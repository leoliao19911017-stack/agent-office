// G06 验收（Playwright + 系统 Chrome，打 8090；故障全部用 page.route() 拦截注入，不动服务端）：
//  T0 正常基线：真实服务 → #sb-conn.ok「已连接」，getComputedStyle 实测 #65D9B1 / 12px / 18px，横幅隐藏，console.error=0
//  T1 /api/health 返回 500 → 底栏「连接失败 · …」#E5B95E（12px/18px），数据仍渲染，console 有 [G06] 连接失败
//  T2 /api/state 挂起 10s（首轮 8s 超时）→ 「数据获取失败 · 请求超时」，横幅出「中台状态」行，console 有 [G06] 数据获取失败；
//     解除拦截后 ≤35s 内恢复「已连接」+ 真实数据行（2s/4s/8s 退避链）
//  T3 /api/state 返回 200 + 无效 JSON → 「数据获取失败 · 响应不是有效 JSON」；
//     文件接口 /api/office/file-check 同样注坏 → 页内直调 api() 应抛 isDataError（可区分）
//  T4 全部 /api/ 中断 60s → 持续「连接失败 · 网络错误」，绝不出现已连接/连接中/空白；
//     恢复后 ≤35s 内重新拿到真实数据，console 出现「已重新连接」
import { chromium } from 'playwright-core';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:8090';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (name, ok, detail) => {
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
  if (!ok) failed++;
};

// 底栏连接区的实测快照（文本/类名/真实样式）
function connState(page) {
  return page.evaluate(() => {
    const el = document.getElementById('sb-conn');
    const t = document.getElementById('sb-conn-text');
    const cs = getComputedStyle(el);
    const tcs = getComputedStyle(t);
    return {
      cls: el.className, text: t.textContent,
      color: cs.color, fontSize: tcs.fontSize, lineHeight: tcs.lineHeight,
      dot: getComputedStyle(el.querySelector('.dot')).backgroundColor,
      bannerHidden: document.getElementById('data-banner').hidden,
      bannerCls: document.getElementById('data-banner').className,
      spConn: document.getElementById('sp-conn').textContent,
      tbTask: document.getElementById('tb-task').textContent,
      navCount: document.querySelectorAll('#rail .rail-item').length,
      chainMsg: (document.querySelector('#center-chain .empty p') || {}).textContent || '',
      reqRows: document.querySelectorAll('#reqs-list .req-item').length,
      bodyH: document.body.getBoundingClientRect().height,
    };
  });
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
let pageErrors = [], consoleErrs = [], consoleAll = [];
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));
page.on('console', (m) => {
  const txt = m.text().slice(0, 300);
  consoleAll.push(m.type() + '|' + txt);
  if (m.type() === 'error') consoleErrs.push(txt);
});

