// W01 第 17 轮：审批版本校验复验——锁内重读+重校验（TOCTOU 收口）隔离验证。
// 隔离环境：mkdtemp 临时 AGENT_AUTOLOOP_HOME + 随机端口 spawn 真实 web/server.js，
// 全部请求走 HTTP，磁盘档案/事件文件为地面真值。测完即删。
// 任务书 5 组：T1 正常审批 / T2 提交前改文件 / T3 改登记版本 / T4 快速重复提交 /
//             T5 服务端写入失败；附 T6 测试豁免仅限声明范围 + T7 非法输入零副作用。
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, 'web');
const PORT = 8300 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
function check(name, ok, detail = {}) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${Object.keys(detail).length ? '  ' + JSON.stringify(detail) : ''}`);
}
const shaOf = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

// ---- 1. 隔离夹具 ----
const home = mkdtempSync(join(tmpdir(), 'w01r17-'));
const tasksDir = join(home, 'office-data', 'tasks');
mkdirSync(tasksDir, { recursive: true });
mkdirSync(join(home, 'fx'), { recursive: true });
// server.js 启动硬性要求：AUTOLOOP_HOME/config.json 必须存在且 owner 非空（本测试不触中台，owner 用占位值）
writeFileSync(join(home, 'config.json'), JSON.stringify({ url: 'http://127.0.0.1:3350', owner: 'w01r17-selftest' }, null, 2), 'utf8');

const mkFx = (name, text) => {
  const p = join(home, 'fx', name);
  writeFileSync(p, text, 'utf8');
  return { path: p.replaceAll('\\', '/'), bytes: Buffer.byteLength(text, 'utf8'), sha256: shaOf(p), kind: 'plan' };
};

const stepDone = (at, note) => ({ status: 'done', at, note, by: 'selftest', files: [], runs: [] });
const stepPending = () => ({ status: 'pending', at: null, note: '', by: null, files: [], runs: [] });
const mkTask = (id, planFiles, policy) => {
  const rec = {
    id, title: `W01 r17 隔离夹具 ${id}（测完即删）`, createdAt: '2026-11-16T12:00:00.000Z', updatedAt: '2026-11-16T12:00:00.000Z',
    steps: {
      req: stepDone('2026-11-16T08:00:00.000Z', '夹具'),
      doc: stepDone('2026-11-16T09:00:00.000Z', '夹具'),
      plan: { status: 'awaiting', at: '2026-11-16T10:00:00.000Z', note: '夹具', by: 'selftest', files: planFiles, runs: [] },
      brief: stepPending(), deliverable: stepPending(), verify: stepPending(), final: stepPending(),
    },
  };
  if (policy) rec.artifactPolicy = policy;
  writeFileSync(join(tasksDir, `${id}.json`), JSON.stringify(rec, null, 2), 'utf8');
};

// 正式夹具 A-E（无 artifactPolicy，全量门禁生效）+ 豁免夹具 F（test-any-file + basis 入档）
const fx = {};
for (const id of ['A', 'B', 'C', 'D', 'E', 'F']) {
  fx[id] = mkFx(`plan-${id.toLowerCase()}.md`, `# 计划 ${id}\nW01 r17 隔离夹具产物。\n`);
  mkTask(`TEST-W01R17-${id}`, [fx[id]],
    id === 'F' ? { mode: 'test-any-file', basis: 'W01 r17 隔离验证夹具（一次性、测完即删）：F 用于验证版本豁免仅在显式声明 + 依据入档时生效。' } : undefined);
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
const writtenOf = (id) => events().filter((e) => e.demandId === id && e.result === 'written');

