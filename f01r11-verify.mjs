// F01 第 11 轮验证：两条历史登记独立保存与校验（对当前组合代码做全量实测）
// 覆盖任务书四条验证要求：
//  ① 查询两条登记记录并比对原始ID、字节数、版本标识与时间（API 地面真值 vs 页面 data-regs）
//  ② 登记版本相同（允许汇总）与不同（必须分行）两类场景
//  ③ 修改物理文件后再次读取，历史快照不得变化
//  ④ getBoundingClientRect 确认元信息与右侧操作区无重叠
// 运行：node --experimental-websocket f01r11-verify.mjs   （Edge CDP 需已在 9466 起来，8090 服务需活）
import { connect, evalJs, waitFor, goto, screenshot, pageErrors, send } from './f01r9-lib.mjs';
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const EV = 'verify-assets/f01-r11';
const FIX_TIME = 'C:/Users/Administrator/Desktop/Soda Intelligence - AI Native Thinking/Soda Office/web/verify-assets/f01-r10/fixture-time.md';
const FIX_VER  = 'C:/Users/Administrator/Desktop/Soda Intelligence - AI Native Thinking/Soda Office/web/verify-assets/f01-r10/fixture-ver.md';
const results = [];
const T = (id, name, pass, detail) => { results.push({ id, name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${id} ${name}${detail === undefined ? '' : '  | ' + JSON.stringify(detail)}`); };

// ---------- API 地面真值 ----------
const flow = await (await fetch('http://127.0.0.1:8090/api/office/flow')).json();
const apiRegs = (taskId, fname) => flow.tasks.find(t => t.id === taskId).steps
  .flatMap(s => (s.files || []).filter(f => f.path.endsWith(fname)).map(f => ({ taskId, stepKey: s.key, at: s.at, bytes: f.bytes, sha256: f.sha256 || null, history: (f.history || []).length })));
const R11 = apiRegs('TEST-R11', 'app.css');
const FTIME = apiRegs('TEST-F01R10', 'fixture-time.md');
const FVER_D = apiRegs('TEST-F01R10', 'fixture-ver.md').find(r => r.stepKey === 'doc');
const FVER_P = apiRegs('TEST-F01R10', 'fixture-ver.md').find(r => r.stepKey === 'plan');
T('A1', 'API 侧两条 R11 登记四要素可读', R11.length === 2 && R11.every(r => r.bytes === 80408 && r.sha256 === 'selftest-placeholder' && r.at === '2026-11-15T18:50:08.441Z'),
  R11.map(r => `${r.taskId}›${r.stepKey} ${r.bytes}B ${r.sha256} ${r.at}`));
T('A2', 'API 侧 F01R10 夹具登记在档', FTIME.length === 2 && FVER_D.bytes === 300 && FVER_P.bytes === 124 && FVER_D.history === 1,
  { ftime: FTIME.map(r => `${r.stepKey} ${r.bytes}B ${r.sha256.slice(0, 8)} ${r.at}`), fverDoc: `${FVER_D.bytes}B ${FVER_D.sha256.slice(0, 8)} hist:${FVER_D.history}`, fverPlan: `${FVER_P.bytes}B ${FVER_P.sha256.slice(0, 8)}` });

// ---------- 连接页面 ----------
await connect(9466);
await goto('http://127.0.0.1:8090/#/files');
await waitFor(`!!document.querySelector('#file-groups .library-file')`, 10000, '文件页渲染');
await new Promise(r => setTimeout(r, 1200)); // 等 file-check 实测回来再测

// 页面内原子测量函数（一次 evaluate 读全，防 3s 轮询重渲染换引用）
const PAGE_LIB = `window.__f01r11 = {
  rowOf(fname, groupHint) {
    const groups = [...document.querySelectorAll('#file-groups .filegroup')];
    const g = groupHint ? groups.find(x => (x.querySelector('summary,.ff-title')?.textContent || '').includes(groupHint)) : null;
    const pool = g ? [...g.querySelectorAll('.library-file')] : [...document.querySelectorAll('#file-groups .library-file')];
    return pool.filter(r => (r.dataset.openFile || '').endsWith(fname));
  },
  regs(el) { try { return JSON.parse(el.getAttribute('data-regs') || 'null'); } catch { return 'BAD_JSON'; } },
  measure(el) {
    const r = (x) => { if (!x) return null; const b = x.getBoundingClientRect(); return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1), right: +b.right.toFixed(1), bottom: +b.bottom.toFixed(1) }; };
    const cs = (x, ps) => { if (!x) return null; const c = getComputedStyle(x); return Object.fromEntries(ps.map(p => [p, c[p]])); };
    const meta = el.querySelector('.lf-meta'); const acts = el.querySelector('.lf-actions');
    const lines = el.querySelector('.lf-lines');
    const spans = [...el.querySelectorAll('.lf-size,.lf-reg,.lf-tag')].map(s => ({ text: s.textContent.trim(), ...cs(s, ['fontSize', 'lineHeight', 'color']) }));
    return {
      cls: el.className, vkey: el.dataset.vkey || null,
      rowRect: r(el), rowStyle: cs(el, ['minHeight', 'maxHeight', 'backgroundColor', 'borderRadius', 'height']),
      metaRect: r(meta), metaStyle: cs(meta, ['width']), linesGap: lines ? cs(lines, ['rowGap', 'gap']) : null,
      actsRect: r(acts),
      gapMetaActs: meta && acts ? +(acts.getBoundingClientRect().left - meta.getBoundingClientRect().right).toFixed(1) : null,
      spans,
      regsText: el.getAttribute('data-regs'),
    };
  },
  sweep() {
    return [...document.querySelectorAll('#file-groups .library-file')].map(el => {
      const m = el.querySelector('.lf-meta'); const a = el.querySelector('.lf-actions');
      const b = el.getBoundingClientRect(); const mb = m.getBoundingClientRect(); const ab = a.getBoundingClientRect();
      return { file: (el.dataset.openFile || '').split('/').pop(), h: +b.height.toFixed(1), overlap: mb.right > ab.left, gap: +(ab.left - mb.right).toFixed(1) };
    });
  } }; true`;
await evalJs(PAGE_LIB);

const grab = (expr) => evalJs(`(function(){ const { rowOf, measure, regs, sweep } = window.__f01r11; return (${expr}); })()`);

// ---------- ②a 相同登记（同版本同刻）→ 汇总 + 身份行 ----------
const r11m = await grab(`(function(){ const rows = rowOf('app.css','R11 决策端点'); return rows.length ? measure(rows[0]) : { err: 'no row', n: rows.length }; })()`);
if (r11m.err) { T('S1', 'R11 app.css 行存在', false, r11m); }
else {
  const regs = JSON.parse(r11m.regsText);
  const exp = R11.map(r => ({ id: `${r.taskId}›${r.stepKey}`, bytes: r.bytes, ver: `sha:${r.sha256}`, at: r.at }));
  const got = regs.map(x => ({ id: x.id, bytes: x.bytes, ver: x.ver, at: x.at }));
  T('S1a', 'R11 行 data-regs 两条登记·四要素与 API 逐一相等', regs.length === 2 && JSON.stringify(exp.sort((a, b) => a.id.localeCompare(b.id))) === JSON.stringify(got.sort((a, b) => a.id.localeCompare(b.id))), { exp, got });
  const agg = r11m.spans.find(s => s.text.includes('×2'));
  const idl = r11m.spans.find(s => s.text.includes('同版'));
  T('S1b', '相同登记→汇总行「登记 78.5KB ×2」+ 身份行「02·03 同版 …」可见', !!agg && !!idl, { agg: agg?.text, idl: idl?.text });
  T('S1c', '汇总/身份行规格 12px/18px/rgb(215,225,238)', [agg, idl].every(s => s && s.fontSize === '12px' && s.lineHeight === '18px' && s.color === 'rgb(215, 225, 238)'),
    { agg: agg && { fontSize: agg.fontSize, lineHeight: agg.lineHeight, color: agg.color }, idl: idl && { fontSize: idl.fontSize, lineHeight: idl.lineHeight, color: idl.color } });
  T('S1d', `行规格 bg #182230 / radius 8px / min 68px / max 96px / 实高∈[68,96]`, r11m.rowStyle.backgroundColor === 'rgb(24, 34, 48)' && r11m.rowStyle.borderRadius === '8px' && r11m.rowStyle.minHeight === '68px' && r11m.rowStyle.maxHeight === '96px' && r11m.rowRect.h >= 68 && r11m.rowRect.h <= 96,
    { ...r11m.rowStyle, h: r11m.rowRect.h });
  T('S1e', '元信息列 190px / 行间距 4px', r11m.metaStyle.width === '190px' && r11m.linesGap.rowGap === '4px', { width: r11m.metaStyle.width, gap: r11m.linesGap });
  T('S1f', '元信息与操作区无重叠（getBoundingClientRect）', r11m.gapMetaActs !== null && r11m.gapMetaActs >= 0, { gap: r11m.gapMetaActs, metaRight: r11m.metaRect.right, actsLeft: r11m.actsRect.x });
}

