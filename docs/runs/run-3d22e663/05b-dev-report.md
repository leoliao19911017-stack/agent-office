# 05b 开发报告：把 tasks 挂到工作流步骤上

> run: `3d22e663-a27f-417c-829b-b6b7fbcc5fad` · 步骤 05 实现与自测（第二批：tasks → workflow_run / run_step）
> 开工 2026-11-24 22:06，报告写于 23:20 前后 · 会话 `soda-office-b0`

**结论先说：** B1–B11 共 11 条，**11 条通过**；其中 **B1、B10 各带一处你必须知道的说明**（见第一节）。定向测试 17/17；上一版测试 12/12；全量（临时库）跑了 3 次：354/11、355/10、355/10，稳定失败的是上一轮就有的 10 条。截图 11 张，逐张看过。

**但功能还没上线：** 8090 上的服务进程我**没有重启**，它跑的还是内存里的旧后端代码，生产库仍是 v8。重启会把生产库迁到 v9，这一步该你拍板。

---

## 一、先看这三件事

### 1. 8090 没重启 → 新功能在线上不生效，而且现在是「半新半旧」

- `web/server.js` 的静态文件（`board-cromma.html/js/css`）是**每次请求从磁盘读**的。所以我一改前端，8090 上的看板**立刻**就是新界面了（我用只读 GET 核对过：8090 返回的 html 里已有 `task-run-select`）。
- 但 8090 进程里的后端还是 20:28 启动时的旧代码（PID 54844，没动过），不认 `workflow_run_id`。
- 结果：线上看板会多出一个「工作流」下拉，选了却不会过滤。这个看板的规矩是「按钮必须有真实行为」，所以我加了一个**降级保护**：前端发现 `/api/tasks` 响应里没有 `workflow_run_id` 回显（= 后端是旧代码），就把下拉**禁用**并提示「服务端未重启」。截图 07 就是这个状态。
- **重启 8090 才算上线。** 重启时 `openDb` 会把 `data/agent-office.db` 从 v8 迁到 v9（只加两列 + 一个索引）。我没有擅自重启。

### 2. 我改了上一轮测试文件里的 2 行断言（`test/tasks-archive.test.js` 的 M1）

任务书要求「迁移版本 +1」且「上一版 12/12」。这两条在 M1 上直接冲突：M1 把版本写死成 `=== 8`。我用**未改动的**原文件对着 v9 代码跑了一遍，如实结果是 **11/12**——A1–A10 和 A9b 共 11 条全过，只有 M1 挂在 `9 !== 8`（原文存档：`tasks-archive-test-v9-before-m1-adjust.log`）。

我把 M1 的两行从「恰好等于 8」改成「至少是 8」，断言的意思（v8 迁移已跑过、三列还在）没变，其余 11 条用例一字未动：

```diff
-    assert.equal(Number(ver.value), 8);
-    assert.equal(SCHEMA_VERSION, 8);
+    assert.ok(Number(ver.value) >= 8, `schema_version 至少是 8（v8 已迁移），实际 ${ver.value}`);
+    assert.ok(SCHEMA_VERSION >= 8, `SCHEMA_VERSION 至少是 8，实际 ${SCHEMA_VERSION}`);
```

如果你认为上一轮的测试文件不该动，把这两行改回去即可，届时结果是 11/12（M1），归档功能本身不受影响。

### 3. 生产库 `tasks` 表现在是 0 行 → B1 的「旧行」不是生产数据

B1 要求「生产库副本跑迁移，旧行还在」。我拷副本去查，发现 **生产库 `tasks` 是 0 行**（`events / task_steps / attempts / checkpoints / deliverables` 也都是 0）。查到的时间线：

| 时点 | schema | tasks 行数 | 来源 |
|---|---|---|---|
| 18:03 的备份 | v5 | 24 | 只读查备份的副本 |
| 上一轮记录（约 20:00） | v7 | 1 | `05-dev-report.md` 第二节 |
| 现在 | v8 | **0** | 只读查生产库副本 |

`docs/需求E-Hermes集成进页面.md` 第 86 行写着「① 清空任务列表历史数据 ✅ 已做（27 任务 / 490 交付物 / 2917 工具事件 全清）」，应该是有意清的。**不是我这次弄丢的**：生产库主文件自 18:03 没变过（sha256 与上一轮 20:08 记录的一致），WAL 最后写入是 20:28，都早于我 22:06 开工；我的脚本只做文件拷贝，每次跑前跑后三个文件的 sha256 都一致。

