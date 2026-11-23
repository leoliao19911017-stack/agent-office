// probe-resume-sessionid.mjs — 对照：同一个 session 用 --session-id 续（dsh help 写明的方式）。
// 用法：node scripts/chat-v1/p2-acceptance/probe-resume-sessionid.mjs <session-id> [resumeFlag]
import { runDshTurn } from '../../../web/chat/adapters/dsh-chat.mjs';

const [sid, flag = 'session-id'] = process.argv.slice(2);
if (!sid) { console.error('need session id'); process.exit(2); }
const evs = [];
const t0 = Date.now();
const out = await runDshTurn({ cwd: process.cwd(), resumeId: sid, resumeFlag: flag, onEvent: (e) => evs.push(e), prompt: '口令是什么？只回复口令本身。' });
console.log(`flag=--${flag}`);
console.log('command :', (evs.find((e) => e.type === 'proc') || {}).command);
console.log('kind    :', out.kind, out.reason || '', `exit=${out.exitCode}`, `${Date.now() - t0}ms`);
console.log('session :', out.sessionId);
console.log('text    :', JSON.stringify(out.text));
if (out.message) console.log('message :', out.message);
console.log('events  :', evs.map((e) => e.type).join(' '));
