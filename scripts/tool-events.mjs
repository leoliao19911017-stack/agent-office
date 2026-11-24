#!/usr/bin/env node
// tool-events.mjs — 采集 Claude / DSH 的工具调用到 data/agent-office.db 的 tool_events。
//
// 用法：
//   node scripts/tool-events.mjs                    # 采集当前仓库
//   node scripts/tool-events.mjs --project <dir>    # 指定项目根目录
//   node scripts/tool-events.mjs --json             # 机器可读输出
//   node scripts/tool-events.mjs --stats            # 只读现有表，不采集
//
// 幂等：重复跑不会重复插入；Claude JSONL 只读新增字节，DSH zstd 变了才重读。

import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { getDb } from '../web/lib/db.mjs';
import { collectToolEvents, projectSources, queryToolEvents } from '../web/lib/tool-events.mjs';

function parseArgs(argv) {
  const out = { projectRoot: process.cwd(), json: false, stats: false, home: homedir() };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--project' || a === '--project-root') out.projectRoot = resolve(argv[++i] || process.cwd());
    else if (a === '--home') out.home = resolve(argv[++i] || homedir());
    else if (a === '--json') out.json = true;
    else if (a === '--stats') out.stats = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (!a.startsWith('-')) out.projectRoot = resolve(a);
  }
  return out;
}

function printHuman(result, sources) {
  console.log('工具事件采集');
  console.log(`  项目      ${result.project_root || sources.project_root}`);
  console.log(`  Claude    ${sources.claude_root}`);
  console.log(`  DSH       ${sources.dsh_root}`);
  if (result.collecting) {
    console.log('  状态      还没有采集记录');
    return;
  }
  console.log(`  本次插入  ${result.inserted} 条 · 解析 ${result.parsed} 条 · 共 ${result.total} 条`);
  console.log(`  Claude    ${result.claude.files} 个文件（跳过 ${result.claude.skipped} 个未变化）`);
  console.log(`  DSH       ${result.dsh.files} 个会话（跳过 ${result.dsh.skipped} 个未变化）`);
  if (result.errors && result.errors.length) {
    console.log(`  错误      ${result.errors.length} 个`);
    for (const e of result.errors.slice(0, 8)) console.log(`            - ${e}`);
  }
  console.log(`  数据库    ${result.db_path || ''}`);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('用法：node scripts/tool-events.mjs [--project <dir>] [--home <dir>] [--json] [--stats]');
  process.exit(0);
}

const sources = projectSources(args.projectRoot, args.home);
try {
  if (args.stats) {
    const db = getDb();
    const view = queryToolEvents(db, { recentLimit: 20 });
    if (args.json) console.log(JSON.stringify(view, null, 2));
    else {
      console.log('工具事件（只读）');
      console.log(`  最后采集  ${view.last_run_at || '—'}`);
      console.log(`  总条数    ${view.total_all}`);
      console.log(`  collecting ${view.collecting}`);
      for (const a of view.by_agent) console.log(`  ${a.agent_id.padEnd(10)} ${a.count} 条 · 最近 ${a.last_ts}`);
    }
  } else {
    const result = collectToolEvents({ projectRoot: args.projectRoot, home: args.home });
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else printHuman(result, sources);
  }
} catch (err) {
  console.error(`采集失败：${err && err.message ? err.message : err}`);
  process.exit(1);
}
