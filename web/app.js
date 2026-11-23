
'use strict';

/* ================= 模块地图（G02 拆分后） =================
   index.html 按 shared → version → approval → decision-ops → files → preview →
   agents → cabin → render → app 顺序加载 10 个普通 <script>，全部共享同一全局词法环境
   （file:// 下 ES modules 不可用）；跨文件引用都是调用期解析的全局绑定，
   与拆分前单文件行为一致。加载顺序即依赖边界：只允许后面的引用前面的，
   verify-g02-deps.mjs 按该顺序做静态检查。
     shared.js        工具 / 请求封装 / 语义映射 / withScroll（零业务状态）
     version.js       版本核对缓存 + 登记去重 + 文件实体模型与纯工具
     approval.js      审批规则镜像 + 决策面板视图（decideHtml 及子视图）
     decision-ops.js  决策操作：决策态/待确认/草稿 + submitDecision/回查/操作历史
     files.js         文件视图（renderFiles / 筛选）+ 筛选状态存取收口
     preview.js       文件预览抽屉 M6（openFileView / 历史版本 / 图片预览）
     agents.js        G01 工位卡与 roster（agentStats / renderAgents，只读展示）
     cabin.js         TASK-工作台重做：小白三页（我的任务/干活记录/设置）渲染
     render.js        渲染主干（renderAll 及各区块渲染，只读本文件 M2 状态）
     app.js           入口：状态与轮询（M2）、技能页、事件绑定与 boot
   服务端对应拆分：server.js（HTTP 层）+ server-core.mjs（决策闭环核心）。 */

// 页面 JS 异常计数（验收口径：window.__uiErrors === 0）。
// Task-R2 补上 rejection：fetch 被拒绝不走 error 事件，之前漏计。
window.__uiErrors = 0;
window.addEventListener('error', () => { window.__uiErrors++; });
window.addEventListener('unhandledrejection', () => { window.__uiErrors++; });

/* ================= G04：启动护栏（模块完整性检查 + 失败态挂载） =================
   G02 拆分后 index.html 按 shared → version → approval → decision-ops → files →
   preview → agents → render → app 顺序加载 9 个 <script>。任一拆出模块 404 / 解析失败时，
   app.js 顶层对它的引用会 ReferenceError，
   tick→renderAll 整条启动链断掉，四个页面只剩外壳永久空白（本轮回归根因）。
   这里在一切顶层执行之前点名检查八个拆出模块的入口全局：缺谁立刻把 G04 失败态挂到
   #data-banner（样式见 app-workbench.css 的 #data-banner.boot-fail）并中止本文件，
   不带着半套绑定往下跑。 */
function bootFail(msg) {
  const el = document.getElementById('data-banner');
  if (!el) { console.error('[G04] 启动失败（横幅容器缺失）', msg); return; }
  // shared.js 的 esc 此刻可能恰好缺失：失败态自带迷你转义，不依赖任何拆出模块
  const s = String(msg).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
  el.classList.add('boot-fail');
  // 注意：走到这里时 app.js 的事件委托多半还没注册，重试只能整页刷新（脚本只加载一次）
  el.innerHTML = `<div class="b-row"><b>启动失败</b><span>${s}</span><span class="b-why">页面保持外壳，不用虚构数据冒充；修复后重试。</span></div><button class="btn" type="button" onclick="location.reload()">重试 / 刷新页面</button>`;
  el.hidden = false;
}
{
  const NEED = {
    'shared.js': ['esc', 'api'],
    'version.js': ['scheduleVersionGate'],
    'approval.js': ['decideHtml'],
    'decision-ops.js': ['submitDecision', 'initDecisionOps'],
    'files.js': ['renderFiles', 'getFileFilters', 'setFileFilters', 'clearFileFilters'],
    'preview.js': ['openFileView', 'closeFileView'],
    'agents.js': ['agentStats', 'renderAgents'],
    'cabin.js': ['renderCabin', 'renderLog', 'syncSettingsTabs'],
    'render.js': ['renderAll'],
  };
  const missing = [];
  for (const [file, names] of Object.entries(NEED)) {
    for (const n of names) {
      if (typeof window[n] !== 'function') missing.push(`${file} 缺 ${n}`);
    }
  }
  if (missing.length) {
    bootFail(`前端模块加载不完整：${missing.join('；')}。请确认服务进程为最新代码（静态映射含 9 个拆分脚本）后重试。`);
    throw new Error('[G04] 前端模块加载不完整，app.js 中止执行：' + missing.join('；'));
  }
}

/* ================= R72·G02：样式表完整性检查（CSS 404 不得静默裸奔） =================
   link[rel=stylesheet] 加载失败不抛任何异常、不写 console.error——本轮回归根因正是
   旧进程白名单缺 4 个拆分 CSS，页面全裸却无一丝反馈。核对口径：link 落定后
   加载成功必有 .sheet（CSSOM 入口），失败/404 恒为 null。app.js 在 head 各 link
   之后同步执行，此刻可能仍未落定，故挂 error 监听先行点名 + window load 后
   全量复核一次双保险。失败态用内联样式：CSS 可能恰好全缺，#data-banner 的
   类样式（app-workbench.css）此刻不可依赖——bg #3B3021 / 文字 #E5B95E /
   13px/20px / padding 16px 按规格写死在元素上。 */
let cssFailed = false;   // 粘性：样式表失败后挂住横幅，renderDataBanner 不得用正常数据把它摘掉
function cssFail(hrefs) {
  const el = document.getElementById('data-banner');
  if (!el) { console.error('[G02] 样式表加载失败（横幅容器缺失）', hrefs); return; }
  cssFailed = true;
  const s = String(hrefs.join('、')).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
  el.classList.add('boot-fail');
  el.setAttribute('style', [
    'display:block', 'background:#3B3021', 'color:#E5B95E',
    'font:13px/20px var(--font-body, system-ui, sans-serif)',
    'padding:16px', 'border-bottom:1px solid #E5B95E',
  ].join(';'));
  el.innerHTML = `<div class="b-row"><b>样式表加载失败</b><span>${s}</span>`
    + `<span class="b-why">页面正以无样式降级显示（非正常状态）。常见原因：服务进程为旧代码，静态映射缺拆分 CSS；请重启服务进程后重试。</span></div>`
    + `<button class="btn" type="button" onclick="location.reload()">重试 / 刷新页面</button>`;
  el.hidden = false;
  console.error('[G02] 样式表加载失败：', hrefs);
}
{
  const links = [...document.querySelectorAll('link[rel="stylesheet"]')];
  // 落定后复核。实测口径（E1 调试钉死）：404 的样式表 link.sheet 仍存在且 0 条规则——
  // 不能只看 .sheet 有无，须叠加 cssRules.length===0（同源可读；跨域读取抛异常则不判失败）。
  const isDead = (l) => {
    if (!l.sheet) return true;
    try { return l.sheet.cssRules.length === 0; } catch { return false; }
  };
  const sweep = () => {
    const bad = links.filter(isDead).map((l) => l.getAttribute('href'));
    if (bad.length) cssFail(bad);
  };
  if (document.readyState === 'complete') sweep();
  else window.addEventListener('load', sweep, { once: true });
  // 先行点名：单个 link 的 error 事件（实际常在 app.js 执行前就发完，兜底以 load 复核为准）
  for (const l of links) {
    l.addEventListener('error', () => cssFail([l.getAttribute('href')]));
  }
}

/* G02：M1 工具/请求/语义映射 → shared.js */

/* ================= M2 · state+poll — 数据快照/页面状态/轮询编排/产物核实 ================= */

/* ================= 页面状态（轮询只换数据，不重置这些） ================= */

const POLL_MS = 3000;
const ui = {
  taskId: null,     // 选中的需求
  stepKey: null,    // 选中的步骤（属于 taskId）
  view: 'chain',    // 'chain' 交付链 | 'overview' 全部需求
  search: '',       // 顶栏搜索词，只筛需求列表
};
let lastState = null;      // /api/state 最后一次成功数据
let hermesData = null;     // /api/office/hermes — 三个 Hermes 入口自报状态
let agentsRealData = null; // X03：/api/agents/real — Claude/Codex 本机实测三维（进程/执行/接活）
let lastFlow = null;       // /api/office/flow 最后一次成功数据
let hubOnline = null;      // null 未知 / true / false
let lastSyncAt = null;     // 最后一次成功同步的时间戳
let fileStatus = new Map(); // normPath -> { exists, bytes }（服务端核实）
let fileCheckKey = '';     // 上次核实的路径集合指纹，不变就不重查
let pollTimer = null;

