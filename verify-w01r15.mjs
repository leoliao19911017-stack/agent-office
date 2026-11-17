// verify-w01r15.mjs — W01 第 15 轮验收：审批校验（页面恢复后的完整验证）。
//
// 任务书口径：
//   正式需求：服务端核验文件存在性 + 物理文件版本（bytes/sha256）+ 前置条件（类型/可处理性）；
//   测试需求：仅按明确声明的例外范围（test-any-file）处理，漂移照报不阻断；
//   失败反馈：#3B3021 底 / #E5B95E 字 / 12px 字号 / 18px 行高 / 12px 内边距（getComputedStyle 实测）；
//   幂等：重复写入不得产生第二条成功记录；失败路径不得留下虚假成功记录。
//
// 场景（任务书 5 项）：
//   S1 正常审批（正式 F1）        → 200 done + 事件 written×1
//   S2 文件内容变更（正式 F2）    → 变字节 409 why:bytes；等字节改写 409 why:sha；档案停 awaiting
//   S3 登记版本变更（正式 F2）    → 登记更新为物理现值后按新登记核对 → 200 done
//   S4 重复点击/重复提交          → /decision 二次 POST 409 NOT_ACTIONABLE；legacy /decide 同 opId
//                                   重放回缓存结果不重复执行；页面成功后无按钮可点
//   S5 API 写入失败               → 400/404 各口径事件零新增；漂移 409 事件零新增
//   S6 页面（headless CDP）       → F2 打开后物理漂移再点通过 → 服务端 409 兜底 → .fb.err
//                                   实测样式 + 按钮收敛 + 刷新一致；R11 例外放行 → done；
//                                   F1 完成后无重复入口
//   P3 清理：夹具与共享文件删除、TEST-R11.json 按基线 sha256 恢复（外层 finally）。
// 用法：node verify-w01r15.mjs

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP_PORT = 9347;
const BASE = 'http://127.0.0.1:8090';
const DATA = 'C:/Tools/agent-autoloop/office-data';
const TASKS = join(DATA, 'tasks');
const EVENTS = join(DATA, 'decision-events.jsonl');
const TMPDIR = join(DATA, 'tmp-w01r15');
const SHARED = join(TMPDIR, 'w01r15-shared.md');
const F1 = 'TEST-W01R15F1', F2 = 'TEST-W01R15F2', TT = 'TEST-W01R15T', R11 = 'TEST-R11';
const R11_BASELINE_SHA = '0dd1e387c7908d9251f2cecb46083663428f88b8b723d74426dd23055b646087';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const out = { checks: [], api: [], page: [] };
function check(name, pass, detail) {
  out.checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '  | ' + JSON.stringify(detail)}`);
  return pass;
}
const evCount = () => (existsSync(EVENTS) ? readFileSync(EVENTS, 'utf8').split('\n').filter((l) => l.trim()).length : 0);
const evTail = (n) => (existsSync(EVENTS) ? readFileSync(EVENTS, 'utf8').split('\n').filter((l) => l.trim()).slice(-n) : []);

async function api(path, body, method = 'POST') {
  const r = await fetch(BASE + path, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null; try { j = await r.json(); } catch { /* 非 JSON */ }
  out.api.push({ path, status: r.status, code: j?.code ?? null });
  return { status: r.status, body: j };
}
const planStatus = async (id) => {
  const r = await api('/api/office/flow', undefined, 'GET');
  const t = r.body.tasks.find((x) => x.id === id);
  return t ? (t.steps.find((s) => s.key === 'plan') || {}).status : '(no-task)';
};

// ---- 夹具 ------------------------------------------------------------------
// V1 基线；V2 改内容且变字节数；V2B 与 V1 等字节不同内容（内容指纹检出用）。
const V1 = Buffer.from('W01 r15 shared approval object baseline.\nformal vs test policy A/B fixture file.\n', 'utf8');
const V2 = Buffer.concat([V1, Buffer.from('(mutated after submit)\n', 'utf8')]);
const V2B = Buffer.from(String(V1, 'utf8').replace('baseline', 'tampered'), 'utf8');
if (V2B.length !== V1.length) throw new Error(`V2B 必须与 V1 等长: ${V2B.length} vs ${V1.length}`);

function fixture(id, policy, kind) {
  return {
    id, title: `W01 r15 一次性夹具 ${id}（测完即删）`,
    createdAt: '2026-11-16T12:00:00.000Z', updatedAt: '2026-11-16T12:00:00.000Z',
    ...(policy ? { artifactPolicy: policy } : {}),
    steps: {
      req: { status: 'done', at: '2026-11-16T12:00:00.000Z', note: 'W01 r15 夹具', by: 'selftest', files: [], runs: [] },
      doc: { status: 'done', at: '2026-11-16T12:01:00.000Z', note: 'W01 r15 夹具', by: 'selftest', files: [], runs: [] },
      plan: {
        status: 'awaiting', at: '2026-11-16T12:02:00.000Z', note: '', by: 'selftest',
        files: [{ path: SHARED.replace(/\\/g, '/'), bytes: V1.length, sha256: sha256(V1), kind }], runs: [],
      },
      brief: { status: 'pending', at: null, note: '', by: null, files: [], runs: [] },
      deliverable: { status: 'pending', at: null, note: '', by: null, files: [], runs: [] },
      verify: { status: 'pending', at: null, note: '', by: null, files: [], runs: [] },
      final: { status: 'pending', at: null, note: '', by: null, files: [], runs: [] },
    },
  };
}
const TEST_POLICY = {
  mode: 'test-any-file',
  basis: 'W01 第 15 轮一次性夹具：shared.md 仅作审批对象占位，非真实开发计划；按测试策略任意登记产物均可作为审批对象验证例外隔离。',
};
function writeF2Fixture() { writeFileSync(join(TASKS, `${F2}.json`), JSON.stringify(fixture(F2, null, 'plan'), null, 2)); }
function writeFixtures() {
  mkdirSync(TMPDIR, { recursive: true });
  writeFileSync(SHARED, V1);
  writeFileSync(join(TASKS, `${F1}.json`), JSON.stringify(fixture(F1, null, 'plan'), null, 2));
  writeF2Fixture();
  writeFileSync(join(TASKS, `${TT}.json`), JSON.stringify(fixture(TT, TEST_POLICY, 'test-artifact'), null, 2));
}
const cleanFixtures = () => { for (const id of [F1, F2, TT]) rmSync(join(TASKS, `${id}.json`), { force: true }); rmSync(TMPDIR, { recursive: true, force: true }); };

// ---- CDP 直连骨架（与 r9 相同）------------------------------------------------
class CDP {
  constructor(ws) {
    this.sock = ws; this.id = 0; this.pending = new Map(); this.pageErrors = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.exceptionThrown') this.pageErrors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '?');
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP 超时: ${method}`)); } }, 15000);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.sock.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true });
    if (r.exceptionDetails) throw new Error('页面 JS 异常: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  async waitFor(expr, timeoutMs, label) {
    const t0 = Date.now();
    for (;;) {
      try { const v = await this.eval(expr); if (v) return v; } catch { /* 导航切换瞬间 */ }
      if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时: ${label}`);
      await sleep(400);
    }
  }
}
const HOOK = `(() => { window.__w01net = []; const of = window.fetch.bind(window); window.fetch = async (...a) => { const r = await of(...a); try { window.__w01net.push({ url: String(a[0]).replace(location.origin, ''), status: r.status }); } catch { } return r; }; return true; })()`;
async function selectTaskStep(cdp, taskId) {
  await cdp.eval(`document.querySelector('.req-item[data-task="${taskId}"]')?.click()`);
  await sleep(500);
  await cdp.eval(`document.querySelector('.track-node[data-step="plan"]')?.click()`);
  await sleep(1200);
}

// ---- 主流程 -------------------------------------------------------------------
async function main() {
  try {
    // P0 前置：R11 基线 + F01 夹具登记与物理文件一致（「恢复原有 F01/R11 测试数据」核对）
    const r11Pre = sha256(readFileSync(join(TASKS, `${R11}.json`)));
    check('P0 R11 档案 = 基线 sha256（原有测试数据在位）', r11Pre === R11_BASELINE_SHA, { r11Pre: r11Pre.slice(0, 12) });
    const f01r = await api('/api/office/flow', undefined, 'GET');
    const f01t = f01r.body.tasks.find((t) => t.id === 'TEST-F01R10');
    const fPlan = (f01t.steps.find((s) => s.key === 'plan') || {});
    const fFiles = fPlan.files || [];
    const f01ok = fPlan.status === 'awaiting' && fFiles.length === 2 && fFiles.every((f) => {
      try { const b = readFileSync(f.path); return b.length === f.bytes && sha256(b) === f.sha256; } catch { return false; }
    });
    check('P0 F01R10 夹具在位：plan=awaiting 且 2 条登记与物理文件 bytes/sha 一致', f01ok,
      { plan: fPlan.status, files: fFiles.map((f) => `${String(f.path).split('/').pop()} ${f.bytes}B`) });

    writeFixtures();
    check('P0 一次性夹具落盘（F1/F2 正式无策略，T 声明 test-any-file）', existsSync(SHARED) && existsSync(join(TASKS, `${F1}.json`)));

    // ===== S1 正常审批（正式需求·未修改） =====
    let ev0 = evCount();
    let r = await api('/api/office/decision', { demandId: F1, stepKey: 'plan', action: 'approve' });
    check('S1 正式·未修改 → 200 verified=true to:done', r.status === 200 && r.body.verified === true && r.body.to === 'done', { http: r.status, to: r.body?.to });
    check('S1 档案 plan=done', (await planStatus(F1)) === 'done');
    check('S1 事件新增恰好 1 条 written（from awaiting）', evCount() === ev0 + 1 && JSON.parse(evTail(1)[0]).result === 'written' && JSON.parse(evTail(1)[0]).from === 'awaiting', evTail(1));

    // ===== S2 文件内容变更（正式需求·物理文件变了） =====
    writeFileSync(SHARED, V2);            // 变内容且变字节数
    ev0 = evCount();
    r = await api('/api/office/decision', { demandId: F2, stepKey: 'plan', action: 'approve' });
    let g = await api('/api/office/version-gate', { taskId: F2, stepKey: 'plan' });
    let gd = (g.body?.versionGate || g.body || {}).drifted || [];
    check('S2a 正式·改内容变字节 → 409 ARTIFACT_VERSION_DRIFT', r.status === 409 && /ARTIFACT_VERSION_DRIFT/.test(r.body?.code || ''), { http: r.status, code: r.body?.code });
    check('S2a gate why:bytes（实测≠登记字节）', gd[0]?.why === 'bytes' && gd[0]?.actBytes === V2.length && gd[0]?.regBytes === V1.length, gd);
    writeFileSync(SHARED, V2B);           // 等字节改内容
    r = await api('/api/office/decision', { demandId: F2, stepKey: 'plan', action: 'approve' });
    g = await api('/api/office/version-gate', { taskId: F2, stepKey: 'plan' });
    gd = (g.body?.versionGate || g.body || {}).drifted || [];
    check('S2b 正式·等字节改内容 → 409 且 why:sha（内容指纹不漏检）', r.status === 409 && gd[0]?.why === 'sha' && gd[0]?.actB === gd[0]?.regB, { http: r.status, why: gd[0]?.why });
    check('S2 失败两连后档案仍 awaiting（无成功记录）', (await planStatus(F2)) === 'awaiting');
    check('S2 失败路径事件零新增', evCount() === ev0, { before: ev0, after: evCount() });

    // ===== S3 登记版本变更（登记更新为物理现值 → 按新登记核对） =====
    const f2f = join(TASKS, `${F2}.json`);
    const f2rec = JSON.parse(readFileSync(f2f, 'utf8'));
    f2rec.steps.plan.files[0] = { ...f2rec.steps.plan.files[0], bytes: V2B.length, sha256: sha256(V2B) };
    writeFileSync(f2f, JSON.stringify(f2rec, null, 2));
    g = await api('/api/office/version-gate', { taskId: F2, stepKey: 'plan' });
    const g3 = g.body?.versionGate || g.body || {};
    check('S3 登记版本变更后 gate valid:true 无漂移（按新登记核对）', g3.valid === true && (g3.drifted || []).length === 0, g3.drifted);
    r = await api('/api/office/decision', { demandId: F2, stepKey: 'plan', action: 'approve' });
    check('S3 按新登记审批 → 200 done', r.status === 200 && r.body?.to === 'done', { http: r.status });

    // ===== S4 重复点击 / 重复提交 =====
    ev0 = evCount();
    r = await api('/api/office/decision', { demandId: F1, stepKey: 'plan', action: 'approve' });   // F1 已 done
    check('S4a /decision 对已 done 步骤重复 POST → 409 NOT_ACTIONABLE（不二次写入）', r.status === 409 && /NOT_ACTIONABLE/.test(r.body?.code || ''), { http: r.status, code: r.body?.code });
    const opId = `w01r15-t-${Date.now()}`;
    const ttFile = join(TASKS, `${TT}.json`);
    r = await api('/api/office/decide', { taskId: TT, step: 'plan', action: 'approve', note: 'W01 r15：测试例外放行', opId });
    const first = { status: r.status, ok: r.body?.ok, to: r.body?.to ?? r.body?.state?.status ?? r.body?.step?.status };
    const shaAfterFirst = sha256(readFileSync(ttFile));
    r = await api('/api/office/decide', { taskId: TT, step: 'plan', action: 'approve', note: 'W01 r15：重放同 opId', opId });
    const replay = { status: r.status, ok: r.body?.ok, replay: r.body?.replay };
    check('S4b legacy /decide 首次 200 + 同 opId 重放 200 且 replay:true（命中幂等缓存）', first.status === 200 && replay.status === 200 && replay.replay === true, { first, replay });
    check('S4b 重放未二次落盘（TT 档案 sha 前后一致）', sha256(readFileSync(ttFile)) === shaAfterFirst, { shaAfterFirst: shaAfterFirst.slice(0, 12) });
    const tg = await api('/api/office/version-gate', { taskId: TT, stepKey: 'plan' });
    const tgg = tg.body?.versionGate || tg.body || {};
    check('S4b 测试需求漂移照报 + versionExempt:true（例外只按声明生效）', tgg.versionExempt === true && (tgg.drifted || []).length > 0, { exempt: tgg.versionExempt, drifted: (tgg.drifted || [])[0]?.why });

    // ===== S5 API 写入失败（各失败口径都不留成功记录） =====
    ev0 = evCount();
    const fails = [];
    fails.push(await api('/api/office/decision', { demandId: F1, stepKey: 'plan', action: 'wiggle' }));               // 400 BAD_ACTION
    fails.push(await api('/api/office/decision', { demandId: F1, stepKey: 'nope', action: 'approve' }));              // 400 BAD_STEP
    fails.push(await api('/api/office/decision', { demandId: 'NO-SUCH-DEMAND', stepKey: 'plan', action: 'approve' }));// 404
    fails.push(await api('/api/office/decision', { demandId: F1, stepKey: 'plan', action: 'reject' }));               // 400 REASON_REQUIRED
    check('S5 非法 action/step/不存在需求/缺理由 → 全 4xx', fails.every((f) => f.status >= 400), fails.map((f) => f.status));
    check('S5 失败口径事件零新增（无虚假成功记录）', evCount() === ev0, { before: ev0, after: evCount() });

    // ===== S6 页面（headless CDP） =====
    // F2 重置为干净态（物理 V1 + 登记 V1 + awaiting），页面打开按钮可用后再落盘漂移。
    writeFileSync(SHARED, V1);
    writeF2Fixture();
    await sleep(300);

    const profile = join(tmpdir(), `w01r15-cdp-${Date.now()}`);
    const chrome = spawn(CHROME, [
      `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
      '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
      '--window-size=1440,900', 'about:blank',
    ], { stdio: 'ignore' });
    let cdp = null;
    try {
      let page = null;
      for (let i = 0; i < 50; i++) {
        try {
          const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
          page = list.find((t) => t.type === 'page');
          if (page) break;
        } catch { /* retry */ }
        await sleep(300);
      }
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
      cdp = new CDP(ws);
      await cdp.send('Runtime.enable');

      await cdp.send('Page.navigate', { url: BASE });
      await sleep(2500);
      await cdp.eval(HOOK);
      const boot = await cdp.eval(`(() => ({
        modules: ['esc','api','scheduleVersionGate','decideHtml','renderFiles'].map(n => n + ':' + typeof window[n]).join(' '),
        uiErr: window.__uiErrors || 0, reqs: document.querySelectorAll('#reqs-list .req-item').length,
      }))()`);
      check('S6 页面加载：模块齐全/无 UI 错误/需求列表渲染（右侧审批区域正常渲染）', boot.modules.includes('undefined') === false && boot.uiErr === 0 && boot.reqs > 0, boot);

      // —— S6-1 正式漂移：页面就绪后落盘漂移，再点「通过」→ 服务端 409 兜底 ——
      await selectTaskStep(cdp, F2);
      const ready = await cdp.waitFor(`(() => { const b = document.querySelector('#insp-foot [data-decide="approve"]'); return b ? !b.disabled : false; })()`, 12000, 'F2 审批按钮可用');
      check('S6-1 页面就绪时（物理未漂移）审批按钮可用', !!ready);
      const evS6 = evCount();
      writeFileSync(SHARED, V2B);          // 物理漂移发生在门禁拉取之后（前端 60s 缓存窗口内）
      await cdp.eval(`document.querySelector('#insp-foot [data-decide="approve"]').click()`);
      const fbErr = await cdp.waitFor(`(() => { const el = document.querySelector('#insp-body .fb.err, #insp-foot .fb.err'); return el ? el.textContent.trim().slice(0, 200) : null; })()`, 10000, '409 失败反馈出现');
      check('S6-1 漂移后点通过 → 页面出现失败反馈（服务端 409 兜底）', /不一致|版本/.test(String(fbErr)), fbErr);
      const net = await cdp.eval(`window.__w01net.filter(x => x.url === '/api/office/decision')`);
      check('S6-1 真实 HTTP：decision POST 得 409', net.length === 1 && net[0].status === 409, net);
      const style = await cdp.eval(`(() => {
        const el = document.querySelector('#insp-body .fb.err, #insp-foot .fb.err'); if (!el) return null;
        const c = getComputedStyle(el); const b = el.getBoundingClientRect();
        return { font: c.fontSize, lh: c.lineHeight, bg: c.backgroundColor, color: c.color, pad: c.padding,
                 rect: { w: +b.width.toFixed(1), h: +b.height.toFixed(1) }, text: el.textContent.trim().slice(0, 160) };
      })()`);
      out.page.push({ scenario: 'S6-1 fb.err 实测', style });
      check('S6-1 样式实测：12px/18px/rgb(59,48,33)/rgb(229,185,94)/12px',
        style && style.font === '12px' && style.lh === '18px' && style.bg === 'rgb(59, 48, 33)' && style.color === 'rgb(229, 185, 94)' && style.pad === '12px', style);
      const btnState = await cdp.eval(`(() => { const b = document.querySelector('#insp-foot [data-decide="approve"]'); return b ? { disabled: b.disabled } : { gone: true }; })()`);
      check('S6-1 失败后主操作收敛（禁用或隐藏，强制重拉版本门禁后）', btnState.disabled === true || btnState.gone === true, btnState);
      const mm = await cdp.eval(`!!document.querySelector('#insp-body .material-mismatch')`);
      check('S6-1 材料不一致警示块在（.material-mismatch）', mm === true);
      check('S6-1 页面失败路径档案停 awaiting + 事件零新增', (await planStatus(F2)) === 'awaiting' && evCount() === evS6, { plan: await planStatus(F2), evDelta: evCount() - evS6 });

      // 刷新后一致：无未确认成功
      await cdp.send('Page.reload', { ignoreCache: true });
      await sleep(2000);
      await selectTaskStep(cdp, F2);
      const afterReload = await cdp.eval(`(() => {
        const body = document.getElementById('insp-body'); const foot = document.getElementById('insp-foot');
        const done = !!document.querySelector('#insp-body .done-line');
        return { hasBody: body && body.innerHTML.length > 100, footHidden: foot.hidden, doneLine: done,
          stepText: (body.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80) };
      })()`);
      check('S6-1 刷新后：步骤详情在、无成功 done-line、F2 仍待拍板（与服务端一致）', afterReload.hasBody && !afterReload.doneLine && /待拍板|待 Leo/.test(afterReload.stepText), afterReload);

      // —— S6-2 R11 测试例外：页面点「通过」→ 200 → done ——
      await selectTaskStep(cdp, R11);
      const r11Ready = await cdp.waitFor(`(() => { const b = document.querySelector('#insp-foot [data-decide="approve"]'); return b ? !b.disabled : false; })()`, 12000, 'R11 审批按钮可用');
      check('S6-2 R11 审批按钮可用（例外放行不阻断）', !!r11Ready);
      await cdp.eval(`document.querySelector('#insp-foot [data-decide="approve"]').click()`);
      const doneLine = await cdp.waitFor(`(() => { const el = document.querySelector('#insp-body .done-line'); return el ? el.textContent.trim().slice(0, 120) : null; })()`, 10000, 'R11 成功反馈');
      check('S6-2 R11 页面审批 → done 反馈出现', !!doneLine, doneLine);
      check('S6-2 R11 档案 plan=done', (await planStatus(R11)) === 'done');
      const noDup = await cdp.eval(`!document.querySelector('#insp-foot [data-decide="approve"]')`);
      check('S6-2 成功后审批按钮消失（页面无重复提交入口）', noDup === true);

      // —— S6-3 F1 已 done：页面确认无审批入口（重复点击的另一面） ——
      await selectTaskStep(cdp, F1);
      const f1View = await cdp.eval(`(() => {
        const foot = document.getElementById('insp-foot');
        return { footHidden: foot.hidden, hasApprove: !!document.querySelector('#insp-foot [data-decide="approve"]'),
          stepText: (document.getElementById('insp-body').textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60) };
      })()`);
      check('S6-3 已完成步骤无审批按钮（重复点击无入口）', f1View.footHidden === true && f1View.hasApprove === false, f1View);

      check('S6 全程无 JS 异常', cdp.pageErrors.length === 0, cdp.pageErrors.slice(0, 3));
    } finally {
      try { cdp && cdp.sock.close(); } catch { }
      chrome.kill();
    }

    // ===== P3 清理 =====
    cleanFixtures();
    check('P3 一次性夹具与共享文件已清理', !existsSync(join(TASKS, `${F1}.json`)) && !existsSync(TMPDIR));

    const failed = out.checks.filter((c) => !c.pass).length;
    console.log(`\n==== W01 r15 验收：${out.checks.length - failed}/${out.checks.length} PASS ====`);
    mkdirSync(join('.', 'verify-assets'), { recursive: true });
    writeFileSync(join('.', 'verify-assets', 'w01r15-out.json'), JSON.stringify(out, null, 2));
    if (failed > 0) process.exitCode = 1;
  } catch (e) {
    console.error('SCRIPT-ERROR', e);
    process.exitCode = 1;
    try { cleanFixtures(); } catch { }
  }
}

// R11 页面场景会改档案 —— 先备份再跑，结束后恢复基线。
const r11File = join(TASKS, `${R11}.json`);
const r11Snap = join(tmpdir(), `w01r15-r11-snap-${Date.now()}.json`);
copyFileSync(r11File, r11Snap);
main().finally(() => {
  try {
    copyFileSync(r11Snap, r11File);
    const ok = sha256(readFileSync(r11File)) === R11_BASELINE_SHA;
    console.log('R11-RESTORED', ok ? '基线已恢复' : '恢复后哈希不一致');
    if (!ok) process.exitCode = process.exitCode || 2;
  } catch (e) { console.error('R11 恢复失败', e); process.exitCode = process.exitCode || 2; }
});
