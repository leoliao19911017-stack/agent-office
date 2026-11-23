// chat-engine.test.js — 聊天引擎（内存库 + 假适配器，不起任何真 CLI）：
// 事件序号与 SSE 续订（P3 C1-C4）、同一对话排队串行（P5）、失败归落（P2 B5 / P5）、取消、重启对账。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../web/lib/db.mjs';
import * as store from '../web/chat/chat-db.mjs';
import { createChatEngine } from '../web/chat/chat-engine.mjs';
import { ACTIVE_TURN_STATUS, ERR, EVT, TURN, MSG } from '../web/chat/chat-state.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 假适配器：script(ctx, nth) → outcome；calls 记录每次调用，供断言调用顺序与参数 */
function fakeAdapter(script) {
  const calls = [];
  const fn = async (ctx) => { calls.push(ctx); return script(ctx, calls.length); };
  fn.calls = calls;
  return fn;
}

function makeEngine(adapters, timing = {}) {
  const db = openDb({ memory: true });
  const engine = createChatEngine({ db, adapters, claudeSettings: null, timing: { tickMs: 50, deltaFlushMs: 15, ...timing } });
  return { db, engine };
}

async function waitTerminal(db, turnId, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    const t = store.getTurn(db, turnId);
    if (t && !ACTIVE_TURN_STATUS.has(t.status)) return t;
    if (Date.now() - t0 > ms) throw new Error(`轮次 ${turnId} 没在 ${ms}ms 内走到终态（当前 ${t && t.status}）`);
    await sleep(5);
  }
}

function collector() {
  const events = [];
  const c = {
    events,
    ended: false,
    active: true,
    send: (ev) => { if (c.active) events.push(ev); },
    end: () => { c.ended = true; },
    of: (type) => events.filter((e) => e.type === type),
    async until(pred, ms = 8000) {
      const t0 = Date.now();
      for (;;) {
        const hit = events.find(pred);
        if (hit) return hit;
        if (Date.now() - t0 > ms) throw new Error(`没等到事件：${pred}（已收 ${events.length} 条：${events.map((e) => e.type).join(' ')}）`);
        await sleep(5);
      }
    },
  };
  return c;
}

function seqs(events) { return events.filter((e) => Number.isInteger(e.seq)).map((e) => e.seq); }

function assertContiguous(list, from = 1) {
  list.forEach((s, i) => assert.equal(s, from + i, `序号断了：${list.join(',')}`));
}

const goodScript = (text, { chunkDelay = 0, sessionId = 'sess-1' } = {}) => async (ctx) => {
  ctx.onEvent({ type: 'proc', pid: 4242, command: 'fake-cli --flag' });
  ctx.onEvent({ type: 'session', sessionId, resumed: Boolean(ctx.resumeId) });
  ctx.onEvent({ type: 'meta', tools: ['Read'], model: 'fake', permissionMode: 'plan' });
  for (const ch of text) {
    ctx.onEvent({ type: 'delta', text: ch });
    if (chunkDelay) await sleep(chunkDelay);
  }
  return { kind: 'completed', text, sessionId, usage: { input_tokens: 5, output_tokens: text.length } };
};

/* ------------------------------------------------------------------ P3 */

