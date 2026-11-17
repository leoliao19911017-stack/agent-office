// G06 第3轮复验 · 新增场景 T5（旧套件 T0–T4 见 verify-g06.mjs，本轮原样重跑）：
//   断网→恢复全周期中「当前路由 / 需求选中状态 / 未提交草稿」不丢失。
//   任务书原文：「恢复服务，确认30s内数据自动重新出现，当前路由、需求选中状态及草稿内容不丢失」
//   T5.0 基线（真实 8090）：选中一条需求（点 .req-item）→ ui.taskId 落 office.ui.v2；
//     草稿走产品真实路径 saveNoteDraft()（可拍板步骤则直接往 #ip-decide-note 打字，否则页内直调）；
//     点 #rail-files 切到文件页（hash 路由）。
//   T5.1 运行中断网（page.route '**/api/**' abort，不刷新页面——断的是运行中的会话）：
//     ≤20s 出现「连接失败 · 网络错误」；路由仍是 #/files（恢复机制不踢页面）；
//     整页不空白；office.ui.v2.taskId 与 office.notes.v1 草稿原样未被覆盖。
//   T5.2 解除拦截：≤35s 恢复「已连接」（30s 退避上限 + 余量，实测秒数如实记录）；
//     仍在文件页且文件区拿到真实数据；切回工作台后选中需求仍是原任务（.req-item.sel）；
//     草稿在内存 Map 与 localStorage 双双完好；若决策面板可见则 textarea 值即草稿原文。
import { chromium } from 'playwright-core';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:8090';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DRAFT = 'G06第3轮复验草稿：断网不丢、恢复仍在';

let failed = 0;
const check = (name, ok, detail) => {
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
  if (!ok) failed++;
};

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
let pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));

