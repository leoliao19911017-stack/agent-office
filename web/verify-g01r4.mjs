// G01 第 4 轮审计：四页 **全 DOM 可见文本节点** 逐个量字号/行高/颜色/对比度（不再是抽样选择器），
// 并在 1440×900 与 1280×800 双视口下复测几何/溢出/行间遮挡。
// 用法： PHASE=baseline node --experimental-websocket verify-g01r4.mjs   （改前基线）
//       PHASE=after    node --experimental-websocket verify-g01r4.mjs   （改后，输出 diff）
// 硬规则（节点级）：A 对比度 ≥4.5 · B 字号 ≥11px · C <12px 必须是短标签（≤16 字符的 chip）
//                  D 颜色不得用 alpha<1 透明度弱化 · E 「—」占位以外的真文字不得用 #8996A8 弱化灰
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9338;
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

// 全 DOM 文本节点巡检：TreeWalker 取所有可见文本节点，逐个取计算样式与几何
const WALK = `(() => { ${UTIL}
  const skip = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','TITLE']);
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (!n.textContent.trim() || skip.has(n.parentElement?.tagName)) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
  const seen = new Set();
  let n;
  while ((n = walker.nextNode()) && out.length < 600) {
    const el = n.parentElement; if (!el || seen.has(el)) continue; seen.add(el);
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const rects = el.getClientRects(); if (!rects.length) continue;
    const text = n.textContent.trim(); if (!text) continue;
    const fg = parseColor(cs.color), bg = solidBg(el);
    if (!fg) continue;
    const b = el.getBoundingClientRect();
    // 找带 class 的最近祖先，做定位标签（tag.chain）
    let mark = el.tagName.toLowerCase(), p = el, hops = 0;
    while (hops < 3 && p && p !== document.body) {
      if (p.className && typeof p.className === 'string' && p.className.trim()) { mark = p.tagName.toLowerCase() + '.' + p.className.trim().split(/\\s+/).slice(0,3).join('.'); break; }
      p = p.parentElement; hops++;
    }
    out.push({ mark, tag: el.tagName.toLowerCase(),
      text: text.slice(0, 28), len: text.length,
      fontSize: parseFloat(cs.fontSize), lineHeight: cs.lineHeight === 'normal' ? -1 : parseFloat(cs.lineHeight),
      color: hex(fg), rawColor: cs.color, alpha: fg.a, bg: hex(bg),
      contrast: +contrast(fg, bg).toFixed(2),
      mono: cs.fontFamily.toLowerCase().includes('mono') || cs.fontFamily.toLowerCase().includes('consol') || cs.fontFamily.toLowerCase().includes('cascadia'),
      weight: cs.fontWeight,
      rect: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
      clipX: el.scrollWidth > el.clientWidth + 1,
      escX: b.right > window.innerWidth + 1 || b.left < -1 });
  }
  return { nodes: out, walkedAll: out.length < 600, pageOverflowX: document.documentElement.scrollWidth > window.innerWidth,
    viewport: { w: window.innerWidth, h: window.innerHeight } };
})()`;

// 几何 + 相邻行遮挡检查（图2 名册 / 图3 技能卡 / 图4 文件行）
const GEOM = `(() => {
  const hs = (sel) => [...document.querySelectorAll(sel)].slice(0, 12).map((el) => Math.round(el.getBoundingClientRect().height));
  const ws = (sel) => [...document.querySelectorAll(sel)].slice(0, 12).map((el) => Math.round(el.getBoundingClientRect().width));
  const overlap = (sel) => { const els = [...document.querySelectorAll(sel)].slice(0, 12); const bad = [];
    for (let i = 1; i < els.length; i++) { const a = els[i-1].getBoundingClientRect(), b = els[i].getBoundingClientRect();
      if (a.bottom > b.top + 1 && a.top < b.bottom + 1 && a.left < b.right && b.left < a.right) bad.push({ i, aBottom: Math.round(a.bottom), bTop: Math.round(b.top) }); }
    return bad; };
  return {
    reqItems: hs('.req-item'), agentCards: hs('#agent-grid > *'), skillRows: hs('#skill-list .skill-row'),
    fileRows: hs('#file-groups .library-file'), fileMainW: ws('#file-groups .lf-main'),
    rosterOverlap: overlap('.agent-select'), skillOverlap: overlap('#skill-list .skill-row'), fileOverlap: overlap('#file-groups .library-file'),
    pageOverflowX: document.documentElement.scrollWidth > window.innerWidth,
  };
})()`;

