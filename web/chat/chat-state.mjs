// chat-state.mjs — 聊天的状态、文案与错误分类（纯逻辑，不碰 db / 进程 / 网络）。
//
// 沿用看板的「不许撒谎」原则（TASK-AgentChat-V1 §六）：
//   状态只有任务书列的十种；没有可靠证据一律 unknown，绝不兜底成「空闲」。
//   错误文案按真实原因写：CLI 起不来 / 429 / 额度耗尽 / 会话丢失 / 进程异常退出 各说各的。

/** V1 接入的 provider。codex（本机执行器起不来）与 hermes（会话能力待验证）本轮不接，不伪装。 */
export const CHAT_PROVIDERS = Object.freeze(['claude', 'dsh']);
const PROVIDER = new Set(CHAT_PROVIDERS);

/** 未接入的 Agent 在面板里怎么说（如实写原因，不给一个能打字但发不出去的假输入框） */
export const UNSUPPORTED_REASON = Object.freeze({
  codex: '本机 codex 执行器起不来（CreateProcess 超时），V1 不接入',
  hermes: 'hermes 本地网关的会话能力还没实测，V1 不接入',
});

/** 讨论模式是 V1 唯一开放的模式（ADR-06）：能读、能分析、能回答；不开放写代码和 Shell 执行。 */
export const CHAT_MODES = Object.freeze(['discuss']);

export const TURN = Object.freeze({
  QUEUED: 'queued',
  STARTING: 'starting',
  RESTORING: 'restoring',
  RUNNING: 'running',
  TOOL_RUNNING: 'tool_running',
  APPROVAL_REQUIRED: 'approval_required',
  COMPLETED: 'completed',
  RATE_LIMITED: 'rate_limited',
  INTERRUPTED: 'interrupted',
  FAILED: 'failed',
  UNKNOWN: 'unknown',
});

export const TURN_STATUS = new Set(Object.values(TURN));

/** 还没走到终态的状态（服务重启时这些轮次要落成 interrupted，不能挂着装作还在跑） */
export const ACTIVE_TURN_STATUS = new Set([
  TURN.QUEUED, TURN.STARTING, TURN.RESTORING, TURN.RUNNING, TURN.TOOL_RUNNING, TURN.APPROVAL_REQUIRED,
]);

/** 任务书 §六 的状态文案，一个状态一句话，前后端同一份 */
export const TURN_LABEL = Object.freeze({
  queued: '等待发送',
  starting: '正在启动 Agent',
  restoring: '正在恢复会话',
  running: '正在回答',
  tool_running: '正在执行工具',
  approval_required: '等待你的确认',
  completed: '回答完成',
  rate_limited: '请求受限',
  interrupted: '执行中断',
  failed: '执行失败',
  unknown: '执行结果未确认',
});

/**
 * 界面五态（分批计划 P4）：queued 排队 / running 执行中 / completed 完成 / failed 失败 / unknown 未知。
 * 十态是引擎的精确状态，五态是给人看的大类；具体原因另由 status_label / error 带出。
 */
export const DISPLAY = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  UNKNOWN: 'unknown',
});
export const DISPLAY_LABEL = Object.freeze({
  queued: '排队', running: '执行中', completed: '完成', failed: '失败', unknown: '未知',
});

/** 十态 → 五态。starting/restoring 算执行中（已经开始为这句话干活了），rate_limited 算失败（带「请求受限」标签） */
export function displayStatusOf(status) {
  if (status === TURN.QUEUED) return DISPLAY.QUEUED;
  if (status === TURN.COMPLETED) return DISPLAY.COMPLETED;
  if (status === TURN.UNKNOWN) return DISPLAY.UNKNOWN;
  if (ACTIVE_TURN_STATUS.has(status)) return DISPLAY.RUNNING;
  if (status === TURN.FAILED || status === TURN.INTERRUPTED || status === TURN.RATE_LIMITED) return DISPLAY.FAILED;
  return DISPLAY.UNKNOWN;   // 不认识的状态不猜
}

/** 消息状态：用户消息 stored→sent；助手消息 streaming→complete / 其它终态与轮次同名 */
export const MSG = Object.freeze({
  STORED: 'stored',       // 已落库，还没交给 CLI（消息在这里就不会丢）
  SENT: 'sent',           // 已交给 CLI
  STREAMING: 'streaming', // 正在接收
  COMPLETE: 'complete',   // 完整收到
  PARTIAL: 'partial',     // 收到一部分但本轮没完成（保留已得内容，不冒充完整）
  FAILED: 'failed',       // 没能发出去（CLI 没起来）
  RATE_LIMITED: 'rate_limited',
  INTERRUPTED: 'interrupted',
  UNKNOWN: 'unknown',
});

/** SSE 事件类型。前六个是任务书 §五 定的；status / retry / snapshot 是补充的：
 *  status  轮次状态变化、卡住提醒；retry  CLI 自己的退避重试进度；snapshot  订阅时的全量快照。 */
