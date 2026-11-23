# Agent Chat P3 验收证据：SSE 流式输出（C1-C4）

- 日期：2026-11-23T21:11:32.366Z（验收开始 2026-11-23T21:11:03.471Z）
- 执行人：Claude（soda-office-ba 会话，飞书触发）
- 服务：`http://127.0.0.1:8090`（health={"ok":true,"autoloop":true,"build":"r73"}；运行实例启动于本批代码之后）
- 新端点：`GET /api/chat/turns/:turn_id/stream`（`text/event-stream`；每帧 `id: <seq>`；`retry: 1500`；每 15 秒一行心跳注释）
- 轮询接口保留：`GET /api/chat/threads/:id/messages`（未删，返回 thread / messages / turns / thread_status）
- 验收脚本：`scripts/chat-v1/p3-acceptance/run.mjs`，完整输出 `scripts/chat-v1/p3-acceptance/out/run.log`
- 验收对话：claude thread `th-a0e2746961`（C1-C3，真 Claude Code）；dsh 另有两个对话（C3-dsh / C4）
- Agent Office 登记：task `t-20261123211055-0cc0c6` / attempt `a-110b9f69-mwtrfwvq`

## 结论

| 项 | 内容 | 结果 |
|---|---|---|
| C1 | 订阅 stream 能收到 started → delta(多个) → completed | ✅ 7 条 delta，顺序正确，序号 1…13 连续 |
| C2 | delta 拼起来等于最终完整回复 | ✅ 307 字逐字相等；库内 chat_events 与 SSE id 是同一串 |
| C3 | 中途断开重连，按 seq 补发，内容不丢不重 | ✅ 断在 seq=9，重连只补 2 条，并集 1…11 无重复 |
| C3-dsh | 真 dsh：started 之后断开重连，后续全部补到 | ✅ 并集 1,2,3,4,5,6 = 库里全部事件 |
| C4 | 出错时收到 error 事件且 code 具体 | ✅ 两种真实出错都是 error 收尾，code / reason 具体 |
| 轮询 | 旧轮询接口保留 | ✅ |

验收 6/6 通过（脚本退出码 0）。心跳：✅ 挂起 16500ms 内收到 1 次心跳（第 1 次在 15003ms）（私有实例 + 假 CLI 的 `[hang]`，模型一直不吐字）。

## 事件协议

```
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
```

续订规则（引擎 `chat-engine.mjs` `subscribe()`）：**一个 seq，落库与推送是同一条**。订阅时同步做三步——
先发 snapshot（此刻状态 + 全文 + 已落库最大序号），再补发 seq 大于「对方已收到哪」的落库事件（没说收到哪就从头补发这一轮），
然后挂到实时流。排队中的轮次也能订阅（起跑后第一条就是 started/restoring）。

## C1 订阅 → started → delta(多个) → completed ✅

真 Claude Code。发送：「用三句话介绍一下 SSE（Server-Sent Events）是什么、和 WebSocket 比有什么不同。不要用工具。」

- Content-Type：`text/event-stream; charset=utf-8`，`retry: 1500`
- 7 条 delta；**首段增量在发送后 10713ms 到达，completed 在 13337ms**——增量先到、完成最后到，不是等全部结束才出现

事件序列：

```
snapshot → started → status → status → status → delta → status → delta → delta → delta → delta → delta → delta → completed
```

收到的原始帧（前 8 帧，data 截断到 260 字）：

