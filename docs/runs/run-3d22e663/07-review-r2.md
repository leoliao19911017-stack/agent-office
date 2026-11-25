# 07 独立评审报告（第二轮）

## 总分 7.8 / 10（目标 8.0）

**不达标，暂不能通过 08 验收。** 上一轮四个 P1 的原始场景均已修好，三组指定测试全部通过，显示层修复也已在当前 8090 生效。本轮独立发现一个新的 P1 和两个 P2：停止确认没有绑定执行实例、多实例停止后界面失去操作入口、详情接口新增状态写入没有事务保护。

评审时间：2026-11-25 08:25–08:32（Asia/Shanghai）。评审对象为当前工作目录，包含未提交改动。已完整阅读 `07-review.md` 与 `05c-rework-report.md`，检查实现并亲自运行测试及探针。业务代码未修改；写入验证均使用临时数据库、隔离服务和无模型调用的测试进程，8090 仅做页面及列表查询，未重启。新增证据位于 `review-r2-evidence/`。

## 各维度得分

| 维度 | 权重 | 得分 | 加权分 | 依据 |
|---|---:|---:|---:|---|
| 需求达成 | 30% | 8.5 | 2.550 | 四个原始 P1 已消除，回收站、停止入口和显示层已交付；多实例情况下“先停再删”仍不能从界面完成，见 R2-2 |
| 功能正确 | 25% | 7.0 | 1.750 | 12+17+27 条全过，独立旧场景也通过；但旧停止确认可误结束新实例并放行删除，见 R2-1 |
| 代码质量 | 20% | 8.0 | 1.600 | 管理操作逐条事务、执行启动守卫、统一状态推导均有改善；确认缺少实例标识，新增 GET 写库遗漏事务，见 R2-1/R2-3 |
| 体验 | 15% | 7.8 | 1.170 | 实测完成 10、每行 1/1、下拉无归档 run；回收站可单条和批量恢复；多实例停止成功后按钮消失但删不了，见 R2-2 |
| 稳定性与安全 | 10% | 7.0 | 0.700 | 并发首开、迁移及删除/启动竞态样本通过；新确认流程的时序缺陷和详情部分提交仍存在，见 R2-1/R2-3 |

加权合计 **7.770，四舍五入 7.8**，比上一轮 6.9 提升 0.9。已修复的四个 P1 不重复扣分；扣分来自本轮有实测证据的剩余问题。未进行完整权限渗透或全量历史测试，不对这些范围作通过声明。

## 上一轮四个 P1 的复核结论

| 上轮问题 | 结论 | 当前实现及本轮实测证据 |
|---|---|---|
| P1-1 状态筛选后批量作用于隐藏任务 | **修好了** | `web/board-cromma.js:2012` 切分类清选择；`:919` 渲染时剔除不可见选择；`:1270` 提交与当前筛选结果取交集。独立复跑“全部勾 waiting → 切执行”：隐藏行数 0、selectedSize=0、批量条隐藏、没有发批量请求、隐藏任务 archived_at=null。见 `review-r2-evidence/probe.json:696`。本轮 C1 还通过了人为插入隐藏 id 后抓请求体的验证（`test/tasks-rework.test.js:251`），不只依赖清空逻辑 |
| P1-2 删除后仍可创建执行 | **修好了（原始启动场景）** | `web/lib/tasks.mjs:253` 统一拒绝 deleted_at；`web/api-tasks.mjs:1091` 检查与建 attempt 同事务，`:1163` handoff 同样保护；`:1124` checkpoint 入口及 `:1261` finish 有守卫；`web/adapters/dsh.mjs:277` 直接执行器入口也保护。独立 DELETE=200，随后 attempt=409/TASK_DELETED，库仍 waiting，见 `probe.json:146`。C2 四入口顺序调用均通过；C2b 本轮 60 次跨进程竞争：删除先赢 52、启动先赢 8、同时成功 0、都失败 0、隐藏 running 0。此结论不声称慢 checkpoint 的所有并发窗口均已覆盖 |
| P1-3 归档期间完成，恢复后“已完成却不能删” | **修好了** | `web/api-tasks.mjs:375` 保留 archived_from 写回，`:380` 随即按证据重算；`:409` 删除先同步再检查 running 实例。独立 running → archive → finish passed → restore：恢复 status=completed，详情 task/state=completed，无活跃实例，DELETE=200，见 `probe.json:219`。本轮 C3、C3b、C3c、C3d 全过，A5 原断言仍过。多实例问题另列 R2-2，不把它冒充原场景未修复 |
| P1-4 管理主记录与审计非原子 | **修好了（归档/恢复/删除及批量）** | `web/api-tasks.mjs:345`、`:370`、`:406` 三操作各自事务；批量继续逐条调用。独立注入拒绝 task_archived 的 trigger：归档=500，但 archived_at=null、事件 0，见 `probe.json:204`。C4 本轮通过归档/恢复/删除回滚和批量部分失败验证（`test/tasks-rework.test.js:552`）。新增详情写库的原子性遗漏另列 R2-3，不否认三条管理路径已修好 |

