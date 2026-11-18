// cabin.js — TASK-工作台重做（2026-11-18）：面向 AI 小白的三个主页面。
//   我的任务（驾驶舱：一句话说清现在在干什么 + 真实进度 + 唯一主按钮）
//   干活记录（每个 AI 干了什么/正在干嘛，人话时间线）
//   设置·常用页（目标分默认值 + 术语小抄；Agents/技能/文件三个专业页签由
//   index.html 挪进设置页，本文件只管页签切换与常用页）
// 加载位置：agents.js 之后、render.js 之前——只引用更早加载的模块入口
// （shared/approval/version/agents/decision-ops），被 render.js/app.js 调用期引用。
// 术语口径（任务书钉死）：首页只用大白话，专业词只允许出现在设置页的对照表里。

/* ================= 术语映射（任务书术语表，首页文案的唯一词源） ================= */
const STEP_HUMAN = {
  req: '你的想法', doc: '确认好的需求', plan: '打算怎么做', brief: '给 Claude 的活',
  deliverable: '做出来的东西', verify: '检查结果', final: '最后交接',
};
// 确认按钮的人话文案（approval.js 的 APPROVE_LABEL 带专业词，首页不能直接用）
const CABIN_APPROVE = {
  req: '我确认，开始做', doc: '确认，按这个需求来', plan: '确认，就这么做',
  brief: '确认，把活派下去', deliverable: '确认，东西没问题', verify: '确认，检查通过',
  final: '确认，交付完成',
};
function stepHumanName(s, steps) {
  if (STEP_HUMAN[s.key]) return STEP_HUMAN[s.key];
  return s.name || '这一步';
}
// 前置等待名单里的专业步骤名 → 人话（waitingOnOf 返回的是 name，按 name 反查 key）
function humanStepNames(steps, names) {
  return (names || []).map((n) => {
    const st = (steps || []).find((x) => x.name === n);
    return st && STEP_HUMAN[st.key] ? STEP_HUMAN[st.key] : n;
  });
}
// 任务标题等动态数据的显示层去专业词（术语表口径）。标题是后端数据，不是 UI 文案，
// 实测出现过「产物库文件浏览与预览」这种标题——首页的禁用词约束照样管住它。
// 只影响首页显示，专业视图与档案数据一字不动。
const PLAIN_WORDS = [
  ['SHA-256', '文件校验'], ['字节', '大小'], ['指纹', '校验'], ['加权', '综合'],
  ['门禁', '把关'], ['实例', '在线'], ['心跳', '动静'], ['产物', '东西'],
];
function plainDyn(s) {
  return PLAIN_WORDS.reduce((acc, [from, to]) => acc.split(from).join(to), String(s));
}

/* ================= 目标分（Leo 决策一：每个任务一份，默认 8.0，可改） =================
   后端任务档案里没有分数字段（实测核对过），目标分是前端一等的用户设置：
   office.score.v1 = { def: 8.0, tasks: { <taskId>: 7.5 } }。
   「当前分」没有数据源就如实显示「还没打分」，绝不造分。 */
const SCORE_DEF = 8.0;
function scoreStore() {
  try { return JSON.parse(localStorage.getItem('office.score.v1') || '{}') || {}; } catch { return {}; }
}
function scoreSave(s) {
  try { localStorage.setItem('office.score.v1', JSON.stringify(s)); } catch { /* 隐私模式 */ }
}
function defaultScore() {
  const v = scoreStore().def;
  return Number.isFinite(v) ? v : SCORE_DEF;
}
function setDefaultScore(v) {
  const s = scoreStore();
  s.def = v;
  scoreSave(s);
}
function targetScoreOf(taskId) {
  const s = scoreStore();
  const t = s.tasks && s.tasks[taskId];
  return Number.isFinite(t) ? t : defaultScore();
}
function setTargetScore(taskId, v) {
  const s = scoreStore();
  s.tasks = s.tasks || {};
  s.tasks[taskId] = v;
  scoreSave(s);
}

/* ================= 页面状态 ================= */
let settingsTab = 'general';            // 设置页当前页签：general | agents | skills | files
const cabinUI = { pastOpen: false, noteOpen: false, scoreEdit: false, tasksOpen: false };

