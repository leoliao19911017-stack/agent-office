# Agent Chat P2 验收证据：dsh adapter（B1-B5）

- 日期：2026-11-23T21:03:33.042Z（验收开始 2026-11-23T21:03:00.289Z）
- 执行人：Claude（soda-office-ba 会话，飞书触发）
- 服务：`http://127.0.0.1:8090`（重启后载入本批代码；health={"ok":true,"autoloop":true,"build":"r73"}）
- dsh：`C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd`（0.2.2-rc.5，完整路径；不在 PATH）
- 验收脚本：`scripts/chat-v1/p2-acceptance/run.mjs`，完整输出 `scripts/chat-v1/p2-acceptance/out/run.log`，逐项 JSON 在同目录
- 验收对话：thread `th-5c99928c3e`（B1-B4，四轮真 dsh）
- Agent Office 登记：task `t-20261123210150-6256ee` / attempt `a-440ca07a-mwtr484c`（checkpoint、finish 见本批提交后的记录）

## 结论

| 项 | 内容 | 结果 |
|---|---|---|
| B1 | 建 dsh thread，发一条消息有真实回复 | ✅ 通过 |
| B2 | 连发 3 条，第 3 条能反映第 1 条内容 | ✅ 通过 |
| B3 | 问「我第一句说了什么」能答对 | ✅ 通过 |
| B4 | session-id 正确保存，第 2 条起走续聊 | ✅ 通过 |
| B5 | dsh 起不来时状态是 failed 且原因具体 | ✅ 四种情况全过 |

验收 8/8 通过（脚本退出码 0）。

## ⚠️ 与任务书口径不一致的一处：续聊参数

任务书写「续聊用 --resume <session-id>，不是 --session-id」。**对 dsh 不成立**，两种都真跑了：

| 参数 | 真实命令（节选） | dsh 的真实结果 |
|---|---|---|
| `--resume` | --resume session-b54d3eab-bdc6-4df6-aa44-a4330bf45501 | ❌ exit 1，stderr/stdout 报「unknown option '--resume'」，引擎归为 `cli_error` |
| `--session-id` | --session-id session-6140b91e-bada-4418-98ed-05f78b6b7927 | ✅ exit 0，答出口令「青禾-9241」 |

依据：dsh 自带 help（`dsh --profile headless --help`）只列了 `--session-id <id>`「adopt the persisted Session with this id」，
示例就是 `--session-id session-… "continue"   resume an existing Session`；`--resume` 是 `dsh tui` 的参数，也是 Claude Code 的参数。
所以 **dsh adapter 用 `--session-id`、claude adapter 用 `--resume`**，各自按实测。B4 的「第 2 条走续聊」按这个口径验收。
复现：`node scripts/chat-v1/p2-acceptance/probe-resume-flag.mjs resume` 与 `… session-id`。

```
$ dsh.cmd --profile headless --help
Options:
  --json                      write newline-delimited run events to stdout instead of the final message
  --session-id <id>           adopt the persisted Session with this id; an unknown id is an error
  --permission-mode <preset>  select a configured permission preset for this task, including on resume
  --approval-policy <policy>  set approval behavior after selecting the permission preset (choices: "ask", "never")
  --add-dir <path>            allow an additional physical absolute directory under workspace-write (repeatable)

Examples:
  dsh --profile headless --session-id session-… "continue"   resume an existing Session
```

## B1 建 dsh thread，发一条有真实回复 ✅

- `POST /api/chat/threads {"agent_id":"dsh"}` → HTTP 201，thread `th-5c99928c3e`
- 发送：「口令是：青禾-9241。它只是这次对话里的口令，不要写进任何文件。现在只回复两个字：收到。」
- 轮次 `ct-a7a6c8e865`：status=**completed**（界面 completed），3087ms
- dsh 回复原文：「收到。」

这一轮的事件（`GET /api/chat/turns/ct-a7a6c8e865`；序号就是 SSE 的 `id`）：

