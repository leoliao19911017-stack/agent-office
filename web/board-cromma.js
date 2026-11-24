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

/** 交付物时间线六类：顺序固定；goal_report 单独放在任务头「目标达成」。 */
const DL_TIMELINE = [
  { kind: 'requirement', no: '01', label: '需求文档', hint: '讨论后沉淀的需求 / 任务书' },
  { kind: 'task_spec', no: '02', label: '开发指令', hint: '派给 Agent 的任务书' },
  { kind: 'dev_output', no: '03', label: '交付成果', hint: 'git commit + 改动文件' },
  { kind: 'artifact', no: '04', label: '生成物', hint: '截图 / 证据 / 报告' },
  { kind: 'review', no: '05', label: '评审报告', hint: 'GPT 评审文档' },
  { kind: 'retro', no: '06', label: '复盘建议', hint: '评审文档里的结论与改进建议' },
];
const DL_KIND_LABEL = Object.fromEntries(DL_TIMELINE.map((k) => [k.kind, k.label]));
const DL_JUDGEMENT = {
  achieved: '已达成', partial: '部分达成', missed: '未达成', no_goal: '未设定目标',
};

const state = {
  statusV2: null,
  tasksData: null,
  hubState: null,
  quotas: null,
  agents: null,
  toolEvents: null,
  toolEventsError: null,
  loadError: null,
  quotasError: null,
  selectedAgentId: null,
  selectedTaskId: null,
  filter: 'all',
  route: 'board',
  // TASK-交付物视图：选中任务 → 中央交付物时间线；右侧预览。
  deliverables: null,
  deliverablesFor: null,
  deliverablesLoading: false,
  deliverablesError: null,
  unlinked: null,
  unlinkedLoading: false,
  unlinkedError: null,
  showUnlinked: false,
  preview: null,
  expandedKinds: new Set(),
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
/** 交付物时间：日期 + 时分，避免时间线只写「3 天前」看不出先后。 */
function fmtDate(iso) {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
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
    getJson('/api/tool-events?recent=200&tools=30'),
  ]);
  const failures = [];
  state.statusV2 = results[0].status === 'fulfilled' ? results[0].value : null;
  if (results[0].status === 'rejected') failures.push(`status-v2：${results[0].reason.message}`);
  state.tasksData = results[1].status === 'fulfilled' ? results[1].value : null;
  if (results[1].status === 'rejected') failures.push(`tasks：${results[1].reason.message}`);
  state.hubState = results[2].status === 'fulfilled' ? results[2].value : null;
  state.quotas = results[3].status === 'fulfilled' ? results[3].value : null;
  state.agents = results[4] && results[4].status === 'fulfilled' ? results[4].value : null;
  state.toolEvents = results[5] && results[5].status === 'fulfilled' ? results[5].value : null;
  state.toolEventsError = results[5] && results[5].status === 'rejected' ? results[5].reason.message : null;
  // 工具采集失败不冒充 0：转盘左弧显示读取失败，不让状态/任务一起背锅。
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

/* ---------- 交付物数据层（只读 API，采集由 scripts/collect-deliverables.mjs 做） ---------- */
async function loadDeliverables(taskId) {
  state.deliverablesLoading = true;
  state.deliverablesError = null;
  state.deliverables = null;
  state.deliverablesFor = taskId;
  renderDeliverables();
  try {
    const data = await getJson(`/api/deliverables?task_id=${encodeURIComponent(taskId)}`);
    // 用户可能已经切走：旧请求回来不许覆盖新任务
    if (state.selectedTaskId !== taskId || state.showUnlinked) return;
    state.deliverables = data;
    state.deliverablesFor = taskId;
  } catch (err) {
    if (state.selectedTaskId !== taskId) return;
    state.deliverablesError = String(err.message || err);
  } finally {
    if (state.selectedTaskId === taskId) {
      state.deliverablesLoading = false;
      renderAll();
    }
  }
}

async function refreshUnlinkedSummary() {
  try {
    const data = await getJson('/api/deliverables');
    state.unlinked = data;
    const btn = $('#unlinked-count');
    if (btn) btn.textContent = String(Number(data?.total) || 0);
  } catch { /* 未关联区读不到不拖垮看板；点开时会再报一次真实错误 */ }
}

async function loadUnlinked() {
  state.unlinkedLoading = true;
  state.unlinkedError = null;
  renderDeliverables();
  try {
    const data = await getJson('/api/deliverables');
    state.unlinked = data;
    const n = Number(data?.total) || 0;
    const btn = $('#unlinked-count');
    if (btn) btn.textContent = String(n);
  } catch (err) {
    state.unlinkedError = String(err.message || err);
  } finally {
    state.unlinkedLoading = false;
    renderAll();
  }
}

async function openPreview(deliverableId) {
  if (!deliverableId) return;
  state.preview = { loading: true, deliverable_id: deliverableId };
  renderDetail();
  try {
    const data = await getJson(`/api/deliverables/preview?deliverable_id=${encodeURIComponent(deliverableId)}`);
    if (!state.preview || state.preview.deliverable_id !== deliverableId) return;
    state.preview = { ...data, deliverable_id: deliverableId, loading: false };
  } catch (err) {
    if (!state.preview || state.preview.deliverable_id !== deliverableId) return;
    state.preview = { loading: false, deliverable_id: deliverableId, error: String(err.message || err) };
  }
  renderDetail();
  const panel = $('#detail-panel');
  if (panel) panel.scrollTop = 0;
}

function closePreview() {
  state.preview = null;
  renderDetail();
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
    : state.toolEventsError
      ? `${n} 个 Agent · 工具采集读取失败：${state.toolEventsError}`
      : `${n} 个 Agent · 转盘刻度来自真实 tool_events · 点弧上的 Agent 在右侧与它对话`;
  const countNote = $('#agent-count-note');
  if (countNote) {
    countNote.textContent = state.statusV2
      ? `${n} 个启用${all.length > n ? ` / 共 ${all.length}` : ''}`
      : '—';
  }
}

