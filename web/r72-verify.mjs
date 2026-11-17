// 第 72 轮整改验证：四页布局数值实测（G01/A01/S01/F01/W01 的几何与计算样式）。
// 用法： node --experimental-websocket r72-verify.mjs
// 输出： JSON 结果到 stdout；四页截图 r72-{page}-1440x900.png
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9372;
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

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, '--headless=new', '--no-first-run', '--no-default-browser-check',
  '--user-data-dir=' + process.env.TEMP + '/r72-chrome-' + Date.now(),
  '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore' });
await sleep(1500);

try {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const cdp = await CDP.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  const results = {};

  // ---- 四页导航截图 + G01 全局布局 ----
  const pages = [
    { id: 'p1-workbench', nav: null },             // 默认页
    { id: 'p2-agents', nav: '#rail-agents' },
    { id: 'p3-skills', nav: '#rail-skills' },
    { id: 'p4-files', nav: '#rail-files' },
  ];
  for (const p of pages) {
    await cdp.send('Page.navigate', { url: BASE + '/' });
    await sleep(2500);
    if (p.nav) { await cdp.eval(`document.querySelector(${JSON.stringify(p.nav)}).click()`); await sleep(1200); }
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`r72-${p.id}-1440x900.png`, Buffer.from(shot.data, 'base64'));
    console.error(`截图完成: r72-${p.id}-1440x900.png`);
  }

  // ---- G01：全局布局实测（回到工作台） ----
  await cdp.send('Page.navigate', { url: BASE + '/' });
  await sleep(2500);
  results.G01 = await cdp.eval(`(() => {
    const gs = (sel, prop) => { const el = document.querySelector(sel); return el ? getComputedStyle(el)[prop] : null; };
    const rect = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) }; };
    const fs = (sel) => gs(sel, 'fontSize') + '/' + gs(sel, 'lineHeight');
    return {
      bodyBg: gs('body', 'backgroundColor'),
      cssLinks: [...document.styleSheets].map((s) => (s.href || 'inline') + ':' + (() => { try { s.cssRules.length; return 'ok'; } catch { return 'ERR'; } })()),
      topbar: rect('#topbar'), statusbar: rect('#statusbar'), rail: rect('#rail'),
      reqs: rect('#reqs'), inspector: rect('#inspector'),
      bodyFont: fs('body'),
      cardSample: (() => { const el = document.querySelector('.step-card'); return el ? getComputedStyle(el).backgroundColor : null; })(),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  })()`);

  // ---- A01：Agents 头像与列表 ----
  await cdp.eval(`document.querySelector('#rail-agents').click()`);
  await sleep(1500);
  results.A01 = await cdp.eval(`(() => {
    const avatars = [...document.querySelectorAll('#agent-grid img')].map((img) => { const r = img.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
    const rows = [...document.querySelectorAll('#agent-grid .agent-card, #agent-grid > *')].slice(0, 6).map((el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
    return {
      avatarCount: avatars.length,
      avatarSizes: avatars,
      allAvatar44: avatars.every((a) => Math.abs(a.w - 44) <= 1 && Math.abs(a.h - 44) <= 1),
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      gridCols: (() => { const g = document.querySelector('#agent-grid'); return g ? getComputedStyle(g).gridTemplateColumns : null; })(),
      rowCount: document.querySelectorAll('#agent-grid > *').length,
      rowHeights: rows,
    };
  })()`);

  // ---- S01：技能卡片网格 ----
  await cdp.eval(`document.querySelector('#rail-skills').click()`);
  await sleep(1500);
  results.S01 = await cdp.eval(`(() => {
    const cards = [...document.querySelectorAll('#skill-list > *')].filter((el) => el.offsetParent !== null);
    const rects = cards.map((el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; });
    const firstTwo = rects.slice(0, 2);
    const sameRow = firstTwo.length === 2 ? Math.abs(firstTwo[0].y - firstTwo[1].y) <= 2 : false;
    const gapX = firstTwo.length === 2 ? Math.round(firstTwo[1].x - (firstTwo[0].x + firstTwo[0].w)) : null;
    const rows = [...new Set(rects.map((r) => r.y))];
    const listRect = (() => { const el = document.querySelector('#skill-list'); return el ? el.getBoundingClientRect() : null; })();
    const pagRect = (() => { const el = document.querySelector('#skill-pagination'); return el ? el.getBoundingClientRect() : null; })();
    return {
      visibleCardCount: cards.length,
      columnCount: sameRow ? 2 : 1,
      gapX,
      rowYs: rows,
      cardMinH: rects.length ? Math.min(...rects.map((r) => r.h)) : null,
      cardMaxW: rects.length ? Math.max(...rects.map((r) => r.w)) : null,
      paginationOverlap: listRect && pagRect ? (listRect.bottom > pagRect.top + 2) : null,
      cardBg: cards[0] ? getComputedStyle(cards[0]).backgroundColor : null,
    };
  })()`);

  // ---- F01：文件列表三列 ----
  await cdp.eval(`document.querySelector('#rail-files').click()`);
  await sleep(1500);
  results.F01 = await cdp.eval(`(() => {
    const groups = [...document.querySelectorAll('#file-groups > *')];
    const fileRows = [...document.querySelectorAll('.library-file')];
    const sample = fileRows[0];
    let cols = null, rowH = null;
    if (sample) { const g = getComputedStyle(sample); cols = g.gridTemplateColumns; rowH = Math.round(sample.getBoundingClientRect().height); }
    // 版本列与操作列宽度（取 CSS Grid 实际分配）
    let verColW = null, opsColW = null;
    if (fileRows[0]) {
      const vr = fileRows[0].querySelector('.lf-lines'); const or = fileRows[0].querySelector('.lf-ops');
      if (vr) verColW = Math.round(vr.getBoundingClientRect().width);
      if (or) opsColW = Math.round(or.getBoundingClientRect().width);
    }
    return {
      groupCount: groups.length,
      groupTitles: groups.map((g) => (g.querySelector('.lg-head, h3, .file-group-head')?.textContent || '').trim().slice(0, 20)).filter(Boolean),
      fileRowCount: fileRows.length,
      gridColumns: cols,
      firstRowH: rowH,
      verColW, opsColW,
      groupBg: groups[0] ? getComputedStyle(groups[0]).backgroundColor : null,
    };
  })()`);

  // ---- W01：审批详情面板（工作台 + 选择一个步骤） ----
  await cdp.eval(`document.querySelector('#rail-reqs').click()`);
  await sleep(1500);
  results.W01 = await cdp.eval(`(() => {
    const insp = document.querySelector('#inspector');
    const foot = document.querySelector('#insp-foot');
    const body = document.querySelector('#insp-body');
    return {
      inspector: insp ? { w: Math.round(insp.getBoundingClientRect().width), h: Math.round(insp.getBoundingClientRect().height) } : null,
      footH: foot && !foot.hidden ? Math.round(foot.getBoundingClientRect().height) : (foot ? 'hidden' : null),
      bodyScrollable: body ? getComputedStyle(body).overflowY : null,
      footVisible: foot ? !foot.hidden : null,
    };
  })()`);

  // ---- 1280x768 复测关键项 ----
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 768, deviceScaleFactor: 1, mobile: false });
  await sleep(600);
  results.vp1280 = await cdp.eval(`(() => {
    const rect = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
    const avs = [...document.querySelectorAll('#agent-grid img')].map((i) => { const r = i.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); });
    return { rail: rect('#rail'), reqs: rect('#reqs'), inspector: rect('#inspector'), overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth };
  })()`);

  console.log(JSON.stringify(results, null, 2));
} finally {
  chrome.kill();
}
