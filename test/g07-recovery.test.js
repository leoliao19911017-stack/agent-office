// G07-C｜API 异常与恢复回归（4 用例）——G06 四态（connected/conn-fail/data-fail/退避恢复）的门禁化。
//
// 故障注入两层：
//   - 浏览器层 page.route()（与 web/verify-g06.mjs 同一已验证手法）：/api/health 500、全 /api/ 中断；
//   - 服务层真实故障：stub 中台切换 faultMode（/v1/state 回非 JSON / 回 503），
//     web/server.js callHub 真实转发真实报错——这条链路同时覆盖「中台挂了」的服务端语义。
// 恢复一律走产品自身退避链（2s/4s/8s→30s 上限），验收窗口 ≤35s。
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, launchBrowser, newPage, sleep } from './g07-harness.mjs';

let stack, browser;

before(async () => {
  stack = await startStack();
  browser = await launchBrowser();
});

after(async () => {
  await browser?.close();
  await stack?.stop();
});

// C2/C3 会真实切换 stub 中台的 faultMode；任何一条用例中途失败都必须复位，
// 否则会污染同文件后续用例（R90 前 C2 色值断言先挂，C3/C4 全部跟着「未连接」超时）。
afterEach(() => {
  if (stack) stack.hub.faultMode = null;
});