/* ---------- 渲染：中央转盘（TASK-转盘与Agent可添加 第二批） ----------
   取消 Agent 卡片网格：中央是一条 224° 的同心圆弧 + 刻度轨道。
   · 每个 Agent 一个扇区，扇区里的弧长 = 该 Agent 真实工具调用数 / 最大值
   · 刻度值取真实 max(tool_events by_agent)，没有采集就写「未采集」，不画假数字
   · 左弧读 tool_events（工具名 × 次数 + 最近内容），右弧是数据流管道 + 液位
   · 液位 = 任务推进 done/total，真实值；管道 dashoffset 是纯 CSS 动画 */
const TT = { cx: 450, cy: 392, start: -112, end: 112, trackR: 244, nodeR: 232, labelR: 208, scaleR: 318 };

function ttPoint(r, deg) {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [TT.cx + r * Math.cos(rad), TT.cy + r * Math.sin(rad)];
}
function ttArc(r, a0, a1) {
  const [x0, y0] = ttPoint(r, a0);
  const [x1, y1] = ttPoint(r, a1);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
function ttCounts() {
  const map = new Map();
  for (const a of state.toolEvents?.by_agent || []) map.set(a.agent_id, Number(a.count) || 0);
  return map;
}
function ttScope(agentId) {
  const te = state.toolEvents;
  if (!te) return { kind: state.toolEventsError ? 'error' : 'loading', error: state.toolEventsError };
  if (te.collecting) return { kind: 'collecting' };
  const agentCount = Number((te.by_agent || []).find((a) => a.agent_id === agentId)?.count) || 0;
  const useAgent = agentCount > 0;
  const tools = (te.tools || []).map((t) => ({
    ...t,
    scopeCount: useAgent ? Number(t.agents && t.agents[agentId]) || 0 : Number(t.count) || 0,
    scopeRecent: (t.recent || []).filter((r) => !useAgent || r.agent_id === agentId),
  })).filter((t) => t.scopeCount > 0);
  const recent = useAgent
    ? ((te.recent_by_agent && te.recent_by_agent[agentId]) || (te.recent || []).filter((r) => r.agent_id === agentId))
    : (te.recent || []);
  const total = useAgent ? agentCount : Number(te.total_all) || 0;
  return {
    kind: total > 0 ? (useAgent ? 'agent' : 'all') : 'empty',
    agentId: useAgent ? agentId : null,
    tools,
    recent,
    total,
    note: useAgent ? null : (te.total_all > 0 ? '这个 Agent 没有工具事件，左弧显示全部已采集数据' : null),
  };
}

function renderTurntable() {
  const root = $('#tt-gauge');
  const center = $('#tt-center');
  const agents = agentsNow();
  if (!root || !center) return;
  if (!agents.length) {
    root.innerHTML = '';
    center.innerHTML = `<div class="tt-center__name">NO AGENT</div><div class="tt-center__meta">${state.loadError ? '读不到 /api/agents/status-v2，不编造' : '正在读取真实 Agent 名册…'}</div>`;
    renderToolPanels();
    return;
  }

  const counts = ttCounts();
  const maxCount = Math.max(0, ...agents.map((a) => counts.get(a.agent_id) || 0));
  const selected = agents.find((a) => a.agent_id === state.selectedAgentId) || agents[0];
  const selectedId = selected ? selected.agent_id : null;
  const n = agents.length;
  const sweep = TT.end - TT.start;
  const gap = n > 1 ? 7 : 0;
  const sector = (sweep - gap * (n - 1)) / n;

  /* 刻度轨道：1.5° 一根细线，每 6 根加长；整组缓慢旋转（CSS，60fps） */
  const tickParts = [];
  let tickCount = 0;
  for (let i = 0; i * 1.5 <= sweep + 0.01; i += 1) {
    const deg = TT.start + i * 1.5;
    const major = i % 6 === 0;
    const [x0, y0] = ttPoint(286, deg);
    const [x1, y1] = ttPoint(major ? 300 : 294, deg);
    tickParts.push(`<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}" stroke="${major ? '#CFC4B2' : '#DDD5C7'}" stroke-width="${major ? 1 : .7}"/>`);
    tickCount += 1;
  }

  /* 真实刻度标签：0 到 maxCount，取 6 个位置；采集没跑时只写 0 和「未采集」 */
  const scaleParts = [];
  const scaleSteps = maxCount > 0 ? 6 : 1;
  for (let i = 0; i <= scaleSteps; i += 1) {
    const deg = TT.start + (sweep * i) / scaleSteps;
    const [x, y] = ttPoint(TT.scaleR, deg);
    const value = maxCount > 0 ? Math.round((maxCount * i) / scaleSteps) : 0;
    const cos = Math.cos(((deg - 90) * Math.PI) / 180);
    const anchor = cos > 0.3 ? 'start' : cos < -0.3 ? 'end' : 'middle';
    scaleParts.push(`<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}" class="tt-scale-label">${value}</text>`);
  }

  /* 每个 Agent 的扇区：满区轨道 + 按真实计数缩放的弧带 + 边界辐条 */
  const sectors = agents.map((a, i) => {
    const a0 = TT.start + i * (sector + gap);
    const a1 = a0 + sector;
    const mid = a0 + sector / 2;
    const count = counts.get(a.agent_id) || 0;
    const ratio = maxCount > 0 ? count / maxCount : 0;
    const usable = Math.max(0, sector - 5);
    const valueA1 = count > 0 ? a0 + 2.5 + usable * (0.12 + 0.88 * ratio) : a0;
    const isSel = a.agent_id === selectedId;
    const [nx, ny] = ttPoint(TT.nodeR, mid);
    const [lx, ly] = ttPoint(TT.labelR, mid);
    // 标签放在弧内侧，并朝圆心方向展开：两侧面板不遮住 Agent 名。
    const anchor = mid > 35 ? 'end' : mid < -35 ? 'start' : 'middle';
    const nameY = ly + 3;
    const countY = nameY + 12;
    const [b0x, b0y] = ttPoint(232, a0);
    const [b0x2, b0y2] = ttPoint(302, a0);
    const band = count > 0
      ? `<path d="${ttArc(TT.trackR, a0 + 2.5, valueA1)}" fill="none" stroke="#FEF1DC" stroke-width="${isSel ? 23 : 18}" stroke-linecap="round" opacity="${isSel ? .9 : .35}"/>
         <path d="${ttArc(TT.trackR, a0 + 2.5, valueA1)}" fill="none" stroke="${isSel ? '#F8BA3F' : '#D8C39B'}" stroke-width="${isSel ? 13 : 8}" stroke-linecap="round" opacity="${isSel ? .95 : .62}"/>`
      : '';
    const m = meta(a.agent_id);
    return {
      agentId: a.agent_id,
      html: `<g class="tt-sector ${isSel ? 'is-selected' : ''}">
        <path d="${ttArc(TT.trackR, a0 + 2, a1 - 2)}" fill="none" stroke="${isSel ? '#F3DFB8' : '#ECE5D9'}" stroke-width="14" stroke-linecap="round"/>
        ${band}
        <line x1="${b0x.toFixed(1)}" y1="${b0y.toFixed(1)}" x2="${b0x2.toFixed(1)}" y2="${b0y2.toFixed(1)}" stroke="#E6DED1" stroke-width=".8" opacity=".85"/>
        <g class="tt-node ${isSel ? 'is-selected' : ''}" data-agent="${esc(a.agent_id)}" role="button" tabindex="0" aria-label="${esc(m.name)}，工具 ${count} 次，点击查看对话">
          <circle cx="${nx.toFixed(1)}" cy="${ny.toFixed(1)}" r="${isSel ? 10 : 7}" fill="${isSel ? 'rgba(248,186,63,.18)' : 'transparent'}" stroke="${isSel ? '#E0A83D' : '#C9BEAE'}" stroke-width="1.2"/>
          <circle cx="${nx.toFixed(1)}" cy="${ny.toFixed(1)}" r="${isSel ? 4.6 : 3.2}" fill="${isSel ? '#F0B34A' : '#C4B8A5'}"/>
          <text x="${lx.toFixed(1)}" y="${nameY.toFixed(1)}" text-anchor="${anchor}" class="tt-node__name ${isSel ? 'is-selected' : ''}">${esc(m.short)}</text>
          <text x="${lx.toFixed(1)}" y="${countY.toFixed(1)}" text-anchor="${anchor}" class="tt-node__count ${isSel ? 'is-selected' : ''}">${maxCount > 0 ? `×${fmtInt(count)}` : '待采集'}</text>
          <title>${esc(m.name)} · 工具调用 ${fmtInt(count)} 次${isSel ? ' · 当前选中' : ''}</title>
        </g>
      </g>`,
      mid,
      count,
    };
  });

  root.innerHTML = `
    <g class="tt-rings">
      <path d="${ttArc(306, TT.start, TT.end)}" fill="none" stroke="#D9CFBF" stroke-width=".9"/>
      <path d="${ttArc(282, TT.start, TT.end)}" fill="none" stroke="#E9E2D6" stroke-width=".7"/>
      <path d="${ttArc(262, TT.start, TT.end)}" fill="none" stroke="#EFE9DE" stroke-width=".7"/>
    </g>
    <text x="${TT.cx}" y="34" text-anchor="middle" class="tt-scale-title">TOOL CALLS · ${maxCount > 0 ? `0–${fmtInt(maxCount)}` : '未采集'}</text>
    <g class="tt-tickrail">${tickParts.join('')}</g>
    ${scaleParts.join('')}
    ${sectors.map((s) => s.html).join('')}`;

  $$('.tt-node', root).forEach((node) => {
    const pick = () => selectAgentById(node.getAttribute('data-agent'));
    node.addEventListener('click', pick);
    node.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
  });

  if (selected) {
    const m = meta(selected.agent_id);
    const count = counts.get(selected.agent_id) || 0;
    const toolCountLabel = !state.toolEvents || state.toolEvents.collecting ? '工具 待采集' : `工具 ×${fmtInt(count)}`;
    const tone = agentTone(selected);
    center.innerHTML = `
      <div class="tt-center__eyebrow">当前选中 · ${agents.length} 个启用</div>
      <div class="tt-center__id">${iconHtml(selected.agent_id)}<b>${esc(m.name)}</b></div>
      <div class="tt-center__meta">
        <span class="tt-center__state" data-tone="${tone}">${esc(agentStateLabel(selected))}</span>
        <span>${esc(toolCountLabel)}</span>
        <span>最近 ${esc(relTime(selected.execution?.last_activity_at))}</span>
      </div>
      <div class="tt-center__hint">点弧上的 Agent 切换 · 右侧显示它的详情/对话</div>`;
  }
  renderToolPanels();
}

function selectAgentById(id) {
  if (!id) return;
  const agent = agentsNow().find((a) => a.agent_id === id);
  if (!agent) return;
  state.selectedAgentId = id;
  state.selectedTaskId = null;
  state.showUnlinked = false;
  state.preview = null;
  state.deliverables = null;
  state.deliverablesFor = null;
  rememberAgent(id);
  renderAll();
  if (window.SodaChat) SodaChat.focus(id);
  const un = agent.chat_supported === false;
  showToast(un ? `${meta(id).name} 暂不支持对话 · 右侧写了原因` : `已打开与 ${meta(id).name} 的对话`);
}

function renderToolPanels() {
  const toolsRoot = $('#tt-tools');
  const flowRoot = $('#tt-flow');
  if (!toolsRoot || !flowRoot) return;
  const selected = selectedAgent();
  const scope = ttScope(selected ? selected.agent_id : null);
  const te = state.toolEvents;

  let toolsHtml;
  if (scope.kind === 'loading') {
    toolsHtml = `<div class="tt-empty"><b>工具数据读取中</b><span>正在读 /api/tool-events…</span></div>`;
  } else if (scope.kind === 'error') {
    toolsHtml = `<div class="tt-empty tt-empty--bad"><b>工具数据读取失败</b><span>${esc(scope.error || '接口没有返回')}；不拿 0 冒充。</span></div>`;
  } else if (scope.kind === 'collecting') {
    toolsHtml = `<div class="tt-empty tt-empty--collecting"><b><i class="tt-dot"></i><i class="tt-dot"></i><i class="tt-dot"></i>工具数据采集中</b><span>采集器还没跑。运行 <code>npm run tools:collect</code> 后刷新；在采集完成前不画任何数字。</span></div>`;
  } else if (scope.kind === 'empty') {
    toolsHtml = `<div class="tt-empty"><b>采集完成，暂无工具调用</b><span>tool_events 里没有这个项目的记录。不补假数据。</span></div>`;
  } else {
    const groups = scope.tools.slice(0, scope.note ? 2 : 3);
    const recent = scope.recent.slice(0, scope.note ? 2 : 5);
    toolsHtml = `
      <div class="tt-tools-list">
        ${groups.map((t) => {
          const sample = t.scopeRecent[0] || t.recent[0] || null;
          return `<div class="tt-tool">
            <div class="tt-tool__head"><b>${esc(String(t.tool_name).toUpperCase().slice(0, 18))}</b><span>×${fmtInt(t.scopeCount)}</span><em>${esc(relTime(t.last_ts))}</em></div>
            <div class="tt-tool__sample" title="${esc(sample?.target || '')}">${esc(sample?.target || '—')}</div>
          </div>`;
        }).join('')}
      </div>
      <div class="tt-code">
        <div class="tt-code__head"><span>最近调用</span><em>${recent.length ? esc(relTime(recent[0].ts)) : '—'}</em></div>
        <div class="tt-code__body">
          ${recent.length ? recent.map((e, i) => `<div class="tt-code__line" style="--i:${i}"><i>${String(i + 1).padStart(2, '0')}</i><b>${esc(String(e.tool_name).toUpperCase().slice(0, 12))}</b><code title="${esc(e.target || '')}">${esc(e.target || '—')}</code></div>`).join('') : '<div class="tt-code__line"><i>--</i><code>没有最近调用</code></div>'}
          <span class="tt-cursor" aria-hidden="true"></span>
        </div>
      </div>`;
  }

  toolsRoot.innerHTML = `
    <header class="tt-panel__head">
      <h3>工具调用流</h3>
      <span>${scope.kind === 'agent' ? esc(meta(scope.agentId).name) : scope.kind === 'all' ? '全部 Agent' : 'tool_events'}</span>
    </header>
    ${scope.note ? `<p class="tt-panel__note">${esc(scope.note)}</p>` : ''}
    ${toolsHtml}
    <footer class="tt-panel__foot">${te?.last_run_at ? `采集于 ${esc(relTime(te.last_run_at))} · ${fmtInt(te.total_all)} 条` : '采集器未运行'}</footer>`;

  const c = counts();
  const p = pct(c.done, c.total);
  const flowCount = te?.rate_15m?.total ?? 0;
  const fillTop = 92 + (96 - (96 * p) / 100);
  flowRoot.innerHTML = `
    <header class="tt-panel__head">
      <h3>数据流</h3>
      <span>真实值</span>
    </header>
    <svg class="tt-pipe" viewBox="0 0 196 232" role="img" aria-label="数据流管道与任务推进液位">
      <path class="tt-pipe__line" d="M18 18 H150 Q166 18 166 34 V86" fill="none" stroke="#DED3C1" stroke-width="3"/>
      <path class="tt-pipe__flow" d="M18 18 H150 Q166 18 166 34 V86" fill="none" stroke="#E2B75D" stroke-width="1.4" stroke-dasharray="4 7"/>
      <path class="tt-pipe__line" d="M18 50 H136 Q152 50 152 66 V86" fill="none" stroke="#DED3C1" stroke-width="3"/>
      <path class="tt-pipe__flow tt-pipe__flow--slow" d="M18 50 H136 Q152 50 152 66 V86" fill="none" stroke="#C9A45E" stroke-width="1.2" stroke-dasharray="3 8"/>
      <path class="tt-pipe__line" d="M18 82 H120 Q136 82 136 98 V86" fill="none" stroke="#E4DACB" stroke-width="2.4"/>
      <path class="tt-pipe__flow tt-pipe__flow--fast" d="M18 82 H120 Q136 82 136 98 V86" fill="none" stroke="#D7B16B" stroke-width="1.1" stroke-dasharray="2 7"/>
      <rect x="72" y="86" width="80" height="102" rx="11" fill="#FBF7EF" stroke="#D8CBB8" stroke-width="1.4"/>
      <rect x="78" y="${fillTop.toFixed(1)}" width="68" height="${((96 * p) / 100).toFixed(1)}" rx="7" fill="#E4C58E" opacity=".9"/>
      <line x1="78" y1="${fillTop.toFixed(1)}" x2="146" y2="${fillTop.toFixed(1)}" stroke="#B9975B" stroke-width="1.2"/>
      <text x="112" y="141" text-anchor="middle" class="tt-tank__value">${c.total ? `${p}%` : '—'}</text>
      <text x="112" y="156" text-anchor="middle" class="tt-tank__label">任务推进</text>
      <text x="112" y="205" text-anchor="middle" class="tt-tank__label">${c.done} / ${c.total} 步</text>
    </svg>
    <div class="tt-flow__facts">
      <span><i>工具事件</i><b>${te?.collecting ? '—' : fmtInt(te?.total_all || 0)}</b></span>
      <span><i>15 分钟</i><b>${te?.collecting ? '—' : fmtInt(flowCount)}</b></span>
    </div>
    <p class="tt-flow__note">液位 = 任务 done/total（真实）；管道流动 = CSS dashoffset，不是随机数据。</p>`;
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
      const next = state.selectedTaskId === btn.dataset.task ? null : btn.dataset.task;
      state.selectedTaskId = next;
      state.showUnlinked = false;
      state.preview = null;
      if (next) {
        state.selectedAgentId = null;
        state.deliverables = null;
        state.deliverablesFor = null;
        loadDeliverables(next);
      } else {
        state.deliverables = null;
        state.deliverablesFor = null;
        ensureSelection();
      }
      renderAll();
      showToast(next ? `中间显示交付物 · ${next}` : '已返回 Agent 详情');
    });
  });
}

