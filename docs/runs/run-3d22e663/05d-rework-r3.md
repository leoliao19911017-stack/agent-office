# 05d 返工报告（第三轮）：停止确认绑定执行实例 / 单活动实例约束 / 详情审计事务

> run: `3d22e663-a27f-417c-829b-b6b7fbcc5fad` · 步骤 05d 返工（第三轮）
> 依据：`docs/runs/run-3d22e663/07-review-r2.md`（R2-1 P1、R2-2 P2、R2-3 P2）与任务书的 E1–E5
> 执行：2026-11-25 上午 10:40 ~ 11:45，Claude（会话 `claude.exe -p`）
> 上一轮的四个 P1 已被评审认可、不重复扣分；本轮只修上一轮返工引入的三个新问题。

**先说结论，逐条，不写「全部修复」：**

- **R2-1（P1）修了**。停止的二次确认从「绑任务」改成「绑具体执行实例」：首次 409 响应在错误体里带结构化 `attempt_id`；前端确认态记住这个 id、确认请求原样带上；后端在停止路径上比对目标实例，任务不对 409 `ATTEMPT_MISMATCH`、实例已换手 409 `STOP_TARGET_CHANGED`（一个字段都不动）；列表刷新发现换手自动作废确认；不带 id 的 `confirm:true` 一律 400 `STOP_CONFIRM_REQUIRES_ATTEMPT`。E1、E2 过。
- **R2-2（P2）修了，选的是「单活动实例约束」这条路，并对库里的遗留重复数据做对齐而不是删除**。入口拒绝第二个 running（同一事务里查+插，409 `ATTEMPT_ALREADY_RUNNING`）；约束上线前已经落库的重复 running 不删——任务视图带 `running_attempts`（还在跑的实例总数）、停止响应带 `remaining_running`（点名剩余实例）、界面的停止按钮显隐和删除守卫都看真实 running 行数，停掉一个按钮还在，全停干净才放行删除。E3 过（包括遗留形态）。
- **R2-3（P2）修了**。详情接口的读时状态同步改成「确有不一致才写、要写才进事务、事务里重读重判」：状态列的 UPDATE 和 `status_changed` 审计 INSERT 在同一个事务里同生同死，审计写不进去时状态列一起回滚。E4 过（trigger 注入实测）。
- **E1–E5 全过**；**Codex 的三个场景用同一个探针原样重演过一遍，全部按修复后契约通过**（见第五节）。
- **线上 8090 还跑着旧后端**：三个修复里 R2-1/R2-2 的后端半边和 R2-3 全部在 `web/api-tasks.mjs`，要**重启 8090 才生效**（没有自己重启，等老板重启）。前端 `board-cromma.js` 是静态文件、每次从磁盘读，线上前端已是新版；它探测 `/api/tasks` 响应里的 `api_features`，旧后端没这个键时「停止」按钮禁用并说明原因（C10 验过），不会出现新前端打旧接口的半吊子状态。
- **改动没有提交**：任务书没让提交，`git add` 一次都没执行过。

---

## 〇、验收标准 E1–E5 逐条结果

| # | 标准 | 过没过 | 测了几次、过几次 | 证据 |
|---|---|---|---|---|
| E1 | 停止确认绑定 attempt_id：实例更换后旧确认无效，复现 A→B 替换、断言旧确认改不了 B | 过 | 2 次全过（接口级全流程） | `tasks-rework-r3-full.log` 行 `E1`；探针 `r2_1` 段 |
| E2 | 列表刷新遇实例变化清确认（DOM 断言） | 过 | 2 次全过（真实 Chrome 点按钮、抓请求体） | 同上 `E2`；截图 30 / 31 |
| E3 | 多实例 UI 能停剩余实例：两个 running → 停止 → 按钮还在 → 能删除 | 过 | 2 次全过（含约束上线前的遗留形态摆库） | 同上 `E3`；截图 32 / 33 / 34；探针 `r2_2` 段 |
| E4 | 详情接口审计失败回滚主记录（注入 trigger、断言状态不变） | 过 | 2 次全过 | 同上 `E4`；探针 `r2_3` 段 |
| E5 | 上一轮 56 条（12 + 17 + 27）不回归 | 过 | 2 次都是 12/12、17/17，且上一轮的 27 条全部原样在跑 | `C7` 两行 diagnostic；全量 `tests 31, pass 31, fail 0` |