```
> GET /api/chat/turns/ct-a7a6c8e865
 1  started status=starting
 2  status status=starting  "C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd" --profile headless --json --permission-mode read-on…
 3  status status=starting
 4  delta
 5  status status=running
 6  completed status=completed
```

## B2 连发 3 条，第 3 条反映第 1 条 ✅

| 轮 | 发送 | dsh 回复（原文节选） | 状态 |
|---|---|---|---|
| 第 2 条 | 第二句：用一句话介绍你自己，不要用工具。 | 我是 DeepSeek Harness 驱动的编程智能体，负责在你的项目里读代码、改代码、排查问题并完成交付任务。 | completed |
| 第 3 条 | 第三句：我在这次对话最开始告诉过你一个口令。请原样复述那个口令，只回复口令本身。 | **青禾-9241** | completed |

第 3 条只回了口令本身 `青禾-9241`——第 1 条告诉它的内容，隔了一条消息仍然记得。

## B3 问「我第一句说了什么」 ✅

发送：「我第一句说了什么？请一字不差地引用原文。」

dsh 回复原文：

```
原文：

口令是：青禾-9241。它只是这次对话里的口令，不要写进任何文件。现在只回复两个字：收到。
```

第一句原文（逐字核对，去掉标点后完全一致）：

```
口令是：青禾-9241。它只是这次对话里的口令，不要写进任何文件。现在只回复两个字：收到。
```

## B4 session-id 保存，第 2 条起走续聊 ✅

- `chat_threads.provider_session_id` = `session-f9f16578-e0e8-49c1-876c-89aa6a58bfc4`（首轮 dsh 自己给的 `session-…`，引擎回填）

首轮的命令行（没有续聊参数）：

```
"C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd" --profile headless --json --permission-mode read-only --approval-policy never -
```

第 2/3/4 条的命令行（都带 `--session-id <同一个真实 ID>`）：

```
"C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd" --profile headless --json --permission-mode read-only --approval-policy never --session-id session-f9f16578-e0e8-49c1-876c-89aa6a58bfc4 -
```

数据库 `chat_turns`（thread `th-5c99928c3e`，按建轮先后）：

| turn_id | status | resume | started_at | ended_at | 事件 |
|---|---|---|---|---|---|
| ct-a7a6c8e865 | completed | 0 | 2026-11-23T21:03:00.453Z | 2026-11-23T21:03:03.442Z | started×1 status×3 delta×1 completed×1 |
| ct-020671b94c | completed | 1 | 2026-11-23T21:03:03.752Z | 2026-11-23T21:03:07.474Z | restoring×1 status×3 delta×1 completed×1 |
| ct-f6627c2a21 | completed | 1 | 2026-11-23T21:03:08.092Z | 2026-11-23T21:03:12.156Z | restoring×1 status×3 delta×1 completed×1 |
| ct-c70b17ff45 | completed | 1 | 2026-11-23T21:03:12.391Z | 2026-11-23T21:03:16.304Z | restoring×1 status×3 delta×1 completed×1 |

`chat_messages`（同 thread）：

| seq | role | status | turn_id | content |
|---|---|---|---|---|
| 1 | user | sent | ct-a7a6c8e865 | 口令是：青禾-9241。它只是这次对话里的口令，不要写进任何文件。现在只回复两个字：收到。 |
| 2 | assistant | complete | ct-a7a6c8e865 | 收到。 |
| 3 | user | sent | ct-020671b94c | 第二句：用一句话介绍你自己，不要用工具。 |
| 4 | assistant | complete | ct-020671b94c | 我是 DeepSeek Harness 驱动的编程智能体，负责在你的项目里读代码、改代码、排查问题并完成交付任务。 |
| 5 | user | sent | ct-f6627c2a21 | 第三句：我在这次对话最开始告诉过你一个口令。请原样复述那个口令，只回复口令本身。 |
| 6 | assistant | complete | ct-f6627c2a21 | 青禾-9241 |
| 7 | user | sent | ct-c70b17ff45 | 我第一句说了什么？请一字不差地引用原文。 |
| 8 | assistant | complete | ct-c70b17ff45 | 原文： 口令是：青禾-9241。它只是这次对话里的口令，不要写进任何文件。现在只回复两个字：收到。 |

