// F02 第 4 轮验证：历史版本预览读取对应快照而非当前文件
// 运行：node f02r4-verify.mjs（自起 Chrome CDP 9478 headless；8090 服务 r11d）
// 本轮改动：A) file-version 请求 cache:'no-store'——删快照后同会话不得复用 HTTP 缓存旧成功
//           B) 服务端明确回答不可用后不再退回页内候选核对（页内 flow 副本可能滞后）
//           C) 不可用态「保存原文」行以服务端实测候选为准
//           D) F01 夹具 300B 历史登记快照重建（f02r4-fix-fixture.mjs，数据修复如实声明）
// 覆盖（对照验收三条）：
//   ① 4 条登记逐一 file-version：返回内容 SHA-256/字节数 = 登记保存值（node crypto 复算）
//   ② 新旧交替 ≥20 次：API 交替 20 次 + UI 点击 20 轮×2 击，每次内容逐字节断言（无串版/无缓存污染）
//   ③ 同会话删快照→再点同条登记：明确失败（no-snapshot）、无 pre、无当前文件内容；
//      刷新重进仍失败；.fv-hint 样式五项实测；恢复快照后复原；聚合恒 2 物理文件/4 登记
import { connect, send, evalJs, waitFor, goto, screenshot, pageErrors, BASE } from './f01r9-lib.mjs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP = 9478;
const FIXTURE = 'C:/Tools/agent-autoloop/office-data/tasks/TEST-F01R10.json';
const VER_DISK = 'C:/Users/Administrator/Desktop/Soda Intelligence - AI Native Thinking/Soda Office/web/verify-assets/f01-r10/fixture-ver.md';
const hash = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const blen = (s) => Buffer.byteLength(s, 'utf8');

// 地面真值：重建后的夹具登记 + 磁盘现状（脚本全程不修改，删除/恢复只在 D/F 段显式发生）
const FIX_STR_BEFORE = readFileSync(FIXTURE, 'utf8');
const fix = JSON.parse(FIX_STR_BEFORE);
const regOf = (step, frag) => fix.steps[step].files.find((f) => f.path.includes(frag));
const HIST = regOf('doc', 'fixture-ver.md');   // 300B 历史登记（快照留档，本轮重建）
const CUR = regOf('plan', 'fixture-ver.md');   // 124B 当前登记（磁盘一致）
const TD = regOf('doc', 'fixture-time.md');    // 133B
const TP = regOf('plan', 'fixture-time.md');   // 133B
const V1_TEXT = HIST.history[0].snapshot;
const V2_TEXT = readFileSync(VER_DISK, 'utf8');
const TIME_TEXT = readFileSync('C:/Users/Administrator/Desktop/Soda Intelligence - AI Native Thinking/Soda Office/web/verify-assets/f01-r10/fixture-time.md', 'utf8');
const V1_MARKER = 'V1 历史版本原文';
const V2B_MARKER = '当前版本 V2';
if (blen(V1_TEXT) !== 300 || blen(V2_TEXT) !== 124) throw new Error('地面真值异常');

