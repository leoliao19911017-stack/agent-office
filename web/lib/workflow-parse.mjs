// workflow-parse.mjs — 自然语言 → 工作流模板草稿（纯规则，不调外部 LLM）。
//
// 第二步的硬约束：确定性、可测试。同一段文本任何时候都产出同一份 draft，
// 没有网络、没有随机数、没有模型温度。第三步接真 LLM 时，本文件仍是
// 「离线兜底 + 单测基准」。
//
// 做法：
//   1) 按标点与连接词切句；
//   2) 九类标准环节各自用关键词在句子里找一次，找到就生成一步（不编没说的步骤）；
//   3) 从命中句里抽角色（Claude / GPT / Codex / 我 / DSH / Hermes），决定 actor 与 collaborators；
//   4) 抽目标分（「8 分」「90 分」）、返工词（「不到…继续改」「回到」「重新」）、判据词；
//   5) 生成给 Leo 看的中文 summary，以及「没识别出来」的 missing 列表。
//
// 不猜的部分：没说的步骤不补、没说的权重不填、没说的自主边界不填。
// missing 就是把「文本里没找到」的项列出来，让 Leo 在确认前自己补。

import { createHash } from 'node:crypto';

/** 九类标准环节，顺序即生成顺序（与 coding-v1 对齐，但缺哪步就跳过哪步）。 */
const STEP_DEFS = [
  {
    key: 'requirement',
    short: '需求',
    name: '需求输入',
    actor: 'user',
    outputs: ['requirement'],
    gate: 'user_done',
    patterns: [
      /(?:给|提|说|写|输入|明确|整理|先).{0,6}需求/,
      /需求(?:输入|提出|来源)/,
      /我的想法|我要做|我想做/,
    ],
  },
  {
    key: 'clarify',
    short: '澄清',
    name: '需求澄清',
    actor: 'hermes',
    collaborators: ['leo'],
    outputs: ['clarification_qa'],
    gate: 'ambiguities_resolved',
    patterns: [/不清楚|不明白|有疑问|问我|澄清|歧义|追问|再问|确认问题|问清楚/],
  },
  {
    key: 'confirm',
    short: '确认',
    name: '需求讨论与确认',
    actor: 'hermes',
    collaborators: ['leo'],
    outputs: ['confirm_discuss', 'confirm_final'],
    gate: 'user_approval',
    patterns: [
      /(?:跟|和|与).{0,10}(?:GPT|Codex|gpt|codex).{0,8}(?:确认|讨论|对齐)/,
      /确认(?:需求|方案|完|后|通过)/,
      /拍板|对齐(?:需求|方案)/,
    ],
  },
  {
    key: 'plan',
    short: '计划',
    name: '开发计划与任务书',
    actor: 'hermes',
    outputs: ['task_breakdown', 'tech_plan', 'acceptance_criteria'],
    gate: 'docs_written_and_registered_in_agent_office',
    patterns: [
      /拆(?:成|解|分)?(?:任务|需求|步骤)/,
      /开发计划|计划|任务书|排期|技术方案|方案设计|依赖/,
    ],
  },
  {
    key: 'develop',
    short: '开发',
    name: '开发执行',
    actor: 'claude',
    fallback_actor: 'dsh',
    outputs: ['code_commit'],
    gate: 'each_batch_committed_and_reported',
    patterns: [
      /(?:Claude|claude|Codex|codex|DSH|dsh).{0,8}(?:做|开发|写|实现|编码)/,
      /开发(?!者)|写代码|编码|实现功能|动手做/,
    ],
  },
  {
    key: 'test',
    short: '自测',
    name: '开发者自测',
    actor: 'claude',
    fallback_actor: 'dsh',
    outputs: ['test_evidence'],
    gate: 'tests_all_pass',
    patterns: [/自测|自己.{0,4}测|先测|测试|单测|联调|冒烟|QA/],
  },
  {
    key: 'review',
    short: '评审',
    name: '独立验证与评审',
    actor: 'codex',
    fallback_actor: 'claude-subagent',
    outputs: ['review_report', 'score'],
    gate: 'hard_criteria_pass',
    patterns: [/评审|审查|review|打分|评分|独立验证|Codex.{0,8}(?:评|审|看)/i],
  },
  {
    key: 'accept',
    short: '验收',
    name: '最终验收与交付',
    actor: 'hermes',
    collaborators: ['leo'],
    outputs: ['acceptance_report'],
    gate: 'user_approval',
    patterns: [/验收|签收|最终确认|交付|我确认|上线前确认/],
  },
  {
    key: 'retro',
    short: '复盘',
    name: '归档与复盘',
    actor: 'hermes',
    outputs: ['retrospective_report', 'improvement_suggestions'],
    gate: 'metrics_summarized_and_improvement_closed',
    patterns: [/复盘|回顾|总结|归档|retro/i],
  },
];

