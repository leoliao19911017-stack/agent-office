# TASK-COMPANY-D0-R2 · worktree 并发隔离 + 渲染修复

> 版本：v1
> 日期：2026-11-25
> 执行：Claude Code（`--model glm-5.3`）
> 工作目录：`E:/DesktopProjects/Soda Intelligence - AI Native Thinking/Soda Office`
> 分支：`feat/company-d0`（继续在这个分支）

---

## 0. 这一轮只做三件事

```
① 修渲染 bug：[object Object]
② 补 project（项目）表，work_item 挂项目
③ 补 git worktree 并发隔离
```

**不做**：员工简历（第三批）、部门配置编辑、工作流编辑器、项目管理页面 UI。

---

## 1. 修渲染 bug

### 现象

**交办任务 → 交付成果后，首页「最新交付」显示：**
```
📄 [object Object]
```

### 原因

`web/company.js` 里渲染 `output_refs` 时直接把对象拼进字符串，没有取 `name` 或 `path`。

### 要求

```
① 每个交付物显示文件名（取 name，没有再取 path 的 basename）
② 可点击（如果有 path，点开看详情；没有就只是文本）
③ 最多显示 3 个，多的显示「+N」
④ 数组为空时不显示任何东西（不要显示空列表）
```

### 顺带检查

**`input_refs` 有没有同样的问题。有就一起修。**

### 验证

**再造一个带 2 个交付物的任务，截图确认显示的是文件名不是 `[object Object]`。**

---

## 2. project（项目）表

### 2.1 建表

```sql
CREATE TABLE IF NOT EXISTS projects (
  project_id    TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  department_id TEXT,
  root_path     TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'active',   -- active | paused | done | archived
  archived_at   TEXT,
  sort_index    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proj_dept ON projects(department_id, status);
```

### 2.2 work_items / workflow_runs 挂项目

```sql
ALTER TABLE work_items    ADD COLUMN project_id TEXT NOT NULL DEFAULT '';
ALTER TABLE workflow_runs ADD COLUMN project_id TEXT NOT NULL DEFAULT '';
```

**注意：`work_items.project_id` 新建时必填（API 层校验），存量可为空。**

### 2.3 种子数据（真实项目，不许编造）

```json
[
  {"project_id":"proj-agent-office","name":"Agent Office","description":"AI 公司经营工作台",
   "department_id":"dev","root_path":"E:/DesktopProjects/Soda Intelligence - AI Native Thinking/Soda Office","sort_index":0},
  {"project_id":"proj-easedraw","name":"EaseDraw","description":"逸刻画板",
   "department_id":"dev","root_path":"E:/DesktopProjects/Soda Intelligence - AI Native Thinking/逸刻EaseDraw","sort_index":1}
]
```

> **EaseDraw 的真实路径必须先自己 `ls` 确认存在再写进种子数据。不存在就不要种，只种 Agent Office，并在报告里说明。**

### 2.4 存量回填

```sql
UPDATE workflow_runs SET project_id = 'proj-agent-office' WHERE project_id = '';
```

### 2.5 项目 API

```
GET  /api/projects
     → [{project_id,name,description,department_id,root_path,status,
         requirement_count,task_count}]

GET  /api/projects/:id
     → {...project, requirements:[], tasks:[]}

POST /api/projects
     { name, description?, department_id?, root_path? }
     → 201；root_path 若给了必须真实存在，否则 400

PATCH /api/projects/:id
     { name?, description?, root_path?, status? }

DELETE /api/projects/:id
     有未完成 work_item 或 running 的 run → 409
```

### 2.6 POST /api/work 改必填

```
project_id   必填
             → 400 PROJECT_REQUIRED（缺）
             → 400 PROJECT_NOT_FOUND（不存在）
```

**前端「交给助理一件事」只做了交办框，没有交办时选项目的地方——现在是「交办但不知道哪个项目」。**

**你要在交办框旁边加一个项目选择（下拉，默认选上次用的）。**

---

## 3. git worktree 并发隔离（核心）

### 3.1 数据模型

```sql
ALTER TABLE work_executions ADD COLUMN worktree_path TEXT NOT NULL DEFAULT '';
ALTER TABLE work_executions ADD COLUMN branch_name   TEXT NOT NULL DEFAULT '';
ALTER TABLE work_executions ADD COLUMN base_ref      TEXT NOT NULL DEFAULT '';
ALTER TABLE work_executions ADD COLUMN commit_sha    TEXT NOT NULL DEFAULT '';
ALTER TABLE work_executions ADD COLUMN session_ref   TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS worktree_locks (
  worktree_path TEXT PRIMARY KEY,
  execution_id  TEXT NOT NULL,
  acquired_at   TEXT NOT NULL,
  released_at   TEXT
);
```

