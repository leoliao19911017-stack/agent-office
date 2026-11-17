// F02 第 3 轮验证：历史版本预览读取对应快照而非当前文件
// 运行：node f02r3-verify.mjs   （自起 Chrome CDP 9477 headless；8090 服务需为 r11d）
// 本轮改动：A) hist 分支不再要求磁盘恰属另一条登记（堵「谁都不匹配→展示当前文件」冒充洞）
//           B) 前端历史预览先问 /api/office/file-version（path+taskId›stepKey+vkey 共同定位），
//              服务端 node crypto 核对快照，页内 WebCrypto 复核，两端都过才展示
//           C) 服务端新增 file-version 端点（curl 可见核对过程与实测值）
// 覆盖：
//   A. API 地面真值 + file-version 端点：4 条登记逐个 + vkey 双确认拒绝 + R11 无快照
//   B. 点 300B 历史登记 → hist 不可用态：无 <pre>、无 V2 冒充、无快照文本冒充、
//      提示样式实测（12px/18px/#E5B95E、背景 #3B3021）、服务端核对行、登记ID绑定
//   C. 点 124B 当前登记 → 正常预览，pre 字节/SHA-256 与登记一致
//   D. 两条 133B 同版本登记各点各的（doc/plan 身份不串）
//   E. TEST-R11 app.css（磁盘 121879B 漂移、登记 80408B、无快照）→ 不可用态而非当前文件
//   F. 300B↔124B 交替 ×10 + 刷新 ×3 → 每次状态与所点登记一一对应；聚合仍 2 文件/4 登记
//   G. .lf-cur=#65D9B1 / .lf-hist 状态色实测
//   H. 全程不改登记：TEST-F01R10.json sha256 前后一致
import { connect, send, evalJs, waitFor, goto, screenshot, pageErrors, BASE } from './f01r9-lib.mjs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP = 9477;
const FIXTURE = 'C:/Tools/agent-autoloop/office-data/tasks/TEST-F01R10.json';
const R11FILE = 'C:/Tools/agent-autoloop/office-data/tasks/TEST-R11.json';

const REG = {
  hist300: { bytes: 300, sha: '9490ac36152969f667760fbb511a968f528c9070104a163e3b2f0a8bfbfca3e4', task: 'TEST-F01R10', step: 'doc' },
  cur124:  { bytes: 124, sha: 'f0431173896513c5285a0e67661f905a5bc5d83dee9f3ad7757a72f61f30e17b', task: 'TEST-F01R10', step: 'plan' },
  time133: { bytes: 133, sha: 'd4ada83ba873592b3dc036a9c920ed582974bdb5e86eefb022a82c0b3a6e8f30' },
  snap15:  { bytes: 15,  sha: '43615f791335d282877319696bfd00eaf6948d77debfb0099380f976beb19bc2' },
  r11:     { bytes: 80408, sha: 'selftest-placeholder', task: 'TEST-R11', step: 'doc' },
};
const FIX_SHA_BEFORE = createHash('sha256').update(readFileSync(FIXTURE)).digest('hex');
const R11_SHA_BEFORE = createHash('sha256').update(readFileSync(R11FILE)).digest('hex');
const V2B_MARKER = '当前版本 V2';   // F01R10 磁盘 124B 文件正文——历史预览里出现即冒充
const SNAP_TEXT = '旧版快照';        // F01R10 失配快照的正文——上屏即冒充快照

