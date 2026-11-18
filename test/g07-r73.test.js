// g07-r73.test.js — 第 73 轮 G01 验收：四页 17 固定场景自动化回归
//
// 场景矩阵（≥16 固定场景的落地版，共 17 条）：
//   初始化 4：P1 工作台 / P2 Agents / P3 技能 / P4 文件库（全局 CSS 200 + 零异常）
//   关键布局 4：L1 双视口导航/头像钉死值 / L2 S01 技能第三排与分页 / L3 F02 文件列宽 /
//               L4 W02 详情密度滚动 + W01 服务端拒绝反馈
//   审批与版本 6：B1 版本一致放行 / B2 内容改+大小改双 409 / B3 重复提交幂等 /
//               B4 并发提交单事件 / B5 F01 异常原因行 + 历史快照不可用不冒充 /
//               B6 登记文件被删除 → decision/decide 双 404 ARTIFACT_FILE_MISSING（第 80 轮）
//   异常恢复 4：R1 A01 上报过期 / R2 A01 无上报与连接分离 / R3 F01 删除→恢复闭环 /
//               R4 人为 CSS 404 必须被回归检出
// 夹具：web/.work/r73-*.txt（FILE_ROOTS 白名单内的真实物理文件），任务 T-R73A-G +
// T-R73W1-3（长文 300/1500/3000 字）。两视口：1440×900 基线 + 1280×768。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, appendFileSync, unlinkSync, existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ROOT, WEB, startStack, launchBrowser, newPage, sleep } from './g07-harness.mjs';

/* ---------------- 夹具物理文件（登记用真实绝对路径，正斜杠口径） ---------------- */
const FIX = join(WEB, '.work').replace(/\\/g, '/');
const fixPath = (n) => `${FIX}/${n}`;
const DIR_PATH = FIX;                       // 目录登记（EISDIR）
const PAGEFILE = 'C:/pagefile.sys';         // statSync 错误码因机而异（本机实测 EINVAL/EBUSY），B5 动态取码断言

const shaOf = (t) => createHash('sha256').update(t, 'utf8').digest('hex');
const iso = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString();

const CLEAN = {
  a: 'R73 审批基线 A：内容与登记一致，用于版本一致放行场景。\n',
  b: 'original',                            // 改写为 tampered（同 8 字节）→ 指纹漂移
  c: 'R73-C-基线：用于大小改写（追加字节）与 W02 长文场景。\n',
  d: 'R73 并发基线 D：内容与登记一致。\n',
  e: 'R73 幂等重放基线 E：内容与登记一致。\n',
  f: 'R73 大小不一致基线 F：实际很短，登记报大。\n',
  r3: 'R73 删除恢复基线 G：内容与登记一致。\n',
  h: 'R73 删除即 404 基线 H：内容与登记一致，起栈后删除。\n',
};

const metaOf = (t) => ({ bytes: Buffer.byteLength(t, 'utf8'), sha256: shaOf(t) });

// 长文备注：精确 300 / 1500 / 3000 字（.length === 目标值），句子真实可读
const longNote = (n) => {
  const unit = '审批详情长文验收：正文按 12px/20px 排版，段落随内容滚动，固定操作区不遮挡末行。';
  let s = unit.repeat(Math.ceil(n / unit.length));
  return s.slice(0, n);
};

/* ---------------- 任务档案 ---------------- */
const mkTask = (id, title, files, verify = {}) => ({
  id, title, createdAt: iso(90), updatedAt: iso(3),
  steps: {
    req: { status: 'done', at: iso(85), note: 'R73 整改任务书（第 73 轮）', by: 'leo' },
    doc: { status: 'done', at: iso(80), note: 'R73 验证文档', by: 'lemate' },
    plan: { status: 'done', at: iso(75), note: '17 场景拆解', by: 'lemate' },
    brief: { status: 'done', at: iso(70), note: '已派发到验收夹具', by: 'lemate' },
    deliverable: { status: 'done', at: iso(30), note: 'R73 夹具交付', by: 'lemate', files },
    verify: { status: verify.status || 'awaiting', at: verify.at || iso(5), note: verify.note || '等 Leo 拍板', by: 'hermes' },
    final: { status: 'pending', at: null, note: '', by: null },
  },
});

const reg = (name) => {
  const t = CLEAN[name];
  return { path: fixPath(`r73-${name}.txt`), ...metaOf(t) };
};

/* ---------------- 套件级夹具：起栈 + 预置漂移 ---------------- */
let stack, browser;

before(async () => {
  mkdirSync(join(WEB, '.work'), { recursive: true });
  for (const k of Object.keys(CLEAN)) writeFileSync(fixPath(`r73-${k}.txt`), CLEAN[k]);
  // r73-missing.txt 刻意不创建（ENOENT 分支的物理事实）
  const tasks = [
    mkTask('T-R73A', 'R73-W01①版本一致放行', [reg('a')]),
    mkTask('T-R73B', 'R73-W01②内容改大小不变', [reg('b')]),
    mkTask('T-R73C', 'R73-W01③大小改+W02长文', [reg('c')], { note: longNote(3000) }),
    mkTask('T-R73D', 'R73-W01⑤并发提交', [reg('d')]),
    mkTask('T-R73E', 'R73-W01④重复提交幂等', [reg('e')]),
    mkTask('T-R73G', 'R73-F01删除恢复闭环', [reg('r3')], { status: 'pending', at: null, note: '' }),
    mkTask('T-R73H', 'R73-W01⑥删除→404', [reg('h')]),
    mkTask('T-R73W1', 'R73-W02 长文 300 字', [reg('a')], { note: longNote(300) }),
    mkTask('T-R73W2', 'R73-W02 长文 1500 字', [reg('a')], { note: longNote(1500) }),
    mkTask('T-R73W3', 'R73-W02 长文 3000 字', [reg('a')], { note: longNote(3000) }),
    {
      id: 'T-R73F', title: 'R73-F01 四类后端错误码', createdAt: iso(90), updatedAt: iso(3),
      steps: {
        req: { status: 'done', at: iso(85), note: '异常原因行需求', by: 'leo' },
        doc: { status: 'done', at: iso(80), note: '', by: 'lemate' },
        plan: { status: 'done', at: iso(75), note: '', by: 'lemate' },
        brief: { status: 'done', at: iso(70), note: '', by: 'lemate' },
        deliverable: {
          status: 'done', at: iso(30), note: '登记四个异常路径', by: 'lemate',
          files: [
            { path: fixPath('r73-missing.txt'), bytes: 12, sha256: shaOf('placeholder-missing') },
            { path: DIR_PATH, bytes: 0, sha256: shaOf('placeholder-dir') },
            { path: PAGEFILE, bytes: 4242424, sha256: shaOf('placeholder-pagefile') },
            { path: fixPath('r73-f.txt'), bytes: 42424, sha256: shaOf('placeholder-f') },
          ],
        },
        verify: { status: 'pending', at: null, note: '', by: null },
        final: { status: 'pending', at: null, note: '', by: null },
      },
    },
  ];
  stack = await startStack(tasks);
  browser = await launchBrowser();
  // B 用漂移在起栈后落笔：登记值是 clean，磁盘改写 → 服务端重读必然不一致
  writeFileSync(fixPath('r73-b.txt'), 'tampered');   // 同 8 字节，仅内容指纹变
  unlinkSync(fixPath('r73-h.txt'));                  // B6：登记在、磁盘没了 → 404 分支
});

