'use strict';

/* ================= workflow-runs.js — 看板工作流视图（P0 第四步·界面） =================
   数据只来自后端真表：
     GET /api/workflow/runs          左侧列表（run_id/title/status/current_step/step_name/done_steps/total_steps/target_score）
     GET /api/workflow/runs/:id      中间九步 + 每步交付物 + 需求基线
     GET /api/workflow/artifact      交付物原文（md 渲染 / 代码前 100 行）
     GET /api/workflow/tasklist      docs/开发任务清单与完成情况.md

   普通 tasks 表的渲染逻辑完全不动：本文件只在左侧列表尾部追加「工作流任务」区块，
   在中间区/右侧栏按选中状态接管，不写 tasks 表、不改 tasks 数据。
   ===================================================================================== */

const wfBoard = {
  loaded: false,
  error: null,
  runs: [],
  details: new Map(),   // run_id -> { detail, error }
  runId: null,          // 当前选中的工作流 run
  stepId: null,         // 当前展开的步骤
  artifact: null,       // 当前打开的交付物
  tasklist: null,
};
window.__wfBoard = wfBoard;

const WF_STATUS_LABEL = {
  running: '进行中',
  waiting_human: '等你确认',
  blocked: '已阻塞',
  completed: '已完成',
  failed: '失败',
  switch_agent: '需换人',
  archived: '已归档',
};
const WF_STEP_ICON = { done: '✅', running: '🔵', pending: '⚪', failed: '❌', skipped: '⏭' };

function wfEsc(v) { return esc(String(v == null ? '' : v)); }

function wfPad(n) { return String(n == null ? '' : n).padStart(2, '0'); }

function wfCircled(index) {
  return index >= 1 && index <= 20 ? String.fromCharCode(0x245F + index) : `(${index})`;
}

function wfRunById(runId) {
  return wfBoard.runs.find((r) => r.run_id === runId) || null;
}

function wfDetailOf(runId) {
  const rec = wfBoard.details.get(runId);
  return rec ? rec.detail : null;
}

/** 选中态给 render.js / app.js 用（不要读 wfBoard 内部细节）。 */
function workflowSelected() { return !!(wfBoard.runId && !offline); }

function workflowTopTitle() {
  const run = wfRunById(wfBoard.runId);
  return run ? run.title : '';
}

function resetWorkflowSelection() {
  wfBoard.runId = null;
  wfBoard.stepId = null;
}

function wfTotalOf(run) {
  return Number(run && run.total_steps) || 9;
}

function wfDoneOf(run) {
  if (run && run.done_steps != null) return Number(run.done_steps) || 0;
  if (run && run.progress) return Number(run.progress.done) || 0;
  return 0;
}

function wfPercentOf(run) {
  if (run && run.percent != null) return Number(run.percent) || 0;
  if (run && run.progress) return Number(run.progress.percent) || 0;
  const total = wfTotalOf(run);
  return total ? Math.round(wfDoneOf(run) / total * 100) : 0;
}

function wfCurrentText(run) {
  const idx = Number(run && (run.step_index || run.current_step));
  const total = wfTotalOf(run);
  const name = run && (run.step_name || run.current_step_name) || '—';
  return `${idx ? wfPad(idx) : '—'}/${wfPad(total)} ${name}`;
}

function wfArtifactsOf(step) {
  if (!step || !Array.isArray(step.artifacts)) return [];
  return step.artifacts
    .map((a) => (typeof a === 'string' ? a : (a && (a.path || a.name)) || ''))
    .filter(Boolean);
}

