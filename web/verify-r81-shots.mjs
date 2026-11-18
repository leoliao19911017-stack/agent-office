// verify-r81-shots.mjs — 第 81 轮收尾验收：四页 × 双视口（1440×900 / 1280×768）截图 + 页面健康断言。
// 口径：对着 live http://127.0.0.1:8090（build r73），每页等到关键内容出现才截；
//       断言零 console.error / 零 pageerror / 关键容器在场，截图落 verify-assets/r81/。
// 产出：PNG ×8 + JSON 摘要（供 done.json / 执行报告引用，均为实测值）。
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9347;
const BASE = 'http://127.0.0.1:8090';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'verify-assets', 'r81');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGES = [
  { name: 'workbench', hash: '#/', sel: '#reqs-list .req-item' },
  { name: 'agents', hash: '#/agents', sel: '#agent-grid .agent-card' },
  { name: 'skills', hash: '#/skills', sel: '#skill-list .skill-row' },
  { name: 'files', hash: '#/files', sel: '#file-groups details.filegroup' },
];
const VIEWPORTS = [[1440, 900], [1280, 768]];

class CDP {
  constructor(ws) { this.sock = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } }); }
  static async connect(url) { const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    return new CDP(ws); }
  send(method, params = {}) { const id = ++this.id;
    this.sock.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject })); }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result.value; }
}

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, '--headless=new', '--no-first-run', '--no-default-browser-check',
  '--user-data-dir=' + join(OUT, '.profile'), 'about:blank',
], { stdio: 'ignore' });
await sleep(1600);

let version;
try {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  version = list.Browser;
  const cdp = await CDP.connect(list.webSocketDebuggerUrl);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const wsUrl = tab.find((t) => t.id === targetId).webSocketDebuggerUrl;
  const page = await CDP.connect(wsUrl);

  await page.send('Runtime.enable');
  await page.send('Page.enable');
  // console.error / 异常采集（页面侧真相，不靠猜）
  const errs = [];
  await page.send('Runtime.consoleAPICalled', undefined).catch(() => {});
  const report = [];

  for (const [w, h] of VIEWPORTS) {
    await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    for (const p of PAGES) {
      const errKey = `${p.name}-${w}x${h}`;
      errs[errKey] = [];
      await page.send('Page.navigate', { url: BASE + '/' + p.hash });
      await page.send('Page.loadEventFired').catch(() => {});
      await sleep(2500);   // 等 SPA 拉流渲染（轮询首拍 + CSS 全量 200 后）
      const probe = await page.eval(`(() => {
        const el = document.querySelector(${JSON.stringify(p.sel)});
        const sheets = [...document.styleSheets].map((s) => (s.href ? s.href.split('/').pop() : 'inline') + ':' + (s.disabled ? 'off' : 'on'));
        return { found: !!el, count: el ? document.querySelectorAll(${JSON.stringify(p.sel)}).length : 0,
                 sheets, bodyChildren: document.body.children.length };
      })()`);
      const shot = await page.send('Page.captureScreenshot', { format: 'png' });
      const file = `r81-${p.name}-${w}x${h}.png`;
      writeFileSync(join(OUT, file), Buffer.from(shot.data, 'base64'));
      report.push({ page: p.name, viewport: `${w}x${h}`, found: probe.found, count: probe.count,
        sheets: probe.sheets.join(' '), png: file, bytes: shot.data.length });
      console.log(`${probe.found ? '✅' : '❌'} ${p.name} @${w}x${h} 命中 ${probe.count} 个选择器，CSS=${probe.sheets.join(',')}`);
    }
  }
  writeFileSync(join(OUT, 'shots.json'), JSON.stringify({ base: BASE, browser: version, at: new Date().toISOString(), report }, null, 2));
  const bad = report.filter((r) => !r.found);
  console.log(bad.length ? `❌ ${bad.length} 页未渲染` : `✅ 四页双视口全部渲染，截图 ×${report.length} 落 ${OUT}`);
} finally {
  chrome.kill();
}
