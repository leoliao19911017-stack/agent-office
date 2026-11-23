// chat-state.test.js — 聊天状态机的纯逻辑（不碰 db / 进程 / 网络）：
// 错误 → 终态的归落（failed / interrupted / rate_limited / unknown）、界面五态、
// 「什么时候可以重试」的解析。口径来自 TASK-AgentChat-分批计划 P2 B5 / P4 / P5。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ERR, TURN, MSG, FAILED_KINDS, NOT_DELIVERED_KINDS, ACTIVE_TURN_STATUS, TURN_STATUS,
  statusForError, turnStatusLabel, displayStatusOf, DISPLAY, errorLabel, extractResetAt, retryHint, isRetryable,
} from '../web/chat/chat-state.mjs';

test('没跑成的错误落 failed（P2 B5：dsh 起不来时状态是 failed）', () => {
  assert.equal(statusForError(ERR.CLI_START_FAILED), TURN.FAILED);
  assert.equal(statusForError(ERR.CREDENTIALS_MISSING), TURN.FAILED);
  assert.equal(statusForError(ERR.AUTH_FAILED), TURN.FAILED);
  assert.equal(statusForError(ERR.SESSION_NOT_FOUND), TURN.FAILED);
  assert.equal(statusForError(ERR.CLI_ERROR), TURN.FAILED);
  for (const kind of FAILED_KINDS) assert.equal(statusForError(kind), TURN.FAILED, kind);
});

test('跑着被切断的落 interrupted；429 一族落 rate_limited；结果不明落 unknown', () => {
  for (const kind of [ERR.CANCELLED, ERR.CRASHED, ERR.SERVER_RESTARTED, ERR.TIMEOUT_CAP, ERR.MAX_TURNS]) {
    assert.equal(statusForError(kind), TURN.INTERRUPTED, kind);
  }
  assert.equal(statusForError(ERR.RATE_LIMIT), TURN.RATE_LIMITED);
  assert.equal(statusForError(ERR.QUOTA_EXHAUSTED), TURN.RATE_LIMITED);
  assert.equal(statusForError(ERR.UNKNOWN), TURN.UNKNOWN);
  assert.equal(statusForError('不认识的种类'), TURN.UNKNOWN, '不认识的种类不猜，落 unknown');
});

test('failed 不在「进行中」集合里：服务重启对账不会把它改写成 interrupted', () => {
  assert.ok(!ACTIVE_TURN_STATUS.has(TURN.FAILED));
  assert.ok(!ACTIVE_TURN_STATUS.has(TURN.RATE_LIMITED));
  for (const s of ['queued', 'starting', 'restoring', 'running', 'tool_running', 'approval_required']) {
    assert.ok(ACTIVE_TURN_STATUS.has(s), s);
  }
  assert.equal(TURN_STATUS.size, 11);
});

test('状态标签说具体原因：failed + 错误种类 → 「Agent 启动失败 / 会话已丢失」', () => {
  assert.equal(turnStatusLabel(TURN.FAILED, ERR.CLI_START_FAILED), 'Agent 启动失败');
  assert.equal(turnStatusLabel(TURN.FAILED, ERR.SESSION_NOT_FOUND), '会话已丢失');
  assert.equal(turnStatusLabel(TURN.FAILED, null), '执行失败');
  assert.equal(turnStatusLabel(TURN.RATE_LIMITED, ERR.QUOTA_EXHAUSTED), '额度暂不可用');
  assert.equal(turnStatusLabel(TURN.RATE_LIMITED, ERR.RATE_LIMIT), '请求受限');
  assert.equal(turnStatusLabel(TURN.QUEUED), '等待发送');
  assert.equal(turnStatusLabel(TURN.UNKNOWN), '执行结果未确认');
});

