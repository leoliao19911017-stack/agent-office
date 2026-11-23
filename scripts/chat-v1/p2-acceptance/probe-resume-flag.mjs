// probe-resume-flag.mjs — P2 开工探针：dsh headless 续聊到底认哪个参数（--resume 还是 --session-id）。
// 老板给的口径是 --resume；dsh 自带 help（0.2.2-rc.5）只列了 --session-id。两个都真跑一次，以实际输出为准。
// 用法：node scripts/chat-v1/p2-acceptance/probe-resume-flag.mjs [resume|session-id]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDshTurn, defaultDshBin } from '../../../web/chat/adapters/dsh-chat.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, 'out');
mkdirSync(OUT, { recursive: true });
const FLAG = process.argv[2] || 'resume';
const CODE = '青禾-5173';
const REPO = resolve(HERE, '..', '..', '..');
const rows = [];

async function step(name, opts) {
  const evs = [];
  const t0 = Date.now();
  const out = await runDshTurn({ cwd: REPO, onEvent: (e) => evs.push(e), ...opts });
  const row = { name, flag: FLAG, ms: Date.now() - t0, kind: out.kind, reason: out.reason || null, sessionId: out.sessionId, exitCode: out.exitCode, text: out.text, message: out.message || null, command: (evs.find((e) => e.type === 'proc') || {}).command || null, eventTypes: evs.map((e) => e.type) };
  rows.push(row);
  console.log(`\n[${name}] flag=--${FLAG}`);
  console.log('  command :', row.command);
  console.log('  kind    :', row.kind, row.reason || '', `exit=${row.exitCode}`, `${row.ms}ms`);
  console.log('  session :', row.sessionId);
  console.log('  text    :', JSON.stringify(row.text));
  if (row.message) console.log('  message :', row.message);
  console.log('  events  :', row.eventTypes.join(' '));
  return out;
}

const a = await step('1-new', { prompt: `这次对话里我先设一个口令：${CODE}。它只是对话内的临时口令，不要写进任何文件。现在只回复两个字：收到。`, resumeId: null, resumeFlag: FLAG });
if (a.kind === 'completed' && a.sessionId) {
  await step('2-resume', { prompt: '口令是什么？只回复口令本身。', resumeId: a.sessionId, resumeFlag: FLAG });
}
writeFileSync(resolve(OUT, `resume-flag-${FLAG}.json`), JSON.stringify({ bin: defaultDshBin(), at: new Date().toISOString(), rows }, null, 2));
