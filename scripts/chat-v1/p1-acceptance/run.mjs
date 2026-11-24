// run.mjs — Agent Chat P1 验收 A1-A7 的自动化重跑（P7 回归用）。
// 和 P1 当时的手工 curl/poll 同一套断言，只是串起来跑：真 claude、真 8090、真 SQLite。
// 用法：node --no-warnings scripts/chat-v1/p1-acceptance/run.mjs [--base http://127.0.0.1:8090]
// 产物：scripts/chat-v1/p1-acceptance/out/run.json，完整输出由调用方重定向到 out/run.log
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { postJson, getJson, sleep } from '../../../test/chat-harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const OUT = process.env.CHAT_EVIDENCE_DIR ? resolve(process.env.CHAT_EVIDENCE_DIR) : resolve(HERE, 'out');
mkdirSync(OUT, { recursive: true });
const args = process.argv.slice(2);
const BASE = args.includes('--base') ? args[args.indexOf('--base') + 1] : 'http://127.0.0.1:8090';
const DB_PATH = process.env.AGENT_OFFICE_DB || resolve(REPO, 'data', 'agent-office.db');
const results = [];
const save = (name, data) => writeFileSync(resolve(OUT, `${name}.json`), JSON.stringify(data, null, 2));
const log = (...a) => console.log(...a);
function record(id, title, pass, detail) {
  results.push({ id, title, pass, detail });
  log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${title}${detail ? `\n      ${String(detail).replace(/\n/g, '\n      ')}` : ''}`);
}
const ACTIVE = ['queued', 'starting', 'restoring', 'running', 'tool_running', 'approval_required'];
const TERMINAL = new Set(['completed', 'failed', 'interrupted', 'unknown']);
const isTerminalTurn = (t) => TERMINAL.has(t.status) || (t.status === 'rate_limited' && Boolean(t.ended_at));
const norm = (t) => String(t || '').replace(/^[\s>*_#`~-]+/gm, '').replace(/\s+/g, '').replace(/[「」“”"'']/g, '');

async function send(threadId, content) {
  const r = await postJson(BASE, `/api/chat/threads/${threadId}/messages`, { content });
  if (r.status !== 202) throw new Error(`发消息失败 HTTP ${r.status}：${JSON.stringify(r.body)}`);
  return r.body;
}
async function waitTurn(turnId, ms = 240000) {
  const t0 = Date.now();
  const seen = [];
  for (;;) {
    const body = (await getJson(BASE, `/api/chat/turns/${turnId}`)).body;
    const t = body && body.turn;
    if (t && seen[seen.length - 1] !== t.status) seen.push(t.status);
    if (t && isTerminalTurn(t)) return { ...body, seen };
    if (Date.now() - t0 > ms) throw new Error(`轮次 ${turnId} 超时（${t && t.status}）`);
    await sleep(400);
  }
}
const dbq = (sql, ...params) => {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try { return db.prepare(sql).all(...params); } finally { db.close(); }
};
const dbExec = (sql, ...params) => {
  const db = new DatabaseSync(DB_PATH);
  try { return db.prepare(sql).run(...params); } finally { db.close(); }
};

const startedAt = new Date().toISOString();
try {
  /* A1 建 thread */
  const created = await postJson(BASE, '/api/chat/threads', { agent_id: 'claude', title: `P7 回归 A1-A7 ${startedAt}` });
  const th = created.body && created.body.thread_id;
  record('A1', '能创建 thread，返回 thread_id', created.status === 201 && /^th-/.test(th || ''),
    `HTTP ${created.status} thread_id=${th}`);

  const msg1 = '你好，我是Leo。我最喜欢的数字是 42，养了一只叫「汽水」的猫。请记住这两件事，等下我会考你。';
  const msg2 = '第二句：随便聊聊，你觉得养猫的人写代码会更有耐心吗？一两句话回答就行。';
  const msg3 = '第三句：我在第一句话里告诉过你两件关于我的事，你还记得吗？请原样复述这两件事。';
  const msg4 = '我刚才第一句说了什么？请一字不差地引用原文。';

  /* A2 真实回复 */
  const s1 = await send(th, msg1);
  const t1 = await waitTurn(s1.turn_id);
  const a1 = t1.assistant_message ? t1.assistant_message.content : '';
  record('A2', '发一条消息，claude 有真实回复', t1.turn.status === 'completed' && a1.length >= 10,
    `turn ${t1.turn.turn_id}：${(t1.seen || []).join(' → ')}；回复 ${a1.length} 字：${a1.replace(/\s+/g, ' ').slice(0, 160)}`);

  /* A3 第 3 条体现第 1 条 */
  await waitTurn((await send(th, msg2)).turn_id);
  const s3 = await send(th, msg3);
  const t3 = await waitTurn(s3.turn_id);
  const a3 = t3.assistant_message ? t3.assistant_message.content : '';
  record('A3', '第 3 条能体现第 1 条内容（真上下文）', t3.turn.status === 'completed' && /42/.test(a3) && /汽水/.test(a3),
    `回复 ${a3.length} 字：${a3.replace(/\s+/g, ' ').slice(0, 240)}`);

  /* A4 一字不差引用第一句 */
  const s4 = await send(th, msg4);
  const t4 = await waitTurn(s4.turn_id);
  const a4 = t4.assistant_message ? t4.assistant_message.content : '';
  const quoted = norm(a4).includes(norm(msg1));
  record('A4', '「我刚才第一句说了什么？」一字不差引用原文', t4.turn.status === 'completed' && quoted,
    `回复：${a4.replace(/\s+/g, ' ').slice(0, 300)}\n去空白/引号后包含原句=${quoted}`);

  /* A5 provider_session_id 保存 + 第 2 条起 resume */
  const msgs = (await getJson(BASE, `/api/chat/threads/${th}/messages`)).body;
  const turns = [...msgs.turns].reverse();
  const sid = msgs.thread.provider_session_id;
  const okResume = turns.length >= 4 && Boolean(turns[0].resume) === false && turns.slice(1).every((t) => Boolean(t.resume));
  record('A5', 'provider_session_id 正确保存，第 2 条起走 --resume', Boolean(sid) && okResume,
    `session=${sid}\nturns: ${turns.map((t) => `${t.turn_id}:resume=${Boolean(t.resume)}`).join('  ')}`);

  /* A6 三表落库 */
  const cMsg = dbq('SELECT COUNT(*) n FROM chat_messages WHERE thread_id = ?', th)[0].n;
  const cTurn = dbq('SELECT COUNT(*) n FROM chat_turns WHERE thread_id = ?', th)[0].n;
  const cEvt = dbq('SELECT COUNT(*) n FROM chat_events WHERE turn_id IN (SELECT turn_id FROM chat_turns WHERE thread_id = ?)', th)[0].n;
  const row = dbq('SELECT provider_session_id, mode FROM chat_threads WHERE thread_id = ?', th)[0];
  record('A6', '数据库里能查到 thread / messages / turns', cMsg >= 8 && cTurn >= 4 && cEvt > 0 && row && row.provider_session_id === sid,
    `chat_threads 1 行（mode=${row && row.mode}，session=${row && row.provider_session_id}）\nchat_messages ${cMsg} 行；chat_turns ${cTurn} 行；chat_events ${cEvt} 行`);

  /* A7 坏 session id → 不冒充 completed */
  const bad = await postJson(BASE, '/api/chat/threads', { agent_id: 'claude', title: `P7 回归 A7 坏 session ${startedAt}` });
  const bth = bad.body.thread_id;
  dbExec("UPDATE chat_threads SET provider_session_id = '00000000-dead-beef-0000-000000000000' WHERE thread_id = ?", bth);
  const s7 = await send(bth, '这条应该因为会话不存在而失败：只回复两个字「收到」。');
  const t7 = await waitTurn(s7.turn_id, 120000);
  const after7 = (await getJson(BASE, `/api/chat/threads/${bth}`)).body.thread;
  const a7 = t7.assistant_message ? t7.assistant_message.content : '';
  const kind = t7.turn.error && t7.turn.error.kind;
  record('A7', '坏 session id → 失败态，不冒充 completed', t7.turn.status !== 'completed' && kind === 'session_not_found' && after7.provider_session_id == null,
    `status=${t7.turn.status} error.kind=${kind} message=「${t7.turn.error && t7.turn.error.message}」\nprovider_session_id 已清=${after7.provider_session_id == null}；助手消息=${t7.assistant_message && t7.assistant_message.status} 内容=「${a7.slice(0, 60)}」`);

  save('run', {
    at: startedAt, base: BASE, thread: th, bad_thread: bth, results,
    messages: msgs.messages.map((m) => ({ role: m.role, status: m.status, turn_id: m.turn_id, content: m.content })),
    turns: turns.map((t) => ({ turn_id: t.turn_id, status: t.status, resume: Boolean(t.resume), error: t.error })),
    db: { messages: cMsg, turns: cTurn, events: cEvt, provider_session_id: sid },
    a7: { status: t7.turn.status, error: t7.turn.error, provider_session_id: after7.provider_session_id },
  });
} catch (err) {
  log(`\n中断：${err && err.stack ? err.stack : err}`);
  results.push({ id: 'RUN', title: '验收脚本中途异常', pass: false, detail: String(err && err.message ? err.message : err) });
}

save('summary', { at: new Date().toISOString(), base: BASE, results, pass: results.filter((r) => r.pass).length, total: results.length });
log(`\nA1-A7：${results.filter((r) => r.pass).length}/${results.length} 通过`);
process.exit(results.every((r) => r.pass) ? 0 : 1);
