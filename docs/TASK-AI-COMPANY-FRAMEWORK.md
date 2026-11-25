# TASK-AI-COMPANY-FRAMEWORK · AI 公司组织架构框架

> 版本：v1
> 日期：2026-11-25
> 执行：Codex
> 工作目录：`E:/DesktopProjects/Soda Intelligence - AI Native Thinking/Soda Office`
> 分支：从 `p0-foundation` 开新分支 `feat/company-framework`

---

## 0. 一句话目标

**把现有的「项目管理工具」改造成「AI 公司经营工作台」的骨架：引入部门、员工、岗位职责三个组织层，让现有项目挂在部门下，其余（例行工作/目标管理/响应工作/办公室插画）本轮一律不做。**

---

## 1. 背景：为什么改

现在的产品只有一个扁平结构：
```
workflow_runs（需求/项目）
  └── workflow_run_steps（九步）
tasks（子任务）
agents（Agent 配置：claude/codex/dsh/hermes）
```

**Leo 的原话：**
> 我应该按照一家公司各个部门真实的工作来做。
> 因为我是 Office，那我肯定会有部门嘛，那研发部就干研发干的事。然后我接哪些 Agent？工作流是什么样的？
> 我这个部门都可以去创建的呀，比如说我现在创建一个什么部门，它有哪些 Agent 组成，这些都可以创建、可以配置的。
> 所以说你先把这个框架搭起来，然后现在只有研发部，到时候再加个营销部。
> 例行工作先不用安排吧，目前先把我每天安排的这个任务需求做完。

**所以本轮唯一目标：搭出「部门 → 员工 → 项目」这层骨架，且三者都可创建可配置。**

---

## 2. 必须遵守的硬约束

| # | 约束 | 说明 |
|---|---|---|
| 1 | **不推翻现有代码** | 九步工作流、任务归档删除、交付物、评审全部保留，只加关联 |
| 2 | **数据迁移不丢** | 现有 4 条 `workflow_runs`、33 条 `tasks`、6 条 `agents` 一条不能少 |
| 3 | **不改 `index.html`** | 该文件归 Codex 独占，但本次若需要改，只改 `board-cromma.*` |
| 4 | **不写死部门** | 部门必须是数据，不是代码里的常量 |
| 5 | **不编造数据** | 初始只有「研发部」一个真实部门。测试数据必须显式标注 |
| 6 | **不改变现有接口行为** | 现有 API 的返回结构只增不改 |
| 7 | **全量测试用临时库** | 不许在 `data/agent-office.db` 上跑全量测试 |
| 8 | **禁止 `git add -A`** | 提交前显式列文件 |

---

## 3. 数据模型（核心）

### 3.1 新增表

#### `departments` — 部门

```sql
CREATE TABLE IF NOT EXISTS departments (
  department_id TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  duty          TEXT NOT NULL DEFAULT '',        -- 部门职责描述
  color         TEXT NOT NULL DEFAULT '#2563eb', -- 标识色，用于列表左侧色条
  sort_index    INTEGER NOT NULL DEFAULT 0,
  default_workflow_template_id TEXT,             -- 默认工作流模板
  archived_at   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
```

**初始数据（唯一一条，真实）：**
```json
{
  "department_id": "dev",
  "name": "研发部",
  "duty": "做项目、做产品",
  "color": "#2563eb",
  "sort_index": 0,
  "default_workflow_template_id": "coding-v1"
}
```

#### `employees` — 员工

**关键设计：员工 ≠ Agent。**

```
员工 = 组织身份（长期资产：岗位、职责、记忆、历史成果）
Agent = 执行引擎（claude / codex / dsh / hermes）
一个员工可以换执行引擎，但员工身份不变
```

