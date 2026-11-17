// server-core.mjs — 决策闭环核心（G02 拆分自 server.js）
// 纯逻辑（不依赖进程环境）：决策口径 / 写回核验 / 审批门禁与版本门禁 / 档案视图，
// 路由层通过命名导出取用；依赖档案目录与 HTTP 工具的函数走 createDecisionCore
// 工厂注入（AUTOLOOP_HOME / httpError / sendJson 由 server.js 提供）。
// 与拆分前逐字同源（工厂体内仅整体加 2 空格缩进），行为不变。
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync, renameSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
// ---- 决策闭环（TASK-R2）--------------------------------------------------
// 「待决策」口径收敛在服务端这一处，前端只消费结果，不再自算。
// 步骤唯一定义（TASK-R3 合并）：flow 全量视图与决策口径共用这一份（hint 给卡片
// 作副标题、gate 标决策门禁）；此前两处各抄一份已经漂移过一次。
const STEP_DEFS = [
  { key: 'req', no: 1, name: '原始需求', hint: 'Leo 原话，原件存档', gate: false },
  { key: 'doc', no: 2, name: '需求文档', hint: '讨论后沉淀，需 Leo 确认', gate: true },
  // W01：开发计划步骤声明期望的产物类型——登记产物必须显式声明 kind:'plan'
  // 才能作为有效审批对象。只认档案里声明的类型字段，不看扩展名、不猜路径。
  // 测试场景（如 R11 自测档案）通过任务级 artifactPolicy 显式豁免，依据入档。
  { key: 'plan', no: 3, name: '开发计划', hint: '拆成 Task 清单 + 测试用例', gate: false, expectsKinds: ['plan'] },
  { key: 'brief', no: 4, name: '任务书', hint: '派给谁的指令', gate: false },
  { key: 'deliverable', no: 5, name: '交付物', hint: '文件路径 + 字节 + 哈希', gate: false },
  { key: 'verify', no: 6, name: '验收报告', hint: 'Hermes 独立核对结果', gate: false },
  { key: 'final', no: 7, name: '最终交付', hint: '✓ 完成 / ✗ 打回', gate: true },
];

// 同一步的写回互斥（TASK-R3）：写回期间档案正被改，第二个并发请求直接 409。
// TASK-R4（评审 #3）：锁寿命盖住「子进程写回（15s 超时）+ 读回核验」全程，由各
// 端点 finally 释放；兜底 TTL 25s 只兜异常路径，杜绝慢写入期间锁先过期被插队。
const DECIDE_LOCK_TTL = 25000;
const decideLocks = new Map(); // `${taskId}/${stepKey}` -> 上锁时间戳
function lockDecision(key) {
  const at = decideLocks.get(key);
  const now = Date.now();
  if (at != null && now - at < DECIDE_LOCK_TTL) return false;
  decideLocks.set(key, now);
  return true;
}
const unlockDecision = (key) => decideLocks.delete(key);

// 操作登记簿（TASK-R5 评审 #3）：写回按 opId 记最终结果——同 opId 重放直接回上次
// 结果（幂等），前端超时/断连后凭 opId 回查归属。内存态重启即清空：重启前的 opId
// 查询回 found:false，前端退回状态比对 + 超时兜底，不会死锁。
const opLog = new Map();   // opId -> { ok, taskId, step, action, status, verified, at, after, msg }
const OP_LOG_MAX = 200;
function recordOp(opId, entry) {
  if (!opId) return;
  if (opLog.size >= OP_LOG_MAX) opLog.delete(opLog.keys().next().value);   // 挤掉最老的
  opLog.set(opId, { opId, at: new Date().toISOString(), ...entry });
}

