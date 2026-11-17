// verify-f01-r75.mjs — F01 第 75 轮：历史版本预览严格读快照（浏览器全链路实测）。
// 口径（任务书）：预览必须按不可变版本标识读对应快照，禁止用当前文件内容冒充；
//   V1/V2 各自预览的 SHA-256 必须匹配登记值；删除 V1 快照后再次预览必须明确失败
//   （绝不能返回 V2 内容）；重复刷新 5 次版本内容与版本标识不得变化；
//   提示 12px/18px/#E5B95E；历史版本标识 11px 等宽，当前/历史版本最多各占 2 行。
// 夹具：g07-harness 起隔离 stack，注入 T-F01R75——doc 步登记 V1（合成旧指纹 + history
//   快照=V1 原文），plan 步登记 V2（=磁盘现状指纹）。磁盘零改动即得分叉两版本。
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startStack, launchBrowser, newPage, sleep, REAL_FILE, realFileMeta } from '../test/g07-harness.mjs';

const shaOf = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const iso = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString();

// —— 合成 V1：与磁盘现状（app-base.css = V2）内容必然不同 ——
const V1_TEXT = [
  'F01 第75轮历史快照 V1（合成测试数据）',
  '这是登记时留档的旧版本文本；预览 V1 必须逐字返回这份内容。',
  'Mixed ascii + 多字节第二行，指纹独立实算，不信服务端回显。',
].join('\n') + '\n';
const V1 = { text: V1_TEXT, bytes: Buffer.byteLength(V1_TEXT, 'utf8'), sha256: shaOf(V1_TEXT) };
const V2 = realFileMeta();   // 磁盘现状 = V2

const EXTRA_TASKS = [{
  id: 'T-F01R75', title: 'F01 第75轮历史版本验证',
  createdAt: iso(70), updatedAt: iso(2),
  steps: {
    req: { status: 'done', at: iso(65), note: 'F01 验证', by: 'leo' },
    doc: { status: 'done', at: iso(60), note: '登记历史版本 V1（快照留档）', by: 'lemate',
      files: [{ path: REAL_FILE, bytes: V1.bytes, sha256: V1.sha256,
        history: [{ snapshot: V1.text, at: iso(60) }] }] },
    plan: { status: 'done', at: iso(30), note: '登记 V2（=磁盘现状）', by: 'lemate',
      files: [{ path: REAL_FILE, bytes: V2.bytes, sha256: V2.sha256 }] },
    brief: { status: 'pending', at: null, note: '', by: null },
    deliverable: { status: 'pending', at: null, note: '', by: null },
    verify: { status: 'pending', at: null, note: '', by: null },
    final: { status: 'pending', at: null, note: '', by: null },
  },
}];

const V1_ROW = `[data-reg-vkey="sha:${V1.sha256}"]`;
const V2_ROW = `[data-reg-vkey="sha:${V2.sha256}"]`;
const pageSha = (t) => `crypto.subtle.digest('SHA-256', new TextEncoder().encode(${JSON.stringify(t)})).then(b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join(''))`;

let allOk = true;
const check = (ok, label, detail) => { console.log(`${ok ? '✅' : '❌'} ${label}${detail ? '：' + detail : ''}`); if (!ok) allOk = false; };

async function openFilesAndClickRow(page, rowSel) {
  await page.reload({ waitUntil: 'domcontentloaded' });   // 真·刷新（hash goto 不重载，抽屉会残留）
  await page.waitForSelector(`.library-file[data-open-file$="app-base.css"] ${rowSel}`, { timeout: 10000 });
  await page.click(rowSel);
  await page.waitForSelector('#file-view.open', { timeout: 8000 });
}

