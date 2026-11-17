// g02-approval.test.js — G02 回归：审批核心逻辑（approval.js 视图 + 提交闭环）
// 覆盖：decideHtml 六分支（failed 重提/完成反馈/门禁未到/等待前置/无对象/可决策）、
// 重复提交锁、版本门禁镜像禁用、submitDecision 守卫链与四分支收尾。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadOffice } from '../test-support/g02-vm.mjs';

const ctx = () => loadOffice(['shared.js', 'version.js', 'approval.js', 'decision-ops.js']);

// 夹具：req 已完成，doc（决策门禁）待拍板
const baseTask = () => ({
  id: 'T1', title: 'G02 测试需求', updatedAt: 3,
  steps: [
    { key: 'req', no: 1, name: '原始需求', status: 'done', gate: false, by: 'Leo', at: '2026-11-16T09:00:00Z', note: '原话' },
    { key: 'doc', no: 2, name: '需求文档', status: 'awaiting', gate: true, by: 'Hermes', at: '2026-11-16T10:00:00Z' },
  ],
});
const withFiles = (t) => {
  t.steps[1].files = [{ path: 'D:/d/需求文档.md', bytes: 10, sha256: 'aabbccdd', kind: 'doc' }];
  return t;
};
const decide = (c, t) => c.run(`(() => {
  const t = ${JSON.stringify(t)};
  return decideHtml(t, t.steps[1], t.steps, 1);
})()`);

test('decideHtml：failed 步骤出重提面板（打回不是死路）', () => {
  const c = ctx();
  const t = baseTask();
  t.steps[1].status = 'failed';
  t.steps[1].note = '结构没对齐';
  const r = decide(c, t);
  assert.match(r.html, /已打回 · 待修改后重提/);
  assert.match(r.html, /打回理由：结构没对齐/);
  assert.match(r.html, /data-decide="resubmit"/);
  assert.equal(r.acts, '', 'failed 分支 acts 为空，底栏不占位');
});

test('decideHtml：不可决策 + 已通过反馈 → 一条确认反馈（不冒充）', () => {
  const c = ctx();
  const t = baseTask();
  t.steps[1].status = 'done';
  c.run(`__g02.decisionResults.set('T1/doc', { key: 'T1/doc', ok: true, action: 'approve', at: '2026-11-16T11:00:00Z' })`);
  const r = decide(c, t);
  assert.match(r.html, /✓ 已通过/);
  assert.equal(r.acts, '');

  const c2 = ctx();
  c2.run(`__g02.decisionResults.set('T1/doc', { key: 'T1/doc', ok: true, action: 'approve', unconfirmed: true, msg: '归属未确认' })`);
  const r2 = decide(c2, baseTask().steps && (() => { const t = baseTask(); t.steps[1].status = 'done'; return t; })());
  assert.match(r2.html, /档案已变更，本次提交尚未确认/);
});

test('decideHtml：gate+pending 前序未齐 → 门禁未到', () => {
  const c = ctx();
  const t = baseTask();
  t.steps[0].status = 'pending';
  t.steps[1].status = 'pending';
  const r = decide(c, t);
  assert.match(r.html, /门禁未到/);
  assert.match(r.html, /01 原始需求/);
  assert.equal(r.acts, '');
});

test('decideHtml：awaiting 前序未齐 → 等待前置条件（不进待决策）', () => {
  const c = ctx();
  const t = baseTask();
  t.steps[0].status = 'running';
  const r = decide(c, t);
  assert.match(r.html, /等待前置条件/);
  assert.equal(r.acts, '');
});

test('decideHtml：可决策但无登记产物 → 只有补齐材料，没有可点的通过', () => {
  const c = ctx();
  const r = decide(c, baseTask());
  assert.match(r.acts, /data-decide="request"/);
  assert.doesNotMatch(r.acts, /data-decide="approve"/);
  assert.match(r.html, /本步骤尚无登记产物/);
});

test('decideHtml：可决策且有产物 → 通过/打回按钮，对象先行展示', () => {
  const c = ctx();
  const r = decide(c, withFiles(baseTask()));
  assert.match(r.acts, /data-decide="approve"/);
  assert.match(r.acts, /data-decide="reject"/);
  assert.doesNotMatch(r.acts, /data-decide="approve"[^>]*disabled/);
  assert.match(r.html, /审批对象 · 需求文档/);
  assert.match(r.html, /需求文档\.md/);
});

