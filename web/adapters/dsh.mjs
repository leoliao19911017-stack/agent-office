// dsh.mjs — DSH adapter（P0 托管）。
//
// 为什么 DSH 是 P0：它由 Agent Office 自己启动，能拿到进程、退出码和 JSON 事件流，
// 所以「谁启动、进程何时退出、实例归属谁」都有权威证据。
//
// 本适配器做四件事：
//   1) 起进程：dsh --profile headless ... --json -，prompt 走 stdin；
//   2) 吃事件：逐行解析 stdout JSON，映射成 tool_call / permission_request /
//      api_error / claim_done / artifact_produced ...，全部标 evidence_source=executor；
//   3) 额度阻塞：识别 quota/rate-limit/auth，写 block 事件 + 标记 relay_pending +
//      自动生成检查点（保存现场），但**不杀进程**——任务书 T04 要求进程还在时判 blocked；
//   4) 退出归因：正常退出→completed，被强杀/异常→interrupted，并把 attempt 落库。
//
// 启动失败（命令不存在等）不抛到调用方：写 agent_start_failed、把 attempt 标
// failed/spawn_failed，任务保持原状态（T06 要求仍是 interrupted，不是 idle）。

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendEvent, classifyFailure, recordBlockEvent, EVIDENCE } from '../lib/events.mjs';
import {
  createAttempt, endAttempt, getAttempt, setRelayPending,
} from '../lib/attempts.mjs';
import { acquireWriteOwner, releaseAllForAttempt } from '../lib/write-owner.mjs';
import { createCheckpoint } from '../lib/checkpoint.mjs';
import { refreshTaskState } from '../lib/state-machine.mjs';
import { requireTask, newAttemptId } from '../lib/tasks.mjs';

export const DSH_BIN_ENV = 'DSH_BIN';

/** 任务书给出的 DSH headless 启动形状。 */
export function dshArgs(opts = {}) {
  const {
    sessionId = null,
    profile = 'headless',
    permissionMode = 'workspace-write',
    approvalPolicy = 'never',
  } = opts;
  const args = ['--profile', profile, '--permission-mode', permissionMode,
    '--approval-policy', approvalPolicy];
  if (sessionId) args.push('--session-id', sessionId);
  args.push('--json', '-');
  return args;
}

export function defaultDshBin() {
  if (process.env[DSH_BIN_ENV]) return process.env[DSH_BIN_ENV];
  // 本机 DSH 装在用户目录下，PATH 里没有；先找已知位置，再退回 PATH。
  const local = process.env.LOCALAPPDATA
    || (process.env.USERPROFILE ? `${process.env.USERPROFILE}/AppData/Local` : null);
  if (local) {
    const known = `${String(local).replace(/\\/g, '/')}/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd`;
    if (existsSync(known)) return known;
  }
  return 'dsh';
}

function stamp(now) {
  return (now instanceof Date ? now : new Date(now ?? Date.now())).toISOString();
}

function isCmdFile(bin) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(String(bin));
}

