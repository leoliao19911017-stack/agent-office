// server-api.mjs — G02（R73 第 73 轮）从 server.js 拆出的 /api/* 路由层。
// 纯代码搬移：17 个路由体逐字未动（含 405/404 兜底）；TASK-向导化改造新增
// /api/office/review（GET/POST）与 /api/office/new-task（POST），共 20 个路由。协议、状态码、错误码、
// 响应字段全部与拆分前一致；依赖经 createApiRouter 工厂注入（对齐 server-core.mjs
// 的 createDecisionCore 注入风格）。决策核心六件套在本模块内实例化一次，
// 与拆分前 server.js 单实例行为等价。owner key 仍只在进程内存，不进本文件。
// G02（R75 第 75 轮）：原单个 api() 路由函数 763 行（17 路由全内联，超「>120 必须
// 拆分」红线）。按路由拆为模块级 maker——每个 maker 按需解构依赖、返回自己的
// 处理器，路由体逐字搬入未改动；api() 收敛为纯派发 + 405/404 兜底（逐字保留）。
// 决策核心仍只实例化一次，17 个处理器共享，与拆分前行为等价。
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import {
  STEP_DEFS, WORKBENCH_WRITER, computeDecisions, execFlowWriteAndVerify,
  lockDecision, unlockDecision,
  artifactPolicyOf, artifactGateOf, artifactMismatchMessage,
  artifactVersionGateOf, artifactVersionMessage,
  approvalObjectOfRec, taskDemandView,
  createDecisionCore,
} from './server-core.mjs';
// TASK-R87整改 X01/X03：需求讨论自动推进器（服务端模块，不经 STATIC_APP）
import { kickoffAutoAdvance, startDiscussRecord, discussView } from './server-auto.mjs';
// X01（让 Agent 状态显示真实情况）：/api/agents/real 只读探测——进程/最近活动/额度
import { makeAgentsRealRoute } from './server-agents-real.mjs';
// P0 地基：任务/事件/检查点/三独立状态 API（/api/tasks*、/api/agents/status-v2）。
// 路由体在 api-tasks.mjs；这里只做挂载，不重复任何状态判定。
import { handleTasksApi } from './api-tasks.mjs';

// /api/health
function makeHealthRoute(deps) {
  const { sendJson, handleHealth } = deps;
  return async (req, res) => {
    sendJson(res, 200, await handleHealth());
    return;
  };
}

// /api/state
function makeStateRoute(deps) {
  const { sendJson, callHub } = deps;
  return async (req, res) => {
    sendJson(res, 200, await callHub('/v1/state'));
    return;
  };
}

// /api/office/hermes —— 三个 Hermes 入口（Lemate / Winter / Karina）的实时状态。
// 平级架构：每个 Hermes 只自报自己那一行，这里只负责读，不做调度。
function makeHermesRoute(deps) {
  const { AUTOLOOP_HOME, sendJson } = deps;
  return async (req, res) => {
    const base = AUTOLOOP_HOME;
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
  };
}

// /api/office/files —— Leo's Agent Office：任务档案与文件汇总（读取 office-data/index.json）
// TASK-R2：读失败时带 readError 返回，前端据此显示错误态而不是空数据
function makeFilesRoute(deps) {
  const { sendJson, readOfficeJsonDetailed } = deps;
  return async (req, res) => {
    const { payload, readError } = readOfficeJsonDetailed('index.json', { generatedAt: null, tasks: [] });
    sendJson(res, 200, { ...payload, readError });
    return;
  };
}

// /api/office/skills —— 技能中心索引（读取 office-data/skills.json）
// TASK-R11/S02：合并 skill-meta.json 里的用途分类 overlay。
// 分类是人工维护的元数据——服务端不做任何自动猜测，
// overlay 里没有的技能 category=null，前端归「未分类」。
function makeSkillsRoute(deps) {
  const { sendJson, readOfficeJsonDetailed, readOfficeJson } = deps;
  return async (req, res) => {
    const { payload, readError } = readOfficeJsonDetailed('skills.json', { generatedAt: null, skills: [] });
    const meta = readOfficeJson('skill-meta.json', null);
    const categories = meta && meta.categories && typeof meta.categories === 'object' ? meta.categories : null;
    const skills = (payload.skills || []).map((s) => ({
      ...s,
      category: categories && typeof categories[s.name] === 'string' ? categories[s.name] : null,
    }));
    sendJson(res, 200, { ...payload, skills, readError });
    return;
  };
}

// ---- X05（TASK-向导化改造）：AI 活动四字段 --------------------------------
// 统一口径：current_activity（在干什么，人话）/ activity_state（working |
// awaiting_user | idle | unknown 四态互斥）/ activity_updated_at（最近一次
// 状态变化时间）/ run_id（关联的 Autoloop run，没有就 null）。
// 「在线」是连接口径（/api/office/hermes），绝不混进四态冒充「正在干活」。
// 步骤人话与 cabin.js 的 X03 术语表同源同值——这里只是展示字典，不改业务标识。

// 各步骤「AI 正在为你……」的动词（display only，不改 STEP_DEFS 的 key/name）
const ACTIVITY_DOING = {
  req: '整理你的想法', doc: '整理需求文档', plan: '制定开发计划',
  brief: '准备派活说明', deliverable: '开发软件', verify: '检查做得怎么样',
  final: '准备最终交付',
};
// 各步骤的小白叫法（与 cabin.js STEP_HUMAN 同值）
const ACTIVITY_STEP_CN = {
  req: '你的想法', doc: '需求文档', plan: '开发计划', brief: '派活说明',
  deliverable: '软件成品', verify: '检查结果', final: '最终交接',
};

/** 单任务的 activity 四字段（由真实步骤状态推导，不写死任何文案占位） */
function activityOfTask(rec, steps, decidableKeys) {
  const updatedAt = rec.updatedAt || null;
  const lastRunId = (() => {
    for (let i = steps.length - 1; i >= 0; i -= 1) {
      const rs = steps[i].runs || [];
      if (rs.length) return String(rs[rs.length - 1].runId || '') || null;
    }
    return null;
  })();
  const running = steps.find((s) => s.status === 'running') || null;
  if (running) {
    return {
      current_activity: `AI 正在为你${ACTIVITY_DOING[running.key] || '处理'}（${ACTIVITY_STEP_CN[running.key] || running.name}）`,
      activity_state: 'working',
      activity_updated_at: running.at || updatedAt,
      run_id: lastRunId,
    };
  }
  // decidableKeys 来自 computeDecisions 的 items——「真可拍板」而不是「awaiting 了」。
  // 但 gate+pending（可拍板但材料还没交）不能播报「已经做好等你确认」——只有
  // 真正交上来的 awaiting 才是「等你确认」，gate 空挂着仍按排队播报。
  const waiting = steps.find((s) => decidableKeys.has(s.key) && s.status === 'awaiting') || null;
  if (waiting) {
    return {
      current_activity: `${ACTIVITY_STEP_CN[waiting.key] || waiting.name}已经做好，等你确认`,
      activity_state: 'awaiting_user',
      activity_updated_at: waiting.at || updatedAt,
      run_id: lastRunId,
    };
  }
  const failed = steps.find((s) => s.status === 'failed') || null;
  if (failed) {
    return {
      current_activity: `${ACTIVITY_STEP_CN[failed.key] || failed.name}被打回了，等 AI 修改后重新交上来`,
      activity_state: 'idle',
      activity_updated_at: failed.at || updatedAt,
      run_id: lastRunId,
    };
  }
  if (steps.every((s) => s.status === 'done')) {
    return {
      current_activity: '这个软件已经全部做完，可以查看成果',
      activity_state: 'idle',
      activity_updated_at: updatedAt,
      run_id: lastRunId,
    };
  }
  const next = steps.find((s) => s.status !== 'done') || null;
  return {
    current_activity: next
      ? `排着队，下一步是${ACTIVITY_STEP_CN[next.key] || next.name}（还没开始）`
      : '暂时无法确认 AI 在做什么',
    activity_state: next ? 'idle' : 'unknown',
    activity_updated_at: updatedAt,
    run_id: lastRunId,
  };
}

