const get = (id) => document.getElementById(id);
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);
const urlPart = encodeURIComponent;
const agentIcons = new Set(['claude', 'codex', 'dsh', 'hermes']);
const statuses = {
  running: ['进行中', 'active'], waiting_human: ['待拍板', 'attention'],
  blocked: ['已暂停', 'attention'], switch_agent: ['待换人', 'attention'],
  completed: ['已完成', 'idle'], failed: ['失败', 'attention'], archived: ['已归档', 'unknown'],
};
const stepLabels = { pending: '待开始', running: '进行中', done: '已完成', failed: '失败', skipped: '已跳过' };
const kindLabels = { cli: 'CLI', api: 'API', external: '外部接入' };
const sourceLabels = { external: '外部日志', executor: '执行器', process_probe: '进程探测', system: '系统', none: '无证据' };
const zone = 'Asia/Shanghai';
const dateFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: zone, month: 'long', day: 'numeric', weekday: 'long' });
const updateFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: zone, hour: '2-digit', minute: '2-digit' });
const activityFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: zone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const data = {
  roster: { path: '/api/agents?all=1', field: 'agents' },
  occupancy: { path: '/api/agents/status-v2', field: 'agents' },
  runs: { path: '/api/workflow/runs', field: 'runs' },
  decisions: { path: '/api/office/decisions', field: 'items' },
};
const dialog = get('dialog');
let currentDialog;
let returnFocus;
let inspectorSelection;
let inspectorVersion;
let focusInspectorAfterClose = false;
let refreshJob;
let submittedRun;

