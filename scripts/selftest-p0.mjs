// selftest-p0.mjs — P0 地基自测：8 个规定场景 + 3 个必验项。
//
// 原则：
//   - 真跑，不 mock 状态：DSH 相关用真子进程 + 真 JSON 事件流（fixtures/fake-dsh.mjs），
//     强杀用真 kill，重启恢复用真换进程读同一个 DB 文件；
//   - 隔离：数据库/工作区全在系统临时目录，不污染 data/agent-office.db；
//   - 失败不掩盖：任一断言失败打印堆栈，退出码 1。
//
// 运行：node scripts/selftest-p0.mjs
// 保留现场：KEEP=1 node scripts/selftest-p0.mjs

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { openDb, closeDb } from '../web/lib/db.mjs';
import { createTask, getTask } from '../web/lib/tasks.mjs';
import {
  createAttempt, getAttempt, endAttempt,
} from '../web/lib/attempts.mjs';
import { appendEvent, queryEvents, countArtifacts, recordAcceptance, EVIDENCE } from '../web/lib/events.mjs';
import { createCheckpoint, listCheckpoints } from '../web/lib/checkpoint.mjs';
import {
  acquireWriteOwner, releaseWriteOwner, getWriteOwner,
} from '../web/lib/write-owner.mjs';
import {
  evaluateTaskState, refreshTaskState, STATES,
} from '../web/lib/state-machine.mjs';
import { startDshAttempt } from '../web/adapters/dsh.mjs';

const HERE = join(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = join(HERE, '..');
const FAKE_DSH = join(HERE, 'fixtures', 'fake-dsh.mjs');
const MIGRATE_SCRIPT = join(HERE, 'migrate-legacy.mjs');
const KEEP = process.env.KEEP === '1';

const ROOT = mkdtempSync(join(tmpdir(), 'agent-office-p0-'));
const DB_PATH = join(ROOT, 'main.db');
process.env.AGENT_OFFICE_DB = DB_PATH;

const db = openDb({ path: DB_PATH });
const handles = [];
const results = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, opts = {}) {
  const { timeout = 8000, interval = 30, label = 'condition' } = opts;
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`等待超时（${timeout}ms）：${label}; last=${JSON.stringify(last)}`);
}

function runGit(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 32 * 1024 * 1024,
  }).trim();
}

/** 建一个真 git 仓库：一个已提交文件 + 干净工作区。 */
function initRepo(name) {
  const dir = join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  runGit(dir, ['init', '-q']);
  runGit(dir, ['config', 'user.email', 'selftest@example.invalid']);
  runGit(dir, ['config', 'user.name', 'P0 Selftest']);
  // 避免 Windows 上 LF→CRLF 的提示污染自测输出（不影响检查点内容）。
  runGit(dir, ['config', 'core.autocrlf', 'false']);
  writeFileSync(join(dir, 'tracked.txt'), 'base\n', 'utf8');
  runGit(dir, ['add', 'tracked.txt']);
  runGit(dir, ['commit', '-qm', 'base']);
  return dir;
}

function newTask(title, steps) {
  const task = createTask(db, { title, steps: steps || ['分析', '实现', '验收'], source: 'selftest' });
  refreshTaskState(db, task.task_id);
  return task;
}

async function startFake(scenario, taskId, worktreePath = null) {
  const h = await startDshAttempt({
    db,
    taskId,
    worktreePath,
    command: process.execPath,
    args: [FAKE_DSH, scenario],
    prompt: 'selftest',
    acquireOwner: Boolean(worktreePath),
  });
  handles.push(h);
  return h;
}

async function stopAll() {
  for (const h of handles.splice(0)) {
    try {
      const closing = h.stop ? h.stop('test_cleanup') : null;
      if (closing) await Promise.race([closing, sleep(4000)]);
    } catch { /* 已退出 */ }
  }
}

async function test(id, name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    const ms = Date.now() - t0;
    results.push({ id, name, ok: true, ms });
    console.log(`✔ ${id} ${name} (${ms}ms)`);
  } catch (err) {
    const ms = Date.now() - t0;
    results.push({ id, name, ok: false, ms, error: String(err && err.stack ? err.stack : err) });
    console.log(`✘ ${id} ${name} (${ms}ms)`);
    console.log(String(err && err.stack ? err.stack : err).split('\n').map((l) => `    ${l}`).join('\n'));
  }
}

