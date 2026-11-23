// state-machine.mjs — 七状态判定：全项目唯一入口。
//
// 三条硬规矩（任务书 §2.2）：
//   1) 没有最新可信证据时显示 unknown，永远不用 idle 兜底；
//   2) blocked 必须带 reason：quota_5h / rate_limit_temp / auth_failed / other；
//   3) completed 必须绑定验收通过，Agent 自称完成不算。
//
// 状态只是「结论」，本模块同时回答「凭什么」：每个结论都带
// evidence_source（P0–P4 来源）、observed_at（证据观测时间）、status_reason。
//
// 三种状态不合并：
//   evaluateTaskState        任务状态——做到哪了，能不能交付
//   evaluateAgentStatuses    每个 Agent 的 可用 / 执行 / 任务 三个独立对象
//
// 任务状态判定的优先级（从高到低）：
//   完成（验收通过）> 阻塞 > 明确等待 > 自称完成待验收 > 外部证据（unknown）
//   > 活动中的实例（running/interrupted/unknown）> 无实例时的中断/待验/待开始

import { getRow } from './db.mjs';
import {
  queryEvents, latestEvent, EVIDENCE, WEAK_SOURCES, evidencePriority, classifyFailure,
} from './events.mjs';
import {
  getTask, getSteps, summarizeSteps, updateTaskStatus,
} from './tasks.mjs';
import {
  listAttempts, endAttempt, isPidAlive, strongestSource,
} from './attempts.mjs';
import { latestCheckpoint } from './checkpoint.mjs';

export const STATES = Object.freeze({
  RUNNING: 'running',
  WAITING: 'waiting',
  IDLE: 'idle',
  BLOCKED: 'blocked',
  INTERRUPTED: 'interrupted',
  UNKNOWN: 'unknown',
  COMPLETED: 'completed',
});

export const STATE_VALUES = Object.freeze(Object.values(STATES));

export const BLOCK_REASONS = Object.freeze({
  QUOTA_5H: 'quota_5h',
  RATE_LIMIT_TEMP: 'rate_limit_temp',
  AUTH_FAILED: 'auth_failed',
  OTHER: 'other',
});

export const DEFAULT_THRESHOLDS = Object.freeze({
  /** 有活动事件、但进程探测不到 pid 时，超过这个时长就不能再断言 running。 */
  activityMs: 5 * 60 * 1000,
  /** 超过这个时长仍无任何证据 → unknown（观测链路失效）。 */
  staleMs: 30 * 60 * 1000,
});

const EXTERNAL_AGENTS = new Set(['claude', 'codex']);

const ACTIVITY_EVENTS = new Set([
  'thinking', 'tool_call', 'step_end', 'artifact_produced', 'dsh_event',
  'heartbeat', 'permission_request', 'permission_granted', 'user_input_received',
  'external_activity', 'external_probe', 'claim_done',
]);

const PROGRESS_EVENTS = new Set([
  'artifact_produced', 'step_end', 'checkpoint_created', 'step_completed',
  'acceptance_passed', 'acceptance_failed',
]);

const BLOCK_EVENTS = new Set(['quota_exhausted', 'rate_limit', 'auth_failed', 'block_cleared']);

const WAIT_EVENTS = new Set(['permission_request', 'waiting_user', 'waiting_external', 'verification_pending']);

const RESUME_EVENTS = new Set([
  'permission_granted', 'user_input_received', 'external_ready', 'block_cleared', 'resume', 'attempt_started',
]);

// 这些事件是「状态衍生物」，不能反过来当作活动/阻塞证据。
const DERIVED_EVENTS = new Set(['status_changed', 'legacy_imported', 'task_created', 'attempt_ended']);

function isoOf(now) {
  if (now instanceof Date) return now.toISOString();
  if (typeof now === 'number') return new Date(now).toISOString();
  if (typeof now === 'string' && now) {
    const t = Date.parse(now);
    return Number.isNaN(t) ? new Date().toISOString() : new Date(t).toISOString();
  }
  return new Date().toISOString();
}

