// Soda Office HTTP API 层（Task 1.2：Agent 注册与状态；Task 1.3：任务提交与原子领取；Task 1.4：事件流；
// Task 2.1：租约续约 / 可疑任务 / 处置 / 带 token 的状态更新）。
// 零框架：node:http + 手写 JSON 解析，所有错误统一 { error, code }（claim / renew / resolve /
// 带token PATCH 的 409 例外，按接口契约返回 { ok: false, reason }）。
// 心跳口径：注册即首次心跳；每次状态更新都刷新 last_heartbeat（状态更新就是心跳）。
import { createServer } from 'node:http';
import {
  AGENT_STATUSES,
  EVENT_TYPES,
  TASK_STATUSES,
  insertAgent,
  listAgents,
  findAgentByName,
  updateAgentStatus,
  getAgentById,
  insertTask,
  getTaskById,
  listTasks,
  claimTask,
  updateTaskStatus,
  updateTaskStatusWithToken,
  renewLease,
  listSuspectTasks,
  resolveSuspectTask,
  RESOLVE_ACTIONS,
  insertEvent,
  listEventsByTask,
  listRecentEvents,
} from './db.js';

const DEFAULT_PORT = 3100;
const DEFAULT_STALE_MS = 60_000;

/** 端口优先级：显式入参 > 环境变量 PORT（须为非负整数）> 默认 3100。0 = 随机端口。 */
function resolvePort(port) {
  if (port !== undefined) return port;
  if (process.env.PORT !== undefined && process.env.PORT !== '') {
    const n = Number(process.env.PORT);
    if (Number.isInteger(n) && n >= 0) return n;
  }
  return DEFAULT_PORT;
}

/** 心跳超时阈值（毫秒）。每个请求实时读环境变量 STALE_MS，测试可动态改；非法值回落默认。 */
function staleMs() {
  const v = Number(process.env.STALE_MS);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_STALE_MS;
}

/** 带 HTTP 状态码与业务 code 的错误，路由层统一转成 JSON 响应。 */
function httpError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** 手写请求体解析：空体当 {}；非法 JSON 400；超过 1MB 直接断开（拒绝无界读）。 */
function readJsonBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      if ((size += chunk.length) > limit) {
        req.destroy();
        reject(httpError(413, 'BODY_TOO_LARGE', `请求体超过 ${limit} 字节`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text === '') return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(httpError(400, 'INVALID_JSON', '请求体不是合法 JSON'));
      }
    });
    req.on('error', (err) => reject(Object.assign(err, { statusCode: 400, code: 'BODY_READ_FAILED' })));
  });
}

/** 数据库行 → API 形状：capabilities 从 JSON 字符串还原为数组。 */
function toApi(row) {
  const { capabilities, ...rest } = row;
  return { ...rest, capabilities: JSON.parse(capabilities) };
}

/** POST /api/agents/register — 注册；name 查重 409，缺/空 name 400，注册即首次心跳。 */
async function handleRegister(req, res, db) {
  const body = await readJsonBody(req);
  if (typeof body.name !== 'string' || body.name.trim() === '') {
    throw httpError(400, 'INVALID_NAME', 'name 必须是非空字符串');
  }
  const name = body.name.trim();
  if (findAgentByName(db, name)) {
    throw httpError(409, 'NAME_CONFLICT', `同名 Agent 已注册：${name}`);
  }
  let row;
  try {
    row = insertAgent(db, {
      name,
      type: body.type,
      capabilities: body.capabilities,
      lastHeartbeat: Date.now(), // 注册即首次心跳，否则刚注册就会因 null 被判 stale
    });
  } catch (err) {
    // insertAgent 的参数校验（type/capabilities 类型）不过 → 调用方问题
    if (err instanceof TypeError || err instanceof RangeError) {
      throw httpError(400, 'INVALID_AGENT', err.message);
    }
    throw err;
  }
  sendJson(res, 201, toApi(row));
}

