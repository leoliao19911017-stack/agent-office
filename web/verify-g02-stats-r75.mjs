// verify-g02-stats-r75.mjs — G02 第 75 轮静态统计（R75 口径，区别于旧轮 450 模块上限）。
//   A. 入口有效代码行：app.js ≤800；server.js ≤500（有效 = 非空非注释行，字符串/模板算代码）。
//   B. 全部模块总行/有效行：报告项（R75 未设模块单文件上限；旧轮 450 仅作对照参考，
//      files.js 491 行为 R71 既有状态、本轮未改动，如实报告不判失败）。
//   C. 函数长度：全部模块（含入口）。>120 行 = ❌ 必须拆分；101–120 = ⚠️ 目标 100 的偏差带；
//      ≤100 = ✅。报告全量最大值。
//   D. CSS 重复硬编码语义色：4 个 CSS 文件中，:root 之外与任一变量值相同的 hex/rgb() 字面量
//      目标归零（口径：组件规则一律 var() 引用，色值不散置）。
//   E. 防偷工指标：console.*/throw/try/catch 计数与测试套件在场清单（证明没有靠删日志、
//      错误处理或测试降行数）。
// 词法扫描器与 verify-g02-stats.mjs 同源（字符串/模板/${}/注释/正则感知），口径可对照。
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const rd = (f) => readFileSync(join(HERE, f), 'utf8');

const fail = (m) => { console.error('❌ ' + m); process.exit(1); };
const MAX_APP_EFF = 800;    // R75：app.js 入口有效代码 ≤800
const MAX_SRV_EFF = 500;    // R75：server.js 入口有效代码 ≤500
const FN_TARGET = 100;      // R75：单个函数目标 ≤100
const FN_HARD = 120;        // R75：超过 120 必须检查并拆分

