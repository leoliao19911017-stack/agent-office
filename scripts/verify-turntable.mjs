// verify-turntable.mjs — 第二批（中央转盘）真跑验收。
//
// 只读真实 API + 真实浏览器：
//   · /api/tool-events 的 by_agent / tools / rate_15m
//   · /api/agents/status-v2 的启用 Agent 数
//   · /api/tasks 的 done/total（液位必须等于它）
// 逐项断言：转盘扇区数、中心选中、左弧工具计数、真实刻度、CSS 动效、图标 viewBox、
// 没有采集时的「工具数据采集中」占位、三种分辨率不重叠不溢出。
//
// 用法：node scripts/verify-turntable.mjs
// 输出：docs/evidence/turntable/acceptance.json + 截图 + 终端 PASS/FAIL。

import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = process.env.BOARD_URL || 'http://127.0.0.1:8090';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = resolve('docs/evidence/turntable');
mkdirSync(OUT, { recursive: true });

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  · ${JSON.stringify(detail)}`}`);
}
function parseCount(text) {
  return Number(String(text).replace(/[^0-9]/g, '')) || 0;
}

const api = await (await fetch(`${BASE}/api/tool-events?recent=200&tools=30`)).json();
const status = await (await fetch(`${BASE}/api/agents/status-v2`)).json();
const tasks = await (await fetch(`${BASE}/api/tasks`)).json();
const enabled = (status.agents || []).length;
const maxAgent = Math.max(0, ...(api.by_agent || []).map((a) => Number(a.count) || 0));
const done = (tasks.tasks || []).reduce((n, t) => n + (Number(t.progress?.done) || 0), 0);
const total = (tasks.tasks || []).reduce((n, t) => n + (Number(t.progress?.total) || 0), 0);
const progressPct = total > 0 ? Math.round((done / total) * 100) : 0;
const claudeCount = Number((api.by_agent || []).find((a) => a.agent_id === 'claude')?.count) || 0;
const claudeBash = Number((api.tools || []).find((t) => String(t.tool_name).toLowerCase() === 'bash')?.agents?.claude) || 0;

check('API /api/tool-events 200 且已采集', api.ok === true && api.collecting === false, {
  total_all: api.total_all, last_run_at: api.last_run_at,
});
check('API 有 Claude/DSH 真实工具事件', claudeCount > 0 && Number((api.by_agent || []).find((a) => a.agent_id === 'dsh')?.count) > 0, api.by_agent);
check('API 15 分钟桶是 15 个', (api.rate_15m?.buckets || []).length === 15);
check('API 聚合不带 raw_json', (api.tools || []).every((t) => t.recent.every((r) => !('raw_json' in r))));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await ctx.addInitScript(() => { try { localStorage.clear(); } catch { /* 无视 */ } });
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
await page.goto(`${BASE}/board-cromma.html`, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForFunction(() => document.querySelectorAll('.tt-node').length > 0, { timeout: 20000 });
await page.waitForTimeout(900);

const main = await page.evaluate(() => {
  const rect = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
  };
  const centerText = document.querySelector('#tt-center')?.innerText || '';
  const toolsText = document.querySelector('#tt-tools')?.innerText || '';
  const flowText = document.querySelector('#tt-flow')?.innerText || '';
  const icon = document.querySelector('#tt-center .agent-icon svg');
  const centerIcon = icon ? {
    vb: icon.getAttribute('viewBox'),
    fill: icon.querySelector('path')?.getAttribute('fill') || null,
    color: getComputedStyle(icon).color,
    rect: icon.getBoundingClientRect().toJSON(),
  } : null;
  const selectedCircle = document.querySelector('.tt-node.is-selected circle');
  const codeLine = document.querySelector('.tt-code__line');
  const pipe = document.querySelector('.tt-pipe__flow');
  return {
    nodes: document.querySelectorAll('.tt-node').length,
    sectors: document.querySelectorAll('.tt-sector').length,
    scaleTitle: document.querySelector('.tt-scale-title')?.textContent || '',
    scaleLabels: [...document.querySelectorAll('.tt-scale-label')].map((e) => e.textContent),
    centerText,
    toolsText,
    flowText,
    toolGroups: document.querySelectorAll('.tt-tool').length,
    codeLines: document.querySelectorAll('.tt-code__line').length,
    rateText: document.querySelector('#tool-rate')?.innerText || '',
    panelL: rect('#tt-tools'), panelR: rect('#tt-flow'), center: rect('#tt-center'),
    turntable: rect('.turntable'),
    docOverflow: document.documentElement.scrollWidth > innerWidth,
    icon: centerIcon,
    anim: {
      tick: getComputedStyle(document.querySelector('.tt-tickrail')).animationName,
      pipe: pipe ? getComputedStyle(pipe).animationName : null,
      codeLine: codeLine ? getComputedStyle(codeLine).animationName : null,
      cursor: getComputedStyle(document.querySelector('.tt-cursor')).animationName,
      selected: selectedCircle ? getComputedStyle(selectedCircle).animationName : null,
    },
  };
});

