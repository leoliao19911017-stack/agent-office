// G01 验证（第 3 轮）：四页高频元信息的 getComputedStyle 字号/行高/颜色 + WCAG 对比度 + 溢出 + 卡片几何（baseline vs after）
// 用法： PHASE=baseline node --experimental-websocket verify-g01.mjs   （改前基线）
//       PHASE=after    node --experimental-websocket verify-g01.mjs   （改后，读 baseline 做 diff）
// 第 3 轮新增：①覆盖弱化档节点（ag-task.hist / work-unknown / agent-kv / fvd-row / sc-label）
//             ②溢出口径修正：clipX=自身省略号截断（合规），escX=内容逃逸出元素盒（不合规），另测页面级横向滚动
//             ③换行/溢出压力测试：中文长文本、英文长路径、混合字符注入后量几何
//             ④记录原始 color 字符串，证明没有靠透明度弱化文本
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9337;            // 独立端口，避免撞上其他验证实例
// BASE 可用环境变量覆盖（R73 G02 收口：截图/量测跑在临时端口的新代码实例上，
// 不依赖 8090 常驻进程是否已重启到最新 build）。
const BASE = process.env.BASE || 'http://127.0.0.1:8090';
const PHASE = process.env.PHASE || 'after';
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

// 页内工具：解析颜色 → 相对亮度 → WCAG 对比度；沿祖先链找实际背景
const UTIL = `
const parseColor = (s) => { const m = s.match(/rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)(?:,\\s*([\\d.]+))?\\)/); return m ? { r:+m[1], g:+m[2], b:+m[3], a:m[4]===undefined?1:+m[4] } : null; };
const blend = (fg, bg) => ({ r: fg.r*fg.a + bg.r*(1-fg.a), g: fg.g*fg.a + bg.g*(1-fg.a), b: fg.b*fg.a + bg.b*(1-fg.a) });
const lum = (c) => { const f = (v) => { v/=255; return v<=0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); }; return 0.2126*f(c.r)+0.7152*f(c.g)+0.0722*f(c.b); };
const contrast = (fg, bg) => { const a = blend(fg, bg); const l1 = lum(a), l2 = lum(bg); return (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05); };
const solidBg = (el) => { let n = el; while (n && n !== document.documentElement) { const c = parseColor(getComputedStyle(n).backgroundColor); if (c && c.a >= 0.99) return c; n = n.parentElement; } return parseColor(getComputedStyle(document.body).backgroundColor) || {r:13,g:17,b:26,a:1}; };
const hex = (c) => '#' + [c.r,c.g,c.b].map((v)=>Math.round(v).toString(16).padStart(2,'0')).join('').toUpperCase();
`;

// 通用节点采集：selector → { fontSize, lineHeight, color(hex), bg(hex), contrast, rect, clipX/escX, rawColor }
// clipX：自身 scrollWidth>clientWidth（nowrap+ellipsis 的设计内截断，合规）
// escX：内容矩形逃逸出元素可视盒再逃逸到视口外（真溢出，不合规）
const NODE = `
  const el = document.querySelector(sel); if (!el) return null;
  const cs = getComputedStyle(el);
  const fg = parseColor(cs.color), bg = solidBg(el);
  const b = el.getBoundingClientRect();
  const clipX = el.scrollWidth > el.clientWidth + 1;
  const escX = b.right > window.innerWidth + 1 || b.left < -1;   // 逃逸视口 = 真横向溢出
  return { sel, text: (el.textContent||'').trim().slice(0,36),
    fontSize: cs.fontSize, lineHeight: cs.lineHeight, color: hex(fg), rawColor: cs.color, bg: hex(bg),
    contrast: +contrast(fg,bg).toFixed(2), mono: cs.fontFamily.includes('mono'),
    rect: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
    clipX, escX };
`;
function probesExpr(sels) { return `(() => { ${UTIL}
  const one = (sel) => { ${NODE} };
  return ${JSON.stringify(sels)}.map(one);
})()`; }

// 压力测试：向目标节点注入超长中文/英文路径/混合串，量「逃逸视口」与页面横向滚动
function stressExpr(cases) {
  return `(() => { ${UTIL}
    const res = [];
    for (const c of ${JSON.stringify(cases)}) {
      const el = document.querySelector(c.sel);
      if (!el) { res.push({ ...c, found: false }); continue; }
      el.textContent = c.text;
      const b = el.getBoundingClientRect();
      res.push({ sel: c.sel, kind: c.kind, found: true,
        rect: { w: Math.round(b.width), h: Math.round(b.height) },
        clipX: el.scrollWidth > el.clientWidth + 1,
        escX: b.right > window.innerWidth + 1 || b.left < -1 });
    }
    return { cases: res, pageOverflowX: document.documentElement.scrollWidth > window.innerWidth };
  })()`;
}

