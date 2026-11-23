// events.mjs — 事件写入与查询。
//
// 事件是「真实发生的事」，也是状态机的唯一事实来源。看板上每个状态都必须能
// 顺着 task_id 追到事件行，因此本模块做三件事：
//   1) appendEvent：统一写入口，payload 序列化、时间戳规范化；
//   2) queryEvents / latestEvent：按任务、执行实例、类型、证据来源查询；
//   3) 事件语义辅助：阻塞原因分类、验收记录、产物计数。
//
// evidence_source 取值（对应任务书 §4 证据优先级）：
//   executor(P0)      Agent Office 托管的执行器实例
//   cli_event(P1)     CLI 结构化事件 / hooks
//   checkpoint(P2)    任务检查点 / 验证记录
//   verifier(P2)      验收结果（人工或测试脚本）
//   git(P3)           Git / 文件系统
//   process_probe(P4) 进程探测 / 日志 mtime —— 不能单独证明在工作
//   external          Claude/Codex 等外部终端（只有 P4 能力，执行状态只能是 unknown）
//   self_report       Hermes 自报
//   system / user     系统与人工操作（迁移、建任务等）

import { allRows, getRow } from './db.mjs';

export const EVIDENCE = {
  EXECUTOR: 'executor',
  CLI_EVENT: 'cli_event',
  CHECKPOINT: 'checkpoint',
  VERIFIER: 'verifier',
  GIT: 'git',
  PROCESS_PROBE: 'process_probe',
  EXTERNAL: 'external',
  SELF_REPORT: 'self_report',
  SYSTEM: 'system',
  USER: 'user',
};

/** 数字越小证据越强。用于状态机挑「凭什么」的来源。 */
export const EVIDENCE_PRIORITY = {
  executor: 0,
  cli_event: 1,
  checkpoint: 2,
  verifier: 2,
  git: 3,
  process_probe: 4,
  external: 4,
  self_report: 5,
  system: 8,
  user: 8,
};

/** 只够证明「有活动」，不够证明「任务做对了」的来源。 */
export const WEAK_SOURCES = new Set(['process_probe', 'external', 'self_report']);

export function evidencePriority(source) {
  return EVIDENCE_PRIORITY[source] ?? 7;
}

function nowIso(now) {
  return (now instanceof Date ? now : new Date(now ?? Date.now())).toISOString();
}

export function encodePayload(payload) {
  if (payload === undefined || payload === null) return null;
  if (typeof payload === 'string') return JSON.stringify({ text: payload });
  try {
    return JSON.stringify(payload);
  } catch {
    return JSON.stringify({ text: String(payload) });
  }
}

export function decodePayload(text) {
  if (text === null || text === undefined || text === '') return null;
  try { return JSON.parse(text); } catch { return { raw: String(text) }; }
}

function mapEvent(row) {
  if (!row) return null;
  return {
    event_id: row.event_id,
    task_id: row.task_id,
    attempt_id: row.attempt_id,
    agent_id: row.agent_id,
    event_type: row.event_type,
    payload: decodePayload(row.payload),
    evidence_source: row.evidence_source,
    observed_at: row.observed_at,
  };
}

/**
 * 写一条事件。
 * 注意：不在这里刷新任务状态，避免「写事件 → 刷新状态 → 又写状态事件」的递归。
 * 调用方需要落状态时显式调用 refreshTaskState。
 */
