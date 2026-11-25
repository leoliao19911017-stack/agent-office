# 08 最终验收与交付

> run: `3d22e663-a27f-417c-829b-b6b7fbcc5fad`
> 需求：任务归档 / 删除 / 恢复 + 工作流关联
> 评审：Codex 终审 **8.3 / 10**（目标 8.0）✅

---

## 一、需求达成情况

**Leo 原话：**
> 可以批量删，归档，恢复，正在跑的不能删需要先停

**结构要求：**
> 工作流是固定的，任务不是固定的。任务列表是我这一个需求要做哪些事。

| 需求项 | 状态 | 证据 |
|---|---|---|
| 归档 | ✅ | `archived_at` + `archived_from`，不改 status |
| 删除（软删） | ✅ | `deleted_at`，行保留，可恢复 |
| 恢复 | ✅ | 用 `archived_from` 还原原状态 |
| 批量操作 | ✅ | archive / delete / restore 逐条返回 |
| 正在跑不能删 | ✅ | 409 `TASK_RUNNING` + 「停止」按钮 |
| 先停再删 | ✅ | 停止绑定 attempt_id，防误杀新实例 |
| 任务挂到工作流 | ✅ | `workflow_run_id` + `workflow_step_id` |
| 任务显示步骤标签 | ✅ | 界面显示「05 开发执行」等 |

---

## 二、交付物清单

### 数据库
```
迁移 v7 → v8   tasks 加 archived_at / archived_from / deleted_at
迁移 v8 → v9   tasks 加 workflow_run_id / workflow_step_id + 索引
迁移 v9        未变
```

### 后端
```
web/lib/db.mjs                 迁移 + 事务工具
web/lib/tasks.mjs              查询过滤（visibility / workflow）
web/lib/state-machine.mjs      状态推导（completed 不再变 idle）
web/api-tasks.mjs              archive/restore/delete/batch/stop + 四入口守卫
web/api-workflow-runs.mjs      批量建任务 + archived_at 透传
```

### 前端
```
web/board-cromma.html          回收站入口 / 停止按钮 / 工作流下拉
web/board-cromma.js            批量选择 + 筛选清空 + 停止确认绑实例
web/board-cromma.css           归档灰显 / 已删除样式 / 确认态
```

### 测试（60 条，全过）
```
test/tasks-archive.test.js       12 条  A1-A10
test/tasks-workflow-link.test.js 17 条  B1-B11
test/tasks-rework.test.js        31 条  C1-C10 + D1-D5 + E1-E5
```

### 证据
```
docs/runs/run-3d22e663/07-review.md       第一轮 6.9 分
docs/runs/run-3d22e663/07-review-r2.md    第二轮 7.8 分
docs/runs/run-3d22e663/07-review-r3.md    第三轮 8.3 分 ✅
docs/screenshots/tasks-archive/           3 张
docs/screenshots/tasks-workflow-link/     11 张
docs/screenshots/tasks-rework/            18-25
docs/screenshots/tasks-rework-r3/         14 张
```

---

## 三、我实际验证过的（不只是信报告）

```
60 条测试自己跑                       → 60/60 pass
界面：分类 完成10 / 每行 1/1 / 下拉无归档  → 实测通过
P1-1 切筛选清空选择                   → 实测 DOM，已选消失
P1-2 已删除不能启动                   → 实测 409 TASK_DELETED
D1 接口返回 completed 不再是 idle      → 实测接口
```

---

## 四、三轮评审记录（这是工作流价值的证据）

| 轮次 | 分数 | 发现的问题 | 结果 |
|---|---|---|---|
| 第一轮 | 6.9 | 4 个 P1（隐藏任务误操作、删除后能启动、恢复状态漂移、审计非原子） | 不达标，返工 |
| 第二轮 | 7.8 | 新发现 1 P1 + 2 P2（停止误杀、多实例死局、详情半提交） | 不达标，返工 |
| 第三轮 | **8.3** | 2 个 P2/P3 不阻断（交接入口绕过单实例、刷新误清确认） | **达标** |

**三轮共修复 7 个真实缺陷，全部是独立评审发现、我自测没发现的。这就是为什么要第三方评审。**

---

## 五、遗留问题（登记，不阻断本次交付）

| 编号 | 严重度 | 问题 | 建议 |
|---|---|---|---|
| R3-1 | P2 | `handoff` 入口绕过单活动实例约束 | 后续统一到 attempt 守卫 |
| R3-2 | P3 | 页面刷新会清掉仍然有效的停止确认 | 加实例指纹校验 |
| 历史 | — | 全量测试 10 条失败（g02/g07 旧 UI 颜色断言） | 与本次无关，单独清理 |
| 历史 | — | 批量建任务只有 API，界面无入口 | 需要时再加 |

---

## 六、Codex 评审边界声明

> 本结论覆盖任务管理、三条返工路径及实际显示检查；**未执行全项目测试、压力测试或完整权限渗透**，不对此作通过声明。

**我也不能声称「这个功能完美」——只能声称「按 21 条验收标准 + 三轮评审，达到 8.3 分」。**
