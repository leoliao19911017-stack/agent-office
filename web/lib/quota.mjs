// quota.mjs — 额度面板的数据层（GLM 3 个 key + Codex 已用量）
//
// 数据源（实测，2026-11-24）：
//   GLM   GET https://open.bigmodel.cn/api/monitor/usage/quota/limit
//         Header Authorization: <裸 key，不带 Bearer>
//         返回 data.limits[]；unit=3 是 5 小时窗，unit=6 是周窗；
//         percentage 是「已用」百分比；TOKENS_LIMIT / CREDIT_LIMIT 两种 type 都认，
//         只按 unit 分类（CC Switch 硬编码 TOKENS_LIMIT 踩过坑）。
//   key   只从 ~/.cc-switch/cc-switch.db 的 providers 表读：
//         app_type='claude' AND name LIKE '%Zhipu%'，
//         settings_config 是 JSON 字符串，取 .env.ANTHROPIC_AUTH_TOKEN。
//   Codex OpenAI 官方没有剩余额度查询接口。只能从同一个库里
//         usage_daily_rollups（app_type='codex'）按 date 聚合「已用」。
//
// 安全边界：
//   - 本模块不导出 key，也不把 key / settings_config 放进任何返回值。
//   - key 只在「一次刷新」的局部变量里活；缓存只缓存脱敏后的额度快照。
//   - 厂商错误信息在返回前再过一遍脱敏，防止意外把凭据带出去。
//
// 缓存：
//   默认 5 分钟一轮，10 次请求只打一轮厂商接口（3 个 key 各 1 次，共 3 个 HTTP 请求）。
//   缓存只在内存，不落库（quota_snapshots 表按任务书是可选项，这里不做，避免多一处
//   需要证明「没有写进 key」的地方）。

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const GLM_QUOTA_URL = 'https://open.bigmodel.cn/api/monitor/usage/quota/limit';
export const DEFAULT_TTL_MS = 5 * 60 * 1000;
export const WINDOW_LABELS = Object.freeze({ 3: '5 小时', 6: '1 周' });

/** 默认的 cc-switch 库位置（Windows / macOS / Linux 都用 ~/.cc-switch）。 */
export function defaultCcSwitchDb() {
  return join(homedir(), '.cc-switch', 'cc-switch.db');
}

