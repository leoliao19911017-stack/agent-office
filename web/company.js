// company.js — TASK-COMPANY-D0 前端逻辑。
// 视图：助理（默认工作台）/ 公司（部门→员工→档案）/ 资源（工具库）。
// 数据全部来自 /api/company/* /api/work /api/assistant/report，不编造。
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  view: 'assistant',
  org: null,        // { departments, assistant }
  report: null,
  selectedDept: null,
  selectedEmp: null,
};

// ---------- 小工具 ----------

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function timeHM(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* 空体 */ }
  if (!res.ok) {
    const msg = (data && (data.message || data.error)) || `${res.status} ${res.statusText}`;
    throw new Error(msg);
  }
  return data;
}

function flash(text) {
  const label = $('#sync-label');
  label.textContent = text;
}

function markSynced() {
  $('#sync-lamp').classList.add('ok');
  $('#sync-label').textContent = `数据更新于 ${timeHM(new Date().toISOString())}`;
}

// ---------- 视图切换 ----------

function switchView(view) {
  state.view = view;
  $$('.nav-item').forEach((btn) => {
    if (btn.dataset.view === view) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });
  $$('[data-view-panel]').forEach((panel) => { panel.hidden = panel.dataset.viewPanel !== view; });
  if (view === 'company') loadCompany();
  if (view === 'resources') loadResources();
}

// ---------- 助理工作台 ----------

const STATUS_TAG = {
  pending: '', delivered: 'accent', accepted: 'accent',
  rejected: 'warn', blocked: 'warn', running: '',
};

function workCardHtml(w, { actions = '', extra = '' } = {}) {
  const statusTag = `<span class="tag status-tag ${STATUS_TAG[w.status] || ''}">${esc(w.status_label || w.status)}</span>`;
  const meta = [
    w.owner_name ? `负责人 ${esc(w.owner_name)}` : '',
    w.department_name ? esc(w.department_name) : '',
    w.deliverable_count ? `${w.deliverable_count} 份成果` : '',
  ].filter(Boolean).join(' · ');
  return `<article class="work-card" data-work-id="${esc(w.work_id)}">
    <div class="row1"><p class="title">${esc(w.title)}</p>${statusTag}</div>
    <p class="meta">${esc(meta)}</p>
    ${extra}
    <div class="actions">${actions}</div>
  </article>`;
}

function refsHtml(outputRefs) {
  if (!outputRefs || !outputRefs.length) return '';
  return `<ul class="refs">${outputRefs.map((r) => `<li data-action="show-refs">📄 ${esc(r)}</li>`).join('')}</ul>`;
}

function renderNeeds(items) {
  const box = $('#needs-list');
  $('#needs-count').textContent = items.length;
  if (!items.length) { box.innerHTML = '<p class="empty">没有等你拍板的事。</p>'; return; }
  box.innerHTML = items.map((w) => {
    const extra = [
      w.why ? `<p class="reason">${esc(w.why)}</p>` : '',
      w.note ? `<p class="note">${esc(w.note)}</p>` : '',
      refsHtml(w.output_refs),
    ].join('');
    const isDeliveredLike = w.status === 'delivered';
    const actions = isDeliveredLike
      ? `<button class="btn small primary" data-action="accept">验收通过</button>
         <button class="btn small danger" data-action="reject">要求修改</button>`
      : `<button class="btn small primary" data-action="start">重新开始执行</button>`;
    return workCardHtml(w, { actions, extra });
  }).join('');
}

function renderDelivered(items) {
  const box = $('#delivered-list');
  if (!items.length) { box.innerHTML = '<p class="empty">今天还没有交付。</p>'; return; }
  box.innerHTML = items.map((w) => workCardHtml(w, {
    extra: refsHtml(w.output_refs),
    actions: `<button class="btn small primary" data-action="accept">验收通过</button>
              <button class="btn small danger" data-action="reject">要求修改</button>`,
  })).join('');
}