export const EVT = Object.freeze({
  STARTED: 'started',
  RESTORING: 'restoring',
  DELTA: 'delta',
  TOOL: 'tool',
  COMPLETED: 'completed',
  ERROR: 'error',
  STATUS: 'status',
  RETRY: 'retry',
  SNAPSHOT: 'snapshot',
});

export const ERR = Object.freeze({
  RATE_LIMIT: 'rate_limit',               // 429 / 限流：可重试
  QUOTA_EXHAUSTED: 'quota_exhausted',     // 额度耗尽：暂停但保留 Session
  AUTH_FAILED: 'auth_failed',
  CREDENTIALS_MISSING: 'credentials_missing',
  CLI_START_FAILED: 'cli_start_failed',   // 命令不存在 / 起不来
  SESSION_NOT_FOUND: 'session_not_found', // DSH 不认识这个 session-id
  CANCELLED: 'cancelled',                 // 用户主动停止
  CRASHED: 'crashed',                     // 进程异常退出
  SERVER_RESTARTED: 'server_restarted',   // 服务重启 / 停止，本轮没人盯着了
  TIMEOUT_CAP: 'timeout_cap',             // 超过硬上限，被引擎停止
  MAX_TURNS: 'max_turns',                 // CLI 自己的轮数上限
  CLI_ERROR: 'cli_error',                 // CLI 明确报了错，但不是上面任何一类
  UNKNOWN: 'unknown',                     // 没有可靠证据说结果如何
});

/**
 * 哪些错误落 failed（没跑成：起不来 / 没凭据 / 认证不过 / 会话丢了 / CLI 明确报错），
 * 哪些落 interrupted（跑着被切断：崩溃 / 超时 / 取消 / 服务重启 / 轮数上限）。
 * 分开是因为对用户是两回事：failed 该查环境，interrupted 该看已保存的输出再决定重试。
 */
export const FAILED_KINDS = new Set([
  ERR.CLI_START_FAILED, ERR.CREDENTIALS_MISSING, ERR.AUTH_FAILED, ERR.SESSION_NOT_FOUND, ERR.CLI_ERROR,
]);
/** 这些错误发生时，用户这句话根本没交给模型 → 用户消息也标 failed（不是 sent） */
export const NOT_DELIVERED_KINDS = new Set([
  ERR.CLI_START_FAILED, ERR.CREDENTIALS_MISSING, ERR.AUTH_FAILED, ERR.SESSION_NOT_FOUND,
]);

/** 错误 → 用户看的那句话（任务书 §6.1） */
const ERR_LABEL = Object.freeze({
  rate_limit: '请求受限',
  // 任务书 P5：429 / 限额都归「请求受限」这一句；「额度已用尽」的细分由 detail / message 说，
  // 不给人两套词（界面头部原来会把额度显示成另一句，和任务书不一致）。
  quota_exhausted: '请求受限',
  auth_failed: '认证失败',
  credentials_missing: '凭据缺失',
  cli_start_failed: 'Agent 启动失败',
  session_not_found: '会话已丢失',
  cancelled: '已停止',
  crashed: '本轮中断',
  server_restarted: '本轮中断',
  timeout_cap: '本轮中断',
  max_turns: '本轮中断',
  cli_error: 'Agent 报错',
  unknown: '执行结果未确认',
});

export function isErrorKind(kind) {
  return Object.prototype.hasOwnProperty.call(ERR_LABEL, kind);
}

/** 错误种类 → 面板上的短标签；不认识的种类不猜，按 unknown 显示 */
export function errorLabel(kind) {
  return ERR_LABEL[kind] || ERR_LABEL.unknown;
}

/** 错误种类 → 轮次终态。429 一族落 rate_limited；没跑成的落 failed；跑着被切断的落 interrupted；
 *  其余（结果不明）落 unknown——不兜底。 */
export function statusForError(kind) {
  if (kind === ERR.RATE_LIMIT || kind === ERR.QUOTA_EXHAUSTED) return TURN.RATE_LIMITED;
  if (kind === ERR.UNKNOWN) return TURN.UNKNOWN;
  if (FAILED_KINDS.has(kind)) return TURN.FAILED;
  if (isErrorKind(kind)) return TURN.INTERRUPTED;
  return TURN.UNKNOWN;
}

/** 这类错误值不值得「重试」：额度和认证重试没用，其余都可以 */
export function isRetryable(kind) {
  return kind !== ERR.QUOTA_EXHAUSTED && kind !== ERR.AUTH_FAILED && kind !== ERR.CREDENTIALS_MISSING && kind !== ERR.UNKNOWN;
}

/** 轮次状态 → 标签。rate_limited 的两种（限流 / 额度）文案不同，由错误种类决定。 */
export function turnStatusLabel(status, errorKind = null) {
  if (status === TURN.RATE_LIMITED && errorKind) return errorLabel(errorKind);
  if (status === TURN.FAILED && errorKind) return errorLabel(errorKind);
  if (status === TURN.INTERRUPTED && errorKind && errorKind !== ERR.CANCELLED) return errorLabel(errorKind);
  if (status === TURN.UNKNOWN) return TURN_LABEL.unknown;
  return TURN_LABEL[status] || TURN_LABEL.unknown;
}

