// Task 2.2 测试：Runner 编排逻辑。
// 用假执行器（不发真 CLI），只验证"领任务 → 心跳 → 执行 → 落盘 → 提交"的编排本身；
// 真实 Claude Code 链路由 verify-real-agent.mjs 手动验证。
// 编号 11–16 对应任务书验收清单。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeDatabase, closeDatabase, getTaskById } from '../src/db.js';
import { startServer } from '../src/server.js';
import { AgentClient } from '../src/agent-client.js';
import { Runner } from '../src/runner.js';

const jsonHeaders = { 'content-type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function createTask(base, title) {
  const res = await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ title }),
  });
  assert.equal(res.status, 201);
  return res.json();
}

async function makeRunner(api, executor, opts = {}) {
  const client = new AgentClient({
    baseUrl: api.base,
    name: `runner-agent-${Math.random().toString(36).slice(2, 8)}`,
    type: 'test',
    heartbeatIntervalMs: opts.heartbeatIntervalMs ?? 300,
  });
  const workdir = await mkdtemp(join(tmpdir(), 'soda-runner-test-'));
  const runner = new Runner({
    client,
    workdir,
    executor,
    pollIntervalMs: opts.pollIntervalMs ?? 100,
    logger: { log() {}, warn() {} }, // 测试静音（诊断期曾打开，问题定位见提交说明）
  });
  return { runner, client, workdir };
}

/** 轮询等待条件成立（默认 10s 上限），超时返回最后一次求值结果。 */
async function waitFor(predicate, timeoutMs = 10_000, stepMs = 50) {
  const t0 = Date.now();
  let last = false;
  while (Date.now() - t0 < timeoutMs) {
    last = await predicate();
    if (last) return true;
    await sleep(stepMs);
  }
  return last;
}

// 同步读状态：waitFor 的 predicate 是同步箭头，这里必须返回字符串而不是 Promise
function taskStatus(api, id) {
  return getTaskById(api.db, id).status;
}

// ---------------------------------------------------------------------------

test('11. 领到任务 → 执行 → 提交 done，result_path 指向 output.log 且内容落盘', async () => {
  const api = await startApi();
  let workdir;
  try {
    const task = await createTask(api.base, '成功路径');
    const executor = async () => ({ ok: true, output: 'CLI 输出：一切正常', durationMs: 42 });
    const made = await makeRunner(api, executor);
    workdir = made.workdir;
    await made.runner.start();

    assert.ok(await waitFor(() => taskStatus(api, task.id) === 'done'), '任务应到终态 done');
    await made.runner.stop();

    const row = getTaskById(api.db, task.id);
    const expectPath = join(workdir, 'runs', task.id, 'output.log');
    assert.equal(row.result_path, expectPath, 'result_path 必须指向落盘的 output.log');
    const log = await readFile(expectPath, 'utf8');
    assert.ok(log.includes('CLI 输出：一切正常'), '执行器输出必须写进 output.log');
    assert.ok(log.includes('任务 ' + task.id), '日志头部带任务标识');
  } finally {
    if (workdir) await rm(workdir, { recursive: true, force: true });
    await api.stop();
  }
});

test('12. 执行器返回失败 → 提交 failed', async () => {
  const api = await startApi();
  let workdir;
  try {
    const task = await createTask(api.base, '失败路径');
    const executor = async () => ({ ok: false, output: 'CLI 报错：文件写不进去', durationMs: 10 });
    const made = await makeRunner(api, executor);
    workdir = made.workdir;
    await made.runner.start();

    assert.ok(await waitFor(() => taskStatus(api, task.id) === 'failed'), '失败结果必须提交为 failed');
    await made.runner.stop();
    assert.ok(getTaskById(api.db, task.id).result_path, 'failed 也要有 result_path（现场可查）');
  } finally {
    if (workdir) await rm(workdir, { recursive: true, force: true });
    await api.stop();
  }
});

test('13. 执行器抛异常 → 提交 failed，错误写进 output.log', async () => {
  const api = await startApi();
  let workdir;
  try {
    const task = await createTask(api.base, '异常路径');
    const executor = async () => {
      throw new Error('boom: 执行器炸了');
    };
    const made = await makeRunner(api, executor);
    workdir = made.workdir;
    await made.runner.start();

    assert.ok(await waitFor(() => taskStatus(api, task.id) === 'failed'), '异常不许吞，必须提交 failed');
    await made.runner.stop();
    const log = await readFile(join(workdir, 'runs', task.id, 'output.log'), 'utf8');
    assert.ok(log.includes('boom: 执行器炸了'), '异常信息必须落盘');
  } finally {
    if (workdir) await rm(workdir, { recursive: true, force: true });
    await api.stop();
  }
});

