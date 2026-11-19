// cabin.js — TASK-向导化改造（2026-11-18）：把首页从「AI 工作状态监控台」改成
//「AI 软件制作向导」。首屏永远回答三件事：你的软件做到哪了 / AI 正在做什么 / 现在你只需要点什么。
//   我的任务（向导主页：当前软件 + 当前状态 + 下一步 + 功能清单 + 六段旅程 + 评审返工 + 唯一主按钮）
//   干活记录（每个 AI 干了什么/正在干嘛，人话时间线）
//   设置·常用页（目标分默认值 + 术语对照表；Agents/技能/文件三个专业页签住在这里）
// 加载位置：agents.js 之后、render.js 之前——只引用更早加载的模块入口
// （shared/approval/version/agents/decision-ops），被 render.js/app.js 调用期引用。
// 数据口径（任务书钉死）：首页只展示真实任务数据，没有就如实说「还没有」；
// 术语口径：首页只用大白话，专业词只允许出现在设置页的对照表里（X03）。

/* ================= 术语映射（首页文案的词源，X03 只改展示层） ================= */
const STEP_HUMAN = {
  req: '你的想法', doc: '确认好的需求', plan: '打算怎么做', brief: '给 Claude 的活',
  deliverable: '做出来的东西', verify: '检查结果', final: '最后交接',
};
// X02：主按钮文案按阶段变化（「确认 X，开始 Y」句式，告诉用户点下去会发生什么）
// TASK-R87整改 X01：删掉 req 档——「确认想法」这道审批整个没了（新任务 req 落档
// 即 done，AI 自动讨论）；唯一的确认点是 doc（确认需求文档）。
const STAGE_MAIN = {
  doc: '确认需求，开始制定计划',
  plan: '确认计划，开始开发',
  brief: '确认安排，AI 开始开发',
  deliverable: '确认成果，开始检查',
  verify: '通过评审，查看成果',      // 评审达到目标（或还没打分）→ 通过
  final: '通过评审，查看成果',
};
// X02：评审未达标时 verify 的主按钮换成「自动按建议继续改进」（走既有打回通道）
const STAGE_MAIN_REWORK = '自动按建议继续改进';
function stepHumanName(s, steps) {
  if (STEP_HUMAN[s.key]) return STEP_HUMAN[s.key];
  return s.name || '这一步';
}
function humanStepNames(steps, names) {
  return (names || []).map((n) => {
    const st = (steps || []).find((x) => x.name === n);
    return st && STEP_HUMAN[st.key] ? STEP_HUMAN[st.key] : n;
  });
}
// 动态数据（标题/活动句）的展示层去专业词。只影响首页显示，档案与专业视图一字不动。
const PLAIN_WORDS = [
  ['SHA-256', '文件校验'], ['字节', '大小'], ['指纹', '校验'], ['加权', '综合'],
  ['门禁', '把关'], ['实例', '在线'], ['心跳', '动静'], ['产物', '东西'],
  ['Agent', 'AI 助手'], ['Coding', '软件开发'],
];
function plainDyn(s) {
  return PLAIN_WORDS.reduce((acc, [from, to]) => acc.split(from).join(to), String(s));
}
// R86：计划/需求正文里常带「F01」「TEST-F01R10」这类内部代号前缀，
// 首屏一个都不许露（GPT 硬门槛：有一个未解释技术词就封顶 5.0）。
// 只剥开头的代号词，正文里的中文内容原样保留。
function stripCodes(s) {
  return String(s)
    .replace(/^\s*(?:\[?\s*(?:TEST-)?[A-Z]{1,3}[-_]?\d{1,4}(?:R\d+)?\s*\]?[\s:：·、\-—]*)+/i, '')
    .replace(/^\s*(?:编号|代号)\s*[:：]?\s*(?:TEST-)?[A-Z]{1,3}[-_]?\d{1,4}\S*\s*[\s:：·、\-—]*/i, '')
    .trim();
}

/* ---- R85·X03：内部编号不上面首屏；测试任务可标记可隐藏；AI 名字带人话岗位 ----
   只动展示层：档案数据、专业视图、Agents 页签一字不改。
   编号只在「详细信息」折叠块里出现；裸 AI 名字一律带「帮你做什么」后缀。 */
const cabinFresh = new Map();   // R85·X08：新建任务 -> 创建时刻（会话内有效，判断「刚建的」）
function isTestTask(t) {
  return /^TEST-/i.test(String((t && t.id) || '')) || String((t && t.title) || '').includes('测完即删');
}
// 标题的人话版：非测试任务原样（保住 g07 夹具标题）；测试任务剥掉「纯编号词」和测完即删除标记
function plainTitle(t) {
  const raw = String((t && t.title) || '');
  const base = raw.replace(/[〔［（(\s]*测完即删[)）\]］〕\s]*/g, '').trim();
  if (!isTestTask(t)) return plainDyn(base || raw);
  const kept = base.split(/\s+/).filter((w) => w && !/^(?:TEST[-—_]?)?(?:F|R)\d{1,4}(?:R\d{1,4})?$/i.test(w));
  // 编号与业务词连写（没隔空格）时再剥一次行首编号，分隔符只认空格/·/冒号/逗号——
  // 不认「-」，R73-W01 这类复合编号是业务名的一部分，剥了会把标题拆残
  const stripped = kept.join(' ').replace(/^(?:TEST[-—_]?)?(?:F|R)\d{1,4}(?:R\d{1,4})?(?=[\s·:：,，]|$)/i, '').trim();
  return plainDyn(stripped || base || raw);
}
// 岗位的人话版（Agents 页签保留原岗位词；首页/干活记录/底栏用这份）
const ROLE_PLAIN = { lemate: '帮你写代码', winter: '帮你剪视频', karina: '帮你做图文', codex: '帮你生图和把关' };
function rolePlainOf(r) {
  return (r && ROLE_PLAIN[r.roleId]) || (r && r.role) || 'AI 助手';
}

/* ================= X04：七步流水线 → 用户可见的六段旅程 =================
   内部 7 步（req/doc/plan/brief/deliverable/verify/final）一个不改，
   展示层折成 6 段：①理解你的想法 ②确认软件功能 ③制定开发计划
   ④开发软件 ⑤检查并改进 ⑥交付成果。 */
const JOURNEY = [
  { no: 1, label: '理解你的想法', keys: ['req'] },
  { no: 2, label: '确认软件功能', keys: ['doc'] },
  { no: 3, label: '制定开发计划', keys: ['plan'] },
  { no: 4, label: '开发软件', keys: ['brief', 'deliverable'] },
  { no: 5, label: '检查并改进', keys: ['verify'] },
  { no: 6, label: '交付成果', keys: ['final'] },
];
// 一段的展示状态：已完成 / 进行中 / 需要你确认 / 等待开始（打回重做算「进行中」，
// 它是检查并改进的一部分；「需要你确认」只认真的交了东西上来 awaiting）
// TASK-R87整改 X04：①② 段按真实流程钉死对应关系——
//   ① 理解你的想法 = 提交 + AI 自动讨论 + 生成文档（文档到确认点才算完成；
//     新流程 req 落档即 done、doc 在跑 → ①进行中，绝不出「用户审批完成」）
//   ② 确认软件功能 = 用户确认已生成的文档（doc awaiting 才亮「需要你确认」）
function journeyStateOf(stage, steps) {
  const byKey = (k) => steps.find((x) => x.key === k);
  if (stage.no === 1) {
    const req = byKey('req'); const doc = byKey('doc');
    if (doc && (doc.status === 'awaiting' || doc.status === 'done' || doc.status === 'skipped')) return '已完成';
    if (doc && (doc.status === 'running' || doc.status === 'failed')) return '进行中';
    // 老任务停在「确认想法」的：那是它的真实状态，照实显示
    if (req && req.status === 'awaiting' && waitingOnOf(req, steps).length === 0) return '需要你确认';
    if (req && (req.status === 'done' || req.status === 'skipped')) return '进行中';
    return '等待开始';
  }
  if (stage.no === 2) {
    const doc = byKey('doc');
    if (!doc) return '等待开始';
    if (doc.status === 'awaiting' && waitingOnOf(doc, steps).length === 0) return '需要你确认';
    if (doc.status === 'done' || doc.status === 'skipped') return '已完成';
    if (doc.status === 'failed') return '进行中';   // 被打回重改也算这一段在进行
    return '等待开始';                              // running 是第 ① 段的工作
  }
  const ss = stage.keys.map((k) => steps.find((x) => x.key === k)).filter(Boolean);
  if (!ss.length) return '等待开始';
  if (ss.some((x) => x.status === 'awaiting' && waitingOnOf(x, steps).length === 0)) return '需要你确认';
  if (ss.every((x) => x.status === 'done' || x.status === 'skipped')) return '已完成';
  if (ss.some((x) => x.status === 'running' || x.status === 'failed')) return '进行中';
  return '等待开始';
}
/* ---- R85·X05：旅程下方给真实时间口径——何时开始/最近更新来自步骤档案的真实时间戳；
   当前段四态（在等你确认 / 正在改 / 可能卡住 / 在等前置）；没有历史耗时就明说估不了，
   绝不编一个倒计时。 ---- */
