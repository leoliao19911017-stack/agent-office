// api-tasks.mjs — P0 新 API：任务 / 执行实例 / 检查点 / 交接 / 三独立状态。
//
// 契约（任务书 §6）：
//   GET  /api/tasks                任务列表（状态、当前步骤、产物数、最后活动）
//   GET  /api/tasks/:taskId        任务详情（步骤、attempts、checkpoints、事件时间线）
//   GET  /api/agents/status-v2     三个独立状态对象（可用/执行/任务），每个带 evidence_source
//   POST /api/tasks                新建任务
//   POST /api/tasks/:id/attempt    声明一次执行开始
//   POST /api/tasks/:id/checkpoint 生成检查点
//   POST /api/tasks/:id/handoff    交接（from → to，转移 write_owner）
//
// 所有返回状态的地方都带 evidence_source + observed_at。状态一律来自
// state-machine.mjs，本文件不写第二套判定。

import { getDb } from './lib/db.mjs';
import {
  createTask, listTasks, getTask, getSteps, summarizeSteps, requireTask,
  newAttemptId,
} from './lib/tasks.mjs';
import {
  createAttempt, listAttempts, getAttempt, endAttempt, latestAttempt,
  reconcileOrphanedAttempts,
} from './lib/attempts.mjs';
import { createCheckpoint, listCheckpoints, latestCheckpoint } from './lib/checkpoint.mjs';
import {
  acquireWriteOwner, transferWriteOwner, getWriteOwner, listWriteOwners,
  normalizeWorktreePath,
} from './lib/write-owner.mjs';
import {
  evaluateTaskState, refreshTaskState, evaluateAgentStatuses,
  STATES,
} from './lib/state-machine.mjs';
import { queryEvents, countArtifacts, EVIDENCE } from './lib/events.mjs';
import { detectDsh } from './adapters/dsh.mjs';
import { detectClaude, listClaudeSessions } from './adapters/claude.mjs';
import { probeCliBinary } from './adapters/external.mjs';

const AGENTS = new Set(['dsh', 'claude', 'codex', 'hermes']);
const TASK_PATH = /^\/api\/tasks\/([A-Za-z0-9][A-Za-z0-9_.-]{0,95})$/;
const TASK_ACTION_PATH = /^\/api\/tasks\/([A-Za-z0-9][A-Za-z0-9_.-]{0,95})\/(attempt|checkpoint|handoff)$/;

function stamp(now) {
  return (now instanceof Date ? now : new Date(now ?? Date.now())).toISOString();
}

function mkHttpError(deps) {
  return (status, code, message) => {
    if (typeof deps.httpError === 'function') return deps.httpError(status, code, message);
    return Object.assign(new Error(message), { statusCode: status, code });
  };
}

function safeState(db, taskId, opts = {}) {
  try {
    return evaluateTaskState(db, taskId, opts);
  } catch (err) {
    return {
      task_id: taskId,
      status: STATES.UNKNOWN,
      status_reason: `状态计算失败：${String(err.message || err).slice(0, 160)}`,
      evidence_source: EVIDENCE.SYSTEM,
      observed_at: stamp(opts.now),
      evaluated_at: stamp(opts.now),
      last_activity_at: null,
      last_progress_at: null,
      last_event_type: null,
      attempt_id: null,
      attempt_status: null,
      active_attempt_id: null,
      process_alive: null,
      relay_pending: false,
      blocked_reason: null,
      verification: { result: 'none' },
      current_step: null,
      done: [],
      remaining: [],
      done_count: 0,
      total: 0,
    };
  }
}

function taskView(db, task, state) {
  const steps = getSteps(db, task.task_id);
  const summary = summarizeSteps(steps);
  const artifacts = countArtifacts(db, task.task_id);
  return {
    task_id: task.task_id,
    title: task.title,
    acceptance: task.acceptance,
    status: state.status,
    status_reason: state.status_reason,
    evidence_source: state.evidence_source,
    observed_at: state.observed_at,
    last_activity_at: state.last_activity_at,
    last_progress_at: state.last_progress_at,
    last_event_type: state.last_event_type,
    attempt_id: state.attempt_id,
    active_attempt_id: state.active_attempt_id,
    attempt_status: state.attempt_status,
    blocked_reason: state.blocked_reason,
    relay_pending: Boolean(state.relay_pending),
    verification: state.verification,
    current_step: summary.current_step,
    done: summary.done,
    remaining: summary.remaining,
    progress: { done: summary.done_count, total: summary.total },
    artifact_count: artifacts.count,
    latest_artifacts: artifacts.paths.slice(-5),
    created_at: task.created_at,
    updated_at: task.updated_at,
    closed_at: task.closed_at || null,
  };
}

