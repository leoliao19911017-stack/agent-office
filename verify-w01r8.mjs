// verify-w01r8.mjs — W01 第 8 轮独立验收（测试例外与正式审批的版本校验边界）。
// 只读代码不代码，运行时按用例创建一次性夹具，测完清理恢复：
//   P0 夹具：TEST-W01R8F（正式，无策略，kind:'plan'）与 TEST-W01R8T（test-any-file，
//            kind:'test-artifact'）登记同一个共享文件同一份 bytes/sha256——
//            唯一变量是策略声明，A/B 对照「例外不扩大到普通需求」。
//   P1 API 矩阵（curl 同口径 fetch）：
//            F1 未变化→200 / F2 字节变化→409 / F2b 同尺寸内容变化→409(why:sha)
//            T1 未变化→200 / T2 字节变化→200(例外) / T2b 同尺寸→200(例外)
//            R11 真实档案按现状审批→200(例外)，随后逐字节恢复。
//            每例核对：version-gate 判定、decide HTTP、任务档案 plan.status。
//   P2 页面（headless Chrome CDP）：
//            F3 页面打开后文件再变化：草稿留存、409 反馈、无成功提示、
//               主操作收敛为禁用（本轮新增强制重拉）、警示块出现、刷新后与服务端一致。
//            T3 测试流程同场景：例外放行→200→页面/刷新一致。
//            R11 现状页面：警示块 + 例外尾部文案 + 主操作可用 + 计算样式实测。
//            计算样式抽查 .material-mismatch（12px/18px/#3B3021/#E5B95E/6px/6px 10px）。
//   P3 清理：夹具任务与共享文件删除、TEST-R11.json 按基线 sha256 恢复。
// 用法：node --experimental-websocket verify-w01r8.mjs

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP_PORT = 9341;
const BASE = 'http://127.0.0.1:8090';
const DATA = 'C:/Tools/agent-autoloop/office-data';
const TASKS = join(DATA, 'tasks');
const TMPDIR = join(DATA, 'tmp-w01r8');
const SHARED = join(TMPDIR, 'w01r8-shared.md');
const F_ID = 'TEST-W01R8F', T_ID = 'TEST-W01R8T', R11 = 'TEST-R11';
const R11_BASELINE_SHA = '0dd1e387c7908d9251f2cecb46083663428f88b8b723d74426dd23055b646087';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ---- 与 round7 相同的 CDP 直连骨架 -------------------------------------------
class CDP {
  constructor(ws) {
    this.sock = ws; this.id = 0; this.pending = new Map(); this.netlog = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Network.responseReceived') {
        const u = (m.params.response || {}).url || '';
        if (u.includes('/api/office/')) this.netlog.push({ url: u.replace(BASE, ''), status: m.params.response.status });
      }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      }
    });
  }
  static async connect(url) {
    const { WebSocket } = globalThis;
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    return new CDP(ws);
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.sock.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('page eval failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  }
}

// ---- 服务端口径助手 -----------------------------------------------------------
async function api(path, body) {
  const res = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let j = null; try { j = await res.json(); } catch { /* 保持 null 如实 */ }
  return { status: res.status, body: j };
}
const readTask = (id) => JSON.parse(readFileSync(join(TASKS, `${id}.json`), 'utf8'));
const planStatus = (id) => readTask(id).steps.plan.status;
const freshOpId = (tag) => `w01r8-${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
// 服务端原始响应的 drifted 条目字段是 regBytes/actBytes（app.js 里的 regB/actB 是前端映射名）
const gateOf = (b) => b && ({ src: b.src, policy: b.policy ? b.policy.mode : null, valid: b.valid, versionExempt: b.versionExempt, drifted: (b.drifted || []).map((d) => ({ why: d.why, regB: d.regBytes, actB: d.actBytes })) });
const decideOf = (b) => b && ({ ok: b.ok, status: b.status, code: b.code || null, msg: (b.msg || b.error || '').slice(0, 90) });

// ---- 夹具 ---------------------------------------------------------------------
// 内容版本：v1 基线（登记值）；v2 追加一行（字节变化）；v2b 等长改写末字符（同尺寸内容变化）。
const V1 = 'W01R8 shared artifact baseline v1\n86075a19 probe line\n';
const V2 = V1 + 'appended after registration (bytes changed)\n';
const V2B = V1.slice(0, -2) + '2\n';   // 与 V1 逐字节等长，仅末位字符不同
const reg = { bytes: Buffer.byteLength(V1), sha: sha256(Buffer.from(V1)) };

function fixtureJson(id, title, policy, kind) {
  const now = '2026-11-16T09:40:00.000Z';
  const done = { status: 'done', at: now, note: '', by: 'selftest', files: [], runs: [] };
  const planFile = [{ path: SHARED, bytes: reg.bytes, sha256: reg.sha, kind }];
  const j = {
    id, title, createdAt: now, updatedAt: now,
    steps: {
      req: { ...done },
      doc: { ...done },
      plan: { status: 'awaiting', at: now, note: '', by: 'selftest', files: planFile, runs: [] },
      brief: { status: 'awaiting', at: now, note: '', by: 'selftest', files: [], runs: [] },
      deliverable: { status: 'pending', at: null, note: '', by: null, files: [], runs: [] },
      verify: { status: 'pending', at: null, note: '', by: null, files: [], runs: [] },
      final: { status: 'pending', at: null, note: '', by: null, files: [], runs: [] },
    },
  };
  if (policy) j.artifactPolicy = policy;
  return j;
}
const POLICY = { mode: 'test-any-file', basis: 'W01 第 8 轮验收一次性夹具：占位产物，任意登记产物均可作为审批对象验证流程；测完即删。' };
const writeF = () => writeFileSync(join(TASKS, `${F_ID}.json`), JSON.stringify(fixtureJson(F_ID, 'W01R8 正式需求夹具（测完即删）', null, 'plan'), null, 2));
const writeT = () => writeFileSync(join(TASKS, `${T_ID}.json`), JSON.stringify(fixtureJson(T_ID, 'W01R8 测试策略夹具（测完即删）', POLICY, 'test-artifact'), null, 2));
const writeV = (s) => writeFileSync(SHARED, s);

// ---- 断言与记录 ---------------------------------------------------------------
const out = { when: new Date().toISOString(), api: [], page: {}, styles: {}, cleanup: {} };
let fails = 0;
function check(name, cond, detail) {
  const ok = cond === true;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  |  ' + JSON.stringify(detail) : ''}`);
  return ok;
}

