#!/usr/bin/env node
// collect-deliverables.mjs — 从真实文件/记录推导交付物，写 deliverables 表。
//
// 铁律：不新增人工填写，不编造。
//   requirement  docs/产品需求-*.md、docs/TASK-*.md、docs/决定-*.md
//   task_spec    C:/Tools/agent-autoloop/claude-*.txt、dsh-*.txt、.dsh-*-prompt.txt
//   dev_output   git log 的 commit + 改动文件
//   artifact     docs/screenshots/**、docs/evidence/**
//   review       C:/Tools/agent-autoloop/*-answer.md、office-r*-raw.txt
//   retro        评审文档里的「结论」「改进建议」；解析不出来写「未提取到」
//   goal_report  tasks.acceptance + checkpoints 推导
//
// 关联：文件路径 / commit message 里能匹配到任务标识才挂任务；
// 匹配不上 task_id=NULL，进「未关联交付物」区，不硬塞。
//
// 用法：
//   node --no-warnings scripts/collect-deliverables.mjs
//   node --no-warnings scripts/collect-deliverables.mjs --json   # 机器可读汇总
//
// 采集是独立 CLI：API 只读 deliverables 表，不在请求里扫目录/跑 git。

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, closeDb, REPO_ROOT } from '../web/lib/db.mjs';
import { listTasks } from '../web/lib/tasks.mjs';
import {
  DELIVERABLE_KINDS, computeGoal, deliverableId, normalizePath, replaceAllDeliverables,
} from '../web/lib/deliverables.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = resolve(HERE, '..');
const AUTOLOOP = 'C:/Tools/agent-autoloop';
const AS_JSON = process.argv.includes('--json');

const KIND_TITLE = Object.fromEntries(DELIVERABLE_KINDS.map((k) => [k.kind, k.label]));

function isoOf(ms) {
  return new Date(Number.isFinite(Number(ms)) ? Number(ms) : Date.now()).toISOString();
}
function mtimeIso(path) {
  try { return statSync(path).mtime.toISOString(); } catch { return null; }
}
function readText(path, max = 2 * 1024 * 1024) {
  try { return readFileSync(path).subarray(0, max).toString('utf8'); } catch { return ''; }
}
function listDirSafe(dir) {
  try { return readdirSync(dir); } catch { return []; }
}
function walkFiles(root, relBase = '') {
  const out = [];
  const walk = (abs, rel) => {
    for (const name of listDirSafe(abs)) {
      const a = join(abs, name);
      let st;
      try { st = statSync(a); } catch { continue; }
      if (st.isDirectory()) walk(a, rel ? `${rel}/${name}` : name);
      else if (st.isFile()) out.push({ abs: a, rel: rel ? `${rel}/${name}` : name, mtime: st.mtime.toISOString(), bytes: st.size });
    }
  };
  walk(root, relBase);
  return out;
}

/* ----------------------------------------------------------- 任务匹配 */

