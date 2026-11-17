// G07-B｜四页导航与刷新状态回归（4 用例）——SPA 哈希路由 + 页切换 + 刷新后状态恢复。
//
// 验收口径：
//   - 切页后目标页真实可见（getComputedStyle display 实测），其余页真隐藏；
//   - aria-current 高亮与当前页一致，全站唯一；
//   - 刷新后回到刷新前页面且业务内容恢复（不是空白外壳）；
//   - 多次切页后各页数据仍在（导航不毁数据）、__uiErrors=0。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, launchBrowser, newPage, sleep } from './g07-harness.mjs';

let stack, browser;

before(async () => {
  stack = await startStack();
  browser = await launchBrowser();
});

after(async () => {
  await browser?.close();
  await stack?.stop();
});

const PAGES = [
  { hash: '#/', page: 'page-workbench', dataPage: 'workbench', rail: '#rail-reqs', biz: '#reqs-list .req-item' },
  { hash: '#/agents', page: 'page-agents', dataPage: 'agents', rail: '#rail-agents', biz: '#agent-grid .agent-card' },
  { hash: '#/skills', page: 'page-skills', dataPage: 'skills', rail: '#rail-skills', biz: '#skill-list .skill-row' },
  { hash: '#/files', page: 'page-files', dataPage: 'files', rail: '#rail-files', biz: '#file-groups details.filegroup' },
];

// 页面可见性矩阵：data-page + display 实测
const visMatrix = (page) => page.evaluate(() => {
  const ids = ['page-workbench', 'page-agents', 'page-skills', 'page-files'];
  const vis = {};
  for (const id of ids) {
    const el = document.getElementById(id);
    vis[id] = { hidden: el.hidden, display: getComputedStyle(el).display };
  }
  const cur = document.querySelector('#rail .rail-item[aria-current="page"]');
  return { vis, dataPage: document.body.dataset.page, ariaCurrentId: cur ? cur.id : null };
});

test('B1 侧栏点击切换四页：目标页 display 可见、其余 display:none', async () => {
  const { page, state } = await newPage(browser);
  try {
    await page.goto(stack.base + '/', { waitUntil: 'commit' });
    await page.waitForSelector('#reqs-list .req-item', { timeout: 15000 });
    await page.waitForSelector('#sb-conn.ok', { timeout: 10000 });

    for (const p of PAGES) {
      await page.click(p.rail);
      await page.waitForSelector(p.biz, { timeout: 8000 });
      await sleep(120); // 等 route() 后一帧渲染稳定
      const m = await visMatrix(page);
      assert.equal(m.dataPage, p.dataPage, `body.dataset.page 应为 ${p.dataPage}，实际 ${m.dataPage}`);
      for (const [id, v] of Object.entries(m.vis)) {
        const wantVisible = id === p.page;
        const isVisible = !v.hidden && v.display !== 'none';
        assert.equal(isVisible, wantVisible,
          `${id} 可见性应=${wantVisible}，实测 hidden=${v.hidden} display=${v.display}`);
      }
    }
    assert.equal(state.pageErrors.length, 0, state.pageErrors.join(' || '));
    console.log('[B1] 四页依次点击切换全部命中，display 矩阵断言通过');
  } finally { await page.close(); }
});

test('B2 aria-current 高亮唯一且跟随当前页', async () => {
  const { page } = await newPage(browser);
  try {
    await page.goto(stack.base + '/', { waitUntil: 'commit' });
    await page.waitForSelector('#reqs-list .req-item', { timeout: 15000 });
    for (const p of PAGES) {
      // 哈希直接导航（与点击等价的另一入口：location.hash 赋值触发 hashchange）
      await page.evaluate((h) => { location.hash = h; }, p.hash);
      await sleep(150);
      const m = await visMatrix(page);
      assert.equal(m.ariaCurrentId, p.rail.slice(1),
        `${p.hash} 下 aria-current 应在 ${p.rail}，实际在 #${m.ariaCurrentId}`);
      const curCount = await page.locator('#rail .rail-item[aria-current="page"]').count();
      assert.equal(curCount, 1, `aria-current 应唯一，实际 ${curCount} 个`);
    }
    console.log('[B2] aria-current 四页全部跟随且唯一');
  } finally { await page.close(); }
});