function shellQuote(s) {
  const text = String(s);
  return /[\s"&|<>^]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

/**
 * .cmd/.bat 在 Windows 上不能直接 exec，必须经 cmd.exe。把命令和参数拼成一个
 * 已引用的字符串再交给 shell，避免「路径含空格 → 被拆成两段」以及 DEP0190。
 */
function spawnPlan(command, args) {
  if (!isCmdFile(command)) return { command, args, shell: false };
  return {
    command: `"${command}" ${(args || []).map(shellQuote).join(' ')}`.trim(),
    args: [],
    shell: true,
  };
}

/**
 * 探测 DSH CLI 是否可用。这是「Agent 可用性」证据，不是执行证据。
 * 找不到就是 available:false + reason=cli_not_found，不猜。
 */
export function detectDsh(opts = {}) {
  const bin = opts.dshBin || defaultDshBin();
  const checkedAt = stamp(opts.now);
  const timeout = opts.timeoutMs || 5000;
  const plan = spawnPlan(bin, ['--version']);
  const r = spawnSync(plan.command, plan.args, {
    encoding: 'utf8', timeout, windowsHide: true, shell: plan.shell, maxBuffer: 256 * 1024,
  });
  if (r.error) {
    return {
      available: false,
      reason: r.error.code === 'ENOENT' ? 'cli_not_found' : 'probe_failed',
      version: null,
      command: bin,
      checked_at: checkedAt,
      observed_at: checkedAt,
      evidence_source: EVIDENCE.EXECUTOR,
      detail: String(r.error.message || r.error).slice(0, 240),
    };
  }
  if (r.status !== 0) {
    return {
      available: false,
      reason: 'cli_error',
      version: null,
      command: bin,
      checked_at: checkedAt,
      observed_at: checkedAt,
      evidence_source: EVIDENCE.EXECUTOR,
      detail: String(r.stderr || r.stdout || `exit ${r.status}`).slice(0, 240),
    };
  }
  return {
    available: true,
    reason: null,
    version: String(r.stdout || '').trim().split(/\r?\n/)[0].slice(0, 120) || null,
    command: bin,
    checked_at: checkedAt,
    observed_at: checkedAt,
    evidence_source: EVIDENCE.EXECUTOR,
    detail: null,
  };
}

/** 把可用性探测结果落成事件，供 status-v2 / 审计查询。 */
export function recordDshAvailability(db, opts = {}) {
  const availability = opts.availability || detectDsh(opts);
  appendEvent(db, {
    agentId: 'dsh',
    eventType: 'agent_availability',
    payload: availability,
    evidenceSource: EVIDENCE.EXECUTOR,
    observedAt: availability.checked_at || opts.now,
  });
  return availability;
}

/** 从事件对象里尽力抽出文件路径；抽不到就不伪造产物。 */
function extractFiles(msg) {
  const out = [];
  const push = (v) => {
    if (!v) return;
    if (typeof v === 'string') { out.push(v); return; }
    if (Array.isArray(v)) { v.forEach(push); return; }
    if (typeof v === 'object' && (v.path || v.file)) out.push(v.path || v.file);
  };
  push(msg.files);
  push(msg.paths);
  push(msg.artifacts);
  push(msg.path);
  push(msg.file);
  if (Array.isArray(msg.changes)) {
    for (const c of msg.changes) push(c && (c.path || c.file));
  }
  return [...new Set(out.map(String))];
}

/**
 * 把一行 DSH JSON 映射成内部事件类型。
 * 兼容常见命名：type / event / kind / subtype。
 */
export function classifyDshMessage(msg) {
  const obj = msg && typeof msg === 'object' ? msg : { raw: msg };
  const type = String(obj.type || obj.event || obj.kind || obj.subtype || '').toLowerCase();
  const text = (() => { try { return JSON.stringify(obj).slice(0, 6000); } catch { return String(obj); } })();

  if (/permission|approval|confirm/.test(type)) {
    const granted = /grant|allow|approv|confirm(ed)?/i.test(text) && !/request|ask|need/i.test(type);
    return { eventType: granted ? 'permission_granted' : 'permission_request', payload: obj };
  }
  if (/quota|usage.?limit|rate.?limit|too many requests|auto_compact|limit_reached/.test(type)
    || /\b429\b/.test(text)) {
    const reason = classifyFailure(text);
    return { eventType: 'api_error', payload: obj, block: reason !== 'other' || /quota|limit|429/.test(type), reason };
  }
  if (/auth|unauthor|401|403|login|credential/.test(type)) {
    return { eventType: 'api_error', payload: obj, block: true, reason: 'auth_failed' };
  }
  if (/api.?error|error/.test(type)) {
    const reason = classifyFailure(text);
    return { eventType: 'api_error', payload: obj, block: reason !== 'other', reason };
  }
  if (/tool/.test(type)) {
    return { eventType: 'tool_call', payload: obj, files: extractFiles(obj) };
  }
  if (/think|reason|assistant|message|text/.test(type)) {
    return { eventType: 'thinking', payload: obj };
  }
  if (/file|artifact|write|patch|edit/.test(type)) {
    const files = extractFiles(obj);
    if (files.length) return { eventType: 'artifact_produced', payload: { ...obj, files } };
    return { eventType: 'file_changed', payload: obj };
  }
  if (/result|done|complete|finish|success|step.?end/.test(type)) {
    return { eventType: 'claim_done', payload: obj };
  }
  return { eventType: 'dsh_event', payload: obj };
}

function killTree(child) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true, timeout: 8000, stdio: 'ignore',
      });
      return;
    } catch { /* 落到 child.kill */ }
  }
  try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
}