所以生产库副本上没有真实旧行可验。我的做法：先原样记录生产库现状（0 行），再**只在副本里**补 3 行 v8 形状的任务行去迁。补行在截图和文本里都标了「副本补行·非生产数据」。「旧行不丢」另有一份单测（自己造的 v8 形状库文件）覆盖。

---

## 二、改动文件清单

| 文件 | 类型 | 改了什么 |
|---|---|---|
| `web/lib/db.mjs` | 改 | `SCHEMA_VERSION` 8 → **9**；v9 迁移：`tasks` 用 `ALTER TABLE ADD COLUMN` 加 `workflow_run_id` / `workflow_step_id` + 联合索引 `idx_tasks_workflow`（`web/lib/db.mjs:418`） |
| `web/lib/tasks.mjs` | 改 | `createTask` 接受挂点；`listTasks` 支持 run / step 过滤（SQL 里）；新增 `createTasksForWorkflowStep`（整批原子，`web/lib/tasks.mjs:156`）；把写步骤行抽成 `insertStepRows`、写任务抽成 `insertTaskRecord`（行为不变，为了能被外层事务包住）；导出 `DEFAULT_TASK_STEPS` |
| `web/api-tasks.mjs` | 改 | `taskView` 多 3 个字段；`GET /api/tasks` 支持 `workflow_run_id` / `workflow_step_id` 并回显；`POST /api/tasks` 接受挂点并校验；新增导出 `createWorkflowStepTasks`（`web/api-tasks.mjs:1009`） |
| `web/api-workflow-runs.mjs` | 改 | 加一条路由匹配 `POST /api/workflow/runs/:runId/steps/:stepId/tasks` → 调 `api-tasks.mjs` 的处理函数（`web/api-workflow-runs.mjs:99`、`:188`）。**不碰状态机** |
| `web/board-cromma.html` | 改 | 任务区加一行「工作流」下拉（`web/board-cromma.html:78`）；页脚数据源说明加 `/api/workflow/runs` |
| `web/board-cromma.css` | 改 | `.task-runbar`、`.task-tag--step`（含禁用态） |
| `web/board-cromma.js` | 改 | 按 run 过滤（真请求）、步骤标签、下拉渲染、旧后端降级保护、任务详情多一行「工作流」归属（`web/board-cromma.js:856` 起） |
| `test/tasks-workflow-link.test.js` | 新增 | B1–B10 逐条 + 边界，共 17 条 |
| `test/tasks-archive.test.js` | 改 | 仅 M1 的 2 行断言（见第一节第 2 点） |
| `scripts/tasks-workflow-link-shots.mjs` | 新增 | 生产库副本迁移实证 + 真实服务 + 真实 Chrome 截图与断言 |
| `docs/screenshots/tasks-workflow-link/` | 新增 | 11 张截图 + `shot-evidence.json` / `migration-before.txt` / `migration-after.txt` / `batch-response.json` |
| `docs/runs/run-3d22e663/*.log` | 新增 | 测试与实验的真实输出（见第七、八节） |
| `docs/runs/run-3d22e663/probes/` | 新增 | 第八节两个实验的探针脚本原件：`canary.mjs`（金丝雀）、`first-open-race.mjs`（并发首开复现） |
| `docs/runs/run-3d22e663/05b-dev-report.html`、`05b-md2html.mjs` | 新增 | 本报告的 HTML 版（给人看，内嵌截图、可搜索 / 折叠），由这份 `.md` 经 `05b-md2html.mjs` 生成——同一份源，改了 `.md` 重新生成一次即可 |

**没动的：** `web/lib/workflow-engine.mjs`（mtime 仍是 17:35:44）、`web/server-api.mjs`、`web/server.js`、`web/lib/workflow-db.mjs`、`workflow_runs.requirement_baseline`。

为什么路由匹配放在 `api-workflow-runs.mjs` 而不是任务书说的「都在 `api-tasks.mjs`」：`server-api.mjs:1348` 把 `/api/workflow/runs*` 先分给 `handleWorkflowRunsApi`，排在 `handleTasksApi`（`:1370`）之前；放进 `handleTasksApi` 永远走不到。建任务的逻辑仍在 `api-tasks.mjs`（所有写 `tasks` 表的入口放在一起）。

