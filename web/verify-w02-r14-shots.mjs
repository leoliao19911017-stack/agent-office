// verify-w02-r14-shots.mjs — 三视口滚底截图（视觉证据）+ T-DAILY/req 需求类审批面板快速核对。
// 截图口径：注入长段 → 滚到最底 → Page.captureScreenshot（此刻末行与底栏同框）。
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9342;
const BASE = 'http://127.0.0.1:8090';
const LONG = 'W02 第14轮滚动验证占位段：用于把审批正文拉长到超过滚动区高度，验证滚到底后末行完整可见。'.repeat(24);
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

const INJECT_SCROLL = `(() => {
  const body = document.getElementById('insp-body');
  const content = body.querySelector('.inspector-content');
  if (!content) return 'no-content';
  if (!document.getElementById('w02-probe')) {
    const p = document.createElement('p');
    p.id = 'w02-probe'; p.className = 'ip-note';
    p.textContent = ${JSON.stringify(LONG)};
    content.appendChild(p);
  }
  body.scrollTop = body.scrollHeight;
  const probe = document.getElementById('w02-probe').getBoundingClientRect();
  const foot = document.getElementById('insp-foot').getBoundingClientRect();
  return JSON.stringify({ max: body.scrollHeight - body.clientHeight, top: body.scrollTop,
    probeBottom: probe.bottom, footTop: foot.top, gap: +(foot.top - probe.bottom).toFixed(1) });
})()`;

const DEMAND_CHECK = `(() => {
  const body = document.getElementById('insp-body');
  const foot = document.getElementById('insp-foot');
  body.scrollTop = body.scrollHeight;
  const last = body.querySelector('.inspector-content').lastElementChild.getBoundingClientRect();
  const footR = foot.getBoundingClientRect();
  return { footBtns: [...foot.querySelectorAll('button')].map(b => b.textContent.trim()),
    maxScroll: body.scrollHeight - body.clientHeight, scrolledTo: body.scrollTop,
    lastBottom: +last.bottom.toFixed(1), bodyViewBottom: +body.getBoundingClientRect().bottom.toFixed(1),
    lastLineFullyVisible: last.bottom <= body.getBoundingClientRect().bottom + 0.5,
    overlap: last.bottom > footR.top + 0.5 };
})()`;

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'w02r14s-cdp-'));
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
    for (const vp of [{ w: 1440, h: 900 }, { w: 1280, h: 800 }, { w: 1100, h: 768 }]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: false });
      await cdp.send('Page.navigate', { url: BASE });
      for (let i = 0; i < 100; i++) { if (await cdp.eval(`!!document.querySelector('.req-item')`)) break; await sleep(200); }
      await cdp.eval(`document.querySelector('.req-item[data-task="TEST-R11"]')?.click()`);
      await sleep(400);
      await cdp.eval(`document.querySelector('.track-node[data-step="plan"]')?.click()`);
      await sleep(1000);
      const m = await cdp.eval(INJECT_SCROLL);
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const out = join(process.cwd(), `w02r14-${vp.w}x${vp.h}-scrollbottom.png`);
      writeFileSync(out, Buffer.from(shot.data, 'base64'));
      console.log(`${vp.w}x${vp.h}  ${m}  -> ${out}`);
    }
    // 需求类审批面板（无文件对象，foot 只有一个「补齐材料」动作）——同口径滚底核对
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await cdp.eval(`document.querySelector('.req-item[data-task="T-DAILY"]')?.click()`);
    await sleep(400);
    await cdp.eval(`document.querySelector('.track-node[data-step="req"]')?.click()`);
    await sleep(1000);
    console.log('T-DAILY/req (demand 型审批):', JSON.stringify(await cdp.eval(DEMAND_CHECK), null, 1));
  } finally {
    try { chrome.kill(); } catch {}
    try { execSync(`taskkill /PID ${chrome.pid} /T /F`, { stdio: 'ignore' }); } catch {}
  }
}
main().catch((e) => { console.error('FAIL', e); process.exit(1); });
