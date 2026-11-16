// verify-w01.mjs — W01 验收实测：CDP 直连 headless Chrome，量 TEST-R11 审批卡里
// 文件预览条目（.ev-file）两行布局的真实数值：字号/行高/颜色/字重、矩形、重叠、溢出。
// 用法：node --experimental-websocket verify-w01.mjs [longname-test:on|off] [输出.json]
// 依赖：Chrome + 127.0.0.1:8090 已在跑当前代码（只读，不做任何写操作）。

import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9334;
const BASE = 'http://127.0.0.1:8090';
const TASK = 'TEST-R11';
const STEP = 'plan';           // awaiting 步骤 → 渲染审批卡（ip-decide + ev 文件预览）
const LONG = process.argv[2] === 'long';
const LONG_NAME = 'a'.repeat(120) + '-超长文件名测试-never-ends-here.css';
const VIEWPORTS = [{ w: 1440, h: 900 }, { w: 1280, h: 800 }];
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
  const file = document.querySelector('#insp-body .ev-file');
  if (!file) return { found: false };
  const txt = file.querySelector('.ev-file-txt');
  const fn = file.querySelector('.fn');
  const meta = file.querySelector('small');
  const msz = meta ? meta.querySelector('.msz') : null;
  const mtp = meta ? meta.querySelector('.mtp') : null;
  const inspBody = document.getElementById('insp-body');
  const insp = document.getElementById('inspector');
  const cs = (el, props) => { const c = getComputedStyle(el); const o = {}; for (const p of props) o[p] = c.getPropertyValue(p); return o; };
  const r = (el) => { const b = el.getBoundingClientRect(); return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) }; };
  const fnR = fn.getBoundingClientRect(), mR = meta.getBoundingClientRect();
  // 重叠判定：纵向区间是否相交（水平上同一列必然重叠，关键是两行不能叠在一起）
  const overlapY = !(fnR.bottom <= mR.top + 0.5 || mR.bottom <= fnR.top + 0.5);
  const fnClipW = inspBody.getBoundingClientRect().right;
  const trunc = (el) => el ? el.scrollWidth > el.clientWidth + 1 : null;
  // msz/mtp 是否同行（换行了说明面板窄，两段各占一行）
  const sameLine = msz && mtp ? Math.abs(msz.getBoundingClientRect().top - mtp.getBoundingClientRect().top) < 1 : null;
  return {
    found: true,
    fileText: file.textContent.replace(/\\s+/g, ' ').trim().slice(0, 120),
    fileNameShown: fn.textContent,
    metaShown: meta.textContent,
    mszShown: msz ? msz.textContent : null,
    mtpShown: mtp ? mtp.textContent : null,
    file: Object.assign(r(file), cs(file, ['min-height', 'padding', 'background-color', 'border', 'border-radius', 'border-color'])),
    fn: Object.assign(r(fn), cs(fn, ['font-size', 'line-height', 'font-weight', 'color', 'white-space', 'text-overflow', 'overflow'])),
    meta: Object.assign(r(meta), cs(meta, ['font-size', 'line-height', 'color', 'flex-wrap', 'row-gap', 'column-gap'])),
    msz: msz ? Object.assign(r(msz), { truncated: trunc(msz) }) : null,
    mtp: mtp ? Object.assign(r(mtp), { truncated: trunc(mtp) }) : null,
    txt: Object.assign(r(txt), cs(txt, ['flex-direction', 'row-gap', 'min-width'])),
    metaOneLine: sameLine,
    fnEllipsized: trunc(fn),
    rowsOverlapY: overlapY,
    verticalGap: +(mR.top - fnR.bottom).toFixed(2),
    // 右侧面板溢出：文件条目右缘 vs 详情滚动容器右缘；文档级横向溢出
    fileRightVsBodyRight: +(fnR.right - fnClipW).toFixed(2),
    inspBodyOverflowX: inspBody.scrollWidth - inspBody.clientWidth,
    inspOverflowX: insp.scrollWidth - insp.clientWidth,
    docOverflowX: document.documentElement.scrollWidth - window.innerWidth,
    bodyOverflowX: document.body.scrollWidth - document.body.clientWidth,
    gapPx: (() => { const c = getComputedStyle(txt); return c.rowGap; })(),
  };
})()`;

async function main() {
  const out = { base: BASE, task: TASK, step: STEP, longNameTest: LONG, when: new Date().toISOString(), viewports: [] };
  const profile = mkdtempSync(join(tmpdir(), 'w01-cdp-'));
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
      await sleep(900);   // 等文件核实（物理大小）渲染稳定

      if (LONG) {
        // 注入超长文件名（不落盘、不碰数据接口，纯 DOM 验证溢出防护）
        await cdp.eval(`(() => {
          const fn = document.querySelector('#insp-body .ev-file .fn');
          if (fn) fn.textContent = ${JSON.stringify(LONG_NAME)};
        })()`);
        await sleep(100);
      }

      const measure = await cdp.eval(MEASURE);
      const vpw = `${vp.w}x${vp.h}`;
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const suffix = LONG ? 'long' : 'base';
      writeFileSync(`verify-w01-${vpw}-${suffix}.png`, Buffer.from(shot.data, 'base64'));
      out.viewports.push({ viewport: vpw, measure });
      console.log(`\n===== ${vpw}${LONG ? ' (long-name)' : ''} =====`);
      console.log(JSON.stringify(measure, null, 1));
    }
  } finally {
    try { chrome.kill(); } catch {}
    try { execSync(`taskkill /PID ${chrome.pid} /T /F`, { stdio: 'ignore' }); } catch {}
  }
  const outPath = process.argv[3] || (LONG ? 'verify-w01-long.json' : 'verify-w01-base.json');
  writeFileSync(outPath, JSON.stringify(out, null, 1));
  console.log(`\nwrote ${outPath}`);
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });
