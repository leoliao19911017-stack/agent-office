// Task 1.3 HTTP API 测试：任务创建 / 原子领取（并发）/ 状态流转 / 列表筛选。
// 运行：npm test（node --test test/）
// 并发原子性是本文件的核心：10 个并发抢同一个任务，必须恰好 1 个成功、9 个 409。
// 服务一律 listen(0) 拿随机端口；库用内存 SQLite，每个测试独立一套。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initializeDatabase,
  closeDatabase,
  insertAgent,
  insertTask,
  claimTask,
  getTaskById,
} from '../src/db.js';
import { startServer } from '../src/server.js';

const jsonHeaders = { 'content-type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 起一个随机端口 + 内存库的服务，返回 { db, base, stop() }。 */
async function startApi() {
  const db = initializeDatabase(':memory:');
  const server = startServer({ port: 0, db });
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address();
  return {
    db,
    base: `http://127.0.0.1:${port}`,
    async stop() {
      server.closeAllConnections?.(); // fetch 的 keep-alive 连接不掐掉，close() 会一直挂着
      await new Promise((r) => server.close(r));
      closeDatabase(db);
    },
  };
}

async function registerAgent(base, name) {
  const res = await fetch(`${base}/api/agents/register`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ name }),
  });
  assert.equal(res.status, 201, `注册 agent ${name} 必须成功`);
  return res.json();
}

async function createTask(base, body) {
  return fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(body),
  });
}

async function claimViaApi(base, taskId, agentId) {
  return fetch(`${base}/api/tasks/${taskId}/claim`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ agent_id: agentId }),
  });
}

async function patchTaskStatus(base, taskId, body) {
  return fetch(`${base}/api/tasks/${taskId}/status`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify(body ?? {}),
  });
}

async function listTasksViaApi(base, query = '') {
  const res = await fetch(`${base}/api/tasks${query}`);
  assert.equal(res.status, 200);
  return (await res.json()).tasks;
}

// ---------------------------------------------------------------------------
// 基础功能
// ---------------------------------------------------------------------------

test('创建任务：201，字段完整，默认 status=queued', async () => {
  const api = await startApi();
  try {
    const agent = await registerAgent(api.base, 'worker');
    const res = await createTask(api.base, {
      title: '写登录页',
      description: '支持手机号+验证码',
      assignee: agent.id,
    });
    assert.equal(res.status, 201);
    const t = await res.json();
    assert.ok(typeof t.id === 'string' && t.id.length > 0, '应自动生成 id');
    assert.equal(t.title, '写登录页');
    assert.equal(t.description, '支持手机号+验证码');
    assert.equal(t.assignee, agent.id);
    assert.equal(t.status, 'queued', '新任务默认 queued');
    assert.equal(t.claimed_at, null);
    assert.equal(t.result_path, null);
    assert.equal(typeof t.created_at, 'number');

    // 不传 assignee → null（未指派）
    const bare = await (await createTask(api.base, { title: '无人认领' })).json();
    assert.equal(bare.assignee, null);
  } finally {
    await api.stop();
  }
});

test('缺 title / 空串 / 纯空白：400，不留脏数据', async () => {
  const api = await startApi();
  try {
    for (const body of [{}, { title: '' }, { title: '   ' }, { description: '没标题' }]) {
      const res = await createTask(api.base, body);
      assert.equal(res.status, 400, `body=${JSON.stringify(body)} 应 400`);
      const err = await res.json();
      assert.ok(err.error && err.code, '错误响应必须是 { error, code }');
    }
    assert.equal((await listTasksViaApi(api.base)).length, 0, '失败的创建不能留下数据');
  } finally {
    await api.stop();
  }
});

test('assignee 指向不存在的 agent：404，不落库', async () => {
  const api = await startApi();
  try {
    const res = await createTask(api.base, { title: '有主任务', assignee: 'no-such-agent' });
    assert.equal(res.status, 404);
    const err = await res.json();
    assert.ok(err.error && err.code);
    assert.equal((await listTasksViaApi(api.base)).length, 0, '不能留下悬空引用的任务');
  } finally {
    await api.stop();
  }
});

