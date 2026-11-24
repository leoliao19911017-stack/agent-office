// build.mjs — 结构化交接包生成器
//
// 目标：换 Agent 时，接手的人不用读 5000 字对话，先看 6 个板块就知道：
//   任务是什么 / 做到哪 / 代码现场 / 试过什么 / 什么没成 / 下一步
//
// 数据源分两层，硬事实优先：
//   1) 系统事实（硬编码，不由 LLM 编）：
//      - git branch / HEAD / 未提交文件 / worktree        ← git 命令
//      - task / steps / attempts / checkpoints / events   ← agent-office.db
//      - chat_turns 的失败记录                             ← agent-office.db
//   2) 会话原文（catchup 导出）：
//      - 只从中摘录「失败/坑/未决问题/最后请求」，并带 [会话] 来源标记
//      - 摘要不是事实来源；attempts 一律来自 DB，不采用 LLM 编造
//
// 用法：
//   node scripts/handoff/build.mjs --thread th-xxxx
//   node scripts/handoff/build.mjs --task t-xxxx --to claude
//   node scripts/handoff/build.mjs --thread th-xxxx --json
//
// 输出：docs/handoffs/<handoff_id>.json + .md；catchup 原文另存 <id>.session.md

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, closeDb } from '../../web/lib/db.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');
export const HANDOFF_DIR = join(REPO_ROOT, 'docs', 'handoffs');
const CATCHUP_TEMP = 'C:/Users/Administrator/AppData/Local/Temp/catchup-bin/catchup.exe';

/** Agent → catchup 的 agent 名（dsh 在 catchup 里叫 deepseek） */
export const CATCHUP_AGENT = Object.freeze({ claude: 'claude', dsh: 'deepseek', codex: 'codex', kimi: 'kimi' });

function pad(n) { return String(n).padStart(2, '0'); }

