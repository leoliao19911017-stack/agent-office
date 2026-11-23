// restart-8090.mjs — 安全重启 8090 看板服务（Agent Chat 各批改了服务端代码后用）。
//
// 重启会打断正在跑的东西，所以先查三样，任何一样不干净就拒绝重启（--force 才继续）：
//   1. 聊天：库里有没有还在进行中的轮次（在跑的 CLI 会变成没人盯的孤儿）
//   2. 任务：attempts 里 running 且进程还活着的执行实例
//   3. 同机其它 Claude 会话：有没有 claude.exe -p 的命令行里带着本仓库路径（说明有别的会话在驱动这个服务）
//
// 用法：node scripts/chat-v1/restart-8090.mjs [--force] [--port 8090]
//   只检查不重启：加 --check
//   --ignore-pid <pid>  这个 claude.exe 是发起重启的那个会话自己（祖先链认不出来时手工指明）
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const args = process.argv.slice(2);
const PORT = args.includes('--port') ? Number(args[args.indexOf('--port') + 1]) : 8090;
const FORCE = args.includes('--force');
const CHECK_ONLY = args.includes('--check');

function sh(cmd, cmdArgs, opts = {}) {
  return spawnSync(cmd, cmdArgs, { encoding: 'utf8', windowsHide: true, ...opts });
}
function listenerPid(port) {
  const r = sh('netstat', ['-ano']);
  const line = String(r.stdout || '').split('\n').find((l) => new RegExp(`^\\s*TCP\\s+\\S+:${port}\\s+\\S+\\s+LISTENING\\s+\\d+\\s*$`).test(l));
  return line ? Number(line.trim().split(/\s+/).pop()) : null;
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

const db = new DatabaseSync(resolve(REPO, 'data', 'agent-office.db'), { readOnly: true });
const activeChat = db.prepare(
  "SELECT turn_id, thread_id, status, provider FROM chat_turns WHERE status IN ('queued','starting','restoring','running','tool_running','approval_required') OR (status = 'rate_limited' AND ended_at IS NULL) ORDER BY created_at",
).all();
const runningAttempts = db.prepare("SELECT attempt_id, task_id, agent_id, pid, started_at FROM attempts WHERE status = 'running' ORDER BY started_at").all();
db.close();
const liveAttempts = runningAttempts.filter((a) => a.pid != null && alive(Number(a.pid)));
const noPidAttempts = runningAttempts.filter((a) => a.pid == null);

// 同机 headless Claude 会话（claude.exe -p …）的命令行；顺便带上本进程的祖先链，好把自己这一支排除掉
const psScript = [
  `$id=${Number(process.pid)}; $anc=@(); while($id){ $anc+=$id; $p=Get-CimInstance Win32_Process -Filter "ProcessId=$id"; if(-not $p){break}; $id=$p.ParentProcessId }`,
  "$anc | ForEach-Object { 'anc|' + $_ }",
  "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | ForEach-Object { 'claude|' + $_.ProcessId + '|' + $_.CommandLine }",
].join('; ');
const psLines = String(sh('powershell', ['-NoProfile', '-Command', psScript]).stdout || '').split(/\r?\n/).filter(Boolean);
const ancestors = new Set(psLines.filter((l) => l.startsWith('anc|')).map((l) => l.slice(4)));
if (args.includes('--ignore-pid')) ancestors.add(String(args[args.indexOf('--ignore-pid') + 1]));
const peerSessions = psLines.filter((l) => l.startsWith('claude|')).map((l) => {
  const [, pid, cmd] = l.split('|', 3);
  return { pid, cmd };
}).filter((p) => /claude(\.exe)?"?\s+-p\b/.test(p.cmd) && /Soda Office/i.test(p.cmd) && !ancestors.has(p.pid));

const oldPid = listenerPid(PORT);
const report = {
  at: new Date().toISOString(), port: PORT, listener_pid: oldPid,
  active_chat_turns: activeChat, running_attempts: runningAttempts, live_attempts: liveAttempts,
  claude_headless_sessions_touching_repo: peerSessions.map((p) => ({ pid: p.pid, cmd: p.cmd.slice(0, 160) })),
};
console.log(JSON.stringify(report, null, 2));

const blockers = [];
if (activeChat.length) blockers.push(`有 ${activeChat.length} 个聊天轮次还在进行中`);
if (liveAttempts.length) blockers.push(`有 ${liveAttempts.length} 个任务执行实例的进程还活着`);
if (peerSessions.length) blockers.push(`有 ${peerSessions.length} 个 headless Claude 会话的命令行带着本仓库路径（可能有别的会话在用这个服务）`);

if (CHECK_ONLY) { console.log(blockers.length ? `检查结果：不宜重启——${blockers.join('；')}` : '检查结果：可以重启'); process.exit(0); }
if (blockers.length && !FORCE) { console.error(`拒绝重启：${blockers.join('；')}（确认无碍可加 --force）`); process.exit(3); }
if (blockers.length) console.warn(`--force：无视 ${blockers.join('；')}`);

if (oldPid) {
  const k = sh('taskkill', ['/PID', String(oldPid), '/T', '/F']);
  console.log(`已结束旧实例 pid=${oldPid}：${String(k.stdout || k.stderr || '').trim()}`);
}

// 启动命令写进临时 .ps1 再用 -File 执行：路径里有空格和括号，经命令行层层转义太容易出错
// （第一版就是这样把服务杀掉后没起来过）。脚本内容先落盘，人能看见、能复跑。
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const outLog = resolve(REPO, 'web', `web-${PORT}.out`);
const errLog = resolve(REPO, 'web', `web-${PORT}.err`);
const ps1 = [
  `$ErrorActionPreference = 'Stop'`,
  `$env:PORT = ${q(String(PORT))}`,
  `Start-Process -FilePath (Get-Command node).Source -ArgumentList 'web/server.js' -WorkingDirectory ${q(REPO)} -WindowStyle Hidden -RedirectStandardOutput ${q(outLog)} -RedirectStandardError ${q(errLog)}`,
].join('\n');
const ps1Path = resolve(tmpdir(), `soda-restart-${PORT}.ps1`);
writeFileSync(ps1Path, ps1, 'utf8');
// 不能用管道接 PowerShell 的输出： detached 的服务进程会继承管道句柄，spawnSync 要等管道关闭（= 服务退出）才返回。
// 所以不接输出，起没起来以 /api/health 和端口监听为准。
const started = sh('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1Path], { stdio: 'ignore' });
if (started.status !== 0) {
  console.error(`启动脚本退出码 ${started.status}：${started.error ? started.error.message : '见 stderr 日志'}\n启动脚本：${ps1Path}\n${ps1}`);
  process.exit(1);
}
console.log(`启动脚本已执行（日志 ${outLog} / ${errLog}）`);

const t0 = Date.now();
for (;;) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) { console.log(`就绪：${JSON.stringify(await r.json())}（${Date.now() - t0}ms）pid=${listenerPid(PORT)}`); break; }
  } catch { /* 还没起来 */ }
  if (Date.now() - t0 > 20000) {
    console.error(`20s 内 /api/health 没有就绪；stderr 日志：${readFileSync(errLog, 'utf8').slice(-600)}`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 200));
}