const STALE_STEP_MS = 30 * 60 * 1000;   // 超过 30 分钟没动静算「可能卡住」
function journeyHtml(steps, t) {
  const states = JOURNEY.map((st) => journeyStateOf(st, steps));
  const curIdx = states.findIndex((s) => s !== '已完成');
  const marks = ['①', '②', '③', '④', '⑤', '⑥'];
  const items = JOURNEY.map((st, i) => {
    const s = states[i];
    const cls = s === '已完成' ? 'js-done' : s === '需要你确认' ? 'js-confirm js-cur' : i === curIdx ? 'js-cur' : 'js-wait';
    return `<div class="jstage ${cls}" title="第 ${st.no} 段 · ${esc(s)}">
      <span class="js-no" aria-hidden="true">${marks[i] || st.no}</span>
      <b>${esc(st.label)}</b>
      <span class="js-state">${esc(s)}</span>
    </div>`;
  }).join('<span class="j-arrow" aria-hidden="true">›</span>');
  const ats = steps.map((s) => (s.at ? Date.parse(s.at) : NaN)).filter(Number.isFinite);
  const upd = t && t.updatedAt ? Date.parse(t.updatedAt) : NaN;
  if (Number.isFinite(upd)) ats.push(upd);
  const started = ats.length ? fmtTime(new Date(Math.min(...ats)).toISOString()) : '—';
  const updated = ats.length ? fmtTime(new Date(Math.max(...ats)).toISOString()) : '—';
  let why = { cls: '', text: '六段全部完成' };
  if (curIdx >= 0) {
    const st = JOURNEY[curIdx];
    // TASK-R87整改 X04：第 ① 段的实况要把 doc 一起看（讨论/写文档都发生在这一段）
    const ss = (st.no === 1 ? ['req', 'doc'] : st.keys)
      .map((k) => steps.find((x) => x.key === k)).filter(Boolean);
    const lastAt = Math.max(0, ...ss.map((x) => (x.at ? Date.parse(x.at) : 0)));
    const waiting = ss.find((x) => x.status === 'awaiting' && waitingOnOf(x, steps).length === 0);
    if (waiting) {
      // TASK-R87整改 X05：「在等你」和「AI 卡住」分开——等你只报等待天数，
      // 不冒充超时；天数来自该步骤档案的真实时间戳
      const days = waiting.at ? Math.floor((Date.now() - Date.parse(waiting.at)) / 86400000) : 0;
      why = { cls: '', text: days >= 1 ? `这项软件已等待你确认约 ${days} 天，AI 暂时不会继续下一步` : '在等你确认——确认后 AI 会接着做' };
    } else if (ss.some((x) => x.status === 'failed')) {
      why = { cls: 'jmeta-stale', text: '被打回了，AI 正在按你的意见改' };
    } else if (ss.some((x) => x.status === 'running') && lastAt && Date.now() - lastAt > STALE_STEP_MS) {
      // TASK-R87整改 X05：AI 卡住的原话，绝不和「在等你」混说
      why = { cls: 'jmeta-stale', text: 'AI 暂时没有新的工作进展，正在检查' };
    } else if (ss.some((x) => x.status === 'running')) {
      why = { cls: '', text: 'AI 正在做这一段' };
    } else {
      why = { cls: '', text: '在等前面的步骤完成' };
    }
  }
  const meta = `<div class="jmeta">
    <span>何时开始 ${esc(started)}</span><span>最近更新 ${esc(updated)}</span>
    <span class="${why.cls}">${esc(why.text)}</span>
    <span class="jmeta-eta">剩余时间暂时无法估计（还没有可靠的历史耗时记录）</span>
  </div>`;
  return `<div class="cabin-journey"><h3 class="cj-h">制作旅程</h3><div class="jtrack">${items}</div>${meta}</div>`;
}

/* ================= 目标分（每个任务一份，默认 8.0，可改；X07 新建时不偷偷覆盖） =================
   目标分是前端一等的用户设置：office.score.v1 = { def, tasks }。
   「本轮得分」来自服务端评审台账（GET /api/office/review），没有记录就如实「还没打分」。 */
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

/* ================= X06：评审台账（服务端 GET/POST /api/office/review） =================
   renderCabin 每 3 秒跑一次，这里带 15s 缓存 + 在途去重，只在任务切换/到期/写入后重拉。 */
const reviewCache = { taskId: null, at: 0, inflight: false, data: null, err: '' };
function ensureReview(t) {
  if (offline) return;   // 离线快照没收录评审接口，不造数据
  const fresh = reviewCache.taskId === t.id && Date.now() - reviewCache.at < 15000;
  if (fresh || reviewCache.inflight) return;
  reviewCache.inflight = true;
  api('/api/office/review?taskId=' + encodeURIComponent(t.id))
    .then((d) => { reviewCache.data = d; reviewCache.err = ''; reviewCache.taskId = t.id; reviewCache.at = Date.now(); })
    .catch((e) => { reviewCache.err = (e && e.message) || '读取失败'; reviewCache.at = Date.now(); })
    .finally(() => { reviewCache.inflight = false; if (activePage === 'home') renderCabin(); });
}
function cabinReviewData(t) {
  ensureReview(t);
  return reviewCache.taskId === t.id ? reviewCache.data : null;
}
function reviewLatest(t) {
  const rd = cabinReviewData(t);
  if (!rd || !Array.isArray(rd.rounds) || !rd.rounds.length) return null;
  return rd.rounds[rd.rounds.length - 1];
}
// verify 的主按钮是否该换成「自动按建议继续改进」：有评审记录且最新一轮未达标
function verifyNeedsRework(t) {
  const last = reviewLatest(t);
  if (!last) return false;
  return Number(last.score) < targetScoreOf(t.id);
}
function reviewCardHtml(t) {
  if (offline) return '';   // 离线快照模式没有评审接口，整卡不渲染，不冒充
  const target = targetScoreOf(t.id);
  const head = `<div class="cr-head"><h3>评审与自动改进</h3>
    <span class="cr-k">目标 <b>${target.toFixed(1)}</b> 分</span></div>`;
  const rd = cabinReviewData(t);
  if (!rd) {
    const why = reviewCache.err && reviewCache.taskId === t.id
      ? `评审记录读取失败：${esc(reviewCache.err)}（稍后自动重试）` : '评审记录读取中…';
    return `<div class="cabin-review">${head}<p class="cr-na">${why}</p></div>`;
  }
  const rounds = rd.rounds || [];
  const last = rounds[rounds.length - 1] || null;
  const limits = rd.limits || { maxRounds: 5, stopIfNoProgressRounds: 2 };
  const advice = rd.advice || 'none';
  let statusHtml = '';
  if (advice === 'pass' && last) {
    statusHtml = `<div class="cr-pass">✓ 第 ${rounds.length} 轮已达标（${Number(last.score).toFixed(1)} ≥ 目标 ${target.toFixed(1)}），这个软件可以交付了。</div>`;
  } else if (advice === 'rework' && last) {
    statusHtml = `<div class="cr-work">第 ${rounds.length} 轮改进中：上一轮 ${Number(last.score).toFixed(1)} 分，没到目标 ${target.toFixed(1)} 分。${last.instruction ? `修改指令：${esc(String(last.instruction).slice(0, 80))}` : '按你的意见继续改。'}</div>`;
  } else if (advice === 'pause-max-rounds') {
    statusHtml = `<div class="cr-stop">已经连续改进 ${limits.maxRounds} 轮（上限就是 ${limits.maxRounds} 轮），AI 按约定停下来了，不再自动继续。需要你处理：<button class="btn btn-secondary" type="button" data-open-pro>打开高级工作台处理</button><span class="cr-stop-tip">看细节、改目标分，或把决定告诉 Lemate。</span></div>`;
  } else if (advice === 'pause-no-progress') {
    statusHtml = `<div class="cr-stop">最近 ${limits.stopIfNoProgressRounds} 轮分数没有提高，AI 按约定暂停（不无限空转）。需要你处理：<button class="btn btn-secondary" type="button" data-open-pro>打开高级工作台处理</button><span class="cr-stop-tip">调低目标、改指令，或确认就此收尾。</span></div>`;
  } else if (!rounds.length) {
    statusHtml = `<p class="cr-na">还没打过分。AI 交出成果后，把这一轮的分数和依据记在这里；没到目标分，AI 会按你的修改指令自动接着改。</p>`;
  }
  const roundRows = rounds.map((r, i) => {
    const next = rounds[i + 1] || null;
    return `<details class="cr-round"${i === rounds.length - 1 ? ' open' : ''}>
      <summary>第 ${esc(String(r.no ?? (i + 1)))} 轮 · 得分 <b>${Number(r.score).toFixed(1)}</b>${r.outcome === 'pass' ? ' · 已达标' : ' · 改进中'}<time>${r.at ? esc(fmtTime(r.at)) : ''}</time></summary>
      <dl>
        <dt>评审对象</dt><dd>${r.reviewedVersion ? esc(String(r.reviewedVersion).slice(0, 120)) : '—'}</dd>
        <dt>得分依据</dt><dd>${esc(String(r.basis || '—').slice(0, 200))}${String(r.basis || '').length > 200 ? '…' : ''}</dd>
        <dt>发现的问题</dt><dd>${r.issues ? esc(String(r.issues).slice(0, 200)) : '—'}</dd>
        <dt>修改指令</dt><dd>${r.instruction ? esc(String(r.instruction).slice(0, 200)) : '—'}</dd>
        <dt>AI 的执行结果</dt><dd>${r.result ? esc(String(r.result).slice(0, 200)) : '<span class="cr-pend">还没回填（AI 改完后在这里补）</span>'}</dd>
        <dt>下一轮结果</dt><dd>${next ? `第 ${esc(String(next.no))} 轮得 ${Number(next.score).toFixed(1)} 分` : '还没开始'}</dd>
      </dl>
    </details>`;
  }).join('');
  const formHtml = cabinUI.reviewOpen ? `
    <div class="cr-form">
      <div class="crf-row">
        <label>这轮得分 <input id="review-score" type="number" step="0.1" min="0" max="10" placeholder="0-10"></label>
        <label>评审对象 <input id="review-ver" maxlength="200" placeholder="评的是哪个版本/文件（可不填）"></label>
      </div>
      <textarea id="review-basis" rows="2" maxlength="2000" placeholder="得分依据：凭什么给这个分（必填）"></textarea>
      <input id="review-issues" maxlength="500" placeholder="发现的问题（可不填，多个用分号隔开）">
      <textarea id="review-instruction" rows="2" maxlength="2000" placeholder="给 AI 的修改指令：没到目标分时告诉它怎么改（可不填）"></textarea>
      <div class="crf-row">
        <span id="review-hint" class="cf-hint"></span>
        <button class="cabin-link" type="button" data-review-close>收起</button>
        <button class="btn btn-primary" type="button" data-review-save>保存这轮评审</button>
      </div>
    </div>` : `<button class="cabin-link cr-add" type="button" data-review-open>和 AI 一起评审</button>`;
  return `<div class="cabin-review">${head}${statusHtml}${roundRows}${formHtml}</div>`;
}

