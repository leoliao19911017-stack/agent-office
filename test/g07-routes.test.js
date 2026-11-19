// G07-D｜25 个 API 路由清单回归（3 用例）——防止「重构删路由」再次无声发生。
//
// G07 任务书口径「确认 17 个既有 API 路由没有丢失」：
//   17 = 固定路径路由（11 GET + 6 POST /api/office/*、/api/state、/api/health）；
//   另有 3 条参数化中台代理（/api/cards/:id/answer|resolve、/api/runs/:id/cancel），共 20 条一并守护。
// TASK-向导化改造（X06/X07）新增 3 条固定路由（GET+POST /api/office/review、
//   POST /api/office/new-task），冻结清单同步扩到 20 固定 + 3 参数化——只增不减。
// TASK-R87整改（X03）再增 1 条：GET /api/office/discuss（需求讨论留档，首页
//   「AI 讨论了什么」块的真实数据源），冻结清单扩到 21 固定 + 3 参数化。
// TASK-Agent真实状态（X01）再增 1 条：GET /api/agents/real（Claude/Codex 本机
//   实测三维：进程/最近会话活动/额度，只读探测，出错出 null 不出 500），
//   冻结清单扩到 22 固定 + 3 参数化。
//
// R1 源码静态扫描：路由注册字面量逐一对照冻结清单——删掉任何一条，本用例立刻失败；
// R2 GET 数据路由业务形状：响应体里必须有真实业务字段（HTTP 200 不作为通过条件）；
// R3 POST 协议错误/白名单/下载/代理链：具体 400 业务码（不是笼统 404）、
//    白名单 403、下载响应头、stub 中台 404 原样透传（证明代理链真的到中台）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startStack } from './g07-harness.mjs';

let stack;
// 白名单内的真实文件（仓库自身 app-base.css，G02 第 5 轮起 app.css 已拆四文件）：Windows 下必须 fileURLToPath，pathname 会带 %20
const REAL_FILE = fileURLToPath(new URL('../web/app-base.css', import.meta.url)).replace(/\\/g, '/');

before(async () => { stack = await startStack(); });
after(async () => { await stack?.stop(); });

/* ---------------- 冻结清单：17 固定 + 3 参数化 ---------------- */
const EXPECTED_FIXED = new Map([
  ['GET /api/health', '服务自检'],
  ['GET /api/state', '中台状态代理'],
  ['GET /api/office/hermes', 'Hermes 三入口状态'],
  ['GET /api/office/files', '产物汇总索引'],
  ['GET /api/office/skills', '技能中心索引'],
  ['GET /api/office/flow', '需求流水线视图'],
  ['GET /api/office/file', '产物内容读取'],
  ['GET /api/office/file-version', '历史版本读取'],
  ['GET /api/office/decisions', '待决策清单'],
  ['GET /api/office/op-status', '操作结果回查'],
  ['GET /api/office/file-download', '产物下载'],
  ['POST /api/office/file-check', '产物存在性核实'],
  ['POST /api/office/version-gate', '审批版本门禁判定'],
  ['POST /api/office/file-revalidate', '产物登记重校验'],
  ['POST /api/office/decide', '决策处理'],
  ['POST /api/office/resubmit', '重新提交'],
  ['POST /api/office/decision', '需求决策'],
  // TASK-向导化改造（X06 评审轮次账本 / X07 首页开新软件）
  ['GET /api/office/review', '评审轮次查询'],
  ['POST /api/office/review', '评审轮次记入'],
  ['POST /api/office/new-task', '首页开新软件制作'],
  ['GET /api/office/discuss', '需求讨论留档查询'],
  // TASK-Agent真实状态（X01）：Claude/Codex 本机实测三维（进程/活动/额度）
  ['GET /api/agents/real', 'Agent 本机实测三维'],
]);
const EXPECTED_PARAM = new Map([
  ['POST /api/cards/:id/answer', '提问卡作答'],
  ['POST /api/cards/:id/resolve', '提问卡解决'],
  ['POST /api/runs/:id/cancel', '运行取消'],
]);

