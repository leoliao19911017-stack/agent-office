// company.mjs — TASK-COMPANY-D0 数据层：组织（部门 / 员工 / 工具授权）+ 任务 + 执行 + 助理汇报。
//
// 概念模型（Leo 定的，不许改）：员工 ≠ 工具。agents 表是「工具」（能力 harness），
// employees 是组织成员，employee_tools 是授权。表结构在 db.mjs 的 v10 迁移里建。
//
// 本模块只做数据和校验，不碰 HTTP：所有「不合法」都以带 statusCode / code 的 Error
// 抛出（和 httpError 同构），api-company.mjs 原样透传。所有写操作都在调用方给的
// db 连接上单条语句完成（SQLite 同库写天然串行）；需要「校验 + 写入」原子的地方
// 用 db.mjs 的 transaction() 包一层。
//
// 助理汇报的铁律（Codex 定的，必须遵守）：
//   ① 汇报数据 100% 从数据库真实状态聚合，不许模型生成；
//   ② 模型只能组织语言，不能编事实；
//   ③ 三种误报必须防（本模块在 assistantReport 里落实）：
//      - delivered 但没有 output_refs → 进 verify_pending（「待核验」），不进 delivered；
//      - running 执行心跳超时 → 显示「状态待确认」，不显示「正在工作」；
//      - 没有本周目标 → week_goals 为空数组，前端显示「尚无目标」，不显示 0%。

import { randomBytes } from 'node:crypto';
import { allRows, getRow, transaction } from './db.mjs';

/** work_items.status 的中文口径（列表 / 汇报 / 前端共用一份）。 */
export const WORK_STATUS_LABEL = {
  pending: '待启动',
  running: '进行中',
  delivered: '已交付',
  accepted: '已验收',
  rejected: '已退回',
  blocked: '受阻',
};

/** 「未完成」= 还会有下文的那些状态；部门 / 员工归档前检查用。accepted 是唯一终态。 */
const UNFINISHED_WORK_SQL = "('pending','running','delivered','rejected','blocked')";

/**
 * running 执行的心跳超时口径：started_at 距今超过 30 分钟还没有 ended_at，
 * 就不能再汇报成「正在工作」，只能「状态待确认」（铁律③-2）。
 * D0 没有心跳表，用 started_at 近似——宁可保守判超时，不假装在干活。
 */
export const RUNNING_STALE_MS = 30 * 60 * 1000;

/** 「x 分钟」式的时间差描述（汇报依据行用，只算不猜）。 */
function runningAgeText(iso, now = Date.now()) {
  const ms = Math.max(0, now - Date.parse(iso));
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} 分钟`;
  return `${Math.floor(min / 60)} 小时 ${min % 60} 分钟`;
}

/** 业务错误：带 HTTP 语义抛给 API 层。 */
function fail(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

/** 生成行 ID：前缀 + 本地时间戳 + 6 位随机 hex（与 tasks 表 t-20261124…-8a75cd 同款式）。 */
function makeId(prefix) {
  const ts = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${ts.getFullYear()}${p(ts.getMonth() + 1)}${p(ts.getDate())}${p(ts.getHours())}${p(ts.getMinutes())}${p(ts.getSeconds())}`;
  return `${prefix}-${stamp}-${randomBytes(3).toString('hex')}`;
}

const nowIso = () => new Date().toISOString();