test('一轮完整跑完：序号从 1 连续递增，实时流与落库是同一串，增量拼起来等于最终回复', async () => {
  const claude = fakeAdapter(goodScript('这是假适配器的完整回复。', { chunkDelay: 2 }));
  const { db, engine } = makeEngine({ claude, dsh: claude });
  const th = store.createThread(db, { agentId: 'claude' });
  const turn = store.createTurn(db, { threadId: th.thread_id, content: '你好', provider: 'claude', resume: false });
  engine.kick(th.thread_id);
  const live = collector();
  const sub = engine.subscribe(turn.turn_id, live);
  assert.equal(sub.ok, true);
  assert.equal(sub.live, true);
  await live.until((e) => e.type === EVT.COMPLETED);
  assert.equal(live.ended, true, '终态后引擎主动 end()');

  const types = live.events.map((e) => e.type);
  assert.equal(types[0], EVT.SNAPSHOT);
  assert.ok(types.includes(EVT.STARTED), '订阅就能拿到 started（哪怕它发生在订阅之前）');
  assert.ok(types.indexOf(EVT.STARTED) < types.indexOf(EVT.DELTA), 'started 在第一个 delta 之前');
  assert.ok(types.indexOf(EVT.DELTA) < types.indexOf(EVT.COMPLETED), 'completed 在最后一个 delta 之后');
  assert.ok(live.of(EVT.DELTA).length >= 2, `delta 应该有多条（实际 ${live.of(EVT.DELTA).length}）`);

  const all = seqs(live.events);
  assertContiguous(all);
  const stored = store.listChatEvents(db, turn.turn_id);
  assert.deepEqual(stored.map((e) => e.seq), all, '库里的事件序号与实时推送的完全一致');
  assert.deepEqual(stored.map((e) => e.type), live.events.filter((e) => e.type !== EVT.SNAPSHOT).map((e) => e.type));

  const fromDeltas = live.of(EVT.DELTA).map((e) => e.text).join('');
  const finalTurn = store.getTurn(db, turn.turn_id);
  const assistant = store.getMessage(db, finalTurn.assistant_message_id);
  assert.equal(finalTurn.status, TURN.COMPLETED);
  assert.equal(assistant.content, '这是假适配器的完整回复。');
  assert.equal(fromDeltas, assistant.content, '增量拼起来 = 最终完整回复');
  assert.equal(assistant.status, MSG.COMPLETE);
  assert.equal(live.of(EVT.COMPLETED)[0].message_id, assistant.message_id);
  assert.equal(store.getMessage(db, finalTurn.user_message_id).status, MSG.SENT);
  assert.equal(store.getThread(db, th.thread_id).provider_session_id, 'sess-1', '首轮拿到的 provider session 被保存');
  assert.ok(store.listChatEvents(db, turn.turn_id).some((e) => e.type === EVT.STATUS && e.payload && e.payload.cli_command === 'fake-cli --flag'), '真正执行的命令行留了证');
});

test('断线重连：带 Last-Event-ID 续订只补 seq 之后的，不重复不丢', async () => {
  const claude = fakeAdapter(goodScript('零一二三四五六七八九十一二三四五六七八', { chunkDelay: 12 }));
  const { db, engine } = makeEngine({ claude, dsh: claude });
  const th = store.createThread(db, { agentId: 'claude' });
  const turn = store.createTurn(db, { threadId: th.thread_id, content: '慢慢说', provider: 'claude', resume: false });
  engine.kick(th.thread_id);

  const first = collector();
  const sub1 = engine.subscribe(turn.turn_id, first);
  await first.until((e) => e.type === EVT.DELTA && e.seq >= 6);   // 收到几条之后「断线」
  first.active = false;
  sub1.unsubscribe();

  await sleep(60);   // 断线期间事件继续发生、落库

  const lastSeen = Math.max(...seqs(first.events));
  const second = collector();
  const sub2 = engine.subscribe(turn.turn_id, second, { afterSeq: lastSeen });
  await second.until((e) => e.type === EVT.COMPLETED);
  assert.equal(second.ended, true);

  const snap = second.events[0];
  assert.equal(snap.type, EVT.SNAPSHOT);
  assert.equal(snap.replay_from, lastSeen);
  assert.equal(snap.event_seq >= lastSeen, true);

  const secondSeqs = seqs(second.events);
  assert.ok(secondSeqs.every((s) => s > lastSeen), `重连后不该再收到 ≤ ${lastSeen} 的事件（实际从 ${secondSeqs[0]} 起）`);
  const union = [...new Set([...seqs(first.events), ...secondSeqs])].sort((a, b) => a - b);
  assertContiguous(union, 1);
  assert.equal(union.length, seqs(first.events).length + secondSeqs.length, '两边没有重复的序号');

  const text = [...first.of(EVT.DELTA), ...second.of(EVT.DELTA)].sort((a, b) => a.seq - b.seq).map((e) => e.text).join('');
  const finalTurn = store.getTurn(db, turn.turn_id);
  assert.equal(text, store.getMessage(db, finalTurn.assistant_message_id).content, '两段拼起来 = 完整回复，一字不丢一字不重');
  assert.equal(claude.calls.length, 1, '重连不会让 CLI 再跑一次');
});