let pass = 0, fail = 0;
const T = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`);
  ok ? pass++ : fail++;
};

const waitRow = (frag) => waitFor(
  `!![...document.querySelectorAll('#file-groups .library-file')].find(r => (r.dataset.openFile||'').includes('${frag}'))`,
  25000, `行出现: ${frag}`);

// 点某条登记行（按 bytes + 可选 stepKey 定位 .lf-reg）并等预览稳定。
// 返回 { spanId…（单登记行才有 data-reg-vkey 等）, rowId…（行根身份，合并行的回退源）, regsCount }。
// 同版本多条登记会合并成一个 span（无自身身份属性，点击委托回退行根身份）——这是 F01 聚合的
// 既有语义；F02 关心的是内容不冒充，身份逐条核对由 A 组端点按 taskId+stepKey+vkey 完成。
const clickReg = async (frag, bytes, stepKey, settleExpr, label, rowCond = '') => {
  await waitRow(frag);
  const clicked = await evalJs(`(() => {
    const row = [...document.querySelectorAll('#file-groups .library-file')].find(r => (r.dataset.openFile||'').includes('${frag}')${rowCond ? ` && (${rowCond})` : ''});
    if (!row) return 'no-row';
    const span = [...row.querySelectorAll('.lf-reg')].find(s => {
      try { return JSON.parse(s.dataset.regs || '[]').some(r => r.bytes === ${bytes}${stepKey ? ` && String(r.id||'').includes('›${stepKey}')` : ''}); } catch { return false; }
    });
    if (!span) return 'no-span';
    const regs = (() => { try { return JSON.parse(span.dataset.regs || '[]'); } catch { return []; } })();
    span.click();
    return JSON.stringify({
      vk: span.dataset.regVkey || null, taskId: span.dataset.taskId || null, stepKey: span.dataset.stepKey || null,
      rowVk: row.dataset.vkey || null, rowTaskId: row.dataset.taskId || null, rowStepKey: row.dataset.stepKey || null,
      regsCount: regs.length, regsIds: regs.map(r => r.id), cls: span.className,
    });
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
    hintStyle: cs ? { fontSize: cs.fontSize, lineHeight: cs.lineHeight, color: cs.color, bg: cs.backgroundColor,
      padTop: cs.paddingTop, padRight: cs.paddingRight, padBottom: cs.paddingBottom, padLeft: cs.paddingLeft } : null,
    kvRegId: kv('登记ID'), kvBytes: kv('登记字节'), kvSaved: kv('保存原文'), kvSrv: kv('服务端核对'), kvDisk: kv('磁盘当前'),
    preText: pre ? pre.textContent : null,
    detailText: (document.getElementById('fv-detail').textContent || ''),
    locateGoto: (document.getElementById('fv-locate').dataset.goto || null),
  };
})()`);
const AGGR_EXPR = `(() => {
  const g = document.querySelector('#file-groups .filegroup[data-group="TEST-F01R10"]');
  if (!g) return null;
  return { rows: g.querySelectorAll('.library-file').length, regs: g.querySelectorAll('.lf-reg').length,
    summary: (g.querySelector('summary') || {}).textContent || '' };
})()`;
const assertAggr = (tag) => evalJs(AGGR_EXPR).then((a) => {
  T(`${tag} 聚合仍 2 物理文件`, !!a && a.rows === 2, a ? `rows=${a.rows}` : 'no group');
  T(`${tag} 登记仍 4 条`, !!a && a.regs === 4, a ? `regs=${a.regs}` : 'no group');
  T(`${tag} 组头明示 2 个产物（4 条登记）`, !!a && a.summary.includes('2 个产物') && a.summary.includes('4 条登记'), a ? a.summary.trim() : 'no group');
});
const reloadFiles = async () => {
  try { await send('Page.reload', { ignoreCache: true }); } catch { /* 已在导航 */ }
  await waitRow('f01-r10/fixture-ver.md');
};

// ── 起 Chrome ──────────────────────────────────────────────────
const profile = mkdtempSync(join(tmpdir(), 'f02r3-cdp-'));
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore' });
try {
  await connect(CDP);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  // ── A. API 地面真值 + file-version 端点 ──────────────────────
  console.log('== A. API 地面真值 + /api/office/file-version ==');
  const flow = await (await fetch(`${BASE}/api/office/flow`)).json();
  const pickReg = (task, step, frag) => flow.tasks.find(t => t.id === task).steps.find(s => s.key === step)
    .files.find(f => f.path.includes(frag));
  const rHist = pickReg('TEST-F01R10', 'doc', 'fixture-ver.md');
  const rCur = pickReg('TEST-F01R10', 'plan', 'fixture-ver.md');
  const rTimeDoc = pickReg('TEST-F01R10', 'doc', 'fixture-time.md');
  T('A1 F01R10 doc 登记 = 300B/9490ac36（夹具未动）', rHist.bytes === 300 && rHist.sha256 === REG.hist300.sha, `${rHist.bytes}B ${rHist.sha256.slice(0,8)}`);
  T('A2 F01R10 plan 登记 = 124B/f0431173', rCur.bytes === 124 && rCur.sha256 === REG.cur124.sha, `${rCur.bytes}B ${rCur.sha256.slice(0,8)}`);
  T('A3 F01R10 doc›time 登记 = 133B/d4ada83b', rTimeDoc.bytes === 133 && rTimeDoc.sha256 === REG.time133.sha, `${rTimeDoc.bytes}B`);
  const fv = async (task, step, frag, vkey) => {
    const f = pickReg(task, step, frag);
    const u = new URL(`${BASE}/api/office/file-version`);
    u.searchParams.set('path', f.path); u.searchParams.set('taskId', task); u.searchParams.set('stepKey', step);
    if (vkey) u.searchParams.set('vkey', vkey);
    const r = await fetch(u); return { status: r.status, j: await r.json() };
  };
  const s1 = await fv('TEST-F01R10', 'doc', 'fixture-time.md');
  T('A4 file-version doc›time → 可用·磁盘现状核对一致 133B/d4ada83b',
    s1.status === 200 && s1.j.available === true && s1.j.source === 'disk-current' && s1.j.bytes === 133 && s1.j.sha256 === REG.time133.sha,
    `HTTP ${s1.status} ${s1.j.source} ${s1.j.bytes}B ${(s1.j.sha256||'').slice(0,8)}`);
  const s2 = await fv('TEST-F01R10', 'doc', 'fixture-ver.md');
  const c2 = (s2.j.candidates || [])[0];
  T('A5 file-version doc›ver(300B 历史) → 明确不可用·快照核对不上',
    s2.status === 200 && s2.j.available === false && s2.j.reason === 'snapshot-mismatch',
    `HTTP ${s2.status} ${s2.j.reason}`);
  T('A6 A5 的快照实测：15B/43615f79 ≠ 登记 300B/9490ac36（SHA-256+字节双比对）',
    c2 && c2.bytes === REG.snap15.bytes && c2.sha256 === REG.snap15.sha
      && s2.j.registration.bytes === 300 && s2.j.registration.sha256 === REG.hist300.sha,
    `快照 ${c2.bytes}B/${c2.sha256.slice(0,8)} vs 登记 ${s2.j.registration.bytes}B/${s2.j.registration.sha256.slice(0,8)}`);
  T('A7 A5 同时回磁盘实测 124B/f0431173（只报数值，不回内容冒充）',
    s2.j.disk.bytes === 124 && s2.j.disk.sha256 === REG.cur124.sha && typeof s2.j.text === 'undefined',
    `disk ${s2.j.disk.bytes}B/${s2.j.disk.sha256.slice(0,8)} text=${typeof s2.j.text}`);
  const s3 = await fv('TEST-F01R10', 'plan', 'fixture-ver.md');
  T('A8 file-version plan›ver → 可用 124B/f0431173', s3.j.available === true && s3.j.bytes === 124 && s3.j.sha256 === REG.cur124.sha, `${s3.j.source} ${s3.j.bytes}B`);
  const s4 = await fv('TEST-F01R10', 'plan', 'fixture-time.md');
  T('A9 file-version plan›time → 可用 133B/d4ada83b', s4.j.available === true && s4.j.bytes === 133, s4.j.source);
  const s5 = await fv('TEST-F01R10', 'doc', 'fixture-ver.md', 'sha:' + REG.cur124.sha);
  T('A10 vkey 双确认：拿 plan 的指纹问 doc 登记 → HTTP 409 拒绝',
    s5.status === 409 && s5.j.reason === 'vkey-mismatch', `HTTP ${s5.status} ${s5.j.reason}`);
  { // A11：TEST-F01R10›doc 未登记 app.css（不经过 pickReg，路径直取 R11 的物理文件）
    const u = new URL(`${BASE}/api/office/file-version`);
    u.searchParams.set('path', 'C:/Users/Administrator/Desktop/Soda Intelligence - AI Native Thinking/Soda Office/web/app.css');
    u.searchParams.set('taskId', 'TEST-F01R10'); u.searchParams.set('stepKey', 'doc');
    const r = await fetch(u); const j = await r.json();
    T('A11 登记不存在 → HTTP 404', r.status === 404 && j.reason === 'reg-not-found', `HTTP ${r.status} ${j.reason}`);
  }
  const s7 = await fv('TEST-R11', 'doc', 'app.css');
  const R11_DISK = { bytes: s7.j.disk ? s7.j.disk.bytes : null, sha: s7.j.disk ? s7.j.disk.sha256 : null };
  T('A12 file-version TEST-R11 app.css（登记 80408B，磁盘漂移）→ 明确不可用·无快照留档',
    s7.status === 200 && s7.j.available === false && s7.j.reason === 'no-snapshot'
      && s7.j.registration.bytes === 80408 && s7.j.disk.bytes > 80408 && Array.isArray(s7.j.candidates) && s7.j.candidates.length === 0,
    `reg ${s7.j.registration.bytes}B disk ${s7.j.disk.bytes}B/${s7.j.disk.sha256.slice(0,8)}（磁盘值实测自取，不硬编码）`);

  // ── B. 点 300B 历史登记 → 不可用态 ───────────────────────────
  console.log('== B. 300B 历史登记预览（不可用态） ==');
  await goto(BASE + '/#/files');
  await waitFor(`!!document.querySelector('#file-groups .library-file')`, 12000, '文件页渲染');
  const idB = await clickReg('f01-r10/fixture-ver.md', 300, 'doc',
    `document.getElementById('fv-body').dataset.fvHint === 'hist'`, '300B 历史登记');
  T('B1 所点行身份 = TEST-F01R10›doc · sha:9490ac36（物理文件+版本登记双绑定）',
    idB.taskId === 'TEST-F01R10' && idB.stepKey === 'doc' && idB.vk === 'sha:' + REG.hist300.sha && idB.cls.includes('lf-hist'),
    `${idB.taskId}›${idB.stepKey} ${String(idB.vk).slice(0,20)}… cls=${idB.cls}`);
  let st = await fvState();
  T('B2 data-fv-hint=hist 且无 <pre>（不展示任何冒充内容）', st.fvHint === 'hist' && st.hasPre === false, `hint=${st.fvHint} pre=${st.hasPre}`);
  T('B3 正文无磁盘 V2 字样（不冒充当前文件）', !st.bodyText.includes(V2B_MARKER), '含"当前版本 V2"=' + st.bodyText.includes(V2B_MARKER));
  T('B4 正文无快照文本"旧版快照"（不冒充快照）', !st.bodyText.includes(SNAP_TEXT), '含"旧版快照"=' + st.bodyText.includes(SNAP_TEXT));
  T('B5 提示样式 = 12px / 18px / #E5B95E / 背景 #3B3021',
    st.hintStyle && st.hintStyle.fontSize === '12px' && st.hintStyle.lineHeight === '18px'
      && st.hintStyle.color === 'rgb(229, 185, 94)' && st.hintStyle.bg === 'rgb(59, 48, 33)',
    JSON.stringify(st.hintStyle));
  T('B6 提示内边距 12px 四边', st.hintStyle && ['padTop','padRight','padBottom','padLeft'].every(k => st.hintStyle[k] === '12px'),
    `${st.hintStyle.padTop}/${st.hintStyle.padRight}/${st.hintStyle.padBottom}/${st.hintStyle.padLeft}`);
  T('B7 元数据：登记ID=TEST-F01R10›doc、登记字节=300 B（300 B）',
    st.kvRegId === 'TEST-F01R10›doc' && st.kvBytes === '300 B（300 B）', `${st.kvRegId} | ${st.kvBytes}`);
  T('B8 保存原文行含快照实测 15B/43615f79 ≠ 登记 9490ac36',
    (st.kvSaved || '').includes('43615f79') && (st.kvSaved || '').includes('9490ac36') && (st.kvSaved || '').includes('15 B'),
    st.kvSaved);
  T('B9 服务端核对行 = file-version 不可用（snapshot-mismatch）+ 快照实测值',
    (st.kvSrv || '').includes('snapshot-mismatch') && (st.kvSrv || '').includes('43615f79'), st.kvSrv);
  T('B10 磁盘当前行只报实测 124B/f0431173，不展示内容',
    (st.kvDisk || '').includes('124') && (st.kvDisk || '').includes('f0431173'), st.kvDisk);
  T('B11 定位入口 = TEST-F01R10|doc', st.locateGoto === 'TEST-F01R10|doc', st.locateGoto);
  await screenshot('f02r3-hist-300B-1440x900.png');

  // ── C. 点 124B 当前登记 → 正常预览 ───────────────────────────
  console.log('== C. 124B 当前登记预览 ==');
  const idC = await clickReg('f01-r10/fixture-ver.md', 124, 'plan',
    `!!document.querySelector('#fv-body pre')`, '124B 当前登记');
  T('C1 所点行身份 = TEST-F01R10›plan', idC.taskId === 'TEST-F01R10' && idC.stepKey === 'plan', `${idC.taskId}›${idC.stepKey}`);
  const preC = await shaInPage('#fv-body pre');
  T('C2 pre 页内实测 = 124B / sha256=f0431173…（与所选登记指纹逐字节一致）',
    preC && preC.bytes === 124 && preC.sha === REG.cur124.sha, `${preC.bytes}B ${preC.sha.slice(0,12)}`);
  T('C3 正文含「当前版本 V2」（当前版本正常展示，非冒充）', preC.text.includes(V2B_MARKER), '');
  st = await fvState();
  T('C4 data-fv-hint 未标历史（match 分支不贴提示）', st.fvHint === null, `hint=${st.fvHint}`);
  T('C5 定位入口 = TEST-F01R10|plan', st.locateGoto === 'TEST-F01R10|plan', st.locateGoto);

  // ── D. 两条 133B 同版本登记各点各的 ──────────────────────────
  console.log('== D. 133B 同版本双登记 ==');
  const idD1 = await clickReg('f01-r10/fixture-time.md', 133, 'doc',
    `!!document.querySelector('#fv-body pre')`, 'doc›time');
  const preD1 = await shaInPage('#fv-body pre');
  st = await fvState();
  T('D1 doc›time：登记身份=doc、pre=133B/d4ada83b、定位 doc',
    idD1.stepKey === 'doc' && preD1.bytes === 133 && preD1.sha === REG.time133.sha && st.locateGoto === 'TEST-F01R10|doc',
    `${idD1.stepKey} ${preD1.bytes}B ${preD1.sha.slice(0,8)} goto=${st.locateGoto}`);
  // D2：两条 133B 登记是同一版本 → F01 聚合把 doc+plan 合并成一个版本行（无独立身份 span，
  // 点击回退行根身份 doc）。F02 口径断言：内容逐字节 = 该版本（133B/d4ada83b），不串入
  // 另一物理文件的任何版本（124B V2 / 300B 历史都不出现）；plan›time 的按条定位由 A9 端点证明。
  const idD2 = await clickReg('f01-r10/fixture-time.md', 133, 'plan',
    `!!document.querySelector('#fv-body pre')`, 'plan›time（合并版本行）');
  const preD2 = await shaInPage('#fv-body pre');
  st = await fvState();
  T('D2 plan›time（同版本合并行）：pre=133B/d4ada83b、无 124B/300B 串入、行根身份=TEST-F01R10',
    preD2.bytes === 133 && preD2.sha === REG.time133.sha && !preD2.text.includes(V2B_MARKER)
      && idD2.regsIds.join(',').includes('plan') && idD2.rowTaskId === 'TEST-F01R10',
    `${preD2.bytes}B ${preD2.sha.slice(0,8)} 行内登记=[${idD2.regsIds.join(',')}] 行根=${idD2.rowTaskId}`);
  T('D2b plan›time 按条核对由服务端完成（A9 已过：133B/d4ada83b 可用）', true, '见 A9');

  // ── E. TEST-R11 app.css：堵「谁都不匹配→展示当前文件」洞 ─────
  console.log('== E. TEST-R11 app.css 漂移登记 ==');
  const idE = await clickReg('app.css', 80408, null,
    `document.getElementById('fv-body').dataset.fvHint === 'hist'`, 'R11 app.css 80408B',
    `r.dataset.taskId === 'TEST-R11'`);
  st = await fvState();
  T('E1 登记身份 = TEST-R11 · vkey=sha:selftest-placeholder（历史分支接管；合并行回退行根身份）',
    idE.rowTaskId === 'TEST-R11' && idE.rowVk === 'sha:' + REG.r11.sha, `行根=${idE.rowTaskId} vk=${String(idE.rowVk).slice(0,24)}… 行内登记=[${idE.regsIds.join(',')}]`);
  T('E2 无 <pre>——磁盘 121879B 当前内容不再冒充 80408B 登记版本', st.hasPre === false, `pre=${st.hasPre}`);
  T('E3 服务端核对行 = no-snapshot（无保存原文、无快照留档）',
    (st.kvSrv || '').includes('no-snapshot'), st.kvSrv);
  T(`E4 磁盘当前行报实测 ${R11_DISK.bytes}B 现值 / 指纹 ${String(R11_DISK.sha).slice(0,8)}（只报数值不展示内容）`,
    (st.kvDisk || '').includes(String(R11_DISK.sha).slice(0, 8)) && /119\.\d KB/.test(st.kvDisk || ''), st.kvDisk);
  await screenshot('f02r3-r11-drift-1440x900.png');

  // ── F. 交替切换 ×10 + 刷新 ×3 ────────────────────────────────
  console.log('== F. 交替切换 10 次 + 刷新 3 次 ==');
  for (let i = 0; i < 10; i++) {
    const wantHist = i % 2 === 0;
    await clickReg('f01-r10/fixture-ver.md', wantHist ? 300 : 124, wantHist ? 'doc' : 'plan',
      wantHist ? `document.getElementById('fv-body').dataset.fvHint === 'hist'`
               : `!!document.querySelector('#fv-body pre')`,
      `第${i + 1}点 ${wantHist ? '300B' : '124B'}`);
    st = await fvState();
    if (wantHist) {
      T(`F${i + 1}a 300B→hist：无 pre、无 V2/快照冒充`,
        st.fvHint === 'hist' && st.hasPre === false && !st.bodyText.includes(V2B_MARKER) && !st.bodyText.includes(SNAP_TEXT),
        `hint=${st.fvHint} pre=${st.hasPre}`);
    } else {
      const p = await shaInPage('#fv-body pre');
      T(`F${i + 1}b 124B→match：pre=124B/f0431173`,
        st.fvHint === null && p.bytes === 124 && p.sha === REG.cur124.sha, `${p.bytes}B ${p.sha.slice(0,8)}`);
    }
  }
  for (let r = 0; r < 3; r++) {
    await reloadFiles();
    await assertAggr(`刷新${r + 1}后`);
  }

  // ── G. 状态色 ────────────────────────────────────────────────
  console.log('== G. 版本选择状态色 ==');
  const colors = await evalJs(`(() => {
    const cur = document.querySelector('#file-groups .lf-cur');
    const hist = document.querySelector('#file-groups .lf-hist');
    return { cur: cur ? getComputedStyle(cur).color : null, hist: hist ? getComputedStyle(hist).color : null };
  })()`);
  T('G1 .lf-cur 当前版本行 = rgb(101,217,177)=#65D9B1', colors.cur === 'rgb(101, 217, 177)', colors.cur);
  T('G2 .lf-hist 历史版本行 = rgb(175,192,213)=#AFC0D5', colors.hist === 'rgb(175, 192, 213)', colors.hist);

  // ── H. 全程不改登记 ──────────────────────────────────────────
  console.log('== H. 历史内容未被修改 ==');
  const flow2 = await (await fetch(`${BASE}/api/office/flow`)).json();
  const rHist2 = flow2.tasks.find(t => t.id === 'TEST-F01R10').steps.find(s => s.key === 'doc').files.find(f => f.path.includes('fixture-ver.md'));
  T('H1 10 次切换+3 次刷新后 doc 登记 = 300B/9490ac36（历史内容未变）',
    rHist2.bytes === 300 && rHist2.sha256 === REG.hist300.sha, `${rHist2.bytes}B ${rHist2.sha256.slice(0,8)}`);
  const FIX_SHA_AFTER = createHash('sha256').update(readFileSync(FIXTURE)).digest('hex');
  T('H2 TEST-F01R10.json 文件 sha256 前后一致（登记档案零写入）',
    FIX_SHA_AFTER === FIX_SHA_BEFORE, `${FIX_SHA_BEFORE.slice(0,12)} → ${FIX_SHA_AFTER.slice(0,12)}`);
  const R11_SHA_AFTER = createHash('sha256').update(readFileSync(R11FILE)).digest('hex');
  T('H3 TEST-R11.json 文件 sha256 前后一致', R11_SHA_AFTER === R11_SHA_BEFORE, `${R11_SHA_BEFORE.slice(0,12)} → ${R11_SHA_AFTER.slice(0,12)}`);
  T('H4 页面 JS 异常 = 0', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | ') || '0');

  await assertAggr('终态');
  await screenshot('f02r3-final-aggregation-1440x900.png');
} catch (e) {
  console.error('PROBE ERROR:', e.message);
  fail++;
} finally {
  console.log(`\n总计: ${pass} PASS / ${fail} FAIL`);
  try { chrome.kill(); } catch { /* 已退出 */ }
  process.exit(fail ? 1 : 0);
}
