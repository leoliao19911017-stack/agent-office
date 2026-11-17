// W02 r13 像素实证：从已存滚底截图直接采样底栏边界两侧像素
// 解矛盾：--paper=#F1EADB(浅) vs foot #111927(深) 应有强对比；视觉模型却说融为一体
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9485;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.sock = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    return new CDP(ws);
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.sock.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('page eval failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result.value;
  }
}

// 每视口的 foot 几何来自 w02r13-after.json（getBoundingClientRect 实测）
const after = JSON.parse(readFileSync('w02r13-after.json', 'utf8'));
const plan = after.viewports.map((v) => {
  const f = v.foot, b = v.bodyRect;
  const cx = Math.round(f.x + f.w / 2);
  return {
    tag: v.viewport,
    png: `w02r13-after-${v.viewport}-bottom.png`,
    w: v.innerWidth, h: v.innerHeight,
    cols: [
      { x: cx, points: [
        { y: Math.round(f.y - 6), label: 'body 纸面(边界上方6px)' },
        { y: Math.round(f.y), label: 'border-top 行(1px)' },
        { y: Math.round(f.y + 32), label: 'foot 内部(+32px)' },
      ]},
      { x: Math.round(f.x + 8), points: [
        { y: Math.round(f.y - 6), label: 'body 纸面(左缘)' },
        { y: Math.round(f.y), label: 'border-top(左缘)' },
        { y: Math.round(f.y + 32), label: 'foot 内部(左缘)' },
      ]},
    ],
    bodyBottom: b.bottom, footTop: f.y,
  };
});

const profile = mkdtempSync(join(tmpdir(), 'w02r13px-'));
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank',
], { stdio: 'ignore' });
try {
  let targets = null;
  for (let i = 0; i < 50; i++) {
    try { const res = await fetch(`http://127.0.0.1:${PORT}/json/list`); targets = await res.json(); break; }
    catch { await sleep(200); }
  }
  const page = targets.find((t) => t.type === 'page');
  const cdp = await CDP.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');

  const results = [];
  for (const p of plan) {
    const b64 = readFileSync(p.png).toString('base64');
    const samples = await cdp.eval(`(async () => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + ${JSON.stringify(b64)};
      await img.decode();
      const cv = document.createElement('canvas');
      cv.width = img.width; cv.height = img.height;
      const ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const cols = ${JSON.stringify(p.cols)};
      const hex = (r, g, b) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
      return { imgSize: [img.width, img.height], cols: cols.map((c) => ({
        x: c.x, points: c.points.map((pt) => {
          const d = ctx.getImageData(c.x, pt.y, 1, 1).data;
          return { y: pt.y, label: pt.label, rgb: [d[0], d[1], d[2]], hex: hex(d[0], d[1], d[2]) };
        }),
      })) };
    })()`);
    results.push({ tag: p.tag, ...samples, bodyBottom: p.bodyBottom, footTop: p.footTop });
    console.log(`\n===== ${p.tag} (${samples.imgSize.join('x')}) bodyBottom=${p.bodyBottom} footTop=${p.footTop} =====`);
    for (const c of samples.cols) {
      console.log(`  x=${c.x}`);
      for (const pt of c.points) console.log(`    y=${pt.y} ${pt.label}: ${pt.rgb.join(',')} (${pt.hex})`);
    }
  }
  writeFileSync('w02r13-pixels.json', JSON.stringify(results, null, 1));
  console.log('\nwrote w02r13-pixels.json');
} finally {
  try { chrome.kill(); } catch {}
  try { execSync(`taskkill /PID ${chrome.pid} /T /F`, { stdio: 'ignore' }); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