test('14. 执行 3 秒期间心跳持续，租约没被判定过期', async () => {
  const api = await startApi();
  let workdir;
  try {
    const task = await createTask(api.base, '长任务');
    let suspectCheckedDuringRun = false;
    let suspectWasEmpty = false;
    const executor = async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 1500) await sleep(100); // 执行到一半
      const res = await fetch(`${api.base}/api/tasks/suspect`);
      const { tasks } = await res.json();
      suspectCheckedDuringRun = true;
      suspectWasEmpty = tasks.length === 0; // 执行中任务不许进可疑列表
      while (Date.now() - t0 < 3000) await sleep(100); // 执行满 3 秒
      return { ok: true, output: 'ok', durationMs: Date.now() - t0 };
    };
    const made = await makeRunner(api, executor, { heartbeatIntervalMs: 300 });
    workdir = made.workdir;

    await made.runner.start();
    assert.ok(await waitFor(() => taskStatus(api, task.id) === 'done'), '3 秒任务应正常完成');
    await made.runner.stop();

    assert.ok(suspectCheckedDuringRun, '执行中必须做过可疑检查');
    assert.ok(suspectWasEmpty, '心跳持续时任务不许被判可疑');
    const row = getTaskById(api.db, task.id);
    assert.ok(row.lease_expires_at !== null, '终态租约有值');
    // 关键断言：执行结束时租约比刚 claim 时晚 ≥2s —— 唯一的解释是执行期间一直在续约
    const leaseAtClaim = row.claimed_at + 90_000; // claim 时刻 + 默认租约 90s
    assert.ok(
      row.lease_expires_at >= leaseAtClaim + 2_000,
      `执行 3 秒期间租约必须被续到更晚：claim 基线 ${leaseAtClaim}，终值 ${row.lease_expires_at}`,
    );
  } finally {
    if (workdir) await rm(workdir, { recursive: true, force: true });
    await api.stop();
  }
});

test('15. 执行中所有权丢失 → 子进程被 kill，不提交', async () => {
  const api = await startApi();
  let workdir;
  try {
    const task = await createTask(api.base, '被接管的长任务');
    // 真 spawn 一个 60s 才退出的子进程，signal abort 时 kill —— 模拟真实 CLI 被 Runner 停手
    let childExited = false;
    let killedBySignal = false;
    let executorReturned = false;
    const executor = async ({ signal }) => {
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
      const exited = new Promise((resolve) =>
        child.on('close', (code, sig) => {
          killedBySignal = sig !== null; // 被 kill 的进程带信号退出
          childExited = true;
          resolve();
        }),
      );
      const kill = () => child.kill();
      if (signal.aborted) kill();
      else signal.addEventListener('abort', kill, { once: true });
      await exited;
      executorReturned = true;
      return { ok: false, killed: true, output: '被 kill', durationMs: 0 };
    };
    const made = await makeRunner(api, executor, { heartbeatIntervalMs: 50 });
    workdir = made.workdir;

    await made.runner.start();
    // 等任务进入 running（执行已开始），再模拟所有权被接管（token 被换）
    assert.ok(await waitFor(() => taskStatus(api, task.id) === 'running'));
    api.db.run('UPDATE tasks SET claim_token = ? WHERE id = ?', ['taken-over-by-other', task.id]);

    assert.ok(await waitFor(() => executorReturned), '执行器应在丢所有权后返回');
    assert.ok(childExited, '子进程必须真的退出');
    assert.ok(killedBySignal, '子进程是被信号杀掉的，不是自然退出');
    assert.equal(made.client.lostOwnership, true);
    await made.runner.stop();

    const row = getTaskById(api.db, task.id);
    assert.equal(row.status, 'running', '丢所有权后不许提交 —— 任务停在 running 等 suspect 流程');
    assert.equal(row.result_path, null, 'result_path 不许被写');
    const events = await (await fetch(`${api.base}/api/tasks/${task.id}/events`)).json();
    assert.ok(
      events.events.some((e) => e.type === 'note' && String(e.payload.note ?? '').includes('停手')),
      '停手必须留审计事件',
    );
  } finally {
    if (workdir) await rm(workdir, { recursive: true, force: true });
    await api.stop();
  }
});

test('16. stop() 后不再领新任务', async () => {
  const api = await startApi();
  let workdir;
  try {
    const executor = async () => ({ ok: true, output: 'ok', durationMs: 1 });
    const made = await makeRunner(api, executor, { pollIntervalMs: 100 });
    workdir = made.workdir;
    await made.runner.start();

    const t1 = await createTask(api.base, '停机前');
    assert.ok(await waitFor(() => taskStatus(api, t1.id) === 'done'));
    await made.runner.stop();
    assert.equal(made.runner.running, false, 'stop 后 running 标志必须为 false');

    const t2 = await createTask(api.base, '停机后');
    await sleep(400); // 4 个 poll 周期，足够证明不会再领
    assert.equal(taskStatus(api, t2.id), 'queued', 'stop 后新任务必须原样躺在队列里');
  } finally {
    if (workdir) await rm(workdir, { recursive: true, force: true });
    await api.stop();
  }
});
