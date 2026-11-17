// W01 第15轮诊断探针：核实「右侧审批内容完全没有渲染」是否属实。
// 只读不改：开 headless Chrome → 打开 8090 → 查 JS 错误/模块加载/需求列表/
// 选 TEST-R11 plan 步骤 → 查 #insp-body/#insp-foot 渲染结果与审批按钮状态。
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP_PORT = 9345;
const BASE = 'http://127.0.0.1:8090';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws = null, msgId = 0;
const pending = new Map();
export const pageErrors = [];
function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP 超时: ${method}`)); } }, 15000);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evalJs(expression, awaitPromise = false) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) throw new Error('页面 JS 异常: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}
async function waitFor(expr, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    try { const v = await evalJs(expr); if (v) return v; } catch { /* 导航瞬间上下文切换 */ }
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时: ${label}`);
    await sleep(400);
  }
}

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'w01r15-'))}`,
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore' });

try {
  let page = null;
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      page = list.find((t) => t.type === 'page');
      if (page) break;
    } catch { /* retry */ }
    await sleep(300);
  }
  if (!page) throw new Error('CDP 页面没起来');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    } else if (m.method === 'Runtime.exceptionThrown') {
      pageErrors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '?');
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      pageErrors.push('console.error: ' + JSON.stringify(m.params.args?.map((a) => a.value ?? a.description)));
    }
  };
  await send('Runtime.enable');
  await send('Page.enable');

  await send('Page.navigate', { url: BASE });
  await sleep(2500);

  // 1) 模块与 JS 错误
  const modules = await evalJs(`(() => ({
    esc: typeof window.esc, api: typeof window.api,
    scheduleVersionGate: typeof window.scheduleVersionGate,
    decideHtml: typeof window.decideHtml, renderFiles: typeof window.renderFiles,
    bootFailed: !!document.querySelector('#boot-fail, .boot-fail'),
    title: document.title,
  }))()`);
  console.log('== 模块 ==', JSON.stringify(modules));
  const uiErr = await evalJs(`window.__uiErrors || 0`);
  console.log('== __uiErrors ==', uiErr, '| CDP 捕获异常 ==', pageErrors.length ? JSON.stringify(pageErrors.slice(0, 5)) : '无');

  // 2) 需求列表渲染
  const reqs = await waitFor(`(() => { const n = document.querySelectorAll('#reqs-list .req-item').length; return n > 0 ? n : null; })()`, 10000, '需求列表渲染');
  console.log('== 需求条数 ==', reqs);

  // 3) 选 TEST-R11 → plan 步骤
  await evalJs(`document.querySelector('.req-item[data-task="TEST-R11"]')?.click()`);
  await sleep(700);
  await evalJs(`document.querySelector('.track-node[data-step="plan"]')?.click()`);
  await sleep(1500);

  const insp = await evalJs(`(() => {
    const body = document.getElementById('insp-body');
    const foot = document.getElementById('insp-foot');
    const approve = document.querySelector('#insp-foot [data-decide="approve"]');
    const mm = document.querySelector('#insp-body .material-mismatch');
    const fb = document.querySelector('#insp-body .fb.err, #insp-foot .fb.err');
    const fbStyle = fb ? (() => { const c = getComputedStyle(fb); return { font: c.fontSize, lh: c.lineHeight, bg: c.backgroundColor, color: c.color, pad: c.padding }; })() : null;
    return {
      bodyLen: body ? body.innerHTML.length : -1,
      bodyHead: body ? body.textContent.replace(/\\s+/g, ' ').trim().slice(0, 140) : null,
      footHidden: foot ? foot.hidden : 'no-foot',
      footText: foot && !foot.hidden ? foot.textContent.replace(/\\s+/g, ' ').trim().slice(0, 80) : null,
      approvePresent: !!approve, approveDisabled: approve ? approve.disabled : null,
      mmPresent: !!mm, mmText: mm ? mm.textContent.replace(/\\s+/g, ' ').trim().slice(0, 100) : null,
      fbStyle,
    };
  })()`);
  console.log('== Inspector(TEST-R11/plan) ==', JSON.stringify(insp, null, 1));

  // 4) 顺便看 TEST-F01R10 的 doc 步骤（正式需求，无策略）
  await evalJs(`document.querySelector('.req-item[data-task="TEST-F01R10"]')?.click()`);
  await sleep(700);
  await evalJs(`document.querySelector('.track-node[data-step="doc"]')?.click()`);
  await sleep(1500);
  const insp2 = await evalJs(`(() => {
    const body = document.getElementById('insp-body');
    const foot = document.getElementById('insp-foot');
    const approve = document.querySelector('#insp-foot [data-decide="approve"]');
    return {
      bodyLen: body ? body.innerHTML.length : -1,
      bodyHead: body ? body.textContent.replace(/\\s+/g, ' ').trim().slice(0, 140) : null,
      footHidden: foot ? foot.hidden : 'no-foot',
      approvePresent: !!approve, approveDisabled: approve ? approve.disabled : null,
    };
  })()`);
  console.log('== Inspector(TEST-F01R10/doc) ==', JSON.stringify(insp2, null, 1));

  console.log('PROBE-DONE');
} finally {
  try { ws && ws.close(); } catch { }
  chrome.kill();
}
