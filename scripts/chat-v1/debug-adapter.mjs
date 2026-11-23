// debug-adapter.mjs — 临时排查用：跑一轮适配器并打印完整结局与事件类型统计。
// 用法：node --no-warnings scripts/chat-v1/debug-adapter.mjs claude|dsh "prompt" [resumeId]
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const which = process.argv[2] || 'claude';
const prompt = process.argv[3] || '只回复两个字：收到';
const resumeId = process.argv[4] || null;
const mod = await import(`../../web/chat/adapters/${which}-chat.mjs`);
const run = which === 'claude' ? mod.runClaudeTurn : mod.runDshTurn;

const scratch = process.env.SCRATCH ? mkdtempSync(join(tmpdir(), 'soda-dbg-')) : null;
const evs = [];
const t0 = Date.now();
const out = await run({ prompt, resumeId, cwd: scratch || REPO, onEvent: (e) => evs.push(e) });
console.log('elapsed', Date.now() - t0, 'ms');
console.log('OUT =', JSON.stringify(out).slice(0, 1200));
console.log('EVENT TYPES =', JSON.stringify(evs.reduce((a, e) => (a[e.type] = (a[e.type] || 0) + 1, a), {})));
console.log('non-delta events =', JSON.stringify(evs.filter((e) => e.type !== 'delta' && e.type !== 'liveness')).slice(0, 1500));
if (scratch) console.log('dir =', scratch, JSON.stringify(readdirSync(scratch)));