/* ================= X01：你的软件将包含（需求文档里真实列出的功能清单） =================
   数据源 = doc 步骤登记的文件内容（GET /api/office/file），按 path+版本缓存 60s。
   没交文档/读不出来/没有清单条目 → 各自如实说明，不编功能点。 */
const featCache = new Map();   // path\0versionKey -> {kind, bullets?, name?, at}
const featPending = new Set();
// R85·X01：抽成通用「某步骤登记的第一份文件」；doc 用它取需求文档，plan 用它取开发计划
function stepDocSource(t, stepKey) {
  const st = (t.steps || []).find((s) => s.key === stepKey);
  if (!st) return null;
  const files = dedupFiles(st.files || []);
  if (!files.length) return null;
  return files[0];
}
function docFeatSource(t) {
  return stepDocSource(t, 'doc');
}
// TASK-R87整改 X03②：清单抽两组——功能 + 明确「不做什么」（出现在
// 「不做什么」标题之后的条目归不做桶）。抽不出来就留空，不编条目。
function parseFeatLists(text) {
  const feat = [];
  const notdo = [];
  const seen = new Set();
  let inNot = false;
  for (const raw of String(text).split(/\r?\n/)) {
    if (/不做什么|不做的|明确不做|排除范围/.test(raw)) { inNot = true; continue; }
    if (/功能清单|软件将包含|核心功能/.test(raw)) { inNot = false; }
    const m = raw.match(/^\s{0,3}(?:[-*•]|\d{1,2}[.、)])\s+(.+?)\s*$/);
    if (!m) continue;
    const s = m[1]
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .trim();
    if (s.length < 2 || s.length > 60 || seen.has(s)) continue;
    seen.add(s);
    if (inNot) { if (notdo.length < 5) notdo.push(s); }
    else if (feat.length < 5) feat.push(s);
  }
  return { feat, notdo };
}
function ensureFeat(t) {
  const f = docFeatSource(t);
  if (!f) return { kind: 'nodoc' };
  const key = f.path + '\u0000' + versionKeyOf(f);
  const c = featCache.get(key);
  if (c && Date.now() - c.at < 60000) return c;
  if (offline) return { kind: 'offline' };
  if (featPending.has(key)) return c || { kind: 'loading' };
  featPending.add(key);
  api('/api/office/file?path=' + encodeURIComponent(f.path))
    .then((d) => {
      let out;
      if (!d || !d.exists || d.kind !== 'text') out = { kind: 'unreadable' };
      else {
        const lists = parseFeatLists(d.text || '');
        out = lists.feat.length ? { kind: 'ok', bullets: lists.feat, notdo: lists.notdo, name: d.name, path: f.path }
          : { kind: 'nofeat', name: d.name, path: f.path };
      }
      out.at = Date.now();
      featCache.set(key, out);
    })
    .catch(() => { featCache.set(key, { kind: 'unreadable', at: Date.now() }); })
    .finally(() => { featPending.delete(key); if (activePage === 'home') renderCabin(); });
  return c || { kind: 'loading' };
}
function featCardHtml(t) {
  const feat = ensureFeat(t);
  const src = docFeatSource(t);
  let body = '';
  if (feat.kind === 'ok') {
    body = `<ul class="cf-list">${feat.bullets.map((b) => `<li>${esc(plainDyn(b))}</li>`).join('')}</ul>`;
    // X03②：明确「不做什么」和功能清单一样来自文档原文
    if (feat.notdo && feat.notdo.length) {
      body += `<p class="cf-notdo-h">明确不做什么</p><ul class="cf-list cf-notdo">${feat.notdo.map((b) => `<li>${esc(plainDyn(b))}</li>`).join('')}</ul>`;
    }
  } else if (feat.kind === 'loading') {
    body = `<p class="cr-na">正在读取需求文档…</p>`;
  } else if (feat.kind === 'nodoc') {
    // TASK-R87整改 X02：按 doc 真实状态说话——后端确实在干活才说「正在整理」，
    // 没开始/停住了都照实说，不许假装
    const doc = (t.steps || []).find((s) => s.key === 'doc');
    const ds = doc ? doc.status : 'pending';
    if (ds === 'running') {
      const d = ensureDiscuss(t);
      body = d && d.exists && d.phase === 'error'
        ? '<p class="cr-na">功能清单整理停住了，原因见上面的状态说明。</p>'
        : '<p class="cr-na">正在整理功能清单，完成后会在这里显示。</p>';
    } else if (ds === 'failed') {
      body = '<p class="cr-na">AI 正在按你的意见重新整理功能清单。</p>';
    } else if (ds === 'awaiting') {
      body = '<p class="cr-na">功能清单还没登记到文档里——点开需求文档全文核对。</p>';
    } else {
      body = '<p class="cr-na">功能清单还没开始整理——AI 讨论完、生成需求文档后，这里会列出你的软件将包含的功能。</p>';
    }
  } else if (feat.kind === 'offline') {
    body = `<p class="cr-na">离线快照没收录文档内容，连上服务后展示。</p>`;
  } else if (feat.kind === 'unreadable') {
    body = `<p class="cr-na">需求文档暂时读不出来（可能已被移走）。</p>`;
  } else if (feat.kind === 'nofeat') {
    body = `<p class="cr-na">需求文档里没有逐条列出功能清单。${src ? `<span class="cp-file" data-open-file="${esc(src.path)}" role="button" tabindex="0">看需求文档全文</span>` : ''}</p>`;
  }
  return `<div class="cabin-feat"><h3 class="cj-h">最终准备做什么</h3>${body}</div>`;
}

/* ================= TASK-R87整改 X03①：AI 讨论了什么（真实讨论留档） =================
   数据源 = GET /api/office/discuss（server-auto.mjs 落档的 discuss.mjs 真实子进程
   输出原文，agent 名来自引擎 stderr 真实诊断）。硬约束（GPT 原话）：讨论消息不能
   用预设文案冒充真实 Agent 输出；留档拿不到就明说「暂时无法获取讨论记录」，
   不伪造协作过程。 */
const discussCache = new Map();   // taskId -> {view, at}
const discussPending = new Set();
const DISCUSS_TTL = 15000;        // 15s 内不重复拉（讨论一轮要好几分钟，不用盯太紧）
function ensureDiscuss(t) {
  const doc = (t.steps || []).find((s) => s.key === 'doc');
  const eligible = doc && ['running', 'awaiting', 'failed'].includes(doc.status);
  const c = discussCache.get(t.id);
  if (c && Date.now() - c.at < DISCUSS_TTL) return c.view;
  if (!eligible) return c ? c.view : null;
  if (offline) return c ? c.view : { exists: false };
  if (discussPending.has(t.id)) return c ? c.view : { loading: true };
  discussPending.add(t.id);
  api('/api/office/discuss?taskId=' + encodeURIComponent(t.id))
    .then((d) => { discussCache.set(t.id, { view: d && d.ok ? d : { exists: false }, at: Date.now() }); })
    .catch(() => { discussCache.set(t.id, { view: { exists: false }, at: Date.now() }); })
    .finally(() => { discussPending.delete(t.id); if (activePage === 'home') renderCabin(); });
  return c ? c.view : { loading: true };
}
// 指纹用的压缩视图（内容一变就触发重画）
function discussFpOf(d) {
  if (!d) return 'nd';
  if (d.loading) return 'ld';
  return [d.exists ? 1 : 0, d.phase || '', (d.messages || []).length, String(d.error || '').slice(0, 60)].join('~');
}
function discussCardHtml(t) {
  const d = ensureDiscuss(t);
  if (!d) return '';
  let body = '';
  if (d.loading) {
    body = '<p class="cr-na">正在读取讨论记录…</p>';
  } else if (!d.exists) {
    body = '<p class="cr-na">暂时无法获取讨论记录——这个软件的讨论原文没有留档（老任务或留档丢失）。这里只展示真实讨论，不伪造协作过程。</p>';
  } else {
    const msgs = Array.isArray(d.messages) ? d.messages : [];
    const real = msgs.filter((m) => m && m.round && m.text);
    if (d.phase === 'error' && d.error) {
      body += `<p class="cr-na">这轮讨论没有跑成，真实原因：${esc(String(d.error).slice(0, 160))}</p>`;
    }
    if (real.length) {
      body += real.map((m) => `
        <div class="cd-msg">
          <div class="cd-meta"><b>${esc(plainDyn(String(m.agent || 'AI 助手')))}</b>
            <span>${esc(m.role || '讨论')} · 第 ${Number(m.round)} 轮${m.at ? ' · ' + esc(fmtTime(m.at)) : ''}</span></div>
          <p>${esc(String(m.text).slice(0, 600))}${String(m.text).length > 600 ? '…' : ''}</p>
        </div>`).join('');
      body += `<details class="cd-full"><summary>看全部讨论原文（${real.length} 条）</summary>${real.map((m) => `
        <div class="cd-msg"><div class="cd-meta"><b>${esc(plainDyn(String(m.agent || 'AI 助手')))}</b><span>第 ${Number(m.round)} 轮</span></div><pre>${esc(String(m.text))}</pre></div>`).join('')}</details>`;
    } else if (d.phase === 'discussing') {
      body += '<p class="cr-na">讨论刚开场，AI 还没说出第一条——有了立刻显示原文。</p>';
    } else if (d.phase === 'writing') {
      body += '<p class="cr-na">讨论完成，AI 正在把结论写进需求文档。</p>';
    } else if (d.phase === 'done') {
      body += '<p class="cr-na">讨论留档里没有可展示的消息（可点开下方需求文档全文核对）。</p>';
    }
    const sys = msgs.filter((m) => m && m.kind === 'system').slice(-1);
    if (sys.length) body += `<p class="cd-sys">${esc(String(sys[0].text).slice(0, 200))}</p>`;
  }
  return `<div class="cabin-discuss"><h3 class="cj-h">AI 讨论了什么</h3>${body}</div>`;
}

