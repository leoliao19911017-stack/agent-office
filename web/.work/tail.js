<script>
'use strict';

// 页面 JS 异常计数（验收口径：window.__uiErrors === 0）
window.__uiErrors = 0;
window.addEventListener('error', () => { window.__uiErrors++; });

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

const offline = location.protocol === 'file:';
const snapshot = offline ? JSON.parse(document.getElementById('offline-snapshot').textContent) : null;
async function api(path, opts) {
  if (offline) {
    if (opts?.method && opts.method !== 'GET') throw new Error('离线快照不能执行操作，请通过本地服务打开');
    const data={'/api/state':snapshot.state,'/api/office/flow':snapshot.flow,'/api/office/skills':snapshot.skills,'/api/health':{autoloop:false}};
    if (path in data) return data[path];
    throw new Error('离线模式不支持此操作');
  }
  const res = await fetch(path, opts);
  let body = null;
  try { body = await res.json(); } catch { /* 空体 */ }
  if (!res.ok) {
    const msg = body && body.error ? body.error : 'HTTP ' + res.status;
    throw new Error(msg);
  }
  return body;
}

// 路径归一：flow 数据里同一路径混用 \ 和 / 两种分隔符，归一后才能去重与比对
function normPath(p) { return String(p ?? '').replace(/\\/g, '/'); }

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

// 步骤状态 → 中文标签（卡片/Inspector 同源）
const STEP_LABEL = { done: '完成', running: '进行中', awaiting: '待拍板', pending: '等待', skipped: '已跳过', failed: '失败' };

// 待决策判定（任务书口径）：awaiting，或 gate 步骤停在 pending
function isAwaiting(step) {
  return step.status === 'awaiting' || (step.gate === true && step.status === 'pending');
}

// 需求整体状态：待拍板 > 已交付 > 进行中 > 排队
function taskStatus(t) {
  const steps = t.steps || [];
  if (steps.some(isAwaiting)) return 'awaiting';
  if ((t.total || 0) > 0 && (t.done || 0) >= t.total) return 'delivered';
  if ((t.done || 0) === 0 && !steps.some((s) => s.status === 'running')) return 'queued';
  return 'active';
}
const TASK_STATUS_LABEL = { active: '进行中', awaiting: '待拍板', queued: '排队', delivered: '已交付' };

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

function currentTask() {
  if (!lastFlow) return null;
  return (lastFlow.tasks || []).find((t) => t.id === ui.taskId) || null;
}

// 数据刷新后校准选中项：任务没了就退回第一个，步骤没了就清空
function ensureSelection() {
  const tasks = (lastFlow && lastFlow.tasks) || [];
  if (!tasks.length) { ui.taskId = null; ui.stepKey = null; return; }
  if (!tasks.some((t) => t.id === ui.taskId)) {
    ui.taskId = tasks[0].id;
    ui.stepKey = null;
  }
  const t = currentTask();
  if (t && ui.stepKey != null && !t.steps.some((s) => s.key === ui.stepKey)) {
    ui.stepKey = null;
  }
}

/* ================= 轮询 ================= */

async function tick() {
  const [sR, hR, fR, kR, mR] = await Promise.allSettled([
    api('/api/state'),
    api('/api/health'),
    api('/api/office/flow'),
    api('/api/office/skills'),
    api('/api/office/hermes'),
  ]);
  hubOnline = hR.status === 'fulfilled' && hR.value && hR.value.autoloop === true;
  if (sR.status === 'fulfilled') { lastState = sR.value; lastSyncAt = Date.now(); }
  if (mR.status === 'fulfilled' && mR.value && !mR.value.error) hermesData = mR.value;
  if (fR.status === 'fulfilled' && fR.value) {
    lastFlow = fR.value;
    ensureSelection();
    scheduleFileCheck();   // 异步，不挡渲染
  }
  if(kR.status==='fulfilled') skillsData=kR.value.skills || [];
  renderAll();

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

async function scheduleFileCheck() {
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
  if (key === fileCheckKey) return;
  fileCheckKey = key;
  try {
    const d = await api('/api/office/file-check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: arr }),
    });
    fileStatus = new Map((d.results || []).map((r) => [normPath(r.path), r]));
    withScroll(document.getElementById('insp-body'), renderInspector);   // 红标只影响 Inspector
  } catch {
    fileCheckKey = '';   // 失败了下轮重试；期间按「未核实」渲染（不标红也不标绿）
    fileStatus = new Map();
  }
}