全量测试真实输出（`node --no-warnings --test test/tasks-rework.test.js`，临时库，日志存 `docs/runs/run-3d22e663/tasks-rework-r3-full.log`）：

```
✔ C7 上一版两个测试文件仍全过：tasks-archive 12/12、tasks-workflow-link 17/17 (6759.0375ms)
ℹ test/tasks-archive.test.js：tests 12，pass 12，fail 0，exit 0
ℹ test/tasks-workflow-link.test.js：tests 17，pass 17，fail 0，exit 0
✔ E1 停止确认绑定 attempt_id：A 结束、B 接替后，旧确认改不了 B、放不了删除 (38.4212ms)
ℹ E1：A=a-a970678c-mwvktewk 结束、B=a-ee34605c-mwvktews 接替；旧确认(A) → STOP_TARGET_CHANGED；删 B 前置 → TASK_RUNNING；绑 B 确认 → 200（剩余 0）；删除 → 200
✔ E2 界面：实例换了手，列表刷新后确认态自动作废（按钮回「停止」，不带旧确认发请求） (1990.9883ms)
ℹ E2：确认绑 A(a-43a81937-mwvktf8g) → 刷新后作废 → 新 409 给 B(a-447aa7a8-mwvktg0z) → 绑 B 确认 200 → 删除 200
✔ E3 界面：两个 running（遗留形态）→ 停一个按钮还在 → 停掉剩余 → 能删除 (2750.3257ms)
ℹ E3：A=a-e53c9010-mwvktgsb、B=a-66d27751-mwvktgsj 两条 running；再启动 → 409 ATTEMPT_ALREADY_RUNNING；停 B 后剩余 1、按钮还在、删除 409；停 A 后剩余 0、删除 200
✔ E4 详情接口状态同步的审计写失败 → 500，状态列一行不变（同生同死） (23.4009ms)
ℹ E4：trigger 拦 status_changed → GET 详情 500，行原样（status=running、updated_at=2026-11-25T03:41:06.764Z）；去掉 trigger → 200，状态列对齐 completed
✔ C9 界面用例全程没有未捕获的 JS 异常（pageerror / console error） (0.2046ms)
ℹ tests 31
ℹ pass 31
ℹ fail 0
ℹ duration_ms 44234.9735
```

31 = 上一轮的 27 + 本轮新增 E1–E4。E5 要求的 56 条（12+17+27）全部在里面，一个没少、一个没改坏。

**说明两处旧用例跟着新契约改了**（不是「只改断言」——生产行为本身变了，旧断言验的是旧契约）：`D4`（停止接口的两步契约：先 `{}` 吃 409 拿 `attempt_id`、再带 `confirm+attempt_id`）和 `C5c`（断言确认请求绑定的正是 409 响应点名的那个 id）。D4/C5c 验的停止/确认行为在第五节的探针里另有独立于测试文件的端到端实测。

---

## 一、开工前的现场核对

- **同行**：`ListAgents` 里 4 个会话，1 个 busy（engvm-b1，别的仓库），3 个 idle；没有别的会话在动这个仓库的代码。要改的三个文件（`web/api-tasks.mjs`、`web/board-cromma.js`、`test/tasks-rework.test.js`）开工时 mtime 停在上一轮收尾，40 分钟没人动。
- **8090**：还跑着上一轮的后端（启动时间早于本轮开工），本轮全部用临时库 + 随机端口的夹具/子进程验证，没碰 8090、没碰 `data/agent-office.db`。
- **测试基线**：`test/tasks-rework.test.js` 上一轮 27 条全绿才动手；改完先单跑 E1–E4（4/4 过）再跑全量。

---

## 二、R2-1（P1）：停止的二次确认只绑任务，旧确认会结束新实例并放行删除