// 等就绪（GET /api/office/decisions 只读本地 tasks，不依赖中台）
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
  // ---- T1 正常审批：登记与物理一致 → 200 done + 恰 1 条 written 事件 ----
  const evBefore = events().length;
  const r1 = await post('/api/office/decision', { demandId: 'TEST-W01R17-A', stepKey: 'plan', action: 'approve' });
  check('T1a 正常审批 HTTP 200', r1.status === 200, { status: r1.status, code: r1.body?.code });
  check('T1b 响应 verified=true to=done', r1.body?.ok === true && r1.body?.verified === true && r1.body?.to === 'done',
    { ok: r1.body?.ok, verified: r1.body?.verified, to: r1.body?.to });
  check('T1c 磁盘档案 plan=done', readTask('TEST-W01R17-A').steps.plan.status === 'done');
  check('T1d written 事件恰 +1', events().length === evBefore + 1 && writtenOf('TEST-W01R17-A').length === 1,
    { evBefore, evAfter: events().length, written: writtenOf('TEST-W01R17-A').length });

  // ---- T2 提交前修改物理文件 → 409，档案停 awaiting，成功记录 0 ----
  writeFileSync(fx.B.path, readFileSync(fx.B.path, 'utf8') + '\n追加一段，字节数变了', 'utf8');   // 字节漂移
  const r2a = await post('/api/office/decision', { demandId: 'TEST-W01R17-B', stepKey: 'plan', action: 'approve' });
  const g2a = await post('/api/office/version-gate', { taskId: 'TEST-W01R17-B', stepKey: 'plan' });
  check('T2a 改字节后提交 HTTP 409 ARTIFACT_VERSION_DRIFT', r2a.status === 409 && r2a.body?.code === 'ARTIFACT_VERSION_DRIFT',
    { status: r2a.status, code: r2a.body?.code, msg: (r2a.body?.error || '').slice(0, 90) });
  check('T2b version-gate 判 why=bytes（实测≠登记）', g2a.body?.valid === false && g2a.body?.drifted?.some((d) => d.why === 'bytes'),
    { why: g2a.body?.drifted?.map((d) => d.why), regBytes: g2a.body?.drifted?.[0]?.regBytes, actBytes: g2a.body?.drifted?.[0]?.actBytes });
  writeFileSync(fx.B.path, Buffer.alloc(fx.B.bytes, 0x61));                                    // 字节级等长改内容 → 仅 sha 漂移
  const r2b = await post('/api/office/decision', { demandId: 'TEST-W01R17-B', stepKey: 'plan', action: 'approve' });
  const g2b = await post('/api/office/version-gate', { taskId: 'TEST-W01R17-B', stepKey: 'plan' });
  check('T2c 等字节改内容 HTTP 409（sha 指纹漂移）', r2b.status === 409 && r2b.body?.code === 'ARTIFACT_VERSION_DRIFT' && g2b.body?.drifted?.some((d) => d.why === 'sha'),
    { status: r2b.status, why: g2b.body?.drifted?.map((d) => d.why), regSha: (g2b.body?.drifted?.[0]?.regSha || '').slice(0, 8), actSha: (g2b.body?.drifted?.[0]?.actSha || '').slice(0, 8) });
  check('T2d 失败后档案停 awaiting', readTask('TEST-W01R17-B').steps.plan.status === 'awaiting');
  check('T2e B 成功记录数 = 0', writtenOf('TEST-W01R17-B').length === 0, { written: writtenOf('TEST-W01R17-B').length });

  // ---- T3 修改登记版本（直接改档案里的登记字节）→ 409，成功记录 0 ----
  const tC = readTask('TEST-W01R17-C');
  tC.steps.plan.files[0].bytes += 1000;                                                        // 模拟登记被手改/过期
  writeFileSync(join(tasksDir, 'TEST-W01R17-C.json'), JSON.stringify(tC, null, 2), 'utf8');
  const r3 = await post('/api/office/decision', { demandId: 'TEST-W01R17-C', stepKey: 'plan', action: 'approve' });
  const g3 = await post('/api/office/version-gate', { taskId: 'TEST-W01R17-C', stepKey: 'plan' });
  check('T3a 登记版本被改后提交 HTTP 409', r3.status === 409 && r3.body?.code === 'ARTIFACT_VERSION_DRIFT',
    { status: r3.status, code: r3.body?.code, why: g3.body?.drifted?.map((d) => d.why) });
  check('T3b 失败后档案停 awaiting', readTask('TEST-W01R17-C').steps.plan.status === 'awaiting');
  check('T3c C 成功记录数 = 0', writtenOf('TEST-W01R17-C').length === 0);

  // ---- T4 快速重复提交：并发两发 + 顺序补发 → 恰 1 条成功，无重复记录 ----
  const [c1, c2] = await Promise.all([
    post('/api/office/decision', { demandId: 'TEST-W01R17-D', stepKey: 'plan', action: 'approve' }),
    post('/api/office/decision', { demandId: 'TEST-W01R17-D', stepKey: 'plan', action: 'approve' }),
  ]);
  const statuses = [c1.status, c2.status].sort();
  check('T4a 并发两发 = 一个 200 + 一个 409', statuses[0] === 200 && statuses[1] === 409,
    { statuses, code409: (c1.body?.code || c2.body?.code) });
  check('T4b 磁盘恰一次 done', readTask('TEST-W01R17-D').steps.plan.status === 'done');
  check('T4c D written 事件恰 1 条', writtenOf('TEST-W01R17-D').length === 1, { written: writtenOf('TEST-W01R17-D').length });
  const r4d = await post('/api/office/decision', { demandId: 'TEST-W01R17-D', stepKey: 'plan', action: 'approve' });
  check('T4d 顺序重复提交 409 NOT_ACTIONABLE', r4d.status === 409 && r4d.body?.code === 'NOT_ACTIONABLE',
    { status: r4d.status, code: r4d.body?.code });
  check('T4e 补发后 D written 仍恰 1 条', writtenOf('TEST-W01R17-D').length === 1);

  // ---- T5 服务端写入失败（任务档案设只读 → rename 顶替失败）→ 500，档案未变，成功记录 0 ----
  const taskE = join(tasksDir, 'TEST-W01R17-E.json');
  const evBefore5 = events().length;
  chmodSync(taskE, 0o444);
  const r5 = await post('/api/office/decision', { demandId: 'TEST-W01R17-E', stepKey: 'plan', action: 'approve' });
  const afterE = readTask('TEST-W01R17-E');
  chmodSync(taskE, 0o666);
  check('T5a 写入失败 HTTP 500 ATOMIC_WRITE_FAILED', r5.status === 500 && r5.body?.code === 'ATOMIC_WRITE_FAILED',
    { status: r5.status, code: r5.body?.code, msg: (r5.body?.error || '').slice(0, 80) });
  check('T5b 档案未被替换（plan 仍 awaiting、JSON 完整）', afterE.steps.plan.status === 'awaiting' && Array.isArray(afterE.steps.plan.files) && afterE.steps.plan.files.length === 1);
  check('T5c E 成功记录数 = 0（事件零新增）', events().length === evBefore5 && writtenOf('TEST-W01R17-E').length === 0);
  const r5d = await post('/api/office/decision', { demandId: 'TEST-W01R17-E', stepKey: 'plan', action: 'approve' });
  check('T5d 解除只读后重提 200 done（失败未留半态）', r5d.status === 200 && readTask('TEST-W01R17-E').steps.plan.status === 'done',
    { status: r5d.status });
  // saveTaskFileAtomic 失败路径不清理 tmp（既有行为，非本轮引入，不动共享核心、报告标注）；
  // W01 口径要守的是：残留 tmp 不得变成幻影任务/决策记录。
  const leftovers = readdirSync(tasksDir).filter((f) => f.includes('.tmp-'));
  const dec5 = await fetch(BASE + '/api/office/decisions').then((r) => r.json());
  check('T5e 残留 tmp 不进任务/决策清单（无幻影记录）',
    !JSON.stringify(dec5).includes('.tmp-') && (dec5.errors || []).length === 0,
    { tmpLeftovers: leftovers.length, listedErrors: (dec5.errors || []).length });

  // ---- T6 测试豁免仅在显式声明范围生效：F 声明 test-any-file → 漂移照放行；B 未声明 → 漂移必拒 ----
  writeFileSync(fx.F.path, readFileSync(fx.F.path, 'utf8') + '\n豁免夹具漂移', 'utf8');
  const g6 = await post('/api/office/version-gate', { taskId: 'TEST-W01R17-F', stepKey: 'plan' });
  const r6 = await post('/api/office/decision', { demandId: 'TEST-W01R17-F', stepKey: 'plan', action: 'approve' });
  check('T6a F 豁免生效（versionExempt=true）且放行 200 done', g6.body?.versionExempt === true && r6.status === 200 && readTask('TEST-W01R17-F').steps.plan.status === 'done',
    { exempt: g6.body?.versionExempt, status: r6.status, driftedReported: (g6.body?.drifted || []).length });
  check('T6b 同款漂移在未声明档案（B）上仍是 409（豁免未扩大）', (await post('/api/office/decision', { demandId: 'TEST-W01R17-B', stepKey: 'plan', action: 'approve' })).status === 409);

  // ---- T7 非法输入（400/404）零副作用 ----
  const evBefore7 = events().length;
  const bad = [
    await post('/api/office/decision', { demandId: 'TEST-W01R17-A', stepKey: 'plan', action: '重启' }),
    await post('/api/office/decision', { demandId: 'TEST-W01R17-A', stepKey: 'nope', action: 'approve' }),
    await post('/api/office/decision', { demandId: 'NO-SUCH', stepKey: 'plan', action: 'approve' }),
    await post('/api/office/decision', { demandId: 'TEST-W01R17-B', stepKey: 'plan', action: 'reject' }),
  ].map((r) => r.status);
  check('T7a 非法 action/step/需求/缺理由 → [400,400,404,400]', JSON.stringify(bad) === '[400,400,404,400]', { bad });
  check('T7b 事件零新增', events().length === evBefore7);
} finally {
  child.kill();
  await new Promise((s) => setTimeout(s, 300));
  try { rmSync(home, { recursive: true, force: true }); } catch {}
}

const pass = results.filter((r) => r.ok).length;
console.log(`\n===== W01 r17 隔离验证：${pass}/${results.length} PASS =====`);
process.exit(pass === results.length ? 0 : 1);
