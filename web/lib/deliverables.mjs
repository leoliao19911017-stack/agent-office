// deliverables.mjs — 交付物数据层：真实来源 → deliverables 表 → 任务交付物视图。
//
// 核心口径（TASK-交付物视图与工作流编排 铁律）：
//   1. 交付物必须指向真实文件/记录，不许编造；
//   2. 没有的类别由前端显式写「未产生」，不在库里塞占位行；
//   3. 匹配不上任务就 task_id=NULL，挂「未关联交付物」，不硬塞；
//   4. 目标达成只从 tasks.acceptance + checkpoints + 任务状态推导，未设目标
//      一律 no_goal，不编百分比。
//
// 本模块只做「读任务 + 推导 + 读写 deliverables」，不创建数据库连接；
// 采集器 scripts/collect-deliverables.mjs 与 API 共用这里，避免两套口径。

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute, normalize, resolve } from 'node:path';
import { allRows, getRow, transaction, REPO_ROOT } from './db.mjs';

/** 六类交付物 + goal_report。顺序就是界面时间线顺序（goal_report 单独放顶部）。 */
export const DELIVERABLE_KINDS = [
  { kind: 'requirement', no: 1, label: '需求文档', short: '需求' },
  { kind: 'task_spec', no: 2, label: '开发指令', short: '指令' },
  { kind: 'dev_output', no: 3, label: '交付成果', short: '成果' },
  { kind: 'artifact', no: 4, label: '生成物', short: '产物' },
  { kind: 'review', no: 5, label: '评审报告', short: '评审' },
  { kind: 'retro', no: 6, label: '复盘建议', short: '复盘' },
  { kind: 'goal_report', no: 7, label: '目标达成', short: '目标' },
];
export const KIND_SET = new Set(DELIVERABLE_KINDS.map((k) => k.kind));
export const TIMELINE_KINDS = DELIVERABLE_KINDS.filter((k) => k.kind !== 'goal_report').map((k) => k.kind);

export const STATUS_LABEL = {
  draft: '草稿', submitted: '已提交', accepted: '已验收', rejected: '已打回',
};

const TEXT_EXT = new Set(['.md', '.txt', '.json', '.js', '.mjs', '.cjs', '.ts', '.css', '.html', '.htm',
  '.yml', '.yaml', '.toml', '.ini', '.log', '.csv', '.sh', '.ps1', '.py', '.svg', '.xml']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.css', '.html', '.htm', '.yml', '.yaml',
  '.toml', '.ini', '.sh', '.ps1', '.py', '.json', '.xml', '.svg']);
const PREVIEW_BYTES = 2 * 1024 * 1024;
const PREVIEW_LINES = 100;
const DIFF_BYTES = 400 * 1024;

function stamp(now) {
  return (now instanceof Date ? now : new Date(now ?? Date.now())).toISOString();
}

function sha1(text) {
  return createHash('sha1').update(String(text)).digest('hex');
}

/** 采集器生成确定性 ID：同一任务 + 同一来源重复采集不产生重复行。 */
export function deliverableId(kind, taskId, ref) {
  return `dl-${sha1(`${kind}|${taskId || '_unlinked'}|${ref}`).slice(0, 20)}`;
}

export function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/');
}

export function displayPath(p) {
  const n = normalizePath(p);
  const root = normalizePath(REPO_ROOT);
  if (n.toLowerCase().startsWith(root.toLowerCase() + '/')) return n.slice(root.length + 1);
  return n;
}

/* ------------------------------------------------------------------ 目标达成 */

const SKIP_CRITERION_PREFIX = /^(证据|复现|说明|备注|参考|验收证据|入口)[：:]/;