/**
 * 直读 office-data/hermes-status/*.json 自报（不经子进程——flow 每 3 秒被轮询，
 * 每次起一个 hermes-status.mjs 太重）。过期阈值 2 分钟，与 hermes-status.mjs
 * read 的降级语义一致：过期 → state 按 idle、task 标「上次上报已过期」。
 * 在线与否不在这里判——那要读心跳，归 /api/office/hermes。
 */
function readHermesReports(base) {
  const dir = join(base, 'office-data', 'hermes-status');
  const reports = [];
  const errors = [];
  try {
    const now = Date.now();
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      try {
        const r = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        if (!r || !r.id || !r.reportedAt) continue;
        const ageMs = now - Date.parse(r.reportedAt);
        if (!Number.isFinite(ageMs)) continue;
        const fresh = ageMs <= 2 * 60 * 1000;
        reports.push({
          id: r.id, name: r.name || r.id,
          state: fresh ? (r.state === 'working' ? 'working' : 'idle') : 'idle',
          task: fresh ? (r.task || '') : '（上次上报已过期）',
          reportedAt: r.reportedAt, fresh,
        });
      } catch (err) {
        errors.push({ file: f, message: err.message });
      }
    }
  } catch {
    // 目录不存在 = 从来没有自报，是真空，不算错误
  }
  return { reports, errors };
}

/** 顶层 live：系统级「AI 正在干什么」头条（优先正在跑的任务 > 等确认 > 新鲜自报） */
function liveHeadline(tasks, hermesReports) {
  const runningTask = tasks.find((t) => t.activity && t.activity.activity_state === 'working');
  if (runningTask) {
    return { ...runningTask.activity, source: 'task', taskId: runningTask.id, taskTitle: runningTask.title };
  }
  const waitingTask = tasks.find((t) => t.activity && t.activity.activity_state === 'awaiting_user');
  if (waitingTask) {
    return { ...waitingTask.activity, source: 'task', taskId: waitingTask.id, taskTitle: waitingTask.title };
  }
  const freshWorking = hermesReports.find((r) => r.fresh && r.state === 'working');
  if (freshWorking) {
    return {
      current_activity: `${freshWorking.name}正在做：${freshWorking.task || '（没写具体任务）'}`,
      activity_state: 'working',
      activity_updated_at: freshWorking.reportedAt,
      run_id: null, source: 'hermes', taskId: null, taskTitle: null,
    };
  }
  const freshIdle = hermesReports.find((r) => r.fresh);
  if (freshIdle) {
    return {
      current_activity: 'AI 助手空闲，现在没有正在进行的活',
      activity_state: 'idle',
      activity_updated_at: freshIdle.reportedAt,
      run_id: null, source: 'hermes', taskId: null, taskTitle: null,
    };
  }
  return {
    current_activity: tasks.length ? '现在没有 AI 正在干活的任务' : '还没有开始任何软件制作',
    activity_state: 'idle',
    activity_updated_at: null,
    run_id: null, source: 'none', taskId: null, taskTitle: null,
  };
}

// /api/office/flow —— 需求流水线：7 步全貌（读 office-data/tasks/*.json）
// 这是「以需求为主线」的视图，跟以 Agent 为主线的 /api/state 互补。
// TASK-向导化改造（X05）：每个任务附 activity 四字段；顶层附 live 头条。
function makeFlowRoute(deps) {
  const { AUTOLOOP_HOME, sendJson } = deps;
  return async (req, res) => {
    const dir = join(AUTOLOOP_HOME, 'office-data', 'tasks');
    // STEP_DEFS 已收敛为文件顶部唯一定义（TASK-R3），这里直接用，不再内联一份
    // TASK-R2：逐文件隔离——一个损坏的任务档案只报它自己的错，
    // 不能拖垮整批需求。「部分数据 + 坏文件清单」好过「全空」。
    let tasks = [];
    const recs = [];
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
        recs.push(rec);
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
    // X05：可拍板键集合复用 /api/office/decisions 的同一条规则（computeDecisions），
    // 「等你确认」的判定不另起炉灶——两端口径必须一致。
    const decidableByTask = new Map();
    try {
      const { items } = computeDecisions(recs);
      for (const it of items) {
        if (!decidableByTask.has(it.taskId)) decidableByTask.set(it.taskId, new Set());
        decidableByTask.get(it.taskId).add(it.stepKey);
      }
    } catch (err) {
      readErrors.push({ file: '(decisions)', message: `可拍板集合计算失败：${err ? err.message : '未知错误'}` });
    }
    for (const t of tasks) {
      const rec = recs.find((r) => r.id === t.id) || null;
      t.activity = rec
        ? activityOfTask(rec, t.steps, decidableByTask.get(t.id) || new Set())
        : { current_activity: '暂时无法确认这个任务的状态', activity_state: 'unknown', activity_updated_at: null, run_id: null };
    }
    const { reports: hermesReports, errors: hermesErrors } = readHermesReports(AUTOLOOP_HOME);
    const live = liveHeadline(tasks, hermesReports);
    sendJson(res, 200, {
      generatedAt: new Date().toISOString(),
      tasks, live,
      hermesReports,
      errors: readErrors.concat(hermesErrors),
    });
    return;
  };
}

// /api/office/file —— 产物内容读取（C · 产物库）：点开文件能看到真实内容。
// 安全：只读白名单根目录内的绝对路径，拒绝 .. 穿越。
function makeFileRoute(deps) {
  const { PORT, TEXT_EXT, IMAGE_EXT, httpError, sendJson, isAllowedPath } = deps;
  return async (req, res) => {
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
    // F02：全文 sha256（不受 2MB 截断影响），前端用它核对预览内容是否属于所选登记版本
    const sha256 = createHash('sha256').update(buf).digest('hex');
    sendJson(res, 200, {
      exists: true, path: p, name: base, ext, kind: 'text',
      bytes: st.size, truncated, text, sha256,
      modifiedAt: st.mtime.toISOString(),
    });
    return;
  };
}

