// api-chat.mjs — Agent Chat V1 P1：聊天三路由（HTTP 轮询，SSE 是 P3 的事）。
//
// 契约（TASK-AgentChat-分批计划 P1.3）：
//   POST /api/chat/threads              建对话，拿 thread_id
//   GET  /api/chat/threads/:id/messages 拉全部消息（含轮次状态，给轮询用）
//   POST /api/chat/threads/:id/messages 发一句话 → 立刻回 turn_id，异步执行
//
// 挂载方式与 api-tasks.mjs 同款：自己负责 405，不是本模块的路径返回 false，
// 交给 server-api.mjs 原有路由。状态判定一律来自 chat-state / chat-engine，
// 本文件不写第二套口径；引擎是 chat-engine.mjs 的进程级单例（HTTP 与对账共用）。

import { getDb } from './lib/db.mjs';
import {
  createThread, requireThread, listMessages, listTurns, createTurn, threadStatusOf,
  setThreadTitleIfEmpty,
} from './chat/chat-db.mjs';
import { chatEngine } from './chat/chat-engine.mjs';
import { CHAT_MODES, CHAT_PROVIDERS, turnStatusLabel } from './chat/chat-state.mjs';

const THREADS_PATH = /^\/api\/chat\/threads$/;
const THREAD_MESSAGES_PATH = /^\/api\/chat\/threads\/([A-Za-z0-9][A-Za-z0-9_-]{0,95})\/messages$/;

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

/** 轮次的对外视图：状态标签同源 TURN_LABEL，resume 证据原样带出（A5 靠它核对） */
function turnView(t) {
  const errorKind = t.error && t.error.kind ? t.error.kind : null;
  return {
    turn_id: t.turn_id,
    thread_id: t.thread_id,
    attempt_id: t.attempt_id,
    status: t.status,
    status_label: turnStatusLabel(t.status, errorKind),
    provider: t.provider,
    resume: t.resume,
    error: t.error,
    started_at: t.started_at,
    ended_at: t.ended_at,
    created_at: t.created_at,
  };
}

/**
 * @returns {Promise<boolean>} true=已处理；false=不是本模块的路径，交给 server-api 兜底。
 */
export async function handleChatApi(req, res, path, method, deps = {}) {
  const httpError = mkHttpError(deps);
  const normalizedMethod = String(method || 'GET').toUpperCase();

  const isThreads = THREADS_PATH.test(path);
  const mMessages = path.match(THREAD_MESSAGES_PATH);
  if (!isThreads && !mMessages) return false;

  const knownMethods = mMessages ? ['GET', 'POST'] : ['POST'];
  if (!knownMethods.includes(normalizedMethod)) {
    throw httpError(405, 'METHOD_NOT_ALLOWED', `${normalizedMethod} ${path} 不支持`);
  }

  const db = getDb();
  const nowIso = new Date().toISOString();

  // ---- POST /api/chat/threads -------------------------------------------
  if (isThreads) {
    const body = (await bodyOf(req, deps)) || {};
    const agentId = String(body.agent_id ?? body.agentId ?? '').trim();
    if (!agentId) throw httpError(400, 'BAD_AGENT', 'agent_id 必填（V1 支持：' + CHAT_PROVIDERS.join(' / ') + '）');
    const workspace = body.workspace == null ? null : String(body.workspace).trim() || null;
    const mode = body.mode == null ? 'discuss' : String(body.mode);
    if (!CHAT_MODES.includes(mode)) throw httpError(400, 'BAD_MODE', `mode 不受支持（V1 只开放：${CHAT_MODES.join(' / ')}）`);
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
      generated_at: nowIso,
      thread_id: thread.thread_id,
      thread,
    });
    return true;
  }

  const threadId = mMessages[1];

  // ---- GET /api/chat/threads/:id/messages --------------------------------
  if (normalizedMethod === 'GET') {
    const thread = requireThread(db, threadId);   // 不存在 → 404 THREAD_NOT_FOUND
    const messages = listMessages(db, threadId);
    const turns = listTurns(db, threadId).map(turnView);
    deps.sendJson(res, 200, {
      ok: true,
      generated_at: new Date().toISOString(),
      thread,
      messages,
      turns,
      thread_status: threadStatusOf(db, thread),
    });
    return true;
  }

  // ---- POST /api/chat/threads/:id/messages -------------------------------
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
    turn: turnView(fresh),
    poll: { href: `/api/chat/threads/${threadId}/messages`, note: '异步执行，轮询此地址看轮次状态与助手消息' },
  });
  return true;
}
