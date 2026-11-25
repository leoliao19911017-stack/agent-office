// api-deliverables.mjs — 交付物只读 API（第一批）。
//
//   GET /api/deliverables?task_id=xxx   该任务全部交付物，按 kind 分组
//   GET /api/deliverables               未关联交付物（task_id IS NULL）
//   GET /api/deliverables/preview?deliverable_id=xxx   内容预览
//
// 只读：采集是独立 CLI（scripts/collect-deliverables.mjs），API 不在请求里扫目录/跑 git。
// 口径：没有记录的 kind 也返回空数组 + empty_kinds，前端才能显式写「未产生」。
// 预览只认 deliverables 表里的行；不接受前端传任意路径。

import { existsSync } from 'node:fs';
import { getDb } from './lib/db.mjs';
import { getTask, getSteps, summarizeSteps } from './lib/tasks.mjs';
import {
  DELIVERABLE_KINDS, KIND_SET, STATUS_LABEL, computeGoal, displayPath,
  getDeliverable, groupByKind, listDeliverables, previewDeliverable,
} from './lib/deliverables.mjs';

const MAX_UNLINKED_PER_KIND = 120;

function stamp(now) {
  return (now instanceof Date ? now : new Date(now ?? Date.now())).toISOString();
}

function send(deps, res, statusCode, payload) {
  deps.sendJson(res, statusCode, payload);
}

function httpErrorOf(deps) {
  return (status, code, message) => {
    if (typeof deps.httpError === 'function') return deps.httpError(status, code, message);
    return Object.assign(new Error(message), { statusCode: status, code });
  };
}

function previewShape(d) {
  if (d.content_ref && /^git:[0-9a-f]{7,40}$/i.test(d.content_ref)) return 'diff';
  if (d.kind === 'retro' || d.kind === 'goal_report') return 'text';
  if (!d.path) return 'none';
  const ext = String(d.path).toLowerCase().match(/\.[a-z0-9]+$/);
  const e = ext ? ext[0] : '';
  if (['.md', '.markdown'].includes(e)) return 'markdown';
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(e)) return 'image';
  if (['.js', '.mjs', '.cjs', '.ts', '.css', '.html', '.htm', '.json', '.yml', '.yaml',
    '.toml', '.ini', '.sh', '.ps1', '.py', '.xml', '.svg'].includes(e)) return 'code';
  return 'text';
}

function decorate(d) {
  const kind = DELIVERABLE_KINDS.find((k) => k.kind === d.kind);
  return {
    deliverable_id: d.deliverable_id,
    task_id: d.task_id || null,
    kind: d.kind,
    kind_label: kind ? kind.label : d.kind,
    title: d.title,
    path: d.path || null,
    display_path: d.path ? displayPath(d.path) : null,
    content_ref: d.content_ref || null,
    status: d.status,
    status_label: STATUS_LABEL[d.status] || d.status,
    created_by: d.created_by || null,
    created_at: d.created_at,
    updated_at: d.updated_at,
    preview: previewShape(d),
    exists: d.path ? existsSync(d.path) : true,
  };
}

function taskHead(db, task) {
  const steps = getSteps(db, task.task_id);
  // 这里的 status 是库里的状态列；进度按同一个口径算（已完成的任务步骤按全部完成算，见 summarizeSteps）
  const s = summarizeSteps(steps, { completed: task.status === 'completed' });
  return {
    task_id: task.task_id,
    title: task.title,
    acceptance: task.acceptance || null,
    status: task.status,
    status_reason: task.status_reason || null,
    progress: { done: s.done_count, total: s.total },
    current_step: s.current_step,
    created_at: task.created_at,
    updated_at: task.updated_at,
    closed_at: task.closed_at || null,
  };
}