function afterOrSame(a, b) {
  if (!a) return false;
  if (!b) return true;
  if (a.observed_at !== b.observed_at) return a.observed_at > b.observed_at;
  return a.event_id > b.event_id;
}

function latestOf(events, types) {
  const set = types instanceof Set ? types : new Set(types);
  let out = null;
  for (const e of events) {
    if (!set.has(e.event_type)) continue;
    if (!out || afterOrSame(e, out)) out = e;
  }
  return out;
}

function isBlockEvent(e) {
  if (!e) return false;
  if (BLOCK_EVENTS.has(e.event_type)) return e.event_type !== 'block_cleared';
  // 通用 api_error：带 reason 或消息文本能明确归类（额度/限流/认证）才算阻塞；
  // 普通工具报错不改变任务状态。
  if (e.event_type === 'api_error') {
    if (e.payload && e.payload.reason) return true;
    const text = e.payload ? (e.payload.message || e.payload.error || e.payload.text || '') : '';
    return classifyFailure(typeof text === 'string' ? text : JSON.stringify(text)) !== 'other';
  }
  return false;
}

function blockReasonOf(event) {
  const raw = event && event.payload ? event.payload.reason : null;
  if (raw && Object.values(BLOCK_REASONS).includes(raw)) return raw;
  if (event && event.event_type === 'quota_exhausted') return BLOCK_REASONS.QUOTA_5H;
  if (event && event.event_type === 'rate_limit') return BLOCK_REASONS.RATE_LIMIT_TEMP;
  if (event && event.event_type === 'auth_failed') return BLOCK_REASONS.AUTH_FAILED;
  const text = event && event.payload ? (event.payload.message || event.payload.error || event.payload.text || '') : '';
  return classifyFailure(typeof text === 'string' ? text : JSON.stringify(text));
}

function ageMs(at, nowMs) {
  const t = Date.parse(at || '');
  if (Number.isNaN(t)) return Infinity;
  return Math.max(0, nowMs - t);
}

function reasonText(ms) {
  const sec = Math.round(ms / 1000);
  if (sec < 90) return `${sec} 秒`;
  const min = Math.round(sec / 60);
  if (min < 90) return `${min} 分钟`;
  return `${Math.round(min / 60)} 小时`;
}

function verificationOf(acceptance) {
  if (!acceptance) {
    return { result: 'none', code_sha: null, command: null, report: null, observed_at: null, evidence_source: null };
  }
  const p = acceptance.payload || {};
  return {
    result: p.result || (acceptance.event_type === 'acceptance_passed' ? 'passed' : 'failed'),
    code_sha: p.code_sha ?? null,
    command: p.command ?? null,
    report: p.report ?? null,
    observed_at: acceptance.observed_at,
    evidence_source: acceptance.evidence_source,
  };
}

function runningReason(lastActivityAt, nowMs, alive) {
  if (!lastActivityAt) {
    return alive === true
      ? '托管实例进程存活，尚未收到首个活动事件'
      : '托管实例正在启动，尚未收到活动事件';
  }
  const ms = ageMs(lastActivityAt, nowMs);
  return alive === true
    ? `托管实例在运行，最近 ${reasonText(ms)}有活动事件`
    : `托管实例在运行，最近 ${reasonText(ms)}有活动事件（进程探测不可用）`;
}

function interruptedReason(attempt, event) {
  if (event && event.payload && event.payload.reason) return event.payload.reason;
  const map = {
    crash: '执行实例进程消失，任务未完成',
    user_stop: '用户主动停止执行实例，任务未完成',
    quota_blocked: '额度阻塞后执行实例结束，任务等待接力',
    handoff: '写入权已交接，原执行实例结束',
    spawn_failed: '接力实例启动失败，任务等待恢复',
    auth_failed: '认证失败导致执行实例结束',
    done: '执行实例已结束，任务尚未通过验收',
  };
  return map[attempt && attempt.end_reason] || '执行实例意外终止，任务未完成';
}

/**
 * 纯判定：给定任务、实例、事件，返回状态对象。
 * 不写库，便于测试与「先算后写」。
 */