/* TASK-R2 新增状态 */
let decisionsData = null;  // /api/office/decisions：可处理 items + 条件未到 blocked
const modErr = {};         // 模块名 -> 错误文本（state/flow/skills/files/hermes/decisions）
const modOkAt = {};        // 模块名 -> 最后一次成功时间戳，报错时据此标「数据已过期」
let bootWatchdog = null;   // G04：首轮 8s 看门狗句柄（启动段设置，flow 首次成功一拍即撤）
/* G06：初始化四态 + 失败退避。沿用 hubOnline/modErr 既有机制，只在其上区分：
   loading 加载中 → connected 已连接 | conn-fail 连接失败（连不上 /api/health）
   | data-fail 数据获取失败（服务在，但 state/flow 读不回：超时 / 无效 JSON / 5xx） */
let initPhase = 'loading';
let phaseReason = '';      // 异常态一句话原因（底栏 / 顶栏 / 中央共用）
let firstRound = true;     // 首轮请求超时 8000ms（api() 默认 12s 兜底）
let failStreak = 0;        // 连续失败轮数：重试间隔 2s→4s→8s，之后最多每 30s 一次
let polling = false;       // G06：退避轮询链开关（原 pollTimer!=null 的语义显式化）
// G06：错误一句话归类（底栏/中央展示用，不改变错误对象本身）。
// TimeoutError/AbortError=超时；TypeError=fetch 网络层失败；isDataError=无效响应。
function errShort(e) {
  if (!e) return '未知错误';
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return '请求超时';
  if (e instanceof TypeError) return '网络错误';
  const m = String(e.message || e);
  return m.length > 30 ? m.slice(0, 30) + '…' : m;
}
let userPaused = false;    // 用户手动暂停轮询（与页面隐藏暂停相互独立，回前台不覆盖）
let fileCheckedAt = 0;     // 上次核实完成时间，供「核实于 xx」展示与过期判断
let fileCheckErr = null;   // 上次核实失败原因（成功后清空）
/* G02：W02 版本核对缓存 → version.js */
/* G02：决策操作状态与提交/回查/操作历史（decisionBusy / pendingOps / decisionNotes / submitDecision…）→ decision-ops.js；boot 段统一调 initDecisionOps() */
/* G02：预览序列号与中断器（fvSeq / fvAbort）→ preview.js */
let tickInFlight = false;  // TASK-R3：上一轮 tick 还没回来就不发下一轮，防请求摞叠
let tickSeq = 0;           // TASK-R3：轮询序号——只认最新一轮的渲染，晚到的旧响应整包丢弃
let fileStatusVersion = 0; // TASK-R3：核实结果版本号，每核实成功 +1，renderFiles 缓存 key 用
let uiPosReady = false;    // TASK-R3：布局位置数据还没加载/恢复完之前不许 saveUiPos 覆写存档

function currentTask() {
  if (!lastFlow) return null;
  return (lastFlow.tasks || []).find((t) => t.id === ui.taskId) || null;
}

// 数据刷新后校准选中项：没有工作位置（或位置失效）时回答「现在该做什么」
// TASK-R4（评审 #6）：不再固定取 tasks[0]——后端按更新时间排序，最新的一条
// 可能没有任何可处理的事。默认优先落在「有可拍板步骤」的需求上，
// 其次「有待重提」的，最后才是第一条；并直接选中该步骤，Inspector
// 立即给出决策面板，而不是让用户自己在链里找。
// R86·X02：首页不默认选中测试任务——候选池先滤掉 isTestTask（只是展示层过滤，
// 数据不动），没有真实需求时才落回测试任务（首页自己会给空状态，专业视图照常）。
function ensureSelection() {
  const tasks = (lastFlow && lastFlow.tasks) || [];
  if (!tasks.length) { ui.taskId = null; ui.stepKey = null; return; }
  if (!tasks.some((t) => t.id === ui.taskId)) {
    const real = tasks.filter((t) => !isTestTask(t));
    const pool = real.length ? real : tasks;
    const pick = pool.find((t) => (t.steps || []).some((s) => isDecidable(s, t.steps)))
      || pool.find((t) => (t.steps || []).some((s) => s.status === 'failed'))
      || pool[0];
    ui.taskId = pick.id;
    const pickStep = (pick.steps || []).find((s) => isDecidable(s, pick.steps) || s.status === 'failed');
    ui.stepKey = pickStep ? pickStep.key : null;
  }
  const t = currentTask();
  if (t && ui.stepKey != null && !t.steps.some((s) => s.key === ui.stepKey)) {
    ui.stepKey = null;
  }
}

/* ================= 轮询 ================= */

// 模块级读取登记（TASK-R2）：失败不再吞掉——记录错误与最后成功时间，
// 横幅据此展示「哪个模块坏了 / 现有数据多旧」。
function setMod(name, ok, errMsg) {
  if (ok) { delete modErr[name]; modOkAt[name] = Date.now(); }
  else modErr[name] = errMsg || '读取失败';
}

async function tick() {
  // TASK-R3：在途保护——上一轮还没回来（慢/挂死）就直接跳过本轮，
  // 配合 api() 的 12s 超时，最坏情况也只是丢几拍，不会请求摞叠。
  if (tickInFlight) return;
  tickInFlight = true;
  const seq = ++tickSeq;   // 本轮序号；回来时若已有更新的一轮在跑，整包丢弃
  try {
    // G06：首轮初始化请求 8000ms 超时——启动失败尽快见到明确失败态；后续轮询维持 12s 兜底
    const tmo = firstRound ? 8000 : undefined;
    const reqs = [
      api('/api/state', undefined, tmo),
      api('/api/health', undefined, tmo),
      api('/api/office/flow', undefined, tmo),
      api('/api/office/skills', undefined, tmo),
      api('/api/office/hermes', undefined, tmo),
      api('/api/agents/real', undefined, tmo),   // X03：Claude/Codex 本机实测三维
    ];
    if (!offline) reqs.push(api('/api/office/decisions', undefined, tmo));  // 离线快照没收录这份，跳过免噪音
    const rs = await Promise.allSettled(reqs);
    firstRound = false;   // 首轮已出结论，之后的请求回到默认超时
    const [sR, hR, fR, kR, mR, rR, dR] = rs;

    hubOnline = hR.status === 'fulfilled' && hR.value && hR.value.autoloop === true;

    if (sR.status === 'fulfilled') { lastState = sR.value; lastSyncAt = Date.now(); setMod('state', true); }
    else setMod('state', false, sR.reason && sR.reason.message);

    const hermesOk = mR.status === 'fulfilled' && mR.value && !mR.value.error;
    if (hermesOk) { hermesData = mR.value; setMod('hermes', true); }
    else if (mR.status === 'fulfilled') setMod('hermes', false, mR.value.error);   // 接口通了但内部报错
    else setMod('hermes', false, mR.reason && mR.reason.message);

    // X03：/api/agents/real —— 失败时保留上一份好数据（不拿旧值冒充新值，也不清空），
    // agentsRealData 为 null 时 agentStats 对 claude/codex 如实显示「未知」。
    if (rR.status === 'fulfilled' && rR.value && rR.value.agents) {
      agentsRealData = rR.value; setMod('agentsReal', true);
    } else if (rR.status === 'fulfilled') setMod('agentsReal', false, '返回里没有 agents 字段');
    else setMod('agentsReal', false, rR.reason && rR.reason.message);

    if (fR.status === 'fulfilled' && fR.value) {
      lastFlow = fR.value;
      ensureSelection();
      scheduleFileCheck();   // 异步，不挡渲染
      scheduleVersionGate(); // W02：当前步骤的服务端版本判定，异步，不挡渲染
      const ferrs = fR.value.errors || [];
      setMod('flow', ferrs.length === 0,
        ferrs.length ? `${ferrs.length} 个任务档案读取失败（${ferrs.map((e) => e.file).join('、')}），这些需求暂不展示` : undefined);
      if (bootWatchdog) { clearTimeout(bootWatchdog); bootWatchdog = null; }   // G04：首轮 flow 已成功，撤看门狗
      // TASK-R4（评审 #5）：工作位置的恢复/落盘只认「flow 首次成功读取」这一拍。
      // 首轮失败时这里不跑，uiPosReady 保持 false，saveUiPos 不会拿空态覆盖存档。
      completeUiPosRestore();
      // TASK-R5（评审 #2/#3）：在途写回按操作集合回查（服务端操作记录优先，
      // 状态比对兜底），与当前看哪一步无关，fire-and-forget 不挡渲染
      reconcilePendingDecision();
    } else setMod('flow', false, fR.reason && fR.reason.message);

    // TASK-R4（评审 #1）：技能「成功读到空」才算 0；接口通了但 skills.json 读失败
    // 属于读取失败——保留上一份好数据（没有就保持未加载态），不拿 [] 冒充实测空集。
    if (kR.status === 'fulfilled' && kR.value) {
      if (kR.value.readError) {
        setMod('skills', false, kR.value.readError);
      } else {
        skillsData = kR.value.skills || [];   // 成功读取：空数组 = 确实没有，可以显示 0
        setMod('skills', true);
      }
    } else setMod('skills', false, kR.reason && kR.reason.message);

    if (!offline) {
      if (dR.status === 'fulfilled' && dR.value) {
        // TASK-R3：decisions 接口自身通≠没毛病——读档失败会带 errors[]，
        // 和 flow 同样处理：横幅明说哪些档案读不出来，而不是默默当它没决策。
        const derrs = dR.value.errors || [];
        decisionsData = dR.value;
        setMod('decisions', derrs.length === 0,
          derrs.length ? `${derrs.length} 个任务档案读取失败（${derrs.map((e) => e.file).join('、')}），决策列表可能不全` : undefined);
      }
      else setMod('decisions', false, dR.reason && dR.reason.message);
    }

    // 晚到的旧响应不许覆写新状态：序号对不上就整轮丢弃
    if (seq !== tickSeq) return;

    applyInitPhase(sR, hR, fR);   // G06：四态判定（拆出见下方 applyInitPhase，口径不变）

    renderAll();
  } finally {
    tickInFlight = false;
  }
}

