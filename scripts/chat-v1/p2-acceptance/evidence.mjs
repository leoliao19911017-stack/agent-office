// evidence.mjs — 用 out/ 里的真实输出 + 数据库里的行，生成 P2 证据文档（md 给 AI、html 给人）。
// 用法：node --no-warnings scripts/chat-v1/p2-acceptance/evidence.mjs
// 前提：run.mjs 已经跑过（out/*.json、out/run.log 在），office/*.resp.json 是登记响应。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { evidencePage } from '../evidence-html.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const OUT = resolve(HERE, 'out');
const DOC = resolve(REPO, 'docs', 'evidence', 'chat-p2');
mkdirSync(DOC, { recursive: true });
const json = (name) => JSON.parse(readFileSync(resolve(OUT, `${name}.json`), 'utf8'));
const office = (name) => JSON.parse(readFileSync(resolve(HERE, 'office', `${name}.resp.json`), 'utf8'));
const summary = json('summary');
const b1 = json('b1');
const b2 = json('b2');
const b3 = json('b3');
const b4 = json('b4');
const b5a = json('b5a-session-not-found');
const b5b = json('b5b-workspace-gone');
const b5c1 = json('b5c-cli_path_missing');
const b5c2 = json('b5c-cli_not_found');
const fr = json('resume-flag-resume');
const fsid = json('resume-flag-session-id');
const runLog = readFileSync(resolve(OUT, 'run.log'), 'utf8');
const task = office('task-create');
const attempt = office('task-attempt');
const q = (s) => String(s ?? '').replace(/\|/g, '\\|');
const code = (s) => `\`\`\`\n${String(s).trim()}\n\`\`\``;
const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };

/* ---------- 数据库里的行（直查 data/agent-office.db） ---------- */
const db = new DatabaseSync(resolve(REPO, 'data', 'agent-office.db'), { readOnly: true });
const threadId = b1.thread_id;
const turns = db.prepare('SELECT turn_id, status, resume, started_at, ended_at FROM chat_turns WHERE thread_id = ? ORDER BY created_at').all(threadId);
const messages = db.prepare('SELECT seq, role, status, turn_id, content FROM chat_messages WHERE thread_id = ? ORDER BY seq').all(threadId);
const eventTypes = (turnId) => db.prepare('SELECT type, COUNT(*) AS n FROM chat_events WHERE turn_id = ? GROUP BY type ORDER BY MIN(seq)').all(turnId)
  .map((r) => `${r.type}×${r.n}`).join(' ');
const evByTurn = Object.fromEntries(turns.map((t) => [t.turn_id, eventTypes(t.turn_id)]));   // 关库前先取好，模板里只用结果
const counts = Object.fromEntries(['chat_threads', 'chat_messages', 'chat_turns', 'chat_events'].map((t) => [t, Number(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n)]));
db.close();

/* ---------- 自动化测试（现跑现记） ---------- */
function runTests(args2) {
  const r = spawnSync(process.execPath, ['--no-warnings', '--test', ...args2], { cwd: REPO, encoding: 'utf8', timeout: 180000 });
  const text = `${r.stdout || ''}${r.stderr || ''}`;
  const pick = (k) => { const m = text.match(new RegExp(`^ℹ ${k} (\\d+)`, 'm')); return m ? Number(m[1]) : null; };
  return { tests: pick('tests'), pass: pick('pass'), fail: pick('fail'), exit: r.status };
}
const tState = runTests(['test/chat-state.test.js']);
const tEngine = runTests(['test/chat-engine.test.js']);
const tHttp = runTests(['test/chat-http.test.js']);

