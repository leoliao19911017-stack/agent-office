// office.mjs — 把每一批登记到 Agent Office（POST /api/tasks → attempt → checkpoint → finish）。
// 中文请求体一律走 UTF-8 文件 + curl --data-binary（内联中文会被 Windows 控制台按 GBK 转码）。
//
// 用法：
//   node scripts/chat-v1/office.mjs register <目录>            读 <目录>/task-create.json、task-attempt.json，发 create + attempt，
//                                                              响应落 task-create.resp.json / task-attempt.resp.json，打印 task_id / attempt_id
//   node scripts/chat-v1/office.mjs close <目录> [--sha <git_sha>] [--task <task_id>] [--attempt <attempt_id>]
//       读 <目录>/task-checkpoint.json、task-finish.json（没有就用默认文案），发 checkpoint + finish；
//       --sha 写进 finish 的 code_sha（要等于刚生成的检查点的 git_sha，状态才是「代码版本与检查点一致」）
//   可选环境变量 OFFICE_BASE（默认 http://127.0.0.1:8090）
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const BASE = process.env.OFFICE_BASE || 'http://127.0.0.1:8090';
const [cmd, dir, ...rest] = process.argv.slice(2);
if (!cmd || !dir) { console.error('用法见文件头'); process.exit(2); }
const argsOf = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : null; };

function curl(method, path, bodyFile) {
  const out = resolve(dir, `${bodyFile.replace(/\.json$/, '')}.resp.json`);
  const a = ['-s', '-m', '30', '-o', out, '-w', '%{http_code}', '-X', method, '-H', 'content-type: application/json; charset=utf-8'];
  if (bodyFile) a.push('--data-binary', `@${resolve(dir, bodyFile)}`);
  a.push(BASE + path);
  const r = spawnSync('curl', a, { encoding: 'utf8' });
  const status = Number(String(r.stdout || '').trim());
  const body = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null;
  return { status, body };
}
const load = (name, fallback) => {
  const p = resolve(dir, name);
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  return fallback;
};
const save = (name, data) => writeFileSync(resolve(dir, name), `${JSON.stringify(data, null, 2)}\n`, 'utf8');

if (cmd === 'register') {
  const created = curl('POST', '/api/tasks', 'task-create.json');
  if (created.status !== 201) { console.error(`建任务失败 HTTP ${created.status}：${JSON.stringify(created.body)}`); process.exit(1); }
  const taskId = created.body.task.task_id;
  const attempted = curl('POST', `/api/tasks/${taskId}/attempt`, 'task-attempt.json');
  if (attempted.status !== 201) { console.error(`attempt 失败 HTTP ${attempted.status}：${JSON.stringify(attempted.body)}`); process.exit(1); }
  console.log(`task ${taskId}  status=${created.body.task.status}  「${created.body.task.title}」`);
  console.log(`attempt ${attempted.body.attempt.attempt_id}  status=${attempted.body.attempt.status}  运行中任务状态=${attempted.body.state.status}（${attempted.body.state.status_reason}）`);
} else if (cmd === 'close') {
  const created = load('task-create.resp.json', null);
  const attempted = load('task-attempt.resp.json', null);
  const taskId = argsOf('--task') || (created && created.task.task_id);
  const attemptId = argsOf('--attempt') || (attempted && attempted.attempt.attempt_id);
  if (!taskId || !attemptId) { console.error('找不到 task_id / attempt_id（目录里没有 register 的响应，也没用 --task/--attempt 指定）'); process.exit(1); }
  const sha = argsOf('--sha');
  const checkpointBody = load('task-checkpoint.json', { label: '完成', worktree_path: resolve(dirname(fileURLToPath(import.meta.url)), '..', '..') });
  if (!checkpointBody.worktree_path) checkpointBody.worktree_path = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  checkpointBody.attempt_id = attemptId;
  save('task-checkpoint.json', checkpointBody);
  const cp = curl('POST', `/api/tasks/${taskId}/checkpoint`, 'task-checkpoint.json');
  if (cp.status !== 201) { console.error(`checkpoint 失败 HTTP ${cp.status}：${JSON.stringify(cp.body)}`); process.exit(1); }
  console.log(`checkpoint ${cp.body.checkpoint.checkpoint_id}  git_sha=${String(cp.body.git_sha || '').slice(0, 10)}  tracked_changed=${cp.body.checkpoint.files ? cp.body.checkpoint.files.length : '?'}  untracked=${cp.body.checkpoint.untracked ? cp.body.checkpoint.untracked.length : '?'}`);
  const finishBody = load('task-finish.json', { evidence: '', note: '' });
  finishBody.attempt_id = attemptId;
  if (sha) finishBody.code_sha = sha;
  if (!finishBody.evidence) { console.error('finish 必须带 evidence（task-finish.json 里写 evidence）'); process.exit(1); }
  save('task-finish.json', finishBody);
  const fin = curl('POST', `/api/tasks/${taskId}/finish`, 'task-finish.json');
  if (fin.status !== 200) { console.error(`finish 失败 HTTP ${fin.status}：${JSON.stringify(fin.body)}`); process.exit(1); }
  console.log(`finish → 任务状态=${fin.body.state.status}｜${fin.body.state.status_reason}｜执行实例=${fin.body.attempt ? fin.body.attempt.status : '无'}｜步骤=${fin.body.task.progress.done}/${fin.body.task.progress.total}`);
  console.log(`（git rev-parse HEAD = ${execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim().slice(0, 10)}）`);
} else { console.error('不认识的命令'); process.exit(2); }