async function waitFor(cdp, sel, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const n = await cdp.eval(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
    if (n > 0) return true;
    await sleep(250);
  }
  return false;
}
async function shot(cdp, path) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path, Buffer.from(r.data, 'base64'));
}

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'g01r4-cdp-'));
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

    for (const [W, H] of VIEWPORTS) {
      const vp = `${W}x${H}`;
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
      const V = out.viewports[vp] = {};

      // 图1 工作台
      await cdp.send('Page.navigate', { url: BASE + '/' });
      await waitFor(cdp, '.req-item'); await sleep(700);
      V.workbench = await cdp.eval(WALK); V.geomWorkbench = await cdp.eval(GEOM);

      // 图2 Agents（列表态 + 展开第一张卡）
      await cdp.eval(`document.getElementById('rail-agents').click()`);
      await waitFor(cdp, '#agent-grid > *'); await sleep(700);
      V.agentsList = await cdp.eval(WALK);
      await cdp.eval(`document.querySelector('.agent-select').click()`); await sleep(500);
      V.agentsDetail = await cdp.eval(WALK);
      await cdp.eval(`document.querySelector('.agent-select').click()`); await sleep(300);
      V.geomAgents = await cdp.eval(GEOM);

      // 图3 技能（含展开第一张卡 → skill-path）
      await cdp.eval(`document.getElementById('rail-skills').click()`);
      await waitFor(cdp, '#skill-list .skill-row'); await sleep(700);
      await cdp.eval(`document.querySelector('#skill-list .skill-row').click()`); await sleep(400);
      V.skills = await cdp.eval(WALK); V.geomSkills = await cdp.eval(GEOM);

      // 图4 文件（含点第一行开预览抽屉 → fv-path / fvd-row）
      await cdp.eval(`document.getElementById('rail-files').click()`);
      await waitFor(cdp, '#file-groups .library-file'); await sleep(700);
      V.filesList = await cdp.eval(WALK);
      await cdp.eval(`document.querySelector('#file-groups .lf-main').click()`); await sleep(900);
      V.filesPreview = await cdp.eval(WALK); V.geomFiles = await cdp.eval(GEOM);

      if (PHASE === 'after') {
        for (const [key, name] of [['workbench','p1-workbench'],['agentsList','p2-agents'],['skills','p3-skills'],['filesPreview','p4-files']]) {
          const f = `verify-g01r4-${vp}-${name}.png`; await shot(cdp, f); out.shots.push(f);
        }
      }
    }

    // 规则判定（Node 侧）：A 对比度 · B 字号下限 · C <12px 必须短标签 · D 无透明弱化 · E 弱化灰只许「—」
    const BRAND = ['#62C6A0', '#E5B95E', '#E0B341', '#78A8F5', '#6C9EF1', '#5B8FF9', '#D96A6A', '#E07B7B'];
    const classify = (nodes) => {
      const isControl = (n) => ['button', 'a', 'select', 'option', 'input'].includes(n.tag);
      const bad = [];
      for (const n of nodes) {
        const v = [];
        if (n.contrast < 4.5) v.push('A:contrast=' + n.contrast);
        if (n.fontSize < 11) v.push('B:size=' + n.fontSize);
        if (n.fontSize < 12 && !isControl(n) && n.len > 16) v.push('C:sub12-longtext');
        if (n.alpha < 0.99) v.push('D:alpha=' + n.alpha);
        if (n.color === '#8996A8' && !/^([—–-]|未知|无|N\/A)$/.test(n.text) && n.len > 2) v.push('E:faint-on-text');
        if (v.length) bad.push({ ...n, rules: v });
      }
      const dim = nodes.filter((n) => n.fontSize < 12 && !isControl(n));
      const offtier = nodes.filter((n) => { // 信息性：辅助档颜色不落 #B3C0D2/#E2EAF4 的正文类节点
        if (isControl(n)) return false;
        if (BRAND.includes(n.color) || n.weight >= 600) return false;
        if (n.color === '#B3C0D2' || n.color === '#E2EAF4' || n.color === '#8996A8') return false;
        return n.fontSize <= 13 && n.len > 2 && !/^([—–-])$/.test(n.text);
      });
      const esc = nodes.filter((n) => n.escX);
      return { total: nodes.length, bad, dimCount: dim.length, offtier, escCount: esc.length };
    };
    for (const vp of Object.keys(out.viewports)) {
      const V = out.viewports[vp];
      V.audit = {};
      for (const key of ['workbench', 'agentsList', 'agentsDetail', 'skills', 'filesList', 'filesPreview']) {
        if (V[key]) V.audit[key] = classify(V[key].nodes);
      }
    }

    // after 轮 diff：与 baseline 比几何
    if (PHASE === 'after' && existsSync('verify-g01r4-baseline.json')) {
      const base = JSON.parse(readFileSync('verify-g01r4-baseline.json', 'utf8'));
      const geomKeys = ['geomWorkbench', 'geomAgents', 'geomSkills', 'geomFiles'];
      out.geomDiff = {};
      for (const vp of Object.keys(out.viewports)) {
        out.geomDiff[vp] = {};
        for (const gk of geomKeys) {
          const a = base.viewports[vp]?.[gk] || {}, b = out.viewports[vp][gk];
          const row = {};
          for (const k of ['reqItems', 'agentCards', 'skillRows', 'fileRows', 'fileMainW']) {
            row[k] = { base: a[k], now: b[k], same: JSON.stringify(a[k]) === JSON.stringify(b[k]) };
          }
          for (const k of ['rosterOverlap', 'skillOverlap', 'fileOverlap', 'pageOverflowX']) row[k] = { base: a[k], now: b[k] };
          out.geomDiff[vp][gk] = row;
        }
      }
      out.badBaseline = {};
      for (const vp of Object.keys(base.viewports)) {
        out.badBaseline[vp] = {};
        for (const key of Object.keys(base.viewports[vp].audit || {})) out.badBaseline[vp][key] = base.viewports[vp].audit[key].bad;
      }
    }

    writeFileSync(PHASE === 'after' ? 'verify-g01r4.json' : 'verify-g01r4-baseline.json', JSON.stringify(out, null, 1));
    const cnt = (vp, key) => out.viewports[vp][key] ? out.viewports[vp][key].nodes.length : 0;
    console.log('written:', PHASE, 'nodes@1440:', ['workbench','agentsList','agentsDetail','skills','filesList','filesPreview'].map((k) => k + '=' + cnt('1440x900', k)).join(' '));
  } finally {
    chrome.kill();
  }
}
main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