// ---- P1 API 矩阵 --------------------------------------------------------------
async function apiCase(tag, taskId) {
  const g = await api('/api/office/version-gate', { taskId, stepKey: 'plan' });
  const d = await api('/api/office/decide', { taskId, step: 'plan', action: 'approve', note: `W01R8 验收 ${tag}`, opId: freshOpId(tag) });
  const rec = { tag, taskId, gateHttp: g.status, gate: gateOf(g.body), decideHttp: d.status, decide: decideOf(d.body), planStatus: planStatus(taskId) };
  out.api.push(rec);
  console.log(`\n--- ${tag} ---`); console.log(JSON.stringify(rec));
  return rec;
}

// ---- P2 页面 ------------------------------------------------------------------
const STATE = `(() => {
  const btn = document.querySelector('#insp-foot [data-decide="approve"]');
  const mm = document.querySelector('#insp-body .material-mismatch');
  const ta = document.getElementById('ip-decide-note');
  const fbErr = document.querySelector('#insp-foot .fb.err, #insp-body .fb.err');
  const fbOk = document.querySelector('#insp-body .done-line');
  const node = document.querySelector('.track-node[data-step="plan"]');
  return {
    approveBtn: btn ? { disabled: btn.disabled, invalidCls: btn.className.includes('btn-invalid-material') } : null,
    mismatch: mm ? mm.textContent.replace(/\\s+/g, ' ').trim().slice(0, 260) : null,
    noteDraft: ta ? ta.value : null,
    fbErr: fbErr ? fbErr.textContent.replace(/\\s+/g, ' ').trim().slice(0, 160) : null,
    doneLine: fbOk ? fbOk.textContent.replace(/\\s+/g, ' ').trim().slice(0, 120) : null,
    stepCls: node ? node.className : null,
  };
})()`;
const MM_STYLE = `(() => {
  const mm = document.querySelector('#insp-body .material-mismatch');
  if (!mm) return null;
  const c = getComputedStyle(mm); const b = mm.getBoundingClientRect();
  return { font: c.fontSize, lh: c.lineHeight, bg: c.backgroundColor, color: c.color, radius: c.borderRadius, pad: c.padding, rect: { w: +b.width.toFixed(1), h: +b.height.toFixed(1) } };
})()`;
const MM_SPEC = { font: '12px', lh: '18px', bg: 'rgb(59, 48, 33)', color: 'rgb(229, 185, 94)', radius: '6px', pad: '6px 10px' };
// 页面内 fetch 钩子：记录审批 POST 的真实 HTTP 状态（比 CDP Network 域观察更直接；导航后需重装）
const HOOK = `(() => { window.__w01net = window.__w01net || []; const of = window.fetch.bind(window); window.fetch = async (...a) => { const r = await of(...a); try { window.__w01net.push({ url: String(a[0]).replace(location.origin, ''), status: r.status }); } catch { } return r; }; return true; })()`;

