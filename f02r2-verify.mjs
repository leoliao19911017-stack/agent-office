// F02 第 2 轮验证：历史版本预览读取对应快照（不冒充、不可用态明示、切换不串版）
// 运行：node f02r2-verify.mjs   （Edge CDP 9466 已起，8090 服务需活）
// 覆盖：
//   A. API 地面真值：TEST-F01R10 登记与磁盘、TEST-F02R2 夹具自洽性、旧快照指纹不符的证明
//   B. 点 300B 历史登记 → data-fv-hint=hist、无 <pre>、无 V2 冒充、无失配快照冒充、
//      提示样式实测（12px/18px/#E5B95E/内边距 12px 四边）、元数据逐行、登记ID绑定
//   C. 点 124B 当前登记 → 正常预览，pre 内容字节数/SHA-256 与所选登记一致
//   D. 点 TEST-F02R2 的 153B 历史登记（history[].snapshot 与登记指纹一致）→ hist-saved，
//      pre=快照原文且字节/指纹逐项核对一致；同路径 145B 当前登记正常预览
//   E. 交替切换 300B↔124B ×10 + 刷新 ×5 → 每次状态与所点登记一一对应（不串版），
//      刷新后 TEST-F01R10 聚合仍 = 2 个物理文件 / 4 条登记
//   F. 版本选择状态色：当前版本行 .lf-cur = #65D9B1，历史版本行 .lf-hist = #AFC0D5
import { connect, send, evalJs, waitFor, goto, screenshot, pageErrors, BASE } from './f01r9-lib.mjs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const META = JSON.parse(readFileSync('tmp-f02r2-meta.txt', 'utf8'));   // {len1,sha1,len2,sha2}
const REG = {
  hist300: { bytes: 300, sha: '9490ac36152969f667760fbb511a968f528c9070104a163e3b2f0a8bfbfca3e4', task: 'TEST-F01R10', step: 'doc' },
  cur124:  { bytes: 124, sha: 'f0431173896513c5285a0e67661f905a5bc5d83dee9f3ad7757a72f61f30e17b', task: 'TEST-F01R10', step: 'plan' },
  time133: { bytes: 133, sha: 'd4ada83ba873592b3dc036a9c920ed582974bdb5e86eefb022a82c0b3a6e8f30' },
  f2r2v1:  { bytes: META.len1, sha: META.sha1, task: 'TEST-F02R2', step: 'doc' },
  f2r2v2:  { bytes: META.len2, sha: META.sha2, task: 'TEST-F02R2', step: 'plan' },
};
const V2B_MARKER = '当前版本 V2';      // F01R10 磁盘 124B 文件正文——历史预览里出现即冒充
const SNAP_LABEL = '旧版快照';          // F01R10 失配快照的标签——上屏即冒充
const V1R2_MARKER = '历史原文 V1';      // F02R2 快照原文标记
const V2R2_MARKER = '磁盘现状';         // F02R2 当前版本标记
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const nb = (s) => Buffer.byteLength(s, 'utf8');