/* G06：四态判定（G02 自 tick 拆出，口径不变，变量声明处有完整口径）。
   health 连不上 = 连接失败；服务在但 state/flow 任一读不回 = 数据获取失败；
   都成功 = 已连接。离线快照模式跳过。 */
function applyInitPhase(sR, hR, fR) {
  if (offline) return;
  const prevPhase = initPhase;
  if (hR.status === 'rejected') {
    initPhase = 'conn-fail';
    phaseReason = errShort(hR.reason);
  } else {
    const bad = [sR, fR].find((r) => r.status === 'rejected');
    if (bad) { initPhase = 'data-fail'; phaseReason = errShort(bad.reason); }
    else { initPhase = 'connected'; phaseReason = ''; }
  }
  if (initPhase === 'connected') failStreak = 0;
  else {
    failStreak++;
    // G06 验收口径：控制台要有对应错误信息。每失败轮一条（退避后 30s 一条，不刷屏）
    if (initPhase === 'conn-fail') {
      console.error(`[G06] 连接失败（连续第 ${failStreak} 轮）：/api/health ${phaseReason}` +
        (modErr.state ? `；state: ${modErr.state}` : ''));
    } else {
      const det = ['state', 'flow', 'skills', 'hermes', 'agentsReal', 'decisions']
        .filter((n) => modErr[n]).map((n) => `${n}: ${modErr[n]}`).join('；');
      console.error(`[G06] 数据获取失败（连续第 ${failStreak} 轮）：${det || phaseReason}`);
    }
  }
  if (prevPhase !== 'connected' && initPhase === 'connected' && prevPhase !== 'loading') {
    console.info('[G06] 已重新连接，恢复真实数据');
  }
}

/* G06：失败退避轮询链——替代固定 3s setInterval。连续失败按 2s→4s→8s 重试，
   之后最多每 30s 一次；任一轮成功（health+state+flow 都回来）即清零，恢复 3s 正常轮询。
   由此保证：恢复服务后最长 30s 内必然重新拿到真实数据；断网期间也不会无限空白。 */
const RETRY_STEPS = [2000, 4000, 8000];
function nextDelay() {
  if (failStreak <= 0) return POLL_MS;
  return failStreak <= RETRY_STEPS.length ? RETRY_STEPS[failStreak - 1] : 30000;
}
async function runPollTick() {
  pollTimer = null;
  try { await tick(); } catch { /* tick 渲染链异常不拖垮轮询链；启动段看门狗另有兜底 */ }
  if (polling) pollTimer = setTimeout(runPollTick, nextDelay());
}
function startPolling() {
  if (offline) return;
  if (polling) return;
  polling = true;
  pollTimer = setTimeout(runPollTick, nextDelay());
}
function stopPolling() {
  polling = false;
  if (pollTimer != null) { clearTimeout(pollTimer); pollTimer = null; }
}

/* ================= 产物存在性核实（服务端，只查变化的路径集） ================= */

// TASK-R2：核实结果只保 60 秒——「路径集没变」不代表文件还在；
// 失败时保留上一轮结果（那是真实测过的），只记错误，不冒充空。
async function scheduleFileCheck(force = false) {
  if (offline) return;
  const paths = new Set();
  for (const t of (lastFlow.tasks || [])) {
    for (const s of (t.steps || [])) for (const f of (s.files || [])) {
      const p = String(f.path || '');
      if (p) paths.add(p);
    }
  }
  const arr = [...paths];
  const key = arr.slice().sort().join('\n');
  const fresh = Date.now() - fileCheckedAt < 60 * 1000;
  if (!force && key === fileCheckKey && fresh && !fileCheckErr) return;
  fileCheckKey = key;
  try {
    const d = await api('/api/office/file-check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: arr }),
    });
    fileStatus = new Map((d.results || []).map((r) => [physKey(r.path), r]));   // F02：物理键归一，两种写法同一实体共用同一校验结果
    fileCheckedAt = Date.now();
    fileCheckErr = null;
    fileStatusVersion++;   // TASK-R3：核实结果变了，文件库缓存 key 才会变
  } catch (e) {
    fileCheckErr = e.message || '核实请求失败';   // 旧结果保留可看，但明说没核实成
  }
  withScroll(document.getElementById('insp-body'), renderInspector);   // 红标只影响 Inspector
  // TASK-R3：核实结果刷新只重渲染 Inspector 是漏的——文件库页的红标/字节/哈希
  // 同样吃这份数据，路径集没变它就一直显示旧核实结果。
  // R90：文件页升一级页，直接看 activePage。
  if (activePage === 'files') renderFiles();
}

/* G02：W02 审批版本取数（scheduleVersionGate/dedupFiles）→ version.js */

/* G02：M3 渲染主干（renderAll / renderDataBanner / renderTopbar / renderStatusbar / renderReqList /
   renderCenter / renderInspector / renderDecisionPop…）→ render.js（R73 第 73 轮拆分，加载于本文件之前） */

/* ================= M5 · pos+event — 工作位置持久化/恢复 + 全局交互 ================= */

/* ================= 交互 ================= */

