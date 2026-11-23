// external.mjs — 通用外部执行器观测（只能产出 P4 证据）。
//
// 适用对象：在终端里手敲起来的 Claude Code / Codex / 其它 CLI。
// 这类进程不归 Agent Office 启动，拿不到结构化事件流，我们只能看到：
//   进程在不在（pid / 进程名）
//   日志文件最后修改时间（mtime）
//
// P4 证据不能单独证明「正在工作」，所以本模块写出的所有事件都标
// evidence_source=process_probe；状态机看到弱证据只会给 unknown，不会给 running。
//
// 只读：一个字节都不写被观测对象的目录/日志。

import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { appendEvent, EVIDENCE } from '../lib/events.mjs';
import { isPidAlive } from '../lib/attempts.mjs';

export { isPidAlive };

function stamp(now) {
  return (now instanceof Date ? now : new Date(now ?? Date.now())).toISOString();
}

/** 单个 pid 是否存活。null=未知（没给 pid），false=明确不存在。 */
export function probePid(pid, opts = {}) {
  const checkedAt = stamp(opts.now);
  const alive = isPidAlive(pid);
  return {
    kind: 'pid',
    pid: pid == null ? null : Number(pid),
    alive,
    checked_at: checkedAt,
    observed_at: checkedAt,
    evidence_source: EVIDENCE.PROCESS_PROBE,
    priority: 4,
    note: alive === null
      ? '没有 pid，无法探测'
      : alive ? '进程存在（只能证明进程在，不能证明在工作）' : '进程不存在',
  };
}

/** 按进程名探测（Windows: tasklist；其它: pgrep）。失败返回 found=null，不猜 0。 */
export function probeProcessByName(name, opts = {}) {
  const checkedAt = stamp(opts.now);
  const pattern = String(name || '').trim();
  if (!pattern) {
    return {
      kind: 'process_name', name: null, found: null, pids: [], checked_at: checkedAt,
      observed_at: checkedAt, evidence_source: EVIDENCE.PROCESS_PROBE, error: '空进程名',
    };
  }
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'tasklist.exe' : 'pgrep';
    const args = isWin
      ? ['/FI', `IMAGENAME eq ${pattern}`, '/FO', 'CSV', '/NH']
      : ['-fl', pattern];
    execFile(cmd, args, { timeout: 5000, maxBuffer: 256 * 1024, windowsHide: true }, (err, stdout) => {
      const text = String(stdout || '');
      const pids = [];
      if (isWin) {
        for (const line of text.split(/\r?\n/)) {
          const m = line.match(/^"([^"]+)","(\d+)"/);
          if (m) pids.push(Number(m[2]));
        }
      } else {
        for (const line of text.split(/\r?\n/)) {
          const m = line.match(/^(\d+)\s+/);
          if (m) pids.push(Number(m[1]));
        }
      }
      resolve({
        kind: 'process_name',
        name: pattern,
        found: err ? null : pids.length > 0,
        pids,
        checked_at: checkedAt,
        observed_at: checkedAt,
        evidence_source: EVIDENCE.PROCESS_PROBE,
        priority: 4,
        error: err ? String(err.message || err).slice(0, 200) : null,
        note: '进程探测（P4）：只能证明有进程，不能证明任务在推进',
      });
    });
  });
}

/** 日志文件 mtime 探测。mtime 新只说明「可能刚写过」，同样只是 P4。 */
export function probeLogMtime(filePath, opts = {}) {
  const checkedAt = stamp(opts.now);
  const nowMs = Date.parse(checkedAt);
  try {
    const st = statSync(filePath);
    return {
      kind: 'log_mtime',
      path: String(filePath),
      exists: true,
      mtime: new Date(st.mtimeMs).toISOString(),
      age_ms: Math.max(0, nowMs - st.mtimeMs),
      checked_at: checkedAt,
      observed_at: checkedAt,
      evidence_source: EVIDENCE.PROCESS_PROBE,
      priority: 4,
      note: '日志 mtime（P4）：不能单独证明在工作',
    };
  } catch (err) {
    return {
      kind: 'log_mtime',
      path: String(filePath),
      exists: false,
      mtime: null,
      age_ms: null,
      checked_at: checkedAt,
      observed_at: checkedAt,
      evidence_source: EVIDENCE.PROCESS_PROBE,
      priority: 4,
      error: String(err.message || err).slice(0, 200),
    };
  }
}

/**
 * 把一次外部观测写成事件。注意：即使 alive=true 也只写 process_probe，
 * 不把任务推进到 running——这是外部观测与托管执行的分界线。
 */
export function observeExternalProcess(db, input = {}) {
  const {
    taskId, attemptId = null, agentId = null,
    pid = null, processName = null, logPath = null, now = null,
  } = input;
  const observations = [];
  if (pid != null) observations.push(probePid(pid, { now }));
  if (logPath) observations.push(probeLogMtime(logPath, { now }));
  if (!observations.length && processName) {
    // 异步探测由调用方 await；这里只处理同步可得的观测。
    throw Object.assign(new Error('按进程名探测请使用 probeProcessByName 后调用 recordExternalObservation'), {
      code: 'ASYNC_PROBE_REQUIRED', statusCode: 400,
    });
  }
  if (!observations.length) {
    throw Object.assign(new Error('observeExternalProcess 需要 pid / logPath 之一'), {
      code: 'BAD_OBSERVATION', statusCode: 400,
    });
  }
  const event = appendEvent(db, {
    taskId, attemptId, agentId,
    eventType: 'external_probe',
    payload: { observations },
    evidenceSource: EVIDENCE.PROCESS_PROBE,
    observedAt: now,
  });
  return { observations, event };
}

/** 记录一次按进程名的异步探测结果。 */
export function recordExternalObservation(db, input = {}) {
  const { taskId, attemptId = null, agentId = null, observation, now = null } = input;
  if (!observation || typeof observation !== 'object') {
    throw Object.assign(new Error('recordExternalObservation 需要 observation'), {
      code: 'BAD_OBSERVATION', statusCode: 400,
    });
  }
  const event = appendEvent(db, {
    taskId, attemptId, agentId,
    eventType: 'external_probe',
    payload: { observations: [observation] },
    evidenceSource: EVIDENCE.PROCESS_PROBE,
    observedAt: now,
  });
  return { observations: [observation], event };
}

/** 可用性探测：外部 Agent 的 CLI 是否存在（只作为可用性证据，不冒充执行证据）。 */
export function probeCliBinary(bin, opts = {}) {
  const checkedAt = stamp(opts.now);
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: opts.timeoutMs || 4000, maxBuffer: 64 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) {
        resolve({
          available: false,
          reason: err.code === 'ENOENT' ? 'cli_not_found' : 'probe_failed',
          version: null,
          checked_at: checkedAt,
          observed_at: checkedAt,
          evidence_source: EVIDENCE.PROCESS_PROBE,
          error: String(err.message || err).slice(0, 200),
        });
        return;
      }
      resolve({
        available: true,
        reason: null,
        version: String(stdout || '').trim().split(/\r?\n/)[0].slice(0, 120) || null,
        checked_at: checkedAt,
        observed_at: checkedAt,
        evidence_source: EVIDENCE.PROCESS_PROBE,
        error: null,
      });
    });
  });
}
