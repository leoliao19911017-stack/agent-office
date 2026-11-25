// workflow-engine.mjs — P0 第三步：工作流执行状态机（九步推进 + 人工决策点 + 返工路由）。
//
// 依据：docs/工作流定义-v3-定稿.md 第一、二、五节。
// 数据层在 workflow-db.mjs（只存不判），本文件负责「按步骤定义推进 / 卡在 gate /
// 按模板的 rework_routes 返工」；HTTP 在 api-workflow-runs.mjs。
//
// 四条硬约定：
// 1. 步骤顺序以模板 steps 数组为准，不按 step_id 排序 —— 模板允许步骤可增减（§四①）。
// 2. 当前步骤的 gate 不满足 → run.status = waiting_human，status_reason 写清在等谁、等什么；
//    本轮不推进，由人在 /approve 上放行。
// 3. 返工目标只从模板 rework_routes 读，本文件不写死「一律回 05」。
// 4. requirement_baseline 写入后本文件没有任何路径会改它（W14）。
import { getDb } from './db.mjs';
import {
  getWorkflowRun,
  getWorkflowRunStep,
  getWorkflowTemplate,
  getWorkflowTemplateVersion,
  insertWorkflowRun,
  insertWorkflowRunStep,
  listWorkflowRunSteps,
  listWorkflowRuns,
  setWorkflowRunCurrentStep,
  updateWorkflowRunStatus,
  updateWorkflowRunStep,
} from './workflow-db.mjs';