全库计数：chat_threads=10，chat_messages=40，chat_turns=19，chat_events=116。

## B5 dsh 起不来 → failed，原因具体 ✅

四种情况都是真制造的（不是 mock）。轮次终态一律 `failed`，`error.code` 是错误大类、`error.reason` 是细原因，`error.message` 是给用户看的那句话。

| 情况 | 怎么制造的 | turn.status | error.code | error.reason | 用户消息 | 助手消息 |
|---|---|---|---|---|---|---|
| 会话不存在 | 8090：把 thread 的 provider_session_id 改成不存在的 ID 再发消息，dsh 真的报 does not exist | failed | session_not_found | session_not_found | failed | failed |
| 工作目录没了 | 8090：建对话时目录在，发消息前把目录删了 | failed | cli_start_failed | workspace_not_found | failed | failed |
| CLI 路径错 | 私有实例（真实 server.js + 临时库），DSH_BIN=`C:/nope/never/installed/dsh.cmd` | failed | cli_start_failed | cli_path_missing | failed | failed |
| 命令找不到 | 私有实例，DSH_BIN=`definitely-not-a-dsh-binary-xyz.cmd` | failed | cli_start_failed | cli_not_found | failed | failed |

给用户看的原因（`error.message` 原文）：

```
[会话不存在]  DSH 找不到会话 session-00000000-0000-4000-8000-000000000000：session "session-00000000-0000-4000-8000-000000000000" does not exist; omit --session-id to start a new Session
[工作目录没了] 工作目录不存在：E:/DesktopProjects/Soda Intelligence - AI Native Thinking/Soda Office/scripts/chat-v1/p2-acceptance/out/ws-1795467799191
[CLI 路径错]   找不到 CLI：C:/nope/never/installed/dsh.cmd 这个路径上没有文件（路径写错，或程序被卸载 / 移走了）
[命令找不到]   找不到命令 definitely-not-a-dsh-binary-xyz.cmd：系统找不到这个命令（不在 PATH 里，或名字写错了）
```

「CLI 路径错」那一轮通过 HTTP 看到的样子（界面五态 display_status=failed / display_label=Agent 启动失败）：

```
> GET /api/chat/turns/ct-22a0ddcdd4
{"status":"failed","status_label":"Agent 启动失败","display_status":"failed","display_label":"Agent 启动失败","error":{"kind":"cli_start_failed","code":"cli_start_failed","reason":"cli_path_missing","label":"Agent 启动失败","message":"找不到 CLI：C:/nope/never/installed/dsh.cmd 这个路径上没有文件（路径写错，或程序被卸载 / 移走了）","text":"找不到 CLI：C:/nope/never/installed/dsh.cmd 这个路径上没有文件（路径写错，或程序被卸载 / 移走了）","retryable":true,"api_error_status":null,"retry_at":null,"retry_hint":null}}

> 对话状态 thread_status
{"status":"failed","error_kind":"cli_start_failed","reason":"找不到 CLI：C:/nope/never/installed/dsh.cmd 这个路径上没有文件（路径写错，或程序被卸载 / 移走了）","retry_hint":null,"retry_at":null,"evidence_source":"chat_turns","observed_at":"2026-11-23T21:03:19.720Z","turn_id":"ct-22a0ddcdd4","queued":0,"active_turn_id":null}
```

说明：
- 「路径错 / 命令找不到」不能在 8090 上制造（要改 DSH_BIN），所以另起了一个真实的 `web/server.js` 子进程 + 临时数据库（`test/chat-harness.mjs`），走的是同一段代码。
- P1 的 A7 当时落的是 `interrupted`；本批把「没跑成」和「跑着被切断」分开：前者（起不来 / 没凭据 / 认证不过 / 会话丢了 / CLI 明确报错）落 **failed**，后者（崩溃 / 超时 / 取消 / 服务重启 / 轮数上限）落 interrupted。

