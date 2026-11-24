// api-provider.mjs — Anthropic / OpenAI 兼容协议的最小客户端。
//
// 只做两件事：
//   1) testApiConnection：测试连接按钮用的「真跑一次最小请求」（max_tokens=1）；
//   2) streamChat：API 类型 Agent 聊天用的一次流式请求（SSE 增量）。
//
// 约束：key 只在请求头里出现，不进 URL、不进错误文案、不打印。所有错误先 redact。

import { redactKey } from './secrets.mjs';

export const API_PROTOCOLS = Object.freeze(['anthropic', 'openai']);

export function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

/** 有人把 /v1 写进 base_url，有人没写；这里统一补，不产生 /v1/v1。 */
export function apiEndpoint(baseUrl, protocol) {
  const base = normalizeBaseUrl(baseUrl);
  if (protocol === 'anthropic') {
    return /\/v1$/i.test(base) ? `${base}/messages` : `${base}/v1/messages`;
  }
  return /\/v1$/i.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

export function apiHeaders(protocol, apiKey) {
  if (protocol === 'anthropic') {
    // Kimi / GLM 这类 Anthropic 兼容网关既认 x-api-key 也认 Bearer；两个都带，少一次兼容性排查。
    return {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      authorization: `Bearer ${apiKey}`,
      'anthropic-version': '2023-06-01',
    };
  }
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
  };
}

function errText(data) {
  if (!data) return '';
  if (typeof data === 'string') return data;
  if (data.error) {
    if (typeof data.error === 'string') return data.error;
    return String(data.error.message || data.error.type || JSON.stringify(data.error));
  }
  return String(data.message || data.detail || '');
}

async function readJsonSafe(res) {
  const text = await res.text().catch(() => '');
  try { return { json: text ? JSON.parse(text) : {}, text }; } catch { return { json: null, text }; }
}

/**
 * 真跑一次最小请求。成功 = HTTP 2xx 且返回体可解析；失败把上游状态/原因带回来，
 * 但不带 key（redactKey 兜底）。
 */
export async function testApiConnection(opts = {}) {
  const {
    baseUrl, model, protocol, apiKey, timeoutMs = 20000,
  } = opts;
  const started = Date.now();
  const base = normalizeBaseUrl(baseUrl);
  const endpoint = apiEndpoint(base, protocol);
  const result = {
    ok: false, protocol, endpoint, model: model || null, http_status: null,
    latency_ms: null, error: null,
  };
  if (!base || !model || !protocol || !apiKey) {
    result.error = 'base_url / model / protocol / api_key 缺一不可';
    result.latency_ms = Date.now() - started;
    return result;
  }
  if (!API_PROTOCOLS.includes(protocol)) {
    result.error = `不支持的协议：${protocol}`;
    result.latency_ms = Date.now() - started;
    return result;
  }

  const body = protocol === 'anthropic'
    ? { model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }
    : { model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] };

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: apiHeaders(protocol, apiKey),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    result.http_status = res.status;
    const { json, text } = await readJsonSafe(res);
    result.latency_ms = Date.now() - started;
    if (!res.ok) {
      const msg = errText(json) || text.slice(0, 300) || `HTTP ${res.status}`;
      result.error = redactKey(msg, apiKey).slice(0, 400);
      return result;
    }
    if (!json || typeof json !== 'object') {
      result.error = '上游返回 2xx，但响应不是 JSON（不是可用的模型接口）';
      return result;
    }
    result.ok = true;
    result.model = (json.model || json.model_name) || model;
    result.response_id = (json && (json.id || json.response_id)) || null;
    result.probe_text = protocol === 'anthropic'
      ? String((json && json.content && json.content[0] && json.content[0].text) || '')
      : String((json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '');
    return result;
  } catch (err) {
    result.latency_ms = Date.now() - started;
    const cause = err && err.cause ? (err.cause.code || err.cause.message) : '';
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      result.error = `请求超时（${Math.round(timeoutMs / 1000)}s）`;
    } else {
      result.error = redactKey(`${err && err.message ? err.message : err}${cause ? `（${cause}）` : ''}`, apiKey).slice(0, 400);
    }
    return result;
  }
}

class ProviderError extends Error {
  constructor(message, { status = null, kind = 'cli_error', retryAfter = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.kind = kind;
    this.retryAfter = retryAfter;
  }
}

function kindForStatus(status) {
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 429) return 'rate_limit';
  if (status === 404) return 'session_not_found';
  return 'cli_error';
}

function parseSseBuffer(buffer, onEvent) {
  let rest = buffer;
  for (;;) {
    const idx = rest.indexOf('\n');
    if (idx < 0) break;
    const line = rest.slice(0, idx).replace(/\r$/, '');
    rest = rest.slice(idx + 1);
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    let obj;
    try { obj = JSON.parse(data); } catch { continue; }
    try { onEvent(obj); } catch (err) {
      // 上游错误要中断本轮；回调自身的小毛病才允许忽略。
      if (err && err.name === 'ProviderError') throw err;
    }
  }
  return rest;
}

