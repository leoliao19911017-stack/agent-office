// write-owner.mjs — 写入所有权：同一 worktree 同一时刻只允许一个执行实例写。
//
// 这是 P0 唯一的并发闸门。规则：
//   1) 没有记录 / 已释放           → 可以获取；
//   2) 同一个 attempt 重复申请      → 幂等成功（更新 heartbeat）；
//   3) 另一个 attempt/agent 持有中  → 拒绝（409 WRITE_OWNER_CONFLICT）；
//   4) 显式 force + 理由            → 强制接管，事件里留痕；
//   5) 超过 staleMs 且调用方确认原实例已死 → 可接管，事件里留痕。
//
// 交接（handoff）必须是一次事务：先校验旧的持有者，再改 attempt_id/agent_id，
// 不能出现「旧的已释放、新的还没拿到」的空窗。

import { resolve as pathResolve } from 'node:path';
import { getRow, transaction } from './db.mjs';
import { appendEvent, EVIDENCE } from './events.mjs';

export class WriteOwnerConflict extends Error {
  constructor(message, owner) {
    super(message);
    this.name = 'WriteOwnerConflict';
    this.code = 'WRITE_OWNER_CONFLICT';
    this.statusCode = 409;
    this.owner = owner || null;
  }
}

function stamp(now) {
  return (now instanceof Date ? now : new Date(now ?? Date.now())).toISOString();
}

/**
 * 路径规范化：绝对路径、正斜杠、Windows 盘符小写、去掉尾部斜杠。
 * 同一目录的不同写法必须落到同一个主键，否则所有权形同虚设。
 */
export function normalizeWorktreePath(p) {
  if (!p || typeof p !== 'string') {
    throw Object.assign(new Error('worktree_path 不能为空'), { code: 'BAD_WORKTREE', statusCode: 400 });
  }
  let n = p.replace(/\\/g, '/').trim();
  // 相对路径按进程 cwd 解析，保证同一目录的不同写法落到同一个主键。
  n = pathResolve(n).replace(/\\/g, '/');
  if (/^[A-Za-z]:/.test(n)) n = n[0].toLowerCase() + n.slice(1);
  return n.replace(/\/+$/, '');
}

function mapOwner(row) {
  return row ? { ...row } : null;
}

export function getWriteOwner(db, worktreePath) {
  const path = normalizeWorktreePath(worktreePath);
  return mapOwner(getRow(db, 'SELECT * FROM write_owner WHERE worktree_path = ?', [path]));
}

export function listWriteOwners(db, opts = {}) {
  const { activeOnly = false } = opts;
  const sql = 'SELECT * FROM write_owner'
    + (activeOnly ? ' WHERE released_at IS NULL' : '')
    + ' ORDER BY acquired_at DESC';
  return db.prepare(sql).all().map((r) => ({ ...r }));
}

function findConflict(owner, attemptId) {
  if (!owner || owner.released_at) return null;
  if (owner.attempt_id === attemptId) return null; // 幂等
  return owner;
}

/**
 * 获取写入权。成功返回 {acquired:true, owner, idempotent?}；
 * 冲突抛 WriteOwnerConflict（带当前 owner，方便 API 告诉调用方被谁占着）。
 */
export function acquireWriteOwner(db, input = {}) {
  const {
    worktreePath, taskId, attemptId, agentId,
    now = null, force = false, forceReason = null,
    staleMs = null, staleConfirmed = false,
  } = input;
  const path = normalizeWorktreePath(worktreePath);
  const at = stamp(now);
  if (!taskId || !attemptId || !agentId) {
    throw Object.assign(new Error('获取写入权需要 taskId / attemptId / agentId'), {
      code: 'BAD_WRITE_OWNER', statusCode: 400,
    });
  }

  return transaction(db, () => {
    const owner = getRow(db, 'SELECT * FROM write_owner WHERE worktree_path = ?', [path]);
    const conflict = findConflict(owner, attemptId);
    const ageMs = owner && !owner.released_at ? Math.max(0, Date.parse(at) - Date.parse(owner.acquired_at)) : 0;
    const stale = staleMs != null && ageMs > Number(staleMs) && staleConfirmed;

    if (conflict && !force && !stale) {
      throw new WriteOwnerConflict(
        `worktree 已被 ${conflict.agent_id}/${conflict.attempt_id} 占用，拒绝并发写入`,
        mapOwner(conflict),
      );
    }

    if (owner && !owner.released_at && owner.attempt_id === attemptId) {
      db.prepare('UPDATE write_owner SET heartbeat_at = ? WHERE worktree_path = ?').run(at, path);
      appendEvent(db, {
        taskId, attemptId, agentId,
        eventType: 'write_owner_heartbeat',
        payload: { worktree_path: path },
        evidenceSource: EVIDENCE.EXECUTOR,
        observedAt: at,
      });
      return { acquired: true, idempotent: true, owner: getWriteOwner(db, path) };
    }

    if (owner) {
      db.prepare(
        'UPDATE write_owner SET task_id = ?, attempt_id = ?, agent_id = ?, acquired_at = ?, released_at = NULL, heartbeat_at = ? ' +
        'WHERE worktree_path = ?',
      ).run(taskId, attemptId, agentId, at, at, path);
    } else {
      db.prepare(
        'INSERT INTO write_owner (worktree_path, task_id, attempt_id, agent_id, acquired_at, released_at, heartbeat_at) ' +
        'VALUES (?, ?, ?, ?, ?, NULL, ?)',
      ).run(path, taskId, attemptId, agentId, at, at);
    }

    appendEvent(db, {
      taskId, attemptId, agentId,
      eventType: conflict ? (force ? 'write_owner_forced' : 'write_owner_stale_takeover') : 'write_owner_acquired',
      payload: {
        worktree_path: path,
        previous: conflict ? { agent_id: conflict.agent_id, attempt_id: conflict.attempt_id } : null,
        force: Boolean(force),
        force_reason: forceReason,
        stale_ms: staleMs,
      },
      evidenceSource: EVIDENCE.EXECUTOR,
      observedAt: at,
    });
    return { acquired: true, owner: getWriteOwner(db, path) };
  });
}

