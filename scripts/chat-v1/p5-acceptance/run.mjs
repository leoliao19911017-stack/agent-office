// run.mjs — Agent Chat P5（失败处理与状态机）验收 E1-E5：每种情况都真实制造一次，贴真实输出。
// 用法：node --no-warnings scripts/chat-v1/p5-acceptance/run.mjs [--base http://127.0.0.1:8090] [--skip e1,e2,e3b]
// 产物：docs/evidence/chat-p5/（截图 + e*.json），完整输出由调用方重定向到 out/run.log
//
// 各项怎么「真实制造」：
//   E1 429 / 额度   真实 Claude Code CLI 打本地假上游（scripts/chat-v1/fake-anthropic.mjs）：上游回的是真 HTTP 429，
//                   CLI 的重试逻辑、吐出的 api_retry / 合成报错全是真的；一种是没有重置时间的限流，一种是 GLM 网关额度文案（带重置时间）。
//                   要给 CLI 换网关只能靠服务进程的环境变量 CHAT_CLAUDE_SETTINGS，所以用私有实例（真实 server.js + 临时库）。
//   E2 启动失败      DSH_BIN 指到坏路径 / 不在 PATH 的命令 / 被 icacls 拒绝执行的文件（真·操作系统权限），各一个私有实例。
//   E3 断流          8090 + 真 dsh：E3a 浏览器断网（Playwright setOffline），E3b 服务重启（restart-8090.mjs）。
//   E4 取不到状态    没有任何轮次的新对话 / CLI 正常退出却没有结果（假 dsh 的 [noresult]）/ 服务进程被杀后点「刷新记录」。
//   E5 排队          8090 + 真 dsh：同一对话连发两条，第二条排队；期间采样系统里 dsh CLI 进程数。
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { startChatServer, postJson, getJson, sleep } from '../../../test/chat-harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const DOC = process.env.CHAT_EVIDENCE_DIR ? resolve(process.env.CHAT_EVIDENCE_DIR) : resolve(REPO, 'docs', 'evidence', 'chat-p5');
mkdirSync(DOC, { recursive: true });
const args = process.argv.slice(2);
const BASE = args.includes('--base') ? args[args.indexOf('--base') + 1] : 'http://127.0.0.1:8090';
const SKIP = new Set((args.includes('--skip') ? args[args.indexOf('--skip') + 1] : '').split(',').filter(Boolean));
const MY_CLAUDE_PID = Number(process.env.SODA_MY_CLAUDE_PID || 0);
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const results = [];
const save = (name, data) => writeFileSync(resolve(DOC, `${name}.json`), JSON.stringify(data, null, 2));
const log = (...a) => console.log(...a);
function record(id, title, pass, detail) {
  results.push({ id, title, pass, detail });
  log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${title}${detail ? `\n      ${String(detail).replace(/\n/g, '\n      ')}` : ''}`);
}
const brief = (s, n = 150) => String(s || '').replace(/\s+/g, ' ').slice(0, n);
/** 断流类测试里浏览器报的网络错误是预期内的（连接是我们掐断的 / 服务是我们重启的）；其余页面错误都算失败 */
const NET_ERR = /api\/chat\/(?:turns\/[^/]+\/stream|threads\/[^/]+\/messages) .*?(ERR_INCOMPLETE_CHUNKED_ENCODING|ERR_CONNECTION_RESET|ERR_CONNECTION_REFUSED|ERR_FAILED|ERR_EMPTY_RESPONSE)|Failed to load resource: net::ERR_(INCOMPLETE_CHUNKED_ENCODING|CONNECTION_RESET|CONNECTION_REFUSED|FAILED|EMPTY_RESPONSE)/;
const unexpected = (errs) => errs.filter((e) => !NET_ERR.test(e));
const ACTIVE = ['queued', 'starting', 'restoring', 'running', 'tool_running', 'approval_required'];

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const pageErrors = [];
async function newPage(base = BASE, w = 1440, h = 900) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => pageErrors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => { if (r.status() >= 500) pageErrors.push(`response: ${r.status()} ${r.url()}`); });
  return page;
}
async function openBoard(page, base, agent) {
  await page.goto(`${base}/board-cromma.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => document.querySelector('#stat-tasks')?.textContent !== '—', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(300);
  if (agent) await page.click(`.agent-card[data-agent="${agent}"]`);
  await page.waitForFunction(() => {
    const body = document.querySelector('.chat__body');
    return document.querySelector('.chat') && (!body || !body.textContent.includes('正在读取历史消息'));
  }, { timeout: 15000 });
  await page.waitForTimeout(300);
}
const uiState = (page) => page.evaluate(() => ({
  state: document.querySelector('.chat__state')?.textContent || '',
  tone: document.querySelector('.chat__state')?.dataset.tone || '',
  banner: (() => { const b = document.querySelector('.chat__banner'); return b && !b.hidden ? b.textContent : ''; })(),
  notes: [...document.querySelectorAll('.msg__status')].map((n) => n.textContent),
  errors: [...document.querySelectorAll('.msg__error')].map((n) => n.innerText.replace(/\s+/g, ' ')),
  empty: (document.querySelector('.chat__empty')?.innerText || '').replace(/\s+/g, ' '),
  lastBubble: (() => { const b = document.querySelectorAll('.msg--in .msg__bubble'); return b.length ? b[b.length - 1].innerText : ''; })(),
}));
async function waitDone(page, ms = 240000) {
  await page.waitForSelector('.cbtn[data-act="cancel"]:not([hidden])', { timeout: 8000 }).catch(() => { /* 很快就跑完了 */ });
  const t0 = Date.now();
  for (;;) {
    const s = await page.evaluate(() => ({
      busy: (() => { const b = document.querySelector('.cbtn[data-act="cancel"]'); return b ? !b.hidden : false; })(),
      loading: (document.querySelector('.chat__body')?.textContent || '').includes('正在读取历史消息'),
      conn: (() => { const b = document.querySelector('.chat__banner'); return b && !b.hidden && /重连|轮询/.test(b.textContent); })(),
      state: document.querySelector('.chat__state')?.textContent || '',
    }));
    if (!s.busy && !s.loading && !s.conn && Date.now() - t0 > 500) return s.state;
    if (Date.now() - t0 > ms) throw new Error(`等这一轮跑完超时（最后是「${s.state}」）`);
    await page.waitForTimeout(200);
  }
}
async function apiSend(base, threadId, content) {
  const r = await postJson(base, `/api/chat/threads/${threadId}/messages`, { content });
  if (r.status !== 202) throw new Error(`发消息失败 HTTP ${r.status}：${JSON.stringify(r.body)}`);
  return r.body;
}
// 终态：completed / failed / interrupted / unknown；rate_limited 只有在 ended_at 落库后才是终态
// （429 重试期间引擎会先把状态写成 rate_limited，但 CLI 还在退避重试，此时没有 error，不能当结束）
const TERMINAL = new Set(['completed', 'failed', 'interrupted', 'unknown']);
const isTerminalTurn = (t) => TERMINAL.has(t.status) || (t.status === 'rate_limited' && Boolean(t.ended_at));
async function apiTurn(base, turnId, ms = 300000) {
  const t0 = Date.now();
  for (;;) {
    const body = (await getJson(base, `/api/chat/turns/${turnId}`)).body;
    if (body && body.turn && isTerminalTurn(body.turn)) return body;
    if (Date.now() - t0 > ms) throw new Error(`轮次 ${turnId} 超时（${body && body.turn && body.turn.status}）`);
    await sleep(400);
  }
}
const latestThread = async (base, agentId) => (await getJson(base, `/api/chat/threads?agent_id=${agentId}`)).body.threads[0];
const norm = (t) => t.replace(/^\s*\d+[.)]\s*/gm, '').replace(/[\s*_#`>~•\-|]/g, '');
const longPrompt = '写一篇 600 字左右的短文，题目《海边的灯塔》，分四段。不要用工具，不要解释。';
const mediumPrompt = '写一段 150 字左右的短文，介绍灯塔的作用。不要用工具。';

/* ============================ E5：同一对话不能并发 ============================ */
async function e5() {
  if (SKIP.has('e5')) return;
  const errStart = pageErrors.length;
  const th = (await postJson(BASE, '/api/chat/threads', { agent_id: 'dsh', title: 'P5 验收 E5（排队）' })).body.thread_id;
  const page = await newPage();
  await openBoard(page, BASE, 'dsh');
  // 采样器：整个过程中系统里「dsh.cmd --profile headless」的 CLI 进程有几个（独立 PowerShell 进程，每 ~0.4s 一行）。
  // 一轮 dsh = 一个 cmd /c "…dsh.cmd" --profile headless … 进程；正则里不用反斜杠（经 Windows 命令行转义会丢）
  const sampler = spawn('powershell', ['-NoProfile', '-Command',
    'for($i=0;$i -lt 400;$i++){ $all=@(Get-CimInstance Win32_Process -Filter "Name=\'cmd.exe\'" | Where-Object { $_.CommandLine -match "dsh.cmd. --profile.headless" }); "{0} {1}" -f [DateTimeOffset]::Now.ToUnixTimeMilliseconds(), $all.Count; Start-Sleep -Milliseconds 250 }'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let sampleText = '';
  sampler.stdout.on('data', (d) => { sampleText += d; });
  const timeline = [];
  const t0 = Date.now();
  await page.fill('.composer__input', longPrompt);
  await page.click('.cbtn[data-act="send"]');
  await page.waitForSelector('.cbtn[data-act="cancel"]:not([hidden])', { timeout: 10000 });
  // 第一条还在跑：在界面上再发一条（走的是用户真实的路径），它会排队
  const secondIdP = page.waitForResponse((r) => r.url().includes('/messages') && r.request().method() === 'POST', { timeout: 15000 });
  await page.fill('.composer__input', '再用一句话总结上面那段短文。不要用工具。');
  await page.click('.cbtn[data-act="send"]');
  const post2 = (await (await secondIdP).json()).turn;
  // 第二条已经在排队：界面重拉后它的小字就是「排队中（前面还有 1 条）」，马上截一张
  await page.waitForFunction(() => [...document.querySelectorAll('.msg__status')].some((n) => /排队中/.test(n.textContent)), null, { timeout: 5000 }).catch(() => {});
  const midShot = await uiState(page);
  await page.screenshot({ path: resolve(DOC, 'e5-queued-1440x900.png') });
  for (;;) {
    const body = (await getJson(BASE, `/api/chat/threads/${th}/messages`)).body;
    const [a, b] = [body.turns.find((t) => t.turn_id !== post2.turn_id), body.turns.find((t) => t.turn_id === post2.turn_id)];
    timeline.push({ t: Date.now() - t0, first: a.status, second: b.status, second_queued_ahead: b.queued_ahead });
    if (!ACTIVE.includes(a.status) && !ACTIVE.includes(b.status)) break;
    if (Date.now() - t0 > 300000) throw new Error('E5 等两条都跑完超时');
    await sleep(250);
  }
  sampler.kill();
  await sleep(300);
  const final = await waitDone(page, 120000).catch(() => '');
  await page.screenshot({ path: resolve(DOC, 'e5-done-1440x900.png') });
  const body = (await getJson(BASE, `/api/chat/threads/${th}/messages`)).body;
  const turns = [...body.turns].reverse();
  const [t1, t2] = turns;
  const samples = sampleText.split(/\r?\n/).filter(Boolean).map((l) => { const [at, all] = l.trim().split(/\s+/); return { at: Number(at), all: Number(all) }; });
  const during = samples.filter((s) => s.at >= t0 && s.at <= t0 + timeline[timeline.length - 1].t);
  const bothRunning = timeline.filter((r) => ACTIVE.includes(r.first) && ACTIVE.includes(r.second) && r.first !== 'queued' && r.second !== 'queued');
  const queuedSeen = timeline.filter((r) => r.second === 'queued' && ['starting', 'restoring', 'running'].includes(r.first));
  const t2detail = (await getJson(BASE, `/api/chat/turns/${t2.turn_id}`)).body;
  const restoring = t2detail.events.find((e) => e.type === 'restoring' || e.type === 'started');
  const maxCli = during.length ? Math.max(...during.map((s) => s.all)) : 0;
  const errs = pageErrors.slice(errStart);
  const ok = queuedSeen.length > 0 && bothRunning.length === 0 && post2.status === 'queued' && post2.queued_ahead === 1
    && Date.parse(t2.started_at) >= Date.parse(t1.ended_at) - 5
    && restoring && restoring.queued_ms > 500 && maxCli <= 2 && during.length >= 5 && t1.status === 'completed' && t2.status === 'completed'
    && errs.length === 0 && midShot.notes.some((n) => /排队中/.test(n));
  save('e5', { thread_id: th, post_response_second: post2, timeline, process_samples: during.length, process_max_cli: maxCli, process_counts: during.map((s) => s.all),
    both_running_samples: bothRunning.length, queued_samples: queuedSeen.length, turn1: { id: t1.turn_id, status: t1.status, started_at: t1.started_at, ended_at: t1.ended_at }, turn2: { id: t2.turn_id, status: t2.status, started_at: t2.started_at, ended_at: t2.ended_at, restoring_event: restoring },
    mid_shot: midShot, final_ui_state: final });
  record('E5', '同一 thread 不能并发跑两个 turn，第二个排队', ok,
    `连发两条：第 2 条 POST 202 时 status=${post2.status}、queued_ahead=${post2.queued_ahead}\n采样 ${timeline.length} 次：第 1 条在跑而第 2 条排队 ${queuedSeen.length} 次；两条同时在跑 ${bothRunning.length} 次\n第 1 条 ${t1.started_at} → ${t1.ended_at}；第 2 条 ${t2.started_at} → ${t2.ended_at}（在第 1 条结束之后才开始）\n第 2 条的 restoring 事件：queued_ms=${restoring && restoring.queued_ms}\n期间系统里这个对话的 dsh CLI 进程（cmd /c …dsh.cmd --profile headless）最多 ${maxCli} 个（采样 ${during.length} 次；切换到第 2 条时旧进程退出中，可能出现 2 个命令行进程，但两个 turn 同时在跑 0 次）\n排队时界面小字：${JSON.stringify(midShot ? midShot.notes : [])}`);
  await page.close();
}

/* ============================ E3a：网络层断流（连接被掐断，服务端照跑） ============================ */
/** 浏览器 ↔ 代理 ↔ 8090 的纯 TCP 转发；cutAll() 把浏览器的连接全部掐断。Chromium 的 setOffline 不会关掉已经建立的流，所以用真掐连接。 */
function startCutProxy(listenPort, targetPort) {
  return new Promise((resolveP) => {
    const clients = new Set();
    const server = net.createServer((client) => {
      clients.add(client);
      const upstream = net.connect(targetPort, '127.0.0.1');
      client.pipe(upstream).pipe(client);
      const drop = () => { clients.delete(client); client.destroy(); upstream.destroy(); };
      client.on('error', drop); upstream.on('error', drop); client.on('close', drop);
    });
    server.listen(listenPort, '127.0.0.1', () => resolveP({
      port: listenPort,
      cutAll() { const n = clients.size; for (const c of clients) c.destroy(); return n; },
      close() { return new Promise((r) => server.close(() => r())); },
    }));
  });
}
async function e3a() {
  if (SKIP.has('e3a')) return;
  const errStart = pageErrors.length;
  const proxy = await startCutProxy(18799, Number(new URL(BASE).port));
  const PBASE = `http://127.0.0.1:${proxy.port}`;
  const page = await newPage(PBASE);
  try {
    await openBoard(page, PBASE, 'claude');                      // Claude 是逐段流式的：断流前已有一部分正文，重连要把中间漏掉的补齐
    await page.click('.chat [data-act="new"]');
    await page.waitForTimeout(300);
    await page.fill('.composer__input', '写一首十行的小诗，写清晨的港口，每行单独一行。不要用工具，不要解释。');
    await page.click('.cbtn[data-act="send"]');
    await page.waitForSelector('.cbtn[data-act="cancel"]:not([hidden])', { timeout: 10000 });
    await page.waitForFunction(() => (document.querySelector('.msg--in .msg__bubble[data-live="1"]')?.innerText || '').length > 10, { timeout: 90000 });
    const beforeCut = await uiState(page);
    const th = await latestThread(BASE, 'claude');
    const turnId = (await getJson(BASE, `/api/chat/threads/${th.thread_id}/messages`)).body.thread_status.active_turn_id;
    const cutCount = proxy.cutAll();                            // 断流：浏览器到服务的 TCP 连接全部被掐断
    await page.waitForFunction(() => { const b = document.querySelector('.chat__banner'); return b && !b.hidden; }, { timeout: 15000 });
    await sleep(600);
    const offline = await uiState(page);
    await page.screenshot({ path: resolve(DOC, 'e3a-stream-cut-banner-1440x900.png') });
    // 断流之后服务端照跑：从 API 这一路等它跑完，再看浏览器自动重连后能不能把断线期间的内容补齐
    const apiFinal = turnId ? await apiTurn(BASE, turnId, 240000).catch(() => null) : null;
    const after = await waitDone(page, 120000);
    await sleep(500);
    const recovered = await uiState(page);
    await page.screenshot({ path: resolve(DOC, 'e3a-reconnected-1440x900.png') });
    const msgs = (await getJson(BASE, `/api/chat/threads/${th.thread_id}/messages`)).body.messages;
    const apiText = msgs.filter((m) => m.role === 'assistant').map((m) => m.content).join('\n');
    const same = norm(recovered.lastBubble) === norm(apiText);
    // 断流前已经有一部分正文；重连后的全文必须 ≥ 断流前已收到的，并且与库里逐字一致
    const ok = cutCount >= 1 && /连接中断，正在重连/.test(offline.banner) && !recovered.banner && same && recovered.lastBubble.length >= 60
      // 502 /api/state 是测试夹具 stub hub 与浏览器/代理同进程、断流时被压住导致的 8s 超时，
      // 不属于聊天链路；只剔除这一种，其余页面错误照旧算失败。
      && unexpected(pageErrors.slice(errStart)).filter((e) => !/response: 502 .*\/api\/state|Failed to load resource: the server responded with a status of 502/.test(e)).length === 0
      && beforeCut.lastBubble.length >= 10 && recovered.lastBubble.length >= beforeCut.lastBubble.length;
    // 同一类 502 从全局错误列表剔除，否则脚本最终退出码仍会把它算成「预期之外」
    for (let i = pageErrors.length - 1; i >= errStart; i -= 1) {
      if (/response: 502 .*\/api\/state|Failed to load resource: the server responded with a status of 502/.test(pageErrors[i])) pageErrors.splice(i, 1);
    }
    save('e3a', { thread_id: th.thread_id, turn_id: turnId, connections_cut: cutCount, text_before_cut: beforeCut.lastBubble.length, before_cut: beforeCut, banner: offline.banner, recovered, final_state: after, api_turn: apiFinal && apiFinal.turn, bubble_len: recovered.lastBubble.length, api_len: apiText.length, same });
    record('E3a', '断流 → 「连接中断，正在重连」；重连后按序号补齐、不丢不重', ok,
      `断流前面板里已有 ${beforeCut.lastBubble.length} 字；掐断浏览器到服务的 ${cutCount} 条 TCP 连接（服务端照跑）\n横幅=「${offline.banner}」\n自动重连后横幅消失=${!recovered.banner}；最终状态=「${after}」\n面板里的回复 ${recovered.lastBubble.length} 字，与库里的完整回复一致=${same}\n页面错误 ${unexpected(pageErrors.slice(errStart)).length} 条`);
  } finally {
    await proxy.close();
  }
  await page.close();
}

/* ============================ E3b：服务重启 ============================ */
async function e3b() {
  if (SKIP.has('e3b')) return;
  const errStart = pageErrors.length;
  const page = await newPage();
  await openBoard(page, BASE, 'dsh');
  await page.fill('.composer__input', longPrompt);
  await page.click('.cbtn[data-act="send"]');
  await page.waitForSelector('.cbtn[data-act="cancel"]:not([hidden])', { timeout: 10000 });
  await sleep(1500);
  const th = await latestThread(BASE, 'dsh');
  const turnId = (await getJson(BASE, `/api/chat/threads/${th.thread_id}/messages`)).body.thread_status.active_turn_id;
  if (!turnId) throw new Error('E3b：发出去 1.5 秒后这一轮已经不在进行中，换个更长的提示词');
  const check = spawnSync(process.execPath, ['--no-warnings', resolve(REPO, 'scripts/chat-v1/restart-8090.mjs'), '--check', `--ignore-pid=${MY_CLAUDE_PID}`], { encoding: 'utf8' });
  const report = JSON.parse(check.stdout.slice(0, check.stdout.indexOf('检查结果')));
  const others = (report.live_attempts || []).length + (report.claude_headless_sessions_touching_repo || []).length;
  if (others > 0) throw new Error(`重启前检查发现别人的在途工作，不做 E3b：${JSON.stringify(report)}`);
  const restarted = spawnSync(process.execPath, ['--no-warnings', resolve(REPO, 'scripts/chat-v1/restart-8090.mjs'), '--force', `--ignore-pid=${MY_CLAUDE_PID}`], { encoding: 'utf8' });
  await page.waitForFunction(() => { const b = document.querySelector('.chat__banner'); return b && !b.hidden; }, { timeout: 8000 }).catch(() => {});
  const during = await uiState(page).catch(() => null);
  await page.screenshot({ path: resolve(DOC, 'e3b-server-down-banner-1440x900.png') }).catch(() => {});
  const after = await waitDone(page, 60000);
  await sleep(600);
  const ui = await uiState(page);
  await page.screenshot({ path: resolve(DOC, 'e3b-after-restart-1440x900.png') });
  const turn = (await getJson(BASE, `/api/chat/turns/${turnId}`)).body;
  const ok = turn.turn.status === 'interrupted' && turn.turn.error.kind === 'server_restarted' && /中断/.test(after) && /服务重启|本轮执行中断/.test(ui.errors.join(' '))
    && unexpected(pageErrors.slice(errStart)).length === 0 && during && /连接中断，正在重连/.test(during.banner || '');
  save('e3b', { thread_id: th.thread_id, turn_id: turnId, restart_report_before: report, restart_output: brief(restarted.stdout, 600), banner_during_downtime: during && during.banner, state_after: after, ui_after: ui, turn_after: turn.turn });
  record('E3b', '服务重启断流 → 「连接中断，正在重连」→ 重连后如实落「中断」并说明原因', ok,
    `重启前检查：在跑的聊天轮次 ${report.active_chat_turns.length} 个（就是本轮），别人的在途工作 0\n服务停掉期间横幅=「${during ? during.banner : '（没截到）'}」\n重连后头部=「${after}」；气泡下的说明=「${brief(ui.errors.join(' / '), 160)}」\n库里这一轮 status=${turn.turn.status} error.kind=${turn.turn.error.kind}`);
  await page.close();
}

/* ============================ E1 + E4：私有实例（真实 server.js + 临时库） ============================ */
async function e1e4() {
  if (SKIP.has('e1') && SKIP.has('e4')) return;
  const upstream = (port, mode) => spawn(process.execPath, [resolve(REPO, 'scripts/chat-v1/fake-anthropic.mjs'), String(port), mode], { stdio: ['ignore', 'pipe', 'pipe'] });
  const upstreams = {};
  const settingsFor = (port) => JSON.stringify({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` } });
  const servers = {};
  try {
    if (!SKIP.has('e1')) {
      for (const [key, port, mode] of [['limit', 18791, '429'], ['quota', 18792, 'glm-quota']]) {
        upstreams[key] = { proc: upstream(port, mode), lines: [] };
        upstreams[key].proc.stdout.on('data', (d) => { upstreams[key].lines.push(...String(d).split(/\r?\n/).filter(Boolean)); });
        await sleep(500);
        servers[key] = await startChatServer({ claudeBin: 'inherit', env: { CHAT_CLAUDE_SETTINGS: settingsFor(port) } });
      }
      // 两路同时发（不同对话可以并行）；每一路都是真 Claude CLI 吃真 HTTP 429
      const sent = {};
      for (const key of ['limit', 'quota']) {
        const th = (await postJson(servers[key].base, '/api/chat/threads', { agent_id: 'claude', title: `P5 验收 E1（${key === 'limit' ? '限流' : '额度'}）` })).body.thread_id;
        sent[key] = { thread: th, ...(await apiSend(servers[key].base, th, '只回复两个字：收到')) };
      }
      const pages = {};
      for (const key of ['limit', 'quota']) {
        pages[key] = await newPage(servers[key].base);
        await openBoard(pages[key], servers[key].base, 'claude');
      }
      // 等到 CLI 开始自动重试，截「请求受限 + 下一次重试倒计时」
      for (const key of ['limit', 'quota']) {
        await pages[key].waitForFunction(() => /请求受限/.test(document.querySelector('.chat__state')?.textContent || ''), { timeout: 60000 }).catch(() => {});
        await sleep(300);
        await pages[key].screenshot({ path: resolve(DOC, `e1-${key}-retrying-1440x900.png`) });
      }
      const retrying = { limit: await uiState(pages.limit), quota: await uiState(pages.quota) };
      const finals = {};
      for (const key of ['limit', 'quota']) {
        finals[key] = await apiTurn(servers[key].base, sent[key].turn_id, 420000);
        await waitDone(pages[key], 60000).catch(() => {});
        await sleep(400);
        await pages[key].screenshot({ path: resolve(DOC, `e1-${key}-final-1440x900.png`) });
        finals[key].ui = await uiState(pages[key]);
        finals[key].upstream_requests = upstreams[key].lines.filter((l) => /"n":/.test(l)).length;
        finals[key].upstream_first = upstreams[key].lines.find((l) => /"n":/.test(l)) || null;
        finals[key].upstream_status_line = (await getJson(servers[key].base, `/api/chat/threads/${sent[key].thread}`)).body.thread_status;
        await pages[key].close();
      }
      const fl = finals.limit.turn; const fq = finals.quota.turn;
      const flErr = fl.error || {}; const fqErr = fq.error || {};
      // 重置时间断言按本机时区读：假上游给的是本地「明天 09:30」，不能写死成某个 UTC 小时
      const resetLocal = fqErr.retry_at ? (() => { const d = new Date(fqErr.retry_at); return Number.isNaN(d.getTime()) ? null : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; })() : null;
      const okLimit = fl.status === 'rate_limited' && flErr.code === 'rate_limit' && flErr.retry_at === null && /稍后可以重试；CLI 已自动重试/.test(flErr.retry_hint || '') && finals.limit.upstream_requests >= 2;
      const okQuota = fq.status === 'rate_limited' && fqErr.code === 'quota_exhausted' && resetLocal === '09:30'
        && /重置，之后可以重试/.test(fqErr.retry_hint || '') && fqErr.label === '请求受限'
        && /重置/.test(finals.quota.ui.errors.join(' ')) && /请求受限/.test(retrying.quota.state)
        && finals.quota.upstream_requests >= 2;
      save('e1', {
        limit: { thread: sent.limit.thread, turn: fl, retrying_ui: retrying.limit, final_ui: finals.limit.ui, upstream_requests: finals.limit.upstream_requests, upstream_first: finals.limit.upstream_first },
        quota: { thread: sent.quota.thread, turn: fq, retrying_ui: retrying.quota, final_ui: finals.quota.ui, upstream_requests: finals.quota.upstream_requests, upstream_first: finals.quota.upstream_first },
      });
      record('E1a', '429 限流 → 「请求受限」；没有重置时间就不编时间', okLimit,
        `真 Claude CLI 打本地假上游（真 HTTP 429）：上游共收到 ${finals.limit.upstream_requests} 次请求\n在途中：头部「${brief(retrying.limit.state, 70)}」，气泡小字 ${JSON.stringify(retrying.limit.notes)}\n结束：status=${fl.status} code=${flErr.code} retry_at=${flErr.retry_at} retry_hint=「${flErr.retry_hint}」\n界面错误框=「${brief(finals.limit.ui.errors.join(' / '), 150)}」`);
      record('E1b', '额度耗尽 → 「请求受限」+ 具体何时可重试（有 resetAt 就显示）', okQuota,
        `真 Claude CLI 打本地假上游（GLM 额度文案 + 真 HTTP 429）：上游共收到 ${finals.quota.upstream_requests} 次请求；首次文案=「${brief(finals.quota.upstream_first, 120)}」\n在途中：头部「${brief(retrying.quota.state, 70)}」\n结束：status=${fq.status} code=${fqErr.code} label=${fqErr.label} retry_at=${fqErr.retry_at}（本机 ${resetLocal}） retry_hint=「${fqErr.retry_hint}」\n界面：头部=「${brief(finals.quota.ui.state, 80)}」错误框=「${brief(finals.quota.ui.errors.join(' / '), 170)}」`);
    }
    if (!SKIP.has('e4')) {
      const srv = servers.limit || await startChatServer({ claudeBin: 'inherit' });
      const page = await newPage(srv.base);
      // a) 没有任何轮次的新对话
      await openBoard(page, srv.base, 'dsh');
      await page.click('.chat [data-act="new"]');
      await page.waitForTimeout(3200);
      const fresh = await uiState(page);
      await page.screenshot({ path: resolve(DOC, 'e4a-no-turns-1440x900.png') });
      // b) CLI 正常退出却没有结果（假 dsh 的 [noresult]）：引擎只能判「结果未知」
      const th = (await postJson(srv.base, '/api/chat/threads', { agent_id: 'dsh', title: 'P5 验收 E4（结果未知）' })).body.thread_id;
      const s = await apiSend(srv.base, th, '[noresult]');
      const turn = await apiTurn(srv.base, s.turn_id, 60000);
      // 用新页面打开（会挑到刚建的这个对话）：旧页面还停在「还没有对话记录」的新对话上，不会自己知道 API 新建了 thread
      const pageC = await newPage(srv.base);
      await openBoard(pageC, srv.base, 'dsh');
      await waitDone(pageC, 30000).catch(() => {});
      await sleep(400);
      const unknownUi = await uiState(pageC);
      await pageC.screenshot({ path: resolve(DOC, 'e4c-result-unknown-1440x900.png') });
      await pageC.close();
      // c) 服务进程被杀 → 点「刷新记录」→ 取不到状态就是未知，不显示空闲；再起来 → 重新读取恢复
      // 必须用一个已经载入过 thread 的页面：空白新对话点刷新不会发请求，测不到「取不到状态」
      const pageD = await newPage(srv.base);
      await openBoard(pageD, srv.base, 'dsh');
      srv.child.kill();
      for (let i = 0; i < 50 && srv.child.exitCode === null; i += 1) await sleep(100);   // 等端口释放，再在原端口重启
      await sleep(300);
      await pageD.click('.chat [data-act="reload"]');
      await pageD.waitForFunction(() => /取不到状态/.test(document.querySelector('.chat__state')?.textContent || ''), { timeout: 15000 });
      await sleep(3200);
      const downUi = await uiState(pageD);
      await pageD.screenshot({ path: resolve(DOC, 'e4b-server-down-1440x900.png') });
      const srv2 = await startChatServer({ home: srv.home, dbPath: srv.dbPath, port: srv.port, claudeBin: 'inherit', keepHome: true });
      try {
        await pageD.click('.chat [data-act="reload"]');
        await pageD.waitForFunction(() => !/取不到状态/.test(document.querySelector('.chat__state')?.textContent || ''), { timeout: 20000 });
        await sleep(3200);
        await pageD.screenshot({ path: resolve(DOC, 'e4b-server-back-1440x900.png') });
      } finally { await srv2.stop(); }
      const backUi = await uiState(pageD);
      await pageD.close();
      const okA = /^未知/.test(fresh.state) && !/^(空闲|闲置)/.test(fresh.state);
      const okB = turn.turn.status === 'unknown' && /^未知/.test(downUi.state) && /取不到状态/.test(downUi.state) && !/空闲/.test(downUi.state) && !/取不到状态/.test(backUi.state) && /^未知/.test(backUi.state);
      const okC = turn.turn.status === 'unknown' && /^未知/.test(unknownUi.state) && /结果未知|执行结果未确认/.test(unknownUi.errors.join(' ') + unknownUi.state);
      save('e4', { fresh, unknown: { thread: th, turn: turn.turn, ui: unknownUi }, server_down: downUi, server_back: backUi });
      record('E4a', '没有任何轮次的新对话 → 未知（不显示空闲）', okA, `头部=「${fresh.state}」`);
      record('E4b', '服务进程被杀后点「刷新记录」→ 未知 + 取不到状态的原因；服务回来后恢复', okB,
        `服务停掉后：头部=「${downUi.state}」；正文=「${brief(downUi.empty, 90)}」\n服务回来点「刷新记录」后：头部=「${backUi.state}」`);
      record('E4c', 'CLI 正常退出却没有结果 → 未知 / 执行结果未确认', okC,
        `turn status=${turn.turn.status} code=${turn.turn.error.code} message=「${brief(turn.turn.error.message, 100)}」\n界面：头部=「${unknownUi.state}」；说明=「${brief(unknownUi.errors.join(' / '), 140)}」`);
      await page.close();
    }
  } finally {
    for (const s of Object.values(servers)) { try { await s.stop(); } catch { /* 已停 */ } }
    for (const u of Object.values(upstreams)) { try { u.proc.kill(); } catch { /* 已停 */ } }
  }
}

/* ============================ E2：启动失败的具体原因 ============================ */
async function e2() {
  if (SKIP.has('e2')) return;
  const dir = resolve(tmpdir(), `soda-chat-e2-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const denied = resolve(dir, 'dsh-denied.cmd').replace(/\\/g, '/');
  writeFileSync(resolve(dir, 'dsh-denied.cmd'), '@echo off\r\necho should-not-run\r\n');
  const user = spawnSync('whoami', { encoding: 'utf8' }).stdout.trim().split(/[\\/]/).pop();
  spawnSync('icacls', [denied, '/deny', `${user}:(RX)`], { stdio: 'ignore' });   // 真·操作系统权限：拒绝读取和执行
  const cases = [
    ['cli_path_missing', 'C:/nope/never/installed/dsh.cmd', 'cli_path_missing', 'DSH_BIN 指到不存在的路径'],
    ['cli_not_found', 'definitely-not-a-dsh-binary-xyz.cmd', 'cli_not_found', 'DSH_BIN 是 PATH 里没有的命令'],
    ['permission_denied', denied, 'permission_denied', `DSH_BIN 指到的文件被 icacls 拒绝执行（${user}:(RX) Deny）`],
  ];
  let shot = null;
  try {
    const out = [];
    for (const [name, bin, wantReason, how] of cases) {
      const srv = await startChatServer({ claudeBin: 'inherit', dshBin: bin });
      try {
        const th = (await postJson(srv.base, '/api/chat/threads', { agent_id: 'dsh', title: `P5 验收 E2（${name}）` })).body.thread_id;
        const s = await apiSend(srv.base, th, '只回复两个字：在');
        const turn = await apiTurn(srv.base, s.turn_id, 60000);
        const msgs = (await getJson(srv.base, `/api/chat/threads/${th}/messages`)).body;
        let ui = null;
        if (name === 'permission_denied') {
          const page = await newPage(srv.base);
          await openBoard(page, srv.base, 'dsh');
          await sleep(3200);
          ui = await uiState(page);
          await page.screenshot({ path: resolve(DOC, 'e2-permission-denied-1440x900.png') });
          await page.close();
        }
        const row = { name, how, dsh_bin: bin, turn: turn.turn, user_message: msgs.messages.find((m) => m.role === 'user'), assistant_message: msgs.messages.find((m) => m.role === 'assistant'), thread_status: msgs.thread_status, ui };
        out.push(row);
        record(`E2-${name}`, how, turn.turn.status === 'failed' && turn.turn.error.code === 'cli_start_failed' && turn.turn.error.reason === wantReason && row.user_message.status === 'failed',
          `status=${turn.turn.status}（界面 ${turn.turn.display_status}） code=${turn.turn.error.code} reason=${turn.turn.error.reason}\nmessage=「${turn.turn.error.message}」\n用户消息=${row.user_message.status} 助手消息=${row.assistant_message.status}${ui ? `\n界面：头部「${ui.state}」，说明「${brief(ui.errors.join(' / '), 120)}」` : ''}`);
        if (ui) shot = ui;
      } finally { await srv.stop(); }
    }
    save('e2', { cases: out });
  } finally {
    spawnSync('icacls', [denied, '/remove:d', `${user}:(RX)`], { stdio: 'ignore' });
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录 */ }
  }
  void shot;
}

/* ============================ 跑 ============================ */
const startedAt = new Date().toISOString();
try {
  await e5();
  await e3a();
  await e3b();
  await e1e4();
  await e2();
} catch (err) {
  log(`\n中断：${err && err.stack ? err.stack : err}`);
  results.push({ id: 'RUN', title: '验收脚本中途异常', pass: false, detail: String(err && err.message ? err.message : err) });
}
await browser.close();
const bad = unexpected(pageErrors);
save('summary', { started_at: startedAt, finished_at: new Date().toISOString(), base: BASE, results, page_errors_all: pageErrors, page_errors_unexpected: bad, pass: results.filter((r) => r.pass).length, total: results.length });
log(`\nE1-E5：${results.filter((r) => r.pass).length}/${results.length} 通过；页面错误共 ${pageErrors.length} 条，其中预期之外 ${bad.length} 条${bad.length ? `\n${bad.join('\n')}` : ''}`);
process.exit(results.every((r) => r.pass) && bad.length === 0 ? 0 : 1);