// 设置页签切换：按钮高亮 + 四个子面板显隐（page-agents/skills/files 从一级页挪进来）
function syncSettingsTabs() {
  document.querySelectorAll('#page-settings [data-settab]').forEach((b) => {
    b.classList.toggle('on', b.dataset.settab === settingsTab);
  });
  for (const [tab, id] of [['general', 'set-general'], ['agents', 'page-agents'], ['skills', 'page-skills'], ['files', 'page-files']]) {
    const el = document.getElementById(id);
    if (el) el.hidden = tab !== settingsTab;
  }
}

/* ================= 顶栏：目标 8.0 · 当前 —（renderTopbar 之后由 renderModules 调） ================= */
function renderScorePill() {
  const el = document.getElementById('tb-score');
  if (!el) return;
  const t = currentTask();
  if (!t) { el.hidden = true; return; }
  const target = targetScoreOf(t.id);
  el.hidden = false;
  // 当前分没有数据源：如实「还没打分」。有评分记录的口径以后端出现真实字段为准。
  el.innerHTML = `目标 <b>${target.toFixed(1)}</b> · 当前 <b class="ts-na">还没打分</b>`;
  el.title = `这个任务要做到 ${target.toFixed(1)} 分算完成。点这里去「我的任务」改目标分。`;
}

/* ================= AI 状态人话（驾驶舱/干活记录共用 agentStats() 这一份名册） ================= */
function rosterPlain(st) {
  return st.roster.map((r) => {
    if (!r.loaded) return { name: r.name, role: r.role, text: '状态未知（没有上报）', cls: 'unknown' };
    if (r.conn !== 'online') return { name: r.name, role: r.role, text: '没连上', cls: 'down' };
    if (r.work === 'working') {
      // hbState 口径（agents.js）：'ok' 新鲜 / 'timeout' 停滞 / 'none' 没报过
      const fresh = r.hbState === 'ok' && r.hbText && r.hbText !== '—';
      return { name: r.name, role: r.role, cls: 'busy',
        text: `在干活${fresh ? ` · 上次动静 ${r.hbText}` : ''}${r.taskText && r.taskText !== '—' ? ` · ${r.taskText}` : ''}` };
    }
    if (r.work === 'idle') return { name: r.name, role: r.role, text: '空着，没在干活', cls: 'idle' };
    if (r.hbState === 'timeout') return { name: r.name, role: r.role, text: '已经有一阵没动静，可能卡住了', cls: 'unknown' };
    return { name: r.name, role: r.role, text: `在不在干未知${r.workUnknownWhy ? `（${r.workUnknownWhy}）` : ''}`, cls: 'unknown' };
  });
}
function rosterHeadline(st) {
  if (!lastState || !Array.isArray(lastState.agents)) return 'AI 状态还没读到（等首轮同步完成）';
  const on = st.rosterOnline, busy = st.rosterBusy;
  const unk = st.hasUnknown ? `（另有 ${st.roster.length - st.firstLine} 个情况不明）` : '';
  if (busy > 0) return `${busy} 个 AI 正在干活 · 共 ${on} 个在线${unk}`;
  if (on > 0) return `${on} 个 AI 都在，现在没人干活${unk}`;
  return '还没有 AI 连上来';
}
// 在干活的那位 + 动静新鲜度（驾驶舱一句话的补充）。卡住预警：在线且有上报但很久没动静。
function rosterBusyLine(st) {
  const busy = st.roster.filter((r) => r.loaded && r.work === 'working');
  if (!busy.length) return '';
  const b = busy[0];
  if (b.hbState === 'timeout') return `${b.name} 已经有一阵没动静了，可能卡住了`;
  if (b.hbState === 'ok' && b.hbText && b.hbText !== '—') return `${b.name} 在干活 · 上次动静 ${b.hbText}`;
  return `${b.name} 在干活`;
}

/* ================= 任务的人话状态（任务条 chip 用） ================= */
function cabinTaskState(t) {
  const ss = t.steps || [];
  if (ss.some((s) => isDecidable(s, ss))) return '等你拍板';
  if (ss.some((s) => s.status === 'failed')) return '被打回';
  if (ss.some((s) => s.status === 'running')) return '在改';
  if (ss.length && ss.every((s) => s.status === 'done' || s.status === 'skipped')) return '做完了';
  return '进行中';
}