export function deriveTaskState(input = {}) {
  const { task, attempts = [], events = [], checkpoint = null, now = new Date(), thresholds = {} } = input;
  const th = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const nowMs = Date.parse(isoOf(now));
  const nowIso = isoOf(now);

  // 只保留与任务/实例直接相关、且不是状态衍生物的事件；按时间升序。
  const relevant = events
    .filter((e) => !DERIVED_EVENTS.has(e.event_type))
    .sort((a, b) => (a.observed_at === b.observed_at ? a.event_id - b.event_id : a.observed_at < b.observed_at ? -1 : 1));

  const lastEvent = relevant.length ? relevant[relevant.length - 1] : null;
  const acceptance = latestOf(relevant, ['acceptance_passed', 'acceptance_failed']);
  const verification = verificationOf(acceptance);
  const claimDone = latestOf(relevant, ['claim_done']);
  const blockEvent = [...relevant].reverse().find(isBlockEvent) || null;
  const cleared = latestOf(relevant, ['block_cleared']);
  const waitEvent = latestOf(relevant, WAIT_EVENTS);
  const resumeEvent = latestOf(relevant, RESUME_EVENTS);

  const lastAttempt = attempts[0] || null;
  // 只有「最新一次尝试」才算活动实例；更早的 running 行是孤儿，交给 reconcile。
  const active = lastAttempt && lastAttempt.status === 'running' ? lastAttempt : null;

  const activityEvents = relevant.filter((e) => ACTIVITY_EVENTS.has(e.event_type));
  const progressEvents = relevant.filter((e) => PROGRESS_EVENTS.has(e.event_type));
  const lastActivityEvent = activityEvents.length ? activityEvents[activityEvents.length - 1] : null;
  const lastProgressEvent = progressEvents.length ? progressEvents[progressEvents.length - 1] : null;
  const lastActivityAt = lastActivityEvent
    ? lastActivityEvent.observed_at
    : (active ? active.started_at : (lastAttempt ? lastAttempt.started_at : null));
  const lastProgressAt = lastProgressEvent
    ? lastProgressEvent.observed_at
    : (checkpoint ? checkpoint.created_at : null);

  const hasExecutorAttempt = attempts.some((a) => !EXTERNAL_AGENTS.has(a.agent_id) && a.agent_id !== 'hermes');
  const externalEvidence = relevant.filter((e) => WEAK_SOURCES.has(e.evidence_source));
  const externalOnly = !hasExecutorAttempt && externalEvidence.length > 0
    && externalEvidence.length === relevant.filter((e) => !DERIVED_EVENTS.has(e.event_type)).length;
  const lastExternal = externalEvidence.length ? externalEvidence[externalEvidence.length - 1] : null;

  // 进程存活：显式 process_exit 优先，其次 pid 探测，最后 null（未知）。
  const exitEvent = active
    ? latestOf(relevant.filter((e) => e.attempt_id === active.attempt_id), ['process_exit'])
    : null;
  let processAlive = null;
  if (active) {
    if (exitEvent) processAlive = false;
    else if (active.pid != null) processAlive = isPidAlive(active.pid);
  }

  const base = {
    task_id: task.task_id,
    status: STATES.UNKNOWN,
    status_reason: '状态未知',
    evidence_source: EVIDENCE.SYSTEM,
    observed_at: nowIso,
    evaluated_at: nowIso,
    last_activity_at: lastActivityAt,
    last_progress_at: lastProgressAt,
    last_event_type: lastEvent ? lastEvent.event_type : null,
    attempt_id: active ? active.attempt_id : (lastAttempt ? lastAttempt.attempt_id : null),
    attempt_status: active ? active.status : (lastAttempt ? lastAttempt.status : null),
    active_attempt_id: active ? active.attempt_id : null,
    process_alive: processAlive,
    relay_pending: Boolean(active && active.relay_pending),
    blocked_reason: null,
    verification,
    acceptance: acceptance
      ? { event_type: acceptance.event_type, observed_at: acceptance.observed_at, evidence_source: acceptance.evidence_source }
      : null,
  };

  const finish = (status, statusReason, evidenceSource, observedAt) => ({
    ...base,
    status,
    status_reason: statusReason,
    evidence_source: evidenceSource || EVIDENCE.SYSTEM,
    observed_at: observedAt || (lastEvent ? lastEvent.observed_at : nowIso),
  });

  // ① 完成：必须有一条 acceptance_passed；若绑定了 code_sha，必须与最新检查点一致。
  // 如果验收之后又起了新实例，说明任务被重新打开，旧验收不再代表当前现场。
  const acceptanceSuperseded = active && acceptance && active.started_at > acceptance.observed_at;
  if (acceptance && acceptance.event_type === 'acceptance_passed' && !acceptanceSuperseded) {
    const sha = verification.code_sha;
    if (!sha) {
      return finish(STATES.COMPLETED, '验收通过（未绑定代码版本）', acceptance.evidence_source, acceptance.observed_at);
    }
    if (!checkpoint || !checkpoint.git_sha) {
      return finish(STATES.WAITING,
        `验收通过，但找不到绑定 ${String(sha).slice(0, 12)} 的检查点，待复核`,
        acceptance.evidence_source, acceptance.observed_at);
    }
    if (checkpoint.git_sha !== sha) {
      return finish(STATES.WAITING,
        `验收针对 ${String(sha).slice(0, 12)}，最新检查点是 ${String(checkpoint.git_sha).slice(0, 12)}，待重新验收`,
        acceptance.evidence_source, acceptance.observed_at);
    }
    return finish(STATES.COMPLETED, '验收通过，代码版本与检查点一致', acceptance.evidence_source, acceptance.observed_at);
  }

  // ② 明确阻塞：只认带 reason 的四类事件，且之后没有 block_cleared / 新实例。
  if (blockEvent && (!cleared || afterOrSame(blockEvent, cleared)) && (!resumeEvent || afterOrSame(blockEvent, resumeEvent))) {
    const reason = blockReasonOf(blockEvent);
    const msg = blockEvent.payload && blockEvent.payload.message ? `：${String(blockEvent.payload.message).slice(0, 160)}` : '';
    return {
      ...finish(STATES.BLOCKED, `执行受阻（${reason}）${msg}`, blockEvent.evidence_source, blockEvent.observed_at),
      blocked_reason: reason,
    };
  }

  // ③ 明确等待：权限 / 用户输入 / 外部依赖，且之后没有恢复事件。
  if (waitEvent && (!resumeEvent || afterOrSame(waitEvent, resumeEvent))) {
    const map = {
      permission_request: '等待你确认权限',
      waiting_user: '等待你输入',
      waiting_external: '等待外部依赖',
      verification_pending: '等待验收',
    };
    return finish(STATES.WAITING, map[waitEvent.event_type] || '等待处理', waitEvent.evidence_source, waitEvent.observed_at);
  }

  // ④ 自称完成但还没有验收结论：停在 waiting（待验证），绝不下 completed。
  if (claimDone && !acceptance) {
    return finish(STATES.WAITING,
      '执行实例自称完成，等待验收（未验收不算完成）',
      claimDone.evidence_source, claimDone.observed_at);
  }

  // ⑤ 外部终端（Claude/Codex）：只有进程/日志证据，执行状态只能是 unknown。
  if (active && EXTERNAL_AGENTS.has(active.agent_id)) {
    return finish(STATES.UNKNOWN,
      '外部终端启动（Claude/Codex），拿不到结构化事件，无法确认执行状态',
      EVIDENCE.EXTERNAL, lastActivityAt || active.started_at);
  }
  if (externalOnly || (!hasExecutorAttempt && lastAttempt && EXTERNAL_AGENTS.has(lastAttempt.agent_id))) {
    const src = lastExternal ? lastExternal.evidence_source : EVIDENCE.EXTERNAL;
    return {
      ...finish(STATES.UNKNOWN,
        '外部终端启动，只有进程/日志证据，无法确认执行状态',
        src,
        lastExternal ? lastExternal.observed_at : nowIso),
      // 外部证据不足以断言 relay_pending / 进度
    };
  }

  // ⑥ 有活动中的执行实例。
  if (active) {
    if (processAlive === false) {
      return finish(STATES.INTERRUPTED,
        interruptedReason(active, exitEvent),
        exitEvent ? exitEvent.evidence_source : EVIDENCE.EXECUTOR,
        exitEvent ? exitEvent.observed_at : nowIso);
    }

    const actAge = lastActivityAt ? ageMs(lastActivityAt, nowMs) : Infinity;
    const alive = processAlive;

    if (alive === true) {
      return finish(STATES.RUNNING, runningReason(lastActivityAt, nowMs, true), EVIDENCE.EXECUTOR,
        lastActivityAt || active.started_at);
    }
    if (alive === null) {
      // 没有进程探测结果，只能靠事件新鲜度。事件过期 → unknown，绝不 idle。
      if (actAge <= th.activityMs) {
        return finish(STATES.RUNNING, runningReason(lastActivityAt, nowMs, null), EVIDENCE.EXECUTOR,
          lastActivityAt || active.started_at);
      }
      return finish(STATES.UNKNOWN,
        `观测链路失效：无进程探测，且最近活动在 ${reasonText(actAge)}前（超过 ${reasonText(th.activityMs)}阈值）`,
        EVIDENCE.EXECUTOR,
        lastActivityAt || active.started_at);
    }
    // 有 pid 但探测不到存活，同时没有 process_exit 事件：按中断处理。
    return finish(STATES.INTERRUPTED, '执行实例进程消失，任务未完成', EVIDENCE.EXECUTOR,
      lastActivityAt || active.started_at);
  }

  // ⑦ 没有活动实例：由最后一次实例的结局决定，绝不用 idle 兜底。
  if (lastAttempt) {
    if (lastAttempt.status === 'interrupted') {
      const exit = latestOf(relevant.filter((e) => e.attempt_id === lastAttempt.attempt_id), ['process_exit']);
      return finish(STATES.INTERRUPTED, interruptedReason(lastAttempt, exit), EVIDENCE.EXECUTOR,
        exit ? exit.observed_at : (lastAttempt.ended_at || lastAttempt.started_at));
    }
    if (lastAttempt.status === 'failed') {
      if (lastAttempt.end_reason === 'quota_blocked') {
        return {
          ...finish(STATES.BLOCKED, '执行受阻（quota_5h）：额度耗尽，实例已结束，等待接力', EVIDENCE.EXECUTOR,
            lastAttempt.ended_at || lastAttempt.started_at),
          blocked_reason: BLOCK_REASONS.QUOTA_5H,
        };
      }
      if (lastAttempt.end_reason === 'auth_failed') {
        return {
          ...finish(STATES.BLOCKED, '执行受阻（auth_failed）：认证失败，实例已结束', EVIDENCE.EXECUTOR,
            lastAttempt.ended_at || lastAttempt.started_at),
          blocked_reason: BLOCK_REASONS.AUTH_FAILED,
        };
      }
      if (lastAttempt.end_reason === 'spawn_failed') {
        const prior = attempts.slice(1);
        if (prior.some((a) => a.status === 'interrupted')) {
          return finish(STATES.INTERRUPTED,
            '接力实例启动失败，任务保持中断，等待恢复（不是 idle）',
            EVIDENCE.EXECUTOR, lastAttempt.ended_at || lastAttempt.started_at);
        }
        if (prior.some((a) => a.end_reason === 'quota_blocked')) {
          return {
            ...finish(STATES.BLOCKED, '接力实例启动失败，额度阻塞仍未解除', EVIDENCE.EXECUTOR,
              lastAttempt.ended_at || lastAttempt.started_at),
            blocked_reason: BLOCK_REASONS.QUOTA_5H,
          };
        }
        return finish(STATES.UNKNOWN,
          '接力实例启动失败，且没有可恢复的中断现场',
          EVIDENCE.EXECUTOR, lastAttempt.ended_at || lastAttempt.started_at);
      }
      return finish(STATES.INTERRUPTED, interruptedReason(lastAttempt, null), EVIDENCE.EXECUTOR,
        lastAttempt.ended_at || lastAttempt.started_at);
    }
    if (lastAttempt.status === 'completed') {
      if (verification.result === 'failed') {
        return finish(STATES.WAITING, '执行实例已结束，验收未通过，待修复后重跑', EVIDENCE.VERIFIER,
          verification.observed_at || lastAttempt.ended_at);
      }
      return finish(STATES.WAITING, '执行实例已结束，尚未通过验收（未验收不算完成）', EVIDENCE.EXECUTOR,
        lastAttempt.ended_at || lastAttempt.started_at);
    }
  }

  // ⑧ 从未有执行实例。
  if (task.closed_at) {
    return finish(STATES.IDLE, '任务已关闭，没有待继续的工作', EVIDENCE.USER, task.updated_at);
  }
  if (externalOnly) {
    return {
      ...finish(STATES.UNKNOWN, '只有外部证据，无法确认执行状态', EVIDENCE.EXTERNAL,
        lastExternal ? lastExternal.observed_at : nowIso),
    };
  }
  if (!lastEvent) {
    // 任务行本身就是「任务被创建」的证据；但证据过期后仍是 unknown，不猜 idle。
    const createdAge = ageMs(task.created_at, nowMs);
    if (createdAge > th.staleMs) {
      return finish(STATES.UNKNOWN,
        `观测链路失效：任务创建于 ${reasonText(createdAge)}前，之后没有任何事件`,
        EVIDENCE.SYSTEM, task.created_at);
    }
    return finish(STATES.WAITING, '任务已创建，尚未开始执行（等待派活）', EVIDENCE.SYSTEM, task.created_at);
  }
  const eventAge = ageMs(lastEvent.observed_at, nowMs);
  if (eventAge > th.staleMs) {
    return finish(STATES.UNKNOWN,
      `观测链路失效：最近证据在 ${reasonText(eventAge)}前（超过 ${reasonText(th.staleMs)}阈值）`,
      EVIDENCE.SYSTEM, lastEvent.observed_at);
  }
  return finish(STATES.WAITING, '任务已创建，尚未开始执行（等待派活）', EVIDENCE.SYSTEM, lastEvent.observed_at);
}

