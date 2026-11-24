// db.mjs — Agent Office V1 P0 数据层：SQLite 初始化 + 建表 + 迁移（幂等）
//
// 用 Node 内置 node:sqlite（Node 24 实测可用），不安装 better-sqlite3，
// 避免原生模块编译问题。数据库默认落在仓库 data/agent-office.db，
// 可用环境变量 AGENT_OFFICE_DB 覆盖（selftest / 迁移脚本用它隔离现场）。
//
// 设计约束（见 TASK-P0-地基.md §2.1）：
//   tasks / attempts / events / checkpoints 四张主表 + write_owner 所有权表。
// 另有三张辅助表，都是为了让「任务做到哪一步」和「迁移幂等」可查，不是替代主表：
//   task_steps      任务步骤（tasks 表只存任务头，步骤单独成表，避免把 JSON 塞进任务行）
//   migrate_ledger  旧 JSON 迁移账本（同一文件同一内容只迁一次）
//   schema_meta     建表版本，供后续迁移判断
// v2（TASK-AgentChat V1）另加聊天六张表 chat_threads / chat_messages / chat_turns /
// chat_events / chat_approvals / chat_summaries，与任务三张表互相独立（见 SCHEMA_V2_CHAT）。
//
// 整个项目只有本文件创建数据库连接；其它模块一律接收 db 参数，便于测试隔离。

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url)); // web/lib
export const REPO_ROOT = resolve(HERE, '..', '..');
export const DEFAULT_DB_PATH = resolve(REPO_ROOT, 'data', 'agent-office.db');

const SCHEMA_VERSION = 3;

/**
 * v2（TASK-AgentChat V1）：聊天六张表，字段按任务书 §四，带 + 的为本实现补充的辅助列。
 *
 * 与 tasks / attempts / events 完全独立（ADR-03）：聊天只写这六张表，一行都不往任务三张表写。
 * 状态机 evaluateAgentStatuses 只读 attempts + events，所以它看不见聊天——普通聊天不会让
 * Agent 卡片从 unknown 变成 running，也不会挂到正在执行任务的 Session 上。
 *
 * 三个 ID 不许混（任务书 §四）：
 *   thread_id            Agent Office 自己的聊天编号（th-…）
 *   provider_session_id  Claude / DSH 真正的 Session ID（首轮建立后回填）
 *   turn_id              一次用户输入 + 对应执行的唯一编号（ct-…）
 * chat_turns.attempt_id 是「这一轮聊天的一次 CLI 调用」编号（ca-…），与任务表 attempts
 * 的 a-… 不是一回事；关联任务时另用 task_id / task_attempt_id 两列做只读引用。
 */
const SCHEMA_V2_CHAT = `
CREATE TABLE IF NOT EXISTS chat_threads (
  thread_id            TEXT PRIMARY KEY,
  agent_id             TEXT NOT NULL,
  provider_session_id  TEXT,
  workspace            TEXT,
  mode                 TEXT NOT NULL DEFAULT 'discuss',
  task_id              TEXT,
  task_attempt_id      TEXT,
  title                TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  message_id   TEXT PRIMARY KEY,
  thread_id    TEXT NOT NULL REFERENCES chat_threads(thread_id),
  turn_id      TEXT,
  role         TEXT NOT NULL,
  content      TEXT NOT NULL,
  status       TEXT NOT NULL,
  error_json   TEXT,
  seq          INTEGER NOT NULL,
  event_seq    INTEGER,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_turns (
  turn_id              TEXT PRIMARY KEY,
  thread_id            TEXT NOT NULL REFERENCES chat_threads(thread_id),
  attempt_id           TEXT NOT NULL,
  user_message_id      TEXT,
  assistant_message_id TEXT,
  status               TEXT NOT NULL,
  provider             TEXT NOT NULL,
  resume               INTEGER NOT NULL DEFAULT 0,
  retry_of_turn_id     TEXT,
  error_json           TEXT,
  started_at           TEXT,
  ended_at             TEXT,
  created_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_events (
  event_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id    TEXT NOT NULL REFERENCES chat_turns(turn_id),
  seq        INTEGER NOT NULL,
  type       TEXT NOT NULL,
  payload    TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (turn_id, seq)
);

CREATE TABLE IF NOT EXISTS chat_approvals (
  approval_id TEXT PRIMARY KEY,
  turn_id     TEXT NOT NULL REFERENCES chat_turns(turn_id),
  action      TEXT NOT NULL,
  decision    TEXT,
  decided_at  TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_summaries (
  thread_id       TEXT PRIMARY KEY REFERENCES chat_threads(thread_id),
  summary         TEXT NOT NULL,
  covered_turn_id TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_threads_agent  ON chat_threads(agent_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread_id, seq);
CREATE INDEX IF NOT EXISTS idx_chat_turns_thread    ON chat_turns(thread_id, created_at);
`;