/* ================= 驾驶舱（我的任务） ================= */
function renderCabin() {
  const wrap = document.getElementById('cabin-main');
  const foot = document.getElementById('cabin-foot');
  if (!wrap || !foot) return;

  // 数据未到/读失败的诚实占位（与工作台同口径，不拿空数据冒充）
  if (!lastFlow) {
    const failed = modErr.flow && !modOkAt.flow;
    wrap.innerHTML = `<div class="cabin-loading">${failed
      ? '任务清单读取失败，原因见页面顶部；正在自动重试。'
      : '正在读取任务…首轮同步完成后展示。'}</div>`;
    foot.innerHTML = '';
    return;
  }
  const tasks = lastFlow.tasks || [];
  if (!tasks.length) {
    wrap.innerHTML = `<div class="cabin-loading">还没有任务。把你的想法发给 Lemate，它会在这里建一张任务卡，你只需要在关键处拍板。</div>`;
    foot.innerHTML = '';
    return;
  }

  // 任务条：全部任务 + 人话状态，点击切换（selectTask 已有）
  renderChanged('cabin-tasks', tasks.map((t) => `${t.id}:${cabinTaskState(t)}:${t.title}`).join('|'), () => {
    const el = document.getElementById('cabin-tasks');
    el.innerHTML = tasks.slice(0, 12).map((t) => {
      const title = plainDyn(t.title);
      return `
      <button type="button" class="cabin-task${t.id === ui.taskId ? ' cur' : ''}" data-cabin-task="${esc(t.id)}" title="${esc(title)}">
        <b>${esc(title.length > 16 ? title.slice(0, 16) + '…' : title)}</b>
        <span>${esc(cabinTaskState(t))}</span>
      </button>`;
    }).join('');
  });

  const t = currentTask();
  if (!t) { wrap.innerHTML = '<div class="cabin-loading">请在上面的任务条里选一个任务。</div>'; foot.innerHTML = ''; return; }
  const steps = (t.steps || []).slice().sort((a, b) => (a.no ?? 0) - (b.no ?? 0));
  if (!steps.length) { wrap.innerHTML = '<div class="cabin-loading">这个任务还没有步骤档案。</div>'; foot.innerHTML = ''; return; }

  // 焦点步与工作台同规则：可拍板 > 被打回 > 进行中 > 待确认 > 第一格。
  // 驾驶舱就是选择器：每次渲染把 ui.stepKey 对齐到焦点步（主按钮走全局 data-decide 委托，
  // submitDecision 读的就是 ui.taskId/ui.stepKey）。
  const focus = steps.find((x) => isDecidable(x, t.steps))
    || steps.find((x) => x.status === 'failed')
    || steps.find((x) => x.status === 'running')
    || steps.find((x) => x.status === 'awaiting')
    || steps[0];
  ui.stepKey = focus.key;

  const total = steps.length;
  const doneN = steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  const pct = total ? Math.round(doneN / total * 100) : 0;
  const fSt = focus.status || 'pending';
  const decidable = isDecidable(focus, t.steps);
  const st = agentStats();
  const busyLine = rosterBusyLine(st);
  const target = targetScoreOf(t.id);
  const key = `${t.id}/${focus.key}`;

  // 一句话：现在在干什么（唯一主信息，别的都折叠）
  let nowMain = '', nowSub = '';
  if (fSt === 'running') {
    nowMain = `${focus.by || 'AI'} 正在做第 ${focus.no}/${total} 项：${esc(stepHumanName(focus, steps))}`;
    nowSub = [focus.at ? `已用 ${esc(ago(focus.at))}` : '', busyLine].filter(Boolean).join(' · ');
  } else if (decidable) {
    nowMain = `「${esc(stepHumanName(focus, steps))}」做好了，等你拍板`;
    nowSub = focus.note ? esc(String(focus.note).slice(0, 80)) : '看完下面做出来的东西，再决定确认还是打回';
  } else if (fSt === 'failed') {
    nowMain = `「${esc(stepHumanName(focus, steps))}」被你打回了`;
    nowSub = focus.note ? `你的意见：${esc(String(focus.note).slice(0, 80))}` : 'AI 改好后会再交上来；急的话也可以直接让它重交';
  } else if (fSt === 'awaiting') {
    nowMain = `「${esc(stepHumanName(focus, steps))}」在等前面的事完成`;
    nowSub = `还在等：${esc(humanStepNames(steps, waitingOnOf(focus, t.steps)).join('、'))}`;
  } else if (fSt === 'done') {
    nowMain = `「${esc(plainDyn(t.title))}」全部做完了 ✓`;
    nowSub = `目标 ${target.toFixed(1)} 分 · 还没有评分记录`;
  } else {
    nowMain = `「${esc(stepHumanName(focus, steps))}」还没开始`;
    nowSub = busyLine || '排着队，AI 接到活就会开始动';
  }

  // 走过的路：完成步默认折叠（✓），当前步高亮（▸），以后灰着（○）
  const pastSteps = steps.filter((s) => (s.status === 'done' || s.status === 'skipped') && s.no < focus.no);
  const futureIdx = steps.findIndex((x) => x.key === focus.key);
  const pathHtml = steps.map((s, i) => {
    const isFocus = s.key === focus.key;
    const past = i < futureIdx && (s.status === 'done' || s.status === 'skipped');
    if (isFocus) {
      return `<div class="cp cur">
        <span class="cp-mark">▸</span>
        <div class="cp-main">
          <b>${esc(stepHumanName(s, steps))}</b>
          <span class="cp-state">${decidable ? '做好了，等你拍板' : fSt === 'failed' ? '被你打回了' : fSt === 'running' ? '正在做' : '还没开始'}</span>
          ${s.note ? `<p class="cp-note">${esc(String(s.note).slice(0, 100))}</p>` : ''}
          ${cabinFilesHtml(s)}
        </div>
      </div>`;
    }
    if (past) {
      if (!cabinUI.pastOpen) return '';
      return `<div class="cp done">
        <span class="cp-mark">✓</span>
        <div class="cp-main">
          <b>${esc(stepHumanName(s, steps))}</b>
          <span class="cp-state">完成于 ${s.at ? esc(fmtTime(s.at)) : '—'}</span>
          ${cabinFilesHtml(s)}
        </div>
      </div>`;
    }
    return `<div class="cp fut"><span class="cp-mark">○</span><div class="cp-main"><b>${esc(stepHumanName(s, steps))}</b></div></div>`;
  }).join('');

  // 备注草稿防丢：轮询重渲染前，正打的字先落进 decisionNotes（与决策面板同一份草稿）
  const noteEl = document.getElementById('cabin-note-input');
  if (noteEl && document.activeElement === noteEl) decisionNotes.set(key, noteEl.value);

  const scoreHtml = cabinUI.scoreEdit ? `
    <div class="cabin-score-edit">
      <span>这个任务做到多少分算完成：</span>
      <input id="cabin-score-input" type="number" step="0.5" min="5" max="10" value="${target.toFixed(1)}">
      <span>分</span>
      <button class="btn btn-primary" type="button" data-cabin-savescore>保存</button>
    </div>` : `
    <div class="cabin-score">目标 <b>${target.toFixed(1)}</b> 分
      <button class="cabin-link" type="button" id="cabin-score-edit" data-cabin-scoreedit>改</button>
    </div>`;

  const fp = [
    t.id, focus.key, steps.map((s) => s.status).join(','),
    steps.map((s) => (s.files || []).map((f) => (f.history || []).length).join('.')).join(';'),
    cabinUI.pastOpen, cabinUI.scoreEdit, target,
    pastSteps.length, busyLine,
  ].join('|');
  renderChanged('cabin-main', fp, () => {
    document.getElementById('cabin-main').innerHTML = `
      <div class="cabin-now">
        <h2>${nowMain}</h2>
        ${nowSub ? `<p>${nowSub}</p>` : ''}
        <div class="cabin-bar"><i style="width:${pct}%"></i></div>
        <div class="cabin-progress">第 ${focus.no} 项 / 共 ${total} 项 · 做完 ${doneN} 项</div>
        ${scoreHtml}
      </div>
      <div class="cabin-path">
        <button class="cabin-past-toggle" type="button" data-cabin-past>
          ${cabinUI.pastOpen ? '收起' : `看看已经做完的（${pastSteps.length} 项）`}
        </button>
        ${pathHtml}
      </div>`;
  });

  // ---- 底部：唯一主按钮 ----
  renderCabinFoot(t, steps, focus, key);
}