async function selectTaskStep(cdp, taskId) {
  await cdp.eval(`document.querySelector('.req-item[data-task="${taskId}"]')?.click()`);
  await sleep(500);
  await cdp.eval(`document.querySelector('.track-node[data-step="plan"]')?.click()`);
  await sleep(1200);
}
async function waitApproveReady(cdp, wantDisabled) {
  for (let i = 0; i < 40; i++) {
    const s = await cdp.eval(`(() => { const b = document.querySelector('#insp-foot [data-decide="approve"]'); return b ? b.disabled : null; })()`);
    if (s === wantDisabled) return true;
    await sleep(250);
  }
  return false;
}

// ---- 主流程 -------------------------------------------------------------------
async function main() {
  // P0 夹具与基线
  const r11File = join(TASKS, `${R11}.json`);
  const r11Snap = join(tmpdir(), `w01r8-r11-snap-${Date.now()}.json`);
  copyFileSync(r11File, r11Snap);
  const r11Pre = sha256(readFileSync(r11File));
  check('P0 R11 基线哈希与验收口径一致', r11Pre === R11_BASELINE_SHA, { r11Pre });

  mkdirSync(TMPDIR, { recursive: true });
  writeV(V1); writeF(); writeT();
  const sharedStat = { bytes: existsSync(SHARED) ? Buffer.byteLength(readFileSync(SHARED)) : -1 };
  check('P0 共享文件落盘且与登记字节一致', sharedStat.bytes === reg.bytes, { actual: sharedStat.bytes, reg: reg.bytes });

  // P1-1 正式流程：未变化 → 通过
  let r = await apiCase('F1-formal-unchanged', F_ID);
  check('F1 gate valid:true 无漂移', r.gateHttp === 200 && r.gate.valid === true && r.gate.drifted.length === 0, r.gate);
  check('F1 decide 200 且档案 plan=done', r.decideHttp === 200 && r.planStatus === 'done', { http: r.decideHttp, plan: r.planStatus });
  writeF();

  // P1-2 正式流程：字节变化 → 409
  writeV(V2);
  r = await apiCase('F2-formal-bytes-changed', F_ID);
  check('F2 gate valid:false why:bytes（原始字节数比对）', r.gate.valid === false && r.gate.drifted[0].why === 'bytes' && r.gate.drifted[0].regB === reg.bytes && r.gate.drifted[0].actB === Buffer.byteLength(V2), r.gate);
  check('F2 decide 409 ARTIFACT_VERSION_DRIFT 且档案 plan=awaiting', r.decideHttp === 409 && /ARTIFACT_VERSION_DRIFT/.test(r.decide.code || '') && r.planStatus === 'awaiting', { http: r.decideHttp, code: r.decide.code, plan: r.planStatus });
  writeV(V1);

  // P1-3 正式流程：同尺寸内容变化 → 409（字节一致后比内容哈希）
  writeV(V2B);
  r = await apiCase('F2b-formal-same-size-changed', F_ID);
  check('F2b gate valid:false why:sha（等长内容变化不漏检）', r.gate.valid === false && r.gate.drifted[0].why === 'sha' && r.gate.drifted[0].regB === r.gate.drifted[0].actB, r.gate);
  check('F2b decide 409 且档案 plan=awaiting', r.decideHttp === 409 && r.planStatus === 'awaiting', { http: r.decideHttp, plan: r.planStatus });
  writeV(V1);

  // P1-4/5/6 测试策略流程：同一文件同一漂移，仅策略不同 → 例外放行
  r = await apiCase('T1-test-unchanged', T_ID);
  check('T1 gate valid:true versionExempt:true', r.gate.valid === true && r.gate.versionExempt === true && r.gate.drifted.length === 0, r.gate);
  check('T1 decide 200 且档案 plan=done', r.decideHttp === 200 && r.planStatus === 'done', { http: r.decideHttp, plan: r.planStatus });
  writeT();

  writeV(V2);   // 与 F2 完全相同的漂移
  r = await apiCase('T2-test-bytes-changed', T_ID);
  check('T2 同一漂移在测试流程：valid:true 漂移照报（不因豁免隐藏）', r.gate.valid === true && r.gate.versionExempt === true && r.gate.drifted[0].why === 'bytes' && r.gate.drifted[0].regB === reg.bytes && r.gate.drifted[0].actB === Buffer.byteLength(V2), r.gate);
  check('T2 decide 200（例外条件成立才放行）且档案 plan=done', r.decideHttp === 200 && r.planStatus === 'done', { http: r.decideHttp, plan: r.planStatus });
  writeT(); writeV(V1);

  writeV(V2B);
  r = await apiCase('T2b-test-same-size-changed', T_ID);
  check('T2b 等长漂移同样走例外 200', r.decideHttp === 200 && r.gate.drifted[0].why === 'sha' && r.planStatus === 'done', { http: r.decideHttp, why: r.gate.drifted[0] && r.gate.drifted[0].why, plan: r.planStatus });
  writeT(); writeV(V1);

  // P1-7 R11 真实档案按现状审批（既有测试例外保持）
  const r11Gate = await api('/api/office/version-gate', { taskId: R11, stepKey: 'plan' });
  const r11g = gateOf(r11Gate.body);
  const appCssBytes = (await api('/api/office/file-check', { paths: ['C:/Users/Administrator/Desktop/Soda Intelligence - AI Native Thinking/Soda Office/web/app.css'] })).body;
  const r11Decide = await api('/api/office/decide', { taskId: R11, step: 'plan', action: 'approve', note: 'W01R8 验收：R11 既有测试例外按策略放行核对', opId: freshOpId('r11') });
  out.api.push({ tag: 'R11-real-as-is', gate: r11g, decideHttp: r11Decide.status, decide: decideOf(r11Decide.body), planStatus: planStatus(R11), appCssActual: (appCssBytes && appCssBytes.results && appCssBytes.results[0] && appCssBytes.results[0].bytes) || null });
  check('R11 现状 gate：漂移照报(80408→实测) + versionExempt:true valid:true', r11g.valid === true && r11g.versionExempt === true && r11g.drifted[0].why === 'bytes' && r11g.drifted[0].regB === 80408, r11g);
  check('R11 现状审批按既有例外 200 且档案 plan=done', r11Decide.status === 200 && planStatus(R11) === 'done', { http: r11Decide.status });
  copyFileSync(r11Snap, r11File);   // 立即恢复，页面阶段前回到 awaiting
  check('R11 恢复后哈希与基线一致', sha256(readFileSync(r11File)) === R11_BASELINE_SHA);

  // P2 页面（headless Chrome）
  const profile = join(tmpdir(), `w01r8-cdp-${Date.now()}`);
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank',
  ], { stdio: 'ignore' });
  try {
    let targets = null;
    for (let i = 0; i < 50; i++) {
      try { const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`); targets = await res.json(); break; }
      catch { await sleep(200); }
    }
    if (!targets) throw new Error('chrome devtools port never came up');
    const cdp = await CDP.connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Network.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: BASE });
    for (let i = 0; i < 100; i++) { if (await cdp.eval(`!!document.querySelector('.req-item')`)) break; await sleep(200); }
    // 页面内 fetch 钩子：记录审批 POST 的真实 HTTP 状态（比 CDP Network 域观察更直接）
    await cdp.eval(HOOK);

    // ---- F3 正式流程：页面打开后文件再变化 → 409，草稿留存，状态收敛 ----
    writeF(); writeV(V1);
    await selectTaskStep(cdp, F_ID);
    check('F3 打开时主操作可用（文件未漂移）', await waitApproveReady(cdp, false));
    await cdp.eval(`(() => { const ta = document.getElementById('ip-decide-note'); ta.value = 'F3 草稿：正式流程页面打开后文件再变化'; ta.dispatchEvent(new Event('input', { bubbles: true })); return ta.value; })()`);
    writeV(V2);   // 页面不刷新，物理文件变
    await cdp.eval(`document.querySelector('#insp-foot [data-decide="approve"]').click()`);
    await sleep(4500);   // POST → 409 → 本轮新增：强制重拉 gate/filecheck → 重渲染
    const f3 = await cdp.eval(STATE);
    out.page.F3 = f3; console.log('\n--- F3 after-409 ---'); console.log(JSON.stringify(f3));
    check('F3 服务端 409 后页面报版本漂移错误、无成功提示', !!f3.fbErr && /版本|不一致/.test(f3.fbErr) && !f3.doneLine, { fbErr: f3.fbErr, doneLine: f3.doneLine });
    check('F3 备注草稿留存（用户输入不丢）', f3.noteDraft === 'F3 草稿：正式流程页面打开后文件再变化', { noteDraft: f3.noteDraft });
    check('F3 主操作收敛为禁用（前端状态=服务端判定）', f3.approveBtn && f3.approveBtn.disabled === true && f3.approveBtn.invalidCls === true, f3.approveBtn);
    check('F3 警示块出现并按登记/实测原始字节叙述', !!f3.mismatch && /登记/.test(f3.mismatch), { mismatch: (f3.mismatch || '').slice(0, 120) });
    check('F3 档案仍 awaiting（409 无副作用）', planStatus(F_ID) === 'awaiting');
    const decideCalls = await cdp.eval(`(window.__w01net || []).filter((n) => n.url.startsWith('/api/office/decis'))`);
    out.page.F3net = decideCalls;
    check('F3 浏览器内 decide 真实 HTTP 409', decideCalls.some((n) => n.status === 409), decideCalls);
    const f3Style = await cdp.eval(MM_STYLE); out.styles.F3 = f3Style;
    console.log('--- F3 .material-mismatch computed ---'); console.log(JSON.stringify(f3Style));
    let shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync('verify-w01r8-F3-after409.png', Buffer.from(shot.data, 'base64'));
    // 刷新一致性
    await cdp.send('Page.navigate', { url: BASE });
    for (let i = 0; i < 100; i++) { if (await cdp.eval(`!!document.querySelector('.req-item')`)) break; await sleep(200); }
    await selectTaskStep(cdp, F_ID);
    const f3r = await cdp.eval(STATE); out.page.F3refresh = f3r;
    await cdp.eval(HOOK);   // 刷新重置了钩子，为后续 T3/R11 的 POST 记录重装
    check('F3 刷新后与服务端一致：仍待拍板、警示在、主操作禁用', (f3r.stepCls || '').includes('st-awaiting') && f3r.approveBtn && f3r.approveBtn.disabled === true && !!f3r.mismatch, { stepCls: f3r.stepCls, approveBtn: f3r.approveBtn, mismatch: !!f3r.mismatch });

    // ---- T3 测试策略流程：页面打开后文件再变化 → 例外放行 → 状态一致 ----
    writeT(); writeV(V1);
    await selectTaskStep(cdp, T_ID);
    check('T3 打开时主操作可用', await waitApproveReady(cdp, false));
    writeV(V2);   // 同样的页面打开后漂移
    await cdp.eval(`document.querySelector('#insp-foot [data-decide="approve"]').click()`);
    await sleep(4500);
    const t3 = await cdp.eval(STATE); out.page.T3 = t3;
    console.log('\n--- T3 after-approve ---'); console.log(JSON.stringify(t3));
    check('T3 例外放行：页面显示已通过、无错误反馈', !!t3.doneLine && !t3.fbErr, { doneLine: t3.doneLine, fbErr: t3.fbErr });
    check('T3 档案 plan=done（例外条件成立才可过）', planStatus(T_ID) === 'done');
    shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync('verify-w01r8-T3-exception-pass.png', Buffer.from(shot.data, 'base64'));
    out.page.T3net = await cdp.eval(`(window.__w01net || []).filter((n) => n.url.startsWith('/api/office/decis'))`);   // 刷新前读，导航会换文档
    await cdp.send('Page.navigate', { url: BASE });
    for (let i = 0; i < 100; i++) { if (await cdp.eval(`!!document.querySelector('.req-item')`)) break; await sleep(200); }
    await selectTaskStep(cdp, T_ID);
    const t3r = await cdp.eval(STATE); out.page.T3refresh = t3r;
    await cdp.eval(HOOK);
    check('T3 刷新后与服务端一致（done 不再渲染通过按钮）', (t3r.stepCls || '').includes('st-done') && t3r.approveBtn === null, { stepCls: t3r.stepCls, approveBtn: t3r.approveBtn });

    // ---- R11 现状页面：既有例外的展示口径 + 计算样式 ----
    writeV(V1);
    await selectTaskStep(cdp, R11);
    check('R11 页面：主操作就绪（例外下可用）', await waitApproveReady(cdp, false));
    const r11p = await cdp.eval(STATE); out.page.R11 = r11p;
    console.log('\n--- R11 page ---'); console.log(JSON.stringify(r11p));
    check('R11 页面：警示块照报漂移且尾部说明为测试例外口径', !!r11p.mismatch && /test-any-file/.test(r11p.mismatch) && /不阻断本测试流程/.test(r11p.mismatch), { mismatch: (r11p.mismatch || '').slice(0, 200) });
    check('R11 页面：例外下主操作保持可用', r11p.approveBtn && r11p.approveBtn.disabled === false, r11p.approveBtn);
    const r11Style = await cdp.eval(MM_STYLE); out.styles.R11 = r11Style;
    console.log('--- R11 .material-mismatch computed ---'); console.log(JSON.stringify(r11Style));
    shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync('verify-w01r8-R11-exception.png', Buffer.from(shot.data, 'base64'));
    // R11 通过既有例外在页面上审批 → 200
    await cdp.eval(`document.querySelector('#insp-foot [data-decide="approve"]').click()`);
    await sleep(4500);
    const r11a = await cdp.eval(STATE); out.page.R11after = r11a;
    check('R11 页面审批放行（done），档案 plan=done', (r11a.stepCls || '').includes('st-done') && planStatus(R11) === 'done', { stepCls: r11a.stepCls });
    out.page.R11net = await cdp.eval(`(window.__w01net || []).filter((n) => n.url.startsWith('/api/office/decis'))`);
    check('T3/R11 浏览器内 decide 真实 HTTP 200', (out.page.T3net || []).some((n) => n.status === 200) && (out.page.R11net || []).some((n) => n.status === 200), { T3: out.page.T3net, R11: out.page.R11net });

    // 统一样式规格抽查（两处独立测量都要落在规格上）
    for (const [where, st] of [['F3', f3Style], ['R11', r11Style]]) {
      if (!st) { check(`样式 ${where}：警示块存在`, false); continue; }
      for (const [k, v] of Object.entries(MM_SPEC)) check(`样式 ${where} ${k} = ${v}`, st[k] === v, { got: st[k] });
    }
  } finally {
    try { chrome.kill(); } catch { /* 已退出 */ }
  }

  // P3 清理与恢复
  rmSync(join(TASKS, `${F_ID}.json`), { force: true });
  rmSync(join(TASKS, `${T_ID}.json`), { force: true });
  rmSync(TMPDIR, { recursive: true, force: true });
  copyFileSync(r11Snap, r11File);
  const r11Post = sha256(readFileSync(r11File));
  out.cleanup = { fixturesDeleted: !existsSync(join(TASKS, `${F_ID}.json`)) && !existsSync(join(TASKS, `${T_ID}.json`)), tmpDeleted: !existsSync(TMPDIR), r11Restored: r11Post === R11_BASELINE_SHA };
  check('P3 夹具任务与共享文件已删除', out.cleanup.fixturesDeleted && out.cleanup.tmpDeleted);
  check('P3 TEST-R11.json 逐字节恢复（sha256=基线）', out.cleanup.r11Restored, { r11Post });

  writeFileSync('verify-w01r8.json', JSON.stringify(out, null, 1));
  console.log(`\n===== W01R8 验收：${fails === 0 ? '全部通过' : fails + ' 项失败'} =====`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
