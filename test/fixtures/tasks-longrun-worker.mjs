// tasks-longrun-worker.mjs — 测试夹具：一个「长跑的假 DSH headless」进程。
//
// 给 test/tasks-rework.test.js 的 C5（停止动作能终止真实执行）用，不联网、不调用任何模型。
// 行为照着真 dsh 的 --json NDJSON：读完 stdin 里的 prompt 后，按固定间隔往 stdout 写事件行，
// 一直写到被杀为止。它是一个真实的操作系统进程——「停止」要真的把它结束掉，不是改一个状态值。
//
// 环境变量：
//   LONGRUN_PID_FILE    启动后把自己的 pid 写进去（测试据此确认被杀的是哪个进程）
//   LONGRUN_STATE_FILE  每写一行事件就把计数写进去（测试据此确认停止后不再有新输出）
import { writeFileSync } from 'node:fs';

const pidFile = process.env.LONGRUN_PID_FILE || null;
const stateFile = process.env.LONGRUN_STATE_FILE || null;
const INTERVAL_MS = Number(process.env.LONGRUN_INTERVAL_MS) || 200;

let prompt = '';
let started = false;

function run() {
  if (started) return;
  started = true;
  if (pidFile) writeFileSync(pidFile, String(process.pid));
  let n = 0;
  setInterval(() => {
    n += 1;
    // thinking / tool_call 交替：在适配器里都算「活动事件」，实例保持 running
    const line = n % 3 === 0
      ? { type: 'tool_call', seq: n, tool: 'Read', path: 'docs/fixture.md' }
      : { type: 'thinking', seq: n, chars: prompt.length };
    process.stdout.write(`${JSON.stringify(line)}\n`);
    if (stateFile) writeFileSync(stateFile, String(n));
  }, INTERVAL_MS);
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', run);
process.stdin.on('error', run);
// 父进程先走了（管道断开）：没人在读事件，自己退出，不抛 EPIPE
process.stdout.on('error', (err) => { if (err && err.code === 'EPIPE') process.exit(0); });
if (process.stdin.isTTY) run();
