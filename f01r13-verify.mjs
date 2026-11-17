// F01 第 13 轮验证：历史登记版本信息两行布局（左 28px 版本编号 + 右自适应信息）。
// 运行：node --experimental-websocket f01r13-verify.mjs
// 证据落 verify-assets/f01-r13/（results.json + 截图）。
import { connect, evalJs, send, waitFor, screenshot, gotoFiles, pageErrors, BASE } from './f01r9-lib.mjs';
import { writeFileSync } from 'node:fs';

const OUT = 'verify-assets/f01-r13/';
const results = [];
const T = (name, pass, detail) => {
  results.push({ name, pass: !!pass, detail });
  console.log((pass ? 'PASS' : 'FAIL') + ' | ' + name + ' | ' + String(detail).replace(/\n/g, ' ').slice(0, 260));
};

// ---------- 地面真值：API 直读（不经过页面代码） ----------
const flow = await (await fetch(BASE + '/api/office/flow')).json();
const task = (flow.tasks || []).find((t) => t.id === 'TEST-F01R10');
T('API 地面真值：TEST-F01R10 存在', !!task, task ? task.title : '未找到');
const gt = [];
for (const s of (task.steps || []).slice().sort((a, b) => (a.no ?? 0) - (b.no ?? 0)))
  for (const f of s.files || [])
    gt.push({ id: 'TEST-F01R10›' + s.key, no: String(s.no).padStart(2, '0'), stepName: s.name, bytes: f.bytes, sha: f.sha256, at: s.at, path: f.path });
T('API 登记条数 = 4', gt.length === 4, gt.length);

// node 复刻 physKey（app.js:122-134，逐字符同源）
const physKey = (p) => {
  let s = String(p ?? '').trim().replace(/\\/g, '/');
  if (/^\/\/\?\/unc\//i.test(s)) s = '//' + s.slice(8);
  else s = s.replace(/^\/\/[?.]+\/?/, '');
  const msys = s.match(/^\/([a-z])(\/|$)/i);
  if (msys) s = msys[1].toLowerCase() + ':' + s.slice(2);
  const unc = s.startsWith('//');
  s = s.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  if (unc) s = '/' + s;
  return s.toLowerCase();
};
const pks = [...new Set(gt.map((r) => physKey(r.path)))];
T('node 复刻 physKey：4 条登记分属 2 个物理路径', pks.length === 2, pks.map((p) => p.slice(-28)));
const byTime = (a, b) => String(a.at || '').localeCompare(String(b.at || ''));
const sha6 = (s) => (s || '').slice(0, 6);
const fmtBytesNode = (b) => (b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : (b / 1048576).toFixed(1) + ' MB');
const lab = (b) => fmtBytesNode(b).replace(' ', '');
// fmtTime 复刻（app.js:54-64）：同日 HH:MM，跨日 M/D HH:MM，分钟精度
const fmtTimeNode = (iso) => {
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return '—';
  const now = new Date(); const sameDay = d.toDateString() === now.toDateString();
  const hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0');
  return sameDay ? hh + ':' + mm : d.getMonth() + 1 + '/' + d.getDate() + ' ' + hh + ':' + mm;
};
// 磁盘实测（只读）：两 fixture 的当前字节数
const { statSync, readFileSync } = await import('node:fs');
const disk = {};
for (const pk of pks) {
  try { disk[pk] = { bytes: statSync(pk).size }; } catch { disk[pk] = null; }
}

// 每物理文件的期望登记行（页面顺序：当前版本在前，历史按时间倒序——lf-phys；
// lf-multi 按步骤号升序 refs）——四要素逐项核对用
const expect = {};
for (const pk of pks) {
  const regs = gt.filter((r) => physKey(r.path) === pk);
  const curB = disk[pk] ? disk[pk].bytes : null;
  const cur = curB != null ? regs.filter((r) => r.bytes === curB) : [];
  const hist = regs.filter((r) => !cur.includes(r));
  hist.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  const ordered = [...cur, ...hist];   // lf-phys 顺序（fileButton refs 则按步骤序，核对不依赖顺序）
  expect[pk] = ordered.map((r) => ({
    vno: r.no,
    t1: lab(r.bytes) + '·' + sha6(r.sha) + (curB == null ? '' : r.bytes === curB ? ' ✓' : ' ≠'),
    t2: fmtTimeNode(r.at),
    cls: curB == null || r.bytes == null ? 'lf-unver' : r.bytes === curB ? 'lf-cur' : 'lf-hist',
    bytes: r.bytes, sha: r.sha, at: r.at, id: r.id, stepName: r.stepName,
  }));
}

// ---------- CDP ----------
const port = 9466;
await connect(port);
await send('Page.enable'); await send('Runtime.enable');

async function setViewport(w) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
  await new Promise((r) => setTimeout(r, 350));
}

// 页面侧原子测量（一次 evalJs 读全，防轮询间 DOM 变化）
const MEASURE = `(() => {
  const g = document.querySelector('details.filegroup[data-group="TEST-F01R10"]');
  if (!g) return { error: 'F01 组未找到' };
  const rows = [...g.querySelectorAll('.library-file')];
  const R = (el) => { const b = el.getBoundingClientRect(); return { top: +b.top.toFixed(1), bottom: +b.bottom.toFixed(1), left: +b.left.toFixed(1), right: +b.right.toFixed(1), width: +b.width.toFixed(1), height: +b.height.toFixed(1) }; };
  const CS = (el, ps) => { const c = getComputedStyle(el); const o = {}; for (const p of ps) o[p] = c.getPropertyValue(p); return o; };
  const rowOf = (row) => {
    const meta = row.querySelector('.lf-meta');
    const items = [...row.querySelectorAll('.lf-vrow')];
    return {
      cls: row.className,
      name: row.querySelector('.lf-name')?.textContent || '',
      path: row.getAttribute('data-open-file') || '',
      rowRect: R(row),
      metaRect: meta ? R(meta) : null,
      regsAttr: JSON.parse(row.getAttribute('data-regs') || '[]'),
      items: items.map((it) => {
        const vno = it.querySelector('.lf-vno'), vbody = it.querySelector('.lf-vbody');
        const l1 = it.querySelector('.lf-vl1'), tm = it.querySelector('.lf-vtime');
        return {
          cls: it.className,
          regAttrs: { vkey: it.getAttribute('data-reg-vkey'), taskId: it.getAttribute('data-task-id'), stepKey: it.getAttribute('data-step-key') },
          regsAttr: JSON.parse(it.getAttribute('data-regs') || '[]'),
          vnoText: vno?.textContent, l1Text: l1?.textContent, tmText: tm?.textContent,
          style: CS(it, ['font-family', 'font-size', 'line-height', 'height', 'color', 'display', 'gap']),
          vnoStyle: vno ? CS(vno, ['width', 'flex', 'font-family']) : null,
          itRect: R(it), vnoRect: vno ? R(vno) : null, vbodyRect: vbody ? R(vbody) : null,
          l1Rect: l1 ? R(l1) : null, tmRect: tm ? R(tm) : null,
          l1Clip: l1 ? { sw: l1.scrollWidth, cw: l1.clientWidth } : null,
          tmClip: tm ? { sw: tm.scrollWidth, cw: tm.clientWidth } : null,
        };
      }),
    };
  };
  const unverProbe = (() => {   // 不可核验色是规则级验证：临时挂一个 lf-unver 行量 computed color，量完即删，不碰数据
    const host = g.querySelector('.library-file .lf-lines');
    if (!host) return { err: '无 .lf-lines 容器' };
    const s = document.createElement('span');
    s.className = 'lf-size lf-reg lf-vrow lf-unver'; s.textContent = 'probe';
    host.appendChild(s);
    const c = getComputedStyle(s).color; const fam = getComputedStyle(s).fontFamily; const fs = getComputedStyle(s).fontSize; const lh = getComputedStyle(s).lineHeight; const h = getComputedStyle(s).height;
    s.remove();
    return { color: c, fontFamily: fam, fontSize: fs, lineHeight: lh, height: h };
  })();
  return {
    groupSummary: (g.querySelector('summary')?.textContent || '').trim(),
    topCount: (document.getElementById('file-count')?.textContent || '').trim(),
    rowCount: rows.length, vrowCount: g.querySelectorAll('.lf-vrow').length,
    rows: rows.map(rowOf),
    docScrollW: document.documentElement.scrollWidth, winW: window.innerWidth,
    bodyScrollW: document.body.scrollWidth,
    unverProbe,
    pageErrors: window.__errs || 0,
  };
})()`;

// —— 1440px ——
await setViewport(1440);
await gotoFiles();
// 已知坑：浏览器 HTTP 缓存会端着旧 app.css 不放——改样式后必须整页无缓存重读
await send('Page.reload', { ignoreCache: true });
await new Promise((r) => setTimeout(r, 900));
await waitFor(`!!document.querySelector('details.filegroup[data-group="TEST-F01R10"] .lf-vrow')`, 10000, 'F01 两行布局渲染');
await evalJs(`document.querySelector('details.filegroup[data-group="TEST-F01R10"]').scrollIntoView({block:'start'})`);
await new Promise((r) => setTimeout(r, 400));
const m1440 = await evalJs(MEASURE);

// —— 1280px ——
await setViewport(1280);
await new Promise((r) => setTimeout(r, 400));
const m1280 = await evalJs(MEASURE);

// —— 断言 ——
const g1 = m1440;
T('组头计数：2 个产物（4 条登记）', /2 个产物（4 条登记）/.test(g1.groupSummary), g1.groupSummary);
T('F01 组主行数 = 2', g1.rowCount === 2, g1.rowCount);
T('F01 组登记行数 = 4', g1.vrowCount === 4, g1.vrowCount);

for (const m of [['1440', m1440], ['1280', m1280]]) {
  const [w, d] = m;
  T(`[${w}] 页面无水平溢出`, d.docScrollW <= d.winW && d.bodyScrollW <= d.winW, `docScrollW=${d.docScrollW} bodyScrollW=${d.bodyScrollW} winW=${d.winW}`);
  for (const row of d.rows) {
    const pk = physKey(row.path);
    const exp = expect[pk] || [];
    T(`[${w}] ${row.name} 登记行数 = ${exp.length}`, row.items.length === exp.length, `${row.items.length}（期望 ${exp.length}）`);
    for (const it of row.items) {
      const e = exp.find((x) => x.vno === it.vnoText && x.t1 === it.l1Text && x.t2 === it.tmText) || exp.find((x) => x.id === it.regAttrs.taskId + '›' + it.regAttrs.stepKey);
      T(`[${w}] ${row.name} ${it.vnoText} 四要素一致`, !!e && e.t1 === it.l1Text && e.t2 === it.tmText, `页面「${it.vnoText}｜${it.l1Text}｜${it.tmText}」 期望「${e ? e.vno + '｜' + e.t1 + '｜' + e.t2 : '未匹配'}」`);
      T(`[${w}] ${row.name} ${it.vnoText} 分色=${e ? e.cls : '?'}`, e ? it.cls.includes(e.cls) : false, it.cls);
      T(`[${w}] ${row.name} ${it.vnoText} 单条高 36px`, Math.abs(it.itRect.height - 36) < 0.6, it.itRect.height);
      T(`[${w}] ${row.name} ${it.vnoText} 左列 28px`, Math.abs((it.vnoRect?.width || 0) - 28) < 0.6, it.vnoRect?.width + ' / css:' + (it.vnoStyle?.width || '?'));
      T(`[${w}] ${row.name} ${it.vnoText} 字体 12px 等宽 18px`, it.style['font-size'] === '12px' && it.style['line-height'] === '18px' && /Cascadia|mono/i.test(it.style['font-family']), `${it.style['font-size']}/${it.style['line-height']}/${it.style['font-family'].slice(0, 24)}`);
      const colors = { 'lf-cur': 'rgb(101, 217, 177)', 'lf-hist': 'rgb(179, 192, 210)', 'lf-unver': 'rgb(229, 185, 94)' };
      const want = e ? colors[e.cls] : null;
      T(`[${w}] ${row.name} ${it.vnoText} 颜色 ${want}`, it.style.color === want, it.style.color);
      T(`[${w}] ${row.name} ${it.vnoText} 时间独占第二行`, it.l1Rect && it.tmRect && it.l1Rect.bottom <= it.tmRect.top + 0.6 && Math.abs(it.tmRect.top - it.l1Rect.top - 18) < 1, `l1.bottom=${it.l1Rect?.bottom} tm.top=${it.tmRect?.top} Δtop=${it.tmRect && it.l1Rect ? +(it.tmRect.top - it.l1Rect.top).toFixed(1) : '?'}`);
      T(`[${w}] ${row.name} ${it.vnoText} 左右列不重叠`, it.vnoRect && it.vbodyRect && it.vnoRect.right <= it.vbodyRect.left + 0.6, `vno.right=${it.vnoRect?.right} vbody.left=${it.vbodyRect?.left}`);
      T(`[${w}] ${row.name} ${it.vnoText} 文本无截断`, it.l1Clip.sw <= it.l1Clip.cw + 1 && it.tmClip.sw <= it.tmClip.cw + 1, `l1 ${it.l1Clip.sw}/${it.l1Clip.cw} tm ${it.tmClip.sw}/${it.tmClip.cw}`);
      T(`[${w}] ${row.name} ${it.vnoText} 点击身份完整`, !!it.regAttrs.vkey && !!it.regAttrs.taskId && !!it.regAttrs.stepKey, JSON.stringify(it.regAttrs).slice(0, 120));
    }
    // 行内条间距 6px（两条目 top - bottom）
    if (row.items.length >= 2) {
      const gap1 = row.items[1].itRect.top - row.items[0].itRect.bottom;
      T(`[${w}] ${row.name} 条间距 6px`, Math.abs(gap1 - 6) < 0.6, gap1);
    }
    T(`[${w}] ${row.name} 行高 ∈ [80,128]`, row.rowRect.height >= 79.4 && row.rowRect.height <= 128.4, row.rowRect.height);
    T(`[${w}] ${row.name} data-regs 登记投影完整`, row.regsAttr.length === exp.length && row.regsAttr.every((p, i) => p.bytes === (expect[pk].find((x) => x.id === p.id) || {}).bytes), JSON.stringify(row.regsAttr.map((p) => p.id + ':' + p.bytes + 'B:' + (p.ver || '').slice(4, 10))));
  }
}
T('不可核验色 #E5B95E（规则级探针：临时行量完即删）', m1440.unverProbe.color === 'rgb(229, 185, 94)', JSON.stringify(m1440.unverProbe));

