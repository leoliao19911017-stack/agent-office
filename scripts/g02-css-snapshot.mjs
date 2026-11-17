// G02(第 5 轮)——四页全 DOM 计算色快照:颜色变量化 + CSS 拆分前后各跑一次,
// diff 必须为 0(任务书:最终计算色值保持不变)。
//   node scripts/g02-css-snapshot.mjs before|after
// 产物:verify-assets/g02/colors-before.json / colors-after.json + diff 结果
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, newPage } from '../test/g07-harness.mjs';

const mode = process.argv[2] || 'before';
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(dirname(HERE), 'verify-assets', 'g02');
mkdirSync(OUT, { recursive: true });
const BASE = process.env.SNAP_BASE || 'http://127.0.0.1:8090'; // 8091 = server.js 改动后未重启 8090 时的验证实例

const PROPS = ['color', 'backgroundColor', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor', 'fill', 'stroke'];
const PAGES = [
  { name: 'p1', hash: '#/' },
  { name: 'p2', hash: '#/agents' },
  { name: 'p3', hash: '#/skills' },
  { name: 'p4', hash: '#/files' },
];

const browser = await launchBrowser();
const snap = { at: new Date().toISOString(), mode, pages: {} };
try {
  for (const p of PAGES) {
    const { page } = await newPage(browser);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(BASE + '/' + p.hash, { waitUntil: 'commit' });
    await page.waitForSelector('#statusbar', { timeout: 15000 });
    await page.waitForTimeout(700);
    snap.pages[p.name] = await page.evaluate((PROPS) => {
      const out = [];
      for (const el of document.querySelectorAll('*')) {
        if (el.shadowRoot) continue; // 本应用无 shadow DOM
        const cs = getComputedStyle(el);
        const rec = { tag: el.tagName.toLowerCase(), id: el.id || '', cls: String(el.className).slice(0, 60), v: [] };
        for (const pr of PROPS) {
          const val = cs[pr];
          if (val && val !== 'rgba(0, 0, 0, 0)') rec.v.push(pr.slice(0, 4) + ':' + val);
        }
        if (rec.v.length) out.push(rec);
      }
      return out;
    }, PROPS);
    await page.close();
  }
} finally {
  await browser.close?.();
}
writeFileSync(join(OUT, `colors-${mode}.json`), JSON.stringify(snap));
if (mode === 'after') {
  const before = JSON.parse(readFileSync(join(OUT, 'colors-before.json'), 'utf8'));
  const norm = (s) => JSON.stringify(s.pages);
  const same = norm(before) === norm(snap);
  const diffs = [];
  if (!same) {
    for (const k of Object.keys(before.pages)) {
      const a = JSON.stringify(before.pages[k]), b = JSON.stringify(snap.pages[k]);
      if (a !== b) diffs.push(k);
    }
  }
  const res = { identical: same, diffPages: diffs, beforeCount: Object.values(before.pages).flat().length, afterCount: Object.values(snap.pages).flat().length };
  writeFileSync(join(OUT, 'colors-diff.json'), JSON.stringify(res, null, 2));
  console.log(JSON.stringify(res));
} else {
  console.log('baseline written:', join(OUT, 'colors-before.json'), existsSync(join(OUT, 'colors-before.json')));
}
