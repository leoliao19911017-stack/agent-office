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
//   POST /api/tasks/:id/finish     收尾：结束执行实例 + 记验收结论 → 任务 completed（必须带证据）
//   POST /api/tasks/:id/stop       停止：结束正在跑的执行实例（interrupted / user_stop），不写验收；
//                                   本进程托管的实例等进程真的退出才回，停止之后才允许删除
//   POST /api/tasks/:id/archive    归档（只写 archived_at / archived_from，不动 status）
//   POST /api/tasks/:id/restore    恢复（清 archived_at，用 archived_from 还原原状态，再按最新执行证据重算）
//   DELETE /api/tasks/:id          软删（有 running 的执行实例返回 409，必须显式先停止）
//   POST /api/tasks/batch          批量 archive / delete / restore，逐条返回结果（逐条事务，允许部分失败）
//   POST /api/workflow/runs/:runId/steps/:stepId/tasks
//                                   从任务书批量建任务，整批挂到该 run 的这一步（v9）。
//                                   路由匹配在 api-workflow-runs.mjs（/api/workflow/runs* 先于本文件分发），
//                                   建任务的逻辑留在本文件——所有写 tasks 表的入口都在一起。
//
// v9 工作流挂点：tasks.workflow_run_id / workflow_step_id（属于哪次需求、九步里的哪一步）。
//   GET  /api/tasks?workflow_run_id=X[&workflow_step_id=05]   按挂点过滤（真 SQL 过滤，不是前端筛）
//   POST /api/tasks 带 workflow_run_id / workflow_step_id       建任务时就挂上；run / 步骤不存在 → 404
//
// 归档 / 软删的可见性（GET /api/tasks）：
//   默认                         不要归档、不要软删
//   ?include_archived=1          带上归档的
//   ?only_deleted=1              只看软删的（回收站），归档与否都算
//   ?include_deleted=1           全部行（内部工具用）
//
// 生命周期约束（返工 run-3d22e663 · 05c）：
//   · 已软删的任务不能再开始执行：attempt / handoff / checkpoint / finish 一律 409 TASK_DELETED；
//     「检查没被删」和「建实例行」在同一个事务里（P1-2）。
//   · 归档 / 恢复 / 删除各自是一个事务：读取、校验、更新、事件同生同死（P1-4）。
//   · 恢复写回 archived_from 之后，再按最新执行证据重算状态；删除守卫看的也是执行证据，
//     不是可能过期的 status 列（P1-3）。
//
// 所有返回状态的地方都带 evidence_source + observed_at。状态一律来自
// state-machine.mjs，本文件不写第二套判定。

