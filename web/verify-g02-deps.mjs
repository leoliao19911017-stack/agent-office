// verify-g02-deps.mjs — G02 静态依赖检查（普通多 <script> 架构下的「导入导出检查」落地版）
// 前端文件没有 import/export（file:// 下 ES modules 不可用，全局共享），所以
// 「静态导入导出检查」在这里落地为三条可执行断言：
//   A. 顶层立即执行代码引用的名字，必须在此之前可见（同文件更早声明，或更早文件声明，
//      或浏览器内置）——违反即「加载顺序导致的未初始化引用」，正是循环依赖会炸的形态；
//   B. 顶层立即执行代码不得写其它文件的 let/const（跨模块顶层状态写）；
//   C. 输出调用期依赖图（函数体内引用 → 声明所在文件），标出环——调用期环在普通
//      script 下合法，但必须显式列出让评审看见，不允许藏着。
// 另附：每个文件的顶层立即执行语句清单（初始化时机的审计面——「谁在加载期就动手」）。
// 已知近似（本代码库风格下安全）：模板字符串插值内的引用不参与统计；对象方法简写
// （m(){} 形式）按 fn 体处理。用真实解析器属过度工程，此处偏差靠「未知全局」人工核对兜底。
// 用法：node web/verify-g02-deps.mjs [--json]
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(WEB, 'index.html'), 'utf8');
const ORDER = [...html.matchAll(/<script src="([^"]+)"[^>]*>\s*<\/script>/g)].map((m) => m[1].replace(/^\.\//, ''));

const BUILTINS = new Set(('document window location localStorage sessionStorage navigator fetch AbortSignal AbortController ' +
  'setTimeout setInterval clearTimeout clearInterval queueMicrotask requestAnimationFrame cancelAnimationFrame ' +
  'crypto TextEncoder TextDecoder console JSON Math Date Promise Map Set WeakMap WeakSet Object Array String Number Boolean RegExp Symbol BigInt ' +
  'Error TypeError RangeError SyntaxError URIError EvalError ReferenceError isNaN isFinite parseInt parseFloat ' +
  'encodeURIComponent decodeURIComponent btoa atob structuredClone alert confirm prompt undefined NaN Infinity globalThis performance ' +
  'Image ImageData URL URLSearchParams Request Response Headers FormData Blob FileReader ArrayBuffer Uint8Array Int8Array Uint16Array ' +
  'Int16Array Uint32Array Int32Array Float32Array Float64Array DataView WebSocket Worker SharedWorker CustomEvent Event EventTarget ' +
  'DOMParser XMLSerializer MutationObserver ResizeObserver IntersectionObserver getComputedStyle matchMedia scrollX scrollY ' +
  'innerWidth innerHeight outerWidth outerHeight devicePixelRatio screen history caches Notification ClipboardEvent').split(/\s+/));
const KEYWORDS = new Set(('function return if else for while do switch case default break continue let const var class extends new delete ' +
  'typeof instanceof in of void this super try catch finally throw async await yield static get set export import true false null').split(/\s+/));