四个原始场景本轮由 `node --no-warnings docs/runs/run-3d22e663/probes/review-r2-original-scenarios.mjs` 独立执行，exit=0。脚本复用上一轮 HTTP/浏览器场景，调整修复后已隐藏的批量条处理，并将输出改到本轮目录，没有覆盖上一轮证据。脚本退出码只表示执行完毕；上述结论来自响应、DOM 和数据库字段。

## 上一轮三个 P2 的复核结论

| 上轮问题 | 结论 | 当前证据及边界 |
|---|---|---|
| P2-1 无法从列表“先停再删” | **部分修好** | `web/api-tasks.mjs:495` 托管分支先记请求、等 stop、再查进程；`:548` 外部有 pid 时拒绝代杀并给出操作路径；`:579` 无 pid 时要求用户二次确认。`web/board-cromma.js:965` 有停止按钮。本轮 C5/C5b/C5c/C5d 全过，C5 实测真实测试进程退出、600ms 输出不再增长、实例 interrupted/user_stop；C4b 审计失败时进程未停。外部无 pid 的 `verified:false` 是人工声明，不能称为系统验证退出。新增流程仍有 R2-1/R2-2，故不能判整个需求修好 |
| P2-2 软删后 UI 找不回 | **修好了** | `web/board-cromma.html:82` 回收站入口；`web/board-cromma.js:285` only_deleted 查询，`:930` 回收站批量只保留恢复；`web/lib/tasks.mjs:285` SQL 仅取已删除。C6 接口和真实 UI 两项本轮均过：删除后进入回收站、单条恢复、批量恢复、退出后重新出现在普通列表。不是只验证 API 存在 |
| P2-3 多进程首次开库锁冲突 | **修好了（本轮验证样本）** | `web/lib/db.mjs:510` 先设 busy_timeout，`:485` WAL 切换撞锁重试，`:577` 每版本事务内重读版本。本轮 C8 新库 8 服务×2 请求×3轮=48 请求，0失败；C8b v7→v9 8服务×2请求×2轮=32请求，0失败且旧行/rowid保留。另原探针 4服务×2请求输出 `non-200 = 0/8 []`。B1 单进程 v8→v9 也通过；未把这些样本扩大为任意负载下无锁失败的证明 |

托管执行的产品边界也已核实：`rg -n 'startDshAttempt\(' web scripts test/fixtures/tasks-rework-harness.mjs` 只找到执行器定义、自测脚本和测试夹具调用（夹具 `:155`），未找到生产服务启动托管任务的调用。已有外部执行的说明和确认路径可以评审，不额外要求新增花费模型额度的启动产品；但不能把夹具里的托管停止宣传为生产界面已经具备的完整托管链路。

## 返工引入的新问题

### R2-1 · P1：停止的二次确认只绑定任务，旧确认会结束新的执行实例

**复现：** 为任务声明无 pid 的实例 A；页面点“停止”，得到 STOP_UNVERIFIED 并进入“确认已停止”；另一个客户端完成 A 并启动实例 B；刷新列表后仍显示“确认已停止”；点击该按钮，POST 只带 `{actor:"board:ui",confirm:true}`，服务端返回 200，却把 B 标成 interrupted/user_stop。随后 DELETE=200。