let pass = 0, fail = 0;
const T = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`);
  ok ? pass++ : fail++;
};
const waitRow = (frag) => waitFor(
  `!![...document.querySelectorAll('#file-groups .library-file')].find(r => (r.dataset.openFile||'').includes('${frag}'))`,
  25000, `行出现: ${frag}`);
// 点某条登记行（按 bytes 定位 .lf-reg）并等预览稳定；返回所点行的登记身份（登记ID+版本指纹）
const clickReg = async (frag, bytes, settleExpr, label) => {
  await waitRow(frag);
  const clicked = await evalJs(`(() => {
    const row = [...document.querySelectorAll('#file-groups .library-file')].find(r => (r.dataset.openFile||'').includes('${frag}'));
    if (!row) return 'no-row';
    const span = [...row.querySelectorAll('.lf-reg')].find(s => {
      try { return JSON.parse(s.dataset.regs || '[]').some(r => r.bytes === ${bytes}); } catch { return false; }
    });
    if (!span) return 'no-span';
    span.click();
    return JSON.stringify({ vk: span.dataset.regVkey, taskId: span.dataset.taskId, stepKey: span.dataset.stepKey, cls: span.className });
  })()`);
  if (typeof clicked !== 'string' || clicked === 'no-row' || clicked === 'no-span') throw new Error(`点击失败 ${label}: ${clicked}`);
  await waitFor(settleExpr, 9000, `预览稳定: ${label}`);
  return JSON.parse(clicked);
};
const shaInPage = (sel) => evalJs(`(async () => {
  const el = document.querySelector('${sel}');
  if (!el) return null;
  const buf = new TextEncoder().encode(el.textContent);
  const h = await crypto.subtle.digest('SHA-256', buf);
  return { sha: [...new Uint8Array(h)].map(b => b.toString(16).padStart(2,'0')).join(''), bytes: buf.length, text: el.textContent };
})()`, true);
const fvState = () => evalJs(`(() => {
  const body = document.getElementById('fv-body');
  const hint = body.querySelector('.fv-hint');
  const meta = body.querySelector('.fv-hist-meta');
  const pre = body.querySelector('pre');
  const cs = hint ? getComputedStyle(hint) : null;
  const kv = (k) => { const r = [...(meta ? meta.querySelectorAll('.fh-kv') : [])].find(x => x.querySelector('span').textContent === k); return r ? r.querySelector('b').textContent : null; };
  return {
    fvHint: body.dataset.fvHint || null,
    hasPre: !!pre, bodyText: body.textContent,
    hintStyle: cs ? { fontSize: cs.fontSize, lineHeight: cs.lineHeight, color: cs.color,
      padTop: cs.paddingTop, padRight: cs.paddingRight, padBottom: cs.paddingBottom, padLeft: cs.paddingLeft } : null,
    kvRegId: kv('登记ID'), kvBytes: kv('登记字节'), kvSaved: kv('保存原文'),
    preText: pre ? pre.textContent : null,
    detailText: (document.getElementById('fv-detail').textContent || ''),
    detailWarnRows: [...document.querySelectorAll('#fv-detail .fvd-row b.warn')].map(b => b.parentElement.querySelector('span').textContent),
    locateGoto: (document.getElementById('fv-locate').dataset.goto || null),
  };
})()`);
// 刷新后 F01R10 组的聚合口径：物理文件行数 / 登记行数 / 组头文案
const AGGR_EXPR = `(() => {
  const g = document.querySelector('#file-groups .filegroup[data-group="TEST-F01R10"]');
  if (!g) return null;
  return { rows: g.querySelectorAll('.library-file').length, regs: g.querySelectorAll('.lf-reg').length,
    summary: (g.querySelector('summary') || {}).textContent || '' };
})()`;
const assertAggr = (tag) => evalJs(AGGR_EXPR).then((a) => {
  T(`${tag} 聚合仍 2 物理文件`, !!a && a.rows === 2, a ? `rows=${a.rows}` : 'no group');
  T(`${tag} 历史登记仍 4 条`, !!a && a.regs === 4, a ? `regs=${a.regs}` : 'no group');
  T(`${tag} 组头明示 2 个产物（4 条登记）`, !!a && a.summary.includes('2 个产物') && a.summary.includes('4 条登记'), a ? a.summary : 'no group');
});
const reloadFiles = async () => {
  try { await send('Page.reload', { ignoreCache: true }); } catch { /* 已在导航，忽略 */ }
  await waitRow('f01-r10/fixture-ver.md');
};

await connect(9466);
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

// ── A. API 地面真值 ─────────────────────────────────────────────
console.log('== A. API 地面真值 ==');
const flow = await (await fetch(`${BASE}/api/office/flow`)).json();
const pickReg = (task, step, frag) => flow.tasks.find(t => t.id === task).steps.find(s => s.key === step)
  .files.find(f => f.path.includes(frag));
const rHist = pickReg('TEST-F01R10', 'doc', 'fixture-ver.md');
const rCur = pickReg('TEST-F01R10', 'plan', 'fixture-ver.md');
const rF2doc = pickReg('TEST-F02R2', 'doc', 'fixture-snap.md');
const rF2plan = pickReg('TEST-F02R2', 'plan', 'fixture-snap.md');
T('A1 F01R10 登记历史版 300B/9490ac36（夹具未动）', rHist.bytes === 300 && rHist.sha256 === REG.hist300.sha, `${rHist.bytes}B ${rHist.sha256.slice(0,8)}`);
T('A2 F01R10 登记当前版 124B/f0431173', rCur.bytes === 124 && rCur.sha256 === REG.cur124.sha, `${rCur.bytes}B ${rCur.sha256.slice(0,8)}`);
const fVer = await (await fetch(`${BASE}/api/office/file?path=${encodeURIComponent(rCur.path)}`)).json();
const fTime = await (await fetch(`${BASE}/api/office/file?path=${encodeURIComponent(pickReg('TEST-F01R10','doc','fixture-time.md').path)}`)).json();
T('A3 磁盘 fixture-ver.md = 124B/f0431173（API 回 sha256）', fVer.bytes === 124 && fVer.sha256 === REG.cur124.sha, `${fVer.bytes}B ${fVer.sha256.slice(0,8)}`);
T('A4 磁盘 fixture-time.md = 133B/d4ada83b', fTime.bytes === 133 && fTime.sha256 === REG.time133.sha, `${fTime.bytes}B ${fTime.sha256.slice(0,8)}`);
T('A5 F02R2 doc 登记历史版快照留档（len1/sha1 与登记一致）', rF2doc.bytes === REG.f2r2v1.bytes && rF2doc.sha256 === REG.f2r2v1.sha
  && Array.isArray(rF2doc.history) && rF2doc.history[0].snapshot && rF2doc.history[0].sha256 === REG.f2r2v1.sha,
  `${rF2doc.bytes}B ${rF2doc.sha256.slice(0,8)} hist=${(rF2doc.history||[]).length}`);
T('A6 F02R2 plan 登记当前版=磁盘现状', rF2plan.bytes === REG.f2r2v2.bytes && rF2plan.sha256 === REG.f2r2v2.sha, `${rF2plan.bytes}B ${rF2plan.sha256.slice(0,8)}`);
const fSnap = await (await fetch(`${BASE}/api/office/file?path=${encodeURIComponent(rF2plan.path)}`)).json();
T('A7 磁盘 fixture-snap.md = len2/sha2（V2 当前内容）', fSnap.bytes === REG.f2r2v2.bytes && fSnap.sha256 === REG.f2r2v2.sha, `${fSnap.bytes}B ${fSnap.sha256.slice(0,8)}`);
T('A8 Node 核对：快照原文 sha256 = 登记指纹（夹具自洽）', sha(rF2doc.history[0].snapshot) === REG.f2r2v1.sha && nb(rF2doc.history[0].snapshot) === REG.f2r2v1.bytes,
  `node-sha=${sha(rF2doc.history[0].snapshot).slice(0,8)}`);
const snapSha = sha('V1 旧版快照');
T('A9 F01R10 旧快照留档与登记指纹不符（15B/≠9490ac36 → 不可用态是唯一诚实答案）',
  nb('V1 旧版快照') === 15 && snapSha !== REG.hist300.sha, `snap=${nb('V1 旧版快照')}B/${snapSha.slice(0,8)} reg=300B/9490ac36`);

// ── B. 点 300B 历史登记：绑定登记身份，元数据 + 明示不可预览，不冒充 ──
console.log('== B. 点 300B 历史登记 ==');
await goto(`${BASE}/#/files`);
await waitRow('f01-r10/fixture-ver.md');
const cHist = await clickReg('f01-r10/fixture-ver.md', 300, `document.getElementById('fv-body').dataset.fvHint==='hist'`, '300B 历史登记');
T('B1 版本选择绑定登记ID+指纹（TEST-F01R10›doc · sha:9490ac36）',
  cHist.vk === 'sha:' + REG.hist300.sha && cHist.taskId === 'TEST-F01R10' && cHist.stepKey === 'doc',
  `${cHist.taskId}›${cHist.stepKey} ${cHist.vk.slice(0,17)}…`);