// —— 词法感知扫描器（与 verify-g02-stats.mjs 逐字同源）——
function scanFunctions(rawSrc, maxDepth, file) {
  const src = rawSrc.replace(/\r\n/g, '\n');
  const N = src.length;
  const funcs = [];
  const frames = [];
  const subDepth = [];
  const modes = ['code'];
  let pending = null;
  let varDecl = null;
  let depth = 0, paren = 0, line = 1, i = 0;
  let prevSig = '';
  let prevWord = '';
  const REGEX_OK_BEFORE = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '<', '>', '+', '-', '*', '/', '%', '~', '^']);
  const KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case', 'do', 'else', 'yield', 'await']);
  const DECL_KW = new Set(['const', 'let', 'var']);
  const isIdStart = (c) => /[A-Za-z_$]/.test(c);
  const isId = (c) => /[A-Za-z0-9_$]/.test(c);
  const atTop = () => modes.length === 1 && modes[0] === 'code';

  while (i < N) {
    const c = src[i];

    if (modes[modes.length - 1] === 'tmpl') {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { modes.pop(); i++; continue; }
      if (c === '$' && src[i + 1] === '{') { modes.push('code'); depth++; subDepth.push(depth); i += 2; prevSig = '{'; prevWord = ''; continue; }
      if (c === '\n') line++;
      i++; continue;
    }

    if (c === '\n') { line++; i++; prevSig = ''; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < N && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < N && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; }
      i += 2; continue;
    }
    if (c === "'" || c === '"') {
      const q = c; i++;
      while (i < N && src[i] !== q) { if (src[i] === '\\') i++; if (src[i] === '\n') line++; i++; }
      i++; prevSig = q; prevWord = ''; continue;
    }
    if (c === '`') { modes.push('tmpl'); i++; prevSig = '`'; prevWord = ''; continue; }
    if (c === '/' && (REGEX_OK_BEFORE.has(prevSig) || KEYWORDS.has(prevWord))) {
      i++; let inCls = false;
      while (i < N) {
        const r = src[i];
        if (r === '\\') { i += 2; continue; }
        if (r === '\n') break;
        if (r === '[') inCls = true;
        else if (r === ']') inCls = false;
        else if (r === '/' && !inCls) break;
        i++;
      }
      i++; while (i < N && isId(src[i])) i++;
      prevSig = '/'; prevWord = ''; continue;
    }
    if (isIdStart(c)) {
      let w = c; i++;
      while (i < N && isId(src[i])) { w += src[i]; i++; }
      if (w === 'function' && atTop() && depth <= maxDepth && paren === 0) {
        pending = { name: null, startLine: line }; varDecl = null;
      } else if (pending && pending.name === null && w !== 'function') {
        pending.name = w;
      } else if (DECL_KW.has(w) && atTop() && depth === 0 && paren === 0 && !pending) {
        varDecl = { stage: 'kw' };
      } else if (varDecl && varDecl.stage === 'kw') {
        varDecl = { stage: 'name', name: w, startLine: line };
      } else if (varDecl && varDecl.stage === 'name') {
        varDecl = null;
      }
      prevSig = 'w'; prevWord = w; continue;
    }
    if (c === '(') { paren++; prevSig = '('; prevWord = ''; i++; continue; }
    if (c === ')') { paren--; prevSig = ')'; prevWord = ''; i++; continue; }
    if (c === '=' && src[i + 1] === '>') {
      if (varDecl && varDecl.stage === 'eq') varDecl.stage = 'arrow';
      i += 2; prevSig = 'w'; prevWord = ''; continue;
    }
    if (c === '=') {
      if (varDecl && varDecl.stage === 'name' && atTop() && paren === 0) varDecl.stage = 'eq';
      prevSig = '='; prevWord = ''; i++; continue;
    }
    if (c === '{') {
      depth++;
      if (pending && pending.name && paren === 0 && atTop()) { frames.push({ ...pending, funcDepth: depth }); pending = null; }
      else if (varDecl && varDecl.stage === 'arrow' && paren === 0 && atTop()) { frames.push({ name: varDecl.name, startLine: varDecl.startLine, funcDepth: depth }); varDecl = null; }
      else if (varDecl && varDecl.stage !== 'arrow') varDecl = null;
      prevSig = '{'; prevWord = ''; i++; continue;
    }
    if (c === '}') {
      const fr = frames[frames.length - 1];
      if (fr && fr.funcDepth === depth) {
        funcs.push({ name: fr.name, startLine: fr.startLine, endLine: line, lines: line - fr.startLine + 1 });
        frames.pop();
      } else if (subDepth.length && subDepth[subDepth.length - 1] === depth) {
        subDepth.pop(); modes.pop();
      }
      depth--;
      prevSig = '}'; prevWord = ''; i++; continue;
    }
    if (c === ';' && atTop() && depth === 0 && paren === 0) {
      if (pending) pending = null;
      if (varDecl) {
        if (varDecl.stage === 'arrow') funcs.push({ name: varDecl.name, startLine: varDecl.startLine, endLine: line, lines: line - varDecl.startLine + 1 });
        varDecl = null;
      }
      prevSig = ';'; prevWord = ''; i++; continue;
    }
    prevSig = c; prevWord = ''; i++;
  }
  if (frames.length || pending || varDecl || modes.length !== 1 || depth !== 0)
    fail(`${file} 扫描结束状态不干净（括号不平或扫描器漏形态）`);
  return funcs;
}

