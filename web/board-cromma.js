/* Soda Office · Agent 看板 V2
   真实数据源：GET /api/agents/status-v2、GET /api/tasks、GET /api/state；右列对话走 /api/chat/*（board-chat.js）
   状态口径：availability=false → 不可用；执行没有可信证据 → unknown，不兜底 idle。
   所有按钮都必须有真实行为；中央没有无数据支撑的装饰线。 */

/** 内置 Agent 的品牌 icon / 短名；名册与显示名以 /api/agents 为准，这里只做图标映射。 */
const AGENT_META = {
  claude: { name: 'Claude Code', short: 'CLAUDE', icon: 'claude' },
  codex: { name: 'Codex', short: 'CODEX', icon: 'codex' },
  dsh: { name: 'DSH', short: 'DSH', icon: 'dsh' },
  hermes: { name: 'Hermes', short: 'HERMES', icon: 'hermes' },
};
const AGENT_ORDER = ['claude', 'codex', 'dsh', 'hermes'];
const STATUS_LABEL = {
  running: '执行中', waiting: '待接力', idle: '空闲', completed: '已完成',
  blocked: '已阻塞', interrupted: '已中断', failed: '失败', unknown: '? 未知',
};
const FILTERS = {
  all: () => true,
  running: (t) => t.status === 'running',
  relay: (t) => t.relay_pending === true,
  risk: (t) => ['blocked', 'interrupted', 'failed'].includes(t.status),
  unknown: (t) => !t.status || t.status === 'unknown',
};