/**
 * 读库判定任务状态（不写库）。API 与适配器都走这里。
 */
export function evaluateTaskState(db, taskId, opts = {}) {
  const task = getTask(db, taskId);
  if (!task) {
    throw Object.assign(new Error(`任务不存在：${taskId}`), { code: 'TASK_NOT_FOUND', statusCode: 404 });
  }
  const attempts = listAttempts(db, { taskId, limit: 50 });
  // 取最新 1000 条（desc），避免任务很长时只读到最早的事件而漏掉最新阻塞。
  // 状态机不依赖全表扫描。
  const events = queryEvents(db, { taskId, limit: 1000, desc: true });
  const checkpoint = opts.checkpoint !== undefined ? opts.checkpoint : latestCheckpoint(db, taskId);

  const state = deriveTaskState({
    task,
    attempts,
    events,
    checkpoint,
    now: opts.now,
    thresholds: opts.thresholds,
  });

  const steps = getSteps(db, taskId);
  return { ...state, ...summarizeSteps(steps) };
}

function nowIsoDefault(now) {
  return isoOf(now);
}

/**
 * 计算后落库：tasks.status / status_reason，状态变化时补一条 status_changed 事件。
 * 同时处理「DB 说在跑、进程已经没了」的实例，把 attempt 落成 interrupted——
 * 这样任务与实例不会互相打脸。
 */