async function extra(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ id: `EX-${name}`, name, ok: true, ms: Date.now() - t0 });
    console.log(`✔ EX ${name} (${Date.now() - t0}ms)`);
  } catch (err) {
    results.push({ id: `EX-${name}`, name, ok: false, ms: Date.now() - t0, error: String(err && err.stack ? err.stack : err) });
    console.log(`✘ EX ${name}`);
    console.log(String(err && err.stack ? err.stack : err).split('\n').map((l) => `    ${l}`).join('\n'));
  }
}

// ---------------------------------------------------------------------------

async function main() {
  console.log(`P0 selftest  node=${process.version}  git=${execFileSync('git', ['--version'], { encoding: 'utf8' }).trim()}`);
  console.log(`workspace=${ROOT}`);
  console.log(`db=${DB_PATH}`);
  console.log('');

  let t03TaskId = null;

  // T01：正在思考、暂无文件输出 → running，产物数不变
  await test('T01', 'DSH 正在思考、暂无文件输出 → running，产物数不变', async () => {
    const task = newTask('T01 思考中', ['分析方案', '写代码']);
    const before = countArtifacts(db, task.task_id).count;
    const h = await startFake('think', task.task_id);
    await waitFor(() => queryEvents(db, { taskId: task.task_id, types: ['thinking'], limit: 10 }).length >= 1,
      { label: 'thinking 事件' });
    const s1 = evaluateTaskState(db, task.task_id);
    assert.equal(s1.status, STATES.RUNNING, `第一次判定应为 running，实际 ${s1.status}`);
    assert.equal(countArtifacts(db, task.task_id).count, before, '思考阶段不应新增产物');
    await sleep(300);
    const s2 = evaluateTaskState(db, task.task_id);
    assert.equal(s2.status, STATES.RUNNING, `持续思考仍应为 running，实际 ${s2.status}`);
    assert.equal(countArtifacts(db, task.task_id).count, before, '产物数必须保持不变');
    assert.equal(s2.evidence_source, EVIDENCE.EXECUTOR, '应标 executor');
    await h.stop();
  });

  // T02：等待权限 → waiting
  await test('T02', 'DSH 等待权限确认 → waiting', async () => {
    const task = newTask('T02 等权限', ['实现']);
    const h = await startFake('permission', task.task_id);
    await waitFor(() => queryEvents(db, { taskId: task.task_id, types: ['permission_request'] }).length >= 1,
      { label: 'permission_request 事件' });
    const s = evaluateTaskState(db, task.task_id);
    assert.equal(s.status, STATES.WAITING, `应为 waiting，实际 ${s.status}`);
    assert.match(s.status_reason, /权限/, 'waiting 理由要说清在等权限');
    assert.equal(s.evidence_source, EVIDENCE.EXECUTOR);
    await h.stop();
  });

  // T03：进程被强杀 → interrupted，任务记录还在
  await test('T03', 'DSH 进程被强杀 → interrupted，任务记录还在', async () => {
    const task = newTask('T03 被强杀', ['实现']);
    t03TaskId = task.task_id;
    const h = await startFake('think', task.task_id);
    await waitFor(() => queryEvents(db, { taskId: task.task_id, types: ['thinking'] }).length >= 1,
      { label: 'thinking 事件' });
    await h.kill(); // 真 kill 进程树（非正常退出）
    const s = evaluateTaskState(db, task.task_id);
    assert.equal(s.status, STATES.INTERRUPTED, `应为 interrupted，实际 ${s.status}`);
    assert.notEqual(s.status, STATES.IDLE, '不允许落成 idle');
    const row = getTask(db, task.task_id);
    assert.ok(row, '任务记录必须还在');
    assert.equal(row.status, STATES.INTERRUPTED, '持久化状态也应是 interrupted');
    const exits = queryEvents(db, { taskId: task.task_id, types: ['process_exit'] });
    assert.ok(exits.length >= 1, '必须留下 process_exit 证据');
    assert.equal(exits[0].payload.expected, false, '强杀不能标成 expected');
  });

  // T04：明确额度耗尽 → blocked + reason=quota_5h + 检查点 + attempt 待接力
  await test('T04', '额度耗尽（进程还在）→ blocked/quota_5h，生成检查点，attempt 待接力', async () => {
    const repo = initRepo('repo-t04');
    const task = newTask('T04 额度耗尽', ['实现']);
    const h = await startFake('quota', task.task_id, repo);
    await waitFor(() => queryEvents(db, { taskId: task.task_id, types: ['quota_exhausted'] }).length >= 1,
      { label: 'quota_exhausted 事件' });
    await waitFor(() => listCheckpoints(db, task.task_id).length >= 1, { label: '自动检查点' });

    const s = evaluateTaskState(db, task.task_id);
    assert.equal(s.status, STATES.BLOCKED, `应为 blocked，实际 ${s.status}`);
    assert.equal(s.blocked_reason, 'quota_5h', `reason 应为 quota_5h，实际 ${s.blocked_reason}`);
    assert.match(s.status_reason, /quota_5h/);

    const attempt = getAttempt(db, h.attempt.attempt_id);
    assert.equal(attempt.status, 'running', '额度耗尽时进程还在，attempt 仍应是 running');
    assert.equal(attempt.relay_pending, true, 'attempt 必须标记待接力');

    const cps = listCheckpoints(db, task.task_id);
    assert.ok(cps.length >= 1, '必须生成检查点');
    assert.match(String(cps[0].label || ''), /blocked_quota_5h/, `检查点标签应标记阻塞原因，实际 ${cps[0].label}`);

    await h.stop();
  });

  // T05：改了新文件未提交 → 检查点 untracked 必须包含
  await test('T05', '新文件未提交 → 检查点 untracked 列表包含这些文件', async () => {
    const repo = initRepo('repo-t05');
    writeFileSync(join(repo, 'tracked.txt'), 'base\nchanged\n', 'utf8');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'new-a.js'), 'export const a = 1;\n', 'utf8');
    writeFileSync(join(repo, 'src', 'new-b.js'), 'export const b = 2;\n', 'utf8');

    const task = newTask('T05 未提交新文件', ['实现']);
    const attempt = createAttempt(db, {
      taskId: task.task_id, agentId: 'dsh', worktreePath: repo, startedAt: new Date().toISOString(),
    });
    const cp = createCheckpoint(db, {
      taskId: task.task_id, attemptId: attempt.attempt_id, worktreePath: repo, label: 't05',
    });
    assert.ok(cp.git_sha, `应记录 git sha，实际 ${cp.git_sha}（git_error=${cp.git_error || 'none'}）`);
    const untracked = cp.untracked.map((u) => u.path).sort();
    assert.deepEqual(untracked, ['src/new-a.js', 'src/new-b.js'], `untracked 不符：${JSON.stringify(untracked)}`);
    const tracked = cp.files.find((f) => f.path === 'tracked.txt');
    assert.ok(tracked, '已跟踪的修改必须在 files 里');
    assert.equal(tracked.tracked, true);
    assert.ok(tracked.sha256 && tracked.sha256.length === 64, '应有 sha256');
    assert.ok(tracked.status.includes('M'), `tracked 状态应为修改，实际 ${tracked.status}`);
  });

  // T06：DSH 无法启动 → 接力失败，任务仍 interrupted
  await test('T06', 'DSH 无法启动 → 接力失败，任务仍 interrupted（不是 idle/completed）', async () => {
    const repo = initRepo('repo-t06');
    const task = newTask('T06 接力失败', ['实现']);
    const a1 = createAttempt(db, {
      taskId: task.task_id, agentId: 'dsh', worktreePath: repo, startedAt: new Date(Date.now() - 60000).toISOString(),
    });
    endAttempt(db, { attemptId: a1.attempt_id, status: 'interrupted', endReason: 'crash' });
    appendEvent(db, {
      taskId: task.task_id, attemptId: a1.attempt_id, agentId: 'dsh',
      eventType: 'process_exit', payload: { code: null, signal: 'SIGKILL', expected: false, reason: '模拟原实例被强杀' },
      evidenceSource: EVIDENCE.EXECUTOR,
    });
    refreshTaskState(db, task.task_id);
    assert.equal(getTask(db, task.task_id).status, STATES.INTERRUPTED);

    const bad = join(ROOT, 'definitely-no-such-dsh-command.exe');
    const r = await startDshAttempt({
      db, taskId: task.task_id, worktreePath: repo,
      command: bad, args: [], prompt: 'selftest', acquireOwner: true,
    });
    assert.equal(r.ok, false, '启动必须失败');
    assert.ok(r.error && /ENOENT|not found|找不到/i.test(r.error), `错误信息应说明找不到命令，实际 ${r.error}`);

    const s = evaluateTaskState(db, task.task_id);
    assert.equal(s.status, STATES.INTERRUPTED, `仍应为 interrupted，实际 ${s.status}`);
    assert.notEqual(s.status, STATES.IDLE, '接力失败不许变 idle');
    assert.notEqual(s.status, STATES.COMPLETED, '接力失败不许变 completed');
    const failed = queryEvents(db, { taskId: task.task_id, types: ['agent_start_failed'] });
    assert.equal(failed.length, 1, '应记录 agent_start_failed');
    assert.equal(failed[0].payload.error ? true : false, true, '失败事件必须带错误');
    // 启动失败必须释放写入权，不能把 worktree 锁死。
    const owner = getWriteOwner(db, repo);
    assert.ok(!owner || owner.released_at, '启动失败后写入权应已释放');
  });

  // T07：两个 agent 同时申请同一 worktree → 第二个被拒绝，第一个仍持有
  await test('T07', '两个 agent 同时申请同一 worktree → 第二个拒绝，第一个仍持有', async () => {
    const repo = initRepo('repo-t07');
    const task = newTask('T07 双写', ['实现']);
    const a1 = createAttempt(db, { taskId: task.task_id, agentId: 'claude', worktreePath: repo });
    const a2 = createAttempt(db, { taskId: task.task_id, agentId: 'dsh', worktreePath: repo });

    const first = acquireWriteOwner(db, {
      worktreePath: repo, taskId: task.task_id, attemptId: a1.attempt_id, agentId: 'claude',
    });
    assert.equal(first.acquired, true);

    let conflict = null;
    try {
      acquireWriteOwner(db, {
        worktreePath: repo, taskId: task.task_id, attemptId: a2.attempt_id, agentId: 'dsh',
      });
    } catch (err) {
      conflict = err;
    }
    assert.ok(conflict, '第二个申请必须被拒绝');
    assert.equal(conflict.code, 'WRITE_OWNER_CONFLICT');
    assert.equal(conflict.statusCode, 409);

    const still = getWriteOwner(db, repo);
    assert.equal(still.attempt_id, a1.attempt_id, '第一个尝试必须仍持有');
    assert.equal(still.agent_id, 'claude');
    assert.equal(still.released_at, null);

    // 释放后第二个可以拿到，证明不是永久锁死。
    releaseWriteOwner(db, { worktreePath: repo, attemptId: a1.attempt_id });
    const second = acquireWriteOwner(db, {
      worktreePath: repo, taskId: task.task_id, attemptId: a2.attempt_id, agentId: 'dsh',
    });
    assert.equal(second.acquired, true);
    assert.equal(getWriteOwner(db, repo).attempt_id, a2.attempt_id);
  });

  // T08：Agent 自称完成但测试不通过 → 不许 completed
  await test('T08', 'Agent 自称完成但测试不通过 → 不许置 completed', async () => {
    const task = newTask('T08 假完成', ['实现', '测试']);
    const h = await startFake('claim-done', task.task_id);
    await waitFor(() => queryEvents(db, { taskId: task.task_id, types: ['claim_done'] }).length >= 1,
      { label: 'claim_done 事件' });

    // 只有自称完成、没有验收结论：最多 waiting，不能 completed。
    const s1 = evaluateTaskState(db, task.task_id);
    assert.notEqual(s1.status, STATES.COMPLETED, '自称完成不算完成');

    recordAcceptance(db, {
      taskId: task.task_id, attemptId: h.attempt.attempt_id,
      result: 'failed', command: 'npm test', report: '2 failing',
    });
    const s2 = evaluateTaskState(db, task.task_id);
    assert.notEqual(s2.status, STATES.COMPLETED, '测试不通过时绝不能 completed');
    assert.equal(s2.verification.result, 'failed', '必须带验证失败标记');
    assert.equal(s2.status, STATES.RUNNING, `实例还在跑，应为 running，实际 ${s2.status}`);

    // 反证 1：验收绑定了代码版本，但找不到对应检查点 → 只能 waiting，不能 completed。
    recordAcceptance(db, {
      taskId: task.task_id, attemptId: h.attempt.attempt_id,
      result: 'passed', command: 'npm test', report: 'all green', codeSha: 'deadbeefdeadbeef',
    });
    const sBound = evaluateTaskState(db, task.task_id);
    assert.equal(sBound.status, STATES.WAITING, `绑定版本但无检查点应为 waiting，实际 ${sBound.status}`);

    // 反证 2：同一套机制在验收通过（未绑版本）后确实能给 completed，说明不是永远卡死。
    recordAcceptance(db, {
      taskId: task.task_id, attemptId: h.attempt.attempt_id,
      result: 'passed', command: 'npm test', report: 'all green',
    });
    const s3 = evaluateTaskState(db, task.task_id);
    assert.equal(s3.status, STATES.COMPLETED, `验收通过后应为 completed，实际 ${s3.status}`);
    await h.stop();
  });

  // 必验 1：重启恢复（真的换一个进程读同一个 DB 文件）
  await extra('重启恢复：换进程后 interrupted 仍是 interrupted', async () => {
    const restartPath = join(ROOT, 'restart.db');
    const rdb = openDb({ path: restartPath });
    const task = createTask(rdb, { title: '重启恢复', steps: ['实现'], source: 'selftest' });
    // 拿一个已经退出的真实 pid，模拟「DB 说在跑、进程已经没了」。
    const p = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
    const deadPid = p.pid;
    await new Promise((r) => p.on('close', r));
    createAttempt(rdb, {
      taskId: task.task_id, agentId: 'dsh', worktreePath: null,
      pid: deadPid, startedAt: new Date(Date.now() - 120000).toISOString(),
    });
    refreshTaskState(rdb, task.task_id);
    closeDb(rdb);

    const url = (p) => pathToFileURL(p).href;
    const script = `
      import { openDb, closeDb } from ${JSON.stringify(url(join(REPO_ROOT, 'web/lib/db.mjs')))};
      import { reconcileOrphanedAttempts } from ${JSON.stringify(url(join(REPO_ROOT, 'web/lib/attempts.mjs')))};
      import { refreshTaskState } from ${JSON.stringify(url(join(REPO_ROOT, 'web/lib/state-machine.mjs')))};
      const db = openDb({ path: process.env.AGENT_OFFICE_DB });
      reconcileOrphanedAttempts(db, {});
      const s = refreshTaskState(db, ${JSON.stringify(task.task_id)});
      const row = db.prepare('SELECT status FROM tasks WHERE task_id = ?').get(${JSON.stringify(task.task_id)});
      console.log(JSON.stringify({ status: s.status, persisted: row.status }));
      closeDb(db);
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: { ...process.env, AGENT_OFFICE_DB: restartPath },
      windowsHide: true,
    }).trim().split(/\r?\n/).pop();
    const parsed = JSON.parse(out);
    assert.equal(parsed.status, STATES.INTERRUPTED, `换进程后应为 interrupted，实际 ${parsed.status}`);
    assert.equal(parsed.persisted, STATES.INTERRUPTED, '持久化状态也必须是 interrupted');
    assert.notEqual(parsed.status, STATES.IDLE, '重启后绝不许变 idle');
  });

  // 必验 2：迁移幂等（连跑两次，count 不变，原 JSON 不删）
  await extra('迁移幂等：连跑两次 tasks 条数不变、原 JSON 保留', async () => {
    const legacyDir = join(ROOT, 'legacy-tasks');
    mkdirSync(legacyDir, { recursive: true });
    const legacyTask = {
      id: 'T-LEGACY-01',
      title: '历史任务·记账工具',
      createdAt: '2026-11-19T07:10:26.086Z',
      updatedAt: '2026-11-19T08:08:18.013Z',
      steps: {
        req: { status: 'done', at: '2026-11-19T07:10:26.131Z', note: '想法', files: [], by: 'Leo' },
        doc: { status: 'done', at: '2026-11-19T07:15:25.647Z', note: '文档', files: [{ path: 'C:/tmp/doc.md', bytes: 10, sha256: 'a'.repeat(64) }], by: 'Leo' },
        plan: { status: 'awaiting', at: '2026-11-19T08:07:53.942Z', note: '等确认', files: [], by: 'Leo' },
        final: { status: 'pending', at: null, note: '', files: [], by: null },
      },
    };
    const second = {
      id: 'T-LEGACY-02',
      title: '历史任务·喝水记录',
      createdAt: '2026-11-18T01:00:00.000Z',
      updatedAt: '2026-11-18T02:00:00.000Z',
      steps: { req: { status: 'pending', at: null, note: '', files: [] } },
    };
    const f1 = join(legacyDir, 'T-LEGACY-01.json');
    const f2 = join(legacyDir, 'T-LEGACY-02.json');
    writeFileSync(f1, JSON.stringify(legacyTask, null, 2));
    writeFileSync(f2, JSON.stringify(second, null, 2));
    const original1 = readFileSync(f1, 'utf8');

    const migrationDb = join(ROOT, 'legacy.db');
    const run = () => {
      const out = execFileSync(process.execPath, [MIGRATE_SCRIPT, '--source', legacyDir, '--db', migrationDb], {
        encoding: 'utf8', windowsHide: true,
      }).trim();
      return JSON.parse(out.split(/\r?\n/).filter(Boolean).pop());
    };
    const first = run();
    assert.equal(first.errors.length, 0, `第一次迁移有错误：${JSON.stringify(first.errors)}`);
    assert.equal(first.imported, 2);
    assert.equal(first.before, 0);
    assert.equal(first.after, 2);
    const secondRun = run();
    assert.equal(secondRun.errors.length, 0, `第二次迁移有错误：${JSON.stringify(secondRun.errors)}`);
    assert.equal(secondRun.skipped, 2, '第二次应全部跳过');
    assert.equal(secondRun.before, secondRun.after, '两次迁移之间条数必须不变');
    assert.equal(secondRun.after, 2, 'tasks 总数必须仍是 2');
    assert.equal(readFileSync(f1, 'utf8'), original1, '旧 JSON 必须原样保留');
    assert.ok(existsSync(f2), '旧 JSON 文件不能被删除');

    const mdb = openDb({ path: migrationDb });
    const rows = mdb.prepare('SELECT task_id, status FROM tasks ORDER BY task_id').all();
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.status === STATES.WAITING), `迁移后都应是 waiting，实际 ${JSON.stringify(rows)}`);
    assert.ok(rows.every((r) => r.status !== STATES.COMPLETED), '没有验收记录不能迁成 completed');
    const steps = mdb.prepare('SELECT COUNT(*) AS n FROM task_steps WHERE task_id = ?').get('T-LEGACY-01');
    assert.equal(steps.n, 4, '步骤必须迁全');
    const artifacts = countArtifacts(mdb, 'T-LEGACY-01');
    assert.equal(artifacts.count, 1, '旧步骤里的产物要迁成 artifact_produced 事件');
    closeDb(mdb);
  });

  // 必验 3：状态可追溯（从 events 表还原 interrupted 的来龙去脉）
  await extra('状态可追溯：能从 events 还原 interrupted', async () => {
    assert.ok(t03TaskId, 'T03 任务必须存在');
    const events = queryEvents(db, { taskId: t03TaskId, limit: 1000 });
    const types = events.map((e) => e.event_type);
    for (const needed of ['task_created', 'attempt_started', 'process_exit']) {
      assert.ok(types.includes(needed), `缺少事件 ${needed}，实际 ${JSON.stringify(types)}`);
    }
    const change = [...events].reverse().find((e) => e.event_type === 'status_changed' && e.payload.to === STATES.INTERRUPTED);
    assert.ok(change, '必须留下转成 interrupted 的 status_changed 事件');
    assert.ok(change.payload.reason && change.payload.reason.length > 0, '状态变化必须带理由');
    assert.ok(change.payload.evidence_source, '状态变化必须带证据来源');
    assert.ok(change.payload.evidence_observed_at, '状态变化必须带证据观测时间');
    const row = db.prepare('SELECT status FROM tasks WHERE task_id = ?').get(t03TaskId);
    assert.equal(row.status, STATES.INTERRUPTED);
  });
}

main()
  .catch((err) => {
    console.error('selftest 运行异常：', err);
    results.push({ id: 'FATAL', name: 'runner', ok: false, error: String(err && err.stack ? err.stack : err) });
  })
  .finally(async () => {
    await stopAll();
    console.log('');
    const required = results.filter((r) => /^T0[1-8]$/.test(r.id));
    const extras = results.filter((r) => r.id.startsWith('EX-'));
    const reqPass = required.filter((r) => r.ok).length;
    const exPass = extras.filter((r) => r.ok).length;
    for (const r of results) {
      if (!r.ok) console.log(`FAILED ${r.id}: ${r.error}`);
    }
    console.log(`规定测试: ${reqPass}/8 通过`);
    console.log(`附加必验: ${exPass}/3 通过`);
    const all = reqPass === 8 && exPass === 3;
    console.log(all ? 'P0 SELFTEST PASS' : 'P0 SELFTEST FAIL');

    try { closeDb(db); } catch { /* 已关闭 */ }
    if (!KEEP) {
      try { rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Windows 偶发占用 */ }
    } else {
      console.log(`现场保留: ${ROOT}`);
    }
    process.exitCode = all ? 0 : 1;
  });
