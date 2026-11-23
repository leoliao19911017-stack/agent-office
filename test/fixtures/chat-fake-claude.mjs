// fake-claude.mjs — 测试夹具：假 Claude Code CLI（给 test/chat-http.test.js 用，不联网、不花额度）。
// 形状照着真 CLI 的 stream-json 抄（system/init → stream_event/text_delta → assistant → result），
// 续聊参数也与真 CLI 一致：新建 --session-id <id>（已存在 → 报 already in use），续聊 --resume <id>（不存在 → 报 No conversation found）。
// 「会话记忆」落在 FAKE_CLI_HOME/sessions/<id>.json，所以续聊真能接上上一句（用来验证多轮上下文的链路）。
//
// 行为由提示词里的机器标记控制（仅测试用）：
//   [slow]  慢速流式：40 片，每片间隔 FAKE_CLI_DELAY_MS（默认 60ms）
//   [hang]  永不结束（等被杀）
//   [429]   吐 api_retry + <synthetic> 报错 + result(is_error, api_error_status=429)
//   [quota] 同上，但文案是 GLM 的额度上限形状（带重置时间）
//   [crash] 初始化后以 0xC0000142 退出
// 普通提示词 → 回复「假 Claude 收到：<原文>｜本会话此前有 N 句」；问「第一句」→ 原样引用会话里的第一句。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const DELAY = Number(process.env.FAKE_CLI_DELAY_MS) || 60;
const HOME = process.env.FAKE_CLI_HOME;
if (!HOME) { console.error('fake-claude: 需要 FAKE_CLI_HOME'); process.exit(2); }
const DIR = join(HOME, 'claude-sessions');
mkdirSync(DIR, { recursive: true });

const args = process.argv.slice(2);
function flag(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }
const sessionId = flag('--session-id');
const resumeId = flag('--resume');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => main(input).catch((err) => { console.error(err && err.stack ? err.stack : err); process.exit(1); }));
if (process.stdin.isTTY) main('').catch((err) => { console.error(err); process.exit(1); });

async function main(prompt) {
  if (resumeId) {
    let history = null;
    try { history = JSON.parse(readFileSync(join(DIR, `${resumeId}.json`), 'utf8')); } catch { history = null; }
    if (!history) {
      process.stderr.write(`No conversation found with session ID: ${resumeId}\n`);
      process.exit(1);
    }
    return run(resumeId, history, prompt);
  }
  if (sessionId) {
    try {
      readFileSync(join(DIR, `${sessionId}.json`));
      process.stderr.write(`Session ID ${sessionId} is already in use\n`);
      process.exit(1);
    } catch { /* 不存在 = 可以新建 */ }
    return run(sessionId, { messages: [] }, prompt);
  }
  process.stderr.write('fake-claude: 需要 --session-id 或 --resume\n');
  process.exit(1);
}

async function run(sid, history, prompt) {
  const sidField = { session_id: sid };
  out({ type: 'system', subtype: 'init', cwd: process.cwd(), tools: ['Read', 'Grep', 'Glob'], model: 'fake-claude', permissionMode: 'plan', ...sidField });
  // 真 CLI 在 init 时就已经把会话落盘；这里一样（之后崩溃也会留下会话文件）
  writeFileSync(join(DIR, `${sid}.json`), JSON.stringify(history));

  if (/\[crash\]/.test(prompt)) process.exit(0xC0000142);

  if (/\[429\]|\[quota\]/.test(prompt)) {
    const quota = /\[quota\]/.test(prompt);
    const text = quota
      ? '已达到 5 小时的使用上限。限额将在 2099-01-01 09:30 重置'
      : 'API Error: Request rejected (429) · This request would exceed your organization\'s rate limit of 50,000 input tokens per minute.';
    for (const attempt of [1, 2]) {
      await sleep(DELAY);
      out({ type: 'system', subtype: 'api_retry', attempt, max_retries: 2, retry_delay_ms: 50, error_status: 429, error: quota ? 'usage_limit' : 'rate_limit', ...sidField });
    }
    out({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text }] }, error: quota ? 'usage_limit_reached' : 'rate_limit', ...sidField });
    out({
      type: 'result', subtype: 'success', is_error: true, terminal_reason: 'api_error', api_error_status: 429,
      result: text, num_turns: 1, duration_ms: DELAY * 2, usage: { input_tokens: 0, output_tokens: 0 }, ...sidField,
    });
    return;
  }

  if (/\[hang\]/.test(prompt)) { for (;;) await sleep(1000); }

  const first = history.messages[0] || null;
  const reply = /第一句|first message/i.test(prompt)
    ? `你第一句的原文是：${first || '（这个会话还没有第一句）'}`
    : `假 Claude 收到：${prompt}｜本会话此前有 ${history.messages.length} 句`;
  history.messages.push(prompt);
  writeFileSync(join(DIR, `${sid}.json`), JSON.stringify(history));

  const pieces = /\[slow\]/.test(prompt) ? Array.from({ length: 40 }, (_, i) => `第${i + 1}片·`) : Array.from(reply);
  for (const piece of pieces) {
    if (/\[slow\]/.test(prompt)) await sleep(DELAY);
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } }, ...sidField });
  }
  const full = pieces.join('');
  out({ type: 'assistant', message: { id: `msg_${randomUUID().slice(0, 8)}`, model: 'fake-claude', content: [{ type: 'text', text: full }], usage: { input_tokens: 12, output_tokens: full.length } }, ...sidField });
  out({
    type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', num_turns: 1,
    duration_ms: pieces.length * DELAY, usage: { input_tokens: 12, output_tokens: full.length }, result: full, ...sidField,
  });
}
