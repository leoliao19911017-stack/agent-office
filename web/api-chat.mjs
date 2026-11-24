// api-chat.mjs — Agent Chat 的 HTTP 接口（P1 轮询三路由 + P3 SSE 流式 + 取消）。
//
// 契约（TASK-AgentChat-分批计划 P1.3 / P3、TASK-AgentChat-V1 §五）：
//   POST /api/chat/threads                建对话，拿 thread_id
//   GET  /api/chat/threads?agent_id=…     列对话（最近用过的在前；界面按 agent 找「它的那一个」）
//   GET  /api/chat/threads/:id            对话详情 + 当前状态（没有证据就是 unknown，不显示空闲）
//   GET  /api/chat/threads/:id/messages   拉全部消息（含轮次状态，给轮询用；P3 之后保留不删）
//   POST /api/chat/threads/:id/messages   发一句话 → 立刻回 turn_id，异步执行（同一对话排队串行）
//   GET  /api/chat/turns/:id              一轮的状态 + 全部已落库事件
//   GET  /api/chat/turns/:id/stream       SSE：snapshot → 补发 → 实时；事件 started / delta / completed / error …
//   POST /api/chat/turns/:id/cancel       取消本轮（排队中的直接停；在跑的杀进程树）
//
// 挂载方式与 api-tasks.mjs 同款：自己负责 405，不是本模块的路径返回 false，
// 交给 server-api.mjs 原有路由。状态判定一律来自 chat-state / chat-engine，
// 本文件不写第二套口径；引擎是 chat-engine.mjs 的进程级单例（HTTP 与对账共用）。

import { isAbsolute } from 'node:path';
import { getDb } from './lib/db.mjs';
import { getAgent, chatSupport, listAgents } from './lib/agents.mjs';
import {
  createThread, requireThread, getThread, listThreads, listMessages, listTurns, createTurn, getTurn, threadStatusOf,
  setThreadTitleIfEmpty, listChatEvents, getMessage,
} from './chat/chat-db.mjs';
import { chatEngine } from './chat/chat-engine.mjs';
import {
  CHAT_MODES, TURN, UNSUPPORTED_REASON, displayStatusOf, DISPLAY_LABEL, isTurnActive, turnStatusLabel,
} from './chat/chat-state.mjs';
import { isDirectory } from './chat/proc.mjs';

const ID = '([A-Za-z0-9][A-Za-z0-9_-]{0,95})';
const THREADS_PATH = /^\/api\/chat\/threads$/;
const THREAD_PATH = new RegExp(`^/api/chat/threads/${ID}$`);
const THREAD_MESSAGES_PATH = new RegExp(`^/api/chat/threads/${ID}/messages$`);
const TURN_PATH = new RegExp(`^/api/chat/turns/${ID}$`);
const TURN_STREAM_PATH = new RegExp(`^/api/chat/turns/${ID}/stream$`);
const TURN_CANCEL_PATH = new RegExp(`^/api/chat/turns/${ID}/cancel$`);

/** SSE 心跳间隔：长时间没有事件（模型在想）也让连接两端知道对方还在 */
const HEARTBEAT_MS = 15000;

function mkHttpError(deps) {
  return (status, code, message) => {
    if (typeof deps.httpError === 'function') return deps.httpError(status, code, message);
    return Object.assign(new Error(message), { statusCode: status, code });
  };
}

function bodyOf(req, deps) {
  if (typeof deps.readJsonBody === 'function') return deps.readJsonBody(req);
  return Promise.resolve({});
}

/**
 * 引擎单例 + 一次性启动对账：服务重启前库里还挂着「进行中」的轮次，
 * 本进程并没有在跑它们——第一次碰到聊天请求时统一落成 interrupted
 * （与 api-tasks 的 dbReady 对账时机同理：不为了对账白白起单例）。
 */
let engineReady = null;
function engine() {
  if (!engineReady) {
    const eng = chatEngine();
    eng.reconcileOnStartup();
    engineReady = eng;
  }
  return engineReady;
}

/**
 * 轮次的对外视图：引擎的十态原样带出，另给界面五态（排队 / 执行中 / 完成 / 失败 / 未知）。
 * status_label 是具体说法（「请求受限」「Agent 启动失败」…），resume 证据原样带出（B4 靠它核对）。
 */
