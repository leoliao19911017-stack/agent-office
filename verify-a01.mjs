// A01 验收：通过 8090 服务实测 Agents 页渲染 DOM（每视口独立无头 Chrome + 一次性 CDP 会话）。
// Node 20 无 WebSocket 全局 → 内置最小 WS 客户端。不发 Runtime.enable（避开本机偶发的连接抢断）。
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const TARGET = 'http://127.0.0.1:8090/#/agents';
const OUT_DIR = 'C:/Users/Administrator/Desktop/Soda Intelligence - AI Native Thinking/Soda Office/verify-assets/task-a01/';

function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': 13 },
    });
    req.on('upgrade', (res, socket) => {
      const sender = { socket, nextId: 1, pending: new Map() };
      let buf = Buffer.alloc(0);
      const deliver = (obj) => {
        if (obj.id && sender.pending.has(obj.id)) {
          const { res: r, rej } = sender.pending.get(obj.id);
          sender.pending.delete(obj.id);
          obj.error ? rej(new Error(JSON.stringify(obj.error))) : r(obj.result);
        }
      };
      const parseFrame = () => {
        while (buf.length >= 2) {
          const b0 = buf[0], b1 = buf[1];
          const opcode = b0 & 0x0f;
          let len = b1 & 0x7f, off = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (buf.length < 10) return; len = buf.readUInt32BE(2) * 2 ** 32 + buf.readUInt32BE(6); off = 10; }
          if (b1 & 0x80) off += 4;
          if (buf.length < off + len) return;
          const payload = buf.subarray(off, off + len);
          buf = buf.subarray(off + len);
          const fin = (b0 & 0x80) !== 0;
          if (opcode === 9) socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
          else if (opcode === 8) { socket.destroy(); return; }
          else if (opcode === 1 || opcode === 2 || opcode === 0) {
            const chunks = (sender._frag ||= { chunks: [] }).chunks;
            chunks.push(payload);
            if (fin) { sender._frag = null; try { deliver(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch {} }
          }
        }
      };
      socket.on('data', (d) => { buf = Buffer.concat([buf, d]); parseFrame(); });
      socket.on('close', () => { for (const { rej } of sender.pending.values()) rej(new Error('cdp socket closed')); sender.pending.clear(); });
      socket.on('error', () => {});
      sender.send = (method, params) => new Promise((res2, rej2) => {
        const id = sender.nextId++;
        sender.pending.set(id, { res: res2, rej: rej2 });
        const json = Buffer.from(JSON.stringify(params === undefined ? { id, method } : { id, method, params }));
        const mask = crypto.randomBytes(4);
        let head;
        if (json.length < 126) head = Buffer.from([0x81, 0x80 | json.length]);
        else if (json.length < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(json.length, 2); }
        else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(json.length), 2); }
        for (let i = 0; i < json.length; i++) json[i] ^= mask[i & 3];
        socket.write(Buffer.concat([head, mask, json]));
      });
      sender.close = () => socket.destroy();
      resolve(sender);
    });
    req.on('response', (r) => reject(new Error('no upgrade ' + r.statusCode)));
    req.on('error', reject);
    req.end();
  });
}