### 3.2 目录规范

```
<project.root_path>/.worktrees/<work_id>/<execution_id>/
```

**`.gitignore` 已加 `.worktrees/`，不要重复加。**

### 3.3 执行流程改造

**`POST /api/work/:id/start` 要做的事（按顺序）：**

```
① 校验 work 存在、没有 running 执行
② 校验 work.project_id 非空、项目存在、root_path 非空且真实存在
③ 校验 owner 有授权工具
④ 取 root_path 当前分支作为 base_ref
⑤ 生成 execution_id
⑥ branch_name = "exec/" + execution_id
⑦ worktree_path = <root>/<.worktrees>/<work_id>/<execution_id>
⑧ 执行 git worktree add <worktree_path> -b <branch_name> <base_ref>
   失败 → 500 WORKTREE_CREATE_FAILED，写清 git 的 stderr
⑨ 写 worktree_locks
⑩ 写 work_executions（status=running，含 worktree_path / branch_name / base_ref）
⑪ 返回
```

**关键：这一轮不需要真的 spawn 进程。**
**只把 worktree 建出来、记录写对。进程调度是下一轮的事。**

> **为什么：现在还没有「工具怎么执行」的抽象，硬塞进去会做歪。先把物理隔离建好、可验证。**

### 3.4 新增收尾接口

```
POST /api/work/:id/finish
     body: { result_summary, output_refs?, failed?:bool, error? }
     做的事：
       ① git -C <worktree> add -A
       ② 有改动才 commit，消息 "exec: <execution_id> <work title>"
       ③ 记录 commit_sha
       ④ work_executions.status = failed ? 'failed' : 'success'
       ⑤ 写 ended_at
       ⑥ 释放 worktree_locks（released_at）
       ⑦ 不删 worktree（等验收后由合并流程清理）
       ⑧ 有 output_refs 时 work.status = delivered
```

### 3.5 worktree 生命周期

```
成功 + 验收通过  → 合并回 base_ref 分支 → git worktree remove → 删 exec 分支
成功 + 验收不通过 → 保留 worktree
执行失败         → 保留 worktree
```

**这一轮只实现「保留」，不实现「合并」和「清理」。合并是人工动作。**

### 3.6 合并接口（只做最小的）

```
POST /api/work/:id/merge
     校验：work.status === 'accepted'，execution.commit_sha 非空
     做：git -C <项目根> merge --no-ff <branch_name>
     成功后：git worktree remove <worktree_path> --force，删除 branch
     失败（冲突）：返回 409 MERGE_CONFLICT，不动 worktree
```

**这条接口不自动调用，只能人工点。**

---

## 4. 验收标准

| # | 验收项 | 怎么验 |
|---|---|---|
| R1 | 交付物显示文件名，不是 `[object Object]` | 截图 + 读 DOM |
| R2 | 多个交付物显示「+N」 | 建 4 个交付物看 |
| R3 | projects 表有真实数据 | SQL |
| R4 | 现有 workflow_runs 都挂到 proj-agent-office | SQL |
| R5 | POST /api/work 不带 project_id → 400 | curl |
| R6 | 交办框旁边能选项目 | 截图 |
| R7 | start 后 worktree 真的建出来了 | `git worktree list` |
| R8 | worktree 路径符合规范 | 对比路径 |
| R9 | exec 分支真的建了 | `git branch \| grep exec/` |
| R10 | base_ref 记录对了 | SQL |
| R11 | 同一 work 二次 start → 409 | curl |
| R12 | finish 后有 commit_sha | SQL + `git log` |
| R13 | finish 后 worktree_locks 释放 | SQL |
| R14 | .worktrees/ 不污染 git status | `git status` |
| R15 | 两个任务并行，worktree 互不干扰 | 建两个 worktree 看 |
| R16 | 16 条 company 测试仍全过 | 跑测试 |
| R17 | 存量 60 条测试仍全过 | 跑测试 |
| R18 | board-cromma.html 仍能用 | 打开验证 |

---

## 5. 铁律

```
① 不许 git add -A，显式列文件
② 不许改 .gitignore 已有内容（.worktrees/ 已加好）
③ 不许碰 ~/.claude/settings.json 或任何全局配置
④ git 命令失败必须把 stderr 原样返回，不许吞
⑤ worktree 建失败不许静默降级成「在项目根跑」
⑥ 存量测试失败数不许比开工前多（基线：412 过 402，失败 10）
```

---

## 6. 汇报格式

```
① 改了什么（文件 + 行数）
② 验证了什么（真实命令输出，特别是 git worktree list 和 git branch）
③ 还差什么
```
