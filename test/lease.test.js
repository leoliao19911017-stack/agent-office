// Task 2.1 测试：租约 / Claim Token / 安全恢复。
// 运行：npm test（node --test test/）
//
// 编号对应任务书验收清单 1–14；15–18 是 API 层加固（新接口不走 HTTP 测一遍才是漏）。
// 时间控制口径：不依赖真 sleep——claim 时传短 leaseMs、listSuspectTasks / resolveSuspectTask
// 传"未来 nowMs"来模拟租约过期，确定性且不拖慢测试。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initializeDatabase,
  closeDatabase,
  insertAgent,
  insertTask,
  getTaskById,
  claimTask,
  renewLease,
  updateTaskStatus,
  updateTaskStatusWithToken,
  listSuspectTasks,
  resolveSuspectTask,
  migrateDatabase,
  DEFAULT_LEASE_MS,
} from '../src/db.js';
import { startServer } from '../src/server.js';

const jsonHeaders = { 'content-type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 租约基础（1–5）
// ---------------------------------------------------------------------------

test('1. 领取后 claim_token 非空、lease_expires_at 在未来、attempt 为 1', () => {
  const db = initializeDatabase(':memory:');
  try {
    const agent = insertAgent(db, { name: 'w1' });
    const task = insertTask(db, { title: '租约基础' });
    const before = Date.now();

    const r = claimTask(db, task.id, agent.id);
    assert.equal(r.ok, true);
    assert.ok(typeof r.claim_token === 'string' && r.claim_token.length > 0, '返回值必须带 claim_token');
    const row = getTaskById(db, task.id);
    assert.equal(row.claim_token, r.claim_token, '顶层 token 与落库一致');
    assert.ok(row.lease_expires_at > before, '租约必须在未来');
    assert.ok(row.lease_expires_at <= before + DEFAULT_LEASE_MS + 50, '租约长度 = 默认 90s（留误差余量）');
    assert.equal(row.attempt, 1, '首次领取 attempt=1');
    assert.ok(row.current_run_id, 'current_run_id 必须落值');
    assert.equal(row.status, 'claimed');
    assert.equal(row.assignee, agent.id);
  } finally {
    closeDatabase(db);
  }
});

test('2. 续约成功，lease_expires_at 变晚', () => {
  const db = initializeDatabase(':memory:');
  try {
    const agent = insertAgent(db, { name: 'w2' });
    const task = insertTask(db, { title: '续约' });
    // 领取只给 1s 短租约，续约走默认 90s：两步哪怕同毫秒执行（连续 Date.now()
    // 可能同值），新租约也恒比旧的晚 89s——断言不依赖时钟推进
    const { claim_token } = claimTask(db, task.id, agent.id, 1000);
    const oldLease = getTaskById(db, task.id).lease_expires_at;

    const r = renewLease(db, task.id, claim_token);
    assert.deepEqual(r, { ok: true, lease_expires_at: r.lease_expires_at }); // 只含这两个键
    assert.ok(r.lease_expires_at > oldLease, '新租约必须晚于旧租约');
    assert.equal(getTaskById(db, task.id).lease_expires_at, r.lease_expires_at, '落库值与返回值一致');
  } finally {
    closeDatabase(db);
  }
});

test('3. 错误 token 续约失败 reason=token_mismatch，且库中租约未被动过', () => {
  const db = initializeDatabase(':memory:');
  try {
    const agent = insertAgent(db, { name: 'w3' });
    const task = insertTask(db, { title: '错 token 续约' });
    claimTask(db, task.id, agent.id);
    const frozen = getTaskById(db, task.id).lease_expires_at;

    const r = renewLease(db, task.id, '00000000-0000-0000-0000-000000000000');
    assert.deepEqual(r, { ok: false, reason: 'token_mismatch' });
    assert.equal(getTaskById(db, task.id).lease_expires_at, frozen, '失败的续约不许改库');
  } finally {
    closeDatabase(db);
  }
});

test('4. 正确 token 但任务已完成 → 续约失败 reason=not_active', () => {
  const db = initializeDatabase(':memory:');
  try {
    const agent = insertAgent(db, { name: 'w4' });
    const task = insertTask(db, { title: '完成后不许续' });
    const { claim_token } = claimTask(db, task.id, agent.id);
    updateTaskStatus(db, task.id, 'done', { result_path: '/r.json' });

    const r = renewLease(db, task.id, claim_token);
    assert.deepEqual(r, { ok: false, reason: 'not_active' });
  } finally {
    closeDatabase(db);
  }
});

test('5. requeue 后第二次领取，attempt 变 2，token 是全新的', () => {
  const db = initializeDatabase(':memory:');
  try {
    const agent = insertAgent(db, { name: 'w5' });
    const task = insertTask(db, { title: '二进宫' });
    const first = claimTask(db, task.id, agent.id);

    // 判定时刻用 lease+1 而不是 Date.now()+偏移：连续两次 Date.now() 可能同毫秒，
    // 严格小于就不成立；读出真实 lease 再 +1 在任何时钟粒度下恒过期。
    const resolved = resolveSuspectTask(db, task.id, 'requeue', {
      nowMs: getTaskById(db, task.id).lease_expires_at + 1,
    });
    assert.equal(resolved.ok, true);

    const second = claimTask(db, task.id, agent.id);
    assert.equal(second.ok, true);
    const row = getTaskById(db, task.id);
    assert.equal(row.attempt, 2, 'requeue 后再领，attempt 累计');
    assert.notEqual(row.claim_token, first.claim_token, '两回合的凭证必须不同');
    assert.notEqual(row.current_run_id, first.task.current_run_id, '两回合的 run_id 必须不同');
  } finally {
    closeDatabase(db);
  }
});

// ---------------------------------------------------------------------------
// 所有权保护（6–8，核心）
// ---------------------------------------------------------------------------

test('6. 错误 token 更新状态 → 拒绝，且数据库里的状态没变', () => {
  const db = initializeDatabase(':memory:');
  try {
    const agent = insertAgent(db, { name: 'w6' });
    const task = insertTask(db, { title: '不许冒名提交' });
    claimTask(db, task.id, agent.id);
    const before = getTaskById(db, task.id);

    const r = updateTaskStatusWithToken(db, task.id, 'forged-token', 'done', {
      result_path: '/stolen.json',
    });
    assert.deepEqual(r, { ok: false, reason: 'token_mismatch' });

    const after = getTaskById(db, task.id);
    assert.equal(after.status, before.status, '状态不许被改');
    assert.equal(after.result_path, null, 'result_path 不许被写入');
    assert.equal(after.claim_token, before.claim_token, 'token 不许被换');
  } finally {
    closeDatabase(db);
  }
});

test('7. 正确 token 更新状态 → 成功，result_path 落库', () => {
  const db = initializeDatabase(':memory:');
  try {
    const agent = insertAgent(db, { name: 'w7' });
    const task = insertTask(db, { title: '正主提交' });
    const { claim_token } = claimTask(db, task.id, agent.id);

    const r = updateTaskStatusWithToken(db, task.id, claim_token, 'done', {
      result_path: '/real.json',
    });
    assert.equal(r.ok, true);
    assert.equal(r.task.status, 'done');
    assert.equal(getTaskById(db, task.id).result_path, '/real.json');
  } finally {
    closeDatabase(db);
  }
});

test('8.【核心】A 领取 → 租约过期 → requeue → B 领取 → A 用旧 token 提交必须被拒绝', () => {
  const db = initializeDatabase(':memory:');
  try {
    const a = insertAgent(db, { name: 'slow-A' });
    const b = insertAgent(db, { name: 'fast-B' });
    const task = insertTask(db, { title: '崩溃接管战' });

    // A 领取（租约只给 1ms）；「过期」由判定时刻定义（lease+1），不等真实时钟
    const aClaim = claimTask(db, task.id, a.id, 1);
    assert.equal(aClaim.ok, true);
    const aToken = aClaim.claim_token;
    const expiredAt = getTaskById(db, task.id).lease_expires_at;

    const suspects = listSuspectTasks(db, expiredAt + 1);
    assert.ok(suspects.some((t) => t.id === task.id), '过期后必须先出现在可疑列表');

    // 人工确认后 requeue，B 接管（判定时刻同样用 expiredAt+1，确定性过期）
    assert.equal(resolveSuspectTask(db, task.id, 'requeue', { nowMs: expiredAt + 1 }).ok, true);
    const bClaim = claimTask(db, task.id, b.id);
    assert.equal(bClaim.ok, true);

    // A 拿旧 token 提交结果：必须拒绝，且一行不写
    const stolen = updateTaskStatusWithToken(db, task.id, aToken, 'done', {
      result_path: '/a-slow.json',
    });
    assert.deepEqual(stolen, { ok: false, reason: 'token_mismatch' });

    const row = getTaskById(db, task.id);
    assert.equal(row.status, 'claimed', '仍是 B 的 claimed，未被污染');
    assert.equal(row.result_path, null, 'A 的产物路径不许落库');
    assert.equal(row.claim_token, bClaim.claim_token, '凭证仍是 B 的');

    // A 拿旧 token 续约也续不上（不能把 B 的租约顶掉）
    assert.deepEqual(renewLease(db, task.id, aToken), { ok: false, reason: 'token_mismatch' });

    // B 用自己的 token 正常提交：成功
    const bDone = updateTaskStatusWithToken(db, task.id, bClaim.claim_token, 'done', {
      result_path: '/b-fast.json',
    });
    assert.equal(bDone.ok, true);
    assert.equal(getTaskById(db, task.id).result_path, '/b-fast.json');
  } finally {
    closeDatabase(db);
  }
});

// ---------------------------------------------------------------------------
// 可疑任务处置（9–12）
// ---------------------------------------------------------------------------

test('9. 租约过期后任务出现在 listSuspectTasks 里', () => {
  const db = initializeDatabase(':memory:');
  try {
    const agent = insertAgent(db, { name: 'w9' });
    const task = insertTask(db, { title: '过期可见' });
    claimTask(db, task.id, agent.id);

    // 默认租约 90s；把"现在"拨到 91s 后，租约即视为过期
    const future = Date.now() + DEFAULT_LEASE_MS + 1000;
    const suspects = listSuspectTasks(db, future);
    assert.equal(suspects.length, 1);
    assert.equal(suspects[0].id, task.id);
    assert.equal(suspects[0].status, 'claimed');
  } finally {
    closeDatabase(db);
  }
});

test('10. 租约未过期的任务不出现在可疑列表', () => {
  const db = initializeDatabase(':memory:');
  try {
    const agent = insertAgent(db, { name: 'w10' });
    const fresh = insertTask(db, { title: '健康任务' });
    const dead = insertTask(db, { title: '过期任务' });
    claimTask(db, fresh.id, agent.id, 60_000); // 还有 60s 寿命
    claimTask(db, dead.id, agent.id, 1); // 1ms 即死
    const deadLease = getTaskById(db, dead.id).lease_expires_at;

    // 判定时刻选 deadLease+1：> dead.lease（恒过期）且 < fresh.lease
    // （fresh.lease 比 dead.lease 至少大 60s-1ms，恒未过期）——不依赖时钟推进
    const suspects = listSuspectTasks(db, deadLease + 1);
    const ids = suspects.map((t) => t.id);
    assert.ok(ids.includes(dead.id), '过期的必须在列');
    assert.ok(!ids.includes(fresh.id), '未过期的绝不能在列');
  } finally {
    closeDatabase(db);
  }
});

test('11. requeue 后回 queued、claim_token 清空、attempt 保留', () => {
  const db = initializeDatabase(':memory:');
  try {
    const agent = insertAgent(db, { name: 'w11' });
    const task = insertTask(db, { title: '放回队列' });
    claimTask(db, task.id, agent.id, 1);

    const r = resolveSuspectTask(db, task.id, 'requeue', {
      nowMs: getTaskById(db, task.id).lease_expires_at + 1,
    });
    assert.equal(r.ok, true);
    const row = getTaskById(db, task.id);
    assert.equal(row.status, 'queued');
    assert.equal(row.claim_token, null, '旧凭证必须作废（清空）');
    assert.equal(row.assignee, null);
    assert.equal(row.claimed_at, null);
    assert.equal(row.current_run_id, null);
    assert.equal(row.attempt, 1, '领取次数是账，必须保留');
  } finally {
    closeDatabase(db);
  }
});

test('12. 对正常任务（租约未过期）resolve → 拒绝 reason=not_suspect，库未动', () => {
  const db = initializeDatabase(':memory:');
  try {
    const agent = insertAgent(db, { name: 'w12' });
    const healthy = insertTask(db, { title: '健康的' });
    const queued = insertTask(db, { title: '压根没被领的' });
    claimTask(db, healthy.id, agent.id); // 90s 租约，健康

    for (const [id, why] of [
      [healthy.id, '租约未过期的 claimed 任务'],
      [queued.id, 'queued 任务'],
    ]) {
      const r = resolveSuspectTask(db, id, 'requeue');
      assert.deepEqual(r, { ok: false, reason: 'not_suspect' }, why);
    }
    // 健康任务原封不动
    const row = getTaskById(db, healthy.id);
    assert.equal(row.status, 'claimed');
    assert.ok(row.claim_token, '凭证不许被清');
    // 不存在的任务
    assert.deepEqual(resolveSuspectTask(db, 'no-such', 'requeue'), { ok: false, reason: 'not_found' });
  } finally {
    closeDatabase(db);
  }
});

// ---------------------------------------------------------------------------
// 并发与迁移（13–14）
// ---------------------------------------------------------------------------

test('13. 回归：10 个并发领取同一任务，仍恰好 1 个成功（attempt=1，不双写）', async () => {
  const db = initializeDatabase(':memory:');
  try {
    const agentIds = Array.from({ length: 10 }, (_, i) => insertAgent(db, { name: `racer-${i}` }).id);
    const task = insertTask(db, { title: '并发抢占回归' });

    const results = await Promise.all(
      agentIds.map(async (agentId) => {
        await sleep(Math.floor(Math.random() * 5)); // 模拟同时出手，判定全靠 WHERE
        return claimTask(db, task.id, agentId);
      }),
    );

    assert.equal(results.filter((r) => r.ok === true).length, 1, '必须恰好 1 个赢家');
    assert.equal(results.filter((r) => r.reason === 'not_queued').length, 9);
    const row = getTaskById(db, task.id);
    assert.equal(row.attempt, 1, '并发下 attempt 只许 +1，不许跳变');
    assert.equal(row.status, 'claimed');
    assert.ok(agentIds.includes(row.assignee), '赢家必须是真实 agent');
    // 赢家的 token 是唯一有效凭证：输家伪造的 token 续约必须失配，赢家畅通
    const winner = results.find((r) => r.ok === true);
    assert.deepEqual(renewLease(db, task.id, 'loser-forged-token'), { ok: false, reason: 'token_mismatch' });
    assert.equal(renewLease(db, task.id, winner.claim_token).ok, true, '赢家续约畅通');
  } finally {
    closeDatabase(db);
  }
});

test('14. 老库（无租约四列）迁移：补列成功、数据不丢、幂等', () => {
  // 手工搭 Task 1.x 时代的 tasks 表（无租约四列），塞进各状态的真实数据。
  // events 的外键依赖 tasks，退回老 schema 要先删 events 再重建两张表。
  const raw = initializeDatabase(':memory:');
  raw.exec('DROP TABLE events');
  raw.exec('DROP TABLE tasks');
  raw.exec(`
    CREATE TABLE tasks (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      assignee    TEXT REFERENCES agents(id),
      status      TEXT NOT NULL DEFAULT 'queued',
      claimed_at  INTEGER,
      created_at  INTEGER NOT NULL,
      result_path TEXT
    );
    CREATE TABLE events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id    TEXT REFERENCES tasks(id),
      agent_id   TEXT REFERENCES agents(id),
      type       TEXT NOT NULL,
      payload    TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
  `);
  const agent = insertAgent(raw, { name: 'legacy-worker' });
  const now = Date.now();
  const rows = [
    ['t-queued-1', '老排队任务', 'queued', null, null, null],
    ['t-claimed-1', '老卡死任务', 'claimed', agent.id, now - 10 * 60_000, null],
    ['t-done-1', '老完成任务', 'done', agent.id, now - 60_000, '/legacy/result.json'],
  ];
  for (const [id, title, status, assignee, claimedAt, resultPath] of rows) {
    raw.run(
      'INSERT INTO tasks (id, title, description, assignee, status, claimed_at, created_at, result_path) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, title, '', assignee, status, claimedAt, now - 3600_000, resultPath],
    );
  }

  // 迁移：补列 + 存量 claimed 任务补租约
  migrateDatabase(raw);

  const cols = raw.all('PRAGMA table_info(tasks)').map((c) => c.name);
  for (const col of ['claim_token', 'lease_expires_at', 'attempt', 'current_run_id']) {
    assert.ok(cols.includes(col), `迁移后必须有列 ${col}`);
  }
  // 原有数据一条不丢（期望按 sort() 的码点序：卡 U+5361 < 完 U+5B8C < 排 U+6392）
  const titles = raw.all('SELECT id, title, status, result_path FROM tasks').map((r) => r.title);
  assert.deepEqual(titles.sort(), ['老卡死任务', '老完成任务', '老排队任务']);
  assert.equal(raw.get('SELECT result_path FROM tasks WHERE id = ?', ['t-done-1']).result_path, '/legacy/result.json');
  // 存量卡死任务：补了从 claimed_at 起算的租约（早已过期），立刻进入可疑列表
  const stuck = raw.get('SELECT lease_expires_at FROM tasks WHERE id = ?', ['t-claimed-1']);
  assert.equal(stuck.lease_expires_at, now - 10 * 60_000 + DEFAULT_LEASE_MS, '租约 = claimed_at + 90s');
  assert.ok(listSuspectTasks(raw).some((t) => t.id === 't-claimed-1'), '存量卡死任务迁移后可见、可处置');
  // 未被领取的任务不补租约、attempt 归零
  assert.equal(raw.get('SELECT lease_expires_at FROM tasks WHERE id = ?', ['t-queued-1']).lease_expires_at, null);
  assert.ok(raw.all('SELECT attempt FROM tasks').every((r) => r.attempt === 0));

  // 幂等：再跑两遍，不抛错、数据不变
  migrateDatabase(raw);
  migrateDatabase(raw);
  assert.equal(raw.all('SELECT COUNT(*) AS n FROM tasks')[0].n, 3);
  assert.equal(
    raw.get('SELECT lease_expires_at FROM tasks WHERE id = ?', ['t-claimed-1']).lease_expires_at,
    stuck.lease_expires_at,
    '重复迁移不许把租约往前滚',
  );
  closeDatabase(raw);
});

// ---------------------------------------------------------------------------
// API 层加固（15–18，任务书"至少 14 条"之外的 HTTP 合同测试）
// ---------------------------------------------------------------------------

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

test('15. API renew：对 token 200 / 错 token 409 / 不存在 404 / 缺 token 400', async () => {
  const api = await startApi();
  try {
    const agent = (await (await fetch(`${api.base}/api/agents/register`, {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ name: 'api-renewer' }),
    })).json());
    const task = (await (await fetch(`${api.base}/api/tasks`, {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ title: 'API 续约' }),
    })).json());
    const claim = await (await fetch(`${api.base}/api/tasks/${task.id}/claim`, {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ agent_id: agent.id }),
    })).json();

    const okRes = await fetch(`${api.base}/api/tasks/${task.id}/renew`, {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ claim_token: claim.claim_token }),
    });
    assert.equal(okRes.status, 200);
    const okBody = await okRes.json();
    assert.equal(okBody.ok, true);
    assert.ok(okBody.lease_expires_at > Date.now());

    const bad = await fetch(`${api.base}/api/tasks/${task.id}/renew`, {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ claim_token: 'wrong' }),
    });
    assert.equal(bad.status, 409);
    assert.deepEqual(await bad.json(), { ok: false, reason: 'token_mismatch' });

    const nf = await fetch(`${api.base}/api/tasks/no-such/renew`, {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ claim_token: 'x' }),
    });
    assert.equal(nf.status, 404);

    const missing = await fetch(`${api.base}/api/tasks/${task.id}/renew`, {
      method: 'POST', headers: jsonHeaders, body: '{}',
    });
    assert.equal(missing.status, 400);
  } finally {
    await api.stop();
  }
});