// /api/office/file-version —— F02（第 3 轮）：历史版本读取——「物理文件标识（path）
// + 版本登记标识（taskId›stepKey，可带 vkey 双确认）」共同定位，绝不拿磁盘当前
// 文件冒充历史版本：
//   磁盘现状与登记指纹核对一致            → 200 available=true  source=disk-current
//   登记保存原文/历史快照留档经 sha256 核对一致 → 200 available=true  source=snapshot
//   快照不存在/快照核对不上（F01 第 78 轮）  → 404 available=false + 真实实测值，
//   快照候选逐条回实测字节与指纹，核对过程 curl 可见；404 即「该历史版本没有
//   可服务的快照」，绝不拿磁盘当前文件冒充。登记本身未存版本标识（no-version）
//   属登记缺陷而非快照缺失，维持 200 明示。
function makeFileVersionRoute(deps) {
  const { PORT, httpError, sendJson, taskFileOf, isAllowedPath } = deps;
  return async (req, res) => {
    const q = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const raw = String(q.searchParams.get('path') || '');
    const taskId = String(q.searchParams.get('taskId') || '');
    const stepKey = String(q.searchParams.get('stepKey') || '');
    const vkey = String(q.searchParams.get('vkey') || '');
    if (!raw || !taskId || !stepKey) {
      throw httpError(400, 'MISSING_IDS', '需要 path + taskId + stepKey：物理文件标识与版本登记标识共同定位');
    }
    const p = normalize(raw).replace(/\\/g, '/');
    if (!isAllowedPath(p)) throw httpError(403, 'PATH_NOT_ALLOWED', '该路径不在允许读取的目录内');
    let rec = null;
    try { rec = JSON.parse(readFileSync(taskFileOf(taskId), 'utf8')); } catch { /* 档案不在/损坏＝没有这条登记 */ }
    const stepRec = rec && rec.steps && rec.steps[stepKey] ? rec.steps[stepKey] : null;
    const files = stepRec && Array.isArray(stepRec.files) ? stepRec.files : null;
    const notFound = (msg) => sendJson(res, 404, { ok: false, available: false, reason: 'reg-not-found', error: msg });
    if (!files) { notFound(`没有这条登记：${taskId}›${stepKey}`); return; }
    const f = files.find((x) => x && typeof x.path === 'string' && normalize(x.path).replace(/\\/g, '/') === p) || null;
    if (!f) { notFound(`这条登记不含该物理文件：${taskId}›${stepKey} › ${p}`); return; }
    const regSha = typeof f.sha256 === 'string' && f.sha256 ? f.sha256 : null;
    const regBytes = Number.isFinite(f.bytes) ? f.bytes : null;
    // vkey（版本登记标识）双确认：与登记自身的版本键不一致就拒绝，防止拿 A 登记的身份读 B 登记的内容
    if (vkey) {
      const want = regSha ? `sha:${regSha}` : (regBytes != null ? `b:${regBytes}` : '');
      if (want && vkey !== want) {
        sendJson(res, 409, { ok: false, available: false, reason: 'vkey-mismatch', error: `版本登记标识不匹配：登记=${want}，请求=${vkey}` });
        return;
      }
    }
    const registration = { taskId, stepKey, path: p, bytes: regBytes, sha256: regSha, at: stepRec.at || null };
    if (!regSha && regBytes == null) {
      sendJson(res, 200, { ok: true, available: false, reason: 'no-version', error: '登记未存指纹与字节，没有可核对的版本标识', registration });
      return;
    }
    // 磁盘现状实测（sha256 全文口径，与 /api/office/file、artifactVersionGateOf 一致）
    let disk = { exists: false, bytes: null, sha256: null };
    try {
      const st = statSync(p);
      if (st.isFile()) disk = { exists: true, bytes: st.size, sha256: createHash('sha256').update(readFileSync(p)).digest('hex') };
    } catch { /* 读不到＝磁盘现状不存在 */ }
    const verEqual = (text) => (regSha
      ? createHash('sha256').update(text, 'utf8').digest('hex') === regSha
      : Buffer.byteLength(text, 'utf8') === regBytes);
    if (disk.exists && (regSha ? disk.sha256 === regSha : disk.bytes === regBytes)) {
      // 磁盘现状就是登记版本：核对一致后可以按「现状=该版本」展示，不是冒充
      const LIMIT = 2 * 1024 * 1024;
      const buf = readFileSync(p);
      sendJson(res, 200, {
        ok: true, available: true, source: 'disk-current',
        sourceLabel: '磁盘现状（与登记指纹核对一致）',
        bytes: disk.bytes, sha256: disk.sha256, truncated: buf.length > LIMIT,
        text: buf.subarray(0, LIMIT).toString('utf8'), registration, disk,
      });
      return;
    }
    // 历史内容候选：登记保存原文 → 最近一条快照留档（与前端 fvHistPreview 同序同口径）
    const cands = [];
    if (typeof f.text === 'string') cands.push({ text: f.text, label: '登记保存原文', at: null });
    const histArr = Array.isArray(f.history) ? f.history : [];
    for (let i = histArr.length - 1; i >= 0; i--) {
      const h = histArr[i];
      if (h && typeof h.snapshot === 'string') {
        cands.push({ text: h.snapshot, label: `登记历史快照（${h.at || '时间 —'}留档）`, at: h.at || null });
        break;   // 只取最近一条，与前端一致
      }
    }
    const measured = cands.map((c) => ({
      label: c.label, bytes: Buffer.byteLength(c.text, 'utf8'),
      sha256: createHash('sha256').update(c.text, 'utf8').digest('hex'), at: c.at,
    }));
    for (let i = 0; i < cands.length; i++) {
      if (verEqual(cands[i].text)) {
        sendJson(res, 200, {
          ok: true, available: true, source: 'snapshot', sourceLabel: cands[i].label,
          bytes: measured[i].bytes, sha256: measured[i].sha256, truncated: false,
          text: cands[i].text, registration, disk,
        });
        return;
      }
    }
    // F01（第 78 轮）：快照不存在/核对不上 → HTTP 404——该历史版本没有可服务的
    // 快照，明确失败；payload 结构与 200 时代一致（reason/error/实测候选），
    // 前端照常渲染「服务端核对」行，只是 HTTP 语义从「成功但不可用」改为「未找到」。
    sendJson(res, 404, {
      ok: false, available: false,
      reason: cands.length ? 'snapshot-mismatch' : 'no-snapshot',
      error: cands.length
        ? `快照留档与登记版本核对不上（候选 ${cands.length} 条均不符），不能冒充历史原文，不可预览`
        : '该登记没有保存原文或快照留档，历史原文不可预览',
      registration, disk, candidates: measured,
    });
    return;
  };
}

