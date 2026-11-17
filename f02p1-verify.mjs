// F02 第 1 轮验证：历史版本预览不冒充磁盘当前内容
// 运行：node --experimental-websocket f02p1-verify.mjs   （Edge CDP 9466 已起，8090 服务需活）
// 覆盖：
//   A. API 地面真值：登记（300B/9490ac36 历史、124B/f0431173 当前、181B/3b255e02 带保存原文）
//      vs 磁盘实测（fixture-ver.md=124B/f0431173，fixture-hist.md=121B/2c4ebaa0）
//   B. 点 300B 历史登记 → data-fv-hint=hist、无 <pre>、无 V2 内容冒充、提示样式实测
//   C. 点 124B 当前登记 → 正常预览，pre 内容 sha256/字节数与所选登记一致
//   D. 点 181B 带保存原文的历史登记 → data-fv-hint=hist-saved，pre=保存原文且指纹核对一致
//   E. 刷新 ×5 + 交替切换 300B/124B 共 10 次 → 状态与所点登记一一对应，不串用
import { connect, evalJs, waitFor, goto, screenshot, pageErrors, BASE } from './f01r9-lib.mjs';

await connect(9466);

const VER_MD = 'verify-assets/f01-r10/fixture-ver.md';
const HIST_MD = 'verify-assets/f02-p1/fixture-hist.md';
const REG = {
  hist300: { bytes: 300, sha: '9490ac36152969f667760fbb511a968f528c9070104a163e3b2f0a8bfbfca3e4', task: 'TEST-F01R10', step: 'doc' },
  cur124:  { bytes: 124, sha: 'f0431173896513c5285a0e67661f905a5bc5d83dee9f3ad7757a72f61f30e17b', task: 'TEST-F01R10', step: 'plan' },
  saved181:{ bytes: 181, sha: '3b255e02356c330a601f206b641d9475381dbdaf0a97ace5aefc635851a48137', task: 'TEST-F02P1', step: 'doc' },
  cur121:  { bytes: 121, sha: '2c4ebaa0f28189a55d59f147554f6e53a50c198d05c9cbdb684ddaa9f2712428', task: 'TEST-F02P1', step: 'plan' },
};
const V2_MARKER = '验证夹具 B：当前版本 V2';   // 124B 文件的正文首句——历史预览里出现即冒充
const V1_MARKER = '历史原文 V1';

