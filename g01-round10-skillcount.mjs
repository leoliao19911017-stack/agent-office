// G01 r10 补测：#skill-list .skill-row small（技能摘要）的真实 getComputedStyle 值
// （探针 mark 回溯只找 3 层内有 class 的祖先，small 无 class 时落到 button.skill-row，被控件豁免跳过——这里直接量 small 本身）
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9343;
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
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, resolve, reject }));
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('page eval failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  }
}

const UTIL = `
const parseColor = (s) => { const m = s.match(/rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)(?:,\\s*([\\d.]+))?\\)/); return m ? { r:+m[1], g:+m[2], b:+m[3], a:m[4]===undefined?1:+m[4] } : null; };
const lum = (c) => { const f = (v) => { v/=255; return v<=0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); }; return 0.2126*f(c.r)+0.7152*f(c.g)+0.0722*f(c.b); };
const contrast = (fg, bg) => { const l1 = lum(fg), l2 = lum(bg); return (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05); };
const solidBg = (el) => { let n = el; while (n && n !== document.documentElement) { const c = parseColor(getComputedStyle(n).backgroundColor); if (c && c.a >= 0.99) return c; n = n.parentElement; } return parseColor(getComputedStyle(document.body).backgroundColor) || {r:13,g:17,b:26,a:1}; };
`;

const MEASURE = `(() => { ${UTIL}
  const rows = [...document.querySelectorAll('#skill-list .skill-row small')].slice(0, 3).map((el) => {
    const cs = getComputedStyle(el);
    const fg = parseColor(cs.color), bg = solidBg(el);
    return { text: el.textContent.trim().slice(0, 22), len: el.textContent.trim().length,
      fontSize: cs.fontSize, lineHeight: cs.lineHeight, color: cs.color,
      multiLine: el.getClientRects().length > 1,
      contrast: +contrast(fg, bg).toFixed(2) };
  });
  return rows;
})()`;

const profile = mkdtempSync(join(tmpdir(), 'g01r10c-cdp-'));
const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
try {
  let targets = null;
  for (let i = 0; i < 50; i++) { try { const res = await fetch(`http://127.0.0.1:${PORT}/json/list`); targets = await res.json(); break; } catch { await sleep(200); } }
  if (!targets) throw new Error('chrome devtools port never came up');
  const cdp = await CDP.connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable'); await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: BASE + '/' }); await sleep(1200);
  await cdp.eval(`document.getElementById('rail-skills').click()`); await sleep(1200);
  const rows = await cdp.eval(MEASURE);
  if (!rows.length) console.log('NO .skill-row small FOUND');
  for (const r of rows) console.log(JSON.stringify(r));
} finally { chrome.kill(); }
