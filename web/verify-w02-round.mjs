// verify-w02-round.mjs — W02 本轮验收：审批详情正文完整滚动 + 固定操作区。
// 口径（任务书）：
//   ① #insp-body padding 16/16/80/16、flex:1、min-height:0、overflow-y:auto
//   ② .insp-head 48px / #insp-foot 64px、背景 #111823、顶部 1px #334155
//   ③ 正文 12px / 行高 19px
//   ④ 滚到底后最后一行与固定操作区间距 ≥16px，末行完整可见
//   ⑤ 按钮在滚动前/中/后始终位于视口内（getBoundingClientRect）
//   ⑥ 无整页水平滚动；滚动只发生在 #insp-body，不联动中间流水线（#center 不动）
// 视口：1440×900 与 1280×768（任务书只钉高度 900/768；宽度取 ≥1100 保持三栏常驻布局）。
// 两组数据各测一次：A=真实审批内容（TEST-R11/plan，现有最长审批说明：对象+策略依据）；
// B=注入长段落后（滚动压力，注入+滚动+测量同一 eval 原子完成，避开 3 秒轮询重渲染）。
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9347;
const BASE = 'http://127.0.0.1:8090';
const TASK = 'TEST-R11';        // 现有最长审批文档：app.css 审批对象 + test-any-file 策略依据
const STEP = 'plan';
const LONG =
  'W02 本轮滚动验证占位段：把审批正文拉长到超过滚动区高度，验证滚到底后末行完整可见、与固定操作区相隔≥16px。'.repeat(24);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) { this.sock = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } }); }
  static async connect(url) { const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    return new CDP(ws); }
  send(method, params = {}) { const id = ++this.id;
    this.sock.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject })); }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result.value; }
}

