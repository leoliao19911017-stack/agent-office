// S01 第 13 轮验证：技能网格独立滚动容器 + 分页 48px/间隔 16px + 描述 12/18×3 行。
// 用法： node --experimental-websocket verify-s01r13.mjs [phase]   phase=baseline|after（默认 after）
// 量测口径（全部页面内真实 getComputedStyle / getBoundingClientRect / Range.getClientRects）：
//   A #skill-list 容器：overflow-y / min-height / padding-bottom / clientHeight / scrollHeight / 可滚动
//   B #skill-pagination：高度 48 / 与网格底间隔 16
//   C 卡片：min-height 144 / 高度集合 / 双列 / 间距 16×16
//   D 描述：12px / 18px 行高 / line-clamp 3 / 实际渲染行数 / 截断省略
//   E 顶部状态：第 6 张卡几何 + 可见卡与分页无交集
//   F 滚动到底：末卡底 ↔ 列表底(=padding-bottom 16) / 末卡底 ↔ 分页顶(≥16)
//     所有可见卡 .sk-meta 完整落在列表可视框内（标签不被裁切）
// 视口：1440×900 / 1280×768 / 1920×1080
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9348;
const BASE = process.env.BASE || 'http://127.0.0.1:8090';
const PHASE = process.argv[2] || 'after';
const VIEWPORTS = [[1440, 900], [1280, 768], [1920, 1080]];

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
  const list = document.getElementById('skill-list');
  const pag = document.getElementById('skill-pagination');
  const cards = [...document.querySelectorAll('#skill-list .skill-row')];
  const r = (el) => el.getBoundingClientRect();
  const cs = (el) => getComputedStyle(el);
  const lcs = cs(list), pcs = cs(pag);
  out.viewport = { w: window.innerWidth, h: window.innerHeight };
  out.cardCount = cards.length;
  out.countText = (document.getElementById('skill-count').textContent || '').trim();
  // A 容器口径
  out.listBox = {
    overflowY: lcs.overflowY, minHeight: lcs.minHeight, paddingBottom: lcs.paddingBottom,
    clientH: list.clientHeight, scrollH: list.scrollHeight,
    rectTop: +r(list).top.toFixed(1), rectBottom: +r(list).bottom.toFixed(1),
    scrollable: list.scrollHeight > list.clientHeight + 1,
    gap: lcs.gap, cols: lcs.gridTemplateColumns.split(' ').length,
  };
  // B 分页口径
  out.pagination = {
    computedH: pcs.height, minH: pcs.minHeight, marginTop: pcs.marginTop,
    rectTop: +r(pag).top.toFixed(1), rectBottom: +r(pag).bottom.toFixed(1), rectH: +r(pag).height.toFixed(1),
    gapToListBottom: +(r(pag).top - r(list).bottom).toFixed(1),
  };
  // C 卡片几何
  out.cardComputed = { minH: cs(cards[0]).minHeight, h: cs(cards[0]).height };
  out.cardHeights = [...new Set(cards.map((c) => +r(c).height.toFixed(1)))];
  const xs = [...new Set(cards.slice(0, 6).map((c) => Math.round(r(c).left)))];
  out.columns = xs.length;
  // D 描述口径（前 6 卡）
  out.desc = cards.slice(0, 6).map((c) => {
    const s = c.querySelector('small');
    const rg = document.createRange(); rg.selectNodeContents(s);
    const rects = [...rg.getClientRects()].filter((q) => q.width > 1);
    return { fs: cs(s).fontSize, lh: cs(s).lineHeight, ws: cs(s).whiteSpace,
      clamp: cs(s).webkitLineClamp ?? cs(s).getPropertyValue('-webkit-line-clamp'),
      lines: rects.length, boxH: +r(s).height.toFixed(1),
      clamped: s.scrollHeight > s.clientHeight + 1 };
  });
  // E 顶部状态（强制回顶，抵消 app.js 的滚动位置恢复）
  list.scrollTop = 0;
  const c6 = cards[5];
  const lt0 = r(list).top, lb0 = r(list).bottom;
  out.top_state = {
    scrollTop: list.scrollTop,
    card6: { top: +r(c6).top.toFixed(1), bottom: +r(c6).bottom.toFixed(1), h: +r(c6).height.toFixed(1) },
    card6MetaBottom: +r(c6.querySelector('.sk-meta')).bottom.toFixed(1),
    listBottom: +lb0.toFixed(1), pagTop: +r(pag).top.toFixed(1),
    card6BelowFold: +(r(c6).bottom - lb0).toFixed(1),
    card6VisibleBottom: +Math.min(r(c6).bottom, lb0).toFixed(1),
    card6VisibleToPag: +(r(pag).top - Math.min(r(c6).bottom, lb0)).toFixed(1),
  };
  // 「可见部分」口径：卡片被滚动容器裁切后真正显示的区段 [max(top,lt), min(bottom,lb)]
  const visiblePartOverlapsPag = (lt, lb) => cards.some((c) => {
    const a = r(c), b = r(pag);
    const vTop = Math.max(a.top, lt), vBottom = Math.min(a.bottom, lb);
    return vBottom - vTop > 0.5 && vBottom > b.top + 0.5 && vTop < b.bottom;
  });
  out.visibleCardsAtTop = cards.filter((c) => { const a = r(c); return Math.min(a.bottom, lb0) - Math.max(a.top, lt0) > 0.5; }).length;
  out.visibleOverlapAtTop = visiblePartOverlapsPag(lt0, lb0);
  // F 滚动到底
  list.scrollTop = list.scrollHeight - list.clientHeight;
  const lc = cards[cards.length - 1];
  const lt = r(list).top, lb = r(list).bottom;
  out.card6AtBottom = { bottom: +r(c6).bottom.toFixed(1), toPag: +(r(pag).top - r(c6).bottom).toFixed(1) };
  out.bottom_state = {
    scrollTop: +list.scrollTop.toFixed(1), maxScroll: +(list.scrollHeight - list.clientHeight).toFixed(1),
    lastCardIdx: cards.length, lastCardBottom: +r(lc).bottom.toFixed(1),
    listBottom: +lb.toFixed(1), pagTop: +r(pag).top.toFixed(1),
    lastCardToListBottom: +(lb - r(lc).bottom).toFixed(1),
    lastCardToPag: +(r(pag).top - r(lc).bottom).toFixed(1),
  };
  out.visibleCardsAtBottom = cards.filter((c) => r(c).bottom > lt + 0.5 && r(c).top < lb - 0.5).length;
  out.metaCheckAtBottom = cards.filter((c) => r(c).bottom > lt + 0.5 && r(c).top < lb - 0.5).map((c) => {
    const m = r(c.querySelector('.sk-meta'));
    return { name: c.querySelector('b').textContent.slice(0, 16), metaTop: +m.top.toFixed(1), metaBottom: +m.bottom.toFixed(1),
      inside: m.top >= lt - 0.5 && m.bottom <= lb + 0.5 };
  });
  out.allMetaInside = out.metaCheckAtBottom.every((x) => x.inside);
  out.visibleOverlapAtBottom = visiblePartOverlapsPag(lt, lb);
  out.hScroll = document.documentElement.scrollWidth > window.innerWidth + 1;
  return out;
})()`;

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, '--headless=new', '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--window-size=1440,900', 'about:blank',
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
    const m = await cdp.eval(MEASURE);   // 注意：eval 内部已把网格滚到底
    report.viewports[`${w}x${h}`] = m;
    if (PHASE === 'after') {
      const shot1 = await cdp.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(`verify-s01r13-${w}x${h}-bottom.png`, Buffer.from(shot1.data, 'base64'));
      await cdp.eval(`document.getElementById('skill-list').scrollTop = 0`);
      const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(`verify-s01r13-${w}x${h}-top.png`, Buffer.from(shot2.data, 'base64'));
    }
  }
  writeFileSync(`verify-s01r13-${PHASE}.json`, JSON.stringify(report, null, 2));
  for (const [vp, m] of Object.entries(report.viewports)) {
    console.log(`\n===== ${vp} (${PHASE}) =====`);
    console.log(`卡片数=${m.cardCount} "${m.countText}" 列数=${m.columns} 高度集合=[${m.cardHeights}] minH计算值=${m.cardComputed.minH}`);
    console.log(`列表: overflow-y=${m.listBox.overflowY} min-height=${m.listBox.minHeight} padding-bottom=${m.listBox.paddingBottom} gap=${m.listBox.gap}`);
    console.log(`列表: clientH=${m.listBox.clientH} scrollH=${m.listBox.scrollH} 可滚动=${m.listBox.scrollable} rect=[${m.listBox.rectTop}→${m.listBox.rectBottom}]`);
    console.log(`分页: 高度=${m.pagination.rectH}(计算${m.pagination.computedH}/min${m.pagination.minH}) margin-top=${m.pagination.marginTop} 与列表底间隔=${m.pagination.gapToListBottom}px`);
    const d0 = m.desc[0];
    console.log(`描述(卡1): fs=${d0.fs} lh=${d0.lh} clamp=${d0.clamp} ws=${d0.ws} 行数=${d0.lines} 盒高=${d0.boxH} 截断=${d0.clamped}`);
    console.log(`顶部: scrollTop=${m.top_state.scrollTop} 可见卡=${m.visibleCardsAtTop} 第6卡=[${m.top_state.card6.top}→${m.top_state.card6.bottom}] 超出列表底=${m.top_state.card6BelowFold}px 第6卡可见底↔分页顶=${m.top_state.card6VisibleToPag}px 可见部重叠分页=${m.visibleOverlapAtTop}`);
    console.log(`底部: scrollTop=${m.bottom_state.scrollTop}/${m.bottom_state.maxScroll} 末卡底=${m.bottom_state.lastCardBottom} 第6卡底↔分页顶=${m.card6AtBottom.toPag}px`);
    console.log(`底部: 末卡底↔列表底=${m.bottom_state.lastCardToListBottom}px 末卡底↔分页顶=${m.bottom_state.lastCardToPag}px 可见卡=${m.visibleCardsAtBottom}`);
    console.log(`底部: 标签全部在框内=${m.allMetaInside} 可见部重叠分页=${m.visibleOverlapAtBottom} 横向滚动=${m.hScroll}`);
    console.log(`底部: 标签明细=${JSON.stringify(m.metaCheckAtBottom)}`);
  }
} finally {
  chrome.kill();
}
