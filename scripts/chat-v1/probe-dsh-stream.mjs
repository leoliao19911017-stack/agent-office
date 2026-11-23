// probe-dsh-stream.mjs — dsh 长回答的流式形状：text 事件是增量还是整段？status 有哪些 phase？
// 用法：node scripts/chat-v1/probe-dsh-stream.mjs [resume-session-id]
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const OUT = resolve(HERE, 'out');
mkdirSync(OUT, { recursive: true });
const DSH = 'C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd';
function readKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const raw = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8');
    const m = raw.match(/DEEPSEEK_API_KEY:\s*(\S+)/);
    if (m) return m[1].replace(/^["']|["']$/g, '');
  } catch { /* none */ }
  return null;
}
const KEY = readKey();
const resume = process.argv[2];
const args = ['--profile', 'headless', '--json', '--permission-mode', 'read-only', '--approval-policy', 'never'];
if (resume) args.push('--session-id', resume);
args.push('-');
const t0 = Date.now();
const child = spawn(`"${DSH}" ${args.join(' ')}`, [], {
  cwd: REPO, env: { ...process.env, DEEPSEEK_API_KEY: KEY }, windowsHide: true, shell: true, stdio: ['pipe', 'pipe', 'pipe'],
});
let buf = '';
const rows = [];
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  const at = Date.now() - t0;
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { rows.push({ at, raw: line.slice(0, 100) }); continue; }
    rows.push({ at, type: o.type, phase: o.phase, turn: o.turn, text: o.text, len: typeof o.text === 'string' ? o.text.length : null });
  }
});
let err = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => { err += d; });
child.on('close', (code) => {
  console.log('exit', code, 'elapsed', Date.now() - t0, 'ms');
  console.log('stderr:', JSON.stringify((KEY ? err.split(KEY).join('<redacted>') : err).slice(-300)));
  for (const r of rows) console.log(JSON.stringify(r));
  writeFileSync(resolve(OUT, 'dsh-stream.rows.json'), JSON.stringify(rows, null, 1));
});
child.stdin.end('请用 6 行列表介绍一下这个仓库 web/ 目录是做什么的（每行一句话，不要用工具，凭常识编即可）。');
