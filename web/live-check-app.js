
'use strict';

/* ================= 模块地图（TASK-R4 / 评审 #8） =================
   本文件按下面 7 个模块分区，每个分区有 ======= M[n] · 名称 ======= 边界。

   M1 core       工具函数、api() 请求封装（统一 12s 超时）、语义映射（纯函数，零状态）
   M2 state+poll 数据快照与页面状态声明、tick 请求编排、模块级错误登记、产物核实调度
   M3 render     渲染层（需求列表/交付链/Inspector/横幅/状态栏），只读 M2 的状态
   M4 decide     决策/重提：面板视图 + 提交 + 超时回查（pendingOps 操作集合的全生命周期在此）
   M5 pos+event  工作位置持久化与恢复、全局交互（点击/键盘/搜索）
   M6 preview    文件预览弹层（自带超时与取消控制）
   M7 modules    Agents/技能/文件三个页面 + 路由 + 启动序列

   模块间调用关系（如实，不装 layered）：M2 tick → M3 renderAll → M4 decideHtml（面板视图）；
   M4 submitDecision → M2 tick（写回后立即回读）+ M5 completeUiPosRestore 由 M2 在 flow
   首次成功时调用；M5 交互 → M3/M4；M6 独立；M7 启动 → M2 tick。
   状态归属：决策状态（decisionNotes/decisionBusy/decisionResult + pendingOps 操作集合）全在 M4；
   工作位置（ui / uiPosReady + save•restore）在 M5；数据快照（lastState/lastFlow/…）在 M2，
   渲染层只读不写。

   为什么还在一个文件里：静态资源白名单锁在 server.js 的 STATIC_APP 常量里，
   正在跑的 8090 进程只认 /app.js /app.css /offline-snapshot.js 三个名字——
   新增物理文件在不重启服务的前提下会 404，违反「改完刷新即生效」的交付约束。
   物理拆分留给下次服务重启：把各 M 分区整段剪切到独立文件，index.html 按 M1→M7
   顺序加 <script> 即可，分区间没有跨文件闭包（只有顶层 let/const 与函数声明的
   全局共享，普通多 <script> 加载即可，file:// 下 ES modules 不可用）。
   ==================================================== */

// 页面 JS 异常计数（验收口径：window.__uiErrors === 0）。
// Task-R2 补上 rejection：fetch 被拒绝不走 error 事件，之前漏计。
window.__uiErrors = 0;
window.addEventListener('error', () => { window.__uiErrors++; });
window.addEventListener('unhandledrejection', () => { window.__uiErrors++; });

/* ================= M1 · core — 工具/请求封装/语义映射（纯函数，零状态） ================= */

/* ================= 工具 ================= */

