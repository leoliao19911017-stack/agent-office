// api-workflow-runs.mjs — P0 第三步：执行状态机 HTTP 层。
//
// 挂载点：
//   POST /api/workflow/runs                     创建 run（建九条 step，第一条 running）
//   GET  /api/workflow/runs                     列表（当前步骤 + 状态）
//   GET  /api/workflow/runs/:id                 完整状态（每步状态 / 交付物 / 目标分 / 是否等 Leo）
//   POST /api/workflow/runs/:id/advance         推进；gate 不满足 → 409 + status_reason
//   POST /api/workflow/runs/:id/artifact        往某步挂交付物
//   POST /api/workflow/runs/:id/fail            标某步失败 + 原因
//   POST /api/workflow/runs/:id/rework          按失败原因路由返工
//   POST /api/workflow/runs/:id/approve         人在 gate 上确认放行
//   POST /api/workflow/runs/:runId/steps/:stepId/tasks
//                                               从任务书批量建任务，整批挂到该 run 的这一步（v9）
//
// 状态判定全部在 workflow-engine.mjs；这里只做协议转换、入参归一和错误映射。
// 403 只由引擎的 autonomy 判定抛出（must_ask 动作），本文件不另设决策边界。
//
// 看板只读辅助（P0 第四步·界面）：
//   GET /api/workflow/artifact?path=...   读 run 交付物原文（相对仓库根，只读）
//   GET /api/workflow/tasklist           读 docs/开发任务清单与完成情况.md
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from './lib/db.mjs';
import {
  createWorkflowEngine,
  WorkflowEngineError,
} from './lib/workflow-engine.mjs';
import { createWorkflowStepTasks } from './api-tasks.mjs';

const BASE = '/api/workflow/runs';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TASKLIST_REL = 'docs/开发任务清单与完成情况.md';
const MD_EXT = new Set(['.md', '.markdown', '.mdx']);
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.css',
  '.html', '.htm', '.yml', '.yaml', '.toml', '.ini', '.sh', '.ps1', '.py', '.sql']);
// 单文件读取上限：看板只用于阅读，超大日志不整份塞进浏览器。
const ARTIFACT_LIMIT = 1024 * 1024;

/** 把相对路径收进仓库根；绝对路径也必须在仓库根内。越界一律 403。 */
function resolveInsideRepo(raw) {
  const p = raw.replace(/\\/g, '/');
  const abs = resolve(REPO_ROOT, p);
  if (abs !== REPO_ROOT && !abs.startsWith(REPO_ROOT + sep)) {
    throw Object.assign(new Error(`路径不在仓库内：${raw}`), { statusCode: 403, code: 'PATH_NOT_ALLOWED' });
  }
  return abs;
}

function readTextArtifact(deps, raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw deps.httpError(400, 'MISSING_PATH', '缺少 path 参数');
  }
  let abs;
  try {
    abs = resolveInsideRepo(raw);
  } catch (err) {
    throw deps.httpError(err.statusCode || 400, err.code || 'BAD_PATH', err.message);
  }
  let st;
  try {
    st = statSync(abs);
  } catch {
    throw deps.httpError(404, 'ARTIFACT_NOT_FOUND', `交付物不存在或已被移走：${raw}`);
  }
  if (!st.isFile()) throw deps.httpError(400, 'NOT_A_FILE', `不是文件：${raw}`);
  const ext = extname(abs).toLowerCase();
  const name = abs.split(sep).pop();
  const kind = MD_EXT.has(ext) ? 'markdown' : CODE_EXT.has(ext) ? 'code' : 'text';
  if (!MD_EXT.has(ext) && !CODE_EXT.has(ext) && !['.txt', '.log', '.csv', '.xml', '.svg'].includes(ext)) {
    return {
      ok: true, path: raw, abs_path: abs, name, ext, kind: 'binary',
      bytes: st.size, lines: 0, text: '', truncated: false,
      note: '二进制文件，看板不预览；可用下载入口取原件',
      modified_at: st.mtime.toISOString(),
    };
  }
  const buf = readFileSync(abs);
  const truncated = buf.length > ARTIFACT_LIMIT;
  const text = buf.subarray(0, ARTIFACT_LIMIT).toString('utf8');
  return {
    ok: true,
    path: raw,
    abs_path: abs,
    name,
    ext,
    kind,
    bytes: st.size,
    lines: text.split(/\r?\n/).length,
    text,
    truncated,
    modified_at: st.mtime.toISOString(),
  };
}
const ID_RE = '[A-Za-z0-9][A-Za-z0-9._-]{0,63}';
const ID_PATH = new RegExp(`^${BASE}/(${ID_RE})$`);
const ACTION_PATH = new RegExp(`^${BASE}/(${ID_RE})/(advance|artifact|fail|rework|approve)$`);
// v9：/runs/:runId/steps/:stepId/tasks —— 比 :id/<action> 多两段，单独一条，不被它吞掉。
const STEP_TASKS_PATH = new RegExp(`^${BASE}/(${ID_RE})/steps/(${ID_RE})/tasks$`);

