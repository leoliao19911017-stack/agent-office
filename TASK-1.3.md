# Task 1.3 任务书 — 任务提交与原子领取

> 前置：Task 1.1 / 1.2 已验收（16 个测试全过）

---

## 这一关是整个项目最难的部分

**原子领取**：两个 Agent 同时领同一个任务，**只能有一个成功**。

这不是"先查状态再更新"能解决的 —— 中间有竞态窗口。必须靠数据库层面的原子操作。

**如果你做出来的实现，在并发测试里两个都成功了，等于没做。**

---

## 做什么

### 1. 数据库层补充（`src/db.js`）

加以下函数，**不要动已有函数**：

**`insertTask(db, task)`**
- 入参：`{ title, description, assignee, status }`
- `title` 必须非空字符串
- `status` 默认 `'queued'`，必须在 `TASK_STATUSES` 里
- `assignee` 可为 null（未指派）
- 自生成 `id`（uuid），`created_at = Date.now()`
- 返回落库后的行

**`getTaskById(db, id)`** — 查无返回 null

**`listTasks(db, { status })`** — 按状态筛，不传返回全部，按 `created_at` 倒序

**`claimTask(db, taskId, agentId)`** ← **核心**

必须做到：
- **原子性**：用单条 `UPDATE ... WHERE id = ? AND status = 'queued'`，靠返回的 `changes` 数量判断是否抢到
- **绝不允许**"先 SELECT 判断 status 再 UPDATE"这种写法
- 抢到：`status = 'claimed'`、`assignee = agentId`、`claimed_at = Date.now()`，返回 `{ ok: true, task: <更新后的行> }`
- 没抢到（已被人领走/不存在）：返回 `{ ok: false, reason: 'not_queued' }`
- **注意 `node-sqlite3-wasm` 的 `db.run()` 返回什么** —— 先写个小实验搞清楚它有没有 `changes` 字段，没有就想别的办法（比如更新后再查一次并核对 `assignee`）

**`updateTaskStatus(db, taskId, status, extras)`** — `extras` 可带 `result_path`，返回更新后的行

### 2. API 接口（`src/server.js`）

**`POST /api/tasks`**

```json
{ "title": "写登录页", "description": "支持手机号+验证码", "assignee": "agent-id 或 null" }
```

- 成功 `201`，返回完整任务行
- `title` 缺失或空 → `400`
- `assignee` 给了但 agent 不存在 → `404`

**`POST /api/tasks/:id/claim`**

```json
{ "agent_id": "uuid" }
```

- 成功 `200`：`{ ok: true, task: {...} }`
- 被抢先：`409`，`{ ok: false, reason: "not_queued" }`
- 任务不存在：`404`
- `agent_id` 缺失：`400`
- **agent 不存在时也要 404**（不能让人拿假 id 领任务）

**`PATCH /api/tasks/:id/status`**

```json
{ "status": "running", "result_path": "/path/to/result.json" }
```

- 成功 `200`，返回更新后的行
- 非法状态 `400`，任务不存在 `404`

**`GET /api/tasks`**

- 支持 `?status=queued` 筛选
- 返回 `{ tasks: [...] }`

---

## 验收标准

### 必须写 `test/api.tasks.test.js`

**基础功能（7 条）**
1. 创建任务 201，字段完整，默认 status 是 queued
2. 缺 title → 400
3. assignee 指向不存在的 agent → 404
4. 领取成功 200，status 变 claimed，assignee 正确，claimed_at 有值
5. 领取已被领走的任务 → 409
6. 领取不存在的任务 → 404
7. `GET /api/tasks?status=queued` 只返回 queued 的

**并发原子性（3 条，**最重要**）**

8. **10 个并发领取同一任务，只有 1 个成功，9 个拿到 409**
   ```js
   const results = await Promise.all(
     Array.from({length: 10}, (_, i) =>
       fetch(`${base}/api/tasks/${taskId}/claim`, {
         method: 'POST', headers: {'content-type':'application/json'},
         body: JSON.stringify({ agent_id: agentIds[i] })
       }).then(async r => ({ status: r.status, body: await r.json() }))
     )
   );
   const wins = results.filter(r => r.status === 200);
   assert.equal(wins.length, 1, `期望 1 个成功，实际 ${wins.length} 个`);
   ```

9. **直接测数据库层的并发**：用 10 个并发的 `claimTask()` 调用（不经 HTTP），同样只有 1 个 `ok: true`

10. **领取后重复领取同一个任务（串行），第二次必须失败**

**状态流转（2 条）**

11. `PATCH` 状态到 running → done，`result_path` 正确落库
12. 非法状态 → 400

---

## 边界（不许做）

- ❌ 不做事件上报接口（Task 1.4）
- ❌ 不做前端
- ❌ 不加新依赖
- ❌ 不改 `test/db.test.js`、`test/api.agents.test.js`

---

## 特别注意

**这台机器的 Node 是 v20，用的是 `node-sqlite3-wasm`（WASM 版 SQLite），不是原生 better-sqlite3。**

WASM 版是**单线程同步**的，这实际上让并发测试更容易通过 —— 但你不能因此偷懒写成"先查再改"。**要求的是逻辑上的原子性**，即使将来换成真并发驱动也成立。

**先用小实验确认 `db.run()` 的返回值结构**，再写 `claimTask`。不确定就报告，不要猜。

---

## 报告格式

```
## Task 1.3 完成

改了什么：
- ...

验证了什么：
$ npm test
（真实输出，16 + 12 = 28 个测试）

并发测试的真实结果：
- 10 并发领取，成功 N 个（必须是 1）

还差什么：
- ...
```
