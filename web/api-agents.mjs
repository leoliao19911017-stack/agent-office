// api-agents.mjs — Agent 名册 CRUD + API 类型「测试连接」。
//
// 挂载点：
//   GET   /api/agents                    名册（默认只返回 enabled；?all=1 含禁用）
//   POST  /api/agents                    新增（API 类型必须先拿到 test_token）
//   GET   /api/agents/:id                单个配置
//   PATCH /api/agents/:id                改名 / 禁用 / 排序 / 配置；不支持改 kind
//   POST  /api/agents/test-connection    真跑一次最小请求（不落库、不返回 key）
//   POST  /api/agents/:id/test           用已保存配置再测一次
//
// 铁律：api_key 只在这一层被「用」，不被存、不被回显、不进日志。agents 表只存
// api_key_ref；真 key 在 lib/secrets.mjs 的库外保管。

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getDb } from './lib/db.mjs';
import {
  AGENT_KINDS, AGENT_PROTOCOLS, createAgent, deleteAgent, getAgent, listAgents,
  toPublicAgent, updateAgent, slugifyAgentId, isValidAgentId, chatSupport,
} from './lib/agents.mjs';
import {
  saveAgentSecret, resolveApiKey, keyFingerprint, redactKey,
} from './lib/secrets.mjs';
import { testApiConnection, normalizeBaseUrl } from './lib/api-provider.mjs';

const AGENT_PATH = /^\/api\/agents\/([A-Za-z0-9][A-Za-z0-9_.-]{0,63})$/;
const AGENT_TEST_PATH = /^\/api\/agents\/([A-Za-z0-9][A-Za-z0-9_.-]{0,63})\/test$/;
const RESERVED = new Set(['status-v2', 'real', 'test-connection']);
const TEST_CONNECTION = '/api/agents/test-connection';
const TEST_TOKEN_TTL_MS = 10 * 60 * 1000;

/** 进程级随机密钥：测试令牌只在本进程有效，重启后必须重测——不留可重放的长期凭据。 */
const TEST_SECRET = randomBytes(32);

function bodyOf(req, deps) {
  if (typeof deps.readJsonBody === 'function') return deps.readJsonBody(req);
  return Promise.resolve({});
}

function send(deps, res, statusCode, payload) {
  deps.sendJson(res, statusCode, payload);
}

function pickString(obj, ...keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== '') return String(obj[k]).trim();
  }
  return null;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sign(payloadB64) {
  return b64url(createHmac('sha256', TEST_SECRET).update(payloadB64).digest());
}

function issueTestToken({ baseUrl, model, protocol, fingerprint }) {
  const payload = {
    b: normalizeBaseUrl(baseUrl),
    m: String(model),
    p: String(protocol),
    f: fingerprint,
    e: Date.now() + TEST_TOKEN_TTL_MS,
  };
  const payloadB64 = b64url(JSON.stringify(payload));
  return `${payloadB64}.${sign(payloadB64)}`;
}

function verifyTestToken(token, expected) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return false;
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) return false;
  const want = sign(payloadB64);
  const a = Buffer.from(sig);
  const b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch { return false; }
  return payload
    && payload.e > Date.now()
    && payload.b === normalizeBaseUrl(expected.baseUrl)
    && payload.m === String(expected.model)
    && payload.p === String(expected.protocol)
    && payload.f === expected.fingerprint;
}

/** api_key_ref 只接受三种引用；把明文 key 塞进 ref 的请求直接拒绝，避免绕过库外保管。 */
function validateKeyRef(ref) {
  if (!ref) return null;
  return /^(local|ccswitch|env):.+$/.test(ref) ? null : 'api_key_ref 必须是 local:<agent_id> / ccswitch:<名称> / env:<变量名>';
}

