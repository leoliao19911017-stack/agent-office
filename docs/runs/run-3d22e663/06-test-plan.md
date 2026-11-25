# 测试用例方案与验收标准

> run: `3d22e663-a27f-417c-829b-b6b7fbcc5fad`
> 用途：06 步自测的口径依据 · 07 步 Codex 评审的对照表 · Lemate 独立验收的 checklist

---

## 一、需求基线（不可改）

> 可以批量删，归档，恢复，正在跑的不能删需要先停

结构要求（Leo 补充）：
> 工作流是固定的，任务不是固定的。任务列表是我这一个需求要做哪些事。

---

## 二、验收标准总表（21 条）

### 第一批：归档 / 删除 / 恢复（A1-A10）

| # | 验收标准 | 测试方法 | 通过判据 |
|---|---|---|---|
| A1 | archive 写 `archived_at` | 建 task → POST archive → 查 DB | `archived_at` 非空 |
| A2 | 归档不改 `status` | 归档前后各查一次 status | 两次完全相等 |
| A3 | 归档后默认列表不返回 | `GET /api/tasks` | 返回里没有该 task_id |
| A4 | `include_archived=1` 能返回 | `GET /api/tasks?include_archived=1` | 返回里有该 task_id |
| A5 | restore 用 `archived_from` 还原原状态 | running → 归档 → 恢复 → 查 status | 恢复后仍是 running |
| A6 | 恢复后 `archived_at` 置空 | 恢复后查 DB | 为 NULL |
| A7 | DELETE 对 running 返回 409 | `DELETE /api/tasks/:id`（running 任务） | HTTP 409 + code `TASK_RUNNING` |
| A8 | DELETE 非 running 是软删 | `DELETE`（pending 任务）→ 查 DB | `deleted_at` 有值，行还在 |
| A9 | batch 逐条返回，一条失败不影响其他 | 3 条中 1 条 running，批量删 | 2 成功 1 失败，各自有 code 和 message |
| A10 | 三操作都写 event | 归档/删除/恢复各做一次 → 查 events | 3 条记录，含 actor / at / action |

### 第二批：工作流关联（B1-B11）

| # | 验收标准 | 测试方法 | 通过判据 |
|---|---|---|---|
| B1 | 迁移 v9 加两列，旧行不丢 | 生产库副本跑 v8→v9 | 两列存在，旧行 15 列全等，rowid 不变 |
| B2 | 不删表重建 | grep `web/` | 无 `DROP TABLE` |
| B3 | POST 能带 `workflow_run_id` | 建一条带 run_id | DB 里两列有值 |
| B4 | 按 `workflow_run_id` 过滤 | 2 个 run 各 3 条 | 查询只返回对应 3 条 |
| B5 | 按 run + step 过滤 | 05 步 2 条、06 步 1 条 | 各查各的 |
| B6 | 不带 run_id 的老任务仍能查到 | 默认列表查询 | 老任务在列表里 |
| B7 | 批量建任务自动填两字段 | 一次建 5 条 | DB 里 5 条两字段全对 |
| B8 | 不存在的 run_id → 404 | POST 带假 run_id | 404 `RUN_NOT_FOUND` |
| B9 | run 里没这步 → 404 | POST 带假 step_id | 404 `STEP_NOT_FOUND` |
| B10 | 第一批 A1-A10 仍全过 | `node --test test/tasks-archive.test.js` | 12/12 pass |
| B11 | 界面按 run 过滤 + 步骤标签 | 截图 + DOM 断言 | 下拉存在；任务带「05 开发执行」等标签 |

---

## 三、测试用例方案（分层）

### L1 单元测试（自动化，已有）

```
test/tasks-archive.test.js        12 条  覆盖 A1-A10 + A9b + M1
test/tasks-workflow-link.test.js  17 条  覆盖 B1-B10
```

**执行：** `node --test test/tasks-archive.test.js test/tasks-workflow-link.test.js`

### L2 接口级测试（自动化，本方案新增）

**目的：** 不经 UI，直接打 HTTP，验证真实服务端行为（单测用的是临时库实例，L2 打的是真 8090）

| 用例 | 请求 | 断言 |
|---|---|---|
| L2-1 | 建 task（带 run+step） | 201/200，查 DB 两字段有值 |
| L2-2 | archive 它 | DB `archived_at` 非空，`status` 不变 |
| L2-3 | 默认列表查 | 不含它 |
| L2-4 | include_archived 查 | 含它 |
| L2-5 | restore 它 | `status` 还原，`archived_at` 为 NULL |
| L2-6 | 造一条 running，DELETE | 409 |
| L2-7 | 批量删 3 条（1 running） | 2 成功 1 失败 |
| L2-8 | 按 run 过滤 | 只返回该 run 的任务 |
| L2-9 | 批量建 5 条 | 5 条全入库，两字段对 |

### L3 界面级测试（自动化 DOM 断言 + 截图）

| 用例 | 断言 |
|---|---|
| L3-1 | 任务列表每行有「归档」「删除」按钮（DOM 计数 = 任务数 × 2） |
| L3-2 | 勾选任务后批量操作条出现（DOM 出现 `批量` 字样 + 已选 N 条） |
| L3-3 | 点归档 → 该行灰显 + 出现「已归档」标签 |
| L3-4 | 工作流下拉存在，选项含当前 run |
| L3-5 | 任务行显示步骤标签（如「05 开发执行」） |
| L3-6 | 控制台无 JS 报错 |

### L4 回归测试

```
全量 node --test test/*.test.js（临时库）
已知 10 条历史失败在 g02-flows / g07-r72 / g07-r73，不属本次范围
```

---

## 四、验收判定

**通过条件（三条同时满足）：**
1. L1 全部 29 条 pass（12 + 17）
2. L2 九条接口用例全部符合断言
3. L3 六条界面用例全部符合断言

**目标分：** Codex 评审 ≥ 8.0 / 10

**不通过处理：**
- 任一 L1 失败 → 回 05 修
- L2 失败 → 回 05 修
- L3 失败 → 回 05 修（界面问题）
- Codex 评分 < 8.0 → 按评审报告的返工项回 05
