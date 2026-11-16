# Soda Office 第一阶段交付报告

> 2026-11-12 · Task 1.1 – 1.4 全部完成，40 个测试全过。本报告给下一个接手的人，读完即可上手。

## 1. 做了什么

| Task | 交付 | 状态 |
|---|---|---|
| 1.1 数据库层 | `src/db.js`：建表（agents / tasks / events）+ CRUD + 外键约束。驱动 node-sqlite3-wasm，零编译工具链 | ✅ 已验收 |
| 1.2 Agent API | `POST /api/agents/register`、`PATCH /api/agents/:id/status`、`GET /api/agents`（含 stale 判定）。口径：注册即首次心跳，状态更新即心跳 | ✅ 已验收 |
| 1.3 任务 API | `POST /api/tasks`、`POST /api/tasks/:id/claim`（原子领取）、`PATCH /api/tasks/:id/status`、`GET /api/tasks?status=`。并发安全靠单条条件 UPDATE（20 并发 5 轮压测 PASS） | ✅ 已验收 |
| 1.4 事件流 | `POST /api/events`、`GET /api/tasks/:id/events`（升序）、`GET /api/events`（倒序）。payload 落库为 JSON 字符串，所有出口还原为对象 | ✅ 本次完成 |

做完这四块，Soda Office 具备了「看见 Agent 在干什么」的最小能力：Agent 注册 → 领任务 → 干活时上报事件 → 人查事件流。

## 2. API 清单

| 方法 | 路径 | 用途 | 成功 | 主要错误 |
|---|---|---|---|---|
| POST | `/api/agents/register` | 注册 Agent（重名 409） | 201 | 400 缺/空 name、409 重名 |
| GET | `/api/agents` | 全量列表，附计算字段 `stale` | 200 | — |
| PATCH | `/api/agents/:id/status` | 改状态并刷心跳 | 200 | 400 非法状态、404 无此 Agent |
| POST | `/api/tasks` | 建任务（默认 queued） | 201 | 400 缺 title、404 assignee 不存在 |
| GET | `/api/tasks?status=` | 任务列表（created_at 倒序，可按状态筛） | 200 | 400 非法 status 筛选值 |
| POST | `/api/tasks/:id/claim` | 原子领取（唯一 409 接口） | 200 `{ok:true,task}` | 400 缺 agent_id、404、409 `{ok:false,reason:'not_queued'}` |
| PATCH | `/api/tasks/:id/status` | 状态流转，可附 result_path | 200 | 400 非法状态、404 |
| POST | `/api/events` | 上报事件（task_id/agent_id 可 null） | 201 | 400 非法 type/payload、404 引用不存在 |
| GET | `/api/tasks/:id/events?limit=` | 该任务事件流，**时间升序** | 200 `{events}` | 404 无此任务 |
| GET | `/api/events?limit=` | 全量最近事件，**时间倒序** | 200 `{events}` | — |

约定：错误统一 `{ error, code }`（claim 409 例外，按契约返回 `{ ok, reason }`）；时间戳一律 epoch 毫秒；limit 对事件查询默认 100/50、最大 1000（超过静默截断）。

## 3. 数据库 Schema

三张表，完整字段说明见 `docs/schema.md`。

- **agents** — `id`(UUID PK) / `name` / `type`(默认 unknown) / `status`(working·idle·blocked·done) / `last_heartbeat` / `capabilities`(JSON 数组字符串) / `created_at`
- **tasks** — `id`(UUID PK) / `title` / `description` / `assignee`→agents / `status`(queued→claimed→running→done·failed·cancelled·blocked) / `claimed_at` / `created_at` / `result_path`
- **events** — `id`(AUTOINCREMENT) / `task_id`→tasks(可 null) / `agent_id`→agents(可 null) / `type`(start·step·cmd·end·blocked·error·note) / `payload`(JSON 字符串，默认 {}) / `created_at`

索引：`idx_tasks_status`、`idx_events_task_id`、`idx_events_agent_id`。连接打开即 `PRAGMA foreign_keys = ON`。

## 4. 测试覆盖

`npm test` = `node --test test/`，共 **40 个测试，全过**：

| 文件 | 数量 | 覆盖 |
|---|---|---|
| `test/db.test.js` | 5 | 建表字段、插入/查询、文件持久化、非法输入拒收、外键真实生效 |
| `test/api.agents.test.js` | 11 | 注册/重名/负路径、状态更新刷心跳、stale 判定（STALE_MS 可调）、错误形状统一 |
| `test/api.tasks.test.js` | 12 | 建任务、原子领取（HTTP 与 DB 层各 10 并发，恰好 1 赢）、状态流转、列表筛选 |
| `test/api.events.test.js` | 12 | 上报 201/400/404、null 引用（系统级事件）、升序/倒序、limit 生效与 1000 截断、中文嵌套 payload 往返无损、建任务→领取→start/step/end 全流程 |

## 5. 已知限制

1. **无鉴权** — 任何能连到端口的人都能调所有接口。单机内网可用，公开部署前必须加。
2. **无实时推送** — 事件只能轮询拉取；WebSocket/SSE 留第二阶段。
3. **事件无清理机制** — events 表只增不减，长期跑会无限膨胀（limit 只保护查询，不保护存储）。
4. **单进程** — 内存库/文件库都是单连接同步驱动，没有多进程并发场景；换真并发驱动时 claim 的单条 UPDATE 语义仍成立，但其余代码未做压力验证。
5. **limit 静默截断** — 超过 1000 不报错只截断，调用方若不知情可能以为拿全了（任务书口径如此，记录在案）。
6. **前端、自然语言编排** — 均为第二阶段范围，本阶段未涉及。

## 接手 5 分钟上手

```bash
npm install        # 唯一依赖 node-sqlite3-wasm
npm test           # 40 个测试，全过即环境正常
```

起服务（一条命令，文件库落盘 `soda-office.db`，端口 3100）：

```bash
node --input-type=module -e "import { initializeDatabase } from './src/db.js'; import { startServer } from './src/server.js'; startServer({ port: 3100, db: initializeDatabase('soda-office.db') }); console.log('listening :3100');"
```

冒烟（注册 → 建任务 → 上报事件 → 查事件流）：

```bash
curl -s localhost:3100/api/agents/register -H 'content-type: application/json' -d '{"name":"demo"}'
curl -s localhost:3100/api/tasks -H 'content-type: application/json' -d '{"title":"演示"}'
curl -s localhost:3100/api/events -H 'content-type: application/json' -d '{"type":"note","payload":{"消息":"你好"}}'
curl -s localhost:3100/api/events
```

要点：`startServer({ port, db })` 必须传 `db`（`initializeDatabase(path)` 创建，`:memory:` 或文件路径）；测试文件里每个用例都是现成的调用示例。