let pass = 0, fail = 0;
const T = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`);
  ok ? pass++ : fail++;
};
const waitRow = (frag) => waitFor(
  `!![...document.querySelectorAll('#file-groups .library-file')].find(r => (r.dataset.openFile||'').includes('${frag}'))`,
  25000, `行出现: ${frag}`);
// 点某条登记行（按 bytes 定位 .lf-reg）并等预览稳定
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
    return span.dataset.regVkey;
  })()`);
  if (typeof clicked !== 'string' || clicked === 'no-row' || clicked === 'no-span') throw new Error(`点击失败 ${label}: ${clicked}`);
  await waitFor(settleExpr, 9000, `预览稳定: ${label}`);
  return clicked;
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
  const panel = document.querySelector('#file-view .fv-panel');
  const cs = hint ? getComputedStyle(hint) : null;
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { top: +b.top.toFixed(1), bottom: +b.bottom.toFixed(1), w: +b.width.toFixed(1) }; };
  return {
    fvHint: body.dataset.fvHint || null,
    hasPre: !!pre, bodyText: body.textContent,
    hintStyle: cs ? { fontSize: cs.fontSize, lineHeight: cs.lineHeight, color: cs.color } : null,
    hintRect: r(hint), metaRect: r(meta), preRect: r(pre),
    panelW: panel ? +panel.getBoundingClientRect().width.toFixed(1) : null,
    detailText: (document.getElementById('fv-detail').textContent || ''),
    detailWarnRows: [...document.querySelectorAll('#fv-detail .fvd-row b.warn')].map(b => b.parentElement.querySelector('span').textContent),
  };
})()`);

// ── A. API 地面真值 ─────────────────────────────────────────────
console.log('== A. API 地面真值 ==');
const flow = await (await fetch(`${BASE}/api/office/flow`)).json();
const pickReg = (task, step, frag) => flow.tasks.find(t => t.id === task).steps.find(s => s.key === step)
  .files.find(f => f.path.includes(frag));
const rHist = pickReg('TEST-F01R10', 'doc', 'fixture-ver.md');
const rCur = pickReg('TEST-F01R10', 'plan', 'fixture-ver.md');
const rSaved = pickReg('TEST-F02P1', 'doc', 'fixture-hist.md');
T('A1 登记历史版 300B/9490ac36', rHist.bytes === 300 && rHist.sha256 === REG.hist300.sha, `${rHist.bytes}B ${rHist.sha256.slice(0,8)}`);
T('A2 登记当前版 124B/f0431173', rCur.bytes === 124 && rCur.sha256 === REG.cur124.sha, `${rCur.bytes}B ${rCur.sha256.slice(0,8)}`);
T('A3 登记保存原文版 181B/3b255e02 带 text', rSaved.bytes === 181 && rSaved.sha256 === REG.saved181.sha && typeof rSaved.text === 'string' && rSaved.text.includes(V1_MARKER), `${rSaved.bytes}B ${rSaved.sha256.slice(0,8)} text=${rSaved.text ? rSaved.text.length + '字' : '无'}`);
const fVer = await (await fetch(`${BASE}/api/office/file?path=${encodeURIComponent(rCur.path)}`)).json();
const fHist = await (await fetch(`${BASE}/api/office/file?path=${encodeURIComponent(rSaved.path)}`)).json();
T('A4 磁盘 fixture-ver.md = 124B/f0431173（API 回 sha256）', fVer.bytes === 124 && fVer.sha256 === REG.cur124.sha, `${fVer.bytes}B ${fVer.sha256.slice(0,8)}`);
T('A5 磁盘 fixture-hist.md = 121B/2c4ebaa0（API 回 sha256）', fHist.bytes === 121 && fHist.sha256 === REG.cur121.sha, `${fHist.bytes}B ${fHist.sha256.slice(0,8)}`);

// ── B. 点 300B 历史登记：元数据 + 明示，不冒充 ────────────────────
console.log('== B. 点 300B 历史登记 ==');
await goto(`${BASE}/#/files`);
await waitRow('fixture-ver.md');
const vkHist = await clickReg('fixture-ver.md', 300, `document.getElementById('fv-body').dataset.fvHint==='hist'`, '300B 历史登记');
T('B1 data-fv-hint=hist', vkHist === 'sha:' + REG.hist300.sha, `regVkey=${vkHist.slice(0,17)}…`);
let s = await fvState();
T('B2 无 <pre>（不展示文件内容）', s.hasPre === false, `hasPre=${s.hasPre}`);
T('B3 无 V2 当前内容冒充', !s.bodyText.includes(V2_MARKER));
T('B4 提示字号 12px', s.hintStyle.fontSize === '12px', s.hintStyle.fontSize);
T('B5 提示行高 18px', s.hintStyle.lineHeight === '18px', s.hintStyle.lineHeight);
T('B6 提示颜色 #E5B95E', s.hintStyle.color === 'rgb(229, 185, 94)', s.hintStyle.color);
T('B7 提示与元数据间距 12px', s.metaRect && +(s.metaRect.top - s.hintRect.bottom).toFixed(1) === 12, `gap=${s.metaRect ? (s.metaRect.top - s.hintRect.bottom).toFixed(1) : 'n/a'}px`);
T('B8 元数据含登记字节 300 B', s.bodyText.includes('300 B'), (s.bodyText.match(/\d+ B/g) || []).join('/'));
T('B9 元数据明示原文不可预览', s.bodyText.includes('不可预览'));
T('B10 详情含「预览核对」且 warn', s.detailText.includes('预览核对') && s.detailWarnRows.includes('预览核对'), `warnRows=[${s.detailWarnRows}]`);
const panelW_Hist = s.panelW;
await screenshot('f02p1-hist-300B-1440x900.png');

