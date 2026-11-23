// checkpoint.mjs — 检查点：可恢复的代码现场。
//
// 检查点回答的是「中断/交接时，磁盘上到底有哪些改动」，不是「代码对不对」。
// 因此保存三样东西：
//   git_sha    HEAD 指向的已提交版本（没有 git/没有提交时允许为 null）
//   files      已跟踪且有改动的文件清单（含 工作区内容 sha256 / bytes / 是否已删除）
//   untracked  未跟踪但需要保留的文件（新文件必须在这里，T05 的核心）
//
// 用 git status --porcelain=v1 -z 取清单：-z 用 NUL 分隔，路径含空格/中文也不会切错；
// --untracked-files=all 保证目录里的新文件逐个列出，而不是只给一个目录名。

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { getRow, allRows } from './db.mjs';
import { appendEvent, EVIDENCE } from './events.mjs';
import { attachCheckpoint, getAttempt, latestAttempt } from './attempts.mjs';
import { newCheckpointId } from './tasks.mjs';

const MAX_HASH_BYTES = 64 * 1024 * 1024; // 超过 64MB 的文件不读进内存，sha256 记 null 并标注

function stamp(now) {
  return (now instanceof Date ? now : new Date(now ?? Date.now())).toISOString();
}

function git(cwd, args) {
  try {
    return {
      // core.autocrlf=false 只影响 status 的路径判断，不改变工作区内容；
      // 关掉它避免 Windows 上刷「LF will be replaced by CRLF」的提示。
      out: execFileSync('git', ['-c', 'core.autocrlf=false', '-C', cwd, ...args], {
        encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 30000,
      }),
      ok: true,
    };
  } catch (err) {
    return { ok: false, error: err && (err.stderr || err.message) ? String(err.stderr || err.message).trim() : 'git failed' };
  }
}

function normalizeFilePath(p) {
  return String(p).replace(/\\/g, '/');
}

function hashFile(absPath) {
  try {
    const st = statSync(absPath);
    if (!st.isFile()) {
      return { exists: true, is_file: false, bytes: 0, sha256: null, note: 'not_a_regular_file' };
    }
    if (st.size > MAX_HASH_BYTES) {
      return { exists: true, is_file: true, bytes: st.size, sha256: null, note: 'too_large_to_hash' };
    }
    const buf = readFileSync(absPath);
    return {
      exists: true,
      is_file: true,
      bytes: st.size,
      sha256: createHash('sha256').update(buf).digest('hex'),
    };
  } catch {
    // 已删除的跟踪文件：git status 里仍是改动，但工作区没有内容。
    return { exists: false, is_file: false, bytes: 0, sha256: null, note: 'deleted_in_worktree' };
  }
}

/**
 * 解析 `git status --porcelain=v1 -z`。
 * 记录格式：XY<space>PATH<NUL>；重命名/复制时后面再跟一个 <NUL> 分隔的原路径。
 */
export function parsePorcelainZ(raw) {
  const parts = String(raw || '').split('\0');
  const entries = [];
  for (let i = 0; i < parts.length; i += 1) {
    const rec = parts[i];
    if (!rec) continue;
    if (rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    const path = rec.slice(3);
    let origPath = null;
    if (xy[0] === 'R' || xy[0] === 'C') {
      origPath = parts[i + 1] || null;
      if (origPath !== null) i += 1;
    }
    entries.push({ xy, path, origPath });
  }
  return entries;
}

/**
 * 生成检查点。
 * @returns {{checkpoint:object, files:Array, untracked:Array, git_sha:string|null, git_error:string|null}}
 */
export function createCheckpoint(db, input = {}) {
  const {
    taskId, attemptId = null, worktreePath = process.cwd(),
    label = null, now = null,
  } = input;
  if (!taskId) throw Object.assign(new Error('createCheckpoint 需要 taskId'), { code: 'BAD_CHECKPOINT', statusCode: 400 });

  const attempt = attemptId ? getAttempt(db, attemptId) : latestAttempt(db, { taskId });
  if (!attempt) {
    throw Object.assign(new Error('检查点必须绑定执行实例：当前任务没有 attempt'), {
      code: 'NO_ATTEMPT', statusCode: 409,
    });
  }
  const cwd = resolve(worktreePath || attempt.worktree_path || process.cwd());

  const rev = git(cwd, ['rev-parse', 'HEAD']);
  const gitSha = rev.ok ? rev.out.trim() || null : null;
  const gitError = rev.ok ? null : rev.error;

  const status = git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=no']);
  let entries = [];
  let statusError = null;
  if (status.ok) {
    entries = parsePorcelainZ(status.out);
  } else {
    statusError = status.error;
  }

  const files = [];
  const untracked = [];
  for (const e of entries) {
    const rel = normalizeFilePath(e.path);
    if (!rel) continue;
    const abs = isAbsolute(rel) ? rel : join(cwd, rel);
    const meta = hashFile(abs);
    if (e.xy === '??') {
      untracked.push({ path: rel, tracked: false, ...meta });
    } else if (e.xy === '!!') {
      // --ignored=no 下理论上不会出现；真出现也不当交付物。
    } else {
      files.push({
        path: rel,
        tracked: true,
        status: e.xy.trim() || e.xy,
        orig_path: e.origPath ? normalizeFilePath(e.origPath) : null,
        ...meta,
      });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  untracked.sort((a, b) => a.path.localeCompare(b.path));

  const checkpointId = newCheckpointId();
  const at = stamp(now || input.createdAt);
  db.prepare(
    'INSERT INTO checkpoints (checkpoint_id, task_id, attempt_id, git_sha, files, untracked, created_at, label) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(checkpointId, taskId, attempt.attempt_id, gitSha, JSON.stringify(files), JSON.stringify(untracked), at, label);
  attachCheckpoint(db, attempt.attempt_id, checkpointId);

  appendEvent(db, {
    taskId,
    attemptId: attempt.attempt_id,
    agentId: attempt.agent_id,
    eventType: 'checkpoint_created',
    payload: {
      checkpoint_id: checkpointId,
      worktree_path: cwd,
      git_sha: gitSha,
      tracked_changed: files.length,
      untracked_count: untracked.length,
      label,
      git_error: gitError || statusError,
    },
    evidenceSource: EVIDENCE.CHECKPOINT,
    observedAt: at,
  });

  const checkpoint = getCheckpoint(db, checkpointId);
  return { checkpoint, files, untracked, git_sha: gitSha, git_error: gitError || statusError, worktree_path: cwd };
}

function mapCheckpoint(row) {
  if (!row) return null;
  return {
    ...row,
    files: row.files ? JSON.parse(row.files) : [],
    untracked: row.untracked ? JSON.parse(row.untracked) : [],
  };
}

export function getCheckpoint(db, checkpointId) {
  return mapCheckpoint(getRow(db, 'SELECT * FROM checkpoints WHERE checkpoint_id = ?', [checkpointId]));
}

export function listCheckpoints(db, taskId = null, limit = 100) {
  const rows = taskId
    ? allRows(db, 'SELECT * FROM checkpoints WHERE task_id = ? ORDER BY created_at DESC LIMIT ?', [taskId, limit])
    : allRows(db, 'SELECT * FROM checkpoints ORDER BY created_at DESC LIMIT ?', [limit]);
  return rows.map(mapCheckpoint);
}

export function latestCheckpoint(db, taskId) {
  return listCheckpoints(db, taskId, 1)[0] || null;
}