第二次探针同时启动了一个独立、无模型调用的长驻 Node 测试进程，模拟 B 的外部执行且按此分支不登记 pid。停止和删除之后 `process.kill(pid,0)` 仍成功，证据记录 `aliveAfterStopAndDelete:true`；探针最终负责终止该测试进程。这证明二次确认并未对应用户先前被告知的 A，能够把未停止的新执行从管理层隐藏，而不是仅按钮文案不准确。

**根因：** `web/board-cromma.js:1244` 的 stopConfirm 只存 taskId，没有 attemptId；`:1225` 也只比较任务，`:1229` 请求不带目标实例。`web/api-tasks.mjs:473` 每次重新选择当前 running 实例，`:585` 确认事务只检查这个新选择的实例是否仍 running，没有核对它是否是用户确认的对象。30 秒过期不能解决窗口内的实例替换。

**证据：** `review-r2-evidence/edge-cases.json:38`（A/B id、第一条提示、按钮文字、实际请求和停止响应）；`:248`（外部测试进程仍存活）；同对象 deleteAfter.status=200。独立脚本 `probes/review-r2-edge-cases.mjs`，真实 Chrome 点击和生产路由，未修改业务实现。

**应修：** 首次拒绝响应提供结构化 attempt_id，前端确认和请求绑定该 id；后端事务内比较目标实例，不匹配返回冲突，要求重新确认。列表刷新遇到实例变化也清确认。补“A 结束、B 接替、旧确认不得改 B 或放行删除”的回归。不能只修改提示文字。

### R2-2 · P2：允许多个 running 实例，但停止一次后按钮消失、删除仍被拒

**复现：** 同一任务连续两次 POST attempt，均=201；POST stop(confirm=true)=200，只结束较新的实例。库中仍有一个 running，状态响应却 active_attempt_id=null；刷新页面该任务“停止”按钮数量=0；DELETE=409/TASK_RUNNING。用户陷入“必须先停止，但界面已没有停止按钮”。

**根因：** `web/api-tasks.mjs:1091` 启动不限制已有 running；`:268`/`:473` 停止仅选最新的 running。`web/lib/state-machine.mjs:217` 起只把最新 attempt 当活动实例，最新实例结束后忽略更早的 running；`web/board-cromma.js:906`、`:966` 据此隐藏停止按钮，而删除守卫 `web/api-tasks.mjs:410` 查所有 running。多实例基础行为并非本轮首次引入，**新增 stop/UI 集成没有处理已有可达数据形态**。

**证据：** `review-r2-evidence/edge-cases.json:254`：startStatuses=[201,201]，stop=200，running 长度1，stopButtons=0，delete=409；截图 `review-r2-evidence/multi-attempt.png`。API 继续调用 stop 可处理剩余实例，但 UI 无法发起该操作。

**应修：** 明确单活动实例约束并处理已有重复记录，或让状态/停止 UI 展示所有尚未结束的实例，停止返回结果必须说明剩余执行。补“两个 running → 停止 → 仍能从 UI 停剩余 → 删除”的场景。

### R2-3 · P2：详情接口新增的状态同步会在审计失败时部分提交

**复现：** 临时任务没有实例，把缓存 status 设为 running；注入只拒绝 status_changed 事件的 SQLite trigger；GET /api/tasks/:id 返回500，但库中 status 已从 running 变为 waiting、updated_at 已变化，status_changed 事件仍为0。

**根因：** 新增 `web/api-tasks.mjs:937`–`:940` 在 GET 中直接调用 refreshTaskState，没有事务。`web/lib/state-machine.mjs:513` 先 UPDATE，`:519` 才 INSERT 审计。同一函数在归档恢复/删除内有外层事务，而详情新调用点没有。

**证据：** `review-r2-evidence/edge-cases.json:417` 的 detailAtomicity 保存 before、500响应、after、events.n=0。与上轮管理操作 P1-4 的故障类型相同，但发生在返工新增路径；本轮按派生状态同步的影响列 P2，不把已修复的归档事务重新判失败。

**应修：** 详情路径在事务内重新读取并同步状态，使状态更新和事件同生同死；补 GET 故障注入断言所有相关记录保持原值。事务内重读还应避免使用跨连接写入前的旧判断。