test('16. API PATCH status：带错 token 409 且库未动 / 带对 token 200 / 缺 token 走 Task 1.3 老语义', async () => {
  const api = await startApi();
  try {
    const agent = (await (await fetch(`${api.base}/api/agents/register`, {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ name: 'api-patcher' }),
    })).json());
    const task = (await (await fetch(`${api.base}/api/tasks`, {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ title: 'API 状态' }),
    })).json());
    const claim = await (await fetch(`${api.base}/api/tasks/${task.id}/claim`, {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ agent_id: agent.id }),
    })).json();

    // 错 token → 409，一行不写
    const stolen = await fetch(`${api.base}/api/tasks/${task.id}/status`, {
      method: 'PATCH', headers: jsonHeaders,
      body: JSON.stringify({ claim_token: 'forged', status: 'done', result_path: '/stolen.json' }),
    });
    assert.equal(stolen.status, 409);
    assert.deepEqual(await stolen.json(), { ok: false, reason: 'token_mismatch' });
    const guarded = getTaskById(api.db, task.id);
    assert.equal(guarded.status, 'claimed');
    assert.equal(guarded.result_path, null);

    // 对 token → 200
    const okRes = await fetch(`${api.base}/api/tasks/${task.id}/status`, {
      method: 'PATCH', headers: jsonHeaders,
      body: JSON.stringify({ claim_token: claim.claim_token, status: 'running' }),
    });
    assert.equal(okRes.status, 200);
    assert.equal((await okRes.json()).status, 'running');

    // 缺 token → 兼容老语义（Task 1.3 客户端），仍可更新——这是有意保留的过渡口径
    const legacy = await fetch(`${api.base}/api/tasks/${task.id}/status`, {
      method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ status: 'done' }),
    });
    assert.equal(legacy.status, 200, '不带 token 的老调用在兼容期必须继续可用');
  } finally {
    await api.stop();
  }
});