/**
 * v3（TASK-转盘与Agent可添加 §2.2）：agents 表。
 *
 * 现有 claude / codex / dsh / hermes 四个 agent_id 原值迁移，历史 attempts /
 * chat_threads 里引用的 agent_id 不变，不迁历史数据。
 *
 * 在任务书字段之外补了一列 protocol（anthropic | openai）：§2.4 的 API 表单
 * 要求选协议，没有地方存就做不到「保存后按同一协议再调」。其余列严格按任务书。
 *
 * api_key 不落这张表：api_key_ref 只是引用（local:<agent_id> / ccswitch:<名称> /
 * env:<变量名>），真正的 key 由 web/lib/secrets.mjs 存在库外。
 */
const SCHEMA_V3_AGENTS = `
CREATE TABLE IF NOT EXISTS agents (
  agent_id     TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('cli', 'api', 'external')),
  enabled      INTEGER NOT NULL DEFAULT 1,
  sort_index   INTEGER NOT NULL DEFAULT 0,

  cli_command  TEXT,
  cli_args     TEXT,
  resume_flag  TEXT,

  base_url     TEXT,
  model        TEXT,
  protocol     TEXT,
  api_key_ref  TEXT,

  extra_env    TEXT,
  capabilities TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agents_enabled ON agents(enabled, sort_index, agent_id);
`;

/** 本机 DSH 的完整命令路径（任务书 §2.3 要求 cli_command 存完整路径）。 */
function defaultDshCommand() {
  if (process.env.DSH_BIN) return String(process.env.DSH_BIN);
  const local = process.env.LOCALAPPDATA
    || (process.env.USERPROFILE ? `${process.env.USERPROFILE}/AppData/Local` : null);
  if (local) {
    const known = `${String(local).replace(/\\/g, '/')}/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd`;
    try {
      if (existsSync(known)) return known;
    } catch { /* 目录不可读就退回 PATH */ }
  }
  return 'dsh';
}

/**
 * 四个历史 Agent 的初始配置。只 INSERT OR IGNORE：已有行绝不覆盖，
 * 以后用户在界面上改过的名字 / 命令 / 禁用状态不会被迁移冲掉。
 */
function seedAgents(db) {
  const at = new Date().toISOString();
  const rows = [
    {
      agent_id: 'claude', display_name: 'Claude Code', kind: 'cli', sort_index: 10,
      cli_command: 'claude', resume_flag: '--resume',
      capabilities: JSON.stringify({ chat: true, tools: true }),
    },
    {
      agent_id: 'codex', display_name: 'Codex', kind: 'cli', sort_index: 20,
      cli_command: 'codex', resume_flag: '--resume',
      capabilities: JSON.stringify({ chat: false, tools: true }),
    },
    {
      agent_id: 'dsh', display_name: 'DSH', kind: 'cli', sort_index: 30,
      cli_command: defaultDshCommand(), resume_flag: '--session-id',
      capabilities: JSON.stringify({ chat: true, tools: true }),
    },
    {
      agent_id: 'hermes', display_name: 'Hermes', kind: 'external', sort_index: 40,
      cli_command: null, resume_flag: null,
      capabilities: JSON.stringify({ chat: true, self_report: true }),
    },
  ];
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO agents (agent_id, display_name, kind, enabled, sort_index, ' +
    'cli_command, cli_args, resume_flag, base_url, model, protocol, api_key_ref, ' +
    'extra_env, capabilities, created_at, updated_at) ' +
    'VALUES (?, ?, ?, 1, ?, ?, NULL, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)',
  );
  for (const r of rows) {
    stmt.run(r.agent_id, r.display_name, r.kind, r.sort_index,
      r.cli_command, r.resume_flag, r.capabilities, at, at);
  }
}

/** 建表 SQL。用 IF NOT EXISTS，保证重复调用安全。
 * 字段严格按任务书 §2.1；带 + 注释的是本实现补充的辅助列/索引，
 * 只做增量，不改任务书点名的任何列。
 */
const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS tasks (
  task_id       TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  acceptance    TEXT,
  status        TEXT NOT NULL,
  status_reason TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  closed_at     TEXT
);

CREATE TABLE IF NOT EXISTS attempts (
  attempt_id    TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(task_id),
  agent_id      TEXT NOT NULL,
  status        TEXT NOT NULL,
  worktree_path TEXT,
  checkpoint_id TEXT,
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  end_reason    TEXT,
  pid           INTEGER,
  session_id    TEXT,
  relay_pending INTEGER NOT NULL DEFAULT 0,
  note          TEXT
);

