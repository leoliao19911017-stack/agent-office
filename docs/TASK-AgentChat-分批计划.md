# TASK：Agent Chat —— 分批实施计划（总纲）

> 老板要求：拆成小批次，一批一批做完，**每批完成都要登记到 Agent Office**，边开发边用起来验证。
> 全部完成后交 GPT 评审。
> UI 统一改用 **Coss UI** 风格（见 `docs/Coss-UI-设计参数.md`）。

---

## 批次总览

| 批次 | 内容 | 完成判据 | 状态 |
|---|---|---|---|
| **P1** | 数据表 + claude adapter + 最简聊天（HTTP 轮询） | 和 claude 连聊 3 轮，第 3 轮记得第 1 轮 | ✅ 完成 2026-11-24（证据：`docs/evidence/chat-p1/acceptance.md` / `.html`） |
| **P2** | dsh adapter | 和 dsh 连聊 3 轮，能接上下文 | ✅ 完成 2026-11-24（证据：`docs/evidence/chat-p2/acceptance.md` / `.html`） |
| **P3** | SSE 流式输出 | 回复是逐字出现的，不是等全部结束 | 待做 |
| **P4** | 前端聊天面板（Coss 风格） | 点 agent 卡开面板，气泡左右对齐，刷新历史还在 | 待做 |
| **P5** | 失败处理与状态机 | 429 / 启动失败 / 断流 都有明确状态和文案 | 待做 |
| **P6** | hermes adapter | hermes 能对话（能力按实测，不强行伪装） | 待做 |
| **P7** | 全量回归 + 交付 | T1-T10 全过，交 GPT 评审 | 待做 |

---

## 铁规矩（每一批都适用）

### 〇、进度必须上报（老板 2026-11-24 明确要求）

```
每批开始   报一句「P 几开始」
每批结束   报结果（通过 / 卡在哪 / 证据在哪）
限额/卡住  立刻报，不要闷头等
限额后     立刻切 DSH 继续，不许停
```

**触发原话：「你怎么没有上报？后续如果限额了，就切换到dsh继续开发」**
上一批 Claude 限额停了，我没有主动报，这是错的。

### 一、完成即登记到 Agent Office

每批做完，**必须往 Agent Office 写一条真实记录**，用现有 API：

```
POST /api/tasks                 建一个批次任务（title 写清楚是 P几）
POST /api/tasks/:id/attempt     声明开始执行
POST /api/tasks/:id/checkpoint  每完成一个关键步骤存检查点
```

**这不是走过场 —— 老板要通过看板看到「开发进度本身」在跑。**
登记失败要修，不能跳过。

### 二、边开发边验证

```
写完一个能力 → 立刻真调一次 → 把真实返回贴进交付记录
不许写完一堆再统一测
不许只写测试脚本不跑
```

### 三、不许声称完成

```
声称完成 = 附真实终端输出
没跑就是没跑
做不到就说做不到
```

### 四、UI 全用 Coss 风格

看板骨架保留 Cromma 的暖米白（老板已认可），
**所有新增的聊天相关界面、以及需要返工的区域，一律用 Coss 的参数**（见设计参数文档）。

---

## P1 详细：数据表 + claude adapter + 最简聊天

### P1.1 数据表

加进现有 `data/agent-office.db`，**不新建库**。

```sql
CREATE TABLE IF NOT EXISTS chat_threads (
  thread_id            TEXT PRIMARY KEY,
  agent_id             TEXT NOT NULL,
  provider_session_id  TEXT,
  workspace            TEXT,
  mode                 TEXT NOT NULL DEFAULT 'discuss',
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  message_id   TEXT PRIMARY KEY,
  thread_id    TEXT NOT NULL,
  turn_id      TEXT,
  role         TEXT NOT NULL,        -- user | assistant | system
  content      TEXT NOT NULL,
  status       TEXT NOT NULL,        -- queued|starting|running|completed|failed|unknown
  seq          INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  FOREIGN KEY (thread_id) REFERENCES chat_threads(thread_id)
);

CREATE TABLE IF NOT EXISTS chat_turns (
  turn_id      TEXT PRIMARY KEY,
  thread_id    TEXT NOT NULL,
  status       TEXT NOT NULL,
  started_at   TEXT,
  ended_at     TEXT,
  error_code   TEXT,
  error_text   TEXT
);
```

