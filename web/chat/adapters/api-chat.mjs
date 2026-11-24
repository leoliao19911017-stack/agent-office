// api-chat.mjs — API 类型 Agent 的聊天适配器（Anthropic / OpenAI 兼容）。
//
// 与 CLI 适配器的差别：API 没有原生 Session 可续。历史由引擎按 thread 回放
// （opts.history），这里只负责把这一段历史发出去、把 SSE 增量转成统一事件。
// 返回形状与 CLI 适配器一致：{ kind, text, usage, model, duration_ms }。
//
// key 只从 api_key_ref 解析（库外），不进日志、不进事件 payload。

import { streamChat } from '../../lib/api-provider.mjs';
import { resolveApiKey } from '../../lib/secrets.mjs';

function normalizeHistory(history, prompt) {
  const out = [];
  for (const m of Array.isArray(history) ? history : []) {
    const role = m && m.role;
    const content = m && m.content;
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string' || content.trim() === '') continue;
    out.push({ role, content });
  }
  if (!out.length) out.push({ role: 'user', content: String(prompt || '') });
  return out.slice(-40);   // 最近的 40 条，防止无限长上下文把请求撑爆
}

export async function runApiTurn(opts = {}) {
  const {
    agent, prompt, history, signal = null, onEvent = () => {},
  } = opts;
  if (!agent) return { kind: 'credentials_missing', message: '找不到这个 API Agent 的配置', text: '' };
  const { key } = resolveApiKey({ apiKeyRef: agent.api_key_ref });
  if (!key) {
    return {
      kind: 'credentials_missing',
      message: `API key 没有解析到（api_key_ref=${agent.api_key_ref || '空'}）；请重新保存一次 key`,
      text: '',
    };
  }
  return streamChat({
    baseUrl: agent.base_url,
    model: agent.model,
    protocol: agent.protocol,
    apiKey: key,
    messages: normalizeHistory(history, prompt),
    signal,
    onEvent,
    maxTokens: 4096,
    timeoutMs: 120000,
  });
}
