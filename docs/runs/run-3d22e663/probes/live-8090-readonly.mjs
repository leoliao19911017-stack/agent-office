// live-8090-readonly.mjs —— 只读核对线上 8090：「新前端 + 旧后端」这段时间里看板是什么样。
//
// 只发 GET（和老板自己打开看板完全一样）：不建任务、不归档、不删除、不重启。
// 看板静态文件每次请求从磁盘读，所以改完 web/board-cromma.* 线上界面立刻是新的；
// 而 web/api-tasks.mjs 要重启才换。这个探针核对的就是这个窗口：
//   · 线上 /api/tasks 的响应里有没有 api_features（没有 = 服务端进程还是旧代码）；
//   · 旧后端下，「回收站」必须禁用并在悬停提示里说明原因，「停止」不许是可点的；
//   · 页面不许抛未捕获异常。
//
// 运行：node --no-warnings docs/runs/run-3d22e663/probes/live-8090-readonly.mjs [baseurl] [输出目录]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const BASE = process.argv[2] || 'http://127.0.0.1:8090';
const OUT = process.argv[3] || 'docs/runs/run-3d22e663/rework-evidence';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
mkdirSync(OUT, { recursive: true });

const tasksRes = await fetch(`${BASE}/api/tasks`, { headers: { accept: 'application/json' } });
const tasksJson = await tasksRes.json();
const html = await (await fetch(`${BASE}/board-cromma.html`)).text();
const js = await (await fetch(`${BASE}/board-cromma.js`)).text();

const evidence = {
  at: new Date().toISOString(),
  base: BASE,
  // 只读统计：线上任务的状态分布（不看内容）
  tasks: {
    status: tasksRes.status,
    count: tasksJson.count,
    byStatus: (tasksJson.tasks || []).reduce((m, t) => { m[t.status] = (m[t.status] || 0) + 1; return m; }, {}),
    withActiveAttempt: (tasksJson.tasks || []).filter((t) => t.active_attempt_id).length,
  },
  backend: {
    hasApiFeatures: Object.hasOwn(tasksJson, 'api_features'),
    apiFeatures: tasksJson.api_features ?? null,
    hasOnlyDeletedEcho: Object.hasOwn(tasksJson, 'only_deleted'),
    verdict: Object.hasOwn(tasksJson, 'api_features') ? '新代码（进程在返工之后重启过）' : '旧代码（进程还没重启：响应里没有 api_features）',
  },
  frontend: {
    htmlHasTrashToggle: html.includes('task-trash-toggle'),
    jsHasStopHandler: js.includes('runStopAction'),
    jsReadsApiFeatures: js.includes('api_features'),
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
  // 保险：这个探针只许发 GET。看板自己只会发 GET；万一发了写请求，记录下来（不拦截线上行为，但报告里要说）。
  page.on('request', (r) => { if (r.method() !== 'GET' && r.method() !== 'HEAD') writes.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  await page.goto(`${BASE}/board-cromma.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const list = document.querySelector('#task-list');
    return Boolean(list && (list.querySelector('.task-line') || list.querySelector('.task-empty')));
  }, null, { timeout: 20000 });
  await page.waitForTimeout(800);
  const trash = page.locator('#task-trash-toggle');
  evidence.board = {
    rows: await page.locator('#task-list .task-line').count(),
    trashToggle: {
      present: await trash.count(),
      disabled: await trash.isDisabled(),
      text: (await trash.textContent()).trim(),
      title: await trash.getAttribute('title'),
    },
    stopButtons: {
      total: await page.locator('#task-list [data-act="stop"]').count(),
      enabled: await page.locator('#task-list [data-act="stop"]:not([disabled])').count(),
    },
    archToggleDisabled: await page.locator('#task-archived-toggle').isDisabled(),
    errors,
    nonGetRequests: writes,
  };
  if (evidence.board.rows > 0) {
    await page.screenshot({ path: join(OUT, '16-live-8090-board-1440x900@2x.png') });
    await page.screenshot({ path: join(OUT, '16-live-8090-rail-2x.png'), clip: { x: 0, y: 0, width: 272, height: 900 } });
  }
  await ctx.close();
} finally {
  await browser.close();
}
writeFileSync(join(OUT, 'live-8090-readonly.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