function norm(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function taskAliases(task) {
  const aliases = new Set();
  const title = String(task.title || '');
  aliases.add(String(task.task_id || ''));
  aliases.add(title);
  // 标题按「：·—」切成可独立匹配的短语；太短的（第一批/第二批）不参与，避免乱挂。
  for (const part of title.split(/[：:·—–]+/)) {
    const p = part.trim();
    if (p.length >= 4) aliases.add(p);
  }
  // Agent Chat P1 这类批次号：允许 p1 作为独立词匹配（p1 不能匹配 p10）。
  const pn = title.match(/\bP(\d{1,2})\b/i);
  if (pn) aliases.add(`p${pn[1]}`);
  return [...aliases].filter((a) => norm(a).length >= 2);
}

function taskFamilyAliases(task) {
  const title = String(task.title || '');
  const out = new Set();
  // Agent Chat P1 → Agent Chat；转盘与 Agent 可添加 · 第一批 → 转盘与 Agent 可添加
  const beforePn = title.split(/\bP\d{1,2}\b/i)[0];
  const beforeBatch = title.split(/第[一二三四五六七八九十0-9]+批/)[0];
  for (const raw of [beforePn, beforeBatch]) {
    const p = raw.replace(/[：:·—–\-]+$/, '').trim();
    if (p.length >= 4) out.add(p);
  }
  return [...out];
}

function compact(s) {
  return norm(s).replace(/[\s_\-—–·:：]/g, '');
}

function buildMatcher(tasks) {
  const entries = tasks.map((t) => ({ task: t, aliases: taskAliases(t) }));
  function matchTasks(text, opts = {}) {
    const hay = norm(text);
    if (!hay) return [];
    const allowPn = opts.pn !== false;
    const hit = [];
    for (const { task, aliases } of entries) {
      let ok = false;
      for (const alias of aliases) {
        const a = norm(alias);
        if (!a) continue;
        if (a.startsWith('p') && /^p\d{1,2}$/.test(a)) {
          if (!allowPn) continue;
          // 批次号按词边界匹配，p1 不能命中 p10 / p12
          if (new RegExp(`(^|[^a-z0-9])${a}([^0-9]|$)`).test(hay)) { ok = true; break; }
        } else if (hay.includes(a)) {
          ok = true; break;
        }
      }
      if (ok) hit.push(task);
    }
    return hit;
  }

  // 需求文档用：路径里的批次号常写成 V1 / 第一批，先按普通规则，
  // 不中再按「任务家族」压缩匹配（AgentChat-V1 → Agent Chat P1-P7）。
  matchTasks.requirement = function matchRequirement(text) {
    const direct = matchTasks(text);
    if (direct.length) return direct;
    const hay = compact(text);
    if (!hay) return [];
    const hit = [];
    for (const task of tasks) {
      for (const fam of taskFamilyAliases(task)) {
        const f = compact(fam);
        if (f.length >= 4 && hay.includes(f)) { hit.push(task); break; }
      }
    }
    return hit;
  };
  return matchTasks;
}

function uniqueTasks(list) {
  const seen = new Set();
  return (list || []).filter((t) => {
    if (!t || seen.has(t.task_id)) return false;
    seen.add(t.task_id);
    return true;
  });
}

/**
 * 任务书文件名 → 任务。文件名里的 p1 / p2-p7 / p5p7b 是真实批次标识，
 * 先按批次号精确展开；没有批次号再按 chat / dial / deliverables 等主题词。
 * 不用正文匹配：同一份总任务书会提到多个批次，按正文匹配会把任务书硬塞给
 * 它只是举例提到的任务（例如本轮任务书提到 Agent Chat P1 截图）。
 */
function matchTaskSpec(name, tasks) {
  const hay = norm(name);
  const nums = new Set();
  const ranged = /p(\d{1,2})\s*[-~—]\s*p?(\d{1,2})/g;
  let m;
  while ((m = ranged.exec(hay))) {
    const a = Number(m[1]); const b = Number(m[2]);
    if (a <= b && b - a <= 20) for (let i = a; i <= b; i += 1) nums.add(i);
  }
  const packed = /p(\d{1,2})p(\d{1,2})/g;
  while ((m = packed.exec(hay))) {
    nums.add(Number(m[1])); nums.add(Number(m[2]));
  }
  const single = /(^|[^a-z0-9])p(\d{1,2})(?![0-9])/g;
  while ((m = single.exec(hay))) nums.add(Number(m[2]));

  const hit = [];
  for (const n of nums) {
    const re = new RegExp(`(^|[^A-Za-z0-9])P${n}(?![0-9])`, 'i');
    for (const t of tasks) if (re.test(t.title)) hit.push(t);
  }
  if (hit.length) return uniqueTasks(hit);

  const themes = [
    [/chat/, /agent chat/i],
    [/dial|turntable|转盘/, /转盘/],
    [/deliverable/, /交付物/],
    [/quota|handoff/, /额度|交接/],
    [/replica|cromma/, /复刻/],
    [/easedraw/, /easedraw/i],
  ];
  for (const [fileRe, taskRe] of themes) {
    if (fileRe.test(hay)) return uniqueTasks(tasks.filter((t) => taskRe.test(t.title)));
  }
  return [];
}

/* ----------------------------------------------------------- git */

function git(args, max = 16 * 1024 * 1024) {
  try {
    return execFileSync('git', ['-c', 'core.autocrlf=false', '-C', REPO, ...args], {
      encoding: 'utf8', maxBuffer: max, timeout: 60000, windowsHide: true,
    });
  } catch {
    return '';
  }
}

function readCommits() {
  // 一次 git log 拿 commit 元信息 + 改动文件；预览时再按 sha 跑 git show --stat --patch。
  const raw = git(['log', '--no-merges', '--pretty=format:%x1e%H%x09%aI%x09%an%x09%s', '--name-only', '-n', '400']);
  if (!raw) return [];
  const out = [];
  for (const rec of raw.split('\x1e')) {
    if (!rec.trim()) continue;
    const lines = rec.split(/\r?\n/);
    const head = lines.shift() || '';
    const [sha, at, author, ...subjectParts] = head.split('\t');
    const subject = subjectParts.join('\t').trim();
    const files = lines.map((s) => s.trim()).filter(Boolean).map(normalizePath);
    out.push({ sha, at, author, subject, files });
  }
  return out;
}

/* ----------------------------------------------------------- 评审 / 复盘 */

function extractReview(text) {
  const lines = String(text || '').split(/\r?\n/);
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  let conclusion = null;
  let improvement = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    // 「结论：」后面可能换行再接一段
    if (!conclusion && /^结论[：:]/.test(line)) {
      const buf = [line.replace(/^结论[：:]\s*/, '')];
      for (let j = i + 1; j < Math.min(lines.length, i + 8); j += 1) {
        const next = lines[j].trim();
        if (!next) { if (buf.join('').length > 0) break; continue; }
        if (/^[一二三四五六七八九十#]+[、.．]/.test(next) || /^(问题|建议|下一步)/.test(next)) break;
        buf.push(next);
      }
      conclusion = clean(buf.join(' ')).slice(0, 1200) || null;
      continue;
    }
    // 「改进建议 / 修改建议」必须是真标题（# 标题或「建议：内容」），
    // 不接受表格里的「修改建议」单元格——那只是表格表头，后面跟的是
    // 别的行内容，抽出来会变成一句不完整的假建议。抽不到就保持 null，
    // 落库时写「未提取到」。
    if (!improvement) {
      const heading = line.match(/^#{1,6}\s*(改进建议|修改建议|建议)\s*$/);
      const inline = line.match(/^(改进建议|修改建议|建议)[：:]\s*(.+)$/);
      if (heading || inline) {
        const buf = inline ? [inline[2]] : [];
        for (let j = i + 1; j < Math.min(lines.length, i + 60); j += 1) {
          const next = lines[j].trim();
          if (!next) { if (buf.length) break; continue; }
          if (/^#{1,6}\s/.test(next)) break;
          if (/^(结论|下一步|附录|参考|版本|评审|问题)[：:]/.test(next)) break;
          if (/^[一二三四五六七八九十]+[、.．]/.test(next) && buf.length) break;
          buf.push(next);
        }
        improvement = clean(buf.join(' ')).slice(0, 2000) || null;
      }
    }
  }
  return { conclusion, improvement };
}

function reviewTitle(path) {
  return basename(path);
}

/* ----------------------------------------------------------- 采集主流程 */

function main() {
  const db = openDb();
  const tasks = listTasks(db, { limit: 1000 });
  const matchTasks = buildMatcher(tasks);
  const rows = [];
  const seen = new Set();

  const add = (row) => {
    const key = `${row.kind}|${row.task_id || '_unlinked'}|${row.path || row.content_ref || row.title}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(row);
  };

  const agentOfTask = (taskId) => {
    try {
      const r = db.prepare(
        'SELECT agent_id FROM attempts WHERE task_id = ? ORDER BY started_at DESC LIMIT 1',
      ).get(taskId);
      return r ? r.agent_id : null;
    } catch { return null; }
  };
  const statusFor = (task, fallback = 'submitted') => {
    if (!task) return fallback;
    if (task.status === 'completed') return 'accepted';
    if (task.status === 'failed' || task.status === 'blocked') return 'rejected';
    return 'submitted';
  };

  /* ---- 1. requirement：需求讨论文档 ---- */
  const docDir = join(REPO, 'docs');
  const reqFiles = listDirSafe(docDir)
    .filter((n) => /^(产品需求-.*|TASK-.*|决定-.*)\.md$/.test(n))
    .map((n) => join(docDir, n))
    .filter((p) => existsSync(p));
  for (const abs of reqFiles) {
    const rel = normalizePath(relative(REPO, abs));
    const hits = uniqueTasks(matchTasks.requirement(rel));
    const at = mtimeIso(abs) || isoOf();
    const target = hits.length ? hits : [null];
    for (const task of target) {
      add({
        deliverable_id: deliverableId('requirement', task && task.task_id, rel),
        task_id: task ? task.task_id : null,
        kind: 'requirement',
        title: basename(abs, extname(abs)),
        path: rel,
        content_ref: null,
        status: statusFor(task),
        created_by: task ? agentOfTask(task.task_id) : null,
        created_at: at,
        updated_at: at,
      });
    }
  }

  /* ---- 2. task_spec：派给 Agent 的任务书 ---- */
  const specNames = listDirSafe(AUTOLOOP).filter((n) => (
    /^claude-.*\.txt$/.test(n) || /^dsh-.*\.txt$/.test(n) || /^\.dsh-.*-prompt\.txt$/.test(n)
  ));
  for (const name of specNames) {
    const abs = normalizePath(join(AUTOLOOP, name));
    if (!existsSync(abs)) continue;
    const hits = uniqueTasks(matchTaskSpec(name, tasks));
    const at = mtimeIso(abs) || isoOf();
    const target = hits.length ? hits : [null];
    for (const task of target) {
      add({
        deliverable_id: deliverableId('task_spec', task && task.task_id, abs),
        task_id: task ? task.task_id : null,
        kind: 'task_spec',
        title: name,
        path: abs,
        content_ref: null,
        status: statusFor(task),
        created_by: task ? agentOfTask(task.task_id) : null,
        created_at: at,
        updated_at: at,
      });
    }
  }

  /* ---- 3. artifact：截图 / 证据（先扫文件，再用 commit 反查归属） ---- */
  const commitFiles = new Map(); // 文件路径 -> Set(task_id)
  const commits = readCommits();
  for (const c of commits) {
    const hits = uniqueTasks(matchTasks(c.subject));
    if (!hits.length) continue;
    for (const f of c.files) {
      if (!commitFiles.has(f)) commitFiles.set(f, new Set());
      for (const t of hits) commitFiles.get(f).add(t.task_id);
    }
  }

  const artifactDirs = [join(REPO, 'docs', 'screenshots'), join(REPO, 'docs', 'evidence')];
  for (const dir of artifactDirs) {
    if (!existsSync(dir)) continue;
    for (const f of walkFiles(dir)) {
      const rel = normalizePath(relative(REPO, f.abs));
      const direct = uniqueTasks(matchTasks(rel));
      const viaCommit = [...(commitFiles.get(rel) || [])]
        .map((id) => tasks.find((t) => t.task_id === id))
        .filter(Boolean);
      const hits = uniqueTasks([...direct, ...viaCommit]);
      const target = hits.length ? hits : [null];
      for (const task of target) {
        add({
          deliverable_id: deliverableId('artifact', task && task.task_id, rel),
          task_id: task ? task.task_id : null,
          kind: 'artifact',
          title: basename(f.abs),
          path: rel,
          content_ref: null,
          status: statusFor(task),
          created_by: task ? agentOfTask(task.task_id) : null,
          created_at: f.mtime,
          updated_at: f.mtime,
        });
      }
    }
  }

  /* ---- 4. dev_output：git commit + 改动文件 ---- */
  for (const c of commits) {
    if (!c.sha) continue;
    const hits = uniqueTasks(matchTasks(c.subject));
    const filesChanged = c.files.length;
    const target = hits.length ? hits : [null];
    for (const task of target) {
      add({
        deliverable_id: deliverableId('dev_output', task && task.task_id, c.sha),
        task_id: task ? task.task_id : null,
        kind: 'dev_output',
        title: c.subject || c.sha.slice(0, 8),
        path: null,
        content_ref: `git:${c.sha}`,
        status: statusFor(task, 'submitted'),
        created_by: c.author || null,
        created_at: c.at || isoOf(),
        updated_at: c.at || isoOf(),
        meta: { sha: c.sha, files_changed: filesChanged, files: c.files.slice(0, 80), author: c.author },
      });
    }
  }

  /* ---- 5/6. review + retro：GPT 评审文档 ---- */
  const reviewFiles = [];
  for (const name of listDirSafe(AUTOLOOP)) {
    if (/^.*-answer\.md$/.test(name) || /^office-r.*-raw\.txt$/.test(name)) {
      const abs = normalizePath(join(AUTOLOOP, name));
      if (existsSync(abs)) reviewFiles.push(abs);
    }
  }
  for (const abs of reviewFiles) {
    const name = basename(abs);
    const text = readText(abs);
    const hits = uniqueTasks(matchTasks(name, { pn: false }));
    const at = mtimeIso(abs) || isoOf();
    const target = hits.length ? hits : [null];
    for (const task of target) {
      add({
        deliverable_id: deliverableId('review', task && task.task_id, abs),
        task_id: task ? task.task_id : null,
        kind: 'review',
        title: reviewTitle(abs),
        path: abs,
        content_ref: null,
        status: statusFor(task, 'submitted'),
        created_by: task ? agentOfTask(task.task_id) : null,
        created_at: at,
        updated_at: at,
      });

      const extracted = extractReview(text);
      const hasAnything = Boolean(extracted.conclusion || extracted.improvement);
      const retroText = [
        extracted.conclusion ? `结论：${extracted.conclusion}` : '结论：未提取到',
        extracted.improvement ? `改进建议：${extracted.improvement}` : '改进建议：未提取到',
      ].join('\n\n');
      add({
        deliverable_id: deliverableId('retro', task && task.task_id, `${abs}|retro`),
        task_id: task ? task.task_id : null,
        kind: 'retro',
        title: `复盘与改进建议 · ${name}`,
        path: null,
        content_ref: JSON.stringify({
          source_path: abs,
          extracted: hasAnything,
          conclusion: extracted.conclusion || '未提取到',
          improvement: extracted.improvement || '未提取到',
          text: retroText,
        }),
        status: statusFor(task, 'submitted'),
        created_by: task ? agentOfTask(task.task_id) : null,
        created_at: at,
        updated_at: at,
      });
    }
  }

  /* ---- 7. goal_report：acceptance + checkpoints 推导 ---- */
  for (const task of tasks) {
    const goal = computeGoal(db, task);
    const at = task.updated_at || task.created_at || isoOf();
    add({
      deliverable_id: deliverableId('goal_report', task.task_id, task.task_id),
      task_id: task.task_id,
      kind: 'goal_report',
      title: `目标达成 · ${task.title}`,
      path: null,
      content_ref: JSON.stringify(goal),
      status: goal.judgement === 'achieved' ? 'accepted'
        : goal.judgement === 'no_goal' ? 'draft'
          : goal.judgement === 'missed' ? 'rejected' : 'submitted',
      created_by: 'system',
      created_at: at,
      updated_at: at,
    });
  }

  const inserted = replaceAllDeliverables(db, rows);
  closeDb(db);

  const summary = {
    ok: true,
    generated_at: new Date().toISOString(),
    db: process.env.AGENT_OFFICE_DB || 'data/agent-office.db',
    tasks: tasks.length,
    deliverables: inserted,
    linked: rows.filter((r) => r.task_id).length,
    unlinked: rows.filter((r) => !r.task_id).length,
    by_kind: Object.fromEntries(DELIVERABLE_KINDS.map((k) => [k.kind, rows.filter((r) => r.kind === k.kind).length])),
    by_task: Object.fromEntries(tasks.map((t) => [
      t.task_id,
      Object.fromEntries(DELIVERABLE_KINDS.map((k) => [
        k.kind, rows.filter((r) => r.task_id === t.task_id && r.kind === k.kind).length,
      ])),
    ])),
    sources: {
      requirement_files: reqFiles.length,
      task_spec_files: specNames.length,
      commits: commits.length,
      artifact_files: artifactDirs.reduce((n, d) => n + (existsSync(d) ? walkFiles(d).length : 0), 0),
      review_files: reviewFiles.length,
    },
  };

  if (AS_JSON) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log('交付物采集完成');
    console.log(`  任务 ${summary.tasks} 个 · 交付物 ${summary.deliverables} 条（已关联 ${summary.linked} / 未关联 ${summary.unlinked}）`);
    console.log(`  来源：需求文档 ${summary.sources.requirement_files} · 任务书 ${summary.sources.task_spec_files} · commit ${summary.sources.commits} · 产物文件 ${summary.sources.artifact_files} · 评审 ${summary.sources.review_files}`);
    console.log(`  分类：${DELIVERABLE_KINDS.map((k) => `${k.label} ${summary.by_kind[k.kind]}`).join(' · ')}`);
    const agentChat = tasks.filter((t) => /Agent Chat P[1-7]/.test(t.title));
    if (agentChat.length) {
      console.log('  Agent Chat 链：');
      for (const t of agentChat) {
        const c = summary.by_task[t.task_id];
        console.log(`    ${t.task_id} ${t.title.slice(0, 36)}  ` +
          DELIVERABLE_KINDS.map((k) => `${k.short}${c[k.kind] || 0}`).join(' '));
      }
    }
    console.log('  未关联交付物保留在原表 task_id=NULL，前端单独展示，不硬塞任务。');
  }
}

main();