// /api/office/file-check —— 产物存在性核实（TASK-7.1）：flow 里登记的 path 可信度
// 有限（字节过期、文件被移走），由服务端 stat 后回「存在 + 实测字节数」，前端据此
// 标红失效产物。只查存在性与大小，不读内容；一次最多 200 条，防滥用。
function makeFileCheckRoute(deps) {
  const { httpError, sendJson, readJsonBody } = deps;
  return async (req, res) => {
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
      let errCode = null;   // F01（第 73 轮）：不可读时回真实错误码（ENOENT/EACCES/EPERM/EISDIR…），
      try {                 // 前端据此映射原因文案；stat 正常但不是普通文件也归不可读并给分类码
        const st = statSync(s);
        if (st.isFile()) { exists = true; bytes = st.size; mtime = st.mtime.toISOString(); }
        else errCode = st.isDirectory() ? 'EISDIR' : 'UNKNOWN';
      } catch (e) {   // 不存在 / 权限拒绝 / 路径不可达：如实回 false + 系统错误码
        errCode = e && typeof e.code === 'string' ? e.code : 'UNKNOWN';
      }
      return { path: s, exists, bytes, mtime, errCode };
    });
    sendJson(res, 200, { results });
    return;
  };
}

// /api/office/version-gate —— W02（版本门禁轮）：审批版本判定的唯一权威出口——前端
// 中央异常标签 / 右侧警示块 / 主操作禁用三处都消费这份判定（同一产物 ID + 同一审批
// 版本），决策端点 decide/decision 在写前重跑的也是同一个 artifactVersionGateOf：
// 三处与审批接口按构造同源，前端展示与服务端拒绝不会再各说各话。只读，不写档案不加锁。
function makeVersionGateRoute(deps) {
  const { httpError, sendJson, readJsonBody, taskFileOf } = deps;
  return async (req, res) => {
    const body = await readJsonBody(req);
    const taskId = String(body.taskId || '');
    const stepKey = String(body.stepKey || '');
    if (!/^[A-Za-z0-9_-]+$/.test(taskId)) throw httpError(400, 'BAD_TASK_ID', 'taskId 只能是字母数字_-');
    if (!STEP_DEFS.some((d) => d.key === stepKey)) throw httpError(400, 'BAD_STEP', `没有这一步：${stepKey || '(空)'}`);
    const taskFile = taskFileOf(taskId);
    let rec;
    try { rec = JSON.parse(readFileSync(taskFile, 'utf8')); }
    catch { throw httpError(404, 'TASK_NOT_FOUND', `任务档案不存在或损坏：${taskId}`); }
    const g = artifactVersionGateOf(rec, stepKey);
    sendJson(res, 200, {
      taskId, stepKey, src: g.src, policy: g.policy, valid: g.valid, drifted: g.drifted,
      verified: Array.isArray(g.verified) ? g.verified : [],
      versionExempt: g.versionExempt === true,
    });
    return;
  };
}

// /api/office/file-revalidate —— TASK-R11/F02：重新校验单个产物，用真实文件元数据
// 更新任务档案里的登记值。行为约定（数据可靠性，不是样式）：
//   - 白名单外 / 参数缺失 → 400/403 协议错误；
//   - 文件当前不可读（不存在/被移走/无权限）→ 200 {ok:false, reason:'unreadable'}，
//     登记值原样保留（不可把「无法校验」推断成「已丢失」），事件照记；
//   - 可读 → 现算 sha256，命中 taskId+stepKey+path 的登记条目：
//     旧登记快照追加进 history（保留历史），登记值更新为实测值，
//     原子写回 + 事件留痕，响应给出 before/after 全量对照。
function makeFileRevalidateRoute(deps) {
  const { httpError, sendJson, readJsonBody, taskFileOf, isAllowedPath, saveTaskFileAtomic, appendFileEvent } = deps;
  return async (req, res) => {
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

    const taskFile = taskFileOf(taskId);
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
  };
}

// /api/office/decisions —— 待决策清单（TASK-R2）：把「哪些决策点真的能动」收敛成
// 服务端单一口径，前端不再自己数 gate+pending——那正是把 OFFICE-V4 数错的根源。
function makeDecisionsRoute(deps) {
  const { sendJson, readTaskRecs } = deps;
  return async (req, res) => {
    const { recs, errors } = readTaskRecs();
    const { items, blocked, rejected } = computeDecisions(recs);
    sendJson(res, 200, { generatedAt: new Date().toISOString(), items, blocked, rejected, errors });
    return;
  };
}

// /api/office/op-status —— 操作结果查询（TASK-R5 评审 #3）：前端超时/断连后凭 opId
// 回查这次提交到底落没落。found:false 只说明「登记簿里没有」——请求没到、还在写、
// 或服务重启过都长这样，前端据此走等待/状态比对兜底，不能直接当失败。
function makeOpStatusRoute(deps) {
  const { PORT, httpError, sendJson, opLog } = deps;
  return async (req, res) => {
    const q = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const opId = String(q.searchParams.get('opId') || '').trim().slice(0, 64);
    if (!opId) throw httpError(400, 'MISSING_OP_ID', '缺少 opId 参数');
    const rec = opLog.get(opId);
    if (!rec) { sendJson(res, 200, { found: false }); return; }
    const { opId: _id, ...view } = rec;
    sendJson(res, 200, { found: true, op: view });
    return;
  };
}

