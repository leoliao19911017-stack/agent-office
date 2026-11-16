# Task 1.4 任务书 — 事件流

> 前置：Task 1.1 / 1.2 / 1.3 已验收（28 个测试全过）

---

## 做什么

这是第一阶段的最后一块。做完之后，Soda Office 就具备了「看得见 Agent 在干什么」的最小能力。

### 1. 数据库层（`src/db.js`）

**`insertEvent(db, event)`**
- 入参：`{ task_id, agent_id, type, payload }`
- `type` 必须在 `EVENT_TYPES` 里（`start/step/cmd/end/blocked/error/note`），否则抛 `RangeError`
- `payload` 是任意对象，序列化为 JSON 字符串落库，默认 `{}`
- `task_id` / `agent_id` 可为 null（有些事件不绑定任务或 Agent）
- `created_at = Date.now()`
- 返回落库后的行

**`listEventsByTask(db, taskId, { limit })`**
- 按 `created_at` 升序（事件流要看时间顺序）
- 默认 `limit = 100`，最大 1000
- 返回数组

**`listRecentEvents(db, { limit })`**
- 全量最近事件，按 `created_at` 倒序
- 默认 `limit = 50`

### 2. API 接口（`src/server.js`）

**`POST /api/events`**

```json
{
  "task_id": "uuid 或 null",
  "agent_id": "uuid 或 null",
  "type": "step",
  "payload": { "message": "正在写登录页" }
}
```

- 成功 `201`，返回落库的事件行（`payload` 返回时是**对象**，不是字符串 —— 输出前 parse 回来）
- `type` 非法 → `400`
- `task_id` 给了但任务不存在 → `404`
- `agent_id` 给了但 agent 不存在 → `404`

**`GET /api/tasks/:id/events`**

- 查参数 `?limit=50`
- 返回 `{ events: [...] }`
- 任务不存在 → `404`
- **payload 必须是对象**，不能直接把库里的 JSON 字符串吐出去

**`GET /api/events`**

- 全部最近事件，`?limit=50`
- 返回 `{ events: [...] }`

---

## 验收标准

### 写 `test/api.events.test.js`，至少 10 条

1. 上报事件 201，字段完整，payload 返回是对象
2. 非法 type → 400
3. task_id 指向不存在的任务 → 404
4. agent_id 指向不存在的 agent → 404
5. task_id / agent_id 都为 null 也能上报成功（系统级事件）
6. `GET /api/tasks/:id/events` 返回该任务的事件，**按时间升序**
7. limit 参数生效（发 10 条，`?limit=3` 只返回 3 条）
8. 不存在的任务查事件 → 404
9. **payload 中文不丢、嵌套对象往返无损**（`{"a":{"b":[1,2,"三"]}}` 存进去再查出来必须一样）
10. `GET /api/events` 返回最近事件，倒序

**额外要求（完整性）**：
11. **完整流程测试**：创建任务 → 领取 → 上报 3 个事件（start/step/end）→ 查事件流 → 顺序正确
12. `limit` 超过 1000 时被截到 1000（不报错，静默截断）

---

## 边界（不许做）

- ❌ 不做前端界面（第二阶段）
- ❌ 不做自然语言编排（第二阶段）
- ❌ 不加新依赖
- ❌ 不改已有的三个测试文件
- ❌ 不做 WebSocket / SSE 实时推送（第二阶段再说）

---

## 报告格式

```
## Task 1.4 完成

改了什么：
- ...

验证了什么：
$ npm test
（真实输出，应该是 28 + 12 = 40 个测试）

还差什么：
- 第一阶段整体完成情况
```

---

## 完成后额外做一件事

写一份 `docs/PHASE1-REPORT.md`，包含：

1. **做了什么**：四个 Task 各自交付了什么
2. **API 清单**：所有接口的路径、方法、用途（表格）
3. **数据库 schema**：三张表的字段说明
4. **测试覆盖**：多少个测试，覆盖了什么
5. **已知限制**：还没做的、有隐患的

这份报告是给下一个接手的人看的，要能让他 5 分钟上手。