function pick(obj, ...keys) {
  for (const key of keys) {
    if (obj[key] !== undefined) return obj[key];
  }
  return undefined;
}

async function bodyOf(req, deps) {
  return typeof deps.readJsonBody === 'function' ? (await deps.readJsonBody(req)) || {} : {};
}

function send(deps, res, statusCode, payload) {
  deps.sendJson(res, statusCode, payload);
}

function bad(deps, code, message) {
  return deps.httpError(400, code, message);
}

/** 引擎错误 → HTTP；数据层的 TypeError / RangeError 是入参错转 400；其余照旧上抛。 */
function translate(deps, err) {
  if (err instanceof WorkflowEngineError) {
    return deps.httpError(err.statusCode, err.code, err.message);
  }
  if (err instanceof TypeError || err instanceof RangeError) {
    return deps.httpError(400, 'BAD_WORKFLOW_RUN', err.message);
  }
  return err;
}

function runOrThrow(operation, deps) {
  try {
    return operation();
  } catch (err) {
    throw translate(deps, err);
  }
}

/** 推进 / 确认的公共入参：保持宽松，但只把认得的字段传给引擎。 */
function advanceOpts(body) {
  const opts = {};
  if (body.approved !== undefined) opts.approved = body.approved === true;
  const humanDone = pick(body, 'human_done', 'humanDone');
  if (humanDone !== undefined) opts.humanDone = humanDone === true;
  if (body.criteria !== undefined) opts.criteria = body.criteria === true;
  if (body.score !== undefined) opts.score = body.score;
  const hardCriteriaPass = pick(body, 'hard_criteria_pass', 'hardCriteriaPass');
  if (hardCriteriaPass !== undefined) opts.hardCriteriaPass = hardCriteriaPass === true;
  if (body.action !== undefined) opts.action = body.action;
  if (body.by !== undefined) opts.by = body.by;
  if (body.note !== undefined) opts.note = body.note;
  return opts;
}