// /api/office/decide —— 决策处理（TASK-R2）：approve → flow.mjs set --status done；
// reject → --status failed。写之前重算一次可处理性，档案若已变（比如 Hermes 刚标过），
// 409 拒绝覆盖。
function makeDecideRoute(deps) {
  // lockDecision/unlockDecision 是 server-core 模块级导入，不在注入 deps 内，直接引用
  const { AUTOLOOP_HOME, httpError, sendJson, readJsonBody, taskFileOf, opLog,
    respondFlowWriteResult } = deps;
  return async (req, res) => {
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

    const taskFile = taskFileOf(taskId);
    const readRec = () => {
      try { return JSON.parse(readFileSync(taskFile, 'utf8')); }
      catch { throw httpError(404, 'TASK_NOT_FOUND', `任务档案不存在或损坏：${taskId}`); }
    };

    // W01 r17：先拿写锁，再读档案、再校验——可处理性/类型门禁/版本门禁全部在
    // 锁内对「提交瞬间」的档案与物理文件执行，校验通过后紧接着写回。校验若在
    // 锁外，check 与 act 之间存在窗口：别的入口此刻改档案/换文件会被旧读覆盖。
    const lockKey = `${taskId}/${stepKey}`;
    if (!lockDecision(lockKey)) throw httpError(409, 'WRITE_IN_FLIGHT', '这一步正有写回在途，稍等它完成再操作');

    try {
      const rec = readRec();                       // 锁内重读，不是请求进门的旧快照
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
      // W01（第 80 轮）：文件不存在与版本漂移分开报——登记路径在磁盘上已消失是
      // 「审批对象没了」（404 ARTIFACT_FILE_MISSING），内容/大小变化才是「版本漂移」
      // （409 ARTIFACT_VERSION_DRIFT）；多文件时任一 missing 优先按 404 报。
      if (action === 'approve') {
        const vgate = artifactVersionGateOf(rec, stepKey);
        if (!vgate.valid && vgate.drifted.some((d) => d.why === 'missing')) {
          throw httpError(404, 'ARTIFACT_FILE_MISSING', artifactVersionMessage(stepKey, vgate));
        }
        if (!vgate.valid) throw httpError(409, 'ARTIFACT_VERSION_DRIFT', artifactVersionMessage(stepKey, vgate));
      }

      const status = action === 'approve' ? 'done' : 'failed';
      const args = [join(AUTOLOOP_HOME, 'flow.mjs'), 'set', taskId, stepKey, '--status', status, '--by', WORKBENCH_WRITER.decide];
      if (note) args.push('--note', note);
      // TASK-R7（评审 #1/#2/#8）：写回 + 读回核验收敛到统一服务。
      // 报错路径不再拿「状态恰好等于目标」冒领成功——归属判定用 --by 标记 +
      // 操作起始时间；读不回档案保持「未确认」而非「写入失败」。
      // W01 r17：锁覆盖读档+校验+写回+核验全程，finally 释放（TASK-R4 口径不变）。
      const outcome = await execFlowWriteAndVerify({
        args, taskFile, stepKey, status,
        writerMark: WORKBENCH_WRITER.decide, opStartMs: Date.now(),
      });
      respondFlowWriteResult(res, opId, { taskId, step: stepKey, action, status }, outcome);
    } finally {
      unlockDecision(lockKey);
    }
    return;
  };
}

// /api/office/resubmit —— 打回重提（TASK-R3）：reject 之后步骤停在 failed，此前没有
// 任何入口能救回来，页面上也无处理按钮——打回等于死路。重提 = 把 failed 设回
// awaiting 重新等拍板；后续步骤维持 blocked，直到这一步重新 approve 才解锁，
// 顺序不变，只补再入路径。
function makeResubmitRoute(deps) {
  const { AUTOLOOP_HOME, httpError, sendJson, readJsonBody, taskFileOf, opLog,
    respondFlowWriteResult } = deps;
  return async (req, res) => {
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

    const taskFile = taskFileOf(taskId);
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
  };
}

// /api/office/decision —— 决策直写（TASK-11.1 / R1 核心交付闭环）：
//   body: { demandId, stepKey, action: 'approve'|'reject'|'request', reason? }
//   approve → done（必须有可审批对象，否则 409 APPROVE_NEEDS_ARTIFACT——
//              「先有证据再审批」在服务端兜底，不是只把按钮藏起来）
//   reject  → failed（reason 必填）
//   request → awaiting（reason 必填；步骤仍停在待拍板，note 记「补齐材料：…」）
// 原子写 + 事件记录 + 响应即写后真实状态（见文件头部 TASK-11.1 注释）。
function makeDecisionRoute(deps) {
  const { httpError, sendJson, readJsonBody, taskFileOf,
    saveTaskFileAtomic, appendDecisionEvent } = deps;
  return async (req, res) => {
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

    const taskFile = taskFileOf(demandId);

    // W01 r17：先拿写锁，再读档案、再校验、再写——存在性 / 前置条件 / 类型 /
    // 版本（statSync 字节 + sha256 指纹）全部在锁内对「提交瞬间」的档案与物理
    // 文件复核，任何一条不过就不落笔；校验到写入之间不再有别的入口能插队改
    // 档案或换文件（校验在锁外时 check 与 act 之间有并发窗口）。
    const lockKey = `${demandId}/${stepKey}`;
    if (!lockDecision(lockKey)) throw httpError(409, 'WRITE_IN_FLIGHT', '这一步正有写回在途，稍等它完成再操作');

    const at = new Date().toISOString();
    let approvalObject = 'none';
    let from = 'pending';
    let target = null;
    let writerMark = null;
    let writeError = null;
    try {
      let rec;
      try { rec = JSON.parse(readFileSync(taskFile, 'utf8')); }
      catch { throw httpError(404, 'DEMAND_NOT_FOUND', `需求档案不存在或损坏：${demandId}`); }

      // 写前重算可处理性（锁内重读后）：与 decide 同一口径，档案刚被别的入口改过就 409，不覆盖
      const { items } = computeDecisions([rec]);
      if (!items.some((it) => it.stepKey === stepKey)) {
        throw httpError(409, 'NOT_ACTIONABLE', '这一步当前不可决策（可能刚被其它入口处理过，刷新看最新状态）');
      }

      // 先有证据再审批：没有可审批的对象（req 步骤除外，它批的是需求本身）不允许通过
      approvalObject = approvalObjectOfRec(rec, stepKey);
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
      // 提交登记的版本审批，文件漂移/内容指纹不一致时 409，文件不存在时 404
      // （W01 第 80 轮：missing 与漂移分码，两端口同口径），前端禁用只是提示；
      // test-any-file 的版本例外在 artifactVersionGateOf 内独立判定（类型例外与
      // 版本例外分开，互不混用），豁免时 valid=true 放行。
      if (action === 'approve') {
        const vgate = artifactVersionGateOf(rec, stepKey);
        if (!vgate.valid && vgate.drifted.some((d) => d.why === 'missing')) {
          throw httpError(404, 'ARTIFACT_FILE_MISSING', artifactVersionMessage(stepKey, vgate));
        }
        if (!vgate.valid) throw httpError(409, 'ARTIFACT_VERSION_DRIFT', artifactVersionMessage(stepKey, vgate));
      }

      writerMark = action === 'request' ? WORKBENCH_WRITER.request : WORKBENCH_WRITER.decide;
      target = action === 'approve' ? 'done' : action === 'reject' ? 'failed' : 'awaiting';
      from = (((rec.steps || {})[stepKey] || {}).status) || 'pending';
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
      }
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
  };
}

// /api/office/file-download —— 受控下载（TASK-R2）：二进制/大文件预览不了时给条真
// 出路，而不是只能看 meta。只放行白名单路径，带 content-disposition，流式回写，
// 出错直接断开。
function makeFileDownloadRoute(deps) {
  const { PORT, httpError, isAllowedPath } = deps;
  return async (req, res) => {
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
  };
}

// ---- X06（TASK-向导化改造）：评审轮次账本 ----------------------------------
// 存储位置 office-data/review-rounds/<taskId>.json（新目录，不碰 tasks/*.json
// 的业务档案）。此前全链路没有任何分数数据源——GPT 评审分数只活在聊天里，
// 工作台只能「还没打分」。这个端点把「目标分数 / 本轮得分 / 第 N 轮改进中」
// 变成有账可查的真实数据。写入原子（tmp + rename），响应 = 磁盘读回值。
// 返工上限与暂停条件在服务端定死并随 GET 下发，前端不许自创：
//   maxRounds=5（同一任务最多记 5 轮评审）；
//   stopIfNoProgressRounds=2（连续 2 轮得分不涨就建议暂停，转人工）。