CREATE TABLE IF NOT EXISTS events (
  event_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id         TEXT,
  attempt_id      TEXT,
  agent_id        TEXT,
  event_type      TEXT NOT NULL,
  payload         TEXT,
  evidence_source TEXT NOT NULL,
  observed_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL,
  attempt_id    TEXT NOT NULL,
  git_sha       TEXT,
  files         TEXT NOT NULL,
  untracked     TEXT,
  created_at    TEXT NOT NULL,
  label         TEXT
);

CREATE TABLE IF NOT EXISTS write_owner (
  worktree_path TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL,
  attempt_id    TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  acquired_at   TEXT NOT NULL,
  released_at   TEXT,
  heartbeat_at  TEXT
);

CREATE TABLE IF NOT EXISTS task_steps (
  task_id    TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  step_key   TEXT NOT NULL,
  name       TEXT,
  seq        INTEGER NOT NULL,
  status     TEXT NOT NULL,
  at         TEXT,
  note       TEXT,
  files      TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (task_id, step_key)
);

CREATE TABLE IF NOT EXISTS migrate_ledger (
  source_path TEXT PRIMARY KEY,
  sha256      TEXT NOT NULL,
  task_id     TEXT NOT NULL,
  migrated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_task      ON events(task_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_events_attempt   ON events(attempt_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_events_type      ON events(event_type, observed_at);
CREATE INDEX IF NOT EXISTS idx_attempts_task    ON attempts(task_id, started_at);
CREATE INDEX IF NOT EXISTS idx_attempts_agent   ON attempts(agent_id, started_at);
CREATE INDEX IF NOT EXISTS idx_checkpoints_task ON checkpoints(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_steps_task       ON task_steps(task_id, seq);
`;

/** 迁移清单：以后加表/加列时追加一项，版本号递增，已有库只跑增量。 */
const MIGRATIONS = [
  { version: 1, up(db) { db.exec(SCHEMA_V1); } },
  { version: 2, up(db) { db.exec(SCHEMA_V2_CHAT); } },
  { version: 3, up(db) { db.exec(SCHEMA_V3_AGENTS); seedAgents(db); } },
];

/** 已打开的连接缓存：同一个 db 文件在一个进程里只建一个连接。 */
const cache = new Map();

export function resolveDbPath(p) {
  return resolve(p || process.env.AGENT_OFFICE_DB || DEFAULT_DB_PATH);
}

/**
 * 打开（或新建）数据库并建表。
 * @param {{path?: string, memory?: boolean}} opts
 */
export function openDb(opts = {}) {
  const path = opts.memory ? ':memory:' : resolveDbPath(opts.path);
  if (!opts.memory) mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);
  // WAL：读写不互相堵；busy_timeout 防止多进程（server / 迁移脚本）偶发锁冲突。
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  applyMigrations(db);

  if (!opts.memory) cache.set(path, db);
  return db;
}

/** 取进程级单例连接（server / api 用）。 */
export function getDb(opts = {}) {
  const path = resolveDbPath(opts.path);
  const hit = cache.get(path);
  if (hit) return hit;
  return openDb({ ...opts, path });
}

/** 关闭连接并从缓存里移除（测试模拟「重启」时用）。 */
export function closeDb(db) {
  if (!db) return;
  for (const [path, cached] of cache.entries()) {
    if (cached === db) cache.delete(path);
  }
  try { db.close(); } catch { /* 已关闭 */ }
}

/** 主键/事件查询用；避免 sqlite 返回 null-prototype 对象时断言库比较别扭。 */
export function plain(row) {
  return row ? { ...row } : row;
}

/** 执行一段只读查询并返回普通对象数组。 */
export function allRows(db, sql, params = []) {
  return db.prepare(sql).all(...params).map((r) => ({ ...r }));
}

export function getRow(db, sql, params = []) {
  const row = db.prepare(sql).get(...params);
  return row ? { ...row } : null;
}

/** 建表版本；幂等：已经到版本 1 的库不会重复建表。 */
export function applyMigrations(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const row = getRow(db, 'SELECT value FROM schema_meta WHERE key = ?', ['schema_version']);
  const current = row ? Number(row.value) || 0 : 0;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    m.up(db);
    db.prepare(
      'INSERT INTO schema_meta (key, value) VALUES (?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run('schema_version', String(m.version));
  }
  return { version: Math.max(current, SCHEMA_VERSION) };
}

/** 事务包装：BEGIN IMMEDIATE 保证抢锁语义；异常统一回滚。 */
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* 回滚失败不掩盖原错误 */ }
    throw err;
  }
}

export { SCHEMA_VERSION };
