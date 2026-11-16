# W02 第 5 轮验证报告 — 文件版本异常与审批规则校验闭环

日期：2026-11-16 ｜ 代码：web/server.js + web/app.js（app.css 未动）｜ 实测环境：8091（新代码测试实例，已停）/ 8090（已用新代码重启）

原始证据：`verify-w02-round5-api.txt`（API 控制台输出存档）、`verify-w02-round5-ui.json`（CDP getComputedStyle 实测）、`verify-w02-round5-ctx.txt`（右栏大小值出现位置逐条上下文）

---

## 一、改了什么

**server.js（相对备份 server.js.bak-w02r5 共 27 行差异）**
1. `artifactVersionGateOf`：版本变化例外改为独立维度判定——`versionExempt = !!policy`（策略声明在档即豁免阻断，drifted 照常上报）；返回值新增 `versionExempt`。文件类型例外仍在 `artifactGateOf`（test-any-file 豁免 kind 要求），两者分别判定、不混用。
2. `/api/office/version-gate` 响应新增 `versionExempt: g.versionExempt === true`。
3. `artifactVersionMessage` 删掉不可达的策略分支（该文案只会用于无策略声明的正式流程）。
4. decide / decision 两端点与文件头部的口径注释同步更新：正式流程（无策略声明）不享受版本例外，仍按 drifted 严格 409；R11 测试策略明确允许的例外保持 W01 验收④原有行为（放行但上报差异）。

**app.js（相对备份 app.js.bak-w02r5 共 29 行差异）**
1. `scheduleVersionGate` 状态对象透传 `versionExempt`；`artifactVersionGate` 包装层带出。
2. `.material-mismatch` 警示块（mmNote）尾巴按 `versionExempt` 分流：
   - 豁免分支：「本任务声明的测试策略（test-any-file）已入档：登记产物为占位产物，文件类型例外与版本变化例外分别判定——上述版本差异照常展示，但不阻断本测试流程的审批（服务端按同一规则放行）。」
   - 正式分支：「正式流程按提交登记的版本审批：……已禁止按原版本通过，服务端同样会拒绝。请先「打回」要求重新提交——重新登记后的档案才是新版本。」
3. 无新增按钮、无改动审批交互；中央产物行、右侧核对、审批禁用继续吃同一个 versionGate 结果（60s TTL，键 `taskId/stepKey`）。

**app.css：0 行改动**。异常样式沿用既有 `.material-mismatch`（L1562），实测六项全部符合（见下）。

---

## 二、验证了什么（全部真实输出）

### 1. API 矩阵（8091 新代码；判定用字节+sha256 精确值，非四舍五入 KB）

三组一次性夹具（正式流程，无 artifactPolicy）+ R11 真实档案（测试流程，策略在档）：

| 样本 | version-gate | decide（工作台路径） | decision（直写路径） |
|---|---|---|---|
| A 字节相等（490 B） | 200 valid:true, versionExempt:false | 200 → 持久化 done（readBack:true, verified:true） | — |
| B 字节变（登记 490 → 实测 534） | 200 valid:false, why:bytes | **409 ARTIFACT_VERSION_DRIFT**，持久化仍 awaiting | — |
| C 同大小内容变（480 B/480 B，sha 91ef251e→7b214d7f） | 200 valid:false, why:sha | **409 ARTIFACT_VERSION_DRIFT**，持久化仍 awaiting | **409 ARTIFACT_VERSION_DRIFT**（同规，无一严一松） |
| R11 测试流程（登记 80408 → 实测 101786，策略 test-any-file） | 200 **valid:true, versionExempt:true**，drifted 照常上报 | **200 → 持久化 done，by=Leo（工作台）** | **200 → 持久化 done** |

- R11 测试后按字节还原档案+events，sha256 前后一致：`0dd1e387c7908d92…` ✅
- 同 opId 幂等重放返回记录结果且不再写档案（重放前后哈希一致）✅
- 服务端是权威：B/C 即便绕过前端直打 API 也 409；R11 即便差异巨大也按策略放行。**类型例外与版本例外分别判定**：R11 的 app.css 既不是 plan 类文件（类型例外独立豁免）又有版本差异（版本例外独立豁免），两者互不代偿。

### 2. UI 实测（CDP headless Chrome → 8090，getComputedStyle）

**TEST-R11（豁免分支）**：中央 tag「大小不一致」title「登记 78.5 KB ≠ 实测 99.4 KB」；右栏 msz「实测 99.4 KB ≠ 登记 78.5 KB」——同一 versionGate 结果，数字一致。mmNote 完整说明 + 豁免尾巴（无「已禁止」字样）。审批按钮 disabled:**false**、class `btn btn-primary`、无禁用 title。

**TEST-W02B/C（正式阻断分支）**：数字逐字一致（490/534、480/480+指纹 91ef251e）；审批按钮 disabled:**true**、class 含 `btn-invalid-material`、title「…服务端同样会拒绝；请先打回要求重新提交」。

**.material-mismatch 六项 computed style（三个任务全部相同）**：
`background: rgb(52,44,32)`（#342C20）｜`color: rgb(229,185,94)`（#E5B95E）｜`font-size: 12px`｜`line-height: 19px`｜`border-radius: 8px`｜`padding: 10px` ✅

### 3. 「同一大小值不重复三次」口径

异常解释/核对口径文本 = 恰好 2 处（msz 简短摘要 + mmNote 完整说明），同一值在这两处各出现 ≤2 次。

第 3 次出现经逐条定位（verify-w02-round5-ctx.txt）全部来自「**本步产物**」清单段（如 R11：`✓ app.css 99.4 KB 登记 78.5 KB`）。判定**不动它**：
- 它是 TASK-R2 时代就存在的步骤产物盘点（含文件打开、重新核实按钮），对非决策态/已完成步骤是大小信息的唯一展示位，职能不是异常解释；
- 任务硬约束「只改这一处，不要动别的功能」——改它即动 TASK-R2 已验收功能。
- 若按「右栏任何位置 ≤2 次」的字面口径执行，改法是：决策警示在场时清单段省略双口径数字。一句话的事，但属于动别的功能，本轮未做，留给 Leo 拍板。

### 4. 附注

- 任务文本里的「实测约 97.0 KB」是旧截图数字；当前 app.css 实测 101786 B = 99.4 KB，登记 80408 B = 78.5 KB，报告全部用实测值。
- 既有审批行为、大小异常提示、R11 测试策略展示均保留；无新增按钮。
- 收尾：夹具 TEST-W02A/B/C 与 tmp-w02r5 已删；TEST-R11.json 哈希核验与预置值一致；8090 已用新代码重启（/api/health → `{"ok":true,"autoloop":true,"build":"r11c"}`，version-gate 实测 versionExempt:true）。

---

## 三、还差什么

1. **web/ 下非源码产物会被不明清理**：本轮 API/UI 结果文件在 web/ 与 web/tmp-w02r5/ 两度消失（脚本已确认写入成功），根目录存活。原因未查明，证据已改存项目根目录。建议后续排查（疑似系统级清理，非本服务代码——server.js 无 janitor 逻辑）。
2. **本步产物第 3 处数值的口径取舍**待 Leo 拍板（见二.3，不影响本轮①-⑤判定）。
3. 8090 以后台方式重启（2 小时后台时限）；若需常驻请转入服务方式。