const REVIEW_LIMITS = { maxRounds: 5, stopIfNoProgressRounds: 2 };

function reviewFileOf(AUTOLOOP_HOME, taskId) {
  return join(AUTOLOOP_HOME, 'office-data', 'review-rounds', `${taskId}.json`);
}

function readReviewStore(AUTOLOOP_HOME, taskId) {
  try {
    const raw = JSON.parse(readFileSync(reviewFileOf(AUTOLOOP_HOME, taskId), 'utf8'));
    if (!raw || Array.isArray(raw) || typeof raw !== 'object') return null;
    return { taskId: raw.taskId || taskId, targetScore: raw.targetScore ?? null, rounds: Array.isArray(raw.rounds) ? raw.rounds : [] };
  } catch {
    return null;
  }
}

/** 派生建议：none 没轮次 / pass 已达标 / rework 继续改进 / pause-* 建议停转人工 */
function reviewAdvice(store) {
  const rounds = store ? store.rounds : [];
  if (!rounds.length) return 'none';
  const last = rounds[rounds.length - 1];
  if (last.outcome === 'pass') return 'pass';
  if (rounds.length >= REVIEW_LIMITS.maxRounds) return 'pause-max-rounds';
  // 连续多少轮（从最后一轮往前数）得分没有比上一轮高
  let noProgress = 0;
  for (let i = rounds.length - 1; i >= 1; i -= 1) {
    if (Number(rounds[i].score) <= Number(rounds[i - 1].score)) noProgress += 1;
    else break;
  }
  if (noProgress >= REVIEW_LIMITS.stopIfNoProgressRounds) return 'pause-no-progress';
  return 'rework';
}

// GET /api/office/review?taskId=X —— 轮次历史 + 目标分 + 上限 + 派生建议
function makeReviewGetRoute(deps) {
  const { PORT, AUTOLOOP_HOME, httpError, sendJson } = deps;
  return async (req, res) => {
    const q = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const taskId = String(q.searchParams.get('taskId') || '').trim();
    if (!/^[A-Za-z0-9_-]+$/.test(taskId)) throw httpError(400, 'BAD_TASK_ID', 'taskId 只能是字母数字_-');
    const store = readReviewStore(AUTOLOOP_HOME, taskId);
    sendJson(res, 200, {
      generatedAt: new Date().toISOString(),
      taskId,
      targetScore: store ? store.targetScore : null,
      rounds: store ? store.rounds : [],
      limits: REVIEW_LIMITS,
      advice: reviewAdvice(store),
      // 账本还没建 ≠ 出错——新任务没打过分是常态，前端按「还没打分」展示
      exists: store !== null,
    });
    return;
  };
}

// POST /api/office/review —— 两种模式：
//   记一轮：{ taskId, score, basis, reviewedVersion?, issues?, instruction?, result?, targetScore? }
//   补记执行结果：{ taskId, roundNo, result }
// score 达到 targetScore（取本次传入或账本既有，缺省 8.0）记 outcome=pass，否则 rework。
function makeReviewPostRoute(deps) {
  const { AUTOLOOP_HOME, httpError, sendJson, readJsonBody, taskFileOf } = deps;
  return async (req, res) => {
    const body = await readJsonBody(req);
    const taskId = String(body.taskId || '');
    if (!/^[A-Za-z0-9_-]+$/.test(taskId)) throw httpError(400, 'BAD_TASK_ID', 'taskId 只能是字母数字_-');
    // 任务档案必须真实存在——不允许给空气记评审分
    try { statSync(taskFileOf(taskId)); }
    catch { throw httpError(404, 'TASK_NOT_FOUND', `任务档案不存在：${taskId}`); }

    const clampText = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    const store = readReviewStore(AUTOLOOP_HOME, taskId) || { taskId, targetScore: null, rounds: [] };
    const lockKey = `review/${taskId}`;
    if (!lockDecision(lockKey)) throw httpError(409, 'WRITE_IN_FLIGHT', '这个任务的评审账本正有写入在途，稍等再操作');

    try {
      if (body.roundNo !== undefined) {
        // ---- 补记模式：把「Claude 的执行结果」写进已存在的某一轮 ----
        const no = Number(body.roundNo);
        const result = clampText(body.result, 2000);
        if (!Number.isInteger(no) || no < 1) throw httpError(400, 'BAD_ROUND_NO', 'roundNo 必须是正整数');
        if (result === '') throw httpError(400, 'RESULT_REQUIRED', 'result 必须是非空字符串（≤2000 字）');
        const round = store.rounds.find((r) => r.no === no);
        if (!round) throw httpError(404, 'ROUND_NOT_FOUND', `第 ${no} 轮不存在（这个任务目前有 ${store.rounds.length} 轮）`);
        round.result = result;
        round.resultAt = new Date().toISOString();
      } else {
        // ---- 记一轮模式 ----
        const score = Number(body.score);
        const basis = clampText(body.basis, 2000);
        if (body.score === undefined || !Number.isFinite(score) || score < 0 || score > 10) {
          throw httpError(400, 'BAD_SCORE', 'score 必须是 0-10 之间的数字');
        }
        if (basis === '') throw httpError(400, 'BASIS_REQUIRED', 'basis（得分依据）必填，≤2000 字');
        if (store.rounds.length >= REVIEW_LIMITS.maxRounds) {
          throw httpError(409, 'MAX_ROUNDS_REACHED', `这个任务已记满 ${REVIEW_LIMITS.maxRounds} 轮评审，不能再自动返工；请人工接手处理`);
        }
        if (body.targetScore !== undefined) {
          const ts = Number(body.targetScore);
          if (!Number.isFinite(ts) || ts < 0 || ts > 10) throw httpError(400, 'BAD_TARGET_SCORE', 'targetScore 必须是 0-10 之间的数字');
          store.targetScore = ts;
        }
        const target = store.targetScore ?? 8.0;
        const prev = store.rounds[store.rounds.length - 1] || null;
        const no = prev ? prev.no + 1 : 1;
        store.rounds.push({
          no,
          at: new Date().toISOString(),
          reviewer: 'Leo（工作台）',
          reviewedVersion: clampText(body.reviewedVersion, 200),
          score: Math.round(score * 10) / 10,
          targetScore: target,
          basis,
          issues: clampText(body.issues, 2000),
          instruction: clampText(body.instruction, 2000),
          result: clampText(body.result, 2000),
          resultAt: null,
          outcome: score >= target ? 'pass' : 'rework',
        });
      }

      // 原子写：同目录 tmp → rename 顶替；写完重读磁盘作为响应（不拿发出当写成了）
      const file = reviewFileOf(AUTOLOOP_HOME, taskId);
      mkdirSync(join(AUTOLOOP_HOME, 'office-data', 'review-rounds'), { recursive: true });
      const tmp = join(join(AUTOLOOP_HOME, 'office-data', 'review-rounds'), `.${taskId}.tmp-${Date.now()}.json`);
      writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
      renameSync(tmp, file);
      const readBack = readReviewStore(AUTOLOOP_HOME, taskId);
      if (!readBack) throw httpError(500, 'REVIEW_WRITE_FAILED', '写回了但读不回来——账本状态未知，请刷新后核对');
      sendJson(res, 200, {
        ok: true, taskId,
        targetScore: readBack.targetScore,
        rounds: readBack.rounds,
        limits: REVIEW_LIMITS,
        advice: reviewAdvice(readBack),
        readBack: true,
      });
      return;
    } finally {
      unlockDecision(lockKey);
    }
  };
}

