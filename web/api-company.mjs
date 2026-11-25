// api-company.mjs — TASK-COMPANY-D0 的 /api/* 路由（组织 + 任务 + 助理汇报）。
//
//   组织   GET    /api/company/org            全景（部门 → 员工 → 工具）
//         GET    /api/company/tools           工具库（agents 全表 + 谁能调用）
//         POST   /api/departments             建部门
//         PATCH  /api/departments/:id         改部门
//         DELETE /api/departments/:id         软删（有未完结任务 / 在职员工 → 409）
//         POST   /api/employees               建员工（带 tool_ids 授权）
//         PATCH  /api/employees/:id           改员工（tool_ids 整组替换）
//         DELETE /api/employees/:id           软删（有未完结任务 → 409）
//         POST   /api/employees/:id/tools     授权工具 { agent_id }
//         DELETE /api/employees/:id/tools/:agentId   收回授权
//   项目   GET    /api/projects               列表（带 requirement_count / task_count）
//         POST   /api/projects                建项目（root_path 给了必须真实存在）
//         GET    /api/projects/:id            详情（+ requirements / tasks）
//         PATCH  /api/projects/:id            改项目
//         DELETE /api/projects/:id            软删（未完结任务 / running run → 409）
//   任务   POST   /api/work                   交办（R2 起 project_id 必填）
//         GET    /api/work?status=&owner=&dept=&project=   列表
//         GET    /api/work/:id                详情（负责人 + 执行记录 + 时间线）
//         POST   /api/work/:id/assign         派给（改负责人；点击路径 3）
//         POST   /api/work/:id/start          开始执行（建 worktree；已有 running → 409）
//         POST   /api/work/:id/deliver        提交成果 → delivered（人工补录路径）
//         POST   /api/work/:id/finish         执行收尾（commit + 释放锁；R2 §3.4）
//         POST   /api/work/:id/accept         验收 → accepted
//         POST   /api/work/:id/reject         退回 { reason } → rejected
//         POST   /api/work/:id/block          受阻 { reason } → blocked
//         POST   /api/work/:id/merge          人工合并执行分支（R2 §3.6，只对 accepted 开放）
//   汇报   GET    /api/assistant/report       100% 库内聚合（铁律见 lib/company.mjs 头注）
//
// 挂载约定与 api-tasks / api-agents 一致：自己匹配路径、自己管 405，
// 不认识的路径返回 false 交给后面的路由。
import { getDb } from './lib/db.mjs';
import {
  acceptWork, archiveDepartment, archiveEmployee, archiveProject, assignWork, assistantReport,
  blockWork, createDepartment, createEmployee, createProject, createWork, deliverWork,
  finishExecution, getDepartment, getEmployee, getOrg, getProjectDetail, getToolLibrary,
  getWork, grantTool, listDepartments, listEmployees, listProjects, listWorks, mergeExecution,
  rejectWork, revokeTool, startExecution, updateDepartment, updateEmployee, updateProject,
} from './lib/company.mjs';

function send(deps, res, statusCode, payload) {
  deps.sendJson(res, statusCode, payload);
}

function httpErrorOf(deps) {
  return (status, code, message) => {
    if (typeof deps.httpError === 'function') return deps.httpError(status, code, message);
    return Object.assign(new Error(message), { statusCode: status, code });
  };
}

/** 读 JSON 请求体（空 body 当 {}）。 */
async function readBody(deps, req) {
  if (typeof deps.readJsonBody === 'function') return deps.readJsonBody(req);
  // 没有注入（理论不会发生）：按空体处理，让校验报 400 而不是炸 500
  return {};
}

const METHODS = { GET: 1, POST: 1, PATCH: 1, DELETE: 1 };

/**
 * @returns {Promise<boolean>} true=已处理
 */
