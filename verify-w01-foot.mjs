// verify-w01-foot.mjs — W01 底部固定操作区验收实测（CDP 直连 headless Chrome，只读）。
// 规格核对项：
//   1) #inspector 总高 = 100vh-108（900 视口 792）；.insp-head 48px；#insp-body flex:1/内滚/横不滚
//   2) #insp-foot：高 64 / padding 12px 16px / 底色 #171C27 / 顶边框 1px #344253；底边 ≤ 状态栏顶边
//   3) 主/次按钮 ≥86×36 / ≥58×36，间距 8px，圆角 8px，完整可见
//   4) 右栏超高可独立滚到底；滚右栏不带动主内容区
//   5) scrollTop=200 连续 10 次 3 秒轮询，误差 ≤2px（不切需求/步骤）
//   6) 非审批步骤（done）不显示固定操作区（无 64px 空占位）
// 用法：node --experimental-websocket verify-w01-foot.mjs

import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9336;
const BASE = 'http://127.0.0.1:8090';
const TASK = 'TEST-R11';
const STEP = 'plan';
const VIEWPORTS = [{ w: 1440, h: 900 }, { w: 1280, h: 800 }, { w: 1100, h: 768 }];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = this; this.id = 0; this.pending = new Map();
    this.sock = ws;
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
    await new Promise((res, rej) => { ws.addEventListener('open', res); { /* placeholder */ } ws.addEventListener('error', rej); });
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

const MEASURE_LAYOUT = `(() => {
  const insp = document.getElementById('inspector');
  const head = insp.querySelector('.insp-head');
  const body = document.getElementById('insp-body');
  const foot = document.getElementById('insp-foot');
  const sb = document.getElementById('statusbar');
  const prim = foot.querySelector('.btn-primary');
  const sec = foot.querySelector('.btn-secondary');
  const src = document.querySelector('#insp-body .ev-src');
  const cs = (el, ps) => { const c = getComputedStyle(el); const o = {}; for (const p of ps) o[p] = c.getPropertyValue(p); return o; };
  const r = (el) => { const b = el.getBoundingClientRect(); return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1), bottom: +b.bottom.toFixed(1) }; };
  const sbTop = sb.getBoundingClientRect().top;
  const primR = prim.getBoundingClientRect(), secR = sec.getBoundingClientRect();
  const footR = foot.getBoundingClientRect();
  return {
    innerHeight: window.innerHeight, innerWidth: window.innerWidth,
    inspector: Object.assign(r(insp), cs(insp, ['flex-direction', 'min-height'])),
    head: Object.assign(r(head), cs(head, ['height', 'display', 'align-items', 'box-sizing'])),
    body: Object.assign(r(body), cs(body, ['flex-grow', 'flex-shrink', 'overflow-y', 'overflow-x'])),
    foot: Object.assign(r(foot), { hiddenAttr: foot.hidden }, cs(foot, ['height', 'padding', 'background-color', 'border-top-width', 'border-top-style', 'border-top-color', 'box-sizing', 'display'])),
    footBottomMinusStatusTop: +(footR.bottom - sbTop).toFixed(1),
    statusTop: +sbTop.toFixed(1),
    primary: Object.assign(r(prim), cs(prim, ['min-width', 'min-height', 'border-radius'])),
    secondary: Object.assign(r(sec), cs(sec, ['min-width', 'min-height', 'border-radius'])),
    btnGap: +(secR.left - primR.right).toFixed(1),
    btnsFullyVisible: primR.top >= 0 && primR.bottom <= window.innerHeight && secR.top >= 0 && secR.bottom <= window.innerHeight && primR.right <= window.innerWidth && secR.left >= 0,
    btnLabels: [prim.textContent.trim(), sec.textContent.trim()],
    bodyScroll: { scrollHeight: body.scrollHeight, clientHeight: body.clientHeight, canScroll: body.scrollHeight > body.clientHeight + 1 },
    evSrcText: src ? src.textContent.trim().slice(0, 40) : null,
    evSrcStyle: src ? cs(src, ['font-size', 'line-height', 'color']) : null,
    docOverflowX: document.documentElement.scrollWidth - window.innerWidth,
  };
})()`;

const MEASURE_SCROLL = `(() => {
  const body = document.getElementById('insp-body');
  const center = document.getElementById('center');
  const foot = document.getElementById('insp-foot');
  const footBefore = foot.getBoundingClientRect().bottom;
  body.scrollTop = body.scrollHeight;   // 滚到底
  const maxTop = body.scrollTop;
  const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 1;
  const footAfter = foot.getBoundingClientRect().bottom;
  const centerTopBefore = center.scrollTop;
  body.scrollTop = 200;                 // 轮询稳定性起点
  return {
    maxTop, atBottom,
    bottomReachable: atBottom,
    footPinnedAcrossScroll: Math.abs(footAfter - footBefore) < 0.5,
    centerScrollTop: centerTopBefore,
    centerScrollHeight: center.scrollHeight, centerClientHeight: center.clientHeight,
    overflowX: body.scrollWidth - body.clientWidth,
    sbSync: (document.getElementById('sb-sync') || {}).textContent || '',
  };
})()`;