const getJSON = (port, path) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port, path }, (r) => {
    let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MEASURE = `(() => {
  const q = s => document.querySelector(s);
  const r = el => { const b = el.getBoundingClientRect(); return {left:+b.left.toFixed(1), top:+b.top.toFixed(1), right:+b.right.toFixed(1), bottom:+b.bottom.toFixed(1), width:+b.width.toFixed(1), height:+b.height.toFixed(1)}; };
  const cs = (el, props) => { const c = getComputedStyle(el); return Object.fromEntries(props.map(p=>[p,c[p]])); };
  const out = { viewport:{w:innerWidth,h:innerHeight}, dataPage:document.body.dataset.page };
  const heading = q('#page-agents .page-heading');
  out.heading = heading ? r(heading) : null;
  const h1 = q('#page-agents h1');
  out.h1 = h1 ? {rect:r(h1), cs:cs(h1,['fontSize','lineHeight','fontWeight'])} : null;
  out.modulePaddingLeft = cs(q('#page-agents'),['paddingLeft']).paddingLeft;
  out.oldSummaryPresent = !!q('#agent-summary');
  out.sumChipsCount = document.querySelectorAll('.sum-chips').length;
  out.summaryText = q('#agent-summary')?.textContent?.trim().slice(0,140) ?? null;
  const cards = [...document.querySelectorAll('#agent-stats .stat-card')];
  out.cards = cards.map(c=>({rect:r(c), label:c.querySelector('.sc-label')?.textContent, num:c.querySelector('.sc-num')?.textContent,
    cs:cs(c,['width','height','backgroundColor','borderColor','borderRadius','borderTopWidth'])}));
  out.labelCs = cards.map(c=>cs(c.querySelector('.sc-label'),['fontSize','lineHeight']));
  out.numCs = cards.map(c=>cs(c.querySelector('.sc-num'),['fontSize','lineHeight']));
  const tops = cards.map(c=>c.getBoundingClientRect().top), lefts = cards.map(c=>c.getBoundingClientRect().left);
  out.cardTops = tops.map(t=>+t.toFixed(1));
  out.cardTopMaxDiff = tops.length ? +(Math.max(...tops)-Math.min(...tops)).toFixed(2) : null;
  out.cardLeftDeltas = lefts.length>1 ? lefts.slice(1).map((l,i)=>+(l-lefts[i]).toFixed(1)) : [];
  const scope = q('#agent-scope');
  out.scope = scope ? {rect:r(scope), cs:cs(scope,['fontSize','lineHeight','color']), lines:+(scope.getBoundingClientRect().height/18).toFixed(1), text:scope.textContent.slice(0,180)} : null;
  const roster = q('.roster-head');
  out.rosterHead = roster ? {rect:r(roster)} : null;
  out.gapScopeToRoster = (scope&&roster) ? +(roster.getBoundingClientRect().top-scope.getBoundingClientRect().bottom).toFixed(1) : null;
  out.gapHeadingToScope = (scope&&heading) ? +(scope.getBoundingClientRect().top-heading.getBoundingClientRect().bottom).toFixed(1) : null;
  out.statGapCss = q('#agent-stats') ? cs(q('#agent-stats'),['gap','marginTop','marginBottom']).gap : null;
  return JSON.stringify(out);
})()`;

async function measureViewport(w, h, tag) {
  const port = 9350 + Math.floor(Math.random() * 200); // 随机端口，避免与残留实例冲突
  const profile = `${OUT_DIR}profile-${port}`;
  rmSync(profile, { recursive: true, force: true });
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${port}`, '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--hide-scrollbars', `--window-size=${w},${h}`,
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });
  try {
    let list;
    for (let i = 0; i < 50; i++) { await sleep(150); try { list = await getJSON(port, '/json/list'); if (list.length) break; } catch {} }
    if (!list?.length) throw new Error('chrome did not start');
    const page = list.find((t) => t.type === 'page');
    const cdp = await wsConnect(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: TARGET });
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      await sleep(200);
      try {
        const v = await cdp.send('Runtime.evaluate', { expression: `(() => {
          const cards = document.querySelectorAll('#agent-stats .stat-card').length;
          const scope = (document.getElementById('agent-scope')?.textContent || '').length;
          return document.body.dataset.page === 'agents' && (cards > 0 || scope > 0);
        })()`, returnByValue: true });
        ready = v.result?.value === true;
      } catch (e) { if (String(e).includes('closed')) throw e; }
    }
    await sleep(500); // 布局稳定
    const meas = await cdp.send('Runtime.evaluate', { expression: MEASURE, returnByValue: true });
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`${OUT_DIR}${w}x${h}-${tag}.png`, Buffer.from(shot.data, 'base64'));
    cdp.close();
    return { ready, ...JSON.parse(meas.result.value) };
  } finally {
    chrome.kill();
    // Crashpad 句柄释放需要时间，清理失败不影响测量结果
    setTimeout(() => { try { rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); } catch {} }, 500).unref?.();
  }
}

async function main() {
  const tag = process.argv[2] || 'run';
  mkdirSync(OUT_DIR, { recursive: true });
  const results = {};
  for (const [w, h] of [[1440, 900], [1280, 800], [1100, 768]]) {
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { results[`${w}x${h}`] = await measureViewport(w, h, tag); lastErr = null; break; }
      catch (e) { lastErr = e; console.error(`[retry] ${w}x${h} #${attempt}:`, e.message); }
    }
    if (lastErr) results[`${w}x${h}`] = { error: lastErr.message };
    console.error(`[done] ${w}x${h}`);
  }
  console.log(JSON.stringify(results, null, 1));
}
main().catch((e) => { console.error('FAIL', e); process.exit(1); });