// ---- X07（TASK-向导化改造）：从首页开一个新软件制作 ------------------------
// POST /api/office/new-task { idea, title? }
// 真实创建：子进程 flow.mjs init（建 7 步骨架）+ flow.mjs set req done
// （idea 作为「原始需求」原话存档，by=Leo（工作台·新需求））。响应是写后
// 从磁盘读回的档案摘要——不拿「命令发出去了」冒充「建成了」。
// 不改任何既有任务的 ID/文件名/版本；新 ID 形如 T-YYYYMMDD-NN（当天序号）。
function makeNewTaskRoute(deps) {
  const { AUTOLOOP_HOME, httpError, sendJson, readJsonBody } = deps;
  return async (req, res) => {
    const body = await readJsonBody(req);
    const idea = typeof body.idea === 'string' ? body.idea.trim() : '';
    if (idea === '') throw httpError(400, 'IDEA_REQUIRED', 'idea 必填：你想让 AI 帮你做一个什么软件');
    if (idea.length > 2000) throw httpError(400, 'IDEA_TOO_LONG', 'idea 太长了（≤2000 字），拆成几句先聊最要紧的');
    const title = typeof body.title === 'string' && body.title.trim()
      ? body.title.trim().slice(0, 80)
      : idea.slice(0, 30).trim() || '新软件';

    const { execFile } = await import('node:child_process');
    const runFlow = (args) => new Promise((resolve, reject) => {
      execFile(process.execPath, [join(AUTOLOOP_HOME, 'flow.mjs'), ...args],
        { timeout: 15000, maxBuffer: 1024 * 1024 },
        (err, stdout) => { if (err) reject(err); else resolve(stdout); });
    });

    // 新 ID：T-YYYYMMDD-NN，扫当天已有档案取下一个序号；撞满 99 个直接报满
    const dir = join(AUTOLOOP_HOME, 'office-data', 'tasks');
    const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    let taskId = null;
    for (let seq = 1; seq <= 99; seq += 1) {
      const cand = `T-${ymd}-${String(seq).padStart(2, '0')}`;
      if (!existsSync(join(dir, `${cand}.json`))) { taskId = cand; break; }
    }
    if (!taskId) throw httpError(409, 'DAILY_LIMIT', `今天已经建了 99 个任务（T-${ymd}-01…99），明天再来或手工建档案`);

    const lockKey = `${taskId}/req`;
    if (!lockDecision(lockKey)) throw httpError(409, 'WRITE_IN_FLIGHT', '正有人在写这个新任务，稍等再试');
    try {
      await runFlow(['init', taskId, title]);
      await runFlow(['set', taskId, 'req', '--status', 'done', '--note', idea, '--by', 'Leo（工作台·新需求）']);
      // 读回核验：档案存在、id/title/req 状态全部对上才算建成
      let rec;
      try { rec = JSON.parse(readFileSync(join(dir, `${taskId}.json`), 'utf8')); }
      catch { throw httpError(500, 'NEW_TASK_UNCONFIRMED', `flow.mjs 执行完但读不回档案 ${taskId}.json——任务可能没建成，请刷新列表核对`); }
      const reqStep = (rec.steps && rec.steps.req) || {};
      if (rec.id !== taskId || reqStep.status !== 'done' || (reqStep.note || '') !== idea) {
        throw httpError(500, 'NEW_TASK_MISMATCH', '读回的档案与写入意图不一致，任务状态未知，请刷新核对');
      }
      // TASK-R87整改 X01：删掉「确认想法」审批。req 落档后立即把 doc 推成 running
      // ——AI 自动开始讨论，不再问用户要不要；讨论留档同步起头（phase=discussing），
      // 之后由 kickoffAutoAdvance 真跑两轮讨论 → 生成文档 → doc=awaiting 停在唯一确认点。
      await runFlow(['set', taskId, 'doc', '--status', 'running', '--note', 'AI 已自动开始讨论需求', '--by', '苏打工作台·自动推进']);
      const rec2 = JSON.parse(readFileSync(join(dir, `${taskId}.json`), 'utf8'));
      const docStep = (rec2.steps && rec2.steps.doc) || {};
      if (docStep.status !== 'running') {
        throw httpError(500, 'NEW_TASK_MISMATCH', 'doc 步骤没有进入 running，自动推进没启动，请刷新核对');
      }
      // 讨论留档同步起头：紧接着 GET /api/office/discuss 一定读得到（不靠后台时序）
      startDiscussRecord({ AUTOLOOP_HOME, taskId, title });
      sendJson(res, 200, {
        ok: true, taskId, title,
        createdAt: rec.createdAt || null,
        readBack: {
          id: rec.id, title: rec.title, updatedAt: rec.updatedAt || null,
          req: { status: reqStep.status, note: reqStep.note || '', by: reqStep.by || null },
          doc: { status: docStep.status, note: docStep.note || '', by: docStep.by || null },
        },
        verified: true,
      });
      // 响应发完再后台推进（25 分钟一轮的讨论不能挂在 HTTP 请求上）；失败会如实
      // 落在讨论留档（phase=error + 真实原因），页面据此说「停住了」，不冒充进行中。
      kickoffAutoAdvance({ AUTOLOOP_HOME, taskId, title, idea }).catch(() => {});
      return;
    } finally {
      unlockDecision(lockKey);
    }
  };
}

// ---- TASK-R87整改 X03：需求讨论留档只读视图 -------------------------------
// GET /api/office/discuss?taskId=T-...
// 返回真实讨论留档（phase/messages/error 全部来自 server-auto.mjs 落档的原文）。
// 拿不到就是 exists:false —— 前端据此显示「暂时无法获取讨论记录」，绝不伪造。
function makeDiscussRoute(deps) {
  const { AUTOLOOP_HOME, httpError, sendJson } = deps;
  return async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const taskId = (u.searchParams.get('taskId') || '').trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(taskId)) {
      throw httpError(400, 'BAD_TASK_ID', 'taskId 必填（字母数字_-，≤64 字符）');
    }
    sendJson(res, 200, { ok: true, taskId, ...discussView(AUTOLOOP_HOME, taskId) });
    return;
  };
}

