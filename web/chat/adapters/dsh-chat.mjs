// dsh-chat.mjs — DSH 的聊天适配器（一轮对话 = 一次 dsh headless 调用，ADR-01 按需启动）。
//
// 续聊口径（P2 实测，本机 dsh 0.2.2-rc.5；证据 scripts/chat-v1/p2-acceptance/out/resume-flag-*.json）：
//   新建会话   dsh --profile headless --json … -          （不带续聊参数）
//              stdout 第一条 {"type":"session","sessionId":"session-<uuid>"} 就是真实 ID，必须存下来
//   续聊       dsh --profile headless --json … --session-id <那个真实 ID> -
//              —— dsh headless 的续聊参数就是 --session-id（它自己的 help 也只列了这一个）。
//                 --resume 是 Claude Code 的参数，dsh 不认：实测「unknown option '--resume'」exit 1。
//   未知 ID    {"type":"error","message":"session \"…\" does not exist; …"}，exit 1
//   所以这里的 ID 只能来自首轮输出（由 chat-db 回填），绝不自己编。
//
// 路径：dsh.cmd 不在 PATH，必须用完整路径（defaultDshBin 认 LOCALAPPDATA 下的安装位置，或 DSH_BIN）。
// 沙箱：Windows 上只要带 shell 的沙箱（workspace-write）必崩 0xC0000142，所以讨论模式只用
//   read-only + approval never ——能读、能分析、能回答；不开 danger-full-access（任务书 §7）。
//
// 上下文交给 DSH 自己的会话文件；每轮只发用户这一句话（ADR-04）。
//
// 凭据：headless profile 的凭据服务是关的，只认环境变量 DEEPSEEK_API_KEY。本机既有做法
// （C:/Tools/agent-autoloop/dsh-agent.js）是环境变量没有就读 ~/.dsh/.credentials.yaml 的
// refs.DEEPSEEK_API_KEY，只放内存、不打印。密钥不进日志、不进库、不回传。
//
// 输出是 NDJSON 运行事件（session / status / thinking / text / tool_call / tool_result / final / error）。
// 实测 text 事件是「每一步一条整段」，不是逐字——所以 DSH 这边的增量粒度是：
// 开始 / 阶段变化 / 工具调用实时到达，正文按步到达。
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  cleanChildEnv, decodeConsoleOutput, explainStartFailure, killTree, makeByteTail, makeLineSplitter, preflightBin,
  redactSecrets, spawnPlan, waitSpawned,
} from '../proc.mjs';
import { classifyErrorText, ERR, extractResetAt, isAuthStatus } from '../chat-state.mjs';

export const DSH_PERMISSION_MODE = 'read-only';
export const DSH_APPROVAL_POLICY = 'never';
/** 续聊参数名：实测 dsh headless 只认 --session-id（--resume → unknown option），见文件头。
 *  留成参数是为了能复现那组对照（probe-resume-flag.mjs resume|session-id）。 */
export const DSH_RESUME_FLAG = 'session-id';

export function defaultDshBin() {
  if (process.env.DSH_BIN) return process.env.DSH_BIN;
  const local = process.env.LOCALAPPDATA || (process.env.USERPROFILE ? `${process.env.USERPROFILE}/AppData/Local` : null);
  if (local) {
    const known = `${String(local).replace(/\\/g, '/')}/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd`;
    if (existsSync(known)) return known;
  }
  return 'dsh';
}