export function appendEvent(db, input = {}) {
  const {
    taskId = null, attemptId = null, agentId = null,
    eventType, payload = null, evidenceSource = EVIDENCE.SYSTEM,
    observedAt = null,
  } = input;
  if (!eventType || typeof eventType !== 'string') {
    throw Object.assign(new Error('appendEvent 需要 event_type'), { code: 'BAD_EVENT_TYPE', statusCode: 400 });
  }
  if (!evidenceSource || typeof evidenceSource !== 'string') {
    throw Object.assign(new Error('appendEvent 需要 evidence_source'), { code: 'BAD_EVIDENCE_SOURCE', statusCode: 400 });
  }
  const at = nowIso(observedAt);
  const info = db.prepare(
    'INSERT INTO events (task_id, attempt_id, agent_id, event_type, payload, evidence_source, observed_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(taskId, attemptId, agentId, eventType, encodePayload(payload), evidenceSource, at);
  return mapEvent(getRow(db, 'SELECT * FROM events WHERE event_id = ?', [info.lastInsertRowid]));
}

/** 查询事件；默认按时间升序（时间线），desc=true 时倒序。 */
export function queryEvents(db, filters = {}) {
  const {
    taskId = null, attemptId = null, agentId = null, types = null,
    evidenceSources = null, since = null, until = null,
    limit = 500, desc = false,
  } = filters;
  const where = [];
  const params = [];
  if (taskId) { where.push('task_id = ?'); params.push(taskId); }
  if (attemptId) { where.push('attempt_id = ?'); params.push(attemptId); }
  if (agentId) { where.push('agent_id = ?'); params.push(agentId); }
  if (Array.isArray(types) && types.length) {
    where.push(`event_type IN (${types.map(() => '?').join(',')})`);
    params.push(...types);
  }
  if (Array.isArray(evidenceSources) && evidenceSources.length) {
    where.push(`evidence_source IN (${evidenceSources.map(() => '?').join(',')})`);
    params.push(...evidenceSources);
  }
  if (since) { where.push('observed_at >= ?'); params.push(since); }
  if (until) { where.push('observed_at <= ?'); params.push(until); }
  const sql = 'SELECT * FROM events'
    + (where.length ? ` WHERE ${where.join(' AND ')}` : '')
    + ` ORDER BY observed_at ${desc ? 'DESC' : 'ASC'}, event_id ${desc ? 'DESC' : 'ASC'}`
    + ' LIMIT ?';
  return allRows(db, sql, [...params, Math.max(1, Number(limit) || 500)]).map(mapEvent);
}

export function latestEvent(db, filters = {}) {
  const rows = queryEvents(db, { ...filters, limit: 1, desc: true });
  return rows[0] || null;
}

export function countEvents(db, filters = {}) {
  const where = [];
  const params = [];
  if (filters.taskId) { where.push('task_id = ?'); params.push(filters.taskId); }
  if (filters.attemptId) { where.push('attempt_id = ?'); params.push(filters.attemptId); }
  if (filters.types) {
    where.push(`event_type IN (${filters.types.map(() => '?').join(',')})`);
    params.push(...filters.types);
  }
  const row = getRow(db, 'SELECT COUNT(*) AS n FROM events'
    + (where.length ? ` WHERE ${where.join(' AND ')}` : ''), params);
  return row ? row.n : 0;
}

/**
 * 失败/阻塞文本分类。宁可归到 other，也不把「限额」和「认证失败」混成一个。
 * 返回任务书 §2.2 规定的四个 blocked reason 之一。
 */
export function classifyFailure(text) {
  const s = String(text || '');
  if (/5\s*[-_]?\s*h(our)?|five.?hour|usage.?limit|quota|额度|用量上限|使用上限/i.test(s)) {
    return 'quota_5h';
  }
  if (/rate.?limit|too many requests|429|限流|频率/i.test(s)) {
    return 'rate_limit_temp';
  }
  if (/auth|unauthor|401|403|login|credential|认证|登录|凭据/i.test(s)) {
    return 'auth_failed';
  }
  return 'other';
}

const BLOCK_EVENT_OF_REASON = {
  quota_5h: 'quota_exhausted',
  rate_limit_temp: 'rate_limit',
  auth_failed: 'auth_failed',
  other: 'api_error',
};

/**
 * 记录一次明确阻塞。状态机只认这里写出的四类事件 + reason。
 * 返回 {event, reason}。
 */
export function recordBlockEvent(db, input = {}) {
  const {
    taskId, attemptId = null, agentId = null, reason = null,
    message = '', evidenceSource = EVIDENCE.CLI_EVENT,
    observedAt = null, payload = {},
  } = input;
  const classified = reason && BLOCK_EVENT_OF_REASON[reason] ? reason : classifyFailure(message);
  const eventType = BLOCK_EVENT_OF_REASON[classified];
  const event = appendEvent(db, {
    taskId, attemptId, agentId,
    eventType,
    payload: { reason: classified, message: String(message || ''), ...payload },
    evidenceSource,
    observedAt,
  });
  return { event, reason: classified };
}

/** 记录验收结果：completed 的唯一合法入口是 acceptance_passed。note 是给人看的说明（可选，不参与状态判定）。 */
export function recordAcceptance(db, input = {}) {
  const {
    taskId, attemptId = null, result, codeSha = null, command = null,
    report = null, evidenceSource = EVIDENCE.VERIFIER, observedAt = null, note = null,
  } = input;
  if (result !== 'passed' && result !== 'failed') {
    throw Object.assign(new Error('验收结果必须是 passed 或 failed'), { code: 'BAD_ACCEPTANCE', statusCode: 400 });
  }
  const event = appendEvent(db, {
    taskId, attemptId,
    eventType: result === 'passed' ? 'acceptance_passed' : 'acceptance_failed',
    payload: { result, code_sha: codeSha, command, report, note: note ? String(note).slice(0, 1000) : null },
    evidenceSource,
    observedAt,
  });
  return event;
}

export function latestAcceptance(db, taskId) {
  return latestEvent(db, { taskId, types: ['acceptance_passed', 'acceptance_failed'] });
}

/**
 * 产物计数。只认显式 artifact_produced 事件里的文件路径，
 * 不把「进程还活着」或「改了某个文件」当成交付物。
 */
export function countArtifacts(db, taskId) {
  const events = queryEvents(db, { taskId, types: ['artifact_produced'], limit: 10000 });
  const set = new Map();
  let latestAt = null;
  for (const e of events) {
    const files = e.payload && Array.isArray(e.payload.files) ? e.payload.files : [];
    for (const f of files) {
      const p = typeof f === 'string' ? f : (f && (f.path || f.file));
      if (!p) continue;
      set.set(String(p), {
        path: String(p),
        bytes: typeof f === 'object' && f ? (f.bytes ?? null) : null,
        sha256: typeof f === 'object' && f ? (f.sha256 ?? null) : null,
        at: e.observed_at,
      });
    }
    if (files.length && (!latestAt || e.observed_at > latestAt)) latestAt = e.observed_at;
  }
  const paths = [...set.values()];
  return { count: paths.length, paths, latest_at: latestAt };
}
