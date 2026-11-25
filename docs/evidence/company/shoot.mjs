// A12-A14 验收脚本：对隔离服务器（18790，演示快照库）跑 10 条点击路径。
// 运行：node docs/evidence/company/shoot.mjs   （截图写入同目录）
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'http://127.0.0.1:18790';
const OUT = process.cwd() + '/docs/evidence/company';
mkdirSync(OUT, { recursive: true });

const pw = (await import('playwright-core')).default;
// 本机 ms-playwright 只有 chromium-1248，而仓库 playwright-core 要 1255 的 headless shell；
// 直接指系统 Chrome，协议兼容。
const browser = await pw.chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const results = [];
const step = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const shot = (name) => page.screenshot({ path: join(OUT, name), fullPage: false });

// A14：所有可见文字 ≥11px
async function fontAudit(label) {
  const bad = await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Map();
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent.trim();
      if (!text) continue;
      const el = node.parentElement;
      if (!el || el.closest('.sr-only')) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const px = parseFloat(cs.fontSize);
      if (px < 11) seen.set(`${el.tagName}.${el.className} "${text.slice(0, 20)}"`, px);
    }
    return [...seen.entries()].map(([k, v]) => `${k} = ${v}px`);
  });
  step(`A14 ${label} 字号≥11px`, bad.length === 0, bad.length ? bad.join('; ') : '全部达标');
}

