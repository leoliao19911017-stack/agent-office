// hermes-chat.mjs — Hermes Agent 的聊天适配器（一轮对话 = 一次 hermes chat 非交互调用）。
//
// 能力是实测过的（P6 探测，证据 docs/evidence/chat-p6/）：
//   非交互   hermes chat --query-file - --format stream-json --oneshot
//            → stdout 是 NDJSON：{type:"system",subtype:"init",session_id} /
//              {type:"text",text}（逐小段）/ {type:"result",session_id,exit_code,text,tokens,duration_ms}
//            → 任务文本走 stdin（--query-file -），中文 UTF-8 原样到达，不经过 Windows 命令行编码
//   续聊     hermes chat … --resume <上一轮的 session_id>，实测第 2 轮答对第 1 轮说过的数字
//   未知 ID  stderr「Session not found: …」+ result.exit_code=1（init 事件仍会带那个坏 ID，不能当证据）
//   版本     本机 hermes v0.21.3（2026.9.14）
//
// 讨论模式（ADR-06）：只开 web / session_search 两个只读工具集，不开 file / terminal /
// code_execution，所以它能查网、能查历史会话、能回答，但读不了也改不了本机文件。
// 这是按 Hermes 的工具集粒度做的取舍，面板文案也如实这么写（见 web/board-chat.js）。
//
// 注意：hermes 在 stderr 打一行「session_id: …」是正常回执，不是错误；不能用 stderr 非空判失败。
import { spawn } from 'node:child_process';
import {
  cleanChildEnv, decodeConsoleOutput, explainStartFailure, killTree, makeByteTail, makeLineSplitter, preflightBin,
  redactSecrets, spawnPlan, waitSpawned,
} from '../proc.mjs';
import { classifyErrorText, ERR, extractResetAt } from '../chat-state.mjs';

/** 讨论模式开放的只读工具集（不含 file / terminal / code_execution，避免在聊天里读写本机） */
export const HERMES_TOOLSETS = 'web,session_search';

export function defaultHermesBin() {
  return process.env.HERMES_BIN || 'hermes';
}

/** 组参数：resumeId 有值 → --resume；否则新会话（session_id 由 init / result 事件给出） */
export function hermesArgs({ resumeId = null, toolsets = HERMES_TOOLSETS } = {}) {
  const args = ['chat', '--query-file', '-', '--format', 'stream-json', '--oneshot'];
  if (toolsets) args.push('--toolsets', toolsets);
  if (resumeId) args.push('--resume', resumeId);
  return args;
}

function abortMessage(kind) {
  if (kind === ERR.TIMEOUT_CAP) return '超过单轮时间上限，已停止本轮；已收到的内容保留';
  if (kind === ERR.SERVER_RESTARTED) return '服务正在停止，本轮执行中断；已收到的内容保留';
  return '已按你的要求停止本轮；已收到的内容保留';
}

/**
 * 跑一轮：发一句、收完、退出。返回形状与 runClaudeTurn 一致。
 * onEvent 收到：proc{pid,command} / session{sessionId,resumed} / delta{text,replace?} /
 *               tool{phase,id,name,input?} / tool_result{id,isError,text} / liveness{source}。
 */
