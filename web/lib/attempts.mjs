// attempts.mjs — 执行实例（一次「谁在跑这个任务」的尝试）。
//
// attempts 记录的是执行实例本身，不是任务状态。attempt.status 只有四种：
//   running | completed | failed | interrupted
// 任务状态由 state-machine.mjs 根据 attempts + events 推导，两者不混。
//
// 额外提供 reconcileOrphanedAttempts：进程被杀/服务重启后，DB 里可能留下
// status=running 但 pid 已经消失的实例。这个函数把这类实例落成 interrupted，
// 并补一条 process_exit 事件——这样任务不会在重启后变成 idle。

import { allRows, getRow, transaction } from './db.mjs';
import { appendEvent, EVIDENCE, evidencePriority } from './events.mjs';
import { newAttemptId } from './tasks.mjs';

export const ATTEMPT_STATUS = new Set(['running', 'completed', 'failed', 'interrupted']);
export const END_REASONS = new Set(['done', 'quota_blocked', 'user_stop', 'crash', 'spawn_failed', 'handoff', 'auth_failed']);

function stamp(now) {
  return (now instanceof Date ? now : new Date(now ?? Date.now())).toISOString();
}

/** pid 是否存活。取不到（无 pid）时返回 null——null 表示未知，不是 false。 */
export function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return null;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    if (err && err.code === 'EPERM') return true; // 进程存在，只是没权限发信号
    return false;
  }
}

function mapAttempt(row) {
  if (!row) return null;
  return { ...row, relay_pending: Boolean(row.relay_pending) };
}

export function createAttempt(db, input = {}) {
  const {
    taskId, agentId, worktreePath = null, status = 'running',
    pid = null, sessionId = null, startedAt = null, note = null,
    evidenceSource = EVIDENCE.EXECUTOR, checkpointId = null,
  } = input;
  if (!taskId) throw Object.assign(new Error('createAttempt 需要 taskId'), { code: 'BAD_ATTEMPT', statusCode: 400 });
  if (!agentId) throw Object.assign(new Error('createAttempt 需要 agentId'), { code: 'BAD_ATTEMPT', statusCode: 400 });
  if (!ATTEMPT_STATUS.has(status)) {
    throw Object.assign(new Error(`非法执行实例状态：${status}`), { code: 'BAD_ATTEMPT_STATUS', statusCode: 400 });
  }
  const attemptId = input.attemptId || newAttemptId();
  const at = startedAt || stamp();
  db.prepare(
    'INSERT INTO attempts (attempt_id, task_id, agent_id, status, worktree_path, checkpoint_id, ' +
    'started_at, ended_at, end_reason, pid, session_id, relay_pending, note) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, 0, ?)',
  ).run(attemptId, taskId, agentId, status, worktreePath, checkpointId, at, pid, sessionId, note);

  appendEvent(db, {
    taskId, attemptId, agentId,
    eventType: 'attempt_started',
    payload: { agent_id: agentId, worktree_path: worktreePath, pid, session_id: sessionId },
    evidenceSource,
    observedAt: at,
  });
  return getAttempt(db, attemptId);
}

export function getAttempt(db, attemptId) {
  return mapAttempt(getRow(db, 'SELECT * FROM attempts WHERE attempt_id = ?', [attemptId]));
}

export function listAttempts(db, filters = {}) {
  const { taskId = null, agentId = null, status = null, limit = 100 } = filters;
  const where = [];
  const params = [];
  if (taskId) { where.push('task_id = ?'); params.push(taskId); }
  if (agentId) { where.push('agent_id = ?'); params.push(agentId); }
  if (status) { where.push('status = ?'); params.push(status); }
  const sql = 'SELECT * FROM attempts'
    + (where.length ? ` WHERE ${where.join(' AND ')}` : '')
    + ' ORDER BY started_at DESC, attempt_id DESC LIMIT ?';
  return allRows(db, sql, [...params, Math.max(1, Number(limit) || 100)]).map(mapAttempt);
}

export function latestAttempt(db, filters = {}) {
  return listAttempts(db, { ...filters, limit: 1 })[0] || null;
}

export function latestRunningAttempt(db, taskId = null) {
  return latestAttempt(db, { ...(taskId ? { taskId } : {}), status: 'running' });
}

/**
 * 这个任务还没结束的全部执行实例（不止最新一条）。
 * latestRunningAttempt 只认「最新一条 running」——单活动实例约束上线前的遗留数据里
 * 可能同时有多条 running：停止入口的按钮显隐、停止后的剩余数、启动约束的冲突提示都看全量，
 * 不能只看最新的那个（R2-2）。
 */
export function listRunningAttempts(db, taskId = null) {
  return listAttempts(db, { ...(taskId ? { taskId } : {}), status: 'running', limit: 50 });
}