// ── C. 点 124B 当前登记：正常预览 + 指纹核对一致 ──────────────────
console.log('== C. 点 124B 当前登记 ==');
const vkCur = await clickReg('fixture-ver.md', 124, `!!document.querySelector('#fv-body pre') && !document.getElementById('fv-body').dataset.fvHint`, '124B 当前登记');
T('C1 正常预览（无 hist 标记，有 <pre>）', vkCur === 'sha:' + REG.cur124.sha, `regVkey=${vkCur.slice(0,17)}…`);
const pre1 = await shaInPage('#fv-body pre');
T('C2 预览内容 124 B（与登记一致）', pre1.bytes === 124, `实测 ${pre1.bytes} B`);
T('C3 预览内容 sha256=f0431173…（与登记一致）', pre1.sha === REG.cur124.sha, pre1.sha.slice(0, 16) + '…');
T('C4 预览是 V2 当前内容', pre1.text.includes(V2_MARKER));
s = await fvState();
T('C5 预览容器宽度与历史分支一致（未动）', Math.abs(s.panelW - panelW_Hist) < 0.5, `cur=${s.panelW}px hist=${panelW_Hist}px`);
T('C6 当前分支不带「预览核对」行', !s.detailText.includes('预览核对'), 'match 分支不加行，保持原样');
await screenshot('f02p1-cur-124B-1440x900.png');

// ── D. 点 181B 带保存原文的历史登记 → hist-saved 展示保存原文 ─────
console.log('== D. 点 181B 带保存原文登记 ==');
const vkSaved = await clickReg('fixture-hist.md', 181, `document.getElementById('fv-body').dataset.fvHint==='hist-saved' && !!document.querySelector('#fv-body pre')`, '181B 保存原文登记');
T('D1 data-fv-hint=hist-saved', vkSaved === 'sha:' + REG.saved181.sha, `regVkey=${vkSaved.slice(0,17)}…`);
const pre2 = await shaInPage('#fv-body pre');
T('D2 保存原文 181 B（与登记一致）', pre2.bytes === 181, `实测 ${pre2.bytes} B`);
T('D3 保存原文 sha256=3b255e02…（指纹核对一致才上屏）', pre2.sha === REG.saved181.sha, pre2.sha.slice(0, 16) + '…');
T('D4 展示的是 V1 保存原文（非磁盘 V2）', pre2.text.includes(V1_MARKER) && !pre2.text.includes('当前磁盘版本 V2'));
s = await fvState();
T('D5 提示样式同规格 12px/18px/#E5B95E', s.hintStyle.fontSize === '12px' && s.hintStyle.lineHeight === '18px' && s.hintStyle.color === 'rgb(229, 185, 94)', `${s.hintStyle.fontSize}/${s.hintStyle.lineHeight}/${s.hintStyle.color}`);
T('D6 提示与原文间距 12px', +(s.preRect.top - s.hintRect.bottom).toFixed(1) === 12, `gap=${(s.preRect.top - s.hintRect.bottom).toFixed(1)}px`);
await screenshot('f02p1-saved-181B-1440x900.png');

// ── E. 刷新 ×5 + 交替切换 10 次：登记与预览一一对应，不串用 ────────
console.log('== E. 刷新+交替切换 ×10 ==');
for (let i = 0; i < 10; i++) {
  const wantHist = i % 2 === 0;
  if (i % 2 === 0) { await goto(`${BASE}/#/files`); await waitRow('fixture-ver.md'); }
  await clickReg('fixture-ver.md', wantHist ? 300 : 124,
    wantHist ? `document.getElementById('fv-body').dataset.fvHint==='hist'`
             : `!!document.querySelector('#fv-body pre') && !document.getElementById('fv-body').dataset.fvHint`,
    `E${i + 1} ${wantHist ? '300B hist' : '124B cur'}`);
  s = await fvState();
  if (wantHist) {
    T(`E${i + 1} hist 态正确（无 pre、无 V2 冒充）`, s.fvHint === 'hist' && !s.hasPre && !s.bodyText.includes(V2_MARKER), `fvHint=${s.fvHint} hasPre=${s.hasPre}`);
  } else {
    const p = await shaInPage('#fv-body pre');
    T(`E${i + 1} cur 态正确（内容指纹=所选登记）`, !s.fvHint && p.sha === REG.cur124.sha && p.bytes === 124, `fvHint=${s.fvHint} ${p.bytes}B ${p.sha.slice(0, 8)}`);
  }
}

// ── 收尾 ────────────────────────────────────────────────────────
T('F1 全程无页面 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
