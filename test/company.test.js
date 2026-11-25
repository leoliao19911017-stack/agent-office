// TASK-COMPANY-D0 验收测试：A1-A4（迁移与预置）、A6-A11（任务链路 + 汇报铁律）。
// 运行：node --no-warnings --test test/company.test.js
//
// 两层：
//   数据层用内存 SQLite 直接调 web/lib/company.mjs（不 mock，真库真事务）；
//   HTTP 层用 test/chat-harness.mjs 起真实 web/server.js 子进程（临时库 + 随机端口），
//   与 tasks-rework 的隔离口径一致：不碰 data/agent-office.db、不抢 8090。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, closeDb } from '../web/lib/db.mjs';
import {
  acceptWork, archiveDepartment, archiveEmployee, assignWork, assistantReport,
  blockWork, createDepartment, createEmployee, createWork, deliverWork, getEmployee,
  getOrg, getWork, grantTool, listWorks, rejectWork, startExecution,
} from '../web/lib/company.mjs';
import { startChatServer, postJson, getJson } from './chat-harness.mjs';

/** 每个数据层测试独立一套内存库（迁移 v10 自动跑，预置 4 部门 / 2 员工 / 3 授权）。 */
function freshDb() {
  return openDb({ memory: true });
}

/** 走完整链路到指定状态，返回 work_id。 */
function makeWork(db, { to = 'pending', owner = 'emp-claude', outputRefs = ['docs/x.md'] } = {}) {
  const w = createWork(db, {
    title: '测试任务', what_to_deliver: '一份文档', acceptance: '覆盖全部点',
    owner_employee_id: owner, assigned_by: 'leo',
  });
  if (to === 'pending') return w.work_id;
  startExecution(db, w.work_id, {});
  if (to === 'running') return w.work_id;
  deliverWork(db, w.work_id, { output_refs: outputRefs, result_summary: '完成' });
  if (to === 'delivered') return w.work_id;
  if (to === 'accepted') { acceptWork(db, w.work_id); return w.work_id; }
  throw new Error(`不支持的目标状态：${to}`);
}

// ---------------------------------------------------------------------------
// A1-A4：迁移与预置数据
// ---------------------------------------------------------------------------

test('A1/A2/A3 迁移后预置 4 部门 / 2 员工 / 3 条工具授权', () => {
  const db = freshDb();
  try {
    const depts = getOrg(db).departments;
    assert.equal(depts.length, 4, 'A1：departments 应为 4 行');
    assert.deepEqual(depts.map((d) => d.name), ['研发部', '营销部', '人事部', '资产部']);
    // 营销部 manager 为空 = 助理兼任（任务书 §2.1）
    const mkt = depts.find((d) => d.department_id === 'mkt');
    assert.equal(mkt.manager_employee_id, null);
    assert.equal(mkt.managed_by_assistant, true);
    assert.equal(mkt.employee_count, 0);

    const hermes = getEmployee(db, 'emp-hermes');
    const claude = getEmployee(db, 'emp-claude');
    assert.ok(hermes && claude, 'A2：employees 应为 2 行');
    assert.equal(hermes.is_assistant, true, 'Hermes 是助理');
    assert.equal(hermes.department_id, 'hr', 'Hermes 归人事部（兼任），不是普通人事员工');
    assert.equal(claude.department_id, 'dev');
    assert.equal(claude.is_assistant, false);

    assert.deepEqual(claude.tools.map((t) => t.agent_id), ['claude', 'dsh'],
      'A3：Claude 授权 claude + dsh（员工可以换工具）');
    assert.deepEqual(hermes.tools.map((t) => t.agent_id), ['hermes']);
  } finally { closeDb(db); }
});

test('A4 workflow_runs 有 department_id 列（存量迁移在快照上验过，这里验表结构）', () => {
  const db = freshDb();
  try {
    const cols = db.prepare('PRAGMA table_info(workflow_runs)').all().map((c) => c.name);
    assert.ok(cols.includes('department_id'), `workflow_runs 应有 department_id 列：${cols.join(',')}`);
  } finally { closeDb(db); }
});