import { getDb, transaction } from './lib/db.mjs';
import {
  createTask, listTasks, getTask, getSteps, summarizeSteps, requireTask, requireNotDeletedTask,
  newAttemptId, updateStep, createTasksForWorkflowStep, DEFAULT_TASK_STEPS,
} from './lib/tasks.mjs';
import {
  createAttempt, listAttempts, getAttempt, endAttempt, latestAttempt,
  reconcileOrphanedAttempts, isPidAlive, listRunningAttempts,
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
import { queryEvents, countArtifacts, EVIDENCE, recordAcceptance, appendEvent } from './lib/events.mjs';
import { detectDsh, getLiveAttempt } from './adapters/dsh.mjs';
import { detectClaude, listClaudeSessions } from './adapters/claude.mjs';
import { probeCliBinary } from './adapters/external.mjs';
import { listAgents, agentExists } from './lib/agents.mjs';
import { createWorkflowEngine, WorkflowEngineError } from './lib/workflow-engine.mjs';
import { spawnSync } from 'node:child_process';
import { spawnPlan } from './chat/proc.mjs';

const TASK_PATH = /^\/api\/tasks\/([A-Za-z0-9][A-Za-z0-9_.-]{0,95})$/;
const TASK_ACTION_PATH = /^\/api\/tasks\/([A-Za-z0-9][A-Za-z0-9_.-]{0,95})\/(attempt|checkpoint|handoff|finish|stop|archive|restore)$/;
const BATCH_PATH = '/api/tasks/batch';
const BATCH_ACTIONS = new Set(['archive', 'delete', 'restore']);

/**
 * 这个进程的任务 API 有哪几样能力——随 GET /api/tasks 一起回显。
 *
 * 看板的静态文件是每次请求从磁盘读的：改完前端的一瞬间线上界面就是新的，而本文件要重启才换。
 * 旧进程的响应里没有这个键，前端据此把依赖新后端的按钮（停止、回收站）禁用并说明原因，
 * 不留一个点了没反应的控件。新增能力时往这里加一项，前端按名字认。
 */
const API_FEATURES = Object.freeze([
  'archive', 'restore', 'soft_delete', 'batch', 'workflow_link',
  'stop', 'trash', 'execution_guard_deleted', 'admin_atomic',
  // R2-1：停止的二次确认绑定具体执行实例——STOP_UNVERIFIED 响应带 attempt_id，confirm 必须带上它。
  'stop_attempt_binding',
  // R2-2：单活动实例约束（已有 running 再启动 → 409），任务视图带 running_attempts、停止响应带 remaining_running。
  'single_active_attempt',
]);

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

/**
 * 步骤名查表（同一个响应内按 run 缓存：列表里几十条任务同属一次 run 也只查一次）。
 * 步骤名不在 workflow_run_steps 里（那张表只有 step_id），要按 run 用的模板版本取——
 * 引擎的 getRunState 已经做了这件事，这里只读它，不另写一套解析。
 * run 没了 / 模板没了 / 步骤不在模板里都返回 null：标签退回只显示步骤号，不编名字。
 */
function stepNameResolver(db) {
  const cache = new Map();
  return (runId, stepId) => {
    if (!runId || !stepId) return null;
    if (!cache.has(runId)) {
      let names = null;
      try {
        const steps = createWorkflowEngine(db).getRunState(runId)?.steps || [];
        names = new Map(steps.map((s) => [s.step_id, s.name]));
      } catch { names = null; }
      cache.set(runId, names);
    }
    const names = cache.get(runId);
    return names ? (names.get(stepId) || null) : null;
  };
}

function taskView(db, task, state, opts = {}) {
  const steps = getSteps(db, task.task_id);
  // 任务已完成时步骤按全部完成算（规则见 summarizeSteps）：进度要和状态说的是同一件事
  const summary = summarizeSteps(steps, { completed: state.status === STATES.COMPLETED });
  const artifacts = countArtifacts(db, task.task_id);
  const stepNameOf = opts.stepNameOf || stepNameResolver(db);
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
    // 还在跑的实例总数（R2-2）。状态机的 active_attempt_id 只认「最新一条 running」——
    // 遗留数据里可能同时多条 running：最新那条停掉后它是 null，但更早的还在跑。
    // 界面的停止按钮显隐看这个数；旧后端的响应里没有这个键，前端退回 active_attempt_id。
    running_attempts: runningAttemptsOf(db, task.task_id).length,
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
    // v8 归档 / 软删三列：前端据此灰显、贴「已归档」标签、显示恢复按钮。
    archived_at: task.archived_at || null,
    archived_from: task.archived_from || null,
    deleted_at: task.deleted_at || null,
    is_archived: Boolean(task.archived_at),
    is_deleted: Boolean(task.deleted_at),
    // v9 工作流挂点：属于哪次需求 / 九步里的哪一步。老任务两列都是 null（不属于任何工作流）。
    // workflow_step_name 是服务端按 run 的模板查出来的（查不到为 null），前端标签直接用。
    workflow_run_id: task.workflow_run_id || null,
    workflow_step_id: task.workflow_step_id || null,
    workflow_step_name: stepNameOf(task.workflow_run_id, task.workflow_step_id),
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

/** path 里没有 query（server.js 只传 pathname），归档筛选从 req.url 自己解。 */
function queryOf(req) {
  const raw = req && typeof req.url === 'string' ? req.url : '';
  const i = raw.indexOf('?');
  return new URLSearchParams(i >= 0 ? raw.slice(i + 1) : '');
}

function flagParam(params, name) {
  const v = params.get(name);
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * 「谁」做了归档/删除/恢复。
 * 优先 body.actor / actor_id / by，其次 X-Actor 请求头，最后落在 user:local——
 * events.agent_id 与 payload.actor 都必须有值，不允许匿名写操作。
 */
function actorOf(req, body) {
  const direct = pickString(body || {}, 'actor', 'actor_id', 'by', 'operator');
  if (direct) return direct;
  const headers = req && req.headers ? req.headers : {};
  const header = pickString(headers, 'x-actor', 'x-operator');
  if (header) return header;
  return 'user:local';
}

function runningAttemptOf(db, taskId) {
  return latestAttempt(db, { taskId, status: 'running' });
}

/** 还在跑的全部实例（不止最新一条）：约束上线前的遗留数据可能有多条 running（R2-2）。 */
function runningAttemptsOf(db, taskId) {
  return listRunningAttempts(db, taskId);
}

/** URLSearchParams → 普通对象（pickString 按属性取值）。 */
function queryFields(params) {
  return Object.fromEntries(params.entries());
}

/**
 * 工作流挂点入参归一（v9）：camelCase / snake_case 都认，没给或空串都是 null。
 * 只给步骤不给 run 是半截挂点——'05' 这种步骤号只在一次 run 里有意义——所以 400，不猜是哪次需求。
 */
function workflowLinkOf(source, httpError) {
  const src = source || {};
  const runId = pickString(src, 'workflow_run_id', 'workflowRunId');
  const stepId = pickString(src, 'workflow_step_id', 'workflowStepId');
  if (stepId && !runId) {
    throw httpError(400, 'BAD_WORKFLOW_LINK', 'workflow_step_id 必须和 workflow_run_id 一起给：步骤号只在一次 run 里有意义');
  }
  return { runId, stepId };
}

/**
 * 写任务前校验挂点真实存在，不让任务挂到不存在的 run / 步骤上。
 * 错误码与 /api/workflow/runs* 的引擎同一套：run 不存在 404 RUN_NOT_FOUND，
 * run 里没有这一步 404 STEP_NOT_FOUND。只给 run 不给步骤是允许的
 * （任务属于这次需求，但还没挂到具体某一步）。步骤名顺手带出来给响应用。
 */
function requireWorkflowLink(db, { runId, stepId }, httpError) {
  if (!runId) return { runId: null, stepId: null, stepName: null };
  let state;
  try {
    state = createWorkflowEngine(db).getRunState(runId);
  } catch (err) {
    if (err instanceof WorkflowEngineError) throw httpError(err.statusCode, err.code, err.message);
    throw err;
  }
  if (!state) throw httpError(404, 'RUN_NOT_FOUND', `run 不存在：${runId}`);
  if (!stepId) return { runId, stepId: null, stepName: null };
  const def = state.steps.find((s) => s.step_id === stepId);
  if (!def) throw httpError(404, 'STEP_NOT_FOUND', `run 里没有第 ${stepId} 步`);
  return { runId, stepId, stepName: def.name };
}

/** 归档/删除/恢复统一的事件写法：event_type + agent_id(谁) + observed_at(何时) + payload(什么操作)。 */
function taskAdminEvent(db, { taskId, actor, eventType, action, payload, at }) {
  return appendEvent(db, {
    taskId,
    agentId: actor,
    eventType,
    payload: { ...payload, action, actor, at },
    evidenceSource: EVIDENCE.USER,
    observedAt: at,
  });
}

/**
 * 把派生状态（tasks.status / status_reason）对齐到最新执行证据，返回对齐后的任务行。
 *
 * 状态一律由 state-machine.mjs 算，这里不写第二套判定；只是让删除守卫看「此刻按证据算出来的状态」，
 * 而不是一列可能过期的缓存（进程消失后没人触发刷新，状态列就会落后）。要在事务里调用。
 */
function syncDerivedState(db, taskId, at) {
  refreshTaskState(db, taskId, { now: at });
  return requireTask(db, taskId);
}

/**
 * 归档：只写 archived_at / archived_from，status 一个字都不改（A2）。
 * archived_from 记的是归档前 status 列的值，恢复时按它写回（A5）。
 * 即便这一列已经落后于执行证据，恢复那一步也会按最新证据重算，所以这里不去动它。
 *
 * 读取、校验、更新、事件在同一个事务里：审计事件写不进去，archived_at 就跟着回滚，
 * 不会出现「接口报 500、库里却已经归档」（P1-4）。
 */
function archiveOne(db, taskId, { actor, at, httpError }) {
  return transaction(db, () => {
    const task = requireTask(db, taskId);
    if (task.deleted_at) throw httpError(409, 'TASK_DELETED', `任务已删除，不能归档：${taskId}`);
    if (task.archived_at) throw httpError(409, 'TASK_ALREADY_ARCHIVED', `任务已归档：${taskId}`);
    db.prepare('UPDATE tasks SET archived_at = ?, archived_from = ?, updated_at = ? WHERE task_id = ?')
      .run(at, task.status, at, taskId);
    const updated = requireTask(db, taskId);
    const event = taskAdminEvent(db, {
      taskId, actor, eventType: 'task_archived', action: 'archive', at,
      payload: { status_before: task.status, archived_at: at, archived_from: task.status },
    });
    return { task: updated, event, archived_at: at, archived_from: task.status };
  });
}

/**
 * 恢复：清 archived_at（A6），并写回 archived_from 记录的原状态（A5）。
 *
 * 写回去的只是「归档那一刻」的状态。归档 / 删除期间执行可能已经结束（完成、被停、进程消失），
 * 所以写回之后紧接着按最新执行证据重算一次并落库——恢复不能把一个早就结束的实例重新伪造成
 * 「执行中」，否则界面显示「已完成」、删除却被拒（P1-3）。实例还活着的话（A5 那种），
 * 重算结果就是原状态，状态不变、也不写 status_changed。
 * 整段在一个事务里；事件里把「写回了什么」和「最后落库的是什么」都记下来。
 */
function restoreOne(db, taskId, { actor, at, httpError }) {
  return transaction(db, () => {
    const task = requireTask(db, taskId);
    if (!task.archived_at && !task.deleted_at) {
      throw httpError(409, 'NOT_ARCHIVED', `任务没有归档或删除，不能恢复：${taskId}`);
    }
    const restoredStatus = task.archived_from || task.status;
    db.prepare(
      'UPDATE tasks SET archived_at = NULL, archived_from = NULL, deleted_at = NULL, status = ?, updated_at = ? ' +
      'WHERE task_id = ?',
    ).run(restoredStatus, at, taskId);
    const state = refreshTaskState(db, taskId, { now: at });
    const updated = requireTask(db, taskId);
    const event = taskAdminEvent(db, {
      taskId, actor, eventType: 'task_restored', action: 'restore', at,
      payload: {
        status_before: task.status,
        // 按 archived_from 写回去的状态，和按最新证据重算后落库的状态。两者不同 = 归档 / 删除期间状态变过。
        status_restored: restoredStatus,
        status_after: updated.status,
        was_archived: Boolean(task.archived_at),
        was_deleted: Boolean(task.deleted_at),
      },
    });
    return { task: updated, event, status: updated.status, restored_status: restoredStatus, state };
  });
}

/**
 * 软删：有 running 的执行实例一律 409（A7），否则只写 deleted_at，行不删（A8）。
 *
 * 守卫看的是执行证据，不是 tasks.status 这一列：状态列可能已经过期（返工前的 restore 会把
 * 「归档那一刻的 running」原样写回，而实例其实早就结束了；线上库里就有这样的行）。
 * 所以先让状态机按最新证据对齐——进程已经没了的 running 实例在这一步落成 interrupted——
 * 再问「还有没有 running 的执行实例」，有才拒。「正在跑的不能删，需要先停」这条不变。
 */
function deleteOne(db, taskId, { actor, at, httpError }) {
  return transaction(db, () => {
    let task = requireTask(db, taskId);
    if (task.deleted_at) throw httpError(409, 'TASK_ALREADY_DELETED', `任务已删除：${taskId}`);
    syncDerivedState(db, taskId, at);
    const liveAttempt = runningAttemptOf(db, taskId);
    if (liveAttempt) {
      throw httpError(409, 'TASK_RUNNING',
        `任务正在运行，不能删除；请先停止再删：${taskId}（执行实例 ${liveAttempt.attempt_id}`
        + `${liveAttempt.pid != null ? `，pid ${liveAttempt.pid}` : '，未登记进程号'}）`);
    }
    task = requireTask(db, taskId);
    db.prepare('UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE task_id = ?')
      .run(at, at, taskId);
    const updated = requireTask(db, taskId);
    const event = taskAdminEvent(db, {
      taskId, actor, eventType: 'task_deleted', action: 'delete', at,
      payload: {
        status_before: task.status,
        deleted_at: at,
        // 走到这里一定没有在跑的实例；字段留着，保持事件形状不变
        running_attempt_id: null,
      },
    });
    return { task: updated, event, deleted_at: at };
  });
}

/** 等托管进程退出的上限。执行器的 killTree 自己有 8 秒超时，这里再留一倍余量。 */
const STOP_WAIT_MS = 20000;

/** 正在停止中的执行实例（同一个实例不许两个请求同时停）。 */
const stoppingAttempts = new Set();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 实例进程退出事件的统一写法（detected 写明是谁发现的，reason 写明为什么）。 */
function processExitEvent(db, { taskId, attempt, detected, expected, reason, at }) {
  return appendEvent(db, {
    taskId,
    attemptId: attempt.attempt_id,
    agentId: attempt.agent_id,
    eventType: 'process_exit',
    payload: { detected, pid: attempt.pid ?? null, expected, reason },
    evidenceSource: EVIDENCE.EXECUTOR,
    observedAt: at,
  });
}

/**
 * 停止任务当前的执行实例。按「本服务能确认到什么程度」分三种情况，不混为一谈：
 *
 *   managed   实例是本进程用执行器（startDshAttempt）起的：先把停止请求记进审计（写不进去就不停），
 *             调它的 stop()，等到进程退出（执行器在 close 事件里写 process_exit、把实例落成
 *             interrupted / user_stop），再回库核对实例行和 pid。确认之后才算停了。
 *   unmanaged 实例不是本进程起的，但登记了 pid：本服务不代为结束别人的进程。pid 还活着 → 409，
 *             告诉用户去哪里停、停完再点一次。那种情况下通常等不到这里——每次请求开头的对账
 *             （reconcileOrphanedAttempts）发现 pid 没了就把实例落成中断了，停止路由直接回「已停止」。
 *   declared  实例不是本进程起的，也没有 pid：本服务没有任何可观测的进程，无法确认。
 *             必须由用户显式 confirm：确认后把实例记为 interrupted / user_stop，事件里写明
 *             「用户确认，未经系统验证」。
 *
 * 三种情况都不写验收结论——停止不是 finish，任务不会因此变成 completed。
 * 停下来之后任务里不再有 running 的实例，DELETE 的守卫才放行。
 * 不在事务里等进程：等的过程可能要几秒，期间不能占着写锁。
 *
 * 确认绑定（R2-1）：targetAttemptId 指定「要停的是哪一个实例」。
 * 用户点「确认已停止」确认的是第一次被拒时告诉他的那个实例；请求必须原样带回它的 attempt_id，
 * 服务端只对它落「用户停止」。不带 id 的 confirm 一律 400——那是「让我停现在正好在跑的那个」，
 * 窗口里实例一换手，就会把用户没确认过的新实例误标成已停止并放行删除。
 */
async function stopOne(db, taskId, { actor, httpError, confirm = false, targetAttemptId = null }) {
  const task = requireTask(db, taskId);
  if (confirm && !targetAttemptId) {
    throw httpError(400, 'STOP_CONFIRM_REQUIRES_ATTEMPT',
      '确认停止必须带上要确认的执行实例 attempt_id（第一次「停止」被拒时的响应里给了它）。'
      + '不带实例 id 的确认对应不到用户当时看到的那次执行，不收。');
  }
  // 目标实例的解析：
  //   给了 targetAttemptId —— 只停用户点名的这个：不是本任务的实例 → 409；已经不在跑 →
  //     还有别的在跑就 409 STOP_TARGET_CHANGED（一个都不动，要求重新走一遍确认），没有就幂等返回。
  //   没给 —— 兼容「第一次停止」的旧调用，选最新一条 running（单实例约束下就是唯一的那个）。
  let active;
  if (targetAttemptId) {
    const target = getAttempt(db, targetAttemptId);
    if (!target || target.task_id !== taskId) {
      throw httpError(409, 'ATTEMPT_MISMATCH',
        `执行实例 ${targetAttemptId} 不是任务 ${taskId} 的实例，不能对它执行停止。`);
    }
    if (target.status === 'running') {
      active = target;
    } else {
      const others = runningAttemptsOf(db, taskId).filter((a) => a.attempt_id !== targetAttemptId);
      if (others.length) {
        throw httpError(409, 'STOP_TARGET_CHANGED',
          `要停止的执行实例 ${targetAttemptId} 已经不在运行；当前运行中的是 ${others.map((a) => a.attempt_id).join('、')}。`
          + '你手里的确认对应的是已经结束的那次执行，不适用于现在的实例——请重新点「停止」走一遍确认。');
      }
      // 点名的实例已经结束、也没有别的在跑：无事可做（幂等，不改任何行）。
      return {
        task, attempt: target, mode: 'none', verified: true, already_stopped: true,
        process_alive: target.pid != null ? isPidAlive(target.pid) : null,
        pid: target.pid, event: null, state: evaluateTaskState(db, taskId),
      };
    }
  } else {
    active = runningAttemptOf(db, taskId);
    if (!active) {
      // 没有在跑的实例：无事可做，幂等返回成功。
      return {
        task, attempt: null, mode: 'none', verified: true, already_stopped: true,
        process_alive: null, pid: null, event: null, state: evaluateTaskState(db, taskId),
      };
    }
  }
  const attemptId = active.attempt_id;
  const managed = getLiveAttempt(attemptId);
  // 读完 active 到落库之间，别的进程（对账 / 收尾）可能已经把这个实例结束了。要写之前在事务里再看一眼：
  // 已经不是 running 就以库里为准，不拿「用户停止」覆盖别人写下的结论。
  const endedElsewhere = () => {
    const current = getAttempt(db, attemptId);
    if (current && current.status === 'running') return null;
    return {
      task: requireTask(db, taskId), attempt: current, mode: 'none', verified: true, already_stopped: true,
      process_alive: current && current.pid != null ? isPidAlive(current.pid) : null,
      pid: current ? current.pid : null, event: null, state: evaluateTaskState(db, taskId),
    };
  };

  if (managed) {
    if (stoppingAttempts.has(attemptId)) {
      throw httpError(409, 'STOP_IN_PROGRESS', `这个执行实例正在停止中，请稍候：${attemptId}`);
    }
    stoppingAttempts.add(attemptId);
    try {
      // 先把「谁、何时要求停止」记下来，再去停。进程一旦被杀是撤不回来的，所以审计事件必须先落库：
      // 写不进去就在这里报错返回，进程不动——不会出现「进程被杀了、库里却没有这次操作的记录」。
      // 停下来的证据（process_exit、实例结束）由执行器在进程退出时写，不在这里预先断言。
      const requestedAt = stamp();
      const event = transaction(db, () => taskAdminEvent(db, {
        taskId, actor, eventType: 'task_stopped', action: 'stop', at: requestedAt,
        payload: {
          attempt_id: attemptId, mode: 'managed', phase: 'requested', pid: managed.pid ?? null, requested_by: actor,
        },
      }));
      await Promise.race([
        managed.stop('user_stop'),
        sleep(STOP_WAIT_MS).then(() => {
          throw httpError(504, 'STOP_TIMEOUT',
            `停止已经发出，但进程 ${managed.pid ?? ''} 在 ${Math.round(STOP_WAIT_MS / 1000)} 秒内没有退出：${attemptId}。`
            + '任务仍算运行中；稍后重试，必要时请人工结束该进程');
        }),
      ]);
      // 进程退出后再回库核对一遍：实例行确实结束了、pid 确实不在了，才回「已停止」。
      return transaction(db, () => {
        const at = stamp();
        let row = getAttempt(db, attemptId);
        const alive = row && row.pid != null ? isPidAlive(row.pid) : null;
        if (alive === true) {
          // 进程没退干净（比如被 shell 包了一层、孙进程还活着）：不确认停止。
          throw httpError(504, 'STOP_UNCONFIRMED', `进程 ${row.pid} 仍在运行，停止没有得到确认：${attemptId}`);
        }
        if (row && row.status === 'running') {
          // 执行器的 close 处理没来得及落库（不应发生）：补落。原因如实写 user_stop，不写验收。
          row = endAttempt(db, {
            attemptId, status: 'interrupted', endReason: 'user_stop', endedAt: at, evidenceSource: EVIDENCE.USER,
          });
          processExitEvent(db, {
            taskId, attempt: row, detected: 'stop_route', expected: true, reason: '用户停止；进程已退出', at,
          });
        }
        const state = refreshTaskState(db, taskId, { now: at });
        return {
          task: requireTask(db, taskId), attempt: row, mode: 'managed', verified: true, already_stopped: false,
          process_alive: false, pid: row ? row.pid : null, event, state,
        };
      });
    } finally {
      stoppingAttempts.delete(attemptId);
    }
  }

  if (active.pid != null) {
    const alive = isPidAlive(active.pid);
    if (alive !== false) {
      throw httpError(409, 'STOP_NOT_MANAGED',
        `执行实例 ${attemptId}（${active.agent_id}，pid ${active.pid}）不是本服务启动的`
        + `${alive === true ? '，进程仍在运行' : '，进程状态无法确认'}；本服务不代为结束别人的进程。`
        + '请先在启动它的那个终端 / 会话里停止它，再回来点一次「停止」，本服务会确认进程已经退出。');
    }
    // 登记的进程已经不在了（用户刚在别处停掉了它）：把实例落成中断——不是完成，不写验收。
    return transaction(db, () => {
      const done = endedElsewhere();
      if (done) return done;
      const at = stamp();
      const row = endAttempt(db, {
        attemptId, status: 'interrupted', endReason: 'crash', endedAt: at, evidenceSource: EVIDENCE.EXECUTOR,
      });
      processExitEvent(db, {
        taskId, attempt: row, detected: 'stop_request', expected: false, reason: '收到停止请求时进程已经退出', at,
      });
      const event = taskAdminEvent(db, {
        taskId, actor, eventType: 'task_stopped', action: 'stop', at,
        payload: { attempt_id: attemptId, mode: 'unmanaged', verified: true, pid: row.pid, process_alive: false },
      });
      const state = refreshTaskState(db, taskId, { now: at });
      return {
        task: requireTask(db, taskId), attempt: row, mode: 'unmanaged', verified: true, already_stopped: false,
        process_alive: false, pid: row.pid, event, state,
      };
    });
  }

  if (!confirm) {
    // 409 的响应体里带上结构化 attempt_id（err.details，由 server.js / 测试夹具的 catch 展开进 JSON）：
    // 前端把「确认已停止」绑定到这个实例，确认请求原样带回；实例换手后旧确认就作废（R2-1）。
    const err = httpError(409, 'STOP_UNVERIFIED',
      `执行实例 ${attemptId}（${active.agent_id}）不是本服务启动的，也没有登记进程号，本服务无法确认它是否还在运行。`
      + '请先在启动它的地方停止它；确认已经停止后再点一次「确认已停止」'
      + '（接口上是带 confirm=true 和这个实例的 attempt_id），'
      + '本服务会把这次实例记为「用户停止」，不写任何验收结论。');
    err.details = { attempt_id: attemptId, agent_id: active.agent_id, started_at: active.started_at || null };
    throw err;
  }
  return transaction(db, () => {
    const done = endedElsewhere();
    if (done) return done;
    const at = stamp();
    const row = endAttempt(db, {
      attemptId, status: 'interrupted', endReason: 'user_stop', endedAt: at, evidenceSource: EVIDENCE.USER,
    });
    const event = taskAdminEvent(db, {
      taskId, actor, eventType: 'task_stopped', action: 'stop', at,
      payload: {
        attempt_id: attemptId, mode: 'declared', verified: false, pid: null, process_alive: null,
        confirmed_by: actor,
        note: '用户确认已停止；本服务没有可观测的进程，未经系统验证',
      },
    });
    const state = refreshTaskState(db, taskId, { now: at });
    return {
      task: requireTask(db, taskId), attempt: row, mode: 'declared', verified: false, already_stopped: false,
      process_alive: null, pid: null, event, state,
    };
  });
}

function batchResultOf(taskId, fn) {
  try {
    const out = fn();
    return { task_id: taskId, ok: true, ...out };
  } catch (err) {
    // 一条失败不影响其它条：错误就地收成结果，循环继续。
    return {
      task_id: taskId,
      ok: false,
      error: {
        code: err.code || 'TASK_ACTION_FAILED',
        message: String(err.message || err),
        status: err.statusCode || 500,
      },
    };
  }
}

/** 可用性探测缓存：status-v2 会被前端轮询，同一份配置 15 秒内不重复起子进程。 */
const PROBE_TTL_MS = 15000;
const probeCache = new Map(); // `${agent_id}|${updated_at}` → { at, probe }

function probeKey(a) {
  return [a.agent_id, a.updated_at, a.enabled, a.cli_command, a.base_url, a.model, a.protocol].join('|');
}

/** 通用 CLI 探测：支持完整路径（含空格）与 .cmd，失败不猜 0。 */
function probeCommand(bin, nowMs) {
  const checkedAt = stamp(nowMs);
  if (!bin) {
    return {
      available: false, reason: 'cli_not_configured', version: null, checked_at: checkedAt,
      observed_at: checkedAt, evidence_source: EVIDENCE.PROCESS_PROBE, detail: '这个 CLI Agent 还没配命令',
    };
  }
  const plan = spawnPlan(bin, ['--version']);
  const r = spawnSync(plan.command, plan.args, {
    encoding: 'utf8', timeout: 5000, windowsHide: true, shell: plan.shell, maxBuffer: 256 * 1024,
  });
  if (r.error) {
    return {
      available: false, reason: r.error.code === 'ENOENT' ? 'cli_not_found' : 'probe_failed',
      version: null, checked_at: checkedAt, observed_at: checkedAt,
      evidence_source: EVIDENCE.PROCESS_PROBE, detail: String(r.error.message || r.error).slice(0, 240),
    };
  }
  if (r.status !== 0) {
    return {
      available: false, reason: 'cli_error', version: null, checked_at: checkedAt,
      observed_at: checkedAt, evidence_source: EVIDENCE.PROCESS_PROBE,
      detail: String(r.stderr || r.stdout || `exit ${r.status}`).slice(0, 240),
    };
  }
  return {
    available: true, reason: null,
    version: String(r.stdout || '').trim().split(String.fromCharCode(10))[0].slice(0, 120) || null,
    checked_at: checkedAt, observed_at: checkedAt,
    evidence_source: EVIDENCE.PROCESS_PROBE, detail: null,
  };
}

/** 一个 Agent 的可用性证据。名册从 DB 来，探测按 kind 与 id 分流，不写死 agent 清单。 */
async function probeAgent(db, a, nowIso) {
  const nowMs = Date.now();
  const key = probeKey(a);
  const hit = probeCache.get(key);
  if (hit && nowMs - hit.at < PROBE_TTL_MS) return hit.probe;

  let probe;
  if (a.kind === 'api') {
    // 不为了一次轮询就花额度；能不能用由「测试连接 / 发一条消息」实测。
    probe = {
      available: null,
      reason: 'api_not_probed',
      checked_at: nowIso, observed_at: nowIso,
      evidence_source: 'none',
      detail: `API 已配置（${a.protocol || '?'} · ${a.model || '?'}）；可用性需发消息实测，不凭配置猜`,
    };
  } else if (a.kind === 'external' && a.agent_id === 'hermes') {
    probe = hermesAvailability(db, nowIso);
  } else if (a.kind === 'external') {
    probe = {
      available: null, reason: 'no_self_report', checked_at: nowIso, observed_at: nowIso,
      evidence_source: 'none', detail: '外部 Agent 只信自报，当前没有自报记录',
    };
  } else if (a.agent_id === 'claude') {
    try {
      const cli = await detectClaude({ now: nowMs });
      const scan = listClaudeSessions({ sinceMs: nowMs - 24 * 60 * 60 * 1000, limit: 1 });
      const latest = scan.sessions && scan.sessions[0];
      if (latest && latest.limited) {
        probe = {
          ...cli, available: false, reason: latest.reason || 'quota_5h',
          detail: latest.reset_at ? `额度重置时间 ${latest.reset_at}` : (latest.sample || null),
        };
      } else {
        probe = { ...cli, detail: cli.available ? (latest ? 'CLI 可用；执行状态仍只能看外部日志' : 'CLI 可用；未找到会话') : cli.detail };
      }
    } catch (err) {
      probe = {
        available: null, reason: 'scan_failed', checked_at: nowIso, observed_at: nowIso,
        evidence_source: EVIDENCE.EXTERNAL, detail: String(err.message || err).slice(0, 200),
      };
    }
  } else if (a.agent_id === 'dsh') {
    try {
      probe = detectDsh({ now: nowMs, dshBin: a.cli_command || undefined });
    } catch (err) {
      probe = {
        available: null, reason: 'probe_failed', checked_at: nowIso, observed_at: nowIso,
        evidence_source: EVIDENCE.EXECUTOR, detail: String(err.message || err).slice(0, 200),
      };
    }
  } else if (a.agent_id === 'codex') {
    try {
      const r = await probeCliBinary(a.cli_command || 'codex', { now: nowMs });
      probe = {
        available: r.available, reason: r.available ? null : 'cli_not_found',
        checked_at: r.checked_at, observed_at: r.observed_at,
        evidence_source: EVIDENCE.PROCESS_PROBE, detail: r.error || null,
      };
    } catch (err) {
      probe = {
        available: null, reason: 'probe_failed', checked_at: nowIso, observed_at: nowIso,
        evidence_source: EVIDENCE.PROCESS_PROBE, detail: String(err.message || err).slice(0, 200),
      };
    }
  } else {
    probe = probeCommand(a.cli_command, nowMs);
  }

  probeCache.set(key, { at: nowMs, probe });
  return probe;
}

async function collectAvailability(db, agents, nowIso) {
  const out = {};
  for (const a of agents) out[a.agent_id] = await probeAgent(db, a, nowIso);
  return out;
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

  const isBatch = path === BATCH_PATH;
  // /api/tasks/batch 是保留路径，不能被当成 task_id='batch' 的详情路由。
  const mTask = isBatch ? null : path.match(TASK_PATH);
  const mAction = path.match(TASK_ACTION_PATH);
  const isStatusV2 = path === '/api/agents/status-v2';
  const isTasks = path === '/api/tasks';

  if (!isStatusV2 && !isTasks && !isBatch && !mTask && !mAction) return false;

  const knownMethods = isStatusV2 ? ['GET']
    : isTasks ? ['GET', 'POST']
      : isBatch ? ['POST']
        : mAction ? ['POST']
          : ['GET', 'DELETE'];
  if (!knownMethods.includes(normalizedMethod)) {
    throw httpError(405, 'METHOD_NOT_ALLOWED', `${normalizedMethod} ${path} 不支持`);
  }

  const db = dbReady();
  const nowIso = stamp();

  // ---- GET /api/agents/status-v2 ---------------------------------------
  if (isStatusV2) {
    const agents = listAgents(db, { enabledOnly: true });
    const probes = await collectAvailability(db, agents, nowIso);
    const availability = Object.fromEntries(agents.map((a) => [a.agent_id, probes[a.agent_id]]));
    const result = evaluateAgentStatuses(db, { availability, now: nowIso, agents });
    send(deps, res, 200, {
      ...result,
      probes: availability,
      agents_available: agents.map((a) => a.agent_id),
    });
    return true;
  }

  // ---- GET /api/tasks ---------------------------------------------------
  if (isTasks && normalizedMethod === 'GET') {
    // A3：默认不返回归档；A4：include_archived=1 返回归档（软删始终不返回）。
    const params = queryOf(req);
    const includeArchived = flagParam(params, 'include_archived');
    const includeDeleted = flagParam(params, 'include_deleted');
    // 回收站：只要软删的行（归档与否都算）。给了它就按它，不再看 include_*。
    const onlyDeleted = flagParam(params, 'only_deleted');
    const visibility = onlyDeleted ? 'deleted' : includeDeleted ? 'all' : includeArchived ? 'not_deleted' : 'active';
    // v9：按工作流挂点过滤（真 SQL 过滤，走 idx_tasks_workflow）；不带参数就是原来的全量列表，
    // 没挂工作流的老任务照常返回（B6）。
    const link = workflowLinkOf(queryFields(params), httpError);
    const stepNameOf = stepNameResolver(db);
    const tasks = listTasks(db, {
      limit: 500, visibility, workflowRunId: link.runId, workflowStepId: link.stepId,
    }).map((task) => {
      const state = safeState(db, task.task_id, { now: nowIso });
      return taskView(db, task, state, { stepNameOf });
    });
    send(deps, res, 200, {
      ok: true,
      generated_at: nowIso,
      observed_at: nowIso,
      evidence_source: EVIDENCE.SYSTEM,
      include_archived: includeArchived,
      include_deleted: includeDeleted,
      only_deleted: onlyDeleted,
      // 本进程的任务 API 有哪些能力（前端据此识别「服务端还是旧代码」）；见 API_FEATURES。
      api_features: API_FEATURES,
      workflow_run_id: link.runId,
      workflow_step_id: link.stepId,
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
      : DEFAULT_TASK_STEPS;
    // v9：可带工作流挂点；带了就必须是真实存在的 run / 步骤（404），不写悬空引用。
    const link = requireWorkflowLink(db, workflowLinkOf(body, httpError), httpError);
    const task = createTask(db, {
      title,
      acceptance: body.acceptance ?? null,
      steps,
      taskId: body.task_id || body.taskId || undefined,
      source: 'api',
      evidenceSource: EVIDENCE.USER,
      workflowRunId: link.runId,
      workflowStepId: link.stepId,
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

  // ---- POST /api/tasks/batch -------------------------------------------
  // A9：action = archive | delete | restore，ids 逐条执行，逐条返回。
  // 一条 running 删除失败不能拖垮其它两条——所以这里绝不整体抛错/整体回滚。
  // 每一条自己是一个事务（archiveOne / deleteOne / restoreOne）：某一条的审计事件写失败了，
  // 报的是失败、库里也确实没改；逐条结果和实际写入一致。
  if (isBatch && normalizedMethod === 'POST') {
    const body = (await bodyOf(req, deps)) || {};
    const action = pickString(body, 'action', 'op');
    if (!action || !BATCH_ACTIONS.has(action)) {
      throw httpError(400, 'BAD_BATCH_ACTION', 'action 必须是 archive / delete / restore');
    }
    const rawIds = Array.isArray(body.ids) ? body.ids
      : Array.isArray(body.task_ids) ? body.task_ids
        : Array.isArray(body.taskIds) ? body.taskIds
          : null;
    if (!rawIds || !rawIds.length) throw httpError(400, 'BAD_BATCH_IDS', 'ids 必须是非空数组');
    const ids = [...new Set(rawIds.map((x) => String(x || '').trim()).filter(Boolean))];
    if (!ids.length) throw httpError(400, 'BAD_BATCH_IDS', 'ids 里没有有效 task_id');
    const actor = actorOf(req, body);
    const opts = { actor, at: nowIso, httpError };
    const impl = action === 'archive' ? archiveOne : action === 'delete' ? deleteOne : restoreOne;
    const results = ids.map((id) => batchResultOf(id, () => impl(db, id, opts)));
    const succeeded = results.filter((r) => r.ok).length;
    send(deps, res, 200, {
      ok: true,
      action,
      actor,
      observed_at: nowIso,
      evidence_source: EVIDENCE.USER,
      requested: ids.length,
      succeeded,
      failed: ids.length - succeeded,
      results,
    });
    return true;
  }

  // ---- GET /api/tasks/:id ----------------------------------------------
  if (mTask && normalizedMethod === 'GET') {
    const taskId = mTask[1];
    let task = getTask(db, taskId);
    if (!task) throw httpError(404, 'TASK_NOT_FOUND', `任务不存在：${taskId}`);
    // 响应里的三个状态必须说的是同一件事：state / view 是按证据实时算的，task 是库里的状态列。
    // 状态列落后于证据时（返工前的 restore 写回了旧值、进程消失后还没人触发刷新……），
    // 读一次详情就对齐一次。只在确实不一致时才写：不然每看一眼详情都会刷 updated_at，把任务顶到列表最上面。
    // 要写才进事务（R2-3）：事务里重读重判——外面的判断可能已经过期，不用跨事务的旧判断落库；
    // 状态列和 status_changed 审计事件在同一个事务里同生同死，审计写不进去时状态列一起回滚，
    // 不会出现「接口 500、库里 status 却已经变了、事件是 0」的半提交。只读路径不开写锁。
    let state = evaluateTaskState(db, taskId, { now: nowIso });
    if (state.status !== task.status) {
      state = transaction(db, () => {
        const current = getTask(db, taskId);
        const liveNow = evaluateTaskState(db, taskId, { now: nowIso });
        // 有人抢在前面同步过了：不重复写（也避免多刷一次 updated_at）。
        if (liveNow.status === current.status) return liveNow;
        return refreshTaskState(db, taskId, { now: nowIso });
      });
      task = getTask(db, taskId);
    }
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

  // ---- POST /api/tasks/:id/archive -------------------------------------
  // A1/A2/A10：写 archived_at=当前时间、archived_from=当前 status；status 不变；写事件。
  if (mAction && mAction[2] === 'archive' && normalizedMethod === 'POST') {
    const taskId = mAction[1];
    const body = (await bodyOf(req, deps)) || {};
    const actor = actorOf(req, body);
    const result = archiveOne(db, taskId, { actor, at: nowIso, httpError });
    send(deps, res, 200, {
      ok: true,
      action: 'archive',
      task_id: taskId,
      actor,
      observed_at: nowIso,
      evidence_source: EVIDENCE.USER,
      archived_at: result.archived_at,
      archived_from: result.archived_from,
      status: result.task.status,
      event: result.event,
      task: result.task,
    });
    return true;
  }

  // ---- POST /api/tasks/:id/restore -------------------------------------
  // A5/A6/A10：archived_at 置空，status 用 archived_from 还原；写事件。
  if (mAction && mAction[2] === 'restore' && normalizedMethod === 'POST') {
    const taskId = mAction[1];
    const body = (await bodyOf(req, deps)) || {};
    const actor = actorOf(req, body);
    const result = restoreOne(db, taskId, { actor, at: nowIso, httpError });
    send(deps, res, 200, {
      ok: true,
      action: 'restore',
      task_id: taskId,
      actor,
      observed_at: nowIso,
      evidence_source: EVIDENCE.USER,
      archived_at: null,
      // status = 恢复之后的当前状态（按最新执行证据重算过的）；restored_status = 按 archived_from 写回去的那个。
      // 实例在归档期间结束了的话两者不同（running → completed / interrupted）。
      status: result.status,
      restored_status: result.restored_status,
      event: result.event,
      task: result.task,
      state: result.state,
      view: taskView(db, result.task, result.state),
    });
    return true;
  }

  // ---- POST /api/tasks/:id/stop ----------------------------------------
  // 「正在跑的不能删，需要先停」里的那个「停」：结束正在跑的执行实例，不写验收。
  // body: { actor?, confirm?, attempt_id? }。confirm 只对「不是本服务启动、也没登记 pid」的实例有意义：
  // 那种实例本服务无法确认，必须由用户明确说「我已经停掉了」才记为用户停止。
  // confirm 必须带 attempt_id（R2-1）：用户确认的是第一次被拒时点名给他的那个实例；
  // 实例换了还拿旧确认来点，服务端 409 STOP_TARGET_CHANGED，不会动新实例。
  if (mAction && mAction[2] === 'stop' && normalizedMethod === 'POST') {
    const taskId = mAction[1];
    const body = (await bodyOf(req, deps)) || {};
    const actor = actorOf(req, body);
    const result = await stopOne(db, taskId, {
      actor, httpError,
      confirm: body.confirm === true || body.confirm === 'true',
      targetAttemptId: pickString(body, 'attempt_id', 'attemptId'),
    });
    // 停完一个，任务里可能还有别的在跑（单实例约束上线前的遗留形态）。停止的答复必须说明剩余：
    // 界面据此保留「停止」入口，也据此不说「现在可以删除」（R2-2）。
    const remainingAttempts = runningAttemptsOf(db, taskId)
      .map((a) => ({ attempt_id: a.attempt_id, agent_id: a.agent_id, pid: a.pid ?? null }));
    const observedAt = result.event ? result.event.observed_at : nowIso;
    send(deps, res, 200, {
      ok: true,
      action: 'stop',
      task_id: taskId,
      actor,
      observed_at: observedAt,
      evidence_source: EVIDENCE.USER,
      stopped: true,
      // verified：本服务是否亲眼确认进程已退出。declared 那种是用户确认的，这里是 false。
      verified: result.verified,
      // mode：managed（本进程托管，等到了退出）/ unmanaged（别处起的，pid 已不在）/ declared（用户确认）/ none（本来就没在跑）
      mode: result.mode,
      already_stopped: result.already_stopped,
      attempt: result.attempt ? attemptView(result.attempt) : null,
      // 这个任务还剩几个没结束的执行实例（R2-2）：count 0 才是真的「全停干净、可以删除」。
      remaining_running: { count: remainingAttempts.length, attempts: remainingAttempts },
      pid: result.pid ?? null,
      process_alive: result.process_alive ?? null,
      event: result.event,
      state: result.state,
      task: taskView(db, result.task, result.state),
    });
    return true;
  }

  // ---- DELETE /api/tasks/:id -------------------------------------------
  // A7：running → 409 TASK_RUNNING（不是 500，不是静默跳过）。
  // A8：非 running → 软删，只写 deleted_at，行还在。
  if (mTask && normalizedMethod === 'DELETE') {
    const taskId = mTask[1];
    const body = (await bodyOf(req, deps)) || {};
    const actor = actorOf(req, body);
    const result = deleteOne(db, taskId, { actor, at: nowIso, httpError });
    send(deps, res, 200, {
      ok: true,
      action: 'delete',
      task_id: taskId,
      actor,
      observed_at: nowIso,
      evidence_source: EVIDENCE.USER,
      deleted_at: result.deleted_at,
      status: result.task.status,
      event: result.event,
      task: result.task,
    });
    return true;
  }

  // ---- POST /api/tasks/:id/attempt -------------------------------------
  if (mAction && mAction[2] === 'attempt' && normalizedMethod === 'POST') {
    const taskId = mAction[1];
    // 先挡一道「任务不存在」（在读请求体之前就回 404）；真正算数的是下面事务里的检查。
    requireTask(db, taskId);
    const body = (await bodyOf(req, deps)) || {};
    const agentId = pickString(body, 'agent_id', 'agentId') || 'dsh';
    if (!agentExists(db, agentId, { enabledOnly: true })) throw httpError(400, 'BAD_AGENT', `未知或已禁用的 agent_id：${agentId}`);
    const worktreePath = pickString(body, 'worktree_path', 'worktreePath');
    const attemptId = newAttemptId();

    // 「任务没被删」的检查、抢写入权、建实例行在同一个事务里：检查和建行之间插不进一次删除
    // （多进程下「先删后启动」会留下一条看不见却在运行的任务，评审 P1-2）；
    // 建行失败时写入权也跟着回滚，不再需要事后补偿。
    // 同一个事务里还有单活动实例约束（R2-2）：已有 running 的实例就不许再开第二个——
    // 「连开两个、停掉新的、旧的还在跑、按钮却没了、删除还被拒」那个死局从入口上断掉。
    // 交接（handoff）不受影响：它建新实例的同时在同一个事务里结束旧实例，不是「再开一个」。
    // 约束上线前已有的重复 running 是遗留形态：这里不清理（删别人的执行记录不能悄悄做），
    // 靠 running_attempts / remaining_running / 删除守卫把界面和事实对齐。
    const attempt = transaction(db, () => {
      requireNotDeletedTask(db, taskId);
      const alreadyRunning = runningAttemptsOf(db, taskId);
      if (alreadyRunning.length) {
        throw httpError(409, 'ATTEMPT_ALREADY_RUNNING',
          `任务已有执行实例在运行（${alreadyRunning.map((a) => a.attempt_id).join('、')}），`
          + `同一任务同时只允许一个活动实例；请先停止或等它结束再启动新的：${taskId}`);
      }
      if (worktreePath) {
        acquireWriteOwner(db, {
          worktreePath, taskId, attemptId, agentId, now: nowIso,
          force: Boolean(body.force), forceReason: body.force_reason || null,
        });
      }
      return createAttempt(db, {
        taskId, agentId, attemptId, worktreePath,
        pid: body.pid == null ? null : Number(body.pid),
        sessionId: pickString(body, 'session_id', 'sessionId'),
        startedAt: nowIso,
        note: pickString(body, 'note'),
        evidenceSource: agentId === 'claude' || agentId === 'codex' ? EVIDENCE.EXTERNAL : EVIDENCE.EXECUTOR,
      });
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
    // 已软删的任务不能再产生执行痕迹（检查点要跑 git，比较慢，所以不把守卫包进事务，只在入口挡）。
    requireNotDeletedTask(db, taskId);
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
    if (!toAgent || !agentExists(db, toAgent, { enabledOnly: true })) throw httpError(400, 'BAD_AGENT', 'to_agent_id 必填且必须是启用中的已知 Agent');
    const fromAttemptId = pickString(body, 'from_attempt_id', 'fromAttemptId', 'from');
    const explicitPath = pickString(body, 'worktree_path', 'worktreePath');

    // 交接会新建一个 running 的实例，所以同样是执行入口：已软删的任务 409。
    // 整段（转移写入权、建新实例、结束旧实例、写事件）在一个事务里：
    // 半路失败不会出现「写入权转了、新实例没建」。
    const handoff = transaction(db, () => {
      requireNotDeletedTask(db, taskId);

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
      return { fromAttempt, toAttempt, transfer, checkpointId };
    });

    const state = refreshTaskState(db, taskId, { now: nowIso });
    send(deps, res, 201, {
      ok: true,
      observed_at: nowIso,
      evidence_source: EVIDENCE.EXECUTOR,
      from_attempt: attemptView(getAttempt(db, handoff.fromAttempt.attempt_id)),
      to_attempt: attemptView(handoff.toAttempt),
      write_owner: ownerView(handoff.transfer.owner),
      checkpoint_id: handoff.checkpointId,
      state,
    });
    return true;
  }

  // ---- POST /api/tasks/:id/finish ----------------------------------------
  // 「做完了」不是一个可以直接写的状态：状态机只认 acceptance_passed（硬规矩 3：Agent 自称完成不算）。
  // 所以 finish 做三件事：把执行实例正常结束（completed/done）、记一条带证据的验收结论、
  // 让状态机自己算出 completed。没有证据（evidence）一律 400——声称完成必须附证据。
  if (mAction && mAction[2] === 'finish' && normalizedMethod === 'POST') {
    const taskId = mAction[1];
    requireTask(db, taskId);
    const body = (await bodyOf(req, deps)) || {};
    const result = body.result === 'failed' ? 'failed' : 'passed';
    const evidence = pickString(body, 'evidence', 'report', 'evidence_path');
    if (!evidence) {
      throw httpError(400, 'EVIDENCE_REQUIRED', 'finish 必须带 evidence（验收证据的路径或链接）；没有证据不能记成完成');
    }
    const note = pickString(body, 'note', 'summary');
    const command = pickString(body, 'command');
    const codeSha = pickString(body, 'code_sha', 'codeSha');

    // 已软删的任务不能再收尾记验收（先恢复）。结束实例、记验收、落步骤、刷状态在同一个事务里：
    // 验收事件写不进去时，实例不会已经被记成「正常跑完」却没有任何验收结论。
    const finished = transaction(db, () => {
      requireNotDeletedTask(db, taskId);

      const attemptId = pickString(body, 'attempt_id', 'attemptId')
        || (latestAttempt(db, { taskId, status: 'running' }) || latestAttempt(db, { taskId }) || {}).attempt_id
        || null;
      let attempt = null;
      if (attemptId) {
        const found = getAttempt(db, attemptId);
        if (!found || found.task_id !== taskId) {
          throw httpError(409, 'ATTEMPT_MISMATCH', `执行实例 ${attemptId} 不属于任务 ${taskId}`);
        }
        attempt = found;
        if (attempt.status === 'running') {
          // 实例是正常跑到头的：落 completed/done。任务最终是不是 completed 由下面的验收结论决定
          attempt = endAttempt(db, {
            attemptId, status: 'completed', endReason: 'done', endedAt: nowIso, evidenceSource: EVIDENCE.USER,
          });
        }
      }

      const acceptance = recordAcceptance(db, {
        taskId, attemptId: attempt ? attempt.attempt_id : null, result, codeSha, command,
        report: evidence, note,
        // 带了验收命令 = 脚本验的（verifier）；否则是人工验收（user）
        evidenceSource: command ? EVIDENCE.VERIFIER : EVIDENCE.USER,
        observedAt: nowIso,
      });

      if (result === 'passed') {
        // 任务完成 ⇒ 步骤一并落 done（没跳过的），看板的「N / N 步」才和状态对得上
        for (const step of getSteps(db, taskId)) {
          if (step.status === 'done' || step.status === 'skipped') continue;
          updateStep(db, taskId, step.key, { status: 'done', at: nowIso, note: step.note || '' });
        }
      }

      return { attempt, acceptance, state: refreshTaskState(db, taskId, { now: nowIso }) };
    });

    send(deps, res, 200, {
      ok: true,
      observed_at: finished.state.observed_at,
      evidence_source: finished.state.evidence_source,
      acceptance: finished.acceptance,
      attempt: finished.attempt ? attemptView(getAttempt(db, finished.attempt.attempt_id)) : null,
      state: finished.state,
      task: taskView(db, requireTask(db, taskId), finished.state),
    });
    return true;
  }

  return false;
}

/**
 * 从任务书批量建任务（v9）：POST /api/workflow/runs/:runId/steps/:stepId/tasks
 * 路由匹配在 api-workflow-runs.mjs，这里是被它调用的处理函数。
 *
 *   body  { tasks: [{ title, acceptance? }, ...] }
 *   201   { ok, created, tasks: [taskView...], workflow_run_id, workflow_step_id, workflow_step_name, actor }
 *   400   tasks 不是非空数组 / 某一项没有 title —— 整批一条都不建
 *   404   run 不存在（RUN_NOT_FOUND）/ run 里没有这一步（STEP_NOT_FOUND）
 *
 * 整批全建或全不建：任务书是一个整体，半批任务 + 调用方重试 = 重复任务。
 * 与 /api/tasks/batch（归档/删除，逐条独立、允许部分失败）刻意不同——那边操作的是互不相干的已有任务。
 */
export async function createWorkflowStepTasks(req, res, runId, stepId, deps = {}) {
  const httpError = mkHttpError(deps);
  const db = dbReady();
  const nowIso = stamp();

  // 路径上的 run / 步骤先验：不存在就是 404，不看 body。
  const link = requireWorkflowLink(db, { runId, stepId }, httpError);
  const body = (await bodyOf(req, deps)) || {};
  if (!Array.isArray(body.tasks) || !body.tasks.length) {
    throw httpError(400, 'BAD_TASKS', 'tasks 必须是非空数组：[{ title, acceptance? }, ...]');
  }
  const actor = actorOf(req, body);

  let created;
  try {
    created = createTasksForWorkflowStep(db, {
      runId: link.runId, stepId: link.stepId, items: body.tasks, actor, at: Date.now(),
    });
  } catch (err) {
    // 校验类错误（BAD_TITLE 等）原样转成 HTTP；其它（磁盘、约束）照旧上抛成 500，事务已回滚。
    if (err && err.statusCode && err.statusCode < 500) throw httpError(err.statusCode, err.code, err.message);
    throw err;
  }

  // 与单条 POST /api/tasks 走同一条状态刷新；now 用每条自己的 created_at，
  // 不把整批的 updated_at 刷成同一毫秒（列表靠它保持整批的确定顺序）。
  const stepNameOf = stepNameResolver(db);
  const tasks = created.map((task) => {
    const state = refreshTaskState(db, task.task_id, { now: new Date(task.created_at) });
    return taskView(db, task, state, { stepNameOf });
  });
  send(deps, res, 201, {
    ok: true,
    created: tasks.length,
    tasks,
    workflow_run_id: link.runId,
    workflow_step_id: link.stepId,
    workflow_step_name: link.stepName,
    actor,
    observed_at: nowIso,
    evidence_source: EVIDENCE.USER,
  });
  return true;
}
