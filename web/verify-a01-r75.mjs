// verify-a01-r75.mjs — A01 第 75 轮：三状态列四组数据实测（1440×900）。
// 口径（任务书）：连接=真实探测；执行=真实自报事件；上报新鲜度=最后一次成功上报时间。
//   新鲜(≤300s)=#65D9B1 ｜ 过期(>300s)=#E5B95E ｜ 无上报「—」=#8996A8 ｜ 三列文字 12px/18px。
//   不得把「连接在线」映射成 空闲/执行中/上报正常。
// 做法：CDP 打开 agents 页，对 hermes 角色 lemate 依次注入四组 hermesData（真实 300s 阈值），
// 每组调用 renderAgents() 重渲染后量该行三列的文本 + getComputedStyle 字号/颜色。
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9343;
const BASE = process.env.BASE || 'http://127.0.0.1:8090';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// 组名 → hermesData.agents[0]（角色 lemate）。now 由 lastState.now 或 Date.now。
// reportStale 由服务端语义预置（前端只读）；lastReport 用真实时间戳保证 300s 阈值两侧确定。
const AGO = (s) => new Date(Date.now() - s * 1000).toISOString();
const GROUPS = {
  g1_online_no_report: { online: true, state: 'unknown', lastReport: null },                       // 在线+从未上报
  g2_online_stale: { online: true, state: 'working', reportStale: true, lastReport: AGO(600), task: '旧任务' }, // 在线+上报过期10分钟
  g3_offline_hist: { online: false, state: 'idle', reportStale: true, lastReport: AGO(120), task: '历史任务' },  // 掉线+历史上报(2分钟前,新鲜)
  g4_online_working: { online: true, state: 'working', reportStale: false, lastReport: AGO(30), task: '当前任务' }, // 在线+执行中+30秒前上报
};

const MEASURE = (fixture) => `(() => {
  hermesData = { agents: [{ id: 'lemate', name: 'Lemate', ${Object.entries(fixture).map(([k, v]) =>
    `${k}:${JSON.stringify(v)}`).join(', ')} }] };
  renderAgents();
  const row = [...document.querySelectorAll('.agent-card')]
    .find(r => r.textContent.includes('Lemate') && r.querySelector('.ag-hb'));
  if (!row) return { error: 'no roster row' };
  const pick = (sel) => { const el = row.querySelector(sel); if (!el) return null;
    const cs = getComputedStyle(el);
    return { text: el.textContent.trim().slice(0, 24), fs: cs.fontSize, lh: cs.lineHeight, color: cs.color }; };
  return {
    conn: pick('.ag-conn'), work: pick('.ag-work'), hb: pick('.ag-hb'),
    fiveCol: !!row.querySelector('.ag-hb') && !!row.querySelector('.ag-conn') && !!row.querySelector('.ag-work'),
  };
})()`;

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'a01r75-cdp-'));
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
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: `${BASE}/#/agents` });
    for (let i = 0; i < 100; i++) { if (await cdp.eval(`typeof renderAgents === 'function' && !!document.querySelector('.ag-hb')`)) break; await sleep(200); }

    // 先量真实基线（未注入），确认页面活着
    const results = { baseline: await cdp.eval(MEASURE(GROUPS.g1_online_no_report).replace('hermesData =', 'window.__keep =')) };
    for (const [name, fixture] of Object.entries(GROUPS)) {
      results[name] = await cdp.eval(MEASURE(fixture));
      console.log(`[${name}]`, JSON.stringify(results[name]));
    }

    // 断言：每组三列 12px/18px；颜色符合口径
    const C = { ok: 'rgb(101, 217, 177)', stale: 'rgb(229, 185, 94)', faint: 'rgb(137, 150, 168)' };
    const expect = {
      g1_online_no_report: { hbColor: C.faint, hbText: '—', workText: '未知', connText: '在线' },
      g2_online_stale: { hbColor: C.stale, hbHas: '已过期', workText: '未知', connText: '在线' },
      g3_offline_hist: { hbColor: C.ok, workText: '未知', connText: '离线' },
      g4_online_working: { hbColor: C.ok, workText: '执行中', connText: '在线' },
    };
    let allOk = true;
    for (const [name, r] of Object.entries(results)) {
      if (name === 'baseline') continue;
      if (r.error) { console.error(`✗ ${name}: ${r.error}`); allOk = false; continue; }
      for (const col of ['conn', 'work', 'hb']) {
        if (r[col].fs !== '12px' || r[col].lh !== '18px') { console.error(`✗ ${name}.${col} 字号 ${r[col].fs}/${r[col].lh} ≠ 12px/18px`); allOk = false; }
      }
      const e = expect[name];
      if (e.hbColor && r.hb.color !== e.hbColor) { console.error(`✗ ${name}.hb 色 ${r.hb.color} ≠ ${e.hbColor}`); allOk = false; }
      if (e.hbText && r.hb.text !== e.hbText) { console.error(`✗ ${name}.hb 文本 "${r.hb.text}" ≠ ${e.hbText}`); allOk = false; }
      if (e.hbHas && !r.hb.text.includes(e.hbHas)) { console.error(`✗ ${name}.hb 文本 "${r.hb.text}" 不含 ${e.hbHas}`); allOk = false; }
      if (e.workText && r.work.text !== e.workText) { console.error(`✗ ${name}.work "${r.work.text}" ≠ ${e.workText}`); allOk = false; }
      if (e.connText && r.conn.text !== e.connText) { console.error(`✗ ${name}.conn "${r.conn.text}" ≠ ${e.connText}`); allOk = false; }
    }
    console.log(allOk ? '\nA01-R75: ALL OK' : '\nA01-R75: FAIL');
    process.exitCode = allOk ? 0 : 1;
  } finally {
    try { chrome.kill(); } catch {}
    try { execSync(`taskkill /PID ${chrome.pid} /T /F`, { stdio: 'ignore' }); } catch {}
  }
}
main().catch((e) => { console.error('FAIL', e); process.exit(1); });
