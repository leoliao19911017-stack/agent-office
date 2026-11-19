// X 系列（Agent 真实状态）验证：一次跑完四件事，全部真实证据落盘
//  1) Agents 页 roster 全量行读数：Claude Code 三维 + Hermes 三行「未知」（自测2/4，逐字记录）
//  2) 点开 Claude Code 行：明细面板（实时状态·本机实测/中台档案/额度样本/执行记录）+ 截图（自测2）
//  3) 注入伪数据点（claude lastActivityAt → 20 分钟前，进程仍活着）→ roster 必须显示「空闲」+ 截图（自测3）
//  4) 首页驾驶舱 roster 卡：Claude 行与 Hermes 行文案 + 截图
// 用法：node --experimental-websocket verify-x-agents-real.mjs
// 证据：verify-x-agents.json + verify-x-agents-roster.png / -detail.png / -idle-fake.png / -cabin.png
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9341;            // 独立端口，避免撞上其他验证实例
const BASE = process.env.BASE || 'http://127.0.0.1:8090';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (e) => { const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result); } });
  }
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
    if (r.exceptionDetails) throw new Error('page eval failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 500));
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

async function shot(cdp, path) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(path, Buffer.from(r.data, 'base64'));
}

// roster 全量行读数（逐字，含 title 提示）
const ROSTER = `(() => {
  const t = (el) => (el && el.textContent || '').trim();
  return [...document.querySelectorAll('#agent-grid .agent-card')].map(card => ({
    id: card.querySelector('.agent-select')?.dataset.agent || null,
    ids: t(card.querySelector('.ag-ids')),
    conn: t(card.querySelector('.ag-conn')),
    work: t(card.querySelector('.ag-work')),
    workTitle: card.querySelector('.ag-work')?.title || '',
    can: t(card.querySelector('.ag-can')),
    canTitle: card.querySelector('.ag-can')?.title || '',
    hb: t(card.querySelector('.ag-hb')),
    task: t(card.querySelector('.ag-task')),
  }));
})()`;

// 底栏 chips（与 roster 同源 agentStats）
const CHIPS = `(() => [...document.querySelectorAll('.sb-chip')].map(el => ({ text: (el.textContent||'').trim(), title: el.title || '' })))()`;

// 明细面板（展开态卡片内）：标题 + 全部键值对 + 说明段
const DETAIL = `(() => {
  const card = document.querySelector('#agent-grid .agent-card.selected');
  if (!card) return { open: false };
  const kvs = [...card.querySelectorAll('.agent-detail .agent-kv')].map(kv => [ (kv.children[0].textContent||'').trim(), (kv.children[1].textContent||'').trim() ]);
  return { open: true,
    headings: [...card.querySelectorAll('.agent-detail h4')].map(h => (h.textContent||'').trim()),
    kvs,
    sample: (card.querySelector('.agent-detail .agent-role')?.textContent || '').trim() };
})()`;

// 自测3：注入伪数据点——claude 最近活动改到 20 分钟前（进程仍活着），立刻重渲并同步读回
const INJECT_IDLE = `(() => {
  const d = (typeof agentsRealData === 'undefined') ? null : agentsRealData;
  if (!d || !d.agents || !d.agents.claude) return { ok: false, why: 'agentsRealData 未就绪', keys: d ? Object.keys(d) : null };
  const before = { lastActivityAt: d.agents.claude.lastActivityAt, processAlive: d.agents.claude.processAlive, processCount: d.agents.claude.processCount };
  d.agents.claude = Object.assign({}, d.agents.claude, { lastActivityAt: new Date(Date.now() - 20 * 60 * 1000).toISOString() });
  renderAgents();
  const card = [...document.querySelectorAll('#agent-grid .agent-card')].find(c => c.querySelector('.agent-select')?.dataset.agent === 'claude');
  const t = (el) => (el && el.textContent || '').trim();
  return { ok: true, injectedAgeMin: 20, before,
    conn: t(card?.querySelector('.ag-conn')), work: t(card?.querySelector('.ag-work')),
    can: t(card?.querySelector('.ag-can')), hb: t(card?.querySelector('.ag-hb')), task: t(card?.querySelector('.ag-task')) };
})()`;

