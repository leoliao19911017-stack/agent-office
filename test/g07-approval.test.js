// G07-E｜审批与历史版本校验（4 用例）——任务书四大类里此前缺失的一类。
//
// 验收口径（对应任务书「4 个审批和历史版本校验」+「历史版本错配注入必须让测试明确失败」）：
//   D1 审批链路 UI 闭环：真浏览器里选待拍板任务 → 备注理由 → 打回 →
//      步骤真实转 failed（中央链路节点 st-failed + 服务端档案复核），不是本地假状态；
//   D2 审批版本门禁：上游产物登记漂移（指纹与磁盘不符）→ 前端禁用批准按钮、
//      服务端 approve 409 ARTIFACT_VERSION_DRIFT 不落笔；打回不受门禁限制仍可走（不锁死流程）；
//   D3 历史版本命中：登记旧指纹 + history 快照与指纹一致 → snapshot 提供历史原文，
//      服务端返回的 text 用 node:crypto 独立复算指纹必须等于登记值（不冒充）；
//   D4 历史版本错配拒绝：快照与登记指纹对不上 → available:false / snapshot-mismatch /
//      不给 text；vkey（版本登记标识）不匹配 → 409 vkey-mismatch。
//
// 夹具：本文件独立起一套 stack（临时 home + 临时端口），并注入两条额外任务
// （T-G07D 漂移审批 / T-G07V 历史版本），不影响 A/B/C/R 文件的 3 任务断言。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startStack, launchBrowser, newPage, sleep, REAL_FILE } from './g07-harness.mjs';

const shaOf = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/* ------- 合成历史版本文本：指纹在测试侧独立实算（不信服务端回显值） ------- */
const V1_TEXT = [
  'G07 历史版本快照 V1（合成测试数据）',
  '这是登记时留档的旧版本文本，第二行确保多行。',
  'Third line to keep multi-byte + ascii mixed hashing honest.',
].join('\n') + '\n';
const WRONG_TEXT = 'G07 错配快照：这份文本与登记指纹对不上，不允许冒充历史原文（合成测试数据）\n';
const V1 = { text: V1_TEXT, bytes: Buffer.byteLength(V1_TEXT, 'utf8'), sha256: shaOf(V1_TEXT) };
const WRONG = { text: WRONG_TEXT, bytes: Buffer.byteLength(WRONG_TEXT, 'utf8'), sha256: shaOf(WRONG_TEXT) };
// 漂移登记指纹：一个不属于任何真实文件的合法 sha256（真实文件另有指纹，必然对不上）
const DRIFT_SHA = shaOf('G07 漂移登记占位：这份指纹不指向任何真实文件内容');

const iso = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString();

// T-G07V：doc 登记旧指纹 V1 且快照=V1（命中）；plan 登记指纹仍 V1 但快照=WRONG（错配）
// T-G07D：deliverable 登记与磁盘漂移，verify 待拍板（approve 必被版本门禁拦下）
const EXTRA_TASKS = [
  {
    id: 'T-G07V', title: 'G07 历史版本验证需求',
    createdAt: iso(90), updatedAt: iso(3),
    steps: {
      req: { status: 'done', at: iso(88), note: '历史版本链路验证', by: 'leo' },
      doc: { status: 'done', at: iso(60), note: '登记历史版本 V1（快照留档）', by: 'lemate',
        files: [{ path: REAL_FILE, bytes: V1.bytes, sha256: V1.sha256,
          history: [{ snapshot: V1.text, at: iso(60) }] }] },
      plan: { status: 'done', at: iso(50), note: '快照与指纹故意错配（拒绝路径）', by: 'lemate',
        files: [{ path: REAL_FILE, bytes: V1.bytes, sha256: V1.sha256,
          history: [{ snapshot: WRONG.text, at: iso(50) }] }] },
      brief: { status: 'pending', at: null, note: '', by: null },
      deliverable: { status: 'pending', at: null, note: '', by: null },
      verify: { status: 'pending', at: null, note: '', by: null },
      final: { status: 'pending', at: null, note: '', by: null },
    },
  },
  {
    id: 'T-G07D', title: 'G07 版本漂移审批需求',
    createdAt: iso(80), updatedAt: iso(1),
    steps: {
      req: { status: 'done', at: iso(78), note: '版本门禁验证', by: 'leo' },
      doc: { status: 'done', at: iso(70), note: '', by: 'lemate' },
      plan: { status: 'done', at: iso(68), note: '', by: 'lemate' },
      brief: { status: 'done', at: iso(66), note: '', by: 'lemate' },
      deliverable: { status: 'done', at: iso(20), note: '登记与磁盘不符（漂移注入）', by: 'lemate',
        files: [{ path: REAL_FILE, bytes: 12345, sha256: DRIFT_SHA }] },
      verify: { status: 'awaiting', at: iso(1), note: '等拍板：approve 应被版本门禁拦下', by: 'hermes' },
      final: { status: 'pending', at: null, note: '', by: null },
    },
  },
];