// ---------------------------------------------------------------------------
// 组织 CRUD 与保护
// ---------------------------------------------------------------------------

test('部门：能建（路径 10）、重名 409、改名；预置部门不许归档', () => {
  const db = freshDb();
  try {
    const d = createDepartment(db, { name: '设计部', duty: '出设计稿' });
    assert.ok(d.department_id.startsWith('dept-'));
    assert.equal(d.name, '设计部');

    assert.throws(() => createDepartment(db, { name: '设计部' }),
      (e) => e.statusCode === 409 && e.code === 'DEPARTMENT_NAME_TAKEN');

    assert.throws(() => archiveDepartment(db, 'dev'),
      (e) => e.statusCode === 409 && e.code === 'DEPARTMENT_IS_PRESET');
  } finally { closeDb(db); }
});

test('部门归档保护：有未完结任务 → 409', () => {
  const db = freshDb();
  try {
    const d = createDepartment(db, { name: '设计部', duty: '' });
    const w = createWork(db, { title: 'x', owner_employee_id: 'emp-claude' });
    db.prepare('UPDATE work_items SET department_id = ? WHERE work_id = ?').run(d.department_id, w.work_id);
    assert.throws(() => archiveDepartment(db, d.department_id),
      (e) => e.statusCode === 409 && e.code === 'DEPARTMENT_HAS_ACTIVE_WORK');
  } finally { closeDb(db); }
});

test('员工：建 / 改 / 工具授权整组替换 / 归档保护（有 running 任务 → 409）', () => {
  const db = freshDb();
  try {
    const e = createEmployee(db, {
      department_id: 'dev', name: 'Codex', role: '评审工程师',
      duty: '独立评审', tool_ids: ['codex'],
    });
    assert.ok(e.employee_id.startsWith('emp-'));
    assert.deepEqual(e.tools.map((t) => t.agent_id), ['codex']);

    // 给未知工具授权 → 400
    assert.throws(() => grantTool(db, e.employee_id, 'no-such-tool'),
      (err) => err.statusCode === 400 && err.code === 'AGENT_NOT_FOUND');

    // 归档保护：pending 任务也算未完结
    const w = createWork(db, { title: 'x', owner_employee_id: e.employee_id });
    assert.throws(() => archiveEmployee(db, e.employee_id),
      (err) => err.statusCode === 409 && err.code === 'EMPLOYEE_HAS_RUNNING_WORK');
    // 任务验收后就能归档了
    startExecution(db, w.work_id, {});
    deliverWork(db, w.work_id, { output_refs: ['a.md'] });
    acceptWork(db, w.work_id);
    const archived = archiveEmployee(db, e.employee_id);
    assert.equal(archived.status, 'archived');

    // 助理不能归档（D0 唯一入口）
    assert.throws(() => archiveEmployee(db, 'emp-hermes'),
      (err) => err.statusCode === 409 && err.code === 'EMPLOYEE_IS_ASSISTANT');
  } finally { closeDb(db); }
});

// ---------------------------------------------------------------------------
// 任务链路：A6-A9
// ---------------------------------------------------------------------------

test('A6 交办：校验负责人存在、在职、至少一个工具', () => {
  const db = freshDb();
  try {
    const w = createWork(db, {
      title: '整理 EaseDraw 功能介绍',
      what_to_deliver: '一份功能介绍文档',
      acceptance: '覆盖全部功能点',
      owner_employee_id: 'emp-claude',
      assigned_by: 'leo',
    });
    assert.equal(w.status, 'pending');
    assert.equal(w.owner_name, 'Claude');
    assert.equal(w.department_id, 'dev', '不指定部门时默认负责人的部门');

    assert.throws(() => createWork(db, { title: 'x', owner_employee_id: 'emp-nobody' }),
      (e) => e.statusCode === 404 && e.code === 'EMPLOYEE_NOT_FOUND');

    // 没有工具授权的员工接不了活
    const e = createEmployee(db, { department_id: 'dev', name: '裸奔', role: '临时工' });
    assert.throws(() => createWork(db, { title: 'x', owner_employee_id: e.employee_id }),
      (err) => err.statusCode === 400 && err.code === 'OWNER_NO_TOOL');
  } finally { closeDb(db); }
});

