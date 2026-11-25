# TASK：任务归档 / 删除 / 恢复

> run: `3d22e663-a27f-417c-829b-b6b7fbcc5fad` · 步骤 04 开发计划与任务书
> 目标分 8 分 · 由 Codex 评审

## 一、需求（不可改）

任务列表要支持手动删除、归档、恢复、批量操作；正在运行的任务不能删，需要先停止。
归档不改状态改 `archived_at`，恢复时还原原状态。

原文：`docs/runs/run-3d22e663/01-requirement.md`

## 二、验收标准（10 条）

| # | 标准 | 验证方式 |
|---|---|---|
| A1 | `POST /api/tasks/:id/archive` 把 `archived_at` 写成当前时间 | 查 DB |
| A2 | 归档不改 `status` | 归档前后查 status 一致 |
| A3 | 归档后默认列表不返回该任务 | `GET /api/tasks` 断言不含 |
| A4 | `GET /api/tasks?include_archived=1` 能返回 | 断言含 |
| A5 | `POST /api/tasks/:id/restore` 用 `archived_from` 还原原状态 | 归档前 running → 恢复后仍 running |
| A6 | `archived_at` 置空 | 查 DB |
| A7 | `DELETE /api/tasks/:id` 对 running 返回 409 | 断言 status code |
| A8 | `DELETE` 对非 running 是软删（`deleted_at`） | 查 DB，行还在 |
| A9 | 批量：`POST /api/tasks/batch` 支持 archive/delete/restore，逐条返回结果 | 一次 3 条，1 条 running，断言 2 成功 1 失败且各自有原因 |
| A10 | 归档/删除/恢复都要写 event 记录（谁、何时、什么操作） | 查 events 表 |

## 三、技术约束

- SQLite 已有 `tasks` 表，加列用迁移，**不许删表重建**
- 所有写操作走 `web/api-tasks.mjs`，不新建路由文件
- 迁移版本 +1，写在 `web/lib/db.mjs`
- 前端：任务列表每行加「归档/删除」按钮，顶部加批量选择 + 批量操作条
- 归档的视觉：灰显 + 「已归档」标签
- 禁止：无条件 `git add -A`

## 四、必须自己做的事

1. 写代码
2. 写测试（`test/tasks-archive.test.js`，覆盖 A1-A10）
3. **自己跑测试并把真实输出贴出来**
4. **自己起服务、自己截图**，存 `docs/screenshots/tasks-archive/`
5. 对着截图自己检查：按钮在不在、点了有没有反应

## 五、交付物

- 代码改动清单
- 测试文件 + 真实运行输出
- 截图 3 张（列表含按钮、归档后灰显、批量选择状态）
- 一份 `docs/runs/run-3d22e663/05-dev-report.md`，写：改了什么、测了什么、还差什么

## 六、禁止事项

- 不许修改 `docs/runs/run-3d22e663/01-requirement.md`
- 不许改 `workflow_runs.requirement_baseline`
- 不许在跑全量测试时连生产库（用临时库）
