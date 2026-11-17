// G07-R72｜第 72 轮新增回归：4 个关键布局检查（L1-L4）+ 2 个静默降级故障注入（E1-E2）。
//
// 与既有用例的关系（G03 要求 ≥16 场景 = 4 初始化 + 4 布局 + 4 审批版本 + 4 错误恢复）：
//   - 4 初始化 = g07-pages A1-A4（已有）
//   - 4 审批版本 = g07-approval D1-D4（已有）
//   - 4 错误恢复 = g07-recovery C1-C4（已有，API 500/非JSON/503/全中断）
//   - 4 布局 = 本文件 L1-L4（本轮补齐，computed style + getBoundingClientRect 实测）
//   - E1/E2 = 本文件新增 G02 场景（CSS 404 / JS 模块 404 不得静默裸奔），超额覆盖。
//
// 取证口径：1440×900 基线 + 1280×768 复测；尺寸断言误差 ≤1px（任务书 G03 原文）。
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

async function open(hash, selector, timeout = 15000) {
  const { page, state } = await newPage(browser);
  await page.goto(stack.base + '/' + hash, { waitUntil: 'commit' });
  await page.waitForSelector(selector, { timeout });
  return { page, state };
}

// R72·G01 规格值（任务书钉死）：rail 56 / reqs 248 / insp 328 / topbar 52 / statusbar 56
const REGIONS = [
  ['#rail', 'width', 56],
  ['#topbar', 'height', 52],
  ['#statusbar', 'height', 56],
];

test('L1 工作台布局：五区尺寸误差 ≤1px，正文 13px/20px，底色 #0D111A（1440×900 + 1280×768）', async () => {
  const { page } = await open('#/', '#reqs-list .req-item');
  try {
    const m = await page.evaluate(() => {
      const r = (sel) => document.querySelector(sel)?.getBoundingClientRect();
      const cs = (sel) => getComputedStyle(document.querySelector(sel));
      return {
        rail: r('#rail'), topbar: r('#topbar'), statusbar: r('#statusbar'),
        reqs: r('#reqs'), inspW: cs('#inspector').width,
        font: cs('body').fontSize, lh: cs('body').lineHeight, bg: cs('body').backgroundColor,
        fontVar: cs('body').fontFamily,
      };
    });
    // reqs/inspector 可能带 transform 平移出屏，但 width 不受 transform 影响
    assert.ok(Math.abs(m.rail.width - 56) <= 1, `rail 宽 ${m.rail.width} ≠56±1`);
    assert.ok(Math.abs(m.topbar.height - 52) <= 1, `topbar 高 ${m.topbar.height} ≠52±1`);
    assert.ok(Math.abs(m.statusbar.height - 56) <= 1, `statusbar 高 ${m.statusbar.height} ≠56±1`);
    assert.ok(Math.abs(m.reqs.width - 248) <= 1, `reqs 宽 ${m.reqs.width} ≠248±1`);
    assert.ok(Math.abs(parseFloat(m.inspW) - 328) <= 1, `inspector 宽 ${m.inspW} ≠328±1`);
    assert.equal(m.font, '13px');
    assert.equal(m.lh, '20px');
    assert.equal(m.bg, 'rgb(13, 17, 26)', `body 底色实测 ${m.bg}（#0D111A）`);
    console.log(`[L1@1440] rail=${m.rail.width} topbar=${m.topbar.height} statusbar=${m.statusbar.height} reqs=${m.reqs.width} insp=${m.inspW} font=${m.font}/${m.lh} bg=${m.bg}`);

    // 1280×768 复测：固定尺寸不随视口漂移，且无横向溢出
    await page.setViewportSize({ width: 1280, height: 768 });
    await page.waitForTimeout(300);
    const m2 = await page.evaluate(() => ({
      rail: document.querySelector('#rail').getBoundingClientRect().width,
      reqs: document.querySelector('#reqs').getBoundingClientRect().width,
      inspW: getComputedStyle(document.querySelector('#inspector')).width,
      overflowX: document.documentElement.scrollWidth,
    }));
    assert.ok(Math.abs(m2.rail - 56) <= 1 && Math.abs(m2.reqs - 248) <= 1 && Math.abs(parseFloat(m2.inspW) - 328) <= 1,
      `1280×768 下固定区漂移：rail=${m2.rail} reqs=${m2.reqs} insp=${m2.inspW}`);
    assert.ok(m2.overflowX <= 1280, `1280 视口横向溢出 ${m2.overflowX}px`);
    console.log(`[L1@1280] rail=${m2.rail} reqs=${m2.reqs} insp=${m2.inspW} overflowX=${m2.overflowX}`);
  } finally { await page.close(); }
});