export function refreshTaskState(db, taskId, opts = {}) {
  const state = evaluateTaskState(db, taskId, opts);
  const task = getTask(db, taskId);
  const at = nowIsoDefault(opts.now);
  const statusChanged = task.status !== state.status;

  updateTaskStatus(db, taskId, state.status, state.status_reason, at);

  // 只有「状态值」变化才留审计事件。running 的理由里含「最近 N 秒」，
  // 如果按理由变化写事件，每次刷新都会刷屏。
  if (statusChanged) {
    // 这条事件永不参与状态判定（DERIVED_EVENTS），只用于追溯「何时因为什么变了」。
    db.prepare(
      'INSERT INTO events (task_id, attempt_id, agent_id, event_type, payload, evidence_source, observed_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      taskId,
      state.attempt_id,
      null,
      'status_changed',
      JSON.stringify({
        from: task.status,
        to: state.status,
        reason: state.status_reason,
        evidence_source: state.evidence_source,
        evidence_observed_at: state.observed_at,
        blocked_reason: state.blocked_reason,
      }),
      EVIDENCE.SYSTEM,
      at,
    );
  }

  // 中断但 attempt 还写着 running：同步落库（不改变判定，只是保持一致）。
  if (state.status === STATES.INTERRUPTED && state.active_attempt_id && state.process_alive === false) {
    const active = listAttempts(db, { taskId, status: 'running', limit: 1 })[0];
    if (active) {
      const hasExit = getRow(db,
        "SELECT event_id FROM events WHERE attempt_id = ? AND event_type = 'process_exit' LIMIT 1",
        [active.attempt_id]);
      endAttempt(db, {
        attemptId: active.attempt_id,
        status: 'interrupted',
        endReason: 'crash',
        endedAt: at,
        evidenceSource: EVIDENCE.EXECUTOR,
      });
      if (!hasExit) {
        db.prepare(
          'INSERT INTO events (task_id, attempt_id, agent_id, event_type, payload, evidence_source, observed_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run(
          taskId, active.attempt_id, active.agent_id, 'process_exit',
          JSON.stringify({ detected: 'state_machine', pid: active.pid, expected: false, reason: '进程消失，执行实例未正常结束' }),
          EVIDENCE.EXECUTOR, at,
        );
      }
    }
  }

  return evaluateTaskState(db, taskId, opts);
}