after(async () => {
  if (browser) await browser.close();
  if (stack) await stack.stop();   // 临时 home（含 hermes-control.json）随 stop 整目录删除
  for (const k of Object.keys(CLEAN)) { const p = fixPath(`r73-${k}.txt`); if (existsSync(p)) unlinkSync(p); }
});

/* ---------------- 页面侧小工具 ---------------- */
const get = async (p) => {
  const r = await fetch(stack.base + p);
  let b = null; try { b = await r.json(); } catch { /* 保持 null */ }
  return { status: r.status, body: b };
};
const post = async (p, body) => {
  const r = await fetch(stack.base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let b = null; try { b = await r.json(); } catch { /* 保持 null */ }
  return { status: r.status, body: b };
};
const writtenEventsOf = (demandId) => {
  const p = join(stack.home, 'office-data', 'decision-events.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && e.demandId === demandId && e.result === 'written');
};
const openHash = async (page, hash, selector) => {
  await page.goto(stack.base + '/' + hash, { waitUntil: 'commit' });
  await page.waitForSelector(selector, { timeout: 15000 });
};
const rect = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s); if (!el) return null;
  const r = el.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: r.width, h: r.height };
}, sel);
const cs = (page, sel, props) => page.evaluate(({ s, ps }) => {
  const el = document.querySelector(s); if (!el) return null;
  const c = getComputedStyle(el); const o = {};
  for (const p of ps) o[p] = c.getPropertyValue(p);
  return o;
}, { s: sel, ps: props });
const near = (v, target, tol = 1) => Math.abs(v - target) <= tol;

/* ================= 初始化 4 场景 ================= */

test('P1 首页驾驶舱初始化：页面就绪 + 五个全局 CSS 全部 200 + 零异常', async () => {
  const { page, state } = await newPage(browser);
  try {
    // TASK-工作台重做：#/ 首页已是任务驾驶舱（三栏工作台挪到 #/pro 专业视图）。
    // 就绪标记从 #reqs-list 换成驾驶舱业务 DOM：任务卡条 + 现在干什么的实况区。
    await page.goto(stack.base + '/', { waitUntil: 'commit' });
    await page.waitForSelector('#cabin-tasks .cabin-task', { timeout: 15000 });
    await page.waitForSelector('#cabin-main .cabin-now', { timeout: 10000 });
    await page.waitForSelector('#sb-conn.ok', { timeout: 10000 });
    // 任务卡是真实业务内容（夹具 11 条任务，条上限 12），不是空壳
    const cards = await page.locator('#cabin-tasks .cabin-task').count();
    assert.equal(cards, 12, `任务卡应 12 张（夹具 T-R73A-H/G/W1-3/F 全量），实际 ${cards}`);
    const titles = (await page.locator('#cabin-tasks .cabin-task b').allInnerTexts()).join('|');
    assert.ok(titles.includes('R73-W01①版本一致放行'), `任务卡应含夹具标题，实际：${titles.slice(0, 120)}`);
    // 实况区一句话 + 进度条 + 进度文字都是渲染出来的真实数据
    const nowLine = await page.evaluate(() => document.querySelector('#cabin-main .cabin-now h2').textContent.trim());
    assert.ok(nowLine.length > 0, `「现在干什么」一句话应为真实内容，实际「${nowLine}」`);
    const prog = await page.evaluate(() => ({
      bar: !!document.querySelector('#cabin-main .cabin-bar i'),
      text: (document.querySelector('#cabin-main .cabin-progress') || {}).textContent || '',
    }));
    assert.ok(prog.bar, '进度条应渲染');
    assert.match(prog.text, /第 \d+ 项 \/ 共 \d+ 项 · 做完 \d+ 项/, `进度文字应带真实计数，实际「${prog.text}」`);
    const cssStatus = await page.evaluate(async () => {
      const names = ['app-base.css', 'app-workbench.css', 'app-pages.css', 'app-layers.css', 'app-cabin.css'];
      const out = {};
      for (const n of names) { const r = await fetch(n); out[n] = r.status; }
      return out;
    });
    for (const [n, s] of Object.entries(cssStatus)) assert.equal(s, 200, `${n} 应 200，实际 ${s}`);
    assert.equal(state.pageErrors.length, 0, state.pageErrors.join(' || '));
    assert.equal(state.consoleErrs.length, 0, state.consoleErrs.join(' || '));
    console.log('[P1] 驾驶舱就绪（' + nowLine.slice(0, 24) + '），CSS=' + JSON.stringify(cssStatus) + '，零异常');
  } finally { await page.close(); }
});

test('P2 Agents 初始化：≥4 张卡片 + 头像 44×44 + 零异常', async () => {
  const { page, state } = await newPage(browser);
  try {
    await openHash(page, '#/agents', '.agent-select');
    const cards = await page.locator('.agent-select').count();
    assert.ok(cards >= 4, `应至少 4 个 agent 卡（3 Hermes + 1 中台），实际 ${cards}`);
    const ava = await rect(page, '.agent-avatar');
    assert.ok(near(ava.w, 44) && near(ava.h, 44), `头像应 44×44±1，实际 ${ava.w}×${ava.h}`);
    assert.equal(state.pageErrors.length, 0, state.pageErrors.join(' || '));
    assert.equal(state.consoleErrs.length, 0, state.consoleErrs.join(' || '));
    console.log(`[P2] Agents 就绪：${cards} 卡，头像 ${ava.w}×${ava.h}`);
  } finally { await page.close(); }
});

test('P3 技能初始化：12 条索引 / 首页 6 卡双列 + 零异常', async () => {
  const { page, state } = await newPage(browser);
  try {
    await openHash(page, '#/skills', '#skill-list .skill-row');
    const cnt = await page.locator('#skill-list .skill-row').count();
    assert.equal(cnt, 6, `首页应 6 卡（页大小 6），实际 ${cnt}`);
    const counter = await page.evaluate(() => document.getElementById('skill-count').textContent);
    assert.ok(counter.includes('12'), `技能计数应含总数 12，实际「${counter}」`);
    const cols = await cs(page, '#skill-list', ['grid-template-columns']);
    assert.equal(cols['grid-template-columns'].split(' ').length, 2, `应双列，实际 ${cols['grid-template-columns']}`);
    assert.equal(state.pageErrors.length, 0, state.pageErrors.join(' || '));
    assert.equal(state.consoleErrs.length, 0, state.consoleErrs.join(' || '));
    console.log(`[P3] 技能就绪：计数「${counter.trim()}」，首页 ${cnt} 卡双列`);
  } finally { await page.close(); }
});

test('P4 文件库初始化：≥10 行登记 + 零异常', async () => {
  const { page, state } = await newPage(browser);
  try {
    await openHash(page, '#/files', '.library-file');
    const rows = await page.locator('.library-file').count();
    assert.ok(rows >= 10, `应至少 10 行（r73×8 + 目录 + pagefile + app-base.css），实际 ${rows}`);
    assert.equal(state.pageErrors.length, 0, state.pageErrors.join(' || '));
    assert.equal(state.consoleErrs.length, 0, state.consoleErrs.join(' || '));
    console.log(`[P4] 文件库就绪：${rows} 行`);
  } finally { await page.close(); }
});

