// S01 第 12 轮验证：技能摘要两行 + 卡片统一 144px。
// 用法： node --experimental-websocket verify-s01r12.mjs [phase]   phase=baseline|after（默认 after）
// 量测口径（全部页面内真实 getComputedStyle / getBoundingClientRect / Range.getClientRects）：
//   A 第一页 6 张卡高度 144±1px · 全页 20 张一致性
//   B padding 16 / radius 8 / 卡底 #182230 / #skill-list gap 16×16 / 双列
//   C 标题 14/20 单行 · 摘要 13/20 · line-clamp 2 · white-space normal · 摘要区固定 40px
//   D 摘要实际渲染行数（文本节点 Range 行盒数，nowrap=1 行的实锤口径）= 2（长摘要）
//   E 摘要底 → .sk-meta 顶 ≥ 12px · 摘要不覆盖标签
//   F 1440 与 1280 双视口：无横向滚动、双列保持、总数 222
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9347;
const BASE = process.env.BASE || 'http://127.0.0.1:8090';
const PHASE = process.argv[2] || 'after';
const VIEWPORTS = [[1440, 900], [1280, 800]];

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
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('page eval failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  }
}

const MEASURE = `(() => {
  const out = {};
  const cards = [...document.querySelectorAll('#skill-list .skill-row')];
  out.cardCount = cards.length;
  out.countText = (document.getElementById('skill-count').textContent || '').trim();
  const r = (el) => el.getBoundingClientRect();
  const cs = (el) => getComputedStyle(el);
  out.first6 = cards.slice(0, 6).map((c) => ({
    h: +r(c).height.toFixed(2), w: +r(c).width.toFixed(2),
    top: +r(c).top.toFixed(1), left: +r(c).left.toFixed(1),
    pad: cs(c).padding, radius: cs(c).borderRadius, bg: cs(c).backgroundColor,
  }));
  out.allHeights = [...new Set(cards.map((c) => +r(c).height.toFixed(1)))];
  const list = document.getElementById('skill-list');
  out.list = { gap: cs(list).gap, cols: cs(list).gridTemplateColumns.split(' ').length,
    colWidths: cs(list).gridTemplateColumns.split(' ').map((s) => +s.replace('px','')).map((v)=>+v.toFixed(1)) };
  const c0 = cards[0], b = c0.querySelector('b'), s = c0.querySelector('small'), meta = c0.querySelector('.sk-meta');
  const pick = (el) => { const p = [...el.querySelectorAll('.skill-row small')];
    return p.map((x) => { const range = document.createRange(); range.selectNodeContents(x);
      const rects = [...range.getClientRects()].filter((q) => q.width > 1);
      return { text: x.textContent.slice(0, 24), lines: rects.length, h: +x.getBoundingClientRect().height.toFixed(1),
        scrollH: x.scrollHeight, clientH: x.clientHeight,
        clamped: x.scrollHeight > x.clientHeight + 1,
        fs: cs(x).fontSize, lh: cs(x).lineHeight, ws: cs(x).whiteSpace, clamp: cs(x).webkitLineClamp ?? cs(x).getPropertyValue('-webkit-line-clamp') }; }); };
  out.summaries = pick(document).slice(0, 6);
  out.title0 = { fs: cs(b).fontSize, lh: cs(b).lineHeight, ws: cs(b).whiteSpace,
    lineRects: (() => { const rg = document.createRange(); rg.selectNodeContents(b); return [...rg.getClientRects()].filter((q)=>q.width>1).length; })() };
  const sRect = s.getBoundingClientRect(), mRect = meta.getBoundingClientRect();
  out.gapSummaryToTags = +(mRect.top - sRect.bottom).toFixed(1);
  out.metaOverlaps = mRect.top < sRect.bottom - 0.5;
  out.hScroll = document.documentElement.scrollWidth > window.innerWidth + 1;
  out.docW = document.documentElement.scrollWidth, out.winW = window.innerWidth;
  const xs = [...new Set(cards.slice(0, 6).map((c) => Math.round(r(c).left)))];
  out.distinctCols = xs.length;
  return out;
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, '--headless=new', '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', `--window-size=1440,900`, 'about:blank',
], { stdio: 'ignore' });
await sleep(1800);

try {
  const t = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const tab = t.find((x) => x.type === 'page');
  const cdp = await CDP.connect(tab.webSocketDebuggerUrl);
  const report = { phase: PHASE, viewports: {} };
  for (const [w, h] of VIEWPORTS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: `${BASE}/#/skills` });
    await sleep(3500);   // 等 /api/office/skills 渲染
    const m = await cdp.eval(MEASURE);
    report.viewports[`${w}x${h}`] = m;
    if (PHASE === 'after' && w === 1440) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(`verify-s01r12-${w}x${h}-skills.png`, Buffer.from(shot.data, 'base64'));
    }
  }
  writeFileSync(`verify-s01r12-${PHASE}.json`, JSON.stringify(report, null, 2));
  for (const [vp, m] of Object.entries(report.viewports)) {
    console.log(`\n===== ${vp} (${PHASE}) =====`);
    console.log(`卡片数=${m.cardCount} 计数行="${m.countText}" 高度集合=[${m.allHeights}]`);
    console.log(`list: gap=${m.list.gap} 列数=${m.list.cols} 列宽=[${m.list.colWidths}] 不同左缘列数=${m.distinctCols}`);
    console.log(`横向滚动=${m.hScroll} (docW=${m.docW} winW=${m.winW})`);
    const f = m.first6[0];
    console.log(`卡1: h=${f.h} w=${f.w} pad="${f.pad}" radius=${f.radius} bg=${f.bg}`);
    console.log(`标题: fs=${m.title0.fs} lh=${m.title0.lh} ws=${m.title0.ws} 行盒数=${m.title0.lineRects}`);
    for (const s of m.summaries.slice(0, 3))
      console.log(`摘要: lines=${s.lines} h=${s.h} clamp=${s.clamp} ws=${s.ws} fs=${s.fs} lh=${s.lh} clamped=${s.clamped} "${s.text}…"`);
    console.log(`摘要底→标签顶=${m.gapSummaryToTags}px 覆盖=${m.metaOverlaps}`);
    const hs = m.first6.map((x) => x.h);
    console.log(`前6卡高度: [${hs}] 全部144±1=${hs.every((x) => Math.abs(x - 144) <= 1)}`);
  }
} finally {
  chrome.kill();
}
