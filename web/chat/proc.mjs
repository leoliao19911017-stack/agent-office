// proc.mjs — 聊天适配器共用的子进程小工具（起进程 / 杀进程树 / 环境变量清洗 / 脱敏）。
//
// 两件事最容易在这里出错，所以单独成文件、只写一遍：
//   1) 嵌套会话隔离：本服务常常是从一个 Claude Code 会话里启动的，进程环境里带着
//      CLAUDECODE / CLAUDE_CODE_SESSION_ID / CLAUDE_CODE_MESSAGING_* 等变量。子 CLI 继承了
//      它们就可能挂到父会话上（写错会话文件、连上别人的消息管道）。一律不往下传。
//   2) Windows 上 .cmd/.bat 不能直接 exec，必须经 cmd.exe；路径含空格要整条加引号
//      （与 adapters/dsh.mjs 同一做法）。

import { spawnSync } from 'node:child_process';

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