/** 状态机错误：带上 HTTP 语义，API 层直接转状态码，不在路由里猜。 */
export class WorkflowEngineError extends Error {
  constructor(statusCode, code, message, details = {}) {
    super(message);
    this.name = 'WorkflowEngineError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

function fail(statusCode, code, message, details) {
  throw new WorkflowEngineError(statusCode, code, message, details);
}

function nowIso() {
  return new Date().toISOString();
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stepDefsOf(template) {
  const steps = parseJson(template.steps);
  if (!Array.isArray(steps) || steps.length === 0) {
    fail(500, 'TEMPLATE_BROKEN', `模板 ${template.template_id} 的 steps 不是非空数组`);
  }
  return steps;
}

function routesOf(template) {
  const routes = parseJson(template.rework_routes);
  return routes && typeof routes === 'object' && !Array.isArray(routes) ? routes : {};
}

function autonomyOf(template) {
  const auto = parseJson(template.autonomy);
  return auto && typeof auto === 'object' && !Array.isArray(auto) ? auto : {};
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];
}

/**
 * gate 四分类（任务书 A）：
 *   user_done / user_approval → 人来做 / 人来确认
 *   auto                      → 前面完成就过
 *   其余（判据表达式）          → criteria，如 score >= target
 * 兼容模板里 gate 写成自由文本的情况：只有显式 user_* / auto 才归人/自动。
 */
export function classifyGate(gate) {
  const raw = String(gate ?? '').trim();
  const lower = raw.toLowerCase();
  if (lower === 'user_done' || lower === 'user') return 'user_done';
  if (lower === 'user_approval' || lower === 'human_approval') return 'user_approval';
  if (lower === '' || lower === 'auto' || lower.startsWith('auto_') || lower.startsWith('auto ')) return 'auto';
  return 'criteria';
}

/**
 * 判断当前步骤的 gate 是否满足。
 *
 * opts（全部可选）：
 *   approved / humanDone   人已确认（approve 端点与 advance 都收）
 *   criteria: true         调用方声明判据已满足（用于不是分数的判据）
 *   score                  评审得分；gate 含 "score >= target" 时据此判断
 *   hardCriteriaPass       false 表示硬性验收未全过（与 score 并列时一票否决）
 *
 * 返回 { type, satisfied, reason }；不满足时 reason 就是给 Leo 看的原因。
 */
export function evaluateGate({ run, stepDef, opts = {} }) {
  const gate = stepDef.gate;
  const type = classifyGate(gate);
  const approved = opts.approved === true || opts.humanDone === true || opts.human_done === true;

  if (approved) {
    return { type, satisfied: true, reason: 'Leo 已确认', approved: true };
  }
  if (type === 'auto') {
    return { type, satisfied: true, reason: '自动通过（前置步骤已完成）' };
  }
  if (type === 'user_done') {
    return {
      type,
      satisfied: false,
      needs_human: true,
      reason: `等待 Leo：第 ${stepDef.id} 步「${stepDef.name}」还没说完成`,
    };
  }
  if (type === 'user_approval') {
    return {
      type,
      satisfied: false,
      needs_human: true,
      reason: `等待 Leo 确认：第 ${stepDef.id} 步「${stepDef.name}」需要你点头才放行`,
    };
  }

  // criteria：先看调用方有没有直接声明满足，再看是否是分数判据。
  if (opts.criteria === true) {
    return { type, satisfied: true, reason: '判据已满足（调用方确认）' };
  }
  if (/score\s*>=\s*target/i.test(String(gate))) {
    if (typeof opts.score !== 'number' || !Number.isFinite(opts.score)) {
      return {
        type,
        satisfied: false,
        needs_human: true,
        reason: `等待评审结果：第 ${stepDef.id} 步判据是「${gate}」，还需要分数`,
      };
    }
    if (run.target_score === null || run.target_score === undefined) {
      return {
        type,
        satisfied: false,
        needs_human: true,
        reason: '没有设目标分（target_score），无法判断 score >= target',
      };
    }
    if (opts.hardCriteriaPass === false) {
      return {
        type,
        satisfied: false,
        needs_human: true,
        reason: `硬性验收未全过，即使 ${opts.score} 分也不能放行`,
      };
    }
    if (opts.score < run.target_score) {
      return {
        type,
        satisfied: false,
        needs_human: true,
        reason: `评审 ${opts.score} 分，未达到目标分 ${run.target_score}`,
      };
    }
    return {
      type,
      satisfied: true,
      reason: `评审 ${opts.score} 分，达到目标分 ${run.target_score}，且硬性验收已过`,
    };
  }
  return {
    type,
    satisfied: false,
    needs_human: true,
    reason: `等待第 ${stepDef.id} 步判据满足：${gate}`,
  };
}

/**
 * autonomy 决策分界线（任务书 D）：从模板读，不写死。
 * - must_ask 里的动作 → 403，消息必须带「需要 Leo 批准」；
 * - self_decide 里的动作 → 引擎可直接做；
 * - 两边都没有的动作 → 400（模板没授权，不擅自做）。
 * action 为空表示本次调用没有请求动作，直接放行。
 */
export function assertAutonomy(template, action) {
  if (action === undefined || action === null || action === '') return null;
  if (typeof action !== 'string') {
    fail(400, 'BAD_ACTION', 'action 必须是字符串');
  }
  const auto = autonomyOf(template);
  const selfDecide = stringList(auto.self_decide);
  const mustAsk = stringList(auto.must_ask);
  if (mustAsk.includes(action)) {
    fail(403, 'NEEDS_LEO_APPROVAL', `需要 Leo 批准：${action}`, { action, must_ask: mustAsk });
  }
  if (selfDecide.includes(action)) {
    return { action, decision: 'self_decide' };
  }
  fail(400, 'UNKNOWN_ACTION', `模板 autonomy 未授权动作：${action}`, {
    action,
    self_decide: selfDecide,
    must_ask: mustAsk,
  });
}

// 失败原因的常见别名：模板里可能叫 external_env_failure，调用方写 env_failure 也认。
const CAUSE_ALIASES = {
  env_failure: 'external_env_failure',
  environment_failure: 'external_env_failure',
  external_environment_failure: 'external_env_failure',
  quota: 'quota_exhausted',
  criteria_mismatch: 'review_criteria_mismatch',
  review_mismatch: 'review_criteria_mismatch',
  agent_insufficient: 'agent_capability',
};

function resolveFailureCause(routes, cause) {
  if (Object.prototype.hasOwnProperty.call(routes, cause)) return cause;
  const alias = CAUSE_ALIASES[cause];
  if (alias && Object.prototype.hasOwnProperty.call(routes, alias)) return alias;
  return null;
}

function normalizeBaseline(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && !Array.isArray(value)) return JSON.stringify(value);
  fail(400, 'BAD_REQUIREMENT_BASELINE', 'requirementBaseline 必须是字符串、对象或 null');
}

function normalizeTitle(title, template) {
  if (title === undefined || title === null) return `${template.name} 运行`;
  if (typeof title !== 'string' || title.trim() === '') {
    fail(400, 'BAD_TITLE', 'title 必须是非空字符串');
  }
  return title.trim();
}

function normalizeTargetScore(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(400, 'BAD_TARGET_SCORE', 'targetScore 必须是非负数字或 null');
  }
  return value;
}