// ---------- ②b 同版本不同登记时间 → 必须分行 ----------
const ftm0 = await grab(`(function(){ const rows = rowOf('fixture-time.md','F01'); return rows.length === 1 ? { ...measure(rows[0]), n: rows.length } : { n: rows.length }; })()`);
if (ftm0.n !== 1) T('S2', 'fixture-time.md 恰一行（聚合）', false, { n: ftm0.n });
else {
  const rows = ftm0.spans.filter(s => s.text && /[0-9]{2} /.test(s.text));
  T('S2a', '同版本不同刻 → lf-multi 分行态', ftm0.cls.includes('lf-multi') && !ftm0.spans.some(s => s.text.includes('×2')), { cls: ftm0.cls });
  const lines = await evalJs(`(function(){ const rows = window.__f01r11.rowOf('fixture-time.md','F01'); return [...rows[0].querySelectorAll('.lf-reg')].map(s => ({ text: s.textContent.trim(), regs: JSON.parse(s.dataset.regs) })); })()`);
  const okFour = lines.length === 2 && lines.every(l => l.regs.length === 1)
    && JSON.stringify(lines[0].regs[0]) === JSON.stringify({ id: 'TEST-F01R10›doc', step: lines[0].regs[0].step, bytes: 133, ver: 'sha:' + FTIME[0].sha256, at: FTIME[0].at, history: 0 })
    && lines[1].regs[0].id === 'TEST-F01R10›plan' && lines[1].regs[0].bytes === 133 && lines[1].regs[0].ver === 'sha:' + FTIME[0].sha256 && lines[1].regs[0].at === FTIME[1].at;
  T('S2b', '两条登记各自独立一行·data-regs 各 1 条·四要素与 API 相等（时间不同仍分列）', okFour, lines.map(l => ({ text: l.text, regs: l.regs })));
  const diffTime = lines[0].text !== lines[1].text && lines.every(l => /133B/.test(l.text.replace(' ', '')) || /133\s?B/.test(l.text));
  T('S2c', '两行可见文本各自含登记字节与不同登记时间（未合并成 ×2）', diffTime, lines.map(l => l.text));
  T('S2d', '分行行高 ∈[68,96]、无重叠', ftm0.rowRect.h >= 68 && ftm0.rowRect.h <= 96 && ftm0.gapMetaActs >= 0, { h: ftm0.rowRect.h, gap: ftm0.gapMetaActs });
}

