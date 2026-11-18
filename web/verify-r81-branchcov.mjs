// verify-r81-branchcov.mjs — 第 81 轮 G01 分支覆盖率实测（NODE_V8_COVERAGE 口径）。
// 范围：审批/版本校验核心四模块 shared.js / version.js / approval.js / decision-ops.js
//（与 test/g02-branches.test.js 头部声明的 ≥90% 目标同口径）。
// 数据：NODE_V8_COVERAGE=web/tmp-cov-r81 下 `node --test`（238 用例）的 149 个
//       coverage-*.json。同一模块会被多个测试子进程各自装载一次（g02-vm 按
//       filename 装载，url=裸文件名），各进程只覆盖它测的那部分。
// 算法（跨进程求并集）：对每次装载，把「count=0 的子区间 + 从未被调用函数的
//       整体区间」标成未执行；同一模块所有装载的未执行掩码按位与——一段代码
//       只要在任一进程执行过就算覆盖。覆盖率 = 1 - 处处未执行字符数 / 脚本总字符数。
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const COV_DIR = join(HERE, 'tmp-cov-r81');
const TARGETS = ['shared.js', 'version.js', 'approval.js', 'decision-ops.js'];

const state = new Map(TARGETS.map((t) => [t, { masks: [], size: 0, loads: 0 }]));

for (const f of readdirSync(COV_DIR)) {
  if (!f.endsWith('.json')) continue;
  let doc; try { doc = JSON.parse(readFileSync(join(COV_DIR, f), 'utf8')); } catch { continue; }
  for (const cov of doc.result || []) {
    const url = cov.url || '';
    const name = TARGETS.find((t) => url === t || url.endsWith('/' + t) || url.endsWith('\\' + t));
    if (!name) continue;
    const st = state.get(name);
    st.loads++;
    let size = st.size;
    for (const fn of cov.functions || []) size = Math.max(size, ...fn.ranges.map((r) => r.endOffset));
    // 本次装载的「未执行」区间：root.count=0 的函数整体，或 root 覆盖下的 count=0 子区间
    const zeros = [];
    for (const fn of cov.functions || []) {
      const rs = fn.ranges || [];
      if (!rs.length) continue;
      if (rs[0].count === 0) zeros.push([rs[0].startOffset, rs[0].endOffset]);
      else for (const r of rs) if (r !== rs[0] && r.count === 0) zeros.push([r.startOffset, r.endOffset]);
    }
    const mask = new Uint8Array(size);
    for (const [s, e] of zeros) mask.fill(1, s, e);
    st.size = size; st.masks.push(mask);
  }
}

const report = { at: new Date().toISOString(), scope: 'web/{shared,version,approval,decision-ops}.js（g02-vm 装载，NODE_V8_COVERAGE 并集口径）', files: {} };
let ok = true;
for (const t of TARGETS) {
  const st = state.get(t);
  if (!st.size || !st.masks.length) { report.files[t] = { error: '无覆盖数据' }; ok = false; continue; }
  const all = new Uint8Array(st.size);   // 处处未执行掩码 = 各装载未执行掩码按位与
  for (let i = 0; i < st.size; i++) {
    let unc = 1;
    for (const m of st.masks) { if (!m[i]) { unc = 0; break; } }
    all[i] = unc;
  }
  let uncovChars = 0; for (const b of all) uncovChars += b;
  const pct = 100 * (1 - uncovChars / st.size);
  report.files[t] = { loads: st.loads, scriptChars: st.size, neverExecutedChars: uncovChars, blockCoveragePct: +pct.toFixed(1) };
  console.log(`${t.padEnd(16)} 装载 ${st.loads} 次 · 脚本 ${st.size} 字符 · 处处未执行 ${uncovChars} → 分支臂覆盖 ${pct.toFixed(1)}%`);
}
const agg = (names) => {
  const sz = names.map((t) => report.files[t].scriptChars || 0).reduce((a, b) => a + b, 0);
  const un = names.map((t) => report.files[t].neverExecutedChars || 0).reduce((a, b) => a + b, 0);
  return +(100 * (1 - un / sz)).toFixed(1);
};
// G01 的「审批/版本校验」主口径 = approval/version/decision-ops 三模块；
// shared 是工具层，单列一并给出（其中部分渲染工具只有浏览器进程执行，
// node 覆盖数据天然看不见——本口径数值是下界）。
report.approvalScopePct = agg(['approval.js', 'version.js', 'decision-ops.js']);
report.allFourPct = agg(TARGETS);
report.pass = ok && report.approvalScopePct >= 90 && report.allFourPct >= 90;
console.log(`审批/版本校验三模块（approval+version+decision-ops）：${report.approvalScopePct}%`);
console.log(`含工具层四模块合计（字符加权）：${report.allFourPct}%（≥90% ${report.pass ? '✅' : '❌'}）`);
writeFileSync(join(HERE, 'verify-assets', 'r81', 'branchcov.json'), JSON.stringify(report, null, 2));
console.log('结果落 verify-assets/r81/branchcov.json');
