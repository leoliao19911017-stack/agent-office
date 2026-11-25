// TASK-任务归档 返工（run-3d22e663 · 05c）验收测试：C1-C8 逐条对应任务书的「新增验收标准」。
// 返工项来源：docs/runs/run-3d22e663/07-review.md（P1-1 ~ P1-4、P2-1 ~ P2-3）。
//
//   C1  切筛选后选择被清空，或提交的 ids 只有可见的            真实 DOM 点击 + 断言请求 ids
//   C2  已删除任务不能创建 attempt（含多进程竞态）              DELETE 后 POST attempt → 拒绝
//   C3  归档期间完成后恢复，状态 / 实例 / 可删除性一致          走完整路由序列
//   C4  事件写失败时主记录必须回滚                              注入失败 trigger
//   C5  停止动作能终止真实执行                                  起真实执行，点停止，验证进程 / attempt 结束
//   C6  删除后可重新列出并恢复                                  UI 操作 + DB 断言
//   C7  上一版 29 条（12 + 17）仍全过                           跑两个测试文件
//   C8  P2-3 并发锁：多进程首开同一个新库 / 并发升级            多进程并发验证
//   C9  界面用例全程没有未捕获的 JS 异常                        pageerror / console error
//   C10 旧后端保护：没重启时「停止」「回收站」禁用并说明        模拟 /api/tasks 响应里没有 api_features
//       （C9 / C10 不在任务书的 8 条里，是这次返工自己加的护栏）
//
// 第三轮返工（run-3d22e663 · 05d，评审 07-review-r2.md 的三个新问题）：
//   E1  停止确认绑 attempt_id：A 结束、B 接替后，旧确认改不了 B、放不了删除   接口级 A→B 回归
//   E2  界面：实例换了手，列表刷新后确认态自动作废                          DOM 断言 state.stopConfirm
//   E3  界面：两个 running（遗留形态）→ 停一个按钮还在 → 停剩余 → 能删除    单实例约束 + remaining_running
//   E4  详情接口状态同步的审计写失败 → 500，状态列一行不变                   注入 trigger
//   E5  上轮 56 条（12 + 17 + 27）不回归                                    由本文件全量跑 + C7 覆盖
//
// 隔离（不碰 data/agent-office.db、不抢 8090、不调用任何模型）：
//   - 接口用例：test/chat-harness.mjs 起真实 web/server.js 子进程（临时库 + stub 中台 + 随机端口）；
//   - 「查 DB」是这个临时库的第二个连接，接口说写了和库里真有必须同时成立；
//   - C5 托管停止：test/fixtures/tasks-rework-harness.mjs 在同一进程里挂生产路由 + 调生产执行器
//     startDshAttempt，起一个真实的长跑进程（test/fixtures/tasks-longrun-worker.mjs）；
//   - 界面用例：系统 Chrome（playwright-core），真实点击；默认打真实 web/server.js。
//
// 环境变量（都可选）：
//   TASKS_REWORK_WEB_DIR   界面用例改打进程内夹具，看板静态文件从这个目录读（前端先改在暂存目录里预演用）
//   TASKS_REWORK_SHOT_DIR  设了就把界面用例的关键画面截图存到这个目录（整页 1440×900@2x + 左栏裁切）
//
// 运行：node --no-warnings --test test/tasks-rework.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { closeDb, openDb, SCHEMA_VERSION } from '../web/lib/db.mjs';
import { createAttempt, endAttempt } from '../web/lib/attempts.mjs';
import { newAttemptId } from '../web/lib/tasks.mjs';
import { updateWorkflowRunStatus } from '../web/lib/workflow-db.mjs';
import { startChatServer } from './chat-harness.mjs';
import { startReworkServer } from './fixtures/tasks-rework-harness.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const TMP_ROOT = mkdtempSync(join(tmpdir(), 'tasks-rework-'));
const ORIGINAL_DB_ENV = process.env.AGENT_OFFICE_DB;
const STAGE_WEB_DIR = process.env.TASKS_REWORK_WEB_DIR || null;
const SHOT_DIR = process.env.TASKS_REWORK_SHOT_DIR || null;

let server = null;   // 共用的真实服务（接口用例）
let raw = null;      // 这个临时库的第二个连接（查库 / 注入 trigger）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  // 保险：任何模块若在用例之外调用 getDb()，也只能落到临时目录。
  process.env.AGENT_OFFICE_DB = join(TMP_ROOT, 'unused.db');
  if (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true });
  server = await startChatServer();
  assert.ok(server.dbPath.startsWith(tmpdir()), `测试库必须在临时目录：${server.dbPath}`);
  raw = new DatabaseSync(server.dbPath);
  raw.exec('PRAGMA busy_timeout = 5000');
});

after(async () => {
  try { if (raw) raw.close(); } catch { /* 已关 */ }
  try {
    if (server) await server.stop();
  } finally {
    try { if (browser) await browser.close(); } catch { /* 已关 */ }
    if (ORIGINAL_DB_ENV === undefined) delete process.env.AGENT_OFFICE_DB;
    else process.env.AGENT_OFFICE_DB = ORIGINAL_DB_ENV;
    rmSync(TMP_ROOT, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function callerOf(base) {
  return async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* 非 JSON 保留 null */ }
    return { status: res.status, body: json };
  };
}

const call = (method, path, body) => callerOf(server.base)(method, path, body);

async function newTask(title, extra = {}) {
  const r = await call('POST', '/api/tasks', { title, ...extra });
  assert.equal(r.status, 201, `建任务必须 201，实际 ${r.status}：${JSON.stringify(r.body)}`);
  return r.body.task.task_id;
}

/** 通过真实 attempt 接口声明一次执行（不带 pid = 外部声明的实例，本服务没有它的进程）。 */
function startAttempt(taskId, body = { agent_id: 'dsh' }) {
  return call('POST', `/api/tasks/${taskId}/attempt`, body);
}

function rowOf(handle, taskId) {
  const row = handle.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
  return row ? { ...row } : null;
}

function runningAttemptsOf(handle, taskId) {
  return handle.prepare("SELECT * FROM attempts WHERE task_id = ? AND status = 'running' ORDER BY attempt_id").all(taskId).map((r) => ({ ...r }));
}

/** 当前（最新的一个）running 实例的 attempt_id —— 停止确认要绑定的目标（与 runningAttemptOf 同序）。 */
function attemptIdOf(handle, taskId) {
  const row = handle.prepare("SELECT attempt_id FROM attempts WHERE task_id = ? AND status = 'running' ORDER BY started_at DESC, attempt_id DESC LIMIT 1").get(taskId);
  return row ? row.attempt_id : null;
}

function attemptCountOf(handle, taskId) {
  return handle.prepare('SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?').get(taskId).n;
}

function eventsOf(handle, taskId, type) {
  return handle.prepare('SELECT * FROM events WHERE task_id = ? AND event_type = ? ORDER BY event_id ASC')
    .all(taskId, type).map((r) => ({ ...r }));
}

function payloadOf(eventRow) {
  return eventRow && eventRow.payload ? JSON.parse(eventRow.payload) : null;
}

function acceptancesOf(handle, taskId) {
  return handle.prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND event_type IN ('acceptance_passed','acceptance_failed')")
    .get(taskId).n;
}

function pidAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch (err) { return Boolean(err && err.code === 'EPERM'); }
}

/** 起一个真实的、什么都不干的长驻进程，充当「别处启动的执行器」（pid 登记到 attempt 上）。 */
function spawnSleeper() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  const exited = new Promise((r) => child.once('exit', r));
  return {
    pid: child.pid,
    exited,
    async kill() {
      if (child.exitCode == null && child.signalCode == null) child.kill();
      await Promise.race([exited, sleep(5000)]);
    },
  };
}

/** 只读打开某个用例自己的临时库，跑完就关。 */
function withReadOnly(dbPath, fn) {
  const handle = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return fn(handle);
  } finally {
    handle.close();
  }
}

// ---------------------------------------------------------------------------
// 界面工具
// ---------------------------------------------------------------------------
let browser = null;
const pageErrors = [];   // `${kind}: ${message}`，kind = real（真实 server.js）/ harness（进程内夹具）

async function newPage(kind) {
  if (!browser) {
    assert.ok(existsSync(CHROME), `找不到系统 Chrome：${CHROME}`);
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
  }
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  // 动作超时压到 10 秒：返工前的旧前端没有这些按钮，等待点不到时尽快失败，而不是每个用例干等 30 秒
  page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => pageErrors.push(`${kind}: ${String(e).slice(0, 300)}`));
  page.on('console', (m) => {
    // 夹具只挂任务 API，其它接口 404 会刷资源加载失败的 console 错误，与看板代码无关，不算
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) pageErrors.push(`${kind}: console: ${m.text().slice(0, 200)}`);
  });
  return page;
}

/**
 * 界面用例打哪个服务：默认是真实 web/server.js（静态文件从 web/ 读）；
 * 设了 TASKS_REWORK_WEB_DIR 就打进程内夹具（静态文件从暂存目录读，只有任务 API）。
 */
async function uiServer() {
  if (!STAGE_WEB_DIR) {
    const s = await startChatServer();
    return { kind: 'real', base: s.base, dbPath: s.dbPath, call: callerOf(s.base), stop: () => s.stop() };
  }
  const h = await startReworkServer({ webDir: STAGE_WEB_DIR });
  return { kind: 'harness', base: h.base, dbPath: h.dbPath, call: h.call, stop: () => h.stop() };
}

