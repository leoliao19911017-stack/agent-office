// chat-db.mjs — 聊天六张表的读写（只做 CRUD 与查询，不判定状态；状态由 chat-engine 落库）。
//
// 红线：本模块只写 chat_* 六张表。tasks / attempts / events / write_owner 一行都不碰（ADR-03）。
// 其它模块一律接收 db 参数，便于测试用内存库隔离（与 lib/*.mjs 同一约定）。

import { randomUUID } from 'node:crypto';
import { allRows, getRow, transaction } from '../lib/db.mjs';
import { ACTIVE_TURN_STATUS, CHAT_MODES, CHAT_PROVIDERS, TURN, TURN_LABEL, errorLabel } from './chat-state.mjs';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;

function stamp(now) {
  return (now instanceof Date ? now : new Date(now ?? Date.now())).toISOString();
}

const short = () => randomUUID().replace(/-/g, '').slice(0, 10);
export const newThreadId = () => `th-${short()}`;
export const newTurnId = () => `ct-${short()}`;
export const newMessageId = () => `cm-${short()}`;
/** 一轮聊天里一次 CLI 调用的编号；与任务表 attempts 的 a-… 不是一个 ID 空间 */
export const newChatAttemptId = () => `ca-${short()}`;

export function isId(value) {
  return typeof value === 'string' && ID_RE.test(value);
}

function badRequest(message) {
  return Object.assign(new Error(message), { code: 'BAD_CHAT_INPUT', statusCode: 400 });
}
const notFound = (code, message) => Object.assign(new Error(message), { code, statusCode: 404 });

function parseJson(text) {
  if (text === null || text === undefined || text === '') return null;
  try { return JSON.parse(text); } catch { return null; }
}

const mapThread = (r) => r && {
  thread_id: r.thread_id,
  agent_id: r.agent_id,
  provider_session_id: r.provider_session_id || null,
  workspace: r.workspace || null,
  mode: r.mode,
  task_id: r.task_id || null,
  task_attempt_id: r.task_attempt_id || null,
  title: r.title || null,
  created_at: r.created_at,
  updated_at: r.updated_at,
};

const mapMessage = (r) => r && {
  message_id: r.message_id,
  thread_id: r.thread_id,
  turn_id: r.turn_id || null,
  role: r.role,
  content: r.content,
  status: r.status,
  error: parseJson(r.error_json),
  seq: r.seq,
  event_seq: r.event_seq,
  created_at: r.created_at,
  updated_at: r.updated_at,
};

const mapTurn = (r) => r && {
  turn_id: r.turn_id,
  thread_id: r.thread_id,
  attempt_id: r.attempt_id,
  user_message_id: r.user_message_id || null,
  assistant_message_id: r.assistant_message_id || null,
  status: r.status,
  provider: r.provider,
  resume: Boolean(r.resume),
  retry_of_turn_id: r.retry_of_turn_id || null,
  error: parseJson(r.error_json),
  started_at: r.started_at || null,
  ended_at: r.ended_at || null,
  created_at: r.created_at,
  rowid: r.rowid,
};

const mapEvent = (r) => r && {
  event_id: r.event_id,
  turn_id: r.turn_id,
  seq: r.seq,
  type: r.type,
  payload: parseJson(r.payload),
  created_at: r.created_at,
};

/* ---------------- threads ---------------- */

export function createThread(db, input = {}) {
  const { agentId, workspace = null, mode = 'discuss', taskId = null, taskAttemptId = null, title = null, now = null } = input;
  if (!CHAT_PROVIDERS.includes(agentId)) throw badRequest(`agent_id 不受支持：${agentId}`);
  if (!CHAT_MODES.includes(mode)) throw badRequest(`mode 不受支持：${mode}`);
  if (taskId != null && !isId(taskId)) throw badRequest('task_id 不合法');
  const at = stamp(now);
  const thread = {
    thread_id: input.threadId || newThreadId(),
    agent_id: agentId,
    provider_session_id: null,
    workspace: workspace || null,
    mode,
    task_id: taskId || null,
    task_attempt_id: taskAttemptId || null,
    title: title ? String(title).slice(0, 120) : null,
    created_at: at,
    updated_at: at,
  };
  db.prepare(
    'INSERT INTO chat_threads (thread_id, agent_id, provider_session_id, workspace, mode, task_id, task_attempt_id, title, created_at, updated_at) ' +
    'VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    thread.thread_id, thread.agent_id, thread.workspace, thread.mode,
    thread.task_id, thread.task_attempt_id, thread.title, thread.created_at, thread.updated_at,
  );
  return getThread(db, thread.thread_id);
}

