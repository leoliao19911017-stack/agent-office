// G07-B｜四页导航与刷新状态回归（4 用例）——SPA 哈希路由 + 页切换 + 刷新后状态恢复。
// TASK-工作台重做：一级页从 旧四页（工作台/Agents/技能/文件）换成
// 我的任务 #/（驾驶舱）/ 干活记录 #/log / 设置 #/settings（含 agents/skills/files 页签）
// / 专业视图 #/pro（原三栏工作台）。导航矩阵按新四页断言，强度不降：
//   - 切页后目标页真实可见（getComputedStyle display 实测），其余页真隐藏；
//   - 设置页还多断一层：四个分区页签（常用/Agents/技能/文件）里只有当前页签可见；
//   - 旧链接 #/agents #/skills #/files 不作废——折算成设置页签再跳，redirect 契约也在断言里；
//   - aria-current 高亮与当前页一致，全站唯一；
//   - 刷新后回到刷新前页面（含设置页里的子页签）且业务内容恢复（不是空白外壳）；
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
  { hash: '#/', page: 'page-home', dataPage: 'home', rail: '#rail-home', biz: '#cabin-tasks .cabin-task' },
  { hash: '#/log', page: 'page-log', dataPage: 'log', rail: '#rail-log', biz: '#log-body .log-headline' },
  { hash: '#/settings', page: 'page-settings', dataPage: 'settings', rail: '#rail-settings', biz: '#set-general .set-card', sub: 'general' },
  { hash: '#/pro', page: 'page-workbench', dataPage: 'workbench', rail: '#rail-pro', biz: '#reqs-list .req-item' },
];

// 设置页内部的四个分区页签（旧 Agents/技能/文件 三页的新住处）→ DOM id
const MODULES = { general: 'set-general', agents: 'page-agents', skills: 'page-skills', files: 'page-files' };

// 页面可见性矩阵：data-page + display 实测；设置页连带页签矩阵 + 当前页签
const visMatrix = (page) => page.evaluate(() => {
  const ids = ['page-home', 'page-log', 'page-settings', 'page-workbench'];
  const vis = {};
  for (const id of ids) {
    const el = document.getElementById(id);
    vis[id] = { hidden: el.hidden, display: getComputedStyle(el).display };
  }
  const tabIds = ['set-general', 'page-agents', 'page-skills', 'page-files'];
  const tabs = {};
  for (const id of tabIds) {
    const el = document.getElementById(id);
    tabs[id] = { hidden: el.hidden, display: getComputedStyle(el).display };
  }
  const onTab = document.querySelector('#page-settings .set-tabs [data-settab].on');
  const cur = document.querySelector('#rail .rail-item[aria-current="page"]');
  return {
    vis, tabs,
    setTab: onTab ? onTab.dataset.settab : null,
    dataPage: document.body.dataset.page,
    ariaCurrentId: cur ? cur.id : null,
  };
});

test('B1 侧栏点击切换四页：目标页 display 可见、其余 display:none', async () => {
  const { page, state } = await newPage(browser);
  try {
    await page.goto(stack.base + '/', { waitUntil: 'commit' });
    await page.waitForSelector('#cabin-tasks .cabin-task', { timeout: 15000 });
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
      // 设置页加一层页签矩阵：四个分区里只有当前页签可见（页签化不等于内容混住）
      if (p.sub) {
        assert.equal(m.setTab, p.sub, `设置页当前页签应为 ${p.sub}，实际 ${m.setTab}`);
        for (const [sub, id] of Object.entries(MODULES)) {
          const wantVisible = sub === p.sub;
          const v = m.tabs[id];
          const isVisible = !v.hidden && v.display !== 'none';
          assert.equal(isVisible, wantVisible,
            `设置页签 ${id} 可见性应=${wantVisible}，实测 hidden=${v.hidden} display=${v.display}`);
        }
      }
    }
    assert.equal(state.pageErrors.length, 0, state.pageErrors.join(' || '));
    console.log('[B1] 新四页依次点击切换全部命中，display + 设置页签矩阵断言通过');
  } finally { await page.close(); }
});

