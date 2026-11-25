// TASK-tasks 挂到工作流步骤上（run-3d22e663 · 05b）验收测试：B1-B10 逐条对应。
//
// 隔离（不碰 data/agent-office.db，不抢 8090）：
//   1. HTTP 用例复用 test/chat-harness.mjs 起真实 web/server.js 子进程——临时库、stub 中台、
//      随机端口。路由（server-api → api-workflow-runs → api-tasks）、状态码、错误码全部走生产代码；
//   2. 「查 DB」用的是这个临时库的第二个只读连接，接口说写了和库里真有必须同时成立；
//   3. B1 的迁移用例自己造一个 v8 形状的库文件（带旧行），再用生产代码打开它触发 v9 迁移。
//
// 运行：node --no-warnings --test test/tasks-workflow-link.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  mkdtempSync, rmSync, readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { openDb, closeDb, SCHEMA_VERSION } from '../web/lib/db.mjs';
import { startChatServer } from './chat-harness.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TMP_ROOT = mkdtempSync(join(tmpdir(), 'tasks-workflow-link-'));
const ORIGINAL_DB_ENV = process.env.AGENT_OFFICE_DB;

let server = null;   // 真实服务（整个文件共用一个，用例之间靠各自的 run 隔离）
let db = null;       // 临时库的只读连接（查库用）

before(async () => {
  // 保险：任何模块若在用例之外调用 getDb()，也只能落到临时目录。
  process.env.AGENT_OFFICE_DB = join(TMP_ROOT, 'unused.db');
  server = await startChatServer();
  assert.ok(server.dbPath.startsWith(tmpdir()), `测试库必须在临时目录：${server.dbPath}`);
  db = openDb({ path: server.dbPath });
});