export function getThread(db, threadId) {
  if (!isId(threadId)) return null;
  return mapThread(getRow(db, 'SELECT * FROM chat_threads WHERE thread_id = ?', [threadId]));
}

export function requireThread(db, threadId) {
  const thread = getThread(db, threadId);
  if (!thread) throw notFound('THREAD_NOT_FOUND', `对话不存在：${threadId}`);
  return thread;
}

/** 按 agent 列对话，最近用过的在前 */
export function listThreads(db, { agentId = null, limit = 50 } = {}) {
  const where = [];
  const params = [];
  if (agentId) { where.push('agent_id = ?'); params.push(agentId); }
  const sql = 'SELECT * FROM chat_threads' + (where.length ? ` WHERE ${where.join(' AND ')}` : '')
    + ' ORDER BY updated_at DESC, created_at DESC LIMIT ?';
  return allRows(db, sql, [...params, Math.max(1, Number(limit) || 50)]).map(mapThread);
}

/**
 * 回填 provider 的真实 Session ID（首轮 CLI 返回后调用，只此一处写这一列）。
 * 已经有值且不一样时不覆盖——一个 thread 只认它第一次拿到的那个 Session。
 */
export function setProviderSession(db, threadId, providerSessionId, now = null) {
  if (!providerSessionId) return getThread(db, threadId);
  const current = requireThread(db, threadId);
  if (current.provider_session_id && current.provider_session_id !== providerSessionId) return current;
  db.prepare('UPDATE chat_threads SET provider_session_id = ?, updated_at = ? WHERE thread_id = ?')
    .run(String(providerSessionId), stamp(now), threadId);
  return getThread(db, threadId);
}

export function touchThread(db, threadId, now = null) {
  db.prepare('UPDATE chat_threads SET updated_at = ? WHERE thread_id = ?').run(stamp(now), threadId);
}

/**
 * provider 说「找不到这个会话」时清掉引用：下一轮会重新开一个会话（旧上下文不保留，界面会如实说明）。
 * 与 setProviderSession 相反，只这一处会把该列置空。
 */
export function clearProviderSession(db, threadId, now = null) {
  db.prepare('UPDATE chat_threads SET provider_session_id = NULL, updated_at = ? WHERE thread_id = ?').run(stamp(now), threadId);
  return getThread(db, threadId);
}

/** 对话标题只取第一句话的开头，给「历史对话」切换用；已经有了就不覆盖 */
export function setThreadTitleIfEmpty(db, threadId, title, now = null) {
  const text = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!text) return;
  db.prepare('UPDATE chat_threads SET title = ?, updated_at = ? WHERE thread_id = ? AND title IS NULL')
    .run(text, stamp(now), threadId);
}

/* ---------------- messages ---------------- */

function nextMessageSeq(db, threadId) {
  const row = getRow(db, 'SELECT COALESCE(MAX(seq), 0) AS n FROM chat_messages WHERE thread_id = ?', [threadId]);
  return (row ? Number(row.n) : 0) + 1;
}

export function appendMessage(db, input = {}) {
  const { threadId, turnId = null, role, content, status, now = null } = input;
  if (!['user', 'assistant', 'system'].includes(role)) throw badRequest(`role 非法：${role}`);
  if (typeof content !== 'string') throw badRequest('content 必须是字符串');
  const at = stamp(now);
  const seq = nextMessageSeq(db, threadId);
  const messageId = input.messageId || newMessageId();
  db.prepare(
    'INSERT INTO chat_messages (message_id, thread_id, turn_id, role, content, status, error_json, seq, event_seq, created_at, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 0, ?, ?)',
  ).run(messageId, threadId, turnId, role, content, status, seq, at, at);
  db.prepare('UPDATE chat_threads SET updated_at = ? WHERE thread_id = ?').run(at, threadId);
  return getMessage(db, messageId);
}