test('已经结束的轮次：订阅拿到 snapshot + 全过程回放 + completed，然后连接结束', async () => {
  const claude = fakeAdapter(goodScript('答案'));
  const { db, engine } = makeEngine({ claude, dsh: claude });
  const th = store.createThread(db, { agentId: 'claude' });
  const turn = store.createTurn(db, { threadId: th.thread_id, content: '问', provider: 'claude', resume: false });
  engine.kick(th.thread_id);
  await waitTerminal(db, turn.turn_id);

  const c = collector();
  const sub = engine.subscribe(turn.turn_id, c);
  assert.equal(sub.live, false);
  assert.equal(c.ended, true);
  const types = c.events.map((e) => e.type);
  assert.deepEqual(types.slice(0, 2), [EVT.SNAPSHOT, EVT.STARTED], '这一轮的第一条事件就是 started');
  assert.equal(types[types.length - 1], EVT.COMPLETED);
  assert.equal(c.events[0].text, '答案');
  assert.equal(c.events[0].status, TURN.COMPLETED);

  const tail = collector();
  engine.subscribe(turn.turn_id, tail, { afterSeq: store.lastEventSeq(db, turn.turn_id) });
  assert.deepEqual(tail.events.map((e) => e.type), [EVT.SNAPSHOT], '已经收到最后一条的人重连：只有快照，不再重放');
  assert.equal(tail.ended, true);
});

test('出错：error 事件带具体的 code / reason / text', async () => {
  const claude = fakeAdapter(async () => ({ kind: ERR.CLI_START_FAILED, reason: 'cli_path_missing', message: '找不到 CLI：C:/nope/dsh.cmd 这个路径上没有文件' }));
  const { db, engine } = makeEngine({ claude, dsh: claude });
  const th = store.createThread(db, { agentId: 'claude' });
  const turn = store.createTurn(db, { threadId: th.thread_id, content: '在吗', provider: 'claude', resume: false });
  engine.kick(th.thread_id);
  const c = collector();
  engine.subscribe(turn.turn_id, c);
  const err = await c.until((e) => e.type === EVT.ERROR);
  assert.equal(err.code, ERR.CLI_START_FAILED);
  assert.equal(err.reason, 'cli_path_missing');
  assert.match(err.text, /C:\/nope\/dsh\.cmd/);
  assert.equal(err.label, 'Agent 启动失败');
  assert.equal(err.status, TURN.FAILED);
  assert.equal(c.ended, true);
});

/* ------------------------------------------------------------------ P5 */

test('同一对话不能并发：第二条一直排队，等第一条结束才开始；不同对话互不等待', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const seen = [];
  const claude = fakeAdapter(async (ctx) => {
    seen.push(ctx.prompt);
    if (ctx.prompt === '第一条') await gate;
    return { kind: 'completed', text: `回：${ctx.prompt}`, sessionId: 's' };
  });
  const { db, engine } = makeEngine({ claude, dsh: claude });
  const th = store.createThread(db, { agentId: 'claude' });
  const other = store.createThread(db, { agentId: 'claude' });
  const t1 = store.createTurn(db, { threadId: th.thread_id, content: '第一条', provider: 'claude', resume: false });
  const t2 = store.createTurn(db, { threadId: th.thread_id, content: '第二条', provider: 'claude', resume: true });
  const t3 = store.createTurn(db, { threadId: other.thread_id, content: '别的对话', provider: 'claude', resume: false });
  engine.kick(th.thread_id);
  engine.kick(other.thread_id);
  await sleep(40);

  assert.equal(store.getTurn(db, t1.turn_id).status, TURN.STARTING);
  assert.equal(store.getTurn(db, t2.turn_id).status, TURN.QUEUED, '第二条在排队');
  assert.equal(store.queuedAhead(db, store.getTurn(db, t2.turn_id)), 1, '第二条前面还有 1 条');
  assert.deepEqual(seen, ['第一条', '别的对话'], '同一对话的第二条没被起跑；另一个对话照常跑');

  release();
  await waitTerminal(db, t2.turn_id);
  await waitTerminal(db, t3.turn_id);
  assert.deepEqual(seen, ['第一条', '别的对话', '第二条'], '第一条结束后第二条才起跑');
  assert.equal(claude.calls[2].resumeId, 's', '第二条用第一条拿到的 session 续聊');
  const started2 = store.listChatEvents(db, t2.turn_id).find((e) => e.type === EVT.RESTORING || e.type === EVT.STARTED);
  assert.ok(started2.payload.queued_ms >= 30, `排队时长留证（${started2.payload.queued_ms}ms）`);
});