/**
 * 可处理口径（前后端同一套规则）：awaiting 且前序全 done＝档案标了等拍板且依赖
 * 已到；gate 停在 pending 且前序全 done＝门禁到了但档案没标。blocked（W02 统一
 * 两类）：awaiting 或 gate+pending 但前序有未完成——分别是「等待前置条件」「门禁
 * 未到」，都附 waitingOn，前端如实展示不混进待决策数。依赖规则：STEP_DEFS（与
 * flow.mjs STEPS 同源）按 no 严格排序、无并行分组，前置＝前序全部 done；将来声明
 * 并行分组只需改这里与前端的 waitingOnOf。
 */
function computeDecisions(taskRecs) {
  const items = [];
  const blocked = [];
  const rejected = [];
  for (const rec of taskRecs) {
    const steps = STEP_DEFS.map((d) => {
      const v = (rec.steps && rec.steps[d.key]) || {};
      return { ...d, status: v.status || 'pending' };
    });
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (s.status === 'failed') {
        // 打回的步骤单列（TASK-R3）：它当前不可拍板所以不进 items，但必须可见——
        // 这是「待修改后重提」的再入口，静默掉就等于打回后死路一条。
        rejected.push({
          taskId: rec.id, taskTitle: rec.title, stepKey: s.key, stepNo: s.no,
          stepName: s.name, gate: s.gate, status: s.status,
          note: ((rec.steps || {})[s.key] || {}).note || '',
        });
        continue;
      }
      if (s.status === 'awaiting') {
        // W02：awaiting 只说明「审批记录已创建」，不等于「当前可审批」。
        // 前序没走完的 awaiting 是「等待前置条件」：不进 items（顶栏计数、
        // /decide 与 /decision 的 NOT_ACTIONABLE 校验都从这里走），进 blocked。
        const waitingOn = steps.slice(0, i)
          .filter((p) => p.status !== 'done')
          .map((p) => `${String(p.no).padStart(2, '0')} ${p.name}`);
        if (waitingOn.length === 0) {
          items.push({ taskId: rec.id, taskTitle: rec.title, stepKey: s.key, stepNo: s.no, stepName: s.name, gate: s.gate, status: s.status, kind: s.gate ? 'gate' : 'confirm' });
        } else {
          blocked.push({ taskId: rec.id, taskTitle: rec.title, stepKey: s.key, stepNo: s.no, stepName: s.name, gate: s.gate, status: s.status, waitingOn });
        }
        continue;
      }
      if (s.gate && s.status === 'pending') {
        const waitingOn = steps.slice(0, i)
          .filter((p) => p.status !== 'done')
          .map((p) => `${String(p.no).padStart(2, '0')} ${p.name}`);
        if (waitingOn.length === 0) {
          items.push({ taskId: rec.id, taskTitle: rec.title, stepKey: s.key, stepNo: s.no, stepName: s.name, gate: s.gate, status: s.status, kind: 'gate' });
        } else {
          blocked.push({ taskId: rec.id, taskTitle: rec.title, stepKey: s.key, stepNo: s.no, stepName: s.name, gate: s.gate, status: s.status, waitingOn });
        }
      }
    }
  }
  return { items, blocked, rejected };
}

// ---- 统一写回核验服务（TASK-R7 评审 #1/#2/#8）---------------------------
// decide 与 resubmit 此前各抄一份已漂移（评审 #8），收敛成一个服务。五种结论：
//   success 流程正常或报错但读回可归属本次 / unconfirmed 状态对但写入者非本次
//   （不冒领）/ mismatch 报成功但读回不一致 / unknown 读不回＝未确认非失败 /
//   failed flow 报错且读回明确没落成目标。
// 归属判定（评审 #1 的核心）：报错路径读回核对 pst.by＝本次 --by 标记、pst.at
// 不早于操作开始（1s 容差）；只比「状态恰好等于目标」会冒领别人的写入——禁止。
const WORKBENCH_WRITER = {
  decide: 'Leo（工作台）',
  resubmit: 'Leo（工作台·重提）',
  request: 'Leo（工作台·催材料）',   // TASK-11.1：补齐材料，不是打回也不是通过
};

