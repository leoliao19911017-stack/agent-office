// proc.mjs — 聊天适配器共用的子进程小工具（起进程 / 杀进程树 / 环境变量清洗 / 脱敏）。
//
// 两件事最容易在这里出错，所以单独成文件、只写一遍：
//   1) 嵌套会话隔离：本服务常常是从一个 Claude Code 会话里启动的，进程环境里带着
//      CLAUDECODE / CLAUDE_CODE_SESSION_ID / CLAUDE_CODE_MESSAGING_* 等变量。子 CLI 继承了
//      它们就可能挂到父会话上（写错会话文件、连上别人的消息管道）。一律不往下传。
//   2) Windows 上 .cmd/.bat 不能直接 exec，必须经 cmd.exe；路径含空格要整条加引号
//      （与 adapters/dsh.mjs 同一做法）。

import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';

export function isCmdFile(command) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(String(command));
}

export function shellQuote(s) {
  const text = String(s);
  return /[\s"&|<>^]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

/** 把「命令 + 参数」变成可直接交给 spawn 的形状 */
export function spawnPlan(command, args) {
  if (!isCmdFile(command)) return { command, args, shell: false };
  return {
    command: `"${command}" ${(args || []).map(shellQuote).join(' ')}`.trim(),
    args: [],
    shell: true,
  };
}

/** 杀整棵进程树（CLI 可能再拉子进程）。Windows 用 taskkill /T，其它平台退回 SIGKILL。 */
export function killTree(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  if (process.platform === 'win32') {
    try {
      const r = spawnSync('taskkill.exe', ['/PID', String(n), '/T', '/F'], { windowsHide: true, timeout: 8000, stdio: 'ignore' });
      return !r.error;
    } catch { /* 落到下面的 kill */ }
  }
  try { process.kill(n, 'SIGKILL'); return true; } catch { return false; }
}

/** 不传给子 CLI 的变量：嵌套会话标记（CLAUDECODE、CLAUDE_CODE_*）与父会话的 effort 设置 */
export function cleanChildEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || process.env)) {
    if (v === undefined) continue;
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k === 'CLAUDE_EFFORT') continue;
    out[k] = v;
  }
  return out;
}

/** 日志/报错里若混进密钥（不该发生）先打码：环境变量名带 KEY/TOKEN/SECRET/PASSWORD 且长度 ≥ 8 的值 */
export function redactSecrets(text, env) {
  let s = String(text ?? '');
  for (const [k, v] of Object.entries(env || {})) {
    if (!/KEY|TOKEN|SECRET|PASSWORD/i.test(k) || typeof v !== 'string' || v.length < 8) continue;
    if (s.includes(v)) s = s.split(v).join('[REDACTED]');
  }
  return s;
}

/** 等 spawn 成功或失败（Node 的 'error' 是异步发的，不await 会漏掉 ENOENT） */
export function waitSpawned(child, ms = 8000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: true }), ms);
    child.once('spawn', () => { clearTimeout(timer); resolve({ ok: true }); });
    child.once('error', (err) => { clearTimeout(timer); resolve({ ok: false, error: err }); });
  });
}

/* ---------------- 启动失败归因 ----------------
 * 「Agent 启动失败」四个字对用户没用：到底是命令找不到、路径写错、没权限、工作目录没了，
 * 还是进程一起来就崩（Windows 沙箱的 0xC0000142），要各说各的。
 * 这里只认操作系统 / shell 的机器文案（Node 的 err.code、cmd.exe 的 GBK/英文报错、NTSTATUS 退出码），
 * 不猜；认不出就如实写「启动后立即退出」并带上原始输出。
 */

