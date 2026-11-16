// measure-w01-text.mjs — 在真实页面环境里量第二行候选文案在 11px 下的实际渲染宽度，
// 用真实数值决定 meta 行格式，不靠拍脑袋。
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9335;
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
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result.value; }
}

const MEASURE = `(() => {
  // 用与 .ev-file small 完全相同的字体环境量宽：挂一个临时 small 到 .ev-file-txt 里
  const file = document.querySelector('#insp-body .ev-file');
  const txt = file.querySelector('.ev-file-txt');
  const probe = document.createElement('small');
  probe.style.cssText = 'position:absolute; visibility:hidden; white-space:nowrap; font: inherit;';
  txt.appendChild(probe);
  const w = (s) => { probe.textContent = s; return probe.getBoundingClientRect().width; };
  const res = {
    candidates: {
      '87.1 KB · 类型 test-artifact': w('87.1 KB · 类型 test-artifact'),
      '87.1 KB · test-artifact': w('87.1 KB · test-artifact'),
      '87.1 KB': w('87.1 KB'),
      'test-artifact': w('test-artifact'),
      '·': w('·'),
    },
    metaRowCurrentWidth: file.querySelector('small').getBoundingClientRect().width,
    fnRowCurrentWidth: file.querySelector('.fn').getBoundingClientRect().width,
    evVWidth: document.querySelector('#insp-body .ev-v').getBoundingClientRect().width,
    evKWidth: document.querySelector('#insp-body .ev-k').getBoundingClientRect().width,
    evRowGap: getComputedStyle(document.querySelector('#insp-body .ev-row')).gap,
    evPadding: getComputedStyle(document.querySelector('#insp-body .ev')).padding,
    inspWidth: document.getElementById('inspector').getBoundingClientRect().width,
  };
  probe.remove();
  return res;
})()`;

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'w01m-cdp-'));
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
      console.log(`===== ${vp.w}x${vp.h} =====`);
      console.log(JSON.stringify(await cdp.eval(MEASURE), null, 1));
    }
  } finally {
    try { chrome.kill(); } catch {}
    try { execSync(`taskkill /PID ${chrome.pid} /T /F`, { stdio: 'ignore' }); } catch {}
  }
}
main().catch((e) => { console.error('FAIL', e); process.exit(1); });
