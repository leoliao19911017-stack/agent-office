// TASK-交接包 验收 H1-H5 + API + UI（H6 由新 Agent 单独回答，见 h6-prompt.md）
// 跑法：node scripts/verify-handoff.mjs
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const BASE = process.env.BOARD_BASE || 'http://127.0.0.1:8090';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = resolve('docs/evidence/handoff');
mkdirSync(OUT, { recursive: true });

const THREAD_TASK = process.env.HANDOFF_THREAD || 'th-f17dcdf611';   // dsh 真会话，已关联额度任务
const THREAD_FAIL = process.env.HANDOFF_FAIL_THREAD || 'th-d066754db6'; // claude 真会话，有一轮 529 失败
const TASK_ID = process.env.HANDOFF_TASK || 't-20261124022821-85c2cb';
const DB = resolve('data/agent-office.db');

const checks = [];
const failures = [];
function check(id, name, ok, detail = '') {
  checks.push({ id, name, ok, detail });
  if (!ok) failures.push(`${id} ${name}：${detail}`);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function get(path) {
  const res = await fetch(BASE + path, { headers: { accept: 'application/json' } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 保留 null */ }
  return { status: res.status, json, text };
}
async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 保留 null */ }
  return { status: res.status, json, text };
}

function git(args) {
  return execFileSync('git', args, { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
}
function parseAcceptance(v) {
  if (v == null || v === '') return [];
  try { const p = JSON.parse(v); if (Array.isArray(p)) return p.map(String); } catch { /* 按分隔符 */ }
  return String(v).split(/\n|,|，|；|;/).map((s) => s.trim()).filter(Boolean);
}

// ---------- H1 对真实 thread 生成，六板块都有内容 ----------
const r1 = await post('/api/handoffs', { thread_id: THREAD_TASK, to_agent_id: 'claude' });
const h1 = r1.json && r1.json.handoff;
check('H1', 'POST /api/handoffs 对真实 thread 生成成功', r1.status === 201 && Boolean(h1 && h1.handoff_id), `${r1.status} ${h1 && h1.handoff_id}`);
if (h1) {
  const md = r1.json.markdown || '';
  const sections = {
    task: Boolean(h1.task && h1.task.title && h1.task.task_id),
    progress: Array.isArray(h1.progress?.done) && h1.progress.done.length > 0,
    workspace: Boolean(h1.workspace && h1.workspace.branch && h1.workspace.head_commit),
    attempts: Array.isArray(h1.attempts) && h1.attempts.length > 0,
    dead_ends: Array.isArray(h1.dead_ends) && h1.dead_ends.length > 0,
    next_action: Boolean(h1.next_action),
  };
  check('H1', '六个板块都有内容', Object.values(sections).every(Boolean), JSON.stringify(sections));
  check('H1', '真实 thread 有 provider_session_id 且 catchup 原文已落盘',
    Boolean(h1.from.session_id) && Boolean(h1.artifacts.session_transcript) && existsSync(h1.artifacts.session_transcript),
    `session=${h1.from.session_id} transcript=${h1.artifacts.session_transcript}`);
  check('H1', '输出 JSON + Markdown 两个文件', existsSync(r1.json.json_path) && existsSync(r1.json.markdown_path), `${r1.json.json_path} / ${r1.json.markdown_path}`);
  check('H1', 'Markdown 含 8 个小节标题', ['## 1. 任务', '## 2. 做到哪了', '## 3. 代码现场', '## 4. 试过什么', '## 5. 坑 / 死路', '## 6. 下一步', '## 7. 未决问题', '## 8. 产物与证据'].every((x) => md.includes(x)), '');
}

// ---------- H2 workspace 与实际 git 一致 ----------
if (h1) {
  const w = h1.workspace;
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const head = git(['rev-parse', 'HEAD']);
  const status = git(['--no-optional-locks', 'status', '--porcelain=v1', '-uall']).split(/\r?\n/).filter(Boolean);
  const listed = new Set(w.uncommitted);
  const currentOnly = status.filter((x) => !listed.has(x));
  const missing = [...listed].filter((x) => !status.includes(x));
  const newFiles = currentOnly.filter((x) => x.includes('docs/handoffs/'));
  const onlyHandoffs = currentOnly.every((x) => x.includes('docs/handoffs/'));
  check('H2', 'branch 与实际 git 一致', w.branch === branch, `${w.branch} vs ${branch}`);
  check('H2', 'HEAD 与实际 git 一致', w.head_commit_full === head, `${w.head_commit_full} vs ${head}`);
  // 列表超过 80 条会截断；此时只要求已经列出的每条都还在当前 status 里，
  // 并且 currentOnly 里多出来的只能是本次生成后新出现的 docs/handoffs/*。
  check('H2', 'uncommitted 列出的每条都还在实际 git status 里，新增的只有 handoff 文件',
    missing.length === 0 && (w.uncommitted_truncated || onlyHandoffs),
    `missing=${missing.length} currentOnly=${currentOnly.length} newHandoffs=${newFiles.length}${w.uncommitted_truncated ? '（已截断）' : ''}`);
  check('H2', 'uncommitted_count 与生成时刻实际数量一致',
    w.uncommitted_count === status.length - newFiles.length,
    `${w.uncommitted_count} vs ${status.length} - ${newFiles.length}`);
  check('H2', '超长未提交列表标了 truncated', w.uncommitted_truncated === (w.uncommitted_count > w.uncommitted.length),
    `count=${w.uncommitted_count} listed=${w.uncommitted.length} truncated=${w.uncommitted_truncated}`);
}

// ---------- H3 task 信息与 DB 一致 ----------
if (h1) {
  const db = new DatabaseSync(DB, { readOnly: true });
  try {
    const row = db.prepare('SELECT task_id,title,acceptance,status FROM tasks WHERE task_id=?').get(TASK_ID);
    const dbAccept = parseAcceptance(row && row.acceptance);
    const sameAccept = JSON.stringify(dbAccept) === JSON.stringify(h1.task.acceptance);
    check('H3', 'task_id / title 与 tasks 表一致',
      h1.task.task_id === TASK_ID && row && h1.task.title === row.title,
      `${h1.task.task_id} / ${h1.task.title}`);
    check('H3', 'acceptance 与 tasks 表一致', sameAccept, `DB=${dbAccept.length} 项，handoff=${h1.task.acceptance.length} 项`);
    check('H3', 'task_doc 指向真实任务书文件', Boolean(h1.task.task_doc) && existsSync(h1.task.task_doc), h1.task.task_doc);
  } finally { db.close(); }
}

// ---------- H4 attempts 来自真实失败记录 ----------
const r4 = await post('/api/handoffs', { thread_id: THREAD_FAIL, to_agent_id: 'dsh', reason: 'rate_limited' });
const h4 = r4.json && r4.json.handoff;
if (h4) {
  const db = new DatabaseSync(DB, { readOnly: true });
  try {
    const turns = db.prepare('SELECT turn_id,status,started_at,error_json FROM chat_turns WHERE thread_id=?').all(THREAD_FAIL);
    const failed = turns.filter((t) => ['failed', 'interrupted', 'rate_limited'].includes(t.status));
    const matched = (h4.attempts || []).filter((a) => a.source === 'chat_turns' && failed.some((t) => t.started_at === a.at_iso && t.status === a.result));
    check('H4', '失败 attempts 来自 chat_turns 真记录', matched.length > 0, `DB 失败轮次 ${failed.length} 条，交接包匹配 ${matched.length} 条`);
    check('H4', '失败原因带真实错误文本', (h4.attempts || []).some((a) => /529|限流|失败|error/i.test(String(a.why || ''))), (h4.attempts?.[0]?.why || '').slice(0, 100));
    check('H4', '死路里有 [对话] 来源标记', (h4.dead_ends || []).some((x) => x.startsWith('[对话]')), (h4.dead_ends || []).join(' | ').slice(0, 160));
  } finally { db.close(); }
} else {
  check('H4', '失败 thread 生成交接包', false, `${r4.status}`);
}

// ---------- H5 Markdown 人能读 ----------
if (h1) {
  const md = r1.json.markdown || '';
  const bad = [];
  if (md.length < 1500) bad.push(`太短 ${md.length}`);
  if (/^\s*\{/m.test(md)) bad.push('像 JSON dump');
  if (md.includes('undefined') || md.includes('[object Object]') || md.includes('�')) bad.push('有 undefined/[object Object]/乱码');
  if (!md.includes('**接手先看这一句：**')) bad.push('缺少接手摘要');
  if (!/- \*\*\d\d:\d\d\*\*/.test(md)) bad.push('attempts 没有渲染成可读条目');
  if (!/分支：`p0-foundation`/.test(md)) bad.push('缺少分支');
  check('H5', 'Markdown 可读（非 JSON dump、无乱码/undefined）', bad.length === 0, bad.join('；') || `${md.length} 字，8 节`);
  writeFileSync(join(OUT, 'handoff-sample.md'), md, 'utf8');
}

// ---------- API 列表 / 读取 / 错误码 ----------
const list = await get('/api/handoffs');
check('API', 'GET /api/handoffs 列表', list.status === 200 && list.json && list.json.count >= 2, `count=${list.json && list.json.count}`);
const oneId = h1 && h1.handoff_id;
if (oneId) {
  const one = await get(`/api/handoffs/${oneId}`);
  check('API', 'GET /api/handoffs/:id 返回 JSON + Markdown',
    one.status === 200 && one.json.handoff.handoff_id === oneId && one.json.markdown.length > 0,
    `${one.status} md=${one.json && one.json.markdown ? one.json.markdown.length : 0}`);
  check('API', 'GET 返回的 Markdown 与落盘文件一致',
    one.json.markdown === readFileSync(join('docs/handoffs', `${oneId}.md`), 'utf8'), '');
}
const bad = await get('/api/handoffs/not-an-id');
check('API', '非法 id 被拒', bad.status === 400 || bad.status === 404, `${bad.status} ${bad.json && bad.json.code}`);
const missing = await post('/api/handoffs', {});
check('API', '缺 thread_id/task_id 返回 400', missing.status === 400 && missing.json && missing.json.code === 'MISSING_INPUT', `${missing.status} ${missing.json && missing.json.code}`);

// ---------- UI：对话面板顶部按钮 -> 生成 -> 复制/下载/关闭 ----------
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
try { await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE }); } catch { /* 允许失败，后面用 toast 判定 */ }
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`console: ${m.text()}`); });
await page.goto(`${BASE}/board-cromma.html#board`, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForFunction(() => document.querySelector('#stat-tasks')?.textContent !== '—', { timeout: 20000 });
await page.click('.agent-card[data-agent="dsh"]');
await page.waitForSelector('.cbtn--handoff', { timeout: 15000 });
check('UI', '对话面板顶部有「交接包」按钮', (await page.locator('.cbtn--handoff').count()) === 1, '');
const beforeToast = await page.evaluate(() => Number(document.querySelector('#toast')?.dataset.count || 0));
await page.click('.cbtn--handoff');
await page.waitForSelector('.handoff:not([hidden])', { timeout: 10000 });
await page.waitForFunction(() => {
  const el = document.querySelector('.handoff__preview');
  return el && el.textContent.includes('## 1. 任务');
}, { timeout: 60000 });
const ui = await page.evaluate(() => {
  const panel = document.querySelector('.handoff');
  const preview = document.querySelector('.handoff__preview');
  const sizes = [...panel.querySelectorAll('*')]
    .filter((el) => (el.textContent || '').trim())
    .map((el) => parseFloat(getComputedStyle(el).fontSize))
    .filter((n) => Number.isFinite(n));
  return {
    preview: preview.textContent,
    buttons: [...panel.querySelectorAll('button')].map((b) => b.textContent.trim()),
    minFont: sizes.length ? Math.min(...sizes) : null,
    panelText: panel.innerText.replace(/\s+/g, ' ').slice(0, 300),
  };
});
check('UI', '面板里能看到交接包 Markdown', /## 1\. 任务/.test(ui.preview) && /## 6\. 下一步/.test(ui.preview), ui.panelText.slice(0, 140));
check('UI', '面板有复制 + 下载 .md + 下载 .json', ['复制 Markdown', '下载 .md', '下载 .json'].every((x) => ui.buttons.some((b) => b.includes(x.replace(' Markdown', ' Markdown')))), ui.buttons.join(' / '));
check('UI', '面板字号 >= 11px', ui.minFont >= 11, `min=${ui.minFont}px`);
check('UI', 'Markdown 预览无乱码/undefined', !ui.preview.includes('�') && !ui.preview.includes('undefined'), '');
await page.screenshot({ path: join(OUT, 'handoff-panel-1440x900.png'), fullPage: false });

// 复制按钮：点击后 toast 必须出现「复制」或「剪贴板」反馈
const beforeCopy = await page.evaluate(() => Number(document.querySelector('#toast')?.dataset.count || 0));
await page.click('[data-act="copy-handoff"]');
await page.waitForFunction((n) => {
  const el = document.querySelector('#toast');
  return Number(el?.dataset.count || 0) > n && /复制|剪贴板/.test(el?.textContent || '');
}, beforeCopy, { timeout: 10000 });
const copyToast = await page.evaluate(() => document.querySelector('#toast')?.textContent || '');
check('UI', '复制按钮有反馈', /复制|剪贴板/.test(copyToast), copyToast);

// 下载 .md：Playwright 捕获真实 download 事件
const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 15000 }),
  page.click('[data-act="download-handoff"]'),
]);
const downloadedPath = join(OUT, 'downloaded-handoff.md');
await download.saveAs(downloadedPath);
const downloaded = readFileSync(downloadedPath, 'utf8');
check('UI', '下载 .md 真的落文件且内容完整', downloaded.includes('## 1. 任务') && downloaded.includes('## 8. 产物与证据'), `${downloaded.length} 字 -> ${downloadedPath}`);

