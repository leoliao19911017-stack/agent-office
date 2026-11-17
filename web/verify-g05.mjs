// G05 验收（Playwright + 系统 Chrome，打 8090）：
//  A. 逐个点击四个导航 → 每次断言 hash / aria-current 唯一 / 四页容器显隐 / document.title / h1 / 数据行 + 截图
//  B. 四张截图 sha256 两两不同
//  C. getComputedStyle 实测选中态（背景 #182230 / 边框 1px #78A9EF / 文字 13px）与未选中态（无选中样式）
//  D. 分别刷新四个路由 → 路由 + 选中态保持
//  E. 审批备注草稿：有真实备注框就实测输入；否则用应用自身的 saveNoteDraft/restoreNotes 路径实测
//  F. 全程 pageerror / console.error 必须为 0（files.js:195 修复的回归证明）
import { chromium } from 'playwright-core';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.G05_BASE || 'http://127.0.0.1:8090';
const NAVS = [
  { id: 'rail-reqs',   page: 'workbench', hash: '/',        title: "工作台 · Leo's Agent Office", h1: null,          dataSel: '#reqs-list .req-item',          dataName: '需求条目' },
  { id: 'rail-agents', page: 'agents',    hash: '/agents',  title: "Agents · Leo's Agent Office", h1: 'Agents',      dataSel: '#agent-grid > *',               dataName: 'Agent 卡片' },
  { id: 'rail-skills', page: 'skills',    hash: '/skills',  title: "技能 · Leo's Agent Office",   h1: '技能',        dataSel: '#skill-list .skill-row',         dataName: '技能行' },
  { id: 'rail-files',  page: 'files',     hash: '/files',   title: "文件 · Leo's Agent Office",   h1: '文件',        dataSel: '#file-groups .library-file',    dataName: '文件行' },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);

let failed = 0;
const check = (name, ok, detail) => {
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
  if (!ok) failed++;
};

async function snapshotState(page) {
  return page.evaluate(() => {
    const rails = {};
    for (const id of ['rail-reqs', 'rail-agents', 'rail-skills', 'rail-files']) {
      const el = document.getElementById(id);
      rails[id] = el.getAttribute('aria-current') || '';
    }
    const pages = {};
    for (const n of ['workbench', 'agents', 'skills', 'files']) pages[n] = document.getElementById('page-' + n).hidden;
    const cur = document.querySelector('.rail-item[aria-current=page]');
    const cs = cur ? getComputedStyle(cur) : null;
    const un = document.querySelector('.rail-item:not([aria-current])');
    const ucs = un ? getComputedStyle(un) : null;
    const h1 = document.querySelector('.module-page:not([hidden]) h1');
    return {
      hash: location.hash, title: document.title, page: document.body.dataset.page, rails, pages,
      h1: h1 ? h1.textContent.trim() : null,
      curStyle: cs ? { bg: cs.backgroundColor, bw: cs.borderTopWidth, bc: cs.borderTopColor, fs: cs.fontSize } : null,
      unStyle: ucs ? { bg: ucs.backgroundColor, bc: ucs.borderTopColor, fs: ucs.fontSize, id: un.id } : null,
    };
  });
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [], consoleErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });

try {
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForSelector('#reqs-list .req-item', { timeout: 20000 });
  await sleep(800);

  // ---------- A + C：逐个点击 ----------
  const shots = [];
  for (let i = 0; i < NAVS.length; i++) {
    const n = NAVS[i];
    if (i > 0) { await page.locator('#' + n.id).click(); await sleep(600); }
    await page.waitForSelector(n.dataSel, { timeout: 15000 });
    const st = await snapshotState(page);

    check(`[${n.page}] hash`, st.hash === '#' + n.hash || (n.hash === '/' && st.hash === ''), st.hash);
    check(`[${n.page}] document.title`, st.title === n.title, st.title);
    check(`[${n.page}] body.dataset.page`, st.page === n.page, st.page);
    const curIds = Object.entries(st.rails).filter(([, v]) => v === 'page').map(([k]) => k);
    check(`[${n.page}] aria-current 唯一且正确`, curIds.length === 1 && curIds[0] === n.id, JSON.stringify(st.rails));
    const hiddenBad = Object.entries(st.pages).filter(([k, v]) => v !== (k !== n.page)).map(([k]) => k);
    check(`[${n.page}] 页面容器显隐`, hiddenBad.length === 0, JSON.stringify(st.pages));
    if (n.h1) check(`[${n.page}] h1`, st.h1 === n.h1, String(st.h1));
    const rows = await page.locator(n.dataSel).count();
    check(`[${n.page}] ${n.dataName}数据行 > 0`, rows > 0, 'count=' + rows);

    if (st.curStyle) {
      const c = st.curStyle;
      check(`[${n.page}] 选中态背景`, c.bg === 'rgb(24, 34, 48)', c.bg + ' (=#182230)');
      check(`[${n.page}] 选中态边框`, c.bw === '1px' && c.bc === 'rgb(120, 169, 239)', `${c.bw} ${c.bc} (=1px #78A9EF)`);
      check(`[${n.page}] 选中态字号`, c.fs === '13px', c.fs);
    } else check(`[${n.page}] 选中态读取`, false, '找不到 aria-current 元素');
    if (st.unStyle) {
      check(`[${n.page}] 未选中态无选中背景/边框`, st.unStyle.bg === 'rgba(0, 0, 0, 0)' && st.unStyle.bc === 'rgba(0, 0, 0, 0)',
        `${st.unStyle.id}: bg=${st.unStyle.bg} border=${st.unStyle.bc}`);
      check(`[${n.page}] 未选中态字号仍 12px`, st.unStyle.fs === '12px', st.unStyle.fs);
    }

    const f = `g05-shot-${i + 1}-${n.page}.png`;
    await page.screenshot({ path: f });
    shots.push({ f, page: n.page, h: sha(readFileSync(f)) });
  }

  // ---------- B：四张截图两两不同 ----------
  let dup = [];
  for (let a = 0; a < shots.length; a++) for (let b = a + 1; b < shots.length; b++)
    if (shots[a].h === shots[b].h) dup.push(shots[a].page + '==' + shots[b].page);
  check('四张截图两两不同', dup.length === 0, shots.map((s) => s.page + ':' + s.h).join(' '));

  // ---------- D：刷新四个路由，路由 + 选中态保持 ----------
  for (const n of NAVS) {
    await page.locator('#' + n.id).click();
    await page.waitForSelector(n.dataSel, { timeout: 15000 });
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector(n.dataSel, { timeout: 20000 });
    await sleep(800);
    const st = await snapshotState(page);
    check(`[刷新 ${n.page}] 路由保持`, st.hash === '#' + n.hash && st.page === n.page, `${st.hash} / ${st.page}`);
    const curIds = Object.entries(st.rails).filter(([, v]) => v === 'page').map(([k]) => k);
    check(`[刷新 ${n.page}] 选中态保持`, curIds.length === 1 && curIds[0] === n.id, JSON.stringify(st.rails));
  }

  // ---------- E：审批备注草稿存续 ----------
  // 先找真实的审批备注框（工作台：点第一条需求，逐个点链上步骤看是否出现备注框）
  await page.locator('#rail-reqs').click();
  await page.waitForSelector('#reqs-list .req-item');
  await page.locator('#reqs-list .req-item').first().click();
  await sleep(600);
  let noteTA = null, noteVia = '';
  const phases = await page.locator('#center-chain .track-node').count();
  for (let i = 0; i < Math.min(phases, 12) && !noteTA; i++) {
    await page.locator('#center-chain .track-node').nth(i).click();
    await sleep(350);
    const ta = page.locator('#ip-decide-note, #ip-resubmit-note');
    if (await ta.count() > 0) { noteTA = ta.first(); noteVia = '真实审批备注框'; }
  }
  if (noteTA) {
    await noteTA.fill('G05草稿存续测试');
    await page.locator('#rail-agents').click(); await sleep(500);
    await page.locator('#rail-reqs').click(); await sleep(500);
    const v = await page.evaluate(() => {
      const ta = document.querySelector('#ip-decide-note, #ip-resubmit-note');
      return ta ? ta.value : null;
    });
    check('导航往返后审批备注草稿保留（真实备注框）', v === 'G05草稿存续测试', 'value=' + JSON.stringify(v));
    await noteTA.fill(''); // 清掉测试草稿（fill('') 触发 input → saveNoteDraft('') → 删除）
  } else {
    console.log('INFO | 当前数据里没有可用的审批备注框，改用应用自身 saveNoteDraft/restoreNotes 路径实测（如实记录）');
  }
  // 无论哪条路，都再验证应用自身草稿机制跨导航 + 跨刷新
  await page.evaluate(() => saveNoteDraft('g05-probe-key', 'G05机制验证值'));
  await page.locator('#rail-skills').click(); await sleep(400);
  await page.locator('#rail-reqs').click(); await sleep(400);
  const v1 = await page.evaluate(() => decisionNotes.get('g05-probe-key'));
  check('decisionNotes 跨导航保留', v1 === 'G05机制验证值', 'value=' + JSON.stringify(v1));
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#reqs-list .req-item', { timeout: 20000 });
  const v2 = await page.evaluate(() => decisionNotes.get('g05-probe-key'));
  check('decisionNotes 跨刷新由 restoreNotes 恢复', v2 === 'G05机制验证值', 'value=' + JSON.stringify(v2));
  await page.evaluate(() => saveNoteDraft('g05-probe-key', '')); // 清理测试键

  // ---------- F：全程无页面异常 / 控制台错误 ----------
  check('全程 pageerror = 0', pageErrors.length === 0, pageErrors.join(' || ') || '无');
  check('全程 console.error = 0', consoleErrors.length === 0, consoleErrors.join(' || ') || '无');
  console.log(`\n备注框路径: ${noteVia || '未找到（用机制路径验证）'}；截图: ${shots.map((s) => s.f).join(', ')}`);
} finally {
  await browser.close();
}
console.log(failed === 0 ? '\n== G05 全部通过 ==' : `\n== G05 失败 ${failed} 项 ==`);
process.exit(failed === 0 ? 0 : 1);
