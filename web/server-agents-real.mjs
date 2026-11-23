// server-agents-real.mjs — X01（让 Agent 状态显示真实情况）：只读探测端点。
//
// 为什么要有这个模块：中台 /v1/state 的 seenAt 只是「中台刷新时刻」，7 个 agent
// 全都同一毫秒，拿它判在线是假的；codex 的 cost 恒为 0 也不可信。真实情况要从
// 本机事实里读：
//   进程   —— PowerShell Get-Process（claude / codex），活着≠能干活，分开报；
//   活动   —— 会话日志文件的 mtime（Claude: ~/.claude/projects/*/*.jsonl；
//             Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl）；
//   额度   —— 最新会话日志尾部有没有限额报错（Claude: 合成消息「已达到 5 小时的
//             使用上限」；Codex: usage_limit_exceeded）。
// 三条红线：只读（一个字节都不写）；任何一步失败 → 字段给 null + 说明，绝不 500、
// 绝不拿默认值假装成功（取不到就是 null，不猜）；结果缓存 5 秒，前端 3 秒一轮
// 轮询不会把磁盘扫爆。
//
// 限额判定防自指：Claude 的会话 jsonl 会原样记下本文件这类「含限额报错文本」的
// 源码与输出，直接搜字符串会命中自己。所以只认真正的合成错误消息——逐行
// JSON.parse，要求 type=assistant 且 model=<synthetic>；且「报错之后又出现过
// 正常 assistant 消息」视为已恢复，不算额度用完。
import { readdirSync, statSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';

const HOME = homedir().replace(/\\/g, '/');
const CLAUDE_PROJECTS = `${HOME}/.claude/projects`;
const CODEX_SESSIONS = `${HOME}/.codex/sessions`;
const CACHE_TTL_MS = 5000;
const TAIL_BYTES = 128 * 1024;
const CLAUDE_LIMIT_MARK = '已达到 5 小时的使用上限';

/** ISO 时间 → 本地「MM/DD HH:mm」，只用于给人看的说明文字 */
function fmtLocal(iso) {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(t.getMonth() + 1)}/${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`;
}

/** PowerShell 数进程。失败 → null（取不到就是未知，不许猜 0）。 */
function psCount(name) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-Command', `@(Get-Process -Name ${name} -ErrorAction SilentlyContinue).Count`],
      { timeout: 4000, maxBuffer: 64 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) { resolve({ count: null, error: err.message }); return; }
        const n = Number.parseInt(String(stdout).trim(), 10);
        resolve(Number.isFinite(n) ? { count: n, error: null } : { count: null, error: `输出不是数字：${String(stdout).trim().slice(0, 80)}` });
      },
    );
  });
}

/** 读文件末尾 maxBytes 字节（限额判定只看会话结尾，不必读全文件）。 */
function tailText(filePath) {
  let fd = -1;
  try {
    fd = openSync(filePath, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== -1) { try { closeSync(fd); } catch { /* 已尽力 */ } }
  }
}

/**
 * 在 dir/<sub>/<file> 里找 mtime 最新的 fileFilter 命中文件（一层子目录展开，
 * Claude 的 projects/<项目>/<会话>.jsonl 是这个形状）。返回 { path, mtimeMs }
 * 或 null。目录不存在等错误抛给调用方 try/catch 收口成 scanError。
 */
function newestJsonlFlat(dir, fileFilter) {
  let best = null;
  for (const sub of readdirSync(dir, { withFileTypes: true })) {
    if (!sub.isDirectory()) continue;
    const subDir = join(dir, sub.name);
    let names;
    try { names = readdirSync(subDir); } catch { continue; }
    for (const name of names) {
      if (!fileFilter(name)) continue;
      const p = join(subDir, name);
      try {
        const m = statSync(p).mtimeMs;
        if (!best || m > best.mtimeMs) best = { path: p, mtimeMs: m };
      } catch { /* 单个文件 stat 失败不拖垮整个扫描 */ }
    }
  }
  return best;
}

/** Codex 的 rollout 在 sessions/YYYY/MM/DD/ 三层日期目录下，单独走两层数字目录。 */
function newestCodexRollout(dayDirs) {
  let best = null;
  for (const day of dayDirs) {
    let names;
    try { names = readdirSync(day); } catch { continue; }
    for (const name of names) {
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
      const p = join(day, name);
      try {
        const m = statSync(p).mtimeMs;
        if (!best || m > best.mtimeMs) best = { path: p, mtimeMs: m };
      } catch { /* 同上 */ }
    }
  }
  return best;
}

/**
 * Claude 限额判定：从尾往回逐行看，最后一个「有效的状态事件」说了算——
 * 先遇到正常 assistant 消息 → 已恢复（false）；先遇到合成限额消息 → true。
 * 解析失败/无关行（user、tool_result……）跳过。整段都无 → false（读到且干净）。
 */
function claudeQuotaFromTail(tail) {
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.includes('"assistant"')) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || obj.type !== 'assistant' || !obj.message) continue;
    const contents = Array.isArray(obj.message.content) ? obj.message.content : [];
    if (obj.model === '<synthetic>') {
      for (const c of contents) {
        if (c && typeof c.text === 'string' && c.text.includes(CLAUDE_LIMIT_MARK)) {
          const at = c.text.indexOf(CLAUDE_LIMIT_MARK);
          const stop = c.text.indexOf('。', at);
          const m = c.text.slice(at).match(/限额将在\s*([\d\-]+\s+[\d:]+)\s*重置/);
          const t = m ? new Date(m[1].replace(' ', 'T')) : null;
          return {
            rateLimited: true,
            resetAt: t && !Number.isNaN(t.getTime()) ? t.toISOString() : null,
            sample: c.text.slice(at, stop > 0 ? stop + 1 : at + 120),
          };
        }
      }
    } else {
      return { rateLimited: false, resetAt: null, sample: null }; // 报错之后有过正常回复
    }
  }
  return { rateLimited: false, resetAt: null, sample: null };
}

/** Claude：扫全部项目目录的最新会话，尾部判限额。 */
function probeClaude() {
  const out = {
    processAlive: null, processCount: null, processError: null,
    lastActivityAt: null, lastActivityAgeSec: null, lastActivityFile: null,
    rateLimited: null, rateLimitResetAt: null, rateLimitSample: null, scanError: null,
    note: null,
  };
  try {
    const newest = newestJsonlFlat(CLAUDE_PROJECTS, (f) => f.endsWith('.jsonl'));
    if (newest) {
      out.lastActivityAt = new Date(newest.mtimeMs).toISOString();
      out.lastActivityAgeSec = Math.max(0, Math.round((Date.now() - newest.mtimeMs) / 1000));
      out.lastActivityFile = newest.path.replace(/\\/g, '/');
      const tail = tailText(newest.path);
      if (tail !== null) {
        const q = claudeQuotaFromTail(tail);
        out.rateLimited = q.rateLimited;
        out.rateLimitResetAt = q.resetAt;
        out.rateLimitSample = q.sample;
      }
    } else {
      out.scanError = `${CLAUDE_PROJECTS} 下没有找到任何会话 jsonl`;
    }
  } catch (err) {
    out.scanError = `扫描 ${CLAUDE_PROJECTS} 失败：${err.message}`;
  }
  return out;
}

/** Codex：会话按本地日期分目录（YYYY/MM/DD），扫今天+昨天，跨零点不漏。 */
function probeCodex() {
  const out = {
    processAlive: null, processCount: null, processError: null,
    lastActivityAt: null, lastActivityAgeSec: null, lastActivityFile: null,
    rateLimited: null, rateLimitResetAt: null, rateLimitSample: null, scanError: null,
    note: '中台 cost 恒为 0，不可信；额度以此处本地探测为准',
  };
  try {
    const now = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const dayDirs = [0, 1].map((back) => {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
      return join(CODEX_SESSIONS, String(d.getFullYear()), p2(d.getMonth() + 1), p2(d.getDate()));
    });
    const newest = newestCodexRollout(dayDirs);
    if (newest) {
      out.lastActivityAt = new Date(newest.mtimeMs).toISOString();
      out.lastActivityAgeSec = Math.max(0, Math.round((Date.now() - newest.mtimeMs) / 1000));
      out.lastActivityFile = newest.path.replace(/\\/g, '/');
      const tail = tailText(newest.path);
      if (tail !== null) {
        // codex 的限额错误是 task_complete 事件里带 codex_error_info:
        // usage_limit_exceeded；消息文本含 "You've hit your usage limit … try again at H:MM PM"。
        const marker = Math.max(
          tail.lastIndexOf('usage_limit_exceeded'),
          tail.lastIndexOf("You've hit your usage limit"),
        );
        if (marker >= 0) {
          out.rateLimited = true;
          // 「try again at …」文本在 codex_error_info 标记之前，得搜整个尾部。
          // R90 修：原文用弯引号 You’ve，不是直引号；而且 message 里还有 "Upgrade to Pro"
          // 这类干扰。直接找 "try again at H:MM AM/PM" 这一段最稳。
          const m = tail.match(/try again at (\d{1,2}):(\d{2})\s*(AM|PM)/i);
          if (m) {
            let h = Number(m[1]) % 12;
            if (/pm/i.test(m[3])) h += 12;
            // 「try again at …」不带日期，只有时刻；按会话所在目录的本地日期拼
            const dayDir = out.lastActivityFile.match(/\/(\d{4})\/(\d{2})\/(\d{2})\/rollout-/);
            if (dayDir) {
              const t = new Date(Number(dayDir[1]), Number(dayDir[2]) - 1, Number(dayDir[3]), h, Number(m[2]));
              out.rateLimitResetAt = Number.isNaN(t.getTime()) ? null : t.toISOString();
            }
          }
          const stop = tail.indexOf('\n', marker);
          out.rateLimitSample = tail.slice(marker, stop > 0 ? stop : marker + 160);
          // R90 修：rateLimited 不能只看「日志里出现过限额报错」——
          // 那是一条历史记录，重置时间过了就该恢复。按重置时间判：
          //   resetAt 已过  → 额度恢复了，rateLimited=false
          //   resetAt 未到  → rateLimited=true
          //   resetAt 没读到 → 保守判 true，但标记 resetUnknown
          if (out.rateLimitResetAt) {
            const resetMs = Date.parse(out.rateLimitResetAt);
            if (Number.isFinite(resetMs) && resetMs <= Date.now()) {
              out.rateLimited = false;
              out.note = `上次限额已于 ${fmtLocal(out.rateLimitResetAt)} 重置；历史日志里的 usage_limit_exceeded 是旧记录`;
              out.rateLimitExpired = true;
            }
          } else {
            out.rateLimitResetUnknown = true;
          }
        } else {
          out.rateLimited = false;
        }
      }
    } else {
      out.scanError = `${CODEX_SESSIONS} 下（今天/昨天）没有找到 rollout-*.jsonl`;
    }
  } catch (err) {
    out.scanError = `扫描 ${CODEX_SESSIONS} 失败：${err.message}`;
  }
  return out;
}

/** 采集一轮：进程数走 PowerShell（并发），日志扫描同步做（276 个 stat，毫秒级）。 */
async function collect() {
  const [claudePs, codexPs] = await Promise.all([psCount('claude'), psCount('codex')]);
  const claude = probeClaude();
  const codex = probeCodex();
  claude.processCount = claudePs.count;
  claude.processAlive = claudePs.count === null ? null : claudePs.count > 0;
  claude.processError = claudePs.error;
  codex.processCount = codexPs.count;
  codex.processAlive = codexPs.count === null ? null : codexPs.count > 0;
  codex.processError = codexPs.error;
  return { generatedAt: new Date().toISOString(), agents: { claude, codex } };
}

// 5 秒缓存 + 在途合并：缓存期内直接回旧结果；刚好过期时有并发请求只采一轮。
let cache = { at: 0, data: null };
let inflight = null;

/** GET /api/agents/real 的处理器（maker 风格对齐 server-api.mjs 其余路由）。 */
export function makeAgentsRealRoute(deps) {
  const { sendJson } = deps;
  return async (req, res) => {
    const now = Date.now();
    if (cache.data && now - cache.at < CACHE_TTL_MS) {
      sendJson(res, 200, { ...cache.data, cacheAgeSec: Math.round((now - cache.at) / 100) / 10 });
      return;
    }
    if (!inflight) {
      inflight = collect()
        .then((data) => { cache = { at: Date.now(), data }; return data; })
        .finally(() => { inflight = null; });
    }
    // collect 内部每一步都有自己的 try/catch 收口，这里的 await 不会抛——
    // 任何探测失败都以字段级 null + scanError 返回，端点永不 500。
    const data = await inflight;
    sendJson(res, 200, { ...data, cacheAgeSec: 0 });
    return;
  };
}
