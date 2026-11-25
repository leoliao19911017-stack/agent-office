# 07 独立评审报告（第三轮 · 终审）

## 总分 8.3 / 10

**达标，可通过 08 验收。** 第二轮的旧确认误伤新实例、停止一个后永久失去入口、详情审计失败部分提交，三个原始场景本轮均未再出现。单活动实例方案仍有交接入口遗漏，新增确认刷新逻辑还有误清有效确认的问题，分别按 P2、P3 扣分；不重复扣已经解决的旧问题。

评审时间：2026-11-25 11:44–11:50（Asia/Shanghai）。对象为当前工作目录的实际文件及未提交改动。先阅读 `07-review-r2.md`，再阅读 `05d-rework-r3.md`，检查 `web/api-tasks.mjs`、`web/board-cromma.js`、`web/lib/state-machine.mjs` 及 attempts、write-owner 实现。未修改业务代码，未提交代码。所有写入复现使用自己启动的真实 `web/server.js`、临时数据库和 Chrome；8090 只读检查，未重启、未创建或删除业务任务。

## 各维度得分

| 维度 | 权重 | 得分 | 加权分 | 证据与扣分依据 |
|---|---:|---:|---:|---|
| 需求达成 | 30% | 8.8 | 2.640 | 三个原始场景通过，存量多实例可逐个停止并删除；但新单实例承诺未覆盖 handoff，见 R3-1 |
| 功能正确 | 25% | 8.0 | 2.000 | 指定测试 60/60；旧确认被拒且 B 不变；新增独立探针证明交接仍能创建第二个 running |
| 代码质量 | 20% | 8.0 | 1.600 | 详情事务内重读重判、确认携带实例标识均有效；约束只放在一个 HTTP 分支，确认清理与按钮显隐使用不同活动实例口径，见 R3-1/R3-2 |
| 体验 | 15% | 8.2 | 1.230 | 实际看板完成计数、进度、归档过滤正确；多实例停止有剩余提示和持续入口；刷新误清有效确认需要用户重走一步，见 R3-2 |
| 稳定性与安全 | 10% | 8.4 | 0.840 | 审计失败回滚通过，旧确认不能改新实例或放行删除；启动约束遗漏仍降低一致性保障，见 R3-1 |

加权合计 **8.310，四舍五入 8.3**，较第二轮 7.8 提高 0.5。提升来自已验证的修复；剩余扣分来自下述本轮证据。没有把测试全绿当作没有缺陷的证明。

## 第二轮三个问题的复核结论

### R2-1（P1）：修好了

原场景：无 pid 实例 A → 点击停止进入确认 → 另一客户端结束 A、启动 B → 刷新 → 使用 A 的旧确认。

- `web/api-tasks.mjs:491` 起要求 confirm 携带目标实例，目标解析只作用于指定实例；首次 STOP_UNVERIFIED 返回结构化 attempt_id。`web/board-cromma.js:1283` 保存 attemptId，`:1271` 将其带回，`:353` 起在刷新时作废换手确认。
- 本轮实测首次确认绑定 A，换手刷新后确认清空、按钮回到“停止”；无 id 的 confirm 返回 **400 / STOP_CONFIRM_REQUIRES_ATTEMPT**；带 A 的旧确认返回 **409 / STOP_TARGET_CHANGED**。
- 探针断言 B 仍 running、end_reason=null、task_stopped 事件数为 0；删除返回 **409 / TASK_RUNNING**。独立外部测试进程仍活着，与数据库口径一致。对 B 重新确认后停止 200、剩余 0、删除 200。

证据：[本轮场景记录](review-r3-evidence/r3-verify.json:6)、[执行日志](review-r3-evidence/scenarios.log)。旧确认误伤新实例的 P1 不再扣分。下述 R3-2 是确认被误清的可恢复体验问题，不是误杀问题复发。

### R2-2（P2）：部分——原死局修好了，新增单实例约束未覆盖全部入口

