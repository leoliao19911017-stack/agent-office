// tool-events.mjs — 工具级事件采集与只读聚合（TASK-转盘与Agent可添加 第二批）
//
// 数据源（只读，不写别人的目录）：
//   Claude  ~/.claude/projects/<slug>/*.jsonl        明文 JSONL，assistant.content 里的 tool_use
//   DSH     ~/.dsh/sessions/--<slug>--/<id>/session.v4.jsonl.zstd
//           Node 内置 zlib.zstdDecompressSync 解压，取 tool/call 事件
//
// 写入 data/agent-office.db 的 tool_events 表；source ledger 只用于增量读取，
// 不改变任务书点名的七个字段。id 是确定性哈希，重复采集 INSERT OR IGNORE。
//
// 设计约束：
//   · 不猜工具名，不补假数据；采不到就是 0，API 返回 collecting=true。
//   · 采集器本身是同步 CLI；API 只读表，不在请求里扫描会话目录。
//   · target 只保留可读的一行，raw_json 截断；不把 api key 一类长文本塞进接口。

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { getDb, resolveDbPath } from './db.mjs';

export const TOOL_EVENTS_VERSION = 1;
const RAW_LIMIT = 20000;
const TARGET_LIMIT = 180;

export function claudeProjectSlug(projectRoot) {
  return String(projectRoot || '').replace(/[^A-Za-z0-9]/g, '-');
}

/** DSH 的目录名：路径分隔符/冒号变 -，空格变 ~0020，再包 --。 */
export function dshProjectSlug(projectRoot) {
  const s = String(projectRoot || '')
    .replace(/[\\/:]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/ /g, '~0020');
  return `--${s}--`;
}

export function projectSources(projectRoot, home = homedir()) {
  const root = resolve(projectRoot || process.cwd());
  return {
    project_root: root,
    claude_root: join(home, '.claude', 'projects', claudeProjectSlug(root)),
    dsh_root: join(home, '.dsh', 'sessions', dshProjectSlug(root)),
  };
}

