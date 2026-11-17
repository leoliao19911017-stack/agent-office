// S01 第11轮探针：技能卡片底部横线结构实测。
// 口径（S01 任务书）：
//   1) 末行卡片下方不得存在独立边框/伪元素横线；分页上方仅一条通栏分隔线 100%×1px×#334257
//   2) 末行卡片底边 → 分隔线 24px；分隔线下沿 → 分页控件顶 12px
//   3) getBoundingClientRect 末行左右卡片底边 y 差 ≤ 1px
//   4) 卡片背景 #182230、圆角 10px、既有布局不变
// 证据链：DOM getComputedStyle/getBoundingClientRect + 截图区域像素级横线扫描（zlib 解 PNG，无三方依赖）。
// 用法（repo 根目录）：
//   PHASE=baseline node --experimental-websocket s01-round11-probe.mjs
//   PHASE=after    node --experimental-websocket s01-round11-probe.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inflateSync } from 'node:zlib';

const NODE = process.execPath;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9347;
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

// —— 极简 PNG 解码（CDP 截图：8bit、非隔行、彩色类型 2/6）——
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png');
  let pos = 8, w = 0, h = 0, bpp = 0, idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bpp = data[8] === 6 ? 4 : 3; }
    else if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
    if (type === 'IEND') break;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp, out = Buffer.alloc(h * stride);
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0, b = prev ? prev[x] : 0, c = x >= bpp && prev ? prev[x - bpp] : 0;
      out[y * stride + x] = f === 1 ? row[x] + a : f === 2 ? row[x] + b : f === 3 ? row[x] + ((a + b) >> 1) : f === 4 ? row[x] + paeth(a, b, c) : row[x];
    }
  }
  return { w, h, bpp, data: out };
}

// —— 区域像素横线扫描：找 #334257(51,66,87) 系横线行 ——
// L1 距离阈值：core<40（纯色线芯）、soft<80（抗锯齿半覆盖）；卡片底 #182230 距离 98、面板 #121925 距离 145，均被排除。
function scanLines(png) {
  const rows = [];
  for (let y = 0; y < png.h; y++) {
    let core = 0, soft = 0, x0 = -1, x1 = -1, run = 0, bestRun = 0, bestRunX0 = 0;
    for (let x = 0; x < png.w; x++) {
      const i = y * png.stride0 + x * png.bpp; // stride0 占位，见下
      const d = Math.abs(png.data[i] - 51) + Math.abs(png.data[i + 1] - 66) + Math.abs(png.data[i + 2] - 87);
      if (d < 80) { soft++; if (x0 < 0) x0 = x; x1 = x; run++; if (run > bestRun) { bestRun = run; bestRunX0 = x - run + 1; } } else run = 0;
      if (d < 40) core++;
    }
    if (soft >= 40 && bestRun >= 30) rows.push({ y, x0, x1, soft, core, bestRun, bestRunX0 });
  }
  return rows;
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

// —— DOM 实测：末行卡片几何/边框/伪元素 + 分隔线与间距 ——
const MEASURE = `(() => {
  const list = document.getElementById('skill-list');
  const pag = document.getElementById('skill-pagination');
  list.scrollTop = list.scrollHeight;                       // 滚到底，末行可见
  const cards = [...list.querySelectorAll('.skill-row')];
  const cs = getComputedStyle(cards[0]);
  const card0 = {
    border: [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor],
    borderWidth: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth],
    background: cs.backgroundColor, radius: cs.borderRadius,
  };
  const maxBottom = Math.max(...cards.map((c) => c.getBoundingClientRect().bottom));
  const lastRow = cards.filter((c) => Math.abs(c.getBoundingClientRect().bottom - maxBottom) <= 1);
  const pagR = pag.getBoundingClientRect();
  const pcs = getComputedStyle(pag);
  const btns = [...pag.querySelectorAll('button')];
  const btnTop = Math.min(...btns.map((b) => b.getBoundingClientRect().top));
  // 末行卡片伪元素是否有可见线（content/border/background）
  const pseudo = lastRow.map((c) => {
    const b = getComputedStyle(c, '::before'), a = getComputedStyle(c, '::after');
    return { before: { content: b.content, border: b.borderBottomWidth + ' ' + b.borderBottomColor, bg: b.backgroundColor },
             after:  { content: a.content, border: a.borderBottomWidth + ' ' + a.borderBottomColor, bg: a.backgroundColor } };
  });
  // 卡片与分页之间（skill-list-column 直系子元素之外）是否还有别的元素
  const col = document.querySelector('.skill-list-column');
  const between = [...col.children].map((el) => el.id || el.className);
  return {
    cardCount: cards.length,
    card0,
    lastRowCount: lastRow.length,
    lastRow: lastRow.map((c) => { const r = c.getBoundingClientRect();
      return { text: c.querySelector('b')?.textContent.slice(0, 24), left: +r.left.toFixed(1), bottom: +r.bottom.toFixed(1), width: +r.width.toFixed(1) }; }),
    leftRightBottomDiff: lastRow.length === 2 ? +(lastRow[1].getBoundingClientRect().bottom - lastRow[0].getBoundingClientRect().bottom).toFixed(2) : null,
    pagRect: { top: +pagR.top.toFixed(1), left: +pagR.left.toFixed(1), width: +pagR.width.toFixed(1), height: +pagR.height.toFixed(1) },
    pagBorderTop: pcs.borderTopWidth + ' ' + pcs.borderTopStyle + ' ' + pcs.borderTopColor,
    pagMarginTop: pcs.marginTop, listPaddingBottom: getComputedStyle(list).paddingBottom,
    cardBottomToLineTop: +(pagR.top - maxBottom).toFixed(1),
    lineBottomToControlTop: +(btnTop - pagR.top - parseFloat(pcs.borderTopWidth)).toFixed(1),
    btnHeights: btns.map((b) => Math.round(b.getBoundingClientRect().height)),
    pagSpan: pag.querySelector('span')?.textContent.trim(),
    btnDisabled: btns.map((b) => b.disabled),
    pseudoOnLastRow: pseudo,
    columnChildren: between,
  };
})()`;

async function shootRegion(cdp, clip, path) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 } });
  const buf = Buffer.from(r.data, 'base64');
  writeFileSync(path, buf);
  const png = decodePng(buf);
  png.stride0 = png.w * png.bpp;
  const rows = scanLines(png);
  // 相邻 y 合并成线段组
  const groups = [];
  for (const row of rows) {
    const g = groups[groups.length - 1];
    if (g && row.y - g.y1 <= 1) { g.y1 = row.y; g.x0 = Math.min(g.x0, row.x0); g.x1 = Math.max(g.x1, row.x1); g.core += row.core; g.soft += row.soft; g.rows++; }
    else groups.push({ y0: row.y, y1: row.y, x0: row.x0, x1: row.x1, core: row.core, soft: row.soft, rows: 1 });
  }
  return { clip, pngW: png.w, pngH: png.h, lineGroups: groups };
}

