// api-workflow-templates.mjs — 工作流模板 CRUD + 自然语言生成草稿。
//
// 挂载点：
//   GET    /api/workflow/templates               列表（摘要：步骤数 / 在用 run 数，不含完整 steps）
//   GET    /api/workflow/templates/:id           完整定义（?version=N 查历史版本）
//   POST   /api/workflow/templates               新建
//   PUT    /api/workflow/templates/:id           更新（版本 +1，旧版本进历史表）
//   DELETE /api/workflow/templates/:id           删除（有 run 在用 → 409）
//   POST   /api/workflow/templates/from-text     规则解析口述文本 → { draft, summary, missing }
//   POST   /api/workflow/templates/confirm       确认草稿 → 落库 version=1
//
// 本层只做 HTTP 协议转换与入参校验；模板存取在 workflow-db.mjs，
// 自然语言解析在 workflow-parse.mjs。没有外部 LLM 调用。

import { getDb } from './lib/db.mjs';
import {
  countWorkflowRunsByTemplate,
  deleteWorkflowTemplate,
  getWorkflowTemplate,
  getWorkflowTemplateVersion,
  insertWorkflowTemplate,
  listWorkflowTemplateSummaries,
  listWorkflowTemplateVersions,
  updateWorkflowTemplate,
} from './lib/workflow-db.mjs';
import { parseWorkflowText } from './lib/workflow-parse.mjs';

const BASE = '/api/workflow/templates';
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ID_PATH = /^\/api\/workflow\/templates\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/;
const MAX_TEXT = 20000;

function send(deps, res, statusCode, payload) {
  deps.sendJson(res, statusCode, payload);
}

async function bodyOf(req, deps) {
  return typeof deps.readJsonBody === 'function' ? (await deps.readJsonBody(req)) || {} : {};
}

function bad(deps, code, message) {
  const err = deps.httpError(400, code, message);
  return err;
}

function notFound(deps, templateId) {
  return deps.httpError(404, 'TEMPLATE_NOT_FOUND', `模板不存在：${templateId}`);
}