## 完整运行输出

```
服务 http://127.0.0.1:8090 health={"ok":true,"autoloop":true,"build":"r73"}
dsh=C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd
PASS  B1  建 dsh thread，发一条消息有真实回复
      thread=th-5c99928c3e turn=ct-a7a6c8e865 status=completed（3087ms） 回复=「收到。」
PASS  B2  连发 3 条，第 3 条能反映第 1 条内容
      第 2 条回复=「我是 DeepSeek Harness 驱动的编程智能体，负责在你的项目里读代码、改代码、排查问题并完成交付任务。」
      第 3 条回复=「青禾-9241」（期望含口令 青禾-9241）
PASS  B3  问「我第一句说了什么」能答对
      回复=「原文： 口令是：青禾-9241。它只是这次对话里的口令，不要写进任何文件。现在只回复两个字：收到。」
PASS  B4  session-id 正确保存，第 2 条起走续聊
      provider_session_id=session-f9f16578-e0e8-49c1-876c-89aa6a58bfc4
      首轮命令=（无续聊参数）
      第 2/3/4 条命令=--session-id session-f9f16578-e0e8-49c1-876c-89aa6a58bfc4
      chat_turns.resume=1,1,1,0（首轮 0，其余 1）
PASS  B5a  dsh 报会话不存在 → failed，带 dsh 的原话
      status=failed code=session_not_found
      message=「DSH 找不到会话 session-00000000-0000-4000-8000-000000000000：session "session-00000000-0000-4000-8000-000000000000" does not exist; omit --session-id to start a new Session」
      用户消息=failed 助手消息=failed
PASS  B5b  工作目录没了 → failed，说清是哪个目录，没去起进程
      status=failed reason=workspace_not_found
      message=「工作目录不存在：E:/DesktopProjects/Soda Intelligence - AI Native Thinking/Soda Office/scripts/chat-v1/p2-acceptance/out/ws-1795467799191」 用户消息=failed
PASS  B5c-cli_path_missing  DSH_BIN=C:/nope/never/installed/dsh.cmd
      status=failed（界面 failed/Agent 启动失败） code=cli_start_failed reason=cli_path_missing
      message=「找不到 CLI：C:/nope/never/installed/dsh.cmd 这个路径上没有文件（路径写错，或程序被卸载 / 移走了）」
      用户消息=failed 助手消息=failed 对话状态=failed
PASS  B5c-cli_not_found  DSH_BIN=definitely-not-a-dsh-binary-xyz.cmd
      status=failed（界面 failed/Agent 启动失败） code=cli_start_failed reason=cli_not_found
      message=「找不到命令 definitely-not-a-dsh-binary-xyz.cmd：系统找不到这个命令（不在 PATH 里，或名字写错了）」
      用户消息=failed 助手消息=failed 对话状态=failed
不能用  flag-resume  续聊参数 --resume：能不能接上上一句
      命令=--resume session-b54d3eab-bdc6-4df6-aa44-a4330bf45501
      kind=cli_error exit=1 回复=「」 报错=「unknown option '--resume'」
能用  flag-session-id  续聊参数 --session-id：能不能接上上一句
      命令=--session-id session-6140b91e-bada-4418-98ed-05f78b6b7927
      kind=completed exit=0 回复=「青禾-9241」

验收 B1-B5：8/8 通过
续聊参数实测：--resume 不能续；--session-id 能续
结论：dsh headless 的续聊参数是 --session-id <真实 session-id>；--resume 是 Claude Code 的参数，dsh 不认（unknown option，exit 1）
```

## 本批改动

