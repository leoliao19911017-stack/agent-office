// G01 第 12 轮审计探针：四页全 DOM 可见文本节点逐个量 fontSize/lineHeight/color/对比度，
// 双视口 1440×900 / 1280×800 复测几何、溢出、Inspector 滚动可达性；after 与 baseline diff。
// 本轮判定档位（G01 r12 任务口径）：
//   普通正文   13px / 20px / #D6E0ED（等宽与否不限，如 Agent 标识 mono 正文）
//   辅助元数据 12px / 18px / #B3C0D2
//   短标签     11px / 16px（仅限单行 ≤16 字符）
//   文件路径   12px 等宽（色 #B3C0D2，与元数据一致）
//   正文对比度 ≥ 4.5:1（卡片底 #182230 / 面板底 #121925）
// 豁免：表单控件与链接、标题（h1-4 / ≥14px / ≥600 权重 / 标题类）、品牌语义色
//   （绿金蓝红系）、F01 r12 版本判定色 #65D9B1/#AFC0D5、A02 r3 心跳 off #91A0B4、
//   「—」诚实占位（仍查对比度）、#fv-body 文件内容预览。
// 用法（repo 根目录，node22 自带 WebSocket；profile 落 D 盘防 C 盘 ENOSPC）：
//   PHASE=baseline node g01-round12-probe.mjs
//   PHASE=after    node g01-round12-probe.mjs
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const NODE = process.execPath;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9483;
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

const UTIL = `
const parseColor = (s) => { const m = s.match(/rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)(?:,\\s*([\\d.]+))?\\)/); return m ? { r:+m[1], g:+m[2], b:+m[3], a:m[4]===undefined?1:+m[4] } : null; };
const blend = (fg, bg) => ({ r: fg.r*fg.a + bg.r*(1-fg.a), g: fg.g*fg.a + bg.g*(1-fg.a), b: fg.b*fg.a + bg.b*(1-fg.a) });
const lum = (c) => { const f = (v) => { v/=255; return v<=0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); }; return 0.2126*f(c.r)+0.7152*f(c.g)+0.0722*f(c.b); };
const contrast = (fg, bg) => { const a = blend(fg, bg); const l1 = lum(a), l2 = lum(bg); return (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05); };
const solidBg = (el) => { let n = el; while (n && n !== document.documentElement) { const c = parseColor(getComputedStyle(n).backgroundColor); if (c && c.a >= 0.99) return c; n = n.parentElement; } return parseColor(getComputedStyle(document.body).backgroundColor) || {r:13,g:17,b:26,a:1}; };
const hex = (c) => '#' + [c.r,c.g,c.b].map((v)=>Math.round(v).toString(16).padStart(2,'0')).join('').toUpperCase();
`;