export async function handleCompanyApi(req, res, path, method, deps = {}) {
  const m = String(method || 'GET').toUpperCase();
  if (!METHODS[m]) return false;
  const seg = path.split('/').filter(Boolean);   // ['api', 'departments', ...]
  const db = getDb();

  // ---- 组织全景 / 工具库 -------------------------------------------------
  if (path === '/api/company/org') {
    if (m !== 'GET') throw httpErrorOf(deps)(405, 'METHOD_NOT_ALLOWED', `${m} ${path} 不支持`);
    send(deps, res, 200, { ok: true, ...getOrg(db) });
    return true;
  }
  if (path === '/api/company/tools') {
    if (m !== 'GET') throw httpErrorOf(deps)(405, 'METHOD_NOT_ALLOWED', `${m} ${path} 不支持`);
    send(deps, res, 200, { ok: true, tools: getToolLibrary(db) });
    return true;
  }

  // ---- 部门 --------------------------------------------------------------
  if (seg[0] === 'api' && seg[1] === 'departments') {
    if (seg.length === 2) {
      if (m === 'GET') { send(deps, res, 200, { ok: true, departments: listDepartments(db) }); return true; }
      if (m === 'POST') { send(deps, res, 201, { ok: true, department: createDepartment(db, await readBody(deps, req)) }); return true; }
      throw httpErrorOf(deps)(405, 'METHOD_NOT_ALLOWED', `${m} ${path} 不支持`);
    }
    if (seg.length === 3) {
      const id = decodeURIComponent(seg[2]);
      if (m === 'GET') {
        const d = getDepartment(db, id);
        if (!d) throw httpErrorOf(deps)(404, 'DEPARTMENT_NOT_FOUND', `部门不存在：${id}`);
        send(deps, res, 200, { ok: true, department: d, employees: listEmployees(db, { departmentId: id }) });
        return true;
      }
      if (m === 'PATCH') { send(deps, res, 200, { ok: true, department: updateDepartment(db, id, await readBody(deps, req)) }); return true; }
      if (m === 'DELETE') { send(deps, res, 200, { ok: true, department: archiveDepartment(db, id) }); return true; }
      throw httpErrorOf(deps)(405, 'METHOD_NOT_ALLOWED', `${m} ${path} 不支持`);
    }
  }

  // ---- 员工 + 工具授权 ----------------------------------------------------
  if (seg[0] === 'api' && seg[1] === 'employees') {
    if (seg.length === 2) {
      if (m === 'GET') {
        const q = new URL(req.url, 'http://127.0.0.1');
        const dept = q.searchParams.get('department_id') || q.searchParams.get('dept');
        send(deps, res, 200, { ok: true, employees: listEmployees(db, { departmentId: dept || undefined }) });
        return true;
      }
      if (m === 'POST') { send(deps, res, 201, { ok: true, employee: createEmployee(db, await readBody(deps, req)) }); return true; }
      throw httpErrorOf(deps)(405, 'METHOD_NOT_ALLOWED', `${m} ${path} 不支持`);
    }
    if (seg.length === 3) {
      const id = decodeURIComponent(seg[2]);
      if (m === 'GET') {
        const e = getEmployee(db, id);
        if (!e) throw httpErrorOf(deps)(404, 'EMPLOYEE_NOT_FOUND', `员工不存在：${id}`);
        send(deps, res, 200, { ok: true, employee: e });
        return true;
      }
      if (m === 'PATCH') { send(deps, res, 200, { ok: true, employee: updateEmployee(db, id, await readBody(deps, req)) }); return true; }
      if (m === 'DELETE') { send(deps, res, 200, { ok: true, employee: archiveEmployee(db, id) }); return true; }
      throw httpErrorOf(deps)(405, 'METHOD_NOT_ALLOWED', `${m} ${path} 不支持`);
    }
    if (seg.length === 4 && seg[3] === 'tools') {
      const id = decodeURIComponent(seg[2]);
      if (m === 'POST') {
        const body = await readBody(deps, req);
        send(deps, res, 201, { ok: true, employee: grantTool(db, id, body.agent_id, body.permission || 'use') });
        return true;
      }
      throw httpErrorOf(deps)(405, 'METHOD_NOT_ALLOWED', `${m} ${path} 不支持`);
    }
    if (seg.length === 5 && seg[3] === 'tools') {
      const id = decodeURIComponent(seg[2]);
      const agentId = decodeURIComponent(seg[4]);
      if (m === 'DELETE') { send(deps, res, 200, { ok: true, employee: revokeTool(db, id, agentId) }); return true; }
      throw httpErrorOf(deps)(405, 'METHOD_NOT_ALLOWED', `${m} ${path} 不支持`);
    }
  }

  // ---- 项目（TASK-COMPANY-D0-R2 §2.5）--------------------------------------
  if (seg[0] === 'api' && seg[1] === 'projects') {
    if (seg.length === 2) {
      if (m === 'GET') { send(deps, res, 200, { ok: true, projects: listProjects(db) }); return true; }
      if (m === 'POST') { send(deps, res, 201, { ok: true, project: createProject(db, await readBody(deps, req)) }); return true; }
      throw httpErrorOf(deps)(405, 'METHOD_NOT_ALLOWED', `${m} ${path} 不支持`);
    }
    if (seg.length === 3) {
      const id = decodeURIComponent(seg[2]);
      if (m === 'GET') {
        const p = getProjectDetail(db, id);
        if (!p) throw httpErrorOf(deps)(404, 'PROJECT_NOT_FOUND', `项目不存在：${id}`);
        send(deps, res, 200, { ok: true, project: p });
        return true;
      }
      if (m === 'PATCH') { send(deps, res, 200, { ok: true, project: updateProject(db, id, await readBody(deps, req)) }); return true; }
      if (m === 'DELETE') { send(deps, res, 200, { ok: true, project: archiveProject(db, id) }); return true; }
      throw httpErrorOf(deps)(405, 'METHOD_NOT_ALLOWED', `${m} ${path} 不支持`);
    }
  }

  // ---- 任务 ---------------------------------------------------------------
  if (seg[0] === 'api' && seg[1] === 'work' && seg.length === 2) {
    if (m === 'GET') {
      const q = new URL(req.url, 'http://127.0.0.1');
      send(deps, res, 200, {
        ok: true,
        works: listWorks(db, {
          status: q.searchParams.get('status') || undefined,
          owner: q.searchParams.get('owner') || undefined,
          dept: q.searchParams.get('dept') || undefined,
        }),
      });
      return true;
    }
    if (m === 'POST') { send(deps, res, 201, { ok: true, work: createWork(db, await readBody(deps, req)) }); return true; }
    throw httpErrorOf(deps)(405, 'METHOD_NOT_ALLOWED', `${m} ${path} 不支持`);
  }
  if (seg[0] === 'api' && seg[1] === 'work' && seg.length === 3) {
    const id = decodeURIComponent(seg[2]);
    if (m === 'GET') {
      const w = getWork(db, id);
      if (!w) throw httpErrorOf(deps)(404, 'WORK_NOT_FOUND', `任务不存在：${id}`);
      send(deps, res, 200, { ok: true, work: w });
      return true;
    }
    throw httpErrorOf(deps)(405, 'METHOD_NOT_ALLOWED', `${m} ${path} 不支持`);
  }
  if (seg[0] === 'api' && seg[1] === 'work' && seg.length === 4) {
    const id = decodeURIComponent(seg[2]);
    const action = seg[3];
    const body = ['start', 'deliver', 'assign', 'reject', 'block', 'finish'].includes(action)
      ? await readBody(deps, req) : {};
    if (m !== 'POST') throw httpErrorOf(deps)(405, 'METHOD_NOT_ALLOWED', `${m} ${path} 不支持`);
    if (action === 'start') { send(deps, res, 201, { ok: true, ...startExecution(db, id, body) }); return true; }
    if (action === 'deliver') { send(deps, res, 200, { ok: true, work: deliverWork(db, id, body) }); return true; }
    if (action === 'finish') { send(deps, res, 200, { ok: true, work: finishExecution(db, id, body) }); return true; }
    if (action === 'merge') { send(deps, res, 200, { ok: true, ...mergeExecution(db, id) }); return true; }
    if (action === 'accept') { send(deps, res, 200, { ok: true, work: acceptWork(db, id) }); return true; }
    if (action === 'reject') { send(deps, res, 200, { ok: true, work: rejectWork(db, id, body) }); return true; }
    if (action === 'block') { send(deps, res, 200, { ok: true, work: blockWork(db, id, body) }); return true; }
    if (action === 'assign') { send(deps, res, 200, { ok: true, work: assignWork(db, id, body) }); return true; }
    throw httpErrorOf(deps)(404, 'UNKNOWN_ACTION', `不支持的动作：${action}`);
  }

  // ---- 助理汇报 -----------------------------------------------------------
  if (path === '/api/assistant/report') {
    if (m !== 'GET') throw httpErrorOf(deps)(405, 'METHOD_NOT_ALLOWED', `${m} ${path} 不支持`);
    send(deps, res, 200, { ok: true, ...assistantReport(db) });
    return true;
  }

  return false;
}
