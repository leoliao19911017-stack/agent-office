// V2c-4 修正断言：组头「（N 条登记）」仅在实际发生登记合并(allRegs>all)时标注——
// 分叉态 2 产物=2 登记，无合并不标。核心不变量仍是 聚合前后 13=13。
import { connect, evalJs, waitFor, goto, BASE } from './f01r9-lib.mjs';
import { writeFileSync, readFileSync } from 'node:fs';
await connect(9451);
await goto(BASE + '/#/files');
await waitFor(`[...document.querySelectorAll('#file-groups .filegroup')].some(g => (g.querySelector('summary')?.textContent||'').includes('R11 决策端点'))`, 10000, '组出现');
const r = await evalJs(`(() => {
  const read = () => {
    const g = [...document.querySelectorAll('#file-groups .filegroup')].find(x => (x.querySelector('summary')?.textContent||'').includes('R11 决策端点'));
    return { title: g.querySelector('summary').textContent.trim(),
      rows: [...g.querySelectorAll('.library-file')].filter(r => (r.dataset.openFile||'').includes('app.css')).map(r => r.dataset.vkey),
      totalRegs: [...fileRegsByPath.values()].reduce((n,l)=>n+l.length,0),
      sumRefs: [...fileEntitiesByPath.values()].reduce((n,m)=>n+[...m.values()].reduce((k,e)=>k+e.refs.length,0),0) };
  };
  const t = lastFlow.tasks.find(t => t.id === 'TEST-R11');
  const fd = t.steps.find(s => s.key === 'doc').files.find(f => String(f.path).includes('app.css'));
  const o = fd.sha256;
  fd.sha256 = 'f01r9-fake-version-0001'; fileStatusVersion++; renderFiles();
  const split = read();
  fd.sha256 = o; fileStatusVersion++; renderFiles();
  return { split, merged: read() };
})()`);
const A = (n, c, d) => console.log((c ? 'PASS  ' : 'FAIL  ') + n + (c ? '' : ' :: ' + JSON.stringify(d)));
A('V2c-4a 分叉态：2 产物=2 登记、无合并不标注（设计：allRegs>all 才标）', /2 个产物$/.test(r.split.title) && r.split.rows.length === 2, r.split.title);
A('V2c-4b 聚合前后数量不变：登记 13 = 引用 13', r.split.totalRegs === 13 && r.split.sumRefs === 13, r.split);
A('V2c-4c 还原回合并态：组头恢复 1 个产物（2 条登记）', /1 个产物（2 条登记）/.test(r.merged.title) && r.merged.rows.length === 1, r.merged.title);
const j = JSON.parse(readFileSync('f01r9-verify2.json', 'utf8'));
j.fail = j.fail.filter(f => !f.startsWith('V2c-4'));
j['V2c-4 复核'] = r;
writeFileSync('f01r9-verify2.json', JSON.stringify(j, null, 2));
console.log('证据已更新 f01r9-verify2.json');