/* ---------- 词法（两遍：先出 token，再建括号路径 + 参数区/箭头体标记） ---------- */
function lexFull(src) {
  // 第一遍：token 化（跳过注释/字符串/模板/regex）
  const raw = [];
  let i = 0, line = 1, lastSig = null;
  const emit = (type, value) => raw.push({ type, value, line, off: i });
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; } i += 2; continue; }
    if (c === "'" || c === '"') { const q = c; i++; while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; if (src[i] === '\n') line++; i++; } i++; lastSig = 'str'; continue; }
    if (c === '`') {
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '\n') { line++; i++; continue; }
        if (src[i] === '`') { i++; break; }
        if (src[i] === '$' && src[i + 1] === '{') {   // 插值按普通代码继续（含嵌套字符串）
          i += 2; let d = 1;
          while (i < src.length && d > 0) {
            const cc = src[i];
            if (cc === '\n') { line++; i++; continue; }
            if (cc === "'" || cc === '"') { const q2 = cc; i++; while (i < src.length && src[i] !== q2) { if (src[i] === '\\') i++; if (src[i] === '\n') line++; i++; } i++; continue; }
            if (cc === '{') d++;
            if (cc === '}') { d--; if (!d) { i++; break; } }
            i++;
          }
          continue;
        }
        i++;
      }
      lastSig = 'str'; continue;
    }
    if (c === '/') {
      // 除法只可能出现在 id/num/)/]/str/regex 之后；其余位置按 regex 处理
      const divBefore = ['id', 'num', 'str', 'regex', 'punct-)', 'punct-]'].includes(lastSig);
      if (!divBefore) {
        i++; let inCls = false;
        while (i < src.length) {
          if (src[i] === '\\') { i += 2; continue; }
          if (src[i] === '\n') break;
          if (src[i] === '[') inCls = true;
          else if (src[i] === ']') inCls = false;
          else if (src[i] === '/' && !inCls) { i++; break; }
          i++;
        }
        while (i < src.length && /[a-z]/i.test(src[i])) i++;
        lastSig = 'regex'; continue;
      }
      i++; lastSig = 'punct-/'; continue;
    }
    if (/[A-Za-z_$]/.test(c)) { let j = i; while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++; const v = src.slice(i, j); emit(KEYWORDS.has(v) ? 'kw' : 'id', v); i = j; lastSig = KEYWORDS.has(v) ? 'kw-' + v : 'id'; continue; }
    if (/[0-9]/.test(c)) { let j = i; while (j < src.length && /[0-9a-fxA-F._]/.test(src[j])) j++; emit('num', src.slice(i, j)); i = j; lastSig = 'num'; continue; }
    if (c === '=' && src[i + 1] === '>') { emit('punct', '=>'); i += 2; lastSig = 'punct-=>'; continue; }
    emit('punct', c); i++; lastSig = 'punct-' + c;
  }

  // 圆括号配对表
  const pair = new Map();
  { const st = []; for (let k = 0; k < raw.length; k++) { const t = raw[k]; if (t.type === 'punct' && t.value === '(') st.push(k); else if (t.type === 'punct' && t.value === ')') { const o = st.pop(); if (o != null) { pair.set(o, k); pair.set(k, o); } } } }
  // 每个 token 的括号深度（处理该 token 之前的深度）
  const depthBefore = new Array(raw.length).fill(0);
  { let d = 0; for (let k = 0; k < raw.length; k++) { depthBefore[k] = d; const t = raw[k]; if (t.type === 'punct' && '([{'.includes(t.value)) d++; else if (t.type === 'punct' && ')]}'.includes(t.value)) d = Math.max(0, d - 1); } }

  // 参数区（function 头 / 箭头参数）与箭头表达式体 → 都算调用期，不算加载期引用
  const paramRegion = new Set();
  const callTime = new Set();
  for (let k = 0; k < raw.length; k++) {
    const t = raw[k];
    if (t.type === 'kw' && t.value === 'function') {
      let j = k + 1;
      if (raw[j] && raw[j].type === 'id') j++;
      if (raw[j] && raw[j].type === 'punct' && raw[j].value === '(' && pair.has(j)) {
        const cl = pair.get(j);
        for (let q = j + 1; q < cl; q++) paramRegion.add(q);
      }
    }
    if (t.type === 'punct' && t.value === '(' && pair.has(k)) {
      const cl = pair.get(k);
      const after = raw[cl + 1];
      if (after && after.type === 'punct' && after.value === '=>') for (let q = k + 1; q < cl; q++) paramRegion.add(q);
    }
    if (t.type === 'id' && raw[k + 1] && raw[k + 1].type === 'punct' && raw[k + 1].value === '=>') paramRegion.add(k);
    if (t.type === 'punct' && t.value === '=>') {
      const dA = depthBefore[k];
      for (let q = k + 1; q < raw.length; q++) {
        const u = raw[q];
        if (u.type === 'punct' && ';,)]}'.includes(u.value) && depthBefore[q] <= dA) break;
        callTime.add(q);
      }
    }
  }

  // 第二遍：括号路径（fn=函数体/类体 block=立即执行块 obj=对象字面量）
  const stack = [{ kind: 'root' }];
  const out = [];
  const isFnBrace = (k) => {
    const prev = raw[k - 1];
    if (prev && prev.type === 'punct' && prev.value === '=>') return true;
    if (prev && prev.type === 'punct' && prev.value === ')' && pair.has(k - 1)) {
      const open = pair.get(k - 1);
      const before = raw[open - 1];
      if (before && before.type === 'kw' && before.value === 'function') return true; // 匿名 function(
      if (before && before.type === 'id') {
        const bb = raw[open - 2];
        if (bb && bb.type === 'kw' && bb.value === 'function') return true;          // 命名 function name(
        const top = stack[stack.length - 1];
        if (top.kind === 'obj' || top.kind === 'fn') return true;                     // 方法简写 m(p){}
      }
      return false;
    }
    // class [id] [extends id] {
    let j = k - 1;
    while (j >= 0 && raw[j].type === 'id') j--;
    if (j >= 0 && raw[j].type === 'kw' && raw[j].value === 'class') return true;
    if (j >= 0 && raw[j].type === 'kw' && raw[j].value === 'extends') {
      let m = j - 1;
      while (m >= 0 && raw[m].type === 'id') m--;
      if (m >= 0 && raw[m].type === 'kw' && raw[m].value === 'class') return true;
    }
    return false;
  };
  for (let k = 0; k < raw.length; k++) {
    const t = raw[k];
    let kind = null;
    if (t.type === 'punct' && t.value === '{') {
      kind = isFnBrace(k) ? 'fn' : (
        (() => {
          const prev = raw[k - 1];
          const top = stack[stack.length - 1];
          if (top.kind === 'fn' && !(prev && prev.type === 'punct' && prev.value === '=>')) {
            // fn 体内再遇 {：大概率是块/嵌套——由 isFnBrace 决定，这里只兜对象字面量
          }
          if (prev && ((prev.type === 'punct' && ['=', '(', ',', '[', ':', '?', '|', '&', '+', '!', '*', '%', '<', '>', '^', '~'].includes(prev.value)) || (prev.type === 'kw' && ['return', 'typeof', 'case', 'new'].includes(prev.value)))) return 'obj';
          return 'block';
        })()
      );
      stack.push({ kind });
      out.push({ ...t, idx: k, path: stack.map((s) => s.kind), param: paramRegion.has(k), ct: callTime.has(k) });
      continue;
    }
    if (t.type === 'punct' && t.value === '}') { if (stack.length > 1) stack.pop(); }
    else if (t.type === 'punct' && (t.value === '(' || t.value === '[')) stack.push({ kind: t.value === '(' ? 'paren' : 'bracket' });
    else if (t.type === 'punct' && (t.value === ')' || t.value === ']')) { const top = stack[stack.length - 1]; if (top && (top.kind === 'paren' || top.kind === 'bracket')) stack.pop(); }
    out.push({ ...t, idx: k, path: stack.map((s) => s.kind), param: paramRegion.has(k), ct: callTime.has(k) });
  }
  return out;
}