```
event: snapshot
data: {"type":"snapshot","turn_id":"ct-0f11417384","at":"2026-11-23T21:11:03.789Z","status":"starting","text":"","event_seq":2,"replay_from":0,"resume":false,"error":null,"queued_ahead":0}

id: 1
event: started
data: {"provider":"claude","resume":false,"status":"starting","provider_session_id":null,"workspace":"E:\\DesktopProjects\\Soda Intelligence - AI Native Thinking\\Soda Office","mode":"discuss","attempt_id":"ca-ea45d00e66","queued_ms":114,"queued_ahead":0,"seq":1,"ty

id: 2
event: status
data: {"status":"starting","pid":32992,"cli_command":"claude","seq":2,"type":"status","turn_id":"ct-0f11417384","at":"2026-11-23T21:11:03.754Z"}

id: 3
event: status
data: {"seq":3,"type":"status","turn_id":"ct-0f11417384","at":"2026-11-23T21:11:04.467Z","status":"starting","provider_session_id":"5dee391d-521b-49d7-ae20-856db41f6e29","resumed":false}

id: 4
event: status
data: {"seq":4,"type":"status","turn_id":"ct-0f11417384","at":"2026-11-23T21:11:04.737Z","status":"starting","tools":["Glob","Grep","Read"],"model":"glm-5.4[1m]","permission_mode":"plan"}

id: 5
event: delta
data: {"seq":5,"type":"delta","turn_id":"ct-0f11417384","at":"2026-11-23T21:11:14.227Z","text":"S"}

id: 6
event: status
data: {"seq":6,"type":"status","turn_id":"ct-0f11417384","at":"2026-11-23T21:11:14.227Z","status":"running","label":null}

id: 7
event: delta
data: {"seq":7,"type":"delta","turn_id":"ct-0f11417384","at":"2026-11-23T21:11:14.474Z","text":"SE（Server-Sent Events）是基于 HTTP 长连接的服务器→客户端单向推送技术，浏览器用 `EventSource` 接收流式文本消息，断线自动重连、自带事件类型，实现简单。与 WebSocket 的核心区别是方向性：SSE 只能服务器推、客户端发数据仍需普通 HTTP 请求，且是纯文本协议；WebSocket 则是经
```

## C2 delta 拼起来 = 最终完整回复 ✅

- SSE 的 delta 依次拼接：307 字
- `GET /api/chat/turns/ct-0f11417384` 的 `assistant_message.content`：307 字
- 逐字相等：**是**
- 库里 `chat_events`（turn `ct-0f11417384`）：13 行，序号 1…13；SSE 收到的 `id` 也是 1…13（13 条）——**同一串序号**