function safeRefresh(db, taskId, opts = {}) {
  try {
    return refreshTaskState(db, taskId, opts);
  } catch {
    return null;
  }
}

/**
 * 启动一次 DSH 执行实例（异步：等 spawn 成功或失败才返回）。
 *
 * @returns {Promise<{ok:boolean, attempt:object, child?:object, done?:Promise, stop?:Function, kill?:Function, error?:string}>}
 */
export async function startDshAttempt(opts = {}) {
  const {
    db, taskId, prompt = '', worktreePath = null, cwd = null,
    command = defaultDshBin(), args = null, env = null,
    sessionId = null, agentId = 'dsh',
    acquireOwner = Boolean(worktreePath),
    checkpointOnBlock = true,
    now = null,
    stdio = 'pipe',
  } = opts;

  if (!db) throw Object.assign(new Error('startDshAttempt 需要 db'), { code: 'BAD_DSH', statusCode: 400 });
  requireTask(db, taskId);

  // 先抢写入权再建实例：抢不到就不留一条「running 但没人管」的孤儿 attempt。
  const attemptId = newAttemptId();
  let owner = null;
  if (acquireOwner && worktreePath) {
    owner = acquireWriteOwner(db, {
      worktreePath, taskId, attemptId, agentId, now,
    });
  }

  let attempt;
  try {
    attempt = createAttempt(db, {
      taskId,
      agentId,
      worktreePath,
      attemptId,
      status: 'running',
      sessionId,
      startedAt: stamp(now),
      note: 'DSH 托管实例',
      evidenceSource: EVIDENCE.EXECUTOR,
    });
  } catch (err) {
    if (owner) releaseAllForAttempt(db, attemptId, now);
    throw err;
  }

  const spawnArgs = Array.isArray(args) ? args : dshArgs({ sessionId });
  const childEnv = { ...process.env, ...(env || {}) };
  const plan = spawnPlan(command, spawnArgs);
  let child;
  try {
    child = spawn(plan.command, plan.args, {
      cwd: cwd || worktreePath || process.cwd(),
      env: childEnv,
      stdio: [stdio, 'pipe', 'pipe'],
      windowsHide: true,
      shell: plan.shell,
    });
  } catch (err) {
    const message = String(err && err.message ? err.message : err);
    endAttempt(db, {
      attemptId: attempt.attempt_id, status: 'failed', endReason: 'spawn_failed',
      evidenceSource: EVIDENCE.EXECUTOR,
    });
    appendEvent(db, {
      taskId, attemptId: attempt.attempt_id, agentId,
      eventType: 'agent_start_failed',
      payload: { command, args: spawnArgs, error: message },
      evidenceSource: EVIDENCE.EXECUTOR,
    });
    if (owner) releaseAllForAttempt(db, attempt.attempt_id, now);
    safeRefresh(db, taskId, { now });
    return { ok: false, attempt: getAttempt(db, attempt.attempt_id), error: message };
  }

  // 等 spawn / error。'spawn' 成功事件在 Node 里是异步发的。
  const started = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: true }), 5000);
    child.once('spawn', () => { clearTimeout(timer); resolve({ ok: true }); });
    child.once('error', (err) => { clearTimeout(timer); resolve({ ok: false, error: err }); });
  });

  if (!started.ok) {
    const message = String(started.error && started.error.message ? started.error.message : started.error);
    endAttempt(db, {
      attemptId: attempt.attempt_id, status: 'failed', endReason: 'spawn_failed',
      evidenceSource: EVIDENCE.EXECUTOR,
    });
    appendEvent(db, {
      taskId, attemptId: attempt.attempt_id, agentId,
      eventType: 'agent_start_failed',
      payload: { command, args: spawnArgs, error: message },
      evidenceSource: EVIDENCE.EXECUTOR,
    });
    if (owner) releaseAllForAttempt(db, attempt.attempt_id, now);
    safeRefresh(db, taskId, { now });
    return { ok: false, attempt: getAttempt(db, attempt.attempt_id), error: message };
  }

  const pid = child.pid || null;
  db.prepare('UPDATE attempts SET pid = ? WHERE attempt_id = ?').run(pid, attempt.attempt_id);
  appendEvent(db, {
    taskId, attemptId: attempt.attempt_id, agentId,
    eventType: 'process_spawned',
    payload: { pid, command, args: spawnArgs },
    evidenceSource: EVIDENCE.EXECUTOR,
    observedAt: stamp(now),
  });

  let stopMode = null; // null=正常运行；user_stop / crash
  let stderrTail = '';
  let lineBuf = '';
  let blockReason = null;
  let blockMessage = '';
  let ended = false;
  let session = sessionId;

  const applySession = (msg) => {
    const sid = msg && (msg.session_id || msg.sessionId || (msg.session && msg.session.id));
    if (sid && sid !== session) {
      session = String(sid);
      db.prepare('UPDATE attempts SET session_id = ? WHERE attempt_id = ?').run(session, attempt.attempt_id);
    }
  };

  const onWake = () => { safeRefresh(db, taskId, {}); };

  const handleMessage = async (msg) => {
    applySession(msg);
    const cls = classifyDshMessage(msg);
    const observedAt = msg && (msg.timestamp || msg.at || msg.time)
      ? (() => { const t = new Date(msg.timestamp || msg.at || msg.time); return Number.isNaN(t.getTime()) ? null : t.toISOString(); })()
      : null;

    if (cls.eventType === 'api_error' && cls.block) {
      blockReason = cls.reason || 'other';
      blockMessage = (msg && (msg.message || msg.error || msg.error_message)) || '';
      const { reason } = recordBlockEvent(db, {
        taskId, attemptId: attempt.attempt_id, agentId,
        reason: blockReason, message: JSON.stringify(msg).slice(0, 400),
        evidenceSource: EVIDENCE.EXECUTOR, observedAt,
      });
      blockReason = reason;
      setRelayPending(db, {
        attemptId: attempt.attempt_id, pending: true, reason,
        observedAt, evidenceSource: EVIDENCE.EXECUTOR,
      });
      // T04：额度耗尽要保存现场。检查点失败不能掩盖阻塞事件本身。
      if (checkpointOnBlock && worktreePath && existsSync(worktreePath)) {
        try {
          createCheckpoint(db, {
            taskId, attemptId: attempt.attempt_id, worktreePath,
            label: `blocked_${reason}`, now: observedAt || undefined,
          });
        } catch (err) {
          appendEvent(db, {
            taskId, attemptId: attempt.attempt_id, agentId,
            eventType: 'checkpoint_failed',
            payload: { reason, error: String(err && err.message ? err.message : err) },
            evidenceSource: EVIDENCE.EXECUTOR,
            observedAt,
          });
        }
      }
      onWake();
      return;
    }

    appendEvent(db, {
      taskId, attemptId: attempt.attempt_id, agentId,
      eventType: cls.eventType,
      payload: cls.files ? { ...cls.payload, files: cls.files } : cls.payload,
      evidenceSource: EVIDENCE.EXECUTOR,
      observedAt,
    });

    if (cls.eventType === 'permission_request'
      || cls.eventType === 'permission_granted'
      || cls.eventType === 'claim_done'
      || cls.eventType === 'artifact_produced'
      || cls.eventType === 'step_end') {
      onWake();
    }
  };

  const flushLines = (chunk) => {
    lineBuf += chunk;
    let idx;
    while ((idx = lineBuf.indexOf('\n')) >= 0) {
      const line = lineBuf.slice(0, idx).trim();
      lineBuf = lineBuf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch {
        appendEvent(db, {
          taskId, attemptId: attempt.attempt_id, agentId,
          eventType: 'stdout_non_json',
          payload: { line: line.slice(0, 2000) },
          evidenceSource: EVIDENCE.EXECUTOR,
        });
        continue;
      }
      try { void handleMessage(msg); } catch (err) {
        appendEvent(db, {
          taskId, attemptId: attempt.attempt_id, agentId,
          eventType: 'adapter_error',
          payload: { error: String(err && err.message ? err.message : err) },
          evidenceSource: EVIDENCE.EXECUTOR,
        });
      }
    }
  };

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', flushLines);
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk).slice(-16384);
  });

  if (child.stdin) {
    try { child.stdin.end(prompt || ''); } catch { /* 进程可能已退出 */ }
  }

  const done = new Promise((resolve) => {
    child.once('close', (code, signal) => {
      if (ended) return;
      ended = true;

      // 退出前把最后一行没换行的 JSON 也读掉。
      if (lineBuf.trim()) {
        const line = lineBuf.trim();
        lineBuf = '';
        try { void handleMessage(JSON.parse(line)); } catch { /* 忽略残行 */ }
      }

      let status;
      let endReason;
      let expected = false;
      if (stopMode === 'user_stop') {
        status = 'interrupted';
        endReason = 'user_stop';
        expected = true;
      } else if (blockReason) {
        status = 'failed';
        endReason = blockReason === 'auth_failed' ? 'auth_failed' : 'quota_blocked';
      } else if (code === 0) {
        status = 'completed';
        endReason = 'done';
        expected = true;
      } else {
        status = 'interrupted';
        endReason = 'crash';
      }

      const at = stamp();
      appendEvent(db, {
        taskId, attemptId: attempt.attempt_id, agentId,
        eventType: 'process_exit',
        payload: {
          code, signal, expected,
          stop_mode: stopMode,
          block_reason: blockReason,
          stderr_tail: stderrTail ? stderrTail.slice(-4000) : null,
        },
        evidenceSource: EVIDENCE.EXECUTOR,
        observedAt: at,
      });
      endAttempt(db, {
        attemptId: attempt.attempt_id,
        status,
        endReason,
        endedAt: at,
        evidenceSource: EVIDENCE.EXECUTOR,
        keepRelayPending: Boolean(blockReason),
      });
      releaseAllForAttempt(db, attempt.attempt_id, at);
      const state = safeRefresh(db, taskId, {});
      resolve({
        ok: status === 'completed',
        status,
        end_reason: endReason,
        code,
        signal,
        attempt: getAttempt(db, attempt.attempt_id),
        state,
      });
    });
  });

  const stop = async (reason = 'user_stop') => {
    if (ended) return done;
    stopMode = reason === 'crash' ? 'crash' : 'user_stop';
    // 主动停止/强杀都要先停止写入，再杀进程树。
    killTree(child);
    return done;
  };

  safeRefresh(db, taskId, { now });
  return {
    ok: true,
    attempt: getAttempt(db, attempt.attempt_id),
    child,
    pid,
    done,
    stop,
    kill: () => stop('crash'),
  };
}