let pass = 0, fail = 0;
const T = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`); ok ? pass++ : fail++; };

const fvApi = async (reg, step, vkey) => {
  const u = new URL(`${BASE}/api/office/file-version`);
  u.searchParams.set('path', reg.path); u.searchParams.set('taskId', 'TEST-F01R10'); u.searchParams.set('stepKey', step);
  if (vkey) u.searchParams.set('vkey', vkey);
  const r = await fetch(u); return { status: r.status, j: await r.json() };
};
// 逐条登记核对：返回内容 node crypto 复算 SHA-256/字节数 == 登记保存值，且内容逐字节等于预期原文
const checkReg = (label, r, step, wantSource, wantText) => {
  const { status, j } = r;
  T(`${label} available:true source=${wantSource}`,
    status === 200 && j.available === true && j.source === wantSource, `HTTP ${status} ${j.source}`);
  T(`${label} 返回内容 SHA-256 = 登记保存值`,
    hash(j.text) === j.sha256 && j.sha256 === (j.registration && j.registration.sha256),
    `${hash(j.text).slice(0, 12)}… vs 登记 ${(j.registration && j.registration.sha256 || '').slice(0, 12)}…`);
  T(`${label} 返回内容字节数 = 登记保存值`,
    blen(j.text) === j.bytes && j.bytes === j.registration.bytes, `${blen(j.text)} B vs 登记 ${j.registration.bytes} B`);
  T(`${label} 内容逐字节 = ${wantSource === 'snapshot' ? '快照留档' : '磁盘现状'}`,
    j.text === wantText, `相等=${j.text === wantText}`);
};

const waitRow = (frag) => waitFor(
  `!![...document.querySelectorAll('#file-groups .library-file')].find(r => (r.dataset.openFile||'').includes('${frag}'))`,
  25000, `行出现: ${frag}`);
// 点某条登记行并等预览稳定。settle 用内容锚（防上一态残留 pre 造成假通过）。
const clickReg = async (frag, bytes, stepKey, settleExpr, label) => {
  await waitRow(frag);
  const clicked = await evalJs(`(() => {
    const row = [...document.querySelectorAll('#file-groups .library-file')].find(r => (r.dataset.openFile||'').includes('${frag}'));
    if (!row) return 'no-row';
    const span = [...row.querySelectorAll('.lf-reg')].find(s => {
      try { return JSON.parse(s.dataset.regs || '[]').some(r => r.bytes === ${bytes}${stepKey ? ` && String(r.id||'').includes('›${stepKey}')` : ''}); } catch { return false; }
    });
    if (!span) return 'no-span';
    span.click();
    return JSON.stringify({ vk: span.dataset.regVkey || null, taskId: span.dataset.taskId || null, stepKey: span.dataset.stepKey || null, cls: span.className });
  })()`);
  if (typeof clicked !== 'string' || clicked === 'no-row' || clicked === 'no-span') throw new Error(`点击失败 ${label}: ${clicked}`);
  await waitFor(settleExpr, 12000, `预览稳定: ${label}`);
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
    fvHint: body.dataset.fvHint || null, hasPre: !!pre, bodyText: body.textContent,
    hintStyle: cs ? { fontSize: cs.fontSize, lineHeight: cs.lineHeight, color: cs.color, bg: cs.backgroundColor,
      padTop: cs.paddingTop, padRight: cs.paddingRight, padBottom: cs.paddingBottom, padLeft: cs.paddingLeft } : null,
    kvRegId: kv('登记ID'), kvSaved: kv('保存原文'), kvSrv: kv('服务端核对'), kvDisk: kv('磁盘当前'),
    preText: pre ? pre.textContent : null,
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
  T(`${tag} 聚合 = 2 物理文件 / 4 条登记（登记不因物理去重丢失）`,
    !!a && a.rows === 2 && a.regs === 4 && a.summary.includes('2 个产物') && a.summary.includes('4 条登记'),
    a ? `rows=${a.rows} regs=${a.regs}｜${a.summary.trim()}` : 'no group');
});
const assertHintStyle = (tag, st) => {
  T(`${tag} .fv-hint 样式 = 12px / 18px / #E5B95E`,
    st.hintStyle && st.hintStyle.fontSize === '12px' && st.hintStyle.lineHeight === '18px' && st.hintStyle.color === 'rgb(229, 185, 94)',
    JSON.stringify({ f: st.hintStyle && st.hintStyle.fontSize, l: st.hintStyle && st.hintStyle.lineHeight, c: st.hintStyle && st.hintStyle.color }));
  T(`${tag} .fv-hint 内边距 12px 四边（背景 #3B3021）`,
    st.hintStyle && ['padTop','padRight','padBottom','padLeft'].every(k => st.hintStyle[k] === '12px') && st.hintStyle.bg === 'rgb(59, 48, 33)',
    `${st.hintStyle && st.hintStyle.padTop}/${st.hintStyle && st.hintStyle.padRight}/${st.hintStyle && st.hintStyle.padBottom}/${st.hintStyle && st.hintStyle.padLeft} bg=${st.hintStyle && st.hintStyle.bg}`);
};