function turnView(t, { queue = null } = {}) {
  const errorKind = t.error && t.error.kind ? t.error.kind : null;
  const display = displayStatusOf(t.status);
  const view = {
    turn_id: t.turn_id,
    thread_id: t.thread_id,
    attempt_id: t.attempt_id,
    status: t.status,
    status_label: turnStatusLabel(t.status, errorKind),
    display_status: display,
    display_label: display === 'failed' && errorKind ? turnStatusLabel(t.status, errorKind) : DISPLAY_LABEL[display],
    provider: t.provider,
    resume: t.resume,
    user_message_id: t.user_message_id,
    assistant_message_id: t.assistant_message_id,
    error: t.error,
    started_at: t.started_at,
    ended_at: t.ended_at,
    created_at: t.created_at,
  };
  if (queue != null) view.queued_ahead = queue;
  return view;
}

function threadView(thread, extra = {}) {
  const ts = extra.thread_status || null;
  return { ...thread, thread_status: ts };
}

/** SSE 一帧：id 行让浏览器的 EventSource 断线重连时自动带 Last-Event-ID */
function sseFrame(ev) {
  let out = `event: ${ev.type}\n`;
  if (Number.isInteger(ev.seq)) out = `id: ${ev.seq}\n${out}`;
  return `${out}data: ${JSON.stringify(ev)}\n\n`;
}

/** 对方已经收到哪个 seq：优先请求头 Last-Event-ID（EventSource 自动带），其次 ?after_seq= */
function afterSeqOf(req) {
  const header = req.headers['last-event-id'];
  const raw = header != null && header !== '' ? header : new URL(req.url, 'http://127.0.0.1').searchParams.get('after_seq');
  const text = String(raw == null ? '' : raw).trim();
  return /^\d{1,12}$/.test(text) ? Number(text) : null;
}

/**
 * @returns {Promise<boolean>} true=已处理；false=不是本模块的路径，交给 server-api 兜底。
 */
