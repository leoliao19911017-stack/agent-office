# GPT 对 Soda Office 第一阶段的意见

Soda Office 第一阶段架构评审

我的结论是：方向正确，现阶段不建议更换技术栈，也不建议引入大型 Agent 编排框架。

你们已经完成的 4 个 Task、40 项测试，证明了任务注册、领取、状态流转和事件记录这条基础链路能够运行。但下一阶段的重点应该从“让 API 能用”转向“让多个真实 Agent 可靠地完成一个任务”。

我建议把 Soda Office 的产品定位明确为：

面向已有 AI Agent 的协作工作台。让 Agent 可见、可调度、可交接、可追责，而不是再创造一套新的 Agent。

这也是它与 LangGraph、Microsoft Agent Framework 等产品最值得区分的地方。

五个问题的决策摘要

Q1 架构	保留 Node.js + SQLite，自研轻量编排核心
Q2 自然语言编排	

采用 LLM 生成任务图 + 确定性执行引擎


Q3 原子领取	第二阶段立即补租约、Fencing Token 和失败恢复
Q4 看板	

选择 B：本地 Web 服务，先轮询，暂不做 WebSocket


Q5 产品化	聚焦一个真实工作流，先做 Windows 单机试点版
Q1：架构方向对吗？需要引入编排框架吗？
结论：分层合理，但建议增加两个明确的层次

你现在是：

SQLite → HTTP API → 编排层 → 界面层

这个划分可以继续，但如果最终要实现真正的 Agent 协作，建议扩展成下面的结构。

Soda Office Web / 飞书 / Skill

用户提出任务、查看状态、人工确认

Office API

任务、Agent、事件、能力和权限

Workflow Engine · 核心

Workflow Compiler

自然语言生成任务图

Scheduler

依赖和任务分配

Execution Manager

超时、租约、恢复

Approval & Handoff

审批、交接与验收

Agent Adapter / Capability Registry

发现 Agent 能力、执行任务、采集真实事件

Claude

可执行

Codex

可执行

Hermes

协调

DSH

只读

SQLite 持久化

Workflow / Tasks / Runs / Events / Artifacts / Leases

这里最重要的是把 Agent Adapter 从编排逻辑中独立出来。

因为将来不管接入的是 Claude Code、Codex、DSH，还是企业内部自建 Agent，Office 都应该只关心统一能力：

能不能接收任务？

能否返回状态？

能否被取消？

能否交付产物？

是否支持继续执行或恢复？

而不关心它内部运行什么模型。

三个现成框架怎么选？

框架

	

真正擅长什么

	

对 Soda Office 的建议




LangGraph

	

状态图、Checkpoint、Agent 多轮工作流

	

参考状态持久化设计，不急着引入




Microsoft Agent Framework

	

多 Agent 协调、顺序和并行执行、Handoff

	

参考协作模式，不必整体迁移




Temporal

	

长任务恢复、持久化执行、重试、Worker 故障处理

	

未来跨机器、高可靠场景再评估

这几个框架目前确实都具备相应的工作流能力。LangGraph 支持持久化 Checkpoint；Microsoft Agent Framework 的编排模式已经覆盖顺序、并行、交接；Temporal 则专门解决长时间执行与故障恢复。
GitHub
+2

但它们**不能直接替你解决“已经安装在 Windows 上的第三方 Agent 怎么连接”**这个问题。你仍然需要适配 Claude Code、Codex 和 DSH。

因此，当前使用 Node.js 自己实现一个小型调度内核是合理的。

有两个技术约束需要现在锁定：

第一，所有任务领取、心跳和结果提交都应通过 Office API，不允许多个 Agent 直接写 SQLite。尤其使用 WASM SQLite 驱动时，需要验证多进程下的文件锁与持久化行为，不能把 HTTP 层内的并发测试直接等同于跨进程数据库安全。

第二，必须明确 Hermes 和 Workflow Engine 的边界：

Hermes 负责理解意图、编排方案、协调异常，不写业务代码。

Workflow Engine 负责执行确定的任务图、维护状态和处理超时，不依赖 Hermes 一直在线思考。

