# Agent Chat P1 验收证据（A1-A7）

- 日期：2026-11-24（本地 2026-11-23 20:11–20:17 UTC）
- 执行人：Claude（soda-office-ea 会话，飞书触发）
- 服务：`http://127.0.0.1:8090`（重启后 build=r73，含本次新增路由）
- 验收对话：thread `th-16e11b96a0`（正式）/ `th-99d89d4373`（A7 坏 session）
- Agent Office 登记：task `t-20261123201623-0fc3b4` / attempt `a-5ed9efbe-mwtphwpf` / checkpoint `ck-mwtphx1j-8383d9`

> 复现材料：`scripts/chat-v1/p1-acceptance/`（请求体 json + 轮询脚本 poll.mjs）。
> 注意：请求体必须走 UTF-8 文件（`curl --data-binary @file`）。命令行内联中文会被
> Windows 控制台按 GBK 转码，claude 会收到乱码——这是调用方编码问题，产品链路
> （前端 fetch → server → stdin）全程 UTF-8 正常，A2-A4 的对话内容可证。

## A1 建 thread ✅

```
POST /api/chat/threads  {"agent_id":"claude","title":"P1 验收对话（正式）"}
→ HTTP 201
{"ok":true,"thread_id":"th-16e11b96a0","thread":{"agent_id":"claude",
 "provider_session_id":null,"mode":"discuss",...}}
```

## A2 发消息有真实回复 ✅（turn `ct-7ebe9c59e0`）

msg1 =「你好，我是Leo。我最喜欢的数字是 42，养了一只叫「汽水」的猫。请记住这两件事，等下我会考你。」

状态流转：starting → running → completed（约 42 秒）。
claude 回复（原文摘录）：

> Leo 你好！两条都记下了：
> - 最喜欢的数字：**42**
> - 猫：「汽水」🐱
> 不过得诚实说明：当前会话处于**计划模式（只读）**，我不能写任何文件……我已查过记忆目录（`memory/`），目前只有 `parallel-sessions-shared-worktree.md` 一条……

（它真的调了只读工具去查 memory 目录——chat_events 里 tool×3 可证。）

## A3 第 3 条体现第 1 条 ✅（turn `ct-eecd8d7dd2`）

msg3 =「第三句：我在第一句话里告诉过你两件关于我的事，你还记得吗？请原样复述这两件事。」

claude 回复：

> 记得，原样复述：
> 1. 你最喜欢的数字是 **42**
> 2. 你养了一只叫「**汽水**」的猫
> （另外你开头自报了名字是 Leo。）

## A4 「我刚才第一句说了什么？」答对 ✅（turn `ct-8055ee74e7`，核心项）

msg4 =「我刚才第一句说了什么？请一字不差地引用原文。」

claude 回复：

> 你第一句的原文是：
> > 你好，我是Leo。我最喜欢的数字是 42，养了一只叫「汽水」的猫。请记住这两件事，等下我会考你。

与 msg1 逐字一致。**真多轮上下文成立**（同一 provider session 续聊，不是每轮新会话）。

## A5 第 2 条起走 --resume ✅

数据库 chat_turns（th-16e11b96a0）：

```
ct-7ebe9c59e0  status=completed  resume=0  （首轮 --session-id 新建）
ct-3837ea2a02  status=completed  resume=1  （--resume）
ct-eecd8d7dd2  status=completed  resume=1  （--resume）
ct-8055ee74e7  status=completed  resume=1  （--resume）
```

- provider_session_id 全程稳定：`1a04c048-b2ed-4227-8f8a-4258286e2ea9`（首轮回填后不变）
- chat_events：`started`×1（首轮）+ `restoring`×3（续聊轮），与 resume 列互证
- 发送续聊消息的 202 响应里 turn.status 即为 `restoring`

## A6 三表落库 ✅（直查 data/agent-office.db）

```
chat_threads  3 行（含 th-16e11b96a0，provider_session_id=1a04c048-…）
chat_messages 8 行（user/assistant 交替，status=sent/complete，seq 1-8）
chat_turns    4 行（status=completed，带 started_at/ended_at）
chat_events   40 行（started 1 / restoring 3 / delta 12 / tool 3 / status 17 / completed 4）
```

## A7 坏 session id → 失败态 ✅（thread `th-99d89d4373`，turn `ct-0ab0e6bb50`）

手工把 provider_session_id 塞成 `00000000-dead-beef-0000-000000000000` 后发消息：

```
TURN ct-0ab0e6bb50 status=interrupted resume=true
  error={"kind":"session_not_found","label":"会话已丢失",
         "message":"Claude 找不到会话 00000000-dead-beef-0000-000000000000
                    （No conversation found with session ID）","retryable":true}
```

- 轮次终态 `interrupted`，**不是 completed**；助手消息 `interrupted`（空内容不冒充回复）
- 引擎清掉了坏 session 引用（provider_session_id → null），并追加 system 消息：
  「原会话 … 已不存在，下一句会新开一个会话；之前的上下文不会带过去。」
- 说明：任务书原文写「状态是 failed」。本实现状态词汇表（chat-state.mjs，十态）
  没有裸 'failed'——有明确证据的失败落 `interrupted` + error.kind=session_not_found。
  判据核心（不冒充 completed、失败原因如实可见）满足。

## 过程中发现并修复的问题

1. **首请求轮次被启动对账误伤**：引擎懒初始化时 reconcileOnStartup 把刚入库的
   queued 轮次当成「重启残留」落成 interrupted。修复：POST 处理器先取引擎（对账
   先跑）再建轮次（web/api-chat.mjs，已带注释）。修复后复测通过。
2. **调用方编码坑（非产品缺陷）**：curl 命令行内联中文经 Windows GBK 转码后发出
   乱码，claude 如实回复「收到乱码」（thread th-ea421adfb5 留档）。改 UTF-8 文件体
   后全链路正常。前端接入时无此问题（fetch 全程 UTF-8）。

## 本次接线改动清单

- 新增 `web/api-chat.mjs`：聊天三路由（POST /api/chat/threads；GET|POST
  /api/chat/threads/:id/messages），405/400/404 语义对齐 api-tasks.mjs
- `web/server-api.mjs`：+2 处（import 与派发挂载，未动既有路由）
- `web/server.js`：无改动（P1 无前端页面，静态白名单不需新增；P4 才做面板）
- 服务重启：PID 41944（旧）→ 37556 → 现行实例，日志 `web/web-8090.out`