export async function handleWorkflowRunsApi(req, res, path, method, deps = {}) {
  const m = String(method || 'GET').toUpperCase();

  /* ---- GET /api/workflow/artifact?path=... 交付物原文（只读） ---------- */
  if (path === '/api/workflow/artifact') {
    if (m !== 'GET') throw deps.httpError(405, 'METHOD_NOT_ALLOWED', `${m} ${path} 不支持`);
    const url = new URL(req.url, 'http://127.0.0.1');
    const raw = url.searchParams.get('path') || '';
    send(deps, res, 200, readTextArtifact(deps, raw));
    return true;
  }

  /* ---- GET /api/workflow/tasklist 开发任务清单（Markdown 原文） -------- */
  if (path === '/api/workflow/tasklist') {
    if (m !== 'GET') throw deps.httpError(405, 'METHOD_NOT_ALLOWED', `${m} ${path} 不支持`);
    let payload;
    try {
      payload = readTextArtifact(deps, TASKLIST_REL);
    } catch (err) {
      if (err && err.statusCode === 404) {
        throw deps.httpError(404, 'TASKLIST_NOT_FOUND', `任务清单不存在：${TASKLIST_REL}`);
      }
      throw err;
    }
    send(deps, res, 200, payload);
    return true;
  }

  if (path !== BASE && !path.startsWith(`${BASE}/`)) return false;

  /* ---- POST /api/workflow/runs/:runId/steps/:stepId/tasks 从任务书批量建任务（v9） ---- */
  // 挂点在路径上；建任务的逻辑与错误码（404 RUN_NOT_FOUND / STEP_NOT_FOUND、400）在
  // api-tasks.mjs——所有写 tasks 表的入口放在那边。不碰状态机：建任务不推进步骤。
  const stepTasksMatch = path.match(STEP_TASKS_PATH);
  if (stepTasksMatch) {
    if (m !== 'POST') throw deps.httpError(405, 'METHOD_NOT_ALLOWED', `${m} ${path} 不支持`);
    return createWorkflowStepTasks(req, res, stepTasksMatch[1], stepTasksMatch[2], deps);
  }

  const engine = createWorkflowEngine(getDb());

  /* ---- POST /api/workflow/runs ---------------------------------------- */
  if (path === BASE) {
    if (m === 'GET') {
      const url = new URL(req.url, 'http://127.0.0.1');
      const status = url.searchParams.get('status');
      const templateId = url.searchParams.get('template_id') ?? url.searchParams.get('templateId');
      const runs = runOrThrow(
        () => engine.listRunStates({
          ...(status !== null ? { status } : {}),
          ...(templateId !== null ? { templateId } : {}),
        }),
        deps,
      );
      send(deps, res, 200, {
        ok: true,
        generated_at: new Date().toISOString(),
        count: runs.length,
        // 看板左侧列表直接要的字段（D）：
        // current_step = 当前步骤号字符串 "07"；step_index = 数字 7；
        // step_name = 当前步名；done_steps/total_steps/target_score = 进度与目标分。
        // 旧字段（current_step_id / current_step_name / progress…）原样保留，不破坏已有调用方。
        runs: runs.map((run) => ({
          ...run,
          current_step: run.current_step_id,
          step_name: run.current_step_name,
          done_steps: run.progress ? run.progress.done : 0,
          percent: run.progress ? run.progress.percent : 0,
        })),
      });
      return true;
    }
    if (m === 'POST') {
      const body = await bodyOf(req, deps);
      const templateId = pick(body, 'template_id', 'templateId');
      if (typeof templateId !== 'string' || templateId.trim() === '') {
        throw bad(deps, 'BAD_TEMPLATE_ID', 'template_id 必须是非空字符串');
      }
      const title = pick(body, 'title', 'title');
      const baseline = pick(body, 'requirement_baseline', 'requirementBaseline');
      const targetScore = pick(body, 'target_score', 'targetScore');
      const state = runOrThrow(
        () => engine.createRun(templateId, {
          title,
          requirementBaseline: baseline,
          targetScore,
        }),
        deps,
      );
      send(deps, res, 201, { ok: true, run: state });
      return true;
    }
    throw deps.httpError(405, 'METHOD_NOT_ALLOWED', `${m} ${path} 不支持`);
  }

  /* ---- /api/workflow/runs/:id ----------------------------------------- */
  const idMatch = path.match(ID_PATH);
  if (idMatch) {
    const runId = idMatch[1];
    if (m !== 'GET') throw deps.httpError(405, 'METHOD_NOT_ALLOWED', `${m} ${path} 不支持`);
    const state = runOrThrow(() => engine.getRunState(runId), deps);
    if (!state) throw deps.httpError(404, 'RUN_NOT_FOUND', `run 不存在：${runId}`);
    send(deps, res, 200, { ok: true, run: state });
    return true;
  }

  /* ---- /api/workflow/runs/:id/<action> -------------------------------- */
  const actionMatch = path.match(ACTION_PATH);
  if (!actionMatch) return false;
  const [, runId, action] = actionMatch;
  if (m !== 'POST') throw deps.httpError(405, 'METHOD_NOT_ALLOWED', `${m} ${path} 不支持`);
  const body = await bodyOf(req, deps);

  if (action === 'advance') {
    const result = runOrThrow(() => engine.advanceStep(runId, advanceOpts(body)), deps);
    if (!result.advanced) {
      // 409 + 原因：状态已经落成 waiting_human，这里把 gate 和原因一起回给调用方。
      send(deps, res, 409, {
        ok: false,
        code: 'GATE_NOT_SATISFIED',
        error: result.gate.reason,
        status_reason: result.state.status_reason,
        gate: result.gate,
        step_id: result.state.current_step_id,
        run: result.state,
      });
      return true;
    }
    send(deps, res, 200, {
      ok: true,
      advanced: true,
      gate: result.gate,
      next_step_id: result.next_step_id ?? null,
      completed: result.completed === true,
      run: result.state,
    });
    return true;
  }

  if (action === 'approve') {
    const result = runOrThrow(() => engine.approve(runId, advanceOpts(body)), deps);
    send(deps, res, 200, {
      ok: true,
      approved: true,
      completed: result.completed === true,
      next_step_id: result.next_step_id ?? null,
      run: result.state,
    });
    return true;
  }

  if (action === 'artifact') {
    const stepId = pick(body, 'step_id', 'stepId');
    if (typeof stepId !== 'string' || stepId.trim() === '') {
      throw bad(deps, 'BAD_STEP_ID', 'step_id 必须是非空字符串');
    }
    const artifacts = pick(body, 'artifacts', 'artifacts') ?? pick(body, 'artifact', 'artifact');
    const result = runOrThrow(() => engine.recordArtifact(runId, stepId, artifacts), deps);
    send(deps, res, 200, { ok: true, step_id: result.step_id, artifacts: result.artifacts, run: result.state });
    return true;
  }

  if (action === 'fail') {
    const stepId = pick(body, 'step_id', 'stepId');
    if (typeof stepId !== 'string' || stepId.trim() === '') {
      throw bad(deps, 'BAD_STEP_ID', 'step_id 必须是非空字符串');
    }
    const reason = pick(body, 'reason', 'reason');
    const result = runOrThrow(() => engine.failStep(runId, stepId, reason), deps);
    send(deps, res, 200, { ok: true, step_id: result.step_id, reason: result.reason, run: result.state });
    return true;
  }

  // rework
  const cause = pick(body, 'failure_cause', 'failureCause', 'cause', 'reason');
  const opts = {};
  if (body.action !== undefined) opts.action = body.action;
  const result = runOrThrow(() => engine.rework(runId, cause, opts), deps);
  send(deps, res, 200, { ok: true, ...result });
  return true;
}
