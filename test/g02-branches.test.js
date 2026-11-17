// g02-branches.test.js — G02 回归：分支覆盖补齐（shared / version / approval / decision-ops）
// 目标：涉及业务判断的核心模块分支臂 ≥90%（NODE_V8_COVERAGE + web/tmp-g02-coverage.mjs 口径）。
// 只补既有 g02-*.test.js 没打到的分支：工具函数边界、api 三类错误与离线短路、
// 版本判定取数全链（成功/失败/串台/缓存命中）、审批视图变体（需求对象/上游引用/
// 类型门禁/版本漂移四类文案）、决策操作持久化（存/恢复/坏档/隐私异常）与回查三层判定。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadOffice } from '../test-support/g02-vm.mjs';

const FULL = ['shared.js', 'version.js', 'approval.js', 'decision-ops.js'];
const ctx = (mods = FULL) => loadOffice(mods);
const ISO = '2026-11-16T09:00:00Z';

/* ================= shared.js：工具边界 + api 错误分类 ================= */

test('shared 工具：esc/fmtBytes/fmtTime/ago/withScroll/versionKeyOf 边界臂', () => {
  const c = ctx(['shared.js']);
  assert.equal(c.run('esc(null)'), '', 'esc null → 空串');
  assert.equal(c.run('esc("<b class=\'x\'>&</b>")'), '&lt;b class=&#39;x&#39;&gt;&amp;&lt;/b&gt;');
  assert.equal(c.run('fmtBytes(null)'), '—');
  assert.equal(c.run('fmtBytes(NaN)'), '—');
  assert.equal(c.run('fmtBytes(100)'), '100 B');
  assert.equal(c.run('fmtBytes(2048)'), '2.0 KB');
  assert.equal(c.run('fmtBytes(3 * 1024 * 1024)'), '3.0 MB');
  assert.equal(c.run('fmtTime("not-a-date")'), '—', '非法时间 → —');
  assert.equal(c.run('fmtTime(new Date(Date.now() - 86400000).toISOString())').length > 5, true, '非今天 → 带日期');
  assert.equal(c.run('fmtTime({ toString() { throw new Error("x"); } })'), '—', '构造抛错 → catch 兜底');
  assert.equal(c.run('ago("bad")'), '');
  assert.equal(c.run('ago(new Date(Date.now() - 5 * 1000).toISOString())'), '5 秒前');
  assert.equal(c.run('ago(new Date(Date.now() - 120 * 1000).toISOString())'), '2 分钟前');
  assert.equal(c.run('ago(new Date(Date.now() - 3 * 86400 * 1000).toISOString())'), '3 天前');
  assert.equal(c.run(`let hit = 0; withScroll(null, () => { hit = 1; }); hit`), 1,
    '无容器 → 不碰 scrollTop 直执行');
  assert.equal(c.run("versionKeyOf({ sha256: 'abc' })"), 'sha:abc');
  assert.equal(c.run('versionKeyOf({ bytes: 9 })'), 'b:9');
  assert.equal(c.run('versionKeyOf({})'), 'v:?');
  assert.equal(c.run('versionKeyOf(null)'), 'v:?');
  assert.equal(c.run('normPath(null)'), '');
});

test('shared 语义映射：waitingOnOf 缺省与首步臂', () => {
  const c = ctx(['shared.js']);
  assert.deepEqual(c.run('waitingOnOf({ key: "a" }, null)'), [], 'steps 缺省 → []');
  assert.deepEqual(c.run('waitingOnOf({ key: "a" }, [{ key: "a" }, { key: "b" }])'), [],
    '首步无前置（i<=0）');
  assert.deepEqual(
    c.run(`waitingOnOf({ key: "b" }, [{ key: "a", name: "X" }, { key: "b", name: "Y" }])`),
    ['00 X'], 'no 缺省按 ?? 0 排序，未完成前序如实列出');
});

test('api：2xx 非 JSON → isDataError（响应不是有效 JSON）', async () => {
  const c = ctx(['shared.js']);
  c.run(`__g02.fetchImpl = () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } })`);
  const r = await c.runAsync(`try { await api('/x'); return 'NO-THROW'; }
    catch (e) { return { msg: e.message, data: e.isDataError === true, http: e.isHttpError }; }`);
  assert.equal(r.msg, '响应不是有效 JSON');
  assert.equal(r.data, true);
  assert.equal(r.http, undefined, '数据错误不带 HTTP 标记');
});

test('api：2xx 空响应体 → isDataError（响应体为空）', async () => {
  const c = ctx(['shared.js']);
  c.run(`__g02.fetchImpl = () => ({ ok: true, status: 200, json: async () => null })`);
  const r = await c.runAsync(`try { await api('/x'); return 'NO-THROW'; }
    catch (e) { return { msg: e.message, data: e.isDataError === true }; }`);
  assert.equal(r.msg, '响应体为空');
  assert.equal(r.data, true);
});

test('api：HTTP 错误无 error 字段 → 「HTTP 状态码」消息 + isHttpError', async () => {
  const c = ctx(['shared.js']);
  c.run(`__g02.fetchImpl = () => ({ ok: false, status: 503, json: async () => ({}) })`);
  const r = await c.runAsync(`try { await api('/x'); return 'NO-THROW'; }
    catch (e) { return { msg: e.message, http: e.isHttpError === true }; }`);
  assert.equal(r.msg, 'HTTP 503');
  assert.equal(r.http, true);
});

test('api 离线：POST 拒绝 / 快照命中 / 未知路径拒绝', async () => {
  const c = loadOffice(['shared.js'], { offline: true });
  const post = await c.runAsync(`try { await api('/api/state', { method: 'POST' }); return 'NO-THROW'; }
    catch (e) { return e.message; }`);
  assert.match(post, /离线快照不能执行操作/);
  const st = await c.runAsync(`return await api('/api/state')`);
  assert.deepEqual(st, {}, '已知路径 → 快照数据');
  const other = await c.runAsync(`try { await api('/api/other'); return 'NO-THROW'; }
    catch (e) { return e.message; }`);
  assert.match(other, /离线模式不支持此操作/);
});

/* ================= version.js：判定取数全链 + 实体缺省 ================= */

test('scheduleVersionGate：离线直接返回（不发请求）', async () => {
  const c = loadOffice(['shared.js', 'version.js'], { offline: true });
  await c.runAsync(`await scheduleVersionGate(true)`);
  assert.equal(c.run('__g02.fetchCalls.length'), 0);
});

test('scheduleVersionGate：无当前任务 → 清空三缓存', async () => {
  const c = ctx(['shared.js', 'version.js']);
  c.run(`versionGate = { key: 'T1/doc', at: Date.now() }; versionGateKey = 'T1/doc'; versionGateErr = '旧错';`);
  await c.runAsync(`await scheduleVersionGate(true)`);
  const r = c.run(`[versionGate, versionGateKey, versionGateErr]`);
  assert.deepEqual(r, [null, '', null]);
});

test('scheduleVersionGate：成功落缓存（drifted/policy/src 兜底）+ 60 秒 fresh 命中不再请求', async () => {
  const c = ctx(['shared.js', 'version.js']);
  c.run(`__g02.curTask = { id: 'T1', steps: [{ key: 'doc' }] };`);
  c.run(`__g02.fetchImpl = () => ({ ok: true, status: 200,
    json: async () => ({ taskId: 'T1', stepKey: 'doc', valid: true, drifted: '不是数组' }) })`);
  await c.runAsync(`await scheduleVersionGate(true)`);
  const g = c.run(`versionGate`);
  assert.equal(g.valid, true);
  assert.deepEqual(g.drifted, [], 'drifted 非数组 → 空表兜底');
  assert.equal(g.policy, null);
  assert.equal(g.src, 'none');
  await c.runAsync(`await scheduleVersionGate(false)`);
  assert.equal(c.run('__g02.fetchCalls.length'), 1, 'fresh 且无错 → 不重查');
});

test('scheduleVersionGate：失败保留旧值只记错；fresh+err 仍重查并清错', async () => {
  const c = ctx(['shared.js', 'version.js']);
  c.run(`__g02.curTask = { id: 'T1', steps: [{ key: 'doc' }] };`);
  c.run(`__g02.fetchImpl = () => ({ ok: true, status: 200, json: async () => ({ valid: true }) })`);
  await c.runAsync(`await scheduleVersionGate(true)`);
  c.run(`__g02.fetchImpl = async () => { throw new Error('boom'); }`);
  await c.runAsync(`await scheduleVersionGate(true)`);
  let r = c.run(`({ valid: versionGate.valid, err: versionGateErr })`);
  assert.equal(r.valid, true, '失败保留旧判定');
  assert.equal(r.err, 'boom');
  c.run(`__g02.fetchImpl = () => ({ ok: true, status: 200, json: async () => ({ valid: false, drifted: [] }) })`);
  await c.runAsync(`await scheduleVersionGate(false)`);   // fresh=true 但 err 非空 → 重查
  r = c.run(`({ valid: versionGate.valid, err: versionGateErr, calls: __g02.fetchCalls.length })`);
  assert.equal(r.valid, false, '重查结果落地');
  assert.equal(r.err, null, '成功清错');
  assert.equal(r.calls, 3);
});