/* ---------- 分析 ---------- */
const files = ORDER.map((name) => {
  const src = readFileSync(join(WEB, name), 'utf8');
  const toks = lexFull(src);
  const decls = [];   // { name, kind, off, mutable }
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    // 真全局声明：括号路径必须恰好是 [root]（块/圆括号/对象内声明的都是局部）
    if (t.path.length !== 1) continue;
    if (t.type === 'kw' && (t.value === 'function' || t.value === 'class')) {
      const n = toks[k + 1];
      if (n && n.type === 'id') decls.push({ name: n.value, kind: t.value, off: n.off, mutable: false });
    }
    if (t.type === 'kw' && (t.value === 'let' || t.value === 'const' || t.value === 'var')) {
      // 只收集声明名：`=` 之后的初始化表达式里的标识符不是声明（const s = Number(sec) 不登记 Number）
      let j = k + 1, d = 0, expectName = true;
      while (j < toks.length) {
        const n = toks[j];
        if (d === 0 && n.type === 'punct' && n.value === ';') break;
        if (n.type === 'punct' && '([{'.includes(n.value)) { d++; j++; continue; }
        if (n.type === 'punct' && ')]}'.includes(n.value)) { if (d === 0) break; d--; j++; continue; }
        if (d === 0 && n.type === 'punct' && n.value === ',') { expectName = true; j++; continue; }
        if (d === 0 && expectName && n.type === 'id' && !KEYWORDS.has(n.value)) {
          decls.push({ name: n.value, kind: t.value, off: n.off, mutable: t.value !== 'const' });
          expectName = false;
        }
        j++;
      }
    }
  }
  // 引用：非属性名、非对象键、非参数区的标识符
  // 局部名（函数内 let/const、参数、catch 绑定）——不构成跨文件依赖，用于过滤未知全局噪音
  const localNames = new Set();
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.path.length === 1) continue; // 根级已在 decls
    if (t.type === 'kw' && (t.value === 'let' || t.value === 'const' || t.value === 'var' || t.value === 'function' || t.value === 'class')) {
      const n = toks[k + 1];
      if (n && n.type === 'id' && !KEYWORDS.has(n.value)) localNames.add(n.value);
    }
    if (t.type === 'id' && t.param) localNames.add(t.value);
    if (t.type === 'kw' && t.value === 'catch') { const n = toks[k + 2]; if (n && n.type === 'id') localNames.add(n.value); }
    if (t.type === 'id' && toks[k + 1] && toks[k + 1].type === 'punct' && toks[k + 1].value === '=>') localNames.add(t.value);
  }
  const uses = [];
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.type !== 'id' || t.param) continue;
    const prev = toks[k - 1];
    if (prev && prev.type === 'punct' && prev.value === '.') continue;          // 属性访问
    const next = toks[k + 1];
    if (t.path[t.path.length - 1] === 'obj' && next && next.type === 'punct' && next.value === ':') continue; // 对象键
    if (decls.some((d) => d.name === t.value && d.off === t.off)) continue;     // 声明名本身
    uses.push({ name: t.value, line: t.line, off: t.off, immediate: !t.path.some((p) => p === 'fn') && !t.ct });
  }
  return { name: name.replace(/^.*\//, ''), src, decls, uses, localNames };
});

