// Soda Agent 工作台 — Web 看板服务（TASK-3.1）
//
// 架构（两层，owner key 不出服务端）：
//
//   浏览器 ──► 本服务 127.0.0.1:8080 ──► Autoloop 中台 127.0.0.1:3350
//                ↑ 从 config.json 读 owner key，只在进程内存里
//
// 本服务是「动作白名单代理」，不是透明转发：前端只能调白名单内的 /api/* 接口
// （路由清单见 server-api.mjs），
// 不能借助它任意访问中台。owner key 不写日志、不返回给前端、出错也不透传。
// 零依赖：node:http + 全局 fetch（Node >= 18，本项目要求 Node 24）。

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
// G02 拆分（R73 第 73 轮收口）：决策闭环核心（纯逻辑）在 server-core.mjs，由
// server-api.mjs 直接引用；/api/* 路由（G02 时 17 个，TASK-向导化改造后 20 个）
// 也在 server-api.mjs（createApiRouter
// 工厂注入环境依赖）。本文件只剩启动配置、HTTP 小工具、静态白名单与错误收口。
import { createApiRouter } from './server-api.mjs';
// TASK-R87整改 X01：需求讨论自动推进器——重启后恢复中断的讨论（只碰新建流程任务）
import { resumeInterruptedAuto } from './server-auto.mjs';
// Agent Chat：停机时把在跑的聊天轮次落库（SIGINT 处理里用）
import { chatEngine } from './chat/chat-engine.mjs';

/**
 * 产物库允许读取的根目录白名单。
 * 只允许读工作产物所在目录——不接受任意绝对路径，
 * 否则一个 path 参数就能把整台机器读空。
 */
const HERE = dirname(fileURLToPath(import.meta.url)); // web/ 目录（提前定义，白名单要用）

const FILE_ROOTS = [
  'C:/Tools/agent-autoloop/office-data',
  'C:/Tools/agent-autoloop/output',
  'C:/Tools/agent-autoloop/worker',
  'C:/Users/Administrator/Desktop/Soda Intelligence - AI Native Thinking/Soda Office',
  dirname(HERE), // 仓库自身根目录（搬家自适应）：产物文件就住在这里；旧 Desktop 硬编码在仓库搬到 E: 后失配致 file 一族全 403
];

