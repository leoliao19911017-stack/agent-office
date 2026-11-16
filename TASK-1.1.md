# Soda Office — 第一阶段任务书

> 派给：Claude Code
> 验收：Lemate（Hermes）
> 工作区：`~/Desktop/Soda Intelligence - AI Native Thinking/Soda Office/`
> 技术栈：Node ESM + SQLite，零外部依赖优先

---

## 0. 先读这段，再动手

你（Claude Code）是**执行者**，负责写代码。Lemate（Hermes）是**协调者**，负责拆任务、验收、把关。

**这次只做第一阶段。** 不要顺手把后面几阶段一起做了 —— 范围越大，越容易跑偏。

**每完成一个任务，必须停在任务边界，报告进度，等 Lemate 验收。**

---

## 1. 这个项目是什么

**Soda Office 是一个 Agent 编排工作台。**

核心问题：一台机器上装了多个 AI Agent（Claude Code、Codex、DSH、Hermes），它们互不知道彼此在干什么，人只能靠翻聊天记录去拼接信息。

Soda Office 要做三件事：

1. **看见** —— 所有 Agent 现在在做什么、今天做了什么、结果在哪
2. **调度** —— 用自然语言编排工作流，把任务派给合适的 Agent
3. **交接** —— Agent 之间能查询对方状态、请求对方干活

**它不是聊天工具，是工作台。** 人可以在这里下需求，Agent 在这里领活、交活。

---

## 2. 已有的东西（要复用，不要重写）

### 2.1 `soda-agent-workspace`（同目录下）

已经实现了 Agent 接入层，**直接复用它的协议和概念，不要重新发明**。

它提供：
- ed25519 签名身份（私钥在本机，不用 token）
- Claude Code 自动上报钩子：开始 / 工具调用 / 结束
- 实时事件类型：`start` / `step` / `cmd` / `end` / `blocked` / `error` / `note`
- 工作状态：`working` / `idle` / `blocked` / `done`
- 完成摘要口径：「做成了什么 / 怎么证明 / 还差什么」
- 派活队列：`handoff-inbox`
- 零 token 心跳（证明 Agent 还活着，不是僵尸）

**先读它的 `SKILL.md` 和 `README.md`，把事件模型和身份模型搞清楚。**

### 2.2 `agent-office-fix/office_adapter`（`~/Desktop/leo/agent-office-fix/`）

Python 写的执行层，**作为设计参考，不要直接搬代码**（技术栈不同）。

值得借鉴的设计：
- **任务状态机**：`queued` → `claimed` → `running` → `done` / `failed` / `cancelled` / `blocked`
- **原子领取**：`UPDATE ... WHERE status='queued'` 靠 rowcount 判断，不搞"先查再改"
- **租约制**：心跳过期才算失效，不靠 PID 探测（Windows 上不可靠）
- **fencing token**：每次持有 +1，旧持有者的写入被丢弃
- **配额按 task_id 累计**，不是按单次 Job，防止拆任务绕过限制
- **prompt 落库只存 sha256 + 长度 + 预览**，全文落文件

**读它的 `V0.1.3-REPORT.md` 里关于"租约制"和"fencing token"的部分**，这两个设计踩过坑，别重蹈覆辙。

---

## 3. 第一阶段做什么

### 3.1 技术栈约束（必须先看）

**Node 版本：v20.19.2** —— 没有内置 `node:sqlite`。

**数据库用 `node-sqlite3-wasm`，不要用 `better-sqlite3`。**

原因：这台机器**没有 C++ 编译工具链**，`better-sqlite3` 装不上（实测 `node-gyp` 编译失败）。`node-sqlite3-wasm` 是纯 WASM，秒装。

已经装好了，用法：

```js
import pkg from 'node-sqlite3-wasm';
const { Database } = pkg;          // 注意：必须解构 default
const db = new Database('./data.db');
db.exec('CREATE TABLE ...');
db.run('INSERT INTO t VALUES (?)', ['x']);
db.get('SELECT * FROM t');          // 单行
db.all('SELECT * FROM t');          // 多行
db.close();
```

**API 差异，注意：**
- `require('node-sqlite3-wasm')` 返回 `{ default: {...} }`，必须 `pkg.default` 或解构
- 没有 `.prepare()` 的迭代器语义，用 `.all()` / `.get()`
- 事务用 `db.exec('BEGIN IMMEDIATE')` / `COMMIT` / `ROLLBACK` 手动控制