| seq | type | payload（截断） |
|---|---|---|
| 1 | started | {"provider":"claude","resume":false,"status":"starting","pro |
| 2 | status | {"status":"starting","pid":32992,"cli_command":"claude"} |
| 3 | status | {"status":"starting","provider_session_id":"5dee391d-521b-49 |
| 4 | status | {"status":"starting","tools":["Glob","Grep","Read"],"model": |
| 5 | delta | {"text":"S"} |
| 6 | status | {"status":"running","label":null} |
| 7 | delta | {"text":"SE（Server-Sent Events）是基于 HTTP 长连接的服务器→客户端单向推送技术，浏览 |
| 8 | delta | {"text":"后的双向全双工协议，两端随时互发、支持二进制。因此 SSE 更"} |
| 9 | delta | {"text":"轻量、对代理/CDN/HTTP2 更友好"} |
| 10 | delta | {"text":"，适合资讯推送、进度通知、"} |
| 11 | delta | {"text":"大模型流式输出等\"只下不上\"的场景；WebSocket 适合即时通讯、协作编辑、游戏等需要客户端高 |
| 12 | delta | {"text":"上行的双向实时场景。"} |
| 13 | completed | {"turn_id":"ct-0f11417384","status":"completed","text_len":3 |

完整回复：

```
SSE（Server-Sent Events）是基于 HTTP 长连接的服务器→客户端单向推送技术，浏览器用 `EventSource` 接收流式文本消息，断线自动重连、自带事件类型，实现简单。与 WebSocket 的核心区别是方向性：SSE 只能服务器推、客户端发数据仍需普通 HTTP 请求，且是纯文本协议；WebSocket 则是经 `ws://` 升级握手后的双向全双工协议，两端随时互发、支持二进制。因此 SSE 更轻量、对代理/CDN/HTTP2 更友好，适合资讯推送、进度通知、大模型流式输出等"只下不上"的场景；WebSocket 适合即时通讯、协作编辑、游戏等需要客户端高频上行的双向实时场景。
```

## C3 中途断开，带 Last-Event-ID 重连 ✅

真 Claude Code 写八行小诗。收到 10 条（已含 4 条 delta）后客户端主动断开（AbortController，模拟网络中断），
断线 1.5 秒后带着 `Last-Event-ID: 9` 重连：

- 重连收到的 snapshot：`replay_from=9`，`event_seq=11`，`status=completed`
- 重连后补发的事件 id：10, 11（全部 > 9，没有一条是断开前已经收过的）
- 两次连接的序号并集：1…11，连续、无重复（共 11 条）
- 两段增量拼起来 75 字 = 库里完整回复 75 字，逐字相等：**是**

第一次连接收到的事件：

```
1  restoring
 2  status
 3  status
 4  status
 5  delta  "斜"
 6  status
 7  delta  "阳把天边染成蜜色 风携落叶掠过屋檐 雁声远远掠过山脊 炊烟缓缓融进暮"
 8  delta  "霭 薄雾漫过收割"
 9  delta  "后的田 凉意悄悄爬上窗棂 一盏灯火次"
```

重连后收到的事件：

```
10  delta  "第亮起 秋夜在虫鸣里渐渐深了"
11  completed
```

拼出来的完整回复：

```
斜阳把天边染成蜜色
风携落叶掠过屋檐
雁声远远掠过山脊
炊烟缓缓融进暮霭
薄雾漫过收割后的田
凉意悄悄爬上窗棂
一盏灯火次第亮起
秋夜在虫鸣里渐渐深了
```

### C3-dsh：真 dsh，started 之后断开重连 ✅

dsh 的正文是整段到达的（一步一条 text），所以断点选在 started 之后、正文之前：

- 第一次收到：snapshot → started → status（断在 seq=2）
- 重连补发：snapshot → status → delta → status → completed
- 并集 = 库里全部事件；最终回复：「我是 DeepSeek Harness 驱动的编码 AI 智能体，可以帮你写代码、查资料、读文件和处理工程任务。」

## C4 出错时 error 事件且 code 具体 ✅

都是在 8090 上真制造的：

| 情况 | 事件序列 | error.code | error.reason | error.status | error.text（截断） |
|---|---|---|---|---|---|
| 把 thread 的 provider_session_id 改成不存在的 ID，dsh 真的报 does not exist | snapshot → restoring → status → error | undefined | undefined | undefined |  |
| 建对话后把工作目录改成不存在的路径 | snapshot → started → error | undefined | undefined | undefined |  |

原始帧（data 截断）：

```
event: snapshot
data: {"type":"snapshot","turn_id":"ct-bdf0f97681","at":"2026-11-23T21:11:29.813Z","status":"restoring","text":"","event_seq":2,"replay_from":0,"resume":true,"error":null,"queued_ahead":0}

id: 1
event: restoring
data: {"provider":"dsh","resume":true,"status":"restoring","provider_session_id":"session-00000000-0000-4000-8000-000000000000","workspace":"E:\\DesktopProjects\\Soda Intelligence - AI Native Thinking\\Soda Office","mode":"discuss","attempt_id":"ca-3faa52363c","queued_ms":116,"queued_ahead":0,"seq":1,"type":"restoring","turn_id":"ct-b…

id: 2
event: status
data: {"status":"restoring","pid":33468,"cli_command":"\"C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd\" --profile headless --json --permission-mode read-only --approval-policy never --session-id session-00000000-0000-4000-8000-000000000000 -","seq":2,"type":"status","turn_id":"ct-bdf…

id: 3
event: error
data: {"seq":3,"type":"error","turn_id":"ct-bdf0f97681","at":"2026-11-23T21:11:32.044Z","status":"failed","text_len":0,"kind":"session_not_found","code":"session_not_found","reason":"session_not_found","label":"会话已丢失","message":"DSH 找不到会话 session-00000000-0000-4000-8000-000000000000：session \"session-00000000-0000-4000-8000-0000000000…

event: snapshot
data: {"type":"snapshot","turn_id":"ct-8e49c13056","at":"2026-11-23T21:11:32.362Z","status":"failed","text":"","event_seq":2,"replay_from":0,"resume":false,"error":{"kind":"cli_start_failed","code":"cli_start_failed","reason":"workspace_not_found","label":"Agent 启动失败","message":"工作目录不存在：E:/DesktopProjects/Soda Intelligence - AI Native…

id: 1
event: started
data: {"provider":"dsh","resume":false,"status":"starting","provider_session_id":null,"workspace":"E:/DesktopProjects/Soda Intelligence - AI Native Thinking/Soda Office/scripts/chat-v1/p3-acceptance/out/ws-1795468289511","mode":"discuss","attempt_id":"ca-f3789948cc","queued_ms":106,"queued_ahead":0,"seq":1,"type":"started","turn_id":"…

id: 2
event: error
data: {"turn_id":"ct-8e49c13056","status":"failed","text_len":0,"kind":"cli_start_failed","code":"cli_start_failed","reason":"workspace_not_found","label":"Agent 启动失败","message":"工作目录不存在：E:/DesktopProjects/Soda Intelligence - AI Native Thinking/Soda Office/scripts/chat-v1/p3-acceptance/out/ws-1795468289511","text":"工作目录不存在：E:/DesktopP…
```

## 库里的行（claude thread `th-a0e2746961`）

| turn_id | status | resume | started_at | ended_at |
|---|---|---|---|---|
| ct-0f11417384 | completed | 0 | 2026-11-23T21:11:03.653Z | 2026-11-23T21:11:16.765Z |
| ct-52906f6157 | completed | 1 | 2026-11-23T21:11:16.982Z | 2026-11-23T21:11:24.679Z |

全库计数：chat_threads=14，chat_messages=51，chat_turns=24，chat_events=151。

## 完整运行输出

```
服务 http://127.0.0.1:8090 health={"ok":true,"autoloop":true,"build":"r73"}
PASS  C1  订阅 stream 收到 started → delta(多个) → completed
      Content-Type=text/event-stream; charset=utf-8；retry=1500
      事件序列=snapshot → started → status → status → status → delta → status → delta → delta → …（共 14 条）
      共 7 条 delta；首段增量在发送后 10713ms 到达，completed 在 13337ms ——增量先到、完成最后到
PASS  C2  delta 拼起来等于最终完整回复；库里的 chat_events 与实时流是同一串序号
      拼接长度=307 字，库里助手消息长度=307 字，逐字相等=true
      开头：「SSE（Server-Sent Events）是基于 HTTP 长连接的服务器→客户端单向推送技术，浏览器用 `Even」
      库内事件序号 1…13（13 条）= SSE id 1…13（13 条）
PASS  C3  中途断开重连，按 seq 补发，内容不丢不重
      断开时已收到 9 条（最后 seq=9）；重连带 Last-Event-ID: 9
      重连后 snapshot.replay_from=9，补发 2 条，seq 10…11（全部 > 9）
      两边序号并集 1…11 连续无重复（共 11 条）
      两段增量拼起来 75 字 = 库里完整回复 75 字，逐字相等=true
PASS  C3-dsh  真 dsh：started 之后断开、带 Last-Event-ID 重连，后续事件全部补到、不重复
      第一次收到 snapshot → started → status（断在 seq=2）
      重连补发 snapshot → status → delta → status → completed
      并集 1,2,3,4,5,6 = 库里全部 6 条事件；最终回复=「我是 DeepSeek Harness 驱动的编码 AI 智能体，可以帮你写代码、查资料、读文件和处理工程任务。」
PASS  C4  出错时收到 error 事件且 code 具体
      [会话不存在] snapshot → restoring → status → error
        error: code=session_not_found reason=session_not_found status=failed text=「DSH 找不到会话 session-00000000-0000-4000-8000-000000000000：session "session-00000000-0000-4000-8000-000000000000" does not e」
      [工作目录没了] snapshot → started → error
        error: code=cli_start_failed reason=workspace_not_found status=failed text=「工作目录不存在：E:/DesktopProjects/Soda Intelligence - AI Native Thinking/Soda Office/scripts/chat-v1/p3-acceptance/out/ws-17954」
PASS  轮询保留  GET /api/chat/threads/:id/messages 仍在，返回 thread / messages / turns / thread_status
      thread=th-25271578a4 messages=2 turns=1 thread_status=failed

C1-C4：6/6 通过
```

## 本批改动

P3 的服务端代码在 P2 那次提交里已经带上（引擎单 seq 事件日志、SSE 路由、取消路由），本批是**用真 CLI 验收**并留证据：

- 引擎：每条事件只有一个 seq，先落库再推送，实时流与 `chat_events` 是同一串；增量 200ms / 1KB 攒批（同一批同一 seq）
- 路由：`GET /api/chat/turns/:id/stream`、`GET /api/chat/turns/:id`、`POST /api/chat/turns/:id/cancel`；`GET /api/chat/threads?agent_id=`、`GET /api/chat/threads/:id`
- 订阅：snapshot → 补发 → 实时 三步同步完成；排队中的轮次可订阅；Last-Event-ID / ?after_seq 续订；已收全的人重连只有快照
- 自动化：`test/chat-engine.test.js`（17/17）、`test/chat-http.test.js`（14/14，含真实 server.js 上的断线重连 / 404 / 405 / 心跳之外的协议细节）

## Agent Office 登记

- `POST /api/tasks` → 201，task `t-20261123211055-0cc0c6`「Agent Chat P3：SSE 流式输出（真 CLI 验收 C1-C4）」
- `POST /api/tasks/:id/attempt` → 201，attempt `a-110b9f69-mwtrfwvq`
- checkpoint / finish 的响应在 `scripts/chat-v1/p3-acceptance/office/`（提交后执行，finish 带 evidence 与 code_sha）