function probeTaskFile(taskFile) {
  try { return JSON.parse(readFileSync(taskFile, 'utf8')); } catch { return null; }
}

function stepViewOf(probe, stepKey) {
  const st = (probe && probe.steps && probe.steps[stepKey]) || {};
  return { status: st.status || null, at: st.at || null, note: st.note || '', by: st.by || null };
}

/** 报错路径上的归属判定：档案上这次写入是不是本次操作的（评审 #1） */
function writeOwnedByThisOp(pst, writerMark, opStartMs) {
  if (pst.by !== writerMark) return false;
  if (pst.at == null) return true;            // 档案没记时间就只认 by 标记
  const t = Date.parse(pst.at);
  if (Number.isNaN(t)) return true;
  return t >= opStartMs - 1000;               // 写入时间必须落在本次操作窗口内
}

/**
 * 执行写回并核验（decide / resubmit 共用）。
 * flow.mjs 的输出是 JSON，必须解析结构再判 ok（TASK-R3 口径保留）；
 * 子进程 15s 超时（TASK-R4 口径保留）。
 */
async function execFlowWriteAndVerify({ args, taskFile, stepKey, status, writerMark, opStartMs }) {
  const { execFile } = await import('node:child_process');
  const out = await new Promise((resolve) => {
    execFile(process.execPath, args, { timeout: 15000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { resolve({ ok: false, msg: stderr || err.message }); return; }
      let parsed = null;
      try { parsed = JSON.parse(stdout); } catch { parsed = null; }
      resolve({ ok: !!(parsed && parsed.ok === true), msg: parsed ? stdout : `输出不是 JSON：${String(stdout).slice(0, 200)}` });
    });
  });
  // 无论 flow 报没报错都读回一次——读回是唯一的真相源（评审 #1/#2）
  const probe = probeTaskFile(taskFile);
  const pst = stepViewOf(probe, stepKey);
  if (out.ok) {
    if (probe == null) return { kind: 'unknown' };
    if (pst.status === status) return { kind: 'success', after: pst };
    return { kind: 'mismatch', after: pst, reason: '写回未确认：档案读回状态与目标不一致，请刷新核对' };
  }
  // flow 报错：超时杀进程/输出解析失败都可能发生在实际写入之后（TASK-R6 评审 #5
  // 口径保留），但「状态恰好一致」不再直接算成功——必须先过归属判定（评审 #1）。
  if (probe == null) {
    // 评审 #2：读不回 ≠ 写入失败。结论只能是「未确认」，交给前端回查循环
    return { kind: 'unknown' };
  }
  if (pst.status === status) {
    if (writeOwnedByThisOp(pst, writerMark, opStartMs)) {
      return { kind: 'success', after: pst };   // 报错发生在写入之后，归属核对通过
    }
    return {
      kind: 'unconfirmed', after: pst,
      reason: `档案已变成目标状态，但写入者是「${pst.by || '未登记'}」而不是本次操作，无法确认本次写回的结果，请人工核对`,
    };
  }
  return { kind: 'failed', msg: String(out.msg || '').slice(0, 300) };
}

/**
 * 审批对象口径（与前端 approvalObjectOf 同一规则）：
 *   'demand'   req 步骤批的是需求本身（Leo 原话），不需要文件；
 *   'own'      本步骤有登记产物，批的就是这些文件；
 *   'upstream' final/verify 等收尾步骤批的是前序交付物；
 *   'none'     没有任何可审批的对象——只许 request 补材料，不许 approve。
 */
function approvalObjectOfRec(rec, stepKey) {
  const idx = STEP_DEFS.findIndex((d) => d.key === stepKey);
  if (idx < 0) return 'none';
  if (stepKey === 'req') return 'demand';
  const v = (rec.steps && rec.steps[stepKey]) || {};
  if ((v.files || []).filter(Boolean).length > 0) return 'own';
  if (stepKey === 'final' || stepKey === 'verify' || STEP_DEFS[idx].gate === true) {
    const up = STEP_DEFS.slice(0, idx)
      .flatMap((d) => (((rec.steps || {})[d.key] || {}).files || []));
    if (up.filter(Boolean).length > 0) return 'upstream';
  }
  return 'none';
}