const state = {
  statusV2: null,
  tasksData: null,
  hubState: null,
  quotas: null,
  agents: null,
  loadError: null,
  quotasError: null,
  selectedAgentId: null,
  selectedTaskId: null,
  filter: 'all',
  route: 'board',
  loading: false,
  loadedAt: null,
  fetchLog: [],
  agentModal: { open: false, mode: 'add', kind: 'cli', test: null, busy: false, error: null },
};
const ICONS = {};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- 时间 / 数字 ---------- */
function relTime(iso, now = Date.now()) {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 5) return '刚刚';
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}
function shortNum(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  if (v >= 1e6) return `${(v / 1e6).toFixed(2).replace(/0$/, '')}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
  return String(v);
}
function fmtInt(n) { return n == null ? '—' : Number(n).toLocaleString('en-US'); }
function fmtUsd(n) { return n == null || !Number.isFinite(Number(n)) ? '—' : `$${Number(n).toFixed(2)}`; }
function pct(done, total) { return total > 0 ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : 0; }

/* ---------- 额度（percentage 是「已用」，不是剩余） ---------- */
function quotaTone(usedPct) {
  if (usedPct == null) return 'unknown';
  if (usedPct > 80) return 'bad';
  if (usedPct >= 50) return 'warn';
  return 'ok';
}
function fmtCountdown(iso, now = Date.now()) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const ms = t - now;
  if (ms <= 0) return '已到点';
  const minutes = Math.ceil(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
  return `${Math.floor(hours / 24)}d${hours % 24}h`;
}
function quotaWindowOf(p, unit) {
  return (p.windows || []).find((w) => Number(w.unit) === unit) || null;
}
function quotaWinCell(w, shortLabel) {
  const used = w && w.percentage != null ? Number(w.percentage) : null;
  const tone = quotaTone(used);
  const label = w ? w.label : (shortLabel === '5h' ? '5 小时' : '1 周');
  const title = w
    ? `${label}：已用 ${used == null ? '未知' : `${used}%`}${w.remaining != null ? ` · 剩余 ${fmtInt(w.remaining)}` : '（厂商只返回百分比）'}`
    : `${label}：厂商没有返回这个窗口`;
  return `<span class="quota-win" title="${esc(title)}">
    <i>${esc(shortLabel)}</i>
    <span class="quota-bar"><b data-tone="${tone}" style="width:${used == null ? 0 : used}%"></b></span>
    <em>${used == null ? '—' : `${used}%`}</em>
  </span>`;
}
function quotaProviderRow(p) {
  const w5 = quotaWindowOf(p, 3);
  const wk = quotaWindowOf(p, 6);
  const resetAt = (w5 && w5.resetAt) || (wk && wk.resetAt) || null;
  const useds = [w5, wk].filter(Boolean).map((w) => (w.percentage == null ? -1 : Number(w.percentage)));
  const worst = useds.length ? Math.max(...useds) : -1;
  const tone = quotaTone(worst < 0 ? null : worst);
  // 涛哥的 5h 窗口厂商没给 nextResetTime：退回周窗口倒计时，并标明「周」，不假装 5h 会重置。
  const resetPrefix = (w5 && w5.resetAt) ? '重置' : '周';
  const resetText = resetAt ? `${resetPrefix} ${fmtCountdown(resetAt)}` : '重置 —';
  const title = `${p.provider_name || p.name}${p.model ? ` · ${p.model}` : ''}${p.level ? ` · ${p.level}` : ''}${resetAt ? ` · ${resetPrefix === '周' ? '5h 窗口没有重置时间，这里显示周窗口重置' : '重置'} ${new Date(resetAt).toLocaleString('zh-CN', { hour12: false })}` : ' · 厂商没给重置时间'}`;
  return `<span class="quota-row" data-tone="${tone}" data-provider="${esc(p.id)}" title="${esc(title)}">
    <span class="quota-row__name">${esc(p.name)}</span>
    ${quotaWinCell(w5, '5h')}
    ${quotaWinCell(wk, '周')}
    <span class="quota-row__reset" data-reset-at="${esc(resetAt || '')}" data-reset-prefix="${esc(resetPrefix)}">${esc(resetText)}</span>
  </span>`;
}
function quotaErrorRow(p) {
  const msg = String(p.error || '接口没有返回数据');
  return `<span class="quota-row quota-row--error" data-provider="${esc(p.id)}" title="${esc(`${p.provider_name || p.name}：${msg}`)}">
    <span class="quota-row__name">${esc(p.name)}</span>
    <span class="quota-row__err">接口失败 · ${esc(msg.slice(0, 42))}</span>
  </span>`;
}
function apiBlock(a) {
  return `<span class="quota-block" aria-label="API 配置">
    <span class="quota-block__head"><i>API</i><span>${esc(a.protocol || '?')} · ${esc(a.model || '?')}</span></span>
    <span class="quota-note" title="${esc(a.base_url || '')}">${esc(a.base_url || '—')} · key 只存引用</span>
  </span>`;
}
function quotaBlock(agentId) {
  const cfg = typeof agentId === 'string' ? null : agentId;
  const id = cfg ? cfg.agent_id : agentId;
  if (cfg && cfg.kind === 'api') return apiBlock(cfg);
  if (id !== 'claude' && id !== 'codex') {
    return `<span class="quota-block quota-block--empty">
      <span class="quota-block__head"><i>额度</i><span>未接入</span></span>
      <span class="quota-note">没有该 Agent 的额度数据源，不编造。</span>
    </span>`;
  }
  if (!state.quotas) {
    return `<span class="quota-block quota-block--error">
      <span class="quota-block__head"><i>额度</i><span>读取失败</span></span>
      <span class="quota-note">${esc(state.quotasError || '还没读到 /api/quotas')}</span>
    </span>`;
  }
  const q = state.quotas;
  const cacheNote = q.cache ? `缓存 ${Math.max(0, Math.round((q.cache.age_ms || 0) / 1000))}s` : '5 分钟缓存';
  if (id === 'claude') {
    const providers = Array.isArray(q.providers) ? q.providers : [];
    if (!providers.length) {
      return `<span class="quota-block quota-block--error">
        <span class="quota-block__head"><i>额度 · 已用 %</i><span>GLM</span></span>
        <span class="quota-note">${esc((q.notes && q.notes[0]) || '没有读到 Zhipu provider')}</span>
      </span>`;
    }
    return `<span class="quota-block" aria-label="GLM 额度，百分比为已用">
      <span class="quota-block__head"><i>额度 · 已用 %</i><span>GLM ${providers.length} key · ${esc(cacheNote)}</span></span>
      ${providers.map((p) => (p.ok ? quotaProviderRow(p) : quotaErrorRow(p))).join('')}
    </span>`;
  }
  const c = q.codex;
  if (!c) {
    return `<span class="quota-block quota-block--error">
      <span class="quota-block__head"><i>已用 · 今日</i><span>Codex</span></span>
      <span class="quota-note">没有读到 Codex 用量。</span>
    </span>`;
  }
  const todayText = `${fmtUsd(c.used_usd)} / 今日 ${fmtInt(c.requests)} 次请求`;
  const latest = c.latest_date
    ? `rollup 最新 ${esc(c.latest_date)} · ${fmtUsd(c.latest_used_usd)} / ${fmtInt(c.latest_requests)} 次`
    : 'rollup 里没有 Codex 记录';
  return `<span class="quota-block" aria-label="Codex 已用量，无剩余额度接口">
    <span class="quota-block__head"><i>已用 · 今日</i><span>无剩余额度接口</span></span>
    <span class="quota-row quota-row--codex">
      <span class="quota-row__usd">${esc(todayText)}</span>
      <span class="quota-row__reset">${c.has_today ? '今日有记录' : '今日无记录'}</span>
    </span>
    <span class="quota-note">${esc(latest)} · OpenAI 官方不提供剩余额度查询</span>
  </span>`;
}

/* ---------- 数据层 ---------- */
async function getJson(path) {
  const started = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(path, { headers: { accept: 'application/json' }, cache: 'no-store', signal: ctrl.signal });
    const text = await res.text();
    state.fetchLog.push({ path, status: res.status, bytes: new Blob([text]).size, ms: Math.round(performance.now() - started), at: new Date().toISOString(), ok: res.ok });
    if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
    return JSON.parse(text);
  } finally { clearTimeout(timer); }
}

async function loadData() {
  if (state.loading) return;
  state.loading = true;
  state.fetchLog = [];
  const results = await Promise.allSettled([
    getJson('/api/agents/status-v2'),
    getJson('/api/tasks'),
    getJson('/api/state'),
    getJson('/api/quotas'),
    getJson('/api/agents?all=1'),
  ]);
  const failures = [];
  state.statusV2 = results[0].status === 'fulfilled' ? results[0].value : null;
  if (results[0].status === 'rejected') failures.push(`status-v2：${results[0].reason.message}`);
  state.tasksData = results[1].status === 'fulfilled' ? results[1].value : null;
  if (results[1].status === 'rejected') failures.push(`tasks：${results[1].reason.message}`);
  state.hubState = results[2].status === 'fulfilled' ? results[2].value : null;
  state.quotas = results[3].status === 'fulfilled' ? results[3].value : null;
  state.agents = results[4] && results[4].status === 'fulfilled' ? results[4].value : null;
  state.quotasError = results[3].status === 'rejected'
    ? results[3].reason.message
    : (state.quotas && state.quotas.ok === false ? '额度接口返回 ok=false' : null);
  // 额度失败不把整个看板标成「读取失败」：状态/任务仍可信，额度单独在卡片里报错。
  state.loadError = failures.length ? failures.join('；') : null;
  state.loadedAt = new Date().toISOString();
  state.loading = false;

  if (state.selectedTaskId && !tasksNow().some((t) => t.task_id === state.selectedTaskId)) state.selectedTaskId = null;
  ensureSelection();

  renderAll();
  if (window.AgentAdmin) window.AgentAdmin.refresh();
}

/* ---------- 派生数据 ---------- */
function agentsNow() {
  const rows = state.statusV2?.agents || [];
  return [...rows].sort((a, b) => {
    const sa = Number.isFinite(Number(a.sort_index)) ? Number(a.sort_index) : 999;
    const sb = Number.isFinite(Number(b.sort_index)) ? Number(b.sort_index) : 999;
    if (sa !== sb) return sa - sb;
    const ia = AGENT_ORDER.indexOf(a.agent_id);
    const ib = AGENT_ORDER.indexOf(b.agent_id);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
}
function rosterAll() {
  return state.agents?.agents || [];
}
function rosterById(id) {
  return rosterAll().find((a) => a.agent_id === id) || null;
}
function tasksNow() { return state.tasksData?.tasks || []; }
/** 上次点开的 Agent 记在本机：刷新页面回到同一个 Agent 的对话（历史从 API 拉，不靠本机） */
function rememberAgent(id) {
  try {
    if (id) localStorage.setItem('soda-board.agent', id);
    else localStorage.removeItem('soda-board.agent');
  } catch { /* 本机存储不可用就不记 */ }
}
function rememberedAgent() {
  try { return localStorage.getItem('soda-board.agent') || null; } catch { return null; }
}
function pickDefaultAgent(agents) {
  // 用户本机上次点开的 Agent 优先：刷新是「回到刚才那场对话」，不能因为别的 Agent
  // 正在跑任务就把他带到另一个对话里（D4 回归就是这样暴露的）。
  const saved = rememberedAgent();
  return agents.find((a) => a.agent_id === saved)
    || agents.find((a) => a.execution?.instance_status === 'running')
    || agents.find((a) => a.agent_id === 'claude')
    || agents[0];
}
function selectedAgent() { return agentsNow().find((a) => a.agent_id === state.selectedAgentId) || null; }
function selectedTask() { return tasksNow().find((t) => t.task_id === state.selectedTaskId) || null; }
function meta(id) {
  const builtin = AGENT_META[id] || null;
  const cfg = rosterById(id);
  const name = (cfg && cfg.display_name) || (builtin && builtin.name) || id;
  return {
    name,
    short: (builtin && builtin.short) || String(name).toUpperCase().slice(0, 12),
    icon: builtin ? builtin.icon : null,
    kind: cfg ? cfg.kind : null,
  };
}

function agentTone(a) {
  if (a?.availability?.available === false) return 'bad';
  const s = a?.execution?.instance_status;
  if (s === 'running') return 'live';
  if (s === 'idle' || s === 'completed') return 'ok';
  if (s === 'blocked') return 'bad';
  if (s === 'waiting') return 'wait';
  return 'unknown';
}
function agentStateLabel(a) {
  if (a?.availability?.available === false) return '不可用';
  const s = a?.execution?.instance_status;
  if (!s || s === 'unknown') return '? 未知';
  return STATUS_LABEL[s] || s;
}
function taskTone(t) {
  if (!t) return 'unknown';
  if (t.status === 'completed') return 'ok';
  if (t.status === 'running') return 'live';
  if (['blocked', 'interrupted', 'failed'].includes(t.status)) return 'bad';
  if (t.relay_pending) return 'wait';
  return 'unknown';
}
function taskLabel(t) { return t ? (STATUS_LABEL[t.status] || t.status || '—') : '—'; }
function doingText(a) {
  if (a?.kind === 'api' && !a?.task?.task_id && !a?.execution?.attempt_id) {
    return `API · ${a.protocol || '?'} · ${a.model || '?'}；可用性以实测为准（聊天不并入任务状态）`;
  }
  return a?.execution?.status_reason
    || a?.task?.status_reason
    || a?.availability?.detail
    || a?.availability?.reason
    || '—';
}
function evidenceLabel(src) {
  if (!src || src === 'none') return '无证据';
  return src;
}
function evidenceShort(src) {
  const map = { external: '外部日志', executor: '执行器', process_probe: '进程探测', system: '系统', none: '无证据' };
  return map[src] || (src ? String(src) : '无证据');
}
function ensureSelection() {
  const agents = agentsNow();
  if (state.selectedAgentId && !agents.some((a) => a.agent_id === state.selectedAgentId)) state.selectedAgentId = null;
  if (!state.selectedAgentId && agents.length) state.selectedAgentId = pickDefaultAgent(agents).agent_id;
}
function counts() {
  const tasks = tasksNow();
  const artifacts = tasks.reduce((n, t) => n + (Number(t.artifact_count) || 0), 0);
  const done = tasks.reduce((n, t) => n + (Number(t.progress?.done) || 0), 0);
  const total = tasks.reduce((n, t) => n + (Number(t.progress?.total) || 0), 0);
  const running = tasks.filter(FILTERS.running).length;
  const relay = tasks.filter(FILTERS.relay).length;
  const risk = tasks.filter(FILTERS.risk).length;
  const unknown = tasks.filter(FILTERS.unknown).length;
  return { tasks: tasks.length, artifacts, done, total, running, relay, risk, unknown };
}
function usage() {
  const u = state.hubState?.totals?.usage;
  return u && Number.isFinite(Number(u.output)) ? u : null;
}

/* ---------- 品牌 icon ---------- */
async function loadIcons() {
  await Promise.all(Object.entries(AGENT_META).map(async ([id, m]) => {
    if (!m.icon) return;
    try {
      const res = await fetch(`/icons/${m.icon}.svg`, { cache: 'no-store' });
      if (!res.ok) return;
      ICONS[id] = await res.text();
    } catch { /* 图标缺失时退回首字母，不阻塞数据 */ }
  }));
}
function iconHtml(id) {
  const svg = ICONS[id];
  if (svg) return `<span class="agent-icon" aria-hidden="true">${svg}</span>`;
  return `<span class="agent-icon" aria-hidden="true"><b>${esc(meta(id).short.slice(0, 1))}</b></span>`;
}

/* ---------- 渲染：顶栏与统计 ---------- */
function renderMeta() {
  const c = counts();
  $('#stat-agents').textContent = agentsNow().length || '—';
  $('#stat-tasks').textContent = state.tasksData ? c.tasks : '—';
  $('#stat-artifacts').textContent = state.tasksData ? c.artifacts : '—';
  $('#task-count').textContent = state.tasksData ? c.tasks : '—';

  const filterCounts = { all: c.tasks, running: c.running, relay: c.relay, risk: c.risk, unknown: c.unknown };
  $$('#task-filters .filter').forEach((btn) => {
    const f = btn.dataset.filter;
    btn.querySelector('b').textContent = state.tasksData ? filterCounts[f] : '—';
    btn.classList.toggle('is-active', f === state.filter);
    btn.setAttribute('aria-pressed', String(f === state.filter));
  });

  const obs = state.statusV2?.observed_at;
  const upd = $('#updated-at');
  upd.textContent = state.loadError ? '读取失败' : relTime(obs || state.loadedAt);
  upd.title = obs ? `服务端观测时间 ${obs}` : '尚无观测时间';

  const n = agentsNow().length;
  const all = rosterAll();
  $('#board-sub').textContent = state.loadError
    ? `读取失败：${state.loadError}`
    : `${n} 个 Agent · 卡片显示分配任务数与证据源 · 点卡片在右侧与它对话`;
  const countNote = $('#agent-count-note');
  if (countNote) {
    countNote.textContent = state.statusV2
      ? `${n} 个启用${all.length > n ? ` / 共 ${all.length}` : ''}`
      : '—';
  }
}

/* ---------- 渲染：Agent 卡 ---------- */
function renderAgentCards() {
  const root = $('#agent-cards');
  const agents = agentsNow();
  if (!agents.length) {
    root.innerHTML = `<div class="task-empty" style="grid-column:1/-1">${state.loadError ? '读不到 /api/agents/status-v2，不编造 Agent。' : '正在读取 /api/agents/status-v2 …'}</div>`;
    return;
  }
  root.dataset.count = String(agents.length);
  const boardMain = $('.board-main');
  if (boardMain) boardMain.classList.toggle('board-main--scroll', agents.length > 4);
  root.innerHTML = agents.map((a) => {
    const m = meta(a.agent_id);
    const tone = agentTone(a);
    const stateLabel = agentStateLabel(a);
    const selected = a.agent_id === state.selectedAgentId && !state.selectedTaskId;
    const taskKnown = Boolean(a.task?.task_id);
    const taskIdle = a.task?.status === 'idle';
    const loadLabel = taskKnown ? '任务 1' : taskIdle ? '任务 0' : '任务 未知';
    const av = a.availability?.available;
    const avLabel = av === true ? '可用' : av === false ? '不可用' : '可用性未知';
    const hasQuota = a.agent_id === 'claude' || a.agent_id === 'codex';
    return `<div class="agent-card-wrap"><button type="button" class="agent-card ${selected ? 'is-selected' : ''} ${hasQuota ? 'agent-card--quota' : ''}" data-agent="${esc(a.agent_id)}" aria-pressed="${selected}" data-tone="${tone}" data-task-count="${taskKnown ? 1 : 0}">
      <span class="agent-card__top">
        ${iconHtml(a.agent_id)}
        <span class="agent-card__name">${esc(m.name)}</span>
        <span class="agent-card__dot" data-tone="${tone}" aria-hidden="true"></span>
      </span>
      <span class="agent-card__state" data-tone="${tone}">${esc(stateLabel)}</span>
      <span class="agent-card__doing">${esc(doingText(a))}</span>
      ${quotaBlock(a)}
      <span class="agent-card__facts">
        <span class="agent-card__fact"><i>最近活动</i><b>${esc(relTime(a.execution?.last_activity_at))}</b></span>
        <span class="agent-card__fact"><i>观测</i><b data-rel="${esc(a.execution?.observed_at || '')}">${esc(relTime(a.execution?.observed_at))}</b></span>
      </span>
      <span class="agent-card__meta">
        <span class="chip ${av === false ? 'chip--bad' : av === true ? 'chip--ok' : ''}">${esc(avLabel)}</span>
        <span class="chip chip__mono">${a.kind === 'api' ? `API · ${esc(a.protocol || '?')}` : esc(evidenceShort(a.availability?.evidence_source))}</span>
        <span class="agent-card__load">${esc(loadLabel)}</span>
      </span>
    </button></div>`;
  }).join('');
  $$('.agent-card', root).forEach((btn) => {
    btn.addEventListener('click', () => {
      state.selectedAgentId = btn.dataset.agent;
      state.selectedTaskId = null;
      rememberAgent(state.selectedAgentId);
      renderAll();
      if (window.SodaChat) SodaChat.focus(state.selectedAgentId);
      const agent = agents.find((x) => x.agent_id === btn.dataset.agent);
      const un = agent && agent.chat_supported === false;
      showToast(un ? `${meta(btn.dataset.agent).name} 暂不支持对话 · 右侧写了原因` : `已打开与 ${meta(btn.dataset.agent).name} 的对话`);
    });
  });
}

/* ---------- 渲染：左栏任务 ---------- */
function filteredTasks() {
  const allow = FILTERS[state.filter] || FILTERS.all;
  return tasksNow().filter(allow);
}
function renderTasks() {
  const list = $('#task-list');
  if (!state.tasksData) {
    list.innerHTML = `<div class="task-empty">读不到 /api/tasks。<br>不是 0 个任务，是证据没到。</div>`;
    return;
  }
  const rows = filteredTasks();
  if (!rows.length) {
    list.innerHTML = `<div class="task-empty">此筛选下没有任务。<br>空内容显示 —，不兜底成别的状态。</div>`;
    return;
  }
  list.innerHTML = rows.map((t) => {
    const tone = taskTone(t);
    const done = Number(t.progress?.done) || 0;
    const total = Number(t.progress?.total) || 0;
    const selected = t.task_id === state.selectedTaskId;
    return `<button type="button" class="task-row ${selected ? 'is-selected' : ''}" data-task="${esc(t.task_id)}" aria-pressed="${selected}" aria-label="${esc(t.title || t.task_id)} · ${esc(taskLabel(t))} · ${done}/${total}" title="${esc(t.title || t.task_id)} · ${esc(taskLabel(t))}">
      <span class="task-row__dot" data-tone="${tone}" aria-hidden="true"></span>
      <span class="task-row__title">${esc(t.title || t.task_id)}</span>
      <span class="task-row__meta">
        <span class="task-row__prog">${done}/${total}</span>
      </span>
    </button>`;
  }).join('');
  list.classList.toggle('is-scrollable', list.scrollHeight > list.clientHeight + 1);
  $$('.task-row', list).forEach((btn) => {
    btn.addEventListener('click', () => {
      state.selectedTaskId = state.selectedTaskId === btn.dataset.task ? null : btn.dataset.task;
      if (state.selectedTaskId) state.selectedAgentId = null;
      else ensureSelection();
      renderAll();
      showToast(state.selectedTaskId ? `已选中任务 ${state.selectedTaskId}` : '已返回 Agent 详情');
    });
  });
}

/* ---------- 渲染：右侧一整列 ---------- */
/* 选中任务 → 任务详情（本文件画）；选中 Agent → 与它的对话（board-chat.js 画，流式更新时不整块重绘） */
function renderDetail() {
  const root = $('#detail-panel');
  const task = selectedTask();
  const agent = selectedAgent();
  if (task || !agent || !window.SodaChat) {
    if (window.SodaChat) SodaChat.hide();
    root.setAttribute('aria-live', 'polite');
    root.classList.remove('is-chat');
    let html;
    if (task) html = taskDetailHtml(task);
    else html = `<div class="detail__top">${iconHtml('claude')}<div><div class="detail__name">NO AGENT</div><div class="detail__sub">没有可信的 Agent 数据</div></div></div>
      <div class="detail__note">${state.loadError ? `读取失败：${esc(state.loadError)}` : '正在读取 /api/agents/status-v2 …'}</div>`;
    root.innerHTML = html;
    root.classList.toggle('is-scrollable', root.scrollHeight > root.clientHeight + 1);
    return;
  }
  SodaChat.show(agent.agent_id);
}

function agentDetailHtml(a) {
  const m = meta(a.agent_id);
  const tone = agentTone(a);
  const av = a.availability || {};
  const ex = a.execution || {};
  const tk = a.task || {};
  const avLabel = av.available === true ? '可用' : av.available === false ? '不可用' : '? 未知';
  const tkId = tk.task_id ? String(tk.task_id) : '—';
  const proc = ex.process_alive === true ? 'alive' : ex.process_alive === false ? 'dead' : '—';
  return `
    <div class="detail__top">
      ${iconHtml(a.agent_id)}
      <div>
        <div class="detail__name">${esc(m.name)}</div>
        <div class="detail__sub">agent_id · ${esc(a.agent_id)}</div>
      </div>
      <span class="detail__state chip ${tone === 'bad' ? 'chip--bad' : tone === 'ok' ? 'chip--ok' : tone === 'live' ? 'chip--amber' : ''}">${esc(agentStateLabel(a))}</span>
    </div>

    <section class="detail__section">
      <div class="detail__label">可用性<span>观测于 ${esc(relTime(av.checked_at || av.observed_at))}</span></div>
      <div class="detail__value">${esc(av.detail || av.reason || (av.available === true ? 'CLI 探测通过；可用不等于正在执行。' : '没有可信的可用性证据。'))}</div>
      <div class="detail__chips">
        <span class="chip ${av.available === false ? 'chip--bad' : av.available === true ? 'chip--ok' : ''}">${esc(avLabel)}</span>
        <span class="chip chip__mono">${esc(evidenceLabel(av.evidence_source))}</span>
      </div>
    </section>

    <section class="detail__section">
      <div class="detail__label">执行</div>
      <div class="detail__value">${esc(ex.status_reason || '没有可信的执行证据。')}</div>
      <div class="kv-list kv-list--2">
        <div class="kv-row"><span>实例状态</span><b>${esc(ex.instance_status ? (STATUS_LABEL[ex.instance_status] || ex.instance_status) : '—')}</b></div>
        <div class="kv-row"><span>进程</span><b class="mono">${esc(proc)}</b></div>
        <div class="kv-row"><span>待接力</span><b>${ex.relay_pending ? '是' : '否'}</b></div>
        <div class="kv-row"><span>证据源</span><b class="mono">${esc(evidenceLabel(ex.evidence_source))}</b></div>
      </div>
    </section>

    <section class="detail__section">
      <div class="detail__label">任务</div>
      <div class="detail__value">${esc(tk.status_reason || '没有可信证据证明它有没有任务。')}</div>
      <div class="kv-list kv-list--2">
        <div class="kv-row"><span>任务 ID</span><b class="mono">${esc(tkId)}</b></div>
        <div class="kv-row"><span>任务状态</span><b>${esc(tk.status ? (STATUS_LABEL[tk.status] || tk.status) : '—')}</b></div>
        <div class="kv-row"><span>证据源</span><b class="mono">${esc(evidenceLabel(tk.evidence_source))}</b></div>
      </div>
    </section>

    ${quotaDetailHtml(a.agent_id)}
`;
}

function quotaDetailHtml(agentId) {
  if (agentId !== 'claude' && agentId !== 'codex') {
    return `<section class="detail__section">
      <div class="detail__label">额度</div>
      <div class="detail__reason">这个 Agent 没有接入额度数据源，不编造。</div>
    </section>`;
  }
  if (!state.quotas) {
    return `<section class="detail__section">
      <div class="detail__label">额度</div>
      <div class="detail__reason">额度读取失败：${esc(state.quotasError || '还没读到 /api/quotas')}</div>
    </section>`;
  }
  const q = state.quotas;
  if (agentId === 'claude') {
    const rows = (q.providers || []).map((p) => {
      if (!p.ok) {
        return `<div class="kv-row"><span>${esc(p.name)}</span><b>接口失败：${esc(String(p.error || '').slice(0, 60))}</b></div>`;
      }
      const w5 = quotaWindowOf(p, 3);
      const wk = quotaWindowOf(p, 6);
      const one = (w) => {
        if (!w) return '—';
        const used = w.percentage == null ? '—' : `${w.percentage}%`;
        const rest = w.remaining == null ? '剩余未知（仅百分比）' : `剩余 ${fmtInt(w.remaining)}`;
        return `${used} 已用 · ${rest}${w.resetAt ? ` · 重置 ${fmtCountdown(w.resetAt)}` : ' · 重置时间未知'}`;
      };
      return `<div class="kv-row"><span>${esc(p.name)}${p.level ? ` · ${esc(p.level)}` : ''}</span><b>5h ${esc(one(w5))}<br>周 ${esc(one(wk))}</b></div>`;
    }).join('');
    return `<section class="detail__section">
      <div class="detail__label">额度 · GLM<span>${esc(q.cache ? `缓存 ${Math.max(0, Math.round((q.cache.age_ms || 0) / 1000))}s` : '')}</span></div>
      <div class="detail__reason">百分比是「已用」，不是剩余。${esc((q.notes || [])[0] || '')}</div>
      <div class="kv-list">${rows || '<div class="kv-row"><span>—</span><b>没有读到 Zhipu provider</b></div>'}</div>
    </section>`;
  }
  const c = q.codex || {};
  return `<section class="detail__section">
    <div class="detail__label">额度 · Codex<span>无剩余额度接口</span></div>
    <div class="detail__reason">${esc(c.note || 'OpenAI 官方没有剩余额度查询接口，只显示已用量。')}</div>
    <div class="kv-list kv-list--2">
      <div class="kv-row"><span>今日花费</span><b>${esc(fmtUsd(c.used_usd))}</b></div>
      <div class="kv-row"><span>今日请求</span><b>${esc(fmtInt(c.requests))}</b></div>
      <div class="kv-row"><span>最新 rollup</span><b>${esc(c.latest_date || '—')}</b></div>
      <div class="kv-row"><span>最新花费</span><b>${esc(fmtUsd(c.latest_used_usd))}</b></div>
      <div class="kv-row"><span>剩余额度</span><b>不提供</b></div>
      <div class="kv-row"><span>今日有记录</span><b>${c.has_today ? '是' : '否'}</b></div>
    </div>
  </section>`;
}

function taskDetailHtml(t) {
  const done = Number(t.progress?.done) || 0;
  const total = Number(t.progress?.total) || 0;
  const p = pct(done, total);
  const remaining = Array.isArray(t.remaining) ? t.remaining : [];
  const artifacts = Array.isArray(t.latest_artifacts) ? t.latest_artifacts.slice(0, 2) : [];
  const step = t.current_step?.name || t.current_step?.key || '—';
  return `
    <div class="detail__top">
      <span class="agent-icon" aria-hidden="true"><svg width="30" height="30" viewBox="0 0 20 20" fill="none"><rect x="2.6" y="2.6" width="14.8" height="14.8" rx="3" stroke="#4A4237" stroke-width="1.5"/><path d="M6.2 7.2h7.6M6.2 10h7.6M6.2 12.8h4.6" stroke="#4A4237" stroke-width="1.5" stroke-linecap="round"/></svg></span>
      <div>
        <div class="detail__name">${esc(t.task_id)}</div>
        <div class="detail__sub">任务详情 · /api/tasks</div>
      </div>
      <span class="detail__state chip">${esc(taskLabel(t))}</span>
    </div>
    <div class="detail__note"><b>${esc(t.title || t.task_id)}</b><br>${esc(t.status_reason || '没有状态说明。')}</div>

    <section class="detail__section">
      <div class="detail__label">进度<span>${p}%</span></div>
      <div class="detail__value">${done} / ${total} 步完成</div>
      <div class="kv-list">
        <div class="kv-row"><span>当前步骤</span><b>${esc(step)}</b></div>
        <div class="kv-row"><span>剩余步骤</span><b>${remaining.length ? remaining.map((r) => esc(r)).join(' / ') : '—'}</b></div>
        <div class="kv-row"><span>交付物</span><b>${Number(t.artifact_count) || 0} 个</b></div>
        <div class="kv-row"><span>证据源</span><b class="mono">${esc(evidenceLabel(t.evidence_source))}</b></div>
        <div class="kv-row"><span>观测于</span><b>${esc(relTime(t.observed_at))}</b></div>
      </div>
    </section>

    <section class="detail__section">
      <div class="detail__label">最近交付物</div>
      <div class="detail__artifacts">${artifacts.length ? artifacts.map((a) => {
        const name = String(a.path || '').split(String.fromCharCode(92)).join('/').split('/').pop();
        return `<div class="detail__artifact"><span title="${esc(a.path || '')}">${esc(name)}</span><span>${shortNum(a.bytes || 0)}B</span></div>`;
      }).join('') : '<div class="detail__reason">— 没有交付物记录</div>'}</div>
    </section>`;
}

/* ---------- 渲染：任务推进带 ---------- */
function renderProgress() {
  const tasks = tasksNow();
  const c = counts();
  $('#progress-sum').textContent = `${c.done} / ${c.total} 步 · ${c.tasks} 个任务`;
  const root = $('#progress-bars');
  if (!tasks.length) {
    root.innerHTML = '<span class="progress-cell is-empty" title="没有任务数据"><i></i></span>';
    return;
  }
  root.innerHTML = tasks.map((t) => {
    const done = Number(t.progress?.done) || 0;
    const total = Number(t.progress?.total) || 0;
    const p = pct(done, total);
    const tone = taskTone(t);
    return `<span class="progress-cell ${p ? '' : 'is-empty'}" data-task-id="${esc(t.task_id)}" data-tone="${tone}" title="${esc(t.task_id)} · ${done}/${total} 步 · ${esc(taskLabel(t))}"><i style="width:${p}%"></i></span>`;
  }).join('');
}

/* ---------- 渲染：底部数据卡 ---------- */
function renderDataCards() {
  const activity = $('#activity-list');
  const agents = agentsNow();
  activity.innerHTML = agents.length ? agents.map((a) => {
    const m = meta(a.agent_id);
    return `<div class="activity-row" data-agent="${esc(a.agent_id)}">
      ${iconHtml(a.agent_id).replace('agent-icon', 'activity-row__icon')}
      <span class="activity-row__name">${esc(m.name)}</span>
      <span class="activity-row__time" data-rel="${esc(a.execution?.observed_at || '')}">${esc(relTime(a.execution?.observed_at))}</span>
      <span class="activity-row__src">${esc(evidenceShort(a.execution?.evidence_source))}</span>
    </div>`;
  }).join('') : `<div class="empty-note">${state.loadError ? '读取失败，不编造活动。' : '没有 Agent 证据。'}</div>`;

  const u = usage();
  $('#tok-output').textContent = u ? shortNum(u.output) : '—';
  $('#tok-input').textContent = u ? shortNum(u.input) : '—';
  $('#tok-cost').textContent = u && Number.isFinite(Number(u.cost)) ? `$${Number(u.cost).toFixed(2)}` : '—';
  $('#tok-output').title = u ? `${fmtInt(u.output)} tokens` : '无 token 采集';

  const procs = agents.length ? agents.map((a) => {
    const alive = a.execution?.process_alive;
    const state = alive === true ? 'alive' : alive === false ? 'dead' : 'unknown';
    const label = alive === true ? 'alive' : alive === false ? 'dead' : '—';
    return `<div class="proc-row"><span>${esc(meta(a.agent_id).name)}</span><b data-state="${state}">${label}</b></div>`;
  }).join('') : '<div class="empty-note">没有进程证据。</div>';
  $('#proc-list').innerHTML = procs;
}

/* ---------- 总渲染 ---------- */
function renderAll() {
  renderMeta();
  renderAgentCards();
  renderTasks();
  renderDetail();
  renderProgress();
  renderDataCards();
}

/* ---------- 视图切换（hash 可前进后退） ---------- */
function routeFromHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  return raw === 'easedraw' ? 'easedraw' : 'board';
}
function ensureFrame() {
  const frame = $('#ease-frame');
  if (!frame.src || frame.getAttribute('src') === 'about:blank') frame.src = frame.dataset.src;
}
function applyRoute(route) {
  state.route = route;
  const isEase = route === 'easedraw';
  $('#view-board').hidden = isEase;
  $('#view-ease').hidden = !isEase;
  $$('.pillnav__item').forEach((b) => {
    const on = b.dataset.route === route;
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  if (isEase) ensureFrame();
  document.title = isEase ? 'Soda Office · EaseDraw' : 'Soda Office · Agent 看板 V2';
  document.body.dataset.route = route;
}
function go(route) {
  if (location.hash === `#${route}`) {
    applyRoute(route);
    if (route === 'board') renderAll();
    showToast(route === 'board' ? '当前已是看板视图' : '当前已是 EaseDraw 视图');
    return;
  }
  location.hash = route;
}

