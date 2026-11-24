// api-tool-events.mjs — 转盘左弧 / 刻度的只读数据源。
//
// GET /api/tool-events?agent_id=claude&recent=60&tools=24
//   只读 tool_events 表，不在请求里扫描 ~/.claude 或 ~/.dsh。
//   采集没跑过时返回 collecting=true，前端必须显示「工具数据采集中」，不许画假数字。
//   响应不含 raw_json（里面可能有完整命令/路径，列表只需要 target）。

import { getDb } from './lib/db.mjs';
import { queryToolEvents } from './lib/tool-events.mjs';

function send(deps, res, status, body) {
  if (typeof deps.sendJson === 'function') return deps.sendJson(res, status, body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

export async function handleToolEventsApi(req, res, path, method, deps = {}) {
  if (path !== '/api/tool-events') return false;
  const m = String(method || 'GET').toUpperCase();
  if (m !== 'GET') {
    const err = typeof deps.httpError === 'function'
      ? deps.httpError(405, 'METHOD_NOT_ALLOWED', `${m} ${path} 不支持`)
      : Object.assign(new Error(`${m} ${path} 不支持`), { statusCode: 405, code: 'METHOD_NOT_ALLOWED' });
    throw err;
  }
  const url = new URL(req.url || path, 'http://127.0.0.1');
  const db = getDb();
  const view = queryToolEvents(db, {
    agentId: url.searchParams.get('agent_id') || null,
    recentLimit: url.searchParams.get('recent') || 60,
    toolLimit: url.searchParams.get('tools') || 24,
  });
  send(deps, res, 200, { ok: true, source: 'tool_events', ...view });
  return true;
}
