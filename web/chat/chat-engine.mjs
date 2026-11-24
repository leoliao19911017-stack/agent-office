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
// 事件与续订（P3「断线重连按 event_seq 补发，不重复不丢」）：
//   CLI 只由引擎跑，跟有没有人在看无关。每条事件只有一个序号 seq（从 1 起严格递增），
//   同一个 seq 既写进 chat_events，又原样推给在线订阅者——实时流和落库的事件日志是同一串序号。
//   订阅（含断线重连）的顺序：先一条 snapshot（此刻的状态 + 助手消息全文 + 已落库的最大序号），
//   再补发 seq 大于「对方已经收到哪」的落库事件（没说收到哪就从头补发这一轮），然后接实时流。
//   三步在同一个同步段里完成，中间不会漏。
//   所以：重连不会重放已经收到的，也不会跳过断线期间发生的；CLI 更不会被再起一次。
//   增量文本为省库是攒批发送的（200ms 或 1KB 一次）——订阅者看到的和库里存的是同一批、同一个 seq。
import { getDb, REPO_ROOT } from '../lib/db.mjs';
import { isPidAlive } from '../lib/attempts.mjs';
import * as store from './chat-db.mjs';
import {
  ERR, EVT, FAILED_KINDS, NOT_DELIVERED_KINDS, errorLabel, isRetryable, isTurnActive, MSG, retryHint, statusForError, TURN,
} from './chat-state.mjs';
import { isDirectory, killTree, redactSecrets } from './proc.mjs';
import { runClaudeTurn, extraClaudeSettings } from './adapters/claude-chat.mjs';
import { runDshTurn } from './adapters/dsh-chat.mjs';
import { runHermesTurn } from './adapters/hermes-chat.mjs';

const DEFAULT_TIMING = {
  stallWarnMs: 60 * 1000,          // 这么久没有新事件就提示「长时间无新事件，正在核实」（不按耗时判死）
  maxTurnMs: 30 * 60 * 1000,       // 单轮硬上限：到了由引擎停止，状态是 interrupted（是我们停的，不是它死了）
  deltaFlushMs: 200,               // 增量的发送 / 落库间隔（实时流与库同一批、同一 seq）
  deltaFlushChars: 1024,           // 攒够这么多字符也立刻发
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
    input_tokens: n(usage.input_tokens ?? usage.inputTokens),
    output_tokens: n(usage.output_tokens ?? usage.outputTokens),
    cache_read_input_tokens: n(usage.cache_read_input_tokens ?? usage.cacheReadTokens),
    cache_creation_input_tokens: n(usage.cache_creation_input_tokens ?? usage.cacheWriteTokens),
  };
}

function clip(value, max = 300) {
  if (value === undefined || value === null) return null;
  const text = typeof value === 'string' ? value : (() => { try { return JSON.stringify(value); } catch { return String(value); } })();
  return String(text).slice(0, max);
}

/** 进程命令行留证用：--settings 里可能有凭据，整段抹掉；环境变量里的密钥也打码 */
function clipCommand(command, max = 600) {
  const s = String(command || '').replace(/--settings\s+\{.*\}(\s|$)/, '--settings [已省略]$1');
  return clip(redactSecrets(s, process.env), max);
}

/** 助手消息的终态：完整 / 请求受限 / 没跑成 / 没跑完但留了部分内容 */
function assistantStatusOf(kind, text) {
  if (kind === 'completed') return MSG.COMPLETE;
  if (kind === ERR.RATE_LIMIT || kind === ERR.QUOTA_EXHAUSTED) return MSG.RATE_LIMITED;
  if (FAILED_KINDS.has(kind)) return text ? MSG.PARTIAL : MSG.FAILED;
  if (kind === ERR.UNKNOWN) return MSG.UNKNOWN;
  return text ? MSG.PARTIAL : MSG.INTERRUPTED;
}

