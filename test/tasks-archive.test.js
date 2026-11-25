// TASK-任务归档 / 删除 / 恢复（run-3d22e663）验收测试：A1-A10 逐条对应。
//
// 隔离三件套（不碰 data/agent-office.db）：
//   1. 每个用例一个新临时目录 + 新 SQLite 文件（AGENT_OFFICE_DB 指过去）；
//   2. 真实 HTTP 服务：node:http 直接挂 web/api-tasks.mjs 的 handleTasksApi，
//      路由/状态码/错误码全部走生产代码，不 mock；
//   3. 断言一半走 HTTP 响应，一半直接 PRAGMA/ SELECT 查库——「接口说改了」
//      和「库里真的改了」必须同时成立。
//
// 运行：node --no-warnings --test test/tasks-archive.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, SCHEMA_VERSION } from '../web/lib/db.mjs';
import { handleTasksApi } from '../web/api-tasks.mjs';

const TMP_ROOT = mkdtempSync(join(tmpdir(), 'tasks-archive-'));
const ORIGINAL_DB_ENV = process.env.AGENT_OFFICE_DB;

before(() => {
  // 保险：任何模块若在用例之外调用 getDb()，也只能落到临时目录。
  process.env.AGENT_OFFICE_DB = join(TMP_ROOT, 'unused.db');
});
after(() => {
  if (ORIGINAL_DB_ENV === undefined) delete process.env.AGENT_OFFICE_DB;
  else process.env.AGENT_OFFICE_DB = ORIGINAL_DB_ENV;
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 真实 HTTP 夹具：web/api-tasks.mjs 挂在临时端口上
// ---------------------------------------------------------------------------

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function httpError(status, code, message) {
  return Object.assign(new Error(message), { statusCode: status, code });
}

let seq = 0;
/** 起一套「临时库 + 真实路由」的服务，用例结束自动拆。 */
async function withApi(fn) {
  const dir = mkdtempSync(join(TMP_ROOT, `case-${++seq}-`));
  const dbPath = join(dir, 'agent-office.db');
  process.env.AGENT_OFFICE_DB = dbPath;
  const db = openDb({ path: dbPath });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      const handled = await handleTasksApi(req, res, url.pathname, req.method, {
        sendJson, readJsonBody, httpError,
      });
      if (!handled) sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: `${req.method} ${url.pathname}` });
    } catch (err) {
      sendJson(res, err.statusCode || 500, { ok: false, code: err.code || 'ERROR', message: String(err.message || err) });
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* 非 JSON 保留 null */ }
    return { status: res.status, body: json };
  };

  try {
    return await fn({ db, dbPath, call, base });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
}

function taskRow(db, taskId) {
  const row = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
  return row ? { ...row } : null;
}

function eventsOf(db, taskId, type) {
  return db.prepare('SELECT * FROM events WHERE task_id = ? AND event_type = ? ORDER BY event_id ASC')
    .all(taskId, type).map((r) => ({ ...r }));
}

async function createTask(call, title) {
  const r = await call('POST', '/api/tasks', { title });
  assert.equal(r.status, 201, `建任务必须 201，实际 ${r.status}：${JSON.stringify(r.body)}`);
  return r.body.task.task_id;
}

/** 通过真实 attempt 接口把任务推到 running（不是直接 UPDATE 状态列）。 */
async function createRunningTask(call, title) {
  const taskId = await createTask(call, title);
  const r = await call('POST', `/api/tasks/${taskId}/attempt`, { agent_id: 'dsh' });
  assert.equal(r.status, 201, `声明执行必须 201，实际 ${r.status}：${JSON.stringify(r.body)}`);
  assert.equal(r.body.state.status, 'running', `attempt 后状态必须是 running，实际 ${r.body.state.status}`);
  return taskId;
}

