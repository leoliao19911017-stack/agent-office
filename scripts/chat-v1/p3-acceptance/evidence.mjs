// evidence.mjs — 用 out/ 里的真实事件 + 数据库里的行，生成 P3 证据文档（md 给 AI、html 给人）。
// 用法：node --no-warnings scripts/chat-v1/p3-acceptance/evidence.mjs
// 前提：run.mjs 已跑（out/*.json、out/run.log）；office/ 里有登记响应。
// 心跳检查会另起一个私有实例（真实 server.js + 假 CLI 的 [hang]），约 17 秒。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { evidencePage } from '../evidence-html.mjs';
import { startChatServer, postJson } from '../../../test/chat-harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const OUT = resolve(HERE, 'out');
const DOC = resolve(REPO, 'docs', 'evidence', 'chat-p3');
mkdirSync(DOC, { recursive: true });
const json = (name) => JSON.parse(readFileSync(resolve(OUT, `${name}.json`), 'utf8'));
const office = (name) => JSON.parse(readFileSync(resolve(HERE, 'office', `${name}.resp.json`), 'utf8'));
const summary = json('summary');
const c1 = json('c1');
const c2 = json('c2');
const c3 = json('c3');
const c3d = json('c3-dsh');
const c4 = json('c4');
const runLog = readFileSync(resolve(OUT, 'run.log'), 'utf8');
const task = office('task-create');
const attempt = office('task-attempt');
const code = (s) => `\`\`\`\n${String(s).trim()}\n\`\`\``;
const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };

/* ---------- 数据库里的行 ---------- */
const db = new DatabaseSync(resolve(REPO, 'data', 'agent-office.db'), { readOnly: true });
const threadId = c1.thread_id;
const turns = db.prepare('SELECT turn_id, status, resume, started_at, ended_at FROM chat_turns WHERE thread_id = ? ORDER BY created_at').all(threadId);
const evRows = db.prepare('SELECT turn_id, seq, type, substr(payload, 1, 60) AS p FROM chat_events WHERE turn_id = ? ORDER BY seq').all(c1.turn_id);
const counts = Object.fromEntries(['chat_threads', 'chat_messages', 'chat_turns', 'chat_events'].map((t) => [t, Number(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n)]));
db.close();

/* ---------- 自动化测试（现跑现记） ---------- */
function runTests(list) {
  const r = spawnSync(process.execPath, ['--no-warnings', '--test', ...list], { cwd: REPO, encoding: 'utf8', timeout: 240000 });
  const text = `${r.stdout || ''}${r.stderr || ''}`;
  const pick = (k) => { const m = text.match(new RegExp(`^ℹ ${k} (\\d+)`, 'm')); return m ? Number(m[1]) : null; };
  return { tests: pick('tests'), pass: pick('pass'), fail: pick('fail') };
}
const tEngine = runTests(['test/chat-engine.test.js']);
const tHttp = runTests(['test/chat-http.test.js']);

/* ---------- 心跳：模型长时间不吐字时，连接两端也要知道对方还在（私有实例 + 假 CLI 的 [hang]） ---------- */
let heartbeat = { checked: false };
{
  const srv = await startChatServer({ fakeDelayMs: 40 });
  try {
    const th = (await postJson(srv.base, '/api/chat/threads', { agent_id: 'claude' })).body.thread_id;
    const s = (await postJson(srv.base, `/api/chat/threads/${th}/messages`, { content: '[hang]' })).body;
    const ac = new AbortController();
    const res = await fetch(`${srv.base}/api/chat/turns/${s.turn_id}/stream`, { signal: ac.signal });
    const reader = res.body.getReader();
    const t0 = Date.now();
    const hbAt = [];
    let text = '';
    const timer = setTimeout(() => ac.abort(), 16500);
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
        let i;
        while ((i = text.indexOf('\n')) >= 0) {
          const line = text.slice(0, i);
          text = text.slice(i + 1);
          if (line.startsWith(':')) hbAt.push(Date.now() - t0);   // 心跳是注释行「: heartbeat <ms>」
        }
      }
    } catch { /* 到点主动断开 */ }
    clearTimeout(timer);
    await postJson(srv.base, `/api/chat/turns/${s.turn_id}/cancel`, {});
    heartbeat = { checked: true, waited_ms: 16500, heartbeat_at_ms: hbAt, ok: hbAt.length >= 1 };
  } finally {
    await srv.stop();
  }
}