export function getMessage(db, messageId) {
  return mapMessage(getRow(db, 'SELECT * FROM chat_messages WHERE message_id = ?', [messageId]));
}

export function listMessages(db, threadId, { limit = 2000 } = {}) {
  return allRows(db, 'SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY seq ASC LIMIT ?', [threadId, Math.max(1, Number(limit) || 2000)])
    .map(mapMessage);
}

export function setMessageStatus(db, messageId, status, { error = null, now = null } = {}) {
  db.prepare('UPDATE chat_messages SET status = ?, error_json = ?, updated_at = ? WHERE message_id = ?')
    .run(status, error ? JSON.stringify(error) : null, stamp(now), messageId);
  return getMessage(db, messageId);
}

/** 助手消息内容落盘（增量批量写）。event_seq = 这一刻已落库的事件序号，SSE 续订靠它对齐。 */
export function setMessageContent(db, messageId, content, { eventSeq, status = null, error = undefined, now = null } = {}) {
  const sets = ['content = ?', 'event_seq = ?', 'updated_at = ?'];
  const params = [content, eventSeq, stamp(now)];
  if (status) { sets.push('status = ?'); params.push(status); }
  if (error !== undefined) { sets.push('error_json = ?'); params.push(error ? JSON.stringify(error) : null); }
  params.push(messageId);
  db.prepare(`UPDATE chat_messages SET ${sets.join(', ')} WHERE message_id = ?`).run(...params);
  return getMessage(db, messageId);
}

/* ---------------- turns ---------------- */

/**
 * 建一轮：同一次调用里落「用户消息 + 轮次」，两者同生成败——
 * 消息一旦受理就一定能在库 里查到（T6：消息不丢）。
 */
export function createTurn(db, input = {}) {
  const { threadId, content, provider, resume, retryOfTurnId = null, now = null } = input;
  if (typeof content !== 'string' || content.trim() === '') throw badRequest('content 不能为空');
  const at = stamp(now);
  const turnId = input.turnId || newTurnId();
  return transaction(db, () => {
    const userMsg = appendMessage(db, { threadId, turnId, role: 'user', content, status: 'stored', now: at });
    db.prepare(
      'INSERT INTO chat_turns (turn_id, thread_id, attempt_id, user_message_id, assistant_message_id, status, provider, resume, retry_of_turn_id, ' +
      'error_json, started_at, ended_at, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, NULL, ?)',
    ).run(turnId, threadId, newChatAttemptId(), userMsg.message_id, TURN.QUEUED, provider, resume ? 1 : 0, retryOfTurnId, at);
    return getTurn(db, turnId);
  });
}

export function getTurn(db, turnId) {
  if (!isId(turnId)) return null;
  return mapTurn(getRow(db, 'SELECT * FROM chat_turns WHERE turn_id = ?', [turnId]));
}

export function requireTurn(db, turnId) {
  const turn = getTurn(db, turnId);
  if (!turn) throw notFound('TURN_NOT_FOUND', `轮次不存在：${turnId}`);
  return turn;
}

export function latestTurn(db, threadId) {
  return mapTurn(getRow(db, 'SELECT * FROM chat_turns WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', [threadId]));
}

export function listTurns(db, threadId, { limit = 200 } = {}) {
  return allRows(db, 'SELECT * FROM chat_turns WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
    [threadId, Math.max(1, Number(limit) || 200)]).map(mapTurn);
}

export function nextQueuedTurn(db, threadId) {
  return mapTurn(getRow(db,
    "SELECT * FROM chat_turns WHERE thread_id = ? AND status = 'queued' ORDER BY created_at ASC, rowid ASC LIMIT 1", [threadId]));
}