const MEASURE = (mode) => `(() => {
  const mode = ${JSON.stringify(mode)};
  const body = document.getElementById('insp-body');
  const head = document.querySelector('#inspector .insp-head');
  const foot = document.getElementById('insp-foot');
  const content = body.querySelector('.inspector-content');
  if (!content) return { error: 'no inspector-content' };
  if (mode === 'long' && !document.getElementById('w02-probe')) {
    const p = document.createElement('p');
    p.id = 'w02-probe'; p.className = 'ip-note';
    p.textContent = ${JSON.stringify(LONG)};
    content.appendChild(p);
  }
  const probe = mode === 'long' ? document.getElementById('w02-probe') : content.lastElementChild;
  const csB = getComputedStyle(body), csF = getComputedStyle(foot), csH = getComputedStyle(head);
  const center = document.getElementById('center');

  // ①②③ 规格实测
  const specs = {
    bodyPadding: [csB.paddingTop, csB.paddingRight, csB.paddingBottom, csB.paddingLeft],
    bodyFlexGrow: csB.flexGrow, bodyMinHeight: csB.minHeight, bodyOverflowY: csB.overflowY,
    headH: csH.height, footH: csF.height,
    footBg: csF.backgroundColor, footBorderTop: csF.borderTopWidth + ' ' + csF.borderTopStyle + ' ' + csF.borderTopColor,
    text125: (() => { const t = body.querySelector('.ip-note') || body.querySelector('.ev-src');
      const c = getComputedStyle(t); return [c.fontSize, c.lineHeight]; })(),
  };

  // ⑤ 按钮始终在视口内：滚动前 / 中 / 底 三拍采样
  const btnInVp = () => [...foot.querySelectorAll('button')].every((b) => {
    const r = b.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= window.innerHeight && r.height > 0;
  });
  const centerR0 = center.getBoundingClientRect();
  const btnTop = btnInVp();
  body.scrollTop = Math.floor((body.scrollHeight - body.clientHeight) / 2);
  const btnMid = btnInVp();
  body.scrollTop = body.scrollHeight;                    // 滚到最底
  const btnBottom = btnInVp();

  const headR = head.getBoundingClientRect(), bodyR = body.getBoundingClientRect(),
        footR = foot.getBoundingClientRect(), probeR = probe.getBoundingClientRect();
  const centerR1 = center.getBoundingClientRect();

  return {
    ...specs,
    stackOk: headR.bottom <= bodyR.top + 0.5 && bodyR.bottom <= footR.top + 0.5,   // 48 / 滚动 / 64 三段邻接
    scrollH: body.scrollHeight, clientH: body.clientHeight, scrolledTo: body.scrollTop,
    maxScroll: body.scrollHeight - body.clientHeight,
    lastBottom: +probeR.bottom.toFixed(1), bodyViewBottom: +bodyR.bottom.toFixed(1), footTop: +footR.top.toFixed(1),
    lastLineFullyVisible: probeR.bottom <= bodyR.bottom + 0.5,          // ④ 末行完整可见
    gapLastToFoot: +(footR.top - probeR.bottom).toFixed(1),             // ④ 与固定操作区间距 ≥16
    overlapBodyFoot: bodyR.bottom > footR.top + 0.5,                    // 正文容器不得压进底栏
    btnInVp: { top: btnTop, mid: btnMid, bottom: btnBottom },           // ⑤
    footBtns: [...foot.querySelectorAll('button')].map((b) => b.textContent.trim()),
    outerScrollXY: [window.scrollX, window.scrollY],
    docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,  // ⑥ 整页无水平滚动
    bodyOverflowX: body.scrollWidth - body.clientWidth,                 // ⑥ 正文区无水平溢出
    centerMoved: +(Math.abs(centerR1.top - centerR0.top)).toFixed(1)
      + +(Math.abs(centerR1.left - centerR0.left)).toFixed(1),          // ⑥ 中栏不联动（应 0）
  };
})()`;

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'w02round-cdp-'));
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank',
  ], { stdio: 'ignore' });
  let failed = 0;
  const check = (name, ok, detail) => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ← ' + detail}`);
    if (!ok) failed++;
  };
  try {
    let targets = null;
    for (let i = 0; i < 50; i++) {
      try { const res = await fetch(`http://127.0.0.1:${PORT}/json/list`); targets = await res.json(); break; }
      catch { await sleep(200); }
    }
    const page = targets.find((t) => t.type === 'page');
    const cdp = await CDP.connect(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    for (const vp of [{ w: 1440, h: 900 }, { w: 1280, h: 768 }]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: false });
      await cdp.send('Page.navigate', { url: BASE });
      for (let i = 0; i < 100; i++) { if (await cdp.eval(`!!document.querySelector('.req-item')`)) break; await sleep(200); }
      await cdp.eval(`document.querySelector('.req-item[data-task="${TASK}"]')?.click()`);
      await sleep(400);
      await cdp.eval(`document.querySelector('.track-node[data-step="${STEP}"]')?.click()`);
      await sleep(1000);   // 等 version-gate 异步判定落定，避免测量时按钮状态中途变化
      console.log(`\n===== ${vp.w}x${vp.h} =====`);
      for (const mode of ['real', 'long']) {
        const m = await cdp.eval(MEASURE(mode));
        console.log(`[${mode === 'real' ? 'A 真实内容' : 'B 长文注入'}] ${JSON.stringify(m)}`);
        const tag = `[${mode}]`;
        check(`${tag} body padding 16/16/80/16`, m.bodyPadding.join('|') === '16px|16px|80px|16px', m.bodyPadding.join('|'));
        check(`${tag} body flex:1 + min-height:0 + overflow-y:auto`,
          m.bodyFlexGrow === '1' && m.bodyMinHeight === '0px' && m.bodyOverflowY === 'auto',
          `${m.bodyFlexGrow}/${m.bodyMinHeight}/${m.bodyOverflowY}`);
        check(`${tag} head 48px`, m.headH === '48px', m.headH);
        check(`${tag} foot 64px`, m.footH === '64px', m.footH);
        check(`${tag} foot bg #111823`, m.footBg === 'rgb(17, 24, 35)', m.footBg);
        check(`${tag} foot border-top 1px solid #334155`,
          m.footBorderTop === '1px solid rgb(51, 65, 85)', m.footBorderTop);
        check(`${tag} 正文 12px/19px`, m.text125.join('/') === '12px/19px', m.text125.join('/'));
        check(`${tag} 三段邻接 48/滚/64`, m.stackOk === true);
        check(`${tag} 滚到底（B 组须 maxScroll>0 且已滚满）`,
          mode === 'real' || (m.maxScroll > 0 && m.scrolledTo >= m.maxScroll - 1),
          `max=${m.maxScroll} at=${m.scrolledTo}`);
        check(`${tag} 末行完整可见`, m.lastLineFullyVisible === true, `lastBottom=${m.lastBottom} viewBottom=${m.bodyViewBottom}`);
        check(`${tag} 末行与固定操作区间距 ≥16px`, m.gapLastToFoot >= 16, `gap=${m.gapLastToFoot}`);
        check(`${tag} 正文不被固定区遮挡`, m.overlapBodyFoot === false);
        check(`${tag} 按钮滚动前/中/后均在视口`, m.btnInVp.top && m.btnInVp.mid && m.btnInVp.bottom, JSON.stringify(m.btnInVp));
        check(`${tag} 整页无水平滚动`, m.docOverflowX === 0, `docOverflowX=${m.docOverflowX}`);
        check(`${tag} 正文区无水平溢出`, m.bodyOverflowX <= 0, `bodyOverflowX=${m.bodyOverflowX}`);
        check(`${tag} 中栏不联动`, m.centerMoved === 0, `centerMoved=${m.centerMoved}`);
      }
    }
    console.log(failed === 0 ? '\nALL PASS' : `\n${failed} CHECK(S) FAILED`);
    process.exitCode = failed === 0 ? 0 : 1;
  } finally {
    try { chrome.kill(); } catch {}
    try { execSync(`taskkill /PID ${chrome.pid} /T /F`, { stdio: 'ignore' }); } catch {}
  }
}
main().catch((e) => { console.error('FAIL', e); process.exit(1); });
