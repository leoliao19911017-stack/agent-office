'use strict';

/* ================= workflow-templates.js — 设置页「工作流模板」=================
   第二步的最小可用界面：
   - 列表：模板名 / 版本 / 步骤数 / 在用 run 数；
   - 点模板：只读展示完整步骤、判据、返工路由；
   - 「＋ 从描述生成」：粘贴 Leo 口述 → 看中文摘要与缺失项 → 确认保存。

   数据全部来自 /api/workflow/templates*（原生 fetch 封装在 shared.js 的 api()），
   本文件不自己编模板，也不在浏览器里解析自然语言。 */

const wfUI = {
  loaded: false,
  loading: false,
  error: null,
  templates: [],
  detail: null,
  detailLoading: false,
  detailReq: 0,
  draft: null,
  generating: false,
  saving: false,
};

const WF_ACTOR_CN = {
  user: '你', hermes: 'Hermes', claude: 'Claude', codex: 'Codex', dsh: 'DSH', gpt: 'GPT', leo: '你',
};

const WF_GATE_CN = {
  user_done: '你确认完成',
  ambiguities_resolved: '疑问都澄清',
  user_approval: '你拍板确认',
  docs_written_and_registered_in_agent_office: '计划与任务书写完并登记',
  each_batch_committed_and_reported: '每批提交并汇报',
  tests_all_pass: '测试全部通过',
  hard_criteria_pass: '硬性项全过',
  metrics_summarized_and_improvement_closed: '指标汇总、改进闭环',
};

const WF_ROUTE_CN = {
  review_below_target: '评审不到目标分',
  review_criteria_mismatch: '评审标准不一致',
  test_failed: '测试没过',
  req_ambiguity: '需求有歧义',
  code_bug: '代码有 bug',
  test_gap: '测试没覆盖',
  plan_flaw: '方案不合理',
  agent_capability: '能力不足',
  quota_exhausted: '额度耗尽',
  external_env_failure: '外部环境故障',
};

function wfActor(id) {
  return WF_ACTOR_CN[id] || id || '—';
}

function wfGate(gate) {
  const g = String(gate || '');
  const hit = WF_GATE_CN[g];
  if (hit) return `${hit}（${g}）`;
  const m = g.match(/hard_criteria_pass\s+AND\s+score\s*>=\s*([\d.]+)/);
  if (m) return `硬性项全过，且分数 ≥ ${m[1]}（${g}）`;
  return g || '—';
}

function wfStepName(id) {
  const t = wfUI.detail;
  const step = t && (t.steps || []).find((s) => s.id === id);
  return step ? step.name : (id || '—');
}

async function wfLoad(force = false) {
  if (wfUI.loading) return;
  if (wfUI.loaded && !force) return;
  wfUI.loading = true;
  wfUI.error = null;
  renderWorkflowTemplates();
  try {
    const data = await api('/api/workflow/templates');
    wfUI.templates = Array.isArray(data.templates) ? data.templates : [];
    wfUI.loaded = true;
  } catch (err) {
    wfUI.error = err.message || '读取失败';
  } finally {
    wfUI.loading = false;
    if (!document.getElementById('page-workflow')?.hidden) renderWorkflowTemplates();
  }
}

function wfRenderList() {
  const el = document.getElementById('wf-list');
  if (!el) return;
  const list = document.getElementById('wf-detail');
  if (list) list.hidden = true;

  if (wfUI.loading && wfUI.templates.length === 0) {
    el.innerHTML = '<div class="cabin-loading">正在读工作流模板…</div>';
    return;
  }
  if (wfUI.error) {
    el.innerHTML = `<div class="wf-error">读取模板失败：${esc(wfUI.error)}<button class="btn btn-secondary" type="button" data-wf-retry>重试</button></div>`;
    return;
  }
  if (wfUI.templates.length === 0) {
    el.innerHTML = '<div class="wf-empty">还没有工作流模板。点右上角「＋ 从描述生成」，把一段口述变成模板。</div>';
    return;
  }

  el.innerHTML = `<div class="wf-rows">${wfUI.templates.map((t) => `
    <button class="wf-row" type="button" data-wf-open="${esc(t.template_id)}">
      <span class="wf-row-main"><b>${esc(t.name)}</b><span class="wf-ver">v${esc(String(t.version))}</span></span>
      <span class="wf-row-meta">${Number(t.step_count) || 0} 步 · ${Number(t.run_count) || 0} 个 run 在用 · 更新于 ${esc(fmtTime(t.updated_at))}</span>
      <span class="wf-row-arrow" aria-hidden="true">→</span>
    </button>`).join('')}</div>`;
}

