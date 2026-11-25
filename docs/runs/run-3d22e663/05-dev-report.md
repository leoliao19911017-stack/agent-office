# 05 开发报告：任务归档 / 删除 / 恢复

> run: `3d22e663-a27f-417c-829b-b6b7fbcc5fad` · 步骤 05 实现与自测
> 结论先说：**A1-A10 十条全部实现并通过（10/10）**；定向测试 12/12 通过；全量 348 条中 338 通过、10 条失败，失败全部集中在本次未改动的旧 UI 回归文件（`g02-flows` / `g07-r72` / `g07-r73`），与本功能无关。截图 3 张已逐张自查。

---

## 一、改动文件清单

| 文件 | 类型 | 改了什么 |
|---|---|---|
| `web/lib/db.mjs` | 改 | 迁移版本 7 → **8**；`tasks` 用 `ALTER TABLE ADD COLUMN` 加 `archived_at` / `archived_from` / `deleted_at` 三列 + 两个索引，不删表重建 |
| `web/lib/tasks.mjs` | 改 | `listTasks()` 新增 `visibility`：`all`（默认，兼容采集/迁移脚本）/ `not_deleted` / `active`，归档与软删的过滤收口在 SQL 里 |
| `web/api-tasks.mjs` | 改 | 新增 `POST /:id/archive`、`POST /:id/restore`、`DELETE /:id`、`POST /api/tasks/batch`；`GET /api/tasks` 支持 `include_archived=1` / `include_deleted=1`；`taskView` 带归档三列；归档/删除/恢复统一写 events |
| `web/board-cromma.html` | 改 | 任务列表顶部加「全选 / 显示已归档」工具条 + 批量操作条（已选 N 条 / 归档 / 删除 / 恢复） |
| `web/board-cromma.css` | 改 | 行内操作按钮、勾选框、批量条、归档灰显（opacity .55）与「已归档」标签样式 |
| `web/board-cromma.js` | 改 | 每行加归档/删除（归档行是恢复/删除）按钮；多选 + 全选 + 批量调用；`显示已归档` 真请求 `?include_archived=1`；归档后自动亮出归档行，便于看到灰显与恢复 |
| `test/tasks-archive.test.js` | 新增 | A1-A10 逐条测试 + 迁移测试（M1）+ 批量归档/恢复（A9b），共 12 条 |
| `scripts/tasks-archive-shots.mjs` | 新增 | 临时库 + 临时 `AGENT_AUTOLOOP_HOME` + stub 中台 + 真实 Chrome，起服务、造数、点击、截图、断言 |
| `docs/screenshots/tasks-archive/*.png` | 新增 | 3 张验收截图 + `shot-evidence.json` |
| `docs/runs/run-3d22e663/tasks-archive-test.log` | 新增 | 定向测试真实输出 |
| `docs/runs/run-3d22e663/full-suite-tempdb.log` | 新增 | 全量测试真实输出（临时库） |

未新建任何路由文件；所有写路由都在 `web/api-tasks.mjs`。

---

## 二、数据模型与迁移

迁移写在 `web/lib/db.mjs` 的 `MIGRATIONS`：

```js
{ version: 8, up(db) {
  const cols = new Set(allRows(db, 'PRAGMA table_info(tasks)').map((c) => c.name));
  if (!cols.has('archived_at'))   db.exec('ALTER TABLE tasks ADD COLUMN archived_at TEXT');
  if (!cols.has('archived_from')) db.exec('ALTER TABLE tasks ADD COLUMN archived_from TEXT');
  if (!cols.has('deleted_at'))    db.exec('ALTER TABLE tasks ADD COLUMN deleted_at TEXT');
  ...
} }
```

**迁移真机验证（拿生产库副本，不碰原库）：**

```text
BEFORE {"ver":"7","tasks":1}
AFTER  {"ver":"8","tasks":1,"row":{"task_id":"t-legacy-1","title":"旧任务不许丢","status":"running","archived_at":null,"archived_from":null,"deleted_at":null}}
```

旧行还在、`status` 原值不动、新列为 NULL。没有 DROP TABLE / 重建。

---

## 三、API 行为

