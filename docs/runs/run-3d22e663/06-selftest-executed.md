# 06 自测执行报告（按验收标准实测）

> run: `3d22e663-a27f-417c-829b-b6b7fbcc5fad`
> 执行人：Lemate（自己按验收标准测，不依赖 Agent 自述）
> 依据：`06-test-plan.md`（21 条验收标准 + L1-L4 四层测试方案）

---

## 一、L1 单元测试（自动化）

```
node --test test/tasks-archive.test.js        → 12/12 pass
node --test test/tasks-workflow-link.test.js  → 17/17 pass
```

**A1-A10 + B10 通过。**

---

## 二、L2 接口级测试（打真服务 8090）

| 用例 | 结果 | 证据 |
|---|---|---|
| L2-1 建 task 带 run+step | ✅ PASS | DB 两字段有值 |
| L2-2 archive 成功 | ✅ PASS | `archived_at` 非空 |
| L2-3 归档后默认列表不含 | ✅ PASS | count=10（归档的 1 条不在） |
| L2-4 include_archived 含 | ✅ PASS | count=11 |
| L2-5 restore 成功 | ✅ PASS | status 还原 |
| L2-6 running DELETE → 409 | ✅ PASS | `status=409 TASK_RUNNING` |
| L2-7 批量删 3 条（1 running） | ✅ PASS | 2 成功 1 失败 |
| L2-8 按 run 过滤 | ✅ PASS | 全部归属正确 |
| L2-9 批量建 5 条 | ✅ PASS | `status=201 created=5` |

**9/9 通过。**

**过程中我自己的测试写错两次，代码是对的：**
- 第一次用不存在的 `POST /:id/claim` 造 running，任务一直是 waiting → 我的测试错
- 第二次断言 `status===200`，实际创建返回 201 → 我的断言错

---

## 三、L3 界面级测试（DOM 断言 + 视觉确认）

| 用例 | 结果 | 证据 |
|---|---|---|
| L3-1 每行有归档/删除按钮 | ✅ PASS | DOM 计数：归档 30 个、删除 30 个 |
| L3-2 勾选后出现批量条 | ✅ PASS | 「已选 1 条」+ 归档/删除/恢复三按钮可见 |
| L3-3 归档后灰显 + 标签 | ✅ PASS | 截图确认 |
| L3-4 工作流下拉存在 | ✅ PASS | `<select>` 存在，选项含当前 run |
| L3-5 任务显示步骤标签 | ✅ PASS | 「05 开发执行」等标签可见 |
| L3-6 无 JS 报错 | ✅ PASS | `window.__errs` 为空 |

**6/6 通过。**

---

## 四、任务完成情况（10 条）

| # | 任务 | 状态 | 依据 |
|---|---|---|---|
| 1 | 迁移 v8：加 archived_at / archived_from / deleted_at | completed | A1 A2 A5 A6 A8 通过 |
| 2 | listTasks 加 visibility 过滤 | completed | A3 A4 通过 |
| 3 | api-tasks 加四路由 | completed | A7 A9 A10 + L2-6 L2-7 通过 |
| 4 | 看板按钮 + 灰显 + 批量条 | completed | L3-1 L3-2 L3-3 通过 |
| 5 | test/tasks-archive.test.js | completed | 12/12 pass |
| 6 | 迁移 v9：加 workflow_run_id / workflow_step_id | completed | B1 B2 通过 |
| 7 | 按 run/step 过滤和写入 | completed | B3-B6 + L2-8 通过 |
| 8 | 批量建任务接口 | completed | B7-B9 + L2-9 通过 |
| 9 | 看板下拉 + 步骤标签 | completed | L3-4 L3-5 通过 |
| 10 | test/tasks-workflow-link.test.js | completed | 17/17 pass |

**10/10 completed。**

---

## 五、自测中顺手清理的数据

```
软删测试垃圾任务        19 条（L2批量 / L2-9 / 调试批量）
归档乱码 run            1 条（最早 curl 创建导致中文乱码）
剩余活任务              10 条（本需求的真实任务）
```

---

## 六、发现的真问题（不阻塞验收，但要记录）

1. **`POST /api/tasks/:id/claim` 接口不存在** —— 测试里我以为有，实际没有；任务怎么从 waiting 变 running 需要确认
2. **curl 发中文会乱码** —— 建 run 时必须用 node 或指定 UTF-8
3. **`database is locked`** —— Claude 发现的多进程并发缺陷，未修
4. **批量操作条在测试数据下验到了，但真实使用时数据为 0 时看不到**

---

## 七、结论

```
验收标准 21 条：A1-A10 ✅ · B1-B11 ✅
分层测试 L1 29 条 · L2 9 条 · L3 6 条，全部 PASS
任务清单 10 条，全部 completed
```

**具备提交 Codex 评审的条件。**