const get = async (p) => {
  const r = await fetch(stack.base + p);
  let body = null;
  try { body = await r.json(); } catch { /* 非 JSON 也如实保留 null */ }
  return { status: r.status, body };
};
const post = (p, body) => fetch(stack.base + p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
}).then(async (r) => {
  let b = null;
  try { b = await r.json(); } catch { /* 保留 null */ }
  return { status: r.status, body: b };
});

test('R1 源码路由清单：22 条固定 + 3 条参数化全部在（少一条即失败）', () => {
  // G02（R73）：/api/* 路由体已从 server.js 搬至 server-api.mjs（createApiRouter
  // 工厂），扫描口径跟随拆分：两文件源码并集，路由丢一条立刻失败，与拆分前等效。
  const src = readFileSync(new URL('../web/server.js', import.meta.url), 'utf8')
    + readFileSync(new URL('../web/server-api.mjs', import.meta.url), 'utf8');

  // 固定路径：`path === '/api/...' && method === 'GET|POST'`
  const found = new Set();
  for (const m of src.matchAll(/path === '(\/api\/[A-Za-z0-9/-]+)' && method === '(GET|POST)'/g)) {
    found.add(`${m[2]} ${m[1]}`);
  }
  const missing = [...EXPECTED_FIXED.keys()].filter((k) => !found.has(k));
  assert.deepEqual(missing, [], `server.js 丢了固定路由：${missing.join('、')}（扫描到 ${found.size} 条固定路由）`);
  assert.equal(found.size, 22, `固定路由应恰好 22 条（G07 17 + 向导化 3 + R87 1 + X01 1），实际扫描到 ${found.size}：${[...found].join('、')}`);

  // 参数化：`m = path.match(/…/)`，用样本路径逐条试配（对正则写法不敏感）
  const paramLiterals = [...src.matchAll(/m = path\.match\((\/\^[^\n]*?)\)\)/g)].map((m) => m[1]);
  const paramFound = [];
  for (const [key] of EXPECTED_PARAM) {
    const sample = key.replace(':id', '123').split(' ')[1];
    const hit = paramLiterals.some((lit) => {
      try { return new RegExp(lit.slice(1, -1)).test(sample); } catch { return false; }
    });
    if (hit) paramFound.push(key);
  }
  const missParam = [...EXPECTED_PARAM.keys()].filter((k) => !paramFound.includes(k));
  assert.deepEqual(missParam, [], `server.js 丢了参数化代理路由：${missParam.join('、')}`);
  console.log(`[R1] 固定 22/22 + 参数化 3/3 全在（参数化正则 ${paramLiterals.length} 条参与试配）`);
});