test('L2 Agents 布局：头像 44×44 ±1px · 行 ≥74px/内边距 8px·16px · 名称 14px/20px（双视口）', async () => {
  const { page } = await open('#/agents', '#agent-grid .agent-card');
  try {
    const m = await page.evaluate(() => {
      const avas = [...document.querySelectorAll('#agent-grid .agent-avatar')];
      const row = document.querySelector('#agent-grid .agent-select');
      const cs = getComputedStyle(row);
      const name = getComputedStyle(document.querySelector('.ag-idcol .agent-name'));
      const role = getComputedStyle(document.querySelector('.ag-idcol .agent-role'));
      return {
        avaRects: avas.map((i) => ({ w: i.getBoundingClientRect().width, h: i.getBoundingClientRect().height })),
        avaFit: avas.length ? getComputedStyle(avas[0]).objectFit : null,
        rowMinH: cs.minHeight, rowPad: cs.paddingTop + '/' + cs.paddingLeft,
        nameFont: name.fontSize + '/' + name.lineHeight,
        roleFont: role.fontSize + '/' + role.lineHeight,
        cards: document.querySelectorAll('#agent-grid .agent-card').length,
        overflowX: document.documentElement.scrollWidth,
      };
    });
    assert.ok(m.cards >= 3, `Agent 卡应 ≥3（夹具 4 角色），实际 ${m.cards}`);
    assert.equal(m.avaFit, 'cover', `object-fit 实测 ${m.avaFit}`);
    for (const [i, r] of m.avaRects.entries()) {
      assert.ok(Math.abs(r.w - 44) <= 1 && Math.abs(r.h - 44) <= 1,
        `第 ${i + 1} 个头像 ${r.w}×${r.h} ≠44±1`);
    }
    assert.ok(parseFloat(m.rowMinH) >= 74, `行 min-height ${m.rowMinH} <74px`);
    assert.equal(m.rowPad, '8px/16px', `行内边距实测 ${m.rowPad}（规格 上下8/左右16）`);
    assert.equal(m.nameFont, '14px/20px', `名称字号实测 ${m.nameFont}`);
    assert.equal(m.roleFont, '12px/18px', `辅助文字实测 ${m.roleFont}`);
    console.log(`[L2@1440] cards=${m.cards} ava=${m.avaRects[0].w}×${m.avaRects[0].h} fit=${m.avaFit} row=${m.rowMinH}/${m.rowPad} name=${m.nameFont} role=${m.roleFont}`);

    await page.setViewportSize({ width: 1280, height: 768 });
    await page.waitForTimeout(300);
    const m2 = await page.evaluate(() => ({
      ava: [...document.querySelectorAll('#agent-grid .agent-avatar')].map((i) => i.getBoundingClientRect().width),
      overflowX: document.documentElement.scrollWidth,
    }));
    for (const [i, w] of m2.ava.entries()) {
      assert.ok(Math.abs(w - 44) <= 1, `1280×768 第 ${i + 1} 个头像宽 ${w} ≠44±1`);
    }
    assert.ok(m2.overflowX <= 1280, `1280 视口横向溢出 ${m2.overflowX}px`);
    console.log(`[L2@1280] ava=${m2.ava.join(',')} overflowX=${m2.overflowX}`);
  } finally { await page.close(); }
});