function groupsPayload(rows) {
  const groups = groupByKind(rows);
  const decorated = {};
  for (const k of DELIVERABLE_KINDS.map((x) => x.kind)) {
    decorated[k] = (groups[k] || []).map(decorate);
  }
  const counts = Object.fromEntries(DELIVERABLE_KINDS.map((k) => [k.kind, decorated[k.kind].length]));
  const empty_kinds = DELIVERABLE_KINDS.filter((k) => counts[k.kind] === 0).map((k) => k.kind);
  return { groups: decorated, counts, empty_kinds };
}

/**
 * @returns {Promise<boolean>} true=已处理
 */
export async function handleDeliverablesApi(req, res, path, method, deps = {}) {
  const normalizedMethod = String(method || 'GET').toUpperCase();
  const isList = path === '/api/deliverables';
  const isPreview = path === '/api/deliverables/preview';
  if (!isList && !isPreview) return false;

  if (normalizedMethod !== 'GET') {
    throw httpErrorOf(deps)(405, 'METHOD_NOT_ALLOWED', `${normalizedMethod} ${path} 不支持（交付物 API 只读）`);
  }

  const db = getDb();

  if (isPreview) {
    const q = new URL(req.url, 'http://127.0.0.1');
    const id = String(q.searchParams.get('deliverable_id') || q.searchParams.get('id') || '').trim();
    if (!id) throw httpErrorOf(deps)(400, 'MISSING_ID', '缺少 deliverable_id 参数');
    const result = previewDeliverable(db, id);
    if (!result.ok) {
      send(deps, res, result.status || 400, { ok: false, error: result.error, path: result.path || null });
      return true;
    }
    const d = decorate(result.deliverable);
    send(deps, res, 200, {
      ok: true,
      generated_at: stamp(),
      deliverable: d,
      preview: result.preview,
      title: result.title || d.title,
      path: result.path || d.path,
      display_path: result.path ? displayPath(result.path) : d.display_path,
      text: result.text ?? null,
      url: result.url || null,
      bytes: result.bytes ?? null,
      truncated: Boolean(result.truncated),
      total_lines: result.total_lines ?? null,
      shown_lines: result.shown_lines ?? null,
      sha: result.sha || null,
      note: result.note || null,
      modifiedAt: result.modifiedAt || null,
    });
    return true;
  }

  const q = new URL(req.url, 'http://127.0.0.1');
  const taskId = String(q.searchParams.get('task_id') || '').trim();

  if (!taskId) {
    // 未关联区：不硬塞任务，单独返回。按 kind 分组，单类最多 120 条，另给 total。
    const rows = listDeliverables(db, { unlinked: true });
    const packed = groupsPayload(rows);
    const total = rows.length;
    const groups = {};
    for (const k of DELIVERABLE_KINDS.map((x) => x.kind)) {
      groups[k] = packed.groups[k].slice(0, MAX_UNLINKED_PER_KIND);
    }
    const counts = packed.counts;
    const truncated = Object.fromEntries(Object.entries(counts).map(([k, n]) => [k, n > MAX_UNLINKED_PER_KIND]));
    send(deps, res, 200, {
      ok: true,
      generated_at: stamp(),
      unlinked: true,
      task_id: null,
      task: null,
      goal: null,
      groups,
      counts,
      empty_kinds: packed.empty_kinds,
      total,
      truncated,
    });
    return true;
  }

  const task = getTask(db, taskId);
  if (!task) throw httpErrorOf(deps)(404, 'TASK_NOT_FOUND', `任务不存在：${taskId}`);

  const rows = listDeliverables(db, { taskId });
  const packed = groupsPayload(rows);
  send(deps, res, 200, {
    ok: true,
    generated_at: stamp(),
    unlinked: false,
    task_id: taskId,
    task: taskHead(db, task),
    goal: computeGoal(db, task),
    groups: packed.groups,
    counts: packed.counts,
    empty_kinds: packed.empty_kinds,
    total: rows.length,
    kinds: DELIVERABLE_KINDS,
  });
  return true;
}

export { KIND_SET };