function wfRenderDetail() {
  const t = wfUI.detail;
  const list = document.getElementById('wf-list');
  const box = document.getElementById('wf-detail');
  if (!list || !box) return;
  if (wfUI.detailLoading || !t) {
    list.hidden = true;
    box.hidden = false;
    box.innerHTML = '<div class="cabin-loading">正在读模板定义…</div>';
    return;
  }
  list.hidden = true;
  box.hidden = false;

  const steps = Array.isArray(t.steps) ? t.steps : [];
  const routes = t.rework_routes && typeof t.rework_routes === 'object' ? t.rework_routes : {};
  const routeRows = Object.entries(routes);
  const versions = Array.isArray(t.versions) ? t.versions : [t.version];

  box.innerHTML = `
    <div class="wf-detail-bar">
      <button class="btn btn-secondary" type="button" data-wf-back>← 返回列表</button>
      <div class="wf-detail-title"><h2>${esc(t.name)}</h2><span class="wf-ver">v${esc(String(t.version))}${t.is_current === false ? '（历史版本）' : ''}</span></div>
      <span class="wf-detail-meta">${steps.length} 步 · ${Number(t.run_count) || 0} 个 run 在用</span>
    </div>
    <div class="wf-version-row">
      <span>版本：</span>
      ${versions.map((v) => `<button type="button" class="wf-version${Number(v) === Number(t.version) ? ' on' : ''}" data-wf-version="${esc(String(v))}">v${esc(String(v))}</button>`).join('')}
    </div>
    <div class="wf-steps">${steps.map((s) => `
      <article class="wf-step">
        <span class="wf-step-id">${esc(String(s.id))}</span>
        <div class="wf-step-body">
          <div class="wf-step-name">${esc(s.name)}</div>
          <div class="wf-step-line">执行：<b>${esc(wfActor(s.actor))}</b>${s.collaborators && s.collaborators.length ? ` · 协作：${s.collaborators.map((c) => esc(wfActor(c))).join(' / ')}` : ''}${s.fallback_actor ? ` · 替补：${esc(wfActor(s.fallback_actor))}` : ''}</div>
          <div class="wf-step-line">判据：${esc(wfGate(s.gate))}</div>
          <div class="wf-step-line">交付物：${(s.outputs || []).map((o) => `<code>${esc(o)}</code>`).join(' ') || '—'}</div>
        </div>
      </article>`).join('')}
    </div>
    <div class="wf-section">
      <h3>返工路由</h3>
      ${routeRows.length ? `<table class="wf-routes"><tbody>${routeRows.map(([reason, target]) => `
        <tr><td>${esc(WF_ROUTE_CN[reason] || reason)}</td><td>→</td><td>${esc(wfStepName(target))}</td></tr>`).join('')}</tbody></table>`
        : '<p class="wf-muted">这个模板还没配返工路由。</p>'}
    </div>
    <div class="wf-section">
      <h3>评分权重 / 自主边界</h3>
      <p class="wf-muted">评分权重：${Object.keys(t.scoring || {}).length ? Object.entries(t.scoring).map(([k, v]) => `${esc(k)} ${Math.round(Number(v) * 100)}%`).join(' · ') : '未配置'}</p>
      <p class="wf-muted">自主决策：${(t.autonomy && t.autonomy.self_decide || []).length ? (t.autonomy.self_decide || []).map(esc).join(' / ') : '未配置'}　必须问你：${(t.autonomy && t.autonomy.must_ask || []).length ? (t.autonomy.must_ask || []).map(esc).join(' / ') : '未配置'}</p>
    </div>`;
}

function renderWorkflowTemplates() {
  const page = document.getElementById('page-workflow');
  if (!page) return;
  if (!wfUI.loaded && !wfUI.loading && !wfUI.error) wfLoad();
  if (wfUI.detail || wfUI.detailLoading) wfRenderDetail();
  else wfRenderList();
}

async function wfOpenDetail(id, version) {
  const req = ++wfUI.detailReq;
  wfUI.detailLoading = true;
  wfUI.detail = null;
  renderWorkflowTemplates();
  try {
    const q = version ? `?version=${encodeURIComponent(version)}` : '';
    const data = await api(`/api/workflow/templates/${encodeURIComponent(id)}${q}`);
    if (req !== wfUI.detailReq) return; // 期间用户已返回列表，旧请求作废
    wfUI.detail = data.template || null;
  } catch (err) {
    if (req !== wfUI.detailReq) return;
    showToast(`打开模板失败：${err.message}`, 'err');
    wfUI.detail = null;
  } finally {
    if (req === wfUI.detailReq) {
      wfUI.detailLoading = false;
      renderWorkflowTemplates();
    }
  }
}