// ---- 产物类型门禁（W01）-----------------------------------------------------
// 问题背景：开发计划（plan）步骤曾把任意登记文件（如 app.css）直接当有效审批
// 对象，「审批什么」与步骤定义脱钩。修正口径：审批对象关联必须建立在
// 真实 step_id + 产物登记（path/sha256）+ 声明的产物类型（files[].kind）之上。
// 类型只认显式声明——不看扩展名、不看路径、不猜（禁止硬编码扩展名规则）。

/** 产物声明的类型：只读 files[].kind，没声明就是 null（无法建立类型关联） */
function declaredKindOf(f) {
  return f && typeof f.kind === 'string' && f.kind.trim() ? f.kind.trim() : null;
}

/**
 * 任务级产物策略：档案显式声明 artifactPolicy.mode === 'test-any-file' 才生效。
 * 这是测试场景的自声明（如 R11 决策端点自测档案，由 verify-r11-ui.mjs 创建），
 * 「任意登记产物均可作为审批对象」的依据必须写进 basis 并原样展示给用户。
 * 不靠标题 / ID 猜测——没声明就按正式流程的严格口径走。
 */
function artifactPolicyOf(rec) {
  const p = rec && rec.artifactPolicy;
  if (!p || typeof p !== 'object' || p.mode !== 'test-any-file') return null;
  const basis = typeof p.basis === 'string' ? p.basis.trim() : '';
  return basis ? { mode: p.mode, basis } : null;
}

/**
 * 门禁判定（与前端 artifactGate 同一规则）：
 *  - 步骤未声明 expectsKinds：无类型要求，有登记产物即有效（原口径不变）；
 *  - 任务声明了 test-any-file 策略：任意登记产物有效（测试豁免，依据入档）；
 *  - 否则：必须至少有一个产物声明了匹配的 kind，拿不出 → valid:false。
 *    approve 在服务端被 409 拒绝；reject / request 不受限——材料不合格正是
 *    打回和催材料的用途，不能连「说不合格」的出口一起堵死。
 */
function artifactGateOf(rec, stepKey) {
  const def = STEP_DEFS.find((d) => d.key === stepKey);
  const expects = def && Array.isArray(def.expectsKinds) && def.expectsKinds.length ? def.expectsKinds : null;
  const policy = artifactPolicyOf(rec);
  const files = ((((rec.steps || {})[stepKey] || {}).files) || []).filter(Boolean);
  if (!expects) return { expects: null, policy, valid: true, matched: files, unmatched: [] };
  if (policy) return { expects, policy, valid: files.length > 0, matched: files, unmatched: [] };
  const matched = files.filter((f) => expects.includes(declaredKindOf(f)));
  const unmatched = files.filter((f) => !expects.includes(declaredKindOf(f)));
  return { expects, policy: null, valid: matched.length > 0, matched, unmatched };
}

/** 门禁不通时的统一报错文案（决策端点 409 用，与前端提示同一口径） */
function artifactMismatchMessage(stepKey, gate) {
  const def = STEP_DEFS.find((d) => d.key === stepKey) || {};
  const kinds = (gate.expects || []).join(' / ');
  const detail = (gate.unmatched.length ? gate.unmatched : [])
    .map((f) => `${String(f.path || '').split('/').pop() || '(未命名)'}：${declaredKindOf(f) || '未声明类型'}`)
    .join('、');
  return `本步骤「${def.name || stepKey}」要求声明类型为「${kinds}」的材料，当前登记产物（${detail}）不满足类型要求，不能作为有效审批对象：请先补齐计划类产物再审批`;
}

