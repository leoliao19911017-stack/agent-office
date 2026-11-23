// migrate-legacy.mjs — 把 office-data/tasks/*.json 复制进 SQLite（幂等，可重跑）。
//
// 红线（任务书 §9.5）：这是「复制进库」，不是「搬家」。旧 JSON 一个都不删、不改。
//
// 幂等实现：migrate_ledger 记录 source_path + sha256。
//   同一文件同一内容 → 第二次直接 skip，tasks 条数不变；
//   文件内容变了 → upsert 任务/步骤，并补一条新的迁移事件。
//
// 状态映射：旧的 pending/done/awaiting 不能证明验收，所以迁移后一律 waiting
// （已完成步骤也是「待验收」），绝不迁成 completed，更不会迁成 idle。
//
// 用法：
//   node scripts/migrate-legacy.mjs
//   node scripts/migrate-legacy.mjs --dry-run
//   node scripts/migrate-legacy.mjs --db data/selftest/x.db --source C:/tmp/legacy-tasks
// 环境变量：AGENT_AUTOLOOP_HOME / LEGACY_TASKS_DIR / AGENT_OFFICE_DB

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, resolveDbPath } from '../web/lib/db.mjs';
import { countTasks, getTask, normalizeTaskId, replaceSteps, upsertMigratedTask } from '../web/lib/tasks.mjs';
import { appendEvent, EVIDENCE } from '../web/lib/events.mjs';

const STEP_STATUS = new Set(['pending', 'running', 'done', 'awaiting', 'failed', 'skipped']);