// ── 起 Chrome ──────────────────────────────────────────────────
const profile = mkdtempSync(join(tmpdir(), 'f02r4-cdp-'));
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore' });
try {
  await connect(CDP);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  // ── ① A. 4 条登记逐一：返回内容 SHA-256/字节数 = 保存值 ──────
  console.log('== A. 4 条登记逐一 file-version（SHA-256+字节复算） ==');
  const flow = await (await fetch(`${BASE}/api/office/flow`)).json();
  const t = flow.tasks.find((x) => x.id === 'TEST-F01R10');
  const flowReg = (step, frag) => t.steps.find((s) => s.key === step).files.find((f) => f.path.includes(frag));
  T('A0 flow 与夹具登记一致（300B/8243f36a、124B/f0431173、133B×2/d4ada83b）',
    flowReg('doc','fixture-ver.md').bytes === 300 && flowReg('doc','fixture-ver.md').sha256 === HIST.sha256
    && flowReg('plan','fixture-ver.md').sha256 === CUR.sha256
    && flowReg('doc','fixture-time.md').sha256 === TD.sha256 && flowReg('plan','fixture-time.md').sha256 === TP.sha256,
    `doc=300B/${HIST.sha256.slice(0,8)}`);
  checkReg('A1 doc›fixture-ver.md（300B 历史）', await fvApi(HIST, 'doc', 'sha:' + HIST.sha256), 'doc', 'snapshot', V1_TEXT);
  checkReg('A2 plan›fixture-ver.md（124B 当前）', await fvApi(CUR, 'plan', 'sha:' + CUR.sha256), 'plan', 'disk-current', V2_TEXT);
  checkReg('A3 doc›fixture-time.md（133B）', await fvApi(TD, 'doc', 'sha:' + TD.sha256), 'doc', 'disk-current', TIME_TEXT);
  checkReg('A4 plan›fixture-time.md（133B）', await fvApi(TP, 'plan', 'sha:' + TP.sha256), 'plan', 'disk-current', TIME_TEXT);
  { const { status, j } = await fvApi(HIST, 'doc', 'sha:' + CUR.sha256);
    T('A5 vkey 双确认：拿 plan 指纹问 doc 登记 → HTTP 409', status === 409 && j.reason === 'vkey-mismatch', `HTTP ${status} ${j.reason}`); }
  { const u = new URL(`${BASE}/api/office/file-version`);
    u.searchParams.set('path', 'C:/Users/Administrator/Desktop/Soda Intelligence - AI Native Thinking/Soda Office/web/app.css');
    u.searchParams.set('taskId', 'TEST-F01R10'); u.searchParams.set('stepKey', 'doc');
    const r = await fetch(u); const j = await r.json();
    T('A6 登记不存在 → HTTP 404', r.status === 404 && j.reason === 'reg-not-found', `HTTP ${r.status} ${j.reason}`); }

  // ── ②a B. API 交替 20 次（新旧版本互切，逐次内容断言） ───────
  console.log('== B. API 新旧交替 20 次 ==');
  let apiAltOK = true;
  for (let i = 0; i < 20; i++) {
    const wantHist = i % 2 === 0;
    const { j } = wantHist ? await fvApi(HIST, 'doc', 'sha:' + HIST.sha256) : await fvApi(CUR, 'plan', 'sha:' + CUR.sha256);
    const good = j.available === true && hash(j.text) === (wantHist ? HIST : CUR).sha256
      && blen(j.text) === (wantHist ? HIST : CUR).bytes && j.text === (wantHist ? V1_TEXT : V2_TEXT);
    if (!good) { apiAltOK = false; console.log(`  第${i + 1}次失配: ${j.source} ${blen(j.text || '')}B`); }
  }
  T('B1 API 交替 20 次（10×旧+10×新）全部逐字节一致，无串版', apiAltOK, '20/20');

  // ── ②b C. UI 点 300B 历史登记 → hist-saved：pre = 快照原文 ────
  console.log('== C. UI 历史登记预览（hist-saved） ==');
  await goto(BASE + '/#/files');
  await waitFor(`!!document.querySelector('#file-groups .library-file')`, 12000, '文件页渲染');
  const idC = await clickReg('f01-r10/fixture-ver.md', 300, 'doc',
    `(() => { const b = document.getElementById('fv-body'); const p = b.querySelector('pre'); return b.dataset.fvHint === 'hist-saved' && !!p && p.textContent.includes('${V1_MARKER}'); })()`,
    '300B 历史登记');
  T('C1 所点行身份 = TEST-F01R10›doc · sha:8243f36a（行内绑定该登记指纹）',
    idC.taskId === 'TEST-F01R10' && idC.stepKey === 'doc' && idC.vk === 'sha:' + HIST.sha256 && idC.cls.includes('lf-hist'),
    `${idC.taskId}›${idC.stepKey} ${String(idC.vk).slice(0, 18)}…`);
  const preC = await shaInPage('#fv-body pre');
  T('C2 pre 页内 WebCrypto 实测 = 300B / sha256=8243f36a…（=登记保存指纹）',
    preC && preC.bytes === 300 && preC.sha === HIST.sha256, `${preC.bytes}B ${preC.sha.slice(0, 12)}…`);
  T('C3 pre 内容逐字节 = 快照留档原文（而非磁盘当前 124B 文件）',
    preC.text === V1_TEXT && !preC.text.includes(V2B_MARKER), `相等=${preC.text === V1_TEXT}`);
  let st = await fvState();
  T('C4 提示明示来源：服务端+页内双重核对一致', (st.bodyText || '').includes('双重核对一致'), '');
  await screenshot('f02r4-hist-saved-300B-1440x900.png');

  // ── ②c D. UI 新旧交替 20 轮（40 击，逐次断言） ────────────────
  console.log('== D. UI 新旧交替 20 轮 ×2 击 ==');
  let uiAltOK = true, uiAltFail = '';
  for (let i = 0; i < 20; i++) {
    await clickReg('f01-r10/fixture-ver.md', 300, 'doc',
      `(() => { const b = document.getElementById('fv-body'); const p = b.querySelector('pre'); return b.dataset.fvHint === 'hist-saved' && !!p && p.textContent.includes('${V1_MARKER}'); })()`,
      `第${i + 1}轮·旧`);
    let p1 = await shaInPage('#fv-body pre');
    if (!(p1.bytes === 300 && p1.sha === HIST.sha256 && p1.text === V1_TEXT)) { uiAltOK = false; uiAltFail = `第${i + 1}轮旧版失配 ${p1.bytes}B/${p1.sha.slice(0, 8)}`; break; }
    await clickReg('f01-r10/fixture-ver.md', 124, 'plan',
      `(() => { const p = document.querySelector('#fv-body pre'); return !!p && p.textContent.includes('${V2B_MARKER}'); })()`,
      `第${i + 1}轮·新`);
    let p2 = await shaInPage('#fv-body pre');
    let s2 = await fvState();
    if (!(p2.bytes === 124 && p2.sha === CUR.sha256 && p2.text === V2_TEXT && s2.fvHint === null)) { uiAltOK = false; uiAltFail = `第${i + 1}轮新版失配 ${p2.bytes}B/${p2.sha.slice(0, 8)} hint=${s2.fvHint}`; break; }
  }
  T('D1 UI 交替 20 轮（40 击）：每次 pre 逐字节 = 所点版本（旧 300B/8243f36a，新 124B/f0431173）',
    uiAltOK, uiAltOK ? '20/20 轮' : uiAltFail);

  // ── ③ E. 同会话删快照 → 再点同条：明确失败（缓存污染实测） ────
  console.log('== E. 同会话删快照 → 明确失败 ==');
  // E0 先点一次旧版确保成功（同一 URL 刚成功过，才有缓存污染可言）
  await clickReg('f01-r10/fixture-ver.md', 300, 'doc',
    `(() => { const b = document.getElementById('fv-body'); const p = b.querySelector('pre'); return b.dataset.fvHint === 'hist-saved' && !!p && p.textContent.includes('${V1_MARKER}'); })()`, 'E0 删前成功');
  T('E0 删前：同条登记 hist-saved 成功（300B 快照上屏）', (await shaInPage('#fv-body pre')).sha === HIST.sha256, '');
  // E1 服务端删快照（只删 snapshot 内容，版本记录条目保留）
  const delRec = JSON.parse(FIX_STR_BEFORE);
  delete delRec.steps.doc.files.find((x) => x.path.includes('f01-r10/fixture-ver.md')).history[0].snapshot;
  delRec.updatedAt = new Date().toISOString();
  writeFileSync(FIXTURE, JSON.stringify(delRec, null, 1) + '\n', 'utf8');
  const e1 = await fvApi(HIST, 'doc', 'sha:' + HIST.sha256);
  T('E1 删快照后 API → available:false reason=no-snapshot（不回内容）',
    e1.status === 200 && e1.j.available === false && e1.j.reason === 'no-snapshot' && typeof e1.j.text === 'undefined',
    `HTTP ${e1.status} ${e1.j.reason} text=${typeof e1.j.text}`);
  // E2 不刷新页面，直接再点同一条 300B 登记 → 必须明确失败
  await clickReg('f01-r10/fixture-ver.md', 300, 'doc',
    `(() => { const b = document.getElementById('fv-body'); return b.dataset.fvHint === 'hist' && !b.querySelector('pre'); })()`, 'E2 同会话再点');
  st = await fvState();
  T('E2 同会话再点 → data-fv-hint=hist、无 <pre>（明确失败，非缓存旧成功）',
    st.fvHint === 'hist' && st.hasPre === false, `hint=${st.fvHint} pre=${st.hasPre}`);
  T('E3 正文无当前文件内容（不冒充）、无旧快照内容（不上屏）',
    !st.bodyText.includes(V2B_MARKER) && !st.bodyText.includes('300B 版本（V1 快照留档）'),
    `含V2=${st.bodyText.includes(V2B_MARKER)} 含快照正文=${st.bodyText.includes('300B 版本（V1 快照留档）')}`);
  T('E4 服务端核对行 = no-snapshot', (st.kvSrv || '').includes('no-snapshot'), st.kvSrv);
  T('E5 保存原文行明示服务端实测无留档', (st.kvSaved || '').includes('服务端实测'), st.kvSaved);
  T('E6 登记身份仍 = TEST-F01R10›doc（登记未丢）', st.kvRegId === 'TEST-F01R10›doc', st.kvRegId);
  assertHintStyle('E7', st);
  await screenshot('f02r4-deleted-snapshot-fail-1440x900.png');

  // ── ③ F. 删快照后刷新重进 → 仍明确失败；聚合不变 ─────────────
  console.log('== F. 删除后刷新重进 ==');
  try { await send('Page.reload', { ignoreCache: true }); } catch { /* 导航中 */ }
  await waitRow('f01-r10/fixture-ver.md');
  await clickReg('f01-r10/fixture-ver.md', 300, 'doc',
    `(() => { const b = document.getElementById('fv-body'); return b.dataset.fvHint === 'hist' && !b.querySelector('pre'); })()`, 'F1 刷新后点');
  st = await fvState();
  T('F1 刷新(ignoreCache)后仍明确失败：hist、无 pre、无 V2 冒充',
    st.fvHint === 'hist' && st.hasPre === false && !st.bodyText.includes(V2B_MARKER), `hint=${st.fvHint}`);
  assertHintStyle('F2', st);
  assertAggr('F3 删快照后（删的是快照不是登记）');

  // ── G. 恢复快照 → 复原；档案逐字节还原；零异常 ────────────────
  console.log('== G. 恢复快照 ==');
  writeFileSync(FIXTURE, FIX_STR_BEFORE, 'utf8');
  try { await send('Page.reload', { ignoreCache: true }); } catch { /* 导航中 */ }
  await waitRow('f01-r10/fixture-ver.md');
  await clickReg('f01-r10/fixture-ver.md', 300, 'doc',
    `(() => { const b = document.getElementById('fv-body'); const p = b.querySelector('pre'); return b.dataset.fvHint === 'hist-saved' && !!p && p.textContent.includes('${V1_MARKER}'); })()`, 'G1 恢复后点');
  const pG = await shaInPage('#fv-body pre');
  T('G1 恢复后 hist-saved 复原：pre=300B/8243f36a 且逐字节=快照',
    pG.bytes === 300 && pG.sha === HIST.sha256 && pG.text === V1_TEXT, `${pG.bytes}B ${pG.sha.slice(0, 8)}`);
  assertAggr('G2 终态');
  T('G3 TEST-F01R10.json 逐字节还原（=重建版）', readFileSync(FIXTURE, 'utf8') === FIX_STR_BEFORE, '');
  T('G4 页面 JS 异常 = 0', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | ') || '0');
  await screenshot('f02r4-restored-aggregation-1440x900.png');
} catch (e) {
  console.error('PROBE ERROR:', e.message);
  fail++;
} finally {
  console.log(`\n总计: ${pass} PASS / ${fail} FAIL`);
  try { chrome.kill(); } catch { /* 已退出 */ }
  process.exit(fail ? 1 : 0);
}