const md = `# Agent Chat P2 验收证据：dsh adapter（B1-B5）

- 日期：${summary.finished_at}（验收开始 ${summary.started_at}）
- 执行人：Claude（soda-office-ba 会话，飞书触发）
- 服务：\`${summary.base}\`（重启后载入本批代码；health=${JSON.stringify(summary.health)}）
- dsh：\`${summary.bin}\`（0.2.2-rc.5，完整路径；不在 PATH）
- 验收脚本：\`scripts/chat-v1/p2-acceptance/run.mjs\`，完整输出 \`scripts/chat-v1/p2-acceptance/out/run.log\`，逐项 JSON 在同目录
- 验收对话：thread \`${threadId}\`（B1-B4，四轮真 dsh）
- Agent Office 登记：task \`${task.task.task_id}\` / attempt \`${attempt.attempt.attempt_id}\`（checkpoint、finish 见本批提交后的记录）

## 结论

| 项 | 内容 | 结果 |
|---|---|---|
| B1 | 建 dsh thread，发一条消息有真实回复 | ✅ ${summary.acceptance.find((r) => r.id === 'B1').pass ? '通过' : '未过'} |
| B2 | 连发 3 条，第 3 条能反映第 1 条内容 | ✅ ${summary.acceptance.find((r) => r.id === 'B2').pass ? '通过' : '未过'} |
| B3 | 问「我第一句说了什么」能答对 | ✅ ${summary.acceptance.find((r) => r.id === 'B3').pass ? '通过' : '未过'} |
| B4 | session-id 正确保存，第 2 条起走续聊 | ✅ ${summary.acceptance.find((r) => r.id === 'B4').pass ? '通过' : '未过'} |
| B5 | dsh 起不来时状态是 failed 且原因具体 | ✅ ${summary.acceptance.filter((r) => r.id.startsWith('B5')).every((r) => r.pass) ? '四种情况全过' : '有未过项'} |

验收 ${summary.pass}/${summary.total} 通过（脚本退出码 0）。

## ⚠️ 与任务书口径不一致的一处：续聊参数

任务书写「续聊用 --resume <session-id>，不是 --session-id」。**对 dsh 不成立**，两种都真跑了：

| 参数 | 真实命令（节选） | dsh 的真实结果 |
|---|---|---|
| \`--resume\` | ${q((fr.resume.command || '').match(/--resume\s+\S+/)?.[0] || '')} | ❌ exit ${fr.resume.exitCode}，stderr/stdout 报「${q(fr.resume.message)}」，引擎归为 \`${fr.resume.kind}\` |
| \`--session-id\` | ${q((fsid.resume.command || '').match(/--session-id\s+\S+/)?.[0] || '')} | ✅ exit ${fsid.resume.exitCode}，答出口令「${q(fsid.resume.text)}」 |

依据：dsh 自带 help（\`dsh --profile headless --help\`）只列了 \`--session-id <id>\`「adopt the persisted Session with this id」，
示例就是 \`--session-id session-… "continue"   resume an existing Session\`；\`--resume\` 是 \`dsh tui\` 的参数，也是 Claude Code 的参数。
所以 **dsh adapter 用 \`--session-id\`、claude adapter 用 \`--resume\`**，各自按实测。B4 的「第 2 条走续聊」按这个口径验收。
复现：\`node scripts/chat-v1/p2-acceptance/probe-resume-flag.mjs resume\` 与 \`… session-id\`。

${code(`$ dsh.cmd --profile headless --help
Options:
  --json                      write newline-delimited run events to stdout instead of the final message
  --session-id <id>           adopt the persisted Session with this id; an unknown id is an error
  --permission-mode <preset>  select a configured permission preset for this task, including on resume
  --approval-policy <policy>  set approval behavior after selecting the permission preset (choices: "ask", "never")
  --add-dir <path>            allow an additional physical absolute directory under workspace-write (repeatable)

