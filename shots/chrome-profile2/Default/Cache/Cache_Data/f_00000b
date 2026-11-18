// render.js — G02（R73 第 73 轮）从 app.js 拆出的渲染主干（原 M3 段，纯代码搬移）。
// 只读 app.js 的 M2 状态（页面状态/轮询快照），不写；所有跨文件引用都在函数体内
// 调用期解析（verify-g02-deps.mjs 的 A/B 规则口径）。加载顺序：agents.js → 本文件 → app.js。
// 入口：renderAll（app.js 的 tick/route 与 G04 护栏点名检查它）。
/* ================= M3 · render — 渲染层（只读 M2 的状态，不写） ================= */

/* ================= 渲染 ================= */

/* G02：withScroll → shared.js（version.js 渲染调度也用，放最早加载的共享层） */

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

/* G02：ACTION_CN / renderOpHistory（最近操作记录）→ decision-ops.js */

/* ---- 数据异常横幅（TASK-R2）：模块读失败如实挂出，标明现有数据多旧 ---- */
const MOD_LABEL = { state: '中台状态', flow: '需求流水线', skills: '技能索引', hermes: 'Hermes 状态', decisions: '决策清单' };

function renderDataBanner() {
  const el = document.getElementById('data-banner');
  // R72·G02：样式表完整性横幅优先——页面正裸奔时，「数据正常」不该也不能把警告摘掉
  if (cssFailed) return;
  // G04：每轮按真实模块状态重判失败态样式——上一轮可能是护栏/看门狗挂的 boot-fail，
  // 迟到的成功数据来了就摘掉；首轮 flow 失败（从未成功过）则保持启动失败态，
  // 不允许停在「连接中…」的空白外壳。
  el.classList.remove('boot-fail');
  const names = Object.keys(modErr);
  if (!names.length) { el.hidden = true; el.innerHTML = ''; return; }
  if (!modOkAt.flow && modErr.flow) el.classList.add('boot-fail');
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
  // G06：无任务且处于失败态时，顶部状态信息如实标注（不是空占位「—」）
  document.getElementById('tb-task').textContent = t ? t.title
    : initPhase === 'conn-fail' ? '连接失败'
    : initPhase === 'data-fail' ? '数据获取失败'
    : '—';

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
    // TASK-工作台重做：胶囊说人话——「等你拍板」比「待决策」一眼懂
    const parts = [];
    if (decN > 0) parts.push(`<b>${decN}</b> 件事等你拍板`);
    if (rejN > 0) parts.push(`<b>${rejN}</b> 件被打回，等重交`);
    pill.hidden = false;
    pill.innerHTML = parts.join(' · ');
    pill.title = `可拍板 ${decN} 项 · 待重提 ${rejN} 项，点击查看清单`;
  } else {
    pill.hidden = true;
  }

  // 设置弹层里的连接态（G06：与底栏同一套四态口径，不再用 hubOnline 三态占位）
  const spConn = document.getElementById('sp-conn');
  spConn.textContent = offline ? '离线快照'
    : initPhase === 'connected' ? '已连接'
    : initPhase === 'conn-fail' ? '连接失败'
    : initPhase === 'data-fail' ? '数据获取失败'
    : '加载中';
  spConn.title = offline ? 'file:// 离线快照模式' : (phaseReason || '初始化四态与底部状态栏同口径');
}

