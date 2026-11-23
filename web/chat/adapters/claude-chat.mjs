// claude-chat.mjs — Claude Code 的聊天适配器（一轮对话 = 一次 CLI 调用，ADR-01 按需启动）。
//
// 续聊口径（TASK-AgentChat-V1 §3.1，本机 v2.1.296 实测）：
//   新建会话   claude -p … --session-id <新UUID>
//   续聊       claude -p … --resume <已存在的 session-id>
//   拿旧 ID 传 --session-id → exit 1「Session ID … is already in use」。所以这里二选一，绝不混用。
//   --resume 一个不存在的 ID → exit 1，stderr「No conversation found with session ID: …」
//
// 上下文全部交给 Claude 自己的会话文件；本适配器每轮只发用户这一句话（ADR-04）。
//
// 讨论模式（ADR-06）：plan 权限模式 + 只给 Read/Grep/Glob 三个只读工具，并显式拉黑
// Bash/PowerShell/Edit/Write 等执行与写入类工具；--strict-mcp-config 不挂 MCP。
// 实测让它写文件：它回答「处于 Plan mode，只拥有只读工具，无法创建文件」，目录保持为空。
//
// 输出用 stream-json + --include-partial-messages，逐 token 拿到 text_delta（T8 增量显示）。
// 实测要点：
//   - 429 时 CLI 自己会退避重试 10 次（约 3 分钟），每次吐 system/api_retry；
//     耗尽后吐一条 model=<synthetic> 的「assistant」消息，result 的 is_error=true、
//     terminal_reason=api_error、api_error_status=429 —— 注意 subtype 仍是 success，不能只看它。
//   - <synthetic> 消息是报错不是回答，绝不能当正文显示。
//   - 失败原因可能在 result.result / result.errors[] / stderr 三处，要都看。
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  cleanChildEnv, decodeConsoleOutput, killTree, makeByteTail, makeLineSplitter, redactSecrets, spawnPlan, waitSpawned,
} from '../proc.mjs';
import { classifyErrorText, ERR, isAuthStatus } from '../chat-state.mjs';

