// verify-w01-foot.mjs — W01 底部固定操作区轮验收：三视口量 #insp-foot/#insp-body/按钮几何、
// 独立滚动、不占位、正文档位、scrollTop 稳定性。全部 getComputedStyle/getBoundingClientRect 实测。
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9337;
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
    if (r.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value; }
}

// 原子测量：一次 evaluate 里取全部几何/样式，规避 3s 轮询重渲染的中间态
const MEASURE = `(() => {
  const R = (el) => { const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), bottom: +r.bottom.toFixed(1), top: +r.top.toFixed(1) }; };
  const S = (el, props) => { const cs = getComputedStyle(el); const o = {}; for (const p of props) o[p] = cs[p]; return o; };
  const insp = document.getElementById('inspector');
  const head = document.querySelector('#inspector .insp-head');
  const body = document.getElementById('insp-body');
  const foot = document.getElementById('insp-foot');
  const sb = document.getElementById('statusbar');
  const footCs = S(foot, ['display','height','padding','backgroundColor','borderTopWidth','borderTopColor','borderTopStyle']);
  const bodyCs = S(body, ['overflowY','overflowX','flexGrow','minHeight']);
  const out = {
    viewport: { w: innerWidth, h: innerHeight },
    inspector: { rect: R(insp), position: S(insp,['position']).position, display: S(insp,['display']).display },
    head: { rect: R(head), h: S(head,['height']).height },
    body: { rect: R(body), cs: bodyCs, scrollHeight: body.scrollHeight, clientHeight: body.clientHeight, scrollTop: body.scrollTop },
    foot: { rect: R(foot), cs: footCs, hidden: foot.hidden },
    statusbar: { rect: R(sb) },
  };
  out.checks = {
    inspH: +(insp.getBoundingClientRect().height).toFixed(1),
    inspH_expect: innerHeight - 108,
    head48: head.getBoundingClientRect().height === 48,
    footH64: foot.getBoundingClientRect().height === 64,
    footBottomLeStatusbarTop: foot.getBoundingClientRect().bottom <= sb.getBoundingClientRect().top + 0.5,
    bodyScrollable: body.scrollHeight > body.clientHeight,
  };
  // 底栏按钮：逐个量尺寸/圆角，并确认完整可见
  out.buttons = [...foot.querySelectorAll('.btn')].map((b) => {
    const r = b.getBoundingClientRect(); const cs = getComputedStyle(b);
    return { label: b.textContent.trim(), decide: b.dataset.decide, cls: b.className,
      rect: R(b), minW: cs.minWidth, minH: cs.minHeight, radius: cs.borderRadius, disabled: b.disabled,
      inViewport: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth,
      aboveStatusbar: r.bottom <= sb.getBoundingClientRect().top + 0.5,
      gePrimary: r.width >= 86 && r.height >= 36, geSecondary: r.width >= 58 && r.height >= 36 };
  });
  const acts = foot.querySelector('.acts');
  if (acts) { const cs = getComputedStyle(acts);
    out.acts = { gap: cs.gap, display: cs.display, rect: R(acts) };
    // 按钮横向间距实测（相邻按钮 left 差 - 前按钮宽）
    const btns = [...acts.querySelectorAll('.btn')];
    if (btns.length >= 2) out.acts.measuredGap = +(btns[1].getBoundingClientRect().left - btns[0].getBoundingClientRect().right).toFixed(2);
  }
  // 正文档位：真实元素 + 探针（类挂在 #insp-body 下读 computed，验证规则本身）
  const probe = (tag, cls) => { const el = document.createElement(tag); el.className = cls; body.appendChild(el);
    const cs = getComputedStyle(el); const o = { cls, fs: cs.fontSize, lh: cs.lineHeight, color: cs.color };
    el.remove(); return o; };
  out.textProbes = [ probe('p','ip-note'), probe('p','rej-why'), probe('div','ip-v'), probe('p','ev-demand'), probe('p','ev-src') ];
  out.textReal = {};
  for (const sel of ['.ev-src','.ip-note','.rej-why','.ip-sec .ip-v','.ev-demand','.material-mismatch']) {
    const el = body.querySelector(sel);
    if (el) { const cs = getComputedStyle(el); out.textReal[sel] = { fs: cs.fontSize, lh: cs.lineHeight, color: cs.color, text: el.textContent.trim().slice(0,18) }; }
  }
  out.docScroll = { docEl: document.documentElement.scrollTop, body: document.body.scrollTop };
  out.centerScroll = document.getElementById('center').scrollTop;
  return out;
})()`;