// —— 有效行计数：注释替换为空格（保换行），非空白即有效。字符串/模板/正则算代码。
//    词法口径与 scanFunctions 同源：模板 ${} 压栈弹栈、正则字面量按上文判定跳过。 ——
function effectiveLines(rawSrc, file) {
  const src = rawSrc.replace(/\r\n/g, '\n');
  const N = src.length;
  const modes = ['code'];
  const subDepth = [];
  const REGEX_OK_BEFORE = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '<', '>', '+', '-', '*', '/', '%', '~', '^']);
  const KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case', 'do', 'else', 'yield', 'await']);
  let out = '';
  let depth = 0, i = 0;
  let prevSig = '';
  let prevWord = '';
  const isIdStart = (c) => /[A-Za-z_$]/.test(c);
  const isId = (c) => /[A-Za-z0-9_$]/.test(c);
  while (i < N) {
    const c = src[i];
    if (modes[modes.length - 1] === 'tmpl') {
      if (c === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
      if (c === '`') { modes.pop(); out += c; i++; prevSig = '`'; prevWord = ''; continue; }
      if (c === '$' && src[i + 1] === '{') { modes.push('code'); depth++; subDepth.push(depth); out += '${'; i += 2; prevSig = '{'; prevWord = ''; continue; }
      out += c; i++; continue;
    }
    if (c === '/' && src[i + 1] === '/') { while (i < N && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < N && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i++; }
      i += 2; continue;
    }
    if (c === "'" || c === '"') {
      const q = c; out += c; i++;
      while (i < N && src[i] !== q) { if (src[i] === '\\') { out += src.slice(i, i + 2); i += 2; continue; } if (src[i] === '\n') out += '\n'; out += src[i]; i++; }
      out += q; i++; prevSig = q; prevWord = ''; continue;
    }
    if (c === '`') { modes.push('tmpl'); out += c; i++; prevSig = '`'; prevWord = ''; continue; }
    if (c === '/' && (REGEX_OK_BEFORE.has(prevSig) || KEYWORDS.has(prevWord))) {
      out += c; i++;
      let inCls = false;
      while (i < N) {
        const r = src[i];
        if (r === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
        if (r === '\n') break;
        if (r === '[') inCls = true;
        else if (r === ']') inCls = false;
        else if (r === '/' && !inCls) break;
        out += r; i++;
      }
      out += src[i] || ''; i++;
      while (i < N && isId(src[i])) { out += src[i]; i++; }
      prevSig = '/'; prevWord = ''; continue;
    }
    if (isIdStart(c)) {
      let w = c; out += c; i++;
      while (i < N && isId(src[i])) { w += src[i]; out += src[i]; i++; }
      prevSig = 'w'; prevWord = w; continue;
    }
    if (c === '{') { depth++; out += c; i++; prevSig = '{'; prevWord = ''; continue; }
    if (c === '}') {
      if (subDepth.length && subDepth[subDepth.length - 1] === depth) { subDepth.pop(); modes.pop(); out += c; i++; depth--; prevSig = '}'; prevWord = ''; continue; }
      depth--; out += c; i++; prevSig = '}'; prevWord = ''; continue;
    }
    out += c; i++;
    if (c !== ' ' && c !== '\t' && c !== '\r') { prevSig = c; prevWord = ''; }
  }
  if (modes.length !== 1 || depth !== 0) fail(`${file} 有效行扫描结束状态不干净 modes=${modes.length} depth=${depth}`);
  const lines = out.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();   // 末尾换行不计数（对齐老口径）
  return { total: lines.length, effective: lines.filter((l) => /\S/.test(l)).length };
}

// ============ A+B. 行数统计 ============
console.log('== A. 入口有效代码行（R75：app.js ≤800 / server.js ≤500）==');
const BROWSER = ['offline-snapshot.js', 'shared.js', 'version.js', 'approval.js', 'decision-ops.js',
  'files.js', 'preview.js', 'agents.js', 'render.js'];
const SERVER_MOD = ['server-core.mjs', 'server-api.mjs'];
const FILES = {
  'app.js': rd('app.js'), 'server.js': rd('server.js'),
  ...Object.fromEntries([...BROWSER, ...SERVER_MOD].map((f) => [f, rd(f)])),
};
const stats = {};
for (const [f, src] of Object.entries(FILES)) stats[f] = effectiveLines(src, f);

{
  const a = stats['app.js'], s = stats['server.js'];
  console.log(`app.js    有效 ${a.effective} / 总 ${a.total} 行 / 上限 ${MAX_APP_EFF} ${a.effective <= MAX_APP_EFF ? '✅' : '❌'}`);
  console.log(`server.js 有效 ${s.effective} / 总 ${s.total} 行 / 上限 ${MAX_SRV_EFF} ${s.effective <= MAX_SRV_EFF ? '✅' : '❌'}`);
  if (a.effective > MAX_APP_EFF) fail(`app.js 有效 ${a.effective} > ${MAX_APP_EFF}`);
  if (s.effective > MAX_SRV_EFF) fail(`server.js 有效 ${s.effective} > ${MAX_SRV_EFF}`);
}

console.log('\n== B. 全部模块 行数（总 / 有效；R75 无模块单文件上限，450 为旧轮对照）==');
for (const f of [...BROWSER, ...SERVER_MOD]) {
  const st = stats[f];
  const legacy = st.total > 450 ? `（旧轮 450 对照：超 ${st.total - 450}，R71 既有状态本轮未改）` : '';
  console.log(`${f.padEnd(20)} ${String(st.total).padStart(4)} / ${String(st.effective).padStart(4)}${legacy}`);
}
const modEffSum = [...BROWSER, ...SERVER_MOD].reduce((n, f) => n + stats[f].effective, 0);
console.log(`模块有效合计 ${modEffSum}（入口 app.js ${stats['app.js'].effective} + server.js ${stats['server.js'].effective} 之外）`);

// ============ C. 函数长度 ============
console.log(`\n== C. 函数长度（目标 ≤${FN_TARGET}，>${FN_HARD} 必须拆分；浏览器模块 maxDepth=0，服务端工厂 =1）==`);
const rows = [];
for (const f of [...Object.keys(FILES)]) {
  const maxDepth = f.startsWith('server') ? 1 : 0;
  const fns = scanFunctions(FILES[f], maxDepth, f);
  if (!fns.length && stats[f].total > 10) fail(`${f} 一个函数都没扫到，扫描器有问题`);   // ≤10 行的存根文件可无函数
  fns.sort((a, b) => a.startLine - b.startLine);
  for (const fn of fns) rows.push({ file: f, ...fn });
}
const overs = rows.filter((r) => r.lines > FN_TARGET);
if (overs.length) {
  for (const r of overs) console.log(`${r.lines > FN_HARD ? '❌' : '⚠️'} ${r.file}:${r.startLine} ${r.name || '(anon)'} ${r.lines} 行 (${r.startLine}-${r.endLine})`);
} else console.log(`全部 ${rows.length} 个函数 ≤${FN_TARGET} 行 ✅`);
const maxFn = rows.reduce((m, r) => (r.lines > m.lines ? r : m), rows[0]);
console.log(`函数总数 ${rows.length}；最大 ${maxFn.file}:${maxFn.name || '(anon)'} = ${maxFn.lines} 行`);
const hard = rows.filter((r) => r.lines > FN_HARD);
if (hard.length) fail(`超 ${FN_HARD} 行必须拆分的函数：${hard.map((r) => `${r.file}:${r.name}=${r.lines}`).join(', ')}`);

// ============ D. CSS 重复硬编码语义色 ============
console.log('\n== D. CSS 重复硬编码语义色（:root 之外命中变量值的字面量，目标 0）==');
const CSS = ['app-base.css', 'app-workbench.css', 'app-pages.css', 'app-layers.css'];
const hexNorm = (h) => {
  h = h.replace('#', '').toUpperCase();
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  return '#' + h;
};
const hexToRgb = (h) => { const n = hexNorm(h).slice(1); return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16)); };