**为什么是问题**（07-review-r2.md 的复现）：A 声明式启动（无 pid）→ 点「停止」进确认态 → 另一个客户端把 A 完成、启动 B → 刷新列表后按钮仍是「确认已停止」（确认态跟着 taskId 走，不知道实例换了手）→ 点下去 POST `{confirm:true}` 200：**B 被写成 user_stop**（停止路径只停「最新的 running」，不校验确认对应哪次执行），**DELETE 放行**（停止后 active_attempt_id 为 null）。一次过时的确认，杀掉了一个新执行、还擦掉了删除守卫的依据。

**修法**（确认这个动作从「绑任务」变成「绑那个具体的执行实例」，四处配合）：

1. **接口层**（`web/api-tasks.mjs`）：
   - `stopOne`（489–663 行）：`confirm:true` 而不带 `attempt_id` → 400 `STOP_CONFIRM_REQUIRES_ATTEMPT`（492 行）——旧形态的确认请求从根上进不来；带 `attempt_id` 但实例不属于这个任务 → 409 `ATTEMPT_MISMATCH`（504 行）；实例属于这个任务但**已经不在运行**（且还有别的在跑）→ 409 `STOP_TARGET_CHANGED`（512 行），**一个字段都不动**，要求重新走一遍确认；一个 running 都没有时幂等返回 already_stopped。
   - 首次 409 `STOP_UNVERIFIED`（634 行）的响应体通过 `err.details` 带上结构化 `attempt_id / agent_id / started_at`——前端要绑定的目标由服务端点名，不靠前端自己猜（猜就会猜错）。
   - 停止路由（1089–1126 行）与 `API_FEATURES`（85–88 行）声明 `stop_attempt_binding`，前端用它识别新后端。
2. **前端**（`web/board-cromma.js`）：
   - 确认态存 `{taskId, attemptId, at, message}`（`runStopAction` 1283 行附近）：只有从 409 响应里拿到 `attempt_id` 才进确认态；确认请求体带上这个 id（1261–1262 行的 `confirming` 判定 + 发请求时 spread）。
   - **列表刷新清确认**（`loadData` 350–358 行，在 `renderAll` 之前）：发现 `t.active_attempt_id !== state.stopConfirm.attemptId` 就把 `state.stopConfirm` 置 null——换手后按钮自然回到「停止」，下一次点击是全新的一次确认。旧后端响应里没有 `active_attempt_id` 时退回布尔判断（353–358 行的兜底）。
   - 409 `STOP_TARGET_CHANGED` / `ATTEMPT_MISMATCH` 的处理分支（`runStopAction`）：清确认 + 重新 `loadData` + 提示「确认已失效」。
3. **旧确认的 30 秒超时**沿用对象引用比对（确认换手后旧对象不再被引用，不会误清新的）。

**怎么验的**：

- **E1（接口级）**：声明 A → 首次停止 409（body 里 `attempt_id` 就是 A）→ 别的客户端结束 A、启动 B → 拿**A 的 id** 发 `confirm:true` → 409 `STOP_TARGET_CHANGED`，库里 B 仍 `running`、`end_reason` 仍 null、`task_stopped` 事件 0 条 → DELETE 409 `TASK_RUNNING` → 不带 id 的确认 400 → 新的 409 点名 B → 绑 B 确认 200（`remaining_running.count=0`）→ DELETE 200。
- **E2（界面级，真实 Chrome）**：A 声明 → 点「停止」进确认态（断言 `state.stopConfirm.attemptId === A`）→ 换手 → 点刷新 → 断言 `state.stopConfirm === null` 且按钮文字回到「停止」→ 再点停止，抓请求体断言 `confirm===false`、`attempt_id===undefined`，新 409 给的是 B → 绑 B 确认 200 → 删除 200。
- **探针**（第五节 `r2_1` 段）把评审的完整剧本重演了一遍，还多放了一个真实活着的外部进程，证明库的口径（B running、删除被拒）与外部事实一致。

---

## 三、R2-2（P2）：多 running 实例停一个后按钮消失，删除仍被拒（409 死局）