- `web/api-tasks.mjs:1171` 起在事务内查 running 再创建 attempt。实测普通 attempt 连续启动的状态码由 `[201,201]` 变成 **[201,409]**，第二次为 ATTEMPT_ALREADY_RUNNING。
- `web/api-tasks.mjs:178` 提供 running_attempts；`:1116` 起返回 remaining_running；`web/board-cromma.js:923` 按真实 running 数保留按钮，`:1219` 按剩余数显示停止结果。
- 在隔离库摆出两条历史 running，真实 Chrome 点击停止较新实例后，**剩余 1、按钮仍为 1、删除 409**；继续从界面停止剩余实例后，**剩余 0、删除 200**。原来的“必须先停，但没有停止按钮”死局已经消除。
- 但从已结束的旧实例交接仍能在 B 正在运行时创建 C；不必有历史脏数据，新库即可通过公开 API 制造重复。详见 R3-1。因此不能认可返工报告“从根上不再产生新的重复”的完整承诺。

证据：[本轮原场景记录](review-r3-evidence/r3-verify.json:43)、[新边界记录](review-r3-evidence/new-edges.json:4)。原死局不重复扣分；仅对新增约束覆盖遗漏和新增确认清理缺陷扣分。

### R2-3（P2）：修好了

`web/api-tasks.mjs:995` 先判断状态是否不一致，`:997` 开事务，`:998–1002` 重读任务并重判，确实仍不一致才调用 refreshTaskState。`web/lib/state-machine.mjs:509` 起的状态更新与审计插入由该事务覆盖。

本轮按第二轮原场景创建无实例任务，把缓存 status 设成 running，注入拒绝 status_changed 的 SQLite trigger：GET 返回 **500 / ERR_SQLITE_ERROR**，但 status、status_reason、updated_at **与请求前完全相同**，事件数仍为 0。去掉 trigger 后 GET=200，接口和库都为 waiting，审计事件为 1。另 E4 的已验收 completed 场景同样通过。

证据：[原场景故障注入及对照](review-r3-evidence/r3-verify.json:87)、[E4 测试日志](review-r3-evidence/rework.log)。详情部分提交的扣分撤销。

## 本轮新发现的问题

### R3-1 · P2：新增单活动实例约束遗漏 handoff，可从已结束实例创建第二个 running

**定位：** `web/api-tasks.mjs:1173–1178` 只在 attempt 分支检查；`:1254–1260` 对源实例只校验存在且属于任务；`:1277` 创建新的 running；`:1285` 仅在源实例仍 running 时结束源实例。`web/lib/write-owner.mjs:182` 在目标路径没有活动 owner 时允许转移，不能替代任务级唯一性检查。

**独立复现（没有直接插入 attempts）：**

1. 创建任务，启动 A；finish A 为 completed。
2. 启动 B，返回 201；再次普通 attempt 返回 409 / ATTEMPT_ALREADY_RUNNING。
3. POST handoff，指定 `from_attempt_id=A`、`to_agent_id=codex`，并提供临时目录中的空闲 worktree_path。
4. 返回 **201**；A 仍 completed，B、C 同时 running，数据库查询得到 **2 条 running**。

证据：[请求结果与两条 running](review-r3-evidence/new-edges.json:4)，复现脚本 [review-r3-new-edges.mjs](probes/review-r3-new-edges.mjs)。此路径未启动模型、未真的并行写代码；已证实的是实例约束可被公开接口绕过，不扩大声称发生了文件损坏。

**影响与归因：** 本轮新声明的 single_active_attempt 能力不成立，调用者仍能制造被当成“历史遗留”处理的数据。handoff 原行为不是本轮新写的代码，这是本轮引入单实例约束时遗漏的集成入口，不将其描述成新增加的交接回归。逐个停止与删除仍有效，故不是 P1，也不是上一轮无入口死局。

**修复建议：** handoff 事务内检查所有 running，只允许被这次交接替换的源实例占据活动位置；从已结束实例恢复执行时必须确认没有其他 running。补“结束 A → 启动 B → 从 A 交接被拒、B 不变”的回归，确保正常 A→B 交接仍通过。

### R3-2 · P3：剩余旧实例仍在运行，刷新却把它的有效确认清掉

**定位：** 新确认清理逻辑 `web/board-cromma.js:353–358` 用 active_attempt_id 判断目标是否仍有效；而 `web/lib/state-machine.mjs:217–219` 只把最新 attempt 当活动实例。按钮显隐已经改用 running_attempts（`web/board-cromma.js:923`），确认清理没有同步口径。