// 同一步里同一路径常以 \ 和 / 两种写法登记两次，按归一路径去重
function dedupFiles(files) {
  const seen = new Set();
  const out = [];
  for (const f of files || []) {
    const np = normPath(f.path);
    if (!np || seen.has(np)) continue;
    seen.add(np);
    out.push(f);
  }
  return out;
}

/* ================= 渲染 ================= */

// innerHTML 重建但容器不动：显式保住滚动位置（三栏各自滚）
function withScroll(el, fn) {
  if (!el) { fn(); return; }
  const top = el.scrollTop;
  fn();
  el.scrollTop = top;
}

function renderAll() {
  renderTopbar();
  renderStatusbar();
  withScroll(document.getElementById('reqs-list'), renderReqList);
  withScroll(document.getElementById('center'), renderCenter);
  withScroll(document.getElementById('insp-body'), renderInspector);
  renderModules();
}

/* ---- 顶栏 ---- */
function renderTopbar() {
  const t = currentTask();
  document.getElementById('tb-task').textContent = t ? t.title : '—';

  // 待决策琥珀胶囊：0 个完全隐藏
  const pill = document.getElementById('tb-decision');
  let n = 0;
  for (const tk of (lastFlow ? lastFlow.tasks : [])) {
    n += (tk.steps || []).filter(isAwaiting).length;
  }
  if (n > 0) {
    pill.hidden = false;
    pill.innerHTML = `⏸ <b>${n}</b> 待决策`;
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
  if (hubOnline === true) { conn.classList.remove('off'); connText.textContent = '连接正常'; }
  else if (hubOnline === false) { conn.classList.add('off'); connText.textContent = offline ? '离线快照 · '+fmtTime(snapshot.state.now) : '连接断开'; }
  else { conn.classList.remove('off'); connText.textContent = '连接中…'; }

  const agents = (lastState && lastState.agents) || [];
  const now = lastState ? (Date.parse(lastState.now) || Date.now()) : Date.now();
  let running = 0, idle = 0;
  for (const a of agents) {
    const w = workOf(a.totals);
    if (w === 'running' || w === 'retrying') running++;
    else if (w === 'idle' && connectionOf(a, now) !== 'offline') idle++;
  }
  document.getElementById('sb-agents').textContent = `${agents.length} Agents`;
  document.getElementById('sb-running').textContent = `${running} 执行中`;
  document.getElementById('sb-idle').textContent = `${idle} 空闲`;
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
  document.getElementById('reqs-count').textContent = tasks.length;

  const q = ui.search.trim().toLowerCase();
  const shown = q ? tasks.filter((t) => (t.title || '').toLowerCase().includes(q) || (t.id || '').toLowerCase().includes(q)) : tasks;

  if (!tasks.length) {
    list.innerHTML = '<div class="empty"><img src="assets/empty-data.png" alt="" width="160"><p>还没有需求进来。<br>把需求告诉 Hermes，它会在这里建档。</p></div>';
    return;
  }
  if (!shown.length) {
    list.innerHTML = `<div class="empty"><img src="assets/empty-search.png" alt="" width="160"><p>没有匹配「${esc(ui.search)}」的需求</p></div>`;
    return;
  }
  list.innerHTML = shown.map((t) => {
    const st = taskStatus(t);
    const pct = (t.total || 0) > 0 ? Math.round((t.done || 0) / t.total * 100) : 0;
    const stage = currentStageText(t);
    return `<button type="button" class="req-item s-${st}${t.id === ui.taskId ? ' sel' : ''}" data-task="${esc(t.id)}">
      <span class="req-name" title="${esc(t.title)}">${esc(t.title)}</span>
      <span class="req-line2">
        <span class="req-status t-${st}"><i class="dot"></i>${TASK_STATUS_LABEL[st]}</span>
        <span class="req-stage" title="${esc(stage)}">${esc(stage)}</span>
      </span>
      <span class="req-prog">已完成 ${t.done ?? 0}/${t.total ?? 0}</span>
      <span class="req-bar"><i style="width:${pct}%"></i></span>
    </button>`;
  }).join('');
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
    box.innerHTML = '<div class="empty"><img src="assets/empty-data.png" alt="" width="160"><p>没有需求数据。<br>等中台恢复后会自动填上。</p></div>';
    return;
  }
  const phases = phasesOf(t);
  const curIdx = currentPhaseIdx(t);
  const st = taskStatus(t);
  const pct = (t.total || 0) > 0 ? Math.round((t.done || 0) / t.total * 100) : 0;
  const curP = PHASES[curIdx];

  const phaseHtml = phases.map((p) => {
    const total = p.steps.length;
    const done = p.steps.filter((s) => s.status === 'done').length;
    const run = p.steps.filter((s) => s.status === 'running').length;
    const wait = p.steps.filter(isAwaiting).length;
    const fin = total > 0 && done === total;
    const parts = [`已完成 ${done}/${total}`];
    if (run > 0) parts.push(`<span class="c-run">进行中 ${run}</span>`);
    if (wait > 0) parts.push(`<span class="c-wait">待拍板 ${wait}</span>`);
    return `<div class="phase${p.no - 1 === curIdx ? ' cur' : ''}${fin ? ' fin' : ''}">
      <span class="p-name">0${p.no} ${p.name}</span>
      <span class="p-count">${parts.join(' · ')}</span>
    </div>`;
  }).join('');

  // 步骤卡按阶段成列：一阶段一列，列内上下堆叠（不搞 1/3/5/7 错位排）
  const colsHtml = phases.map((p) => {
    const cards = p.steps.map(stepCardHtml).join('');
    return `<div class="col">${cards || '<div class="req-empty">（无步骤）</div>'}</div>`;
  }).join('');

  box.innerHTML = `
    <div class="ch-head">
      <div class="ch-title-row">
        <span class="ch-id">${esc(t.id)}</span>
        <h2>${esc(t.title)}</h2>
        <span class="st st-${esc(st)}">${TASK_STATUS_LABEL[st]}</span>
      </div>
      <div class="ch-meta">已完成 ${t.done ?? 0}/${t.total ?? 0} · 当前 0${curP.no} ${curP.name}${t.updatedAt ? ' · 更新 ' + esc(fmtTime(t.updatedAt)) : ''}</div>
      <div class="ch-bar"><i style="width:${pct}%"></i></div>
    </div>
    <div class="phases">${phaseHtml}</div>
    <div class="cols">${colsHtml}</div>`;
}