/* ---- 底部状态栏 ---- */
function renderStatusbar() {
  const conn = document.getElementById('sb-conn');
  const connText = document.getElementById('sb-conn-text');
  // G06：初始化四态——加载中(wait) / 已连接(ok) / 连接失败(off) / 数据获取失败(off)。
  // 异常文字 #E5B95E、正常 #65D9B1（12px/18px 见 app.css #statusbar 段，规格值不走主题变量）。
  // TASK-11.1（四区分对 #3）：这里说的是本页 ↔ 中台 API 的连接；
  // Agent 实例健不健康看右边每枚 chip（断连/空闲/执行中）——API 通 ≠ Agent 活着。
  conn.classList.remove('wait', 'ok', 'off');
  if (offline) {
    conn.classList.add('off');
    connText.textContent = '离线快照 · ' + fmtTime(snapshot.state.now);
    conn.title = 'file:// 离线快照模式，未连接本地服务';
  } else if (initPhase === 'connected') {
    conn.classList.add('ok');
    connText.textContent = '已连接';
    conn.title = '指本页与中台 API 的连接；各 AI 健不健康看右侧每枚状态点' +
      (hubOnline === false ? '（中台 autoloop 未开启，详见设置弹层）' : '');
  } else if (initPhase === 'conn-fail') {
    conn.classList.add('off');
    connText.textContent = '连接失败 · ' + phaseReason;
    conn.title = `连不上本地服务（/api/health：${phaseReason}）。导航与布局保留，按 2s/4s/8s/30s 自动重试，恢复后自动接回真实数据`;
  } else if (initPhase === 'data-fail') {
    conn.classList.add('off');
    connText.textContent = '数据获取失败 · ' + phaseReason;
    conn.title = `已连上服务，但数据接口读取失败（${phaseReason}）。明细见顶部横幅，可点「重试读取」；恢复后自动接回真实数据`;
  } else {
    conn.classList.add('wait');
    connText.textContent = '连接中…';
    conn.title = '正在发起首轮数据同步';
  }

  // TASK-R3：还没拿到过 state（启动首拍/一直失败）时数字是「未知」，不是 0——
  // 0 是「中台确实没注册任何 Agent」的实测结论，没数据不冒充。
  // 有 lastState 但 state 模块正在报错时是「过期数据」：横幅已标旧，这里如实展示最后已知值。
  const chips = document.getElementById('sb-chips');
  if (!lastState || !Array.isArray(lastState.agents)) {
    document.getElementById('sb-agents').textContent = 'AI 在线 —';
    document.getElementById('sb-agents').setAttribute('title', '中台状态尚未读到，等首轮同步完成');
    document.getElementById('sb-running').textContent = '在干活 —';
    document.getElementById('sb-running').setAttribute('title', '中台状态尚未读到，等首轮同步完成');
    chips.innerHTML = '<span class="sb-note">AI 状态等待首轮同步…</span>';
    return;
  }
  // TASK-R11/G01：中台全量 agents 的在线统计不再在此另算一套——
  // 底栏主数字与 Agents 页同源（agentStats 名册），避免 7/7 与 4/4 打架。
  const staleNote = modErr.state ? '上一次成功读取的快照（顶部横幅可见时长）' : '';
  // TASK-工作台重做：底栏只说人话「N 个 AI 在线（另 X 情况不明）」；专业口径
  // （一线/注册/同源说明）全收进 tooltip，专业视图和 Agents 页签里看全量。
  const st = agentStats();
  const unknownNote = st.hasUnknown ? `；${st.roster.length - st.firstLine} 个未上报（状态未知，不计入在线）` : '';
  document.getElementById('sb-agents').textContent = `AI ${st.rosterOnline} 个在线${st.hasUnknown ? '（另 ' + (st.roster.length - st.firstLine) + ' 个情况不明）' : ''}`;
  document.getElementById('sb-agents').setAttribute('title', staleNote || `与 Agents 页同口径（agentStats）：一线角色 ${st.roster.length}、在线 ${st.rosterOnline}${unknownNote}。中台共注册角色 ${st.registered == null ? '—' : st.registered} 个（含未启用的壳角色），Agents 页统计卡可见分层`);
  document.getElementById('sb-agents').setAttribute('data-note', '一线口径=Agents页同源');
  const runEl = document.getElementById('sb-running');
  runEl.textContent = `在干活 ${st.rosterBusy}`;
  runEl.classList.toggle('run', st.rosterBusy > 0);
  runEl.setAttribute('title', staleNote || '正在干活的 AI 数（含重试中），与 Agents 页同口径');
  // R9（评审 Agents）：每个 Agent 一枚状态点+岗位——busy 绿 / idle 灰 / unknown 灰蓝 / down 断连，
  // 点击整排跳到 Agents 页。TASK-R11/G01：chips 同样从 agentStats() 名册渲染，
  // 带 roleId/instanceId，与 Agents 页逐一对应。A02：chip 只报名册的 conn/work 字段，
  // 与 Agents 页「连接健康 / 执行状态」列同一判定——执行状态未知就显示未知，不推断成空闲。
  chips.innerHTML = st.roster.map((s) => {
    const cls = !s.loaded ? 'unknown' : s.work === 'working' ? 'busy' : s.work === 'idle' ? 'idle' : s.conn === 'online' ? 'unknown' : 'down';
    const connTxt = !s.loaded ? '未知' : s.conn === 'online' ? '在线' : '离线';
    const workTxt = WORK_CN[s.work] || '未知';
    const state = `连接：${connTxt}｜执行状态：${workTxt}${s.workUnknownWhy ? `（${s.workUnknownWhy}）` : ''}`;
    return `<button type="button" class="sb-chip ${cls}" title="角色：${esc(s.role)}（ID ${esc(s.roleId)}）｜编号 ${s.loaded ? esc(s.instanceId) : '未上报'}｜${esc(state)}｜点击查看 AI 明细"><i></i>${esc(s.name)}</button>`;
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
      // G06：中央区如实区分失败原因——连接失败（连不上服务）与数据获取失败分开口径
      msg = modErr.flow && !modOkAt.flow
        ? (initPhase === 'conn-fail'
            ? `连接失败（${esc(phaseReason)}）。<br>导航与布局保留，按 2s/4s/8s/30s 自动重试，恢复后接回真实数据。`
            : `需求流水线读取失败（${esc(phaseReason || modErr.flow)}）。<br>原因见顶部横幅，可点「重试读取」。`)
        : '需求流水线读取中…';
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

  const trackHtml = chainTrackHtml(stepsSorted, focus);        // G02：导航轨渲染拆出
  const summaryFiles = chainSummaryFilesHtml(t, focus);        // G02：产物与交接列表拆出

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

// G02：横向导航轨渲染（自 renderChain 拆出）——一格一步，只放 编号 + 短名 + 状态点；
// 点击即选中（与 Inspector 同一数据路径）。
function chainTrackHtml(stepsSorted, focus) {
  return stepsSorted.map((x) => {
    // W02：类名/提示用展示态——waitpre 的点走灰系，title 说明在等谁
    const ds = dispStepState(x, stepsSorted);
    const waitTip = ds === 'waitpre' ? `（等 ${waitingOnOf(x, stepsSorted).join('、')} 通过）` : '';
    return `<button type="button" class="track-node st-${esc(ds)}${x.key === focus.key ? ' cur' : ''}" data-step="${esc(x.key)}" title="${String(x.no ?? '').padStart(2, '0')} ${esc(x.name)} · ${esc(STEP_LABEL[ds] || ds)}${esc(waitTip)}">
      <span class="tn-no">${String(x.no ?? '').padStart(2, '0')}</span>
      <span class="tn-name">${esc(x.name)}</span>
      <i class="tn-dot"></i>
    </button>`;
  }).join('');
}

// G02：中央「产物与交接」列表（自 renderChain 拆出）。
// W02（版本门禁轮）：异常标签与右侧审批面板、审批接口消费同一份服务端
// 判定（version-gate，按 taskId+stepKey 取当前选中步骤），不再本地另算一套：
// 判定未到手时只并列双值不打标签；标签按 why 分口径——bytes=大小不一致、
// sha=内容不一致（大小相同、指纹对不上）。
function chainSummaryFilesHtml(t, focus) {
  const focusFiles = dedupFiles(focus.files || []);
  const vgMap = versionGate && versionGate.key === `${t.id}/${focus.key}`
    ? new Map(versionGate.drifted.map((d) => [physKey(d.path), d]))
    : null;
  // W01（第 79 轮）：核对通过的文件也取服务端内容级证据——「指纹 ✓」=大小与内容
  // 双一致（登记 sha256 与现算值比对通过），异常标签之外的正面标签同源同款。
  const vgOk = versionGate && versionGate.key === `${t.id}/${focus.key}`
    ? new Map((Array.isArray(versionGate.verified) ? versionGate.verified : []).map((v) => [physKey(v.path), v]))
    : null;
  return focusFiles.map((f) => {
    const np = normPath(f.path);
    const pk = physKey(f.path);
    const chk = fileStatus.get(pk);   // F02：物理键与文件库同一份校验结果
    const missing = chk && chk.exists === false;
    // F01：实测/登记双口径分开列——实测值不覆盖登记值，登记缺失显「—」（fmtBytes(null)），不判一致；
    // 不一致时给异常标签（与文件库 .lf-tag.mism 同一套 12px/18px · #E5B95E/#3B3021 规范）
    const regB = fmtBytes(f.bytes);
    const vd = vgMap ? vgMap.get(pk) : undefined;
    const vv = vgOk ? vgOk.get(pk) : undefined;
    const okTag = vv && vv.shaMatch && vv.regSha
      ? `<i class="hf-tag shaok" title="服务端已现算 SHA-256 与登记指纹比对通过：大小与内容双一致">指纹 ${esc(String(vv.regSha).slice(0, 8))} ✓</i>`
      : '';
    const anomTag = vd && vd.why === 'bytes'
      ? `<i class="hf-tag mism" title="登记 ${esc(fmtBytes(vd.regBytes))} ≠ 实测 ${esc(fmtBytes(vd.actBytes))}；登记原文保留、不自动更新，点开预览可核对">大小不一致</i>`
      : vd && vd.why === 'sha'
        ? `<i class="hf-tag mism" title="大小相同（${esc(fmtBytes(vd.regBytes))}）但内容指纹与登记不一致；登记原文保留、不自动更新，点开预览可核对">内容不一致</i>`
        : '';
    let meta;
    if (missing) meta = '文件不存在';
    else if (chk && chk.exists) {
      const actB = fmtBytes(chk.bytes);
      meta = `${okTag}${anomTag}<span class="hf-val">实测 ${esc(actB)}</span><span class="hf-val">登记 ${esc(regB)}</span> · ${esc(focus.by || '—')}`;
    } else meta = `${esc(regB)}（登记） · ${esc(focus.by || '—')}`;
    return `<div class="handoff-file${missing ? ' miss' : ''}" data-open-file="${esc(f.path)}" title="${esc(f.path)}&#10;点击预览内容" role="button" tabindex="0">
      <span class="hf-name">${esc(np.split('/').pop())}</span>
      <span class="hf-meta">${meta}</span>
    </div>`;
  }).join('');
}

/* ---- 中：全部需求概览（一行一个需求，点行回到交付链） ---- */
function renderOverview() {
  const box = document.getElementById('center-overview');
  const tasks = (lastFlow && lastFlow.tasks) || [];
  if (!lastFlow) {   // TASK-R4（评审 #1）：未读到 ≠ 空集；G06：失败时带上原因口径
    const msg = modErr.flow && !modOkAt.flow
      ? (initPhase === 'conn-fail'
          ? `连接失败（${esc(phaseReason)}）。导航与布局保留，自动重试中。`
          : `需求流水线读取失败（${esc(phaseReason || modErr.flow)}）。原因见顶部横幅。`)
      : '需求流水线读取中…';
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
  const foot = document.getElementById('insp-foot');   // W01：审批操作固定底栏
  const hideFoot = () => { if (foot) { foot.innerHTML = ''; foot.hidden = true; } };
  const t = currentTask();
  if (!t) {
    body.innerHTML = '<div class="insp-empty">点左边任意一步看详情</div>';
    hideFoot();
    return;
  }
  const steps = (t.steps || []).slice().sort((a, b) => (a.no ?? 0) - (b.no ?? 0));
  const idx = steps.findIndex((s) => s.key === ui.stepKey);
  if (idx < 0) {
    body.innerHTML = '<div class="insp-empty">点左边任意一步看详情</div>';
    hideFoot();
    return;
  }
  const s = steps[idx];
  const st = dispStepState(s, steps);   // W02：展示态（awaiting 前置未齐 → waitpre）
  const label = STEP_LABEL[st] || st;

  const files = inspFilesHtml(s);   // G02：产物双口径列表拆出（见下方）

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

  // W01：decideHtml 拆回 {html, acts}——说明留在卡里随内容滚动，
  // 审批按钮进右栏固定底栏，长内容不再把操作推出首屏。
  const dec = decideHtml(t, s, steps, idx);

  body.innerHTML = `
    <div class="inspector-content">
      <div class="ip-step">STEP ${String(s.no ?? '').padStart(2, '0')}</div>
      <h3 class="ip-name">${esc(s.name)} <span class="st st-${esc(st)}">${esc(label)}</span></h3>
      <div class="ip-time">${s.at ? esc(fmtTime(s.at)) + ' · ' + esc(ago(s.at)) : '时间 —'}</div>

      ${dec.html}

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

  // W01：有审批按钮才显示固定底栏；done/pending/等待前置/门禁未到等步骤不占位。
  // 按钮仍带 data-decide，走 document 级事件委托，移位不改点击行为。
  if (dec.acts) {
    foot.innerHTML = dec.acts;
    foot.hidden = false;
  } else {
    hideFoot();
  }
}

// G02：Inspector 产物列表（自 renderInspector 拆出）。
// 产物字节双口径（TASK-R2）：登记值是 flow 档案写的，实测值是服务端 stat 的。
// 没核实过 / 文件不在 → 只展示登记值并标「登记」；核实过且不一致 → 双显，让差异可见。
function inspFilesHtml(s) {
  return dedupFiles(s.files).map((f) => {
    const np = normPath(f.path);
    const chk = fileStatus.get(physKey(f.path));   // F02：物理键与文件库同一份校验结果
    const exists = chk ? chk.exists === true : null;
    const name = np.split('/').pop();
    const sizeHtml = !chk || !chk.exists
      ? `<span class="fb reg">登记 ${fmtBytes(f.bytes)}</span>`
      : (f.bytes != null && chk.bytes != null && chk.bytes !== f.bytes)
        ? `<span class="fb">${fmtBytes(chk.bytes)}</span><span class="fb reg">登记 ${fmtBytes(f.bytes)}</span>`
        // F01：登记值缺失时只显实测并标「登记 —」——缺登记无从比较，不得默认一致
        : f.bytes != null
          ? `<span class="fb">${fmtBytes(chk.bytes)}</span>`
          : `<span class="fb">${fmtBytes(chk.bytes)}</span><span class="fb reg">登记 —（缺失）</span>`;
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
}

/* G02：M4 审批门禁镜像 + 决策面板（decideHtml）→ approval.js */