/** 角色词。顺序无所谓，同一句里全收；user 展示成「你」。 */
const ROLE_PATTERNS = [
  { id: 'claude', label: 'Claude', re: /Claude|claude|克劳德/ },
  { id: 'codex', label: 'Codex', re: /Codex|codex/ },
  { id: 'gpt', label: 'GPT', re: /GPT|gpt|ChatGPT/ },
  { id: 'dsh', label: 'DSH', re: /\bDSH\b|\bdsh\b/ },
  { id: 'hermes', label: 'Hermes', re: /Hermes|hermes/ },
  { id: 'user', label: '你', re: /我(?!们)|自己|本人/ },
];

const ROLE_LABEL = Object.fromEntries(ROLE_PATTERNS.map((r) => [r.id, r.label]));

/** 切句：标点 + 常见连接词。连接词本身不携带信息，切掉不影响抽取。 */
const CLAUSE_SPLIT = /[，,。；;！!？?\n]+|然后|接着|之后|随后|最后|再(?:让|把|做|来)?/;

/** 句子里出现的角色（去重，保持 ROLE_PATTERNS 顺序）。 */
function rolesIn(clause) {
  const out = [];
  for (const { id, re } of ROLE_PATTERNS) {
    if (re.test(clause)) out.push(id);
  }
  return out;
}

/** 找出第一个命中该环节关键词的句子。 */
function findClause(clauses, patterns) {
  for (const clause of clauses) {
    for (const re of patterns) {
      if (re.test(clause)) return clause;
    }
  }
  return null;
}

/** 目标分：8 分 / 8.5分 / 90 分（11–100 视为百分制，换算成十分制）。 */
function parseTargetScore(text) {
  const m = text.match(/(\d+(?:\.\d+)?)\s*分/);
  if (!m) return null;
  const raw = Number(m[1]);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  if (raw <= 10) return { value: raw, text: `${m[1]} 分` };
  if (raw <= 100) {
    return { value: Math.round((raw / 10) * 10) / 10, text: `${m[1]} 分（百分制，按 ${Math.round((raw / 10) * 10) / 10} 分计）` };
  }
  return null;
}

/** 从命中句里抽角色，决定这一步谁主做、谁协作。 */
function resolveActors(def, clause) {
  const roles = clause ? rolesIn(clause) : [];
  const has = (id) => roles.includes(id);
  let actor = def.actor;

  if (def.key === 'requirement') {
    actor = 'user';
  } else if (def.key === 'clarify') {
    actor = 'hermes';
  } else if (def.key === 'confirm') {
    // 「跟 GPT 确认」= 你和 GPT 一起确认；只有「确认」没有角色时由 Hermes 主持。
    actor = has('gpt') || has('codex') ? 'user' : 'hermes';
  } else if (def.key === 'plan') {
    // 「拆成任务给 Claude 做」里的 Claude 是开发，不是计划作者；
    // 只有明说「Claude 拆任务 / Codex 出计划」才换人。
    const planner = clause && /(?:Claude|claude|Codex|codex|DSH|dsh|GPT|gpt).{0,6}(?:拆|计划|任务书)/.test(clause);
    actor = planner ? (has('claude') ? 'claude' : has('codex') ? 'codex' : 'hermes') : 'hermes';
  } else if (def.key === 'develop') {
    actor = has('claude') ? 'claude' : has('codex') ? 'codex' : has('dsh') ? 'dsh' : has('user') ? 'user' : 'claude';
  } else if (def.key === 'test') {
    // 「我自己先测」就是 Leo 自己测，不硬写成 Claude。
    actor = has('user') ? 'user' : has('claude') ? 'claude' : has('dsh') ? 'dsh' : 'claude';
  } else if (def.key === 'review') {
    actor = has('codex') ? 'codex' : has('claude') ? 'claude' : 'codex';
  } else if (def.key === 'accept') {
    actor = has('user') ? 'user' : 'hermes';
  } else if (def.key === 'retro') {
    actor = has('hermes') ? 'hermes' : 'hermes';
  }

  // 计划步骤的协作方只认「谁出计划」，不把同一句里的开发角色当协作者。
  if (def.key === 'plan') return { actor, collaborators: [] };

  const collaborators = [];
  for (const id of roles) {
    if (id === actor) continue;
    const mapped = id === 'user' ? 'leo' : id;
    if (!collaborators.includes(mapped)) collaborators.push(mapped);
  }
  // 默认协作方也保留（如 02 的 leo、08 的 leo），不因句子没提就当没有。
  for (const id of def.collaborators || []) {
    // actor 已经是「你」时，再挂一个 leo 协作方就是同一个人兼两职。
    if (id === 'leo' && actor === 'user') continue;
    if (!collaborators.includes(id)) collaborators.push(id);
  }
  return { actor, collaborators };
}