/* ================= 关键布局 4 场景 ================= */

test('L1 双视口钉死值：导航 56 / 状态栏 56 / 审批栏 328 / 头像 44×44（±1px）', async () => {
  // 每视口一个全新页：SPA 会把「上次所在页」写进 localStorage 并在下次启动时恢复
  // （TASK-R2 刷新不丢位置，产品行为），复用同一页时第二视口会被拉回 #/agents，
  // 工作台 display:none → req-item 永远不可见。新 context = 干净 storage，双视口口径才成立。
  for (const vp of [{ width: 1440, height: 900 }, { width: 1280, height: 768 }]) {
    const { page } = await newPage(browser);
    try {
      await page.setViewportSize(vp);
      // TASK-工作台重做：#/ 首页是驾驶舱，导航/状态栏在新布局里量；
      // 审批栏 328 与选中需求后的交付链都在 #/pro 专业视图（原三栏工作台原样搬过去）。
      await page.goto(stack.base + '/', { waitUntil: 'commit' });
      await page.waitForSelector('#cabin-tasks .cabin-task', { timeout: 15000 });
      const rail = await rect(page, '#rail');
      const sb = await rect(page, '#statusbar');
      const tb = await rect(page, '#topbar');
      assert.ok(near(rail.w, 56), `${vp.width} 视口导航应 56±1，实际 ${rail.w}`);
      assert.ok(near(sb.h, 56), `${vp.width} 状态栏应 56±1，实际 ${sb.h}`);
      await openHash(page, '#/pro', '#reqs-list .req-item');
      await page.click('#reqs-list .req-item');   // 选中需求，审批栏进入布局
      await page.waitForSelector('#center-chain .track-node', { timeout: 8000 });
      const insp = await rect(page, '#inspector');
      assert.ok(near(insp.w, 328), `${vp.width} 审批栏应 328±1，实际 ${insp.w}`);
      await openHash(page, '#/agents', '.agent-avatar');
      const ava = await rect(page, '.agent-avatar');
      assert.ok(near(ava.w, 44) && near(ava.h, 44), `${vp.width} 头像应 44×44±1，实际 ${ava.w}×${ava.h}`);
      console.log(`[L1] ${vp.width}×${vp.height}：rail=${rail.w} sb=${sb.h} insp=${insp.w} topbar=${tb.h} avatar=${ava.w}×${ava.h}`);
    } finally { await page.close(); }
  }
});

test('L2 S01 技能第三排：双视口可完整滚出 + 末卡距分页 ≥12px + 卡片钉死值', async () => {
  const { page } = await newPage(browser);
  try {
    for (const vp of [{ width: 1440, height: 900 }, { width: 1280, height: 768 }]) {
      await page.setViewportSize(vp);
      await openHash(page, '#/skills', '#skill-list .skill-row');
      await page.waitForFunction(() => document.querySelectorAll('#skill-list .skill-row').length >= 6, null, { timeout: 8000 });
      const layout = await page.evaluate(() => {
        const list = document.getElementById('skill-list');
        const cards = [...document.querySelectorAll('#skill-list .skill-row')];
        const page2 = document.getElementById('skill-pagination');
        const c0 = getComputedStyle(cards[0]);
        const lc = getComputedStyle(list);
        return {
          listOv: lc.overflowY, listMinH: lc.minHeight,
          gap: lc.columnGap, rowGap: lc.rowGap, pad: c0.padding, minH: c0.minHeight,
          metaH: getComputedStyle(cards[0].querySelector('.sk-meta')).height,
          desc: (() => { const s = getComputedStyle(cards[0].querySelector('small')); return s.fontSize + '/' + s.lineHeight; })(),
          pagH: page2.getBoundingClientRect().height,
        };
      });
      assert.equal(layout.listOv, 'auto', '技能列表容器应 overflow-y:auto');
      assert.equal(layout.listMinH, '0px', '技能列表容器应 min-height:0');
      assert.equal(layout.minH, '144px', `卡片 min-height 应 144px，实际 ${layout.minH}`);
      assert.ok(near(parseFloat(layout.gap), 16, 0.5) && near(parseFloat(layout.rowGap), 16, 0.5), `列/行间距应 16px，实际 ${layout.gap}/${layout.rowGap}`);
      assert.equal(layout.pad, '16px', `卡片内边距应 16px，实际 ${layout.pad}`);
      assert.ok(near(parseFloat(layout.metaH), 20, 0.5), `标签区应固定 20px，实际 ${layout.metaH}`);
      assert.ok(near(layout.pagH, 56), `分页区应 56px，实际 ${layout.pagH}`);

      // 第三排（第 5/6 张卡）滚到可视区后标签完整可见
      await page.evaluate(() => {
        const cards = document.querySelectorAll('#skill-list .skill-row');
        cards[5].scrollIntoView({ block: 'end' });
      });
      await sleep(120);
      const third = await page.evaluate(() => {
        const list = document.getElementById('skill-list');
        const lr = list.getBoundingClientRect();
        const cards = document.querySelectorAll('#skill-list .skill-row');
        const out = [];
        for (const i of [4, 5]) {
          const m = cards[i].querySelector('.sk-meta').getBoundingClientRect();
          out.push({ i, top: m.top, bottom: m.bottom, visible: m.top >= lr.top && m.bottom <= lr.bottom + 1 });
        }
        return { lr: { top: lr.top, bottom: lr.bottom }, out };
      });
      for (const m of third.out) assert.ok(m.visible, `${vp.width} 视口第 ${m.i + 1} 张卡标签未完整滚出（meta ${m.top.toFixed(1)}~${m.bottom.toFixed(1)}，容器 ${third.lr.top.toFixed(1)}~${third.lr.bottom.toFixed(1)}）`);

      // 滚到底：末卡底部与分页上沿 ≥12px 间距，不重叠
      await page.evaluate(() => { const l = document.getElementById('skill-list'); l.scrollTop = l.scrollHeight; });
      await sleep(120);
      const gap = await page.evaluate(() => {
        const cards = document.querySelectorAll('#skill-list .skill-row');
        const last = cards[cards.length - 1].getBoundingClientRect();
        const pag = document.getElementById('skill-pagination').getBoundingClientRect();
        return { lastBottom: last.bottom, pagTop: pag.top, clearance: pag.top - last.bottom };
      });
      assert.ok(gap.clearance >= 12, `${vp.width} 末卡距分页应 ≥12px，实测 ${gap.clearance.toFixed(1)}px`);
      console.log(`[L2] ${vp.width}×${vp.height}：第三排标签可见，末卡-分页间距 ${gap.clearance.toFixed(1)}px，分页 ${layout.pagH}px，meta ${layout.metaH}，desc ${layout.desc}`);
    }
  } finally { await page.close(); }
});