function renderProgress(items, org) {
  const box = $('#progress-list');
  if (!items.length) { box.innerHTML = '<p class="empty">没有进行中的任务。</p>'; return; }
  const assignables = org ? org.departments.flatMap((d) => d.employees || [])
    .filter((e) => !e.is_assistant) : [];
  box.innerHTML = items.map((w) => {
    const basis = w.basis ? `<p class="basis">依据：${esc(w.basis)}</p>` : '';
    let actions = '';
    if (w.status === 'pending') {
      actions = `<button class="btn small primary" data-action="start">开始执行</button>
        ${assignables.map((e) => `<button class="btn small" data-action="assign" data-emp="${esc(e.employee_id)}">派给 ${esc(e.name)}</button>`).join('')}
        <button class="btn small danger" data-action="block">受阻</button>`;
    } else if (w.status === 'running') {
      actions = `<button class="btn small primary" data-action="deliver">提交成果</button>
        <button class="btn small danger" data-action="block">受阻</button>`;
    }
    const progressTag = `<span class="tag ${w.progress === '状态待确认' ? 'warn' : ''}">${esc(w.progress)}</span>`;
    return `<article class="work-card" data-work-id="${esc(w.work_id)}">
      <div class="row1"><p class="title">${esc(w.title)}</p>${progressTag}</div>
      <p class="meta">负责人 ${esc(w.owner_name || '')}${w.department_name ? ' · ' + esc(w.department_name) : ''}</p>
      ${basis}
      <div class="actions">${actions}</div>
    </article>`;
  }).join('');
}

function renderRecent(works) {
  const ul = $('#recent-list');
  if (!works.length) { ul.innerHTML = '<li class="empty">还没有交办过任务。</li>'; return; }
  ul.innerHTML = works.slice(0, 5).map((w) => `<li>
    <span>${esc(w.title)}</span>
    <span class="muted">${esc(w.status_label || w.status)} · ${esc(w.owner_name || '')}</span>
  </li>`).join('');
}

function renderWeekGoals(goals) {
  const box = $('#week-goals');
  // 铁律③-3：没有本周目标 → 「尚无目标」，不显示 0%
  if (!goals || !goals.length) {
    box.innerHTML = '<div><dt>目标</dt><dd class="muted">尚无目标</dd></div><div><dt>进度</dt><dd class="muted">—</dd></div>';
    return;
  }
  box.innerHTML = goals.map((g) => `<div><dt>${esc(g.title)}</dt><dd>${esc(g.progress ?? '—')}</dd></div>`).join('');
}

function renderToday(report) {
  const running = report.in_progress.filter((x) => x.progress === '正在工作').length;
  const waiting = report.in_progress.filter((x) => x.progress === '待启动').length;
  const unsure = report.in_progress.filter((x) => x.progress === '状态待确认').length;
  $('#today-plan').innerHTML = `
    <div><dt>待启动</dt><dd>${waiting}</dd></div>
    <div><dt>正在工作</dt><dd>${running}</dd></div>
    <div><dt>状态待确认</dt><dd>${unsure}</dd></div>
    <div><dt>待核验</dt><dd>${report.verify_pending.length}</dd></div>
    <div><dt>待验收</dt><dd>${report.delivered.length}</dd></div>`;
}

async function loadAssistant() {
  const [report, works, org] = await Promise.all([
    api('/api/assistant/report'),
    api('/api/work'),
    api('/api/company/org'),
  ]);
  state.report = report;
  state.org = org;
  $('#assistant-name').textContent = org.assistant ? org.assistant.name : '—';
  const hermesDept = org.departments.find((d) => (org.assistant && d.employees.some((e) => e.employee_id === org.assistant.employee_id)))
    || org.departments.find((d) => d.managed_by_assistant);
  $('#assistant-dept').textContent = hermesDept ? `${hermesDept.name} · 助理` : '助理';

  renderNeeds([...report.needs_decision, ...report.verify_pending]);
  renderDelivered(report.delivered);
  renderProgress(report.in_progress, org);
  renderRecent(works.works || []);
  renderWeekGoals(report.week_goals);
  renderToday(report);
  markSynced();
}