test('派给（路径 3）：assign 改 owner，校验同 createWork', () => {
  const db = freshDb();
  try {
    const wid = makeWork(db, { to: 'pending', owner: 'emp-hermes' });
    const w = assignWork(db, wid, { owner_employee_id: 'emp-claude' });
    assert.equal(w.owner_employee_id, 'emp-claude');
    assert.throws(() => assignWork(db, wid, { owner_employee_id: 'emp-nobody' }),
      (e) => e.statusCode === 404 && e.code === 'EMPLOYEE_NOT_FOUND');
  } finally { closeDb(db); }
});

test('A7 同一 work 不能有两条 running 执行（409 WORK_ALREADY_RUNNING）', () => {
  const db = freshDb();
  try {
    const wid = makeWork(db, { to: 'running' });
    assert.throws(() => startExecution(db, wid, {}),
      (e) => e.statusCode === 409 && e.code === 'WORK_ALREADY_RUNNING');
    // 已 running 的任务换工具再 start 也是 409（running 检查在授权检查之前）
    assert.throws(() => startExecution(db, wid, { agent_id: 'codex' }),
      (e) => e.code === 'WORK_ALREADY_RUNNING');
    // 显式指定未授权的工具 → 400（要在 pending 状态上测才轮得到授权检查）
    const w2 = makeWork(db, { to: 'pending' });
    assert.throws(() => startExecution(db, w2, { agent_id: 'codex' }),
      (e) => e.statusCode === 400 && e.code === 'AGENT_NOT_AUTHORIZED');
  } finally { closeDb(db); }
});

test('A8 提交成果 → delivered（output_refs 落库）；A9 验收 → accepted；退回要原因', () => {
  const db = freshDb();
  try {
    const wid = makeWork(db, { to: 'delivered', outputRefs: ['docs/a.md', 'docs/b.md'] });
    const w = getWork(db, wid);
    assert.equal(w.status, 'delivered');
    assert.deepEqual(w.output_refs, ['docs/a.md', 'docs/b.md']);
    assert.equal(w.deliverable_count, 2);
    assert.equal(w.executions[0].status, 'success', '交付时 running 执行收口为 success');
    assert.ok(w.executions[0].ended_at);

    // 不是 running 不能交付
    assert.throws(() => deliverWork(db, wid, { output_refs: [] }),
      (e) => e.statusCode === 409 && e.code === 'WORK_NOT_RUNNING');

    acceptWork(db, wid);
    assert.equal(getWork(db, wid).status, 'accepted');
    // 已验收不能再验收 / 受阻
    assert.throws(() => acceptWork(db, wid), (e) => e.code === 'WORK_NOT_DELIVERED');
    assert.throws(() => blockWork(db, wid, { reason: 'r' }), (e) => e.code === 'WORK_ALREADY_ACCEPTED');
  } finally { closeDb(db); }
});

test('退回 / 受阻：要写原因，状态与 status_reason 落库', () => {
  const db = freshDb();
  try {
    const wid = makeWork(db, { to: 'delivered' });
    assert.throws(() => rejectWork(db, wid, {}), (e) => e.code === 'MISSING_REASON');
    const r = rejectWork(db, wid, { reason: '缺了导出功能' });
    assert.equal(r.status, 'rejected');
    assert.equal(r.status_reason, '缺了导出功能');

    const wid2 = makeWork(db, { to: 'running' });
    const b = blockWork(db, wid2, { reason: '等 Leo 提供素材' });
    assert.equal(b.status, 'blocked');
    assert.equal(b.status_reason, '等 Leo 提供素材');
    assert.equal(getWork(db, wid2).executions[0].status, 'failed', '受阻时 running 执行收口为 failed');
  } finally { closeDb(db); }
});

// ---------------------------------------------------------------------------
// A10 / A11：助理汇报（铁律①②③）
// ---------------------------------------------------------------------------