// ---- 审批对象版本门禁（W01）-------------------------------------------------
// 工作流模型里的版本标识：产物登记时快照 bytes/sha256（flow.mjs setStep），同路径
// 重登记＝替换出新版本。正式流程按「提交登记的版本」审批——物理文件在提交后发生
// 变化（实测≠登记字节 / 内容指纹≠登记 sha256 / 文件不存在 / 登记缺版本标识）
// 就不能继续按原版本通过，服务端 409 拒绝，正规途径是打回重新提交、重新登记。
// 比对按条核对（同一物理文件的多条登记各比各的登记值），不比较舍入后的 KB 数；
// 登记带 sha256 的条目在字节一致后再比内容哈希——「大小相同内容被改」不再漏检。
// 两个例外分开判定、不混用：文件类型例外在 artifactGateOf（test-any-file 豁免
// 产物类型要求）；版本变化例外在这里（test-any-file 声明的登记产物是占位产物，
// basis 已注明「仅作占位、任意登记产物均可作为审批对象」，版本漂移照实上报
// 但不阻断该测试流程的审批——保持 W01 验收④的原有行为）。正式流程（无策略
// 声明）不享受版本例外，仍按 drifted 严格 409。

/** 审批对象的文件清单（own / upstream / 空），与前端 approvalObjectOf 同一口径。
 *  不按路径去重：每条登记都是一条版本声明，逐条核对（F02 双登记模型）。 */
function approvalFilesOfRec(rec, stepKey) {
  const idx = STEP_DEFS.findIndex((d) => d.key === stepKey);
  if (idx < 0 || stepKey === 'req') return { src: 'none', files: [] };
  const own = ((((rec.steps || {})[stepKey] || {}).files) || []).filter(Boolean);
  if (own.length) return { src: 'own', files: own };
  if (stepKey === 'final' || stepKey === 'verify' || STEP_DEFS[idx].gate === true) {
    const up = STEP_DEFS.slice(0, idx)
      .flatMap((d) => ((((rec.steps || {})[d.key] || {}).files) || []).filter(Boolean));
    if (up.length) return { src: 'upstream', files: up };
  }
  return { src: 'none', files: [] };
}

/** 版本门禁判定（decide/decision/version-gate 三处共用同一函数同一数据源）：
 *  逐条登记与当前物理文件核对，drifted 带核对不过的原因——
 *  why=missing 文件不存在 / noreg 登记缺字节数（无版本标识）/ bytes 实测≠登记字节 /
 *  sha 字节一致但内容哈希≠登记 sha256（登记带 sha256 才比哈希，老档案缺哈希只比字节）。
 *  例外与正式流程分别出结果：无策略声明 → valid = drifted 为空（严格）；
 *  test-any-file 策略声明在档 → 版本例外生效，versionExempt=true、valid=true，
 *  drifted 仍照实上报（前端继续展示大小/指纹差异，不因豁免而隐藏）。
 *  W01（第 79 轮）：核对通过的文件也回带证据（verified[]）——actSha 现算本就发生
 *  在通过分支上，只是结果一直被丢弃；现在登记指纹与实测指纹并列返回，前端把
 *  「大小相同且内容一致」的内容级核对亮出来（登记无 sha256 的老档案 shaMatch=null
 *  如实回空，不说「已核指纹」的假话）。 */
