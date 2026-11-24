// api-quotas.mjs — GET /api/quotas
//
// 只返回脱敏后的额度快照：provider id/name/model/level/windows + Codex 已用量。
// key、settings_config、任何 Authorization 值都不进响应；数据层已经保证，
// 这里再做一次白名单式输出，避免将来给 provider 对象加字段时意外带出敏感信息。
import { getQuotas } from './lib/quota.mjs';

const providerView = (p) => ({
  id: p.id,
  agent_id: p.agent_id,
  name: p.name,
  provider_name: p.provider_name,
  model: p.model,
  level: p.level,
  ok: p.ok,
  error: p.error,
  windows: (p.windows || []).map((w) => ({
    unit: w.unit,
    label: w.label,
    percentage: w.percentage,
    used_percent: w.used_percent,
    remaining: w.remaining,
    usage: w.usage,
    used: w.used,
    resetAt: w.resetAt,
    basis: w.basis,
  })),
});

const codexView = (c) => (c ? {
  agent_id: c.agent_id,
  display_name: c.display_name,
  date: c.date,
  has_today: c.has_today,
  used_usd: c.used_usd,
  requests: c.requests,
  latest_date: c.latest_date,
  latest_used_usd: c.latest_used_usd,
  latest_requests: c.latest_requests,
  remaining: null,                 // OpenAI 没有剩余额度查询接口，永远不编造
  remaining_supported: false,
  source: c.source,
  note: c.note,
  error: c.error,
} : null);

export function makeQuotasRoute(deps) {
  return async (req, res) => {
    const snap = await getQuotas();
    deps.sendJson(res, 200, {
      ok: true,
      generated_at: snap.generated_at,
      observed_at: snap.generated_at,
      source: snap.source,
      cache: snap.cache,
      providers: (snap.providers || []).map(providerView),
      codex: codexView(snap.codex),
      notes: snap.notes || [],
    });
  };
}