**索引：**
```sql
CREATE INDEX IF NOT EXISTS ix_chat_messages_thread ON chat_messages(thread_id, seq);
CREATE INDEX IF NOT EXISTS ix_chat_turns_thread ON chat_turns(thread_id);
```

### P1.2 claude adapter

**核心：`--resume` 续聊，不是每轮传 `--session-id`。**

```
首轮    claude -p "<msg>" --session-id <自己生成的UUID>
        → 从输出里拿本次 session 的真实 ID（或直接用自己传的那个）
续聊    claude -p "<msg>" --resume <上轮的 session id>

参数     --effort high
        --permission-mode acceptEdits
        --allowedTools "Read" "Write" "Edit" "Bash" "Glob" "Grep"
        --output-format json     ← 便于解析
```

**实测已知：**
- 模型用 settings.json 里配的 `glm-5.4[1M]`，**不要显式传 `--model`**（会触发 unrecognized_model 警告）
- `-p` 模式必须给 `--allowedTools`，否则会卡在工具授权
- 会打印一行 `[claude-code:unrecognized_model]` 到 stderr，**是警告不是错误，忽略**

**adapter 要做的：**
```
输入  消息文本 + 上轮 session id
输出  { reply, sessionId, usage?, error? }
超时  单个请求 180s
失败  区分 启动失败 / 429 / 超时 / 其他
```

### P1.3 API（HTTP 轮询，先不做 SSE）

```
POST /api/chat/threads
  body { agent_id, workspace? }
  → { thread_id }

GET  /api/chat/threads/:id/messages
  → { messages: [...] }

POST /api/chat/threads/:id/messages
  body { content }
  → { turn_id, status: 'running' }
  （异步执行，立刻返回）
```

**挂进 `web/server-api.mjs` 的 `createApiRouter(deps)`，不要另起服务。**

### P1.4 P1 验收

```
A1  能创建 thread，返回 thread_id
A2  发一条消息，claude 有真实回复
A3  连发 3 条，第 3 条的回复里能体现第 1 条的内容（真上下文）
A4  发一条"我刚才第一句说了什么？"，它能答对
A5  provider_session_id 被正确保存，第 2 条用的是 --resume
A6  数据库里能查到 thread / messages / turns
A7  失败时（比如故意传错 session id）状态是 failed 不是 completed
```

**A3 和 A4 是核心 —— 证明「真多轮」，不是每轮开新会话。**

### P1 完成记录（2026-11-24）

- A1-A7 全过：A4（「我刚才第一句说了什么？」）一字不差引用原文，真多轮成立。
  验收对话 thread `th-16e11b96a0`，坏 session 验证 thread `th-99d89d4373`。
- 证据文档：`docs/evidence/chat-p1/acceptance.md`（AI 用）+ `acceptance.html`（人看）；
  复现材料：`scripts/chat-v1/p1-acceptance/`。
- Agent Office 已登记：task `t-20261123201623-0fc3b4` → attempt `a-5ed9efbe-mwtphwpf`
  → checkpoint `ck-mwtphx1j-8383d9`（三个 201 真实响应）。
- 接线：`web/api-chat.mjs`（三路由）+ `web/server-api.mjs`（挂载 2 处）；8090 已重启生效。
- 备注：A7 任务书写「状态是 failed」，实现按 chat-state.mjs 十态词汇表落
  `interrupted` + `error.kind=session_not_found`（不冒充 completed，原因如实可见）。


### P1.5 P1 完成动作

```
1. 真实跑完 A1-A7，贴输出
2. 往 Agent Office 登记：POST /api/tasks 建 "Agent Chat P1" 任务，走完 attempt/checkpoint
3. 在本文档 P1 那行状态改成 ✅ 完成，附证据路径
```