/** PATCH /api/agents/:id/status — 改状态并刷心跳；非法状态 400，Agent 不存在 404。 */
async function handleStatusPatch(req, res, db, id) {
  const body = await readJsonBody(req);
  if (!AGENT_STATUSES.includes(body.status)) {
    throw httpError(
      400,
      'INVALID_STATUS',
      `status 必须是 ${AGENT_STATUSES.join(' / ')} 之一，收到：${JSON.stringify(body.status)}`,
    );
  }
  const row = updateAgentStatus(db, id, body.status); // 内部把 last_heartbeat 刷成 Date.now()
  if (row === null) throw httpError(404, 'AGENT_NOT_FOUND', `Agent 不存在：${id}`);
  sendJson(res, 200, toApi(row));
}

/** GET /api/agents — 全量列表，每个 Agent 附计算字段 stale（心跳超时或从未心跳）。 */
function handleList(res, db) {
  const now = Date.now(); // 同一列表用同一时刻判定，快照一致
  const agents = listAgents(db).map((row) => ({
    ...toApi(row),
    stale: row.last_heartbeat === null || now - row.last_heartbeat > staleMs(),
  }));
  sendJson(res, 200, { agents });
}

// ---------------------------------------------------------------------------
// 任务（Task 1.3）
// ---------------------------------------------------------------------------

/**
 * POST /api/tasks — 建任务，成功 201 返回完整任务行。
 * 缺/空 title 400；assignee 给了但 agent 不存在 404（先验存在再落库，外键只是兜底）。
 */
async function handleCreateTask(req, res, db) {
  const body = await readJsonBody(req);
  if (typeof body.title !== 'string' || body.title.trim() === '') {
    throw httpError(400, 'INVALID_TITLE', 'title 必须是非空字符串');
  }
  if (body.assignee != null) {
    if (typeof body.assignee !== 'string') {
      throw httpError(400, 'INVALID_ASSIGNEE', 'assignee 必须是字符串（agent id）或 null');
    }
    if (!getAgentById(db, body.assignee)) {
      throw httpError(404, 'AGENT_NOT_FOUND', `assignee 指向的 Agent 不存在：${body.assignee}`);
    }
  }
  let row;
  try {
    row = insertTask(db, {
      title: body.title,
      description: body.description,
      assignee: body.assignee ?? null,
    });
  } catch (err) {
    // insertTask 的参数校验（description 类型）不过 → 调用方问题
    if (err instanceof TypeError || err instanceof RangeError) {
      throw httpError(400, 'INVALID_TASK', err.message);
    }
    throw err;
  }
  sendJson(res, 201, row);
}

/**
 * POST /api/tasks/:id/claim — 原子领取（db.claimTask 单条 UPDATE 定输赢）。
 * 成功 200 { ok: true, task }；被抢先 409 { ok: false, reason: 'not_queued' }；
 * 缺 agent_id 400；任务或 Agent 不存在 404（假 id 不许领任务）。
 */
async function handleClaim(req, res, db, id) {
  const body = await readJsonBody(req);
  if (typeof body.agent_id !== 'string' || body.agent_id === '') {
    throw httpError(400, 'INVALID_AGENT_ID', 'agent_id 必须是非空字符串');
  }
  if (!getAgentById(db, body.agent_id)) {
    throw httpError(404, 'AGENT_NOT_FOUND', `Agent 不存在：${body.agent_id}`);
  }
  const result = claimTask(db, id, body.agent_id);
  if (result.ok) {
    sendJson(res, 200, result);
    return;
  }
  // 没抢到：区分"任务不存在"与"状态不是 queued"。这只是输赢定局后的归因查询，
  // 领取成败本身已由 UPDATE 的 changes 原子判定，这里的 SELECT 不参与判定。
  if (!getTaskById(db, id)) throw httpError(404, 'TASK_NOT_FOUND', `任务不存在：${id}`);
  sendJson(res, 409, { ok: false, reason: 'not_queued' });
}

/**
 * PATCH /api/tasks/:id/status — 非法状态 400，任务不存在 404，成功 200 返回更新后的行。
 *
 * Task 2.1 增强：请求体带 claim_token 时启用所有权校验（db.updateTaskStatusWithToken，
 * token 不匹配 409，一行不写）。这是"旧执行者失去所有权后覆盖新结果"的 API 层闸门。
 *
 * 兼容口径（有意为之，不是疏漏）：不带 claim_token 的请求仍走 Task 1.3 老语义
 * （updateTaskStatus，不校验）。原因：Task 1.3 的契约测试就是"claim 后不带 token
 * PATCH"，严格必填会把它们打成 400；Task 2.3 真实 Agent 接入前，不带 token 的
 * 调用方（人工 CLI 等）仍需可用。真实保护由带 token 路径 + DB 层函数保证，
 * 待 Agent 全面接入后可切严格模式（缺 token 即 400）。
 */
