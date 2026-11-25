// tasks-rework-harness.mjs — 返工验收（test/tasks-rework.test.js）的进程内夹具（node --test 不收本文件）。
//
// 为什么要它：C5 要验「停止动作能终止真实执行」。真实执行器是 web/adapters/dsh.mjs 的 startDshAttempt，
// 它起的子进程和停止句柄都在调用它的那个进程里；web/server.js 里没有任何入口会在服务进程内调用它。
// 所以这里在同一个进程里做两件事：
//   1. 用生产代码 handleTasksApi 挂任务 API（路由 / 状态码 / 错误码全是生产代码，不 mock）；
//   2. 直接调用生产代码 startDshAttempt 起一个真实的长跑进程（test/fixtures/tasks-longrun-worker.mjs）。
// 「停止」走 HTTP → 同进程的注册表 → 执行器的 stop() → 进程真的退出。
//
// 另外能当「预演服务器」用：webDir 指向哪，就看板静态文件从哪读（web/board-cromma.* 是每次请求从磁盘读的，
// 所以可以先把前端改在暂存目录里对着这里验，验过了再放进 web/）。静态文件清单与 web/server.js 的
// 看板那几项一致；JSON 错误体的形状（{ error, code }、5xx 不回传内部细节）也照 server.js 的收口写。
//
// 隔离：临时库（AGENT_OFFICE_DB 指过去）、随机端口、不碰 data/agent-office.db、不抢 8090。
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleTasksApi } from '../../web/api-tasks.mjs';
import { handleWorkflowRunsApi } from '../../web/api-workflow-runs.mjs';
import { openDb, closeDb } from '../../web/lib/db.mjs';
// 整个命名空间引入：返工前的旧代码没有 listLiveAttempts，静态解构会让整个测试文件加载失败，
// 那样「修之前先跑一遍看它红不红」就看不到逐条的真实结果了。
import * as dshAdapter from '../../web/adapters/dsh.mjs';

const { startDshAttempt } = dshAdapter;
const listLiveAttempts = () => (typeof dshAdapter.listLiveAttempts === 'function' ? dshAdapter.listLiveAttempts() : null);

export const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));   // 仓库根
export const WEB_DIR = join(ROOT, 'web');
export const FIXTURES = join(ROOT, 'test', 'fixtures');

/** 与 web/server.js 看板静态白名单里的看板几项一致。 */
const STATIC = {
  '/board-cromma.html': 'text/html; charset=utf-8',
  '/board-cromma.css': 'text/css; charset=utf-8',
  '/board-cromma.js': 'application/javascript; charset=utf-8',
  '/board-agent-admin.js': 'application/javascript; charset=utf-8',
  '/board-chat.css': 'text/css; charset=utf-8',
  '/board-chat.js': 'application/javascript; charset=utf-8',
};

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

/** 与 server.js 同口径：空体当 {}；非法 JSON 400；超过 1MB 断开。 */
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

/**
 * 起一个进程内服务：任务 API + 看板静态文件 + 能在同进程起托管执行。
 * @param {{webDir?: string, dbPath?: string}} [opts]
 */
export async function startReworkServer(opts = {}) {
  const webDir = opts.webDir || WEB_DIR;
  const home = mkdtempSync(join(tmpdir(), 'tasks-rework-'));
  const dbPath = opts.dbPath || join(home, 'agent-office.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  const previousDbEnv = process.env.AGENT_OFFICE_DB;
  process.env.AGENT_OFFICE_DB = dbPath;
  const db = openDb({ path: dbPath });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;
    const method = req.method || 'GET';
    try {
      if ((method === 'GET' || method === 'HEAD') && STATIC[path]) {
        const buf = readFileSync(join(webDir, path.slice(1)));
        res.writeHead(200, { 'content-type': STATIC[path], 'cache-control': 'no-cache' });
        res.end(method === 'HEAD' ? undefined : buf);
        return;
      }
      if ((method === 'GET' || method === 'HEAD') && path.startsWith('/icons/')) {
        const seg = path.slice('/icons/'.length);
        const file = join(webDir, 'icons', seg);
        if (!/^[A-Za-z0-9._-]+\.svg$/.test(seg) || seg.includes('..') || !existsSync(file)) {
          throw httpError(404, 'NOT_FOUND', '资源不存在');
        }
        const buf = readFileSync(file);
        res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-cache' });
        res.end(method === 'HEAD' ? undefined : buf);
        return;
      }
      let handled = await handleTasksApi(req, res, path, method, { sendJson, readJsonBody, httpError });
      // 工作流 run 的路由也挂上（真实 server.js 里先于任务 API 分发）：左栏的工作流下拉要读 run 列表、
      // 从任务书批量建任务也走它。同样全是生产代码，不 mock。
      if (!handled) handled = await handleWorkflowRunsApi(req, res, path, method, { sendJson, readJsonBody, httpError });
      if (!handled) sendJson(res, 404, { error: `${method} ${path} 不存在（夹具只挂任务 API 和工作流 run API）`, code: 'NOT_FOUND' });
    } catch (err) {
      const statusCode = err.statusCode || 500;
      if (statusCode >= 500) console.error(`[错误] ${method} ${path} → ${err.code}: ${err.message}`);
      // 与 server.js 同口径：4xx 的结构化附加字段（停止确认要绑定的 attempt_id，R2-1）原样带给前端。
      sendJson(res, statusCode, {
        error: statusCode >= 500 ? '服务内部错误' : err.message,
        code: err.code || 'INTERNAL',
        ...(statusCode < 500 && err.details ? err.details : {}),
      });
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* 非 JSON 保留 null */ }
    return { status: res.status, body: json };
  };

  let workerSeq = 0;
  /**
   * 用生产代码的托管执行器起一个真实的长跑进程（不调用任何模型）。
   * @returns {Promise<{handle: object, pidFile: string, stateFile: string}>}
   */
  const startManaged = async (taskId) => {
    workerSeq += 1;
    const pidFile = join(home, `worker-${workerSeq}.pid`);
    const stateFile = join(home, `worker-${workerSeq}.state`);
    const handle = await startDshAttempt({
      db,
      taskId,
      prompt: '返工验收：长跑夹具，等到被停止',
      // 直接用 node 可执行文件（不是 .cmd）：子进程就是 worker 本身，pid 不会被 cmd.exe 包一层
      command: process.execPath,
      args: [join(FIXTURES, 'tasks-longrun-worker.mjs')],
      env: { LONGRUN_PID_FILE: pidFile, LONGRUN_STATE_FILE: stateFile },
    });
    return { handle, pidFile, stateFile };
  };

  return {
    base, db, dbPath, home, call, startManaged,
    liveAttempts: listLiveAttempts,    async stop() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      closeDb(db);
      if (previousDbEnv === undefined) delete process.env.AGENT_OFFICE_DB;
      else process.env.AGENT_OFFICE_DB = previousDbEnv;
      rmSync(home, { recursive: true, force: true });
    },
  };
}