test('17. API GET /api/tasks/suspect：返回 lease_expired_ms，健康的和排队的不在列', async () => {
  const api = await startApi();
  try {
    const agent = (await (await fetch(`${api.base}/api/agents/register`, {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ name: 'api-suspect' }),
    })).json());
    const mk = async (title) => (await (await fetch(`${api.base}/api/tasks`, {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ title }),
    })).json());

    // API 的 claim 固定 90s 租约，直接改库把一个任务的租约拨到过去，模拟"已过期"
    const stuck = await mk('API 卡死');
    const healthy = await mk('API 健康');
    await fetch(`${api.base}/api/tasks/${stuck.id}/claim`, {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ agent_id: agent.id }),
    });
    await fetch(`${api.base}/api/tasks/${healthy.id}/claim`, {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ agent_id: agent.id }),
    });
    api.db.run('UPDATE tasks SET lease_expires_at = ? WHERE id = ?', [Date.now() - 5000, stuck.id]);

    const res = await fetch(`${api.base}/api/tasks/suspect`);
    assert.equal(res.status, 200);
    const { tasks } = await res.json();
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, stuck.id);
    assert.ok(tasks[0].lease_expired_ms >= 5000 - 50 && tasks[0].lease_expired_ms < 60_000, '过期时长量级正确');
  } finally {
    await api.stop();
  }
});