let stack, browser;
before(async () => {
  stack = await startStack(EXTRA_TASKS);
  browser = await launchBrowser();
});
after(async () => {
  await browser?.close();
  await stack?.stop();
});

const get = async (p) => {
  const r = await fetch(stack.base + p);
  let body = null;
  try { body = await r.json(); } catch { /* 保留 null，断言自会点名 */ }
  return { status: r.status, body };
};
const post = (p, body) => fetch(stack.base + p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
}).then(async (r) => {
  let b = null;
  try { b = await r.json(); } catch { /* 保留 null */ }
  return { status: r.status, body: b };
});

test('D1 审批链路 UI 闭环：选任务→备注→打回→步骤真实转 failed（服务端档案复核）', async () => {
  const { page, state } = await newPage(browser);
  try {
    await page.goto(stack.base + '/', { waitUntil: 'commit' });
    await page.waitForSelector('#reqs-list .req-item', { timeout: 15000 });
    await page.waitForSelector('#sb-conn.ok', { timeout: 10000 });

    // 选 T-G07A（verify 待拍板）→ 右侧决策面板出现：备注框 + 通过/打回按钮
    await page.click('.req-item[data-task="T-G07A"]');
    await page.waitForSelector('#ip-decide-note', { timeout: 8000 });
    const approveBtn = page.locator('[data-decide="approve"]');
    await approveBtn.waitFor({ state: 'visible', timeout: 8000 });
    // T-G07A 的登记与磁盘一致：批准按钮可用（disabled 属性不存在）
    const approveEnabled = await approveBtn.isEnabled();
    assert.equal(approveEnabled, true, '登记无漂移时批准按钮应可用（若禁用说明版本判定误报）');

    await page.fill('#ip-decide-note', 'G07-D1 打回理由：验收证据不足，补充回归报告后重提');
    await page.click('[data-decide="reject"]');

    // 打回成功反馈 + 中央链路 verify 节点转 failed（等轮询/写回合并那一拍）
    await page.waitForSelector('.done-line', { timeout: 10000 });
    await page.waitForSelector('#center-chain .track-node[data-step="verify"].st-failed', { timeout: 10000 });
    const fb = await page.locator('.done-line').first().innerText();
    assert.ok(fb.includes('已打回'), `打回反馈应含「已打回」，实际「${fb}」`);

    // 服务端真相复核：档案里 verify.status 真的是 failed（不是前端本地假状态）
    const flow = await get('/api/office/flow');
    const a = flow.body.tasks.find((t) => t.id === 'T-G07A');
    const verify = a.steps.find((s) => s.key === 'verify');
    assert.equal(verify.status, 'failed', `服务端档案 verify 应 failed，实际 ${verify.status}`);
    // 打回必须写明理由：档案 note 带回提交的理由
    assert.ok(String(verify.note || '').includes('G07-D1 打回理由'),
      `打回后 note 应含提交理由，实际「${verify.note}」`);

    // 全程零页面异常 / 零 console.error
    const uiErrors = await page.evaluate(() => window.__uiErrors | 0);
    assert.equal(uiErrors, 0, `__uiErrors=${uiErrors}`);
    assert.equal(state.pageErrors.length, 0, state.pageErrors.join(' || '));
    assert.equal(state.consoleErrs.length, 0, state.consoleErrs.join(' || '));
    console.log('[D1] UI 打回闭环通过：verify→failed（UI+服务端双确认），零异常');
  } finally { await page.close(); }
});

