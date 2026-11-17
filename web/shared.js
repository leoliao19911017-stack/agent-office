'use strict';

/* ================= shared.js — 共享工具（G02 拆分自 app.js M1） =================
   纯函数 + 请求封装 + 语义映射，零业务状态（offline/snapshot 是仅有的两个常量快照）。
   index.html 在 app.js 之前按 shared → version → approval → files 顺序加载；
   普通多 <script> 全局共享（file:// 下 ES modules 不可用），无跨文件闭包。
   状态归属：本文件不声明任何可变状态；数据快照与轮询仍在 app.js M2。 */

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
    if (isNaN(d.getTime())) return '—';
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

// G02：innerHTML 重建但容器不动：显式保住滚动位置（三栏各自滚）
function withScroll(el, fn) {
  if (!el) { fn(); return; }
  const top = el.scrollTop;
  fn();
  el.scrollTop = top;
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
async function api(path, opts, timeoutMs = 12000) {
  if (offline) {
    if (opts?.method && opts.method !== 'GET') throw new Error('离线快照不能执行操作，请通过本地服务打开');
    const data={'/api/state':snapshot.state,'/api/office/flow':snapshot.flow,'/api/office/skills':snapshot.skills,'/api/health':{autoloop:false}};
    if (path in data) return data[path];
    throw new Error('离线模式不支持此操作');
  }
  // 前端兜底超时（TASK-R3）：服务端转发中台 8s 超时，这里 12s 收口，
  // 不让一个挂死的请求把 3 秒一轮的轮询摞起来。
  // G06：首轮初始化请求由调用方传 8000ms——启动失败要尽快见到明确的失败态。
  const res = await fetch(path, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  let body = null;
  let jsonOk = true;
  try { body = await res.json(); } catch { jsonOk = false; }
  if (!res.ok) {
    const msg = body && body.error ? body.error : 'HTTP ' + res.status;
    // TASK-R5（评审 #3）：HTTP 4xx/5xx 是服务端明确给出的结论（确定失败）；
    // 网络层失败（fetch TypeError / 超时中断）结果不确定——请求可能已到服务端并写入。
    // 两类错误后续处置完全不同，必须可区分。
    const err = new Error(msg);
    err.isHttpError = true;
    throw err;
  }
  // G06：2xx 但响应体不是有效 JSON（或为空）= 数据获取失败，不再当「成功读到 null」。
  // 之前 body=null 会顺着 fulfilled 一路灌进 lastState/hermesData，把接口坏掉伪装成空数据。
  if (!jsonOk || body == null) {
    const err = new Error(!jsonOk ? '响应不是有效 JSON' : '响应体为空');
    err.isDataError = true;
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
