// api-handoffs.mjs — 交接包 HTTP 接口
//
//   POST /api/handoffs        生成交接包（body: thread_id / task_id / to_agent_id / reason）
//   GET  /api/handoffs        列表（docs/handoffs/*.json，最近在前）
//   GET  /api/handoffs/:id    读取一份交接包（JSON + Markdown）
//
// 生成逻辑全部在 scripts/handoff/build.mjs：任务/attempts 来自 agent-office.db，
// git 现场来自 git 命令，catchup 原文只做带来源标记的摘录。本文件只做 HTTP 壳。
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHandoff, HANDOFF_DIR } from '../scripts/handoff/build.mjs';

const ID_RE = /^ho-[A-Za-z0-9_-]{4,96}$/;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = process.env.HANDOFF_DIR
  ? (isAbsolute(process.env.HANDOFF_DIR) ? process.env.HANDOFF_DIR : join(REPO_ROOT, process.env.HANDOFF_DIR))
  : HANDOFF_DIR;

function mkHttpError(deps) {
  return (status, code, message) => {
    if (typeof deps.httpError === 'function') return deps.httpError(status, code, message);
    return Object.assign(new Error(message), { statusCode: status, code });
  };
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function summaryOf(h) {
  return {
    handoff_id: h.handoff_id,
    created_at: h.created_at,
    from: h.from,
    to: h.to,
    task: h.task ? { task_id: h.task.task_id, title: h.task.title } : null,
    progress: h.progress ? { done_count: (h.progress.done || []).length, doing: h.progress.doing, blocked: h.progress.blocked } : null,
    next_action: h.next_action,
    workspace: h.workspace ? { branch: h.workspace.branch, head_commit: h.workspace.head_commit, uncommitted_count: h.workspace.uncommitted_count } : null,
    artifacts: h.artifacts || null,
  };
}

export async function handleHandoffsApi(req, res, path, method, deps = {}) {
  const httpError = mkHttpError(deps);
  const m = String(method || 'GET').toUpperCase();
  const isList = path === '/api/handoffs';
  const mMatch = path.match(/^\/api\/handoffs\/([^/]+)$/);

  if (!isList && !mMatch) {
    if (path.startsWith('/api/handoffs/')) throw httpError(404, 'NOT_FOUND', `${path} 不存在`);
    return false;
  }
  if (isList && !['GET', 'POST'].includes(m)) throw httpError(405, 'METHOD_NOT_ALLOWED', `${m} ${path} 不支持`);
  if (mMatch && m !== 'GET') throw httpError(405, 'METHOD_NOT_ALLOWED', `${m} ${path} 不支持（交接包只读，生成用 POST /api/handoffs）`);

  /* ---- GET /api/handoffs ---- */
  if (isList && m === 'GET') {
    let names = [];
    try { names = readdirSync(DIR).filter((n) => /^ho-.+\.json$/.test(n)); } catch { names = []; }
    const rows = [];
    for (const name of names) {
      const h = readJson(join(DIR, name));
      if (h) rows.push(summaryOf(h));
    }
    rows.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    deps.sendJson(res, 200, {
      ok: true,
      generated_at: new Date().toISOString(),
      count: rows.length,
      handoffs: rows,
    });
    return true;
  }

  /* ---- POST /api/handoffs ---- */
  if (isList && m === 'POST') {
    const body = (await deps.readJsonBody(req)) || {};
    const threadId = body.thread_id || body.threadId || null;
    const taskId = body.task_id || body.taskId || null;
    const toAgentId = body.to_agent_id || body.toAgentId || null;
    if (!threadId && !taskId) throw httpError(400, 'MISSING_INPUT', 'thread_id 或 task_id 至少给一个');
    if (toAgentId && !['dsh', 'claude', 'codex', 'hermes', 'kimi'].includes(String(toAgentId))) {
      throw httpError(400, 'BAD_AGENT', `to_agent_id 不受支持：${toAgentId}`);
    }
    try {
      const r = await buildHandoff({
        threadId: threadId ? String(threadId) : undefined,
        taskId: taskId ? String(taskId) : undefined,
        toAgentId: toAgentId ? String(toAgentId) : undefined,
        reason: body.reason ? String(body.reason) : undefined,
        last: Number.isInteger(Number(body.last)) && Number(body.last) > 0 ? Math.min(Number(body.last), 100) : 30,
        outDir: DIR,
      });
      deps.sendJson(res, 201, {
        ok: true,
        generated_at: new Date().toISOString(),
        handoff: r.handoff,
        markdown: r.markdown,
        json_path: r.json_path,
        markdown_path: r.markdown_path,
        session_transcript_path: r.session_transcript_path,
      });
    } catch (err) {
      if (err.statusCode) throw err;
      throw httpError(500, 'HANDOFF_BUILD_FAILED', `生成交接包失败：${String(err.message || err).slice(0, 240)}`);
    }
    return true;
  }

  /* ---- GET /api/handoffs/:id ---- */
  if (mMatch && m === 'GET') {
    const id = decodeURIComponent(mMatch[1]);
    if (!ID_RE.test(id)) throw httpError(400, 'BAD_ID', `交接包 id 不合法：${id}`);
    const jsonPath = join(DIR, `${id}.json`);
    const mdPath = join(DIR, `${id}.md`);
    if (!existsSync(jsonPath)) throw httpError(404, 'HANDOFF_NOT_FOUND', `交接包不存在：${id}`);
    const handoff = readJson(jsonPath);
    if (!handoff) throw httpError(500, 'HANDOFF_BAD_JSON', `交接包 JSON 损坏：${id}`);
    let markdown = '';
    try { markdown = readFileSync(mdPath, 'utf8'); } catch { markdown = ''; }
    deps.sendJson(res, 200, {
      ok: true,
      observed_at: new Date().toISOString(),
      handoff,
      markdown,
      json_path: `docs/handoffs/${id}.json`,
      markdown_path: `docs/handoffs/${id}.md`,
    });
    return true;
  }

  return false;
}