/** 取 DeepSeek API Key：优先环境变量，否则读 DSH 自己的凭证文件。只返回到内存，调用方不得打印。 */
export function sourceDeepSeekKey(env = process.env) {
  if (env.DEEPSEEK_API_KEY) return String(env.DEEPSEEK_API_KEY);
  let raw;
  try { raw = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8'); } catch { return null; }
  const m = raw.match(/^[ \t]*DEEPSEEK_API_KEY:[ \t]*(\S+)[ \t]*$/m);
  if (!m) return null;
  return m[1].replace(/^["']|["']$/g, '');
}

/** 组参数：resumeId 只能是首轮拿到的真实 ID；续聊走 --session-id */
export function dshArgs({ resumeId = null, resumeFlag = DSH_RESUME_FLAG } = {}) {
  const args = ['--profile', 'headless', '--json', '--permission-mode', DSH_PERMISSION_MODE, '--approval-policy', DSH_APPROVAL_POLICY];
  if (resumeId) args.push(`--${resumeFlag}`, resumeId);
  args.push('-');   // 任务文本走 stdin
  return args;
}

function abortMessage(kind) {
  if (kind === ERR.TIMEOUT_CAP) return '超过单轮时间上限，已停止本轮；已收到的内容保留';
  if (kind === ERR.SERVER_RESTARTED) return '服务正在停止，本轮执行中断；已收到的内容保留';
  return '已按你的要求停止本轮；已收到的内容保留';
}

/**
 * 跑一轮：发一句、收完、退出。返回形状与 runClaudeTurn 一致。
 * onEvent 收到：proc{pid,command} / session{sessionId,resumed} / delta{text} / tool{phase,id,name,input} /
 * tool_result{id,isError,text} / approval{action} / liveness{source,phase?}。
 * 失败时返回里带 reason（机器可读的细原因：cli_not_found / cli_path_missing / permission_denied / …）。
 */
export async function runDshTurn(opts) {
  const {
    prompt, resumeId = null, cwd, bin = defaultDshBin(), env = process.env,
    onEvent = () => {}, signal = null, spawnMs = 10000, resumeFlag = DSH_RESUME_FLAG,
  } = opts;
  const emit = (ev) => { try { onEvent(ev); } catch { /* 监听方出错不影响继续解析输出 */ } };
  const fail = (kind, message, extra = {}) => ({ kind, message, sessionId: resumeId, text: '', exitCode: null, ...extra });

  // 起进程之前先把能确定的失败说清楚：路径写错 / 不是可执行文件 / 工作目录没了 / 没有凭据
  const pre = preflightBin(bin);
  if (pre) return fail(ERR.CLI_START_FAILED, pre.message, { reason: pre.reason });
  if (cwd && !existsSync(cwd)) return fail(ERR.CLI_START_FAILED, `工作目录不存在：${cwd}`, { reason: 'workspace_not_found' });

  const apiKey = sourceDeepSeekKey(env);
  if (!apiKey) {
    return fail(ERR.CREDENTIALS_MISSING, 'DSH 没有 DEEPSEEK_API_KEY：环境变量里没有，~/.dsh/.credentials.yaml 里也没读到', { reason: 'credentials_missing' });
  }

  const plan = spawnPlan(bin, dshArgs({ resumeId, resumeFlag }));
  let child;
  try {
    child = spawn(plan.command, plan.args, {
      cwd, env: { ...cleanChildEnv(env), DEEPSEEK_API_KEY: apiKey }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: plan.shell,
    });
  } catch (err) {
    const why = explainStartFailure({ bin, cwd, err });
    return fail(ERR.CLI_START_FAILED, why.message, { reason: why.reason });
  }
  let spawnErr = null;   // 进程级错误（起不来 / 被系统杀），统一在这里记一次
  child.on('error', (err) => { spawnErr = err; });
  emit({ type: 'proc', pid: child.pid, command: plan.command });
  const spawned = await waitSpawned(child, spawnMs);
  if (!spawned.ok) {
    const why = explainStartFailure({ bin, cwd, err: spawned.error });
    return fail(ERR.CLI_START_FAILED, why.message, { reason: why.reason });
  }

  const state = {
    sessionId: resumeId, text: '', final: null, errorEvent: null, rawTail: '',
    sawEvent: false, abortedKind: null, usage: null,
  };
  const stderrTail = makeByteTail(16384);

  const handle = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    state.sawEvent = true;
    switch (obj.type) {
      case 'session': {
        // 首条事件带真实 sessionId：首轮就是它决定了以后用什么续聊
        const sid = typeof obj.sessionId === 'string' ? obj.sessionId : '';
        state.sessionId = sid || state.sessionId;
        emit({ type: 'session', sessionId: state.sessionId, resumed: Boolean(resumeId), cwd: obj.cwd });
        return;
      }
      case 'status': {
        const u = obj.usage;
        if (u && typeof u === 'object') state.usage = { ...state.usage, ...u };
        emit({ type: 'liveness', source: `status/${obj.phase}`, phase: obj.phase, turn: obj.turn });
        return;
      }
      case 'thinking':
        emit({ type: 'liveness', source: 'thinking' });
        return;
      case 'text':
        if (typeof obj.text === 'string' && obj.text !== '') {
          state.text += obj.text;
          emit({ type: 'delta', text: obj.text });
        }
        return;
      case 'tool_call':
        emit({ type: 'tool', phase: 'call', id: obj.callId, name: obj.tool, input: obj.input });
        return;
      case 'tool_result': {
        const text = (typeof obj.result === 'string' ? obj.result : (obj.error && obj.error.message) || '');
        // 命令行里若混进密钥（不该发生）先打码再往外发
        emit({
          type: 'tool_result', id: obj.callId, isError: obj.status === 'error',
          text: redactSecrets(text, { ...env, DEEPSEEK_API_KEY: apiKey }).slice(0, 2000),
        });
        return;
      }
      case 'final':
        state.final = obj;
        return;
      case 'error':
        state.errorEvent = obj;
        return;
      default: {
        // 没见过的事件：像审批/提问就单独报出来（讨论模式不放行任何需要确认的操作），其余只当活性
        const t = String(obj.type || '');
        if (/approval|permission|question|confirm/i.test(t)) emit({ type: 'approval', action: obj });
        else emit({ type: 'liveness', source: t });
      }
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
  child.stderr.on('data', (chunk) => stderrTail.push(chunk));

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
  // stderr 经 cmd.exe 出来，报错是 GBK；密钥只在内存里，进了输出也先打码
  const stderr = redactSecrets(decodeConsoleOutput(stderrTail.get()), { ...env, DEEPSEEK_API_KEY: apiKey }).trim();

  const base = { sessionId: state.sessionId, text: state.text, exitCode: closed.code };
  if (state.abortedKind) {
    return { ...base, kind: state.abortedKind, message: abortMessage(state.abortedKind) };
  }
  if (spawnErr) {
    const why = explainStartFailure({ bin, cwd, err: spawnErr });
    return { ...base, kind: ERR.CLI_START_FAILED, message: why.message, reason: why.reason };
  }

  if (state.errorEvent) {
    const msg = String(state.errorEvent.message || '');
    if (/does not exist|not found/i.test(msg)) {
      return { ...base, kind: ERR.SESSION_NOT_FOUND, reason: 'session_not_found', message: `DSH 找不到会话 ${resumeId}：${msg}` };
    }
    return { ...base, kind: ERR.CLI_ERROR, reason: 'cli_error', message: msg.slice(0, 800) || 'DSH 报错但没有给出原因' };
  }

  const fin = state.final;
  if (fin) {
    const reason = fin.reason || {};
    if (reason.kind === 'error') {
      const err = reason.error || {};
      const detail = [err.message, reason.message].filter(Boolean).join(' ') || JSON.stringify(reason).slice(0, 500);
      const code = String(err.code || '');
      let kind;
      if (/MISSING_CREDENTIAL|no API key/i.test(`${code} ${detail}`)) kind = ERR.CREDENTIALS_MISSING;
      else if (isAuthStatus(err.status) || /auth|unauthor|login/i.test(code) || /\b(401|403)\b/.test(`${code} ${detail}`)) kind = ERR.AUTH_FAILED;
      else kind = classifyErrorText(detail) || ERR.CLI_ERROR;
      return {
        ...base, kind, reason: kind === ERR.CLI_ERROR ? 'cli_error' : kind,
        apiErrorStatus: Number.isInteger(err.status) ? err.status : null,
        resetAt: extractResetAt(detail),
        message: detail.slice(0, 800),
      };
    }
    if (reason.kind === 'completed') {
      // 没收到过 text 事件时用 final.text 兜住（不编内容，只搬 CLI 给的）
      const finalText = state.text || (typeof fin.text === 'string' ? fin.text : '');
      if (!state.text && finalText) emit({ type: 'delta', text: finalText });
      return { ...base, kind: 'completed', text: finalText };
    }
    return { ...base, kind: ERR.UNKNOWN, message: `DSH 结束但终态不明（reason.kind=${reason.kind}）` };
  }

  if (closed.code === 0) {
    return {
      ...base, kind: ERR.UNKNOWN,
      message: `DSH 退出但没有 final 事件，执行结果未确认${state.rawTail ? `：${state.rawTail.slice(-300)}` : ''}`,
    };
  }
  if (!state.sawEvent) {
    // 一条事件都没吐出来就退了 = CLI 根本没起来（命令不存在、启动即崩），把具体原因带给用户
    const why = explainStartFailure({ bin, cwd, exitCode: closed.code, stderr: stderr || state.rawTail });
    return { ...base, kind: ERR.CLI_START_FAILED, reason: why.reason, message: why.message };
  }
  return { ...base, kind: ERR.CRASHED, reason: 'crashed', message: `DSH 异常退出（exit ${closed.code}）：${stderr.slice(-400) || '没有错误输出'}` };
}