// 做出来的东西：只报名字和改过几版（版本数来自登记历史，真实可数）
function cabinFilesHtml(s) {
  const files = dedupFiles(s.files || []);
  if (!files.length) return '';
  const rows = files.slice(0, 4).map((f) => {
    const versions = (f.history || []).length;
    const name = String(f.path || '').split('/').pop();
    return `<span class="cp-file" data-open-file="${esc(f.path)}" title="${esc(f.path)}&#10;点击看内容" role="button" tabindex="0">${esc(name)}${versions > 1 ? `<i>改过 ${versions} 版</i>` : ''}</span>`;
  }).join('');
  return `<div class="cp-files">${rows}${files.length > 4 ? `<span class="cp-file-more">等 ${files.length} 份</span>` : ''}</div>`;
}

function renderCabinFoot(t, steps, focus, key) {
  const fSt = focus.status || 'pending';
  const decidable = isDecidable(focus, t.steps);
  const idx = steps.findIndex((x) => x.key === focus.key);
  const pending = pendingOps.has(key);
  const err = decisionResult && decisionResult.key === key && decisionResult.msg ? decisionResult.msg : '';
  const fp = [key, fSt, decidable, cabinUI.noteOpen, pending, err,
    approvalObjectOf(t, focus, t.steps, idx).kind].join('|');
  renderChanged('cabin-foot', fp, () => {
    const foot = document.getElementById('cabin-foot');
    if (pending) {
      foot.innerHTML = `<div class="cf-wait">已提交，正在确认结果…（几秒内自动更新）</div>`;
      return;
    }
    const errHtml = err ? `<div class="cf-err">${esc(err)}</div>` : '';
    if (decidable) {
      const obj = approvalObjectOf(t, focus, t.steps, idx);
      const noteBox = cabinUI.noteOpen ? `
        <div class="cf-note">
          <textarea id="cabin-note-input" maxlength="500" rows="3" placeholder="写清楚要改什么 / 缺什么，AI 才知道怎么改（打回必填）"></textarea>
          <div class="cf-note-row">
            <span id="cabin-note-hint" class="cf-hint"></span>
            <button class="btn btn-secondary" type="button" data-cabin-note>收起</button>
            <button class="btn btn-primary" type="button" data-cabin-${obj.kind === 'none' ? 'request' : 'reject'}>${obj.kind === 'none' ? '催它补齐' : '确认打回'}</button>
          </div>
        </div>` : '';
      if (obj.kind === 'none') {
        // 拿不出可审的东西：没有「通过」可点，唯一真实动作是催交材料
        foot.innerHTML = `${errHtml}
          <div class="cf-row">
            <button class="btn btn-primary cf-main" type="button" data-cabin-note>${cabinUI.noteOpen ? '在写要求…' : '它没交东西，我去催'}</button>
            <span class="cf-tip">这一步还没交上可看的东西，先说清楚缺什么</span>
          </div>${noteBox}`;
      } else {
        foot.innerHTML = `${errHtml}
          <div class="cf-row">
            <button class="btn btn-primary cf-main" type="button" data-decide="approve">${esc(CABIN_APPROVE[focus.key] || '我确认')}</button>
            <button class="cabin-link" type="button" data-cabin-note>我要改</button>
            <span class="cf-tip">确认后 AI 会接着做下一步</span>
          </div>${noteBox}`;
      }
      return;
    }
    if (fSt === 'failed') {
      foot.innerHTML = `${errHtml}
        <div class="cf-row">
          <button class="btn btn-primary cf-main" type="button" data-decide="resubmit">让它重新交上来</button>
          <span class="cf-tip">AI 按你的意见改好后，从这里重交；也可以等它自己交</span>
        </div>`;
      return;
    }
    if (fSt === 'running') {
      foot.innerHTML = `<div class="cf-idle">AI 在干活，现在不用你操作。有结果了这里会出现「等你拍板」。</div>`;
      return;
    }
    foot.innerHTML = `<div class="cf-idle">现在不用你操作。轮到你的那一刻，这里会出现唯一一个亮着的按钮。</div>`;
    // 备注框重建后接回草稿（decisionNotes 与专业视图决策面板共用一份）
    const ne = document.getElementById('cabin-note-input');
    if (ne) ne.value = decisionNotes.get(key) || '';
  });
}

