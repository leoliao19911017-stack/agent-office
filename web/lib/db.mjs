// db.mjs — Agent Office V1 P0 数据层：SQLite 初始化 + 建表 + 迁移（幂等）
//
// 用 Node 内置 node:sqlite（Node 24 实测可用），不安装 better-sqlite3，
// 避免原生模块编译问题。数据库默认落在仓库 data/agent-office.db，
// 可用环境变量 AGENT_OFFICE_DB 覆盖（selftest / 迁移脚本用它隔离现场）。
//
// 设计约束（见 TASK-P0-地基.md §2.1）：
//   tasks / attempts / events / checkpoints 四张主表 + write_owner 所有权表。
// 另有三张辅助表，都是为了让「任务做到哪一步」和「迁移幂等」可查，不是替代主表：
//   task_steps      任务步骤（tasks 表只存任务头，步骤单独成表，避免把 JSON 塞进任务行）
//   migrate_ledger  旧 JSON 迁移账本（同一文件同一内容只迁一次）
//   schema_meta     建表版本，供后续迁移判断
// v2（TASK-AgentChat V1）另加聊天六张表 chat_threads / chat_messages / chat_turns /
// chat_events / chat_approvals / chat_summaries，与任务三张表互相独立（见 SCHEMA_V2_CHAT）。
//
// 整个项目只有本文件创建数据库连接；其它模块一律接收 db 参数，便于测试隔离。

import { DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync, mkdirSync, openSync, readSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKFLOW_SCHEMA, WORKFLOW_VERSION_SCHEMA, seedWorkflowTemplates } from './workflow-schema.mjs';

export const HERE = dirname(fileURLToPath(import.meta.url)); // web/lib
export const REPO_ROOT = resolve(HERE, '..', '..');
export const DEFAULT_DB_PATH = resolve(REPO_ROOT, 'data', 'agent-office.db');

const SCHEMA_VERSION = 10;

/**
 * v2（TASK-AgentChat V1）：聊天六张表，字段按任务书 §四，带 + 的为本实现补充的辅助列。
 *
 * 与 tasks / attempts / events 完全独立（ADR-03）：聊天只写这六张表，一行都不往任务三张表写。
 * 状态机 evaluateAgentStatuses 只读 attempts + events，所以它看不见聊天——普通聊天不会让
 * Agent 卡片从 unknown 变成 running，也不会挂到正在执行任务的 Session 上。
 *
 * 三个 ID 不许混（任务书 §四）：
 *   thread_id            Agent Office 自己的聊天编号（th-…）
 *   provider_session_id  Claude / DSH 真正的 Session ID（首轮建立后回填）
 *   turn_id              一次用户输入 + 对应执行的唯一编号（ct-…）
 * chat_turns.attempt_id 是「这一轮聊天的一次 CLI 调用」编号（ca-…），与任务表 attempts
 * 的 a-… 不是一回事；关联任务时另用 task_id / task_attempt_id 两列做只读引用。
 */
const SCHEMA_V2_CHAT = `
CREATE TABLE IF NOT EXISTS chat_threads (
  thread_id            TEXT PRIMARY KEY,
  agent_id             TEXT NOT NULL,
  provider_session_id  TEXT,
  workspace            TEXT,
  mode                 TEXT NOT NULL DEFAULT 'discuss',
  task_id              TEXT,
  task_attempt_id      TEXT,
  title                TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  message_id   TEXT PRIMARY KEY,
  thread_id    TEXT NOT NULL REFERENCES chat_threads(thread_id),
  turn_id      TEXT,
  role         TEXT NOT NULL,
  content      TEXT NOT NULL,
  status       TEXT NOT NULL,
  error_json   TEXT,
  seq          INTEGER NOT NULL,
  event_seq    INTEGER,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_turns (
  turn_id              TEXT PRIMARY KEY,
  thread_id            TEXT NOT NULL REFERENCES chat_threads(thread_id),
  attempt_id           TEXT NOT NULL,
  user_message_id      TEXT,
  assistant_message_id TEXT,
  status               TEXT NOT NULL,
  provider             TEXT NOT NULL,
  resume               INTEGER NOT NULL DEFAULT 0,
  retry_of_turn_id     TEXT,
  error_json           TEXT,
  started_at           TEXT,
  ended_at             TEXT,
  created_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_events (
  event_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id    TEXT NOT NULL REFERENCES chat_turns(turn_id),
  seq        INTEGER NOT NULL,
  type       TEXT NOT NULL,
  payload    TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (turn_id, seq)
);

CREATE TABLE IF NOT EXISTS chat_approvals (
  approval_id TEXT PRIMARY KEY,
  turn_id     TEXT NOT NULL REFERENCES chat_turns(turn_id),
  action      TEXT NOT NULL,
  decision    TEXT,
  decided_at  TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_summaries (
  thread_id       TEXT PRIMARY KEY REFERENCES chat_threads(thread_id),
  summary         TEXT NOT NULL,
  covered_turn_id TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_threads_agent  ON chat_threads(agent_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread_id, seq);
CREATE INDEX IF NOT EXISTS idx_chat_turns_thread    ON chat_turns(thread_id, created_at);
`;