**如果 `node-sqlite3-wasm` 不够用（比如并发写有性能问题），停下来报告，不要自己换成 `better-sqlite3` 然后卡在编译上。**

### 3.2 第一阶段做什么

### 范围（只做这些）

**Task 1.1 — 项目骨架**
- `package.json`（ESM，`"type": "module"`）
- 目录结构：`src/`、`test/`、`docs/`
- SQLite 初始化（**用 `node-sqlite3-wasm`**，原因见 §3.1，不要用 `better-sqlite3`）
- 数据库 schema：`agents`、`tasks`、`events` 三张表
- 一个能跑通的 `npm test`（哪怕只有 1 个测试）

**Task 1.2 — Agent 注册与状态**
- `POST /api/agents/register` — Agent 注册（名字、类型、能力）
- `PATCH /api/agents/:id/status` — 更新状态（working/idle/blocked/done）
- `GET /api/agents` — 列表，含最后活跃时间、当前任务
- 状态必须有**心跳超时判定**：超过 N 秒没心跳，显示为 `stale`，不是 `working`

**Task 1.3 — 任务提交与领取**
- `POST /api/tasks` — 提交任务（自然语言描述 + 指派给谁）
- `POST /api/tasks/:id/claim` — 原子领取
- `PATCH /api/tasks/:id/status` — 状态流转
- `GET /api/tasks` — 列表，支持按状态筛
- **原子领取必须防并发**：两个 Agent 同时领同一个任务，只能有一个成功

**Task 1.4 — 事件流**
- `POST /api/events` — 上报事件（复用 soda-agent-workspace 的事件类型）
- `GET /api/tasks/:id/events` — 查某任务的事件流
- 事件要带时间戳、来源 Agent、类型

### 不做什么（明确排除）

- ❌ 不做前端界面（第二阶段的活）
- ❌ 不做自然语言编排（第二阶段的活）
- ❌ 不做 Agent 之间的通信（第三阶段的活）
- ❌ 不做权限系统（先单机跑通）
- ❌ 不碰浏览器、不碰 GPT

---

## 4. 硬性要求

### 4.1 安全

- **不存任何 token / 密钥 / Cookie**，身份用 ed25519 签名
- **不在日志里打印凭证**
- 用户输入要校验，不能直接拼进 SQL

### 4.2 正确性

- **原子领取必须真原子**：两个并发请求只能有一个成功。写测试证明它。
- **心跳超时要能判断 Agent 是死了还是卡了**，不能因为超时就判死
- **不编数据**：查不到就返回空，不返回假数据

### 4.3 交付标准（每个 Task 都要满足）

1. 代码能跑，`npm test` 全过
2. 有测试覆盖核心逻辑（不是只有 happy path）
3. 报告三段式：**改了什么 / 验证了什么（附真实输出）/ 还差什么**
4. 不许说"应该可以" —— 要么跑过，要么说没跑

---

## 5. 工作方式

### 你会收到什么

每次一个 Task，包含：
- 做什么
- 验收标准（怎么算完成）
- 边界（不许碰什么）

### 你要怎么回报

做完一个 Task 后，停下来报告：

```
## Task 1.1 完成

改了什么：
- package.json（ESM，零依赖）
- src/db.js（建表）
- test/db.test.js（3 个测试）

验证了什么：
$ npm test
Ran 3 tests, all passed

还差什么：
- 还没做 API 层
```

**Lemate 验收通过后，才会给你下一个 Task。**

---

## 6. 遇到问题怎么办

- **不确定就问**，不要猜。猜错了返工成本更高。
- **卡住了就说卡在哪**，不要假装完成了。
- **发现任务书有问题**，直接说，不要硬做。

---

## 7. 第一条指令

现在开始 **Task 1.1**。

具体做：

1. 在 `Soda Office/` 建 Node ESM 项目骨架
2. SQLite schema：`agents`（id, name, type, status, last_heartbeat, capabilities, created_at）、`tasks`（id, title, description, assignee, status, claimed_at, created_at, result_path）、`events`（id, task_id, agent_id, type, payload, created_at）
3. 写 `src/db.js` 导出初始化和查询函数
4. 写 `test/db.test.js`，至少 3 个测试：建表、插入 Agent、查询 Agent
5. 跑 `npm test` 确认通过

**先报告你的计划（3 行以内），我确认后你再写代码。**

这是为了对齐 —— 避免你写了 500 行之后发现方向不对。