export function localIso(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const oh = Math.floor(Math.abs(off) / 60);
  const om = Math.abs(off) % 60;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(oh)}:${pad(om)}`;
}

export function compactStamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function shortTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function safeRelative(p, cwd) {
  if (!p) return null;
  const abs = isAbsolute(p) ? p : resolve(cwd, p);
  const rel = relative(cwd, abs).replace(/\\/g, '/');
  return rel.startsWith('..') ? abs.replace(/\\/g, '/') : rel;
}

function truncate(text, n = 180) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function parseAcceptance(value) {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) return value.map(String);
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch { /* 不是 JSON，按分隔符拆 */ }
  return String(value).split(/\n|,|，|；|;/).map((s) => s.trim()).filter(Boolean);
}

function parseJsonArray(text) {
  if (!text) return [];
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

/* ---------------- git ---------------- */

function run(command, args, { cwd, timeout = 10000 } = {}) {
  try {
    return {
      ok: true,
      out: execFileSync(command, args, {
        cwd, timeout, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim(),
      error: null,
    };
  } catch (err) {
    return { ok: false, out: '', error: truncate(err.stderr ? err.stderr.toString() : err.message, 300) };
  }
}

export function gitFacts(cwd = REPO_ROOT) {
  const base = { cwd, branch: null, head_commit: null, head_commit_full: null, uncommitted: [], uncommitted_count: 0, worktree: null, repo_root: null, status_error: null };
  if (!existsSync(cwd)) return { ...base, status_error: `工作目录不存在：${cwd}` };
  const inside = run('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree'], { cwd });
  if (!inside.ok || inside.out !== 'true') return { ...base, status_error: inside.error || '不是 git 工作区' };
  const branch = run('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  const head = run('git', ['-C', cwd, 'rev-parse', 'HEAD'], { cwd });
  const headShort = run('git', ['-C', cwd, 'rev-parse', '--short', 'HEAD'], { cwd });
  const top = run('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { cwd });
  const gitDir = run('git', ['-C', cwd, 'rev-parse', '--git-dir'], { cwd });
  const commonDir = run('git', ['-C', cwd, 'rev-parse', '--git-common-dir'], { cwd });
  const status = run('git', ['--no-optional-locks', '-C', cwd, 'status', '--porcelain=v1', '-uall'], { cwd, timeout: 20000 });
  const lines = status.ok && status.out ? status.out.split(/\r?\n/).filter(Boolean) : [];
  const worktree = gitDir.ok && commonDir.ok && gitDir.out !== commonDir.out ? (top.out || cwd) : null;
  return {
    cwd,
    branch: branch.ok ? branch.out : null,
    head_commit: headShort.ok ? headShort.out : (head.ok ? head.out.slice(0, 8) : null),
    head_commit_full: head.ok ? head.out : null,
    uncommitted: lines.slice(0, 80),
    uncommitted_count: lines.length,
    uncommitted_truncated: lines.length > 80,
    worktree,
    repo_root: top.ok ? top.out.replace(/\\/g, '/') : null,
    status_error: status.ok ? null : status.error,
  };
}

/* ---------------- task doc 定位 ---------------- */

function findTaskDoc(title, cwd = REPO_ROOT) {
  const docsDir = join(cwd, 'docs');
  if (!title || !existsSync(docsDir)) return null;
  const tokens = [...String(title).matchAll(/[A-Za-z0-9]{3,}|[\u4e00-\u9fa5]{2,}/g)]
    .map((m) => m[0])
    .filter((t) => !['任务', '实现', '验收', '全量', '回归'].includes(t));
  if (!tokens.length) return null;
  let best = null;
  for (const name of readdirSync(docsDir)) {
    if (!/^TASK-.*\.md$/.test(name)) continue;
    let text;
    try { text = readFileSync(join(docsDir, name), 'utf8'); } catch { continue; }
    const score = tokens.reduce((n, t) => n + (text.includes(t) ? 1 : 0), 0);
    if (!best || score > best.score) best = { name, score };
  }
  return best && best.score >= 2 ? `docs/${best.name}` : null;
}

/* ---------------- catchup ---------------- */

export function resolveCatchupBin(explicit) {
  const candidates = [explicit, process.env.CATCHUP_BIN, join(REPO_ROOT, 'scripts', 'tools', 'catchup.exe'), CATCHUP_TEMP, 'catchup'].filter(Boolean);
  for (const c of candidates) {
    if (c === 'catchup') return c;
    if (existsSync(c)) return c;
  }
  return null;
}

export function readTranscript({ agentId, sessionId, cwd = REPO_ROOT, last = 30, catchupBin } = {}) {
  const agent = CATCHUP_AGENT[agentId];
  const empty = { ok: false, text: '', meta: null, error: null, command: null };
  if (!agent) return { ...empty, error: `catchup 不支持 agent=${agentId}（支持：${Object.keys(CATCHUP_AGENT).join(' / ')}）` };
  if (!sessionId) return { ...empty, error: 'thread 没有 provider_session_id，读不到会话原文' };
  const bin = resolveCatchupBin(catchupBin);
  if (!bin) return { ...empty, error: '找不到 catchup 可执行文件（放 scripts/tools/catchup.exe 或设 CATCHUP_BIN）' };
  const args = [agent, '--id', String(sessionId), '--last', String(last)];
  const r = run(bin, args, { cwd, timeout: 45000 });
  if (!r.ok || !r.out) return { ...empty, command: `${bin} ${args.join(' ')}`, error: r.error || 'catchup 没有输出' };
  const text = r.out;
  const head = text.split(/\n---\n/)[0] || '';
  const meta = {};
  for (const line of head.split(/\r?\n/)) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (m) meta[m[1]] = m[2].replace(/^"|"$/g, '');
  }
  return { ok: true, text, meta, error: null, command: `${bin} ${args.join(' ')}` };
}

export function parseTranscriptEntries(text) {
  if (!text) return [];
  const body = text.includes('\n---\n') ? text.split(/\n---\n/).slice(1).join('\n---\n') : text;
  const re = /^## (\d+)\. (user|assistant|tool|system) \| (.+)$/gm;
  const marks = [];
  let m;
  while ((m = re.exec(body))) marks.push({ index: m.index, end: re.lastIndex, n: Number(m[1]), role: m[2], at: m[3] });
  return marks.map((mark, i) => {
    const start = mark.end;
    const end = i + 1 < marks.length ? marks[i + 1].index : body.length;
    return { n: mark.n, role: mark.role, at: mark.at.trim(), content: body.slice(start, end).trim() };
  });
}

/* ---------------- 数据库 ---------------- */

function loadThread(db, threadId) {
  return db.prepare('SELECT * FROM chat_threads WHERE thread_id=?').get(threadId) || null;
}
function loadTask(db, taskId) {
  return db.prepare('SELECT * FROM tasks WHERE task_id=?').get(taskId) || null;
}
function loadSteps(db, taskId) {
  return db.prepare('SELECT * FROM task_steps WHERE task_id=? ORDER BY seq').all(taskId);
}
function loadAttempts(db, taskId) {
  return db.prepare('SELECT * FROM attempts WHERE task_id=? ORDER BY started_at').all(taskId);
}
function loadCheckpoints(db, taskId) {
  return db.prepare('SELECT * FROM checkpoints WHERE task_id=? ORDER BY created_at DESC LIMIT 20').all(taskId);
}
function loadTurns(db, threadId) {
  return db.prepare('SELECT * FROM chat_turns WHERE thread_id=? ORDER BY created_at').all(threadId);
}
function loadMessages(db, threadId) {
  return db.prepare('SELECT * FROM chat_messages WHERE thread_id=? ORDER BY seq').all(threadId);
}

/* ---------------- 从会话摘录（只摘，不编） ---------------- */

const HARD_FAIL = /(失败|报错|错误|不支持|无法|不能|unknown option|not found|ENOENT|超时|限流|额度|529|429|400\b|401\b|403\b|404\b|409\b|500\b|502\b|503\b)/i;

export function extractFromTranscript(entries) {
  const deadEnds = [];
  const questions = [];
  for (const e of entries) {
    const content = String(e.content || '').trim();
    if (!content) continue;
    if (e.role === 'assistant') {
      for (const line of content.split(/\r?\n/)) {
        const s = line.replace(/^[-*#>\s]+/, '').trim();
        if (s.length >= 8 && s.length <= 220 && HARD_FAIL.test(s) && !/^写|^请|^你/.test(s)) {
          deadEnds.push(`[会话] ${s}`);
        }
      }
    }
    if (e.role === 'user') {
      for (const line of content.split(/\r?\n/)) {
        const s = line.replace(/^[-*#>\s]+/, '').trim();
        if (s.length >= 6 && s.length <= 180 && /[?？]|待确认|未确认|要不要|是否/.test(s)) {
          questions.push(`[会话] ${s}`);
        }
      }
    }
  }
  const uniq = (arr) => [...new Set(arr.map((s) => s.replace(/\s+/g, ' ').trim()))];
  return { dead_ends: uniq(deadEnds).slice(0, 8), open_questions: uniq(questions).slice(-5) };
}

/* ---------------- 组装 ---------------- */

function oppositeAgent(agentId) {
  if (agentId === 'claude') return 'dsh';
  if (agentId === 'dsh') return 'claude';
  if (agentId === 'codex') return 'dsh';
  return 'dsh';
}

function reasonFrom({ taskState, turns }) {
  if (taskState && taskState.status === 'blocked') return 'blocked';
  const lastTurn = [...(turns || [])].reverse().find((t) => t.status === 'failed' || t.status === 'rate_limited');
  if (lastTurn) {
    let err = {};
    try { err = JSON.parse(lastTurn.error_json || '{}'); } catch { /* 保留空 */ }
    if (Number(err.api_error_status) === 429 || String(err.message || '').includes('429')) return 'rate_limited';
    if (Number(err.api_error_status) === 529 || String(err.message || '').includes('529')) return 'rate_limited';
    return 'failed';
  }
  return 'manual';
}

/**
 * 生成一份交接包（默认落盘）。
 * @param {{threadId?:string, taskId?:string, toAgentId?:string, reason?:string, outDir?:string,
 *          cwd?:string, catchup?:boolean, last?:number, now?:Date, write?:boolean, dbPath?:string,
 *          catchupBin?:string, handoffId?:string}} opts
 */
export async function buildHandoff(opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const db = getDb(opts.dbPath ? { path: opts.dbPath } : {});
  let thread = null;
  let task = null;
  if (opts.threadId) {
    thread = loadThread(db, String(opts.threadId));
    if (!thread) throw Object.assign(new Error(`thread 不存在：${opts.threadId}`), { statusCode: 404, code: 'THREAD_NOT_FOUND' });
    if (thread.task_id) task = loadTask(db, thread.task_id);
  }
  if (opts.taskId) {
    const t = loadTask(db, String(opts.taskId));
    if (!t) throw Object.assign(new Error(`task 不存在：${opts.taskId}`), { statusCode: 404, code: 'TASK_NOT_FOUND' });
    if (task && task.task_id !== t.task_id) {
      throw Object.assign(new Error(`thread 关联的是 ${task.task_id}，与传入 ${t.task_id} 不一致`), { statusCode: 409, code: 'TASK_THREAD_MISMATCH' });
    }
    task = t;
  }
  if (!thread && !task) throw Object.assign(new Error('必须给 thread_id 或 task_id'), { statusCode: 400, code: 'MISSING_INPUT' });

  const taskId = task ? task.task_id : null;
  const cwd = (thread && thread.workspace) ? thread.workspace : (opts.cwd || REPO_ROOT);
  const steps = taskId ? loadSteps(db, taskId) : [];
  const attemptsRows = taskId ? loadAttempts(db, taskId) : [];
  const checkpoints = taskId ? loadCheckpoints(db, taskId) : [];
  const turns = thread ? loadTurns(db, thread.thread_id) : [];
  const messages = thread ? loadMessages(db, thread.thread_id) : [];

  // 状态口径复用任务状态机；任务不存在就不编状态
  let taskState = null;
  if (taskId) {
    try {
      const { evaluateTaskState } = await import('../../web/lib/state-machine.mjs');
      taskState = evaluateTaskState(db, taskId, { now });
    } catch (err) {
      taskState = { status: task.status, status_reason: `状态机读取失败：${err.message}`, blocked_reason: null };
    }
  }

  const fromAgent = (thread && thread.agent_id) || (attemptsRows.length ? attemptsRows[attemptsRows.length - 1].agent_id : 'unknown');
  const toAgent = opts.toAgentId || oppositeAgent(fromAgent);
  const reason = opts.reason || reasonFrom({ taskState, turns });

  // 会话原文（失败不阻塞交接包；错误如实写进 artifacts）
  let transcript = { ok: false, text: '', meta: null, error: '跳过（--no-catchup）', command: null };
  if (opts.catchup !== false && thread) {
    transcript = readTranscript({
      agentId: thread.agent_id,
      sessionId: thread.provider_session_id,
      cwd,
      last: opts.last || 30,
      catchupBin: opts.catchupBin,
    });
  }
  const entries = transcript.ok ? parseTranscriptEntries(transcript.text) : [];
  const extracted = extractFromTranscript(entries);

  // 任务
  const title = task ? task.title : (thread.title || `对话 ${thread.thread_id}`);
  const acceptance = task ? parseAcceptance(task.acceptance) : [];
  const taskDoc = task ? findTaskDoc(task.title, cwd) : null;

  // 进度：只写 DB / 状态机里的事实
  const doneSteps = steps.filter((s) => s.status === 'done' || s.status === 'skipped');
  const runningStep = steps.find((s) => s.status === 'running') || null;
  const pendingStep = steps.find((s) => s.status !== 'done' && s.status !== 'skipped');
  const latestCheckpoint = checkpoints[0] || null;
  const progressDone = [];
  if (doneSteps.length) progressDone.push(...doneSteps.map((s) => `${s.name || s.step_key}（${s.step_key}，${s.status}）`));
  if (checkpoints.length) progressDone.push(`已有 ${checkpoints.length} 个检查点；最新 ${String(latestCheckpoint.git_sha || '').slice(0, 12) || '无 sha'}`);
  if (!progressDone.length) progressDone.push(thread ? `对话已进行 ${turns.length} 轮；任务尚未登记步骤` : '任务尚未登记步骤');
  const doing = taskState && taskState.status === 'completed'
    ? '任务已完成，没有进行中的步骤'
    : runningStep
      ? `正在执行：${runningStep.name || runningStep.step_key}（${runningStep.step_key}）`
      : (attemptsRows.length ? `最近一次执行：${attemptsRows[attemptsRows.length - 1].agent_id} / ${attemptsRows[attemptsRows.length - 1].status}` : (pendingStep ? `排队中：${pendingStep.name || pendingStep.step_key}` : (taskState ? taskState.status_reason : '没有执行记录')));
  const blocked = taskState && taskState.status === 'blocked'
    ? (taskState.blocked_reason || taskState.status_reason || '已阻塞')
    : '无阻塞';

  // attempts：任务 attempts + 对话失败轮次，都是 DB 真记录
  const attempts = [];
  for (const a of attemptsRows) {
    attempts.push({
      at: shortTime(a.started_at),
      at_iso: a.started_at,
      what: `${a.agent_id} 执行 ${a.attempt_id}${a.note ? `：${truncate(a.note, 80)}` : ''}`,
      result: a.status,
      why: a.end_reason || a.note || '',
      source: 'attempts',
    });
  }
  turns.forEach((t, i) => {
    if (!['failed', 'interrupted', 'rate_limited', 'unknown'].includes(t.status)) return;
    let err = {};
    try { err = JSON.parse(t.error_json || '{}'); } catch { /* 保留空 */ }
    attempts.push({
      at: shortTime(t.started_at || t.created_at),
      at_iso: t.started_at || t.created_at,
      what: `第 ${i + 1} 轮对话（${t.provider}）`,
      result: t.status,
      why: err.message || err.reason || err.label || '',
      source: 'chat_turns',
    });
  });
  attempts.sort((a, b) => String(a.at_iso || '').localeCompare(String(b.at_iso || '')));

  // 死路：失败 attempt + 会话里明确的错误行；不把用户提示词里的「不要」当死路
  const deadEnds = [];
  for (const a of attemptsRows) {
    if (['failed', 'interrupted'].includes(a.status)) {
      deadEnds.push(`[执行记录] ${a.agent_id} ${shortTime(a.started_at)} ${a.status}：${truncate(a.end_reason || a.note || '没有原因记录', 160)}`);
    }
  }
  for (const t of turns) {
    if (!['failed', 'interrupted', 'rate_limited'].includes(t.status)) continue;
    let err = {};
    try { err = JSON.parse(t.error_json || '{}'); } catch { /* 保留空 */ }
    deadEnds.push(`[对话] ${shortTime(t.started_at)} ${t.status}：${truncate(err.message || err.reason || '没有原因记录', 160)}`);
  }
  deadEnds.push(...extracted.dead_ends);
  const deadEndsUniq = [...new Set(deadEnds)].slice(0, 10);
  if (!deadEndsUniq.length) deadEndsUniq.push('没有记录到明确的死路/失败；先按下一步继续，别重复造轮子。');

  // 下一步：任务状态机优先
  let nextAction;
  if (taskState) {
    switch (taskState.status) {
      case 'completed':
        nextAction = '任务已完成（验收通过）；如要返工，重新开 attempt 并写清楚哪条验收不通过。';
        break;
      case 'blocked':
        nextAction = `先解除阻塞：${taskState.blocked_reason || taskState.status_reason}；解除后重新 attempt，不要直接改文件。`;
        break;
      case 'running':
        nextAction = `继续 ${runningStep ? (runningStep.name || runningStep.key) : '当前步骤'}；完成后先 POST checkpoint，再 finish（必须带证据）。`;
        break;
      case 'waiting':
        nextAction = `等用户确认/补材料：${taskState.status_reason}；确认后再继续。`;
        break;
      default:
        nextAction = `先核对执行实例与最新检查点（${latestCheckpoint ? String(latestCheckpoint.git_sha || '').slice(0, 12) : '无'}），再从剩余步骤继续。`;
    }
  } else {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    nextAction = lastUser
      ? `继续最后一条用户请求：${truncate(lastUser.content, 160)}`
      : '先读会话原文与未提交改动，确认要交接的目标后再动手。';
  }

  const openQuestions = extracted.open_questions.length
    ? extracted.open_questions
    : ['无明确未决问题；按 next_action 继续，遇到阻塞再登记。'];

  // 代码现场：先取 git，再写文件（写文件后 untracked 会变，快照必须取在写之前）
  const workspace = gitFacts(cwd);

  // 产物
  const docs = [];
  if (taskDoc) docs.push(taskDoc);
  const evidence = [];
  for (const c of checkpoints) {
    for (const f of [...parseJsonArray(c.files), ...parseJsonArray(c.untracked)]) {
      const p = typeof f === 'string' ? f : (f && f.path);
      const rel = safeRelative(p, cwd);
      if (!rel) continue;
      if (rel.startsWith('docs/evidence/') && !evidence.includes(rel)) evidence.push(rel);
      else if (/\.md$/i.test(rel) && rel.startsWith('docs/') && !docs.includes(rel) && docs.length < 8) docs.push(rel);
    }
  }
  if (taskState && taskState.verification && taskState.verification.report) {
    const rel = safeRelative(taskState.verification.report, cwd);
    if (rel && !evidence.includes(rel)) evidence.push(rel);
  }

  const handoffId = opts.handoffId || await (async () => {
    const base = `ho-${compactStamp(now)}`;
    let id = base;
    for (let n = 2; ; n += 1) {
      if (!existsSync(join(opts.outDir || HANDOFF_DIR, `${id}.json`)) && !existsSync(join(opts.outDir || HANDOFF_DIR, `${id}.md`))) return id;
      id = `${base}-${n}`;
    }
  })();

  const pkg = {
    handoff_id: handoffId,
    created_at: localIso(now),
    from: { agent_id: fromAgent, session_id: (thread && thread.provider_session_id) || null, reason },
    to: { agent_id: toAgent },
    task: {
      task_id: taskId,
      title,
      goal: task ? task.title : (thread ? `对话目标：${thread.title || thread.thread_id}` : ''),
      acceptance,
      task_doc: taskDoc,
    },
    progress: {
      done: progressDone,
      doing,
      blocked,
    },
    workspace: {
      cwd: workspace.cwd,
      branch: workspace.branch,
      head_commit: workspace.head_commit,
      head_commit_full: workspace.head_commit_full,
      uncommitted: workspace.uncommitted,
      uncommitted_count: workspace.uncommitted_count,
      uncommitted_truncated: workspace.uncommitted_truncated,
      worktree: workspace.worktree,
      repo_root: workspace.repo_root,
      status_error: workspace.status_error,
      captured_at: localIso(now),
    },
    attempts,
    dead_ends: deadEndsUniq,
    next_action: nextAction,
    open_questions: openQuestions,
    artifacts: {
      docs: [...new Set(docs)],
      evidence: [...new Set(evidence)].slice(0, 20),
      session_transcript: null, // 写盘后回填
    },
    sources: {
      facts: ['agent-office.db: tasks/task_steps/attempts/checkpoints/chat_turns', 'git: branch/HEAD/status'],
      transcript: transcript.ok ? 'catchup' : null,
      transcript_error: transcript.error || null,
      extraction: 'deterministic-v1（attempts 只来自 DB；会话摘录带 [会话] 前缀）',
      transcript_meta: transcript.meta || null,
    },
    thread: thread ? {
      thread_id: thread.thread_id,
      agent_id: thread.agent_id,
      provider_session_id: thread.provider_session_id,
      title: thread.title,
      task_id: thread.task_id,
      workspace: thread.workspace,
      updated_at: thread.updated_at,
    } : null,
    counts: { turns: turns.length, messages: messages.length, attempts: attempts.length, checkpoints: checkpoints.length },
  };

  const outDir = opts.outDir || HANDOFF_DIR;
  const jsonPath = join(outDir, `${handoffId}.json`);
  const mdPath = join(outDir, `${handoffId}.md`);
  const sessionPath = transcript.ok ? join(outDir, `${handoffId}.session.md`) : null;

  if (opts.write !== false) {
    mkdirSync(outDir, { recursive: true });
    if (sessionPath) {
      writeFileSync(sessionPath, `<!-- catchup ${transcript.command} -->\n\n${transcript.text}\n`, 'utf8');
      pkg.artifacts.session_transcript = safeRelative(sessionPath, cwd);
    }
    const md = renderMarkdown(pkg);
    writeFileSync(jsonPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
    writeFileSync(mdPath, md, 'utf8');
  } else if (transcript.ok) {
    pkg.artifacts.session_transcript = `<未写盘> ${handoffId}.session.md`;
  }

  return {
    handoff: pkg,
    markdown: renderMarkdown(pkg),
    json_path: safeRelative(jsonPath, cwd),
    markdown_path: safeRelative(mdPath, cwd),
    session_transcript_path: pkg.artifacts.session_transcript,
    from: pkg.from,
    to: pkg.to,
  };
}

/* ---------------- Markdown（给人读，不是 JSON dump） ---------------- */

export function renderMarkdown(h) {
  const yes = (v) => (v == null || v === '' ? '—' : String(v));
  const list = (arr, empty = '—') => (arr && arr.length ? arr.map((x) => `- ${x}`).join('\n') : `- ${empty}`);
  const ws = h.workspace || {};
  const un = ws.uncommitted_count
    ? `${ws.uncommitted_count} 个未提交（前 ${Math.min(ws.uncommitted.length, 12)} 个）：\n${ws.uncommitted.slice(0, 12).map((s) => `  - \`${s}\``).join('\n')}`
    : '工作区干净（生成时刻）';
  return `# 交接包 ${h.handoff_id}