function attemptView(a) {
  return {
    ...a,
    evidence_source: a.agent_id === 'claude' || a.agent_id === 'codex' ? EVIDENCE.EXTERNAL : EVIDENCE.EXECUTOR,
    observed_at: a.ended_at || a.started_at,
  };
}

function checkpointView(c) {
  return {
    ...c,
    evidence_source: EVIDENCE.CHECKPOINT,
    observed_at: c.created_at,
  };
}

function ownerView(o) {
  if (!o) return null;
  return {
    ...o,
    evidence_source: EVIDENCE.EXECUTOR,
    observed_at: o.released_at || o.acquired_at,
  };
}

function eventView(e) {
  return { ...e };
}

function bodyOf(req, deps) {
  if (typeof deps.readJsonBody === 'function') return deps.readJsonBody(req);
  return Promise.resolve({});
}

function send(deps, res, statusCode, payload) {
  deps.sendJson(res, statusCode, payload);
}

function pickString(obj, ...keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== '') return String(obj[k]).trim();
  }
  return null;
}

/** 可用性探测缓存：status-v2 会被前端轮询，不能每次都起子进程。 */
const probeCache = { at: 0, dsh: null, claude: null, codex: null };
const PROBE_TTL_MS = 15000;

async function collectAvailability(opts = {}) {
  const nowMs = Date.now();
  if (probeCache.dsh && nowMs - probeCache.at < PROBE_TTL_MS) return probeCache;

  const dsh = detectDsh({ now: nowMs });
  let claude = {
    available: null, reason: 'scan_failed', checked_at: stamp(nowMs), observed_at: stamp(nowMs),
    evidence_source: EVIDENCE.EXTERNAL, detail: null,
  };
  try {
    const cli = await detectClaude({ now: nowMs });
    const scan = listClaudeSessions({ sinceMs: nowMs - 24 * 60 * 60 * 1000, limit: 1 });
    const latest = scan.sessions && scan.sessions[0];
    if (latest && latest.limited) {
      claude = {
        ...cli,
        available: false,
        reason: latest.reason || 'quota_5h',
        detail: latest.reset_at ? `额度重置时间 ${latest.reset_at}` : (latest.sample || null),
      };
    } else {
      claude = { ...cli, detail: cli.available ? (latest ? 'CLI 可用；执行状态仍只能看外部日志' : 'CLI 可用；未找到会话') : cli.detail };
    }
  } catch (err) {
    claude = { ...claude, detail: String(err.message || err).slice(0, 200) };
  }

  let codex = {
    available: null, reason: 'probe_failed', checked_at: stamp(nowMs), observed_at: stamp(nowMs),
    evidence_source: EVIDENCE.PROCESS_PROBE, detail: null,
  };
  try {
    const r = await probeCliBinary('codex', { now: nowMs });
    codex = {
      available: r.available,
      reason: r.available ? null : 'cli_not_found',
      checked_at: r.checked_at,
      observed_at: r.observed_at,
      evidence_source: EVIDENCE.PROCESS_PROBE,
      detail: r.error || null,
    };
  } catch (err) {
    codex = { ...codex, detail: String(err.message || err).slice(0, 200) };
  }

  probeCache.at = nowMs;
  probeCache.dsh = dsh;
  probeCache.claude = claude;
  probeCache.codex = codex;
  return probeCache;
}