test('L3 F02 文件行三列：信息自适应 / 版本 220 / 操作 144 + 操作元素 ≥76×36 不换行', async () => {
  const { page } = await newPage(browser);
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openHash(page, '#/files', '.library-file');
    await page.waitForSelector('.lf-actions .lf-preview', { timeout: 8000 });
    const cols = await cs(page, '.library-file', ['grid-template-columns']);
    const parts = cols['grid-template-columns'].split(' ');
    assert.equal(parts.length, 3, `应三列，实际 ${cols['grid-template-columns']}`);
    // getComputedStyle 返回的是解析后的 used px（如 '856px 220px 144px'），不会出现 minmax 字样；
    // 自适应列的口径 = 首列为正 px（随视口伸缩），固定列在下方逐列断言
    assert.ok(/^\d+(\.\d+)?px$/.test(parts[0]) && parseFloat(parts[0]) > 0, `信息列应为自适应正宽，实际 ${parts[0]}`);
    assert.equal(parts[1], '220px', `版本列应 220px，实际 ${parts[1]}`);
    assert.equal(parts[2], '144px', `操作列应 144px（R73/F02），实际 ${parts[2]}`);
    const act = await cs(page, '.lf-actions', ['white-space']);
    assert.equal(act['white-space'], 'nowrap', `操作区文字应不换行，实际 ${act['white-space']}`);
    const btns = await page.evaluate(() => {
      const row = document.querySelector('.library-file');
      const out = {};
      for (const b of ['.lf-locate', '.lf-preview']) {
        const el = row.querySelector(b);
        if (el) { const r = el.getBoundingClientRect(); out[b] = { w: r.width, h: r.height }; }
      }
      return out;
    });
    for (const [k, v] of Object.entries(btns)) {
      assert.ok(v.w >= 76, `${k} 宽应 ≥76px，实际 ${v.w}`);
      assert.ok(near(v.h, 36), `${k} 高应 36±1，实际 ${v.h}`);
    }
    const vrow = await cs(page, '.lf-src', ['font-size', 'line-height', 'white-space', 'text-overflow']);
    assert.equal(vrow['font-size'], '11px', `路径应 11px，实际 ${vrow['font-size']}`);
    assert.equal(vrow['line-height'], '16px', `路径行高应 16px，实际 ${vrow['line-height']}`);
    assert.equal(vrow['white-space'], 'nowrap', `路径应单行省略，实际 ${vrow['white-space']}`);
    assert.equal(vrow['text-overflow'], 'ellipsis', `路径应省略号截断，实际 ${vrow['text-overflow']}`);
    // 版本哈希行：11px 等宽 / 16px 行高（R76/F01 规格更新，原 R73 钉死 17px 已作废）
    const hash = await cs(page, '.lf-lines .lf-size.lf-reg.lf-vrow', ['font-size', 'line-height', 'font-family']);
    assert.equal(hash['font-size'], '11px', `版本哈希应 11px，实际 ${hash['font-size']}`);
    assert.equal(hash['line-height'], '16px', `版本哈希行高应 16px，实际 ${hash['line-height']}`);
    assert.ok(/mono/i.test(hash['font-family']), `版本哈希应等宽字体，实际 ${hash['font-family']}`);

    // 1280×768：无横向溢出
    await page.setViewportSize({ width: 1280, height: 768 });
    await sleep(200);
    const overflow = await page.evaluate(() => ({ sw: document.scrollingElement.scrollWidth, iw: window.innerWidth }));
    assert.ok(overflow.sw <= overflow.iw, `1280 视口不应横向溢出：scrollWidth=${overflow.sw} innerWidth=${overflow.iw}`);
    console.log(`[L3] 列 ${parts.join(' | ')}，locate=${btns['.lf-locate'].w}×${btns['.lf-locate'].h} preview=${btns['.lf-preview'].w}×${btns['.lf-preview'].h}，1280 溢出=${overflow.sw - overflow.iw}px`);
  } finally { await page.close(); }
});

test('L4 W02 详情密度滚动 + W01 服务端拒绝反馈（拍板瞬间文件已改 → 409 红条）', async () => {
  const { page } = await newPage(browser);
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    // TASK-工作台重做：三栏工作台在 #/pro 专业视图，#/ 首页是驾驶舱
    await page.goto(stack.base + '/#/pro', { waitUntil: 'commit' });
    await page.waitForSelector('#reqs-list .req-item', { timeout: 15000 });

    // —— W02：三档长文（300/1500/3000 字）滚到底，末行完整且距操作区 ≥12px ——
    for (const [tid, n] of [['T-R73W1', 300], ['T-R73W2', 1500], ['T-R73W3', 3000]]) {
      await page.click(`.req-item[data-task="${tid}"]`);
      await page.waitForSelector('#center-chain .track-node[data-step="verify"]', { timeout: 8000 });
      await page.click('#center-chain .track-node[data-step="verify"]');
      await page.waitForSelector('#insp-body .ip-note', { timeout: 8000 });
      const noteLen = await page.evaluate(() => document.querySelector('#insp-body .ip-note').textContent.length);
      assert.equal(noteLen, n, `${tid} 正文应 ${n} 字，实际 ${noteLen}`);
      const bodyCs = await cs(page, '#insp-body', ['overflow-y', 'min-height', 'padding-bottom']);
      assert.equal(bodyCs['overflow-y'], 'auto', '正文容器应 overflow-y:auto');
      assert.equal(bodyCs['min-height'], '0px', '正文容器应 min-height:0');
      assert.equal(bodyCs['padding-bottom'], '80px', `底部内边距应 80px，实际 ${bodyCs['padding-bottom']}`);
      await page.evaluate(() => { const b = document.getElementById('insp-body'); b.scrollTop = b.scrollHeight; });
      await sleep(100);
      const cleared = await page.evaluate(() => {
        const note = document.querySelector('#insp-body .ip-note').getBoundingClientRect();
        const foot = document.getElementById('insp-foot').getBoundingClientRect();
        return { noteBottom: note.bottom, footTop: foot.top, gap: foot.top - note.bottom, footH: foot.height };
      });
      assert.ok(cleared.gap >= 12, `${tid} 滚到底末行距操作区应 ≥12px，实测 ${cleared.gap.toFixed(1)}px`);
      if (tid === 'T-R73W3') {
        const noteCs = await cs(page, '#insp-body .ip-note', ['font-size', 'line-height']);
        assert.equal(noteCs['font-size'], '12px', `正文应 12px，实际 ${noteCs['font-size']}`);
        assert.equal(noteCs['line-height'], '20px', `正文行高应 20px，实际 ${noteCs['line-height']}`);
        const evk = await cs(page, '#insp-body .ev-k', ['width']);
        assert.equal(evk.width, '64px', `证据标签列应 64px，实际 ${evk.width}`);
        const footBg = await cs(page, '#insp-foot', ['background-color']);
        assert.equal(footBg['background-color'], 'rgb(17, 24, 35)', `操作区背景应 #111823，实际 ${footBg['background-color']}`);
        assert.ok(near(cleared.footH, 64), `操作区应 64px，实际 ${cleared.footH}`);
        // 段落间距 12px：正文是单 <p>，DOM 无 p+p 时读真实样式表规则（同一口径）
        const pGap = await page.evaluate(() => {
          const pair = document.querySelector('#insp-body .ip-note p + p, #insp-body .rej-why p + p');
          if (pair) return getComputedStyle(pair).marginTop;
          for (const sh of document.styleSheets) {
            let rules; try { rules = sh.cssRules; } catch { continue; }
            for (const r of rules || []) {
              if (r.selectorText && r.selectorText.includes('#insp-body .ip-note p + p')) {
                const v = r.style.getPropertyValue('margin-top'); if (v) return v + '（样式表规则）';
              }
            }
          }
          return null;
        });
        assert.equal(parseFloat(pGap), 12, `段落间距应 12px，实际 ${pGap}`);
      }
      console.log(`[L4/W02] ${tid} ${n} 字：末行-操作区 ${cleared.gap.toFixed(1)}px`);
    }

    // —— W01：拍板瞬间文件被改写 → 服务端重读 409 → 红条反馈 ——
    await page.click('.req-item[data-task="T-R73C"]');
    await page.waitForSelector('#center-chain .track-node[data-step="verify"]', { timeout: 8000 });
    await page.click('#center-chain .track-node[data-step="verify"]');
    await page.waitForSelector('[data-decide="approve"]', { timeout: 8000 });
    await page.waitForFunction(() => {
      const b = document.querySelector('[data-decide="approve"]');
      return b && b.disabled === false;
    }, null, { timeout: 10000 });   // 文件未改时版本门禁应放行（按钮可点）
    await page.fill('#ip-decide-note', 'R73-L4 服务端复核：文件在拍板瞬间已被改写');
    appendFileSync(fixPath('r73-c.txt'), '（拍板前被外部追加的字节）');   // 大小改写（点击前最后一刻）
    await page.click('[data-decide="approve"]');
    await page.waitForSelector('.ip-decide .fb.err', { timeout: 10000 });
    const fb = await cs(page, '.ip-decide .fb.err', ['font-size', 'line-height', 'background-color', 'color']);
    assert.equal(fb['font-size'], '13px', `错误反馈应 13px，实际 ${fb['font-size']}`);
    assert.equal(fb['line-height'], '20px', `错误反馈行高应 20px，实际 ${fb['line-height']}`);
    assert.equal(fb['background-color'], 'rgb(59, 48, 33)', `错误反馈背景应 #3B3021，实际 ${fb['background-color']}`);
    assert.equal(fb.color, 'rgb(229, 185, 94)', `错误反馈文字应 #E5B95E，实际 ${fb.color}`);
    const fbText = await page.evaluate(() => document.querySelector('.ip-decide .fb.err').textContent);
    assert.ok(fbText.includes('登记版本不一致'), `错误文案应点名版本不一致，实际「${fbText.slice(0, 80)}」`);
    assert.ok(fbText.includes('≠ 登记'), `大小改写应报实测≠登记，实际「${fbText.slice(0, 120)}」`);
    console.log(`[L4/W01] 409 红条实测 ${fb['font-size']}/${fb['line-height']} bg=${fb['background-color']} color=${fb.color}`);
  } finally { await page.close(); }
});

