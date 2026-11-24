#!/usr/bin/env node
// verify-deliverables.mjs — 第一批验收 D1-D5 真跑（真 API + 真浏览器 + 真截图）。
//
//   D1 点任务，中间显示六类交付物时间线，六类都有位置
//   D2 每类交付物可点开（Markdown 渲染 / commit diff）
//   D3 没有的类别显式写「未产生」
//   D4 真实历史任务：Agent Chat P1-P7 每批都有 requirement/task_spec/dev_output/artifact/goal
//   D5 工具调用数据不在主视图，折叠在「技术细节」，默认不展开
//
// 用法：
//   node --no-warnings scripts/verify-deliverables.mjs
//   BASE_URL=http://127.0.0.1:18090 node ...   # 不打扰 8090 的测试实例
//
// 退出码：0 全过；1 有失败。结果同时落 docs/evidence/deliverables/verify-deliverables.json。

import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = (process.env.BASE_URL || 'http://127.0.0.1:8090').replace(/\/+$/, '');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT_DIR = resolve('docs/screenshots/deliverables');
const EVIDENCE_DIR = resolve('docs/evidence/deliverables');
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(EVIDENCE_DIR, { recursive: true });
const SHOT = resolve(OUT_DIR, 'agent-chat-p1-six-kinds-1440x900.png');