function hermesAvailability(db, nowIso) {
  const e = queryEvents(db, {
    agentId: 'hermes', types: ['self_report', 'hermes_status'], limit: 1, desc: true,
  })[0];
  if (!e) {
    return {
      available: null, reason: 'no_self_report', checked_at: nowIso, observed_at: nowIso,
      evidence_source: 'none', detail: 'Hermes 只信自报，当前没有自报记录',
    };
  }
  return {
    available: e.payload && e.payload.available !== undefined ? Boolean(e.payload.available) : null,
    reason: e.payload && e.payload.reason ? String(e.payload.reason) : null,
    checked_at: e.observed_at,
    observed_at: e.observed_at,
    evidence_source: EVIDENCE.SELF_REPORT,
    detail: e.payload && e.payload.detail ? String(e.payload.detail) : null,
  };
}

function dbReady() {
  const db = getDb();
  // 重启后把「DB 说在跑、进程已消失」的实例落成 interrupted，并把任务状态
  // 一起落库，避免任务变 idle / 或只改实例不改任务。
  const { reconciled } = reconcileOrphanedAttempts(db, {});
  for (const r of reconciled) {
    try {
      const a = getAttempt(db, r.attempt_id);
      if (a) refreshTaskState(db, a.task_id);
    } catch { /* 单个任务刷新失败不拖垮 API */ }
  }
  return db;
}

/**
 * @returns {Promise<boolean>} true=已处理；false=不是本模块的路径，交给 server-api 兜底。
 */