---

## 三、数据模型与迁移 v9

```
workflow_run（一次需求，跑九步）
  └── workflow_run_steps（九步之一，如 05）
        └── tasks.workflow_run_id + tasks.workflow_step_id   ← 这一列关系就是本次加的
```

一个任务只属于一次需求的一步；两列为 NULL = 不属于任何工作流（老任务就是这样）。没加外键——run / 步骤是否存在由 API 在建任务时校验，这样 run 归档、模板升级不会反过来卡住任务表写入。

迁移（`web/lib/db.mjs`）：

```js
{
  version: 9,
  up(db) {
    const cols = new Set(allRows(db, 'PRAGMA table_info(tasks)').map((c) => c.name));
    if (!cols.has('workflow_run_id')) db.exec('ALTER TABLE tasks ADD COLUMN workflow_run_id TEXT');
    if (!cols.has('workflow_step_id')) db.exec('ALTER TABLE tasks ADD COLUMN workflow_step_id TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_workflow ON tasks(workflow_run_id, workflow_step_id)');
  },
}
```

**生产库副本实证**（`scripts/tasks-workflow-link-shots.mjs` 第一段；只拷文件，原库从不被打开）：

```text
BEFORE  schema_version 8 · integrity ok · tasks 0 行（生产库现状）→ 副本里补 3 行 v8 形状的旧行
AFTER   schema_version 9 · integrity ok
  [OK] schema_version  8 → 9（v8 → v9）
  [OK] 任务行数        3 → 3（都是副本补的旧行；生产库本身 0 行）
  [OK] 老列逐列比对    3 行 × 15 列（迁移前全部列）全部一致
  [OK] rowid           [431, 902, 1500] → [431, 902, 1500]（表没有被重建）
  [OK] 新列            workflow_run_id / workflow_step_id 全部为 NULL
  [OK] 新列存在        workflow_run_id / workflow_step_id
  [OK] 索引            idx_tasks_workflow (workflow_run_id, workflow_step_id)
```

两点说明：
- 生产库的 `tasks` 实际有 15 列，比当前建表语句多 `claim_token / lease_expires_at / attempt / current_run_id` 四列（更早版本留下的）。核对按**迁移前全部列**比，不是我认识的列。
- rowid 故意不从 1 开始：删表重建会重新编号，迁移后不变才能说明没重建。

---

## 四、API 行为

| 方法与路径 | 行为 |
|---|---|
| `POST /api/tasks` | 可带 `workflow_run_id` / `workflow_step_id`；带了就校验：run 不存在 → **404 `RUN_NOT_FOUND`**，run 里没这步 → **404 `STEP_NOT_FOUND`**，只给步骤不给 run → **400 `BAD_WORKFLOW_LINK`**；三种情况都不建任务 |
| `GET /api/tasks?workflow_run_id=X` | 只返回这次需求的任务（SQL 过滤，走联合索引）；响应回显 `workflow_run_id` / `workflow_step_id` |
| `GET /api/tasks?workflow_run_id=X&workflow_step_id=05` | 只要这一步的；可与 `include_archived=1` 叠加 |
| `GET /api/tasks`（不带参数） | 原行为不变：全量列表，没挂工作流的老任务照常返回 |
| `GET /api/tasks` 每一项 | 多三个字段：`workflow_run_id`、`workflow_step_id`、`workflow_step_name`（服务端按 run 的模板版本查出，查不到为 null） |
| `POST /api/workflow/runs/:runId/steps/:stepId/tasks` | **新增。** body `{ tasks: [{ title, acceptance? }, ...] }` → **201** `{ ok, created, tasks: [...], workflow_run_id, workflow_step_id, workflow_step_name, actor }` |

批量建任务的语义：

