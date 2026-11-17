// G02(第 5 轮)——四页 DOM 内容断言:截图之外再证「页面真渲染了数据」。
// 每页检查:样式表 4 个全部加载成功 + 关键容器子元素数 + 顶/底栏在场。
//   node scripts/g02-r5-domcheck.mjs
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, newPage } from '../test/g07-harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.SNAP_BASE || 'http://127.0.0.1:8091';

const CHECKS = [
  { name: 'p1-工作台', hash: '#/', sel: '#reqs-list', min: 1 },
  { name: 'p2-Agents', hash: '#/agents', sel: '#agent-grid', min: 1 },
  { name: 'p3-技能', hash: '#/skills', sel: '#skill-list', min: 1 },
  { name: 'p4-文件', hash: '#/files', sel: '#file-groups', min: 1 },
];

const browser = await launchBrowser();
const results = [];
try {
  for (const c of CHECKS) {
    const { page } = await newPage(browser);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(BASE + '/' + c.hash, { waitUntil: 'commit' });
    await page.waitForSelector('#statusbar', { timeout: 15000 });
    await page.waitForTimeout(1200);
    const r = await page.evaluate(async (sel) => {
      const sheets = [...document.querySelectorAll('link[rel=stylesheet]')].map((l) => {
        // 同源 link 可直接读 sheet.cssRules;跨域/加载失败为 null
        let ok = false, rules = -1;
        try { rules = l.sheet ? l.sheet.cssRules.length : -1; ok = !!l.sheet; } catch { /* 跨域 */ }
        return { href: l.getAttribute('href'), loaded: ok, rules };
      });
      const target = document.querySelector(sel);
      const bodyBg = getComputedStyle(document.body).backgroundColor;
      return {
        sheets, bodyBg,
        targetChildren: target ? target.children.length : -1,
        statusbarText: (document.querySelector('#sb-conn-text') || {}).textContent || '',
      };
    }, c.sel);
    const pass = r.targetChildren >= c.min && r.sheets.length === 4 && r.sheets.every((s) => s.loaded);
    results.push({ page: c.name, pass, targetChildren: r.targetChildren, sheets: r.sheets, bodyBg: r.bodyBg });
    await page.close();
  }
} finally {
  await browser.close?.();
}
let allPass = results.every((r) => r.pass);
console.log(JSON.stringify({ allPass, results }, null, 2));
process.exit(allPass ? 0 : 1);