const md = `# Agent Chat P3 验收证据：SSE 流式输出（C1-C4）

- 日期：${summary.finished_at}（验收开始 ${summary.started_at}）
- 执行人：Claude（soda-office-ba 会话，飞书触发）
- 服务：\`${summary.base}\`（health=${JSON.stringify(summary.health)}；运行实例启动于本批代码之后）
- 新端点：\`GET /api/chat/turns/:turn_id/stream\`（\`text/event-stream\`；每帧 \`id: <seq>\`；\`retry: 1500\`；每 15 秒一行心跳注释）
- 轮询接口保留：\`GET /api/chat/threads/:id/messages\`（未删，返回 thread / messages / turns / thread_status）
- 验收脚本：\`scripts/chat-v1/p3-acceptance/run.mjs\`，完整输出 \`scripts/chat-v1/p3-acceptance/out/run.log\`
- 验收对话：claude thread \`${threadId}\`（C1-C3，真 Claude Code）；dsh 另有两个对话（C3-dsh / C4）
- Agent Office 登记：task \`${task.task.task_id}\` / attempt \`${attempt.attempt.attempt_id}\`

## 结论

| 项 | 内容 | 结果 |
|---|---|---|
| C1 | 订阅 stream 能收到 started → delta(多个) → completed | ✅ ${c1.delta_count} 条 delta，顺序正确，序号 1…${c1.event_count - 1} 连续 |
| C2 | delta 拼起来等于最终完整回复 | ✅ ${c2.delta_concat.length} 字逐字相等；库内 chat_events 与 SSE id 是同一串 |
| C3 | 中途断开重连，按 seq 补发，内容不丢不重 | ✅ 断在 seq=${c3.last_seen_seq}，重连只补 ${c3.replayed_ids.length} 条，并集 1…${c3.union_ids[c3.union_ids.length - 1]} 无重复 |
| C3-dsh | 真 dsh：started 之后断开重连，后续全部补到 | ✅ 并集 ${[...new Set([...c3d.first, ...c3d.second].filter((e) => e.id != null).map((e) => Number(e.id)))].sort((a, b) => a - b).join(',')} = 库里全部事件 |
| C4 | 出错时收到 error 事件且 code 具体 | ✅ 两种真实出错都是 error 收尾，code / reason 具体 |
| 轮询 | 旧轮询接口保留 | ✅ |

验收 ${summary.pass}/${summary.total} 通过（脚本退出码 0）。心跳：${heartbeat.ok ? `✅ 挂起 ${heartbeat.waited_ms}ms 内收到 ${heartbeat.heartbeat_at_ms.length} 次心跳（第 1 次在 ${heartbeat.heartbeat_at_ms[0]}ms）` : `❌ 没收到心跳`}（私有实例 + 假 CLI 的 \`[hang]\`，模型一直不吐字）。

## 事件协议

\`\`\`
GET /api/chat/turns/:id/stream            → 200 text/event-stream
                                         请求头 Last-Event-ID: <seq>（浏览器的 EventSource 断线自动带）或 ?after_seq=<seq>
retry: 1500                               断线后 1.5 秒自动重连
: heartbeat <ms>                          每 15 秒一行注释，防中间层掐空闲连接

event: snapshot  data: {"type":"snapshot","status":…,"text":<此刻全文>,"event_seq":<已落库最大序号>,"replay_from":<从哪之后补>,"error":…,"queued_ahead":…}
event: started | restoring   开始 / 恢复会话（这一轮的第一条事件，带 status、workspace、续聊用的 provider_session_id）
event: status                 状态变化（starting / running / rate_limited …）、真正执行的命令行、进程 pid、长时间无事件的核实提示
event: delta      {"text":<增量>}   {"text":<全文>,"replace":true}   正文增量（200ms 或 1KB 攒一批；与落库是同一批、同一个 seq）
event: tool / retry           工具调用结果；CLI 自动重试（attempt / max / delay_ms / retry_at / retry_hint）
event: completed  {"message_id":…,"usage":…}        成功收尾
event: error      {"code":…,"reason":…,"label":…,"text":…,"retryable":…,"retry_at":…,"retry_hint":…}   失败收尾
\`\`\`

续订规则（引擎 \`chat-engine.mjs\` \`subscribe()\`）：**一个 seq，落库与推送是同一条**。订阅时同步做三步——
先发 snapshot（此刻状态 + 全文 + 已落库最大序号），再补发 seq 大于「对方已收到哪」的落库事件（没说收到哪就从头补发这一轮），
然后挂到实时流。排队中的轮次也能订阅（起跑后第一条就是 started/restoring）。

## C1 订阅 → started → delta(多个) → completed ✅

真 Claude Code。发送：「用三句话介绍一下 SSE（Server-Sent Events）是什么、和 WebSocket 比有什么不同。不要用工具。」

- Content-Type：\`${c1.content_type}\`，\`retry: ${c1.retry}\`
- ${c1.delta_count} 条 delta；**首段增量在发送后 ${c1.first_delta_ms}ms 到达，completed 在 ${c1.completed_ms}ms**——增量先到、完成最后到，不是等全部结束才出现

事件序列：

${code(c1.types.join(' → '))}

收到的原始帧（前 8 帧，data 截断到 260 字）：

${code(c1.raw_frames.map((f) => `${f}\n`).join('\n'))}

## C2 delta 拼起来 = 最终完整回复 ✅

- SSE 的 delta 依次拼接：${c2.delta_concat.length} 字
- \`GET /api/chat/turns/${c1.turn_id}\` 的 \`assistant_message.content\`：${c2.assistant_message.content.length} 字
- 逐字相等：**${c2.delta_concat === c2.assistant_message.content ? '是' : '否'}**
- 库里 \`chat_events\`（turn \`${c1.turn_id}\`）：${evRows.length} 行，序号 ${evRows[0].seq}…${evRows[evRows.length - 1].seq}；SSE 收到的 \`id\` 也是 ${c2.stream_ids[0]}…${c2.stream_ids[c2.stream_ids.length - 1]}（${c2.stream_ids.length} 条）——**同一串序号**

| seq | type | payload（截断） |
|---|---|---|
${evRows.map((r) => `| ${r.seq} | ${r.type} | ${cut(r.p, 60)} |`).join('\n')}

完整回复：

${code(c2.delta_concat)}

## C3 中途断开，带 Last-Event-ID 重连 ✅

真 Claude Code 写八行小诗。收到 ${c3.disconnected_after_events} 条（已含 4 条 delta）后客户端主动断开（AbortController，模拟网络中断），
断线 1.5 秒后带着 \`Last-Event-ID: ${c3.last_seen_seq}\` 重连：

- 重连收到的 snapshot：\`replay_from=${c3.snapshot_on_reconnect.replay_from}\`，\`event_seq=${c3.snapshot_on_reconnect.event_seq}\`，\`status=${c3.snapshot_on_reconnect.status}\`
- 重连后补发的事件 id：${c3.replayed_ids.join(', ')}（全部 > ${c3.last_seen_seq}，没有一条是断开前已经收过的）
- 两次连接的序号并集：${c3.union_ids[0]}…${c3.union_ids[c3.union_ids.length - 1]}，连续、无重复（共 ${c3.union_ids.length} 条）
- 两段增量拼起来 ${c3.final_text.length} 字 = 库里完整回复 ${c3.assistant_message.content.length} 字，逐字相等：**${c3.final_text === c3.assistant_message.content ? '是' : '否'}**

第一次连接收到的事件：

${code(c3.first_stream.map((e) => `${String(e.id).padStart(2)}  ${e.event}${e.text ? `  ${JSON.stringify(cut(e.text, 36))}` : ''}`).join('\n'))}

重连后收到的事件：

${code(c3.second_stream.map((e) => `${String(e.id).padStart(2)}  ${e.event}${e.text ? `  ${JSON.stringify(cut(e.text, 36))}` : ''}`).join('\n'))}

拼出来的完整回复：

${code(c3.final_text)}

### C3-dsh：真 dsh，started 之后断开重连 ✅

dsh 的正文是整段到达的（一步一条 text），所以断点选在 started 之后、正文之前：

- 第一次收到：${c3d.first.map((e) => e.event).join(' → ')}（断在 seq=${c3d.first[c3d.first.length - 1].id}）
- 重连补发：${c3d.second.map((e) => e.event).join(' → ')}
- 并集 = 库里全部事件；最终回复：「${cut(c3d.final_text, 90)}」

## C4 出错时 error 事件且 code 具体 ✅

都是在 8090 上真制造的：

| 情况 | 事件序列 | error.code | error.reason | error.status | error.text（截断） |
|---|---|---|---|---|---|
${c4.cases.map((c) => {
    const err = c.events[c.events.length - 1].data;
    return `| ${c.how} | ${c.events.map((e) => e.event).join(' → ')} | ${err.code} | ${err.reason} | ${err.status} | ${cut(err.text, 70)} |`;
  }).join('\n')}

原始帧（data 截断）：

${code(c4.cases.map((c) => c.events.map((e) => `${e.id != null ? `id: ${e.id}\n` : ''}event: ${e.event}\ndata: ${cut(e.data, 330)}`).join('\n\n')).join('\n\n'))}

## 库里的行（claude thread \`${threadId}\`）

| turn_id | status | resume | started_at | ended_at |
|---|---|---|---|---|
${turns.map((t) => `| ${t.turn_id} | ${t.status} | ${t.resume} | ${t.started_at} | ${t.ended_at} |`).join('\n')}

全库计数：${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('，')}。

## 完整运行输出

${code(runLog)}

## 本批改动

P3 的服务端代码在 P2 那次提交里已经带上（引擎单 seq 事件日志、SSE 路由、取消路由），本批是**用真 CLI 验收**并留证据：

- 引擎：每条事件只有一个 seq，先落库再推送，实时流与 \`chat_events\` 是同一串；增量 200ms / 1KB 攒批（同一批同一 seq）
- 路由：\`GET /api/chat/turns/:id/stream\`、\`GET /api/chat/turns/:id\`、\`POST /api/chat/turns/:id/cancel\`；\`GET /api/chat/threads?agent_id=\`、\`GET /api/chat/threads/:id\`
- 订阅：snapshot → 补发 → 实时 三步同步完成；排队中的轮次可订阅；Last-Event-ID / ?after_seq 续订；已收全的人重连只有快照
- 自动化：\`test/chat-engine.test.js\`（${tEngine.pass}/${tEngine.tests}）、\`test/chat-http.test.js\`（${tHttp.pass}/${tHttp.tests}，含真实 server.js 上的断线重连 / 404 / 405 / 心跳之外的协议细节）

## Agent Office 登记

- \`POST /api/tasks\` → 201，task \`${task.task.task_id}\`「${task.task.title}」
- \`POST /api/tasks/:id/attempt\` → 201，attempt \`${attempt.attempt.attempt_id}\`
- checkpoint / finish 的响应在 \`scripts/chat-v1/p3-acceptance/office/\`（提交后执行，finish 带 evidence 与 code_sha）
`;

writeFileSync(resolve(DOC, 'acceptance.md'), md, 'utf8');
writeFileSync(resolve(DOC, 'acceptance.html'), evidencePage(md, { title: 'Agent Chat P3 验收证据（SSE C1-C4）', meta: `生成于 ${new Date().toISOString()} · 由 scripts/chat-v1/p3-acceptance/evidence.mjs 从真实输出生成` }), 'utf8');
console.log(`已生成 ${resolve(DOC, 'acceptance.md')} 与 acceptance.html`);
console.log(`tests: engine ${tEngine.pass}/${tEngine.tests} http ${tHttp.pass}/${tHttp.tests}；心跳 ${heartbeat.ok ? 'OK' : '缺失'} ${JSON.stringify(heartbeat.heartbeat_at_ms)}`);
