// chat-engine.mjs — 聊天引擎：排队、起 CLI、把事件落库并推给 SSE 订阅者、取消、重启对账。
//
// 并发口径（ADR-05）：
//   同一个对话（thread）里的轮次严格串行——一个原生 Session 同一时刻只能有一个 CLI 在续；
//   不同对话之间互不等待，各起各的 CLI，可以并行。
//   V1 只有讨论模式（只读），聊天不产生任何写操作，所以不去抢 write_owner；
//   将来开工作模式时，写之前必须走任务系统的 acquireWriteOwner，且锁的是「一次写操作」而不是整个会话。
//
// 隔离口径（ADR-03 / §3.3）：引擎只写 chat_* 六张表；不建 attempts、不写 events、不碰任务用的 Session。
//   每个对话用自己的 provider Session；任务执行用的 Session 由任务系统管，这里从不引用。
//
// 事件与续订（§6.1「SSE 断开 → 重连并补发，不重复执行 CLI」）：
//   CLI 只由引擎跑，跟有没有人在看无关。每条事件先落 chat_events 再推给在线订阅者；
//   订阅者（含断线重连的）先拿一条 snapshot（助手消息当前全文 + 已落库事件序号 event_seq），
//   再收 event_seq 之后的事件，然后接实时流——不重、不漏，也不会再起一次 CLI。
//   增量文本为省库是攒批落盘的（200ms 或 1KB 一次），实时订阅者仍然逐条收到。
import { getDb, REPO_ROOT } from '../lib/db.mjs';
import { isPidAlive } from '../lib/attempts.mjs';
import * as store from './chat-db.mjs';
import { ACTIVE_TURN_STATUS, ERR, EVT, errorLabel, isRetryable, MSG, statusForError, TURN } from './chat-state.mjs';
import { killTree } from './proc.mjs';
import { runClaudeTurn } from './adapters/claude-chat.mjs';
import { runDshTurn } from './adapters/dsh-chat.mjs';

const DEFAULT_TIMING = {
  stallWarnMs: 60 * 1000,          // 这么久没有新事件就提示「长时间无新事件，正在核实」（不按耗时判死）
  maxTurnMs: 30 * 60 * 1000,       // 单轮硬上限：到了由引擎停止，状态是 interrupted（是我们停的，不是它死了）
  deltaFlushMs: 200,               // 增量落库的最小间隔
  deltaFlushChars: 1024,           // 攒够这么多字符也立刻落库
  tickMs: 5000,
};

const TERMINAL_TYPES = new Set([EVT.COMPLETED, EVT.ERROR]);

function httpErr(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}

function pickUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    input_tokens: n(usage.input_tokens),
    output_tokens: n(usage.output_tokens),
    cache_read_input_tokens: n(usage.cache_read_input_tokens),
    cache_creation_input_tokens: n(usage.cache_creation_input_tokens),
  };
}

function clip(value, max = 300) {
  if (value === undefined || value === null) return null;
  const text = typeof value === 'string' ? value : (() => { try { return JSON.stringify(value); } catch { return String(value); } })();
  return String(text).slice(0, max);
}

/** 助手消息的终态：完整 / 请求受限 / 没发出去 / 没跑完但留了部分内容 */
function assistantStatusOf(kind, text) {
  if (kind === 'completed') return MSG.COMPLETE;
  if (kind === ERR.RATE_LIMIT || kind === ERR.QUOTA_EXHAUSTED) return MSG.RATE_LIMITED;
  if (kind === ERR.CLI_START_FAILED || kind === ERR.CREDENTIALS_MISSING) return MSG.FAILED;
  if (kind === ERR.UNKNOWN) return MSG.UNKNOWN;
  return text ? MSG.PARTIAL : MSG.INTERRUPTED;
}

/**
 * @param {object} opts
 * @param {object} [opts.db]         不传则用进程级单例库
 * @param {object} [opts.adapters]   { claude, dsh }：({prompt, resumeId, cwd, signal, onEvent}) => outcome；测试可注入假的
 * @param {object} [opts.timing]     覆盖 DEFAULT_TIMING
 */
