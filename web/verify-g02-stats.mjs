// verify-g02-stats.mjs — G02 静态统计（任务要求①，预算对齐任务原文）
//   A. 入口文件行数：app.js ≤1500（任务原文「入口文件目标不超过 1500 行」）。
//      server.js 行数仅报告（任务未给 server 入口单独上限，其函数同样受 B 约束）。
//   B. 拆分出的业务模块单文件 ≤450 行（任务原文）：shared/version/approval/files +
//      G02 新增模块（decision-ops/preview/agents，存在即检）+ server-core.mjs。
//   C. 函数长度：上述全部文件（含 app.js）的顶层 function/箭头 ≤100 行（任务原文
//      「单个函数原则上不超过 100 行」）。
//   词法感知扫描：单双引号串/模板串/${} 嵌套/行注释/块注释/正则字面量里的
//   大括号一律不参与配对；带体箭头按配对大括号收尾，表达式体箭头按顶层分号收尾。
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';

const fail = (m) => { console.error('❌ ' + m); process.exit(1); };
const MAX_FN = 100;
const MAX_ENTRY = 1500;   // app.js
const MAX_MODULE = 450;   // 拆分出的业务模块

// —— 词法感知扫描器：mode 栈 = ['code'] 起步，模板串/代入块显式压栈弹出 ——
function scanFunctions(rawSrc, maxDepth, file) {
  const src = rawSrc.replace(/\r\n/g, '\n');
  const N = src.length;
  const funcs = [];
  const frames = [];        // 函数帧 {name, startLine, funcDepth}
  const subDepth = [];      // 模板串 ${ 代入块入栈时刻的大括号深度
  const modes = ['code'];   // 'code' | 'tmpl'
  let pending = null;       // 已见 function 关键字，等函数体大括号
  let varDecl = null;       // const/let/var 箭头：kw → name → eq(见=) → arrow(见=>)
  let depth = 0, paren = 0, line = 1, i = 0;
  let prevSig = '';         // 上一个代码态有效字符（判断 / 是正则还是除号）
  let prevWord = '';
  const REGEX_OK_BEFORE = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '<', '>', '+', '-', '*', '/', '%', '~', '^']);
  const KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case', 'do', 'else', 'yield', 'await']);
  const DECL_KW = new Set(['const', 'let', 'var']);
  const isIdStart = (c) => /[A-Za-z_$]/.test(c);
  const isId = (c) => /[A-Za-z0-9_$]/.test(c);
  const atTop = () => modes.length === 1 && modes[0] === 'code';

  while (i < N) {
    const c = src[i];

    if (modes[modes.length - 1] === 'tmpl') {          // —— 模板串文本态：只有三件事有意义 ——
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { modes.pop(); i++; continue; }
      if (c === '$' && src[i + 1] === '{') { modes.push('code'); depth++; subDepth.push(depth); i += 2; prevSig = '{'; prevWord = ''; continue; }
      if (c === '\n') line++;
      i++; continue;
    }

    // —— 代码态 ——
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
      i++; let inCls = false;                          // 正则字面量：字符类内的 / 不结尾
      while (i < N) {
        const r = src[i];
        if (r === '\\') { i += 2; continue; }
        if (r === '\n') break;                         // 见到换行即认定不是正则（防御）
        if (r === '[') inCls = true;
        else if (r === ']') inCls = false;
        else if (r === '/' && !inCls) break;
        i++;
      }
      i++; while (i < N && isId(src[i])) i++;          // flags
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
        // 箭头 const 只认文件顶层语句（maxDepth 只放行工厂体内的 function 声明；
        // 函数体内的 const 表达式常含 lambda =>，放行depth会产生大量误报）
        varDecl = { stage: 'kw' };
      } else if (varDecl && varDecl.stage === 'kw') {
        varDecl = { stage: 'name', name: w, startLine: line };
      } else if (varDecl && varDecl.stage === 'name') {
        varDecl = null;                                // const 后连着两个词：不是箭头声明
      }                                                 // eq/arrow 阶段遇到的词是参数/表达式，保留状态
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
      else if (varDecl && varDecl.stage !== 'arrow') varDecl = null;   // 对象字面量：不是箭头函数
      prevSig = '{'; prevWord = ''; i++; continue;
    }
    if (c === '}') {
      const fr = frames[frames.length - 1];
      if (fr && fr.funcDepth === depth) {              // 函数体收尾
        funcs.push({ name: fr.name, startLine: fr.startLine, endLine: line, lines: line - fr.startLine + 1 });
        frames.pop();
      } else if (subDepth.length && subDepth[subDepth.length - 1] === depth) {  // ${ 代入块收尾
        subDepth.pop(); modes.pop();                    // 回到模板串文本态
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
    fail(`${file} 扫描结束状态不干净 frames=${JSON.stringify(frames)} pending=${JSON.stringify(pending)} varDecl=${JSON.stringify(varDecl)} modes=${modes.length} depth=${depth}（括号不平或扫描器漏形态）`);
  return funcs;
}

// —— A. 入口文件行数 ——
const lineCount = (f) => { const t = readFileSync(f, 'utf8'); return t.split('\n').length - (t.endsWith('\n') ? 1 : 0); };
console.log('== A. 入口文件行数 ==');
{
  const n = lineCount('app.js');
  console.log(`app.js: ${n} 行 / 上限 ${MAX_ENTRY} ${n <= MAX_ENTRY ? '✅' : '❌'}`);
  if (n > MAX_ENTRY) fail(`app.js ${n} 行 > 上限 ${MAX_ENTRY}`);
  console.log(`server.js: ${lineCount('server.js')} 行（报告项，任务未设 server 入口上限）`);
}

// —— B. 业务模块单文件行数 ——
console.log('\n== B. 业务模块行数（≤450） ==');
const NEW_MODULES = ['decision-ops.js', 'preview.js', 'agents.js']; // G02 拆分新增（存在即检）
const MODULES = [['shared.js', 0], ['version.js', 0], ['approval.js', 0], ['files.js', 0],
  ...NEW_MODULES.filter(existsSync).map((f) => [f, 0]), ['server-core.mjs', 1]];
for (const [f] of MODULES) {
  const n = lineCount(f);
  console.log(`${f}: ${n} 行 / 上限 ${MAX_MODULE} ${n <= MAX_MODULE ? '✅' : '❌'}`);
  if (n > MAX_MODULE) fail(`${f} ${n} 行 > 上限 ${MAX_MODULE}`);
}

// —— C. 函数长度扫描（含 app.js） ——
console.log('\n== C. 函数长度（全部 ≤100 行） ==');
const rows = [];
for (const [f, maxDepth] of [['app.js', 0], ...MODULES]) {
  const fns = scanFunctions(readFileSync(f, 'utf8'), maxDepth, f);
  if (!fns.length) fail(`${f} 一个函数都没扫到，扫描器有问题`);
  fns.sort((a, b) => a.startLine - b.startLine);
  for (const fn of fns) rows.push({ file: f, ...fn });
}
const pad = Math.max(...rows.map((r) => (r.file + ':' + r.startLine).length));
for (const r of rows) {
  const flag = r.lines > MAX_FN ? '❌' : '✅';
  console.log(`${flag} ${String(r.file + ':' + r.startLine).padEnd(pad + 2)} ${r.name.padEnd(28)} ${String(r.lines).padStart(3)} 行 (${r.startLine}-${r.endLine})`);
}
const over = rows.filter((r) => r.lines > MAX_FN);
if (over.length) fail(`超 ${MAX_FN} 行的函数：${over.map((r) => `${r.file}:${r.name}=${r.lines}`).join(', ')}`);
console.log(`\n✅ 静态统计通过：app.js ≤${MAX_ENTRY}，业务模块 ≤${MAX_MODULE}，${rows.length} 个函数全部 ≤${MAX_FN} 行`);