async function measureScenario(cdp, vp, name, out, shots) {
  const m = await cdp.eval(MEASURE);
  // 截图区域：末行卡片底往上 6px → 分页按钮区中部（覆盖 线上方卡片底边/线/控件顶）
  const clip = {
    x: m.pagRect.left, y: Math.max(0, Math.max(...m.lastRow.map((c) => c.bottom)) - 6),
    width: m.pagRect.width, height: (m.pagRect.top + 44) - (Math.max(...m.lastRow.map((c) => c.bottom)) - 6),
  };
  const f = `s01-round11-${PHASE}-${vp}-${name}.png`;
  const scan = await shootRegion(cdp, clip, f);
  shots.push(f);
  out[vp] = out[vp] || {}; out[vp][name] = { dom: m, pixelScan: scan };
  return m;
}

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 's01r11-cdp-'));
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
      await cdp.eval(`document.getElementById('rail-skills').click()`);
      await waitFor(cdp, '#skill-list .skill-row');
      await sleep(800);

      // 场景0：默认列表（全部技能）
      const def = await measureScenario(cdp, vp, 'default', out.viewports, out.shots);

      // 场景1：分页切换（任务书要求）。仅当存在多页时执行，如实记录按钮态。
      if (def.btnDisabled.every((d) => d)) {
        out.viewports[vp].paginationNote = `仅 1 页（${def.cardCount} 张 / 20 每页），上一页/下一页均 disabled，无法真实换页；改用筛选与搜索重渲染复测`;
      } else {
        await cdp.eval(`[...document.querySelectorAll('#skill-pagination button')].find(b=>b.dataset.page==='1').click()`);
        await sleep(500);
        await measureScenario(cdp, vp, 'page2', out.viewports, out.shots);
        await cdp.eval(`[...document.querySelectorAll('#skill-pagination button')].find(b=>b.dataset.page==='-1').click()`);
        await sleep(400);
      }

      // 场景2：用途筛选里挑奇数张卡片的类别（末行单卡边界情形）
      const chips = await cdp.eval(`[...document.querySelectorAll('#skill-cat-filters button')].map(b=>b.textContent.trim())`);
      let oddChip = null;
      for (const label of chips) {
        if (/全部|All/.test(label)) continue;
        await cdp.eval(`[...document.querySelectorAll('#skill-cat-filters button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}).click()`);
        await sleep(350);
        const n = await cdp.eval(`document.querySelectorAll('#skill-list .skill-row').length`);
        if (n % 2 === 1 && n > 0) { oddChip = { label, count: n }; break; }
      }
      if (oddChip) {
        await cdp.eval(`document.getElementById('skill-list').scrollTop = 1e6`);
        await sleep(200);
        await measureScenario(cdp, vp, 'oddFilter', out.viewports, out.shots);
        out.viewports[vp].oddFilterChip = oddChip;
      } else {
        out.viewports[vp].oddFilterNote = '没有奇数张的用途分类，跳过 oddFilter';
      }
      // 恢复全部，避免影响后续视口
      await cdp.eval(`[...document.querySelectorAll('#skill-cat-filters button')].find(b=>/全部/.test(b.textContent))?.click()`);
      await sleep(300);
    }

    writeFileSync(`s01-round11-${PHASE}.json`, JSON.stringify(out, null, 1));
    for (const vp of Object.keys(out.viewports)) {
      for (const [name, s] of Object.entries(out.viewports[vp])) {
        if (s && s.dom) {
          console.log(`${vp} ${name}: cards=${s.dom.cardCount} lastRow=${s.dom.lastRowCount} yDiff=${s.dom.leftRightBottomDiff} ` +
            `cardBottom→line=${s.dom.cardBottomToLineTop} line→ctrl=${s.dom.lineBottomToControlTop} ` +
            `lineGroups=${s.pixelScan.lineGroups.length} pagBorder=[${s.dom.pagBorderTop}] cardBorderBottom=${s.dom.card0.border[2]}`);
        }
      }
    }
    console.log('written: s01-round11-' + PHASE + '.json');
  } finally {
    chrome.kill();
  }
}
main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