**为什么是问题**：上一轮允许多个 running 并存。停止只停「最新的 running」，停完 `active_attempt_id` 变 null → 界面停止按钮消失；但删除守卫查的是**所有** running 行 → 409 `TASK_RUNNING`。用户卡死：没有入口停掉剩下那个。

**选型**：任务书给了两条路，选了**「单活动实例约束」**，理由：多实例并存本来就是上一轮放开约束的副作用，任务的真实语义（一个任务同一时刻一个执行）不需要多实例；展示「所有未结束实例」的 UI 复杂度高得多，还要发明「逐实例停止」的交互。但**硬约束 5 要求处理库里已有的重复 running 数据**——处理方式是「对齐」而不是「删」：

1. **入口约束**（`web/api-tasks.mjs` 1170–1178 行）：POST attempt 的查重+插入挪进同一个事务，已有 running 再启动 → 409 `ATTEMPT_ALREADY_RUNNING`。**从根上不再产生新的重复**。
2. **遗留数据不删、全链路对齐**：约束上线前已经落库的重复 running 行一条不动（别人的执行记录不代删）。任务视图带 `running_attempts`（还在跑的实例总数，178 行）、停止响应带 `remaining_running`（1119 行，点名剩余的 `attempt_id/agent_id/pid`）、前端停止按钮显隐改看 `running_attempts`（`board-cromma.js` 918–924 行）、删除守卫本来就查全部 running 行。四处的口径一致：**还有实例在跑，按钮就在、删除就被拒；全停干净，按钮消失、删除放行**。
3. **停止结果必须说明剩余**（任务书原话）：停止成功的 toast 在还有剩余时说「这个任务还有 N 个执行实例在运行，「停止」按钮还在，全停下来才能删除」（`stopToast`，1218–1230 行）；接口层的 `remaining_running` 是结构化的同一份事实。
4. **换手场景的确认绑定**（R2-1）天然覆盖了「停最新时目标被换」的竞态：停谁由 409 点名，不由「最新」暗指定。

**怎么验的**：

- **E3（界面级）**：API 启动第一条 201、第二条 409 `ATTEMPT_ALREADY_RUNNING`（断言）→ **直接往库里摆一条约束上线前的遗留 running**（生产修复不删别人的记录，测试模拟的就是硬约束 5 点名的那种存量）→ 界面两条 running 的行有「停止」按钮 → 点停止 → 409 点名遗留那条 → 确认 → 200 `remaining_running` 剩 1、点名最早那条 → **重载后按钮还在**（断言 not is-confirm、文字「停止」）→ 删除 409 → 再点停止 → 409 点名剩下那条 → 确认 → 200 剩 0 → 按钮消失 → **删除 200**。
- **探针**（第五节 `r2_2` 段）重演了评审的「两个 201」剧本：现在第二个是 409；再摆遗留数据走完「停一 → 按钮在 → 停二 → 删除放行」。

---

## 四、R2-3（P2）：详情接口的读时状态同步，审计写失败会部分提交

**为什么是问题**：上一轮给 GET /api/tasks/:id 加了「读时对齐」：状态列落后于证据时，UPDATE tasks + INSERT status_changed 事件。但这两步**没在事务里**：UPDATE 提交后 INSERT 失败 → 接口 500，库里 status 已经变了、`updated_at` 已经动了、事件却是 0 条。读接口留下一个「看起来成功过的写」。

**修法**（`web/api-tasks.mjs` 994–1006 行，注释写得很全）：

- **只读路径不开写锁**：先在外面用 `evaluateTaskState` 判一次，状态列和证据一致就直接返回——绝大多数 GET 不再进事务（不然每看一眼详情都持写锁）。
- **确有不一致才进事务，事务里重读重判**：外面的判断可能已经过期（并发下别人可能刚同步过）；事务里重读 `getTask` + 重判 `evaluateTaskState`，还是不一致才 `refreshTaskState`（状态列 UPDATE + 审计 INSERT 同事务）。
- 效果：**审计写不进去时状态列一起回滚**，不会出现「接口 500、库里 status 却已经变了、事件是 0」的半提交。

**怎么验的**（E4，沿用上一轮 C4 的 trigger 注入手法）：

