// G01 r10 补测：1280×800 下图1 工作台（等左列表 DOM 稳定后再采样，消除 3s 轮询重渲染竞态）
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9342;
const BASE = 'http://127.0.0.1:8090';
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
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('page eval failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  }
}

const UTIL = `
const parseColor = (s) => { const m = s.match(/rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)(?:,\\s*([\\d.]+))?\\)/); return m ? { r:+m[1], g:+m[2], b:+m[3], a:m[4]===undefined?1:+m[4] } : null; };
const blend = (fg, bg) => ({ r: fg.r*fg.a + bg.r*(1-fg.a), g: fg.g*fg.a + bg.g*(1-fg.a), b: fg.b*fg.a + bg.b*(1-fg.a) });
const lum = (c) => { const f = (v) => { v/=255; return v<=0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); }; return 0.2126*f(c.r)+0.7152*f(c.g)+0.0722*f(c.b); };
const contrast = (fg, bg) => { const a = blend(fg, bg); const l1 = lum(a), l2 = lum(bg); return (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05); };
const solidBg = (el) => { let n = el; while (n && n !== document.documentElement) { const c = parseColor(getComputedStyle(n).backgroundColor); if (c && c.a >= 0.99) return c; n = n.parentElement; } return parseColor(getComputedStyle(document.body).backgroundColor) || {r:13,g:17,b:26,a:1}; };
const hex = (c) => '#' + [c.r,c.g,c.b].map((v)=>Math.round(v).toString(16).padStart(2,'0')).join('').toUpperCase();
`;

const WALK = `(() => { ${UTIL}
  const skip = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','TITLE']);
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (!n.textContent.trim() || skip.has(n.parentElement?.tagName)) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
  const seen = new Set(); let n;
  while ((n = walker.nextNode()) && out.length < 600) {
    const el = n.parentElement; if (!el || seen.has(el)) continue; seen.add(el);
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const rects = el.getClientRects(); if (!rects.length) continue;
    const text = n.textContent.trim(); if (!text) continue;
    const fg = parseColor(cs.color), bg = solidBg(el); if (!fg) continue;
    const b = el.getBoundingClientRect();
    let mark = el.tagName.toLowerCase(), cls = '', p = el, hops = 0;
    while (hops < 3 && p && p !== document.body) {
      if (p.className && typeof p.className === 'string' && p.className.trim()) { mark = p.tagName.toLowerCase() + '.' + p.className.trim().split(/\\s+/).slice(0,3).join('.'); cls = p.className.trim().split(/\\s+/)[0]; break; }
      p = p.parentElement; hops++; }
    out.push({ mark, cls, tag: el.tagName.toLowerCase(), text: text.slice(0, 30), len: text.length,
      fontSize: parseFloat(cs.fontSize), lineHeight: cs.lineHeight === 'normal' ? -1 : parseFloat(cs.lineHeight),
      color: hex(fg), alpha: fg.a, bg: hex(bg), contrast: +contrast(fg, bg).toFixed(2),
      mono: cs.fontFamily.toLowerCase().includes('mono') || cs.fontFamily.toLowerCase().includes('consol') || cs.fontFamily.toLowerCase().includes('cascadia'),
      weight: cs.fontWeight, rect: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
      clipX: el.scrollWidth > el.clientWidth + 1, multiLine: rects.length > 1,
      escX: b.right > window.innerWidth + 1 || b.left < -1 });
  }
  return { nodes: out, pageOverflowX: document.documentElement.scrollWidth > window.innerWidth };
})()`;

const GEOM = `(() => ({
  reqItems: [...document.querySelectorAll('.req-item')].slice(0,8).map((el)=>Math.round(el.getBoundingClientRect().height)),
  pageOverflowX: document.documentElement.scrollWidth > window.innerWidth,
}))()`;

const profile = mkdtempSync(join(tmpdir(), 'g01r10b-cdp-'));
const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' });
try {
  let targets = null;
  for (let i = 0; i < 50; i++) { try { const res = await fetch(`http://127.0.0.1:${PORT}/json/list`); targets = await res.json(); break; } catch { await sleep(200); } }
  if (!targets) throw new Error('chrome devtools port never came up');
  const cdp = await CDP.connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable'); await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: BASE + '/' });
  await sleep(800);
  // 等 .req-item 有非零高度（轮询重渲染会瞬时替换 DOM，等稳定帧）
  let stable = 0;
  for (let i = 0; i < 40; i++) {
    const h = await cdp.eval(`(() => { const el = document.querySelector('.req-item'); return el ? Math.round(el.getBoundingClientRect().height) : -1; })()`);
    if (h > 0) { stable++; if (stable >= 3) break; } else stable = 0;
    await sleep(400);
  }
  const inspEmpty = await cdp.eval(`!document.querySelector('#insp-body') || !document.querySelector('#insp-body').textContent.trim()`);
  if (inspEmpty) { await cdp.eval(`document.querySelector('.req-item')?.click()`); await sleep(700); }
  await sleep(600); // 等一次 3s 轮询周期过去再测，避免测到半渲染帧
  const walk = await cdp.eval(WALK);
  const geom = await cdp.eval(GEOM);
  writeFileSync('g01-round10-recheck-1280-workbench.json', JSON.stringify({ when: new Date().toISOString(), geom, walk }, null, 1));
  console.log('reqItems:', JSON.stringify(geom.reqItems), 'overflowX:', geom.pageOverflowX, 'nodes:', walk.nodes.length);
} finally { chrome.kill(); }