export async function handleTasksApi(req, res, path, method, deps = {}) {
  const httpError = mkHttpError(deps);
  const normalizedMethod = String(method || 'GET').toUpperCase();

  const mTask = path.match(TASK_PATH);
  const mAction = path.match(TASK_ACTION_PATH);
  const isStatusV2 = path === '/api/agents/status-v2';
  const isTasks = path === '/api/tasks';

  if (!isStatusV2 && !isTasks && !mTask && !mAction) return false;

  const knownMethods = isStatusV2 ? ['GET']
    : isTasks ? ['GET', 'POST']
      : mAction ? ['POST']
        : ['GET'];
  if (!knownMethods.includes(normalizedMethod)) {
    throw httpError(405, 'METHOD_NOT_ALLOWED', `${normalizedMethod} ${path} 不支持`);
  }

  const db = dbReady();
  const nowIso = stamp();

  // ---- GET /api/agents/status-v2 ---------------------------------------
  if (isStatusV2) {
    const probes = await collectAvailability();
    const availability = {
      dsh: probes.dsh,
      claude: probes.claude,
      codex: probes.codex,
      hermes: hermesAvailability(db, nowIso),
    };
    const result = evaluateAgentStatuses(db, { availability, now: nowIso });
    send(deps, res, 200, {
      ...result,
      probes: availability,
      agents_available: [...AGENTS],
    });
    return true;
  }

  // ---- GET /api/tasks ---------------------------------------------------
  if (isTasks && normalizedMethod === 'GET') {
    const tasks = listTasks(db, { limit: 500 }).map((task) => {
      const state = safeState(db, task.task_id, { now: nowIso });
      return taskView(db, task, state);
    });
    send(deps, res, 200, {
      ok: true,
      generated_at: nowIso,
      observed_at: nowIso,
      evidence_source: EVIDENCE.SYSTEM,
      count: tasks.length,
      tasks,
    });
    return true;
  }

  // ---- POST /api/tasks --------------------------------------------------
  if (isTasks && normalizedMethod === 'POST') {
    const body = (await bodyOf(req, deps)) || {};
    const title = pickString(body, 'title', 'name');
    if (!title) throw httpError(400, 'BAD_TITLE', 'title 必填（非空字符串）');
    const steps = Array.isArray(body.steps) && body.steps.length
      ? body.steps
      : [{ key: 'deliverable', name: '交付' }];
    const task = createTask(db, {
      title,
      acceptance: body.acceptance ?? null,
      steps,
      taskId: body.task_id || body.taskId || undefined,
      source: 'api',
      evidenceSource: EVIDENCE.USER,
    });
    const state = refreshTaskState(db, task.task_id);
    send(deps, res, 201, {
      ok: true,
      observed_at: state.observed_at,
      evidence_source: EVIDENCE.USER,
      task: taskView(db, requireTask(db, task.task_id), state),
    });
    return true;
  }

  // ---- GET /api/tasks/:id ----------------------------------------------
  if (mTask && normalizedMethod === 'GET') {
    const taskId = mTask[1];
    const task = getTask(db, taskId);
    if (!task) throw httpError(404, 'TASK_NOT_FOUND', `任务不存在：${taskId}`);
    const state = evaluateTaskState(db, taskId, { now: nowIso });
    const attempts = listAttempts(db, { taskId, limit: 100 }).map(attemptView);
    const checkpoints = listCheckpoints(db, taskId, 100).map(checkpointView);
    const events = queryEvents(db, { taskId, limit: 1000 }).map(eventView);
    const owner = listWriteOwners(db, { activeOnly: true }).find((o) => o.task_id === taskId) || null;
    send(deps, res, 200, {
      ok: true,
      generated_at: nowIso,
      observed_at: state.observed_at,
      evidence_source: state.evidence_source,
      task: {
        ...task,
        evidence_source: state.evidence_source,
        observed_at: state.observed_at,
      },
      state,
      view: taskView(db, task, state),
      steps: getSteps(db, taskId),
      attempts,
      checkpoints,
      events,
      write_owner: ownerView(owner),
      artifacts: countArtifacts(db, taskId),
    });
    return true;
  }

  // ---- POST /api/tasks/:id/attempt -------------------------------------
  if (mAction && mAction[2] === 'attempt' && normalizedMethod === 'POST') {
    const taskId = mAction[1];
    requireTask(db, taskId);
    const body = (await bodyOf(req, deps)) || {};
    const agentId = pickString(body, 'agent_id', 'agentId') || 'dsh';
    if (!AGENTS.has(agentId)) throw httpError(400, 'BAD_AGENT', `未知 agent_id：${agentId}`);
    const worktreePath = pickString(body, 'worktree_path', 'worktreePath');
    const attemptId = newAttemptId();

    if (worktreePath) {
      acquireWriteOwner(db, {
        worktreePath, taskId, attemptId, agentId, now: nowIso,
        force: Boolean(body.force), forceReason: body.force_reason || null,
      });
    }
    const attempt = createAttempt(db, {
      taskId, agentId, attemptId, worktreePath,
      pid: body.pid == null ? null : Number(body.pid),
      sessionId: pickString(body, 'session_id', 'sessionId'),
      startedAt: nowIso,
      note: pickString(body, 'note'),
      evidenceSource: agentId === 'claude' || agentId === 'codex' ? EVIDENCE.EXTERNAL : EVIDENCE.EXECUTOR,
    });
    const state = refreshTaskState(db, taskId, { now: nowIso });
    send(deps, res, 201, {
      ok: true,
      observed_at: nowIso,
      evidence_source: attemptView(attempt).evidence_source,
      attempt: attemptView(attempt),
      write_owner: worktreePath ? ownerView(getWriteOwner(db, worktreePath)) : null,
      state,
    });
    return true;
  }

  // ---- POST /api/tasks/:id/checkpoint ----------------------------------
  if (mAction && mAction[2] === 'checkpoint' && normalizedMethod === 'POST') {
    const taskId = mAction[1];
    requireTask(db, taskId);
    const body = (await bodyOf(req, deps)) || {};
    const attemptId = pickString(body, 'attempt_id', 'attemptId')
      || (latestAttempt(db, { taskId, status: 'running' }) || latestAttempt(db, { taskId }) || {}).attempt_id
      || null;
    const worktreePath = pickString(body, 'worktree_path', 'worktreePath')
      || (attemptId ? (getAttempt(db, attemptId) || {}).worktree_path : null)
      || process.cwd();
    const result = createCheckpoint(db, {
      taskId, attemptId, worktreePath,
      label: pickString(body, 'label'), now: nowIso,
    });
    const state = refreshTaskState(db, taskId, { now: nowIso });
    send(deps, res, 201, {
      ok: true,
      observed_at: result.checkpoint.created_at,
      evidence_source: EVIDENCE.CHECKPOINT,
      checkpoint: checkpointView(result.checkpoint),
      git_sha: result.git_sha,
      git_error: result.git_error,
      worktree_path: result.worktree_path,
      state,
    });
    return true;
  }

  // ---- POST /api/tasks/:id/handoff -------------------------------------
  if (mAction && mAction[2] === 'handoff' && normalizedMethod === 'POST') {
    const taskId = mAction[1];
    requireTask(db, taskId);
    const body = (await bodyOf(req, deps)) || {};
    const toAgent = pickString(body, 'to_agent_id', 'toAgentId', 'to');
    if (!toAgent || !AGENTS.has(toAgent)) throw httpError(400, 'BAD_AGENT', 'to_agent_id 必填且必须已知');
    const fromAttemptId = pickString(body, 'from_attempt_id', 'fromAttemptId', 'from');
    const explicitPath = pickString(body, 'worktree_path', 'worktreePath');

    const activeOwner = listWriteOwners(db, { activeOnly: true })
      .find((o) => o.task_id === taskId && (!explicitPath || normalizeWorktreePath(o.worktree_path) === normalizeWorktreePath(explicitPath)));
    const fromAttempt = fromAttemptId
      ? getAttempt(db, fromAttemptId)
      : (activeOwner ? getAttempt(db, activeOwner.attempt_id) : latestAttempt(db, { taskId }));
    if (!fromAttempt || fromAttempt.task_id !== taskId) {
      throw httpError(409, 'NO_FROM_ATTEMPT', '找不到可交接的源执行实例');
    }
    const worktreePath = explicitPath || (activeOwner && activeOwner.worktree_path) || fromAttempt.worktree_path;
    if (!worktreePath) throw httpError(400, 'NO_WORKTREE', '交接需要 worktree_path（或源实例带路径）');

    const toAttemptId = pickString(body, 'to_attempt_id', 'toAttemptId') || newAttemptId();
    if (getAttempt(db, toAttemptId)) {
      throw httpError(409, 'ATTEMPT_EXISTS', `目标执行实例已存在：${toAttemptId}`);
    }
    const checkpointId = pickString(body, 'checkpoint_id', 'checkpointId')
      || (latestCheckpoint(db, taskId) || {}).checkpoint_id || null;

    const transfer = transferWriteOwner(db, {
      worktreePath, taskId,
      fromAttemptId: fromAttempt.attempt_id,
      toAttemptId, agentId: toAgent,
      now: nowIso, reason: pickString(body, 'reason') || 'handoff',
    });

    const toAttempt = createAttempt(db, {
      taskId, agentId: toAgent, attemptId: toAttemptId,
      worktreePath, status: 'running', startedAt: nowIso,
      checkpointId,
      note: pickString(body, 'note') || `从 ${fromAttempt.agent_id}/${fromAttempt.attempt_id} 交接`,
      evidenceSource: toAgent === 'claude' || toAgent === 'codex' ? EVIDENCE.EXTERNAL : EVIDENCE.EXECUTOR,
    });

    if (fromAttempt.status === 'running') {
      endAttempt(db, {
        attemptId: fromAttempt.attempt_id,
        status: 'interrupted',
        endReason: 'handoff',
        endedAt: nowIso,
        evidenceSource: EVIDENCE.EXECUTOR,
      });
    }

    db.prepare(
      'INSERT INTO events (task_id, attempt_id, agent_id, event_type, payload, evidence_source, observed_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      taskId, toAttemptId, toAgent, 'handoff',
      JSON.stringify({
        from_attempt_id: fromAttempt.attempt_id,
        from_agent_id: fromAttempt.agent_id,
        to_attempt_id: toAttemptId,
        to_agent_id: toAgent,
        worktree_path: transfer.owner.worktree_path,
        checkpoint_id: checkpointId,
        reason: pickString(body, 'reason') || 'handoff',
      }),
      EVIDENCE.EXECUTOR, nowIso,
    );

    const state = refreshTaskState(db, taskId, { now: nowIso });
    send(deps, res, 201, {
      ok: true,
      observed_at: nowIso,
      evidence_source: EVIDENCE.EXECUTOR,
      from_attempt: attemptView(getAttempt(db, fromAttempt.attempt_id)),
      to_attempt: attemptView(toAttempt),
      write_owner: ownerView(transfer.owner),
      checkpoint_id: checkpointId,
      state,
    });
    return true;
  }

  return false;
}