after(async () => {
  if (db) closeDb(db);
  try {
    if (server) await server.stop();
  } finally {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

async function call(method, path, body) {
  const res = await fetch(server.base + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON 保留 null */ }
  return { status: res.status, body: json };
}

/** 建一次工作流 run（九条 step 一起建好），返回 run_id。 */
async function newRun(title) {
  const r = await call('POST', '/api/workflow/runs', { template_id: 'coding-v1', title });
  assert.equal(r.status, 201, `建 run 必须 201，实际 ${r.status}：${JSON.stringify(r.body)}`);
  return r.body.run.run_id;
}

async function newTask(title, extra = {}) {
  const r = await call('POST', '/api/tasks', { title, ...extra });
  assert.equal(r.status, 201, `建任务必须 201，实际 ${r.status}：${JSON.stringify(r.body)}`);
  return r.body.task.task_id;
}

function taskRow(taskId) {
  const row = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
  return row ? { ...row } : null;
}

function rowsWhere(where, params = []) {
  return db.prepare(`SELECT * FROM tasks WHERE ${where} ORDER BY rowid ASC`).all(...params).map((r) => ({ ...r }));
}

async function idsOf(path) {
  const r = await call('GET', path);
  assert.equal(r.status, 200, `GET ${path} 必须 200，实际 ${r.status}：${JSON.stringify(r.body)}`);
  return r.body;
}

const batchPath = (runId, stepId) => `/api/workflow/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/tasks`;

// ---------------------------------------------------------------------------
// B1 / B2：迁移 v9 只加两列 + 索引，旧行一行不动，不删表重建
// ---------------------------------------------------------------------------

/** v9 之前 tasks 表的真实形状：v1 的八列 + v8 加的归档三列（与 db.mjs 的 SCHEMA_V1 / v8 迁移逐列对应）。 */
function makeV8DbFile(path, legacyRows) {
  const raw = new DatabaseSync(path);
  raw.exec(`
    CREATE TABLE tasks (
      task_id       TEXT PRIMARY KEY,
      title         TEXT NOT NULL,
      acceptance    TEXT,
      status        TEXT NOT NULL,
      status_reason TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      closed_at     TEXT,
      archived_at   TEXT,
      archived_from TEXT,
      deleted_at    TEXT
    );
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  // rowid 故意不从 1 开始：删表重建会把 rowid 重新编号，迁移后 rowid 不变 = 表没被重建。
  for (const row of legacyRows) {
    raw.prepare(
      'INSERT INTO tasks (rowid, task_id, title, acceptance, status, status_reason, created_at, updated_at, closed_at, ' +
        'archived_at, archived_from, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      row.rowid, row.task_id, row.title, row.acceptance, row.status, row.status_reason,
      row.created_at, row.updated_at, row.closed_at, row.archived_at, row.archived_from, row.deleted_at,
    );
  }
  raw.prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version', '8')").run();
  raw.close();
}

const LEGACY_ROWS = [
  {
    rowid: 431, task_id: 't-legacy-1', title: '旧任务不许丢', acceptance: '旧行原样保留', status: 'running',
    status_reason: '迁移前的状态', created_at: '2026-11-20T01:00:00.000Z', updated_at: '2026-11-20T02:00:00.000Z',
    closed_at: null, archived_at: null, archived_from: null, deleted_at: null,
  },
  {
    rowid: 902, task_id: 't-legacy-2', title: '已归档的旧任务', acceptance: null, status: 'waiting',
    status_reason: '归档不改状态', created_at: '2026-11-21T01:00:00.000Z', updated_at: '2026-11-21T02:00:00.000Z',
    closed_at: null, archived_at: '2026-11-21T03:00:00.000Z', archived_from: 'waiting', deleted_at: null,
  },
];

function columnsOf(handle) {
  return handle.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
}

test('B1 迁移 v9：v8 库加 workflow_run_id / workflow_step_id 两列，旧行还在、新列为 NULL', () => {
  const dir = mkdtempSync(join(TMP_ROOT, 'b1-'));
  const path = join(dir, 'v8.db');
  try {
    makeV8DbFile(path, LEGACY_ROWS);

    const before = new DatabaseSync(path, { readOnly: true });
    const colsBefore = columnsOf(before);
    const verBefore = before.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get().value;
    const rowsBefore = before.prepare('SELECT rowid, * FROM tasks ORDER BY rowid ASC').all().map((r) => ({ ...r }));
    before.close();

    assert.equal(Number(verBefore), 8, '夹具必须是 v8 库');
    assert.ok(!colsBefore.includes('workflow_run_id') && !colsBefore.includes('workflow_step_id'), '夹具不能已有新列');
    assert.equal(rowsBefore.length, 2);

    // 生产代码打开 → 只跑 v9 增量
    const db9 = openDb({ path });
    try {
      const verAfter = db9.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get().value;
      // TASK-COMPANY-D0 加了 v10（公司架构表 + workflow_runs.department_id），打开会一路迁到最新
      assert.equal(Number(verAfter), 10, `迁移后版本必须是 10，实际 ${verAfter}`);
      assert.equal(SCHEMA_VERSION, 10);

      const colsAfter = columnsOf(db9);
      assert.ok(colsAfter.includes('workflow_run_id'), `缺 workflow_run_id，实际列：${colsAfter.join(',')}`);
      assert.ok(colsAfter.includes('workflow_step_id'), `缺 workflow_step_id，实际列：${colsAfter.join(',')}`);
      // 老列一个不少
      for (const col of colsBefore) assert.ok(colsAfter.includes(col), `老列丢了：${col}`);

      const rowsAfter = db9.prepare('SELECT rowid, * FROM tasks ORDER BY rowid ASC').all().map((r) => ({ ...r }));
      assert.equal(rowsAfter.length, 2, '旧行数必须不变');
      rowsAfter.forEach((after, i) => {
        const beforeRow = rowsBefore[i];
        assert.equal(after.rowid, beforeRow.rowid, `rowid 变了（${beforeRow.rowid} → ${after.rowid}），表被重建过`);
        for (const col of colsBefore) {
          assert.equal(after[col], beforeRow[col], `${after.task_id}.${col} 迁移后变了`);
        }
        assert.equal(after.workflow_run_id, null, `${after.task_id}.workflow_run_id 必须是 NULL`);
        assert.equal(after.workflow_step_id, null, `${after.task_id}.workflow_step_id 必须是 NULL`);
      });

      // 索引：(workflow_run_id, workflow_step_id) 联合索引
      const idx = db9.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tasks' AND name = 'idx_tasks_workflow'")
        .get();
      assert.ok(idx, '缺索引 idx_tasks_workflow');
      const idxCols = db9.prepare('PRAGMA index_info(idx_tasks_workflow)').all().map((c) => c.name);
      assert.deepEqual(idxCols, ['workflow_run_id', 'workflow_step_id']);
    } finally {
      closeDb(db9);
    }

    // 幂等：再开一次不报错、版本不跳、行不重复
    const again = openDb({ path });
    try {
      assert.equal(Number(again.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get().value), 10);
      assert.equal(again.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 2);
    } finally {
      closeDb(again);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B2 不删表重建：迁移代码里没有 DROP TABLE，v9 只 ALTER TABLE ADD COLUMN', () => {
  const source = readFileSync(join(ROOT, 'web', 'lib', 'db.mjs'), 'utf8');
  assert.ok(!/DROP\s+TABLE/i.test(source), 'web/lib/db.mjs 里不允许出现 DROP TABLE');
  assert.ok(!/DROP\s+INDEX/i.test(source), 'web/lib/db.mjs 里不允许出现 DROP INDEX');

  // 取出 v9 那一段（从 "version: 9" 到文件里 MIGRATIONS 结束的 "];"）
  const start = source.indexOf('version: 9');
  assert.ok(start > 0, '找不到 v9 迁移');
  const v9 = source.slice(start, source.indexOf('];', start));
  assert.match(v9, /ALTER TABLE tasks ADD COLUMN workflow_run_id TEXT/);
  assert.match(v9, /ALTER TABLE tasks ADD COLUMN workflow_step_id TEXT/);
  assert.doesNotMatch(v9, /CREATE TABLE/i, 'v9 不许建新表来替换 tasks');
  // 硬约束：没有动需求基线那一列
  assert.doesNotMatch(v9, /requirement_baseline/);
});

test('B1b 全新库直接建到 v9：tasks 表自带两列', () => {
  const fresh = openDb({ memory: true });
  try {
    assert.equal(Number(fresh.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get().value), 10);
    const cols = columnsOf(fresh);
    assert.ok(cols.includes('workflow_run_id') && cols.includes('workflow_step_id'));
  } finally {
    closeDb(fresh);
  }
});

// ---------------------------------------------------------------------------
// B3：POST /api/tasks 能带 workflow_run_id
// ---------------------------------------------------------------------------

test('B3 POST /api/tasks 带 workflow_run_id + workflow_step_id：库里两列都有值', async () => {
  const runId = await newRun('B3 单条挂点');
  const taskId = await newTask('B3 加三列迁移', { workflow_run_id: runId, workflow_step_id: '05' });

  const row = taskRow(taskId);
  assert.equal(row.workflow_run_id, runId, 'DB workflow_run_id 必须有值');
  assert.equal(row.workflow_step_id, '05', 'DB workflow_step_id 必须有值');
  assert.equal(row.title, 'B3 加三列迁移');

  // 响应与库一致，并且带出步骤名（服务端按 run 的模板查）
  const detail = await call('GET', `/api/tasks/${taskId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.view.workflow_run_id, runId);
  assert.equal(detail.body.view.workflow_step_id, '05');
  assert.equal(detail.body.view.workflow_step_name, '开发执行');

  // task_created 事件记下挂点
  const ev = db.prepare("SELECT payload FROM events WHERE task_id = ? AND event_type = 'task_created'").get(taskId);
  const payload = JSON.parse(ev.payload);
  assert.equal(payload.workflow_run_id, runId);
  assert.equal(payload.workflow_step_id, '05');
});

test('B3b 只给 run 不给步骤：允许（属于这次需求，没挂到具体某步）', async () => {
  const runId = await newRun('B3b 只挂 run');
  const taskId = await newTask('B3b 只挂需求', { workflow_run_id: runId });
  assert.equal(taskRow(taskId).workflow_run_id, runId);
  assert.equal(taskRow(taskId).workflow_step_id, null);
});

test('B3c 挂点校验：run 不存在 404、run 里没这步 404、只给步骤 400，且都不建任务', async () => {
  const runId = await newRun('B3c 挂点校验');
  const title = 'B3c 不该被建出来';

  const ghost = await call('POST', '/api/tasks', { title, workflow_run_id: 'run-does-not-exist', workflow_step_id: '05' });
  assert.equal(ghost.status, 404, `不存在的 run 必须 404，实际 ${ghost.status}：${JSON.stringify(ghost.body)}`);
  assert.equal(ghost.body.code, 'RUN_NOT_FOUND');

  const badStep = await call('POST', '/api/tasks', { title, workflow_run_id: runId, workflow_step_id: '99' });
  assert.equal(badStep.status, 404, `run 里没有的步骤必须 404，实际 ${badStep.status}`);
  assert.equal(badStep.body.code, 'STEP_NOT_FOUND');

  const half = await call('POST', '/api/tasks', { title, workflow_step_id: '05' });
  assert.equal(half.status, 400, `只给步骤必须 400，实际 ${half.status}`);
  assert.equal(half.body.code, 'BAD_WORKFLOW_LINK');

  assert.equal(rowsWhere('title = ?', [title]).length, 0, '三种非法挂点都不许建出任务');
});

// ---------------------------------------------------------------------------
// B4 / B5 / B6：GET 过滤
// ---------------------------------------------------------------------------

test('B4 GET /api/tasks?workflow_run_id=X：2 个 run 各 3 条，查询只返回该 run 的 3 条', async () => {
  const runA = await newRun('B4 需求 A');
  const runB = await newRun('B4 需求 B');
  const aIds = [];
  const bIds = [];
  for (let i = 0; i < 3; i += 1) {
    aIds.push(await newTask(`B4 A-${i}`, { workflow_run_id: runA, workflow_step_id: '05' }));
    bIds.push(await newTask(`B4 B-${i}`, { workflow_run_id: runB, workflow_step_id: '05' }));
  }

  const a = await idsOf(`/api/tasks?workflow_run_id=${encodeURIComponent(runA)}`);
  assert.equal(a.count, 3, `run A 必须 3 条，实际 ${a.count}`);
  assert.deepEqual(a.tasks.map((t) => t.task_id).sort(), [...aIds].sort());
  assert.equal(a.tasks.some((t) => bIds.includes(t.task_id)), false, '不许混进 run B 的任务');
  assert.equal(a.workflow_run_id, runA, '响应回显过滤条件');
  assert.equal(a.workflow_step_id, null);

  const b = await idsOf(`/api/tasks?workflow_run_id=${encodeURIComponent(runB)}`);
  assert.equal(b.count, 3);
  assert.deepEqual(b.tasks.map((t) => t.task_id).sort(), [...bIds].sort());
});

test('B5 GET 按 run + step 过滤：05 步 2 条、06 步 1 条，各查各的', async () => {
  const runId = await newRun('B5 按步骤过滤');
  const s05 = [
    await newTask('B5 开发-1', { workflow_run_id: runId, workflow_step_id: '05' }),
    await newTask('B5 开发-2', { workflow_run_id: runId, workflow_step_id: '05' }),
  ];
  const s06 = [await newTask('B5 自测-1', { workflow_run_id: runId, workflow_step_id: '06' })];
  // 同一个步骤号挂在别的 run 上，不许被这次查询带出来
  const otherRun = await newRun('B5 别的 run');
  const other05 = await newTask('B5 别的 run 的 05', { workflow_run_id: otherRun, workflow_step_id: '05' });

  const dev = await idsOf(`/api/tasks?workflow_run_id=${encodeURIComponent(runId)}&workflow_step_id=05`);
  assert.equal(dev.count, 2, `05 步必须 2 条，实际 ${dev.count}`);
  assert.deepEqual(dev.tasks.map((t) => t.task_id).sort(), [...s05].sort());
  assert.deepEqual(dev.tasks.map((t) => t.workflow_step_id), ['05', '05']);

  const test_ = await idsOf(`/api/tasks?workflow_run_id=${encodeURIComponent(runId)}&workflow_step_id=06`);
  assert.equal(test_.count, 1, `06 步必须 1 条，实际 ${test_.count}`);
  assert.deepEqual(test_.tasks.map((t) => t.task_id), [...s06]);
  assert.equal(test_.workflow_step_id, '06', '响应回显步骤过滤条件');

  // 各查各的：两个集合不相交；不带步骤时是三步之和
  assert.equal(dev.tasks.some((t) => test_.tasks.some((x) => x.task_id === t.task_id)), false);
  assert.ok(!dev.tasks.some((t) => t.task_id === other05), '别的 run 的同号步骤不许混进来');
  const all = await idsOf(`/api/tasks?workflow_run_id=${encodeURIComponent(runId)}`);
  assert.equal(all.count, 3);
});

test('B6 不带 workflow_run_id 的老任务：默认列表仍然能查到，挂点字段为 null', async () => {
  const legacy = await newTask('B6 没挂工作流的任务');
  const runId = await newRun('B6 对照 run');
  const linked = await newTask('B6 挂了工作流的任务', { workflow_run_id: runId, workflow_step_id: '07' });
  const row = taskRow(legacy);
  assert.equal(row.workflow_run_id, null);
  assert.equal(row.workflow_step_id, null);

  const all = await idsOf('/api/tasks');
  const ids = all.tasks.map((t) => t.task_id);
  assert.ok(ids.includes(legacy), '默认列表必须包含没挂工作流的老任务');
  assert.ok(ids.includes(linked), '默认列表也包含挂了工作流的任务（不过滤就全返回）');
  assert.equal(all.workflow_run_id, null);
  assert.equal(all.workflow_step_id, null);

  const old = all.tasks.find((t) => t.task_id === legacy);
  assert.equal(old.workflow_run_id, null);
  assert.equal(old.workflow_step_id, null);
  assert.equal(old.workflow_step_name, null);

  // 「GET /api/tasks 返回里带上这两个字段」：每一条都有这两个键
  for (const t of all.tasks) {
    assert.ok(Object.hasOwn(t, 'workflow_run_id'), `${t.task_id} 缺 workflow_run_id 字段`);
    assert.ok(Object.hasOwn(t, 'workflow_step_id'), `${t.task_id} 缺 workflow_step_id 字段`);
  }

  // 按 run 过滤时，老任务不出现
  const filtered = await idsOf(`/api/tasks?workflow_run_id=${encodeURIComponent(runId)}`);
  assert.equal(filtered.tasks.some((t) => t.task_id === legacy), false, '按 run 过滤不许带出老任务');
  assert.ok(filtered.tasks.some((t) => t.task_id === linked));
});

test('B6b GET 只给 workflow_step_id 不给 run：400，不猜是哪次需求', async () => {
  const r = await call('GET', '/api/tasks?workflow_step_id=05');
  assert.equal(r.status, 400, `实际 ${r.status}：${JSON.stringify(r.body)}`);
  assert.equal(r.body.code, 'BAD_WORKFLOW_LINK');
});

// ---------------------------------------------------------------------------
// B7 / B8 / B9：从任务书批量建任务
// ---------------------------------------------------------------------------

const DOC = [
  { title: '加三列迁移', acceptance: 'v9 迁移只 ALTER TABLE，旧行不丢' },
  { title: '写四个路由', acceptance: 'GET 过滤 ×2、POST 挂点、批量建任务' },
  { title: '12 条测试', acceptance: 'B1-B10 全覆盖' },
  { title: '看板按 run 过滤', acceptance: '选中 run 只看这次需求的任务' },
  { title: '任务显示步骤标签', acceptance: '每个任务显示「05 开发执行」' },
];

test('B7 批量建任务：一次建 5 条，自动填 run + step，库里全对', async () => {
  const runId = await newRun('B7 从任务书批量建任务');
  const r = await call('POST', batchPath(runId, '05'), { tasks: DOC });
  assert.equal(r.status, 201, `批量建任务必须 201，实际 ${r.status}：${JSON.stringify(r.body)}`);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.created, 5, `created 必须是 5，实际 ${r.body.created}`);
  assert.equal(r.body.tasks.length, 5);
  assert.equal(r.body.workflow_run_id, runId);
  assert.equal(r.body.workflow_step_id, '05');
  assert.equal(r.body.workflow_step_name, '开发执行');

  // 响应顺序 = 任务书顺序
  assert.deepEqual(r.body.tasks.map((t) => t.title), DOC.map((d) => d.title));
  const ids = r.body.tasks.map((t) => t.task_id);
  assert.equal(new Set(ids).size, 5, '五条任务的 task_id 必须互不相同');

  // 查库：五条都在，两列全对，acceptance 原样落库
  const rows = rowsWhere('workflow_run_id = ? AND workflow_step_id = ?', [runId, '05']);
  assert.equal(rows.length, 5, `库里该 run 05 步必须有 5 条，实际 ${rows.length}`);
  assert.deepEqual(rows.map((x) => x.task_id), ids, '库里行与响应一一对应');
  rows.forEach((row, i) => {
    assert.equal(row.title, DOC[i].title);
    assert.equal(row.acceptance, DOC[i].acceptance);
    assert.equal(row.workflow_run_id, runId, `${row.task_id} 的 workflow_run_id 不对`);
    assert.equal(row.workflow_step_id, '05', `${row.task_id} 的 workflow_step_id 不对`);
    assert.equal(row.status, 'waiting');
    assert.equal(row.archived_at, null);
    assert.equal(row.deleted_at, null);
  });

  // 列表接口按 run + step 查得到，标签字段齐
  const list = await idsOf(`/api/tasks?workflow_run_id=${encodeURIComponent(runId)}&workflow_step_id=05`);
  assert.equal(list.count, 5);
  for (const t of list.tasks) {
    assert.equal(t.workflow_step_name, '开发执行');
    assert.ok(ids.includes(t.task_id));
  }
});

test('B7b 批量是原子的：5 条里 1 条没有 title → 400，一条都不建', async () => {
  const runId = await newRun('B7b 整批回滚');
  const bad = [...DOC.slice(0, 2), { acceptance: '没有 title' }, ...DOC.slice(2)];
  const r = await call('POST', batchPath(runId, '06'), { tasks: bad });
  assert.equal(r.status, 400, `坏任务书必须 400，实际 ${r.status}：${JSON.stringify(r.body)}`);
  assert.equal(r.body.code, 'BAD_TITLE');
  assert.match(r.body.error, /tasks\[2\]/, '错误要指明是第几项');
  assert.equal(rowsWhere('workflow_run_id = ?', [runId]).length, 0, '整批回滚：不许留下前 2 条');
});

test('B7c 批量入参：tasks 不是数组 / 空数组 → 400；路径对但方法不对 → 405', async () => {
  const runId = await newRun('B7c 入参校验');
  const notArray = await call('POST', batchPath(runId, '05'), { tasks: '加三列迁移' });
  assert.equal(notArray.status, 400);
  assert.equal(notArray.body.code, 'BAD_TASKS');

  const empty = await call('POST', batchPath(runId, '05'), { tasks: [] });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.code, 'BAD_TASKS');

  const get = await call('GET', batchPath(runId, '05'));
  assert.equal(get.status, 405, `GET 这个路径必须 405，实际 ${get.status}`);
  assert.equal(rowsWhere('workflow_run_id = ?', [runId]).length, 0);
});

test('B8 传不存在的 run_id：404，且不建任务', async () => {
  const title = 'B8 不该被建出来';
  const r = await call('POST', batchPath('run-does-not-exist', '05'), { tasks: [{ title }] });
  assert.equal(r.status, 404, `不存在的 run 必须 404，实际 ${r.status}：${JSON.stringify(r.body)}`);
  assert.equal(r.body.code, 'RUN_NOT_FOUND');
  assert.equal(r.body.created, undefined, '失败响应不许带 created');
  assert.equal(rowsWhere('title = ?', [title]).length, 0);
});

test('B9 传 run 里没有的 step_id：404，且不建任务', async () => {
  const runId = await newRun('B9 步骤不存在');
  const title = 'B9 不该被建出来';
  const r = await call('POST', batchPath(runId, '99'), { tasks: [{ title }, { title: `${title} 2` }] });
  assert.equal(r.status, 404, `run 里没有的步骤必须 404，实际 ${r.status}：${JSON.stringify(r.body)}`);
  assert.equal(r.body.code, 'STEP_NOT_FOUND');
  assert.equal(rowsWhere('workflow_run_id = ?', [runId]).length, 0, '不许建出任何任务');
});

// ---------------------------------------------------------------------------
// B10：上一版的行为不变
// ---------------------------------------------------------------------------

test('B10 挂了工作流的任务，归档 / 恢复 / 删除 / 批量的行为与上一版一致，挂点不丢', async () => {
  const runId = await newRun('B10 归档删除回归');
  const archivedId = await newTask('B10 归档', { workflow_run_id: runId, workflow_step_id: '05' });
  const restoredId = await newTask('B10 恢复', { workflow_run_id: runId, workflow_step_id: '05' });
  const deletedId = await newTask('B10 删除', { workflow_run_id: runId, workflow_step_id: '06' });

  // 归档：只写 archived_at，status 不动，挂点不动
  const before = taskRow(archivedId);
  const ar = await call('POST', `/api/tasks/${archivedId}/archive`, { actor: 'test:b10' });
  assert.equal(ar.status, 200, JSON.stringify(ar.body));
  const afterArchive = taskRow(archivedId);
  assert.ok(afterArchive.archived_at);
  assert.equal(afterArchive.status, before.status);
  assert.equal(afterArchive.workflow_run_id, runId);
  assert.equal(afterArchive.workflow_step_id, '05');

  // 默认列表不返回归档行；include_archived=1 返回；与 run 过滤可以叠加
  const byRun = await idsOf(`/api/tasks?workflow_run_id=${encodeURIComponent(runId)}`);
  assert.equal(byRun.tasks.some((t) => t.task_id === archivedId), false, '归档行默认不返回');
  assert.equal(byRun.tasks.some((t) => t.task_id === restoredId), true);
  const byRunWithArchived = await idsOf(`/api/tasks?workflow_run_id=${encodeURIComponent(runId)}&include_archived=1`);
  const archivedView = byRunWithArchived.tasks.find((t) => t.task_id === archivedId);
  assert.ok(archivedView && archivedView.is_archived === true);
  assert.equal(archivedView.workflow_step_id, '05');

  // 批量恢复 + 批量删除（逐条返回，挂点保留）
  const batch = await call('POST', '/api/tasks/batch', { action: 'restore', ids: [archivedId], actor: 'test:b10' });
  assert.equal(batch.status, 200);
  assert.equal(batch.body.succeeded, 1);
  assert.equal(taskRow(archivedId).archived_at, null);
  assert.equal(taskRow(archivedId).workflow_step_id, '05', '恢复后挂点还在');

  const del = await call('POST', '/api/tasks/batch', { action: 'delete', ids: [deletedId], actor: 'test:b10' });
  assert.equal(del.status, 200);
  assert.equal(del.body.succeeded, 1);
  assert.ok(taskRow(deletedId).deleted_at, '软删：行还在、deleted_at 有值');
  assert.equal(taskRow(deletedId).workflow_run_id, runId, '软删后挂点还在');

  const single = await call('DELETE', `/api/tasks/${restoredId}`, { actor: 'test:b10' });
  assert.equal(single.status, 200);
  assert.ok(taskRow(restoredId).deleted_at);
});

test('B10 上一版 A1-A10：node --test test/tasks-archive.test.js 必须 12/12', () => {
  const tmp = mkdtempSync(join(TMP_ROOT, 'b10-'));
  try {
    // Node 的测试运行器给测试进程设了 NODE_TEST_CONTEXT；原样传给子进程会让子进程的
    // `node --test` 不输出任何汇总（实测 exit 0、0 字节），所以这里必须剔掉。
    const { NODE_TEST_CONTEXT, ...env } = process.env;
    const r = spawnSync(process.execPath, [
      '--no-warnings', '--test', 'test/tasks-archive.test.js',
    ], {
      cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 120000,
      env: { ...env, AGENT_OFFICE_DB: join(tmp, 'unused.db') },
    });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    assert.equal(r.status, 0, `上一版测试必须全过（exit ${r.status}）：\n${out.slice(-3000)}`);
    const pass = /ℹ pass (\d+)/.exec(out);
    const fail = /ℹ fail (\d+)/.exec(out);
    const total = /ℹ tests (\d+)/.exec(out);
    assert.ok(pass && fail && total, `读不到测试汇总：\n${out.slice(-800)}`);
    assert.equal(Number(total[1]), 12, `上一版应当有 12 条用例，实际 ${total[1]}`);
    assert.equal(Number(pass[1]), 12, `上一版必须 12/12，实际通过 ${pass[1]}：\n${out.slice(-2000)}`);
    assert.equal(Number(fail[1]), 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