// 步骤卡只放四件事：序号+名称 / 状态 / 执行者 / 产物数量
function stepCardHtml(s) {
  const st = s.status || 'pending', files = dedupFiles(s.files || []);
  return `<article class="step-card st-${esc(st)}${s.key === ui.stepKey ? ' sel' : ''}${files.length ? ' has-files' : ''}" data-step="${esc(s.key)}" data-task="${esc(ui.taskId)}" tabindex="0" aria-label="${esc(s.name)}详情">
    <span class="sc-row1"><span class="sc-title"><span class="step-number">${String(s.no ?? '').padStart(2,'0')}</span> · ${esc(s.name)}</span><span class="st st-${esc(st)}">${esc(STEP_LABEL[st] || st)}</span></span>
    <span class="sc-row2"><span class="sc-by">${esc(s.by || '—')}</span><button class="file-pill" data-open-step-files="${esc(s.key)}" ${files.length ? '' : 'disabled title="这一步没有登记产物"'}>${files.length} 个产物</button></span>
  </article>`;
}

/* ---- 中：全部需求概览（一行一个需求，点行回到交付链） ---- */
function renderOverview() {
  const box = document.getElementById('center-overview');
  const tasks = (lastFlow && lastFlow.tasks) || [];
  if (!tasks.length) {
    box.innerHTML = '<div class="empty"><img src="assets/empty-data.png" alt="" width="160"><p>还没有需求进来。</p></div>';
    return;
  }
  const rows = tasks.map((t) => {
    const phases = phasesOf(t);
    const cells = phases.map((p) => {
      const total = p.steps.length;
      const done = p.steps.filter((s) => s.status === 'done').length;
      const run = p.steps.filter((s) => s.status === 'running').length;
      const wait = p.steps.filter(isAwaiting).length;
      let cls = 'k-idle', txt = `${done}/${total}`;
      if (wait > 0) { cls = 'k-wait'; txt = `⏸ ${done}/${total}`; }
      else if (run > 0) { cls = 'k-run'; txt = `${done}/${total}`; }
      else if (total > 0 && done === total) { cls = 'k-done'; txt = `✓ ${done}/${total}`; }
      return `<td class="ov-cell ${cls}">${txt}</td>`;
    }).join('');
    const block = (t.steps || []).find(isAwaiting);
    const stage = currentStageText(t);
    return `<tr class="ov-row${t.id === ui.taskId ? ' sel' : ''}" data-task="${esc(t.id)}">
      <td><b>${esc(t.title)}</b><div class="ch-id" style="margin-top:2px">${esc(t.id)}</div></td>
      ${cells}
      <td class="ov-cell">已完成 ${t.done ?? 0}/${t.total ?? 0}</td>
      <td>${block ? `<span class="ov-block">⏸ ${esc(block.name)}</span>` : '<span class="ov-noblock">无</span>'}</td>
      <td class="ov-cell">${esc(stage)}</td>
    </tr>`;
  }).join('');
  box.innerHTML = `<table class="ov-table">
    <thead><tr><th>需求</th><th>01 定义</th><th>02 生产</th><th>03 验证</th><th>04 交付</th><th>进度</th><th>当前阻塞</th><th>当前阶段</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/* ---- 右：Inspector ---- */
function renderInspector() {
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
  const st = s.status || 'pending';
  const label = STEP_LABEL[st] || st;

  const files = dedupFiles(s.files).map((f) => {
    const np = normPath(f.path);
    const chk = fileStatus.get(np);           // 服务端核实结果；undefined = 还没核实到
    const exists = chk ? chk.exists === true : null;
    const realBytes = chk && chk.exists ? chk.bytes : f.bytes;   // 存在用实测字节，不存在用登记字节
    const name = np.split('/').pop();
    if (exists === false) {
      // 登记了但文件不在了：标红 + 明说，不能因为接口返回了路径就当可打开
      return `<div class="ip-file miss" title="${esc(f.path)}">
        <i class="fm">✗</i><span class="fn">${esc(name)}</span>
        <span class="fb">${fmtBytes(realBytes)}</span><span class="ft">文件不存在</span>
      </div>`;
    }
    return `<div class="ip-file" data-open-file="${esc(f.path)}" title="${esc(f.path)} &#10;点击查看内容">
      <i class="fm" style="color:var(--ink-green)">${exists === true ? '✓' : '·'}</i>
      <span class="fn">${esc(name)}</span><span class="fb">${fmtBytes(realBytes)}</span>
    </div>`;
  }).join('');

  const prev = steps[idx - 1];
  const next = steps[idx + 1];
  const linkHtml = (step, arrow) => {
    if (!step) return `<div class="ip-link"><span class="arr">${arrow}</span><span class="ln ip-none">—</span></div>`;
    const ls = step.status || 'pending';
    const k = ls === 'done' ? 'k-done' : ls === 'awaiting' ? 'k-awaiting' : ls === 'running' ? 'k-running' : ls === 'failed' ? 'k-failed' : '';
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

      <div class="ip-sec"><h4>执行者</h4><div class="ip-v">${s.by ? esc(s.by) : '<span class="ip-none">—</span>'}</div></div>

      <div class="ip-sec"><h4>本步产物</h4>
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

/* ================= 交互 ================= */

// 选中需求：中央/右侧跟着换，滚动回顶部；步骤选择清空
function selectTask(id, opts = {}) {
  ui.taskId = id;
  ui.stepKey = null;
  if (!opts.keepView) ui.view = 'chain';
  renderAll();
  document.getElementById('center').scrollTop = 0;
  document.getElementById('insp-body').scrollTop = 0;
}

function selectStep(key) {
  ui.stepKey = key;
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
  if (el.classList.contains('step-card') && el.dataset.step) { selectStep(el.dataset.step); return; }

  switch (el.id) {
    case 'tb-decision': {
      location.hash='/';
      // 定位到第一个待决策步骤：选需求 → 选步骤 → Inspector 直接打开
      const tk = ((lastFlow && lastFlow.tasks) || []).find((t) => (t.steps || []).some(isAwaiting));
      if (!tk) return;
      ui.taskId = tk.id;
      ui.view = 'chain';
      ui.stepKey = (tk.steps.find(isAwaiting) || {}).key || null;
      renderAll();
      document.getElementById('center').scrollTop = 0;
      document.body.classList.add('insp-open');
      syncToggleStates();
      return;
    }
    case 'btn-overview':
      ui.view = ui.view === 'overview' ? 'chain' : 'overview';
      renderCenter();
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
      if (pollTimer != null) { stopPolling(); label.textContent = '关'; btn.textContent = '恢复'; }
      else { tick(); startPolling(); label.textContent = '开'; btn.textContent = '暂停'; }
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
searchInput.addEventListener('input', () => { ui.search = searchInput.value; renderReqList(); });
searchInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    searchInput.value = ''; ui.search = '';
    searchInput.hidden = true;
    document.getElementById('tb-search').classList.remove('on');
    renderReqList();
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

/* ================= 页面工具 ================= */
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

/* ================= 文件预览 ================= */
/* 点 Inspector 里的产物 → 拉 /api/office/file → 按类型渲染。
   Markdown 不做富文本渲染，直接显示原文——要"看真实内容"，不是"看美化后的成品"，
   原文更能暴露问题（比如文件其实是空的、或者写的是别的任务）。 */
async function openFileView(p) {
  const box = document.getElementById('file-view');
  const body = document.getElementById('fv-body');
  document.getElementById('fv-name').textContent = String(p).split(/[\\/]/).pop();
  document.getElementById('fv-meta').textContent = '';
  document.getElementById('fv-path').textContent = p;
  body.innerHTML = '<div class="fv-msg">读取中…</div>';
  box.classList.add('open');

  if (offline) {
    const file=snapshot.files[p];
    document.getElementById('fv-meta').textContent='离线快照';
    body.innerHTML=file?`<pre>${esc(file.text||file.note||'暂无可预览内容')}</pre>`:'<div class="fv-warn">离线快照没有收录此文件，请通过本地服务打开。</div>';
    return;
  }
  const ext = (String(p).match(/\.[^.\\/]+$/) || [''])[0].toLowerCase();
  // 图片直接走 img
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) {
    body.innerHTML = `<img src="/api/office/file?path=${encodeURIComponent(p)}" alt="">`;
    return;
  }

  try {
    const res = await fetch(`/api/office/file?path=${encodeURIComponent(p)}`);
    const d = await res.json();
    if (!res.ok || d.exists === false) {
      body.innerHTML = `<div class="fv-warn">${esc(d.error || ('HTTP ' + res.status))}</div>`;
      return;
    }
    document.getElementById('fv-meta').textContent =
      `${fmtBytes(d.bytes)}${d.modifiedAt ? ' · ' + fmtTime(d.modifiedAt) : ''}`;
    if (d.kind === 'binary') {
      body.innerHTML = `<div class="fv-msg">${esc(d.note || '二进制文件，不支持预览')}</div>`;
      return;
    }
    const warn = d.truncated
      ? `<div class="fv-warn">文件 ${fmtBytes(d.bytes)}，超过 2MB 只显示前 2MB</div>` : '';
    body.innerHTML = `${warn}<pre>${esc(d.text || '')}</pre>`;
  } catch (e) {
    body.innerHTML = `<div class="fv-warn">读取失败：${esc(e.message)}</div>`;
  }
}

function closeFileView() {
  document.getElementById('file-view').classList.remove('open');
  document.getElementById('fv-body').innerHTML = '';
}

// Inspector 里点产物行 / 点遮罩关闭
document.addEventListener('click', (e) => {
  const row = e.target.closest('[data-open-file]');
  if (row) { openFileView(row.getAttribute('data-open-file')); return; }
  if (e.target.id === 'file-view') closeFileView();
});
document.getElementById('fv-close').addEventListener('click', closeFileView);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('file-view').classList.contains('open')) {
    closeFileView();
  }
});

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

/* 页面切后台暂停轮询，切回来立刻刷一次 */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopPolling();
  else { tick(); startPolling(); }
});


/* TASK-10.1 油画风图标：米金色 PNG（assets/icons/，64×64 真透明）。
   加载失败时隐藏（onerror），不留破图。 */
const ICON_PNG = ['board','agents','skills','folder','focus','search','settings','close','chevron','check','warning','clock'];
function iconPNG(name, size = 18) {
  return `<img class="ic" src="assets/icons/icon-${name}.png" width="${size}" height="${size}" alt="" aria-hidden="true" decoding="async" onerror="this.hidden=true">`;
}
/* 启动预加载，避免切页 / 重渲染闪一下 */
for (const n of ICON_PNG) { const im = new Image(); im.src = `assets/icons/icon-${n}.png`; }
let skillsData=[],skillPage=0,skillQuery='',skillSelected=null,skillFilter='all',activePage='workbench';
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
}
window.addEventListener('hashchange',route);
function money(n){return n==null?'未统计':'$'+Number(n).toFixed(2)}
function agentDetail(a){
 const t=a.totals||{},u=t.usage||{};
 const runs=(lastState?.runs||[]).filter(r=>r.agent===a.id).slice(0,8);
 return `<div class="agent-detail"><h4>当前状态</h4><div class="agent-kv"><span>${a.online?'在线':'离线'} · ${agentBusy(a)?'工作中':'空闲'}</span><span>${t.retrying||0} 重试中</span></div><div class="agent-kv"><span>最近心跳</span><span>${esc(fmtAgo(a.seenAt))}</span></div><h4>累计工作量</h4><div class="agent-kv"><span>已完成 ${t.done||0}</span><span>${fmtNum((u.input||0)+(u.output||0))} tokens</span></div><h4>最近 8 条执行记录</h4>${runs.length?runs.map(r=>`<div class="agent-run"><span class="st st-${r.state==='done'?'done':r.state==='failed'?'failed':'running'}">${esc(({done:'完成',failed:'失败',running:'执行中',claimed:'已领取',retrying:'重试'})[r.state]||r.state)}</span> ${esc(r.rule||'—')}<p>${esc(r.summary||'暂无执行摘要')}</p></div>`).join(''):'<p class="agent-role">最近没有执行记录</p>'}</div>`;
}
function renderAgents(){
 // 平级架构：三个 Hermes（Lemate / Winter / Karina）各自是不同场景的需求入口，
 // 加上 Codex。只显示这四个真实存在的 Agent，其余（claude-readonly / image-gen /
 // gpt-drive / dsh）是过去为了凑调度角色注册的壳，不再展示，要用时再接。
 const hs=hermesData?.agents||[];
 const codex=(lastState?.agents||[]).find(a=>a.id==='codex');
 const cards=hs.map(h=>{
   const sel=h.id===agentUI.selId;
   const sceneCls={'Coding':'scene-code','视频剪辑':'scene-video','图文笔记':'scene-note'}[h.scene]||'';
   const st=h.state==='working'?'working':h.state==='idle'?'idle':'unknown';
   const stLabel={working:'执行中',idle:'空闲',unknown:'—'}[st];
   const mins=Math.round((h.heartbeatAgeMs||0)/60000);
   const hb=h.online?(mins<1?'刚刚':mins+' 分钟前'):'离线';
   return `<article class="agent-card ${sel?'selected':''}"><button class="agent-select" data-agent="${esc(h.id)}" aria-expanded="${sel}"><span class="agent-head"><span class="agent-badge ${sceneCls}">${esc(h.type)}</span><span><span class="agent-name">${esc(h.name)}</span><span class="agent-role">${esc(h.scene)}</span><span class="agent-online ${h.online?'':'agent-offline'}">● ${h.online?'在线':'离线'} · 心跳 ${esc(hb)}</span></span></span><span class="agent-stats"><span class="st-anim st-${st}"><b>${esc(stLabel)}</b>状态</span><span><b>${esc(h.activity||'—')}</b>活动</span></span><span class="agent-cost">${esc(h.task||'未接入上报')}</span></button>${sel?agentHermesDetail(h):''}</article>`;
 });
 if(codex){
   const t=codex.totals||{},sel=codex.id===agentUI.selId;
   const runs=(lastState?.runs||[]).filter(r=>r.agent==='codex').slice(0,6);
   cards.push(`<article class="agent-card ${sel?'selected':''}"><button class="agent-select" data-agent="codex" aria-expanded="${sel}"><span class="agent-head"><img class="agent-avatar" src="assets/agents/codex.png" alt="Codex"><span><span class="agent-name">Codex</span><span class="agent-role">生图 · 代码审查</span><span class="agent-online ${codex.online?'':'agent-offline'}">● ${codex.online?'在线':'离线'} · 心跳 ${esc(fmtAgo(codex.seenAt))}</span></span></span><span class="agent-stats"><span class="st-anim st-${agentBusy(codex)?'working':'idle'}"><b>${agentBusy(codex)?'执行中':'空闲'}</b>状态</span><span><b>${t.done||0}</b>累计完成</span></span><span class="agent-cost">${runs.length?esc(runs[0].rule||'最近一次 '+runs[0].state):'暂无执行记录'}</span></button>${sel?agentDetail(codex):''}</article>`);
 }
 document.getElementById('agent-summary').textContent=`${hs.filter(h=>h.online).length+ (codex&&codex.online?1:0)} 个在线 · ${hs.filter(h=>h.state==='working').length+(codex&&agentBusy(codex)?1:0)} 执行中`;
 renderChanged('agent-grid',[hs,codex,agentUI.selId],()=>{
  document.getElementById('agent-grid').innerHTML=cards.join('')||'<div class="empty"><img src="assets/empty-data.png" alt="" width="160"><p>尚未收到 Agent 数据</p></div>';
 });
}
function agentHermesDetail(h){
 const rows=[
  ['类型', h.type],['场景', h.scene],['连接', h.online?'在线':'离线'],
  ['心跳', h.online?Math.round((h.heartbeatAgeMs||0)/60000)+' 分钟前':'离线'],
  ['当前状态', {working:'执行中',idle:'空闲'}[h.state]||'未知'],
  ['当前任务', h.task||'—'],
  ['活动数', h.activity||'—'],
 ];
 return `<div class="agent-detail"><h4>实时状态</h4>${rows.map(([k,v])=>`<div class="agent-kv"><span>${k}</span><span>${esc(String(v))}</span></div>`).join('')}
 <p class="agent-role" style="margin-top:10px">平级入口之间不共享内部数据。这一行是 ${esc(h.name)} 自己上报的，不是外部探测的。</p></div>`;
}
function renderSkills(){
 const rows=skillsData.filter(s=>(skillFilter==='all'||(s.agents||[]).some(a=>a===skillFilter||a.startsWith(skillFilter+'-')))&&(s.name+' '+(s.description||'')).toLowerCase().includes(skillQuery.toLowerCase()));
 const pages=Math.max(1,Math.ceil(rows.length/20));skillPage=Math.max(0,Math.min(skillPage,pages-1));
 document.getElementById('skill-count').textContent=`${skillsData.length} 条技能 · ${rows.length} 条匹配`;
 renderChanged('skill-filters',skillFilter,()=>document.getElementById('skill-filters').innerHTML=['all','claude','codex','hermes'].map(a=>`<button class="${a===skillFilter?'selected':''}" data-filter="${a}" aria-pressed="${a===skillFilter}">${a==='all'?'全部':a}</button>`).join(''));
 renderChanged('skill-list',[rows,skillPage,skillSelected],()=>document.getElementById('skill-list').innerHTML=rows.slice(skillPage*20,skillPage*20+20).map(s=>`<button class="skill-row ${s.name===skillSelected?'selected':''}" data-skill="${esc(s.name)}"><b>${esc(s.name)}</b><small>${esc(s.description||'暂无描述')}</small></button>`).join('')||'<div class="empty"><img src="assets/empty-search.png" alt="" width="160"><p>没有找到匹配的技能，请尝试其他关键词或选择全部 Agent。</p></div>');
 document.getElementById('skill-pagination').innerHTML=`<button class="btn btn-secondary" data-page="-1" ${skillPage===0?'disabled':''}>上一页</button><span>第 ${skillPage+1} / ${pages} 页</span><button class="btn btn-secondary" data-page="1" ${skillPage===pages-1?'disabled':''}>下一页</button>`;
 const selected=rows.find(s=>s.name===skillSelected),detail=document.getElementById('skill-detail');
 detail.hidden=!selected;
 renderChanged('skill-detail',selected,()=>{detail.innerHTML=selected?`<button class="btn btn-ghost" data-close-skill aria-label="关闭技能详情">关闭 ${iconPNG('close',14)}</button><h3>${esc(selected.name)}</h3><h4>完整描述</h4><p>${esc(selected.description||'该技能尚未提供描述')}</p><h4>归属 Agent</h4><p>${esc((selected.agents||[]).join(' · ')||'未登记')}</p><h4>文件路径</h4><p class="skill-path">${esc(selected.path||((selected.dir||'')+'/SKILL.md'))}</p>`:''});
}
function fileButton(f){return `<button class="library-file" data-open-file="${esc(f.path)}" title="${esc(f.path)}">${iconPNG('folder',18)}<span>${esc(normPath(f.path).split('/').pop())}</span><small>${fmtBytes(f.bytes)}</small></button>`}
function renderFiles(){
 const tasks=lastFlow?.tasks||[];document.getElementById('file-count').textContent=tasks.reduce((n,t)=>n+dedupFiles((t.steps||[]).flatMap(s=>s.files||[])).length,0)+' 个产物 · 按需求归档';
 renderChanged('file-groups',tasks,()=>{const box=document.getElementById('file-groups'),states=new Map([...box.querySelectorAll('details')].map(e=>[e.dataset.group,e.open]));box.innerHTML=tasks.map(t=>{const files=dedupFiles((t.steps||[]).flatMap(s=>s.files||[]));return `<details class="filegroup" data-group="${esc(t.id)}" ${(states.get(t.id)??true)?'open':''}><summary>${esc(t.title)} · ${files.length} 个产物</summary>${files.map(fileButton).join('')||'<div class="empty"><img src="assets/empty-files.png" alt="" width="160"><p>这项需求还没有登记产物</p></div>'}</details>`}).join('')||'<div class="empty"><img src="assets/empty-files.png" alt="" width="160"><p>尚无需求产物</p></div>'});
}
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
 if(b.dataset.page&&!b.disabled){skillPage+=Number(b.dataset.page);renderSkills();document.getElementById('skill-list').scrollTop=0}
 if(b.dataset.skill){skillSelected=b.dataset.skill;renderSkills()}
 if(b.dataset.filter){skillFilter=b.dataset.filter;skillPage=0;skillSelected=null;renderSkills();document.getElementById('skill-list').scrollTop=0}
 if(b.hasAttribute('data-close-skill')){skillSelected=null;renderSkills()}
 if(b.hasAttribute('data-close-picker')||b.dataset.openFile)document.getElementById('step-files').close();
});
document.getElementById('skill-search').addEventListener('input',e=>{skillQuery=e.target.value;skillPage=0;skillSelected=null;renderSkills();document.getElementById('skill-list').scrollTop=0});
document.addEventListener('keydown',e=>{
 if(e.key==='Escape'){skillSelected=null;renderSkills()}
 if((e.key==='Enter'||e.key===' ')&&e.target.matches('.step-card')){e.preventDefault();selectStep(e.target.dataset.step)}
});
for(const [id,name] of Object.entries({'rail-reqs':'board','rail-agents':'agents','rail-skills':'skills','rail-files':'folder','rail-focus':'focus','tb-search':'search','tb-settings':'settings','tb-reqs-toggle':'board','tb-insp-toggle':'chevron'})){
 const el=document.getElementById(id);el.querySelector('svg,img')?.remove();el.insertAdjacentHTML('afterbegin',iconPNG(name, el.classList.contains('rail-item')?20:18));
}
route();

/* ================= 启动 ================= */
/* 启动：读回用户上次的降噪设置，再开始轮询 */
try { applyQuiet(localStorage.getItem('office.quiet') === '1'); } catch { applyQuiet(false); }
tick();
startPolling();
</script>
</body>
</html>