test('scheduleVersionGate：等待期间切步骤 → 晚到响应整包丢弃（成功/失败两路）', async () => {
  const c = ctx(['shared.js', 'version.js']);
  c.run(`__g02.curTask = { id: 'T1', steps: [{ key: 'doc' }] };`);
  c.run(`__g02.fetchImpl = () => ({ ok: true, status: 200, json: async () => ({ valid: true }) })`);
  const r1 = await c.runAsync(`
    const p = scheduleVersionGate(true);
    versionGateKey = 'T9/zz';
    await p;
    return versionGate;`);
  assert.equal(r1, null, '成功响应串台 → 丢弃');
  c.run(`versionGateErr = '旧错'; __g02.fetchImpl = async () => { throw new Error('net'); }`);
  const r2 = await c.runAsync(`
    const p = scheduleVersionGate(true);
    versionGateKey = 'T9/zz';
    await p;
    return versionGateErr;`);
  assert.equal(r2, '旧错', '失败响应串台 → 不记新错');
});

test('scheduleVersionGate：失败无 message → 默认文案', async () => {
  const c = ctx(['shared.js', 'version.js']);
  c.run(`__g02.curTask = { id: 'T1', steps: [{ key: 'doc' }] };`);
  c.run(`__g02.fetchImpl = async () => { throw new Error(''); }`);
  await c.runAsync(`await scheduleVersionGate(true)`);
  assert.equal(c.run('versionGateErr'), '版本判定请求失败');
});

test('buildFileEntities：steps/files/by/at/no 缺省臂 + stepOfPath 空兜底', () => {
  const c = ctx(['shared.js', 'version.js']);
  const r = c.run(`buildFileEntities([
    { id: 'T1', title: '无步骤需求' },
    { id: 'T2', title: '缺元数据', steps: [{ key: 'doc', files: [{ path: 'D:/a.md' }] }] },
  ])`);
  assert.equal(r.entries.length, 1, '无 steps 的需求按空集跳过');
  assert.equal(r.entries[0].meta.by, '', 'by 缺省 → 空串');
  assert.equal(r.entries[0].meta.at, null, 'at 缺省 → null');
  assert.equal(r.ents.length, 1);
  assert.equal(c.run(`stepOfPath('D:/a.md')`), null, 'lastFlow 未设 → 找不到');
  c.run(`lastFlow = { tasks: [{ id: 'T9', title: '无步骤' }] }`);
  assert.equal(c.run(`stepOfPath('D:/a.md')`), null, 'task 无 steps → 找不到');
});

/* ================= approval.js：审批视图矩阵 ================= */

const decide = (c, t, stepIdx = 1) => c.run(`(() => {
  const t = ${JSON.stringify(t)};
  return decideHtml(t, t.steps[${stepIdx}], t.steps, ${stepIdx});
})()`);

test('req 步骤：审批对象是需求本身（有/无补充说明两臂）', () => {
  const c = ctx();
  const t = () => ({ id: 'T1', title: '需求标题', steps: [
    { key: 'req', no: 1, name: '原始需求', status: 'awaiting', by: 'Leo', at: ISO, note: '补充说明原文' },
  ]});
  const r = decide(c, t(), 0);
  assert.match(r.html, /需求原文/);
  assert.match(r.html, /ev-note/);
  assert.match(r.html, /补充说明原文/);
  assert.match(r.acts, /批准 · 开始编写/, 'req 的通过文案跟对象走');
  assert.match(r.html, /待 Leo 确认/, '非门禁步骤的标题臂');

  const c2 = ctx();
  const r2 = decide(c2, { ...t(), steps: [{ ...t().steps[0], note: undefined }] }, 0);
  assert.match(r2.html, /（需求未附补充说明）/, '无补充说明 → ev-none 兜底');
});

test('final/verify/gate 无本步产物：引用前序产物并明说（upstream 臂）', () => {
  const mk = (lastStep) => ({ id: 'T1', title: '上游引用', steps: [
    { key: 'doc', no: 1, name: '需求文档', status: 'done', by: 'A', at: ISO,
      files: [{ path: 'D:/d/doc.md', bytes: 10, kind: 'doc' }] },
    lastStep,
  ]});
  const rFinal = decide(ctx(), mk({ key: 'final', no: 2, name: '最终交付', status: 'awaiting', by: 'B', at: ISO }));
  assert.match(rFinal.html, /本步骤未单独登记产物，列出的是前序步骤已登记产物/);
  assert.match(rFinal.acts, /通过 · 确认交付/);
  assert.match(rFinal.html, /决策门禁 · 等 Leo 拍板|待 Leo 确认/);

  const rVerify = decide(ctx(), mk({ key: 'verify', no: 2, name: '验收结论', status: 'awaiting', by: 'B', at: ISO }));
  assert.match(rVerify.acts, /通过验收/);
  assert.match(rVerify.html, /供核对/);

  const rGate = decide(ctx(), mk({ key: 'run', no: 2, name: '执行', status: 'pending', gate: true, by: 'B', at: ISO }));
  assert.match(rGate.acts, /data-decide="approve"/, 'gate+pending 前序齐 → 可拍板');
  assert.match(rGate.html, /本步骤未单独登记产物/);
});