- **整批全建或全不建。** 先把每一项校验完（任一项没有 title → 400 `BAD_TITLE`，指明 `tasks[i]`），再在一个事务里写入，中途出错整批回滚。理由：任务书是一个整体，半批任务 + 调用方重试 = 重复任务。这和上一轮的 `/api/tasks/batch`（归档 / 删除，逐条独立、允许部分失败）刻意不同。
- `tasks` 不是非空数组 → 400 `BAD_TASKS`；路径对但方法不是 POST → 405。
- 路径上的 run / 步骤先校验（不看 body）：run 不存在 → 404 `RUN_NOT_FOUND`；run 里没有这一步 → 404 `STEP_NOT_FOUND`。错误码沿用 `/api/workflow/runs*` 引擎里已有的那两个。
- 建任务不推进步骤、不碰状态机。
- 同一批的时间戳逐条 +1ms：列表按 `updated_at` 倒序，这样整批顺序确定（后建的在上），不会因为时间戳全相同而退化成按随机 task_id 排。

**归档 / 删除 / 恢复 / 批量的代码路径一行没改**，并且用挂了工作流的任务重新验过（`B10` 用例 + 截图脚本里真点了一次归档再恢复）。

---

## 五、界面（`web/board-cromma.*`）

- **任务区多一行「工作流」下拉。** 选项来自 `GET /api/workflow/runs`；选中哪次需求，任务列表就真请求 `/api/tasks?workflow_run_id=…`（服务端过滤，不是前端筛），和「显示已归档」是同一个做法。选「全部任务」回到不过滤。
- **每个挂了工作流的任务显示步骤标签**，如「05 开发执行」，画在每行下方的操作行左端（右端还是归档 / 删除）。步骤名取模板里的真名（05 开发执行、06 开发者自测、07 独立验证与评审），查不到就只显示步骤号，不编名字。没挂工作流的老任务没有标签。
- **任务详情面板**（右侧）多一行「工作流：这次需求的标题 · 第 05 步 开发执行」。
- **现有按钮行为不变**：归档 / 删除 / 恢复 / 批量 / 全选 / 状态筛选页签 / 显示已归档，都照常作用于过滤后的可见行。
- **旧后端降级保护**：见第一节第 1 点。

一处我做了又改掉的：第一版把步骤标签放在标题前面，断言全过，但我看截图发现它把标题挤成三四个字（「目标…」「交付物时…」）。标签是次要信息，标题才是主要的，所以挪到了操作行。脚本里加了断言锁住这一点：带标签的行，标题行宽度必须等于无标签的行（实测都是 144.2px）。

---

## 六、B1–B11 逐条结果

| # | 标准 | 结果 | 证据 |
|---|---|---|---|
| B1 | 迁移 v9 加两列，旧行不丢 | **过（带说明）** | 生产库副本：v8 → v9、两列 + 索引、3 行 × 15 列全等、rowid 不变、新列 NULL。**这 3 行是副本里补的，生产库本身 0 行**；另单测 `B1` 用自造 v8 库文件验旧行保留 |
| B2 | 不删表重建 | **过** | `web/` 下无 `DROP TABLE`；v9 只 `ALTER TABLE ADD COLUMN`；rowid 不变 |
| B3 | POST /api/tasks 能带 workflow_run_id | **过** | `B3`：查库两列有值；`B3b` 只给 run；`B3c` 三种非法挂点都拒且不建 |
| B4 | GET 按 run 过滤 | **过** | `B4`：2 个 run 各 3 条，各查各的 3 条 |
| B5 | GET 按 run + step 过滤 | **过** | `B5`：05 步 2 条、06 步 1 条，不相交；别的 run 的同号步骤不混入 |
| B6 | 不带 run 的老任务仍能查到 | **过** | `B6`：默认列表包含、挂点字段为 null、按 run 过滤时不出现；`B6b` 只给步骤 → 400 |
| B7 | 批量建 N 条并自动填两字段 | **过** | `B7`：一次 5 条，库里全对、顺序 = 任务书顺序；`B7b` 整批回滚；`B7c` 400 / 405 |
| B8 | 不存在的 run_id → 404 | **过** | `B8`：真实服务返回 404 `RUN_NOT_FOUND`，没建任务 |
| B9 | run 里没这步 → 404 | **过** | `B9`：404 `STEP_NOT_FOUND`，没建任务 |
| B10 | 上一版 A1–A10 仍通过，12/12 | **过（带说明）** | 原文件 11/12（仅 M1 版本写死）；M1 改 2 行后 12/12。详见第一节第 2 点 |
| B11 | 界面按 run 过滤生效、显示步骤标签 | **过** | 截图 03 / 03b / 04 / 04b / 05 / 05b；脚本抓到真实请求 `GET /api/tasks?workflow_run_id=…` 200，返回的 3 条全属该 run |