const fileIdx = new Map(files.map((f, i) => [f.name, i]));
const declOwner = new Map();
for (const f of files) for (const d of f.decls) {
  if (!declOwner.has(d.name)) declOwner.set(d.name, []);
  declOwner.get(d.name).push({ file: f.name, off: d.off, mutable: d.mutable });
}

const violations = [];
const unknowns = new Set();
const immediateStmts = [];
for (let i = 0; i < files.length; i++) {
  const f = files[i];
  for (const u of f.uses) {
    if (!u.immediate) continue;
    const owners = declOwner.get(u.name) || [];
    if (!owners.length) { if (!BUILTINS.has(u.name) && !f.localNames.has(u.name)) unknowns.add(`${f.name}:${u.line} ${u.name}`); continue; }
    const ok = owners.some((o) => fileIdx.get(o.file) < i || (o.file === f.name && o.off < u.off));
    if (!ok) violations.push({ file: f.name, line: u.line, name: u.name, rule: 'A-前向引用', detail: `顶层立即执行引用了更晚声明的 ${u.name}（首声明于 ${owners[0].file}）` });
    const after = f.src.slice(u.off + u.name.length).match(/^\s*(=(?!=)|\+\+|--|\+=|-=)/);
    if (after && owners.some((o) => o.file !== f.name && o.mutable)) {
      violations.push({ file: f.name, line: u.line, name: u.name, rule: 'B-跨文件顶层写', detail: `顶层立即写 ${[...new Set(owners.filter((o) => o.mutable).map((o) => o.file))].join('/')} 的可变绑定` });
    }
  }
  const lines = [...new Set(f.uses.filter((u) => u.immediate).map((u) => u.line))].sort((a, b) => a - b);
  if (lines.length) immediateStmts.push({ file: f.name, lines });
}

// 调用期依赖图 + 环
const edges = new Map();
for (let i = 0; i < files.length; i++) {
  const f = files[i];
  for (const u of f.uses) {
    if (u.immediate) continue;
    for (const o of declOwner.get(u.name) || []) {
      if (o.file !== f.name) {
        if (!edges.has(f.name)) edges.set(f.name, new Set());
        edges.get(f.name).add(o.file);
      }
    }
  }
}
const cycles = [];
const seen = new Set();
for (const from of edges.keys()) {
  const st = [[from, [from]]];
  while (st.length) {
    const [n, path] = st.pop();
    for (const to of edges.get(n) || []) {
      if (to === from) { const c = [...path, to].join(' → '); if (!seen.has(c)) { seen.add(c); cycles.push(c); } continue; }
      if (path.includes(to) || path.length >= files.length) continue;
      st.push([to, [...path, to]]);
    }
  }
}

/* ---------- 输出 ---------- */
const asJson = process.argv.includes('--json');
const result = { order: ORDER, violations, unknowns: [...unknowns], immediateStmts, edges: [...edges].map(([f, t]) => `${f} → [${[...t].join(', ')}]`), cycles };
if (asJson) { console.log(JSON.stringify(result, null, 2)); }
else {
  console.log(`脚本加载顺序（index.html）：${ORDER.join(' → ')}`);
  console.log(`\n[A] 顶层前向引用（未初始化引用风险）：${violations.filter((v) => v.rule.startsWith('A')).length} 处`);
  for (const v of violations.filter((v) => v.rule.startsWith('A'))) console.log(`  ${v.file}:${v.line}  ${v.name}  ${v.detail}`);
  console.log(`\n[B] 跨文件顶层写：${violations.filter((v) => v.rule.startsWith('B')).length} 处`);
  for (const v of violations.filter((v) => v.rule.startsWith('B'))) console.log(`  ${v.file}:${v.line}  ${v.name}  ${v.detail}`);
  console.log(`\n[未知全局·人工核对]：${unknowns.size} 个`);
  for (const u of unknowns) console.log(`  ${u}`);
  console.log(`\n[顶层立即执行语句]（加载期就动手的行）：`);
  for (const s of immediateStmts) console.log(`  ${s.file}: 行 ${s.lines.join(',')}`);
  console.log(`\n[调用期依赖图]：`);
  for (const e of result.edges) console.log(`  ${e}`);
  console.log(`\n[调用期环]：${cycles.length} 个（普通 script 调用期环合法，此处显式列出供评审）`);
  for (const c of cycles) console.log(`  ${c}`);
}
const bad = violations.filter((v) => v.rule.startsWith('A') || v.rule.startsWith('B')).length;
if (!asJson) console.log(`\n结论：${bad === 0 ? 'PASS — 无顶层前向引用/跨文件顶层写' : `FAIL — ${bad} 处违规`}`);
process.exitCode = bad === 0 ? 0 : 1;
