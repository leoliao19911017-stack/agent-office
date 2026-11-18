
import { readFileSync, existsSync } from 'node:fs';
const cssFiles = ['web/app-base.css','web/app-workbench.css','web/app-pages.css','web/app-layers.css'].filter(f => existsSync(f));
if (!cssFiles.length) { console.log('没有找到 CSS 文件'); process.exit(0); }
const css = cssFiles.map(f => readFileSync(f, 'utf8')).join('
');
const counts = {};
for (const m of css.matchAll(/#[0-9a-fA-F]{6}/g)) {
  const k = m[0].toLowerCase();
  counts[k] = (counts[k] || 0) + 1;
}
const top = Object.entries(counts).filter(([, n]) => n >= 5).sort((a, b) => b[1] - a[1]).slice(0, 12);
for (const [c, n] of top) console.log(c + '  出现 ' + n + ' 次');
if (!top.length) console.log('（没有出现 5 次以上的硬编码颜色）');