/* ================= R85·X01 + R86·X01：开发计划预览（确认前必须把真计划摆出来） =================
   数据源 = plan 步骤登记的文件内容（GET /api/office/file），与 feat 同一套
   缓存/在途/60s TTL 模式。摘要取的是计划文件里真实存在的行（标题/条目都算），
   绝不拿需求文档顶替计划文档，也不编一个固定的「三段式」结构。
   R86 收紧判定口径：文件能读 ≠ 计划能确认——内容里找得到三类结构
   （功能项 / 实施步骤 / 测试方法）才放行确认，否则一律拦下。 */
const planCache = new Map();   // path\0versionKey -> {kind, lines?, name?, path?, at}
const planPending = new Set();
function planSummary(text) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text || '').split(/\r?\n/)) {
    const s = raw
      .replace(/^\s{0,6}#{1,4}\s+/, '')
      .replace(/^\s{0,3}(?:[-*•·]|\d{1,2}[.、)])\s+/, '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .trim();
    if (!s || /^[-=*]{3,}$/.test(s) || s.length > 90 || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= 6) break;
  }
  return out;
}
/* R86·X01：计划内容合格性——只看内容，不看文件名/路径。
   合格 = 三类结构都能从内容里找到：① 功能项（要做哪些功能）② 实施步骤（分几步、产出什么）
   ③ 测试方法（怎么测、怎么判合格）。关键词必须搭上「结构证据」（≥2 个条目或 ≥2 个分节），
   光有词没有结构不算。验证/测试性质的登记（满篇「验证夹具/回归验证」且没有功能结构）
   单独标成 verifyTask，明说是系统验证任务，不许冒充普通软件开发计划。 */
function planQuality(text) {
  const s = String(text || '');
  const lines = s.split(/\r?\n/);
  const listN = lines.filter((l) => /^\s{0,6}(?:[-*•·]|\d{1,2}[.、)])\s+\S/.test(l)).length;
  const headN = lines.filter((l) => /^\s{0,6}#{1,4}\s+\S/.test(l)).length;
  const structured = listN >= 2 || headN >= 2;
  const hasFeat = structured && /(功能|特性|feature)/i.test(s);
  const hasStep = structured && /(步骤|阶段|实施|step|phase)/i.test(s);
  const hasTest = structured && /(测试|验收|判定|通过标准|test)/i.test(s);
  const verifyHit = (s.match(/验证|夹具|fixture|回归验证/g) || []).length;
  return { qualified: hasFeat && hasStep && hasTest, verifyTask: !hasFeat && verifyHit >= 2 };
}
function ensurePlanRead(t) {
  const f = stepDocSource(t, 'plan');
  if (!f) return { kind: 'nofile' };
  const key = f.path + '\u0000' + versionKeyOf(f);
  const c = planCache.get(key);
  if (c && Date.now() - c.at < 60000) return c;
  if (offline) return { kind: 'offline' };
  if (planPending.has(key)) return c || { kind: 'loading' };
  planPending.add(key);
  api('/api/office/file?path=' + encodeURIComponent(f.path))
    .then((d) => {
      let out;
      if (!d || !d.exists || d.kind !== 'text') out = { kind: 'unreadable' };
      else {
        const text = d.text || '';
        const q = planQuality(text);
        const lines = planSummary(text);
        // R86·X01：三样齐全（功能/步骤/测试）才放行；缺任意一样 → 还不完整；
        // 验证/测试性质 → 明说这是系统验证任务，不冒充开发计划；
        // 摘不出真实条目同样不放行——摘要为空时不许默认批准。
        if (!q.qualified) {
          out = q.verifyTask
            ? { kind: 'verify', goal: lines[0] || '', name: d.name, path: f.path }
            : { kind: 'incomplete', name: d.name, path: f.path };
        } else {
          out = lines.length
            ? { kind: 'ok', lines: lines.slice(0, 5), name: d.name, path: f.path }
            : { kind: 'incomplete', name: d.name, path: f.path };
        }
      }
      out.at = Date.now();
      planCache.set(key, out);
    })
    .catch(() => { planCache.set(key, { kind: 'unreadable', at: Date.now() }); })
    .finally(() => { planPending.delete(key); if (activePage === 'home') renderCabin(); });
  return c || { kind: 'loading' };
}
/* R86·X03：计划摘要搬进主操作卡（hero 通栏），顺序钉死：当前状态 → 摘要 3~5 条 →
   查看完整计划 → 主按钮在最下面。不再另设一张与主按钮同重量的计划卡。 */
function planHeroHtml(plan) {
  let body = '';
  if (plan.kind === 'ok') {
    body = `
    <ul class="cf-list">${plan.lines.map((l) => `<li>${esc(stripCodes(plainDyn(l)))}</li>`).join('')}</ul>
    <div class="plan-sub">
      <span class="cp-file" data-open-file="${esc(plan.path)}" role="button" tabindex="0">查看完整开发计划</span>
      <span class="plan-tip">计划有问题？点左边看全文，或点「计划需要修改」告诉 AI。</span>
    </div>`;
  } else if (plan.kind === 'verify') {
    body = `<p class="cr-na"><b>这是一次系统验证任务，不是软件开发计划。</b>目标是：${esc(stripCodes(plainDyn(plan.goal || '验证系统自身的登记与审批流程')))}。它不会给你做出新软件——需要处理请到「高级工作台」。</p>`;
  } else if (plan.kind === 'incomplete') {
    body = `<p class="cr-na">AI 生成的开发计划还不完整，正在补充——三样齐了才亮确认按钮：要做哪些功能、分几步做、怎么测。</p>`;
  } else if (plan.kind === 'loading') {
    body = `<p class="cr-na">正在读取开发计划…</p>`;
  } else if (plan.kind === 'offline') {
    body = `<p class="cr-na">离线快照没收录计划内容，连上服务后展示。</p>`;
  } else if (plan.kind === 'nofile') {
    body = `<p class="cr-na">还没收到开发计划文件——AI 交上来后会先摆在这里给你过目，再谈确认。</p>`;
  } else {
    body = `<p class="cr-na">开发计划暂时无法读取，请重试。<button class="cabin-link" type="button" data-plan-retry>重试读取</button></p>`;
  }
  return `<div class="ch-plan"><span class="ch-k">开发计划（确认前先过目）</span>${body}</div>`;
}

/* ================= 页面状态 ================= */
let settingsTab = 'general';            // 设置页当前页签：general | agents | skills | files
const cabinUI = { pastOpen: false, noteOpen: false, scoreEdit: false, tasksOpen: false, newOpen: false, reviewOpen: false,
  rosterOpen: false };   // X07 展开名册（R86·X02：hideTest 下线——测试任务在首页固定隐藏，开关不再需要）
// 新建软件/评审表单的草稿：轮询重渲染不丢正在打的字（按输入框 id 存，重建后回填）
const cabinDrafts = new Map();
const DRAFT_IDS = ['newtask-idea', 'newtask-score', 'review-score', 'review-ver', 'review-basis', 'review-issues', 'review-instruction'];
function saveCabinDrafts() {
  for (const id of DRAFT_IDS) {
    const el = document.getElementById(id);
    if (el && document.activeElement === el) cabinDrafts.set(id, el.value);
  }
}
function restoreCabinDrafts() {
  for (const id of DRAFT_IDS) {
    const el = document.getElementById(id);
    if (el && cabinDrafts.has(id)) {
      el.value = cabinDrafts.get(id);
      if (document.activeElement === document.body) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    }
  }
}

// 设置页签切换：按钮高亮 + 四个子面板显隐
function syncSettingsTabs() {
  document.querySelectorAll('#page-settings [data-settab]').forEach((b) => {
    b.classList.toggle('on', b.dataset.settab === settingsTab);
  });
  for (const [tab, id] of [['general', 'set-general'], ['agents', 'page-agents'], ['skills', 'page-skills'], ['files', 'page-files']]) {
    const el = document.getElementById(id);
    if (el) el.hidden = tab !== settingsTab;
  }
}

