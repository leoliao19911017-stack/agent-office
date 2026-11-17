// G02-F｜三流程 E2E（G02 收官）：审批闭环 / 文件预览 / 历史版本读取。
// 复用 G07 夹具（stub 中台 + 临时 AGENT_AUTOLOOP_HOME + 真实 server.js 子进程 +
// 系统 Chrome），全程不碰真实任务档案。
// 验收口径（G02 任务书）：「最终必须能够重新打开四个实际页面，并完整执行
// 审批、文件预览和历史版本读取流程」——四页首屏已由 g07-pages 覆盖，
// 本文件补三条业务流程，getComputedStyle / getBoundingClientRect / 网络响应
// 实测数值随断言取证。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { startStack, launchBrowser, newPage } from './g07-harness.mjs';

let stack, browser;

before(async () => {
  stack = await startStack();
  browser = await launchBrowser();
});

after(async () => {
  await browser?.close();
  await stack?.stop();
});

test('D1 审批闭环：选需求→verify 步打回→写回一致+事件落档+重提面板反馈', async () => {
  const REASON = 'G02 回归验证：验收结论缺类型声明，打回重报';
  const { page, state } = await newPage(browser);
  try {
    await page.goto(stack.base + '/#/', { waitUntil: 'commit' });
    await page.waitForSelector('#reqs-list .req-item', { timeout: 15000 });

    await page.locator('.req-item', { hasText: 'G07 首屏验证需求' }).first().click();
    // selectTask 自动 focus 到可决策步骤（verify）：决策面板已在常驻 Inspector 里渲染

    // 实测：轨道节点是真实可点击的尺寸（不是 0×0 假节点）
    const nodeRect = await page.locator('.track-node[data-step="verify"]').evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), cursor: getComputedStyle(el).cursor };
    });
    assert.ok(nodeRect.w >= 24 && nodeRect.h >= 24, `verify 轨道节点尺寸实测 ${JSON.stringify(nodeRect)}，应 ≥24×24`);
    assert.equal(nodeRect.cursor, 'pointer', '轨道节点应为可点击指针');

    // 宽屏（≥1100px）下 Inspector 常驻右栏（app-base.css W02：#tb-insp-toggle 仅 ≤1099px
    // 抽屉模式显示）。verify 的审批对象=前序步骤已登记产物（app-base.css）→ approve/reject
    // 双按钮渲染；本步骤无产物登记时才是「补齐材料」单按钮（decideActsHtml 口径）。
    const btn = page.locator('[data-decide="reject"]');
    await btn.waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await page.locator('[data-decide="approve"]').count(), 1, '前序产物构成审批对象：应有通过按钮');
    const btnStyle = await btn.evaluate((el) => ({ disabled: el.disabled, cursor: getComputedStyle(el).cursor }));
    assert.equal(btnStyle.disabled, false);
    assert.equal(btnStyle.cursor, 'pointer');

    await page.fill('#ip-decide-note', REASON);
    const respPromise = page.waitForResponse((r) => r.url().includes('/api/office/decision') && r.request().method() === 'POST', { timeout: 15000 });
    await btn.click();
    const resp = await respPromise;
    assert.equal(resp.status(), 200, `decision 应 200，实际 ${resp.status()}`);
    const body = await resp.json();
    assert.equal(body.verified, true, '写后读回应与目标一致');
    assert.equal(body.action, 'reject');
    assert.equal(body.to, 'failed', '打回后步骤应为 failed');
    assert.equal(body.step.note, REASON, '打回理由应原样写入步骤备注');

    // 事件流水落档（夹具隔离目录）
    const evText = readFileSync(join(stack.home, 'office-data', 'decision-events.jsonl'), 'utf8').trim();
    assert.ok(evText.length > 0, 'decision-events.jsonl 应有事件');
    const lastEv = JSON.parse(evText.split('\n').pop());
    assert.equal(lastEv.demandId, 'T-G07A');
    assert.equal(lastEv.stepKey, 'verify');
    assert.equal(lastEv.action, 'reject');
    assert.equal(lastEv.to, 'failed');
    assert.equal(lastEv.result, 'written');

    // UI 反馈：failed → 重提面板（decideFailedHtml），理由原文 + 重提按钮同屏
    await page.waitForSelector('[data-decide="resubmit"]', { timeout: 10000 });
    await page.waitForFunction((reason) => {
      const why = document.querySelector('.rej-why');
      return why && (why.textContent || '').includes(reason);
    }, REASON, { timeout: 10000 });
    const whyText = await page.locator('.rej-why').innerText();
    console.log(`[D1] nodeRect=${JSON.stringify(nodeRect)} btnCursor=${btnStyle.cursor} to=${body.to} 理由="${whyText.trim().slice(0, 30)}…"`);
    assert.equal(state.pageErrors.length, 0, state.pageErrors.join(' || '));
    assert.equal(state.consoleErrs.length, 0, state.consoleErrs.join(' || '));
  } finally { await page.close(); }
});