function wfArtifactName(p) {
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function wfArtifactExt(p) {
  const m = String(p).match(/\.([A-Za-z0-9]+)$/);
  return m ? m[1].toUpperCase() : 'FILE';
}

/* ---------------- 数据读取 ---------------- */

async function refreshWorkflowDetail(runId, timeoutMs) {
  try {
    const body = await api(`/api/workflow/runs/${encodeURIComponent(runId)}`, undefined, timeoutMs);
    wfBoard.details.set(runId, { detail: body.run, error: null });
    return body.run;
  } catch (err) {
    const prev = wfBoard.details.get(runId);
    // 轮询失败时保留上一份好数据，只记错误，不让页面突然空掉。
    wfBoard.details.set(runId, {
      detail: prev ? prev.detail : null,
      error: (err && err.message) || '读取失败',
    });
    return null;
  }
}

/** tick() 每轮调用；先列表、再按需刷新当前 run 的详情。 */
async function refreshWorkflowRuns(timeoutMs) {
  if (offline) return;
  try {
    const body = await api('/api/workflow/runs', undefined, timeoutMs);
    wfBoard.runs = Array.isArray(body.runs) ? body.runs : [];
    wfBoard.loaded = true;
    wfBoard.error = null;
    if (wfBoard.runId && !wfRunById(wfBoard.runId)) {
      wfBoard.runId = null;
      wfBoard.stepId = null;
    }
  } catch (err) {
    wfBoard.loaded = true;
    wfBoard.error = (err && err.message) || '工作流列表读取失败';
    return;   // 保留上一份 runs（过期数据也不清空）
  }
  if (wfBoard.runId) await refreshWorkflowDetail(wfBoard.runId, timeoutMs);
}

/* ---------------- 交互 ---------------- */

function selectWorkflowRun(runId) {
  if (!runId) return;
  wfBoard.runId = runId;
  wfBoard.stepId = null;
  if (typeof ui !== 'undefined') ui.view = 'chain';
  if (typeof saveUiPos === 'function') saveUiPos();
  renderAll();
  if (!wfDetailOf(runId)) {
    refreshWorkflowDetail(runId).then(() => renderAll());
  }
}

function toggleWorkflowStep(stepId) {
  wfBoard.stepId = wfBoard.stepId === stepId ? null : stepId;
  renderAll();
}

function wfRetryDetail() {
  if (!wfBoard.runId) return;
  refreshWorkflowDetail(wfBoard.runId).then(() => renderAll());
}

/* ---------------- 左侧列表（追加到 tasks 列表尾部） ---------------- */

function renderWorkflowReqList() {
  const list = document.getElementById('reqs-list');
  if (!list || offline) return;
  const old = document.getElementById('wf-reqs');
  if (old) old.remove();

  const runs = wfBoard.runs || [];
  const q = (typeof ui !== 'undefined' && ui.search ? ui.search : '').trim().toLowerCase();
  const shown = q
    ? runs.filter((r) => String(r.title || '').toLowerCase().includes(q)
        || String(r.run_id || '').toLowerCase().includes(q))
    : runs;

  let inner;
  if (!wfBoard.loaded) {
    inner = '<div class="wf-req-hint">工作流读取中…</div>';
  } else if (wfBoard.error && !runs.length) {
    inner = `<div class="wf-req-hint wf-req-err">工作流读取失败：${wfEsc(wfBoard.error)}</div>`;
  } else if (!shown.length) {
    inner = `<div class="wf-req-hint">${q ? '没有匹配的工作流任务' : '还没有工作流任务'}</div>`;
  } else {
    inner = shown.map((run) => {
      const sel = run.run_id === wfBoard.runId;
      const st = run.status || 'running';
      const pct = wfPercentOf(run);
      const idx = Number(run.step_index || run.current_step) || null;
      return `<button type="button" class="req-item wf-req-item s-${wfEsc(st)}${sel ? ' sel' : ''}" data-wf-run="${wfEsc(run.run_id)}" title="${wfEsc(run.title)}&#10;当前 ${wfEsc(wfCurrentText(run))}">
        <span class="wf-req-top">
          <span class="req-name">${wfEsc(run.title)}</span>
          <span class="wf-badge wf-b-${wfEsc(st)}">${wfEsc(st)}</span>
        </span>
        <span class="req-line2">
          <span class="wf-req-step">${idx ? wfPad(idx) : '—'}/${wfPad(wfTotalOf(run))} ${wfEsc(run.step_name || run.current_step_name || '—')}</span>
        </span>
        <span class="wf-req-bar" aria-label="已完成 ${wfDoneOf(run)}/${wfTotalOf(run)}"><i style="width:${pct}%"></i></span>
      </button>`;
    }).join('');
  }

  const wrap = document.createElement('div');
  wrap.id = 'wf-reqs';
  wrap.className = 'wf-reqs';
  wrap.innerHTML = `<div class="wf-reqs-head"><span>工作流任务</span><b>${wfBoard.error && !runs.length ? '—' : runs.length}</b>
    <span class="wf-reqs-sub">一次需求 = 一个任务 · 内含九步</span></div>${inner}`;
  list.appendChild(wrap);
}

/* ---------------- 中间：九步进度 ---------------- */

function wfStepRowHtml(step, run, expanded) {
  const st = step.status || 'pending';
  const arts = wfArtifactsOf(step);
  const n = arts.length;
  const countText = st === 'pending' ? '等待开始'
    : n > 0 ? `交付物 ${n} 件`
    : st === 'done' ? '未挂交付物'
    : st === 'running' ? '未挂交付物'
    : '未挂交付物';
  const icon = WF_STEP_ICON[st] || '·';
  return `<li class="wf-step s-${wfEsc(st)}${expanded ? ' open' : ''}" data-wf-step-item="${wfEsc(step.step_id)}">
    <button type="button" class="wf-step-row" data-wf-step="${wfEsc(step.step_id)}" aria-expanded="${expanded ? 'true' : 'false'}">
      <span class="wf-step-num">${wfCircled(step.index || 0)}</span>
      <span class="wf-step-name">${wfEsc(step.name)}</span>
      <span class="wf-step-state">${icon} ${wfEsc(st)}</span>
      <span class="wf-step-count">${countText}</span>
      <span class="wf-step-chev" aria-hidden="true">${expanded ? '▼' : '►'}</span>
    </button>
    ${expanded ? wfStepBodyHtml(step, run) : ''}
  </li>`;
}

function wfStepBodyHtml(step, run) {
  const st = step.status || 'pending';
  const arts = wfArtifactsOf(step);
  if (st === 'pending') {
    return `<div class="wf-step-body"><div class="wf-step-note">还没到这一步。当前停在第 ${wfPad(Number(run && (run.step_index || run.current_step)) || 0)} 步，走到这里时再展开交付物。</div></div>`;
  }
  if (!arts.length) {
    return `<div class="wf-step-body"><div class="wf-step-note">未挂交付物。</div></div>`;
  }
  const rows = arts.map((p, i) => `<button type="button" class="wf-art" data-wf-artifact="${wfEsc(p)}" title="${wfEsc(p)}">
    <span class="wf-art-idx">${wfPad(i + 1)}</span>
    <span class="wf-art-icon">${wfEsc(wfArtifactExt(p))}</span>
    <span class="wf-art-main"><b>${wfEsc(wfArtifactName(p))}</b><small>${wfEsc(p)}</small></span>
    <span class="wf-art-open">查看 →</span>
  </button>`).join('');
  return `<div class="wf-step-body">
    <div class="wf-step-body-h">本步交付物 · ${arts.length} 件</div>
    <div class="wf-art-list">${rows}</div>
  </div>`;
}

function renderWorkflowCenter() {
  const box = document.getElementById('center-chain');
  const runId = wfBoard.runId;
  const summary = wfRunById(runId);
  const rec = wfBoard.details.get(runId);
  const detail = rec ? rec.detail : null;

  if (!detail && !summary) {
    box.innerHTML = '<div class="empty"><p>工作流任务读取中…</p></div>';
    return;
  }
  const run = detail || summary;
  const st = run.status || 'running';
  const pct = wfPercentOf(run);
  const total = wfTotalOf(run);
  const curIdx = Number(run.step_index || run.current_step) || null;
  const curName = run.step_name || (run.current_step_detail && run.current_step_detail.name) || '—';
  const score = run.target_score == null ? '—' : String(run.target_score);
  const steps = detail && Array.isArray(detail.steps) ? detail.steps : [];
  const currentStep = steps.find((s) => s.step_id === run.current_step);

  const reason = run.status_reason
    ? `<div class="wf-reason">${wfEsc(run.status_reason)}</div>` : '';
  const loadingNotice = !detail
    ? `<div class="wf-loading">${rec && rec.error ? `九步详情读取失败：${wfEsc(rec.error)} <button type="button" class="wf-link" data-wf-retry="1">重试</button>` : '九步详情读取中…'}</div>` : '';

  const stepsHtml = steps.length
    ? steps.map((s) => wfStepRowHtml(s, run, s.step_id === wfBoard.stepId)).join('')
    : '';

  const baseline = run.requirement_baseline
    ? `<blockquote>${wfEsc(run.requirement_baseline)}</blockquote>`
    : `<div class="wf-step-note">还没有登记需求基线。</div>`;

  box.innerHTML = `<div class="wf-center">
    <header class="wf-head">
      <div class="wf-eyebrow">AGENT OFFICE · WORKFLOW RUN</div>
      <h2>${wfEsc(run.title)}</h2>
      <div class="wf-meta-line">
        <span>目标分 <b>${wfEsc(score)}</b></span>
        <span class="wf-dot">·</span>
        <span>当前 <b>${curIdx ? wfPad(curIdx) : '—'}/${wfPad(total)}</b> ${wfEsc(curName)}</span>
        <span class="wf-badge wf-b-${wfEsc(st)}">${wfEsc(st)}</span>
        ${st === 'waiting_human' ? '<span class="wf-wait">等你确认</span>' : ''}
      </div>
      ${reason}
      <div class="wf-progress"><i style="width:${pct}%"></i></div>
      <div class="wf-progress-label">已完成 ${wfDoneOf(run)}/${total} 步 · ${pct}%<span class="wf-runid">run ${wfEsc(run.run_id)}</span></div>
    </header>
    ${loadingNotice}
    <ol class="wf-steps" aria-label="工作流九步">${stepsHtml}</ol>
    <section class="wf-baseline">
      <h3>需求基线（Leo 确认过，不可改）</h3>
      ${baseline}
    </section>
  </div>`;
}

/* ---------------- 右侧：步骤详情 ---------------- */

function renderWorkflowInspector(body, foot) {
  if (foot) { foot.innerHTML = ''; foot.hidden = true; }
  if (!body) return;
  const head = document.querySelector('#inspector .insp-head');
  if (head) head.textContent = '工作流步骤';

  const run = wfDetailOf(wfBoard.runId) || wfRunById(wfBoard.runId);
  if (!run) { body.innerHTML = '<div class="insp-empty">工作流任务读取中…</div>'; return; }
  const steps = Array.isArray(run.steps) ? run.steps : [];
  const step = steps.find((s) => s.step_id === wfBoard.stepId);
  if (!step) {
    const score = run.target_score == null ? '—' : run.target_score;
    body.innerHTML = `<div class="inspector-content">
      <div class="ip-step">WORKFLOW RUN</div>
      <h3 class="ip-name">${wfEsc(run.title)}</h3>
      <div class="ip-time">当前 ${wfEsc(wfCurrentText(run))} · <span class="wf-badge wf-b-${wfEsc(run.status)}">${wfEsc(run.status)}</span></div>
      <div class="ip-sec"><h4>目标分</h4><div class="ip-v">${wfEsc(score)}</div></div>
      <div class="ip-sec"><h4>进度</h4><div class="ip-v">已完成 ${wfDoneOf(run)}/${wfTotalOf(run)} 步（${wfPercentOf(run)}%）</div></div>
      <div class="ip-sec"><h4>怎么看</h4><div class="ip-none">点中间任意一步，展开这一步的交付物。</div></div>
      <div class="ip-sec"><h4>需求基线</h4>${run.requirement_baseline ? `<p class="ip-note">${wfEsc(run.requirement_baseline)}</p>` : '<div class="ip-none">—</div>'}</div>
    </div>`;
    return;
  }

  const st = step.status || 'pending';
  const arts = wfArtifactsOf(step);
  const actors = [step.actor, step.fallback_actor ? `备选 ${step.fallback_actor}` : ''].filter(Boolean).join(' · ') || '—';
  const filesHtml = st === 'pending'
    ? '<div class="ip-none">还没到这一步</div>'
    : arts.length
      ? arts.map((p) => `<button type="button" class="ip-file wf-insp-file" data-wf-artifact="${wfEsc(p)}" title="${wfEsc(p)}">
          <i class="fm">·</i><span class="fn">${wfEsc(wfArtifactName(p))}</span><span class="ft">查看 →</span>
        </button>`).join('')
      : '<div class="ip-none">未挂交付物</div>';

  body.innerHTML = `<div class="inspector-content wf-insp">
    <div class="ip-step">STEP ${wfPad(step.step_id)} / ${wfPad(wfTotalOf(run))}</div>
    <h3 class="ip-name">${wfEsc(step.name)} <span class="wf-badge wf-b-${wfEsc(st)}">${wfEsc(st)}</span></h3>
    <div class="ip-time">${step.entered_at ? '进入 ' + esc(fmtTime(step.entered_at)) : '时间 —'}</div>
    <div class="ip-sec"><h4>执行者</h4><div class="ip-v">${wfEsc(actors)}</div></div>
    <div class="ip-sec"><h4>判据</h4><div class="ip-v wf-gate">${wfEsc(step.gate || '—')}</div></div>
    <div class="ip-sec"><h4>本步交付物</h4>${filesHtml}</div>
    <div class="ip-sec"><h4>需求基线</h4>${run.requirement_baseline ? `<p class="ip-note">${wfEsc(run.requirement_baseline)}</p>` : '<div class="ip-none">—</div>'}</div>
  </div>`;
}

/* ---------------- 交付物弹窗 / 任务清单弹窗 ---------------- */

function wfModalEls() {
  return {
    box: document.getElementById('wf-modal'),
    kicker: document.getElementById('wf-modal-kicker'),
    title: document.getElementById('wf-modal-title'),
    meta: document.getElementById('wf-modal-meta'),
    body: document.getElementById('wf-modal-body'),
  };
}

function wfOpenModal(kicker, title) {
  const m = wfModalEls();
  if (!m.box) return m;
  m.kicker.textContent = kicker;
  m.title.textContent = title || '';
  m.meta.textContent = '';
  m.body.innerHTML = '<div class="wf-loading">读取中…</div>';
  m.box.hidden = false;
  document.body.classList.add('wf-modal-open');
  return m;
}

function wfCloseModal() {
  const m = wfModalEls();
  wfBoard.artifact = null;
  if (!m.box) return;
  m.box.hidden = true;
  m.body.innerHTML = '';
  document.body.classList.remove('wf-modal-open');
}

function wfFmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(2)} MB`;
}

async function openWorkflowArtifact(path) {
  if (!path) return;
  wfBoard.artifact = path;
  const m = wfOpenModal('交付物', wfArtifactName(path));
  try {
    const d = await api('/api/workflow/artifact?path=' + encodeURIComponent(path), undefined, 12000);
    if (wfBoard.artifact !== path) return;   // 期间又点了别的文件
    m.meta.textContent = `${d.kind} · ${wfFmtBytes(d.bytes)}${d.lines ? ' · ' + d.lines + ' 行' : ''}`;
    if (d.kind === 'binary') {
      m.body.innerHTML = `<div class="wf-step-note">${wfEsc(d.note || '二进制文件，看板不预览。')}<br><span class="wf-path">${wfEsc(d.path)}</span></div>`;
      return;
    }
    if (d.kind === 'markdown') {
      m.body.innerHTML = `<div class="wf-md">${wfMdToHtml(d.text)}</div>
        ${d.truncated ? '<div class="wf-trunc">文件超过 1MB，只渲染前 1MB。</div>' : ''}
        <div class="wf-path-foot">${wfEsc(d.path)}</div>`;
      return;
    }
    const all = String(d.text || '').split(/\r?\n/);
    const first = all.slice(0, 100);
    const rows = first.map((line, i) => `<span class="wf-code-line"><i>${String(i + 1).padStart(3, ' ')}</i>${wfEsc(line)}</span>`).join('');
    const more = all.length > 100
      ? `<div class="wf-trunc">只显示前 100 行；本文件共 ${all.length} 行（约 ${wfFmtBytes(d.bytes)}）。</div>` : '';
    m.body.innerHTML = `<pre class="wf-code">${rows}</pre>${more}<div class="wf-path-foot">${wfEsc(d.path)}</div>`;
  } catch (err) {
    if (wfBoard.artifact !== path) return;
    m.body.innerHTML = `<div class="wf-loading wf-req-err">交付物读取失败：${wfEsc((err && err.message) || '未知错误')}</div>`;
  }
}

async function openWorkflowTaskList() {
  const m = wfOpenModal('开发任务清单', '开发任务清单与完成情况');
  try {
    const d = await api('/api/workflow/tasklist', undefined, 12000);
    wfBoard.tasklist = d;
    m.meta.textContent = `${d.bytes || 0} B · 更新 ${d.modified_at ? fmtTime(d.modified_at) : '—'}`;
    m.body.innerHTML = `<div class="wf-md">${wfMdToHtml(d.text || '')}</div>
      <div class="wf-path-foot">${wfEsc(d.path)}</div>`;
  } catch (err) {
    m.body.innerHTML = `<div class="wf-loading wf-req-err">任务清单读取失败：${wfEsc((err && err.message) || '未知错误')}</div>`;
  }
}

/* ---------------- 极简 Markdown 渲染（先转义，再只加白名单标签） ---------------- */

function wfMdInline(raw) {
  let s = esc(String(raw == null ? '' : raw));
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, text, href) => {
    const h = String(href);
    if (!/^(https?:\/\/|#|\/|\.\.?\/)/i.test(h)) return whole;
    return `<a href="${h}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });
  return s;
}

