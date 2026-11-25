// P0 第一步数据层测试：workflow_templates / workflow_runs / workflow_run_steps。
// 运行：node --no-warnings --test test/workflow-db.test.js
//
// 五条用例对应用户验收口径：建表 / 插入模板 / 插入 run / 插入 step / 查询。
// 每条都真开 SQLite、真写、真读回，不做 mock。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, closeDb } from '../web/lib/db.mjs';
import {
  CODING_V1_TEMPLATE_ID,
  RUN_STATUSES,
  RUN_STEP_STATUSES,
  seedWorkflowTemplates,
} from '../web/lib/workflow-schema.mjs';
import {
  getWorkflowTemplate,
  listWorkflowTemplates,
  insertWorkflowTemplate,
  insertWorkflowRun,
  getWorkflowRun,
  listWorkflowRuns,
  updateWorkflowRunStatus,
  setWorkflowRunCurrentStep,
  setWorkflowRunTargetScore,
  insertWorkflowRunStep,
  getWorkflowRunStep,
  listWorkflowRunSteps,
  updateWorkflowRunStep,
} from '../web/lib/workflow-db.mjs';

const TEMPLATE_COLUMNS = [
  'template_id', 'name', 'version', 'steps', 'rework_routes', 'scoring', 'autonomy', 'created_at', 'updated_at',
];
const RUN_COLUMNS = [
  'run_id', 'template_id', 'template_version', 'title', 'current_step', 'status', 'status_reason',
  'requirement_baseline', 'target_score', 'created_at', 'updated_at', 'archived_at',
  // TASK-COMPANY-D0 迁移 v10 追加：run 归属部门
  'department_id',
];
const STEP_COLUMNS = [
  'run_step_id', 'run_id', 'step_id', 'status', 'entered_at', 'exited_at', 'gate_result', 'artifacts',
];

function all(db, sql, params = []) {
  return db.prepare(sql).all(...params);
}

function columnsOf(db, table) {
  return all(db, `PRAGMA table_info(${table})`).map((c) => c.name);
}