test('启动失败：轮次 failed、原因具体；这句话没交给模型 → 用户消息也是 failed', async () => {
  const claude = fakeAdapter(async () => ({ kind: ERR.CLI_START_FAILED, reason: 'cli_not_found', message: '找不到命令 dsh：系统里没有这个可执行文件' }));
  const { db, engine } = makeEngine({ claude, dsh: claude });
  const th = store.createThread(db, { agentId: 'claude' });
  const turn = store.createTurn(db, { threadId: th.thread_id, content: '在吗', provider: 'claude', resume: false });
  engine.kick(th.thread_id);
  const t = await waitTerminal(db, turn.turn_id);
  assert.equal(t.status, TURN.FAILED);
  assert.equal(t.error.kind, ERR.CLI_START_FAILED);
  assert.equal(t.error.code, ERR.CLI_START_FAILED);
  assert.equal(t.error.reason, 'cli_not_found');
  assert.match(t.error.message, /找不到命令 dsh/);
  assert.equal(t.error.label, 'Agent 启动失败');
  assert.equal(store.getMessage(db, t.user_message_id).status, MSG.FAILED);
  assert.equal(store.getMessage(db, t.assistant_message_id).status, MSG.FAILED);
  assert.equal(store.threadStatusOf(db, store.getThread(db, th.thread_id)).status, TURN.FAILED);
});

test('工作目录不存在：不去起进程，直接 failed 并说明是哪个目录', async () => {
  const claude = fakeAdapter(goodScript('不该跑到这里'));
  const { db, engine } = makeEngine({ claude, dsh: claude });
  const missing = join(mkdtempSync(join(tmpdir(), 'chat-ws-')), 'nope');
  const th = store.createThread(db, { agentId: 'claude', workspace: missing });
  const turn = store.createTurn(db, { threadId: th.thread_id, content: '在吗', provider: 'claude', resume: false });
  engine.kick(th.thread_id);
  const t = await waitTerminal(db, turn.turn_id);
  assert.equal(claude.calls.length, 0);
  assert.equal(t.status, TURN.FAILED);
  assert.equal(t.error.reason, 'workspace_not_found');
  assert.match(t.error.message, /工作目录不存在/);
});

test('429 限额：轮次 rate_limited，带「额度何时重置」；在途的 retry 事件带下一次重试倒计时', async () => {
  const claude = fakeAdapter(async (ctx) => {
    ctx.onEvent({ type: 'session', sessionId: 's9', resumed: false });
    ctx.onEvent({ type: 'retry', attempt: 1, max: 10, delayMs: 1000, status: 429, error: 'rate_limit' });
    ctx.onEvent({ type: 'retry', attempt: 10, max: 10, delayMs: 38645, status: 429, error: 'rate_limit' });
    return {
      kind: ERR.QUOTA_EXHAUSTED, reason: ERR.QUOTA_EXHAUSTED, apiErrorStatus: 429,
      message: '已达到 5 小时的使用上限，限额将在 2099-01-01 09:30 重置',
      resetAt: '2099-01-01T01:30:00.000Z', retryDelayMs: 38645, retryAttempt: 10, retryMax: 10,
    };
  });
  const { db, engine } = makeEngine({ claude, dsh: claude });
  const th = store.createThread(db, { agentId: 'claude' });
  const turn = store.createTurn(db, { threadId: th.thread_id, content: '在吗', provider: 'claude', resume: false });
  engine.kick(th.thread_id);
  const c = collector();
  engine.subscribe(turn.turn_id, c);
  const err = await c.until((e) => e.type === EVT.ERROR);
  const retries = c.of(EVT.RETRY);
  assert.equal(retries.length, 2);
  assert.match(retries[0].retry_hint, /约 1 秒后第 2 次/);
  assert.ok(retries[0].retry_at, '下一次重试的绝对时间');
  assert.ok(c.of(EVT.STATUS).some((e) => e.status === TURN.RATE_LIMITED), 'CLI 自己重试期间状态如实是「请求受限」');
  assert.equal(err.status, TURN.RATE_LIMITED);
  assert.equal(err.code, ERR.QUOTA_EXHAUSTED);
  assert.equal(err.retry_at, '2099-01-01T01:30:00.000Z');
  assert.match(err.retry_hint, /01\/01 09:30 重置/);
  const t = store.getTurn(db, turn.turn_id);
  assert.equal(t.status, TURN.RATE_LIMITED);
  assert.equal(store.getMessage(db, t.assistant_message_id).status, MSG.RATE_LIMITED);
  assert.equal(store.getMessage(db, t.user_message_id).status, MSG.SENT, '话已经交出去了，不是没发出去');
  const ts = store.threadStatusOf(db, store.getThread(db, th.thread_id));
  assert.equal(ts.status, TURN.RATE_LIMITED);
  assert.match(ts.retry_hint, /重置/);
});