async function main() {
  const out = { base: BASE, task: TASK, step: STEP, when: new Date().toISOString(), viewports: [], pollStability: null, doneStep: null };
  const profile = mkdtempSync(join(tmpdir(), 'w01foot-cdp-'));
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
    if (!targets) throw new Error('chrome devtools port never came up');
    const page = targets.find((t) => t.type === 'page');
    const cdp = await CDP.connect(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    for (const vp of VIEWPORTS) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: false });
      if (vp === VIEWPORTS[0]) {
        await cdp.send('Page.navigate', { url: BASE });
        for (let i = 0; i < 100; i++) {
          const ok = await cdp.eval(`!!document.querySelector('.req-item')`);
          if (ok) break; await sleep(200);
        }
      }
      await cdp.eval(`document.querySelector('.req-item[data-task="${TASK}"]')?.click()`);
      await sleep(400);
      await cdp.eval(`document.querySelector('.track-node[data-step="${STEP}"]')?.click()`);
      await sleep(900);   // 等文件核实渲染稳定

      const layout = await cdp.eval(MEASURE_LAYOUT);
      const scroll = await cdp.eval(MEASURE_SCROLL);
      const vpw = `${vp.w}x${vp.h}`;
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(`verify-w01foot-${vpw}-approval.png`, Buffer.from(shot.data, 'base64'));
      out.viewports.push({ viewport: vpw, layout, scroll });
      console.log(`\n===== ${vpw} =====`);
      console.log(JSON.stringify({ layout, scroll }, null, 1));
    }

    // ---- 轮询稳定性：1440×900，scrollTop=200，10 次 × 3s ----
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const samples = [];
    let syncTexts = new Set();
    for (let i = 0; i < 10; i++) {
      await sleep(3000);
      const s = await cdp.eval(`(() => {
        const b = document.getElementById('insp-body');
        return { top: b.scrollTop,
                 sync: (document.getElementById('sb-sync')||{}).textContent || '',
                 stepStillPlan: !!document.querySelector('#insp-foot .btn-primary'),
                 taskStill: !!document.querySelector('.req-item.sel[data-task="${TASK}"]') };
      })()`);
      syncTexts.add(s.sync);
      samples.push(s);
    }
    const tops = samples.map((s) => s.top);
    out.pollStability = {
      setTo: 200, samples: tops,
      min: Math.min(...tops), max: Math.max(...tops),
      maxDrift: Math.max(...tops.map((t) => Math.abs(t - 200))),
      pollCount: syncTexts.size,                       // 同步时间戳不同 = 轮询真的在跑
      stepStillPlanAll: samples.every((s) => s.stepStillPlan),
      taskStillAll: samples.every((s) => s.taskStill),
      distinctSyncTexts: [...syncTexts].slice(0, 3),
    };
    console.log('\n===== poll stability (10 x 3s) =====');
    console.log(JSON.stringify(out.pollStability, null, 1));

    // ---- 非审批步骤（done）：foot 必须隐藏、无 64px 占位 ----
    const done = await cdp.eval(`(() => {
      const node = document.querySelector('.track-node.st-done');
      if (!node) return { found: false };
      node.click();
      return { found: true, step: node.dataset.step };
    })()`);
    await sleep(400);
    if (done.found) {
      out.doneStep = await cdp.eval(`(() => {
        const insp = document.getElementById('inspector');
        const foot = document.getElementById('insp-foot');
        const body = document.getElementById('insp-body');
        const cs = getComputedStyle(foot);
        const iR = insp.getBoundingClientRect(), bR = body.getBoundingClientRect();
        return {
          step: ${JSON.stringify(done.step)},
          footHiddenAttr: foot.hidden,
          footDisplay: cs.display,
          footRectHeight: foot.getBoundingClientRect().height,
          bodyBottomGapToInspector: +(iR.bottom - bR.bottom).toFixed(1),   // foot 隐藏时应≈0
          hasButtons: !!foot.querySelector('button'),
        };
      })()`);
      const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(`verify-w01foot-1440x900-donestep.png`, Buffer.from(shot2.data, 'base64'));
      console.log('\n===== done-step (foot hidden) =====');
      console.log(JSON.stringify(out.doneStep, null, 1));
    } else {
      out.doneStep = { found: false };
    }
  } finally {
    try { chrome.kill(); } catch {}
    try { execSync(`taskkill /PID ${chrome.pid} /T /F`, { stdio: 'ignore' }); } catch {}
  }
  writeFileSync('verify-w01foot.json', JSON.stringify(out, null, 1));
  console.log('\nwrote verify-w01foot.json');
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });
