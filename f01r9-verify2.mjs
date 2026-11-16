// F01 第 9 轮 · 验证相位 2（修正版）：10:01:23 有并行「第 10 轮」层落进同一区域
// （sameRegs = 字节+版本+时间全等才汇总，否则逐条分行行整体替换 dual()）。
// 本脚本修掉上一版的 stale-element 测量 bug（renderFiles 后必须重新查 DOM），
// 并按组合代码的真实行为断言 V2b（异大小）/V2c（同字节异指纹），复测样式与交叠。
import { connect, evalJs, waitFor, goto, screenshot, MEASURE_DEFINE, pageErrors, BASE } from './f01r9-lib.mjs';
import { writeFileSync } from 'node:fs';

const P = 'C:/Users/Administrator/Desktop/Soda Intelligence - AI Native Thinking/Soda Office/web/app.css';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { fail: [] };
const A = (name, cond, detail) => { if (!cond) out.fail.push(name + (detail ? ' :: ' + JSON.stringify(detail).slice(0, 300) : '')); console.log((cond ? 'PASS' : 'FAIL') + '  ' + name); };

await connect(9451);
await goto(BASE + '/#/files');
await waitFor(`[...document.querySelectorAll('#file-groups .filegroup')].some(g => (g.querySelector('summary,.ff-title')?.textContent||'').includes('R11 决策端点'))`, 10000, 'TEST-R11 组出现');
await evalJs(`scheduleFileCheck(true); true`);
await sleep(1500);
await evalJs(MEASURE_DEFINE);

// V2b：doc.bytes=93000 → 分行。测量函数在 renderFiles() 之后重新查 DOM（不再持有旧引用）。
const v2b = await evalJs(`(() => {
  const freshRow = () => {
    const g = [...document.querySelectorAll('#file-groups .filegroup')].find(x => (x.querySelector('summary,#fg-title,.ff-title')?.textContent || '').includes('R11 决策端点'));
    const row = [...g.querySelectorAll('.library-file')].find(r => (r.dataset.openFile || '').includes('app.css'));
    const meta = row.querySelector('.lf-meta'), acts = row.querySelector('.lf-actions'), lines = row.querySelector('.lf-lines');
    const cs = (el, ps) => { const c = getComputedStyle(el); return Object.fromEntries(ps.map(p => [p, c[p]])); };
    const rb = row.getBoundingClientRect(), mb = meta.getBoundingClientRect(), ab = acts.getBoundingClientRect();
    return { cls: row.className, groupTitle: (g.querySelector('summary,#fg-title,.ff-title')?.textContent || '').trim(),
      rowH: +rb.height.toFixed(1), styles: cs(row, ['backgroundColor', 'minHeight', 'maxHeight', 'borderTopWidth', 'borderTopColor', 'borderRadius']),
      metaStyle: cs(meta, ['width']),
      spans: [...lines.querySelectorAll('.lf-size')].map(s => { const c = getComputedStyle(s); return { text: s.textContent, title: s.title, font: c.fontSize + '/' + c.lineHeight + '/' + c.color }; }),
      tag: row.querySelector('.lf-tag')?.textContent || null,
      overlap: !(mb.right <= ab.left), gap: +(ab.left - mb.right).toFixed(1) };
  };
  const t = lastFlow.tasks.find(t => t.id === 'TEST-R11');
  const fd = t.steps.find(s => s.key === 'doc').files.find(f => String(f.path).includes('app.css'));
  const orig = fd.bytes;
  fd.bytes = 93000;
  fileStatusVersion++; renderFiles();
  const snap = freshRow();
  fd.bytes = orig;
  fileStatusVersion++; renderFiles();
  const back = window.__r11Measure();
  return { snap, backLines: back.sizeSpans.map(s => s.text), backRegs: back.regs.map(r => r.id + '=' + r.bytes) };
})()`);
const s = v2b.snap;
A('V2b-1 异大小→逐条分行：两行登记、无 ×N 合并、无汇总', s.spans.length === 2 && !s.spans.some(x => x.text.includes('×')) && s.spans.some(x => x.text.startsWith('02 ') && x.text.includes('90.8KB')) && s.spans.some(x => x.text.startsWith('03 ') && x.text.includes('78.5KB')), s.spans.map(x => x.text));
A('V2b-2 每行带各自指纹+登记时间+与实测结论（≠）', s.spans.every(x => x.text.includes('selfte') && x.text.includes('02:50') && x.text.trim().endsWith('≠')), s.spans.map(x => x.text));
A('V2b-3 行 title 四要素齐全（登记ID/原始字节/版本标识/登记时间/比对）', s.spans.some(x => x.title.includes('原始字节数 93000 B') && x.title.includes('版本标识 sha:selftest-placeholder') && x.title.includes('与该条登记不一致')) && s.spans.some(x => x.title.includes('原始字节数 80408 B')), s.spans.map(x => x.title.split('\n')[1]));
A('V2b-4 分行态样式仍在规格内（96px 行高/底色/边框/圆角/190px/12px/18px/#D7E1EE）', s.rowH === 96 && s.styles.backgroundColor === 'rgb(24, 34, 48)' && s.styles.maxHeight === '96px' && s.styles.borderTopWidth === '1px' && s.styles.borderTopColor === 'rgb(51, 66, 87)' && s.styles.borderRadius === '8px' && s.metaStyle.width === '190px' && s.spans.every(x => x.font === '12px/18px/rgb(215, 225, 238)'), { h: s.rowH, bg: s.styles.backgroundColor, font: s.spans[0]?.font });
A('V2b-5 分行态元信息与操作区无交叠（间隙 ' + s.gap + 'px）', s.overlap === false && s.gap > 0, { gap: s.gap });
A('V2b-6 还原后回到汇总 登记 78.5 KB ×2（80408×2）', v2b.backLines[1] === '登记 78.5 KB ×2' && v2b.backRegs.every(x => x.endsWith('=80408')), v2b.backLines);
out.v2b = v2b;