async function handleTaskStatusPatch(req, res, db, id) {
  const body = await readJsonBody(req);
  if (!TASK_STATUSES.includes(body.status)) {
    throw httpError(
      400,
      'INVALID_STATUS',
      `status 必须是 ${TASK_STATUSES.join(' / ')} 之一，收到：${JSON.stringify(body.status)}`,
    );
  }
  if (body.claim_token !== undefined) {
    if (typeof body.claim_token !== 'string' || body.claim_token === '') {
      throw httpError(400, 'INVALID_CLAIM_TOKEN', 'claim_token 必须是非空字符串');
    }
    let result;
    try {
      result = updateTaskStatusWithToken(db, id, body.claim_token, body.status, {
        result_path: body.result_path,
      });
    } catch (err) {
      if (err instanceof TypeError) throw httpError(400, 'INVALID_RESULT_PATH', err.message);
      throw err;
    }
    if (result.ok) {
      sendJson(res, 200, result.task);
      return;
    }
    if (result.reason === 'not_found') throw httpError(404, 'TASK_NOT_FOUND', `任务不存在：${id}`);
    sendJson(res, 409, { ok: false, reason: 'token_mismatch' });
    return;
  }
  let row;
  try {
    row = updateTaskStatus(db, id, body.status, { result_path: body.result_path });
  } catch (err) {
    if (err instanceof TypeError) throw httpError(400, 'INVALID_RESULT_PATH', err.message);
    throw err;
  }
  if (row === null) throw httpError(404, 'TASK_NOT_FOUND', `任务不存在：${id}`);
  sendJson(res, 200, row);
}

// ---------------------------------------------------------------------------
// 租约与安全恢复（Task 2.1）
// ---------------------------------------------------------------------------

/**
 * POST /api/tasks/:id/renew — 持有者续约。
 * 成功 200 { ok: true, lease_expires_at }；token 不匹配 / 任务已终态 409
 * { ok: false, reason }；缺 claim_token 400；任务不存在 404。
 */
async function handleRenew(req, res, db, id) {
  const body = await readJsonBody(req);
  if (typeof body.claim_token !== 'string' || body.claim_token === '') {
    throw httpError(400, 'INVALID_CLAIM_TOKEN', 'claim_token 必须是非空字符串');
  }
  const result = renewLease(db, id, body.claim_token);
  if (result.ok) {
    sendJson(res, 200, result);
    return;
  }
  if (result.reason === 'not_found') throw httpError(404, 'TASK_NOT_FOUND', `任务不存在：${id}`);
  sendJson(res, 409, { ok: false, reason: result.reason }); // token_mismatch | not_active
}

/** GET /api/tasks/:id — 单条任务详情；任务不存在 404。
 *  为什么要有：Runner 与验收脚本需要轮询单个任务状态，用 GET /api/tasks?status= 全量拉再筛
 *  既低效又容易把别的任务混进来。 */
function handleGetTask(res, db, id) {
  const task = getTaskById(db, id);
  if (task === null) throw httpError(404, 'TASK_NOT_FOUND', `任务不存在：${id}`);
  sendJson(res, 200, { task });
}

/**
 * GET /api/tasks/suspect — 可疑任务列表（claimed/running 且租约已过期）。
 * 每条附 lease_expired_ms（已过期多久）。只列不处置：租约超时不能证明进程已死，
 * 回收必须经 POST /api/tasks/:id/resolve 由人工/策略明确触发。
 */
function handleListSuspects(res, db) {
  const now = Date.now(); // 列表与过期时长用同一时刻，快照一致
  const tasks = listSuspectTasks(db, now).map((row) => ({
    ...row,
    lease_expired_ms: now - row.lease_expires_at,
  }));
  sendJson(res, 200, { tasks });
}