async function openBoard(page, base) {
  await page.goto(`${base}/board-cromma.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const list = document.querySelector('#task-list');
    return Boolean(list && (list.querySelector('.task-line') || list.querySelector('.task-empty')));
  }, null, { timeout: 20000 });
}

async function waitRows(page, n, timeout = 15000) {
  await page.waitForFunction((want) => document.querySelectorAll('#task-list .task-line').length === want, n, { timeout });
}

const lineSel = (taskId) => `.task-line[data-line="${taskId}"]`;
const actSel = (taskId, action) => `${lineSel(taskId)} [data-act="${action}"]`;

async function actText(page, taskId, action) {
  return (await page.locator(actSel(taskId, action)).first().textContent()).trim();
}

async function toastText(page) {
  return (await page.locator('#toast').textContent()).trim();
}

/** 等某个请求回来：返回 { status, json, sent }。sent 是请求体（没有则为 undefined）。 */
async function clickAwaiting(page, selector, match) {
  const waited = page.waitForResponse((res) => match(res), { timeout: 15000 });
  await page.locator(selector).first().click();
  const response = await waited;
  let json = null;
  try { json = await response.json(); } catch { /* 非 JSON */ }
  let sent;
  try { sent = response.request().postDataJSON(); } catch { sent = undefined; }
  return { status: response.status(), json, sent };
}

/** 等 toast 显示出匹配的文字（界面把一次写操作做完的信号）。 */
async function settle(page, re) {
  await page.waitForFunction((src) => {
    const t = document.querySelector('#toast');
    return Boolean(t && t.classList.contains('is-show') && new RegExp(src).test(t.textContent || ''));
  }, re.source, { timeout: 15000 });
}

async function shot(page, name) {
  if (!SHOT_DIR) return;
  await page.screenshot({ path: join(SHOT_DIR, name) });
  // 左栏裁切：272 × 900 CSS 像素，@2x 输出 544 × 1800
  await page.screenshot({ path: join(SHOT_DIR, name.replace(/\.png$/, '-rail.png')), clip: { x: 0, y: 0, width: 272, height: 900 } });
}

// ===========================================================================
// C1：切筛选后选择被清空；批量提交的 ids 只有当前可见的
// ===========================================================================
test('C1 切换状态筛选后选择被清空，批量归档只提交当前可见的 ids', { timeout: 120000 }, async () => {
  const ui = await uiServer();
  const page = await newPage(ui.kind);
  try {
    const mk = async (title) => (await ui.call('POST', '/api/tasks', { title })).body.task.task_id;
    const waitingId = await mk('C1 看不见的待执行任务');
    const runningId = await mk('C1 可见的执行中任务');
    assert.equal((await ui.call('POST', `/api/tasks/${runningId}/attempt`, { agent_id: 'dsh' })).status, 201);

    await openBoard(page, ui.base);
    await waitRows(page, 2);

    // 「全部」下勾选两条（一条 waiting、一条 running）
    await page.locator(`[data-pick="${waitingId}"]`).check();
    await page.locator(`[data-pick="${runningId}"]`).check();
    assert.equal(await page.locator('#task-batch').isVisible(), true, '勾选后批量条应出现');
    assert.equal((await page.locator('#task-batch-count').textContent()).trim(), '2');
    await shot(page, '01-c1-selected-two-in-all-1440x900@2x.png');

    // 切到「执行」：waiting 行消失，选择必须一起清空
    // （返工前：行没了，选择还在，批量条仍显示「已选 2 条」，点归档会把看不见的那条一起归档）
    await page.locator('[data-filter="running"]').click();
    await waitRows(page, 1);
    assert.equal(await page.locator(lineSel(waitingId)).count(), 0, 'waiting 行不应出现在「执行」下');
    assert.equal(await page.locator('#task-batch').isHidden(), true, '切筛选后批量条必须收起');
    assert.equal((await page.locator('#task-batch-count').textContent()).trim(), '0');
    assert.equal(await page.evaluate(() => state.selectedTaskIds.size), 0, '选择集合必须被清空');
    await shot(page, '02-c1-after-filter-switch-selection-cleared-1440x900@2x.png');

    // 重新勾选可见的 running 行
    await page.locator(`[data-pick="${runningId}"]`).check();
    assert.equal((await page.locator('#task-batch-count').textContent()).trim(), '1');
    // 纵深防御：就算选择集合里混进一条此刻不可见的 id（模拟将来别处漏清），提交时也只能带可见的
    await page.evaluate((id) => { state.selectedTaskIds.add(id); syncTaskSelectionUi(); }, waitingId);
    const batch = await clickAwaiting(
      page, '[data-batch="archive"]',
      (res) => res.url().endsWith('/api/tasks/batch') && res.request().method() === 'POST',
    );
    assert.equal(batch.status, 200, JSON.stringify(batch.json));
    assert.deepEqual(batch.sent.ids, [runningId], `批量请求只能带可见的 ids，实际 ${JSON.stringify(batch.sent.ids)}`);
    await page.waitForFunction(
      (id) => document.querySelector(`.task-line[data-line="${id}"]`)?.classList.contains('is-archived'),
      runningId, { timeout: 15000 },
    );

    withReadOnly(ui.dbPath, (db) => {
      const w = rowOf(db, waitingId);
      const r = rowOf(db, runningId);
      assert.equal(w.archived_at, null, '看不见的那条不许被批量归档');
      assert.equal(eventsOf(db, waitingId, 'task_archived').length, 0);
      assert.ok(r.archived_at, '可见的那条应被归档');
      assert.equal(batch.json.succeeded, 1);
    });
  } finally {
    await page.context().close();
    await ui.stop();
  }
});

test('C1b 在「执行」筛选下停掉一条已勾选的任务：它被筛出列表后，勾选跟着消失', { timeout: 120000 }, async () => {
  // 和 C1 是同一类问题的另一个来路：不是用户切了筛选，而是列表刷新后某一行不再符合当前筛选
  //（执行中 → 已停止）。勾选如果还留着，批量条就会挂着一个看不见的计数。
  const ui = await uiServer();
  const page = await newPage(ui.kind);
  try {
    const id = (await ui.call('POST', '/api/tasks', { title: 'C1b 执行筛选下要停掉的任务' })).body.task.task_id;
    assert.equal((await ui.call('POST', `/api/tasks/${id}/attempt`, { agent_id: 'dsh' })).status, 201);
    const stopMatch = (res) => res.url().endsWith(`/api/tasks/${id}/stop`) && res.request().method() === 'POST';

    await openBoard(page, ui.base);
    await waitRows(page, 1);
    await page.locator('[data-filter="running"]').click();
    await waitRows(page, 1);
    await page.locator(`[data-pick="${id}"]`).check();
    assert.equal(await page.locator('#task-batch').isVisible(), true);
    assert.equal((await page.locator('#task-batch-count').textContent()).trim(), '1');

    // 停掉它（声明式实例：第一次点要求确认，第二次带 confirm）
    const first = await clickAwaiting(page, actSel(id, 'stop'), stopMatch);
    assert.equal(first.status, 409, JSON.stringify(first.json));
    const second = await clickAwaiting(page, actSel(id, 'stop'), stopMatch);
    assert.equal(second.status, 200, JSON.stringify(second.json));
    await waitRows(page, 0);
    assert.equal(await page.locator('#task-batch').isHidden(), true, '被筛走的那一条不许还挂在批量条上');
    assert.equal(await page.evaluate(() => state.selectedTaskIds.size), 0);
    await shot(page, '02b-c1b-stopped-under-running-filter-selection-pruned-1440x900@2x.png');
  } finally {
    await page.context().close();
    await ui.stop();
  }
});

// ===========================================================================
// C2：已软删的任务不能创建执行实例
// ===========================================================================
test('C2 已软删的任务不能再开始执行：attempt / handoff / finish / checkpoint 一律 409 TASK_DELETED', { timeout: 60000 }, async () => {
  // --- 先删后启动 ---
  const deletedId = await newTask('C2 删除后不许再执行');
  const del = await call('DELETE', `/api/tasks/${deletedId}`, { actor: 'test:c2' });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  const att = await startAttempt(deletedId);
  assert.equal(att.status, 409, `已删除任务 POST attempt 必须 409，实际 ${att.status}：${JSON.stringify(att.body)}`);
  assert.equal(att.body.code, 'TASK_DELETED');
  assert.equal(attemptCountOf(raw, deletedId), 0, '拒绝后不许留下执行实例');
  assert.equal(rowOf(raw, deletedId).status, 'waiting', '拒绝启动不许改任务状态');

  // --- 有过执行、已完成的任务：删掉之后，另外三个执行入口同样要拒 ---
  const doneId = await newTask('C2 完成后删除');
  assert.equal((await startAttempt(doneId)).status, 201);
  assert.equal((await call('POST', `/api/tasks/${doneId}/finish`, { evidence: 'docs/runs/run-3d22e663/07-review.md', result: 'passed' })).status, 200);
  assert.equal((await call('DELETE', `/api/tasks/${doneId}`, { actor: 'test:c2' })).status, 200);
  const before = { attempts: attemptCountOf(raw, doneId), status: rowOf(raw, doneId).status };

  const rejected = {
    handoff: await call('POST', `/api/tasks/${doneId}/handoff`, { to_agent_id: 'claude', worktree_path: TMP_ROOT }),
    finish: await call('POST', `/api/tasks/${doneId}/finish`, { evidence: 'x', result: 'passed' }),
    checkpoint: await call('POST', `/api/tasks/${doneId}/checkpoint`, { worktree_path: TMP_ROOT }),
    attempt: await startAttempt(doneId),
  };
  for (const [name, r] of Object.entries(rejected)) {
    assert.equal(r.status, 409, `${name} 对已删除任务必须 409，实际 ${r.status}：${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, 'TASK_DELETED', `${name} 的错误码必须是 TASK_DELETED，实际 ${JSON.stringify(r.body)}`);
  }
  assert.equal(attemptCountOf(raw, doneId), before.attempts, '四个入口被拒后不许多出执行实例');
  assert.equal(runningAttemptsOf(raw, doneId).length, 0);
  assert.equal(rowOf(raw, doneId).status, before.status);
  assert.equal(acceptancesOf(raw, doneId), 1, '被拒的 finish 不许再写验收结论');
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM checkpoints WHERE task_id = ?').get(doneId).n, 0, '被拒的 checkpoint 不许落库');
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM write_owner WHERE task_id = ?').get(doneId).n, 0, '被拒的 handoff 不许留下写入权记录');

  // --- 恢复之后可以重新执行：拦的是「已删除」，不是把任务判死 ---
  assert.equal((await call('POST', `/api/tasks/${doneId}/restore`, { actor: 'test:c2' })).status, 200);
  const again = await startAttempt(doneId);
  assert.equal(again.status, 201, `恢复后应能重新开始执行，实际 ${again.status}：${JSON.stringify(again.body)}`);
});

test('C2b 先删后启动的多进程竞态：删除与启动同时到达，恰好一方成功，不留「已删除却在运行」的任务', { timeout: 120000 }, async (t) => {
  // 第二个真实服务进程，指向同一个临时库（两个进程各有一条连接，才会真撞车）
  const other = await startChatServer({ home: server.home, dbPath: server.dbPath, keepHome: true });
  const callOther = callerOf(other.base);
  try {
    const ROUNDS = 60;
    const outcomes = { deleteWon: 0, attemptWon: 0, both: 0, neither: 0 };
    const violations = [];
    for (let i = 0; i < ROUNDS; i += 1) {
      const id = await newTask(`C2b 竞态 ${i}`);
      const [del, att] = await Promise.all([
        call('DELETE', `/api/tasks/${id}`, { actor: 'test:c2b' }),
        callOther('POST', `/api/tasks/${id}/attempt`, { agent_id: 'dsh' }),
      ]);
      const delOk = del.status === 200;
      const attOk = att.status === 201;
      const round = { i, delete: del.status, deleteCode: del.body?.code, attempt: att.status, attemptCode: att.body?.code };
      if (delOk && attOk) {
        outcomes.both += 1;
        violations.push({ ...round, why: '删除和启动同时成功' });
      } else if (delOk) {
        outcomes.deleteWon += 1;
        if (att.body?.code !== 'TASK_DELETED') violations.push({ ...round, why: '删除成功时启动应被 TASK_DELETED 拒绝' });
      } else if (attOk) {
        outcomes.attemptWon += 1;
        if (del.body?.code !== 'TASK_RUNNING') violations.push({ ...round, why: '启动成功时删除应被 TASK_RUNNING 拒绝' });
      } else {
        outcomes.neither += 1;
        violations.push({ ...round, why: '两个都没成功' });
      }
      // 库里的结果必须和响应一致
      const row = rowOf(raw, id);
      const n = attemptCountOf(raw, id);
      if (delOk) {
        if (!row.deleted_at || n !== 0) violations.push({ ...round, why: '删除成功，但库里不是「已删且无实例」', attempts: n });
      } else if (attOk && (!row.deleted_at && n !== 1)) {
        violations.push({ ...round, why: '启动成功，但库里不是「未删且有 1 个实例」', attempts: n });
      }
    }
    const hidden = raw.prepare(
      "SELECT COUNT(*) AS n FROM attempts a JOIN tasks t ON t.task_id = a.task_id WHERE t.deleted_at IS NOT NULL AND a.status = 'running'",
    ).get().n;
    t.diagnostic(`C2b ${ROUNDS} 轮：删除先赢 ${outcomes.deleteWon}，启动先赢 ${outcomes.attemptWon}，同时成功 ${outcomes.both}，都失败 ${outcomes.neither}；库里「已删除却在运行」${hidden} 条`);
    assert.equal(hidden, 0, '库里不许有「已删除却在运行」的执行实例');
    assert.deepEqual(violations, [], `竞态出现不一致：${JSON.stringify(violations.slice(0, 5))}`);
    assert.equal(outcomes.neither, 0, '每一轮都必须恰好有一方成功');
  } finally {
    await other.stop();
  }
});