test('D2 文件预览：文件页点产物预览 → 抽屉打开 + 内容指纹核对 + 实测样式', async () => {
  const { page, state } = await newPage(browser);
  try {
    await page.goto(stack.base + '/#/files', { waitUntil: 'commit' });
    await page.waitForSelector('.lf-preview', { timeout: 15000 });

    const fileRespP = page.waitForResponse((r) => r.url().includes('/api/office/file?'), { timeout: 15000 });
    await page.locator('.lf-preview').first().click();
    const fileResp = await fileRespP;
    assert.equal(fileResp.status(), 200);
    const body = await fileResp.json();
    assert.equal(body.exists, true);
    assert.equal(body.kind, 'text', 'app-base.css 应走文本预览');
    // 指纹双口径：响应里的 sha256 与响应文本自算一致（预览的就是返回的内容）
    const selfSha = createHash('sha256').update(body.text, 'utf8').digest('hex');
    assert.equal(selfSha, body.sha256, '预览内容全文 sha256 应与服务端登记指纹一致');

    await page.waitForSelector('#fv-body pre', { timeout: 10000 });
    const view = await page.evaluate(() => {
      const box = document.getElementById('file-view');
      const cs = getComputedStyle(box);
      const r = box.getBoundingClientRect();
      return {
        display: cs.display, visibility: cs.visibility,
        w: Math.round(r.width), h: Math.round(r.height),
        name: document.getElementById('fv-name').textContent,
        path: document.getElementById('fv-path').textContent,
        bodyLen: document.querySelector('#fv-body pre').textContent.length,
        detailRows: document.querySelectorAll('#fv-detail .fh-kv, #fv-detail div').length,
      };
    });
    assert.equal(view.name, 'app-base.css', `预览文件名实测 "${view.name}"`);
    assert.ok(view.path.endsWith('app-base.css'), `预览路径实测 ${view.path}`);
    assert.notEqual(view.display, 'none', '抽屉应可见');
    assert.equal(view.visibility, 'visible');
    assert.ok(view.w >= 400 && view.h >= 200, `抽屉实测 ${view.w}×${view.h}，应 ≥400×200`);
    assert.ok(view.bodyLen > 0, '预览正文应有真实内容');
    assert.ok(view.detailRows > 0, '元数据区应有登记行');
    console.log(`[D2] 抽屉=${view.w}×${view.h} display=${view.display} bodyLen=${view.bodyLen} sha=${body.sha256.slice(0, 12)}…`);
    assert.equal(state.pageErrors.length, 0, state.pageErrors.join(' || '));
    assert.equal(state.consoleErrs.length, 0, state.consoleErrs.join(' || '));
  } finally { await page.close(); }
});