## 本轮仍需修复的问题（按严重度）

| 优先级 | 编号 | 必须解决的差距 | 主要定位 |
|---|---|---|---|
| P1 | R2-1 | 二次确认绑定具体实例，实例更换时拒绝旧确认，不能误标新执行已停并放行删除 | `web/board-cromma.js:1225`、`:1244`；`web/api-tasks.mjs:473`、`:585` |
| P2 | R2-2 | 多 running 情况停止后仍有清晰可用的停止入口，提示与可删除性一致 | `web/api-tasks.mjs:268`、`:1091`；`web/lib/state-machine.mjs:217`；`web/board-cromma.js:906` |
| P2 | R2-3 | 新增详情状态写入及审计原子提交，故障时回滚 | `web/api-tasks.mjs:939`；`web/lib/state-machine.mjs:513`、`:519` |

## 独立测试与界面验证记录

以下均为本轮亲自执行结果，非引用开发方历史日志：

| 命令 | 结果 |
|---|---|
| `node --test test/tasks-archive.test.js` | exit 0；tests 12 / pass 12 / fail 0；665ms |
| `node --test test/tasks-workflow-link.test.js` | exit 0；tests 17 / pass 17 / fail 0；7001ms |
| `node --test test/tasks-rework.test.js` | exit 0；tests 27 / pass 27 / fail 0；32011ms |
| `node --no-warnings docs/runs/run-3d22e663/probes/review-r2-original-scenarios.mjs` | exit 0；四个原始 P1 场景结果见上表，原始响应在 `review-r2-evidence/probe.json` |
| `node --no-warnings docs/runs/run-3d22e663/probes/review-r2-edge-cases.mjs` | exit 0；显示断言通过，三个新缺陷全部复现；`review-r2-evidence/edge-cases.json`。退出码代表采证完成，并非缺陷验收通过 |
| `node --no-warnings docs/runs/run-3d22e663/probes/first-open-race.mjs "E:/DesktopProjects/Soda Intelligence - AI Native Thinking/Soda Office" 4 1` | exit 0；`round 1: 4 servers × 2 requests, non-200 = 0/8 []` |
| `node --no-warnings docs/runs/run-3d22e663/probes/live-8090-display-readonly.mjs http://127.0.0.1:8090 docs/runs/run-3d22e663/review-r2-evidence/live` | exit 0；10条 completed、10条1/1；API有4个run，其中1个已归档，DOM仅3个未归档run加“全部任务”；页面异常0、非GET请求0 |

三组汇总为 **56/56**。其中 B10、C7 会嵌套运行旧测试，不宣称56条是互不重复的独立覆盖。返工测试中打印的审计注入 ERR_SQLITE_ERROR 属于 C4b 的预期故障，最终 fail=0。

**自己启动的服务：** 探针通过 `test/chat-harness.mjs` 起真实 `web/server.js`、临时库和 Chrome，造10条 completed（步骤仍pending）及一个 archived run，实测“完成10 / 空闲0”、十行全部1/1、下拉排除 archived id。证据 `edge-cases.json:4`、`display.png`、`display-rail.png`；截图已亲自打开查看。实现定位：`web/lib/state-machine.mjs:434`、`web/lib/tasks.mjs:384`、`web/board-cromma.js:25`、`:1032`、`web/lib/workflow-engine.mjs:380`。

**当前8090：** 08:28现场结果同样满足要求，见 `review-r2-evidence/live/live-8090-display-readonly.json:30`、`:45` 及 `live-rail-2x.png`（已打开查看）。因此返工报告里“还需要再次重启8090”的旧现场描述不再适用于本次评审；本轮不以此扣分。

## 是否达标

**不达标：7.8 / 10，暂不能通过 08 验收。** 差距为0.2分，且存在必须修复的 R2-1。返工已解决上一轮四个原始 P1，正常路径、回收站、并发首开和显示层有明确改善；剩余工作应集中在上述三个有证据的新问题，不需重做已通过功能。

修复 R2-1、R2-2、R2-3 后，重跑对应边界场景与指定三组测试，再复核停止、状态、审计及删除是否一致。不得仅凭56条现有测试全过宣告达标，因为本轮已证明这些测试未覆盖上述失败路径。
