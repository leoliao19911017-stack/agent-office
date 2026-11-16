// Task 1.4 HTTP API 测试：事件上报 / 任务事件流（升序）/ 最近事件（倒序）/ limit 截断 / 中文嵌套 payload 往返。
// 运行：npm test（node --test test/）
// 核心口径：payload 落库是 JSON 字符串，吐出必须是对象；事件流按时间升序（看顺序），
// 最近事件按时间倒序；limit 默认 100 / 50、最大 1000（超过静默截断，不报错）。
// 服务一律 listen(0) 拿随机端口；库用内存 SQLite，每个测试独立一套。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initializeDatabase,
  closeDatabase,
  insertTask,
  insertEvent,
  listEventsByTask,
  listRecentEvents,
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

async function createTask(base, title) {
  const res = await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ title }),
  });
  assert.equal(res.status, 201, `建任务 ${title} 必须成功`);
  return res.json();
}

async function postEvent(base, body) {
  return fetch(`${base}/api/events`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(body),
  });
}

/** 上报并断言 201，返回事件行（payload 已是对象）。 */
async function postEventOk(base, body) {
  const res = await postEvent(base, body);
  assert.equal(res.status, 201, `上报事件必须成功：${JSON.stringify(body)}`);
  return res.json();
}

async function listTaskEvents(base, taskId, query = '') {
  const res = await fetch(`${base}/api/tasks/${taskId}/events${query}`);
  assert.equal(res.status, 200);
  return (await res.json()).events;
}

// ---------------------------------------------------------------------------
// 上报（POST /api/events）
// ---------------------------------------------------------------------------

test('上报事件：201，字段完整，payload 返回是对象不是字符串', async () => {
  const api = await startApi();
  try {
    const agent = await registerAgent(api.base, 'worker');
    const task = await createTask(api.base, '写登录页');
    const ev = await postEventOk(api.base, {
      task_id: task.id,
      agent_id: agent.id,
      type: 'step',
      payload: { message: '正在写登录页' },
    });

    assert.equal(typeof ev.id, 'number', '自增 id 必须是数字');
    assert.equal(ev.task_id, task.id);
    assert.equal(ev.agent_id, agent.id);
    assert.equal(ev.type, 'step');
    assert.equal(typeof ev.created_at, 'number');
    // 关键：吐出去必须是对象，不许把库里的 JSON 字符串直接返回
    assert.equal(typeof ev.payload, 'object', 'payload 必须是对象');
    assert.notEqual(ev.payload, null);
    assert.deepEqual(ev.payload, { message: '正在写登录页' });
  } finally {
    await api.stop();
  }
});

test('非法 type（含缺失、大小写敏感）：400，不留脏数据', async () => {
  const api = await startApi();
  try {
    for (const body of [{ type: 'boom' }, { type: 'STEP' }, { payload: {} }, {}]) {
      const res = await postEvent(api.base, body);
      assert.equal(res.status, 400, `body=${JSON.stringify(body)} 应 400`);
      const err = await res.json();
      assert.ok(err.error && err.code, '错误响应必须是 { error, code }');
    }
    const all = await (await fetch(`${api.base}/api/events`)).json();
    assert.equal(all.events.length, 0, '失败的上报不能留下数据');
  } finally {
    await api.stop();
  }
});

test('task_id 指向不存在的任务：404，不落库', async () => {
  const api = await startApi();
  try {
    const res = await postEvent(api.base, { task_id: 'no-such-task', type: 'note' });
    assert.equal(res.status, 404);
    const err = await res.json();
    assert.ok(err.error && err.code);
    const all = await (await fetch(`${api.base}/api/events`)).json();
    assert.equal(all.events.length, 0, '不能留下悬空引用的事件');
  } finally {
    await api.stop();
  }
});