function wfTableHtml(lines, start) {
  const parseRow = (line) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
  const head = parseRow(lines[start]);
  const rows = [];
  let i = start + 2;
  while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
    if (/^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i])) break;
    rows.push(parseRow(lines[i]));
    i++;
  }
  const th = head.map((c) => `<th>${wfMdInline(c)}</th>`).join('');
  const tb = rows.map((r) => `<tr>${r.map((c) => `<td>${wfMdInline(c)}</td>`).join('')}</tr>`).join('');
  return { html: `<div class="wf-table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`, next: i };
}

/** 支持标题 / 列表 / 引用 / 表格 / 代码块 / 分隔线 / 粗斜体 / 行内代码 / 链接。 */
function wfMdToHtml(src) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const isBlockStart = (line) => /^(#{1,6}\s|```|>\s?|\s*([-*+]|\d+\.)\s+|---+\s*$|\*\*\*\s*$)/.test(line);

  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { i++; continue; }

    if (/^```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      if (i < lines.length) i++;
      out.push(`<pre class="md-code"><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }

    if (/^(---|\*\*\*|___)\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const n = h[1].length;
      out.push(`<h${n}>${wfMdInline(h[2])}</h${n}>`);
      i++;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
      out.push(`<blockquote>${wfMdToHtml(buf.join('\n'))}</blockquote>`);
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      const t = wfTableHtml(lines, i);
      out.push(t.html);
      i = t.next;
      continue;
    }

    const li = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
    if (li) {
      const ordered = /\d+\./.test(li[2]);
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
        if (!m) break;
        items.push(`<li>${wfMdInline(m[3])}</li>`);
        i++;
      }
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }

    const buf = [line];
    i++;
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlockStart(lines[i])) {
      if (lines[i].includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) break;
      buf.push(lines[i]);
      i++;
    }
    out.push(`<p>${buf.map((l) => wfMdInline(l)).join('<br>')}</p>`);
  }
  return out.join('\n');
}

/* ---------------- 事件绑定 ---------------- */

document.addEventListener('click', (ev) => {
  const close = ev.target.closest('#wf-modal-close');
  if (close) { wfCloseModal(); return; }
  if (ev.target.id === 'wf-modal') { wfCloseModal(); return; }
  const retry = ev.target.closest('[data-wf-retry]');
  if (retry) { wfRetryDetail(); return; }
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    const box = document.getElementById('wf-modal');
    if (box && !box.hidden) wfCloseModal();
  }
});
