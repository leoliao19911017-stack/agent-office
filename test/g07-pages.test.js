// G07-A｜四页首屏加载回归（4 用例）——回归背景：上轮重构后「页面只剩外壳」而测试无阻拦。
// TASK-工作台重做：#/ 首页=驾驶舱（原断言拆两半：驾驶舱首屏 + #/pro 专业视图业务断言）；
// Agents/技能/文件 三页挪进设置页签，旧 hash 自动跳转，A2-A4 走原 hash 即可测到同 DOM。
//
// 验收口径（任务书原文执行）：
//   - 不把静态 HTML 存在当页面可用：每页断言「业务 DOM 真实渲染出内容」
//     （需求行/Agent 卡/技能行/文件组），HTTP 200 不作为通过条件；
//   - 首轮有效内容加载 ≤3000ms（goto 前打点 → 业务选择器可见，真实墙钟时间）；
//   - getComputedStyle/getBoundingClientRect 实测数值随断言取证并打印。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
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

// 打点导航：goto(commit) → 等业务选择器。返回 { page, state, contentMs }
async function openPage(hash, businessSelector, timeout = 15000) {
  const { page, state } = await newPage(browser);
  const t0 = Date.now();
  await page.goto(stack.base + '/' + hash, { waitUntil: 'commit' });
  await page.waitForSelector(businessSelector, { timeout });
  const contentMs = Date.now() - t0;
  return { page, state, contentMs };
}

// 页面里统一取证：连接态实测样式 + 零异常口径
async function evidence(page) {
  return page.evaluate(() => {
    const conn = document.getElementById('sb-conn');
    const cs = getComputedStyle(conn);
    const t = getComputedStyle(document.getElementById('sb-conn-text'));
    return {
      connCls: conn.className,
      connText: document.getElementById('sb-conn-text').textContent,
      connColor: cs.color,
      dotColor: getComputedStyle(conn.querySelector('.dot')).backgroundColor,
      fontSize: t.fontSize,
      uiErrors: window.__uiErrors | 0,
    };
  });
}

test('A1 首页驾驶舱首屏：任务卡/实况区是真实业务内容，首轮 ≤3000ms', async () => {
  // TASK-工作台重做：#/ 首页已是任务驾驶舱（我的任务），三栏工作台在 #/pro 专业视图。
  // 首屏口径量驾驶舱；需求列表 + 交付链的业务断言原样搬到 #/pro 再验，不删不降。
  const { page, state, contentMs } = await openPage('#/', '#cabin-tasks .cabin-task');
  try {
    const cards = await page.locator('#cabin-tasks .cabin-task').count();
    assert.ok(cards >= 3, `任务卡应 ≥3（夹具 3 条），实际 ${cards}`);
    const titles = (await page.locator('#cabin-tasks .cabin-task b').allInnerTexts()).join('|');
    assert.ok(titles.includes('G07 首屏验证需求'), `任务卡应含夹具标题，实际：${titles.slice(0, 120)}`);
    // 实况区一句话非空 + 进度文字带真实计数（业务内容，不是空壳）
    const nowLine = await page.evaluate(() => document.querySelector('#cabin-main .cabin-now h2').textContent.trim());
    assert.ok(nowLine.length > 0, `「现在干什么」应为真实内容，实际「${nowLine}」`);
    const progText = await page.evaluate(() => (document.querySelector('#cabin-main .cabin-progress') || {}).textContent || '');
    assert.match(progText, /第 \d+ 项 \/ 共 \d+ 项 · 做完 \d+ 项/, `进度文字应带真实计数，实际「${progText}」`);

    await page.waitForSelector('#sb-conn.ok', { timeout: 10000 });
    const ev = await evidence(page);
    assert.equal(ev.connText, '已连接');
    assert.equal(ev.connColor, 'rgb(101, 217, 177)', `连接区颜色实测 ${ev.connColor}`);
    assert.equal(ev.fontSize, '12px');
    assert.equal(ev.uiErrors, 0, `__uiErrors 应为 0，实际 ${ev.uiErrors}：${state.pageErrors.join(' || ')}`);
    assert.equal(state.pageErrors.length, 0, state.pageErrors.join(' || '));
    assert.equal(state.consoleErrs.length, 0, state.consoleErrs.join(' || '));

    assert.ok(contentMs <= 3000, `首屏有效内容 ${contentMs}ms，应 ≤3000ms`);

    // 原工作台业务断言在专业视图 #/pro 原样保留：需求行真实 + 交付链 7 步轨道
    await page.goto(stack.base + '/#/pro', { waitUntil: 'commit' });
    await page.waitForSelector('#reqs-list .req-item', { timeout: 15000 });
    const rows = await page.locator('#reqs-list .req-item').count();
    assert.ok(rows >= 3, `需求行应 ≥3（夹具 3 条），实际 ${rows}`);
    const reqTitles = (await page.locator('#reqs-list .req-item').allInnerTexts()).join('|');
    assert.ok(reqTitles.includes('G07 首屏验证需求'), `需求行应含夹具标题，实际：${reqTitles.slice(0, 120)}`);
    const trackNodes = await page.locator('#center-chain .track-node').count();
    assert.ok(trackNodes >= 7, `交付链应有 7 步轨道节点，实际 ${trackNodes}`);
    assert.equal(state.pageErrors.length, 0, state.pageErrors.join(' || '));
    assert.equal(state.consoleErrs.length, 0, state.consoleErrs.join(' || '));

    console.log(`[A1] contentMs=${contentMs} cards=${cards} rows=${rows} trackNodes=${trackNodes} conn=${ev.connColor}`);
  } finally { await page.close(); }
});