// /api/cards/:id/answer
function makeCardsAnswerRoute(deps) {
  const { sendJson, readJsonBody, handleAnswer } = deps;
  return async (req, res, id) => {
    sendJson(res, 200, await handleAnswer(id, await readJsonBody(req)));
    return;
  };
}

// /api/cards/:id/resolve
function makeCardsResolveRoute(deps) {
  const { sendJson, readJsonBody, handleResolve } = deps;
  return async (req, res, id) => {
    sendJson(res, 200, await handleResolve(id, await readJsonBody(req)));
    return;
  };
}

// /api/runs/:id/cancel
function makeRunsCancelRoute(deps) {
  const { sendJson, handleCancel } = deps;
  return async (req, res, id) => {
    sendJson(res, 200, await handleCancel(id));
    return;
  };
}

export function createApiRouter(deps) {
  // 决策核心六件套实例化一次，全部处理器共享——与拆分前 server.js 单实例行为等价。
  const core = createDecisionCore({
    AUTOLOOP_HOME: deps.AUTOLOOP_HOME, httpError: deps.httpError, sendJson: deps.sendJson,
  });
  const ctx = { ...deps, ...core };
  const health = makeHealthRoute(ctx);
  const state = makeStateRoute(ctx);
  const hermes = makeHermesRoute(ctx);
  const agentsReal = makeAgentsRealRoute(ctx);
  const files = makeFilesRoute(ctx);
  const skills = makeSkillsRoute(ctx);
  const flow = makeFlowRoute(ctx);
  const file = makeFileRoute(ctx);
  const fileVersion = makeFileVersionRoute(ctx);
  const fileCheck = makeFileCheckRoute(ctx);
  const versionGate = makeVersionGateRoute(ctx);
  const fileRevalidate = makeFileRevalidateRoute(ctx);
  const decisions = makeDecisionsRoute(ctx);
  const opStatus = makeOpStatusRoute(ctx);
  const decide = makeDecideRoute(ctx);
  const resubmit = makeResubmitRoute(ctx);
  const decision = makeDecisionRoute(ctx);
  const fileDownload = makeFileDownloadRoute(ctx);
  // TASK-向导化改造（X06/X07）：评审轮次账本 + 首页开新软件制作
  const reviewGet = makeReviewGetRoute(ctx);
  const reviewPost = makeReviewPostRoute(ctx);
  const newTask = makeNewTaskRoute(ctx);
  const discuss = makeDiscussRoute(ctx);
  const cardsAnswer = makeCardsAnswerRoute(ctx);
  const cardsResolve = makeCardsResolveRoute(ctx);
  const runsCancel = makeRunsCancelRoute(ctx);

  // 派发层：只做路径/方法匹配与兜底，路由体在各 maker 内（R75 G02 拆分）。
  return async function api(req, res, path, method) {
    // P0 地基层：先交给任务 API 匹配；不是它的路径再走原有路由。
    // 任务 API 自己负责 405，未匹配返回 false，原路由行为不变。
    if (path === '/api/tasks' || path.startsWith('/api/tasks/') || path === '/api/agents/status-v2') {
      const handled = await handleTasksApi(req, res, path, method, ctx);
      if (handled) return;
    }

    if (path === '/api/health' && method === 'GET') return health(req, res);
    if (path === '/api/state' && method === 'GET') return state(req, res);
    if (path === '/api/office/hermes' && method === 'GET') return hermes(req, res);
    if (path === '/api/agents/real' && method === 'GET') return agentsReal(req, res);
    if (path === '/api/office/files' && method === 'GET') return files(req, res);
    if (path === '/api/office/skills' && method === 'GET') return skills(req, res);
    if (path === '/api/office/flow' && method === 'GET') return flow(req, res);
    if (path === '/api/office/file' && method === 'GET') return file(req, res);
    if (path === '/api/office/file-version' && method === 'GET') return fileVersion(req, res);
    if (path === '/api/office/file-check' && method === 'POST') return fileCheck(req, res);
    if (path === '/api/office/version-gate' && method === 'POST') return versionGate(req, res);
    if (path === '/api/office/file-revalidate' && method === 'POST') return fileRevalidate(req, res);
    if (path === '/api/office/decisions' && method === 'GET') return decisions(req, res);
    if (path === '/api/office/op-status' && method === 'GET') return opStatus(req, res);
    if (path === '/api/office/decide' && method === 'POST') return decide(req, res);
    if (path === '/api/office/resubmit' && method === 'POST') return resubmit(req, res);
    if (path === '/api/office/decision' && method === 'POST') return decision(req, res);
    if (path === '/api/office/file-download' && method === 'GET') return fileDownload(req, res);
    if (path === '/api/office/review' && method === 'GET') return reviewGet(req, res);
    if (path === '/api/office/review' && method === 'POST') return reviewPost(req, res);
    if (path === '/api/office/new-task' && method === 'POST') return newTask(req, res);
    if (path === '/api/office/discuss' && method === 'GET') return discuss(req, res);

    let m;
    if ((m = path.match(/^\/api\/cards\/(\d+)\/answer$/)) && method === 'POST') return cardsAnswer(req, res, m[1]);
    if ((m = path.match(/^\/api\/cards\/(\d+)\/resolve$/)) && method === 'POST') return cardsResolve(req, res, m[1]);
    if ((m = path.match(/^\/api\/runs\/(\d+)\/cancel$/)) && method === 'POST') return runsCancel(req, res, m[1]);

    // 已知端点但方法不对 → 405；其余（含路径穿越、怪 id、未列出的中台端点）一律 404。
    // 白名单之外不代理任何东西——前端无法借道本服务访问中台其它接口。
    const known = [
      [/^\/api\/state$/, ['GET']],
      [/^\/api\/health$/, ['GET']],
      [/^\/api\/agents\/real$/, ['GET']],
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
      [/^\/api\/office\/review$/, ['GET', 'POST']],
      [/^\/api\/office\/new-task$/, ['POST']],
      [/^\/api\/office\/discuss$/, ['GET']],
    ];
    if (known.some(([re, methods]) => re.test(path) && !methods.includes(method))) {
      throw httpErrorFallback(deps, 405, 'METHOD_NOT_ALLOWED', `${method} ${path} 不支持`);
    }
    throw httpErrorFallback(deps, 404, 'NOT_FOUND', `${method} ${path} 不存在（本服务只开放 /api/state、/api/health、/api/agents/real、/api/cards/:id/answer、/api/cards/:id/resolve、/api/runs/:id/cancel、/api/office/decisions、/api/office/decide、/api/office/decision、/api/office/resubmit、/api/office/op-status、/api/office/file-download、/api/office/file-revalidate、/api/office/review、/api/office/new-task、/api/office/discuss）`);
  };
}

// 兜底抛错走注入的 httpError（派发层不重复解构，保持薄）。
function httpErrorFallback(deps, status, code, message) {
  return deps.httpError(status, code, message);
}
