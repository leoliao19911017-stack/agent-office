// g02-server-core.test.js — G02 回归：服务端决策闭环核心（server-core.mjs，G02 自 server.js 抽出）
// 覆盖：可处理口径（items/blocked/rejected/waitingOn）、决策写互斥锁 + TTL、
// 产物类型门禁、审批对象口径、版本门禁（真实临时文件实测）、档案视图投影。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import {
  computeDecisions, lockDecision, unlockDecision,
  artifactPolicyOf, artifactGateOf, artifactMismatchMessage,
  approvalObjectOfRec, approvalFilesOfRec, artifactVersionGateOf, artifactVersionMessage,
  taskDemandView, stepViewOf, writeOwnedByThisOp, execFlowWriteAndVerify, createDecisionCore,
} from '../web/server-core.mjs';

// STEP_DEFS（server-core 15-26）：req(1) doc(2,gate) plan(3,expectsKinds:['plan'])
// brief(4) deliverable(5) verify(6) final(7,gate)
const rec = (steps, extra = {}) => ({ id: 'T1', title: '测试需求', steps, ...extra });

test('computeDecisions：全 7 步分诊——doc 可批进 items；final 前序未齐进 blocked', () => {
  const ok = computeDecisions([rec({ req: { status: 'done' }, doc: { status: 'awaiting' } })]);
  assert.equal(ok.items.length, 1);
  assert.equal(ok.items[0].stepKey, 'doc');
  assert.equal(ok.items[0].kind, 'gate', 'doc 是决策门禁步');
  // final（gate+pending，plan..verify 缺位）也参与分诊：前序未齐 → blocked 可见
  assert.equal(ok.blocked.length, 1);
  assert.equal(ok.blocked[0].stepKey, 'final');
  assert.deepEqual(ok.blocked[0].waitingOn, ['02 需求文档', '03 开发计划', '04 任务书', '05 交付物', '06 验收报告']);

  const blocked = computeDecisions([rec({ req: { status: 'running' }, doc: { status: 'awaiting' } })]);
  assert.equal(blocked.items.length, 0, 'awaiting 只说明记录已创建，不等于当前可审批');
  assert.equal(blocked.blocked[0].stepKey, 'doc', '前序未齐的 awaiting 排最前，waitingOn 点名卡点');
  assert.deepEqual(blocked.blocked[0].waitingOn, ['01 原始需求']);
});

test('computeDecisions：failed 单列 rejected（打回的再入口）；gate+pending 同口径', () => {
  const r = computeDecisions([rec({ req: { status: 'done' }, plan: { status: 'failed', note: '类型不符' } })]);
  assert.equal(r.rejected.length, 1);
  assert.equal(r.rejected[0].stepKey, 'plan');
  assert.equal(r.rejected[0].note, '类型不符');
  // doc 是 gate 步：记录未创建（pending）但前序已齐 → 照样进 items 待办，不能漏
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].stepKey, 'doc');
  assert.equal(r.items[0].kind, 'gate');
  assert.equal(r.blocked[0].stepKey, 'final');

  const allDone = { req: { status: 'done' }, doc: { status: 'done' }, plan: { status: 'done' }, brief: { status: 'done' }, deliverable: { status: 'done' }, verify: { status: 'done' } };
  const g1 = computeDecisions([rec({ ...allDone, final: { status: 'pending' } })]);
  assert.equal(g1.items.length, 1);
  assert.equal(g1.items[0].stepKey, 'final');
  assert.equal(g1.items[0].kind, 'gate');
  assert.equal(g1.blocked.length, 0);
  const g2 = computeDecisions([rec({ ...allDone, verify: { status: 'running' }, final: { status: 'pending' } })]);
  assert.equal(g2.items.length, 0);
  assert.deepEqual(g2.blocked[0].waitingOn, ['06 验收报告']);
});

