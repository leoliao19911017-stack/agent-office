// Soda Agent 工作台 — Web 看板服务（TASK-3.1）
//
// 架构（两层，owner key 不出服务端）：
//
//   浏览器 ──► 本服务 127.0.0.1:8080 ──► Autoloop 中台 127.0.0.1:3350
//                ↑ 从 config.json 读 owner key，只在进程内存里
//
// 本服务是「动作白名单代理」，不是透明转发：前端只能调下面 5 个接口，
// 不能借助它任意访问中台。owner key 不写日志、不返回给前端、出错也不透传。
// 零依赖：node:http + 全局 fetch（Node >= 18，本项目要求 Node 24）。

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, renameSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join, normalize, extname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 产物库允许读取的根目录白名单。
 * 只允许读工作产物所在目录——不接受任意绝对路径，
 * 否则一个 path 参数就能把整台机器读空。
 */
const FILE_ROOTS = [
  'C:/Tools/agent-autoloop/office-data',
  'C:/Tools/agent-autoloop/output',
  'C:/Tools/agent-autoloop/worker',
  'C:/Users/Administrator/Desktop/Soda Intelligence - AI Native Thinking/Soda Office',
];

/** 文本类扩展名：直接回文本；其余回元信息 + 下载链接 */
const TEXT_EXT = new Set(['.md', '.txt', '.json', '.js', '.mjs', '.cjs', '.ts', '.css', '.html', '.htm',
  '.yml', '.yaml', '.toml', '.ini', '.log', '.csv', '.sh', '.ps1', '.py', '.svg', '.xml']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

/** 判断路径是否落在白名单根目录内（防目录穿越） */
function isAllowedPath(p) {
  if (!isAbsolute(p)) return false;
  const n = normalize(p).replace(/\\/g, '/');
  if (n.includes('..')) return false;
  return FILE_ROOTS.some((root) => {
    const r = normalize(root).replace(/\\/g, '/').replace(/\/$/, '');
    return n === r || n.startsWith(r + '/');
  });
}

const HERE = dirname(fileURLToPath(import.meta.url));

// ---- 构建版本（TASK-R6 评审 #1）---------------------------------------
// 曾经出过「源码里有 /api/office/op-status，运行实例却 404」——进程是旧代码起的，
// 前端已经在调新接口。版本号写死在源码，/api/health 与启动日志都带它；
// 部署后冒烟第一件事就是核对这个值，运行实例与源码不一致当场暴露。
const BUILD_VERSION = 'r11c';

/**
 * 读 office-data 下的 JSON（任务档案汇总、技能索引）。
 * 文件不存在或损坏时返回 fallback，而不是抛错——看板不该因为附属数据缺失而白屏。
 */
function readOfficeJson(name, fallback) {
  const base = process.env.AGENT_AUTOLOOP_HOME || 'C:/Tools/agent-autoloop';
  const p = join(base, 'office-data', name);
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * readOfficeJson 的透明版（TASK-R2）：读取失败不再伪装成 fallback，
 * 错误一并带回，由端点透出给前端——「数据为空」和「读取失败」必须分得开。
 */
function readOfficeJsonDetailed(name, fallback) {
  const p = join(AUTOLOOP_HOME, 'office-data', name);
  try {
    return { payload: JSON.parse(readFileSync(p, 'utf8')), readError: null };
  } catch (err) {
    return { payload: fallback, readError: `读取 ${name} 失败：${err.message}` };
  }
}

// ---- 端口与中台地址 ----------------------------------------------------

/** 端口：环境变量 PORT（正整数）> 默认 8080。只绑 127.0.0.1，不对外。 */
const PORT = Number.isInteger(Number(process.env.PORT)) && Number(process.env.PORT) > 0
  ? Number(process.env.PORT)
  : 8080;

const AUTOLOOP_HOME = process.env.AGENT_AUTOLOOP_HOME || 'C:/Tools/agent-autoloop';

// ---- 读配置：owner key 只进内存 ----------------------------------------

let cfg;
try {
  cfg = JSON.parse(readFileSync(join(AUTOLOOP_HOME, 'config.json'), 'utf8'));
} catch (err) {
  console.error(`[启动失败] 读不到 ${join(AUTOLOOP_HOME, 'config.json')}：${err.message}`);
  process.exit(1);
}

const HUB = String(cfg.url || 'http://127.0.0.1:3350').replace(/\/+$/, '');
const OWNER_KEY = String(cfg.owner || '');
if (OWNER_KEY === '') {
  console.error('[启动失败] config.json 里没有 owner 字段');
  process.exit(1);
}
const HUB_HEADERS = {
  authorization: `Bearer ${OWNER_KEY}`,
  'content-type': 'application/json',
};

// ---- 小工具 ------------------------------------------------------------

/** 带 HTTP 状态码与业务 code 的错误，路由层统一转成 JSON 响应。 */
function httpError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** 手写请求体解析：空体当 {}；非法 JSON 400；超过 1MB 直接断开。 */
function readJsonBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      if ((size += chunk.length) > limit) {
        req.destroy();
        reject(httpError(413, 'BODY_TOO_LARGE', `请求体超过 ${limit} 字节`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text === '') return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(httpError(400, 'INVALID_JSON', '请求体不是合法 JSON'));
      }
    });
    req.on('error', (err) => reject(Object.assign(err, { statusCode: 400, code: 'BODY_READ_FAILED' })));
  });
}

/**
 * 深度脱敏：任何字符串值只要包含 owner key 的片段，整段替换为 [REDACTED]。
 * 防御性措施——实测 /v1/state 的返回不含 key，但万一中台将来把凭据放进状态里，
 * 这一层保证它到不了浏览器。对象键名同样检查（防止 key 出现在字段名上）。
 */
function redact(value) {
  if (typeof value === 'string') {
    return value.includes(OWNER_KEY) ? '[REDACTED]' : value;
  }
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k.includes(OWNER_KEY) ? '[REDACTED]' : k] = redact(v);
    }
    return out;
  }
  return value;
}

/**
 * 调中台。网络层失败 → 502 HUB_UNREACHABLE；中台返回非 2xx → 原样透传状态码
 * 与业务错误体（里面不含凭据），供前端展示。成功的 JSON 响应先过 redact 再返回。
 */
