// P0 第三步测试：执行状态机（W1-W14 的模块级版本）。
// 运行：node --no-warnings --test test/workflow-engine.test.js
//
// 每个用例真开一个内存 SQLite、真建 run / 真推进 / 真读回，不做 mock。
// 同一组 W1-W14 还会由 scripts/verify-workflow-engine.mjs 走真实 HTTP 再跑一遍。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, closeDb } from '../web/lib/db.mjs';
import { insertWorkflowTemplate } from '../web/lib/workflow-db.mjs';
import {
  assertAutonomy,
  classifyGate,
  createWorkflowEngine,
  evaluateGate,
  WorkflowEngineError,
} from '../web/lib/workflow-engine.mjs';
import { CODING_V1_TEMPLATE_ID } from '../web/lib/workflow-schema.mjs';

const BASELINE = '可以批量删、归档、恢复；正在跑的不能删，需先停。';

function fresh() {
  const db = openDb({ memory: true });
  return { db, engine: createWorkflowEngine(db), close: () => closeDb(db) };
}

function newRun(engine, extra = {}) {
  return engine.createRun(CODING_V1_TEMPLATE_ID, {
    title: 'W 系列验证',
    requirementBaseline: BASELINE,
    targetScore: 8,
    ...extra,
  });
}

/** 一路 approve 到某步（approve 在引擎里就是「人放行」，不受 gate 类型限制）。 */
function driveTo(engine, runId, stepId) {
  for (let i = 0; i < 12; i += 1) {
    const state = engine.getRunState(runId);
    if (state.current_step_id === stepId) return state;
    if (state.status === 'completed') throw new Error(`run 已完成，到不了 ${stepId}`);
    engine.approve(runId, {});
  }
  throw new Error(`推进不到第 ${stepId} 步`);
}