test('lockDecision：同步骤写回互斥；TTL 25s 过期后兜底放行；释放后可再锁', () => {
  const key = 'g02-ttl-' + Math.random().toString(36).slice(2);
  const realNow = Date.now;
  try {
    let t = 1_000_000;
    Date.now = () => t;
    assert.equal(lockDecision(key), true);
    assert.equal(lockDecision(key), false, '锁寿命内第二个并发请求必须被拒');
    t += 26_000;                                  // 超过 DECIDE_LOCK_TTL(25000)
    assert.equal(lockDecision(key), true, 'TTL 只兜异常路径：过期后不允许永久死锁');
    unlockDecision(key);
    assert.equal(lockDecision(key), true, '正常路径 finally 释放后立即可再锁');
  } finally {
    Date.now = realNow;
    unlockDecision(key);
  }
});

test('artifactGateOf：plan 步类型门禁——声明 kind 才有效，test-any-file 豁免须带 basis', () => {
  const good = artifactGateOf(rec({ plan: { status: 'awaiting', files: [{ path: 'D:/p.md', bytes: 1, kind: 'plan' }] } }), 'plan');
  assert.equal(good.valid, true);
  assert.equal(good.matched.length, 1);

  const bad = artifactGateOf(rec({ plan: { status: 'awaiting', files: [{ path: 'D:/app.css', bytes: 1 }] } }), 'plan');
  assert.equal(bad.valid, false, '未声明 kind 的产物不能当 plan 审批对象');
  assert.equal(bad.unmatched.length, 1);
  assert.match(artifactMismatchMessage('plan', bad), /不满足类型要求/);
  assert.match(artifactMismatchMessage('plan', bad), /app\.css：未声明类型/);

  const noExpects = artifactGateOf(rec({ brief: { status: 'awaiting', files: [{ path: 'D:/x.md', bytes: 1 }] } }), 'brief');
  assert.equal(noExpects.valid, true, '步骤未声明类型要求：有登记产物即有效（原口径）');
  assert.equal(noExpects.expects, null);

  const exempt = artifactGateOf(rec(
    { plan: { status: 'awaiting', files: [{ path: 'D:/any.css', bytes: 1 }] } },
    { artifactPolicy: { mode: 'test-any-file', basis: 'R11 自测占位' } },
  ), 'plan');
  assert.equal(exempt.valid, true, '测试策略在档：任意登记产物有效');
  assert.equal(exempt.policy.basis, 'R11 自测占位');

  const noBasis = artifactPolicyOf(rec({}, { artifactPolicy: { mode: 'test-any-file' } }));
  assert.equal(noBasis, null, 'basis 缺失不生效，不靠猜');
});

test('approvalObjectOfRec：demand / own / upstream / none 四口径', () => {
  const r = rec({
    req: { status: 'done', note: '原话' },
    doc: { status: 'done', files: [{ path: 'D:/doc.md', bytes: 1 }] },
    plan: { status: 'awaiting', files: [{ path: 'D:/plan.md', bytes: 1 }] },
    brief: { status: 'awaiting' },
  });
  assert.equal(approvalObjectOfRec(r, 'req'), 'demand', 'req 批的是需求本身');
  assert.equal(approvalObjectOfRec(r, 'plan'), 'own');
  assert.equal(approvalObjectOfRec(r, 'final'), 'upstream', 'final 未单独登记 → 引用前序产物（明说，不冒充本步）');
  assert.equal(approvalObjectOfRec(r, 'brief'), 'none', '无对象只许补材料，不许 approve');
  assert.equal(approvalObjectOfRec(r, 'nope'), 'none');
});