test('R2 GET 数据路由业务形状：响应体必须有真实业务字段（200 空壳不算过）', async () => {
  // 1) /api/health：ok+autoloop（stub /healthz 可达）+ build 版本串
  const health = await get('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true, `health.ok 应 true，实际 ${JSON.stringify(health.body)}`);
  assert.equal(health.body.autoloop, true, `health.autoloop 应 true（stub 中台 /healthz 可达），实际 ${JSON.stringify(health.body)}`);
  assert.ok(typeof health.body.build === 'string' && health.body.build.length > 0, 'health.build 应为版本串');

  // 2) /api/state：stub 中台真实数据透传（codex + 运行单 9001）
  const state = await get('/api/state');
  assert.equal(state.status, 200);
  assert.equal(state.body.agents[0]?.id, 'codex', `state.agents[0].id 应 codex，实际 ${JSON.stringify(state.body.agents)}`);
  assert.equal(state.body.runs[0]?.id, '9001', 'state.runs[0].id 应 9001');

  // 3) /api/office/hermes：夹具存根三入口（lemate/winter/karina）
  const hermes = await get('/api/office/hermes');
  assert.equal(hermes.status, 200);
  const ids = (hermes.body.agents || []).map((a) => a.id).sort();
  assert.deepEqual(ids, ['karina', 'lemate', 'winter'], `hermes 三入口应齐，实际 ${JSON.stringify(ids)}`);

  // 4) /api/office/files：readError=null（夹具 index.json 可读）
  const files = await get('/api/office/files');
  assert.equal(files.status, 200);
  assert.equal(files.body.readError, null, `files.readError 应 null，实际 ${JSON.stringify(files.body.readError)}`);

  // 5) /api/office/skills：12 条 + 分类 overlay 真合并（overlay 内=开发，overlay 外=null）
  const skills = await get('/api/office/skills');
  assert.equal(skills.status, 200);
  assert.equal(skills.body.skills.length, 12, `技能应 12 条，实际 ${skills.body.skills.length}`);
  const byName = Object.fromEntries(skills.body.skills.map((s) => [s.name, s.category]));
  assert.equal(byName['gstack-command'], '开发', `overlay 分类应合并，实际 ${JSON.stringify(byName['gstack-command'])}`);
  assert.equal(byName['g07-fixture-builder'], null, 'overlay 外技能 category 应 null（前端归未分类）');

  // 6) /api/office/flow：3 任务 × 7 步、T-G07A 完成 5/7、按 updatedAt 倒序
  const flow = await get('/api/office/flow');
  assert.equal(flow.status, 200);
  assert.equal(flow.body.tasks.length, 3, `flow 应 3 任务，实际 ${flow.body.tasks.length}`);
  for (const t of flow.body.tasks) {
    assert.equal(t.steps.length, 7, `${t.id} 应 7 步（STEP_DEFS），实际 ${t.steps.length}`);
  }
  const a = flow.body.tasks.find((t) => t.id === 'T-G07A');
  assert.ok(a, 'flow 应含 T-G07A');
  assert.equal(a.done, 5, `T-G07A 应完成 5/7 步，实际 ${a.done}`);
  assert.equal(flow.body.tasks[0].id, 'T-G07A', 'flow 应按 updatedAt 倒序（T-G07A 最新在前）');
  const verifyStep = a.steps.find((s) => s.key === 'verify');
  assert.equal(verifyStep.status, 'awaiting', `T-G07A verify 应 awaiting，实际 ${verifyStep.status}`);

  // 6b) X05（向导化改造）：每任务附 activity 四字段，四态互斥、字段齐全；
  //     T-G07A verify 可拍板 → awaiting_user + 「等你确认」；顶层 live 同源。
  const STATES = ['working', 'awaiting_user', 'idle', 'unknown'];
  for (const t of flow.body.tasks) {
    const act = t.activity;
    assert.ok(act && typeof act.current_activity === 'string' && act.current_activity.length > 0,
      `${t.id}.activity.current_activity 应为非空字符串，实际 ${JSON.stringify(act)}`);
    assert.ok(STATES.includes(act.activity_state), `${t.id}.activity_state 应为四态之一，实际 ${act.activity_state}`);
    assert.ok('activity_updated_at' in act && 'run_id' in act, `${t.id}.activity 四字段必须齐全`);
  }
  assert.equal(a.activity.activity_state, 'awaiting_user', `T-G07A verify 可拍板应 awaiting_user，实际 ${JSON.stringify(a.activity)}`);
  assert.match(a.activity.current_activity, /等你确认/, `T-G07A activity 文案应指向用户确认，实际「${a.activity.current_activity}」`);
  assert.ok(flow.body.live && STATES.includes(flow.body.live.activity_state),
    `flow.live.activity_state 应为四态之一，实际 ${JSON.stringify(flow.body.live)}`);
  assert.equal(flow.body.live.activity_state, 'awaiting_user', `live 头条应继承 T-G07A 的等待确认，实际 ${JSON.stringify(flow.body.live)}`);
  assert.equal(flow.body.live.taskId, 'T-G07A', `live.taskId 应指向 T-G07A，实际 ${flow.body.live.taskId}`);

  // 7) /api/office/decisions：待决策清单真算出 T-G07A verify
  const dec = await get('/api/office/decisions');
  assert.equal(dec.status, 200);
  const item = (dec.body.items || []).find((it) => it.taskId === 'T-G07A' && it.stepKey === 'verify');
  assert.ok(item, `decisions.items 应含 T-G07A/verify，实际 ${JSON.stringify(dec.body.items).slice(0, 160)}`);

  // 8) /api/office/op-status：缺参 400 带业务码；未知 opId 如实 found:false
  const noOp = await get('/api/office/op-status');
  assert.equal(noOp.status, 400);
  assert.equal(noOp.body.code, 'MISSING_OP_ID', `应 400/MISSING_OP_ID，实际 ${noOp.status}/${noOp.body?.code}`);
  const unknownOp = await get('/api/office/op-status?opId=g07-never');
  assert.equal(unknownOp.status, 200);
  assert.equal(unknownOp.body.found, false, '未知 opId 应 found:false（不是 404 也不是 500）');

  // 8b) X01 /api/agents/real：claude/codex 两位必须在；探测字段三值域
  //     （boolean|null——取不到就是 null，不许猜）；任何本机探测异常都不得变 500。
  //     放在 file 白名单用例之前：本机仓库搬家后白名单根还是旧 C: 盘路径（既有问题），
  //     file 一族会 403，不能让它挡在本路由的形状检查前面。
  const ar = await get('/api/agents/real');
  assert.equal(ar.status, 200, `agents/real 应 200（探测失败也不许 500），实际 ${ar.status}`);
  assert.ok(ar.body.agents && ar.body.agents.claude && ar.body.agents.codex,
    `agents/real 应同时含 claude 与 codex，实际 ${JSON.stringify(ar.body).slice(0, 160)}`);
  for (const k of ['claude', 'codex']) {
    const a = ar.body.agents[k];
    assert.ok(typeof a.processAlive === 'boolean' || a.processAlive === null,
      `${k}.processAlive 应 boolean|null，实际 ${JSON.stringify(a.processAlive)}`);
    assert.ok(typeof a.rateLimited === 'boolean' || a.rateLimited === null,
      `${k}.rateLimited 应 boolean|null（取不到就是 null，不许猜 false），实际 ${JSON.stringify(a.rateLimited)}`);
  }

  // 9) /api/office/file：缺参 400；白名单内真实文件读回真实文本与指纹
  const noPath = await get('/api/office/file');
  assert.equal(noPath.status, 400);
  assert.equal(noPath.body.code, 'MISSING_PATH', `应 400/MISSING_PATH，实际 ${noPath.status}/${noPath.body?.code}`);

  const realPath = REAL_FILE;
  const fileRes = await get('/api/office/file?path=' + encodeURIComponent(realPath));
  assert.equal(fileRes.status, 200);
  assert.equal(fileRes.body.kind, 'text', `.css 应按文本读，实际 kind=${fileRes.body.kind}`);
  assert.ok(fileRes.body.text.length > 100, `应读回真实文本，实际 ${fileRes.body.text.length} 字`);
  const disk = statSync(new URL('../web/app-base.css', import.meta.url));
  assert.equal(fileRes.body.bytes, disk.size, `bytes 应等于磁盘实测 ${disk.size}，实际 ${fileRes.body.bytes}`);
  assert.match(fileRes.body.sha256, /^[0-9a-f]{64}$/, 'sha256 应为 64 位十六进制指纹');

  // 10) /api/office/file-version：登记指纹与磁盘一致 → disk-current 提供真实内容
  const fv = await get(`/api/office/file-version?path=${encodeURIComponent(realPath)}&taskId=T-G07A&stepKey=req`);
  assert.equal(fv.status, 200);
  assert.equal(fv.body.ok, true);
  assert.equal(fv.body.available, true, `登记=磁盘现状应 available，实际 ${JSON.stringify(fv.body).slice(0, 140)}`);
  assert.equal(fv.body.source, 'disk-current');
  const fvBad = await get('/api/office/file-version?path=x');
  assert.equal(fvBad.status, 400);
  assert.equal(fvBad.body.code, 'MISSING_IDS', `应 400/MISSING_IDS，实际 ${fvBad.status}/${fvBad.body?.code}`);

  // 11) X06 /api/office/review GET：T-G07A 还没记过评审 → 空账本如实 exists:false
  //     （不是 404 也不是 500），上限常量随响应下发，前端不自创返工规则。
  const rv0 = await get('/api/office/review?taskId=T-G07A');
  assert.equal(rv0.status, 200);
  assert.equal(rv0.body.exists, false, `没记过评审应 exists:false，实际 ${JSON.stringify(rv0.body)}`);
  assert.deepEqual(rv0.body.rounds, []);
  assert.equal(rv0.body.advice, 'none');
  assert.equal(rv0.body.limits.maxRounds, 5, '返工上限应为 5 轮');
  const rvBad = await get('/api/office/review?taskId=');
  assert.equal(rvBad.status, 400);
  assert.equal(rvBad.body.code, 'BAD_TASK_ID', `应 400/BAD_TASK_ID，实际 ${rvBad.status}/${rvBad.body?.code}`);

  console.log(`[R2] 13 条 GET 路由业务形状全过（skills=12、flow=3×7+X05 四字段、decisions 含 T-G07A/verify、review 空账本如实、agents/real 三值域）`);
});

test('R3 POST 协议错误/白名单/下载/代理链：具体业务码 + 403 白名单 + 中台透传', async () => {
  // 1) file-check：真实路径核实出 exists+bytes
  const realPath = REAL_FILE;
  const fc = await post('/api/office/file-check', { paths: [realPath, 'X:/g07/不存在的文件.md'] });
  assert.equal(fc.status, 200);
  assert.equal(fc.body.results.length, 2);
  assert.equal(fc.body.results[0].exists, true, '白名单内真实文件应 exists=true');
  assert.ok(fc.body.results[0].bytes > 0, '真实文件 bytes>0');
  assert.equal(fc.body.results[1].exists, false, '不存在路径应如实 exists=false');

  // 2) version-gate：协议错误逐个具名（不是笼统 404）
  assert.equal((await post('/api/office/version-gate', {})).body.code, 'BAD_TASK_ID');
  assert.equal((await post('/api/office/version-gate', { taskId: 'T-G07A', stepKey: 'nope' })).body.code, 'BAD_STEP');
  const vg = await post('/api/office/version-gate', { taskId: 'T-G07A', stepKey: 'verify' });
  assert.equal(vg.status, 200, `version-gate 合法请求应 200，实际 ${vg.status}/${JSON.stringify(vg.body)}`);
  assert.equal(vg.body.taskId, 'T-G07A');

  // 3) file-revalidate：缺参具名 400
  const rv = await post('/api/office/file-revalidate', {});
  assert.equal(rv.status, 400);
  assert.equal(rv.body.code, 'MISSING_PARAMS', `应 400/MISSING_PARAMS，实际 ${rv.status}/${rv.body?.code}`);

  // 4) decide：四段校验逐个具名
  assert.equal((await post('/api/office/decide', {})).body.code, 'BAD_TASK_ID');
  assert.equal((await post('/api/office/decide', { taskId: 'T-G07A', step: 'nope' })).body.code, 'BAD_STEP');
  assert.equal((await post('/api/office/decide', { taskId: 'T-G07A', step: 'verify', action: 'nope' })).body.code, 'BAD_ACTION');
  assert.equal((await post('/api/office/decide', { taskId: 'T-G07A', step: 'verify', action: 'reject' })).body.code, 'REASON_REQUIRED');

  // 5) resubmit / decision：参数校验具名
  assert.equal((await post('/api/office/resubmit', {})).body.code, 'BAD_TASK_ID');
  assert.equal((await post('/api/office/decision', {})).body.code, 'BAD_DEMAND_ID');
  assert.equal((await post('/api/office/decision', { demandId: 'T-G07A', stepKey: 'nope' })).body.code, 'BAD_STEP');

  // 6) 白名单语义：白名单外路径读取 403（file / file-version / file-download / file-revalidate 四处一致）
  const outside = 'C:/Windows/win.ini';
  for (const probe of [
    () => get('/api/office/file?path=' + encodeURIComponent(outside)),
    () => get(`/api/office/file-version?path=${encodeURIComponent(outside)}&taskId=T-G07A&stepKey=req`),
    () => get('/api/office/file-download?path=' + encodeURIComponent(outside)),
    () => post('/api/office/file-revalidate', { path: outside, taskId: 'T-G07A', stepKey: 'req' }),
  ]) {
    const r = await probe();
    assert.equal(r.status, 403, `白名单外 ${outside} 应 403，实际 ${r.status}`);
    assert.equal(r.body.code, 'PATH_NOT_ALLOWED', `应 PATH_NOT_ALLOWED，实际 ${r.body?.code}`);
  }

  // 7) file-download：真实下载链（attachment 头 + 字节与磁盘一致）
  const dl = await fetch(stack.base + '/api/office/file-download?path=' + encodeURIComponent(realPath));
  assert.equal(dl.status, 200);
  const disposition = dl.headers.get('content-disposition') || '';
  assert.ok(/attachment/i.test(disposition), `下载应带 attachment 头，实际「${disposition}」`);
  const dlBytes = Buffer.from(await dl.arrayBuffer());
  assert.equal(dlBytes.length, statSync(new URL('../web/app-base.css', import.meta.url)).size,
    '下载字节应与磁盘一致');

  // 8) 参数化代理链：stub 中台 404 原样透传——证明请求真的转到了中台对应路径
  const ans = await post('/api/cards/123/answer', { choice: 0 });
  assert.equal(ans.status, 404, `stub 中台不认识该卡 → 应透传 404，实际 ${ans.status}`);
  assert.ok(String(ans.body?.error || '').includes('/v1/cards/123/answer'),
    `透传错误应点名中台路径，实际 ${JSON.stringify(ans.body)}`);
  const res_ = await post('/api/cards/123/resolve', { reason: 'G07 代理链验证' });
  assert.equal(res_.status, 404);
  assert.ok(String(res_.body?.error || '').includes('/v1/cards/123/resolve'));
  const cancel = await post('/api/runs/9001/cancel');
  assert.equal(cancel.status, 404);
  assert.ok(String(cancel.body?.error || '').includes('/v1/runs/9001/cancel'));
  // 代理入参校验在本端：无效 answer body 不出网
  assert.equal((await post('/api/cards/123/answer', {})).body.code, 'INVALID_ANSWER');
  assert.equal((await post('/api/cards/123/resolve', {})).body.code, 'INVALID_REASON');

  // 9) 405 语义：已知路由打错方法
  const wrong = await fetch(stack.base + '/api/health', { method: 'POST' });
  assert.equal(wrong.status, 405, `已知路由错方法应 405，实际 ${wrong.status}`);

  // 10) X06 /api/office/review POST：具名校验 + 记轮 + 补记执行结果 +
  //     无进展暂停 / 打满上限 409 / 达标 outcome=pass，全链走真实磁盘账本
  assert.equal((await post('/api/office/review', {})).body.code, 'BAD_TASK_ID');
  assert.equal((await post('/api/office/review', { taskId: 'T-G07A' })).body.code, 'BAD_SCORE');
  assert.equal((await post('/api/office/review', { taskId: 'T-G07A', score: 7 })).body.code, 'BASIS_REQUIRED');
  assert.equal((await post('/api/office/review', { taskId: 'T-NOSUCH', score: 7, basis: 'x' })).body.code, 'TASK_NOT_FOUND');
  const r1 = await post('/api/office/review', { taskId: 'T-G07A', score: 6.0, targetScore: 8, basis: '第 1 轮：骨架有了，核心功能缺一半', issues: '导出功能没做', instruction: '补导出功能' });
  assert.equal(r1.status, 200, `记第 1 轮应 200，实际 ${r1.status}/${JSON.stringify(r1.body)}`);
  assert.equal(r1.body.rounds.length, 1);
  assert.equal(r1.body.rounds[0].outcome, 'rework', '6.0 < 8 应记 rework');
  assert.equal(r1.body.readBack, true, '响应必须是磁盘读回值');
  // 平分不涨 → 第 3 轮后应建议暂停转人工
  await post('/api/office/review', { taskId: 'T-G07A', score: 6.0, basis: '第 2 轮：改了一个问题又冒出两个' });
  const r3 = await post('/api/office/review', { taskId: 'T-G07A', score: 5.5, basis: '第 3 轮：修复没落地，分反而降了' });
  assert.equal(r3.body.advice, 'pause-no-progress', `连续两轮无进展应建议暂停，实际 ${r3.body.advice}`);
  // 补记执行结果（Claude 的执行结果写进既有轮次）
  const back = await post('/api/office/review', { taskId: 'T-G07A', roundNo: 1, result: 'Claude 说已补上导出功能，等下轮评审核实' });
  assert.equal(back.status, 200);
  assert.equal(back.body.rounds[0].result, 'Claude 说已补上导出功能，等下轮评审核实');
  // 达标轮 → pass；打满 5 轮后第 6 轮 409 拒绝（不无限返工）
  const r4 = await post('/api/office/review', { taskId: 'T-G07A', score: 8.3, basis: '第 4 轮：人工接手指路后达标' });
  assert.equal(r4.body.rounds[3].outcome, 'pass', '8.3 >= 8 应记 pass');
  assert.equal(r4.body.advice, 'pass');
  await post('/api/office/review', { taskId: 'T-G07A', score: 8.4, basis: '第 5 轮：复核保持达标' });
  const r6 = await post('/api/office/review', { taskId: 'T-G07A', score: 8.5, basis: '第 6 轮' });
  assert.equal(r6.status, 409, `打满上限后应 409，实际 ${r6.status}`);
  assert.equal(r6.body.code, 'MAX_ROUNDS_REACHED', `应 MAX_ROUNDS_REACHED，实际 ${r6.body?.code}`);

  // 11) X07 /api/office/new-task POST：真实建档（init+set req done）+ 读回核验 +
  //     idea 原话入档；空 idea 400 具名
  //     R87·X01 新契约：建档即自动推进——req done 后 doc 立即 running（AI 自动讨论，
  //     不再有「确认想法」审批），讨论留档同步起头（GET /api/office/discuss 可读）。
  //     （原断言 idle/排着队 属于被删掉的旧流程，按新流程口径改。）
  assert.equal((await post('/api/office/new-task', {})).body.code, 'IDEA_REQUIRED');
  const nt = await post('/api/office/new-task', { idea: 'G07 验证：帮我做一个记录每天喝水杯数的小工具' });
  assert.equal(nt.status, 200, `新任务应 200，实际 ${nt.status}/${JSON.stringify(nt.body)}`);
  assert.match(nt.body.taskId, /^T-\d{8}-01$/, `新 ID 应为当天序号格式，实际 ${nt.body.taskId}`);
  assert.equal(nt.body.readBack.req.status, 'done', 'req 应记 done（原始需求原话存档）');
  assert.equal(nt.body.readBack.req.note, 'G07 验证：帮我做一个记录每天喝水杯数的小工具', 'idea 原话必须一字不差入档');
  assert.equal(nt.body.readBack.req.by, 'Leo（工作台·新需求）');
  assert.equal(nt.body.readBack.doc.status, 'running', 'R87·X01：建档后 doc 应立即 running（AI 自动开始讨论，无审批卡点）');
  // 建完后 flow 里能看到它，activity 是真实的自动推进态（正在讨论，不是排队）
  const flow2 = await get('/api/office/flow');
  const created = flow2.body.tasks.find((t) => t.id === nt.body.taskId);
  assert.ok(created, `新任务应出现在 flow 列表，实际 ${flow2.body.tasks.map((t) => t.id).join('、')}`);
  assert.equal(created.activity.activity_state, 'working', `R87·X01：新任务应 working（AI 正在讨论），实际 ${JSON.stringify(created.activity)}`);
  assert.match(created.activity.current_activity, /正在/, '推进态文案应说 AI 正在做');
  // R87·X03：讨论留档路由通、且建档后立即可读（同步起头，不靠后台时序）
  const dsc = await get(`/api/office/discuss?taskId=${nt.body.taskId}`);
  assert.equal(dsc.status, 200, `discuss 路由应 200，实际 ${dsc.status}`);
  assert.equal(dsc.body.ok, true);
  assert.equal(dsc.body.exists, true, '建档后讨论留档应已存在');

  console.log('[R3] POST 具名错误码 + 403 白名单×4 + 下载头 + 代理透传×3 + 405 + review 账本全链 + 新任务读回核验 全过');
});