const checks = [];
function check(id, name, pass, detail) {
  checks.push({ id, name, pass: Boolean(pass), detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${name}${detail ? ` · ${detail}` : ''}`);
}

async function api(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 400) }; }
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status} ${data?.error || ''}`);
  return data;
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => {
  const msg = r.failure()?.errorText || '';
  if (!/ERR_ABORTED/.test(msg)) errors.push(`requestfailed: ${r.url()} ${msg}`);
});

try {
  // ---- 0. 真实任务与 API ----
  const tasksData = await api('/api/tasks');
  const agentChat = tasksData.tasks
    .filter((t) => /Agent Chat P[1-7]/.test(t.title || ''))
    .sort((a, b) => String(a.title).localeCompare(String(b.title)) || String(a.task_id).localeCompare(String(b.task_id)));
  check('D4-0', 'Agent Chat P1-P7 任务真实存在', agentChat.length >= 7,
    `${agentChat.length} 条：${agentChat.map((t) => t.title.match(/P\d/)?.[0]).join(',')}`);

  const p1 = agentChat.find((t) => /Agent Chat P1/.test(t.title));
  if (!p1) throw new Error('找不到 Agent Chat P1 任务');
  const p1Deliverables = await api(`/api/deliverables?task_id=${encodeURIComponent(p1.task_id)}`);
  const p1Kinds = ['requirement', 'task_spec', 'dev_output', 'artifact', 'review', 'retro'];
  check('D1-API', 'P1 交付物 API 返回六类分组', p1Kinds.every((k) => Array.isArray(p1Deliverables.groups[k])),
    p1Kinds.map((k) => `${k}:${p1Deliverables.groups[k].length}`).join(' '));
  check('D3-API', 'P1 没有 review/retro 时 empty_kinds 显式列出',
    p1Deliverables.empty_kinds.includes('review') && p1Deliverables.empty_kinds.includes('retro'),
    `empty_kinds=${p1Deliverables.empty_kinds.join(',')}`);
  check('GOAL-P1', 'P1 目标达成从 acceptance + checkpoints 推导',
    p1Deliverables.goal?.judgement === 'achieved' && p1Deliverables.goal?.criteria?.total >= 7,
    `${p1Deliverables.goal?.judgement} · 验收项 ${p1Deliverables.goal?.criteria?.passed}/${p1Deliverables.goal?.criteria?.total} · 检查点 ${p1Deliverables.goal?.checkpoints?.passed}/${p1Deliverables.goal?.checkpoints?.total}`);

  // ---- 1. 浏览器：点 P1 看交付物时间线 ----
  await page.goto(`${BASE}/board-cromma.html`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForSelector('.task-row', { timeout: 30000 });
  await page.locator('.task-row', { hasText: 'Agent Chat P1' }).first().click();
  await page.waitForSelector('#deliverables-main:not([hidden])', { timeout: 15000 });
  await page.waitForFunction(() => document.querySelectorAll('#dl-timeline .dl-kind').length === 6, { timeout: 15000 });

  const labels = await page.$$eval('#dl-timeline .dl-kind h2', (els) => els.map((e) => e.textContent.trim()));
  check('D1', '中间主区显示六类交付物时间线', labels.length === 6, labels.join(' / '));

  const emptyKinds = await page.$$eval('#dl-timeline .dl-kind.is-empty', (els) => els.map((el) => ({
    kind: el.dataset.kind,
    text: el.querySelector('.dl-kind__empty')?.textContent.trim() || '',
  })));
  check('D3', '没有的类别显式写「未产生」',
    emptyKinds.length === 2 && emptyKinds.every((x) => x.text === '未产生'),
    emptyKinds.map((x) => `${x.kind}=${x.text || '(空)'}`).join(' '));

  // ---- 2. 点路径 → 右侧预览 ----
  await page.locator('#dl-timeline .dl-kind[data-kind="requirement"] .dl-item__path').first().click();
  await page.waitForSelector('.preview__body', { timeout: 15000 });
  const md = await page.evaluate(() => ({
    kind: document.querySelector('.preview__kind')?.textContent || '',
    h1: document.querySelectorAll('.preview__body h1').length,
    textLen: (document.querySelector('.preview__body')?.textContent || '').length,
    back: Boolean(document.querySelector('[data-preview-back]')),
  }));
  check('D2-markdown', '需求文档 .md 在右侧直接渲染',
    md.kind.includes('markdown') && md.h1 >= 1 && md.textLen > 200 && md.back,
    `kind=${md.kind} h1=${md.h1} chars=${md.textLen}`);

  await page.locator('[data-preview-back]').click();
  await page.waitForTimeout(300);
  await page.locator('#dl-timeline .dl-kind[data-kind="dev_output"] .dl-item__path').first().click();
  await page.waitForSelector('.preview__diff', { timeout: 15000 });
  const diff = await page.evaluate(() => ({
    kind: document.querySelector('.preview__kind')?.textContent || '',
    lines: document.querySelectorAll('.preview__diff .diff-line').length,
    adds: document.querySelectorAll('.preview__diff .diff-line--add').length,
  }));
  check('D2-diff', '交付成果 commit 在右侧显示 diff',
    diff.kind.includes('diff') && diff.lines > 20 && diff.adds > 0,
    `kind=${diff.kind} lines=${diff.lines} adds=${diff.adds}`);
  await page.locator('[data-preview-back]').click();
  await page.waitForTimeout(300);

  // ---- 3. D4：P1-P7 每批交付物链 ----
  const chain = [];
  for (const t of agentChat) {
    const d = await api(`/api/deliverables?task_id=${encodeURIComponent(t.task_id)}`);
    const row = {
      task_id: t.task_id,
      title: t.title,
      requirement: d.groups.requirement.length,
      task_spec: d.groups.task_spec.length,
      dev_output: d.groups.dev_output.length,
      artifact: d.groups.artifact.length,
      review: d.groups.review.length,
      retro: d.groups.retro.length,
      goal: d.goal?.judgement || null,
      empty_kinds: d.empty_kinds,
    };
    row.coreComplete = row.requirement > 0 && row.task_spec > 0 && row.dev_output > 0 && row.artifact > 0 && row.goal;
    row.absentExplicit = ['review', 'retro'].every((k) => row[k] > 0 || d.empty_kinds.includes(k));
    chain.push(row);
  }
  check('D4', 'Agent Chat P1-P7 每批 core 交付物链完整（未产生的类别显式列出）',
    chain.length >= 7 && chain.every((r) => r.coreComplete && r.absentExplicit),
    chain.map((r) => `${r.title.match(/P\d/)?.[0]}: req${r.requirement} spec${r.task_spec} dev${r.dev_output} art${r.artifact} review${r.review} retro${r.retro} goal=${r.goal}`).join(' | '));

  // ---- 4. D5：工具调用折叠，不在主视图 ----
  const d5 = await page.evaluate(() => {
    const tech = document.querySelector('#dl-tech');
    const board = document.querySelector('.board-main');
    const cards = document.querySelector('.data-cards');
    return {
      boardHidden: Boolean(board && board.hidden),
      mainVisible: !document.querySelector('#deliverables-main')?.hidden,
      dataCardsVisible: Boolean(cards && cards.offsetParent !== null),
      techOpen: Boolean(tech && tech.open),
      techText: (tech?.textContent || '').replace(/\s+/g, ' ').trim(),
    };
  });
  check('D5', '工具调用不在主视图，技术细节默认折叠',
    d5.boardHidden && d5.mainVisible && !d5.dataCardsVisible && !d5.techOpen
      && d5.techText.includes('工具调用'),
    `boardHidden=${d5.boardHidden} dataCardsVisible=${d5.dataCardsVisible} techOpen=${d5.techOpen} techText=${d5.techText.slice(0, 60)}`);

  // ---- 5. 实拍图 ----
  await page.waitForTimeout(3200); // 等 toast 消失，拍干净的主视图
  await page.evaluate(() => {
    const el = document.querySelector('#dl-scroll');
    if (el) el.scrollTop = 0;
  });
  await page.screenshot({ path: SHOT, fullPage: false });
  check('SHOT', '实拍图已保存', true, SHOT);

  // ---- 6. JS 异常 ----
  check('JS', '页面无 JS 异常 / 资源加载失败', errors.length === 0, errors.join(' | ') || '0');

  const ok = checks.every((c) => c.pass);
  const report = {
    ok,
    generated_at: new Date().toISOString(),
    base_url: BASE,
    viewport: '1440x900',
    screenshot: SHOT,
    checks,
    agent_chat_chain: chain,
    p1: {
      task_id: p1.task_id,
      title: p1.title,
      goal: p1Deliverables.goal,
      counts: p1Deliverables.counts,
      empty_kinds: p1Deliverables.empty_kinds,
    },
    errors,
  };
  writeFileSync(resolve(EVIDENCE_DIR, 'verify-deliverables.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(resolve(EVIDENCE_DIR, 'verify-deliverables.md'), [
    '# 交付物视图 · 第一批验收（D1-D5）',
    '',
    `- 时间：${report.generated_at}`,
    `- 地址：${BASE}`,
    `- 视口：1440x900`,
    `- 实拍图：${SHOT}`,
    '',
    '| 编号 | 验收 | 结果 | 证据 |',
    '|---|---|---|---|',
    ...checks.map((c) => `| ${c.id} | ${c.name} | ${c.pass ? 'PASS' : 'FAIL'} | ${String(c.detail || '').replace(/\|/g, '\\|')} |`),
    '',
    '## Agent Chat P1-P7 交付物链',
    '',
    '| 批次 | requirement | task_spec | dev_output | artifact | review | retro | goal |',
    '|---|---|---|---|---|---|---|---|',
    ...chain.map((r) => `| ${r.title.match(/P\d/)?.[0] || r.task_id} | ${r.requirement} | ${r.task_spec} | ${r.dev_output} | ${r.artifact} | ${r.review} | ${r.retro} | ${r.goal} |`),
    '',
    '> review / retro 为 0 时，API 的 empty_kinds 与界面都显式写「未产生」，不填假数据。',
    '',
  ].join('\n'), 'utf8');

  console.log(`\n${ok ? 'ALL PASS' : 'HAS FAILURES'} · 报告 ${resolve(EVIDENCE_DIR, 'verify-deliverables.json')}`);
  if (!ok) process.exitCode = 1;
} catch (err) {
  console.error('验收脚本异常：', err);
  const report = { ok: false, generated_at: new Date().toISOString(), error: String(err?.stack || err), checks, errors };
  writeFileSync(resolve(EVIDENCE_DIR, 'verify-deliverables.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.exitCode = 1;
} finally {
  await browser.close();
}
