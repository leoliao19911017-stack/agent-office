// W01 第 76 轮：审批提交 6 场景——服务端重读物理文件 + 身份/SHA-256/登记版本校验。
// 口径（第 76 轮任务书）：S1 正常 / S2 同大小不同内容 / S3 不同大小 / S4 文件删除 /
//   S5 重复提交同一操作ID（幂等）/ S6 并发提交。冲突场景成功事件=0；
//   重复并发成功事件最多 1 条。隔离环境：mkdtemp + 随机端口 spawn 真实 web/server.js，
//   复制零依赖 flow.mjs 供 decide 端点（opId 幂等）全链路执行。测完即删。
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, 'web');
const REAL_HOME = 'C:/Tools/agent-autoloop';
const PORT = 8600 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
function check(name, ok, detail = {}) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${Object.keys(detail).length ? '  ' + JSON.stringify(detail) : ''}`);
}
const shaOf = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

// ---- 1. 隔离夹具 ----
const home = mkdtempSync(join(tmpdir(), 'w01r76-'));
const tasksDir = join(home, 'office-data', 'tasks');
mkdirSync(tasksDir, { recursive: true });
mkdirSync(join(home, 'fx'), { recursive: true });
writeFileSync(join(home, 'config.json'), JSON.stringify({ url: 'http://127.0.0.1:3350', owner: 'w01r76-selftest' }, null, 2), 'utf8');
copyFileSync(join(REAL_HOME, 'flow.mjs'), join(home, 'flow.mjs'));   // decide 端点走它，零依赖可复制

const mkFx = (name, text) => {
  const p = join(home, 'fx', name);
  writeFileSync(p, text, 'utf8');
  return { path: p.replaceAll('\\', '/'), bytes: Buffer.byteLength(text, 'utf8'), sha256: shaOf(p), kind: 'plan' };
};
const stepDone = (at) => ({ status: 'done', at, note: '夹具', by: 'selftest', files: [], runs: [] });
const stepPending = () => ({ status: 'pending', at: null, note: '', by: null, files: [], runs: [] });
const mkTask = (id, planFiles) => {
  const rec = {
    id, title: `W01 r76 隔离夹具 ${id}（测完即删）`, createdAt: '2026-11-17T12:00:00.000Z', updatedAt: '2026-11-17T12:00:00.000Z',
    steps: {
      req: stepDone('2026-11-17T08:00:00.000Z'),
      doc: stepDone('2026-11-17T09:00:00.000Z'),
      plan: { status: 'awaiting', at: '2026-11-17T10:00:00.000Z', note: '夹具', by: 'selftest', files: planFiles, runs: [] },
      brief: stepPending(), deliverable: stepPending(), verify: stepPending(), final: stepPending(),
    },
  };
  writeFileSync(join(tasksDir, `${id}.json`), JSON.stringify(rec, null, 2), 'utf8');
};

// S1 正常 / S2 等长换内容 / S3 变长 / S4 删除（decision 端点）+ S5 幂等 / S6 并发（decide 端点）
const fx = {};
for (const id of ['G', 'H', 'I', 'J', 'K', 'L']) {
  fx[id] = mkFx(`plan-${id.toLowerCase()}.md`, `# 计划 ${id}\nW01 r76 第 76 轮隔离夹具产物，六场景验证。\n`);
  mkTask(`TEST-W01R76-${id}`, [fx[id]]);
}

// ---- 2. 起隔离服务实例 ----
const child = spawn(process.execPath, ['server.js'], {
  cwd: WEB,
  env: { ...process.env, PORT: String(PORT), AGENT_AUTOLOOP_HOME: home },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderrTail = '';
child.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-2000); });