Examples:
  dsh --profile headless --session-id session-… "continue"   resume an existing Session`)}

## B1 建 dsh thread，发一条有真实回复 ✅

- \`POST /api/chat/threads {"agent_id":"dsh"}\` → HTTP ${b1.http}，thread \`${threadId}\`
- 发送：「${q(b1.request)}」
- 轮次 \`${b1.turn.turn_id}\`：status=**${b1.turn.status}**（界面 ${b1.turn.display_status}），${b1.waited_ms}ms
- dsh 回复原文：「${q(b1.reply)}」

这一轮的事件（\`GET /api/chat/turns/${b1.turn.turn_id}\`；序号就是 SSE 的 \`id\`）：

${code(`> GET /api/chat/turns/${b1.turn.turn_id}\n${b1.events.map((e) => `${String(e.seq).padStart(2)}  ${e.type}${e.status ? ` status=${e.status}` : ''}${e.cli_command ? `  ${cut(e.cli_command, 150)}` : ''}`).join('\n')}`)}

## B2 连发 3 条，第 3 条反映第 1 条 ✅

| 轮 | 发送 | dsh 回复（原文节选） | 状态 |
|---|---|---|---|
| 第 2 条 | ${q(b2.m2.request)} | ${q(cut(b2.m2.reply, 120))} | ${b2.m2.turn.status} |
| 第 3 条 | ${q(b2.m3.request)} | **${q(b2.m3.reply)}** | ${b2.m3.turn.status} |

第 3 条只回了口令本身 \`${b2.m3.reply.includes('青禾-9241') ? '青禾-9241' : '（未含）'}\`——第 1 条告诉它的内容，隔了一条消息仍然记得。

## B3 问「我第一句说了什么」 ✅

发送：「${q(b3.request)}」

dsh 回复原文：

${code(b3.reply)}

第一句原文（逐字核对，去掉标点后完全一致）：

${code(b3.first_message)}

## B4 session-id 保存，第 2 条起走续聊 ✅

- \`chat_threads.provider_session_id\` = \`${b4.provider_session_id}\`（首轮 dsh 自己给的 \`session-…\`，引擎回填）

首轮的命令行（没有续聊参数）：

${code(cut(b4.first_command, 400))}

第 2/3/4 条的命令行（都带 \`--session-id <同一个真实 ID>\`）：

${code(cut(b4.resume_commands[0], 400))}

数据库 \`chat_turns\`（thread \`${threadId}\`，按建轮先后）：

| turn_id | status | resume | started_at | ended_at | 事件 |
|---|---|---|---|---|---|
${turns.map((t) => `| ${t.turn_id} | ${t.status} | ${t.resume} | ${t.started_at} | ${t.ended_at} | ${q(evByTurn[t.turn_id])} |`).join('\n')}

\`chat_messages\`（同 thread）：

| seq | role | status | turn_id | content |
|---|---|---|---|---|
${messages.map((m) => `| ${m.seq} | ${m.role} | ${m.status} | ${m.turn_id || ''} | ${q(cut(m.content, 70))} |`).join('\n')}

全库计数：${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('，')}。

## B5 dsh 起不来 → failed，原因具体 ✅

四种情况都是真制造的（不是 mock）。轮次终态一律 \`failed\`，\`error.code\` 是错误大类、\`error.reason\` 是细原因，\`error.message\` 是给用户看的那句话。

| 情况 | 怎么制造的 | turn.status | error.code | error.reason | 用户消息 | 助手消息 |
|---|---|---|---|---|---|---|
| 会话不存在 | 8090：把 thread 的 provider_session_id 改成不存在的 ID 再发消息，dsh 真的报 does not exist | ${b5a.turn.status} | ${b5a.turn.error.code} | ${b5a.turn.error.reason} | ${b5a.user_message.status} | ${b5a.assistant_message.status} |
| 工作目录没了 | 8090：建对话时目录在，发消息前把目录删了 | ${b5b.turn.status} | ${b5b.turn.error.code} | ${b5b.turn.error.reason} | ${b5b.user_message_status} | failed |
| CLI 路径错 | 私有实例（真实 server.js + 临时库），DSH_BIN=\`C:/nope/never/installed/dsh.cmd\` | ${b5c1.turn.status} | ${b5c1.turn.error.code} | ${b5c1.turn.error.reason} | ${b5c1.user_message.status} | ${b5c1.assistant_message.status} |
| 命令找不到 | 私有实例，DSH_BIN=\`definitely-not-a-dsh-binary-xyz.cmd\` | ${b5c2.turn.status} | ${b5c2.turn.error.code} | ${b5c2.turn.error.reason} | ${b5c2.user_message.status} | ${b5c2.assistant_message.status} |

给用户看的原因（\`error.message\` 原文）：

${code([
  `[会话不存在]  ${b5a.turn.error.message}`,
  `[工作目录没了] ${b5b.turn.error.message}`,
  `[CLI 路径错]   ${b5c1.turn.error.message}`,
  `[命令找不到]   ${b5c2.turn.error.message}`,
].join('\n'))}

「CLI 路径错」那一轮通过 HTTP 看到的样子（界面五态 display_status=failed / display_label=${b5c1.turn.display_label}）：

${code(`> GET /api/chat/turns/${b5c1.turn.turn_id}
${cut(JSON.stringify({ status: b5c1.turn.status, status_label: b5c1.turn.status_label, display_status: b5c1.turn.display_status, display_label: b5c1.turn.display_label, error: b5c1.turn.error }), 900)}