/**
 * v3（TASK-转盘与Agent可添加 §2.2）：agents 表。
 *
 * 现有 claude / codex / dsh / hermes 四个 agent_id 原值迁移，历史 attempts /
 * chat_threads 里引用的 agent_id 不变，不迁历史数据。
 *
 * 在任务书字段之外补了一列 protocol（anthropic | openai）：§2.4 的 API 表单
 * 要求选协议，没有地方存就做不到「保存后按同一协议再调」。其余列严格按任务书。
 *
 * api_key 不落这张表：api_key_ref 只是引用（local:<agent_id> / ccswitch:<名称> /
 * env:<变量名>），真正的 key 由 web/lib/secrets.mjs 存在库外。
 */
const SCHEMA_V3_AGENTS = `
CREATE TABLE IF NOT EXISTS agents (
  agent_id     TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('cli', 'api', 'external')),
  enabled      INTEGER NOT NULL DEFAULT 1,
  sort_index   INTEGER NOT NULL DEFAULT 0,

  cli_command  TEXT,
  cli_args     TEXT,
  resume_flag  TEXT,

  base_url     TEXT,
  model        TEXT,
  protocol     TEXT,
  api_key_ref  TEXT,

  extra_env    TEXT,
  capabilities TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agents_enabled ON agents(enabled, sort_index, agent_id);
`;

/** 本机 DSH 的完整命令路径（任务书 §2.3 要求 cli_command 存完整路径）。 */
function defaultDshCommand() {
  if (process.env.DSH_BIN) return String(process.env.DSH_BIN);
  const local = process.env.LOCALAPPDATA
    || (process.env.USERPROFILE ? `${process.env.USERPROFILE}/AppData/Local` : null);
  if (local) {
    const known = `${String(local).replace(/\\/g, '/')}/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd`;
    try {
      if (existsSync(known)) return known;
    } catch { /* 目录不可读就退回 PATH */ }
  }
  return 'dsh';
}

/**
 * 四个历史 Agent 的初始配置。只 INSERT OR IGNORE：已有行绝不覆盖，
 * 以后用户在界面上改过的名字 / 命令 / 禁用状态不会被迁移冲掉。
 */
function seedAgents(db) {
  const at = new Date().toISOString();
  const rows = [
    {
      agent_id: 'claude', display_name: 'Claude Code', kind: 'cli', sort_index: 10,
      cli_command: 'claude', resume_flag: '--resume',
      capabilities: JSON.stringify({ chat: true, tools: true }),
    },
    {
      agent_id: 'codex', display_name: 'Codex', kind: 'cli', sort_index: 20,
      cli_command: 'codex', resume_flag: '--resume',
      capabilities: JSON.stringify({ chat: false, tools: true }),
    },
    {
      agent_id: 'dsh', display_name: 'DSH', kind: 'cli', sort_index: 30,
      cli_command: defaultDshCommand(), resume_flag: '--session-id',
      capabilities: JSON.stringify({ chat: true, tools: true }),
    },
    {
      agent_id: 'hermes', display_name: 'Hermes', kind: 'external', sort_index: 40,
      cli_command: null, resume_flag: null,
      capabilities: JSON.stringify({ chat: true, self_report: true }),
    },
  ];
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO agents (agent_id, display_name, kind, enabled, sort_index, ' +
    'cli_command, cli_args, resume_flag, base_url, model, protocol, api_key_ref, ' +
    'extra_env, capabilities, created_at, updated_at) ' +
    'VALUES (?, ?, ?, 1, ?, ?, NULL, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)',
  );
  for (const r of rows) {
    stmt.run(r.agent_id, r.display_name, r.kind, r.sort_index,
      r.cli_command, r.resume_flag, r.capabilities, at, at);
  }
}

