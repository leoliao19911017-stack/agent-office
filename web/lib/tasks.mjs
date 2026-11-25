// tasks.mjs — 任务与步骤的持久化。
//
// 任务是一等公民。本模块只做 CRUD，不判定状态；状态一律由 state-machine.mjs
// 计算后写回（tasks.status / tasks.status_reason），避免出现第二套判定。
//
// 步骤单独一张 task_steps 表：
//   - 任务列表要回答「当前步骤 / 已完成 / 还剩什么」；
//   - 旧 office-data 的 steps 对象迁移进来后能保持顺序与文件清单；
//   - 不把大 JSON 塞进 tasks 行，避免以后查询任务列表时被迫解析全部步骤。
//
// v9：任务可以挂到工作流的某一步上（tasks.workflow_run_id / workflow_step_id）。
// 工作流是固定的九步，任务每次不同——「属于哪次需求的哪一步」是任务的属性，所以落在 tasks 行上，
// 不另建关联表；一个任务只属于一次需求的一步。run / 步骤是否存在由 API 层校验，本文件只存取。

import { randomUUID } from 'node:crypto';
import { allRows, getRow, transaction } from './db.mjs';
import { appendEvent, EVIDENCE } from './events.mjs';

export const STEP_STATUS = new Set(['pending', 'running', 'done', 'awaiting', 'failed', 'skipped']);

/** 没给步骤时每条任务的默认步骤（POST /api/tasks 与批量建任务共用同一份）。 */
export const DEFAULT_TASK_STEPS = [{ key: 'deliverable', name: '交付' }];

function stamp(now) {
  return (now instanceof Date ? now : new Date(now ?? Date.now())).toISOString();
}

function pickNow(now) {
  return now instanceof Date ? now.getTime() : (typeof now === 'number' ? now : Date.now());
}

export function newTaskId(now = Date.now()) {
  const d = new Date(now);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const ts = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
    + `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  return `t-${ts}-${randomUUID().slice(0, 6)}`;
}

export function newAttemptId() {
  return `a-${randomUUID().slice(0, 8)}-${Date.now().toString(36)}`;
}

export function newCheckpointId() {
  return `ck-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
}

export function normalizeTaskId(raw) {
  const id = String(raw || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(id)) {
    throw Object.assign(new Error('task_id 不合法（字母数字开头，允许 _ . -，≤96 字符）'), {
      code: 'BAD_TASK_ID', statusCode: 400,
    });
  }
  return id;
}

/** 步骤规范化：字符串 → {key,name}；对象保留 key/name/status/note/files。 */
export function normalizeSteps(steps) {
  if (!Array.isArray(steps)) return [];
  const used = new Set();
  return steps.map((raw, i) => {
    const obj = typeof raw === 'string' ? { name: raw } : (raw && typeof raw === 'object' ? raw : {});
    let key = String(obj.key || obj.name || `step-${i + 1}`).trim().slice(0, 64) || `step-${i + 1}`;
    let n = 2;
    while (used.has(key)) { key = `${key}-${n++}`; }
    used.add(key);
    const status = STEP_STATUS.has(obj.status) ? obj.status : 'pending';
    return {
      key,
      name: String(obj.name || obj.title || key).slice(0, 200),
      status,
      at: obj.at || null,
      note: obj.note == null ? '' : String(obj.note),
      files: Array.isArray(obj.files) ? obj.files : [],
    };
  });
}

/** 工作流挂点归一：没给 / 空串都是 null（= 不属于任何工作流 / 没挂到步骤）。 */
function linkOf(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s ? s : null;
}

/**
 * 写一条任务：任务行 + 步骤 + task_created 事件。
 * 自己不开事务——单条建任务直接调用；批量建任务由调用方包进一个事务
 * （见 createTasksForWorkflowStep），所以这里不能像 replaceSteps 那样自己 BEGIN。
 */
