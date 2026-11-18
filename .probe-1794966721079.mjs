
import { readFileSync, existsSync } from 'node:fs';
if (!existsSync('web/app.css')) { console.log('web/app.css 不存在'); process.exit(0); }
const css = readFileSync('web/app.css', 'utf8');
const counts = {};
for (const m of css.matchAll(/#[0-9a-fA-F]{6}/g)) {
  const k = m[0].toLowerCase();
  counts[k] = (counts[k] || 0) + 1;
}
const top = Object.entries(counts).filter(([, n]) => n >= 5).sort((a, b) => b[1] - a[1]).slice(0, 12);
for (const [c, n] of top) console.log(c + '  出现 ' + n + ' 次');
if (!top.length) console.log('（没有出现 5 次以上的硬编码颜色）');
