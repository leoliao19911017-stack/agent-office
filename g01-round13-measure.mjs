// G01 r13 一次性精确测量：四页区域内全部可见文本节点的 (字号/行高/颜色/对比度)，
// 严格对照 r13 档位：正文 13/20/#D6E0ED · 辅助 12/18/#B3C0D2 · 11/16 仅单行短标签 · 标题豁免。
// 不做控件/品牌色豁免的静默过滤——全部列出，人工判定哪些改、哪些留（语义状态色）。
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9484;
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
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject: (e) => reject(new Error(method + ': ' + e.message)) }));
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('page eval failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  }
}

// 在页面内跑：限定容器内全部文本节点 → computed 字号/行高/色/对比度/是否多行/mono/权重/标签
const MEASURE = (rootSel) => `(() => {
  const parseColor = (s) => { const m = s.match(/rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)(?:,\\s*([\\d.]+))?\\)/); return m ? { r:+m[1], g:+m[2], b:+m[3], a:m[4]===undefined?1:+m[4] } : null; };
  const blend = (fg, bg) => ({ r: fg.r*fg.a + bg.r*(1-fg.a), g: fg.g*fg.a + bg.g*(1-fg.a), b: fg.b*fg.a + bg.b*(1-fg.a) });
  const lum = (c) => { const f = (v) => { v/=255; return v<=0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); }; return 0.2126*f(c.r)+0.7152*f(c.g)+0.0722*f(c.b); };
  const contrast = (fg, bg) => { const a = blend(fg, bg); const l1 = lum(a), l2 = lum(bg); return (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05); };
  const solidBg = (el) => { let n = el; while (n && n !== document.documentElement) { const c = parseColor(getComputedStyle(n).backgroundColor); if (c && c.a >= 0.99) return c; n = n.parentElement; } return parseColor(getComputedStyle(document.body).backgroundColor) || {r:13,g:17,b:26,a:1}; };
  const hex = (c) => '#' + [c.r,c.g,c.b].map((v)=>Math.round(v).toString(16).padStart(2,'0')).join('').toUpperCase();
  const root = document.querySelector(${JSON.stringify(rootSel)});
  if (!root) return null;
  const skip = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','TITLE']);
  const out = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (!n.textContent.trim() || skip.has(n.parentElement?.tagName)) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
  const seen = new Set(); let n;
  while ((n = walker.nextNode())) {
    const el = n.parentElement; if (!el || seen.has(el)) continue; seen.add(el);
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const rects = el.getClientRects(); if (!rects.length) continue;
    const text = n.textContent.trim(); if (!text) continue;
    const fg = parseColor(cs.color), bg = solidBg(el); if (!fg) continue;
    let mark = el.tagName.toLowerCase(), p = el, hops = 0;
    while (hops < 4 && p && p !== root) {
      if (p.className && typeof p.className === 'string' && p.className.trim()) { mark = p.tagName.toLowerCase() + '.' + p.className.trim().split(/\\s+/).slice(0,3).join('.'); break; }
      p = p.parentElement; hops++;
    }
    out.push({ mark, tag: el.tagName.toLowerCase(), text: text.slice(0, 26), len: text.length,
      fs: parseFloat(cs.fontSize), lh: cs.lineHeight === 'normal' ? -1 : parseFloat(cs.lineHeight),
      color: hex(fg), bg: hex(bg), c: +contrast(fg, bg).toFixed(2),
      mono: /mono|consol|cascadia/i.test(cs.fontFamily), w: cs.fontWeight,
      multi: rects.length > 1 });
  }
  return out;
})()`;

async function waitFor(cdp, sel, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const c = await cdp.eval(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
    if (c > 0) return true;
    await sleep(250);
  }
  return false;
}

const TIER = { body: '13/20/#D6E0ED', meta: '12/18/#B3C0D2' };
const isTier = (x) => (x.fs === 13 && x.lh === 20 && x.color === '#D6E0ED') || (x.fs === 12 && x.lh === 18 && x.color === '#B3C0D2') || (x.fs === 11 && x.lh === 16);