async function callHub(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(HUB + path, {
      method,
      headers: HUB_HEADERS,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    const cause = err.cause ? (err.cause.code || err.cause.message) : err.message;
    throw httpError(502, 'HUB_UNREACHABLE', `中台不可达（${HUB}）：${cause}`);
  }

  const text = await res.text();
  let payload;
  try {
    payload = text === '' ? {} : JSON.parse(text);
  } catch {
    throw httpError(502, 'HUB_BAD_RESPONSE', `中台返回了非 JSON 内容（HTTP ${res.status}）`);
  }

  if (!res.ok) {
    // 透传中台的业务错误（status + body），不带任何凭据
    const err = httpError(res.status, payload.code || payload.error || 'HUB_ERROR',
      payload.error || payload.message || `中台返回 HTTP ${res.status}`);
    err.hubPayload = payload;
    throw err;
  }
  return redact(payload);
}

// ---- 路由处理器 ---------------------------------------------------------

/** GET /api/health — 本服务活着；顺带探测中台 /healthz（免鉴权端点）。 */
async function handleHealth() {
  let autoloop = false;
  try {
    const res = await fetch(`${HUB}/healthz`, { signal: AbortSignal.timeout(3000) });
    autoloop = res.ok;
  } catch {
    autoloop = false;
  }
  return { ok: true, autoloop, build: BUILD_VERSION };
}

/** POST /api/cards/:id/answer — 只接受 { choice: 非负整数 } 或 { text: 非空字符串 }。 */
async function handleAnswer(cardId, body) {
  const hasChoice = body.choice !== undefined;
  const hasText = body.text !== undefined;
  if (hasChoice === hasText) {
    throw httpError(400, 'INVALID_ANSWER', 'body 必须且只能是 { choice: 选项下标 } 或 { text: 自由回答 } 其一');
  }
  let forward;
  if (hasChoice) {
    if (!Number.isInteger(body.choice) || body.choice < 0) {
      throw httpError(400, 'INVALID_CHOICE', 'choice 必须是非负整数（选项下标，从 0 开始）');
    }
    forward = { choice: body.choice };
  } else {
    if (typeof body.text !== 'string' || body.text.trim() === '') {
      throw httpError(400, 'INVALID_TEXT', 'text 必须是非空字符串');
    }
    forward = { text: body.text };
  }
  return callHub(`/v1/cards/${cardId}/answer`, { method: 'POST', body: forward });
}

/** POST /api/cards/:id/resolve — { reason: 非空字符串 }。 */
async function handleResolve(cardId, body) {
  if (typeof body.reason !== 'string' || body.reason.trim() === '') {
    throw httpError(400, 'INVALID_REASON', 'reason 必须是非空字符串');
  }
  return callHub(`/v1/cards/${cardId}/resolve`, { method: 'POST', body: { reason: body.reason } });
}

/** POST /api/runs/:id/cancel — 忽略 body，直接转发。 */
function handleCancel(runId) {
  return callHub(`/v1/runs/${runId}/cancel`, { method: 'POST', body: {} });
}

// ---- 决策闭环（TASK-R2）--------------------------------------------------
// 之前「待决策」由前端把所有 gate+pending 一律计入，没到门禁的也被虚报成待决策。
// 现在口径收敛在服务端这一处，前端只消费结果，不再自算。

// 步骤唯一定义（TASK-R3 合并）：flow 全量视图与决策口径共用这一份，
// hint 给前端卡片作副标题，gate 标决策门禁。此前两处各抄一份，已经漂移过一次。
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

// 同一步的写回互斥（TASK-R3）：决策/重提写回期间档案正被改，第二个并发请求直接 409，
// 防止「两个入口同时点通过/打回」互相覆盖却都拿到成功。
// TASK-R4（评审 #3）：锁寿命必须盖住「子进程写回（15s 超时）+ 读回核验」全程，
// 由各端点 finally 释放；兜底 TTL 从 10s 提到 25s（> 15s + 读回余量），
// 只兜异常路径（正常路径不走 TTL），杜绝「慢写入期间锁先过期、第二个请求插队」。
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

// 操作登记簿（TASK-R5 评审 #3）：写回操作按 opId 记录最终结果，支撑两件事——
//  1) 幂等提交：同 opId 重放直接回上次结果，不再执行写回（网络重试不会重复执行）；
//  2) 结果查询：前端超时/断连后凭 opId 回查归属，不靠「档案状态碰巧一致」猜测。
// 内存态：服务重启即清空。重启前的 opId 查询回 found:false，
// 前端退回状态比对 + 超时兜底，不会死锁。
const opLog = new Map();   // opId -> { ok, taskId, step, action, status, verified, at, after, msg }
const OP_LOG_MAX = 200;
function recordOp(opId, entry) {
  if (!opId) return;
  if (opLog.size >= OP_LOG_MAX) opLog.delete(opLog.keys().next().value);   // 挤掉最老的
  opLog.set(opId, { opId, at: new Date().toISOString(), ...entry });
}

/**
 * 可处理口径（前后端同一套规则）：
 *  - status === 'awaiting' 且前序步骤全部 done：档案标了等拍板、依赖也到了；
 *  - gate 步骤停在 pending 且前序步骤全部 done：门禁到了但档案还没标。
 * blocked 是「看着是决策点但还动不了」的（W02 统一两类）：
 *  - awaiting + 前序有未完成：审批记录已创建 ≠ 当前可审批，是「等待前置条件」；
 *  - gate + pending + 前序有未完成：「门禁未到」。
 * 都附 waitingOn（还差哪些步骤），前端如实展示而不是混进待决策数。
 * 依赖规则按流水线声明走：STEP_DEFS（与 flow.mjs STEPS 同源）按 no 严格
 * 排序、无并行分组配置，前置 = 前序全部 done；若将来声明并行分组，只需
 * 改这里与前端的 waitingOnOf。
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

// ---- 统一写回核验服务（TASK-R7 评审 #1/#2/#8）---------------------------
// decide 与 resubmit 此前各抄一份「执行 flow.mjs → 读回核验」，两份分支已经
// 漂移过（评审 #8）。收敛成一个服务，一次写回只可能得到五种结论之一：
//   success      写回确认属于本次操作（flow 正常，或报错但读回可归属到本次）
//   unconfirmed  档案已是目标状态，但写入者不是本次操作（别的入口写的）——不冒领
//   mismatch     flow 报成功但读回状态与目标不一致（被覆盖/没落上），请人工核对
//   unknown      读不回档案——只说明「结果未确认」，绝不是「写入失败」（评审 #2）
//   failed       flow 报错且读回明确显示状态没落成目标——这才是确定的写入失败
// 归属判定（评审 #1 的核心）：写回命令自带 --by 工作台标记；报错路径上读回时
// 核对 ① pst.by 等于本次标记；② pst.at 不早于本次操作开始（1s 容差）。
// 只做「状态恰好等于目标」的比对，会把别的入口的写入冒领成本次成功——禁止。
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
 * 按统一结论登记 opLog 并响应（decide / resubmit 共用）。
 * 只有 failed 会抛 500 FLOW_WRITE_FAILED——确定失败才登记 ok:false，
 * 原样回放给重试的同一 opId，避免二次执行（TASK-R5 评审 #3 口径保留）。
 */
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

// ---- 决策直写端点（TASK-11.1 / R1）--------------------------------------
// POST /api/office/decide 走子进程 flow.mjs（Hermes 共用的老通道）；本端点另起一条
// 直写路径，三个差别是任务书点名要的：
//   1) 原子写：先写同目录临时文件再 rename 顶替——任何时刻磁盘上要么是完整旧档，
//      要么是完整新档，断电/崩溃不会留半截 JSON（flow.mjs 的裸 writeFileSync 做不到，
//      它是共享基础设施不能改）；
//   2) 每次操作追加一条事件记录（谁/何时/对哪个对象/做了什么/结果）到
//      office-data/decision-events.jsonl；
//   3) 响应就是写后的真实状态：rename 完成后重新从磁盘读回整份档案再返回，
//      不拿「命令发出去了」冒充「写成了」。
// 写是同步在进程内完成的（无子进程），单事件循环天然互斥；decideLocks 仍按
// 同一键空间加锁，与 decide/resubmit 互斥，防止两入口同时改同一步。

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
 *  drifted 仍照实上报（前端继续展示大小/指纹差异，不因豁免而隐藏）。 */
function artifactVersionGateOf(rec, stepKey) {
  const policy = artifactPolicyOf(rec);
  const { src, files } = approvalFilesOfRec(rec, stepKey);
  const drifted = [];
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
  }
  // 版本例外是独立于类型例外（artifactGateOf）的另一维度判定：策略声明在档
  // （test-any-file + basis）→ 豁免版本阻断但保留 drifted 上报；未声明 → 严格。
  const versionExempt = !!policy;
  return { policy, src, valid: versionExempt || drifted.length === 0, drifted, versionExempt };
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

// ---- HTTP 服务 ----------------------------------------------------------

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  const method = req.method || 'GET';

  try {
    // 静态首页：只服务本目录的 index.html，不做目录列表
    if (method === 'GET' && (path === '/' || path === '/index.html')) {
      let html;
      try {
        html = readFileSync(join(HERE, 'index.html'));
      } catch {
        throw httpError(500, 'NO_FRONTEND', 'index.html 不在本服务同目录下');
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // TASK-R3 拆分产物：样式 / 主脚本 / 离线快照与 index.html 同目录。
    // 只精确匹配这三个文件名（不开放目录列表），no-cache 保证改版刷新即生效。
    if (method === 'GET' || method === 'HEAD') {
      const STATIC_APP = {
        '/app.css': 'text/css; charset=utf-8',
        '/app.js': 'application/javascript; charset=utf-8',
        '/offline-snapshot.js': 'application/javascript; charset=utf-8',
      };
      if (STATIC_APP[path]) {
        let buf;
        try { buf = readFileSync(join(HERE, path.slice(1))); }
        catch { throw httpError(404, 'NOT_FOUND', '资源不存在'); }
        res.writeHead(200, { 'content-type': STATIC_APP[path], 'cache-control': 'no-cache' });
        res.end(method === 'HEAD' ? undefined : buf);
        return;
      }
    }

    // 静态资源：只服务本目录 assets/ 下的图片（TASK-4.1）；
    // TASK-5.2 起允许一层子目录 assets/agents/（工位卡头像）。
    // 每段文件名只允许字母数字开头 + ._-，天然挡掉 ..、分隔符与空段；扩展名白名单。
    if ((method === 'GET' || method === 'HEAD') && path.startsWith('/assets/')) {
      const MIME = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
      };
      const segs = path.slice('/assets/'.length).split('/');
      const last = segs[segs.length - 1];
      const dot = last.lastIndexOf('.');
      const ext = dot >= 0 ? last.slice(dot).toLowerCase() : '';
      const safe = segs.length <= 2
        && segs.every((s) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s))
        && !path.includes('..') && MIME[ext] !== undefined;
      if (!safe) throw httpError(404, 'NOT_FOUND', '资源不存在');
      let buf;
      try {
        buf = readFileSync(join(HERE, 'assets', ...segs));
      } catch {
        throw httpError(404, 'NOT_FOUND', '资源不存在');
      }
      // 头像是不变的资产，而工位卡每 3 秒重渲染会重建 <img>：
      // agents/ 给长缓存，否则 no-cache 会让浏览器每轮全量重拉 3.7MB；其余维持 no-cache
      res.writeHead(200, {
        'content-type': MIME[ext],
        'cache-control': segs.length === 2 ? 'public, max-age=86400' : 'no-cache',
      });
      res.end(method === 'HEAD' ? undefined : buf);
      return;
    }

    if (path === '/api/health' && method === 'GET') {
      sendJson(res, 200, await handleHealth());
      return;
    }

    if (path === '/api/state' && method === 'GET') {
      sendJson(res, 200, await callHub('/v1/state'));
      return;
    }

    // 三个 Hermes 入口（Lemate / Winter / Karina）的实时状态。
    // 平级架构：每个 Hermes 只自报自己那一行，这里只负责读，不做调度。
    if (path === '/api/office/hermes' && method === 'GET') {
      const base = process.env.AGENT_AUTOLOOP_HOME || 'C:/Tools/agent-autoloop';
      const { execFile } = await import('node:child_process');
      const out = await new Promise((resolve) => {
        execFile(process.execPath, [join(base, 'hermes-status.mjs'), 'read'],
          { timeout: 8000, maxBuffer: 1024 * 1024 },
          (err, stdout) => {
            if (err || !stdout) { resolve({ error: String(err && err.message || 'read failed'), agents: [] }); return; }
            try { resolve(JSON.parse(stdout)); } catch { resolve({ error: 'bad json', agents: [] }); }
          });
      });
      sendJson(res, 200, out);
      return;
    }

    // Leo's Agent Office：任务档案与文件汇总（读取 office-data/index.json）
    // TASK-R2：读失败时带 readError 返回，前端据此显示错误态而不是空数据
    if (path === '/api/office/files' && method === 'GET') {
      const { payload, readError } = readOfficeJsonDetailed('index.json', { generatedAt: null, tasks: [] });
      sendJson(res, 200, { ...payload, readError });
      return;
    }

    // 技能中心索引（读取 office-data/skills.json）
    // TASK-R11/S02：合并 skill-meta.json 里的用途分类 overlay。
    // 分类是人工维护的元数据——服务端不做任何自动猜测，
    // overlay 里没有的技能 category=null，前端归「未分类」。
    if (path === '/api/office/skills' && method === 'GET') {
      const { payload, readError } = readOfficeJsonDetailed('skills.json', { generatedAt: null, skills: [] });
      const meta = readOfficeJson('skill-meta.json', null);
      const categories = meta && meta.categories && typeof meta.categories === 'object' ? meta.categories : null;
      const skills = (payload.skills || []).map((s) => ({
        ...s,
        category: categories && typeof categories[s.name] === 'string' ? categories[s.name] : null,
      }));
      sendJson(res, 200, { ...payload, skills, readError });
      return;
    }

    // 需求流水线：8 步全貌（读 office-data/tasks/*.json）
    // 这是「以需求为主线」的视图，跟以 Agent 为主线的 /api/state 互补。
    if (path === '/api/office/flow' && method === 'GET') {
      const base = process.env.AGENT_AUTOLOOP_HOME || 'C:/Tools/agent-autoloop';
      const dir = join(base, 'office-data', 'tasks');
      // STEP_DEFS 已收敛为文件顶部唯一定义（TASK-R3），这里直接用，不再内联一份
      // TASK-R2：逐文件隔离——一个损坏的任务档案只报它自己的错，
      // 不能拖垮整批需求。「部分数据 + 坏文件清单」好过「全空」。
      let tasks = [];
      const readErrors = [];
      try {
        const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
        for (const f of files) {
          let rec;
          try {
            rec = JSON.parse(readFileSync(join(dir, f), 'utf8'));
          } catch (err) {
            readErrors.push({ file: f, message: err.message });
            continue;
          }
          const steps = STEP_DEFS.map((d) => {
            const v = (rec.steps && rec.steps[d.key]) || { status: 'pending' };
            return {
              ...d,
              status: v.status || 'pending',
              at: v.at || null,
              note: v.note || '',
              by: v.by || null,
              files: v.files || [],
              runs: v.runs || [],
            };
          });
          tasks.push({
            id: rec.id,
            title: rec.title,
            updatedAt: rec.updatedAt || null,
            done: steps.filter((s) => s.status === 'done').length,
            total: steps.length,
            steps,
            // W01：任务级产物策略（test-any-file 测试豁免）原样下发，
            // 前端在审批卡上展示豁免依据，而不是静默放行。
            artifactPolicy: artifactPolicyOf(rec),
          });
        }
        tasks.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
      } catch (err) {
        // ENOENT = 还没有任何任务档案，是真「空」；其余目录级错误必须上报（TASK-R3）
        if (!err || err.code !== 'ENOENT') readErrors.push({ file: '(tasks 目录)', message: `目录读取失败：${err ? err.message : '未知错误'}` });
      }
      sendJson(res, 200, { generatedAt: new Date().toISOString(), tasks, errors: readErrors });
      return;
    }

    // 产物内容读取（C · 产物库）：点开文件能看到真实内容。
    // 安全：只读白名单根目录内的绝对路径，拒绝 .. 穿越。
    if (path === '/api/office/file' && method === 'GET') {
      const q = new URL(req.url, `http://127.0.0.1:${PORT}`);
      const raw = String(q.searchParams.get('path') || '');
      if (!raw) throw httpError(400, 'MISSING_PATH', '缺少 path 参数');
      const p = normalize(raw).replace(/\\/g, '/');
      if (!isAllowedPath(p)) {
        throw httpError(403, 'PATH_NOT_ALLOWED', '该路径不在允许读取的目录内');
      }
      let st;
      try {
        st = statSync(p);
      } catch {
        sendJson(res, 404, { exists: false, path: p, error: '文件不存在或已被移走' });
        return;
      }
      if (!st.isFile()) throw httpError(400, 'NOT_A_FILE', '不是文件');
      const ext = extname(p).toLowerCase();
      const base = p.split('/').pop();

      if (IMAGE_EXT.has(ext)) {
        // 图片回二进制，前端直接用 <img> 打开
        const buf = readFileSync(p);
        res.writeHead(200, {
          'content-type': ext === '.png' ? 'image/png'
            : ext === '.webp' ? 'image/webp'
              : ext === '.gif' ? 'image/gif' : 'image/jpeg',
          'content-length': buf.length,
          'cache-control': 'no-cache',
        });
        res.end(buf);
        return;
      }

      if (!TEXT_EXT.has(ext)) {
        sendJson(res, 200, {
          exists: true, path: p, name: base, bytes: st.size, ext,
          kind: 'binary', note: '二进制文件，不支持预览',
        });
        return;
      }

      const buf = readFileSync(p);
      // 头部 2MB 保护：日志类文件可能很大，超了截断并明确告知
      const LIMIT = 2 * 1024 * 1024;
      const truncated = buf.length > LIMIT;
      const text = buf.subarray(0, LIMIT).toString('utf8');
      sendJson(res, 200, {
        exists: true, path: p, name: base, ext, kind: 'text',
        bytes: st.size, truncated, text,
        modifiedAt: st.mtime.toISOString(),
      });
      return;
    }

    // 产物存在性核实（TASK-7.1）：flow 里登记的 path 可信度有限（字节过期、文件被移走），
    // 由服务端 stat 后回「存在 + 实测字节数」，前端据此标红失效产物。
    // 只查存在性与大小，不读内容；一次最多 200 条，防滥用。
    if (path === '/api/office/file-check' && method === 'POST') {
      const body = await readJsonBody(req);
      const paths = Array.isArray(body.paths) ? body.paths : [];
      if (paths.length > 200) {
        throw httpError(400, 'TOO_MANY_PATHS', '一次最多核实 200 个路径');
      }
      const results = paths.map((p) => {
        const s = String(p ?? '');
        let exists = false;
        let bytes = null;
        let mtime = null;
        try {
          const st = statSync(s);
          if (st.isFile()) { exists = true; bytes = st.size; mtime = st.mtime.toISOString(); }
        } catch { /* 不存在 / 不可达：如实回 false */ }
        return { path: s, exists, bytes, mtime };
      });
      sendJson(res, 200, { results });
      return;
    }

    // W02（版本门禁轮）：审批版本判定的唯一权威出口——前端中央异常标签 / 右侧
    // 警示块 / 主操作禁用三处都消费这份判定（同一产物 ID + 同一审批版本），决策端点
    // decide/decision 在写前重跑的也是同一个 artifactVersionGateOf：三处与审批接口
    // 按构造同源，前端展示与服务端拒绝不会再各说各话。只读，不写档案不加锁。
    if (path === '/api/office/version-gate' && method === 'POST') {
      const body = await readJsonBody(req);
      const taskId = String(body.taskId || '');
      const stepKey = String(body.stepKey || '');
      if (!/^[A-Za-z0-9_-]+$/.test(taskId)) throw httpError(400, 'BAD_TASK_ID', 'taskId 只能是字母数字_-');
      if (!STEP_DEFS.some((d) => d.key === stepKey)) throw httpError(400, 'BAD_STEP', `没有这一步：${stepKey || '(空)'}`);
      const taskFile = join(AUTOLOOP_HOME, 'office-data', 'tasks', `${taskId}.json`);
      let rec;
      try { rec = JSON.parse(readFileSync(taskFile, 'utf8')); }
      catch { throw httpError(404, 'TASK_NOT_FOUND', `任务档案不存在或损坏：${taskId}`); }
      const g = artifactVersionGateOf(rec, stepKey);
      sendJson(res, 200, {
        taskId, stepKey, src: g.src, policy: g.policy, valid: g.valid, drifted: g.drifted,
        versionExempt: g.versionExempt === true,
      });
      return;
    }

    // TASK-R11/F02：重新校验单个产物，用真实文件元数据更新任务档案里的登记值。
    // 行为约定（数据可靠性，不是样式）：
    //   - 白名单外 / 参数缺失 → 400/403 协议错误；
    //   - 文件当前不可读（不存在/被移走/无权限）→ 200 {ok:false, reason:'unreadable'}，
    //     登记值原样保留（不可把「无法校验」推断成「已丢失」），事件照记；
    //   - 可读 → 现算 sha256，命中 taskId+stepKey+path 的登记条目：
    //     旧登记快照追加进 history（保留历史），登记值更新为实测值，
    //     原子写回 + 事件留痕，响应给出 before/after 全量对照。
    if (path === '/api/office/file-revalidate' && method === 'POST') {
      const body = await readJsonBody(req);
      const rawPath = String(body.path || '');
      const taskId = String(body.taskId || '');
      const stepKey = String(body.stepKey || '');
      if (!rawPath || !taskId || !stepKey) {
        throw httpError(400, 'MISSING_PARAMS', '缺少 path / taskId / stepKey');
      }
      const p = normalize(rawPath).replace(/\\/g, '/');
      if (!isAllowedPath(p)) {
        throw httpError(403, 'PATH_NOT_ALLOWED', '该路径不在允许读取的目录内');
      }
      const nowIso = new Date().toISOString();

      // 第一步：真实读文件。读不到 ≠ 登记错了，登记值不动。
      let st;
      let sha256 = null;
      let unreadableReason = null;
      try {
        st = statSync(p);
        if (!st.isFile()) {
          unreadableReason = '不是普通文件';
        } else {
          sha256 = createHash('sha256').update(readFileSync(p)).digest('hex');
        }
      } catch (err) {
        unreadableReason = err && err.code === 'ENOENT' ? '文件不存在或已被移走' : `读取失败：${err.message}`;
      }

      const taskFile = join(AUTOLOOP_HOME, 'office-data', 'tasks', `${taskId}.json`);
      let rec;
      try {
        rec = JSON.parse(readFileSync(taskFile, 'utf8'));
      } catch (err) {
        throw httpError(404, 'TASK_NOT_FOUND', `任务档案读取失败：${err.message}`);
      }
      const step = rec.steps && rec.steps[stepKey];
      const files = step && Array.isArray(step.files) ? step.files : null;
      const norm = (x) => normalize(String(x || '')).replace(/\\/g, '/');
      const fileRec = files ? files.find((f) => norm(f.path) === p) : null;

      if (unreadableReason) {
        const ev = {
          at: nowIso, kind: 'file-revalidate', taskId, stepKey, path: p,
          ok: false, reason: 'unreadable', message: unreadableReason,
        };
        ev.logError = appendFileEvent(ev);
        sendJson(res, 200, {
          ok: false, reason: 'unreadable', message: unreadableReason,
          path: p, taskId, stepKey,
          registered: fileRec ? { bytes: fileRec.bytes ?? null, sha256: fileRec.sha256 ?? null } : null,
          registeredFound: !!fileRec,
        });
        return;
      }
      if (!fileRec) {
        throw httpError(404, 'FILE_NOT_REGISTERED', '该文件未登记在此任务步骤下，无法更新登记值');
      }

      // 第二步：留历史 → 更新登记 → 原子写回。
      const before = {
        bytes: fileRec.bytes ?? null,
        sha256: fileRec.sha256 ?? null,
        measuredAt: fileRec.measuredAt || null,
        registeredAt: fileRec.registeredAt || fileRec.at || null,
      };
      if (!Array.isArray(fileRec.history)) fileRec.history = [];
      fileRec.history.push({ ...before, snapshot: '重校验前登记值', at: nowIso });
      fileRec.bytes = st.size;
      fileRec.sha256 = sha256;
      fileRec.measuredAt = nowIso;
      fileRec.mtime = st.mtime.toISOString();
      saveTaskFileAtomic(taskFile, rec);

      const after = {
        bytes: fileRec.bytes,
        sha256: fileRec.sha256,
        measuredAt: fileRec.measuredAt,
        mtime: fileRec.mtime,
      };
      const ev = {
        at: nowIso, kind: 'file-revalidate', taskId, stepKey, path: p,
        ok: true, before, after,
      };
      ev.logError = appendFileEvent(ev);
      sendJson(res, 200, {
        ok: true, path: p, taskId, stepKey,
        before, after, changed: before.bytes !== after.bytes,
        historyDepth: fileRec.history.length,
      });
      return;
    }

    // 待决策清单（TASK-R2）：把「哪些决策点真的能动」收敛成服务端单一口径，
    // 前端不再自己数 gate+pending——那正是把 OFFICE-V4 数错的根源。
    if (path === '/api/office/decisions' && method === 'GET') {
      const { recs, errors } = readTaskRecs();
      const { items, blocked, rejected } = computeDecisions(recs);
      sendJson(res, 200, { generatedAt: new Date().toISOString(), items, blocked, rejected, errors });
      return;
    }

    // 操作结果查询（TASK-R5 评审 #3）：前端超时/断连后凭 opId 回查这次提交到底落没落。
    // found:false 只说明「登记簿里没有」——请求没到、还在写、或服务重启过都长这样，
    // 前端据此走等待/状态比对兜底，不能直接当失败。
    if (path === '/api/office/op-status' && method === 'GET') {
      const q = new URL(req.url, `http://127.0.0.1:${PORT}`);
      const opId = String(q.searchParams.get('opId') || '').trim().slice(0, 64);
      if (!opId) throw httpError(400, 'MISSING_OP_ID', '缺少 opId 参数');
      const rec = opLog.get(opId);
      if (!rec) { sendJson(res, 200, { found: false }); return; }
      const { opId: _id, ...view } = rec;
      sendJson(res, 200, { found: true, op: view });
      return;
    }

    // 决策处理（TASK-R2）：approve → flow.mjs set --status done；reject → --status failed。
    // 写之前重算一次可处理性，档案若已变（比如 Hermes 刚标过），409 拒绝覆盖。
    if (path === '/api/office/decide' && method === 'POST') {
      const body = await readJsonBody(req);
      const taskId = String(body.taskId || '');
      const stepKey = String(body.step || '');
      const action = String(body.action || '');
      if (!/^[A-Za-z0-9_-]+$/.test(taskId)) throw httpError(400, 'BAD_TASK_ID', 'taskId 只能是字母数字_-');
      if (!STEP_DEFS.some((d) => d.key === stepKey)) throw httpError(400, 'BAD_STEP', `没有这一步：${stepKey || '(空)'}`);
      if (action !== 'approve' && action !== 'reject') throw httpError(400, 'BAD_ACTION', 'action 只能是 approve / reject');
      const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : '';
      if (action === 'reject' && note === '') throw httpError(400, 'REASON_REQUIRED', '打回必须写一句理由（≤500 字）');
      const opId = typeof body.opId === 'string' && body.opId.trim() ? body.opId.trim().slice(0, 64) : undefined;

      // 幂等重放（TASK-R5 评审 #3）：同 opId 已执行过就直接回上次结果，不再写回。
      // 网络超时后前端重试同一 opId，不会造成第二次执行。放在可处理性重算之前——
      // 重放时步骤多半已不在 awaiting，按新请求算会误报 409。
      // TASK-R6（评审 #2）：重放前必须核对归属。opId 绑定 (taskId, step, action)，
      // 不一致说明这个 ID 已被另一个操作占用（前端生成碰撞 / 手工构造），
      // 把 A 的记录回给 B 等于冒充执行结果——409 拒绝，让调用方换新 opId。
      if (opId && opLog.has(opId)) {
        const rec = opLog.get(opId);
        if (rec.taskId !== taskId || rec.step !== stepKey || rec.action !== action) {
          throw httpError(409, 'OP_CONFLICT', '操作标识已绑定到其它任务/步骤/动作，不能重放为本次请求的结果；请生成新的操作标识');
        }
        if (rec.ok !== true) throw httpError(500, 'FLOW_WRITE_FAILED', `flow.mjs 写回失败：${String(rec.msg || '').slice(0, 300)}`);
        sendJson(res, 200, {
          ok: true, taskId, step: stepKey, action, status: rec.status,
          opId, replay: true,
          verified: rec.verified === true,
          readBack: rec.readBack !== false,
          after: rec.after || null,
          unconfirmed: rec.unconfirmed === true,          // TASK-R7（评审 #1）：重放带全未确认口径
          unverifiedReason: rec.unverifiedReason || null,
        });
        return;
      }

      const taskFile = join(AUTOLOOP_HOME, 'office-data', 'tasks', `${taskId}.json`);
      const readRec = () => {
        try { return JSON.parse(readFileSync(taskFile, 'utf8')); }
        catch { throw httpError(404, 'TASK_NOT_FOUND', `任务档案不存在或损坏：${taskId}`); }
      };
      const rec = readRec();
      const { items } = computeDecisions([rec]);
      if (!items.some((it) => it.stepKey === stepKey)) {
        throw httpError(409, 'NOT_ACTIONABLE', '这一步当前不可决策（可能刚被其它入口处理过，刷新看最新状态）');
      }

      // W01：产物类型门禁与 /api/office/decision 同一口径——两条审批写入路径
      // 不允许一严一松，否则绕过前端直打旧端点就能批进不合规材料。
      if (action === 'approve') {
        const gate = artifactGateOf(rec, stepKey);
        if (!gate.valid) throw httpError(409, 'ARTIFACT_KIND_MISMATCH', artifactMismatchMessage(stepKey, gate));
      }

      // W01/W02：审批对象版本门禁，同样两端口同规——登记版本与当前物理文件不一致
      // （字节 / 内容哈希 / 缺失）时正式流程拒绝按原版本通过；test-any-file 的版本
      // 例外在 artifactVersionGateOf 内独立判定（与类型例外分开），豁免时 valid=true。
      if (action === 'approve') {
        const vgate = artifactVersionGateOf(rec, stepKey);
        if (!vgate.valid) throw httpError(409, 'ARTIFACT_VERSION_DRIFT', artifactVersionMessage(stepKey, vgate));
      }

      const lockKey = `${taskId}/${stepKey}`;
      if (!lockDecision(lockKey)) throw httpError(409, 'WRITE_IN_FLIGHT', '这一步正有写回在途，稍等它完成再操作');

      const status = action === 'approve' ? 'done' : 'failed';
      const args = [join(AUTOLOOP_HOME, 'flow.mjs'), 'set', taskId, stepKey, '--status', status, '--by', WORKBENCH_WRITER.decide];
      if (note) args.push('--note', note);
      // TASK-R7（评审 #1/#2/#8）：写回 + 读回核验收敛到统一服务。
      // 报错路径不再拿「状态恰好等于目标」冒领成功——归属判定用 --by 标记 +
      // 操作起始时间；读不回档案保持「未确认」而非「写入失败」。
      // 锁仍覆盖写回+核验全程，finally 释放（TASK-R4 口径不变）。
      try {
        const outcome = await execFlowWriteAndVerify({
          args, taskFile, stepKey, status,
          writerMark: WORKBENCH_WRITER.decide, opStartMs: Date.now(),
        });
        respondFlowWriteResult(res, opId, { taskId, step: stepKey, action, status }, outcome);
      } finally {
        unlockDecision(lockKey);
      }
      return;
    }

    // 打回重提（TASK-R3）：reject 之后步骤停在 failed，此前没有任何入口能救回来，
    // 页面上也无处理按钮——打回等于死路。重提 = 把 failed 设回 awaiting 重新等拍板；
    // 后续步骤维持 blocked，直到这一步重新 approve 才解锁，顺序不变，只补再入路径。
    if (path === '/api/office/resubmit' && method === 'POST') {
      const body = await readJsonBody(req);
      const taskId = String(body.taskId || '');
      const stepKey = String(body.step || '');
      const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : '';
      if (!/^[A-Za-z0-9_-]+$/.test(taskId)) throw httpError(400, 'BAD_TASK_ID', 'taskId 只能是字母数字_-');
      if (!STEP_DEFS.some((d) => d.key === stepKey)) throw httpError(400, 'BAD_STEP', `没有这一步：${stepKey || '(空)'}`);

      const opId = typeof body.opId === 'string' && body.opId.trim() ? body.opId.trim().slice(0, 64) : undefined;

      // 幂等重放（TASK-R5 评审 #3）：同 decide——重试同一 opId 不二次执行。
      // TASK-R6（评审 #2）：必须放在「failed 状态检查」之前——重放成功时步骤已经
      // 是 awaiting，先验状态会把重试请求 409 掉（成功重提后的同 ID 请求被拒）。
      // 归属核对同 decide：opId 绑定 (taskId, step, resubmit)，不一致 409 冲突。
      if (opId && opLog.has(opId)) {
        const rec = opLog.get(opId);
        if (rec.taskId !== taskId || rec.step !== stepKey || rec.action !== 'resubmit') {
          throw httpError(409, 'OP_CONFLICT', '操作标识已绑定到其它任务/步骤/动作，不能重放为本次请求的结果；请生成新的操作标识');
        }
        if (rec.ok !== true) throw httpError(500, 'FLOW_WRITE_FAILED', `flow.mjs 写回失败：${String(rec.msg || '').slice(0, 300)}`);
        sendJson(res, 200, {
          ok: true, taskId, step: stepKey, action: 'resubmit', status: 'awaiting',
          opId, replay: true,
          verified: rec.verified === true,
          readBack: rec.readBack !== false,
          after: rec.after || null,
          unconfirmed: rec.unconfirmed === true,          // TASK-R7（评审 #1）：重放带全未确认口径
          unverifiedReason: rec.unverifiedReason || null,
        });
        return;
      }

      const taskFile = join(AUTOLOOP_HOME, 'office-data', 'tasks', `${taskId}.json`);
      let rec;
      try { rec = JSON.parse(readFileSync(taskFile, 'utf8')); }
      catch { throw httpError(404, 'TASK_NOT_FOUND', `任务档案不存在或损坏：${taskId}`); }
      const cur = (rec.steps && rec.steps[stepKey]) || {};
      if (cur.status !== 'failed') {
        throw httpError(409, 'NOT_REJECTED', `只有被打回（failed）的步骤能重提，当前状态：${cur.status || 'pending'}`);
      }

      const lockKey = `${taskId}/${stepKey}`;
      if (!lockDecision(lockKey)) throw httpError(409, 'WRITE_IN_FLIGHT', '这一步正有写回在途，稍等它完成再操作');

      // 不写 note 时 flow.mjs 会保留原打回理由，重提面板上仍能看到为什么被打回
      const args = [join(AUTOLOOP_HOME, 'flow.mjs'), 'set', taskId, stepKey, '--status', 'awaiting', '--by', WORKBENCH_WRITER.resubmit];
      if (note) args.push('--note', `重提说明：${note}`);
      // TASK-R7（评审 #1/#2/#8）：与 decide 同一统一写回核验服务，口径完全一致。
      // 锁仍覆盖写回+核验全程，finally 释放（TASK-R4 口径不变）。
      try {
        const outcome = await execFlowWriteAndVerify({
          args, taskFile, stepKey, status: 'awaiting',
          writerMark: WORKBENCH_WRITER.resubmit, opStartMs: Date.now(),
        });
        respondFlowWriteResult(res, opId, { taskId, step: stepKey, action: 'resubmit', status: 'awaiting' }, outcome);
      } finally {
        unlockDecision(lockKey);
      }
      return;
    }

    // 决策直写（TASK-11.1 / R1 核心交付闭环）：
    //   body: { demandId, stepKey, action: 'approve'|'reject'|'request', reason? }
    //   approve → done（必须有可审批对象，否则 409 APPROVE_NEEDS_ARTIFACT——
    //              「先有证据再审批」在服务端兜底，不是只把按钮藏起来）
    //   reject  → failed（reason 必填）
    //   request → awaiting（reason 必填；步骤仍停在待拍板，note 记「补齐材料：…」）
    // 原子写 + 事件记录 + 响应即写后真实状态（见文件头部 TASK-11.1 注释）。
    if (path === '/api/office/decision' && method === 'POST') {
      const body = await readJsonBody(req);
      const demandId = String(body.demandId || '');
      const stepKey = String(body.stepKey || '');
      const action = String(body.action || '');
      const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : '';
      if (!/^[A-Za-z0-9_-]+$/.test(demandId)) throw httpError(400, 'BAD_DEMAND_ID', 'demandId 只能是字母数字_-');
      if (!STEP_DEFS.some((d) => d.key === stepKey)) throw httpError(400, 'BAD_STEP', `没有这一步：${stepKey || '(空)'}`);
      if (action !== 'approve' && action !== 'reject' && action !== 'request') {
        throw httpError(400, 'BAD_ACTION', 'action 只能是 approve / reject / request');
      }
      if ((action === 'reject' || action === 'request') && reason === '') {
        throw httpError(400, 'REASON_REQUIRED', `${action === 'reject' ? '打回' : '补齐材料'}必须写一句理由（≤500 字）`);
      }

      const taskFile = join(AUTOLOOP_HOME, 'office-data', 'tasks', `${demandId}.json`);
      let rec;
      try { rec = JSON.parse(readFileSync(taskFile, 'utf8')); }
      catch { throw httpError(404, 'DEMAND_NOT_FOUND', `需求档案不存在或损坏：${demandId}`); }

      // 写前重算可处理性：与 decide 同一口径，档案刚被别的入口改过就 409，不覆盖
      const { items } = computeDecisions([rec]);
      if (!items.some((it) => it.stepKey === stepKey)) {
        throw httpError(409, 'NOT_ACTIONABLE', '这一步当前不可决策（可能刚被其它入口处理过，刷新看最新状态）');
      }

      // 先有证据再审批：没有可审批的对象（req 步骤除外，它批的是需求本身）不允许通过
      const approvalObject = approvalObjectOfRec(rec, stepKey);
      if (action === 'approve' && approvalObject === 'none') {
        throw httpError(409, 'APPROVE_NEEDS_ARTIFACT', '本步骤没有登记产物，没有可审批的对象：请先用 request 补齐材料');
      }

      // W01：声明的产物类型门禁——正式流程里，登记产物未声明本步骤要求的
      // 类型（如 plan 步骤要求 kind:'plan'）就不是有效审批对象，服务端直接 409，
      // 不靠前端藏按钮。测试豁免（test-any-file 策略）依据必须已入档。
      const gate = artifactGateOf(rec, stepKey);
      if (action === 'approve' && !gate.valid) {
        throw httpError(409, 'ARTIFACT_KIND_MISMATCH', artifactMismatchMessage(stepKey, gate));
      }

      // W01/W02：审批对象版本门禁（与 /api/office/decide 同一规则）——正式流程按
      // 提交登记的版本审批，文件漂移/内容指纹不一致/缺失/无版本标识时 409，
      // 前端禁用只是提示；test-any-file 的版本例外在 artifactVersionGateOf 内
      // 独立判定（类型例外与版本例外分开，互不混用），豁免时 valid=true 放行。
      if (action === 'approve') {
        const vgate = artifactVersionGateOf(rec, stepKey);
        if (!vgate.valid) throw httpError(409, 'ARTIFACT_VERSION_DRIFT', artifactVersionMessage(stepKey, vgate));
      }

      const lockKey = `${demandId}/${stepKey}`;
      if (!lockDecision(lockKey)) throw httpError(409, 'WRITE_IN_FLIGHT', '这一步正有写回在途，稍等它完成再操作');

      const writerMark = action === 'request' ? WORKBENCH_WRITER.request : WORKBENCH_WRITER.decide;
      const target = action === 'approve' ? 'done' : action === 'reject' ? 'failed' : 'awaiting';
      const from = (((rec.steps || {})[stepKey] || {}).status) || 'pending';
      const at = new Date().toISOString();
      let writeError = null;
      try {
        rec.steps = rec.steps || {};
        const cur = rec.steps[stepKey] || { status: 'pending', at: null, note: '', by: null, files: [], runs: [] };
        rec.steps[stepKey] = {
          ...cur,                                     // files / runs 原样保留，只动决策字段
          status: target,
          at,
          note: action === 'request' ? `补齐材料：${reason}` : (reason || cur.note || ''),
          by: writerMark,
        };
        saveTaskFileAtomic(taskFile, rec);
      } catch (err) {
        writeError = err.message;
      } finally {
        unlockDecision(lockKey);
      }
      if (writeError) {
        throw httpError(500, 'ATOMIC_WRITE_FAILED', `原子写失败（档案未替换成新状态）：${writeError}`);
      }

      // 响应必须是写后的真实状态：rename 完成后重新读回，不回内存副本
      let after;
      try { after = JSON.parse(readFileSync(taskFile, 'utf8')); }
      catch { throw httpError(500, 'READBACK_FAILED', '写入后读回档案失败，请刷新核对（写入本身可能已成功）'); }
      const demand = taskDemandView(after);
      const st = demand.steps.find((s) => s.key === stepKey);
      const verified = st.status === target;
      const event = {
        at, actor: writerMark, demandId, stepKey, action,
        reason: reason || null, from, to: st.status,
        result: verified ? 'written' : 'mismatch',
      };
      event.logError = appendDecisionEvent(event);   // null = 已落事件记录
      sendJson(res, 200, {
        ok: true, verified, action, from, to: st.status,
        approvalObject, step: st, demand, event,
      });
      return;
    }

    // 受控下载（TASK-R2）：二进制/大文件预览不了时给条真出路，而不是只能看 meta。
    // 只放行白名单路径，带 content-disposition，流式回写，出错直接断开。
    if (path === '/api/office/file-download' && method === 'GET') {
      const q = new URL(req.url, `http://127.0.0.1:${PORT}`);
      const raw = String(q.searchParams.get('path') || '');
      if (!raw) throw httpError(400, 'MISSING_PATH', '缺少 path 参数');
      const p = normalize(raw).replace(/\\/g, '/');
      if (!isAllowedPath(p)) throw httpError(403, 'PATH_NOT_ALLOWED', '该路径不在允许下载的目录内');
      let st;
      try { st = statSync(p); }
      catch { throw httpError(404, 'NOT_FOUND', '文件不存在或已被移走'); }
      if (!st.isFile()) throw httpError(400, 'NOT_A_FILE', '不是文件');
      const base = p.split('/').pop();
      const { createReadStream } = await import('node:fs');
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': st.size,
        'content-disposition': `attachment; filename="${encodeURIComponent(base)}"; filename*=UTF-8''${encodeURIComponent(base)}`,
        'cache-control': 'no-store',
      });
      const stream = createReadStream(p);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
      return;
    }

    let m;
    if ((m = path.match(/^\/api\/cards\/(\d+)\/answer$/)) && method === 'POST') {
      sendJson(res, 200, await handleAnswer(m[1], await readJsonBody(req)));
      return;
    }
    if ((m = path.match(/^\/api\/cards\/(\d+)\/resolve$/)) && method === 'POST') {
      sendJson(res, 200, await handleResolve(m[1], await readJsonBody(req)));
      return;
    }
    if ((m = path.match(/^\/api\/runs\/(\d+)\/cancel$/)) && method === 'POST') {
      sendJson(res, 200, await handleCancel(m[1]));
      return;
    }

    // 已知端点但方法不对 → 405；其余（含路径穿越、怪 id、未列出的中台端点）一律 404。
    // 白名单之外不代理任何东西——前端无法借道本服务访问中台其它接口。
    const known = [
      [/^\/api\/state$/, ['GET']],
      [/^\/api\/health$/, ['GET']],
      [/^\/api\/cards\/\d+\/answer$/, ['POST']],
      [/^\/api\/cards\/\d+\/resolve$/, ['POST']],
      [/^\/api\/runs\/\d+\/cancel$/, ['POST']],
      [/^\/api\/office\/decisions$/, ['GET']],
      [/^\/api\/office\/decide$/, ['POST']],
      [/^\/api\/office\/decision$/, ['POST']],
      [/^\/api\/office\/resubmit$/, ['POST']],
      [/^\/api\/office\/op-status$/, ['GET']],
      [/^\/api\/office\/file-download$/, ['GET']],
      [/^\/api\/office\/file-revalidate$/, ['POST']],
    ];
    if (known.some(([re, methods]) => re.test(path) && !methods.includes(method))) {
      throw httpError(405, 'METHOD_NOT_ALLOWED', `${method} ${path} 不支持`);
    }
    throw httpError(404, 'NOT_FOUND', `${method} ${path} 不存在（本服务只开放 /api/state、/api/health、/api/cards/:id/answer、/api/cards/:id/resolve、/api/runs/:id/cancel、/api/office/decisions、/api/office/decide、/api/office/decision、/api/office/resubmit、/api/office/op-status、/api/office/file-download、/api/office/file-revalidate）`);
  } catch (err) {
    const statusCode = err.statusCode || 500;
    // 500 级错误不回传内部细节，避免任何意外泄漏
    const message = statusCode >= 500 && !err.code?.startsWith('HUB')
      ? '服务内部错误'
      : err.message;
    if (statusCode >= 500) console.error(`[错误] ${method} ${path} → ${err.code}: ${err.message}`);
    sendJson(res, statusCode, { error: message, code: err.code || 'INTERNAL' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Soda Agent 工作台  http://127.0.0.1:${PORT}  build=${BUILD_VERSION}`);
  console.log(`代理到中台        ${HUB}（owner key 已从 config.json 载入内存，不出服务端）`);
});

process.on('SIGINT', () => {
  console.log('\n收到 SIGINT，关闭工作台服务');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
});