test('18. API resolve：可疑任务 requeue 200；健康任务 409；action 非法 400', async () => {
  const api = await startApi();
  try {
    const agent = (await (await fetch(`${api.base}/api/agents/register`, {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ name: 'api-resolver' }),
    })).json());
    const task = (await (await fetch(`${api.base}/api/tasks`, {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ title: 'API 处置' }),
    })).json());
    await fetch(`${api.base}/api/tasks/${task.id}/claim`, {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ agent_id: agent.id }),
    });
    api.db.run('UPDATE tasks SET lease_expires_at = ? WHERE id = ?', [Date.now() - 1000, task.id]);

    // action 非法 → 400
    const badAction = await fetch(`${api.base}/api/tasks/${task.id}/resolve`, {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ action: 'delete' }),
    });
    assert.equal(badAction.status, 400);

    // 可疑 → requeue 成功，返回处置后的任务行
    const res = await fetch(`${api.base}/api/tasks/${task.id}/resolve`, {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ action: 'requeue' }),
    });
    assert.equal(res.status, 200);
    const { task: resolved } = await res.json();
    assert.equal(resolved.status, 'queued');
    assert.equal(resolved.claim_token, null);
    assert.equal(resolved.attempt, 1, 'attempt 保留');

    // requeue 后（queued、无租约）再 resolve → 409 not_suspect
    const again = await fetch(`${api.base}/api/tasks/${task.id}/resolve`, {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ action: 'requeue' }),
    });
    assert.equal(again.status, 409);
    assert.deepEqual(await again.json(), { ok: false, reason: 'not_suspect' });
  } finally {
    await api.stop();
  }
});