// 工作位置持久化（TASK-R2：刷新不丢位置）
function saveUiPos() {
  // TASK-R3：数据加载+位置恢复完成前不许存。
  // 启动序是 tick → restoreUiPos → renderAll；这之前 route()/selectXxx() 会先跑，
  // 那时 ui.taskId 还是初始空值，一旦落盘就把上次的工作位置覆盖没了。
  if (!uiPosReady) return;
  try {
    localStorage.setItem('office.ui.v2', JSON.stringify({
      taskId: ui.taskId, stepKey: ui.stepKey, view: ui.view,
      search: ui.search, searchOpen: !document.getElementById('tb-search-input').hidden,
      page: activePage, settingsTab,   // TASK-工作台重做：设置页里停在第几个页签也记住
      // R9（评审 Skills/Files）：搜索词/筛选/页码/展开态刷新不丢
      // TASK-R11/S04：再加用途分类 skillCat 与列表滚动位置 skillScroll
      skillQuery, skillFilter, skillCat, skillPage, skillSelected, skillScroll,
      ...getFileFilters(),   // G02：文件页筛选状态统一走 files.js 存取口，不再各写一份字段清单
    }));
  } catch { /* 隐私模式 */ }
}
function restoreUiPos() {
  try {
    const p = JSON.parse(localStorage.getItem('office.ui.v2') || 'null');
    if (!p) return;
    if (p.view === 'overview' || p.view === 'chain') ui.view = p.view;
    if (typeof p.search === 'string' && p.search) {
      ui.search = p.search;
      const inp = document.getElementById('tb-search-input');
      inp.value = p.search; inp.hidden = false;
      document.getElementById('tb-search').classList.add('on');
    }
    const tasks = (lastFlow && lastFlow.tasks) || [];
    if (p.taskId && tasks.some((t) => t.id === p.taskId)) ui.taskId = p.taskId;   // 任务还在才恢复
    if (p.stepKey && ui.taskId) {
      const t = tasks.find((x) => x.id === ui.taskId);
      if (t && (t.steps || []).some((s) => s.key === p.stepKey)) ui.stepKey = p.stepKey;
    }
    // R90 布局重排：agents/files 升一级页，老存档停在它们的直接跳对应 hash；
    // skills 仍在设置页里当子页签（route() 会把 /skills 原地折算成设置+技能）。
    const hashOfPage = { agents: '/agents', files: '/files', skills: '/skills', log: '/log', settings: '/settings', workbench: '/pro' };
    if (p.page && hashOfPage[p.page]) location.hash = hashOfPage[p.page];
    // 老存档的 settingsTab 可能还是 agents/files（设置页旧页签）——升一级页跳过去
    if (p.settingsTab === 'agents') location.hash = '/agents';
    if (p.settingsTab === 'files') location.hash = '/files';
    if (p.settingsTab === 'skills') settingsTab = 'skills';
    if (p.settingsTab === 'general') settingsTab = 'general';
    // R9：技能页与文件页的检索状态接回（选择器/输入框的值在各自 render 时回填）
    if (typeof p.skillQuery === 'string') { skillQuery = p.skillQuery; document.getElementById('skill-search').value = p.skillQuery; }
    if (typeof p.skillFilter === 'string' && p.skillFilter) skillFilter = p.skillFilter;
    // TASK-R11/S04：用途分类与滚动位置一并接回（渲染重建 DOM 后由 renderSkills 应用）
    if (typeof p.skillCat === 'string' && p.skillCat) skillCat = p.skillCat;
    if (Number.isFinite(p.skillScroll) && p.skillScroll > 0) skillScroll = p.skillScroll;
    if (Number.isInteger(p.skillPage) && p.skillPage >= 0) skillPage = p.skillPage;
    if (typeof p.skillSelected === 'string') skillSelected = p.skillSelected;
    setFileFilters(p);   // G02：文件页筛选接回（files.js 存取口，字段类型校验同原逻辑）
    // TASK-工作台重做（G07 回归修复）：恢复出的页签要真正落到 DOM。旧四页结构里
    // 恢复位置必然改 hash → hashchange → route() 重同步页签；页签化后停在 /settings
    // 刷新时 hash 不变、route() 不会再跑，页签会永远留在「常用」——存档等于白记。
    if (activePage === 'settings') { syncSettingsTabs(); renderModules(); }
  } catch { /* 坏档就当没有 */ }
}

// TASK-R4（评审 #5）/ TASK-R5（评审 #4）：工作位置的恢复与落盘，只认「flow 完整
// 成功读取」这一个事件。部分读取失败（errors 非空）时原任务可能只是暂时缺席——
// 这时既不恢复也不落盘：restoreUiPos 找不到任务会回退到默认选择，一旦跟着
// saveUiPos 归档，原工作位置就被覆盖没了。存档原样保留，等完整读取成功的
// 那一拍再恢复 + 归档；flow 一直失败则 uiPosReady 一直为 false，saveUiPos 全程 no-op。
function completeUiPosRestore() {
  if (uiPosReady || !lastFlow) return;
  if ((lastFlow.errors || []).length > 0) return;   // 部分失败：不恢复、不落盘
  restoreUiPos();
  uiPosReady = true;
  saveUiPos();   // 归档恢复后的真实位置（任务没了回退后的那个），不留陈旧 id
}

// 选中需求：中央/右侧跟着换，滚动回顶部；步骤选择清空。
// TASK-R6（评审 #4）：不再清反馈/草稿——它们按 key 隔离存取，切回来还在
//（反馈 10 分钟内有效），不会串台，也就没有「切走即丢」的问题。
function selectTask(id, opts = {}) {
  ui.taskId = id;
  // R9（评审 IA）：切需求直接落到「卡住 Leo 的那一步」——决策面板立刻可见，
  // 不用再自己找哪步等拍板。找不到阻塞步才停在第一格。
  const t = (lastFlow && lastFlow.tasks || []).find((x) => x.id === id);
  const ss = ((t && t.steps) || []).slice().sort((a, b) => (a.no ?? 0) - (b.no ?? 0));
  const focus = ss.find((s) => isDecidable(s, ss))
    || ss.find((s) => s.status === 'failed')
    || ss.find((s) => s.status === 'running')
    || ss[0];
  ui.stepKey = focus ? focus.key : null;
  if (!opts.keepView) ui.view = 'chain';
  saveUiPos();
  renderAll();
  for (const k of Object.keys(inspScrollMemo)) delete inspScrollMemo[k];   // 换需求视图整体回顶，旧记忆不跨需求带
  document.getElementById('center').scrollTop = 0;
  document.getElementById('insp-body').scrollTop = 0;
}

// W02（第 81 轮）：详情正文按「任务:步骤」记忆滚动位置——切走前存，切回时接续；
// 轮询重渲染走 withScroll 保位置，唯独 selectStep 是整块重建，不记就回顶。
// 没看过的步骤不给记忆值，明确回顶（新内容从头上读起）。
const inspScrollMemo = {};

// TASK-R6（评审 #4）：同 selectTask——反馈/草稿按 key 留存，切步骤不清
function selectStep(key) {
  const body = document.getElementById('insp-body');
  const from = `${ui.taskId}:${ui.stepKey}`;
  const to = `${ui.taskId}:${key}`;
  if (body && ui.stepKey != null && from !== to) inspScrollMemo[from] = body.scrollTop;
  ui.stepKey = key;
  saveUiPos();
  withScroll(document.getElementById('center-chain'), renderChain);
  renderInspector();
  if (body && from !== to && inspScrollMemo[to] != null) body.scrollTop = inspScrollMemo[to];
  scheduleVersionGate();   // W02：切换步骤立即拉这一步的服务端版本判定，不等下一拍轮询
  // 窄屏（≤1099，W02 口径与 app-workbench.css 抽屉断点一致）Inspector 是覆盖层：点步骤就带出来
  if (window.matchMedia('(max-width: 1099px)').matches) {
    document.body.classList.add('insp-open');
    syncToggleStates();
  }
}

document.addEventListener('click', (ev) => {
  // 设置弹层：点外面关掉
  const pop = document.getElementById('settings-pop');
  if (!pop.hidden && !pop.contains(ev.target) && ev.target !== document.getElementById('tb-settings')
      && !document.getElementById('tb-settings').contains(ev.target)) {
    pop.hidden = true;
    document.getElementById('tb-settings').classList.remove('on');
  }
  // 决策弹层：同样点外面收起（点清单项除外，那一击要用来跳转）
  const dpop = document.getElementById('decision-pop');
  if (!dpop.hidden && !dpop.contains(ev.target) && ev.target !== document.getElementById('tb-decision')) {
    dpop.hidden = true;
  }

  // 通过/打回（Inspector 决策面板里的真按钮）
  const dc = ev.target.closest('[data-decide]');
  if (dc) { submitDecision(dc.dataset.decide); return; }

  // 决策清单 / 文件页「定位到步骤」→ 直达：选需求 → 选步骤 → 拉出 Inspector
  const go = ev.target.closest('[data-goto]');
  if (go) {
    const [taskId, stepKey] = go.dataset.goto.split('|');
    dpop.hidden = true;
    closeFileView();   // R9：从文件页跳走时顺手关掉预览抽屉，不留浮层盖在决策面板上
    const nav = () => {
      selectTask(taskId, { keepView: false });
      ui.view = 'chain';
      selectStep(stepKey);
      document.body.classList.add('insp-open');
      syncToggleStates();
    };
    // hashchange 是异步派发的：先回工作台 hash，下一拍再选，避免 route() 把 insp-open 抢先摘掉
    if (location.hash !== '#/' && location.hash !== '') { location.hash = '/'; setTimeout(nav, 0); }
    else nav();
    return;
  }

  // R85·X04：决策清单的新手路径——落在「我的任务」页就地看、就地确认，不进专业工作台
  const goHome = ev.target.closest('[data-goto-home]');
  if (goHome) {
    const [taskId, stepKey] = goHome.dataset.gotoHome.split('|');
    dpop.hidden = true;
    closeFileView();
    const nav = () => {
      selectTask(taskId, { keepView: true });
      ui.stepKey = stepKey;
      if (activePage === 'home') renderCabin();
    };
    if (location.hash !== '#/' && location.hash !== '') { location.hash = '/'; setTimeout(nav, 0); }
    else nav();
    return;
  }

  const pill = ev.target.closest('[data-open-step-files]');
  if (pill) {
    if (pill.disabled) return;
    const files = dedupFiles(currentTask()?.steps.find(s=>s.key===pill.dataset.openStepFiles)?.files || []);
    if (files.length===1) openFileView(files[0].path);
    else if (files.length>1) { document.getElementById('step-file-list').innerHTML=files.map(fileButton).join(''); document.getElementById('step-files').showModal(); }
    return;
  }
  const el = ev.target.closest('[data-task],[data-step],button');
  if (!el) return;

  if (el.classList.contains('req-item') && el.dataset.task) {
    if (el.dataset.task !== ui.taskId) selectTask(el.dataset.task);
    else if (ui.view === 'overview') selectTask(el.dataset.task);
    return;
  }
  if (el.classList.contains('ov-row') && el.dataset.task) { selectTask(el.dataset.task); return; }
  // R9：横向导航轨节点 = 旧的步骤卡，同一交互（点击选中，Inspector 出详情/决策）
  if ((el.classList.contains('track-node') || el.classList.contains('step-card')) && el.dataset.step) { selectStep(el.dataset.step); return; }
  // R9：底栏 Agent 状态点——点哪枚都跳 Agents 页看明细
  if (el.classList.contains('sb-chip')) { location.hash = '/agents'; return; }

  handleAction(el, pop);
});

