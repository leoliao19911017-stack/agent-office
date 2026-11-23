// probe-claude.mjs — 开工前的 claude CLI 真实调用探针：摸清 stream-json 事件形状、
// --session-id 新建 / --resume 续聊的差别、干净环境变量下的启动耗时。
// 用法：node scripts/chat-v1/probe-claude.mjs
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const OUT = resolve(HERE, 'out');
mkdirSync(OUT, { recursive: true });

/** 嵌套会话隔离：父进程（本 Claude Code 会话）的 CLAUDECODE / CLAUDE_CODE_* 一律不传给子 CLI */
function cleanEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k === 'CLAUDE_EFFORT') continue;
    out[k] = v;
  }
  return out;
}

function run(args, { label, input = '' } = {}) {
  return new Promise((resolveRun) => {
    const t0 = Date.now();
    const first = { at: null, type: null };
    const child = spawn('claude', args, {
      cwd: REPO, env: cleanEnv(process.env), windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (first.at == null && chunk.trim()) { first.at = Date.now() - t0; first.type = chunk.trim().slice(0, 80); }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('spawn', () => console.log(`[${label}] spawned pid=${child.pid}`));
    child.on('error', (err) => console.log(`[${label}] spawn error: ${err.message}`));
    child.on('close', (code, signal) => {
      const ms = Date.now() - t0;
      console.log(`\n===== ${label} =====`);
      console.log('args:', args.join(' '));
      console.log(`exit code=${code} signal=${signal} elapsed=${ms}ms firstOutputAt=${first.at}ms`);
      console.log('stderr:', JSON.stringify(stderr.slice(0, 600)));
      writeFileSync(resolve(OUT, `${label}.stdout.jsonl`), stdout);
      const lines = stdout.split('\n').filter((l) => l.trim());
      const types = {};
      let text = '';
      let sessionId = null;
      for (const line of lines) {
        let obj;
        try { obj = JSON.parse(line); } catch { console.log('  non-json:', line.slice(0, 120)); continue; }
        const key = obj.type + (obj.subtype ? `/${obj.subtype}` : '');
        types[key] = (types[key] || 0) + 1;
        if (obj.session_id) sessionId = obj.session_id;
        if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
          for (const c of obj.message.content) if (c.type === 'text') text += c.text;
        }
        if (obj.type === 'result') {
          console.log('  result:', JSON.stringify({ subtype: obj.subtype, is_error: obj.is_error, result: String(obj.result ?? '').slice(0, 200), num_turns: obj.num_turns, duration_ms: obj.duration_ms, session_id: obj.session_id }));
        }
        if (obj.type === 'stream_event') {
          const ev = obj.event;
          if (ev && !['content_block_delta', 'message_start', 'message_stop', 'content_block_start', 'content_block_stop', 'ping'].includes(ev.type)) {
            console.log('  stream_event:', ev.type, JSON.stringify(ev).slice(0, 160));
          }
        }
      }
      console.log('event types:', JSON.stringify(types));
      console.log('session_id seen:', sessionId);
      console.log('assistant text:', JSON.stringify(text.slice(0, 400)));
      resolveRun({ code, ms, sessionId, text, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

const sid = randomUUID();
console.log('new session id:', sid);
const a = await run([
  '-p', '请记住这个暗号：青竹-7391。只回复两个字：收到。',
  '--output-format', 'stream-json', '--verbose',
  '--session-id', sid,
  '--permission-mode', 'plan',
  '--tools', 'Read,Grep,Glob',
  '--disallowedTools', 'Bash,PowerShell,Edit,Write,NotebookEdit,WebFetch,WebSearch,Task,Agent',
  '--strict-mcp-config',
  '--max-turns', '3',
], { label: 'claude-1-new' });

const b = await run([
  '-p', '暗号是什么？只回复暗号本身。',
  '--output-format', 'stream-json', '--verbose',
  '--resume', a.sessionId || sid,
  '--permission-mode', 'plan',
  '--tools', 'Read,Grep,Glob',
  '--disallowedTools', 'Bash,PowerShell,Edit,Write,NotebookEdit,WebFetch,WebSearch,Task,Agent',
  '--strict-mcp-config',
  '--max-turns', '3',
], { label: 'claude-2-resume' });

console.log('\n===== 对照：同一条消息用 --session-id 传旧 ID（任务书说这样不能续） =====');
const c = await run([
  '-p', '暗号是什么？只回复暗号本身。',
  '--output-format', 'stream-json', '--verbose',
  '--session-id', a.sessionId || sid,
  '--permission-mode', 'plan',
  '--tools', 'Read,Grep,Glob',
  '--disallowedTools', 'Bash,PowerShell,Edit,Write,NotebookEdit,WebFetch,WebSearch,Task,Agent',
  '--strict-mcp-config',
  '--max-turns', '3',
], { label: 'claude-3-sessionid-old' });
