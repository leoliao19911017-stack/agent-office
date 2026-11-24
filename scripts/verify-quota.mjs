// TASK-额度面板 验收 Q1-Q6
// 跑法：node scripts/verify-quota.mjs [1440x900]
//
// Q1 3 个 GLM provider，每个 5h + 周两个窗口
// Q2 与厂商接口逐窗口对比（percentage / remaining / resetAt）
// Q3 前端条形图 + 重置倒计时 + 字号 >= 11（截图）
// Q4 响应 / agent-office.db / 日志里没有 key；响应里没有 token/api_key 字样
// Q5 连续 10 次 /api/quotas 只打一轮厂商接口（缓存）
// Q6 Codex 显示已用，并明确「无剩余额度接口」，不编造 remaining
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  GLM_QUOTA_URL, readZhipuProviders, parseLimitWindows,
} from '../web/lib/quota.mjs';

const BASE = process.env.BOARD_BASE || 'http://127.0.0.1:8090';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const [W, H] = (process.argv[2] || '1440x900').split('x').map(Number);
const OUT = resolve('docs/evidence/quota');
mkdirSync(OUT, { recursive: true });

const failures = [];
const checks = [];
function check(id, name, ok, detail) {
  checks.push({ id, name, ok, detail });
  if (!ok) failures.push(`${id} ${name}：${detail}`);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function getJson(path) {
  const res = await fetch(BASE + path, { headers: { accept: 'application/json' } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return { json: JSON.parse(text), text };
}

// ---------- Q1 ----------
const api = await getJson('/api/quotas');
const { json: q, text: apiText } = api;
const providers = Array.isArray(q.providers) ? q.providers : [];
check('Q1', '3 个 GLM provider', providers.length === 3, `实际 ${providers.length} 个`);
for (const p of providers) {
  const units = (p.windows || []).map((w) => Number(w.unit)).sort();
  const ok = units.length === 2 && units[0] === 3 && units[1] === 6;
  check('Q1', `${p.name} 有 5h(unit=3) + 周(unit=6) 两个窗口`, ok,
    (p.windows || []).map((w) => `${w.label} ${w.percentage == null ? '—' : `${w.percentage}%`}`).join(' / ') || '没有窗口');
}

// ---------- Q2 ----------
const dbProviders = readZhipuProviders();
const vendorRows = [];
for (const p of providers) {
  const src = (dbProviders.providers || []).find((x) => x.id === p.id);
  if (!src || !src.token) {
    vendorRows.push({ provider: p.name, ok: false, error: 'cc-switch 里找不到这个 provider 的凭据' });
    continue;
  }
  let raw;
  try {
    const res = await fetch(GLM_QUOTA_URL, {
      headers: { Authorization: src.token, 'Accept-Language': 'en-US,en' },
      signal: AbortSignal.timeout(15000),
    });
    raw = await res.json();
  } catch (err) {
    vendorRows.push({ provider: p.name, ok: false, error: String(err.message || err) });
    continue;
  }
  const expected = parseLimitWindows(raw?.data?.limits || []);
  const rows = [];
  let ok = raw?.code === 200 && expected.length === 2 && p.ok === true;
  for (const unit of [3, 6]) {
    const a = (p.windows || []).find((w) => Number(w.unit) === unit);
    const v = expected.find((w) => Number(w.unit) === unit);
    const pctSame = a && v && a.percentage === v.percentage;
    const remSame = a && v && a.remaining === v.remaining;
    const resetSame = a && v && a.resetAt === v.resetAt;
    if (!pctSame || !remSame || !resetSame) ok = false;
    rows.push({
      unit, label: v?.label || a?.label,
      api: a ? { percentage: a.percentage, remaining: a.remaining, resetAt: a.resetAt } : null,
      vendor: v ? { percentage: v.percentage, remaining: v.remaining, resetAt: v.resetAt } : null,
      same: { percentage: pctSame, remaining: remSame, resetAt: resetSame },
    });
    console.log(`       ${p.name.padEnd(4)} ${String(v?.label || unit).padEnd(7)} API ${String(a?.percentage ?? '—').padStart(3)}% / 厂商 ${String(v?.percentage ?? '—').padStart(3)}% · 剩余 API ${a?.remaining ?? '—'} / 厂商 ${v?.remaining ?? '—'}`);
  }
  // 厂商 level 也要和接口一致
  if ((raw?.data?.level || null) !== (p.level || null)) ok = false;
  vendorRows.push({
    provider: p.name, id: p.id, api_level: p.level, vendor_level: raw?.data?.level || null, ok, windows: rows,
  });
  check('Q2', `${p.name} 与厂商接口逐字段一致`, ok, ok ? 'percentage / remaining / resetAt 全一致' : '有字段不一致，见 vendor-compare.json');
}
writeFileSync(join(OUT, 'vendor-compare.json'), JSON.stringify({
  generatedAt: new Date().toISOString(), glmUrl: GLM_QUOTA_URL,
  apiGeneratedAt: q.generated_at, providers: vendorRows,
}, null, 2));

// ---------- Q4（先查响应与本地持久化，再跑 UI） ----------
const tokens = (dbProviders.providers || []).map((p) => p.token).filter(Boolean);
const leakedInResponse = tokens.filter((t) => apiText.includes(t));
check('Q4', '响应里没有 key 值', leakedInResponse.length === 0, `${tokens.length} 个 key 逐个比对，命中 ${leakedInResponse.length} 个`);
check('Q4', '响应里没有 token/api_key/authorization/settings_config 字样',
  !/token|api_key|authorization|settings_config/i.test(apiText),
  /token|api_key|authorization|settings_config/i.test(apiText) ? '命中敏感字样' : 'grep 结果 0');

const dbFiles = ['data/agent-office.db', 'data/agent-office.db-wal'].map((p) => resolve(p)).filter((p) => existsSync(p));
const dbLeaks = [];
for (const f of dbFiles) {
  const buf = readFileSync(f);
  for (const t of tokens) if (buf.includes(t)) dbLeaks.push(f);
}
check('Q4', 'agent-office.db（含 WAL）里没有 key', dbLeaks.length === 0, dbLeaks.length ? `命中：${[...new Set(dbLeaks)].join(', ')}` : `${dbFiles.length} 个文件逐个字节比对，0 命中`);

const logFiles = ['web/web-8090.out', 'web/web-8090.err'].map((p) => resolve(p)).filter((p) => existsSync(p));
const logLeaks = [];
for (const f of logFiles) {
  const text = readFileSync(f, 'utf8');
  for (const t of tokens) if (text.includes(t)) logLeaks.push(f);
}
check('Q4', '服务日志里没有 key', logLeaks.length === 0, logLeaks.length ? `命中：${[...new Set(logLeaks)].join(', ')}` : `${logFiles.length} 个日志文件逐个比对，0 命中`);

// ---------- Q5 ----------
const before = q.cache || {};
const rounds = [];
for (let i = 0; i < 10; i += 1) {
  const r = await getJson('/api/quotas');
  rounds.push(r.json.cache || {});
}
const last = rounds[rounds.length - 1];
const sameRounds = last.vendor_rounds === before.vendor_rounds;
const sameRequests = last.vendor_requests === before.vendor_requests;
check('Q5', '连续 10 次请求没有新增厂商调用',
  sameRounds && sameRequests,
  `vendor_rounds ${before.vendor_rounds} → ${last.vendor_rounds}，vendor_requests ${before.vendor_requests} → ${last.vendor_requests}（3 个 key 各 1 次 = 1 轮）`);
check('Q5', '10 次全部吃缓存', rounds.every((c) => c.hit === true) && last.hits >= 10,
  `cache.hit=${rounds.map((c) => (c.hit ? '1' : '0')).join('')}，hits=${last.hits}，ttl=${last.ttl_ms}ms`);

// ---------- Q6 ----------
const codex = q.codex || {};
check('Q6', 'Codex 只显示已用，不编造剩余额度',
  codex.remaining === null && codex.remaining_supported === false
    && typeof codex.used_usd === 'number' && typeof codex.requests === 'number',
  `remaining=${codex.remaining} remaining_supported=${codex.remaining_supported} 今日 ${codex.used_usd} USD / ${codex.requests} 次`);
check('Q6', 'Codex 明确标注无剩余额度接口',
  /没有剩余额度查询接口|无剩余额度接口/.test(String(codex.note || '')),
  String(codex.note || '').slice(0, 80));

// ---------- Q3：前端 ----------
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`console: ${m.text()}`); });
await page.goto(`${BASE}/board-cromma.html#board`, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForFunction(() => document.querySelectorAll('.agent-card[data-agent="claude"] .quota-row').length === 3, { timeout: 20000 });
await page.waitForTimeout(500);

const ui = await page.evaluate(() => {
  const claude = document.querySelector('.agent-card[data-agent="claude"]');
  const codex = document.querySelector('.agent-card[data-agent="codex"]');
  const rows = [...claude.querySelectorAll('.quota-row')];
  const bars = [...claude.querySelectorAll('.quota-bar b')];
  const resetEls = [...claude.querySelectorAll('.quota-row__reset')];
  const textEls = [...claude.querySelectorAll('.quota-block *')].filter((el) => (el.textContent || '').trim());
  const sizes = textEls.map((el) => parseFloat(getComputedStyle(el).fontSize)).filter((n) => Number.isFinite(n));
  return {
    rows: rows.map((r) => ({
      provider: r.dataset.provider,
      tone: r.dataset.tone,
      text: r.innerText.replace(/\s+/g, ' ').trim(),
      bars: [...r.querySelectorAll('.quota-bar b')].map((b) => b.style.width),
      pcts: [...r.querySelectorAll('.quota-win em')].map((e) => e.textContent.trim()),
      reset: r.querySelector('.quota-row__reset')?.textContent.trim(),
      resetAt: r.querySelector('.quota-row__reset')?.dataset.resetAt || '',
    })),
    barCount: bars.length,
    resetCount: resetEls.length,
    minFontSize: sizes.length ? Math.min(...sizes) : null,
    codexText: codex.innerText.replace(/\s+/g, ' ').trim(),
    codexHasNoRemaining: /无剩余额度接口/.test(codex.innerText),
    codexHasToday: /今日/.test(codex.innerText),
    claudeHasEmptyNote: /未接入/.test(claude.innerText),
  };
});

check('Q3', 'Claude 卡有 3 行 provider 额度', ui.rows.length === 3, ui.rows.map((r) => r.text.slice(0, 46)).join(' | '));
check('Q3', '每个窗口都有条形图（3 provider × 2 窗口 = 6 条）', ui.barCount === 6, `bars=${ui.barCount}`);
check('Q3', '百分比与条形宽度一致', ui.rows.every((r) => r.pcts.every((p, i) => {
  const w = r.bars[i] || '';
  const n = Number.parseInt(w, 10);
  return p === '—' ? n === 0 : `${n}%` === p;
})), ui.rows.map((r) => `${r.pcts.join('/')}@${r.bars.join('/')}`).join(' | '));
check('Q3', '重置倒计时可读（每行一个；5h 没给重置时间就标「周」）',
  ui.resetCount === 3 && ui.rows.every((r) => /重置|周\s*\d/.test(r.reset || '')),
  ui.rows.map((r) => r.reset).join(' | '));
check('Q3', '额度块最小字号 >= 11px', ui.minFontSize >= 11, `min=${ui.minFontSize}px`);
check('Q6', 'Codex 卡显示已用 + 无剩余额度接口', ui.codexHasNoRemaining && ui.codexHasToday, ui.codexText.slice(0, 140));

// 刷新按钮必须有反应，且刷新后额度仍在
const beforeToast = await page.evaluate(() => Number(document.querySelector('#toast')?.dataset.count || 0));
await page.click('#refresh-btn');
await page.waitForFunction((n) => {
  const el = document.querySelector('#toast');
  return Number(el?.dataset.count || 0) > n && el.classList.contains('is-show');
}, beforeToast, { timeout: 15000 });
const refreshState = await page.evaluate(() => ({
  toast: document.querySelector('#toast')?.textContent,
  label: document.querySelector('#refresh-label')?.textContent,
  quotaRows: document.querySelectorAll('.agent-card[data-agent="claude"] .quota-row').length,
}));
check('Q3', '刷新按钮有真实反应且额度重新渲染', refreshState.quotaRows === 3 && /已重新读取/.test(refreshState.toast || ''),
  `toast=${refreshState.toast}`);

// 详情 tab 也显示额度（点 Claude 卡 → 详情）
await page.click('.agent-card[data-agent="claude"]');
await page.click('.seg__item[data-tab="detail"]');
await page.waitForTimeout(300);
const detailText = await page.evaluate(() => (document.querySelector('.chat__detail')?.innerText || '').replace(/\s+/g, ' ').slice(0, 260));
check('Q3', '「详情」tab 能看到额度明细', /额度 · GLM/.test(detailText) && /5h/.test(detailText), detailText.slice(0, 160));

await page.screenshot({ path: join(OUT, `board-quota-${W}x${H}.png`), fullPage: false });
await browser.close();
check('Q3', '页面无 JS 报错', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 200));

// ---------- 汇总 ----------
const report = {
  generatedAt: new Date().toISOString(),
  base: BASE,
  viewport: `${W}x${H}`,
  api: {
    generated_at: q.generated_at,
    providers: q.providers,
    codex: q.codex,
    cache: q.cache,
  },
  ui,
  checks,
  failures,
  screenshots: [`docs/evidence/quota/board-quota-${W}x${H}.png`],
  pass: failures.length === 0,
};
writeFileSync(join(OUT, 'verify-quota.json'), JSON.stringify(report, null, 2));
writeFileSync(join(OUT, 'api-quotas.json'), JSON.stringify(q, null, 2));

console.log(`\n=== 额度面板验收 ${failures.length ? 'FAIL' : 'PASS'} ===`);
console.log(`检查项 ${checks.length}，失败 ${failures.length}`);
if (failures.length) console.log(failures.join('\n'));
console.log(`证据：${OUT}`);
process.exit(failures.length ? 1 : 0);
