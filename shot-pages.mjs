// shot-pages.mjs — TASK-工作台重做 验收取证脚本（2026-11-18）
// 做四件事（对应任务书验收 1-7）：
//   1. 四页截图（我的任务 / 干活记录 / 设置 / 专业视图）→ shots/*.png
//   2. 首页可见文本禁用词扫描（8 词，含顶栏/状态栏）
//   3. 底部主按钮唯一性、目标分显示、走过的路可展开 —— 全部量 getBoundingClientRect 实测值
//   4. window.__uiErrors === 0
// 跑法：node --experimental-websocket shot-pages.mjs
// 实现沿用 verify-w01.mjs 的裸 CDP over WebSocket 方案（本机无 playwright 模块）。

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = 'http://127.0.0.1:8090';
// 注意：URL.pathname 保留 %20 编码，必须走 fileURLToPath，否则会把截图写进
// 字面名叫「Soda%20Intelligence…」的错误目录（第一版就犯了这个错）。
const OUT = fileURLToPath(new URL('./shots/', import.meta.url));
mkdirSync(OUT, { recursive: true });

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DEBUG_PORT = 9334;

// ---- 最小 CDP 客户端（与 verify-w01.mjs 同款） ----
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('eval 异常: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
}

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${DEBUG_PORT}`,
  '--headless=new',
  '--no-first-run',
  // 每次跑用全新 profile：上一次跑完停在 /agents，localStorage 里的页面位置会让
  // 下次启动被 restoreUiPos 直接拉去设置页，首页量出来全是 0×0（第二版犯的错）。
  '--user-data-dir=' + OUT + 'profile-' + Date.now(),
  '--window-size=1440,900',
  'about:blank',
], { stdio: 'ignore' });
const die = (msg) => { try { chrome.kill() } catch {} ; console.error(msg); process.exit(1); };

// 等 DevTools 端口就绪并找到 page target
let target;
for (let i = 0; i < 40; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
    target = list.find((t) => t.type === 'page');
    if (target) break;
  } catch { /* 还没起来 */ }
  await sleep(250);
}
if (!target) die('Chrome DevTools 端口 40 次都没等到，放弃');

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
const cdp = new CDP(ws);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');

// ---- 轮询等待页面就绪（首页数据首轮同步 + 渲染完成） ----
async function goto(hash, readyExpr, timeoutMs = 20000) {
  await cdp.send('Page.navigate', { url: BASE + '/#' + hash });
  const t0 = Date.now();
  for (;;) {
    const ok = await cdp.eval(`(function(){ try { return !!(${readyExpr}); } catch { return false; } })()`);
    if (ok) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`页面就绪超时: #${hash} 等 ${readyExpr}`);
    await sleep(400);
  }
}
async function shot(name) {
  const b64 = (await cdp.send('Page.captureScreenshot', { format: 'png' })).data;
  writeFileSync(OUT + name + '.png', Buffer.from(b64, 'base64'));
}

const evidence = {};

// ============ ① 我的任务（首页） ============
await goto('', `document.querySelector('#cabin-main .cabin-now') || document.querySelector('#cabin-main .cabin-loading')`);
// 双保险：就算启动时被恢复逻辑带偏，也拉回首页并等它真的显示
await cdp.eval(`if (document.body.dataset.page !== 'home') location.hash = '/'`);
for (let i = 0; i < 30 && !(await cdp.eval(`document.body.dataset.page === 'home' && !!document.querySelector('.cabin-now h2')`)); i++) await sleep(300);
await sleep(1200);   // 等 3s 轮询一拍，任务条/进度条落定
await shot('1-home');
evidence.home = await cdp.eval(`(function(){
  const vis = (el) => { if(!el) return false; const r = el.getBoundingClientRect(); return r.width>0 && r.height>0; };
  const banned = ['SHA-256','字节','指纹','加权','门禁','实例','心跳','产物'];
  const scope = ['#topbar','#page-home','#statusbar'].map(s=>document.querySelector(s)).filter(Boolean);
  const text = scope.map(el=>el.innerText||'').join('\\n');
  const hits = banned.filter(w=>text.includes(w));
  const foot = document.getElementById('cabin-foot');
  const mainBtns = foot ? [...foot.querySelectorAll('.btn-primary')].filter(vis) : [];
  const allBtns = foot ? [...foot.querySelectorAll('button')].filter(vis) : [];
  const bar = document.querySelector('.cabin-bar');
  const barFill = document.querySelector('.cabin-bar i');
  const h2 = document.querySelector('.cabin-now h2');
  const prog = document.querySelector('.cabin-progress');
  const score = document.getElementById('tb-score');
  const pastBtn = document.querySelector('[data-cabin-past]');
  return {
    oneSentence: h2 ? h2.innerText : null,
    oneSentenceRect: h2 ? (r=>({x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}))(h2.getBoundingClientRect()) : null,
    progressBar: bar && barFill ? { trackW: Math.round(bar.getBoundingClientRect().width), fillW: Math.round(barFill.getBoundingClientRect().width), fillPct: barFill.style.width } : null,
    progressText: prog ? prog.innerText : null,
    topScore: score && !score.hidden ? score.innerText : '(未显示)',
    primaryButtonCount: mainBtns.length,
    primaryButtonLabel: mainBtns.map(b=>b.innerText.trim()),
    footButtonCount: allBtns.length,
    bannedWordsVisible: hits,
    pastToggleText: pastBtn ? pastBtn.innerText : null,
    uiErrors: window.__uiErrors,
  };
})()`);