function splitAcceptance(text) {
  return String(text || '')
    .split(/[；;。\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function expandRange(prefix, from, toPrefix, to) {
  const p = String(prefix || '').toUpperCase();
  const tp = String(toPrefix || prefix || '').toUpperCase();
  const a = Number(from);
  const b = Number(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a > b || b - a > 30) return [];
  const out = [];
  for (let i = a; i <= b; i += 1) out.push(`${tp}${i}`);
  return out;
}

/**
 * 从 acceptance 文本解析验收项。
 * 支持 `A1 建 thread；A2 ...` 与 `A1-A7、B1-B5 全部重跑` 两种真实写法。
 * 解析不出来时退化成「1 条验收标准」，不假装很多条。
 */
export function parseAcceptanceCriteria(acceptance) {
  const text = String(acceptance || '').trim();
  if (!text) return [];
  const out = [];
  const seen = new Set();
  const push = (label, segText) => {
    if (seen.has(label)) return;
    seen.add(label);
    out.push({ label, text: segText });
  };

  for (const seg of splitAcceptance(text)) {
    if (SKIP_CRITERION_PREFIX.test(seg)) continue;
    const ranges = [...seg.matchAll(/([A-Z])(\d{1,2})\s*[-~—至]\s*([A-Z]?)(\d{1,2})/g)];
    if (ranges.length) {
      let addedRange = false;
      for (const m of ranges) {
        // P1-P7 是批次号（Agent Chat P1-P7），不是验收项编号；
        // 把它拆成 7 条会虚增达成度，这里跳过 P 前缀的区间。
        if (String(m[1]).toUpperCase() === 'P') continue;
        for (const label of expandRange(m[1], m[2], m[3], m[4])) push(label, seg);
        addedRange = true;
      }
      if (addedRange) continue;
    }
    const lead = seg.match(/^([A-Z]\d{1,2})(?=[\s：:，,、）)]|$)/);
    if (lead && !/^P\d/.test(lead[1])) {
      push(lead[1], seg);
      continue;
    }
    // 没有编号的验收句：用序号做 label，保证条数真实、不把整段吞成一条
    push(`第${out.length + 1}项`, seg);
  }
  if (!out.length) out.push({ label: '验收标准', text });
  return out;
}

/**
 * 目标达成：只从 tasks.acceptance + checkpoints + 任务状态推导。
 *
 * 通过 / 未通过的判定规则（写死、可解释）：
 *   - 没有 acceptance                     → no_goal（未设定目标，0/0）
 *   - 任务 completed                      → achieved，全部验收项通过；
 *     检查点通过数 = 检查点总数（有检查点才算证据）
 *   - 任务 failed/blocked/interrupted     → missed，已记录检查点通过 0 个
 *   - 其余（running/waiting/idle）        → partial，检查点只算「已留存」不算「通过」
 *
 * 注意：checkpoints 表记的是代码现场快照，没有逐条 pass/fail 字段；
 * 所以「通过检查点」只在该任务 completed 时才成立，不拿快照数量冒充通过数。
 */
export function computeGoal(db, task) {
  const acceptance = task && task.acceptance != null ? String(task.acceptance).trim() : '';
  if (!acceptance) {
    return {
      judgement: 'no_goal',
      judgement_label: '未设定目标',
      goal: null,
      percent: null,
      criteria: { total: 0, passed: 0, items: [] },
      checkpoints: { total: 0, passed: 0 },
      gaps: ['未设定目标'],
      evidence: 'tasks.acceptance 为空',
    };
  }

  const criteria = parseAcceptanceCriteria(acceptance);
  const cks = allRows(db, 'SELECT checkpoint_id, created_at FROM checkpoints WHERE task_id = ? ORDER BY created_at ASC',
    [task.task_id]);
  const completed = task.status === 'completed';
  const failed = ['failed', 'blocked', 'interrupted'].includes(task.status);
  const judgement = completed ? 'achieved' : failed ? 'missed' : 'partial';
  const passedCriteria = completed ? criteria.length : 0;
  const items = criteria.map((c) => ({
    label: c.label,
    text: c.text,
    passed: completed,
  }));
  const gaps = items.filter((c) => !c.passed).map((c) => c.text);
  const percent = criteria.length ? Math.round((passedCriteria / criteria.length) * 100) : null;

  return {
    judgement,
    judgement_label: judgement === 'achieved' ? '已达成'
      : judgement === 'partial' ? '部分达成'
        : '未达成',
    goal: acceptance,
    percent,
    criteria: { total: criteria.length, passed: passedCriteria, items },
    checkpoints: { total: cks.length, passed: completed ? cks.length : 0 },
    gaps,
    evidence: completed
      ? `任务状态 completed；${cks.length} 个检查点`
      : `任务状态 ${task.status}${cks.length ? `；已留存 ${cks.length} 个检查点，但未完成验收` : '；没有检查点'}`,
  };
}

/* --------------------------------------------------------------- 交付物 CRUD */

function mapRow(row) {
  if (!row) return null;
  return { ...row };
}

export function getDeliverable(db, deliverableIdValue) {
  return mapRow(getRow(db, 'SELECT * FROM deliverables WHERE deliverable_id = ?', [deliverableIdValue]));
}

export function listDeliverables(db, opts = {}) {
  if (opts.taskId) {
    return allRows(db,
      'SELECT * FROM deliverables WHERE task_id = ? ORDER BY kind ASC, created_at DESC, deliverable_id ASC',
      [opts.taskId]).map(mapRow);
  }
  if (opts.unlinked) {
    return allRows(db,
      'SELECT * FROM deliverables WHERE task_id IS NULL ORDER BY kind ASC, created_at DESC, deliverable_id ASC')
      .map(mapRow);
  }
  return allRows(db, 'SELECT * FROM deliverables ORDER BY kind ASC, created_at DESC').map(mapRow);
}

/** 按 kind 分组；没有记录的 kind 也返回空数组，前端才能显式写「未产生」。 */
export function groupByKind(rows) {
  const groups = {};
  for (const k of DELIVERABLE_KINDS.map((x) => x.kind)) groups[k] = [];
  for (const row of rows || []) {
    if (!groups[row.kind]) groups[row.kind] = [];
    groups[row.kind].push(row);
  }
  return groups;
}

/**
 * 全量替换：采集器每次从真实来源重建。先删后插在一个事务里，
 * 文件消失后旧记录不会残留成幽灵交付物。
 */
export function replaceAllDeliverables(db, rows) {
  const list = Array.isArray(rows) ? rows : [];
  const at = stamp();
  transaction(db, () => {
    db.prepare('DELETE FROM deliverables').run();
    const ins = db.prepare(
      'INSERT INTO deliverables (deliverable_id, task_id, attempt_id, kind, title, path, content_ref, ' +
      'status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const d of list) {
      if (!KIND_SET.has(d.kind)) throw new Error(`未知 deliverable kind：${d.kind}`);
      ins.run(
        d.deliverable_id || deliverableId(d.kind, d.task_id, d.path || d.content_ref || d.title),
        d.task_id || null,
        d.attempt_id || null,
        d.kind,
        String(d.title || d.path || '未命名交付物').slice(0, 300),
        d.path || null,
        d.content_ref || null,
        d.status || 'submitted',
        d.created_by || null,
        d.created_at || at,
        d.updated_at || d.created_at || at,
      );
    }
  });
  return list.length;
}

/* ------------------------------------------------------------------ 预览 */

function fileRoots() {
  return [
    normalizePath(REPO_ROOT).replace(/\/$/, ''),
    'C:/Tools/agent-autoloop',
    'C:/Tools/agent-autoloop/office-data',
  ];
}

export function resolvePreviewPath(p) {
  if (!p) return null;
  const n = normalizePath(p);
  const abs = isAbsolute(n) ? normalize(n) : resolve(REPO_ROOT, n);
  const norm = normalizePath(abs);
  const ok = fileRoots().some((root) => norm === root || norm.startsWith(root + '/'));
  return ok ? abs : null;
}

function readText(path) {
  const st = statSync(path);
  const buf = readFileSync(path);
  const truncated = buf.length > PREVIEW_BYTES;
  const text = buf.subarray(0, PREVIEW_BYTES).toString('utf8');
  return { text, bytes: st.size, truncated, modifiedAt: st.mtime.toISOString() };
}

function firstLines(text, n) {
  const lines = String(text || '').split(/\r?\n/);
  return { text: lines.slice(0, n).join('\n'), total_lines: lines.length, shown_lines: Math.min(n, lines.length) };
}

/**
 * 交付物预览。只接受 deliverables 表里的行，不接受前端任意路径。
 * - .md            → markdown 全文
 * - 代码 / 日志     → 前 100 行 + 总行数
 * - 图片            → 交给 /api/office/file 以二进制返回
 * - git commit      → git show --stat --patch（diff）
 */
export function previewDeliverable(db, deliverableIdValue) {
  const d = getDeliverable(db, deliverableIdValue);
  if (!d) return { ok: false, status: 404, error: '交付物不存在' };

  if (d.content_ref && /^git:[0-9a-f]{7,40}$/i.test(d.content_ref)) {
    const sha = d.content_ref.slice(4);
    try {
      const out = execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.quotepath=false', '-C', REPO_ROOT, 'show',
        '--stat', '--patch', '--format=fuller', '--no-color', sha], {
        encoding: 'utf8', maxBuffer: DIFF_BYTES * 4, timeout: 30000, windowsHide: true,
      });
      const truncated = out.length > DIFF_BYTES;
      return {
        ok: true,
        deliverable: d,
        preview: 'diff',
        path: null,
        title: d.title,
        sha,
        text: truncated ? out.slice(0, DIFF_BYTES) : out,
        truncated,
        bytes: out.length,
      };
    } catch (err) {
      return { ok: false, status: 404, error: `git show ${sha} 失败：${String(err.message || err).slice(0, 200)}` };
    }
  }

  // retro / goal_report 不是文件：content_ref 里是采集时提取的真实文本/判定。
  if (d.kind === 'retro' || d.kind === 'goal_report') {
    let obj = null;
    try { obj = JSON.parse(d.content_ref || '{}'); } catch { obj = null; }
    if (!obj) return { ok: false, status: 422, error: '交付物内容引用不是合法 JSON' };
    let text = '';
    if (d.kind === 'retro') {
      text = obj.text || `结论：${obj.conclusion || '未提取到'}

改进建议：${obj.improvement || '未提取到'}`;
    } else {
      const g = obj;
      text = [
        `目标：${g.goal || '未设定目标'}`,
        `判定：${g.judgement_label || g.judgement || '—'}（${g.judgement || '—'}）`,
        `达成度：验收项 ${g.criteria?.passed ?? 0}/${g.criteria?.total ?? 0}` +
          `${g.percent == null ? '' : ` · ${g.percent}%`}` +
          ` · 检查点 ${g.checkpoints?.passed ?? 0}/${g.checkpoints?.total ?? 0}`,
        `依据：${g.evidence || '—'}`,
        `差距：${(g.gaps || []).length ? g.gaps.join('；') : '无'}`,
      ].join('\n');
    }
    return {
      ok: true, deliverable: d, preview: 'text', path: null, title: d.title,
      text, bytes: Buffer.byteLength(text, 'utf8'), truncated: false,
      note: d.kind === 'retro' ? '从评审文档提取；提取不到写「未提取到」，不编。' : '从 tasks.acceptance + checkpoints 推导。',
    };
  }

  const abs = resolvePreviewPath(d.path);
  if (!abs) return { ok: false, status: 403, error: '交付物路径不在允许预览的目录内' };
  if (!existsSync(abs)) {
    return { ok: false, status: 404, error: '文件不存在或已被移走', path: d.path };
  }
  let st;
  try { st = statSync(abs); } catch (err) {
    return { ok: false, status: 404, error: `读取文件失败：${String(err.message || err).slice(0, 200)}` };
  }
  if (!st.isFile()) return { ok: false, status: 400, error: '不是文件' };

  const ext = extname(abs).toLowerCase();
  if (IMAGE_EXT.has(ext)) {
    return {
      ok: true,
      deliverable: d,
      preview: 'image',
      path: d.path,
      title: d.title,
      url: `/api/office/file?path=${encodeURIComponent(normalizePath(abs))}`,
      bytes: st.size,
      modifiedAt: st.mtime.toISOString(),
    };
  }
  if (!TEXT_EXT.has(ext)) {
    return {
      ok: true, deliverable: d, preview: 'binary', path: d.path, title: d.title,
      bytes: st.size, note: '二进制文件，不支持文本预览',
    };
  }

  const file = readText(abs);
  if (ext === '.md' || ext === '.markdown') {
    return {
      ok: true, deliverable: d, preview: 'markdown', path: d.path, title: d.title,
      text: file.text, bytes: file.bytes, truncated: file.truncated, modifiedAt: file.modifiedAt,
    };
  }
  const lines = firstLines(file.text, PREVIEW_LINES);
  return {
    ok: true, deliverable: d,
    preview: CODE_EXT.has(ext) ? 'code' : 'text',
    path: d.path, title: d.title, text: lines.text,
    total_lines: lines.total_lines, shown_lines: lines.shown_lines,
    bytes: file.bytes, truncated: file.truncated || lines.total_lines > PREVIEW_LINES,
    modifiedAt: file.modifiedAt,
    note: lines.total_lines > PREVIEW_LINES ? `只显示前 ${PREVIEW_LINES} 行，共 ${lines.total_lines} 行` : null,
  };
}

export { REPO_ROOT };