// 几何基线：卡片/行高度集合 + 列布局（含文件列宽，防字号统一引起列宽回归）
const GEOM = `(() => {
  const hs = (sel) => [...document.querySelectorAll(sel)].slice(0, 12).map((el) => Math.round(el.getBoundingClientRect().height));
  const ws = (sel) => [...document.querySelectorAll(sel)].slice(0, 12).map((el) => Math.round(el.getBoundingClientRect().width));
  return {
    reqItems: hs('.req-item'),
    agentCards: hs('#agent-grid > *'),
    skillRows: hs('#skill-list .skill-row'),
    fileRows: hs('#file-groups .library-file'),
    fileMainW: ws('#file-groups .lf-main'),
    pageOverflowX: document.documentElement.scrollWidth > window.innerWidth,
    viewport: { w: window.innerWidth, h: window.innerHeight },
  };
})()`;

const LONG_CN = '这是一段用于压力测试的超长中文辅助文本，用来验证字号行高统一之后长文本是否正常换行或截断，不会把卡片撑破也不会横向溢出页面边界，混合了标点、数字与英文Word片段。';
const LONG_PATH = 'C:/Users/Administrator/Desktop/Soda Intelligence - AI Native Thinking/Soda Office/web/verify-assets/task-f01r3/.profile-probe/Default/Extensions/deep/nested/very/long/path/target-file-name-here.md';
const LONG_MIX = '混合路径 D:/项目/交付物/第3轮/G01-统一可读性/very~long(1)文件-name_final.v2.md 与中文说明文字混排测试';

