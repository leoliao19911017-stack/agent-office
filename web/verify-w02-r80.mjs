// verify-w02-r80.mjs — W02 第 80 轮：#insp-body 滚动条宽 6px 实测 + 既有布局契约复测。
// 口径（任务书）：右栏 328px；正文 flex:1 / min-height:0 / overflow-y:auto / 底 padding 80px；
//   固定操作区 64px；正文 12px/20px；滚动条宽 6px（本轮新增，仅 ::-webkit-scrollbar，
//   不写 scrollbar-width 以免标准属性接管后 6px 失真）。滚到底末行完整可见且距操作区 ≥12px。
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { WEB, CHROME, startStack, newPage, sleep } from '../test/g07-harness.mjs';

const FIX = join(WEB, '.work').replace(/\\/g, '/');
const shaOf = (t) => createHash('sha256').update(t, 'utf8').digest('hex');
const metaOf = (t) => ({ bytes: Buffer.byteLength(t, 'utf8'), sha256: shaOf(t) });
const iso = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString();
const TXT = 'R80-W02 滚动条验证基线：内容与登记一致。\n';
const longNote = (n) => {
  const unit = '第80轮滚动条验证段：审批正文独立滚动，滚动条宽6px，滚到底末行完整可见。';
  return unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
};

const TASKS = [{
  id: 'T-W80S', title: 'R80-W02 滚动条 6px',
  createdAt: iso(50), updatedAt: iso(3),
  steps: {
    req: { status: 'done', at: iso(45), note: '', by: 'leo' },
    doc: { status: 'done', at: iso(40), note: '', by: 'lemate' },
    plan: { status: 'done', at: iso(35), note: '', by: 'lemate' },
    brief: { status: 'done', at: iso(30), note: '', by: 'lemate' },
    deliverable: { status: 'done', at: iso(20), note: '', by: 'lemate',
      files: [{ path: `${FIX}/r80-w.txt`, ...metaOf(TXT) }] },
    verify: { status: 'awaiting', at: iso(3), note: longNote(3000), by: 'hermes' },
    final: { status: 'pending', at: null, note: '', by: null },
  },
}];

let allOk = true;
const check = (ok, label, detail) => { console.log(`${ok ? '✅' : '❌'} ${label}${detail ? '：' + detail : ''}`); if (!ok) allOk = false; };

async function main() {
  const { writeFileSync, unlinkSync } = await import('node:fs');
  writeFileSync(`${FIX}/r80-w.txt`, TXT);
  const stack = await startStack(TASKS);
  // 无头 Chrome 默认叠加式滚动条（不占布局，offsetWidth−clientWidth 恒 0），物理
  // 宽度量不出来；Playwright 无头还会默认注入 --hide-scrollbars（直接不渲染）。
  // 滤掉该默认参数 + 禁用 OverlayScrollbar 特性，恢复经典滚动条才能实测 6px 占位。
  const browser = await chromium.launch({
    executablePath: CHROME, headless: true,
    ignoreDefaultArgs: ['--hide-scrollbars'],
    args: ['--disable-features=OverlayScrollbar'],
  });
  try {
    const { page, state } = await newPage(browser);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(stack.base + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.req-item[data-task="T-W80S"]', { timeout: 10000 });
    await page.evaluate(() => document.querySelector('.req-item[data-task="T-W80S"]').click());
    await page.waitForSelector('.track-node[data-step="verify"]', { timeout: 10000 });
    await page.evaluate(() => document.querySelector('.track-node[data-step="verify"]').click());
    await page.waitForSelector('#insp-body .ip-note', { timeout: 10000 });
    await sleep(600);

    const m = await page.evaluate(() => {
      const body = document.getElementById('insp-body');
      const foot = document.getElementById('insp-foot');
      const insp = document.getElementById('inspector');
      const lastP = [...body.querySelectorAll('.ip-note')].pop();
      body.scrollTop = body.scrollHeight;
      const bR = body.getBoundingClientRect(), fR = foot.getBoundingClientRect(), pR = lastP.getBoundingClientRect();
      const cs = getComputedStyle(body);
      const sb = getComputedStyle(body, '::-webkit-scrollbar');
      const thumb = getComputedStyle(body, '::-webkit-scrollbar-thumb');
      const csP = getComputedStyle(lastP);
      return {
        overflowed: body.scrollHeight > body.clientHeight,
        scrollW: body.offsetWidth - body.clientWidth, sbCssW: sb.width,
        thumbBg: thumb.backgroundColor, thumbRadius: thumb.borderRadius,
        inspW: insp.getBoundingClientRect().width, footH: fR.height,
        padBottom: cs.paddingBottom, textFont: `${csP.fontSize}/${csP.lineHeight}`,
        lastBottom: +pR.bottom.toFixed(1), bodyBottom: +bR.bottom.toFixed(1), footTop: +fR.top.toFixed(1),
        lastVisible: pR.bottom <= bR.bottom + 0.5,
      };
    });
    check(m.overflowed, '正文确有滚动（3000 字溢出）', `scrollH>clientH=${m.overflowed}`);
    check(m.scrollW === 6, '滚动条物理宽度 = 6px（offsetWidth−clientWidth）', `${m.scrollW}px`);
    check(m.sbCssW === '6px', '::-webkit-scrollbar 规则宽 6px', m.sbCssW);
    check(m.thumbBg === 'rgb(51, 65, 85)' && m.thumbRadius === '3px', '滑块 #334155 · 圆角 3px', `${m.thumbBg} / ${m.thumbRadius}`);
    check(m.inspW === 328, '右栏 328px（契约复测）', `${m.inspW}px`);
    check(m.footH === 64, '固定操作区 64px（契约复测）', `${m.footH}px`);
    check(m.padBottom === '80px', '正文底 padding 80px（契约复测）', m.padBottom);
    check(m.textFont === '12px/20px', '正文段落 12px/20px（契约复测，量 .ip-note）', m.textFont);
    check(m.lastVisible && (m.footTop - m.lastBottom) >= 12, '滚到底末行完整可见且距操作区 ≥12px', `gap=${(m.footTop - m.lastBottom).toFixed(1)}px`);

    await sleep(300);
    check(state.pageErrors.length === 0, '零 pageerror', String(state.pageErrors.length));
    check(state.consoleErrs.length === 0, '零 console.error', String(state.consoleErrs.length));
    await page.screenshot({ path: 'verify-w02-r80-scrollbar.png', fullPage: false });
    console.log('截图：web/verify-w02-r80-scrollbar.png');
  } finally {
    await browser.close();
    await stack.stop();
    try { unlinkSync(`${FIX}/r80-w.txt`); } catch { /* 已随清理移除则无妨 */ }
  }
  console.log(allOk ? 'W02-R80: ALL OK' : 'W02-R80: FAILED');
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