function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}
function clip(s, n) {
  const t = oneLine(s);
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}
function stableId(parts) {
  return `te-${createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 24)}`;
}
function isoFrom(value) {
  if (value == null) return null;
  if (typeof value === 'number' || /^\d{10,13}$/.test(String(value))) {
    const n = Number(value);
    const ms = n < 1e12 ? n * 1000 : n;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** 工具参数里最像「目标」的那个字段；不是猜测工具类型，只是取可读字段。 */
export function extractTarget(name, args) {
  if (args === null || args === undefined) return null;
  if (typeof args !== 'object') return clip(args, TARGET_LIMIT) || null;
  const keys = ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description', 'prompt', 'task', 'skill', 'name'];
  for (const k of keys) {
    if (typeof args[k] === 'string' && args[k].trim()) {
      let v = args[k];
      if (k === 'command') v = v.split('\n')[0];
      return clip(v, TARGET_LIMIT);
    }
  }
  return clip(JSON.stringify(args), TARGET_LIMIT) || null;
}

function toolEventsFromClaudeLine(rawLine) {
  const j = safeJson(rawLine);
  if (!j) return [];
  const blocks = [];
  const c = j.message && j.message.content;
  if (Array.isArray(c)) for (const b of c) if (b && b.type === 'tool_use' && b.name) blocks.push(b);
  if (!blocks.length && j.type === 'tool_use' && j.name) blocks.push(j);
  if (!blocks.length) return [];
  const sessionId = j.sessionId || (j.message && j.message.sessionId) || null;
  const ts = isoFrom(j.timestamp) || isoFrom(j.message && j.message.timestamp) || new Date().toISOString();
  return blocks.map((b, idx) => {
    const target = extractTarget(b.name, b.input || null);
    return {
      id: stableId(['claude', sessionId || '', b.id || `${ts}:${idx}`, b.name, String(b.id || '')]),
      agent_id: 'claude',
      session_id: sessionId,
      tool_name: String(b.name),
      target,
      ts,
      raw_json: rawLine.length > RAW_LIMIT ? rawLine.slice(0, RAW_LIMIT) : rawLine,
    };
  });
}

function toolEventsFromDshLine(rawLine, fallbackSession) {
  const j = safeJson(rawLine);
  if (!j || j.type !== 'tool/call') return [];
  const data = j.data || {};
  const name = data.name || data.tool_name;
  if (!name) return [];
  const args = typeof data.arguments === 'string' ? safeJson(data.arguments) : data.arguments;
  const sessionId = fallbackSession || null;
  const ts = isoFrom(j.time) || isoFrom(j.timestamp) || new Date().toISOString();
  return [{
    id: stableId(['dsh', sessionId || '', data.callId || j.seq || '', name, ts]),
    agent_id: 'dsh',
    session_id: sessionId,
    tool_name: String(name),
    target: extractTarget(name, args),
    ts,
    raw_json: rawLine.length > RAW_LIMIT ? rawLine.slice(0, RAW_LIMIT) : rawLine,
  }];
}

function readSourceRow(db, path) {
  return db.prepare('SELECT * FROM tool_event_sources WHERE source_path = ?').get(path) || null;
}
function writeSourceRow(db, row) {
  db.prepare(`INSERT INTO tool_event_sources
    (source_path, agent_id, session_id, size, mtime_ms, byte_offset, collected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_path) DO UPDATE SET
      agent_id=excluded.agent_id, session_id=excluded.session_id, size=excluded.size,
      mtime_ms=excluded.mtime_ms, byte_offset=excluded.byte_offset, collected_at=excluded.collected_at`)
    .run(row.source_path, row.agent_id, row.session_id, row.size, row.mtime_ms, row.byte_offset, row.collected_at);
}

/** 返回本次要插入的事件；incremental 读 Claude 追加写文件，只读新行。 */
function collectClaude({ db, root, stats }) {
  if (!existsSync(root)) return { events: [], files: 0, skipped: 0 };
  const files = readdirSync(root)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => join(root, name))
    .filter((p) => { try { return statSync(p).isFile(); } catch { return false; } });
  const events = [];
  let skipped = 0;
  for (const file of files) {
    let st;
    try { st = statSync(file); } catch { stats.errors.push(`stat 失败：${file}`); continue; }
    const prev = readSourceRow(db, file);
    if (prev && prev.size === st.size && prev.mtime_ms === Math.round(st.mtimeMs)) { skipped += 1; continue; }
    let offset = 0;
    if (prev && st.size >= prev.byte_offset) offset = Number(prev.byte_offset) || 0;
    let buf;
    try { buf = readFileSync(file); } catch { stats.errors.push(`读取失败：${file}`); continue; }
    const text = buf.subarray(offset).toString('utf8');
    const lastNl = text.lastIndexOf('\n');
    const complete = lastNl >= 0 ? text.slice(0, lastNl) : '';
    const consumed = complete ? Buffer.byteLength(`${complete}\n`, 'utf8') : 0;
    const lines = complete ? complete.split('\n').filter((l) => l.trim()) : [];
    let sessionId = null;
    let fileEvents = 0;
    for (const line of lines) {
      const evs = toolEventsFromClaudeLine(line);
      for (const ev of evs) { sessionId = ev.session_id || sessionId; events.push(ev); fileEvents += 1; }
    }
    writeSourceRow(db, {
      source_path: file,
      agent_id: 'claude',
      session_id: sessionId,
      size: st.size,
      mtime_ms: Math.round(st.mtimeMs),
      byte_offset: offset + consumed,
      collected_at: new Date().toISOString(),
    });
    stats.files += 1;
    stats.lines += lines.length;
    stats.parsed += fileEvents;
  }
  stats.skipped += skipped;
  return { events, files: files.length, skipped };
}

function collectDsh({ db, root, stats }) {
  if (!existsSync(root)) return { events: [], files: 0, skipped: 0 };
  let dirs = [];
  try { dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(root, d.name)); }
  catch { return { events: [], files: 0, skipped: 0 }; }
  const events = [];
  let skipped = 0;
  for (const dir of dirs) {
    const file = join(dir, 'session.v4.jsonl.zstd');
    if (!existsSync(file)) continue;
    let st;
    try { st = statSync(file); } catch { continue; }
    const prev = readSourceRow(db, file);
    if (prev && prev.size === st.size && prev.mtime_ms === Math.round(st.mtimeMs)) { skipped += 1; continue; }
    let text;
    try { text = zstdDecompressSync(readFileSync(file)).toString('utf8'); }
    catch (err) { stats.errors.push(`解压失败：${basename(dir)} ${String(err.message || err).slice(0, 60)}`); continue; }
    const lines = text.split('\n').filter((l) => l.trim());
    let sessionId = basename(dir);
    let fileEvents = 0;
    for (const line of lines) {
      const j = safeJson(line);
      if (j && j.type === 'session' && j.id) sessionId = j.id;
      const evs = toolEventsFromDshLine(line, sessionId);
      for (const ev of evs) { ev.session_id = sessionId; events.push(ev); fileEvents += 1; }
    }
    writeSourceRow(db, {
      source_path: file,
      agent_id: 'dsh',
      session_id: sessionId,
      size: st.size,
      mtime_ms: Math.round(st.mtimeMs),
      byte_offset: st.size,
      collected_at: new Date().toISOString(),
    });
    stats.files += 1;
    stats.lines += lines.length;
    stats.parsed += fileEvents;
  }
  stats.skipped += skipped;
  return { events, files: dirs.length, skipped };
}

