// H6：证明交接包真的能让一个新 Agent 接手——只用 h6-answer.md 对照 h1 交接包做断言。
// 回答由独立 subagent（handoff-h6）生成，输入只有 h6-prompt.md。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT = resolve('docs/evidence/handoff');
const answerPath = resolve(OUT, 'h6-answer.md');
const h1Path = resolve(OUT, 'h1-handoff.json');
if (!existsSync(answerPath) || !existsSync(h1Path)) {
  console.error('缺少 h6-answer.md 或 h1-handoff.json');
  process.exit(1);
}
const answer = readFileSync(answerPath, 'utf8');
const h1 = JSON.parse(readFileSync(h1Path, 'utf8'));
const checks = [
  ['答出任务已完成', /已完成|验收通过/.test(answer), '需要明确说任务已经完成/验收通过'],
  ['答出验收项 Q1-Q6', /Q1-Q6/.test(answer), '需要提到 Q1-Q6 验收'],
  ['答出代码版本/检查点', new RegExp(String(h1.workspace.head_commit || '').slice(0, 7)).test(answer) || /检查点/.test(answer), '需要提到 HEAD 或检查点'],
  ['答出下一步（无需继续/返工条件）', /不需要再执行|返工/.test(answer), '需要说明下一步或返工条件'],
  ['答出已知死路或未决问题', /死路|未决问题|看不到/.test(answer), '需要回答第 3 个问题'],
  ['没有把 JSON 原文当回答', !/^\s*\{/.test(answer), '不能是 JSON dump'],
];
const rows = checks.map(([name, ok, why]) => ({ name, ok, why: ok ? '' : why }));
const pass = rows.every((r) => r.ok);
writeFileSync(resolve(OUT, 'h6-check.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  agent: 'handoff-h6 (independent subagent)',
  input: 'docs/evidence/handoff/h6-prompt.md',
  answer: 'docs/evidence/handoff/h6-answer.md',
  handoff_id: h1.handoff_id,
  checks: rows,
  pass,
}, null, 2));
for (const r of rows) console.log(`${r.ok ? 'PASS' : 'FAIL'}  H6  ${r.name}${r.ok ? '' : ` — ${r.why}`}`);
console.log(`\n${pass ? 'PASS' : 'FAIL'}：新 Agent 只读交接包能答出任务做到哪了、下一步和死路`);
process.exit(pass ? 0 : 1);