/** 释放写入权。不是持有者时返回 {released:false, reason}，不抛错。 */
export function releaseWriteOwner(db, input = {}) {
  const { worktreePath, attemptId = null, now = null, reason = 'released' } = input;
  const path = normalizeWorktreePath(worktreePath);
  const at = stamp(now);
  return transaction(db, () => {
    const owner = getRow(db, 'SELECT * FROM write_owner WHERE worktree_path = ?', [path]);
    if (!owner || owner.released_at) return { released: false, reason: 'not_held' };
    if (attemptId && owner.attempt_id !== attemptId) {
      return { released: false, reason: 'held_by_other', owner: mapOwner(owner) };
    }
    db.prepare('UPDATE write_owner SET released_at = ?, heartbeat_at = ? WHERE worktree_path = ?')
      .run(at, at, path);
    appendEvent(db, {
      taskId: owner.task_id, attemptId: owner.attempt_id, agentId: owner.agent_id,
      eventType: 'write_owner_released',
      payload: { worktree_path: path, reason },
      evidenceSource: EVIDENCE.EXECUTOR,
      observedAt: at,
    });
    return { released: true, owner: getWriteOwner(db, path) };
  });
}

/**
 * 交接：一次性把写入权从 fromAttempt 转给 toAttempt。
 * 若当前没有持有者，则直接给 toAttempt（等价 acquire）；若持有者不是 from，拒绝。
 */
export function transferWriteOwner(db, input = {}) {
  const {
    worktreePath, taskId, fromAttemptId, toAttemptId, agentId,
    now = null, reason = 'handoff',
  } = input;
  const path = normalizeWorktreePath(worktreePath);
  const at = stamp(now);
  if (!taskId || !fromAttemptId || !toAttemptId || !agentId) {
    throw Object.assign(new Error('交接需要 taskId / fromAttemptId / toAttemptId / agentId'), {
      code: 'BAD_HANDOFF', statusCode: 400,
    });
  }
  return transaction(db, () => {
    const owner = getRow(db, 'SELECT * FROM write_owner WHERE worktree_path = ?', [path]);
    if (owner && !owner.released_at && owner.attempt_id !== fromAttemptId) {
      throw new WriteOwnerConflict(
        `写入权当前属于 ${owner.agent_id}/${owner.attempt_id}，不能从 ${fromAttemptId} 交接`,
        mapOwner(owner),
      );
    }
    if (owner) {
      db.prepare(
        'UPDATE write_owner SET task_id = ?, attempt_id = ?, agent_id = ?, acquired_at = ?, released_at = NULL, heartbeat_at = ? ' +
        'WHERE worktree_path = ?',
      ).run(taskId, toAttemptId, agentId, at, at, path);
    } else {
      db.prepare(
        'INSERT INTO write_owner (worktree_path, task_id, attempt_id, agent_id, acquired_at, released_at, heartbeat_at) ' +
        'VALUES (?, ?, ?, ?, ?, NULL, ?)',
      ).run(path, taskId, toAttemptId, agentId, at, at);
    }
    appendEvent(db, {
      taskId, attemptId: toAttemptId, agentId,
      eventType: 'write_owner_transferred',
      payload: {
        worktree_path: path,
        from_attempt_id: fromAttemptId,
        to_attempt_id: toAttemptId,
        reason,
      },
      evidenceSource: EVIDENCE.EXECUTOR,
      observedAt: at,
    });
    return { transferred: true, owner: getWriteOwner(db, path) };
  });
}

/** 释放某个 attempt 持有的全部 worktree（进程退出时兜底）。 */
export function releaseAllForAttempt(db, attemptId, now = null) {
  const rows = db.prepare('SELECT * FROM write_owner WHERE attempt_id = ? AND released_at IS NULL')
    .all(attemptId).map((r) => ({ ...r }));
  const out = [];
  for (const r of rows) {
    out.push(releaseWriteOwner(db, {
      worktreePath: r.worktree_path, attemptId, now, reason: 'attempt_ended',
    }));
  }
  return out;
}