test('L3 技能卡网格：双列·间距16·min-height 144·#182230·圆角10·首页 6 张（2×3）·筛选 34px', async () => {
  const { page } = await open('#/skills', '#skill-list .skill-row');
  try {
    const m = await page.evaluate(() => {
      const list = document.querySelector('#skill-list');
      const lcs = getComputedStyle(list);
      const card = document.querySelector('#skill-list .skill-row');
      const ccs = getComputedStyle(card);
      const b = ccs ? getComputedStyle(card.querySelector('b')) : null;
      const small = ccs ? getComputedStyle(card.querySelector('small')) : null;
      const tag = card?.querySelector('.sk-tag, .sk-cat');
      const chip = document.querySelector('.chip-row button');
      const rects = [...document.querySelectorAll('#skill-list .skill-row')].slice(0, 2)
        .map((el) => el.getBoundingClientRect());
      return {
        cols: lcs.gridTemplateColumns, colGap: lcs.columnGap, rowGap: lcs.rowGap,
        cards: document.querySelectorAll('#skill-list .skill-row').length,
        minH: ccs.minHeight, pad: ccs.padding, radius: ccs.borderRadius, bg: ccs.backgroundColor,
        nameFont: b ? b.fontSize + '/' + b.lineHeight : null,
        descFont: small ? small.fontSize + '/' + small.lineHeight : null,
        descClamp: small ? small.webkitLineClamp : null,
        tagFont: tag ? getComputedStyle(tag).fontSize + '/' + getComputedStyle(tag).lineHeight : null,
        chipH: chip ? getComputedStyle(chip).height : null,
        pageW: document.querySelector('#page-skills').getBoundingClientRect().width,
        pagText: document.querySelector('#skill-pagination')?.textContent.trim(),
        gap12: rects.length === 2 ? rects[1].left - rects[0].right : null,
        overflowX: document.documentElement.scrollWidth,
      };
    });
    assert.equal(m.cards, 6, `首页应恰好 6 张卡（2×3），实际 ${m.cards}`);
    assert.equal(m.cols.split(' ').length, 2, `双列网格实测 ${m.cols}`);
    assert.equal(m.colGap, '16px', `列间距 ${m.colGap}`);
    assert.equal(m.rowGap, '16px', `行间距 ${m.rowGap}`);
    if (m.gap12 != null) assert.ok(Math.abs(m.gap12 - 16) <= 1, `相邻卡实测间距 ${m.gap12} ≠16±1`);
    assert.ok(parseFloat(m.minH) >= 144, `卡 min-height ${m.minH} <144px`);
    assert.equal(m.pad, '16px', `卡内边距实测 ${m.pad}`);
    assert.equal(m.radius, '10px', `卡圆角实测 ${m.radius}`);
    assert.equal(m.bg, 'rgb(24, 34, 48)', `卡底色实测 ${m.bg}（#182230）`);
    assert.equal(m.nameFont, '14px/20px', `名称 ${m.nameFont}`);
    assert.equal(m.descFont, '12px/18px', `描述 ${m.descFont}`);
    assert.equal(m.descClamp, '3', `描述行数上限实测 ${m.descClamp}`);
    assert.equal(m.tagFont, '11px/16px', `来源标签 ${m.tagFont}`);
    assert.equal(m.chipH, '34px', `筛选项高实测 ${m.chipH}`);
    assert.ok(Math.abs(m.pageW - 1136) <= 1, `列表容器宽 ${m.pageW} ≠1136±1`);
    assert.ok(/第 1 \/ \d+ 页/.test(m.pagText || ''), `分页文本实测「${m.pagText}」`);
    assert.ok(m.overflowX <= 1440, `横向溢出 ${m.overflowX}px`);
    console.log(`[L3@1440] cards=${m.cards} cols=${m.cols} gap=${m.colGap}/${m.rowGap}(实测${m.gap12}) minH=${m.minH} pad=${m.pad} r=${m.radius} bg=${m.bg} name=${m.nameFont} desc=${m.descFont}×${m.descClamp} tag=${m.tagFont} chip=${m.chipH} pageW=${m.pageW} 分页「${m.pagText}」`);

    // 筛选变更后布局不变（任务书：筛选条件改变后卡片仍保持相同布局）
    await page.click('.chip-row button:nth-child(2)');
    await page.waitForTimeout(400);
    const m2 = await page.evaluate(() => ({
      cols: getComputedStyle(document.querySelector('#skill-list')).gridTemplateColumns,
      cards: document.querySelectorAll('#skill-list .skill-row').length,
    }));
    assert.equal(m2.cols.split(' ').length, 2, `筛选后仍应双列，实测 ${m2.cols}`);
    assert.ok(m2.cards >= 1 && m2.cards <= 6, `筛选后首页卡数 ${m2.cards} 应在 1..6`);
    console.log(`[L3@筛选后] cols=${m2.cols} cards=${m2.cards}`);

    // 1280×768 复测（G03 双视口基线）：重置筛选回「全部」，固定双列不随视口重排、容器不溢出
    await page.click('.chip-row button:nth-child(1)');
    await page.waitForTimeout(400);
    await page.setViewportSize({ width: 1280, height: 768 });
    await page.waitForTimeout(150);
    const m3 = await page.evaluate(() => ({
      cols: getComputedStyle(document.querySelector('#skill-list')).gridTemplateColumns,
      cards: document.querySelectorAll('#skill-list .skill-row').length,
      pageW: document.querySelector('#page-skills').getBoundingClientRect().width,
      overflowX: document.documentElement.scrollWidth,
    }));
    assert.equal(m3.cols.split(' ').length, 2, `1280 下仍应双列，实测 ${m3.cols}`);
    assert.equal(m3.cards, 6, `1280 下首页仍应 6 张卡，实际 ${m3.cards}`);
    assert.ok(Math.abs(m3.pageW - 1136) <= 1, `1280 下容器宽 ${m3.pageW} ≠1136±1（max-width 钉死不漂移）`);
    assert.ok(m3.overflowX <= 1280, `1280 视口横向溢出 ${m3.overflowX}px`);
    console.log(`[L3@1280] cols=${m3.cols} cards=${m3.cards} pageW=${m3.pageW} overflowX=${m3.overflowX}`);
  } finally { await page.close(); }
});