function wfResetDialog() {
  wfUI.draft = null;
  wfUI.generating = false;
  wfUI.saving = false;
  const text = document.getElementById('wf-text');
  const result = document.getElementById('wf-result');
  const name = document.getElementById('wf-name');
  const summary = document.getElementById('wf-summary');
  const missing = document.getElementById('wf-missing');
  const json = document.getElementById('wf-draft-json');
  const hint = document.getElementById('wf-save-hint');
  const gen = document.getElementById('wf-generate');
  const confirm = document.getElementById('wf-confirm');
  if (text) text.value = '';
  if (result) result.hidden = true;
  if (name) name.value = '';
  if (summary) summary.textContent = '';
  if (missing) missing.innerHTML = '';
  if (json) json.textContent = '';
  if (hint) hint.textContent = '';
  if (gen) { gen.disabled = false; gen.textContent = '生成草稿'; }
  if (confirm) { confirm.disabled = false; confirm.textContent = '确认保存'; }
}

function wfOpenDialog() {
  const dialog = document.getElementById('wf-dialog');
  if (!dialog) return;
  wfResetDialog();
  if (!dialog.open) dialog.showModal();
  setTimeout(() => document.getElementById('wf-text')?.focus(), 0);
}

async function wfGenerate() {
  if (wfUI.generating) return;
  const textEl = document.getElementById('wf-text');
  const text = textEl ? textEl.value.trim() : '';
  if (!text) { showToast('先把 Leo 的口述贴进来', 'err'); textEl?.focus(); return; }
  const btn = document.getElementById('wf-generate');
  wfUI.generating = true;
  if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
  try {
    const data = await api('/api/workflow/templates/from-text', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    wfUI.draft = data.draft;
    const result = document.getElementById('wf-result');
    if (result) result.hidden = false;
    document.getElementById('wf-summary').textContent = data.summary || '';
    document.getElementById('wf-missing').innerHTML = (data.missing && data.missing.length)
      ? data.missing.map((m) => `<li>${esc(m)}</li>`).join('')
      : '<li class="wf-ok">都识别到了。</li>';
    document.getElementById('wf-name').value = (data.draft && data.draft.name) || '口述流程';
    document.getElementById('wf-draft-json').textContent = JSON.stringify(data.draft, null, 2);
    document.getElementById('wf-save-hint').textContent = `草稿 ${Array.isArray(data.draft?.steps) ? data.draft.steps.length : 0} 步，确认后存为 v1。`;
  } catch (err) {
    showToast(`生成失败：${err.message}`, 'err');
  } finally {
    wfUI.generating = false;
    if (btn) { btn.disabled = false; btn.textContent = '生成草稿'; }
  }
}

async function wfConfirm() {
  if (wfUI.saving) return;
  if (!wfUI.draft) { showToast('先点「生成草稿」', 'err'); return; }
  const nameEl = document.getElementById('wf-name');
  const name = nameEl ? nameEl.value.trim() : '';
  if (!name) { showToast('给模板起个名字再保存', 'err'); nameEl?.focus(); return; }
  const btn = document.getElementById('wf-confirm');
  wfUI.saving = true;
  if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
  try {
    const data = await api('/api/workflow/templates/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draft: wfUI.draft, name }),
    });
    const t = data.template;
    showToast(`已保存：${t.name} v${t.version}`, 'ok');
    document.getElementById('wf-dialog')?.close();
    wfUI.loaded = false;
    wfUI.templates = [];
    await wfLoad(true);
  } catch (err) {
    showToast(`保存失败：${err.message}`, 'err');
  } finally {
    wfUI.saving = false;
    if (btn) { btn.disabled = false; btn.textContent = '确认保存'; }
  }
}

document.addEventListener('click', (ev) => {
  const t = ev.target;
  const open = t.closest('[data-wf-open]');
  if (open) { wfOpenDetail(open.dataset.wfOpen); return; }
  if (t.closest('#wf-new')) { wfOpenDialog(); return; }
  if (t.closest('[data-wf-back]')) { wfUI.detailReq += 1; wfUI.detail = null; wfUI.detailLoading = false; renderWorkflowTemplates(); return; }
  if (t.closest('[data-wf-retry]')) { wfUI.error = null; wfUI.loaded = false; wfLoad(true); return; }
  const ver = t.closest('[data-wf-version]');
  if (ver && wfUI.detail) { wfOpenDetail(wfUI.detail.template_id, ver.dataset.wfVersion); return; }
  if (t.closest('#wf-close')) { document.getElementById('wf-dialog')?.close(); return; }
  if (t.closest('#wf-generate')) { wfGenerate(); return; }
  if (t.closest('#wf-confirm')) { wfConfirm(); return; }
});

// 点遮罩关掉生成对话框（与原生 dialog 的 Esc 行为一致；输入丢失前弹确认太重，这里直接关）
document.addEventListener('click', (ev) => {
  const dialog = document.getElementById('wf-dialog');
  if (dialog && dialog.open && ev.target === dialog) dialog.close();
});
