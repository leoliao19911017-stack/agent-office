// run.mjs — Agent Chat P6（hermes adapter）验收 F1-F2：真 hermes、真服务、真浏览器。
// 用法：node --no-warnings scripts/chat-v1/p6-acceptance/run.mjs
// 产物：docs/evidence/chat-p6/（F1/F2 的 json + 截图），完整输出由调用方重定向到 out/run.log
//
// F1  hermes 能非交互对话：建 thread → 发一句 → 拿到真实回复；session_id 入库；
//     事件有 started → delta → completed（不是等全部结束才一次性出现）
// F2  能续聊：在同一个 thread 里问第 1 句说过的数字（走界面发），答对 42；
//     第二轮 --resume 上一轮的 session_id，provider_session_id 不变、turn.resume=1、事件是 restoring
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startChatServer, postJson, getJson, sleep } from '../../../test/chat-harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const DOC = resolve(REPO, 'docs', 'evidence', 'chat-p6');
mkdirSync(DOC, { recursive: true });
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const results = [];
const log = (...a) => console.log(...a);
const save = (name, data) => writeFileSync(resolve(DOC, `${name}.json`), JSON.stringify(data, null, 2));
const brief = (s, n = 180) => String(s || '').replace(/\s+/g, ' ').slice(0, n);
function record(id, title, pass, detail) {
  results.push({ id, title, pass, detail });
  log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${title}${detail ? `\n      ${String(detail).replace(/\n/g, '\n      ')}` : ''}`);
}
const ACTIVE = ['queued', 'starting', 'restoring', 'running', 'tool_running', 'approval_required'];
const TERMINAL = new Set(['completed', 'failed', 'interrupted', 'unknown']);
const isTerminalTurn = (t) => TERMINAL.has(t.status) || (t.status === 'rate_limited' && Boolean(t.ended_at));
async function apiTurn(base, turnId, ms = 180000) {
  const t0 = Date.now();
  for (;;) {
    const body = (await getJson(base, `/api/chat/turns/${turnId}`)).body;
    if (body && body.turn && isTerminalTurn(body.turn)) return body;
    if (Date.now() - t0 > ms) throw new Error(`轮次 ${turnId} 超时（${body && body.turn && body.turn.status}）`);
    await sleep(300);
  }
}
const latestThread = async (base, agentId) => (await getJson(base, `/api/chat/threads?agent_id=${agentId}`)).body.threads[0];
const norm = (t) => t.replace(/[\s*_#`>~•\-|]/g, '');

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const pageErrors = [];
async function newPage(base) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => pageErrors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
  return page;
}
async function openBoard(page, base, agent) {
  await page.goto(`${base}/board-cromma.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => document.querySelector('#stat-tasks')?.textContent !== '—', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(300);
  await page.click(`.agent-card[data-agent="${agent}"]`);
  await page.waitForFunction(() => {
    const body = document.querySelector('.chat__body');
    return document.querySelector('.chat') && (!body || !body.textContent.includes('正在读取历史消息'));
  }, { timeout: 30000 });
  await page.waitForTimeout(500);
}
const uiState = (page) => page.evaluate(() => ({
  state: document.querySelector('.chat__state')?.textContent || '',
  banner: (() => { const b = document.querySelector('.chat__banner'); return b && !b.hidden ? b.textContent : ''; })(),
  notes: [...document.querySelectorAll('.msg__status')].map((n) => n.textContent),
  errors: [...document.querySelectorAll('.msg__error')].map((n) => n.innerText.replace(/\s+/g, ' ')),
  empty: (document.querySelector('.chat__empty')?.innerText || '').replace(/\s+/g, ' '),
  composerVisible: Boolean(document.querySelector('.composer__input')),
  lastBubble: (() => { const b = document.querySelectorAll('.msg--in .msg__bubble'); return b.length ? b[b.length - 1].innerText : ''; })(),
  outgoing: (() => { const b = document.querySelectorAll('.msg--out .msg__bubble'); return b.length ? b[b.length - 1].innerText : ''; })(),
  msgCount: document.querySelectorAll('.msg').length,
}));
async function waitDone(page, ms = 180000) {
  await page.waitForSelector('.cbtn[data-act="cancel"]:not([hidden])', { timeout: 10000 }).catch(() => {});
  const t0 = Date.now();
  for (;;) {
    const s = await page.evaluate(() => ({
      busy: (() => { const b = document.querySelector('.cbtn[data-act="cancel"]'); return b ? !b.hidden : false; })(),
      loading: (document.querySelector('.chat__body')?.textContent || '').includes('正在读取历史消息'),
      conn: (() => { const b = document.querySelector('.chat__banner'); return b && !b.hidden && /重连|轮询/.test(b.textContent); })(),
      state: document.querySelector('.chat__state')?.textContent || '',
    }));
    if (!s.busy && !s.loading && !s.conn && Date.now() - t0 > 600) return s.state;
    if (Date.now() - t0 > ms) throw new Error(`等这一轮跑完超时（最后是「${s.state}」）`);
    await page.waitForTimeout(200);
  }
}

let server = null;
try {
  server = await startChatServer({ claudeBin: 'inherit' });
  log(`服务：${server.base}（真实 web/server.js + 临时库；hermes 是机器上真的 ${process.env.HERMES_BIN || 'hermes'}）`);

  /* ---------------- F1：非交互对话 ---------------- */
  const created = await postJson(server.base, '/api/chat/threads', { agent_id: 'hermes', title: 'P6 验收 F1/F2（hermes 真对话）' });
  if (created.status !== 201) throw new Error(`建 thread 失败：HTTP ${created.status} ${JSON.stringify(created.body)}`);
  const th = created.body.thread_id;
  const msg1 = '你好，我是 Leo。我最喜欢的数字是 42，养了一只叫汽水的猫。请记住这两件事，等下我会考你。';
  const s1 = await postJson(server.base, `/api/chat/threads/${th}/messages`, { content: msg1 });
  if (s1.status !== 202) throw new Error(`发消息失败：HTTP ${s1.status} ${JSON.stringify(s1.body)}`);
  const t1 = await apiTurn(server.base, s1.body.turn_id);
  const threadAfter1 = (await getJson(server.base, `/api/chat/threads/${th}`)).body.thread;
  const evTypes = t1.events.map((e) => e.type);
  const deltaText = t1.events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
  const assistant1 = t1.assistant_message.content;
  const okF1 = t1.turn.status === 'completed' && assistant1.length >= 10
    && Boolean(threadAfter1.provider_session_id) && /^\d{8}_\d{6}_[0-9a-z]+$/.test(threadAfter1.provider_session_id)
    && evTypes.includes('started') && evTypes.includes('delta') && evTypes.includes('completed')
    && norm(deltaText) === norm(assistant1) && !t1.turn.resume;
  save('f1', {
    thread_id: th, user_message: msg1, turn: t1.turn, assistant_message: assistant1,
    provider_session_id: threadAfter1.provider_session_id, event_types: evTypes,
    delta_events: t1.events.filter((e) => e.type === 'delta').length, delta_equals_assistant: norm(deltaText) === norm(assistant1),
  });
  record('F1', 'hermes 非交互对话：真实回复 + session_id 入库 + started→delta→completed', okF1,
    `thread=${th} turn=${t1.turn.turn_id} status=${t1.turn.status} resume=${t1.turn.resume}\nprovider_session_id=${threadAfter1.provider_session_id}（格式符合 hermes 的 YYYYMMDD_HHMMSS_xxxxxx）\n事件 ${evTypes.length} 条：${brief(evTypes.join(' → '), 220)}\n回复（${assistant1.length} 字）：${brief(assistant1, 220)}\ndelta 拼接与助手消息一致=${norm(deltaText) === norm(assistant1)}`);

  /* ---------------- F2：界面续聊（真浏览器） ---------------- */
  const page = await newPage(server.base);
  await openBoard(page, server.base, 'hermes');
  const before = await uiState(page);
  // 发第 2 句：走用户真实路径（输入框 + 发送键）
  await page.fill('.composer__input', '我最喜欢的数字是多少？只回答数字。');
  await page.click('.cbtn[data-act="send"]');
  await page.waitForSelector('.cbtn[data-act="cancel"]:not([hidden])', { timeout: 15000 }).catch(() => { /* 回复很快时可能没截到执行中 */ });
  const stateAfterSend = await uiState(page);
  const doneState = await waitDone(page, 180000);
  await sleep(500);
  const ui = await uiState(page);
  await page.screenshot({ path: resolve(DOC, 'f2-hermes-multiturn-1440x900.png') });

  const body = (await getJson(server.base, `/api/chat/threads/${th}/messages`)).body;
  const turns = [...body.turns].reverse();
  const t2 = turns[turns.length - 1];
  const t2detail = (await getJson(server.base, `/api/chat/turns/${t2.turn_id}`)).body;
  const threadAfter2 = (await getJson(server.base, `/api/chat/threads/${th}`)).body.thread;
  const restoring = t2detail.events.find((e) => e.type === 'restoring' || e.type === 'started');
  const assistant2 = t2detail.assistant_message.content;
  const okF2 = t2.status === 'completed' && Boolean(t2.resume) && /\b42\b/.test(assistant2)
    && threadAfter2.provider_session_id === threadAfter1.provider_session_id
    && restoring && restoring.type === 'restoring' && /42/.test(ui.lastBubble)
    && !/没有接入对话/.test(before.empty + before.state)
    && before.composerVisible && ui.errors.length === 0 && pageErrors.length === 0;
  save('f2', {
    thread_id: th, assistant_1: assistant1, assistant_2: assistant2, turn_2: t2, restoring_event: restoring,
    provider_session_id_before: threadAfter1.provider_session_id, provider_session_id_after: threadAfter2.provider_session_id,
    ui_before: before, ui_after_send: stateAfterSend, ui_after: ui, final_state: doneState, page_errors: pageErrors,
  });
  record('F2', 'hermes 续聊：界面第 2 句接上第 1 句（答对 42），--resume 同一 session', okF2,
    `第 2 轮 turn=${t2.turn_id} status=${t2.status} resume=${t2.resume}；事件首条=${restoring && restoring.type}\nsession 不变=${threadAfter2.provider_session_id === threadAfter1.provider_session_id}（${threadAfter2.provider_session_id}）\n面板里第 2 条回复=「${brief(ui.lastBubble, 120)}」（API=${brief(assistant2, 80)}）\n点发送后立刻的状态=「${brief(stateAfterSend.state, 70)}」；最终=「${brief(doneState, 40)}」\n页面前：空提示=「${brief(before.empty, 120)}」输入框在=${before.composerVisible}`);

  await page.close();
} catch (err) {
  log(`\n中断：${err && err.stack ? err.stack : err}`);
  results.push({ id: 'RUN', title: '验收脚本中途异常', pass: false, detail: String(err && err.message ? err.message : err) });
} finally {
  if (server) await server.stop().catch(() => {});
  await browser.close();
}

const bad = pageErrors.filter((e) => !/favicon/i.test(e));
save('summary', { at: new Date().toISOString(), results, page_errors: pageErrors, pass: results.filter((r) => r.pass).length, total: results.length });
log(`\nF1-F2：${results.filter((r) => r.pass).length}/${results.length} 通过；页面错误 ${bad.length} 条${bad.length ? `\n${bad.join('\n')}` : ''}`);
process.exit(results.every((r) => r.pass) && bad.length === 0 ? 0 : 1);
