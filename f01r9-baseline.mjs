// F01 第 9 轮 · 基线相位：改动前实测 R11 行的现状（布局/文案/数据三侧）。
import { connect, evalJs, waitFor, goto, MEASURE_DEFINE, pageErrors } from './f01r9-lib.mjs';
import { writeFileSync } from 'node:fs';

await connect(9451);
await goto('http://127.0.0.1:8090/#/files');
await waitFor(`!!document.querySelector('#file-groups .library-file')`, 10000, '文件页首渲染');
const info = await evalJs(`(() => {
  const gs = [...document.querySelectorAll('#file-groups .filegroup')];
  return { groupCount: gs.length, titles: gs.map(g => (g.querySelector('summary,.ff-title')?.textContent || '').trim().slice(0, 60)) };
})()`);
console.log('groups:', JSON.stringify(info));
await waitFor(`[...document.querySelectorAll('#file-groups .filegroup')].some(g => (g.querySelector('summary,.ff-title')?.textContent||'').includes('R11 决策端点'))`, 10000, 'TEST-R11 组出现');
await evalJs(`scheduleFileCheck(true); true`);
await new Promise(r => setTimeout(r, 1500));
await evalJs(MEASURE_DEFINE);
const snap = await evalJs(`window.__r11Measure()`);
writeFileSync('f01r9-baseline.json', JSON.stringify(snap, null, 2));
console.log(JSON.stringify(snap, null, 2));
console.log('pageErrors:', JSON.stringify(pageErrors.slice(0, 5)));
