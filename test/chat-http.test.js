// chat-http.test.js — Agent Chat 的 HTTP + SSE 集成测试：真实 web/server.js 子进程 + 假 CLI（test/fixtures/chat-fake-*.mjs）。
// 覆盖分批计划的验收口径（假 CLI 版，真 CLI 的实测证据在 docs/evidence/chat-*/）：
//   P2 B1-B5  多轮续聊 / session 保存 / 起不来时 failed + 具体原因
//   P3 C1-C4  SSE：started → delta → completed；增量 = 完整回复；断线按 seq 补发不重不漏；error 的 code 具体
//   P5 E1-E5  429 / 额度（何时可重试）、启动失败细原因、排队串行、取消
//   登记接口   POST /api/tasks/:id/finish（没证据 400；有证据 → completed）
//   T5        重启服务历史还在
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startChatServer, readSse, postJson, getJson, sleep, waitTurn } from './chat-harness.mjs';

const ACTIVE = ['queued', 'starting', 'restoring', 'running', 'tool_running', 'approval_required'];

async function send(base, threadId, content) {
  const r = await postJson(base, `/api/chat/threads/${threadId}/messages`, { content });
  assert.equal(r.status, 202, `发消息应 202（实际 ${r.status}：${JSON.stringify(r.body)}）`);
  return r.body;
}

async function newThread(base, agentId, extra = {}) {
  const r = await postJson(base, '/api/chat/threads', { agent_id: agentId, ...extra });
  assert.equal(r.status, 201, `建对话应 201（实际 ${r.status}：${JSON.stringify(r.body)}）`);
  return r.body.thread;
}

/** 订阅到连接结束，返回全部事件 [{event, data, id}] */
async function streamAll(base, turnId, headers = {}, query = '') {
  const events = [];
  const res = await fetch(`${base}/api/chat/turns/${turnId}/stream${query}`, { headers });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  assert.equal(res.headers.get('cache-control'), 'no-cache, no-transform');
  await readSse(res, (e) => events.push(e));
  return events;
}

const types = (events) => events.map((e) => e.event);
const of = (events, type) => events.filter((e) => e.event === type);
const ids = (events) => events.filter((e) => e.id != null).map((e) => Number(e.id));
const deltaText = (events) => of(events, 'delta').filter((e) => !e.data.replace).map((e) => e.data.text).join('');

function assertContiguous(list, from = 1) {
  list.forEach((s, i) => assert.equal(s, from + i, `序号断了：${list.join(',')}`));
}

async function assistantOf(base, threadId, turnId) {
  const { body } = await getJson(base, `/api/chat/threads/${threadId}/messages`);
  const msg = body.messages.find((m) => m.role === 'assistant' && m.turn_id === turnId);
  return { body, msg };
}

