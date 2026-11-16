// verify-w02.mjs — W02 验收实测：CDP 直连一个临时 Chrome，在 1440×900 / 1280×800 / 1100×768
// 三个视口下量右侧详情区（#insp-body）的滚动与样式真实数值，并做 10 轮 3 秒轮询滚动保持测试。
// 用法：node --experimental-websocket verify-w02.mjs [输出.json]
// 依赖：本机 Chrome + 127.0.0.1:8090 已在跑当前代码（不做任何写操作，只读页面）。

import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9333;
const BASE = 'http://127.0.0.1:8090';
const TASK = 'TEST-R11';      // 带 test-any-file 策略说明的需求（图1场景）
const STEP = 'plan';          // 第3步 plan：awaiting + expects=["plan"] → 渲染测试策略说明
const VIEWPORTS = [
  { w: 1440, h: 900 }, { w: 1280, h: 800 }, { w: 1100, h: 768 },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    return new CDP(ws);
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('page eval failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  }
}

// 页内测量：全部用 getComputedStyle / getBoundingClientRect / scroll 尺寸，真实数值
const MEASURE = `(() => {
  const insp = document.getElementById('inspector');
  const body = document.getElementById('insp-body');
  const decide = document.querySelector('#insp-body .ip-decide');
  const evSrc = document.querySelector('#insp-body .ev-src');
  const secs = [...document.querySelectorAll('#insp-body .ip-sec')];
  const executor = secs.find(x => (x.querySelector('h4')||{}).textContent === '执行者');
  const io = secs.find(x => (x.querySelector('h4')||{}).textContent === '上下游');
  const arts = secs.find(x => (x.querySelector('.ip-sec-h h4')||{}).textContent === '本步产物');
  const cs = (el, props) => { const c = getComputedStyle(el); const o = {}; for (const p of props) o[p] = c.getPropertyValue(p); return o; };
  const r = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    inspOpenOverlay: document.body.classList.contains('insp-open'),
    insp: insp ? Object.assign(r(insp), cs(insp, ['position', 'overflow-y'])) : null,
    inspBody: body ? Object.assign({
      clientW: body.clientWidth, clientH: body.clientHeight,
      scrollW: body.scrollWidth, scrollH: body.scrollHeight,
      canScrollY: body.scrollHeight > body.clientHeight,
      overflowXClipped: body.scrollWidth <= body.clientWidth,
      scrollTop: body.scrollTop, scrollTopMax: body.scrollTopMax,
    }, cs(body, ['overflow-x', 'overflow-y', 'width', 'height', 'padding'])) : null,
    decide: decide ? Object.assign(r(decide), cs(decide, ['padding', 'border-radius', 'background-color'])) : null,
    evSrc: evSrc ? Object.assign(r(evSrc), cs(evSrc, ['font-size', 'line-height', 'color', 'margin-top', 'margin-bottom']), {
      textLen: evSrc.textContent.length,
      textHead: evSrc.textContent.slice(0, 40),
    }) : null,
    executorTopInScroll: executor ? executor.offsetTop : null,
    ioTopInScroll: io ? io.offsetTop : null,
    artsTopInScroll: arts ? arts.offsetTop : null,
    // 页面级横向溢出（审批文字溢出会顶破这里或 inspBody）
    docOverflowX: document.documentElement.scrollWidth > window.innerWidth,
    bodyScrollable: document.body.scrollHeight > document.body.clientHeight,
  };
})()`;

// 滚动测试：滚到底（Chrome 无 scrollTopMax，用 scrollHeight-clientHeight），看执行者/上下游是否进入可视区
const SCROLL_TEST = `(() => {
  const b = document.getElementById('insp-body');
  const max = b.scrollHeight - b.clientHeight;
  b.scrollTop = max;
  const vis = (sel, text) => {
    const secs = [...document.querySelectorAll('#insp-body .ip-sec')];
    const el = secs.find(x => (x.querySelector('h4')||{}).textContent === text);
    if (!el) return null;
    const br = el.getBoundingClientRect();
    const bb = b.getBoundingClientRect();
    return { text, topInView: br.top >= bb.top - 1 && br.bottom <= bb.bottom + 1, rect: { top: Math.round(br.top), bottom: Math.round(br.bottom) }, view: { top: Math.round(bb.top), bottom: Math.round(bb.bottom) } };
  };
  return { scrollTop: b.scrollTop, scrollTopMax: max, executor: vis(null, '执行者'), arts: vis(null, '本步产物'), io: vis(null, '上下游') };
})()`;

async function main() {
  const out = { base: BASE, task: TASK, step: STEP, when: new Date().toISOString(), viewports: [], pollTest: null };
  const profile = mkdtempSync(join(tmpdir(), 'w02-cdp-'));
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank',
  ], { stdio: 'ignore' });
  try {
    // 等 DevTools 端口起来
    let targets = null;
    for (let i = 0; i < 50; i++) {
      try { const res = await fetch(`http://127.0.0.1:${PORT}/json/list`); targets = await res.json(); break; }
      catch { await sleep(200); }
    }
    if (!targets) throw new Error('chrome devtools port never came up');
    const page = targets.find((t) => t.type === 'page');
    const cdp = await CDP.connect(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    for (const vp of VIEWPORTS) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: false });
      if (vp === VIEWPORTS[0]) {
        await cdp.send('Page.navigate', { url: BASE });
        // 等需求列表渲染出来
        for (let i = 0; i < 100; i++) {
          const ok = await cdp.eval(`!!document.querySelector('.req-item')`);
          if (ok) break; await sleep(200);
        }
      }
      await cdp.eval(`document.querySelector('.req-item[data-task="${TASK}"]')?.click()`);
      await sleep(400);
      await cdp.eval(`document.querySelector('.track-node[data-step="${STEP}"]')?.click()`);
      await sleep(800);   // 等 3 秒轮询外的首帧 + 文件核实渲染稳定

      const measure = await cdp.eval(MEASURE);
      const vpw = `${vp.w}x${vp.h}`;
      // 先归零再截「顶部」图，再滚到底截「滚后」图，避免上一视口残留滚动位
      await cdp.eval(`document.getElementById('insp-body').scrollTop = 0`);
      const shotTop = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const scroll = await cdp.eval(SCROLL_TEST);
      const shotAfter = await cdp.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(`verify-w02-${vpw}-top.png`, Buffer.from(shotTop.data, 'base64'));
      writeFileSync(`verify-w02-${vpw}-scrolled.png`, Buffer.from(shotAfter.data, 'base64'));
      out.viewports.push({ viewport: vpw, measure, scrollTest: scroll });
      console.log(`\n===== ${vpw} =====`);
      console.log(JSON.stringify({ measure, scrollTest: scroll }, null, 1));
    }

    // 10 轮 3 秒轮询滚动保持测试（在 1440×900 下做）：滚到中部，30 秒不重置
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.eval(`document.querySelector('.req-item[data-task="${TASK}"]')?.click()`);
    await sleep(300);
    await cdp.eval(`document.querySelector('.track-node[data-step="${STEP}"]')?.click()`);
    await sleep(500);
    const set = await cdp.eval(`(() => { const b = document.getElementById('insp-body'); const max = b.scrollHeight - b.clientHeight; b.scrollTop = Math.floor(max / 2); return { set: b.scrollTop, max }; })()`);
    const samples = [];
    for (let i = 1; i <= 10; i++) {
      await sleep(3200);
      const s = await cdp.eval(`document.getElementById('insp-body').scrollTop`);
      samples.push(s);
    }
    out.pollTest = { setTo: set.set, scrollTopMax: set.max, samples, drift: samples.every((s) => s === set.set) };
    console.log('\n===== poll test (10 x ~3.2s) =====');
    console.log(JSON.stringify(out.pollTest));
  } finally {
    try { chrome.kill(); } catch {}
    try { execSync(`taskkill /PID ${chrome.pid} /T /F`, { stdio: 'ignore' }); } catch {}
  }
  const outPath = process.argv[2] || 'verify-w02-result.json';
  writeFileSync(outPath, JSON.stringify(out, null, 1));
  console.log(`\nwrote ${outPath}`);
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });
