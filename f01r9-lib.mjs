// F01 第 9 轮共用库：最小 CDP 客户端 + R11 行测量/断言助手。
// 用法：import { connect, evalJs, send, ... } from './f01r9-lib.mjs'
const BASE = 'http://127.0.0.1:8090';
export { BASE };

let ws = null, msgId = 0;
const pending = new Map();
export const pageErrors = [];
export function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    // 看门狗：响应丢失（导航换上下文等竞态）时 15s 后拒绝，不让整条脚本挂死
    const timer = setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP 超时: ${method}`)); } }, 15000);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
export async function connect(port) {
  let targets = null;
  for (let i = 0; i < 40; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); break; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  if (!targets) throw new Error('CDP 端口没起来');
  let page = targets.find((t) => t.type === 'page' && t.url.startsWith(BASE));
  if (!page) page = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    } else if (m.method === 'Runtime.exceptionThrown') {
      pageErrors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '?');
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      pageErrors.push('console.error: ' + JSON.stringify(m.params.args?.map((a) => a.value ?? a.description)));
    }
  };
  return page;
}
export async function evalJs(expression, awaitPromise = false) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) throw new Error('页面 JS 异常: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.params?.text || r.exceptionDetails.text));
  return r.result.value;
}
export async function waitFor(expr, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await evalJs(expr);
      if (v) return v;
    } catch (e) { /* 导航切换上下文的瞬间会抛错，继续轮询 */ }
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时: ${label}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}
// 页面导航必须走 Page.navigate：在 evaluate 里写 location.href 会让响应随上下文一起消失（挂死）。
export async function goto(url) {
  try { await send('Page.navigate', { url }); } catch { /* 目标已在导航，忽略 */ }
  await new Promise((r) => setTimeout(r, 800));
}
export async function screenshot(name) {
  const { writeFileSync } = await import('node:fs');
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(r.data, 'base64');
  writeFileSync(name, buf);
  return buf.length;
}

// 进入文件页并等 R11 组的 app.css 行出现（返回行数）。rail 有覆盖层，脚本切页走 hash。
export async function gotoFiles() {
  await goto('http://127.0.0.1:8090/#/files');
  await waitFor(`!!document.querySelector('#file-groups .library-file')`, 8000, '文件页渲染');
}

// 页面侧一次性原子测量：R11 组里 data-open-file 指向 app.css 的那一行。
// findRow 的匹配口径与页面 physKey 无关，直接按路径含 'app.css' 且组头含 'TEST-R11' 取。
export const MEASURE_DEFINE = `window.__r11Measure = () => {
  const groups = [...document.querySelectorAll('#file-groups .filegroup')];
  const g = groups.find(x => (x.querySelector('summary,#fg-title,.ff-title')?.textContent || '').includes('（2 条登记）')) || groups.find(x => (x.querySelector('summary,.ff-title')?.textContent||'').includes('R11 决策端点'));
  if (!g) return { err: 'no TEST-R11 group', groupCount: groups.length };
  const row = [...g.querySelectorAll('.library-file')].find(r => (r.dataset.openFile || '').includes('app.css'));
  if (!row) return { err: 'no app.css row in R11 group' };
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1), l: +b.left.toFixed(1), right: +b.right.toFixed(1), top: +b.top.toFixed(1), bottom: +b.bottom.toFixed(1) }; };
  const cs = (el, props) => { if (!el) return null; const c = getComputedStyle(el); return Object.fromEntries(props.map(p => [p, c[p]])); };
  const meta = row.querySelector('.lf-meta');
  const actions = row.querySelector('.lf-actions');
  const main = row.querySelector('.lf-main');
  const lines = row.querySelector('.lf-lines');
  const sizeSpans = lines ? [...lines.querySelectorAll('.lf-size')].map(s => ({ text: s.textContent, title: (s.title || '').slice(0, 200), ...cs(s, ['fontSize', 'lineHeight', 'color']) })) : [];
  return {
    groupTitle: (g.querySelector('summary,#fg-title,.ff-title')?.textContent || '').trim(),
    rowRect: r(row), metaRect: r(meta), actionsRect: r(actions), mainRect: r(main), linesRect: r(lines),
    rowStyle: cs(row, ['backgroundColor', 'borderTopWidth', 'borderTopColor', 'borderTopStyle', 'borderRadius', 'minHeight', 'maxHeight', 'height']),
    metaStyle: cs(meta, ['width', 'fontSize', 'lineHeight', 'color']),
    linesStyle: lines ? cs(lines, ['gap', 'rowGap']) : null,
    sizeSpans,
    tagText: row.querySelector('.lf-tag')?.textContent || null,
    execText: row.querySelector('.lf-exec')?.textContent || null,
    typeText: row.querySelector('.lf-type')?.textContent || null,
    srcText: row.querySelector('.lf-src')?.textContent || null,
    nameText: row.querySelector('.lf-name')?.textContent || null,
    titleAttr: (row.title || '').slice(0, 400),
    gapMetaToActions: meta && actions ? +(actions.getBoundingClientRect().left - meta.getBoundingClientRect().right).toFixed(1) : null,
    overlapMetaActions: meta && actions ? !(meta.getBoundingClientRect().right <= actions.getBoundingClientRect().left) : null,
    // 页面数据侧：两条登记 + 实体 + 实测（一次读全，防轮询换引用）
    regs: (() => { const pk = physKey('C:/Users/Administrator/Desktop/Soda Intelligence - AI Native Thinking/Soda Office/web/app.css'); return (fileRegsByPath.get(pk) || []).map(x => ({ id: x.meta.taskId + '›' + x.meta.stepKey, stepNo: x.meta.stepNo, stepName: x.meta.stepName, taskTitle: x.meta.taskTitle, by: x.meta.by, at: x.meta.at, path: x.f.path, bytes: x.f.bytes, sha256: x.f.sha256 || null })); })(),
    entityRefs: (() => { const pk = physKey('C:/Users/Administrator/Desktop/Soda Intelligence - AI Native Thinking/Soda Office/web/app.css'); const m = fileEntitiesByPath.get(pk); return m ? [...m.values()].map(e => ({ vk: e.vk, refs: e.refs.length })) : null; })(),
    actual: (() => { const pk = physKey('C:/Users/Administrator/Desktop/Soda Intelligence - AI Native Thinking/Soda Office/web/app.css'); const s = fileStatus.get(pk); return s ? { exists: s.exists, bytes: s.bytes } : null; })(),
    totalRegs: [...fileRegsByPath.values()].reduce((n, l) => n + l.length, 0),
  }; }; true`;
