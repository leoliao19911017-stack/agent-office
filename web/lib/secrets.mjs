// secrets.mjs — API key 的库外保管与引用解析。
//
// 硬约束（TASK §G6 / 铁律）：api_key 不写进 agent-office.db、不进任何 HTTP 响应、
// 不进日志。agents 表只存 api_key_ref（引用），真 key 在这里：
//   local:<agent_id>   → data/secrets/agents.json（0600，gitignore）
//   ccswitch:<名称/id> → 读本机 CC Switch 的 provider 配置（只读，不回显）
//   env:<变量名>       → 从进程环境变量取
//
// 本模块不打印任何 key；出错信息也先过 redactKey 再返回。

import {
  chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)); // web/lib
const REPO_ROOT = resolve(HERE, '..', '..');
const SECRETS_DIR = process.env.AGENT_OFFICE_SECRETS_DIR || join(REPO_ROOT, 'data', 'secrets');
const SECRETS_FILE = join(SECRETS_DIR, 'agents.json');

function readVault() {
  try {
    const parsed = JSON.parse(readFileSync(SECRETS_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.agents && typeof parsed.agents === 'object') return parsed;
  } catch { /* 不存在 / 损坏：当成空库，不覆盖别人的东西 */ }
  return { version: 1, agents: {} };
}

function writeVault(vault) {
  mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
  const tmp = join(SECRETS_DIR, `.agents.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(vault, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, SECRETS_FILE);
  try { chmodSync(SECRETS_FILE, 0o600); } catch { /* Windows ACL 不认 mode，不影响内容 */ }
}

export function saveAgentSecret(agentId, apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) return false;
  const vault = readVault();
  vault.agents[String(agentId)] = { api_key: key, updated_at: new Date().toISOString() };
  writeVault(vault);
  return true;
}

export function getAgentSecret(agentId) {
  const hit = readVault().agents[String(agentId)];
  return hit && hit.api_key ? String(hit.api_key) : null;
}

export function deleteAgentSecret(agentId) {
  const vault = readVault();
  if (!vault.agents[String(agentId)]) return false;
  delete vault.agents[String(agentId)];
  writeVault(vault);
  return true;
}

/** key 指纹：用于测试令牌绑定，不可逆；空 key 返回 null。 */
export function keyFingerprint(apiKey) {
  const key = String(apiKey || '');
  if (!key) return null;
  return createHash('sha256').update(key).digest('hex').slice(0, 32);
}

/** 输出前抹掉已知 key（错误信息 / 上游回显可能带）。 */
export function redactKey(text, apiKey) {
  const s = String(text ?? '');
  const key = String(apiKey || '');
  if (key.length < 8) return s;
  return s.split(key).join('[REDACTED]');
}

/** 从 CC Switch 的 provider 读 key（只读；找不到返回 null，不猜）。 */
function resolveCcSwitch(nameOrId) {
  const dbPath = join(homedir(), '.cc-switch', 'cc-switch.db');
  if (!existsSync(dbPath)) return null;
  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare(
      'SELECT settings_config FROM providers WHERE name = ? OR id = ? ORDER BY sort_index LIMIT 1',
    ).get(String(nameOrId), String(nameOrId));
    if (!row) return null;
    const cfg = JSON.parse(row.settings_config || '{}');
    const env = cfg.env && typeof cfg.env === 'object' ? cfg.env : {};
    const candidates = [
      env.ANTHROPIC_AUTH_TOKEN, env.ANTHROPIC_API_KEY, env.OPENAI_API_KEY,
      env.OPENAI_AUTH_TOKEN, env.GEMINI_API_KEY, cfg.apiKey, cfg.api_key,
    ];
    return candidates.find((v) => typeof v === 'string' && v.trim() !== '') || null;
  } catch {
    return null;
  } finally {
    try { if (db) db.close(); } catch { /* 已关闭 */ }
  }
}

/**
 * 解析引用，返回 { key, source }；解析不到返回 { key:null, source }。
 * 传入显式 key 时永远优先（测试连接表单）。
 */
export function resolveApiKey({ apiKey = null, apiKeyRef = null } = {}) {
  if (apiKey && String(apiKey).trim()) return { key: String(apiKey).trim(), source: 'input' };
  const ref = apiKeyRef == null ? '' : String(apiKeyRef).trim();
  if (!ref) return { key: null, source: null };
  if (ref.startsWith('local:')) return { key: getAgentSecret(ref.slice('local:'.length)), source: ref };
  if (ref.startsWith('env:')) {
    const v = process.env[ref.slice('env:'.length)] || null;
    return { key: v, source: ref };
  }
  if (ref.startsWith('ccswitch:')) {
    return { key: resolveCcSwitch(ref.slice('ccswitch:'.length).trim()), source: ref };
  }
  return { key: null, source: ref };
}

export const SECRETS_PATH = SECRETS_FILE;