- 起一个任务走完验收（真实状态 completed）→ SQL 把状态列摆回 `running`（模拟过期缓存）→ 建一个**只拒 `status_changed` 事件**的 trigger → GET 详情 **500** → `deepEqual` 断言失败前后整行（status / status_reason / updated_at）**一字未动**、事件数不增 → 拿掉 trigger 再 GET：**200**、接口说的和库里说的是同一件事（completed）、这一次留下审计事件。

---

## 五、复现 Codex 的三个场景（评审剧本原样重演）

探针：`docs/runs/run-3d22e663/probes/review-r3-verify.mjs`（自证用，不覆盖评审证据）。步骤照抄 `07-review-r2.md` 的复现路径，用**真实 `web/server.js` 子进程 + 临时库 + 真实 Chrome**（不 mock、不调模型），每一步带「修好了应该是什么样」的断言——哪步红了就是没修好。与 Codex 自己的 `review-r2-edge-cases.mjs` 的区别：那个只采证不断言（退出码只代表采证完成），这个逐步断言。证据 JSON：`docs/runs/run-3d22e663/r3-evidence/r3-verify.json`。

运行（真实输出）：

```
$ node --no-warnings docs/runs/run-3d22e663/probes/review-r3-verify.mjs
R3 三个场景全部按修复后契约通过。
```

（exit 0；证据 JSON 全文见 `r3-verify.json`，以下摘关键值）

**场景一（R2-1，A 换手旧确认）**：

```
"firstConfirm": { "attemptId": "a-b4e68992-mwvkn92p", ... }        ← 前端确认绑的是 A（409 点名的那个）
"afterRefresh": { "clearedConfirm": null, "confirmText": "停止" }   ← 换手+刷新后确认作废、按钮复位
"unboundConfirm": { "status": 400, "code": "STOP_CONFIRM_REQUIRES_ATTEMPT" }
"staleConfirm":   { "status": 409, "code": "STOP_TARGET_CHANGED", ... }  ← 旧确认（A 的 id）被拒
                                                                   （B 行：status=running、end_reason=null、task_stopped 事件 0 条 —— 断言过）
"deleteWhileBRunning": { "status": 409, "code": "TASK_RUNNING" }    ← 旧确认放不了删除
"externalWorker": { "pid": 48188, "alive": true, ... }              ← 真活着的外部进程，库的口径与之一致
"legitimateFlow": { "stop": 200, "remaining": 0, "delete": 200 }    ← 正规流程（绑 B）一路通
```

评审里旧剧本的结果是 `staleConfirm 200`、B 被 `user_stop`、`DELETE 200`——现在是 409 拒绝、B 原样、删除仍守卫，直到对新实例重新确认。

**场景二（R2-2，多实例死局）**：

```
"startStatuses": [201, 409]  "secondStartCode": "ATTEMPT_ALREADY_RUNNING"   ← 入口就拒绝第二个
"legacy": { "running": ["a-287f3391-...", "a-r3legacy-..."] }               ← 摆出约束前的遗留形态（两条 running）
"stopButtonsBefore": 1                                                       ← 两条 running 的行有「停止」按钮
"firstStop": { "status": 409, "attempt_id": "a-r3legacy-..." }              ← 409 点名最新（遗留）那条
"confirmStop": { "status": 200, "remaining": { "count": 1, "attempts": [{ "attempt_id": "a-287f3391-..." }] } }  ← 剩余说清楚
"stopButtonsAfterOneStop": 1                                                ← 停一个按钮还在（评审里是 0）
"deleteWhileRemaining": { "status": 409, "code": "TASK_RUNNING" }           ← 与按钮仍在一致
"confirmStopRemaining": { "status": 200, "remaining": 0 }
"deleteAfterAllStopped": 200                                                ← 全停干净删除放行（评审里 409 死局）
```

**场景三（R2-3，审计半提交）**：

