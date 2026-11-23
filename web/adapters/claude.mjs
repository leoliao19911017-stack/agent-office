// claude.mjs — Claude Code adapter（外部观测，只读）。
//
// Claude Code 是人在终端里手敲起来的，Agent Office 拿不到事件流、也管不了进程。
// 因此本适配器只做「外部观测」：
//   会话目录：~/.claude/projects/<项目>/<会话>.jsonl
//   能读到：会话文件的 mtime、尾部最后事件、限额/认证错误文本
//   不能证明：它此刻是不是真在干活
//
// 所以这里写出的所有事件都标 evidence_source=external；状态机会把它们归为
// unknown（P4 能力），绝不冒充 running。
//
// 三个红线：只读（不写会话文件）；读不到就报 null/错误，不猜；限额判定只认
// Claude 自己的合成错误消息（model=<synthetic>），避免读到源码/日志里的字样误判。

import { openSync, readSync, closeSync, fstatSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { appendEvent, EVIDENCE } from '../lib/events.mjs';
import { probeCliBinary } from './external.mjs';

export const CLAUDE_LIMIT_MARK = '已达到 5 小时的使用上限';
const TAIL_BYTES = 256 * 1024;

export function defaultClaudeProjectsDir() {
  return process.env.CLAUDE_PROJECTS_DIR || join(homedir(), '.claude', 'projects');
}

function stamp(now) {
  return (now instanceof Date ? now : new Date(now ?? Date.now())).toISOString();
}

function tailText(filePath, maxBytes = TAIL_BYTES) {
  let fd = -1;
  try {
    fd = openSync(filePath, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== -1) { try { closeSync(fd); } catch { /* 已关闭 */ } }
  }
}

/** 从尾部解析 Claude 会话：最后事件类型 + 限额/认证证据。 */
export function analyzeClaudeTail(tail) {
  const out = {
    last_event_type: null,
    last_at: null,
    limited: false,
    reason: null,
    reset_at: null,
    sample: null,
  };
  if (!tail) return out;
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line || line[0] !== '{') continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!out.last_event_type && obj.type) {
      out.last_event_type = String(obj.type);
      out.last_at = obj.timestamp || obj.at || null;
    }
    if (obj.type === 'assistant' && obj.message) {
      const contents = Array.isArray(obj.message.content) ? obj.message.content : [];
      if (obj.model === '<synthetic>') {
        for (const c of contents) {
          const text = c && typeof c.text === 'string' ? c.text : '';
          if (text.includes(CLAUDE_LIMIT_MARK) || /usage limit|额度|使用上限/i.test(text)) {
            const m = text.match(/限额将在\s*([\d-]+\s+[\d:]+)\s*重置/);
            const t = m ? new Date(m[1].replace(' ', 'T')) : null;
            out.limited = true;
            out.reason = 'quota_5h';
            out.reset_at = t && !Number.isNaN(t.getTime()) ? t.toISOString() : null;
            out.sample = text.slice(0, 240);
            return out;
          }
          if (/401|403|unauthor|login|credential|认证|登录/i.test(text)) {
            out.limited = true;
            out.reason = 'auth_failed';
            out.sample = text.slice(0, 240);
            return out;
          }
        }
      } else {
        // 限额报错之后又出现过正常的 assistant 消息，视为已恢复。
        return out;
      }
    }
  }
  return out;
}

/**
 * 列出 Claude 会话（按 mtime 倒序）。
 * 默认扫 ~/.claude/projects 下两层：projects/<project>/<session>.jsonl。
 */
export function listClaudeSessions(opts = {}) {
  const projectsDir = opts.projectsDir || defaultClaudeProjectsDir();
  const limit = Math.max(1, Number(opts.limit) || 20);
  const sinceMs = opts.sinceMs == null ? null : Number(opts.sinceMs);
  const files = [];
  try {
    for (const sub of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!sub.isDirectory()) continue;
      const subDir = join(projectsDir, sub.name);
      let names = [];
      try { names = readdirSync(subDir); } catch { continue; }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue;
        const p = join(subDir, name);
        try {
          const st = statSync(p);
          if (sinceMs != null && st.mtimeMs < sinceMs) continue;
          files.push({ path: p, project: sub.name, session_id: name.replace(/\.jsonl$/, ''), mtime_ms: st.mtimeMs, size: st.size });
        } catch { /* 单个文件失败不拖垮扫描 */ }
      }
    }
  } catch (err) {
    return {
      projects_dir: projectsDir,
      readable: false,
      error: String(err.message || err),
      sessions: [],
    };
  }
  files.sort((a, b) => b.mtime_ms - a.mtime_ms);
  const sessions = files.slice(0, limit).map((f) => {
    const tail = tailText(f.path);
    const analysis = analyzeClaudeTail(tail);
    return {
      ...f,
      mtime: new Date(f.mtime_ms).toISOString(),
      tail_readable: tail !== null,
      ...analysis,
    };
  });
  return { projects_dir: projectsDir, readable: true, error: null, sessions };
}

/** Claude CLI 可用性（只作为 availability 证据）。 */
export async function detectClaude(opts = {}) {
  const r = await probeCliBinary(opts.bin || process.env.CLAUDE_BIN || 'claude', opts);
  return {
    available: r.available,
    reason: r.available ? null : (r.reason === 'cli_not_found' ? 'cli_not_found' : 'probe_failed'),
    version: r.version,
    checked_at: r.checked_at,
    observed_at: r.observed_at,
    evidence_source: EVIDENCE.EXTERNAL,
    detail: r.error || null,
  };
}

/**
 * 把最近的 Claude 会话观测落成事件（幂等：同一文件同一 mtime 不重复写）。
 * 不创建 attempt、不推进任务状态；调用方最多把它当「可用性/限额」证据。
 */
export function importClaudeObservations(db, opts = {}) {
  const {
    taskId = null, agentId = 'claude', projectsDir = null,
    sinceMs = Date.now() - 24 * 60 * 60 * 1000,
    limit = 5, now = null,
  } = opts;

  const scan = listClaudeSessions({ projectsDir, sinceMs, limit });
  if (!scan.readable) {
    return { imported: 0, skipped: 0, sessions: [], error: scan.error, projects_dir: scan.projects_dir };
  }

  const recent = db.prepare(
    "SELECT payload FROM events WHERE agent_id = ? AND event_type = 'external_activity' " +
    'ORDER BY observed_at DESC LIMIT 200',
  ).all(agentId).map((r) => {
    try { return JSON.parse(r.payload || '{}'); } catch { return {}; }
  });
  const seen = new Set(recent.map((p) => `${p.session_file}|${p.mtime}`));

  let imported = 0;
  let skipped = 0;
  for (const s of scan.sessions) {
    const key = `${s.path.replace(/\\/g, '/')}|${s.mtime}`;
    if (seen.has(key)) { skipped += 1; continue; }
    appendEvent(db, {
      taskId, agentId,
      eventType: 'external_activity',
      payload: {
        session_file: s.path.replace(/\\/g, '/'),
        project: s.project,
        session_id: s.session_id,
        mtime: s.mtime,
        size: s.size,
        last_event_type: s.last_event_type,
        last_at: s.last_at,
        limited: s.limited,
        block_reason: s.reason,
        reset_at: s.reset_at,
        sample: s.sample,
      },
      evidenceSource: EVIDENCE.EXTERNAL,
      observedAt: now || s.mtime,
    });
    seen.add(key);
    imported += 1;
  }
  return {
    imported,
    skipped,
    sessions: scan.sessions,
    projects_dir: scan.projects_dir,
    error: null,
    checked_at: stamp(now),
  };
}