/**
 * POST /api/tasks/:id/resolve — 处置可疑任务（requeue / block / fail）。
 * 只能处置真可疑的（活跃态 + 租约已过期，WHERE 卡死），否则 409 not_suspect；
 * action 非法 400；任务不存在 404；成功 200 返回处置后的任务行。
 */
async function handleResolve(req, res, db, id) {
  const body = await readJsonBody(req);
  if (!RESOLVE_ACTIONS.includes(body.action)) {
    throw httpError(
      400,
      'INVALID_ACTION',
      `action 必须是 ${RESOLVE_ACTIONS.join(' / ')} 之一，收到：${JSON.stringify(body.action)}`,
    );
  }
  const result = resolveSuspectTask(db, id, body.action);
  if (result.ok) {
    // 与其它读接口保持一致：包一层 { task }，调用方不用记哪个接口是裸对象
    sendJson(res, 200, { task: result.task });
    return;
  }
  if (result.reason === 'not_found') throw httpError(404, 'TASK_NOT_FOUND', `任务不存在：${id}`);
  sendJson(res, 409, { ok: false, reason: 'not_suspect' });
}

/** GET /api/tasks?status=queued — 按状态筛（不传返回全部），created_at 倒序。 */
function handleListTasks(res, db, searchParams) {
  const status = searchParams.get('status') ?? undefined;
  if (status !== undefined && !TASK_STATUSES.includes(status)) {
    throw httpError(
      400,
      'INVALID_STATUS_FILTER',
      `status 必须是 ${TASK_STATUSES.join(' / ')} 之一，收到：${status}`,
    );
  }
  sendJson(res, 200, { tasks: listTasks(db, status === undefined ? {} : { status }) });
}

// ---------------------------------------------------------------------------
// 事件（Task 1.4）
// ---------------------------------------------------------------------------

/** 事件行 → API 形状：payload 从 JSON 字符串还原为对象。吐出去必须是对象，不许裸字符串。 */
function eventToApi(row) {
  return { ...row, payload: JSON.parse(row.payload) };
}

/** 解析 ?limit= 查询参数：缺省传 undefined（走 DB 层默认值），否则转数字；非法值由 DB 层回落默认。 */
function limitFromQuery(searchParams) {
  const raw = searchParams.get('limit');
  return raw === null ? undefined : Number(raw);
}

/**
 * POST /api/events — 上报事件，成功 201 返回落库行（payload 已还原为对象）。
 * type 非法 400；task_id / agent_id 给了但不存在 404（先验存在再落库，外键只是兜底）；
 * 两者都可省略或显式 null（系统级事件）。
 */
async function handleCreateEvent(req, res, db) {
  const body = await readJsonBody(req);
  if (!EVENT_TYPES.includes(body.type)) {
    throw httpError(
      400,
      'INVALID_EVENT_TYPE',
      `type 必须是 ${EVENT_TYPES.join(' / ')} 之一，收到：${JSON.stringify(body.type)}`,
    );
  }
  if (body.task_id != null) {
    if (typeof body.task_id !== 'string') {
      throw httpError(400, 'INVALID_TASK_ID', 'task_id 必须是字符串（任务 id）或 null');
    }
    if (!getTaskById(db, body.task_id)) {
      throw httpError(404, 'TASK_NOT_FOUND', `task_id 指向的任务不存在：${body.task_id}`);
    }
  }
  if (body.agent_id != null) {
    if (typeof body.agent_id !== 'string') {
      throw httpError(400, 'INVALID_AGENT_ID', 'agent_id 必须是字符串（agent id）或 null');
    }
    if (!getAgentById(db, body.agent_id)) {
      throw httpError(404, 'AGENT_NOT_FOUND', `agent_id 指向的 Agent 不存在：${body.agent_id}`);
    }
  }
  let row;
  try {
    row = insertEvent(db, {
      task_id: body.task_id ?? null,
      agent_id: body.agent_id ?? null,
      type: body.type,
      payload: body.payload,
    });
  } catch (err) {
    // insertEvent 的参数校验（payload 类型）不过 → 调用方问题
    if (err instanceof TypeError || err instanceof RangeError) {
      throw httpError(400, 'INVALID_EVENT', err.message);
    }
    throw err;
  }
  sendJson(res, 201, eventToApi(row));
}