---

## 七、定向测试真实输出

### 7.1 新测试

```bash
node --no-warnings --test test/tasks-workflow-link.test.js
```

```text
✔ B1 迁移 v9：v8 库加 workflow_run_id / workflow_step_id 两列，旧行还在、新列为 NULL
✔ B2 不删表重建：迁移代码里没有 DROP TABLE，v9 只 ALTER TABLE ADD COLUMN
✔ B1b 全新库直接建到 v9：tasks 表自带两列
✔ B3 POST /api/tasks 带 workflow_run_id + workflow_step_id：库里两列都有值
✔ B3b 只给 run 不给步骤：允许（属于这次需求，没挂到具体某步）
✔ B3c 挂点校验：run 不存在 404、run 里没这步 404、只给步骤 400，且都不建任务
✔ B4 GET /api/tasks?workflow_run_id=X：2 个 run 各 3 条，查询只返回该 run 的 3 条
✔ B5 GET 按 run + step 过滤：05 步 2 条、06 步 1 条，各查各的
✔ B6 不带 workflow_run_id 的老任务：默认列表仍然能查到，挂点字段为 null
✔ B6b GET 只给 workflow_step_id 不给 run：400，不猜是哪次需求
✔ B7 批量建任务：一次建 5 条，自动填 run + step，库里全对
✔ B7b 批量是原子的：5 条里 1 条没有 title → 400，一条都不建
✔ B7c 批量入参：tasks 不是数组 / 空数组 → 400；路径对但方法不对 → 405
✔ B8 传不存在的 run_id：404，且不建任务
✔ B9 传 run 里没有的 step_id：404，且不建任务
✔ B10 挂了工作流的任务，归档 / 恢复 / 删除 / 批量的行为与上一版一致，挂点不丢
✔ B10 上一版 A1-A10：node --test test/tasks-archive.test.js 必须 12/12
ℹ tests 17
ℹ pass 17
ℹ fail 0
```

HTTP 用例复用 `test/chat-harness.mjs` 起真实的 `web/server.js`（临时库 + stub 中台 + 随机端口），状态码是真实服务给的；「查库」用的是这个临时库的第二个连接。完整输出：`docs/runs/run-3d22e663/tasks-workflow-link-test.log`。

### 7.2 上一版测试：改动前 / 后

```text
原文件（未改）对着 v9 代码：          M1 改 2 行断言之后：
✖ M1 迁移 v8：…                      ✔ M1 迁移 v8：…
✔ A1 … ✔ A10（含 A9b，共 11 条）      ✔ A1 … ✔ A10（含 A9b，共 11 条）
ℹ tests 12  pass 11  fail 1          ℹ tests 12  pass 12  fail 0
  AssertionError: 9 !== 8
  at test/tasks-archive.test.js:137:12
```

原文：`tasks-archive-test-v9-before-m1-adjust.log`（改前）、`tasks-archive-test-v9.log`（改后）。

### 7.3 额外的两个窄回归

我改的两处——`api-workflow-runs.mjs` 的路由、`createTask` / `listTasks` 的内部实现——在 HTTP 级和端到端的覆盖主要在这两个脚本里，所以单独跑了一遍。两个脚本都自带隔离（系统临时目录建库、独立端口），不碰生产库和 8090。

```text
node --no-warnings scripts/verify-workflow-engine.mjs   →  通过 15/15（W1–W14 + EXTRA，真实 HTTP）
node --no-warnings scripts/selftest-p0.mjs              →  规定测试 8/8 通过 · 附加必验 3/3 通过 · P0 SELFTEST PASS
```

---

## 八、全量回归（临时库）与那条偶发失败

**隔离方式：** `AGENT_OFFICE_DB` 指向系统临时目录下的新库；G07 夹具 spawn 的 `server.js` 继承同一环境变量。跑前跑后对 `data/agent-office.db`、`-wal`、`-shm` 做 sha256，**每一次都一致**：

