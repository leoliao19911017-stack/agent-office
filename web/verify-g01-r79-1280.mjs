// verify-g01-r79-1280.mjs — G01 第 79 轮补测：1280×768 四页无横向溢出 +
// W01 新指纹徽标（.msha / .hf-tag.shaok）在窄视口下不逃逸（escX 口径）。
import { startStack, launchBrowser, REAL_FILE, realFileMeta } from '../test/g07-harness.mjs';

const iso = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString();
const rf = realFileMeta();
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const stack = await startStack(EXTRA_TASKS);
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 768 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 120)));
    await page.goto(stack.base + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.req-item[data-task="T-W01R79"]', { timeout: 10000 });
    await page.evaluate(() => document.querySelector('.req-item[data-task="T-W01R79"]').click());
    await page.waitForSelector('.track-node[data-step="verify"]', { timeout: 10000 });
    await page.evaluate(() => document.querySelector('.track-node[data-step="verify"]').click());
    await page.waitForSelector('#insp-body .ev-file .msha', { timeout: 10000 });
    await sleep(1200);

    // 工作台：页面级横向滚动 + 新徽标逃逸检查（.msha 是 nowrap，只许在自身盒内截断/换行到第二行，不许逃出面板）
    const wb = await page.evaluate(() => {
      const esc = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); const p = document.getElementById('inspector').getBoundingClientRect(); return { right: Math.round(r.right), panelRight: Math.round(p.right), escX: r.right > p.right + 1, h: Math.round(r.height) }; };
      return {
        pageScrollX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        msha: esc(document.querySelector('#insp-body .ev-file .msha')),
        msz: esc(document.querySelector('#insp-body .ev-file .msha')?.parentElement),
        shaok: (() => { const el = document.querySelector('#center .handoff-file .hf-tag.shaok'); if (!el) return null; const r = el.getBoundingClientRect(); const c = document.getElementById('center').getBoundingClientRect(); return { escX: r.right > c.right + 1, w: Math.round(r.width) }; })(),
      };
    });
    check(wb.pageScrollX === false, '工作台 1280×768 无页面级横向滚动');
    check(!!wb.msha && wb.msha.escX === false, '审批 .msha 未逃逸面板', JSON.stringify(wb.msha));
    check(!!wb.shaok && wb.shaok.escX === false, '中央 .hf-tag.shaok 未逃逸中栏', JSON.stringify(wb.shaok));
    await page.screenshot({ path: 'verify-w01-r79-1280.png' });

    // 其余三页：切过去各查一次页面级横向滚动
    for (const [rail, name, sel] of [['rail-agents', 'Agents', '#agent-grid'], ['rail-skills', '技能', '#skill-list'], ['rail-files', '文件', '#file-groups']]) {
      await page.evaluate((r) => document.getElementById(r).click(), rail);
      await page.waitForSelector(sel, { timeout: 8000 });
      await sleep(400);
      const sx = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      check(sx === false, `${name} 1280×768 无页面级横向滚动`);
    }
    check(errors.length === 0, '全程零 pageerror', String(errors.length));
  } finally {
    await browser.close();
    await stack.stop();
  }
  console.log(allOk ? 'G01-R79-1280: ALL OK' : 'G01-R79-1280: FAILED');
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