// ---------- ②c 不同版本 → 两个实体行，历史字节不被当前元数据覆盖 ----------
const fvm = await evalJs(`(function(){ const rows = window.__f01r11.rowOf('fixture-ver.md','F01'); return rows.map(r => window.__f01r11.measure(r)); })()`);
if (fvm.length !== 2) T('S3', 'fixture-ver.md 两版本两行', false, { n: fvm.length });
else {
  const v1 = fvm.find(m => m.vkey && m.vkey.startsWith('sha:9490ac'));
  const v2 = fvm.find(m => m.vkey && m.vkey.startsWith('sha:f04311'));
  const v1regs = v1 && JSON.parse(v1.regsText); const v2regs = v2 && JSON.parse(v2.regsText);
  T('S3a', '两个版本标识各自成行（sha:9490ac…=V1 / sha:f04311…=V2，data-vkey 独立）', !!v1 && !!v2 && v1.vkey !== v2.vkey, { v1: v1?.vkey, v2: v2?.vkey });
  T('S3b', 'V1 行登记原件 = 300B/sha:9490ac…/history:1（未被当前 124B 覆盖）', v1regs?.length === 1 && v1regs[0].id === 'TEST-F01R10›doc' && v1regs[0].bytes === 300 && v1regs[0].ver === 'sha:' + FVER_D.sha256 && v1regs[0].history === 1 && v1regs[0].at === FVER_D.at,
    v1regs);
  const v1shows300 = v1.spans.some(s => s.text.includes('300')) && !v1.spans.some(s => s.text.includes('124'));
  T('S3c', 'V1 行可见文本展示登记 300B（历史版本标签），非当前实测 124B', v1.spans.some(s => s.text.includes('历史版本')) && v1shows300, v1.spans.map(s => s.text));
  T('S3d', 'V2 行 = 当前版 ✓124B，登记 124B/sha:f04311…', v2regs?.length === 1 && v2regs[0].bytes === 124 && v2regs[0].ver === 'sha:' + FVER_P.sha256 && v2.spans.some(s => s.text.includes('✓')),
    { regs: v2regs, spans: v2.spans.map(s => s.text) });
  T('S3e', '两行无重叠、行高∈[68,96]', fvm.every(m => m.gapMetaActs >= 0 && m.rowRect.h >= 68 && m.rowRect.h <= 96), fvm.map(m => ({ h: m.rowRect.h, gap: m.gapMetaActs })));
}