T('B2 历史行带 lf-hist 类', /(^|\s)lf-hist(\s|$)/.test(cHist.cls), cHist.cls);
let s = await fvState();
T('B3 无 <pre>（不展示文件内容）', s.hasPre === false, `hasPre=${s.hasPre}`);
T('B4 无 V2 当前内容冒充', !s.bodyText.includes(V2B_MARKER));
T('B5 无失配快照冒充（旧快照标签不上屏）', !s.bodyText.includes(SNAP_LABEL));
T('B6 提示字号 12px', s.hintStyle.fontSize === '12px', s.hintStyle.fontSize);
T('B7 提示行高 18px', s.hintStyle.lineHeight === '18px', s.hintStyle.lineHeight);
T('B8 提示颜色 #E5B95E', s.hintStyle.color === 'rgb(229, 185, 94)', s.hintStyle.color);
T('B9 提示内边距 12px（四边实测）', ['padTop','padRight','padBottom','padLeft'].every(k => s.hintStyle[k] === '12px'),
  `${s.hintStyle.padTop}/${s.hintStyle.padRight}/${s.hintStyle.padBottom}/${s.hintStyle.padLeft}`);
T('B10 登记ID 行 = TEST-F01R10›doc', s.kvRegId === 'TEST-F01R10›doc', s.kvRegId);
T('B11 登记字节行 = 300 B（300 B）', (s.kvBytes || '').includes('300 B') && (s.kvBytes || '').includes('（300 B）'), s.kvBytes);
T('B12 保存原言行明示快照失配（15B/43615f79 ≠ 9490ac36）',
  (s.kvSaved || '').includes('快照 15 B') && (s.kvSaved || '').includes(snapSha.slice(0,8)) && (s.kvSaved || '').includes(REG.hist300.sha.slice(0,8)),
  s.kvSaved);
