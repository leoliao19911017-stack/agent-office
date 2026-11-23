# TASK：Agent Office 真对话（Agent Chat V1.0）

> 设计已与 GPT 讨论定型，本任务只做 V1.0，不扩范围。

---

## 一、目标

在 Agent Office 看板（localhost:8090）中间那块 agent 区域，**点击某个 agent，右侧面板变成与它的真对话**。

是真多轮聊天：发一句、回一句、下一句能接上上下文。

---

## 二、本机现有能力（已实测）

```
claude    C:/Users/Administrator/.local/bin/claude  v2.1.296
          已配 GLM：ANTHROPIC_BASE_URL=open.bigmodel.cn/api/anthropic
          模型 glm-5.4[1M]，有 5 小时限额（会 429）
          支持 --resume <session-id> 续聊

dsh       dsh.cmd --profile headless --session-id <id>
          实测能续上下文；Windows 上必须 danger-full-access 才能跑 shell
          未知 session-id 会报错，必须用首次建立时返回的真实 ID

hermes    本地网关，HTTP 接口，会话能力待验证

codex     本机执行器起不来（CreateProcess 超时），本轮排除
```

## 三、六项架构决策（已定，按这个做）

```
ADR-01  按需启动 CLI + Session ID 续聊，不做常驻进程池
ADR-02  HTTP POST 发消息 + SSE 推流；现有轮询看板保留
ADR-03  Chat Thread / Task / Execution Attempt 三者数据独立
ADR-04  SQLite 存聊天事实（界面历史），原生 Session 存模型上下文
        —— 绝不每轮把全部历史重新塞给模型
ADR-05  聊天可以并行；同一工作目录的写入必须串行
ADR-06  默认「讨论模式」；受控执行模式单独授权
```

### 3.1 关于续聊参数（重要，别搞错）

```
claude    新建会话  --session-id <新UUID>
          续聊      --resume <已存在的session-id>
          —— 不是每轮都传 --session-id 就能续

dsh       首次启动拿到真实 session-id 后保存
          后续续跑传那个真实 ID
```

### 3.2 并发写入策略

```
两个 agent 同时普通聊天        → 可以并行，不争写入锁
两个 agent 同时改同一目录      → 不可以，写入前必须获得所有权
各自独立 worktree             → 可以并行
```

**注意：锁的粒度是「一次写操作」，不是整个聊天会话。** 不能因为聊半小时就占锁半小时。

### 3.3 聊天会话 ≠ 任务会话

```
普通聊天        Agent Office 自己创建独立 Session
关联任务聊天    独立聊天 Session + 指定任务上下文
任务执行        任务系统原来的 Session
```

**不能把聊天消息塞进正在执行任务的 CLI Session 里。**

---

## 四、数据结构（加进现有 SQLite，不另起库）

```
chat_threads    thread_id, agent_id, provider_session_id, workspace, mode
chat_messages   message_id, thread_id, role, content, status
chat_turns      turn_id, thread_id, attempt_id, status
chat_events     event_id, turn_id, seq, type, timestamp
chat_approvals  approval_id, turn_id, action, decision
chat_summaries  thread_id, summary, covered_turn_id
```

**三个 ID 不许混：**
```
thread_id            Agent Office 自己的聊天编号
provider_session_id  Claude/DSH 真正的 Session ID
turn_id              一次用户输入 + 对应执行的唯一编号
```

---

## 五、接口

```
POST /api/chat/threads              开一个对话（指定 agent）
GET  /api/chat/threads/:id/messages 拉历史
POST /api/chat/threads/:id/messages 发消息 → 返回 turn_id
GET  /api/chat/turns/:id/stream     SSE 推流
POST /api/chat/turns/:id/cancel     取消本轮
```

**SSE 事件类型：**
```
started      开始
restoring    正在恢复会话
delta        增量文本
tool         工具调用
completed    完成
error        失败（带类型）
```

---

## 六、状态与文案（沿用「不许撒谎」原则）

```
queued              等待发送
starting            正在启动 Agent
restoring           正在恢复会话
running             正在回答
tool_running        正在执行工具
approval_required   等待你的确认
completed           回答完成
rate_limited        请求受限
interrupted         执行中断
unknown             执行结果未确认
```

**没有可靠证据 → unknown，绝不兜底成空闲。**

### 6.1 失败怎么写

```
CLI 启动失败      显示具体原因，允许重试，不丢消息
Claude 429        显示「请求受限」，退避重试
Claude 额度耗尽   显示「额度暂不可用」，暂停但保留 Session
DSH 卡住          显示「长时间无新事件，正在核实」，不按耗时判死
进程异常退出       显示「本轮中断」，检查已保存输出
SSE 断开          重连并补发，不重复执行 CLI
```

---

## 七、权限（V1 保守）

**V1.0 只开讨论模式：能读、能分析、能回答。不开放无人监管的写代码和 Shell 执行。**

**理由：** DSH 的 `danger-full-access` 绕过了文件系统限制，**worktree 是代码隔离，不是安全沙箱**。给指定工作目录不等于它只改那个目录。

**什么时候开工作模式：** 要单独授权，由任务系统（现有的 write_owner）控制，不在聊天里直接给。

---

## 八、V1.0 验收标准

```
T1  点 agent 卡片 → 右侧打开该 agent 的聊天面板
T2  和 claude 连续聊 3 轮，第 3 轮回答里能体现第 1 轮的内容（真上下文）
T3  和 dsh 连续聊 3 轮，同样能接上
T4  刷新页面，聊天历史还在（从 SQLite 读）
T5  重启 Node 服务，聊天历史还在
T6  模拟 429，界面显示「请求受限」，消息不丢
T7  普通聊天不影响正在执行的任务 Session
T8  SSE 能增量显示，不是等全部结束才出现
T9  没有证据时状态显示 unknown，不显示「空闲」
T10 所有按钮点击有反应，没有假按钮
```

---

## 九、工作方式

**一干到底：写代码 → 起服务 → 自己测 → 自己截图 → 自己改 → 再审。
交回：截图 + 每个验收项的实际测试输出。**

**不许声称完成而没有测试证据。**

## 十、环境

```
项目     E:\DesktopProjects\Soda Intelligence - AI Native Thinking\Soda Office
分支     p0-foundation
服务     PORT=8090 node web/server.js
数据库   data/agent-office.db
桌面看板 web/board-cromma.html（V2 已交付，在此基础上改）
```

**注意：** 中间那块现在是 agent 表盘（4 张卡），点卡片要能打开对话。
EaseDraw 的入口保留在顶部胶囊，别删。