test('没有重置时间的纯限流：不编时间，如实说 CLI 还在自动重试', async () => {
  const claude = fakeAdapter(async () => ({ kind: ERR.RATE_LIMIT, reason: ERR.RATE_LIMIT, apiErrorStatus: 429, message: 'Request rejected (429) · rate limit of 50,000 input tokens per minute', retryDelayMs: 32249, retryAttempt: 10, retryMax: 10 }));
  const { db, engine } = makeEngine({ claude, dsh: claude });
  const th = store.createThread(db, { agentId: 'claude' });
  const turn = store.createTurn(db, { threadId: th.thread_id, content: '在吗', provider: 'claude', resume: false });
  engine.kick(th.thread_id);
  const t = await waitTerminal(db, turn.turn_id);
  assert.equal(t.status, TURN.RATE_LIMITED);
  assert.equal(t.error.retry_at, null);
  assert.equal(t.error.retry_hint, '稍后可以重试；CLI 已自动重试 10/10 次仍未通过', '轮次已结束，不再说「正在重试」');
  assert.deepEqual(t.error.retried, { attempt: 10, max: 10 });
});

test('进程崩溃 / 引擎拿不到结果：interrupted / unknown，绝不是 completed', async () => {
  const claude = fakeAdapter(async (ctx, n) => (n === 1
    ? { kind: ERR.CRASHED, reason: 'crashed', message: 'CLI 异常退出（exit 3221225794）' }
    : { kind: ERR.UNKNOWN, message: 'CLI 退出但没有 result 事件' }));
  const { db, engine } = makeEngine({ claude, dsh: claude });
  const th = store.createThread(db, { agentId: 'claude' });
  const a = store.createTurn(db, { threadId: th.thread_id, content: '一', provider: 'claude', resume: false });
  const b = store.createTurn(db, { threadId: th.thread_id, content: '二', provider: 'claude', resume: true });
  engine.kick(th.thread_id);
  const ta = await waitTerminal(db, a.turn_id);
  const tb = await waitTerminal(db, b.turn_id);
  assert.equal(ta.status, TURN.INTERRUPTED);
  assert.equal(tb.status, TURN.UNKNOWN);
});

test('取消：排队中的直接停（不起 CLI）；在跑的收到 abort 后落 interrupted，已收到的内容保留', async () => {
  const claude = fakeAdapter(async (ctx) => {
    if (ctx.prompt === '跑着的') {
      ctx.onEvent({ type: 'delta', text: '已经写了一半' });
      await new Promise((r) => { if (ctx.signal.aborted) r(); else ctx.signal.addEventListener('abort', () => r(), { once: true }); });
      return { kind: ERR.CANCELLED, text: '已经写了一半' };
    }
    return { kind: 'completed', text: '不该跑到这里' };
  });
  const { db, engine } = makeEngine({ claude, dsh: claude });
  const th = store.createThread(db, { agentId: 'claude' });
  const running = store.createTurn(db, { threadId: th.thread_id, content: '跑着的', provider: 'claude', resume: false });
  const queued = store.createTurn(db, { threadId: th.thread_id, content: '排队的', provider: 'claude', resume: true });
  engine.kick(th.thread_id);
  await sleep(30);

  const after = engine.cancel(queued.turn_id);
  assert.equal(after.status, TURN.INTERRUPTED);
  assert.equal(after.error.kind, ERR.CANCELLED);
  engine.cancel(running.turn_id);
  const tr = await waitTerminal(db, running.turn_id);
  assert.equal(tr.status, TURN.INTERRUPTED);
  assert.equal(tr.error.kind, ERR.CANCELLED);
  assert.equal(store.getMessage(db, tr.assistant_message_id).status, MSG.PARTIAL, '收到一半的内容保留，不冒充完整');
  await sleep(30);
  assert.equal(claude.calls.length, 1, '排队的那条被取消后没有起 CLI');
  assert.throws(() => engine.cancel(running.turn_id), (e) => e.statusCode === 409, '已结束的轮次不能再取消');
});

