// G04 验收脚本：四个页面空白的启动回归修复验证。
// 用 Chrome headless + 原生 CDP（node --experimental-websocket）实测：
//   T1 正常启动      —— 真实需求数 + 七步流水线 + 控制台无未捕获异常 + API 与页面一致
//   T2a 服务整个断开 —— 已加载页面挂错误横幅、不空白、不造假
//   T2b API 断开     —— 静态可达但 /api/* 502：首轮失败态按 G04 样式挂出
//   T3 JS 模块异常   —— shared.js 改名 404：启动护栏挂失败态，页面不永久空白
//   T4 API 延迟 9.5s —— 8s 看门狗挂失败态（量样式），迟到数据到达后自动恢复
// 运行：node --experimental-websocket g04-verify.mjs（需 8090 服务由本脚本外启动/或自动拉起）
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, 'web');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const MAIN = 'http://127.0.0.1:8090';
const CDP_PORT = 9223;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const report = { tests: [], console: [] };
function log(...a) { console.log(...a); }
function section(t) { log('\n========== ' + t + ' =========='); }

// ---------------- Chrome / CDP ----------------
let chromeProc = null;
let ws = null;
let msgId = 0;
const pending = new Map();      // id -> {resolve, reject}
const events = [];              // {test, type, text}
let currentTest = '(init)';

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function startChrome() {
  const profile = mkdtempSync(join(tmpdir(), 'g04-chrome-'));
  chromeProc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--no-sandbox',
    '--window-size=1440,900', 'about:blank',
  ], { stdio: 'ignore' });
  // 等 DevTools 端口就绪
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const list = await r.json();
      if (list.some((t) => t.webSocketDebuggerUrl)) return list;
    } catch { /* not ready */ }
    await sleep(200);
  }
  throw new Error('Chrome DevTools 端口未就绪');
}

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    } else if (m.method) {
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        events.push({ test: currentTest, type: 'exception', text: (d.exception && (d.exception.description || d.exception.value)) || d.text || '?' });
      } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        events.push({ test: currentTest, type: 'consoleError', text: m.params.args.map((a) => a.value || a.description || '').join(' ').slice(0, 300) });
      }
    }
  };
  await send('Runtime.enable');
  await send('Page.enable');
}

async function navigate(url, waitMs) {
  await send('Page.navigate', { url });
  await sleep(waitMs);
}

async function evalJS(expression, awaitPromise = false) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error('页面内求值异常: ' + ((d.exception && d.exception.description) || d.text));
  }
  return r.result.value;
}

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(HERE, `g04-${name}.png`), Buffer.from(r.data, 'base64'));
}

// 页面探针：业务状态 + 失败横幅的计算样式
const PROBE = `JSON.stringify((() => {
  const banner = document.getElementById('data-banner');
  const cs = banner ? getComputedStyle(banner) : null;
  const cnt = document.getElementById('reqs-count');
  const track = [...document.querySelectorAll('.track-node')];
  return {
    reqsCountText: cnt ? cnt.textContent : null,
    reqListChildren: document.querySelectorAll('#reqs-list > *').length,
    trackNodes: track.length,
    trackTitles: track.map(n => (n.getAttribute('title') || '').slice(0, 40)),
    bannerHidden: banner ? banner.hidden : null,
    bannerClass: banner ? banner.className : null,
    bannerText: banner && !banner.hidden ? banner.textContent.replace(/\\s+/g, ' ').trim().slice(0, 160) : null,
    bannerRect: banner && !banner.hidden ? (r => ({ w: r.width, h: r.height }))(banner.getBoundingClientRect()) : null,
    bannerCS: banner && !banner.hidden ? { fontSize: cs.fontSize, lineHeight: cs.lineHeight, color: cs.color, backgroundColor: cs.backgroundColor, paddingTop: cs.paddingTop, paddingRight: cs.paddingRight, paddingBottom: cs.paddingBottom, paddingLeft: cs.paddingLeft } : null,
    uiErrors: window.__uiErrors === undefined ? null : window.__uiErrors,
    sbConn: document.getElementById('sb-conn-text') ? document.getElementById('sb-conn-text').textContent : null,
    centerTextLen: document.getElementById('center-chain') ? document.getElementById('center-chain').textContent.trim().length : 0,
    bodyTextLen: document.body.textContent.trim().length,
  };
})())`;

