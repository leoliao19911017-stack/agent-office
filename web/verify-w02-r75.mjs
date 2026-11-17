// verify-w02-r75.mjs — W02 第 75 轮：审批正文 300/1500/3000 字三档滚动实测 + 刷新保持选中。
// 口径（任务书）：#insp-body 独立滚动；滚到底后最后一行完整可见且距固定操作区顶 ≥12px；
// 右栏滚动不带动中列/外层；刷新后选中状态恢复。注入+滚动+测量同一 eval 原子完成（防 3 秒重渲染）。
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9342;
const BASE = process.env.BASE || 'http://127.0.0.1:8090';
const TASK = 'TEST-R11';
const STEP = 'plan';
const UNIT = '第75轮滚动验证占位段：300/1500/3000字三档，验证审批正文独立滚动，滚到底末行完整可见。';
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

// chars: 目标字数。注入段落一次性建好再滚到底测量（原子）。
const MEASURE = (chars) => `(() => {
  const chars = ${chars};
  const body = document.getElementById('insp-body');
  const foot = document.getElementById('insp-foot');
  const content = body.querySelector('.inspector-content');
  if (!content) return { error: 'no inspector-content' };
  document.getElementById('w02-probe')?.remove();
  const p = document.createElement('p');
  p.id = 'w02-probe'; p.className = 'ip-note';
  const unit = ${JSON.stringify(UNIT)};
  p.textContent = unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
  content.appendChild(p);
  const center = document.getElementById('center');
  const before = { scrollX: window.scrollX, scrollY: window.scrollY,
    centerL: +center.getBoundingClientRect().left.toFixed(1) };
  body.scrollTop = body.scrollHeight;
  const bodyR = body.getBoundingClientRect(), footR = foot.getBoundingClientRect(),
        pR = p.getBoundingClientRect();
  const after = { scrollX: window.scrollX, scrollY: window.scrollY,
    centerL: +center.getBoundingClientRect().left.toFixed(1) };
  const csT = getComputedStyle(p);
  return {
    injectedChars: p.textContent.length,
    scrollH: body.scrollHeight, clientH: body.clientHeight,
    scrolledTo: body.scrollTop, maxScroll: body.scrollHeight - body.clientHeight,
    lastBottom: +pR.bottom.toFixed(1), bodyViewBottom: +bodyR.bottom.toFixed(1), footTop: +footR.top.toFixed(1),
    lastLineFullyVisible: pR.bottom <= bodyR.bottom + 0.5,
    overlapBodyFoot: pR.bottom > footR.top + 0.5,
    gapLastToFoot: +(footR.top - pR.bottom).toFixed(1),
    outerStill: before.scrollX === after.scrollX && before.scrollY === after.scrollY && before.centerL === after.centerL,
    textStyle: { size: csT.fontSize, lh: csT.lineHeight },
  };
})()`;

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'w02r75-cdp-'));
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
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: BASE });
    for (let i = 0; i < 100; i++) { if (await cdp.eval(`!!document.querySelector('.req-item')`)) break; await sleep(200); }
    await cdp.eval(`document.querySelector('.req-item[data-task="${TASK}"]')?.click()`);
    await sleep(400);
    await cdp.eval(`document.querySelector('.track-node[data-step="${STEP}"]')?.click()`);
    await sleep(1000);

    const results = {};
    for (const chars of [300, 1500, 3000]) {
      results[`c${chars}`] = await cdp.eval(MEASURE(chars));
      console.log(`[${chars} 字]`, JSON.stringify(results[`c${chars}`]));
    }

    // 刷新保持选中：reload 后选中任务/步骤应恢复（office.ui.v2）
    await cdp.send('Page.navigate', { url: BASE });
    for (let i = 0; i < 100; i++) { if (await cdp.eval(`!!document.querySelector('.req-item')`)) break; await sleep(200); }
    await sleep(1200);   // 等 restoreUiPos 异步恢复
    results.refreshKept = await cdp.eval(`(() => {
      const sel = document.querySelector('.req-item.sel, .req-item.selected, .req-item[data-task="${TASK}"].sel');
      const taskSel = document.querySelector('.req-item.sel');
      const stepSel = document.querySelector('.track-node.sel, .track-node.active');
      const bodyOpen = !!document.querySelector('#inspector .inspector-content');
      return { taskSelected: !!taskSel, taskIsR11: !!taskSel && taskSel.dataset.task === '${TASK}',
               stepSelected: !!stepSel, inspectorOpen: bodyOpen };
    })()`);
    console.log('[刷新保持选中]', JSON.stringify(results.refreshKept));
    const ok = Object.entries(results).every(([k, r]) => {
      if (k === 'refreshKept') return r.taskSelected && r.inspectorOpen;
      return r.lastLineFullyVisible && !r.overlapBodyFoot && r.gapLastToFoot >= 12 && r.outerStill;
    });
    console.log(ok ? '\nW02-R75: ALL OK' : '\nW02-R75: FAIL');
    process.exitCode = ok ? 0 : 1;
  } finally {
    try { chrome.kill(); } catch {}
    try { execSync(`taskkill /PID ${chrome.pid} /T /F`, { stdio: 'ignore' }); } catch {}
  }
}
main().catch((e) => { console.error('FAIL', e); process.exit(1); });