/** 字段既收 snake_case（v3 定稿 schema），也收 camelCase（数据层入参口径）。 */
function pick(obj, snake, camel) {
  if (obj[snake] !== undefined) return obj[snake];
  if (camel !== undefined && obj[camel] !== undefined) return obj[camel];
  return undefined;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 数据库行 → API 视图（JSON 列解析成对象/数组，不外泄原始字符串）。 */
function templateView(row, extra = {}) {
  return {
    template_id: row.template_id,
    name: row.name,
    version: row.version,
    steps: parseJson(row.steps) ?? [],
    rework_routes: parseJson(row.rework_routes) ?? {},
    scoring: parseJson(row.scoring) ?? {},
    autonomy: parseJson(row.autonomy) ?? {},
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...extra,
  };
}

/** 列表摘要只给 Leo 需要判断的几项，不传整份 steps。 */
function summaryView(row) {
  const steps = parseJson(row.steps) ?? [];
  return {
    template_id: row.template_id,
    name: row.name,
    version: row.version,
    step_count: Array.isArray(steps) ? steps.length : 0,
    step_names: Array.isArray(steps) ? steps.map((s) => s && s.name).filter(Boolean) : [],
    run_count: Number(row.run_count) || 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * 把请求体（或 confirm 的 draft）规范成数据层入参。
 * requireSteps=false 供 PUT 局部更新：steps 没传时由数据层沿用旧值。
 */
function normalizeTemplateInput(deps, source, { requireSteps = true, name } = {}) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw bad(deps, 'BAD_TEMPLATE', '模板必须是 JSON 对象');
  }
  const displayName = name !== undefined ? name : pick(source, 'name', 'name');
  if (typeof displayName !== 'string' || displayName.trim() === '') {
    throw bad(deps, 'BAD_NAME', '模板 name 必须是非空字符串');
  }

  const steps = pick(source, 'steps', 'steps');
  if (requireSteps && (steps === undefined || !Array.isArray(steps) || steps.length === 0)) {
    throw bad(deps, 'BAD_STEPS', '模板 steps 必须是非空数组');
  }
  if (steps !== undefined && !Array.isArray(steps)) {
    throw bad(deps, 'BAD_STEPS', '模板 steps 必须是数组');
  }

  const templateId = pick(source, 'template_id', 'templateId');
  if (templateId !== undefined && (typeof templateId !== 'string' || !ID_RE.test(templateId))) {
    throw bad(deps, 'BAD_TEMPLATE_ID', 'template_id 只能包含字母数字、_ . -，且以字母数字开头，最长 64');
  }

  const input = { name: displayName.trim() };
  if (templateId) input.templateId = templateId;
  if (steps !== undefined) input.steps = steps;
  const reworkRoutes = pick(source, 'rework_routes', 'reworkRoutes');
  if (reworkRoutes !== undefined) input.reworkRoutes = reworkRoutes;
  const scoring = pick(source, 'scoring', 'scoring');
  if (scoring !== undefined) input.scoring = scoring;
  const autonomy = pick(source, 'autonomy', 'autonomy');
  if (autonomy !== undefined) input.autonomy = autonomy;
  return input;
}

/** confirm 时给草稿找一个没被占用的 id：nl-xxxx 已存在就 nl-xxxx-2、-3… */
function uniqueTemplateId(db, requested) {
  const base = requested && ID_RE.test(requested) ? requested : 'tpl';
  if (!getWorkflowTemplate(db, base)) return base;
  for (let i = 2; i <= 99; i += 1) {
    const candidate = `${base}-${i}`.slice(0, 64);
    if (!getWorkflowTemplate(db, candidate)) return candidate;
  }
  return `tpl-${Date.now().toString(36)}`;
}

/** 数据层的 TypeError / RangeError 是入参错，转 400；其余照旧上抛。 */
function runWrite(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof TypeError || err instanceof RangeError) {
      const wrapped = new Error(err.message);
      wrapped.statusCode = 400;
      wrapped.code = 'BAD_TEMPLATE';
      throw wrapped;
    }
    throw err;
  }
}