// ===========================================================================
// C3：归档期间完成后恢复，状态 / 实例 / 可删除性一致
// ===========================================================================
test('C3 running → 归档 → finish passed → restore：状态、实例、可删除性一致，恢复不伪造活跃实例', { timeout: 60000 }, async () => {
  const id = await newTask('C3 归档期间完成');
  assert.equal((await startAttempt(id)).status, 201);
  assert.equal((await call('POST', `/api/tasks/${id}/archive`, { actor: 'test:c3' })).status, 200);
  assert.equal((await call('POST', `/api/tasks/${id}/finish`, { evidence: 'docs/runs/run-3d22e663/07-review.md', result: 'passed' })).status, 200);
  assert.equal(rowOf(raw, id).status, 'completed', '归档期间执行完成，库里应已是 completed');

  const restore = await call('POST', `/api/tasks/${id}/restore`, { actor: 'test:c3' });
  assert.equal(restore.status, 200, JSON.stringify(restore.body));
  assert.equal(restore.body.status, 'completed', `恢复响应里的当前状态应是 completed，实际 ${restore.body.status}`);

  const row = rowOf(raw, id);
  assert.equal(row.status, 'completed', `库里 status 必须是 completed，实际 ${row.status}`);
  assert.equal(row.archived_at, null);
  assert.equal(row.archived_from, null);

  const detail = await call('GET', `/api/tasks/${id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.state.status, 'completed', '详情 state');
  assert.equal(detail.body.view.status, 'completed', '详情 view');
  assert.equal(detail.body.task.status, 'completed', '详情 task（库里的状态列）');
  assert.equal(detail.body.state.active_attempt_id, null, '恢复不许伪造一个活跃实例');
  assert.equal(detail.body.view.active_attempt_id, null);
  assert.equal(detail.body.attempts.some((a) => a.status === 'running'), false, '不许有 running 的执行实例');

  const list = await call('GET', '/api/tasks');
  const item = list.body.tasks.find((x) => x.task_id === id);
  assert.ok(item, '恢复后任务回到默认列表');
  assert.equal(item.status, 'completed');
  assert.equal(item.active_attempt_id, null);

  const ev = payloadOf(eventsOf(raw, id, 'task_restored')[0]);
  assert.ok(ev, '恢复要写 task_restored 事件');
  assert.equal(ev.status_restored, 'running', '事件写明：按 archived_from 写回的是 running');
  assert.equal(ev.status_after, 'completed', '事件写明：按最新执行证据重算后是 completed');
  assert.equal(ev.actor, 'test:c3');

  // 完成后还能再开一次新执行（恢复没有留下假的活跃实例挡路）
  assert.equal((await startAttempt(id)).status, 201, '恢复后应能重新开始执行');
  // 新实例在跑 → 又不能删
  const delRunning = await call('DELETE', `/api/tasks/${id}`, { actor: 'test:c3' });
  assert.equal(delRunning.status, 409);
  assert.equal(delRunning.body.code, 'TASK_RUNNING');
});

test('C3b running → 归档 → 停止 → restore：恢复后是「已中断」，不是「执行中」，可以删除', { timeout: 60000 }, async () => {
  const id = await newTask('C3b 归档期间停止');
  assert.equal((await startAttempt(id)).status, 201);
  assert.equal((await call('POST', `/api/tasks/${id}/archive`, {})).status, 200);
  // 声明式实例（没有 pid）：本服务无法观测进程，必须显式 confirm 才记为用户停止。
  // 确认要绑到 409 响应里给的 attempt_id（R2-1：不带 id 的 confirm 是 400）
  const noConfirm = await call('POST', `/api/tasks/${id}/stop`, { actor: 'test:c3b' });
  assert.equal(noConfirm.status, 409, JSON.stringify(noConfirm.body));
  assert.equal(noConfirm.body.code, 'STOP_UNVERIFIED');
  assert.equal(noConfirm.body.attempt_id, attemptIdOf(raw, id), '409 响应体必须带结构化 attempt_id（R2-1）');
  assert.equal(runningAttemptsOf(raw, id).length, 1, '没确认之前不许动实例');
  const unbound = await call('POST', `/api/tasks/${id}/stop`, { actor: 'test:c3b', confirm: true });
  assert.equal(unbound.status, 400, JSON.stringify(unbound.body));
  assert.equal(unbound.body.code, 'STOP_CONFIRM_REQUIRES_ATTEMPT', '不带 attempt_id 的 confirm 一律 400（R2-1）');
  const stopped = await call('POST', `/api/tasks/${id}/stop`, {
    actor: 'test:c3b', confirm: true, attempt_id: noConfirm.body.attempt_id,
  });
  assert.equal(stopped.status, 200, JSON.stringify(stopped.body));

  const restore = await call('POST', `/api/tasks/${id}/restore`, { actor: 'test:c3b' });
  assert.equal(restore.status, 200, JSON.stringify(restore.body));
  assert.equal(restore.body.status, 'interrupted');
  assert.equal(rowOf(raw, id).status, 'interrupted');
  assert.equal(runningAttemptsOf(raw, id).length, 0);

  const del = await call('DELETE', `/api/tasks/${id}`, { actor: 'test:c3b' });
  assert.equal(del.status, 200, `停止后恢复的任务必须能删，实际 ${del.status}：${JSON.stringify(del.body)}`);
  assert.ok(rowOf(raw, id).deleted_at);
});

test('C3c 归档期间进程消失 → restore：恢复后不是 running，可以删除', { timeout: 60000 }, async () => {
  const sleeper = spawnSleeper();
  try {
    const id = await newTask('C3c 归档期间进程消失');
    assert.equal((await startAttempt(id, { agent_id: 'dsh', pid: sleeper.pid })).status, 201);
    assert.equal(rowOf(raw, id).status, 'running');
    assert.equal((await call('POST', `/api/tasks/${id}/archive`, {})).status, 200);
    await sleeper.kill();

    const restore = await call('POST', `/api/tasks/${id}/restore`, { actor: 'test:c3c' });
    assert.equal(restore.status, 200, JSON.stringify(restore.body));
    assert.equal(restore.body.status, 'interrupted', `进程已经没了，恢复后应是 interrupted，实际 ${restore.body.status}`);
    assert.equal(rowOf(raw, id).status, 'interrupted');
    assert.equal(runningAttemptsOf(raw, id).length, 0, '进程消失的实例不许还写着 running');

    const del = await call('DELETE', `/api/tasks/${id}`, { actor: 'test:c3c' });
    assert.equal(del.status, 200, `实际 ${del.status}：${JSON.stringify(del.body)}`);
  } finally {
    await sleeper.kill();
  }
});

test('C3d 删除守卫读执行证据，不读可能过期的 status 列：status=running 但没有运行中的实例 → 能删', { timeout: 60000 }, async () => {
  // 模拟返工前 restore 留下的坏行（线上库里已经有这种行）：状态列写着 running，实际没有任何实例在跑
  const id = await newTask('C3d 状态列过期');
  assert.equal((await startAttempt(id)).status, 201);
  assert.equal((await call('POST', `/api/tasks/${id}/finish`, { evidence: 'docs/runs/run-3d22e663/07-review.md', result: 'passed' })).status, 200);
  raw.prepare("UPDATE tasks SET status = 'running', status_reason = '返工前 restore 写回的旧值' WHERE task_id = ?").run(id);
  assert.equal(rowOf(raw, id).status, 'running');
  assert.equal(runningAttemptsOf(raw, id).length, 0);

  const detail = await call('GET', `/api/tasks/${id}`);
  assert.equal(detail.body.state.status, 'completed', '实时状态按证据算：completed');
  assert.equal(detail.body.task.status, 'completed', '读详情时把过期的状态列对齐到证据');

  const del = await call('DELETE', `/api/tasks/${id}`, { actor: 'test:c3d' });
  assert.equal(del.status, 200, `没有运行中的实例就必须能删，实际 ${del.status}：${JSON.stringify(del.body)}`);
  assert.ok(rowOf(raw, id).deleted_at);
});

// ===========================================================================
// C4：事件写失败时主记录必须回滚
// ===========================================================================
test('C4 归档 / 恢复 / 删除的事件写失败 → 500，且主记录一行都不变；批量仍逐条事务、允许部分失败', { timeout: 60000 }, async () => {
  const snapshot = (id) => {
    const r = rowOf(raw, id);
    return {
      archived_at: r.archived_at, archived_from: r.archived_from, deleted_at: r.deleted_at,
      status: r.status, status_reason: r.status_reason, updated_at: r.updated_at,
    };
  };
  const cases = [
    { name: 'archive', eventType: 'task_archived', setup: null, run: (id) => call('POST', `/api/tasks/${id}/archive`, { actor: 'test:c4' }) },
    { name: 'restore', eventType: 'task_restored', setup: (id) => call('POST', `/api/tasks/${id}/archive`, {}), run: (id) => call('POST', `/api/tasks/${id}/restore`, { actor: 'test:c4' }) },
    { name: 'delete', eventType: 'task_deleted', setup: null, run: (id) => call('DELETE', `/api/tasks/${id}`, { actor: 'test:c4' }) },
  ];
  for (const c of cases) {
    const id = await newTask(`C4 ${c.name} 事件写失败`);
    if (c.setup) assert.equal((await c.setup(id)).status, 200);
    const before = snapshot(id);
    raw.exec(`CREATE TRIGGER rework_fail_event BEFORE INSERT ON events WHEN NEW.event_type = '${c.eventType}' BEGIN SELECT RAISE(ABORT, 'rework: injected audit failure'); END`);
    let res;
    try {
      res = await c.run(id);
    } finally {
      raw.exec('DROP TRIGGER rework_fail_event');
    }
    assert.equal(res.status, 500, `${c.name}：事件写失败必须报错，实际 ${res.status}：${JSON.stringify(res.body)}`);
    const after = snapshot(id);
    assert.deepEqual(after, before, `${c.name}：事件写失败后主记录必须原样（前 ${JSON.stringify(before)}，后 ${JSON.stringify(after)}）`);
    assert.equal(eventsOf(raw, id, c.eventType).length, 0, `${c.name}：被拒的事件不许留下`);
  }

  // 对照组：没有 trigger 拦着时同样的操作能成功 —— 证明上面不是「反正都不会写」
  const okId = await newTask('C4 对照组');
  assert.equal((await call('POST', `/api/tasks/${okId}/archive`, { actor: 'test:c4' })).status, 200);
  assert.ok(rowOf(raw, okId).archived_at);
  assert.equal(eventsOf(raw, okId, 'task_archived').length, 1);

  // 批量：只拦其中一条任务的归档事件 → 那条失败且主记录没动，另一条成功且真的写了
  const bad = await newTask('C4 批量里被拦的那条');
  const good = await newTask('C4 批量里正常的另一条');
  raw.exec(`CREATE TRIGGER rework_fail_one BEFORE INSERT ON events WHEN NEW.event_type = 'task_archived' AND NEW.task_id = '${bad}' BEGIN SELECT RAISE(ABORT, 'rework: injected'); END`);
  let batch;
  try {
    batch = await call('POST', '/api/tasks/batch', { action: 'archive', ids: [bad, good], actor: 'test:c4' });
  } finally {
    raw.exec('DROP TRIGGER rework_fail_one');
  }
  assert.equal(batch.status, 200, JSON.stringify(batch.body));
  const byId = Object.fromEntries(batch.body.results.map((x) => [x.task_id, x]));
  assert.equal(byId[bad].ok, false, '事件被拦的那条必须报失败');
  assert.equal(byId[good].ok, true, '另一条不受影响');
  assert.equal(batch.body.succeeded, 1);
  assert.equal(batch.body.failed, 1);
  assert.equal(rowOf(raw, bad).archived_at, null, '报失败的那条：主记录必须没动（逐条结果与实际写入一致）');
  assert.ok(rowOf(raw, good).archived_at, '报成功的那条：真的写进去了');
});

test('C4b 托管停止：停止请求的审计事件写不进去 → 500，进程不动、实例仍是 running、没有事件', { timeout: 90000 }, async () => {
  // 进程一旦被杀撤不回来，所以托管停止是「先记审计、再动手」：审计写失败就必须什么都没发生。
  const fx = await startReworkServer();
  try {
    const id = (await fx.call('POST', '/api/tasks', { title: 'C4b 停止审计写失败' })).body.task.task_id;
    const { handle, stateFile } = await fx.startManaged(id);
    assert.equal(handle.ok, true, `托管执行没起来：${handle.error}`);
    const t0 = Date.now();
    while (!existsSync(stateFile) && Date.now() - t0 < 8000) await sleep(50);
    const attemptId = handle.attempt.attempt_id;

    const raw2 = new DatabaseSync(fx.dbPath);
    raw2.exec('PRAGMA busy_timeout = 5000');
    let refused;
    try {
      raw2.exec("CREATE TRIGGER rework_fail_stop BEFORE INSERT ON events WHEN NEW.event_type = 'task_stopped' BEGIN SELECT RAISE(ABORT, 'rework: injected stop audit failure'); END");
      refused = await fx.call('POST', `/api/tasks/${id}/stop`, { actor: 'test:c4b' });
    } finally {
      raw2.exec('DROP TRIGGER rework_fail_stop');
    }
    assert.equal(refused.status, 500, JSON.stringify(refused.body));
    assert.equal(pidAlive(handle.pid), true, '审计没写进去，进程不许被动过');
    const still = fx.db.prepare('SELECT status, end_reason FROM attempts WHERE attempt_id = ?').get(attemptId);
    assert.equal(still.status, 'running');
    assert.equal(eventsOf(fx.db, id, 'task_stopped').length, 0, '被拒的事件不许留下');
    assert.equal((fx.liveAttempts() || []).some((x) => x.attempt_id === attemptId), true, '实例仍在执行器的在跑登记表里');

    // 拿掉故障注入后，同样的停止能成功
    const stop = await fx.call('POST', `/api/tasks/${id}/stop`, { actor: 'test:c4b' });
    assert.equal(stop.status, 200, JSON.stringify(stop.body));
    assert.equal(stop.body.verified, true);
    assert.equal(pidAlive(handle.pid), false);
    const ended = fx.db.prepare('SELECT status, end_reason FROM attempts WHERE attempt_id = ?').get(attemptId);
    assert.equal(ended.status, 'interrupted');
    assert.equal(ended.end_reason, 'user_stop');
    assert.equal(eventsOf(fx.db, id, 'task_stopped').length, 1);
    raw2.close();
  } finally {
    await fx.stop();
  }
});

// ===========================================================================
// C5：停止动作能终止真实执行
// ===========================================================================
test('C5 托管执行：POST stop 走执行器的停止路径，进程真的退出、实例落成 user_stop，之后才能删', { timeout: 90000 }, async (t) => {
  const fx = await startReworkServer();
  try {
    const id = (await fx.call('POST', '/api/tasks', { title: 'C5 托管的长跑执行' })).body.task.task_id;
    const { handle, pidFile, stateFile } = await fx.startManaged(id);
    assert.equal(handle.ok, true, `托管执行没起来：${handle.error}`);
    const attemptId = handle.attempt.attempt_id;
    const pid = handle.pid;
    assert.ok(pid && pidAlive(pid), '托管进程必须真的在跑');

    // 等它真的开始输出，确认不是「起了个空壳」
    const t0 = Date.now();
    while (!existsSync(stateFile) && Date.now() - t0 < 8000) await sleep(50);
    assert.equal(Number(readFileSync(pidFile, 'utf8')), pid, '夹具进程登记的 pid 必须就是执行器记下的 pid');
    const seqBefore = Number(readFileSync(stateFile, 'utf8'));
    await sleep(450);
    assert.ok(Number(readFileSync(stateFile, 'utf8')) > seqBefore, '停止前它应该还在持续输出事件');

    // 在跑 → 不能删
    const delBefore = await fx.call('DELETE', `/api/tasks/${id}`, { actor: 'test:c5' });
    assert.equal(delBefore.status, 409, JSON.stringify(delBefore.body));
    assert.equal(delBefore.body.code, 'TASK_RUNNING');

    const stop = await fx.call('POST', `/api/tasks/${id}/stop`, { actor: 'test:c5' });
    assert.equal(stop.status, 200, JSON.stringify(stop.body));
    assert.equal(stop.body.stopped, true);
    assert.equal(stop.body.verified, true, '托管停止必须等到确认');
    assert.equal(stop.body.mode, 'managed');
    assert.equal(stop.body.process_alive, false);
    assert.equal(stop.body.attempt.attempt_id, attemptId);

    // 进程：真的没了，而且不再有新输出
    assert.equal(pidAlive(pid), false, `停止后 pid ${pid} 必须已经退出`);
    const seqAtStop = Number(readFileSync(stateFile, 'utf8'));
    await sleep(600);
    assert.equal(Number(readFileSync(stateFile, 'utf8')), seqAtStop, '停止后不许再有新输出');

    // 实例：落成 interrupted / user_stop，有 process_exit
    const row = fx.db.prepare('SELECT * FROM attempts WHERE attempt_id = ?').get(attemptId);
    assert.equal(row.status, 'interrupted');
    assert.equal(row.end_reason, 'user_stop');
    assert.ok(row.ended_at);
    const exit = fx.db.prepare("SELECT * FROM events WHERE attempt_id = ? AND event_type = 'process_exit' ORDER BY event_id DESC LIMIT 1").get(attemptId);
    assert.ok(exit, '执行器要写 process_exit');
    assert.equal(JSON.parse(exit.payload).stop_mode, 'user_stop');
    const stoppedEv = fx.db.prepare("SELECT * FROM events WHERE task_id = ? AND event_type = 'task_stopped'").get(id);
    assert.ok(stoppedEv, '停止要写操作事件（谁、何时）');
    assert.equal(stoppedEv.agent_id, 'test:c5');

    // 注册表里不再有它；任务状态是「已中断」，没有活跃实例
    const live = fx.liveAttempts() || [];
    assert.equal(live.some((x) => x.attempt_id === attemptId), false, '停止后执行器注册表必须清掉这条');
    const detail = await fx.call('GET', `/api/tasks/${id}`);
    assert.equal(detail.body.state.status, 'interrupted');
    assert.equal(detail.body.state.active_attempt_id, null);

    // 没有验收结论 —— 停止不是 finish
    assert.equal(acceptancesOf(fx.db, id), 0);
    assert.notEqual(rowOf(fx.db, id).status, 'completed');

    // 幂等：没有在跑的实例时再停一次，仍是成功
    const again = await fx.call('POST', `/api/tasks/${id}/stop`, { actor: 'test:c5' });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.already_stopped, true);

    // 停了之后才能删
    const del = await fx.call('DELETE', `/api/tasks/${id}`, { actor: 'test:c5' });
    assert.equal(del.status, 200, `停止后必须能删，实际 ${del.status}：${JSON.stringify(del.body)}`);
    assert.ok(rowOf(fx.db, id).deleted_at);
    t.diagnostic(`C5 托管执行 pid=${pid} attempt=${attemptId}：停止后 600ms 内输出计数停在 ${seqAtStop}；实例 ${row.status}/${row.end_reason}`);
  } finally {
    await fx.stop();
  }
});

test('C5b 界面：别处启动、登记了 pid 的执行 → 本服务不代杀，给出可操作的停止路径；进程退出后确认并允许删除', { timeout: 120000 }, async () => {
  const ui = await uiServer();
  const page = await newPage(ui.kind);
  const sleeper = spawnSleeper();
  try {
    const id = (await ui.call('POST', '/api/tasks', { title: 'C5b 别处启动的执行（有 pid）' })).body.task.task_id;
    assert.equal((await ui.call('POST', `/api/tasks/${id}/attempt`, { agent_id: 'claude', pid: sleeper.pid })).status, 201);
    const stopMatch = (res) => res.url().endsWith(`/api/tasks/${id}/stop`) && res.request().method() === 'POST';
    const deleteMatch = (res) => res.url().endsWith(`/api/tasks/${id}`) && res.request().method() === 'DELETE';

    await openBoard(page, ui.base);
    await waitRows(page, 1);
    assert.equal(await page.locator(actSel(id, 'stop')).count(), 1, '有执行实例在跑的行必须有「停止」按钮');
    await shot(page, '03-c5b-row-with-stop-button-1440x900@2x.png');

    // 在跑 → 删除被拒
    const del = await clickAwaiting(page, actSel(id, 'delete'), deleteMatch);
    assert.equal(del.status, 409, JSON.stringify(del.json));
    await settle(page, /先停止/);
    assert.match(await toastText(page), /先停止/, '删除被拒的提示要指向「先停止」');
    assert.equal(withReadOnly(ui.dbPath, (db) => rowOf(db, id).deleted_at), null);

    // 点停止：进程不是本服务启动的 → 不代杀，告诉用户怎么办
    const first = await clickAwaiting(page, actSel(id, 'stop'), stopMatch);
    assert.equal(first.status, 409, JSON.stringify(first.json));
    assert.equal(first.json.code, 'STOP_NOT_MANAGED');
    await settle(page, /不是本服务启动/);
    assert.equal(pidAlive(sleeper.pid), true, '本服务不许代杀别人的进程');
    assert.equal(await actText(page, id, 'stop'), '停止', '这种情形不能靠「确认」绕过，按钮不该变成确认态');
    await shot(page, '04-c5b-stop-refused-not-managed-1440x900@2x.png');

    // 用户在它自己的终端里停掉它（这里直接结束这个进程）
    await sleeper.kill();
    assert.equal(pidAlive(sleeper.pid), false);

    // 再点一次停止：本服务确认进程已退出，实例落成中断
    const second = await clickAwaiting(page, actSel(id, 'stop'), stopMatch);
    assert.equal(second.status, 200, JSON.stringify(second.json));
    assert.equal(second.json.stopped, true);
    await page.waitForFunction((sel) => !document.querySelector(sel), actSel(id, 'stop'), { timeout: 15000 });
    await shot(page, '05-c5b-after-process-exited-1440x900@2x.png');

    // 现在能删了
    const del2 = await clickAwaiting(page, actSel(id, 'delete'), deleteMatch);
    assert.equal(del2.status, 200, JSON.stringify(del2.json));
    withReadOnly(ui.dbPath, (db) => {
      assert.ok(rowOf(db, id).deleted_at, '停止确认后删除必须成功');
      assert.equal(db.prepare('SELECT status FROM attempts WHERE task_id = ?').get(id).status, 'interrupted');
    });
  } finally {
    await sleeper.kill();
    await page.context().close();
    await ui.stop();
  }
});

test('C5c 界面：别处启动、没登记 pid 的执行 → 必须二次确认才记为「用户停止」（不写验收），之后才能删', { timeout: 120000 }, async () => {
  const ui = await uiServer();
  const page = await newPage(ui.kind);
  try {
    const id = (await ui.call('POST', '/api/tasks', { title: 'C5c 别处启动的执行（无 pid）' })).body.task.task_id;
    assert.equal((await ui.call('POST', `/api/tasks/${id}/attempt`, { agent_id: 'claude' })).status, 201);
    const stopMatch = (res) => res.url().endsWith(`/api/tasks/${id}/stop`) && res.request().method() === 'POST';

    await openBoard(page, ui.base);
    await waitRows(page, 1);

    // 第一次点：服务端无法确认，要求确认
    const first = await clickAwaiting(page, actSel(id, 'stop'), stopMatch);
    assert.equal(first.status, 409, JSON.stringify(first.json));
    assert.equal(first.json.code, 'STOP_UNVERIFIED');
    assert.equal(first.sent.confirm, false, '第一次点击不许自带 confirm');
    await page.waitForFunction((sel) => document.querySelector(sel)?.classList.contains('is-confirm'), actSel(id, 'stop'), { timeout: 10000 });
    assert.equal(await actText(page, id, 'stop'), '确认已停止');
    await shot(page, '06-c5c-stop-needs-confirm-1440x900@2x.png');

    // 第二次点：带 confirm，且必须绑上第一次 409 里给的 attempt_id（R2-1）
    const second = await clickAwaiting(
      page, actSel(id, 'stop'),
      (res) => stopMatch(res) && res.request().postDataJSON()?.confirm === true,
    );
    assert.equal(second.status, 200, JSON.stringify(second.json));
    assert.equal(second.sent.attempt_id, first.json.attempt_id, '确认请求必须绑定 409 响应里给的 attempt_id（R2-1）');
    assert.equal(second.json.verified, false, '没有进程可核对，不许声称已验证');
    assert.equal(second.json.mode, 'declared');
    await page.waitForFunction((sel) => !document.querySelector(sel), actSel(id, 'stop'), { timeout: 15000 });
    await shot(page, '07-c5c-after-confirmed-stop-1440x900@2x.png');

    withReadOnly(ui.dbPath, (db) => {
      const a = db.prepare('SELECT status, end_reason FROM attempts WHERE task_id = ?').get(id);
      assert.equal(a.status, 'interrupted');
      assert.equal(a.end_reason, 'user_stop');
      assert.equal(acceptancesOf(db, id), 0, '停止不是 finish，不许写验收结论');
      assert.notEqual(rowOf(db, id).status, 'completed');
    });

    const del = await clickAwaiting(
      page, actSel(id, 'delete'),
      (res) => res.url().endsWith(`/api/tasks/${id}`) && res.request().method() === 'DELETE',
    );
    assert.equal(del.status, 200, JSON.stringify(del.json));
    assert.ok(withReadOnly(ui.dbPath, (db) => rowOf(db, id).deleted_at));
  } finally {
    await page.context().close();
    await ui.stop();
  }
});

test('C5d 界面：点「停止」真的结束一个托管执行（进程退出 + 实例结束），然后才能删', { timeout: 120000 }, async () => {
  // web/server.js 里没有任何入口会在服务进程内调用 startDshAttempt（真实执行器），
  // 所以「界面 → 托管执行」这一段只能在进程内夹具上验：夹具挂的是同一份生产路由、同一个生产执行器，
  // 看板静态文件在读的是同一份前端（默认 web/，设了 TASKS_REWORK_WEB_DIR 就是暂存目录）。
  const fx = await startReworkServer(STAGE_WEB_DIR ? { webDir: STAGE_WEB_DIR } : {});
  const page = await newPage('harness');
  try {
    const id = (await fx.call('POST', '/api/tasks', { title: 'C5d 界面停止托管执行' })).body.task.task_id;
    const { handle, stateFile } = await fx.startManaged(id);
    assert.equal(handle.ok, true, `托管执行没起来：${handle.error}`);
    const t0 = Date.now();
    while (!existsSync(stateFile) && Date.now() - t0 < 8000) await sleep(50);

    await openBoard(page, fx.base);
    await waitRows(page, 1);
    assert.equal(await page.locator(actSel(id, 'stop')).count(), 1, '托管执行在跑的行必须有「停止」');
    await shot(page, '08-c5d-managed-running-with-stop-1440x900@2x.png');

    const stop = await clickAwaiting(
      page, actSel(id, 'stop'),
      (res) => res.url().endsWith(`/api/tasks/${id}/stop`) && res.request().method() === 'POST',
    );
    assert.equal(stop.status, 200, JSON.stringify(stop.json));
    assert.equal(stop.json.mode, 'managed');
    assert.equal(stop.json.verified, true);

    assert.equal(pidAlive(handle.pid), false, '点停止后托管进程必须已经退出');
    const seq = Number(readFileSync(stateFile, 'utf8'));
    await sleep(600);
    assert.equal(Number(readFileSync(stateFile, 'utf8')), seq, '停止后不许再有新输出');
    await page.waitForFunction((sel) => !document.querySelector(sel), actSel(id, 'stop'), { timeout: 15000 });
    await shot(page, '09-c5d-managed-stopped-1440x900@2x.png');

    const a = fx.db.prepare('SELECT status, end_reason FROM attempts WHERE task_id = ?').get(id);
    assert.equal(a.status, 'interrupted');
    assert.equal(a.end_reason, 'user_stop');

    const del = await clickAwaiting(
      page, actSel(id, 'delete'),
      (res) => res.url().endsWith(`/api/tasks/${id}`) && res.request().method() === 'DELETE',
    );
    assert.equal(del.status, 200, JSON.stringify(del.json));
    assert.ok(rowOf(fx.db, id).deleted_at);
    await shot(page, '10-c5d-managed-deleted-after-stop-1440x900@2x.png');
  } finally {
    await page.context().close();
    await fx.stop();
  }
});

// ===========================================================================
// C6：删除后可重新列出并恢复
// ===========================================================================
test('C6 接口：GET /api/tasks?only_deleted=1 只返回已删除的；单条 / 批量 restore 清掉 deleted_at', { timeout: 60000 }, async () => {
  const a = await newTask('C6 接口 回收站 A');
  const b = await newTask('C6 接口 回收站 B');
  const keep = await newTask('C6 接口 留在列表里的');
  assert.equal((await call('DELETE', `/api/tasks/${a}`, {})).status, 200);
  assert.equal((await call('DELETE', `/api/tasks/${b}`, {})).status, 200);

  const trash = await call('GET', '/api/tasks?only_deleted=1');
  assert.equal(trash.status, 200);
  assert.equal(trash.body.only_deleted, true, '响应回显 only_deleted');
  // 共用的库里还有别的用例（C2 / C2b）删掉的任务，所以这里只断言「该在的在、不该在的不在」
  const trashIds = trash.body.tasks.map((x) => x.task_id);
  assert.ok(trashIds.includes(a) && trashIds.includes(b), `刚删的两条必须在回收站里，实际 ${trashIds.length} 条`);
  assert.equal(trashIds.includes(keep), false, '没删的不许出现在回收站');
  assert.ok(trash.body.tasks.every((x) => x.is_deleted === true && x.deleted_at), '回收站里每一行都必须是已删除的');

  const normal = await call('GET', '/api/tasks');
  assert.ok(normal.body.tasks.some((x) => x.task_id === keep));
  assert.equal(normal.body.tasks.some((x) => x.task_id === a || x.task_id === b), false, '默认列表不含已删除的');

  const single = await call('POST', `/api/tasks/${a}/restore`, { actor: 'test:c6' });
  assert.equal(single.status, 200, JSON.stringify(single.body));
  assert.equal(rowOf(raw, a).deleted_at, null);

  const batch = await call('POST', '/api/tasks/batch', { action: 'restore', ids: [b], actor: 'test:c6' });
  assert.equal(batch.status, 200);
  assert.equal(batch.body.succeeded, 1);
  assert.equal(rowOf(raw, b).deleted_at, null);

  const trashAfter = await call('GET', '/api/tasks?only_deleted=1');
  assert.equal(trashAfter.body.tasks.some((x) => x.task_id === a || x.task_id === b), false, '恢复后不再是已删除');
});

test('C6 界面：回收站入口列出已删除任务，批量恢复 + 单条恢复', { timeout: 120000 }, async () => {
  const ui = await uiServer();
  const page = await newPage(ui.kind);
  try {
    const mk = async (title) => (await ui.call('POST', '/api/tasks', { title })).body.task.task_id;
    const [a, b, c, d] = [
      await mk('C6 界面 早先删掉的 A'), await mk('C6 界面 早先删掉的 B'),
      await mk('C6 界面 待删的 C'), await mk('C6 界面 留着的 D'),
    ];
    assert.equal((await ui.call('DELETE', `/api/tasks/${a}`, {})).status, 200);
    assert.equal((await ui.call('DELETE', `/api/tasks/${b}`, {})).status, 200);
    const batchMatch = (res) => res.url().endsWith('/api/tasks/batch') && res.request().method() === 'POST';
    const isTrashList = (res) => {
      const u = new URL(res.url());
      return u.pathname === '/api/tasks' && res.request().method() === 'GET' && u.searchParams.get('only_deleted') === '1';
    };
    const isNormalList = (res) => {
      const u = new URL(res.url());
      return u.pathname === '/api/tasks' && res.request().method() === 'GET' && u.searchParams.get('only_deleted') !== '1';
    };

    await openBoard(page, ui.base);
    await waitRows(page, 2);
    assert.equal(await page.locator(`${lineSel(a)}, ${lineSel(b)}`).count(), 0, '已删除的不在普通列表');

    // 行内删除 C
    const del = await clickAwaiting(
      page, actSel(c, 'delete'),
      (res) => res.url().endsWith(`/api/tasks/${c}`) && res.request().method() === 'DELETE',
    );
    assert.equal(del.status, 200, JSON.stringify(del.json));
    await page.waitForFunction(() => document.querySelectorAll('#task-list .task-line').length === 1, null, { timeout: 15000 });
    await settle(page, /回收站/);
    assert.match(await toastText(page), /回收站/, '删除后的提示要告诉用户去回收站找回');

    // 进回收站：真请求 ?only_deleted=1
    const trashReq = page.waitForResponse(isTrashList, { timeout: 15000 });
    await page.locator('#task-trash-toggle').click();
    assert.equal((await trashReq).status(), 200);
    await waitRows(page, 3);
    const trashIds = await page.locator('#task-list .task-line').evaluateAll((els) => els.map((el) => el.dataset.line).sort());
    assert.deepEqual(trashIds, [a, b, c].sort(), '回收站里正好是三条已删除的');
    assert.equal(await page.locator('#task-list .task-tag--deleted').count(), 3, '每行都要有「已删除」标签');
    assert.equal(await page.locator('#task-list [data-act="delete"], #task-list [data-act="archive"]').count(), 0, '回收站里行内不该有归档 / 删除');
    assert.equal(await page.locator('#task-archived-toggle').isDisabled(), true, '回收站里「显示已归档」不适用，应禁用');
    await shot(page, '11-c6-trash-list-1440x900@2x.png');

    // 回收站里的批量条只有「恢复」
    await page.locator(`[data-pick="${a}"]`).check();
    assert.equal(await page.locator('#task-batch').isVisible(), true);
    assert.equal(await page.locator('#task-batch [data-batch="restore"]').isVisible(), true);
    assert.equal(await page.locator('#task-batch [data-batch="archive"]').isVisible(), false);
    assert.equal(await page.locator('#task-batch [data-batch="delete"]').isVisible(), false);
    await shot(page, '11b-c6-trash-batch-bar-restore-only-1440x900@2x.png');

    // 批量恢复 A
    const batch = await clickAwaiting(page, '[data-batch="restore"]', batchMatch);
    assert.equal(batch.status, 200, JSON.stringify(batch.json));
    assert.deepEqual(batch.sent, { action: 'restore', ids: [a], actor: 'board:ui' });
    await waitRows(page, 2);
    await shot(page, '12-c6-trash-after-batch-restore-1440x900@2x.png');

    // 回收站里还剩 2 条，但切到「执行」就都看不到了：空状态要说清是筛选造成的，不是回收站空了
    await page.locator('[data-filter="running"]').click();
    await page.waitForFunction(() => /回收站里有 2 条已删除的任务，但当前筛选下没有/.test(document.querySelector('#task-list')?.textContent || ''), null, { timeout: 10000 });
    await page.locator('[data-filter="all"]').click();
    await waitRows(page, 2);

    // 批量恢复剩下的 B + C
    await page.locator(`[data-pick="${b}"]`).check();
    await page.locator(`[data-pick="${c}"]`).check();
    const batch2 = await clickAwaiting(page, '[data-batch="restore"]', batchMatch);
    assert.equal(batch2.status, 200, JSON.stringify(batch2.json));
    assert.equal(batch2.json.succeeded, 2);
    await waitRows(page, 0);
    await shot(page, '13-c6-trash-empty-1440x900@2x.png');

    // 再删 D，用行内「恢复」恢复（单条路径）
    assert.equal((await ui.call('DELETE', `/api/tasks/${d}`, {})).status, 200);
    await page.locator('#refresh-btn').click();
    await waitRows(page, 1, 20000);
    const single = await clickAwaiting(
      page, actSel(d, 'restore'),
      (res) => res.url().endsWith(`/api/tasks/${d}/restore`) && res.request().method() === 'POST',
    );
    assert.equal(single.status, 200, JSON.stringify(single.json));
    await waitRows(page, 0);

    // 退出回收站：四条都回到普通列表
    const normalReq = page.waitForResponse(isNormalList, { timeout: 15000 });
    await page.locator('#task-trash-toggle').click();
    await normalReq;
    await waitRows(page, 4);
    await shot(page, '14-c6-back-to-normal-list-1440x900@2x.png');

    withReadOnly(ui.dbPath, (db) => {
      for (const id of [a, b, c, d]) {
        const row = rowOf(db, id);
        assert.ok(row, `${id} 行必须还在（软删不删行）`);
        assert.equal(row.deleted_at, null, `${id} 恢复后 deleted_at 必须是 NULL`);
      }
    });
  } finally {
    await page.context().close();
    await ui.stop();
  }
});

// ===========================================================================
// C7：上一版 29 条（12 + 17）仍全过
// ===========================================================================
test('C7 上一版两个测试文件仍全过：tasks-archive 12/12、tasks-workflow-link 17/17', { timeout: 300000 }, (t) => {
  // Node 的测试运行器给测试进程设了 NODE_TEST_CONTEXT；原样传给子进程会让子进程的 `node --test`
  // 不输出任何汇总，所以必须剔掉，且读不到汇总就判失败（不默认当成通过）。
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const runOne = (file, expectedTests) => {
    const tmp = mkdtempSync(join(TMP_ROOT, 'c7-'));
    try {
      const r = spawnSync(process.execPath, ['--no-warnings', '--test', file], {
        cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 240000,
        env: { ...env, AGENT_OFFICE_DB: join(tmp, 'unused.db') },
      });
      const out = `${r.stdout || ''}${r.stderr || ''}`;
      const pass = /ℹ pass (\d+)/.exec(out);
      const fail = /ℹ fail (\d+)/.exec(out);
      const total = /ℹ tests (\d+)/.exec(out);
      assert.ok(pass && fail && total, `${file} 读不到测试汇总（exit ${r.status}）：\n${out.slice(-800)}`);
      t.diagnostic(`${file}：tests ${total[1]}，pass ${pass[1]}，fail ${fail[1]}，exit ${r.status}`);
      assert.equal(r.status, 0, `${file} 必须 exit 0，实际 ${r.status}：\n${out.slice(-3000)}`);
      assert.equal(Number(total[1]), expectedTests, `${file} 应有 ${expectedTests} 条用例，实际 ${total[1]}`);
      assert.equal(Number(pass[1]), expectedTests, `${file} 必须 ${expectedTests}/${expectedTests}，实际通过 ${pass[1]}：\n${out.slice(-2000)}`);
      assert.equal(Number(fail[1]), 0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  };
  runOne('test/tasks-archive.test.js', 12);
  runOne('test/tasks-workflow-link.test.js', 17);
});

// ===========================================================================
// C8：P2-3 并发锁 —— 多进程同时首开同一个新库 / 并发升级
// ===========================================================================
/** 起一个 v7 形状的库：先用生产代码建一个完整的新库，再把 v8 / v9 加的东西拿掉、版本改回 7、补旧行。 */
function makeV7ShapeDb(path, legacyRows) {
  const full = openDb({ path });
  closeDb(full);
  const handle = new DatabaseSync(path);
  try {
    handle.exec('PRAGMA busy_timeout = 5000');
    handle.exec('DROP INDEX idx_tasks_archived; DROP INDEX idx_tasks_deleted; DROP INDEX idx_tasks_workflow;');
    for (const col of ['archived_at', 'archived_from', 'deleted_at', 'workflow_run_id', 'workflow_step_id']) {
      handle.exec(`ALTER TABLE tasks DROP COLUMN ${col}`);
    }
    handle.exec("UPDATE schema_meta SET value = '7' WHERE key = 'schema_version'");
    const ins = handle.prepare(
      'INSERT INTO tasks (rowid, task_id, title, acceptance, status, status_reason, created_at, updated_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const r of legacyRows) {
      ins.run(r.rowid, r.task_id, r.title, r.acceptance ?? null, r.status, r.status_reason ?? null, r.created_at, r.updated_at, null);
    }
  } finally {
    handle.close();
  }
}

function tasksSnapshot(path) {
  const handle = new DatabaseSync(path, { readOnly: true });
  try {
    const names = handle.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
    return {
      version: Number(handle.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()?.value),
      integrity: handle.prepare('PRAGMA integrity_check').get().integrity_check,
      names,
      rows: handle.prepare(`SELECT rowid AS __rowid, ${names.map((n) => JSON.stringify(n)).join(', ')} FROM tasks ORDER BY rowid ASC`).all().map((r) => ({ ...r })),
      indexes: handle.prepare('PRAGMA index_list(tasks)').all().map((i) => i.name).sort(),
    };
  } finally {
    handle.close();
  }
}

/** N 个真实 server.js 同时第一次打开同一个库，同时各发 2 个首个请求；返回 non-200 的列表和各服务的错误日志。 */
async function raceOpen(dbPath, n) {
  const servers = await Promise.all(Array.from({ length: n }, () => startChatServer({ dbPath })));
  try {
    const hits = await Promise.all(servers.flatMap((s, i) => [
      fetch(`${s.base}/api/workflow/runs`).then((r) => ({ i, p: '/api/workflow/runs', status: r.status }), (e) => ({ i, p: '/api/workflow/runs', status: `ERR ${e.message}` })),
      fetch(`${s.base}/api/tasks`).then((r) => ({ i, p: '/api/tasks', status: r.status }), (e) => ({ i, p: '/api/tasks', status: `ERR ${e.message}` })),
    ]));
    const errs = servers.flatMap((s) => s.logs.filter((l) => l.includes('[错误]')).map((l) => l.slice(0, 200)));
    return { hits, non200: hits.filter((h) => h.status !== 200), errs };
  } finally {
    for (const s of servers) await s.stop();
  }
}

const RACE_N = 8;

test('C8 多进程并发首开同一个「还不存在」的新库：全部 200，无 database is locked', { timeout: 240000 }, async (t) => {
  const ROUNDS = 3;
  let total = 0;
  let bad = 0;
  for (let round = 1; round <= ROUNDS; round += 1) {
    const dir = mkdtempSync(join(TMP_ROOT, `c8-fresh-${round}-`));
    try {
      const { hits, non200, errs } = await raceOpen(join(dir, 'fresh.db'), RACE_N);
      total += hits.length;
      bad += non200.length;
      t.diagnostic(`C8 新库 第 ${round} 轮：${RACE_N} 个服务 × 2 个首请求，non-200 = ${non200.length}/${hits.length}${non200.length ? ` ${JSON.stringify(non200.slice(0, 4))}` : ''}`);
      if (errs.length) t.diagnostic(`   服务端错误日志：${[...new Set(errs)].slice(0, 3).join(' | ')}`);
      const snap = tasksSnapshot(join(dir, 'fresh.db'));
      assert.deepEqual(non200, [], `第 ${round} 轮有请求失败：${JSON.stringify(non200)}`);
      assert.deepEqual(errs, [], `第 ${round} 轮服务端报错：${[...new Set(errs)].join(' | ')}`);
      assert.equal(snap.version, SCHEMA_VERSION);
      assert.equal(snap.integrity, 'ok');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  t.diagnostic(`C8 新库 合计 ${ROUNDS} 轮：${total} 个首请求，失败 ${bad} 个`);
});

test('C8b 多进程并发升级 v7 形状的旧库（v8、v9 两个迁移一起抢）：全部 200，旧行逐列不变、rowid 不变', { timeout: 240000 }, async (t) => {
  const ROUNDS = 2;
  const legacy = [
    { rowid: 431, task_id: 't-c8-old-1', title: '旧任务不许丢', acceptance: '旧行原样保留', status: 'running', status_reason: '迁移前的状态', created_at: '2026-11-20T01:00:00.000Z', updated_at: '2026-11-20T02:00:00.000Z' },
    { rowid: 902, task_id: 't-c8-old-2', title: '另一条旧任务', acceptance: null, status: 'waiting', status_reason: null, created_at: '2026-11-21T01:00:00.000Z', updated_at: '2026-11-21T02:00:00.000Z' },
  ];
  const newCols = ['archived_at', 'archived_from', 'deleted_at', 'workflow_run_id', 'workflow_step_id'];
  for (let round = 1; round <= ROUNDS; round += 1) {
    const dir = mkdtempSync(join(TMP_ROOT, `c8-upgrade-${round}-`));
    try {
      const path = join(dir, 'v7.db');
      makeV7ShapeDb(path, legacy);
      const before = tasksSnapshot(path);
      assert.equal(before.version, 7, '夹具必须是 v7 库');
      assert.equal(newCols.some((c) => before.names.includes(c)), false, '夹具不能已有 v8 / v9 的列');

      const { hits, non200, errs } = await raceOpen(path, RACE_N);
      t.diagnostic(`C8b 升级 第 ${round} 轮：${RACE_N} 个服务 × 2 个首请求，non-200 = ${non200.length}/${hits.length}${non200.length ? ` ${JSON.stringify(non200.slice(0, 4))}` : ''}`);
      if (errs.length) t.diagnostic(`   服务端错误日志：${[...new Set(errs)].slice(0, 3).join(' | ')}`);
      const after = tasksSnapshot(path);
      assert.deepEqual(non200, [], `第 ${round} 轮有请求失败：${JSON.stringify(non200)}`);
      assert.deepEqual(errs, []);

      assert.equal(after.version, SCHEMA_VERSION, `升级后版本必须是 ${SCHEMA_VERSION}，实际 ${after.version}`);
      assert.equal(after.integrity, 'ok');
      for (const col of newCols) assert.ok(after.names.includes(col), `缺列 ${col}`);
      for (const idx of ['idx_tasks_archived', 'idx_tasks_deleted', 'idx_tasks_workflow']) {
        assert.ok(after.indexes.includes(idx), `缺索引 ${idx}`);
      }
      assert.equal(after.rows.length, before.rows.length, '旧行数不变');
      before.rows.forEach((b, i) => {
        const a = after.rows[i];
        assert.equal(a.__rowid, b.__rowid, `${b.task_id}: rowid 变了（${b.__rowid} → ${a.__rowid}），表被重建过`);
        for (const col of before.names) assert.equal(a[col], b[col], `${b.task_id}.${col} 迁移后变了`);
        for (const col of newCols) assert.equal(a[col], null, `${b.task_id}.${col} 应为 NULL，实际 ${a[col]}`);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// ===========================================================================
// C9：界面用例收尾，整个过程不许有未捕获的 JS 异常
// ===========================================================================

test('C10 旧后端保护：服务端进程没重启（/api/tasks 响应里没有 api_features）时，「停止」「回收站」禁用并说明原因', { timeout: 120000 }, async () => {
  // 看板静态文件是每次请求从磁盘读的：前端一改线上立刻是新的，而 web/api-tasks.mjs 要重启才换。
  // 改完前端、还没重启的那段时间里，线上就是「新前端 + 旧后端」。这里把真实服务的 /api/tasks 响应
  // 里的新字段去掉，模拟那段窗口：不许留下一个点了没反应的控件。
  const ui = await uiServer();
  const page = await newPage(ui.kind);
  try {
    const id = (await ui.call('POST', '/api/tasks', { title: 'C10 旧后端下的执行中任务' })).body.task.task_id;
    assert.equal((await ui.call('POST', `/api/tasks/${id}/attempt`, { agent_id: 'dsh' })).status, 201);

    const trashRequests = [];
    await page.route('**/api/tasks*', async (route) => {
      const res = await route.fetch();
      if (new URL(route.request().url()).searchParams.get('only_deleted') === '1') trashRequests.push(route.request().url());
      let json = null;
      try { json = await res.json(); } catch { /* 非 JSON 原样放行 */ }
      if (json && Array.isArray(json.tasks)) {
        delete json.api_features;
        delete json.only_deleted;
      }
      await route.fulfill({ response: res, json: json === null ? undefined : json });
    });

    await openBoard(page, ui.base);
    await waitRows(page, 1);
    const stop = page.locator(actSel(id, 'stop'));
    assert.equal(await stop.count(), 1, '行上仍然给出「停止」的位置（看得出有这个功能）');
    assert.equal(await stop.isDisabled(), true, '旧后端下「停止」必须禁用');
    assert.match(await stop.getAttribute('title'), /服务端进程还是旧代码/);
    const trash = page.locator('#task-trash-toggle');
    assert.equal(await trash.isDisabled(), true, '旧后端下「回收站」必须禁用');
    assert.match(await trash.getAttribute('title'), /服务端进程还是旧代码/);

    await trash.click({ force: true, timeout: 2000 }).catch(() => { /* 禁用的按钮点不动，正是要的结果 */ });
    await sleep(500);
    assert.deepEqual(trashRequests, [], '旧后端下不许发出 ?only_deleted=1 的请求（它会悄悄返回普通列表）');
    assert.equal(await page.locator('.tasks.is-trash').count(), 0);
    await shot(page, '15-c10-old-backend-disabled-stop-and-trash-1440x900@2x.png');
  } finally {
    await page.context().close();
    await ui.stop();
  }
});

// ===========================================================================
// 第二轮追问：显示层四个问题（D1–D5）
//   背景：线上 10 条任务在库里是 completed（closed_at 有值），接口却返回 idle、进度 0/1；
//   筛选分类里没有「完成」，10 条任务只出现在「全部」里；工作流下拉里混着已归档的 run。
// ===========================================================================

const OUT_OF_BAND_REASON = '代码已交付，单测通过，界面已验证';   // 线上那 10 条任务 status_reason 的原话

/** 打开某个用例自己的临时库来「摆数据」（可写），跑完就关。 */
function withDb(dbPath, fn) {
  const h = new DatabaseSync(dbPath);
  h.exec('PRAGMA busy_timeout = 5000');
  try {
    return fn(h);
  } finally {
    h.close();
  }
}

/** 线上的真实形状：任务没跑过，被人直接改库记成 completed（closed_at 一起写）。不写任何事件。 */
function markCompletedOutOfBand(h, taskId, at = new Date().toISOString()) {
  h.prepare("UPDATE tasks SET status = 'completed', status_reason = ?, closed_at = ?, updated_at = ? WHERE task_id = ?")
    .run(OUT_OF_BAND_REASON, at, at, taskId);
}

function stepRowsOf(h, taskId) {
  return h.prepare('SELECT step_key, status FROM task_steps WHERE task_id = ? ORDER BY seq').all(taskId).map((r) => ({ ...r }));
}

const progressOf = (view) => ({ done: view.progress.done, total: view.progress.total });

test('D1 库里是 completed 的任务，接口返回的也是 completed，不是 idle', { timeout: 60000 }, async (t) => {
  // 评审给的那条查询：GET /api/tasks?workflow_run_id=… 返回 idle，而 SELECT status 是 completed
  const runId = (await call('POST', '/api/workflow/runs', { template_id: 'coding-v1', title: 'D1 状态映射' })).body.run.run_id;
  const doneId = await newTask('D1 人工记成完成', { workflow_run_id: runId, workflow_step_id: '05' });
  markCompletedOutOfBand(raw, doneId);
  assert.equal(rowOf(raw, doneId).status, 'completed', '摆数据：库里的状态列要是 completed');

  const byRun = await call('GET', `/api/tasks?workflow_run_id=${encodeURIComponent(runId)}`);
  const inRun = byRun.body.tasks.find((x) => x.task_id === doneId);
  assert.equal(inRun.status, 'completed', `按 run 过滤的列表里状态应是 completed，实际 ${inRun.status}`);
  const list = await call('GET', '/api/tasks');
  const item = list.body.tasks.find((x) => x.task_id === doneId);
  assert.equal(item.status, 'completed');
  assert.match(item.status_reason, /任务记录为已完成/, '理由要写明凭什么是 completed');
  assert.equal(item.evidence_source, 'system', '这不是验收证据，证据源不许写成 verifier / user');
  assert.equal(item.verification.result, 'none', '没有验收事件，就不许伪造出一条验收');

  const detail = await call('GET', `/api/tasks/${doneId}`);
  assert.equal(detail.body.state.status, 'completed');
  assert.equal(detail.body.view.status, 'completed');
  assert.equal(detail.body.task.status, 'completed');
  // 读详情不许反过来把库里的状态列改掉（返工第一版的对齐逻辑会把它刷成 idle）
  assert.equal(rowOf(raw, doneId).status, 'completed', '读一次详情之后，库里的状态列必须还是 completed');

  // 反面：不是「把所有任务都标成 completed」
  const waitingId = await newTask('D1 没开始做的');
  const runningId = await newTask('D1 在跑的');
  assert.equal((await startAttempt(runningId)).status, 201);
  // 跑过、实例正常结束、但没有验收，之后被人工改库记成 completed：仍然只认验收事件（硬规矩 3），不显示 completed
  const ranId = await newTask('D1 跑过但没验收');
  const attemptId = newAttemptId();
  createAttempt(raw, { taskId: ranId, agentId: 'dsh', attemptId, evidenceSource: 'executor' });
  endAttempt(raw, { attemptId, status: 'completed', endReason: 'done', evidenceSource: 'executor' });
  markCompletedOutOfBand(raw, ranId);
  const after = Object.fromEntries((await call('GET', '/api/tasks')).body.tasks.map((x) => [x.task_id, x]));
  assert.equal(after[waitingId].status, 'waiting');
  assert.equal(after[runningId].status, 'running');
  assert.equal(after[ranId].status, 'waiting', `跑过但没验收的任务不许因为状态列写了 completed 就显示 completed，实际 ${after[ranId].status}`);
  t.diagnostic(`D1：库里 completed + 无执行实例 + 无验收事件 → 接口 ${item.status}（${item.evidence_source}：${item.status_reason}）；waiting → ${after[waitingId].status}；running → ${after[runningId].status}；跑过没验收 + 库里 completed → ${after[ranId].status}`);
});

test('D2 没有 task_steps 时进度按任务状态算：completed → 1/1，waiting → 0/1', { timeout: 60000 }, async (t) => {
  const waitingId = await newTask('D2 没有步骤行的待办');
  raw.prepare('DELETE FROM task_steps WHERE task_id = ?').run(waitingId);
  assert.equal(stepRowsOf(raw, waitingId).length, 0, '摆数据：这条任务没有步骤行');
  let view = (await call('GET', '/api/tasks')).body.tasks.find((x) => x.task_id === waitingId);
  assert.deepEqual(progressOf(view), { done: 0, total: 1 });
  let detail = await call('GET', `/api/tasks/${waitingId}`);
  assert.deepEqual(progressOf(detail.body.view), { done: 0, total: 1 });
  assert.deepEqual({ done_count: detail.body.state.done_count, total: detail.body.state.total }, { done_count: 0, total: 1 });

  const doneId = await newTask('D2 没有步骤行的已完成');
  raw.prepare('DELETE FROM task_steps WHERE task_id = ?').run(doneId);
  markCompletedOutOfBand(raw, doneId);
  view = (await call('GET', '/api/tasks')).body.tasks.find((x) => x.task_id === doneId);
  assert.deepEqual(progressOf(view), { done: 1, total: 1 });
  assert.deepEqual({ done: view.done, remaining: view.remaining, current: view.current_step }, { done: [], remaining: [], current: null }, '没有步骤行就不编一个步骤出来');
  detail = await call('GET', `/api/tasks/${doneId}`);
  assert.deepEqual(progressOf(detail.body.view), { done: 1, total: 1 });
  // 交付物视图里的任务头用的是同一套口径
  const dl = await call('GET', `/api/deliverables?task_id=${encodeURIComponent(doneId)}`);
  assert.equal(dl.status, 200, JSON.stringify(dl.body).slice(0, 200));
  assert.deepEqual(progressOf(dl.body.task), { done: 1, total: 1 });
  assert.equal(dl.body.task.current_step, null);
  t.diagnostic(`D2：无步骤行 · waiting → 0/1；无步骤行 · completed → 列表 ${progressOf(view).done}/${progressOf(view).total}、详情 ${progressOf(detail.body.view).done}/${progressOf(detail.body.view).total}、交付物视图 ${progressOf(dl.body.task).done}/${progressOf(dl.body.task).total}`);
});

test('D3 有 task_steps 时仍按步骤计数：两步完成一步 → 1/2；记成完成但步骤行还挂在 pending 的 → 满进度', { timeout: 60000 }, async (t) => {
  const halfId = await newTask('D3 两步做了一步', { steps: ['设计', '开发'] });
  raw.prepare("UPDATE task_steps SET status = 'done' WHERE task_id = ? AND step_key = ?").run(halfId, '设计');
  let view = (await call('GET', '/api/tasks')).body.tasks.find((x) => x.task_id === halfId);
  assert.deepEqual(progressOf(view), { done: 1, total: 2 });
  assert.deepEqual({ done: view.done, remaining: view.remaining, current: view.current_step?.key }, { done: ['设计'], remaining: ['开发'], current: '开发' });

  // 线上 10 条任务的真实形状：一条 pending 的步骤行 + 库里直接记成 completed（评审说的「task_steps 是空的」并不准确，
  // 行是在的，只是停在 pending——只按「有没有步骤行」分支修不好这一种）
  const prodId = await newTask('D3 记成完成但步骤行没落', { steps: ['设计', '开发'] });
  markCompletedOutOfBand(raw, prodId);
  view = (await call('GET', '/api/tasks')).body.tasks.find((x) => x.task_id === prodId);
  assert.deepEqual(progressOf(view), { done: 2, total: 2 }, '任务已完成，进度就该是满的');
  assert.deepEqual({ done: view.done, remaining: view.remaining, current: view.current_step }, { done: ['设计', '开发'], remaining: [], current: null });
  assert.deepEqual(stepRowsOf(raw, prodId).map((s) => s.status), ['pending', 'pending'], '这是显示口径，不改库里的步骤行');

  // 对照：走 finish 验收通过的任务，步骤行会被真的落成 done
  const acceptedId = await newTask('D3 验收通过完成');
  assert.equal((await startAttempt(acceptedId)).status, 201);
  assert.equal((await call('POST', `/api/tasks/${acceptedId}/finish`, { evidence: 'docs/runs/run-3d22e663/07-review.md', result: 'passed' })).status, 200);
  view = (await call('GET', '/api/tasks')).body.tasks.find((x) => x.task_id === acceptedId);
  assert.deepEqual(progressOf(view), { done: 1, total: 1 });
  assert.deepEqual(stepRowsOf(raw, acceptedId).map((s) => s.status), ['done']);
  t.diagnostic(`D3：两步完成一步 → 1/2；completed + 步骤行停在 pending → 2/2（库里步骤行未改）；finish 验收通过 → 1/1（步骤行已是 done）`);
});

/** 读左栏筛选条上每个分类的计数。 */
function filterCountsOf(page) {
  return page.locator('#task-filters .filter').evaluateAll((els) => Object.fromEntries(
    els.map((el) => [el.dataset.filter, Number(el.querySelector('b').textContent)]),
  ));
}

test('D4 筛选分类覆盖所有任务状态：七种状态各一条，分类之和 = 总数，completed 有自己的分类', { timeout: 120000 }, async (t) => {
  const ui = await uiServer();
  const page = await newPage(ui.kind);
  try {
    const mk = async (title, extra) => (await ui.call('POST', '/api/tasks', { title, ...extra })).body.task.task_id;
    const ids = { waiting: await mk('D4 待接力（等待派活）') };
    ids.running = await mk('D4 执行中'); await ui.call('POST', `/api/tasks/${ids.running}/attempt`, { agent_id: 'dsh' });
    ids.interrupted = await mk('D4 已中断'); await ui.call('POST', `/api/tasks/${ids.interrupted}/attempt`, { agent_id: 'dsh' });
    // 停止确认必须绑 409 里给的 attempt_id（R2-1 之后的合同）
    const d4stop = await ui.call('POST', `/api/tasks/${ids.interrupted}/stop`, {});
    assert.equal(d4stop.status, 409, JSON.stringify(d4stop.body));
    assert.ok(d4stop.body.attempt_id, '409 必须带 attempt_id');
    const d4stopped = await ui.call('POST', `/api/tasks/${ids.interrupted}/stop`, { confirm: true, attempt_id: d4stop.body.attempt_id });
    assert.equal(d4stopped.status, 200, JSON.stringify(d4stopped.body));
    ids.unknown = await mk('D4 未知（外部终端）'); await ui.call('POST', `/api/tasks/${ids.unknown}/attempt`, { agent_id: 'claude' });
    ids.blocked = await mk('D4 已阻塞（额度耗尽）');
    ids.idle = await mk('D4 已关闭（空闲）');
    ids.completed = await mk('D4 已完成');
    withDb(ui.dbPath, (h) => {
      h.prepare("INSERT INTO events (task_id, attempt_id, agent_id, event_type, payload, evidence_source, observed_at) VALUES (?, NULL, 'dsh', 'quota_exhausted', ?, 'executor', ?)")
        .run(ids.blocked, JSON.stringify({ reason: 'quota_5h', message: '已达到 5 小时的使用上限' }), new Date().toISOString());
      const at = new Date().toISOString();
      h.prepare('UPDATE tasks SET closed_at = ?, updated_at = ? WHERE task_id = ?').run(at, at, ids.idle);
      markCompletedOutOfBand(h, ids.completed);
    });
    // 先用接口确认摆出来的确实是七种状态，再看界面
    const statuses = Object.fromEntries((await ui.call('GET', '/api/tasks')).body.tasks.map((x) => [x.task_id, x.status]));
    assert.deepEqual(statuses, { [ids.waiting]: 'waiting', [ids.running]: 'running', [ids.interrupted]: 'interrupted', [ids.unknown]: 'unknown', [ids.blocked]: 'blocked', [ids.idle]: 'idle', [ids.completed]: 'completed' });

    await openBoard(page, ui.base);
    await waitRows(page, 7);
    await page.waitForFunction(() => [...document.querySelectorAll('#task-filters .filter b')].every((b) => b.textContent !== '—'), null, { timeout: 10000 });
    const counts = await filterCountsOf(page);
    const { all, ...specific } = counts;
    const sum = Object.values(specific).reduce((n, x) => n + x, 0);
    assert.deepEqual(counts, { all: 7, running: 1, relay: 1, risk: 2, unknown: 1, completed: 1, idle: 1 });
    assert.equal(sum, all, `各分类之和必须等于总数：${JSON.stringify(counts)}`);
    await shot(page, '20-d4-filters-cover-every-status-1440x900@2x.png');

    // 纯函数层面：任何状态值都有归属，不认识的（将来新增的 / 缺失的）归「未知」
    const buckets = await page.evaluate(() => {
      const probe = (p) => taskBucketOf(p);
      return {
        seven: ['running', 'waiting', 'idle', 'blocked', 'interrupted', 'unknown', 'completed'].map((s) => [s, probe({ status: s })]),
        relayPendingRunning: probe({ status: 'running', relay_pending: true }),
        relayPendingBlocked: probe({ status: 'blocked', relay_pending: true }),
        failed: probe({ status: 'failed' }),
        paused: probe({ status: 'paused' }),
        missing: probe({}),
      };
    });
    assert.deepEqual(buckets.seven.map((x) => x[1]), ['running', 'relay', 'idle', 'risk', 'risk', 'unknown', 'completed']);
    assert.deepEqual([buckets.relayPendingRunning, buckets.relayPendingBlocked], ['relay', 'relay'], '待接力的优先归「接力」');
    assert.deepEqual([buckets.failed, buckets.paused, buckets.missing], ['risk', 'unknown', 'unknown'], '不认识的状态一律归「未知」，不会漏');

    // 点进「完成」：只剩那条已完成的
    await page.locator('[data-filter="completed"]').click();
    await waitRows(page, 1);
    assert.deepEqual(await page.locator('#task-list .task-line').evaluateAll((els) => els.map((e) => e.dataset.line)), [ids.completed]);
    assert.match(await page.locator('#task-list .task-line').first().innerText(), /已完成/);
    await shot(page, '21-d4-filter-completed-1440x900@2x.png');
    for (const [key, expected] of [['idle', [ids.idle]], ['risk', [ids.blocked, ids.interrupted]], ['relay', [ids.waiting]], ['unknown', [ids.unknown]], ['running', [ids.running]]]) {
      await page.locator(`[data-filter="${key}"]`).click();
      await waitRows(page, expected.length);
      assert.deepEqual((await page.locator('#task-list .task-line').evaluateAll((els) => els.map((e) => e.dataset.line))).sort(), [...expected].sort(), `分类 ${key} 里的任务不对`);
    }
    t.diagnostic(`D4：筛选计数 ${JSON.stringify(counts)}；各分类之和 ${sum} = 全部 ${all}`);
  } finally {
    await page.context().close();
    await ui.stop();
  }
});

test('D5 工作流下拉只列未归档的 run；选中的 run 被归档后退回「全部任务」', { timeout: 120000 }, async (t) => {
  const ui = await uiServer();
  const page = await newPage(ui.kind);
  try {
    const mkRun = async (title) => (await ui.call('POST', '/api/workflow/runs', { template_id: 'coding-v1', title })).body.run.run_id;
    const keep = await mkRun('D5 留着的 run');
    const other = await mkRun('D5 另一个留着的 run');
    const archived = await mkRun('【D5】已归档的 run');
    const archivedStillRunning = await mkRun('【D5】状态还是 running 但已归档的 run');
    const mkTask = (title, run) => ui.call('POST', '/api/tasks', { title, workflow_run_id: run, workflow_step_id: '05' });
    await mkTask('D5 留着的 run 的任务', keep);
    await mkTask('D5 另一个 run 的任务', other);
    await mkTask('D5 已归档 run 的任务', archived);
    withDb(ui.dbPath, (h) => {
      updateWorkflowRunStatus(h, archived, 'archived');                                                   // 正规途径：status + archived_at
      h.prepare('UPDATE workflow_runs SET archived_at = ? WHERE run_id = ?').run(new Date().toISOString(), archivedStillRunning);   // 线上那种：只写了 archived_at
    });
    // 接口把 archived_at 带出来了（以前没有这个键，前端无从判断）
    const runs = (await ui.call('GET', '/api/workflow/runs')).body.runs;
    for (const r of runs) assert.ok(Object.hasOwn(r, 'archived_at'), `run 列表必须带 archived_at：${r.run_id}`);
    assert.equal(runs.find((r) => r.run_id === keep).archived_at, null);
    assert.ok(runs.find((r) => r.run_id === archived).archived_at);
    assert.ok(runs.find((r) => r.run_id === archivedStillRunning).archived_at);

    await openBoard(page, ui.base);
    await waitRows(page, 3);
    await page.waitForFunction(() => document.querySelectorAll('#task-run-select option').length >= 3, null, { timeout: 10000 });
    const options = await page.locator('#task-run-select option').evaluateAll((els) => els.map((o) => ({ value: o.value, text: o.textContent.trim() })));
    const values = options.map((o) => o.value);
    assert.ok(values.includes(keep) && values.includes(other), '未归档的 run 要在下拉里');
    assert.equal(values.includes(archived), false, '已归档的 run 不许出现在下拉里');
    assert.equal(values.includes(archivedStillRunning), false, '状态还是 running、但 archived_at 有值的 run 同样不许出现');
    assert.equal(options.some((o) => /D5】/.test(o.text)), false, '两个【D5】开头的都是已归档的，一个都不该在');
    // 把下拉的 option 清单投到页面上，截图才有东西可看（原生下拉展开的样子截不到）
    await page.evaluate((opts) => {
      const box = document.createElement('pre');
      box.id = 'evidence-run-options';
      box.style.cssText = 'position:fixed;z-index:9999;right:400px;top:96px;width:520px;max-height:760px;overflow:hidden;padding:14px 16px;border:1px solid #D8C7A6;border-radius:10px;background:#FEFCF9;color:#2B261F;font:13px/1.7 "Cascadia Mono",Consolas,"Microsoft YaHei UI",monospace;white-space:pre-wrap;box-shadow:0 6px 24px rgba(43,38,31,.12)';
      box.textContent = [
        'DOM 原文 · #task-run-select 的 <option>（' + opts.length + ' 项）',
        ...opts.map((o) => (o.value ? `  ${o.value}  ←  ${o.text}` : `  (空值)  ←  ${o.text}`)),
        '',
        '库里共 4 个 run；2 个已归档（archived_at 有值），都不在上面。',
      ].join('\n');
      document.body.appendChild(box);
    }, options);
    await shot(page, '22-d5-run-dropdown-excludes-archived-1440x900@2x.png');
    await page.evaluate(() => document.getElementById('evidence-run-options')?.remove());

    // 选一个未归档的 run：只剩它的任务
    await page.locator('#task-run-select').selectOption(keep);
    await waitRows(page, 1);
    assert.equal(await page.locator('#task-list .task-line').first().getAttribute('data-line'), (await ui.call('GET', `/api/tasks?workflow_run_id=${encodeURIComponent(keep)}`)).body.tasks[0].task_id);

    // 选中的 run 随后被归档：刷新之后筛选自动退回「全部任务」，不留一个指向看不见的 run 的筛选
    withDb(ui.dbPath, (h) => updateWorkflowRunStatus(h, keep, 'archived'));
    await page.locator('#refresh-btn').click();
    await page.waitForFunction(() => document.querySelector('#task-run-select')?.value === '' && document.querySelectorAll('#task-list .task-line').length === 3, null, { timeout: 20000 });
    await shot(page, '23-d5-selected-run-archived-falls-back-to-all-1440x900@2x.png');
    t.diagnostic(`D5：下拉 ${options.length} 项（含「全部任务」）；已归档的 2 个 run 都不在里面；选中的 run 被归档后退回全部任务`);
  } finally {
    await page.context().close();
    await ui.stop();
  }
});

test('D1b 界面：十条人工记成完成的任务 → 左栏「完成 10」，每行进度 1/1，不再显示成「空闲 0/1」', { timeout: 120000 }, async (t) => {
  // 按线上数据的真实形状造一份：十条任务挂在同一个 run 的 05 步，库里直接记成 completed，步骤行停在 pending，没有任何执行实例
  const ui = await uiServer();
  const page = await newPage(ui.kind);
  try {
    const runId = (await ui.call('POST', '/api/workflow/runs', { template_id: 'coding-v1', title: 'D1b 十条已完成的任务' })).body.run.run_id;
    const batch = await ui.call('POST', `/api/workflow/runs/${runId}/steps/05/tasks`, {
      tasks: Array.from({ length: 10 }, (_, i) => ({ title: `D1b 已交付的第 ${i + 1} 件事` })),
    });
    assert.equal(batch.status, 201, JSON.stringify(batch.body).slice(0, 200));
    const ids = batch.body.tasks.map((x) => x.task_id);
    withDb(ui.dbPath, (h) => { for (const id of ids) markCompletedOutOfBand(h, id); });

    await openBoard(page, ui.base);
    await waitRows(page, 10);
    await page.waitForFunction(() => [...document.querySelectorAll('#task-filters .filter b')].every((b) => b.textContent !== '—'), null, { timeout: 10000 });
    const counts = await filterCountsOf(page);
    assert.deepEqual(counts, { all: 10, running: 0, relay: 0, risk: 0, unknown: 0, completed: 10, idle: 0 });
    const progresses = await page.locator('#task-list .task-row__prog').evaluateAll((els) => els.map((e) => e.textContent.trim()));
    assert.deepEqual([...new Set(progresses)], ['1/1'], `十条的进度都该是 1/1，实际 ${JSON.stringify([...new Set(progresses)])}`);
    await shot(page, '18-d1b-ten-completed-tasks-shown-as-completed-1440x900@2x.png');

    // 点开一条看详情：状态「已完成」，进度 1 / 1 步，没有剩余步骤
    await page.locator(`.task-line[data-line="${ids[0]}"] .task-row`).click();
    await page.waitForFunction(() => /任务详情/.test(document.querySelector('#detail-panel')?.textContent || ''), null, { timeout: 10000 });
    const detailText = (await page.locator('#detail-panel').innerText()).replace(/\s+/g, ' ');
    assert.match(detailText, /已完成/);
    assert.match(detailText, /1 \/ 1 步完成/);
    assert.doesNotMatch(detailText, /空闲|0 \/ 1/);
    await shot(page, '19-d1b-completed-task-detail-1-of-1-1440x900@2x.png');
    t.diagnostic(`D1b 界面：筛选计数 ${JSON.stringify(counts)}；十行进度 ${JSON.stringify([...new Set(progresses)])}`);
  } finally {
    await page.context().close();
    await ui.stop();
  }
});

// ===========================================================================
// 第三轮返工（07-review-r2.md）：E1–E4 是新回归，E5 由本文件全量跑 + C7 覆盖
// ===========================================================================

test('E1 停止确认绑定 attempt_id：A 结束、B 接替后，旧确认改不了 B、放不了删除', { timeout: 60000 }, async (t) => {
  const id = await newTask('E1 停止确认绑实例');
  // A 起来（外部声明、无 pid：那种必须用户确认的实例）
  assert.equal((await startAttempt(id, { agent_id: 'dsh' })).status, 201);
  const aId = attemptIdOf(raw, id);

  // 第一次点停止：409 + 结构化 attempt_id —— 用户要确认的就是 A
  const first = await call('POST', `/api/tasks/${id}/stop`, { actor: 'test:e1' });
  assert.equal(first.status, 409, JSON.stringify(first.body));
  assert.equal(first.body.code, 'STOP_UNVERIFIED');
  assert.equal(first.body.attempt_id, aId, '409 响应体必须点名 A 的 attempt_id');

  // A 在别处结束了（对账路径收尾），B 接替上来
  endAttempt(raw, { attemptId: aId, status: 'completed', endReason: 'done', evidenceSource: 'executor' });
  assert.equal((await startAttempt(id, { agent_id: 'dsh' })).status, 201, 'A 已结束，B 必须能接替');
  const bId = attemptIdOf(raw, id);
  assert.notEqual(aId, bId);

  // 旧的确认（绑的是 A）拿来点：409 STOP_TARGET_CHANGED，B 一个字段都不许动
  const stale = await call('POST', `/api/tasks/${id}/stop`, { actor: 'test:e1', confirm: true, attempt_id: aId });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.code, 'STOP_TARGET_CHANGED', `旧确认必须被拒为 STOP_TARGET_CHANGED，实际：${JSON.stringify(stale.body)}`);
  const stillRunning = runningAttemptsOf(raw, id);
  assert.equal(stillRunning.length, 1, `B 必须还在跑，实际 ${stillRunning.length} 条`);
  assert.equal(stillRunning[0].attempt_id, bId);
  assert.equal(stillRunning[0].end_reason, null, 'B 不许被标成用户停止');
  assert.equal(eventsOf(raw, id, 'task_stopped').length, 0, '旧确认不许对 B 落「用户停止」的审计');

  // B 在跑 → 删除仍被拒（旧确认不能放行删除）
  const del1 = await call('DELETE', `/api/tasks/${id}`, { actor: 'test:e1' });
  assert.equal(del1.status, 409, JSON.stringify(del1.body));
  assert.equal(del1.body.code, 'TASK_RUNNING');

  // 不带 attempt_id 的 confirm 一律 400（对不上用户确认过的那次执行）
  const unbound = await call('POST', `/api/tasks/${id}/stop`, { actor: 'test:e1', confirm: true });
  assert.equal(unbound.status, 400, JSON.stringify(unbound.body));
  assert.equal(unbound.body.code, 'STOP_CONFIRM_REQUIRES_ATTEMPT');

  // 重新走一遍确认：新的 409 给的是 B 的 id，绑 B 确认 → 200，剩余 0
  const again = await call('POST', `/api/tasks/${id}/stop`, { actor: 'test:e1' });
  assert.equal(again.status, 409, JSON.stringify(again.body));
  assert.equal(again.body.attempt_id, bId);
  const stopB = await call('POST', `/api/tasks/${id}/stop`, { actor: 'test:e1', confirm: true, attempt_id: bId });
  assert.equal(stopB.status, 200, JSON.stringify(stopB.body));
  assert.equal(stopB.body.attempt.attempt_id, bId);
  assert.equal(stopB.body.remaining_running.count, 0, '全停干净后剩余必须是 0');

  // 现在删除放行
  const del = await call('DELETE', `/api/tasks/${id}`, { actor: 'test:e1' });
  assert.equal(del.status, 200, `停干净了必须能删，实际 ${del.status}：${JSON.stringify(del.body)}`);
  assert.ok(rowOf(raw, id).deleted_at);
  t.diagnostic(`E1：A=${aId} 结束、B=${bId} 接替；旧确认(A) → ${stale.body.code}；删 B 前置 → ${del1.body.code}；绑 B 确认 → 200（剩余 0）；删除 → 200`);
});

test('E2 界面：实例换了手，列表刷新后确认态自动作废（按钮回「停止」，不带旧确认发请求）', { timeout: 120000 }, async (t) => {
  const ui = await uiServer();
  const page = await newPage(ui.kind);
  try {
    const id = (await ui.call('POST', '/api/tasks', { title: 'E2 实例换手后确认作废' })).body.task.task_id;
    assert.equal((await ui.call('POST', `/api/tasks/${id}/attempt`, { agent_id: 'dsh' })).status, 201);
    const aId = withReadOnly(ui.dbPath, (db) => attemptIdOf(db, id));
    const stopMatch = (res) => res.url().endsWith(`/api/tasks/${id}/stop`) && res.request().method() === 'POST';

    await openBoard(page, ui.base);
    await waitRows(page, 1);

    // 第一次点停止 → 409，按钮进入「确认已停止」（前端记下了 A 的 attempt_id）
    const first = await clickAwaiting(page, actSel(id, 'stop'), stopMatch);
    assert.equal(first.status, 409, JSON.stringify(first.json));
    assert.equal(first.json.attempt_id, aId);
    await page.waitForFunction((sel) => document.querySelector(sel)?.classList.contains('is-confirm'), actSel(id, 'stop'), { timeout: 10000 });
    assert.equal(await page.evaluate(() => state.stopConfirm && state.stopConfirm.attemptId), aId, '前端的确认必须绑到 A 的 attempt_id');
    await shot(page, '30-e2-stop-confirm-bound-to-attempt-a-1440x900@2x.png');

    // A 在别处结束、B 接替（界面上的人看不见这次换手）
    withDb(ui.dbPath, (db) => endAttempt(db, { attemptId: aId, status: 'completed', endReason: 'done', evidenceSource: 'executor' }));
    assert.equal((await ui.call('POST', `/api/tasks/${id}/attempt`, { agent_id: 'dsh' })).status, 201, 'A 已结束，B 接替');
    const bId = withReadOnly(ui.dbPath, (db) => attemptIdOf(db, id));
    assert.notEqual(aId, bId);

    // 触发一次列表刷新（#refresh-btn → loadData）：确认态必须跟着实例换手作废
    await page.locator('#refresh-btn').click();
    await page.waitForFunction(() => state.stopConfirm === null, null, { timeout: 15000 });
    await page.waitForFunction(
      (sel) => { const b = document.querySelector(sel); return Boolean(b) && !b.classList.contains('is-confirm'); },
      actSel(id, 'stop'), { timeout: 15000 },
    );
    assert.equal(await actText(page, id, 'stop'), '停止', '确认态作废后按钮文字必须回到「停止」');
    await shot(page, '31-e2-confirm-cleared-after-instance-swap-1440x900@2x.png');

    // 作废之后点停止：又是「第一次点」——不带 confirm、不带旧的 attempt_id（确认没悄悄续命）
    const second = await clickAwaiting(page, actSel(id, 'stop'), stopMatch);
    assert.equal(second.status, 409, JSON.stringify(second.json));
    assert.equal(second.sent.confirm, false, '旧确认作废后，新一次点击不许带 confirm');
    assert.equal(second.sent.attempt_id, undefined, '也不许带旧的 attempt_id');
    assert.equal(second.json.attempt_id, bId, '新的 409 点名的是 B');

    // 对着 B 确认 → 200（剩余 0），然后能删除
    const confirm = await clickAwaiting(
      page, actSel(id, 'stop'),
      (res) => stopMatch(res) && res.request().postDataJSON()?.confirm === true,
    );
    assert.equal(confirm.status, 200, JSON.stringify(confirm.json));
    assert.equal(confirm.sent.attempt_id, bId, '确认请求绑的是 B');
    assert.equal(confirm.json.remaining_running.count, 0);
    await page.waitForFunction((sel) => !document.querySelector(sel), actSel(id, 'stop'), { timeout: 15000 });
    const del = await clickAwaiting(
      page, actSel(id, 'delete'),
      (res) => res.url().endsWith(`/api/tasks/${id}`) && res.request().method() === 'DELETE',
    );
    assert.equal(del.status, 200, JSON.stringify(del.json));
    t.diagnostic(`E2：确认绑 A(${aId}) → 刷新后作废 → 新 409 给 B(${bId}) → 绑 B 确认 200 → 删除 200`);
  } finally {
    await page.context().close();
    await ui.stop();
  }
});

test('E3 界面：两个 running（遗留形态）→ 停一个按钮还在 → 停掉剩余 → 能删除', { timeout: 120000 }, async (t) => {
  const ui = await uiServer();
  const page = await newPage(ui.kind);
  try {
    const id = (await ui.call('POST', '/api/tasks', { title: 'E3 两个遗留 running 实例' })).body.task.task_id;
    assert.equal((await ui.call('POST', `/api/tasks/${id}/attempt`, { agent_id: 'dsh' })).status, 201);
    const aId = withReadOnly(ui.dbPath, (db) => attemptIdOf(db, id));

    // 新入口：同一任务已有 running 就不许再开第二个（单活动实例约束）
    const secondStart = await ui.call('POST', `/api/tasks/${id}/attempt`, { agent_id: 'dsh' });
    assert.equal(secondStart.status, 409, `已有 running 再启动必须 409，实际 ${secondStart.status}：${JSON.stringify(secondStart.body)}`);
    assert.equal(secondStart.body.code, 'ATTEMPT_ALREADY_RUNNING');

    // 约束上线前的遗留形态：库里直接摆第二条 running（API 已经进不去了，只能这样造）
    withDb(ui.dbPath, (db) => createAttempt(db, { taskId: id, agentId: 'dsh', evidenceSource: 'executor' }));
    const bId = withReadOnly(ui.dbPath, (db) => attemptIdOf(db, id));
    assert.notEqual(aId, bId);
    assert.equal(withReadOnly(ui.dbPath, (db) => runningAttemptsOf(db, id).length), 2, '摆数据：两条 running');

    const stopMatch = (res) => res.url().endsWith(`/api/tasks/${id}/stop`) && res.request().method() === 'POST';
    const deleteMatch = (res) => res.url().endsWith(`/api/tasks/${id}`) && res.request().method() === 'DELETE';

    await openBoard(page, ui.base);
    await waitRows(page, 1);
    assert.equal(await page.locator(actSel(id, 'stop')).count(), 1, '两条 running 的行必须有「停止」按钮');
    await shot(page, '32-e3-two-legacy-running-stop-present-1440x900@2x.png');

    // 停最新的 B：第一次点（无确认）→ 409 点名 B；确认 → 200，答复说明还剩 1 个
    const first = await clickAwaiting(page, actSel(id, 'stop'), stopMatch);
    assert.equal(first.status, 409, JSON.stringify(first.json));
    assert.equal(first.json.attempt_id, bId, '409 点名的是最新一条 running（B）');
    const confirmB = await clickAwaiting(
      page, actSel(id, 'stop'),
      (res) => stopMatch(res) && res.request().postDataJSON()?.confirm === true,
    );
    assert.equal(confirmB.status, 200, JSON.stringify(confirmB.json));
    assert.equal(confirmB.json.remaining_running.count, 1, '停了 B 还剩 A：答复必须说清楚');
    assert.equal(confirmB.json.remaining_running.attempts[0].attempt_id, aId);

    // R2-2 的核心：停了一个，「停止」按钮必须还在（不许一停按钮就没了），删除仍被拒。
    // 注意要等「还在且不是确认态」：响应到达时旧 DOM 还画着「确认已停止」，loadData 之后才会重画。
    await page.waitForFunction(
      (sel) => { const b = document.querySelector(sel); return Boolean(b) && !b.classList.contains('is-confirm'); },
      actSel(id, 'stop'), { timeout: 15000 },
    );
    assert.equal(await actText(page, id, 'stop'), '停止', '确认完成之后按钮回到普通「停止」');
    await settle(page, /还有 1 个执行实例在运行/);
    await shot(page, '33-e3-one-stopped-stop-button-still-present-1440x900@2x.png');
    const del1 = await clickAwaiting(page, actSel(id, 'delete'), deleteMatch);
    assert.equal(del1.status, 409, `还有 A 在跑，删除必须被拒，实际 ${del1.status}：${JSON.stringify(del1.json)}`);
    assert.equal(del1.json.code, 'TASK_RUNNING');

    // 再停剩下的 A → 剩余 0，按钮消失，删除放行
    const third = await clickAwaiting(page, actSel(id, 'stop'), stopMatch);
    assert.equal(third.status, 409, JSON.stringify(third.json));
    assert.equal(third.json.attempt_id, aId, '这次 409 点名的是剩下的 A');
    const confirmA = await clickAwaiting(
      page, actSel(id, 'stop'),
      (res) => stopMatch(res) && res.request().postDataJSON()?.confirm === true,
    );
    assert.equal(confirmA.status, 200, JSON.stringify(confirmA.json));
    assert.equal(confirmA.json.remaining_running.count, 0, '全停干净后剩余必须是 0');
    await page.waitForFunction((sel) => !document.querySelector(sel), actSel(id, 'stop'), { timeout: 15000 });
    await settle(page, /现在可以删除/);
    const del = await clickAwaiting(page, actSel(id, 'delete'), deleteMatch);
    assert.equal(del.status, 200, `全停干净必须能删，实际 ${del.status}：${JSON.stringify(del.json)}`);
    assert.ok(withReadOnly(ui.dbPath, (db) => rowOf(db, id).deleted_at));
    await shot(page, '34-e3-all-stopped-deleted-1440x900@2x.png');
    t.diagnostic(`E3：A=${aId}、B=${bId} 两条 running；再启动 → 409 ${secondStart.body.code}；停 B 后剩余 1、按钮还在、删除 409；停 A 后剩余 0、删除 200`);
  } finally {
    await page.context().close();
    await ui.stop();
  }
});

test('E4 详情接口状态同步的审计写失败 → 500，状态列一行不变（同生同死）', { timeout: 60000 }, async (t) => {
  const id = await newTask('E4 详情同步审计失败');
  assert.equal((await startAttempt(id)).status, 201);
  assert.equal((await call('POST', `/api/tasks/${id}/finish`, { evidence: 'docs/runs/run-3d22e663/07-review-r2.md', result: 'passed' })).status, 200);
  assert.equal(rowOf(raw, id).status, 'completed');

  // 把状态列摆成过期的 running：读详情时必须做一次同步写（refreshTaskState）
  const staleAt = new Date(Date.now() + 1000).toISOString();   // 和 finish 写的 updated_at 错开，比对才有意义
  raw.prepare("UPDATE tasks SET status = 'running', status_reason = 'E4 摆的过期值', updated_at = ? WHERE task_id = ?").run(staleAt, id);
  const before = rowOf(raw, id);
  assert.equal(before.status, 'running');
  const eventsBefore = eventsOf(raw, id, 'status_changed').length;   // waiting→running→completed 各留过一条

  // 审计事件写不进去 → 整个同步回滚：状态列、updated_at 一个字段都不许动
  raw.exec(`CREATE TRIGGER rework_fail_status_event BEFORE INSERT ON events WHEN NEW.event_type = 'status_changed' AND NEW.task_id = '${id}' BEGIN SELECT RAISE(ABORT, 'rework: injected status audit failure'); END`);
  let failed;
  try {
    failed = await call('GET', `/api/tasks/${id}`);
  } finally {
    raw.exec('DROP TRIGGER rework_fail_status_event');
  }
  assert.equal(failed.status, 500, `审计写失败必须 500，实际 ${failed.status}：${JSON.stringify(failed.body)}`);
  const after = rowOf(raw, id);
  assert.equal(after.status, 'running', '状态列不许被半提交（还是摆的过期值）');
  assert.equal(after.status_reason, before.status_reason);
  assert.equal(after.updated_at, staleAt, 'updated_at 不许被半提交');
  assert.equal(eventsOf(raw, id, 'status_changed').length, eventsBefore, '被拒的这次不许多留下任何审计事件');

  // 对照组：拿掉故障注入，同样的详情请求把状态列对齐到证据，审计事件在
  const ok = await call('GET', `/api/tasks/${id}`);
  assert.equal(ok.status, 200, JSON.stringify(ok.body).slice(0, 300));
  assert.equal(ok.body.state.status, 'completed');
  assert.equal(ok.body.task.status, 'completed', '响应里三个状态说的是同一件事');
  assert.equal(rowOf(raw, id).status, 'completed', '库里状态列已对齐');
  assert.ok(eventsOf(raw, id, 'status_changed').length >= eventsBefore + 1, '对齐这次写了新的审计事件');
  t.diagnostic(`E4：trigger 拦 status_changed → GET 详情 500，行原样（status=running、updated_at=${staleAt}）；去掉 trigger → 200，状态列对齐 completed`);
});

test('C9 界面用例全程没有未捕获的 JS 异常（pageerror / console error）', () => {
  assert.deepEqual(pageErrors, [], `页面抛了未捕获异常：\n${pageErrors.join('\n')}`);
});