/** 文本类扩展名：直接回文本；其余回元信息 + 下载链接 */
const TEXT_EXT = new Set(['.md', '.txt', '.json', '.js', '.mjs', '.cjs', '.ts', '.css', '.html', '.htm',
  '.yml', '.yaml', '.toml', '.ini', '.log', '.csv', '.sh', '.ps1', '.py', '.svg', '.xml']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

/** 判断路径是否落在白名单根目录内（防目录穿越） */
function isAllowedPath(p) {
  if (!isAbsolute(p)) return false;
  const n = normalize(p).replace(/\\/g, '/');
  if (n.includes('..')) return false;
  return FILE_ROOTS.some((root) => {
    const r = normalize(root).replace(/\\/g, '/').replace(/\/$/, '');
    return n === r || n.startsWith(r + '/');
  });
}

// G02（第 5 轮）：AGENT_AUTOLOOP_HOME 读取收口为唯一常量（原先 4 处各读一遍 env）；
// taskFileOf 收口 6 处 join(AUTOLOOP_HOME,'office-data','tasks',`${id}.json`) 拼接。
const AUTOLOOP_HOME = process.env.AGENT_AUTOLOOP_HOME || 'C:/Tools/agent-autoloop';
const taskFileOf = (taskId) => join(AUTOLOOP_HOME, 'office-data', 'tasks', `${taskId}.json`);

// ---- 构建版本（TASK-R6 评审 #1）---------------------------------------
// 曾经出过「源码里有 /api/office/op-status，运行实例却 404」——进程是旧代码起的，
// 前端已经在调新接口。版本号写死在源码，/api/health 与启动日志都带它；
// 部署后冒烟第一件事就是核对这个值，运行实例与源码不一致当场暴露。
const BUILD_VERSION = 'r73';

/**
 * 读 office-data 下的 JSON（任务档案汇总、技能索引）。
 * 文件不存在或损坏时返回 fallback，而不是抛错——看板不该因为附属数据缺失而白屏。
 */
function readOfficeJson(name, fallback) {
  const p = join(AUTOLOOP_HOME, 'office-data', name);
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * readOfficeJson 的透明版（TASK-R2）：读取失败不再伪装成 fallback，
 * 错误一并带回，由端点透出给前端——「数据为空」和「读取失败」必须分得开。
 */
function readOfficeJsonDetailed(name, fallback) {
  const p = join(AUTOLOOP_HOME, 'office-data', name);
  try {
    return { payload: JSON.parse(readFileSync(p, 'utf8')), readError: null };
  } catch (err) {
    return { payload: fallback, readError: `读取 ${name} 失败：${err.message}` };
  }
}

// ---- 端口与中台地址 ----------------------------------------------------

/** 端口：环境变量 PORT（正整数）> 默认 8080。只绑 127.0.0.1，不对外。 */
const PORT = Number.isInteger(Number(process.env.PORT)) && Number(process.env.PORT) > 0
  ? Number(process.env.PORT)
  : 8080;

// ---- 读配置：owner key 只进内存 ----------------------------------------

let cfg;
try {
  cfg = JSON.parse(readFileSync(join(AUTOLOOP_HOME, 'config.json'), 'utf8'));
} catch (err) {
  console.error(`[启动失败] 读不到 ${join(AUTOLOOP_HOME, 'config.json')}：${err.message}`);
  process.exit(1);
}

const HUB = String(cfg.url || 'http://127.0.0.1:3350').replace(/\/+$/, '');
const OWNER_KEY = String(cfg.owner || '');
if (OWNER_KEY === '') {
  console.error('[启动失败] config.json 里没有 owner 字段');
  process.exit(1);
}
const HUB_HEADERS = {
  authorization: `Bearer ${OWNER_KEY}`,
  'content-type': 'application/json',
};

// ---- 小工具 ------------------------------------------------------------

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

/** 手写请求体解析：空体当 {}；非法 JSON 400；超过 1MB 直接断开。 */
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
 * 深度脱敏：任何字符串值只要包含 owner key 的片段，整段替换为 [REDACTED]。
 * 防御性措施——实测 /v1/state 的返回不含 key，但万一中台将来把凭据放进状态里，
 * 这一层保证它到不了浏览器。对象键名同样检查（防止 key 出现在字段名上）。
 */
function redact(value) {
  if (typeof value === 'string') {
    return value.includes(OWNER_KEY) ? '[REDACTED]' : value;
  }
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k.includes(OWNER_KEY) ? '[REDACTED]' : k] = redact(v);
    }
    return out;
  }
  return value;
}

/**
 * 调中台。网络层失败 → 502 HUB_UNREACHABLE；中台返回非 2xx → 原样透传状态码
 * 与业务错误体（里面不含凭据），供前端展示。成功的 JSON 响应先过 redact 再返回。
 */