/** 交付物只收非空字符串（数据层 artifacts 是 JSON 字符串数组）。 */
function normalizeArtifacts(input) {
  const list = typeof input === 'string' ? [input] : input;
  if (!Array.isArray(list) || list.length === 0) {
    fail(400, 'BAD_ARTIFACTS', 'artifacts 必须是非空字符串或非空字符串数组');
  }
  for (const item of list) {
    if (typeof item !== 'string' || item.trim() === '') {
      fail(400, 'BAD_ARTIFACTS', 'artifacts 的每一项都必须是非空字符串');
    }
  }
  return list;
}

/**
 * 创建执行引擎。db 显式注入（测试用内存库 / 服务用 getDb 单例）。
 * 返回的函数签名与任务书一致：advanceStep(runId, opts) / createRun(templateId, opts) …
 */
export function createWorkflowEngine(db = getDb()) {
  if (!db) throw new TypeError('createWorkflowEngine 需要 db');

  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* 回滚失败不掩盖原错误 */ }
      throw err;
    }
  }

  function loadRunAndTemplate(runId) {
    if (typeof runId !== 'string' || runId.trim() === '') {
      fail(400, 'BAD_RUN_ID', 'runId 必须是非空字符串');
    }
    const run = getWorkflowRun(db, runId);
    if (!run) fail(404, 'RUN_NOT_FOUND', `run 不存在：${runId}`, { run_id: runId });
    const template =
      getWorkflowTemplateVersion(db, run.template_id, run.template_version) ??
      getWorkflowTemplate(db, run.template_id);
    if (!template) fail(404, 'TEMPLATE_NOT_FOUND', `run 引用的模板不存在：${run.template_id}`);
    return { run, template, defs: stepDefsOf(template) };
  }

  function stepRows(runId) {
    return listWorkflowRunSteps(db, runId);
  }

  function currentOf(run, defs, rows) {
    const id = run.current_step ?? rows.find((r) => r.status === 'running')?.step_id ?? null;
    const def = defs.find((d) => d.id === id);
    if (!def) return null;
    const row = rows.find((r) => r.step_id === id) ?? null;
    return { def, row, index: defs.indexOf(def) };
  }

  /**
   * run 的完整状态：
   * 当前第几步 / 每步状态 / 每步交付物 / 目标分 / 是否在等 Leo。
   */
  function getRunState(runId) {
    if (typeof runId !== 'string' || runId.trim() === '') {
      fail(400, 'BAD_RUN_ID', 'runId 必须是非空字符串');
    }
    const run = getWorkflowRun(db, runId);
    if (!run) return null;
    const template =
      getWorkflowTemplateVersion(db, run.template_id, run.template_version) ??
      getWorkflowTemplate(db, run.template_id);
    if (!template) fail(404, 'TEMPLATE_NOT_FOUND', `run 引用的模板不存在：${run.template_id}`);
    const defs = stepDefsOf(template);
    const rows = stepRows(runId);
    const rowById = new Map(rows.map((r) => [r.step_id, r]));

    const steps = defs.map((def, i) => {
      const row = rowById.get(def.id) ?? null;
      return {
        step_id: def.id,
        index: i + 1,
        name: def.name,
        actor: def.actor ?? null,
        fallback_actor: def.fallback_actor ?? null,
        collaborators: Array.isArray(def.collaborators) ? def.collaborators : [],
        outputs: Array.isArray(def.outputs) ? def.outputs : [],
        gate: def.gate ?? null,
        gate_type: classifyGate(def.gate),
        status: row ? row.status : 'pending',
        entered_at: row ? row.entered_at : null,
        exited_at: row ? row.exited_at : null,
        gate_result: row && row.gate_result ? parseJson(row.gate_result) ?? row.gate_result : null,
        artifacts: row ? parseJson(row.artifacts) ?? [] : [],
      };
    });

    const currentId =
      run.current_step ?? steps.find((s) => s.status === 'running')?.step_id ?? null;
    const current = steps.find((s) => s.step_id === currentId) ?? null;
    const done = steps.filter((s) => s.status === 'done').length;

    return {
      run_id: run.run_id,
      template_id: run.template_id,
      template_version: run.template_version,
      title: run.title,
      status: run.status,
      status_reason: run.status_reason,
      // current_step 与数据层同义（步骤号字符串），当前步详情放 current_step_detail。
      current_step: current ? current.step_id : null,
      current_step_id: current ? current.step_id : null,
      current_step_detail: current,
      step_index: current ? current.index : null,
      total_steps: steps.length,
      requirement_baseline: run.requirement_baseline,
      target_score: run.target_score,
      waiting_for_leo: run.status === 'waiting_human',
      needs_switch_agent: run.status === 'switch_agent',
      progress: {
        done,
        total: steps.length,
        percent: steps.length === 0 ? 0 : Math.round((done / steps.length) * 100),
      },
      steps,
      created_at: run.created_at,
      updated_at: run.updated_at,
      // 归档是独立的一列，和 status 无关（run 可以 status 仍是 running 但已被归档）。
      // 看板的工作流下拉靠它把已归档的 run 筛掉；以前没带出来，前端无从判断。
      archived_at: run.archived_at ?? null,
    };
  }

  /** 列表摘要（含当前步骤、状态），不给整份 steps 交付物。 */
  function listRunStates(filters = {}) {
    return listWorkflowRuns(db, filters).map((run) => {
      const state = getRunState(run.run_id);
      return {
        run_id: state.run_id,
        template_id: state.template_id,
        template_version: state.template_version,
        title: state.title,
        status: state.status,
        status_reason: state.status_reason,
        archived_at: state.archived_at,
        current_step_id: state.current_step_id,
        current_step_name: state.current_step_detail ? state.current_step_detail.name : null,
        current_step_status: state.current_step_detail ? state.current_step_detail.status : null,
        step_index: state.step_index,
        total_steps: state.total_steps,
        target_score: state.target_score,
        waiting_for_leo: state.waiting_for_leo,
        progress: state.progress,
        created_at: state.created_at,
        updated_at: state.updated_at,
      };
    });
  }

  /**
   * 建 run + 按模板建九条 step（全部 pending），第一条 running。
   * requirementBaseline 一旦写入，后续 advance / rework 都不会碰它。
   */
  function createRun(templateId, opts = {}) {
    if (typeof templateId !== 'string' || templateId.trim() === '') {
      fail(400, 'BAD_TEMPLATE_ID', 'templateId 必须是非空字符串');
    }
    const template = getWorkflowTemplate(db, templateId);
    if (!template) {
      fail(404, 'TEMPLATE_NOT_FOUND', `模板不存在：${templateId}`, { template_id: templateId });
    }
    const defs = stepDefsOf(template);
    const title = normalizeTitle(opts.title, template);
    const requirementBaseline = normalizeBaseline(opts.requirementBaseline);
    const targetScore = normalizeTargetScore(opts.targetScore);
    const at = nowIso();

    return tx(() => {
      const run = insertWorkflowRun(db, {
        templateId,
        templateVersion: template.version,
        title,
        currentStep: defs[0].id,
        status: 'running',
        statusReason: null,
        requirementBaseline,
        targetScore,
        createdAt: at,
        updatedAt: at,
      });
      defs.forEach((def, i) => {
        insertWorkflowRunStep(db, {
          runId: run.run_id,
          stepId: def.id,
          status: i === 0 ? 'running' : 'pending',
          enteredAt: i === 0 ? at : null,
        });
      });
      return getRunState(run.run_id);
    });
  }

  function finishStepAndMoveOn(run, defs, current, gateResult) {
    const at = nowIso();
    updateWorkflowRunStep(db, current.row.run_step_id, {
      status: 'done',
      exitedAt: at,
      gateResult: JSON.stringify(gateResult),
    });
    const nextDef = defs[current.index + 1];
    if (!nextDef) {
      updateWorkflowRunStatus(db, run.run_id, 'completed', {
        statusReason: '九步全部完成',
      });
      return { advanced: true, completed: true };
    }
    const nextRow = stepRows(run.run_id).find((r) => r.step_id === nextDef.id);
    if (nextRow) {
      updateWorkflowRunStep(db, nextRow.run_step_id, {
        status: 'running',
        enteredAt: at,
        exitedAt: null,
        gateResult: null,
      });
    } else {
      insertWorkflowRunStep(db, { runId: run.run_id, stepId: nextDef.id, status: 'running', enteredAt: at });
    }
    updateWorkflowRunStatus(db, run.run_id, 'running', { statusReason: null });
    setWorkflowRunCurrentStep(db, run.run_id, nextDef.id);
    return { advanced: true, completed: false, next_step_id: nextDef.id };
  }

  function assertAdvanceable(run) {
    if (run.status === 'completed') {
      fail(409, 'RUN_COMPLETED', '这个 run 已经完成，不能再推进');
    }
    if (run.status === 'archived') {
      fail(409, 'RUN_ARCHIVED', '这个 run 已归档，不能再推进');
    }
    if (run.status === 'failed') {
      fail(409, 'RUN_FAILED', '这个 run 有步骤失败，先 POST /rework 按原因返工');
    }
    if (run.status === 'blocked') {
      fail(409, 'RUN_BLOCKED', run.status_reason || '这个 run 被阻塞，解放后再推进');
    }
    if (run.status === 'switch_agent') {
      fail(409, 'NEEDS_SWITCH_AGENT', run.status_reason || '这个 run 需要换 Agent 后才能继续');
    }
  }

  /**
   * 推进到下一步。
   * - gate 满足：当前步骤 done，下一步 running，run 回到 running；
   * - gate 不满足：run → waiting_human，status_reason 写明在等什么，步骤保持 running，
   *   返回 { advanced:false, gate, state }，API 层转 409。
   */
  function advanceStep(runId, opts = {}) {
    const { run, template, defs } = loadRunAndTemplate(runId);
    assertAutonomy(template, opts.action);
    assertAdvanceable(run);

    const rows = stepRows(runId);
    const current = currentOf(run, defs, rows);
    if (!current) fail(409, 'NO_CURRENT_STEP', 'run 没有当前步骤，状态异常');
    if (!current.row) fail(500, 'STEP_ROW_MISSING', `run 缺少步骤行：${current.def.id}`);
    if (current.row.status === 'failed') {
      fail(409, 'STEP_FAILED', `第 ${current.def.id} 步已失败，先 POST /rework 返工`);
    }
    if (current.row.status === 'pending') {
      // 理论不该出现；把它拉起来而不是空转。
      updateWorkflowRunStep(db, current.row.run_step_id, { status: 'running', enteredAt: nowIso() });
      current.row = getWorkflowRunStep(db, current.row.run_step_id);
    }

    const gate = evaluateGate({ run, stepDef: current.def, opts });
    if (!gate.satisfied) {
      const at = nowIso();
      return tx(() => {
        updateWorkflowRunStep(db, current.row.run_step_id, {
          gateResult: JSON.stringify({
            gate: current.def.gate,
            gate_type: gate.type,
            status: 'waiting',
            reason: gate.reason,
            at,
          }),
        });
        updateWorkflowRunStatus(db, run.run_id, 'waiting_human', { statusReason: gate.reason });
        return { advanced: false, gate, state: getRunState(run.run_id) };
      });
    }

    const result = tx(() => {
      const move = finishStepAndMoveOn(run, defs, current, {
        gate: current.def.gate,
        gate_type: gate.type,
        status: 'passed',
        reason: gate.reason,
        at: nowIso(),
      });
      return { ...move, state: getRunState(run.run_id) };
    });
    return { advanced: true, gate, ...result };
  }

  /**
   * 人在 gate 上确认放行：当前步骤直接 done（无论 gate 是人还是判据），
   * 下一步 running；最后一步确认完 → status=completed。
   */
  function approve(runId, opts = {}) {
    const { run, template, defs } = loadRunAndTemplate(runId);
    assertAutonomy(template, opts.action);
    assertAdvanceable(run);

    const rows = stepRows(runId);
    const current = currentOf(run, defs, rows);
    if (!current) fail(409, 'NO_CURRENT_STEP', 'run 没有当前步骤，状态异常');
    if (!current.row) fail(500, 'STEP_ROW_MISSING', `run 缺少步骤行：${current.def.id}`);
    if (current.row.status === 'failed') {
      fail(409, 'STEP_FAILED', `第 ${current.def.id} 步已失败，先 POST /rework 返工`);
    }

    const approvedBy = typeof opts.by === 'string' && opts.by.trim() ? opts.by.trim() : 'leo';
    const note = typeof opts.note === 'string' ? opts.note : null;
    const gate = evaluateGate({ run, stepDef: current.def, opts: { ...opts, approved: true } });

    return tx(() => {
      const move = finishStepAndMoveOn(run, defs, current, {
        gate: current.def.gate,
        gate_type: gate.type,
        status: 'approved',
        by: approvedBy,
        note,
        reason: gate.reason,
        at: nowIso(),
      });
      return { advanced: true, approved: true, ...move, state: getRunState(run.run_id) };
    });
  }

  /** 往某步挂交付物，追加去重；不改步骤状态。 */
  function recordArtifact(runId, stepId, artifacts) {
    if (typeof stepId !== 'string' || stepId.trim() === '') {
      fail(400, 'BAD_STEP_ID', 'stepId 必须是非空字符串');
    }
    const { defs } = loadRunAndTemplate(runId);
    if (!defs.some((d) => d.id === stepId)) {
      fail(404, 'STEP_NOT_FOUND', `run 里没有第 ${stepId} 步`, { run_id: runId, step_id: stepId });
    }
    const rows = stepRows(runId);
    const row = rows.find((r) => r.step_id === stepId);
    if (!row) fail(404, 'STEP_NOT_FOUND', `run 里没有第 ${stepId} 步`, { run_id: runId, step_id: stepId });

    const incoming = normalizeArtifacts(artifacts);
    const existing = parseJson(row.artifacts) ?? [];
    const merged = [...existing];
    for (const item of incoming) {
      if (!merged.includes(item)) merged.push(item);
    }
    updateWorkflowRunStep(db, row.run_step_id, { artifacts: merged });
    return { step_id: stepId, artifacts: merged, state: getRunState(runId) };
  }

  /** 某步失败：步骤 failed，run failed，原因写进 status_reason。路由由 rework 决定。 */
  function failStep(runId, stepId, reason) {
    if (typeof stepId !== 'string' || stepId.trim() === '') {
      fail(400, 'BAD_STEP_ID', 'stepId 必须是非空字符串');
    }
    if (typeof reason !== 'string' || reason.trim() === '') {
      fail(400, 'BAD_FAILURE_REASON', 'reason 必须是非空字符串');
    }
    const { run, defs } = loadRunAndTemplate(runId);
    if (run.status === 'completed') fail(409, 'RUN_COMPLETED', '已完成的 run 不能再标失败');
    const def = defs.find((d) => d.id === stepId);
    if (!def) fail(404, 'STEP_NOT_FOUND', `run 里没有第 ${stepId} 步`, { run_id: runId, step_id: stepId });
    const row = stepRows(runId).find((r) => r.step_id === stepId);
    if (!row) fail(404, 'STEP_NOT_FOUND', `run 里没有第 ${stepId} 步`, { run_id: runId, step_id: stepId });
    if (row.status === 'done') {
      fail(409, 'STEP_ALREADY_DONE', `第 ${stepId} 步已经是 done，不能标失败`);
    }

    const at = nowIso();
    return tx(() => {
      updateWorkflowRunStep(db, row.run_step_id, {
        status: 'failed',
        exitedAt: at,
        gateResult: JSON.stringify({ status: 'failed', reason: reason.trim(), at }),
      });
      updateWorkflowRunStatus(db, run.run_id, 'failed', {
        statusReason: `第 ${stepId} 步「${def.name}」失败：${reason.trim()}`,
      });
      return { step_id: stepId, reason: reason.trim(), state: getRunState(runId) };
    });
  }

  function setStepStatus(row, patch) {
    updateWorkflowRunStep(db, row.run_step_id, patch);
  }

  /**
   * 按失败原因路由返工。路由表来自模板 rework_routes：
   * - 目标是步骤 id → 回到该步（该步及之后重置，目标 running）；
   * - switch_agent → run.status=switch_agent，不推进，标记需换人；
   * - pause / pause_or_switch → run.status=blocked；
   * - resume → run.status=blocked（等环境恢复后继续）。
   */
  function rework(runId, failureCause, opts = {}) {
    const { run, template, defs } = loadRunAndTemplate(runId);
    assertAutonomy(template, opts.action);
    if (run.status !== 'failed') {
      fail(409, 'RUN_NOT_FAILED', `只有 failed 的 run 才需要返工，当前是 ${run.status}`);
    }
    if (typeof failureCause !== 'string' || failureCause.trim() === '') {
      fail(400, 'BAD_FAILURE_CAUSE', 'failureCause 必须是非空字符串');
    }
    const cause = failureCause.trim();
    const routes = routesOf(template);
    const resolved = resolveFailureCause(routes, cause);
    if (!resolved) {
      fail(400, 'UNKNOWN_FAILURE_CAUSE', `模板没有配置失败原因「${cause}」的返工路由`, {
        failure_cause: cause,
        available: Object.keys(routes),
      });
    }
    const target = routes[resolved];
    const targetLower = String(target).toLowerCase();
    const failedRows = stepRows(runId).filter((r) => r.status === 'failed');
    const failedStepId = failedRows.length > 0 ? failedRows[failedRows.length - 1].step_id : null;
    const failedDef = defs.find((d) => d.id === failedStepId) || null;
    const at = nowIso();

    // 特殊动作（不是步骤号）
    if (targetLower === 'switch_agent') {
      // 换人是 autonomy 里的动作：must_ask 优先拦，self_decide 才自动做。
      const auto = autonomyOf(template);
      const mustAsk = stringList(auto.must_ask);
      const selfDecide = stringList(auto.self_decide);
      if (mustAsk.includes('switch_agent')) {
        fail(403, 'NEEDS_LEO_APPROVAL', '需要 Leo 批准：switch_agent', { action: 'switch_agent' });
      }
      const reason = `第 ${failedStepId ?? '?'} 步${failedDef ? `「${failedDef.name}」` : ''} Agent 能力不足：需要换人重做（switch_agent）`;
      const state = tx(() => {
        updateWorkflowRunStatus(db, run.run_id, 'switch_agent', { statusReason: reason });
        return getRunState(run.run_id);
      });
      return {
        routed: true,
        action: 'switch_agent',
        needs_switch_agent: true,
        self_decided: selfDecide.includes('switch_agent'),
        failure_cause: resolved,
        from_step: failedStepId,
        state,
      };
    }
    if (targetLower === 'pause_or_switch' || targetLower === 'pause') {
      const reason = `第 ${failedStepId ?? '?'} 步暂停：额度耗尽，等额度恢复或换 Agent 后再继续`;
      const state = tx(() => {
        updateWorkflowRunStatus(db, run.run_id, 'blocked', { statusReason: reason });
        return getRunState(run.run_id);
      });
      return { routed: true, action: 'pause', failure_cause: resolved, from_step: failedStepId, state };
    }
    if (targetLower === 'resume') {
      const reason = `第 ${failedStepId ?? '?'} 步受阻：外部环境故障，环境恢复后继续`;
      const state = tx(() => {
        updateWorkflowRunStatus(db, run.run_id, 'blocked', { statusReason: reason });
        return getRunState(run.run_id);
      });
      return { routed: true, action: 'resume', failure_cause: resolved, from_step: failedStepId, state };
    }

    // 步骤号路由
    const targetIndex = defs.findIndex((d) => d.id === target);
    if (targetIndex === -1) {
      fail(500, 'BAD_REWORK_ROUTE', `模板把「${resolved}」路由到了不存在的步骤：${target}`);
    }
    const rows = stepRows(runId);
    const rowById = new Map(rows.map((r) => [r.step_id, r]));

    const state = tx(() => {
      defs.forEach((def, i) => {
        const row = rowById.get(def.id);
        if (!row) return;
        if (i === targetIndex) {
          setStepStatus(row, {
            status: 'running',
            enteredAt: at,
            exitedAt: null,
            gateResult: JSON.stringify({
              status: 'rework',
              failure_cause: resolved,
              from_step: failedStepId,
              at,
            }),
          });
          return;
        }
        if (i > targetIndex && row.status !== 'pending') {
          setStepStatus(row, { status: 'pending', enteredAt: null, exitedAt: null, gateResult: null });
          return;
        }
        if (i < targetIndex && (row.status === 'failed' || row.status === 'running')) {
          // 失败点被路由绕过去了，或步骤还没做完就被跳到后面 —— 标 skipped，不冒充完成。
          setStepStatus(row, {
            status: 'skipped',
            exitedAt: at,
            gateResult: JSON.stringify({ status: 'skipped', failure_cause: resolved, at }),
          });
        }
      });
      updateWorkflowRunStatus(db, run.run_id, 'running', { statusReason: null });
      setWorkflowRunCurrentStep(db, run.run_id, target);
      return getRunState(run.run_id);
    });

    return {
      routed: true,
      action: 'jump_to_step',
      target_step_id: target,
      failure_cause: resolved,
      from_step: failedStepId,
      state,
    };
  }

  return {
    createRun,
    getRunState,
    listRunStates,
    advanceStep,
    approve,
    recordArtifact,
    failStep,
    rework,
  };
}

// 模块级默认引擎：API 与临时脚本可直接 `import { advanceStep } from './workflow-engine.mjs'`。
// 懒加载 —— 只 import 本模块不应该顺手打开生产库（测试尤其需要这一点）。
let defaultEngine = null;
function engine() {
  if (!defaultEngine) defaultEngine = createWorkflowEngine();
  return defaultEngine;
}

export const createRun = (...args) => engine().createRun(...args);
export const getRunState = (...args) => engine().getRunState(...args);
export const listRunStates = (...args) => engine().listRunStates(...args);
export const advanceStep = (...args) => engine().advanceStep(...args);
export const approve = (...args) => engine().approve(...args);
export const recordArtifact = (...args) => engine().recordArtifact(...args);
export const failStep = (...args) => engine().failStep(...args);
export const rework = (...args) => engine().rework(...args);