function insertTaskRecord(db, rec) {
  const { taskId, title, acceptance, status, statusReason, now, steps } = rec;
  const workflowRunId = linkOf(rec.workflowRunId);
  const workflowStepId = linkOf(rec.workflowStepId);
  db.prepare(
    'INSERT INTO tasks (task_id, title, acceptance, status, status_reason, created_at, updated_at, ' +
      'workflow_run_id, workflow_step_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(taskId, title, acceptance, status, statusReason, now, now, workflowRunId, workflowStepId);

  const stepList = normalizeSteps(steps);
  insertStepRows(db, taskId, stepList, now);

  // 挂了工作流的任务，事件里带上挂点：以后查「这条任务是为哪次需求的哪一步建的」不用回表。
  const link = workflowRunId ? { workflow_run_id: workflowRunId, workflow_step_id: workflowStepId } : {};
  appendEvent(db, {
    taskId,
    agentId: rec.agentId || null,
    eventType: 'task_created',
    payload: {
      title, acceptance, steps: stepList.map((s) => s.key), source: rec.source || 'api', ...link,
    },
    evidenceSource: rec.evidenceSource || EVIDENCE.USER,
    observedAt: now,
  });
}

export function createTask(db, input = {}) {
  const now = input.createdAt || stamp();
  const taskId = input.taskId ? normalizeTaskId(input.taskId) : newTaskId(pickNow(input.createdAt));
  const title = String(input.title || '').trim();
  if (!title) {
    throw Object.assign(new Error('title 不能为空'), { code: 'BAD_TITLE', statusCode: 400 });
  }
  const acceptance = input.acceptance == null ? null : String(input.acceptance);
  const status = input.status || 'waiting';
  const statusReason = input.statusReason || '任务已创建，等待执行';

  const exists = getRow(db, 'SELECT task_id FROM tasks WHERE task_id = ?', [taskId]);
  if (exists) {
    throw Object.assign(new Error(`任务已存在：${taskId}`), { code: 'TASK_EXISTS', statusCode: 409 });
  }

  insertTaskRecord(db, {
    taskId, title, acceptance, status, statusReason, now, steps: input.steps,
    source: input.source, evidenceSource: input.evidenceSource,
    workflowRunId: input.workflowRunId, workflowStepId: input.workflowStepId,
  });

  return getTask(db, taskId);
}

/**
 * 挂到工作流某一步上的批量建任务（v9）：任务书里拆出来的 N 条一次建完，全部带同一个挂点。
 *
 * 整批要么全建、要么一条不建：先把每一项校验完（任一项不合法直接抛 400，此时还没写库），
 * 再在一个事务里逐条写入，写入中途出错整批回滚——否则会留下半批任务，调用方一重试就重复。
 * 这里只管 tasks 表；run / 步骤是否真实存在由 API 层先校验（那边才拿得到 404 语义）。
 *
 * 同一批里时间戳逐条 +1ms：任务列表按 updated_at 倒序，这样整批顺序确定（后建的在上），
 * 不会因为时间戳全相同而退化成按随机 task_id 排。
 *
 * @param {{runId: string, stepId: string, items: Array<{title: string, acceptance?: string|null}>, actor?: string|null, at?: Date|number, source?: string}} input
 * @returns {Array<object>} 按传入顺序返回新建的任务行（tasks 表原行）
 */
export function createTasksForWorkflowStep(db, { runId, stepId, items, actor = null, at, source = 'workflow' }) {
  const run = linkOf(runId);
  const step = linkOf(stepId);
  if (!run || !step) {
    throw Object.assign(new Error('批量建任务必须同时给 workflow_run_id 和 workflow_step_id'), {
      code: 'BAD_WORKFLOW_LINK', statusCode: 400,
    });
  }
  if (!Array.isArray(items) || !items.length) {
    throw Object.assign(new Error('tasks 必须是非空数组'), { code: 'BAD_TASKS', statusCode: 400 });
  }
  const base = at === undefined || at === null ? Date.now()
    : at instanceof Date ? at.getTime()
      : typeof at === 'number' ? at : new Date(at).getTime();
  if (!Number.isFinite(base)) {
    throw Object.assign(new Error('at 必须是可解析的时间'), { code: 'BAD_TIME', statusCode: 400 });
  }

  // 第一遍只校验、不写库：任何一项不合法都在写第一行之前抛出。
  const rows = items.map((item, i) => {
    const obj = item !== null && typeof item === 'object' && !Array.isArray(item) ? item : null;
    const title = obj ? String(obj.title ?? '').trim() : '';
    if (!title) {
      throw Object.assign(new Error(`tasks[${i}] 需要非空字符串 title`), { code: 'BAD_TITLE', statusCode: 400 });
    }
    const acceptance = obj.acceptance == null ? null : String(obj.acceptance);
    const atMs = base + i;
    return { taskId: newTaskId(atMs), title, acceptance, at: stamp(atMs) };
  });

  return transaction(db, () => rows.map((row) => {
    insertTaskRecord(db, {
      taskId: row.taskId,
      title: row.title,
      acceptance: row.acceptance,
      status: 'waiting',
      statusReason: '任务已创建，等待执行',
      now: row.at,
      steps: DEFAULT_TASK_STEPS,
      source,
      evidenceSource: EVIDENCE.USER,
      agentId: actor,
      workflowRunId: run,
      workflowStepId: step,
    });
    return getTask(db, row.taskId);
  }));
}

/**
 * 迁移专用 upsert：不写 task_created（迁移事件单独写），按 task_id 覆盖。
 * 返回 {inserted:boolean, task}。
 */
export function upsertMigratedTask(db, input = {}) {
  const taskId = normalizeTaskId(input.taskId);
  const now = input.updatedAt || stamp();
  const createdAt = input.createdAt || now;
  const before = getRow(db, 'SELECT task_id FROM tasks WHERE task_id = ?', [taskId]);
  db.prepare(
    'INSERT INTO tasks (task_id, title, acceptance, status, status_reason, created_at, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(task_id) DO UPDATE SET ' +
    'title = excluded.title, acceptance = excluded.acceptance, status = excluded.status, ' +
    'status_reason = excluded.status_reason, updated_at = excluded.updated_at',
  ).run(
    taskId,
    String(input.title || taskId),
    input.acceptance == null ? null : String(input.acceptance),
    input.status || 'waiting',
    input.statusReason || '历史任务迁移',
    createdAt,
    now,
  );
  return { inserted: !before, task: getTask(db, taskId) };
}

export function getTask(db, taskId) {
  const row = getRow(db, 'SELECT * FROM tasks WHERE task_id = ?', [taskId]);
  if (!row) return null;
  return { ...row };
}

export function requireTask(db, taskId) {
  const task = getTask(db, taskId);
  if (!task) {
    throw Object.assign(new Error(`任务不存在：${taskId}`), { code: 'TASK_NOT_FOUND', statusCode: 404 });
  }
  return task;
}

/**
 * 执行入口（声明实例 / 交接 / 检查点 / 收尾）共用的守卫：已软删的任务不能再执行。
 *
 * 软删的任务在界面上默认看不见。还能在它上面起一个 running 的实例的话，就会留下一条
 * 「看不见却在跑」的任务，之后既停不了也删不掉（评审 P1-2）。恢复之后可以重新执行。
 * 调用方要把它和后面的写入放进同一个事务：检查和写入之间才插不进一次删除。
 */
export function requireNotDeletedTask(db, taskId) {
  const task = requireTask(db, taskId);
  if (task.deleted_at) {
    throw Object.assign(
      new Error(`任务已删除，不能再开始执行：${taskId}（恢复之后才能再执行）`),
      { code: 'TASK_DELETED', statusCode: 409 },
    );
  }
  return task;
}

/**
 * 任务列表。
 *
 * visibility 决定归档 / 软删的行是否返回（默认 'all'，与加列前行为一致，
 * 采集器 / 迁移脚本不受影响）：
 *   'all'         全部行（内部工具用）
 *   'not_deleted' 排除软删，保留归档 —— GET /api/tasks?include_archived=1
 *   'active'      排除软删 + 排除归档 —— GET /api/tasks 默认
 *   'deleted'     只要软删的行（归档与否都算）—— GET /api/tasks?only_deleted=1（回收站）
 * 归档 / 删除的判定只在这里做 SQL 过滤，不把过滤逻辑散到路由里。
 *
 * v9 追加两个可选过滤（走 idx_tasks_workflow 联合索引）：
 *   workflowRunId    只要这一次需求下拆出来的任务
 *   workflowStepId   只要挂在某一步上的任务；和 workflowRunId 一起用就是「这次需求的这一步」
 * 不带 run 的老任务两列都是 NULL，按 run 过滤时自然排除；不带过滤时照常返回（B6）。
 */
export function listTasks(db, opts = {}) {
  const { limit = 200, offset = 0, visibility = 'all', workflowRunId = null, workflowStepId = null } = opts;
  const where = [];
  if (visibility === 'active') where.push('archived_at IS NULL', 'deleted_at IS NULL');
  else if (visibility === 'not_deleted') where.push('deleted_at IS NULL');
  else if (visibility === 'deleted') where.push('deleted_at IS NOT NULL');
  const params = [];
  const run = linkOf(workflowRunId);
  const step = linkOf(workflowStepId);
  if (run) { where.push('workflow_run_id = ?'); params.push(run); }
  if (step) { where.push('workflow_step_id = ?'); params.push(step); }
  return allRows(db,
    `SELECT * FROM tasks${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ` +
      'ORDER BY updated_at DESC, task_id DESC LIMIT ? OFFSET ?',
    [...params, Math.max(1, Number(limit) || 200), Math.max(0, Number(offset) || 0)]);
}

export function countTasks(db) {
  const row = getRow(db, 'SELECT COUNT(*) AS n FROM tasks');
  return row ? row.n : 0;
}

/** 只更新状态列；状态机的 refreshTaskState 调用它。 */
export function updateTaskStatus(db, taskId, status, statusReason, at = stamp()) {
  db.prepare('UPDATE tasks SET status = ?, status_reason = ?, updated_at = ? WHERE task_id = ?')
    .run(status, statusReason ?? null, at, taskId);
}

export function closeTask(db, taskId, reason = '任务已关闭', at = stamp()) {
  db.prepare('UPDATE tasks SET status = ?, status_reason = ?, closed_at = ?, updated_at = ? WHERE task_id = ?')
    .run('idle', reason, at, at, taskId);
  return getTask(db, taskId);
}

function mapStep(row) {
  return {
    key: row.step_key,
    name: row.name,
    seq: row.seq,
    status: row.status,
    at: row.at,
    note: row.note,
    files: row.files ? JSON.parse(row.files) : [],
  };
}

export function getSteps(db, taskId) {
  return allRows(db, 'SELECT * FROM task_steps WHERE task_id = ? ORDER BY seq ASC', [taskId]).map(mapStep);
}

/** 按顺序写步骤行。不开事务——调用方要么自己包了事务（replaceSteps / 批量建任务），要么在单条建任务里直接调。 */
function insertStepRows(db, taskId, list, at) {
  const ins = db.prepare(
    'INSERT INTO task_steps (task_id, step_key, name, seq, status, at, note, files, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  list.forEach((s, i) => {
    ins.run(taskId, s.key, s.name, i, s.status, s.at, s.note, JSON.stringify(s.files), at);
  });
}