/** 建表 SQL。用 IF NOT EXISTS，保证重复调用安全。
 * 字段严格按任务书 §2.1；带 + 注释的是本实现补充的辅助列/索引，
 * 只做增量，不改任务书点名的任何列。
 */
const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS tasks (
  task_id       TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  acceptance    TEXT,
  status        TEXT NOT NULL,
  status_reason TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  closed_at     TEXT
);

CREATE TABLE IF NOT EXISTS attempts (
  attempt_id    TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(task_id),
  agent_id      TEXT NOT NULL,
  status        TEXT NOT NULL,
  worktree_path TEXT,
  checkpoint_id TEXT,
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  end_reason    TEXT,
  pid           INTEGER,
  session_id    TEXT,
  relay_pending INTEGER NOT NULL DEFAULT 0,
  note          TEXT
);

CREATE TABLE IF NOT EXISTS events (
  event_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id         TEXT,
  attempt_id      TEXT,
  agent_id        TEXT,
  event_type      TEXT NOT NULL,
  payload         TEXT,
  evidence_source TEXT NOT NULL,
  observed_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL,
  attempt_id    TEXT NOT NULL,
  git_sha       TEXT,
  files         TEXT NOT NULL,
  untracked     TEXT,
  created_at    TEXT NOT NULL,
  label         TEXT
);

CREATE TABLE IF NOT EXISTS write_owner (
  worktree_path TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL,
  attempt_id    TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  acquired_at   TEXT NOT NULL,
  released_at   TEXT,
  heartbeat_at  TEXT
);

CREATE TABLE IF NOT EXISTS task_steps (
  task_id    TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  step_key   TEXT NOT NULL,
  name       TEXT,
  seq        INTEGER NOT NULL,
  status     TEXT NOT NULL,
  at         TEXT,
  note       TEXT,
  files      TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (task_id, step_key)
);