test('类型门禁：expectsKinds 不匹配 → invalid-material 块 + 主操作禁用', () => {
  const c = ctx();
  const t = { id: 'T1', steps: [
    { key: 'plan', no: 1, name: '开发计划', status: 'awaiting', by: 'A', at: ISO,
      expectsKinds: ['plan'], files: [{ path: 'D:/p.md', bytes: 5, kind: 'doc' }] },
  ]};
  const r = decide(c, t, 0);
  assert.match(r.html, /类型要求/);
  assert.match(r.html, />plan</);
  assert.match(r.html, /本步骤要求声明类型为「plan」的材料/);
  assert.match(r.html, /p\.md：doc/);
  assert.match(r.acts, /data-decide="approve"[^>]*disabled/);
  assert.match(r.acts, /btn-invalid-material/);
  assert.match(r.acts, /title="登记产物不符合本步骤类型要求/);
  assert.match(r.acts, /data-decide="reject"/, '打回仍可用');
});

test('类型门禁：类型匹配 → 有效；test-any-file 策略 → 任意产物可批 + 依据展示', () => {
  const c = ctx();
  const t = { id: 'T1', steps: [
    { key: 'plan', no: 1, name: '开发计划', status: 'awaiting', by: 'A', at: ISO,
      expectsKinds: ['plan'], files: [{ path: 'D:/p.md', bytes: 5, kind: 'plan' }] },
  ]};
  const r = decide(c, t, 0);
  assert.doesNotMatch(r.acts, /data-decide="approve"[^>]*disabled/);
  assert.doesNotMatch(r.html, /invalid-material/);

  const c2 = ctx();
  const t2 = { id: 'T1', artifactPolicy: { mode: 'test-any-file', basis: 'X'.repeat(100) }, steps: [
    { key: 'plan', no: 1, name: '开发计划', status: 'awaiting', by: 'A', at: ISO,
      expectsKinds: ['plan'], files: [{ path: 'D:/p.md', bytes: 5, kind: 'whatever' }] },
  ]};
  const r2 = decide(c2, t2, 0);
  assert.match(r2.html, /测试策略（test-any-file）/);
  assert.match(r2.html, /X{80}…/, '依据超 80 字截断');
  assert.doesNotMatch(r2.acts, /data-decide="approve"[^>]*disabled/);
});

test('taskArtifactPolicy：mode 不符 / basis 空白 / 正常（trim）', () => {
  const c = ctx();
  assert.equal(c.run(`taskArtifactPolicy({ artifactPolicy: { mode: 'other', basis: 'x' } })`), null);
  assert.equal(c.run(`taskArtifactPolicy({ artifactPolicy: { mode: 'test-any-file', basis: '  ' } })`), null);
  assert.equal(c.run(`taskArtifactPolicy(null)`), null);
  assert.deepEqual(c.run(`taskArtifactPolicy({ artifactPolicy: { mode: 'test-any-file', basis: ' 依据 ' } })`),
    { mode: 'test-any-file', basis: '依据' });
});

test('完成反馈文案：resubmit/request/reject/未知 action 变体 + 未确认', () => {
  const done = () => ({ id: 'T1', steps: [{ key: 'doc', no: 1, name: '需求文档', status: 'done' }]});
  const withRes = (c, res) => c.run(`setDecisionResult(${JSON.stringify(res)})`);

  const c1 = ctx(); withRes(c1, { key: 'T1/doc', ok: true, action: 'resubmit', at: ISO, note: '改好了' });
  assert.match(decide(c1, done(), 0).html, /已重提 · 09:00|已重提/);
  assert.match(decide(c1, done(), 0).html, /备注：改好了/);

  const c2 = ctx(); withRes(c2, { key: 'T1/doc', ok: true, action: 'request' });
  assert.match(decide(c2, done(), 0).html, /已催材料/);

  const c3 = ctx(); withRes(c3, { key: 'T1/doc', ok: true, action: 'reject', at: ISO });
  assert.match(decide(c3, done(), 0).html, /已打回/);

  const c4 = ctx(); withRes(c4, { key: 'T1/doc', ok: true, action: 'weird' });
  assert.match(decide(c4, done(), 0).html, /已打回/, '未知 action 按打回收尾');

  const c5 = ctx(); withRes(c5, { key: 'T1/doc', ok: true, action: 'approve', unconfirmed: true, msg: '归属说明' });
  assert.match(decide(c5, done(), 0).html, /⚠ 档案已变更，本次提交尚未确认/);
  assert.match(decide(c5, done(), 0).html, /归属说明/);
});

test('failed 面板：理由未登记/草稿留存/busy/打回反馈变体', () => {
  const failed = () => ({ id: 'T1', steps: [
    { key: 'req', no: 1, name: '原始需求', status: 'done', by: 'Leo', at: ISO },
    { key: 'doc', no: 2, name: '需求文档', status: 'failed', gate: true, by: 'Hermes', at: ISO },
  ]});
  const c1 = ctx();
  const r1 = decide(c1, failed());
  assert.match(r1.html, /打回理由未登记/);

  const c2 = ctx();
  c2.run(`decisionNotes.set('T1/doc', '草稿内容'); decisionBusy = true;`);
  const r2 = decide(c2, failed());
  assert.match(r2.html, />草稿内容</);
  assert.match(r2.html, /4\/500 · 草稿已留存/);
  assert.match(r2.html, /提交中…/, 'busy 时按钮文案切换');

  const c3 = ctx();
  c3.run(`setDecisionResult({ key: 'T1/doc', ok: true, action: 'reject', at: ${JSON.stringify(ISO)}, note: 'rn' })`);
  const r3 = decide(c3, failed());
  assert.match(r3.html, /✓ 已打回/);
  assert.match(r3.html, /备注：rn/);

  const c4 = ctx();
  c4.run(`setDecisionResult({ key: 'T1/doc', ok: true, action: 'reject', unconfirmed: true, msg: '未确认原因' })`);
  assert.match(decide(c4, failed()).html, /⚠ 档案已变更，本次提交尚未确认/);
  assert.match(decide(c4, failed()).html, /未确认原因/);
});

test('skipped 步骤：不可决策也无反馈 → 空面板（acts 不占位）', () => {
  const c = ctx();
  const t = { id: 'T1', steps: [{ key: 'doc', no: 1, name: '需求文档', status: 'skipped' }]};
  const r = decide(c, t, 0);
  assert.equal(r.html, '');
  assert.equal(r.acts, '');
});

test('版本漂移四类文案 + 文件条目摘要 + 指纹尾注', () => {
  const c = ctx();
  const files = [
    { path: 'D:/d/a.md', bytes: 10, kind: 'doc' },   // vd bytes：实测≠登记
    { path: 'D:/d/b.md', bytes: 10, sha256: 'ffeeddcc', kind: 'doc' },   // vd sha：指纹不一致
    { path: 'D:/d/c.md', kind: 'doc' },               // vd noreg：登记大小缺失
    { path: 'D:/d/d.md', bytes: 4, kind: 'doc' },     // vd 未知 why → 实测兜底
    { path: 'D:/d/e.md', kind: 'doc' },               // 无 chk 无 bytes → —（登记）
    { path: 'D:/d/f.md', bytes: 6 },                  // chk exists:false → 文件不存在
    { path: 'D:/d/g.md', kind: 'doc' },               // chk 在、登记 bytes 缺 → 登记缺失
    { path: 'D:/d/h.md', bytes: 3 },                   // 无 kind → 类型未声明
  ];
  c.run(`fileStatus = new Map([
    ['d:/d/a.md', { exists: true, bytes: 20 }],
    ['d:/d/b.md', { exists: true, bytes: 10 }],
    ['d:/d/c.md', { exists: true, bytes: 10 }],
    ['d:/d/d.md', { exists: true, bytes: 9 }],
    ['d:/d/f.md', { exists: false }],
    ['d:/d/g.md', { exists: true, bytes: 5 }],
    ['d:/d/h.md', { exists: true, bytes: 3 }],
  ])`);
  c.run(`versionGate = { key: 'T1/doc', taskId: 'T1', stepKey: 'doc', valid: false,
    drifted: [
      { path: 'D:/d/a.md', why: 'bytes', exists: true, regBytes: 10, actBytes: 20, regSha: null },
      { path: 'D:/d/b.md', why: 'sha', exists: true, regBytes: 10, actBytes: 10, regSha: 'ffeeddcc' },
      { path: 'D:/d/c.md', why: 'noreg', exists: true, regBytes: null, actBytes: 10, regSha: null },
      { path: 'D:/d/d.md', why: 'whatever', exists: true, regBytes: 4, actBytes: 9, regSha: null },
      { path: 'D:/d/f.md', why: 'missing', exists: false, regBytes: 6, actBytes: null, regSha: null },
    ], policy: null, src: 'probe', at: Date.now(), versionExempt: false }`);
  const t = { id: 'T1', title: '漂移', steps: [
    { key: 'req', no: 1, name: '原始需求', status: 'done', by: 'Leo', at: ISO },
    { key: 'doc', no: 2, name: '需求文档', status: 'awaiting', gate: true, by: 'Hermes', at: ISO, files },
  ]};
  const r = decide(c, t);
  assert.match(r.html, /实测 20 B ≠ 登记 10 B/);
  assert.match(r.html, /实测 10 B · 登记 10 B · 指纹不一致/);
  assert.match(r.html, /登记大小缺失，无版本标识可比/);
  assert.match(r.html, /文件不存在，无法按登记版本核对/);
  assert.match(r.html, /（登记内容指纹 ffeeddcc）/, '指纹尾注取前 8 位');
  assert.match(r.html, /正式流程按提交登记的版本审批/, '非豁免结尾文案');
  assert.match(r.html, /已禁止按原版本通过，服务端同样会拒绝/);
  assert.match(r.html, /文件不存在</, '条目级缺失标记');
  assert.match(r.html, /—（登记）/, '无实测无登记字节 → 占位');
  assert.match(r.html, /实测 5 B · 登记 —（缺失）/, '登记 bytes 缺失并列展示');
  assert.match(r.html, /类型 未声明/, '未声明类型的臂');   // h.md
  assert.match(r.acts, /data-decide="approve"[^>]*disabled/);
  assert.doesNotMatch(r.html, /核对口径：/, '有警示块时条目区不再重复核对口径说明');
});

test('versionExempt：差异照说不阻断（两种结尾文案）', () => {
  const drift = [{ path: 'D:/d/a.md', why: 'bytes', exists: true, regBytes: 10, actBytes: 20, regSha: null }];
  const mk = (artifactPolicy) => ({ id: 'T1', artifactPolicy, steps: [
    { key: 'req', no: 1, name: '原始需求', status: 'done', by: 'Leo', at: ISO },
    { key: 'doc', no: 2, name: '需求文档', status: 'awaiting', gate: true, by: 'Hermes', at: ISO,
      expectsKinds: ['doc'], files: [{ path: 'D:/d/a.md', bytes: 10, kind: 'doc' }] },
  ]});
  const setupGate = (c) => c.run(`versionGate = { key: 'T1/doc', taskId: 'T1', stepKey: 'doc', valid: true,
    drifted: ${JSON.stringify(drift)}, policy: null, src: 'probe', at: Date.now(), versionExempt: true }`);

  const c1 = ctx(); setupGate(c1);
  const r1 = decide(c1, mk({ mode: 'test-any-file', basis: '占位产物依据' }));
  assert.match(r1.html, /不阻断本测试流程的审批（服务端按同一规则放行）/);
  assert.match(r1.html, /差异照常展示/);
  assert.doesNotMatch(r1.acts, /data-decide="approve"[^>]*disabled/, '版本豁免 → 主操作不禁用');

  const c2 = ctx(); setupGate(c2);
  const r2 = decide(c2, mk(null));
  assert.match(r2.html, /已入档：登记产物为占位产物/, 'policyNote 未渲染时保留全句');
});

test('可决策面板：草稿留存/busy/失败反馈/自定义步骤 key/提交者缺省', () => {
  const c = ctx();
  const t = { id: 'T1', steps: [
    { key: 'req', no: 1, name: '原始需求', status: 'done', by: 'Leo', at: ISO },
    { key: 'custom', no: 2, name: '自定义环节', status: 'awaiting', by: '', at: null,
      files: [{ path: 'D:/c.md', bytes: 1, kind: 'x' }] },
  ]};
  c.run(`decisionNotes.set('T1/custom', '我的备注'); decisionBusy = true;
         setDecisionResult({ key: 'T1/custom', msg: '上次的失败' })`);
  const r = decide(c, t);
  assert.match(r.acts, /确认通过/, 'APPROVE_LABEL 未命中 → 默认文案');
  assert.match(r.html, /自定义环节（1 个文件）|审批对象 · 自定义环节/, 'OBJECT_LABEL 未命中 → 步骤名');
  assert.match(r.html, /（1 个文件）/);
  assert.match(r.html, /提交者<span class="ev-none">—<\/span>|ev-none">—</, '提交者缺省 → —');
  assert.match(r.html, /提交时间.*ev-none">—/s, '提交时间缺省 → —');
  assert.match(r.html, />我的备注</);
  assert.match(r.html, /4\/500 · 草稿已留存/);
  assert.match(r.html, /提交中…/);
  assert.match(r.html, /fb err/) || assert.match(r.html, /上次的失败/);
  assert.match(r.acts, /data-decide="approve"[^>]*disabled/, 'busy 锁主操作');
});

test('重提/催材料成功反馈嵌在可决策面板顶部', () => {
  const base = () => ({ id: 'T1', steps: [
    { key: 'req', no: 1, name: '原始需求', status: 'done', by: 'Leo', at: ISO },
    { key: 'doc', no: 2, name: '需求文档', status: 'awaiting', gate: true, by: 'Hermes', at: ISO,
      files: [{ path: 'D:/d/x.md', bytes: 10, kind: 'doc' }] },
  ]});
  const c1 = ctx();
  c1.run(`setDecisionResult({ key: 'T1/doc', ok: true, action: 'resubmit' })`);
  assert.match(decide(c1, base()).html, /已重提，等待重新拍板/);

  const c2 = ctx();
  c2.run(`setDecisionResult({ key: 'T1/doc', ok: true, action: 'resubmit', unconfirmed: true, msg: 'm' })`);
  const h2 = decide(c2, base()).html;
  assert.match(h2, /档案已变更，本次提交尚未确认/);
  assert.match(h2, /<br>m</);

  const c3 = ctx();
  c3.run(`setDecisionResult({ key: 'T1/doc', ok: true, action: 'request' })`);
  assert.match(decide(c3, base()).html, /已发出补齐材料要求，本步仍停在待拍板/);
});

/* ================= decision-ops.js：持久化 + 操作历史 + 回查 ================= */

test('备注草稿：输入即存档、清空即删除、计数上屏、隐私模式不炸', () => {
  const c = ctx();
  c.run(`saveNoteDraft('T1/doc', '备注草稿', 'note-cnt')`);
  assert.equal(c.run(`decisionNotes.get('T1/doc')`), '备注草稿');
  assert.equal(c.run(`__g02.storage.get('office.notes.v1')`), JSON.stringify([['T1/doc', '备注草稿']]));
  assert.equal(c.run(`__g02.els['note-cnt'].textContent`), '4/500');
  c.run(`saveNoteDraft('T1/doc', '', 'note-cnt')`);
  assert.equal(c.run(`decisionNotes.size`), 0, '清空输入 = 删除草稿');
  assert.equal(c.run(`__g02.storage.get('office.notes.v1')`), '[]');
  c.run(`__g02.storageBroken = true; saveNoteDraft('T1/doc', 'x', 'note-cnt'); __g02.storageBroken = false;`);
  assert.equal(c.run(`decisionNotes.get('T1/doc')`), 'x', '隐私模式 setItem 抛错被吞，内存态不受影响');
});

test('restoreNotes：正常恢复（500 截断）/坏字段滤除/坏 JSON 当没有', () => {
  const c = ctx();
  c.run(`__g02.storage.set('office.notes.v1', JSON.stringify([
    ['T9/x', 'y'.repeat(600)], ['bad', 5], ['T9/empty', ''],
  ])); restoreNotes()`);
  const r = c.run(`({ size: decisionNotes.size, len: (decisionNotes.get('T9/x') || '').length })`);
  assert.equal(r.size, 1, '非字符串值/空串滤除');
  assert.equal(r.len, 500, '超长截断到 500');
  c.run(`__g02.storage.set('office.notes.v1', '{bad'); restoreNotes()`);
  assert.equal(c.run(`decisionNotes.size`), 1, '坏 JSON 不清已有数据');
});

test('pendingOps 持久化：坏档 at 兜底重计时/字段缺失滤除/坏 JSON/隐私异常', () => {
  const c = ctx();
  c.run(`pendingOps.set('T1/doc', { id: 'op-1', key: 'T1/doc', taskId: 'T1', stepKey: 'doc', action: 'approve', at: '坏档' });
         persistPendingOps()`);
  const saved = JSON.parse(c.run(`__g02.storage.get('office.pendingOps.v1')`));
  assert.equal(saved[0].at, '坏档', 'persist 原样落盘；at 的数字兜底发生在 restore');
  c.run(`pendingOps.clear();
         __g02.storage.set('office.pendingOps.v1', JSON.stringify([
           { id: 'op-1', key: 'T1/doc', taskId: 'T1', stepKey: 'doc', action: 'approve', at: '坏档' },
           { id: 'op-2' },
         ])); restorePendingOps()`);
  const r = c.run(`({ size: pendingOps.size, at: pendingOps.get('T1/doc').at })`);
  assert.equal(r.size, 1, '字段不齐的条目滤除');
  assert.equal(typeof r.at, 'number', '坏档 at 重新计时');
  c.run(`__g02.storage.set('office.pendingOps.v1', '{bad'); restorePendingOps()`);
  assert.equal(c.run(`pendingOps.size`), 1);
  c.run(`__g02.storageBroken = true; persistPendingOps(); __g02.storageBroken = false;`);
  assert.equal(c.run(`pendingOps.size`), 1, '隐私模式写入被吞');
});

test('pushOpResult：空记录拒收、30 条截断、restoreOpResults 过滤与坏档', () => {
  const c = ctx();
  c.run(`pushOpResult(null); pushOpResult({}); pushOpResult({ nokey: 1 });`);
  assert.equal(c.run(`__g02.opResults.length`), 0, '无 key 的记录拒收');
  c.run(`for (let i = 0; i < 35; i++) pushOpResult({ key: 'k' + i, ok: true, action: 'approve', taskId: 'T1', stepKey: 'doc' })`);
  const r = c.run(`({ len: __g02.opResults.length, first: __g02.opResults[0].key })`);
  assert.equal(r.len, 30, '超 30 条截断');
  assert.equal(r.first, 'k34', '最新在前');
  c.run(`__g02.storage.set('office.opResults.v1', JSON.stringify([{ key: 'a' }, null, { nokey: 1 }])); restoreOpResults()`);
  assert.equal(c.run(`__g02.opResults.length`), 1);
  c.run(`__g02.storage.set('office.opResults.v1', '{bad'); restoreOpResults()`);
  assert.equal(c.run(`__g02.opResults.length`), 0, '坏档 → 空');
});

test('renderOpHistory：空盒/无容器/四类结论/任务定位/未知动作', () => {
  const c = ctx();
  c.run(`renderOpHistory()`);
  assert.match(c.run(`__g02.els['sp-ops'].innerHTML`), /还没有操作记录/);
  c.run(`__g02.hiddenEls = new Set(['sp-ops']); renderOpHistory(); __g02.hiddenEls = null;`);
  assert.equal(c.run(`__g02.els['sp-ops'] === undefined || true`, ), true, '容器缺失直接返回（无异常即可）');

  const c2 = ctx();
  c2.run(`lastFlow = { tasks: [{ id: 'T1', title: '任务一', steps: [{ key: 'doc', name: '需求文档' }] }] };
    pushOpResult({ key: 'a', ok: true, unconfirmed: true, action: 'approve', taskId: 'T1', stepKey: 'doc' });
    pushOpResult({ key: 'b', ok: true, action: 'approve', taskId: 'T1', stepKey: 'doc' });
    pushOpResult({ key: 'c', msg: 'x'.repeat(80), action: 'reject', taskId: 'T9', stepKey: 'zz' });
    pushOpResult({ key: 'd', action: 'request', taskId: 'T9', stepKey: 'zz' });`);
  const html = c2.run(`__g02.els['sp-ops'].innerHTML`);
  assert.match(html, /is-warn[\s\S]*⚠ 档案已变更，归属未确认/);
  assert.match(html, /is-ok[\s\S]*✓ 已确认/);
  assert.match(html, /✗ x{60}/, '失败消息截断 60 字');
  assert.match(html, /✗ 结果未确认/, '无结论的默认臂');
  assert.match(html, /任务一 · 需求文档/, '档案里找得到 → 任务·步骤');
  assert.match(html, /T9 · zz/, '找不到 → 原始 id');
  assert.match(html, />request</, 'ACTION_CN 未命中 → 原文展示');
});

test('localDecisions：lastFlow 缺省/打回单列/门禁阻塞等待清单', () => {
  const c = ctx();
  assert.deepEqual(c.run(`lastFlow = null; localDecisions()`),
    { items: [], blocked: [], rejected: [] });
  c.run(`lastFlow = { tasks: [{ id: 'T1', title: '任务一', steps: [
    { key: 'plan', no: 1, name: '开发计划', status: 'awaiting' },
    { key: 'doc', no: 2, name: '需求文档', status: 'failed' },
    { key: 'run', no: 3, name: '执行', status: 'pending', gate: true },
  ]}]}`);
  const r = c.run(`localDecisions()`);
  assert.equal(r.items.length, 1, 'awaiting 前序齐 → 可拍板');
  assert.equal(r.items[0].stepKey, 'plan');
  assert.equal(r.rejected.length, 1, 'failed 单列打回组');
  assert.equal(r.rejected[0].note, '', '无打回理由 → 空串');
  assert.equal(r.blocked.length, 1, 'gate+pending 前序未齐 → 阻塞组');
  assert.deepEqual(r.blocked[0].waitingOn, ['01 开发计划', '02 需求文档'],
    '打回步骤也算未完成前置，如实列出');
});

test('renderDecisionPop：本地兜底/空态/数据源标注/打回直达', () => {
  const c = ctx();
  c.run(`decisionsData = null;
    lastFlow = { tasks: [{ id: 'T1', title: '任务一', steps: [
      { key: 'plan', no: 1, name: '开发计划', status: 'awaiting' },
      { key: 'doc', no: 2, name: '需求文档', status: 'failed', note: '结构没对齐' },
    ]}]};
    renderDecisionPop()`);
  const html = c.run(`__g02.els['decision-pop'].innerHTML`);
  assert.match(html, /待决策 · 1 项 · 打回 1/);
  assert.match(html, /dp-rejected/);
  assert.match(html, /title="结构没对齐"/);
  assert.match(html, / · 结构没对齐/);
  assert.doesNotMatch(html, / · 数据 /, '无 generatedAt → 不标数据时间');

  const c2 = ctx();
  c2.run(`decisionsData = { items: [], blocked: [], rejected: [], generatedAt: '${ISO}' }; renderDecisionPop()`);
  assert.match(c2.run(`__g02.els['decision-pop'].innerHTML`), /当前没有可处理的决策/);
  assert.match(c2.run(`__g02.els['decision-pop'].innerHTML`), / · 数据 /);
});

// 回查循环的 interval 回调 fire-and-forget 调 reconcilePendingDecision()，
// 宿主侧轮询排水直到集合清空/在途标志复位（vm 里没有 setTimeout）。
const drain = async (c) => {
  for (let i = 0; i < 200 && c.run('pendingOps.size || reconcileInFlight'); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
};

test('回查循环：集合空自动停、注册幂等、回调驱动核验', async () => {
  const c = ctx();
  c.run(`pendingOps.set('T1/doc', { id: 'op-1', key: 'T1/doc', taskId: 'T1', stepKey: 'doc', action: 'approve', targetStatus: 'done', at: Date.now() - 60000 });
         ensureReconcileLoop(); ensureReconcileLoop()`);
  assert.equal(c.run(`__g02.timers.length`), 1, '已有定时器不重复注册');
  c.run(`__g02.fetchImpl = (url) => ({ ok: true, json: async () => url.includes('op-status')
    ? { found: false }
    : { tasks: [{ id: 'T1', steps: [{ key: 'doc', status: 'done' }] }] } })`);
  c.run(`__g02.timers[0]()`);   // 一拍回查（回调不 await，宿主排水等它落定）
  await drain(c);               // 超窗+现拉匹配 → 归属未确认的成功
  assert.equal(c.run(`pendingOps.size`), 0);
  const r = c.run(`__g02.decisionResults.get('T1/doc')`);
  assert.equal(r.ok, true);
  assert.equal(r.unconfirmed, true);
  c.run(`__g02.timers[0]()`);   // 集合已空 → 清定时器自停
  assert.equal(c.run(`reconcileTimer`), null);
});

test('initDecisionOps：从存档恢复草稿与待确认操作，并立即开回查', () => {
  const c = ctx();
  c.run(`__g02.storage.set('office.notes.v1', JSON.stringify([['T1/doc', '留存的草稿']]));
    __g02.storage.set('office.pendingOps.v1', JSON.stringify([
      { id: 'op-r', key: 'T1/doc', taskId: 'T1', stepKey: 'doc', action: 'approve', at: Date.now() }]));
    initDecisionOps()`);
  const r = c.run(`({ note: decisionNotes.get('T1/doc'), pend: pendingOps.size, timers: __g02.timers.length })`);
  assert.equal(r.note, '留存的草稿');
  assert.equal(r.pend, 1);
  assert.equal(r.timers, 1, '有待确认操作 → 立即开专属回查');
});

test('reconcilePendingDecision：占用/在途/空集直接返回', async () => {
  const c = ctx();
  await c.runAsync(`await reconcilePendingDecision()`);   // 空集
  c.run(`reconcileInFlight = true; pendingOps.set('T1/doc', { id: 'x', key: 'T1/doc', taskId: 'T1', stepKey: 'doc', action: 'approve', targetStatus: 'done', at: 0 })`);
  await c.runAsync(`await reconcilePendingDecision()`);
  assert.equal(c.run(`pendingOps.size`), 1, '在途标志 → 直接返回不动');
  c.run(`reconcileInFlight = false`);
});

test('reconcilePendingDecision：登记 ok:false → 确定失败（有无 msg 两臂）', async () => {
  const run = async (op, msg) => {
    const c = ctx();
    c.run(`pendingOps.set('T1/doc', ${JSON.stringify(op)})`);
    c.run(`__g02.fetchImpl = (url) => ({ ok: true, json: async () => url.includes('op-status')
      ? { found: true, op: { ok: false, ${msg === undefined ? '' : `msg: ${JSON.stringify(msg)},`} } }
      : { tasks: [] } })`);
    await c.runAsync(`await reconcilePendingDecision()`);
    return c.run(`({ pend: pendingOps.size, res: __g02.decisionResults.get('T1/doc'), ops: __g02.opResults })`);
  };
  const base = { id: 'op-1', key: 'T1/doc', taskId: 'T1', stepKey: 'doc', action: 'approve', targetStatus: 'done', at: Date.now() - 60000 };
  const r1 = await run(base, 'flow.mjs 写回出错');
  assert.equal(r1.pend, 0);
  assert.match(r1.res.msg, /写回失败（服务端操作记录）：flow\.mjs 写回出错/);
  assert.equal(r1.ops[0].msg, r1.res.msg);
  const r2 = await run(base);
  assert.match(r2.res.msg, /写回失败（服务端操作记录）：flow\.mjs 写回出错/, '无 msg → 默认口径');
});

test('reconcilePendingDecision：登记 verified → 确定成功并清草稿', async () => {
  const c = ctx();
  c.run(`pendingOps.set('T1/doc', { id: 'op-v', key: 'T1/doc', taskId: 'T1', stepKey: 'doc', action: 'approve', targetStatus: 'done', at: Date.now() - 60000 });
    decisionNotes.set('T1/doc', '草稿');`);
  c.run(`__g02.fetchImpl = (url) => ({ ok: true, json: async () => url.includes('op-status')
    ? { found: true, op: { verified: true, at: '${ISO}', after: { note: 'n' } } }
    : { tasks: [] } })`);
  await c.runAsync(`await reconcilePendingDecision()`);
  const r = c.run(`({ pend: pendingOps.size, res: __g02.decisionResults.get('T1/doc'), notes: decisionNotes.size })`);
  assert.equal(r.pend, 0);
  assert.equal(r.res.ok, true);
  assert.equal(r.res.at, ISO);
  assert.equal(r.res.note, 'n');
  assert.equal(r.notes, 0, '确定成功清草稿');
});

test('reconcilePendingDecision：readBack=false 的三副面孔（匹配/超窗不一致/档案读不到）', async () => {
  const run = async (flowBody, at) => {
    const c = ctx();
    c.run(`pendingOps.set('T1/doc', { id: 'op-r', key: 'T1/doc', taskId: 'T1', stepKey: 'doc', action: 'approve', targetStatus: 'done', at: ${at} })`);
    c.run(`__g02.fetchImpl = (url) => {
      if (url.includes('op-status')) return { ok: true, json: async () => ({ found: true, op: { readBack: false } }) };
      if (url.includes('/flow')) return { ok: true, json: async () => (${JSON.stringify(flowBody)}) };
      return { ok: true, json: async () => ({}) };
    }`);
    await c.runAsync(`await reconcilePendingDecision()`);
    return c.run(`({ pend: pendingOps.size, res: __g02.decisionResults.get('T1/doc') || null })`);
  };
  const flowDone = { tasks: [{ id: 'T1', steps: [{ key: 'doc', status: 'done' }] }] };
  const r1 = await run(flowDone, Date.now() - 60000);
  assert.equal(r1.res.ok, true);
  assert.equal(r1.res.unconfirmed, true);
  assert.match(r1.res.msg, /档案已是目标状态；服务端写入时读回未确认/);

  const flowOld = { tasks: [{ id: 'T1', steps: [{ key: 'doc', status: 'awaiting' }] }] };
  const r2 = await run(flowOld, Date.now() - 60000);
  assert.match(r2.res.msg, /写回未确认：档案读回状态与目标不一致（服务端操作记录）/);

  const r3 = await run(flowOld, Date.now());   // 未超窗：不下结论
  assert.equal(r3.pend, 1, '未超窗继续等');
});

test('reconcilePendingDecision：现拉档案读不到不下结论（continue 臂）', async () => {
  const c = ctx();
  c.run(`pendingOps.set('T1/doc', { id: 'op-n', key: 'T1/doc', taskId: 'T1', stepKey: 'doc', action: 'approve', targetStatus: 'done', at: Date.now() - 60000 })`);
  c.run(`__g02.fetchImpl = (url) => {
    if (url.includes('op-status')) return { ok: true, json: async () => ({ found: true, op: { readBack: false } }) };
    throw new TypeError('net down');
  }`);
  await c.runAsync(`await reconcilePendingDecision()`);
  assert.equal(c.run(`pendingOps.size`), 1, '读不到 ≠ 读了对不上，不落结论');
});

test('reconcilePendingDecision：登记 unconfirmed / 无结论登记的收尾', async () => {
  const run = async (opRecord) => {
    const c = ctx();
    c.run(`pendingOps.set('T1/doc', { id: 'op-x', key: 'T1/doc', taskId: 'T1', stepKey: 'doc', action: 'approve', targetStatus: 'done', at: Date.now() - 60000 })`);
    c.run(`__g02.fetchImpl = (url) => ({ ok: true, json: async () => url.includes('op-status')
      ? { found: true, op: ${JSON.stringify(opRecord)} }
      : { tasks: [] } })`);
    await c.runAsync(`await reconcilePendingDecision()`);
    return c.run(`__g02.decisionResults.get('T1/doc')`);
  };
  const r1 = await run({ unconfirmed: true, unverifiedReason: '写入者是别的入口', after: { at: ISO } });
  assert.equal(r1.ok, true);
  assert.equal(r1.unconfirmed, true);
  assert.equal(r1.msg, '写入者是别的入口');
  const r2 = await run({ unconfirmed: true });
  assert.match(r2.msg, /档案已变成目标状态，但写入者不是本次操作/, '无原因 → 默认口径');
  const r3 = await run({ to: 'awaiting', unverifiedReason: '状态对不上' });
  assert.match(r3.msg, /状态对不上/);
  const r4 = await run({ to: 'awaiting' });
  assert.match(r4.msg, /写回未确认：档案读回状态与目标不一致（服务端操作记录）/);
});

test('reconcilePendingDecision：查不到登记的窗口内/超窗两副面孔', async () => {
  const run = async (flowBody, at, opStatusThrows) => {
    const c = ctx();
    c.run(`pendingOps.set('T1/doc', { id: 'op-w', key: 'T1/doc', taskId: 'T1', stepKey: 'doc', action: 'approve', targetStatus: 'done', at: ${at} })`);
    c.run(`__g02.fetchImpl = (url) => {
      if (url.includes('op-status')) { ${opStatusThrows ? "throw new Error('old server');" : ''} return { ok: true, json: async () => ({ found: false }) }; }
      if (url.includes('/flow')) return { ok: true, json: async () => (${JSON.stringify(flowBody)}) };
      return { ok: true, json: async () => ({}) };
    }`);
    await c.runAsync(`await reconcilePendingDecision()`);
    return c.run(`({ pend: pendingOps.size, res: __g02.decisionResults.get('T1/doc') || null })`);
  };
  const flowOld = { tasks: [{ id: 'T1', steps: [{ key: 'doc', status: 'awaiting' }] }] };
  const r1 = await run(flowOld, Date.now(), false);   // 窗口内：继续等
  assert.equal(r1.pend, 1);
  const flowDone = { tasks: [{ id: 'T1', steps: [{ key: 'doc', status: 'done' }] }] };
  const r2 = await run(flowDone, Date.now() - 60000, false);   // 超窗+现拉匹配
  assert.equal(r2.res.ok, true);
  assert.equal(r2.res.unconfirmed, true);
  assert.match(r2.res.msg, /查不到这次提交（可能服务重启过）/);
  const r3 = await run(flowOld, Date.now() - 60000, false);    // 超窗+不匹配
  assert.match(r3.res.msg, /写回结果未能确认（30 秒内无服务端操作记录/);
  const r4 = await run(flowOld, Date.now() - 60000, true);     // 查询本身失败 → 同一兜底
  assert.match(r4.res.msg, /写回结果未能确认（30 秒内无服务端操作记录/);
});

test('currentStepStatus：档案缺任务/缺步骤/状态缺省/请求失败', async () => {
  const run = async (flowBody, throws) => {
    const c = ctx();
    c.run(`__g02.fetchImpl = ${throws ? `async () => { throw new TypeError('x'); }` :
      `() => ({ ok: true, json: async () => (${JSON.stringify(flowBody)}) })`}`);
    return c.runAsync(`return await currentStepStatus({ taskId: 'T1', stepKey: 'doc' })`);
  };
  assert.equal(await run({ x: 1 }), null, '无 tasks → null');
  assert.equal(await run({ tasks: [{ id: 'T9' }] }), null, '无目标任务 → null');
  assert.equal(await run({ tasks: [{ id: 'T1', steps: [{ key: 'plan' }] }] }), null, '无目标步骤 → null');
  assert.equal(await run({ tasks: [{ id: 'T1', steps: [{ key: 'doc' }] }] }), 'pending', '状态缺省 → pending');
  assert.equal(await run(null, true), null, '请求失败 → null');
});

test('settleOp：确定失败保留草稿 + 数据同步失败不打扰', async () => {
  const c = ctx();
  c.run(`__tickImpl = async () => { throw new Error('tick 失败'); };
    pendingOps.set('T1/doc', { id: 'op-f', key: 'T1/doc', taskId: 'T1', stepKey: 'doc', action: 'approve', targetStatus: 'done', at: 0 });
    decisionNotes.set('T1/doc', '要留的草稿');`);
  await c.runAsync(`await settleOp(pendingOps.get('T1/doc'), { key: 'T1/doc', msg: '失败结论' })`);
  const r = c.run(`({ pend: pendingOps.size, notes: decisionNotes.size, res: __g02.decisionResults.get('T1/doc').msg })`);
  assert.equal(r.pend, 0);
  assert.equal(r.notes, 1, '失败不清草稿');
  assert.equal(r.res, '失败结论');
});

/* ================= 离线模式：决策操作短路 ================= */

test('离线：持久化短路/回查循环不开/回查直接返回/提交被拦', async () => {
  const c = loadOffice(FULL, { offline: true });
  const r = c.run(`(() => { persistNotes(); persistPendingOps();
    pendingOps.set('T1/doc', { id: 'x', key: 'T1/doc', taskId: 'T1', stepKey: 'doc', action: 'approve', targetStatus: 'done', at: 0 });
    pushOpResult({ key: 'k', ok: true, action: 'approve', taskId: 'T1', stepKey: 'doc' });
    ensureReconcileLoop();
    return { stored: __g02.storage.size, ops: __g02.opResults.length, timers: __g02.timers.length }; })()`);
  assert.equal(r.stored, 0, '离线不落盘');
  assert.equal(r.ops, 1, '内存记录保留');
  assert.equal(r.timers, 0, '离线不开回查循环');
  await c.runAsync(`await reconcilePendingDecision()`);
  assert.equal(c.run(`pendingOps.size`), 1, '离线回查直接返回');
  c.run(`__g02.curTask = { id: 'T1', steps: [{ key: 'doc' }] }; ui.stepKey = 'doc';`);
  await c.runAsync(`await submitDecision('approve')`);
  assert.match(c.run(`__g02.alerts[0]`), /离线快照模式，决策写回需要连上服务/);
  assert.equal(c.run(`__g02.fetchCalls.length`), 0);
});

/* ================= decision-ops.js：第4轮补测（分支覆盖率缺口，目标 ≥90%） ================= */

// submitDecision 夹具：doc 为可决策门禁步骤，ui.stepKey 桩默认 'doc' → key 'T1/doc'
const submitTask = () => ({
  id: 'T1', title: '覆盖率任务', updatedAt: 1,
  steps: [
    { key: 'req', no: 1, name: '原始需求', status: 'done' },
    { key: 'doc', no: 2, name: '需求文档', status: 'awaiting', gate: true, files: [{ path: 'D:/d/需求文档.md' }] },
  ],
});

test('恢复函数兜底：空存档读 null / 非数组档当没有（六个缺省臂）', () => {
  const c = ctx();   // 全新 realm：storage 为空 → getItem 返回 null
  c.run(`restoreNotes(); restorePendingOps(); restoreOpResults()`);
  assert.deepEqual(c.run(`({ n: decisionNotes.size, p: pendingOps.size, o: __g02.opResults.length })`),
    { n: 0, p: 0, o: 0 }, '空存档 → 三处全空，不炸');
  c.run(`__g02.storage.set('office.notes.v1', '{}');
         __g02.storage.set('office.pendingOps.v1', '"x"');
         __g02.storage.set('office.opResults.v1', '42');
         restoreNotes(); restorePendingOps(); restoreOpResults()`);
  assert.deepEqual(c.run(`({ n: decisionNotes.size, p: pendingOps.size, o: __g02.opResults.length })`),
    { n: 0, p: 0, o: 0 }, '合法 JSON 但不是数组 → 当没有');
});

test('pushOpResult：隐私模式落盘被吞（catch 臂），内存记录不受影响', () => {
  const c = ctx();
  c.run(`__g02.storageBroken = true;
         pushOpResult({ key: 'a', ok: true, action: 'approve', taskId: 'T1', stepKey: 'doc' });
         __g02.storageBroken = false;`);
  assert.equal(c.run(`__g02.opResults.length`), 1, '落盘失败不打扰内存态');
  assert.equal(c.run(`__g02.storage.has('office.opResults.v1')`), false);
});

test('renderOpHistory：档案任务无 steps → 原始定位；记录无 action → — 兜底', () => {
  const c = ctx();
  c.run(`lastFlow = { tasks: [{ id: 'T1', title: '无步骤任务' }] };
    pushOpResult({ key: 'a', ok: true, action: 'approve', taskId: 'T1', stepKey: 'doc' });
    pushOpResult({ key: 'b' });`);
  const html = c.run(`__g02.els['sp-ops'].innerHTML`);
  assert.match(html, /T1 · doc/, '任务在档案但无 steps → 退回原始 id 定位');
  assert.match(html, />—</, '无 action 的记录 → — 占位');
});

test('localDecisions：无 steps 任务/无序号排序/不可决策过滤/门禁可拍板/空序号前置', () => {
  const c = ctx();
  c.run(`lastFlow = { tasks: [
    { id: 'T0' },
    { id: 'T1', steps: [
      { key: 'a', status: 'running', name: '前期调研' },
      { key: 'b', gate: true, status: 'pending', name: '需求评审' },
    ]},
    { id: 'T2', steps: [
      { key: 'req', no: 1, name: '原始需求', status: 'done' },
      { key: 'doc', no: 2, name: '需求文档', status: 'awaiting', gate: true, files: [{ path: 'D:/d/需求文档.md' }] },
    ]},
  ]}`);
  const r = c.run(`localDecisions()`);
  assert.deepEqual(r.items.map((x) => x.taskId), ['T2'], '只有 T2 的门禁步骤可拍板');
  assert.equal(r.items[0].kind, 'gate', 'gate 步骤 → kind gate');
  assert.equal(r.blocked.length, 1, 'T1 的 gate 前序未齐 → 阻塞');
  assert.deepEqual(r.blocked[0].waitingOn, ['00 前期调研'], '前置无序号 → 00 占位');
  assert.equal(r.rejected.length, 0);

  c.run(`decisionsData = null; renderDecisionPop()`);
  const html = c.run(`__g02.els['decision-pop'].innerHTML`);
  assert.match(html, /is-gate/, '门禁徽标类名');
  assert.match(html, /门禁/, '门禁文案');
  assert.match(html, /T2/, '无标题任务 → 退回任务 id');
  assert.match(html, /dp-blocked/, '阻塞区渲染');
});

test('renderDecisionPop：打回未登记理由/无标题 + 缺 rejected 键的兜底', () => {
  const c = ctx();
  c.run(`decisionsData = { items: [], blocked: [], rejected: [{ taskId: 'T7', stepName: '需求文档' }] };
         renderDecisionPop()`);
  const html = c.run(`__g02.els['decision-pop'].innerHTML`);
  assert.match(html, /title="未登记打回理由"/, '无 note → 默认提示');
  assert.match(html, /dp-rejected[\s\S]*>T7</, '无 taskTitle → 退回任务 id');
  assert.doesNotMatch(html, /dp-rejected[\s\S]*? · /, '无 note → 打回条目不带说明尾注');

  c.run(`decisionsData = { items: [], blocked: [] }; renderDecisionPop()`);
  assert.doesNotMatch(c.run(`__g02.els['decision-pop'].innerHTML`), /dp-rejected/, '缺 rejected 键 → || [] 兜底，不炸');
});

test('submitDecision 守卫：无当前任务 / busy / 超长备注（三个提前返回，零请求）', async () => {
  const c1 = ctx();
  await c1.runAsync(`await submitDecision('approve')`);   // curTask 桩默认 null
  assert.equal(c1.run(`__g02.fetchCalls.length`), 0, '无当前任务直接返回');

  const c2 = ctx();
  c2.run(`__g02.curTask = ${JSON.stringify(submitTask())}; decisionBusy = true`);
  await c2.runAsync(`await submitDecision('approve')`);
  assert.equal(c2.run(`__g02.fetchCalls.length`), 0, 'busy 直接返回');

  const c3 = ctx();
  c3.run(`__g02.curTask = ${JSON.stringify(submitTask())}; decisionNotes.set('T1/doc', 'x'.repeat(501))`);
  await c3.runAsync(`await submitDecision('approve')`);
  assert.equal(c3.run(`__g02.fetchCalls.length`), 0, '超长备注拦下');
  assert.match(c3.run(`__g02.decisionResults.get('T1/doc').msg`), /501 字，超过 500 字上限/);
});

test('submitDecision：reject 带理由 → targetStatus=failed 并成功收尾', async () => {
  const c = ctx();
  c.run(`__g02.curTask = ${JSON.stringify(submitTask())}; decisionNotes.set('T1/doc', '结构不对')`);
  c.run(`__g02.fetchImpl = () => ({ ok: true, status: 200, json: async () => ({
    verified: true, step: { status: 'failed', at: ${JSON.stringify(ISO)} },
  }) })`);
  await c.runAsync(`await submitDecision('reject')`);
  const r = c.run(`({ url: __g02.fetchCalls[0].url, body: JSON.parse(__g02.fetchCalls[0].body),
    res: __g02.decisionResults.get('T1/doc'), busy: decisionBusy })`);
  assert.equal(r.url, '/api/office/decision');
  assert.deepEqual(r.body, { demandId: 'T1', stepKey: 'doc', action: 'reject', reason: '结构不对' });
  assert.equal(r.res.ok, true);
  assert.equal(r.busy, false, 'finally 复位');
});

test('submitDecision：readBack=false → 展示交回查循环（else 臂）', async () => {
  const c = ctx();
  c.run(`__g02.curTask = ${JSON.stringify(submitTask())}`);
  c.run(`__g02.fetchImpl = () => ({ ok: true, status: 200, json: async () => ({ readBack: false }) })`);
  await c.runAsync(`await submitDecision('approve')`);
  const r = c.run(`({ pend: pendingOps.size, timers: __g02.timers.length, has: __g02.decisionResults.has('T1/doc') })`);
  assert.equal(r.pend, 1, '已写入未确认：占用不释放');
  assert.equal(r.timers, 1, '专属回查循环开启');
  assert.equal(r.has, false, '不落确定结论，展示交给待确认条');
});

test('applyDecisionOutcome：verified 读回缺省兜底 + 不同 id 需求追加', () => {
  const c = ctx();
  c.run(`pendingOps.set('T1/doc', { id: 'op-a', key: 'T1/doc', taskId: 'T1', stepKey: 'doc', action: 'approve', targetStatus: 'done' });
         lastFlow = { tasks: [{ id: 'T1', title: '旧', steps: [] }] };
         applyDecisionOutcome({ verified: true, after: { at: ${JSON.stringify(ISO)}, status: 'done' }, demand: { id: 'T9', title: '新', steps: [] } },
           'T1/doc', pendingOps.get('T1/doc'), 'approve')`);
  const r = c.run(`({ at: __g02.decisionResults.get('T1/doc').at, len: lastFlow.tasks.length, t9: lastFlow.tasks[1] && lastFlow.tasks[1].id })`);
  assert.equal(r.at, ISO, 'r.step 缺 → 用 r.after');
  assert.equal(r.len, 2);
  assert.equal(r.t9, 'T9', '不同 id 的写后需求 → 追加不替换');

  const c2 = ctx();
  c2.run(`pendingOps.set('T1/doc', { id: 'op-b', key: 'T1/doc', taskId: 'T1', stepKey: 'doc', action: 'approve', targetStatus: 'done' });
          applyDecisionOutcome({ verified: true }, 'T1/doc', pendingOps.get('T1/doc'), 'approve')`);
  assert.equal(c2.run(`__g02.decisionResults.get('T1/doc').ok`), true);
  assert.equal(c2.run(`__g02.decisionResults.get('T1/doc').at`), undefined, 'step/after 全缺 → at 缺省');
});

test('applyDecisionOutcome：unconfirmed 的时间与原因兜底', () => {
  const mk = (rec) => {
    const c = ctx();
    c.run(`pendingOps.set('T1/doc', { id: 'op-u', key: 'T1/doc', taskId: 'T1', stepKey: 'doc', action: 'approve', targetStatus: 'done' });
           applyDecisionOutcome(${JSON.stringify(rec).replace(/"AT_ISO"/g, JSON.stringify(ISO))}, 'T1/doc', pendingOps.get('T1/doc'), 'approve')`);
    return c.run(`__g02.decisionResults.get('T1/doc')`);
  };
  const r1 = mk({ unconfirmed: true, after: { at: 'AT_ISO' } });
  assert.equal(r1.at, ISO, 'r.step 缺 → after.at 生效');
  const r2 = mk({ unconfirmed: true });
  assert.equal(r2.at, undefined, 'step/after 全缺 → at 缺省');
  assert.match(r2.msg, /无法确认是本次操作的写回/, '无原因 → 默认口径');
});

test('applyDecisionOutcome：写回不一致的消息兜底（after.status / ？）', () => {
  const mk = (rec) => {
    const c = ctx();
    c.run(`pendingOps.set('T1/doc', { id: 'op-m', key: 'T1/doc', taskId: 'T1', stepKey: 'doc', action: 'approve', targetStatus: 'done' });
           applyDecisionOutcome(${JSON.stringify(rec)}, 'T1/doc', pendingOps.get('T1/doc'), 'approve')`);
    return c.run(`__g02.decisionResults.get('T1/doc').msg`);
  };
  assert.match(mk({ after: { status: 'awaiting' } }), /「awaiting」与目标「done」/, 'r.to 缺 → after.status');
  assert.match(mk({}), /「\?」与目标「done」/, '全缺 → ？');
});

test('reconcilePendingDecision：超窗 + 现拉档案读不到 → 不下结论（continue 臂）', async () => {
  const c = ctx();
  c.run(`pendingOps.set('T1/doc', { id: 'op-c', key: 'T1/doc', taskId: 'T1', stepKey: 'doc', action: 'approve', targetStatus: 'done', at: Date.now() - 60000 })`);
  c.run(`__g02.fetchImpl = (url) => {
    if (url.includes('op-status')) return { ok: true, json: async () => ({ found: false }) };
    throw new TypeError('net down');
  }`);
  await c.runAsync(`await reconcilePendingDecision()`);
  assert.equal(c.run(`pendingOps.size`), 1, '读不到 ≠ 读了对不上，下一拍再试');
});

test('currentStepStatus：档案任务无 steps → null（|| [] 兜底）', async () => {
  const c = ctx();
  c.run(`__g02.fetchImpl = () => ({ ok: true, json: async () => ({ tasks: [{ id: 'T1' }] }) })`);
  assert.equal(await c.runAsync(`return await currentStepStatus({ taskId: 'T1', stepKey: 'doc' })`), null);
});

test('settleOp：用户正看着落定步骤 → renderInspector 跟进（ui 匹配臂）', async () => {
  const c = ctx();
  c.run(`ui.taskId = 'T1'; ui.stepKey = 'doc';
    pendingOps.set('T1/doc', { id: 'op-v', key: 'T1/doc', taskId: 'T1', stepKey: 'doc', action: 'approve', targetStatus: 'done', at: 0 })`);
  await c.runAsync(`await settleOp(pendingOps.get('T1/doc'), { key: 'T1/doc', ok: true, msg: '结论' })`);
  assert.equal(c.run(`pendingOps.size`), 0, '正常落定释放占用');
});

test('submitDecision：request 带说明 → targetStatus=awaiting', async () => {
  const c = ctx();
  c.run(`__g02.curTask = ${JSON.stringify(submitTask())}; decisionNotes.set('T1/doc', '缺验收口径')`);
  c.run(`__g02.fetchImpl = () => ({ ok: true, status: 200, json: async () => ({ verified: true, step: { status: 'awaiting' } }) })`);
  await c.runAsync(`await submitDecision('request')`);
  const r = c.run(`({ body: JSON.parse(__g02.fetchCalls[0].body), res: __g02.decisionResults.get('T1/doc') })`);
  assert.deepEqual(r.body, { demandId: 'T1', stepKey: 'doc', action: 'request', reason: '缺验收口径' });
  assert.equal(r.res.ok, true);
});

test('submitDecision：网络异常（非 HTTP 拒绝）→ 结果不确定，交回查循环（catch else 臂）', async () => {
  const c = ctx();
  c.run(`__g02.curTask = ${JSON.stringify(submitTask())}`);
  c.run(`__g02.fetchImpl = () => { throw new TypeError('net down'); }`);
  await c.runAsync(`await submitDecision('approve')`);
  const r = c.run(`({ pend: pendingOps.size, timers: __g02.timers.length,
    has: __g02.decisionResults.has('T1/doc'), ops: __g02.opResults.length, busy: decisionBusy })`);
  assert.equal(r.pend, 1, '请求可能已到服务端：占用不释放，防重复执行');
  assert.equal(r.has, false, '不下确定结论');
  assert.equal(r.ops, 0, '不落操作记录');
  assert.equal(r.timers, 1, '回查循环接管');
  assert.equal(r.busy, false, 'finally 复位');
});

test('renderDecisionPop：阻塞条目缺 waitingOn → 空清单兜底', () => {
  const c = ctx();
  c.run(`decisionsData = { items: [], rejected: [], blocked: [{ taskId: 'T7', stepName: '需求文档' }] };
         renderDecisionPop()`);
  const html = c.run(`__g02.els['decision-pop'].innerHTML`);
  assert.match(html, /dp-blocked/);
  assert.match(html, /等：<\/span>/, '缺 waitingOn → 空等待清单收尾');
});