export async function handleChatApi(req, res, path, method, deps = {}) {
  const httpError = mkHttpError(deps);
  const m = String(method || 'GET').toUpperCase();

  const isThreads = THREADS_PATH.test(path);
  const mThread = path.match(THREAD_PATH);
  const mMessages = path.match(THREAD_MESSAGES_PATH);
  const mTurn = path.match(TURN_PATH);
  const mStream = path.match(TURN_STREAM_PATH);
  const mCancel = path.match(TURN_CANCEL_PATH);
  if (!isThreads && !mThread && !mMessages && !mTurn && !mStream && !mCancel) return false;

  const allowed = isThreads || mMessages ? ['GET', 'POST'] : mCancel ? ['POST'] : ['GET'];
  if (!allowed.includes(m)) {
    throw httpError(405, 'METHOD_NOT_ALLOWED', `${m} ${path} 不支持`);
  }

  const db = getDb();
  // 任何聊天请求之前先把引擎备好：它的首次初始化会做启动对账（库里挂着的「进行中」
  // 轮次本进程并没有在跑 → 落成 interrupted）。读状态也要先对账，否则重启后头几次读到的还是旧的 running。
  engine();

  /* ---- GET /api/chat/threads?agent_id=… ---------------------------------- */
  if (isThreads && m === 'GET') {
    const agentId = new URL(req.url, 'http://127.0.0.1').searchParams.get('agent_id');
    const threads = listThreads(db, agentId ? { agentId } : {}).map((t) => threadView(t, { thread_status: threadStatusOf(db, t) }));
    // 不支持对话的名单也从 DB 名册算：新增 API Agent 自动可聊，禁用/未接适配器的如实说明原因。
    const unsupported = { ...UNSUPPORTED_REASON };
    for (const a of listAgents(db, { enabledOnly: true })) {
      const s = chatSupport(a);
      if (!s.supported && !unsupported[a.agent_id]) unsupported[a.agent_id] = s.reason;
    }
    deps.sendJson(res, 200, { ok: true, generated_at: new Date().toISOString(), count: threads.length, threads, unsupported });
    return true;
  }

  /* ---- POST /api/chat/threads ------------------------------------------- */
  if (isThreads) {
    const body = (await bodyOf(req, deps)) || {};
    const agentId = String(body.agent_id ?? body.agentId ?? '').trim();
    if (!agentId) throw httpError(400, 'BAD_AGENT', 'agent_id 必填');
    const agent = getAgent(db, agentId);
    const support = chatSupport(agent);
    if (!support.supported) {
      throw httpError(400, 'BAD_AGENT', `agent_id 不支持对话：${agentId}（${support.reason}）`);
    }
    let workspace = body.workspace == null ? null : String(body.workspace).trim() || null;
    if (workspace != null) {
      // 工作目录现在就得存在：CLI 要在那里起；不存在的目录等到发消息时才失败，不如建对话时就拦住
      const normalized = workspace.replace(/\\/g, '/');
      if (!isAbsolute(normalized)) throw httpError(400, 'BAD_WORKSPACE', 'workspace 必须是绝对路径');
      if (!isDirectory(normalized)) throw httpError(400, 'BAD_WORKSPACE', `工作目录不存在：${workspace}`);
      workspace = normalized;
    }
    const mode = body.mode == null ? 'discuss' : String(body.mode);
    if (!CHAT_MODES.includes(mode)) throw httpError(400, 'BAD_MODE', `mode 不受支持（只开放：${CHAT_MODES.join(' / ')}）`);
    const thread = createThread(db, {
      agentId,
      workspace,
      mode,
      taskId: body.task_id ?? body.taskId ?? null,
      taskAttemptId: body.task_attempt_id ?? body.taskAttemptId ?? null,
      title: body.title == null ? null : String(body.title),
    });
    deps.sendJson(res, 201, {
      ok: true,
      generated_at: new Date().toISOString(),
      thread_id: thread.thread_id,
      thread: threadView(thread, { thread_status: threadStatusOf(db, thread) }),
    });
    return true;
  }

  /* ---- GET /api/chat/threads/:id ---------------------------------------- */
  if (mThread) {
    const thread = requireThread(db, mThread[1]);
    const threadStatus = threadStatusOf(db, thread);
    deps.sendJson(res, 200, {
      ok: true, generated_at: new Date().toISOString(),
      thread: threadView(thread, { thread_status: threadStatus }),
      thread_status: threadStatus,
    });
    return true;
  }

  /* ---- GET|POST /api/chat/threads/:id/messages --------------------------- */
  if (mMessages) {
    const threadId = mMessages[1];
    if (m === 'GET') {
      const thread = requireThread(db, threadId);   // 不存在 → 404 THREAD_NOT_FOUND
      const messages = listMessages(db, threadId);
      // 排队中的轮次：前面还有几轮在它之前没跑完（正在跑的 + 更早排队的），界面显示「排队中，前面还有 N 条」。
      // 与 POST 的 202 响应里的 queued_ahead 同一个口径。
      const allTurns = listTurns(db, threadId);
      const running = allTurns.filter((t) => isTurnActive(t));
      const turns = allTurns.map((t) => turnView(t, {
        queue: t.status === TURN.QUEUED ? running.filter((o) => o.turn_id !== t.turn_id && o.created_at < t.created_at).length : 0,
      }));
      const threadStatus = threadStatusOf(db, thread);
      // 正在进行的几轮里最早的那一轮（turns 是新的在前）：界面接它的实时流；后面的还在排队
      threadStatus.active_turn_id = [...turns].reverse().find((t) => isTurnActive(t))?.turn_id || null;
      deps.sendJson(res, 200, {
        ok: true,
        generated_at: new Date().toISOString(),
        thread: threadView(thread, { thread_status: threadStatus }),
        messages,
        turns,
        thread_status: threadStatus,
      });
      return true;
    }

    const body = (await bodyOf(req, deps)) || {};
    const content = typeof body.content === 'string' ? body.content : '';
    if (content.trim() === '') throw httpError(400, 'BAD_CONTENT', 'content 必填（非空字符串）');
    if (content.length > 20000) throw httpError(400, 'CONTENT_TOO_LONG', 'content 太长（≤20000 字），拆成几句发');
    const thread = requireThread(db, threadId);
    // 先取引擎再建轮次：引擎首次初始化会做启动对账（把库里残留的「进行中」
    // 轮次落成 interrupted）——必须发生在新轮次入库之前，否则刚排队的这一轮
    // 会被对账误伤（实测踩过：首请求 202 回来就是 interrupted/server_restarted）。
    const eng = engine();
    // 同一对话串行排队（ADR-05）：入库即排队，引擎按序起 CLI，响应立刻返回
    const queuedAhead = listTurns(db, threadId).filter((t) => isTurnActive(t)).length;
    const turn = createTurn(db, {
      threadId,
      content,
      provider: thread.agent_id,
      resume: Boolean(thread.provider_session_id),
    });
    eng.kick(threadId);
    // 回复用 kick 之后的真实状态（可能已从 queued 走到 starting），不写死文案
    const fresh = listTurns(db, threadId).find((t) => t.turn_id === turn.turn_id) || turn;
    const firstText = content.replace(/\s+/g, ' ').trim().slice(0, 40);
    // 标题只取第一句话开头，给「历史对话」切换用；已有就不覆盖（chat-db 保证）
    if (firstText) setThreadTitleIfEmpty(db, threadId, firstText);
    deps.sendJson(res, 202, {
      ok: true,
      accepted: true,
      thread_id: threadId,
      turn_id: turn.turn_id,
      turn: turnView(fresh, { queue: fresh.status === 'queued' ? queuedAhead : 0 }),
      stream: { href: `/api/chat/turns/${turn.turn_id}/stream`, note: 'SSE 订阅本轮：snapshot → 补发 → 实时事件' },
      poll: { href: `/api/chat/threads/${threadId}/messages`, note: '轮询此地址看轮次状态与助手消息（保留兼容）' },
    });
    return true;
  }

  /* ---- GET /api/chat/turns/:id ------------------------------------------ */
  if (mTurn) {
    const turn = getTurn(db, mTurn[1]);
    if (!turn) throw httpError(404, 'TURN_NOT_FOUND', `轮次不存在：${mTurn[1]}`);
    const assistant = turn.assistant_message_id ? getMessage(db, turn.assistant_message_id) : null;
    deps.sendJson(res, 200, {
      ok: true,
      generated_at: new Date().toISOString(),
      turn: turnView(turn),
      events: listChatEvents(db, turn.turn_id).map((e) => ({ ...(e.payload || {}), seq: e.seq, type: e.type, turn_id: e.turn_id, at: e.created_at })),
      assistant_message: assistant,
    });
    return true;
  }

  /* ---- POST /api/chat/turns/:id/cancel ---------------------------------- */
  if (mCancel) {
    const turn = engine().cancel(mCancel[1]);
    deps.sendJson(res, 200, { ok: true, generated_at: new Date().toISOString(), turn: turnView(turn) });
    return true;
  }

  /* ---- GET /api/chat/turns/:id/stream（SSE）------------------------------ */
  const turnId = mStream[1];
  const existing = getTurn(db, turnId);
  if (!existing) throw httpError(404, 'TURN_NOT_FOUND', `轮次不存在：${turnId}`);   // 写头之前先把 404 发掉
  const afterSeq = afterSeqOf(req);

  let ended = false;
  let heartbeat = null;
  let unsubscribe = null;
  const cleanup = () => {
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  };
  const listener = {
    send: (ev) => { if (!ended && !res.writableEnded && !res.destroyed) res.write(sseFrame(ev)); },
    end: () => {
      if (ended) return;
      ended = true;
      cleanup();
      if (!res.writableEnded && !res.destroyed) res.end();
    },
  };

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.flushHeaders();
  if (res.socket) res.socket.setNoDelay(true);
  res.write(`retry: 1500\n\n`);   // 断线后浏览器的 EventSource 1.5 秒自动重连，并带 Last-Event-ID
  res.on('close', () => { ended = true; cleanup(); });   // 对方断开：立刻停止推送、退订

  // 三步（快照 → 补发 → 挂实时）在 subscribe 里同步完成，之后这里再起心跳
  const sub = engine().subscribe(turnId, listener, { afterSeq });
  if (!sub.ok) { listener.end(); return true; }
  if (sub.unsubscribe) unsubscribe = sub.unsubscribe;
  if (!ended && !res.destroyed && !res.writableEnded) {
    heartbeat = setInterval(() => {
      if (ended || res.writableEnded || res.destroyed) { cleanup(); return; }
      res.write(`: heartbeat ${Date.now()}\n\n`);
    }, HEARTBEAT_MS);
  }
  return true;
}