即使 Hermes 崩溃、DeepSeek 接口暂时不可用，已经提交的任务也不应该因为调度者失联就丢失。

这是我认为 Q1 最重要的架构决定。

Q2：自然语言编排具体应该怎么做？
结论：不要让大模型直接控制调度循环

我推荐采用一个很明确的模式：

Natural Language → WorkflowSpec → Validator → Scheduler → Agent → Verification

即：

LLM 做规划：理解人话，生成结构化任务图。

代码做校验：检查 Agent 能力、依赖、权限和预算。

调度器做执行：按依赖关系启动任务，不靠 LLM 轮询状态。

Agent 做工作：只处理被分配的具体任务。

Verifier 做验收：根据产物和测试证据判断是否完成。

LLM 决定“应该做什么”，确定性代码决定“什么时候可以执行”。

1. 先建立 Agent Capability Registry

你们现在的 agents 表主要承担注册和状态管理。第二阶段应该增加能力信息。

例如：

Agent

	

能力

	

调度模式




Hermes

	

plan, coordinate, summarize

	

协调




Claude Code

	

code.write, code.test

	

可执行




Codex

	

code.review, code.plan

	

可执行




DSH

	

session.observe

	

只读

这里的能力不是根据模型名称猜测的，而应该来自适配器实际验证、管理员注册或经确认的能力声明。

DSH 当前不能接受程序化派活，因此不能让规划器因为“DSH 是通用 Agent”就自动分配视频剪辑任务。

2. 自然语言必须先编译成任务图

假设用户说：

帮我组建一个视频团队，有人负责脚本，有人负责剪辑，最后审核并发布。

第一步不是马上启动 Agent，而是生成这样的计划：

用户需求

制作并发布一条产品视频

01 · 脚本策划

需要 script.write 能力

02 · 视频剪辑

依赖脚本，需要 video.edit 能力

03 · 内容审核

依赖成片，需要 content.review 能力

04 · 人工审批发布

审批通过后才允许执行发布

当前能力不足

未验证视频剪辑和发布执行器，工作流需要等待补齐能力，不能虚假派发

这就是自然语言编排的第一层价值：不只是拆任务，还能发现当前团队无法完成什么。

3. WorkflowSpec 应该是明确的结构化协议

我建议第一版直接使用 JSON，不需要引入复杂的 DSL。

JSON

{
  "schema_version": "1.0",
  "workflow_id": "wf-video-001",
  "goal": "制作并发布产品视频",
  "steps": [
    {
      "id": "script",
      "capability": "script.write",
      "depends_on": [],
      "output": "script.md",
      "verify": {
        "type": "artifact_exists"
      }
    },
    {
      "id": "editing",
      "capability": "video.edit",
      "depends_on": ["script"],
      "output": "final.mp4",
      "verify": {
        "type": "media_valid"
      }
    },
    {
      "id": "review",
      "capability": "content.review",
      "depends_on": ["editing"],
      "output": "review.json"
    },
    {
      "id": "publish",
      "capability": "social.publish",
      "depends_on": ["review"],
      "requires_approval": true,
      "retry_policy": "manual"
    }
  ]
}


这只是简化示例。生产版本还应包含输入来源、任务权限、超时、资源限制、Agent 选择策略和失败处理策略。

关键是：WorkflowSpec 不直接携带可以任意执行的 Shell 命令。 真正的执行命令由可信 Adapter 根据能力映射生成。

4. 做一个三阶段的 Workflow Compiler

1

Planner：大模型生成任务图

输入用户需求、已注册能力、资源限制和验收标准。输出严格符合 Schema 的 JSON，不输出执行命令。

2

Validator：确定性校验

检查 JSON Schema、是否有环、依赖是否存在、Agent 能力是否匹配、是否越权、是否超预算。缺能力就 blocked，不伪造执行者。

3

Scheduler：执行 DAG

上游完成且验收通过，才释放下游任务。失败按照策略重试、改派、暂停或请求人工介入。

其中 Planner 可以由 Hermes 调用 DeepSeek 来完成，但生成后必须经过 Validator。

5. 推荐使用的 Prompt 模式

