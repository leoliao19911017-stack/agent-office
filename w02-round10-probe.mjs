// W02 第 10 轮探针：右侧审批面板布局/样式/滚动 基线与复测共用。
// 用法: node w02-round10-probe.mjs <phase>   phase = baseline | after
// 输出: w02-round10-<phase>.json + 三视口截图 w02-round10-<phase>-<vp>.png
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9477;
const BASE = 'http://127.0.0.1:8090';
const TASK = 'TEST-R11';
const STEP = 'plan';
const VIEWPORTS = [{ w: 1440, h: 900 }, { w: 1280, h: 800 }, { w: 1100, h: 768 }];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const phase = process.argv[2] || 'baseline';

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
    if (r.exceptionDetails) throw new Error('page eval failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  }
}

const MEASURE = `(() => {
  const insp = document.getElementById('inspector');
  const head = insp.querySelector('.insp-head');
  const body = document.getElementById('insp-body');
  const foot = document.getElementById('insp-foot');
  const sb = document.getElementById('statusbar');
  const src = document.querySelector('#insp-body .ev-src');           // 测试策略说明
  const mm = document.querySelector('#insp-body .material-mismatch'); // 异常说明
  const chip = document.querySelector('#insp-body .ev-policy');       // 类型要求行内策略标注
  const cs = (el, ps) => { const c = getComputedStyle(el); const o = {}; for (const p of ps) o[p] = c.getPropertyValue(p); return o; };
  const r = (el) => { const b = el.getBoundingClientRect(); return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1), bottom: +b.bottom.toFixed(1) }; };
  const footR = foot.getBoundingClientRect();
  const bodyR = body.getBoundingClientRect();
  const mmR = mm.getBoundingClientRect();

  // 滚到底，异常说明是否完整可读（mm 底边 ≤ body 可视底边）
  body.scrollTop = body.scrollHeight;
  const maxTop = body.scrollTop;
  const mmBottomAfter = mm.getBoundingClientRect().bottom;
  const bodyClientBottom = bodyR.top + body.clientHeight;
  const readableAtBottom = mmBottomAfter <= bodyClientBottom + 0.5;

  // 滚回 mm 顶部对齐：异常说明起始是否可达
  body.scrollTop = Math.max(0, mm.offsetTop - 8);
  const mmTopAfter = mm.getBoundingClientRect().top;
  const mmReachableFromTop = mmTopAfter >= bodyR.top - 0.5 && mmTopAfter < bodyR.top + 40;

  const out = {
    innerWidth: window.innerWidth, innerHeight: window.innerHeight,
    inspector: Object.assign(r(insp), cs(insp, ['flex-direction', 'position'])),
    head: Object.assign(r(head), cs(head, ['height', 'box-sizing'])),
    body: Object.assign(r(body), cs(body, ['flex-grow', 'flex-shrink', 'min-height', 'overflow-y', 'overflow-x', 'padding-bottom'])),
    bodyRect: r(body),
    foot: Object.assign(r(foot), { hiddenAttr: foot.hidden }, cs(foot, ['height', 'display', 'box-sizing'])),
    footVisibleInView: footR.top >= 0 && footR.bottom <= window.innerHeight + 0.5,
    footPinnedWhileScrolled: Math.abs(foot.getBoundingClientRect().bottom - footR.bottom) < 0.5,
    bodyOverlapsFoot: bodyR.bottom > footR.top + 0.5,
    scroll: {
      scrollHeight: body.scrollHeight, clientHeight: body.clientHeight,
      maxTop, overflowX: body.scrollWidth - body.clientWidth,
      mmReadableAtBottom: readableAtBottom, mmBottomMinusClientBottom: +(mmBottomAfter - bodyClientBottom).toFixed(1),
      mmReachableFromTop,
    },
    evSrc: src ? Object.assign(r(src), cs(src, ['font-size', 'line-height', 'color', 'margin-top', 'margin-bottom'])) : null,
    evSrcText: src ? src.textContent.trim() : null,
    mm: mm ? Object.assign(r(mm), cs(mm, ['background-color', 'color', 'border-radius', 'padding', 'font-size', 'line-height', 'margin-top', 'margin-bottom'])) : null,
    mmText: mm ? mm.textContent.trim() : null,
    chipText: chip ? chip.textContent.trim() : null,
    otherRuleParas: (() => {
      const ipV = document.querySelector('#insp-body .ip-sec .ip-v');
      return ipV ? cs(ipV, ['font-size', 'line-height', 'color']) : null;
    })(),
  };
  body.scrollTop = 0;
  return out;
})()`;