check('转盘扇区数 = 启用 Agent 数', main.sectors === enabled, { sectors: main.sectors, enabled });
check('转盘 Agent 节点数 = 启用 Agent 数', main.nodes === enabled, { nodes: main.nodes, enabled });
check('中心默认选中 Claude 且工具数 = API by_agent', /Claude Code/.test(main.centerText) && main.centerText.includes(`×${claudeCount.toLocaleString('en-US')}`), {
  center: main.centerText.replace(/\n/g, ' | '), api: claudeCount,
});
check('真实刻度标题 = max(by_agent)', main.scaleTitle.replace(/,/g, '').includes(`0–${maxAgent}`) || main.scaleTitle.replace(/,/g, '').includes(`0-${maxAgent}`), {
  title: main.scaleTitle, maxAgent,
});
check('左弧 BASH 次数 = API 里 Claude 的 Bash 次数', claudeBash > 0 && main.toolsText.includes(`×${claudeBash}`), { claudeBash });
check('左弧有工具分组与最近内容', main.toolGroups >= 1 && /最近调用/.test(main.toolsText), { groups: main.toolGroups, codeLines: main.codeLines });
check('液位 = 任务真实 done/total', main.flowText.includes(`${progressPct}%`) && main.flowText.includes(`${done} / ${total} 步`), {
  pct: progressPct, done, total, flow: main.flowText.replace(/\n/g, ' | '),
});
check('15 分钟调用率来自真实 buckets', /次 \/ 最近 15 分钟/.test(main.rateText), { rate: main.rateText.replace(/\n/g, ' | ') });
check('CSS 动效：刻度旋转 / 管道 dashoffset / 代码淡入 / 光标闪烁 / 选中脉冲',
  main.anim.tick === 'tt-tick-spin' && main.anim.pipe === 'tt-dash' && main.anim.codeLine === 'tt-line-in'
  && main.anim.cursor === 'tt-blink' && main.anim.selected === 'tt-node-pulse', main.anim);
check('Claude 中心图标是官方橙色星芒（#D97757）', main.icon?.vb === '0 0 248 248' && main.icon?.fill === '#D97757', main.icon);
check('两侧面板与中心文字不重叠', main.panelL.right < main.center.x && main.center.right < main.panelR.x, {
  panelL: main.panelL, center: main.center, panelR: main.panelR,
});
check('页面无横向溢出', main.docOverflow === false);
check('浏览器控制台无错误', consoleErrors.length === 0, consoleErrors);

// Hermes 中心图标：单色剪影（currentColor），viewBox 是官方 catalog-wing 的比例
await page.locator('.tt-node[data-agent="hermes"]').click();
await page.waitForTimeout(500);
const hermes = await page.evaluate(() => {
  const icon = document.querySelector('#tt-center .agent-icon svg');
  return {
    center: document.querySelector('#tt-center')?.innerText || '',
    vb: icon?.getAttribute('viewBox') || null,
    fill: icon?.querySelector('path')?.getAttribute('fill') || null,
    color: icon ? getComputedStyle(icon).color : null,
    rect: icon?.getBoundingClientRect().toJSON() || null,
  };
});
check('Hermes 中心图标是单色翅膀剪影（currentColor + catalog-wing viewBox）',
  /Hermes/.test(hermes.center) && hermes.vb === '0 0 39.1 78.5' && hermes.fill === 'currentColor' && hermes.color === 'rgb(58, 52, 43)', hermes);
await page.evaluate(() => document.querySelector('#toast')?.classList.remove('is-show'));
await page.waitForTimeout(200);
await page.screenshot({ path: resolve(OUT, 'turntable-hermes-1440x900.png') });

