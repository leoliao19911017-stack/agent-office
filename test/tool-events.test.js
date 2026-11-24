// tool-events.test.js — 转盘第二批：工具级采集器与只读聚合。
// 真文件（临时目录）+ 真 zstd 压缩，不用假的数据库行；验证幂等与「没采集不冒充 0」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { openDb, closeDb } from '../web/lib/db.mjs';
import {
  collectToolEvents, queryToolEvents, claudeProjectSlug, dshProjectSlug, extractTarget,
} from '../web/lib/tool-events.mjs';

function claudeLine({ sessionId, ts, content }) {
  return JSON.stringify({ type: 'assistant', sessionId, timestamp: ts, message: { role: 'assistant', content } });
}

test('项目路径 → Claude / DSH 目录名与实测一致', () => {
  const root = 'E:\\DesktopProjects\\Soda Intelligence - AI Native Thinking\\Soda Office';
  assert.equal(claudeProjectSlug(root), 'E--DesktopProjects-Soda-Intelligence---AI-Native-Thinking-Soda-Office');
  assert.equal(dshProjectSlug(root), '--E-DesktopProjects-Soda~0020Intelligence~0020-~0020AI~0020Native~0020Thinking-Soda~0020Office--');
});

test('extractTarget 取可读的一行，不把多行命令塞进列表', () => {
  assert.equal(extractTarget('Bash', { command: 'pwd\ngit status' }), 'pwd');
  assert.equal(extractTarget('Edit', { file_path: 'web/a.mjs' }), 'web/a.mjs');
  assert.equal(extractTarget('Grep', { pattern: 'tool_events' }), 'tool_events');
});

test('没采集时 API 口径是 collecting=true，不是 0', () => {
  const db = openDb({ memory: true });
  try {
    const view = queryToolEvents(db);
    assert.equal(view.collecting, true);
    assert.equal(view.collected, false);
    assert.equal(view.total_all, 0);
    assert.equal(view.last_run_at, null);
  } finally { closeDb(db); }
});

test('Claude JSONL + DSH zstd 真解析、真聚合、重复跑幂等', () => {
  const root = mkdtempSync(join(tmpdir(), 'soda-tools-'));
  const home = join(root, 'home');
  const project = join(root, 'Soda Office');
  mkdirSync(project, { recursive: true });
  const claudeDir = join(home, '.claude', 'projects', claudeProjectSlug(project));
  const dshDir = join(home, '.dsh', 'sessions', dshProjectSlug(project), 'session-test-1');
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(dshDir, { recursive: true });

  const claudeFile = join(claudeDir, 's1.jsonl');
  const lines = [
    claudeLine({
      sessionId: 'cs-1', ts: '2026-11-24T01:00:00.000Z',
      content: [{ type: 'text', text: '干活' }, { type: 'tool_use', id: 'tu-1', name: 'Edit', input: { file_path: 'web/a.mjs' } }],
    }),
    claudeLine({
      sessionId: 'cs-1', ts: '2026-11-24T01:01:00.000Z',
      content: [
        { type: 'tool_use', id: 'tu-2', name: 'Read', input: { file_path: 'web/b.mjs' } },
        { type: 'tool_use', id: 'tu-3', name: 'Bash', input: { command: 'git status\npwd' } },
      ],
    }),
  ];
  writeFileSync(claudeFile, `${lines.join('\n')}\n`, 'utf8');

  const dshFile = join(dshDir, 'session.v4.jsonl.zstd');
  const dshLines = [
    JSON.stringify({ type: 'session', version: 4, id: 'session-test-1', cwd: project }),
    JSON.stringify({ type: 'tool/call', seq: 1, time: 1795481951371, data: { callId: 'call-1', name: 'bash', arguments: JSON.stringify({ command: 'node -v' }) } }),
    JSON.stringify({ type: 'tool/result', seq: 2, time: 1795481952228, data: { callId: 'call-1' } }),
  ];
  writeFileSync(dshFile, zstdCompressSync(Buffer.from(`${dshLines.join('\n')}\n`, 'utf8')));

  const db = openDb({ memory: true });
  try {
    const first = collectToolEvents({ db, projectRoot: project, home });
    assert.equal(first.ok, true);
    assert.equal(first.inserted, 4, 'Edit/Read/Bash 三条 Claude + 一条 DSH');
    assert.equal(first.total, 4);

    const second = collectToolEvents({ db, projectRoot: project, home });
    assert.equal(second.inserted, 0, '重复采集不重复插入');
    assert.equal(second.total, 4);

    const view = queryToolEvents(db);
    assert.equal(view.collecting, false);
    assert.equal(view.collected, true);
    assert.equal(view.total_all, 4);
    assert.deepEqual(
      view.by_agent.map((a) => [a.agent_id, a.count]).sort(),
      [['claude', 3], ['dsh', 1]],
    );
    const bash = view.tools.find((t) => t.tool_name.toLowerCase() === 'bash');
    assert.equal(bash.count, 2, 'Claude 的 Bash 与 DSH 的 bash 合并展示');
    assert.equal(bash.agents.claude, 1);
    assert.equal(bash.agents.dsh, 1);
    assert.ok(bash.recent.some((r) => r.target === 'git status'), 'Claude 的 sample 在');
    assert.ok(bash.recent.some((r) => r.target === 'node -v'), 'DSH 的 sample 在');

    const claudeOnly = queryToolEvents(db, { agentId: 'claude' });
    assert.equal(claudeOnly.total, 3);
    assert.equal(claudeOnly.tools.find((t) => t.tool_name === 'Edit').count, 1);
    assert.ok(!claudeOnly.recent.some((r) => r.agent_id === 'dsh'));
    assert.ok(!('raw_json' in (claudeOnly.recent[0] || {})), '接口聚合不带 raw_json');
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});