/** 安全解析 JSON 列（input_refs / output_refs）；坏值当空数组，不让脏数据炸掉整个接口。 */
function parseJsonArray(text) {
  if (!text) return [];
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

// ---------------------------------------------------------------------------
// 组织：部门
// ---------------------------------------------------------------------------

/** 部门行 → 接口形态（带负责人姓名、在职员工数）。 */
function decorateDepartment(row) {
  return row ? {
    department_id: row.department_id,
    name: row.name,
    duty: row.duty || '',
    color: row.color || '#2563eb',
    manager_employee_id: row.manager_employee_id || null,
    manager_name: row.manager_name || null,
    // manager 为空 = 助理兼任（任务书 §2.1：界面显示「由助理兼任 · 暂无专职员工」）
    managed_by_assistant: !row.manager_employee_id,
    employee_count: row.employee_count ?? 0,
    sort_index: row.sort_index,
    archived_at: row.archived_at || null,
  } : null;
}

const DEPARTMENT_SELECT = `
  SELECT d.*, m.name AS manager_name,
    (SELECT COUNT(*) FROM employees e
      WHERE e.department_id = d.department_id AND e.status = 'active') AS employee_count
  FROM departments d LEFT JOIN employees m ON m.employee_id = d.manager_employee_id`;

export function listDepartments(db, { includeArchived = false } = {}) {
  const sql = DEPARTMENT_SELECT
    + (includeArchived ? '' : ' WHERE d.archived_at IS NULL')
    + ' ORDER BY d.sort_index, d.department_id';
  return allRows(db, sql).map(decorateDepartment);
}

export function getDepartment(db, id) {
  return decorateDepartment(getRow(db, `${DEPARTMENT_SELECT} WHERE d.department_id = ?`, [id]));
}

export function createDepartment(db, input) {
  const name = isNonEmptyString(input.name) ? input.name.trim() : '';
  if (!name) throw fail(400, 'MISSING_NAME', '部门名称不能为空');
  const duty = isNonEmptyString(input.duty) ? input.duty.trim() : '';
  const manager = isNonEmptyString(input.manager_employee_id) ? input.manager_employee_id.trim() : null;
  if (manager && !getRow(db, "SELECT employee_id FROM employees WHERE employee_id = ? AND status = 'active'", [manager])) {
    throw fail(400, 'MANAGER_NOT_FOUND', `负责人不存在或已归档：${manager}`);
  }
  if (getRow(db, 'SELECT department_id FROM departments WHERE name = ? AND archived_at IS NULL', [name])) {
    throw fail(409, 'DEPARTMENT_NAME_TAKEN', `部门名称已存在：${name}`);
  }
  const id = makeId('dept');
  const now = nowIso();
  transaction(db, () => {
    db.prepare(`INSERT INTO departments
      (department_id, name, duty, color, manager_employee_id, sort_index, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, name, duty, '#2563eb', manager, 0, now, now);
  });
  return getDepartment(db, id);
}

export function updateDepartment(db, id, patch) {
  const row = getRow(db, 'SELECT * FROM departments WHERE department_id = ?', [id]);
  if (!row || row.archived_at) throw fail(404, 'DEPARTMENT_NOT_FOUND', `部门不存在或已归档：${id}`);
  const next = {
    name: isNonEmptyString(patch.name) ? patch.name.trim() : row.name,
    duty: isNonEmptyString(patch.duty) ? patch.duty.trim() : row.duty,
    manager_employee_id: patch.manager_employee_id !== undefined
      ? (isNonEmptyString(patch.manager_employee_id) ? patch.manager_employee_id.trim() : null)
      : row.manager_employee_id,
  };
  if (getRow(db, 'SELECT department_id FROM departments WHERE name = ? AND department_id != ? AND archived_at IS NULL', [next.name, id])) {
    throw fail(409, 'DEPARTMENT_NAME_TAKEN', `部门名称已存在：${next.name}`);
  }
  if (next.manager_employee_id
    && !getRow(db, "SELECT employee_id FROM employees WHERE employee_id = ? AND status = 'active'", [next.manager_employee_id])) {
    throw fail(400, 'MANAGER_NOT_FOUND', `负责人不存在或已归档：${next.manager_employee_id}`);
  }
  transaction(db, () => {
    db.prepare('UPDATE departments SET name = ?, duty = ?, manager_employee_id = ?, updated_at = ? WHERE department_id = ?')
      .run(next.name, next.duty, next.manager_employee_id, nowIso(), id);
  });
  return getDepartment(db, id);
}

export function archiveDepartment(db, id) {
  const row = getRow(db, 'SELECT * FROM departments WHERE department_id = ?', [id]);
  if (!row) throw fail(404, 'DEPARTMENT_NOT_FOUND', `部门不存在：${id}`);
  if (row.archived_at) return getDepartment(db, id);
  // 预置部门（dev/mkt/hr/asset）是组织骨架，D0 不许归档，否则初始员工挂着悬空外键
  if (['dev', 'mkt', 'hr', 'asset'].includes(id)) {
    throw fail(409, 'DEPARTMENT_IS_PRESET', `预置部门不能归档：${row.name}`);
  }
  const active = getRow(db,
    `SELECT COUNT(*) AS n FROM work_items WHERE department_id = ? AND status IN ${UNFINISHED_WORK_SQL}`, [id]);
  if (active.n > 0) {
    throw fail(409, 'DEPARTMENT_HAS_ACTIVE_WORK', `部门还有 ${active.n} 件未完结任务，先处理再归档`);
  }
  const employees = getRow(db,
    "SELECT COUNT(*) AS n FROM employees WHERE department_id = ? AND status = 'active'", [id]);
  if (employees.n > 0) {
    throw fail(409, 'DEPARTMENT_HAS_EMPLOYEES', `部门还有 ${employees.n} 名在职员工，先转移再归档`);
  }
  transaction(db, () => {
    db.prepare('UPDATE departments SET archived_at = ?, updated_at = ? WHERE department_id = ?')
      .run(nowIso(), nowIso(), id);
  });
  return getDepartment(db, id);
}

// ---------------------------------------------------------------------------
// 组织：员工 + 工具授权
// ---------------------------------------------------------------------------

/** 员工的工具授权（按 agents.sort_index 排：第一个就是「默认工具」）。 */
function toolsOf(db, employeeId) {
  return allRows(db, `
    SELECT a.agent_id, a.display_name, a.kind, a.enabled
    FROM employee_tools et JOIN agents a ON a.agent_id = et.agent_id
    WHERE et.employee_id = ?
    ORDER BY a.sort_index, a.agent_id`, [employeeId]);
}

function decorateEmployee(db, row) {
  if (!row) return null;
  return {
    employee_id: row.employee_id,
    department_id: row.department_id,
    department_name: row.department_name || null,
    name: row.name,
    role: row.role,
    duty: row.duty || '',
    resume: row.resume || '',
    is_assistant: Number(row.is_assistant) === 1,
    status: row.status,
    sort_index: row.sort_index,
    tools: toolsOf(db, row.employee_id),
    archived_at: row.archived_at || null,
    // employees 表没有单独的归档列：status='archived' 即软删（任务书 §2.1）
  };
}

const EMPLOYEE_SELECT = `
  SELECT e.*, d.name AS department_name
  FROM employees e LEFT JOIN departments d ON d.department_id = e.department_id`;

export function listEmployees(db, { departmentId, includeArchived = false } = {}) {
  const conds = [];
  const params = [];
  if (!includeArchived) conds.push("e.status = 'active'");
  if (departmentId) { conds.push('e.department_id = ?'); params.push(departmentId); }
  const sql = EMPLOYEE_SELECT + (conds.length ? ` WHERE ${conds.join(' AND ')}` : '')
    + ' ORDER BY e.sort_index, e.employee_id';
  return allRows(db, sql, params).map((r) => decorateEmployee(db, r));
}

export function getEmployee(db, id) {
  const row = getRow(db, `${EMPLOYEE_SELECT} WHERE e.employee_id = ?`, [id]);
  if (!row) return null;
  return decorateEmployee(db, row);
}

/** 校验一批 agent_id 都真实存在（不要求 enabled：授权先给，启用是资源页的事）。 */
function assertAgentsExist(db, agentIds) {
  for (const a of agentIds) {
    if (!getRow(db, 'SELECT agent_id FROM agents WHERE agent_id = ?', [a])) {
      throw fail(400, 'AGENT_NOT_FOUND', `工具不存在：${a}`);
    }
  }
}

export function createEmployee(db, input) {
  const name = isNonEmptyString(input.name) ? input.name.trim() : '';
  const role = isNonEmptyString(input.role) ? input.role.trim() : '';
  const deptId = isNonEmptyString(input.department_id) ? input.department_id.trim() : '';
  if (!name) throw fail(400, 'MISSING_NAME', '员工姓名不能为空');
  if (!role) throw fail(400, 'MISSING_ROLE', '岗位不能为空');
  const dept = getRow(db, 'SELECT * FROM departments WHERE department_id = ?', [deptId]);
  if (!dept || dept.archived_at) throw fail(400, 'DEPARTMENT_NOT_FOUND', `部门不存在或已归档：${deptId}`);
  const toolIds = Array.isArray(input.tool_ids) ? input.tool_ids.filter(isNonEmptyString) : [];
  assertAgentsExist(db, toolIds);

  const id = makeId('emp');
  const now = nowIso();
  transaction(db, () => {
    db.prepare(`INSERT INTO employees
      (employee_id, department_id, name, role, duty, resume, is_assistant, status, sort_index, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, 'active', ?, ?, ?)`)
      .run(id, deptId, name, role,
        isNonEmptyString(input.duty) ? input.duty.trim() : '',
        isNonEmptyString(input.resume) ? input.resume.trim() : '',
        0, now, now);
    const grant = db.prepare('INSERT OR IGNORE INTO employee_tools (employee_id, agent_id, permission, created_at) VALUES (?, ?, ?, ?)');
    for (const a of toolIds) grant.run(id, a, 'use', now);
  });
  return getEmployee(db, id);
}

export function updateEmployee(db, id, patch) {
  const row = getRow(db, 'SELECT * FROM employees WHERE employee_id = ?', [id]);
  if (!row || row.status !== 'active') throw fail(404, 'EMPLOYEE_NOT_FOUND', `员工不存在或已归档：${id}`);
  const next = {
    name: isNonEmptyString(patch.name) ? patch.name.trim() : row.name,
    role: isNonEmptyString(patch.role) ? patch.role.trim() : row.role,
    duty: isNonEmptyString(patch.duty) ? patch.duty.trim() : row.duty,
    resume: isNonEmptyString(patch.resume) ? patch.resume.trim() : row.resume,
    department_id: isNonEmptyString(patch.department_id) ? patch.department_id.trim() : row.department_id,
  };
  const dept = getRow(db, 'SELECT * FROM departments WHERE department_id = ?', [next.department_id]);
  if (!dept || dept.archived_at) throw fail(400, 'DEPARTMENT_NOT_FOUND', `部门不存在或已归档：${next.department_id}`);
  const toolIds = Array.isArray(patch.tool_ids) ? patch.tool_ids.filter(isNonEmptyString) : null;
  if (toolIds) assertAgentsExist(db, toolIds);

  const now = nowIso();
  transaction(db, () => {
    db.prepare('UPDATE employees SET name = ?, role = ?, duty = ?, resume = ?, department_id = ?, updated_at = ? WHERE employee_id = ?')
      .run(next.name, next.role, next.duty, next.resume, next.department_id, now, id);
    if (toolIds) {
      db.prepare('DELETE FROM employee_tools WHERE employee_id = ?').run(id);
      const grant = db.prepare('INSERT OR IGNORE INTO employee_tools (employee_id, agent_id, permission, created_at) VALUES (?, ?, ?, ?)');
      for (const a of toolIds) grant.run(id, a, 'use', nowIso());
    }
  });
  return getEmployee(db, id);
}

export function archiveEmployee(db, id) {
  const row = getRow(db, 'SELECT * FROM employees WHERE employee_id = ?', [id]);
  if (!row) throw fail(404, 'EMPLOYEE_NOT_FOUND', `员工不存在：${id}`);
  if (row.status !== 'active') return getEmployee(db, id);
  // 助理是老板的唯一入口，D0 不许归档（归档了交办就没接收人了）
  if (Number(row.is_assistant) === 1) {
    throw fail(409, 'EMPLOYEE_IS_ASSISTANT', '助理不能归档（D0 只有这一名助理）');
  }
  const active = getRow(db,
    `SELECT COUNT(*) AS n FROM work_items WHERE owner_employee_id = ? AND status IN ('pending','running','delivered')`, [id]);
  if (active.n > 0) {
    throw fail(409, 'EMPLOYEE_HAS_RUNNING_WORK', `员工还有 ${active.n} 件未完结任务（待启动/进行中/已交付），先处理再归档`);
  }
  transaction(db, () => {
    db.prepare("UPDATE employees SET status = 'archived', updated_at = ? WHERE employee_id = ?").run(nowIso(), id);
  });
  return getEmployee(db, id);
}

export function grantTool(db, employeeId, agentId, permission = 'use') {
  const emp = getRow(db, 'SELECT * FROM employees WHERE employee_id = ?', [employeeId]);
  if (!emp || emp.status !== 'active') throw fail(404, 'EMPLOYEE_NOT_FOUND', `员工不存在或已归档：${employeeId}`);
  if (!isNonEmptyString(agentId)) throw fail(400, 'MISSING_AGENT_ID', '缺少 agent_id');
  if (!getRow(db, 'SELECT agent_id FROM agents WHERE agent_id = ?', [agentId])) {
    throw fail(400, 'AGENT_NOT_FOUND', `工具不存在：${agentId}`);
  }
  if (!['use', 'admin'].includes(permission)) throw fail(400, 'BAD_PERMISSION', 'permission 只能是 use 或 admin');
  transaction(db, () => {
    db.prepare('INSERT OR IGNORE INTO employee_tools (employee_id, agent_id, permission, created_at) VALUES (?, ?, ?, ?)')
      .run(employeeId, agentId, permission, nowIso());
  });
  return getEmployee(db, employeeId);
}

export function revokeTool(db, employeeId, agentId) {
  const emp = getRow(db, 'SELECT * FROM employees WHERE employee_id = ?', [employeeId]);
  if (!emp) throw fail(404, 'EMPLOYEE_NOT_FOUND', `员工不存在：${employeeId}`);
  const had = getRow(db, 'SELECT 1 AS x FROM employee_tools WHERE employee_id = ? AND agent_id = ?', [employeeId, agentId]);
  if (!had) throw fail(404, 'GRANT_NOT_FOUND', `该员工没有这个工具授权：${agentId}`);
  transaction(db, () => {
    db.prepare('DELETE FROM employee_tools WHERE employee_id = ? AND agent_id = ?').run(employeeId, agentId);
  });
  return getEmployee(db, employeeId);
}

// ---------------------------------------------------------------------------
// 组织全景 + 工具库
// ---------------------------------------------------------------------------

/** GET /api/company/org 的载荷：部门（含员工）+ 助理是谁。 */
export function getOrg(db) {
  const departments = listDepartments(db).map((d) => ({
    ...d,
    employees: listEmployees(db, { departmentId: d.department_id }),
  }));
  const assistantRow = getRow(db, "SELECT employee_id, name FROM employees WHERE is_assistant = 1 AND status = 'active' ORDER BY sort_index LIMIT 1");
  return {
    generated_at: nowIso(),
    departments,
    assistant: assistantRow || null,
  };
}

/** GET /api/company/tools 的载荷：工具库（agents 全表）+ 谁能调用。 */
export function getToolLibrary(db) {
  const agents = allRows(db, 'SELECT * FROM agents ORDER BY sort_index, agent_id');
  return agents.map((a) => ({
    agent_id: a.agent_id,
    display_name: a.display_name,
    kind: a.kind,
    enabled: Number(a.enabled) === 1,
    // capabilities 是 JSON 文本列；坏值当空对象，接口不炸
    capabilities: safeParseObject(a.capabilities),
    employees: allRows(db, `
      SELECT e.employee_id, e.name FROM employee_tools et
      JOIN employees e ON e.employee_id = et.employee_id AND e.status = 'active'
      WHERE et.agent_id = ? ORDER BY e.sort_index`, [a.agent_id]),
  }));
}

function safeParseObject(text) {
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// 任务：work_items / work_executions
// ---------------------------------------------------------------------------

/** 校验「这个人能接活」：在职 + 至少一个工具授权（任务书 §3.2 POST /api/work 的校验）。 */
function assertOwnerAssignable(db, employeeId) {
  const emp = getRow(db, 'SELECT * FROM employees WHERE employee_id = ?', [employeeId]);
  if (!emp) throw fail(404, 'EMPLOYEE_NOT_FOUND', `员工不存在：${employeeId}`);
  if (emp.status !== 'active') throw fail(400, 'EMPLOYEE_NOT_ACTIVE', `员工已归档，不能接活：${emp.name}`);
  const tool = getRow(db, `
    SELECT a.agent_id FROM employee_tools et JOIN agents a ON a.agent_id = et.agent_id
    WHERE et.employee_id = ? ORDER BY a.sort_index LIMIT 1`, [employeeId]);
  if (!tool) throw fail(400, 'OWNER_NO_TOOL', `${emp.name} 没有任何工具授权，先在员工档案里授权`);
  return { employee: emp, defaultAgentId: tool.agent_id };
}

function decorateWork(db, row, { withDetail = false } = {}) {
  if (!row) return null;
  const outRefs = parseJsonArray(row.output_refs);
  const base = {
    work_id: row.work_id,
    title: row.title,
    what_to_deliver: row.what_to_deliver || '',
    acceptance: row.acceptance || '',
    department_id: row.department_id || null,
    department_name: row.department_name || null,
    project_id: row.project_id || null,
    owner_employee_id: row.owner_employee_id || null,
    owner_name: row.owner_name || null,
    owner_role: row.owner_role || null,
    assigned_by: row.assigned_by || null,
    status: row.status,
    status_label: WORK_STATUS_LABEL[row.status] || row.status,
    status_reason: row.status_reason || '',
    input_refs: parseJsonArray(row.input_refs),
    output_refs: outRefs,
    deliverable_count: outRefs.length,
    due_at: row.due_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (!withDetail) return base;
  return {
    ...base,
    // latest_progress：从最近一次执行推——执行在跑→「执行中」，其余→任务状态本身
    latest_progress: row.latest_exec_status === 'running' ? '执行中' : (WORK_STATUS_LABEL[row.status] || row.status),
    executions: allRows(db, `
      SELECT x.*, e.name AS employee_name, a.display_name AS agent_name
      FROM work_executions x
      LEFT JOIN employees e ON e.employee_id = x.employee_id
      LEFT JOIN agents a ON a.agent_id = x.agent_id
      WHERE x.work_id = ? ORDER BY x.started_at DESC, x.execution_id DESC`, [row.work_id]),
    // timeline：D0 没有独立事件表，时间线由「创建 → 每次执行 → 当前状态」拼出，
    // 只陈述库里有的字段，不推断没发生的动作
    timeline: buildTimeline(db, row),
  };
}

function buildTimeline(db, row) {
  const items = [{ at: row.created_at, event: 'created', text: `交办：${row.title}` }];
  const execs = allRows(db,
    'SELECT * FROM work_executions WHERE work_id = ? ORDER BY started_at, execution_id', [row.work_id]);
  for (const x of execs) {
    items.push({
      at: x.started_at,
      event: 'execution_started',
      text: `开始执行（工具 ${x.agent_id}）`,
      execution_id: x.execution_id,
      agent_id: x.agent_id,
    });
    if (x.ended_at) {
      items.push({
        at: x.ended_at,
        event: `execution_${x.status}`,
        text: `执行结束：${{ success: '成功', failed: '失败', unknown: '状态未知' }[x.status] || x.status}${x.result_summary ? `（${x.result_summary}）` : ''}`,
        execution_id: x.execution_id,
      });
    }
  }
  if (row.status === 'delivered' || row.status === 'accepted' || row.status === 'rejected') {
    items.push({ at: row.updated_at, event: 'delivered', text: '提交成果待验收' });
  }
  if (row.status === 'accepted') items.push({ at: row.updated_at, event: 'accepted', text: '验收通过' });
  if (row.status === 'rejected') items.push({ at: row.updated_at, event: 'rejected', text: `退回：${row.status_reason || '未填原因'}` });
  if (row.status === 'blocked') items.push({ at: row.updated_at, event: 'blocked', text: `受阻：${row.status_reason || '未填原因'}` });
  return items.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

const WORK_SELECT = `
  SELECT w.*, e.name AS owner_name, e.role AS owner_role, d.name AS department_name,
    (SELECT x.status FROM work_executions x WHERE x.work_id = w.work_id
      ORDER BY x.started_at DESC, x.execution_id DESC LIMIT 1) AS latest_exec_status
  FROM work_items w
  LEFT JOIN employees e ON e.employee_id = w.owner_employee_id
  LEFT JOIN departments d ON d.department_id = w.department_id`;

export function createWork(db, input) {
  const title = isNonEmptyString(input.title) ? input.title.trim() : '';
  if (!title) throw fail(400, 'MISSING_TITLE', '任务标题不能为空');
  const owner = isNonEmptyString(input.owner_employee_id) ? input.owner_employee_id.trim() : '';
  if (!owner) throw fail(400, 'MISSING_OWNER', '缺少 owner_employee_id（先派给一个人）');
  assertOwnerAssignable(db, owner);
  const ownerRow = getRow(db, 'SELECT * FROM employees WHERE employee_id = ?', [owner]);
  const deptId = isNonEmptyString(input.department_id) ? input.department_id.trim() : ownerRow.department_id;
  const dept = getRow(db, 'SELECT * FROM departments WHERE department_id = ?', [deptId]);
  if (!dept || dept.archived_at) throw fail(400, 'DEPARTMENT_NOT_FOUND', `部门不存在或已归档：${deptId}`);
  const inputRefs = Array.isArray(input.input_refs) ? input.input_refs : [];

  const id = makeId('work');
  const now = nowIso();
  transaction(db, () => {
    db.prepare(`INSERT INTO work_items
      (work_id, title, what_to_deliver, acceptance, department_id, project_id,
       owner_employee_id, assigned_by, status, status_reason, input_refs, output_refs, due_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', '', ?, '[]', ?, ?, ?)`)
      .run(id, title,
        isNonEmptyString(input.what_to_deliver) ? input.what_to_deliver.trim() : '',
        isNonEmptyString(input.acceptance) ? input.acceptance.trim() : '',
        deptId,
        isNonEmptyString(input.project_id) ? input.project_id.trim() : null,
        owner,
        isNonEmptyString(input.assigned_by) ? input.assigned_by.trim() : null,
        JSON.stringify(inputRefs),
        isNonEmptyString(input.due_at) ? input.due_at.trim() : null,
        now, now);
  });
  return getWork(db, id);
}

export function listWorks(db, filters = {}) {
  const conds = [];
  const params = [];
  if (isNonEmptyString(filters.status)) { conds.push('w.status = ?'); params.push(filters.status.trim()); }
  if (isNonEmptyString(filters.owner)) { conds.push('w.owner_employee_id = ?'); params.push(filters.owner.trim()); }
  if (isNonEmptyString(filters.dept)) { conds.push('w.department_id = ?'); params.push(filters.dept.trim()); }
  const sql = WORK_SELECT + (conds.length ? ` WHERE ${conds.join(' AND ')}` : '')
    + ' ORDER BY w.updated_at DESC, w.work_id DESC';
  return allRows(db, sql, params).map((r) => decorateWork(db, r));
}

export function getWork(db, id) {
  return decorateWork(db, getRow(db, `${WORK_SELECT} WHERE w.work_id = ?`, [id]), { withDetail: true });
}

/** 派给（改负责人）：任务书点击路径 3「助理派给 Claude」。 */
export function assignWork(db, id, input) {
  const row = getRow(db, 'SELECT * FROM work_items WHERE work_id = ?', [id]);
  if (!row) throw fail(404, 'WORK_NOT_FOUND', `任务不存在：${id}`);
  const owner = isNonEmptyString(input.owner_employee_id) ? input.owner_employee_id.trim() : '';
  if (!owner) throw fail(400, 'MISSING_OWNER', '缺少 owner_employee_id');
  assertOwnerAssignable(db, owner);
  transaction(db, () => {
    db.prepare('UPDATE work_items SET owner_employee_id = ?, updated_at = ? WHERE work_id = ?')
      .run(owner, nowIso(), id);
  });
  return getWork(db, id);
}

/** 有没有进行中的执行（一个 work 同时最多一条 running，A7 的判定来源）。 */
function runningExecution(db, workId) {
  return getRow(db, "SELECT * FROM work_executions WHERE work_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1", [workId]);
}

export function startExecution(db, workId, input = {}) {
  const row = getRow(db, 'SELECT * FROM work_items WHERE work_id = ?', [workId]);
  if (!row) throw fail(404, 'WORK_NOT_FOUND', `任务不存在：${workId}`);
  if (!row.owner_employee_id) throw fail(400, 'NO_OWNER', '任务还没有负责人，先派给员工');
  if (runningExecution(db, workId)) {
    throw fail(409, 'WORK_ALREADY_RUNNING', '这个任务已有一条进行中的执行，不能重复开始');
  }
  // 用哪个工具：显式指定优先（必须是负责人有授权的），否则负责人的默认工具
  const { defaultAgentId } = assertOwnerAssignable(db, row.owner_employee_id);
  const tools = toolsOf(db, row.owner_employee_id).map((t) => t.agent_id);
  const agentId = isNonEmptyString(input.agent_id) ? input.agent_id.trim() : defaultAgentId;
  if (!tools.includes(agentId)) {
    throw fail(400, 'AGENT_NOT_AUTHORIZED', `负责人没有 ${agentId} 的授权（可用：${tools.join(', ') || '无'}）`);
  }
  const execId = makeId('exec');
  const now = nowIso();
  transaction(db, () => {
    db.prepare(`INSERT INTO work_executions
      (execution_id, work_id, employee_id, agent_id, status, command, log_path, started_at)
      VALUES (?, ?, ?, ?, 'running', ?, NULL, ?)`)
      .run(execId, workId, row.owner_employee_id, agentId,
        isNonEmptyString(input.command) ? input.command.trim() : '', now);
    // 启动即视为「进行中」，此前若被退回 / 受阻，理由清掉
    db.prepare("UPDATE work_items SET status = 'running', status_reason = '', updated_at = ? WHERE work_id = ?")
      .run(now, workId);
  });
  return {
    execution_id: execId,
    work_id: workId,
    agent_id: agentId,
    started_at: now,
    work: getWork(db, workId),
  };
}

export function deliverWork(db, workId, input = {}) {
  const row = getRow(db, 'SELECT * FROM work_items WHERE work_id = ?', [workId]);
  if (!row) throw fail(404, 'WORK_NOT_FOUND', `任务不存在：${workId}`);
  if (row.status !== 'running') {
    throw fail(409, 'WORK_NOT_RUNNING', `只有进行中的任务能提交成果（当前：${WORK_STATUS_LABEL[row.status] || row.status}）`);
  }
  const outRefs = Array.isArray(input.output_refs) ? input.output_refs : [];
  const summary = isNonEmptyString(input.result_summary) ? input.result_summary.trim() : '';
  const now = nowIso();
  transaction(db, () => {
    const running = runningExecution(db, workId);
    if (running) {
      db.prepare("UPDATE work_executions SET status = 'success', result_summary = ?, ended_at = ? WHERE execution_id = ?")
        .run(summary, now, running.execution_id);
    }
    db.prepare("UPDATE work_items SET status = 'delivered', status_reason = '', output_refs = ?, updated_at = ? WHERE work_id = ?")
      .run(JSON.stringify(outRefs), now, workId);
  });
  return getWork(db, workId);
}

export function acceptWork(db, workId) {
  const row = getRow(db, 'SELECT * FROM work_items WHERE work_id = ?', [workId]);
  if (!row) throw fail(404, 'WORK_NOT_FOUND', `任务不存在：${workId}`);
  if (row.status !== 'delivered') {
    throw fail(409, 'WORK_NOT_DELIVERED', `只有已交付的任务能验收（当前：${WORK_STATUS_LABEL[row.status] || row.status}）`);
  }
  transaction(db, () => {
    db.prepare("UPDATE work_items SET status = 'accepted', updated_at = ? WHERE work_id = ?").run(nowIso(), workId);
  });
  return getWork(db, workId);
}

export function rejectWork(db, workId, input = {}) {
  const row = getRow(db, 'SELECT * FROM work_items WHERE work_id = ?', [workId]);
  if (!row) throw fail(404, 'WORK_NOT_FOUND', `任务不存在：${workId}`);
  if (row.status !== 'delivered') {
    throw fail(409, 'WORK_NOT_DELIVERED', `只有已交付的任务能退回（当前：${WORK_STATUS_LABEL[row.status] || row.status}）`);
  }
  const reason = isNonEmptyString(input.reason) ? input.reason.trim() : '';
  if (!reason) throw fail(400, 'MISSING_REASON', '退回要写原因');
  transaction(db, () => {
    db.prepare("UPDATE work_items SET status = 'rejected', status_reason = ?, updated_at = ? WHERE work_id = ?")
      .run(reason, nowIso(), workId);
  });
  return getWork(db, workId);
}

export function blockWork(db, workId, input = {}) {
  const row = getRow(db, 'SELECT * FROM work_items WHERE work_id = ?', [workId]);
  if (!row) throw fail(404, 'WORK_NOT_FOUND', `任务不存在：${workId}`);
  if (row.status === 'accepted') {
    throw fail(409, 'WORK_ALREADY_ACCEPTED', '已验收的任务不能标记受阻');
  }
  if (row.status === 'blocked') return getWork(db, workId);
  const reason = isNonEmptyString(input.reason) ? input.reason.trim() : '';
  if (!reason) throw fail(400, 'MISSING_REASON', '受阻要写原因');
  const now = nowIso();
  transaction(db, () => {
    // 受阻是主动决定，不是工具失败：进行中的执行收口为 failed（error 记原因），不留 running
    const running = runningExecution(db, workId);
    if (running) {
      db.prepare("UPDATE work_executions SET status = 'failed', error = ?, ended_at = ? WHERE execution_id = ?")
        .run(reason, now, running.execution_id);
    }
    db.prepare("UPDATE work_items SET status = 'blocked', status_reason = ?, updated_at = ? WHERE work_id = ?")
      .run(reason, now, workId);
  });
  return getWork(db, workId);
}

// ---------------------------------------------------------------------------
// 助理汇报（§3.3 · 铁律①②③）
// ---------------------------------------------------------------------------

/**
 * 从数据库真实状态聚合汇报。每一节的口径：
 *   needs_decision  rejected / blocked —— 需要老板拍板（重做 / 放行 / 撤）
 *   delivered       已交付且 output_refs 非空 —— 可验收的真成果
 *   verify_pending  已交付但没有 output_refs ——「待核验」，不冒充有成果（铁律③-1）
 *   in_progress     pending / running —— pending=待启动；running 按心跳分「正在工作 /
 *                   状态待确认」（铁律③-2：started_at 超 30 分钟没 ended_at 就不许说正在工作）
 *   blocked         受阻清单（原因来自 status_reason，没写就说未填）
 *   week_goals      D0 不做周目标（任务书 §7），恒空数组，前端显示「尚无目标」（铁律③-3）
 */
export function assistantReport(db) {
  const ownerJoin = `
    LEFT JOIN employees e ON e.employee_id = w.owner_employee_id`;

  const decisionRows = allRows(db, `
    SELECT w.work_id, w.title, w.status, w.status_reason AS why, w.updated_at
    FROM work_items w ${ownerJoin}
    WHERE w.status IN ('rejected','blocked')
    ORDER BY w.updated_at DESC`);

  const deliveredRows = allRows(db, `
    SELECT w.work_id, w.title, w.owner_employee_id, e.name AS owner_name, w.output_refs, w.updated_at
    FROM work_items w ${ownerJoin}
    WHERE w.status = 'delivered' AND w.output_refs != '[]' AND w.output_refs != ''
    ORDER BY w.updated_at DESC`);

  const verifyRows = allRows(db, `
    SELECT w.work_id, w.title, e.name AS owner_name, w.updated_at
    FROM work_items w ${ownerJoin}
    WHERE w.status = 'delivered' AND (w.output_refs = '[]' OR w.output_refs = '' OR w.output_refs IS NULL)
    ORDER BY w.updated_at DESC`);

  const progressRows = allRows(db, `
    SELECT w.work_id, w.title, w.status, w.due_at, w.department_id, e.name AS owner_name,
      (SELECT x.started_at FROM work_executions x WHERE x.work_id = w.work_id AND x.status = 'running'
        ORDER BY x.started_at DESC LIMIT 1) AS running_started_at,
      (SELECT x.execution_id FROM work_executions x WHERE x.work_id = w.work_id AND x.status = 'running'
        ORDER BY x.started_at DESC LIMIT 1) AS running_execution_id,
      (SELECT x.agent_id FROM work_executions x WHERE x.work_id = w.work_id AND x.status = 'running'
        ORDER BY x.started_at DESC LIMIT 1) AS running_agent_id
    FROM work_items w ${ownerJoin}
    WHERE w.status IN ('pending','running')
    ORDER BY w.updated_at DESC`);

  const blockedRows = allRows(db, `
    SELECT w.work_id, w.title, w.status_reason AS reason, e.name AS owner_name, w.updated_at
    FROM work_items w ${ownerJoin}
    WHERE w.status = 'blocked'
    ORDER BY w.updated_at DESC`);

  const now = Date.now();
  return {
    generated_at: nowIso(),
    scope: 'today',
    needs_decision: decisionRows.map((r) => ({
      work_id: r.work_id, title: r.title, status: r.status,
      status_label: WORK_STATUS_LABEL[r.status] || r.status,
      why: r.why || '未填原因', updated_at: r.updated_at,
    })),
    delivered: deliveredRows.map((r) => ({
      work_id: r.work_id, title: r.title, status: 'delivered', status_label: WORK_STATUS_LABEL.delivered,
      owner_name: r.owner_name || '（未派）',
      output_refs: parseJsonArray(r.output_refs), updated_at: r.updated_at,
    })),
    verify_pending: verifyRows.map((r) => ({
      work_id: r.work_id, title: r.title, status: 'delivered', status_label: WORK_STATUS_LABEL.delivered,
      owner_name: r.owner_name || '（未派）', output_refs: [],
      note: '工具说完成但没有提交成果清单，需要人工核验', updated_at: r.updated_at,
    })),
    in_progress: progressRows.map((r) => {
      let progress;
      let basis;
      if (r.status === 'pending') {
        progress = '待启动';
        basis = '还没有执行记录，等待启动';
      } else if (!r.running_started_at) {
        progress = '状态待确认';
        basis = '没有进行中的执行记录';
      } else if (now - Date.parse(r.running_started_at) > RUNNING_STALE_MS) {
        progress = '状态待确认';
        basis = `最近一次心跳 ${runningAgeText(r.running_started_at, now)}前（超过 30 分钟）`;
      } else {
        progress = '正在工作';
        basis = `工具 ${r.running_agent_id || '?'}，开始于 ${runningAgeText(r.running_started_at, now)}前`;
      }
      return {
        work_id: r.work_id, title: r.title, status: r.status,
        status_label: WORK_STATUS_LABEL[r.status] || r.status,
        owner_name: r.owner_name || '（未派）', department_id: r.department_id,
        progress, basis, eta: r.due_at || null, updated_at: r.updated_at,
      };
    }),
    blocked: blockedRows.map((r) => ({
      work_id: r.work_id, title: r.title, reason: r.reason || '未填原因',
      owner_name: r.owner_name || '（未派）', updated_at: r.updated_at,
    })),
    week_goals: [],
  };
}