/* ================= 审批与文件版本 5 场景（W01 五情况 + F01 服务端口径） ================= */

test('B1 W01-① 版本一致：approve 200 → 1 条成功事件 + 档案 done + 刷新后链路仍 done', async () => {
  const r = await post('/api/office/decision', { demandId: 'T-R73A', stepKey: 'verify', action: 'approve', reason: 'R73-B1 版本一致，允许通过' });
  assert.equal(r.status, 200, `应 200，实际 ${r.status}/${JSON.stringify(r.body)}`);
  assert.equal(r.body.verified, true, `verified 应 true，实际 ${JSON.stringify(r.body).slice(0, 160)}`);
  assert.equal(r.body.to, 'done', `目标态应 done，实际 ${r.body.to}`);
  assert.equal(r.body.event && r.body.event.result, 'written', `事件应 written，实际 ${JSON.stringify(r.body.event)}`);
  const evs = writtenEventsOf('T-R73A');
  assert.equal(evs.length, 1, `T-R73A 成功事件应 1 条，实际 ${evs.length}`);

  const flow = await get('/api/office/flow');
  const v = flow.body.tasks.find((t) => t.id === 'T-R73A').steps.find((s) => s.key === 'verify');
  assert.equal(v.status, 'done', `服务端档案 verify 应 done，实际 ${v.status}`);

  const { page } = await newPage(browser);
  try {
    // TASK-工作台重做：需求列表与交付链在 #/pro 专业视图
    await page.goto(stack.base + '/#/pro', { waitUntil: 'commit' });
    await page.waitForSelector('.req-item[data-task="T-R73A"]', { timeout: 15000 });
    await page.click('.req-item[data-task="T-R73A"]');
    await page.waitForSelector('#center-chain .track-node[data-step="verify"].st-done', { timeout: 8000 });
    console.log('[B1] 200/verified/event=written×1/档案 done/刷新后链路 st-done');
  } finally { await page.close(); }
});

test('B2 W01-②③ 内容改大小不变 + 大小改：双 409 ARTIFACT_VERSION_DRIFT，0 事件，档案不动', async () => {
  const rb = await post('/api/office/decision', { demandId: 'T-R73B', stepKey: 'verify', action: 'approve', reason: '尝试通过指纹漂移产物' });
  assert.equal(rb.status, 409, `T-R73B 应 409，实际 ${rb.status}`);
  assert.equal(rb.body.code, 'ARTIFACT_VERSION_DRIFT', `应 ARTIFACT_VERSION_DRIFT，实际 ${rb.body && rb.body.code}`);
  assert.ok(String(rb.body.error).includes('内容已变化'), `同尺寸改内容应报内容指纹变化，实际「${rb.body.error}」`);
  const rc = await post('/api/office/decision', { demandId: 'T-R73C', stepKey: 'verify', action: 'approve', reason: '尝试通过大小漂移产物' });
  assert.equal(rc.status, 409, `T-R73C 应 409，实际 ${rc.status}`);
  assert.ok(String(rc.body.error).includes('≠ 登记'), `大小改应报实测≠登记，实际「${rc.body.error}」`);
  assert.equal(writtenEventsOf('T-R73B').length, 0, '不一致时成功事件必须为 0');
  assert.equal(writtenEventsOf('T-R73C').length, 0, '不一致时成功事件必须为 0');
  const flow = await get('/api/office/flow');
  for (const id of ['T-R73B', 'T-R73C']) {
    const v = flow.body.tasks.find((t) => t.id === id).steps.find((s) => s.key === 'verify');
    assert.equal(v.status, 'awaiting', `${id} 409 后应仍 awaiting，实际 ${v.status}`);
  }
  console.log('[B2] ② sha 漂移 409 + ③ bytes 漂移 409，事件 0，verify 均 awaiting');
});

