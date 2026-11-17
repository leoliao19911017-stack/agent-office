// W02 第 12 轮验证：审批说明正文档位 + 滚动区收口 + 测试策略说明去重 + 刷新留存。
// 用法: node w02r12-verify.mjs <phase>   phase = baseline | after
// 输出: w02r12-<phase>.json + 三视口滚底截图 w02r12-<phase>-<vp>x<h>-bottom.png
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9482;
const BASE = 'http://127.0.0.1:8090';
const TASK = 'TEST-R11';
const STEP = 'plan';
const VIEWPORTS = [{ w: 1440, h: 900 }, { w: 1280, h: 800 }, { w: 1100, h: 768 }];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const phase = process.argv[2] || 'baseline';

class CDP {
  constructor(ws) {
    this.sock = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    return new CDP(ws);
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.sock.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('page eval failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  }
}

const MEASURE = `(() => {
  const insp = document.getElementById('inspector');
  const head = insp.querySelector('.insp-head');
  const body = document.getElementById('insp-body');
  const foot = document.getElementById('insp-foot');
  const src = document.querySelector('#insp-body .ev-src');
  const mm = document.querySelector('#insp-body .material-mismatch');
  const cs = (el, ps) => { const c = getComputedStyle(el); const o = {}; for (const p of ps) o[p] = c.getPropertyValue(p); return o; };
  const r = (el) => { const b = el.getBoundingClientRect(); return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1), bottom: +b.bottom.toFixed(1) }; };
  const FONT = ['font-size', 'line-height', 'color', 'margin-top', 'margin-bottom'];
  const pick = (sel) => { const el = document.querySelector(sel); return el ? Object.assign({ sel }, cs(el, FONT)) : { sel, absent: true }; };
  const footR = foot.getBoundingClientRect();
  const bodyR = body.getBoundingClientRect();

  // 滚到底：最后一块说明完整可见 + 与固定操作区的安全间距
  body.scrollTop = body.scrollHeight;
  const maxTop = body.scrollTop;
  const lastEl = body.lastElementChild;
  const lastR = lastEl.getBoundingClientRect();
  const bodyClientBottom = bodyR.top + body.clientHeight;
  const gapFoot = +(footR.top - lastR.bottom).toFixed(1);

  // 策略说明去重口径
  const bodyText = body.textContent || '';
  const policyNotes = [...body.querySelectorAll('p.ev-src')].filter((p) => p.textContent.includes('test-any-file'));

  const out = {
    innerWidth: window.innerWidth, innerHeight: window.innerHeight,
    head: Object.assign(r(head), cs(head, ['height', 'box-sizing'])),
    body: Object.assign(cs(body, ['flex-grow', 'flex-shrink', 'min-height', 'overflow-y', 'overflow-x',
      'padding-top', 'padding-right', 'padding-bottom', 'padding-left'])),
    bodyRect: r(body),
    foot: Object.assign(r(foot), { hiddenAttr: foot.hidden }, cs(foot, ['height', 'display', 'box-sizing'])),
    footVisibleInView: footR.top >= 0 && footR.bottom <= window.innerHeight + 0.5,
    footPinnedWhileScrolled: Math.abs(foot.getBoundingClientRect().bottom - footR.bottom) < 0.5,
    bodyOverlapsFoot: bodyR.bottom > footR.top + 0.5,
    scroll: {
      scrollHeight: body.scrollHeight, clientHeight: body.clientHeight,
      maxTop, overflowX: body.scrollWidth - body.clientWidth,
      lastBlock: lastEl.className || lastEl.tagName,
      lastBottomMinusClientBottom: +(lastR.bottom - bodyClientBottom).toFixed(1),
      lastVisible: lastR.bottom <= bodyClientBottom + 0.5,
      gapToFoot: gapFoot,
      mmReadableAtBottom: mm ? mm.getBoundingClientRect().bottom <= bodyClientBottom + 0.5 : null,
    },
    paras: [pick('#insp-body .ip-note'), pick('#insp-body .rej-why'), pick('#insp-body .ev-demand'),
            pick('#insp-body p.ev-src'), pick('#insp-body .ip-sec .ip-v')],
    dedup: {
      policyChips: body.querySelectorAll('.ev-policy').length,
      policyNotes: policyNotes.length,
      testAnyFileInBodyText: bodyText.split('test-any-file').length - 1,
      policyNoteText: policyNotes[0] ? policyNotes[0].textContent.trim() : null,
      typeReqRow: (() => { const row = [...body.querySelectorAll('.ev-row')].find((x) => x.textContent.includes('类型要求')); return row ? row.textContent.trim() : null; })(),
    },
    mm: mm ? Object.assign(r(mm), cs(mm, ['background-color', 'font-size', 'line-height'])) : null,
  };
  body.scrollTop = 0;
  return out;
})()`;

async function openApproval(cdp) {
  await cdp.eval(`document.querySelector('.req-item[data-task="${TASK}"]')?.click()`);
  await sleep(400);
  await cdp.eval(`document.querySelector('.track-node[data-step="${STEP}"]')?.click()`);
  await sleep(1000); // 等文件核实 + version-gate 渲染稳定
}

async function main() {
  const out = { phase, base: BASE, task: TASK, step: STEP, when: new Date().toISOString(), viewports: [], refresh: null, poll: null };
  const profile = mkdtempSync(join(tmpdir(), 'w02r12-'));
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank',
  ], { stdio: 'ignore' });
  try {
    let targets = null;
    for (let i = 0; i < 50; i++) {
      try { const res = await fetch(`http://127.0.0.1:${PORT}/json/list`); targets = await res.json(); break; }
      catch { await sleep(200); }
    }
    if (!targets) throw new Error('chrome devtools port never came up');
    const page = targets.find((t) => t.type === 'page');
    const cdp = await CDP.connect(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

    for (const vp of VIEWPORTS) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: false });
      if (vp === VIEWPORTS[0]) {
        await cdp.send('Page.navigate', { url: BASE });
        for (let i = 0; i < 100; i++) {
          const ok = await cdp.eval(`!!document.querySelector('.req-item')`);
          if (ok) break; await sleep(200);
        }
      }
      await openApproval(cdp);
      const m = await cdp.eval(MEASURE);
      await cdp.eval(`document.getElementById('insp-body').scrollTop = document.getElementById('insp-body').scrollHeight`);
      await sleep(200);
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(`w02r12-${phase}-${vp.w}x${vp.h}-bottom.png`, Buffer.from(shot.data, 'base64'));
      out.viewports.push({ viewport: `${vp.w}x${vp.h}`, ...m });
      console.log(`\n===== ${vp.w}x${vp.h} =====`);
      console.log(JSON.stringify({
        head: { h: m.head.height }, foot: { h: m.foot.height, hidden: m.foot.hiddenAttr, visible: m.footVisibleInView, overlapsBody: m.bodyOverlapsFoot },
        body: { pad: [m.body['padding-top'], m.body['padding-right'], m.body['padding-bottom'], m.body['padding-left']], minH: m.body['min-height'], ovY: m.body['overflow-y'], ovX: m.body['overflow-x'], scroll: m.scroll },
        paras: m.paras.map((p) => ({ sel: p.sel, fs: p['font-size'], lh: p['line-height'], color: p.color, mt: p['margin-top'], mb: p['margin-bottom'], absent: p.absent })),
        dedup: m.dedup,
      }, null, 1));
    }

    // ---- 刷新留存（1440×900）：填备注 → 连续 10 次硬刷新 → scrollTop 偏差 + 备注逐字保留 ----
    if (phase !== 'baseline') {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
      const DRAFT = `W02r12-刷新留存验证-${Date.now()}-备注不能被清空`;
      const expected = DRAFT;
      const set0 = await cdp.eval(`(() => {
        const ta = document.getElementById('ip-decide-note');
        if (!ta) return { ok: false, why: 'no textarea' };
        ta.value = ${JSON.stringify(DRAFT)};
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        const b = document.getElementById('insp-body');
        b.scrollTop = 0;
        return { ok: true, typed: ta.value, top: b.scrollTop, saved: !!localStorage.getItem('office.notes') };
      })()`);
      const rounds = [];
      for (let i = 1; i <= 10; i++) {
        await cdp.send('Page.reload', { ignoreCache: true });
        await sleep(1200);
        for (let k = 0; k < 30; k++) {
          const ready = await cdp.eval(`!!document.getElementById('ip-decide-note') || !!document.querySelector('.req-item')`);
          if (ready) break; await sleep(200);
        }
        // 刷新后审批对象由 office.ui.v2 恢复；若未恢复则重新点开同一对象（对象不变）
        const restored = await cdp.eval(`!!document.getElementById('ip-decide-note')`);
        if (!restored) await openApproval(cdp);
        await sleep(300);
        const s = await cdp.eval(`(() => {
          const ta = document.getElementById('ip-decide-note');
          const b = document.getElementById('insp-body');
          return { top: b.scrollTop, note: ta ? ta.value : null,
                   stillApproval: !!document.querySelector('#insp-foot .btn-primary'),
                   stillTask: !!document.querySelector('.req-item.sel[data-task="${TASK}"]') };
        })()`);
        rounds.push({ i, ...s });
        console.log(`reload#${i}: top=${s.top} noteKeep=${s.note === expected} task=${s.stillTask}`);
      }
      const tops = rounds.map((s) => s.top);
      out.refresh = {
        draft: DRAFT, typedOk: set0.ok && set0.typed === DRAFT, localStorageBeforeReload: set0.saved,
        rounds,
        tops, maxDeviation: Math.max(...tops.map((t) => Math.abs(t - tops[0]))),
        noteKeptAll: rounds.every((s) => s.note === DRAFT),
        stillApprovalAll: rounds.every((s) => s.stillApproval),
        stillTaskAll: rounds.every((s) => s.stillTask),
      };
      console.log('\n===== refresh x10 =====');
      console.log(JSON.stringify({ tops: out.refresh.tops, maxDeviation: out.refresh.maxDeviation, noteKeptAll: out.refresh.noteKeptAll }, null, 1));
    }

    // ---- 滚动稳定性：1440×900，scrollTop=200，10 次数据刷新（3s 轮询） ----
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.eval(`document.getElementById('insp-body').scrollTop = 200`);
    const samples = []; const syncTexts = new Set();
    for (let i = 0; i < 10; i++) {
      await sleep(3000);
      const s = await cdp.eval(`(() => {
        const b = document.getElementById('insp-body');
        return { top: b.scrollTop,
                 sync: (document.getElementById('sb-sync')||{}).textContent || '',
                 stillApproval: !!document.querySelector('#insp-foot .btn-primary'),
                 stillTask: !!document.querySelector('.req-item.sel[data-task="${TASK}"]') };
      })()`);
      syncTexts.add(s.sync); samples.push(s);
    }
    const tops = samples.map((s) => s.top);
    out.poll = {
      setTo: 200, tops,
      min: Math.min(...tops), max: Math.max(...tops),
      maxDrift: Math.max(...tops.map((t) => Math.abs(t - 200))),
      pollCount: syncTexts.size,
      stillApprovalAll: samples.every((s) => s.stillApproval),
      stillTaskAll: samples.every((s) => s.stillTask),
    };
    console.log('\n===== poll stability (10 x 3s) =====');
    console.log(JSON.stringify(out.poll, null, 1));
  } finally {
    try { chrome.kill(); } catch {}
    try { execSync(`taskkill /PID ${chrome.pid} /T /F`, { stdio: 'ignore' }); } catch {}
  }
  writeFileSync(`w02r12-${phase}.json`, JSON.stringify(out, null, 1));
  console.log(`\nwrote w02r12-${phase}.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