- `web/chat/adapters/dsh-chat.mjs`：续聊参数定为 `--session-id`（实测）；起进程前先查 bin 路径 / 工作目录；启动失败带 `reason`（cli_path_missing / cli_not_found / cli_not_executable / permission_denied / workspace_not_found / dll_init_failed / start_error）；留证真正执行的命令行；额度错误解析重置时间
- `web/chat/adapters/claude-chat.mjs`：同一套启动失败归因；记录 CLI 自动重试的次数与间隔；支持 `CHAT_CLAUDE_SETTINGS` 追加 `--settings`（换网关 / 对照实验）
- `web/chat/proc.mjs`：`preflightBin` / `explainStartFailure`（认 Node 的 err.code、cmd.exe 的中英文报错、Windows NTSTATUS 退出码）
- `web/chat/chat-state.mjs`：加 `failed` 终态与 FAILED_KINDS / NOT_DELIVERED_KINDS；界面五态 `displayStatusOf`；`extractResetAt` / `retryHint`；`isTurnActive`
- `web/chat/chat-engine.mjs`：事件序号改为「一个 seq，落库与推送同一条」；增量攒批同 seq；订阅支持排队中的轮次与 Last-Event-ID 续订；结局里带的 session 也保存；工作目录不存在不去起进程（这部分是 P3 的地基，P2 一并带了）
- `web/chat/chat-db.mjs`：`queuedAhead` / `lastChatEvent`；限流重试中的轮次算在进行中；`threadStatusOf` 带重试提示
- `web/api-chat.mjs` / `web/server-api.mjs`：`/api/chat/...` 整体挂载；加对话列表 / 详情 / 轮次详情 / SSE / 取消路由（P3 的路由随本批代码一起上线，P3 再验收）
- `web/api-tasks.mjs` + `web/lib/events.mjs`：**新增 `POST /api/tasks/:id/finish`**（之前并不存在，见下）
- `web/server.js`：SIGINT 时收掉在跑的聊天轮次
- 测试：`test/chat-state.test.js`（11/11）、`test/chat-engine.test.js`（17/17）、`test/chat-http.test.js`（14/14，真实 server.js + 假 CLI，不联网不花额度）；夹具 `test/chat-harness.mjs`、`test/fixtures/chat-fake-{claude,dsh}.mjs`

## 关于 `POST /api/tasks/:id/finish`

任务要求用它把每批登记成 completed，但**仓库里原本没有这个端点**（只有 attempt / checkpoint / handoff），P1 那条所以停在 unknown。
本批补上了：它不直接写 completed（状态机硬规矩「completed 必须绑定验收通过」），而是做三件事——把执行实例正常结束（completed/done）、
记一条**必须带证据**的 `acceptance_passed`（没有 evidence 直接 400 EVIDENCE_REQUIRED）、让状态机自己算出 completed。
带 `command` 时证据来源记 verifier（脚本验的），否则记 user（人工验收）。

## 过程中出的事（如实记）

- 第一次重启 8090 时，重启脚本的 PowerShell 引号写错，旧实例杀掉后新实例没起来，**8090 中断了约 2 分钟**；随后手工拉起，
  脚本改成「启动命令落 .ps1 文件再执行」并在 8093 上验证过（255ms 就绪）。重启前脚本会查：在跑的聊天轮次、活着的目标执行实例、同机其它带本仓库路径的 headless Claude 会话，任何一项不干净就拒绝重启。
- 给三个并行会话（engvm-b1 / agent-office-84 / agent-office-a0）发了协调消息，全部被对方会话 hold 住未送达（权限模式不同），所以没等到回复；重启是按上面的三项检查确认无在途工作后才做的。

## Agent Office 登记

- `POST /api/tasks` → HTTP 201，task `t-20261123210150-6256ee`「Agent Chat P2：dsh adapter（真 dsh 多轮续聊 + 起不来时原因具体）」
- `POST /api/tasks/:id/attempt` → HTTP 201，attempt `a-440ca07a-mwtr484c`（agent_id=claude）
- 运行中状态是 unknown（外部终端 Claude 拿不到结构化事件，状态机如实判）；本批提交后走 checkpoint → finish（带证据路径与 code_sha）落 completed，响应见 `scripts/chat-v1/p2-acceptance/office/`