/* ---------- 渲染：中央交付物时间线 ---------- */
function dlStatusTone(task) {
  if (!task) return 'unknown';
  if (task.status === 'completed') return 'ok';
  if (task.status === 'running') return 'live';
  if (['failed', 'blocked', 'interrupted'].includes(task.status)) return 'bad';
  return 'unknown';
}

function goalCardHtml(goal, task) {
  const g = goal || {};
  const judgement = g.judgement || 'no_goal';
  const label = DL_JUDGEMENT[judgement] || g.judgement_label || '未设定目标';
  const criteria = g.criteria || { passed: 0, total: 0 };
  const ck = g.checkpoints || { passed: 0, total: 0 };
  const progress = (task && task.progress) || { done: 0, total: 0 };
  const gaps = Array.isArray(g.gaps) ? g.gaps : [];
  const gapText = judgement === 'no_goal'
    ? '未设定目标（acceptance 为空，不编百分比）'
    : gaps.length ? gaps.join('；') : '无未通过项';
  return `<div class="goal-card">
    <div class="goal-card__head"><span>目标</span><span class="goal-badge" data-judgement="${esc(judgement)}">${esc(label)}</span></div>
    <p class="goal-card__goal ${g.goal ? '' : 'is-empty'}">${g.goal ? esc(g.goal) : '未设定目标'}</p>
    <div class="goal-card__metrics">
      <div class="goal-card__metric"><i>达成度 · 通过检查点 / 总检查点</i><b>${ck.passed} / ${ck.total}</b></div>
      <div class="goal-card__metric"><i>验收项 · 通过 / 总数</i><b>${criteria.passed} / ${criteria.total}${g.percent == null ? '' : ` · ${g.percent}%`}</b></div>
      <div class="goal-card__metric"><i>任务进度</i><b>${progress.done} / ${progress.total} 步</b></div>
    </div>
    <div class="goal-card__gaps ${gaps.length || judgement === 'no_goal' ? '' : 'is-clear'}"><b>差距</b> ${esc(gapText)}</div>
  </div>`;
}

function dlItemHtml(item) {
  const sha = item.content_ref && /^git:/i.test(item.content_ref) ? item.content_ref.slice(4) : null;
  const label = item.display_path || (sha ? `git show ${sha.slice(0, 8)}` : item.title);
  const missing = item.path && item.exists === false;
  return `<li class="dl-item">
    <div class="dl-item__main">
      <span class="dl-item__title">${esc(item.title)}</span>
      <button type="button" class="dl-item__path" data-deliverable="${esc(item.deliverable_id)}" title="在右侧打开内容预览">${esc(missing ? `${label}（文件不存在）` : label)}</button>
    </div>
    <span class="dl-item__status" data-status="${esc(item.status)}">${esc(item.status_label)}</span>
    <time datetime="${esc(item.created_at || '')}">${esc(fmtDate(item.created_at))}</time>
  </li>`;
}

function timelineHtml(groups) {
  return DL_TIMELINE.map((k) => {
    const items = Array.isArray(groups && groups[k.kind]) ? groups[k.kind] : [];
    const empty = items.length === 0;
    const expanded = state.expandedKinds.has(k.kind);
    const shown = expanded ? items : items.slice(0, 4);
    const more = items.length - shown.length;
    return `<li class="dl-kind ${empty ? 'is-empty' : ''}" data-kind="${k.kind}">
      <div class="dl-kind__rail"><span class="dl-kind__no">${k.no}</span><span class="dl-kind__line"></span></div>
      <div class="dl-kind__body">
        <header class="dl-kind__head"><h2>${esc(k.label)}</h2><span class="dl-kind__count">${empty ? '未产生' : `${items.length} 件`}</span></header>
        ${empty
          ? `<p class="dl-kind__empty">未产生</p><p class="dl-kind__hint">${esc(k.hint)} · 没有真实来源就不填</p>`
          : `<ul class="dl-items">${shown.map(dlItemHtml).join('')}</ul>${more > 0
            ? `<button type="button" class="dl-more" data-kind-expand="${k.kind}">还有 ${more} 件 · 展开</button>`
            : ''}`}
      </div>
    </li>`;
  }).join('');
}