/** GET /api/tasks/:id/events — 该任务的事件流（created_at 升序）；任务不存在 404。 */
function handleListTaskEvents(res, db, id, searchParams) {
  if (!getTaskById(db, id)) throw httpError(404, 'TASK_NOT_FOUND', `任务不存在：${id}`);
  const events = listEventsByTask(db, id, { limit: limitFromQuery(searchParams) }).map(eventToApi);
  sendJson(res, 200, { events });
}

/** GET /api/events — 全量最近事件（created_at 倒序），默认 50 条。 */
function handleListEvents(res, db, searchParams) {
  const events = listRecentEvents(db, { limit: limitFromQuery(searchParams) }).map(eventToApi);
  sendJson(res, 200, { events });
}

async function route(req, res, db) {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;

  if (req.method === 'POST' && pathname === '/api/agents/register') {
    return handleRegister(req, res, db);
  }
  if (req.method === 'GET' && pathname === '/api/agents') {
    return handleList(res, db);
  }
  if (req.method === 'POST' && pathname === '/api/tasks') {
    return handleCreateTask(req, res, db);
  }
  if (req.method === 'GET' && pathname === '/api/tasks') {
    return handleListTasks(res, db, url.searchParams);
  }
  if (req.method === 'GET' && pathname === '/api/tasks/suspect') {
    return handleListSuspects(res, db);
  }
  if (req.method === 'POST' && pathname === '/api/events') {
    return handleCreateEvent(req, res, db);
  }
  if (req.method === 'GET' && pathname === '/api/events') {
    return handleListEvents(res, db, url.searchParams);
  }
  // id 是自家生成的 UUID，不需要 percent-decode（decodeURIComponent 遇畸形编码还会抛错）
  const m = req.method === 'PATCH' ? pathname.match(/^\/api\/agents\/([^/]+)\/status$/) : null;
  if (m) return handleStatusPatch(req, res, db, m[1]);
  const mClaim = req.method === 'POST' ? pathname.match(/^\/api\/tasks\/([^/]+)\/claim$/) : null;
  if (mClaim) return handleClaim(req, res, db, mClaim[1]);
  const mRenew = req.method === 'POST' ? pathname.match(/^\/api\/tasks\/([^/]+)\/renew$/) : null;
  if (mRenew) return handleRenew(req, res, db, mRenew[1]);
  const mResolve = req.method === 'POST' ? pathname.match(/^\/api\/tasks\/([^/]+)\/resolve$/) : null;
  if (mResolve) return handleResolve(req, res, db, mResolve[1]);
  const mTaskStatus = req.method === 'PATCH' ? pathname.match(/^\/api\/tasks\/([^/]+)\/status$/) : null;
  if (mTaskStatus) return handleTaskStatusPatch(req, res, db, mTaskStatus[1]);
  const mTaskGet = req.method === 'GET' ? pathname.match(/^\/api\/tasks\/([^/]+)$/) : null;
  if (mTaskGet) return handleGetTask(res, db, mTaskGet[1]);
  const mTaskEvents = req.method === 'GET' ? pathname.match(/^\/api\/tasks\/([^/]+)\/events$/) : null;
  if (mTaskEvents) return handleListTaskEvents(res, db, mTaskEvents[1], url.searchParams);

  throw httpError(404, 'NOT_FOUND', `接口不存在：${req.method} ${pathname}`);
}

/**
 * 起服务并开始监听，返回 server 实例（测试传 port: 0 拿随机端口 + 内存库）。
 * 端口取值见 resolvePort。
 */
export function startServer({ port, db } = {}) {
  if (!db) throw new TypeError('startServer 需要 db（用 initializeDatabase 创建）');
  const server = createServer((req, res) => {
    route(req, res, db).catch((err) => {
      if (res.headersSent || res.destroyed) {
        res.destroy(); // 响应已开头或连接已断，只能掐掉
        return;
      }
      sendJson(res, err.statusCode ?? 500, {
        error: err.message ?? '服务器内部错误',
        code: err.code ?? 'INTERNAL_ERROR',
      });
    });
  });
  server.listen(resolvePort(port));
  return server;
}