function artifactVersionGateOf(rec, stepKey) {
  const policy = artifactPolicyOf(rec);
  const { src, files } = approvalFilesOfRec(rec, stepKey);
  const drifted = [];
  const verified = [];
  for (const f of files) {
    if (!f || typeof f.path !== 'string' || !f.path) continue;
    let exists = false;
    let actBytes = null;
    let actSha = null;
    try { const st = statSync(f.path); if (st.isFile()) { exists = true; actBytes = st.size; } } catch { /* 读不到＝文件不存在口径 */ }
    const regBytes = Number.isFinite(f.bytes) ? f.bytes : null;
    const regSha = typeof f.sha256 === 'string' && f.sha256 ? f.sha256 : null;
    let why = null;
    if (!exists) why = 'missing';
    else if (regBytes == null) why = 'noreg';
    else if (actBytes !== regBytes) why = 'bytes';
    else if (regSha) {
      // 字节一致还要过内容关：登记快照带 sha256 就现算比对，大小相同内容被改也拦下
      try { actSha = createHash('sha256').update(readFileSync(f.path)).digest('hex'); } catch { /* 读不了内容＝对不上登记版本 */ }
      if (actSha !== regSha) why = 'sha';
    }
    if (why) drifted.push({ path: f.path, why, exists, regBytes, actBytes, regSha, actSha });
    // 通过分支：登记带 sha256 时 actSha 已现算完成（shaMatch=true 是真比过）；
    // 老档案无登记指纹则 shaMatch=null——大小通过但内容级核对缺位，如实回空
    else verified.push({ path: f.path, exists, regBytes, actBytes, regSha, actSha, shaMatch: regSha ? actSha === regSha : null });
  }
  // 版本例外是独立于类型例外（artifactGateOf）的另一维度判定：策略声明在档
  // （test-any-file + basis）→ 豁免版本阻断但保留 drifted 上报；未声明 → 严格。
  const versionExempt = !!policy;
  return { policy, src, valid: versionExempt || drifted.length === 0, drifted, verified, versionExempt };
}

/** 版本门禁不通时的统一报错文案（决策端点 409 用，与前端警示块同一口径） */
function artifactVersionMessage(stepKey, vgate) {
  const def = STEP_DEFS.find((d) => d.key === stepKey) || {};
  const detail = vgate.drifted.map((d) => {
    const name = String(d.path).replace(/\\/g, '/').split('/').pop() || '(未命名)';
    if (!d.exists) return `${name}：文件不存在，无法按登记版本核对`;
    if (d.regBytes == null) return `${name}：登记字节数缺失，无版本可核对`;
    if (d.why === 'sha') return `${name}：实测内容指纹与登记 sha256 不一致（大小 ${d.actBytes} B 相同，内容已变化）`;
    return `${name}：实测 ${d.actBytes} B ≠ 登记 ${d.regBytes} B`;
  }).join('；');
  // 只会用于无策略声明的正式流程（test-any-file 版本例外在门禁里已放行，走不到这里）
  return `本步骤「${def.name || stepKey}」的审批对象与提交登记版本不一致（${detail}）。正式流程按提交登记的版本审批，材料在提交后发生过变化就不能继续按原版本通过：请先「打回」要求重新提交，重新登记后的档案才是新版本`;
}

/** 写后读回，投影成响应里的整份档案视图（与 GET /api/office/flow 同一步骤序） */
function taskDemandView(rec) {
  const steps = STEP_DEFS.map((d) => {
    const v = (rec.steps && rec.steps[d.key]) || {};
    return {
      key: d.key, no: d.no, name: d.name, hint: d.hint, gate: d.gate,
      expectsKinds: Array.isArray(d.expectsKinds) ? d.expectsKinds : null,   // W01：步骤的类型要求随视图下发
      status: v.status || 'pending', at: v.at || null, note: v.note || '',
      by: v.by || null, files: v.files || [], runs: v.runs || [],
    };
  });
  return {
    id: rec.id, title: rec.title,
    createdAt: rec.createdAt || null, updatedAt: rec.updatedAt || null,
    done: steps.filter((s) => s.status === 'done').length,
    total: steps.length,
    steps,
    artifactPolicy: artifactPolicyOf(rec),   // W01：决策响应与 flow 视图同一口径
  };
}

export {
  STEP_DEFS, WORKBENCH_WRITER,
  computeDecisions, probeTaskFile, stepViewOf, writeOwnedByThisOp, execFlowWriteAndVerify,
  lockDecision, unlockDecision,
  artifactPolicyOf, artifactGateOf, artifactMismatchMessage,
  approvalFilesOfRec, artifactVersionGateOf, artifactVersionMessage,
  approvalObjectOfRec, taskDemandView,
};

