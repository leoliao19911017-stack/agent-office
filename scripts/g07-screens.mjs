// G07 截图与实测取证脚本（不是测试用例）——起与测试同款隔离 stack，
// 四页各截一张含真实业务内容的 PNG，并把 getComputedStyle / getBoundingClientRect /
// 首屏内容耗时实测值写进 verify-assets/g07/metrics.json（报告与回复引用的真实数值来源）。
//
// 运行：node scripts/g07-screens.mjs   （需 hermes node ≥22，与 test:g07 同一运行时）
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStack, launchBrowser, newPage } from '../test/g07-harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(dirname(HERE), 'verify-assets', 'g07');
mkdirSync(OUT, { recursive: true });

const PAGES = [
  { name: 'p1-workbench', hash: '#/', sel: '#reqs-list .req-item', biz: '#reqs-list .req-item' },
  { name: 'p2-agents', hash: '#/agents', sel: '#agent-grid .agent-card', biz: '#agent-grid .agent-card' },
  { name: 'p3-skills', hash: '#/skills', sel: '#skill-list .skill-row', biz: '#skill-list .skill-row' },
  { name: 'p4-files', hash: '#/files', sel: '#file-groups details.filegroup', biz: '#file-groups details.filegroup' },
];

const stack = await startStack();
const browser = await launchBrowser();
const metrics = { at: new Date().toISOString(), base: stack.base, pages: [] };
try {
  for (const p of PAGES) {
    const { page } = await newPage(browser);
    const t0 = Date.now();
    await page.goto(stack.base + '/' + p.hash, { waitUntil: 'commit' });
    await page.waitForSelector(p.sel, { timeout: 15000 });
    await page.waitForSelector('#sb-conn.ok', { timeout: 10000 });
    const contentMs = Date.now() - t0; // 首个业务元素可见 + 连接 ok 的墙钟耗时（与 A 系列同口径的保守值）

    // getComputedStyle / getBoundingClientRect 实测（在页面里算，不猜）
    const m = await page.evaluate((sel) => {
      const sb = document.getElementById('sb-conn');
      const sbStyle = sb ? getComputedStyle(sb) : null;
      const first = document.querySelector(sel);
      const r = first ? first.getBoundingClientRect() : null;
      return {
        sbConn: sbStyle ? { color: sbStyle.color, fontSize: sbStyle.fontSize, text: sb.textContent.trim() } : null,
        firstBizRect: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
        bodyTextLen: document.body.textContent.trim().length,
      };
    }, p.biz);
    const count = await page.locator(p.biz).count();

    const png = join(OUT, `${p.name}.png`);
    await page.screenshot({ path: png, fullPage: false });
    metrics.pages.push({ page: p.name, hash: p.hash, contentMs, bizCount: count, ...m });
    console.log(`[${p.name}] contentMs=${contentMs} bizCount=${count} sb=${m.sbConn?.color}/${m.sbConn?.fontSize} rect=${JSON.stringify(m.firstBizRect)}`);
    await page.close();
  }
} finally {
  await browser.close();
  await stack.stop();
}
writeFileSync(join(OUT, 'metrics.json'), JSON.stringify(metrics, null, 2));
console.log(`metrics → ${join(OUT, 'metrics.json')}`);