// 等待选择器出现且数量 > 0
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
  const profile = mkdtempSync(join(tmpdir(), 'g01-cdp-'));
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--window-size=1440,900', 'about:blank',
  ], { stdio: 'ignore' });
  const out = { phase: PHASE, base: BASE, when: new Date().toISOString(), viewport: '1440x900', pages: {}, stress: {}, geom: {} };
  const shots = [];
  try {
    let targets = null;
    for (let i = 0; i < 50; i++) {
      try { const res = await fetch(`http://127.0.0.1:${PORT}/json/list`); targets = await res.json(); break; }
      catch { await sleep(200); }
    }
    if (!targets) throw new Error('chrome devtools port never came up');
    const cdp = await CDP.connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    // ---------- 图1 · 工作台（需求列表） ----------
    await cdp.send('Page.navigate', { url: BASE + '/' });
    await waitFor(cdp, '.req-item');
    await sleep(600);
    out.pages.workbench = await cdp.eval(probesExpr([
      '.req-item .req-status', '.req-item .req-status.t-active', '.req-item .req-status.t-delivered',
      '.req-item .req-status.t-queued', '.req-item .req-stage', '.req-item .req-line2',
    ]));
    out.geom.workbench = await cdp.eval(GEOM);
    if (PHASE === 'after') { await shot(cdp, 'verify-g01-p1-workbench.png'); shots.push('verify-g01-p1-workbench.png'); }
    out.stress.workbench = await cdp.eval(stressExpr([
      { sel: '.req-item .req-stage', kind: 'long-cn', text: LONG_CN },
      { sel: '.req-item .req-line2', kind: 'long-path', text: LONG_PATH },
    ]));

    // ---------- 图2 · Agents ----------
    await cdp.eval(`document.getElementById('rail-agents').click()`);
    await waitFor(cdp, '#agent-grid .agent-card, #agent-grid > *');
    await sleep(600);
    out.pages.agents = await cdp.eval(probesExpr([
      '.roster-head', '.agent-card .ag-ids', '.ag-idcol .agent-role', '.sc-label',
      '.ag-conn.ok', '.ag-conn.off', '.ag-work.work-working', '.ag-work.work-idle', '.ag-work.work-unknown',
      '.ag-hb.ok', '.ag-hb.stale', '.ag-hb.off', '.ag-task', '.ag-task.hist', '#agent-scope', '.agent-kv', '.agent-run p',
    ]));
    // 点第一张卡展开 detail → 量 .agent-kv / .agent-run p（高频阅读的展开区元信息）
    await cdp.eval(`document.querySelector('.agent-select').click()`);
    await sleep(500);
    out.pages.agentsDetail = await cdp.eval(probesExpr([
      '.agent-detail .agent-kv', '.agent-detail .agent-kv span:first-child', '.agent-detail .agent-kv span:last-child',
      '.agent-detail .agent-run p',
    ]));
    out.stress.agents = await cdp.eval(stressExpr([
      { sel: '.agent-detail .agent-kv span:last-child', kind: 'long-cn', text: LONG_CN },
      { sel: '.ag-task', kind: 'long-cn', text: LONG_CN },
    ]));
    await cdp.eval(`document.querySelector('.agent-select').click()`); // 收起，保持截图为列表态
    await sleep(300);
    out.geom.agents = await cdp.eval(GEOM);
    if (PHASE === 'after') { await shot(cdp, 'verify-g01-p2-agents.png'); shots.push('verify-g01-p2-agents.png'); }

    // ---------- 图3 · 技能（点第一行展开详情 → skill-path） ----------
    await cdp.eval(`document.getElementById('rail-skills').click()`);
    await waitFor(cdp, '#skill-list .skill-row');
    await sleep(600);
    await cdp.eval(`document.querySelector('#skill-list .skill-row').click()`);
    await sleep(400);
    out.pages.skills = await cdp.eval(probesExpr([
      '#skill-count', '.sfr-label', '.skill-row small', '.skill-row .sk-tag', '.skill-row .sk-cat', '.skill-path',
    ]));
    out.geom.skills = await cdp.eval(GEOM);
    if (PHASE === 'after') { await shot(cdp, 'verify-g01-p3-skills.png'); shots.push('verify-g01-p3-skills.png'); }
    out.stress.skills = await cdp.eval(stressExpr([
      { sel: '.skill-row small', kind: 'long-cn', text: LONG_CN },
      { sel: '.skill-path', kind: 'long-path', text: LONG_PATH },
      { sel: '.skill-path', kind: 'long-mix', text: LONG_MIX },
    ]));

    // ---------- 图4 · 文件（点第一行打开预览 → fv-path / fvd-row） ----------
    await cdp.eval(`document.getElementById('rail-files').click()`);
    await waitFor(cdp, '#file-groups .library-file');
    await sleep(600);
    await cdp.eval(`document.querySelector('#file-groups .lf-main').click()`);
    await sleep(800);
    out.pages.files = await cdp.eval(probesExpr([
      '#file-count', '.file-only', '.library-file .lf-name', '.library-file .lf-src', '.library-file .lf-size',
      '.library-file .lf-type', '.lf-tag.unver', '.fv-path', '.fvd-row span', '.fvd-row b', '.fvd-row b.warn',
      '.lf-lines .lf-size', '.library-file .lf-size.ok', '.library-file .lf-exec', '.library-file .lf-exec.na',
    ]));
    // req-line2 是纯 flex 容器：记录它有没有直接文本节点（0 = 容器样式不渲染任何字，档位检查只看子节点）
    out.workbenchExtra = await cdp.eval(`(() => {
      const el = document.querySelector('.req-line2');
      return el ? { directTextNodes: [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).length } : null;
    })()`);
    out.geom.files = await cdp.eval(GEOM);
    if (PHASE === 'after') { await shot(cdp, 'verify-g01-p4-files.png'); shots.push('verify-g01-p4-files.png'); }
    out.stress.files = await cdp.eval(stressExpr([
      { sel: '.library-file .lf-src', kind: 'long-path', text: LONG_PATH },
      { sel: '.fv-path', kind: 'long-path', text: LONG_PATH },
      { sel: '.fv-path', kind: 'long-mix', text: LONG_MIX },
      { sel: '.fvd-row b', kind: 'long-mix', text: LONG_MIX },
    ]));

    // ---------- after 轮：与 baseline 做几何 diff ----------
    if (PHASE === 'after' && existsSync('verify-g01-baseline.json')) {
      const base = JSON.parse(readFileSync('verify-g01-baseline.json', 'utf8'));
      const diff = {};
      for (const page of Object.keys(out.geom)) {
        const a = base.geom[page] || {}, b = out.geom[page];
        const pair = (k) => a[k] && b[k] ? { base: a[k], now: b[k], same: JSON.stringify(a[k]) === JSON.stringify(b[k]) } : null;
        diff[page] = {
          reqItems: pair('reqItems'), agentCards: pair('agentCards'), skillRows: pair('skillRows'),
          fileRows: pair('fileRows'), fileMainW: pair('fileMainW'), pageOverflowX: b.pageOverflowX,
        };
      }
      out.geomDiff = diff;
    }
    out.shots = shots;
    writeFileSync(PHASE === 'after' ? 'verify-g01.json' : 'verify-g01-baseline.json', JSON.stringify(out, null, 2));
    console.log('written:', PHASE, 'pages:', Object.keys(out.pages).join(','));
  } finally {
    chrome.kill();
  }
}
main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