// —— 回归：R11 app.css 行仍走原汇总行（无 lf-vrow），全库其余行不受影响 ——
const reg = await evalJs(`(() => {
  const r11 = [...document.querySelectorAll('.library-file')].find((r) => (r.getAttribute('data-open-file') || '').endsWith('web/app.css'));
  const others = [...document.querySelectorAll('.library-file')].filter((r) => !r.closest('[data-group="TEST-F01R10"]') && !(r.getAttribute('data-open-file') || '').endsWith('web/app.css'));
  return {
    r11: r11 ? { cls: r11.className, vrow: r11.querySelectorAll('.lf-vrow').length, lines: r11.querySelector('.lf-lines')?.textContent.slice(0, 60) } : null,
    othersVrow: others.reduce((n, r) => n + r.querySelectorAll('.lf-vrow').length, 0),
    othersCount: others.length,
    topCount: (document.getElementById('file-count')?.textContent || '').trim(),
  };
})()`);
T('回归：R11 app.css 行无新布局（仍汇总行）', reg.r11 && reg.r11.vrow === 0, JSON.stringify(reg.r11));
T('回归：其余 12 主行 0 条新布局行', reg.othersVrow === 0, `others=${reg.othersCount} vrow=${reg.othersVrow}`);
T('回归：顶部总量 14/17 口径不变', /14 \/ 14 个产物（17 条登记）/.test(reg.topCount), reg.topCount);

// —— 点击：点哪条登记行看哪条（300B 历史 / 124B 当前 / 133B）——
async function clickProbe(rowIdx, itemIdx, mustContain) {
  await evalJs(`(() => {
    const g = document.querySelector('details.filegroup[data-group="TEST-F01R10"]');
    const it = g.querySelectorAll('.library-file')[${rowIdx}].querySelectorAll('.lf-vrow')[${itemIdx}];
    it.querySelector('.lf-vl1').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 500));
  const txt = await evalJs(`(document.querySelector('#fv-detail')?.textContent || document.querySelector('#step-files')?.textContent || '').replace(/\\s+/g, ' ')`);
  T(`点击身份：主行${rowIdx}·条${itemIdx} 登记面板含「${mustContain}」`, txt.includes(mustContain), txt.slice(0, 220));
  await evalJs(`document.getElementById('step-files')?.close(); null`);
}
const verRow = m1440.rows.findIndex((r) => r.name === 'fixture-ver.md');
const timeRow = m1440.rows.findIndex((r) => r.name === 'fixture-time.md');
await clickProbe(verRow, m1440.rows[verRow].items.findIndex((i) => i.l1Text.includes('300B')), '300 B');
await clickProbe(verRow, m1440.rows[verRow].items.findIndex((i) => i.l1Text.includes('124B')), '124 B');
await clickProbe(timeRow, 0, '133 B');

// —— 截图 ——
await evalJs(`document.querySelector('details.filegroup[data-group="TEST-F01R10"]').scrollIntoView({block:'start'})`);
await new Promise((r) => setTimeout(r, 300));
await screenshot(OUT + 'f01r13-1440-f01.png');
await setViewport(1280); await new Promise((r) => setTimeout(r, 350));
await evalJs(`document.querySelector('details.filegroup[data-group="TEST-F01R10"]').scrollIntoView({block:'start'})`);
await new Promise((r) => setTimeout(r, 300));
await screenshot(OUT + 'f01r13-1280-f01.png');

T('页面 JS 异常 = 0', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | ') || 0);

const pass = results.filter((r) => r.pass).length;
writeFileSync(OUT + 'results.json', JSON.stringify({ pass, total: results.length, results, m1440, m1280 }, null, 1));
console.log(`\n===== ${pass}/${results.length} PASS =====`);
process.exit(0);