test('领取成功：200，status=claimed，assignee/claimed_at 正确', async () => {
  const api = await startApi();
  try {
    const agent = await registerAgent(api.base, 'claimer');
    const task = await (await createTask(api.base, { title: '可领任务' })).json();

    const res = await claimViaApi(api.base, task.id, agent.id);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.task.id, task.id);
    assert.equal(body.task.status, 'claimed');
    assert.equal(body.task.assignee, agent.id);
    assert.equal(typeof body.task.claimed_at, 'number', 'claimed_at 必须落值');
    assert.ok(body.task.claimed_at > 0);

    // 同一任务上：缺 agent_id 400；假 agent_id 404（不能让人拿假 id 领任务）
    const missing = await fetch(`${api.base}/api/tasks/${task.id}/claim`, {
      method: 'POST',
      headers: jsonHeaders,
      body: '{}',
    });
    assert.equal(missing.status, 400);
    const fake = await claimViaApi(api.base, task.id, 'ghost-agent-id');
    assert.equal(fake.status, 404);
  } finally {
    await api.stop();
  }
});

test('领取已被领走的任务：409，reason=not_queued', async () => {
  const api = await startApi();
  try {
    const a1 = await registerAgent(api.base, 'first');
    const a2 = await registerAgent(api.base, 'second');
    const task = await (await createTask(api.base, { title: '手快有手慢无' })).json();

    assert.equal((await claimViaApi(api.base, task.id, a1.id)).status, 200);
    const res = await claimViaApi(api.base, task.id, a2.id);
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { ok: false, reason: 'not_queued' });
  } finally {
    await api.stop();
  }
});

test('领取不存在的任务：404', async () => {
  const api = await startApi();
  try {
    const agent = await registerAgent(api.base, 'who');
    const res = await claimViaApi(api.base, 'no-such-task', agent.id);
    assert.equal(res.status, 404);
    const err = await res.json();
    assert.ok(err.error && err.code);
  } finally {
    await api.stop();
  }
});

test('GET /api/tasks?status=queued：只返回 queued 的', async () => {
  const api = await startApi();
  try {
    const agent = await registerAgent(api.base, 'filter');
    const kept1 = await (await createTask(api.base, { title: '排队1' })).json();
    const claimed = await (await createTask(api.base, { title: '被领走' })).json();
    const kept2 = await (await createTask(api.base, { title: '排队2' })).json();
    assert.equal((await claimViaApi(api.base, claimed.id, agent.id)).status, 200);

    const queued = await listTasksViaApi(api.base, '?status=queued');
    assert.equal(queued.length, 2);
    assert.ok(queued.every((t) => t.status === 'queued'));
    assert.deepEqual(
      queued.map((t) => t.title),
      ['排队2', '排队1'], // created_at 倒序，新的在前
    );

    // 不带筛选返回全部
    assert.equal((await listTasksViaApi(api.base)).length, 3);
    assert.ok(kept1 && kept2); // 两个排队任务的引用确实存在（防拼写错变量名）
  } finally {
    await api.stop();
  }
});

// ---------------------------------------------------------------------------
// 并发原子性（本任务的核心验收）
// ---------------------------------------------------------------------------

test('并发（HTTP）：10 个并发领取同一任务，恰好 1 个成功、9 个 409', async () => {
  const api = await startApi();
  try {
    const agentIds = [];
    for (let i = 0; i < 10; i++) agentIds.push((await registerAgent(api.base, `racer-${i}`)).id);
    const task = await (await createTask(api.base, { title: '抢椅子，10 人 1 椅' })).json();

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        fetch(`${api.base}/api/tasks/${task.id}/claim`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agent_id: agentIds[i] }),
        }).then(async (r) => ({ status: r.status, body: await r.json() })),
      ),
    );

    const wins = results.filter((r) => r.status === 200);
    const loses = results.filter((r) => r.status === 409);
    assert.equal(wins.length, 1, `期望 1 个成功，实际 ${wins.length} 个`);
    assert.equal(loses.length, 9, `期望 9 个 409，实际 ${loses.length} 个`);
    assert.ok(
      loses.every((r) => r.body.ok === false && r.body.reason === 'not_queued'),
      '输家的响应体必须是 { ok:false, reason:"not_queued" }',
    );
    // 赢家必须是真实存在的 agent，且任务行最终只认这一个
    assert.ok(agentIds.includes(wins[0].body.task.assignee));
    const finalRow = getTaskById(api.db, task.id);
    assert.equal(finalRow.status, 'claimed');
    assert.equal(finalRow.assignee, wins[0].body.task.assignee);
  } finally {
    await api.stop();
  }
});

