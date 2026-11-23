// tasks.mjs — 任务与步骤的持久化。
//
// 任务是一等公民。本模块只做 CRUD，不判定状态；状态一律由 state-machine.mjs
// 计算后写回（tasks.status / tasks.status_reason），避免出现第二套判定。
//
// 步骤单独一张 task_steps 表：
//   - 任务列表要回答「当前步骤 / 已完成 / 还剩什么」；
//   - 旧 office-data 的 steps 对象迁移进来后能保持顺序与文件清单；
//   - 不把大 JSON 塞进 tasks 行，避免以后查询任务列表时被迫解析全部步骤。

import { randomUUID } from 'node:crypto';
import { allRows, getRow } from './db.mjs';
import { appendEvent, EVIDENCE } from './events.mjs';

export const STEP_STATUS = new Set(['pending', 'running', 'done', 'awaiting', 'failed', 'skipped']);

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

  db.prepare(
    'INSERT INTO tasks (task_id, title, acceptance, status, status_reason, created_at, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(taskId, title, acceptance, status, statusReason, now, now);

  const steps = normalizeSteps(input.steps);
  replaceSteps(db, taskId, steps, { at: now });

  appendEvent(db, {
    taskId,
    eventType: 'task_created',
    payload: { title, acceptance, steps: steps.map((s) => s.key), source: input.source || 'api' },
    evidenceSource: input.evidenceSource || EVIDENCE.USER,
    observedAt: now,
  });

  return getTask(db, taskId);
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

export function listTasks(db, opts = {}) {
  const { limit = 200, offset = 0 } = opts;
  return allRows(db,
    'SELECT * FROM tasks ORDER BY updated_at DESC, task_id DESC LIMIT ? OFFSET ?',
    [Math.max(1, Number(limit) || 200), Math.max(0, Number(offset) || 0)]);
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

/** 全量替换步骤（迁移/建任务用）。旧行先删，避免残留已改名的步骤。 */
export function replaceSteps(db, taskId, steps, opts = {}) {
  const at = opts.at || stamp();
  const list = normalizeSteps(steps);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM task_steps WHERE task_id = ?').run(taskId);
    const ins = db.prepare(
      'INSERT INTO task_steps (task_id, step_key, name, seq, status, at, note, files, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    list.forEach((s, i) => {
      ins.run(taskId, s.key, s.name, i, s.status, s.at, s.note, JSON.stringify(s.files), at);
    });
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
 */
export function summarizeSteps(steps) {
  const list = Array.isArray(steps) ? steps : [];
  const done = list.filter((s) => s.status === 'done' || s.status === 'skipped');
  const remaining = list.filter((s) => s.status !== 'done' && s.status !== 'skipped');
  const current = list.find((s) => s.status === 'running')
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
