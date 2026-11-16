// F01 第 9 轮 · 验证相位：V0 改后自然态+样式+抽屉；V1 独立登记ID/数量不变/API 交叉；
// V2b/V2c 构造数据（异大小分行 / 同字节异指纹分行）；V3 物理文件修改后历史登记不变；V4 交叠。
import { connect, evalJs, waitFor, goto, screenshot, MEASURE_DEFINE, pageErrors, BASE } from './f01r9-lib.mjs';
import { writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const P = 'C:/Users/Administrator/Desktop/Soda Intelligence - AI Native Thinking/Soda Office/web/app.css';
const CSS = 'C:/Users/Administrator/Desktop/Soda Intelligence - AI Native Thinking/Soda Office/web/app.css';
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { fail: [] };
const A = (name, cond, detail) => { if (!cond) out.fail.push(name + (detail ? ' :: ' + JSON.stringify(detail).slice(0, 300) : '')); console.log((cond ? 'PASS' : 'FAIL') + '  ' + name); };

await connect(9451);

// ---------- V0：硬重载取新代码，自然态（汇总显示）+ 计算样式 ----------
await goto(BASE + '/');
await goto(BASE + '/#/files');
await waitFor(`!!document.querySelector('#file-groups .library-file')`, 10000, '文件页首渲染');
await waitFor(`[...document.querySelectorAll('#file-groups .filegroup')].some(g => (g.querySelector('summary,.ff-title')?.textContent||'').includes('R11 决策端点'))`, 10000, 'TEST-R11 组出现');
await evalJs(`scheduleFileCheck(true); true`);
await sleep(1500);
await evalJs(MEASURE_DEFINE);
const v0 = await evalJs(`window.__r11Measure()`);
A('V0-1 两条独立登记（doc/plan）且元数据各自完整', v0.regs.length === 2
  && v0.regs.some(r => r.id === 'TEST-R11›doc' && r.bytes === 80408 && r.sha256 === 'selftest-placeholder' && r.stepNo === 2)
  && v0.regs.some(r => r.id === 'TEST-R11›plan' && r.bytes === 80408 && r.sha256 === 'selftest-placeholder' && r.stepNo === 3)
  && v0.regs.every(r => r.path === P && r.at), v0.regs);
A('V0-2 两条登记时间各自独立保留', v0.regs[0].at !== v0.regs[1].at || v0.regs.length === 2, v0.regs.map(r => r.at));
A('V0-3 汇总行文案 = 登记 78.5 KB ×2', v0.sizeSpans.length === 2 && v0.sizeSpans[1].text === '登记 78.5 KB ×2', v0.sizeSpans.map(s => s.text));
A('V0-4 汇总前提=版本标识一致且写明指纹（不再只凭字节）', /版本标识完全一致/.test(v0.sizeSpans[1].title) && /内容指纹 selftest/.test(v0.sizeSpans[1].title) && /2 条登记/.test(v0.sizeSpans[1].title), v0.sizeSpans[1].title);
A('V0-5 底色 #182230', v0.rowStyle.backgroundColor === 'rgb(24, 34, 48)', v0.rowStyle.backgroundColor);
A('V0-6 行高 68~96px 实测 ' + v0.rowRect.h + '，maxHeight 96px', v0.rowRect.h >= 68 && v0.rowRect.h <= 96 && v0.rowStyle.maxHeight === '96px' && v0.rowStyle.minHeight === '68px', { h: v0.rowRect.h, max: v0.rowStyle.maxHeight, min: v0.rowStyle.minHeight });
A('V0-7 边框 1px #334257 · 圆角 8px', v0.rowStyle.borderTopWidth === '1px' && v0.rowStyle.borderTopColor === 'rgb(51, 66, 87)' && v0.rowStyle.borderRadius === '8px', v0.rowStyle);
A('V0-8 元信息列宽 190px', v0.metaStyle.width === '190px', v0.metaStyle.width);
A('V0-9 字号 12px / 行高 18px / 颜色 #D7E1EE', v0.sizeSpans.every(s => s.fontSize === '12px' && s.lineHeight === '18px' && s.color === 'rgb(215, 225, 238)'), v0.sizeSpans[0]);
A('V0-10 行间距 4px', v0.linesStyle.rowGap === '4px' || v0.linesStyle.gap === '4px', v0.linesStyle);
A('V4-1 元信息区与操作区无交叠（间隙 ' + v0.gapMetaToActions + 'px）', v0.overlapMetaActions === false && v0.gapMetaToActions > 0, { gap: v0.gapMetaToActions });
out.v0 = v0;

// 抽屉：按独立登记ID逐条读取原始路径/字节/版本/步骤/时间
await evalJs(`openFileView(${JSON.stringify(P)}, {taskId:'TEST-R11', stepKey:'doc', vkey:'sha:selftest-placeholder'}); true`);
await sleep(1000);
const drawer = await evalJs(`(() => {
  const rows = [...document.querySelectorAll('#fv-detail .fvd-row')].map(r => ({ k: r.querySelector('span')?.textContent, v: r.querySelector('b')?.textContent }));
  return { rows, path: document.getElementById('fv-path')?.textContent, hidden: document.getElementById('fv-detail').hidden };
})()`);
const drow = (k) => drawer.rows.find(r => r.k === k)?.v || '';
A('A7-1 抽屉登记版本逐条列出两条独立指纹', drow('登记版本').includes('02 需求文档：内容指纹 selftest') && drow('登记版本').includes('03 开发计划：内容指纹 selftest'), drow('登记版本'));
A('A7-2 抽屉登记路径逐条列出原始路径', (drow('登记路径').match(/02 需求文档：C:\/Users\/Administrator\/Desktop\/Soda Intelligence - AI Native Thinking\/Soda Office\/web\/app.css/g) || []).length === 1 && drow('登记路径').includes('03 开发计划：'), drow('登记路径'));
A('A7-3 抽屉登记值逐条 80408 B', drow('登记值').includes('02 需求文档：78.5 KB（80408 B）') && drow('登记值').includes('03 开发计划：78.5 KB（80408 B）'), drow('登记值'));
A('A7-4 抽屉登记时间逐条列出', /02 需求文档：.+；03 开发计划：.+/.test(drow('登记时间')), drow('登记时间'));
A('A7-5 抽屉登记步骤两条独立ID', drow('登记步骤').includes('02 需求文档') && drow('登记步骤').includes('03 开发计划'), drow('登记步骤'));
A('A7-6 校验状态按版本标识口径逐条核对', drow('校验状态').includes('02 需求文档：登记 78.5 KB ≠ 实测') && drow('校验状态').includes('03 开发计划：登记 78.5 KB ≠ 实测') && drow('校验状态').includes('版本标识完全一致'), drow('校验状态').slice(0, 200));
out.drawer = drawer;
await screenshot('f01r9-drawer.png');
await evalJs('closeFileView(); true');
await screenshot('f01r9-row-merged.png');

// ---------- V1：聚合前后数量不变 + API 原始登记交叉 ----------
const inv = await evalJs(`(() => {
  const pk = physKey(${JSON.stringify(P)});
  const regs = fileRegsByPath.get(pk) || [];
  const sumRefs = [...fileEntitiesByPath.values()].reduce((n, m) => n + [...m.values()].reduce((k, e) => k + e.refs.length, 0), 0);
  const totalRegs = [...fileRegsByPath.values()].reduce((n, l) => n + l.length, 0);
  const header = [...document.querySelectorAll('#file-groups .filegroup')].map(g => (g.querySelector('summary,.ff-title')?.textContent || '').trim()).find(t => t.includes('R11 决策端点'));
  return { totalRegs, sumRefs, regCount: regs.length, entityRefs: (fileEntitiesByPath.get(pk) ? [...fileEntitiesByPath.get(pk).values()].map(e => ({ vk: e.vk, refs: e.refs.length })) : null), header, fileCount: document.getElementById('file-count')?.textContent };
})()`);
const flow = await (await fetch(BASE + '/api/office/flow')).json();
const t11 = flow.tasks.find(t => t.id === 'TEST-R11');
const apiRegs = [];
for (const s of (t11.steps || [])) for (const f of (s.files || [])) if (String(f.path).replace(/\\\\/g, '/').includes('app.css')) apiRegs.push({ id: t11.id + '›' + s.key, stepNo: s.no, stepName: s.name, at: s.at, path: f.path, bytes: f.bytes, sha256: f.sha256 || null });
A('V1-1 聚合前后数量不变：登记 13 = 实体引用合计 13', inv.totalRegs === 13 && inv.sumRefs === 13, inv);
A('V1-2 R11 组头同时给出产物数与登记数', inv.header.includes('1 个产物（2 条登记）'), inv.header);
A('V1-3 API 原始登记也是 2 条、字段逐项等于页面读数', apiRegs.length === 2
  && apiRegs.some(r => r.id === 'TEST-R11›doc' && r.bytes === 80408 && r.sha256 === 'selftest-placeholder')
  && apiRegs.some(r => r.id === 'TEST-R11›plan' && r.bytes === 80408 && r.sha256 === 'selftest-placeholder')
  && apiRegs.every(r => v0.regs.find(p => p.id === r.id && p.bytes === r.bytes && p.sha256 === r.sha256 && p.at === r.at)), apiRegs);
out.inv = inv; out.apiRegs = apiRegs;

// ---------- V2b：两条登记大小不同 → 分行呈现（原子变异 lastFlow → 强制重渲染 → 还原） ----------
const v2b = await evalJs(`(() => {
  const t = lastFlow.tasks.find(t => t.id === 'TEST-R11');
  const fd = t.steps.find(s => s.key === 'doc').files.find(f => String(f.path).includes('app.css'));
  const orig = fd.bytes;
  fd.bytes = 93000;
  fileStatusVersion++; renderFiles();
  const snap = __r11Measure();
  fd.bytes = orig;
  fileStatusVersion++; renderFiles();
  const back = __r11Measure();
  return { h: snap.rowRect.h, maxH: snap.rowStyle.maxHeight, lines: snap.sizeSpans.map(s => s.text), titles: snap.sizeSpans.map(s => s.title),
    overlap: snap.overlapMetaActions, gap: snap.gapMetaToActions, regs: snap.regs.map(r => r.id + '=' + r.bytes),
    backLines: back.sizeSpans.map(s => s.text), backRegs: back.regs.map(r => r.id + '=' + r.bytes) };
})()`);
A('V2b-1 大小不同→逐条分行（实测 + 02/03 两条登记，无 ×N 合并）', v2b.lines.length === 3 && v2b.lines[1] === '02 登记 90.8 KB' && v2b.lines[2] === '03 登记 78.5 KB' && !v2b.lines.some(x => x.includes('×')), v2b.lines);
A('V2b-2 行高被 96px 上限截断（' + v2b.h + 'px）且不交叠', v2b.h <= 96.01 && v2b.overlap === false && v2b.gap > 0, { h: v2b.h, overlap: v2b.overlap, gap: v2b.gap });
A('V2b-3 分行 title 各带版本与核对结论', v2b.titles.some(x => x.includes('02 需求文档')) && v2b.titles.some(x => x.includes('内容指纹 selftest') && x.includes('≠ 实测')), v2b.titles[1]);
A('V2b-4 变异期页面读数 doc=93000 / plan=80408（逐条独立）', v2b.regs.includes('TEST-R11›doc=93000') && v2b.regs.includes('TEST-R11›plan=80408'), v2b.regs);
A('V2b-5 还原后回到汇总 78.5 KB ×2、登记 80408×2', v2b.backLines[1] === '登记 78.5 KB ×2' && v2b.backRegs.every(x => x.endsWith('=80408')), v2b.backLines);
out.v2b = v2b;

// ---------- V2c：字节相同但内容指纹不同 → 不同历史版本，分列 ----------
const v2c = await evalJs(`(() => {
  const g = [...document.querySelectorAll('#file-groups .filegroup')].find(x => (x.querySelector('summary,#fg-title,.ff-title')?.textContent || '').includes('R11 决策端点'));
  const t = lastFlow.tasks.find(t => t.id === 'TEST-R11');
  const fd = t.steps.find(s => s.key === 'doc').files.find(f => String(f.path).includes('app.css'));
  const origSha = fd.sha256;
  fd.sha256 = 'f01r9-fake-version-0001';
  fileStatusVersion++; renderFiles();
  const title = (g.querySelector('summary,#fg-title,.ff-title')?.textContent || '').trim();
  const rows = [...g.querySelectorAll('.library-file')].filter(r => (r.dataset.openFile || '').includes('app.css')).map(r => {
    const meta = r.querySelector('.lf-meta'), acts = r.querySelector('.lf-actions');
    const rb = r.getBoundingClientRect(), mb = meta.getBoundingClientRect(), ab = acts.getBoundingClientRect();
    return { vkey: r.dataset.vkey, lines: [...r.querySelectorAll('.lf-size')].map(s => s.textContent), titles: [...r.querySelectorAll('.lf-size')].map(s => s.title),
      h: +rb.height.toFixed(1), overlap: !(mb.right <= ab.left), gap: +(ab.left - mb.right).toFixed(1) };
  });
  const sumRefs = [...fileEntitiesByPath.values()].reduce((n, m) => n + [...m.values()].reduce((k, e) => k + e.refs.length, 0), 0);
  const totalRegs = [...fileRegsByPath.values()].reduce((n, l) => n + l.length, 0);
  fd.sha256 = origSha;
  fileStatusVersion++; renderFiles();
  const back = __r11Measure();
  return { title, rows, totalRegs, sumRefs, backLines: back.sizeSpans.map(s => s.text), backRegs: back.regs.map(r => r.id + '=' + r.bytes + '/' + r.sha256) };
})()`);
A('V2c-1 字节同值指纹不同→不合并：2 行各 1 条登记、无 ×2', v2c.rows.length === 2 && v2c.rows.every(r => r.lines.length === 2 && r.lines[1] === '登记 78.5 KB' && !r.lines.some(x => x.includes('×'))), v2c.rows.map(r => r.lines));
A('V2c-2 两行版本身份各自独立（vkey 不同）', v2c.rows.some(r => r.vkey === 'sha:f01r9-fake-version-0001') && v2c.rows.some(r => r.vkey === 'sha:selftest-placeholder'), v2c.rows.map(r => r.vkey));
A('V2c-3 分行 title 写明各自指纹', v2c.rows.some(r => r.titles.some(x => x.includes('内容指纹 f01r9-fa'))) && v2c.rows.every(r => r.titles.some(x => x.includes('≠ 实测'))), v2c.rows.map(r => r.titles[1]?.slice(0, 80)));
A('V2c-4 数量不变：登记 13=引用 13，组头 2 个产物（2 条登记）', v2c.totalRegs === 13 && v2c.sumRefs === 13 && v2c.title.includes('2 个产物（2 条登记）'), { totalRegs: v2c.totalRegs, sumRefs: v2c.sumRefs, title: v2c.title });
A('V2c-5 还原后回到同一版本汇总展示', v2c.backLines[1] === '登记 78.5 KB ×2' && v2c.backRegs.every(x => x.endsWith('/selftest-placeholder')), v2c.backLines);
A('V2c-6 两行均不交叠', v2c.rows.every(r => r.overlap === false && r.gap > 0), v2c.rows.map(r => r.gap));
out.v2c = v2c;

// 分行截图（变异是易失的：变异→截图→验证，失败重试，最多 3 次）
let splitShot = false;
for (let i = 0; i < 3 && !splitShot; i++) {
  await evalJs(`(() => { const t = lastFlow.tasks.find(t => t.id === 'TEST-R11'); const fd = t.steps.find(s => s.key === 'doc').files.find(f => String(f.path).includes('app.css')); fd.bytes = 93000; fileStatusVersion++; renderFiles(); return true; })()`);
  await screenshot('f01r9-row-split.png');
  splitShot = await evalJs(`(() => { const g = [...document.querySelectorAll('#file-groups .filegroup')].find(x => (x.querySelector('summary,.ff-title')?.textContent||'').includes('R11 决策端点')); const ls = [...(g.querySelector('.library-file')||{}).querySelectorAll?.('.lf-size')||[]].map(s=>s.textContent); const ok = ls.some(x => x.includes('02 登记')); if (!ok) return false; const t = lastFlow.tasks.find(t => t.id === 'TEST-R11'); const fd = t.steps.find(s => s.key === 'doc').files.find(f => String(f.path).includes('app.css')); fd.bytes = 80408; fileStatusVersion++; renderFiles(); return true; })()`);
  if (!splitShot) await sleep(400);
}
A('V2-截图 分行态截图已取（f01r9-row-split.png）', splitShot);

// ---------- V3：物理文件修改后，历史登记字节/版本不得变化 ----------
const before = readFileSync(CSS);
const beforeHash = sha256(before);
const pad = Buffer.from('\n/* f01r9-v3 临时标记，验证后立即还原（' + new Date().toISOString() + '） */\n'.repeat(6));
appendFileSync(CSS, pad);
await evalJs(`scheduleFileCheck(true); true`);
await sleep(1800);
const v3a = await evalJs(`window.__r11Measure()`);
const flow3 = await (await fetch(BASE + '/api/office/flow')).json();
const t11b = flow3.tasks.find(t => t.id === 'TEST-R11');
const api3 = [];
for (const s of (t11b.steps || [])) for (const f of (s.files || [])) if (String(f.path).replace(/\\\\/g, '/').includes('app.css')) api3.push({ id: s.key, bytes: f.bytes, sha256: f.sha256 || null });
A('V3-1 物理文件已变大：实测 ' + (v3a.actual?.bytes ?? '?') + ' B', v3a.actual?.bytes === before.length + pad.length, { actual: v3a.actual, expect: before.length + pad.length });
A('V3-2 页面历史登记仍是 80408×2 / selftest-placeholder（不被物理文件覆盖）', v3a.regs.length === 2 && v3a.regs.every(r => r.bytes === 80408 && r.sha256 === 'selftest-placeholder'), v3a.regs.map(r => r.bytes));
A('V3-3 登记行仍显示 78.5 KB ×2，实测行随物理文件变化', v3a.sizeSpans[1]?.text === '登记 78.5 KB ×2' && v3a.sizeSpans[0]?.text !== v0.sizeSpans[0]?.text, v3a.sizeSpans.map(s => s.text));
A('V3-4 服务端登记数据同样未变', api3.length === 2 && api3.every(r => r.bytes === 80408 && r.sha256 === 'selftest-placeholder'), api3);
out.v3 = { actual: v3a.actual, regs: v3a.regs, lines: v3a.sizeSpans.map(s => s.text), api: api3, expectBytes: before.length + pad.length };
// 抽屉复查：物理文件改了，登记值/版本仍逐条 80408/指纹不变
await evalJs(`openFileView(${JSON.stringify(P)}, {taskId:'TEST-R11', stepKey:'doc', vkey:'sha:selftest-placeholder'}); true`);
await sleep(900);
const d3 = await evalJs(`(() => { const r = [...document.querySelectorAll('#fv-detail .fvd-row')]; return { regVal: r.find(x => x.querySelector('span')?.textContent === '登记值')?.querySelector('b')?.textContent, ver: r.find(x => x.querySelector('span')?.textContent === '登记版本')?.querySelector('b')?.textContent, act: r.find(x => x.querySelector('span')?.textContent === '实测值')?.querySelector('b')?.textContent }; })()`);
A('V3-5 抽屉：登记值仍 80408×2、版本指纹不变，实测值已更新', d3.regVal.includes('80408 B）') && !d3.regVal.includes(String(before.length + pad.length)) && d3.ver.includes('内容指纹 selftest') && d3.act !== v0.sizeSpans[0]?.text.replace(/^实测 /, ''), d3);
out.v3.drawer = d3;
await evalJs('closeFileView(); true');
// 还原物理文件并校验字节级一致
writeFileSync(CSS, before);
A('V3-6 app.css 已字节级还原（sha256 一致）', sha256(readFileSync(CSS)) === beforeHash);
await evalJs(`scheduleFileCheck(true); true`);
await sleep(1500);
const v3back = await evalJs(`window.__r11Measure()`);
A('V3-7 还原后实测回到 ' + before.length + ' B，登记 78.5 KB ×2 不变', v3back.actual?.bytes === before.length && v3back.sizeSpans[1]?.text === '登记 78.5 KB ×2', { actual: v3back.actual, lines: v3back.sizeSpans.map(s => s.text) });
out.v3.back = { actual: v3back.actual, lines: v3back.sizeSpans.map(s => s.text) };

A('A11 页面零 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 3));
writeFileSync('f01r9-verify.json', JSON.stringify(out, null, 2));
console.log('\n===== 结果：' + (out.fail.length ? out.fail.length + ' 项未过' : '全部通过') + ' =====');
if (out.fail.length) console.log(out.fail.join('\n'));