const FOOT_HIDDEN_CHECK = `(() => {
  const foot = document.getElementById('insp-foot');
  const cs = getComputedStyle(foot);
  const sbTop = document.getElementById('statusbar').getBoundingClientRect().top;
  const body = document.getElementById('insp-body');
  const btnCount = foot.querySelectorAll('.btn').length;
  return { display: cs.display, hiddenAttr: foot.hidden, btnCount,
    rectH: foot.getBoundingClientRect().height,
    bodyBottomLeSbTop: body.getBoundingClientRect().bottom <= sbTop + 0.5,
    stepLabel: document.querySelector('#insp-body .ip-step')?.textContent || '',
    stepName: document.querySelector('#insp-body .ip-name')?.textContent || '' };
})()`;

const SCROLL_TEST = `(() => {
  const body = document.getElementById('insp-body');
  body.scrollTop = 1e9;
  const center = document.getElementById('center');
  return { scrollTop: body.scrollTop, scrollHeight: body.scrollHeight, clientHeight: body.clientHeight,
    reachedBottom: body.scrollTop + body.clientHeight >= body.scrollHeight - 1,
    centerScroll: center.scrollTop, docScroll: document.documentElement.scrollTop,
    footStillVisible: (() => { const f = document.getElementById('insp-foot'); const r = f.getBoundingClientRect();
      const sbTop = document.getElementById('statusbar').getBoundingClientRect().top;
      return r.height === 64 && r.bottom <= sbTop + 0.5; })() };
})()`;

async function main() {
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
    const page = targets.find((t) => t.type === 'page');
    const cdp = await CDP.connect(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');

    const gotoStep = async (task, step) => {
      await cdp.eval(`document.querySelector('.req-item[data-task="${task}"]')?.click()`);
      await sleep(450);
      await cdp.eval(`document.querySelector('.track-node[data-step="${step}"]')?.click()`);
      await sleep(1500);   // 等 file-check 异步核实 + 下一拍渲染落定
    };

    for (const vp of [{ w: 1440, h: 900 }, { w: 1280, h: 800 }, { w: 1100, h: 768 }]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: false });
      if (vp.w === 1440) {
        await cdp.send('Page.navigate', { url: BASE });
        for (let i = 0; i < 100; i++) { if (await cdp.eval(`!!document.querySelector('.req-item')`)) break; await sleep(200); }
        await sleep(800);
      }
      console.log(`\n===== ${vp.w}x${vp.h} · TEST-R11 / plan（awaiting 可拍板）=====`);
      await gotoStep('TEST-R11', 'plan');
      console.log(JSON.stringify(await cdp.eval(MEASURE), null, 1));

      // 滚动到底：独立滚动 + 不影响中栏 + 底栏不动
      console.log('--- scroll-to-bottom ---');
      console.log(JSON.stringify(await cdp.eval(SCROLL_TEST), null, 1));

      if (vp.w === 1440) {
        // 不可拍板步骤：done 步 / 等前置步 → 底栏必须隐藏不占位
        for (const [step, why] of [['req', 'done 步'], ['brief', 'awaiting 但等前置']]) {
          await cdp.eval(`document.querySelector('.track-node[data-step="${step}"]')?.click()`);
          await sleep(1200);
          const r = await cdp.eval(FOOT_HIDDEN_CHECK);
          console.log(`--- ${why}（${step}）底栏状态 ---`);
          console.log(JSON.stringify(r, null, 1));
        }
        // 回到 plan，做 scrollTop=200 十拍稳定性（3s 轮询重渲染下漂移 ≤2px）
        await cdp.eval(`document.querySelector('.track-node[data-step="plan"]')?.click()`);
        await sleep(1500);
        await cdp.eval(`document.getElementById('insp-body').scrollTop = 200`);
        const samples = [];
        for (let i = 0; i < 10; i++) {
          await sleep(3000);
          samples.push(await cdp.eval(`(() => { const b = document.getElementById('insp-body');
            return { t: b.scrollTop, btns: document.querySelectorAll('#insp-foot .btn').length,
              step: document.querySelector('#insp-body .ip-name')?.textContent.slice(0,10) }; })()`));
        }
        const tops = samples.map((s) => s.t);
        const drift = +(Math.max(...tops) - Math.min(...tops)).toFixed(2);
        console.log('--- scrollTop=200 十拍稳定性（每 3s）---');
        console.log(JSON.stringify({ samples, maxDrift: drift, ok: drift <= 2 }, null, 1));
      }
    }
  } finally {
    try { chrome.kill(); } catch {}
    try { execSync(`taskkill /PID ${chrome.pid} /T /F`, { stdio: 'ignore' }); } catch {}
  }
}
main().catch((e) => { console.error('FAIL', e); process.exit(1); });