| 方法与路径 | 行为 | 关键点 |
|---|---|---|
| `POST /api/tasks/:id/archive` | 写 `archived_at=now`、`archived_from=当前 status` | **不改 `status`**（A2）；已删除 409 `TASK_DELETED`；已归档 409 `TASK_ALREADY_ARCHIVED` |
| `POST /api/tasks/:id/restore` | `archived_at=NULL`、`archived_from=NULL`、`deleted_at=NULL`，`status=archived_from` | 归档前 running → 恢复后 running（A5）；`archived_at` 置空（A6） |
| `DELETE /api/tasks/:id` | `status=running` 或存在 running attempt → **409 `TASK_RUNNING`**；否则只写 `deleted_at` | 409 不写 `deleted_at`（A7）；非 running 软删、行保留（A8） |
| `POST /api/tasks/batch` | `{action: archive\|delete\|restore, ids:[...]}`，逐条执行 | 每条独立 try/catch，返回 `{task_id, ok, ...}` 或 `{task_id, ok:false, error:{code,message,status}}`；一条失败不影响其他（A9） |
| `GET /api/tasks` | 默认 `archived_at IS NULL AND deleted_at IS NULL` | 归档不返回（A3） |
| `GET /api/tasks?include_archived=1` | 返回归档、仍排除软删 | 列表项带 `archived_at` / `is_archived`（A4） |

事件（A10）：`task_archived` / `task_deleted` / `task_restored` 三种 `event_type`；`events.agent_id` 记「谁」、`observed_at` 记「何时」、`payload.action` 记「什么操作」，另带 `status_before` / `archived_from` / `deleted_at` 等上下文。actor 取值优先级：body `actor|actor_id|by` → `X-Actor` 头 → `user:local`（不会匿名）。

---

## 四、前端（`/board-cromma.html`，唯一消费 `/api/tasks` 的列表）

- 每行固定显示「归档 / 删除」；归档行变「恢复 / 删除」。
- 行首勾选框 + 顶部「全选」；选中后在筛选条下出现批量条：`已选 N 条 | 归档 | 删除 | 恢复`。
- 「显示已归档」不是前端本地过滤，而是真的请求 `GET /api/tasks?include_archived=1`。
- 归档成功自动打开归档视图，用户立刻看到灰显 +「已归档」标签，可马上恢复。
- 删除 running 行：接口返回 409，toast 显示 `删除失败（HTTP 409）：TASK_RUNNING`，行不会消失。
- 批量结果逐条汇总：全成功提示条数；有失败提示「成功 X 条，失败 Y 条 · 首条原因（运行中的会写明先停止）」。

---

## 五、A1-A10 逐条验收

| # | 标准 | 测试用例 | 结果 |
|---|---|---|---|
| A1 | archive 把 `archived_at` 写成当前时间 | `A1`：断言非空、可解析、落在调用前后时间窗、响应与库一致 | ✅ |
| A2 | 归档不改 `status` | `A2`：running 任务归档前后 DB `status` 都是 running，`archived_from=running` | ✅ |
| A3 | 归档后默认列表不返回 | `A3`：`GET /api/tasks` 断言不含归档 id、含未归档 id | ✅ |
| A4 | `include_archived=1` 能返回 | `A4`：断言含、`is_archived=true`、`archived_at` 非空 | ✅ |
| A5 | restore 用 `archived_from` 还原原状态 | `A5`：running → 归档（仍 running）→ 恢复后仍是 running | ✅ |
| A6 | 恢复后 `archived_at` 置空 | `A6`：DB `archived_at` / `archived_from` 均为 NULL | ✅ |
| A7 | DELETE 对 running 返回 409 | `A7`：断言 HTTP 409、`code=TASK_RUNNING`、`deleted_at` 仍为 NULL | ✅ |
| A8 | DELETE 对非 running 是软删 | `A8`：行还在、`deleted_at` 有值、默认列表不返回 | ✅ |
| A9 | batch 逐条返回，1 条失败不影响其他 | `A9`：3 条（2 可删 + 1 running）→ `succeeded=2, failed=1`，失败条 `TASK_RUNNING`；DB 里 2 条已软删、running 那条没删 | ✅ |
| A10 | 归档/删除/恢复都写 event | `A10`：三种事件各 1 条，`agent_id=actor`、`observed_at` 可解析、`payload.action` 正确 | ✅ |