T('B13 明示不可预览', s.bodyText.includes('不可预览'));
T('B14 提示指认磁盘内容属另一条登记（TEST-F01R10›plan）', s.bodyText.includes('TEST-F01R10›plan'));
T('B15 定位入口绑定所选登记（goto=TEST-F01R10|doc）', s.locateGoto === 'TEST-F01R10|doc', s.locateGoto);
T('B16 详情「预览核对」= warn 且明说未预览内容', s.detailWarnRows.includes('预览核对') && s.detailText.includes('未预览文件内容'),
  `warnRows=[${s.detailWarnRows}]`);
await screenshot('f02r2-hist-300B-1440x900.png');

// ── C. 点 124B 当前登记：正常预览，内容与所选登记逐项一致 ──────────
console.log('== C. 点 124B 当前登记 ==');
const cCur = await clickReg('f01-r10/fixture-ver.md', 124, `!!document.querySelector('#fv-body pre') && !document.getElementById('fv-body').dataset.fvHint`, '124B 当前登记');
T('C1 绑定登记ID+指纹（TEST-F01R10›plan · sha:f0431173）',
  cCur.vk === 'sha:' + REG.cur124.sha && cCur.taskId === 'TEST-F01R10' && cCur.stepKey === 'plan',
  `${cCur.taskId}›${cCur.stepKey} ${cCur.vk.slice(0,17)}…`);
T('C2 当前行带 lf-cur 类', /(^|\s)lf-cur(\s|$)/.test(cCur.cls), cCur.cls);
const pre1 = await shaInPage('#fv-body pre');
T('C3 预览内容 124 B（与登记一致）', pre1.bytes === 124, `实测 ${pre1.bytes} B`);
T('C4 预览内容 sha256=f0431173…（与登记一致）', pre1.sha === REG.cur124.sha, pre1.sha.slice(0, 16) + '…');
T('C5 预览是 V2 当前内容', pre1.text.includes(V2B_MARKER));
s = await fvState();
T('C6 定位入口换成所选登记（goto=TEST-F01R10|plan）', s.locateGoto === 'TEST-F01R10|plan', s.locateGoto);
T('C7 match 分支不加「预览核对」行', !s.detailText.includes('预览核对'));
await screenshot('f02r2-cur-124B-1440x900.png');

// ── D. F02R2：有指纹一致的历史快照 → 读取对应快照内容 ─────────────
console.log('== D. 点 153B 历史登记（快照与登记指纹一致）==');
const cSnap = await clickReg('f02-r2/fixture-snap.md', REG.f2r2v1.bytes,
  `document.getElementById('fv-body').dataset.fvHint==='hist-saved' && !!document.querySelector('#fv-body pre')`, '153B 快照历史登记');
T('D1 绑定登记ID+指纹（TEST-F02R2›doc）',
  cSnap.vk === 'sha:' + REG.f2r2v1.sha && cSnap.taskId === 'TEST-F02R2' && cSnap.stepKey === 'doc',
  `${cSnap.taskId}›${cSnap.stepKey} ${cSnap.vk.slice(0,17)}…`);
const pre2 = await shaInPage('#fv-body pre');
T(`D2 预览=快照原文 ${REG.f2r2v1.bytes} B（与登记一致）`, pre2.bytes === REG.f2r2v1.bytes, `实测 ${pre2.bytes} B`);
T(`D3 预览 sha256=${REG.f2r2v1.sha.slice(0,8)}…（指纹核对一致才上屏）`, pre2.sha === REG.f2r2v1.sha, pre2.sha.slice(0, 16) + '…');
T('D4 展示的是快照 V1 原文（非磁盘当前内容）', pre2.text.includes(V1R2_MARKER) && !pre2.text.includes(V2R2_MARKER));
s = await fvState();
T('D5 提示明说按指纹核对一致后展示历史快照留档', s.bodyText.includes('核对一致') && s.bodyText.includes('历史快照'));
T('D6 提示样式同规格（12px/18px/#E5B95E/内边距 12px）',
  s.hintStyle.fontSize === '12px' && s.hintStyle.lineHeight === '18px' && s.hintStyle.color === 'rgb(229, 185, 94)' && s.hintStyle.padTop === '12px' && s.hintStyle.padBottom === '12px',
  `${s.hintStyle.fontSize}/${s.hintStyle.lineHeight}/${s.hintStyle.color}/${s.hintStyle.padTop}`);
