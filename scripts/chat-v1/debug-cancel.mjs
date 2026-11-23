// debug-cancel.mjs — 排查「取消为什么没杀掉进程」：逐行打时间线 + 直接试 taskkill。
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cleanChildEnv } from '../../web/chat/proc.mjs';

const t0 = Date.now();
const at = () => `+${Date.now() - t0}ms`;
const sid = randomUUID();
const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--session-id', sid,
  '--permission-mode', 'plan', '--tools', 'Read,Grep,Glob', '--max-turns', '2'];
const child = spawn('claude', args, { cwd: process.argv[2], env: cleanChildEnv(process.env), stdio: ['pipe', 'pipe', 'pipe'] });
console.log(at(), 'spawned pid', child.pid);
let deltas = 0;
child.stdout.setEncoding('utf8');
child.stdout.on('data', (d) => { for (const l of d.split('\n')) { if (!l.trim()) continue; let o; try { o = JSON.parse(l); } catch { continue; } if (o.type === 'stream_event') deltas++; else console.log(at(), 'event', o.type, o.subtype || o.event?.type || ''); } });
child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => console.log(at(), 'stderr', JSON.stringify(d.slice(0, 200))));
child.stdin.on('error', (e) => console.log(at(), 'stdin err', e.code));
child.stdin.end('请写一篇 2000 字的长文，慢慢写。');

setTimeout(() => {
  console.log(at(), '→ taskkill now; deltas so far =', deltas);
  const r = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8', timeout: 8000 });
  console.log(at(), 'taskkill status', r.status, 'error', r.error ? r.error.message : null, 'stdout', JSON.stringify((r.stdout || '').trim().slice(0, 200)), 'stderr', JSON.stringify((r.stderr || '').trim().slice(0, 200)));
}, 2500);
child.on('close', (code, sig) => { console.log(at(), 'close code', code, 'sig', sig, 'deltas', deltas); });