/** Windows NTSTATUS：进程创建了，但在装载 / 初始化阶段就死（DLL 初始化失败、缺 DLL、映像格式不对） */
const BAD_START_STATUSES = new Set([0xC0000142, 0xC0000140, 0xC0000135, 0xC000007B]);
const REASONS = Object.freeze({
  CLI_PATH_MISSING: 'cli_path_missing',       // 给了路径，但那个位置没有这个文件
  CLI_NOT_FOUND: 'cli_not_found',             // 裸命令，PATH 里找不到
  CLI_NOT_EXECUTABLE: 'cli_not_executable',   // 路径在，但不是可执行文件（比如是个目录）
  PERMISSION_DENIED: 'permission_denied',
  WORKSPACE_NOT_FOUND: 'workspace_not_found',
  DLL_INIT_FAILED: 'dll_init_failed',
  SPAWN_ERROR: 'spawn_error',
  START_ERROR: 'start_error',
});
const hex = (n) => `0x${(n >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;

/**
 * 起进程之前先看一眼：bin 写成了路径就必须真的存在且是文件。返回 null 表示没问题。
 * 裸命令（dsh / claude）交给系统去找，找不到由 explainStartFailure 按启动结果说。
 */
export function preflightBin(bin) {
  const name = String(bin || '');
  if (!/[\\/]/.test(name) && !/^[A-Za-z]:/.test(name)) return null;
  let st;
  try { st = statSync(name); } catch {
    return { reason: REASONS.CLI_PATH_MISSING, message: `找不到 CLI：${name} 这个路径上没有文件（路径写错，或程序被卸载 / 移走了）` };
  }
  if (st.isDirectory()) return { reason: REASONS.CLI_NOT_EXECUTABLE, message: `${name} 是一个目录，不是可执行文件` };
  return null;
}

export function isDirectory(p) {
  try { return statSync(String(p)).isDirectory(); } catch { return false; }
}

/**
 * 把一次启动失败翻译成 { reason, message }。
 * @param {object} input
 * @param {string} input.bin          要启动的命令
 * @param {string} [input.cwd]        工作目录（Node 在 cwd 不存在时也报 ENOENT，要和「命令不存在」分开）
 * @param {Error}  [input.err]        spawn 的 'error' 事件（没有则不传）
 * @param {number|null} [input.exitCode]
 * @param {string} [input.stderr]     已解码的 stderr
 */
export function explainStartFailure({ bin, cwd = null, err = null, exitCode = null, stderr = '' }) {
  const name = String(bin || '');
  const out = String(stderr || '').trim();
  const tail = out ? out.replace(/\s+/g, ' ').slice(-300) : '';

  if (err) {
    const code = err.code || '';
    if (code === 'ENOENT') {
      if (cwd && !isDirectory(cwd)) return { reason: REASONS.WORKSPACE_NOT_FOUND, message: `工作目录不存在：${cwd}` };
      return { reason: REASONS.CLI_NOT_FOUND, message: `找不到命令 ${name}：系统里没有这个可执行文件（不在 PATH 里，或名字写错了）` };
    }
    if (code === 'EACCES' || code === 'EPERM') return { reason: REASONS.PERMISSION_DENIED, message: `没有权限执行 ${name}（${code}）` };
    return { reason: REASONS.SPAWN_ERROR, message: `启动 ${name} 失败：${err.message || err}` };
  }

  // Windows 上进程崩掉的退出码可能是无符号（3221225794）也可能是有符号（-1073741502），统一成无符号再比
  const n = Number(exitCode) >>> 0;
  if (Number.isInteger(Number(exitCode)) && BAD_START_STATUSES.has(n)) {
    return {
      reason: REASONS.DLL_INIT_FAILED,
      message: `${name} 一启动就崩了（exit ${hex(n)}）：进程初始化失败（DLL 初始化失败 / 缺少运行库 / 映像格式不对）${tail ? `；输出：${tail}` : ''}`,
    };
  }
  if (/不是内部或外部命令|不是可运行的程序|not recognized as an internal or external command|command not found|找不到命令/i.test(out)) {
    return { reason: REASONS.CLI_NOT_FOUND, message: `找不到命令 ${name}：系统找不到这个命令（不在 PATH 里，或名字写错了）` };
  }
  if (/拒绝访问|Access is denied|Permission denied|权限不足|\bEACCES\b|\bEPERM\b/i.test(out)) {
    return { reason: REASONS.PERMISSION_DENIED, message: `没有权限执行 ${name}（系统拒绝访问）` };
  }
  if (/系统找不到指定的文件|系统找不到指定的路径|cannot find the (?:file|path)|no such file or directory/i.test(out)) {
    return { reason: REASONS.CLI_PATH_MISSING, message: `找不到 CLI：${name} 不存在（路径写错，或文件已被移走 / 卸载）` };
  }
  return {
    reason: REASONS.START_ERROR,
    message: `${name} 启动后立即退出（exit ${exitCode ?? '?'}）${tail ? `：${tail}` : '，没有留下任何输出'}`,
  };
}

export { REASONS as START_FAIL_REASON };

/** 按 \n 切行（setEncoding('utf8') 已保证多字节字符不会被截断） */
export function makeLineSplitter(onLine) {
  let buf = '';
  return {
    push(chunk) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) onLine(line);
      }
    },
    flush() {
      if (buf.trim()) onLine(buf);
      buf = '';
    },
  };
}

/** 只留最后 maxBytes 字节的 Buffer 尾巴（stderr 留证用） */
export function makeByteTail(maxBytes = 16384) {
  let tail = Buffer.alloc(0);
  return {
    push(chunk) { tail = Buffer.concat([tail, chunk]); if (tail.length > maxBytes) tail = tail.subarray(tail.length - maxBytes); },
    get() { return tail; },
  };
}

const utf8Strict = new TextDecoder('utf-8', { fatal: true });

/**
 * 子进程 stderr 解码。Node 程序输出 UTF-8；经 cmd.exe 出来的报错（「不是内部或外部命令」）
 * 是控制台代码页（本机 936/GBK），按 UTF-8 解会成乱码，正则也认不出来。
 * 先按严格 UTF-8 解，解不了再按 GBK 解；都不行就原样按 UTF-8 解（宁可难看，不丢信息）。
 */
export function decodeConsoleOutput(buf) {
  if (!buf || buf.length === 0) return '';
  try { return utf8Strict.decode(buf); } catch { /* 不是 UTF-8 */ }
  try { return new TextDecoder('gbk').decode(buf); } catch { /* 这台 Node 没带 ICU */ }
  return buf.toString('utf8');
}