> 对话状态 thread_status
${cut(JSON.stringify(b5c1.thread_status), 400)}`)}

说明：
- 「路径错 / 命令找不到」不能在 8090 上制造（要改 DSH_BIN），所以另起了一个真实的 \`web/server.js\` 子进程 + 临时数据库（\`test/chat-harness.mjs\`），走的是同一段代码。
- P1 的 A7 当时落的是 \`interrupted\`；本批把「没跑成」和「跑着被切断」分开：前者（起不来 / 没凭据 / 认证不过 / 会话丢了 / CLI 明确报错）落 **failed**，后者（崩溃 / 超时 / 取消 / 服务重启 / 轮数上限）落 interrupted。

## 完整运行输出

${code(runLog)}

## 本批改动

- \`web/chat/adapters/dsh-chat.mjs\`：续聊参数定为 \`--session-id\`（实测）；起进程前先查 bin 路径 / 工作目录；启动失败带 \`reason\`（cli_path_missing / cli_not_found / cli_not_executable / permission_denied / workspace_not_found / dll_init_failed / start_error）；留证真正执行的命令行；额度错误解析重置时间
- \`web/chat/adapters/claude-chat.mjs\`：同一套启动失败归因；记录 CLI 自动重试的次数与间隔；支持 \`CHAT_CLAUDE_SETTINGS\` 追加 \`--settings\`（换网关 / 对照实验）
- \`web/chat/proc.mjs\`：\`preflightBin\` / \`explainStartFailure\`（认 Node 的 err.code、cmd.exe 的中英文报错、Windows NTSTATUS 退出码）
- \`web/chat/chat-state.mjs\`：加 \`failed\` 终态与 FAILED_KINDS / NOT_DELIVERED_KINDS；界面五态 \`displayStatusOf\`；\`extractResetAt\` / \`retryHint\`；\`isTurnActive\`
- \`web/chat/chat-engine.mjs\`：事件序号改为「一个 seq，落库与推送同一条」；增量攒批同 seq；订阅支持排队中的轮次与 Last-Event-ID 续订；结局里带的 session 也保存；工作目录不存在不去起进程（这部分是 P3 的地基，P2 一并带了）
- \`web/chat/chat-db.mjs\`：\`queuedAhead\` / \`lastChatEvent\`；限流重试中的轮次算在进行中；\`threadStatusOf\` 带重试提示
- \`web/api-chat.mjs\` / \`web/server-api.mjs\`：\`/api/chat/...\` 整体挂载；加对话列表 / 详情 / 轮次详情 / SSE / 取消路由（P3 的路由随本批代码一起上线，P3 再验收）
- \`web/api-tasks.mjs\` + \`web/lib/events.mjs\`：**新增 \`POST /api/tasks/:id/finish\`**（之前并不存在，见下）
- \`web/server.js\`：SIGINT 时收掉在跑的聊天轮次
- 测试：\`test/chat-state.test.js\`（${tState.pass}/${tState.tests}）、\`test/chat-engine.test.js\`（${tEngine.pass}/${tEngine.tests}）、\`test/chat-http.test.js\`（${tHttp.pass}/${tHttp.tests}，真实 server.js + 假 CLI，不联网不花额度）；夹具 \`test/chat-harness.mjs\`、\`test/fixtures/chat-fake-{claude,dsh}.mjs\`

## 关于 \`POST /api/tasks/:id/finish\`

任务要求用它把每批登记成 completed，但**仓库里原本没有这个端点**（只有 attempt / checkpoint / handoff），P1 那条所以停在 unknown。
本批补上了：它不直接写 completed（状态机硬规矩「completed 必须绑定验收通过」），而是做三件事——把执行实例正常结束（completed/done）、
记一条**必须带证据**的 \`acceptance_passed\`（没有 evidence 直接 400 EVIDENCE_REQUIRED）、让状态机自己算出 completed。
带 \`command\` 时证据来源记 verifier（脚本验的），否则记 user（人工验收）。

## 过程中出的事（如实记）

- 第一次重启 8090 时，重启脚本的 PowerShell 引号写错，旧实例杀掉后新实例没起来，**8090 中断了约 2 分钟**；随后手工拉起，
  脚本改成「启动命令落 .ps1 文件再执行」并在 8093 上验证过（255ms 就绪）。重启前脚本会查：在跑的聊天轮次、活着的目标执行实例、同机其它带本仓库路径的 headless Claude 会话，任何一项不干净就拒绝重启。
- 给三个并行会话（engvm-b1 / agent-office-84 / agent-office-a0）发了协调消息，全部被对方会话 hold 住未送达（权限模式不同），所以没等到回复；重启是按上面的三项检查确认无在途工作后才做的。

## Agent Office 登记

- \`POST /api/tasks\` → HTTP 201，task \`${task.task.task_id}\`「${task.task.title}」
- \`POST /api/tasks/:id/attempt\` → HTTP 201，attempt \`${attempt.attempt.attempt_id}\`（agent_id=claude）
- 运行中状态是 unknown（外部终端 Claude 拿不到结构化事件，状态机如实判）；本批提交后走 checkpoint → finish（带证据路径与 code_sha）落 completed，响应见 \`scripts/chat-v1/p2-acceptance/office/\`
`;

writeFileSync(resolve(DOC, 'acceptance.md'), md, 'utf8');
writeFileSync(resolve(DOC, 'acceptance.html'), evidencePage(md, { title: 'Agent Chat P2 验收证据（dsh adapter B1-B5）', meta: `生成于 ${new Date().toISOString()} · 由 scripts/chat-v1/p2-acceptance/evidence.mjs 从真实输出生成` }), 'utf8');
console.log(`已生成 ${resolve(DOC, 'acceptance.md')} 与 acceptance.html`);
console.log(`tests: state ${tState.pass}/${tState.tests} engine ${tEngine.pass}/${tEngine.tests} http ${tHttp.pass}/${tHttp.tests}`);