test('agent_id 指向不存在的 agent：404，不落库', async () => {
  const api = await startApi();
  try {
    const task = await createTask(api.base, '有事件的 任务');
    const res = await postEvent(api.base, { task_id: task.id, agent_id: 'ghost-agent', type: 'start' });
    assert.equal(res.status, 404);
    const err = await res.json();
    assert.ok(err.error && err.code);
    const all = await (await fetch(`${api.base}/api/events`)).json();
    assert.equal(all.events.length, 0);
  } finally {
    await api.stop();
  }
});

test('task_id / agent_id 都为 null 或省略：201（系统级事件）', async () => {
  const api = await startApi();
  try {
    const explicit = await postEventOk(api.base, {
      task_id: null,
      agent_id: null,
      type: 'note',
      payload: { message: '系统启动' },
    });
    assert.equal(explicit.task_id, null);
    assert.equal(explicit.agent_id, null);
    assert.deepEqual(explicit.payload, { message: '系统启动' });

    // 完全省略也等价于 null
    const omitted = await postEventOk(api.base, { type: 'note' });
    assert.equal(omitted.task_id, null);
    assert.equal(omitted.agent_id, null);
    assert.deepEqual(omitted.payload, {}, 'payload 缺省必须是 {}（对象）');
  } finally {
    await api.stop();
  }
});

// ---------------------------------------------------------------------------
// 查询（GET /api/tasks/:id/events、GET /api/events）
// ---------------------------------------------------------------------------

test('任务事件流：按时间升序，只含该任务的事件', async () => {
  const api = await startApi();
  try {
    const agent = await registerAgent(api.base, 'ordered');
    const mine = await createTask(api.base, '我的任务');
    const other = await createTask(api.base, '别人的任务');

    // 逐条上报并隔 2ms，保证 created_at 严格递增（真正测时间序，不靠 rowid 兜底）
    for (let i = 1; i <= 4; i++) {
      await postEventOk(api.base, {
        task_id: mine.id,
        agent_id: agent.id,
        type: 'step',
        payload: { seq: i },
      });
      await sleep(2);
    }
    // 别的任务的事件不许混进来
    await postEventOk(api.base, { task_id: other.id, type: 'note', payload: { seq: 999 } });

    const events = await listTaskEvents(api.base, mine.id);
    assert.equal(events.length, 4);
    assert.deepEqual(
      events.map((e) => e.payload.seq),
      [1, 2, 3, 4],
      '事件流必须按时间升序（看顺序）',
    );
    assert.ok(events.every((e) => e.task_id === mine.id), '只能含本任务事件');
    assert.ok(events.every((e) => typeof e.payload === 'object'), '列表里 payload 也必须是对象');
  } finally {
    await api.stop();
  }
});

test('limit 参数生效：发 10 条，?limit=3 只返回最早的 3 条', async () => {
  const api = await startApi();
  try {
    const task = await createTask(api.base, '限流任务');
    for (let i = 1; i <= 10; i++) {
      await postEventOk(api.base, { task_id: task.id, type: 'step', payload: { seq: i } });
      await sleep(2);
    }
    const events = await listTaskEvents(api.base, task.id, '?limit=3');
    assert.equal(events.length, 3, '?limit=3 必须只返回 3 条');
    assert.deepEqual(
      events.map((e) => e.payload.seq),
      [1, 2, 3],
      '升序 + limit 取的是最早的 3 条',
    );
  } finally {
    await api.stop();
  }
});

test('查不存在的任务的事件流：404', async () => {
  const api = await startApi();
  try {
    const res = await fetch(`${api.base}/api/tasks/no-such-task/events`);
    assert.equal(res.status, 404);
    const err = await res.json();
    assert.ok(err.error && err.code);
  } finally {
    await api.stop();
  }
});