```text
5d77e7b1565a5c8e221727639dbc0e0ab39adbb13a4c9e82ae15283187cb2d34 *data/agent-office.db
93101e9c579d8841e52f57b15318360d3e6719ec06ad3fe863c5d5cce1519063 *data/agent-office.db-wal
f535fb3713282d3b8c0a6de548a1cf1446da295563b111d08e5b5c591f3b1fa0 *data/agent-office.db-shm
```

```bash
AGENT_OFFICE_DB="<临时目录>/full-suite.db" node --no-warnings --test test/*.test.js
```

| 次 | tests | pass | fail | 说明 |
|---|---|---|---|---|
| 上一轮基线 | 348 | 338 | 10 | `full-suite-tempdb.log` |
| 第 1 次 | 365 | 354 | **11** | 348 + 我新增的 17。10 条同基线，**多 1 条** `g07-pages` A1 |
| 第 2 次（带金丝雀） | 365 | 355 | 10 | 正好是基线那 10 条 |
| 第 3 次（带金丝雀，存档） | 365 | 355 | 10 | 同上；`full-suite-canary-v9.log` |

稳定失败的 10 条全部在本次未改动的旧 UI 回归文件里（`g02-flows` 1 条、`g07-r72` 3 条、`g07-r73` 6 条），与上一轮报告第七节列的完全相同。

**多出来的那条是什么（第 1 次）：** `test/g07-pages.test.js` 的 A1「首页驾驶舱首屏」挂在 `consoleErrs` 断言——首页加载时有一个请求拿到 500。查证过程：

1. 这个文件不引用我改的任何东西（`api/tasks`、`board-cromma`、`workflow`、`lib/tasks` 均无）。
2. 单独复跑该文件 2 次，都是 4/4。
3. 写了个「金丝雀」：全量套件并行跑的同时，用同一个 G07 夹具反复加载首页（共用同一个临时库）。57 次加载，0 个 5xx，0 条服务端错误。（脚本：`docs/runs/run-3d22e663/probes/canary.mjs`）
4. 怀疑是「多个进程同时第一次打开同一个还不存在的库」。单独做实验：10 个真实 `web/server.js` 同时第一次打开同一个新库、同时各发 2 个首个请求。**3 轮分别有 18/20、18/20、5/20 个请求 500**，服务端 stderr 是（脚本：`probes/first-open-race.mjs`）：

```text
[错误] GET /api/workflow/runs → ERR_SQLITE_ERROR: database is locked
[错误] GET /api/tasks → ERR_SQLITE_ERROR: database is locked
```

（存档：`first-open-race.log`。）

**结论与边界：**
- 这是 `openDb` / `applyMigrations` 的**既有并发缺陷**：没有任何跨进程串行化，多个进程同时首次创建并迁移同一个库时会锁冲突。不是 v9 引入的，也不是这次任务范围内的东西，我**没有改**它。
- 我**没有定位到**真实流程里具体是哪条语句锁住。我另做了一个简化复刻，撞出来的是 `duplicate column name`（那个复刻没有「先查列再 ALTER」），和真实服务里的 `database is locked` 不是同一条语句——所以这里只能说清现象和出错层级，说不清具体语句。
- 对线上的影响：只发生在「多个进程同时首次创建一个新库」时。生产库已存在（WAL 模式），8090 是单进程，重启不会触发。
- 建议的修法（另开一个小改动做，配并发打开的测试）：`applyMigrations` 每个版本用 `BEGIN IMMEDIATE` 包住，进事务后重读 `schema_version`，别人迁过就跳过；`busy_timeout` 提到 `journal_mode` 之前设。

---

## 九、截图与自查

脚本：`node --no-warnings scripts/tasks-workflow-link-shots.mjs`（临时库 + stub 中台 + 随机端口 + 真实 Chrome；不连 `data/agent-office.db`、不碰 8090）。断言全部通过，`pageErrors` 为空。**每一张我都打开看过。**