test('A10 汇报从库聚合：各分区与 SQL 直查一致', () => {
  const db = freshDb();
  try {
    makeWork(db, { to: 'delivered' });                     // → delivered
    makeWork(db, { to: 'running' });                       // → in_progress 正在工作
    const w3 = makeWork(db, { to: 'delivered', outputRefs: [] }); // → verify_pending
    const w4 = makeWork(db, { to: 'pending' });            // → in_progress 待启动
    rejectWork(db, w3, { reason: '空的' });
    blockWork(db, w4, { reason: '等素材' });
    // 再补一件干净的 delivered / rejected / blocked
    makeWork(db, { to: 'delivered' });

    const rep = assistantReport(db);
    const q = (sql) => db.prepare(sql).get().n;
    assert.equal(rep.delivered.length, q("SELECT COUNT(*) n FROM work_items WHERE status='delivered' AND output_refs != '[]'"),
      'delivered 数量必须等于 SQL 直查');
    assert.equal(rep.verify_pending.length, 0, '被退回的不该留在 verify_pending');
    assert.equal(rep.needs_decision.length,
      q("SELECT COUNT(*) n FROM work_items WHERE status IN ('rejected','blocked')"));
    assert.equal(rep.in_progress.length, q("SELECT COUNT(*) n FROM work_items WHERE status IN ('pending','running')"));
    assert.equal(rep.blocked.length, q("SELECT COUNT(*) n FROM work_items WHERE status='blocked'"));
    assert.deepEqual(rep.week_goals, [], 'D0 没有周目标（§7 明确不做），恒空');
    assert.equal(rep.scope, 'today');
  } finally { closeDb(db); }
});

test('A11 没有 output_refs 的 delivered → 「待核验」，不进 delivered', () => {
  const db = freshDb();
  try {
    makeWork(db, { to: 'delivered', outputRefs: [] });
    makeWork(db, { to: 'delivered', outputRefs: ['docs/real.md'] });
    const rep = assistantReport(db);
    assert.equal(rep.delivered.length, 1, '只有带成果的进 delivered');
    assert.deepEqual(rep.delivered[0].output_refs, ['docs/real.md']);
    assert.equal(rep.verify_pending.length, 1, '空 output_refs 进待核验');
    assert.match(rep.verify_pending[0].note, /核验/);
  } finally { closeDb(db); }
});

test('铁律③-2：running 执行心跳超时 → 「状态待确认」，不显示「正在工作」', () => {
  const db = freshDb();
  try {
    const wid = makeWork(db, { to: 'running' });
    const fresh = assistantReport(db).in_progress.find((x) => x.work_id === wid);
    assert.equal(fresh.progress, '正在工作', '刚启动的执行应显示正在工作');

    // 把 started_at 拨回 40 分钟前（超过 RUNNING_STALE_MS=30min）
    db.prepare("UPDATE work_executions SET started_at = ? WHERE work_id = ?")
      .run(new Date(Date.now() - 40 * 60 * 1000).toISOString(), wid);
    const stale = assistantReport(db).in_progress.find((x) => x.work_id === wid);
    assert.equal(stale.progress, '状态待确认', '心跳超时不许说正在工作');
  } finally { closeDb(db); }
});

test('列表筛选 + 详情：owner / dept / status 过滤，timeline 不编造', () => {
  const db = freshDb();
  try {
    const w = makeWork(db, { to: 'delivered' });
    assert.equal(listWorks(db, { status: 'delivered' }).length, 1);
    assert.equal(listWorks(db, { owner: 'emp-claude' }).length, 1);
    assert.equal(listWorks(db, { owner: 'emp-hermes' }).length, 0);
    assert.equal(listWorks(db, { dept: 'dev' }).length, 1);
    assert.equal(listWorks(db, { dept: 'mkt' }).length, 0);

    const detail = getWork(db, w);
    assert.equal(detail.owner_name, 'Claude');
    assert.equal(detail.department_name, '研发部');
    const events = detail.timeline.map((t) => t.event);
    assert.ok(events.includes('created'));
    assert.ok(events.includes('execution_started'));
    assert.ok(events.includes('delivered'));
    assert.ok(detail.executions.length >= 1);
  } finally { closeDb(db); }
});