// 全 DOM 文本节点巡检（与 r10 同构，mark 归类保留 3 层祖先）
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
    let mark = el.tagName.toLowerCase(), cls = '', p = el, hops = 0;
    while (hops < 3 && p && p !== document.body) {
      if (p.className && typeof p.className === 'string' && p.className.trim()) { mark = p.tagName.toLowerCase() + '.' + p.className.trim().split(/\\s+/).slice(0,3).join('.'); cls = p.className.trim().split(/\\s+/)[0]; break; }
      p = p.parentElement; hops++;
    }
    out.push({ mark, cls, tag: el.tagName.toLowerCase(),
      text: text.slice(0, 30), len: text.length,
      fontSize: parseFloat(cs.fontSize), lineHeight: cs.lineHeight === 'normal' ? -1 : parseFloat(cs.lineHeight),
      color: hex(fg), rawColor: cs.color, alpha: fg.a, bg: hex(bg),
      contrast: +contrast(fg, bg).toFixed(2),
      mono: cs.fontFamily.toLowerCase().includes('mono') || cs.fontFamily.toLowerCase().includes('consol') || cs.fontFamily.toLowerCase().includes('cascadia'),
      weight: cs.fontWeight,
      rect: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
      clipX: el.scrollWidth > el.clientWidth + 1,
      multiLine: rects.length > 1,
      escX: b.right > window.innerWidth + 1 || b.left < -1 });
  }
  return { nodes: out, walkedAll: out.length < 600, pageOverflowX: document.documentElement.scrollWidth > window.innerWidth,
    viewport: { w: window.innerWidth, h: window.innerHeight } };
})()`;

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

// Inspector 说明文字 12→13px 后：滚动体是否仍可滚到底、最后一块是否完整可见、底栏是否遮挡
const INSPI = `(() => {
  const insp = document.querySelector('#insp-body');
  if (!insp) return null;
  insp.scrollTop = insp.scrollHeight; // 滚到底再量
  const ir = insp.getBoundingClientRect();
  let last = insp.lastElementChild, guard = 0;
  while (last && !last.textContent.trim() && guard++ < 5) last = last.previousElementSibling;
  const lr = last ? last.getBoundingClientRect() : null;
  const foot = document.querySelector('#insp-foot');
  const fr = foot && !foot.hidden ? foot.getBoundingClientRect() : null;
  return { scrollH: insp.scrollHeight, clientH: insp.clientHeight,
    scrollable: insp.scrollHeight > insp.clientHeight + 2,
    lastMark: last ? (last.className || last.tagName) : null,
    lastBottom: lr ? Math.round(lr.bottom) : null, bodyBottom: Math.round(ir.bottom),
    lastFullyVisible: lr ? lr.bottom <= ir.bottom + 1.5 : null,
    footTop: fr ? Math.round(fr.top) : null, footOverlapsBody: fr ? fr.top < ir.bottom - 1 : null };
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

// —— 本轮档位判定（Node 侧）——
const BRAND = ['#62C6A0', '#65D9B1', '#6FBF95', '#1E6B40', '#E5B95E', '#E0B341',
  '#78A8F5', '#6C9EF1', '#5B8FF9', '#D96A6A', '#E07B7B', '#AFC0D5', '#91A0B4'];
const HEADING_CLS = new Set(['lf-name', 'agent-name', 'fv-name', 'sc-title', 'req-title', 'eyebrow', 'page-heading', 'reqs-head', 'insp-head', 'picker-heading', 'fd-bar', 'skilldetail']);
function tierOf(n) {
  if (n.fontSize === 13 && n.lineHeight === 20 && n.color === '#D6E0ED') return 'body';   // 普通正文（mono 正文同档）
  if (n.fontSize === 12 && n.lineHeight === 18 && n.color === '#B3C0D2') return n.mono ? 'path' : 'meta'; // 辅助元数据 / 文件路径
  if (n.fontSize === 11 && n.lineHeight === 16) return 'label';
  return null;
}
function classify(nodes) {
  const isControl = (n) => ['button', 'a', 'select', 'option', 'input', 'label'].includes(n.tag);
  const isHeading = (n) => /^h[1-4]$/.test(n.tag) || HEADING_CLS.has(n.cls) || n.fontSize >= 14 || n.weight >= 600;
  const bad = [];
  for (const n of nodes) {
    if (isControl(n) || isHeading(n)) continue;
    const v = [];
    const tier = tierOf(n);
    const isBrand = BRAND.includes(n.color);
    const isPlaceholder = /^[—–-]{1,2}$/.test(n.text);           // 「—」诚实占位：弱化灰豁免档位，仍查对比度
    const isFileContent = n.mark.startsWith('div.fv-panel');      // 文件内容预览非辅助文字（r4 口径）
    if (!tier && !isBrand && !isPlaceholder && !isFileContent) v.push('TIER:' + n.fontSize + '/' + n.lineHeight + '/' + n.color + (n.mono ? '/mono' : ''));
    if (n.contrast < 4.5 && !isBrand && !isFileContent) v.push('A:contrast=' + n.contrast);
    if (n.fontSize < 11) v.push('B:size=' + n.fontSize);
    if (n.fontSize === 11 && tier === 'label' && (n.multiLine || n.len > 16)) v.push('C:label-not-short');
    if (n.alpha < 0.99) v.push('D:alpha=' + n.alpha);
    if (v.length) bad.push({ mark: n.mark, text: n.text, len: n.len, fontSize: n.fontSize, lineHeight: n.lineHeight, color: n.color, bg: n.bg, contrast: n.contrast, mono: n.mono, multiLine: n.multiLine, rules: v });
  }
  return { total: nodes.length, badCount: bad.length, bad };
}
// 聚类清单：全量节点按 (字号/行高/色/等宽) 聚合，供基线盘点与报告抽样表
function clusters(nodes) {
  const m = new Map();
  for (const n of nodes) {
    const k = `${n.fontSize}/${n.lineHeight}/${n.color}${n.mono ? ' mono' : ''}`;
    if (!m.has(k)) m.set(k, { key: k, count: 0, marks: [], tierOK: !!tierOf(n) });
    const c = m.get(k); c.count++;
    if (c.marks.length < 4) c.marks.push(n.mark + '「' + n.text.slice(0, 12) + '」');
  }
  return [...m.values()].sort((a, b) => b.count - a.count);
}

async function main() {
  mkdirSync('D:/tmp', { recursive: true });
  const profile = join('D:/tmp', `g01r12-cdp-${process.pid}`);
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
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true }); // 防止 HTTP 缓存吐旧 CSS

    for (const [W, H] of VIEWPORTS) {
      const vp = `${W}x${H}`;
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
      const V = out.viewports[vp] = {};

      // 图1 工作台（上一视口可能停在 files 等路由且服务端会恢复路由——先显式回需求页，
      // 再若 inspector 空则点第一条需求，保证右侧说明进入采样）
      await cdp.send('Page.navigate', { url: BASE + '/' });
      await sleep(600);
      await cdp.eval(`document.getElementById('rail-reqs')?.click()`); await sleep(400);
      await waitFor(cdp, '.req-item'); await sleep(900);
      const inspEmpty = await cdp.eval(`!document.querySelector('#insp-body') || !document.querySelector('#insp-body').textContent.trim()`);
      if (inspEmpty) { await cdp.eval(`document.querySelector('.req-item')?.click()`); await sleep(700); }
      V.workbench = await cdp.eval(WALK); V.geomWorkbench = await cdp.eval(GEOM);
      V.inspi = await cdp.eval(INSPI);

      // 图2 Agents（列表态 + 展开第一张卡）
      await cdp.eval(`document.getElementById('rail-agents').click()`);
      await waitFor(cdp, '#agent-grid > *'); await sleep(700);
      V.agentsList = await cdp.eval(WALK);
      await cdp.eval(`document.querySelector('.agent-select').click()`); await sleep(500);
      V.agentsDetail = await cdp.eval(WALK);
      await cdp.eval(`document.querySelector('.agent-select').click()`); await sleep(300);
      V.geomAgents = await cdp.eval(GEOM);

      // 图3 技能（含展开第一张卡 → skill-path / skilldetail）
      await cdp.eval(`document.getElementById('rail-skills').click()`);
      await waitFor(cdp, '#skill-list .skill-row'); await sleep(700);
      await cdp.eval(`document.querySelector('#skill-list .skill-row').click()`); await sleep(400);
      V.skills = await cdp.eval(WALK); V.geomSkills = await cdp.eval(GEOM);

      // 图4 文件（含点第一行开预览抽屉 → fv-path / fvd-row / fh-kv）
      await cdp.eval(`document.getElementById('rail-files').click()`);
      await waitFor(cdp, '#file-groups .library-file'); await sleep(700);
      V.filesList = await cdp.eval(WALK);
      await cdp.eval(`document.querySelector('#file-groups .lf-main').click()`); await sleep(900);
      V.filesPreview = await cdp.eval(WALK); V.geomFiles = await cdp.eval(GEOM);

      if (PHASE === 'after') {
        for (const [key, name] of [['workbench','p1-workbench'],['agentsDetail','p2-agents'],['skills','p3-skills'],['filesPreview','p4-files']]) {
          const f = `g01-round12-after-${vp}-${name}.png`; await shot(cdp, f); out.shots.push(f);
        }
      }
    }

    for (const vp of Object.keys(out.viewports)) {
      const V = out.viewports[vp];
      V.audit = {}; V.clusters = {};
      for (const key of ['workbench', 'agentsList', 'agentsDetail', 'skills', 'filesList', 'filesPreview']) {
        if (V[key]) { V.audit[key] = classify(V[key].nodes); V.clusters[key] = clusters(V[key].nodes); }
      }
    }

    if (PHASE === 'after' && existsSync('g01-round12-baseline.json')) {
      const base = JSON.parse(readFileSync('g01-round12-baseline.json', 'utf8'));
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
        const bi = base.viewports[vp]?.inspi, ni = out.viewports[vp].inspi;
        out.geomDiff[vp].inspi = { base: bi, now: ni };
      }
      out.badBaseline = {};
      for (const vp of Object.keys(base.viewports)) {
        out.badBaseline[vp] = {};
        for (const key of Object.keys(base.viewports[vp].audit || {})) out.badBaseline[vp][key] = base.viewports[vp].audit[key].badCount;
      }
    }

    writeFileSync(PHASE === 'after' ? 'g01-round12-after.json' : 'g01-round12-baseline.json', JSON.stringify(out, null, 1));
    const cnt = (vp, key) => out.viewports[vp][key] ? out.viewports[vp][key].nodes.length : 0;
    const badc = (vp, key) => out.viewports[vp].audit?.[key] ? out.viewports[vp].audit[key].badCount : '-';
    console.log('written:', PHASE);
    for (const vp of Object.keys(out.viewports)) {
      console.log(vp, ['workbench','agentsList','agentsDetail','skills','filesList','filesPreview']
        .map((k) => `${k}=${cnt(vp, k)}/${badc(vp, k)}bad`).join(' '));
      const i = out.viewports[vp].inspi;
      if (i) console.log('  insp:', `scrollH=${i.scrollH} clientH=${i.clientH} lastVisible=${i.lastFullyVisible} footOverlap=${i.footOverlapsBody}`);
    }
  } finally {
    chrome.kill();
    await sleep(600);
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 400 }); } catch (e) { console.error('profile cleanup left:', profile, e.message); }
  }
}
main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