// G02（第 5 轮）：顶栏/设置弹层的按钮动作分发,自全局 click 委托拆出（原回调 130 行 > 120 上限）
function handleAction(el, pop) {
  switch (el.id) {
    case 'tb-decision': {
      // 弹出待决策清单：可处理的点进去直达，条件未到的如实列出卡在哪
      const dp = document.getElementById('decision-pop');
      if (dp.hidden) { renderDecisionPop(); dp.hidden = false; }
      else dp.hidden = true;
      return;
    }
    case 'tb-score':
      // TASK-工作台重做：点顶栏「目标 X · 当前 Y」→ 回「我的任务」并展开改分框
      if (activePage !== 'home') { location.hash = '/'; }
      cabinUI.scoreEdit = true;
      renderCabin();
      document.getElementById('cabin-score-input')?.focus();
      return;
    case 'btn-overview':
      ui.view = ui.view === 'overview' ? 'chain' : 'overview';
      saveUiPos();
      renderCenter();
      return;
    case 'ip-recheck':
      // 产物手动重核：不看 60 秒缓存，立即对服务端核一遍
      scheduleFileCheck(true);
      return;
    case 'banner-retry':
      // 数据横幅上的重试：立即重新拉一轮
      tick();
      return;
    case 'rail-focus':
      if (!document.getElementById('fd-frame').src) document.getElementById('fd-frame').src=document.getElementById('fd-frame').dataset.src;
      document.getElementById('focus-panel').style.display = 'flex';
      return;
    case 'fd-close':
      // display:none 保留 iframe，不重载
      document.getElementById('focus-panel').style.display = 'none';
      return;
    case 'tb-search': {
      const input = document.getElementById('tb-search-input');
      input.hidden = !input.hidden;
      el.classList.toggle('on', !input.hidden);
      if (!input.hidden) input.focus();
      else { input.value = ''; ui.search = ''; renderReqList(); }
      return;
    }
    case 'tb-settings':
      pop.hidden = !pop.hidden;
      el.classList.toggle('on', !pop.hidden);
      return;
    case 'sp-refresh':
      tick();
      pop.hidden = true;
      document.getElementById('tb-settings').classList.remove('on');
      return;
    case 'sp-poll-btn': {
      const btn = el, label = document.getElementById('sp-poll');
      // 用户手动暂停是独立开关：页面切后台再回来不许把它偷偷打开
      // G06：轮询链开关从 pollTimer!=null 显式化为 polling（退避链运行中 timer 可为 null）
      if (polling || !userPaused) { stopPolling(); userPaused = true; label.textContent = '关'; btn.textContent = '恢复'; }
      else { userPaused = false; tick(); startPolling(); label.textContent = '开'; btn.textContent = '暂停'; }
      try { localStorage.setItem('office.poll', userPaused ? 'paused' : 'on'); } catch { /* 隐私模式 */ }
      return;
    }
    case 'sp-quiet-btn': {
      // 背景降噪：关掉顶栏/底栏的星空，只留纯色。设置持久化。
      const on = !document.body.classList.contains('quiet');
      applyQuiet(on);
      try { localStorage.setItem('office.quiet', on ? '1' : '0'); } catch { /* 隐私模式 */ }
      return;
    }
    case 'tb-insp-toggle':
      document.body.classList.toggle('insp-open');
      syncToggleStates();
      return;
    case 'tb-reqs-toggle':
      document.body.classList.toggle('reqs-open');
      syncToggleStates();
      return;
  }
}

/* ================= TASK-向导化改造：开新软件 / 录评审 / 自动返工（X07/X06/X02） ================= */

// X07：把一句想法交给 AI（POST /api/office/new-task）。成功后关表单、清草稿、立即拉一轮
// 数据并选中新任务——用户视角：说完想法，下一拍就看到「AI 正在整理你的想法」。
// 新用户从首页到提交需求两次点击（＋开始制作新软件 → 开始和 AI 讨论），不进任何设置页。
let newTaskBusy = false;   // 防双击重复建任务（后端也会按日期序号兜底，双保险）
async function submitNewTask() {
  if (newTaskBusy) return;
  const ideaEl = document.getElementById('newtask-idea');
  const hint = document.getElementById('newtask-hint');
  const idea = (ideaEl && ideaEl.value || '').trim();
  if (!idea) { if (hint) hint.textContent = '先用一两句话写下你想做什么'; if (ideaEl) ideaEl.focus(); return; }
  const scoreEl = document.getElementById('newtask-score');
  const wantScore = scoreEl ? parseFloat(scoreEl.value) : NaN;
  if (hint) hint.textContent = '';
  newTaskBusy = true;
  try {
    const d = await api('/api/office/new-task', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idea }),
    });
    // 目标分只落在这个软件上：没改就不写（保持跟随默认值），绝不偷偷改用户存的默认偏好
    if (Number.isFinite(wantScore) && Math.abs(wantScore - defaultScore()) > 0.01) {
      setTargetScore(d.taskId, Math.round(Math.min(10, Math.max(5, wantScore)) * 2) / 2);
    }
    cabinUI.newOpen = false;
    cabinDrafts.delete('newtask-idea');
    cabinDrafts.delete('newtask-score');
    cabinFresh.set(d.taskId, Date.now());   // R85·X08：标记「刚建的」，首页给三步入伙条
    showToast(`已创建「${d.title}」，AI 正在整理你的想法`);
    await tick();
    selectTask(d.taskId);
  } catch (e) {
    if (hint) hint.textContent = `创建失败：${(e && e.message) || '稍后再试'}`;
  } finally {
    newTaskBusy = false;
  }
}