try {
  // ---- 路径 1：打开首页 = 助理工作台 ----
  await page.goto(BASE + '/company', { waitUntil: 'networkidle' });
  await page.waitForSelector('#assistant-name');
  const navActive = await page.getAttribute('.nav-item[aria-current="page"]', 'data-view');
  const assistantVisible = await page.isVisible('#view-assistant');
  const boardHidden = await page.isHidden('#view-company');
  step('路径1 打开首页看到助理工作台', navActive === 'assistant' && assistantVisible && boardHidden);
  await page.waitForTimeout(400);
  await shot('a12-workbench-1440x900.png');
  await fontAudit('助理视图');

  // ---- 路径 2：交办一件事 → pending ----
  await page.fill('#compose-title', '整理 EaseDraw 功能介绍');
  await page.click('#compose-toggle');
  await page.fill('#compose-deliver', '一份功能介绍文档');
  await page.fill('#compose-acceptance', '覆盖全部功能点');
  await page.click('#compose-form button[type="submit"]');
  await page.waitForTimeout(600);
  const pendingCard = await page.locator('.work-card', { hasText: '整理 EaseDraw 功能介绍' }).first().isVisible();
  const syncText1 = await page.textContent('#sync-label');
  step('路径2 交办后出现在正在推进（pending）', pendingCard, syncText1);
  await shot('a13-p2-assign-pending.png');

  // ---- 路径 3：助理派给 Claude ----
  await page.click('.work-card:has-text("整理 EaseDraw 功能介绍") [data-action="assign"][data-emp="emp-claude"]');
  await page.waitForTimeout(600);
  const ownerTxt = await page.textContent('.work-card:has-text("整理 EaseDraw 功能介绍") .meta');
  step('路径3 派给 Claude', ownerTxt.includes('Claude'), ownerTxt.trim());
  await shot('a13-p3-assigned-claude.png');

  // ---- 路径 4：开始执行 → running ----
  await page.click('.work-card:has-text("整理 EaseDraw 功能介绍") [data-action="start"]');
  await page.waitForTimeout(600);
  const runningTag = await page.textContent('.work-card:has-text("整理 EaseDraw 功能介绍") .tag');
  step('路径4 开始执行 → 正在工作', runningTag.includes('正在工作'), runningTag);
  await shot('a13-p4-running.png');

  // ---- 路径 5：提交成果 → delivered ----
  await page.click('.work-card:has-text("整理 EaseDraw 功能介绍") [data-action="deliver"]');
  await page.fill('.work-card:has-text("整理 EaseDraw 功能介绍") [data-role="refs"]',
    'docs/easedraw/功能介绍.md\ndocs/easedraw/功能清单.md');
  await page.fill('.work-card:has-text("整理 EaseDraw 功能介绍") [data-role="summary"]', '覆盖导入、导出、协作三大块');
  await page.click('.work-card:has-text("整理 EaseDraw 功能介绍") [data-action="deliver-confirm"]');
  await page.waitForTimeout(600);
  const deliveredVisible = await page.locator('#delivered-list .work-card', { hasText: '整理 EaseDraw 功能介绍' }).first().isVisible();
  step('路径5 提交成果 → 最新交付出现', deliveredVisible);
  await shot('a13-p5-delivered.png');

  // ---- 路径 6：首页出现最新交付，可点开成果 ----
  const refItem = page.locator('#delivered-list .work-card .refs li').first();
  const refText = (await refItem.textContent()).trim();
  await refItem.click();
  await page.waitForTimeout(400);
  const syncAfterRef = await page.textContent('#sync-label');
  step('路径6 点开成果', syncAfterRef.includes('功能介绍'), `成果「${refText}」→ ${syncAfterRef.trim()}`);

  // ---- 路径 7：验收通过 → accepted ----
  await page.click('#delivered-list .work-card [data-action="accept"]');
  await page.waitForTimeout(600);
  const acceptedGone = !(await page.locator('#delivered-list .work-card', { hasText: '整理 EaseDraw 功能介绍' }).first().isVisible());
  const recentLine = await page.textContent('#recent-list');
  step('路径7 验收通过 → accepted', acceptedGone && recentLine.includes('已验收'), recentLine.replace(/\s+/g, ' ').slice(0, 80));
  await shot('a13-p7-accepted.png');

  // ---- 路径 8：公司 → 研发部 → Claude 档案 ----
  await page.click('.nav-item[data-view="company"]');
  await page.waitForSelector('.dept-row');
  await page.click('.dept-row:has-text("研发部")');
  await page.waitForTimeout(300);
  const empVisible = await page.locator('.emp-row:has-text("Claude")').isVisible();
  await page.click('.emp-row:has-text("Claude")');
  await page.waitForSelector('#emp-profile .profile-head');
  const profileTxt = await page.textContent('#emp-profile');
  step('路径8 研发部看到 Claude 与工具', empVisible
    && profileTxt.includes('研发工程师') && profileTxt.includes('Claude Code') && profileTxt.includes('工作历史'),
  '档案含岗位/工具/工作历史');
  await shot('a13-p8-company-profile.png');
  await fontAudit('公司视图');

  // ---- 路径 9：资源 → 工具库 6 个 ----
  await page.click('.nav-item[data-view="resources"]');
  await page.waitForSelector('.tool-card');
  await page.waitForTimeout(300);
  const toolNames = await page.$$eval('.tool-card .name', (els) => els.map((e) => e.textContent.trim()));
  const toolStatus = await page.$$eval('.tool-card .tag', (els) => els.map((e) => e.textContent.trim()));
  step('路径9 工具库 6 个工具 + 连接状态', toolNames.length === 6
    && toolStatus.filter((s) => s.includes('已连接')).length === 4
    && toolStatus.filter((s) => s.includes('未启用')).length === 2,
  `${toolNames.join('、')} | ${toolStatus.join('、')}`);
  await shot('a13-p9-tools.png');
  await fontAudit('资源视图');

  // ---- 路径 10：新建部门 ----
  await page.click('.nav-item[data-view="company"]');
  await page.waitForSelector('.dept-row');
  await page.click('#dept-new-toggle');
  await page.fill('#dept-name', '设计部');
  await page.fill('#dept-duty', '出设计稿');
  await page.click('#dept-form button[type="submit"]');
  await page.waitForTimeout(600);
  const newDept = await page.locator('.dept-row:has-text("设计部")').isVisible();
  step('路径10 新建部门出现在列表', newDept);
  await shot('a13-p10-new-dept.png');

  // ---- A16：board-cromma.html 不受影响 ----
  await page.goto(BASE + '/board-cromma.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  const boardOk = await page.evaluate(() => !!document.querySelector('body') && document.body.textContent.length > 100);
  step('A16 board-cromma.html 仍能加载', boardOk, await page.title());
  await shot('a16-board-cromma.png');
} catch (err) {
  step('脚本执行', false, String(err));
}

await browser.close();
const fails = results.filter((r) => !r.ok);
console.log(`\n结果：${results.length - fails.length}/${results.length} 过`);
process.exit(fails.length ? 1 : 0);
