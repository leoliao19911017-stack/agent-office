'use strict';

/* ================= decision-ops.js — 决策操作（G02 拆分自 app.js 决策态 + approval.js 决策执行段） =================
   集中持有：decisionBusy/decisionResult/pendingOps/decisionNotes 状态、本地兜底口径 localDecisions、
   提交 submitDecision / 回查 reconcilePendingDecision / 结果落定 applyDecisionOutcome / 操作历史 renderOpHistory。
   app.js boot 段统一调 initDecisionOps() 自恢复；渲染主干（renderAll 等）仍在 app.js，跨文件引用均为调用期解析。 */

let decisionBusy = false;  // 决策请求在途，防双击
let decisionResult = null; // { key: taskId+'/'+stepKey, ok|pending, msg } 处理结果反馈
// TASK-R5（评审 #2/#3）：写回操作标识集合。之前只有单个 decisionOp——在 A 步骤
// 提交超时后切到 B 步骤再提交会覆盖 A 的记录，A 的回查就此丢失，导航期间
// 超时决策的生命周期被页面切换破坏。现在按「taskId/stepKey」存 Map：
// 多个步骤的待确认操作各自独立；导航不动这个集合（TASK-R6 起反馈/草稿也按
// key 留存），回查由专属心跳驱动、与当前看哪一步无关。
// 单个 op：{ id, key, taskId, stepKey, action, targetStatus, at }
const pendingOps = new Map();
// TASK-R6（评审 #4）：反馈与草稿不再是一次性全局变量——按步骤 key 存最近反馈
// （10 分钟内有效），切走再切回来、刷新恢复后都还能看到；备注草稿同理留存，
// 不再「切一步丢一段」。decideHtml 只认自己 key 的记录，天然不串台。
const decisionResults = new Map();   // key -> { ...result, shownAt }
const decisionNotes = new Map();     // key -> 备注草稿（≤500 字）
// TASK-R7（评审 #6）：草稿此前只在内存 Map——切步骤不丢（TASK-R6 修过），但刷新
// 整页就没了。现在同步落 localStorage（office.notes.v1）：输入即存档、确定成功
// 即清除、启动时恢复；面板恢复草稿时计数旁标注「草稿已留存」，看得见存档生效。
const NOTES_KEY = 'office.notes.v1';
function persistNotes() {
  if (offline) return;
  try { localStorage.setItem(NOTES_KEY, JSON.stringify([...decisionNotes])); } catch { /* 隐私模式 */ }
}
function restoreNotes() {
  try {
    const arr = JSON.parse(localStorage.getItem(NOTES_KEY) || '[]');
    for (const [k, v] of Array.isArray(arr) ? arr : []) {
      if (typeof k === 'string' && typeof v === 'string' && v) decisionNotes.set(k, v.slice(0, 500));
    }
  } catch { /* 坏档当没有 */ }
}
/** 草稿输入回调（模板内联 oninput 用）：存 Map + 落盘 + 更新字数计数 */
function saveNoteDraft(key, value, cntId) {
  if (value) decisionNotes.set(key, String(value).slice(0, 500));
  else decisionNotes.delete(key);   // 清空输入 = 删除草稿，不留空串脏档
  persistNotes();
  const el = document.getElementById(cntId);
  if (el) el.textContent = (value ? value.length : 0) + '/500';
}
function setDecisionResult(r) {
  decisionResult = r;
  if (r && r.key) decisionResults.set(r.key, { ...r, shownAt: Date.now() });
}
function decisionResultFor(key) {
  const e = decisionResults.get(key);
  if (!e || Date.now() - e.shownAt > 10 * 60 * 1000) return null;
  return e;
}
// TASK-R6（评审 #4）：待确认操作与历史结果落 localStorage。此前 pendingOps 只在
// 内存——刷新/误关页面后集合清空，在途写回的操作 ID 丢失，只能靠用户自己想起来
// 核对。现在刷新后恢复集合并继续回查；操作结果留最近 30 条（设置弹层可回看）。
const PENDING_OPS_KEY = 'office.pendingOps.v1';
const OP_RESULTS_KEY = 'office.opResults.v1';
const OP_RESULTS_MAX = 30;
let opResults = [];
function persistPendingOps() {
  if (offline) return;
  try { localStorage.setItem(PENDING_OPS_KEY, JSON.stringify([...pendingOps.values()])); } catch { /* 隐私模式 */ }
}
function restorePendingOps() {
  try {
    const arr = JSON.parse(localStorage.getItem(PENDING_OPS_KEY) || '[]');
    for (const op of Array.isArray(arr) ? arr : []) {
      if (op && typeof op.key === 'string' && typeof op.id === 'string'
        && typeof op.taskId === 'string' && typeof op.stepKey === 'string' && typeof op.action === 'string') {
        if (typeof op.at !== 'number' || !Number.isFinite(op.at)) op.at = Date.now();   // 坏档兜底：重新计时
        pendingOps.set(op.key, op);
      }
    }
  } catch { /* 坏档当没有 */ }
}
function pushOpResult(r) {
  if (!r || !r.key) return;
  opResults.unshift({ ...r, settledAt: Date.now() });
  if (opResults.length > OP_RESULTS_MAX) opResults.length = OP_RESULTS_MAX;
  if (offline) return;
  try { localStorage.setItem(OP_RESULTS_KEY, JSON.stringify(opResults)); } catch { /* 隐私模式 */ }
  renderOpHistory();   // 回查循环落定时轮询可能在暂停，主动刷一次记录区
}
function restoreOpResults() {
  try {
    const arr = JSON.parse(localStorage.getItem(OP_RESULTS_KEY) || '[]');
    opResults = Array.isArray(arr) ? arr.filter((r) => r && r.key).slice(0, OP_RESULTS_MAX) : [];
  } catch { opResults = []; }
}

