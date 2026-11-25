# 任务归档/删除 —— 最终需求文档（待 Leo 确认）

> 工作流步骤 ③ 需求确认。Codex 讨论见 `03-confirm-discuss.md`（本轮 Codex CLI 不可用，先出文档，稍后补讨论记录）。

---

## 一、需求

任务列表要能清理。现在混着真实任务、测试残留、重复任务、状态不明的一堆，看不出哪个是活的。

## 二、功能规则

### 2.1 三种操作

| 操作 | 效果 | 可恢复 |
|---|---|---|
| **归档** | 从主列表移除，不进统计，进归档区 | ✅ 可恢复 |
| **删除** | 从归档区永久删除 | ❌ 不可恢复 |
| **恢复** | 归档区移回主列表 | — |

### 2.2 约束

```
① 支持批量：多选 → 归档 / 删除
② running 状态的任务：禁止归档、禁止删除
   按钮置灰 + 提示「先停止任务再操作」
③ 删除必须二次确认，弹窗明写「永久删除，不可恢复」
④ 归档不需要二次确认（可恢复，低风险）
⑤ 归档区入口：任务列表底部「已归档 N 条」
```

### 2.3 状态流转

```
active 状态（waiting/running/blocked/unknown/completed/failed）
        ↓ 归档
   archived（不进统计，列表隐藏）
        ↓ 恢复            ↓ 删除
    回原状态          gone（真删，DB 里没了）
```

**关键：归档不删数据，只改状态。恢复要能回到归档前的原状态。**

---

## 三、数据变更

```sql
-- tasks 表加字段
ALTER TABLE tasks ADD COLUMN archived_at TEXT;   -- null = 未归档
ALTER TABLE tasks ADD COLUMN archived_from TEXT; -- 归档前的 status，恢复用
```

**不改 status 枚举**，用 `archived_at` 判断是否归档。这样统计口径清晰：
```sql
-- 主列表
SELECT * FROM tasks WHERE archived_at IS NULL
-- 归档区
SELECT * FROM tasks WHERE archived_at IS NOT NULL
```

**已归档的任务，attempts / checkpoints / events 全部保留不删。**

---

## 四、API

```
POST /api/tasks/:id/archive          单条归档
POST /api/tasks/:id/restore          单条恢复
DELETE /api/tasks/:id                永久删除（要求 archived_at 非空 + 二次确认参数）
POST /api/tasks/bulk-archive         批量归档 { ids: [...] }
POST /api/tasks/bulk-delete          批量删除 { ids: [...], confirm: true }
GET  /api/tasks?archived=1           归档列表
```

**每个接口都要校验：**
```
running / blocked 状态 → 返回 409 + 明确原因，不许静默失败
删除非归档任务 → 返回 400「只能删除已归档的任务」
```

---

## 五、界面

### 5.1 主列表

```
每行左侧  □ 多选框
每行 hover 出现「归档」按钮
列表顶部  全选 / 已选 N 项 → 批量归档
底部      「已归档 12 条 →」入口
```

### 5.2 归档区（底部入口点开）

```
列表：任务名 / 归档时间 / 原状态 / 操作「恢复」「删除」
批量：多选 → 恢复 / 删除
删除时弹窗：「永久删除 3 个任务及其所有执行记录，不可恢复。确认？」
```

### 5.3 禁用态

```
running 的任务：
  归档按钮置灰，hover 提示「任务正在执行，请先停止」
  多选时不计入可批量操作的范围
```

---

## 六、验收标准

```
A1  单条归档后从主列表消失，出现在归档区
A2  归档任务不参与「N 任务」统计
A3  恢复后回到归档前的原状态，历史 attempts/checkpoints 完好
A4  running 任务归档接口返回 409，界面按钮置灰
A5  批量归档 10 条一次成功
A6  永久删除只能对已归档任务，未归档返回 400
A7  删除弹窗二次确认，取消则不删
A8  删完之后 tasks 表真没有这条（查 DB 验证）
A9  批量删除 5 条，其余任务不受影响
A10 归档 12 条后主列表统计从 24 变 12（真实数字验证）
```

---

## 七、不做的

```
✗ 权限控制（看板是 Leo 自己用）
✗ 软删除回收站二级（归档已经是软删）
✗ 自动归档规则（手动为主）
```

---

## 八、目标分

**本轮不设目标分**（需求明确，验收标准可穷举）。若 Leo 要求打码，按 10 分制。
