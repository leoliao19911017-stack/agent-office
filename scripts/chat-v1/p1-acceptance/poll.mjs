// poll.mjs — P1 验收轮询工具：等一轮到终态，然后打印该轮消息与轮次证据。
// 用法：node poll.mjs <threadId> [turnId]
import { setTimeout as sleep } from 'node:timers/promises';

const [, , threadId, wantTurnId] = process.argv;
if (!threadId) { console.error('用法：node poll.mjs <threadId> [turnId]'); process.exit(1); }
const base = 'http://127.0.0.1:8090';

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { parse_error: text.slice(0, 400) }; }
  return { status: res.status, json };
}

let last = null;
for (let i = 1; i <= 60; i += 1) {
  const { json } = await fetchJson(`${base}/api/chat/threads/${threadId}/messages`);
  const turns = json.turns || [];
  const turn = wantTurnId ? turns.find((t) => t.turn_id === wantTurnId) : turns[0];
  const st = turn ? turn.status : 'missing';
  if (st !== last) { console.log(`[poll ${i}] turn ${turn ? turn.turn_id : '-'} → ${st}`); last = st; }
  if (!turn || ['completed', 'interrupted', 'unknown', 'rate_limited'].includes(st)) break;
  await sleep(4000);
}

const { json } = await fetchJson(`${base}/api/chat/threads/${threadId}/messages`);
console.log(`provider_session_id = ${json.thread.provider_session_id}`);
for (const t of json.turns || []) {
  console.log(`TURN ${t.turn_id} status=${t.status} resume=${t.resume} error=${JSON.stringify(t.error)}`);
}
for (const m of json.messages || []) {
  console.log(`\n===== ${m.role} | ${m.status} | seq=${m.seq} | turn=${m.turn_id} =====`);
  console.log(m.content || '(空)');
}
