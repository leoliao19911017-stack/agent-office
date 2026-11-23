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
//
// 整个项目只有本文件创建数据库连接；其它模块一律接收 db 参数，便于测试隔离。

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url)); // web/lib
export const REPO_ROOT = resolve(HERE, '..', '..');
export const DEFAULT_DB_PATH = resolve(REPO_ROOT, 'data', 'agent-office.db');

const SCHEMA_VERSION = 1;

/**
 * 建表 SQL。用 IF NOT EXISTS，保证重复调用安全。
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
