// dsh-chat.mjs — DSH 的聊天适配器（一轮对话 = 一次 dsh headless 调用，ADR-01 按需启动）。
//
// 续聊口径（TASK-AgentChat-V1 §3.1，本机 0.2.2-rc.5 实测）：
//   新建会话   dsh --profile headless --json … -          （不传 --session-id）
//              stdout 第一条 {"type":"session","sessionId":"session-<uuid>"} 就是真实 ID，必须存下来
//   续聊       dsh --profile headless --json … --session-id <那个真实 ID> -
//   未知 ID    {"type":"error","message":"session \"…\" does not exist; omit --session-id to start a new Session"}，exit 1
//   所以这里的 ID 只能来自首轮输出（由 chat-db 回填），绝不自己编。
//
// 上下文交给 DSH 自己的会话文件；每轮只发用户这一句话（ADR-04）。
//
// 讨论模式（ADR-06）：--permission-mode read-only + --approval-policy never。
//   read-only 预设 = 沙箱只读 + 需要提权的操作要审批；approval never = 没人审批就一律拒绝。
//   实测让它写文件 → tool_result 报 FS_SANDBOX_DENIED「file access denied under read-only mode」。
//   不用 danger-full-access：那会绕过文件系统限制（任务书 §7）。
//
// 凭据：headless profile 的凭据服务是关的，只认环境变量 DEEPSEEK_API_KEY。本机既有做法
// （C:/Tools/agent-autoloop/dsh-agent.js）是环境变量没有就读 ~/.dsh/.credentials.yaml 的
// refs.DEEPSEEK_API_KEY，只放内存、不打印。这里沿用同一口径，密钥不进日志、不进库、不回传。
//
// 输出是 NDJSON 运行事件（session / status / thinking / text / tool_call / tool_result / final / error）。
// 实测 text 事件是「每一步一条整段」，不是逐字——所以 DSH 这边的增量粒度是：
// 开始 / 阶段变化 / 工具调用实时到达，正文按步到达。
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  cleanChildEnv, decodeConsoleOutput, killTree, makeByteTail, makeLineSplitter, redactSecrets, spawnPlan, waitSpawned,
} from '../proc.mjs';
import { classifyErrorText, ERR, isAuthStatus } from '../chat-state.mjs';

export const DSH_PERMISSION_MODE = 'read-only';
export const DSH_APPROVAL_POLICY = 'never';

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

/** 组参数：resumeId 只能是首轮拿到的真实 ID */
export function dshArgs({ resumeId = null } = {}) {
  const args = ['--profile', 'headless', '--json', '--permission-mode', DSH_PERMISSION_MODE, '--approval-policy', DSH_APPROVAL_POLICY];
  if (resumeId) args.push('--session-id', resumeId);
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
 * onEvent 收到：proc{pid} / session{sessionId,resumed} / delta{text} / tool{phase,id,name,input} /
 * tool_result{id,isError,text} / approval{action} / liveness{source,phase?}。
 */
export async function runDshTurn(opts) {
  const {
    prompt, resumeId = null, cwd, bin = defaultDshBin(), env = process.env,
    onEvent = () => {}, signal = null, spawnMs = 10000,
  } = opts;
  const emit = (ev) => { try { onEvent(ev); } catch { /* 监听方出错不影响继续解析输出 */ } };
  const fail = (kind, message, extra = {}) => ({ kind, message, sessionId: resumeId, text: '', exitCode: null, ...extra });

  const apiKey = sourceDeepSeekKey(env);
  if (!apiKey) {
    return fail(ERR.CREDENTIALS_MISSING, 'DSH 没有 DEEPSEEK_API_KEY：环境变量里没有，~/.dsh/.credentials.yaml 里也没读到');
  }

  const plan = spawnPlan(bin, dshArgs({ resumeId }));
  let child;
  try {
    child = spawn(plan.command, plan.args, {
      cwd, env: { ...cleanChildEnv(env), DEEPSEEK_API_KEY: apiKey }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: plan.shell,
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
    sessionId: resumeId, text: '', final: null, errorEvent: null, rawTail: '',
    sawEvent: false, abortedKind: null,
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
      case 'status':
        emit({ type: 'liveness', source: `status/${obj.phase}`, phase: obj.phase, turn: obj.turn });
        return;
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
      case 'tool_result':
        emit({
          type: 'tool_result', id: obj.callId, isError: obj.status === 'error',
          text: (typeof obj.result === 'string' ? obj.result : (obj.error && obj.error.message) || '').slice(0, 2000),
        });
        return;
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
    child.once('error', (err) => { state.rawTail += `\n[进程错误] ${err.message}`; });
  });
  if (signal) signal.removeEventListener('abort', onAbort);
  stdoutLines.flush();
  // stderr 经 cmd.exe 出来，报错是 GBK；密钥只在内存里，进了输出也先打码
  const stderr = redactSecrets(decodeConsoleOutput(stderrTail.get()), { ...env, DEEPSEEK_API_KEY: apiKey }).trim();

  const base = { sessionId: state.sessionId, text: state.text, exitCode: closed.code };
  if (state.abortedKind) {
    return { ...base, kind: state.abortedKind, message: abortMessage(state.abortedKind) };
  }

  if (state.errorEvent) {
    const msg = String(state.errorEvent.message || '');
    if (/does not exist|not found/i.test(msg)) {
      return { ...base, kind: ERR.SESSION_NOT_FOUND, message: `DSH 找不到会话 ${resumeId}：${msg}` };
    }
    return { ...base, kind: ERR.CLI_ERROR, message: msg.slice(0, 800) || 'DSH 报错但没有给出原因' };
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
      return { ...base, kind, message: detail.slice(0, 800) };
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
    // 一条事件都没吐出来就退了 = CLI 根本没起来（命令不存在、启动即崩），把 stderr 原因带给用户
    return { ...base, kind: ERR.CLI_START_FAILED, message: `无法启动 ${bin}：${(stderr || state.rawTail).slice(-400) || `exit ${closed.code}`}` };
  }
  return { ...base, kind: ERR.CRASHED, message: `DSH 异常退出（exit ${closed.code}）：${stderr.slice(-400) || '没有错误输出'}` };
}
