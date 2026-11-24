// fake-dsh.mjs — 测试夹具：假 DSH headless CLI（给 test/chat-http.test.js 用，不联网、不花额度）。
// 事件形状照着真 dsh 0.2.2-rc.5 的 --json NDJSON 抄；续聊参数也与真的一致：
//   只认 --session-id <id>（未知 ID → {"type":"error","message":"session \"…\" does not exist; …"}，exit 1）
//   --resume → 「unknown option '--resume'」，exit 1（真 dsh 就是这样，Claude Code 才用 --resume）
// 会话记忆落在 FAKE_CLI_HOME/dsh-sessions/<id>.json。机器标记与 fake-claude 相同：[slow] [hang] [429] [quota] [crash]。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const DELAY = Number(process.env.FAKE_CLI_DELAY_MS) || 60;
const HOME = process.env.FAKE_CLI_HOME;
if (!HOME) { console.error('fake-dsh: 需要 FAKE_CLI_HOME'); process.exit(2); }
const DIR = join(HOME, 'dsh-sessions');
mkdirSync(DIR, { recursive: true });

const args = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

function flag(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => main(input).catch((err) => { console.error(err && err.stack ? err.stack : err); process.exit(1); }));
if (process.stdin.isTTY) main('').catch((err) => { console.error(err); process.exit(1); });

async function main(prompt) {
  if (args.includes('--resume')) {
    process.stderr.write(`unknown option '--resume'\n`);
    process.exit(1);
  }
  const given = flag('--session-id');
  let sid = given;
  let history = null;
  if (given) {
    try { history = JSON.parse(readFileSync(join(DIR, `${given}.json`), 'utf8')); } catch { history = null; }
    if (!history) {
      out({ type: 'error', message: `session "${given}" does not exist; omit --session-id to start a new Session` });
      process.exit(1);
    }
  } else {
    sid = `session-${randomUUID()}`;
    history = { messages: [] };
  }
  out({ type: 'session', sessionId: sid, cwd: process.cwd() });
  out({ type: 'status', phase: 'turn_start', turn: history.messages.length + 1 });
  out({ type: 'status', phase: 'step_start', turn: history.messages.length + 1, step: 1 });

  if (/\[crash\]/.test(prompt)) process.exit(0xC0000142);
  if (/\[noresult\]/.test(prompt)) process.exit(0);   // 正常退出码但没有任何 final / text：引擎只能判「结果未知」

  if (/\[429\]|\[quota\]/.test(prompt)) {
    const quota = /\[quota\]/.test(prompt);
    const detail = quota ? '已达到 5 小时的使用上限。限额将在 2099-01-01 09:30 重置' : 'rate limit exceeded (429)';
    const reason = { kind: 'error', error: { code: quota ? 'USAGE_LIMIT_REACHED' : 'RATE_LIMITED', status: 429, message: detail }, message: detail };
    out({ type: 'status', phase: 'turn_end', turn: history.messages.length + 1, reason });
    out({ type: 'final', sessionId: sid, reason });
    process.exitCode = 1;
    return;
  }
  if (/\[hang\]/.test(prompt)) { for (;;) await sleep(1000); }

  const first = history.messages[0] || null;
  const reply = /第一句|first message/i.test(prompt)
    ? `你第一句的原文是：${first || '（这个会话还没有第一句）'}`
    : `假 DSH 收到：${prompt}｜本会话此前有 ${history.messages.length} 句`;
  history.messages.push(prompt);
  writeFileSync(join(DIR, `${sid}.json`), JSON.stringify(history));

  const pieces = /\[slow\]/.test(prompt) ? Array.from({ length: 12 }, (_, i) => `段${i + 1}·`) : [reply];
  for (const piece of pieces) {
    await sleep(DELAY);
    out({ type: 'text', text: piece });
  }
  const full = pieces.join('');
  out({ type: 'status', phase: 'step_end', turn: history.messages.length, step: 1, usage: { inputTokens: 10, outputTokens: full.length } });
  out({ type: 'status', phase: 'turn_end', turn: history.messages.length, reason: { kind: 'completed' } });
  out({ type: 'final', sessionId: sid, reason: { kind: 'completed' }, text: full });
}
