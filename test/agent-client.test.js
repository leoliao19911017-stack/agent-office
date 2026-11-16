// Task 2.2 测试：AgentClient（Agent 侧 HTTP SDK）。
// 全部走真实 HTTP：起真服务（startServer({port:0}) + 内存库），不 mock 网络层。
// 编号 1–10 对应任务书验收清单。
//
// 时间相关口径：心跳间隔在测试里压到 50ms 级别，断言用"值变化 / 请求计数"
// 而不是精确时刻，避免定时器抖动造成的 flaky。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initializeDatabase, closeDatabase, insertTask, getTaskById } from '../src/db.js';
import { startServer } from '../src/server.js';
import { AgentClient } from '../src/agent-client.js';

const jsonHeaders = { 'content-type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 起一个随机端口 + 内存库的服务，返回 { db, base, stop() }（与 api.*.test.js 同款）。 */
async function startApi() {
  const db = initializeDatabase(':memory:');
  const server = startServer({ port: 0, db });
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address();
  return {
    db,
    base: `http://127.0.0.1:${port}`,
    async stop() {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      closeDatabase(db);
    },
  };
}

/** 给全局 fetch 打点（数请求、验"没发请求"用），用完必须 restore。 */
function instrumentFetch() {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET' });
    return orig(url, init);
  };
  return { calls, restore: () => (globalThis.fetch = orig) };
}

function makeClient(base, extra = {}) {
  return new AgentClient({
    baseUrl: base,
    name: 'test-agent',
    type: 'claude-code',
    capabilities: ['code'],
    ...extra,
  });
}

test('1. register() 成功；重复注册 409 不报错且复用同一 id', async () => {
  const api = await startApi();
  try {
    const client = makeClient(api.base);
    const id1 = await client.register();
    assert.ok(typeof id1 === 'string' && id1.length > 0, '注册应返回 agent id');
    const id2 = await client.register(); // 第二次：409 → 视为已注册
    assert.equal(id2, id1, '重复注册必须复用同名 Agent 的 id');
  } finally {
    await api.stop();
  }
});

test('2. claimNext() 领到任务，返回的任务含 claim_token', async () => {
  const api = await startApi();
  try {
    const client = makeClient(api.base);
    await client.register();
    const created = await fetch(`${api.base}/api/tasks`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ title: '写个文件' }),
    });
    const task = await created.json();
    const claimed = await client.claimNext();
    assert.ok(claimed, '应领到任务');
    assert.equal(claimed.id, task.id);
    assert.ok(typeof claimed.claim_token === 'string' && claimed.claim_token.length > 0);
  } finally {
    await api.stop();
  }
});

test('3. 没有 queued 任务时 claimNext() 返回 null', async () => {
  const api = await startApi();
  try {
    const client = makeClient(api.base);
    await client.register();
    assert.equal(await client.claimNext(), null);
  } finally {
    await api.stop();
  }
});

test('4. 任务被别的 Agent 抢先时，claimNext() 换下一个，不报错', async () => {
  const api = await startApi();
  try {
    // 建两个任务 A、B
    const ids = [];
    for (const title of ['任务A', '任务B']) {
      const res = await fetch(`${api.base}/api/tasks`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ title }),
      });
      ids.push((await res.json()).id);
    }
    // 另一个 Agent 先把 A 抢走（列表第一个是创建最新的 B？listTasks 按 created_at 倒序，
    // 所以列表顺序 B、A —— 逐个尝试时先撞 B 也能领走；要制造"撞 409 换下一个"，
    // 就让抢先者领走 B（列表第一个），客户端只能落到 A）
    const rival = makeClient(api.base, { name: 'rival-agent' });
    await rival.register();
    const got = await rival.claimNext();
    assert.equal(got.id, ids[1], '抢先者应领到列表第一个（B，最新创建）');

    const client = makeClient(api.base, { name: 'test-agent' });
    await client.register();
    const claimed = await client.claimNext(); // 撞 B 的 409 → 换 A
    assert.equal(claimed.id, ids[0], '被抢先之后应换到下一个任务 A');
  } finally {
    await api.stop();
  }
});

test('5. startHeartbeat() 后续约成功，lease_expires_at 变晚', async () => {
  const api = await startApi();
  try {
    await fetch(`${api.base}/api/tasks`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ title: '心跳' }),
    });
    const client = makeClient(api.base);
    await client.register();
    const task = await client.claimNext();
    const lease0 = getTaskById(api.db, task.id).lease_expires_at;

    client.startHeartbeat(50);
    await sleep(180); // 至少跳 2 次续约
    const lease1 = getTaskById(api.db, task.id).lease_expires_at;
    client.stopHeartbeat();

    assert.ok(lease1 > lease0, `续约后租约必须变晚：${lease0} → ${lease1}`);
    assert.ok(client.heartbeatHealthy(), '续约成功时心跳应健康');
  } finally {
    await api.stop();
  }
});

