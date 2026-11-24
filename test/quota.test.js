// 额度面板数据层回归：兼容「只有 percentage」/ unit 过滤 / 5 分钟缓存 / 不泄凭据。
// 跑法：node --no-warnings --test test/quota.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  parseLimitWindows, createQuotaService, readCodexUsage, localDate, providerShortName,
} from '../web/lib/quota.mjs';

const TOKEN_A = 'sk-test-token-aaaaaaaaaaaaaaaaaaaa';
const TOKEN_B = 'sk-test-token-bbbbbbbbbbbbbbbbbbbb';
const TOKEN_C = 'sk-test-token-cccccccccccccccccccc';

test('parseLimitWindows：只按 unit 分类，type=TOKENS_LIMIT / CREDIT_LIMIT / 缺字段都认', () => {
  const windows = parseLimitWindows([
    // unit=5 是 TIME_LIMIT（搜索/阅读工具），不是 5 小时额度窗，必须忽略
    { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 3 },
    // 旧版 CREDIT_LIMIT 也要认
    { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 28000, currentValue: 284, remaining: 27715, percentage: 1, nextResetTime: 1795499923795 },
    // 涛哥 key 的真实形态：TOKENS_LIMIT + 只有 percentage，没有 usage/remaining/reset
    { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 0 },
    { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 40, nextResetTime: 1796023131983 },
  ]);
  assert.equal(windows.length, 2, '只有 unit=3 / unit=6 两个窗口');
  assert.deepEqual(windows.map((w) => w.unit), [3, 6]);
  assert.equal(windows[0].percentage, 1);
  assert.equal(windows[0].remaining, 27715);
  assert.equal(windows[0].basis, 'usage');
  assert.equal(windows[0].resetAt, new Date(1795499923795).toISOString());
  assert.equal(windows[1].percentage, 40);
  assert.equal(windows[1].remaining, null, '只有百分比时 remaining 必须是 null，不能拿 0 冒充');
  assert.equal(windows[1].basis, 'percentage');
});

test('parseLimitWindows：TOKENS_LIMIT 只有 percentage 也能出 5h/周两个窗口', () => {
  const windows = parseLimitWindows([
    { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 0 },
    { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 40, nextResetTime: 1796023131983 },
  ]);
  assert.equal(windows.length, 2);
  assert.equal(windows[0].percentage, 0);
  assert.equal(windows[0].remaining, null);
  assert.equal(windows[0].resetAt, null);
  assert.equal(windows[1].percentage, 40);
  assert.equal(windows[1].remaining, null);
});

test('parseLimitWindows：有 usage/currentValue 但没 percentage 时可反推已用百分比', () => {
  const [w] = parseLimitWindows([{ unit: 3, usage: 28000, currentValue: 7000 }]);
  assert.equal(w.percentage, 25);
  assert.equal(w.remaining, null);
});

test('缓存：10 次请求只打 1 轮厂商接口（3 个 key 各 1 次）', async () => {
  let calls = 0;
  let clock = 1_700_000_000_000;
  const providers = [
    { id: 'p1', provider_name: 'Zhipu GLM（涛哥）', name: '涛哥', model: 'glm-5.4', token: TOKEN_A },
    { id: 'p2', provider_name: 'Zhipu GLM（磊哥）', name: '磊哥', model: 'glm-5.4', token: TOKEN_B },
    { id: 'p3', provider_name: 'Zhipu GLM', name: '闲置', model: 'glm-5.4', token: TOKEN_C },
  ];
  const fetchImpl = async (url, init) => {
    calls += 1;
    assert.equal(url, 'https://open.bigmodel.cn/api/monitor/usage/quota/limit');
    assert.ok(init.headers.Authorization.startsWith('sk-test-token-'), '裸 key，不加 Bearer');
    assert.ok(!init.headers.Authorization.startsWith('Bearer '));
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({
        code: 200, success: true,
        data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, percentage: 1 }, { type: 'CREDIT_LIMIT', unit: 6, usage: 140000, currentValue: 103202, remaining: 36797, percentage: 73, nextResetTime: 1795835951983 }], level: 'max' },
      }),
    };
  };
  const service = createQuotaService({
    fetchImpl,
    readProviders: () => ({ providers, error: null }),
    readCodex: () => ({ agent_id: 'codex', remaining: null, remaining_supported: false, used_usd: 0, requests: 0 }),
    now: () => clock,
    ttlMs: 300_000,
  });

  let last;
  for (let i = 0; i < 10; i += 1) {
    last = await service.getQuotas();
    clock += 1_000;
  }
  assert.equal(calls, 3, '10 次请求只打 3 个 HTTP（一轮），不是 30 个');
  assert.equal(last.cache.vendor_rounds, 1);
  assert.equal(last.cache.vendor_requests, 3);
  assert.equal(last.cache.hits, 9);
  assert.equal(last.cache.hit, true);
  assert.equal(last.providers.length, 3);
  assert.equal(last.providers[0].windows.length, 2);
  assert.equal(last.providers[0].windows[1].percentage, 73);

  // 凭据绝不能出现在返回体里
  const text = JSON.stringify(last);
  for (const token of [TOKEN_A, TOKEN_B, TOKEN_C]) assert.equal(text.includes(token), false);
  assert.equal(/api_key|token|authorization|settings_config/i.test(text), false, '响应里连字段名/凭据名都不出现');

  // 5 分钟后再请求才允许重新打厂商
  clock += 300_001;
  await service.getQuotas();
  assert.equal(calls, 6, '缓存过期后重新打一轮 3 个 key');
});

