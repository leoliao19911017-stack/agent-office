// agents.mjs — Agent 名册（v3 agents 表的唯一读写口）。
//
// 原则：
//   · 现有 4 个 agent_id 是历史数据的外键（attempts / chat_threads 都在用），只读不改名；
//   · 名册只从 DB 读，不在 api / 状态机 / 前端各写一份 ['claude','dsh',...]；
//   · api_key 绝不进这张表、也绝不进任何返回：这里只处理 api_key_ref（引用），
//     真 key 在 web/lib/secrets.mjs（库外）。
//
// 本模块只接收 db 参数，不自己建连接，便于测试用内存库。

export const AGENT_KINDS = Object.freeze(['cli', 'api', 'external']);
export const AGENT_PROTOCOLS = Object.freeze(['anthropic', 'openai']);

/** 已经接好聊天适配器的内置 Agent。新 CLI Agent 没有适配器，不能假装能聊。 */
export const CHAT_READY_CLI = Object.freeze(['claude', 'dsh', 'hermes']);

/** 任务书 G5：禁用后从看板消失，但历史和配置都在。 */
export function parseJson(text, fallback = null) {
  if (text === null || text === undefined || text === '') return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

function mapRow(row) {
  if (!row) return null;
  return {
    ...row,
    enabled: Boolean(row.enabled),
    extra_env: parseJson(row.extra_env, null),
    capabilities: parseJson(row.capabilities, null),
    api_key_ref: row.api_key_ref || null,
  };
}

export function listAgents(db, opts = {}) {
  const enabledOnly = Boolean(opts.enabledOnly);
  const sql = `SELECT * FROM agents ${enabledOnly ? 'WHERE enabled = 1' : ''} ORDER BY sort_index, agent_id`;
  return db.prepare(sql).all().map(mapRow);
}

export function getAgent(db, agentId) {
  if (!agentId) return null;
  return mapRow(db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(String(agentId)));
}

export function listAgentIds(db, opts = {}) {
  return listAgents(db, opts).map((a) => a.agent_id);
}

export function agentExists(db, agentId, opts = {}) {
  const a = getAgent(db, agentId);
  if (!a) return false;
  return opts.enabledOnly ? a.enabled : true;
}

export function agentKind(db, agentId) {
  const a = getAgent(db, agentId);
  return a ? a.kind : null;
}

/** 能不能对话：api 类型已接通用适配器；CLI 只认三个已实测的适配器。 */
export function chatSupport(agent) {
  if (!agent) return { supported: false, reason: 'Agent 不存在' };
  if (!agent.enabled) return { supported: false, reason: 'Agent 已禁用' };
  if (agent.kind === 'api') return { supported: true, reason: null };
  if (CHAT_READY_CLI.includes(agent.agent_id)) return { supported: true, reason: null };
  if (agent.kind === 'cli') {
    return { supported: false, reason: `这个 CLI Agent 还没有聊天适配器（${agent.agent_id}）；先接适配器再开放对话` };
  }
  return { supported: false, reason: '外部 Agent 只信自报，没有对话通道' };
}

export function isExternalKind(db, agentId) {
  const a = getAgent(db, agentId);
  return a ? a.kind === 'external' : false;
}

/**
 * 对外视图：不含任何秘密。
 * extra_env / capabilities 是 JSON 文本，这里还原成对象；万一有人把 KEY 塞进
 * extra_env，也会在 publicAgent 里被抹掉。
 */
export function toPublicAgent(agent) {
  if (!agent) return null;
  return {
    agent_id: agent.agent_id,
    display_name: agent.display_name,
    kind: agent.kind,
    enabled: agent.enabled,
    sort_index: agent.sort_index,
    cli_command: agent.cli_command || null,
    cli_args: agent.cli_args || null,
    resume_flag: agent.resume_flag || null,
    base_url: agent.base_url || null,
    model: agent.model || null,
    protocol: agent.protocol || null,
    api_key_ref: agent.api_key_ref || null,
    api_key_set: Boolean(agent.api_key_ref),
    extra_env: redactSecrets(agent.extra_env),
    capabilities: agent.capabilities,
    created_at: agent.created_at,
    updated_at: agent.updated_at,
  };
}

const SECRET_FIELD = /(^|_)(api[_-]?key|token|secret|password|authorization)($|_)/i;

/** 深拷贝并把秘密字段值换成 [REDACTED]（只用于输出，不用于入库）。 */
export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_FIELD.test(k) ? '[REDACTED]' : redactSecrets(v);
    }
    return out;
  }
  return value;
}

/** 从显示名生成稳定 id；中文名生成不出 ascii 时给时间后缀，不拿空串当 id。 */
export function slugifyAgentId(name) {
  const base = String(name || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || `agent-${Date.now().toString(36)}`;
}

export function isValidAgentId(id) {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(String(id || ''));
}

export function createAgent(db, input = {}) {
  const at = new Date().toISOString();
  const agent = {
    agent_id: String(input.agent_id),
    display_name: String(input.display_name),
    kind: String(input.kind),
    enabled: input.enabled === false || input.enabled === 0 ? 0 : 1,
    sort_index: Number.isFinite(Number(input.sort_index)) ? Number(input.sort_index) : 0,
    cli_command: input.cli_command || null,
    cli_args: input.cli_args || null,
    resume_flag: input.resume_flag || null,
    base_url: input.base_url || null,
    model: input.model || null,
    protocol: input.protocol || null,
    api_key_ref: input.api_key_ref || null,
    extra_env: input.extra_env == null ? null : JSON.stringify(input.extra_env),
    capabilities: input.capabilities == null ? null : JSON.stringify(input.capabilities),
    created_at: at,
    updated_at: at,
  };
  db.prepare(
    'INSERT INTO agents (agent_id, display_name, kind, enabled, sort_index, cli_command, cli_args, ' +
    'resume_flag, base_url, model, protocol, api_key_ref, extra_env, capabilities, created_at, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    agent.agent_id, agent.display_name, agent.kind, agent.enabled, agent.sort_index,
    agent.cli_command, agent.cli_args, agent.resume_flag,
    agent.base_url, agent.model, agent.protocol, agent.api_key_ref,
    agent.extra_env, agent.capabilities, agent.created_at, agent.updated_at,
  );
  return getAgent(db, agent.agent_id);
}

const UPDATABLE = new Set([
  'display_name', 'enabled', 'sort_index', 'cli_command', 'cli_args', 'resume_flag',
  'base_url', 'model', 'protocol', 'api_key_ref', 'extra_env', 'capabilities',
]);

export function updateAgent(db, agentId, patch = {}) {
  const current = getAgent(db, agentId);
  if (!current) return null;
  const sets = [];
  const params = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!UPDATABLE.has(k)) continue;
    sets.push(`${k} = ?`);
    if (k === 'enabled') params.push(v ? 1 : 0);
    else if (k === 'sort_index') params.push(Number.isFinite(Number(v)) ? Number(v) : 0);
    else if (k === 'extra_env' || k === 'capabilities') params.push(v == null ? null : JSON.stringify(v));
    else params.push(v == null || v === '' ? null : String(v));
  }
  if (!sets.length) return current;
  params.push(new Date().toISOString(), agentId);
  db.prepare(`UPDATE agents SET ${sets.join(', ')}, updated_at = ? WHERE agent_id = ?`).run(...params);
  return getAgent(db, agentId);
}

/** 只有测试 / 清理现场用；HTTP 不开放删除（G5 要求保留数据）。 */
export function deleteAgent(db, agentId) {
  return db.prepare('DELETE FROM agents WHERE agent_id = ?').run(String(agentId)).changes > 0;
}