test('decideHtml：pendingOps 占用中 → 按钮锁定 + 待确认条（防重复提交）', () => {
  const c = ctx();
  c.run(`pendingOps.set('T1/doc', { id: 'op-x' })`);
  const r = decide(c, withFiles(baseTask()));
  assert.match(r.acts, /data-decide="approve"[^>]*disabled/);
  assert.match(r.html, /结果待确认/);
});

test('decideHtml：服务端版本判定不过 → 主操作禁用 + 材料不一致警示', () => {
  const c = ctx();
  c.run(`versionGate = {
    key: 'T1/doc', taskId: 'T1', stepKey: 'doc', valid: false,
    drifted: [{ path: 'D:/d/需求文档.md', why: 'bytes', exists: true, regBytes: 10, actBytes: 99, regSha: null }],
    policy: null, src: 'probe', at: Date.now(), versionExempt: false,
  }`);
  const r = decide(c, withFiles(baseTask()));
  assert.match(r.acts, /data-decide="approve"[^>]*disabled/);
  assert.match(r.acts, /data-decide="reject"/, '打回仍可用（版本不符正是打回的用途）');
  assert.match(r.html, /材料与提交登记不一致/);
  assert.match(r.html, /已禁止按原版本通过/);
});

// ---- submitDecision：守卫链 + 写回闭环 ----

const setupSubmit = (c) => {
  c.run(`__g02.curTask = ${JSON.stringify(withFiles(baseTask()))}`);
};

test('submitDecision：操作标识占用中拒绝再次提交（不发请求）', async () => {
  const c = ctx();
  setupSubmit(c);
  c.run(`pendingOps.set('T1/doc', { id: 'op-busy' })`);
  await c.runAsync('await submitDecision("approve")');
  assert.equal(c.run('__g02.fetchCalls.length'), 0, '占用中不得再发写回请求');
});

test('submitDecision：打回/补材料必须写备注（两条守卫文案）', async () => {
  const c1 = ctx();
  setupSubmit(c1);
  await c1.runAsync('await submitDecision("reject")');
  assert.equal(c1.run(`__g02.decisionResults.get('T1/doc').msg`), '打回必须写理由（备注框）');
  assert.equal(c1.run('__g02.fetchCalls.length'), 0);

  const c2 = ctx();
  setupSubmit(c2);
  await c2.runAsync('await submitDecision("request")');
  assert.equal(c2.run(`__g02.decisionResults.get('T1/doc').msg`), '补齐材料必须写明缺什么（备注框）');
  assert.equal(c2.run('__g02.fetchCalls.length'), 0);
});

test('submitDecision：approve verified 成功 → 释放占用/清草稿/并档/op 记录', async () => {
  const c = ctx();
  setupSubmit(c);
  c.run(`decisionNotes.set('T1/doc', '通过理由');
         lastFlow = { tasks: [{ id: 'T1', title: '旧档案', steps: [] }] };`);
  c.run(`__g02.fetchImpl = () => ({ ok: true, status: 200, json: async () => ({
    verified: true,
    step: { status: 'done', at: '2026-11-16T12:00:00Z', note: '通过理由' },
    demand: { id: 'T1', title: '写后档案', steps: [] },
  }) })`);
  await c.runAsync('await submitDecision("approve")');
  const r = c.run(`({
    calls: __g02.fetchCalls.map(f => f.url),
    body: JSON.parse(__g02.fetchCalls[0].body),
    res: __g02.decisionResults.get('T1/doc'),
    ops: __g02.opResults,
    pend: pendingOps.size,
    notes: decisionNotes.size,
    flowTitle: lastFlow.tasks[0].title,
    flowLen: lastFlow.tasks.length,
  })`);
  assert.deepEqual(r.calls, ['/api/office/decision']);
  assert.deepEqual(r.body, { demandId: 'T1', stepKey: 'doc', action: 'approve', reason: '通过理由' });
  assert.equal(r.res.ok, true);
  assert.equal(r.res.action, 'approve');
  assert.equal(r.pend, 0, '确定成功必须释放操作占用');
  assert.equal(r.notes, 0, '确定成功才清备注草稿');
  assert.equal(r.ops.length, 1);
  assert.equal(r.ops[0].opId.length > 0, true);
  assert.equal(r.flowTitle, '写后档案', '写后档案立即并入本地快照');
  assert.equal(r.flowLen, 1, '同需求替换不追加');
});