/** 从命中句里判断判据。找不到就沿用环节默认判据，并在 missing 里说明。 */
function resolveGate(def, clause, targetScore) {
  const c = clause || '';
  if (def.key === 'confirm' || def.key === 'accept') return 'user_approval';
  if (def.key === 'review') {
    return targetScore ? `hard_criteria_pass AND score >= ${targetScore.value}` : 'hard_criteria_pass';
  }
  if (def.key === 'test') {
    if (/通过才|通过后|全过|都过|全部通过/.test(c)) return 'tests_all_pass';
    return def.gate;
  }
  if (def.key === 'clarify') {
    if (/不清楚|问清楚|歧义|追问/.test(c)) return 'ambiguities_resolved';
    return def.gate;
  }
  return def.gate;
}

/** 返工路由：只从明说的返工词里推断，不默认给全量八条。 */
function parseReworkRoutes(text, stepsByKey, clauses) {
  const routes = {};
  const idOf = (key) => (stepsByKey[key] ? stepsByKey[key].id : null);
  const dev = idOf('develop');
  const test = idOf('test');
  const review = idOf('review');
  const clarify = idOf('clarify');
  const confirm = idOf('confirm');
  const requirement = idOf('requirement');

  const reworkClause = clauses.find((c) => /返工|重做|继续改|改到|重新|回到|不通过|不过/.test(c));
  const wantsRework = reworkClause !== undefined;

  if (wantsRework) {
    if (review && dev && /(?:不到|低于|少于)\s*\d+(?:\.\d+)?\s*分|继续改|改到|不通过|不过/.test(text)) {
      routes.review_below_target = dev;
    }
    if (test && dev && /(?:测试|自测).{0,8}(?:不通过|不过|失败|挂)/.test(text)) {
      routes.test_failed = dev;
    }
    if (clarify && /(?:回到|重新).{0,6}(?:需求|澄清|问)/.test(text)) {
      routes.req_ambiguity = clarify;
    } else if (confirm && /(?:回到|重新).{0,6}(?:确认|拍板)/.test(text)) {
      routes.req_ambiguity = confirm;
    } else if (requirement && /(?:回到|重新).{0,6}需求/.test(text)) {
      routes.req_ambiguity = requirement;
    }
    if (review && /(?:重新|复审|复评).{0,8}(?:评审|评)/.test(text)) {
      routes.review_criteria_mismatch = review;
    }
  }
  return routes;
}

/** 只抽文本里明说的评分权重（「需求 30%」这种），没有就是空对象。 */
function parseScoring(text) {
  const dims = [
    ['requirement_fit', /需求(?:匹配|满足)?\s*(\d{1,3})\s*%/],
    ['correctness', /(?:功能|正确性)\s*(\d{1,3})\s*%/],
    ['code_quality', /(?:代码)?质量\s*(\d{1,3})\s*%/],
    ['ux', /(?:体验|交互)\s*(\d{1,3})\s*%/],
    ['stability_security', /(?:稳定|安全)(?:性)?\s*(\d{1,3})\s*%/],
  ];
  const scoring = {};
  for (const [key, re] of dims) {
    const m = text.match(re);
    if (m) scoring[key] = Number(m[1]) / 100;
  }
  return scoring;
}

function roleLabel(id) {
  if (id === 'leo') return '你';
  return ROLE_LABEL[id] || id;
}

function actorLabel(id) {
  if (id === 'user') return '你';
  return ROLE_LABEL[id] || id;
}