try {
  // ---------- T5.0 基线：选中需求 + 留草稿 + 切到文件页 ----------
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForSelector('#sb-conn.ok', { timeout: 20000 });
  await sleep(500);

  const items = page.locator('#reqs-list .req-item');
  const n = await items.count();
  check('T5.0 有可选需求', n > 0, 'req-item=' + n);
  // 若首项已选中则点第二项，保证「选中变化」本身被验证
  const firstSel = await items.first().evaluate((el) => el.classList.contains('sel'));
  const target = firstSel && n > 1 ? items.nth(1) : items.first();
  await target.click();
  await sleep(400);
  const base = await page.evaluate(() => ({
    taskId: ui.taskId,
    stepKey: ui.stepKey,
    uiSaved: (JSON.parse(localStorage.getItem('office.ui.v2') || '{}').taskId) || null,
    decideVisible: !!document.getElementById('ip-decide-note'),
  }));
  const key = base.taskId + '/' + base.stepKey;
  check('T5.0 点击后 ui.taskId 已设', !!base.taskId, 'taskId=' + base.taskId);
  check('T5.0 选中已落档 office.ui.v2', base.uiSaved === base.taskId, `存档=${base.uiSaved} 实际=${base.taskId}`);

  if (base.decideVisible) {
    await page.fill('#ip-decide-note', DRAFT);           // 真实输入路径（oninput → saveNoteDraft）
    await sleep(200);
  } else {
    await page.evaluate((k) => saveNoteDraft(k, 'G06第3轮复验草稿：断网不丢、恢复仍在', 'ip-note-cnt'), key);
  }
  const draftSaved = await page.evaluate((k) => {
    const m = JSON.parse(localStorage.getItem('office.notes.v1') || '[]');
    return Object.fromEntries(m)[k] || null;
  }, key);
  check('T5.0 草稿已落档 office.notes.v1', draftSaved === DRAFT, `key=${key} 草稿=${JSON.stringify(draftSaved)}`);
  check('T5.0 草稿走的是 UI 输入还是页内直调', true,
    base.decideVisible ? 'UI 输入 #ip-decide-note（oninput→saveNoteDraft）' : '页内直调 saveNoteDraft()（该步骤无拍板面板）');

  await page.click('#rail-files');
  await page.waitForFunction(() => location.hash === '#/files' && !document.getElementById('page-files').hidden, null, { timeout: 5000 });
  const routeOk = await page.evaluate(() => ({
    hash: location.hash, page: document.body.dataset.page,
    wbHidden: document.getElementById('page-workbench').hidden,
    fileCount: document.getElementById('file-count').textContent.trim(),
  }));
  check('T5.0 已切到文件页（hash 路由）', routeOk.hash === '#/files' && routeOk.page === 'files' && routeOk.wbHidden === true,
    `hash=${routeOk.hash} page=${routeOk.page} 工作台hidden=${routeOk.wbHidden}`);

  // ---------- T5.1 运行中断网：失败态可见、状态不被覆盖 ----------
  await page.route('**/api/**', (route) => route.abort());
  await page.waitForFunction(() => {
    const el = document.getElementById('sb-conn');
    return el.classList.contains('off') && document.getElementById('sb-conn-text').textContent.includes('连接失败');
  }, null, { timeout: 20000 });
  await sleep(300);
  const out = await page.evaluate((k) => {
    const cs = getComputedStyle(document.getElementById('sb-conn'));
    return {
      text: document.getElementById('sb-conn-text').textContent,
      color: cs.color, fontSize: getComputedStyle(document.getElementById('sb-conn-text')).fontSize,
      hash: location.hash, page: document.body.dataset.page,
      filesVisible: !document.getElementById('page-files').hidden,
      bodyH: document.body.getBoundingClientRect().height,
      uiSaved: (JSON.parse(localStorage.getItem('office.ui.v2') || '{}').taskId) || null,
      note: Object.fromEntries(JSON.parse(localStorage.getItem('office.notes.v1') || '[]'))[k] || null,
    };
  }, key);
  check('T5.1 断网后底栏=连接失败 · 网络错误', out.text === '连接失败 · 网络错误', out.text);
  check('T5.1 失败色 #E5B95E / 12px', out.color === 'rgb(229, 185, 94)' && out.fontSize === '12px', `${out.color} / ${out.fontSize}`);
  check('T5.1 断网期间路由不丢（仍 #/files）', out.hash === '#/files' && out.page === 'files' && out.filesVisible === true,
    `hash=${out.hash} page=${out.page}`);
  check('T5.1 无整页空白', out.bodyH > 400, 'bodyH=' + Math.round(out.bodyH));
  check('T5.1 选中未被覆盖（office.ui.v2 原样）', out.uiSaved === base.taskId, `存档=${out.uiSaved} 原=${base.taskId}`);
  check('T5.1 草稿未被清除（office.notes.v1 原样）', out.note === DRAFT, `草稿=${JSON.stringify(out.note)}`);

  // ---------- T5.2 解除拦截：≤35s 恢复 + 三态完好 ----------
  await page.unroute('**/api/**');
  const t0 = Date.now();
  await page.waitForSelector('#sb-conn.ok', { timeout: 35000 });
  const recSec = ((Date.now() - t0) / 1000).toFixed(1);
  await sleep(600);
  const rec = await page.evaluate((k) => ({
    text: document.getElementById('sb-conn-text').textContent,
    hash: location.hash, page: document.body.dataset.page,
    filesVisible: !document.getElementById('page-files').hidden,
    fileCount: document.getElementById('file-count').textContent.trim(),
    fileRows: document.querySelectorAll('#file-groups .file-item, #file-groups .file-row, #file-groups tr, #file-groups li').length,
    taskId: ui.taskId,
    noteMem: decisionNotes.get(k) || null,
    noteLS: Object.fromEntries(JSON.parse(localStorage.getItem('office.notes.v1') || '[]'))[k] || null,
    decideVisible: !!document.getElementById('ip-decide-note'),
    decideVal: (document.getElementById('ip-decide-note') || {}).value ?? null,
  }), key);
  check('T5.2 恢复=已连接（真实数据回填）', rec.text === '已连接', rec.text);
  console.log(`INFO | T5.2 恢复耗时 ${recSec}s（退避 2/4/8→30s 封顶；任务书口径 30s 内，上限断言 35s）`);
  check('T5.2 恢复耗时 ≤35s', Number(recSec) <= 35, recSec + 's');
  check('T5.2 恢复过程不踢路由（仍 #/files）', rec.hash === '#/files' && rec.page === 'files' && rec.filesVisible === true,
    `hash=${rec.hash} page=${rec.page}`);
  check('T5.2 文件页拿到真实数据', rec.fileRows > 0 || /\d/.test(rec.fileCount), `行=${rec.fileRows} 计数="${rec.fileCount}"`);

  await page.click('#rail-reqs');
  await page.waitForFunction(() => location.hash === '#/' || location.hash === '', null, { timeout: 5000 });
  await sleep(500);
  const back = await page.evaluate(({ tid, k }) => ({
    taskId: ui.taskId,
    selTask: (document.querySelector('#reqs-list .req-item.sel') || {}).dataset?.task || null,
    noteMem: decisionNotes.get(k) || null,
    noteLS: Object.fromEntries(JSON.parse(localStorage.getItem('office.notes.v1') || '[]'))[k] || null,
    decideVisible: !!document.getElementById('ip-decide-note'),
    decideVal: (document.getElementById('ip-decide-note') || {}).value ?? null,
  }), { tid: base.taskId, k: key });
  check('T5.2 切回工作台：选中仍是原需求（ui.taskId）', back.taskId === base.taskId, `ui=${back.taskId} 原=${base.taskId}`);
  check('T5.2 选中态可见（.req-item.sel 同一任务）', back.selTask === base.taskId, `sel=${back.selTask}`);
  check('T5.2 草稿内存 Map 完好', back.noteMem === DRAFT, `Map=${JSON.stringify(back.noteMem)}`);
  check('T5.2 草稿落档完好', back.noteLS === DRAFT, `LS=${JSON.stringify(back.noteLS)}`);
  if (base.decideVisible && back.decideVisible) {
    check('T5.2 决策面板 textarea 值=草稿原文', back.decideVal === DRAFT, `值=${JSON.stringify(back.decideVal)}`);
  } else {
    console.log('INFO | T5.2 该步骤无拍板面板（draft 以 Map+localStorage 双档验证，机制同 TASK-R7）');
  }

  check('T5 全程 pageerror = 0', pageErrors.length === 0, pageErrors.join(' || ') || '无');
} finally {
  await browser.close();
}
console.log(failed === 0 ? '\n== G06第3轮 T5 全部通过 ==' : `\n== G06第3轮 T5 失败 ${failed} 项 ==`);
process.exit(failed === 0 ? 0 : 1);
