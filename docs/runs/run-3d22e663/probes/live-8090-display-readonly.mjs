// live-8090-display-readonly.mjs —— 只读核对线上 8090 看板的「显示层」现状（第二轮追问：D1–D5）。
//
// 只发 GET（和老板自己打开看板完全一样）：不建任务、不归档、不删除、不重启、不点任何写操作按钮。
// 核对的是用户报的四个现象在线上还在不在：
//   1. 库里 completed 的任务，接口 / 界面显示成什么（idle 还是 completed）；
//   2. 任务行的进度是 0/1 还是 1/1；
//   3. 筛选条每个分类的计数（有没有「完成」「空闲」，各分类之和是不是等于「全部」）；
//   4. 工作流下拉里有没有已归档的 run（接口有没有带 archived_at）。
//
// 前端文件是从磁盘读的（一改就是新的），后端要重启才换——所以线上可能是「新前端 + 旧后端」，
// 这个脚本把两边各自是哪一版也记下来。
//
// 运行：node --no-warnings docs/runs/run-3d22e663/probes/live-8090-display-readonly.mjs [baseurl] [输出目录]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const BASE = process.argv[2] || 'http://127.0.0.1:8090';
const OUT = process.argv[3] || 'docs/runs/run-3d22e663/rework-evidence/display-live';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
mkdirSync(OUT, { recursive: true });

const getJson = async (path) => {
  const res = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } });
  return { status: res.status, json: await res.json() };
};
const tasks = await getJson('/api/tasks');
const runs = await getJson('/api/workflow/runs');
const html = await (await fetch(`${BASE}/board-cromma.html`)).text();
const js = await (await fetch(`${BASE}/board-cromma.js`)).text();

const evidence = {
  at: new Date().toISOString(),
  base: BASE,
  backend: {
    // 第一轮返工的后端会带 api_features；第二轮（显示层）的后端会带 archived_at
    hasApiFeatures: Object.hasOwn(tasks.json, 'api_features'),
    runListHasArchivedAt: (runs.json.runs || []).length === 0 || Object.hasOwn(runs.json.runs[0], 'archived_at'),
    verdict: !Object.hasOwn(tasks.json, 'api_features')
      ? '返工之前的代码'
      : (runs.json.runs || []).length === 0 || Object.hasOwn(runs.json.runs[0], 'archived_at')
        ? '第二轮（显示层）的代码'
        : '第一轮返工的代码（还没有第二轮的后端改动：completed→idle、进度、archived_at 都还在）',
  },
  frontend: {
    hasCompletedFilter: html.includes('data-filter="completed"'),
    hasIdleFilter: html.includes('data-filter="idle"'),
    jsHasTaskBuckets: js.includes('TASK_BUCKETS'),
    jsFiltersArchivedRuns: js.includes('archived_at'),
  },
  api: {
    tasksStatus: tasks.status,
    count: tasks.json.count,
    // 只读统计：接口返回的状态分布、进度分布（不看内容）
    byStatus: (tasks.json.tasks || []).reduce((m, t) => { m[t.status] = (m[t.status] || 0) + 1; return m; }, {}),
    byProgress: (tasks.json.tasks || []).reduce((m, t) => { const k = `${t.progress?.done}/${t.progress?.total}`; m[k] = (m[k] || 0) + 1; return m; }, {}),
    sampleReason: tasks.json.tasks && tasks.json.tasks[0] ? tasks.json.tasks[0].status_reason : null,
    runCount: runs.json.count,
    archivedRunsInApi: (runs.json.runs || []).filter((r) => r.archived_at).length,
  },
};

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  const writes = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text().slice(0, 200)}`); });
  page.on('request', (r) => { if (r.method() !== 'GET' && r.method() !== 'HEAD') writes.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  await page.goto(`${BASE}/board-cromma.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const list = document.querySelector('#task-list');
    return Boolean(list && (list.querySelector('.task-line') || list.querySelector('.task-empty')));
  }, null, { timeout: 20000 });
  await page.waitForFunction(() => [...document.querySelectorAll('#task-filters .filter b')].every((b) => b.textContent !== '—'), null, { timeout: 15000 }).catch(() => { /* 读不到计数就照实记 '—' */ });
  await page.waitForTimeout(800);
  evidence.board = {
    rows: await page.locator('#task-list .task-line').count(),
    filterCounts: await page.locator('#task-filters .filter').evaluateAll((els) => Object.fromEntries(
      els.map((el) => [el.dataset.filter, el.querySelector('b')?.textContent ?? null]),
    )),
    rowProgress: [...new Set(await page.locator('#task-list .task-row__prog').evaluateAll((els) => els.map((e) => e.textContent.trim())))],
    rowStatusTitles: [...new Set(await page.locator('#task-list .task-row').evaluateAll((els) => els.map((e) => (e.getAttribute('title') || '').split(' · ').slice(-2, -1)[0])))],
    runOptions: await page.locator('#task-run-select option').evaluateAll((els) => els.map((o) => ({ value: o.value, text: o.textContent.trim() }))),
    errors,
    nonGetRequests: writes,
  };
  const { all, ...specific } = evidence.board.filterCounts;
  evidence.board.specificSum = Object.values(specific).reduce((n, v) => n + (Number(v) || 0), 0);
  if (evidence.board.rows > 0) {
    await page.screenshot({ path: join(OUT, 'live-board-1440x900@2x.png') });
    await page.screenshot({ path: join(OUT, 'live-rail-2x.png'), clip: { x: 0, y: 0, width: 272, height: 900 } });
  }
  await ctx.close();
} finally {
  await browser.close();
}
writeFileSync(join(OUT, 'live-8090-display-readonly.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