/* ---------- toast ---------- */
let toastTimer = null;
function showToast(text) {
  const el = $('#toast');
  el.dataset.count = String(Number(el.dataset.count || 0) + 1);   // 每次提示都计数（自检脚本据此判断按钮真的触发了）
  el.textContent = text;
  el.classList.add('is-show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-show'), 2600);
}

/* ---------- 事件 ---------- */
function bindEvents() {
  $$('.pillnav__item').forEach((btn) => {
    btn.addEventListener('click', () => go(btn.dataset.route));
  });
  $('.brand').addEventListener('click', (e) => { e.preventDefault(); go('board'); });
  window.addEventListener('hashchange', () => applyRoute(routeFromHash()));

  $('#refresh-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (btn.getAttribute('aria-busy') === 'true') return;
    btn.setAttribute('aria-busy', 'true');
    $('#refresh-label').textContent = '刷新中';
    const started = performance.now();
    // 右列的对话记录也一并重拉（正在流式输出的那一轮不受影响）
    if (window.SodaChat && state.selectedAgentId && !state.selectedTaskId) SodaChat.reload(state.selectedAgentId);
    await Promise.all([loadData(), new Promise((r) => setTimeout(r, 420))]);
    const ms = Math.round(performance.now() - started);
    btn.removeAttribute('aria-busy');
    $('#refresh-label').textContent = '刷新';
    showToast(state.loadError ? `刷新失败：${state.loadError}` : `已重新读取真实 API · ${ms}ms · 状态仍以证据为准`);
  });

  $('#task-filters').addEventListener('click', (e) => {
    const btn = e.target.closest('.filter');
    if (!btn) return;
    state.filter = btn.dataset.filter;
    if (state.selectedTaskId && !filteredTasks().some((t) => t.task_id === state.selectedTaskId)) {
      state.selectedTaskId = null;
      ensureSelection();
    }
    renderMeta();
    renderTasks();
    renderDetail();
    const labels = { all: '全部', running: '执行', relay: '接力', risk: '异常', unknown: '未知' };
    showToast(`筛选：${labels[state.filter]} · ${filteredTasks().length} 个任务`);
  });

  setInterval(() => {
    const obs = state.statusV2?.observed_at;
    $('#updated-at').textContent = state.loadError ? '读取失败' : relTime(obs || state.loadedAt);
    $$('[data-rel]').forEach((el) => { el.textContent = relTime(el.dataset.rel); });
    $$('[data-reset-at]').forEach((el) => {
      if (!el.dataset.resetAt) return;
      const txt = fmtCountdown(el.dataset.resetAt);
      if (txt) el.textContent = `${el.dataset.resetPrefix || '重置'} ${txt}`;
    });
  }, 30000);
}

/* ---------- 启动 ---------- */
async function init() {
  bindEvents();
  if (!location.hash) history.replaceState(null, '', '#board');
  applyRoute(routeFromHash());
  // 右列对话面板（Coss 风格）：给它看板里的 Agent 名册、Agent 实时数据和 toast
  if (window.AgentAdmin) {
    window.AgentAdmin.init({
      toast: showToast,
      loadData,
      roster: rosterAll,
      meta,
    });
  }
  if (window.SodaChat) {
    window.SodaChat.mount($('#detail-panel'), {
      toast: showToast,
      meta: (agentId) => meta(agentId),
      agent: (agentId) => agentsNow().find((a) => a.agent_id === agentId) || null,
      detailHtml: (agentId) => {
        const a = agentsNow().find((x) => x.agent_id === agentId);
        return a ? agentDetailHtml(a) : '<div class="chat__empty">读不到这个 Agent 的数据</div>';
      },
    });
  }
  await loadIcons();
  await loadData();
  if (state.loadError) showToast(`数据读取失败：${state.loadError}`);
}

init();