// 走过的路可展开：点开再量一次（完成步数量 + 展开按钮文案）
evidence.pastExpand = await cdp.eval(`(function(){
  const btn = document.querySelector('[data-cabin-past]');
  if (!btn) return { ok:false, why:'没有展开按钮（可能还没有做完的步骤）' };
  const before = document.querySelectorAll('.cp.done').length;
  btn.click();
  const after = document.querySelectorAll('.cp.done').length;
  const btnAfter = document.querySelector('[data-cabin-past]');
  return { ok: after > before, doneBefore: before, doneAfter: after, toggleAfter: btnAfter ? btnAfter.innerText : null };
})()`);
await sleep(300);
await shot('1-home-expanded');

// ============ ② 干活记录 ============
await cdp.eval(`location.hash='/log'`);
await sleep(900);
await shot('2-log');
evidence.log = await cdp.eval(`(function(){
  const hl = document.querySelector('.log-headline');
  const roster = [...document.querySelectorAll('.log-agent')].map(el=>el.innerText.replace(/\\s+/g,' ').trim());
  const evs = document.querySelectorAll('.log-ev').length;
  return { headline: hl?hl.innerText:null, rosterCount: roster.length, roster: roster.slice(0,8), eventCount: evs };
})()`);

// ============ ③ 设置 ============
await cdp.eval(`location.hash='/settings'`);
await sleep(900);
await shot('3-settings');
evidence.settings = await cdp.eval(`(function(){
  const tabs = [...document.querySelectorAll('[data-settab]')].map(b=>({ label:b.innerText, on:b.classList.contains('on') }));
  const input = document.getElementById('cabin-defscore-input');
  const termRows = document.querySelectorAll('.set-terms tr').length;
  // 页签真的能切：点「AI 与干活状态」，旧 Agents 页应显示
  const agBtn = document.querySelector('[data-settab="agents"]');
  agBtn.click();
  const agentsVisible = !document.getElementById('page-agents').hidden && document.getElementById('page-agents').getBoundingClientRect().width > 0;
  const generalBack = !document.getElementById('set-general').hidden;
  return { tabs, defaultScoreInput: input?input.value:null, termRows, agentsTabSwitchShowsAgentsPage: agentsVisible, generalHiddenAfterSwitch: !generalBack };
})()`);
await sleep(600);
await shot('3-settings-agents');

// ============ ④ 专业视图（原三栏工作台，页面没删） ============
await cdp.eval(`location.hash='/pro'`);
await sleep(900);
await shot('4-pro');
evidence.pro = await cdp.eval(`(function(){
  const reqs = document.getElementById('reqs'), insp = document.getElementById('inspector');
  const chain = document.getElementById('center-chain');
  return { reqsW: Math.round(reqs.getBoundingClientRect().width), inspW: Math.round(insp.getBoundingClientRect().width),
    chainChildren: chain ? chain.children.length : 0, pageHidden: document.getElementById('page-workbench').hidden };
})()`);

// ============ 导航三项切换 + 旧链接重定向 ============
evidence.navigation = await cdp.eval(`(async function(){
  const out = [];
  const go = async (hash, page) => {
    location.hash = hash;
    await new Promise(r=>setTimeout(r,500));
    out.push({ hash, page: document.body.dataset.page, title: document.title,
      homeHidden: document.getElementById('page-home').hidden,
      logHidden: document.getElementById('page-log').hidden,
      setHidden: document.getElementById('page-settings').hidden });
  };
  await go('/', 'home'); await go('/log', 'log'); await go('/settings', 'settings');
  // 旧链接兼容：/agents 应落到设置页 agents 页签
  await go('/agents', 'settings');
  out[out.length-1].settingsTabAfterLegacy = document.querySelector('[data-settab="agents"]').classList.contains('on');
  return out;
})()`);

// ============ 终态：JS 错误计数 ============
evidence.uiErrorsFinal = await cdp.eval('window.__uiErrors');

writeFileSync(OUT + 'measure.json', JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
console.log('\n四张截图已存 ' + OUT + '；实测数据 ' + OUT + 'measure.json');

try { chrome.kill() } catch {}
process.exit(0);
