// verify-w01-round7.mjs — W01 第 7 轮独立验收（CDP 直连 headless Chrome，只读，不改任何代码）。
// 任务书验证点逐条对照：
//   V1 三视口：#inspector 328×(vh-108)；.insp-head 48px；#insp-body flex:1/min-height:0/oy:auto/ox:hidden
//   V2 #insp-foot：64px、bg #171C27、border-top 1px #344253、padding 12px 16px、固定在滚动区外
//   V3 foot.bottom ≤ statusbar.top；主 ≥86×36 / 次 ≥58×36 / gap 8 / radius 8 / 完整可见
//   V4 详情超高 scrollHeight > clientHeight 且能滚到底；滚动期间 foot 钉住不动
//   V5 scrollTop=200 → 10×3s 轮询，同需求同步骤下偏差 ≤2px
//   V6 中央工作区滚动位置不受右侧滚动影响（强测：预先写 center.scrollTop 再滚右栏）
//   V7 无审批动作的步骤（done）不显示操作区（无 64px 占位）
//   V8 说明文字 12px / 19px / #B3C0D2（.ev-src 及 .ip-decide 卡内说明抽查）
// 用法：node --experimental-websocket verify-w01-round7.mjs

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9337;
const BASE = 'http://127.0.0.1:8090';
const TASK = 'TEST-R11';
const STEP = 'plan';
const VIEWPORTS = [{ w: 1440, h: 900 }, { w: 1280, h: 800 }, { w: 1100, h: 768 }];
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
    const { WebSocket } = globalThis;
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
    if (r.exceptionDetails) throw new Error('page eval failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  }
}

const LAYOUT = `(() => {
  const $ = (id) => document.getElementById(id);
  const insp = $('inspector'), head = insp.querySelector('.insp-head'),
        body = $('insp-body'), foot = $('insp-foot'), sb = $('statusbar'), center = $('center');
  const prim = foot.querySelector('.btn-primary'), sec = foot.querySelector('.btn-secondary');
  const cs = (el, ps) => { const c = getComputedStyle(el); const o = {}; ps.forEach(p => o[p] = c.getPropertyValue(p)); return o; };
  const r = (el) => { const b = el.getBoundingClientRect(); return { x:+b.x.toFixed(1), y:+b.y.toFixed(1), w:+b.width.toFixed(1), h:+b.height.toFixed(1), bottom:+b.bottom.toFixed(1), top:+b.top.toFixed(1) }; };
  const sbTop = sb.getBoundingClientRect().top;
  const pR = prim.getBoundingClientRect(), sR = sec.getBoundingClientRect(), fR = foot.getBoundingClientRect();
  const note = document.querySelector('#insp-body .ev-src');
  const noteStyle = note ? cs(note, ['font-size','line-height','color']) : null;
  return {
    vp: { w: innerWidth, h: innerHeight },
    insp: { ...r(insp), ...cs(insp, ['width','display','flex-direction','min-height']),
            heightEqVhMinus108: Math.abs(insp.getBoundingClientRect().height - (innerHeight-108)) < 0.6 },
    head: { ...r(head), ...cs(head, ['height']) },
    body: { ...r(body), ...cs(body, ['flex-grow','min-height','overflow-y','overflow-x']) },
    foot: { ...r(foot), hiddenAttr: foot.hidden, ...cs(foot, ['height','padding','background-color','border-top-width','border-top-style','border-top-color','display']) },
    footBottomLEstatusTop: fR.bottom <= sbTop + 0.6, footBottom: +fR.bottom.toFixed(1), statusTop: +sbTop.toFixed(1),
    primary: { ...r(prim), ...cs(prim, ['min-width','min-height','border-radius']) },
    secondary: { ...r(sec), ...cs(sec, ['min-width','min-height','border-radius']) },
    btnGap: +(sR.left - pR.right).toFixed(1),
    btnsFullyVisible: pR.top>=0 && pR.bottom<=innerHeight && sR.top>=0 && sR.bottom<=innerHeight && pR.right<=insp.getBoundingClientRect().right && sR.left>=insp.getBoundingClientRect().left,
    btnLabels: [prim.textContent.trim(), sec.textContent.trim()],
    contentTaller: body.scrollHeight > body.clientHeight + 1,
    scrollHeight: body.scrollHeight, clientHeight: body.clientHeight,
    noteStyle,
    docOverflowX: document.documentElement.scrollWidth - innerWidth,
  };
})()`;