test('L4 文件行三列：信息自适应 / 版本 220px / 操作 144px（R73/F02 由 136 调宽）· 行 ≥84px·内边距16 · 组卡 #111823·圆角10', async () => {
  const { page } = await open('#/files', '#file-groups .filegroup');
  try {
    const m = await page.evaluate(() => {
      const row = document.querySelector('#file-groups .library-file');
      const cs = getComputedStyle(row);
      const g = document.querySelector('#file-groups .filegroup');
      const gcs = getComputedStyle(g);
      const name = row.querySelector('.lf-name');
      const src = row.querySelector('.lf-src');
      return {
        cols: cs.gridTemplateColumns.split(' '),
        minH: cs.minHeight, pad: cs.paddingTop, gap: cs.columnGap,
        nameFont: name ? getComputedStyle(name).fontSize + '/' + getComputedStyle(name).lineHeight : null,
        srcFont: src ? getComputedStyle(src).fontSize + '/' + getComputedStyle(src).lineHeight
          + '/' + getComputedStyle(src).whiteSpace + '/' + getComputedStyle(src).textOverflow : null,
        gBg: gcs.backgroundColor, gRadius: gcs.borderRadius, gBorder: gcs.borderTopWidth + ' ' + gcs.borderTopStyle + ' ' + gcs.borderTopColor,
        groups: document.querySelectorAll('#file-groups .filegroup').length,
        rows: document.querySelectorAll('#file-groups .library-file').length,
        overflowX: document.documentElement.scrollWidth,
      };
    });
    assert.equal(m.cols.length, 3, `文件行应为三列，实测 ${m.cols.join(' ')}`);
    assert.equal(m.cols[1], '220px', `版本列宽实测 ${m.cols[1]} ≠220px`);
    assert.equal(m.cols[2], '144px', `操作列宽实测 ${m.cols[2]} ≠144px（R73/F02 规格值）`);
    assert.ok(parseFloat(m.minH) >= 84, `行 min-height ${m.minH} <84px`);
    assert.equal(m.pad, '16px', `行内边距实测 ${m.pad}`);
    assert.equal(m.gap, '16px', `列间距实测 ${m.gap}`);
    assert.equal(m.nameFont, '13px/20px', `文件名字号实测 ${m.nameFont}`);
    assert.ok((m.srcFont || '').startsWith('11px/16px/nowrap/ellipsis'), `路径列实测 ${m.srcFont}`);
    assert.equal(m.gBg, 'rgb(17, 24, 35)', `组卡底色实测 ${m.gBg}（#111823）`);
    assert.equal(m.gRadius, '10px', `组卡圆角实测 ${m.gRadius}`);
    assert.equal(m.gBorder, '1px solid rgb(51, 65, 85)', `组卡边框实测 ${m.gBorder}（#334155）`);
    assert.ok(m.overflowX <= 1440, `横向溢出 ${m.overflowX}px`);
    console.log(`[L4@1440] groups=${m.groups} rows=${m.rows} cols=${m.cols.join('|')} minH=${m.minH} pad=${m.pad} name=${m.nameFont} src=${m.srcFont} 组卡=${m.gBg}/r${m.gRadius}/${m.gBorder}`);

    await page.setViewportSize({ width: 1280, height: 768 });
    await page.waitForTimeout(300);
    const m2 = await page.evaluate(() => ({
      cols: getComputedStyle(document.querySelector('#file-groups .library-file')).gridTemplateColumns.split(' '),
      overflowX: document.documentElement.scrollWidth,
    }));
    assert.equal(m2.cols[1], '220px', `1280 下版本列 ${m2.cols[1]} ≠220px`);
    assert.equal(m2.cols[2], '144px', `1280 下操作列 ${m2.cols[2]} ≠144px（R73/F02 规格值）`);
    assert.ok(m2.overflowX <= 1280, `1280 视口横向溢出 ${m2.overflowX}px`);
    console.log(`[L4@1280] cols=${m2.cols.join('|')} overflowX=${m2.overflowX}`);
  } finally { await page.close(); }
});