test('B2 aria-current 高亮唯一且跟随当前页（旧链接折算设置页签）', async () => {
  const { page } = await newPage(browser);
  try {
    await page.goto(stack.base + '/', { waitUntil: 'commit' });
    await page.waitForSelector('#cabin-tasks .cabin-task', { timeout: 15000 });
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
    // 旧链接不作废契约：#/agents 折算成设置页 agents 页签再跳，
    // aria-current 归属设置主导航，agents 内容真实可见
    await page.evaluate(() => { location.hash = '/agents'; });
    await page.waitForSelector('#agent-grid .agent-card', { timeout: 8000 });
    const m = await visMatrix(page);
    assert.equal(m.dataPage, 'settings', `#/agents 应折算到设置页，实际 ${m.dataPage}`);
    assert.equal(m.setTab, 'agents', `#/agents 应落在 agents 页签，实际 ${m.setTab}`);
    assert.equal(m.ariaCurrentId, 'rail-settings', `#/agents 下 aria-current 应在 #rail-settings，实际在 #${m.ariaCurrentId}`);
    console.log('[B2] aria-current 新四页全部跟随且唯一；旧链接 #/agents→设置页·agents 页签契约成立');
  } finally { await page.close(); }
});

test('B3 刷新后回到刷新前页面，业务内容恢复非空白', async () => {
  const { page } = await newPage(browser);
  try {
    // 旧链接 #/skills 是真实用户入口：折算成设置页 skills 页签（URL 变 #/settings）
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
      sl.dispatchEvent(new Event('scroll')); // 触发 300ms 防抖 saveUiPos
    });
    await sleep(500);

    await page.reload({ waitUntil: 'commit' });
    await page.waitForSelector('#skill-list .skill-row', { timeout: 15000 });
    await page.waitForSelector('#sb-conn.ok', { timeout: 10000 });
    await sleep(300); // 等 completeUiPosRestore（首轮 flow 成功那一拍）执行
    const m = await visMatrix(page);
    // TASK-工作台重做：技能页现在是设置页的页签——刷新后应停在设置页 + skills 页签
    assert.equal(m.dataPage, 'settings', `刷新后应仍停留设置页，实际 ${m.dataPage}`);
    assert.equal(m.setTab, 'skills', `刷新后应恢复 skills 页签，实际 ${m.setTab}`);
    const skillsVis = m.tabs['page-skills'];
    assert.ok(!skillsVis.hidden && skillsVis.display !== 'none',
      `刷新后技能分区应可见，实测 hidden=${skillsVis.hidden} display=${skillsVis.display}`);
    for (const [sub, id] of Object.entries(MODULES)) {
      if (sub === 'skills') continue;
      const v = m.tabs[id];
      assert.ok(v.hidden || v.display === 'none',
        `刷新后其余分区应隐藏（${id}），实测 hidden=${v.hidden} display=${v.display}`);
    }
    const rows = await page.locator('#skill-list .skill-row').count();
    assert.equal(rows, 6, `刷新后技能行应恢复 6 行（S01 第 72 轮页大小 6），实际 ${rows}`);
    const detail = await page.locator('#skill-detail').evaluate((el) => ({ hidden: el.hidden, text: el.textContent }));
    assert.ok(!detail.hidden && detail.text.length > 10, `刷新后选中技能详情应恢复，实测 ${JSON.stringify(detail)}`);
    assert.ok(detail.text.includes(pickedName), `详情应仍是刷新前选中的「${pickedName}」`);
    console.log(`[B3] 刷新后停留设置页·skills 页签，6 行恢复（页大小 6），选中「${pickedName}」详情恢复`);
  } finally { await page.close(); }
});

test('B4 多页往返后各页业务数据仍在，全程零页面异常', async () => {
  const { page, state } = await newPage(browser);
  try {
    await page.goto(stack.base + '/', { waitUntil: 'commit' });
    await page.waitForSelector('#cabin-tasks .cabin-task', { timeout: 15000 });
    await page.waitForSelector('#sb-conn.ok', { timeout: 10000 });

    // 走一圈：我的任务 → 干活记录 → 设置 → 专业视图，再回首页、进专业视图
    for (const p of PAGES) {
      await page.click(p.rail);
      await page.waitForSelector(p.biz, { timeout: 8000 });
    }
    await page.click('#rail-home');
    await page.waitForSelector('#cabin-tasks .cabin-task', { timeout: 8000 });
    await page.click('#rail-pro');
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
    console.log(`[B4] 四页往返后专业视图数据完整（reqs=${counts.reqs} track=${counts.track}），零异常`);
  } finally { await page.close(); }
});