/** 中文摘要：给 Leo 确认「我理解得对不对」，不是给机器看的日志。 */
function buildSummary({ steps, targetScore, routes }) {
  if (steps.length === 0) {
    return '我没从这段描述里认出任何步骤。你可以说得更具体一点，比如「我先提需求，然后 Claude 开发，Codex 评审，最后我验收」。对不对？';
  }
  const byKey = Object.fromEntries(steps.map((s) => [s.key, s]));
  const shorts = steps.map((s) => s.short);
  const parts = [`我理解你要 ${steps.length} 步：${shorts.join('→')}。`];

  if (byKey.requirement) parts.push('你先提需求');
  if (byKey.clarify) parts.push(byKey.requirement ? '，不清楚的地方先问清楚。' : '先把不清楚的地方问清楚。');
  else if (byKey.requirement) parts.push('。');

  if (byKey.confirm) {
    const who = byKey.confirm.collaborators.filter((c) => c !== 'leo').map(roleLabel);
    parts.push(who.length > 0
      ? `你和 ${who.join('/')} 确认需求后拍板。`
      : '需求确认由你拍板。');
  }
  if (byKey.plan) parts.push('然后拆成任务和开发计划。');
  if (byKey.develop) {
    parts.push(`${actorLabel(byKey.develop.actor)} 负责开发`);
    if (byKey.test && byKey.test.actor === 'user') parts.push('，做完你先自测。');
    else if (byKey.test) parts.push(`，再由 ${actorLabel(byKey.test.actor)} 自测。`);
    else parts.push('。');
  } else if (byKey.test) {
    parts.push(`${actorLabel(byKey.test.actor)} 负责自测。`);
  }
  if (byKey.review) {
    parts.push(`${actorLabel(byKey.review.actor)} 评审`);
    if (targetScore && routes.review_below_target) {
      const back = steps.find((s) => s.id === routes.review_below_target);
      parts.push(`，不到 ${targetScore.text.replace(/（.*$/, '')}就回到「${back ? back.name : '上一步'}」继续改。`);
    } else if (targetScore) {
      parts.push(`，要过 ${targetScore.text.replace(/（.*$/, '')}。`);
    } else {
      parts.push('。');
    }
  }
  if (byKey.accept) parts.push(byKey.accept.actor === 'user' ? '最后你验收。' : `最后 ${actorLabel(byKey.accept.actor)} 交给你验收。`);
  if (byKey.retro) parts.push('验收后复盘。');
  parts.push('对不对？');
  return parts.join('');
}

/**
 * 核心入口：文本 → { draft, summary, missing }。
 *
 * draft 是模板 JSON（snake_case，与 v3 定稿草案及 workflow_templates 的列名对齐），
 * 另带 target_score / target_score_text 两个「草稿提示」字段（表里没有对应列，
 * confirm 时只取 name / steps / rework_routes / scoring / autonomy）。
 */
export function parseWorkflowText(text) {
  const source = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (source === '') throw new TypeError('text 必须是非空字符串');

  const clauses = source.split(CLAUSE_SPLIT).map((s) => s.trim()).filter(Boolean);
  const targetScore = parseTargetScore(source);

  const found = [];
  for (const def of STEP_DEFS) {
    const clause = findClause(clauses, def.patterns);
    if (!clause) continue;
    const { actor, collaborators } = resolveActors(def, clause);
    found.push({ def, clause, actor, collaborators });
  }

  const steps = found.map(({ def, clause, actor, collaborators }, i) => {
    const id = String(i + 1).padStart(2, '0');
    return {
      id,
      key: def.key,
      short: def.short,
      name: def.key === 'test' && actor === 'user' ? '自测' : def.name,
      actor,
      fallback_actor: def.fallback_actor && actor === def.actor ? def.fallback_actor : undefined,
      collaborators,
      outputs: [...def.outputs],
      gate: resolveGate(def, clause, targetScore),
    };
  });

  // 草稿对外不带内部 key/short（它们只用于 summary 与路由），
  // 但 steps 数组里保留会污染模板 JSON —— 统一剥掉。
  const publicSteps = steps.map(({ key, short, ...step }) => {
    const out = { ...step };
    if (out.fallback_actor === undefined) delete out.fallback_actor;
    return out;
  });

  const stepsByKey = Object.fromEntries(steps.map((s) => [s.key, s]));
  const reworkRoutes = parseReworkRoutes(source, stepsByKey, clauses);
  const scoring = parseScoring(source);
  const autonomy = {};

  const missing = [];
  for (const def of STEP_DEFS) {
    if (!stepsByKey[def.key]) missing.push(`没识别到「${def.short}」环节，草稿里没有这一步`);
  }
  if (!targetScore) missing.push('没识别到目标分（例如「8 分」），评审的分数判据先留成通用描述');
  if (Object.keys(reworkRoutes).length === 0) missing.push('没识别到返工条件（例如「不到 8 分继续改」），reworkRoutes 先留空');
  if (Object.keys(scoring).length === 0) missing.push('没识别到评分维度权重（scoring 先留空，不替你编）');
  if (Object.keys(autonomy).length === 0) missing.push('没识别到自主决策边界（autonomy 先留空）');
  if (!ROLE_PATTERNS.some((r) => r.re.test(source))) missing.push('没识别到具体执行角色，步骤按默认角色填');

  const hash = createHash('sha1').update(source).digest('hex').slice(0, 8);
  const draft = {
    template_id: `nl-${hash}`,
    name: '口述流程',
    version: 1,
    steps: publicSteps,
    rework_routes: reworkRoutes,
    scoring,
    autonomy,
    target_score: targetScore ? targetScore.value : null,
    target_score_text: targetScore ? targetScore.text : null,
  };

  const summary = buildSummary({ steps, targetScore, routes: reworkRoutes });
  return { draft, summary, missing };
}
