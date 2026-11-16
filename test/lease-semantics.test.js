/**
 * 租约安全语义测试 —— 测试「租约过期之后到底会发生什么」。
 *
 * 为什么单独建这个文件：lease.test.js 覆盖的是「happy path + token 校验」，
 * 但漏掉了「租约已过期」这个状态本身。实测发现三个真实漏洞：
 *
 *   漏洞1 租约过期后旧执行者还能 renewLease 把自己续回来 → 任务被永久锁死
 *   漏洞2 租约过期后旧执行者还能提交 done       → 租约形同虚设
 *   漏洞3 已 done 的任务能用同一 token 改回 running → 终态可被翻案
 *
 * 三个漏洞的共同根因：renewLease / updateTaskStatusWithToken 的 WHERE 只卡了
 * claim_token 和 status，没卡 lease_expires_at。本文件锁死这些语义，防回归。
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import {
  initializeDatabase,
  insertAgent,
  insertTask,
  claimTask,
  renewLease,
  updateTaskStatusWithToken,
  listSuspectTasks,
  resolveSuspectTask,
  getTaskById,
} from '../src/db.js';

let db;
let dbPath;

beforeEach(() => {
  if (db) {
    db.close();
    rmSync(dbPath, { force: true }); // 上一轮的库文件一并清掉，别留一堆 .db
  }
  dbPath = `./tmp-lease-sem-${randomUUID().slice(0, 8)}.db`;
  rmSync(dbPath, { force: true });
  db = initializeDatabase(dbPath);
});

after(() => {
  if (db) db.close();
  rmSync(dbPath, { force: true });
});

/** 把任务租约置为已过期（模拟系统睡眠 / 进程暂停 / 网络抖动） */
function expireLease(taskId, agoMs = 1000) {
  db.run('UPDATE tasks SET lease_expires_at = ? WHERE id = ?', [Date.now() - agoMs, taskId]);
}

function setup() {
  const a = insertAgent(db, { name: `A-${randomUUID().slice(0, 6)}` });
  const b = insertAgent(db, { name: `B-${randomUUID().slice(0, 6)}` });
  const t = insertTask(db, { title: 'task' });
  const { claim_token: tokenA } = claimTask(db, t.id, a.id);
  return { a, b, t, tokenA };
}

// ── 漏洞 1：租约过期后不许自我续命 ──────────────────────────────
test('租约过期后旧执行者续约被拒，reason=lease_expired', () => {
  const { t, tokenA } = setup();
  expireLease(t.id);
  const r = renewLease(db, t.id, tokenA);
  assert.equal(r.ok, false, '过期租约不该能续');
  assert.equal(r.reason, 'lease_expired');
});

test('租约未过期时续约正常（不得因新闸误伤）', () => {
  const { t, tokenA } = setup();
  const r = renewLease(db, t.id, tokenA);
  assert.equal(r.ok, true);
  assert.ok(r.lease_expires_at > Date.now());
});

test('过期后无法靠连续续约把任务永久占住', () => {
  const { t, tokenA } = setup();
  expireLease(t.id);
  for (let i = 0; i < 5; i++) assert.equal(renewLease(db, t.id, tokenA).ok, false);
  // 任务仍在可疑列表里，等人工处置
  assert.ok(listSuspectTasks(db).some((s) => s.id === t.id));
});

// ── 漏洞 2：租约过期后不许写 ────────────────────────────────────
test('租约过期后旧执行者提交结果被拒，库未被污染', () => {
  const { t, tokenA } = setup();
  expireLease(t.id);
  const r = updateTaskStatusWithToken(db, t.id, tokenA, 'done', { result_path: '/A' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'lease_expired');
  const row = getTaskById(db, t.id);
  assert.equal(row.status, 'claimed');
  assert.equal(row.result_path, null);
});

test('租约过期后连中间态 running 也写不进去', () => {
  const { t, tokenA } = setup();
  expireLease(t.id);
  assert.equal(updateTaskStatusWithToken(db, t.id, tokenA, 'running').ok, false);
  assert.equal(getTaskById(db, t.id).status, 'claimed');
});

test('requeue 换新 token 后，新执行者能正常提交', () => {
  const { b, t, tokenA } = setup();
  expireLease(t.id);
  assert.equal(updateTaskStatusWithToken(db, t.id, tokenA, 'done').ok, false);
  assert.equal(resolveSuspectTask(db, t.id, 'requeue').ok, true);
  const { claim_token: tokenB } = claimTask(db, t.id, b.id);
  const r = updateTaskStatusWithToken(db, t.id, tokenB, 'done', { result_path: '/B' });
  assert.equal(r.ok, true);
  assert.equal(getTaskById(db, t.id).result_path, '/B');
});

// ── 漏洞 3：终态不可翻案 ────────────────────────────────────────
test('已 done 的任务不能被改回 running，reason=terminal', () => {
  const { t, tokenA } = setup();
  assert.equal(updateTaskStatusWithToken(db, t.id, tokenA, 'done').ok, true);
  const r = updateTaskStatusWithToken(db, t.id, tokenA, 'running');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'terminal');
  assert.equal(getTaskById(db, t.id).status, 'done');
});

test('已 failed / cancelled 的任务同样不可回退', () => {
  for (const terminalStatus of ['failed', 'cancelled']) {
    const { t, tokenA } = setup();
    assert.equal(updateTaskStatusWithToken(db, t.id, tokenA, terminalStatus).ok, true);
    const r = updateTaskStatusWithToken(db, t.id, tokenA, 'running');
    assert.equal(r.ok, false, `${terminalStatus} 应不可回退`);
    assert.equal(r.reason, 'terminal');
  }
});

test('终态任务续约被拒', () => {
  const { t, tokenA } = setup();
  updateTaskStatusWithToken(db, t.id, tokenA, 'done');
  const r = renewLease(db, t.id, tokenA);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_active');
});

test('终态不可被覆盖成另一个终态（防止事后篡改交付结果）', () => {
  const { t, tokenA } = setup();
  updateTaskStatusWithToken(db, t.id, tokenA, 'done', { result_path: '/real' });
  assert.equal(updateTaskStatusWithToken(db, t.id, tokenA, 'failed').ok, false);
  assert.equal(getTaskById(db, t.id).status, 'done');
});

// ── 组合：崩溃重试全链路 ────────────────────────────────────────
test('同一任务连续 5 次崩溃重试，attempt 累计到 5', () => {
  const { a, t } = setup(); // setup() 已经领过 1 次，attempt=1
  for (let i = 2; i <= 5; i++) {
    expireLease(t.id);
    assert.equal(resolveSuspectTask(db, t.id, 'requeue').ok, true);
    const r = claimTask(db, t.id, a.id);
    assert.equal(r.ok, true, `第 ${i} 次领取应成功`);
    assert.equal(r.task.attempt, i);
  }
  assert.equal(getTaskById(db, t.id).attempt, 5);
});

test('旧执行者在每次 requeue 后都失去写权（token 轮换彻底）', () => {
  const { a, t, tokenA } = setup();
  const seen = new Set([tokenA]);
  for (let i = 0; i < 3; i++) {
    expireLease(t.id);
    resolveSuspectTask(db, t.id, 'requeue');
    const { claim_token } = claimTask(db, t.id, a.id);
    assert.ok(!seen.has(claim_token), '新 token 必须与历史 token 不同');
    seen.add(claim_token);
  }
  // 最早的 token 早已失效
  assert.equal(updateTaskStatusWithToken(db, t.id, tokenA, 'done').ok, false);
});