| 截图 | 我看到了什么 |
|---|---|
| `01-db-copy-before-migration.png` | 迁移前：版本 8，15 列、没有新列；3 行带「【副本补行·非生产数据】」标注；底部写明「生产库 tasks 当前 0 行」「生产库未被打开、未改动」 |
| `02-db-copy-after-migration.png` | 迁移后：版本 9，第 15 / 16 列标「← 新增」，三行新列是 `NULL NULL`，索引列表里有 `idx_tasks_workflow`，7 项核对全 `[OK]` |
| `03-board-all-tasks-step-tags-1440x900.png`、`03b-rail-all-tasks-step-tags-2x.png` | 「全部任务（不按工作流过滤）」，7 条；两条老任务没有标签；挂了工作流的任务标题完整（「目标达成卡片」等），下方操作行左端是「07 独立验证与评审」「05 开发执行」「06 开发者自测」 |
| `04-board-filter-by-run-1440x900.png`、`04b-rail-filter-by-run-2x.png` | 选中 run 后下拉变琥珀色，任务数 3，只剩这次需求的 3 条；底部 toast「按工作流过滤：看板：任务列表支持批量归档 · 3 个任务」 |
| `04c-task-detail-workflow-row.png` | 右侧任务详情「进度」里多一行「工作流　看板：任务列表支持批量归档 · 第 05 步 开发执行」 |
| `05-board-batch-created-1440x900.png`、`05b-rail-batch-created-2x.png` | 批量建 5 条后：任务数 8，新 5 条排在最前，每条带「05 开发执行」 |
| `06-batch-api-response.png` | 批量接口响应表：HTTP 201、`created = 5`、5 行的 `workflow_run_id` / `workflow_step_id` / `workflow_step_name` 全对 |
| `07-old-backend-guard-rail-2x.png` | 模拟后端没重启：下拉灰掉、斜体「全部任务（服务端未重启，…」，没有步骤标签——就是 8090 现在的状态 |

两点要说清：

- **01 / 02 不是终端截图。** 页面里的文字是脚本用 `node:sqlite` 查副本得到的逐字输出，渲染成页面后截的图；原始文本在同目录的 `migration-before.txt` / `migration-after.txt`。
- **06 是响应的投影**，不是完整 JSON；完整原文在同目录 `batch-response.json`，一字未改。

脚本除了看图还验了这些（结果在 `shot-evidence.json`）：

```text
全部任务：7 行，5 个步骤标签（05×3、06、07），老任务 0 个标签，初始不按工作流过滤
标题行宽度：带标签 144.2px = 无标签 144.2px（标签不挤标题）
按 run 过滤：抓到真实请求 GET /api/tasks?workflow_run_id=<run A> → 200，3 条全属 run A
过滤后对挂了工作流的任务点「归档」：标签「05 开发执行」+「已归档」都在，opacity 0.55；点「恢复」回来
批量建任务：201，created 5；库里 run A / 05 步 7 条（原 2 + 新 5）
坏任务书（5 条里 1 条没 title）：400 BAD_TITLE「tasks[1] 需要非空字符串 title」，库里 0 条
旧后端（模拟）：下拉 disabled，步骤标签 0 个
生产库三个文件：跑前跑后 sha256 一致
```

---

## 十、技术选择（自己判断的，说明理由）

| 选择 | 理由 | 你可能想改的地方 |
|---|---|---|
| 只给 `workflow_step_id` 不给 `workflow_run_id` → 400（写入和查询都这样） | 「05」这种步骤号只在一次 run 里有意义，半截挂点没法追溯是哪次需求 | 如果想要「跨所有 run 看第 05 步的任务」，放开查询侧是一行的事 |
| `POST /api/tasks` 带了 run 就校验存在性（404） | 不让任务挂到不存在的 run / 步骤上，和批量接口口径一致 | 任务书只写了「接受」这两个字段，没写校验 |
| 批量建任务整批原子 | 任务书是一个整体；部分成功 + 重试 = 重复任务 | 如果更想要「逐条结果、允许部分失败」，要另定口径 |
| 同批时间戳逐条 +1ms | 列表按 `updated_at` 倒序，整批顺序才确定 | 副作用：后建的几条 `created_at` 比请求时刻晚几毫秒 |
| 两列不加外键 | run 归档 / 模板升级不该反过来卡住任务表写入 | — |
| 响应多给一个派生字段 `workflow_step_name` | 步骤名不在 `workflow_run_steps` 里，要按 run 的模板版本取；服务端查一次比前端硬编码九步名可靠（模板可改） | — |
| GET 过滤时不校验 run 是否存在（不存在的 run 返回空列表） | 列表接口的常规语义；404 只用在写入上 | 如果想要「查一个不存在的 run 报 404」可以加 |
| 没限制 run 的状态 | 已完成 / 已归档的 run 下也能补建任务；任务书没说 | 见第十二节 Q2 |
| 404 沿用 `RUN_NOT_FOUND` / `STEP_NOT_FOUND` | 和 `/api/workflow/runs*` 引擎里已有的错误码保持同一套 | — |
| 没加每批条数上限 | 与上一轮 `/api/tasks/batch` 一致；1MB 请求体是天然上限 | — |