async function callHub(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(HUB + path, {
      method,
      headers: HUB_HEADERS,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    const cause = err.cause ? (err.cause.code || err.cause.message) : err.message;
    throw httpError(502, 'HUB_UNREACHABLE', `中台不可达（${HUB}）：${cause}`);
  }

  const text = await res.text();
  let payload;
  try {
    payload = text === '' ? {} : JSON.parse(text);
  } catch {
    throw httpError(502, 'HUB_BAD_RESPONSE', `中台返回了非 JSON 内容（HTTP ${res.status}）`);
  }

  if (!res.ok) {
    // 透传中台的业务错误（status + body），不带任何凭据
    const err = httpError(res.status, payload.code || payload.error || 'HUB_ERROR',
      payload.error || payload.message || `中台返回 HTTP ${res.status}`);
    err.hubPayload = payload;
    throw err;
  }
  return redact(payload);
}

// ---- 路由处理器 ---------------------------------------------------------

/** GET /api/health — 本服务活着；顺带探测中台 /healthz（免鉴权端点）。 */
async function handleHealth() {
  let autoloop = false;
  try {
    const res = await fetch(`${HUB}/healthz`, { signal: AbortSignal.timeout(3000) });
    autoloop = res.ok;
  } catch {
    autoloop = false;
  }
  return { ok: true, autoloop, build: BUILD_VERSION };
}

/** POST /api/cards/:id/answer — 只接受 { choice: 非负整数 } 或 { text: 非空字符串 }。 */
async function handleAnswer(cardId, body) {
  const hasChoice = body.choice !== undefined;
  const hasText = body.text !== undefined;
  if (hasChoice === hasText) {
    throw httpError(400, 'INVALID_ANSWER', 'body 必须且只能是 { choice: 选项下标 } 或 { text: 自由回答 } 其一');
  }
  let forward;
  if (hasChoice) {
    if (!Number.isInteger(body.choice) || body.choice < 0) {
      throw httpError(400, 'INVALID_CHOICE', 'choice 必须是非负整数（选项下标，从 0 开始）');
    }
    forward = { choice: body.choice };
  } else {
    if (typeof body.text !== 'string' || body.text.trim() === '') {
      throw httpError(400, 'INVALID_TEXT', 'text 必须是非空字符串');
    }
    forward = { text: body.text };
  }
  return callHub(`/v1/cards/${cardId}/answer`, { method: 'POST', body: forward });
}

/** POST /api/cards/:id/resolve — { reason: 非空字符串 }。 */
async function handleResolve(cardId, body) {
  if (typeof body.reason !== 'string' || body.reason.trim() === '') {
    throw httpError(400, 'INVALID_REASON', 'reason 必须是非空字符串');
  }
  return callHub(`/v1/cards/${cardId}/resolve`, { method: 'POST', body: { reason: body.reason } });
}

/** POST /api/runs/:id/cancel — 忽略 body，直接转发。 */
function handleCancel(runId) {
  return callHub(`/v1/runs/${runId}/cancel`, { method: 'POST', body: {} });
}


// ---- G02（R73）：/api/* 路由层整体在 server-api.mjs，环境依赖走工厂注入 ----
const handleApi = createApiRouter({
  AUTOLOOP_HOME, PORT, TEXT_EXT, IMAGE_EXT,
  httpError, sendJson, readJsonBody,
  callHub, handleHealth, handleAnswer, handleResolve, handleCancel,
  taskFileOf, readOfficeJson, readOfficeJsonDetailed, isAllowedPath,
});

// ---- 决策直写端点（TASK-11.1 / R1）--------------------------------------
// POST /api/office/decide 走子进程 flow.mjs（Hermes 共用的老通道）；本端点另起一条
// 直写路径，三个差别是任务书点名要的：
//   1) 原子写：先写同目录临时文件再 rename 顶替——任何时刻磁盘上要么是完整旧档，
//      要么是完整新档，断电/崩溃不会留半截 JSON（flow.mjs 的裸 writeFileSync 做不到，
//      它是共享基础设施不能改）；
//   2) 每次操作追加一条事件记录（谁/何时/对哪个对象/做了什么/结果）到
//      office-data/decision-events.jsonl；
//   3) 响应就是写后的真实状态：rename 完成后重新从磁盘读回整份档案再返回，
//      不拿「命令发出去了」冒充「写成了」。
// 写是同步在进程内完成的（无子进程），单事件循环天然互斥；decideLocks 仍按
// 同一键空间加锁，与 decide/resubmit 互斥，防止两入口同时改同一步。


// ---- HTTP 服务 ----------------------------------------------------------

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  const method = req.method || 'GET';

  try {
    // 静态首页：只服务本目录的 index.html，不做目录列表
    if (method === 'GET' && (path === '/' || path === '/index.html')) {
      let html;
      try {
        html = readFileSync(join(HERE, 'index.html'));
      } catch {
        throw httpError(500, 'NO_FRONTEND', 'index.html 不在本服务同目录下');
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // TASK-R3 拆分产物：样式 / 主脚本 / 离线快照与 index.html 同目录。
    // 只精确匹配这十六个文件名（G02 第5轮 app.css 拆为 base/workbench/pages/layers 四段,
    // 第4轮新增 decision-ops / preview / agents 三个模块脚本，R73 新增 render.js
    // 渲染主干；TASK-工作台重做新增 app-cabin.css / cabin.js 小白三页；
    // 不开放目录列表），no-cache 保证改版刷新即生效。
    if (method === 'GET' || method === 'HEAD') {
      const STATIC_APP = {
        '/app-base.css': 'text/css; charset=utf-8',
        '/app-workbench.css': 'text/css; charset=utf-8',
        '/app-pages.css': 'text/css; charset=utf-8',
        '/app-layers.css': 'text/css; charset=utf-8',
        '/app-cabin.css': 'text/css; charset=utf-8',
        '/app.js': 'application/javascript; charset=utf-8',
        '/shared.js': 'application/javascript; charset=utf-8',
        '/version.js': 'application/javascript; charset=utf-8',
        '/approval.js': 'application/javascript; charset=utf-8',
        '/decision-ops.js': 'application/javascript; charset=utf-8',
        '/files.js': 'application/javascript; charset=utf-8',
        '/preview.js': 'application/javascript; charset=utf-8',
        '/agents.js': 'application/javascript; charset=utf-8',
        '/cabin.js': 'application/javascript; charset=utf-8',
        '/theme.js': 'application/javascript; charset=utf-8',
        '/render.js': 'application/javascript; charset=utf-8',
        '/offline-snapshot.js': 'application/javascript; charset=utf-8',
        // TASK-看板复刻CrommaCode：新增只读看板（独立文件，不改 cabin / app / index）
        '/board-cromma.html': 'text/html; charset=utf-8',
        '/board-cromma.css': 'text/css; charset=utf-8',
        '/board-cromma.js': 'application/javascript; charset=utf-8',
      };
      if (STATIC_APP[path]) {
        let buf;
        try { buf = readFileSync(join(HERE, path.slice(1))); }
        catch { throw httpError(404, 'NOT_FOUND', '资源不存在'); }
        res.writeHead(200, { 'content-type': STATIC_APP[path], 'cache-control': 'no-cache' });
        res.end(method === 'HEAD' ? undefined : buf);
        return;
      }
    }

    // 静态资源：只服务本目录 assets/ 下的图片（TASK-4.1）；
    // TASK-5.2 起允许一层子目录 assets/agents/（工位卡头像）。
    // 每段文件名只允许字母数字开头 + ._-，天然挡掉 ..、分隔符与空段；扩展名白名单。
    if ((method === 'GET' || method === 'HEAD') && path.startsWith('/assets/')) {
      const MIME = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
      };
      const segs = path.slice('/assets/'.length).split('/');
      const last = segs[segs.length - 1];
      const dot = last.lastIndexOf('.');
      const ext = dot >= 0 ? last.slice(dot).toLowerCase() : '';
      const safe = segs.length <= 2
        && segs.every((s) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s))
        && !path.includes('..') && MIME[ext] !== undefined;
      if (!safe) throw httpError(404, 'NOT_FOUND', '资源不存在');
      let buf;
      try {
        buf = readFileSync(join(HERE, 'assets', ...segs));
      } catch {
        throw httpError(404, 'NOT_FOUND', '资源不存在');
      }
      // 头像是不变的资产，而工位卡每 3 秒重渲染会重建 <img>：
      // agents/ 给长缓存，否则 no-cache 会让浏览器每轮全量重拉 3.7MB；其余维持 no-cache
      res.writeHead(200, {
        'content-type': MIME[ext],
        'cache-control': segs.length === 2 ? 'public, max-age=86400' : 'no-cache',
      });
      res.end(method === 'HEAD' ? undefined : buf);
      return;
    }

    // TASK-看板V2：品牌 icon（24×24 单色 SVG，单段文件名，禁目录穿越）
    if ((method === 'GET' || method === 'HEAD') && path.startsWith('/icons/')) {
      const seg = path.slice('/icons/'.length);
      if (!/^[A-Za-z0-9._-]+\.svg$/.test(seg) || seg.includes('..')) {
        throw httpError(404, 'NOT_FOUND', '资源不存在');
      }
      let buf;
      try { buf = readFileSync(join(HERE, 'icons', seg)); }
      catch { throw httpError(404, 'NOT_FOUND', '资源不存在'); }
      res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(method === 'HEAD' ? undefined : buf);
      return;
    }

    // TASK-看板V2：EaseDraw 完整 Web 页面（iframe 嵌入，保留它自己的 ./app.css、./js/*、./ui/*、./p/*）
    // 仅 GET/HEAD；相对路径靠 /easedraw/ 尾斜杠解析，裸 /easedraw 先 302 过去。
    if ((method === 'GET' || method === 'HEAD') && path === '/easedraw') {
      res.writeHead(302, { location: '/easedraw/' });
      res.end();
      return;
    }
    if ((method === 'GET' || method === 'HEAD') && path.startsWith('/easedraw/')) {
      let rel = path.slice('/easedraw/'.length);
      if (rel === '' || rel.endsWith('/')) rel += 'index.html';
      let decoded;
      try { decoded = decodeURIComponent(rel); }
      catch { throw httpError(404, 'NOT_FOUND', '资源不存在'); }
      const segs = decoded.split('/');
      const last = segs[segs.length - 1];
      const dot = last.lastIndexOf('.');
      const ext = dot >= 0 ? last.slice(dot).toLowerCase() : '';
      const MIME = {
        '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8', '.webp': 'image/webp',
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2',
        '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
        '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.webm': 'video/webm',
      };
      const safe = segs.length <= 3
        && segs.every((s) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s))
        && !decoded.includes('..') && MIME[ext] !== undefined;
      if (!safe) throw httpError(404, 'NOT_FOUND', '资源不存在');
      let buf;
      try { buf = readFileSync(join(HERE, 'easedraw', ...segs)); }
      catch { throw httpError(404, 'NOT_FOUND', '资源不存在'); }
      const immutable = ext === '.webp' || ext === '.woff' || ext === '.woff2';
      res.writeHead(200, {
        'content-type': MIME[ext],
        'cache-control': immutable ? 'public, max-age=86400' : 'no-cache',
      });
      res.end(method === 'HEAD' ? undefined : buf);
      return;
    }

    // G02（R73 第 73 轮）：/api/* 路由整体搬至 server-api.mjs（createApiRouter
    // 工厂注入依赖），路由体逐字未动，协议/状态码/错误码不变；405/404 兜底随路由走，
    // 非 /api/ 路径在这里兜底。
    if (path.startsWith('/api/')) {
      await handleApi(req, res, path, method);
      return;
    }
    throw httpError(404, 'NOT_FOUND', `${method} ${path} 不存在`);

  } catch (err) {
    const statusCode = err.statusCode || 500;
    // 500 级错误不回传内部细节，避免任何意外泄漏
    const message = statusCode >= 500 && !err.code?.startsWith('HUB')
      ? '服务内部错误'
      : err.message;
    if (statusCode >= 500) console.error(`[错误] ${method} ${path} → ${err.code}: ${err.message}`);
    sendJson(res, statusCode, { error: message, code: err.code || 'INTERNAL' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Soda Agent 工作台  http://127.0.0.1:${PORT}  build=${BUILD_VERSION}`);
  console.log(`代理到中台        ${HUB}（owner key 已从 config.json 载入内存，不出服务端）`);
  // TASK-R87整改 X01：服务重启时，把中断在半路（讨论中/写文档中）的新流程任务
  // 重新拉起推进；phase=error 和老任务（doc=pending）一律不碰。
  resumeInterruptedAuto(AUTOLOOP_HOME).catch(() => {});
});

process.on('SIGINT', () => {
  console.log('\n收到 SIGINT，关闭工作台服务');
  // Agent Chat：把还在跑的聊天轮次先落库成 interrupted 再走，不留一行没人盯的 running
  try { chatEngine().shutdown(); } catch { /* 引擎这次没被用到，或已经收过 */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
});