test('artifactVersionGateOf：真实临时文件实测——ok/bytes/sha/noreg/missing + 版本豁免', () => {
  const dir = mkdtempSync(join(tmpdir(), 'g02-vg-'));
  try {
    const f1 = join(dir, 'a.md');
    writeFileSync(f1, 'abc');
    const shaAbc = createHash('sha256').update('abc').digest('hex');
    const reg = (files, extra) => rec({ doc: { status: 'awaiting', files } }, extra);
    const gate = (files, extra) => artifactVersionGateOf(reg(files, extra), 'doc');

    let g = gate([{ path: f1, bytes: 3 }]);
    assert.equal(g.valid, true); assert.equal(g.drifted.length, 0); assert.equal(g.versionExempt, false);

    g = gate([{ path: f1, bytes: 999 }]);
    assert.equal(g.valid, false);
    assert.equal(g.drifted[0].why, 'bytes'); assert.equal(g.drifted[0].actBytes, 3);

    g = gate([{ path: f1, bytes: 3, sha256: shaAbc }]);
    assert.equal(g.valid, true, '字节一致且指纹一致');

    writeFileSync(f1, 'xyz');   // 同长度换内容：大小相同内容被改也拦下
    g = gate([{ path: f1, bytes: 3, sha256: shaAbc }]);
    assert.equal(g.valid, false);
    assert.equal(g.drifted[0].why, 'sha');
    writeFileSync(f1, 'abc');

    g = gate([{ path: f1 }]);
    assert.equal(g.valid, false);
    assert.equal(g.drifted[0].why, 'noreg', '登记缺字节数 = 无版本标识');

    unlinkSync(f1);
    g = gate([{ path: f1, bytes: 3 }]);
    assert.equal(g.valid, false);
    assert.equal(g.drifted[0].why, 'missing'); assert.equal(g.drifted[0].exists, false);

    g = gate([{ path: join(dir, 'gone.md'), bytes: 1 }], { artifactPolicy: { mode: 'test-any-file', basis: '占位' } });
    assert.equal(g.versionExempt, true);
    assert.equal(g.valid, true, '版本例外独立生效：豁免阻断但 drifted 照实上报');
    assert.equal(g.drifted.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('taskDemandView：按 STEP_DEFS 投影 7 步、类型要求下发、done 计数', () => {
  const v = taskDemandView(rec({
    req: { status: 'done', at: '2026-11-16T09:00:00Z' },
    doc: { status: 'done' },
    plan: { status: 'awaiting', files: [{ path: 'D:/p.md', bytes: 1, kind: 'plan' }] },
  }, { createdAt: '2026-11-16T08:00:00Z', updatedAt: '2026-11-16T10:00:00Z' }));
  assert.equal(v.id, 'T1');
  assert.equal(v.steps.length, 7);
  assert.deepEqual(v.steps.map((s) => s.key), ['req', 'doc', 'plan', 'brief', 'deliverable', 'verify', 'final']);
  assert.equal(v.done, 2);
  assert.equal(v.total, 7);
  assert.deepEqual(v.steps[2].expectsKinds, ['plan'], 'W01：步骤的类型要求随视图下发');
  assert.equal(v.steps[3].status, 'pending', '未登记的步骤默认 pending');
  assert.equal(v.artifactPolicy, null);
});

test('approvalFilesOfRec：own/upstream/none；双登记不去重逐条保留（F02 版本声明）', () => {
  const r = rec({
    req: { status: 'done', note: '原话' },
    doc: { status: 'done', files: [{ path: 'D:/doc.md', bytes: 1 }, { path: 'D:\\doc.md', bytes: 1 }] },
    deliverable: { status: 'done', files: [{ path: 'D:/d.zip', bytes: 2 }] },
    plan: { status: 'awaiting', files: [{ path: 'D:/a.md', bytes: 1 }, { path: 'D:/a.md', bytes: 1 }] },
    brief: { status: 'awaiting' },
  });
  const own = approvalFilesOfRec(r, 'plan');
  assert.equal(own.src, 'own');
  assert.equal(own.files.length, 2, '不去重：同路径双登记两条都在（每条登记都是一条版本声明）');

  const up = approvalFilesOfRec(r, 'final');
  assert.equal(up.src, 'upstream');
  assert.deepEqual(up.files.map((f) => f.path),
    ['D:/doc.md', 'D:\\doc.md', 'D:/a.md', 'D:/a.md', 'D:/d.zip'],
    '按步骤声明序收前序产物：doc→plan→deliverable，plan 双登记也在内');

  assert.deepEqual(approvalFilesOfRec(r, 'brief'), { src: 'none', files: [] });
  assert.deepEqual(approvalFilesOfRec(r, 'req').src, 'none', 'req 批需求本身，文件不作对象');
  assert.deepEqual(approvalFilesOfRec(r, 'nope'), { src: 'none', files: [] });
});

test('artifactVersionMessage：missing/noreg/sha/bytes 四种差异文案 + 打回指引', () => {
  const msg = artifactVersionMessage('doc', {
    drifted: [
      { path: 'D:/x/缺.md', exists: false, regBytes: 10, actBytes: null },
      { path: 'D:/x/无字节.md', exists: true, regBytes: null, actBytes: 5 },
      { path: 'D:/x/改内容.md', exists: true, regBytes: 3, actBytes: 3, why: 'sha' },
      { path: 'D:/x/变大小.md', exists: true, regBytes: 10, actBytes: 99 },
    ],
  });
  assert.match(msg, /本步骤「需求文档」/);
  assert.match(msg, /缺\.md：文件不存在/);
  assert.match(msg, /无字节\.md：登记字节数缺失/);
  assert.match(msg, /改内容\.md：实测内容指纹与登记 sha256 不一致（大小 3 B 相同，内容已变化）/);
  assert.match(msg, /变大小\.md：实测 99 B ≠ 登记 10 B/);
  assert.match(msg, /请先「打回」要求重新提交/);
});

test('stepViewOf / writeOwnedByThisOp：读回投影与写回归属判定', () => {
  assert.deepEqual(stepViewOf(null, 'doc'), { status: null, at: null, note: '', by: null });
  assert.deepEqual(stepViewOf({ steps: { doc: { status: 'done', at: 'T', note: 'n', by: 'B' } } }, 'doc'),
    { status: 'done', at: 'T', note: 'n', by: 'B' });

  const start = Date.now();
  assert.equal(writeOwnedByThisOp({ by: '别人' }, 'Leo（工作台）', start), false, '写入者不是本次操作');
  assert.equal(writeOwnedByThisOp({ by: 'Leo（工作台）' }, 'Leo（工作台）', start), true, '档案没记时间就只认 by 标记');
  assert.equal(writeOwnedByThisOp({ by: 'Leo（工作台）', at: 'not-a-date' }, 'Leo（工作台）', start), true, '时间解析不了不拦');
  assert.equal(writeOwnedByThisOp({ by: 'Leo（工作台）', at: new Date(start - 2000).toISOString() }, 'Leo（工作台）', start), false, '早于操作窗口（1s 容差外）');
  assert.equal(writeOwnedByThisOp({ by: 'Leo（工作台）', at: new Date(start - 500).toISOString() }, 'Leo（工作台）', start), true, '容差内算本次');
});

test('execFlowWriteAndVerify：真实子进程实测五种结论（success/unknown/mismatch/unconfirmed/failed）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'g02-ev-'));
  try {
    const taskFile = join(dir, 'T1.json');
    const mark = 'Leo（工作台）';
    // 假 flow：真的写档案再按剧本输出——验证的是核验逻辑本身，不 mock 它
    const flowWrite = (step, ok) => ['-e', `const fs=require('fs');
      fs.writeFileSync(${JSON.stringify(taskFile)}, JSON.stringify({steps:{doc:${JSON.stringify(step)}}}));
      ${ok ? "console.log(JSON.stringify({ok:true}))" : "console.error('boom');process.exit(1)"};`];

    // ① flow 报成功 + 读回是目标状态 → success
    let o = await execFlowWriteAndVerify({
      args: flowWrite({ status: 'done', by: mark, at: new Date().toISOString() }, true),
      taskFile, stepKey: 'doc', status: 'done', writerMark: mark, opStartMs: Date.now() - 1000,
    });
    assert.equal(o.kind, 'success');
    assert.equal(o.after.status, 'done');

    // ② flow 报成功但档案读不回 → unknown（读不回 ≠ 写入失败）
    unlinkSync(taskFile);
    o = await execFlowWriteAndVerify({
      args: ['-e', 'console.log(JSON.stringify({ok:true}))'],
      taskFile, stepKey: 'doc', status: 'done', writerMark: mark, opStartMs: Date.now(),
    });
    assert.equal(o.kind, 'unknown');

    // ③ flow 报成功但状态没落上 → mismatch
    o = await execFlowWriteAndVerify({
      args: flowWrite({ status: 'awaiting', by: mark, at: new Date().toISOString() }, true),
      taskFile, stepKey: 'doc', status: 'done', writerMark: mark, opStartMs: Date.now(),
    });
    assert.equal(o.kind, 'mismatch');
    assert.match(o.reason, /写回未确认/);

    // ④ flow 报错但状态已是目标、写入者是别人 → unconfirmed（不冒领）
    o = await execFlowWriteAndVerify({
      args: flowWrite({ status: 'done', by: 'Hermes', at: new Date().toISOString() }, false),
      taskFile, stepKey: 'doc', status: 'done', writerMark: mark, opStartMs: Date.now() - 1000,
    });
    assert.equal(o.kind, 'unconfirmed');
    assert.match(o.reason, /Hermes/);

    // ⑤ flow 报错但状态已是目标、归属核对通过 → success（报错发生在写入之后）
    o = await execFlowWriteAndVerify({
      args: flowWrite({ status: 'done', by: mark, at: new Date().toISOString() }, false),
      taskFile, stepKey: 'doc', status: 'done', writerMark: mark, opStartMs: Date.now() - 1000,
    });
    assert.equal(o.kind, 'success');

    // ⑥ flow 报错且状态不是目标 → failed（唯一确定失败）
    o = await execFlowWriteAndVerify({
      args: flowWrite({ status: 'awaiting', by: mark, at: new Date().toISOString() }, false),
      taskFile, stepKey: 'doc', status: 'done', writerMark: mark, opStartMs: Date.now(),
    });
    assert.equal(o.kind, 'failed');
    assert.match(o.msg, /boom/);

    // ⑦ flow 报错且档案读不回 → unknown，绝不判失败
    unlinkSync(taskFile);
    o = await execFlowWriteAndVerify({
      args: ['-e', "console.error('boom');process.exit(1)"],
      taskFile, stepKey: 'doc', status: 'done', writerMark: mark, opStartMs: Date.now(),
    });
    assert.equal(o.kind, 'unknown');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createDecisionCore：readTaskRecs 好坏文件分账 + ENOENT 静默当空', () => {
  const home = mkdtempSync(join(tmpdir(), 'g02-core-'));
  try {
    const tasks = join(home, 'office-data', 'tasks');
    mkdirSync(tasks, { recursive: true });
    writeFileSync(join(tasks, 'a.json'), JSON.stringify({ id: 'A' }));
    writeFileSync(join(tasks, 'b.json'), '{oops');
    const core = createDecisionCore({ AUTOLOOP_HOME: home, httpError, sendJson });
    const r = core.readTaskRecs();
    assert.equal(r.recs.length, 1);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].file, 'b.json');

    const empty = createDecisionCore({ AUTOLOOP_HOME: join(home, '不存在'), httpError, sendJson }).readTaskRecs();
    assert.deepEqual(empty, { recs: [], errors: [] }, '目录没有 = 真没有，静默当空');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// respondFlowWriteResult 的桩：httpError/sendJson 与 server.js 的用法一致
function httpError(code, label, message) { return Object.assign(new Error(message), { code, label }); }
const sent = [];
function sendJson(res, status, body) { sent.push({ res, status, body }); }

test('createDecisionCore.respondFlowWriteResult：五结论落响应/登记簿；failed 抛 FLOW_WRITE_FAILED', () => {
  const home = mkdtempSync(join(tmpdir(), 'g02-resp-'));
  try {
    const core = createDecisionCore({ AUTOLOOP_HOME: home, httpError, sendJson });
    const base = { taskId: 'T1', step: 'doc', action: 'approve', status: 'done' };
    const after = { status: 'done', at: 'T', by: 'B', note: '' };

    core.respondFlowWriteResult({}, 'op-a', base, { kind: 'success', after });
    assert.equal(sent.at(-1).status, 200);
    assert.equal(sent.at(-1).body.verified, true);
    assert.equal(sent.at(-1).body.readBack, true);
    assert.equal(core.opLog.get('op-a').ok, true);

    core.respondFlowWriteResult({}, 'op-b', base, { kind: 'unknown' });
    assert.equal(sent.at(-1).body.verified, false);
    assert.equal(sent.at(-1).body.readBack, false, '读不回 ≠ 失败，交给前端回查');
    assert.equal(sent.at(-1).body.after, null);

    core.respondFlowWriteResult({}, 'op-c', base, { kind: 'unconfirmed', after, reason: '写入者是别人' });
    assert.equal(sent.at(-1).body.unconfirmed, true);
    assert.equal(sent.at(-1).body.unverifiedReason, '写入者是别人');
    assert.equal(sent.at(-1).body.verified, false);

    core.respondFlowWriteResult({}, 'op-d', base, { kind: 'mismatch', after, reason: '状态没落上' });
    assert.equal(sent.at(-1).body.unconfirmed, false);
    assert.equal(sent.at(-1).body.unverifiedReason, '状态没落上');

    assert.throws(
      () => core.respondFlowWriteResult({}, 'op-e', base, { kind: 'failed', msg: 'boom' }),
      /flow\.mjs 写回失败：boom/,
      '唯一确定失败才 500，且先登记 ok:false 供同 opId 重放',
    );
    assert.equal(core.opLog.get('op-e').ok, false);

    // 登记簿上限 200：挤掉最老的，不无界增长
    for (let i = 0; i < 205; i++) core.respondFlowWriteResult({}, `op-flood-${i}`, base, { kind: 'unknown' });
    assert.equal(core.opLog.size, 200);
    assert.equal(core.opLog.has('op-flood-0'), false, '最老的先被挤掉');
    assert.equal(core.opLog.has('op-flood-204'), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('createDecisionCore：saveTaskFileAtomic 原子落盘 + 事件通道（含写失败上报）', () => {
  const home = mkdtempSync(join(tmpdir(), 'g02-atomic-'));
  try {
    const core = createDecisionCore({ AUTOLOOP_HOME: home, httpError, sendJson });
    const taskFile = join(home, 'office-data', 'tasks', 'T1.json');
    core.saveTaskFileAtomic(taskFile, { id: 'T1', title: 't' });
    const onDisk = JSON.parse(readFileSync(taskFile, 'utf8'));
    assert.equal(onDisk.id, 'T1');
    assert.equal(typeof onDisk.updatedAt, 'string', '落盘前补写时间戳');
    assert.equal(readdirSync(dirname(taskFile)).length, 1, '临时文件 rename 顶替，不留尾巴');

    assert.equal(core.appendDecisionEvent({ op: 1 }), null);
    assert.match(readFileSync(join(home, 'office-data', 'decision-events.jsonl'), 'utf8'), /"op":1/);
    assert.equal(core.appendFileEvent({ chk: 1 }), null);
    assert.match(readFileSync(join(home, 'office-data', 'file-events.jsonl'), 'utf8'), /"chk":1/);

    // AUTOLOOP_HOME 指到文件 → 路径不可用：失败必须带回消息，不吞
    const f = join(home, 'blocker');
    writeFileSync(f, 'x');
    const broken = createDecisionCore({ AUTOLOOP_HOME: f, httpError, sendJson });
    assert.match(broken.appendDecisionEvent({}), /写入失败/);
    assert.match(broken.appendFileEvent({}), /写入失败/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('分支补测：无 steps 档案 / none 兜底 / 空登记跳过 / 空 opId / 空 stderr 等防御臂', async () => {
  const home = mkdtempSync(join(tmpdir(), 'g02-arms-'));
  try {
    // —— computeDecisions：档案完全没有 steps 字段 → 全 pending，不炸 ——
    const tri = computeDecisions([{ id: 'T', title: '空档案' }]);
    assert.equal(tri.items.length, 0);
    assert.equal(tri.rejected.length, 0);
    assert.deepEqual(tri.blocked.map((b) => b.stepKey), ['doc', 'final'], '门禁步全卡，waitingOn 如实列前序');
    assert.deepEqual(tri.blocked[0].waitingOn, ['01 原始需求']);

    // —— 非门禁步 awaiting 且前序全齐 → kind 'confirm'（与门禁 gate 区分）——
    const tri2 = computeDecisions([{
      id: 'T2', title: '任务书待确认',
      steps: { req: { status: 'done' }, doc: { status: 'done' }, plan: { status: 'done' }, brief: { status: 'awaiting' } },
    }]);
    assert.deepEqual(tri2.items.map((x) => [x.stepKey, x.kind]), [['brief', 'confirm']]);
    assert.deepEqual(tri2.blocked.map((b) => b.stepKey), ['final']);

    // —— 收尾步前序一个产物都没有 → none 兜底（不为 null、不抛）——
    assert.deepEqual(approvalFilesOfRec({ id: 'T', steps: {} }, 'final'), { src: 'none', files: [] });
    assert.deepEqual(approvalFilesOfRec({ id: 'T', steps: {} }, 'verify'), { src: 'none', files: [] });
    assert.equal(approvalObjectOfRec({ id: 'T' }, 'final'), 'none', '档案缺 steps 字段同样兜 none');

    // —— stepViewOf：读回对象缺 steps / 整体为 null 的两档回退 ——
    assert.deepEqual(stepViewOf({}, 'doc'), { status: null, at: null, note: '', by: null });
    assert.deepEqual(stepViewOf({ steps: {} }, 'doc'), { status: null, at: null, note: '', by: null });

    // —— 类型门禁：未知步骤查不到定义 → 不设类型要求；策略声明但零登记 → valid:false ——
    assert.deepEqual(
      { expects: artifactGateOf({}, 'nope').expects, valid: artifactGateOf({}, 'nope').valid },
      { expects: null, valid: true },
    );
    assert.equal(artifactGateOf(
      { artifactPolicy: { mode: 'test-any-file', basis: '占位' }, steps: { plan: { files: [] } } },
      'plan',
    ).valid, false, '策略豁免也要有登记产物才算有效审批对象');

    // —— 版本门禁：无 path / 空 path 跳过不核对；非字符串或空串 sha256 视作无指纹 ——
    const real = join(home, 'real.md');
    writeFileSync(real, 'x');
    const vg = artifactVersionGateOf({
      steps: { doc: { files: [
        { bytes: 5 },                           // 无 path：跳过
        { path: '', bytes: 5 },                 // 空 path：跳过
        { path: real, bytes: 1, sha256: 42 },   // sha 是数字：不当指纹，字节对上即过
        { path: real, bytes: 1, sha256: '' },   // 空串指纹：同样不算
      ] } },
    }, 'doc');
    assert.deepEqual(vg.drifted, []);
    assert.equal(vg.valid, true);
    assert.equal(vg.src, 'own');

    // —— 报错文案：无名文件 / 未声明类型的兜底措辞 ——
    assert.match(
      artifactMismatchMessage('plan', { expects: ['plan'], unmatched: [{}], matched: [] }),
      /\(未命名\)：未声明类型/,
    );
    assert.match(
      artifactVersionMessage('doc', { drifted: [{ path: 'D:/', why: 'bytes', exists: true, regBytes: 1, actBytes: 2 }] }),
      /\(未命名\)：实测 2 B ≠ 登记 1 B/,
    );

    // —— taskDemandView：无 steps 档案投影成全 pending 的完整步骤序 ——
    const view = taskDemandView({ id: 'T', title: '空档案' });
    assert.equal(view.steps.length, 7);
    assert.ok(view.steps.every((s) => s.status === 'pending' && Array.isArray(s.files) && s.files.length === 0));

    // —— recordOp：空 opId 不登记（没有幂等键就不登记，响应照常）——
    const core = createDecisionCore({ AUTOLOOP_HOME: home, httpError, sendJson });
    const sentBefore = sent.length;
    core.respondFlowWriteResult({}, '', { taskId: 'T', step: 'doc', action: 'approve', status: 'done' }, { kind: 'success', after: { status: 'done' } });
    assert.equal(core.opLog.has(''), false, 'opLog 模块级共享，只验空 opId 不入册');
    assert.equal(sent.length - sentBefore, 1, '空 opId 也照常走 200 响应');

    // —— flow 子进程报错且 stderr 为空：回退到 err.message，不许空文案 ——
    const noTask = join(home, 'office-data', 'tasks', 'T9.json');
    mkdirSync(dirname(noTask), { recursive: true });
    writeFileSync(noTask, JSON.stringify({ id: 'T9', steps: { doc: { status: 'pending' } } }));
    const fail = await execFlowWriteAndVerify({
      args: ['-e', 'process.exit(3)'],
      taskFile: noTask, stepKey: 'doc', status: 'done',
      writerMark: 'Leo（工作台）', opStartMs: Date.now(),
    });
    assert.equal(fail.kind, 'failed');
    assert.ok(typeof fail.msg === 'string' && fail.msg.length > 0, 'stderr 空时回退到 err.message');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