test('submitDecision：resubmit 走旧端点（taskId/step/note/opId）', async () => {
  const c = ctx();
  setupSubmit(c);
  c.run(`decisionNotes.set('T1/doc', '改好了')`);
  c.run(`__g02.fetchImpl = () => ({ ok: true, status: 200, json: async () => ({ verified: true, step: { status: 'awaiting' } }) })`);
  await c.runAsync('await submitDecision("resubmit")');
  const r = c.run(`({ url: __g02.fetchCalls[0].url, body: JSON.parse(__g02.fetchCalls[0].body) })`);
  assert.equal(r.url, '/api/office/resubmit');
  assert.equal(r.body.taskId, 'T1');
  assert.equal(r.body.step, 'doc');
  assert.equal(r.body.note, '改好了');
  assert.equal(typeof r.body.opId, 'string');
});

test('submitDecision：服务端明确拒绝（HTTP 结论）→ 确定失败并释放占用', async () => {
  const c = ctx();
  setupSubmit(c);
  c.run(`__g02.fetchImpl = () => ({ ok: false, status: 409, json: async () => ({ error: '版本门禁：材料已变化' }) })`);
  await c.runAsync('await submitDecision("approve")');
  const r = c.run(`({
    res: __g02.decisionResults.get('T1/doc'),
    ops: __g02.opResults,
    pend: pendingOps.size,
    firstUrl: __g02.fetchCalls[0].url,
  })`);
  assert.equal(r.firstUrl, '/api/office/decision');
  assert.equal(r.res.ok, undefined);
  assert.equal(r.res.msg, '版本门禁：材料已变化');
  assert.equal(r.pend, 0, 'HTTP 确定失败必须释放占用允许重试');
  assert.equal(r.ops[0].msg, '版本门禁：材料已变化');
});

// ---- applyDecisionOutcome：四分支收尾（G02 自 submitDecision 拆出的函数） ----

test('applyDecisionOutcome：unconfirmed → 不冒领成功的 ⚠ 结果', () => {
  const c = ctx();
  c.run(`pendingOps.set('T1/doc', { id: 'op-u' });
         applyDecisionOutcome({ unconfirmed: true, unverifiedReason: '写入者不是本次操作', step: { at: '2026-11-16T12:00:00Z' } },
           'T1/doc', { id: 'op-u', taskId: 'T1', stepKey: 'doc' }, 'approve')`);
  const r = c.run(`({ res: __g02.decisionResults.get('T1/doc'), ops: __g02.opResults, pend: pendingOps.size })`);
  assert.equal(r.res.ok, true);
  assert.equal(r.res.unconfirmed, true);
  assert.equal(r.res.msg, '写入者不是本次操作');
  assert.equal(r.pend, 0);
  assert.equal(r.ops[0].unconfirmed, true);
});

test('applyDecisionOutcome：readBack=false → 保留占用交回查循环', () => {
  const c = ctx();
  c.run(`pendingOps.set('T1/doc', { id: 'op-r' });
         applyDecisionOutcome({ readBack: false }, 'T1/doc', { id: 'op-r', taskId: 'T1', stepKey: 'doc' }, 'approve')`);
  const r = c.run(`({ has: __g02.decisionResults.has('T1/doc'), ops: __g02.opResults.length, pend: pendingOps.size })`);
  assert.equal(r.has, false, '展示交给待确认条，不落确定结论');
  assert.equal(r.ops, 0);
  assert.equal(r.pend, 1, '已写入但未确认：占用不释放，回查循环继续核验');
});

test('applyDecisionOutcome：写回状态对不上（mismatch）→ 明说并释放', () => {
  const c = ctx();
  c.run(`pendingOps.set('T1/doc', { id: 'op-m' });
         applyDecisionOutcome({ to: 'awaiting', after: { status: 'awaiting' } },
           'T1/doc', { id: 'op-m', taskId: 'T1', stepKey: 'doc', targetStatus: 'done' }, 'approve')`);
  const r = c.run(`({ res: __g02.decisionResults.get('T1/doc'), ops: __g02.opResults, pend: pendingOps.size })`);
  assert.match(r.res.msg, /写回未确认/);
  assert.match(r.res.msg, /awaiting/);
  assert.match(r.res.msg, /done/);
  assert.equal(r.pend, 0);
  assert.equal(r.ops[0].msg, r.res.msg);
});