export async function runHermesTurn(opts) {
  const {
    prompt, resumeId = null, cwd, bin = defaultHermesBin(), env = process.env,
    onEvent = () => {}, signal = null, spawnMs = 10000, toolsets = HERMES_TOOLSETS,
  } = opts;
  const emit = (ev) => { try { onEvent(ev); } catch { /* 监听方出错不影响继续解析 */ } };
  const fail = (kind, message, extra = {}) => ({ kind, message, sessionId: resumeId, text: '', exitCode: null, ...extra });

  const pre = preflightBin(bin);
  if (pre) return fail(ERR.CLI_START_FAILED, pre.message, { reason: pre.reason });

  const plan = spawnPlan(bin, hermesArgs({ resumeId, toolsets }));
  let child;
  try {
    child = spawn(plan.command, plan.args, {
      cwd, env: cleanChildEnv(env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: plan.shell,
    });
  } catch (err) {
    const why = explainStartFailure({ bin, cwd, err });
    return fail(ERR.CLI_START_FAILED, why.message, { reason: why.reason });
  }
  let spawnErr = null;
  child.on('error', (err) => { spawnErr = err; });
  emit({ type: 'proc', pid: child.pid, command: plan.command });
  const spawned = await waitSpawned(child, spawnMs);
  if (!spawned.ok) {
    const why = explainStartFailure({ bin, cwd, err: spawned.error });
    return fail(ERR.CLI_START_FAILED, why.message, { reason: why.reason });
  }

  const state = {
    sessionId: resumeId, text: '', final: null, usage: null, sawEvent: false,
    abortedKind: null, rawTail: '',
  };
  const stderrTail = makeByteTail(16384);

  const handle = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    state.sawEvent = true;
    switch (obj.type) {
      case 'system': {
        // init 是这一轮的第一条：session_id 在这里，result 里还会再给一次（互相印证）
        const sid = typeof obj.session_id === 'string' ? obj.session_id : '';
        if (obj.subtype === 'init' && sid) {
          state.sessionId = sid;
          emit({ type: 'session', sessionId: sid, resumed: Boolean(resumeId) });
          if (obj.model) emit({ type: 'meta', model: obj.model, tools: null, permissionMode: 'read_only_toolsets' });
        } else {
          emit({ type: 'liveness', source: `system/${obj.subtype || '?'}` });
        }
        return;
      }
      case 'text':
        if (typeof obj.text === 'string' && obj.text !== '') {
          state.text += obj.text;
          emit({ type: 'delta', text: obj.text });
        }
        return;
      case 'tool_use':
      case 'tool_call':
        emit({ type: 'tool', phase: 'call', id: obj.id || obj.call_id || null, name: obj.name || obj.tool || null, input: obj.input });
        return;
      case 'tool_result':
        emit({
          type: 'tool_result', id: obj.id || obj.call_id || null, isError: obj.is_error === true || obj.status === 'error',
          text: redactSecrets(typeof obj.text === 'string' ? obj.text : JSON.stringify(obj.result ?? obj.output ?? ''), env).slice(0, 2000),
        });
        return;
      case 'result':
        state.final = obj;
        if (obj.tokens && typeof obj.tokens === 'object') state.usage = obj.tokens;
        return;
      default:
        emit({ type: 'liveness', source: String(obj.type || 'unknown') });
    }
  };

  const stdoutLines = makeLineSplitter((line) => {
    let obj;
    try { obj = JSON.parse(line); } catch {
      state.rawTail = (state.rawTail + '\n' + line).slice(-2000);
      return;
    }
    try { handle(obj); } catch (err) { emit({ type: 'liveness', source: `parse_error/${err.message}` }); }
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => stdoutLines.push(chunk));
  child.stderr.on('data', (chunk) => stderrTail.push(chunk));   // 保留原始字节：UTF-8 / GBK 由 decodeConsoleOutput 判断

  const onAbort = () => {
    state.abortedKind = (signal && signal.reason && signal.reason.kind) || ERR.CANCELLED;
    killTree(child.pid);
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);

  const closed = await new Promise((resolve) => {
    child.once('close', (code, sig) => resolve({ code, sig }));
  });
  if (signal) signal.removeEventListener('abort', onAbort);
  stdoutLines.flush();
  const stderrRaw = decodeConsoleOutput(stderrTail.get()).trim();
  // stderr 里「session_id: …」是正常回执；去掉后再看有没有真错误
  const stderr = redactSecrets(stderrRaw.replace(/^\s*session_id:\s*\S+\s*$/gim, '').trim(), env);

  const base = {
    sessionId: state.sessionId, text: state.text, exitCode: closed.code,
    // 引擎的 usage 口径是 Anthropic 命名（input_tokens / output_tokens / cache_*），这里转一次
    usage: state.usage ? {
      input_tokens: state.usage.input ?? state.usage.input_tokens ?? null,
      output_tokens: state.usage.output ?? state.usage.output_tokens ?? null,
      cache_read_input_tokens: state.usage.cache_read ?? null,
      cache_creation_input_tokens: state.usage.cache_write ?? null,
    } : null,
  };
  if (state.abortedKind) {
    return { ...base, kind: state.abortedKind, message: abortMessage(state.abortedKind) };
  }
  if (spawnErr) {
    const why = explainStartFailure({ bin, cwd, err: spawnErr });
    return { ...base, kind: ERR.CLI_START_FAILED, reason: why.reason, message: why.message };
  }

  const r = state.final;
  const resultError = r && typeof r.error === 'string' ? r.error : '';
  const detail = [resultError, stderr, state.rawTail].filter(Boolean).join(' ').slice(0, 1200);

  if (r) {
    if (/Session not found/i.test(detail)) {
      return { ...base, kind: ERR.SESSION_NOT_FOUND, reason: 'session_not_found', message: `Hermes 找不到会话 ${resumeId}（Session not found）` };
    }
    if (r.exit_code === 0 || r.exit_code == null) {
      const finalText = state.text || (typeof r.text === 'string' ? r.text : '');
      if (!state.text && finalText) emit({ type: 'delta', text: finalText });
      if (!finalText) {
        return { ...base, kind: ERR.UNKNOWN, message: 'Hermes 正常退出但没有返回任何文本，执行结果未确认' };
      }
      if (finalText !== state.text) emit({ type: 'delta', text: finalText, replace: true });
      return { ...base, kind: 'completed', text: finalText, durationMs: r.duration_ms ?? null };
    }
    // 非 0 退出：认得出是限流 / 额度 / 认证就按那几类落状态，认不出就是 CLI 明确报错
    const kind = classifyErrorText(detail) || ERR.CLI_ERROR;
    return {
      ...base, kind, reason: kind === ERR.CLI_ERROR ? 'cli_error' : kind,
      apiErrorStatus: typeof r.status === 'number' ? r.status : null,
      resetAt: extractResetAt(detail),
      message: (detail || `Hermes 退出码 ${r.exit_code}，没有给出原因`).slice(0, 800),
    };
  }

  if (closed.code === 0) {
    return {
      ...base, kind: ERR.UNKNOWN,
      message: `Hermes 退出但没有 result 事件，执行结果未确认${stderr ? `：${stderr.slice(-300)}` : ''}`,
    };
  }
  if (!state.sawEvent) {
    const why = explainStartFailure({ bin, cwd, exitCode: closed.code, stderr: stderr || state.rawTail });
    return { ...base, kind: ERR.CLI_START_FAILED, reason: why.reason, message: why.message };
  }
  return { ...base, kind: ERR.CRASHED, reason: 'crashed', message: `Hermes 异常退出（exit ${closed.code}）：${stderr.slice(-400) || '没有错误输出'}` };
}