test('B3 W01-④ 重复提交：decision 重提 409 不加事件；decide 同 opId 重放单次写回', async () => {
  // ④a 新端点：同一步骤已 done 后再 approve → 409，不产生第二条成功事件
  const again = await post('/api/office/decision', { demandId: 'T-R73A', stepKey: 'verify', action: 'approve', reason: '重复提交同一审批' });
  assert.equal(again.status, 409, `应 409，实际 ${again.status}`);
  assert.equal(again.body.code, 'NOT_ACTIONABLE', `应 NOT_ACTIONABLE，实际 ${again.body && again.body.code}`);
  assert.equal(writtenEventsOf('T-R73A').length, 1, `重提后成功事件仍应 1 条，实际 ${writtenEventsOf('T-R73A').length}`);

  // ④b 旧端点（带 opId）：同 opId 重放 → 200 replay=true，档案只写一次
  const op = { taskId: 'T-R73E', step: 'verify', action: 'approve', note: 'R73-B3 幂等重放', opId: 'op-r73-replay' };
  const r1 = await post('/api/office/decide', op);
  assert.equal(r1.status, 200, `首次 decide 应 200，实际 ${r1.status}/${JSON.stringify(r1.body)}`);
  assert.equal(r1.body.verified, true, `首次写回应 verified=true，实际 ${JSON.stringify(r1.body).slice(0, 160)}`);
  const firstAt = r1.body.after && r1.body.after.at;
  assert.ok(firstAt, '首次写回应带回 after.at');
  const r2 = await post('/api/office/decide', op);
  assert.equal(r2.status, 200, `重放应 200，实际 ${r2.status}`);
  assert.equal(r2.body.replay, true, `重放应标记 replay:true，实际 ${JSON.stringify(r2.body).slice(0, 160)}`);
  assert.equal(r2.body.after && r2.body.after.at, firstAt, '重放返回的应是首次结果，不是二次写回');
  const onDisk = JSON.parse(readFileSync(join(stack.home, 'office-data', 'tasks', 'T-R73E.json'), 'utf8'));
  assert.equal(onDisk.steps.verify.at, firstAt, `档案 verify.at 应等于首次写回时刻（单次写），实际 ${onDisk.steps.verify.at}`);
  console.log('[B3] decision 重提 409（事件仍 1）；decide 重放 replay:true，档案单次写回');
});

test('B4 W01-⑤ 并发提交：同拍板两请求 → [200,409]，成功事件恰 1 条', async () => {
  const body = { demandId: 'T-R73D', stepKey: 'verify', action: 'approve', reason: 'R73-B4 并发提交' };
  const [x1, x2] = await Promise.all([post('/api/office/decision', body), post('/api/office/decision', body)]);
  const statuses = [x1.status, x2.status].sort().join(',');
  assert.equal(statuses, '200,409', `并发应一成一拒（200,409），实际 ${statuses} / ${JSON.stringify(x1.body)} / ${JSON.stringify(x2.body)}`);
  assert.equal(writtenEventsOf('T-R73D').length, 1, `并发后成功事件应恰 1 条，实际 ${writtenEventsOf('T-R73D').length}`);
  const flow = await get('/api/office/flow');
  const v = flow.body.tasks.find((t) => t.id === 'T-R73D').steps.find((s) => s.key === 'verify');
  assert.equal(v.status, 'done', `档案应 done（未撕裂），实际 ${v.status}`);
  console.log(`[B4] 并发结果 ${statuses}，事件 1 条，verify done`);
});

test('B5 F01 异常原因行：四类真实错误码文案 + 快照不可用不拿磁盘冒充 + 抽屉原因', async () => {
  const { page } = await newPage(browser);
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openHash(page, '#/files', '.library-file');
    // 四行各自等到 file-check 实测落地（miss / mism 是异步轮询结果）
    await page.waitForFunction(() => {
      const el = document.querySelector('.library-file[data-open-file$="r73-missing.txt"]');
      return el && el.classList.contains('miss') && el.querySelector('.lf-reason');
    }, null, { timeout: 12000 });
    await page.waitForFunction(() => {
      const el = document.querySelector('.library-file[data-open-file$="pagefile.sys"]');
      return el && el.classList.contains('miss') && el.querySelector('.lf-reason');
    }, null, { timeout: 12000 });
    await page.waitForFunction(() => {
      const el = document.querySelector('.library-file[data-open-file$="r73-f.txt"]');
      return el && !el.classList.contains('miss') && el.querySelector('.lf-reason');
    }, null, { timeout: 12000 });

    const rows = await page.evaluate(() => {
      const pick = (suffix) => document.querySelector(`.library-file[data-open-file$="${suffix}"]`);
      const info = (el) => {
        const reason = el.querySelector('.lf-reason');
        const c = reason ? getComputedStyle(reason) : null;
        return {
          miss: el.classList.contains('miss'),
          border: getComputedStyle(el).borderTopColor,
          text: reason ? reason.textContent : null,
          font: c ? `${c.fontSize}/${c.lineHeight}` : null,
          color: c ? c.color : null,
          maxH: c ? c.maxHeight : null,
        };
      };
      return {
        missing: info(pick('r73-missing.txt')),
        dir: info(pick('.work')),
        pagefile: info(pick('pagefile.sys')),
        f: info(pick('r73-f.txt')),
      };
    });
    // ENOENT（文件删除）
    assert.ok(rows.missing.miss, '缺失行应有 miss 态');
    assert.equal(rows.missing.border, 'rgb(229, 107, 111)', `红边框应 #E56B6F，实际 ${rows.missing.border}`);
    assert.equal(rows.missing.text, '文件已删除或移走（ENOENT：登记路径当前不存在）', `ENOENT 文案，实际「${rows.missing.text}」`);
    // EISDIR（登记为目录）
    assert.ok(rows.dir.miss, '目录登记行应不可校验');
    assert.equal(rows.dir.text, '登记路径是目录不是文件（EISDIR），无法当产物校验', `EISDIR 文案，实际「${rows.dir.text}」`);
    // pagefile：本机对系统页文件的真实 statSync 错误码（EINVAL/EBUSY 因机而异）——
    // 不写死单一码，先从 file-check 拿本机实测 errCode，再断言原因行带出该码。
    // 码落在已知分类（EACCES/EPERM 等）则应给准确文案，未知码走统一说明——两条分支都算过。
    const pf = await post('/api/office/file-check', { paths: [PAGEFILE] });
    const pfCode = pf.body?.results?.[0]?.errCode;
    assert.ok(typeof pfCode === 'string' && pfCode,
      `pagefile 应带回真实 errCode，实际 ${JSON.stringify(pf.body).slice(0, 160)}`);
    const KNOWN = { ENOENT: 1, EACCES: 1, EPERM: 1, EISDIR: 1 };
    assert.ok(rows.pagefile.text.includes(pfCode),
      `原因行应带出真实错误码 ${pfCode}，实际「${rows.pagefile.text}」`);
    if (!KNOWN[pfCode]) {
      assert.ok(rows.pagefile.text.includes('未收录进已知分类'),
        `未知码 ${pfCode} 应统一说明并带出真实码，实际「${rows.pagefile.text}」`);
    }
    // 大小不一致（可读但与登记不符）
    assert.ok(!rows.f.miss, '大小不一致行不是不可读（无双红框语义）');
    const fActual = Buffer.byteLength(CLEAN.f, 'utf8');
    assert.equal(rows.f.text, `实测 ${fActual} B 与登记版本不符（大小不一致，内容已变化）`, `mism 文案应带实测值，实际「${rows.f.text}」`);
    for (const k of ['missing', 'dir', 'pagefile', 'f']) {
      assert.equal(rows[k].font, '12px/18px', `${k} 原因行应 12px/18px，实际 ${rows[k].font}`);
      assert.equal(rows[k].color, 'rgb(232, 164, 167)', `${k} 原因行应 #E8A4A7，实际 ${rows[k].color}`);
      assert.equal(rows[k].maxH, '36px', `${k} 原因行最多 2 行（36px），实际 ${rows[k].maxH}`);
    }

    // 历史快照不可用：登记版本无留档 → 不提供原文，绝不回当前磁盘内容冒充
    const regC = metaOf(CLEAN.c);
    const q = `path=${encodeURIComponent(fixPath('r73-c.txt'))}&taskId=T-R73C&stepKey=deliverable&vkey=sha:${regC.sha256}`;
    const fv = await get('/api/office/file-version?' + q);
    assert.equal(fv.status, 404, `无留档快照应 404（F01 第 78 轮），实际 ${fv.status}`);
    assert.equal(fv.body.available, false, `无留档快照不得 available，实际 ${JSON.stringify(fv.body).slice(0, 160)}`);
    assert.equal(fv.body.reason, 'no-snapshot', `应 no-snapshot，实际 ${fv.body.reason}`);
    assert.equal(fv.body.text, undefined, '快照不可用时不得夹带 text（不得用当前物理文件冒充历史内容）');

    // 抽屉：不可校验行的「原因」行来自同一 errCode 映射
    await page.click('.library-file[data-open-file$="r73-missing.txt"] .lf-preview');
    await page.waitForSelector('#file-view.open', { timeout: 8000 });
    const cause = await page.evaluate(() => {
      const rows2 = [...document.querySelectorAll('#file-view .fvd-row')];
      const r = rows2.find((x) => x.textContent.includes('原因'));
      return r ? r.textContent.trim() : null;
    });
    assert.ok(cause && cause.includes('ENOENT'), `抽屉原因行应含 ENOENT 映射，实际「${cause}」`);
    console.log(`[B5] 四类文案落位（${rows.missing.text.slice(0, 10)}… / EISDIR / ${pfCode} 统一 / 实测 ${fActual}B），12px/18px #E8A4A7 36px，no-snapshot 无 text，抽屉原因行在`);
  } finally { await page.close(); }
});

