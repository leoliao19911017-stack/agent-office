// probe-dsh.mjs — 开工前的 dsh CLI 真实调用探针：摸清 --json 事件形状、
// 首次返回的真实 session-id、--session-id 续跑、未知 ID 的报错形状、read-only 下能不能写文件。
// 用法：node scripts/chat-v1/probe-dsh.mjs
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const OUT = resolve(HERE, 'out');
mkdirSync(OUT, { recursive: true });

const DSH = 'C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd';

/** 与 C:/Tools/agent-autoloop/dsh-agent.js 同一口径：优先环境变量，否则读 DSH 自己的凭证文件。
 *  只放内存，绝不打印、不落盘。 */
function readKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const raw = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8');
    const m = raw.match(/DEEPSEEK_API_KEY:\s*(\S+)/);
    if (m) return m[1].replace(/^["']|["']$/g, '');
  } catch { /* 读不到就当没有 */ }
  return null;
}
const KEY = readKey();
console.log('DEEPSEEK_API_KEY sourced:', KEY ? `yes (len=${KEY.length})` : 'NO');

function shellQuote(s) {
  const text = String(s);
  return /[\s"&|<>^]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

function run(args, { label, input = '', cwd = REPO, timeoutMs = 240000 } = {}) {
  return new Promise((resolveRun) => {
    const t0 = Date.now();
    const command = `"${DSH}" ${args.map(shellQuote).join(' ')}`.trim();
    const child = spawn(command, [], {
      cwd, env: { ...process.env, DEEPSEEK_API_KEY: KEY }, windowsHide: true, shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const first = { at: null };
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      console.log(`[${label}] TIMEOUT ${timeoutMs}ms → kill tree`);
      spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; if (first.at == null && chunk.trim()) first.at = Date.now() - t0; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('spawn', () => console.log(`[${label}] spawned pid=${child.pid}`));
    child.on('error', (err) => console.log(`[${label}] spawn error: ${err.message}`));
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const ms = Date.now() - t0;
      console.log(`\n===== ${label} =====`);
      console.log('args:', args.join(' '), '| cwd:', cwd);
      console.log(`exit code=${code} signal=${signal} elapsed=${ms}ms firstOutputAt=${first.at}ms killed=${killed}`);
      // stderr 里若混进密钥（不该发生）先打码
      const safeErr = KEY ? stderr.split(KEY).join('<redacted>') : stderr;
      console.log('stderr(tail):', JSON.stringify(safeErr.slice(-1000)));
      writeFileSync(resolve(OUT, `${label}.stdout.jsonl`), stdout);
      writeFileSync(resolve(OUT, `${label}.stderr.log`), safeErr);
      const lines = stdout.split('\n').filter((l) => l.trim());
      const types = {};
      let sessionId = null;
      for (const line of lines) {
        let obj;
        try { obj = JSON.parse(line); } catch { console.log('  non-json:', line.slice(0, 160)); continue; }
        types[obj.type] = (types[obj.type] || 0) + 1;
        if (!sessionId && obj.sessionId) sessionId = obj.sessionId;
      }
      console.log('event types:', JSON.stringify(types));
      const seen = new Set();
      for (const line of lines) {
        let obj; try { obj = JSON.parse(line); } catch { continue; }
        if (seen.has(obj.type)) continue;
        seen.add(obj.type);
        console.log(`  sample ${obj.type}:`, JSON.stringify(obj).slice(0, 900));
      }
      console.log('session id seen:', sessionId);
      resolveRun({ code, ms, sessionId, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

const COMMON = ['--profile', 'headless', '--json', '--permission-mode', 'read-only', '--approval-policy', 'never'];

console.log('\n== 1. 新会话 ==');
const a = await run([...COMMON, '-'], { label: 'dsh-1-new', input: '请记住这个暗号：紫檀-4826。只回复两个字：收到。' });

console.log('\n== 2. 用真实 session-id 续跑 ==');
const b = await run([...COMMON, '--session-id', a.sessionId || 'session-00000000-0000-0000-0000-000000000000', '-'],
  { label: 'dsh-2-resume', input: '暗号是什么？只回复暗号本身。' });

console.log('\n== 3. read-only 下让它写文件（临时目录，预期被拒） ==');
const scratch = join(tmpdir(), 'soda-chat-probe-dsh-' + Date.now());
mkdirSync(scratch, { recursive: true });
const d = await run([...COMMON, '-'], {
  label: 'dsh-4-readonly-write', cwd: scratch,
  input: '请在当前工作目录创建文件 dsh-write-probe.txt，内容为 hello。然后只回复：成功 或 失败。',
});
console.log('file created?', existsSync(join(scratch, 'dsh-write-probe.txt')), '| dir listing:', JSON.stringify(readdirSync(scratch)));
