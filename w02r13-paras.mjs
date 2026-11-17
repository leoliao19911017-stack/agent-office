// W02 r13 补证：.ev-demand（T-DAILY/req）与 .ip-note（TEST-F01R10/plan）的档位实测
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9484;
const BASE = 'http://127.0.0.1:8090';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.sock = ws; this.id = 0; this.pending = new Map();
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
    this.sock.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('page eval failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result.value;
  }
}

const profile = mkdtempSync(join(tmpdir(), 'w02r13p-'));
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
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: BASE });
  for (let i = 0; i < 100; i++) {
    if (await cdp.eval(`!!document.querySelector('.req-item')`)) break;
    await sleep(200);
  }
  const measure = (sel) => cdp.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return { sel: ${JSON.stringify(sel)}, absent: true };
    const c = getComputedStyle(el);
    return { sel: ${JSON.stringify(sel)}, fs: c.getPropertyValue('font-size'), lh: c.getPropertyValue('line-height'),
             color: c.getPropertyValue('color'), mt: c.getPropertyValue('margin-top'), mb: c.getPropertyValue('margin-bottom'),
             head: el.textContent.trim().slice(0, 24) };
  })()`);

  // 场景1：T-DAILY / req —— 需求类审批（.ev-demand 渲染）
  await cdp.eval(`document.querySelector('.req-item[data-task="T-DAILY"]')?.click()`);
  await sleep(400);
  await cdp.eval(`document.querySelector('.track-node[data-step="req"]')?.click()`);
  await sleep(900);
  console.log('T-DAILY/req  .ev-demand :', JSON.stringify(await measure('#insp-body .ev-demand')));

  // 场景2：TEST-F01R10 / plan —— 备注段（.ip-note 渲染）
  await cdp.eval(`document.querySelector('.req-item[data-task="TEST-F01R10"]')?.click()`);
  await sleep(400);
  await cdp.eval(`document.querySelector('.track-node[data-step="plan"]')?.click()`);
  await sleep(900);
  console.log('TEST-F01R10/plan .ip-note :', JSON.stringify(await measure('#insp-body .ip-note')));
  console.log('TEST-F01R10/plan .rej-why :', JSON.stringify(await measure('#insp-body .rej-why')));
} finally {
  try { chrome.kill(); } catch {}
  try { execSync(`taskkill /PID ${chrome.pid} /T /F`, { stdio: 'ignore' }); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