给 Planner 的核心约束可以写成：

你是 Workflow Compiler，不是执行 Agent。请根据用户目标、可用 Agent 能力及约束生成一个最小可执行 DAG。不得虚构 Agent、工具或权限。每个任务必须定义能力需求、依赖、输出产物和验收方式。缺少执行能力时标记 unresolved。涉及外部发布、付款、删除和生产部署的操作必须标记人工审批。只输出符合 WorkflowSpec Schema 的 JSON。

我建议参考两个成熟概念：

DAG / Workflow：参考 Temporal、LangGraph 的持久化状态和依赖执行模式。

Agent Handoff：参考 A2A 的 Task、Artifact、状态生命周期和需要人工输入时的暂停机制。A2A 已明确区分工作中、完成、失败、需要输入等状态。
docs.cloud.google.com
+1

但第一版不要实现完整 A2A 协议。先用你们自己稳定的内部任务协议，把真实的 Claude Code 和 Codex 接起来。

Q2 最重要的验收：用户说一句自然语言，系统能够生成一张可理解、可修改、可执行的任务图，并明确指出缺失的能力。

Q3：现在的原子领取够用吗？要不要马上加租约？
结论：马上加，但做一个轻量版本

你们的原子领取实现没有问题：

SQL
UPDATE tasks
SET status = 'claimed'
WHERE id = ? AND status = 'queued';

单条原子 UPDATE 能解决多个 Agent 同时领取同一任务的问题。

但是它解决不了 Agent 领取后崩溃的问题。

我建议第二阶段立即补齐：

Lease + Heartbeat + Claim Token + Recovery

这里需要纠正报告里的一个说法：

心跳是持有者主动写的，唯一可靠。

心跳确实是判断 Agent 最近是否活跃的重要证据，但心跳超时不能证明旧 Agent 进程已经死亡。

可能出现的情况包括系统睡眠、进程暂停、网络抖动、事件循环阻塞，以及进程仍在执行却无法上报心跳。

你们之前 Python Adapter 遇到过的“租约过期但旧进程还活着”，在 Node 版同样需要防范。

推荐的最小实现

在 tasks 表增加：

SQL
claim_token TEXT,
lease_expires_at INTEGER,
attempt INTEGER DEFAULT 0,
current_run_id TEXT

使用 Node.js crypto.randomUUID() 生成不可预测的 claim_token。

领取任务时，在同一条原子 UPDATE 中设置 Token、租约和 Attempt；只有领取成功的 Agent 能获得 Token。

续约时：

SQL
UPDATE tasks
SET lease_expires_at = ?
WHERE id = ?
  AND claim_token = ?
  AND status IN ('claimed', 'running');

所有状态更新和结果提交也必须验证当前 claim_token，防止旧执行者在失去所有权后覆盖新结果。

Agent 领取任务

获得 Claim Token + 租约

正常执行，每 15 秒续约

示例租约有效期 90 秒

超过租约时间，进入 suspect

确认旧任务已结束

安全恢复或重新派发

状态无法确认

Blocked，等待处理

这里的 15 秒、90 秒只是第一版可测试的默认值，需要根据实际执行环境调整。

最容易被忽略的一点：Claim Token 只能阻止旧 Agent 修改 Office 数据，不能阻止旧进程继续修改磁盘文件。

所以对于代码开发任务，还需要配合独立工作区或 Git worktree。

推荐最小恢复规则：

场景

	

处理




Agent 正常退出，验收通过

	

completed




Agent 崩溃，确认进程已结束

	

根据重试策略重新派发




心跳过期，进程情况不明

	

suspect / blocked




旧 Agent 重新提交结果

	

Token 不匹配，拒绝写入




发布、付款等具有副作用的任务失败

	

不自动重试，先核实外部动作是否已发生

另外，建议把 Agent.stale 和 Task.lease_expired 分开。前者代表最近有没有收到 Agent 心跳，后者代表某个任务的执行所有权是否需要重新确认，它们不是同一件事。

Q3 的答案非常明确：租约应该现在做，不要等真实任务永久卡住后才补。 但不需要移植整个 Python Runner，只需先实现可靠的领取、续约、所有权验证和安全恢复。

