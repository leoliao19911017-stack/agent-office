// run.mjs — Agent Chat P3（SSE 流式输出）验收：真 claude / 真 dsh、真 HTTP，C1-C4 每项的真实事件落盘。
// 用法：node --no-warnings scripts/chat-v1/p3-acceptance/run.mjs [--base http://127.0.0.1:8090] [--only c1,c3,c4]
// 产物：scripts/chat-v1/p3-acceptance/out/*.json（证据文档从这里引用）
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { postJson, getJson, sleep } from '../../../test/chat-harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, 'out');
const REPO = resolve(HERE, '..', '..', '..');
mkdirSync(OUT, { recursive: true });
const args = process.argv.slice(2);
const BASE = args.includes('--base') ? args[args.indexOf('--base') + 1] : 'http://127.0.0.1:8090';
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const results = [];
const save = (name, data) => writeFileSync(resolve(OUT, `${name}.json`), JSON.stringify(data, null, 2));
const log = (...a) => console.log(...a);
function record(id, title, pass, detail) {
  results.push({ id, title, pass, detail });
  log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${title}${detail ? `\n      ${String(detail).replace(/\n/g, '\n      ')}` : ''}`);
}

async function send(threadId, content) {
  const r = await postJson(BASE, `/api/chat/threads/${threadId}/messages`, { content });
  if (r.status !== 202) throw new Error(`发消息失败 HTTP ${r.status}：${JSON.stringify(r.body)}`);
  return r.body;
}
async function newThread(agentId, title) {
  const r = await postJson(BASE, '/api/chat/threads', { agent_id: agentId, title });
  if (r.status !== 201) throw new Error(`建对话失败 HTTP ${r.status}：${JSON.stringify(r.body)}`);
  return r.body.thread_id;
}

/**
 * 订阅到连接结束（或 abortAt 返回 true 时主动断开）。每条事件记 at_ms = 相对 t0（发消息时刻）多久到达。
 * 自己解析 text/event-stream：事件帧进 events，注释行（心跳）只计数，retry 行记下来。
 */
async function streamAll(turnId, { headers = {}, query = '', t0 = Date.now(), abortAt = null } = {}) {
  const events = [];
  const raw = { heartbeats: 0, retry: null, contentType: null, status: null };
  const ac = new AbortController();
  const res = await fetch(`${BASE}/api/chat/turns/${turnId}/stream${query}`, { headers, signal: ac.signal });
  raw.status = res.status;
  if (res.status !== 200) throw new Error(`stream HTTP ${res.status}`);
  raw.contentType = res.headers.get('content-type');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let cur = { event: 'message', data: '', id: null };
  const dispatch = () => {
    if (cur.data === '' && cur.id === null) { cur = { event: 'message', data: '', id: null }; return; }
    let data = null;
    try { data = JSON.parse(cur.data.replace(/\n$/, '')); } catch { data = cur.data; }
    const ev = { event: cur.event, data, id: cur.id, at_ms: Date.now() - t0 };
    events.push(ev);
    if (abortAt && abortAt(ev, events)) ac.abort();
    cur = { event: 'message', data: '', id: null };
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        let line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') { dispatch(); continue; }
        if (line.startsWith(':')) { raw.heartbeats += 1; continue; }
        if (line.startsWith('retry:')) { raw.retry = Number(line.slice(6).trim()); continue; }
        const m = line.match(/^(event|data|id):\s?(.*)$/);
        if (!m) continue;
        if (m[1] === 'event') cur.event = m[2];
        else if (m[1] === 'data') cur.data += `${m[2]}\n`;
        else cur.id = m[2];
      }
    }
    dispatch();
  } catch (err) {
    if (!ac.signal.aborted) throw err;
  }
  return { events, raw, aborted: ac.signal.aborted };
}

const types = (events) => events.map((e) => e.event);
const of = (events, type) => events.filter((e) => e.event === type);
const ids = (events) => events.filter((e) => e.id != null).map((e) => Number(e.id));
const deltaText = (events) => of(events, 'delta').filter((e) => !e.data.replace).map((e) => e.data.text).join('');
const brief = (s, n = 120) => String(s || '').replace(/\s+/g, ' ').slice(0, n);
const briefEv = (e, n = 220) => ({ id: e.id, event: e.event, at_ms: e.at_ms, data: brief(JSON.stringify(e.data), n) });
const contiguous = (list, from = 1) => list.every((s, i) => s === from + i);
const strip = (evs) => evs.filter((e) => e.id != null).map((e) => ({ id: Number(e.id), event: e.event, text: e.data && e.data.text ? e.data.text : undefined }));

async function main() {
  const startedAt = new Date().toISOString();
  const health = (await getJson(BASE, '/api/health')).body;
  log(`服务 ${BASE} health=${JSON.stringify(health)}`);
  const want = (id) => !ONLY || ONLY.split(',').includes(id);
  let claudeThread = null;

  if (want('c1') || want('c3')) {
    /* ---------- C1 / C2：真 claude 流式 ---------- */
    claudeThread = await newThread('claude', 'P3 验收 C1-C3（真 claude 流式）');
    const posted = Date.now();
    const s1 = await send(claudeThread, '用三句话介绍一下 SSE（Server-Sent Events）是什么、和 WebSocket 比有什么不同。不要用工具。');
    const live = await streamAll(s1.turn_id, { t0: posted });
    const ts = types(live.events);
    const deltas = of(live.events, 'delta');
    const firstDelta = deltas[0] ? deltas[0].at_ms : null;
    const done = of(live.events, 'completed')[0];
    const okC1 = /text\/event-stream/.test(live.raw.contentType || '') && ts[0] === 'snapshot'
      && ts.includes('started') && deltas.length >= 3 && ts[ts.length - 1] === 'completed'
      && ts.indexOf('started') < ts.indexOf('delta') && contiguous(ids(live.events));
    save('c1', { thread_id: claudeThread, turn_id: s1.turn_id, content_type: live.raw.contentType, retry: live.raw.retry, raw_frames: live.events.slice(0, 8).map((e) => `${e.id != null ? `id: ${e.id}\n` : ''}event: ${e.event}\ndata: ${brief(JSON.stringify(e.data), 260)}`), types: ts, event_count: ts.length, delta_count: deltas.length, first_delta_ms: firstDelta, completed_ms: done ? done.at_ms : null });
    record('C1', '订阅 stream 收到 started → delta(多个) → completed', okC1,
      `Content-Type=${live.raw.contentType}；retry=${live.raw.retry}\n事件序列=${ts.slice(0, 9).join(' → ')}${ts.length > 9 ? ` → …（共 ${ts.length} 条）` : ''}\n共 ${deltas.length} 条 delta；首段增量在发送后 ${firstDelta}ms 到达，completed 在 ${done ? done.at_ms : '?'}ms ——增量先到、完成最后到`);

    const detail = (await getJson(BASE, `/api/chat/turns/${s1.turn_id}`)).body;
    const text = deltaText(live.events);
    const okC2 = detail.turn.status === 'completed' && text === detail.assistant_message.content
      && detail.events.map((e) => e.seq).join(',') === ids(live.events).join(',');
    save('c2', { turn_id: s1.turn_id, delta_concat: text, assistant_message: detail.assistant_message, stored_events: detail.events.map((e) => ({ seq: e.seq, type: e.type })), stream_ids: ids(live.events) });
    record('C2', 'delta 拼起来等于最终完整回复；库里的 chat_events 与实时流是同一串序号', okC2 && text.length > 20,
      `拼接长度=${text.length} 字，库里助手消息长度=${detail.assistant_message.content.length} 字，逐字相等=${text === detail.assistant_message.content}\n开头：「${brief(text, 60)}」\n库内事件序号 ${detail.events[0].seq}…${detail.events[detail.events.length - 1].seq}（${detail.events.length} 条）= SSE id ${ids(live.events)[0]}…${ids(live.events)[ids(live.events).length - 1]}（${ids(live.events).length} 条）`);
  }

  if (want('c3')) {
    /* ---------- C3：中途断开 → 带 Last-Event-ID 重连 ---------- */
    const posted = Date.now();
    const s2 = await send(claudeThread, '写一首八行的小诗，写秋天的傍晚，每行单独一行。不要用工具，不要解释。');
    const first = await streamAll(s2.turn_id, { t0: posted, abortAt: (ev, evs) => ev.event === 'delta' && of(evs, 'delta').length >= 4 });
    const firstIds = ids(first.events);
    const lastSeen = Math.max(...firstIds);
    await sleep(1500);   // 断线期间它继续输出
    const second = await streamAll(s2.turn_id, { t0: posted, headers: { 'last-event-id': String(lastSeen) } });
    const secondIds = ids(second.events);
    const union = [...new Set([...firstIds, ...secondIds])].sort((a, b) => a - b);
    const all = [...strip(first.events), ...strip(second.events)].sort((a, b) => a.id - b.id);
    const detail = (await getJson(BASE, `/api/chat/turns/${s2.turn_id}`)).body;
    const text = all.filter((e) => e.event === 'delta').map((e) => e.text).join('');
    const okC3 = first.aborted && firstIds.length >= 5 && secondIds.length > 0 && secondIds.every((s) => s > lastSeen)
      && contiguous(union) && union.length === firstIds.length + secondIds.length && text === detail.assistant_message.content
      && second.events[second.events.length - 1].event === 'completed' && second.events[0].data.replay_from === lastSeen;
    save('c3', {
      turn_id: s2.turn_id, disconnected_after_events: first.events.length, last_seen_seq: lastSeen,
      snapshot_on_reconnect: second.events[0].data, replayed_ids: secondIds, union_ids: union, final_text: text,
      assistant_message: detail.assistant_message, first_stream: strip(first.events), second_stream: strip(second.events),
    });
    record('C3', '中途断开重连，按 seq 补发，内容不丢不重', okC3,
      `断开时已收到 ${firstIds.length} 条（最后 seq=${lastSeen}）；重连带 Last-Event-ID: ${lastSeen}\n重连后 snapshot.replay_from=${second.events[0].data.replay_from}，补发 ${secondIds.length} 条，seq ${secondIds[0]}…${secondIds[secondIds.length - 1]}（全部 > ${lastSeen}）\n两边序号并集 ${union[0]}…${union[union.length - 1]} 连续无重复（共 ${union.length} 条）\n两段增量拼起来 ${text.length} 字 = 库里完整回复 ${detail.assistant_message.content.length} 字，逐字相等=${text === detail.assistant_message.content}`);

    // 真 dsh 的回答是整段到达的：演示「started 之后断开、带 Last-Event-ID 重连」后续事件全部补到
    const dshThread = await newThread('dsh', 'P3 验收 C3（真 dsh）');
    const p3 = Date.now();
    const s3 = await send(dshThread, '只用一句话说明：你是谁。不要用工具。');
    const d1 = await streamAll(s3.turn_id, { t0: p3, abortAt: (ev) => ev.event === 'started' });
    const dLast = Math.max(...ids(d1.events));
    const d2 = await streamAll(s3.turn_id, { t0: p3, headers: { 'last-event-id': String(dLast) } });
    const dUnion = [...new Set([...ids(d1.events), ...ids(d2.events)])].sort((a, b) => a - b);
    const dDetail = (await getJson(BASE, `/api/chat/turns/${s3.turn_id}`)).body;
    const dText = [...strip(d1.events), ...strip(d2.events)].filter((e) => e.event === 'delta').map((e) => e.text).join('');
    const dOk = d1.aborted && ids(d2.events).every((s) => s > dLast) && contiguous(dUnion) && dUnion.length === dDetail.events.length
      && dText === dDetail.assistant_message.content && d2.events[d2.events.length - 1].event === 'completed';
    save('c3-dsh', { thread_id: dshThread, turn_id: s3.turn_id, first: d1.events.map(briefEv), second: d2.events.map(briefEv), final_text: dDetail.assistant_message.content });
    record('C3-dsh', '真 dsh：started 之后断开、带 Last-Event-ID 重连，后续事件全部补到、不重复', dOk,
      `第一次收到 ${types(d1.events).join(' → ')}（断在 seq=${dLast}）\n重连补发 ${types(d2.events).join(' → ')}\n并集 ${dUnion.join(',')} = 库里全部 ${dDetail.events.length} 条事件；最终回复=「${brief(dDetail.assistant_message.content, 80)}」`);
  }

  if (want('c4')) {
    /* ---------- C4：出错时 error 事件且 code 具体（8090 上真实制造） ---------- */
    const bad = await newThread('dsh', 'P3 验收 C4（坏 session）');
    const wsDir = resolve(OUT, `ws-${Date.now()}`);
    const wsThread = await newThread('dsh', 'P3 验收 C4（工作目录没了）');
    const db = new DatabaseSync(resolve(REPO, 'data', 'agent-office.db'));
    db.prepare('UPDATE chat_threads SET provider_session_id = ? WHERE thread_id = ?').run('session-00000000-0000-4000-8000-000000000000', bad);
    db.prepare('UPDATE chat_threads SET workspace = ? WHERE thread_id = ?').run(wsDir.replace(/\\/g, '/'), wsThread);   // 工作目录指向一个不存在的路径
    db.close();
    const s4 = await send(bad, '只回复两个字：在');
    const e1 = await streamAll(s4.turn_id);
    const err1 = e1.events[e1.events.length - 1];
    const okA = err1.event === 'error' && err1.data.code === 'session_not_found' && /does not exist/.test(err1.data.message) && contiguous(ids(e1.events));
    const s5 = await send(wsThread, '只回复两个字：在');
    const e2 = await streamAll(s5.turn_id);
    const err2 = e2.events[e2.events.length - 1];
    const okB = err2.event === 'error' && err2.data.code === 'cli_start_failed' && err2.data.reason === 'workspace_not_found';
    save('c4', {
      cases: [
        { how: '把 thread 的 provider_session_id 改成不存在的 ID，dsh 真的报 does not exist', thread_id: bad, turn_id: s4.turn_id, events: e1.events.map((e) => briefEv(e, 400)) },
        { how: '建对话后把工作目录改成不存在的路径', thread_id: wsThread, turn_id: s5.turn_id, events: e2.events.map((e) => briefEv(e, 400)) },
      ],
    });
    record('C4', '出错时收到 error 事件且 code 具体', okA && okB,
      `[会话不存在] ${types(e1.events).join(' → ')}\n  error: code=${err1.data.code} reason=${err1.data.reason} status=${err1.data.status} text=「${brief(err1.data.text, 120)}」\n[工作目录没了] ${types(e2.events).join(' → ')}\n  error: code=${err2.data.code} reason=${err2.data.reason} status=${err2.data.status} text=「${brief(err2.data.text, 120)}」`);
  }

  if (want('poll')) {
    /* ---------- 轮询接口保留：同一轮用轮询也能拿到同样的状态与全文 ---------- */
    const list = (await getJson(BASE, '/api/chat/threads?agent_id=dsh')).body;
    const th = list.threads[0];
    const msgs = (await getJson(BASE, `/api/chat/threads/${th.thread_id}/messages`)).body;
    record('轮询保留', 'GET /api/chat/threads/:id/messages 仍在，返回 thread / messages / turns / thread_status', msgs.ok === true && Array.isArray(msgs.messages) && Array.isArray(msgs.turns) && msgs.thread_status.status !== 'idle',
      `thread=${th.thread_id} messages=${msgs.messages.length} turns=${msgs.turns.length} thread_status=${msgs.thread_status.status}`);
  }

  save('summary', { started_at: startedAt, finished_at: new Date().toISOString(), base: BASE, health, results, pass: results.filter((r) => r.pass).length, total: results.length });
  log(`\nC1-C4：${results.filter((r) => r.pass).length}/${results.length} 通过`);
  process.exit(results.every((r) => r.pass) ? 0 : 1);
}

main().catch((err) => { console.error(err && err.stack ? err.stack : err); process.exit(2); });