test('厂商报错也会脱敏，不把 key 带进 error 字段', async () => {
  const service = createQuotaService({
    fetchImpl: async () => { throw new Error(`connect failed for ${TOKEN_A}`); },
    readProviders: () => ({ providers: [{ id: 'p1', provider_name: 'Zhipu GLM', name: '涛哥', model: null, token: TOKEN_A }], error: null }),
    readCodex: () => ({ remaining_supported: false }),
    now: () => 1_700_000_000_000,
  });
  const snap = await service.getQuotas();
  assert.equal(snap.providers[0].ok, false);
  assert.equal(String(snap.providers[0].error).includes(TOKEN_A), false);
  assert.match(String(snap.providers[0].error), /REDACTED/);
});

test('providerShortName：涛哥 / 磊哥 / 空的那个（闲置）', () => {
  assert.equal(providerShortName('Zhipu GLM（涛哥）'), '涛哥');
  assert.equal(providerShortName('Zhipu GLM（磊哥）'), '磊哥');
  assert.equal(providerShortName('Zhipu GLM'), '闲置');
});

test('Codex：只算 usage_daily_rollups 的已用量，今日没记录就如实说没有', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quota-codex-'));
  const dbPath = join(dir, 'cc-switch.db');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`CREATE TABLE usage_daily_rollups (
      date TEXT, app_type TEXT, provider_id TEXT, model TEXT, request_model TEXT, pricing_model TEXT,
      request_count INTEGER, success_count INTEGER, input_tokens INTEGER, output_tokens INTEGER,
      cache_read_tokens INTEGER, cache_creation_tokens INTEGER, total_cost_usd TEXT,
      avg_latency_ms REAL, input_token_semantics INTEGER)`);
    db.prepare("INSERT INTO usage_daily_rollups (date, app_type, request_count, total_cost_usd) VALUES (?,?,?,?)")
      .run('2026-10-24', 'codex', 709, '56.0838368');
    db.prepare("INSERT INTO usage_daily_rollups (date, app_type, request_count, total_cost_usd) VALUES (?,?,?,?)")
      .run('2026-10-24', 'claude', 300, '9.99');
    const r = readCodexUsage(dbPath, new Date(2026, 10, 24, 10, 0, 0));
    assert.equal(r.date, '2026-11-24');
    assert.equal(r.has_today, false);
    assert.equal(r.used_usd, 0);
    assert.equal(r.requests, 0);
    assert.equal(r.latest_date, '2026-10-24');
    assert.equal(r.latest_requests, 709);
    assert.ok(Math.abs(r.latest_used_usd - 56.0838368) < 1e-9);
    assert.equal(r.remaining, null);
    assert.equal(r.remaining_supported, false);
    assert.match(r.note, /没有剩余额度查询接口/);
    assert.equal(localDate(new Date(2026, 0, 2)), '2026-01-02');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
