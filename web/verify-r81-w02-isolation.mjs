// verify-r81-w02-isolation.mjs — 第 81 轮 W02 补测（一次性实测，不进回归套件）：
//   ① 右栏 328px、正文容器独立滚动到底时，左侧需求列表与中间流程区坐标是否纹丝不动（≤1px）；
//   ② 切换步骤再切回，正文滚动位置是否保持。
// 口径：复用 test/g07-harness.mjs 隔离栈（stub 中台 + 临时 HOME + 真实 server.js），
//       1440×900 视口，输出实测差值并落 verify-assets/r81/w02-isolation.json。
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROOT, startStack, launchBrowser, newPage, sleep, REAL_FILE, realFileMeta,
} from '../test/g07-harness.mjs';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'verify-assets', 'r81');
mkdirSync(OUT_DIR, { recursive: true });

const iso = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString();
const unit = '审批详情长文验收：正文按 12px/20px 排版，段落随内容滚动，固定操作区不遮挡末行。';
const longNote = (n) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
const rf = realFileMeta();

const task = {
  id: 'T-W02ISO', title: 'R81-W02 滚动隔离实测', createdAt: iso(90), updatedAt: iso(3),
  steps: {
    req: { status: 'done', at: iso(85), note: 'R81 任务书', by: 'leo' },
    doc: { status: 'done', at: iso(80), note: '', by: 'lemate' },
    plan: { status: 'done', at: iso(75), note: 'R81 计划', by: 'lemate' },
    brief: { status: 'done', at: iso(70), note: '', by: 'lemate' },
    deliverable: { status: 'done', at: iso(30), note: '登记真实文件', by: 'lemate',
      files: [{ path: REAL_FILE, ...rf }] },
    verify: { status: 'awaiting', at: iso(5), note: longNote(3000), by: 'hermes' },
    final: { status: 'pending', at: null, note: '', by: null },
  },
};

const rect = (sel) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, w: r.width, h: r.height, scrollTop: el.scrollTop };
})()`;

const stack = await startStack([task]);
const browser = await launchBrowser();
const { page, state } = await newPage(browser);
const result = { viewport: '1440x900', at: new Date().toISOString(), steps: [] };
try {
  await page.goto(stack.base + '/', { waitUntil: 'commit' });
  await page.waitForSelector('.req-item[data-task="T-W02ISO"]', { timeout: 15000 });
  await page.click('.req-item[data-task="T-W02ISO"]');
  await page.waitForSelector('#center-chain .track-node[data-step="verify"]', { timeout: 8000 });
  await page.click('#center-chain .track-node[data-step="verify"]');
  await page.waitForSelector('#insp-body .ip-note', { timeout: 8000 });

  // —— ① 独立滚动隔离：滚到底前后，左列表 / 中栏坐标差 ——
  const inspW = await page.evaluate(() => document.getElementById('inspector').getBoundingClientRect().width);
  const bodyMeta = await page.evaluate(() => {
    const b = document.getElementById('insp-body');
    return { scrollHeight: b.scrollHeight, clientHeight: b.clientHeight,
      overflowY: getComputedStyle(b).overflowY, minHeight: getComputedStyle(b).minHeight };
  });
  const before = {
    center: await page.evaluate(rect('#center-chain')),
    reqs: await page.evaluate(rect('#reqs-list')),
    firstItem: await page.evaluate(rect('#reqs-list .req-item')),
  };
  await page.evaluate(() => { document.getElementById('insp-body').scrollTop = 1e9; });
  await sleep(120);
  const after = {
    center: await page.evaluate(rect('#center-chain')),
    reqs: await page.evaluate(rect('#reqs-list')),
    firstItem: await page.evaluate(rect('#reqs-list .req-item')),
  };
  const dCenter = Math.abs(after.center.top - before.center.top);
  const dReqs = Math.abs(after.reqs.scrollTop - before.reqs.scrollTop);
  const dItem = Math.abs(after.firstItem.top - before.firstItem.top);
  const scrolled = await page.evaluate(() => document.getElementById('insp-body').scrollTop);
  result.steps.push({
    what: '右栏宽度/正文容器',
    inspWidthPx: inspW, bodyOverflowY: bodyMeta.overflowY, bodyMinHeight: bodyMeta.minHeight,
    scrollablePx: bodyMeta.scrollHeight - bodyMeta.clientHeight,
  });
  result.steps.push({
    what: '正文滚到底 → 左列表/中栏坐标变化',
    centerTopBefore: before.center.top, centerTopAfter: after.center.top, deltaCenterPx: dCenter,
    reqsScrollBefore: before.reqs.scrollTop, reqsScrollAfter: after.reqs.scrollTop, deltaReqsScrollPx: dReqs,
    firstItemTopBefore: before.firstItem.top, firstItemTopAfter: after.firstItem.top, deltaFirstItemPx: dItem,
    bodyScrolledTo: scrolled,
    pass: dCenter <= 1 && dReqs <= 1 && dItem <= 1,
  });
  console.log(`[W02-①] 右栏 ${inspW}px · 可滚 ${bodyMeta.scrollHeight - bodyMeta.clientHeight}px · ` +
    `中栏Δ${dCenter.toFixed(2)}px 左列表Δ${dReqs.toFixed(2)}px 首项Δ${dItem.toFixed(2)}px ` +
    `${dCenter <= 1 && dReqs <= 1 && dItem <= 1 ? '✅' : '❌'}`);

  // —— ② 步骤切换再切回：滚动位置保持 ——
  await page.evaluate(() => { document.getElementById('insp-body').scrollTop = Math.floor(document.getElementById('insp-body').scrollHeight / 2); });
  await sleep(80);
  const kept = await page.evaluate(() => document.getElementById('insp-body').scrollTop);
  await page.click('#center-chain .track-node[data-step="plan"]');
  await page.waitForSelector('#insp-body', { timeout: 8000 });
  await sleep(250);
  await page.click('#center-chain .track-node[data-step="verify"]');
  await page.waitForSelector('#insp-body .ip-note', { timeout: 8000 });
  await sleep(250);
  const restored = await page.evaluate(() => document.getElementById('insp-body').scrollTop);
  const dKeep = Math.abs(restored - kept);
  result.steps.push({
    what: '切换 plan→verify 后滚动位置',
    scrollTopBefore: kept, scrollTopAfter: restored, deltaPx: dKeep, pass: dKeep <= 1,
  });
  console.log(`[W02-②] 滚动位置 ${kept} → ${restored}（Δ${dKeep}px）${dKeep <= 1 ? '✅' : '❌'}`);

  result.pageErrors = state.pageErrors.length;
  result.consoleErrors = state.consoleErrs.length;
  writeFileSync(join(OUT_DIR, 'w02-isolation.json'), JSON.stringify(result, null, 2));
  console.log(`零 pageerror=${state.pageErrors.length} / 零 console.error=${state.consoleErrs.length}；结果落 verify-assets/r81/w02-isolation.json`);
} finally {
  await page.close(); await browser.close(); await stack.stop();
}