/** 进程本机时区下的 YYYY-MM-DD（rollups 的 date 就是本地日期）。 */
export function localDate(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** provider 名称 → 看板上的短名。任务书里的三个 key：涛哥 / 磊哥 / 空的那个（闲置）。 */
export function providerShortName(name) {
  const s = String(name || '');
  if (s.includes('涛哥')) return '涛哥';
  if (s.includes('磊哥')) return '磊哥';
  return '闲置';
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clampPct(n) {
  if (n === null) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function isoFromMs(ms) {
  const n = numOrNull(ms);
  if (n === null || n <= 0) return null;
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * 厂商 limits[] → 看板窗口。
 * 只认 unit=3 / unit=6；不按 type 过滤。兼容只有 percentage 的新版返回：
 * 没有 usage/remaining 时保留 null，不拿 0 冒充。
 */
export function parseLimitWindows(limits) {
  const out = [];
  const seen = new Set();
  for (const lim of Array.isArray(limits) ? limits : []) {
    if (!lim || typeof lim !== 'object') continue;
    const unit = numOrNull(lim.unit);
    const label = WINDOW_LABELS[unit];
    if (!label || seen.has(unit)) continue;
    seen.add(unit);

    const usage = numOrNull(lim.usage);
    const used = numOrNull(lim.currentValue);
    const remaining = numOrNull(lim.remaining);
    let percentage = clampPct(numOrNull(lim.percentage));
    if (percentage === null && usage !== null && usage > 0 && used !== null) {
      percentage = clampPct((used / usage) * 100);
    }
    out.push({
      unit,
      label,
      // percentage 是「已用」百分比——字段名保持 percentage 与厂商一致，语义在 used_percent 里再点明一次。
      percentage,
      used_percent: percentage,
      remaining,
      usage,
      used,
      resetAt: isoFromMs(lim.nextResetTime),
      basis: remaining !== null && usage !== null ? 'usage' : 'percentage',
    });
  }
  out.sort((a, b) => a.unit - b.unit);
  return out;
}

/** 从 cc-switch 读 Zhipu providers（返回值含 token，只在刷新流程内部使用）。 */
export function readZhipuProviders(dbPath = defaultCcSwitchDb()) {
  if (!existsSync(dbPath)) {
    return { providers: [], error: `cc-switch 数据库不存在：${dbPath}` };
  }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare(
      "SELECT id, name, settings_config FROM providers WHERE app_type='claude' AND name LIKE '%Zhipu%' ORDER BY sort_index, name",
    ).all();
    const providers = rows.map((row) => {
      let env = null;
      try { env = JSON.parse(row.settings_config)?.env || null; } catch { env = null; }
      const token = env && typeof env.ANTHROPIC_AUTH_TOKEN === 'string' ? env.ANTHROPIC_AUTH_TOKEN.trim() : '';
      return {
        id: String(row.id),
        provider_name: String(row.name || ''),
        name: providerShortName(row.name),
        model: env && typeof env.ANTHROPIC_MODEL === 'string' ? env.ANTHROPIC_MODEL : null,
        token,
      };
    });
    return { providers, error: null };
  } catch (err) {
    return { providers: [], error: `读取 cc-switch 失败：${String(err.message || err)}` };
  } finally {
    try { db?.close(); } catch { /* 关不掉也不影响这次结果 */ }
  }
}

/** 从 usage_daily_rollups 读 Codex 已用量（没有剩余额度接口，只能显示已用）。 */
export function readCodexUsage(dbPath = defaultCcSwitchDb(), now = new Date()) {
  const base = {
    agent_id: 'codex',
    display_name: 'Codex',
    date: localDate(now),
    has_today: false,
    used_usd: 0,
    requests: 0,
    latest_date: null,
    latest_used_usd: null,
    latest_requests: null,
    remaining: null,
    remaining_supported: false,
    source: '~/.cc-switch/cc-switch.db · usage_daily_rollups (app_type=codex)',
    note: 'OpenAI 官方没有剩余额度查询接口；这里只显示已用量（总花费 / 请求次数），不显示剩余额度。',
    error: null,
  };
  if (!existsSync(dbPath)) return { ...base, error: `cc-switch 数据库不存在：${dbPath}` };
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const today = db.prepare(
      `SELECT date, SUM(request_count) AS requests, SUM(total_cost_usd) AS cost
         FROM usage_daily_rollups WHERE app_type='codex' AND date=? GROUP BY date`,
    ).get(base.date);
    const latest = db.prepare(
      `SELECT date, SUM(request_count) AS requests, SUM(total_cost_usd) AS cost
         FROM usage_daily_rollups WHERE app_type='codex' GROUP BY date ORDER BY date DESC LIMIT 1`,
    ).get();
    return {
      ...base,
      has_today: Boolean(today),
      used_usd: today ? Number(today.cost || 0) : 0,
      requests: today ? Number(today.requests || 0) : 0,
      latest_date: latest ? String(latest.date) : null,
      latest_used_usd: latest ? Number(latest.cost || 0) : null,
      latest_requests: latest ? Number(latest.requests || 0) : null,
    };
  } catch (err) {
    return { ...base, error: `读取 Codex 用量失败：${String(err.message || err)}` };
  } finally {
    try { db?.close(); } catch { /* 同上 */ }
  }
}

async function fetchGlm(token, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(GLM_QUOTA_URL, {
      method: 'GET',
      headers: {
        // 裸 key，不带 Bearer——这是厂商接口的要求。
        Authorization: token,
        'Accept-Language': 'en-US,en',
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(12000),
    });
  } catch (err) {
    throw new Error(`厂商接口不可达：${String(err.message || err)}`);
  }
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch {
    throw new Error(`厂商返回非 JSON（HTTP ${res.status}）`);
  }
  if (!res.ok) throw new Error(`厂商返回 HTTP ${res.status}`);
  if (body && body.success === false) throw new Error(`厂商业务失败：${body.msg || body.message || 'unknown'}`);
  if (!body || !body.data || !Array.isArray(body.data.limits)) {
    throw new Error('厂商返回里没有 data.limits');
  }
  return body.data;
}

/** 返回给前端前统一脱敏：任何字符串里出现 key 都替换掉。 */
function redactText(value, token) {
  if (typeof value !== 'string') return value;
  return token ? value.split(token).join('[REDACTED]') : value;
}

/**
 * 额度服务。依赖可注入，便于测试缓存 / 兼容分支，不碰真厂商接口。
 *
 * @param {object} opts
 * @param {Function} [opts.fetchImpl]
 * @param {Function} [opts.readProviders] () => { providers, error }
 * @param {Function} [opts.readCodex]    () => codex usage
 * @param {Function} [opts.now]          () => ms
 * @param {number}   [opts.ttlMs]
 */
export function createQuotaService(opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const readProviders = opts.readProviders || (() => readZhipuProviders());
  const readCodex = opts.readCodex || (() => readCodexUsage());
  const now = opts.now || (() => Date.now());
  const ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : Number(process.env.QUOTA_TTL_MS || DEFAULT_TTL_MS);

  const cache = {
    at: 0,
    snapshot: null,
    inflight: null,
    hits: 0,
    misses: 0,
    vendorRounds: 0,
    vendorRequests: 0,
  };

  function cacheMeta(t, servedFromCache) {
    return {
      ttl_ms: ttlMs,
      age_ms: cache.snapshot ? Math.max(0, t - cache.at) : null,
      hit: Boolean(servedFromCache),          // 这次响应是否直接吃了缓存（没有打厂商）
      fresh: Boolean(cache.snapshot && t - cache.at < ttlMs),
      hits: cache.hits,
      misses: cache.misses,
      vendor_rounds: cache.vendorRounds,
      vendor_requests: cache.vendorRequests,
      next_fetch_at: cache.snapshot ? new Date(cache.at + ttlMs).toISOString() : null,
    };
  }

  async function refresh() {
    const startedAt = now();
    cache.vendorRounds += 1;
    const loaded = readProviders();
    const providers = Array.isArray(loaded?.providers) ? loaded.providers : [];
    const results = await Promise.all(providers.map(async (p) => {
      const base = {
        id: p.id,
        agent_id: 'claude',
        name: p.name,
        provider_name: p.provider_name,
        model: p.model || null,
        level: null,
        windows: [],
      };
      if (!p.token) {
        return { ...base, ok: false, error: 'cc-switch 里这个 provider 没有凭据' };
      }
      cache.vendorRequests += 1;
      try {
        const data = await fetchGlm(p.token, fetchImpl);
        return {
          ...base,
          ok: true,
          error: null,
          level: typeof data.level === 'string' ? data.level : null,
          windows: parseLimitWindows(data.limits),
        };
      } catch (err) {
        return { ...base, ok: false, error: redactText(String(err.message || err), p.token) };
      }
    }));

    const codex = readCodex();
    const notes = [];
    if (loaded?.error) notes.push(loaded.error);
    const missing = providers.filter((p) => !p.token).length;
    if (missing) notes.push(`${missing} 个 Zhipu provider 没有凭据，已跳过（不编造额度）`);
    if (codex?.error) notes.push(codex.error);

    const snapshot = {
      generated_at: new Date(startedAt).toISOString(),
      source: {
        glm: GLM_QUOTA_URL,
        glm_units: 'unit=3 → 5 小时；unit=6 → 1 周（不按 type 过滤）',
        credentials: "~/.cc-switch/cc-switch.db · providers(app_type=claude, name LIKE '%Zhipu%') · env 凭据（只在后端内存）",
        codex: '~/.cc-switch/cc-switch.db · usage_daily_rollups(app_type=codex)',
      },
      providers: results,
      codex,
      notes,
    };
    cache.at = startedAt;
    cache.snapshot = snapshot;
    return snapshot;
  }

  async function getQuotas() {
    const t = now();
    if (cache.snapshot && t - cache.at < ttlMs) {
      cache.hits += 1;
      return { ...cache.snapshot, cache: cacheMeta(t, true) };
    }
    if (cache.inflight) {
      cache.hits += 1;
      const snap = await cache.inflight;
      return { ...snap, cache: cacheMeta(now(), true) };
    }
    cache.misses += 1;
    cache.inflight = refresh();
    try {
      const snap = await cache.inflight;
      return { ...snap, cache: cacheMeta(now(), false) };
    } finally {
      cache.inflight = null;
    }
  }

  /** 测试 / 排查用：只清内存，不碰任何外部状态。 */
  function clearCache() {
    cache.at = 0;
    cache.snapshot = null;
    cache.inflight = null;
    cache.hits = 0;
    cache.misses = 0;
    cache.vendorRounds = 0;
    cache.vendorRequests = 0;
  }

  return { getQuotas, clearCache, cache };
}

/** 生产单例：整个 server 进程共用一份 5 分钟缓存。 */
export const quotaService = createQuotaService();
export const getQuotas = () => quotaService.getQuotas();