// ---------- 公司页 ----------

function renderDeptList(departments) {
  const box = $('#dept-list');
  box.innerHTML = departments.map((d) => {
    const sub = d.managed_by_assistant
      ? '由助理兼任 · 暂无专职员工'
      : `${d.employee_count} 名员工${d.duty ? ' · ' + d.duty : ''}`;
    return `<div class="dept-row${state.selectedDept === d.department_id ? ' selected' : ''}" data-action="pick-dept" data-id="${esc(d.department_id)}" role="button" tabindex="0">
      <div class="name">${esc(d.name)}</div>
      <div class="sub">${esc(sub)}</div>
    </div>`;
  }).join('');
}

function renderEmpList(dept) {
  const box = $('#emp-list');
  if (!dept) { box.innerHTML = '<p class="empty muted">点左侧部门查看员工。</p>'; return; }
  const emps = dept.employees || [];
  const rows = emps.map((e) => `<div class="emp-row${state.selectedEmp === e.employee_id ? ' selected' : ''}" data-action="pick-emp" data-id="${esc(e.employee_id)}" role="button" tabindex="0">
      <div class="name">${esc(e.name)}${e.is_assistant ? ' <span class="tag">助理</span>' : ''}</div>
      <div class="sub">${esc(e.role)} · 能用：${e.tools && e.tools.length ? e.tools.map((t) => esc(t.display_name || t.agent_id)).join('、') : '无工具'}</div>
    </div>`);
  box.innerHTML = rows.length ? `<div class="emp-list">${rows.join('')}</div>`
    : '<p class="empty muted">这个部门还没有员工。</p>';
}

async function renderProfile(empId) {
  const box = $('#emp-profile');
  const [{ employee }, { works }] = await Promise.all([
    api(`/api/employees/${encodeURIComponent(empId)}`),
    api(`/api/work?owner=${encodeURIComponent(empId)}`),
  ]);
  const chips = employee.tools && employee.tools.length
    ? `<div class="chips">${employee.tools.map((t) => `<span class="tag accent">${esc(t.display_name || t.agent_id)}</span>`).join('')}</div>`
    : '<p class="muted">尚未授权任何工具</p>';
  const history = works && works.length
    ? `<ul class="work-history">${works.slice(0, 8).map((w) => `<li><span>${esc(w.title)}</span><span class="muted">${esc(w.status_label || w.status)}</span></li>`).join('')}</ul>`
    : '<p class="muted">还没有接过任务</p>';
  box.innerHTML = `
    <div class="profile-head"><span class="name">${esc(employee.name)}</span>
      <span class="tag">${esc(employee.role)}</span>
      ${employee.is_assistant ? '<span class="tag accent">助理</span>' : ''}</div>
    <dl class="kv">
      <div><dt>部门</dt><dd>${esc(employee.department_name || '')}</dd></div>
      <div><dt>职责</dt><dd>${esc(employee.duty || '—')}</dd></div>
      <div><dt>简历</dt><dd>${esc(employee.resume || '—')}</dd></div>
    </dl>
    <p class="muted" style="margin-bottom:4px">可调用工具</p>
    ${chips}
    <p class="muted" style="margin:12px 0 4px">工作历史</p>
    ${history}`;
}

async function loadCompany() {
  const org = await api('/api/company/org');
  state.org = org;
  renderDeptList(org.departments);
  if (state.selectedDept) {
    const dept = org.departments.find((d) => d.department_id === state.selectedDept);
    renderEmpList(dept || null);
  }
  markSynced();
}

// ---------- 资源页 ----------

const KIND_LABEL = { cli: 'CLI 工具', api: 'API', external: '外部服务' };

function capText(cap) {
  if (!cap) return '';
  const parts = [];
  if (cap.chat) parts.push('对话');
  if (cap.tools) parts.push('工具调用');
  if (cap.self_report) parts.push('自我汇报');
  return parts.length ? `能力：${parts.join(' / ')}` : '';
}

