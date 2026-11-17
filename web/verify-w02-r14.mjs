// verify-w02-r14.mjs — 审批详情面板独立滚动：三视口（1440×900 / 1280×800 / 1100×768）实测。
// 口径（任务书）：滚动到最底部后最后一行完整可见；正文与操作区 getBoundingClientRect 无重叠；
// 滚动中操作区始终可见；页面外层不因右栏滚动产生位移。
// 两组数据各测一次：A=真实审批内容（不注入）；B=注入长段落后（滚动压力测试，注入+滚动+测量同一 eval 原子完成，
// 不受 3 秒轮询重渲染影响——沿用 verify-w01-long.mjs 的做法）。
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9341;
const BASE = process.env.BASE || 'http://127.0.0.1:8090';
const TASK = 'TEST-R11';        // 有 app.css 审批对象 + test-any-file 策略说明的待拍板步骤
const STEP = 'plan';
const LONG =
  'W02 第14轮滚动验证占位段：用于把审批正文拉长到超过滚动区高度，验证滚到底后末行完整可见。'.repeat(24);
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

// mode: 'real' 只测真实内容；'long' 注入长段落后测（原子）
const MEASURE = (mode) => `(() => {
  const mode = ${JSON.stringify(mode)};
  const body = document.getElementById('insp-body');
  const head = document.querySelector('#inspector .insp-head');
  const foot = document.getElementById('insp-foot');
  const content = body.querySelector('.inspector-content');
  if (!content) return { error: 'no inspector-content' };
  if (mode === 'long' && !document.getElementById('w02-probe')) {
    const p = document.createElement('p');
    p.id = 'w02-probe'; p.className = 'ip-note';
    p.textContent = ${JSON.stringify(LONG)};
    content.appendChild(p);
  }
  const probe = mode === 'long' ? document.getElementById('w02-probe') : content.lastElementChild;
  const csB = getComputedStyle(body), csF = getComputedStyle(foot), csH = getComputedStyle(head);
  const center = document.getElementById('center');
  const before = { scrollX: window.scrollX, scrollY: window.scrollY,
    centerL: +center.getBoundingClientRect().left.toFixed(1), centerW: +center.getBoundingClientRect().width.toFixed(1) };
  const headR0 = head.getBoundingClientRect(), footR0 = foot.getBoundingClientRect();
  body.scrollTop = body.scrollHeight;                    // 滚到最底
  const headR = head.getBoundingClientRect(), bodyR = body.getBoundingClientRect(),
        footR = foot.getBoundingClientRect(), probeR = probe.getBoundingClientRect();
  const after = { scrollX: window.scrollX, scrollY: window.scrollY,
    centerL: +center.getBoundingClientRect().left.toFixed(1), centerW: +center.getBoundingClientRect().width.toFixed(1) };
  const evSrc = body.querySelector('.ev-src') || probe;
  const csT = getComputedStyle(evSrc);
  return {
    headH: +headR.height.toFixed(1), footH: +footR.height.toFixed(1),
    bodyOverflowY: csB.overflowY, bodyMinHeight: csB.minHeight,
    bodyPadding: csB.padding, bodyScrollbarW: body.offsetWidth - body.clientWidth,
    footBg: csF.backgroundColor, footBorderTop: csF.borderTopWidth + ' ' + csF.borderTopStyle + ' ' + csF.borderTopColor,
    footBtns: [...foot.querySelectorAll('button')].map(b => b.textContent.trim()),
    stackOk: headR.bottom <= bodyR.top + 0.5 && bodyR.bottom <= footR.top + 0.5,   // 48 / 滚动 / 64 三段邻接
    scrollH: body.scrollHeight, clientH: body.clientHeight,
    maxScroll: body.scrollHeight - body.clientHeight, scrolledTo: body.scrollTop,
    lastBottom: +probeR.bottom.toFixed(1), bodyViewBottom: +bodyR.bottom.toFixed(1), footTop: +footR.top.toFixed(1),
    lastLineFullyVisible: probeR.bottom <= bodyR.bottom + 0.5,
    overlapBodyFoot: probeR.bottom > footR.top + 0.5 || bodyR.bottom > footR.top + 0.5,
    gapLastToFoot: +(footR.top - probeR.bottom).toFixed(1),
    footVisibleBeforeScroll: footR0.top >= 0 && footR0.bottom <= window.innerHeight + 0.5 && !foot.hidden && foot.offsetHeight > 0,
    footVisibleAfterScroll: footR.top >= 0 && footR.bottom <= window.innerHeight + 0.5,
    outerShift: before.scrollX === after.scrollX && before.scrollY === after.scrollY
      && before.centerL === after.centerL && before.centerW === after.centerW,
    outerScrollXY: [after.scrollX, after.scrollY],
    docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    bodyOverflowX: body.scrollWidth - body.clientWidth,
    textStyle: { size: csT.fontSize, lh: csT.lineHeight, color: csT.color },
  };
})()`;

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'w02r14-cdp-'));
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
      await cdp.eval(`document.querySelector('.req-item[data-task="${TASK}"]')?.click()`);
      await sleep(400);
      await cdp.eval(`document.querySelector('.track-node[data-step="${STEP}"]')?.click()`);
      await sleep(1000);   // 等 version-gate 异步判定落定，避免测量时按钮状态中途变化
      console.log(`\n===== ${vp.w}x${vp.h} =====`);
      console.log('[A 真实内容]', JSON.stringify(await cdp.eval(MEASURE('real')), null, 1));
      console.log('[B 长文注入]', JSON.stringify(await cdp.eval(MEASURE('long')), null, 1));
    }
  } finally {
    try { chrome.kill(); } catch {}
    try { execSync(`taskkill /PID ${chrome.pid} /T /F`, { stdio: 'ignore' }); } catch {}
  }
}
main().catch((e) => { console.error('FAIL', e); process.exit(1); });