/* ================= 顶栏：目标 X · 本轮 Y（renderTopbar 之后由 renderModules 调） ================= */
function renderScorePill() {
  const el = document.getElementById('tb-score');
  if (!el) return;
  const t = currentTask();
  if (!t) { el.hidden = true; return; }
  const target = targetScoreOf(t.id);
  const last = reviewLatest(t);   // 本轮得分来自服务端评审台账，没有就如实「还没打分」
  el.hidden = false;
  el.innerHTML = `目标 <b>${target.toFixed(1)}</b> · 本轮 <b${last ? '' : ' class="ts-na"'}>${last ? Number(last.score).toFixed(1) : '还没打分'}</b>`;
  el.title = `这个软件要做到 ${target.toFixed(1)} 分算完成。点这里去「我的任务」改目标分。`;
}

/* ================= AI 状态人话（干活记录与名册共用 agentStats()） ================= */
function rosterPlain(st) {
  // R85·X03：岗位词走人话版（Coding→帮你写代码）；X07：连接/执行/新鲜度三口径
  // 仍严格分开，只在文案里明说，不把「在线」说成「在干活」。
  return st.roster.map((r) => {
    const role = rolePlainOf(r);
    if (!r.loaded) return { name: r.name, role, text: '状态未知（没有上报）', cls: 'unknown' };
    if (r.conn !== 'online') return { name: r.name, role, text: '没连上（连接断了，不代表它在偷懒）', cls: 'down' };
    if (r.work === 'working') {
      const fresh = r.hbState === 'ok' && r.hbText && r.hbText !== '—';
      return { name: r.name, role, cls: 'busy',
        text: `在干活${fresh ? ` · 上次动静 ${r.hbText}` : ''}${r.taskText && r.taskText !== '—' ? ` · ${r.taskText}` : ''}` };
    }
    if (r.work === 'idle') return { name: r.name, role, text: '连着，但没接到活', cls: 'idle' };
    if (r.hbState === 'timeout') return { name: r.name, role, text: '连着，但已经有一阵没动静，可能卡住了', cls: 'unknown' };
    return { name: r.name, role, text: `连着，在不在干活未知${r.workUnknownWhy ? `（${r.workUnknownWhy}）` : ''}`, cls: 'unknown' };
  });
}
function rosterHeadline(st) {
  if (!lastState || !Array.isArray(lastState.agents)) return 'AI 状态还没读到（等首轮同步完成）';
  const on = st.rosterOnline, busy = st.rosterBusy;
  const unk = st.hasUnknown ? `（另有 ${st.roster.length - st.firstLine} 个情况不明）` : '';
  if (busy > 0) return `${busy} 个 AI 助手正在干活 · 共 ${on} 个已连接${unk}`;
  if (on > 0) return `${on} 个 AI 助手都在，现在没人干活${unk}`;
  return '还没有 AI 助手连上来';
}
function rosterBusyLine(st) {
  const busy = st.roster.filter((r) => r.loaded && r.work === 'working');
  if (!busy.length) return '';
  const b = busy[0];
  if (b.hbState === 'timeout') return `${b.name} 已经有一阵没动静了，可能卡住了`;
  if (b.hbState === 'ok' && b.hbText && b.hbText !== '—') return `${b.name} 在干活 · 上次动静 ${b.hbText}`;
  return `${b.name} 在干活`;
}

/* ---- R85·X07：首页名册卡——只报「谁在干嘛」这一件事，默认一行结论可展开。
     连接健康 / 任务执行 / 上报新鲜度三口径在每行里分开说；情况不明的行给「检查连接」。 ---- */
function rosterCardHtml(st) {
  const head = rosterHeadline(st);
  const rows = cabinUI.rosterOpen ? `<div class="roster-rows">${rosterPlain(st).map((r) => `
    <div class="roster-row ${r.cls}">
      <b>${esc(r.name)} · ${esc(r.role)}</b>
      <span class="roster-state">${esc(r.text)}</span>
      ${r.cls === 'unknown' || r.cls === 'down' ? '<button class="cabin-link" type="button" data-roster-check>检查连接</button>' : ''}
    </div>`).join('')}</div>` : '';
  return `<div class="cabin-roster">
    <div class="roster-h"><b>${esc(head)}</b>
      <button class="cabin-link" type="button" data-cabin-roster>${cabinUI.rosterOpen ? '收起明细' : '每个 AI 在干嘛'}</button></div>
    ${rows}</div>`;
}

/* ---- R85·X08：刚建软件的入伙三步——已收到你的想法 → AI 正在讨论需要做哪些功能
     →（文档生成后）需求文档已生成，等你确认。只对「刚建」且还停在讨论期的任务显示，
     新建全程没有选模型这一步。 ---- */
function onboardStripHtml(t, steps) {
  const g = (k) => steps.find((s) => s.key === k);
  const req = g('req'), doc = g('doc');
  if (!req || req.status !== 'done') return '';                       // 想法还没落档
  if (doc && (doc.status === 'done' || doc.status === 'skipped')) return '';   // 已过了讨论期
  const fresh = cabinFresh.has(t.id)
    || (t.updatedAt && Date.now() - Date.parse(t.updatedAt) < 15 * 60 * 1000);
  if (!fresh) return '';   // 老任务停在这里不算「正在入伙」，按普通旅程展示，不冒充
  const dSt = doc ? doc.status : 'pending';
  // TASK-R87整改 X01：文案跟着真实讨论进度走（任务书状态表口径），停住了不冒充在跑
  const d = ensureDiscuss(t);
  let mid;
  if (dSt === 'running') {
    if (d && d.exists && d.phase === 'error') mid = 'AI 的需求讨论停住了';
    else if (d && d.exists && d.phase === 'writing') mid = 'AI 正在整理需求文档';
    else if (d && d.exists && (d.messages || []).length) mid = '两位 AI 助手正在讨论软件需要哪些功能';
    else if (d && d.exists && d.phase === 'discussing') mid = 'AI 正在分析你的想法';
    else mid = 'AI 正在整理你想做的软件';
  } else if (dSt === 'awaiting') mid = '需求文档已生成，等你确认';
  else if (dSt === 'failed') mid = 'AI 正在按你的意见重新讨论';
  else mid = '即将开始讨论需要做哪些功能';
  return `<div class="ob-strip" aria-label="新软件的当前进度">
    <span class="ob-done">✓ 已收到你的想法</span>
    <span class="ob-cur">② ${esc(mid)}</span>
    <span class="ob-fut">③ 等你确认后开始制作</span>
  </div>`;
}

/* ================= 任务的人话状态（任务条 chip 用，优先吃后端 X05 四态） ================= */
const ACT_STATE_CN = { working: '进行中', awaiting_user: '等你确认', idle: '空闲', unknown: '暂时无法确认' };
function cabinTaskState(t) {
  const a = t.activity;
  const ss = t.steps || [];
  if (a && a.activity_state === 'working') return 'AI 在做';
  if (a && a.activity_state === 'awaiting_user') return '等你确认';
  if (ss.length && ss.every((s) => s.status === 'done' || s.status === 'skipped')) return '做完了';
  if (ss.some((s) => s.status === 'failed')) return '改进中';
  if (ss.some((s) => s.status === 'running')) return 'AI 在做';
  if (a && a.activity_state === 'unknown') return '状态未知';
  return '进行中';
}

/* ================= X05：AI 工作实况广播（数据来自 /api/office/flow 的 live 字段） =================
   四态分得清清楚楚：working 在干活 / awaiting_user 等你确认 / idle 空闲 / unknown 暂时无法确认。
   「在线」绝不冒充「正在干活」——连接情况只在底栏与干活记录页说。 */
function liveBarHtml(t) {
  const live = lastFlow && lastFlow.live;
  if (!live || !live.current_activity) return '';
  const st = live.activity_state;
  const time = live.activity_updated_at ? `<time>${esc(fmtTime(live.activity_updated_at))}</time>` : '';
  if (st === 'working') {
    const jump = live.taskId && live.taskId !== t.id
      ? `<button class="cabin-link" type="button" data-cabin-task="${esc(live.taskId)}">去看看「${esc(plainDyn(String(live.taskTitle || '')).slice(0, 14))}」</button>` : '';
    return `<div class="cabin-live lv-working"><span class="lv-dot" aria-hidden="true"></span><b>AI 正在干活</b><span class="lv-text">${esc(plainDyn(live.current_activity))}</span>${time}${jump}</div>`;
  }
  if (st === 'awaiting_user' && live.taskId && live.taskId !== t.id) {
    return `<div class="cabin-live lv-wait"><b>另一个软件在等你确认</b><span class="lv-text">${esc(plainDyn(live.current_activity))}</span><button class="cabin-link" type="button" data-cabin-task="${esc(live.taskId)}">去看看</button></div>`;
  }
  const cls = st === 'awaiting_user' ? 'lv-wait' : 'lv-idle';
  return `<div class="cabin-live ${cls}"><span class="lv-dot" aria-hidden="true"></span><span class="lv-text">${esc(plainDyn(live.current_activity))}</span>${time}</div>`;
}

