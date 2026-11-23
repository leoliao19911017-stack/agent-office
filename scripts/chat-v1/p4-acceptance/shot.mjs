// shot.mjs — 对话面板截图 / 取证小工具（P4 迭代与验收 D7 用）。
// 用法：node scripts/chat-v1/p4-acceptance/shot.mjs <out.png> [1440x900] [agentId] [--detail] [--task]
//   BOARD_URL 环境变量可指向别的实例（默认 8090 看板）
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = process.env.BOARD_URL || 'http://127.0.0.1:8090/board-cromma.html';
const [out, size, agent, ...flags] = process.argv.slice(2);
const [w, h] = (size || '1440x900').split('x').map(Number);
if (!out) { console.error('用法见文件头'); process.exit(2); }
mkdirSync(dirname(out), { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForFunction(() => document.querySelector('#stat-tasks')?.textContent !== '—', { timeout: 20000 }).catch(() => {});
if (agent) await page.click(`.agent-card[data-agent="${agent}"]`);
await page.waitForTimeout(900);
if (flags.includes('--detail')) { await page.click('.seg__item[data-tab="detail"]'); await page.waitForTimeout(300); }
if (flags.includes('--task')) { await page.click('.task-row'); await page.waitForTimeout(300); }
const metrics = await page.evaluate(() => {
  const rect = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const cs = (sel, props) => { const el = document.querySelector(sel); return el ? Object.fromEntries(props.map((p) => [p, getComputedStyle(el)[p]])) : null; };
  const body = document.querySelector('.chat__body');
  return {
    viewport: { w: innerWidth, h: innerHeight },
    side: rect('#side-panel'), chat: rect('.chat'), body: rect('.chat__body'), composer: rect('.composer'), input: rect('.composer__input'),
    state: document.querySelector('.chat__state')?.textContent,
    msgs: document.querySelectorAll('.msg').length,
    bubble: cs('.msg__bubble', ['borderRadius', 'backgroundColor', 'fontSize', 'color']),
    chatBg: cs('.chat', ['backgroundColor']),
    input: cs('.composer__input', ['fontSize', 'height', 'borderRadius']),
    composer: cs('.composer', ['borderRadius', 'borderTopLeftRadius']),
    bodyScroll: body ? { scrollHeight: body.scrollHeight, clientHeight: body.clientHeight } : null,
    inAlign: (() => { const el = document.querySelector('.msg--in .msg__bubble'); return el ? Math.round(el.getBoundingClientRect().left) : null; })(),
    outAlign: (() => { const el = document.querySelector('.msg--out .msg__bubble'); return el ? Math.round(el.getBoundingClientRect().right) : null; })(),
  };
});
await page.screenshot({ path: out });
await browser.close();
console.log(JSON.stringify({ out, errors, metrics }, null, 1));