await screenshot(`${EV}/shot-1-forms.png`);

// ---------- ③ 物理文件修改后重读，历史快照不变 ----------
const before = await evalJs(`(function(){ const out = {}; for (const f of ['fixture-time.md','fixture-ver.md','app.css']) { const rows = window.__f01r11.rowOf(f); out[f] = rows.map(r => r.getAttribute('data-regs')); } return out; })()`);
const orig = readFileSync(FIX_TIME);
const sha = (b) => createHash('sha256').update(b).digest('hex');
writeFileSync(FIX_TIME, Buffer.concat([orig, Buffer.from('\n')]));   // 133 → 134 B
T('M0', '变异落地：fixture-time.md 133→134 B', orig.length === 133 && sha(orig) === FTIME[0].sha256, { before: `${orig.length}B ${sha(orig).slice(0, 8)}` });

// 真重读：同 URL 的 Page.navigate 不触发 reload（hash 不变），必须 Page.reload 清掉页内 fileStatus 缓存
await send('Page.reload', { ignoreCache: true });
await waitFor(`!!document.querySelector('#file-groups .library-file')`, 10000, '重读渲染');
await evalJs(PAGE_LIB);
await new Promise(r => setTimeout(r, 1500));
const after = await evalJs(`(function(){ const out = {}; for (const f of ['fixture-time.md','fixture-ver.md','app.css']) { const rows = window.__f01r11.rowOf(f); out[f] = rows.map(r => r.getAttribute('data-regs')); } return out; })()`);
const immutable = JSON.stringify(before) === JSON.stringify(after);
T('M1', '物理文件 +1B 后整页重读：三文件全部 data-regs 逐字节不变（历史快照未被当前元数据覆盖）', immutable,
  immutable ? { files: Object.keys(before) } : { diff: Object.keys(before).filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k])) });
const ftMut = await grab(`(function(){ const rows = rowOf('fixture-time.md','F01'); return rows.length===1?{spans: [...rows[0].querySelectorAll('.lf-size,.lf-reg')].map(s=>s.textContent.trim())}:{}; })()`);
T('M2', '实测随动：分行行尾逐条结论 ✓→≠（登记行文本仍 133B 不变）', ftMut.spans?.every(t => t.includes('≠') || !/[✓≠]$/.test(t)) && ftMut.spans?.every(t => t.includes('133')), ftMut.spans);
await screenshot(`${EV}/shot-2-mutated.png`);

writeFileSync(FIX_TIME, orig);   // 字节级还原
const restoredOk = sha(readFileSync(FIX_TIME)) === FTIME[0].sha256 && readFileSync(FIX_TIME).length === 133;
await send('Page.reload', { ignoreCache: true });
await waitFor(`!!document.querySelector('#file-groups .library-file')`, 10000, '还原后重读');
await evalJs(PAGE_LIB);
await new Promise(r => setTimeout(r, 1500));
const afterRestore = await grab(`(function(){ const rows = rowOf('fixture-time.md','F01'); return rows.length===1?{regs: rows[0].getAttribute('data-regs'), spans:[...rows[0].querySelectorAll('.lf-size,.lf-reg')].map(s=>s.textContent.trim())}:{}; })()`);
T('M3', '还原后：登记 data-regs 与变异前一致、结论回 ✓', restoredOk && afterRestore.regs === before['fixture-time.md'][0] && afterRestore.spans.every(t => t.includes('✓') || !/[✓≠]$/.test(t)),
  { restoredOk, regsSame: afterRestore.regs === before['fixture-time.md'][0], spans: afterRestore.spans });

// ---------- ④ 全库行扫：无重叠 / 行高区间 ----------
const sweep = await grab(`sweep()`);
const overlapped = sweep.filter(s => s.overlap);
const outOfRange = sweep.filter(s => s.h < 68 || s.h > 96);
T('W1', `全库 ${sweep.length} 行：元信息与操作区 0 重叠`, overlapped.length === 0, { overlapped, gaps: [...new Set(sweep.map(s => s.gap))] });
T('W2', `全库行高全部 ∈[68,96]`, outOfRange.length === 0, { heights: sweep.map(s => `${s.file}:${s.h}`) });
await screenshot(`${EV}/shot-3-final.png`);

// ---------- JS 异常 ----------
T('X1', '全程页面 JS 异常 0 条', pageErrors.length === 0, pageErrors);

const pass = results.filter(r => r.pass).length;
writeFileSync(`${EV}/results.json`, JSON.stringify({ at: new Date().toISOString(), pass, total: results.length, results }, null, 2));
console.log(`\n==== ${pass}/${results.length} PASS ====`);
process.exit(results.length === pass ? 0 : 1);