// X06：录入一轮评审（POST /api/office/review，得分依据必填）。写完作废评审缓存重拉，
// 评审卡的「第 N 轮 / 建议动作」和 verify 主按钮（是否换「自动按建议继续改进」）立刻跟上。
let reviewBusy = false;
async function saveReviewRound() {
  if (reviewBusy) return;
  const t = currentTask();
  if (!t) return;
  const hint = document.getElementById('review-hint');
  const scoreEl = document.getElementById('review-score');
  const score = scoreEl ? parseFloat(scoreEl.value) : NaN;
  if (!Number.isFinite(score) || score < 0 || score > 10) {
    if (hint) hint.textContent = '得分填 0-10 之间的数字';
    if (scoreEl) scoreEl.focus();
    return;
  }
  const basisEl = document.getElementById('review-basis');
  const basis = (basisEl && basisEl.value || '').trim();
  if (!basis) { if (hint) hint.textContent = '得分依据必填——凭什么给这个分'; if (basisEl) basisEl.focus(); return; }
  if (hint) hint.textContent = '';
  const body = {
    taskId: t.id,
    score: Math.round(score * 10) / 10,
    basis,
    targetScore: targetScoreOf(t.id),
  };
  const ver = ((document.getElementById('review-ver') || {}).value || '').trim();
  if (ver) body.reviewedVersion = ver;
  const issues = ((document.getElementById('review-issues') || {}).value || '').trim();
  if (issues) body.issues = issues;
  const instruction = ((document.getElementById('review-instruction') || {}).value || '').trim();
  if (instruction) body.instruction = instruction;
  reviewBusy = true;
  try {
    await api('/api/office/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    cabinUI.reviewOpen = false;
    for (const id of ['review-score', 'review-ver', 'review-basis', 'review-issues', 'review-instruction']) cabinDrafts.delete(id);
    reviewCache.taskId = null;   // 作废缓存，下一拍强制重拉服务端台账
    showToast('这一轮评审已记录');
    await tick();
    renderCabin();
  } catch (e) {
    if (hint) hint.textContent = `保存失败：${(e && e.message) || '稍后再试'}`;
  } finally {
    reviewBusy = false;
  }
}

// X02/X06：「自动按建议继续改进」——评审台账里有修改指令就直接带上指令走既有打回通道；
// 没写指令就先展开备注框让 Leo 写清楚这轮要改什么（不拿空指令打回）。
function reworkFromReview() {
  const t = currentTask();
  if (!t) return;
  const last = reviewLatest(t);
  if (last && last.instruction) {
    decisionNotes.set(t.id + '/' + ui.stepKey, String(`按第${last.no}轮评审意见改进：${last.instruction}`).slice(0, 500));
    cabinUI.noteOpen = false;
    submitDecision('reject');
    renderCabin();
  } else {
    cabinUI.noteOpen = true;
    renderCabin();
    const h = document.getElementById('cabin-note-hint');
    if (h) h.textContent = '写清楚这轮要改什么，AI 会按这个继续改进';
    const ta = document.getElementById('cabin-note-input');
    if (ta) ta.focus();
  }
}

// 顶栏两个响应式开关的视觉状态同步
function syncToggleStates() {
  document.getElementById('tb-insp-toggle').classList.toggle('on', document.body.classList.contains('insp-open'));
  document.getElementById('tb-reqs-toggle').classList.toggle('on', document.body.classList.contains('reqs-open'));
}

// 搜索：输入即筛需求列表；Esc 清空收起
const searchInput = document.getElementById('tb-search-input');
searchInput.addEventListener('input', () => { ui.search = searchInput.value; saveUiPos(); renderReqList(); });
searchInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    searchInput.value = ''; ui.search = '';
    searchInput.hidden = true;
    document.getElementById('tb-search').classList.remove('on');
    saveUiPos(); renderReqList();
  }
});

// Esc 关闭覆盖层（不关专注面板——专注模式有自己的关闭按钮）
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  if (document.getElementById('focus-panel').style.display !== 'none'
      && document.activeElement && document.activeElement.tagName !== 'INPUT') {
    document.getElementById('focus-panel').style.display = 'none';
    return;
  }
  document.body.classList.remove('insp-open', 'reqs-open');
  syncToggleStates();
});

/* G02：M6 文件预览抽屉（openFileView / fvHistPreview / loadImagePreview 与抽屉全部事件绑定）→ preview.js */

/* ================= M7 · modules — Agents/技能/文件三个页面 + 路由 + 启动 ================= */
/* 点导航「Agent」左滑出列表；再点某个 Agent，右侧推一层看它的工作明细。
   数据全部来自 /api/state，不额外请求，也不缓存过期快照。 */

/* G02：G01 工位卡与 roster（ROLE / AVATAR / avatarFile / fmtNum / fmtAgo / agentUI / agentOf / agentBusy）→ agents.js */

/* ---- 背景降噪 ---- */
function applyQuiet(on) {
  document.body.classList.toggle('quiet', !!on);
  const label = document.getElementById('sp-quiet');
  const btn = document.getElementById('sp-quiet-btn');
  if (label) label.textContent = on ? '开' : '关';
  if (btn) btn.textContent = on ? '关闭' : '开启';
}

/* ---- 悬停看完整路径（Inspector 里的产物路径会被截断） ---- */
document.addEventListener('mouseover', (e) => {
  const el = e.target.closest('[data-fullpath]');
  if (el && !el.title) el.title = el.getAttribute('data-fullpath');
});


/* 页面切后台暂停轮询，切回来立刻刷一次——但用户手动暂停的不复活 */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopPolling();
  else { tick(); if (!userPaused) startPolling(); }
});


/* TASK-10.1 油画风图标：米金色 PNG（assets/icons/，64×64 真透明）。
   加载失败时隐藏（onerror），不留破图。 */
const ICON_PNG = ['board','agents','skills','folder','focus','search','settings','close','chevron','check','warning','clock'];
function iconPNG(name, size = 18) {
  return `<img class="ic" src="assets/icons/icon-${name}.png" width="${size}" height="${size}" alt="" aria-hidden="true" decoding="async" onerror="this.hidden=true">`;
}
/* 启动预加载，避免切页 / 重渲染闪一下 */
for (const n of ICON_PNG) { const im = new Image(); im.src = `assets/icons/icon-${n}.png`; }
// TASK-R4（评审 #1）：skillsData 初始是 null（未读到），不是 []——
// null = 加载中/读取失败（显示未加载态），[] = 成功读到且确实没有（显示 0 才诚实）。
let skillsData=null,skillPage=0,skillQuery='',skillSelected=null,skillFilter='all',skillCat='all',activePage='workbench';
/* G02：文件页检索状态 → files.js */
// TASK-R11/S04：技能列表滚动位置（跨页往返 + 刷新都要接回）
let skillScroll=0;
/* G02：fvCurrent / fvReg（预览当前文件与登记）→ preview.js */
/* G02：三张实体索引 Map（fileMetaByPath 等）→ version.js */


/* G02：fileSourceSemantics → files.js */

