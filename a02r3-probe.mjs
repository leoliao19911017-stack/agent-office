// A02 第 3 轮探针：上报新鲜度只认业务上报时间（lastReport），与连接心跳解耦。
// 口径（A02 任务书）：
//   1) 三类数据：最近上报（绿色相对时长）/ 超过阈值（已过期 · 时刻，金）/ 从未上报（—，灰蓝）
//   2) 仅更新连接心跳（heartbeatAgeSec 变小）时，上报新鲜度不得重置为「刚刚」
//   3) 业务上报超阈值后：新鲜度翻成已过期，连接健康仍在线（两列独立变化）
//   4) 文字 12px/18px；正常 #65D9B1 / 过期 #E5B95E / 未知 #91A0B4（getComputedStyle 实测）
//   5) 五列布局与 72px 行高不变（getBoundingClientRect + grid-template-columns）
//   6) live 阶段不 mock，直连真实 /api/office/hermes：历史过期记录（11/15 00:08）不得显示「刚刚」
// 用法（repo 根目录）：
//   PHASE=baseline node --experimental-websocket a02r3-probe.mjs   # 改前（备份代码）
//   PHASE=after    node --experimental-websocket a02r3-probe.mjs   # 改后
//   PHASE=live     node --experimental-websocket a02r3-probe.mjs   # 不 mock，真实接口
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9357;
const BASE = 'http://127.0.0.1:8090';
const PHASE = process.env.PHASE || 'after';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 截图里的历史过期时刻：2026-11-15 00:08（本地时区）
const NOV15_0008 = new Date(2026, 10, 15, 0, 8, 0);

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener('message', (e) => { const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
      else if (m.method && this.handlers.has(m.method)) this.handlers.get(m.method)(m.params); }); }
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
  on(method, fn) { this.handlers.set(method, fn); }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('page eval failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  }
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

// —— 造数：三个 Hermes 入口的三类形态。fulfill 时才固化时间值，保证「最近上报」真的最近 ——
// 防御：场景未就绪（scen=null）时给空表——fulfillRequest 必须发出，否则请求永久 paused、
// 首拍 tick() 不结算、全页模块（含 agents 页）都不渲染（首轮 baseline 卡死的根因）。
function hermesPayload(scen) {
  if (!scen) return { generatedAt: new Date().toISOString(), agents: [] };
  const now = Date.now();
  const mk = (id, name, scene, o) => ({
    id, name, type: 'Hermes', scene, sceneDetail: scene,
    online: o.online, lastBeat: new Date(now - o.hbSec * 1000).toISOString(),
    heartbeatAgeSec: o.hbSec, state: o.state, task: o.task,
    lastReport: typeof o.lastReport === 'function'
      ? new Date(o.lastReport()).toISOString()
      : (o.lastReport == null ? null : new Date(o.lastReport).toISOString()),
    reportStale: !!o.stale,
  });
  return { generatedAt: new Date(now).toISOString(), agents: [
    mk('lemate', 'Lemate', 'Coding', scen.lemate),
    mk('winter', 'Winter', '视频剪辑', scen.winter),
    mk('karina', 'Karina', '图文笔记', scen.karina),
  ] };
}

// 场景表：S1 三类数据；S2 仅刷新 winter 连接心跳；S3 lemate 业务上报超阈值
const SCENARIOS = {
  S1_three_classes: {
    desc: '最近上报(lemate) / 超阈值+心跳新鲜(winter,11-15 00:08) / 从未上报(karina)',
    data: {
      lemate: { online: true, hbSec: 12, state: 'working', task: '在做 A02 修复', lastReport: () => Date.now() - 30e3, stale: false },
      winter: { online: true, hbSec: 15, state: 'idle', task: '（上次上报已过期）', lastReport: () => +NOV15_0008, stale: true },
      karina: { online: true, hbSec: 8, state: 'unknown', task: '未接入上报', lastReport: null, stale: false },
    },
  },
  S2_heartbeat_only: {
    desc: '仅 winter 连接心跳 15s→2s，业务上报时间不变——新鲜度不得重置',
    data: {
      lemate: { online: true, hbSec: 12, state: 'working', task: '在做 A02 修复', lastReport: () => Date.now() - 40e3, stale: false },
      winter: { online: true, hbSec: 2, state: 'idle', task: '（上次上报已过期）', lastReport: () => +NOV15_0008, stale: true },
      karina: { online: true, hbSec: 8, state: 'unknown', task: '未接入上报', lastReport: null, stale: false },
    },
  },
  S3_report_goes_stale: {
    desc: 'lemate 业务上报推到 5 分钟前（超阈值），连接心跳仍新鲜——新鲜度翻过期、连接仍在线',
    data: {
      lemate: { online: true, hbSec: 10, state: 'idle', task: '（上次上报已过期）', lastReport: () => Date.now() - 5 * 60e3, stale: true },
      winter: { online: true, hbSec: 15, state: 'idle', task: '（上次上报已过期）', lastReport: () => +NOV15_0008, stale: true },
      karina: { online: true, hbSec: 8, state: 'unknown', task: '未接入上报', lastReport: null, stale: false },
    },
  },
};

// —— DOM 实测：每行六格的文本/类名/上报新鲜度列计算样式 + 行高/网格列 ——
const MEASURE = `(() => {
  const hex = (c) => { const m = c.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/);
    return m ? '#' + [1, 2, 3].map((i) => (+m[i]).toString(16).padStart(2, '0')).join('').toUpperCase() : c; };
  const rows = [...document.querySelectorAll('#agent-grid .agent-card')].map((card) => {
    const sel = card.querySelector('.agent-select');
    const hb = card.querySelector('.ag-hb'); const cs = hb ? getComputedStyle(hb) : null;
    const r = sel.getBoundingClientRect();
    return {
      name: card.querySelector('.agent-name')?.textContent?.trim(),
      conn: { text: card.querySelector('.ag-conn')?.textContent, cls: card.querySelector('.ag-conn')?.className },
      work: card.querySelector('.ag-work')?.textContent,
      hb: { text: hb?.textContent, cls: hb?.className, title: hb?.getAttribute('title'),
            fontSize: cs?.fontSize, lineHeight: cs?.lineHeight, color: cs?.color, colorHex: cs ? hex(cs.color) : null },
      task: card.querySelector('.ag-task')?.textContent,
      rowH: +r.height.toFixed(1),
    };
  });
  const firstSel = document.querySelector('#agent-grid .agent-select');
  return {
    rows,
    gridTemplateColumns: firstSel ? getComputedStyle(firstSel).gridTemplateColumns : null,
    headColumns: document.querySelectorAll('#agent-grid .roster-head span').length,
    innerW: window.innerWidth,
    anyJustNow: rows.some((x) => (x.hb.text || '').includes('刚刚')),
  };
})()`;

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'a02r3-cdp-'));
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--window-size=1440,900', 'about:blank',
  ], { stdio: 'ignore' });
  const out = { phase: PHASE, base: BASE, when: new Date().toISOString(), scenarios: {}, shots: [] };
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

    // mock 开关：baseline/after 拦 /api/office/hermes 注入场景数据；live 直连真实接口
    // currentScen 必须在 Page.navigate 前就绪：页面加载即触发首拍 tick 拉取 hermes，
    // 此时若为 null，fulfill 会拿到空表（见 hermesPayload 防御）而不是挂起。
    let mockOn = PHASE !== 'live';
    let currentScen = mockOn ? SCENARIOS.S1_three_classes.data : null;
    if (mockOn) {
      await cdp.send('Fetch.enable', { patterns: [{ urlPattern: BASE + '/api/office/hermes*', requestStage: 'Request' }] });
      cdp.on('Fetch.requestPaused', async (p) => {
        try {
          const body = JSON.stringify(hermesPayload(currentScen));
          await cdp.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200,
            responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from(body).toString('base64') });
        } catch { /* 页面重导航等造成的 requestId 失效可忽略 */ }
      });
    }

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: BASE + '/' });
    await sleep(700);
    await cdp.eval(`document.getElementById('rail-agents').click()`);
    const ok = await waitFor(cdp, '#agent-grid .agent-card');
    if (!ok) throw new Error('agent cards never rendered');

    const names = ['S1_three_classes', 'S2_heartbeat_only', 'S3_report_goes_stale'];
    for (const key of mockOn ? names : ['LIVE_real_api']) {
      if (mockOn) currentScen = SCENARIOS[key].data;
      await sleep(4300);   // 等下一拍 3s 轮询拿到新 payload 并重渲染
      out.scenarios[key] = { desc: mockOn ? SCENARIOS[key].desc : '真实 /api/office/hermes，不 mock', measure: await cdp.eval(MEASURE) };
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const f = `a02r3-${PHASE}-${key}-1440x900.png`;
      writeFileSync(f, Buffer.from(shot.data, 'base64'));
      out.shots.push(f);
    }
  } finally {
    chrome.kill();
  }
  const j = `a02r3-${PHASE}.json`;
  writeFileSync(j, JSON.stringify(out, null, 2));
  console.log('wrote', j, 'and', out.shots.join(', '));
}

main().catch((e) => { console.error(e); process.exit(1); });