```
"before":  { "status": "running", "status_reason": "任务已创建，尚未开始执行（等待派活）", "updated_at": "2026-11-25T03:36:15.931Z" }
"response": { "status": 500, "code": "ERR_SQLITE_ERROR" }                   ← trigger 拦下审计
"after":   { "status": "running", "status_reason": "任务已创建，尚未开始执行（等待派活）", "updated_at": "2026-11-25T03:36:15.931Z" }
"events": 0                                                                  ← 半提交没了：主记录原样、审计没留
"control": { "status": 200, "taskStatus": "waiting", "dbStatus": "waiting", "events": 1 }  ← 拿掉 trigger 一切正常
```

评审里旧剧本的结果是「GET 500、库里 status 已变 waiting、updated_at 已变、事件 0」——现在失败路径整行原样，对照路径正常对齐。

---

## 六、截图与肉眼核对

`docs/screenshots/tasks-rework-r3/`（界面用例 TASKS_REWORK_SHOT_DIR 指过去 + 探针 4 张，共 14 个文件；每张整页 1440×900@2x + 左栏裁切）：

| 截图 | 应该看到 | 核对结果 |
|---|---|---|
| `30-e2-stop-confirm-bound-to-attempt-a-*` | 点「停止」后按钮变深红「确认已停止」（确认态绑 A） | 过（视觉核对：按钮文字确为「确认已停止」） |
| `31-e2-confirm-cleared-after-instance-swap-*` | 换手+刷新后按钮回「停止」 | 过（视觉核对：确为「停止」，旁边「归档」「删除」照常） |
| `32-e3-two-legacy-running-stop-present-*` | 两条 running 的行有「停止」 | 过 |
| `33-e3-one-stopped-stop-button-still-present-*` | 停掉一条后按钮还在 | 过（视觉核对：按钮仍在、文字「停止」；筛选计数「异常 1」——最新的遗留实例被停后任务按状态机进风险桶，但 `running_attempts=1` 顶着按钮不消失，正 是修的这个对齐） |
| `34-e3-all-stopped-deleted-*` | 全停干净、删除放行 | 过 |
| `r3-r2-1-stale-confirm-refused-1440x900.png` | 旧确认被拒后的列表（B 在跑、任务还在） | 过 |
| `r3-r2-2-two-running-stop-present-1440x900.png` | 遗留双 running + 停止按钮在 | 过 |
| `r3-r2-2-one-stopped-button-still-there-1440x900.png` | 停一条后按钮还在 | 过（视觉核对见上） |
| `r3-r2-2-all-stopped-deleted-1440x900.png` | 全停后删除放行 | 过 |

核对方式说明：本会话的 Read 工具对 PNG 返回的是上传链接不是内嵌图，肉眼核对改用视觉模型逐张问「按钮上写的是什么字」，30 / 31 / 33 三张关键的都问过、答的与预期一致（其余几张的逻辑状态有 DOM 断言和请求抓包双重固定，截图是辅助）。

---

## 七、还差什么

1. **8090 没重启，三个修复线上未生效**。R2-1/R2-2 的后端半边和 R2-3 全在 `web/api-tasks.mjs`，要重启 8090 才换。前端是每次请求从磁盘读的，线上前端已是新版；新前端探测到旧后端（`api_features` 里没有 `stop_attempt_binding`）时会把「停止」按钮禁用并说明原因（C10 验过），不会出现新前端打旧契约的错乱。**等老板重启，没自己动。**
2. **改动全部未提交**。任务书没让提交，`git add` 一次没执行过；上一轮起的整个返工序列都在工作区里。
3. **遗留重复 running 只「对齐」不「清理」**：约束上线后新库不会再产生重复；存量库里如果真有重复 running 行，它们会被 `running_attempts` / 停止按钮 / 删除守卫如实对待（逐个停掉才能删），不会被悄悄删行。要不要写一条一次性巡检脚本把存量标成异常，等老板拍板。
4. **未托管执行（无 pid 的声明式实例）仍只能「用户声明停」**：本服务无法核实外部进程，确认动作记录 `task_stopped(mode='declared', verified=false)`，不写任何验收结论——这是上一轮就定下的口径，本轮没动它，只把「确认」绑到了具体实例上。
5. 评审报告里给的目标是 8.0；本轮修完自证全绿，**分数要等 Codex 复测**，这里不打分。