Q4：看板应该选 A、B 还是 C？
结论：选 B，本地 Web 服务

而且我建议现在就做，不用等工作流编排全部完成。

既然你们已经实现了 Node HTTP API，那么使用同一个 Node 进程提供静态网页，是改动最小的选择。

方案

	

评价

	

决定




A. 单文件 HTML

	

适合静态报告，缺乏实时交互

	

保留为导出功能




B. 本地 Web 服务

	

可实时查看、可扩展审批与任务操作

	

第一版采用




C. 终端 TUI

	

适合开发者，不适合普通企业员工

	

暂不开发

第一版界面应该是什么样？

我建议以“工作流”为主角，而不是以“Agent 卡片”为主角。

Soda Office

工作台 · 界面概念示例

 本地服务

3

已注册 Agent

1

执行中任务

2

待处理异常

当前工作流

产品登录页开发

Codex → Claude Code → Codex

3 个阶段

完成

需求分析

Codex

进行中

开发实现

Claude

等待中

代码审查

Codex

最近活动

Codex

完成需求拆解

10:42

Claude Code

开始修改登录页文件

10:43

Office

收到文件写入事件

10:44

以上均为界面示意数据，不代表当前真实运行状态。

第一版至少支持以下四个视图：

工作流视图：展示一个需求如何被拆成多项任务、任务依赖关系、目前执行到哪一步。

Agent 视图：展示注册成员、能力、最近心跳、管理中的任务。对于 DSH 这种只读成员，明确标记为“可观察、不可调度”。

任务详情：展示阶段报告、原始事件、产物、测试证据以及失败原因。

今日记录：自动汇总今天执行过什么、完成了什么、还有什么问题。让用户不用翻聊天记录。

暂时不需要 WebSocket

第一版直接每 3～5 秒轮询现有 API 就够了。以后需要更低延迟的单向更新，可以先考虑 SSE，再决定是否需要 WebSocket。

WebSocket 不会让任务本身执行得更可靠。现在更值得花时间的是任务状态准确性。

另外，当前 API 尚无鉴权。即使只监听 127.0.0.1，在增加网页操作入口之前也要补访问令牌、Origin/Host 检查、路径权限和敏感日志脱敏，防止其他本地进程或恶意网页向服务提交任务。

Q4 最终建议：V0.2 做成 Node 服务 + 静态 Web 页面 + SQLite 实时数据，先把任务真实过程看清楚。

Q5：从现在到第一家企业试用，最短路径是什么？
结论：先卖一个可靠的工作流，而不是完整的 Agent 操作系统

这是我对五个问题中最重视的一项。

现在最大的风险不再是 Agent 能不能通信，而是开发出一套技术完整、功能很多，但客户不知道为什么要装的产品。

对首家企业，我建议只承诺：

安装 Soda Office，把已经在用的 Codex 和 Claude Code 连起来。一个开发需求从分配、开发、测试到审查，整个过程可见，失败能发现，成果能追溯。

不用先宣传“企业全员多 Agent 操作系统”。

第一家试点企业需要的最小产品

能力

	

优先级

	

原因




Windows 一键安装和卸载

	

必须

	

客户不能手工配置一堆命令




发现 Codex、Claude CLI

	

必须

	

快速接入现有工具




一个真实的端到端工作流

	

必须

	

证明能交付，而非仅显示状态




本地任务看板

	

必须

	

解决最直接的透明度问题




租约、超时、故障状态

	

必须

	

避免长任务静默失控




安全授权及项目目录隔离

	

必须

	

防止 Agent 越权修改客户项目




人工验收入口

	

必须

	

完成商业使用的基本闭环




自然语言生成任务图

	

简化版

	

只支持有限能力和模板




DSH 只读会话观察

	

可选

	

不影响主流程




完整 A2A / 跨机器

	

暂缓

	

首家试点不需要




可视化拖拽工作流编辑器

	

暂缓

	

自然语言 + 任务图足够




GPT 生图及视频能力

	

暂缓

	

作为后续 Capability Gateway 插件