// V2c：doc.sha256 换成假指纹（字节不变）→ 版本身份分叉 → 两行各一条登记
const v2c = await evalJs(`(() => {
  const freshAll = () => {
    const g = [...document.querySelectorAll('#file-groups .filegroup')].find(x => (x.querySelector('summary,#fg-title,.ff-title')?.textContent || '').includes('R11 决策端点'));
    const rows = [...g.querySelectorAll('.library-file')].filter(r => (r.dataset.openFile || '').includes('app.css')).map(r => {
      const meta = r.querySelector('.lf-meta'), acts = r.querySelector('.lf-actions');
      const mb = meta.getBoundingClientRect(), ab = acts.getBoundingClientRect(), rb = r.getBoundingClientRect();
      return { vkey: r.dataset.vkey, spans: [...r.querySelectorAll('.lf-size')].map(x => ({ text: x.textContent, title: x.title })), tag: r.querySelector('.lf-tag')?.textContent || null,
        h: +rb.height.toFixed(1), overlap: !(mb.right <= ab.left), gap: +(ab.left - mb.right).toFixed(1) };
    });
    return { groupTitle: (g.querySelector('summary,#fg-title,.ff-title')?.textContent || '').trim(), rows,
      totalRegs: [...fileRegsByPath.values()].reduce((n, l) => n + l.length, 0),
      sumRefs: [...fileEntitiesByPath.values()].reduce((n, m) => n + [...m.values()].reduce((k, e) => k + e.refs.length, 0), 0) };
  };
  const t = lastFlow.tasks.find(t => t.id === 'TEST-R11');
  const fd = t.steps.find(s => s.key === 'doc').files.find(f => String(f.path).includes('app.css'));
  const origSha = fd.sha256;
  fd.sha256 = 'f01r9-fake-version-0001';
  fileStatusVersion++; renderFiles();
  const snap = freshAll();
  fd.sha256 = origSha;
  fileStatusVersion++; renderFiles();
  const back = window.__r11Measure();
  return { snap, backLines: back.sizeSpans.map(x => x.text), backRegs: back.regs.map(r => r.id + '=' + r.bytes + '/' + r.sha256) };
})()`);
const c = v2c.snap;
A('V2c-1 同字节异指纹→版本身份分叉：2 行各 1 条登记（实测+登记+身份行），无 ×2 合并', c.rows.length === 2 && c.rows.every(r => r.spans.length >= 2 && r.spans.some(x => x.text === '登记 78.5 KB') && !r.spans.some(x => x.text.includes('×'))) && c.rows.some(r => r.spans.some(x => x.text.startsWith('02·'))) && c.rows.some(r => r.spans.some(x => x.text.startsWith('03·'))), c.rows.map(r => r.spans.map(x => x.text)));
A('V2c-2 两行版本身份独立（vkey 不同）', c.rows.some(r => r.vkey === 'sha:f01r9-fake-version-0001') && c.rows.some(r => r.vkey === 'sha:selftest-placeholder'), c.rows.map(r => r.vkey));
A('V2c-3 title 各自写明指纹（不再统一宣称一致）', c.rows.every(r => r.spans.some(x => x.title.includes('f01r9-fa') || x.title.includes('selftest'))) && c.rows.some(r => r.spans.some(x => x.title.includes('f01r9-fa'))), c.rows.map(r => r.spans.map(x => x.title.slice(0, 60))));
A('V2c-4 聚合前后数量不变：登记数=引用数（同快照），分叉态组头 2 个产物（无合并不标注）', c.totalRegs === c.sumRefs && /2 个产物$/.test(c.groupTitle), { t: c.totalRegs, s: c.sumRefs, title: c.groupTitle });
A('V2c-5 两行均不交叠、行高合规（' + c.rows.map(r => r.h).join(',') + 'px）', c.rows.every(r => r.overlap === false && r.gap > 0 && r.h >= 68 && r.h <= 96), c.rows.map(r => r.h));
A('V2c-6 还原后回到同版本汇总（指纹一致 ×2）', v2c.backLines[1] === '登记 78.5 KB ×2' && v2c.backRegs.every(x => x.endsWith('/selftest-placeholder')), v2c.backLines);
out.v2c = v2c;