// TASK-R11/G03：统一操作提示（320px toast，13px/20px）
function showToast(msg,kind){
 const root=document.getElementById('toast-root');if(!root)return;
 const t=document.createElement('div');
 t.className='toast '+(kind==='err'?'toast-err':'toast-ok');
 t.textContent=msg;
 root.appendChild(t);
 setTimeout(()=>{t.classList.add('out');setTimeout(()=>t.remove(),320)},2800);
}
const fingerprints={};
function renderChanged(id,data,fn){const key=JSON.stringify(data);if(fingerprints[id]===key)return;fingerprints[id]=key;withScroll(document.getElementById(id),fn)}
function route(){
 // R90 布局重排：六个一级页 home/agents/files/log/workbench(settings) 由顶部页签接管。
 // 旧链接不作废：/agents /files 本来就是一级页；/skills 仍指设置页里的技能子页签——
 // 直接原地渲染成「设置页+技能页签」，不重写 hash（重写会多压一条历史，后退退不出去）。
 const path=location.hash.slice(1)||'/';
 if(path==='/skills'){settingsTab='skills';activePage='settings'}
 else activePage=({'/':'home','/agents':'agents','/files':'files','/log':'log','/pro':'workbench','/settings':'settings'})[path]||'home';
 document.body.dataset.page=activePage;
 for(const name of ['home','agents','files','log','workbench','settings'])document.getElementById('page-'+name).hidden=name!==activePage;
 if(activePage==='settings')syncSettingsTabs();
 for(const [id,name] of Object.entries({'tab-home':'home','tab-agents':'agents','tab-files':'files','tab-log':'log','tab-pro':'workbench','tab-settings':'settings'})){
  const el=document.getElementById(id);if(!el)continue;
  if(name===activePage)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');
 }
 document.body.classList.remove('insp-open','reqs-open');syncToggleStates();
 // TASK-向导化改造（X03）：「专业视图」统一叫「高级工作台」——只改展示名，路由 /pro 与内部 page 标识不动
 document.title=({home:'总览',agents:'Agents',files:'文件',log:'干活记录',workbench:'高级工作台',settings:'设置'})[activePage]+" · Leo's Agent Office";
 document.getElementById('step-files').close();renderModules();
 saveUiPos();  // 记住最后停在哪一页，刷新不丢
}
window.addEventListener('hashchange',route);
/* G02：ROSTER_DEFS…agentStats 与 money / RUN_STATE_CN / agentRunHtml / agentDetail / renderAgents / agentHermesDetail → agents.js */
function renderSkills(){
 // TASK-R4（评审 #1）：没读到数据 ≠ 0 条技能。读取失败/首轮未完成时如实占位，
 // 只有成功读到（skillsData 为数组）才允许出现「0 条技能」这种实测结论。
 if(skillsData==null){
  const failed=modErr.skills&&!modOkAt.skills;
  document.getElementById('skill-count').textContent='— 条技能';
  document.getElementById('skill-cat-filters').innerHTML='';
  document.getElementById('skill-filters').innerHTML='';
  document.getElementById('skill-list').innerHTML=`<div class="empty"><img src="assets/empty-data.png" alt="" width="160"><p>${failed?'技能索引读取失败。<br>原因见顶部横幅，可点「重试读取」。':'技能索引读取中…<br>首轮同步完成后展示。'}</p></div>`;
  document.getElementById('skill-pagination').innerHTML='';
  document.getElementById('skill-detail').hidden=true;
  return;
 }
 // TASK-R11/S02：两级筛选——第一级「用途」（人工整理的 skill-meta.json 分类，服务端合并进
 // 每条记录的 category 字段；没有元数据的按规范进「未分类」，不猜）；第二级「来源/Agent」。
 // 只有两个用途筛选 chip 的选中数不为 0 时才展示「未分类」——全库没有未分类时不造一个空选项。
 const SKILL_CATS=['开发','审查','浏览器','图像','文档','调度'];
 const uncatN=skillsData.filter(s=>!s.category).length;
 const catChips=[{v:'all',t:'全部'}].concat(SKILL_CATS.map(c=>({v:c,t:c})));
 if(uncatN)catChips.push({v:'uncat',t:'未分类'});
 const rows=skillsData.filter(s=>
  (skillCat==='all'||(skillCat==='uncat'?!s.category:s.category===skillCat))
  &&(skillFilter==='all'||(s.agents||[]).some(a=>a===skillFilter||a.startsWith(skillFilter+'-')))
  &&(s.name+' '+(s.description||'')).toLowerCase().includes(skillQuery.toLowerCase()));
 // S01（第 72 轮）：每页固定 6 张（2 列×3 行，任务书钉死）；页数随筛选结果走
 const SKILL_PAGE_SIZE=6;
 const pages=Math.max(1,Math.ceil(rows.length/SKILL_PAGE_SIZE));skillPage=Math.max(0,Math.min(skillPage,pages-1));
 // TASK-R11/S02：顶部结果计数 13px/20px #A3B0BF（计数语义保持「匹配 X / Y」）
 document.getElementById('skill-count').textContent=`匹配 ${rows.length} / ${skillsData.length}`;
 renderChanged('skill-cat-filters',skillCat,()=>document.getElementById('skill-cat-filters').innerHTML=catChips.map(c=>`<button class="${c.v===skillCat?'selected':''}" data-cat="${esc(c.v)}" aria-pressed="${c.v===skillCat}">${esc(c.t)}</button>`).join(''));
 renderChanged('skill-filters',skillFilter,()=>document.getElementById('skill-filters').innerHTML=['all','claude','codex','hermes'].map(a=>`<button class="${a===skillFilter?'selected':''}" data-filter="${a}" aria-pressed="${a===skillFilter}">${a==='all'?'全部':a}</button>`).join(''));
 // TASK-R11/S03：卡上两组标签语义分开——第一组 = 可调用 Agent（s.agents），第二组 = 类别。
 // 来源路径只进详情，不再出现在卡片上。
 renderChanged('skill-list',[rows,skillPage,skillSelected],()=>{document.getElementById('skill-list').innerHTML=rows.slice(skillPage*SKILL_PAGE_SIZE,skillPage*SKILL_PAGE_SIZE+SKILL_PAGE_SIZE).map(s=>{
  const tags=(s.agents||[]).slice(0,4).map(a=>`<i class="sk-tag">${esc(a)}</i>`).join('');
  return `<button class="skill-row ${s.name===skillSelected?'selected':''}" data-skill="${esc(s.name)}"><b>${esc(s.name)}</b><small>${esc(s.description||'暂无描述')}</small><span class="sk-meta">${tags}<em class="sk-cat">类别 ${esc(s.category||'未分类')}</em></span></button>`;
 }).join('')||'<div class="empty"><img src="assets/empty-search.png" alt="" width="160"><p>没有找到匹配的技能，请尝试其他关键词或清除筛选。</p></div>';
 // TASK-R11/S04：inner/DOM 重建会把 scrollTop 归零，这里恢复到最近记录的滚动位置
 document.getElementById('skill-list').scrollTop=skillScroll;
 });
 document.getElementById('skill-pagination').innerHTML=`<button class="btn btn-secondary" data-page="-1" ${skillPage===0?'disabled':''}>上一页</button><span>第 ${skillPage+1} / ${pages} 页</span><button class="btn btn-secondary" data-page="1" ${skillPage===pages-1?'disabled':''}>下一页</button>`;
 const selected=rows.find(s=>s.name===skillSelected),detail=document.getElementById('skill-detail');
 detail.hidden=!selected;
 // TASK-R11/S03：详情展示 定义来源（完整路径）/ 类别 / 可调用角色 / 加载状态 / 使用方式。
 // 没有可靠数据的字段一律「—」（.sk-na 灰 #8996A8），不造「已加载」这类未经证实的状态。
 renderChanged('skill-detail',selected,()=>{detail.innerHTML=selected?`<button class="btn btn-ghost" data-close-skill aria-label="关闭技能详情">关闭 ${iconPNG('close',14)}</button><h3>${esc(selected.name)}</h3><h4>完整描述</h4><p>${esc(selected.description||'该技能尚未提供描述')}</p><h4>类别</h4><p>${selected.category?esc(selected.category):'<span class="sk-na">—（未分类）</span>'}</p><h4>定义来源</h4><p class="skill-path">${esc(selected.path||((selected.dir||'')+'/SKILL.md'))||'<span class="sk-na">—</span>'}</p><h4>可调用角色</h4><p>${(selected.agents||[]).length?esc((selected.agents||[]).join(' · ')):'<span class="sk-na">—</span>'}</p><h4>加载状态</h4><p><span class="sk-na">—（运行时才可知，索引不冒充）</span></p><h4>使用方式</h4><p><span class="sk-na">—（技能未提供调用说明）</span></p>`:''});
}
/* G02：文件视图（fileButton/physButton/renderFiles/筛选/绑定）→ files.js */
function renderModules(){
 // R90 布局重排：agents/files 升一级页，分发跟着走；设置页里只剩 常用/技能 两个子页签。
 // 目标分小徽标在所有页常驻（有任务才显示）。
 renderScorePill();
 // R90：左侧 PROJECTS 项目栏所有页常驻（renderCabin 只管总览主区，不再管任务条）
 renderProjects();
 if(activePage==='home')renderCabin();
 if(activePage==='log')renderLog();
 if(activePage==='agents')withScroll(document.getElementById('page-agents'),renderAgents);
 if(activePage==='files')withScroll(document.getElementById('page-files'),renderFiles);
 if(activePage==='settings'){
  if(settingsTab==='general')renderSettingsGeneral();
  if(settingsTab==='skills')renderSkills();
 }
}
document.addEventListener('click',e=>{
 const b=e.target.closest('button');if(!b)return;
 // R90：顶部页签点谁跳谁的 hash，route() 统一收口（tab-pro → /pro → page-workbench）
 const routes={'tab-home':'/','tab-agents':'/agents','tab-files':'/files','tab-log':'/log','tab-pro':'/pro','tab-settings':'/settings'};
 if(routes[b.id]){location.hash=routes[b.id];return}
 // 设置页子页签（常用/技能管理）：就地切换，不动一级页 hash
 if(b.dataset.settab){settingsTab=b.dataset.settab;syncSettingsTabs();renderModules();saveUiPos();return}
 if(b.dataset.agent){agentUI.selId=agentUI.selId===b.dataset.agent?null:b.dataset.agent;renderAgents()}
 if(b.dataset.page&&!b.disabled){skillPage+=Number(b.dataset.page);skillScroll=0;renderSkills();document.getElementById('skill-list').scrollTop=0;saveUiPos()}
 if(b.dataset.skill){skillSelected=b.dataset.skill;renderSkills()}
 // TASK-R11/S02：第一级「用途」筛选（skillCat）与第二级「来源」筛选（skillFilter）分开存、分开清页码
 if(b.dataset.cat){skillCat=b.dataset.cat;skillPage=0;skillSelected=null;skillScroll=0;renderSkills();document.getElementById('skill-list').scrollTop=0;saveUiPos()}
 if(b.dataset.filter){skillFilter=b.dataset.filter;skillPage=0;skillSelected=null;skillScroll=0;renderSkills();document.getElementById('skill-list').scrollTop=0;saveUiPos()}
 if(b.hasAttribute('data-close-skill')){skillSelected=null;renderSkills()}
 if(b.hasAttribute('data-close-picker')||b.dataset.openFile)document.getElementById('step-files').close();
 // R9：清空文件页全部筛选（空状态/被筛掉的组里给的一键出口）
 if(b.hasAttribute('data-clear-file-filters')){clearFileFilters();saveUiPos();renderFiles();}
 // ===== TASK-工作台重做：驾驶舱交互 =====
 if(b.dataset.cabinTask){selectTask(b.dataset.cabinTask);renderCabin();return}
 // R90：左侧 PROJECTS 行点击 = 选中该任务并回总览看它（selectTask 自带 renderAll）
 if(b.dataset.projTask){selectTask(b.dataset.projTask);if(activePage!=='home')location.hash='/';return}
 // R90：左侧「＋ 新软件」= 旧任务条入口搬家（与 data-cabin-newopen 同一动作）；
 // 跨页跳转时 hashchange 是异步的，聚焦等新页渲染完再做
 if(b.id==='proj-new'){cabinUI.newOpen=true;if(activePage!=='home')location.hash='/';else renderCabin();setTimeout(()=>{const ta=document.getElementById('newtask-idea');if(ta)ta.focus()},0);return}
 // ===== TASK-向导化改造：开新软件 / 评审表单 / 自动返工 / 高级工作台直达 =====
 if(b.hasAttribute('data-cabin-newopen')){cabinUI.newOpen=true;renderCabin();const ta=document.getElementById('newtask-idea');if(ta)ta.focus();return}
 if(b.hasAttribute('data-cabin-newclose')){cabinUI.newOpen=false;renderCabin();return}
 if(b.hasAttribute('data-cabin-newgo')){submitNewTask();return}
 if(b.hasAttribute('data-cabin-rework')){reworkFromReview();return}
 if(b.hasAttribute('data-review-open')){cabinUI.reviewOpen=true;renderCabin();const sc=document.getElementById('review-score');if(sc)sc.focus();return}
 if(b.hasAttribute('data-review-close')){cabinUI.reviewOpen=false;renderCabin();return}
 if(b.hasAttribute('data-review-save')){saveReviewRound();return}
 if(b.hasAttribute('data-open-pro')){location.hash='/pro';return}
 if(b.hasAttribute('data-cabin-past')){cabinUI.pastOpen=!cabinUI.pastOpen;renderCabin();return}
 // R85·X07：名册展开与检查连接 / R85·X01：计划重读（R86·X02：测试任务显隐开关下线，测试固定归 /pro）
 if(b.hasAttribute('data-cabin-roster')){cabinUI.rosterOpen=!cabinUI.rosterOpen;renderCabin();return}
 if(b.hasAttribute('data-roster-check')){tick();return}
 if(b.hasAttribute('data-plan-retry')){planCache.clear();renderCabin();return}
 if(b.hasAttribute('data-cabin-note')){cabinUI.noteOpen=!cabinUI.noteOpen;renderCabin();return}
 if(b.hasAttribute('data-cabin-scoreedit')){cabinUI.scoreEdit=true;renderCabin();return}
 if(b.hasAttribute('data-cabin-savescore')){
  const v=parseFloat(document.getElementById('cabin-score-input').value);
  if(Number.isFinite(v)&&v>=5&&v<=10){setTargetScore(ui.taskId,Math.round(v*2)/2);cabinUI.scoreEdit=false;renderCabin();renderScorePill()}
  return;
 }
 if(b.hasAttribute('data-cabin-savedef')){
  const v=parseFloat(document.getElementById('cabin-defscore-input').value);
  if(Number.isFinite(v)&&v>=5&&v<=10){setDefaultScore(Math.round(v*2)/2);renderSettingsGeneral()}
  return;
 }
 // 打回/催材料：备注在这里写（textarea 不在冒泡目标里，读 DOM 值），空备注就地提示，
 // 非空则灌进 decisionNotes 走既有 submitDecision（与专业视图同一提交链路）。
 if(b.hasAttribute('data-cabin-reject')||b.hasAttribute('data-cabin-request')){
  const ta=document.getElementById('cabin-note-input');
  const txt=(ta&&ta.value||'').trim();
  if(!txt){const h=document.getElementById('cabin-note-hint');if(h)h.textContent='先写清楚要改什么，再点确认';return}
  const t=currentTask();if(!t)return;
  decisionNotes.set(t.id+'/'+ui.stepKey,txt.slice(0,500));
  submitDecision(b.hasAttribute('data-cabin-reject')?'reject':'request');
  cabinUI.noteOpen=false;renderCabin();return;
 }
});
document.getElementById('skill-search').addEventListener('input',e=>{skillQuery=e.target.value;skillPage=0;skillSelected=null;skillScroll=0;renderSkills();document.getElementById('skill-list').scrollTop=0;saveUiPos()});
// TASK-R11/S04：技能列表独立滚动——滚动位置实时记录（DOM 重建即恢复），300ms 防抖落盘
{
 const sl=document.getElementById('skill-list');
 let t=null;
 sl.addEventListener('scroll',()=>{skillScroll=sl.scrollTop;clearTimeout(t);t=setTimeout(saveUiPos,300)},{passive:true});
}
document.addEventListener('keydown',e=>{
 if(e.key==='Escape'){skillSelected=null;renderSkills()}
 if((e.key==='Enter'||e.key===' ')&&e.target.matches('.track-node')){e.preventDefault();selectStep(e.target.dataset.step)}
});
for(const [id,name] of Object.entries({'rail-home':'board','rail-log':'clock','rail-settings':'settings','rail-pro':'chevron','rail-focus':'focus','tb-search':'search','tb-settings':'settings','tb-reqs-toggle':'board','tb-insp-toggle':'chevron'})){
 // R90 布局重排：rail-* 大多已删（rail-focus 挪进 PROJECTS 底部），元素不在就跳过
 const el=document.getElementById(id);if(!el)continue;
 el.querySelector('svg,img')?.remove();el.insertAdjacentHTML('afterbegin',iconPNG(name, el.classList.contains('rail-item')?20:18));
}
route();

