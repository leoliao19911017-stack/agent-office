// workflow-db.mjs — 工作流数据层读写函数（P0 第一步）。
//
// 三张表由 web/lib/db.mjs 的 v6 迁移创建（schema 在 workflow-schema.mjs）。
// 本文件只做"存与取"，不做执行状态机、不做 API、不做界面 —— 那分别是第二、三步。
//
// 约定沿用 web/lib/db.mjs：
// - 时间戳是 TEXT，ISO 8601 字符串；查询排序按字符串比较，ISO 格式天然保序；
// - JSON 字段以 JSON 字符串落库，查询函数原样返回字符串，读取方自行 parse；
// - 查无返回 null / 空数组，不编数据；
// - 枚举值在写入函数里校验，不靠 SQLite CHECK 兜底。
//
// 注意：requirement_baseline 是 Leo 确认过的需求快照，后续不许改。
// 本文件刻意不提供任何能更新该列的写入函数 —— 不是忘了，是约束。
import { randomUUID } from 'node:crypto';
import { RUN_STATUSES, RUN_STEP_STATUSES } from './workflow-schema.mjs';

// node:sqlite 返回 null-prototype 对象，转成普通对象便于断言/序列化。
function one(db, sql, params = []) {
  const row = db.prepare(sql).get(...params);
  return row ? { ...row } : null;
}

function many(db, sql, params = []) {
  return db.prepare(sql).all(...params).map((r) => ({ ...r }));
}

// ---------------------------------------------------------------------------
// 入参校验（错误口径与 web/lib 其它模块一致：类型错 TypeError，枚举/范围错 RangeError）
// ---------------------------------------------------------------------------

function assertNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} 必须是非空字符串`);
  }
}

function assertOptionalString(value, field) {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw new TypeError(`${field} 必须是字符串或 null`);
  }
}

function assertPlainObject(value, field) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} 必须是对象`);
  }
}

function assertStringArray(value, field, { allowEmpty = true } = {}) {
  if (!Array.isArray(value)) throw new TypeError(`${field} 必须是数组`);
  if (!allowEmpty && value.length === 0) throw new TypeError(`${field} 不能为空数组`);
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new TypeError(`${field} 的每一项都必须是非空字符串`);
    }
  }
}

function assertPositiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${field} 必须是正整数，收到：${value}`);
  }
}

/** ISO 时间入参归一：Date / epoch 毫秒 / ISO 字符串都收，null/undefined 原样返回。 */
function isoOrNull(value, field) {
  if (value === undefined || value === null) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new TypeError(`${field} 必须是 Date / epoch 毫秒 / ISO 字符串，收到：${value}`);
  }
  return d.toISOString();
}

/** 当前时刻 ISO 字符串。 */
function nowIso() {
  return new Date().toISOString();
}

/**
 * 校验模板的四个 JSON 字段。steps 是模板的骨架，不能为空；
 * 其余三个允许缺省（落库为 '{}'），但给了就必须是对的形状。
 */
function normalizeTemplateJson(template) {
  const { steps, reworkRoutes, scoring, autonomy } = template;
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new TypeError('template.steps 必须是非空数组');
  }
  steps.forEach((step, i) => {
    if (typeof step !== 'object' || step === null || Array.isArray(step)) {
      throw new TypeError(`template.steps[${i}] 必须是对象`);
    }
    assertNonEmptyString(step.id, `template.steps[${i}].id`);
    assertNonEmptyString(step.name, `template.steps[${i}].name`);
    assertNonEmptyString(step.actor, `template.steps[${i}].actor`);
    assertNonEmptyString(step.gate, `template.steps[${i}].gate`);
    assertStringArray(step.outputs, `template.steps[${i}].outputs`, { allowEmpty: false });
    if (step.collaborators !== undefined) {
      assertStringArray(step.collaborators, `template.steps[${i}].collaborators`);
    }
    if (step.fallback_actor !== undefined) {
      assertNonEmptyString(step.fallback_actor, `template.steps[${i}].fallback_actor`);
    }
  });

  const routes = reworkRoutes ?? {};
  assertPlainObject(routes, 'template.reworkRoutes');
  for (const [reason, target] of Object.entries(routes)) {
    assertNonEmptyString(reason, 'template.reworkRoutes 的失败原因键');
    assertNonEmptyString(target, `template.reworkRoutes.${reason}`);
  }

  const score = scoring ?? {};
  assertPlainObject(score, 'template.scoring');
  for (const [key, weight] of Object.entries(score)) {
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) {
      throw new TypeError(`template.scoring.${key} 必须是非负数字`);
    }
  }

  const auto = autonomy ?? {};
  assertPlainObject(auto, 'template.autonomy');
  if (auto.self_decide !== undefined) assertStringArray(auto.self_decide, 'template.autonomy.self_decide');
  if (auto.must_ask !== undefined) assertStringArray(auto.must_ask, 'template.autonomy.must_ask');

  return {
    steps: JSON.stringify(steps),
    rework_routes: JSON.stringify(routes),
    scoring: JSON.stringify(score),
    autonomy: JSON.stringify(auto),
  };
}

// ---------------------------------------------------------------------------
// 模板（workflow_templates）
// ---------------------------------------------------------------------------

/**
 * 新建模板，返回落库后的完整行（四个 JSON 字段是字符串）。
 *
 * 入参 camelCase：templateId / name / version / steps / reworkRoutes / scoring / autonomy，
 * 可选 createdAt / updatedAt（Date / epoch 毫秒 / ISO，默认 now）。
 * templateId 缺省自动生成 UUID；version 缺省 1。
 */
export function insertWorkflowTemplate(db, template) {
  if (!template || typeof template !== 'object') throw new TypeError('template 必须是对象');
  assertNonEmptyString(template.name, 'template.name');
  if (template.version !== undefined) assertPositiveInteger(template.version, 'template.version');

  const json = normalizeTemplateJson(template);
  const now = nowIso();
  const row = {
    template_id:
      typeof template.templateId === 'string' && template.templateId ? template.templateId : randomUUID(),
    name: template.name.trim(),
    version: template.version ?? 1,
    ...json,
    created_at: isoOrNull(template.createdAt, 'template.createdAt') ?? now,
    updated_at: isoOrNull(template.updatedAt, 'template.updatedAt') ?? isoOrNull(template.createdAt, 'template.createdAt') ?? now,
  };
  db.prepare(
    'INSERT INTO workflow_templates (template_id, name, version, steps, rework_routes, scoring, autonomy, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    row.template_id,
    row.name,
    row.version,
    row.steps,
    row.rework_routes,
    row.scoring,
    row.autonomy,
    row.created_at,
    row.updated_at,
  );
  return getWorkflowTemplate(db, row.template_id);
}

/** 按 id 查模板，查无返回 null。 */
export function getWorkflowTemplate(db, templateId) {
  return one(db, 'SELECT * FROM workflow_templates WHERE template_id = ?', [templateId]);
}

/** 模板全量列表，按创建先后排序（同毫秒按 rowid 决胜，保证插入序稳定）。 */
export function listWorkflowTemplates(db) {
  return many(db, 'SELECT * FROM workflow_templates ORDER BY created_at, rowid');
}

/**
 * 列表用的模板摘要：不返回 steps 原文，只给步骤数和在用 run 数。
 * 排序口径与 listWorkflowTemplates 一致（创建先后）。
 */
export function listWorkflowTemplateSummaries(db) {
  return many(
    db,
    'SELECT t.template_id, t.name, t.version, t.steps, t.created_at, t.updated_at, ' +
      '(SELECT COUNT(*) FROM workflow_runs r WHERE r.template_id = t.template_id) AS run_count ' +
      'FROM workflow_templates t ORDER BY t.created_at, t.rowid',
  );
}

/** 某个模板被多少次 run 引用（含已归档 run —— 历史运行同样不许把模板删掉）。 */
export function countWorkflowRunsByTemplate(db, templateId) {
  assertNonEmptyString(templateId, 'templateId');
  const row = one(db, 'SELECT COUNT(*) AS n FROM workflow_runs WHERE template_id = ?', [templateId]);
  return row ? Number(row.n) : 0;
}

/** 模板的历史版本（不含当前版本），按版本号升序。 */
export function listWorkflowTemplateVersions(db, templateId) {
  assertNonEmptyString(templateId, 'templateId');
  return many(
    db,
    'SELECT * FROM workflow_template_versions WHERE template_id = ? ORDER BY version ASC',
    [templateId],
  );
}

/**
 * 按版本号取模板：version 等于当前版本时取 workflow_templates，
 * 否则取 workflow_template_versions；都查不到返回 null。
 */
export function getWorkflowTemplateVersion(db, templateId, version) {
  assertNonEmptyString(templateId, 'templateId');
  assertPositiveInteger(version, 'version');
  const current = getWorkflowTemplate(db, templateId);
  if (current && current.version === version) return current;
  return one(
    db,
    'SELECT * FROM workflow_template_versions WHERE template_id = ? AND version = ?',
    [templateId, version],
  );
}

/**
 * 更新模板：版本号 +1，更新前的完整定义先抄进历史表，旧版本不丢。
 *
 * patch 支持的字段：name / steps / reworkRoutes / scoring / autonomy；
 * 未传的字段沿用当前值。version 由本函数控制，调用方传了也忽略。
 * 查无模板返回 null（不写入）。
 */
export function updateWorkflowTemplate(db, templateId, patch = {}) {
  assertNonEmptyString(templateId, 'templateId');
  if (!patch || typeof patch !== 'object') throw new TypeError('patch 必须是对象');

  const current = getWorkflowTemplate(db, templateId);
  if (!current) return null;

  const next = {
    name: patch.name !== undefined ? patch.name : current.name,
    steps: patch.steps !== undefined ? patch.steps : JSON.parse(current.steps),
    reworkRoutes: patch.reworkRoutes !== undefined ? patch.reworkRoutes : JSON.parse(current.rework_routes),
    scoring: patch.scoring !== undefined ? patch.scoring : JSON.parse(current.scoring),
    autonomy: patch.autonomy !== undefined ? patch.autonomy : JSON.parse(current.autonomy),
  };
  // 与 insert 用同一套校验：更新不能成为绕过 schema 的后门。
  assertNonEmptyString(next.name, 'template.name');
  const json = normalizeTemplateJson(next);
  const now = nowIso();

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      'INSERT OR REPLACE INTO workflow_template_versions ' +
        '(template_id, version, name, steps, rework_routes, scoring, autonomy, created_at, updated_at, archived_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      current.template_id,
      current.version,
      current.name,
      current.steps,
      current.rework_routes,
      current.scoring,
      current.autonomy,
      current.created_at,
      current.updated_at,
      now,
    );
    db.prepare(
      'UPDATE workflow_templates SET name = ?, version = ?, steps = ?, rework_routes = ?, scoring = ?, ' +
        'autonomy = ?, updated_at = ? WHERE template_id = ?',
    ).run(
      next.name.trim(),
      current.version + 1,
      json.steps,
      json.rework_routes,
      json.scoring,
      json.autonomy,
      now,
      templateId,
    );
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* 回滚失败不掩盖原错误 */ }
    throw err;
  }
  return getWorkflowTemplate(db, templateId);
}

/**
 * 删除模板。有 run 在用就不删（返回 deleted:false + runCount），
 * 由 API 层转成 409；没有引用时连历史版本一起删。
 */
export function deleteWorkflowTemplate(db, templateId) {
  assertNonEmptyString(templateId, 'templateId');
  const current = getWorkflowTemplate(db, templateId);
  if (!current) return { deleted: false, notFound: true, runCount: 0 };
  const runCount = countWorkflowRunsByTemplate(db, templateId);
  if (runCount > 0) return { deleted: false, notFound: false, runCount };

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM workflow_template_versions WHERE template_id = ?').run(templateId);
    db.prepare('DELETE FROM workflow_templates WHERE template_id = ?').run(templateId);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* 回滚失败不掩盖原错误 */ }
    throw err;
  }
  return { deleted: true, notFound: false, runCount: 0 };
}

// ---------------------------------------------------------------------------
// 运行实例（workflow_runs）
// ---------------------------------------------------------------------------

/**
 * 新建一次流程运行，返回落库后的完整行。
 *
 * - templateId 必须能在 workflow_templates 里找到；templateVersion 缺省取模板当前 version
 *   （显式传入时以传入值为准——记录"这次运行用的是哪一版"，不随模板升级漂移）；
 * - status 缺省 running；
 * - requirementBaseline 是 Leo 确认过的需求快照，可为 null（01-03 步还没确认时），
 *   一旦写入，本文件没有任何函数能改它；
 * - targetScore 为 null 表示还没设目标分。
 */
export function insertWorkflowRun(db, run) {
  if (!run || typeof run !== 'object') throw new TypeError('run 必须是对象');
  assertNonEmptyString(run.templateId, 'run.templateId');
  assertNonEmptyString(run.title, 'run.title');
  assertOptionalString(run.currentStep, 'run.currentStep');
  assertOptionalString(run.statusReason, 'run.statusReason');
  assertOptionalString(run.requirementBaseline, 'run.requirementBaseline');

  const status = run.status ?? 'running';
  if (!RUN_STATUSES.includes(status)) {
    throw new RangeError(`run.status 必须是 ${RUN_STATUSES.join(' / ')} 之一，收到：${status}`);
  }
  if (run.targetScore !== undefined && run.targetScore !== null) {
    if (typeof run.targetScore !== 'number' || !Number.isFinite(run.targetScore) || run.targetScore < 0) {
      throw new TypeError(`run.targetScore 必须是非负数字或 null，收到：${run.targetScore}`);
    }
  }

  const template = getWorkflowTemplate(db, run.templateId);
  if (template === null) {
    throw new RangeError(`run.templateId 指向不存在的模板：${run.templateId}`);
  }
  if (run.templateVersion !== undefined) {
    assertPositiveInteger(run.templateVersion, 'run.templateVersion');
  }

  const now = nowIso();
  const createdAt = isoOrNull(run.createdAt, 'run.createdAt') ?? now;
  const row = {
    run_id: typeof run.runId === 'string' && run.runId ? run.runId : randomUUID(),
    template_id: run.templateId,
    template_version: run.templateVersion ?? template.version,
    title: run.title.trim(),
    current_step: run.currentStep ?? null,
    status,
    status_reason: run.statusReason ?? null,
    requirement_baseline: run.requirementBaseline ?? null,
    target_score: run.targetScore ?? null,
    created_at: createdAt,
    updated_at: isoOrNull(run.updatedAt, 'run.updatedAt') ?? createdAt,
    archived_at:
      isoOrNull(run.archivedAt, 'run.archivedAt') ?? (status === 'archived' ? createdAt : null),
  };
  db.prepare(
    'INSERT INTO workflow_runs (run_id, template_id, template_version, title, current_step, status, status_reason, ' +
      'requirement_baseline, target_score, created_at, updated_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    row.run_id,
    row.template_id,
    row.template_version,
    row.title,
    row.current_step,
    row.status,
    row.status_reason,
    row.requirement_baseline,
    row.target_score,
    row.created_at,
    row.updated_at,
    row.archived_at,
  );
  return getWorkflowRun(db, row.run_id);
}

/** 按 id 查运行，查无返回 null。 */
export function getWorkflowRun(db, runId) {
  return one(db, 'SELECT * FROM workflow_runs WHERE run_id = ?', [runId]);
}

/**
 * 运行列表，可按 status / templateId 筛（不传返回全部）；
 * created_at 倒序（新 run 在前），同毫秒按 rowid 倒序决胜。
 */
export function listWorkflowRuns(db, { status, templateId } = {}) {
  if (status !== undefined && !RUN_STATUSES.includes(status)) {
    throw new RangeError(`status 必须是 ${RUN_STATUSES.join(' / ')} 之一，收到：${status}`);
  }
  if (templateId !== undefined) assertNonEmptyString(templateId, 'templateId');

  const where = [];
  const params = [];
  if (status !== undefined) {
    where.push('status = ?');
    params.push(status);
  }
  if (templateId !== undefined) {
    where.push('template_id = ?');
    params.push(templateId);
  }
  const sql =
    'SELECT * FROM workflow_runs' +
    (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY created_at DESC, rowid DESC';
  return many(db, sql, params);
}

/**
 * 更新运行状态，返回更新后的行；run 不存在时不写入、返回 null。
 * opts.statusReason 不传则保持原值；传 null 表示清空。
 * 切到 archived 时自动写 archived_at（可用 opts.archivedAt 注入，测试免 sleep）。
 *
 * 刻意不碰 requirement_baseline / template_id / template_version / title / created_at。
 */
export function updateWorkflowRunStatus(db, runId, status, opts = {}) {
  if (!RUN_STATUSES.includes(status)) {
    throw new RangeError(`status 必须是 ${RUN_STATUSES.join(' / ')} 之一，收到：${status}`);
  }
  const { statusReason, archivedAt } = opts ?? {};
  assertOptionalString(statusReason, 'opts.statusReason');

  const now = nowIso();
  const sets = ['status = ?', 'updated_at = ?'];
  const params = [status, now];
  if (statusReason !== undefined) {
    sets.push('status_reason = ?');
    params.push(statusReason);
  }
  if (status === 'archived') {
    sets.push('archived_at = ?');
    params.push(isoOrNull(archivedAt, 'opts.archivedAt') ?? now);
  }
  params.push(runId);
  db.prepare(`UPDATE workflow_runs SET ${sets.join(', ')} WHERE run_id = ?`).run(...params);
  return getWorkflowRun(db, runId);
}

/** 推进"当前在第几步"（只改指针，不动状态），返回更新后的行；查无返回 null。 */
export function setWorkflowRunCurrentStep(db, runId, currentStep) {
  assertNonEmptyString(currentStep, 'currentStep');
  db.prepare('UPDATE workflow_runs SET current_step = ?, updated_at = ? WHERE run_id = ?').run(
    currentStep,
    nowIso(),
    runId,
  );
  return getWorkflowRun(db, runId);
}

/** 设置目标分；传 null 表示取消目标分。返回更新后的行；查无返回 null。 */
export function setWorkflowRunTargetScore(db, runId, targetScore) {
  if (targetScore !== null && (typeof targetScore !== 'number' || !Number.isFinite(targetScore) || targetScore < 0)) {
    throw new TypeError(`targetScore 必须是非负数字或 null，收到：${targetScore}`);
  }
  db.prepare('UPDATE workflow_runs SET target_score = ?, updated_at = ? WHERE run_id = ?').run(
    targetScore,
    nowIso(),
    runId,
  );
  return getWorkflowRun(db, runId);
}

// ---------------------------------------------------------------------------
// 运行步骤（workflow_run_steps）
// ---------------------------------------------------------------------------

/**
 * 新建一条运行步骤，返回落库后的完整行。
 * (run_id, step_id) 唯一：同一个 run 的同一步只允许一行，重复插入由 UNIQUE 约束拦下。
 * artifacts 是交付物路径数组，落库为 JSON 字符串；缺省 []。
 */
export function insertWorkflowRunStep(db, step) {
  if (!step || typeof step !== 'object') throw new TypeError('step 必须是对象');
  assertNonEmptyString(step.runId, 'step.runId');
  assertNonEmptyString(step.stepId, 'step.stepId');
  assertOptionalString(step.gateResult, 'step.gateResult');

  const status = step.status ?? 'pending';
  if (!RUN_STEP_STATUSES.includes(status)) {
    throw new RangeError(`step.status 必须是 ${RUN_STEP_STATUSES.join(' / ')} 之一，收到：${status}`);
  }
  const artifacts = step.artifacts ?? [];
  assertStringArray(artifacts, 'step.artifacts');

  const row = {
    run_step_id:
      typeof step.runStepId === 'string' && step.runStepId ? step.runStepId : randomUUID(),
    run_id: step.runId,
    step_id: step.stepId,
    status,
    entered_at: isoOrNull(step.enteredAt, 'step.enteredAt'),
    exited_at: isoOrNull(step.exitedAt, 'step.exitedAt'),
    gate_result: step.gateResult ?? null,
    artifacts: JSON.stringify(artifacts),
  };
  db.prepare(
    'INSERT INTO workflow_run_steps (run_step_id, run_id, step_id, status, entered_at, exited_at, gate_result, artifacts) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    row.run_step_id,
    row.run_id,
    row.step_id,
    row.status,
    row.entered_at,
    row.exited_at,
    row.gate_result,
    row.artifacts,
  );
  return getWorkflowRunStep(db, row.run_step_id);
}

/** 按 id 查运行步骤，查无返回 null。 */
export function getWorkflowRunStep(db, runStepId) {
  return one(db, 'SELECT * FROM workflow_run_steps WHERE run_step_id = ?', [runStepId]);
}

/** 某次运行的全部步骤，按 step_id 升序（01 → 09），同 id 按 rowid 决胜。 */
export function listWorkflowRunSteps(db, runId) {
  assertNonEmptyString(runId, 'runId');
  return many(db, 'SELECT * FROM workflow_run_steps WHERE run_id = ? ORDER BY step_id ASC, rowid ASC', [runId]);
}

/**
 * 更新一条运行步骤，返回更新后的行；查无返回 null。
 * patch 支持的字段：status / enteredAt / exitedAt / gateResult / artifacts，
 * 只更新显式传入的字段（undefined = 不动，null = 清空时间/判据）。
 */
export function updateWorkflowRunStep(db, runStepId, patch = {}) {
  if (!patch || typeof patch !== 'object') throw new TypeError('patch 必须是对象');
  const { status, enteredAt, exitedAt, gateResult, artifacts } = patch;
  if (status !== undefined && !RUN_STEP_STATUSES.includes(status)) {
    throw new RangeError(`status 必须是 ${RUN_STEP_STATUSES.join(' / ')} 之一，收到：${status}`);
  }
  assertOptionalString(gateResult, 'patch.gateResult');
  if (artifacts !== undefined) assertStringArray(artifacts, 'patch.artifacts');

  const sets = [];
  const params = [];
  if (status !== undefined) {
    sets.push('status = ?');
    params.push(status);
  }
  if (enteredAt !== undefined) {
    sets.push('entered_at = ?');
    params.push(isoOrNull(enteredAt, 'patch.enteredAt'));
  }
  if (exitedAt !== undefined) {
    sets.push('exited_at = ?');
    params.push(isoOrNull(exitedAt, 'patch.exitedAt'));
  }
  if (gateResult !== undefined) {
    sets.push('gate_result = ?');
    params.push(gateResult);
  }
  if (artifacts !== undefined) {
    sets.push('artifacts = ?');
    params.push(JSON.stringify(artifacts));
  }
  if (sets.length > 0) {
    params.push(runStepId);
    db.prepare(`UPDATE workflow_run_steps SET ${sets.join(', ')} WHERE run_step_id = ?`).run(...params);
  }
  return getWorkflowRunStep(db, runStepId);
}