test('并发（DB 层）：10 个并发 claimTask()，恰好 1 个 ok:true', async () => {
  const db = initializeDatabase(':memory:');
  try {
    const agentIds = Array.from({ length: 10 }, (_, i) =>
      insertAgent(db, { name: `db-racer-${i}` }).id,
    );
    const task = insertTask(db, { title: 'DB 层并发抢占' });

    // 每个"工人"先随机抖动再出手，模拟同时抢；驱动虽是同步串行，判定全靠 WHERE 条件
    const results = await Promise.all(
      agentIds.map(async (agentId) => {
        await sleep(Math.floor(Math.random() * 5));
        return claimTask(db, task.id, agentId);
      }),
    );

    const wins = results.filter((r) => r.ok === true);
    const loses = results.filter((r) => r.ok === false);
    assert.equal(wins.length, 1, `期望 1 个 ok:true，实际 ${wins.length} 个`);
    assert.equal(loses.length, 9);
    assert.ok(loses.every((r) => r.reason === 'not_queued'));
    // 落库结果与赢家一致
    const finalRow = getTaskById(db, task.id);
    assert.equal(finalRow.status, 'claimed');
    assert.equal(finalRow.assignee, wins[0].task.assignee);
  } finally {
    closeDatabase(db);
  }
});

test('串行重复领取：第二次必须失败', async () => {
  const api = await startApi();
  try {
    const a1 = await registerAgent(api.base, 'serial-1');
    const a2 = await registerAgent(api.base, 'serial-2');
    const task = await (await createTask(api.base, { title: '串行抢占' })).json();

    const first = await claimViaApi(api.base, task.id, a1.id);
    assert.equal(first.status, 200);
    // 同一个 agent 再领自己已领的、换人领已领的，都必须失败
    assert.equal((await claimViaApi(api.base, task.id, a1.id)).status, 409);
    assert.equal((await claimViaApi(api.base, task.id, a2.id)).status, 409);
  } finally {
    await api.stop();
  }
});

// ---------------------------------------------------------------------------
// 状态流转
// ---------------------------------------------------------------------------

test('状态流转：claimed → running → done，result_path 正确落库', async () => {
  const api = await startApi();
  try {
    const agent = await registerAgent(api.base, 'runner');
    const task = await (await createTask(api.base, { title: '全流程' })).json();
    assert.equal((await claimViaApi(api.base, task.id, agent.id)).status, 200);

    const running = await patchTaskStatus(api.base, task.id, { status: 'running' });
    assert.equal(running.status, 200);
    assert.equal((await running.json()).status, 'running');

    const done = await patchTaskStatus(api.base, task.id, {
      status: 'done',
      result_path: '/path/to/result.json',
    });
    assert.equal(done.status, 200);
    const doneRow = await done.json();
    assert.equal(doneRow.status, 'done');
    assert.equal(doneRow.result_path, '/path/to/result.json');

    // 落库验证：重新查列表，不是只看响应
    const stored = (await listTasksViaApi(api.base, '?status=done')).find((t) => t.id === task.id);
    assert.ok(stored, 'done 状态应能按筛选查到');
    assert.equal(stored.result_path, '/path/to/result.json');
  } finally {
    await api.stop();
  }
});

test('非法状态（含缺失）：400；不存在的任务：404', async () => {
  const api = await startApi();
  try {
    const task = await (await createTask(api.base, { title: '状态守门' })).json();
    for (const body of [{ status: 'sleeping' }, {}, { status: 'DONE' }]) {
      const res = await patchTaskStatus(api.base, task.id, body);
      assert.equal(res.status, 400, `body=${JSON.stringify(body)} 应 400`);
      const err = await res.json();
      assert.ok(err.error && err.code);
    }
    const notFound = await patchTaskStatus(api.base, 'no-such-task', { status: 'done' });
    assert.equal(notFound.status, 404);

    // 筛选参数传非法状态同样 400（防拼写错误静默返回空列表）
    const badFilter = await fetch(`${api.base}/api/tasks?status=bogus`);
    assert.equal(badFilter.status, 400);
  } finally {
    await api.stop();
  }
});
