// verify-w01-r80.mjs — W01 第 80 轮：提交时服务端全量 SHA-256 复核的六组实测。
// 口径（任务书）：审批通过瞬间服务端重新读取物理文件算完整 SHA-256 与登记版本比对；
//   指纹不一致 → 409；文件不存在 → 404（第 80 轮新增：missing 与漂移分码）；
//   失败场景 0 条成功事件；同 opId 重复提交至多 1 条成功事件；并发两发一成一拒。
//   前端指纹展示保留（.msha 12px/18px/#65D9B1），全程零 pageerror / console.error。
import { writeFileSync, appendFileSync, unlinkSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { WEB, startStack, launchBrowser, newPage, sleep } from '../test/g07-harness.mjs';

const FIX = join(WEB, '.work').replace(/\\/g, '/');
const fixPath = (n) => `${FIX}/${n}`;
const shaOf = (t) => createHash('sha256').update(t, 'utf8').digest('hex');
const metaOf = (t) => ({ bytes: Buffer.byteLength(t, 'utf8'), sha256: shaOf(t) });
const iso = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString();

const CLEAN = {
  a: 'R80 审批基线 A：内容与登记一致，正常放行 + UI 指纹展示。\n',
  b: 'original',                        // 起栈后改写 tampered（同 8 字节）→ why=sha
  c: 'R80-C-基线：起栈后追加字节 → why=bytes。\n',
  d: 'R80-D-基线：起栈后删除 → why=missing（404 新分支）。\n',
  e: 'R80 幂等重放基线 E：内容与登记一致。\n',
  f: 'R80 并发基线 F：内容与登记一致。\n',
};
const reg = (k) => ({ path: fixPath(`r80-${k}.txt`), ...metaOf(CLEAN[k]) });

const mkTask = (id, title, files) => ({
  id, title, createdAt: iso(60), updatedAt: iso(3),
  steps: {
    req: { status: 'done', at: iso(55), note: 'W01 第 80 轮任务书', by: 'leo' },
    doc: { status: 'done', at: iso(50), note: '', by: 'lemate' },
    plan: { status: 'done', at: iso(45), note: '', by: 'lemate' },
    brief: { status: 'done', at: iso(40), note: '', by: 'lemate' },
    deliverable: { status: 'done', at: iso(20), note: 'R80 夹具交付', by: 'lemate', files },
    verify: { status: 'awaiting', at: iso(3), note: '等 Leo 拍板', by: 'hermes' },
    final: { status: 'pending', at: null, note: '', by: null },
  },
});

const TASKS = [
  mkTask('T-W80V', 'R80-W01 指纹展示（不提交）', [reg('a')]),
  mkTask('T-W80A', 'R80-W01①正常文件放行', [reg('a')]),
  mkTask('T-W80B', 'R80-W01②同大小不同内容', [reg('b')]),
  mkTask('T-W80C', 'R80-W01④版本变更（大小漂移）', [reg('c')]),
  mkTask('T-W80D', 'R80-W01③文件删除', [reg('d')]),
  mkTask('T-W80E', 'R80-W01⑤同 opId 重复提交', [reg('e')]),
  mkTask('T-W80F', 'R80-W01⑥两路并发提交', [reg('f')]),
];

let allOk = true;
const check = (ok, label, detail) => { console.log(`${ok ? '✅' : '❌'} ${label}${detail ? '：' + detail : ''}`); if (!ok) allOk = false; };

const post = async (stack, p, body) => {
  const r = await fetch(stack.base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let b = null; try { b = await r.json(); } catch { /* 保持 null */ }
  return { status: r.status, body: b };
};
const writtenEventsOf = (stack, demandId) => {
  const p = join(stack.home, 'office-data', 'decision-events.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && e.demandId === demandId && e.result === 'written');
};
const verifyStatusOf = async (stack, id) => {
  const r = await fetch(stack.base + '/api/office/flow').then((x) => x.json());
  return r.tasks.find((t) => t.id === id).steps.find((s) => s.key === 'verify').status;
};

async function main() {
  for (const k of Object.keys(CLEAN)) writeFileSync(fixPath(`r80-${k}.txt`), CLEAN[k]);
  const stack = await startStack(TASKS);
  // 起栈后落漂移：登记值 = CLEAN，磁盘现状按下组各自破坏
  writeFileSync(fixPath('r80-b.txt'), 'tampered');                                  // 同 8 字节换内容
  appendFileSync(fixPath('r80-c.txt'), '（提交后追加的字节）');                       // 大小漂移
  unlinkSync(fixPath('r80-d.txt'));                                                  // 文件没了
  const browser = await launchBrowser();
  try {
    /* —— ① 正常文件：200 + 恰 1 条成功事件 —— */
    const g1 = await post(stack, '/api/office/decision', { demandId: 'T-W80A', stepKey: 'verify', action: 'approve', reason: 'R80① 正常文件放行' });
    check(g1.status === 200, '① 正常文件 → 200', `status=${g1.status}`);
    check(writtenEventsOf(stack, 'T-W80A').length === 1, '① 成功事件恰 1 条', `events=${writtenEventsOf(stack, 'T-W80A').length}`);

    /* —— ② 同大小不同内容：409 指纹漂移 + 0 事件 + 仍 awaiting —— */
    const g2 = await post(stack, '/api/office/decision', { demandId: 'T-W80B', stepKey: 'verify', action: 'approve', reason: 'R80② 同大小换内容' });
    check(g2.status === 409 && g2.body.code === 'ARTIFACT_VERSION_DRIFT', '② → 409 ARTIFACT_VERSION_DRIFT', `status=${g2.status} code=${g2.body && g2.body.code}`);
    check(String(g2.body.error || '').includes('内容已变化'), '② 文案报内容指纹变化', `"${String(g2.body.error).slice(0, 52)}…"`);
    check(writtenEventsOf(stack, 'T-W80B').length === 0, '② 失败 0 条成功事件', `events=${writtenEventsOf(stack, 'T-W80B').length}`);
    check((await verifyStatusOf(stack, 'T-W80B')) === 'awaiting', '② 拍板不动，仍 awaiting', await verifyStatusOf(stack, 'T-W80B'));

    /* —— ③ 文件删除：404 ARTIFACT_FILE_MISSING（两端口同口径）+ 0 事件 —— */
    const g3 = await post(stack, '/api/office/decision', { demandId: 'T-W80D', stepKey: 'verify', action: 'approve', reason: 'R80③ 文件已被删除' });
    check(g3.status === 404 && g3.body.code === 'ARTIFACT_FILE_MISSING', '③ decision → 404 ARTIFACT_FILE_MISSING', `status=${g3.status} code=${g3.body && g3.body.code}`);
    check(String(g3.body.error || '').includes('文件不存在'), '③ 文案报「文件不存在」', `"${String(g3.body.error).slice(0, 40)}…"`);
    const g3d = await post(stack, '/api/office/decide', { taskId: 'T-W80D', step: 'verify', action: 'approve', note: 'R80③ decide 口径', opId: 'r80-missing-decide' });
    check(g3d.status === 404 && g3d.body.code === 'ARTIFACT_FILE_MISSING', '③ decide → 404 ARTIFACT_FILE_MISSING', `status=${g3d.status} code=${g3d.body && g3d.body.code}`);
    check(writtenEventsOf(stack, 'T-W80D').length === 0, '③ 失败 0 条成功事件', `events=${writtenEventsOf(stack, 'T-W80D').length}`);
    check((await verifyStatusOf(stack, 'T-W80D')) === 'awaiting', '③ 档案不动，仍 awaiting', await verifyStatusOf(stack, 'T-W80D'));

    /* —— ④ 版本变更（大小漂移）：409 + 0 事件 —— */
    const g4 = await post(stack, '/api/office/decision', { demandId: 'T-W80C', stepKey: 'verify', action: 'approve', reason: 'R80④ 登记后追加字节' });
    check(g4.status === 409 && g4.body.code === 'ARTIFACT_VERSION_DRIFT', '④ → 409 ARTIFACT_VERSION_DRIFT', `status=${g4.status} code=${g4.body && g4.body.code}`);
    check(String(g4.body.error || '').includes('≠ 登记'), '④ 文案报实测≠登记', `"${String(g4.body.error).slice(0, 40)}…"`);
    check(writtenEventsOf(stack, 'T-W80C').length === 0, '④ 失败 0 条成功事件', `events=${writtenEventsOf(stack, 'T-W80C').length}`);

    /* —— ⑤ 同 opId 重复提交：至多 1 条成功事件 —— */
    const again = await post(stack, '/api/office/decision', { demandId: 'T-W80A', stepKey: 'verify', action: 'approve', reason: 'R80⑤ decision 重提' });
    check(again.status === 409 && again.body.code === 'NOT_ACTIONABLE', '⑤ decision 重提 → 409 NOT_ACTIONABLE', `status=${again.status} code=${again.body && again.body.code}`);
    check(writtenEventsOf(stack, 'T-W80A').length === 1, '⑤ 成功事件仍 1 条（无第二条）', `events=${writtenEventsOf(stack, 'T-W80A').length}`);
    const op = { taskId: 'T-W80E', step: 'verify', action: 'approve', note: 'R80⑤ decide 幂等', opId: 'r80-opid-replay' };
    const r1 = await post(stack, '/api/office/decide', op);
    const r2 = await post(stack, '/api/office/decide', op);
    const firstAt = r1.body && r1.body.after && r1.body.after.at;
    check(r1.status === 200 && r1.body.verified === true, '⑤ decide 首发写回 verified=true', `status=${r1.status} verified=${r1.body && r1.body.verified}`);
    check(r2.status === 200 && r2.body.replay === true, '⑤ 同 opId 重放 replay:true', `status=${r2.status} replay=${r2.body && r2.body.replay}`);
    check(!!firstAt && r2.body.after.at === firstAt, '⑤ 重放返回首次结果（单次写回）', `at=${String(firstAt).slice(11, 19)}`);

    /* —— ⑥ 两路并发：一成一拒 + 恰 1 条成功事件 —— */
    const body = { demandId: 'T-W80F', stepKey: 'verify', action: 'approve', reason: 'R80⑥ 并发提交' };
    const [x1, x2] = await Promise.all([post(stack, '/api/office/decision', body), post(stack, '/api/office/decision', body)]);
    check([x1.status, x2.status].sort().join(',') === '200,409', '⑥ 并发 [200,409]', `${[x1.status, x2.status].sort().join(',')}`);
    check(writtenEventsOf(stack, 'T-W80F').length === 1, '⑥ 并发后成功事件恰 1 条', `events=${writtenEventsOf(stack, 'T-W80F').length}`);
    check((await verifyStatusOf(stack, 'T-W80F')) === 'done', '⑥ 档案一致落 done（未撕裂）', await verifyStatusOf(stack, 'T-W80F'));

    /* —— UI：指纹展示保留（.msha 12px / #65D9B1），零异常，截图 —— */
    const rf = metaOf(CLEAN.a);
    const { page, state } = await newPage(browser);
    await page.goto(stack.base + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.req-item[data-task="T-W80V"]', { timeout: 10000 });
    await page.evaluate(() => document.querySelector('.req-item[data-task="T-W80V"]').click());
    await page.waitForSelector('.track-node[data-step="verify"]', { timeout: 10000 });
    await page.evaluate(() => document.querySelector('.track-node[data-step="verify"]').click());
    await page.waitForSelector('#insp-body .ev-file', { timeout: 10000 });
    await sleep(1200);   // 等 version-gate 首轮判定回来并重渲染
    const msha = await page.evaluate(() => {
      const el = document.querySelector('#insp-body .ev-file .msha');
      if (!el) return null;
      const c = getComputedStyle(el);
      return { text: el.textContent.trim(), color: c.color, fs: c.fontSize, lh: c.lineHeight };
    });
    check(!!msha && /^指纹 [0-9a-f]{8} ✓$/.test(msha.text), 'UI 指纹徽标「指纹 a1b2c3d4 ✓」', msha ? msha.text : '未找到 .msha');
    check(!!msha && msha.color === 'rgb(101, 217, 177)' && msha.fs === '12px' && msha.lh === '18px', 'UI 指纹 #65D9B1 · 12px/18px', msha ? `${msha.color} ${msha.fs}/${msha.lh}` : '');
    check(!!msha && msha.text.includes(rf.sha256.slice(0, 8)), '显示值 = 实算登记指纹前 8 位（非编造）', `${rf.sha256.slice(0, 8)}`);
    await sleep(300);
    check(state.pageErrors.length === 0, '零 pageerror', String(state.pageErrors.length));
    check(state.consoleErrs.length === 0, '零 console.error', String(state.consoleErrs.length));
    await page.screenshot({ path: 'verify-w01-r80-panel.png', fullPage: false });
    console.log('截图：web/verify-w01-r80-panel.png');
  } finally {
    await browser.close();
    await stack.stop();
    for (const k of Object.keys(CLEAN)) { const p = fixPath(`r80-${k}.txt`); if (existsSync(p)) unlinkSync(p); }
  }
  console.log(allOk ? 'W01-R80: ALL OK' : 'W01-R80: FAILED');
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
