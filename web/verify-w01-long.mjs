// verify-w01-long.mjs — 长文件名专项：注入 120+ 字符文件名后【立即】在同一 eval 里量，
// 避免 3 秒轮询重渲染把注入内容冲掉。两个视口各测。
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9336;
const BASE = 'http://127.0.0.1:8090';
const LONG_NAME = 'a'.repeat(120) + '-超长文件名测试-never-ends-here.css';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) { this.sock = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } }); }
  static async connect(url) { const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    return new CDP(ws); }
  send(method, params = {}) { const id = ++this.id;
    this.sock.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject })); }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result.value; }
}

// 注入 + 测量一次完成（同步，不受轮询影响）
const INJECT_AND_MEASURE = `(() => {
  const fn = document.querySelector('#insp-body .ev-file .fn');
  if (!fn) return { found: false };
  fn.textContent = ${JSON.stringify(LONG_NAME)};
  const file = fn.closest('.ev-file');
  const inspBody = document.getElementById('insp-body');
  const insp = document.getElementById('inspector');
  const fnR = fn.getBoundingClientRect();
  const bodyR = inspBody.getBoundingClientRect();
  return {
    found: true,
    injectedLen: fn.textContent.length,
    fnEllipsized: fn.scrollWidth > fn.clientWidth + 1,
    fnRect: { w: +fnR.width.toFixed(1), h: +fnR.height.toFixed(1), right: +fnR.right.toFixed(1) },
    bodyRight: +bodyR.right.toFixed(1),
    fnStaysInside: fnR.right <= bodyR.right + 0.5,
    fnSingleLine: Math.abs(fnR.height - 20) < 1,
    fileH: +file.getBoundingClientRect().height.toFixed(1),
    fileW: +file.getBoundingClientRect().width.toFixed(1),
    inspBodyOverflowX: inspBody.scrollWidth - inspBody.clientWidth,
    docOverflowX: document.documentElement.scrollWidth - window.innerWidth,
  };
})()`;

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'w01l-cdp-'));
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank',
  ], { stdio: 'ignore' });
  try {
    let targets = null;
    for (let i = 0; i < 50; i++) {
      try { const res = await fetch(`http://127.0.0.1:${PORT}/json/list`); targets = await res.json(); break; }
      catch { await sleep(200); }
    }
    const page = targets.find((t) => t.type === 'page');
    const cdp = await CDP.connect(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    for (const vp of [{ w: 1440, h: 900 }, { w: 1280, h: 800 }]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: false });
      if (vp.w === 1440) {
        await cdp.send('Page.navigate', { url: BASE });
        for (let i = 0; i < 100; i++) { if (await cdp.eval(`!!document.querySelector('.req-item')`)) break; await sleep(200); }
      }
      await cdp.eval(`document.querySelector('.req-item[data-task="TEST-R11"]')?.click()`);
      await sleep(400);
      await cdp.eval(`document.querySelector('.track-node[data-step="plan"]')?.click()`);
      await sleep(900);
      console.log(`===== ${vp.w}x${vp.h} (long-name, inject+measure atomic) =====`);
      console.log(JSON.stringify(await cdp.eval(INJECT_AND_MEASURE), null, 1));
    }
  } finally {
    try { chrome.kill(); } catch {}
    try { execSync(`taskkill /PID ${chrome.pid} /T /F`, { stdio: 'ignore' }); } catch {}
  }
}
main().catch((e) => { console.error('FAIL', e); process.exit(1); });