const RESET_AT_PATTERNS = [
  // GLM 网关的真实文案：「限额将在 2026-11-24 09:30 重置」（与 adapters/claude.mjs 认的同一形状）
  /限[额度].{0,12}(?:将|会)?在\s*((?:\d{4}[-/])?\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2})\s*(?:左右)?(?:重置|恢复)/i,
  // Anthropic 官方：「usage limit will reset at 3pm (UTC)」/「resets at 2026-11-24 09:30」
  /reset(?:s)?\s+(?:at|on)\s+(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2})/i,
];

/**
 * 从 CLI 的报错原文里认出「什么时候可以重试」的绝对时间。只认带日期时间的机器文案；
 * 认不出返回 null（界面就写「稍后重试」，不编一个时间）。输入按本机时区理解。
 */
export function extractResetAt(text, now = new Date()) {
  const s = String(text || '');
  for (const re of RESET_AT_PATTERNS) {
    const m = s.match(re);
    if (!m) continue;
    const raw = m[1].replace(/\//g, '-').replace(' ', 'T');
    const full = /^\d{4}-/.test(raw) ? raw : `${now.getFullYear()}-${raw}`;
    const t = new Date(full);
    if (!Number.isNaN(t.getTime())) return t.toISOString();
  }
  return null;
}

/**
 * 「什么时候可以重试」的人话。有绝对时间就报时间；只有 CLI 的退避间隔就报「N 秒后自动重试」；
 * 都没有就说稍后重试——不显示假的倒计时。
 */
export function retryHint({ resetAt = null, retryDelayMs = null, retryAttempt = null, retryMax = null } = {}) {
  if (resetAt) {
    const t = new Date(resetAt);
    if (!Number.isNaN(t.getTime())) {
      const p = (n) => String(n).padStart(2, '0');
      const stamp = `${p(t.getHours())}:${p(t.getMinutes())}`;
      const day = `${p(t.getMonth() + 1)}/${p(t.getDate())}`;
      return `额度 ${day} ${stamp} 重置，之后可以重试`;
    }
  }
  if (retryDelayMs != null && retryDelayMs !== '' && Number.isFinite(Number(retryDelayMs)) && Number(retryDelayMs) >= 0) {
    const sec = Math.max(1, Math.round(Number(retryDelayMs) / 1000));
    const n = retryAttempt != null && retryMax != null ? `（第 ${retryAttempt}/${retryMax} 次）` : '';
    const next = retryAttempt != null ? `第 ${Number(retryAttempt) + 1} 次` : '下一次';
    return `CLI 正在自动重试${n}，约 ${sec} 秒后${next}`;
  }
  return '稍后可以重试';
}

/**
 * 从 CLI 的报错原文里认出「额度耗尽 / 限流 / 认证失败」。
 * 只认机器错误文本（HTTP 状态字样、CLI 的合成错误消息），不用来理解用户说的话。
 * 返回 ERR 里的种类，认不出返回 null（调用方按自己的证据决定，不在这里猜）。
 */
export function classifyErrorText(text) {
  const s = String(text || '');
  if (!s) return null;
  // 认证：401/403 或 login/credential 字样（排除 429 里的 “rate limit” 误伤）
  if (/\b(401|403)\b|unauthori[sz]ed|invalid.?api.?key|authentication|认证|登录|凭据/i.test(s)) return ERR.AUTH_FAILED;
  // 额度耗尽：按用量计的上限（5 小时窗口 / usage limit / 额度 / 使用上限），带重置时间
  if (/usage.?limit|usage_limit_reached|已达到.{0,12}使用上限|使用上限|额度|用量上限|限额将在|quota/i.test(s)) return ERR.QUOTA_EXHAUSTED;
  // 限流：按频率计的（429 / rate limit / too many requests）
  if (/\b429\b|rate.?limit|too many requests|限流|频率/i.test(s)) return ERR.RATE_LIMIT;
  return null;
}

/** 认证类错误码（HTTP 状态） */
export function isAuthStatus(status) {
  const n = Number(status);
  return n === 401 || n === 403;
}

export function isSupportedAgent(agentId) {
  return PROVIDER.has(String(agentId));
}

export function isSupportedMode(mode) {
  return mode === 'discuss';
}

export function isActiveTurn(status) {
  return ACTIVE_TURN_STATUS.has(status);
}

/**
 * 这一轮还在不在进行（给只拿得到库行的地方用）：
 * 状态在「进行中」集合里，或者处于限流重试中（rate_limited 且还没有 ended_at——
 * 引擎只在真正结束时写 ended_at；终态的 rate_limited 一定带 ended_at）。
 */
export function isTurnActive(turn) {
  if (!turn) return false;
  if (ACTIVE_TURN_STATUS.has(turn.status)) return true;
  return turn.status === TURN.RATE_LIMITED && !turn.ended_at;
}