/* ================= 启动 ================= */
/* G04：整段启动包进 try/catch——初始化抛异常必须留下明确失败态（bootFail 挂横幅），
   不允许页面只剩外壳永久空白。异常照常 console.error 供排查，但不再是未捕获异常。 */
try {
  /* 启动：读回降噪 / 轮询开关 / 上次工作位置，再按用户意愿开轮询 */
  try { applyQuiet(localStorage.getItem('office.quiet') === '1'); } catch { applyQuiet(false); }
  try { userPaused = localStorage.getItem('office.poll') === 'paused'; } catch { userPaused = false; }
  if (userPaused) {
    document.getElementById('sp-poll').textContent = '关';
    document.getElementById('sp-poll-btn').textContent = '恢复';
  }
  // G02：决策操作模块自恢复（结果/待确认/草稿；有待确认时立即开专属回查循环，
  // 与页面轮询无关——用户可能暂停着轮询刷新进来）。口径与实现见 decision-ops.js。
  initDecisionOps();
  // G04：首轮看门狗——首轮数据获取超过 8000ms 仍无 flow 成功，必须挂出明确失败态，
  // 不允许永远停在「连接中…」。flow 首次成功一拍由 tick 撤掉；迟到成功后
  // renderDataBanner 会重判样式，失败态自动让位给真实数据。
  // G06：首轮请求已带 8s 超时，失败轮会由 tick 自己渲染四态+横幅——看门狗只兜
  // 「首轮悬死无结论」（tick 抛异常/渲染链断了）这一种；已有失败结论就不重复挂横幅。
  bootWatchdog = setTimeout(() => {
    if (modOkAt.flow || modErr.flow) return;
    bootFail('首轮数据加载超过 8000ms 未完成（API 无响应或过慢）。这是明确的失败状态，不是「暂无数据」。');
  }, 8000);
  tick().then(() => {
    // TASK-R4（评审 #5）：位置恢复/落盘已挪进 tick——只在 flow 首次成功那一拍执行
    // （见 completeUiPosRestore）。这里不再无条件恢复+归档：首轮 flow 失败时那会拿
    // 空选择覆盖存档。此处只补一次渲染（tick 内部已渲染过，重复无害）。
    renderAll();
  }).catch((e) => {
    // G04：tick 内部渲染链抛异常也不能静默成空白（unhandledrejection 会污染 __uiErrors 验收口径）
    bootFail('初始化异常：' + ((e && e.message) || e));
    console.error('[G04] 首轮 tick 异常', e);
  });
  if (!userPaused) startPolling();
} catch (e) {
  bootFail('初始化异常：' + ((e && e.message) || e));
  console.error('[G04] 启动段异常', e);
}