export function countQueuedTurns(db, threadId) {
  return Number(getRow(db, "SELECT COUNT(*) AS n FROM chat_turns WHERE thread_id = ? AND status = 'queued'", [threadId]).n);
}

/** 这一轮前面还排着几轮（同一对话串行，按建轮先后）。给界面显示「排队中，前面还有 N 条」 */
export function queuedAhead(db, turn) {
  return Number(getRow(db,
    "SELECT COUNT(*) AS n FROM chat_turns WHERE thread_id = ? AND status = 'queued' AND (created_at < ? OR (created_at = ? AND rowid < ?))",
    [turn.thread_id, turn.created_at, turn.created_at, turn.rowid ?? Number.MAX_SAFE_INTEGER]).n);
}

export function listActiveTurns(db) {
  const marks = ACTIVE_TURN_STATUS.size ? [...ACTIVE_TURN_STATUS].map(() => '?').join(',') : "''";
  // 限流重试中的轮次（rate_limited 且没写 ended_at）也还在进行：服务重启时同样要落成 interrupted
  return allRows(db, `SELECT * FROM chat_turns WHERE status IN (${marks}) OR (status = 'rate_limited' AND ended_at IS NULL) ORDER BY created_at ASC`,
    [...ACTIVE_TURN_STATUS]).map(mapTurn);
}

export function setTurnStatus(db, turnId, status, { startedAt = undefined, now = null } = {}) {
  db.prepare('UPDATE chat_turns SET status = ?, started_at = COALESCE(started_at, ?) WHERE turn_id = ?')
    .run(status, startedAt === undefined ? stamp(now) : startedAt, turnId);
  return getTurn(db, turnId);
}

export function finishTurn(db, turnId, { status, error = null, now = null }) {
  const at = stamp(now);
  db.prepare('UPDATE chat_turns SET status = ?, error_json = ?, ended_at = ? WHERE turn_id = ?')
    .run(status, error ? JSON.stringify(error) : null, at, turnId);
  return getTurn(db, turnId);
}

/** 本轮的助手消息（开跑时先建一条空消息，失败也挂在它上面，用户看得到原因） */
export function attachAssistantMessage(db, turnId, messageId) {
  db.prepare('UPDATE chat_turns SET assistant_message_id = ? WHERE turn_id = ?').run(messageId, turnId);
  return getTurn(db, turnId);
}

/* ---------------- approvals ---------------- */

/** 记一次「provider 想做需要确认的事」。讨论模式不放行：decision 一律 denied 并写明依据。 */
export function appendApproval(db, { turnId, action, decision = 'denied', now = null }) {
  const at = stamp(now);
  const approvalId = `ap-${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  db.prepare('INSERT INTO chat_approvals (approval_id, turn_id, action, decision, decided_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(approvalId, turnId, typeof action === 'string' ? action.slice(0, 2000) : JSON.stringify(action).slice(0, 2000), decision, at, at);
  return getRow(db, 'SELECT * FROM chat_approvals WHERE approval_id = ?', [approvalId]);
}

/* ---------------- events ---------------- */

export function lastEventSeq(db, turnId) {
  const row = getRow(db, 'SELECT COALESCE(MAX(seq), 0) AS n FROM chat_events WHERE turn_id = ?', [turnId]);
  return row ? Number(row.n) : 0;
}

/** 这一轮序号最大的那条事件（判断事件日志是不是已经以 terminal 收尾） */
export function lastChatEvent(db, turnId) {
  return mapEvent(getRow(db, 'SELECT * FROM chat_events WHERE turn_id = ? ORDER BY seq DESC LIMIT 1', [turnId]));
}

/** 在事务里追加一条事件并回写消息的 event_seq（两步同生成败，续订才不会重发或漏发） */
export function appendChatEvent(db, { turnId, seq, type, payload = null, messageId = null, content = undefined, now = null }) {
  const at = stamp(now);
  return transaction(db, () => {
    db.prepare('INSERT INTO chat_events (turn_id, seq, type, payload, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(turnId, seq, type, payload === null || payload === undefined ? null : JSON.stringify(payload), at);
    if (messageId) {
      if (content === undefined) {
        db.prepare('UPDATE chat_messages SET event_seq = ?, updated_at = ? WHERE message_id = ?').run(seq, at, messageId);
      } else {
        db.prepare('UPDATE chat_messages SET event_seq = ?, content = ?, updated_at = ? WHERE message_id = ?').run(seq, content, at, messageId);
      }
    }
    return mapEvent(getRow(db, 'SELECT * FROM chat_events WHERE turn_id = ? AND seq = ?', [turnId, seq]));
  });
}

export function listChatEvents(db, turnId, { afterSeq = 0, limit = 5000 } = {}) {
  return allRows(db, 'SELECT * FROM chat_events WHERE turn_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
    [turnId, Number(afterSeq) || 0, Math.max(1, Number(limit) || 5000)]).map(mapEvent);
}

/**
 * 对账（服务启动 / 停止时）：库里还在「进行中」的轮次，本进程并没有在跑它们——
 * 一律落成 interrupted 并写明原因，绝不挂着一个没人盯的 running。
 */
export function reconcileActiveTurns(db, { kind, message, now = null } = {}) {
  const at = stamp(now);
  const stale = listActiveTurns(db);
  for (const turn of stale) {
    let saved = 0;
    if (turn.assistant_message_id) {
      const m = getMessage(db, turn.assistant_message_id);
      if (m) {
        saved = m.content.length;   // 已落库的增量一个字不丢，留给人核对
        if (m.status === 'streaming') setMessageStatus(db, m.message_id, 'interrupted', { now: at });
      }
    }
    if (turn.user_message_id) {
      const u = getMessage(db, turn.user_message_id);
      // 用户消息内容一定还在；只是「有没有交出去」无法确认 → 不改成 sent
      if (u && u.status === 'sent') setMessageStatus(db, u.message_id, 'unknown', { now: at });
    }
    const turnMsg = message || '服务重启，本轮执行中断';
    const text = saved > 0 ? `${turnMsg}；已保存 ${saved} 字输出，请核对后再决定是否重试` : turnMsg;
    finishTurn(db, turn.turn_id, {
      status: TURN.INTERRUPTED,
      error: { kind, code: kind, reason: kind, label: errorLabel(kind), message: text, text, retryable: true, retry_hint: null, retry_at: null },
      now: at,
    });
  }
  return stale.length;
}

/* ---------------- 线程状态（给界面用，带证据） ---------------- */

/**
 * 一个对话现在什么状态——只看最新一轮的真实记录：
 *   没有任何轮次 → unknown（没有证据，不显示空闲）
 *   最新一轮还在进行 → 它的实时状态
 *   最新一轮已终态 → 它的终态与原因
 */
export function threadStatusOf(db, thread) {
  if (!thread) {
    return {
      status: TURN.UNKNOWN, error_kind: null,
      reason: '对话不存在，没有证据判断状态', evidence_source: 'none', observed_at: null,
    };
  }
  const last = latestTurn(db, thread.thread_id);
  if (!last) {
    return {
      status: TURN.UNKNOWN, error_kind: null,
      reason: '还没有对话记录：没有证据判断该 Agent 的对话状态，不显示空闲',
      evidence_source: 'none', observed_at: null,
    };
  }
  const errorKind = last.error && last.error.kind ? last.error.kind : null;
  return {
    status: last.status,
    error_kind: errorKind,
    reason: last.error && last.error.message ? last.error.message : null,
    retry_hint: last.error && last.error.retry_hint ? last.error.retry_hint : null,
    retry_at: last.error && last.error.retry_at ? last.error.retry_at : null,
    evidence_source: 'chat_turns',
    observed_at: last.ended_at || last.started_at || last.created_at,
    turn_id: last.turn_id,
    // 排队中的轮次（同一对话串行）：界面据此显示「还有 N 条在排队」
    queued: countQueuedTurns(db, thread.thread_id),
  };
}