// ---- 环境依赖工厂：server.js 注入 AUTOLOOP_HOME / httpError / sendJson ----
export function createDecisionCore({ AUTOLOOP_HOME, httpError, sendJson }) {
  /** 读 office-data/tasks 下所有任务档案；坏文件跳过并逐个上报，不拖垮整批 */
  function readTaskRecs() {
    const dir = join(AUTOLOOP_HOME, 'office-data', 'tasks');
    const recs = [];
    const errors = [];
    let files = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith('.json')); }
    catch (err) {
      // 目录级失败必须上报（TASK-R3）：ENOENT = 真没有任务档案，静默当空；
      // 其余（权限/磁盘/被占用）进 errors——「读不了」不许伪装成「没有」。
      if (!err || err.code !== 'ENOENT') errors.push({ file: '(tasks 目录)', message: `目录读取失败：${err ? err.message : '未知错误'}` });
      return { recs, errors };
    }
    for (const f of files) {
      try { recs.push(JSON.parse(readFileSync(join(dir, f), 'utf8'))); }
      catch (err) { errors.push({ file: f, message: err.message }); }
    }
    return { recs, errors };
  }

  /** 按统一结论登记 opLog 并响应（decide/resubmit 共用）。只有 failed 抛 500
   *  FLOW_WRITE_FAILED——确定失败才登记 ok:false 原样回放给重试的同一 opId（TASK-R5 评审 #3）。 */
  function respondFlowWriteResult(res, opId, base, outcome) {
    if (outcome.kind === 'failed') {
      recordOp(opId, { ok: false, ...base, msg: outcome.msg });
      throw httpError(500, 'FLOW_WRITE_FAILED', `flow.mjs 写回失败：${outcome.msg}`);
    }
    const record = {
      ok: true, ...base,
      verified: outcome.kind === 'success',
      readBack: outcome.kind !== 'unknown',
      after: outcome.after || null,
    };
    if (outcome.kind === 'unconfirmed') { record.unconfirmed = true; record.unverifiedReason = outcome.reason; }
    if (outcome.kind === 'mismatch') { record.unverifiedReason = outcome.reason; }
    recordOp(opId, record);
    sendJson(res, 200, {
      ok: true, ...base, opId,
      verified: record.verified,
      readBack: record.readBack,
      after: record.after,
      unconfirmed: record.unconfirmed === true,
      unverifiedReason: record.unverifiedReason || null,
    });
  }

  /** 原子写任务档案：临时文件 + rename 顶替（Windows 上 rename 可覆盖已存在文件） */
  function saveTaskFileAtomic(taskFile, rec) {
    mkdirSync(dirname(taskFile), { recursive: true });
    rec.updatedAt = new Date().toISOString();
    const tmp = `${taskFile}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    writeFileSync(tmp, JSON.stringify(rec, null, 2), 'utf8');
    renameSync(tmp, taskFile);
  }

  /** 每次决策操作追加一行 JSON 事件；失败不吞——回填到响应里让调用方看见 */
  function appendDecisionEvent(ev) {
    const file = join(AUTOLOOP_HOME, 'office-data', 'decision-events.jsonl');
    try {
      appendFileSync(file, JSON.stringify(ev) + '\n', 'utf8');
      return null;
    } catch (err) {
      return `事件记录写入失败：${err.message}`;
    }
  }

  /** TASK-R11/F02：文件校验事件追加（file-events.jsonl）——重校验的留痕通道 */
  function appendFileEvent(ev) {
    const file = join(AUTOLOOP_HOME, 'office-data', 'file-events.jsonl');
    try {
      appendFileSync(file, JSON.stringify(ev) + '\n', 'utf8');
      return null;
    } catch (err) {
      return `文件事件记录写入失败：${err.message}`;
    }
  }
  return { readTaskRecs, respondFlowWriteResult, saveTaskFileAtomic, appendDecisionEvent, appendFileEvent, opLog };
}