test('D3 历史版本读取：登记指纹指向保存原文 → file-version snapshot + 页内双重核对展示', async () => {
  // 在隔离夹具内造一条真实「历史版本」：T-G07B 的 deliverable 登记指纹指向
  // 保存原文（≠ 磁盘现状 app-base.css）→ 点该登记行 → 历史预览分支 → file-version
  const HIST_TEXT = 'G02 历史版本保存原文 v1：登记指纹指向本文本，磁盘现状已漂移';
  const bPath = join(stack.home, 'office-data', 'tasks', 'T-G07B.json');
  const bRec = JSON.parse(readFileSync(bPath, 'utf8'));
  bRec.steps.deliverable.files[0] = {
    ...bRec.steps.deliverable.files[0],
    bytes: Buffer.byteLength(HIST_TEXT, 'utf8'),
    sha256: createHash('sha256').update(HIST_TEXT, 'utf8').digest('hex'),
    text: HIST_TEXT,   // 登记保存原文 → 服务端快照候选命中
  };
  writeFileSync(bPath, JSON.stringify(bRec, null, 1));

  // curl 口径（服务端独立链路）：登记指纹≠磁盘 → 走快照候选 → snapshot
  const q = new URLSearchParams({ path: bRec.steps.deliverable.files[0].path, taskId: 'T-G07B', stepKey: 'deliverable' });
  const vr = await fetch(`${stack.base}/api/office/file-version?${q}`);
  const vj = await vr.json();
  assert.equal(vr.status, 200, `file-version 应 200，实际 ${vr.status}`);
  assert.equal(vj.available, true, '保存原文核对一致 → 可用');
  assert.equal(vj.source, 'snapshot', `来源应为快照留档，实际 ${vj.source}`);
  assert.equal(vj.text, HIST_TEXT, '应带回登记保存原文');
  assert.equal(vj.disk.exists, true, '磁盘现状实测应带回');

  // 另一路径：disk-current（T-G07A req 登记与磁盘一致 → 按现状展示）
  const aRec = JSON.parse(readFileSync(join(stack.home, 'office-data', 'tasks', 'T-G07A.json'), 'utf8'));
  const qa = new URLSearchParams({ path: aRec.steps.req.files[0].path, taskId: 'T-G07A', stepKey: 'req' });
  const va = await (await fetch(`${stack.base}/api/office/file-version?${qa}`)).json();
  assert.equal(va.available, true);
  assert.equal(va.source, 'disk-current', '指纹一致的登记按磁盘现状展示');

  // 浏览器口径：点 T-G07B 的历史版本登记行 → 页内发 file-version 并展示保存原文
  const { page, state } = await newPage(browser);
  try {
    await page.goto(stack.base + '/#/files', { waitUntil: 'commit' });
    const histRow = page.locator('.lf-vrow[data-task-id="T-G07B"]');
    await histRow.waitFor({ state: 'visible', timeout: 15000 });
    const verRespP = page.waitForResponse((r) => r.url().includes('/api/office/file-version'), { timeout: 15000 });
    await histRow.first().click();
    const verResp = await verRespP;
    const vbody = await verResp.json();
    assert.equal(verResp.status(), 200);
    assert.equal(vbody.available, true, `页内 file-version 实测 available=${vbody.available}`);
    assert.equal(vbody.source, 'snapshot');

    await page.waitForSelector('#fv-body pre', { timeout: 10000 });
    const shown = await page.evaluate(() => ({
      pre: document.querySelector('#fv-body pre').textContent,
      hint: (document.querySelector('#fv-body .fv-hint') || {}).textContent || '',
      boxOpen: document.getElementById('file-view').classList.contains('open'),
    }));
    assert.equal(shown.pre, HIST_TEXT, '页内应展示双重核对一致后的保存原文');
    assert.match(shown.hint, /历史版本|磁盘当前/, `历史提示应说明口径，实际 "${shown.hint.slice(0, 60)}"`);
    console.log(`[D3] curl: source=${vj.source}/${va.source} len=${vj.text.length} | 页内: ${verResp.status()} snapshot=${vbody.source === 'snapshot'} 原文长度=${shown.pre.length}`);
    assert.equal(state.pageErrors.length, 0, state.pageErrors.join(' || '));
    assert.equal(state.consoleErrs.length, 0, state.consoleErrs.join(' || '));
  } finally { await page.close(); }
});