/* ================= X07：开始制作新软件（一个问题 + 一个输入框 + 一个按钮） ================= */
function newTaskHtml(alwaysOpen) {
  return `
  <div class="cabin-new">
    <h3>${alwaysOpen ? '你想让 AI 帮你做一个什么软件？' : '开始制作新软件'}</h3>
    ${alwaysOpen ? '' : '<p class="cn-q">你想让 AI 帮你做一个什么软件？</p>'}
    <textarea id="newtask-idea" maxlength="2000" rows="3" placeholder="用一两句话描述，比如：帮我做一个能自动整理发票的小工具"></textarea>
    <div class="cn-row">
      <span class="cn-score">目标分 <input id="newtask-score" type="number" step="0.5" min="5" max="10" value="${defaultScore().toFixed(1)}"></span>
      <button class="btn btn-primary" id="newtask-go" type="button" data-cabin-newgo>开始和 AI 讨论</button>
      ${alwaysOpen ? '' : '<button class="cabin-link" type="button" data-cabin-newclose>取消</button>'}
      <span id="newtask-hint" class="cf-hint"></span>
    </div>
    <p class="cn-tip">点「开始和 AI 讨论」后，AI 先把你的想法整理成需求清单，再请你确认。目标分默认用你在设置里存的 ${defaultScore().toFixed(1)} 分；在这里改了只对这个软件生效，不会动你的默认设置。</p>
  </div>`;
}

