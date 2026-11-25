// review-r3-verify.mjs —— 第三轮返工自证：把 07-review-r2.md 里三个新问题的复现场景
// 原样重演一遍（同一套真实 server.js + 临时库 + 真实 Chrome，不 mock、不调模型），
// 每一步都带上「修好了应该是什么样」的断言：哪一步红了就是没修好。
//
// 与 Codex 的 review-r2-edge-cases.mjs 的关系：场景步骤照抄（A 换手旧确认 / 多实例停后无入口 /
// 详情审计半提交），但证据写进 r3-evidence/（不覆盖上一轮评审的证据），并补上断言——
// 上一轮探针只采证不断言（退出码只代表采证完成）。
//
// 运行：node --no-warnings docs/runs/run-3d22e663/probes/review-r3-verify.mjs
// 隔离：test/chat-harness.mjs 起真实 web/server.js 子进程（临时库 + stub 中台 + 随机端口），
// 不碰 data/agent-office.db、不抢 8090。
import { startChatServer } from '../../../../test/chat-harness.mjs';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const out = 'docs/runs/run-3d22e663/review-r3-evidence';
mkdirSync(out, { recursive: true });
mkdirSync('docs/screenshots/tasks-rework-r3', { recursive: true });
const shots = out;

const s = await startChatServer();
const ev = { at: new Date().toISOString(), base: s.base, probe: 'review-r3-verify' };
let db, browser, externalWorker;
const call = async (method, path, body) => {
  const r = await fetch(s.base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};
const create = async (title, extra = {}) => (await call('POST', '/api/tasks', { title, ...extra })).body.task.task_id;
const shot = (page, name) => page.screenshot({ path: `${shots}/${name}` });

try {
  await call('GET', '/api/tasks');
  db = new DatabaseSync(s.dbPath); db.exec('PRAGMA busy_timeout=5000');

  browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(s.base + '/board-cromma.html', { waitUntil: 'networkidle' });

  // =========================================================================
  // R2-1（P1）：停止的二次确认只绑任务 → 旧确认会结束新实例并放行删除。
  // 评审复现：A 声明（无 pid）→ 点停止进确认态 → 另一客户端完成 A、启动 B →
  //           刷新后仍显示「确认已停止」→ 点它 → 200，B 被标 user_stop，DELETE=200。
  // 修复后应验：409 响应带结构化 attempt_id；前端确认绑 A；换手后刷新确认作废；
  //           旧形态请求（不带 id / 带旧 id）被 400/409 拒；B 与删除都不被动。
  // =========================================================================
  const t = await create('R3 旧确认不得改新实例');
  const a = await call('POST', `/api/tasks/${t}/attempt`, { agent_id: 'dsh' });
  assert.equal(a.status, 201);
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator(`[data-line="${t}"] [data-act="stop"]`).click();
  await page.locator(`[data-line="${t}"] [data-confirm="1"]`).waitFor();
  const firstConfirm = await page.evaluate(() => state.stopConfirm);
  ev.r2_1 = { task: t, a: a.body.attempt.attempt_id, firstConfirm };
  // 前端的确认必须绑到第一次 409 点名的那个实例（R2-1 修复的第一半）
  assert.equal(firstConfirm && firstConfirm.attemptId, a.body.attempt.attempt_id,
    `前端确认应绑 A=${a.body.attempt.attempt_id}，实际 ${JSON.stringify(firstConfirm)}`);

  // 另一个客户端完成 A、启动 B（B 无 pid = 外部声明；旁边还留一个真活着的外部进程，
  // 对应「B 其实还在外面跑」这个事实——修复后库不许把它说成已停）
  await call('POST', `/api/tasks/${t}/finish`, { evidence: 'R3 A finished elsewhere', result: 'passed' });
  externalWorker = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { externalWorker.once('spawn', resolve); externalWorker.once('error', reject); });
  const b = await call('POST', `/api/tasks/${t}/attempt`, { agent_id: 'dsh' });
  assert.equal(b.status, 201, `A 已结束，B 必须能接替：${JSON.stringify(b.body)}`);
  ev.r2_1.b = b.body.attempt.attempt_id;

  // 刷新列表：确认态必须跟着实例换手作废（评审里它还挂着「确认已停止」）
  await page.locator('#refresh-btn').click();
  await page.waitForFunction((id) => state.tasksData.tasks.find((x) => x.task_id === id)?.active_attempt_id != null, t);
  const clearedConfirm = await page.evaluate(() => state.stopConfirm);
  const confirmText = await page.locator(`[data-line="${t}"] [data-act="stop"]`).innerText();
  ev.r2_1.afterRefresh = { clearedConfirm, confirmText };
  assert.equal(clearedConfirm, null, `换手后确认必须作废，实际 ${JSON.stringify(clearedConfirm)}`);
  assert.equal(confirmText, '停止', `按钮文字必须回到「停止」，实际「${confirmText}」`);

  // 评审里那一步「点确认按钮 → POST {actor,confirm:true} → 200」：现在按钮已是普通停止，
  // 再点就是第一次语义（不带 confirm）；旧形态的确认请求由接口层直接挡：
  const unbound = await call('POST', `/api/tasks/${t}/stop`, { actor: 'probe:adversarial', confirm: true });
  ev.r2_1.unboundConfirm = { status: unbound.status, code: unbound.body.code };
  assert.equal(unbound.status, 400, `不带 attempt_id 的 confirm 必须 400，实际 ${unbound.status}`);
  assert.equal(unbound.body.code, 'STOP_CONFIRM_REQUIRES_ATTEMPT');

  // 拿旧确认（绑 A 的 id）直接打接口：409 STOP_TARGET_CHANGED，B 一个字段不许动
  const stale = await call('POST', `/api/tasks/${t}/stop`, {
    actor: 'probe:adversarial', confirm: true, attempt_id: a.body.attempt.attempt_id,
  });
  ev.r2_1.staleConfirm = { status: stale.status, code: stale.body.code, message: stale.body.error };
  assert.equal(stale.status, 409, `旧确认必须 409，实际 ${stale.status}`);
  assert.equal(stale.body.code, 'STOP_TARGET_CHANGED', `错误码必须是 STOP_TARGET_CHANGED，实际 ${stale.body.code}`);
  const bRow = db.prepare('SELECT status,end_reason FROM attempts WHERE attempt_id=?').get(b.body.attempt.attempt_id);
  assert.equal(bRow.status, 'running', '旧确认不许把 B 标成结束');
  assert.equal(bRow.end_reason, null, '旧确认不许给 B 写 user_stop');
  assert.equal(db.prepare("SELECT count(*) n FROM events WHERE task_id=? AND event_type='task_stopped'").get(t).n, 0,
    '旧确认不许留下任何停止审计');

  // 删除仍被拒（B 在跑，旧确认不能放行删除）
  const deleteRefused = await call('DELETE', `/api/tasks/${t}`);
  ev.r2_1.deleteWhileBRunning = { status: deleteRefused.status, code: deleteRefused.body.code };
  assert.equal(deleteRefused.status, 409, `B 在跑，删除必须 409，实际 ${deleteRefused.status}`);
  assert.equal(deleteRefused.body.code, 'TASK_RUNNING');

  // 外部进程还活着 = 「B 确实还在跑」；修复后系统口径（B=running、删除被拒）与它一致。
  // 上一轮的病是：进程活着、库却说已停、还放行了删除。
  process.kill(externalWorker.pid, 0);
  ev.r2_1.externalWorker = { pid: externalWorker.pid, alive: true, consistentWith: 'B 仍为 running、删除被拒——口径一致' };

  // 走正规流程收尾：新的 409 给 B → 绑 B 确认 → 200 → 删除放行
  const again = await call('POST', `/api/tasks/${t}/stop`, { actor: 'probe' });
  assert.equal(again.status, 409);
  assert.equal(again.body.attempt_id, b.body.attempt.attempt_id, '新的 409 必须点名 B');
  const stopB = await call('POST', `/api/tasks/${t}/stop`, {
    actor: 'probe', confirm: true, attempt_id: again.body.attempt_id,
  });
  assert.equal(stopB.status, 200, JSON.stringify(stopB.body));
  assert.equal(stopB.body.remaining_running.count, 0);
  const deleteOk = await call('DELETE', `/api/tasks/${t}`);
  ev.r2_1.legitimateFlow = { stop: stopB.status, remaining: stopB.body.remaining_running.count, delete: deleteOk.status };
  assert.equal(deleteOk.status, 200, `全停干净后删除必须放行，实际 ${deleteOk.status}`);
  await shot(page, 'r3-r2-1-stale-confirm-refused-1440x900.png');

  // =========================================================================
  // R2-2（P2）：多 running 停一次后按钮消失、删除仍被拒。
  // 评审复现：连续两次 POST attempt 均 201 → stop(confirm=true)=200 只停最新 →
  //           running 还剩 1、active_attempt_id=null → 界面 stop 按钮 0 个 → DELETE 409。
  // 修复后应验：入口就拒绝第二个（409 ATTEMPT_ALREADY_RUNNING）；
  //           遗留形态（库里已有的重复 running）由 running_attempts / remaining_running
  //           把按钮和事实对齐：停一个按钮还在，全停下来才放行删除。
  // =========================================================================
  const multi = await create('R3 两个 running 的遗留形态');
  const m1 = await call('POST', `/api/tasks/${multi}/attempt`, { agent_id: 'dsh' });
  assert.equal(m1.status, 201);
  const m2 = await call('POST', `/api/tasks/${multi}/attempt`, { agent_id: 'dsh' });
  ev.r2_2 = { task: multi, startStatuses: [m1.status, m2.status], secondStartCode: m2.body.code };
  assert.equal(m2.status, 409, `单活动实例约束：第二个必须 409，实际 ${m2.status}`);
  assert.equal(m2.body.code, 'ATTEMPT_ALREADY_RUNNING', `错误码必须是 ATTEMPT_ALREADY_RUNNING，实际 ${m2.body.code}`);

  // 遗留形态：约束上线前库里已经有的第二条 running（API 已进不去，直接摆库——生产修复不删别人的执行记录）
  const legacyId = `a-r3legacy-${Date.now().toString(36)}`;
  db.prepare("INSERT INTO attempts (attempt_id, task_id, agent_id, status, worktree_path, checkpoint_id, started_at, ended_at, end_reason, pid, session_id, relay_pending, note) VALUES (?, ?, 'dsh', 'running', NULL, NULL, ?, NULL, NULL, NULL, NULL, 0, 'R3 遗留形态：约束上线前的重复 running')")
    .run(legacyId, multi, new Date(Date.now() + 500).toISOString());
  const runningRows = db.prepare("SELECT attempt_id FROM attempts WHERE task_id=? AND status='running' ORDER BY started_at").all(multi);
  ev.r2_2.legacy = { inserted: legacyId, running: runningRows.map((r) => r.attempt_id) };
  assert.equal(runningRows.length, 2, '摆数据：两条 running');

  // 界面：两条 running 的行必须有「停止」按钮（评审里停完最新的那个后按钮数=0）
  await page.reload({ waitUntil: 'networkidle' });
  const buttonsBefore = await page.locator(`[data-line="${multi}"] [data-act="stop"]`).count();
  ev.r2_2.stopButtonsBefore = buttonsBefore;
  assert.equal(buttonsBefore, 1, `两条 running 的行必须有「停止」按钮，实际 ${buttonsBefore} 个`);
  await shot(page, 'r3-r2-2-two-running-stop-present-1440x900.png');

  // 从 UI 停最新那条（第一次点 → 409 点名；确认 → 200 剩余 1），按钮必须还在
  const stopUrl = (r) => r.url().endsWith(`/api/tasks/${multi}/stop`) && r.request().method() === 'POST';
  const first = page.waitForResponse(stopUrl);
  await page.locator(`[data-line="${multi}"] [data-act="stop"]`).click();
  const firstRes = await first;
  const firstBody = await firstRes.json();
  ev.r2_2.firstStop = { status: firstRes.status(), code: firstBody.code, attempt_id: firstBody.attempt_id };
  assert.equal(firstRes.status(), 409);
  assert.equal(firstBody.attempt_id, legacyId, `第一次 409 必须点名最新的实例（遗留那条），实际 ${firstBody.attempt_id}`);
  const confirmWait = page.waitForResponse((r) => stopUrl(r) && r.request().postDataJSON()?.confirm === true);
  await page.locator(`[data-line="${multi}"] [data-confirm="1"]`).click();
  const confirmRes = await confirmWait;
  const confirmBody = await confirmRes.json();
  ev.r2_2.confirmStop = {
    status: confirmRes.status(),
    remaining: confirmBody.remaining_running,
  };
  assert.equal(confirmRes.status(), 200, JSON.stringify(confirmBody));
  assert.equal(confirmBody.remaining_running.count, 1, '停止答复必须说明还剩 1 个在跑');
  assert.equal(confirmBody.remaining_running.attempts[0].attempt_id, m1.body.attempt.attempt_id, '剩余点名的是最早那条');
  await page.reload({ waitUntil: 'networkidle' });
  const buttonsAfter = await page.locator(`[data-line="${multi}"] [data-act="stop"]`).count();
  ev.r2_2.stopButtonsAfterOneStop = buttonsAfter;
  assert.equal(buttonsAfter, 1, `停了一个还有 1 个在跑，「停止」按钮必须还在，实际 ${buttonsAfter} 个（评审里是 0）`);
  await shot(page, 'r3-r2-2-one-stopped-button-still-there-1440x900.png');
  const deleteRefused2 = await call('DELETE', `/api/tasks/${multi}`);
  ev.r2_2.deleteWhileRemaining = { status: deleteRefused2.status, code: deleteRefused2.body.code };
  assert.equal(deleteRefused2.status, 409, `还有实例在跑，删除必须被拒（与按钮仍在一致），实际 ${deleteRefused2.status}`);

  // 再从 UI 停剩下的 → 剩余 0 → 删除放行
  const first2 = page.waitForResponse(stopUrl);
  await page.locator(`[data-line="${multi}"] [data-act="stop"]`).click();
  const first2Res = await first2;
  const first2Body = await first2Res.json();
  assert.equal(first2Res.status(), 409);
  assert.equal(first2Body.attempt_id, m1.body.attempt.attempt_id, '这次 409 点名剩下那条');
  const confirm2Wait = page.waitForResponse((r) => stopUrl(r) && r.request().postDataJSON()?.confirm === true);
  await page.locator(`[data-line="${multi}"] [data-confirm="1"]`).click();
  const confirm2Res = await confirm2Wait;
  const confirm2Body = await confirm2Res.json();
  ev.r2_2.confirmStopRemaining = { status: confirm2Res.status(), remaining: confirm2Body.remaining_running.count };
  assert.equal(confirm2Res.status(), 200);
  assert.equal(confirm2Body.remaining_running.count, 0, '全停干净剩余必须是 0');
  const deleteOk2 = await call('DELETE', `/api/tasks/${multi}`);
  ev.r2_2.deleteAfterAllStopped = deleteOk2.status;
  assert.equal(deleteOk2.status, 200, `全停干净必须能删（评审里是 409 死局），实际 ${deleteOk2.status}`);
  await shot(page, 'r3-r2-2-all-stopped-deleted-1440x900.png');

  // =========================================================================
  // R2-3（P2）：详情接口新增状态同步在审计失败时部分提交。
  // 评审复现：无实例任务、缓存 status 摆成 running；注入只拒 status_changed 的 trigger；
  //           GET /api/tasks/:id = 500，但库里 status 已变 waiting、updated_at 已变、事件=0。
  // 修复后应验：GET 500，status / status_reason / updated_at 一字不动，事件不增；
  //           拿掉 trigger 后同样的请求 200 且状态列对齐（有审计）。
  // =========================================================================
  const drift = await create('R3 详情审计失败回滚');
  db.prepare("UPDATE tasks SET status='running' WHERE task_id=?").run(drift);
  const before = db.prepare('SELECT status,status_reason,updated_at FROM tasks WHERE task_id=?').get(drift);
  db.exec("CREATE TRIGGER r3_fail_status BEFORE INSERT ON events WHEN NEW.event_type='status_changed' BEGIN SELECT RAISE(ABORT,'R3 reject status audit'); END");
  const detail = await call('GET', `/api/tasks/${drift}`);
  const after = db.prepare('SELECT status,status_reason,updated_at FROM tasks WHERE task_id=?').get(drift);
  const eventsAfter = db.prepare("SELECT count(*) n FROM events WHERE task_id=? AND event_type='status_changed'").get(drift);
  db.exec('DROP TRIGGER r3_fail_status');
  ev.r2_3 = { task: drift, before, response: { status: detail.status, code: detail.body.code }, after, events: eventsAfter.n };
  assert.equal(detail.status, 500, `审计写失败必须 500，实际 ${detail.status}`);
  assert.deepEqual(after, before, `失败后主记录必须原样（前 ${JSON.stringify(before)}，后 ${JSON.stringify(after)}）`);
  assert.equal(eventsAfter.n, 0, '被拒的审计事件不许留下');
  // 对照：拿掉 trigger，同样的请求 200、状态列对齐、审计在
  const ok = await call('GET', `/api/tasks/${drift}`);
  const aligned = db.prepare('SELECT status,status_reason FROM tasks WHERE task_id=?').get(drift);
  const eventsOk = db.prepare("SELECT count(*) n FROM events WHERE task_id=? AND event_type='status_changed'").get(drift);
  ev.r2_3.control = { status: ok.status, taskStatus: ok.body.task && ok.body.task.status, dbStatus: aligned.status, events: eventsOk.n };
  assert.equal(ok.status, 200);
  assert.equal(aligned.status, ok.body.task.status, '对齐后接口和库里说的必须是同一件事');
  assert.equal(eventsOk.n, 1, '对齐这一次必须留下审计事件');

  console.log('R3 三个场景全部按修复后契约通过。');
} finally {
  if (externalWorker && externalWorker.exitCode === null) {
    const exited = new Promise((resolve) => externalWorker.once('exit', resolve));
    externalWorker.kill();
    await exited;
  }
  writeFileSync(`${out}/r3-verify.json`, JSON.stringify(ev, null, 2));
  await browser?.close();
  db?.close();
  await s.stop();
}
console.log(JSON.stringify(ev, null, 2));