try {
  // ---------- T0：正常基线（无拦截，真实 8090） ----------
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForSelector('#sb-conn.ok', { timeout: 20000 });
  await sleep(600);
  const t0 = await connState(page);
  check('T0 底栏文本=已连接', t0.text === '已连接', t0.text);
  check('T0 正常色 #65D9B1', t0.color === 'rgb(101, 217, 177)', t0.color);
  check('T0 点色 #65D9B1', t0.dot === 'rgb(101, 217, 177)', t0.dot);
  check('T0 字号 12px', t0.fontSize === '12px', t0.fontSize);
  check('T0 行高 18px', t0.lineHeight === '18px', t0.lineHeight);
  check('T0 横幅隐藏', t0.bannerHidden === true, 'hidden=' + t0.bannerHidden);
  check('T0 设置弹层连接态=已连接', t0.spConn === '已连接', t0.spConn);
  check('T0 真实数据行 > 0', t0.reqRows > 0, 'reqRows=' + t0.reqRows);
  check('T0 console.error = 0', consoleErrs.length === 0, consoleErrs.join(' || ') || '无');

  // ---------- T1：/api/health 返回 500 ----------
  await page.route('**/api/health', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'internal error' }) }));
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#sb-conn.off', { timeout: 20000 });
  await sleep(600);
  const t1 = await connState(page);
  check('T1 底栏=连接失败（health 500）', t1.text.startsWith('连接失败'), t1.text);
  check('T1 异常色 #E5B95E', t1.color === 'rgb(229, 185, 94)', t1.color);
  check('T1 点色 #E5B95E', t1.dot === 'rgb(229, 185, 94)', t1.dot);
  check('T1 字号 12px', t1.fontSize === '12px', t1.fontSize);
  check('T1 行高 18px', t1.lineHeight === '18px', t1.lineHeight);
  check('T1 数据仍在（state/flow 未拦截）', t1.reqRows > 0, 'reqRows=' + t1.reqRows);
  check('T1 导航保留', t1.navCount >= 5, 'navCount=' + t1.navCount);
  check('T1 顶栏有数据时显示任务名、无数据时标注失败态',
    t1.reqRows > 0 ? t1.tbTask.length > 0 : t1.tbTask === '连接失败', `tbTask=${t1.tbTask}（有任务时显示任务名）`);
  check('T1 设置弹层=连接失败', t1.spConn === '连接失败', t1.spConn);
  check('T1 console 有 [G06] 连接失败', consoleErrs.some((s) => s.includes('[G06] 连接失败') && s.includes('health')),
    consoleErrs.filter((s) => s.includes('G06')).join(' || ') || '未见');
  await page.unroute('**/api/health');

  // ---------- T2：/api/state 挂起 10s（首轮 8000ms 超时） ----------
  await page.route('**/api/state', async (route) => {
    await sleep(10000);            // 首轮 8s 超时先到：fetch 被 AbortSignal.timeout(8000) 掐断
    // 客户端已放弃该请求，route 可能已被判handled——继续放行失败可忽略
    await route.continue().catch(() => {});
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => {
    const el = document.getElementById('sb-conn');
    return el.classList.contains('off') && document.getElementById('sb-conn-text').textContent.includes('数据获取失败');
  }, null, { timeout: 20000 });
  await sleep(500);
  const t2 = await connState(page);
  const bannerText = await page.evaluate(() => document.getElementById('data-banner').textContent);
  check('T2 底栏=数据获取失败 · 请求超时（state 超时与连接失败可区分）', t2.text === '数据获取失败 · 请求超时', t2.text);
  check('T2 异常色 #E5B95E', t2.color === 'rgb(229, 185, 94)', t2.color);
  check('T2 横幅可见且含「中台状态」失败行', t2.bannerHidden === false && bannerText.includes('中台状态'), bannerText.slice(0, 120));
  check('T2 console 有 [G06] 数据获取失败且点名 state',
    consoleErrs.some((s) => s.includes('[G06] 数据获取失败') && s.includes('state')),
    consoleErrs.filter((s) => s.includes('数据获取失败')).slice(-1).join(' || ') || '未见');
  // 解除拦截 → 退避链（此刻已失败 2-3 轮，间隔 4-8s）应在 35s 内恢复
  await page.unroute('**/api/state');
  await page.waitForSelector('#sb-conn.ok', { timeout: 35000 });
  const t2r = await connState(page);
  check('T2R 恢复后底栏=已连接', t2r.text === '已连接', t2r.text);
  check('T2R 恢复后拿到真实数据', t2r.reqRows > 0, 'reqRows=' + t2r.reqRows);
  check('T2R 过期错误态已清除（横幅隐藏）', t2r.bannerHidden === true, 'hidden=' + t2r.bannerHidden);

  // ---------- T3：/api/state 200 + 无效 JSON；文件接口 file-check 同样注坏 ----------
  await page.route('**/api/state', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: 'not-json{{{ 坏了' }));
  await page.route('**/api/office/file-check', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: 'not-json{{{ 坏了' }));
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => {
    const el = document.getElementById('sb-conn');
    return el.classList.contains('off') && document.getElementById('sb-conn-text').textContent.includes('响应不是有效 JSON');
  }, null, { timeout: 20000 });
  const t3 = await connState(page);
  check('T3 底栏=数据获取失败 · 响应不是有效 JSON（无效 JSON 不再伪装成功）',
    t3.text === '数据获取失败 · 响应不是有效 JSON', t3.text);
  check('T3 console 有 [G06] 数据获取失败', consoleErrs.some((s) => s.includes('[G06] 数据获取失败')),
    consoleErrs.filter((s) => s.includes('G06')).slice(-1).join(' || ') || '未见');
  // 页内直调 api() 打文件接口：无效 JSON 必须抛 isDataError（与 HTTP 错误/超时可区分）
  const apiResult = await page.evaluate(async () => {
    try {
      await api('/api/office/file-check', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      return { ok: true };
    } catch (e) { return { ok: false, msg: e.message, isDataError: e.isDataError === true, isHttpError: e.isHttpError === true }; }
  });
  check('T3 文件接口无效 JSON → api() 抛错且 isDataError=true',
    apiResult.ok === false && apiResult.isDataError === true && apiResult.isHttpError === false,
    JSON.stringify(apiResult));
  check('T3 错误文案点名 JSON', !apiResult.ok && /有效 JSON/.test(apiResult.msg), apiResult.msg);
  await page.unroute('**/api/state');
  await page.unroute('**/api/office/file-check');
  await page.waitForSelector('#sb-conn.ok', { timeout: 35000 });
  const t3r = await connState(page);
  check('T3R 解除后恢复已连接', t3r.text === '已连接', t3r.text);
  await page.reload({ waitUntil: 'load' });   // 洗掉 T3 期间的 console 计数，T4 从干净页面开始
  await page.waitForSelector('#sb-conn.ok', { timeout: 20000 });

  // ---------- T4：全部 /api/ 中断 60s，之后恢复 ----------
  const g06Before = consoleErrs.filter((s) => s.includes('G06')).length;
  await page.route('**/api/**', (route) => route.abort());
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => {
    const el = document.getElementById('sb-conn');
    return el.classList.contains('off') && document.getElementById('sb-conn-text').textContent.includes('连接失败');
  }, null, { timeout: 20000 });
  let outageOk = true, outageSamples = [];
  const t4start = Date.now();
  for (let i = 0; i <= 6; i++) {          // 0s…60s，每 10s 采样一次
    await sleep(i === 0 ? 300 : 10000);
    const s = await connState(page);
    const ok = s.cls.includes('off') && s.text.startsWith('连接失败') && !s.text.includes('已连接')
      && s.navCount >= 5 && s.bodyH > 400 && s.chainMsg.includes('连接失败');
    outageSamples.push(`t+${Math.round((Date.now() - t4start) / 1000)}s:${s.text}/rows=${s.reqRows}`);
    if (!ok) { outageOk = false; }
  }
  check('T4 断网 60s 持续「连接失败 · 网络错误」，无空白/无误报已连接', outageOk, outageSamples.join(' | '));
  const t4 = await connState(page);
  check('T4 原因为网络错误（与超时/HTTP 错误可区分）', t4.text === '连接失败 · 网络错误', t4.text);
  check('T4 顶栏=连接失败', t4.tbTask === '连接失败', t4.tbTask);
  check('T4 console 期间持续报 [G06] 连接失败',
    consoleErrs.slice(g06Before).filter((s) => s.includes('[G06] 连接失败')).length >= 3,
    `新增 ${consoleErrs.slice(g06Before).filter((s) => s.includes('[G06] 连接失败')).length} 条`);
  // 解除 → 最长 30s 退避间隔，35s 窗口内必须接回真实数据
  await page.unroute('**/api/**');
  const t4recoverStart = Date.now();
  await page.waitForSelector('#sb-conn.ok', { timeout: 35000 });
  const t4r = await connState(page);
  const recoverSec = Math.round((Date.now() - t4recoverStart) / 1000);
  check('T4R 恢复后底栏=已连接', t4r.text === '已连接', t4r.text);
  check('T4R 恢复后拿到真实数据行', t4r.reqRows > 0, 'reqRows=' + t4r.reqRows);
  check('T4R 恢复耗时 ≤35s（30s 退避上限 + 余量）', recoverSec <= 35, recoverSec + 's');
  check('T4R console 有「已重新连接，恢复真实数据」',
    consoleAll.some((s) => s.includes('G06') && s.includes('已重新连接')),
    consoleAll.filter((s) => s.includes('已重新连接')).slice(-1).join(' || ') || '未见');
  check('T4R 恢复后横幅隐藏（过期错误态清除）', t4r.bannerHidden === true, 'hidden=' + t4r.bannerHidden);

  // ---------- 全程无页面异常 ----------
  check('全程 pageerror = 0', pageErrors.length === 0, pageErrors.join(' || ') || '无');
} finally {
  await browser.close();
}
console.log(failed === 0 ? '\n== G06 全部通过 ==' : `\n== G06 失败 ${failed} 项 ==`);
process.exit(failed === 0 ? 0 : 1);