// 解析主题 token 的实际计算色：R90 双主题下 --amber 不再是 app-base 里的 #E5B95E，
// 断言跟当前主题 token 对齐，而不是把某一套主题的字面色焊死。
const tokenColor = (page, name) => page.evaluate((n) => {
  const probe = document.createElement('span');
  probe.style.color = `var(${n})`;
  document.body.appendChild(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();
  return c;
}, name);

const connSnapshot = (page) => page.evaluate(() => {
  const el = document.getElementById('sb-conn');
  const cs = getComputedStyle(el);
  return {
    cls: el.className,
    text: document.getElementById('sb-conn-text').textContent,
    color: cs.color,
    dot: getComputedStyle(el.querySelector('.dot')).backgroundColor,
    bannerHidden: document.getElementById('data-banner').hidden,
    reqRows: document.querySelectorAll('#reqs-list .req-item').length,
    uiErrors: window.__uiErrors | 0,
  };
});

test('C1 /api/health 500 → 连接失败（与数据失败可区分），数据仍渲染；恢复 ≤35s', async () => {
  const { page } = await newPage(browser);
  try {
    await page.goto(stack.base + '/', { waitUntil: 'commit' });
    await page.waitForSelector('#sb-conn.ok', { timeout: 15000 });

    await page.route('**/api/health', (r) =>
      r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"G07 注入 500"}' }));
    await page.reload({ waitUntil: 'commit' });
    // 谓词必须对「新文档还没解析到 #sb-conn」的瞬间返回 false 而不是抛 TypeError：
    // reload(commit) 之后 DOM 尚未就绪时 getElementById 会是 null。
    await page.waitForFunction(() => {
      const el = document.getElementById('sb-conn');
      const txt = document.getElementById('sb-conn-text');
      return !!el && !!txt && el.classList.contains('off') && txt.textContent.startsWith('连接失败');
    }, null, { timeout: 20000 });
    const t = await connSnapshot(page);
    assert.ok(t.text.startsWith('连接失败'), `底栏应「连接失败」，实际「${t.text}」`);
    assert.equal(t.color, await tokenColor(page, '--amber'), `异常色应为当前主题 --amber，实测 ${t.color}`);
    assert.equal(t.dot, await tokenColor(page, '--amber'), `异常点色应为当前主题 --amber，实测 ${t.dot}`);
    assert.ok(t.reqRows >= 3, `health 挂不应毁掉业务数据（state/flow 未拦截），实际 ${t.reqRows} 行`);

    await page.unroute('**/api/health');
    const t0 = Date.now();
    await page.waitForSelector('#sb-conn.ok', { timeout: 35000 });
    const recSec = ((Date.now() - t0) / 1000).toFixed(1);
    const r = await connSnapshot(page);
    assert.equal(r.text, '已连接');
    assert.ok(Number(recSec) <= 35, `恢复耗时 ${recSec}s 应 ≤35s`);
    console.log(`[C1] health 500 → 连接失败（${t.text}，色 ${t.color}，rows=${t.reqRows}）→ ${recSec}s 恢复`);
  } finally { await page.close(); }
});

test('C2 中台回非 JSON → 数据获取失败（横幅点名），恢复 ≤35s 且数据回来', async () => {
  const { page } = await newPage(browser);
  try {
    await page.goto(stack.base + '/', { waitUntil: 'commit' });
    await page.waitForSelector('#sb-conn.ok', { timeout: 15000 });

    stack.hub.faultMode = 'garbage'; // 服务层真实故障：stub 中台 /v1/state 回 200+HTML
    await page.reload({ waitUntil: 'commit' });
    await page.waitForFunction(() => {
      const el = document.getElementById('sb-conn');
      const txt = document.getElementById('sb-conn-text');
      return !!el && !!txt && el.classList.contains('off') && txt.textContent.includes('数据获取失败');
    }, null, { timeout: 25000 });
    const t = await connSnapshot(page);
    assert.ok(t.text.includes('数据获取失败'), `应「数据获取失败」，实际「${t.text}」`);
    assert.equal(t.color, await tokenColor(page, '--amber'), `异常色应为当前主题 --amber，实测 ${t.color}`);
    assert.equal(t.bannerHidden, false, '失败横幅必须可见（不许伪装成空数据）');
    const banner = await page.locator('#data-banner').innerText();
    assert.ok(banner.includes('中台状态'), `横幅应点名「中台状态」行，实际：${banner.slice(0, 100)}`);

    stack.hub.faultMode = null;
    const t0 = Date.now();
    await page.waitForSelector('#sb-conn.ok', { timeout: 35000 });
    const recSec = ((Date.now() - t0) / 1000).toFixed(1);
    const r = await connSnapshot(page);
    assert.equal(r.text, '已连接');
    assert.ok(r.reqRows >= 3, `恢复后需求行应 ≥3，实际 ${r.reqRows}`);
    assert.equal(r.bannerHidden, true, `恢复后过期横幅应隐藏，实测 hidden=${r.bannerHidden}`);
    console.log(`[C2] 中台坏 JSON → 数据获取失败（横幅点名）→ ${recSec}s 恢复 rows=${r.reqRows}`);
  } finally { await page.close(); }
});

test('C3 中台 503 → 服务端透传 502/503（curl 口径），前端数据获取失败，恢复 ≤35s', async () => {
  const { page } = await newPage(browser);
  try {
    await page.goto(stack.base + '/', { waitUntil: 'commit' });
    await page.waitForSelector('#sb-conn.ok', { timeout: 15000 });

    stack.hub.faultMode = 'http503';
    // curl 等价口径：直接打服务端 /api/state，核对透传的状态码与错误码（不是 200 空壳）
    const srvRes = await fetch(stack.base + '/api/state');
    const srvBody = await srvRes.json();
    assert.ok([502, 503].includes(srvRes.status), `服务端应透传 502/503，实际 HTTP ${srvRes.status}`);
    assert.equal(srvBody.code, 'STUB_503', `应透传中台业务码 STUB_503，实际 ${JSON.stringify(srvBody)}`);

    await page.reload({ waitUntil: 'commit' });
    await page.waitForFunction(() => {
      const el = document.getElementById('sb-conn');
      const txt = document.getElementById('sb-conn-text');
      return !!el && !!txt && el.classList.contains('off') && txt.textContent.includes('数据获取失败');
    }, null, { timeout: 25000 });
    const t = await connSnapshot(page);
    assert.ok(t.text.includes('数据获取失败'), `应「数据获取失败」，实际「${t.text}」`);

    stack.hub.faultMode = null;
    const t0 = Date.now();
    await page.waitForSelector('#sb-conn.ok', { timeout: 35000 });
    const recSec = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[C3] 中台 503 → 服务端透传 HTTP ${srvRes.status}/${srvBody.code} → 前端数据失败 → ${recSec}s 恢复`);
  } finally { await page.close(); }
});

test('C4 全部 /api/ 中断 → 持续「连接失败·网络错误」不空白；恢复 ≤35s 带回真实数据', async () => {
  const { page, state } = await newPage(browser);
  try {
    await page.goto(stack.base + '/', { waitUntil: 'commit' });
    await page.waitForSelector('#sb-conn.ok', { timeout: 15000 });

    await page.route('**/api/**', (r) => r.abort());
    await page.reload({ waitUntil: 'commit' });
    await page.waitForFunction(() => {
      const el = document.getElementById('sb-conn');
      const txt = document.getElementById('sb-conn-text');
      return !!el && !!txt && el.classList.contains('off') && txt.textContent.startsWith('连接失败');
    }, null, { timeout: 20000 });

    // 间隔采样两次：断网期间状态必须持续稳定，不允许空白/误报已连接
    const samples = [];
    for (const wait of [500, 4000]) {
      await sleep(wait);
      const s = await connSnapshot(page);
      samples.push(`${s.text}/rows=${s.reqRows}`);
      assert.ok(s.cls.includes('off') && s.text.startsWith('连接失败'),
        `中断期间应持续「连接失败」，采样：${s.text}`);
      const bodyH = await page.evaluate(() => document.body.getBoundingClientRect().height);
      assert.ok(bodyH > 400, `中断期间页面不许空白，body 高实测 ${bodyH}`);
    }
    const t = await connSnapshot(page);
    assert.equal(t.text, '连接失败 · 网络错误', `原因应可区分「网络错误」，实际「${t.text}」`);

    await page.unroute('**/api/**');
    const t0 = Date.now();
    await page.waitForSelector('#sb-conn.ok', { timeout: 35000 });
    const recSec = ((Date.now() - t0) / 1000).toFixed(1);
    const r = await connSnapshot(page);
    assert.equal(r.text, '已连接');
    assert.ok(r.reqRows >= 3, `恢复后需求行 ≥3，实际 ${r.reqRows}`);
    assert.ok(state.consoleAll.some((s) => s.includes('已重新连接')),
      '恢复日志应出现「已重新连接」');
    console.log(`[C4] 断网采样[${samples.join(' | ')}] → ${recSec}s 恢复 rows=${r.reqRows}`);
  } finally { await page.close(); }
});