// ---------------------------------------------------------------------------
// 迁移（A1-A10 的前置）：v8 只加列，不删表重建
// ---------------------------------------------------------------------------
test('M1 迁移 v8：tasks 新增 archived_at / archived_from / deleted_at，版本 +1', async () => {
  await withApi(async ({ db }) => {
    const cols = db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
    for (const col of ['archived_at', 'archived_from', 'deleted_at']) {
      assert.ok(cols.includes(col), `tasks 必须有 ${col} 列，实际列：${cols.join(',')}`);
    }
    const ver = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get();
    // 断言的是「v8 迁移已经跑过」，不是「版本恰好等于 8」：版本号会随后续迁移继续 +1
    // （v9 起是 9），写死 8 会让每一次后续迁移都把本用例打挂，却说明不了归档功能坏了。
    // v9 挂工作流步骤那一轮把这两行从 equal(…, 8) 改成了 >= 8，其余用例一字未动。
    assert.ok(Number(ver.value) >= 8, `schema_version 至少是 8（v8 已迁移），实际 ${ver.value}`);
    assert.ok(SCHEMA_VERSION >= 8, `SCHEMA_VERSION 至少是 8，实际 ${SCHEMA_VERSION}`);
  });
});

// ---------------------------------------------------------------------------
// A1/A2：归档写 archived_at=当前时间；不改 status
// ---------------------------------------------------------------------------
test('A1 POST /archive 把 archived_at 写成当前时间', async () => {
  await withApi(async ({ db, call }) => {
    const taskId = await createTask(call, 'A1 归档时间');
    const before = Date.now();
    const r = await call('POST', `/api/tasks/${taskId}/archive`, { actor: 'test:a1' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(r.body.action, 'archive');

    const row = taskRow(db, taskId);
    assert.ok(row.archived_at, 'archived_at 必须非空');
    const at = Date.parse(row.archived_at);
    assert.ok(Number.isFinite(at), `archived_at 必须是可解析时间，实际 ${row.archived_at}`);
    assert.ok(at >= before - 1000 && at <= Date.now() + 1000, `archived_at 应是当前时间，实际 ${row.archived_at}`);
    // 响应里的时间与库里一致
    assert.equal(r.body.archived_at, row.archived_at);
  });
});

test('A2 归档不改 status（running 归档后仍是 running）', async () => {
  await withApi(async ({ db, call }) => {
    const taskId = await createRunningTask(call, 'A2 归档不改状态');
    const before = taskRow(db, taskId);
    assert.equal(before.status, 'running');

    const r = await call('POST', `/api/tasks/${taskId}/archive`, { actor: 'test:a2' });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const after = taskRow(db, taskId);
    assert.equal(after.status, before.status, '归档前后 status 必须一致');
    assert.equal(after.status, 'running');
    assert.equal(after.archived_from, 'running', 'archived_from 记录归档瞬间状态');
    assert.equal(r.body.status, 'running');
  });
});

// ---------------------------------------------------------------------------
// A3/A4：默认列表不含归档；include_archived=1 含
// ---------------------------------------------------------------------------
test('A3 归档后默认 GET /api/tasks 不返回该任务', async () => {
  await withApi(async ({ call }) => {
    const keep = await createTask(call, 'A3 保留任务');
    const archived = await createTask(call, 'A3 要归档任务');
    assert.equal((await call('POST', `/api/tasks/${archived}/archive`, { actor: 'test:a3' })).status, 200);

    const r = await call('GET', '/api/tasks');
    assert.equal(r.status, 200);
    const ids = r.body.tasks.map((t) => t.task_id);
    assert.ok(ids.includes(keep), '未归档任务必须在默认列表');
    assert.ok(!ids.includes(archived), '归档任务不得出现在默认列表');
    assert.equal(r.body.include_archived, false);
  });
});

test('A4 GET /api/tasks?include_archived=1 返回归档任务', async () => {
  await withApi(async ({ call }) => {
    const archived = await createTask(call, 'A4 归档可见');
    assert.equal((await call('POST', `/api/tasks/${archived}/archive`, { actor: 'test:a4' })).status, 200);

    const r = await call('GET', '/api/tasks?include_archived=1');
    assert.equal(r.status, 200);
    assert.equal(r.body.include_archived, true);
    const found = r.body.tasks.find((t) => t.task_id === archived);
    assert.ok(found, 'include_archived=1 必须返回已归档任务');
    assert.equal(found.is_archived, true);
    assert.ok(found.archived_at, '列表项要带 archived_at 供前端灰显/贴标签');
  });
});

// ---------------------------------------------------------------------------
// A5/A6：恢复用 archived_from 还原原状态；archived_at 置空
// ---------------------------------------------------------------------------
test('A5 归档前 running → 恢复后仍 running（用 archived_from 还原）', async () => {
  await withApi(async ({ db, call }) => {
    const taskId = await createRunningTask(call, 'A5 恢复原状态');
    assert.equal((await call('POST', `/api/tasks/${taskId}/archive`, { actor: 'test:a5' })).status, 200);
    assert.equal(taskRow(db, taskId).status, 'running', '归档不许改状态');

    const r = await call('POST', `/api/tasks/${taskId}/restore`, { actor: 'test:a5' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.action, 'restore');
    assert.equal(r.body.status, 'running');
    assert.equal(taskRow(db, taskId).status, 'running', '恢复后 status 必须是 archived_from 的 running');
  });
});

test('A6 恢复后 archived_at 置空', async () => {
  await withApi(async ({ db, call }) => {
    const taskId = await createTask(call, 'A6 清空归档时间');
    assert.equal((await call('POST', `/api/tasks/${taskId}/archive`, { actor: 'test:a6' })).status, 200);
    assert.ok(taskRow(db, taskId).archived_at);

    const r = await call('POST', `/api/tasks/${taskId}/restore`, { actor: 'test:a6' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const row = taskRow(db, taskId);
    assert.equal(row.archived_at, null, 'archived_at 必须置空');
    assert.equal(row.archived_from, null, 'archived_from 一并清掉');
    assert.equal(r.body.archived_at, null);
  });
});

// ---------------------------------------------------------------------------
// A7/A8：running 拒删 409；非 running 软删
// ---------------------------------------------------------------------------
test('A7 DELETE /api/tasks/:id 对 running 返回 409', async () => {
  await withApi(async ({ db, call }) => {
    const taskId = await createRunningTask(call, 'A7 运行中不许删');
    const r = await call('DELETE', `/api/tasks/${taskId}`, { actor: 'test:a7' });
    assert.equal(r.status, 409, `running 必须 409，实际 ${r.status}：${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, 'TASK_RUNNING');
    assert.match(r.body.message, /运行/);
    const row = taskRow(db, taskId);
    assert.ok(row, '拒删后行必须还在');
    assert.equal(row.deleted_at, null, '拒删不许偷偷写 deleted_at');
  });
});

test('A8 DELETE 对非 running 是软删：deleted_at 有值、行还在、默认列表不返回', async () => {
  await withApi(async ({ db, call }) => {
    const taskId = await createTask(call, 'A8 软删');
    const r = await call('DELETE', `/api/tasks/${taskId}`, { actor: 'test:a8' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.action, 'delete');

    const row = taskRow(db, taskId);
    assert.ok(row, '软删后数据库行必须还在');
    assert.ok(row.deleted_at, 'deleted_at 必须有值');
    assert.ok(Number.isFinite(Date.parse(row.deleted_at)));

    const list = await call('GET', '/api/tasks');
    assert.ok(!list.body.tasks.some((t) => t.task_id === taskId), '软删任务不应出现在默认列表');
  });
});

// ---------------------------------------------------------------------------
// A9：批量逐条返回，一条失败不影响其它
// ---------------------------------------------------------------------------
test('A9 POST /api/tasks/batch：3 条中 1 条 running 删除失败，2 条成功且各自有原因', async () => {
  await withApi(async ({ db, call }) => {
    const ok1 = await createTask(call, 'A9 可删 1');
    const ok2 = await createTask(call, 'A9 可删 2');
    const running = await createRunningTask(call, 'A9 运行中');

    const r = await call('POST', '/api/tasks/batch', {
      action: 'delete', ids: [ok1, running, ok2], actor: 'test:batch',
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.requested, 3);
    assert.equal(r.body.succeeded, 2);
    assert.equal(r.body.failed, 1);
    assert.equal(r.body.results.length, 3, '逐条返回，条数必须与请求一致');

    const byId = Object.fromEntries(r.body.results.map((x) => [x.task_id, x]));
    assert.equal(byId[ok1].ok, true);
    assert.equal(byId[ok2].ok, true);
    assert.equal(byId[running].ok, false);
    assert.equal(byId[running].error.code, 'TASK_RUNNING');
    assert.ok(byId[running].error.message, '失败条必须带原因');

    assert.ok(taskRow(db, ok1).deleted_at, '成功条必须真的软删');
    assert.ok(taskRow(db, ok2).deleted_at, '成功条必须真的软删');
    assert.equal(taskRow(db, running).deleted_at, null, '失败条不许被删');
  });
});

test('A9b batch 支持 archive / restore，且与单条接口结果一致', async () => {
  await withApi(async ({ db, call }) => {
    const a = await createTask(call, 'A9b 归档 1');
    const b = await createTask(call, 'A9b 归档 2');
    const ar = await call('POST', '/api/tasks/batch', { action: 'archive', ids: [a, b], actor: 'test:batch' });
    assert.equal(ar.status, 200);
    assert.equal(ar.body.succeeded, 2);
    assert.ok(taskRow(db, a).archived_at && taskRow(db, b).archived_at);

    const rr = await call('POST', '/api/tasks/batch', { action: 'restore', ids: [a, b], actor: 'test:batch' });
    assert.equal(rr.status, 200);
    assert.equal(rr.body.succeeded, 2);
    assert.equal(taskRow(db, a).archived_at, null);
    assert.equal(taskRow(db, b).archived_at, null);
  });
});

// ---------------------------------------------------------------------------
// A10：归档/删除/恢复都写事件（谁、何时、什么操作）
// ---------------------------------------------------------------------------
test('A10 归档 / 删除 / 恢复各写一条 event：谁、何时、什么操作', async () => {
  await withApi(async ({ db, call }) => {
    const archivedId = await createTask(call, 'A10 归档事件');
    const deletedId = await createTask(call, 'A10 删除事件');
    const restoredId = await createTask(call, 'A10 恢复事件');

    const actor = 'test:audit';
    assert.equal((await call('POST', `/api/tasks/${archivedId}/archive`, { actor })).status, 200);
    assert.equal((await call('DELETE', `/api/tasks/${deletedId}`, { actor })).status, 200);
    assert.equal((await call('POST', `/api/tasks/${restoredId}/archive`, { actor })).status, 200);
    assert.equal((await call('POST', `/api/tasks/${restoredId}/restore`, { actor })).status, 200);

    const cases = [
      [archivedId, 'task_archived', 'archive'],
      [deletedId, 'task_deleted', 'delete'],
      [restoredId, 'task_restored', 'restore'],
    ];
    for (const [taskId, eventType, action] of cases) {
      const rows = eventsOf(db, taskId, eventType);
      assert.equal(rows.length, 1, `${taskId} 必须有一条 ${eventType}，实际 ${rows.length}`);
      const e = rows[0];
      assert.equal(e.agent_id, actor, '事件必须记录「谁」');
      assert.equal(e.evidence_source, 'user');
      assert.ok(Number.isFinite(Date.parse(e.observed_at)), '事件必须记录「何时」');
      const payload = JSON.parse(e.payload);
      assert.equal(payload.action, action, 'payload 必须记录「什么操作」');
      assert.equal(payload.actor, actor);
      assert.equal(payload.task_id, undefined, 'task_id 在事件列上，不重复塞 payload');
    }
  });
});