test('Agent Chat HTTP + SSE（真实 server.js + 假 CLI）', async (t) => {
  const srv = await startChatServer({ fakeDelayMs: 40 });
  t.after(() => srv.stop());
  const base = srv.base;

  await t.test('建对话 / 列对话 / 不支持的 agent 明说 / 工作目录必须存在', async () => {
    const th = await newThread(base, 'claude', { title: '接口冒烟' });
    assert.equal(th.provider_session_id, null);
    assert.equal(th.thread_status.status, 'unknown', '还没有任何轮次：没有证据，不显示空闲');
    assert.match(th.thread_status.reason, /没有证据/);

    const bad = await postJson(base, '/api/chat/threads', { agent_id: 'codex' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'BAD_AGENT');
    assert.match(bad.body.error, /codex/);

    const ws = await postJson(base, '/api/chat/threads', { agent_id: 'dsh', workspace: 'C:/definitely/not/here' });
    assert.equal(ws.status, 400);
    assert.equal(ws.body.code, 'BAD_WORKSPACE');
    const rel = await postJson(base, '/api/chat/threads', { agent_id: 'dsh', workspace: 'relative/path' });
    assert.equal(rel.status, 400);

    const list = await getJson(base, '/api/chat/threads?agent_id=claude');
    assert.equal(list.status, 200);
    assert.ok(list.body.threads.some((x) => x.thread_id === th.thread_id));
    assert.equal(list.body.unsupported.codex !== undefined, true, '列对话时带出未接入 agent 的原因，界面不编');
    const mine = list.body.threads.filter((x) => x.agent_id === 'claude');
    assert.ok(mine.every((x) => x.agent_id === 'claude'));

    const missing = await getJson(base, '/api/chat/threads/th-doesnotexist/messages');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'THREAD_NOT_FOUND');
    const method = await postJson(base, `/api/chat/threads/${th.thread_id}`, {});
    assert.equal(method.status, 405);
  });

  await t.test('C1-C2：SSE 收到 started → delta(多个) → completed，delta 拼起来等于最终完整回复', async () => {
    const th = await newThread(base, 'claude');
    const { turn_id, stream } = await send(base, th.thread_id, '请慢慢说 [slow]');
    assert.equal(stream.href, `/api/chat/turns/${turn_id}/stream`);
    const events = await streamAll(base, turn_id);
    const ts = types(events);
    assert.equal(ts[0], 'snapshot');
    assert.ok(ts.includes('started'), `应有 started（实际：${ts.join(' ')}）`);
    assert.ok(ts.indexOf('started') < ts.indexOf('delta'));
    assert.ok(of(events, 'delta').length >= 5, `delta 应有多条（实际 ${of(events, 'delta').length}）`);
    assert.equal(ts[ts.length - 1], 'completed', '最后一条是 completed');
    assert.equal(of(events, 'completed')[0].data.message_id != null, true);
    assertContiguous(ids(events));
    assert.equal(events[0].id, null, '快照没有 seq，不带 id');

    const text = deltaText(events);
    assert.ok(text.length > 10);
    const { body, msg } = await assistantOf(base, th.thread_id, turn_id);
    assert.equal(msg.content, text, '增量拼起来 = 库里的完整回复');
    assert.equal(msg.status, 'complete');
    const turn = body.turns.find((x) => x.turn_id === turn_id);
    assert.equal(turn.status, 'completed');
    assert.equal(turn.display_status, 'completed');
    assert.equal(turn.resume, false);

    const detail = await getJson(base, `/api/chat/turns/${turn_id}`);
    assert.deepEqual(detail.body.events.map((e) => e.seq), ids(events), 'GET /turns/:id 的事件序号与 SSE 一致');
    assert.equal(detail.body.assistant_message.content, text);
    assert.equal(detail.body.turn.user_message_id != null, true);
  });

  await t.test('C3：中途断开，带 Last-Event-ID 重连只补之后的——不重复不丢', async () => {
    const th = await newThread(base, 'claude');
    const { turn_id } = await send(base, th.thread_id, '慢速流式 [slow]');
    const first = [];
    const ac = new AbortController();
    await fetch(`${base}/api/chat/turns/${turn_id}/stream`, { signal: ac.signal })
      .then((res) => readSse(res, (e) => { first.push(e); if (of(first, 'delta').length >= 3) ac.abort(); }))
      .catch((err) => assert.equal(err.name, 'AbortError', '是我们主动断的'));
    assert.ok(of(first, 'delta').length >= 3, '断开前收到了几段');
    assert.ok(!types(first).includes('completed'), '断开时还没结束');
    const lastSeen = Math.max(...ids(first));
    await sleep(900);   // 断线期间它继续输出并落库

    const second = await streamAll(base, turn_id, { 'last-event-id': String(lastSeen) });
    assert.equal(second[0].event, 'snapshot');
    assert.equal(second[0].data.replay_from, lastSeen);
    const secondIds = ids(second);
    assert.ok(secondIds.length > 0);
    assert.ok(secondIds.every((s) => s > lastSeen), `重连后不该再收到 ≤ ${lastSeen} 的（实际从 ${secondIds[0]} 起）`);
    assert.equal(second[second.length - 1].event, 'completed');

    const union = [...new Set([...ids(first), ...secondIds])].sort((a, b) => a - b);
    assertContiguous(union);
    assert.equal(union.length, ids(first).length + secondIds.length, '两边没有重复');
    const all = [...first, ...second].filter((e) => e.id != null).sort((a, b) => Number(a.id) - Number(b.id));
    const { msg } = await assistantOf(base, th.thread_id, turn_id);
    assert.equal(deltaText(all), msg.content, '两段拼起来 = 完整回复：一字不丢、一字不重');
    const snapSeq = second[0].data.event_seq;
    assert.equal(second[0].data.text, all.filter((e) => e.event === 'delta' && Number(e.id) <= snapSeq).map((e) => e.data.text).join(''),
      '快照里的全文 = 序号 ≤ event_seq 的全部增量（断线期间的输出都已经在快照里，没有丢）');
    assert.ok(second.some((e) => e.event === 'delta' && Number(e.id) > snapSeq) || second[second.length - 1].event === 'completed');
  });

  await t.test('?after_seq= 与请求头等价；已收全的人重连只有快照；未知轮次 404；POST stream 405', async () => {
    const th = await newThread(base, 'claude');
    const { turn_id } = await send(base, th.thread_id, '在吗');
    await waitTurn(base, turn_id);
    const full = await streamAll(base, turn_id);
    const fromHalf = await streamAll(base, turn_id, {}, `?after_seq=3`);
    assert.equal(fromHalf[0].data.replay_from, 3);
    assert.deepEqual(ids(fromHalf), ids(full).filter((s) => s > 3));
    const tail = await streamAll(base, turn_id, { 'last-event-id': String(Math.max(...ids(full))) });
    assert.deepEqual(types(tail), ['snapshot']);
    const tooBig = await streamAll(base, turn_id, {}, '?after_seq=99999');
    assert.equal(tooBig[0].data.replay_from, Math.max(...ids(full)), '超出的 seq 被夹到当前最大值');
    const none = await getJson(base, '/api/chat/turns/ct-nope/stream');
    assert.equal(none.status, 404);
    assert.equal(none.body.code, 'TURN_NOT_FOUND');
    const post = await postJson(base, `/api/chat/turns/${turn_id}/stream`, {});
    assert.equal(post.status, 405);
  });

  await t.test('B1-B4（假 dsh）：三轮续聊，第 3 轮一字不差引用第 1 轮；第 2 条起走续聊；session 被保存', async () => {
    const th = await newThread(base, 'dsh');
    const code = '青禾-5173';
    const m1 = await send(base, th.thread_id, `口令是：${code}（只是对话内的口令）`);
    const r1 = await waitTurn(base, m1.turn_id);
    assert.equal(r1.turn.status, 'completed');
    assert.match(r1.assistant_message.content, /假 DSH 收到/);
    const after1 = (await getJson(base, `/api/chat/threads/${th.thread_id}`)).body.thread;
    assert.match(after1.provider_session_id, /^session-/);
    assert.equal(r1.turn.resume, false);

    const m2 = await send(base, th.thread_id, '第二句：随便聊聊');
    const r2 = await waitTurn(base, m2.turn_id);
    assert.equal(r2.turn.resume, true, '第 2 条走续聊');
    assert.match(r2.assistant_message.content, /本会话此前有 1 句/);
    const cmd = r2.events.find((e) => e.type === 'status' && e.cli_command);
    assert.ok(cmd, '留了真正执行的命令行');
    assert.match(cmd.cli_command, /--session-id session-/);
    assert.ok(!/--resume/.test(cmd.cli_command), 'dsh 的续聊参数不是 --resume');

    const m3 = await send(base, th.thread_id, '我第一句说了什么？请一字不差引用。');
    const r3 = await waitTurn(base, m3.turn_id);
    assert.equal(r3.turn.status, 'completed');
    assert.ok(r3.assistant_message.content.includes(`口令是：${code}（只是对话内的口令）`), `第 3 轮应引用第 1 轮原文（实际：${r3.assistant_message.content}）`);

    const { body } = await assistantOf(base, th.thread_id, m3.turn_id);
    assert.equal(body.messages.filter((m) => m.role === 'user').length, 3);
    assert.equal(body.thread_status.status, 'completed');
    assert.equal(body.turns.length, 3);
  });

  await t.test('C4 / B5：出错时 error 事件的 code 具体（进程崩溃 / 会话不存在）', async () => {
    const th = await newThread(base, 'claude');
    const crashed = await send(base, th.thread_id, '[crash]');
    const events = await streamAll(base, crashed.turn_id);
    const last = events[events.length - 1];
    assert.equal(last.event, 'error');
    assert.equal(last.data.code, 'crashed');
    assert.equal(last.data.status, 'interrupted');
    assert.match(last.data.text, /0xC0000142|异常退出/);
    const turn = await waitTurn(base, crashed.turn_id);
    assert.equal(turn.turn.status, 'interrupted');
    assert.equal(turn.turn.display_status, 'failed');
    assert.equal(turn.turn.error.code, 'crashed');

    const ok = await send(base, th.thread_id, '先建一个会话');
    const made = await waitTurn(base, ok.turn_id);
    assert.equal(made.turn.status, 'completed');
    const sid = made.turn.error === null ? (await getJson(base, `/api/chat/threads/${th.thread_id}`)).body.thread.provider_session_id : null;
    assert.ok(sid);
    rmSync(join(srv.home, 'fake-cli', 'claude-sessions', `${sid}.json`));   // 会话文件没了 = provider 说不存在
    const lost = await send(base, th.thread_id, '这条会命中不存在的会话');
    const lostEvents = await streamAll(base, lost.turn_id);
    const err = lostEvents[lostEvents.length - 1];
    assert.equal(err.event, 'error');
    assert.equal(err.data.code, 'session_not_found');
    assert.equal(err.data.label, '会话已丢失');
    const after = await waitTurn(base, lost.turn_id);
    assert.equal(after.turn.status, 'failed');
    assert.equal(after.turn.display_status, 'failed');
    const { body } = await assistantOf(base, th.thread_id, lost.turn_id);
    const user = body.messages.find((m) => m.role === 'user' && m.turn_id === lost.turn_id);
    assert.equal(user.status, 'failed', '没交出去');
    assert.equal(body.thread.provider_session_id, null, '坏 session 引用已清掉，下一句新开会话');
    assert.equal(body.thread_status.status, 'failed');
  });

  await t.test('E1：429 / 额度 → 「请求受限」，带具体何时可重试；在途 retry 事件带下一次倒计时', async () => {
    const th = await newThread(base, 'claude');
    const q = await send(base, th.thread_id, '[quota]');
    const events = await streamAll(base, q.turn_id);
    const retries = of(events, 'retry');
    assert.equal(retries.length, 2, 'CLI 自己的两次重试如实转出');
    assert.match(retries[0].data.retry_hint, /约 1 秒后第 2 次/);
    assert.ok(of(events, 'status').some((e) => e.data.status === 'rate_limited'));
    const err = events[events.length - 1];
    assert.equal(err.event, 'error');
    assert.equal(err.data.code, 'quota_exhausted');
    assert.equal(err.data.label, '额度暂不可用');
    assert.equal(err.data.retry_at, '2099-01-01T01:30:00.000Z', '上游文案里的重置时间被解析出来');
    assert.equal(err.data.retry_hint, '额度 01/01 09:30 重置，之后可以重试');
    const turn = await waitTurn(base, q.turn_id);
    assert.equal(turn.turn.status, 'rate_limited');
    assert.equal(turn.turn.display_status, 'failed');
    assert.equal(turn.turn.status_label, '额度暂不可用');
    const threadNow = (await getJson(base, `/api/chat/threads/${th.thread_id}`)).body;
    assert.equal(threadNow.thread_status.status, 'rate_limited');
    assert.equal(threadNow.thread_status.retry_hint, '额度 01/01 09:30 重置，之后可以重试');

    const r = await send(base, th.thread_id, '[429]');
    const rEvents = await streamAll(base, r.turn_id);
    const rErr = rEvents[rEvents.length - 1];
    assert.equal(rErr.data.code, 'rate_limit');
    assert.equal(rErr.data.label, '请求受限');
    assert.equal(rErr.data.retry_at, null, '纯限流没有重置时间 → 不编');
    assert.equal(rErr.data.retry_hint, '稍后可以重试；CLI 已自动重试 2/2 次仍未通过', '轮次已结束：不再说「正在重试」，如实报它试过几次');

    const dth = await newThread(base, 'dsh');
    const dq = await send(base, dth.thread_id, '[quota]');
    const dEvents = await streamAll(base, dq.turn_id);
    const dErr = dEvents[dEvents.length - 1];
    assert.equal(dErr.data.code, 'quota_exhausted');
    assert.equal(dErr.data.retry_at, '2099-01-01T01:30:00.000Z');
  });

  await t.test('E5：同一对话第二条排队（前面还有 1 条），第一条结束才起跑；不同对话并行', async () => {
    const th = await newThread(base, 'claude');
    const a = await send(base, th.thread_id, '甲 [slow]');
    const b = await send(base, th.thread_id, '乙');
    assert.equal(b.turn.status, 'queued');
    assert.equal(b.turn.queued_ahead, 1);
    const bEvents = await streamAll(base, b.turn_id);
    assert.equal(bEvents[0].data.status, 'queued');
    assert.equal(bEvents[0].data.queued_ahead, 1);
    assert.equal(bEvents[1].event, 'restoring', '起跑后第一条是 restoring（要续聊）');
    assert.equal(bEvents[bEvents.length - 1].event, 'completed');
    const ta = await waitTurn(base, a.turn_id);
    const tb = await waitTurn(base, b.turn_id);
    assert.equal(ta.turn.status, 'completed');
    assert.equal(tb.turn.status, 'completed');
    assert.ok(Date.parse(tb.turn.started_at) >= Date.parse(ta.turn.ended_at) - 5, '第二条在第一条结束之后才开始');
    assert.ok(bEvents[1].data.queued_ms >= 200, `排队时长留证（${bEvents[1].data.queued_ms}ms）`);
    const { body } = await assistantOf(base, th.thread_id, b.turn_id);
    assert.match(body.messages.find((m) => m.turn_id === b.turn_id && m.role === 'assistant').content, /本会话此前有 1 句/);

    const c = await newThread(base, 'claude');
    const d = await newThread(base, 'claude');
    const mc = await send(base, c.thread_id, '丙 [slow]');
    const md = await send(base, d.thread_id, '丁 [slow]');
    await sleep(250);
    const sc = (await getJson(base, `/api/chat/turns/${mc.turn_id}`)).body.turn.status;
    const sd = (await getJson(base, `/api/chat/turns/${md.turn_id}`)).body.turn.status;
    assert.ok(ACTIVE.includes(sc) && ACTIVE.includes(sd) && sc !== 'queued' && sd !== 'queued', `两个对话同时在跑（${sc} / ${sd}）`);
    await waitTurn(base, mc.turn_id);
    await waitTurn(base, md.turn_id);
  });

  await t.test('取消：在跑的 → interrupted / cancelled；已结束的再取消 → 409', async () => {
    const th = await newThread(base, 'claude');
    const h = await send(base, th.thread_id, '[hang]');
    for (let i = 0; i < 100; i += 1) {
      const s = (await getJson(base, `/api/chat/turns/${h.turn_id}`)).body.turn.status;
      if (s !== 'queued' && s !== 'starting') break;
      await sleep(50);
    }
    const c = await postJson(base, `/api/chat/turns/${h.turn_id}/cancel`, {});
    assert.equal(c.status, 200);
    const turn = await waitTurn(base, h.turn_id);
    assert.equal(turn.turn.status, 'interrupted');
    assert.equal(turn.turn.error.kind, 'cancelled');
    assert.equal(turn.turn.display_status, 'failed');
    const again = await postJson(base, `/api/chat/turns/${h.turn_id}/cancel`, {});
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'TURN_NOT_ACTIVE');
  });

  await t.test('登记：POST /api/tasks/:id/finish 没证据 400；有证据 → completed；步骤一并完成', async () => {
    const created = await postJson(base, '/api/tasks', { title: 'Agent Chat 测试：finish 接口', acceptance: 'completed 必须带证据' });
    assert.equal(created.status, 201);
    const taskId = created.body.task.task_id;
    const attempt = await postJson(base, `/api/tasks/${taskId}/attempt`, { agent_id: 'claude', note: 'finish 接口自测' });
    assert.equal(attempt.status, 201);
    const no = await postJson(base, `/api/tasks/${taskId}/finish`, {});
    assert.equal(no.status, 400);
    assert.equal(no.body.code, 'EVIDENCE_REQUIRED');

    const yes = await postJson(base, `/api/tasks/${taskId}/finish`, {
      attempt_id: attempt.body.attempt.attempt_id, evidence: 'test/chat-http.test.js', note: '接口自测通过',
    });
    assert.equal(yes.status, 200, JSON.stringify(yes.body));
    assert.equal(yes.body.state.status, 'completed');
    assert.equal(yes.body.attempt.status, 'completed');
    assert.equal(yes.body.acceptance.event_type, 'acceptance_passed');
    assert.equal(yes.body.acceptance.evidence_source, 'user');
    const detail = await getJson(base, `/api/tasks/${taskId}`);
    assert.equal(detail.body.state.status, 'completed');
    assert.equal(detail.body.view.progress.done, detail.body.view.progress.total, '步骤随任务完成');
    assert.equal(detail.body.attempts[0].status, 'completed');

    const failed = await postJson(base, '/api/tasks', { title: 'Agent Chat 测试：验收不过' });
    await postJson(base, `/api/tasks/${failed.body.task.task_id}/attempt`, { agent_id: 'dsh' });
    const nope = await postJson(base, `/api/tasks/${failed.body.task.task_id}/finish`, { evidence: 'x', result: 'failed' });
    assert.equal(nope.status, 200);
    assert.equal(nope.body.state.status, 'waiting', '验收不过 → 待修复，绝不是 completed');
  });
});

