// F01(第 14 轮)+ S01(第 14 轮)实测取证——不是测试用例：
// 文件页:文件行三列(grid 1fr/220px/136px,gap 16)、登记行两行(11px 等宽/18px + 12px/18px 完整时间)、
//   有效 #65D9B1 / 差异 #E5B95E、文本无重叠;技能页:来源标签 11px/16px、第 6 卡滚到底完整可见不与分页重叠。
// 运行:node scripts/verify-f01-s01-r14.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStack, launchBrowser, newPage } from '../test/g07-harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(dirname(HERE), 'verify-assets', 'f01-s01-r14');
mkdirSync(OUT, { recursive: true });

const stack = await startStack();
const browser = await launchBrowser();
const M = { at: new Date().toISOString(), base: stack.base, files: {}, skills: {} };
try {
  // ---------- 文件页 F01 ----------
  {
    const { page } = await newPage(browser);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(stack.base + '/#/files', { waitUntil: 'commit' });
    await page.waitForSelector('#file-groups .library-file', { timeout: 15000 });
    await page.waitForTimeout(600);

    const f = await page.evaluate(() => {
      const out = { rows: [], phys: null, groups: [] };
      const phys = document.querySelector('.library-file.lf-phys');
      if (phys) {
        const cs = getComputedStyle(phys);
        out.phys = {
          display: cs.display,
          cols: cs.gridTemplateColumns,
          gap: cs.columnGap || cs.gap,
          template: cs.gridTemplateColumns,
        };
        // 三列几何:列边界 = 子元素 rect
        const kids = [...phys.children].map((k) => {
          const r = k.getBoundingClientRect();
          return { cls: k.className, left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width) };
        });
        out.phys.kids = kids;
      }
      // F01 分组全部登记行
      document.querySelectorAll('.filegroup').forEach((g) => {
        const gid = g.querySelector('summary')?.textContent?.trim().slice(0, 30) || '?';
        const regs = [...g.querySelectorAll('.lf-vrow')].map((el) => {
          const cs = getComputedStyle(el);
          const l1 = el.querySelector('.lf-vl1');
          const tm = el.querySelector('.lf-vtime');
          const no = el.querySelector('.lf-vno');
          const r = el.getBoundingClientRect();
          const r1 = l1?.getBoundingClientRect();
          const r2 = tm?.getBoundingClientRect();
          // 重叠判定:第一行与第二行在垂直方向不相交(允许相接)
          const overlap = r1 && r2 ? r1.bottom > r2.top + 0.5 : null;
          return {
            text1: l1?.textContent || '',
            time: tm?.textContent || '',
            vno: no?.textContent || '',
            color: cs.color,
            fontSize: cs.fontSize,
            lineHeight: cs.lineHeight,
            fontFamily: cs.fontFamily.slice(0, 24),
            timeSize: tm ? getComputedStyle(tm).fontSize : null,
            timeFamily: tm ? getComputedStyle(tm).fontFamily.slice(0, 24) : null,
            clipped: r.width < 8 || r.height < 8,
            overlapRows: overlap,
            visible: r.width > 0 && r.height > 0,
          };
        });
        out.groups.push({ id: gid, phys: g.querySelectorAll('.library-file.lf-phys').length, regs });
        out.rows.push(...regs);
      });
      // 横向溢出
      out.hScroll = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
      return out;
    });
    M.files = f;
    await page.screenshot({ path: join(OUT, 'p4-files-1440.png'), fullPage: false });

    // 1280×768 复测
    await page.setViewportSize({ width: 1280, height: 768 });
    await page.waitForTimeout(300);
    M.files.cols1280 = await page.evaluate(() => {
      const phys = document.querySelector('.library-file.lf-phys');
      return phys ? getComputedStyle(phys).gridTemplateColumns : null;
    });
    await page.screenshot({ path: join(OUT, 'p4-files-1280.png'), fullPage: false });
    await page.close();
  }

  // ---------- 技能页 S01 ----------
  {
    const { page } = await newPage(browser);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(stack.base + '/#/skills', { waitUntil: 'commit' });
    await page.waitForSelector('#skill-list .skill-row', { timeout: 15000 });
    await page.waitForTimeout(400);
    const s = await page.evaluate(() => {
      const list = document.getElementById('skill-list');
      const pg = document.getElementById('skill-pagination');
      // 滚到底
      list.scrollTop = list.scrollHeight;
      const rows = [...list.querySelectorAll(':scope > .skill-row')];
      const last = rows[rows.length - 1];
      const pgR = pg.getBoundingClientRect();
      const lastR = last.getBoundingClientRect();
      const src = last.querySelector('.sk-src');
      const cs = src ? getComputedStyle(src) : null;
      return {
        rowCount: rows.length,
        srcSize: cs?.fontSize || null,
        srcLine: cs?.lineHeight || null,
        lastCardBottom: Math.round(lastR.bottom),
        listScrollBottom: Math.round(list.getBoundingClientRect().bottom),
        pgTop: Math.round(pgR.top),
        cardPgGap: Math.round(pgR.top - lastR.bottom),
        gapWithListBottom: Math.round(list.getBoundingClientRect().bottom - lastR.bottom),
        lastHasBorder: getComputedStyle(last).borderBottomWidth,
        hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      };
    });
    M.skills = s;
    // 滚到底后截图
    await page.evaluate(() => { document.getElementById('skill-list').scrollTop = 1e9; });
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(OUT, 'p3-skills-bottom-1440.png'), fullPage: false });
    await page.close();
  }
} finally {
  await browser.close?.();
  await stack.close?.();
}
writeFileSync(join(OUT, 'metrics.json'), JSON.stringify(M, null, 2));
console.log(JSON.stringify(M, null, 2));
