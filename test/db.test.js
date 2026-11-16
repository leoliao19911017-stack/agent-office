// Task 1.1 数据库层测试：建表 / 插入 Agent / 查询 Agent（含 miss 与负路径）/ 文件持久化。
// 运行：npm test（node --test test/）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initializeDatabase,
  closeDatabase,
  insertAgent,
  getAgentById,
  listAgents,
} from '../src/db.js';

// 任务书 §7 规定的字段清单，顺序即建表顺序。
// Task 2.1 起 tasks 表追加租约四列（claim_token / lease_expires_at / attempt / current_run_id），
// 清单随之同步——本测试的意图是"schema 与任务书一致"，契约更新，断言跟着更新。
const AGENT_COLUMNS = ['id', 'name', 'type', 'status', 'last_heartbeat', 'capabilities', 'created_at'];
const TASK_COLUMNS = [
  'id', 'title', 'description', 'assignee', 'status', 'claimed_at', 'created_at', 'result_path',
  'claim_token', 'lease_expires_at', 'attempt', 'current_run_id',
];
const EVENT_COLUMNS = ['id', 'task_id', 'agent_id', 'type', 'payload', 'created_at'];

function columnsOf(db, table) {
  return db.all(`PRAGMA table_info(${table})`).map((c) => c.name);
}

test('建表：agents / tasks / events 三张表，字段与任务书一致', () => {
  const db = initializeDatabase(':memory:');
  try {
    const tables = db
      .all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .map((r) => r.name)
      .sort();
    assert.deepEqual(tables, ['agents', 'events', 'tasks']);
    assert.deepEqual(columnsOf(db, 'agents'), AGENT_COLUMNS);
    assert.deepEqual(columnsOf(db, 'tasks'), TASK_COLUMNS);
    assert.deepEqual(columnsOf(db, 'events'), EVENT_COLUMNS);
  } finally {
    closeDatabase(db);
  }
});

test('插入 Agent：字段完整落库，capabilities JSON 往返无损', () => {
  const db = initializeDatabase(':memory:');
  try {
    const inserted = insertAgent(db, {
      name: 'lemate',
      type: 'hermes',
      status: 'working',
      capabilities: ['code', 'docs'],
    });
    assert.ok(inserted.id, '应自动生成 id');
    assert.equal(typeof inserted.created_at, 'number');

    const row = getAgentById(db, inserted.id);
    assert.equal(row.name, 'lemate');
    assert.equal(row.type, 'hermes');
    assert.equal(row.status, 'working');
    assert.deepEqual(JSON.parse(row.capabilities), ['code', 'docs']);
    assert.equal(row.last_heartbeat, null);
  } finally {
    closeDatabase(db);
  }
});

test('查询 Agent：列表按注册序返回；查无返回 null，不编数据', () => {
  const db = initializeDatabase(':memory:');
  try {
    const a = insertAgent(db, { name: 'alpha' });
    insertAgent(db, { name: 'beta' });

    const list = listAgents(db);
    assert.equal(list.length, 2);
    assert.deepEqual(list.map((r) => r.name), ['alpha', 'beta']);
    assert.equal(getAgentById(db, a.id).name, 'alpha');
    assert.equal(getAgentById(db, 'no-such-id'), null, '查无此 Agent 必须返回 null');
  } finally {
    closeDatabase(db);
  }
});

test('文件库：数据落盘，重开可读，schema 重复初始化幂等', () => {
  const dir = mkdtempSync(join(tmpdir(), 'soda-office-test-'));
  const dbFile = join(dir, 'office.db');
  let id;
  try {
    const db = initializeDatabase(dbFile);
    id = insertAgent(db, { name: 'persisted' }).id;
    closeDatabase(db);

    // 第二次 initializeDatabase 会再跑一遍 CREATE TABLE IF NOT EXISTS，不应抛错
    const reopened = initializeDatabase(dbFile);
    const row = getAgentById(reopened, id);
    assert.equal(row?.name, 'persisted', '重开后数据必须还在');
    closeDatabase(reopened);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('负路径：非法输入拒收；外键约束真实生效', () => {
  const db = initializeDatabase(':memory:');
  try {
    assert.throws(() => insertAgent(db, {}), TypeError, '缺 name 必须拒收');
    assert.throws(() => insertAgent(db, { name: 'x', status: 'bogus' }), RangeError, '非法状态必须拒收');
    assert.throws(() => insertAgent(db, { name: 'x', capabilities: 'code' }), TypeError, 'capabilities 非数组必须拒收');

    // events.agent_id 指向不存在的 Agent，外键约束必须让写入失败（PRAGMA foreign_keys 已开）
    assert.throws(
      () =>
        db.run(
          'INSERT INTO events (task_id, agent_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)',
          [null, 'ghost-agent', 'start', '{}', Date.now()],
        ),
      '幽灵 agent_id 的事件必须被外键拦下',
    );
  } finally {
    closeDatabase(db);
  }
});