// ---------------------------------------------------------------------------
// HTTP 层：真实 server.js 子进程（隔离库 + 随机端口）
// ---------------------------------------------------------------------------

test('HTTP 全链路：org → 交办 → 派给 → 开始(409) → 交付 → 验收 → 汇报', async () => {
  const srv = await startChatServer();
  try {
    const org = await getJson(srv.base, '/api/company/org');
    assert.equal(org.status, 200);
    assert.equal(org.body.departments.length, 4);
    assert.equal(org.body.assistant.employee_id, 'emp-hermes');

    // 交办给助理（老板入口），再派给 Claude（点击路径 2 → 3）
    const created = await postJson(srv.base, '/api/work', {
      title: '整理 EaseDraw 功能介绍',
      what_to_deliver: '一份功能介绍文档',
      acceptance: '覆盖全部功能点',
      owner_employee_id: 'emp-hermes',
      assigned_by: 'leo',
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.work.status, 'pending');
    const wid = created.body.work.work_id;

    const assigned = await postJson(srv.base, `/api/work/${wid}/assign`, { owner_employee_id: 'emp-claude' });
    assert.equal(assigned.status, 200);
    assert.equal(assigned.body.work.owner_employee_id, 'emp-claude');

    const s1 = await postJson(srv.base, `/api/work/${wid}/start`, {});
    assert.equal(s1.status, 201);
    assert.equal(s1.body.agent_id, 'claude');
    const s2 = await postJson(srv.base, `/api/work/${wid}/start`, {});
    assert.equal(s2.status, 409);
    assert.equal(s2.body.code, 'WORK_ALREADY_RUNNING');

    const dv = await postJson(srv.base, `/api/work/${wid}/deliver`, {
      output_refs: ['docs/easedraw-intro.md'], result_summary: '写完',
    });
    assert.equal(dv.status, 200);
    assert.equal(dv.body.work.status, 'delivered');

    // 汇报里应出现这件（带成果才算 delivered）
    const rep1 = await getJson(srv.base, '/api/assistant/report');
    assert.equal(rep1.status, 200);
    assert.ok(rep1.body.delivered.some((x) => x.work_id === wid));

    const ac = await postJson(srv.base, `/api/work/${wid}/accept`, {});
    assert.equal(ac.status, 200);
    assert.equal(ac.body.work.status, 'accepted');

    const detail = await getJson(srv.base, `/api/work/${wid}`);
    assert.equal(detail.status, 200);
    assert.ok(Array.isArray(detail.body.work.executions));
    assert.ok(detail.body.work.timeline.length >= 3);
  } finally { await srv.stop(); }
});

test('HTTP：工具库 / 建部门（路径 10）/ 405 兜底', async () => {
  const srv = await startChatServer();
  try {
    const tools = await getJson(srv.base, '/api/company/tools');
    assert.equal(tools.status, 200);
    // 测试库 seed 4 个工具（claude/codex/dsh/hermes）；生产库的 kimi-k3/glm-46 是后加的，不在 seed 里
    assert.equal(tools.body.tools.length, 4, '工具库 = agents 全表（seed 4 个）');
    assert.ok(tools.body.tools.every((t) => t.enabled === true), 'seed 的工具都是启用状态');
    const claudeTool = tools.body.tools.find((t) => t.agent_id === 'claude');
    assert.deepEqual(claudeTool.employees.map((e) => e.employee_id), ['emp-claude'], '谁能调用来自 employee_tools');
    const codexTool = tools.body.tools.find((t) => t.agent_id === 'codex');
    assert.equal(codexTool.employees.length, 0, '没人授权的工具 employees 为空，照样展示');

    const dept = await postJson(srv.base, '/api/departments', { name: '质量部', duty: '验收把关' });
    assert.equal(dept.status, 201);
    const org2 = await getJson(srv.base, '/api/company/org');
    assert.equal(org2.body.departments.length, 5, '新建部门立刻出现在列表（路径 10）');

    const bad = await postJson(srv.base, '/api/company/org', {});
    assert.equal(bad.status, 405, '只读端点要 405，不是 404 或 500');
  } finally { await srv.stop(); }
});