async function loadResources() {
  const { tools } = await api('/api/company/tools');
  $('#tool-list').innerHTML = tools.map((t) => {
    const status = t.enabled ? '✅ 已连接' : '⚪ 未启用';
    const statusCls = t.enabled ? 'accent' : '';
    const who = t.employees && t.employees.length
      ? `谁可以调用：${t.employees.map((e) => esc(e.name)).join('、')}`
      : '谁可以调用：尚未授权给任何员工';
    return `<div class="tool-card">
      <div class="row1">
        <span class="name">${esc(t.display_name)}</span>
        <span><span class="kind">${esc(KIND_LABEL[t.kind] || t.kind)}</span> <span class="tag ${statusCls}">${status}</span></span>
      </div>
      <p class="cap">${esc(capText(t.capabilities))}</p>
      <p class="who">${who}</p>
    </div>`;
  }).join('');
  markSynced();
}

// ---------- 卡片内嵌表单（不用弹窗，无动画） ----------

function toggleCardForm(card, html) {
  const old = $('.card-form', card);
  if (old) { old.remove(); return; }
  card.insertAdjacentHTML('beforeend', `<div class="card-form">${html}</div>`);
  $('input, textarea', $('.card-form', card))?.focus();
}

const FORMS = {
  deliver: () => `<textarea data-role="refs" rows="3" placeholder="成果清单（一行一个路径）"></textarea>
    <input type="text" data-role="summary" placeholder="一句话说明做了什么">
    <div class="form-row"><button class="btn small primary" data-action="deliver-confirm">提交</button>
    <button class="btn small" data-action="form-cancel">取消</button></div>`,
  reject: () => `<input type="text" data-role="reason" placeholder="哪里不达标（必填）">
    <div class="form-row"><button class="btn small danger" data-action="reject-confirm">确认退回</button>
    <button class="btn small" data-action="form-cancel">取消</button></div>`,
  block: () => `<input type="text" data-role="reason" placeholder="缺什么 / 卡在哪（必填）">
    <div class="form-row"><button class="btn small danger" data-action="block-confirm">确认受阻</button>
    <button class="btn small" data-action="form-cancel">取消</button></div>`,
};

// ---------- 全局事件 ----------

document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  const card = el.closest('[data-work-id]');
  const workId = card ? card.dataset.workId : null;
  try {
    switch (action) {
      case 'start': {
        const r = await api(`/api/work/${workId}/start`, { method: 'POST', body: {} });
        flash(`已开始执行（工具 ${r.agent_id}）`);
        await loadAssistant();
        break;
      }
      case 'assign': {
        const r = await api(`/api/work/${workId}/assign`, { method: 'POST', body: { owner_employee_id: el.dataset.emp } });
        flash(`已派给 ${r.work.owner_name}`);
        await loadAssistant();
        break;
      }
      case 'accept': {
        await api(`/api/work/${workId}/accept`, { method: 'POST', body: {} });
        flash('已验收通过');
        await loadAssistant();
        break;
      }
      case 'deliver': toggleCardForm(card, FORMS.deliver()); break;
      case 'reject': toggleCardForm(card, FORMS.reject()); break;
      case 'block': toggleCardForm(card, FORMS.block()); break;
      case 'form-cancel': $('.card-form', card)?.remove(); break;
      case 'deliver-confirm': {
        const refs = $('[data-role="refs"]', card).value.split('\n').map((s) => s.trim()).filter(Boolean);
        const summary = $('[data-role="summary"]', card).value.trim();
        await api(`/api/work/${workId}/deliver`, { method: 'POST', body: { output_refs: refs, result_summary: summary } });
        flash('已提交成果');
        await loadAssistant();
        break;
      }
      case 'reject-confirm': {
        const reason = $('[data-role="reason"]', card).value.trim();
        if (!reason) { flash('退回要写原因'); break; }
        await api(`/api/work/${workId}/reject`, { method: 'POST', body: { reason } });
        flash('已退回');
        await loadAssistant();
        break;
      }
      case 'block-confirm': {
        const reason = $('[data-role="reason"]', card).value.trim();
        if (!reason) { flash('受阻要写原因'); break; }
        await api(`/api/work/${workId}/block`, { method: 'POST', body: { reason } });
        flash('已标记受阻');
        await loadAssistant();
        break;
      }
      case 'show-refs': {
        // 点击成果 → 展开这份交付的完整成果清单（数据来自 work 详情）
        const { work } = await api(`/api/work/${workId}`);
        const li = el;
        const title = li.textContent.replace('📄 ', '');
        flash(`成果 ${title} · 共 ${work.output_refs.length} 份：${work.output_refs.join('、')}`);
        break;
      }
      case 'pick-dept': {
        state.selectedDept = el.dataset.id;
        state.selectedEmp = null;
        const dept = state.org.departments.find((d) => d.department_id === state.selectedDept);
        renderDeptList(state.org.departments);
        renderEmpList(dept);
        $('#emp-profile').innerHTML = '<p class="empty muted">点一名员工查看档案。</p>';
        break;
      }
      case 'pick-emp': {
        state.selectedEmp = el.dataset.id;
        const dept = state.org.departments.find((d) => d.department_id === state.selectedDept);
        renderEmpList(dept);
        await renderProfile(state.selectedEmp);
        break;
      }
      default: break;
    }
  } catch (err) {
    flash(`操作失败：${err.message}`);
  }
});

