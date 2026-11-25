// workflow-schema.mjs — 工作流三张表的 schema 与 coding-v1 预置模板。
//
// 依据：docs/工作流定义-v3-定稿.md（Leo 2026-11-24 拍板）。
// 由 web/lib/db.mjs 的 v6 迁移调用：建表 + 预置 coding-v1，幂等可重入。
// 单独成文件是为了让 db.mjs（建表入口）和 workflow-db.mjs（读写函数）都能引用它，
// 又不产生循环依赖。
//
// 时间戳沿用 web/lib 其它表的约定：TEXT，ISO 8601 字符串（如 2026-11-24T09:30:00.000Z）。
// JSON 字段（steps / rework_routes / scoring / autonomy / artifacts）以 JSON 字符串落库。

/**
 * workflow_runs.status 枚举（任务书原文 + P0 第三步）。
 * switch_agent 是第三步新增：agent_capability 类失败不返工，标记「需换人」（W9）。
 */
export const RUN_STATUSES = ['running', 'waiting_human', 'switch_agent', 'blocked', 'completed', 'failed', 'archived'];

/** workflow_run_steps.status 枚举（任务书原文）。 */
export const RUN_STEP_STATUSES = ['pending', 'running', 'done', 'failed', 'skipped'];

/** 预置模板 id，别处引用它时用这个常量，避免手写字符串写错。 */
export const CODING_V1_TEMPLATE_ID = 'coding-v1';

/**
 * 三张表的建表语句。幂等（IF NOT EXISTS），v6 迁移执行一次。
 *
 * 外键：
 * - workflow_runs.template_id → workflow_templates.template_id
 *   跑一个流程必须基于真实存在的模板，幽灵模板直接拒写；
 * - workflow_run_steps.run_id → workflow_runs.run_id，ON DELETE CASCADE
 *   步骤是 run 的从属数据，run 删了步骤跟着删，不留孤儿。
 */
export const WORKFLOW_SCHEMA = `
CREATE TABLE IF NOT EXISTS workflow_templates (
  template_id   TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  steps         TEXT NOT NULL,
  rework_routes TEXT NOT NULL DEFAULT '{}',
  scoring       TEXT NOT NULL DEFAULT '{}',
  autonomy      TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  run_id                TEXT PRIMARY KEY,
  template_id           TEXT NOT NULL REFERENCES workflow_templates(template_id),
  template_version      INTEGER NOT NULL,
  title                 TEXT NOT NULL,
  current_step          TEXT,
  status                TEXT NOT NULL DEFAULT 'running',
  status_reason         TEXT,
  requirement_baseline  TEXT,
  target_score          REAL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  archived_at           TEXT
);

CREATE TABLE IF NOT EXISTS workflow_run_steps (
  run_step_id  TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
  step_id      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  entered_at   TEXT,
  exited_at    TEXT,
  gate_result  TEXT,
  artifacts    TEXT NOT NULL DEFAULT '[]',
  UNIQUE (run_id, step_id)
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_template_id ON workflow_runs(template_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status      ON workflow_runs(status);
CREATE INDEX IF NOT EXISTS idx_workflow_steps_run_id     ON workflow_run_steps(run_id);
CREATE INDEX IF NOT EXISTS idx_workflow_steps_run_status ON workflow_run_steps(run_id, status);
`;

/**
 * coding-v1 的九步，逐条对应 v3 定稿 §一 的表格。
 * 每步都有 id / name / actor / collaborators / outputs / gate 六个字段；
 * 05 / 07 额外带 fallback_actor，对应「Claude 优先 → DSH」与「Codex → Claude 子 agent」。
 */
