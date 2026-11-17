// verify-w01-r79.mjs — W01 第 79 轮：审批条目与中央产物列表明示内容级核对证据。
// 口径（任务书）：核对通过的文件亮出「指纹 a1b2c3d4 ✓」——服务端 version-gate
//   verified[] 带回登记指纹 vs 现算实测指纹的比对结果，审批面板（.msha）与中央
//   产物列表（.hf-tag.shaok）同源展示；颜色 --ok #65D9B1，12px/18px；
//   核对口径段说明 SHA-256 双一致语义；全程零 pageerror / 非预期 console.error。
import { startStack, launchBrowser, newPage, sleep, REAL_FILE, realFileMeta } from '../test/g07-harness.mjs';

const iso = (minAgo) => new Date().toISOString(Date.now() - minAgo * 60000) && new Date(Date.now() - minAgo * 60000).toISOString();
const rf = realFileMeta();

// 夹具：verify 步 awaiting 且登记产物与磁盘现状完全一致（bytes+sha256 都对得上）
// → version-gate 走「核对通过」分支，verified[0].shaMatch=true，页面应亮指纹 ✓。
const EXTRA_TASKS = [{
  id: 'T-W01R79', title: 'W01 第79轮内容级核对证据',
  createdAt: iso(40), updatedAt: iso(2),
  steps: {
    req: { status: 'done', at: iso(35), note: 'W01 r79 验证', by: 'leo' },
    doc: { status: 'done', at: iso(30), note: '', by: 'lemate' },
    plan: { status: 'done', at: iso(25), note: '', by: 'lemate' },
    brief: { status: 'done', at: iso(20), note: '', by: 'lemate' },
    deliverable: { status: 'done', at: iso(15), note: '', by: 'lemate' },
    verify: { status: 'awaiting', at: iso(3), note: '等拍板：内容级核对证据展示', by: 'hermes',
      files: [{ path: REAL_FILE, bytes: rf.bytes, sha256: rf.sha256, kind: 'plan' }] },
    final: { status: 'pending', at: null, note: '', by: null },
  },
}];

let allOk = true;
const check = (ok, label, detail) => { console.log(`${ok ? '✅' : '❌'} ${label}${detail ? '：' + detail : ''}`); if (!ok) allOk = false; };

async function main() {
  const stack = await startStack(EXTRA_TASKS);
  const browser = await launchBrowser();
  try {
    // —— 1. API 层：version-gate verified[] 带回 shaMatch=true ——
    const api = await fetch(stack.base + '/api/office/version-gate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: 'T-W01R79', stepKey: 'verify' }),
    }).then((r) => r.json());
    const v0 = (api.verified || [])[0] || {};
    check(api.valid === true && (api.drifted || []).length === 0, 'version-gate 判定通过、零漂移', `valid=${api.valid} drifted=${(api.drifted || []).length}`);
    check(v0.shaMatch === true && v0.regSha === rf.sha256, 'verified[0] 带回登记指纹且 shaMatch=true', `regSha=${(v0.regSha || '').slice(0, 8)}… shaMatch=${v0.shaMatch}`);

    // —— 2. UI 层：审批面板 + 中央产物列表 ——
    const { page, state } = await newPage(browser);
    await page.goto(stack.base + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.req-item[data-task="T-W01R79"]', { timeout: 10000 });
    await page.evaluate(() => document.querySelector('.req-item[data-task="T-W01R79"]').click());
    await page.waitForSelector('.track-node[data-step="verify"]', { timeout: 10000 });
    await page.evaluate(() => document.querySelector('.track-node[data-step="verify"]').click());
    await page.waitForSelector('#insp-body .ev-file', { timeout: 10000 });
    await sleep(1200);   // 等 version-gate 60s 缓存首轮判定回来并重渲染

    // 审批条目 .msha：指纹 ✓ + 颜色/字号
    const msha = await page.evaluate(() => {
      const el = document.querySelector('#insp-body .ev-file .msha');
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { text: el.textContent.trim(), color: cs.color, fs: cs.fontSize, lh: cs.lineHeight };
    });
    check(!!msha && /^指纹 [0-9a-f]{8} ✓$/.test(msha.text), '审批条目显示「指纹 a1b2c3d4 ✓」（前 8 位）', msha ? msha.text : '未找到 .msha');
    check(!!msha && msha.color === 'rgb(101, 217, 177)' && msha.fs === '12px', '指纹徽标 #65D9B1 · 12px', msha ? `${msha.color} ${msha.fs}/${msha.lh}` : '');
    check(!!msha && msha.text.includes(rf.sha256.slice(0, 8)), '显示的指纹 = 登记指纹前 8 位（非编造）', `${msha && msha.text} vs ${rf.sha256.slice(0, 8)}`);

    // 核对口径段说明 SHA-256 语义
    const caliper = await page.evaluate(() => {
      const els = [...document.querySelectorAll('#insp-body .ev-src')];
      return els.map((e) => e.textContent).join('\n');
    });
    check(caliper.includes('SHA-256') && caliper.includes('指纹 ✓'), '核对口径段说明 SHA-256 双一致语义', caliper.slice(0, 60) + '…');

    // 中央产物列表 .hf-tag.shaok：同源指纹标签
    const tag = await page.evaluate(() => {
      const el = document.querySelector('#center .handoff-file .hf-tag.shaok');
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { text: el.textContent.trim(), color: cs.color, fs: cs.fontSize };
    });
    check(!!tag && /^指纹 [0-9a-f]{8} ✓$/.test(tag.text), '中央产物列表同源指纹标签', tag ? tag.text : '未找到 .hf-tag.shaok');
    check(!!tag && tag.color === 'rgb(101, 217, 177)' && tag.fs === '12px', '中央标签 #65D9B1 · 12px', tag ? `${tag.color} ${tag.fs}` : '');

    // 零异常
    await sleep(300);
    check(state.pageErrors.length === 0, '零 pageerror', String(state.pageErrors.length));
    check(state.consoleErrs.length === 0, '零 console.error', String(state.consoleErrs.length));

    // 截图留档
    await page.screenshot({ path: 'verify-w01-r79-panel.png', fullPage: false });
    console.log('截图：web/verify-w01-r79-panel.png');
  } finally {
    await browser.close();
    await stack.stop();
  }
  console.log(allOk ? 'W01-R79: ALL OK' : 'W01-R79: FAILED');
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
