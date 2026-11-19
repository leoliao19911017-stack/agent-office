// R86 整改实测（独立探针，不进 test:g07 的 19 用例门禁）：node test/r86-verify.mjs
//
// 覆盖任务书三条验收口径：
//   X01 四份计划文件分别测——完整计划放行 / 验证夹具被拦 / 空文件被拦 / 丢失文件被拦；
//   X02 混合数据——首页默认不选测试任务、待确认计数不混测试、全是测试时空状态、/pro 数据不动；
//   X03 1280×768——不滚动读完 3~5 条摘要 + 摸到确认按钮，且摘要在主按钮之前。
//
// 复用 g07-harness 的隔离三件套（stub 中台 + 临时 home + 真实 server.js 子进程）+
// 系统 Chrome。计划文件写在仓库 .r86-tmp/ 下（FILE_ROOTS 白名单内，/api/office/file
// 能真实读取），登记用真实字节 + 真实 sha256，跑完即删。
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { startStack, launchBrowser, newPage, sleep, ROOT, REAL_FILE, realFileMeta } from './g07-harness.mjs';

const shaOf = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const iso = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString();
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail: detail || '' });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' —— ' + detail : ''}`);
};

/* ---------------- 四份计划文件（真实字节 + 真实指纹注册） ---------------- */
const DIR = join(ROOT, '.r86-tmp').replace(/\\/g, '/');
mkdirSync(DIR, { recursive: true });

// ① 合格计划：功能 / 步骤 / 测试三样齐（每样都有分节 + 条目）
const PLAN_FULL = [
  '# 记账小工具开发计划',
  '',
  '## 功能清单',
  '- 功能 1：发票批量导入（csv 和 excel 都要能吃）',
  '- 功能 2：自动识别日期与金额字段',
  '- 功能 3：一键导出月度汇总报表',
  '',
  '## 实施步骤',
  '1. 第一步：搭导入解析模块，产出 parser.js',
  '2. 第二步：实现字段识别与归类，产出 mapper.js',
  '3. 第三步：汇总报表导出，产出 report.js',
  '',
  '## 测试方法',
  '- 功能 1 测试：3 份样例 csv 全部导入成功判为通过',
  '- 功能 2 测试：10 条中文日期记录识别全对判为合格',
  '- 功能 3 测试：导出报表与手算结果一致判为通过',
  '',
].join('\n');

// ② 系统验证夹具内容（第 86 轮评审现场那类的形状：满篇验证夹具，没有功能结构）
const PLAN_VERIFY = [
  '# 系统验证任务记录',
  '',
  '## 验证目标',
  '- 验证夹具 A：同版本不同登记时间的展示一致性',
  '- 验证夹具 B：历史版本回读与指纹复核',
  '',
  '## 验证登记',
  '- 验证夹具 A：登记两条相同指纹的档案，观察版本胶囊',
  '- 验证夹具 B：登记旧指纹，走快照回读',
  '',
].join('\n');

const files = {
  full: { path: `${DIR}/plan-full.md`, text: PLAN_FULL },
  verify: { path: `${DIR}/plan-verify.md`, text: PLAN_VERIFY },
  empty: { path: `${DIR}/plan-empty.md`, text: '' },
  missing: { path: `${DIR}/plan-missing.md` },   // 只登记不落盘：磁盘上就是没有这份文件
};
for (const k of ['full', 'verify', 'empty']) {
  writeFileSync(files[k].path, files[k].text, 'utf8');
  files[k].bytes = Buffer.byteLength(files[k].text, 'utf8');
  files[k].sha256 = shaOf(files[k].text);
}
files.missing.bytes = 5;
files.missing.sha256 = shaOf('R86 丢失文件占位：磁盘上没有这份计划');

const realMeta = realFileMeta();

// plan 步骤 awaiting 待确认的任务（req/doc 已 done，plan 登记对应计划文件）
const planTask = (id, title, fk, minAgo) => ({
  id, title, createdAt: iso(minAgo + 60), updatedAt: iso(minAgo),
  steps: {
    req: { status: 'done', at: iso(minAgo + 50), note: 'R86 实测需求', by: 'leo',
      files: [{ path: REAL_FILE, bytes: realMeta.bytes, sha256: realMeta.sha256 }] },
    doc: { status: 'done', at: iso(minAgo + 40), note: 'R86 实测需求文档', by: 'lemate' },
    plan: { status: 'awaiting', at: iso(minAgo), note: '等你过目开发计划', by: 'lemate',
      files: [{ path: files[fk].path, bytes: files[fk].bytes, sha256: files[fk].sha256 }] },
    brief: { status: 'pending', at: null, note: '', by: null },
    deliverable: { status: 'pending', at: null, note: '', by: null },
    verify: { status: 'pending', at: null, note: '', by: null },
    final: { status: 'pending', at: null, note: '', by: null },
  },
});

// verify 步骤 awaiting 的任务（X02 混合/全测场景用；形状与 T-G07A 一致，登记无漂移）
const verifyTask = (id, title, minAgo) => ({
  id, title, createdAt: iso(minAgo + 60), updatedAt: iso(minAgo),
  steps: {
    req: { status: 'done', at: iso(minAgo + 50), note: 'R86 场景需求', by: 'leo',
      files: [{ path: REAL_FILE, bytes: realMeta.bytes, sha256: realMeta.sha256 }] },
    doc: { status: 'done', at: iso(minAgo + 40), note: '', by: 'lemate' },
    plan: { status: 'done', at: iso(minAgo + 30), note: '', by: 'lemate' },
    brief: { status: 'done', at: iso(minAgo + 20), note: '', by: 'lemate' },
    deliverable: { status: 'done', at: iso(minAgo + 10), note: 'R86 场景交付', by: 'lemate',
      files: [{ path: REAL_FILE, bytes: realMeta.bytes, sha256: realMeta.sha256 }] },
    verify: { status: 'awaiting', at: iso(minAgo), note: '等你拍板验收', by: 'hermes' },
    final: { status: 'pending', at: null, note: '', by: null },
  },
});

const browser = await launchBrowser();
try {
  /* ================= 场景 1：X01 四份文件 + X03 视口（1280×768） ================= */
  {
    const stack = await startStack([
      planTask('T-R86A', 'R86 完整开发计划（记账小工具）', 'full', 4),
      planTask('T-R86B', 'R86 验证夹具任务', 'verify', 3),
      planTask('T-R86C', 'R86 空计划任务', 'empty', 2),
      planTask('T-R86D', 'R86 计划文件丢失任务', 'missing', 1),
    ], { noBase: true });
    try {
      const { page, state } = await newPage(browser);
      // T-R86D 故意丢失文件：读取它必然产生一个 404（X01-4 的检测机制本身）。
      // 记下每个 404 的 URL，console 检查时把这一个预期内 404 归因出来，其余仍要求零错误。
      const notFounds = [];
      page.on('response', (r) => { if (r.status() === 404) notFounds.push(r.url()); });
      await page.setViewportSize({ width: 1280, height: 768 });   // X03 验收口径视口
      await page.goto(stack.base + '/#/', { waitUntil: 'commit' });
      await page.waitForSelector('#cabin-tasks .cabin-task', { timeout: 15000 });
      await page.waitForSelector('#sb-conn.ok', { timeout: 10000 });

      const probe = async (id, expectText) => {
        await page.click(`.cabin-task[data-cabin-task="${id}"]`);
        await page.waitForFunction((txt) => {
          const el = document.querySelector('.ch-plan');
          return el && el.textContent.includes(txt);
        }, expectText, { timeout: 10000 });
        return page.evaluate(() => {
          const b = document.querySelector('.ch-act [data-decide="approve"]');
          const plan = document.querySelector('.ch-plan');
          return {
            btn: !!b, disabled: b ? b.disabled : null,
            liN: document.querySelectorAll('.ch-plan li').length,
            text: (plan ? plan.textContent : '').replace(/\s+/g, ' ').trim().slice(0, 200),
          };
        });
      };

      // ① 完整计划：放行确认
      const a = await probe('T-R86A', '查看完整开发计划');
      check('X01-1 完整开发计划 → 可确认', a.btn && a.disabled === false, `disabled=${a.disabled}，摘要 ${a.liN} 条`);
      check('X01-1 摘要 3~5 条', a.liN >= 3 && a.liN <= 5, `liN=${a.liN}`);
      check('X01-1 摘要来自真实文件内容', a.text.includes('发票批量导入'), `「${a.text.slice(0, 60)}…」`);

      // ② 验证夹具内容：必须被拦下 + 明说是系统验证任务
      const b = await probe('T-R86B', '这是一次系统验证任务');
      check('X01-2 验证夹具内容 → 被拦下', b.btn && b.disabled === true, `disabled=${b.disabled}`);
      check('X01-2 不伪装成开发计划', b.text.includes('不是软件开发计划') && !b.text.includes('查看完整开发计划'), `「${b.text.slice(0, 60)}…」`);

      // ③ 空文件：被拦下
      const c = await probe('T-R86C', '还不完整');
      check('X01-3 空文件 → 被拦下', c.btn && c.disabled === true, `disabled=${c.disabled}，提示「${c.text.slice(0, 40)}…」`);

      // ④ 丢失文件：被拦下
      const d = await probe('T-R86D', '暂时无法读取');
      check('X01-4 丢失文件 → 被拦下', d.btn && d.disabled === true, `disabled=${d.disabled}，提示「${d.text.slice(0, 40)}…」`);

      // X03：回到完整计划，量 1280×768 不滚动
      await page.click('.cabin-task[data-cabin-task="T-R86A"]');
      await page.waitForFunction(() => {
        const el = document.querySelector('.ch-plan');
        return el && el.textContent.includes('查看完整开发计划');
      }, null, { timeout: 10000 });
      await sleep(300);   // 等重绘与布局稳定
      const m = await page.evaluate(() => {
        const home = document.getElementById('page-home');
        const hero = document.querySelector('.cabin-hero');
        const plan = document.querySelector('.ch-plan');
        const act = document.querySelector('.ch-block-act');
        const btn = document.querySelector('.ch-act [data-decide="approve"]');
        const link = document.querySelector('.ch-plan [data-open-file]');
        const idx = (el) => (hero && el) ? Array.prototype.indexOf.call(hero.children, el) : -1;
        return {
          vh: window.innerHeight, homeScrollTop: home.scrollTop,
          planBottom: plan ? Math.round(plan.getBoundingClientRect().bottom) : -1,
          linkBottom: link ? Math.round(link.getBoundingClientRect().bottom) : -1,
          btnBottom: btn ? Math.round(btn.getBoundingClientRect().bottom) : -1,
          btnDisabled: btn ? btn.disabled : null,
          planBeforeAct: idx(plan) >= 0 && idx(act) > idx(plan),
        };
      });
      check('X03-1 1280×768 不滚动读完摘要并摸到确认按钮',
        m.vh === 768 && m.homeScrollTop === 0 && m.planBottom <= m.vh && m.linkBottom <= m.vh && m.btnBottom <= m.vh,
        `viewport=${m.vh} scrollTop=${m.homeScrollTop} 摘要底=${m.planBottom} 链接底=${m.linkBottom} 按钮底=${m.btnBottom}`);
      check('X03-2 顺序：当前状态→计划摘要→查看完整计划→主按钮', m.planBeforeAct === true && m.btnDisabled === false,
        `planBeforeAct=${m.planBeforeAct} disabled=${m.btnDisabled}`);
      await page.screenshot({ path: join(ROOT, 'test', 'r86-x03-1280x768.png') });
      console.log('SHOT test/r86-x03-1280x768.png');
      // console 检查：唯一允许的错误是「丢失计划文件的预期 404」，其余必须为零
      const expected404 = notFounds.filter((u) => u.includes('plan-missing.md')).length;
      const unexpected404 = notFounds.length - expected404;
      check('场景1 零 console.error / pageerror（除丢失文件的预期 404）',
        unexpected404 === 0 && state.consoleErrs.length <= expected404 && state.pageErrors.length === 0,
        `404 共 ${notFounds.length} 个（预期 ${expected404} 个均指向 plan-missing.md），console.error ${state.consoleErrs.length} 条，pageerror ${state.pageErrors.length} 条`);
      await page.close();
    } finally { await stack.stop(); }
  }

  /* ================= 场景 2：X02 混合数据（测试任务最新 + 真实需求较旧） ================= */
  {
    const stack = await startStack([
      verifyTask('TEST-R86X', 'R86 混合场景 · 测试任务（测完即删）', 1),   // 更新时间最新
      verifyTask('T-R86M', 'R86 混合场景真实需求', 5),
    ], { noBase: true });
    try {
      const { page, state } = await newPage(browser);
      await page.goto(stack.base + '/#/', { waitUntil: 'commit' });
      await page.waitForSelector('#cabin-tasks .cabin-task', { timeout: 15000 });
      await page.waitForSelector('#sb-conn.ok', { timeout: 10000 });
      await page.waitForFunction(() => !document.getElementById('tb-decision').hidden, null, { timeout: 10000 });

      const m = await page.evaluate(() => ({
        stripN: document.querySelectorAll('#cabin-tasks .cabin-task').length,
        stripText: (document.querySelector('#cabin-tasks') || {}).textContent || '',
        selTitle: (document.querySelector('.cabin-hero .ch-v') || {}).textContent || '',
        pillHidden: document.getElementById('tb-decision').hidden,
        pillText: (document.getElementById('tb-decision') || {}).textContent || '',
      }));
      check('X02-1 首页任务条不出现测试任务', m.stripN === 1 && m.stripText.includes('真实需求') && !m.stripText.includes('测试任务'), `任务条 ${m.stripN} 条`);
      check('X02-2 默认选中的是真实需求（不是最新的测试任务）', m.selTitle.includes('真实需求'), `选中「${m.selTitle}」`);
      check('X02-3 待确认计数不混入测试审批', !m.pillHidden && /1 件事等你拍板/.test(m.pillText), `胶囊「${m.pillText.trim()}」`);

      // 数据不动：高级工作台两条都在（含测试任务）
      await page.goto(stack.base + '/#/pro', { waitUntil: 'commit' });
      await page.waitForSelector('#reqs-list .req-item', { timeout: 15000 });
      const proN = await page.evaluate(() => document.querySelectorAll('#reqs-list .req-item').length);
      check('X02-4 测试任务只在展示层隐藏（/pro 照常可见）', proN === 2, `/pro 列出 ${proN} 条`);
      check('场景2 零 console.error / pageerror', state.consoleErrs.length === 0 && state.pageErrors.length === 0,
        state.consoleErrs.concat(state.pageErrors).join(' || ').slice(0, 120) || '0 错误');
      await page.close();
    } finally { await stack.stop(); }
  }

  /* ================= 场景 3：X02 全是测试任务 → 首页空状态 ================= */
  {
    const stack = await startStack([
      verifyTask('TEST-R86Z', 'R86 全测试场景（测完即删）', 1),
    ], { noBase: true });
    try {
      const { page, state } = await newPage(browser);
      await page.goto(stack.base + '/#/', { waitUntil: 'commit' });
      await page.waitForSelector('.cabin-empty', { timeout: 15000 });
      await page.waitForSelector('#sb-conn.ok', { timeout: 10000 });
      await sleep(400);   // 等胶囊/任务条按同一拍数据渲染完

      const m = await page.evaluate(() => ({
        emptyH2: (document.querySelector('.cabin-empty h2') || {}).textContent || '',
        emptyBtn: !!document.querySelector('.cabin-empty [data-cabin-newopen]'),
        stripN: document.querySelectorAll('#cabin-tasks .cabin-task').length,
        pillHidden: document.getElementById('tb-decision').hidden,
      }));
      check('X02-5 全是测试任务 → 空状态 + 开始制作第一个软件', m.emptyH2 === '你还没有开始制作软件' && m.emptyBtn === true && m.stripN === 0,
        `h2「${m.emptyH2}」按钮=${m.emptyBtn}`);
      check('X02-6 全测试场景待确认胶囊隐藏', m.pillHidden === true, `hidden=${m.pillHidden}`);

      await page.goto(stack.base + '/#/pro', { waitUntil: 'commit' });
      await page.waitForSelector('#reqs-list .req-item', { timeout: 15000 });
      const proN = await page.evaluate(() => document.querySelectorAll('#reqs-list .req-item').length);
      check('X02-7 测试任务数据不动（/pro 仍可见）', proN === 1, `/pro 列出 ${proN} 条`);
      check('场景3 零 console.error / pageerror', state.consoleErrs.length === 0 && state.pageErrors.length === 0,
        state.consoleErrs.concat(state.pageErrors).join(' || ').slice(0, 120) || '0 错误');
      await page.close();
    } finally { await stack.stop(); }
  }
} finally {
  await browser.close();
  rmSync(DIR, { recursive: true, force: true });   // 计划夹具文件跑完即删
}

const failN = results.filter((r) => !r.ok).length;
console.log(`\nR86 实测汇总：${results.length - failN}/${results.length} 项通过`);
process.exit(failN ? 1 : 0);