async function probe(label) {
  const v = JSON.parse(await evalJS(PROBE));
  log(`[${label}]`, JSON.stringify(v, null, 1));
  return v;
}

function eventsOf(test) { return events.filter((e) => e.test === test); }

// ---------------- 服务与代理管理 ----------------
let serverProc = null;
function startServer() {
  serverProc = spawn('node', ['server.js'], { cwd: WEB, env: { ...process.env, PORT: '8090' }, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('server 启动超时')), 10000);
    serverProc.stdout.on('data', (d) => { if (String(d).includes('工作台')) { clearTimeout(t); res(); } });
    serverProc.stderr.on('data', (d) => log('[server-err]', String(d).slice(0, 200)));
  });
}
function stopServer() {
  if (serverProc) { try { execSync(`powershell -NoProfile -Command "Stop-Process -Id ${serverProc.pid} -Force"`); } catch {} serverProc = null; }
}

// 代理：static 透传到 8090；/api/* 按模式（delay 毫秒延迟 | dead 一律 502）
function startProxy(port, mode) {
  const src = `
    import { createServer } from 'node:http';
    const MODE = ${JSON.stringify(mode)}, PORT = ${port}, UP = 'http://127.0.0.1:8090';
    createServer(async (req, res) => {
      const url = new URL(req.url, 'http://x');
      if (url.pathname.startsWith('/api/')) {
        if (MODE.kind === 'dead') { res.writeHead(502, {'content-type':'application/json'}); res.end(JSON.stringify({error:'API 断开（测试注入）'})); return; }
        await new Promise(r => setTimeout(r, MODE.delay));
      }
      const chunks = []; for await (const c of req) chunks.push(c);
      const up = await fetch(UP + req.url, { method: req.method, headers: { ...req.headers, host: '127.0.0.1:8090' }, body: ['GET','HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
      const buf = Buffer.from(await up.arrayBuffer());
      const h = {}; up.headers.forEach((v, k) => { if (!['content-encoding','transfer-encoding','content-length'].includes(k)) h[k] = v; });
      res.writeHead(up.status, h); res.end(buf);
    }).listen(PORT, '127.0.0.1', () => console.log('proxy ' + PORT + ' ' + JSON.stringify(MODE)));
  `;
  const f = join(HERE, `tmp-g04-proxy-${port}.mjs`);
  writeFileSync(f, src);
  const p = spawn('node', [f], { stdio: 'ignore' });
  proxies.push(p);
  return (async () => { for (let i = 0; i < 30; i++) { try { await fetch(`http://127.0.0.1:${port}/`); return; } catch { await sleep(200); } } throw new Error('proxy ' + port + ' 未就绪'); })();
}
const proxies = [];
function stopProxies() { proxies.forEach((p) => { try { execSync(`powershell -NoProfile -Command "Stop-Process -Id ${p.pid} -Force"`); } catch {} }); }

// ---------------- 断言 ----------------
function assert(cond, msg) { if (!cond) throw new Error('断言失败: ' + msg); log('  ✓', msg); }
const hex = (rgb) => '#' + rgb.match(/\d+/g).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0').toUpperCase()).join('');
function assertG04Style(cs, label) {
  assert(cs.fontSize === '12px', `${label} fontSize=${cs.fontSize}（要求 12px）`);
  assert(cs.lineHeight === '18px', `${label} lineHeight=${cs.lineHeight}（要求 18px）`);
  assert(hex(cs.color) === '#E5B95E', `${label} color=${cs.color} = ${hex(cs.color)}（要求 #E5B95E）`);
  assert(hex(cs.backgroundColor) === '#3B3021', `${label} bg=${cs.backgroundColor} = ${hex(cs.backgroundColor)}（要求 #3B3021）`);
  assert(cs.paddingTop === '16px' && cs.paddingRight === '16px' && cs.paddingBottom === '16px' && cs.paddingLeft === '16px', `${label} padding=${cs.paddingTop}/${cs.paddingRight}/${cs.paddingBottom}/${cs.paddingLeft}（要求 16px）`);
}

