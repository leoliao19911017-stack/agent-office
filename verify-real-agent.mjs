// verify-real-agent.mjs — Task 2.2 真实链路验证（不是测试，是手动跑的演示）。
//
// 链路：起真 Office 服务 → 建真任务 → 真跑 claudeExecutor（claude -p 真改文件）
//       → 检查文件真的被创建 → 打印任务终态和事件流。
// 不许模拟：claude 命令真的被执行，hello.txt 真的是它写的。
//
// 用法：node --no-warnings verify-real-agent.mjs
// 退出码 0 = 全链路通；1 = 任何一环失败。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeDatabase, closeDatabase } from './src/db.js';
import { startServer } from './src/server.js';
import { AgentClient } from './src/agent-client.js';
import { Runner, claudeExecutor, createCodexExecutor } from './src/runner.js';

// 选哪个 CLI 跑：node verify-real-agent.mjs [claude|codex]（默认 claude）
// 两个都验过才算真接入 —— 而且 claude 有 5 小时额度限制，额度用完时用 codex 验证。
const WHICH = (process.argv[2] ?? 'claude').toLowerCase();
const EXECUTORS = {
  claude: { executor: claudeExecutor, label: 'Claude Code', cmd: 'claude' },
  codex: { executor: createCodexExecutor(), label: 'Codex', cmd: 'codex' },
};
if (!EXECUTORS[WHICH]) {
  console.error(`未知的 CLI：${WHICH}（可选 claude / codex）`);
  process.exit(1);
}
const { executor: EXECUTOR, label: CLI_LABEL, cmd: CLI_CMD } = EXECUTORS[WHICH];

const jsonHeaders = { 'content-type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`[verify] ${msg}`);
const fail = (msg) => {
  console.error(`[verify] ❌ ${msg}`);
  process.exitCode = 1;
};

const projectRoot = dirname(fileURLToPath(import.meta.url));
const workdir = join(projectRoot, 'tmp-verify-agent');
const helloPath = join(workdir, 'hello.txt');
const TERMINAL = new Set(['done', 'failed', 'cancelled', 'blocked']);
const WAIT_LIMIT_MS = 10 * 60_000; // claude 跑一个 hello.txt 任务的上限，超过判失败

async function fetchJson(base, path, init) {
  const res = await fetch(`${base}${path}`, init);
  return { status: res.status, body: await res.json() };
}

async function main() {
  // ---- 0. 前置检查：CLI 命令必须真的存在 ----
  const probe = spawnSync('cmd.exe', ['/d', '/s', '/c', CLI_CMD, '--version'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (probe.status !== 0) {
    fail(`${CLI_CMD} 命令不可用（exit=${probe.status}）：${probe.stderr}`);
    return;
  }
  log(`${CLI_LABEL} CLI 就绪：${String(probe.stdout).trim()}`);

  // ---- 1. 清场：删掉旧 hello.txt，保证文件是"这一次"创建的，不是上次残留 ----
  rmSync(helloPath, { force: true });
  mkdirSync(workdir, { recursive: true });
  if (existsSync(helloPath)) {
    fail('清场失败：hello.txt 删不掉');
    return;
  }
  log(`workdir：${workdir}（hello.txt 已清空，等待 claude 创建）`);

  // ---- 2. 起真 Office 服务（内存库 + 随机端口）----
  const db = initializeDatabase(':memory:');
  const server = startServer({ port: 0, db });
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  log(`Office 服务已启动：${base}`);

  let runner = null;
  try {
    // ---- 3. 建真任务 ----
    const created = await fetchJson(base, '/api/tasks', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        title: '创建 hello.txt',
        description:
          '在当前工作目录创建一个文件 hello.txt，内容只有一行：当前时间（ISO 8601 格式）。' +
          '只做这一件事，创建完就停止，不要做任何其他事。',
      }),
    });
    if (created.status !== 201) {
      fail(`建任务失败：HTTP ${created.status} ${JSON.stringify(created.body)}`);
      return;
    }
    const taskId = created.body.id;
    log(`任务已创建：${taskId}（title=创建 hello.txt）`);

    // ---- 4. 真跑 Runner + claudeExecutor（claude -p 真执行）----
    const client = new AgentClient({
      baseUrl: base,
      name: `${WHICH}-verify`,
      type: WHICH,
      capabilities: ['code'],
      heartbeatIntervalMs: 15_000, // 真实口径：15s 心跳 vs 90s 租约
    });
    runner = new Runner({ client, workdir, executor: EXECUTOR, pollIntervalMs: 500 });
    await runner.start();
    log(`Runner 已启动（executor=${CLI_LABEL}），等待领取并执行……`);

    // ---- 5. 轮询终态；顺带观察租约是否一直在被推后（= 心跳在执行期间持续）----
    const t0 = Date.now();
    let row = null;
    let lastLease = null;
    let renewSeen = 0;
    while (Date.now() - t0 < WAIT_LIMIT_MS) {
      const { body } = await fetchJson(base, `/api/tasks/${taskId}`);
      row = body.task ?? body;
      if (row.lease_expires_at !== lastLease) {
        if (lastLease !== null) renewSeen++;
        lastLease = row.lease_expires_at;
      }
      if (TERMINAL.has(row.status)) break;
      await sleep(1_000);
    }
    const elapsedMs = Date.now() - t0;

    // ---- 6. 打印结果 ----
    console.log('');
    if (!row || !TERMINAL.has(row.status)) {
      fail(`等待 ${WAIT_LIMIT_MS / 60_000} 分钟仍未到终态（当前 status=${row?.status}）`);
      return;
    }
    log(`终态：${row.status}（attempt=${row.attempt}，耗时 ${elapsedMs}ms，期间观察到租约被续约 ${renewSeen} 次）`);
    log(`result_path：${row.result_path}`);
    if (row.result_path && existsSync(row.result_path)) {
      const logText = readFileSync(row.result_path, 'utf8');
      log('output.log 节选（前 15 行）：');
      for (const line of logText.split('\n').slice(0, 15)) console.log(`    ${line}`);
    } else {
      fail('result_path 指向的 output.log 不存在');
    }

    // ---- 7. 关键验证：文件真的是 claude 创建的 ----
    console.log('');
    if (!existsSync(helloPath)) {
      fail('hello.txt 没有被创建 —— claude 没有真的执行任务');
      return;
    }
    const content = readFileSync(helloPath, 'utf8').trim();
    log(`✅ hello.txt 已创建，内容：「${content}」`);

    // ---- 8. 事件流 ----
    const { body: ev } = await fetchJson(base, `/api/tasks/${taskId}/events`);
    log(`事件流（共 ${ev.events.length} 条）：`);
    for (const e of ev.events) {
      const note = e.payload?.note ?? e.payload?.result_path ?? '';
      console.log(`    ${new Date(e.created_at).toISOString()}  ${e.type.padEnd(8)} ${note}`);
    }

    // ---- 判定 ----
    if (row.status === 'done' && existsSync(helloPath)) {
      log('全链路验证通过：任务由 claude CLI 真实领取并执行，文件真实落盘，结果真实提交。');
    } else {
      fail(`终态不是 done：${row.status}`);
    }
  } finally {
    if (runner) await runner.stop();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    closeDatabase(db);
  }
}

main().catch((err) => {
  fail(`未捕获异常：${err?.stack ?? err}`);
  process.exit(1);
});