// 所有后端来的字符串都过这道闸再进 innerHTML
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtBytes(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function fmtTime(iso) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return sameDay ? `${hh}:${mm}` : `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
  } catch { return '—'; }
}

function ago(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return Math.floor(s) + ' 秒前';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
  return Math.floor(s / 86400) + ' 天前';
}

// Hermes 心跳展示（TASK-R2）：接口字段是 heartbeatAgeSec（秒），不是毫秒。
// 拿不到就「—」，不拿 0 冒充「刚刚」。
function fmtHbSec(sec) {
  if (sec == null || !Number.isFinite(Number(sec))) return '—';
  const s = Number(sec);
  if (s < 90) return '刚刚';
  const m = Math.round(s / 60);
  if (m < 60) return m + ' 分钟前';
  return Math.floor(m / 60) + ' 小时' + (m % 60 > 0 ? (m % 60) + '分' : '') + '前';
}

const offline = location.protocol === 'file:';
// TASK-R3 拆分：快照从内联 JSON 挪到 offline-snapshot.js（window.__SNAPSHOT__），
// <script src> 在 file:// 下也能加载（fetch 会被 CORS 拦，脚本标签不会）。
// 加载失败时给空壳对象，各处展示层已有「没数据显 —」的兜底，不会拿 undefined 崩掉。
const snapshot = window.__SNAPSHOT__ || { state: {}, flow: {}, skills: {}, files: {} };
async function api(path, opts) {
  if (offline) {
    if (opts?.method && opts.method !== 'GET') throw new Error('离线快照不能执行操作，请通过本地服务打开');
    const data={'/api/state':snapshot.state,'/api/office/flow':snapshot.flow,'/api/office/skills':snapshot.skills,'/api/health':{autoloop:false}};
    if (path in data) return data[path];
    throw new Error('离线模式不支持此操作');
  }
  // 前端兜底超时（TASK-R3）：服务端转发中台 8s 超时，这里 12s 收口，
  // 不让一个挂死的请求把 3 秒一轮的轮询摞起来
  const res = await fetch(path, { ...opts, signal: AbortSignal.timeout(12000) });
  let body = null;
  try { body = await res.json(); } catch { /* 空体 */ }
  if (!res.ok) {
    const msg = body && body.error ? body.error : 'HTTP ' + res.status;
    // TASK-R5（评审 #3）：HTTP 4xx/5xx 是服务端明确给出的结论（确定失败）；
    // 网络层失败（fetch TypeError / 超时中断）结果不确定——请求可能已到服务端并写入。
    // 两类错误后续处置完全不同，必须可区分。
    const err = new Error(msg);
    err.isHttpError = true;
    throw err;
  }
  return body;
}

// 路径归一：flow 数据里同一路径混用 \ 和 / 两种分隔符，归一后才能去重与比对
function normPath(p) { return String(p ?? '').replace(/\\/g, '/'); }
// F02（R14 评审·R11 重复登记）：物理文件身份键——比较 Windows 路径前的归一形式：
// ①分隔符 \ 与 / 等价；②大小写不敏感（NTFS 与登记写法混用）；③有效根目录归一——
// 剥掉 \\?\ 与 \\.\ 设备前缀、\\?\UNC\ 还原成 \\、MSYS 根 /c/ 折成 c:/、
// 折叠重复斜杠、去结尾斜杠。只用于身份比较/分组/去重；展示路径仍走 normPath（保留原大小写）。
function physKey(p) {
  let s = String(p ?? '').trim().replace(/\\/g, '/');
  if (/^\/\/\?\/unc\//i.test(s)) s = '//' + s.slice(8);          // \\?\UNC\srv\share → //srv/share
  else s = s.replace(/^\/\/[?.]+\/?/, '');                      // \\?\C:/x、\\.\C:/x → C:/x（普通 UNC // 不受影响）
  const msys = s.match(/^\/([a-z])(\/|$)/i);                    // MSYS 根 /c/Users/… → c:/Users/…
  if (msys) s = msys[1].toLowerCase() + ':' + s.slice(2);
  const unc = s.startsWith('//');
  s = s.replace(/\/{2,}/g, '/').replace(/\/+$/, '');            // 折叠重复斜杠、去结尾斜杠
  if (unc) s = '/' + s;                                         // UNC 的前导 // 保留
  return s.toLowerCase();                                       // Windows 大小写不敏感
}
// F02：登记的版本身份——sha256 优先（内容指纹），无 sha 退登记字节，再无则不可判版本。
// 同一物理文件的多条登记按它分版本：同版本合并展示、登记一条不删；不同版本各自保留真实身份。
function versionKeyOf(f) {
  if (f && f.sha256) return 'sha:' + f.sha256;
  if (f && f.bytes != null) return 'b:' + f.bytes;
  return 'v:?';
}

/* ================= 语义映射 ================= */

// 心跳判宽：与上一版一致（约 1 分钟一跳，2 分钟没动静才算超时）
const HEARTBEAT_TTL = 120000;

// 连接状态只回答「这台机器连着吗」，和干不干活无关
function connectionOf(agent, now) {
  if (!agent.online) return 'offline';
  const seen = Date.parse(agent.seenAt);
  if (!Number.isFinite(seen) || (now - seen) > HEARTBEAT_TTL) return 'stale';
  return 'online';
}

// 工作状态只看这个 Agent 名下的任务，与连接状态独立
function workOf(totals) {
  const t = totals || {};
  if ((t.retrying || 0) > 0) return 'retrying';
  if ((t.running || 0) > 0) return 'running';
  if ((t.queued || 0) > 0) return 'queued';
  return 'idle';
}

// 4 阶段是视觉投影，不是业务模型：已知 key 语义映射，未知 key 按序号比例摊
const PHASES = [
  { no: 1, name: '定义', keys: ['req', 'doc'] },
  { no: 2, name: '生产', keys: ['plan', 'brief', 'run'] },
  { no: 3, name: '验证', keys: ['deliverable', 'verify'] },
  { no: 4, name: '交付', keys: ['final'] },
];
function phaseIdxOf(step, idx, total) {
  for (let p = 0; p < PHASES.length; p++) {
    if (PHASES[p].keys.includes(step.key)) return p;
  }
  return Math.min(PHASES.length - 1, Math.floor(idx / Math.max(1, total) * PHASES.length));
}

// 步骤状态 → 中文标签（卡片/Inspector 同源）。
// TASK-R3：failed 在这条流水线里只来自「打回」（decide reject / final 打回），
// 标成「已打回」才接得上重提闭环，光写「失败」没人知道下一步干什么。
const STEP_LABEL = { done: '完成', running: '进行中', awaiting: '待拍板', pending: '等待', skipped: '已跳过', failed: '已打回', waitpre: '等待前置' };

// 待决策判定（TASK-R2，与服务端 computeDecisions 同一口径；W02 修订）：
// awaiting 只说明「审批记录已创建」，还必须前序步骤全部 done 才算「当前可审批」
// ——否则是「等待前置条件」，不进待决策计数、不给通过/打回按钮。
// gate+pending 同理：前序没走完的是「门禁未到」。依赖规则按流水线声明走：
// STEP_DEFS / flow STEPS 按 no 严格排序、无并行分组配置，前置 = 前序全部
// done；若将来声明并行分组，只改 waitingOnOf 一处，前后端同规则。
function waitingOnOf(step, steps) {
  const sorted = (steps || []).slice().sort((a, b) => (a.no ?? 0) - (b.no ?? 0));
  const i = sorted.findIndex((s) => s.key === step.key);
  if (i <= 0) return [];
  return sorted.slice(0, i)
    .filter((p) => p.status !== 'done')
    .map((p) => `${String(p.no ?? '').padStart(2, '0')} ${p.name}`);
}
function isDecidable(step, steps) {
  if (!(step.status === 'awaiting' || (step.gate === true && step.status === 'pending'))) return false;
  return waitingOnOf(step, steps).length === 0;
}

// 展示态 = 原始状态 + 前置修正（W02）：awaiting 且前序未全 done → 'waitpre'
// （等待前置条件）。轨道点 / 状态胶囊 / 上下游文字统一灰系，不占审批金；
// 这只是展示态，不写回档案，真实状态仍是 awaiting。
function dispStepState(step, steps) {
  const st = step.status || 'pending';
  if (st === 'awaiting' && !isDecidable(step, steps)) return 'waitpre';
  return st;
}

// 需求整体状态：待拍板 > 已打回 > 已交付 > 进行中 > 排队
// TASK-R3：存在 failed 步骤且未被重提时是「已打回」——
// 这时任务卡必须显眼地提示「有东西等你改」，不能再混在「进行中」里装没事。
function taskStatus(t) {
  const steps = t.steps || [];
  if (steps.some((s) => isDecidable(s, steps))) return 'awaiting';
  if (steps.some((s) => s.status === 'failed')) return 'rejected';
  if ((t.total || 0) > 0 && (t.done || 0) >= t.total) return 'delivered';
  if ((t.done || 0) === 0 && !steps.some((s) => s.status === 'running')) return 'queued';
  return 'active';
}
const TASK_STATUS_LABEL = { active: '进行中', awaiting: '待拍板', queued: '排队', delivered: '已交付', rejected: '已打回' };

// 需求当前阶段：第一个没完成的步骤所在阶段；全部完成则最后一个阶段
function currentPhaseIdx(t) {
  const steps = t.steps || [];
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].status !== 'done') return phaseIdxOf(steps[i], i, steps.length);
  }
  return PHASES.length - 1;
}

// 当前阶段文案（左侧需求卡 & 中央头部共用），如「04 交付 · 最终交付」
function currentStageText(t) {
  const steps = t.steps || [];
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].status !== 'done') {
      const p = PHASES[phaseIdxOf(steps[i], i, steps.length)];
      return `0${p.no} ${p.name} · ${steps[i].name}`;
    }
  }
  const p = PHASES[PHASES.length - 1];
  return `0${p.no} ${p.name}`;
}

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
let lastFlow = null;       // /api/office/flow 最后一次成功数据
let hubOnline = null;      // null 未知 / true / false
let lastSyncAt = null;     // 最后一次成功同步的时间戳
let fileStatus = new Map(); // normPath -> { exists, bytes }（服务端核实）
let fileCheckKey = '';     // 上次核实的路径集合指纹，不变就不重查
let pollTimer = null;

/* TASK-R2 新增状态 */
let decisionsData = null;  // /api/office/decisions：可处理 items + 门禁未到 blocked
const modErr = {};         // 模块名 -> 错误文本（state/flow/skills/files/hermes/decisions）
const modOkAt = {};        // 模块名 -> 最后一次成功时间戳，报错时据此标「数据已过期」
let userPaused = false;    // 用户手动暂停轮询（与页面隐藏暂停相互独立，回前台不覆盖）
let fileCheckedAt = 0;     // 上次核实完成时间，供「核实于 xx」展示与过期判断
let fileCheckErr = null;   // 上次核实失败原因（成功后清空）
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
let fvSeq = 0;             // 文件预览请求序号：晚到的旧响应直接丢弃
let fvAbort = null;        // TASK-R4（评审 #7）：预览在途请求的 AbortController——
                           // 关闭预览/换看别的文件时真正取消请求，不只丢弃响应
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
function ensureSelection() {
  const tasks = (lastFlow && lastFlow.tasks) || [];
  if (!tasks.length) { ui.taskId = null; ui.stepKey = null; return; }
  if (!tasks.some((t) => t.id === ui.taskId)) {
    const pick = tasks.find((t) => (t.steps || []).some((s) => isDecidable(s, t.steps)))
      || tasks.find((t) => (t.steps || []).some((s) => s.status === 'failed'))
      || tasks[0];
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
    const reqs = [
      api('/api/state'),
      api('/api/health'),
      api('/api/office/flow'),
      api('/api/office/skills'),
      api('/api/office/hermes'),
    ];
    if (!offline) reqs.push(api('/api/office/decisions'));  // 离线快照没收录这份，跳过免噪音
    const rs = await Promise.allSettled(reqs);
    const [sR, hR, fR, kR, mR, dR] = rs;

    hubOnline = hR.status === 'fulfilled' && hR.value && hR.value.autoloop === true;

    if (sR.status === 'fulfilled') { lastState = sR.value; lastSyncAt = Date.now(); setMod('state', true); }
    else setMod('state', false, sR.reason && sR.reason.message);

    const hermesOk = mR.status === 'fulfilled' && mR.value && !mR.value.error;
    if (hermesOk) { hermesData = mR.value; setMod('hermes', true); }
    else if (mR.status === 'fulfilled') setMod('hermes', false, mR.value.error);   // 接口通了但内部报错
    else setMod('hermes', false, mR.reason && mR.reason.message);

    if (fR.status === 'fulfilled' && fR.value) {
      lastFlow = fR.value;
      ensureSelection();
      scheduleFileCheck();   // 异步，不挡渲染
      const ferrs = fR.value.errors || [];
      setMod('flow', ferrs.length === 0,
        ferrs.length ? `${ferrs.length} 个任务档案读取失败（${ferrs.map((e) => e.file).join('、')}），这些需求暂不展示` : undefined);
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
    renderAll();
  } finally {
    tickInFlight = false;
  }
}

function startPolling() {
  if (offline) return;
  if (pollTimer != null) return;
  pollTimer = setInterval(tick, POLL_MS);
}
function stopPolling() {
  if (pollTimer != null) { clearInterval(pollTimer); pollTimer = null; }
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
  if (activePage === 'files') renderFiles();
}

// 同一步里同一路径常以 \ 和 / 两种写法登记两次，按归一路径去重；
// F02：去重键再带上版本身份（physKey+versionKey）——同一物理文件同一版本的混写法
// 登记合并成一条；不同历史版本是两份真实登记，不许在去重时吞掉
function dedupFiles(files) {
  const seen = new Set();
  const out = [];
  for (const f of files || []) {
    if (!f || !f.path) continue;
    const k = physKey(f.path) + '\u0000' + versionKeyOf(f);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  return out;
}

/* ================= M3 · render — 渲染层（只读 M2 的状态，不写） ================= */

/* ================= 渲染 ================= */

// innerHTML 重建但容器不动：显式保住滚动位置（三栏各自滚）
function withScroll(el, fn) {
  if (!el) { fn(); return; }
  const top = el.scrollTop;
  fn();
  el.scrollTop = top;
}

function renderAll() {
  renderDataBanner();
  renderTopbar();
  renderStatusbar();
  withScroll(document.getElementById('reqs-list'), renderReqList);
  withScroll(document.getElementById('center'), renderCenter);
  withScroll(document.getElementById('insp-body'), renderInspector);
  renderModules();
  renderOpHistory();   // TASK-R6（评审 #4）：设置弹层里的最近操作记录跟着刷新
  const dpEl = document.getElementById('decision-pop');   // 弹层开着时跟着数据一起刷新
  if (dpEl && !dpEl.hidden) renderDecisionPop();
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

/* ---- 数据异常横幅（TASK-R2）：模块读失败如实挂出，标明现有数据多旧 ---- */
const MOD_LABEL = { state: '中台状态', flow: '需求流水线', skills: '技能索引', hermes: 'Hermes 状态', decisions: '决策清单' };

function renderDataBanner() {
  const el = document.getElementById('data-banner');
  const names = Object.keys(modErr);
  if (!names.length) { el.hidden = true; el.innerHTML = ''; return; }
  const rows = names.map((n) => {
    const stale = modOkAt[n]
      ? `上次成功 ${ago(new Date(modOkAt[n]).toISOString())}，以下为过期数据`
      : '尚无成功数据';
    return `<div class="b-row"><b>${MOD_LABEL[n] || n}</b><span>${esc(modErr[n])}</span><span class="b-why">${stale}</span></div>`;
  }).join('');
  el.innerHTML = `${rows}<button id="banner-retry" class="btn" type="button">重试读取</button>`;
  el.hidden = false;
}

/* ---- 顶栏 ---- */
function renderTopbar() {
  const t = currentTask();
  document.getElementById('tb-task').textContent = t ? t.title : '—';

  // 待决策琥珀胶囊（TASK-R2，TASK-R5 评审 #5 修订）：入口同时看两件事——
  // 可拍板数 + 待重提数。之前只数可拍板，任务全在「已打回待重提」时入口整个
  // 消失，而那正是最需要入口的时候（点进去直达重提）。任一非零就显示。
  const pill = document.getElementById('tb-decision');
  let decN = null, rejN = null;
  if (decisionsData && Array.isArray(decisionsData.items)) {
    decN = decisionsData.items.length;
    rejN = Array.isArray(decisionsData.rejected) ? decisionsData.rejected.length : 0;
  }
  if (decN == null) {
    const ld = localDecisions();   // 离线/接口失败：前端用同一口径本地兜底
    decN = ld.items.length;
    rejN = ld.rejected.length;
  }
  if (decN > 0 || rejN > 0) {
    const parts = [];
    if (decN > 0) parts.push(`⏸ <b>${decN}</b> 待决策`);
    if (rejN > 0) parts.push(`↩ <b>${rejN}</b> 待重提`);
    pill.hidden = false;
    pill.innerHTML = parts.join(' · ');
    pill.title = `可拍板 ${decN} 项 · 待重提 ${rejN} 项，点击查看清单`;
  } else {
    pill.hidden = true;
  }

  // 设置弹层里的连接态
  const spConn = document.getElementById('sp-conn');
  spConn.textContent = hubOnline === true ? '在线' : hubOnline === false ? '离线' : '—';
}

/* ---- 底部状态栏 ---- */
function renderStatusbar() {
  const conn = document.getElementById('sb-conn');
  const connText = document.getElementById('sb-conn-text');
  // TASK-11.1（四区分对 #3）：这里说的是本页 ↔ 中台 API 的连接；
  // Agent 实例健不健康看右边每枚 chip（断连/空闲/执行中）——API 通 ≠ Agent 活着。
  if (hubOnline === true) { conn.classList.remove('off'); connText.textContent = 'API 连接正常'; conn.title = '指本页与中台 API 的连接；各 Agent 实例健康状态看右侧每枚状态点'; }
  else if (hubOnline === false) { conn.classList.add('off'); connText.textContent = offline ? '离线快照 · '+fmtTime(snapshot.state.now) : 'API 连接断开'; conn.title = '指本页与中台 API 的连接断开；各 Agent 实例的最后已知状态看右侧状态点'; }
  else { conn.classList.remove('off'); connText.textContent = '连接中…'; }

  // TASK-R3：还没拿到过 state（启动首拍/一直失败）时数字是「未知」，不是 0——
  // 0 是「中台确实没注册任何 Agent」的实测结论，没数据不冒充。
  // 有 lastState 但 state 模块正在报错时是「过期数据」：横幅已标旧，这里如实展示最后已知值。
  const chips = document.getElementById('sb-chips');
  if (!lastState || !Array.isArray(lastState.agents)) {
    document.getElementById('sb-agents').textContent = '已配置角色 — · 在线实例 —';
    document.getElementById('sb-agents').setAttribute('title', '中台状态尚未读到，等首轮同步完成');
    document.getElementById('sb-running').textContent = '执行中 —';
    document.getElementById('sb-running').setAttribute('title', '中台状态尚未读到，等首轮同步完成');
    chips.innerHTML = '<span class="sb-note">Agent 状态等待首轮同步…</span>';
    return;
  }
  // TASK-R11/G01：中台全量 agents 的在线统计不再在此另算一套——
  // 底栏主数字与 Agents 页同源（agentStats 名册），避免 7/7 与 4/4 打架。
  const staleNote = modErr.state ? '上一次成功读取的快照（顶部横幅可见时长）' : '';
  // TASK-R11/G01：底栏与 Agents 页共用 agentStats() 这一份标准化名册——
  // 这里显示的「一线角色 / 在线实例」就是 Agents 页统计卡上的同一组数字。
  // 中台注册数（含未启用壳角色）只进 tooltip 说明，不再当主数字与 Agents 页打架。
  const st = agentStats();
  const unknownNote = st.hasUnknown ? `；${st.roster.length - st.firstLine} 个实例未上报（状态未知，不计入在线）` : '';
  document.getElementById('sb-agents').textContent = `一线角色 ${st.roster.length} · 在线实例 ${st.rosterOnline}${st.hasUnknown ? '（另 ' + (st.roster.length - st.firstLine) + ' 未知）' : ''}`;
  document.getElementById('sb-agents').setAttribute('title', staleNote || `与 Agents 页同口径（agentStats）：一线角色 ${st.roster.length}、在线实例 ${st.rosterOnline}${unknownNote}。中台共注册角色 ${st.registered == null ? '—' : st.registered} 个（含未启用的壳角色），Agents 页统计卡可见分层`);
  document.getElementById('sb-agents').setAttribute('data-note', '一线口径=Agents页同源');
  const runEl = document.getElementById('sb-running');
  runEl.textContent = `执行中 ${st.rosterBusy}`;
  runEl.classList.toggle('run', st.rosterBusy > 0);
  runEl.setAttribute('title', staleNote || '一线 Agent 中正在执行的实例数（含重试中），与 Agents 页同口径');
  // R9（评审 Agents）：每个 Agent 一枚状态点+岗位——busy 绿 / idle 灰 / unknown 灰蓝 / down 断连，
  // 点击整排跳到 Agents 页。TASK-R11/G01：chips 同样从 agentStats() 名册渲染，
  // 带 roleId/instanceId，与 Agents 页逐一对应。A02：chip 只报名册的 conn/work 字段，
  // 与 Agents 页「连接健康 / 执行状态」列同一判定——执行状态未知就显示未知，不推断成空闲。
  chips.innerHTML = st.roster.map((s) => {
    const cls = !s.loaded ? 'unknown' : s.work === 'working' ? 'busy' : s.work === 'idle' ? 'idle' : s.conn === 'online' ? 'unknown' : 'down';
    const connTxt = !s.loaded ? '未知' : s.conn === 'online' ? '在线' : '离线';
    const workTxt = WORK_CN[s.work] || '未知';
    const state = `连接：${connTxt}｜执行状态：${workTxt}${s.workUnknownWhy ? `（${s.workUnknownWhy}）` : ''}`;
    return `<button type="button" class="sb-chip ${cls}" title="角色：${esc(s.role)}（ID ${esc(s.roleId)}）｜实例 ${s.loaded ? esc(s.instanceId) : '未上报'}｜${esc(state)}｜点击查看 Agents"><i></i>${esc(s.name)}</button>`;
  }).join('');
}

// 同步时间每秒更新（独立于 3 秒轮询，读的是最后一次成功同步的时间戳）
setInterval(() => {
  const el = document.getElementById('sb-sync');
  if (offline) { el.textContent='快照 '+fmtTime(snapshot.state.now); return; }
  el.textContent = lastSyncAt
    ? '同步 ' + new Date(lastSyncAt).toLocaleTimeString('zh-CN', { hour12: false })
    : '同步 —';
}, 1000);

/* ---- 左：需求列表 ---- */
function renderReqList() {
  const list = document.getElementById('reqs-list');
  const tasks = (lastFlow && lastFlow.tasks) || [];
  // TASK-R5（评审 #1）：「读取失败被当成没有数据」。服务端 flow 现在带 errors[]，
  // 这里按三态如实展示——
  //   完整成功（errors 空）：计数 = 实际数；空集才说「还没有需求」
  //   部分成功（tasks>0 且 errors>0）：计数 = 读到的数 + 尾注说明另有几项读取失败
  //   全部失败（tasks=0 且 errors>0）：计数「—」（不知道总数，不拿 0 冒充）+ 失败引导
  const ferrs = (lastFlow && lastFlow.errors) || [];
  const partial = ferrs.length > 0;
  document.getElementById('reqs-count').textContent = !lastFlow
    ? '—'
    : (partial && tasks.length === 0) ? '—' : String(tasks.length);

  if (!lastFlow) {
    const failed = modErr.flow && !modOkAt.flow;
    list.innerHTML = failed
      ? '<div class="empty"><img src="assets/empty-data.png" alt="" width="160"><p>需求流水线读取失败。<br>原因见顶部横幅，可点「重试读取」。</p></div>'
      : '<div class="empty"><img src="assets/empty-data.png" alt="" width="160"><p>需求流水线读取中…<br>首轮同步完成后展示。</p></div>';
    return;
  }

  const partialNote = partial
    ? `<div class="reqs-partial">另有 ${ferrs.length} 项需求档案读取失败，暂不展示（明细见顶部横幅）</div>`
    : '';

  if (!tasks.length) {
    list.innerHTML = partial
      ? `<div class="empty"><img src="assets/empty-data.png" alt="" width="160"><p>${ferrs.length} 项需求档案全部读取失败，暂无法显示需求。<br>原因见顶部横幅，可点「重试读取」。</p></div>`
      : '<div class="empty"><img src="assets/empty-data.png" alt="" width="160"><p>还没有需求进来。<br>把需求告诉 Hermes，它会在这里建档。</p></div>';
    return;
  }
  const q = ui.search.trim().toLowerCase();
  const shown = q ? tasks.filter((t) => (t.title || '').toLowerCase().includes(q) || (t.id || '').toLowerCase().includes(q)) : tasks;
  if (!shown.length) {
    list.innerHTML = `<div class="empty"><img src="assets/empty-search.png" alt="" width="160"><p>没有匹配「${esc(ui.search)}」的需求</p></div>${partialNote}`;
    return;
  }
  // R9（评审 IA）：排序 = 待我决策 → 阻塞(已打回) → 执行中 → 空闲待启动 → 已交付；
  // 同档按最近更新在前。Leo 打开列表第一眼就是需要他动手的那条。
  const RANK = { awaiting: 0, rejected: 1, active: 2, queued: 3, delivered: 4 };
  const sorted = shown.slice().sort((a, b) => {
    const ra = RANK[taskStatus(a)] ?? 9, rb = RANK[taskStatus(b)] ?? 9;
    if (ra !== rb) return ra - rb;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
  list.innerHTML = sorted.map((t) => {
    const st = taskStatus(t);
    const stage = currentStageText(t);
    // R9：7 段式进度条——一段一步，能看出卡在第几格（不再是一条糊掉的百分比）
    const ss = (t.steps || []).slice().sort((x, y) => (x.no ?? 0) - (y.no ?? 0));
    const segs = ss.length
      ? ss.map((s) => {
          // W02：awaiting 且前序未全过 → 展示态 waitpre（等待前置），段不点亮
          const ds = dispStepState(s, t.steps || ss);
          const cls = ds === 'done' ? 'done' : (ds === 'running' || ds === 'awaiting' || ds === 'failed') ? 'on' : '';
          const tip = `${String(s.no ?? '').padStart(2, '0')} ${s.name || s.key} · ${STEP_LABEL[ds] || ds}`;
          return `<i class="${cls}" title="${esc(tip)}"></i>`;
        }).join('')
      : '<i></i>';
    return `<button type="button" class="req-item s-${st}${t.id === ui.taskId ? ' sel' : ''}" data-task="${esc(t.id)}" title="已完成 ${t.done ?? 0}/${t.total ?? 0}">
      <span class="req-name">${esc(t.title)}</span>
      <span class="req-line2">
        <span class="req-status t-${st}"><i class="dot"></i>${TASK_STATUS_LABEL[st]}</span>
        <span class="req-stage">${esc(stage)}</span>
      </span>
      <span class="req-segs" aria-label="已完成 ${t.done ?? 0}/${t.total ?? 0}">${segs}</span>
    </button>`;
  }).join('') + partialNote;
}

/* ---- 中：交付链 / 概览 ---- */
function renderCenter() {
  const chain = document.getElementById('center-chain');
  const overview = document.getElementById('center-overview');
  const btn = document.getElementById('btn-overview');
  if (ui.view === 'overview') {
    chain.hidden = true;
    overview.hidden = false;
    btn.classList.add('on');
    renderOverview();
    return;
  }
  chain.hidden = false;
  overview.hidden = true;
  btn.classList.remove('on');
  renderChain();
}

// 阶段投影：把步骤按 4 阶段分列（视觉组织，不改数据）
function phasesOf(t) {
  const steps = (t.steps || []).slice().sort((a, b) => (a.no ?? 0) - (b.no ?? 0));
  return PHASES.map((p, i) => ({
    ...p,
    steps: steps.filter((s, idx) => phaseIdxOf(s, idx, steps.length) === i),
  }));
}

function renderChain() {
  const box = document.getElementById('center-chain');
  const t = currentTask();
  if (!t) {
    // TASK-R5（评审 #1/#8）：三态如实区分——未读到 / 全部读取失败 / 真的没有需求。
    // 之前「读到了但没有」一律显示「等中台恢复」，成功空集（真没有需求）也被
    // 说成中台出了毛病，文案与真实条件矛盾。
    let msg;
    if (!lastFlow) {
      msg = modErr.flow && !modOkAt.flow ? '需求流水线读取失败，原因见顶部横幅。' : '需求流水线读取中…';
    } else if ((lastFlow.tasks || []).length === 0 && (lastFlow.errors || []).length > 0) {
      msg = `${lastFlow.errors.length} 项需求档案全部读取失败，暂无法显示需求。<br>原因见顶部横幅，可点「重试读取」。`;
    } else if ((lastFlow.tasks || []).length === 0) {
      msg = '还没有需求进来。<br>把需求告诉 Hermes，它会在这里建档跟踪。';
    } else {
      msg = '没有选中的需求，点左侧列表选择一个。';
    }
    box.innerHTML = `<div class="empty"><img src="assets/empty-data.png" alt="" width="160"><p>${msg}</p></div>`;
    return;
  }
  // ---- R9（评审 IA）：删掉「现在」块与 4 阶段投影——同一份信息不再出现三次。
  // 中央 = 标题区（停在 7 步中的哪一步）+ 横向步骤导航轨 + 步骤摘要 + 产物与交接。
  const stepsSorted = (t.steps || []).slice().sort((a, b) => (a.no ?? 0) - (b.no ?? 0));
  if (!stepsSorted.length) {
    box.innerHTML = `<div class="empty"><img src="assets/empty-data.png" alt="" width="160"><p>这个需求还没有步骤档案。</p></div>`;
    return;
  }
  // 默认聚焦「卡住 Leo 的那一步」：选中 > 可拍板 > 已打回 > 进行中 > 待确认 > 第一格
  const focus = stepsSorted.find((x) => x.key === ui.stepKey)
    || stepsSorted.find((x) => isDecidable(x, t.steps))
    || stepsSorted.find((x) => x.status === 'failed')
    || stepsSorted.find((x) => x.status === 'running')
    || stepsSorted.find((x) => x.status === 'awaiting')
    || stepsSorted[0];
  const fSt = focus.status || 'pending';
  // W02：展示态——awaiting 且前序未全过显示「等待前置条件」，不算可拍板
  const fDs = dispStepState(focus, t.steps);
  const total = stepsSorted.length;
  const pct = total > 0 ? Math.round((t.done ?? 0) / total * 100) : 0;
  const waitText = isDecidable(focus, t.steps) ? '等待 Leo 决策'
    : fSt === 'failed' ? '已打回 · 待重提'
    : fSt === 'running' ? '进行中'
    : fSt === 'done' ? '已完成'
    : fDs === 'waitpre' ? `等待前置条件（${waitingOnOf(focus, t.steps).join('、')} 未通过）`
    : fSt === 'awaiting' ? '待确认'
    : '等待中';

  // 横向导航轨：一格一步，只放 编号 + 短名 + 状态点；点击即选中（与 Inspector 同一数据路径）
  const trackHtml = stepsSorted.map((x) => {
    // W02：类名/提示用展示态——waitpre 的点走灰系，title 说明在等谁
    const ds = dispStepState(x, stepsSorted);
    const waitTip = ds === 'waitpre' ? `（等 ${waitingOnOf(x, stepsSorted).join('、')} 通过）` : '';
    return `<button type="button" class="track-node st-${esc(ds)}${x.key === focus.key ? ' cur' : ''}" data-step="${esc(x.key)}" title="${String(x.no ?? '').padStart(2, '0')} ${esc(x.name)} · ${esc(STEP_LABEL[ds] || ds)}${esc(waitTip)}">
      <span class="tn-no">${String(x.no ?? '').padStart(2, '0')}</span>
      <span class="tn-name">${esc(x.name)}</span>
      <i class="tn-dot"></i>
    </button>`;
  }).join('');

  // 步骤摘要卡：执行者 / 状态 / 备注（28×28 头像位放中性 Agent 图标，不虚构身份头像）
  const focusFiles = dedupFiles(focus.files || []);
  const summaryFiles = focusFiles.map((f) => {
    const np = normPath(f.path);
    const chk = fileStatus.get(physKey(f.path));   // F02：物理键与文件库同一份校验结果
    const missing = chk && chk.exists === false;
    const size = chk && chk.exists ? fmtBytes(chk.bytes ?? f.bytes) : `${fmtBytes(f.bytes)}（登记）`;
    return `<div class="handoff-file${missing ? ' miss' : ''}" data-open-file="${esc(f.path)}" title="${esc(f.path)}&#10;点击预览内容" role="button" tabindex="0">
      <span class="hf-name">${esc(np.split('/').pop())}</span>
      <span class="hf-meta">${missing ? '文件不存在' : esc(size) + ' · ' + esc(focus.by || '—')}</span>
    </div>`;
  }).join('');

  box.innerHTML = `
    <div class="ch-head">
      <div class="ch-title-row">
        <span class="ch-id">${esc(t.id)}</span>
        <h2>${esc(t.title)}</h2>
        <span class="st st-${esc(taskStatus(t))}">${TASK_STATUS_LABEL[taskStatus(t)]}</span>
      </div>
      <div class="ch-sub">${String(focus.no ?? '').padStart(2, '0')}/${String(total).padStart(2, '0')} ${esc(focus.name)} · ${esc(waitText)}${t.updatedAt ? ' · 更新 ' + esc(fmtTime(t.updatedAt)) : ''}</div>
      <div class="ch-bar"><i style="width:${pct}%"></i></div>
    </div>
    <div class="track" role="tablist" aria-label="步骤导航">${trackHtml}</div>
    <div class="step-summary">
      <span class="ss-avatar">${iconPNG('agents', 16)}</span>
      <div class="ss-main">
        <span class="ss-name"><span class="step-number">${String(focus.no ?? '').padStart(2, '0')}</span> ${esc(focus.name)}</span>
        <span class="st st-${esc(fDs)}">${esc(STEP_LABEL[fDs] || fDs)}</span>
      </div>
      <div class="ss-meta">执行者 ${esc(focus.by || '—')} · ${focus.at ? esc(fmtTime(focus.at)) + '（' + esc(ago(focus.at)) + '）' : '时间 —'}</div>
      ${focus.note ? `<p class="ss-note" title="${esc(focus.note)}">${esc(focus.note)}</p>` : ''}
    </div>
    <div class="handoff">
      <div class="handoff-h">产物与交接</div>
      ${summaryFiles || `<div class="handoff-empty">${fSt === 'done'
        ? '步骤已完成，但未登记产物——步骤完成 ≠ 产物存在，去下方「产物实测」核对'
        : `此步骤尚无登记产物${isDecidable(focus, t.steps) && focus.key !== 'req' ? '——可在右侧决策面板「补齐材料」催交' : ''}`}</div>`}
    </div>`;
}

/* ---- 中：全部需求概览（一行一个需求，点行回到交付链） ---- */
function renderOverview() {
  const box = document.getElementById('center-overview');
  const tasks = (lastFlow && lastFlow.tasks) || [];
  if (!lastFlow) {   // TASK-R4（评审 #1）：未读到 ≠ 空集
    const msg = modErr.flow && !modOkAt.flow ? '需求流水线读取失败，原因见顶部横幅。' : '需求流水线读取中…';
    box.innerHTML = `<div class="empty"><img src="assets/empty-data.png" alt="" width="160"><p>${msg}</p></div>`;
    return;
  }
  const ovFerrs = lastFlow.errors || [];
  if (!tasks.length) {
    // TASK-R5（评审 #1）：全部读取失败 ≠ 真没有需求，分开口径
    box.innerHTML = ovFerrs.length
      ? `<div class="empty"><img src="assets/empty-data.png" alt="" width="160"><p>${ovFerrs.length} 项需求档案全部读取失败，暂无法显示。<br>原因见顶部横幅，可点「重试读取」。</p></div>`
      : '<div class="empty"><img src="assets/empty-data.png" alt="" width="160"><p>还没有需求进来。<br>把需求告诉 Hermes，它会在这里建档跟踪。</p></div>';
    return;
  }
  const rows = tasks.map((t) => {
    const phases = phasesOf(t);
    const cells = phases.map((p) => {
      const total = p.steps.length;
      const done = p.steps.filter((s) => s.status === 'done').length;
      const run = p.steps.filter((s) => s.status === 'running').length;
      const wait = p.steps.filter((s) => isDecidable(s, t.steps)).length;
      let cls = 'k-idle', txt = `${done}/${total}`;
      if (wait > 0) { cls = 'k-wait'; txt = `⏸ ${done}/${total}`; }
      else if (run > 0) { cls = 'k-run'; txt = `${done}/${total}`; }
      else if (total > 0 && done === total) { cls = 'k-done'; txt = `✓ ${done}/${total}`; }
      return `<td class="ov-cell ${cls}">${txt}</td>`;
    }).join('');
    const block = (t.steps || []).find((s) => isDecidable(s, t.steps));
    // TASK-R6（评审 #6）：failed（已打回）也是阻塞——之前概览只看「待拍板」，
    // 有打回步骤时这一列显示「无」，和状态栏/详情页说的对不上。
    const rej = !block && (t.steps || []).find((s) => s.status === 'failed');
    const stage = currentStageText(t);
    return `<tr class="ov-row${t.id === ui.taskId ? ' sel' : ''}" data-task="${esc(t.id)}">
      <td><b>${esc(t.title)}</b><div class="ch-id" style="margin-top:2px">${esc(t.id)}</div></td>
      ${cells}
      <td class="ov-cell">已完成 ${t.done ?? 0}/${t.total ?? 0}</td>
      <td>${block ? `<span class="ov-block">⏸ ${esc(block.name)}</span>` : rej ? `<span class="ov-block ov-rejected">↩ ${esc(rej.name)} · 已打回待修改</span>` : '<span class="ov-noblock">无</span>'}</td>
      <td class="ov-cell">${esc(stage)}</td>
    </tr>`;
  }).join('');
  box.innerHTML = `<table class="ov-table">
    <thead><tr><th>需求</th><th>01 定义</th><th>02 生产</th><th>03 验证</th><th>04 交付</th><th>进度</th><th>当前阻塞</th><th>当前阶段</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/* ---- 右：Inspector ---- */
/* 决策面板视图 decideHtml/priorsOf 归 M4（决策模块），在本文件更下方 */

function renderInspector() {
  // 正在输入决策/重提备注：跳过本轮重建，3 秒轮询不许吃掉输入焦点。
  // TASK-R4（评审 #4）：只保护 ip-decide-note 是漏的——重提备注框（ip-resubmit-note）
  // 同样会被轮询/文件核实重建详情区打掉焦点，两种输入框统一保护。
  const ae = document.activeElement;
  if (ae && (ae.id === 'ip-decide-note' || ae.id === 'ip-resubmit-note')) return;

  const body = document.getElementById('insp-body');
  const t = currentTask();
  if (!t) {
    body.innerHTML = '<div class="insp-empty">点左边任意一步看详情</div>';
    return;
  }
  const steps = (t.steps || []).slice().sort((a, b) => (a.no ?? 0) - (b.no ?? 0));
  const idx = steps.findIndex((s) => s.key === ui.stepKey);
  if (idx < 0) {
    body.innerHTML = '<div class="insp-empty">点左边任意一步看详情</div>';
    return;
  }
  const s = steps[idx];
  const st = dispStepState(s, steps);   // W02：展示态（awaiting 前置未齐 → waitpre）
  const label = STEP_LABEL[st] || st;

  // 产物字节双口径（TASK-R2）：登记值是 flow 档案写的，实测值是服务端 stat 的。
  // 没核实过 / 文件不在 → 只展示登记值并标「登记」；核实过且不一致 → 双显，让差异可见。
  const files = dedupFiles(s.files).map((f) => {
    const np = normPath(f.path);
    const chk = fileStatus.get(physKey(f.path));   // F02：物理键与文件库同一份校验结果
    const exists = chk ? chk.exists === true : null;
    const name = np.split('/').pop();
    const sizeHtml = !chk || !chk.exists
      ? `<span class="fb reg">登记 ${fmtBytes(f.bytes)}</span>`
      : (f.bytes != null && chk.bytes != null && chk.bytes !== f.bytes)
        ? `<span class="fb">${fmtBytes(chk.bytes)}</span><span class="fb reg">登记 ${fmtBytes(f.bytes)}</span>`
        : `<span class="fb">${fmtBytes(chk.bytes)}</span>`;
    if (exists === false) {
      // 登记了但文件不在了：标红 + 明说，不能因为接口返回了路径就当可打开
      return `<div class="ip-file miss" title="${esc(f.path)}">
        <i class="fm">✗</i><span class="fn">${esc(name)}</span>
        ${sizeHtml}<span class="ft">文件不存在</span>
      </div>`;
    }
    return `<div class="ip-file" data-open-file="${esc(f.path)}" title="${esc(f.path)} &#10;点击查看内容">
      <i class="fm" style="color:var(--ink-green)">${exists === true ? '✓' : '·'}</i>
      <span class="fn">${esc(name)}</span>${sizeHtml}
    </div>`;
  }).join('');

  // 核实时效：展示核实时间；失败如实说，并提供手动重核（TASK-R2：结果只保 60 秒）
  const filesHead = `<div class="ip-sec-h"><h4>本步产物</h4>
    ${fileCheckErr
      ? '<span class="chk-err">核实失败：沿用上次结果</span>'
      : `<span class="chk-at">${fileCheckedAt ? '核实于 ' + esc(fmtTime(fileCheckedAt)) : '未核实'}</span>`}
    ${offline ? '' : '<button class="ip-recheck" id="ip-recheck" type="button">重新核实</button>'}
  </div>`;

  const prev = steps[idx - 1];
  const next = steps[idx + 1];
  const linkHtml = (step, arrow) => {
    if (!step) return `<div class="ip-link"><span class="arr">${arrow}</span><span class="ln ip-none">—</span></div>`;
    // W02：上下游文字也用展示态——waitpre 灰系，不再误读成可拍板
    const ls = dispStepState(step, steps);
    const k = ls === 'done' ? 'k-done' : ls === 'awaiting' ? 'k-awaiting' : ls === 'running' ? 'k-running' : ls === 'failed' ? 'k-failed' : ls === 'waitpre' ? 'k-waitpre' : '';
    return `<div class="ip-link" title="${esc(step.name)}">
      <span class="arr">${arrow}</span>
      <span class="ln">${String(step.no ?? '').padStart(2, '0')} ${esc(step.name)}</span>
      <span class="ls ${k}">${esc(STEP_LABEL[ls] || ls)}</span>
    </div>`;
  };

  body.innerHTML = `
    <div class="inspector-content">
      <div class="ip-step">STEP ${String(s.no ?? '').padStart(2, '0')}</div>
      <h3 class="ip-name">${esc(s.name)} <span class="st st-${esc(st)}">${esc(label)}</span></h3>
      <div class="ip-time">${s.at ? esc(fmtTime(s.at)) + ' · ' + esc(ago(s.at)) : '时间 —'}</div>

      ${decideHtml(t, s, steps, idx)}

      <div class="ip-sec"><h4>执行者</h4><div class="ip-v">${s.by ? esc(s.by) : '<span class="ip-none">—</span>'}</div></div>

      <div class="ip-sec">${filesHead}
        ${files || '<div class="ip-none">无产物登记</div>'}
      </div>

      <div class="ip-sec"><h4>上下游</h4>
        ${linkHtml(prev, '↑')}
        ${linkHtml(next, '↓')}
      </div>

      <div class="ip-sec"><h4>备注</h4>
        ${s.note ? `<p class="ip-note">${esc(s.note)}</p>` : '<div class="ip-none">—</div>'}
      </div>
    </div>`;
}

/* ================= M4 · decide — 决策/重提（TASK-R2：真处理，不再只定位） ================= */

// 决策前提：前序步骤清单（gate 步必须全部 ✓ 才能动）
function priorsOf(steps, idx) {
  return steps.slice(0, idx).map((p) => ({
    ok: p.status === 'done',
    label: `${String(p.no ?? '').padStart(2, '0')} ${p.name}`,
  }));
}

/* ================= R9（评审 P0）：审批对象先行 =================
   「确认通过」之前必须先看到批的是什么。审批对象按步骤类型取：
   - req：审的是需求本身（标题 + 需求原文备注），不需要文件；
   - 其余产物型步骤：审的是本步登记的产物文件；
   - final / verify / 决策门禁本步未单独登记时，引用前序已登记产物
     （交付确认审的就是上游成果，但引用要明说，不冒充本步产物）。
   产物型步骤拿不出对象 → 没有「通过」可点（灰置 + 原因），
   唯一真实动作是「补齐材料」＝打回让执行者把材料交上来。 */
function approvalObjectOf(t, s, steps, idx) {
  const own = dedupFiles(s.files || []);
  if (s.key === 'req') return { kind: 'demand', files: [] };
  if (own.length) return { kind: 'files', files: own, src: 'own' };
  if (s.key === 'final' || s.key === 'verify' || s.gate === true) {
    const upstream = dedupFiles(steps.slice(0, idx).flatMap((p) => p.files || []));
    if (upstream.length) return { kind: 'files', files: upstream, src: 'upstream' };
  }
  return { kind: 'none', files: [] };
}

/* 按钮文案跟对象走：审文件的写明审什么，批准开展的写「批准开始」——
   不再一律「确认通过」让人猜批的是文档还是许可 */
const APPROVE_LABEL = {
  req: '批准 · 开始编写', doc: '通过文档', plan: '通过计划', brief: '通过简报',
  deliverable: '通过产物', verify: '通过验收', final: '通过 · 确认交付',
};
const OBJECT_LABEL = {
  req: '原始需求', doc: '需求文档', plan: '开发计划', brief: '任务简报',
  deliverable: '交付产物', verify: '验收结论', final: '最终交付',
};

/* ================= W01：声明的产物类型门禁（与服务端 artifactGateOf 同一规则） =================
   审批对象关联 = 真实 step_id + 产物登记（path/sha256）+ 声明的产物类型（files[].kind）。
   类型只认档案里显式声明的 kind 字段——不看扩展名、不猜路径：
   - 步骤未声明 expectsKinds：无类型要求，有登记产物即有效（原口径不变）；
   - 任务声明 test-any-file 测试策略：任意登记产物有效（依据入档，页面如实展示）；
   - 否则必须至少一个产物声明了匹配类型，拿不出 → 无效：主操作禁用 +
     服务端 409 ARTIFACT_KIND_MISMATCH 双保险，前端禁用只是提示，不冒充安全边界。 */
function declaredKindOf(f) {
  return f && typeof f.kind === 'string' && f.kind.trim() ? f.kind.trim() : null;
}
function artifactGate(t, s) {
  const expects = Array.isArray(s.expectsKinds) && s.expectsKinds.length ? s.expectsKinds : null;
  const p = t && t.artifactPolicy;
  const policy = p && p.mode === 'test-any-file' && typeof p.basis === 'string' && p.basis.trim()
    ? { mode: p.mode, basis: p.basis.trim() } : null;
  const own = dedupFiles(s.files || []);
  if (!expects) return { expects: null, policy, valid: true, matched: own, unmatched: [] };
  if (policy) return { expects, policy, valid: own.length > 0, matched: own, unmatched: [] };
  const matched = own.filter((f) => expects.includes(declaredKindOf(f)));
  const unmatched = own.filter((f) => !expects.includes(declaredKindOf(f)));
  return { expects, policy: null, valid: matched.length > 0, matched, unmatched };
}

/* 决策面板（TASK-R2，TASK-R4 评审 #2/#3 修订）：
   - failed 步骤 → 重提面板优先于一切成功反馈的提前 return（打回成功后步骤就是
     failed，反馈「✓ 已打回」嵌在重提面板顶部，两者同时可见，打回不再是死路）
   - 可处理 → 琥珀面板：前提清单 + 备注 + 通过/打回（真写回 flow.mjs）
   - gate+pending 但前序未齐 → 「门禁未到」+ 待办清单，不计入待决策
   - pending（超时待确认）→ 琥珀色 fb.pend，锁按钮防重复执行
   - 刚处理完 → 一条确认反馈（面板消失但不留空窗） */
function decideHtml(t, s, steps, idx) {
  const decidable = isDecidable(s, steps);
  const resultKey = `${t.id}/${s.key}`;
  // TASK-R6（评审 #4/#6）：反馈按 key 读取（decisionResultFor），切走再切回来
  // 10 分钟内还能看到这一步上次的提交结果；归属未确认的成功统一显示
  // 「档案已变更，本次提交尚未确认」，不冒充服务端确认过的结论。
  const rFor = decisionResultFor(resultKey);
  const okFb = rFor && rFor.ok;
  // TASK-R5（评审 #2）：待确认以 pendingOps 集合为准，不再依赖 decisionResult——
  // 导航会清 decisionResult（防串台），但操作本身还在回查中。从集合判断后，
  // 切走再切回来依然显示「结果待确认」并锁住按钮，生命周期不被导航破坏。
  const pend = pendingOps.has(resultKey);
  const pendFb = pend
    ? `<div class="fb pend">⏳ 结果待确认：写回可能仍在进行，自动核对服务端操作记录（独立于页面轮询），落定前不能重复提交</div>`
    : '';
  const fbErr = rFor && !rFor.ok
    ? `<div class="fb err">${esc(rFor.msg)}</div>` : '';
  // 待确认期间禁止再点（操作标识占用中，防重复执行）
  const lockBusy = decisionBusy || pend;
  // TASK-R6（评审 #4）：备注草稿按 key 留存，切走再回来不丢
  const draft = decisionNotes.get(resultKey) || '';

  // TASK-R4（评审 #2）：failed 步骤的重提面板必须先于成功反馈的提前 return——
  // 打回成功后步骤状态就是 failed 且不可决策，旧顺序里「不可决策+成功」先 return，
  // 页面只剩「✓ 已打回」没有重提按钮，打回成死路。现在成功反馈嵌在重提面板顶部，
  // 两者同时可见。重提成功后状态回 awaiting，落到下面的正常决策面板。
  if (s.status === 'failed') {
    const okLine = okFb
      ? `<div class="done-line">${rFor.unconfirmed ? '⚠' : '✓'} ${rFor.unconfirmed ? '档案已变更，本次提交尚未确认' : '已打回'}${!rFor.unconfirmed && rFor.at ? ' · ' + esc(fmtTime(rFor.at)) : ''}${rFor.note ? '<br>备注：' + esc(rFor.note) : ''}${rFor.unconfirmed && rFor.msg ? '<br>' + esc(rFor.msg) : ''}</div>`
      : '';
    return `<div class="ip-decide rej">
      <h4>↩ 已打回 · 待修改后重提</h4>
      ${okLine}
      ${s.note ? `<p class="rej-why">打回理由：${esc(s.note)}</p>` : '<p class="rej-why">打回理由未登记（打回时没写备注）</p>'}
      <textarea id="ip-resubmit-note" maxlength="500" placeholder="重提说明（可选）：改了什么、为什么这次能过" oninput="saveNoteDraft('${esc(resultKey)}',this.value,'note-cnt')">${esc(draft)}</textarea>
      <div class="note-cnt" id="note-cnt">${draft.length}/500${draft.length ? ' · 草稿已留存' : ''}</div>
      <div class="acts">
        <button class="btn btn-primary" data-decide="resubmit" ${lockBusy ? 'disabled' : ''}>重提 · 回到待拍板</button>
      </div>
      ${decisionBusy ? '<div class="fb busy">提交中…</div>' : ''}
      ${pendFb}
      ${fbErr}
    </div>`;
  }

  if (!decidable && okFb) {
    const verb = rFor.action === 'approve' ? '通过' : rFor.action === 'resubmit' ? '重提' : rFor.action === 'request' ? '催材料' : '打回';
    // TASK-R5（评审 #3）：回查兜底判定的成功是「档案已是目标状态」，归属不确定——
    // 用 ⚠ 并明说，不冒充服务端确认过的结果。
    const mark = rFor.unconfirmed ? '⚠' : '✓';
    const main = rFor.unconfirmed ? '档案已变更，本次提交尚未确认' : `已${verb}`;
    const unconfirmedNote = rFor.unconfirmed && rFor.msg
      ? `<br>${esc(rFor.msg)}` : '';
    return `<div class="ip-decide"><div class="done-line">${mark} ${main}${!rFor.unconfirmed && rFor.at ? ' · ' + esc(fmtTime(rFor.at)) : ''}${rFor.note ? '<br>备注：' + esc(rFor.note) : ''}${unconfirmedNote}</div></div>`;
  }

  if (!decidable) {
    if (s.gate === true && s.status === 'pending') {
      const waiting = priorsOf(steps, idx).filter((p) => !p.ok).map((p) => p.label);
      return `<div class="ip-sec"><h4>门禁未到</h4><div class="ip-v">这一步是决策门禁，但前序还没走完，暂时不能拍板：<br>${waiting.map((w) => '· ' + esc(w)).join('<br>')}</div></div>`;
    }
    if (s.status === 'awaiting') {
      // W02：审批记录已创建，但按流水线依赖（串行：前序全部通过）还没轮到它拍板。
      // 面板如实说在等谁，不渲染通过/打回——「记录存在」≠「现在能批」。
      const waiting = priorsOf(steps, idx).filter((p) => !p.ok).map((p) => p.label);
      return `<div class="ip-sec"><h4>等待前置条件</h4><div class="ip-v">这一步已有待审批记录，但前序还没走完，暂时不能拍板：<br>${waiting.map((w) => '· ' + esc(w)).join('<br>')}<br>前序通过并同步后，这里会变成可处理的待拍板。</div></div>`;
    }
    return '';
  }

  // ---- R9（评审 P0）：审批对象区放在备注和动作之前——先看，再批 ----
  const obj = approvalObjectOf(t, s, steps, idx);
  const hasObject = obj.kind !== 'none';
  const objLabel = OBJECT_LABEL[s.key] || s.name;
  const approveLabel = APPROVE_LABEL[s.key] || '确认通过';

  // W01：产物类型门禁——登记产物不满足本步骤声明的类型要求时，主操作禁用
  // （服务端另有 409 兜底，这里只是让用户在看板上先看到为什么不能批）。
  const gate = artifactGate(t, s);
  const materialInvalid = hasObject && !gate.valid;

  // 需求类审批：对象是需求本身（标题 + 原文备注），永远可见，不依赖文件
  const demandHtml = obj.kind === 'demand'
    ? `<div class="ev-row"><span class="ev-k">需求原文</span><span class="ev-v"><p class="ev-demand">${esc(t.title)}</p>${s.note
        ? `<p class="ev-demand ev-note" title="${esc(s.note)}">${esc(s.note)}</p>`
        : '<p class="ev-none">（需求未附补充说明）</p>'}</span></div>`
    : '';
  // 文件类审批：对象是产物清单，逐个可点开预览（走全局 data-open-file）。
  // W01：每个文件标注声明的产物类型（未声明也如实标「未声明」）——
  // 「批的是什么类型的东西」必须看得见，不让人猜。
  // W01（本轮）：文件条目改两行——第一行文件名（真实登记记录取 basename），
  // 第二行大小 + 声明类型。单行布局里元信息会把文件名挤没了，审批时认不出批的是哪个文件。
  const filesHtml = obj.kind === 'files'
    ? `<div class="ev-row"><span class="ev-k">文件预览</span><span class="ev-v">${obj.files.map((f) => {
        const np = normPath(f.path);
        const chk = fileStatus.get(physKey(f.path));   // F02：物理键与文件库同一份校验结果
        const missing = chk && chk.exists === false;
        const size = chk && chk.exists ? fmtBytes(chk.bytes ?? f.bytes) : `${fmtBytes(f.bytes)}（登记）`;
        const kind = declaredKindOf(f);
        return `<button type="button" class="ev-file${missing ? ' miss' : ''}" data-open-file="${esc(f.path)}" title="${esc(f.path)}&#10;点击预览内容">
          <i class="fm">${missing ? '✗' : '·'}</i><span class="ev-file-txt"><span class="fn">${esc(np.split('/').pop())}</span><small>${missing ? '文件不存在' : esc(size)} · 类型 ${esc(kind || '未声明')}</small></span></button>`;
      }).join('')}</span></div>
      ${obj.src === 'upstream' ? '<p class="ev-src">本步骤未单独登记产物，列出的是前序步骤已登记产物，供核对。</p>' : ''}`
    : '';
  // W01：本步骤有类型要求时明确列出；测试策略生效时把豁免依据原样挂出来，
  // 页面解释「为什么这个文件能批」，不静默放行。
  const expectsHtml = gate.expects
    ? `<div class="ev-row"><span class="ev-k">类型要求</span><span class="ev-v">${esc(gate.expects.join(' / '))}${gate.policy ? ` <span class="ev-policy" title="${esc(gate.policy.basis)}">· 测试策略 test-any-file 生效（任意登记产物可批）</span>` : ''}</span></div>`
    : '';
  const policyNote = gate.policy && gate.expects
    ? `<p class="ev-src" title="${esc(gate.policy.basis)}">本需求档案声明了测试策略（test-any-file）：任意登记产物均可作为审批对象。依据：${esc(gate.policy.basis.length > 80 ? gate.policy.basis.slice(0, 80) + '…' : gate.policy.basis)}</p>`
    : '';
  const priorsHtml = idx > 0
    ? `<div class="ev-row"><span class="ev-k">前置条件</span><span class="ev-v">${priorsOf(steps, idx).map((p) => `<span class="ev-pre ${p.ok ? 'ok' : ''}">${p.ok ? '✓' : '·'} ${esc(p.label)}</span>`).join('')}</span></div>`
    : '';
  const evidenceHtml = `
    <div class="ev">
      <div class="ev-head">审批对象 · ${esc(objLabel)}${obj.kind === 'files' ? `（${obj.files.length} 个文件）` : obj.kind === 'none' ? ' · 无' : ''}</div>
      ${demandHtml}
      ${filesHtml}
      ${expectsHtml}
      <div class="ev-row"><span class="ev-k">提交者</span><span class="ev-v">${s.by ? esc(s.by) : '<span class="ev-none">—</span>'}</span></div>
      <div class="ev-row"><span class="ev-k">提交时间</span><span class="ev-v">${s.at ? esc(fmtTime(s.at)) + ' · ' + esc(ago(s.at)) : '<span class="ev-none">—</span>'}</span></div>
      ${priorsHtml}
    </div>
    ${policyNote}`;
  // 无对象（TASK-11.1 / R1）：明说为什么不能通过，并且「确认通过」按钮根本不渲染——
  // 不是灰掉摆在那。唯一动作是「补齐材料」（request）：步骤留在待拍板，等材料交上来。
  const noObjNote = !hasObject
    ? '<div class="fb warn">本步骤尚无登记产物——没有可审批的对象，先有证据再审批。请「补齐材料」并写明缺什么，材料登记后再来通过。</div>' : '';
  // W01：有产物但类型不符——对象在、关联不成立。警示块说明规则，主操作禁用，
  // 但打回 / 补齐材料保持可用（材料不合格正是这两个动作的用武之地）。
  const invalidNote = materialInvalid
    ? `<div class="invalid-material">本步骤要求声明类型为「${esc((gate.expects || []).join(' / '))}」的材料，登记产物（${gate.unmatched.map((f) => esc(normPath(f.path).split('/').pop()) + '：' + esc(declaredKindOf(f) || '未声明类型')).join('、')}）不满足类型要求，不能作为有效审批对象。请先「补齐材料」要求提交计划类产物，或「打回」处理。</div>`
    : '';

  // TASK-R3：重提成功的反馈——步骤已回 awaiting（可决策），顶部挂一条「已重提」。
  // TASK-R6（评审 #6）：归属未确认时不再显示「✓ 已重提」，统一为未确认措辞。
  const resubmitted = okFb && rFor.action === 'resubmit'
    ? `<div class="done-line">${rFor.unconfirmed ? '⚠' : '✓'} ${rFor.unconfirmed ? '档案已变更，本次提交尚未确认' : '已重提，等待重新拍板'}${rFor.unconfirmed && rFor.msg ? '<br>' + esc(rFor.msg) : ''}</div>` : '';
  // TASK-11.1：补齐材料成功的反馈——步骤留在 awaiting（仍可决策），顶部挂一条说明。
  // 它不是通过也不是打回：待决策 ≠ 执行失败，步骤状态不变，只留了催材料的记录。
  const requested = okFb && rFor.action === 'request'
    ? `<div class="done-line">${rFor.unconfirmed ? '⚠' : '✓'} ${rFor.unconfirmed ? '档案已变更，本次提交尚未确认' : '已发出补齐材料要求，本步仍停在待拍板——材料登记后这里会列出文件'}${rFor.unconfirmed && rFor.msg ? '<br>' + esc(rFor.msg) : ''}</div>` : '';
  return `<div class="ip-decide">
    <h4>⏸ ${s.gate === true ? '决策门禁 · 等 Leo 拍板' : '待 Leo 确认'}</h4>
    ${resubmitted}
    ${requested}
    ${evidenceHtml}
    ${noObjNote}
    ${invalidNote}
    <textarea id="ip-decide-note" maxlength="500" placeholder="${hasObject ? '备注（打回必填，≤500 字）' : '说明缺什么材料（必填，≤500 字）'}" oninput="saveNoteDraft('${esc(resultKey)}',this.value,'ip-note-cnt')">${esc(draft)}</textarea>
    <div class="note-cnt" id="ip-note-cnt">${draft.length}/500${draft.length ? ' · 草稿已留存' : ''}</div>
    <div class="acts">
      ${hasObject
        ? `<button class="btn btn-primary${materialInvalid ? ' btn-invalid-material' : ''}" data-decide="approve" ${lockBusy || materialInvalid ? 'disabled' : ''} title="${materialInvalid ? '登记产物不符合本步骤类型要求，服务端同样会拒绝' : ''}">${esc(approveLabel)}</button>
           <button class="btn btn-secondary" data-decide="reject" ${lockBusy ? 'disabled' : ''}>打回</button>`
        : `<button class="btn btn-secondary" data-decide="request" ${lockBusy ? 'disabled' : ''} title="步骤留在待拍板，要求执行者先补交产物材料">补齐材料</button>`}
    </div>
    ${decisionBusy ? '<div class="fb busy">提交中…</div>' : ''}
    ${pendFb}
    ${fbErr}
  </div>`;
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
  const src = (decisionsData && Array.isArray(decisionsData.items))
    ? decisionsData
    : localDecisions();
  const generated = (decisionsData && decisionsData.generatedAt)
    ? ` · 数据 ${esc(fmtTime(decisionsData.generatedAt))}` : '';

  let html = '';
  if (src.items.length) {
    html += src.items.map(d => `
      <button class="dp-item" type="button" data-goto="${esc(d.taskId)}|${esc(d.stepKey)}">
        <span class="d-line"><b>${esc(d.stepName)}</b><span class="dp-kind ${d.kind === 'gate' ? 'is-gate' : ''}">${d.kind === 'gate' ? '门禁' : '待确认'}</span></span>
        <span class="d-task">${esc(d.taskTitle || d.taskId)}</span>
      </button>`).join('');
  }
  // TASK-R3：已打回的步骤在弹层里也要能一眼看到、一键直达（同一个 data-goto 路径）
  const rej = src.rejected || [];
  if (rej.length) {
    html += rej.map(d => `
      <button class="dp-item dp-rejected" type="button" data-goto="${esc(d.taskId)}|${esc(d.stepKey)}" title="${esc(d.note || '未登记打回理由')}">
        <span class="d-line"><b>${esc(d.stepName)}</b><span class="dp-kind is-rejected">已打回</span></span>
        <span class="d-task">${esc(d.taskTitle || d.taskId)}${d.note ? ' · ' + esc(d.note) : ''}</span>
      </button>`).join('');
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
      page: activePage,
      // R9（评审 Skills/Files）：搜索词/筛选/页码/展开态刷新不丢
      // TASK-R11/S04：再加用途分类 skillCat 与列表滚动位置 skillScroll
      skillQuery, skillFilter, skillCat, skillPage, skillSelected, skillScroll,
      fileQuery, fileTask, fileStep, fileType, fileAgent, fileSort, fileOnlyWith,
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
    const pages = ['workbench', 'agents', 'skills', 'files'];
    if (p.page && pages.includes(p.page) && p.page !== 'workbench') {
      location.hash = { agents: '/agents', skills: '/skills', files: '/files' }[p.page] || '/';
    }
    // R9：技能页与文件页的检索状态接回（选择器/输入框的值在各自 render 时回填）
    if (typeof p.skillQuery === 'string') { skillQuery = p.skillQuery; document.getElementById('skill-search').value = p.skillQuery; }
    if (typeof p.skillFilter === 'string' && p.skillFilter) skillFilter = p.skillFilter;
    // TASK-R11/S04：用途分类与滚动位置一并接回（渲染重建 DOM 后由 renderSkills 应用）
    if (typeof p.skillCat === 'string' && p.skillCat) skillCat = p.skillCat;
    if (Number.isFinite(p.skillScroll) && p.skillScroll > 0) skillScroll = p.skillScroll;
    if (Number.isInteger(p.skillPage) && p.skillPage >= 0) skillPage = p.skillPage;
    if (typeof p.skillSelected === 'string') skillSelected = p.skillSelected;
    if (typeof p.fileQuery === 'string') fileQuery = p.fileQuery;
    if (typeof p.fileTask === 'string') fileTask = p.fileTask;
    if (typeof p.fileStep === 'string') fileStep = p.fileStep;
    if (typeof p.fileType === 'string') fileType = p.fileType;
    if (typeof p.fileAgent === 'string') fileAgent = p.fileAgent;
    if (typeof p.fileSort === 'string') fileSort = p.fileSort;
    if (typeof p.fileOnlyWith === 'boolean') fileOnlyWith = p.fileOnlyWith;
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
  document.getElementById('center').scrollTop = 0;
  document.getElementById('insp-body').scrollTop = 0;
}

// TASK-R6（评审 #4）：同 selectTask——反馈/草稿按 key 留存，切步骤不清
function selectStep(key) {
  ui.stepKey = key;
  saveUiPos();
  withScroll(document.getElementById('center-chain'), renderChain);
  renderInspector();
  // 窄屏（≤1280）Inspector 是覆盖层：点步骤就带出来
  if (window.matchMedia('(max-width: 1280px)').matches) {
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

  switch (el.id) {
    case 'tb-decision': {
      // 弹出待决策清单：可处理的点进去直达，门禁未到的如实列出卡在哪
      const dp = document.getElementById('decision-pop');
      if (dp.hidden) { renderDecisionPop(); dp.hidden = false; }
      else dp.hidden = true;
      return;
    }
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
      if (pollTimer != null || !userPaused) { stopPolling(); userPaused = true; label.textContent = '关'; btn.textContent = '恢复'; }
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
});

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

/* ================= M6 · preview — 文件预览（自带超时与取消控制） ================= */
/* 点 Inspector 里的产物 → 拉 /api/office/file → 按类型渲染。
   Markdown 不做富文本渲染，直接显示原文——要"看真实内容"，不是"看美化后的成品"，
   原文更能暴露问题（比如文件其实是空的、或者写的是别的任务）。 */

// 图片预览的 blob objectURL（TASK-R5 评审 #6）：img 直接挂 /api/office/file 的 URL
// 会绕过超时与取消控制，改为 fetch+blob 后再建 objectURL；换文件/关闭时必须 revoke。
let fvObjectUrl = null;
function releaseFvObjectUrl() {
  if (fvObjectUrl) { try { URL.revokeObjectURL(fvObjectUrl); } catch { /* 已释放 */ } fvObjectUrl = null; }
}

// 图片分支与文本同款的受控加载：12s 超时 + AbortController 取消 + 序号防旧响应上屏
async function loadImagePreview(p, seq) {
  if (fvAbort) { try { fvAbort.abort(); } catch { /* 已结束 */ } }
  const ac = new AbortController();
  fvAbort = ac;
  const timer = setTimeout(() => ac.abort(), 12000);
  try {
    const res = await fetch(`/api/office/file?path=${encodeURIComponent(p)}`, { signal: ac.signal });
    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      try { const d = await res.json(); if (d && d.error) msg = d.error; } catch { /* 无体 */ }
      throw new Error(msg);
    }
    const blob = await res.blob();
    if (seq !== fvSeq) return;   // 期间用户点了别的文件：这份结果作废
    releaseFvObjectUrl();
    fvObjectUrl = URL.createObjectURL(blob);
    document.getElementById('fv-meta').textContent = fmtBytes(blob.size);
    document.getElementById('fv-body').innerHTML = `<img src="${fvObjectUrl}" alt="预览图">`;
  } catch (e) {
    if (seq !== fvSeq) return;
    // 能到这里的 abort 就是 12s 超时（主动取消时 seq 已变，走不到这里）
    const msg = e && (e.name === 'AbortError' || e.name === 'TimeoutError')
      ? '读取超时（12 秒无响应），已中断' : (e && e.message) || '未知错误';
    document.getElementById('fv-body').innerHTML = `<div class="fv-err">图片读取失败：${esc(msg)}<br>
      <button class="btn btn-secondary" data-fv-retry="${esc(p)}">重试</button></div>`;
  } finally {
    clearTimeout(timer);
    if (fvAbort === ac) fvAbort = null;
  }
}

// R9（评审 Files）：这条路径登记在哪个需求的哪一步——预览抽屉里「定位到步骤」用。
// 找不到（文件已从档案移除等）返回 null，按钮如实隐藏，不给一条跳空的路。
// F02：比较用物理键——\ 与 /、大小写、设备前缀等写法差异不再让同一步的登记对不上。
function stepOfPath(p) {
  const pk = physKey(p);
  for (const t of (lastFlow && lastFlow.tasks) || []) {
    for (const s of t.steps || []) {
      if ((s.files || []).some((f) => physKey(f.path) === pk)) return { taskId: t.id, stepKey: s.key };
    }
  }
  return null;
}
// TASK-R11/F02 补：按（可选的）需求+步骤取这条路径的那条登记；from 缺省或未命中退回首条。
// 同一文件登记在多个步骤时（如 TEST-R11 的 doc+plan 都挂 app.css），行标签、详情、
// 重新校验三处必须用同一条登记，否则「大小不一致」的行点开却显示「一致」。
// F02：物理键取登记集合；from.vkey（所点行的版本）优先，两条登记版本分叉后不串行。
function resolveFileReg(p, from) {
  const regs = fileRegsByPath.get(physKey(p)) || [];
  if (!regs.length) return null;
  if (from) {
    const hit = (from.vkey
      ? regs.find((r) => r.meta.taskId === from.taskId && r.meta.stepKey === from.stepKey && versionKeyOf(r.f) === from.vkey)
      : null) || regs.find((r) => r.meta.taskId === from.taskId && r.meta.stepKey === from.stepKey);
    if (hit) return hit;
  }
  return regs[0];
}

/** F02（R14 评审·R11 重复登记）：实体校验状态——五态判定，行标签与详情共用同一口径。
 *  unchecked=还没核实到；unreadable=服务端读不了；ok=登记与实测一致；
 *  hist=登记版本与实测不同、但同一路径下另有登记版本的 bytes 与磁盘当前内容一致
 *       → 不是登记错了，是磁盘上是另一个历史版本，按历史版本解释；
 *  mism=大小不一致；unknown=登记值缺失、无从比较（不得判定为一致）。
 *  multiVersion=同一路径存在多个登记版本（详情里明示）。
 *  F02（第 8 轮）：同一物理文件的每条登记各比各的登记大小——实体里任一条登记
 *  与实测不同即 mism；没有不同但有登记缺 bytes 即 unknown；全部一致才 ok。
 *  regBytes=实体名下登记过的大小（去重保序），供行内「登记」行展示，不改登记原文。 */
function entityCheckState(pk, ent) {
  const chk = fileStatus.get(pk);
  if (!chk) return { code: 'unchecked', chk: null, multiVersion: false, regBytes: [] };
  const ents = fileEntitiesByPath.get(pk);
  const multiVersion = !!(ents && ents.size > 1);
  if (!chk.exists) return { code: 'unreadable', chk, multiVersion, regBytes: [] };
  const refs = (ent && ent.refs) || [];
  const regBytes = [];
  let mismRef = null, missRef = null;
  for (const r of refs) {
    const b = r.f && r.f.bytes;
    if (b == null || !Number.isFinite(b)) { if (!missRef) missRef = r; continue; }
    if (!regBytes.includes(b)) regBytes.push(b);
    if (chk.bytes !== b && !mismRef) mismRef = r;
  }
  if (mismRef) {
    if (ents) for (const e of ents.values()) {
      if (e === ent) continue;
      for (const r of e.refs || []) {
        const g = r.f && r.f.bytes;
        if (g != null && g === chk.bytes) return { code: 'hist', chk, multiVersion, regBytes };
      }
    }
    return { code: 'mism', chk, multiVersion, regBytes };
  }
  if (missRef) return { code: 'unknown', chk, multiVersion, regBytes };
  return { code: 'ok', chk, multiVersion, regBytes };
}
// F02：登记的版本身份给用户看的写法——有 sha256 用指纹前 8 位，退而求其次按登记大小。
function versionLabelOf(f) {
  if (!f) return '—';
  if (f.sha256) return `内容指纹 ${String(f.sha256).slice(0, 8)}`;
  if (f.bytes != null) return `按登记大小 ${fmtBytes(f.bytes)}`;
  return '不可判版本';
}

/** TASK-R11/F02/F03：预览抽屉的元数据区。实测/登记双口径分开列（24px 行 · 13px），
 *  执行者与来源类型语义拆开，「归档迁移」不再冒充执行者。没有可靠数据的行显示「—」。
 *  reg = 所点那一行的登记；缺省退回首条。多步登记时补一行「登记步骤」明示口径。
 *  F02：reg.ent 指向物理实体——「登记版本/引用登记/登记步骤」按实体口径展开，
 *  同一版本的多条登记是引用不是两个文件；不同版本各开各的行、身份不混。 */
function renderFvDetail(p, reg){
 const det=document.getElementById('fv-detail');
 const pk=physKey(p);
 const regs=fileRegsByPath.get(pk)||[];
 if(!reg)reg=regs[0]||null;
 const meta=reg&&reg.meta;
 const sem=fileSourceSemantics(meta&&meta.by);
 const f=reg&&reg.f;
 const ent=(reg&&reg.ent)||null;
 const refs=(ent&&ent.refs&&ent.refs.length)?ent.refs:(reg?[reg]:[]);
 const st=entityCheckState(pk,ent);
 const regB=f&&f.bytes!=null?fmtBytes(f.bytes):'—';
 const actB=st.chk&&st.chk.exists?fmtBytes(st.chk.bytes):'—';
 const stateText={
  unchecked:'—（尚未实测）',
  unreadable:'无法校验（不可读，非丢失）',
  ok:'一致',
  unknown:'未知（登记值缺失，无法与实测比较，不判定为一致）',
  hist:`历史版本（登记 ${regB} ≠ 实测 ${actB}；同一路径下另有版本与磁盘当前内容一致）`,
  mism:`大小不一致（登记 ${regB} ≠ 实测 ${actB}${st.multiVersion?'；同一路径存在多个登记版本':''}；同一物理文件的每条登记各比各的登记大小）`,
 }[st.code];
 const stepLabel=(r)=>`${r.meta.taskTitle} › ${String(r.meta.stepNo??'').padStart(2,'0')} ${r.meta.stepName}`;
 const rows=[
  ['执行者',sem.executor],
  ['来源类型',sem.sourceType||'—'],
  ['登记版本',versionLabelOf(f)],
 ];
 if(refs.length>1)rows.push(['引用登记',`${refs.length} 条（同一物理文件同一版本，原始登记均保留）`]);
 if(refs.length>1)rows.push(['登记步骤',refs.map(stepLabel).join('；')]);
 else if(meta)rows.push(['登记步骤',stepLabel(reg)]);
 rows.push(
  ['实测值',st.chk&&st.chk.exists?fmtBytes(st.chk.bytes):'—'],
  ['测量时间',st.chk&&st.chk.exists&&st.chk.mtime?fmtTime(st.chk.mtime):'—'],
  ['登记值',regB],
  ['登记时间',meta&&meta.at?fmtTime(meta.at):'—'],
  ['校验状态',stateText],
 );
 det.hidden=false;
 det.innerHTML=rows.map(([k,v])=>`<div class="fvd-row"><span>${k}</span><b${k==='校验状态'&&(st.code==='mism'||st.code==='unreadable'||st.code==='unknown')?' class="warn"':''} title="${esc(String(v))}">${esc(String(v))}</b></div>`).join('');
}
async function openFileView(p, from) {
  const seq = ++fvSeq;              // 竞争保护：连点几个文件，只有最后一次请求有资格上屏
  const box = document.getElementById('file-view');
  const body = document.getElementById('fv-body');
  document.getElementById('fv-name').textContent = String(p).split(/[\\/]/).pop();
  document.getElementById('fv-meta').textContent = '';
  document.getElementById('fv-path').textContent = p;
  body.innerHTML = '<div class="fv-msg">读取中…</div>';
  // R9：定位到步骤——能溯源就给链接，不能就隐藏（不摆假按钮）
  const loc = document.getElementById('fv-locate');
  // TASK-R11/F02 补：优先用所点行自带的登记上下文（from），多步登记不串口径
  const reg = resolveFileReg(p, from);
  const tgt = reg ? { taskId: reg.meta.taskId, stepKey: reg.meta.stepKey } : stepOfPath(p);
  if (tgt) { loc.hidden = false; loc.dataset.goto = `${tgt.taskId}|${tgt.stepKey}`; }
  else loc.hidden = true;
  // TASK-R11/F02/F03：元数据区 + 重校验入口（离线快照或无溯源登记时不给按钮，不摆假的）
  fvCurrent = tgt ? { path: p, taskId: tgt.taskId, stepKey: tgt.stepKey } : { path: p };
  fvReg = reg;
  renderFvDetail(p, reg);
  document.getElementById('fv-revalidate').hidden = offline || !tgt;
  // 受控下载出口：任何时候都可拿到原件（离线快照没有本地服务，不给）
  const dl = document.getElementById('fv-dl');
  dl.hidden = offline;
  dl.href = '/api/office/file-download?path=' + encodeURIComponent(p);
  box.classList.add('open');

  if (offline) {
    const file=snapshot.files[p];
    document.getElementById('fv-meta').textContent='离线快照';
    body.innerHTML=file?`<pre>${esc(file.text||file.note||'暂无可预览内容')}</pre>`:'<div class="fv-warn">离线快照没有收录此文件，请通过本地服务打开。</div>';
    return;
  }
  const ext = (String(p).match(/\.[^.\\/]+$/) || [''])[0].toLowerCase();
  // TASK-R5（评审 #6）：图片不再裸挂 <img src>（绕过超时/取消，悬挂时永远「读取中…」），
  // 与文本同款走 fetch+blob 受控加载；解码失败由下面的捕获态 error 监听兜底
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) {
    body.dataset.fvPath = p;
    releaseFvObjectUrl();
    body.innerHTML = '<div class="fv-msg">图片读取中…</div>';
    loadImagePreview(p, seq);
    return;
  }

  try {
    // TASK-R4（评审 #7）：预览请求纳入统一超时保护（与 api() 同为 12s），
    // 不再裸 fetch——悬挂时永远停在「读取中」。AbortController 让关闭预览/
    // 换文件能真正取消在途请求，超时后走就地重试分支。
    if (fvAbort) { try { fvAbort.abort(); } catch { /* 已结束 */ } }
    const ac = new AbortController();
    fvAbort = ac;
    const timer = setTimeout(() => ac.abort(), 12000);
    let res, d;
    try {
      res = await fetch(`/api/office/file?path=${encodeURIComponent(p)}`, { signal: ac.signal });
      d = await res.json();
    } finally {
      clearTimeout(timer);
      if (fvAbort === ac) fvAbort = null;
    }
    if (seq !== fvSeq) return;      // 期间用户点了别的文件：这份结果作废
    if (!res.ok || d.exists === false) {
      // TASK-R3：HTTP 级失败也给就地重试，和 catch 分口一致——
      // 报错只报一半、想重试得关掉重点，是差一步的体验。
      body.innerHTML = `<div class="fv-warn">${esc(d.error || ('HTTP ' + res.status))}<br>
        <button class="btn btn-secondary" data-fv-retry="${esc(p)}">重试</button></div>`;
      return;
    }
    document.getElementById('fv-meta').textContent =
      `${fmtBytes(d.bytes)}${d.modifiedAt ? ' · ' + fmtTime(d.modifiedAt) : ''}`;
    if (d.kind === 'binary') {
      body.innerHTML = `<div class="fv-msg">${esc(d.note || '二进制文件，不支持页面预览')}<br><br>请用右上角「下载」取原件。</div>`;
      return;
    }
    const warn = d.truncated
      ? `<div class="fv-warn">文件 ${fmtBytes(d.bytes)}，超过 2MB 只显示前 2MB</div>` : '';
    body.innerHTML = `${warn}<pre>${esc(d.text || '')}</pre>`;
  } catch (e) {
    if (seq !== fvSeq) return;      // 用户已关闭/换文件：不回写旧面板
    // 主动取消（abort）只发生在换文件/关闭场景，seq 已变，走不到这里；
    // 能到这里的 abort 就是 12s 超时——如实说，别甩一句英文 AbortError
    const msg = e && (e.name === 'AbortError' || e.name === 'TimeoutError')
      ? '读取超时（12 秒无响应），已中断' : (e && e.message) || '未知错误';
    body.innerHTML = `<div class="fv-err">读取失败：${esc(msg)}<br>
      <button class="btn btn-secondary" data-fv-retry="${esc(p)}">重试</button></div>`;
  }
}

function closeFileView() {
  fvSeq++;                          // 关闭即作废在途请求，回来不允许再上屏
  if (fvAbort) { try { fvAbort.abort(); } catch { /* 已结束 */ } fvAbort = null; }   // TASK-R4：真取消，不留悬挂连接
  releaseFvObjectUrl();             // TASK-R5（评审 #6）：释放图片 objectURL
  document.getElementById('file-view').classList.remove('open');
  document.getElementById('fv-body').innerHTML = '';
}

// 图片加载失败是 <img> 自身的 error 事件，不冒泡——捕获态监听一次，给错误态 + 重试
document.getElementById('fv-body').addEventListener('error', (ev) => {
  if (ev.target.tagName !== 'IMG') return;
  const p = ev.target.parentElement.dataset.fvPath || document.getElementById('fv-path').textContent;
  ev.target.outerHTML = `<div class="fv-err">图片加载失败（路径不存在或不可读）<br>
    <button class="btn btn-secondary" data-fv-retry="${esc(p)}">重试</button></div>`;
}, true);

// Inspector 里点产物行 / 点遮罩关闭 / 失败重试
document.addEventListener('click', (e) => {
  // TASK-R11/F04：整行单击打开预览，但行内的「定位到步骤」「清除筛选」是独立动作——
  // 不加这道闸它们会被行上的 data-open-file 抢走，点了没反应
  if (e.target.closest('[data-goto],[data-clear-file-filters]')) return;
  const row = e.target.closest('[data-open-file]');
  if (row) {
    // TASK-R11/F02 补：文件页的行/预览按钮带自己的登记（data-task-id/data-step-key），
    // 点哪条登记就展示哪条；工作台等入口没有上下文 → null，退回首条登记
    // F02：行上还带版本键（data-vkey）——同一路径版本分叉后，点哪条版本就展示哪条
    const host = row.closest('.library-file') || row;
    const from = host.dataset.taskId ? { taskId: host.dataset.taskId, stepKey: host.dataset.stepKey, vkey: host.dataset.vkey || null } : null;
    openFileView(row.getAttribute('data-open-file'), from);
    return;
  }
  const retry = e.target.closest('[data-fv-retry]');
  if (retry) { openFileView(retry.getAttribute('data-fv-retry')); return; }
  if (e.target.id === 'file-view') closeFileView();
});
document.getElementById('fv-close').addEventListener('click', closeFileView);
// R9（评审 Files）：复制路径。127.0.0.1 是安全上下文，clipboard API 可用；
// execCommand 兜底，仍失败就如实报「复制失败」——不假装成功。
document.getElementById('fv-copy').addEventListener('click', async () => {
  const p = document.getElementById('fv-path').textContent;
  const btn = document.getElementById('fv-copy');
  let ok = false;
  try { await navigator.clipboard.writeText(p); ok = true; }
  catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = p; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      ok = document.execCommand('copy');
      ta.remove();
    } catch { ok = false; }
  }
  const old = btn.textContent;
  btn.textContent = ok ? '已复制' : '复制失败';
  setTimeout(() => { btn.textContent = old; }, 1500);
});
// TASK-R11/F02：重新校验——服务端读真实文件元数据（大小+sha256）更新登记并留历史；
// 文件读不到就明确「无法校验」，登记原样不动（服务端 file-events.jsonl 留痕）。
document.getElementById('fv-revalidate').addEventListener('click', async () => {
  if(!fvCurrent||offline)return;
  const btn=document.getElementById('fv-revalidate');
  btn.disabled=true;const old=btn.textContent;btn.textContent='校验中…';
  try{
    const d=await api('/api/office/file-revalidate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(fvCurrent)});
    if(d.ok){
      fileStatus.set(physKey(fvCurrent.path),{exists:true,bytes:d.after.bytes,mtime:d.after.mtime});   // F02：物理键，与两页共用口径一致
      fileStatusVersion++;
      // TASK-R11/F02 补：登记值就地按服务器回写更新（下一轮 renderFiles 会以档案为准重建）
      if(fvReg&&fvReg.f)fvReg.f.bytes=d.after.bytes;
      renderFvDetail(fvCurrent.path,fvReg);
      if(activePage==='files')renderFiles();
      showToast(d.changed?`已更新登记：实测 ${fmtBytes(d.after.bytes)}（原 ${fmtBytes(d.before.bytes)}，历史已保留）`:`校验一致：${fmtBytes(d.after.bytes)}`,'ok');
    }else{
      showToast(`无法校验：${d.message||'文件不可读'}`,'err');
    }
  }catch(err){
    showToast(`重新校验失败：${err.message||err}`,'err');
  }finally{
    btn.disabled=false;btn.textContent=old;
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('file-view').classList.contains('open')) {
    closeFileView();
  }
});

/* ================= M7 · modules — Agents/技能/文件三个页面 + 路由 + 启动 ================= */
/* 点导航「Agent」左滑出列表；再点某个 Agent，右侧推一层看它的工作明细。
   数据全部来自 /api/state，不额外请求，也不缓存过期快照。 */

/** 岗位（看板上一律显示岗位，不显示内部 agent id） */
const ROLE = {
  claude: '开发', codex: '审查', 'claude-readonly': '日报',
  'image-gen': '生图', dsh: '开发', hermes: '调度', 'gpt-drive': '讨论',
};

/** 头像文件：按 agent id 对应，不用名字首字（三个 C 分不出来） */
const AVATAR = {
  claude: 'claude-code.png', codex: 'codex.png', 'claude-readonly': 'claude-readonly.png',
  'image-gen': 'image-gen.png', dsh: 'dsh.png', hermes: 'hermes.png', 'gpt-drive': 'gpt-drive.png',
};

function avatarFile(id) {
  return AVATAR[id] || 'hermes.png';
}

function fmtNum(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return String(v);
}

function fmtAgo(iso) {
  return ago(iso) || '—';
}

const agentUI = { selId: null };

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

function agentOf(id) {
  return (lastState && lastState.agents || []).find((a) => a.id === id) || null;
}

/** Agent 的忙闲判定：running/claimed/retrying 都算在干活 */
function agentBusy(a) {
  const t = a.totals || {};
  return (t.running || 0) + (t.retrying || 0) > 0;
}

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
// R9（评审 Files）：文件页检索状态——与技能页一样刷新不丢（存 office.ui.v2）
let fileQuery='',fileTask='all',fileStep='all',fileType='all',fileAgent='all',fileSort='recent',fileOnlyWith=true;
// TASK-R11/S04：技能列表滚动位置（跨页往返 + 刷新都要接回）
let skillScroll=0;
// TASK-R11/F02：当前预览的文件上下文（path+taskId+stepKey），「重新校验」用
let fvCurrent=null;
// TASK-R11/F02 补：当前抽屉正在展示的那条登记（同文件多步登记时跟随所点行；重校验后就地更新再重绘）
let fvReg=null;
// TASK-R11/F03：文件页溯源元数据按规范化路径索引——预览抽屉展示 执行者/来源类型/登记信息 用
const fileMetaByPath=new Map();
// TASK-R11/F02 补：同一路径的全部登记（数组，顺序同 fileMetaByPath 首条口径）；fileMetaByPath 保留为首条快查
// F02：键改用物理键 physKey——\ 与 /、大小写、设备前缀等写法差异归到同一实体
const fileRegsByPath=new Map();
// F02（R14 评审·R11 重复登记）：物理路径 → 版本键 → 实体 {pk,vk,refs[{meta,f,ent}]}。
// refs = 同一物理文件同一版本的全部登记（引用）；实体行渲染按它聚合，登记一条不删。
const fileEntitiesByPath=new Map();

// TASK-R11/G01：全站唯一的角色/实例标准化口径。
// 「角色」= ROSTER_DEFS 里的稳定角色ID（一线 4 个：3 个 Hermes 入口 + Codex）；
// 「实例」= 各上报源里的实例标识（Hermes 用自报 id，Codex 用中台 agent id）。
// 底栏与 Agents 页的每一个数字都从这一份 roster 算，不允许各页面自己数各的。
const ROSTER_DEFS=[
 {roleId:'lemate',name:'Lemate',role:'Coding'},
 {roleId:'winter',name:'Winter',role:'视频剪辑'},
 {roleId:'karina',name:'Karina',role:'图文笔记'},
 {roleId:'codex',name:'Codex',role:'生图·审查'},
];
// A02：连接健康 / 执行状态 / 上报新鲜度 —— 三个独立数据字段，一处判定，两处共用。
// 底栏 chips 与 Agents 页 roster 全部读 agentStats() 产出的 conn/work/hbState，
// 任何一个表面不得自己再判一套。语义边界：
//   连接健康   = online（Hermes 心跳 3 分钟窗口 / Codex 中台 seenAt 120 秒窗口）；
//   执行状态   = 只认「当前有效」的自报 state。自报缺失、已过期（reportStale）、
//               连接断开一律「未知」——历史上报事件只进「最近动作」列，不推断当前状态
//               （服务端 hermes-status 会把过期自报降级成 idle，前端按 reportStale 还原成未知）；
//   上报新鲜度 = 心跳年龄 heartbeatAgeSec，超 120 秒 = 超时（金色），与自报是否过期无关。
const WORK_CN={working:'执行中',idle:'空闲',unknown:'未知'};
const HERMES_TASK_PLACEHOLDERS=new Set(['—','未接入上报','（离线）','（上次上报已过期）']);
function hermesWorkOf(h){
 if(!h||!h.online)return 'unknown';         // 连接断开：执行状态不可知，不推断
 if(h.reportStale)return 'unknown';         // 过期自报被服务端降级成 idle；按「未知」还原（A02）
 if(h.state==='working')return 'working';
 if(h.state==='idle')return 'idle';
 return 'unknown';                          // state=unknown（从未接入上报）等
}
function hermesWorkUnknownWhy(h){
 if(!h)return '该角色没有实例上报';
 if(!h.online)return '连接已断开';
 if(h.reportStale)return '上次自报已过期';
 return '从未接入上报';
}
function hermesHbOf(h){
 if(!h)return{state:'none',text:'—'};
 const s=h.heartbeatAgeSec!=null?Number(h.heartbeatAgeSec):null;
 if(s==null||!Number.isFinite(s))return{state:'none',text:'—'};
 return s>120?{state:'timeout',text:`心跳超时 · ${fmtHbSec(s)}`}:{state:'ok',text:fmtHbSec(s)};
}
// A02：最近动作列只放「事件」——新鲜自报的任务文本，或带真实事件时间的历史告警。
// 历史告警不得取代当前执行状态；没有事件时间的历史异常显示 —。
function hermesTaskEvent(h){
 if(!h)return{text:'—',title:'该角色当前没有实例上报'};
 if(h.reportStale){
  if(!h.lastReport)return{text:'—',title:'上次自报已过期，但记录缺上报时间，按「无时间」显示 —'};
  return{text:`上次上报已过期 · ${fmtTime(h.lastReport)}`,title:`历史事件：自报于 ${fmtTime(h.lastReport)}，已过期；不代表当前执行状态`,hist:true};
 }
 const t=String(h.task||'').trim();
 if(!t||HERMES_TASK_PLACEHOLDERS.has(t))
  return{text:'—',title:t==='未接入上报'?'该入口从未接入任务上报，执行状态未知':null};
 return{text:t};
}
function agentStats(){
 const hubAgents=(lastState&&Array.isArray(lastState.agents))?lastState.agents:null;
 const now=Date.parse(lastState&&lastState.now)||Date.now();
 const hs=(hermesData&&hermesData.agents)||[];
 const roster=ROSTER_DEFS.map(d=>{
  if(d.roleId==='codex'){
   const a=hubAgents?hubAgents.find(x=>x.id==='codex'):null;
   if(!a)return{...d,loaded:false,online:false,busy:false,timeout:false,work:'unknown',connText:'—',workText:WORK_CN.unknown,hbState:'none',hbText:'—',taskText:'—'};
   const c=connectionOf(a,now);
   const runs=(lastState?.runs||[]).filter(r=>r.agent==='codex').slice(0,1);
   const work=a.totals==null?'unknown':(agentBusy(a)?'working':'idle');  // A02：任务计数缺失不推断
   return{...d,loaded:true,instanceId:a.id,
    conn:c==='offline'?'offline':'online',
    online:c!=='offline',work,busy:work==='working',
    timeout:c==='stale',
    connText:c==='online'?'在线':c==='stale'?'在线（上报停滞）':'离线',
    workText:WORK_CN[work],
    workUnknownWhy:work==='unknown'?'中台未上报任务计数':null,
    hbState:c==='stale'?'timeout':(a.seenAt?'ok':'none'),
    hbText:c==='stale'?`上报超时 · ${esc(fmtAgo(a.seenAt))}`:esc(fmtAgo(a.seenAt)),
    taskText:runs.length?esc(runs[0].rule||runs[0].state):'—'};
  }
  const h=hs.find(x=>x.id===d.roleId);
  if(!h)return{...d,loaded:false,online:false,busy:false,timeout:false,work:'unknown',connText:'—',workText:WORK_CN.unknown,hbState:'none',hbText:'—',taskText:'—',taskTitle:'该角色当前没有实例上报'};
  const work=hermesWorkOf(h);
  const hb=hermesHbOf(h);
  const ev=hermesTaskEvent(h);
  return{...d,loaded:true,instanceId:h.id,
   conn:h.online?'online':'offline',
   online:!!h.online,work,busy:work==='working',
   timeout:hb.state==='timeout',
   connText:h.online?'在线':'离线',
   workText:WORK_CN[work],
   workUnknownWhy:work==='unknown'?hermesWorkUnknownWhy(h):null,
   hbState:hb.state,hbText:esc(hb.text),
   taskText:esc(ev.text),taskTitle:ev.title?esc(ev.title):null,taskHist:!!ev.hist};
 });
 const loaded=roster.filter(r=>r.loaded);
 return{
  registered:hubAgents?hubAgents.length:null,          // 中台注册角色（含未启用壳角色）
  roster,                                               // 一线 Agent 名册（含未加载占位）
  firstLine:loaded.length,
  rosterOnline:loaded.filter(r=>r.online).length,
  rosterBusy:loaded.filter(r=>r.work==='working').length,
  rosterIdle:loaded.filter(r=>r.work==='idle').length,        // A02：只有明确自报「空闲」才计，未知不计入空闲
  rosterUnknownWork:loaded.filter(r=>r.work==='unknown').length,
  hasUnknown:roster.some(r=>!r.loaded),                 // 有实例没上报时如实说「未知 N」
 };
}

// TASK-R11/F03：来源语义拆分——「执行者」与「来源类型」是两个字段。
// 「归档迁移」是导入行为不是角色：执行者记「—」，来源类型记「历史归档」。
// 依据任务档案里真实出现过的 by 值（Hermes/hermes/Leo（工作台）/归档迁移），
// 不在这一层猜测未登记的值：其它值原样作为执行者，来源类型记 null（前端不显示标签）。
function fileSourceSemantics(by){
 const b=String(by||'').trim();
 if(!b)return{executor:'—',sourceType:null,executorKnown:false};
 if(b==='归档迁移')return{executor:'—',sourceType:'历史归档',executorKnown:false};
 if(/^hermes$/i.test(b))return{executor:'Hermes',sourceType:'Agent生成',executorKnown:true};
 if(b.startsWith('Leo'))return{executor:b,sourceType:'人工创建',executorKnown:true};
 return{executor:b,sourceType:null,executorKnown:true};
}

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
 const path=location.hash.slice(1)||'/';activePage=({'/':'workbench','/agents':'agents','/skills':'skills','/files':'files'})[path]||'workbench';
 document.body.dataset.page=activePage;
 for(const name of ['workbench','agents','skills','files'])document.getElementById('page-'+name).hidden=name!==activePage;
 for(const [id,name] of Object.entries({'rail-reqs':'workbench','rail-agents':'agents','rail-skills':'skills','rail-files':'files'})){
  const el=document.getElementById(id);if(name===activePage)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');
 }
 document.body.classList.remove('insp-open','reqs-open');syncToggleStates();
 document.title=({workbench:'工作台',agents:'Agents',skills:'技能',files:'文件'})[activePage]+" · Leo's Agent Office";
 document.getElementById('step-files').close();renderModules();
 saveUiPos();  // 记住最后停在哪一页，刷新不丢
}
window.addEventListener('hashchange',route);
function money(n){return n==null?'未统计':'$'+Number(n).toFixed(2)}
// TASK-R5（评审 #7）：单条执行记录的 HTML 抽成函数——原来整段内联在 agentDetail
// 的模板串里，一行 900+ 字符；执行记录的结构与状态映射单独看才好核对。
const RUN_STATE_CN={done:'完成',failed:'失败',running:'执行中',claimed:'已领取',retrying:'重试'};
function agentRunHtml(r){
 const st=r.state==='done'?'done':r.state==='failed'?'failed':'running';
 return `<div class="agent-run"><span class="st st-${st}">${esc(RUN_STATE_CN[r.state]||r.state)}</span> ${esc(r.rule||'—')}<p>${esc(r.summary||'暂无执行摘要')}</p></div>`;
}
function agentDetail(a){
 const t=a.totals||{},u=t.usage||{};
 const runs=(lastState?.runs||[]).filter(r=>r.agent===a.id).slice(0,8);
 // 没上报的字段显示 —，不用 0 冒充「做过了」
 const toks=(u.input==null&&u.output==null)?null:(u.input||0)+(u.output||0);
 const runsHtml=runs.length?runs.map(agentRunHtml).join(''):'<p class="agent-role">最近没有执行记录</p>';
 return `<div class="agent-detail"><h4>当前状态</h4><div class="agent-kv"><span>角色ID（稳定）</span><span>codex</span></div><div class="agent-kv"><span>实例ID</span><span>${esc(a.id)}</span></div><div class="agent-kv"><span>${a.online?'在线':'离线'} · ${a.totals==null?'状态未知':(agentBusy(a)?'工作中':'空闲')}</span><span>${t.retrying==null?'—':t.retrying} 重试中</span></div><div class="agent-kv"><span>最近心跳</span><span>${esc(fmtAgo(a.seenAt))}</span></div><h4>累计工作量</h4><div class="agent-kv"><span>已完成 ${t.done==null?'—':t.done}</span><span>${toks==null?'—':fmtNum(toks)} tokens</span></div><h4>最近 8 条执行记录</h4>${runsHtml}</div>`;
}
function renderAgents(){
 // 平级架构：三个 Hermes（Lemate / Winter / Karina）各自是不同场景的需求入口，
 // 加上 Codex。TASK-R11/G01：名册与底栏同源（agentStats），每行带稳定角色ID+实例ID；
 // 中台注册数单独成统计卡——「中台注册 7」与「一线 4」分层展示，同一份名册可解释。
 const st=agentStats();
 const hs=hermesData?.agents||[];
 const codex=(lastState?.agents||[]).find(a=>a.id==='codex');
 const scopeText=`本页只列一线 Agent（${hs.length} 个 Hermes 入口${codex?' + Codex':''}）；中台共注册角色 ${st.registered==null?'—':st.registered} 个，其余为未启用的壳角色。两层数字均出自同一份名册（agentStats），与底栏一致。`;
 // TASK-R3：Hermes 状态还没读到（或一直失败）时如实说「未加载」，
 // 不拿空数组算出「0 个入口 · 0 在线」冒充实测结论。
 if(!hermesData){
  document.getElementById('agent-scope').textContent='Hermes 状态未加载（读取失败或尚未完成首轮同步），顶部横幅可见具体原因，恢复后自动刷新。';
  document.getElementById('agent-stats').innerHTML='';
  document.getElementById('agent-grid').innerHTML='<div class="empty"><img src="assets/empty-data.png" alt="" width="160"><p>Hermes 状态还没读到，等下一轮同步。<br>顶部横幅可见读取状态。</p></div>';
  return;
 }
 // TASK-R11/G01：三个统计卡横向排列——中台注册角色 / 一线角色 / 在线实例。
 // 中台注册数含未启用壳角色，是分层说明的一半；一线数字与底栏逐字相同。
 document.getElementById('agent-stats').innerHTML=[
  {label:'中台注册角色',value:st.registered==null?'—':String(st.registered),title:'中台 /api/state 的 agents 总数，含未启用的壳角色（claude-readonly / image-gen / gpt-drive / dsh 等）'},
  {label:'一线角色',value:String(st.roster.length),title:'实际参与工作的 Agent：3 个 Hermes 入口 + Codex。底栏「一线角色」同一个数'},
  {label:'在线实例',value:String(st.rosterOnline)+(st.hasUnknown?`（另 ${st.roster.length-st.firstLine} 未知）`:''),title:st.hasUnknown?'未上报的实例不计入在线；底栏「在线实例」同一个数':'一线角色中当前在线的实例数；底栏「在线实例」同一个数'},
 ].map(c=>`<div class="stat-card" title="${esc(c.title)}"><span class="sc-label">${esc(c.label)}</span><b class="sc-num">${esc(c.value)}</b></div>`).join('');
 // TASK-R11/G01：范围说明必须是可见文字（此前只藏在 ? 图标里，评审两轮看不见）
 document.getElementById('agent-scope').textContent=scopeText;
 // R9：roster 表格化。A02：连接健康 / 执行状态 / 上报新鲜度 三列读 agentStats
 // 产出的 conn / work / hbState 三个独立字段——「在线（连接，绿）」「心跳超时（新鲜度，金）」
 // 「执行状态未知（历史上报已过期时不推断成空闲）」各自成列，互不顶替。
 // 最近动作列只放事件：新鲜自报的任务文本，或带真实事件时间的历史告警；无时间的历史异常显示 —。
 const now=Date.parse(lastState?.now)||Date.now();
 const rowsRoster=st.roster.map(r=>{
  if(r.roleId==='codex'){
   const c=codex;
   return{...r,id:r.roleId,ava:avatarFile('codex'),
    det:()=>agentDetail(c)};
  }
  const h=hs.find(x=>x.id===r.roleId);
  return{...r,id:r.roleId,ava:avatarFile(r.roleId),
   det:()=>agentHermesDetail(h,r.roleId)};
 });
 const head=`<div class="roster-head"><span></span><span>Agent</span><span>连接健康</span><span>执行状态</span><span>上报新鲜度</span><span>当前需求 / 最近动作</span></div>`;
 const cards=rowsRoster.map(r=>{
  const sel=r.id===agentUI.selId;
  const workCls=r.work==='working'?'work-working':r.work==='idle'?'work-idle':'work-unknown';
  const hbCls=r.hbState==='timeout'?'stale':r.hbState==='ok'?'ok':'off';
  const dotCls=r.work==='working'?'run':r.online?(r.timeout?'stale':'ok'):'off';
  return `<article class="agent-card ${sel?'selected':''}"><button type="button" class="agent-select" data-agent="${esc(r.id)}" aria-expanded="${sel}">
   <span class="ag-ava"><img class="agent-avatar" src="assets/agents/${esc(r.ava)}" alt=""><i class="ava-dot ${dotCls}"></i></span>
   <span class="ag-idcol"><span class="agent-name">${esc(r.name)}<i class="ag-ids" title="角色ID ${esc(r.roleId)}｜实例ID ${r.loaded?esc(r.instanceId):'未上报'}">${esc(r.roleId)}·${r.loaded?esc(r.instanceId):'?'}</i></span><span class="agent-role">${esc(r.role)}</span></span>
   <span class="ag-conn ${r.online?'ok':'off'}">${r.connText}</span>
   <span class="ag-work ${workCls}"${r.workUnknownWhy?` title="执行状态未知：${r.workUnknownWhy}（不推断为空闲）"`:''}>${r.workText}</span>
   <span class="ag-hb ${hbCls}">${r.hbText}</span>
   <span class="ag-task${r.taskHist?' hist':''}"${r.taskTitle?` title="${r.taskTitle}"`:''}>${r.taskText}</span>
  </button>${sel?r.det():''}</article>`;
 });
 renderChanged('agent-grid',[rowsRoster,agentUI.selId],()=>{
  document.getElementById('agent-grid').innerHTML=head+cards.join('')||'<div class="empty"><img src="assets/empty-data.png" alt="" width="160"><p>尚未收到 Agent 数据</p></div>';
 });
}
function agentHermesDetail(h,roleId){
 // A02：明细行与 roster 三列同一套判定（hermesWorkOf / hermesHbOf / hermesTaskEvent），
 // 并把「上次自报时间」单独列出来——历史告警的事件时间在这里可核对。
 const work=h?hermesWorkOf(h):'unknown';
 const hb=hermesHbOf(h);
 const ev=hermesTaskEvent(h);
 const rows=[
  ['角色ID（稳定）', roleId||'—'],
  ['实例ID', h?h.id:'—'],
  ['连接健康', h?(h.online?'在线':'离线（未接入上报时如实显示）'):'—'],
  ['执行状态', h?WORK_CN[work]+(work==='unknown'?`（${hermesWorkUnknownWhy(h)}，不推断为空闲）`:''):'—'],
  ['上报新鲜度（心跳）', h&&h.online?(hb.state==='timeout'?'心跳超时（超 120 秒）':'正常'):'—'],
  ['最后心跳', h&&h.heartbeatAgeSec!=null?fmtHbSec(h.heartbeatAgeSec):'—'],
  ['上次自报', h?(h.lastReport?`${fmtTime(h.lastReport)}${h.reportStale?'（已过期，属历史事件）':''}`:'从未上报'):'—'],
  ['当前需求 / 最近动作', ev.text],
  ['类型 / 场景', h?`${h.type||'—'} · ${h.scene||'—'}`:'—'],
 ];
 return `<div class="agent-detail"><h4>实时状态</h4>${rows.map(([k,v])=>`<div class="agent-kv"><span>${k}</span><span>${esc(String(v))}</span></div>`).join('')}
 <p class="agent-role" style="margin-top:10px">平级入口之间不共享内部数据。这一行是 ${esc(h?h.name:'—')} 自己上报的，不是外部探测的。</p></div>`;
}
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
 const pages=Math.max(1,Math.ceil(rows.length/20));skillPage=Math.max(0,Math.min(skillPage,pages-1));
 // TASK-R11/S02：顶部结果计数 13px/20px #A3B0BF（计数语义保持「匹配 X / Y」）
 document.getElementById('skill-count').textContent=`匹配 ${rows.length} / ${skillsData.length}`;
 renderChanged('skill-cat-filters',skillCat,()=>document.getElementById('skill-cat-filters').innerHTML=catChips.map(c=>`<button class="${c.v===skillCat?'selected':''}" data-cat="${esc(c.v)}" aria-pressed="${c.v===skillCat}">${esc(c.t)}</button>`).join(''));
 renderChanged('skill-filters',skillFilter,()=>document.getElementById('skill-filters').innerHTML=['all','claude','codex','hermes'].map(a=>`<button class="${a===skillFilter?'selected':''}" data-filter="${a}" aria-pressed="${a===skillFilter}">${a==='all'?'全部':a}</button>`).join(''));
 // TASK-R11/S03：卡上两组标签语义分开——第一组 = 可调用 Agent（s.agents），第二组 = 类别。
 // 来源路径只进详情，不再出现在卡片上。
 renderChanged('skill-list',[rows,skillPage,skillSelected],()=>{document.getElementById('skill-list').innerHTML=rows.slice(skillPage*20,skillPage*20+20).map(s=>{
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
// F02（R14 评审·R11 重复登记）：一行 = 一个物理实体（physKey × 版本），不再是一条登记。
// ent.refs = 同一物理文件同一版本的全部登记；taskId 给定时只列该需求的引用（多需求共用同一文件时每组各显示一行）。
function fileButton(ent, taskId){
 const refs=taskId?ent.refs.filter(r=>r.meta.taskId===taskId):ent.refs;
 const reg=refs[0]||ent.refs[0];
 if(!reg)return '';
 const meta=reg.meta, f=reg.f;
 // TASK-R11/F01/F02/F03：一行 64px = 图标 + 文件名/来源路径 + 右侧 240px 元信息（大小/执行者/来源类型）+ 140px 操作区。
 // F02：校验六态——一致 / 尚未实测 / 无法校验 / 大小不一致 / 登记缺失未知 / 历史版本（与预览抽屉同一判定函数）
 // F02（第 8 轮）：190px 元信息列里异常/未知态 = 标签 + 双行「实测/登记」（12px/18px），
 // 实测值与工作台/抽屉同源同舍入；登记行只读登记原文（多条登记各有大小时逐一列出），不改不覆盖。
 // 正常态实测值用完成绿。登记值缺失只标未知，绝不判一致。
 const st=entityCheckState(ent.pk,ent);
 const regLine=st.regBytes&&st.regBytes.length?st.regBytes.map(b=>fmtBytes(b)).join(' · '):null;
 const dual=(tag)=>`<span class="lf-dual">${tag}<span class="lf-lines"><span class="lf-size">实测 ${esc(fmtBytes(st.chk.bytes))}</span><span class="lf-size">登记 ${esc(regLine||'—（缺失）')}</span></span></span>`;
 let size;
 if(st.code==='unchecked') size=`<span class="lf-size" title="尚未实测，显示登记值">${esc(fmtBytes(f.bytes))}（登记）</span>`;
 else if(st.code==='unreadable') size=`<i class="lf-tag unver" title="文件当前不可读（不存在或无法访问）；登记信息保持原样，不推断为已丢失">无法校验</i>`;
 else if(st.code==='hist') size=`<i class="lf-tag hist" title="登记 ${esc(regLine||'—')} 与实测 ${esc(fmtBytes(st.chk.bytes))} 不同；同一路径下另有版本与磁盘当前内容一致，按历史版本保留身份">历史版本</i>`;
 else if(st.code==='mism') size=dual(`<i class="lf-tag mism" title="实测 ${esc(fmtBytes(st.chk.bytes))} · 登记 ${esc(regLine||'—')}，每条登记各比各的登记大小。文件可能在登记后被修改；点开预览可「重新校验」${st.multiVersion?'；同一路径存在多个登记版本':''}">大小不一致</i>`);
 else if(st.code==='unknown') size=dual(`<i class="lf-tag unver" title="登记值缺失，无法与实测大小比较，按未知处理，不判定为一致">登记缺失</i>`);
 else size=`<span class="lf-size ok" title="实测与每条登记的大小都一致">✓ ${esc(fmtBytes(st.chk.bytes))}</span>`;
 const miss=st.code==='unreadable';
 const name=normPath(f.path).split('/').pop();
 const srcPath=normPath(f.path)+(refs.length>1?` · ${refs.length} 处登记`:'');
 // F03：执行者一栏只放真实角色名或「—」；来源类型（Agent生成/人工创建/历史归档）独立成标签，
 // 未知执行者用 #8996A8 弱化，「归档迁移」不再冒充 Agent 身份
 const sem=fileSourceSemantics(meta&&meta.by);
 const executor=`<span class="lf-exec${sem.executorKnown?'':' na'}">${esc(sem.executor)}</span>`;
 const typeTag=sem.sourceType?`<i class="lf-type">${esc(sem.sourceType)}</i>`:'';
 const locate=meta?`<button type="button" class="lf-locate" data-goto="${esc(meta.taskId)}|${esc(meta.stepKey)}" title="回到 ${esc(meta.taskTitle)} 的步骤 ${String(meta.stepNo??'').padStart(2,'0')} ${esc(meta.stepName)}">定位到步骤</button>`:'';
 // title 逐条列出引用登记（需求 › 步骤），多重引用一目了然；\n 在属性值里原样换行
 const titleParts=[f.path,...refs.map(r=>`${r.meta.taskTitle} › ${String(r.meta.stepNo??'').padStart(2,'0')} ${r.meta.stepName}${r.meta.by?`（${r.meta.by}）`:''}`)];
 if(miss)titleParts.push('文件当前不可读');
 // F04：整行单击即预览（行上挂 data-open-file；行内导航类按钮由委托层闸门保护），「预览」按钮保留
 // F02：data-vkey 带上版本身份——同一路径版本分叉后点开抽屉不串版本
 return `<div class="library-file${miss?' miss':''}" data-open-file="${esc(f.path)}" data-vkey="${esc(ent.vk)}"${meta?` data-task-id="${esc(meta.taskId)}" data-step-key="${esc(meta.stepKey)}"`:''} title="${esc(titleParts.join('\n'))}">
  ${iconPNG(miss?'warning':'folder',24)}
  <span class="lf-main"><span class="lf-name">${esc(name)}</span><small class="lf-src">${esc(srcPath)}</small></span>
  <span class="lf-meta">${size}${executor}${typeTag}</span>
  <span class="lf-actions">${locate}<button type="button" class="lf-preview" data-open-file="${esc(f.path)}" data-vkey="${esc(ent.vk)}"${meta?` data-task-id="${esc(meta.taskId)}" data-step-key="${esc(meta.stepKey)}"`:''}>预览</button></span>
 </div>`;
}
// R9：筛选器选项的真实取值集合（从数据里长出来，不写死枚举冒充元数据）
function fileFilterOptions(vals, cur, allLabel){
 let h=`<option value="all"${cur==='all'?' selected':''}>${allLabel}</option>`;
 for(const v of [...new Set(vals.map(String))].sort())h+=`<option value="${esc(v)}"${v===cur?' selected':''}>${esc(v)}</option>`;
 return h;
}
function renderFiles(){
 // TASK-R4（评审 #1）/ TASK-R5（评审 #1）：三态——未读到 / 全部读取失败 / 真实数据。
 // 部分失败时计数只统计读到的任务，尾注说明另有多少项没统计进来，不冒充完整。
 if(!lastFlow){
  const failed=modErr.flow&&!modOkAt.flow;
  document.getElementById('file-count').textContent='— 个产物';
  document.getElementById('file-toolbar').hidden=true;
  document.getElementById('file-groups').innerHTML=`<div class="empty"><img src="assets/empty-files.png" alt="" width="160"><p>${failed?'需求流水线读取失败，文件清单暂不可用。<br>原因见顶部横幅。':'需求流水线读取中…<br>文件清单等首轮同步完成。'}</p></div>`;
  return;
 }
 const tasks=lastFlow.tasks||[],ferrs=lastFlow.errors||[];
 if(!tasks.length&&ferrs.length){
  document.getElementById('file-count').textContent='— 个产物';
  document.getElementById('file-toolbar').hidden=true;
  document.getElementById('file-groups').innerHTML=`<div class="empty"><img src="assets/empty-files.png" alt="" width="160"><p>${ferrs.length} 项需求档案全部读取失败，文件清单暂不可用。<br>原因见顶部横幅，可点「重试读取」。</p></div>`;
  return;
 }
 // 展开全部步骤的文件，带上溯源元数据（需求 > 步骤 > 文件）
 // F02（R14 评审·R11 重复登记）：登记（引用）与物理实体分开建——ent = physKey×版本 的实体，
 // ent.refs 收齐同一实体的全部登记；entries 保持全量登记（计数口径），渲染行用实体。
 // \ 与 / 混写法、同 bytes 同 sha 的登记聚成一行；登记一条不删。
 const entries=[];
 // TASK-R11/F02/F03：路径 → 溯源登记索引（预览抽屉的执行者/来源类型/登记值/登记时间从这里取）
 fileMetaByPath.clear();
 fileRegsByPath.clear();
 fileEntitiesByPath.clear();
 for(const t of tasks){
  const ss=(t.steps||[]).slice().sort((a,b)=>(a.no??0)-(b.no??0));
  for(const s of ss) for(const f of dedupFiles(s.files||[])){
   const meta={taskId:t.id,taskTitle:t.title,stepKey:s.key,stepNo:s.no,stepName:s.name,by:s.by||'',at:s.at||null,updatedAt:t.updatedAt||0};
   const pk=physKey(f.path), vk=versionKeyOf(f);
   let entMap=fileEntitiesByPath.get(pk);
   if(!entMap){entMap=new Map();fileEntitiesByPath.set(pk,entMap);}
   let ent=entMap.get(vk);
   if(!ent){ent={pk,vk,refs:[]};entMap.set(vk,ent);}
   const reg={meta:{...meta},f};
   reg.ent=ent;ent.refs.push(reg);   // 双向挂接：登记指回实体，实体收齐引用
   entries.push(reg);
   const np=normPath(f.path);
   if(!fileMetaByPath.has(np))fileMetaByPath.set(np,{...meta,f});
   let regList=fileRegsByPath.get(pk);
   if(!regList){regList=[];fileRegsByPath.set(pk,regList);}
   regList.push(reg); // 包装形状 {meta,f}：resolveFileReg/renderFvDetail 按 reg.meta/reg.f 取
  }
 }
 // F02：只有登记大小、没有 sha 的版本（b:N），若同一路径恰有 sha 版本登记同样字节数 → 同一内容，
 // 引用并入 sha 实体（bytes 相同只是弱判据，并入只影响展示聚合，不动任何登记数据）
 for(const entMap of fileEntitiesByPath.values()){
  const shaEnts=[...entMap.values()].filter(e=>e.vk.startsWith('sha:'));
  for(const e of [...entMap.values()]){
   if(!e.vk.startsWith('b:'))continue;
   const b=Number(e.vk.slice(2));
   const host=shaEnts.find(h=>h.refs[0]&&h.refs[0].f.bytes===b);
   if(host&&host!==e){
    for(const r of e.refs){r.ent=host;host.refs.push(r);}
    e.refs=[];e.dead=true;entMap.delete(e.vk);
   }
  }
 }
 const ents=[...fileEntitiesByPath.values()].flatMap(m=>[...m.values()]).filter(e=>!e.dead);   // 渲染用实体全集
 // 工具栏：筛选下拉的选项来自真实数据；只看有产物默认开（空需求折叠成 52px 提示行）
 const tb=document.getElementById('file-toolbar');
 tb.hidden=false;
 const setOpt=(id,vals,allLabel,cur)=>{document.getElementById(id).innerHTML=fileFilterOptions(vals,cur||'all',allLabel);};
 setOpt('file-task',tasks.map(t=>t.title),'全部需求',fileTask);
 setOpt('file-step',[...new Set(ents.flatMap(e=>e.refs.map(r=>r.meta.stepName)))].filter(Boolean),'全部步骤',fileStep);
 setOpt('file-type',ents.map(e=>(normPath(e.refs[0].f.path).split('/').pop().split('.').pop()||'无扩展名').toLowerCase()),'全部类型',fileType);
 setOpt('file-agent',ents.flatMap(e=>e.refs.map(r=>r.meta.by)).filter(Boolean),'全部Agent',fileAgent);
 document.getElementById('file-search').value=fileQuery;
 document.getElementById('file-sort').value=fileSort;
 document.getElementById('file-only-toggle').checked=fileOnlyWith;
 // 过滤 + 排序（recent = 需求最近更新优先）——F02：按实体筛，任一引用命中即命中；
 // 排序在原键之后补版本键 tiebreak，同一路径的两个版本行稳定相邻
 const q=fileQuery.trim().toLowerCase();
 let shown=ents.filter(e=>{
  const f=e.refs[0].f;
  if(q&&!(normPath(f.path).toLowerCase().includes(q)||normPath(f.path).split('/').pop().toLowerCase().includes(q)))return false;
  if(fileTask!=='all'){const t=tasks.find(x=>x.title===fileTask);if(!t||!e.refs.some(r=>r.meta.taskId===t.id))return false;}
  if(fileStep!=='all'&&!e.refs.some(r=>r.meta.stepName===fileStep))return false;
  if(fileType!=='all'&&(normPath(f.path).split('/').pop().split('.').pop()||'无扩展名').toLowerCase()!==fileType)return false;
  if(fileAgent!=='all'&&!e.refs.some(r=>r.meta.by===fileAgent))return false;
  return true;
 });
 if(fileSort==='name')shown.sort((a,b)=>normPath(a.refs[0].f.path).split('/').pop().localeCompare(normPath(b.refs[0].f.path).split('/').pop(),'zh')||(a.vk<b.vk?-1:1));
 else if(fileSort==='demand')shown.sort((a,b)=>a.refs[0].meta.taskId.localeCompare(b.refs[0].meta.taskId)||String(a.refs[0].meta.stepNo??0).localeCompare(String(b.refs[0].meta.stepNo??0))||(a.vk<b.vk?-1:1));
 else shown.sort((a,b)=>Math.max(...b.refs.map(r=>r.meta.updatedAt||0))-Math.max(...a.refs.map(r=>r.meta.updatedAt||0)));
 const total=ents.length;
 const filtered=shown.length;
 const totalRegs=entries.length;   // 原始登记条数——实体聚合只影响展示，不减少登记
 document.getElementById('file-count').textContent=ferrs.length
  ?`匹配 ${filtered} / ${total} 个产物${totalRegs>total?`（${totalRegs} 条登记）`:''} · 另有 ${ferrs.length} 项需求读取失败未统计`
  :`匹配 ${filtered} / ${total} 个产物${totalRegs>total?`（${totalRegs} 条登记）`:''}`;
 // 分组渲染：只看有产物（默认开）时空需求折叠成 52px 行；被筛掉的组如实计数
 // F02：被多个需求引用的实体在每个引用组里各出现一行；组计数 = 实体数，登记条数另注
 const byTask=new Map(tasks.map(t=>[t.id,{t,rows:[]}]));
 for(const e of shown){
  const seen=new Set();
  for(const r of e.refs){if(seen.has(r.meta.taskId))continue;seen.add(r.meta.taskId);const g=byTask.get(r.meta.taskId);if(g)g.rows.push(e);}
 }
 const groups=[...byTask.values()];
 const hasFilter=q||fileTask!=='all'||fileStep!=='all'||fileType!=='all'||fileAgent!=='all';
 const html=groups.map(({t,rows})=>{
  const all=ents.filter(e=>e.refs.some(r=>r.meta.taskId===t.id)).length;
  if(!all){
   // 「只看有产物」开（默认）：空需求整组不占位；关：折叠成 52px 提示行，给一条
   // 跳回当前步骤的直达链接（跳过去干什么：看这需求到底走到哪一步了）
   if(fileOnlyWith||hasFilter)return '';
   const cur=(t.steps||[]).find(s=>['awaiting','running','failed'].includes(s.status))||(t.steps||[])[0];
   return `<div class="filegroup-flat" data-group="${esc(t.id)}"><span class="ff-title">${esc(t.title)}</span>${cur?`<button type="button" class="ff-link" data-goto="${esc(t.id)}|${esc(cur.key)}">暂无登记产物 · 查看该需求的当前步骤</button>`:'<span class="ff-note">暂无登记产物</span>'}</div>`;
  }
  const allRegs=entries.filter(r=>r.meta.taskId===t.id).length;
  const inner=rows.map(e=>fileButton(e,t.id)).join('')
    ||`<div class="ff-none">这组文件被当前筛选条件排除 <button type="button" class="lf-locate" data-clear-file-filters="1">清除筛选</button></div>`;
  return `<details class="filegroup" data-group="${esc(t.id)}" open><summary>${esc(t.title)} · ${rows.length}${rows.length!==all?`/${all}`:''} 个产物${allRegs>all?`（${allRegs} 条登记）`:''}</summary>${inner}</details>`;
 }).join('');
 // TASK-R3：缓存 key 必须带上核实版本 fileStatusVersion——
 // 只看 tasks 的话，重核出「文件不存在/字节变了」时任务数据没变，红标永远刷不进来。
 // TASK-R5：再加 ferrs.length；R9 再加全部筛选状态。
 renderChanged('file-groups',[tasks,fileStatusVersion,ferrs.length,fileQuery,fileTask,fileStep,fileType,fileAgent,fileSort,fileOnlyWith],()=>{
  const box=document.getElementById('file-groups');
  const states=new Map([...box.querySelectorAll('details')].map(e=>[e.dataset.group,e.open]));   // 换 DOM 前记下折叠态
  box.innerHTML=html||`<div class="empty"><img src="assets/empty-search.png" alt="" width="160"><p>没有匹配文件</p><button type="button" class="btn btn-secondary" data-clear-file-filters="1">清除筛选</button></div>`;
  for(const d of box.querySelectorAll('details')){if(states.get(d.dataset.group)===false)d.open=false;}   // 用户手动折叠的组不弹开
 });
}
// 筛选状态变更：写回模块变量（不是新建对象）→ 落 office.ui.v2 → 重渲染
function bindFileToolbar(){
 const on=(id,ev,fn)=>document.getElementById(id).addEventListener(ev,fn);
 on('file-search','input',e=>{fileQuery=e.target.value;saveUiPos();renderFiles();});
 on('file-task','change',e=>{fileTask=e.target.value;saveUiPos();renderFiles();});
 on('file-step','change',e=>{fileStep=e.target.value;saveUiPos();renderFiles();});
 on('file-type','change',e=>{fileType=e.target.value;saveUiPos();renderFiles();});
 on('file-agent','change',e=>{fileAgent=e.target.value;saveUiPos();renderFiles();});
 on('file-sort','change',e=>{fileSort=e.target.value;saveUiPos();renderFiles();});
 on('file-only-toggle','change',e=>{fileOnlyWith=e.target.checked;saveUiPos();renderFiles();});
}
bindFileToolbar();
function renderModules(){
 if(activePage==='agents')withScroll(document.getElementById('page-agents'),renderAgents);
 if(activePage==='skills')renderSkills();
 if(activePage==='files')withScroll(document.getElementById('page-files'),renderFiles);
}
document.addEventListener('click',e=>{
 const b=e.target.closest('button');if(!b)return;
 const routes={'rail-reqs':'/','rail-agents':'/agents','rail-skills':'/skills','rail-files':'/files'};
 if(routes[b.id]){location.hash=routes[b.id];return}
 if(b.dataset.agent){agentUI.selId=agentUI.selId===b.dataset.agent?null:b.dataset.agent;renderAgents()}
 if(b.dataset.page&&!b.disabled){skillPage+=Number(b.dataset.page);skillScroll=0;renderSkills();document.getElementById('skill-list').scrollTop=0;saveUiPos()}
 if(b.dataset.skill){skillSelected=b.dataset.skill;renderSkills()}
 // TASK-R11/S02：第一级「用途」筛选（skillCat）与第二级「来源」筛选（skillFilter）分开存、分开清页码
 if(b.dataset.cat){skillCat=b.dataset.cat;skillPage=0;skillSelected=null;skillScroll=0;renderSkills();document.getElementById('skill-list').scrollTop=0;saveUiPos()}
 if(b.dataset.filter){skillFilter=b.dataset.filter;skillPage=0;skillSelected=null;skillScroll=0;renderSkills();document.getElementById('skill-list').scrollTop=0;saveUiPos()}
 if(b.hasAttribute('data-close-skill')){skillSelected=null;renderSkills()}
 if(b.hasAttribute('data-close-picker')||b.dataset.openFile)document.getElementById('step-files').close();
 // R9：清空文件页全部筛选（空状态/被筛掉的组里给的一键出口）
 if(b.hasAttribute('data-clear-file-filters')){fileQuery='';fileTask='all';fileStep='all';fileType='all';fileAgent='all';fileSort='recent';saveUiPos();renderFiles();}
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
for(const [id,name] of Object.entries({'rail-reqs':'board','rail-agents':'agents','rail-skills':'skills','rail-files':'folder','rail-focus':'focus','tb-search':'search','tb-settings':'settings','tb-reqs-toggle':'board','tb-insp-toggle':'chevron'})){
 const el=document.getElementById(id);el.querySelector('svg,img')?.remove();el.insertAdjacentHTML('afterbegin',iconPNG(name, el.classList.contains('rail-item')?20:18));
}
route();

/* ================= 启动 ================= */
/* 启动：读回降噪 / 轮询开关 / 上次工作位置，再按用户意愿开轮询 */
try { applyQuiet(localStorage.getItem('office.quiet') === '1'); } catch { applyQuiet(false); }
try { userPaused = localStorage.getItem('office.poll') === 'paused'; } catch { userPaused = false; }
if (userPaused) {
  document.getElementById('sp-poll').textContent = '关';
  document.getElementById('sp-poll-btn').textContent = '恢复';
}
// TASK-R6（评审 #4）：刷新前留下的待确认操作与最近结果从存档接回——
// 待确认集合非空就直接开专属回查循环，与页面轮询无关（用户可能暂停着轮询刷新进来）。
restoreOpResults();
restorePendingOps();
restoreNotes();   // TASK-R7（评审 #6）：刷新前留下的备注草稿从存档接回，面板恢复时标注「草稿已留存」
if (pendingOps.size) ensureReconcileLoop();
tick().then(() => {
  // TASK-R4（评审 #5）：位置恢复/落盘已挪进 tick——只在 flow 首次成功那一拍执行
  // （见 completeUiPosRestore）。这里不再无条件恢复+归档：首轮 flow 失败时那会拿
  // 空选择覆盖存档。此处只补一次渲染（tick 内部已渲染过，重复无害）。
  renderAll();
});
if (!userPaused) startPolling();