/**
 * 结束一次执行实例。调用方负责在需要时另写 process_exit 等细节事件；
 * 本函数只改实例行 + 写 attempt_ended。
 */
export function endAttempt(db, input = {}) {
  const {
    attemptId, status, endReason = null, endedAt = null,
    evidenceSource = EVIDENCE.EXECUTOR, keepRelayPending = false,
  } = input;
  if (!ATTEMPT_STATUS.has(status)) {
    throw Object.assign(new Error(`非法执行实例状态：${status}`), { code: 'BAD_ATTEMPT_STATUS', statusCode: 400 });
  }
  const at = endedAt || stamp();
  const row = getAttempt(db, attemptId);
  if (!row) throw Object.assign(new Error(`执行实例不存在：${attemptId}`), { code: 'ATTEMPT_NOT_FOUND', statusCode: 404 });
  db.prepare(
    'UPDATE attempts SET status = ?, end_reason = ?, ended_at = ?, relay_pending = ? WHERE attempt_id = ?',
  ).run(status, endReason, at, keepRelayPending ? row.relay_pending : 0, attemptId);

  appendEvent(db, {
    taskId: row.task_id, attemptId, agentId: row.agent_id,
    eventType: 'attempt_ended',
    payload: { status, end_reason: endReason },
    evidenceSource,
    observedAt: at,
  });
  return getAttempt(db, attemptId);
}

/** 标记「待接力」：额度阻塞时进程可能还在，但这次实例已经不能再继续写。 */
export function setRelayPending(db, input = {}) {
  const { attemptId, pending = true, reason = null, observedAt = null, evidenceSource = EVIDENCE.EXECUTOR } = input;
  const row = getAttempt(db, attemptId);
  if (!row) throw Object.assign(new Error(`执行实例不存在：${attemptId}`), { code: 'ATTEMPT_NOT_FOUND', statusCode: 404 });
  db.prepare('UPDATE attempts SET relay_pending = ? WHERE attempt_id = ?').run(pending ? 1 : 0, attemptId);
  appendEvent(db, {
    taskId: row.task_id, attemptId, agentId: row.agent_id,
    eventType: pending ? 'handoff_pending' : 'handoff_cleared',
    payload: { reason },
    evidenceSource,
    observedAt: observedAt || stamp(),
  });
  return getAttempt(db, attemptId);
}

/** 给 attempt 绑定检查点。 */
export function attachCheckpoint(db, attemptId, checkpointId) {
  db.prepare('UPDATE attempts SET checkpoint_id = ? WHERE attempt_id = ?').run(checkpointId, attemptId);
  return getAttempt(db, attemptId);
}

/**
 * 重启恢复：把「DB 说在跑、OS 里已经没了」的实例落成 interrupted。
 * 只处理有 pid 的实例；没 pid 的留给状态机判 unknown，绝不猜成 idle。
 *
 * @returns {{reconciled: Array<{attempt_id:string, pid:number}>, checked:number}}
 */
export function reconcileOrphanedAttempts(db, opts = {}) {
  const { now = null, pidAlive = isPidAlive } = opts;
  const running = listAttempts(db, { status: 'running', limit: 1000 });
  const reconciled = [];
  for (const a of running) {
    if (a.pid == null) continue;
    if (pidAlive(a.pid) !== false) continue;
    const already = getRow(db,
      "SELECT event_id FROM events WHERE attempt_id = ? AND event_type = 'process_exit' LIMIT 1",
      [a.attempt_id]);
    if (already) continue;
    const at = now || stamp();
    transaction(db, () => {
      endAttempt(db, {
        attemptId: a.attempt_id,
        status: 'interrupted',
        endReason: 'crash',
        endedAt: at,
        evidenceSource: EVIDENCE.EXECUTOR,
      });
      appendEvent(db, {
        taskId: a.task_id,
        attemptId: a.attempt_id,
        agentId: a.agent_id,
        eventType: 'process_exit',
        payload: { detected: 'orphan_reconcile', pid: a.pid, expected: false, reason: '进程消失，执行实例未正常结束' },
        evidenceSource: EVIDENCE.EXECUTOR,
        observedAt: at,
      });
    });
    reconciled.push({ attempt_id: a.attempt_id, pid: a.pid });
  }
  return { reconciled, checked: running.length };
}

/** 当前实例证据强度：用于状态机挑 evidence_source。 */
export function attemptEvidenceSource(attempt) {
  if (!attempt) return EVIDENCE.SYSTEM;
  return attempt.agent_id === 'claude' || attempt.agent_id === 'codex'
    ? EVIDENCE.EXTERNAL
    : EVIDENCE.EXECUTOR;
}

export function strongestSource(sources = []) {
  let best = EVIDENCE.SYSTEM;
  let bestRank = 99;
  for (const s of sources) {
    const rank = evidencePriority(s);
    if (rank < bestRank) { best = s; bestRank = rank; }
  }
  return best;
}
