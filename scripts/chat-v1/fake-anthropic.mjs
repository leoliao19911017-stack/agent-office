// fake-anthropic.mjs — T6 用的本地假 Anthropic 接口：让「真 Claude CLI」吃到真 HTTP 429。
// 不是假 CLI——claude 可执行文件、它的重试逻辑、它吐出的事件形状全是真的，只有上游换成它。
//
// 用法：node scripts/chat-v1/fake-anthropic.mjs [port] [mode]
//   mode = 429   （默认）每条 /v1/messages 都回 429 rate_limit_error
//   mode = quota  每条 /v1/messages 都回 429 usage_limit_reached（额度耗尽形状）
//   mode = glm-quota  同上，但文案是本机 GLM 网关的真实形状「已达到 5 小时的使用上限。限额将在 <时间> 重置」
//                     （重置时间默认明天 09:30，可用环境变量 FAKE_RESET_AT="YYYY-MM-DD HH:mm" 指定）——P5 验收用
//   mode = ok     回一个最小的合法流式回复（给对照用）
// 进程每收到一条请求就往 stdout 打一行 JSON（计数留证据）。
import { createServer } from 'node:http';

const port = Number(process.argv[2]) || 18790;
const mode = process.argv[3] || '429';
let n = 0;

function defaultResetAt() {
  if (process.env.FAKE_RESET_AT) return process.env.FAKE_RESET_AT;
  const d = new Date(Date.now() + 24 * 3600 * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} 09:30`;
}

const ERRORS = {
  '429': {
    type: 'rate_limit_error',
    message: 'This request would exceed your organization\'s rate limit of 50,000 input tokens per minute. For details, refer to: https://docs.claude.com/en/api/rate-limits. You can contact sales at https://www.anthropic.com/contact-sales to increase your rate limit.',
  },
  quota: {
    type: 'usage_limit_reached',
    message: 'This request exceeds your organization\'s usage limit. Your limit will reset at 9am.',
  },
  'glm-quota': {
    type: 'usage_limit_reached',
    message: `已达到 5 小时的使用上限。限额将在 ${defaultResetAt()} 重置`,
  },
};

createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    n += 1;
    let model = null;
    try { model = JSON.parse(body).model; } catch { /* 非 JSON */ }
    console.log(JSON.stringify({ n, method: req.method, url: req.url, model, mode, at: new Date().toISOString() }));

    if (req.method === 'POST' && req.url.startsWith('/v1/messages')) {
      if (mode === 'ok') {
        // 最小的 message_start → content_block_delta(text) → message_delta → message_stop
        const ev = (type, payload) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': `req_fake_${n}` });
        res.write(ev('message_start', { message: { id: `msg_fake_${n}`, type: 'message', role: 'assistant', model: model || 'fake', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }));
        res.write(ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }));
        res.write(ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '这是假上游的固定回复。' } }));
        res.write(ev('content_block_stop', { index: 0 }));
        res.write(ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } }));
        res.write(ev('message_stop', {}));
        res.end();
        return;
      }
      const e = ERRORS[mode] || ERRORS['429'];
      res.writeHead(429, {
        'content-type': 'application/json',
        'request-id': `req_fake_${n}`,
        'retry-after': '1',
        'anthropic-ratelimit-requests-remaining': '0',
      });
      res.end(JSON.stringify({ type: 'error', error: e }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `fake: ${req.method} ${req.url}` } }));
  });
}).listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ listening: `http://127.0.0.1:${port}`, mode, pid: process.pid }));
});