补充：`M1` 验证迁移 v8 的列与版本；`A9b` 验证 batch 的 archive / restore 与单条接口结果一致。

---

## 六、定向测试真实输出

命令：

```bash
node --no-warnings --test test/tasks-archive.test.js
```

输出（原文）：

```text
✔ M1 迁移 v8：tasks 新增 archived_at / archived_from / deleted_at，版本 +1 (41.1469ms)
✔ A1 POST /archive 把 archived_at 写成当前时间 (63.3283ms)
✔ A2 归档不改 status（running 归档后仍是 running） (46.9995ms)
✔ A3 归档后默认 GET /api/tasks 不返回该任务 (47.2049ms)
✔ A4 GET /api/tasks?include_archived=1 返回归档任务 (39.0813ms)
✔ A5 归档前 running → 恢复后仍 running（用 archived_from 还原） (43.0923ms)
✔ A6 恢复后 archived_at 置空 (37.2238ms)
✔ A7 DELETE /api/tasks/:id 对 running 返回 409 (39.5571ms)
✔ A8 DELETE 对非 running 是软删：deleted_at 有值、行还在、默认列表不返回 (37.6154ms)
✔ A9 POST /api/tasks/batch：3 条中 1 条 running 删除失败，2 条成功且各自有原因 (49.1965ms)
✔ A9b batch 支持 archive / restore，且与单条接口结果一致 (42.3292ms)
✔ A10 归档 / 删除 / 恢复各写一条 event：谁、何时、什么操作 (47.4919ms)
ℹ tests 12
ℹ suites 0
ℹ pass 12
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 643.5042
```

（完整原文见 `docs/runs/run-3d22e663/tasks-archive-test.log`，以上为逐字复制。）

---

## 七、全量回归（临时库，生产库零改动）

**隔离方式：**

1. 先用当前代码在 os 临时目录建一个新库（schema v8）作为 `AGENT_OFFICE_DB`；
2. 同一条命令里把 `AGENT_OFFICE_DB` 传给测试进程；G07 夹具 spawn 的 `server.js` 继承同一环境变量，因此也不会连生产库；
3. 跑前跑后对 `data/agent-office.db` 做 sha256 校验。

本次实际临时库：`C:\Users\ADMINI~1\AppData\Local\Temp\soda-full2-yYorwk\full-suite.db`（跑完已删除）。

命令：

```bash
AGENT_OFFICE_DB="<临时目录>/full-suite.db" node --no-warnings --test test/*.test.js
```

真实结果：

```text
ℹ tests 348
ℹ pass 338
ℹ fail 10
```

生产库校验：

```text
5d77e7b1565a5c8e221727639dbc0e0ab39adbb13a4c9e82ae15283187cb2d34 *data/agent-office.db
data/agent-office.db: OK
```

10 条失败明细（全部在本次**未改动**的文件）：

| 文件 | 条数 | 失败内容 |
|---|---|---|
| `test/g02-flows.test.js` | 1 | D1 审批闭环：`#reqs-list .req-item` 15s 不可见（首页旧 UI 时序） |
| `test/g07-r72.test.js` | 3 | L1 工作台布局 / L3 技能卡网格 / L4 文件行三列：旧 CSS 硬编码色值与尺寸对不上 |
| `test/g07-r73.test.js` | 6 | P1 首页驾驶舱 / L1 双视口钉死值 / L4 W02 详情密度 / B5 异常原因行 / R1 上报新鲜度 / R2 上报缺省与离线：同样是 `index.html` + 旧 CSS 的视觉断言 |

这些断言对比的是 `web/app-*.css`、`web/index.html` 的旧视觉值（如期望 `#E56B6F`，实际 `rgb(220, 38, 38)`），本次改动只碰 `board-cromma.*`、`web/lib/db.mjs`、`web/lib/tasks.mjs`、`web/api-tasks.mjs`，没有修改这些文件。判定为**既有失败**，不是本功能引入。

另：仓库现有 `npm test` 脚本是 `node --no-warnings --test test/`，在本机 Node v24.22.3 下直接报 `Cannot find module ...\test`（目录参数不被接受），所以全量用 `test/*.test.js` 显式展开执行。这是脚本本身的问题，本次未改 `package.json`。