function normalizeAvailability(agentId, provided, nowIso) {
  if (provided) {
    return {
      agent_id: agentId,
      available: provided.available === undefined ? null : provided.available,
      reason: provided.reason ?? null,
      checked_at: provided.checked_at || nowIso,
      observed_at: provided.observed_at || provided.checked_at || nowIso,
      evidence_source: provided.evidence_source || EVIDENCE.CLI_EVENT,
      detail: provided.detail ?? null,
    };
  }
  return {
    agent_id: agentId,
    available: null,
    reason: 'no_evidence',
    checked_at: nowIso,
    observed_at: nowIso,
    evidence_source: 'none',
    detail: '没有可用的探测证据',
  };
}

function executionStatusOf(lastAttempt, taskState) {
  if (!lastAttempt) return STATES.UNKNOWN;
  if (lastAttempt.status === 'running') {
    return taskState ? taskState.status : STATES.UNKNOWN;
  }
  if (lastAttempt.status === 'completed') return STATES.COMPLETED;
  if (lastAttempt.status === 'interrupted') return STATES.INTERRUPTED;
  if (lastAttempt.status === 'failed') {
    if (lastAttempt.end_reason === 'spawn_failed') {
      return taskState ? taskState.status : STATES.UNKNOWN;
    }
    return STATES.INTERRUPTED;
  }
  return STATES.UNKNOWN;
}