function validateBaseUrl(value) {
  let u;
  try { u = new URL(value); } catch { return 'base_url 不是合法 URL'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'base_url 只支持 http / https';
  return null;
}

function badRequest(deps, code, message) {
  const err = new Error(message);
  err.statusCode = 400;
  err.code = code;
  return err;
}

function conflict(deps, code, message) {
  const err = new Error(message);
  err.statusCode = 409;
  err.code = code;
  return err;
}

function agentView(agent) {
  if (!agent) return null;
  const support = chatSupport(agent);
  return { ...toPublicAgent(agent), chat_supported: support.supported, chat_reason: support.reason };
}

function uniqueAgentId(db, requested, displayName) {
  const base = requested ? String(requested) : slugifyAgentId(displayName);
  if (!isValidAgentId(base)) throw badRequest(null, 'BAD_AGENT_ID', 'agent_id 只能包含字母数字、_ . -，且以字母数字开头，最长 64');
  if (!getAgent(db, base)) return base;
  for (let i = 2; i <= 50; i += 1) {
    const candidate = `${base}-${i}`.slice(0, 64);
    if (!getAgent(db, candidate)) return candidate;
  }
  throw conflict(null, 'AGENT_ID_TAKEN', `agent_id 已被占用：${base}`);
}

/** 表单字段校验：只收该类型需要的字段，不把无意义的字段写进库。 */
function normalizeCreateBody(db, body) {
  const displayName = pickString(body, 'display_name', 'displayName', 'name');
  if (!displayName) throw badRequest(null, 'BAD_NAME', 'display_name 必填');
  const kind = pickString(body, 'kind');
  if (!AGENT_KINDS.includes(kind)) throw badRequest(null, 'BAD_KIND', `kind 必须是 ${AGENT_KINDS.join(' / ')}`);

  const out = {
    agent_id: uniqueAgentId(db, pickString(body, 'agent_id', 'agentId'), displayName),
    display_name: displayName,
    kind,
    enabled: body.enabled === undefined ? true : Boolean(body.enabled),
    sort_index: body.sort_index === undefined
      ? (listAgents(db).reduce((n, a) => Math.max(n, Number(a.sort_index) || 0), 0) + 10)
      : Number(body.sort_index),
    capabilities: body.capabilities && typeof body.capabilities === 'object' ? body.capabilities : undefined,
    extra_env: body.extra_env && typeof body.extra_env === 'object' ? body.extra_env : undefined,
  };

  if (kind === 'cli') {
    out.cli_command = pickString(body, 'cli_command', 'cliCommand', 'command');
    if (!out.cli_command) throw badRequest(null, 'BAD_CLI_COMMAND', 'CLI 类型必须填命令（claude / codex / 完整路径）');
    out.resume_flag = pickString(body, 'resume_flag', 'resumeFlag');
    out.cli_args = pickString(body, 'cli_args', 'cliArgs');
    out.model = pickString(body, 'model');
  } else if (kind === 'api') {
    out.base_url = normalizeBaseUrl(pickString(body, 'base_url', 'baseUrl'));
    out.model = pickString(body, 'model');
    out.protocol = pickString(body, 'protocol');
    if (!out.base_url) throw badRequest(null, 'BAD_BASE_URL', 'API 类型必须填 base_url');
    const urlError = validateBaseUrl(out.base_url);
    if (urlError) throw badRequest(null, 'BAD_BASE_URL', urlError);
    if (!out.model) throw badRequest(null, 'BAD_MODEL', 'API 类型必须填模型名');
    if (!AGENT_PROTOCOLS.includes(out.protocol)) {
      throw badRequest(null, 'BAD_PROTOCOL', '协议必须是 anthropic 或 openai');
    }
  }
  return out;
}

async function testConnectionFor(deps, body) {
  const baseUrl = normalizeBaseUrl(pickString(body, 'base_url', 'baseUrl'));
  const model = pickString(body, 'model');
  const protocol = pickString(body, 'protocol');
  const apiKeyInput = pickString(body, 'api_key', 'apiKey');
  const apiKeyRef = pickString(body, 'api_key_ref', 'apiKeyRef');
  const refError = validateKeyRef(apiKeyRef);
  if (refError) throw badRequest(deps, 'BAD_KEY_REF', refError);

  if (!baseUrl) throw badRequest(deps, 'BAD_BASE_URL', 'base_url 必填');
  const urlError = validateBaseUrl(baseUrl);
  if (urlError) throw badRequest(deps, 'BAD_BASE_URL', urlError);
  if (!model) throw badRequest(deps, 'BAD_MODEL', '模型名必填');
  if (!AGENT_PROTOCOLS.includes(protocol)) throw badRequest(deps, 'BAD_PROTOCOL', '协议必须是 anthropic 或 openai');

  const { key, source } = resolveApiKey({ apiKey: apiKeyInput, apiKeyRef });
  if (!key) {
    return {
      ok: false, error: apiKeyInput ? 'key 为空' : `没有解析到 API key（引用：${apiKeyRef || '未填'}）`,
      protocol, endpoint: null, model, http_status: null, latency_ms: 0,
    };
  }
  const result = await testApiConnection({ baseUrl, model, protocol, apiKey: key });
  if (!result.ok) return { ...result, key_source: source, test_token: null };
  return {
    ...result,
    key_source: source,
    test_token: issueTestToken({
      baseUrl, model, protocol, fingerprint: keyFingerprint(key),
    }),
  };
}

export async function handleAgentsApi(req, res, path, method, deps = {}) {
  const m = String(method || 'GET').toUpperCase();
  const isList = path === '/api/agents';
  const isTestConnection = path === TEST_CONNECTION;
  const mTest = path.match(AGENT_TEST_PATH);
  const mAgent = path.match(AGENT_PATH);
  const reserved = mAgent && RESERVED.has(mAgent[1]);

  if (!isList && !isTestConnection && !mTest && !(mAgent && !reserved)) return false;

  const db = getDb();

  /* ---- POST /api/agents/test-connection -------------------------------- */
  if (isTestConnection) {
    if (m !== 'POST') throw deps.httpError(405, 'METHOD_NOT_ALLOWED', `${m} ${path} 不支持`);
    const body = (await bodyOf(req, deps)) || {};
    const result = await testConnectionFor(deps, body);
    send(deps, res, 200, { ...result, tested_at: new Date().toISOString() });
    return true;
  }

  /* ---- POST /api/agents/:id/test --------------------------------------- */
  if (mTest && !RESERVED.has(mTest[1])) {
    if (m !== 'POST') throw deps.httpError(405, 'METHOD_NOT_ALLOWED', `${m} ${path} 不支持`);
    const agent = getAgent(db, mTest[1]);
    if (!agent) throw deps.httpError(404, 'AGENT_NOT_FOUND', `Agent 不存在：${mTest[1]}`);
    if (agent.kind !== 'api') throw badRequest(deps, 'NOT_API_AGENT', '只有 API 类型 Agent 能做连接测试');
    const { key, source } = resolveApiKey({ apiKeyRef: agent.api_key_ref });
    if (!key) throw badRequest(deps, 'KEY_UNRESOLVED', `没有解析到 API key（引用：${agent.api_key_ref || '空'}）`);
    const result = await testApiConnection({
      baseUrl: agent.base_url, model: agent.model, protocol: agent.protocol, apiKey: key,
    });
    send(deps, res, 200, { ...result, key_source: source, tested_at: new Date().toISOString() });
    return true;
  }

  /* ---- GET /api/agents -------------------------------------------------- */
  if (isList && m === 'GET') {
    const all = new URL(req.url, 'http://127.0.0.1').searchParams.get('all') === '1';
    const agents = listAgents(db, { enabledOnly: !all }).map(agentView);
    send(deps, res, 200, {
      ok: true, generated_at: new Date().toISOString(), count: agents.length, agents,
    });
    return true;
  }

  /* ---- POST /api/agents ------------------------------------------------- */
  if (isList && m === 'POST') {
    const body = (await bodyOf(req, deps)) || {};
    const input = normalizeCreateBody(db, body);
    let apiKey = null;

    if (input.kind === 'api') {
      const apiKeyInput = pickString(body, 'api_key', 'apiKey');
      const apiKeyRef = pickString(body, 'api_key_ref', 'apiKeyRef');
      const refError = validateKeyRef(apiKeyRef);
      if (refError) throw badRequest(deps, 'BAD_KEY_REF', refError);
      const resolved = resolveApiKey({ apiKey: apiKeyInput, apiKeyRef });
      if (!resolved.key) {
        throw badRequest(deps, 'KEY_REQUIRED', `API 类型必须提供可解析的 api_key（引用：${apiKeyRef || '未填'}）`);
      }
      const ok = verifyTestToken(body.test_token || body.testToken, {
        baseUrl: input.base_url,
        model: input.model,
        protocol: input.protocol,
        fingerprint: keyFingerprint(resolved.key),
      });
      if (!ok) {
        throw badRequest(deps, 'TEST_REQUIRED', '保存前必须先测试连接；测试通过后配置不能被改动（或已超过 10 分钟）');
      }
      apiKey = apiKeyInput || null;
      input.api_key_ref = apiKeyRef && !apiKeyInput ? apiKeyRef : `local:${input.agent_id}`;
    } else if (body.api_key || body.apiKey) {
      throw badRequest(deps, 'KEY_NOT_ALLOWED', '只有 API 类型 Agent 可以保存 api_key');
    }

    let agent;
    try {
      agent = createAgent(db, input);
      if (apiKey) saveAgentSecret(agent.agent_id, apiKey);
    } catch (err) {
      if (agent) deleteAgent(db, agent.agent_id);
      throw err;
    }
    send(deps, res, 201, { ok: true, agent: agentView(agent) });
    return true;
  }

  /* ---- GET /api/agents/:id --------------------------------------------- */
  if (mAgent && m === 'GET') {
    const agent = getAgent(db, mAgent[1]);
    if (!agent) throw deps.httpError(404, 'AGENT_NOT_FOUND', `Agent 不存在：${mAgent[1]}`);
    send(deps, res, 200, { ok: true, agent: agentView(agent) });
    return true;
  }

  /* ---- PATCH /api/agents/:id ------------------------------------------- */
  if (mAgent && (m === 'PATCH' || m === 'PUT')) {
    const agent = getAgent(db, mAgent[1]);
    if (!agent) throw deps.httpError(404, 'AGENT_NOT_FOUND', `Agent 不存在：${mAgent[1]}`);
    const body = (await bodyOf(req, deps)) || {};
    const patch = {};

    if (body.display_name !== undefined || body.displayName !== undefined || body.name !== undefined) {
      const name = pickString(body, 'display_name', 'displayName', 'name');
      if (!name) throw badRequest(deps, 'BAD_NAME', 'display_name 不能为空');
      patch.display_name = name;
    }
    if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
    if (body.sort_index !== undefined) patch.sort_index = Number(body.sort_index);
    if (body.cli_command !== undefined) {
      if (agent.kind !== 'cli') throw badRequest(deps, 'FIELD_NOT_ALLOWED', '只有 CLI 类型能改 cli_command');
      patch.cli_command = pickString(body, 'cli_command', 'cliCommand');
    }
    if (body.resume_flag !== undefined) patch.resume_flag = pickString(body, 'resume_flag', 'resumeFlag');
    if (body.cli_args !== undefined) patch.cli_args = pickString(body, 'cli_args', 'cliArgs');
    if (body.base_url !== undefined) {
      if (agent.kind !== 'api') throw badRequest(deps, 'FIELD_NOT_ALLOWED', '只有 API 类型能改 base_url');
      const value = normalizeBaseUrl(pickString(body, 'base_url', 'baseUrl'));
      const urlError = validateBaseUrl(value);
      if (urlError) throw badRequest(deps, 'BAD_BASE_URL', urlError);
      patch.base_url = value;
    }
    if (body.model !== undefined) patch.model = pickString(body, 'model');
    if (body.protocol !== undefined) {
      if (!AGENT_PROTOCOLS.includes(pickString(body, 'protocol'))) throw badRequest(deps, 'BAD_PROTOCOL', '协议必须是 anthropic 或 openai');
      patch.protocol = pickString(body, 'protocol');
    }
    if (body.api_key !== undefined || body.apiKey !== undefined) {
      if (agent.kind !== 'api') throw badRequest(deps, 'KEY_NOT_ALLOWED', '只有 API 类型 Agent 可以保存 api_key');
      const key = pickString(body, 'api_key', 'apiKey');
      if (!key) throw badRequest(deps, 'KEY_REQUIRED', 'api_key 不能为空');
      const next = { base_url: patch.base_url || agent.base_url, model: patch.model || agent.model, protocol: patch.protocol || agent.protocol };
      const ok = verifyTestToken(body.test_token || body.testToken, {
        ...next, fingerprint: keyFingerprint(key),
      });
      if (!ok) throw badRequest(deps, 'TEST_REQUIRED', '改 key 前必须先测试连接');
      saveAgentSecret(agent.agent_id, key);
      patch.api_key_ref = `local:${agent.agent_id}`;
    }
    const updated = updateAgent(db, agent.agent_id, patch);
    send(deps, res, 200, { ok: true, agent: agentView(updated) });
    return true;
  }

  throw deps.httpError(405, 'METHOD_NOT_ALLOWED', `${m} ${path} 不支持`);
}
