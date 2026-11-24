// probe-hermes.mjs — P6 前置探测：hermes 到底能不能非交互调用、能不能续聊。
//
// 只跑真实命令、只记录原始输出，不下结论式断言；结论写进 docs/evidence/chat-p6/probe.md。
// 用法：node scripts/chat-v1/probe-hermes.mjs
// 产物：scripts/chat-v1/out/hermes-probe.json / hermes-probe.txt
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, 'out');
mkdirSync(OUT, { recursive: true });
const lines = [];
const log = (...a) => { const s = a.join(' '); console.log(s); lines.push(s); };

function run(args, { input = null, timeout = 120000 } = {}) {
  const r = spawnSync('hermes', args, { encoding: 'utf8', timeout, input: input ?? undefined, windowsHide: true });
  return { args, status: r.status, signal: r.signal, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/** 跑一条 stream-json，返回 {sessionId, text, events, stderr, status} */
function streamTurn({ prompt, resumeId = null }) {
  return new Promise((resolveP) => {
    const args = ['chat', '--query-file', '-', '--format', 'stream-json', '--oneshot', '--toolsets', 'web,session_search'];
    if (resumeId) args.push('--resume', resumeId);
    const child = spawn('hermes', args, { cwd: resolve(HERE, '..', '..'), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.stdin.end(prompt);
    child.on('close', (code) => {
      const events = out.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
      const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
      const result = events.find((e) => e.type === 'result');
      resolveP({ code, sessionId: (result && result.session_id) || (init && init.session_id) || null, text: result ? result.text : null, events, stderr: err, args });
    });
  });
}

/* 1) 命令在不在 */
const where = spawnSync('where', ['hermes'], { encoding: 'utf8', windowsHide: true });
const version = run(['--version']);
const help = run(['--help']);
const chatHelp = run(['chat', '--help']);
const tools = run(['tools', 'list']);
log('$ where hermes\n' + where.stdout.trim());
log('\n$ hermes --version\n' + version.stdout.trim());
log('\n$ hermes --help（与「非交互」相关的行）');
for (const l of help.stdout.split(/\r?\n/)) if (/-z PROMPT|--oneshot|--resume|--query-file|--format|--toolsets/.test(l)) log(l);
log('\n$ hermes chat --help（query / format / resume）');
for (const l of chatHelp.stdout.split(/\r?\n/)) if (/--query-file|--oneshot|--format|--resume|--toolsets|stream-json/.test(l)) log(l);
log('\n$ hermes tools --summary（前 40 行）\n' + tools.stdout.split(/\r?\n/).slice(0, 40).join('\n'));

/* 2) 最简单的一次性调用 */
const z = run(['-z', 'Reply with exactly: HERMES_ONESHOT_OK'], { timeout: 180000 });
log(`\n$ hermes -z "Reply with exactly: HERMES_ONESHOT_OK"\nexit=${z.status}\nstdout=${JSON.stringify(z.stdout.trim())}\nstderr=${JSON.stringify(z.stderr.trim())}`);

/* 3) stream-json：能不能拿到 session id / 增量 / 最终文本 */
const t1 = await streamTurn({ prompt: '我叫 Leo，我最喜欢的数字是 42，养了一只叫汽水的猫。请记住，等下考你。' });
log(`\n$ hermes chat --query-file - --format stream-json --oneshot -t web,session_search`);
log(`exit=${t1.code} session_id=${t1.sessionId}`);
log(`事件类型=${JSON.stringify([...new Set(t1.events.map((e) => e.type + (e.subtype ? `/${e.subtype}` : '')))])}`);
log(`text 事件数=${t1.events.filter((e) => e.type === 'text').length}`);
log(`最终文本=${JSON.stringify(t1.text)}`);
log(`stderr=${JSON.stringify(t1.stderr.trim())}`);

/* 4) 续聊：--resume 上一轮的 session id，看能不能接上第 1 轮 */
const t2 = t1.sessionId ? await streamTurn({ prompt: '我最喜欢的数字是多少？只回答数字。', resumeId: t1.sessionId }) : null;
if (t2) {
  log(`\n$ hermes chat ... --resume ${t1.sessionId}（第 2 轮）`);
  log(`exit=${t2.code} session_id=${t2.sessionId}（与第 1 轮相同=${t2.sessionId === t1.sessionId}）`);
  log(`第 2 轮回复=${JSON.stringify(t2.text)}`);
}

/* 5) 坏的 session id：它怎么报错（决定 adapter 该落哪个状态） */
const bad = await streamTurn({ prompt: 'hi', resumeId: 'does-not-exist-xyz' });
log(`\n$ hermes chat ... --resume does-not-exist-xyz（坏 ID）`);
log(`exit=${bad.code} session_id=${bad.sessionId}`);
log(`事件=${JSON.stringify(bad.events)}`);
log(`stderr=${JSON.stringify(bad.stderr.trim())}`);

const summary = {
  at: new Date().toISOString(),
  where: where.stdout.trim(), version: version.stdout.trim(),
  oneshot: { status: z.status, stdout: z.stdout.trim() },
  turn1: { code: t1.code, sessionId: t1.sessionId, text: t1.text, event_types: [...new Set(t1.events.map((e) => e.type))], stderr: t1.stderr.trim() },
  turn2: t2 ? { code: t2.code, sessionId: t2.sessionId, text: t2.text, same_session: t2.sessionId === t1.sessionId } : null,
  bad_resume: { code: bad.code, sessionId: bad.sessionId, events: bad.events, stderr: bad.stderr.trim() },
};
writeFileSync(resolve(OUT, 'hermes-probe.json'), JSON.stringify(summary, null, 2));
writeFileSync(resolve(OUT, 'hermes-probe.txt'), lines.join('\n'));
console.log(`\n已写：${resolve(OUT, 'hermes-probe.json')} / hermes-probe.txt`);