T('D7 详情「预览核对」非 warn 且明说已展示核对一致的历史原文',
  !s.detailWarnRows.includes('预览核对') && s.detailText.includes('已展示按登记指纹核对一致的历史原文'));
const cSnap2 = await clickReg('f02-r2/fixture-snap.md', REG.f2r2v2.bytes,
  `!!document.querySelector('#fv-body pre') && !document.getElementById('fv-body').dataset.fvHint`, '145B 当前登记');
const pre3 = await shaInPage('#fv-body pre');
T(`D8 同路径 145B 当前登记正常预览（${REG.f2r2v2.bytes} B/${REG.f2r2v2.sha.slice(0,8)}）`,
  cSnap2.vk === 'sha:' + REG.f2r2v2.sha && pre3.bytes === REG.f2r2v2.bytes && pre3.sha === REG.f2r2v2.sha && pre3.text.includes(V2R2_MARKER),
  `实测 ${pre3.bytes}B/${pre3.sha.slice(0,8)}`);
await screenshot('f02r2-saved-153B-1440x900.png');

// ── E. 交替切换 ×10 + 刷新 ×5：状态与所点登记一一对应，聚合不丢 ─────
console.log('== E. 交替切换 10 次 + 刷新 5 次 ==');
let reloads = 0;
for (let i = 0; i < 10; i++) {
  const wantHist = i % 2 === 0;
  if (i > 0 && i % 2 === 0) { await reloadFiles(); reloads++; await assertAggr(`E${i + 1} 刷新后`); }
  await clickReg('f01-r10/fixture-ver.md', wantHist ? 300 : 124,
    wantHist ? `document.getElementById('fv-body').dataset.fvHint==='hist'`
             : `!!document.querySelector('#fv-body pre') && !document.getElementById('fv-body').dataset.fvHint`,
    `E${i + 1} ${wantHist ? '300B hist' : '124B cur'}`);
  s = await fvState();
  if (wantHist) {
    T(`E${i + 1} hist 态正确（无 pre、无 V2/失配快照冒充）`, s.fvHint === 'hist' && !s.hasPre && !s.bodyText.includes(V2B_MARKER) && !s.bodyText.includes(SNAP_LABEL),
      `fvHint=${s.fvHint} hasPre=${s.hasPre}`);
  } else {
    const p = await shaInPage('#fv-body pre');
    T(`E${i + 1} cur 态正确（内容指纹=所选登记）`, !s.fvHint && p.sha === REG.cur124.sha && p.bytes === 124, `fvHint=${s.fvHint} ${p.bytes}B ${p.sha.slice(0, 8)}`);
  }
}
await reloadFiles(); reloads++;
await assertAggr('E-final 刷新后');
T('E 计数：切换 10 次、刷新 5 次', true, `clicks=10 reloads=${reloads}`);
await screenshot('f02r2-final-aggregation-1440x900.png');

// ── F. 版本选择状态色 ────────────────────────────────────────────
console.log('== F. 版本选择状态色 ==');
const colors = await evalJs(`(() => {
  const row = [...document.querySelectorAll('#file-groups .library-file')].find(r => (r.dataset.openFile||'').includes('f01-r10/fixture-ver.md'));
  const get = (bytes) => { const sp = [...row.querySelectorAll('.lf-reg')].find(s => { try { return JSON.parse(s.dataset.regs||'[]').some(r => r.bytes === bytes); } catch { return false; } }); return sp ? { cls: sp.className, color: getComputedStyle(sp).color } : null; };
  return { cur: get(124), hist: get(300) };
})()`);
T('F1 当前版本行 .lf-cur 色 = #65D9B1', colors.cur && /lf-cur/.test(colors.cur.cls) && colors.cur.color === 'rgb(101, 217, 177)', colors.cur ? `${colors.cur.cls} ${colors.cur.color}` : 'no span');
T('F2 历史版本行 .lf-hist 色 = #AFC0D5', colors.hist && /lf-hist/.test(colors.hist.cls) && colors.hist.color === 'rgb(175, 192, 213)', colors.hist ? `${colors.hist.cls} ${colors.hist.color}` : 'no span');

// ── 收尾 ────────────────────────────────────────────────────────
T('G1 全程无页面 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
