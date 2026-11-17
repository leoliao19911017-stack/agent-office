// G02(第 5 轮)——四页截图回归:8091(新 server.js + 拆分 CSS)上截 工作台/Agents/技能/文件,
// 1440×900,等 statusbar 出现 + 首屏数据渲染后再截(与历轮 g07-screens 同口径)。
//   node scripts/g02-r5-screens.mjs
// 产物:verify-assets/g02/screenshot-p1..p4.png
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, newPage } from '../test/g07-harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(dirname(HERE), 'verify-assets', 'g02');
mkdirSync(OUT, { recursive: true });
const BASE = process.env.SNAP_BASE || 'http://127.0.0.1:8091';

const PAGES = [
  { name: 'p1', hash: '#/', wait: '#reqs-list .req-card, #reqs-list' },
  { name: 'p2', hash: '#/agents', wait: '#agent-grid .agent-card, #agent-grid' },
  { name: 'p3', hash: '#/skills', wait: '#skill-list' },
  { name: 'p4', hash: '#/files', wait: '#file-groups' },
];

const browser = await launchBrowser();
try {
  for (const p of PAGES) {
    const { page } = await newPage(browser);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(BASE + '/' + p.hash, { waitUntil: 'commit' });
    await page.waitForSelector('#statusbar', { timeout: 15000 });
    try { await page.waitForSelector(p.wait, { timeout: 8000 }); } catch { /* 空数据页也照截 */ }
    await page.waitForTimeout(1000);
    const file = join(OUT, `screenshot-${p.name}.png`);
    await page.screenshot({ path: file });
    console.log('shot:', file);
    await page.close();
  }
} finally {
  await browser.close?.();
}