test('D2 审批版本门禁：登记漂移 → 批准按钮禁用 + approve 409 ARTIFACT_VERSION_DRIFT；打回不受限', async () => {
  const { page, state } = await newPage(browser);
  try {
    await page.goto(stack.base + '/', { waitUntil: 'commit' });
    await page.waitForSelector('#reqs-list .req-item', { timeout: 15000 });
    await page.waitForSelector('#sb-conn.ok', { timeout: 10000 });

    // 选 T-G07D：deliverable 登记漂移，verify 待拍板
    await page.click('.req-item[data-task="T-G07D"]');
    await page.waitForSelector('#ip-decide-note', { timeout: 8000 });

    // 前端拉到服务端版本判定（version-gate 异步，不挡渲染）后禁用批准按钮
    await page.waitForFunction(() => {
      const b = document.querySelector('[data-decide="approve"]');
      return b && b.disabled === true;
    }, null, { timeout: 10000 });
    const title = await page.locator('[data-decide="approve"]').getAttribute('title');
    assert.ok(String(title).includes('版本不一致'),
      `禁用原因应点名「版本不一致」，实际 title="${title}"`);
    const rejectEnabled = await page.locator('[data-decide="reject"]').isEnabled();
    assert.equal(rejectEnabled, true, '漂移只拦批准，打回按钮应保持可用');

    // 服务端口径：绕过前端直接 approve → 409 ARTIFACT_VERSION_DRIFT（前端禁用不是兜底，是提示）
    const blocked = await post('/api/office/decision', {
      demandId: 'T-G07D', stepKey: 'verify', action: 'approve', reason: '尝试通过漂移产物',
    });
    assert.equal(blocked.status, 409, `漂移 approve 应 409，实际 ${blocked.status}/${JSON.stringify(blocked.body)}`);
    assert.equal(blocked.body.code, 'ARTIFACT_VERSION_DRIFT',
      `应 ARTIFACT_VERSION_DRIFT，实际 ${blocked.body?.code}`);

    // 门禁拒绝 = 不落笔：档案 verify 仍 awaiting，不是被写成 done
    let flow = await get('/api/office/flow');
    let verify = flow.body.tasks.find((t) => t.id === 'T-G07D').steps.find((s) => s.key === 'verify');
    assert.equal(verify.status, 'awaiting', `409 后 verify 应仍 awaiting（未落笔），实际 ${verify.status}`);

    // 打回不走版本门禁：漂移不锁死流程，可打回要求重新提交
    const rejected = await post('/api/office/decision', {
      demandId: 'T-G07D', stepKey: 'verify', action: 'reject', reason: 'G07-D2：产物漂移，打回重提',
    });
    assert.equal(rejected.status, 200, `打回应 200，实际 ${rejected.status}/${JSON.stringify(rejected.body)}`);
    assert.equal(rejected.body.verified, true, `写回应 verified=true，实际 ${JSON.stringify(rejected.body).slice(0, 160)}`);
    assert.equal(rejected.body.to, 'failed', `打回目标态应为 failed，实际 ${rejected.body.to}`);

    flow = await get('/api/office/flow');
    verify = flow.body.tasks.find((t) => t.id === 'T-G07D').steps.find((s) => s.key === 'verify');
    assert.equal(verify.status, 'failed', `打回后服务端档案 verify 应 failed，实际 ${verify.status}`);

    assert.equal(state.pageErrors.length, 0, state.pageErrors.join(' || '));
    console.log('[D2] 版本门禁通过：UI 禁用 + 409 ARTIFACT_VERSION_DRIFT 不落笔；打回路径未被锁死');
  } finally { await page.close(); }
});