let base;
async function main() {
  const stack = await startStack(EXTRA_TASKS);
  base = stack.base;
  const browser = await launchBrowser();
  try {
    const { page, state } = await newPage(browser);

    /* —— 1. 版本行规格：11px 等宽、每版本最多 2 行 —— */
    await page.goto(base + '/#/files', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(`.library-file[data-open-file$="app-base.css"] ${V1_ROW}`, { timeout: 10000 });
    const rowsSpec = await page.evaluate(() => {
      const host = document.querySelector('.library-file[data-open-file$="app-base.css"]');
      return [...host.querySelectorAll('[data-reg-vkey]')].map((r) => {
        const cs = getComputedStyle(r);
        return { vkey: r.dataset.regVkey.slice(0, 20), fs: cs.fontSize, lh: cs.lineHeight,
          mono: cs.fontFamily.includes('mono'), h: r.getBoundingClientRect().height };
      });
    });
    check(rowsSpec.length >= 2, `版本行数 ≥2（V1/V2 各一条）`, `实际 ${rowsSpec.length} 行`);
    for (const r of rowsSpec) {
      // R75 钉「11px 等宽 + 最多各占 2 行」；行高 17px 为 R73 层既定口径（哈希行 11/17 + 日期行 12/18）
      check(r.fs === '11px' && r.mono, `版本标识 ${r.vkey}… 11px 等宽`, `${r.fs}/${r.lh} mono=${r.mono}`);
      check(r.h <= 36 + 0.5, `版本行 ${r.vkey}… 高度 ≤36px（最多 2 行）`, `实际 ${r.h.toFixed(1)}px`);
    }

    /* —— 2. V1 预览 = 快照原文，页内独立复算指纹 = 登记 V1 —— */
    await page.click(V1_ROW);
    await page.waitForSelector('#fv-body[data-fv-hint="hist-saved"] pre', { timeout: 8000 });
    const v1 = await page.evaluate(async () => {
      const pre = document.querySelector('#fv-body pre');
      const hint = document.querySelector('#fv-body .fv-hint');
      const cs = getComputedStyle(hint);
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pre.textContent));
      const sha = [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
      return { len: pre.textContent.length, sha, hintFs: cs.fontSize, hintLh: cs.lineHeight, hintColor: cs.color };
    });
    check((await page.$eval('#fv-body pre', (el) => el.textContent)) === V1.text, 'V1 预览逐字=快照原文', `${v1.len} 字`);
    check(v1.sha === V1.sha256, 'V1 页内独立复算 SHA-256 = 登记 V1 指纹', `${v1.sha.slice(0, 12)}…`);
    check(v1.hintFs === '12px' && v1.hintLh === '18px', 'V1 提示 12px/18px', `${v1.hintFs}/${v1.hintLh}`);

    /* —— 3. V2 预览 = 磁盘现状（当前版本），指纹 = 登记 V2，且 ≠ V1 —— */
    await page.keyboard.press('Escape');                       // 关抽屉，否则遮罩挡住版本行
    await page.waitForFunction(() => !document.getElementById('file-view').classList.contains('open'), { timeout: 5000 });
    await page.click(V2_ROW);
    await page.waitForSelector('#fv-body pre', { timeout: 8000 });
    await sleep(300);   // 等 fvHint 稳定（disk-current 分支非 hist）
    const v2 = await page.evaluate(async () => {
      const pre = document.querySelector('#fv-body pre');
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pre.textContent));
      return { sha: [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join(''),
        hint: document.getElementById('fv-body').dataset.fvHint || '' };
    });
    check(v2.sha === V2.sha256, 'V2 预览 SHA-256 = 磁盘现状（登记 V2）', `${v2.sha.slice(0, 12)}…`);
    check(v2.sha !== V1.sha256 && v2.hint !== 'hist-saved', 'V2 ≠ V1 且非历史快照分支', `hint=${v2.hint}`);

    /* —— 4. 重复刷新 5 次：版本内容与版本标识不变 —— */
    const first = { vkey: V1.sha256, sha: v1.sha };
    let refreshStable = true; const seq = [];
    for (let i = 0; i < 5; i++) {
      await openFilesAndClickRow(page, V1_ROW);
      await page.waitForSelector('#fv-body[data-fv-hint="hist-saved"] pre', { timeout: 8000 });
      const r = await page.evaluate(async (vk) => {
        const row = document.querySelector(`[data-reg-vkey="${vk}"]`);   // DOM 序当前版本在前，须按 V1 的 vkey 精确取行
        const pre = document.querySelector('#fv-body pre');
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pre.textContent));
        return { vkey: row ? row.dataset.regVkey : null,
          sha: [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('') };
      }, `sha:${first.vkey}`);
      seq.push(r.sha.slice(0, 12));
      if (r.sha !== first.sha || r.vkey !== `sha:${first.vkey}`) refreshStable = false;
    }
    check(refreshStable, '5 次刷新 V1 内容+版本标识均不变', `指纹序列 ${seq.join(' / ')}`);

    /* —— 5. 删除 V1 快照（服务端留档移除）→ 预览必须明确失败，不得返回 V2 —— */
    const taskFile = join(stack.home, 'office-data', 'tasks', 'T-F01R75.json');
    const rec = JSON.parse(readFileSync(taskFile, 'utf8'));
    delete rec.steps.doc.files[0].history;    // V1 快照删除（登记身份保留）
    writeFileSync(taskFile, JSON.stringify(rec, null, 1));
    await openFilesAndClickRow(page, V1_ROW);
    await page.waitForSelector('#fv-body[data-fv-hint="hist"]', { timeout: 8000 });
    await sleep(400);
    const gone = await page.evaluate(() => {
      const body = document.getElementById('fv-body');
      const hint = body.querySelector('.fv-hint');
      const cs = hint ? getComputedStyle(hint) : null;
      const svc = [...body.querySelectorAll('.fh-kv')].find((kv) => kv.textContent.includes('服务端核对'));
      return { hasPre: !!body.querySelector('pre'), fvHint: body.dataset.fvHint,
        svc: svc ? svc.textContent.trim().slice(0, 80) : null,
        hintFs: cs && cs.fontSize, hintLh: cs && cs.lineHeight, hintColor: cs && cs.color,
        leakV2: body.textContent.includes('CSS variables') || body.textContent.includes('app-base') && body.querySelector('pre') !== null };
    });
    check(!gone.hasPre, '删除 V1 快照后无任何原文 <pre>（不得返回 V2 内容）', `hasPre=${gone.hasPre}`);
    check(gone.fvHint === 'hist', '走历史不可用分支（hist 非 hist-saved）', `fvHint=${gone.fvHint}`);
    check(!!gone.svc && gone.svc.includes('no-snapshot'), '服务端核对行明示 no-snapshot', gone.svc || '无该行');
    check(gone.hintFs === '12px' && gone.hintLh === '18px' && gone.hintColor === 'rgb(229, 185, 94)',
      '失败提示 12px/18px/#E5B95E', `${gone.hintFs}/${gone.hintLh} ${gone.hintColor}`);

    // F01（第 78 轮）：端点按规格改回 HTTP 404 后，Chromium 会对该 fetch 自动打一条
    // 网络层 error（Failed to load resource: 404）——JS 无法抑制，属预期伴生日志；
    // 本夹具全程只发一次 404 请求（删快照后的 file-version 调用），只放行这一条，
    // 其余任何 pageerror / console.error 仍然零容忍。
    const NET404 = /^Failed to load resource: the server responded with a status of 404/;
    const net404 = state.consoleErrs.filter((t) => NET404.test(t));
    const otherErrs = state.consoleErrs.filter((t) => !NET404.test(t));
    check(state.pageErrors.length === 0 && otherErrs.length === 0 && net404.length <= 1,
      '全程零 pageerror / 非预期 console.error（404 伴生日志仅 1 条）',
      `pageerror=${state.pageErrors.length} 非预期=${otherErrs.length} 404伴生=${net404.length}`);
    console.log(allOk ? '\nF01-R75: ALL OK' : '\nF01-R75: FAIL');
    process.exitCode = allOk ? 0 : 1;
  } finally {
    await browser.close().catch(() => {});
    await stack.stop();
  }
}
main().catch((e) => { console.error('FAIL', e); process.exit(1); });