let varCount = 0;
const varByValue = new Map();   // '#RRGGBB' → [varNames]
const cssNoComment = {};        // 去 /* */ 注释后的源码（保换行）
for (const f of CSS) {
  const raw = rd(f).replace(/\r\n/g, '\n');
  let out = '', i = 0;
  while (i < raw.length) {
    if (raw[i] === '/' && raw[i + 1] === '*') { i += 2; while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) { if (raw[i] === '\n') out += '\n'; i++; } i += 2; continue; }
    out += raw[i]; i++;
  }
  cssNoComment[f] = out;
  // 收集 :root 块内的变量色值（多 :root 合并；变量可能分散定义）
  let m;
  const rootRe = /:root[^{]*\{/g;
  while ((m = rootRe.exec(out))) {
    let d = 1, j = m.index + m[0].length;
    while (j < out.length && d > 0) { if (out[j] === '{') d++; else if (out[j] === '}') d--; j++; }
    const body = out.slice(m.index, j);
    for (const dm of body.matchAll(/--[\w-]+\s*:\s*([^;}{]+);/g)) {
      const val = dm[1].trim();
      const hex = val.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/) || val.match(/^#([0-9a-fA-F]{6})[0-9a-fA-F]{2}$/);
      if (!hex) continue;
      varCount++;
      const k = hexNorm(hex[1]);
      varByValue.set(k, [...(varByValue.get(k) || []), dm[0].split(':')[0].trim()]);
    }
  }
}
console.log(`变量定义色值 ${varCount} 个 / 去重 ${varByValue.size} 种`);

// :root 区域偏移表（扫描字面量时排除）
const dup = [];
let literalTotal = 0;
for (const f of CSS) {
  const out = cssNoComment[f];
  const rootSpans = [...out.matchAll(/:root[^{]*\{/g)].map((m) => {
    let d = 1, j = m.index + m[0].length;
    while (j < out.length && d > 0) { if (out[j] === '{') d++; else if (out[j] === '}') d--; j++; }
    return [m.index, j];
  });
  const inRoot = (idx) => rootSpans.some(([a, b]) => idx >= a && idx < b);
  const lineOf = (idx) => out.slice(0, idx).split('\n').length;
  for (const m of out.matchAll(/(?<=[:\s,(])#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})(?=[\s;,)!}])/g)) {
    if (inRoot(m.index)) continue;
    literalTotal++;
    const k = hexNorm(m[0]);
    if (varByValue.has(k)) dup.push({ file: f, line: lineOf(m.index), lit: m[0], k, vars: varByValue.get(k).join('/') });
  }
  for (const m of out.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)[^)]*\)/g)) {
    if (inRoot(m.index)) continue;
    literalTotal++;
    const rgb = m.slice(1, 4).map(Number);
    for (const [k] of varByValue) {
      const v = hexToRgb(k);
      if (v[0] === rgb[0] && v[1] === rgb[1] && v[2] === rgb[2]) { dup.push({ file: f, line: lineOf(m.index), lit: m[0], k, vars: varByValue.get(k).join('/') }); break; }
    }
  }
}
if (dup.length) {
  for (const d of dup) console.log(`❌ ${d.file}:${d.line} 硬编码 ${d.lit} = 变量 ${d.vars}（应 var() 引用）`);
  fail(`重复硬编码语义颜色 ${dup.length} 处（目标归零）`);
}
console.log(`:root 外颜色字面量共 ${literalTotal} 处，命中变量值 0 处 ✅`);

// ============ E. 防偷工指标 ============
console.log('\n== E. 防偷工指标（不得删注释/日志/错误处理/测试降行数——在场计数）==');
for (const f of Object.keys(FILES)) {
  const s = FILES[f];
  const n = (re) => (s.match(re) || []).length;
  console.log(`${f.padEnd(20)} 注释行 ${stats[f].total - stats[f].effective}  console.* ${n(/console\.\w+\(/g)}  throw ${n(/\bthrow\b/g)}  try ${n(/\btry\s*\{/g)}  catch ${n(/\bcatch\b/g)}`);
}
const testDir = join(HERE, '..', 'test');
const suites = readdirSync(testDir).filter((f) => f.endsWith('.test.js'));
console.log(`测试套件在场 ${suites.length} 个：${suites.join(', ')}`);

console.log(`\n✅ G02-R75 静态统计通过：app.js 有效 ${stats['app.js'].effective}≤${MAX_APP_EFF}，server.js 有效 ${stats['server.js'].effective}≤${MAX_SRV_EFF}，${rows.length} 函数最大 ${maxFn.lines} 行 ≤${FN_HARD}，重复语义色 0`);