test('A2 Agents 首屏：名册 4 卡 + 统计卡真实渲染，首轮 ≤3000ms', async () => {
  const { page, state, contentMs } = await openPage('#/agents', '#agent-grid .agent-card');
  try {
    const cards = await page.locator('#agent-grid .agent-card').count();
    assert.equal(cards, 4, `Agent 名册应 4 卡（lemate/winter/karina/codex），实际 ${cards}`);
    const names = (await page.locator('#agent-grid .agent-card').allInnerTexts()).join('|');
    for (const n of ['Lemate', 'Winter', 'Karina', 'Codex']) {
      assert.ok(names.includes(n), `名册应含 ${n}，实际：${names.slice(0, 160)}`);
    }
    // 统计卡存在且非空文本（.sc-num 有数字）
    const statNums = await page.locator('#agent-stats .stat-card .sc-num').allInnerTexts();
    assert.ok(statNums.length >= 3, `统计卡应 ≥3，实际 ${statNums.length}`);
    assert.ok(statNums.some((t) => /\d/.test(t)), `统计卡应有数字，实际 ${JSON.stringify(statNums)}`);

    // 实测：Agent 卡真实占位（宽>0 高>0），不是 display:none 的空壳
    const rect = await page.locator('#agent-grid .agent-card').first().evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { w: r.width, h: r.height, display: getComputedStyle(el).display };
    });
    assert.ok(rect.w > 100 && rect.h > 40, `Agent 卡应真实占位，实测 ${JSON.stringify(rect)}`);

    const ev = await evidence(page);
    assert.equal(ev.uiErrors, 0, `__uiErrors=${ev.uiErrors}：${state.pageErrors.join(' || ')}`);
    assert.equal(state.pageErrors.length, 0, state.pageErrors.join(' || '));
    assert.equal(state.consoleErrs.length, 0, state.consoleErrs.join(' || '));

    assert.ok(contentMs <= 3000, `Agents 首屏有效内容 ${contentMs}ms，应 ≤3000ms`);
    console.log(`[A2] contentMs=${contentMs} cards=${cards} cardRect=${JSON.stringify(rect)}`);
  } finally { await page.close(); }
});

test('A3 技能首屏：技能行/计数/分类 overlay 真实渲染，首轮 ≤3000ms', async () => {
  const { page, state, contentMs } = await openPage('#/skills', '#skill-list .skill-row');
  try {
    const rows = await page.locator('#skill-list .skill-row').count();
    assert.equal(rows, 6, `技能行应 6（夹具 12 条，S01 第 72 轮钉死页大小 6=2列×3行），实际 ${rows}`);
    const countText = await page.locator('#skill-count').innerText();
    assert.ok(/匹配\s*12\s*\/\s*12/.test(countText), `技能计数应为「匹配 12 / 12」，实际「${countText}」`);
    // skill-meta.json overlay：给 4 条分类，其余「未分类」——混合才证明合并逻辑真跑了
    const body = await page.locator('#skill-list').innerText();
    assert.ok(body.includes('类别 开发'), '应存在 overlay 分类「开发」（gstack-command）');
    assert.ok(body.includes('未分类'), '未 overlay 的技能应显示「未分类」');

    const ev = await evidence(page);
    assert.equal(ev.uiErrors, 0, `__uiErrors=${ev.uiErrors}：${state.pageErrors.join(' || ')}`);
    assert.equal(state.pageErrors.length, 0, state.pageErrors.join(' || '));
    assert.equal(state.consoleErrs.length, 0, state.consoleErrs.join(' || '));

    assert.ok(contentMs <= 3000, `技能首屏有效内容 ${contentMs}ms，应 ≤3000ms`);
    console.log(`[A3] contentMs=${contentMs} rows=${rows} count=${countText.trim()}`);
  } finally { await page.close(); }
});

test('A4 文件首屏：文件组按需求分组、计数为真实产物，首轮 ≤3000ms', async () => {
  const { page, state, contentMs } = await openPage('#/files', '#file-groups details.filegroup');
  try {
    const groups = await page.locator('#file-groups details.filegroup').count();
    assert.ok(groups >= 2, `有登记产物的需求组应 ≥2（夹具 T-G07A/T-G07B），实际 ${groups}`);
    const countText = await page.locator('#file-count').innerText();
    assert.match(countText, /匹配\s*\d+\s*\/\s*\d+\s*个产物/, `计数应含真实产物数，实际「${countText}」`);
    assert.ok(!countText.includes('—'), `计数不应是占位符「—」，实际「${countText}」`);

    // 实测：展开组内文件行可见且占位（.library-file 一行 64px）
    const firstRow = page.locator('#file-groups details.filegroup .library-file').first();
    await firstRow.waitFor({ timeout: 5000 });
    const rowRect = await firstRow.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { w: r.width, h: r.height };
    });
    assert.ok(rowRect.h >= 40 && rowRect.w > 200, `文件行应真实占位（64px 行高），实测 ${JSON.stringify(rowRect)}`);

    const ev = await evidence(page);
    assert.equal(ev.uiErrors, 0, `__uiErrors=${ev.uiErrors}：${state.pageErrors.join(' || ')}`);
    assert.equal(state.pageErrors.length, 0, state.pageErrors.join(' || '));
    assert.equal(state.consoleErrs.length, 0, state.consoleErrs.join(' || '));

    assert.ok(contentMs <= 3000, `文件首屏有效内容 ${contentMs}ms，应 ≤3000ms`);
    console.log(`[A4] contentMs=${contentMs} groups=${groups} count=${countText.trim()} rowRect=${JSON.stringify(rowRect)}`);
  } finally { await page.close(); }
});