/* ================= 干活记录 ================= */
function renderLog() {
  const box = document.getElementById('log-body');
  if (!box) return;
  const st = agentStats();
  const roster = rosterPlain(st);
  // 时间线：所有任务里有时间戳的步骤事件，倒序取最近 40 条（只记发生过的事）
  let events = [];
  if (lastFlow) {
    for (const t of (lastFlow.tasks || [])) {
      for (const s of (t.steps || [])) {
        if (!s.at) continue;
        const ds = s.status;
        let verb = null;
        if (ds === 'done') verb = '做完了';
        else if (ds === 'running') verb = '正在做';
        else if (ds === 'awaiting') verb = isDecidable(s, t.steps) ? '交上来，等你拍板' : '交上来了';
        else if (ds === 'failed') verb = '被你打回了';
        if (verb) events.push({ at: s.at, by: s.by, verb, name: stepHumanName(s, t.steps), task: plainDyn(t.title) });
      }
    }
    events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    events = events.slice(0, 40);
  }
  const fp = [
    rosterHeadline(st),
    roster.map((r) => `${r.name}${r.text}`).join('|'),
    events.map((e) => `${e.at}${e.by}${e.verb}${e.name}${e.task}`).join('|'),
  ].join('#');
  renderChanged('log-body', fp, () => {
    document.getElementById('log-body').innerHTML = `
      <div class="log-headline">${esc(rosterHeadline(st))}</div>
      <div class="log-roster">${roster.map((r) => `
        <div class="log-agent ${r.cls}">
          <b>${esc(r.name)}</b><span class="log-role">${esc(r.role)}</span>
          <span class="log-state">${esc(r.text)}</span>
        </div>`).join('')}</div>
      <h3 class="log-h">最近干了什么</h3>
      <div class="log-timeline">${events.length ? events.map((e) => `
        <div class="log-ev">
          <time>${esc(fmtTime(e.at))}</time>
          <b>${esc(e.by || 'AI')}</b>
          <span>${esc(e.verb)}「${esc(e.name)}」</span>
          <span class="log-ev-task">${esc(e.task)}</span>
        </div>`).join('') : '<div class="cabin-loading">还没有干活记录——第一个任务开始后，这里会一条条记下来。</div>'}</div>`;
  });
}

/* ================= 设置 · 常用页 ================= */
const TERM_ROWS = [
  ['原始需求', '你的想法'], ['需求文档', '确认好的需求'], ['开发计划', '打算怎么做'],
  ['任务书', '给 Claude 的活'], ['交付物 / 产物登记', '做出来的东西'], ['验收报告', '检查结果'],
  ['评审 / 加权得分', '打分'], ['审批 / 决策 / 门禁', '你来拍板'],
  ['指纹 / SHA-256 / 字节校验', '文件有没有被改动'], ['心跳 / 上报新鲜度', '还活着吗'],
  ['Agent 实例 / 在线实例', '有几个 AI 在干活'],
];
function renderSettingsGeneral() {
  const el = document.getElementById('set-general');
  if (!el) return;
  renderChanged('set-general', String(defaultScore()), () => {
    document.getElementById('set-general').innerHTML = `
      <div class="set-card">
        <h3>目标分</h3>
        <p class="set-desc">一个任务做到多少分算完成。这里是新建任务的默认值；单个任务的目标分，在「我的任务」页顶部改。</p>
        <div class="set-row">
          <span>默认目标分</span>
          <input id="cabin-defscore-input" type="number" step="0.5" min="5" max="10" value="${defaultScore().toFixed(1)}">
          <span>分</span>
          <button class="btn btn-primary" type="button" data-cabin-savedef>保存</button>
        </div>
      </div>
      <div class="set-card">
        <h3>术语小抄</h3>
        <p class="set-desc">系统里偶尔还会出现左边这些词（专业视图、旧文档里），对照右边理解就行。</p>
        <table class="set-terms"><tbody>
          ${TERM_ROWS.map(([a, b]) => `<tr><td>${esc(a)}</td><td>→</td><td><b>${esc(b)}</b></td></tr>`).join('')}
        </tbody></table>
      </div>
      <div class="set-card">
        <h3>其他设置在哪</h3>
        <p class="set-desc">AI 的状态明细在「AI 与干活状态」页签；技能管理和文件库也在本页。顶栏齿轮里是连接与刷新设置。</p>
      </div>`;
  });
}
