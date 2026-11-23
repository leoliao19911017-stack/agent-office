// probe-adapters.mjs — 直接真调两个聊天适配器，验证续聊 / 未知 ID / 起不来 / 取消 / 讨论模式拒写。
// 用法：node --no-warnings scripts/chat-v1/probe-adapters.mjs
import { mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runClaudeTurn } from '../../web/chat/adapters/claude-chat.mjs';
import { runDshTurn } from '../../web/chat/adapters/dsh-chat.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const results = [];
const record = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); };
const has = (text, needle) => String(text || '').includes(needle);

async function timed(fn) { const t0 = Date.now(); const out = await fn(); return { out, ms: Date.now() - t0 }; }

/* ---------------- claude ---------------- */
const CODE = '青竹-7391';
{
  const evs = [];
  const { out: a, ms } = await timed(() => runClaudeTurn({
    prompt: `请记住这个暗号：${CODE}。只回复两个字：收到。`, resumeId: null, cwd: REPO, onEvent: (e) => evs.push(e),
  }));
  record('claude 首轮 --session-id', a.kind === 'completed' && typeof a.sessionId === 'string', `kind=${a.kind} sid=${a.sessionId} text=${JSON.stringify(a.text)} ${ms}ms events=${evs.length} firstSessionAt=${evs.findIndex((e) => e.type === 'session')}`);
  const sid = a.sessionId;

  const b = await runClaudeTurn({ prompt: '暗号是什么？只回复暗号本身。', resumeId: sid, cwd: REPO, onEvent: () => {} });
  record('claude 续聊 --resume 想起暗号', b.kind === 'completed' && has(b.text, CODE), `kind=${b.kind} text=${JSON.stringify(b.text)}`);

  const deltas = [];
  const c = await timed(() => runClaudeTurn({ prompt: '用一句话说明这个仓库 web/server.js 是做什么的（可以用 Read 工具看文件）。', resumeId: sid, cwd: REPO, onEvent: (e) => { if (e.type === 'delta') deltas.push(e); else if (e.type === 'tool') deltas.push(e); } }));
  record('claude 增量事件逐个到达', deltas.filter((e) => e.type === 'delta').length >= 3, `kind=${c.out.kind} delta事件=${deltas.filter((e) => e.type === 'delta').length} tool事件=${deltas.filter((e) => e.type === 'tool').length} 首个delta=${JSON.stringify(deltas.find((e) => e.type === 'delta'))} ${ms}ms`);

  const d = await runClaudeTurn({ prompt: '只回复：在', resumeId: '00000000-0000-4000-8000-000000000000', cwd: REPO, onEvent: () => {} });
  record('claude --resume 不存在的 ID → session_not_found', d.kind === 'session_not_found', `kind=${d.kind} exit=${d.exitCode} msg=${JSON.stringify(d.message)}`);

  const e = await runClaudeTurn({ prompt: '只回复：在', resumeId: null, cwd: REPO, bin: 'definitely-not-a-claude-binary-xyz', onEvent: () => {} });
  record('claude 命令不存在 → cli_start_failed', e.kind === 'cli_start_failed', `kind=${e.kind} msg=${JSON.stringify(e.message)}`);

  const ac = new AbortController();
  let sawSession = false;
  const f = await runClaudeTurn({
    prompt: '请写一篇 2000 字的长文。', resumeId: sid, cwd: REPO, signal: ac.signal,
    onEvent: (ev) => { if (ev.type === 'session' && !sawSession) { sawSession = true; setTimeout(() => ac.abort({ kind: 'cancelled' }), 400); } },
  });
  record('claude 取消 → cancelled', f.kind === 'cancelled', `kind=${f.kind} msg=${JSON.stringify(f.message)} textLen=${f.text.length}`);

  const scratch = mkdtempSync(join(tmpdir(), 'soda-chat-probe-claude-'));
  const g = await runClaudeTurn({ prompt: '请在当前工作目录创建文件 claude-write-probe.txt，内容为 hello。然后用一句话告诉我成功还是失败。', resumeId: null, cwd: scratch, onEvent: () => {} });
  record('claude 讨论模式拒写', g.kind === 'completed' && !existsSync(join(scratch, 'claude-write-probe.txt')), `kind=${g.kind} fileCreated=${existsSync(join(scratch, 'claude-write-probe.txt'))} dir=${JSON.stringify(readdirSync(scratch))} text=${JSON.stringify(g.text.slice(0, 160))}`);
}

/* ---------------- dsh ---------------- */
{
  const CODE2 = '紫檀-4826';
  const evs = [];
  const a = await runDshTurn({ prompt: `请记住这个暗号：${CODE2}。只回复两个字：收到。`, resumeId: null, cwd: REPO, onEvent: (e) => evs.push(e) });
  record('dsh 首轮拿到真实 session-id', a.kind === 'completed' && /^session-[0-9a-f-]+$/.test(a.sessionId || ''), `kind=${a.kind} sid=${a.sessionId} text=${JSON.stringify(a.text)} events=${JSON.stringify(evs.map((e) => e.type))}`);
  const sid = a.sessionId;

  const b = await runDshTurn({ prompt: '暗号是什么？只回复暗号本身。', resumeId: sid, cwd: REPO, onEvent: () => {} });
  record('dsh --session-id 续跑想起暗号', b.kind === 'completed' && has(b.text, CODE2), `kind=${b.kind} text=${JSON.stringify(b.text)}`);

  const d = await runDshTurn({ prompt: '只回复：在', resumeId: 'session-00000000-0000-4000-8000-000000000000', cwd: REPO, onEvent: () => {} });
  record('dsh 未知 session-id → session_not_found', d.kind === 'session_not_found', `kind=${d.kind} exit=${d.exitCode} msg=${JSON.stringify(d.message)}`);

  const e = await runDshTurn({ prompt: '只回复：在', resumeId: null, cwd: REPO, bin: 'definitely-not-a-dsh-binary-xyz.cmd', onEvent: () => {} });
  record('dsh 命令不存在 → cli_start_failed', e.kind === 'cli_start_failed', `kind=${e.kind} msg=${JSON.stringify(e.message)}`);

  const ac = new AbortController();
  let saw = false;
  const f = await runDshTurn({
    prompt: '请写一篇 2000 字的长文。', resumeId: sid, cwd: REPO, signal: ac.signal,
    onEvent: (ev) => { if (ev.type === 'session' && !saw) { saw = true; setTimeout(() => ac.abort({ kind: 'cancelled' }), 300); } },
  });
  record('dsh 取消 → cancelled', f.kind === 'cancelled', `kind=${f.kind} msg=${JSON.stringify(f.message)} textLen=${f.text.length}`);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