test('payload 中文与嵌套对象往返无损', async () => {
  const api = await startApi();
  try {
    const task = await createTask(api.base, '中文往返');
    const payload = { a: { b: [1, 2, '三'] }, 说明: '中文不丢', 嵌套: { 深层: { 值: null } } };

    const created = await postEventOk(api.base, { task_id: task.id, type: 'note', payload });
    assert.deepEqual(created.payload, payload, '创建响应的 payload 必须无损');

    const events = await listTaskEvents(api.base, task.id);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].payload, payload, '存进去再查出来必须一样（含中文与嵌套）');
    assert.equal(events[0].payload.a.b[2], '三', '数组里的中文不丢');
  } finally {
    await api.stop();
  }
});

test('GET /api/events：全量最近事件，按时间倒序', async () => {
  const api = await startApi();
  try {
    const task = await createTask(api.base, '最近事件');
    for (let i = 1; i <= 4; i++) {
      await postEventOk(api.base, { task_id: task.id, type: 'step', payload: { seq: i } });
      await sleep(2);
    }
    // 系统级事件（无 task_id）也要出现在全量列表里
    await postEventOk(api.base, { type: 'note', payload: { seq: 5 } });
    await sleep(2);

    const res = await fetch(`${api.base}/api/events`);
    assert.equal(res.status, 200);
    const { events } = await res.json();
    assert.equal(events.length, 5);
    assert.deepEqual(
      events.map((e) => e.payload.seq),
      [5, 4, 3, 2, 1],
      '最近事件必须按时间倒序（新的在前）',
    );
    assert.ok(events.every((e) => typeof e.payload === 'object'));
  } finally {
    await api.stop();
  }
});

// ---------------------------------------------------------------------------
// 完整流程与 limit 上限
// ---------------------------------------------------------------------------

test('完整流程：建任务 → 领取 → 上报 start/step/end → 事件流顺序正确', async () => {
  const api = await startApi();
  try {
    const agent = await registerAgent(api.base, 'runner');
    const task = await createTask(api.base, '全流程任务');

    const claimRes = await fetch(`${api.base}/api/tasks/${task.id}/claim`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ agent_id: agent.id }),
    });
    assert.equal(claimRes.status, 200);

    const script = [
      { type: 'start', payload: { message: '开工' } },
      { type: 'step', payload: { message: '写登录页' } },
      { type: 'end', payload: { message: '交付', result_path: '/out/login.html' } },
    ];
    for (const ev of script) {
      await postEventOk(api.base, { task_id: task.id, agent_id: agent.id, ...ev });
      await sleep(2);
    }

    const events = await listTaskEvents(api.base, task.id);
    assert.deepEqual(
      events.map((e) => e.type),
      ['start', 'step', 'end'],
      '事件流必须与上报顺序一致',
    );
    assert.equal(events[2].payload.result_path, '/out/login.html', 'end 事件的产物路径往返无损');
    assert.ok(events.every((e) => e.agent_id === agent.id));
  } finally {
    await api.stop();
  }
});

test('limit 超过 1000 被静默截到 1000（DB 层与 HTTP 层都不报错）', async () => {
  const api = await startApi();
  try {
    const task = insertTask(api.db, { title: '压测任务' });
    // 直接走 DB 层灌 1005 条（快），HTTP 层只验证查询截断
    for (let i = 0; i < 1005; i++) {
      insertEvent(api.db, { task_id: task.id, type: 'step', payload: { seq: i } });
    }

    // DB 层：两个查询都截到 1000
    assert.equal(listEventsByTask(api.db, task.id, { limit: 5000 }).length, 1000);
    assert.equal(listRecentEvents(api.db, { limit: 9999 }).length, 1000);

    // HTTP 层：?limit=2000 同样静默截断，不报错
    const viaHttp = await listTaskEvents(api.base, task.id, '?limit=2000');
    assert.equal(viaHttp.length, 1000);
    // 升序截断取的是最早 1000 条（seq 0..999），不是尾部
    assert.equal(viaHttp[0].payload.seq, 0);
    assert.equal(viaHttp[999].payload.seq, 999);
  } finally {
    await api.stop();
  }
});