> 从 **${yes(h.from.agent_id)}** 交给 **${yes(h.to.agent_id)}** · ${h.created_at} · 原因：${yes(h.from.reason)}

**接手先看这一句：** ${h.next_action}

---

## 1. 任务

- 任务 ID：${yes(h.task.task_id)}
- 标题：${yes(h.task.title)}
- 目标：${yes(h.task.goal)}
- 任务书：${yes(h.task.task_doc)}
- 验收：
${list(h.task.acceptance, '任务没有登记验收项')}

## 2. 做到哪了

**已完成：**
${list(h.progress.done)}

**正在进行：** ${h.progress.doing}

**阻塞：** ${h.progress.blocked}

## 3. 代码现场（生成时刻快照）

- 工作目录：\`${yes(ws.cwd)}\`
- 分支：\`${yes(ws.branch)}\`
- HEAD：\`${yes(ws.head_commit)}\`${ws.head_commit_full ? `（完整 ${ws.head_commit_full}）` : ''}
- Worktree：${ws.worktree ? `\`${ws.worktree}\`` : '无（主工作区）'}
- 未提交：${un}
- 状态错误：${yes(ws.status_error)}

## 4. 试过什么（来自 attempts / chat_turns 真记录）

${h.attempts.length ? h.attempts.map((a) => `- **${a.at}** ${a.what} → \`${a.result}\`${a.why ? `：${a.why}` : ''}`).join('\n') : '- 没有执行/失败记录（不编）'}