// 关闭按钮
await page.click('[data-act="close-handoff"]');
await page.waitForFunction(() => document.querySelector('.handoff')?.hidden === true, { timeout: 5000 });
check('UI', '关闭按钮能收起面板', true, '');
check('UI', '页面无 JS 报错', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 200));
await browser.close();

// ---------- H6 交接给新 Agent 的题面（回答单独落 h6-answer.md） ----------
if (h1) {
  const prompt = `你是刚接手这个任务的新 Agent。你只拿到下面这一份交接包，没有别的上下文。\n\n请回答三个问题，只根据交接包，不要编造：\n1. 这个任务做到哪了？\n2. 下一步是什么？\n3. 有哪些已知死路 / 未决问题？\n\n---\n\n${r1.json.markdown}\n`;
  writeFileSync(join(OUT, 'h6-prompt.md'), prompt, 'utf8');
  check('H6', '新 Agent 题面已生成（待独立 Agent 回答）', true, 'docs/evidence/handoff/h6-prompt.md');
}

const report = {
  generatedAt: new Date().toISOString(),
  base: BASE,
  threads: { task: THREAD_TASK, fail: THREAD_FAIL },
  task: TASK_ID,
  handoffs: {
    h1: h1 && { handoff_id: h1.handoff_id, json_path: r1.json.json_path, markdown_path: r1.json.markdown_path, session: h1.artifacts.session_transcript },
    h4: h4 && { handoff_id: h4.handoff_id, json_path: r4.json.json_path, markdown_path: r4.json.markdown_path },
  },
  checks,
  failures,
  screenshots: ['docs/evidence/handoff/handoff-panel-1440x900.png'],
  pass: failures.length === 0,
};
writeFileSync(join(OUT, 'verify-handoff.json'), JSON.stringify(report, null, 2));
writeFileSync(join(OUT, 'h1-handoff.json'), JSON.stringify(h1, null, 2));
writeFileSync(join(OUT, 'h4-handoff.json'), JSON.stringify(h4, null, 2));

console.log(`\n=== 交接包验收 ${failures.length ? 'FAIL' : 'PASS'} ===`);
console.log(`检查项 ${checks.length}，失败 ${failures.length}`);
if (failures.length) console.log(failures.join('\n'));
console.log(`证据：${OUT}`);
process.exit(failures.length ? 1 : 0);