/* ---- 最近操作记录（TASK-R6 评审 #4）：设置弹层里可回看最近落定的提交 ---- */
const ACTION_CN = { approve: '通过', reject: '打回', resubmit: '重提' };
function renderOpHistory() {
  const box = document.getElementById('sp-ops');
  if (!box) return;
  if (!opResults.length) {
    box.innerHTML = '<div class="sp-ops-empty">还没有操作记录</div>';
    return;
  }
  box.innerHTML = opResults.map((r) => {
    const tk = ((lastFlow && lastFlow.tasks) || []).find((x) => x.id === r.taskId);
    const st = tk && (tk.steps || []).find((x) => x.key === r.stepKey);
    const where = tk && st ? `${tk.title} · ${st.name}` : `${r.taskId} · ${r.stepKey}`;
    let cls = 'is-fail', verdict = '✗ 结果未确认';
    if (r.ok && r.unconfirmed) { cls = 'is-warn'; verdict = '⚠ 档案已变更，归属未确认'; }
    else if (r.ok) { cls = 'is-ok'; verdict = '✓ 已确认'; }
    else if (r.msg) { verdict = '✗ ' + String(r.msg).slice(0, 60); }
    return `<div class="sp-op ${cls}">
      <div class="sp-op-line"><span class="sp-op-act">${ACTION_CN[r.action] || esc(r.action || '—')}</span><span class="sp-op-where">${esc(where)}</span><span class="sp-op-at">${esc(fmtTime(new Date(r.settledAt).toISOString()))}</span></div>
      <div class="sp-op-verdict">${esc(verdict)}</div>
    </div>`;
  }).join('');
}

// 决策弹层的兜底数据源：离线或 /decisions 没返回时，用本地 flow 数据算同一套口径
function localDecisions() {
  const items = [], blocked = [], rejected = [];
  for (const t of (lastFlow && lastFlow.tasks) || []) {
    const steps = (t.steps || []).slice().sort((a, b) => (a.no ?? 0) - (b.no ?? 0));
    steps.forEach((s, i) => {
      // TASK-R3：被打回的步骤单列一组（rejected），和「可拍板」区分开——
      // 它要的是重提，不是拍板。
      if (s.status === 'failed') {
        rejected.push({ taskId: t.id, taskTitle: t.title, stepKey: s.key, stepNo: s.no, stepName: s.name, gate: !!s.gate, note: s.note || '' });
        return;
      }
      if (!(s.status === 'awaiting' || (s.gate === true && s.status === 'pending'))) return;
      if (isDecidable(s, steps)) {
        items.push({ taskId: t.id, taskTitle: t.title, stepKey: s.key, stepNo: s.no, stepName: s.name, gate: !!s.gate, kind: s.gate ? 'gate' : 'confirm' });
      } else {
        blocked.push({
          taskId: t.id, taskTitle: t.title, stepKey: s.key, stepName: s.name,
          waitingOn: steps.slice(0, i).filter(p => p.status !== 'done').map(p => `${String(p.no ?? '').padStart(2, '0')} ${p.name}`),
        });
      }
    });
  }
  return { items, blocked, rejected };
}