/* ================= 向导主页（我的任务） ================= */
function renderCabin() {
  const wrap = document.getElementById('cabin-main');
  const foot = document.getElementById('cabin-foot');
  if (!wrap || !foot) return;
  saveCabinDrafts();

  // 数据未到/读失败的诚实占位（与工作台同口径，不拿空数据冒充）
  if (!lastFlow) {
    const failed = modErr.flow && !modOkAt.flow;
    wrap.innerHTML = `${failed
      ? '<div class="cabin-loading">任务清单读取失败，原因见页面顶部；正在自动重试。</div>'
      : '<div class="cabin-loading">正在读取任务…首轮同步完成后展示。</div>'}`;
    foot.innerHTML = '';
    return;
  }
  const tasks = lastFlow.tasks || [];
  // R86·X02：首页只认真实软件需求——测试任务只在展示层隐藏（数据不动），归高级工作台
  const realTasks = tasks.filter((x) => !isTestTask(x));
  if (!realTasks.length) {
    // X07：首页空状态 = 开新软件的唯一入口；R86·X02：没有真实需求（含只剩测试任务）同样是空状态
    wrap.innerHTML = liveBarHtml({ id: '' }) + (cabinUI.newOpen ? newTaskHtml(true) : `
      <div class="cabin-empty">
        <h2>你还没有开始制作软件</h2>
        <button class="btn btn-primary" type="button" data-cabin-newopen>开始制作第一个软件</button>
      </div>`);
    document.getElementById('cabin-tasks').innerHTML =
      '<button type="button" class="cabin-newbtn" data-cabin-newopen title="从头开始，AI 帮你做一个新软件">＋ 开始制作新软件</button>';
    foot.innerHTML = '';
    restoreCabinDrafts();
    return;
  }

  // 任务条：+ 开始制作新软件（X07 固定入口）+ 全部任务 + 人话状态
  // R85·X03：标题走 plainTitle（内部代号只留在「详细信息」）
  // R86·X02：测试任务在首页固定隐藏（要看测试去高级工作台 /pro），指纹按过滤后的清单算
  renderChanged('cabin-tasks', realTasks.map((t) => `${t.id}:${cabinTaskState(t)}:${t.title}`).join('|'), () => {
    const el = document.getElementById('cabin-tasks');
    el.innerHTML = `
    <button type="button" class="cabin-newbtn" data-cabin-newopen title="从头开始，AI 帮你做一个新软件">＋ 开始制作新软件</button>
    ${realTasks.slice(0, 12).map((t) => {
      const title = plainTitle(t);
      return `
      <button type="button" class="cabin-task${t.id === ui.taskId ? ' cur' : ''}" data-cabin-task="${esc(t.id)}" title="${esc(title)}">
        <b>${esc(title.length > 16 ? title.slice(0, 16) + '…' : title)}</b>
        <span>${esc(cabinTaskState(t))}</span>
      </button>`;
    }).join('')}`;
  });

  let t = currentTask();
  // R86·X02：选中项是被隐藏的测试任务时（如从高级工作台带回的位置），切到最近一条真实需求
  if (t && isTestTask(t)) { ui.taskId = realTasks[0].id; t = currentTask(); }
  if (!t) { wrap.innerHTML = '<div class="cabin-loading">请在上面的任务条里选一个软件。</div>'; foot.innerHTML = ''; return; }
  const steps = (t.steps || []).slice().sort((a, b) => (a.no ?? 0) - (b.no ?? 0));
  if (!steps.length) { wrap.innerHTML = '<div class="cabin-loading">这个软件还没有步骤档案。</div>'; foot.innerHTML = ''; return; }

  // 焦点步：真交了东西等你确认（awaiting+前置齐） > 被打回 > 进行中 > 等前置
  // > 首个未完成 > 全做完停最后一格。ui.stepKey 对齐焦点步，
  // 主按钮走全局 data-decide 委托，submitDecision 读的就是 ui.taskId/ui.stepKey。
  // TASK-R87整改 X01：删掉「门开了但还没交（gate+pending）」预确认档——
  // 讨论前那道审批没了，AI 自动开工，用户只在新需求文档交上来（awaiting）时出手。
  const focus = steps.find((x) => x.status === 'awaiting' && waitingOnOf(x, t.steps).length === 0)
    || steps.find((x) => x.status === 'failed')
    || steps.find((x) => x.status === 'running')
    || steps.find((x) => x.status === 'awaiting')
    || steps.find((x) => x.status !== 'done' && x.status !== 'skipped')
    || steps[steps.length - 1];
  ui.stepKey = focus.key;

  const total = steps.length;
  const doneN = steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  const pct = total ? Math.round(doneN / total * 100) : 0;
  const fSt = focus.status || 'pending';
  // TASK-R87整改 X01：向导口径的「轮到你了」只认真的交了东西（awaiting+前置齐）。
  // gate+pending 不再算——那正是被删掉的讨论前审批（专业视图 isDecidable 不动）。
  const decidable = fSt === 'awaiting' && waitingOnOf(focus, t.steps).length === 0;
  const st = agentStats();
  const busyLine = rosterBusyLine(st);
  const target = targetScoreOf(t.id);
  const key = `${t.id}/${focus.key}`;

  // ---- R85 共享判定：hero 卡和底栏同一套状态/同一套按钮，绝不分叉 ----
  const idx = steps.findIndex((x) => x.key === focus.key);
  const obj = decidable ? approvalObjectOf(t, focus, t.steps, idx) : null;
  const rework = focus.key === 'verify' && decidable && verifyNeedsRework(t);
  const pending = pendingOps.has(key);
  // R86·X01：计划阶段先读真实计划文件并做内容判定——三样齐（功能/步骤/测试）才允许确认，
  // 读不到 / 不完整 / 系统验证任务一律禁用（kind 只有 'ok' 放行，空摘要也不放行）
  const planStage = focus.key === 'plan';
  const planRead = planStage ? ensurePlanRead(t) : null;
  const planBlocked = planStage && decidable && fSt === 'awaiting' && (!planRead || planRead.kind !== 'ok');

  // ---- X01 三块之首与 h2：当前状态一句话（优先吃后端 X05 activity 四字段）----
  // TASK-R87整改 X01/X02：需求阶段（doc）优先走「真实讨论进度」分支——文案逐行
  // 对上任务书状态表；后端确实在干活才说「正在」，停住了照实说，不冒充。
  const act = t.activity;
  const actState = act && act.activity_state ? act.activity_state : '';
  let nowMain = '', nowSub = '';
  const dsc = focus.key === 'doc' ? ensureDiscuss(t) : null;
  if (focus.key === 'doc' && fSt === 'running') {
    if (dsc && dsc.exists && dsc.phase === 'error') {
      nowMain = 'AI 的需求讨论停住了';
      nowSub = dsc.error ? String(dsc.error).slice(0, 100) : '原因暂时查不到；可以重新提交想法，或去高级工作台看步骤档案';
    } else if (dsc && dsc.exists && dsc.phase === 'writing') {
      nowMain = 'AI 正在整理需求文档';
      nowSub = busyLine || '讨论完成，正在把结论写成文档';
    } else if (dsc && dsc.exists && dsc.phase === 'discussing' && (dsc.messages || []).length) {
      nowMain = '两位 AI 助手正在讨论软件需要哪些功能';
      nowSub = `已聊了 ${(dsc.messages || []).length} 条，往下能看到讨论原文`;
    } else if (dsc && dsc.exists && dsc.phase === 'discussing') {
      nowMain = '已收到你的想法，AI 正在分析';
      nowSub = '你的原始想法已收到，接下来会整理成具体的软件功能。';
    } else {
      nowMain = 'AI 正在整理你想做的软件';
      nowSub = '你的原始想法已收到，接下来会整理成具体的软件功能。';
    }
  } else if (focus.key === 'doc' && fSt === 'awaiting' && decidable) {
    nowMain = '软件需求已经整理好，等你确认';
    nowSub = '看下面 AI 讨论出来的功能和「不做什么」，确认后开始制定开发计划';
  } else if (act && act.current_activity) {
    nowMain = plainDyn(act.current_activity);
    const parts = [];
    if (act.activity_updated_at) parts.push(`更新于 ${fmtTime(act.activity_updated_at)}`);
    if (actState === 'working' && busyLine) parts.push(busyLine);
    nowSub = parts.join(' · ');
  } else if (fSt === 'running') {
    nowMain = `${focus.by || 'AI'} 正在${stepHumanName(focus, steps)}`;
    nowSub = [focus.at ? `已用 ${ago(focus.at)}` : '', busyLine].filter(Boolean).join(' · ');
  } else if (decidable && fSt === 'awaiting') {
    nowMain = `「${stepHumanName(focus, steps)}」做好了，等你确认`;
    nowSub = focus.note ? String(focus.note).slice(0, 80) : '看完下面做出来的东西，再决定确认还是打回';
  } else if (fSt === 'failed') {
    nowMain = `「${stepHumanName(focus, steps)}」被你打回了`;
    nowSub = focus.note ? `你的意见：${String(focus.note).slice(0, 80)}` : 'AI 改好后会再交上来';
  } else if (fSt === 'done' || fSt === 'skipped') {
    nowMain = `「${plainTitle(t)}」全部做完了 ✓`;
    nowSub = `目标 ${target.toFixed(1)} 分 · ${reviewLatest(t) ? `最后一轮 ${Number(reviewLatest(t).score).toFixed(1)} 分` : '还没有评分记录'}`;
  } else {
    nowMain = `「${stepHumanName(focus, steps)}」还没开始`;
    nowSub = busyLine || '排着队，AI 接到活就会开始动';
  }

  // ---- X01 三块：当前制作的软件 / 当前状态 / 下一步要做的事 ----
  // R85·X03：标题不带内部代号；R85·X02：主按钮直接放进第三块，首屏不滚就能点
  const titlePlain = plainTitle(t);
  const nextLine = (() => {
    const nm = stepHumanName(focus, steps);
    // TASK-R87整改 X01：需求阶段的下一步说法跟新流程走
    if (focus.key === 'doc') {
      if (fSt === 'running') return '等 AI 讨论完、整理出需求文档';
      if (fSt === 'awaiting' && decidable) return '确认这份软件需求，开始制定计划';
      if (fSt === 'awaiting') return `「${nm}」在等前面的步骤完成`;
      if (fSt === 'failed') return `AI 正在按你的意见改「${nm}」`;
      return `下一步是「${nm}」（还没开始）`;
    }
    if (decidable && fSt === 'awaiting') return `等你确认「${nm}」`;
    if (decidable) return `等 AI 交上「${nm}」`;
    if (fSt === 'failed') return `AI 正在按你的意见改「${nm}」`;
    if (fSt === 'running') return `等 AI 做完「${nm}」`;
    if (fSt === 'awaiting') return `「${nm}」在等前面的步骤完成`;
    if (fSt === 'done' || fSt === 'skipped') return '全部完成，去查看成果';
    return `下一步是「${nm}」（还没开始）`;
  })();
  const heroActHtml = pending ? '<span class="ch-act-wait">已提交，正在确认结果…</span>'
    : (decidable && obj && obj.kind === 'none')
      ? `<button class="btn btn-primary" type="button" data-cabin-note>${planStage ? '它还没交计划，我去催' : '它没交东西，我去催'}</button>`
    : rework
      ? `<button class="btn btn-primary" type="button" data-cabin-rework>${esc(STAGE_MAIN_REWORK)}</button><button class="cabin-link" type="button" data-cabin-note>修改这份内容</button>`
    : (decidable && obj)
      ? `<button class="btn btn-primary" type="button" data-decide="approve"${planBlocked ? ' disabled title="开发计划还没到能确认的状态——三样齐了（功能、步骤、测试）自动恢复"' : ''}>${esc(STAGE_MAIN[focus.key] || '我确认')}</button><button class="cabin-link" type="button" data-cabin-note>${planStage ? '计划需要修改' : focus.key === 'doc' ? '告诉 AI 哪里需要修改' : '修改这份内容'}</button>`
    : fSt === 'failed'
      ? '<button class="btn btn-primary" type="button" data-decide="resubmit">让它重新交上来</button>'
    : '<span class="ch-act-wait">现在不用你操作，轮到你的那一刻按钮会亮起来</span>';
  // TASK-R87整改 X03：需求确认界面必须按 ①AI 讨论了什么 → ②最终准备做什么 →
  // ③需要你决定什么 的顺序读。doc 阶段把 hero 拆成两截，中间插讨论卡和功能卡；
  // 其余阶段维持原结构。
  const heroHeadHtml = `
    <div class="ch-block"><span class="ch-k">当前制作的软件</span>
      <b class="ch-v" title="${esc(titlePlain)}">${esc(titlePlain.length > 22 ? titlePlain.slice(0, 22) + '…' : titlePlain)}</b>
      <span class="ch-s">更新于 ${esc(fmtTime(t.updatedAt))}${isTestTask(t) ? ' · 测试任务' : ''}</span></div>
    <div class="ch-block"><span class="ch-k">当前状态</span>
      <b class="ch-v${actState ? ' as-' + actState : ''}">${esc(actState ? ACT_STATE_CN[actState] || actState : (fSt === 'running' ? '进行中' : decidable ? '等你确认' : '进行中'))}</b>
      <span class="ch-s">${esc(nowMain.length > 34 ? nowMain.slice(0, 34) + '…' : nowMain)}</span></div>`;
  const heroActBlockHtml = `
    <div class="ch-block ch-block-act"><span class="ch-k">${focus.key === 'doc' ? '需要你决定什么' : '下一步要做的事'}</span>
      <b class="ch-v">${esc(nextLine)}</b>
      <span class="ch-act">${heroActHtml}</span></div>`;
  const docStage = focus.key === 'doc';
  // R88：主按钮必须留在第一屏（1440×900 / 1280×768 都免滚动）。
  // doc 阶段原本把讨论卡和功能卡排在操作块前面，按钮被顶到 1033px 出屏了。
  // 现在：操作块紧跟三栏信息块；讨论卡和功能卡折进「展开看你确认的内容」，默认展开但限高可滚。
  const heroHtml = docStage
    ? `<div class="cabin-hero">${heroHeadHtml}${heroActBlockHtml}</div>
       <details class="cabin-more" open>
         <summary>展开看你确认的内容（AI 讨论了什么 · 最终准备做什么）</summary>
         ${discussCardHtml(t)}${featCardHtml(t)}
       </details>`
    : `<div class="cabin-hero">${heroHeadHtml}${planStage ? planHeroHtml(planRead) : ''}${heroActBlockHtml}</div>`;

  // ---- 走过的路：完成步默认折叠（✓），当前步高亮（▸），以后灰着（○）
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
          <span class="cp-state">${decidable && fSt === 'awaiting' ? '做好了，等你确认' : fSt === 'failed' ? '被你打回了' : fSt === 'running' ? '正在做' : fSt === 'done' || fSt === 'skipped' ? '已完成' : '还没开始'}</span>
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
      <span>这个软件做到多少分算完成：</span>
      <input id="cabin-score-input" type="number" step="0.5" min="5" max="10" value="${target.toFixed(1)}">
      <span>分</span>
      <button class="btn btn-primary" type="button" data-cabin-savescore>保存</button>
    </div>` : `
    <div class="cabin-score">目标 <b>${target.toFixed(1)}</b> 分
      <button class="cabin-link" type="button" id="cabin-score-edit" data-cabin-scoreedit>改</button>
    </div>`;

  const feat = ensureFeat(t);
  const rd = cabinReviewData(t);
  const lastR = reviewLatest(t);
  const live = lastFlow.live || null;

  // 进度条统一按「6 段制作旅程」算，不再暴露内部的 7 步，
  // 否则首页同时出现「第 3/7 步」和「六段旅程」两套计数，用户会困惑。
  const jStates = JOURNEY.map((jst) => journeyStateOf(jst, steps));
  const jCur = jStates.findIndex((s) => s !== '已完成');
  const journeyNo = jCur < 0 ? JOURNEY.length : jCur + 1;
  const journeyLabel = jCur < 0 ? '全部完成' : `${JOURNEY[jCur].label} · ${jStates[jCur]}`;
  const pctJourney = Math.round((jStates.filter((s) => s === '已完成').length / JOURNEY.length) * 100);

  const onboardHtml = onboardStripHtml(t, steps);
  // R87：讨论留档（phase/条数/错误摘要）与「不做什么」清单参与指纹——
  // 讨论每多一条真实消息，页面立刻重画，不等人
  const dscFp = focus.key === 'doc' ? discussFpOf(dsc) : 'nd';
  const fp = [
    t.id, focus.key, fSt, decidable, nowMain, actState,
    steps.map((s) => s.status).join(','),
    steps.map((s) => (s.files || []).map((f) => (f.history || []).length).join('.')).join(';'),
    cabinUI.pastOpen, cabinUI.scoreEdit, cabinUI.newOpen, target,
    pastSteps.length, busyLine,
    feat.kind, (feat.bullets || []).join('·'), (feat.notdo || []).join('·'), (feat.path || ''),
    dscFp,
    JOURNEY.map((jst) => journeyStateOf(jst, steps)).join(','),
    rd ? `${(rd.rounds || []).length}|${rd.advice}|${lastR ? lastR.score : ''}|${lastR && lastR.result ? 'r' : ''}` : 'nord',
    cabinUI.reviewOpen,
    live ? `${live.activity_state}|${live.current_activity}|${live.taskId}|${live.activity_updated_at || ''}` : 'nolive',
    // R86：计划判定（kind/摘要/验证目标）/名册/入伙条都参与指纹，内容一变就重画
    cabinUI.rosterOpen ? 'ropen' : 'rclosed',
    planStage ? (planRead ? `${planRead.kind}|${(planRead.lines || []).join('·')}|${planRead.goal || ''}` : 'loading') : 'noplan',
    onboardHtml ? 'ob' : 'noob', rosterHeadline(st),
    steps.map((s) => s.at || '').join(','),
  ].join('|');
  renderChanged('cabin-main', fp, () => {
    document.getElementById('cabin-main').innerHTML = `
      ${liveBarHtml(t)}
      ${cabinUI.newOpen ? newTaskHtml(false) : ''}
      <div class="cabin-now">
        <h2>${esc(nowMain)}</h2>
        ${nowSub ? `<p>${esc(nowSub)}</p>` : ''}
        ${heroHtml}
        ${onboardHtml}
        <div class="cabin-bar"><i style="width:${pctJourney}%"></i></div>
        <div class="cabin-progress">第 ${journeyNo} / ${JOURNEY.length} 阶段${journeyLabel ? ' · ' + journeyLabel : ''}</div>
        ${scoreHtml}
      </div>
      ${planStage || docStage ? '' : featCardHtml(t)}
      ${journeyHtml(steps, t)}
      ${reviewCardHtml(t)}
      ${rosterCardHtml(st)}
      <div class="cabin-path">
        <button class="cabin-past-toggle" type="button" data-cabin-past>
          ${cabinUI.pastOpen ? '收起' : `看看已经做完的（${pastSteps.length} 项）`}
        </button>
        ${pathHtml}
        <details class="ch-detail">
          <summary>详细信息</summary>
          <div>内部编号 ${esc(t.id)}${isTestTask(t) ? ' · 测试任务（测完即删，只在高级工作台展示）' : ''}</div>
        </details>
      </div>`;
    restoreCabinDrafts();
  });

  // ---- 底部：与 hero 卡同一套状态/动作（R85·X02 两处入口不分叉） ----
  renderCabinFoot(t, steps, focus, key, { idx, obj, rework, pending, planStage, planBlocked, decidable });
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

function renderCabinFoot(t, steps, focus, key, sh) {
  const fSt = focus.status || 'pending';
  // R87·X01：与 hero 卡同一口径——只认真的交了东西（awaiting+前置齐）才亮确认；
  // sh 里带了 renderCabin 算好的值就优先用，不带（老调用）按同规则现算
  const decidable = sh && sh.decidable != null
    ? sh.decidable
    : (fSt === 'awaiting' && waitingOnOf(focus, t.steps).length === 0);
  const idx = sh && sh.idx != null ? sh.idx : steps.findIndex((x) => x.key === focus.key);
  const pending = sh && sh.pending != null ? sh.pending : pendingOps.has(key);
  const err = decisionResult && decisionResult.key === key && decisionResult.msg ? decisionResult.msg : '';
  // X02：verify 的主按钮文案看评审台账——最新一轮未达标 →「自动按建议继续改进」
  const rework = sh && sh.rework != null ? sh.rework : (focus.key === 'verify' && decidable && verifyNeedsRework(t));
  // R85·X01：计划读不到 → 确认按钮停用（与 hero 卡同一判定，不分叉）
  const planBlocked = !!(sh && sh.planBlocked);
  const planStage = !!(sh && sh.planStage);
  const lastR = reviewLatest(t);
  const fp = [key, fSt, decidable, cabinUI.noteOpen, pending, err, rework, planBlocked,
    lastR ? lastR.no : '',
    approvalObjectOf(t, focus, t.steps, idx).kind].join('|');
  renderChanged('cabin-foot', fp, () => {
    const foot = document.getElementById('cabin-foot');
    if (pending) {
      foot.innerHTML = `<div class="cf-wait">已提交，正在确认结果…（几秒内自动更新）</div>`;
      return;
    }
    const errHtml = err ? `<div class="cf-err">${esc(err)}</div>` : '';
    if (decidable) {
      const obj = sh && sh.obj ? sh.obj : approvalObjectOf(t, focus, t.steps, idx);
      const noteBox = cabinUI.noteOpen ? `
        <div class="cf-note">
          <textarea id="cabin-note-input" maxlength="500" rows="3" placeholder="告诉 AI 哪些地方需要调整（打回/催材料时必填）"></textarea>
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
            <button class="btn btn-primary cf-main" type="button" data-cabin-note>${cabinUI.noteOpen ? '在写要求…' : (planStage ? '它还没交计划，我去催' : '它没交东西，我去催')}</button>
            <span class="cf-tip">这一步还没交上可看的东西，先说清楚缺什么</span>
          </div>${noteBox}`;
      } else if (rework) {
        // X02/X06：评审未达标 → 自动按建议继续改进（有评审指令直接带上，没有就先写）
        foot.innerHTML = `${errHtml}
          <div class="cf-row">
            <button class="btn btn-primary cf-main" type="button" data-cabin-rework>${STAGE_MAIN_REWORK}</button>
            <button class="cabin-link" type="button" data-cabin-note>修改这份内容</button>
            <span class="cf-tip">${lastR && lastR.instruction ? `按第 ${lastR.no} 轮评审意见继续改` : '先在下面写清楚这轮要改什么'}（目标 ${targetScoreOf(t.id).toFixed(1)} 分，上一轮 ${Number(lastR ? lastR.score : 0).toFixed(1)} 分）</span>
          </div>${noteBox}`;
      } else {
        const dis = planBlocked ? ' disabled title="开发计划还没到能确认的状态——三样齐了（功能、步骤、测试）自动恢复"' : '';
        const planErr = planBlocked ? '<div class="cf-err">开发计划还没到能确认的状态（读不到 / 内容不完整 / 系统验证任务）——确认按钮先停用，计划合格后自动恢复。</div>' : '';
        foot.innerHTML = `${errHtml}${planErr}
          <div class="cf-row">
            <button class="btn btn-primary cf-main" type="button" data-decide="approve"${dis}>${esc(STAGE_MAIN[focus.key] || '我确认')}</button>
            <button class="cabin-link" type="button" data-cabin-note>${planStage ? '计划需要修改' : '修改这份内容'}</button>
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
      foot.innerHTML = `<div class="cf-idle">AI 在干活，现在不用你操作。有结果了这里会出现「等你确认」。</div>`;
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
        else if (ds === 'awaiting') verb = waitingOnOf(s, t.steps).length === 0 ? '交上来，等你拍板' : '交上来了';
        else if (ds === 'failed') verb = '被你打回了';
        if (verb) events.push({ at: s.at, by: s.by, verb, name: stepHumanName(s, t.steps), task: plainTitle(t) });
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
          <b>${esc(e.by || 'AI 助手')}</b>
          <span>${esc(e.verb)}「${esc(e.name)}」</span>
          <span class="log-ev-task">${esc(e.task)}</span>
        </div>`).join('') : '<div class="cabin-loading">还没有干活记录——第一个软件开始制作后，这里会一条条记下来。</div>'}</div>`;
  });
}

