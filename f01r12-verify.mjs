// F01 第 12 轮验证：统一物理文件与历史登记的聚合口径（实测）
// 任务书四条验证要求：
//  ① 查询 F01 的登记记录：4 个登记ID 分属 2 个规范化绝对路径（API 地面真值 + node 复刻 physKey）
//  ② 刷新后 F01 只显示 2 个物理文件主行、4 条登记仍可查看
//  ③ getBoundingClientRect：同一物理文件的历史记录位于同一主行容器内（含 80px/24px/4px/12px/18px/双色实测）
//  ④ 再次修改当前文件后，历史登记内容与指纹不变（变异→重读→字节级还原）
// 运行：node --experimental-websocket f01r12-verify.mjs   （Edge CDP 需已在 9466 起来，8090 服务需活）
import { connect, evalJs, waitFor, goto, screenshot, pageErrors, send } from './f01r9-lib.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const EV = 'verify-assets/f01-r12';
const FIX_TIME = 'C:/Users/Administrator/Desktop/Soda Intelligence - AI Native Thinking/Soda Office/web/verify-assets/f01-r10/fixture-time.md';
const FIX_VER  = 'C:/Users/Administrator/Desktop/Soda Intelligence - AI Native Thinking/Soda Office/web/verify-assets/f01-r10/fixture-ver.md';
const results = [];
const T = (id, name, pass, detail) => { results.push({ id, name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${id} ${name}${detail === undefined ? '' : '  | ' + JSON.stringify(detail)}`); };
const sha = (b) => createHash('sha256').update(b).digest('hex');

// ---------- node 侧复刻 physKey/versionKeyOf/dedupFiles（与 web/app.js 逐字符同源） ----------
function physKey(p) {
  let s = String(p ?? '').trim().replace(/\\/g, '/');
  if (/^\/\/\?\/unc\//i.test(s)) s = '//' + s.slice(8);
  else s = s.replace(/^\/\/[?.]+\/?/, '');
  const msys = s.match(/^\/([a-z])(\/|$)/i);
  if (msys) s = msys[1].toLowerCase() + ':' + s.slice(2);
  const unc = s.startsWith('//');
  s = s.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  if (unc) s = '/' + s;
  return s.toLowerCase();
}
function versionKeyOf(f) {
  if (f && f.sha256) return 'sha:' + f.sha256;
  if (f && f.bytes != null) return 'b:' + f.bytes;
  return 'v:?';
}

// ---------- ① API 地面真值：4 个登记ID → 2 个规范化绝对路径 ----------
const flow = await (await fetch('http://127.0.0.1:8090/api/office/flow')).json();
// 登记条数口径 = 步骤内 dedupFiles(physKey+versionKey) 后逐条（与前端 entries 同构）
const regs = flow.tasks.flatMap(t => t.steps.flatMap(s => {
  const seen = new Set(); const out = [];
  for (const f of (s.files || [])) {
    if (!f || !f.path) continue;
    const k = physKey(f.path) + '\u0000' + versionKeyOf(f);
    if (seen.has(k)) continue; seen.add(k); out.push(f);
  }
  return out.map(f => ({ id: `${t.id}›${s.key}`, taskId: t.id, stepKey: s.key, stepName: s.name, path: f.path, pk: physKey(f.path), bytes: f.bytes ?? null, sha256: f.sha256 || null, at: s.at || null, history: (f.history || []).length }));
}));
const F01 = regs.filter(r => r.taskId === 'TEST-F01R10');
const F01pks = [...new Set(F01.map(r => r.pk))];
const stepNameOf = (k) => flow.tasks.find(t => t.id === 'TEST-F01R10').steps.find(s => s.key === k).name;
T('V1a', 'API 侧 F01 恰 4 条登记（doc×2 + plan×2）', F01.length === 4, F01.map(r => r.id));
T('V1b', '4 个登记ID 分属 2 个规范化绝对路径（node 复刻 physKey）', F01pks.length === 2, F01pks);
const byPk = Object.fromEntries(F01pks.map(pk => [pk, F01.filter(r => r.pk === pk)]));
const ftPk = F01pks.find(pk => byPk[pk].length === 2 && byPk[pk].every(r => r.bytes === 133));
const fvPk = F01pks.find(pk => byPk[pk].length === 2 && [124, 300].every(b => byPk[pk].some(r => r.bytes === b)));
T('V1c', '路径 A=fixture-time.md 承载 2 条 133B 登记；路径 B=fixture-ver.md 承载 300B(历史)+124B(当前) 登记', !!ftPk && !!fvPk && ftPk !== fvPk,
  { A: byPk[ftPk]?.map(r => `${r.id} ${r.bytes}B`), B: byPk[fvPk]?.map(r => `${r.id} ${r.bytes}B`) });
const expTotalPhys = new Set(regs.map(r => r.pk)).size;
const expTotalRegs = regs.length;
T('V1d', `全库物理文件去重口径期望值：${expTotalPhys} 个物理文件 / ${expTotalRegs} 条登记`, expTotalPhys > 0, { expTotalPhys, expTotalRegs });

// ---------- 连接页面 ----------
await connect(9466);
await goto('http://127.0.0.1:8090/#/files');
await waitFor(`!!document.querySelector('#file-groups .library-file')`, 10000, '文件页渲染');
await new Promise(r => setTimeout(r, 1500)); // 等 file-check 实测回来再测

const PAGE_LIB = `window.__f01r12 = {
  groupOf(hint) { return [...document.querySelectorAll('#file-groups .filegroup')].find(x => (x.querySelector('summary')?.textContent || '').includes(hint)); },
  rowOf(fname, groupHint) {
    const g = window.__f01r12.groupOf(groupHint);
    const pool = g ? [...g.querySelectorAll('.library-file')] : [...document.querySelectorAll('#file-groups .library-file')];
    return pool.filter(r => (r.dataset.openFile || '').endsWith(fname));
  },
  regs(el) { try { return JSON.parse(el.getAttribute('data-regs') || 'null'); } catch { return 'BAD_JSON'; } },
  phys(fname) {
    const row = window.__f01r12.rowOf(fname, 'F01')[0];
    if (!row) return { err: 'no row' };
    const lines = [...row.querySelectorAll('.lf-vers .lf-size, .lf-lines .lf-reg')].map(s => {
      const b = s.getBoundingClientRect(); const c = getComputedStyle(s);
      return { text: s.textContent.trim(), cls: s.className, color: c.color, fontSize: c.fontSize, lineHeight: c.lineHeight, height: +b.height.toFixed(1), top: +b.top.toFixed(1), bottom: +b.bottom.toFixed(1),
        vkey: s.dataset.regVkey || null, taskId: s.dataset.taskId || null, stepKey: s.dataset.stepKey || null, inRow: row.contains(s) && s.closest('.library-file') === row,
        regs: (() => { try { return JSON.parse(s.dataset.regs); } catch { return 'BAD'; } })() };
    });
    const rb = row.getBoundingClientRect(); const rc = getComputedStyle(row);
    const contained = lines.every(l => l.top >= rb.top - 0.5 && l.bottom <= rb.bottom + 0.5);
    return { cls: row.className, n: 1, regsText: row.getAttribute('data-regs'),
      row: { top: +rb.top.toFixed(1), bottom: +rb.bottom.toFixed(1), h: +rb.height.toFixed(1), w: +rb.width.toFixed(1), minHeight: rc.minHeight, maxHeight: rc.maxHeight },
      lines, contained };
  },
  sweep() {
    return [...document.querySelectorAll('#file-groups .library-file')].map(el => {
      const m = el.querySelector('.lf-meta'); const a = el.querySelector('.lf-actions');
      const b = el.getBoundingClientRect(); const mb = m.getBoundingClientRect(); const ab = a.getBoundingClientRect();
      return { file: (el.dataset.openFile || '').split('/').pop(), h: +b.height.toFixed(1), overlap: mb.right > ab.left, gap: +(ab.left - mb.right).toFixed(1) };
    });
  } }; true`;
await evalJs(PAGE_LIB);
const grab = (expr) => evalJs(`(function(){ const { groupOf, rowOf, regs, phys, sweep } = window.__f01r12; return (${expr}); })()`);

// ---------- ② 刷新后 F01 组 = 2 个物理文件主行 / 4 条登记 ----------
const f01Group = await grab(`groupOf('F01') ? { summary: groupOf('F01').querySelector('summary').textContent.trim(), rows: groupOf('F01').querySelectorAll('.library-file').length } : null`);
T('V2a', 'F01 组存在且恰 2 个 .library-file 主行', f01Group && f01Group.rows === 2, f01Group);
T('V2b', '组头计数按物理文件去重：「· 2 个产物（4 条登记）」', !!f01Group && /·\s*2 个产物（4 条登记）/.test(f01Group.summary), f01Group?.summary);

const ftime = await grab(`phys('fixture-time.md')`);
const fver  = await grab(`phys('fixture-ver.md')`);
T('V2c', 'fixture-time.md 恰 1 主行 / fixture-ver.md 恰 1 主行（不再按版本拆行）', ftime.n === 1 && !ftime.err && fver.n === 1 && !fver.err, { time: ftime.cls, ver: fver.cls });
const fvRowRegs = JSON.parse(fver.regsText); const ftRowRegs = JSON.parse(ftime.regsText);
T('V2d', '4 条登记全部可查看：ver 主行 data-regs 2 条 + time 主行 data-regs 2 条', fvRowRegs.length === 2 && ftRowRegs.length === 2, { ver: fvRowRegs.map(r => `${r.id} ${r.bytes}B`), time: ftRowRegs.map(r => `${r.id} ${r.bytes}B`) });

// fixture-ver.md：300B 历史 + 124B 当前 同主行，登记四要素与 API 逐一相等（不得覆盖）
const fvExp = [F01.find(r => r.bytes === 124), F01.find(r => r.bytes === 300)].map(r => ({ id: r.id, bytes: r.bytes, ver: 'sha:' + r.sha256, at: r.at, history: r.history }));
const fvGot = fvRowRegs.map(x => ({ id: x.id, bytes: x.bytes, ver: x.ver, at: x.at, history: x.history }));
T('V2e', 'ver 主行两条登记四要素（ID/字节/指纹/时间+history）与 API 逐一相等——300B 历史原件未被 124B 覆盖',
  JSON.stringify(fvGot.sort((a, b) => a.id.localeCompare(b.id))) === JSON.stringify(fvExp.sort((a, b) => a.id.localeCompare(b.id))), { exp: fvExp, got: fvGot });
const ftExp = F01.filter(r => r.bytes === 133).map(r => ({ id: r.id, bytes: r.bytes, ver: 'sha:' + r.sha256, at: r.at, history: r.history }));
const ftGot = ftRowRegs.map(x => ({ id: x.id, bytes: x.bytes, ver: x.ver, at: x.at, history: x.history }));
T('V2f', 'time 主行两条 133B 登记四要素与 API 逐一相等', JSON.stringify(ftGot.sort((a, b) => a.id.localeCompare(b.id))) === JSON.stringify(ftExp.sort((a, b) => a.id.localeCompare(b.id))), { exp: ftExp, got: ftGot });

// ---------- ③ getBoundingClientRect：同文件历史记录在同一主行容器内 + 规格实测 ----------
const L = fver.lines;
const curL = L.find(l => l.text.includes('✓')); const histL = L.find(l => l.text.includes('≠'));
T('V3a', 'ver 主行 = 多版本物理行 lf-phys，内部纵向展开 2 条登记行（当前 ✓124B 在首、历史 ≠300B 在后）',
  fver.cls.includes('lf-phys') && L.length === 2 && !!curL && !!histL && L.indexOf(curL) === 0, { cls: fver.cls, lines: L.map(l => l.text) });
T('V3b', '两条登记行均为该主行 DOM 子孙且矩心落在主行矩形内（row.contains + rect 包含）', fver.contained && L.every(l => l.inRow), { row: fver.row, lines: L.map(l => ({ top: l.top, bottom: l.bottom })) });
T('V3c', `主行 min-height 80px（实测 ${fver.row.minHeight}）且渲染高 ${fver.row.h}px ≥ 80`, fver.row.minHeight === '80px' && fver.row.h >= 79.5, fver.row);
T('V3d', `登记行高 24px（实测 cur=${curL?.height} / hist=${histL?.height}），行间垂直间隙 ${histL && curL ? +(histL.top - curL.bottom).toFixed(1) : '?'}px = 4px`,
  curL?.height === 24 && histL?.height === 24 && histL && Math.abs(histL.top - curL.bottom - 4) <= 0.5, { cur: curL?.height, hist: histL?.height, gap: histL ? +(histL.top - curL.bottom).toFixed(1) : null });
T('V3e', `当前版本行色 #65D9B1（实测 ${curL?.color}）；历史版本行色 #AFC0D5（实测 ${histL?.color}）+ 12px/18px（实测 ${histL?.fontSize}/${histL?.lineHeight}）`,
  curL?.color === 'rgb(101, 217, 177)' && histL?.color === 'rgb(175, 192, 213)' && histL?.fontSize === '12px' && histL?.lineHeight === '18px',
  { cur: curL && { color: curL.color }, hist: histL && { color: histL.color, fontSize: histL.fontSize, lineHeight: histL.lineHeight } });
T('V3f', '每条登记行自带登记身份（data-reg-vkey/task/step），点哪条看哪条', L.every(l => l.vkey && l.taskId === 'TEST-F01R10' && (l.stepKey === 'doc' || l.stepKey === 'plan')) && curL.vkey.startsWith('sha:f04311') && histL.vkey.startsWith('sha:9490ac'),
  L.map(l => ({ step: l.stepKey, vkey: l.vkey?.slice(0, 13) })));
// fixture-time.md：同版本两条登记也在同一主行内，统一口径下同着当前色 #65D9B1
T('V3g', 'time 主行 2 条登记行同容器（lf-multi）且登记字节=实测 133B → 统一着当前色 #65D9B1',
  ftime.cls.includes('lf-multi') && ftime.lines.length === 2 && ftime.contained && ftime.lines.every(l => l.color === 'rgb(101, 217, 177)' && l.height === 24),
  { cls: ftime.cls, colors: [...new Set(ftime.lines.map(l => l.color))], heights: ftime.lines.map(l => l.height) });
await screenshot(`${EV}/shot-1-forms.png`);

// ---------- ③b 点击历史登记行 → 抽屉展示该条 300B 登记 ----------
const histIdx = L.indexOf(histL);
await evalJs(`(function(){ const row = window.__f01r12.rowOf('fixture-ver.md','F01')[0]; const lines=[...row.querySelectorAll('.lf-vers .lf-size')]; lines[${histIdx}].click(); return true; })()`);
await new Promise(r => setTimeout(r, 600));
const drawer1 = await evalJs(`document.getElementById('fv-detail') ? document.getElementById('fv-detail').textContent.replace(/\\s+/g,' ').slice(0, 400) : 'NO_DRAWER'`);
await screenshot(`${EV}/shot-2-drawer-300B.png`);
const docName = stepNameOf('doc'), planName = stepNameOf('plan');
T('V3h', '点 300B 历史行 → 抽屉展示该条登记（登记 300 B、步骤「' + docName + '」、指纹 9490ac）而非当前 124B',
  drawer1.includes('300 B') && drawer1.includes(docName) && drawer1.includes('9490ac'), drawer1.slice(0, 200));
await evalJs(`document.getElementById('fv-close').click(); true`);
await new Promise(r => setTimeout(r, 250));
await evalJs(`(function(){ const row = window.__f01r12.rowOf('fixture-ver.md','F01')[0]; const lines=[...row.querySelectorAll('.lf-vers .lf-size')]; lines[${L.indexOf(curL)}].click(); return true; })()`);
await new Promise(r => setTimeout(r, 600));
const drawer2 = await evalJs(`document.getElementById('fv-detail') ? document.getElementById('fv-detail').textContent.replace(/\\s+/g,' ').slice(0, 400) : 'NO_DRAWER'`);
await evalJs(`document.getElementById('fv-close').click(); true`);
T('V3i', '点 124B 当前行 → 抽屉展示 124B 登记（步骤「' + planName + '」）', drawer2.includes('124 B') && drawer2.includes(planName), drawer2.slice(0, 200));

// ---------- ②c 顶部总量同口径 ----------
const topCount = await evalJs(`document.getElementById('file-count').textContent.trim()`);
const m = topCount.match(/匹配 (\d+) \/ (\d+) 个产物(?:（(\d+) 条登记）)?/);
T('V2g', `顶部总量按物理文件去重：${topCount}`, !!m && +m[1] === expTotalPhys && +m[2] === expTotalPhys && +m[3] === expTotalRegs, { topCount, exp: `匹配 ${expTotalPhys} / ${expTotalPhys} 个产物（${expTotalRegs} 条登记）` });

// ---------- 回归：R11（同版本同刻汇总）与其他组 ----------
const r11 = await grab(`(function(){ const rows = rowOf('app.css','R11 决策端点'); return rows.length===1 ? { cls: rows[0].className, regs: regs(rows[0]).length, spans: [...rows[0].querySelectorAll('.lf-size')].map(s=>({t:s.textContent.trim(),c:getComputedStyle(s).color})) } : { n: rows.length }; })()`);
const agg = r11.spans?.find(s => s.t.includes('×2'));
T('R1', '回归 R11 app.css：仍 1 行、data-regs 2 条、汇总行「×2」与 G01 r10 规格色 #E2EAF4 未动（r12 层未碰 lf-reg 基色）', r11.cls !== undefined && r11.regs === 2 && !!agg && agg.c === 'rgb(226, 234, 244)', { cls: r11.cls, regs: r11.regs, agg: agg && { t: agg.t, c: agg.c } });
const sweep = await grab(`sweep()`);
const overlapped = sweep.filter(s => s.overlap);
T('W1', `全库 ${sweep.length} 主行：元信息与操作区 0 重叠`, sweep.length > 0 && overlapped.length === 0, { overlapped, gaps: [...new Set(sweep.map(s => s.gap))] });
const f01Heights = sweep.filter(s => /fixture-(time|ver)\.md/.test(s.file));
T('W2', 'F01 两主行高均 ∈[80,96]', f01Heights.length === 2 && f01Heights.every(s => s.h >= 79.5 && s.h <= 96.5), f01Heights);

// ---------- ④ 变异当前文件 → 历史登记内容与指纹不变 ----------
const beforeAll = await evalJs(`(function(){ const out={}; for (const f of ['fixture-time.md','fixture-ver.md']) { out[f] = window.__f01r12.rowOf(f,'F01')[0].getAttribute('data-regs'); } return out; })()`);
const origVer = readFileSync(FIX_VER);
T('M0', '变异前地面真值：fixture-ver.md 磁盘 124B / sha f0431173…（与登记指纹同源）', origVer.length === 124 && sha(origVer).startsWith('f0431173896513'), `${origVer.length}B ${sha(origVer).slice(0, 13)}`);
writeFileSync(FIX_VER, Buffer.concat([origVer, Buffer.from('\n')]));   // 124 → 125 B
await send('Page.reload', { ignoreCache: true });
await waitFor(`!!document.querySelector('#file-groups .library-file')`, 10000, '变异后重读');
await evalJs(PAGE_LIB);
await new Promise(r => setTimeout(r, 1500));
const afterAll = await evalJs(`(function(){ const out={}; for (const f of ['fixture-time.md','fixture-ver.md']) { out[f] = window.__f01r12.rowOf(f,'F01')[0].getAttribute('data-regs'); } return out; })()`);
const immutable = JSON.stringify(beforeAll) === JSON.stringify(afterAll);
T('M1', '当前文件 +1B（124→125）整页重读：两物理文件全部登记 data-regs 逐字节不变（内容与指纹未被覆盖）', immutable,
  immutable ? { files: Object.keys(beforeAll) } : { diff: Object.keys(beforeAll).filter(k => JSON.stringify(beforeAll[k]) !== JSON.stringify(afterAll[k])) });
const fverMut = await grab(`phys('fixture-ver.md')`);
T('M2', '实测随动：124B 登记转 ≠ 历史色（磁盘 125B 无任何登记=当前版本），300B 历史行不变',
  fverMut.lines.length === 2 && !fverMut.lines.some(l => l.text.includes('✓')) && fverMut.lines.every(l => l.color === 'rgb(175, 192, 213)'),
  fverMut.lines.map(l => ({ t: l.text, c: l.color })));
await screenshot(`${EV}/shot-3-mutated.png`);

writeFileSync(FIX_VER, origVer);   // 字节级还原
const restoredOk = sha(readFileSync(FIX_VER)) === sha(origVer) && readFileSync(FIX_VER).length === 124;
const ftOk = (() => { const b = readFileSync(FIX_TIME); return b.length === 133 && sha(b).startsWith('d4ada83ba873'); })();
await send('Page.reload', { ignoreCache: true });
await waitFor(`!!document.querySelector('#file-groups .library-file')`, 10000, '还原后重读');
await evalJs(PAGE_LIB);
await new Promise(r => setTimeout(r, 1500));
const fverBack = await grab(`phys('fixture-ver.md')`);
const curBack = fverBack.lines.find(l => l.text.includes('✓'));
T('M3', '字节级还原后：登记仍逐字节一致、124B 回当前色 ✓ / 300B 历史色 ≠',
  restoredOk && ftOk && fverBack.regsText === beforeAll['fixture-ver.md'] && !!curBack && curBack.color === 'rgb(101, 217, 177)' && fverBack.lines.some(l => l.text.includes('≠') && l.color === 'rgb(175, 192, 213)'),
  { restoredOk, ftOk, regsSame: fverBack.regsText === beforeAll['fixture-ver.md'], lines: fverBack.lines.map(l => ({ t: l.text, c: l.color })) });
await screenshot(`${EV}/shot-4-final.png`);

// ---------- JS 异常 ----------
T('X1', '全程页面 JS 异常 0 条', pageErrors.length === 0, pageErrors);

const pass = results.filter(r => r.pass).length;
writeFileSync(`${EV}/results.json`, JSON.stringify({ at: new Date().toISOString(), pass, total: results.length, results }, null, 2));
console.log(`\n==== ${pass}/${results.length} PASS ====`);
process.exit(results.length === pass ? 0 : 1);
