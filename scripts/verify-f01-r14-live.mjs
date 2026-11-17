// F01(第 14 轮)实测取证·真数据版——连 127.0.0.1:8090 真实服务(AGENT_AUTOLOOP_HOME 主数据:
// F01 分组 2 个物理文件 × 4 条历史登记),不是 G07 夹具。测:
//   ① 每行 .lf-phys computed display=grid + 三列轨道像素(1fr/220/136) + gap 16
//   ② 每条 .lf-vrow:字号 11px/行高 18px/等宽字体,lf-vtime 12px 正常字体,两行不相交
//   ③ 有效版本 rgb(101,217,177)=#65D9B1,差异/不可核验 rgb(229,185,94)=#E5B95E
//   ④ 版本信息列/操作列几何宽度 220/136(±1px),文件信息列自适应,无横向溢出
//   ⑤ S01 顺带:卡片底部 .sk-tag/.sk-cat 11px/16px
// 运行:node scripts/verify-f01-r14-live.mjs   (前置:8090 服务在跑)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, newPage } from '../test/g07-harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(dirname(HERE), 'verify-assets', 'f01-r14-live');
mkdirSync(OUT, { recursive: true });
const BASE = 'http://127.0.0.1:8090';

const browser = await launchBrowser();
const M = { at: new Date().toISOString(), base: BASE, viewports: {} };
try {
  for (const vp of [{ w: 1440, h: 900 }, { w: 1280, h: 768 }]) {
    const { page } = await newPage(browser);
    await page.setViewportSize({ width: vp.w, height: vp.h });
    await page.goto(BASE + '/#/files', { waitUntil: 'commit' });
    await page.waitForSelector('.library-file.lf-phys', { timeout: 15000 });
    await page.waitForTimeout(600);
    const r = await page.evaluate(() => {
      const out = { rows: [], cols: [], groups: [] };
      document.querySelectorAll('.filegroup').forEach((g) => {
        out.groups.push({
          id: (g.querySelector('summary')?.textContent || '').trim().slice(0, 40),
          phys: g.querySelectorAll('.library-file.lf-phys').length,
          regs: g.querySelectorAll('.lf-vrow').length,
        });
      });
      document.querySelectorAll('.library-file.lf-phys').forEach((phys, i) => {
        const cs = getComputedStyle(phys);
        const kids = [...phys.children].map((k) => {
          const rc = k.getBoundingClientRect();
          return { cls: String(k.className), left: Math.round(rc.left), right: Math.round(rc.right), w: Math.round(rc.width) };
        });
        if (i === 0) out.phys = { display: cs.display, cols: cs.gridTemplateColumns, gap: cs.columnGap };
        out.cols.push({ i, kids });
        phys.querySelectorAll('.lf-vrow').forEach((el) => {
          const c = getComputedStyle(el);
          const l1 = el.querySelector('.lf-vl1'), tm = el.querySelector('.lf-vtime');
          const r1 = l1?.getBoundingClientRect(), r2 = tm?.getBoundingClientRect();
          out.rows.push({
            vno: el.querySelector('.lf-vno')?.textContent || '',
            l1: l1?.textContent || '',
            time: tm?.textContent || '',
            color: c.color, fontSize: c.fontSize, lineHeight: c.lineHeight,
            mono: c.fontFamily.includes('Cascadia'),
            timeSize: tm ? getComputedStyle(tm).fontSize : null,
            timeBody: tm ? getComputedStyle(tm).fontFamily.includes('Segoe') : null,
            rowOverlap: r1 && r2 ? r1.bottom > r2.top + 0.5 : null,
          });
        });
      });
      out.hScroll = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
      return out;
    });
    M.viewports[vp.w] = r;
    await page.screenshot({ path: join(OUT, `p4-files-${vp.w}.png`) });
    await page.close();
  }
  // S01:卡片底部标签字号(真数据技能索引)
  {
    const { page } = await newPage(browser);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(BASE + '/#/skills', { waitUntil: 'commit' });
    await page.waitForSelector('#skill-list .skill-row', { timeout: 15000 });
    await page.waitForTimeout(400);
    M.skills = await page.evaluate(() => {
      const row = document.querySelector('#skill-list .skill-row');
      const tag = row?.querySelector('.sk-tag'), cat = row?.querySelector('.sk-cat');
      return {
        tag: tag ? { fs: getComputedStyle(tag).fontSize, lh: getComputedStyle(tag).lineHeight } : null,
        cat: cat ? { fs: getComputedStyle(cat).fontSize, lh: getComputedStyle(cat).lineHeight } : null,
      };
    });
    await page.close();
  }
} finally {
  await browser.close?.();
}
writeFileSync(join(OUT, 'metrics.json'), JSON.stringify(M, null, 2));
console.log(JSON.stringify(M, null, 2));