test('6. 心跳发现 token 失效 → lostOwnership 变 true 且触发 onLostOwnership 回调', async () => {
  const api = await startApi();
  try {
    await fetch(`${api.base}/api/tasks`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ title: '被接管' }),
    });
    const client = makeClient(api.base);
    await client.register();
    const task = await client.claimNext();

    const losses = [];
    client.onLostOwnership = (reason) => losses.push(reason);
    // 直接换掉库里的 token，模拟任务被 requeue 后别人接走（服务端会回 token_mismatch）
    api.db.run('UPDATE tasks SET claim_token = ? WHERE id = ?', ['taken-over-by-other', task.id]);

    client.startHeartbeat(50);
    await sleep(200); // 等下一跳撞上 409
    client.stopHeartbeat();

    assert.equal(client.lostOwnership, true, 'token 失效后 lostOwnership 必须为 true');
    assert.equal(client.lostReason, 'token_mismatch');
    assert.deepEqual(losses, ['token_mismatch'], 'onLostOwnership 应恰好触发一次并带 reason');
  } finally {
    await api.stop();
  }
});

test('7. 丢了所有权后 submit() 抛错，且不发任何 HTTP 请求', async () => {
  const api = await startApi();
  const probe = instrumentFetch();
  try {
    await fetch(`${api.base}/api/tasks`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ title: '丢所有权后提交' }),
    });
    const client = makeClient(api.base);
    await client.register();
    const task = await client.claimNext();

    // 模拟丢所有权：直接置状态（等价于心跳已发现 token 失效）
    api.db.run('UPDATE tasks SET claim_token = ? WHERE id = ?', ['taken-over-by-other', task.id]);
    client.onLostOwnership = () => {};
    client.startHeartbeat(30);
    await sleep(120); // 心跳发现失配 → lostOwnership = true
    client.stopHeartbeat();
    assert.equal(client.lostOwnership, true, '前置条件：已丢所有权');

    probe.calls.length = 0; // 从现在开始数请求
    await assert.rejects(() => client.submit('done', { resultPath: '/x/output.log' }), /所有权已丢失/);
    const statusCalls = probe.calls.filter((c) => c.url.includes('/status'));
    assert.equal(statusCalls.length, 0, '丢所有权后 submit 不许发任何状态请求');
    assert.equal(probe.calls.length, 0, '且不该有其他任何请求');
    const row = getTaskById(api.db, task.id);
    assert.notEqual(row.status, 'done', '任务状态不许被改动');
    assert.equal(row.result_path, null);
  } finally {
    probe.restore();
    await api.stop();
  }
});

test('8. reportEvent() 上报成功，事件落在该任务的事件流里', async () => {
  const api = await startApi();
  try {
    await fetch(`${api.base}/api/tasks`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ title: '事件' }),
    });
    const client = makeClient(api.base);
    await client.register();
    const task = await client.claimNext();

    const ev = await client.reportEvent('start', { note: '开始改文件' });
    assert.equal(ev.type, 'start');
    assert.equal(ev.task_id, task.id);
    assert.equal(ev.agent_id, client.agentId);

    const list = await fetch(`${api.base}/api/tasks/${task.id}/events`);
    const { events } = await list.json();
    assert.ok(events.some((e) => e.type === 'start' && e.payload.note === '开始改文件'));
  } finally {
    await api.stop();
  }
});

test('9. stopHeartbeat() 后不再续约', async () => {
  const api = await startApi();
  try {
    await fetch(`${api.base}/api/tasks`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ title: '停心跳' }),
    });
    const client = makeClient(api.base);
    await client.register();
    const task = await client.claimNext();

    client.startHeartbeat(50);
    await sleep(130);
    client.stopHeartbeat();
    await sleep(60); // 给可能残留的 in-flight 请求落地，之后读基线
    const leaseA = getTaskById(api.db, task.id).lease_expires_at;
    await sleep(200); // 原 interval 会跳 4 次的窗口
    const leaseB = getTaskById(api.db, task.id).lease_expires_at;
    assert.equal(leaseB, leaseA, '停心跳后租约不许再变');
  } finally {
    await api.stop();
  }
});

test('10. 心跳间隔可配置：50ms 间隔下真的按 50ms 节奏续约', async () => {
  const api = await startApi();
  const probe = instrumentFetch();
  try {
    await fetch(`${api.base}/api/tasks`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ title: '节奏' }),
    });
    const client = makeClient(api.base);
    await client.register();
    await client.claimNext();

    probe.calls.length = 0;
    client.startHeartbeat(50);
    await sleep(300); // 50ms 间隔理论上跳 ~5 次
    client.stopHeartbeat();

    const renews = probe.calls.filter((c) => c.url.includes('/renew'));
    // 下界 3：确认真在按短间隔反复续约；上界 8：留足定时器抖动余量
    assert.ok(
      renews.length >= 3 && renews.length <= 8,
      `300ms 内 50ms 间隔应续约 3-8 次，实际 ${renews.length}`,
    );
  } finally {
    probe.restore();
    await api.stop();
  }
});
