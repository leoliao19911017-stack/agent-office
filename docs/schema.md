# Soda Office 数据库 Schema（Task 1.1）

驱动：`node-sqlite3-wasm`（纯 WASM，无需编译工具链）。建表入口：`src/db.js` 的 `initializeDatabase(path)`，幂等可重入。

## 全局约定

- **时间戳**：INTEGER，Unix epoch 毫秒。数值比较即时间先后。
- **JSON 字段**（`capabilities` / `payload`）：以 JSON 字符串落库，读取方自行 `JSON.parse`。
- **外键**：连接打开即执行 `PRAGMA foreign_keys = ON`。`tasks.assignee`、`events.task_id`、`events.agent_id` 都带引用约束，指向不存在的行会被拒写。
- **查询口径**：查无返回 `null` / 空数组，不编数据。

## agents — Agent 注册表

| 列 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | 自动生成 UUID；将来可换成 ed25519 公钥派生 id（soda-agent-workspace 身份模型） |
| name | TEXT NOT NULL | Agent 名字，如 lemate |
| type | TEXT | 平台类型：claude-code / codex / dsh / hermes …，默认 unknown |
| status | TEXT | 工作状态，枚举见下，默认 idle |
| last_heartbeat | INTEGER | 最后心跳（对应 soda-agent-workspace 的 ping，只更新此值） |
| capabilities | TEXT | 能力 JSON 数组字符串，默认 `[]` |
| created_at | INTEGER | 注册时间 |

`status` 枚举（对齐 soda-agent-workspace，客户端 sync 只认这四个）：`working` / `idle` / `blocked` / `done`。
「心跳超时显示为 stale」是 Task 1.2 的**展示层判定**（由 `last_heartbeat` 与当前时间差推导），不是落库状态，本表不存 stale。

## tasks — 任务表

| 列 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | UUID |
| title | TEXT NOT NULL | 任务标题 |
| description | TEXT | 自然语言描述，默认空串 |
| assignee | TEXT → agents(id) | 指派给谁，可空（允许先入队后认领） |
| status | TEXT | 状态机见下，默认 queued |
| claimed_at | INTEGER | 被领取的时间，未领取为 NULL |
| created_at | INTEGER | 创建时间 |
| result_path | TEXT | 产物路径，可空 |

`status` 状态机（对齐 office_adapter 设计）：
`queued → claimed → running → done / failed / cancelled / blocked`

原子领取与 fencing token 是 Task 1.3 的实现内容，本表先备好 `claimed_at` / `status` 字段。

## events — 事件流

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK AUTOINCREMENT | 单调递增，天然的事件先后顺序 |
| task_id | TEXT → tasks(id) | 关联任务，可空（允许 Agent 级事件） |
| agent_id | TEXT → agents(id) | 来源 Agent，可空（允许系统事件） |
| type | TEXT NOT NULL | 事件类型，枚举见下 |
| payload | TEXT | JSON 字符串（对应 soda-agent-workspace 事件的 detail），默认 `{}` |
| created_at | INTEGER | 上报时间 |

`type` 枚举（对齐 soda-agent-workspace 第六节）：`start` / `step` / `cmd` / `end` / `blocked` / `error` / `note`

## 索引

- `idx_tasks_status` — 按状态筛任务（Task 1.3 `GET /api/tasks?status=`）
- `idx_events_task_id` — 查某任务的事件流（Task 1.4）
- `idx_events_agent_id` — 查某 Agent 的事件流