```sql
CREATE TABLE IF NOT EXISTS employees (
  employee_id   TEXT PRIMARY KEY,
  department_id TEXT NOT NULL,
  name          TEXT NOT NULL,              -- 显示名，如 "Claude Code"
  role          TEXT NOT NULL,              -- 岗位，如 "开发工程师"
  duty          TEXT NOT NULL DEFAULT '',   -- 岗位职责描述
  agent_id      TEXT,                       -- 当前绑定的执行引擎（可空=待配置）
  avatar        TEXT NOT NULL DEFAULT '',   -- 头像标识（首字母或图标 key）
  sort_index    INTEGER NOT NULL DEFAULT 0,
  archived_at   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  FOREIGN KEY (department_id) REFERENCES departments(department_id)
);
CREATE INDEX IF NOT EXISTS idx_employees_dept ON employees(department_id, sort_index);
```

**初始数据（四条，真实）：**
```json
[
  {"employee_id":"emp-hermes","department_id":"dev","name":"Hermes","role":"技术搭档 / 调度","duty":"接收需求、拆解任务、派活、验收汇总","agent_id":"hermes","sort_index":0},
  {"employee_id":"emp-claude","department_id":"dev","name":"Claude Code","role":"开发工程师","duty":"写代码、改代码、自测","agent_id":"claude","sort_index":1},
  {"employee_id":"emp-codex","department_id":"dev","name":"Codex","role":"评审工程师","duty":"独立评审、打分、指出缺陷","agent_id":"codex","sort_index":2},
  {"employee_id":"emp-dsh","department_id":"dev","name":"DSH","role":"备用开发","duty":"主开发不可用时接手","agent_id":"dsh","sort_index":3}
]
```

### 3.2 修改现有表

#### `workflow_runs` 加两列

```sql
ALTER TABLE workflow_runs ADD COLUMN department_id TEXT;
ALTER TABLE workflow_runs ADD COLUMN owner_employee_id TEXT;
```

**迁移规则：**
- `department_id` 全部填 `'dev'`（现在只有研发部，历史数据都是研发部产生的）
- `owner_employee_id`：按 `title` 无法可靠推断，**一律留 NULL**，不猜
- 加索引：`CREATE INDEX IF NOT EXISTS idx_runs_dept ON workflow_runs(department_id, status);`

**为什么不用独立 projects 表：**
一条 `workflow_run` 就是一条需求/一个项目。再加一层 `projects` 会让「项目」和「需求」两个词打架。**本轮就认为 `workflow_run` = 项目。**

---

## 4. 后端接口

全部挂在 `web/api-company.mjs`，在 `web/server.js` 注册路由。

### 4.1 部门

```
GET    /api/departments
       → [{ department_id, name, duty, color, default_workflow_template_id,
            employee_count, project_count, archived_at }]

POST   /api/departments
       body: { name, duty, color?, default_workflow_template_id? }
       → 201 { department_id, ... }
       校验：name 非空、不重名

PATCH  /api/departments/:id
       body: { name?, duty?, color?, default_workflow_template_id? }

DELETE /api/departments/:id
       → 软删（写 archived_at）
       校验：部门下有未归档项目 → 409 DEPARTMENT_NOT_EMPTY
```

### 4.2 员工

```
GET    /api/departments/:id/employees
       → [{ employee_id, name, role, duty, agent_id, agent_display_name,
            status, current_project }]
       status 取值：executing | pending_approval | idle | offline | unknown
       ** 取不到就是 unknown，绝不用 idle 兜底 **

POST   /api/employees
       body: { department_id, name, role, duty?, agent_id? }
       → 201
       校验：department_id 存在、name 非空

PATCH  /api/employees/:id
       body: { name?, role?, duty?, agent_id?, sort_index? }

DELETE /api/employees/:id
       → 软删
       ** 不许删：有正在执行的项目的员工 → 409 EMPLOYEE_BUSY **
```

### 4.3 公司总览

```
GET /api/company/overview
    → {
        departments: [{ department_id, name, duty, color,
                        employee_count, project_count,
                        projects_running, projects_done }],
        totals: {
          departments: 1,
          employees: 4,
          projects_running: 1,
          projects_done: 1,
          pending_decisions: 1
        }
      }
```

### 4.4 员工的执行状态怎么算（重要）

**不要新造一套状态。从现有数据推导：**