function renderDecisionPop() {
  const pop = document.getElementById('decision-pop');
  let src = (decisionsData && Array.isArray(decisionsData.items))
    ? decisionsData
    : localDecisions();
  // R86·X02：测试任务的审批不进这个弹层——弹层按钮落在首页（data-goto-home），
  // 而首页固定隐藏测试任务；测试审批在高级工作台处理。decision-ops.js 先于
  // cabin.js 加载，isTestTask 同样走 typeof 守卫（g02 VM 单测时不过滤），
  // 且只复制不改写全局 decisionsData。
  const notTest = (d) => !(typeof isTestTask === 'function' && isTestTask({ id: d.taskId, title: d.taskTitle }));
  if (Array.isArray(src.items)) {
    src = { ...src,
      items: src.items.filter(notTest),
      rejected: (src.rejected || []).filter(notTest),
      blocked: (src.blocked || []).filter(notTest) };
  }
  const generated = (decisionsData && decisionsData.generatedAt)
    ? ` · 数据 ${esc(fmtTime(decisionsData.generatedAt))}` : '';

  // R85·X04：每行都是可办的事——软件名称｜确认内容｜已等待时间｜查看并确认。
  // data-goto-home 落在「我的任务」页（新手不进专业工作台）；等待时长读步骤真实时间戳。
  // 模块契约：decision-ops.js 在 index.html 里先于 cabin.js 加载，不得硬引用其符号——
  // plainTitle/STEP_HUMAN 用 typeof 守卫，浏览器全量加载时取真值，g02 VM 单测时降级。
  const waitAgoOf = (d) => {
    const tk = ((lastFlow && lastFlow.tasks) || []).find((x) => x.id === d.taskId);
    const stp = tk && (tk.steps || []).find((x) => x.key === d.stepKey);
    return stp && stp.at ? ago(stp.at) : '';   // ago 自带相对口径（「3 天前」），不再叠「已等待」
  };
  const nameOf = (d) => {
    const tk = ((lastFlow && lastFlow.tasks) || []).find((x) => x.id === d.taskId);
    if (!tk) return String(d.taskTitle || d.taskId);
    return typeof plainTitle === 'function' ? plainTitle(tk) : String(tk.title || tk.id);
  };
  const stepNameOf = (d) =>
    (typeof STEP_HUMAN !== 'undefined' && STEP_HUMAN[d.stepKey]) || d.stepName || '';
  let html = '';
  if (src.items.length) {
    html += src.items.map(d => {
      const wait = waitAgoOf(d);
      return `
      <button class="dp-item" type="button" data-goto-home="${esc(d.taskId)}|${esc(d.stepKey)}">
        <span class="d-line"><b>${esc(nameOf(d))}</b><span class="dp-kind ${d.kind === 'gate' ? 'is-gate' : ''}">${d.kind === 'gate' ? '门禁' : '等你确认'}</span></span>
        <span class="d-task">${esc(stepNameOf(d))}${wait ? ' · ' + esc(wait) : ''}</span>
        <span class="dp-go">查看并确认 ›</span>
      </button>`;
    }).join('');
  }
  // TASK-R3：已打回的步骤在弹层里也要能一眼看到、一键直达（同一个 data-goto-home 路径）
  const rej = src.rejected || [];
  if (rej.length) {
    html += rej.map(d => {
      const wait = waitAgoOf(d);
      return `
      <button class="dp-item dp-rejected" type="button" data-goto-home="${esc(d.taskId)}|${esc(d.stepKey)}" title="${esc(d.note || '未登记打回理由')}">
        <span class="d-line"><b>${esc(nameOf(d))}</b><span class="dp-kind is-rejected">已打回</span></span>
        <span class="d-task">${esc(stepNameOf(d))}${wait ? ' · ' + esc(wait) : ''}${d.note ? ' · ' + esc(String(d.note).slice(0, 40)) : ''}</span>
        <span class="dp-go">去处理 ›</span>
      </button>`;
    }).join('');
  }
  if (src.blocked.length) {
    html += src.blocked.map(d => `
      <div class="dp-blocked" title="前序没走完，暂不能拍板">
        <span class="d-line"><b>${esc(d.stepName)}</b><span class="dp-kind">未到</span></span>
        <span class="d-task">${esc(d.taskTitle || d.taskId)} · 等：${(d.waitingOn || []).map(esc).join('、')}</span>
      </div>`).join('');
  }
  if (!html) html = '<div class="dp-none">当前没有可处理的决策</div>';
  const rejCnt = rej.length ? ` · 打回 ${rej.length}` : '';
  pop.innerHTML = `<div class="dp-head">待决策 · ${src.items.length} 项${rejCnt}${generated}</div>${html}`;
}