test('B6 W01-⑥ 登记文件被删除：decision/decide 双 404 ARTIFACT_FILE_MISSING，0 事件，档案不动', async () => {
  // 第 80 轮分码：missing（审批对象没了）不再与版本漂移共用 409，两端口同口径
  const rh = await post('/api/office/decision', { demandId: 'T-R73H', stepKey: 'verify', action: 'approve', reason: '尝试通过已删除的产物' });
  assert.equal(rh.status, 404, `T-R73H 应 404（文件不存在），实际 ${rh.status}`);
  assert.equal(rh.body.code, 'ARTIFACT_FILE_MISSING', `应 ARTIFACT_FILE_MISSING，实际 ${rh.body && rh.body.code}`);
  assert.ok(String(rh.body.error).includes('文件不存在'), `应报文件不存在，实际「${rh.body.error}」`);
  const rh2 = await post('/api/office/decide', { taskId: 'T-R73H', step: 'verify', action: 'approve', note: 'R73-B6 decide 口径', opId: 'op-r73-missing' });
  assert.equal(rh2.status, 404, `decide 应 404，实际 ${rh2.status}`);
  assert.equal(rh2.body.code, 'ARTIFACT_FILE_MISSING', `decide 应 ARTIFACT_FILE_MISSING，实际 ${rh2.body && rh2.body.code}`);
  assert.equal(writtenEventsOf('T-R73H').length, 0, '删除场景成功事件必须为 0');
  const flow = await get('/api/office/flow');
  const v = flow.body.tasks.find((t) => t.id === 'T-R73H').steps.find((s) => s.key === 'verify');
  assert.equal(v.status, 'awaiting', `404 后应仍 awaiting，实际 ${v.status}`);
  console.log('[B6] 删除产物 decision/decide 双 404 ARTIFACT_FILE_MISSING，事件 0，verify awaiting');
});

/* ================= 异常恢复 4 场景 ================= */

test('R1 A01-①② 上报新鲜度：新鲜绿 / 超 300 秒琥珀「已过期」+ 明细阈值', async () => {
  const { page } = await newPage(browser);
  try {
    await openHash(page, '#/agents', '.agent-select[data-agent="lemate"]');
    // ① 新鲜（夹具默认 lastReport=now）
    await page.waitForSelector('.agent-select[data-agent="lemate"] .ag-hb.ok', { timeout: 10000 });
    const fresh = await cs(page, '.agent-select[data-agent="lemate"] .ag-hb', ['color']);
    assert.equal(fresh.color, 'rgb(101, 217, 177)', `新鲜应 #65D9B1，实际 ${fresh.color}`);
    await page.click('.agent-select[data-agent="lemate"]');
    await page.waitForSelector('.agent-card .agent-detail', { timeout: 8000 });
    const detailFresh = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.agent-card .agent-kv')];
      const r = rows.find((x) => x.children[0].textContent.includes('上报新鲜度'));
      return r ? r.children[1].textContent : null;
    });
    assert.ok(detailFresh && detailFresh.startsWith('正常（'), `新鲜明细应「正常（…）」，实际「${detailFresh}」`);
    // ② 超 300 秒 → 过期琥珀
    writeFileSync(join(stack.home, 'hermes-control.json'), JSON.stringify({
      lemate: { lastReport: new Date(Date.now() - 600000).toISOString(), reportStale: true },
    }));
    await page.reload({ waitUntil: 'commit' });
    await page.waitForSelector('.agent-select[data-agent="lemate"] .ag-hb.stale', { timeout: 10000 });
    const stale = await page.evaluate(() => {
      const el = document.querySelector('.agent-select[data-agent="lemate"] .ag-hb');
      return { text: el.textContent.trim(), color: getComputedStyle(el).color };
    });
    assert.ok(stale.text.startsWith('已过期 ·'), `过期文案应「已过期 · 时间」，实际「${stale.text}」`);
    assert.equal(stale.color, 'rgb(229, 185, 94)', `过期应 #E5B95E，实际 ${stale.color}`);
    await page.click('.agent-select[data-agent="lemate"]');
    await page.waitForSelector('.agent-card .agent-detail', { timeout: 8000 });
    const detailStale = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.agent-card .agent-kv')];
      const r = rows.find((x) => x.children[0].textContent.includes('上报新鲜度'));
      return r ? r.children[1].textContent : null;
    });
    assert.ok(detailStale && detailStale.includes('已过期（') && detailStale.includes('超 300 秒阈值'), `过期明细应带阈值说明，实际「${detailStale}」`);
    console.log(`[R1] 新鲜 #65D9B1「${detailFresh}」→ 过期 #E5B95E「${stale.text}」明细「${detailStale}」`);
  } finally { await page.close(); }
});

