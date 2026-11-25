// P0 第二步测试：自然语言解析 + 模板版本保留 + 删除保护。
// 运行：node --no-warnings --test test/workflow-templates.test.js
//
// 解析器是纯函数，直接喂文本断言；版本/删除真开 SQLite（内存库），不做 mock。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, closeDb } from '../web/lib/db.mjs';
import {
  deleteWorkflowTemplate,
  getWorkflowTemplate,
  getWorkflowTemplateVersion,
  insertWorkflowRun,
  insertWorkflowTemplate,
  listWorkflowTemplateVersions,
  updateWorkflowTemplate,
} from '../web/lib/workflow-db.mjs';
import { parseWorkflowText } from '../web/lib/workflow-parse.mjs';
import { CODING_V1_TEMPLATE_ID } from '../web/lib/workflow-schema.mjs';

// Leo 的原始口述（任务书指定测试文本）
const LEO_TEXT =
  '我先给需求，不清楚就问我，然后跟 GPT 确认，确认完拆成任务给 Claude 做，' +
  '做完我自己先测，再让 Codex 评审，不到 8 分继续改，最后我验收，然后复盘';

function makeTemplate(db, overrides = {}) {
  return insertWorkflowTemplate(db, {
    name: '测试模板',
    steps: [
      { id: '01', name: '需求', actor: 'user', outputs: ['requirement'], gate: 'user_done' },
      { id: '02', name: '开发', actor: 'claude', outputs: ['code_commit'], gate: 'tests_pass' },
    ],
    reworkRoutes: { code_bug: '02' },
    scoring: { correctness: 1 },
    autonomy: { must_ask: ['publish'] },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// 1. 自然语言解析：Leo 的真实口述
// ---------------------------------------------------------------------------
test('from-text：Leo 口述解析成九步，顺序与阶段正确', () => {
  const { draft, summary, missing } = parseWorkflowText(LEO_TEXT);

  assert.equal(draft.template_id.startsWith('nl-'), true);
  assert.equal(draft.version, 1);
  assert.equal(draft.steps.length, 9);
  assert.deepEqual(draft.steps.map((s) => s.id), ['01', '02', '03', '04', '05', '06', '07', '08', '09']);
  assert.deepEqual(draft.steps.map((s) => s.name), [
    '需求输入', '需求澄清', '需求讨论与确认', '开发计划与任务书', '开发执行',
    '自测', '独立验证与评审', '最终验收与交付', '归档与复盘',
  ]);

  // 每步字段齐全，steps 里不夹带解析器内部字段
  for (const step of draft.steps) {
    for (const key of ['id', 'name', 'actor', 'outputs', 'gate']) {
      assert.ok(step[key] !== undefined, `步骤 ${step.id} 缺 ${key}`);
    }
    assert.equal(Array.isArray(step.outputs) && step.outputs.length > 0, true);
    assert.equal(step.key, undefined, 'draft.steps 不应带内部 key');
    assert.equal(step.short, undefined, 'draft.steps 不应带内部 short');
  }
});

test('from-text：角色 / 目标分 / 判据 / 返工路由都按原文抽取', () => {
  const { draft } = parseWorkflowText(LEO_TEXT);
  const byName = Object.fromEntries(draft.steps.map((s) => [s.name, s]));

  // 「跟 GPT 确认」→ 你主确认、GPT 协作；「拆任务给 Claude 做」→ Claude 开发
  assert.equal(byName['需求讨论与确认'].actor, 'user');
  assert.deepEqual(byName['需求讨论与确认'].collaborators, ['gpt']);
  assert.equal(byName['开发执行'].actor, 'claude');
  // 「我自己先测」不硬写成 Claude
  assert.equal(byName['自测'].actor, 'user');
  assert.equal(byName['独立验证与评审'].actor, 'codex');
  assert.equal(byName['最终验收与交付'].actor, 'user');

  // 目标分 8；评审判据带分数；返工回到开发 05
  assert.equal(draft.target_score, 8);
  assert.match(byName['独立验证与评审'].gate, /score >= 8/);
  assert.equal(draft.rework_routes.review_below_target, '05');
});

test('from-text：summary 是给 Leo 看的中文，含步数与返工方向', () => {
  const { summary } = parseWorkflowText(LEO_TEXT);
  assert.equal(typeof summary, 'string');
  assert.match(summary, /我理解你要 9 步/);
  assert.match(summary, /需求→澄清→确认→计划→开发→自测→评审→验收→复盘/);
  assert.match(summary, /GPT/);
  assert.match(summary, /Claude 负责开发/);
  assert.match(summary, /Codex 评审/);
  assert.match(summary, /不到 8 分就回到「开发执行」继续改/);
  assert.match(summary, /对不对？/);
});

test('from-text：missing 如实列出没识别到的项，不瞎猜', () => {
  const { draft, missing } = parseWorkflowText(LEO_TEXT);
  assert.ok(Array.isArray(missing));
  // 原文没提权重和自主边界，必须列出来；九步全都识别到了，不应再报缺步骤
  assert.equal(missing.some((m) => m.includes('评分维度权重')), true);
  assert.equal(missing.some((m) => m.includes('自主决策边界')), true);
  assert.equal(missing.some((m) => m.includes('环节')), false);
  // 没提权重就不许编：scoring / autonomy 是空对象
  assert.deepEqual(draft.scoring, {});
  assert.deepEqual(draft.autonomy, {});
});

test('from-text：短描述只生成说到的步骤，缺的进 missing', () => {
  const { draft, summary, missing } = parseWorkflowText('Claude 开发，Codex 评审');
  assert.deepEqual(draft.steps.map((s) => s.name), ['开发执行', '独立验证与评审']);
  assert.equal(draft.target_score, null);
  assert.match(summary, /我理解你要 2 步/);
  assert.equal(missing.some((m) => m.includes('没识别到「需求」环节')), true);
  assert.equal(missing.some((m) => m.includes('没识别到目标分')), true);
});

test('from-text：空文本直接拒绝，不生成空模板', () => {
  assert.throws(() => parseWorkflowText('   '), /非空字符串/);
});

// ---------------------------------------------------------------------------
// 2. 版本保留
// ---------------------------------------------------------------------------
test('PUT 语义：版本 +1，旧版本仍可按 version 查回', () => {
  const db = openDb({ memory: true });
  try {
    const created = makeTemplate(db, { templateId: 'tpl-ver' });
    assert.equal(created.version, 1);

    const updated = updateWorkflowTemplate(db, 'tpl-ver', {
      name: '测试模板 v2',
      steps: [
        { id: '01', name: '需求', actor: 'user', outputs: ['requirement'], gate: 'user_done' },
        { id: '02', name: '开发', actor: 'codex', outputs: ['code_commit'], gate: 'tests_pass' },
        { id: '03', name: '验收', actor: 'user', outputs: ['acceptance_report'], gate: 'user_approval' },
      ],
    });
    assert.equal(updated.version, 2);
    assert.equal(updated.name, '测试模板 v2');
    assert.equal(JSON.parse(updated.steps).length, 3);

    // 当前 = v2；v1 从历史表查回，内容是被覆盖前的原样
    const v1 = getWorkflowTemplateVersion(db, 'tpl-ver', 1);
    assert.ok(v1);
    assert.equal(v1.version, 1);
    assert.equal(v1.name, '测试模板');
    assert.equal(JSON.parse(v1.steps).length, 2);
    assert.equal(JSON.parse(v1.rework_routes).code_bug, '02');

    // 历史版本只有 v1；再改一次，v2 也进历史
    assert.deepEqual(listWorkflowTemplateVersions(db, 'tpl-ver').map((v) => v.version), [1]);
    const v3 = updateWorkflowTemplate(db, 'tpl-ver', { name: '测试模板 v3' });
    assert.equal(v3.version, 3);
    assert.deepEqual(listWorkflowTemplateVersions(db, 'tpl-ver').map((v) => v.version), [1, 2]);
    assert.equal(getWorkflowTemplateVersion(db, 'tpl-ver', 2).name, '测试模板 v2');
    assert.equal(getWorkflowTemplateVersion(db, 'tpl-ver', 4), null);
  } finally {
    closeDb(db);
  }
});

test('PUT 局部更新：只改名字时 steps / 路由 / 权重原样保留', () => {
  const db = openDb({ memory: true });
  try {
    makeTemplate(db, { templateId: 'tpl-part' });
    const updated = updateWorkflowTemplate(db, 'tpl-part', { name: '只改名' });
    assert.equal(updated.version, 2);
    assert.equal(JSON.parse(updated.steps)[0].name, '需求');
    assert.equal(JSON.parse(updated.rework_routes).code_bug, '02');
    assert.equal(JSON.parse(updated.scoring).correctness, 1);
  } finally {
    closeDb(db);
  }
});

// ---------------------------------------------------------------------------
// 3. 删除保护
// ---------------------------------------------------------------------------
test('DELETE：有 run 在用就不删（返回 runCount），没有才真删', () => {
  const db = openDb({ memory: true });
  try {
    makeTemplate(db, { templateId: 'tpl-used' });
    insertWorkflowRun(db, { templateId: 'tpl-used', title: '在用' });
    const blocked = deleteWorkflowTemplate(db, 'tpl-used');
    assert.equal(blocked.deleted, false);
    assert.equal(blocked.runCount, 1);
    assert.ok(getWorkflowTemplate(db, 'tpl-used'), '有 run 时模板必须还在');

    makeTemplate(db, { templateId: 'tpl-free' });
    updateWorkflowTemplate(db, 'tpl-free', { name: 'v2' });
    const removed = deleteWorkflowTemplate(db, 'tpl-free');
    assert.equal(removed.deleted, true);
    assert.equal(getWorkflowTemplate(db, 'tpl-free'), null);
    assert.equal(getWorkflowTemplateVersion(db, 'tpl-free', 1), null);
  } finally {
    closeDb(db);
  }
});

test('DELETE：coding-v1 没 run 时可以删，不搞内置模板特权', () => {
  const db = openDb({ memory: true });
  try {
    const removed = deleteWorkflowTemplate(db, CODING_V1_TEMPLATE_ID);
    assert.equal(removed.deleted, true);
    assert.equal(getWorkflowTemplate(db, CODING_V1_TEMPLATE_ID), null);
  } finally {
    closeDb(db);
  }
});