// 决策写回响应的四分支收尾（verified / readBack / unconfirmed / 确定不一致）。
// G02 从 submitDecision 原样拆出（口径与注释零改动，仅整体减一层缩进），
// 只接响应 r 与提交时刻的 key / op / action，不读 post-await 的 ui.*。
function applyDecisionOutcome(r, key, op, action) {
  // TASK-R6（评审 #5）口径保留：verified=true 确定成功；readBack=false 是
  // 「已写入但服务端读回未确认」，不算失败，保留操作记录交给回查循环比对
  // 最新档案；verified=false 才是「写回状态对不上」的确定问题。
  // 新端点同步写 + 写后读回，verified 即结论；step/demand 是写后真实状态。
  if (r.verified === true) {
    const after = r.step || r.after || {};
    const result = { key, ok: true, action, at: after.at, note: after.note };
    setDecisionResult(result);
    decisionNotes.delete(key);   // 确定成功才清草稿
    persistNotes();              // TASK-R7（评审 #6）：草稿清除同步落盘，刷新后不再复活
    pendingOps.delete(key);      // 确定结论（含幂等重放）：释放占用
    persistPendingOps();
    // TASK-11.1：新端点带回写后整份真实档案，直接并入本地快照——不等下一拍
    // 轮询，中央交付链立即反映写后状态（轮询随后还会核对一次）。
    if (r.demand && lastFlow && Array.isArray(lastFlow.tasks)) {
      const i = lastFlow.tasks.findIndex((x) => x.id === r.demand.id);
      if (i >= 0) lastFlow.tasks[i] = r.demand; else lastFlow.tasks.push(r.demand);
    }
    // TASK-R7（评审 #3）：操作记录用 op 自带的任务/步骤快照（提交那一刻的值），
    // 不读 post-await 的 ui.*——等待期间用户切步骤会让记录飘到别步去。
    pushOpResult({ ...result, taskId: op.taskId, stepKey: op.stepKey, action, opId: op.id });
  } else if (r.readBack === false) {
    setDecisionResult(null);     // 展示交给待确认条，独立回查循环继续核验
  } else if (r.unconfirmed === true) {
    // TASK-R7（评审 #1）：档案已是目标状态，但写入者不是本次操作——
    // 不冒领成功也不算失败，按「归属未确认」收尾（⚠），把原因说清楚。
    const result = { key, ok: true, unconfirmed: true, action, at: (r.step || r.after || {}).at, msg: r.unverifiedReason || '档案已变更，但无法确认是本次操作的写回' };
    setDecisionResult(result);
    pendingOps.delete(key);
    persistPendingOps();
    pushOpResult({ ...result, taskId: op.taskId, stepKey: op.stepKey, action, opId: op.id });
  } else {
    const msg = r.unverifiedReason || `写回未确认：档案读回状态是「${r.to || (r.after && r.after.status) || '?'}」与目标「${op.targetStatus}」不一致，请刷新核对`;
    setDecisionResult({ key, msg });
    pendingOps.delete(key);
    persistPendingOps();
    pushOpResult({ key, msg, taskId: op.taskId, stepKey: op.stepKey, action, opId: op.id });
  }
}