const post = async (path, body) => {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};
const readTask = (id) => JSON.parse(readFileSync(join(tasksDir, `${id}.json`), 'utf8'));
const events = () => {
  try { return readFileSync(join(home, 'office-data', 'decision-events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
};
const writtenOf = (id) => events().filter((e) => (e.demandId || e.taskId) === id && e.result === 'written');
const evLines = () => events().length;

let ready = false;
for (let i = 0; i < 100 && !ready; i++) {
  try { const r = await fetch(BASE + '/api/office/decisions'); if (r.status === 200) ready = true; } catch {}
  if (!ready) await new Promise((s) => setTimeout(s, 100));
}
if (!ready) {
  console.error('隔离服务 10s 未就绪，stderr 尾部：\n' + stderrTail);
  child.kill(); rmSync(home, { recursive: true, force: true });
  process.exit(1);
}
console.log(`隔离实例就绪 :${PORT}（home=${home}）`);

try {
  // ---- S1 正常提交：登记与物理一致 → 200 done + 恰 1 条成功事件 ----
  const r1 = await post('/api/office/decision', { demandId: 'TEST-W01R76-G', stepKey: 'plan', action: 'approve' });
  check('S1a 正常提交 HTTP 200 + verified + done', r1.status === 200 && r1.body?.verified === true && r1.body?.to === 'done',
    { status: r1.status, verified: r1.body?.verified, to: r1.body?.to });
  check('S1b 磁盘档案 plan=done', readTask('TEST-W01R76-G').steps.plan.status === 'done');
  check('S1c 成功事件恰 1 条', writtenOf('TEST-W01R76-G').length === 1, { written: writtenOf('TEST-W01R76-G').length });

  // ---- S2 同大小不同内容：字节相等、SHA-256 不等 → 409，成功事件 0 ----
  const buf = Buffer.alloc(fx.H.bytes, 0x61);
  writeFileSync(fx.H.path, buf);                                  // 等长换内容，仅 sha 漂移
  const r2 = await post('/api/office/decision', { demandId: 'TEST-W01R76-H', stepKey: 'plan', action: 'approve' });
  check('S2a 等长换内容 HTTP 409 ARTIFACT_VERSION_DRIFT', r2.status === 409 && r2.body?.code === 'ARTIFACT_VERSION_DRIFT',
    { status: r2.status, code: r2.body?.code, regSha: shaOf(fx.H.path).slice(0, 8) + '(原登记)', msg: (r2.body?.error || '').slice(0, 80) });
  check('S2b 档案停 awaiting（未创建成功审批）', readTask('TEST-W01R76-H').steps.plan.status === 'awaiting');
  check('S2c 成功事件 = 0', writtenOf('TEST-W01R76-H').length === 0, { written: writtenOf('TEST-W01R76-H').length });

  // ---- S3 不同大小：字节先变 → 409，成功事件 0 ----
  writeFileSync(fx.I.path, readFileSync(fx.I.path, 'utf8') + '\n追加内容使字节数变化，触发 bytes 漂移检测。');
  const r3 = await post('/api/office/decision', { demandId: 'TEST-W01R76-I', stepKey: 'plan', action: 'approve' });
  check('S3a 变更文件大小 HTTP 409 ARTIFACT_VERSION_DRIFT', r3.status === 409 && r3.body?.code === 'ARTIFACT_VERSION_DRIFT',
    { status: r3.status, code: r3.body?.code, msg: (r3.body?.error || '').slice(0, 80) });
  check('S3b 档案停 awaiting', readTask('TEST-W01R76-I').steps.plan.status === 'awaiting');
  check('S3c 成功事件 = 0', writtenOf('TEST-W01R76-I').length === 0, { written: writtenOf('TEST-W01R76-I').length });

  // ---- S4 提交前物理文件被删除 → 409，成功事件 0 ----
  unlinkSync(fx.J.path);
  const r4 = await post('/api/office/decision', { demandId: 'TEST-W01R76-J', stepKey: 'plan', action: 'approve' });
  check('S4a 文件删除后提交 HTTP 409', r4.status === 409, { status: r4.status, code: r4.body?.code, msg: (r4.body?.error || '').slice(0, 80) });
  check('S4b 档案停 awaiting', readTask('TEST-W01R76-J').steps.plan.status === 'awaiting');
  check('S4c 成功事件 = 0', writtenOf('TEST-W01R76-J').length === 0, { written: writtenOf('TEST-W01R76-J').length });

  // ---- S5 重复提交同一操作ID（decide 端点，flow.mjs 全链路）→ 幂等重放，效果只落一次 ----
  // 事件口径说明：decide 通道的留痕 = opLog（内存，/api/office/op-status 可回查）+ 档案
  // 状态/updatedAt；decision-events.jsonl 由 decision 端点写。幂等证据 = 重放后档案
  // updatedAt 不变（flow 未被再次调用）+ op-status 回查命中 + 事件文件零新增。
  const OP = 'op-w01r76-K-0001';
  const evBefore5 = evLines();
  const k1 = await post('/api/office/decide', { taskId: 'TEST-W01R76-K', step: 'plan', action: 'approve', opId: OP });
  const updAfterK1 = readTask('TEST-W01R76-K').updatedAt;
  const k2 = await post('/api/office/decide', { taskId: 'TEST-W01R76-K', step: 'plan', action: 'approve', opId: OP });
  const updAfterK2 = readTask('TEST-W01R76-K').updatedAt;
  check('S5a 首次提交 200 verified', k1.status === 200 && k1.body?.verified === true && k1.body?.status === 'done',
    { status: k1.status, verified: k1.body?.verified, status2: k1.body?.status });
  check('S5b 同 opId 重放 200 + replay:true（不二次执行）', k2.status === 200 && k2.body?.replay === true,
    { status: k2.status, replay: k2.body?.replay });
  check('S5c 档案 plan=done（恰一次效果）', readTask('TEST-W01R76-K').steps.plan.status === 'done');
  check('S5d 重放未再次写档案（updatedAt 不变）', updAfterK1 === updAfterK2, { updAfterK1, updAfterK2 });
  const k3 = await post('/api/office/decide', { taskId: 'TEST-W01R76-K', step: 'plan', action: 'approve', opId: 'op-w01r76-K-0002' });
  check('S5e 换新 opId 重复提交 → 409 NOT_ACTIONABLE（已处理过）', k3.status === 409 && k3.body?.code === 'NOT_ACTIONABLE',
    { status: k3.status, code: k3.body?.code });
  const os5 = await fetch(`${BASE}/api/office/op-status?opId=${encodeURIComponent(OP)}`).then((r) => r.json());
  check('S5f op-status 回查命中且事件文件零新增（成功效果恰一次）',
    os5.found === true && os5.op?.ok === true && evLines() === evBefore5,
    { found: os5.found, ok: os5.op?.ok, events: evLines() - evBefore5 });

  // ---- S6 并发提交（同一操作 ID 并发两发）→ 成功效果最多 1 ----
  // 设计语义：第一发持锁执行 flow（await 让出事件循环），第二发同 opId 进门时 opLog
  // 未命中 → 撞锁 409 WRITE_IN_FLIGHT；客户端稍后用同一 opId 重试 → 命中幂等重放 200。
  // 成功效果最多 1 条 = 档案只落一次 done + 重试不产生第二次写。
  const [m1, m2] = await Promise.all([
    post('/api/office/decide', { taskId: 'TEST-W01R76-L', step: 'plan', action: 'approve', opId: 'op-w01r76-L-conc' }),
    post('/api/office/decide', { taskId: 'TEST-W01R76-L', step: 'plan', action: 'approve', opId: 'op-w01r76-L-conc' }),
  ]);
  const statuses6 = [m1.status, m2.status].sort();
  const winners = [m1, m2].filter((m) => m.status === 200);
  const losers = [m1, m2].filter((m) => m.status !== 200);
  check('S6a 同 opId 并发两发 → 恰一个 200，另一发 409（WRITE_IN_FLIGHT/NOT_ACTIONABLE）',
    winners.length === 1 && losers.length === 1 && losers[0].status === 409,
    { statuses: statuses6, code409: losers[0]?.body?.code });
  const updL = readTask('TEST-W01R76-L').updatedAt;
  const m3 = await post('/api/office/decide', { taskId: 'TEST-W01R76-L', step: 'plan', action: 'approve', opId: 'op-w01r76-L-conc' });
  check('S6b 撞锁发重试同 opId → 200 replay（闭环）', m3.status === 200 && m3.body?.replay === true,
    { status: m3.status, replay: m3.body?.replay });
  check('S6c 档案 plan=done 且并发只落一次（重试未再写）',
    readTask('TEST-W01R76-L').steps.plan.status === 'done' && readTask('TEST-W01R76-L').updatedAt === updL,
    { updatedAtSame: readTask('TEST-W01R76-L').updatedAt === updL });

  // 刷新一致性（HTTP 口径）：决策清单与磁盘档案一致——已处理的不再出现在可处理列表
  const dec = await fetch(BASE + '/api/office/decisions').then((r) => r.json());
  const actionable = (dec.items || []).map((it) => it.taskId || it.demandId);
  const stillListed = (id) => actionable.includes(id) || (dec.blocked || []).some((b) => (b.taskId || b.demandId) === id);
  const ok6c = !actionable.includes('TEST-W01R76-G') && !actionable.includes('TEST-W01R76-K') && !actionable.includes('TEST-W01R76-L')
    && ['TEST-W01R76-H', 'TEST-W01R76-I', 'TEST-W01R76-J'].every(stillListed);
  check('S6d 刷新后可处理清单与持久化一致（G/K/L 不再可处理，H/I/J 仍拦）', ok6c,
    { actionable: actionable.length });
} finally {
  child.kill();
  await new Promise((s) => setTimeout(s, 300));
  try { rmSync(home, { recursive: true, force: true }); } catch {}
}

const pass = results.filter((r) => r.ok).length;
console.log(`\n===== W01 r76 六场景验证：${pass}/${results.length} PASS =====`);
process.exit(pass === results.length ? 0 : 1);
