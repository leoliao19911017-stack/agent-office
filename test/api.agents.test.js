// Task 1.2 HTTP API 测试：Agent 注册 / 状态更新（心跳刷新）/ 列表与 stale 判定。
// 运行：npm test（node --test test/）
// 服务一律 listen(0) 拿随机端口（不写死，防撞）；库用内存 SQLite，每个测试独立一套。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initializeDatabase, closeDatabase, insertAgent } from '../src/db.js';
import { startServer } from '../src/server.js';

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

async function register(base, body) {
  return fetch(`${base}/api/agents/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function patchStatus(base, id, body) {
  return fetch(`${base}/api/agents/${id}/status`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

async function listAgentsViaApi(base) {
  const res = await fetch(`${base}/api/agents`);
  assert.equal(res.status, 200);
  return (await res.json()).agents;
}

test('注册成功：201，字段完整', async () => {
  const api = await startApi();
  try {
    const res = await register(api.base, {
      name: 'Claude Code',
      type: 'claude-code',
      capabilities: ['code', 'review'],
    });
    assert.equal(res.status, 201);
    const a = await res.json();
    assert.ok(typeof a.id === 'string' && a.id.length > 0, '应自动生成 id');
    assert.equal(a.name, 'Claude Code');
    assert.equal(a.type, 'claude-code');
    assert.equal(a.status, 'idle', '新注册默认 idle');
    assert.equal(typeof a.last_heartbeat, 'number', '注册即首次心跳');
    assert.deepEqual(a.capabilities, ['code', 'review'], 'capabilities 应还原为数组');
    assert.equal(typeof a.created_at, 'number');
  } finally {
    await api.stop();
  }
});

test('重名注册：409，且不覆盖原 Agent', async () => {
  const api = await startApi();
  try {
    const first = await (await register(api.base, { name: 'lemate' })).json();
    const res = await register(api.base, { name: 'lemate', type: 'impostor' });
    assert.equal(res.status, 409);
    const err = await res.json();
    assert.ok(typeof err.error === 'string' && typeof err.code === 'string', '错误响应须含 error + code');

    const agents = await listAgentsViaApi(api.base);
    assert.equal(agents.length, 1, '重名注册不能多出一行');
    assert.equal(agents[0].id, first.id);
    assert.equal(agents[0].type, 'unknown', '原 Agent 不被动过（首次注册没传 type）');
  } finally {
    await api.stop();
  }
});

test('缺 name 或空串：400，不留脏数据', async () => {
  const api = await startApi();
  try {
    for (const body of [{}, { name: '' }, { name: '   ' }, { type: 'x' }]) {
      const res = await register(api.base, body);
      assert.equal(res.status, 400, `body=${JSON.stringify(body)} 应 400`);
      const err = await res.json();
      assert.ok(err.error && err.code, '错误响应必须是 { error, code }');
    }
    const agents = await listAgentsViaApi(api.base);
    assert.equal(agents.length, 0, '失败的注册不能留下数据');
  } finally {
    await api.stop();
  }
});

test('更新状态：200，last_heartbeat 刷新（断言前后值不同）', async () => {
  const api = await startApi();
  try {
    const reg = await (await register(api.base, { name: 'worker' })).json();
    const before = reg.last_heartbeat;
    while (Date.now() === before) await sleep(1); // 保证时钟至少走过 1ms，"变新"断言才有意义
    const res = await patchStatus(api.base, reg.id, { status: 'working' });
    assert.equal(res.status, 200);
    const a = await res.json();
    assert.equal(a.id, reg.id);
    assert.equal(a.status, 'working');
    assert.ok(a.last_heartbeat > before, `心跳应刷新：${before} -> ${a.last_heartbeat}`);
  } finally {
    await api.stop();
  }
});

test('非法状态（含缺失）：400', async () => {
  const api = await startApi();
  try {
    const reg = await (await register(api.base, { name: 'w' })).json();
    for (const status of ['sleeping', undefined]) {
      const res = await patchStatus(api.base, reg.id, status === undefined ? {} : { status });
      assert.equal(res.status, 400, `status=${JSON.stringify(status)} 应 400`);
      const err = await res.json();
      assert.ok(err.error && err.code);
    }
  } finally {
    await api.stop();
  }
});

test('更新不存在的 Agent：404', async () => {
  const api = await startApi();
  try {
    const res = await patchStatus(api.base, 'no-such-id', { status: 'idle' });
    assert.equal(res.status, 404);
    const err = await res.json();
    assert.ok(err.error && err.code);
  } finally {
    await api.stop();
  }
});

test('GET /api/agents：返回 { agents: [...] }，按注册序', async () => {
  const api = await startApi();
  try {
    await register(api.base, { name: 'alpha' });
    await register(api.base, { name: 'beta' });
    const agents = await listAgentsViaApi(api.base);
    assert.ok(Array.isArray(agents));
    assert.deepEqual(agents.map((a) => a.name), ['alpha', 'beta']);
    assert.ok('stale' in agents[0], '列表项必须带 stale 字段');
  } finally {
    await api.stop();
  }
});

test('刚注册的 Agent：stale 为 false', async () => {
  const api = await startApi();
  try {
    const reg = await (await register(api.base, { name: 'fresh' })).json();
    const agents = await listAgentsViaApi(api.base);
    assert.equal(agents.find((a) => a.id === reg.id).stale, false);
  } finally {
    await api.stop();
  }
});

test('超时判定真实生效：STALE_MS=1，等 15ms 后 stale 为 true', async () => {
  const api = await startApi();
  process.env.STALE_MS = '1';
  try {
    const reg = await (await register(api.base, { name: 'gone-quiet' })).json();
    assert.equal(reg.last_heartbeat > 0, true);
    await sleep(15); // 心跳后 15ms，远超 1ms 阈值
    const agents = await listAgentsViaApi(api.base);
    assert.equal(agents.find((a) => a.id === reg.id).stale, true);
  } finally {
    delete process.env.STALE_MS; // 必须还原，别污染后续测试
    await api.stop();
  }
});

test('last_heartbeat 为 null 的 Agent：stale 为 true', async () => {
  const api = await startApi();
  try {
    // 注册接口总会写心跳，null 只能来自库层直插（模拟从未心跳的 Agent）
    insertAgent(api.db, { name: 'ghost' });
    const agents = await listAgentsViaApi(api.base);
    assert.equal(agents.find((a) => a.name === 'ghost').stale, true);
  } finally {
    await api.stop();
  }
});

test('错误响应统一形状：未知路由 404、非法 JSON 400，均为 { error, code }', async () => {
  const api = await startApi();
  try {
    const notFound = await fetch(`${api.base}/api/nope`);
    assert.equal(notFound.status, 404);
    assert.deepEqual(Object.keys(await notFound.json()).sort(), ['code', 'error']);

    const badJson = await fetch(`${api.base}/api/agents/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json{',
    });
    assert.equal(badJson.status, 400);
    assert.deepEqual(Object.keys(await badJson.json()).sort(), ['code', 'error']);
  } finally {
    await api.stop();
  }
});
