// g02-files.test.js — G02 回归：文件视图来源语义（files.js）
// fileSourceSemantics 是文件页「执行者/来源类型」拆分的唯一口径：
// 归档迁移是导入行为不是角色；其它值原样透传，不在这层猜未登记的语义。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadOffice } from '../test-support/g02-vm.mjs';

const ctx = loadOffice(['shared.js', 'version.js', 'approval.js', 'files.js']);
const sem = (by) => ctx.run(`fileSourceSemantics(${JSON.stringify(by)})`);

test('fileSourceSemantics：五分支口径', () => {
  assert.deepEqual(sem(''), { executor: '—', sourceType: null, executorKnown: false }, '空执行者：占位 — 且不算已知');
  assert.deepEqual(sem(null), { executor: '—', sourceType: null, executorKnown: false });
  assert.deepEqual(sem('归档迁移'), { executor: '—', sourceType: '历史归档', executorKnown: false }, '归档迁移是导入行为，不是角色');
  assert.deepEqual(sem('hermes'), { executor: 'Hermes', sourceType: 'Agent生成', executorKnown: true });
  assert.deepEqual(sem('HERMES'), { executor: 'Hermes', sourceType: 'Agent生成', executorKnown: true }, '大小写不敏感');
  assert.deepEqual(sem('Leo（工作台）'), { executor: 'Leo（工作台）', sourceType: '人工创建', executorKnown: true }, 'Leo 前缀 → 人工创建');
  assert.deepEqual(sem('Cortana'), { executor: 'Cortana', sourceType: null, executorKnown: true }, '其它值原样透传，不猜来源类型');
});
