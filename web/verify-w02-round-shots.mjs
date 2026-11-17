// verify-w02-round-shots.mjs — W02 本轮：滚底截图留档（1280x768 / 1440x900）。
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9348;
const BASE = 'http://127.0.0.1:8090';
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
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval failed'); return r.result.value; }
}
const profile = mkdtempSync(join(tmpdir(), 'w02shots-cdp-'));
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
  for (const vp of [{ w: 1440, h: 900, n: '1440x900' }, { w: 1280, h: 768, n: '1280x768' }]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: BASE });
    for (let i = 0; i < 100; i++) { if (await cdp.eval(`!!document.querySelector('.req-item')`)) break; await sleep(200); }
    await cdp.eval(`document.querySelector('.req-item[data-task="TEST-R11"]')?.click()`);
    await sleep(400);
    await cdp.eval(`document.querySelector('.track-node[data-step="plan"]')?.click()`);
    await sleep(1000);
    await cdp.eval(`document.getElementById('insp-body').scrollTop = 1e9`);
    await sleep(200);
    await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }).then((r) => {
      writeFileSync(join(process.cwd(), `w02round-${vp.n}-scrollbottom.png`), Buffer.from(r.data, 'base64'));
      console.log('saved', `w02round-${vp.n}-scrollbottom.png`);
    }).catch((e) => console.log('shot fail', e.message));
  }
} finally {
  try { chrome.kill(); } catch {}
  try { execSync(`taskkill /PID ${chrome.pid} /T /F`, { stdio: 'ignore' }); } catch {}
}