/* ================= 设置 · 常用页 ================= */
// X03 术语对照表（任务书钉死的 13 条全在，只影响展示与解释，不改任何内部标识）
const TERM_ROWS = [
  ['F01 / 需求编号', '这条需求的代号（只在详情里出现）'],
  ['登记 A / V2 / 当前版', '这次准备采用的方案'],
  ['产物 / 交付物', '生成的文件、工作成果'],
  ['拍板 / 审批 / 决策', '确认、做决定'],
  ['Agent / 实例', 'AI 助手'],
  ['Coding / 开发', '软件开发'],
  ['执行状态未知', '暂时无法确认是否正在工作'],
  ['上报新鲜度 / 心跳', '最近一次收到消息'],
  ['文件指纹 / 哈希 / SHA-256', '文件版本信息'],
  ['门禁 / 把关', '开始下一步前的检查'],
  ['AI N 个在线 / 在线实例', 'N 个 AI 助手已连接'],
  ['专业视图', '高级工作台'],
  ['fixture-time.md', '时间验证记录'],
  ['评审 / 加权得分', '打分'],
  ['验收报告', '检查结果'],
];
function renderSettingsGeneral() {
  const el = document.getElementById('set-general');
  if (!el) return;
  renderChanged('set-general', String(defaultScore()), () => {
    document.getElementById('set-general').innerHTML = `
      <div class="set-card">
        <h3>目标分</h3>
        <p class="set-desc">一个软件做到多少分算完成。这里是新软件的默认值；单个软件的目标分，在「我的任务」页顶部改。</p>
        <div class="set-row">
          <span>默认目标分</span>
          <input id="cabin-defscore-input" type="number" step="0.5" min="5" max="10" value="${defaultScore().toFixed(1)}">
          <span>分</span>
          <button class="btn btn-primary" type="button" data-cabin-savedef>保存</button>
        </div>
      </div>
      <div class="set-card">
        <h3>术语小抄</h3>
        <p class="set-desc">系统里偶尔还会出现左边这些词（高级工作台、旧文档里），对照右边理解就行。</p>
        <table class="set-terms"><tbody>
          ${TERM_ROWS.map(([a, b]) => `<tr><td>${esc(a)}</td><td>→</td><td><b>${esc(b)}</b></td></tr>`).join('')}
        </tbody></table>
      </div>
      <div class="set-card">
        <h3>其他设置在哪</h3>
        <p class="set-desc">AI 助手的状态明细在「AI 与干活状态」页签；技能管理和文件库也在本页。顶栏齿轮里是连接与刷新设置。</p>
      </div>`;
  });
}