function metaSet(db, key, value) {
  db.prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}
export function metaGet(db, key) {
  const row = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

/**
 * 采集一次（幂等）。返回真实统计；失败不造假数据。
 * @param {{db?:any, projectRoot?:string, home?:string, now?:Date, dbPath?:string}} opts
 */
export function collectToolEvents(opts = {}) {
  const db = opts.db || getDb({ path: opts.dbPath });
  const src = projectSources(opts.projectRoot || process.cwd(), opts.home || homedir());
  const startedAt = new Date(opts.now || Date.now()).toISOString();
  const stats = {
    project_root: src.project_root,
    claude_root: src.claude_root,
    dsh_root: src.dsh_root,
    claude: { files: 0, skipped: 0 },
    dsh: { files: 0, skipped: 0 },
    files: 0, lines: 0, parsed: 0, inserted: 0, skipped: 0, errors: [],
  };
  const claude = collectClaude({ db, root: src.claude_root, stats });
  const dsh = collectDsh({ db, root: src.dsh_root, stats });
  stats.claude.files = claude.files;
  stats.claude.skipped = claude.skipped;
  stats.dsh.files = dsh.files;
  stats.dsh.skipped = dsh.skipped;

  const all = [...claude.events, ...dsh.events];
  const insert = db.prepare(`INSERT OR IGNORE INTO tool_events
    (id, agent_id, session_id, tool_name, target, ts, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const ev of all) {
      const r = insert.run(ev.id, ev.agent_id, ev.session_id, ev.tool_name, ev.target, ev.ts, ev.raw_json);
      if (r.changes) stats.inserted += 1;
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* 回滚失败不掩盖原错误 */ }
    throw err;
  }

  const total = db.prepare('SELECT COUNT(*) AS n FROM tool_events').get().n;
  const finishedAt = new Date().toISOString();
  const summary = {
    started_at: startedAt,
    finished_at: finishedAt,
    project_root: src.project_root,
    inserted: stats.inserted,
    parsed: stats.parsed,
    total,
    claude: stats.claude,
    dsh: stats.dsh,
    errors: stats.errors,
  };
  metaSet(db, 'tool_events.last_run_at', finishedAt);
  metaSet(db, 'tool_events.last_run_json', JSON.stringify(summary));
  metaSet(db, 'tool_events.total', total);
  return { ok: true, ...summary, db_path: resolveDbPath(opts.dbPath) };
}

/** 只读聚合：左弧/刻度/数据卡都从这里取，不再二次猜测。 */
export function queryToolEvents(db, opts = {}) {
  const agentId = opts.agentId ? String(opts.agentId) : null;
  const recentLimit = Math.max(1, Math.min(300, Number(opts.recentLimit) || 120));
  const toolLimit = Math.max(1, Math.min(60, Number(opts.toolLimit) || 24));
  const now = opts.now ? new Date(opts.now) : new Date();
  const nowIso = now.toISOString();
  const lastRunAt = metaGet(db, 'tool_events.last_run_at');
  const totalAll = db.prepare('SELECT COUNT(*) AS n FROM tool_events').get().n;
  const where = agentId ? 'WHERE agent_id = ?' : '';
  const args = agentId ? [agentId] : [];

  const total = db.prepare(`SELECT COUNT(*) AS n FROM tool_events ${where}`).get(...args).n;
  const byAgent = db.prepare(`SELECT agent_id, COUNT(*) AS count, MAX(ts) AS last_ts
    FROM tool_events GROUP BY agent_id ORDER BY count DESC`).all();
  const toolRows = db.prepare(`SELECT tool_name, COUNT(*) AS count, MAX(ts) AS last_ts
    FROM tool_events ${where} GROUP BY tool_name ORDER BY count DESC LIMIT ?`).all(...args, toolLimit);
  // 同一工具名在不同 Agent 下的计数：前端选中 Agent 时按真实归属过滤，不再二次猜。
  const toolAgentRows = db.prepare(`SELECT tool_name, agent_id, COUNT(*) AS count
    FROM tool_events ${where} GROUP BY tool_name, agent_id`).all(...args);
  const recent = db.prepare(`SELECT id, agent_id, session_id, tool_name, target, ts
    FROM tool_events ${where} ORDER BY ts DESC LIMIT ?`).all(...args, recentLimit);

  // 同一工具大小写不同（Claude 的 Bash / DSH 的 bash）合并展示，但保留原 tool_name。
  const merged = new Map();
  for (const row of toolRows) {
    const key = String(row.tool_name).toLowerCase();
    const hit = merged.get(key);
    if (hit) { hit.count += row.count; if (row.last_ts > hit.last_ts) hit.last_ts = row.last_ts; }
    else merged.set(key, { tool_name: row.tool_name, count: row.count, last_ts: row.last_ts, agents: {}, recent: [] });
  }
  for (const row of toolAgentRows) {
    const hit = merged.get(String(row.tool_name).toLowerCase());
    if (hit) hit.agents[row.agent_id] = (hit.agents[row.agent_id] || 0) + row.count;
  }
  // 每个工具按 Agent 分别取最近 2 条内容：最近的 200 条事件可能全是 dsh 的 bash，
  // 不能靠全局 recent 给 Claude 的 Read 找样本。选中 Agent 时由前端按 agent_id 过滤。
  const sampleStmt = db.prepare(`SELECT target, ts, agent_id, tool_name FROM tool_events
    WHERE lower(tool_name) = ? AND agent_id = ? ORDER BY ts DESC LIMIT 2`);
  for (const [key, t] of merged) {
    const agentIds = agentId ? [agentId] : Object.keys(t.agents);
    const rows = [];
    for (const aid of agentIds) rows.push(...sampleStmt.all(key, aid));
    t.recent = rows.sort((a, b) => String(b.ts).localeCompare(String(a.ts))).slice(0, 4)
      .map((r) => ({ target: r.target, ts: r.ts, agent_id: r.agent_id, tool_name: r.tool_name }));
  }
  const tools = [...merged.values()].sort((a, b) => b.count - a.count);

  // 每个 Agent 自己的最近事件，供左弧「最近调用」使用；不能拿全局 recent 冒充。
  const recentByAgent = {};
  const perAgentStmt = db.prepare(`SELECT id, agent_id, session_id, tool_name, target, ts
    FROM tool_events WHERE agent_id = ? ORDER BY ts DESC LIMIT 40`);
  for (const a of byAgent) recentByAgent[a.agent_id] = perAgentStmt.all(a.agent_id);

  // 15 分钟调用率：15 个一分钟桶，空桶是真的 0。
  const since = new Date(now.getTime() - 15 * 60 * 1000).toISOString();
  const recentTs = db.prepare(`SELECT ts FROM tool_events ${where ? `${where} AND` : 'WHERE'} ts >= ?`).all(...args, since);
  const buckets = Array.from({ length: 15 }, (_, i) => {
    const start = new Date(now.getTime() - (14 - i) * 60 * 1000);
    return { start_ts: start.toISOString(), count: 0 };
  });
  for (const row of recentTs) {
    const t = Date.parse(row.ts);
    if (Number.isNaN(t)) continue;
    const idx = Math.floor((t - (now.getTime() - 15 * 60 * 1000)) / 60000);
    if (idx >= 0 && idx < 15) buckets[idx].count += 1;
  }

  return {
    generated_at: nowIso,
    last_run_at: lastRunAt,
    collected: total > 0,
    collecting: !lastRunAt && totalAll === 0,
    agent_id: agentId,
    total,
    total_all: totalAll,
    by_agent: byAgent,
    max_agent_count: byAgent.reduce((m, a) => Math.max(m, a.count), 0),
    tools,
    recent,
    recent_by_agent: recentByAgent,
    rate_15m: { total: recentTs.length, buckets },
  };
}
