// probe-claude-json.mjs — P1 开工前实测：老板给的原样参数 + --output-format json 的真实输出形状。
// 跟 probe-claude.mjs 的区别：那次用的是 stream-json --verbose（事件流），这次是 json（单个结果对象），
// 也就是 P1 adapter 真正要解析的格式。三次真调用：
//   1) 新建   --session-id <新UUID>
//   2) 续聊   --resume <第 1 次的 session id>
//   3) 传错   --resume <不存在的 ID>   ← A7 要的失败形状
// 用法：node scripts/chat-v1/probe-claude-json.mjs
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

// 老板实测给定的参数，原样不动（不传 --model：模型在 settings.json 里配好）
const BASE = [
  '--effort', 'high',
  '--permission-mode', 'acceptEdits',
  '--allowedTools', 'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
  '--output-format', 'json',
];

function run(args, { label }) {
  return new Promise((resolveRun) => {
    const t0 = Date.now();
    const child = spawn('claude', args, {
      cwd: REPO, env: cleanEnv(process.env), windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => {
      console.log(`\n===== ${label} =====`);
      console.log('args:', args.join(' '));
      console.log(`spawn error: ${err.message} (code=${err.code}) elapsed=${Date.now() - t0}ms`);
      resolveRun({ code: null, stdout, stderr, sessionId: null });
    });
    child.on('close', (code, signal) => {
      const ms = Date.now() - t0;
      writeFileSync(resolve(OUT, `${label}.stdout.json`), stdout);
      writeFileSync(resolve(OUT, `${label}.stderr.log`), stderr);
      console.log(`\n===== ${label} =====`);
      console.log('args:', args.map((a) => (a.length > 60 ? `${a.slice(0, 60)}…` : a)).join(' '));
      console.log(`exit code=${code} signal=${signal} elapsed=${ms}ms`);
      console.log(`stdout bytes=${Buffer.byteLength(stdout)} lines=${stdout.split('\n').filter((l) => l.trim()).length}`);
      console.log('stderr:', JSON.stringify(stderr));
      let obj = null;
      try { obj = JSON.parse(stdout.trim()); } catch { /* 非 JSON，下面原样打印 */ }
      if (obj && typeof obj === 'object') {
        console.log('stdout is ONE json object. keys:', Object.keys(obj).join(','));
        console.log('  summary:', JSON.stringify({
          type: obj.type, subtype: obj.subtype, is_error: obj.is_error, num_turns: obj.num_turns,
          duration_ms: obj.duration_ms, session_id: obj.session_id, terminal_reason: obj.terminal_reason,
          stop_reason: obj.stop_reason, api_error_status: obj.api_error_status,
          result: typeof obj.result === 'string' ? obj.result : obj.result,
          usage: obj.usage,
          permission_denials: obj.permission_denials,
        }));
      } else {
        console.log('stdout is NOT a single json object. raw head:', JSON.stringify(stdout.slice(0, 1500)));
      }
      resolveRun({ code, stdout, stderr, sessionId: obj && obj.session_id ? obj.session_id : null });
    });
  });
}

const sid = randomUUID();
console.log('new session id:', sid);

const a = await run(['-p', '请记住这个暗号：青竹-7391。只回复两个字：收到。', '--session-id', sid, ...BASE], { label: 'json-1-new' });
const resumeId = a.sessionId || sid;
console.log('\nresume target:', resumeId, a.sessionId ? '(取自第 1 次输出)' : '(第 1 次没给 session_id，退回自己生成的)');

const b = await run(['-p', '暗号是什么？只回复暗号本身。', '--resume', resumeId, ...BASE], { label: 'json-2-resume' });

console.log('\n===== 对照：--resume 传一个不存在的 session id =====');
const c = await run(['-p', '你好，只回复：在。', '--resume', '00000000-0000-0000-0000-000000000000', ...BASE], { label: 'json-3-resume-missing' });

console.log('\n===== 汇总 =====');
console.log(JSON.stringify({
  new: { code: a.code, session_id: a.sessionId },
  resume: { code: b.code, session_id: b.sessionId },
  missing: { code: c.code, session_id: c.sessionId, stderr: c.stderr.slice(0, 300), stdout: c.stdout.slice(0, 300) },
}, null, 2));
