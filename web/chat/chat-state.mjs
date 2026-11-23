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
  unknown: '执行结果未确认',
});

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

/** 错误 → 用户看的那句话（任务书 §6.1） */
const ERR_LABEL = Object.freeze({
  rate_limit: '请求受限',
  quota_exhausted: '额度暂不可用',
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

/** 错误种类 → 轮次终态。只有 429 一族落到 rate_limited；有明确证据没跑完的落 interrupted；
 *  其余（结果不明）落 unknown——不兜底。 */
export function statusForError(kind) {
  if (kind === ERR.RATE_LIMIT || kind === ERR.QUOTA_EXHAUSTED) return TURN.RATE_LIMITED;
  if (kind === ERR.UNKNOWN) return TURN.UNKNOWN;
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
  if (status === TURN.INTERRUPTED && errorKind && errorKind !== ERR.CANCELLED) return errorLabel(errorKind);
  if (status === TURN.UNKNOWN) return TURN_LABEL.unknown;
  return TURN_LABEL[status] || TURN_LABEL.unknown;
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