```
executing         该员工 agent_id 有 status=running 的 attempt
pending_approval  该员工有待审批（chat_approvals 里 pending）
idle              该员工 agent_id 有记录，但当前无 running attempt
offline           agent 表里 enabled=0
unknown           取不到数据（例如没有 agent_id）
```

**推导逻辑写在 `web/lib/company.mjs`，单测覆盖五种情况。**

---

## 5. 前端

### 5.1 新页面

```
web/company.html     AI 公司首页（新）
web/company.js
web/company.css
```

**保留 `board-cromma.html` 不动。** 新页面独立，通过顶部导航互跳。

### 5.2 布局（1440x900）

```
┌────────────────────────────────────────────────────────────────┐
│ 顶部 48px   Agent Office        2026年11月25日  ● 运行中        │
├──────────┬─────────────────────────────────┬───────────────────┤
│ 左 208px │  中间 自适应                     │  右 320px          │
│          │                                 │                   │
│ 我的公司  │  [办公室] [工作]  ← tab          │  CEO 办公桌        │
│ 今日工作  │                                 │                   │
│          │  ┌───────────────────────────┐  │  发起需求          │
│ 部门      │  │ 研发部     4 位员工  2项目 │  │  ┌─────────────┐  │
│  研发部 ▾ │  ├───────────────────────────┤  │  │ 输入框       │  │
│   Hermes │  │ ┌────┐┌────┐┌────┐┌────┐ │  │  └─────────────┘  │
│   Claude │  │ │H   ││C   ││X   ││D   │ │  │  [发起需求]        │
│   Codex  │  │ │调度 ││开发 ││评审 ││备用 │ │  │                   │
│   DSH    │  │ │待命 ││●执行││待命 ││待命 │ │  │  待我决策  1       │
│          │  │ └────┘└────┘└────┘└────┘ │  │  ┌─────────────┐  │
│  项目 ·2 │  ├───────────────────────────┤  │  │界面重构·方向 │  │
│  界面重构 │  │ 项目                       │  │  │待审批  [查看]│  │
│  归档删除 │  │ Agent Office 界面重构      │  │  └─────────────┘  │
│          │  │   第5步 · Claude Code      │  │                   │
│ +新建部门 │  │ 任务归档与删除             │  │  近期动态          │
│          │  │   已完成 · 8.3 分          │  │  Claude 开发与自测 │
│          │  └───────────────────────────┘  │  归档删除已交付     │
├──────────┴─────────────────────────────────┴───────────────────┤
│ 底部 28px  就绪 · 数据来自 data/agent-office.db                 │
└────────────────────────────────────────────────────────────────┘
```

### 5.3 视觉规范（严格照做）

```css
:root {
  --background: #ffffff;
  --foreground: #262626;
  --muted: #f5f5f5;
  --muted-foreground: #737373;
  --border: #e5e5e5;
  --accent: #2563eb;
  --radius-card: 12px;
  --radius-btn: 8px;
}

font-family: system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
line-height: 1.5;

正文 14px / 辅助 12px / 最小 11px（禁止 <11px）
卡片：border 1px solid var(--border)，圆角 12px，无阴影
按钮：圆角 8px，高 32px，14px，500
输入框：圆角 8px，min-height 40px
强调色只用于：主按钮、当前选中、进行中状态点
```

**禁止：渐变、阴影（hover 最多 1px）、插画、毛玻璃、大圆角（>16px）、动画。**

### 5.4 「工作」视图

同一页面 tab 切换，右侧栏和左栏都不动。

```
项目表格
┌────────────────────────┬──────────┬────────────┬────────┐
│ 名称                    │ 当前步骤  │ 负责人      │ 状态    │
├────────────────────────┼──────────┼────────────┼────────┤
│ Agent Office 界面重构   │ 第5步     │ Claude Code │ 进行中  │
│ 任务归档与删除          │ —        │ Codex       │ 已完成  │
└────────────────────────┴──────────┴────────────┴────────┘
点行 → 展开九步进度条
```

### 5.5 必须能点通的七条路径