---

## 八、截图与自查

脚本：`node --no-warnings scripts/tasks-archive-shots.mjs`
（临时库 + 临时 `AGENT_AUTOLOOP_HOME` + stub 中台 + 动态端口 + 真实 Chrome；全程不连 `data/agent-office.db`、不抢 8080/8090）

| 截图 | 路径 | 我看到了什么 |
|---|---|---|
| 列表含按钮 | `docs/screenshots/tasks-archive/01-list-with-actions.png` | 6 行任务，每行都有「归档」「删除」；顶部有「全选 / 显示已归档」 |
| 归档后灰显 + 标签 | `docs/screenshots/tasks-archive/02-archived-grey-tag.png` | 「Agent 看板深色模式适配」整行变灰（computed opacity **0.55**），标题后可见「已归档」标签，操作变成「恢复 / 删除」；底部 toast「已归档 · Agent 看板深色模式适配（灰显，可恢复）」 |
| 批量选择状态 | `docs/screenshots/tasks-archive/03-batch-selection.png` | 3 行勾选高亮，批量条显示「已选 **3** 条 | 归档 | 删除 | 恢复」 |

第一版截图里「已归档」标签被标题的 `text-overflow: ellipsis` 裁掉了，只看到灰显。已改为 `title` 内 flex：标题名单独省略、标签 `flex:none` 不被裁，并在截图脚本里加了 `tagBox` 与 `titleBox` 的几何断言（标签右边界不得超出标题容器）；重截后标签可见。

脚本同时验证了「点了有反应」：

```text
列表：6 行，归档按钮 6，删除按钮 6
归档：tagText=已归档，opacity=0.55，restore 按钮存在，DB archived_at=2026-11-24T12:08:39.467Z
批量选择：batchCount=3，checked=3
批量归档：请求 3 条，API 里 3 条 archived_at 均有值
恢复：archived_at=null
删除 running：toast=删除失败（HTTP 409）：TASK_RUNNING，任务仍在
软删：列表 6 行 → 5 行，DB 行保留
```

完整机器可读证据：`docs/screenshots/tasks-archive/shot-evidence.json`。
其中 `pageErrors` 只有一条 `Failed to load resource: ... 409 (Conflict)`，这是脚本故意点「删除运行中任务」触发的浏览器网络日志，不是 JS 运行时异常；其余操作零 `pageerror`。

---

## 九、还差什么 / 边界

1. **主工作台 `index.html` 的任务列表没有接这套按钮。** 它读的是 `/api/office/flow`（旧的 office-data 文件链路），不是 `tasks` 表；本次按约束把 UI 做在唯一消费 `/api/tasks` 的看板列表上。若要求主工作台也支持，需要先把那条链路迁到 `tasks` 表，属于另一项改造。
2. **没有新增「停止正在运行的任务」接口。** 任务书只要求 running 删除返回 409；当前 409 文案会提示先停止。真正停止仍走现有执行实例结束路径（`finish` / 外部进程结束），没有在本次新增 stop 端点。
3. **UI 没有“显示已删除”开关。** API 支持 `include_deleted=1`，但看板只做了“显示已归档”；软删恢复目前只能走 API。任务书只点名归档恢复，故未扩前端。
4. **批量失败提示只展示第一条失败原因**（toast 空间有限）；完整逐条结果在 API 响应的 `results[]` 里，测试已覆盖。
5. **删除没有二次确认弹窗**：当前是软删（行保留、可恢复），所以没有加阻塞式 confirm；如果产品要求硬删/二次确认，需要再定义。
6. **全量测试有 10 条既有失败**（见第七节），不是本次引入，但也还未修复。

---

## 十、复现命令

```bash
# 1. 定向验收
node --no-warnings --test test/tasks-archive.test.js

# 2. 全量（务必用临时库；先建 v8 空库再传入）
AGENT_OFFICE_DB="/tmp/tasks-archive-full/full-suite.db" \
  node --no-warnings --test test/*.test.js

# 3. 截图（脚本自己建临时库与临时配置）
node --no-warnings scripts/tasks-archive-shots.mjs
```