## 5. 坑 / 死路

${list(h.dead_ends, '没有记录到明确的死路')}

## 6. 下一步

${h.next_action}

## 7. 未决问题

${list(h.open_questions)}

## 8. 产物与证据

- 文档：${(h.artifacts.docs || []).length ? h.artifacts.docs.map((x) => `\`${x}\``).join('、') : '—'}
- 证据：${(h.artifacts.evidence || []).length ? h.artifacts.evidence.map((x) => `\`${x}\``).join('、') : '—'}
- 会话原文：${h.artifacts.session_transcript ? `\`${h.artifacts.session_transcript}\`` : '—（没有 catchup 原文）'}
- 提取方式：${yes(h.sources && h.sources.extraction)}
${h.sources && h.sources.transcript_error ? `- 会话读取错误：${h.sources.transcript_error}` : ''}

---

*这份交接包由 \`scripts/handoff/build.mjs\` 生成：任务/执行/检查点来自 agent-office.db，代码现场来自 git，会话只做带 \`[会话]\` 标记的摘录。*
`;
}

/* ---------------- CLI ---------------- */

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--thread') out.threadId = argv[++i];
    else if (a === '--task') out.taskId = argv[++i];
    else if (a === '--to') out.toAgentId = argv[++i];
    else if (a === '--reason') out.reason = argv[++i];
    else if (a === '--last') out.last = Number(argv[++i]);
    else if (a === '--out') out.outDir = argv[++i];
    else if (a === '--catchup-bin') out.catchupBin = argv[++i];
    else if (a === '--no-catchup') out.catchup = false;
    else if (a === '--json') out.jsonOnly = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.threadId && !args.taskId)) {
    console.log(`用法：
  node scripts/handoff/build.mjs --thread th-xxxx [--to claude] [--last 30]
  node scripts/handoff/build.mjs --task t-xxxx [--to dsh]
  --no-catchup  不读会话原文（只出 DB/git 事实）
  --json        只打印 JSON（仍会落盘）
  --out <dir>   输出目录（默认 docs/handoffs）`);
    process.exit(args.help ? 0 : 2);
  }
  try {
    const r = await buildHandoff(args);
    if (args.jsonOnly) console.log(JSON.stringify(r.handoff, null, 2));
    else {
      console.log(`handoff_id: ${r.handoff.handoff_id}`);
      console.log(`json: ${r.json_path}`);
      console.log(`md:   ${r.markdown_path}`);
      console.log(`session: ${r.session_transcript_path || '—'}`);
      console.log(`\n${r.markdown.split('\n').slice(0, 18).join('\n')}`);
    }
  } finally {
    closeDb(getDb());
  }
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  main().catch((err) => {
    console.error(`[handoff] ${err.code || 'ERROR'}: ${err.message}`);
    process.exit(1);
  });
}