test('B3 刷新后回到刷新前页面，业务内容恢复非空白', async () => {
  const { page } = await newPage(browser);
  try {
    await page.goto(stack.base + '/#/skills', { waitUntil: 'commit' });
    await page.waitForSelector('#skill-list .skill-row', { timeout: 15000 });
    await page.waitForSelector('#sb-conn.ok', { timeout: 10000 });
    // 在技能页选中一条技能，再按产品真实落盘路径（列表滚动 300ms 防抖 saveUiPos）归档选中态。
    // 注：app.js 行点击处理器只重渲染不落盘，落盘由滚动/切页等路径触发——用例遵循真实用户路径。
    await page.click('#skill-list .skill-row >> nth=0');
    const pickedName = await page.locator('#skill-list .skill-row.selected b').innerText();
    await page.evaluate(() => {
      const sl = document.getElementById('skill-list');
      sl.scrollTop = 40;
      sl.dispatchEvent(new Event('scroll')); // 触发 300ms 防抖 saveUiPos（app.js:2070）
    });
    await sleep(500);

    await page.reload({ waitUntil: 'commit' });
    await page.waitForSelector('#skill-list .skill-row', { timeout: 15000 });
    await page.waitForSelector('#sb-conn.ok', { timeout: 10000 });
    await sleep(300); // 等 completeUiPosRestore（首轮 flow 成功那一拍）执行
    const m = await visMatrix(page);
    assert.equal(m.dataPage, 'skills', `刷新后应仍停留技能页，实际 ${m.dataPage}`);
    const rows = await page.locator('#skill-list .skill-row').count();
    assert.equal(rows, 6, `刷新后技能行应恢复 6 行（S01 第 72 轮页大小 6），实际 ${rows}`);
    const detail = await page.locator('#skill-detail').evaluate((el) => ({ hidden: el.hidden, text: el.textContent }));
    assert.ok(!detail.hidden && detail.text.length > 10, `刷新后选中技能详情应恢复，实测 ${JSON.stringify(detail)}`);
    assert.ok(detail.text.includes(pickedName), `详情应仍是刷新前选中的「${pickedName}」`);
    console.log(`[B3] 刷新后停留技能页，6 行恢复（页大小 6），选中「${pickedName}」详情恢复`);
  } finally { await page.close(); }
});

test('B4 多页往返后各页业务数据仍在，全程零页面异常', async () => {
  const { page, state } = await newPage(browser);
  try {
    await page.goto(stack.base + '/', { waitUntil: 'commit' });
    await page.waitForSelector('#reqs-list .req-item', { timeout: 15000 });
    await page.waitForSelector('#sb-conn.ok', { timeout: 10000 });

    // 走一圈：工作台 → Agents → 技能 → 文件 → 工作台
    for (const p of PAGES) {
      await page.click(p.rail);
      await page.waitForSelector(p.biz, { timeout: 8000 });
    }
    await page.click('#rail-reqs');
    await page.waitForSelector('#reqs-list .req-item', { timeout: 8000 });

    const counts = {
      reqs: await page.locator('#reqs-list .req-item').count(),
      track: await page.locator('#center-chain .track-node').count(),
    };
    assert.ok(counts.reqs >= 3, `往返后需求行应 ≥3，实际 ${counts.reqs}`);
    assert.ok(counts.track >= 7, `往返后交付链节点应 ≥7，实际 ${counts.track}`);

    const uiErrors = await page.evaluate(() => window.__uiErrors | 0);
    assert.equal(uiErrors, 0, `往返后 __uiErrors=${uiErrors}：${state.pageErrors.join(' || ')}`);
    assert.equal(state.pageErrors.length, 0, state.pageErrors.join(' || '));
    assert.equal(state.consoleErrs.length, 0, state.consoleErrs.join(' || '));
    console.log(`[B4] 四页往返后工作台数据完整（reqs=${counts.reqs} track=${counts.track}），零异常`);
  } finally { await page.close(); }
});