test('T5：重启 Node 服务，聊天历史还在；挂着的轮次被落成 interrupted', async (t) => {
  const first = await startChatServer({ fakeDelayMs: 40, keepHome: true });
  t.after(() => { try { rmSync(first.home, { recursive: true, force: true }); } catch { /* noop */ } });
  const th = await newThread(first.base, 'claude');
  const m = await send(first.base, th.thread_id, '重启前的一句话');
  await waitTurn(first.base, m.turn_id);
  const hanging = await send(first.base, th.thread_id, '[hang]');
  await sleep(300);
  assert.ok(ACTIVE.includes((await getJson(first.base, `/api/chat/turns/${hanging.turn_id}`)).body.turn.status), '重启前这一轮还在进行中');
  const before = (await getJson(first.base, `/api/chat/threads/${th.thread_id}/messages`)).body;
  await first.stop();

  const second = await startChatServer({ home: first.home, dbPath: first.dbPath, fakeDelayMs: 40 });
  t.after(() => second.stop());
  const after = await getJson(second.base, `/api/chat/threads/${th.thread_id}/messages`);
  assert.equal(after.status, 200);
  assert.deepEqual(after.body.messages.map((x) => [x.role, x.content]), before.messages.map((x) => [x.role, x.content]), '历史消息一条不少');
  assert.equal(after.body.thread_status.status, 'interrupted', '重启后没人盯着的轮次如实落成 interrupted');
  const turn = (await getJson(second.base, `/api/chat/turns/${hanging.turn_id}`)).body.turn;
  assert.equal(turn.status, 'interrupted');
  assert.equal(turn.error.kind, 'server_restarted');
  assert.equal(turn.display_status, 'failed');

  const again = await send(second.base, th.thread_id, '重启后再说一句');
  const r = await waitTurn(second.base, again.turn_id);
  assert.equal(r.turn.status, 'completed', '重启后照常能聊');
  assert.equal(r.turn.resume, true, '同一个 provider session 续聊');
});

