/**
 * 跨进程并发测试 —— 进程内测试发现不了的问题。
 *
 * 背景：GPT 架构评审指出「HTTP 层内的并发测试不等于跨进程数据库安全」。
 * 实测证实：未设 busy_timeout 时，8 个进程同时抢任务，1 个成功、7 个直接抛
 * "database is locked" 崩溃退出 —— 从生产者视角看是灾难（Agent 进程批量挂掉）。
 *
 * 本测试用真实子进程（spawn）而非 worker_threads，覆盖 WASM SQLite 跨进程文件锁的真实行为。
 *
 * 起跑机制：不用「固定未来时刻」，因为全量并行跑时 CPU 争抢会把 worker 的启动
 * 拖过那个时刻（它醒来时别人已抢完，成功者变成 0 —— 假失败）。改成手写同步栅栏：
 * 每个 worker 就绪后写 ready-<slot> 并轮询 go 文件，父进程集齐 8 个 ready 再创建 go，
 * 所有进程在几毫秒内同时冲线。这样无论机器多忙都能真并发。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { initializeDatabase, insertAgent, insertTask } from '../src/db.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, 'xproc-worker.mjs');
const SYNC_DIR = join(HERE, 'xproc-sync');

// 用 pathToFileURL 生成 import 说明符：路径含空格/中文/反斜杠都能正确转义，
// 不要手写 replace(/\\/g,'/') —— 那在 heredoc 里会被 shell 吃掉一层转义。
const DB_SPEC = pathToFileURL(join(HERE, '..', 'src', 'db.js')).href;

const WORKER_SRC = `
import { initializeDatabase, claimTask } from ${JSON.stringify(DB_SPEC)};
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [,, dbPath, taskId, agentId, syncDir, slot] = process.argv;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// 栅栏 1：import 完成、参数拿到 → 报告就绪
writeFileSync(join(syncDir, 'ready-' + slot), '1');
// 栅栏 2：等父进程放行
while (!existsSync(join(syncDir, 'go'))) sleep(2);

try {
  const db = initializeDatabase(dbPath);
  const r = claimTask(db, taskId, agentId);
  console.log(JSON.stringify({ ok: r.ok, reason: r.reason ?? null, attempt: r.task?.attempt ?? null }));
  db.close();
} catch (e) {
  console.log(JSON.stringify({ error: e.message.slice(0, 120) }));
}
`;

let dbPath;

before(() => {
  writeFileSync(WORKER, WORKER_SRC, 'utf8');
  dbPath = join(HERE, `xproc-${randomUUID().slice(0, 8)}.db`);
});

after(() => {
  rmSync(dbPath, { force: true });
  rmSync(WORKER, { force: true });
  rmSync(SYNC_DIR, { recursive: true, force: true });
});

/** 起 8 个子进程，全部就绪后同时放行抢同一个任务 */
async function raceOnce(round) {
  // 每轮用独立 db 文件：复用同一个文件时，上一轮 worker 的 WASM 文件句柄可能还没
  // 完全释放，rmSync + 重建会让正在跑的进程撞上 "disk I/O error"（假失败）。
  const roundDbPath = join(HERE, `xproc-${round}-${randomUUID().slice(0, 6)}.db`);
  rmSync(SYNC_DIR, { recursive: true, force: true });
  mkdirSync(SYNC_DIR, { recursive: true });

  const db = initializeDatabase(roundDbPath);
  const task = insertTask(db, { title: `round-${round}` });
  const agents = Array.from({ length: 8 }, (_, i) => insertAgent(db, { name: `R${round}P${i}` }));
  db.close();

  const procs = agents.map(
    (a, i) =>
      new Promise((resolve) => {
        const p = spawn(process.execPath, [
          '--no-warnings', // node:sqlite 会往 stderr 打实验特性警告，别污染解析
          WORKER,
          roundDbPath,
          task.id,
          a.id,
          SYNC_DIR,
          String(i),
        ]);
        let out = '';
        p.stdout.on('data', (d) => { out += d; });
        p.stderr.on('data', (d) => { out += d; });
        p.on('close', () => {
          // 只认以 { 开头的那一行，warning 之类的噪声一律跳过
          const line = out.trim().split('\n').filter((l) => l.trim().startsWith('{')).pop();
          try {
            resolve(JSON.parse(line));
          } catch {
            resolve({ error: 'PARSE_FAILURE', raw: out.slice(0, 200) });
          }
        });
      }),
  );

  // 等 8 个 worker 全部就绪（最多 30 秒，防止卡死）
  const deadline = Date.now() + 30_000;
  let ready = 0;
  while (Date.now() < deadline) {
    ready = readdirSync(SYNC_DIR).filter((f) => f.startsWith('ready-')).length;
    if (ready >= agents.length) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(ready, agents.length, `worker 就绪数应为 ${agents.length}，实际 ${ready}`);
  writeFileSync(join(SYNC_DIR, 'go'), '1');

  const results = await Promise.all(procs);
  rmSync(roundDbPath, { force: true });
  rmSync(`${roundDbPath}-wal`, { force: true });
  rmSync(`${roundDbPath}-shm`, { force: true });
  return results;
}

test('跨进程：8 进程抢同一任务，5 轮都恰好 1 个成功', async () => {
  for (let round = 1; round <= 5; round++) {
    const results = await raceOnce(round);
    const crashed = results.filter((r) => r.error);
    assert.equal(crashed.length, 0, `第 ${round} 轮有进程崩溃：${JSON.stringify(crashed[0])}`);
    const wins = results.filter((r) => r.ok === true).length;
    assert.equal(wins, 1, `第 ${round} 轮成功者应为 1，实际 ${wins}`);
  }
});

test('跨进程：落败者不得崩溃，必须返回 ok=false / not_queued', async () => {
  // 回归 busy_timeout —— 缺这条时 7 个进程会抛 "database is locked"
  for (let round = 1; round <= 3; round++) {
    const results = await raceOnce(round);
    const crashed = results.filter((r) => r.error);
    assert.equal(crashed.length, 0, `第 ${round} 轮崩溃 ${crashed.length} 个：${JSON.stringify(crashed[0])}`);

    const losers = results.filter((r) => r.ok === false);
    assert.equal(losers.length, 7, `第 ${round} 轮应有 7 个优雅落败者，实际 ${losers.length}`);
    assert.ok(losers.every((r) => r.reason === 'not_queued'), '落败原因应为 not_queued');
  }
});