/** 全量替换步骤（迁移/建任务用）。旧行先删，避免残留已改名的步骤。 */
export function replaceSteps(db, taskId, steps, opts = {}) {
  const at = opts.at || stamp();
  const list = normalizeSteps(steps);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM task_steps WHERE task_id = ?').run(taskId);
    insertStepRows(db, taskId, list, at);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
  return getSteps(db, taskId);
}

export function updateStep(db, taskId, stepKey, patch = {}) {
  const current = getRow(db, 'SELECT * FROM task_steps WHERE task_id = ? AND step_key = ?', [taskId, stepKey]);
  if (!current) return null;
  const status = STEP_STATUS.has(patch.status) ? patch.status : current.status;
  const at = patch.at === undefined ? current.at : patch.at;
  const note = patch.note === undefined ? current.note : String(patch.note);
  const files = patch.files === undefined ? current.files : JSON.stringify(patch.files);
  db.prepare(
    'UPDATE task_steps SET status = ?, at = ?, note = ?, files = ?, updated_at = ? ' +
    'WHERE task_id = ? AND step_key = ?',
  ).run(status, at, note, files, stamp(), taskId, stepKey);
  return getSteps(db, taskId).find((s) => s.key === stepKey) || null;
}

/**
 * 步骤摘要：当前步骤、已完成、剩余。
 * current 优先取 running/awaiting 的第一个，其次取第一个 pending；
 * 全部 done 时 current 为 null（表示没有「进行中的步骤」）。
 *
 * opts.completed：任务已经完成。此时步骤全部按 done 算、current / remaining 为空。
 * 「任务完成了、步骤行却还挂在 pending」是一种数据不一致：finish 验收通过时本来就会把步骤全落成 done，
 * 但任务也可能是在本系统之外被直接记成完成的（迁移进来的历史任务、人工改库）。
 * 界面不该一边写「已完成」、一边写「0 / 1 步 · 剩余 deliverable」。
 *
 * 没有步骤行时（total 本来会是 0）：不编一个步骤出来，但「这条任务做没做完」仍然要答得出来——
 * 按任务状态给 1 / 1 或 0 / 1（done / remaining 两个清单照旧是空的，current 为 null）。
 */
export function summarizeSteps(steps, opts = {}) {
  const completed = Boolean(opts.completed);
  const list = Array.isArray(steps) ? steps : [];
  if (!list.length) {
    return { current_step: null, done: [], remaining: [], done_count: completed ? 1 : 0, total: 1 };
  }
  const isDone = (s) => completed || s.status === 'done' || s.status === 'skipped';
  const done = list.filter(isDone);
  const remaining = completed ? [] : list.filter((s) => !isDone(s));
  const current = completed
    ? null
    : list.find((s) => s.status === 'running')
      || list.find((s) => s.status === 'awaiting')
      || list.find((s) => s.status === 'failed')
      || remaining[0]
      || null;
  return {
    current_step: current ? { key: current.key, name: current.name, status: current.status } : null,
    done: done.map((s) => s.key),
    remaining: remaining.map((s) => s.key),
    done_count: done.length,
    total: list.length,
  };
}

/** 把任务行 + 步骤包装成列表项要的字段（不判状态，状态由 api 层套 state-machine）。 */
export function taskRecord(db, taskId) {
  const task = requireTask(db, taskId);
  const steps = getSteps(db, taskId);
  return { task, steps, summary: summarizeSteps(steps) };
}