export async function handleWorkflowTemplatesApi(req, res, path, method, deps = {}) {
  if (path !== BASE && !path.startsWith(`${BASE}/`)) return false;
  const m = String(method || 'GET').toUpperCase();
  const db = getDb();

  /* ---- POST /from-text ------------------------------------------------ */
  if (path === `${BASE}/from-text`) {
    if (m !== 'POST') throw deps.httpError(405, 'METHOD_NOT_ALLOWED', `${m} ${path} 不支持`);
    const body = await bodyOf(req, deps);
    const text = body.text;
    if (typeof text !== 'string' || text.trim() === '') {
      throw bad(deps, 'BAD_TEXT', 'text 必须是非空字符串');
    }
    if (text.length > MAX_TEXT) {
      throw bad(deps, 'TEXT_TOO_LONG', `text 最长 ${MAX_TEXT} 字`);
    }
    let parsed;
    try {
      parsed = parseWorkflowText(text);
    } catch (err) {
      throw bad(deps, 'PARSE_FAILED', err.message);
    }
    send(deps, res, 200, { ok: true, ...parsed });
    return true;
  }

  /* ---- POST /confirm -------------------------------------------------- */
  if (path === `${BASE}/confirm`) {
    if (m !== 'POST') throw deps.httpError(405, 'METHOD_NOT_ALLOWED', `${m} ${path} 不支持`);
    const body = await bodyOf(req, deps);
    const draft = body.draft;
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
      throw bad(deps, 'BAD_DRAFT', 'draft 必须是 from-text 返回的模板对象');
    }
    const input = normalizeTemplateInput(deps, draft, { name: body.name ?? draft.name });
    const templateId = uniqueTemplateId(db, pick(draft, 'template_id', 'templateId'));
    const created = runWrite(() => insertWorkflowTemplate(db, { ...input, templateId, version: 1 }));
    send(deps, res, 201, { ok: true, template: templateView(created, { run_count: 0 }) });
    return true;
  }

  /* ---- /api/workflow/templates ---------------------------------------- */
  if (path === BASE) {
    if (m === 'GET') {
      const rows = listWorkflowTemplateSummaries(db);
      const templates = rows.map(summaryView);
      send(deps, res, 200, {
        ok: true, generated_at: new Date().toISOString(), count: templates.length, templates,
      });
      return true;
    }
    if (m === 'POST') {
      const body = await bodyOf(req, deps);
      const input = normalizeTemplateInput(deps, pick(body, 'template', 'template') ?? body);
      const requested = input.templateId;
      if (requested && getWorkflowTemplate(db, requested)) {
        throw deps.httpError(409, 'TEMPLATE_ID_TAKEN', `template_id 已存在：${requested}`);
      }
      const created = runWrite(() => insertWorkflowTemplate(db, { ...input, version: 1 }));
      send(deps, res, 201, { ok: true, template: templateView(created, { run_count: 0 }) });
      return true;
    }
    throw deps.httpError(405, 'METHOD_NOT_ALLOWED', `${m} ${path} 不支持`);
  }

  /* ---- /api/workflow/templates/:id ------------------------------------ */
  const match = path.match(ID_PATH);
  if (!match) return false; // 未知子路径交给兜底 404
  const templateId = match[1];

  if (m === 'GET') {
    const url = new URL(req.url, 'http://127.0.0.1');
    const versionParam = url.searchParams.get('version');
    let row;
    if (versionParam !== null) {
      if (!/^\d+$/.test(versionParam) || Number(versionParam) < 1) {
        throw bad(deps, 'BAD_VERSION', 'version 必须是正整数');
      }
      row = getWorkflowTemplateVersion(db, templateId, Number(versionParam));
      if (!row) throw deps.httpError(404, 'TEMPLATE_VERSION_NOT_FOUND', `模板 ${templateId} 没有 v${versionParam}`);
    } else {
      row = getWorkflowTemplate(db, templateId);
      if (!row) throw notFound(deps, templateId);
    }
    const current = getWorkflowTemplate(db, templateId);
    const history = listWorkflowTemplateVersions(db, templateId);
    send(deps, res, 200, {
      ok: true,
      template: templateView(row, {
        is_current: current ? row.version === current.version : false,
        run_count: countWorkflowRunsByTemplate(db, templateId),
        versions: [...history.map((v) => v.version), ...(current ? [current.version] : [])],
      }),
    });
    return true;
  }

  if (m === 'PUT') {
    const current = getWorkflowTemplate(db, templateId);
    if (!current) throw notFound(deps, templateId);
    const body = await bodyOf(req, deps);
    const source = pick(body, 'template', 'template') ?? body;
    const patch = normalizeTemplateInput(deps, source, {
      requireSteps: false,
      name: pick(source, 'name', 'name') ?? current.name,
    });
    const updated = runWrite(() => updateWorkflowTemplate(db, templateId, patch));
    if (!updated) throw notFound(deps, templateId);
    send(deps, res, 200, {
      ok: true,
      template: templateView(updated, {
        is_current: true,
        run_count: countWorkflowRunsByTemplate(db, templateId),
        versions: [...listWorkflowTemplateVersions(db, templateId).map((v) => v.version), updated.version],
      }),
    });
    return true;
  }

  if (m === 'DELETE') {
    const result = deleteWorkflowTemplate(db, templateId);
    if (result.notFound) throw notFound(deps, templateId);
    if (!result.deleted) {
      send(deps, res, 409, {
        ok: false,
        code: 'TEMPLATE_IN_USE',
        error: `模板还有 ${result.runCount} 个 run 在用，不能删除`,
        run_count: result.runCount,
      });
      return true;
    }
    send(deps, res, 200, { ok: true, deleted: true, template_id: templateId });
    return true;
  }

  throw deps.httpError(405, 'METHOD_NOT_ALLOWED', `${m} ${path} 不支持`);
}