---

## 十一、达到目标没有，还差哪些

**目标**：建立 `workflow_run → run_step → tasks` 的关系，能按步骤挂任务、按需求过滤、界面上看得见。

**在临时环境里达成了**：库有关系（v9 两列 + 索引）、API 能挂能滤能批量建、界面能按 run 过滤并显示步骤标签，B1–B11 都有证据。

**没达成 / 还差的：**

1. **线上没生效。** 8090 没重启，生产库还是 v8，看板上的下拉是禁用状态。这是最大的一条。
2. **「当前选中的工作流 run」在这个看板里原本不存在。** 工作流视图（`workflow-runs.js`）只挂在 `index.html` 上，`board-cromma` 从来不请求 `/api/workflow/runs`。我在左栏加了一个下拉当「选中」。如果你说的是 `index.html` 工作流视图里选中的那个 run，需要跨页面联动，是另一件事。
3. **界面上没有「从任务书批量建任务」的入口**，目前只有 API。任务书的界面部分只点了过滤和标签，我没擅自加按钮。
4. **真实旧行的迁移验证做不了**，因为生产库 `tasks` 是 0 行（第一节第 3 点）。
5. **既有的并发首次开库缺陷没修**（第八节），只查了现象、留下了证据和修法建议。
6. **没测的**：两个请求同时批量建任务；模板改版 / 换模板后旧任务的步骤名解析（现在查不到会退回只显示步骤号，逻辑在但没有用例压着）。
7. **全量里有 10 条上一轮就失败的旧 UI 回归**，没修，与本次无关。

**过程中我自己出错又改掉的地方**（免得看证据时被误导）：

- 第一版截图脚本的「旧行不丢」核对是空过的：生产库 0 行，`0 → 0` 也判 OK。改成行数必须 > 0，并在副本里补行。
- 核对一开始只比了我认识的 11 列，漏了生产库多出来的 4 列。改成按迁移前全部 15 列比。
- 嵌套跑 `node --test` 时子进程不输出汇总（环境里有 `NODE_TEST_CONTEXT`），第一次是靠「读不到汇总就判失败」拦住的，没让它空过。

---

## 十二、需求层面要问 Leo 的

1. **「当前选中的工作流 run」指哪里的选中？** 看板 V2 原来没有这个概念，我做成了左栏下拉。要不要和 `index.html` 工作流视图里选中的 run 联动？
2. **任务能不能挂到已完成 / 已归档的 run 或步骤上？** 现在允许。
3. **批量建任务要不要界面入口？** 比如在九步视图的某一步上放一个「从任务书建任务」。
4. **一个任务只属于一次需求的一步**（现在这样），够不够？有没有一个任务要跨多步的情况？
5. **生产库任务表被清空（需求E）** 是预期的吧？我只是核对时发现的，文档里有记录。
6. **什么时候重启 8090？** 重启后新功能才上线，同时会把生产库迁到 v9。
7. 上一轮测试 M1 那 2 行断言的改法你认不认（第一节第 2 点）。

---

## 十三、复现命令

```bash
# 1. 定向验收
node --no-warnings --test test/tasks-workflow-link.test.js     # 17/17
node --no-warnings --test test/tasks-archive.test.js           # 12/12（M1 调整后）

# 2. 全量（务必用临时库）
AGENT_OFFICE_DB="<临时目录>/full-suite.db" node --no-warnings --test test/*.test.js

# 3. 迁移实证 + 截图（脚本自己拷生产库副本、建临时库与临时配置）
node --no-warnings scripts/tasks-workflow-link-shots.mjs

# 4. 第八节的两个实验（都会跑全量 / 起多个真实服务，各约 1 分钟；全部用临时库）
node --no-warnings "docs/runs/run-3d22e663/probes/canary.mjs" "<仓库根>"
node --no-warnings "docs/runs/run-3d22e663/probes/first-open-race.mjs" "<仓库根>" 10 3
```