async function main() {
  mkdirSync('D:/tmp', { recursive: true });
  const profile = join('D:/tmp', `g01r13m-${process.pid}`);
  const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--headless=new', '--no-first-run', '--disable-gpu', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
  try {
    let targets = null;
    for (let i = 0; i < 50; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`); targets = await r.json(); break; } catch { await sleep(200); } }
    if (!targets) throw new Error('chrome never came up');
    const cdp = await CDP.connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    // 图1：工作台 → 待拍板步骤
    await cdp.send('Page.navigate', { url: BASE + '/' }); await sleep(700);
    await cdp.eval(`document.getElementById('rail-reqs')?.click()`); await sleep(500);
    await waitFor(cdp, '.req-item'); await sleep(900);
    let aw = await cdp.eval(`(() => { const c = [...document.querySelectorAll('.step-card')].find((x) => x.querySelector('.st-awaiting')); if (c) { c.click(); return c.textContent.slice(0,40); } return null; })()`);
    if (!aw) { await cdp.eval(`document.querySelector('.req-item')?.click()`); await sleep(800);
      aw = await cdp.eval(`(() => { const c = [...document.querySelectorAll('.step-card')].find((x) => x.querySelector('.st-awaiting')); if (c) { c.click(); return c.textContent.slice(0,40); } return document.querySelector('#insp-body') ? document.querySelector('#insp-body').textContent.slice(0,40) : null; })()`); }
    await sleep(1000);
    console.log('图1 awaiting step:', JSON.stringify(aw));
    const pre = await cdp.eval(`!!document.querySelector('.ip-decide .pre'), !!document.querySelector('.material-mismatch'), !!document.querySelector('.done-line'), document.querySelector('.ip-decide')?.textContent.slice(0,60)`);
    console.log('图1 ip-decide present:', JSON.stringify(pre));
    const insp = await cdp.eval(MEASURE('#inspector'));

    // 图2：Agents → 逐张展开找 .agent-run p
    await cdp.eval(`document.getElementById('rail-agents').click()`); await waitFor(cdp, '#agent-grid > *'); await sleep(800);
    const runs = await cdp.eval(`[...document.querySelectorAll('.agent-select')].map((c) => !!c.closest('.agent-detail, #agent-grid > *') && c)`); // placeholder
    const runInfo = await cdp.eval(`(() => { const cards = [...document.querySelectorAll('#agent-grid > *')]; return cards.map((card, i) => ({ i, hasRunP: !!card.querySelector('.agent-run p'), name: card.querySelector('.agent-name')?.textContent })); })()`);
    console.log('图2 cards:', JSON.stringify(runInfo));
    const pick = (runInfo.find((c) => c.hasRunP) || {}).i ?? 0;
    await cdp.eval(`document.querySelectorAll('#agent-grid > *')[${pick}].querySelector('.agent-select')?.click() || document.querySelectorAll('.agent-select')[${pick}]?.click()`); await sleep(700);
    const agents = await cdp.eval(MEASURE('#page-agents'));

    // 图3：技能（展开第一张 → skilldetail）
    await cdp.eval(`document.getElementById('rail-skills').click()`); await waitFor(cdp, '#skill-list .skill-row'); await sleep(800);
    await cdp.eval(`document.querySelector('#skill-list .skill-row').click()`); await sleep(500);
    const skills = await cdp.eval(MEASURE('#page-skills'));

    // 图4：文件（列表 + 打开预览抽屉）
    await cdp.eval(`document.getElementById('rail-files').click()`); await waitFor(cdp, '#file-groups .library-file'); await sleep(800);
    const filesL = await cdp.eval(MEASURE('#page-files'));
    await cdp.eval(`document.querySelector('#file-groups .lf-main').click()`); await sleep(1000);
    const fvOpen = await cdp.eval(`!!document.querySelector('#file-view:not([hidden])') || getComputedStyle(document.getElementById('file-view')).display !== 'none'`);
    console.log('图4 drawer open:', fvOpen);
    const filesP = await cdp.eval(MEASURE('#file-view'));

    // —— 严格档位外节点（含控件；11/16 需单行）——
    const report = (name, arr) => {
      console.log(`\n===== ${name}（${arr ? arr.length : 'MISSING'} 节点）=====`);
      if (!arr) return;
      const off = arr.filter((x) => !isTier(x));
      const seen = new Map();
      for (const x of off) { const k = `${x.fs}/${x.lh}/${x.color}`; if (!seen.has(k)) seen.set(k, []); const l = seen.get(k); if (l.length < 4) l.push(`${x.mark}「${x.text}」len${x.len}${x.multi ? '多行' : ''}w${x.w}${x.mono ? ' mono' : ''}C${x.c}`); }
      for (const [k, marks] of [...seen.entries()].sort((a, b) => b[1].length - a[1].length)) console.log(`  ${k}  ×${off.filter((x) => `${x.fs}/${x.lh}/${x.color}` === k).length}  ${marks.join(' | ')}`);
      // 档位内节点数（正文/辅助/标签）
      const body = arr.filter((x) => x.fs === 13 && x.lh === 20 && x.color === '#D6E0ED').length;
      const meta = arr.filter((x) => x.fs === 12 && x.lh === 18 && x.color === '#B3C0D2').length;
      const lab = arr.filter((x) => x.fs === 11 && x.lh === 16).length;
      const lowC = arr.filter((x) => x.c < 4.5).map((x) => `${x.mark}「${x.text}」${x.fs}/${x.lh}/${x.color} C${x.c}`);
      console.log(`  档位内：正文${body} 辅助${meta} 标签${lab}；对比度<4.5：${lowC.length ? lowC.join(' ; ') : '无'}`);
    };
    report('图1 审批说明（#inspector）', insp);
    report('图2 Agents（#page-agents）', agents);
    report('图3 技能（#page-skills）', skills);
    report('图4 文件列表（#page-files）', filesL);
    report('图4 预览抽屉（#file-view）', filesP);
  } finally {
    chrome.kill(); await sleep(600);
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 400 }); } catch {}
  }
}
main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