/**
 * 每个 Agent 三个独立对象：availability / execution / task。
 * 任务状态复用 evaluateTaskState，执行状态由最后一次实例 + 任务状态给出，
 * 可用性由调用方注入探测结果（CLI 可用性、额度证据、已知配置）。
 */
export function evaluateAgentStatuses(db, opts = {}) {
  const nowIso = isoOf(opts.now);
  const agentIds = opts.agentIds || ['claude', 'dsh', 'codex', 'hermes'];
  const availabilityMap = opts.availability || {};
  const availability = [];
  const execution = [];
  const taskObjects = [];
  const agents = [];

  for (const agentId of agentIds) {
    const avail = normalizeAvailability(agentId, availabilityMap[agentId], nowIso);
    const lastAttempt = listAttempts(db, { agentId, limit: 1 })[0] || null;
    let taskState = null;
    if (lastAttempt) {
      try {
        taskState = evaluateTaskState(db, lastAttempt.task_id, { now: opts.now, thresholds: opts.thresholds });
      } catch {
        taskState = null;
      }
    }

    let execObj;
    if (lastAttempt) {
      const ext = EXTERNAL_AGENTS.has(agentId);
      execObj = {
        agent_id: agentId,
        instance_status: executionStatusOf(lastAttempt, taskState),
        attempt_id: lastAttempt.attempt_id,
        task_id: lastAttempt.task_id,
        evidence_source: ext ? EVIDENCE.EXTERNAL : EVIDENCE.EXECUTOR,
        observed_at: lastAttempt.ended_at || lastAttempt.started_at,
        last_activity_at: taskState ? taskState.last_activity_at : lastAttempt.started_at,
        status_reason: taskState ? taskState.status_reason : null,
        process_alive: taskState ? taskState.process_alive : null,
        relay_pending: Boolean(lastAttempt.relay_pending),
      };
    } else {
      const extEvent = queryEvents(db, {
        agentId, types: ['external_activity', 'external_probe'], limit: 1, desc: true,
      })[0] || null;
      const isExternal = EXTERNAL_AGENTS.has(agentId);
      const hasWeak = Boolean(extEvent);
      // 只有托管实例（dsh）才能证明「没有执行实例」。外部终端没有可信观测，
      // 即使没看到活动也只能是 unknown；Hermes 同样只信自报。
      const idleProvable = !isExternal && agentId === 'dsh' && avail.evidence_source !== 'none';
      const noEvidenceStatus = idleProvable ? STATES.IDLE : STATES.UNKNOWN;
      execObj = {
        agent_id: agentId,
        instance_status: hasWeak ? STATES.UNKNOWN : noEvidenceStatus,
        attempt_id: null,
        task_id: null,
        evidence_source: hasWeak ? extEvent.evidence_source : (idleProvable ? EVIDENCE.EXECUTOR : 'none'),
        observed_at: hasWeak ? extEvent.observed_at : nowIso,
        last_activity_at: hasWeak ? extEvent.observed_at : null,
        status_reason: hasWeak
          ? '外部活动证据（进程/日志），不能证明正在执行'
          : (idleProvable
            ? '该 Agent 没有执行实例，也没有分配给它的待继续任务'
            : '没有可信的执行证据（证据不足，不能断言在执行）'),
        process_alive: null,
        relay_pending: false,
      };
    }
    execution.push(execObj);

    let taskObj;
    if (taskState) {
      const steps = getSteps(db, lastAttempt.task_id);
      const summary = summarizeSteps(steps);
      taskObj = {
        agent_id: agentId,
        task_id: lastAttempt.task_id,
        status: taskState.status,
        status_reason: taskState.status_reason,
        evidence_source: taskState.evidence_source,
        observed_at: taskState.observed_at,
        step: summary.current_step,
        done: summary.done,
        remaining: summary.remaining,
        last_activity_at: taskState.last_activity_at,
        last_progress_at: taskState.last_progress_at,
        blocked_reason: taskState.blocked_reason,
        relay_pending: taskState.relay_pending,
      };
    } else {
      const isExternal = EXTERNAL_AGENTS.has(agentId);
      const idleProvable = !isExternal && agentId === 'dsh' && avail.evidence_source !== 'none';
      taskObj = {
        agent_id: agentId,
        task_id: null,
        status: idleProvable ? STATES.IDLE : STATES.UNKNOWN,
        status_reason: idleProvable ? '该 Agent 当前没有分配任务' : '没有可信证据证明它有没有任务',
        evidence_source: idleProvable ? EVIDENCE.EXECUTOR : (avail.evidence_source === 'none' ? 'none' : avail.evidence_source),
        observed_at: nowIso,
        step: null,
        done: [],
        remaining: [],
        last_activity_at: null,
        last_progress_at: null,
        blocked_reason: null,
        relay_pending: false,
      };
    }
    taskObjects.push(taskObj);

    agents.push({
      agent_id: agentId,
      availability: avail,
      execution: execObj,
      task: taskObj,
    });
    availability.push(avail);
  }

  return {
    generated_at: nowIso,
    observed_at: nowIso,
    evidence_source: EVIDENCE.SYSTEM,
    availability,
    execution,
    task: taskObjects,
    agents,
  };
}

/** 给调用方挑证据来源用；保留一处实现，避免各模块各写一份比较逻辑。 */
export function strongestEvidenceSource(sources) {
  return strongestSource(sources);
}