| # | 操作 | 预期 |
|---|---|---|
| 1 | 点左侧「研发部」 | 中间显示该部门 |
| 2 | 点员工卡片 | 右侧或抽屉显示员工档案（名字/岗位/职责/执行引擎/当前项目） |
| 3 | 点项目行 | 展开九步进度 |
| 4 | 点「待我决策」卡片 | 打开决策抽屉（需要什么决定 / 为什么 / 方案A B / 四个按钮） |
| 5 | 切「办公室 / 工作」tab | 左右栏不动，只有中间变 |
| 6 | 点「+ 新建部门」 | 配置弹窗：名称、职责、勾选 Agent、默认工作流 |
| 7 | 右栏输入需求提交 | 调用现有建 run 接口，中间自动打开该项目 |

---

## 6. 文件清单

### 新增

```
web/lib/company.mjs          部门/员工 CRUD + 员工状态推导
web/api-company.mjs          路由
web/company.html             新页面
web/company.js
web/company.css
test/company.test.js         单测
```

### 修改

```
web/lib/db.mjs               迁移：schema_version +1，建两张新表 + 加两列
web/server.js                注册 api-company 路由
```

### 不动

```
web/index.html               不动
web/board-cromma.*           不动（现有看板继续能用）
web/lib/workflow-*.mjs       不动
web/api-workflow-*.mjs       不动
web/lib/tasks.mjs            不动
```

---

## 7. 验收标准（必须逐条自证）

| # | 验收项 | 怎么验 |
|---|---|---|
| A1 | 迁移后 `departments` 有 1 行（研发部） | `SELECT COUNT(*)` |
| A2 | 迁移后 `employees` 有 4 行 | `SELECT COUNT(*)` |
| A3 | 现有 4 条 `workflow_runs` 全部 `department_id='dev'` | `SELECT` 检查 |
| A4 | 现有 33 条 `tasks` 一条不少 | `SELECT COUNT(*)` 前后对比 |
| A5 | `GET /api/departments` 返回研发部，含 employee_count=4 | curl |
| A6 | `POST /api/departments` 能建新部门，重名返回 409 | curl |
| A7 | `DELETE /api/departments/:id` 对有项目的部门返回 409 | curl |
| A8 | `POST /api/employees` 能建员工 | curl |
| A9 | 员工状态五种情况都能正确推导 | 单测 |
| A10 | `GET /api/company/overview` 数字与库一致 | curl + SQL 对比 |
| A11 | 新页面 1440x900 三栏不漏不挤 | 截图 |
| A12 | 七条点击路径全通 | 截图 + 说明 |
| A13 | 页面所有文字 ≥11px | `getComputedStyle` 脚本 |
| A14 | 没有渐变/阴影/插画 | 代码 grep |
| A15 | 现有 `board-cromma.html` 仍然能用 | 打开验证 |

**A15 尤其重要：不许为了新页面弄坏老页面。**

---

## 8. 明确不做

```
❌ 例行工作（定期任务模板 + 自动生成）
❌ 目标管理（周目标/月目标/经营指标）
❌ 响应工作（事件触发）
❌ 办公室插画 / 3D / 小人走动
❌ 员工记忆 / 能力库 / 权限配置
❌ 跨部门协作
❌ 成本预算
❌ 手机端
```

**这些下轮再说。本轮只要骨架立起来。**

---

## 9. 执行顺序

```
1. 开分支 feat/company-framework
2. 写迁移（db.mjs），跑一次，验证 A1-A4
3. 写 web/lib/company.mjs + 单测，跑通 A9
4. 写 web/api-company.mjs + 注册路由，curl 验 A5-A8、A10
5. 写 company.html/js/css
6. 截图验 A11-A14
7. 打开 board-cromma.html 验 A15
8. 提交（显式列文件）
```

**每一步做完立刻验证，不要一口气写完再测。**

---

## 10. 汇报格式（必须按这个报）

```
① 改了什么（文件清单 + 行数）
② 验证了什么（真实命令输出，不要"应该没问题"）
③ 还差什么（没做的、有风险的说清楚）
```

**不许说「已完成」但没有验证输出。**