function parseArgs(argv) {
  const out = { source: null, db: null, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--source') out.source = argv[++i];
    else if (a.startsWith('--source=')) out.source = a.slice('--source='.length);
    else if (a === '--db') out.db = argv[++i];
    else if (a.startsWith('--db=')) out.db = a.slice('--db='.length);
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function defaultSource() {
  const home = process.env.AGENT_AUTOLOOP_HOME || 'C:/Tools/agent-autoloop';
  return process.env.LEGACY_TASKS_DIR || join(home, 'office-data', 'tasks');
}

function isoOr(value, fallback) {
  if (value) {
    const t = Date.parse(value);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  return fallback;
}

/** 旧 steps 对象 → 数组；保留顺序与文件清单。 */
function stepsOf(record) {
  const raw = record && record.steps && typeof record.steps === 'object' ? record.steps : {};
  return Object.entries(raw).map(([key, step]) => {
    const s = step && typeof step === 'object' ? step : {};
    return {
      key,
      name: key,
      status: STEP_STATUS.has(s.status) ? s.status : 'pending',
      at: s.at || null,
      note: s.note == null ? '' : String(s.note),
      files: Array.isArray(s.files) ? s.files : [],
    };
  });
}

function artifactFiles(steps) {
  const out = [];
  for (const s of steps) {
    for (const f of s.files || []) {
      const p = typeof f === 'string' ? f : (f && (f.path || f.file));
      if (p) out.push({ path: String(p), bytes: f.bytes ?? null, sha256: f.sha256 ?? null, kind: f.kind ?? null });
    }
  }
  return out;
}

/** 迁移后的状态：一律 waiting，理由写清楚为什么不是 completed。 */
function legacyStatus(steps) {
  if (!steps.length) return { status: 'waiting', reason: '历史任务迁移：没有步骤记录，等待人工确认' };
  const done = steps.filter((s) => s.status === 'done').length;
  const awaiting = steps.filter((s) => s.status === 'awaiting').length;
  if (done === steps.length) {
    return { status: 'waiting', reason: '历史任务迁移：步骤已完成，尚无验收记录（不算完成）' };
  }
  if (awaiting > 0) {
    return { status: 'waiting', reason: '历史任务迁移：等待人工确认' };
  }
  if (done > 0) {
    return { status: 'waiting', reason: '历史任务迁移：部分步骤完成，无执行实例，等待继续' };
  }
  return { status: 'waiting', reason: '历史任务迁移：尚未开始，等待派活' };
}

export function migrateLegacyTasks(opts = {}) {
  const source = resolve(opts.source || defaultSource());
  const dbPath = resolveDbPath(opts.db);
  const db = opts.dbHandle || openDb({ path: dbPath });
  const before = countTasks(db);

  const summary = {
    db: dbPath,
    source,
    source_exists: existsSync(source),
    files: 0,
    imported: 0,
    updated: 0,
    skipped: 0,
    errors: [],
    before,
    after: before,
    dry_run: Boolean(opts.dryRun),
  };

  if (!summary.source_exists) {
    summary.errors.push({ file: null, error: `源目录不存在：${source}` });
    summary.after = countTasks(db);
    return summary;
  }

  const names = readdirSync(source)
    .filter((n) => n.endsWith('.json'))
    .sort((a, b) => a.localeCompare(b));
  summary.files = names.length;

  for (const name of names) {
    const file = join(source, name);
    try {
      const raw = readFileSync(file);
      const sha256 = createHash('sha256').update(raw).digest('hex');
      const record = JSON.parse(raw.toString('utf8'));
      const stem = basename(name, '.json');
      const rawId = String(record.id || record.task_id || stem);
      const taskId = normalizeTaskId(rawId);
      const st = statSync(file);
      const createdFallback = new Date(st.mtimeMs).toISOString();
      const createdAt = isoOr(record.createdAt || record.created_at, createdFallback);
      const updatedAt = isoOr(record.updatedAt || record.updated_at, createdAt);
      const steps = stepsOf(record);
      const status = legacyStatus(steps);

      const ledger = db.prepare('SELECT * FROM migrate_ledger WHERE source_path = ?').get(file);
      if (ledger && ledger.sha256 === sha256) {
        summary.skipped += 1;
        continue;
      }

      if (!opts.dryRun) {
        const up = upsertMigratedTask(db, {
          taskId,
          title: String(record.title || record.name || stem),
          acceptance: record.acceptance ?? record.acceptance_criteria ?? null,
          status: status.status,
          statusReason: status.reason,
          createdAt,
          updatedAt,
          source,
        });
        replaceSteps(db, taskId, steps, { at: updatedAt });

        appendEvent(db, {
          taskId,
          eventType: 'legacy_imported',
          payload: {
            source_file: file,
            sha256,
            source_id: rawId,
            steps: steps.map((s) => ({ key: s.key, status: s.status })),
          },
          evidenceSource: EVIDENCE.SYSTEM,
          observedAt: updatedAt,
        });

        const files = artifactFiles(steps);
        if (files.length) {
          appendEvent(db, {
            taskId,
            eventType: 'artifact_produced',
            payload: { files, source: 'legacy_import' },
            evidenceSource: EVIDENCE.GIT,
            observedAt: updatedAt,
          });
        }

        db.prepare(
          'INSERT INTO migrate_ledger (source_path, sha256, task_id, migrated_at) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT(source_path) DO UPDATE SET sha256 = excluded.sha256, ' +
          'task_id = excluded.task_id, migrated_at = excluded.migrated_at',
        ).run(file, sha256, taskId, new Date().toISOString());

        if (up.inserted) summary.imported += 1;
        else summary.updated += 1;
      } else {
        const exists = getTask(db, taskId);
        if (exists) summary.updated += 1;
        else summary.imported += 1;
      }
    } catch (err) {
      summary.errors.push({ file, error: String(err && err.message ? err.message : err) });
    }
  }

  summary.after = countTasks(db);
  return summary;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法: node scripts/migrate-legacy.mjs [--source DIR] [--db FILE] [--dry-run]');
    return;
  }
  const summary = migrateLegacyTasks({ source: args.source, db: args.db, dryRun: args.dryRun });
  // 单行 JSON，便于脚本/自测解析；同时保留可读的键名。
  console.log(JSON.stringify(summary));
  if (summary.errors.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