test('续聊时 provider 说会话没了：failed / session_not_found，清掉旧 session，下一句新开会话', async () => {
  const claude = fakeAdapter(async (ctx) => (ctx.resumeId
    ? { kind: ERR.SESSION_NOT_FOUND, reason: 'session_not_found', message: 'Claude 找不到会话 old（No conversation found with session ID）' }
    : { kind: 'completed', text: '新会话的回答', sessionId: 'new-sess' }));
  const { db, engine } = makeEngine({ claude, dsh: claude });
  const th = store.createThread(db, { agentId: 'claude' });
  store.setProviderSession(db, th.thread_id, 'old');
  const t1 = store.createTurn(db, { threadId: th.thread_id, content: '一', provider: 'claude', resume: true });
  engine.kick(th.thread_id);
  const a = await waitTerminal(db, t1.turn_id);
  assert.equal(a.status, TURN.FAILED);
  assert.equal(a.error.code, ERR.SESSION_NOT_FOUND);
  assert.equal(store.getThread(db, th.thread_id).provider_session_id, null, '坏 session 引用被清掉');
  assert.equal(store.getMessage(db, a.user_message_id).status, MSG.FAILED, '这句话没交出去');
  assert.ok(store.listMessages(db, th.thread_id).some((m) => m.role === 'system' && /已不存在/.test(m.content)), '如实留一条系统说明');
  const t2 = store.createTurn(db, { threadId: th.thread_id, content: '二', provider: 'claude', resume: false });
  engine.kick(th.thread_id);
  const b = await waitTerminal(db, t2.turn_id);
  assert.equal(b.status, TURN.COMPLETED);
  assert.equal(claude.calls[1].resumeId, null);
});

test('服务重启对账：库里挂着的「进行中」一律落 interrupted，不装作还在跑', async () => {
  const claude = fakeAdapter(goodScript('x'));
  const { db, engine } = makeEngine({ claude, dsh: claude });
  const th = store.createThread(db, { agentId: 'claude' });
  const t = store.createTurn(db, { threadId: th.thread_id, content: '一', provider: 'claude', resume: false });
  store.setTurnStatus(db, t.turn_id, TURN.RUNNING);
  const asst = store.appendMessage(db, { threadId: th.thread_id, turnId: t.turn_id, role: 'assistant', content: '写了三个字', status: MSG.STREAMING });
  store.attachAssistantMessage(db, t.turn_id, asst.message_id);
  const n = engine.reconcileOnStartup();
  assert.equal(n, 1);
  const after = store.getTurn(db, t.turn_id);
  assert.equal(after.status, TURN.INTERRUPTED);
  assert.equal(after.error.kind, ERR.SERVER_RESTARTED);
  assert.match(after.error.message, /已保存 5 字输出/, '「写了三个字」是 5 个字符');
  assert.equal(store.getMessage(db, asst.message_id).content, '写了三个字', '已落库的内容一字不丢');
});

/* ------------------------------------------------------------------ 口径 */

test('取不到状态就是 unknown：新对话没有任何轮次，不显示「空闲」', () => {
  const { db } = makeEngine({ claude: fakeAdapter(goodScript('x')), dsh: fakeAdapter(goodScript('x')) });
  const th = store.createThread(db, { agentId: 'dsh' });
  const ts = store.threadStatusOf(db, th);
  assert.equal(ts.status, TURN.UNKNOWN);
  assert.equal(ts.evidence_source, 'none');
  assert.match(ts.reason, /没有证据/);
  assert.equal(store.threadStatusOf(db, null).status, TURN.UNKNOWN);
});

test('没有这个 provider 的适配器：如实报 unknown，不假装回答', async () => {
  const claude = fakeAdapter(goodScript('x'));
  const { db, engine } = makeEngine({ claude });
  const th = store.createThread(db, { agentId: 'dsh' });
  const turn = store.createTurn(db, { threadId: th.thread_id, content: '在吗', provider: 'dsh', resume: false });
  engine.kick(th.thread_id);
  const t = await waitTerminal(db, turn.turn_id);
  assert.equal(t.status, TURN.UNKNOWN);
  assert.match(t.error.message, /没有 dsh 的适配器/);
});