test('D3 历史版本命中：快照与登记指纹一致 → 提供历史原文，指纹独立复算吻合', async () => {
  const q = `path=${encodeURIComponent(REAL_FILE)}&taskId=T-G07V&stepKey=doc&vkey=sha:${V1.sha256}`;
  const r = await get('/api/office/file-version?' + q);
  assert.equal(r.status, 200, `应 200，实际 ${r.status}`);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.available, true, `快照与指纹一致应 available，实际 ${JSON.stringify(r.body).slice(0, 200)}`);
  assert.equal(r.body.source, 'snapshot', `来源应 snapshot（磁盘≠登记，不可能 disk-current），实际 ${r.body.source}`);
  assert.equal(r.body.text, V1.text, '提供的历史原文必须逐字等于留档快照，不允许转写');
  assert.equal(r.body.sha256, V1.sha256, `回显指纹应=登记指纹，实际 ${r.body.sha256}`);

  // 独立复算：服务端给的 text 由测试侧 crypto 重算指纹，必须等于登记值——防「回显对、内容错」
  const recomputed = shaOf(r.body.text);
  assert.equal(recomputed, V1.sha256,
    `served text 复算指纹 ${recomputed.slice(0, 12)}… ≠ 登记指纹 ${V1.sha256.slice(0, 12)}…（历史原文被冒充）`);

  // 证明确实走了快照分支：磁盘现状 ≠ 登记版本（bytes 不同）
  assert.notEqual(r.body.disk.bytes, V1.bytes,
    `磁盘 bytes=${r.body.disk.bytes} 不应等于登记旧版本 bytes=${V1.bytes}（等于则测的是 disk-current 不是 snapshot）`);
  assert.equal(r.body.registration.sha256, V1.sha256, '登记标识应随响应带回');

  // vkey 正向双确认通过（vkey=登记指纹 → 不是 vkey-mismatch）
  console.log(`[D3] snapshot 命中：text ${r.body.text.length} 字，复算指纹=${recomputed.slice(0, 12)}… 与登记一致`);
});

test('D4 历史版本错配拒绝：快照对不上指纹 → 不提供原文；vkey 错配 → 409', async () => {
  const q = `path=${encodeURIComponent(REAL_FILE)}&taskId=T-G07V&stepKey=plan`;
  const r = await get('/api/office/file-version?' + q);
  assert.equal(r.status, 404, `快照错配应 404（F01 第 78 轮），实际 ${r.status}`);
  assert.equal(r.body.ok, false, `404 判定体应 ok:false，实际 ${r.body.ok}`);
  assert.equal(r.body.available, false, `快照与登记指纹不符时绝不能 available，实际 ${JSON.stringify(r.body).slice(0, 200)}`);
  assert.equal(r.body.reason, 'snapshot-mismatch', `拒绝原因应 snapshot-mismatch，实际 ${r.body.reason}`);
  assert.equal(r.body.text, undefined, '错配时不得夹带任何 text（不可预览，也不可泄露快照内容）');
  // 候选指纹只回实测数值用于比对提示，且回的是错配快照自身的指纹（≠登记指纹）
  assert.ok(Array.isArray(r.body.candidates) && r.body.candidates.length >= 1, '应带回候选实测指纹供比对');
  assert.equal(r.body.candidates[0].sha256, WRONG.sha256,
    `候选指纹应是错配快照的实测值，实际 ${r.body.candidates[0]?.sha256}`);
  assert.notEqual(r.body.candidates[0].sha256, V1.sha256, '候选指纹必须与登记指纹不同（这正是错配本身）');

  // vkey 双确认：拿 A 登记的身份读不到 B 版本 → 409 vkey-mismatch（不落入正文比对）
  const vk = await get(`/api/office/file-version?path=${encodeURIComponent(REAL_FILE)}&taskId=T-G07V&stepKey=doc&vkey=sha:${WRONG.sha256}`);
  assert.equal(vk.status, 409, `vkey 错配应 409，实际 ${vk.status}`);
  assert.equal(vk.body.reason, 'vkey-mismatch', `应 vkey-mismatch，实际 ${vk.body?.reason}`);
  assert.equal(vk.body.available, false);

  // 拒绝路径不写任何状态：两个分支都只是只读校验
  console.log('[D4] 错配拒绝通过：snapshot-mismatch 无原文泄露 + vkey-mismatch 409');
});