test('界面五态：排队 / 执行中 / 完成 / 失败 / 未知', () => {
  assert.equal(displayStatusOf(TURN.QUEUED), DISPLAY.QUEUED);
  for (const s of ['starting', 'restoring', 'running', 'tool_running', 'approval_required']) {
    assert.equal(displayStatusOf(s), DISPLAY.RUNNING, s);
  }
  assert.equal(displayStatusOf(TURN.COMPLETED), DISPLAY.COMPLETED);
  for (const s of ['failed', 'interrupted', 'rate_limited']) assert.equal(displayStatusOf(s), DISPLAY.FAILED, s);
  assert.equal(displayStatusOf(TURN.UNKNOWN), DISPLAY.UNKNOWN);
  assert.equal(displayStatusOf('随便什么'), DISPLAY.UNKNOWN, '不认识的状态不猜成完成或失败');
  assert.equal(displayStatusOf(null), DISPLAY.UNKNOWN);
});

test('用户这句话没交给模型的错误才把用户消息标 failed', () => {
  assert.deepEqual([...NOT_DELIVERED_KINDS].sort(), ['auth_failed', 'cli_start_failed', 'credentials_missing', 'session_not_found']);
  assert.ok(!NOT_DELIVERED_KINDS.has(ERR.CLI_ERROR), 'CLI 报错时消息已经交给 CLI 了');
  assert.ok(!NOT_DELIVERED_KINDS.has(ERR.CRASHED));
});

test('retryable：额度 / 认证 / 凭据 / 结果不明重试没用，其余都可以', () => {
  for (const kind of [ERR.QUOTA_EXHAUSTED, ERR.AUTH_FAILED, ERR.CREDENTIALS_MISSING, ERR.UNKNOWN]) assert.equal(isRetryable(kind), false, kind);
  for (const kind of [ERR.RATE_LIMIT, ERR.CLI_START_FAILED, ERR.SESSION_NOT_FOUND, ERR.CANCELLED, ERR.CRASHED]) assert.equal(isRetryable(kind), true, kind);
});

test('extractResetAt：只认带日期时间的重置文案，认不出返回 null（不编时间）', () => {
  const now = new Date('2026-11-24T04:40:00+08:00');
  assert.equal(extractResetAt('已达到 5 小时的使用上限，限额将在 2026-11-24 09:30 重置', now), '2026-11-24T01:30:00.000Z');
  assert.equal(extractResetAt('usage limit has been reached. Your limit will reset at 2026-11-24 09:30', now), '2026-11-24T01:30:00.000Z');
  assert.equal(extractResetAt('This request would exceed your organization\'s rate limit of 50,000 input tokens per minute.', now), null);
  assert.equal(extractResetAt('Your limit will reset at 9am.', now), null, '只有钟点没有日期 → 不猜是哪天');
  assert.equal(extractResetAt('', now), null);
  assert.equal(extractResetAt(null, now), null);
});

test('retryHint：有重置时间报时间，只有退避间隔报间隔，都没有就说稍后', () => {
  assert.equal(retryHint({ resetAt: '2026-11-24T01:30:00.000Z' }), '额度 11/24 09:30 重置，之后可以重试');
  assert.equal(retryHint({ resetAt: '2099-01-01T01:30:00.000Z' }), '额度 01/01 09:30 重置，之后可以重试', '月日补零');
  assert.equal(retryHint({ retryDelayMs: 2309, retryAttempt: 3, retryMax: 10 }), 'CLI 正在自动重试（第 3/10 次），约 2 秒后第 4 次');
  assert.equal(retryHint({ retryDelayMs: null, retryAttempt: null, retryMax: null }), '稍后可以重试');
  assert.equal(retryHint({}), '稍后可以重试');
});

test('errorLabel：不认识的种类按 unknown 显示，不冒充成别的', () => {
  assert.equal(errorLabel(ERR.RATE_LIMIT), '请求受限');
  assert.equal(errorLabel('nope'), '执行结果未确认');
});

test('MSG 是消息自己的状态词汇（与轮次十态不是一回事）', () => {
  assert.equal(MSG.FAILED, 'failed');
  assert.equal(MSG.RATE_LIMITED, 'rate_limited');
  assert.equal(MSG.UNKNOWN, 'unknown');
  assert.ok(!('idle' in MSG) && !('idle' in TURN), '聊天没有「空闲」这个状态');
});