---

## P2 详细：dsh adapter

### P2.1 验收（B1-B5）

```
B1  建 dsh thread，发一条消息有真实回复
B2  连发 3 条，第 3 条能反映第 1 条内容
B3  问「我第一句说了什么」能答对
B4  session-id 正确保存，第 2 条走续聊
B5  dsh 起不来时状态是 failed 且原因具体（不是笼统「失败」）
```

### P2 完成记录（2026-11-24）

- B1-B5 全过（8/8，`scripts/chat-v1/p2-acceptance/run.mjs` 退出码 0）。验收对话 thread `th-5c99928c3e`：
  四轮真 dsh，B3「我第一句说了什么」一字不差引用原文；B4 `provider_session_id=session-f9f16578-…`，
  第 2/3/4 条命令行都是 `--session-id session-f9f16578-…`，`chat_turns.resume = 0,1,1,1`。
- B5 四种情况都真制造了：会话不存在（dsh 原话 does not exist）/ 工作目录被删 / CLI 路径错 / 命令找不到 →
  轮次一律 `failed`，`error.reason` 分别是 `session_not_found / workspace_not_found / cli_path_missing / cli_not_found`，
  用户消息也是 `failed`（没交出去）。
- **⚠️ 续聊参数与任务书口径不同**：任务书写「续聊用 --resume，不是 --session-id」。实测 dsh headless 0.2.2-rc.5
  **只认 `--session-id`**；`--resume` 报 `unknown option '--resume'`（exit 1）。dsh 自带 help 也只列 `--session-id`
  （`--resume` 是 `dsh tui` / Claude Code 的参数）。所以 dsh adapter 用 `--session-id`、claude adapter 用 `--resume`。
  对照输出：`scripts/chat-v1/p2-acceptance/out/resume-flag-{resume,session-id}.json`。
- 状态词汇加 `failed`：没跑成（起不来 / 没凭据 / 认证不过 / 会话丢了 / CLI 明确报错）落 failed，
  跑着被切断（崩溃 / 超时 / 取消 / 服务重启）落 interrupted。P1 的 A7 当时落的是 interrupted，P7 回归会按新口径重跑。
- 证据文档：`docs/evidence/chat-p2/acceptance.md`（AI 用）+ `acceptance.html`（人看）；
  自动化：`test/chat-state.test.js` 11/11、`test/chat-engine.test.js` 17/17、`test/chat-http.test.js` 14/14（真实 server.js + 假 CLI）。
- Agent Office 登记：task `t-20261123210150-6256ee` → attempt `a-440ca07a-mwtr484c` → checkpoint / finish 见 `scripts/chat-v1/p2-acceptance/office/`。
- 顺带补上 **`POST /api/tasks/:id/finish`**（仓库里原本没有这个端点，P1 那条所以停在 unknown）：
  结束执行实例 + 记一条**必须带证据**的 `acceptance_passed` + 状态机算出 completed；没证据 400。

---

## 后续批次（P1 完成后再细化，先给方向）

**P2 dsh adapter**
```
dsh.cmd 不在 PATH，必须用完整路径
首次拿真实 session-id 保存，后续用那个续跑
Windows 上必须 danger-full-access（但 P2 只读讨论，不执行写入）
```

**P3 SSE**
```
GET /api/chat/turns/:id/stream
事件：started / delta / completed / error
断线重连按 seq 补发
```

**P4 前端（Coss 风格）**
```
点 agent 卡 → 右侧面板切聊天
气泡左右对齐，收发同色靠对齐区分
时间戳小字灰色
输入框 14px，圆角 14px，最小高 48px
```

**P5 失败与状态**
```
429 → 「请求受限」+ 退避
启动失败 → 具体原因 + 重试
断流 → 「连接中断，正在重连」
未知 → unknown，绝不显示空闲
```

**P6 hermes**
```
先实测网关支持什么，按实际能力接，不伪装
```

**P7 回归 + GPT 评审**
```
T1-T10 全过
把所有批次证据打包给 GPT 审
```