/** 讨论模式允许的内置工具：只读三个 */
export const CLAUDE_READ_TOOLS = Object.freeze(['Read', 'Grep', 'Glob']);
/** 明确拉黑：会执行命令、会写文件、会外呼的工具（工具集已限定为只读三个，这里是第二道保险） */
export const CLAUDE_DENY_TOOLS = Object.freeze(['Bash', 'PowerShell', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent']);
/** 单轮里 CLI 自己的最多轮数（读文件多时会多轮），防止工具循环停不下来 */
export const CLAUDE_MAX_TURNS = 8;

export function defaultClaudeBin() {
  return process.env.CLAUDE_BIN || 'claude';
}

/** 组参数：resumeId 有值 → --resume；否则 --session-id <新UUID> */
export function claudeArgs({ resumeId = null, newSessionId = null, maxTurns = CLAUDE_MAX_TURNS } = {}) {
  if (!resumeId && !newSessionId) {
    throw Object.assign(new Error('claudeArgs 需要 resumeId 或 newSessionId 其一'), { code: 'BAD_CHAT_ARGS' });
  }
  return [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    ...(resumeId ? ['--resume', resumeId] : ['--session-id', newSessionId]),
    '--permission-mode', 'plan',
    '--tools', CLAUDE_READ_TOOLS.join(','),
    '--disallowedTools', CLAUDE_DENY_TOOLS.join(','),
    '--strict-mcp-config',
    '--max-turns', String(maxTurns),
  ];
}

function textOf(content) {
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('');
}

function abortMessage(kind) {
  if (kind === ERR.TIMEOUT_CAP) return '超过单轮时间上限，已停止本轮；已收到的内容保留';
  if (kind === ERR.SERVER_RESTARTED) return '服务正在停止，本轮执行中断；已收到的内容保留';
  return '已按你的要求停止本轮；已收到的内容保留';
}

const SESSION_NOT_FOUND_RE = /No conversation found with session ID/i;

/**
 * 跑一轮：发一句、收完、退出。
 *
 * @param {object} opts
 * @param {string} opts.prompt            用户这一句话（走 stdin，避开 Windows argv 的引号/编码问题）
 * @param {string|null} opts.resumeId     续聊用的 session-id；null = 新建会话
 * @param {string} opts.cwd               工作目录（Claude 的会话按 cwd 归档，续聊必须同一个）
 * @param {Function} opts.onEvent         收到解析后的事件就回调：
 *     proc{pid} / session{sessionId} / meta{tools,model,permissionMode} / delta{text,replace?} /
 *     tool{phase,id,name,input?} / tool_result{id,isError,text} / retry{attempt,max,delayMs,status} / liveness{source}
 * @param {AbortSignal} [opts.signal]     取消时 abort，reason.kind 写明是谁停的
 * @returns {Promise<{kind:string, message?:string, sessionId?:string, text:string, usage?:object, numTurns?:number, durationMs?:number, exitCode?:number}>}
 *   kind === 'completed' 表示这一轮正常完成；其余取值见 chat-state.mjs 的 ERR。
 */
export async function runClaudeTurn(opts) {
  const {
    prompt, resumeId = null, cwd, bin = defaultClaudeBin(), env = process.env,
    onEvent = () => {}, signal = null, maxTurns = CLAUDE_MAX_TURNS,
    newSessionId = randomUUID(), spawnMs = 10000,
  } = opts;
  const emit = (ev) => { try { onEvent(ev); } catch { /* 监听方出错不影响继续解析输出 */ } };
  const fail = (kind, message, extra = {}) => ({ kind, message, sessionId: resumeId, text: '', exitCode: null, ...extra });

  let args;
  try { args = claudeArgs({ resumeId, newSessionId, maxTurns }); } catch (err) { return fail(ERR.UNKNOWN, err.message); }

  const plan = spawnPlan(bin, args);
  let child;
  try {
    child = spawn(plan.command, plan.args, {
      cwd, env: cleanChildEnv(env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: plan.shell,
    });
  } catch (err) {
    return fail(ERR.CLI_START_FAILED, `无法启动 ${bin}：${err.message}`);
  }
  emit({ type: 'proc', pid: child.pid });
  const spawned = await waitSpawned(child, spawnMs);
  if (!spawned.ok) {
    return fail(ERR.CLI_START_FAILED, `无法启动 ${bin}：${spawned.error && spawned.error.message ? spawned.error.message : spawned.error}`);
  }

  const state = {
    sessionId: resumeId, sessionAnnounced: false, text: '', finalText: '', result: null, synthetic: null,
    usage: null, sawEvent: false, nonJson: '', abortedKind: null,
  };
  const stderrTail = makeByteTail(16384);

  const handle = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    state.sawEvent = true;
    // session-id：首个带它的事件就对外报一次（续聊时它是「--resume 成功」的证据），之后变了再报
    if (typeof obj.session_id === 'string' && obj.session_id && (obj.session_id !== state.sessionId || !state.sessionAnnounced)) {
      state.sessionId = obj.session_id;
      state.sessionAnnounced = true;
      emit({ type: 'session', sessionId: obj.session_id, resumed: Boolean(resumeId) });
    }
    if (obj.type === 'system') {
      if (obj.subtype === 'api_retry') {
        emit({
          type: 'retry', attempt: obj.attempt, max: obj.max_retries, delayMs: obj.retry_delay_ms,
          status: obj.error_status, error: obj.error,
        });
      } else if (obj.subtype === 'init') {
        emit({ type: 'meta', tools: obj.tools, model: obj.model, permissionMode: obj.permissionMode });
      } else {
        emit({ type: 'liveness', source: `system/${obj.subtype}` });
      }
      return;
    }
    if (obj.type === 'stream_event') {
      const ev = obj.event;
      if (!ev) return;
      if (ev.type === 'content_block_delta') {
        if (ev.delta && ev.delta.type === 'text_delta' && typeof ev.delta.text === 'string') {
          state.text += ev.delta.text;
          emit({ type: 'delta', text: ev.delta.text });
        } else {
          emit({ type: 'liveness', source: `delta/${ev.delta ? ev.delta.type : '?'}` });
        }
      } else if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'tool_use') {
        emit({ type: 'tool', phase: 'start', id: ev.content_block.id, name: ev.content_block.name });
      } else {
        emit({ type: 'liveness', source: ev.type });
      }
      return;
    }
    if (obj.type === 'assistant') {
      const msg = obj.message;
      if (!msg) return;
      if (msg.model === '<synthetic>') {
        // CLI 合成的报错消息（429 / 额度 / 认证）：只记下，不当正文
        state.synthetic = { text: textOf(msg.content), error: obj.error || null };
        emit({ type: 'liveness', source: 'synthetic' });
        return;
      }
      for (const c of (Array.isArray(msg.content) ? msg.content : [])) {
        if (!c) continue;
        if (c.type === 'text' && typeof c.text === 'string') state.finalText += c.text;
        else if (c.type === 'tool_use') emit({ type: 'tool', phase: 'call', id: c.id, name: c.name, input: c.input });
      }
      if (msg.usage) state.usage = msg.usage;
      emit({ type: 'liveness', source: 'assistant' });
      return;
    }
    if (obj.type === 'user') {
      // --verbose 下工具结果以 user 消息回放
      for (const c of (Array.isArray(obj.message && obj.message.content) ? obj.message.content : [])) {
        if (c && c.type === 'tool_result') {
          const body = Array.isArray(c.content) ? c.content : (typeof c.content === 'string' ? [{ type: 'text', text: c.content }] : []);
          emit({ type: 'tool_result', id: c.tool_use_id, isError: c.is_error === true, text: textOf(body).slice(0, 2000) });
        }
      }
      emit({ type: 'liveness', source: 'user' });
      return;
    }
    if (obj.type === 'result') {
      state.result = obj;
      if (obj.usage) state.usage = obj.usage;
      return;
    }
    emit({ type: 'liveness', source: String(obj.type) });
  };

  const stdoutLines = makeLineSplitter((line) => {
    let obj;
    try { obj = JSON.parse(line); } catch {
      state.nonJson = (state.nonJson + '\n' + line).slice(-2000);
      return;
    }
    try { handle(obj); } catch (err) { emit({ type: 'liveness', source: `parse_error/${err.message}` }); }
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => stdoutLines.push(chunk));
  child.stderr.on('data', (chunk) => stderrTail.push(chunk));

  const onAbort = () => {
    state.abortedKind = (signal && signal.reason && signal.reason.kind) || ERR.CANCELLED;
    killTree(child.pid);
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  // prompt 走 stdin。进程若已退出，写入会 EPIPE——吞掉，结局由退出码说明
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);

  const closed = await new Promise((resolve) => {
    child.once('close', (code, sig) => resolve({ code, sig }));
    child.once('error', (err) => { state.nonJson += `\n[进程错误] ${err.message}`; });
  });
  if (signal) signal.removeEventListener('abort', onAbort);
  stdoutLines.flush();
  const stderr = redactSecrets(decodeConsoleOutput(stderrTail.get()), env).trim();

  const base = {
    sessionId: state.sessionId, text: state.text, usage: state.usage,
    numTurns: state.result ? state.result.num_turns : null,
    durationMs: state.result ? state.result.duration_ms : null,
    exitCode: closed.code,
  };

  // 被我们主动停掉：原因由调用方写（用户取消 / 超时上限 / 服务停止）
  if (state.abortedKind) {
    return { ...base, kind: state.abortedKind, message: abortMessage(state.abortedKind) };
  }

  const r = state.result;
  if (r) {
    const failed = r.is_error === true || r.terminal_reason === 'api_error' || Boolean(state.synthetic);
    if (failed) {
      const detail = [
        state.synthetic && state.synthetic.text,
        typeof r.result === 'string' ? r.result : '',
        Array.isArray(r.errors) ? r.errors.filter(Boolean).join('；') : '',
        typeof r.error === 'string' ? r.error : '',
      ].filter(Boolean).join(' ');
      if (SESSION_NOT_FOUND_RE.test(`${detail} ${stderr}`)) {
        return { ...base, kind: ERR.SESSION_NOT_FOUND, message: `Claude 找不到会话 ${resumeId}（No conversation found with session ID）` };
      }
      const why = detail || stderr.slice(-400);
      let kind;
      if (!why) kind = ERR.UNKNOWN;
      else if (isAuthStatus(r.api_error_status)) kind = ERR.AUTH_FAILED;
      else if (Number(r.api_error_status) === 429) {
        kind = classifyErrorText(why) === ERR.QUOTA_EXHAUSTED ? ERR.QUOTA_EXHAUSTED : ERR.RATE_LIMIT;
      } else {
        kind = classifyErrorText(why) || ERR.CLI_ERROR;
      }
      return {
        ...base, kind, apiErrorStatus: r.api_error_status ?? null,
        message: why ? why.slice(0, 800) : `CLI 报错但没有给出原因（exit ${closed.code}，subtype=${r.subtype}）`,
      };
    }
    if (r.subtype === 'error_max_turns') {
      return { ...base, kind: ERR.MAX_TURNS, message: `达到单轮工具调用上限（${maxTurns} 次）后停止；已得到的回答保留在上面的消息里` };
    }
    if (r.terminal_reason === 'completed' || r.subtype === 'success') {
      // 以 CLI 最终消息为准：流式拼接与最终文本不一致时发一条 replace 让界面纠正
      const finalText = state.finalText || state.text;
      if (finalText !== state.text) emit({ type: 'delta', text: finalText, replace: true });
      return { ...base, kind: 'completed', text: finalText };
    }
    return {
      ...base, kind: ERR.UNKNOWN,
      message: `CLI 正常退出但终态不明（terminal_reason=${r.terminal_reason}，subtype=${r.subtype}）`,
    };
  }

  // 没有 result 事件就退了
  if (closed.code === 0) {
    return {
      ...base, kind: ERR.UNKNOWN,
      message: `CLI 退出但没有 result 事件，执行结果未确认${stderr ? `：${stderr.slice(-300)}` : ''}`,
    };
  }
  if (SESSION_NOT_FOUND_RE.test(stderr)) {
    return { ...base, kind: ERR.SESSION_NOT_FOUND, message: `Claude 找不到会话 ${resumeId}（No conversation found with session ID）` };
  }
  if (!state.sawEvent) {
    // 一条事件都没吐出来就退了 = CLI 根本没起来（命令不存在、启动即崩），把 stderr 原因带给用户
    return { ...base, kind: ERR.CLI_START_FAILED, message: `无法启动 ${bin}：${(stderr || state.nonJson).slice(-400) || `exit ${closed.code}`}` };
  }
  return { ...base, kind: ERR.CRASHED, message: `CLI 异常退出（exit ${closed.code}）：${stderr.slice(-400) || '没有错误输出'}` };
}