/**
 * 一次流式聊天。返回 { kind, text, usage, model }；失败返回 { kind: <ERR>, message, text }。
 * messages 是 [{role:'user'|'assistant', content}]，由引擎按 thread 历史回放。
 */
export async function streamChat(opts = {}) {
  const {
    baseUrl, model, protocol, apiKey, messages = [], signal = null,
    onEvent = () => {}, maxTokens = 4096, timeoutMs = 120000,
  } = opts;
  const started = Date.now();
  const base = normalizeBaseUrl(baseUrl);
  const endpoint = apiEndpoint(base, protocol);
  if (!base || !model || !API_PROTOCOLS.includes(protocol) || !apiKey) {
    return { kind: 'credentials_missing', message: '这个 API Agent 的 base_url / model / 协议 / key 不完整', text: '', endpoint };
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort({ kind: 'timeout_cap' }), timeoutMs);

  const emit = (ev) => { try { onEvent(ev); } catch { /* 监听方出错不中断 */ } };
  try {
    const body = protocol === 'anthropic'
      ? { model, max_tokens: maxTokens, messages, stream: true }
      : { model, max_tokens: maxTokens, messages, stream: true };
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: apiHeaders(protocol, apiKey),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const { json, text } = await readJsonSafe(res);
      const msg = redactKey(errText(json) || text.slice(0, 300) || `HTTP ${res.status}`, apiKey);
      return {
        kind: kindForStatus(res.status), message: msg.slice(0, 500), text: '', http_status: res.status, endpoint,
        retryAfter: res.headers.get('retry-after'),
      };
    }
    emit({ type: 'meta', model, protocol });

    const contentType = String(res.headers.get('content-type') || '');
    let text = '';
    let usage = null;
    const delta = (chunk) => {
      if (typeof chunk !== 'string' || chunk === '') return;
      text += chunk;
      emit({ type: 'delta', text: chunk });
    };

    if (!/text\/event-stream/i.test(contentType) && res.body) {
      // 有些网关忽略 stream=true，直接回整包 JSON：照常取文本，不当作失败。
      const { json } = await readJsonSafe(res);
      const full = protocol === 'anthropic'
        ? String((json && json.content && json.content.map((c) => (c && c.text) || '').join('')) || '')
        : String((json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '');
      if (full) delta(full);
      usage = (json && json.usage) || null;
      if (json && json.model) emit({ type: 'meta', model: json.model, protocol });
    } else if (res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = parseSseBuffer(buffer, (obj) => {
          if (protocol === 'anthropic') {
            if (obj.type === 'message_start' && obj.message) {
              if (obj.message.model) emit({ type: 'meta', model: obj.message.model, protocol });
              if (obj.message.usage) usage = obj.message.usage;
            } else if (obj.type === 'content_block_delta' && obj.delta && obj.delta.type === 'text_delta') {
              delta(obj.delta.text);
            } else if (obj.type === 'message_delta' && obj.usage) {
              usage = { ...(usage || {}), ...obj.usage };
            } else if (obj.type === 'error') {
              const msg = errText(obj);
              if (msg) throw new ProviderError(redactKey(msg, apiKey), { kind: 'cli_error' });
            }
          } else {
            const choice = obj.choices && obj.choices[0];
            if (choice && choice.delta && typeof choice.delta.content === 'string') delta(choice.delta.content);
            if (obj.usage) usage = obj.usage;
          }
        });
      }
      // 收尾：最后一行可能没有换行符
      if (buffer.trim()) {
        parseSseBuffer(`${buffer}\n`, (obj) => {
          if (protocol === 'anthropic' && obj.type === 'content_block_delta' && obj.delta && obj.delta.type === 'text_delta') delta(obj.delta.text);
          if (protocol === 'openai') {
            const choice = obj.choices && obj.choices[0];
            if (choice && choice.delta && typeof choice.delta.content === 'string') delta(choice.delta.content);
          }
        });
      }
    }
    return { kind: 'completed', text, usage, model, duration_ms: Date.now() - started, endpoint };
  } catch (err) {
    if (err && err.name === 'ProviderError') {
      return { kind: err.kind, message: err.message, text: '', endpoint };
    }
    const aborted = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
    if (aborted) {
      const reason = signal && signal.reason && signal.reason.kind ? signal.reason.kind : 'timeout_cap';
      return {
        kind: reason === 'cancelled' ? 'cancelled' : 'timeout_cap',
        message: reason === 'cancelled' ? '已按你的要求停止本轮' : `请求超时（${Math.round(timeoutMs / 1000)}s）`,
        text: '',
        endpoint,
      };
    }
    const cause = err && err.cause ? (err.cause.code || err.cause.message) : '';
    return {
      kind: 'cli_error',
      message: redactKey(`${err && err.message ? err.message : err}${cause ? `（${cause}）` : ''}`, apiKey).slice(0, 500),
      text: '',
      endpoint,
    };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}