// ---------------------------------------------------------------------------
// W1 建 run：九条 step 全 pending，第一条 running
// ---------------------------------------------------------------------------
test('W1 创建 run：九条 step 全部 pending，第一条 running', () => {
  const { engine, close } = fresh();
  try {
    const run = newRun(engine);
    assert.equal(run.status, 'running');
    assert.equal(run.current_step_id, '01');
    assert.equal(run.total_steps, 9);
    assert.deepEqual(run.steps.map((s) => s.step_id), ['01', '02', '03', '04', '05', '06', '07', '08', '09']);
    assert.deepEqual(run.steps.map((s) => s.status), ['running', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending']);
    assert.equal(run.progress.done, 0);
    assert.equal(run.waiting_for_leo, false);
  } finally {
    close();
  }
});

// ---------------------------------------------------------------------------
// W2 第一步 gate=user_done：advance 停下等 Leo
// ---------------------------------------------------------------------------
test('W2 第一步 advance：gate=user_done，停在 waiting_human 并写明在等什么', () => {
  const { engine, close } = fresh();
  try {
    const run = newRun(engine);
    const result = engine.advanceStep(run.run_id, {});
    assert.equal(result.advanced, false);
    assert.equal(result.gate.type, 'user_done');
    assert.equal(result.state.status, 'waiting_human');
    assert.equal(result.state.current_step_id, '01');
    assert.equal(result.state.waiting_for_leo, true);
    assert.match(result.state.status_reason, /等待 Leo/);
    assert.equal(result.state.steps[0].status, 'running');
  } finally {
    close();
  }
});

// ---------------------------------------------------------------------------
// W3 Leo approve → 02
// ---------------------------------------------------------------------------
test('W3 approve 第一步：01 done，推进到 02', () => {
  const { engine, close } = fresh();
  try {
    const run = newRun(engine);
    engine.advanceStep(run.run_id, {});
    const approved = engine.approve(run.run_id, { note: '需求说完了' });
    assert.equal(approved.state.status, 'running');
    assert.equal(approved.state.current_step_id, '02');
    assert.equal(approved.state.steps[0].status, 'done');
    assert.equal(approved.state.steps[1].status, 'running');
    assert.equal(approved.state.steps[0].gate_result.status, 'approved');
  } finally {
    close();
  }
});

// ---------------------------------------------------------------------------
// W4 03 gate=user_approval：advance 409 等待确认
// ---------------------------------------------------------------------------
test('W4 第三步 gate=user_approval：advance 不通过，等 Leo 点头', () => {
  const { engine, close } = fresh();
  try {
    const run = newRun(engine);
    driveTo(engine, run.run_id, '03');
    const result = engine.advanceStep(run.run_id, {});
    assert.equal(result.advanced, false);
    assert.equal(result.gate.type, 'user_approval');
    assert.equal(result.state.status, 'waiting_human');
    assert.equal(result.state.current_step_id, '03');
    assert.match(result.state.status_reason, /等待 Leo 确认/);
  } finally {
    close();
  }
});

// ---------------------------------------------------------------------------
// W5 approve 03 → 04
// ---------------------------------------------------------------------------
test('W5 approve 03：推进到 04', () => {
  const { engine, close } = fresh();
  try {
    const run = newRun(engine);
    driveTo(engine, run.run_id, '03');
    engine.advanceStep(run.run_id, {});
    const approved = engine.approve(run.run_id, {});
    assert.equal(approved.state.current_step_id, '04');
    assert.equal(approved.state.status, 'running');
    assert.equal(approved.state.steps[2].status, 'done');
    assert.equal(approved.state.steps[3].status, 'running');
  } finally {
    close();
  }
});

// ---------------------------------------------------------------------------
// W6 code_bug → 05（回到 05，不往前推）
// ---------------------------------------------------------------------------
test('W6 fail 05（code_bug）→ rework 回 05，不是往前推', () => {
  const { engine, close } = fresh();
  try {
    const run = newRun(engine);
    driveTo(engine, run.run_id, '05');
    engine.failStep(run.run_id, '05', 'code_bug');
    const result = engine.rework(run.run_id, 'code_bug');
    assert.equal(result.routed, true);
    assert.equal(result.action, 'jump_to_step');
    assert.equal(result.target_step_id, '05');
    assert.equal(result.state.status, 'running');
    assert.equal(result.state.current_step_id, '05');
    assert.equal(result.state.steps[4].status, 'running');
    // 01-04 仍是 done：没有把已完成的往前推，也没有把 05 推到 06
    assert.deepEqual(result.state.steps.slice(0, 4).map((s) => s.status), ['done', 'done', 'done', 'done']);
    assert.equal(result.state.steps[5].status, 'pending');
  } finally {
    close();
  }
});

// ---------------------------------------------------------------------------
// W7 plan_flaw → 04
// ---------------------------------------------------------------------------
test('W7 fail 07（plan_flaw）→ rework 回 04，05-07 重置', () => {
  const { engine, close } = fresh();
  try {
    const run = newRun(engine);
    driveTo(engine, run.run_id, '07');
    engine.failStep(run.run_id, '07', 'plan_flaw');
    const result = engine.rework(run.run_id, 'plan_flaw');
    assert.equal(result.target_step_id, '04');
    assert.equal(result.state.current_step_id, '04');
    assert.equal(result.state.steps[3].status, 'running');
    assert.deepEqual(result.state.steps.slice(3, 7).map((s) => s.status), ['running', 'pending', 'pending', 'pending']);
    assert.deepEqual(result.state.steps.slice(0, 3).map((s) => s.status), ['done', 'done', 'done']);
  } finally {
    close();
  }
});

// ---------------------------------------------------------------------------
// W8 req_ambiguity → 02
// ---------------------------------------------------------------------------
test('W8 fail 05（req_ambiguity）→ rework 回 02', () => {
  const { engine, close } = fresh();
  try {
    const run = newRun(engine);
    driveTo(engine, run.run_id, '05');
    engine.failStep(run.run_id, '05', 'req_ambiguity');
    const result = engine.rework(run.run_id, 'req_ambiguity');
    assert.equal(result.target_step_id, '02');
    assert.equal(result.state.current_step_id, '02');
    assert.equal(result.state.steps[1].status, 'running');
    assert.deepEqual(result.state.steps.slice(1, 5).map((s) => s.status), ['running', 'pending', 'pending', 'pending']);
  } finally {
    close();
  }
});

// ---------------------------------------------------------------------------
// W9 agent_capability → switch_agent
// ---------------------------------------------------------------------------
test('W9 fail 05（agent_capability）→ rework 标记 switch_agent，需换人', () => {
  const { engine, close } = fresh();
  try {
    const run = newRun(engine);
    driveTo(engine, run.run_id, '05');
    engine.failStep(run.run_id, '05', 'agent_capability');
    const result = engine.rework(run.run_id, 'agent_capability');
    assert.equal(result.action, 'switch_agent');
    assert.equal(result.needs_switch_agent, true);
    assert.equal(result.state.status, 'switch_agent');
    assert.equal(result.state.needs_switch_agent, true);
    assert.equal(result.state.current_step_id, '05');
    assert.match(result.state.status_reason, /换人/);
  } finally {
    close();
  }
});

// ---------------------------------------------------------------------------
// W10 quota_exhausted → blocked
// ---------------------------------------------------------------------------
test('W10 fail 05（quota_exhausted）→ rework 暂停，status=blocked', () => {
  const { engine, close } = fresh();
  try {
    const run = newRun(engine);
    driveTo(engine, run.run_id, '05');
    engine.failStep(run.run_id, '05', 'quota_exhausted');
    const result = engine.rework(run.run_id, 'quota_exhausted');
    assert.equal(result.action, 'pause');
    assert.equal(result.state.status, 'blocked');
    assert.match(result.state.status_reason, /额度/);
  } finally {
    close();
  }
});

// ---------------------------------------------------------------------------
// W11 交付物挂载 / 读回
// ---------------------------------------------------------------------------
test('W11 挂交付物：追加去重，GET 状态读回正确', () => {
  const { engine, close } = fresh();
  try {
    const run = newRun(engine);
    engine.recordArtifact(run.run_id, '01', ['docs/runs/r1/requirement.md']);
    engine.recordArtifact(run.run_id, '01', 'docs/runs/r1/requirement-v2.md');
    // 重复挂同一条不重复记
    engine.recordArtifact(run.run_id, '01', ['docs/runs/r1/requirement.md']);
    engine.recordArtifact(run.run_id, '03', ['docs/runs/r1/baseline.md', 'docs/runs/r1/confirm.md']);

    const state = engine.getRunState(run.run_id);
    assert.deepEqual(state.steps[0].artifacts, [
      'docs/runs/r1/requirement.md',
      'docs/runs/r1/requirement-v2.md',
    ]);
    assert.deepEqual(state.steps[2].artifacts, [
      'docs/runs/r1/baseline.md',
      'docs/runs/r1/confirm.md',
    ]);
    assert.deepEqual(state.steps[1].artifacts, []);
  } finally {
    close();
  }
});

// ---------------------------------------------------------------------------
// W12 autonomy：must_ask → 403；self_decide 放行
// ---------------------------------------------------------------------------
test('W12 autonomy：must_ask 动作被 403 拦下，self_decide 动作放行', () => {
  const { engine, close } = fresh();
  try {
    const run = newRun(engine);
    assert.throws(
      () => engine.advanceStep(run.run_id, { action: 'publish' }),
      (err) => err instanceof WorkflowEngineError
        && err.statusCode === 403
        && err.code === 'NEEDS_LEO_APPROVAL'
        && /需要 Leo 批准/.test(err.message),
    );
    assert.throws(
      () => engine.approve(run.run_id, { action: 'change_requirement' }),
      (err) => err.statusCode === 403 && /需要 Leo 批准/.test(err.message),
    );

    // self_decide 放行：不是因为 403，而是正常走到 gate 判断（01 仍是 user_done）
    const result = engine.advanceStep(run.run_id, { action: 'retry_failed_step' });
    assert.equal(result.advanced, false);
    assert.equal(result.gate.type, 'user_done');

    // 空模板 autonomy 的动作不擅自做
    const lonely = { autonomy: JSON.stringify({}) };
    assert.throws(
      () => assertAutonomy(lonely, 'publish'),
      (err) => err.statusCode === 400 && err.code === 'UNKNOWN_ACTION',
    );
  } finally {
    close();
  }
});

// ---------------------------------------------------------------------------
// W13 全流程 01→09 每步 approve，最后 completed
// ---------------------------------------------------------------------------
test('W13 全流程：01→09 每步 approve，最后 status=completed', () => {
  const { engine, close } = fresh();
  try {
    const run = newRun(engine);
    for (let i = 0; i < 9; i += 1) {
      const before = engine.getRunState(run.run_id);
      const expected = String(i + 1).padStart(2, '0');
      assert.equal(before.current_step_id, expected, `第 ${i + 1} 次确认前应在 ${expected}`);
      engine.approve(run.run_id, { note: `第 ${expected} 步确认` });
    }
    const state = engine.getRunState(run.run_id);
    assert.equal(state.status, 'completed');
    assert.equal(state.progress.done, 9);
    assert.deepEqual(state.steps.map((s) => s.status), Array(9).fill('done'));
    assert.equal(state.waiting_for_leo, false);
  } finally {
    close();
  }
});

// ---------------------------------------------------------------------------
// W14 需求基线不被改
// ---------------------------------------------------------------------------
test('W14 需求基线在推进 / 确认 / 返工中一字不变', () => {
  const { engine, close } = fresh();
  try {
    const run = newRun(engine);
    const baseline = engine.getRunState(run.run_id).requirement_baseline;
    assert.equal(baseline, BASELINE);

    engine.advanceStep(run.run_id, {});
    engine.approve(run.run_id, {});
    driveTo(engine, run.run_id, '05');
    engine.failStep(run.run_id, '05', 'code_bug');
    engine.rework(run.run_id, 'code_bug');

    const state = engine.getRunState(run.run_id);
    assert.equal(state.requirement_baseline, BASELINE);
    assert.equal(state.requirement_baseline, baseline);
    // run 表这一列也没有更新路径可走
    const row = engine.getRunState(run.run_id);
    assert.equal(row.requirement_baseline, baseline);
  } finally {
    close();
  }
});

// ---------------------------------------------------------------------------
// 判据 gate：07 的 score >= target
// ---------------------------------------------------------------------------
test('gate=criteria：07 评审分数达到目标分才放行', () => {
  const { engine, close } = fresh();
  try {
    const run = newRun(engine, { targetScore: 8 });
    driveTo(engine, run.run_id, '07');

    const low = engine.advanceStep(run.run_id, { score: 7.5 });
    assert.equal(low.advanced, false);
    assert.match(low.state.status_reason, /未达到目标分 8/);

    const noHard = engine.advanceStep(run.run_id, { score: 9, hardCriteriaPass: false });
    assert.equal(noHard.advanced, false);
    assert.match(noHard.state.status_reason, /硬性验收未全过/);

    const pass = engine.advanceStep(run.run_id, { score: 8.5 });
    assert.equal(pass.advanced, true);
    assert.equal(pass.state.current_step_id, '08');
  } finally {
    close();
  }
});

test('gate 分类：user_done / user_approval / auto / criteria 四类', () => {
  assert.equal(classifyGate('user_done'), 'user_done');
  assert.equal(classifyGate('user_approval'), 'user_approval');
  assert.equal(classifyGate('auto'), 'auto');
  assert.equal(classifyGate('hard_criteria_pass AND score >= target'), 'criteria');
  assert.equal(classifyGate('ambiguities_resolved'), 'criteria');

  const run = { target_score: 8 };
  const auto = evaluateGate({ run, stepDef: { id: '01', name: 'x', gate: 'auto' } });
  assert.equal(auto.satisfied, true);
  const low = evaluateGate({ run, stepDef: { id: '07', name: '评审', gate: 'score >= target' }, opts: { score: 7 } });
  assert.equal(low.satisfied, false);
});

test('返工：未知失败原因 400，并列出模板支持的原因', () => {
  const { engine, close } = fresh();
  try {
    const run = newRun(engine);
    driveTo(engine, run.run_id, '05');
    engine.failStep(run.run_id, '05', 'code_bug');
    assert.throws(
      () => engine.rework(run.run_id, 'made_up_reason'),
      (err) => err.statusCode === 400
        && err.code === 'UNKNOWN_FAILURE_CAUSE'
        && err.details.available.includes('code_bug'),
    );
  } finally {
    close();
  }
});

test('返工：env_failure 别名映射到模板的 external_env_failure，落到 blocked', () => {
  const { engine, close } = fresh();
  try {
    const run = newRun(engine);
    driveTo(engine, run.run_id, '05');
    engine.failStep(run.run_id, '05', 'env_failure');
    const result = engine.rework(run.run_id, 'env_failure');
    assert.equal(result.action, 'resume');
    assert.equal(result.state.status, 'blocked');
    assert.match(result.state.status_reason, /环境/);
  } finally {
    close();
  }
});

test('状态机：failed 的 run 不能直接 advance，必须先 rework', () => {
  const { engine, close } = fresh();
  try {
    const run = newRun(engine);
    driveTo(engine, run.run_id, '05');
    engine.failStep(run.run_id, '05', 'code_bug');
    assert.throws(
      () => engine.advanceStep(run.run_id, {}),
      (err) => err.statusCode === 409 && err.code === 'RUN_FAILED',
    );
  } finally {
    close();
  }
});

test('状态机：completed 的 run 不能再 approve / advance', () => {
  const { engine, close } = fresh();
  try {
    const run = newRun(engine);
    for (let i = 0; i < 9; i += 1) engine.approve(run.run_id, {});
    assert.equal(engine.getRunState(run.run_id).status, 'completed');
    assert.throws(
      () => engine.approve(run.run_id, {}),
      (err) => err.statusCode === 409 && err.code === 'RUN_COMPLETED',
    );
    assert.throws(
      () => engine.advanceStep(run.run_id, {}),
      (err) => err.statusCode === 409 && err.code === 'RUN_COMPLETED',
    );
  } finally {
    close();
  }
});

test('返工路由来自模板：自定义模板里的 code_bug → 01，不写死 05', () => {
  const { db, engine, close } = fresh();
  try {
    insertWorkflowTemplate(db, {
      templateId: 'custom-route',
      name: '自定义两步',
      steps: [
        { id: '01', name: '想清楚', actor: 'user', outputs: ['idea'], gate: 'auto' },
        { id: '02', name: '动手', actor: 'claude', outputs: ['code_commit'], gate: 'auto' },
      ],
      reworkRoutes: { code_bug: '01' },
      autonomy: { self_decide: ['retry_failed_step'], must_ask: ['publish'] },
    });
    const run = engine.createRun('custom-route', { title: '自定义路由' });
    // auto gate 不需要人确认，直接推进
    const advanced = engine.advanceStep(run.run_id, {});
    assert.equal(advanced.advanced, true);
    assert.equal(advanced.state.current_step_id, '02');

    engine.failStep(run.run_id, '02', 'code_bug');
    const reworked = engine.rework(run.run_id, 'code_bug');
    // coding-v1 的 code_bug 回 05；这里必须听自定义模板的，回 01
    assert.equal(reworked.target_step_id, '01');
    assert.equal(reworked.state.current_step_id, '01');
  } finally {
    close();
  }
});