// 没有工具事件的 Agent：不空白、不冒充，左弧写明「显示全部」
await page.locator('.tt-node[data-agent="codex"]').click();
await page.waitForTimeout(400);
const codex = await page.evaluate(() => ({
  center: document.querySelector('#tt-center')?.innerText || '',
  tools: document.querySelector('#tt-tools')?.innerText || '',
}));
check('Codex 无工具事件时，左弧明说并显示全部真实采集', /全部 Agent/.test(codex.tools) && /这个 Agent 没有工具事件/.test(codex.tools), {
  tools: codex.tools.slice(0, 120),
});
await page.locator('.tt-node[data-agent="claude"]').click();
await page.waitForTimeout(300);
await page.evaluate(() => document.querySelector('#toast')?.classList.remove('is-show'));

// 多分辨率：截整页 + 检查面板/中心不重叠、无横向溢出
const viewports = [[1440, 900], [1280, 800], [1936, 1056]];
const responsive = [];
for (const [w, h] of viewports) {
  await page.setViewportSize({ width: w, height: h });
  await page.waitForTimeout(500);
  const m = await page.evaluate(() => {
    const rr = (sel) => {
      const r = document.querySelector(sel)?.getBoundingClientRect();
      return r ? { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom } : null;
    };
    return {
      panelL: rr('#tt-tools'), panelR: rr('#tt-flow'), center: rr('#tt-center'),
      overflow: document.documentElement.scrollWidth > innerWidth,
      centerName: document.querySelector('#tt-center__name')?.textContent || document.querySelector('.tt-center__id b')?.textContent || '',
    };
  });
  const overlap = m.panelL && m.center && m.panelR
    ? !(m.panelL.right < m.center.x && m.center.right < m.panelR.x) : true;
  responsive.push({ viewport: `${w}x${h}`, overlap, overflow: m.overflow });
  check(`${w}x${h}：面板不压中心、无横向溢出`, overlap === false && m.overflow === false, { overlap, overflow: m.overflow });
  await page.evaluate(() => document.querySelector('#toast')?.classList.remove('is-show'));
  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(OUT, `turntable-${w}x${h}.png`) });
}

// 「采集还没跑」：拦截 API 返回 collecting，左弧必须是占位，不出现假数字
const emptyPage = await ctx.newPage();
await emptyPage.route('**/api/tool-events**', async (route) => {
  if (route.request().method() !== 'GET') return route.continue();
  await route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, collecting: true, collected: false, last_run_at: null, total: 0, total_all: 0, by_agent: [], tools: [], recent: [], recent_by_agent: {}, rate_15m: { total: 0, buckets: [] } }),
  });
});
await emptyPage.goto(`${BASE}/board-cromma.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await emptyPage.waitForTimeout(1200);
const empty = await emptyPage.evaluate(() => ({
  tools: document.querySelector('#tt-tools')?.innerText || '',
  toolGroups: document.querySelectorAll('.tt-tool').length,
  scaleTitle: document.querySelector('.tt-scale-title')?.textContent || '',
  nodeCounts: [...document.querySelectorAll('.tt-node__count')].map((e) => e.textContent),
  center: document.querySelector('#tt-center')?.innerText || '',
  rate: document.querySelector('#tool-rate')?.innerText || '',
  flow: document.querySelector('#tt-flow')?.innerText || '',
}));
check('采集未跑：左弧显示「工具数据采集中」且不画工具数字',
  /工具数据采集中/.test(empty.tools) && empty.toolGroups === 0 && empty.scaleTitle.includes('未采集')
  && empty.nodeCounts.every((x) => x === '待采集'), empty);
check('采集未跑：中心与 15 分钟卡不把未知写成 0',
  /工具 待采集/.test(empty.center) && /没有数字/.test(empty.rate) && /工具事件[\s\S]*—/.test(empty.flow), {
    center: empty.center.replace(/\n/g, ' | '), rate: empty.rate, flow: empty.flow.replace(/\n/g, ' | '),
  });
await emptyPage.screenshot({ path: resolve(OUT, 'turntable-collecting-1440x900.png') });
await emptyPage.close();

const passed = checks.filter((c) => c.ok).length;
const result = {
  ok: passed === checks.length,
  generated_at: new Date().toISOString(),
  base: BASE,
  summary: { passed, total: checks.length },
  api: { total_all: api.total_all, by_agent: api.by_agent, max_agent_count: api.max_agent_count, last_run_at: api.last_run_at },
  tasks: { done, total, progress_pct: progressPct },
  viewports: responsive,
  checks,
};
writeFileSync(resolve(OUT, 'acceptance.json'), JSON.stringify(result, null, 2), 'utf8');
console.log(`\n${result.ok ? 'ALL PASS' : 'FAILED'}  ${passed}/${checks.length}`);
await browser.close();
process.exit(result.ok ? 0 : 1);