function makeRun(db, overrides = {}) {
  return insertWorkflowRun(db, {
    templateId: CODING_V1_TEMPLATE_ID,
    title: '测试运行',
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// 1. 建表
// ---------------------------------------------------------------------------
test('建表：三张工作流表存在，字段顺序与任务书一致', () => {
  const db = openDb({ memory: true });
  try {
    const tables = all(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .map((r) => r.name);
    for (const table of ['workflow_templates', 'workflow_runs', 'workflow_run_steps']) {
      assert.ok(tables.includes(table), `缺表：${table}`);
    }
    assert.deepEqual(columnsOf(db, 'workflow_templates'), TEMPLATE_COLUMNS);
    assert.deepEqual(columnsOf(db, 'workflow_runs'), RUN_COLUMNS);
    assert.deepEqual(columnsOf(db, 'workflow_run_steps'), STEP_COLUMNS);

    // 外键真的开了：workflow_runs.template_id 指幽灵模板必须被拒
    assert.throws(
      () =>
        db.prepare(
          'INSERT INTO workflow_runs (run_id, template_id, template_version, title, status, created_at, updated_at) ' +
            "VALUES ('r-ghost', 'no-such-template', 1, 'x', 'running', '2026-11-24T00:00:00.000Z', '2026-11-24T00:00:00.000Z')",
        ).run(),
      /FOREIGN KEY/,
    );
  } finally {
    closeDb(db);
  }
});

// ---------------------------------------------------------------------------
// 2. 插入模板
// ---------------------------------------------------------------------------
test('插入模板：coding-v1 预置四段 JSON 完整，自定义模板可落库', () => {
  const db = openDb({ memory: true });
  try {
    const preset = getWorkflowTemplate(db, CODING_V1_TEMPLATE_ID);
    assert.ok(preset, 'v6 迁移必须预置 coding-v1');
    assert.equal(preset.name, '编码全流程');
    assert.equal(preset.version, 1);
    assert.match(preset.created_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(preset.updated_at, /^\d{4}-\d{2}-\d{2}T/);

    // steps：九步，每步六个字段齐全
    const steps = JSON.parse(preset.steps);
    assert.equal(steps.length, 9);
    assert.deepEqual(steps.map((s) => s.id), ['01', '02', '03', '04', '05', '06', '07', '08', '09']);
    for (const step of steps) {
      for (const key of ['id', 'name', 'actor', 'collaborators', 'outputs', 'gate']) {
        assert.ok(key in step, `步骤 ${step.id} 缺字段 ${key}`);
      }
      assert.ok(Array.isArray(step.collaborators), `步骤 ${step.id} 的 collaborators 必须是数组`);
      assert.ok(Array.isArray(step.outputs) && step.outputs.length > 0, `步骤 ${step.id} 的 outputs 不能为空`);
    }
    assert.equal(steps.find((s) => s.id === '07').fallback_actor, 'claude-subagent');

    // rework_routes：失败原因 → 回到哪步，八条全在
    const routes = JSON.parse(preset.rework_routes);
    assert.equal(routes.code_bug, '05');
    assert.equal(routes.test_gap, '06');
    assert.equal(routes.plan_flaw, '04');
    assert.equal(routes.req_ambiguity, '02');
    assert.equal(routes.agent_capability, 'switch_agent');
    assert.equal(routes.quota_exhausted, 'pause_or_switch');
    assert.ok(Object.keys(routes).length >= 6);

    // scoring：默认权重合计 1.0
    const scoring = JSON.parse(preset.scoring);
    assert.deepEqual(scoring, {
      requirement_fit: 0.30,
      correctness: 0.25,
      code_quality: 0.20,
      ux: 0.15,
      stability_security: 0.10,
    });
    const sum = Object.values(scoring).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `权重合计应为 1，实际 ${sum}`);

    // autonomy：self_decide / must_ask 都有内容
    const autonomy = JSON.parse(preset.autonomy);
    assert.ok(autonomy.self_decide.length > 0);
    assert.ok(autonomy.must_ask.length > 0);
    assert.ok(autonomy.must_ask.includes('change_requirement'));

    // 幂等：重复 seed 不重复插入，也不覆盖
    seedWorkflowTemplates(db);
    assert.equal(all(db, 'SELECT * FROM workflow_templates WHERE template_id = ?', [CODING_V1_TEMPLATE_ID]).length, 1);

    // 自定义模板：四个 JSON 原样往返，查得回
    const custom = insertWorkflowTemplate(db, {
      templateId: 'docs-v1',
      name: '文档流程',
      version: 2,
      createdAt: 1000,
      updatedAt: 2000,
      steps: [
        {
          id: '01',
          name: '写',
          actor: 'claude',
          collaborators: ['hermes'],
          outputs: ['draft'],
          gate: 'user_approval',
        },
      ],
      reworkRoutes: { bad_quality: '01' },
      scoring: { quality: 1 },
      autonomy: { self_decide: ['retry'], must_ask: ['publish'] },
    });
    assert.equal(custom.template_id, 'docs-v1');
    assert.equal(custom.version, 2);
    assert.equal(custom.created_at, '1970-01-01T00:00:01.000Z');
    assert.equal(custom.updated_at, '1970-01-01T00:00:02.000Z');
    assert.deepEqual(JSON.parse(custom.steps)[0].collaborators, ['hermes']);
    assert.deepEqual(JSON.parse(custom.rework_routes), { bad_quality: '01' });
    assert.deepEqual(JSON.parse(custom.autonomy), { self_decide: ['retry'], must_ask: ['publish'] });
    assert.equal(listWorkflowTemplates(db).length, 2);

    // 负路径：没有 steps 的模板不是模板
    assert.throws(() => insertWorkflowTemplate(db, { templateId: 'x', name: 'x', steps: [] }), TypeError);
    assert.throws(
      () => insertWorkflowTemplate(db, { templateId: 'y', name: 'y', steps: [{ id: '01', name: 'n', actor: 'a', gate: 'g' }] }),
      TypeError,
      'steps[].outputs 缺失必须拒收',
    );
  } finally {
    closeDb(db);
  }
});

// ---------------------------------------------------------------------------
// 3. 插入 run
// ---------------------------------------------------------------------------
test('插入 run：模板版本锁定、需求基线/目标分落库，默认状态 running', () => {
  const db = openDb({ memory: true });
  try {
    const run = insertWorkflowRun(db, {
      runId: 'run-001',
      templateId: CODING_V1_TEMPLATE_ID,
      title: '  任务归档功能  ',
      currentStep: '03',
      status: 'waiting_human',
      statusReason: '等 Leo 确认需求基线',
      requirementBaseline: '可以批量删、归档、恢复；正在跑的不能删，需先停。',
      targetScore: 8,
      createdAt: 1_000,
    });
    assert.equal(run.run_id, 'run-001');
    assert.equal(run.template_id, CODING_V1_TEMPLATE_ID);
    assert.equal(run.template_version, 1, '未显式给版本时应取模板当前版本');
    assert.equal(run.title, '任务归档功能', 'title 应 trim');
    assert.equal(run.current_step, '03');
    assert.equal(run.status, 'waiting_human');
    assert.equal(run.status_reason, '等 Leo 确认需求基线');
    assert.equal(run.requirement_baseline, '可以批量删、归档、恢复；正在跑的不能删，需先停。');
    assert.equal(run.target_score, 8);
    assert.equal(run.created_at, '1970-01-01T00:00:01.000Z');
    assert.equal(run.archived_at, null);

    // 默认值：running / 目标分 null（不是 0）/ 基线可为 null
    const bare = makeRun(db, { runId: 'run-002', title: '裸跑' });
    assert.equal(bare.status, 'running');
    assert.equal(bare.target_score, null);
    assert.equal(bare.requirement_baseline, null);
    assert.equal(bare.current_step, null);

    // 负路径：未知模板 / 非法状态 / 非法目标分
    assert.throws(() => makeRun(db, { templateId: 'ghost' }), RangeError);
    assert.throws(() => makeRun(db, { status: 'nope' }), RangeError);
    assert.throws(() => makeRun(db, { targetScore: -1 }), TypeError);
    assert.throws(() => makeRun(db, { templateVersion: 0 }), TypeError);

    // 枚举常量与数据层约定一致（switch_agent 是 P0 第三步新增的「需换人」状态）
    assert.deepEqual(RUN_STATUSES, ['running', 'waiting_human', 'switch_agent', 'blocked', 'completed', 'failed', 'archived']);
  } finally {
    closeDb(db);
  }
});

// ---------------------------------------------------------------------------
// 4. 插入 step
// ---------------------------------------------------------------------------
test('插入 step：交付物路径 JSON 往返，状态/时间/判据完整，重复步骤被唯一约束拦下', () => {
  const db = openDb({ memory: true });
  try {
    const run = makeRun(db, { runId: 'run-step' });
    const step = insertWorkflowRunStep(db, {
      runStepId: 'rs-07',
      runId: run.run_id,
      stepId: '07',
      status: 'done',
      enteredAt: 2_000,
      exitedAt: 3_000,
      gateResult: '硬性验收全过；总分 8.6 / 目标 8',
      artifacts: ['docs/runs/run-step/07-review-r1.md', 'docs/runs/run-step/score-r1.json'],
    });
    assert.equal(step.run_step_id, 'rs-07');
    assert.equal(step.run_id, 'run-step');
    assert.equal(step.step_id, '07');
    assert.equal(step.status, 'done');
    assert.equal(step.entered_at, '1970-01-01T00:00:02.000Z');
    assert.equal(step.exited_at, '1970-01-01T00:00:03.000Z');
    assert.equal(step.gate_result, '硬性验收全过；总分 8.6 / 目标 8');
    assert.deepEqual(JSON.parse(step.artifacts), [
      'docs/runs/run-step/07-review-r1.md',
      'docs/runs/run-step/score-r1.json',
    ]);
    assert.deepEqual(getWorkflowRunStep(db, 'rs-07'), step);

    // 默认值：pending / artifacts []
    const bare = insertWorkflowRunStep(db, { runId: run.run_id, stepId: '08' });
    assert.equal(bare.status, 'pending');
    assert.deepEqual(JSON.parse(bare.artifacts), []);
    assert.equal(bare.entered_at, null);

    // 同一 run 的同一步只允许一行
    assert.throws(() => insertWorkflowRunStep(db, { runId: run.run_id, stepId: '07' }), /UNIQUE/);

    // 负路径：非法状态 / artifacts 非数组 / 幽灵 run（外键）
    assert.throws(() => insertWorkflowRunStep(db, { runId: run.run_id, stepId: '09', status: 'nope' }), RangeError);
    assert.throws(
      () => insertWorkflowRunStep(db, { runId: run.run_id, stepId: '09', artifacts: 'a.md' }),
      TypeError,
    );
    assert.throws(() => insertWorkflowRunStep(db, { runId: 'ghost-run', stepId: '01' }), /FOREIGN KEY/);

    assert.deepEqual(RUN_STEP_STATUSES, ['pending', 'running', 'done', 'failed', 'skipped']);
  } finally {
    closeDb(db);
  }
});

// ---------------------------------------------------------------------------
// 5. 查询（列表 / 筛选 / 排序 / miss / 基线不可变）
// ---------------------------------------------------------------------------
test('查询：列表筛选排序正确，查无返回 null，需求基线不会被状态更新改写', () => {
  const db = openDb({ memory: true });
  try {
    const older = makeRun(db, {
      runId: 'run-older',
      title: '旧运行',
      status: 'running',
      requirementBaseline: '基线 A',
      targetScore: 7,
      createdAt: 1_000,
    });
    const newer = makeRun(db, {
      runId: 'run-newer',
      title: '新运行',
      status: 'completed',
      createdAt: 2_000,
    });

    // 运行列表：created_at 倒序；按状态 / 模板筛选
    assert.deepEqual(listWorkflowRuns(db).map((r) => r.run_id), ['run-newer', 'run-older']);
    assert.deepEqual(listWorkflowRuns(db, { status: 'running' }).map((r) => r.run_id), ['run-older']);
    assert.deepEqual(
      listWorkflowRuns(db, { templateId: CODING_V1_TEMPLATE_ID }).map((r) => r.run_id),
      ['run-newer', 'run-older'],
    );
    assert.deepEqual(listWorkflowRuns(db, { status: 'failed' }), []);

    // 步骤列表：按 step_id 升序，与插入顺序无关
    insertWorkflowRunStep(db, { runId: older.run_id, stepId: '03' });
    insertWorkflowRunStep(db, { runId: older.run_id, stepId: '01' });
    insertWorkflowRunStep(db, { runId: older.run_id, stepId: '02' });
    assert.deepEqual(listWorkflowRunSteps(db, older.run_id).map((s) => s.step_id), ['01', '02', '03']);
    assert.deepEqual(listWorkflowRunSteps(db, 'no-such-run'), []);

    // 查无返回 null，不编数据
    assert.equal(getWorkflowRun(db, 'no-such-run'), null);
    assert.equal(getWorkflowRunStep(db, 'no-such-step'), null);
    assert.equal(getWorkflowTemplate(db, 'no-such-template'), null);

    // 状态更新生效；requirement_baseline 在状态 / 当前步 / 目标分三次更新后纹丝不动
    const blocked = updateWorkflowRunStatus(db, older.run_id, 'blocked', { statusReason: '额度耗尽' });
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.status_reason, '额度耗尽');
    setWorkflowRunCurrentStep(db, older.run_id, '05');
    setWorkflowRunTargetScore(db, older.run_id, 8.5);
    const after = getWorkflowRun(db, older.run_id);
    assert.equal(after.requirement_baseline, '基线 A', '需求基线是快照，任何更新都不许改它');
    assert.equal(after.current_step, '05');
    assert.equal(after.target_score, 8.5);

    // 归档写 archived_at；查无时更新返回 null
    const archived = updateWorkflowRunStatus(db, newer.run_id, 'archived', { archivedAt: 9_000 });
    assert.equal(archived.status, 'archived');
    assert.equal(archived.archived_at, '1970-01-01T00:00:09.000Z');
    assert.equal(updateWorkflowRunStatus(db, 'no-such-run', 'failed'), null);

    // 步骤更新：状态 / 判据 / 交付物，只动显式传入的字段
    const first = listWorkflowRunSteps(db, older.run_id)[0];
    const updated = updateWorkflowRunStep(db, first.run_step_id, {
      status: 'done',
      gateResult: '判据通过',
      artifacts: ['docs/runs/run-older/01-requirement.md'],
    });
    assert.equal(updated.status, 'done');
    assert.equal(updated.gate_result, '判据通过');
    assert.deepEqual(JSON.parse(updated.artifacts), ['docs/runs/run-older/01-requirement.md']);
    assert.equal(updated.entered_at, null, '未传的字段应保持原值');
  } finally {
    closeDb(db);
  }
});