3D 办公室和数字人动画

	

暂缓

	

不影响核心价值验证

这里还有一个重要的产品现实：

一个 Skill 无法凭空管理其他程序的进程、访问文件和采集状态。

所以最终的交付形式不应该只是一个 SKILL.md。

我建议产品包装成：

Soda Office Desktop Companion

本地安装包，运行 Office Server、SQLite、Agent Adapters 和 Web 工作台

Soda Office Skill

安装到 Hermes、Claude Code 等工具中，让 Agent 能查任务、发起交接和请求能力

Soda Office Web

企业员工和管理者查看状态、任务、异常与交付结果

用户安装的是一个产品，Skill 只是它连接其他 Agent 的入口之一。

建议的最短实施顺序

01

第 1 步：让真实 CLI 接入 Soda Office

复用之前在 Agent Office 中验证过的 Claude Code / Codex 调度经验，但以当前 Node 版作为统一任务状态来源，避免两套数据库同时管理一个任务。

02

第 2 步：补租约与执行保障

Agent 崩溃、Office 重启、任务超时和重复提交，都必须能正确处理。每次代码开发使用隔离工作区。

03

第 3 步：交付本地 Web 工作台

能看到真实任务、状态、执行时间线、产物、测试结果；允许用户完成一次人工验收。

04

第 4 步：接入最小自然语言编排

先支持“分析需求 → 开发 → 自动测试 → 审查 → 人工验收”这一类模板，不做任意复杂工作流。

05

第 5 步：找一家具备现有 Agent 使用习惯的企业试点

优先选择已经使用 Claude Code 或 Codex 的小型开发团队，而不是需要你帮它从零安装并培训所有 AI 工具的公司。

第一家试点，怎么证明产品有价值？

不需要先追求大规模用户。找 1 家企业、2～5 位实际使用 Agent 的员工，选择他们已有的一类开发任务，连续使用两周即可获得第一批有意义的验证数据。

建议重点记录四个指标：

指标

	

怎么验证




任务交接成功率

	

跨 Agent 交接中，有多少实际收到结果




任务可追溯率

	

有多少任务能查到执行过程、产物和验收证据




异常发现时间

	

Agent 卡住以后，多久能被 Office 发现




人工协调耗时

	

与原来手动复制任务、查看聊天记录相比节省多少时间

最后这个指标尤其重要。

因为企业购买的不是“一个很漂亮的 Agent 看板”，而是减少员工手动协调多个 AI 工具的时间，同时降低交付失控的概率。

最后，给 Soda Office 第二阶段一个明确的优先顺序

你们当前第一阶段的 40 项测试，证明了任务状态系统已经成形。但“注册两个 Agent、模拟执行一个任务并上报结果”，和“真实跨 Agent 完成工作”，中间还有一段距离。

我建议接下来按以下优先级推进：

P0

真实 Agent 接入 + 租约恢复

从模拟任务走向真实执行，这是最重要的技术关口

P1

本地 Web 工作台

让用户能看到真实任务和交付证据

P1

最小 Workflow Engine

固定模板、依赖执行、自动验收和有限重试

P2

自然语言 Workflow Compiler

将人话转成有约束、可验证的 DAG

P3

A2A、跨机器与通用插件生态

等首家企业验证需求后再扩大范围

还有一个关键建议：从现在开始，不要再同时迭代两套独立的 Agent Office 调度内核。

我们之前的 Python Adapter 已经积累了许多非常宝贵的验证经验，包括代理注入、事件归一、进程失联、取消、凭据保护和独立工作区。这些应该成为新 Node 版的测试用例和设计约束，而不是再维护一套与 Soda Office 平行的产品内核。

从长期产品化角度看，Node 版完全可以成为新的统一底座。

如果只能给第二阶段设一个验收目标，我会选这个：

用户在 Soda Office 输入一句开发需求，系统生成任务图，由 Claude Code 和 Codex 在真实工作区完成开发、测试和复核；用户全程能看到进度，异常可以安全恢复，最后只需要确认交付结果。

这一个闭环真正跑通，Soda Office 就有了向第一家企业展示并试用的产品基础。