const SCROLL = `(() => {
  const body = document.getElementById('insp-body');
  const center = document.getElementById('center');
  const foot = document.getElementById('insp-foot');
  const fb0 = foot.getBoundingClientRect().bottom;
  // 中央隔离强测：先给中央写一个滚动位置（若中央本就不可滚，读回 0 并如实记录）
  const centerScrollable = center.scrollHeight > center.clientHeight + 1;
  if (centerScrollable) center.scrollTop = 50;
  const cSet = center.scrollTop;
  body.scrollTop = body.scrollHeight;            // 右栏滚到底
  const maxTop = body.scrollTop;
  const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 1;
  const fb1 = foot.getBoundingClientRect().bottom;
  const cAfter = center.scrollTop;               // 滚右栏之后中央是否被带动
  body.scrollTop = 200;                          // 轮询稳定性起点
  return { maxTop, atBottom, footPinned: Math.abs(fb1 - fb0) < 0.5,
           centerScrollable, centerSetTo: cSet, centerAfterRightScroll: cAfter,
           centerUnaffected: !centerScrollable || Math.abs(cAfter - cSet) < 1,
           overflowXBody: body.scrollWidth - body.clientWidth };
})()`;

async function main() {
  const out = { base: BASE, task: TASK, step: STEP, when: new Date().toISOString(), viewports: [], poll: null, doneStep: null, noObjStep: null };
  const profile = mkdtempSync(join(tmpdir(), 'w01r7-cdp-'));
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
    const cdp = await CDP.connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    for (const vp of VIEWPORTS) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: false });
      if (vp === VIEWPORTS[0]) {
        await cdp.send('Page.navigate', { url: BASE });
        for (let i = 0; i < 100; i++) {
          if (await cdp.eval(`!!document.querySelector('.req-item')`)) break;
          await sleep(200);
        }
      }
      await cdp.eval(`document.querySelector('.req-item[data-task="${TASK}"]')?.click()`);
      await sleep(400);
      await cdp.eval(`document.querySelector('.track-node[data-step="${STEP}"]')?.click()`);
      await sleep(900);
      const layout = await cdp.eval(LAYOUT);
      const scroll = await cdp.eval(SCROLL);
      const name = `${vp.w}x${vp.h}`;
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(`verify-w01r7-${name}-approval.png`, Buffer.from(shot.data, 'base64'));
      out.viewports.push({ viewport: name, layout, scroll });
      console.log(`\n===== ${name} =====`);
      console.log(JSON.stringify({ layout, scroll }));
    }

    // V5 轮询稳定性：1440×900，scrollTop=200，10 × 3s
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const samples = []; const syncs = new Set();
    for (let i = 0; i < 10; i++) {
      await sleep(3000);
      const s = await cdp.eval(`(() => ({
        top: document.getElementById('insp-body').scrollTop,
        sync: (document.getElementById('sb-sync')||{}).textContent || '',
        stepStill: !!document.querySelector('#insp-foot .btn-primary'),
        taskStill: !!document.querySelector('.req-item.sel, .req-item.on') || !!document.querySelector('.req-item[data-task="${TASK}"]'),
      }))()`);
      syncs.add(s.sync); samples.push(s.top);
    }
    out.poll = { setTo: 200, samples, min: Math.min(...samples), max: Math.max(...samples),
      maxDrift: Math.max(...samples.map(t => Math.abs(t - 200))),
      distinctSyncCount: syncs.size, distinctSyncSample: [...syncs].slice(0, 3) };
    console.log('\n===== poll 10x3s ====='); console.log(JSON.stringify(out.poll));

    // V7 done 步骤不显示操作区
    const doneClicked = await cdp.eval(`(() => { const n = document.querySelector('.track-node.st-done'); if (n) n.click(); return !!n; })()`);
    await sleep(500);
    out.doneStep = await cdp.eval(`(() => {
      const foot = document.getElementById('insp-foot');
      const insp = document.getElementById('inspector').getBoundingClientRect();
      const body = document.getElementById('insp-body').getBoundingClientRect();
      const cs = getComputedStyle(foot);
      return { hiddenAttr: foot.hidden, display: cs.display, rectH: foot.getBoundingClientRect().height,
               hasButtons: !!foot.querySelector('button'),
               bodyFillsToInspectorBottom: Math.abs(body.bottom - insp.bottom) < 1.5 };
    })()`);

    // 无对象步骤（T-DAILY / req，awaiting 无产物 → 应只有「补齐材料」进 foot）
    await cdp.eval(`document.querySelector('.req-item[data-task="T-DAILY"]')?.click()`);
    await sleep(600);
    await cdp.eval(`document.querySelector('.track-node[data-step="req"]')?.click()`);
    await sleep(900);
    out.noObjStep = await cdp.eval(`(() => {
      const foot = document.getElementById('insp-foot');
      const btn = foot.querySelector('button');
      const b = btn.getBoundingClientRect();
      return { hiddenAttr: foot.hidden, label: btn ? btn.textContent.trim() : null,
               visible: !foot.hidden && b.top >= 0 && b.bottom <= innerHeight,
               rect: { w: +b.width.toFixed(1), h: +b.height.toFixed(1) } };
    })()`);

    writeFileSync('verify-w01-round7.json', JSON.stringify(out, null, 1));
    console.log('\n===== done-step ====='); console.log(JSON.stringify(out.doneStep));
    console.log('\n===== noObj-step ====='); console.log(JSON.stringify(out.noObjStep));
    console.log('\nwrote verify-w01-round7.json');
  } finally {
    try { chrome.kill(); } catch {}
  }
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