function techDetailsHtml(d) {
  const te = state.toolEvents;
  const tools = (te && Array.isArray(te.tools) ? te.tools : []).slice(0, 3)
    .map((t) => `${t.tool_name} ${fmtInt(t.count)}`).join(' · ');
  const last = te && te.tools && te.tools[0] && te.tools[0].recent && te.tools[0].recent[0];
  const rows = [
    ['工具事件总数', te && !te.collecting && te.total_all != null ? fmtInt(te.total_all) : '—'],
    ['最近 15 分钟', te && !te.collecting && te.rate_15m ? fmtInt(te.rate_15m.total) : '—'],
    ['工具调用 Top3', tools || '—'],
    ['最近一次调用', last ? `${last.tool_name || '—'} · ${last.target || ''}`.slice(0, 80) : '—'],
    ['任务检查点', `${d.goal?.checkpoints?.passed ?? 0} / ${d.goal?.checkpoints?.total ?? 0}`],
    ['交付物记录', String(d.total ?? Object.values(d.counts || {}).reduce((n, x) => n + (Number(x) || 0), 0))],
    ['采集脚本', 'scripts/collect-deliverables.mjs'],
    ['口径', '主视图只放交付物；工具调用 / 进程 / 额度折叠在这里'],
  ];
  return rows.map(([k, v]) => `<div class="dl-tech__row"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');
}

function renderDeliverables() {
  const main = $('#deliverables-main');
  const board = $('.board-main');
  if (!main || !board) return;
  const task = selectedTask();
  const show = Boolean(task || state.showUnlinked);
  main.hidden = !show;
  board.hidden = show;
  if (!show) return;

  const hero = $('#dl-hero');
  const timeline = $('#dl-timeline');
  const tech = $('#dl-tech');
  const techBody = $('#dl-tech-body');
  const unlinked = $('#dl-unlinked');

  if (state.showUnlinked) {
    const data = state.unlinked;
    const counts = data?.counts || {};
    const total = data?.total ?? Object.values(counts).reduce((n, x) => n + (Number(x) || 0), 0);
    const parts = DL_TIMELINE.map((k) => `${k.label} ${counts[k.kind] || 0}`).join(' · ');
    hero.innerHTML = `<div class="dl-unlinked__head">
      <h1>未关联交付物${total ? ` · ${total} 条` : ''}</h1>
      <p>这些是真实文件/commit/评审，但没有匹配到任务标识，所以 task_id 留空，不硬塞给任何任务。${parts ? `<br>${esc(parts)}` : ''}</p>
    </div>`;
    timeline.innerHTML = state.unlinkedLoading
      ? '<li class="dl-kind"><div class="dl-kind__body"><p class="dl-kind__hint">正在读取 /api/deliverables …</p></div></li>'
      : state.unlinkedError
        ? `<li class="dl-kind"><div class="dl-kind__body"><p class="dl-kind__empty">读取失败：${esc(state.unlinkedError)}</p></div></li>`
        : timelineHtml(data?.groups || {});
    tech.hidden = true;
    unlinked.hidden = true;
    return;
  }

  tech.hidden = false;
  unlinked.hidden = true;
  if (state.deliverablesLoading && (!state.deliverables || state.deliverablesFor !== task.task_id)) {
    hero.innerHTML = `<div class="dl-hero__eyebrow"><span>交付物 · 任务</span><code>${esc(task.task_id)}</code></div>
      <h1>${esc(task.title || task.task_id)}</h1>
      <div class="goal-card"><p class="goal-card__goal">正在读取 /api/deliverables … 没有记录会显示「未产生」，不填假数据。</p></div>`;
    timeline.innerHTML = '';
    techBody.innerHTML = '';
    return;
  }
  if (state.deliverablesError) {
    hero.innerHTML = `<div class="dl-hero__eyebrow"><span>交付物 · 任务</span><code>${esc(task.task_id)}</code></div>
      <h1>${esc(task.title || task.task_id)}</h1>
      <div class="goal-card"><p class="goal-card__goal is-empty">交付物读取失败：${esc(state.deliverablesError)}</p></div>`;
    timeline.innerHTML = '';
    techBody.innerHTML = '';
    return;
  }
  const d = state.deliverables;
  if (!d || state.deliverablesFor !== task.task_id) return;

  hero.innerHTML = `<div class="dl-hero__eyebrow"><span>交付物 · 任务</span><code>${esc(d.task?.task_id || task.task_id)}</code>
      <span class="dl-task-status" data-tone="${dlStatusTone(d.task)}">${esc(taskLabel(d.task || task))}</span></div>
    <h1>${esc(d.task?.title || task.title || task.task_id)}</h1>
    ${goalCardHtml(d.goal, d.task)}`;
  timeline.innerHTML = timelineHtml(d.groups || {});
  techBody.innerHTML = techDetailsHtml(d);
}

/* ---------- 渲染：右侧一整列 ---------- */
/* 选中任务 → 任务详情（本文件画）；选中 Agent → 与它的对话（board-chat.js 画，流式更新时不整块重绘） */
function renderDetail() {
  const root = $('#detail-panel');
  if (!root) return;

  // 点交付物路径 → 右侧切内容预览；返回后回到任务详情。
  if (state.preview) {
    if (window.SodaChat) SodaChat.hide();
    root.setAttribute('aria-live', 'polite');
    root.classList.remove('is-chat');
    root.innerHTML = previewHtml(state.preview);
    root.classList.toggle('is-scrollable', root.scrollHeight > root.clientHeight + 1);
    return;
  }

  if (state.showUnlinked) {
    if (window.SodaChat) SodaChat.hide();
    root.setAttribute('aria-live', 'polite');
    root.classList.remove('is-chat');
    root.innerHTML = unlinkedDetailHtml();
    root.classList.toggle('is-scrollable', root.scrollHeight > root.clientHeight + 1);
    return;
  }

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

/* ---------- 右侧：交付物内容预览 / 未关联说明 ---------- */
function previewHtml(p) {
  if (!p || p.loading) {
    return `<div class="preview"><div class="preview__top"><button type="button" class="preview__back" data-preview-back>← 返回任务</button><span class="preview__kind">读取中</span></div>
      <div class="preview__empty">正在读取交付物内容 …</div></div>`;
  }
  if (p.error) {
    return `<div class="preview"><div class="preview__top"><button type="button" class="preview__back" data-preview-back>← 返回任务</button><span class="preview__kind">读取失败</span></div>
      <h2>预览失败</h2><div class="preview__note">${esc(p.error)}</div></div>`;
  }
  const d = p.deliverable || {};
  const kindLabel = DL_KIND_LABEL[d.kind] || d.kind_label || d.kind || '交付物';
  const meta = [];
  if (p.bytes != null) meta.push(`${fmtInt(p.bytes)} B`);
  if (p.modifiedAt || d.created_at) meta.push(`更新 ${fmtDate(p.modifiedAt || d.created_at)}`);
  if (p.truncated) meta.push('已截断');
  let body = '';
  if (p.preview === 'markdown') body = `<div class="preview__body">${renderMarkdown(p.text || '')}</div>`;
  else if (p.preview === 'image') body = `<img class="preview__img" src="${esc(p.url)}" alt="${esc(p.title || '')}">`;
  else if (p.preview === 'diff') body = diffHtml(p.text || '');
  else if (p.preview === 'code') body = `<pre class="preview__code">${esc(p.text || '')}</pre>`;
  else if (p.preview === 'text') body = `<pre class="preview__text">${esc(p.text || '')}</pre>`;
  else body = `<div class="preview__note">${esc(p.note || '这个文件没有可显示的文本内容。')}</div>`;
  return `<div class="preview">
    <div class="preview__top"><button type="button" class="preview__back" data-preview-back>← 返回任务</button><span class="preview__kind">${esc(kindLabel)} · ${esc(p.preview || '')}</span></div>
    <h2>${esc(p.title || d.title || '交付物预览')}</h2>
    <div class="preview__path">${esc(p.display_path || p.path || '')}</div>
    <div class="preview__meta">${esc(meta.join(' · '))}</div>
    ${body}
    ${p.note ? `<div class="preview__note">${esc(p.note)}</div>` : ''}
  </div>`;
}

function diffHtml(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = lines.map((line) => {
    let cls = 'diff-line';
    if (/^(diff --git|index |--- |\+\+\+ )/.test(line)) cls += ' diff-line--meta';
    else if (/^@@/.test(line)) cls += ' diff-line--hunk';
    else if (/^\+/.test(line)) cls += ' diff-line--add';
    else if (/^-/.test(line)) cls += ' diff-line--del';
    return `<span class="${cls}">${esc(line) || ' '}</span>`;
  }).join('');
  return `<pre class="preview__diff">${out}</pre>`;
}

function unlinkedDetailHtml() {
  const n = state.unlinked?.total;
  return `<div class="detail__top">
      <span class="agent-icon" aria-hidden="true"><svg width="30" height="30" viewBox="0 0 20 20" fill="none"><path d="M3 4.4h6l1.4 1.6H17v9.6H3z" stroke="#4A4237" stroke-width="1.4" stroke-linejoin="round"/><path d="M6.6 9.2h6.8M6.6 12h4.4" stroke="#4A4237" stroke-width="1.4" stroke-linecap="round"/></svg></span>
      <div><div class="detail__name">未关联交付物</div><div class="detail__sub">task_id = NULL</div></div>
    </div>
    <div class="detail__note">${state.unlinkedLoading ? '正在读取 …' : state.unlinkedError ? `读取失败：${esc(state.unlinkedError)}` : `共 ${n == null ? '—' : n} 条真实交付物没有匹配到任务标识。它们留在未关联区，不硬塞给任何任务。`}</div>
    <section class="detail__section"><div class="detail__label">怎么处理</div>
      <div class="detail__value">在中间主区逐类展开看；点路径在右侧预览。要归属到任务，需要文件路径或 commit message 里出现任务标识，采集器下次运行才会重新挂接。</div>
    </section>`;
}

/** 极简 Markdown → HTML：只用于右列预览，输入先 esc，绝不把原文当 HTML 执行。 */
function inlineMd(s) {
  const codes = [];
  let out = String(s || '').replace(/`([^`]+)`/g, (m, code) => {
    codes.push(code);
    return `\u0001${codes.length - 1}\u0001`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, label, url) => (
    /^(https?:|\/|#|\.)/.test(url)
      ? `<a href="${url}" target="_blank" rel="noopener">${label}</a>`
      : label
  ));
  out = out.replace(/\u0001(\d+)\u0001/g, (m, i) => `<code>${codes[Number(i)] || ''}</code>`);
  return out;
}

function renderMarkdown(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  let html = '';
  let list = null;
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();
    if (/^```/.test(line)) {
      closeList();
      const buf = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i].trim())) { buf.push(lines[i]); i += 1; }
      i += 1;
      html += `<pre><code>${esc(buf.join('\n'))}</code></pre>`;
      continue;
    }
    if (!line) { closeList(); i += 1; continue; }
    if (/^\|.*\|$/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())) {
      closeList();
      const cells = (row) => row.trim().slice(1, -1).split('|').map((c) => c.trim());
      const head = cells(line);
      const rows = [];
      i += 2;
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) { rows.push(cells(lines[i])); i += 1; }
      html += `<table><thead><tr>${head.map((c) => `<th>${inlineMd(esc(c))}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inlineMd(esc(c))}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeList();
      const level = h[1].length;
      html += `<h${level}>${inlineMd(esc(h[2]))}</h${level}>`;
      i += 1;
      continue;
    }
    if (/^>\s?/.test(line)) {
      closeList();
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) { buf.push(lines[i].trim().replace(/^>\s?/, '')); i += 1; }
      html += `<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`;
      continue;
    }
    if (/^[-*+]\s+/.test(line)) {
      if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; }
      html += `<li>${inlineMd(esc(line.replace(/^[-*+]\s+/, '')))}</li>`;
      i += 1;
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; }
      html += `<li>${inlineMd(esc(line.replace(/^\d+\.\s+/, '')))}</li>`;
      i += 1;
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(line)) { closeList(); html += '<hr>'; i += 1; continue; }
    closeList();
    const buf = [line];
    i += 1;
    while (i < lines.length) {
      const next = lines[i].trim();
      if (!next || /^(#{1,6}\s|```|>|\||[-*+]\s|\d+\.\s)/.test(next) || /^(-{3,}|\*{3,})$/.test(next)) break;
      buf.push(next);
      i += 1;
    }
    html += `<p>${inlineMd(esc(buf.join(' ')))}</p>`;
  }
  closeList();
  return html;
}

function taskDetailHtml(t) {
  const done = Number(t.progress?.done) || 0;
  const total = Number(t.progress?.total) || 0;
  const p = pct(done, total);
  const dl = state.deliverables && state.deliverablesFor === t.task_id ? state.deliverables : null;
  const goal = dl ? dl.goal : null;
  const goalLabel = goal ? (DL_JUDGEMENT[goal.judgement] || goal.judgement_label || '—') : '读取中';
  const remaining = Array.isArray(t.remaining) ? t.remaining : [];
  const artifacts = Array.isArray(t.latest_artifacts) ? t.latest_artifacts.slice(0, 2) : [];
  const recent = dl
    ? Object.values(dl.groups || {}).flat()
      .filter((x) => x && x.deliverable_id)
      .sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0))
      .slice(0, 4)
    : [];
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
    <div class="detail__note"><b>${esc(t.title || t.task_id)}</b><br>${esc(t.status_reason || '没有状态说明。')}<br><span class="detail__back">六类交付物已显示在中间主区 · 点路径在右侧预览</span></div>

    ${goal ? `<section class="detail__section">
      <div class="detail__label">目标达成<span>${esc(goalLabel)}</span></div>
      <div class="detail__value">${goal.goal ? esc(goal.goal) : '未设定目标'}</div>
      <div class="kv-list">
        <div class="kv-row"><span>达成度</span><b>${goal.checkpoints?.passed ?? 0} / ${goal.checkpoints?.total ?? 0} 检查点</b></div>
        <div class="kv-row"><span>验收项</span><b>${goal.criteria?.passed ?? 0} / ${goal.criteria?.total ?? 0}${goal.percent == null ? '' : ` · ${goal.percent}%`}</b></div>
        <div class="kv-row"><span>差距</span><b>${(goal.gaps || []).length ? esc(goal.gaps.join('；')) : '无'}</b></div>
      </div>
    </section>` : ''}

    <section class="detail__section">
      <div class="detail__label">进度<span>${p}%</span></div>
      <div class="detail__value">${done} / ${total} 步完成</div>
      <div class="kv-list">
        <div class="kv-row"><span>当前步骤</span><b>${esc(step)}</b></div>
        <div class="kv-row"><span>剩余步骤</span><b>${remaining.length ? remaining.map((r) => esc(r)).join(' / ') : '—'}</b></div>
        <div class="kv-row"><span>交付物</span><b>${dl ? (dl.total || 0) : (Number(t.artifact_count) || 0)} 个</b></div>
        <div class="kv-row"><span>证据源</span><b class="mono">${esc(evidenceLabel(t.evidence_source))}</b></div>
        <div class="kv-row"><span>观测于</span><b>${esc(relTime(t.observed_at))}</b></div>
      </div>
    </section>

    <section class="detail__section">
      <div class="detail__label">最近交付物<span>${dl ? `${dl.total || 0} 件` : ''}</span></div>
      <div class="detail__artifacts">${recent.length ? recent.map((a) => (
        `<div class="detail__artifact"><span title="${esc(a.display_path || a.title || '')}">${esc(a.title || a.display_path || '')}</span><span>${esc(a.kind_label || '')}</span></div>`
      )).join('') : artifacts.length ? artifacts.map((a) => {
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

  const rate = $('#tool-rate');
  if (rate) {
    const te = state.toolEvents;
    if (state.toolEventsError) {
      rate.innerHTML = `<div class="empty-note">工具采集读取失败：${esc(state.toolEventsError)}。不画 0 柱。</div>`;
    } else if (!te || te.collecting) {
      rate.innerHTML = `<div class="empty-note">工具数据采集中。采集器跑过之前，这里没有数字。</div>`;
    } else {
      const buckets = te.rate_15m?.buckets || [];
      const max = Math.max(1, ...buckets.map((b) => Number(b.count) || 0));
      const total = Number(te.rate_15m?.total) || 0;
      rate.innerHTML = `
        <div class="tool-rate__sum"><b>${fmtInt(total)}</b><span>次 / 最近 15 分钟</span></div>
        <div class="tool-rate__bars" role="img" aria-label="最近 15 分钟每分钟工具调用次数">
          ${buckets.map((b) => {
            const c = Number(b.count) || 0;
            const h = c ? Math.max(6, Math.round((c / max) * 100)) : 2;
            const t = new Date(b.start_ts).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
            return `<span class="tool-rate__bar" data-zero="${c ? '0' : '1'}" style="height:${h}%" title="${t} · ${c} 次"></span>`;
          }).join('')}
        </div>
        <div class="tool-rate__axis"><span>15 分钟前</span><span>现在</span></div>`;
    }
  }
}

/* ---------- 总渲染 ---------- */
function renderAll() {
  renderMeta();
  renderTurntable();
  renderTasks();
  renderDeliverables();
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

  // 交付物：点路径 → 右侧预览；返回；展开某类全部
  document.addEventListener('click', (e) => {
    const open = e.target.closest('[data-deliverable]');
    if (open) {
      e.preventDefault();
      openPreview(open.dataset.deliverable);
      return;
    }
    const back = e.target.closest('[data-preview-back]');
    if (back) {
      e.preventDefault();
      closePreview();
      return;
    }
    const more = e.target.closest('[data-kind-expand]');
    if (more) {
      e.preventDefault();
      state.expandedKinds.add(more.dataset.kindExpand);
      renderDeliverables();
      return;
    }
    const un = e.target.closest('#unlinked-entry');
    if (un) {
      e.preventDefault();
      state.showUnlinked = !state.showUnlinked;
      state.preview = null;
      state.selectedTaskId = null;
      state.selectedAgentId = null;
      if (state.showUnlinked) loadUnlinked();
      renderAll();
      showToast(state.showUnlinked ? '中间显示未关联交付物' : '已返回 Agent 状态');
    }
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
  refreshUnlinkedSummary();
  if (state.loadError) showToast(`数据读取失败：${state.loadError}`);
}

init();