CREATE TABLE IF NOT EXISTS migrate_ledger (
  source_path TEXT PRIMARY KEY,
  sha256      TEXT NOT NULL,
  task_id     TEXT NOT NULL,
  migrated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_task      ON events(task_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_events_attempt   ON events(attempt_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_events_type      ON events(event_type, observed_at);
CREATE INDEX IF NOT EXISTS idx_attempts_task    ON attempts(task_id, started_at);
CREATE INDEX IF NOT EXISTS idx_attempts_agent   ON attempts(agent_id, started_at);
CREATE INDEX IF NOT EXISTS idx_checkpoints_task ON checkpoints(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_steps_task       ON task_steps(task_id, seq);
`;

/**
 * v4（TASK-转盘与Agent可添加 第二批）：工具级事件表。
 *
 * tool_events 是转盘左弧与刻度的唯一数据源，字段严格按任务书：
 *   id, agent_id, session_id, tool_name, target, ts, raw_json
 * id 是确定性哈希（来源+会话+调用 id），重复采集 INSERT OR IGNORE，不产生重复行。
 *
 * tool_event_sources 是采集器的增量账本（不是业务表）：记录每个源文件的
 * mtime/size/已读字节；Claude JSONL 只读新增行，DSH zstd 变了才整份重解压。
 */
const SCHEMA_V4_TOOL_EVENTS = `
CREATE TABLE IF NOT EXISTS tool_events (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL,
  session_id TEXT,
  tool_name  TEXT NOT NULL,
  target     TEXT,
  ts         TEXT NOT NULL,
  raw_json   TEXT
);

CREATE TABLE IF NOT EXISTS tool_event_sources (
  source_path TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  session_id  TEXT,
  size        INTEGER NOT NULL DEFAULT 0,
  mtime_ms    INTEGER NOT NULL DEFAULT 0,
  byte_offset INTEGER NOT NULL DEFAULT 0,
  collected_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_events_agent ON tool_events(agent_id, ts);
CREATE INDEX IF NOT EXISTS idx_tool_events_tool  ON tool_events(tool_name, ts);
CREATE INDEX IF NOT EXISTS idx_tool_events_ts    ON tool_events(ts);
`;

/**
 * v5（TASK-交付物视图与工作流编排 第一批）：deliverables 交付物表。
 *
 * 任务书 1.1 的结构，一处必要偏离：task_id 允许 NULL。任务书要求
 * 「匹配不上就挂到未关联交付物区，不许硬塞给某个任务」——如果 task_id
 * NOT NULL，就只能编一个假任务 id 或塞给随便一个任务，两者都违反铁律。
 * NULL 在这里有明确语义：未关联。其余列与任务书一致。
 *
 * deliverable_id 由采集器按 (kind, task_id, 来源) 生成确定性 ID，
 * 同一份真实来源重复采集不会产生重复行。
 */
const SCHEMA_V5_DELIVERABLES = `
CREATE TABLE IF NOT EXISTS deliverables (
  deliverable_id TEXT PRIMARY KEY,
  task_id        TEXT,
  attempt_id     TEXT,
  kind           TEXT NOT NULL CHECK (kind IN ('requirement','task_spec','dev_output',
                                                'artifact','review','retro','goal_report')),
  title          TEXT NOT NULL,
  path           TEXT,
  content_ref    TEXT,
  status         TEXT NOT NULL CHECK (status IN ('draft','submitted','accepted','rejected')),
  created_by     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(task_id)
);

CREATE INDEX IF NOT EXISTS idx_deliverables_task ON deliverables(task_id, kind, created_at);
CREATE INDEX IF NOT EXISTS idx_deliverables_kind ON deliverables(kind, created_at);
`;

// v10（TASK-COMPANY-D0 · AI 公司组织架构骨架）：
// 概念模型（Leo 定的，不许改）：员工 ≠ 工具。agents 表的 6 行是「工具」（能力 harness），
// 员工是组织成员，靠 employee_tools 授权去调用工具。五张表：
//   departments      部门（职能容器，负责人可空 = 助理兼任）
//   employees        员工（is_assistant=1 是老板的助理；status 软删）
//   employee_tools   员工能用哪些工具（授权，指向 agents 表）
//   work_items       任务（D0 核心：交办 → 派给 → 执行 → 交付 → 验收）
//   work_executions  执行记录（一任务多次执行；同时挂任务 + 员工 + 工具）
// 另给 workflow_runs 补 department_id（存量全部填 'dev'，研发部）。
// 读写函数在 web/lib/company.mjs；API 在 web/api-company.mjs。
const SCHEMA_V10_COMPANY = `
CREATE TABLE IF NOT EXISTS departments (
  department_id TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  duty          TEXT NOT NULL DEFAULT '',
  color         TEXT NOT NULL DEFAULT '#2563eb',
  manager_employee_id TEXT,
  sort_index    INTEGER NOT NULL DEFAULT 0,
  archived_at   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS employees (
  employee_id   TEXT PRIMARY KEY,
  department_id TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL,
  duty          TEXT NOT NULL DEFAULT '',
  resume        TEXT NOT NULL DEFAULT '',
  is_assistant  INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active',
  sort_index    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  FOREIGN KEY (department_id) REFERENCES departments(department_id)
);

CREATE TABLE IF NOT EXISTS employee_tools (
  employee_id TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  permission  TEXT NOT NULL DEFAULT 'use',
  created_at  TEXT NOT NULL,
  PRIMARY KEY (employee_id, agent_id)
);

CREATE TABLE IF NOT EXISTS work_items (
  work_id       TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  what_to_deliver TEXT NOT NULL DEFAULT '',
  acceptance    TEXT NOT NULL DEFAULT '',
  department_id TEXT,
  project_id    TEXT,
  owner_employee_id TEXT,
  assigned_by   TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  status_reason TEXT NOT NULL DEFAULT '',
  input_refs    TEXT NOT NULL DEFAULT '[]',
  output_refs   TEXT NOT NULL DEFAULT '[]',
  due_at        TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_work_owner ON work_items(owner_employee_id, status);
CREATE INDEX IF NOT EXISTS idx_work_dept ON work_items(department_id, status);

CREATE TABLE IF NOT EXISTS work_executions (
  execution_id  TEXT PRIMARY KEY,
  work_id       TEXT NOT NULL,
  employee_id   TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'running',
  command       TEXT NOT NULL DEFAULT '',
  log_path      TEXT,
  result_summary TEXT NOT NULL DEFAULT '',
  error         TEXT NOT NULL DEFAULT '',
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  FOREIGN KEY (work_id) REFERENCES work_items(work_id)
);
CREATE INDEX IF NOT EXISTS idx_exec_work ON work_executions(work_id, started_at);
`;

/**
 * v10 预置数据（任务书 §2.1 指定的真实初始状态）：
 * 4 个部门（营销部 manager 为空 = 助理兼任）+ 2 名员工（Hermes 助理归人事部、Claude 工程师）
 * + 3 条工具授权（Claude 能用 claude 和 dsh —— 体现「员工可以换工具」）。
 * 固定主键 + INSERT OR IGNORE：重跑不重复、不覆盖后来改过的行。
 */
function seedCompany(db) {
  const now = new Date().toISOString();
  const tx = db.prepare('INSERT OR IGNORE INTO departments ' +
    '(department_id, name, duty, color, manager_employee_id, sort_index, created_at, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  tx.run('dev', '研发部', '做项目、做产品', '#2563eb', 'emp-hermes', 0, now, now);
  tx.run('mkt', '营销部', '推广、做视频、做内容', '#7c3aed', null, 1, now, now);
  tx.run('hr', '人事部', '员工生命周期管理', '#059669', 'emp-hermes', 2, now, now);
  tx.run('asset', '资产部', '资料、数据与成果管理', '#d97706', 'emp-hermes', 3, now, now);

  const te = db.prepare('INSERT OR IGNORE INTO employees ' +
    '(employee_id, department_id, name, role, duty, resume, is_assistant, status, sort_index, created_at, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  // Hermes 归人事部（它兼任人事），但它是助理，不是普通人事员工
  te.run('emp-hermes', 'hr', 'Hermes', '总经理助理',
    '接收老板交办、拆解任务、派给员工、跟踪进度、汇报结果',
    'Leo 的技术搭档，负责需求拆解、派活、验收汇总', 1, 'active', 0, now, now);
  te.run('emp-claude', 'dev', 'Claude', '研发工程师',
    '写代码、改代码、自测', '研发部执行工程师', 0, 'active', 1, now, now);

  const tt = db.prepare('INSERT OR IGNORE INTO employee_tools (employee_id, agent_id, permission, created_at) ' +
    'VALUES (?, ?, ?, ?)');
  tt.run('emp-hermes', 'hermes', 'use', now);
  tt.run('emp-claude', 'claude', 'use', now);
  tt.run('emp-claude', 'dsh', 'use', now);
}

/** 迁移清单：以后加表/加列时追加一项，版本号递增，已有库只跑增量。 */
const MIGRATIONS = [
  { version: 1, up(db) { db.exec(SCHEMA_V1); } },
  { version: 2, up(db) { db.exec(SCHEMA_V2_CHAT); } },
  { version: 3, up(db) { db.exec(SCHEMA_V3_AGENTS); seedAgents(db); } },
  { version: 4, up(db) { db.exec(SCHEMA_V4_TOOL_EVENTS); } },
  { version: 5, up(db) { db.exec(SCHEMA_V5_DELIVERABLES); } },
  // v6（P0 第一步数据层，docs/工作流定义-v3-定稿.md）：
  // 工作流模板 / 运行实例 / 运行步骤三张表，并预置 coding-v1 模板。
  // 表结构与预置内容在 web/lib/workflow-schema.mjs，读写函数在 workflow-db.mjs。
  { version: 6, up(db) { db.exec(WORKFLOW_SCHEMA); seedWorkflowTemplates(db); } },
  // v7（P0 第二步）：模板历史版本表。PUT 更新前把旧行抄进历史，旧版本可继续查。
  { version: 7, up(db) { db.exec(WORKFLOW_VERSION_SCHEMA); } },
  // v8（TASK-任务归档/删除/恢复）：tasks 加三列 + 两个索引。
  //
  // 铁律：只 ALTER TABLE ADD COLUMN，不删表重建，历史任务行一行不动。
  //   archived_at   归档时间（NULL=未归档）；归档只写它，不改 status
  //   archived_from 归档前的状态；恢复时用它还原（A5/A6）
  //   deleted_at    软删时间（NULL=未删除）；行保留，列表默认不返回
  // ADD COLUMN 不支持 IF NOT EXISTS，用 PRAGMA 判断列是否已在——旧库/半迁移库
  // 重复执行也安全（迁移版本本身只跑一次，这里是第二道保险）。
  {
    version: 8,
    up(db) {
      const cols = new Set(allRows(db, 'PRAGMA table_info(tasks)').map((c) => c.name));
      if (!cols.has('archived_at')) db.exec('ALTER TABLE tasks ADD COLUMN archived_at TEXT');
      if (!cols.has('archived_from')) db.exec('ALTER TABLE tasks ADD COLUMN archived_from TEXT');
      if (!cols.has('deleted_at')) db.exec('ALTER TABLE tasks ADD COLUMN deleted_at TEXT');
      db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_archived ON tasks(archived_at)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_deleted  ON tasks(deleted_at)');
    },
  },
  // v9（TASK-tasks 挂到工作流步骤）：tasks 加两列 + 一个联合索引。
  //
  // Leo 的口径：工作流是固定的九步，任务每次不同。任务要能回答「属于哪次需求、九步里的哪一步」：
  //   workflow_run_id   属于哪次需求（workflow_runs.run_id）；NULL = 不属于任何工作流
  //   workflow_step_id  属于九步中的哪一步（workflow_run_steps.step_id，如 '05'）；NULL = 没挂到步骤
  // 同 v8：只 ALTER TABLE ADD COLUMN，不删表重建，历史任务行一行不动、两列为 NULL。
  // 两列不加外键——run / step 是否真实存在由 API 层在建任务时校验（web/api-tasks.mjs），
  // 这样 run 的归档 / 模板升级不会反过来卡住任务表的写入。
  {
    version: 9,
    up(db) {
      const cols = new Set(allRows(db, 'PRAGMA table_info(tasks)').map((c) => c.name));
      if (!cols.has('workflow_run_id')) db.exec('ALTER TABLE tasks ADD COLUMN workflow_run_id TEXT');
      if (!cols.has('workflow_step_id')) db.exec('ALTER TABLE tasks ADD COLUMN workflow_step_id TEXT');
      db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_workflow ON tasks(workflow_run_id, workflow_step_id)');
    },
  },
  // v10（TASK-COMPANY-D0）：公司五张表 + 预置 4 部门 / 2 员工 / 3 条工具授权；
  // workflow_runs 补 department_id，存量 4 条全部挂研发部（dev）。
  // 同 v8/v9 的口径：只 ALTER TABLE ADD COLUMN + UPDATE 补值，不重建表，存量行不动。
  // 防御：极老库可能还没有 workflow_runs 表（v8 前的形状），跳过挂部门列而不是炸迁移。
  {
    version: 10,
    up(db) {
      db.exec(SCHEMA_V10_COMPANY);
      seedCompany(db);
      const cols = new Set(allRows(db, 'PRAGMA table_info(workflow_runs)').map((c) => c.name));
      if (cols.size > 0 && !cols.has('department_id')) {
        db.exec('ALTER TABLE workflow_runs ADD COLUMN department_id TEXT');
        db.exec("UPDATE workflow_runs SET department_id = 'dev' WHERE department_id IS NULL");
      }
    },
  },
];

/** 已打开的连接缓存：同一个 db 文件在一个进程里只建一个连接。 */
const cache = new Map();

/** 撞锁时最多等多久。busy_timeout 交给 SQLite 自己等；切 WAL 那一步 SQLite 不吃它，由 enableWal 自己等同样长。 */
const BUSY_TIMEOUT_MS = 5000;

export function resolveDbPath(p) {
  return resolve(p || process.env.AGENT_OFFICE_DB || DEFAULT_DB_PATH);
}

/** 同步睡一小会儿（openDb 是同步的，不能 await）。Node 的主线程允许 Atomics.wait。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 是不是「撞锁」：SQLite 的 busy handler 没等到（或根本没被调用）时抛出来的那种错。 */
function isLockedError(err) {
  if (!err) return false;
  // errcode 5 = SQLITE_BUSY，6 = SQLITE_LOCKED；拿不到 errcode（版本差异）时按消息文本判
  if (err.errcode === 5 || err.errcode === 6) return true;
  return /database is locked/i.test(String(err.message || ''));
}

/**
 * 库文件是不是已经是 WAL 模式：看文件头第 18 / 19 字节（写 / 读格式版本，2 = WAL）。
 * 空文件、文件不存在、读不到，一律当作「还不是」——宁可多跑一次切换，也不凭猜测跳过。
 */
function isWalFile(path) {
  let fd = null;
  try {
    fd = openSync(path, 'r');
    const head = Buffer.alloc(20);
    if (readSync(fd, head, 0, 20, 0) < 20) return false;
    return head[18] === 2 && head[19] === 2;
  } catch {
    return false;
  } finally {
    if (fd != null) {
      try { closeSync(fd); } catch { /* 关不上不影响判断 */ }
    }
  }
}

/**
 * 把库切到 WAL，并且在别的进程正好也在首开时等得起。
 *
 * 为什么不能只靠 busy_timeout：切 WAL 要改写文件头，SQLite 为此要在「自己已经拿着读锁」的
 * 状态下去拿写锁。这时如果别的进程正拿着写锁，SQLite 为了避免死锁会**直接**返回 SQLITE_BUSY，
 * 不调用 busy handler——busy_timeout 设多大都没用。多个进程同时第一次打开同一个（还不存在的）
 * 库时，晚到一步的那个就会这样报 database is locked（实测 10 个服务同时首开：20 个首请求里
 * 2 ~ 8 个 500，全部出在这一句）。
 *
 * 两道处理：
 *   1. 文件已经是 WAL 就根本不碰 journal_mode（线上库、绝大多数测试打开的都是这种）；
 *   2. 确实要切（新库 / 旧模式库）又撞上了，就退让重试，直到切成为止或超过 busy_timeout。
 *      第一个切完之后，后面的进程再读文件头已经是 WAL，同一条 PRAGMA 立刻返回、不再要独占锁。
 */
function enableWal(db, path) {
  if (isWalFile(path)) return;
  const deadline = Date.now() + BUSY_TIMEOUT_MS;
  for (;;) {
    try {
      db.exec('PRAGMA journal_mode = WAL');
      return;
    } catch (err) {
      if (!isLockedError(err) || Date.now() >= deadline) throw err;
      // 退让一小段再试（带一点随机，免得几个进程步调一致地反复同时撞）
      sleepSync(15 + Math.floor(Math.random() * 40));
    }
  }
}

/**
 * 打开（或新建）数据库并建表。
 * @param {{path?: string, memory?: boolean}} opts
 */
export function openDb(opts = {}) {
  const path = opts.memory ? ':memory:' : resolveDbPath(opts.path);
  if (!opts.memory) mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);
  // busy_timeout 要在任何会抢锁的语句之前设：它是这条连接后面所有读写（包括迁移事务）的排队上限。
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  // WAL：读写不互相堵。
  enableWal(db, path);
  db.exec('PRAGMA foreign_keys = ON');
  applyMigrations(db);

  if (!opts.memory) cache.set(path, db);
  return db;
}

/** 取进程级单例连接（server / api 用）。 */
export function getDb(opts = {}) {
  const path = resolveDbPath(opts.path);
  const hit = cache.get(path);
  if (hit) return hit;
  return openDb({ ...opts, path });
}

/** 关闭连接并从缓存里移除（测试模拟「重启」时用）。 */
export function closeDb(db) {
  if (!db) return;
  for (const [path, cached] of cache.entries()) {
    if (cached === db) cache.delete(path);
  }
  try { db.close(); } catch { /* 已关闭 */ }
}

/** 主键/事件查询用；避免 sqlite 返回 null-prototype 对象时断言库比较别扭。 */
export function plain(row) {
  return row ? { ...row } : row;
}

/** 执行一段只读查询并返回普通对象数组。 */
export function allRows(db, sql, params = []) {
  return db.prepare(sql).all(...params).map((r) => ({ ...r }));
}

export function getRow(db, sql, params = []) {
  const row = db.prepare(sql).get(...params);
  return row ? { ...row } : null;
}

/**
 * 建表版本；幂等，并且跨进程串行。
 *
 * 已经是最新版本的库（线上库、绝大多数次打开）：只读一下版本号就返回，不写任何东西。
 * 有版本要迁时，每个版本各占一个 BEGIN IMMEDIATE 事务（走下面的 transaction()）：拿到写锁之后
 * 在事务里重读 schema_version，别的进程已经迁过这一版就什么都不做。不这样做的话，多个进程
 * 同时首开同一个库会各跑一遍同样的迁移、互相撞出 database is locked。
 * 按版本分事务、进事务后重读版本，而不是把整串迁移包成一个大事务：
 *   - 别的进程迁到一半就退出了，接手的进程从它停下的那一版继续，不重跑也不漏跑；
 *   - 迁移内容和「版本号 +1」永远一起提交，不会出现「表建了、版本没记」的半截库。
 *
 * 前提：MIGRATIONS 里任何一版的 up() 都不自己开事务（否则和这里的 BEGIN 嵌套会报错）。
 * 现有 v1–v9 都只有 CREATE / ALTER / INSERT，满足这个前提。
 */
export function applyMigrations(db) {
  // 表已经在了时这条语句不写库；新库上多个进程同时建它，靠前面设好的 busy_timeout 排队。
  db.exec('CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const readVersion = () => {
    const row = getRow(db, 'SELECT value FROM schema_meta WHERE key = ?', ['schema_version']);
    return row ? Number(row.value) || 0 : 0;
  };
  const current = readVersion();
  if (current >= SCHEMA_VERSION) return { version: current };

  for (const m of MIGRATIONS) {
    transaction(db, () => {
      // 拿到写锁之后再读一次：别的进程可能刚刚迁过这一版。
      if (m.version <= readVersion()) return;
      m.up(db);
      db.prepare(
        'INSERT INTO schema_meta (key, value) VALUES (?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).run('schema_version', String(m.version));
    });
  }
  return { version: readVersion() };
}

/** 每个连接当前嵌套在第几层事务里（弱引用：连接对象回收后这一项跟着没了）。 */
const txDepth = new WeakMap();

/**
 * 事务包装：最外层 BEGIN IMMEDIATE 保证抢锁语义；嵌套调用落成 SAVEPOINT。
 * 异常统一回滚（内层只撤自己那一段，并把错误原样抛给外层），不吞错。
 *
 * 可以嵌套：一个操作要原子地做「校验 → 调一个自己会开事务的函数 → 自己的写入」时，
 * 外面直接再包一层就行，不用为了避开嵌套 BEGIN 把顺序拆开再写补偿代码。
 * 例：声明一次执行 = 查任务是否已删除 → acquireWriteOwner（内部有事务）→ createAttempt，
 * 三步必须同生同死（web/api-tasks.mjs 的 attempt 路由）。
 * 注意：这里只认得出经本函数开的事务；别处手写 db.exec('BEGIN …') 之后再调它，
 * 仍然会撞上 SQLite 的「不能在事务里开事务」——和以前一样。
 */
export function transaction(db, fn) {
  const depth = txDepth.get(db) || 0;
  const savepoint = `tx_sp_${depth}`;
  db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
  txDepth.set(db, depth + 1);
  try {
    const out = fn();
    txDepth.set(db, depth);
    db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
    return out;
  } catch (err) {
    txDepth.set(db, depth);
    try {
      db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}`);
      if (depth > 0) db.exec(`RELEASE ${savepoint}`);
    } catch { /* 回滚失败不掩盖原错误 */ }
    throw err;
  }
}

export { SCHEMA_VERSION };