/** 失败的完整说明：机器可读的 code / reason + 给人看的 label / text + 什么时候能重试 */
function errorOf(outcome) {
  const kind = outcome && outcome.kind ? outcome.kind : ERR.UNKNOWN;
  const message = String((outcome && outcome.message) || '').slice(0, 800);
  const err = {
    kind, code: kind,
    reason: (outcome && outcome.reason) || kind,
    label: errorLabel(kind),
    message, text: message,
    retryable: isRetryable(kind),
    api_error_status: outcome && outcome.apiErrorStatus != null ? outcome.apiErrorStatus : null,
    retry_at: null, retry_hint: null,
  };
  if (kind === ERR.RATE_LIMIT || kind === ERR.QUOTA_EXHAUSTED) {
    // 「具体何时可重试」：上游文案里有绝对重置时间就用它；没有就如实说 CLI 还在自动重试、间隔多久
    // 轮次已经结束：CLI 不再重试了，这里只说「什么时候可以再试」——有重置时间报时间，没有就说稍后，
    // 并如实带上它刚才自动重试了几次（在途的重试倒计时在 retry 事件里，不在这里）
    err.retry_at = (outcome && outcome.resetAt) || null;
    err.retried = outcome && outcome.retryAttempt != null ? { attempt: outcome.retryAttempt, max: outcome.retryMax ?? null } : null;
    err.retry_hint = retryHint({ resetAt: err.retry_at });
    if (!err.retry_at && err.retried) {
      err.retry_hint += `；CLI 已自动重试 ${err.retried.attempt}${err.retried.max != null ? `/${err.retried.max}` : ''} 次仍未通过`;
    }
  }
  return err;
}

/**
 * @param {object} opts
 * @param {object} [opts.db]         不传则用进程级单例库
 * @param {object} [opts.adapters]   { claude, dsh, hermes }：({prompt, resumeId, cwd, signal, onEvent}) => outcome；测试可注入假的
 * @param {object} [opts.timing]     覆盖 DEFAULT_TIMING
 * @param {string|null} [opts.claudeSettings]  追加给 Claude CLI 的 --settings；不传则读环境变量 CHAT_CLAUDE_SETTINGS
 */