async function api(path, options = {}) {
  const response = await fetch(path, { cache: 'no-store', signal: AbortSignal.timeout(15000), ...options });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.error || `请求失败（${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function timeLabel(value, formatter) {
  const time = new Date(value || NaN);
  return Number.isNaN(time.valueOf()) ? '—' : formatter.format(time);
}

function dateStamp() {
  const now = new Date();
  get('today').dateTime = new Intl.DateTimeFormat('sv-SE', { timeZone: zone }).format(now);
  get('today').textContent = dateFormat.format(now);
}

function setMarkup(id, html) {
  const target = get(id);
  if (target.renderedHtml === html) return;
  const focused = target.contains(document.activeElement) ? document.activeElement : null;
  target.innerHTML = html;
  target.renderedHtml = html;
  if (focused?.dataset.action) {
    const replacement = Array.from(target.querySelectorAll('[data-action]')).find((button) =>
      button.dataset.action === focused.dataset.action && button.dataset.id === focused.dataset.id);
    replacement?.focus({ preventScroll: true });
  }
}

function badge(label, tone) {
  return `<span class="badge" data-tone="${tone}"><i class="lamp" aria-hidden="true"></i>${escape(label)}</span>`;
}

function agentStatus(agent) {
  if (agent.enabled === false) return ['已停用', 'unknown'];
  if (agent.availability?.available === false) return ['不可用', 'attention'];
  switch (agent.execution?.instance_status) {
    case 'running': return ['执行中', 'active'];
    case 'idle': return ['待命', 'idle'];
    case 'waiting': return ['等待中', 'attention'];
    case 'blocked': return ['受阻', 'attention'];
    case 'failed': return ['执行失败', 'attention'];
    case 'completed': return ['已完成执行', 'idle'];
    default: return ['状态未知', 'unknown'];
  }
}

function agents() {
  const roster = new Map((data.roster.value || []).map((agent) => [agent.agent_id, agent]));
  for (const live of data.occupancy.value || []) {
    const configured = roster.get(live.agent_id);
    roster.set(live.agent_id, {
      ...configured, ...live,
      execution: data.occupancy.error ? null : live.execution,
      availability: data.occupancy.error ? null : live.availability,
      task: data.occupancy.error ? null : live.task,
    });
  }
  return [...roster.values()].sort((a, b) => (a.sort_index || 0) - (b.sort_index || 0));
}

function avatar(agent) {
  const id = agent.agent_id;
  const monogram = [...(agent.display_name || id)][0] || '?';
  return `<span class="avatar" data-agent="${escape(id)}" aria-hidden="true">${agentIcons.has(id)
    ? `<img src="/icons/${id}.svg" alt="" width="22" height="22">` : escape(monogram.toUpperCase())}</span>`;
}

function renderAgents() {
  const roster = agents();
  const seated = roster.filter((agent) => agent.enabled !== false);
  const sourceReady = data.roster.value || data.occupancy.value;
  get('roster-count').textContent = data.roster.error || !data.roster.value ? '—' : roster.length;
  get('floor-count').textContent = sourceReady ? `${seated.length} 个工位` : '—';
  const emptyText = data.roster.error || data.occupancy.error ? '暂时读不到 Agent 名册。' : '当前还没有 Agent。';
  setMarkup('roster', roster.map((agent) => {
    const [status, tone] = agentStatus(agent);
    return `<button class="roster-item" type="button" data-action="agent" data-id="${escape(agent.agent_id)}">
      ${avatar(agent)}<span class="roster-name">${escape(agent.display_name || agent.agent_id)}</span>
      <i class="lamp" data-tone="${tone}" title="${status}" aria-hidden="true"></i><span class="sr-only">${status}</span>
    </button>`;
  }).join('') || `<p class="muted">${emptyText}</p>`);
  setMarkup('desks', seated.map((agent) => {
    const [status, tone] = agentStatus(agent);
    return `<button class="desk" type="button" data-action="agent" data-id="${escape(agent.agent_id)}" data-tone="${tone}">
      <span class="desk-scene" aria-hidden="true">
        <span class="chair"></span><span class="desktop"><i class="monitor"></i><i class="keyboard"></i><i class="cup"></i></span>
        ${avatar(agent)}
      </span>
      <span class="desk-name">${escape(agent.display_name || agent.agent_id)}</span>
      ${badge(status, tone)}
    </button>`;
  }).join('') || `<p class="empty">${seated.length === 0 && roster.length ? '当前没有启用的 Agent。' : emptyText}</p>`);
}

function projects() {
  return (data.runs.value || []).filter((run) => !run.archived_at && run.status !== 'archived');
}

function view() {
  const hash = location.hash.slice(1);
  return hash === 'projects' || hash === 'focus' ? hash : 'floor';
}

function dateOrder(a, b) {
  return (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0);
}

function renderProjects() {
  const runs = projects();
  const all = view() === 'projects';
  const filter = get('project-filter').value;
  const ordered = [...runs].sort((a, b) => Number(a.status === 'completed') - Number(b.status === 'completed') || dateOrder(a, b));
  const visible = all ? ordered.filter((run) => filter === 'all' || (run.status === 'completed') === (filter === 'completed')) : ordered.slice(0, 3);
  const hasRuns = Boolean(data.runs.value) && !data.runs.error;
  get('nav-project-count').textContent = hasRuns ? runs.length : '—';
  get('running-count').textContent = hasRuns ? runs.filter((run) => run.status === 'running').length : '—';
  get('completed-count').textContent = hasRuns ? runs.filter((run) => run.status === 'completed').length : '—';
  setMarkup('rail-projects', ordered.map((run) => {
    const [label, tone] = statuses[run.status] || ['状态未知', 'unknown'];
    return `<button type="button" class="rail-project" data-action="project" data-id="${escape(run.run_id)}">
      <i class="lamp" data-tone="${tone}" aria-hidden="true"></i><span>${escape(run.title || '未命名项目')}</span><span class="sr-only">${label}</span>
    </button>`;
  }).join('') || `<p class="muted">${data.runs.error ? '暂时读不到项目。' : '没有项目。'}</p>`);
  setMarkup('project-list', visible.map((run) => {
    const [label, tone] = statuses[run.status] || ['状态未知', 'unknown'];
    const total = run.progress?.total || run.total_steps || 0;
    const done = run.progress?.done ?? run.done_steps ?? 0;
    const stage = run.current_step_name || run.step_name || '等待进入流程';
    return `<button type="button" class="project-row" data-action="project" data-id="${escape(run.run_id)}">
      <span class="project-icon" data-tone="${tone}" aria-hidden="true">${tone === 'idle' ? '✓' : '↳'}</span>
      <span class="project-text"><strong>${escape(run.title || '未命名项目')}</strong><span>${escape(stage)}</span></span>
      ${total > 0 ? `<span class="project-progress"><progress max="${escape(total)}" value="${escape(done)}" aria-label="已完成 ${escape(done)} 步，共 ${escape(total)} 步"></progress><span>${escape(done)}/${escape(total)}</span></span>` : ''}
      ${badge(label, tone)}<span class="chevron" aria-hidden="true">›</span>
    </button>`;
  }).join('') || `<p class="empty">${data.runs.error ? '项目暂时读取失败。' : '没有符合条件的项目。'}</p>`);
  setMarkup('activity', [...runs].filter((run) => run.updated_at).sort(dateOrder).slice(0, 3).map((run) => {
    const [label, tone] = statuses[run.status] || ['状态未知', 'unknown'];
    return `<button class="activity-item" type="button" data-action="project" data-id="${escape(run.run_id)}">
      <i class="lamp" data-tone="${tone}" aria-hidden="true"></i><span><strong>${escape(run.title || '未命名项目')}</strong>
      <span>${label} · <time datetime="${escape(run.updated_at)}">${timeLabel(run.updated_at, activityFormat)}</time></span></span>
    </button>`;
  }).join('') || `<p class="muted">${data.runs.error ? '动态暂时读取失败。' : '还没有项目更新。'}</p>`);
}

function decisions() {
  return [
    ...projects().filter((run) => run.waiting_for_leo).map((run) => ({ action: 'project', id: run.run_id, title: run.title, step: run.current_step_name })),
    ...(data.decisions.value || []).map((item) => ({ action: 'decision', id: `${item.taskId}:${item.stepKey}`, title: item.taskTitle, step: item.stepName })),
  ];
}

function decisionRows(items) {
  return items.map(({ action, id, title, step }) => `<button class="decision-item" type="button" data-action="${action}" data-id="${escape(id)}">
    <span><strong>${escape(title || '待确认事项')}</strong><span>${escape(step || '等待确认')}</span></span><span class="chevron" aria-hidden="true">›</span>
  </button>`).join('');
}

function renderDecisions() {
  const items = decisions();
  const ready = Boolean(data.decisions.value && data.runs.value) && !data.decisions.error && !data.runs.error;
  const count = ready ? items.length : '—';
  get('decision-count').textContent = count;
  get('inbox-count').textContent = count;
  const note = ready ? '' : '<p class="muted">部分决策数据暂不可用。</p>';
  const more = items.length > 2 ? `<button class="text-link decision-more" type="button" data-action="decisions">查看全部 ${ready ? items.length : ''}<span aria-hidden="true"> →</span></button>` : '';
  setMarkup('decisions', decisionRows(items.slice(0, 2)) + more + note || '<p class="quiet-state">目前没有待拍板事项。</p>');
}

function setView() {
  const current = view();
  const all = current === 'projects';
  const focused = current === 'focus';
  document.body.dataset.view = current;
  get('page-title').textContent = all ? '项目接力' : '办公室';
  document.title = `${focused ? '专注画布' : get('page-title').textContent} · Soda Office`;
  get('page-heading').hidden = focused;
  get('floor-section').hidden = current !== 'floor';
  get('project-section').hidden = focused;
  get('focus-section').hidden = !focused;
  get('filter-wrap').hidden = !all;
  get('all-projects').hidden = all;
  for (const link of document.querySelectorAll('[data-view]')) {
    if (link.dataset.view === current) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  const frame = get('focus-frame');
  if (focused && !frame.hasAttribute('src')) frame.src = frame.dataset.src;
  if (data.runs.value || data.runs.error) renderProjects();
  syncSelection();
}

async function refresh() {
  if (refreshJob) return refreshJob;
  refreshJob = Promise.all(Object.values(data).map(async (source) => {
    try {
      const payload = await api(source.path);
      if (!Array.isArray(payload[source.field])) throw new Error('数据格式不符');
      source.value = payload[source.field];
      source.error = Array.isArray(payload.errors) && payload.errors.length > 0;
    } catch {
      source.error = true;
    }
  })).then(() => {
    if (submittedRun && data.runs.value) {
      if (!data.runs.value.some((run) => run.run_id === submittedRun.run_id)) data.runs.value.unshift(submittedRun);
      else submittedRun = null;
    }
    dateStamp();
    renderAgents();
    renderProjects();
    renderDecisions();
    syncSelection();
    const ok = Object.values(data).filter((source) => !source.error).length;
    const tone = ok === 4 ? 'idle' : ok === 0 ? 'unknown' : 'attention';
    get('sync-lamp').dataset.tone = tone;
    get('sync-label').textContent = ok === 4 ? `已同步 ${timeLabel(Date.now(), updateFormat)}` : ok === 0 ? '连接失败' : '部分数据暂不可用';
  }).finally(() => { refreshJob = null; });
  return refreshJob;
}

function showDialog(title, markup, trigger) {
  const token = Symbol(title);
  currentDialog = token;
  get('dialog-title').textContent = title;
  get('dialog-body').innerHTML = markup;
  if (!dialog.open) {
    returnFocus = trigger;
    dialog.showModal();
  }
  get('dialog-title').focus();
  return token;
}

function syncSelection() {
  for (const button of document.querySelectorAll('main [data-action][data-id]')) {
    const selected = inspectorSelection?.action === button.dataset.action && inspectorSelection.id === button.dataset.id;
    button.toggleAttribute('data-selected', selected);
  }
}

function setInspector(viewName) {
  const detail = viewName === 'detail';
  get('inbox-view').hidden = detail;
  get('detail-view').hidden = !detail;
  for (const button of document.querySelectorAll('.inspector-nav [data-inspector]')) {
    button.setAttribute('aria-pressed', String(button.dataset.inspector === viewName));
  }
}

function focusInspector() {
  const title = get('detail-title');
  title.focus({ preventScroll: true });
  if (matchMedia('(max-width: 900px)').matches) title.scrollIntoView({ block: 'nearest' });
}

function showInspector(action, id, title, markup) {
  inspectorSelection = { action, id };
  inspectorVersion = Symbol(id);
  get('detail-title').textContent = title;
  get('detail-body').innerHTML = markup;
  get('detail-tab').disabled = false;
  setInspector('detail');
  syncSelection();
  if (dialog.open) {
    focusInspectorAfterClose = true;
    dialog.close();
  } else focusInspector();
  return inspectorVersion;
}

function inspectorResult(token, markup) {
  if (inspectorVersion === token) get('detail-body').innerHTML = markup;
}

function detailRow(label, value) {
  return `<div><dt>${escape(label)}</dt><dd>${escape(value || '—')}</dd></div>`;
}

async function openAgent(id) {
  const agent = agents().find((member) => member.agent_id === id);
  if (!agent) return;
  const [status, tone] = agentStatus(agent);
  const taskId = agent.task?.task_id || agent.execution?.task_id;
  const currentStatus = agent.execution?.status_reason || agent.task?.status_reason || agent.availability?.reason;
  const details = `<div class="agent-detail-top">${avatar(agent)}${badge(status, tone)}</div>
    <dl class="details">${detailRow('执行引擎', [kindLabels[agent.kind] || agent.kind, agent.model].filter(Boolean).join(' · '))}
    ${detailRow('可用性', agent.enabled === false ? '已停用' : agent.availability?.available === true ? '可用' : agent.availability?.available === false ? '不可用' : '未知')}
    ${detailRow('状态依据', currentStatus)}${detailRow('证据来源', sourceLabels[agent.execution?.evidence_source] || agent.execution?.evidence_source)}
    ${detailRow('最近观测', timeLabel(agent.execution?.observed_at || agent.availability?.observed_at, activityFormat))}</dl>`;
  const taskMarkup = (label) => taskId ? `<dl class="details task-detail">${detailRow('关联任务', label)}</dl>` : '';
  const token = showInspector('agent', id, agent.display_name || id, details + taskMarkup(taskId));
  if (!taskId) return;
  try {
    const payload = await api(`/api/tasks/${urlPart(taskId)}`);
    if (payload.task?.title) inspectorResult(token, details + taskMarkup(payload.task.title));
  } catch { /* 任务详情不可用时保留已有的任务编号。 */ }
}

async function openProject(id) {
  const title = projects().find((run) => run.run_id === id)?.title || '项目工作流';
  const token = showInspector('project', id, title, '<p class="empty" role="status">正在读取工作流…</p>');
  try {
    const { run } = await api(`/api/workflow/runs/${urlPart(id)}`);
    const [label, tone] = statuses[run.status] || ['状态未知', 'unknown'];
    const actorNames = new Map(agents().map((agent) => [agent.agent_id, agent.display_name]));
    actorNames.set('user', '主理人');
    const steps = run.steps.map((step) => `<li data-state="${escape(step.status)}"${step.step_id === run.current_step_id ? ' aria-current="step"' : ''}>
      <span class="step-number">${escape(step.step_id)}</span><span><strong>${escape(step.name)}</strong><span>${escape(actorNames.get(step.actor) || step.actor || '未指定')}</span></span><span>${stepLabels[step.status] || '状态未知'}</span>
    </li>`).join('');
    const baseline = run.requirement_baseline;
    inspectorResult(token, `<div class="project-detail-meta">${badge(label, tone)}<span>完成 ${escape(run.progress?.done ?? 0)} / ${escape(run.total_steps)} 步</span></div>
      ${run.status_reason ? `<p class="project-reason">${escape(run.status_reason)}</p>` : ''}
      ${baseline ? `<details class="baseline"><summary>查看需求原文</summary><p>${escape(typeof baseline === 'string' ? baseline : JSON.stringify(baseline, null, 2))}</p></details>` : ''}
      <ol class="steps">${steps}</ol><div class="dialog-actions"><a class="text-link" href="/#/pro">打开高级工作台 ↗</a></div>`);
  } catch (error) {
    inspectorResult(token, `<p class="form-error" role="alert">${escape(error.message)}</p><button class="small-button" type="button" data-action="project" data-id="${escape(id)}">重试</button>`);
  }
}

function openDecision(id) {
  const item = (data.decisions.value || []).find((entry) => `${entry.taskId}:${entry.stepKey}` === id);
  if (!item) return;
  showInspector('decision', id, item.taskTitle || '待拍板', `<dl class="details">${detailRow('待确认步骤', item.stepName)}${detailRow('类型', item.gate ? '决策关口' : '步骤确认')}${detailRow('任务编号', item.taskId)}</dl>
    <div class="dialog-actions"><a class="primary-button" href="/#/pro">去高级工作台处理 ↗</a></div>`);
}

async function openCreate(trigger) {
  const token = showDialog('发起需求', `<form id="intake-form" class="intake-form">
    <label>项目名称<input name="title" required maxlength="160" autocomplete="off" placeholder="例如：整理产品发布清单"></label>
    <label>需求说明<textarea name="baseline" required rows="5" maxlength="12000" placeholder="想解决什么问题？怎样算做完？"></textarea></label>
    <label>工作流<select name="template" required disabled><option value="">正在读取工作流…</option></select></label>
    <p class="form-error" role="alert" hidden></p>
    <div class="dialog-actions"><button type="submit" class="primary-button" disabled>创建项目</button></div>
  </form>`, trigger);
  const form = get('intake-form');
  form.elements.title.focus();
  const errorBox = form.querySelector('.form-error');
  try {
    const { templates } = await api('/api/workflow/templates');
    if (!templates.length) throw new Error('还没有可用的工作流模板。');
    if (!dialog.open || currentDialog !== token) return;
    form.elements.template.replaceChildren(...templates.map((template) => new Option(template.name || template.template_id, template.template_id)));
    form.elements.template.disabled = false;
    form.querySelector('[type="submit"]').disabled = false;
  } catch (error) {
    if (dialog.open && currentDialog === token) {
      form.elements.template.options[0].textContent = '工作流暂不可用';
      errorBox.textContent = error.message;
      errorBox.hidden = false;
    }
  }
}

async function submitProject(form) {
  const submit = form.querySelector('[type="submit"]');
  if (submit.disabled) return;
  const body = new FormData(form);
  const title = body.get('title').trim();
  const requirement = body.get('baseline').trim();
  const errorBox = form.querySelector('.form-error');
  if (!title || !requirement) {
    errorBox.textContent = '请填写项目名称和需求说明。';
    errorBox.hidden = false;
    return;
  }
  const token = currentDialog;
  submit.disabled = true;
  submit.textContent = '正在创建…';
  errorBox.hidden = true;
  dialog.dataset.saving = 'true';
  get('close-dialog').disabled = true;
  try {
    const { run } = await api('/api/workflow/runs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, requirement_baseline: requirement, template_id: body.get('template') }),
    });
    submittedRun = run;
    data.runs.value = [run, ...(data.runs.value || []).filter((old) => old.run_id !== run.run_id)];
    get('project-filter').value = 'all';
    location.hash = '#projects';
    setView();
    void openProject(run.run_id);
    void refresh();
  } catch (error) {
    if (dialog.open && currentDialog === token) {
      const uncertain = error.status >= 500 || error.name === 'TimeoutError' || error instanceof TypeError || error instanceof SyntaxError;
      errorBox.textContent = uncertain ? '暂时无法确认是否创建成功。请先关闭窗口，在项目接力中核对。' : error.message;
      errorBox.hidden = false;
      submit.disabled = uncertain;
      void refresh();
    }
  } finally {
    submit.textContent = '创建项目';
    delete dialog.dataset.saving;
    get('close-dialog').disabled = false;
  }
}

document.addEventListener('click', (event) => {
  const panel = event.target.closest('[data-inspector]');
  if (panel) {
    setInspector(panel.dataset.inspector);
    if (panel.closest('#detail-view')) document.querySelector('.inspector-nav [data-inspector="inbox"]').focus();
    return;
  }
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const { action, id } = button.dataset;
  if (action === 'agent') void openAgent(id);
  if (action === 'project') void openProject(id);
  if (action === 'create') void openCreate(button);
  if (action === 'decision') openDecision(id);
  if (action === 'decisions') showDialog('待我拍板', decisionRows(decisions()), button);
});
dialog.addEventListener('submit', (event) => {
  event.preventDefault();
  void submitProject(event.target);
});
dialog.addEventListener('cancel', (event) => {
  if (dialog.dataset.saving) event.preventDefault();
});
dialog.addEventListener('close', () => {
  currentDialog = null;
  if (focusInspectorAfterClose) {
    focusInspectorAfterClose = false;
    focusInspector();
  } else if (returnFocus?.isConnected && !returnFocus.closest('[hidden]')) returnFocus.focus();
  else if (view() === 'focus') document.querySelector('[data-view="focus"]').focus();
  else get('page-title').focus();
});
get('focus-expand').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await get('focus-section').requestFullscreen();
  } catch {
    get('focus-expand').textContent = '全屏不可用';
  }
});
document.addEventListener('fullscreenchange', () => {
  get('focus-expand').textContent = document.fullscreenElement ? '退出全屏' : '全屏';
});
get('close-dialog').addEventListener('click', () => dialog.close());
get('refresh').addEventListener('click', () => void refresh());
get('project-filter').addEventListener('change', renderProjects);
window.addEventListener('hashchange', setView);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
setInterval(() => { if (!document.hidden) void refresh(); }, 20000);
dateStamp();
setView();
void refresh();