const AFTER_INJECT_READ = `(() => {
  const card = [...document.querySelectorAll('#agent-grid .agent-card')].find(c => c.querySelector('.agent-select')?.dataset.agent === 'claude');
  return (card?.querySelector('.ag-work')?.textContent || '').trim();
})()`;

// 首页驾驶舱 roster 卡行
const CABIN = `(() => [...document.querySelectorAll('.roster-row')].map(r => ({
  row: (r.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 140),
  state: (r.querySelector('.roster-state')?.textContent || '').trim(),
})))()`;

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'x-agents-cdp-'));
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--window-size=1440,900', 'about:blank',
  ], { stdio: 'ignore' });
  const out = { when: new Date().toISOString(), base: BASE, viewport: '1440x900', shots: [] };
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

    // ---------- 1/2 · Agents 页 roster + Claude 明细 ----------
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__errs=[]; window.addEventListener("error",function(e){window.__errs.push(String(e.message)+" @"+(e.filename||"")+":"+e.lineno);});' });
    await cdp.send('Page.navigate', { url: BASE + '/#/settings' });
    await waitFor(cdp, '[data-settab="agents"]');
    let opened = false, clickDumps = [];
    for (let i = 0; i < 3 && !opened; i++) {
      await sleep(400);
      clickDumps.push(await cdp.eval(`(() => {
        const btns = [...document.querySelectorAll('[data-settab="agents"]')];
        btns[0] && btns[0].click();
        return { matches: btns.length, visible: btns.map(b => !!b.offsetParent) };
      })()`));
      await sleep(700);
      opened = await cdp.eval(`!!document.getElementById('page-agents') || document.querySelectorAll('#agent-grid .agent-card').length > 0`);
    }
    out.tabClicks = clickDumps;
    if (!opened) {
      const dump = await cdp.eval(`(() => ({ errs: window.__errs, scope: (document.getElementById('agent-scope')||{}).textContent || null, gridHtml: ((document.getElementById('agent-grid')||{}).innerHTML || '').slice(0, 160), tabHtml: ((document.querySelector('[data-settab="agents"]')||{parentElement:{}}).parentElement.outerHTML || '').slice(0, 300), hash: location.hash }))()`);
      throw new Error('roster 没渲染出来：' + JSON.stringify(dump));
    }
    if (!await waitFor(cdp, '#agent-grid .agent-card', 30000)) {
      const dump = await cdp.eval(`(() => ({ scope: (document.getElementById('agent-scope')||{}).textContent || null, gridHtml: ((document.getElementById('agent-grid')||{}).innerHTML || '').slice(0, 160), settabBtn: !!document.querySelector('[data-settab="agents"]'), hash: location.hash }))()`);
      throw new Error('roster 没渲染出来：' + JSON.stringify(dump));
    }
    await sleep(800);                       // 等 /api/agents/real 首轮回来（tick 3s + 接口 5s 缓存）
    out.roster = await cdp.eval(ROSTER);
    out.chips = await cdp.eval(CHIPS);
    await shot(cdp, 'verify-x-agents-roster.png'); out.shots.push('verify-x-agents-roster.png');

    await cdp.eval(`(() => { const b = [...document.querySelectorAll('.agent-select')].find(x => x.dataset.agent === 'claude'); if (!b) throw new Error('没有 claude 行'); b.click(); })()`);
    await sleep(500);
    out.detail = await cdp.eval(DETAIL);
    await shot(cdp, 'verify-x-agents-detail.png'); out.shots.push('verify-x-agents-detail.png');

    // ---------- 3 · 注入伪数据点：20 分钟前 → 必须显示「空闲」 ----------
    out.injectIdle = await cdp.eval(INJECT_IDLE);
    await shot(cdp, 'verify-x-agents-idle-fake.png'); out.shots.push('verify-x-agents-idle-fake.png');
    // 截图后马上复读：若 3s tick 已把真数据刷回来，重来一次（最多 3 次）
    for (let i = 0; i < 3; i++) {
      const after = await cdp.eval(AFTER_INJECT_READ);
      if (after.includes('空闲')) { out.injectIdlePostRead = after; break; }
      out.injectIdle = await cdp.eval(INJECT_IDLE);
      await shot(cdp, 'verify-x-agents-idle-fake.png');
      if (i === 2) out.injectIdlePostRead = after + '（最终复读）';
    }

    // ---------- 4 · 首页驾驶舱 roster 卡（默认折叠一行结论，点开看逐行） ----------
    await cdp.send('Page.navigate', { url: BASE + '/' });
    await waitFor(cdp, '[data-cabin-roster]');
    await sleep(800);
    out.cabinHead = await cdp.eval(`(() => (document.querySelector('.roster-h b')?.textContent || '').trim())()`);
    await cdp.eval(`document.querySelector('[data-cabin-roster]').click()`);
    if (!await waitFor(cdp, '.roster-row', 5000)) throw new Error('驾驶舱 roster 明细没展开');
    await sleep(300);
    out.cabinRoster = await cdp.eval(CABIN);
    await shot(cdp, 'verify-x-cabin.png'); out.shots.push('verify-x-cabin.png');

    // ---------- 结论判定（不许自欺：哪条不成立就如实标 false） ----------
    const claudeRow = (out.roster || []).find(r => r.id === 'claude');
    const codexRow = (out.roster || []).find(r => r.id === 'codex');
    const hermesRows = (out.roster || []).filter(r => ['lemate', 'winter', 'karina'].includes(r.id));
    out.checks = {
      rosterHasClaudeRow: !!claudeRow,
      claudeConnIsProcess: !!claudeRow && /进程活着（\d+ 个）|进程没开|进程未知/.test(claudeRow.conn),
      claudeCanReal: !!claudeRow && ['能接活', '额度用完', '未知'].includes(claudeRow.can),
      detailOpenWithHeadings: !!(out.detail && out.detail.open && (out.detail.headings || []).some(h => h.includes('实时状态'))),
      idleFakeShowsIdle: !!(out.injectIdle && out.injectIdle.ok && out.injectIdle.work.includes('空闲') && out.injectIdle.conn.includes('进程活着')),
      hermesNeverIdle: hermesRows.length === 3 && hermesRows.every(r => r.work.includes('未知') && !r.work.includes('空闲') && r.can.includes('未知')),
      codexRealFromProbe: !!codexRow,
      cabinClaudeRealState: !!(out.cabinRoster || []).find(r => r.row.includes('Claude') && (r.state.includes('在干活') || r.state.includes('空闲'))),
      // Hermes 驾驶舱行：红线是「不许用空闲兜底」，措辞须表达不确定（未知 / 没动静）
      cabinHermesNeverIdle: ['Lemate', 'Winter', 'Karina'].every(n => { const r = (out.cabinRoster || []).find(x => x.row.includes(n)); return !!r && !r.state.includes('空闲') && (r.state.includes('未知') || r.state.includes('没动静')); }),
      cabinCodexQuota: !!(out.cabinRoster || []).find(r => r.row.includes('Codex') && r.state.includes('额度用完')),
    };
    out.allPass = Object.values(out.checks).every(Boolean);
    writeFileSync('verify-x-agents.json', JSON.stringify(out, null, 2));
    console.log(JSON.stringify({ allPass: out.allPass, checks: out.checks, shots: out.shots }));
  } finally {
    chrome.kill();
  }
}

main().catch((e) => { console.error('VERIFY-X FAILED:', e.message); process.exit(1); });