export function createChatEngine(opts = {}) {
  const db = opts.db || getDb();
  const adapters = opts.adapters || { claude: runClaudeTurn, dsh: runDshTurn, hermes: runHermesTurn };
  const claudeSettings = Object.prototype.hasOwnProperty.call(opts, 'claudeSettings') ? opts.claudeSettings : extraClaudeSettings();
  const T = { ...DEFAULT_TIMING, ...(opts.timing || {}) };

  const active = new Map();      // turn_id → run
  const draining = new Map();    // thread_id → 正在排空的 Promise
  const waiting = new Map();     // turn_id → 还在排队、尚未起跑的轮次的订阅者（起跑时由 runTurn 接过去）

  let ticker = null;
  function ensureTicker() {
    if (ticker) return;
    ticker = setInterval(tick, T.tickMs);
    if (ticker.unref) ticker.unref();   // 不为了它拖着进程不退出
  }
  function stopTickerIfIdle() {
    if (ticker && active.size === 0) { clearInterval(ticker); ticker = null; }
  }

  /* ---------------- 事件：一个 seq，落库与推送是同一条 ---------------- */

  function nowIso() { return new Date().toISOString(); }

  /** 发一条增量：取一个新 seq，先落库（同时回写消息全文与 event_seq），再推给在线订阅者 */
  function emitDelta(run, text, replace) {
    const seq = ++run.seq;
    store.appendChatEvent(db, {
      turnId: run.turnId, seq, type: EVT.DELTA, payload: { text, ...(replace ? { replace: true } : {}) },
      messageId: run.assistantMessageId, content: run.text,
    });
    send(run, { seq, type: EVT.DELTA, turn_id: run.turnId, at: nowIso(), text, ...(replace ? { replace: true } : {}) });
  }

  function flushDeltas(run) {
    if (run.flushTimer) { clearTimeout(run.flushTimer); run.flushTimer = null; }
    if (!run.pendingText) return;
    const text = run.pendingText;
    run.pendingText = '';
    emitDelta(run, text, false);
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

  /** 非增量事件：先把攒着的增量发出去，再发自己（保证它之前的文本订阅方都已经收到） */
  function publish(run, type, payload = {}) {
    flushDeltas(run);
    const ev = { seq: ++run.seq, type, turn_id: run.turnId, at: nowIso(), ...payload };
    store.appendChatEvent(db, {
      turnId: run.turnId, seq: ev.seq, type,
      payload: { ...payload }, messageId: run.assistantMessageId,
    });
    send(run, ev);
    return ev;
  }

  function onDelta(run, { text, replace }) {
    if (typeof text !== 'string' || text === '') return;
    run.lastEventAt = Date.now();
    if (replace) {
      // 以 CLI 最终文本为准：先把手里的增量按序发完，再整条重发（订阅端用替换语义）
      flushDeltas(run);
      run.text = text;
      emitDelta(run, text, true);
      return;
    }
    run.text += text;
    run.pendingText += text;
    run.retrying = false;
    run.stallWarned = false;
    // 第一段正文到了：状态转「正在回答」——setStatus 内部会先 flush，所以第一段立刻就出去，不用等 200ms
    if (run.status !== TURN.RUNNING) setStatus(run, TURN.RUNNING);
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
        // 把真正执行的命令行留证（续聊用的是哪个参数、哪个工作目录，事后可查）；凭据不进这一行
        emitStatus(run, { pid: ev.pid, cli_command: clipCommand(ev.command) });
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
        return;
      case 'tool':
        run.toolOpen = true;
        run.lastEventAt = Date.now();
        if (run.status !== TURN.TOOL_RUNNING) setStatus(run, TURN.TOOL_RUNNING);
        publish(run, EVT.TOOL, { phase: ev.phase || 'call', id: ev.id || null, name: ev.name || null, input: clip(ev.input, 300) });
        return;
      case 'tool_result':
        run.toolOpen = false;
        run.lastEventAt = Date.now();
        publish(run, EVT.TOOL, { phase: 'result', id: ev.id || null, is_error: ev.isError === true, text: clip(ev.text, 600) });
        if (run.status === TURN.TOOL_RUNNING) setStatus(run, TURN.RUNNING);
        return;
      case 'retry': {
        // CLI 自己在退避重试（实测 Claude 对 429 最多 10 次）：如实显示「请求受限」+ 下一次重试在多久后，不另起一层重试
        const retryAt = Number.isFinite(Number(ev.delayMs)) ? new Date(Date.now() + Number(ev.delayMs)).toISOString() : null;
        run.retrying = true;
        run.lastEventAt = Date.now();
        if (run.status !== TURN.RATE_LIMITED) setStatus(run, TURN.RATE_LIMITED);
        publish(run, EVT.RETRY, {
          attempt: ev.attempt ?? null, max: ev.max ?? null, delay_ms: ev.delayMs ?? null,
          http_status: ev.status ?? null, error: ev.error || null, retry_at: retryAt,
          retry_hint: retryHint({ retryDelayMs: ev.delayMs, retryAttempt: ev.attempt, retryMax: ev.max }),
        });
        return;
      }
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

    const error = kind === 'completed' ? null : errorOf(outcome);
    // 适配器没单独报过 session 事件、但结局里带了 session：也存下来（下一轮靠它续聊）
    const sid = outcome && outcome.sessionId ? String(outcome.sessionId) : '';
    if (sid && sid !== run.providerSessionId) {
      run.providerSessionId = sid;
      store.setProviderSession(db, run.threadId, sid);
    }
    run.status = status;
    store.finishTurn(db, run.turnId, { status, error });
    store.setMessageStatus(db, run.assistantMessageId, assistantStatusOf(kind, finalText), { error });

    // 用户消息：交给了模型就算发出去；没跑成的那几类（起不来 / 没凭据 / 认证不过 / 会话丢了）就是没发出去
    const delivered = !NOT_DELIVERED_KINDS.has(kind);
    store.setMessageStatus(db, run.userMessageId, delivered ? MSG.SENT : MSG.FAILED, { error: delivered ? null : error });

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
      store.finishTurn(db, turn.turn_id, { status: TURN.INTERRUPTED, error: { kind: ERR.UNKNOWN, code: ERR.UNKNOWN, reason: 'turn_orphaned', label: errorLabel(ERR.UNKNOWN), message: '对话或用户消息不见了，本轮无法执行', text: '对话或用户消息不见了，本轮无法执行', retryable: false } });
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
    // 排队期间就已经在等这一轮的订阅者：接到 run 上，started 事件他们第一条就能收到
    const pend = waiting.get(run.turnId);
    if (pend) { for (const s of pend) run.subscribers.add(s); waiting.delete(run.turnId); }
    ensureTicker();

    const resume = Boolean(thread.provider_session_id);
    const cwd = thread.workspace || REPO_ROOT;
    const waitedMs = Math.max(0, Date.now() - Date.parse(turn.created_at));
    try {
      // 这一轮的第一条事件就是 started / restoring（带着 starting / restoring 状态），不再另发一条同义的状态事件
      run.status = resume ? TURN.RESTORING : TURN.STARTING;
      store.setTurnStatus(db, run.turnId, run.status);
      publish(run, resume ? EVT.RESTORING : EVT.STARTED, {
        provider: thread.agent_id, resume, status: run.status,
        provider_session_id: thread.provider_session_id || null,
        workspace: cwd, mode: thread.mode, attempt_id: turn.attempt_id,
        queued_ms: waitedMs, queued_ahead: 0,
      });
      store.setMessageStatus(db, run.userMessageId, MSG.SENT);

      // 起 CLI 之前先看工作目录在不在：不在就是配置问题，说清楚，不去起一个注定失败的进程
      let outcome;
      if (!isDirectory(cwd)) {
        outcome = { kind: ERR.CLI_START_FAILED, reason: 'workspace_not_found', message: `工作目录不存在：${cwd}`, text: '' };
      } else {
        const adapter = adapters[thread.agent_id];
        if (typeof adapter !== 'function') {
          outcome = { kind: ERR.UNKNOWN, message: `没有 ${thread.agent_id} 的适配器`, text: '' };
        } else {
          outcome = await adapter({
            prompt: userMsg.content,
            resumeId: thread.provider_session_id || null,
            cwd,
            signal: run.abort.signal,
            onEvent: (ev) => onAdapterEvent(run, ev),
            ...(thread.agent_id === 'claude' && claudeSettings ? { extraSettings: claudeSettings } : {}),
          });
        }
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
    const e = turn.error || {};
    return {
      type: EVT.ERROR, turn_id: turn.turn_id, status: turn.status, text_len: textLen,
      kind: e.kind || ERR.UNKNOWN, code: e.code || e.kind || ERR.UNKNOWN, reason: e.reason || e.kind || ERR.UNKNOWN,
      label: e.label || errorLabel(ERR.UNKNOWN),
      message: e.message || '没有可靠证据说明本轮结果',
      text: e.text || e.message || '没有可靠证据说明本轮结果',
      retryable: e.retryable !== false, retry_at: e.retry_at || null, retry_hint: e.retry_hint || null,
    };
  }

  /**
   * 订阅一轮的事件流。listener = { send(ev), end() }。
   * 同步完成「快照 → 补发 → 挂实时」，中间不会漏事件。
   *
   * @param {string} turnId
   * @param {{send: Function, end: Function}} listener
   * @param {{afterSeq?: number|null}} [opts]  对方已经收到哪个 seq（EventSource 的 Last-Event-ID）；
   *   不传 = 这一轮的已落库事件从头补发（新订阅的人总能拿到 started → … 的完整过程；
   *   其中 seq ≤ snapshot.event_seq 的增量已经包含在 snapshot.text 里，订阅方不要重复拼）
   * @returns {{ok:boolean, code?:string, live:boolean, unsubscribe?: Function}}
   *   live=false 表示已终态，事件已全部交给 listener 并调用过 end()
   */
  function subscribe(turnId, listener, { afterSeq = null } = {}) {
    const turn = store.getTurn(db, turnId);
    if (!turn) return { ok: false, code: 'TURN_NOT_FOUND', live: false };
    const run = active.get(turnId) || null;
    const liveRun = run && !run.finished ? run : null;   // 在不在看进程里的 run，不看库里的状态（限流重试中状态是 rate_limited，但还在跑）
    if (liveRun) flushDeltas(run);     // 内存里还没落库的增量先落下去，快照才是最新的
    const msg = turn.assistant_message_id ? store.getMessage(db, turn.assistant_message_id) : null;
    const eventSeq = msg ? (msg.event_seq || 0) : store.lastEventSeq(db, turnId);
    const last = Number.isInteger(afterSeq) && afterSeq >= 0 ? Math.min(afterSeq, eventSeq) : 0;
    const stillActive = Boolean(liveRun) || isTurnActive(turn);
    listener.send({
      type: EVT.SNAPSHOT, turn_id: turnId, at: nowIso(),
      status: turn.status, text: msg ? msg.content : '', event_seq: eventSeq,
      replay_from: last, resume: Boolean(turn.resume),
      error: turn.error || null,
      queued_ahead: stillActive ? store.queuedAhead(db, turn) : 0,
    });
    let sawTerminal = false;
    for (const row of store.listChatEvents(db, turnId, { afterSeq: last })) {
      if (TERMINAL_TYPES.has(row.type)) sawTerminal = true;
      listener.send(fromRow(row));
    }
    const sub = {
      send: (ev) => listener.send(ev),
      end: () => listener.end(),
    };
    if (liveRun) {
      liveRun.subscribers.add(sub);
      return { ok: true, live: true, unsubscribe: () => liveRun.subscribers.delete(sub) };
    }
    if (turn.status === TURN.QUEUED) {
      // 还在排队：这一轮还没起跑、没有 run。先挂上，等它轮到时由 runTurn 接过去（开始后第一时间收到 started）
      if (!waiting.has(turnId)) waiting.set(turnId, new Set());
      waiting.get(turnId).add(sub);
      return { ok: true, live: true, unsubscribe: () => { const s = waiting.get(turnId); if (s) s.delete(sub); } };
    }
    // 事件日志已经以 terminal 收尾就不补（对方可能早就收到了）；只有对账落终态、没来得及写事件的轮次才在这里补一条
    const lastRow = store.lastChatEvent(db, turnId);
    if (!sawTerminal && !(lastRow && TERMINAL_TYPES.has(lastRow.type))) listener.send(terminalEventOf(turn, msg));
    listener.end();
    return { ok: true, live: false };
  }

  /** 排队中被取消的轮次：给等着看它的人一条 terminal 事件并落库，连接才不会一直挂着 */
  function endWaiting(turnId) {
    const subs = waiting.get(turnId);
    if (!subs) return;
    waiting.delete(turnId);
    const turn = store.getTurn(db, turnId);
    const msg = turn && turn.assistant_message_id ? store.getMessage(db, turn.assistant_message_id) : null;
    const ev = terminalEventOf(turn, msg);
    store.appendChatEvent(db, { turnId, seq: store.lastEventSeq(db, turnId) + 1, type: ev.type, payload: { ...ev } });
    for (const sub of subs) { try { sub.send({ ...ev, seq: store.lastEventSeq(db, turnId) }); } catch { /* 已断开 */ } }
    for (const sub of subs) { try { sub.end(); } catch { /* 已断开 */ } }
  }

  /** 取消一轮：排队中的直接落 interrupted；在跑的杀进程树，由适配器回来收尾 */
  function cancel(turnId) {
    const turn = store.requireTurn(db, turnId);
    const run = active.get(turnId) || null;
    if (run && !run.finished) {
      run.abort.abort({ kind: ERR.CANCELLED });
      return store.getTurn(db, turnId);
    }
    if (!isTurnActive(turn)) {
      throw httpErr(409, 'TURN_NOT_ACTIVE', `这一轮已经结束（${turn.status}），不能取消`);
    }
    const error = { kind: ERR.CANCELLED, code: ERR.CANCELLED, reason: 'cancelled', label: errorLabel(ERR.CANCELLED), message: '发送前已停止', text: '发送前已停止', retryable: true, retry_hint: null, retry_at: null };
    store.finishTurn(db, turnId, { status: TURN.INTERRUPTED, error });
    if (turn.assistant_message_id) store.setMessageStatus(db, turn.assistant_message_id, MSG.INTERRUPTED, { error });
    if (turn.user_message_id) store.setMessageStatus(db, turn.user_message_id, MSG.FAILED, { error });
    endWaiting(turnId);
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
