// A01 探针：Agents 页范围说明段落实测 + 统计卡/列表不变性对照。
// 口径（A01 任务书）：
//   1) #agent-scope 字号12px、行高18px、颜色#8FA3BA
//   2) 1440×900 最多一行（容器高32px）；1280×800 最多两行（高48px）；不得水平溢出
//   3) 段落底 → 列表表头(.roster-head)顶 间距12px
//   4) 文案不得含内部字段名（agentStats 等）/技术校验说明
//   5) 三张统计卡数值与 .agent-card 数量 baseline/after 一致（筛选逻辑未动）
// 用法（repo 根目录）：
//   PHASE=baseline node --experimental-websocket a01-round-probe.mjs
//   PHASE=after    node --experimental-websocket a01-round-probe.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9351;
const BASE = 'http://127.0.0.1:8090';
const PHASE = process.env.PHASE || 'after';
const VIEWPORTS = [[1440, 900], [1280, 800]];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (e) => { const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result); } }); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    return new CDP(ws);
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject: (e) => reject(new Error(method + ': ' + e.message)) }));
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('page eval failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  }
}

async function waitFor(cdp, sel, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const n = await cdp.eval(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
    if (n > 0) return true;
    await sleep(250);
  }
  return false;
}

// —— DOM 实测：段落样式/几何/行数 + 表头间距 + 统计卡与列表计数 ——
const MEASURE = `(() => {
  const el = document.getElementById('agent-scope');
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const range = document.createRange(); range.selectNodeContents(el);
  const lineRects = [...range.getClientRects()].filter(x => x.width > 1 && x.height > 1).length;
  const padT = parseFloat(cs.paddingTop), padB = parseFloat(cs.paddingBottom);
  const linesByHeight = Math.round((el.scrollHeight - padT - padB) / parseFloat(cs.lineHeight));
  const head = document.querySelector('#agent-grid .roster-head');
  const headR = head ? head.getBoundingClientRect() : null;
  const gridEl = document.getElementById('agent-grid');
  const grid = gridEl.getBoundingClientRect();
  const before = getComputedStyle(el, '::before');
  return {
    text: el.textContent,
    beforeContent: before.content,
    computed: { fontSize: cs.fontSize, lineHeight: cs.lineHeight, color: cs.color,
      clamp: cs.getPropertyValue('-webkit-line-clamp'), display: cs.display,
      paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom, minHeight: cs.minHeight,
      maxWidth: cs.maxWidth, marginTop: cs.marginTop, marginBottom: cs.marginBottom },
    rect: { left: +r.left.toFixed(1), top: +r.top.toFixed(1), width: +r.width.toFixed(1), height: +r.height.toFixed(1) },
    overflowX: el.scrollWidth - el.clientWidth,
    lineRects, linesByHeight,
    gridMarginTop: getComputedStyle(gridEl).marginTop,
    gapToHead: headR ? +(headR.top - r.bottom).toFixed(1) : null,
    gapToGrid: +(grid.top - r.bottom).toFixed(1),
    stats: [...document.querySelectorAll('#agent-stats .stat-card')].map(c => ({
      label: c.querySelector('.sc-label')?.textContent, value: c.querySelector('.sc-num')?.textContent })),
    agentCards: document.querySelectorAll('#agent-grid .agent-card').length,
    innerW: window.innerWidth,
  };
})()`;

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'a01-cdp-'));
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--window-size=1440,900', 'about:blank',
  ], { stdio: 'ignore' });
  const out = { phase: PHASE, base: BASE, when: new Date().toISOString(), viewports: {}, shots: [] };
  try {
    let targets = null;
    for (let i = 0; i < 50; i++) {
      try { const res = await fetch(`http://127.0.0.1:${PORT}/json/list`); targets = await res.json(); break; }
      catch { await sleep(200); }
    }
    if (!targets) throw new Error('chrome devtools port never came up');
    const cdp = await CDP.connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

    for (const [W, H] of VIEWPORTS) {
      const vp = `${W}x${H}`;
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
      await cdp.send('Page.navigate', { url: BASE + '/' });
      await sleep(600);
      await cdp.eval(`document.getElementById('rail-agents').click()`);
      const ok = await waitFor(cdp, '#agent-grid .agent-card');
      await sleep(800);
      if (!ok) { out.viewports[vp] = { error: 'agent cards never rendered' }; continue; }
      out.viewports[vp] = await cdp.eval(MEASURE);
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const f = `a01-round-${PHASE}-${vp}-agents.png`;
      writeFileSync(f, Buffer.from(shot.data, 'base64'));
      out.shots.push(f);
    }
  } finally {
    chrome.kill();
  }
  const j = `a01-round-${PHASE}.json`;
  writeFileSync(j, JSON.stringify(out, null, 2));
  console.log('wrote', j, 'and', out.shots.join(', '));
}

main().catch((e) => { console.error(e); process.exit(1); });
