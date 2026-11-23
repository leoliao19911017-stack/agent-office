// probe-claude-429.mjs — 让真 Claude CLI 打本地假上游（fake-anthropic.mjs），记录它在 429 下的
// 真实行为：自己重试几次/多久、stream-json 里错误长什么样、退出码。
// 用法：node scripts/chat-v1/probe-claude-429.mjs [mode=429|quota]
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const OUT = resolve(HERE, 'out');
mkdirSync(OUT, { recursive: true });

const MODE = process.argv[2] || '429';
const PORT = 18790;
const CAP_MS = Number(process.argv[3]) || 150000;

function cleanEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k === 'CLAUDE_EFFORT') continue;
    out[k] = v;
  }
  return out;
}

const fake = spawn(process.execPath, [resolve(HERE, 'fake-anthropic.mjs'), String(PORT), MODE], { stdio: ['ignore', 'pipe', 'pipe'] });
const fakeOut = [];
fake.stdout.setEncoding('utf8');
fake.stdout.on('data', (d) => { for (const l of d.split('\n')) if (l.trim()) fakeOut.push(l.trim()); });
fake.stderr.setEncoding('utf8');
fake.stderr.on('data', (d) => console.log('[fake stderr]', d));
await new Promise((r) => setTimeout(r, 600));

const sid = randomUUID();
const t0 = Date.now();
const args = [
  '-p',
  '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
  '--session-id', sid,
  '--permission-mode', 'plan', '--tools', 'Read,Grep,Glob',
  '--settings', JSON.stringify({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${PORT}` } }),
  '--max-turns', '1',
];
const child = spawn('claude', args, { cwd: REPO, env: cleanEnv(process.env), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const timer = setTimeout(() => { console.log(`CAP ${CAP_MS}ms → kill ${child.pid}`); spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); }, CAP_MS);
let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (d) => { stdout += d; });
child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => { stderr += d; });
child.stdin.end('只回复两个字：收到');
child.on('close', (code, signal) => {
  clearTimeout(timer);
  const ms = Date.now() - t0;
  console.log(`\n===== mode=${MODE} =====`);
  console.log(`exit code=${code} signal=${signal} elapsed=${ms}ms session=${sid}`);
  console.log('stderr:', JSON.stringify(stderr.slice(-800)));
  writeFileSync(resolve(OUT, `claude-429-${MODE}.stdout.jsonl`), stdout);
  writeFileSync(resolve(OUT, `claude-429-${MODE}.fake.log`), fakeOut.join('\n'));
  const types = {};
  const lines = stdout.split('\n').filter((l) => l.trim());
  for (const l of lines) {
    let o; try { o = JSON.parse(l); } catch { console.log('non-json:', l.slice(0, 200)); continue; }
    const k = o.type + (o.subtype ? `/${o.subtype}` : '') + (o.event ? `→${o.event.type}` : '');
    types[k] = (types[k] || 0) + 1;
    if (o.type === 'result' || o.type === 'system' && !/hook_|thinking_tokens|init/.test(o.subtype) || (o.type === 'assistant' && o.message?.model === '<synthetic>')) {
      console.log('EVENT:', JSON.stringify(o).slice(0, 900));
    }
  }
  console.log('event types:', JSON.stringify(types));
  console.log(`fake upstream requests: ${fakeOut.length - 1}`);
  for (const l of fakeOut.slice(0, 4)) console.log('  ', l);
  if (fakeOut.length > 5) { console.log('   ...'); for (const l of fakeOut.slice(-3)) console.log('  ', l); }
  fake.kill();
  process.exit(0);
});
