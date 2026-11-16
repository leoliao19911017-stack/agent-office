# Task 1.2 任务书 — Agent 注册与状态

> 前置：Task 1.1 已验收通过（db.js + 5 个测试）

---

## 做什么

在 Task 1.1 的数据库层之上，加 **HTTP API 层** 和 **Agent 状态管理**。

### 1. HTTP 服务

新建 `src/server.js`：

- 用 **Node 内置 `node:http`**，不要引入 Express/Fastify（零依赖优先）
- 监听端口从 `process.env.PORT` 读，默认 `3100`
- 提供 `startServer({ port, db })` 函数，返回 server 实例（方便测试里指定端口和内存库）
- JSON 请求体解析（自己写，约 15 行）
- 统一错误响应：`{ error: string, code: string }`，HTTP 状态码要对

### 2. 三个接口

**`POST /api/agents/register`**

请求：
```json
{ "name": "Claude Code", "type": "claude-code", "capabilities": ["code", "review"] }
```

响应 `201`：
```json
{ "id": "uuid", "name": "Claude Code", "type": "claude-code", "status": "idle", "last_heartbeat": 1234567890, "capabilities": ["code", "review"], "created_at": 1234567890 }
```

- `name` 重复时返回 `409`，不覆盖
- 缺 `name` 或空串返回 `400`

**`PATCH /api/agents/:id/status`**

请求：
```json
{ "status": "working" }
```

响应 `200`：更新后的完整 agent 行

- `status` 必须在 `AGENT_STATUSES` 里，否则 `400`
- agent 不存在返回 `404`
- **每次更新状态时，自动刷新 `last_heartbeat = Date.now()`**（这是心跳，不是可选项）

**`GET /api/agents`**

响应 `200`：
```json
{ "agents": [ { ...agent, "stale": false } ] }
```

- 每个 agent 加一个计算字段 `stale`
- **判定规则**：`Date.now() - last_heartbeat > STALE_MS`（默认 60000，即 60 秒）则为 `true`
- `last_heartbeat` 为 `null` 也算 `stale: true`
- `STALE_MS` 要能从环境变量 `STALE_MS` 覆盖（测试要用）

### 3. 数据库层补充

在 `src/db.js` 里加：

- `updateAgentStatus(db, id, status)` — 同时刷新 `last_heartbeat`，返回更新后的行；不存在返回 `null`
- `findAgentByName(db, name)` — 注册时查重用

**不要动已有函数。**

---

## 验收标准

### 必须写测试 `test/api.agents.test.js`

至少覆盖：

1. 注册成功返回 201，字段完整
2. 重名注册返回 409
3. 缺 name 返回 400
4. 更新状态成功，**且 `last_heartbeat` 变新了**（断言前后值不同）
5. 非法状态返回 400
6. 更新不存在的 agent 返回 404
7. `GET /api/agents` 返回列表
8. **刚注册的 agent `stale: false`**
9. **把 `STALE_MS` 设成 1 毫秒，等 10 毫秒后查，`stale: true`**（证明超时判定真的生效）
10. `last_heartbeat` 为 null 的 agent，`stale: true`

### 测试怎么起服务

不要用固定端口（会撞）。用 `listen(0)` 拿随机端口：

```js
const server = startServer({ port: 0, db });
await new Promise(r => server.once('listening', r));
const { port } = server.address();
```

---

## 边界（不许做）

- ❌ 不做任务相关接口（Task 1.3）
- ❌ 不做事件上报（Task 1.4）
- ❌ 不做前端
- ❌ 不引入任何 npm 依赖
- ❌ 不改 `test/db.test.js`

---

## 报告格式

```
## Task 1.2 完成

改了什么：
- src/server.js（新增，xxx 行）
- src/db.js（加了 2 个函数）
- test/api.agents.test.js（10 个测试）

验证了什么：
$ npm test
（贴真实输出，含 pass/fail 数字）

还差什么：
- ...
```

**真跑测试，不许说"应该能过"。**