test('E1 CSS 404 故障注入：主样式表被拦 → 琥珀失败横幅点名文件，不静默裸奔；布局检查随之失败（闭环）', async () => {
  const { page } = await newPage(browser);
  // 拦截主样式表 → 404（模拟本轮事故根因：旧进程白名单缺 CSS）
  await page.route('**/app-base.css', (route) => route.fulfill({ status: 404, body: 'gone' }));
  try {
    await page.goto(stack.base + '/#/', { waitUntil: 'load' });
    await page.waitForFunction(() => {
      const el = document.getElementById('data-banner');
      return el && !el.hidden && el.textContent.includes('样式表加载失败');
    }, null, { timeout: 10000 });
    const m = await page.evaluate(() => {
      const el = document.getElementById('data-banner');
      const cs = getComputedStyle(el);
      return {
        text: el.textContent.slice(0, 160),
        bg: cs.backgroundColor, color: cs.color, font: cs.fontSize + '/' + cs.lineHeight, pad: cs.padding,
        railW: document.querySelector('#rail')?.getBoundingClientRect().width ?? null,
      };
    });
    assert.ok(m.text.includes('app-base.css'), `横幅应点名失败文件，实测「${m.text}」`);
    assert.equal(m.bg, 'rgb(59, 48, 33)', `失败态底色实测 ${m.bg}（#3B3021）`);
    assert.equal(m.color, 'rgb(229, 185, 94)', `失败态文字实测 ${m.color}（#E5B95E）`);
    assert.equal(m.font, '13px/20px', `失败态字号实测 ${m.font}`);
    assert.ok(m.pad.includes('16px'), `失败态内边距实测 ${m.pad}`);
    // G03 闭环：主 CSS 缺失时布局必然崩坏 → L1 的 rail 断言在此场景必失败（rail ≠56±1）
    assert.ok(m.railW == null || Math.abs(m.railW - 56) > 1,
      `CSS 缺失下 rail 宽 ${m.railW} 应偏离 56px（否则视觉回归测不出 CSS 丢失）`);
    console.log(`[E1] 横幅「${m.text.slice(0, 80)}…」 bg=${m.bg} color=${m.color} font=${m.font} rail=${m.railW}`);
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await page.close();
  }
});

test('E2 JS 模块 404 故障注入：files.js 被拦 → 启动护栏横幅点名缺失模块，页面不留白壳', async () => {
  const { page } = await newPage(browser);
  await page.route('**/files.js', (route) => route.fulfill({ status: 404, body: 'gone' }));
  try {
    await page.goto(stack.base + '/#/', { waitUntil: 'load' });
    await page.waitForFunction(() => {
      const el = document.getElementById('data-banner');
      return el && !el.hidden && el.textContent.includes('前端模块加载不完整');
    }, null, { timeout: 10000 });
    const m = await page.evaluate(() => {
      const el = document.getElementById('data-banner');
      return { text: el.textContent.slice(0, 160), cls: el.className, hasRetry: !!el.querySelector('button') };
    });
    assert.ok(m.text.includes('files.js') && m.text.includes('renderFiles'),
      `横幅应点名 files.js 缺 renderFiles，实测「${m.text}」`);
    assert.ok(m.cls.includes('boot-fail'), `横幅应挂 boot-fail 类，实测 ${m.cls}`);
    assert.ok(m.hasRetry, '失败态应带「重试 / 刷新页面」按钮');
    console.log(`[E2] 横幅「${m.text.slice(0, 90)}…」 cls=${m.cls} retry=${m.hasRetry}`);
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await page.close();
  }
});