// 分行态截图（变异易失：变异→截图→新鲜 DOM 复核，最多 3 次）
let splitShot = false;
for (let i = 0; i < 3 && !splitShot; i++) {
  await evalJs(`(() => { const t = lastFlow.tasks.find(t => t.id === 'TEST-R11'); const fd = t.steps.find(s => s.key === 'doc').files.find(f => String(f.path).includes('app.css')); fd.bytes = 93000; fileStatusVersion++; renderFiles(); return true; })()`);
  await screenshot('f01r9-row-split.png');
  splitShot = await evalJs(`(() => { const g = [...document.querySelectorAll('#file-groups .filegroup')].find(x => (x.querySelector('summary,.ff-title')?.textContent||'').includes('R11 决策端点')); const row = g ? [...g.querySelectorAll('.library-file')].find(r => (r.dataset.openFile||'').includes('app.css')) : null; const ok = row && [...row.querySelectorAll('.lf-size')].some(x => x.textContent.includes('02') && x.textContent.includes('90.8KB')); if (!ok) return false; const t = lastFlow.tasks.find(t => t.id === 'TEST-R11'); const fd = t.steps.find(s => s.key === 'doc').files.find(f => String(f.path).includes('app.css')); fd.bytes = 80408; fileStatusVersion++; renderFiles(); return true; })()`);
  if (!splitShot) await sleep(400);
}
A('V2-截图 分行态截图已取并复核（f01r9-row-split.png）', splitShot);

A('A11 页面零 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 3));
writeFileSync('f01r9-verify2.json', JSON.stringify(out, null, 2));
console.log('\n===== 结果：' + (out.fail.length ? out.fail.length + ' 项未过' : '全部通过') + ' =====');
if (out.fail.length) console.log(out.fail.join('\n'));
process.exit(out.fail.length ? 1 : 0);