export function createChatEngine(opts = {}) {
  const db = opts.db || getDb();
  const adapters = opts.adapters || { claude: runClaudeTurn, dsh: runDshTurn };
  const T = { ...DEFAULT_TIMING, ...(opts.timing || {}) };

  const active = new Map();      // turn_id → run
  const draining = new Map();    // thread_id → 正在排空的 Promise

  let ticker = null;
  function ensureTicker() {
    if (ticker) return;
    ticker = setInterval(tick, T.tickMs);
    if (ticker.unref) ticker.unref();   // 不为了它拖着进程不退出
  }
  function stopTickerIfIdle() {
    if (ticker && active.size === 0) { clearInterval(ticker); ticker = null; }
  }

  /* ---------------- 事件：落库 + 推送 ---------------- */

  function flushDeltas(run) {
    if (run.flushTimer) { clearTimeout(run.flushTimer); run.flushTimer = null; }
    if (!run.pendingText) return;
    const text = run.pendingText;
    run.pendingText = '';
    // 攒批的那几条增量合成一行，序号另取一个新的（不与已落库的非增量事件撞号）
    const seq = ++run.seq;
    store.appendChatEvent(db, {
      turnId: run.turnId, seq, type: EVT.DELTA, payload: { text },
      messageId: run.assistantMessageId, content: run.text,
    });
  }

  function scheduleFlush(run) {
    if (run.flushTimer) return;
    run.flushTimer = setTimeout(() => { run.flushTimer = null; if (!run.finished) flushDeltas(run); }, T.deltaFlushMs);
  }

  function send(run, ev) {
    for (const sub of run.subscribers) {
      try { sub.send(ev); } catch { /* 单个订阅者写失败不影响其它 */ }
    }
  }

  /** 非增量事件：先把攒着的增量落库，再落自己（保证 message.event_seq 之前的文本都在 content 里） */
  function publish(run, type, payload = {}) {
    flushDeltas(run);
    const ev = { seq: ++run.seq, type, turn_id: run.turnId, at: new Date().toISOString(), ...payload };
    store.appendChatEvent(db, {
      turnId: run.turnId, seq: ev.seq, type,
      payload: { ...payload }, messageId: run.assistantMessageId,
    });
    send(run, ev);
    return ev;
  }

  function onDelta(run, { text, replace }) {
    if (typeof text !== 'string' || text === '') return;
    if (replace) {
      run.text = text;
      run.pendingText = text;      // 以 CLI 最终文本为准：整条重发，订阅端用替换语义
    } else {
      run.text += text;
      run.pendingText += text;
    }
    run.lastEventAt = Date.now();
    send(run, { seq: ++run.seq, type: EVT.DELTA, text, replace: replace ? true : undefined });
    if (run.pendingText.length >= T.deltaFlushChars) flushDeltas(run);
    else scheduleFlush(run);
  }

  function setStatus(run, status) {
    if (run.status === status) return;
    run.status = status;
    store.setTurnStatus(db, run.turnId, status);
    publish(run, EVT.STATUS, { status, label: null });
  }

  function emitStatus(run, extra = {}) {
    publish(run, EVT.STATUS, { status: run.status, ...extra });
  }

  /* ---------------- 适配器事件 → 状态 / 事件 ---------------- */

  function onAdapterEvent(run, ev) {
    if (run.finished) return;
    switch (ev.type) {
      case 'proc':
        run.pid = ev.pid;
        run.lastEventAt = Date.now();
        return;
      case 'session':
        if (ev.sessionId && ev.sessionId !== run.providerSessionId) {
          run.providerSessionId = ev.sessionId;
          store.setProviderSession(db, run.threadId, ev.sessionId);
        }
        emitStatus(run, { provider_session_id: ev.sessionId, resumed: Boolean(ev.resumed) });
        return;
      case 'meta':
        emitStatus(run, { tools: Array.isArray(ev.tools) ? ev.tools : null, model: ev.model || null, permission_mode: ev.permissionMode || null });
        return;
      case 'delta':
        onDelta(run, ev);
        if (run.status !== TURN.RUNNING) setStatus(run, TURN.RUNNING);
        run.retrying = false;
        run.stallWarned = false;
        return;
      case 'tool':
        run.toolOpen = true;
        if (run.status !== TURN.TOOL_RUNNING) setStatus(run, TURN.TOOL_RUNNING);
        publish(run, EVT.TOOL, { phase: ev.phase || 'call', id: ev.id || null, name: ev.name || null, input: clip(ev.input, 300) });
        return;
      case 'tool_result':
        run.toolOpen = false;
        publish(run, EVT.TOOL, { phase: 'result', id: ev.id || null, is_error: ev.isError === true, text: clip(ev.text, 600) });
        if (run.status === TURN.TOOL_RUNNING) setStatus(run, TURN.RUNNING);
        return;
      case 'retry':
        // CLI 自己在退避重试（实测 Claude 对 429 最多 10 次）：如实显示「请求受限」，不另起一层重试
        run.retrying = true;
        if (run.status !== TURN.RATE_LIMITED) setStatus(run, TURN.RATE_LIMITED);
        publish(run, EVT.RETRY, {
          attempt: ev.attempt ?? null, max: ev.max ?? null, delay_ms: ev.delayMs ?? null,
          http_status: ev.status ?? null, error: ev.error || null,
        });
        return;
      case 'approval': {
        const status = store.appendApproval(db, { turnId: run.turnId, action: ev.action });
        setStatus(run, TURN.APPROVAL_REQUIRED);
        emitStatus(run, {
          approval_required: true, approval_id: status.approval_id, decision: 'denied',
          note: '讨论模式不放行任何需要确认的操作；CLI 已按「从不审批」的策略拒绝',
        });
        setStatus(run, TURN.RUNNING);
        return;
      }
      case 'liveness':
      default:
        run.lastEventAt = Date.now();
        run.stallWarned = false;
        // 重试之后又来了新输出，说明请求已经过去，状态从「请求受限」回到正常
        if (run.retrying && !(ev.source === 'synthetic')) {
          run.retrying = false;
          if (run.status === TURN.RATE_LIMITED) setStatus(run, run.toolOpen ? TURN.TOOL_RUNNING : TURN.RUNNING);
        }
    }
  }

  /* ---------------- 一轮的执行 ---------------- */

  function finish(run, outcome) {
    if (run.finished) return;
    run.finished = true;
    if (run.flushTimer) { clearTimeout(run.flushTimer); run.flushTimer = null; }
    const kind = outcome && outcome.kind ? outcome.kind : ERR.UNKNOWN;
    const status = kind === 'completed' ? TURN.COMPLETED : statusForError(kind);
    // 结局文本以适配器给的为准；和已推给界面的不一致就发一条 replace 纠正
    const finalText = typeof outcome.text === 'string' ? outcome.text : run.text;
    if (finalText !== run.text) onDelta(run, { text: finalText, replace: true });
    flushDeltas(run);

    const error = kind === 'completed' ? null : {
      kind,
      label: errorLabel(kind),
      message: String((outcome && outcome.message) || '').slice(0, 800),
      retryable: isRetryable(kind),
      api_error_status: outcome && outcome.api_error_status != null ? outcome.api_error_status : null,
    };
    run.status = status;
    store.finishTurn(db, run.turnId, { status, error });
    store.setMessageStatus(db, run.assistantMessageId, assistantStatusOf(kind, finalText), { error });

    // 用户消息：CLI 起来了就算交出去了；没起来就是没发出去（内容仍在库里）
    const reachedCli = kind !== ERR.CLI_START_FAILED && kind !== ERR.CREDENTIALS_MISSING;
    store.setMessageStatus(db, run.userMessageId, reachedCli ? MSG.SENT : MSG.FAILED, { error: reachedCli ? null : error });

    // provider 说会话没了：清掉引用，下一句重新开会话（如实记一条系统消息，旧上下文不保留）
    if (kind === ERR.SESSION_NOT_FOUND) {
      store.clearProviderSession(db, run.threadId);
      store.appendMessage(db, {
        threadId: run.threadId, role: 'system',
        content: `原会话 ${run.providerSessionId || ''} 已不存在，下一句会新开一个会话；之前的上下文不会带过去。`,
        status: MSG.COMPLETE,
      });
    }

    const base = { turn_id: run.turnId, status, text_len: finalText.length };
    if (kind === 'completed') {
      publish(run, EVT.COMPLETED, {
        ...base, message_id: run.assistantMessageId, usage: pickUsage(outcome.usage),
        num_turns: outcome.numTurns ?? null, duration_ms: outcome.durationMs ?? null,
        provider_session_id: run.providerSessionId,
      });
    } else {
      publish(run, EVT.ERROR, { ...base, ...error, provider_session_id: run.providerSessionId });
    }
    for (const sub of run.subscribers) { try { sub.end(); } catch { /* 已断开 */ } }
    run.subscribers.clear();
  }

  async function runTurn(turn) {
    const thread = store.getThread(db, turn.thread_id);
    const userMsg = store.getMessage(db, turn.user_message_id);
    if (!thread || !userMsg) {
      store.finishTurn(db, turn.turn_id, { status: TURN.INTERRUPTED, error: { kind: ERR.UNKNOWN, label: errorLabel(ERR.UNKNOWN), message: '对话或用户消息不见了，本轮无法执行', retryable: false } });
      return;
    }
    const assistant = store.appendMessage(db, { threadId: thread.thread_id, turnId: turn.turn_id, role: 'assistant', content: '', status: MSG.STREAMING });
    store.attachAssistantMessage(db, turn.turn_id, assistant.message_id);

    const run = {
      turnId: turn.turn_id, threadId: thread.thread_id, agentId: thread.agent_id,
      providerSessionId: thread.provider_session_id || null,
      abort: new AbortController(), pid: null,
      seq: store.lastEventSeq(db, turn.turn_id),
      assistantMessageId: assistant.message_id, userMessageId: userMsg.message_id,
      subscribers: new Set(),
      text: '', pendingText: '', flushTimer: null,
      status: null, retrying: false, toolOpen: false,
      lastEventAt: Date.now(), startedAt: Date.now(), stallWarned: false, finished: false,
    };
    active.set(run.turnId, run);
    ensureTicker();

    const resume = Boolean(thread.provider_session_id);
    try {
      setStatus(run, resume ? TURN.RESTORING : TURN.STARTING);
      publish(run, resume ? EVT.RESTORING : EVT.STARTED, {
        provider: thread.agent_id, resume,
        provider_session_id: thread.provider_session_id || null,
        workspace: thread.workspace, mode: thread.mode, attempt_id: turn.attempt_id,
      });
      store.setMessageStatus(db, run.userMessageId, MSG.SENT);

      const adapter = adapters[thread.agent_id];
      let outcome;
      if (typeof adapter !== 'function') {
        outcome = { kind: ERR.UNKNOWN, message: `没有 ${thread.agent_id} 的适配器`, text: '' };
      } else {
        outcome = await adapter({
          prompt: userMsg.content,
          resumeId: thread.provider_session_id || null,
          cwd: thread.workspace || REPO_ROOT,
          signal: run.abort.signal,
          onEvent: (ev) => onAdapterEvent(run, ev),
        });
      }
      finish(run, outcome);
    } catch (err) {
      finish(run, { kind: ERR.UNKNOWN, message: `引擎异常：${err && err.message ? err.message : err}`, text: run.text });
    } finally {
      active.delete(run.turnId);
      stopTickerIfIdle();
    }
  }

  /** 把一个对话里排队的轮次按先后顺序跑完（同一 thread 串行；不同 thread 各跑各的） */
  function kick(threadId) {
    if (draining.has(threadId)) return;
    const p = (async () => {
      for (;;) {
        const next = store.nextQueuedTurn(db, threadId);
        if (!next) return;
        await runTurn(next);
      }
    })()
      .catch((err) => { console.error(`[chat] 对话 ${threadId} 执行出错：${err && err.message}`); })
      .finally(() => {
        draining.delete(threadId);
        if (store.nextQueuedTurn(db, threadId)) kick(threadId);   // 兜底：刚排进来的不能漏
      });
    draining.set(threadId, p);
  }

  /* ---------------- 看门：长时间没事件只提示不判死；到硬上限才由我们停 ---------------- */

  function tick() {
    const now = Date.now();
    for (const run of [...active.values()]) {
      if (run.finished) continue;
      const idle = now - run.lastEventAt;
      if (!run.stallWarned && idle >= T.stallWarnMs) {
        run.stallWarned = true;
        const alive = run.pid != null ? isPidAlive(run.pid) : null;   // 核实：进程到底还在不在
        emitStatus(run, {
          stalled: true, idle_ms: idle, process_alive: alive,
          message: alive === true
            ? `长时间无新事件，正在核实：CLI 进程仍在（pid ${run.pid}），还没收到新的输出`
            : alive === false
              ? '长时间无新事件，正在核实：CLI 进程已经退出，正在等它收尾'
              : '长时间无新事件，正在核实',
        });
      }
      if (now - run.startedAt >= T.maxTurnMs) {
        run.abort.abort({ kind: ERR.TIMEOUT_CAP });
      }
    }
  }

  /* ---------------- 对外：订阅 / 取消 / 对账 / 停机 ---------------- */

  function fromRow(row) {
    return { ...(row.payload || {}), seq: row.seq, type: row.type, turn_id: row.turn_id, at: row.created_at };
  }

  function terminalEventOf(turn, msg) {
    const textLen = msg ? msg.content.length : 0;
    if (turn.status === TURN.COMPLETED) return { type: EVT.COMPLETED, turn_id: turn.turn_id, status: turn.status, text_len: textLen };
    return {
      type: EVT.ERROR, turn_id: turn.turn_id, status: turn.status, text_len: textLen,
      kind: turn.error ? turn.error.kind : ERR.UNKNOWN,
      label: turn.error ? turn.error.label : errorLabel(ERR.UNKNOWN),
      message: turn.error ? turn.error.message : '没有可靠证据说明本轮结果',
      retryable: turn.error ? turn.error.retryable !== false : false,
    };
  }

  /**
   * 订阅一轮的事件流。listener = { send(ev), end() }。
   * 同步完成「快照 → 补发 → 挂实时」，中间不会漏事件。
   * @returns {{ok:boolean, code?:string, live:boolean}} live=false 表示已终态，事件已全部交给 listener 并调用过 end()
   */
  function subscribe(turnId, listener) {
    const turn = store.getTurn(db, turnId);
    if (!turn) return { ok: false, code: 'TURN_NOT_FOUND' };
    const run = active.get(turnId) || null;
    if (run) flushDeltas(run);     // 内存里还没落库的增量先落下去，快照才是最新的
    const msg = turn.assistant_message_id ? store.getMessage(db, turn.assistant_message_id) : null;
    const eventSeq = msg ? (msg.event_seq || 0) : 0;
    listener.send({
      type: EVT.SNAPSHOT, turn_id: turnId, at: new Date().toISOString(),
      status: turn.status, text: msg ? msg.content : '', event_seq: eventSeq,
      error: turn.error || null, resume: Boolean(turn.resume),
    });
    let sawTerminal = false;
    for (const row of store.listChatEvents(db, turnId, { afterSeq: eventSeq })) {
      if (TERMINAL_TYPES.has(row.type)) sawTerminal = true;
      listener.send(fromRow(row));
    }
    if (!run || !ACTIVE_TURN_STATUS.has(turn.status)) {
      if (!sawTerminal) listener.send(terminalEventOf(turn, msg));
      listener.end();
      return { ok: true, live: false };
    }
    const sub = {
      send: (ev) => listener.send(ev),
      end: () => listener.end(),
    };
    run.subscribers.add(sub);
    listener.onSubscribed?.(() => run.subscribers.delete(sub));
    return { ok: true, live: true };
  }

  /** 取消一轮：排队中的直接落 interrupted；在跑的杀进程树，由适配器回来收尾 */
  function cancel(turnId) {
    const turn = store.requireTurn(db, turnId);
    const run = active.get(turnId) || null;
    if (run && !run.finished) {
      run.abort.abort({ kind: ERR.CANCELLED });
      return store.getTurn(db, turnId);
    }
    if (!ACTIVE_TURN_STATUS.has(turn.status)) {
      throw httpErr(409, 'TURN_NOT_ACTIVE', `这一轮已经结束（${turn.status}），不能取消`);
    }
    const error = { kind: ERR.CANCELLED, label: errorLabel(ERR.CANCELLED), message: '发送前已停止', retryable: true };
    store.finishTurn(db, turnId, { status: TURN.INTERRUPTED, error });
    if (turn.user_message_id) store.setMessageStatus(db, turn.user_message_id, MSG.FAILED, { error });
    return store.getTurn(db, turnId);
  }

  /** 服务启动时：库里还「在进行中」的轮次本进程并没有在跑，一律落成 interrupted */
  function reconcileOnStartup() {
    return store.reconcileActiveTurns(db, { kind: ERR.SERVER_RESTARTED, message: '服务重启，本轮执行中断' });
  }

  /** 服务停止时：先把在跑的轮次落库成 interrupted，再杀 CLI 进程树，不等它们自己结束 */
  function shutdown() {
    let n = 0;
    for (const run of [...active.values()]) {
      n += 1;
      finish(run, { kind: ERR.SERVER_RESTARTED, message: '服务停止，本轮执行中断', text: run.text });
      killTree(run.pid);
      run.abort.abort({ kind: ERR.SERVER_RESTARTED });
    }
    n += store.reconcileActiveTurns(db, { kind: ERR.SERVER_RESTARTED, message: '服务停止，本轮还没开始执行' });
    if (ticker) { clearInterval(ticker); ticker = null; }
    return n;
  }

  return {
    kick, subscribe, cancel,
    reconcileOnStartup, shutdown,
    /** 诊断用：本进程此刻真正在跑的轮次 */
    activeTurns: () => [...active.values()].map((r) => ({ turn_id: r.turnId, thread_id: r.threadId, status: r.status, pid: r.pid, text_len: r.text.length })),
  };
}

/** 进程级单例：HTTP 处理器、SSE 订阅、启动对账共用同一个引擎 */
let singleton = null;
export function chatEngine() {
  if (!singleton) singleton = createChatEngine();
  return singleton;
}