test('E2：CLI 起不来的三种原因各说各的（路径不存在 / 命令找不到 / 不是可执行文件）', async (t) => {
  const srv = await startChatServer({ fakeDelayMs: 20, dshBin: 'C:/nope/never/dsh.cmd' });
  t.after(() => srv.stop());
  const th = await newThread(srv.base, 'dsh');
  const m = await send(srv.base, th.thread_id, '在吗');
  const turn = await waitTurn(srv.base, m.turn_id);
  assert.equal(turn.turn.status, 'failed');
  assert.equal(turn.turn.error.kind, 'cli_start_failed');
  assert.equal(turn.turn.error.reason, 'cli_path_missing');
  assert.match(turn.turn.error.message, /C:\/nope\/never\/dsh\.cmd/);
  const { body } = await assistantOf(srv.base, th.thread_id, m.turn_id);
  assert.equal(body.messages.find((x) => x.role === 'user' && x.turn_id === m.turn_id).status, 'failed');
  assert.equal(body.messages.find((x) => x.role === 'assistant' && x.turn_id === m.turn_id).status, 'failed');
  assert.equal(body.thread_status.status, 'failed');
  assert.equal(body.thread_status.reason, turn.turn.error.message);

  await srv.stop();
  const srv2 = await startChatServer({ fakeDelayMs: 20, dshBin: 'definitely-not-a-dsh-binary-xyz.cmd', keepHome: false });
  t.after(() => srv2.stop());
  const th2 = await newThread(srv2.base, 'dsh');
  const m2 = await send(srv2.base, th2.thread_id, '在吗');
  const t2 = await waitTurn(srv2.base, m2.turn_id);
  assert.equal(t2.turn.status, 'failed');
  assert.equal(t2.turn.error.reason, 'cli_not_found');
  assert.match(t2.turn.error.message, /找不到命令 definitely-not-a-dsh-binary-xyz\.cmd/);
});

test('E2：bin 指向的是目录 → 说是目录，不去起进程', async (t) => {
  const srv = await startChatServer({ fakeDelayMs: 20, dshBin: join(dirname(fileURLToPath(import.meta.url)), 'fixtures').replace(/\\/g, '/') });
  t.after(() => srv.stop());
  const th = await newThread(srv.base, 'dsh');
  const m = await send(srv.base, th.thread_id, '在吗');
  const turn = await waitTurn(srv.base, m.turn_id);
  assert.equal(turn.turn.status, 'failed');
  assert.equal(turn.turn.error.reason, 'cli_not_executable');
  assert.match(turn.turn.error.message, /是一个目录/);
});