// 通过/打回/重提：POST /api/office/decide 或 /resubmit → 服务端调 flow.mjs set 写回档案
async function submitDecision(action) {
  const t = currentTask();
  if (!t || !ui.stepKey) return;
  if (offline) { alert('当前是离线快照模式，决策写回需要连上服务'); return; }
  if (decisionBusy) return;
  const key = `${t.id}/${ui.stepKey}`;
  // TASK-R5（评审 #2/#3）：操作标识占用中的步骤拒绝再次提交——
  // 请求超时/断连时服务端可能还在写，重复提交 = 重复执行。
  // 面板上已有待确认条说明原因，这里只重渲染，不再另写一条反馈。
  if (pendingOps.has(key)) { renderInspector(); return; }
  // TASK-R6（评审 #4）：备注草稿按 key 读取（decisionNotes），与输入框同一份
  // TASK-11.1：request（补齐材料）与 reject 一样必须写明缺什么/为什么
  const note = decisionNotes.get(key) || '';
  if ((action === 'reject' || action === 'request') && !note.trim()) {
    setDecisionResult({ key, msg: action === 'reject' ? '打回必须写理由（备注框）' : '补齐材料必须写明缺什么（备注框）' });
    renderInspector();
    return;
  }
  // TASK-R3：超长直接拦下让用户自己精简，不悄悄截断——
  // 「提交成功」和「提交成功但后半段丢了」是两回事。
  if (note.length > 500) {
    setDecisionResult({ key, msg: `备注 ${note.length} 字，超过 500 字上限，请精简后再提交` });
    renderInspector();
    return;
  }
  decisionBusy = true;
  decisionResult = null;
  // TASK-R5（评审 #3）：每次提交生成唯一操作标识，随请求发给服务端。
  // 服务端把最终结果登记在 opLog（内存态）并支持 /op-status 回查 + 同 opId 幂等重放。
  const op = {
    id: 'op-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    key, taskId: t.id, stepKey: ui.stepKey, action,
    targetStatus: action === 'resubmit' ? 'awaiting' : action === 'approve' ? 'done' : action === 'request' ? 'awaiting' : 'failed',
    at: Date.now(),
  };
  pendingOps.set(key, op);   // 入集合即占用该步骤，直至回查落定
  persistPendingOps();       // TASK-R6（评审 #4）：待确认操作落盘，刷新后接续回查
  ensureReconcileLoop();     // TASK-R6（评审 #3）：回查走专属心跳，不依赖页面轮询
  renderInspector();
  try {
    // TASK-11.1（R1）：approve/reject/request 走新决策直写端点——服务端原子写
    // （临时文件+rename）、留事件记录、响应即写后真实状态；resubmit 维持旧端点。
    const isLegacy = action === 'resubmit';
    const url = isLegacy ? '/api/office/resubmit' : '/api/office/decision';
    const payload = isLegacy
      ? { taskId: t.id, step: ui.stepKey, note: note.trim(), opId: op.id }
      : { demandId: t.id, stepKey: ui.stepKey, action, reason: note.trim() };
    const r = await api(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    applyDecisionOutcome(r, key, op, action);   // 四分支收尾（语句原样拆出，见上）
    await tick();             // 立即拉新数据：链路/状态栏同步换
  } catch (e) {
    // TASK-R5（评审 #3）：失败分类，只有「服务端明确拒绝」（HTTP 4xx/5xx 有结论）
    // 才是确定失败、释放占用允许重试。超时 / 网络断连（fetch 抛 TypeError）都
    // 属于结果不确定——请求可能已到服务端并写入，保留操作标识进入回查，
    // 决不能引导用户立刻重试。
    const definite = e && e.isHttpError === true;
    if (definite) {
      pendingOps.delete(key);
      persistPendingOps();
      setDecisionResult({ key, msg: e.message });
      pushOpResult({ key, msg: e.message, taskId: op.taskId, stepKey: op.stepKey, action, opId: op.id });   // TASK-R7（评审 #3）：同上，读 op 快照
      // W01（第 8 轮）：服务端明确拒绝（含 409 版本门禁）后，前端操作状态必须向
      // 同一份服务端判定收敛——强制重拉 version-gate 与实测，绕过 60 秒缓存。
      // 否则「页面打开后文件再变」场景里，旧判定还把主操作亮着，服务端已拒绝，
      // 两端各说各话。只读端点，无副作用；判定落地后自动重渲染右侧与中央。
      scheduleFileCheck(true);
      scheduleVersionGate(true);
    } else {
      setDecisionResult(null);   // 展示交给 pendingOps 的待确认条
      ensureReconcileLoop();     // TASK-R6（评审 #3）：专属回查循环接管，不再靠一次性补拍
    }
  } finally {
    decisionBusy = false;
  }
  renderAll();
}

// TASK-R5（评审 #2/#3）：在途操作回查。遍历 pendingOps 集合，与当前看哪一步无关——
// 导航切走后操作照样落定。每个操作三层判定，按可靠性从高到低：
//   1) 服务端操作登记（/api/office/op-status）：唯一可靠的归属证明。查到即落定。
//   2) 登记查不到：请求可能还在写（没记录 = 没写完），30 秒窗口内继续等。
//   3) 超窗后档案状态比对：状态已变 → 标「归属不确定」的成功（⚠，明说无法确认
//      是本次操作还是其他入口改的）；状态没变 → 明说未能确认，让用户核对后再定。
// 任何一层都不冒充确定成功。
let reconcileInFlight = false;
let reconcileTimer = null;
// TASK-R6（评审 #3）：待确认操作的回查有专属心跳，与页面轮询完全解耦。
// 此前只由 tick() 顺带驱动——用户暂停轮询/切后台时 tick 停转，网络失败分支
// 又只补一次 5 秒后的 tick，那一拍再失败操作就永久卡在「待确认」。
// 现在：集合非空时每 3 秒自查一次，集合清空自动停；页面隐藏时浏览器节流
// 最多拖慢节奏，回到前台立即补拍，不会死锁。
function ensureReconcileLoop() {
  if (offline || reconcileTimer != null) return;
  reconcileTimer = setInterval(() => {
    if (!pendingOps.size) { clearInterval(reconcileTimer); reconcileTimer = null; return; }
    reconcilePendingDecision();
  }, 3000);
}

// 现拉最新档案里某一步的状态；拉不到返回 null（调用方按「不知道」处理，不猜）
async function currentStepStatus(op) {
  try {
    const rf = await api('/api/office/flow');
    if (!rf || !Array.isArray(rf.tasks)) return null;
    const tk = rf.tasks.find((x) => x.id === op.taskId);
    const st = tk && (tk.steps || []).find((x) => x.key === op.stepKey);
    return st ? (st.status || 'pending') : null;
  } catch { return null; }
}

async function reconcilePendingDecision() {
  if (!pendingOps.size || reconcileInFlight || offline) return;
  reconcileInFlight = true;
  try {
    for (const op of [...pendingOps.values()]) {
      let rec = null;
      try {
        const r = await api('/api/office/op-status?opId=' + encodeURIComponent(op.id));
        if (r && r.found && r.op) rec = r.op;
      } catch { /* 查询本身失败（旧服务没这端点/瞬断）不算结论，走下面的兜底 */ }
      if (rec) {
        if (rec.ok === false) {
          settleOp(op, { key: op.key, msg: `写回失败（服务端操作记录）：${rec.msg || 'flow.mjs 写回出错'}` });
        } else if (rec.verified === true) {
          settleOp(op, { key: op.key, ok: true, action: op.action, at: rec.at, note: rec.after && rec.after.note });
        } else if (rec.readBack === false) {
          // TASK-R6（评审 #5）：服务端「已写入但读回未确认」≠ 失败——现拉最新
          // 档案比对，状态已是目标就按状态比对收尾（明说归属靠比对）；还没到
          // 就继续等，只在超窗后才如实报「读回与目标不一致」。
          const cur = await currentStepStatus(op);
          if (cur === null) continue;   // TASK-R7（评审 #2）：档案都读不到就不下「不一致」的结论——没读 ≠ 读了对不上
          if (cur === op.targetStatus) {
            settleOp(op, {
              key: op.key, ok: true, unconfirmed: true, action: op.action, at: new Date().toISOString(),
              msg: '档案已是目标状态；服务端写入时读回未确认，本次结论按最新档案状态比对判定',
            });
          } else if (Date.now() - op.at >= 30000) {
            settleOp(op, { key: op.key, msg: '写回未确认：档案读回状态与目标不一致（服务端操作记录）。请刷新核对' });
          }
        } else if (rec.unconfirmed === true) {
          // TASK-R7（评审 #1）：服务端明确说「档案已变成目标状态，但归属不到本次操作」
          // （写入者是其他入口）。按归属未确认的成功收尾，⚠ 并说明原因。
          settleOp(op, { key: op.key, ok: true, unconfirmed: true, action: op.action, at: rec.after && rec.after.at, msg: rec.unverifiedReason || '档案已变成目标状态，但写入者不是本次操作' });
        } else {
          settleOp(op, { key: op.key, msg: rec.unverifiedReason || '写回未确认：档案读回状态与目标不一致（服务端操作记录）' });
        }
        continue;
      }
      if (Date.now() - op.at < 30000) continue;   // 还在窗口内：下一拍再查
      // TASK-R6（评审 #3）：超窗兜底不再用 lastFlow——那可能是暂停轮询期间的
      // 旧快照。每次现拉最新档案；拉不到（null）不下结论，下一拍再试。
      const cur = await currentStepStatus(op);
      if (cur === null) continue;
      if (cur === op.targetStatus) {
        settleOp(op, {
          key: op.key, ok: true, unconfirmed: true, action: op.action, at: new Date().toISOString(),
          msg: '档案已是目标状态，但服务端操作记录里查不到这次提交（可能服务重启过），无法确认是本次操作还是其他入口改的',
        });
      } else {
        settleOp(op, { key: op.key, msg: '写回结果未能确认（30 秒内无服务端操作记录，档案也未变成目标状态）。请刷新核对后再决定是否重试' });
      }
    }
  } finally {
    reconcileInFlight = false;
  }
}

// 落定：从集合释放占用并同步存档；结果进「最近操作记录」；用户正看着这一步
// 时反馈上屏，不在看也不丢——反馈按 key 存在 decisionResults（10 分钟内有效）。
function settleOp(op, result) {
  pendingOps.delete(op.key);
  persistPendingOps();   // TASK-R6（评审 #4）：落定即从存档移除，刷新后不再重复回查
  // TASK-R7（评审 #6）：确定成功（非归属未确认）才清这一步的备注草稿，同步落盘
  if (result.ok === true && result.unconfirmed !== true) {
    decisionNotes.delete(op.key);
    persistNotes();
  }
  pushOpResult({ ...result, taskId: op.taskId, stepKey: op.stepKey, action: op.action, opId: op.id });
  setDecisionResult(result);   // 无条件进按 key 的反馈存档——落定时没在看这一步，切回来也要能看到
  if (ui.taskId === op.taskId && ui.stepKey === op.stepKey) renderInspector();
  // TASK-R7（评审 #4）：落定即做一次一次性数据同步（链路/决策清单/状态栏）。
  // 回查落定多发生在轮询暂停时（暂停了才更依赖回查），此前页面会一直停在
  // 落定前的旧快照上，直到用户手动刷新。tick() 只拉一次数据并渲染，
  // 不启停轮询定时器——「暂停轮询」的偏好原样保留。
  tick().catch(() => { /* 单次同步失败不打扰：回查循环下一拍会再对账 */ });
}

// G02：决策操作模块统一入口（app.js boot 段调用）——
// 恢复最近操作结果 / 待确认操作 / 备注草稿；有待确认操作时立即开专属回查循环。
function initDecisionOps() {
  restoreOpResults();
  restorePendingOps();
  restoreNotes();   // TASK-R7（评审 #6）：刷新前留下的备注草稿从存档接回，面板恢复时标注「草稿已留存」
  if (pendingOps.size) ensureReconcileLoop();
}