test('最终文本与流式拼接不一致时发 replace 纠正；消息不丢（先落库再执行）', async () => {
  const claude = fakeAdapter(async (ctx) => {
    ctx.onEvent({ type: 'delta', text: 'AB' });
    ctx.onEvent({ type: 'delta', text: 'CD' });
    return { kind: 'completed', text: 'ABCDEF' };
  });
  const { db, engine } = makeEngine({ claude, dsh: claude });
  const th = store.createThread(db, { agentId: 'claude' });
  const turn = store.createTurn(db, { threadId: th.thread_id, content: '问', provider: 'claude', resume: false });
  engine.kick(th.thread_id);
  const c = collector();
  engine.subscribe(turn.turn_id, c);
  await c.until((e) => e.type === EVT.COMPLETED);
  const deltas = c.of(EVT.DELTA);
  assert.deepEqual(deltas.map((d) => d.text), ['AB', 'CD', 'ABCDEF']);
  assert.equal(deltas[0].replace, undefined);
  assert.equal(deltas[deltas.length - 1].replace, true, '最后一条是整条替换');
  const t = store.getTurn(db, turn.turn_id);
  assert.equal(store.getMessage(db, t.assistant_message_id).content, 'ABCDEF');
  assert.equal(store.getMessage(db, t.user_message_id).content, '问');
});

test('排队中的轮次也能订阅：起跑后收到 started → … → completed；排队中被取消则收到 error 并结束', async () => {
  const gates = {};
  const claude = fakeAdapter(async (ctx) => {
    if (/^占着/.test(ctx.prompt)) await new Promise((r) => { gates[ctx.prompt] = r; });
    return goodScript(`回：${ctx.prompt}`, { sessionId: 'sq' })(ctx);
  });
  const { db, engine } = makeEngine({ claude, dsh: claude });
  const th = store.createThread(db, { agentId: 'claude' });
  const busy = store.createTurn(db, { threadId: th.thread_id, content: '占着甲', provider: 'claude', resume: false });
  const queued = store.createTurn(db, { threadId: th.thread_id, content: '排队的', provider: 'claude', resume: true });
  engine.kick(th.thread_id);
  await sleep(30);

  const c = collector();
  const sub = engine.subscribe(queued.turn_id, c);
  assert.equal(sub.live, true, '排队中订阅：连接保持，等它起跑');
  assert.equal(c.events[0].type, EVT.SNAPSHOT);
  assert.equal(c.events[0].status, TURN.QUEUED);
  assert.equal(c.events[0].queued_ahead, 1);
  assert.equal(c.events.length, 1, '还没起跑，没有别的事件');
  gates['占着甲']();
  const done = await c.until((e) => e.type === EVT.COMPLETED);
  assert.equal(c.ended, true);
  const types = c.events.map((e) => e.type);
  assert.deepEqual(types.slice(0, 2), [EVT.SNAPSHOT, EVT.RESTORING], '起跑后第一条就是 restoring（它要续聊）');
  assert.equal(types[types.length - 1], EVT.COMPLETED);
  assert.equal(c.of(EVT.DELTA).map((e) => e.text).join(''), '回：排队的');
  assertContiguous(seqs(c.events));
  await waitTerminal(db, busy.turn_id);

  const busy2 = store.createTurn(db, { threadId: th.thread_id, content: '占着乙', provider: 'claude', resume: true });
  const queued2 = store.createTurn(db, { threadId: th.thread_id, content: '排队乙', provider: 'claude', resume: true });
  engine.kick(th.thread_id);
  await sleep(30);
  const c2 = collector();
  engine.subscribe(queued2.turn_id, c2);
  assert.equal(c2.events[0].status, TURN.QUEUED);
  engine.cancel(queued2.turn_id);
  const err = await c2.until((e) => e.type === EVT.ERROR);
  assert.equal(err.kind, ERR.CANCELLED);
  assert.ok(Number.isInteger(err.seq), '取消也落一条带序号的 terminal 事件');
  assert.equal(c2.ended, true, '等待的连接被结束，不会一直挂着');
  gates['占着乙']();
  await waitTerminal(db, busy2.turn_id);
  const again = collector();
  engine.subscribe(queued2.turn_id, again, { afterSeq: 0 });
  assert.deepEqual(again.events.map((e) => e.type), [EVT.SNAPSHOT, EVT.ERROR], '事后订阅能看到它被取消的记录');
});
