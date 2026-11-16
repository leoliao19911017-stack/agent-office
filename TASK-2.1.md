# Task 2.1 任务书 — 租约、Claim Token 与安全恢复

> 来源：GPT 架构评审 Q3 + P0
> 前置：Task 1.1–1.4 已验收（40 个测试全过）

---

## 背景：为什么现在必须做

现在的原子领取（`UPDATE ... WHERE status='queued'`）只解决「两个 Agent 同时抢」的问题。

**解决不了「抢到之后崩溃」**——任务会永远卡在 `claimed`。

GPT 评审时明确纠正了一个说法：

> 心跳确实是判断 Agent 最近是否活跃的重要证据，**但心跳超时不能证明旧 Agent 进程已经死亡**。可能出现系统睡眠、进程暂停、网络抖动、事件循环阻塞，以及进程仍在执行却无法上报心跳。

**所以：租约过期 ≠ 进程已死。** 处置方式必须是「先怀疑，不直接判死」。

---

## 做什么

### 1. 数据库 schema 变更（`src/db.js`）

`tasks` 表新增 4 个字段：

```sql
claim_token      TEXT,      -- 领取凭证，crypto.randomUUID() 生成，不可预测
lease_expires_at INTEGER,   -- 租约到期时间（epoch ms）
attempt          INTEGER DEFAULT 0,   -- 第几次被领取
current_run_id   TEXT       -- 当前执行批次标识
```

**必须写迁移逻辑**：已有库（没有这些列的）能安全升级，不丢数据。

---

### 2. 改造 `claimTask`

**原实现**（保留原子性，但要扩展）：

```js
UPDATE tasks SET status='claimed', assignee=?, claimed_at=?
WHERE id=? AND status='queued'
```

**新实现**必须在**同一条 UPDATE** 里一起写入：

- `claim_token` = `randomUUID()`
- `lease_expires_at` = `Date.now() + LEASE_MS`（默认 90000）
- `attempt` = `attempt + 1`
- `current_run_id` = 新生成的 run id

返回值必须包含 `claim_token`（调用方要拿它续约）。

**仍然只允许 `status='queued'` 的可被领取。**

---

### 3. 新增函数

**`renewLease(db, taskId, claimToken, leaseMs)`**

```sql
UPDATE tasks
SET lease_expires_at = ?
WHERE id = ? AND claim_token = ? AND status IN ('claimed','running')
```

- 成功返回 `{ ok: true, lease_expires_at }`
- Token 不匹配 / 任务已结束 → `{ ok: false, reason: 'token_mismatch' | 'not_active' }`
- **续约必须校验 token**，否则旧执行者能续上已失效的租约

**`updateTaskStatusWithToken(db, taskId, claimToken, status, extras)`**

在原有 `updateTaskStatus` 基础上**增加 token 校验**：

```sql
UPDATE tasks SET status=?, result_path=?, ...
WHERE id=? AND claim_token=?
```

- Token 不匹配 → `{ ok: false, reason: 'token_mismatch' }`，**不写入**
- 这是防止「旧执行者失去所有权后覆盖新结果」的关键

**`listSuspectTasks(db, nowMs)`**

返回所有 `status IN ('claimed','running')` 且 `lease_expires_at < nowMs` 的任务。

**注意：这里只是「可疑」，不是「可回收」。**

**`resolveSuspectTask(db, taskId, action, opts)`**

处置可疑任务，`action` 只能是：

- `'requeue'` — 重新放回队列（`status='queued'`，清空 claim_token/assignee，保留 attempt 计数）
- `'block'` — 标记为 `blocked`（人工介入）
- `'fail'` — 标记为 `failed`

**必须校验当前状态确实是可疑的**，不能被用来强行改正常任务。

---

### 4. API 接口（`src/server.js`）

**`POST /api/tasks/:id/renew`**

```json
{ "claim_token": "uuid" }
```

- 成功 `200`：`{ ok: true, lease_expires_at }`
- Token 不匹配 `409`：`{ ok: false, reason: "token_mismatch" }`
- 任务不存在 `404`

**`PATCH /api/tasks/:id/status` 增强**

请求体新增必填 `claim_token`（除非是终态 `cancelled`）：

```json
{ "claim_token": "uuid", "status": "running", "result_path": "..." }
```

- Token 不匹配 → `409`
- 缺 token 且不是 cancelled → `400`

**`GET /api/tasks/suspect`**

返回可疑任务列表（租约过期的）：

```json
{ "tasks": [ { ...task, "lease_expired_ms": 5000 } ] }
```

**`POST /api/tasks/:id/resolve`**

```json
{ "action": "requeue" }
```

- 只能对可疑任务操作，否则 `409`
- 返回处置后的任务

---

## 验收标准

### 写 `test/lease.test.js`，至少 14 条

**租约基础（5 条）**
1. 领取后 `claim_token` 不为空、`lease_expires_at` 在未来、`attempt` 为 1
2. 续约成功，`lease_expires_at` 变晚
3. 用错误 token 续约 → 失败，`reason: 'token_mismatch'`
4. 用正确 token 但任务已完成 → 续约失败，`reason: 'not_active'`
5. 第二次领取（任务 requeue 后）`attempt` 变成 2

**所有权保护（3 条，**核心**）**
6. 用错误 token 更新状态 → 拒绝，**且数据库里的状态没变**
7. 用正确 token 更新状态 → 成功
8. **模拟场景**：A 领取 → 人为让租约过期 → B 领取（requeue 后）→ **A 再用旧 token 提交结果，必须被拒绝**

**可疑任务处置（4 条）**
9. 租约过期后任务出现在 `listSuspectTasks` 里
10. 租约未过期的任务**不**出现在可疑列表
11. `requeue` 后状态回 `queued`，`claim_token` 被清空，`attempt` 保留
12. 对正常任务调 `resolve` → 拒绝

**并发与迁移（2 条）**
13. 10 个并发领取同一任务，仍是只有 1 个成功（回归测试，不能破坏原有原子性）
14. 老库（无新字段）能迁移成功，原有数据不丢

---

## 边界（不许做）

- ❌ 不做 Web 界面（Task 2.2）
- ❌ 不做真实 Agent 接入（Task 2.3）
- ❌ 不做心跳自动续约的后台任务（Agent 自己负责续约，Office 只提供接口）
- ❌ 不改 Task 1.1–1.4 的已有测试
- ❌ 不加新依赖

---

## 关键约束

**1. 所有校验必须在 SQL 的 WHERE 里，不能先查再改**

续约、状态更新都要把 `claim_token` 放进 WHERE 条件，靠 `changes` 判断。

**2. 可疑任务绝不自动回收**

`listSuspectTasks` 只返回列表，不自动 requeue。必须人工或策略明确调用 `resolve`。

理由：心跳过期不能证明进程已死（GPT 评审原话）。

**3. 迁移要幂等**

重复执行不出错。

---

## 报告格式

```
## Task 2.1 完成

改了什么：
- src/db.js（schema 迁移 + 4 个新函数）
- src/server.js（3 个新接口 + 增强 PATCH）
- test/lease.test.js（14 个测试）

验证了什么：
$ npm test
（真实输出，40 + 14 = 54 个）

所有权保护测试的真实结果：
- 旧 token 提交被拒绝：是/否
- 数据库状态是否被污染：是/否

还差什么：
```

**真跑测试，不许说"应该能过"。**