// 键盘可达（部门/员工行支持回车）
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter') return;
  const el = ev.target.closest('[data-action="pick-dept"], [data-action="pick-emp"]');
  if (el) el.click();
});

// ---------- 表单 ----------

$('#compose-toggle').addEventListener('click', () => {
  const more = $('#compose-more');
  more.hidden = !more.hidden;
});

$('#compose-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const title = $('#compose-title').value.trim();
  if (!title) return;
  const inputs = $('#compose-inputs').value.trim();
  const body = {
    title,
    what_to_deliver: $('#compose-deliver').value.trim() || undefined,
    acceptance: $('#compose-acceptance').value.trim() || undefined,
    input_refs: inputs ? inputs.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : [],
    owner_employee_id: state.org?.assistant?.employee_id || 'emp-hermes',
    assigned_by: 'leo',
  };
  try {
    const r = await api('/api/work', { method: 'POST', body });
    flash(`已交办（${r.work.status_label}），负责人 ${r.work.owner_name}`);
    $('#compose-form').reset();
    $('#compose-more').hidden = true;
    await loadAssistant();
  } catch (err) {
    flash(`交办失败：${err.message}`);
  }
});

$('#dept-new-toggle').addEventListener('click', () => {
  const form = $('#dept-form');
  form.hidden = !form.hidden;
  if (!form.hidden) $('#dept-name').focus();
});

$('#dept-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const name = $('#dept-name').value.trim();
  if (!name) return;
  try {
    await api('/api/departments', { method: 'POST', body: { name, duty: $('#dept-duty').value.trim() } });
    flash(`已创建部门「${name}」`);
    $('#dept-form').reset();
    $('#dept-form').hidden = true;
    await loadCompany();
  } catch (err) {
    flash(`创建失败：${err.message}`);
  }
});

// ---------- 启动 ----------

$$('.nav-item').forEach((btn) => btn.addEventListener('click', () => {
  location.hash = `#${btn.dataset.view}`;
}));

async function boot() {
  const view = (location.hash || '#assistant').slice(1);
  switchView(['assistant', 'company', 'resources'].includes(view) ? view : 'assistant');
  try {
    await loadAssistant();
  } catch (err) {
    flash(`读取失败：${err.message}`);
  }
}

window.addEventListener('hashchange', () => {
  const view = (location.hash || '#assistant').slice(1);
  if (['assistant', 'company', 'resources'].includes(view)) switchView(view);
});

boot();