**独立复现：** 在上面的 B、C 同时 running 状态下，先停止较新 C；B 仍 running。点击“停止”，409 点名 B，界面保存绑定 B 的确认。没有任何实例换手，仅点击页面“刷新”，确认便从绑定 B 的对象变成 null，按钮从“确认已停止”回到“停止”。前后任务都为 running_attempts=1、active_attempt_id=null；数据库 B 仍 running。

证据：[刷新前后确认态及 B 行](review-r3-evidence/new-edges.json:117)、[实际页面截图](review-r3-evidence/new-edge-refresh.png)。这是本轮新增清理逻辑造成的误失效。页面没有定时调用 loadData，本结论只涉及手动或其他操作触发的列表刷新，不声称定时轮询会触发。

**影响：** 用户刷新后需要重新点击停止取得确认，不能保留仍有效的确认。重新取得确认后停止和删除均 200（同证据 control 段），不存在永久卡死，故定 P3。

**修复建议：** 服务端提供当前可停止目标 id 或完整运行实例 id 集合，刷新时核对确认目标是否仍在运行。不能简单取消目标校验，否则会丢失 R2-1 的换手保护。

## 独立执行与界面证据

以下为本轮亲自运行结果，不是开发方历史日志：

| 命令 / 验证 | 结果 | 证据 |
|---|---|---|
| `node --test test/tasks-archive.test.js` | 12/12，fail 0，约 501ms | `review-r3-evidence/archive.log` |
| `node --test test/tasks-workflow-link.test.js` | 17/17，fail 0，约 6095ms | `review-r3-evidence/workflow.log` |
| `node --test test/tasks-rework.test.js` | 31/31，fail 0，约 41505ms | `review-r3-evidence/rework.log` |
| `node --no-warnings docs/runs/run-3d22e663/probes/review-r3-independent.mjs` | exit 0；三个原场景全部通过修复后断言 | `review-r3-evidence/scenarios.log`、`r3-verify.json` |
| `node --no-warnings docs/runs/run-3d22e663/probes/review-r3-new-edges.mjs` | exit 0；上述两个遗漏均复现，收尾停止/删除 200 | `review-r3-evidence/new-edges.json` |
| live-8090-display-readonly 探针 | exit 0；完成10、十行1/1、页面异常0、非GET请求0 | `review-r3-evidence/live/live-8090-display-readonly.json` |

指定测试汇总 **60/60**。其中测试会嵌套运行旧套件，不宣称有 60 个互不重复的独立覆盖点；预期审计注入错误不计为测试失败。

三个原场景使用已逐段审读的开发方探针副本，修改输出路径保存为本轮评审证据后自行执行；没有冒充从零编写。新问题则使用本轮另写的独立探针，且两个问题可在同一次、全 API 生成的数据中连续复现。两个探针都自行启动隔离服务并在结束后关闭，临时外部测试进程也已清理。

已亲自打开查看本轮生成的 8090 整页截图和隔离服务新边界截图。8090 展示“完成10 / 空闲0”、任务进度1/1；工作流 API 有4个 run、其中1个归档，页面只列3个未归档 run 加“全部任务”。右侧已有模型服务报错属于历史聊天内容，未把它当成本轮任务管理回归。

旧显示探针的 backend.verdict 文案只能识别到“第二轮”，因此另读实际能力数组核实本轮部署：包含 **stop_attempt_binding、single_active_attempt**，见 [api-features.json](review-r3-evidence/live/api-features.json)。返工报告中“8090 仍未重启”的描述已过时，本轮不据此扣分。

## 是否达标

**达标，可通过 08 验收。总分 8.3 / 10，超过目标 8.0。**

本轮已消除原 P1 误伤风险，原多实例停止死局和详情部分提交均有通过证据；指定测试全过，实际界面显示通过。剩余 R3-1（P2）与 R3-2（P3）应登记后续修复，不能把“单活动实例约束覆盖所有入口”写成已验收事实。当前剩余问题未阻断逐个停止、删除和回收站的核心路径，也未复现旧确认改写新实例，因此本次不列为阻断 08 的 P1。

本结论覆盖上述任务管理、三条返工路径及实际显示检查；未执行全项目测试、压力测试或完整权限渗透，不对此作通过声明。