async function main() {
  const out = { phase, base: BASE, task: TASK, step: STEP, when: new Date().toISOString(), viewports: [], poll: null };
  const profile = mkdtempSync(join(tmpdir(), 'w02r10-'));
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
      await sleep(1000); // 等文件核实 + version-gate 渲染稳定

      const m = await cdp.eval(MEASURE);
      // 底部态截图（滚到底 = 异常说明阅读位）
      await cdp.eval(`document.getElementById('insp-body').scrollTop = document.getElementById('insp-body').scrollHeight`);
      await sleep(200);
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(`w02-round10-${phase}-${vp.w}x${vp.h}-bottom.png`, Buffer.from(shot.data, 'base64'));
      out.viewports.push({ viewport: `${vp.w}x${vp.h}`, ...m });
      console.log(`\n===== ${vp.w}x${vp.h} =====`);
      console.log(JSON.stringify({
        head: m.head, foot: { h: m.foot.height, hidden: m.foot.hiddenAttr, visible: m.footVisibleInView, overlapsBody: m.bodyOverlapsFoot },
        body: { padB: m.body['padding-bottom'], ovY: m.body['overflow-y'], ovX: m.body['overflow-x'], flex: m.body['flex-grow'], scroll: m.scroll },
        evSrc: m.evSrc && { fs: m.evSrc['font-size'], lh: m.evSrc['line-height'], color: m.evSrc.color, mt: m.evSrc['margin-top'], mb: m.evSrc['margin-bottom'] },
        mm: m.mm && { bg: m.mm['background-color'], color: m.mm.color, radius: m.mm['border-radius'], pad: m.mm.padding, fs: m.mm['font-size'], lh: m.mm['line-height'], mt: m.mm['margin-top'], mb: m.mm['margin-bottom'] },
      }, null, 1));
    }

    // ---- 滚动稳定性：1440×900，scrollTop=200，10 次数据刷新（3s 轮询） ----
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.eval(`document.getElementById('insp-body').scrollTop = 200`);
    const samples = []; const syncTexts = new Set();
    for (let i = 0; i < 10; i++) {
      await sleep(3000);
      const s = await cdp.eval(`(() => {
        const b = document.getElementById('insp-body');
        return { top: b.scrollTop,
                 sync: (document.getElementById('sb-sync')||{}).textContent || '',
                 stillApproval: !!document.querySelector('#insp-foot .btn-primary'),
                 stillTask: !!document.querySelector('.req-item.sel[data-task="${TASK}"]') };
      })()`);
      syncTexts.add(s.sync); samples.push(s);
    }
    const tops = samples.map((s) => s.top);
    out.poll = {
      setTo: 200, tops,
      min: Math.min(...tops), max: Math.max(...tops),
      maxDrift: Math.max(...tops.map((t) => Math.abs(t - 200))),
      pollCount: syncTexts.size,
      stillApprovalAll: samples.every((s) => s.stillApproval),
      stillTaskAll: samples.every((s) => s.stillTask),
    };
    console.log('\n===== poll stability (10 x 3s) =====');
    console.log(JSON.stringify(out.poll, null, 1));
  } finally {
    try { chrome.kill(); } catch {}
    try { execSync(`taskkill /PID ${chrome.pid} /T /F`, { stdio: 'ignore' }); } catch {}
  }
  writeFileSync(`w02-round10-${phase}.json`, JSON.stringify(out, null, 1));
  console.log(`\nwrote w02-round10-${phase}.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