// ---------------- 主流程 ----------------
try {
  section('启动 Chrome');
  await startChrome();
  await connect();
  log('Chrome + CDP 就绪');

  // 确保 8090 服务在跑
  let serverUp = false;
  try { serverUp = (await (await fetch(MAIN + '/api/office/flow', { signal: AbortSignal.timeout(3000) })).json()).tasks != null; } catch {}
  if (!serverUp) { log('8090 未运行，本脚本拉起'); await startServer(); await sleep(500); }
  else log('8090 已在运行（外部启动）');

  // ===== T1 正常启动 =====
  section('T1 正常服务启动');
  currentTest = 'T1';
  await navigate(MAIN + '/', 4500);
  const t1 = await probe('T1');
  const apiFlow = JSON.parse(await evalJS(`fetch('/api/office/flow').then(r=>r.json()).then(j=>JSON.stringify({n:j.tasks.length, ids:j.tasks.map(t=>t.id), steps:(j.tasks[0].steps||[]).map(s=>s.no+' '+s.name)}))`, true));
  log('[T1] API 侧:', JSON.stringify(apiFlow));
  assert(t1.trackNodes === 7, `七步流水线渲染 .track-node=${t1.trackNodes}（要求 7）`);
  assert(t1.reqsCountText === String(apiFlow.n), `页面需求数「${t1.reqsCountText}」与 API tasks=${apiFlow.n} 一致`);
  assert(t1.bannerHidden === true, `失败横幅隐藏（bannerHidden=${t1.bannerHidden}）`);
  assert(t1.uiErrors === 0, `__uiErrors=${t1.uiErrors}（要求 0）`);
  assert(eventsOf('T1').length === 0, `控制台无错误/未捕获异常（${eventsOf('T1').length} 条）`);
  assert(t1.sbConn.includes('已连接') || t1.sbConn !== '连接中…', `状态栏「${t1.sbConn}」已过连接阶段`);
  assert(t1.centerTextLen > 100, `中央区有真实内容（textLen=${t1.centerTextLen}）`);
  await shot('t1-normal');
  report.tests.push({ name: 'T1 正常启动', pass: true, detail: { trackNodes: t1.trackNodes, reqs: t1.reqsCountText, apiTasks: apiFlow.n, uiErrors: t1.uiErrors } });

  // ===== T2a 服务整个断开（页面已加载后 API 消失）=====
  section('T2a API 断开（服务进程被杀，页面保持已加载）');
  currentTest = 'T2a';
  const extManaged = serverProc == null;   // 服务是外部启动的，杀掉前记下来，最后要负责恢复
  stopServer(); if (extManaged) { try { execSync('powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8090 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"'); } catch {} }
  await sleep(5000);   // 等下一拍轮询失败 + 渲染
  const t2a = await probe('T2a');
  assert(t2a.bannerHidden === false, `断开后错误横幅挂出（hidden=${t2a.bannerHidden}）`);
  assert(/Failed to fetch|读取失败|失败|过期数据/.test(t2a.bannerText || ''), `横幅有明确失败文案：「${(t2a.bannerText || '').slice(0, 80)}」`);
  assert(t2a.sbConn === 'API 连接断开', `状态栏如实显示断开：「${t2a.sbConn}」`);
  assert(t2a.reqsCountText !== '0', `需求数不造假为 0（当前「${t2a.reqsCountText}」，保留上次真实数据）`);
  assert(t2a.centerTextLen > 100, `页面不空白（centerTextLen=${t2a.centerTextLen}，真实数据仍在展示）`);
  await shot('t2a-apidown');
  report.tests.push({ name: 'T2a API 断开(运行中)', pass: true, detail: { banner: (t2a.bannerText || '').slice(0, 100), reqsShown: t2a.reqsCountText } });

  // ===== T2b API 断开（首轮即失败，静态可达）=====
  section('T2b API 断开（首轮即 502，走 G04 失败态样式）');
  currentTest = 'T2b';
  await startServer();   // 静态与 API 同进程：恢复进程，再用 dead 代理模拟「页面能开、API 全挂」
  await sleep(500);
  await startProxy(8095, { kind: 'dead' });
  await navigate('http://127.0.0.1:8095/', 4500);
  const t2b = await probe('T2b');
  assert(t2b.bannerHidden === false && /boot-fail/.test(t2b.bannerClass || ''), `首轮失败挂 boot-fail 横幅（class="${t2b.bannerClass}"）`);
  assertG04Style(t2b.bannerCS, 'T2b 失败态');
  assert(t2b.uiErrors === 0, `__uiErrors=${t2b.uiErrors}（要求 0）`);
  assert(eventsOf('T2b').filter((e) => e.type === 'exception').length === 0, `无未捕获异常`);
  assert(t2b.centerTextLen >= 0 && t2b.bodyTextLen > 0, '页面非空白外壳（横幅 + 列表占位可见）');
  await shot('t2b-api-dead-bootfail');
  report.tests.push({ name: 'T2b API断开(首轮502)', pass: true, detail: { style: t2b.bannerCS } });

  // ===== T3 JS 模块异常（shared.js 404）=====
  section('T3 JS 模块异常（shared.js 临时改名 → 404）');
  currentTest = 'T3';
  const SHARED = join(WEB, 'shared.js'), HIDE = join(WEB, 'shared.js.g04-hidden');
  renameSync(SHARED, HIDE);
  try {
    await navigate(MAIN + '/', 2500);
    const t3 = await probe('T3');
    assert(t3.bannerHidden === false && /boot-fail/.test(t3.bannerClass || ''), `启动护栏挂 boot-fail 横幅（class="${t3.bannerClass}"）`);
    assert(/模块加载不完整/.test(t3.bannerText || ''), `护栏文案点名缺失模块：「${(t3.bannerText || '').slice(0, 90)}」`);
    assertG04Style(t3.bannerCS, 'T3 失败态');
    const exs = eventsOf('T3').filter((e) => e.type === 'exception');
    assert(exs.length >= 1 && exs.every((e) => /\[G04\]/.test(e.text)), `唯一未捕获异常是护栏主动中止（${exs.length} 条，均为 [G04] 标记）`);
    await shot('t3-module-missing');
    report.tests.push({ name: 'T3 JS模块异常', pass: true, detail: { banner: (t3.bannerText || '').slice(0, 100), uncaught: exs.length } });
  } finally {
    renameSync(HIDE, SHARED);   // 无论成败都先恢复文件
  }

  // ===== T4 API 延迟 > 8000ms =====
  section('T4 API 延迟 9.5s（8s 看门狗 + 迟到恢复）');
  currentTest = 'T4';
  await startProxy(8094, { kind: 'delay', delay: 9500 });
  await send('Page.navigate', { url: 'http://127.0.0.1:8094/' });
  await sleep(8300);   // 8s 看门狗应已触发
  const t4a = await probe('T4@8.3s');
  assert(t4a.bannerHidden === false && /boot-fail/.test(t4a.bannerClass || ''), `8s 后看门狗挂 boot-fail 横幅（class="${t4a.bannerClass}"）`);
  assert(/8000ms/.test(t4a.bannerText || ''), `横幅明说超时：「${(t4a.bannerText || '').slice(0, 90)}」`);
  assertG04Style(t4a.bannerCS, 'T4 失败态');
  await shot('t4-timeout-8s');
  await sleep(4500);   // 总计 ~12.8s：9.5s 延迟的 API 应已返回并渲染
  const t4b = await probe('T4@12.8s');
  assert(t4b.trackNodes === 7, `迟到数据到达后七步流水线恢复（trackNodes=${t4b.trackNodes}）`);
  assert(t4b.bannerHidden === true, `失败态自动让位（bannerHidden=${t4b.bannerHidden}）`);
  assert(t4b.uiErrors === 0, `__uiErrors=${t4b.uiErrors}（要求 0）`);
  assert(eventsOf('T4').filter((e) => e.type === 'exception').length === 0, `无未捕获异常`);
  await shot('t4-recovered');
  report.tests.push({ name: 'T4 API延迟>8s', pass: true, detail: { at8s: { visible: !t4a.bannerHidden, style: t4a.bannerCS }, at13s: { trackNodes: t4b.trackNodes, bannerHidden: t4b.bannerHidden } } });

  section('汇总');
  log(JSON.stringify(report.tests, null, 1));
  const allEvents = events.filter((e) => e.type === 'exception' || e.type === 'consoleError');
  log('\n控制台事件记录:', allEvents.length ? JSON.stringify(allEvents, null, 1) : '（无）');
  log('\n全部通过 ✅');
} catch (e) {
  log('\n❌ 失败:', e.message);
  process.exitCode = 1;
} finally {
  stopProxies();
  if (serverProc) stopServer();
  if (ws) { try { ws.close(); } catch {} }
  if (chromeProc) { try { execSync(`powershell -NoProfile -Command "Stop-Process -Id ${chromeProc.pid} -Force"`); } catch {} }
}