test('R2 A01-③④ 无上报显示 — 不编造；连接离线不吞新鲜上报；中台上报停滞不判离线', async () => {
  const { page } = await newPage(browser);
  try {
    // ③ 从未上报：hb=「—」，明细不发明时间
    writeFileSync(join(stack.home, 'hermes-control.json'), JSON.stringify({ lemate: { lastReport: null } }));
    await openHash(page, '#/agents', '.agent-select[data-agent="lemate"]');
    await page.waitForSelector('.agent-select[data-agent="lemate"] .ag-hb.off', { timeout: 10000 });
    const none = await page.evaluate(() => document.querySelector('.agent-select[data-agent="lemate"] .ag-hb').textContent.trim());
    assert.equal(none, '—', `无上报应显示「—」，实际「${none}」`);
    await page.click('.agent-select[data-agent="lemate"]');
    await page.waitForSelector('.agent-card .agent-detail', { timeout: 8000 });
    const noneRows = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.agent-card .agent-kv')];
      const get = (k) => { const r = rows.find((x) => x.children[0].textContent.includes(k)); return r ? r.children[1].textContent : null; };
      return { hb: get('上报新鲜度'), self: get('上次自报') };
    });
    assert.equal(noneRows.hb, '—（从未上报，缺上报时间）', `无上报明细口径，实际「${noneRows.hb}」`);
    assert.equal(noneRows.self, '从未上报', `上次自报不得编造，实际「${noneRows.self}」`);

    // ④a Hermes 连接离线但上报新鲜：连接=离线，上报仍是新鲜绿（两口径互不吞）
    writeFileSync(join(stack.home, 'hermes-control.json'), JSON.stringify({
      lemate: { online: false, lastReport: new Date(Date.now() - 60000).toISOString(), reportStale: false },
    }));
    await page.reload({ waitUntil: 'commit' });
    await page.waitForSelector('.agent-select[data-agent="lemate"] .ag-conn.off', { timeout: 10000 });
    const mixed = await page.evaluate(() => {
      const btn = document.querySelector('.agent-select[data-agent="lemate"]');
      const conn = btn.querySelector('.ag-conn');
      const hb = btn.querySelector('.ag-hb');
      return { connText: conn.textContent.trim(), connCls: conn.className, hbCls: hb.className, hbColor: getComputedStyle(hb).color };
    });
    assert.equal(mixed.connText, '离线', `连接应「离线」，实际「${mixed.connText}」`);
    assert.ok(mixed.hbCls.includes('ok'), `连接断不吞上报：hb 应仍 ok，实际 ${mixed.hbCls}`);
    assert.equal(mixed.hbColor, 'rgb(101, 217, 177)', `新鲜上报应保持 #65D9B1，实际 ${mixed.hbColor}`);

    // ④b 中台 agent 心跳 600 秒前：连接=在线（上报停滞），不因过期改判离线
    stack.hub.agentMode = 'stale600';
    await page.reload({ waitUntil: 'commit' });
    await page.waitForSelector('.agent-select[data-agent="codex"]', { timeout: 10000 });
    const codex = await page.evaluate(() => {
      const btn = document.querySelector('.agent-select[data-agent="codex"]');
      const conn = btn.querySelector('.ag-conn');
      const hb = btn.querySelector('.ag-hb');
      return { connText: conn.textContent.trim(), connCls: conn.className, hbCls: hb.className };
    });
    assert.ok(codex.connText.includes('在线') && !codex.connText.includes('离线'), `上报停滞的连接应仍在线，实际「${codex.connText}」`);
    assert.ok(codex.connCls.includes('ok'), `连接类应 ok，实际 ${codex.connCls}`);
    assert.ok(codex.hbCls.includes('stale'), `600 秒上报应过期，实际 ${codex.hbCls}`);
    console.log(`[R2] 无上报「—」/明细不编造；离线×新鲜 hb=${mixed.hbCls}；codex 停滞 conn「${codex.connText}」hb=${codex.hbCls}`);
  } finally {
    stack.hub.agentMode = null;
    await page.close();
  }
});

test('R3 F01 删除→恢复闭环：同一登记 ok→miss(ENOENT)→ok，原因行随物理事实出现/消失', async () => {
  const { page } = await newPage(browser);
  try {
    const rowSel = '.library-file[data-open-file$="r73-r3.txt"]';
    const rowState = () => page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      return { miss: el.classList.contains('miss'), ok: !!el.querySelector('.lf-size.ok'), reason: el.querySelector('.lf-reason') ? el.querySelector('.lf-reason').textContent : null };
    }, rowSel);
    await openHash(page, '#/files', rowSel);
    await page.waitForFunction((s) => {
      const el = document.querySelector(s);
      return el && el.querySelector('.lf-size.ok') && !el.querySelector('.lf-reason');
    }, rowSel, { timeout: 12000 });
    let st = await rowState();
    assert.ok(st.ok && !st.miss && !st.reason, `初始应 ok 无原因行，实际 ${JSON.stringify(st)}`);

    unlinkSync(fixPath('r73-r3.txt'));
    await page.reload({ waitUntil: 'commit' });
    await page.waitForSelector(rowSel, { timeout: 15000 });
    await page.waitForFunction((s) => {
      const el = document.querySelector(s);
      return el && el.classList.contains('miss') && el.querySelector('.lf-reason');
    }, rowSel, { timeout: 12000 });
    st = await rowState();
    assert.ok(st.miss, '删除后应 miss');
    assert.equal(st.reason, '文件已删除或移走（ENOENT：登记路径当前不存在）', `删除后原因行，实际「${st.reason}」`);

    writeFileSync(fixPath('r73-r3.txt'), CLEAN.r3);
    await page.reload({ waitUntil: 'commit' });
    await page.waitForSelector(rowSel, { timeout: 15000 });
    await page.waitForFunction((s) => {
      const el = document.querySelector(s);
      return el && el.querySelector('.lf-size.ok') && !el.querySelector('.lf-reason');
    }, rowSel, { timeout: 12000 });
    st = await rowState();
    assert.ok(st.ok && !st.reason, `恢复后应回到 ok 且原因行消失，实际 ${JSON.stringify(st)}`);
    console.log('[R3] ok → ENOENT miss+原因行 → 恢复 ok，闭环一致');
  } finally { await page.close(); }
});

test('R4 人为 CSS 404：回归口径必须检出（样式表 404 + 计算样式偏离）', async () => {
  const { page, state } = await newPage(browser);
  const cssResponses = {};
  page.on('response', (r) => {
    const u = r.url();
    for (const n of ['app-base.css', 'app-workbench.css', 'app-pages.css', 'app-layers.css']) {
      if (u.endsWith('/' + n)) cssResponses[n] = r.status();
    }
  });
  try {
    await page.route('**/app-layers.css', (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: 'gone' }));
    await openHash(page, '#/files', '.library-file');
    await page.waitForFunction(() => {
      const el = document.querySelector('.library-file[data-open-file$="r73-missing.txt"]');
      return el && el.querySelector('.lf-reason');
    }, null, { timeout: 12000 });
    assert.equal(cssResponses['app-layers.css'], 404, `注入的样式表应 404，实际 ${cssResponses['app-layers.css']}`);
    assert.equal(cssResponses['app-base.css'], 200, `其余样式表应 200，实际 ${JSON.stringify(cssResponses)}`);
    const probe = await page.evaluate(() => {
      const el = document.querySelector('.library-file[data-open-file$="r73-missing.txt"]');
      const reason = el.querySelector('.lf-reason');
      return {
        reasonFont: reason ? getComputedStyle(reason).fontSize : null,
        missBorder: getComputedStyle(el).borderTopColor,
        pagination: getComputedStyle(document.getElementById('skill-pagination')).minHeight,
      };
    });
    const deviated = probe.reasonFont !== '12px' || probe.missBorder !== 'rgb(229, 107, 111)';
    assert.ok(deviated, `CSS 404 后计算样式必须偏离钉死值（否则回归测不出），实测 ${JSON.stringify(probe)}`);
    console.log(`[R4] app-layers.css=404 检出：reasonFont=${probe.reasonFont} missBorder=${probe.missBorder}（正常值 12px / rgb(229,107,111)）→ 回归口径可拦截`);
  } finally { await page.close(); }
});