const CODING_V1_STEPS = [
  {
    id: '01',
    name: '需求输入',
    actor: 'user',
    collaborators: [],
    outputs: ['requirement'],
    gate: 'user_done',
  },
  {
    id: '02',
    name: '需求澄清',
    actor: 'hermes',
    collaborators: ['leo'],
    outputs: ['clarification_qa'],
    gate: 'ambiguities_resolved',
  },
  {
    id: '03',
    name: '需求讨论与确认',
    actor: 'hermes',
    collaborators: ['gpt', 'codex'],
    outputs: ['confirm_discuss', 'confirm_final'],
    gate: 'user_approval',
  },
  {
    id: '04',
    name: '开发计划与任务书',
    actor: 'hermes',
    collaborators: [],
    outputs: ['task_breakdown', 'tech_plan', 'dependencies', 'acceptance_criteria'],
    gate: 'docs_written_and_registered_in_agent_office',
  },
  {
    id: '05',
    name: '开发执行',
    actor: 'claude',
    fallback_actor: 'dsh',
    collaborators: [],
    outputs: ['code_commit'],
    gate: 'each_batch_committed_and_reported',
  },
  {
    id: '06',
    name: '开发者自测',
    actor: 'claude',
    fallback_actor: 'dsh',
    collaborators: [],
    outputs: ['test_evidence'],
    gate: 'unit_build_and_functional_tests_all_pass',
  },
  {
    id: '07',
    name: '独立验证与评审',
    actor: 'codex',
    fallback_actor: 'claude-subagent',
    collaborators: [],
    outputs: ['review_report', 'score'],
    gate: 'hard_criteria_pass AND score >= target',
  },
  {
    id: '08',
    name: '最终验收与交付',
    actor: 'hermes',
    collaborators: ['leo'],
    outputs: ['acceptance_report'],
    gate: 'user_approval',
  },
  {
    id: '09',
    name: '归档与复盘',
    actor: 'hermes',
    collaborators: [],
    outputs: ['retrospective_report', 'improvement_suggestions'],
    gate: 'metrics_summarized_and_improvement_closed',
  },
];

/**
 * 预置模板 coding-v1 —— v3 定稿里的那份 JSON。
 *
 * - steps：定稿 §一 的九步（定稿 JSON 只举了 01/03/07 三例，这里按同一结构补全）；
 * - rework_routes：定稿 §二 的八条失败原因路由（JSON 草案只列了六条，
 *   这里补上"评审标准不一致"和"外部环境故障"两条，值不是步骤号时表示特殊动作）；
 * - scoring：定稿 §三 默认权重，合计 1.0；
 * - autonomy：定稿 §四 JSON 原文。
 */
export const CODING_V1_TEMPLATE = {
  templateId: CODING_V1_TEMPLATE_ID,
  name: '编码全流程',
  version: 1,
  steps: CODING_V1_STEPS,
  reworkRoutes: {
    code_bug: '05',
    test_gap: '06',
    plan_flaw: '04',
    req_ambiguity: '02',
    agent_capability: 'switch_agent',
    quota_exhausted: 'pause_or_switch',
    review_criteria_mismatch: '07',
    external_env_failure: 'resume',
  },
  scoring: {
    requirement_fit: 0.30,
    correctness: 0.25,
    code_quality: 0.20,
    ux: 0.15,
    stability_security: 0.10,
  },
  autonomy: {
    self_decide: ['retry_failed_step', 'switch_agent', 'adjust_order'],
    must_ask: ['change_requirement', 'publish', 'spend_money'],
  },
};

/**
 * v7（P0 第二步）：模板历史版本表。
 *
 * workflow_templates 以 template_id 为主键、version 只是当前版本号，
 * 原地升级会把旧定义冲掉。任务要求「PUT 后版本 +1，旧版本保留」，
 * 所以每次更新前把当前行整份抄进这张表；v1 被 v2 取代后，
 * 仍能从历史表按 (template_id, version) 查回。
 *
 * 历史行是只读快照：不参与 run 的外键，也不出现在模板列表里。
 */
export const WORKFLOW_VERSION_SCHEMA = `
CREATE TABLE IF NOT EXISTS workflow_template_versions (
  template_id   TEXT NOT NULL,
  version       INTEGER NOT NULL,
  name          TEXT NOT NULL,
  steps         TEXT NOT NULL,
  rework_routes TEXT NOT NULL DEFAULT '{}',
  scoring       TEXT NOT NULL DEFAULT '{}',
  autonomy      TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  archived_at   TEXT NOT NULL,
  PRIMARY KEY (template_id, version)
);

CREATE INDEX IF NOT EXISTS idx_workflow_template_versions_id
  ON workflow_template_versions(template_id, version);
`;

/**
 * 预置 coding-v1，幂等。已存在就一行不写（ON CONFLICT DO NOTHING），
 * 不覆盖用户后来改过的同名模板。
 */
export function seedWorkflowTemplates(db, now = new Date()) {
  const at = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const t = CODING_V1_TEMPLATE;
  db.prepare(
    'INSERT INTO workflow_templates (template_id, name, version, steps, rework_routes, scoring, autonomy, created_at, updated_at) ' +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(template_id) DO NOTHING",
  ).run(
    t.templateId,
    t.name,
    t.version,
    JSON.stringify(t.steps),
    JSON.stringify(t.reworkRoutes),
    JSON.stringify(t.scoring),
    JSON.stringify(t.autonomy),
    at,
    at,
  );
}
