# W02 第 4 轮验证报告 — 审批警告与审批规则同源（版本门禁）

日期：2026-11-16 ｜ 环境：http://127.0.0.1:8090 ｜ 方法：curl 直测服务端端点（version-gate / decide）+ CDP 直连 headless Chrome（--headless=new，1440×900 锁视口）getComputedStyle 实测渲染值。

任务书三组验收数据：①大小一致 ②大小变化 ③内容变化但大小相同 —— 夹具 TEST-W02A/B/C（已生成、已测、已清理）；UI 正常基线另造 TEST-W02D（一致且未审批）。R11 用其真实档案只读核对，档案零改动（sha256 前后一致 `0dd1e387c7908d92`）。

## 一、改了什么

| 文件 | 改动 | 备份 |
|---|---|---|
| `web/server.js` | ① `artifactVersionGateOf` 重写：逐条登记核对，why ∈ missing（文件不存在）/ noreg（登记缺字节数）/ bytes（实测≠登记字节）/ **sha（字节一致但内容指纹≠登记 sha256，系统已有快照字段，据此验证而非只看大小）**；`valid = drifted.length === 0` —— **删掉 `policy ? true` 旁路，test-any-file 只豁免产物类型，不再自动豁免版本一致性**。② 新增只读端点 `POST /api/office/version-gate`。③ decide/decision 端点写前重跑同一函数，409 拒绝（原有调用不变，valid 语义变严） | `server.js.bak-w02r4` |
| `web/app.js` | ① 新增 `versionGate` 状态 + `scheduleVersionGate()`（60s TTL、key 防晚到串台、失败保留旧值、pending 时不禁用——安全边界在服务端）。② 中央第 03 步产物区 hf-tag 按 why 分流（「大小不一致」/「内容不一致」），数字取同一判定。③ 右侧文件行只留简短摘要，数字与警示块逐字相同。④ 警示块（mmNote）为唯一完整版本差异说明；有警示时不再渲染「核对口径」段（压缩重复）。⑤ approve 按钮 disabled 消费同一判定，title 注明服务端同样拒绝。⑥ 未加任何新按钮 | `app.js.bak-w02r4` |
| `web/app.css` | **0 行**（`.material-mismatch` 原有样式实测已符合规格，见下） | — |

三处同源结构：中央 hf-tag / 右侧 msz+警示块 / approve 禁用 → 前端消费 `version-gate` 端点；decide/decision → 服务端写前重跑 `artifactVersionGateOf`。同一产物 ID + 同一审批版本，同一判定函数。

## 二、验证了什么（全部为真实实测值）

### 1. 服务端 version-gate 端点（curl）

| 夹具 | 场景 | 返回 |
|---|---|---|
| TEST-W02A | 大小一致 | `{"valid":true,"drifted":[]}` |
| TEST-W02B | 大小变化 | `valid:false`，why `bytes`，regBytes 490 / actBytes 534 |
| TEST-W02C | 同大小内容变 | `valid:false`，why **`sha`**，regBytes 480 / actBytes 480，regSha `0bc3f2b8…` ≠ actSha `212efdbe…` |
| TEST-R11 | 真实档案只读 | `valid:false`，why `bytes`，regBytes 80408 / actBytes 101786（policy test-any-file 原样上报，不再自动豁免版本） |

### 2. 服务端 decide 端点（curl，审批以服务端返回与持久化为准）

| 夹具 | 结果 |
|---|---|
| A approve | **HTTP 200** `{"ok":true,"status":"done","readBack":true}` —— 真实写回并读回确认 |
| B approve | **HTTP 409** `ARTIFACT_VERSION_DRIFT`「实测 534 B ≠ 登记 490 B」 |
| C approve | **HTTP 409**「实测内容指纹与登记 sha256 不一致（大小 480 B 相同，内容已变化）」—— 同大小内容漂移被指纹拦下 |
| 409 后档案 | B/C 的 plan.status 均仍 `awaiting`（拒绝时未写档案） |

### 3. 前端三处一致 + 样式（CDP getComputedStyle 实测）

**TEST-W02C（内容不一致）：**
- 中央：hf-tag「内容不一致」title「大小相同（480 B）但内容指纹与登记不一致」；hf-val「实测 480 B / 登记 480 B」
- 右侧：文件行「实测 480 B · 登记 480 B · 指纹不一致」；警示块含「（登记内容指纹 0bc3f2b8）」「已禁止按原版本通过，服务端同样会拒绝」
- `.material-mismatch` 实测：background **rgb(52,44,32)**=#342C20 ｜ color **rgb(229,185,94)**=#E5B95E ｜ font-size **12px** ｜ line-height **19px** ｜ border-radius **8px** ｜ padding **10px** —— 六项全中规格
- approve 按钮 `disabled:true` + 类 `btn-invalid-material`；「核对口径」段未渲染（压缩重复生效）

**TEST-W02B（大小不一致）：** 中央 tag「登记 490 B ≠ 实测 534 B」/ 右侧「实测 534 B ≠ 登记 490 B」，样式与禁用同上。

**TEST-W02D（一致基线）：** 无 hf-tag、无警示块、「核对口径：……两者并列以便对版本」段保留（唯一完整口径说明），approve 可用（`disabled:false`，无 btn-invalid-material）。

**TEST-R11（真实测试策略档案）：** 中央「登记 78.5 KB ≠ 实测 99.4 KB」；警示块明确「本任务声明的测试策略（test-any-file）只豁免产物类型要求，不构成版本一致性例外」；approve 禁用。其 basis 只声明对象/类型例外、无版本例外 → 按其实际配置的例外规则执行 = 无版本例外 = 拒绝。

### 4. 无回归抽查
- T-PRODUCT（plan awaiting 无产物）/ T-EASEDRAW（deliverable awaiting 无产物）：走「本步骤尚无登记产物——没有可审批的对象」分支，无审批按钮 —— 该分支在本轮备份 `app.js.bak-w02r4:1349` 中即存在，原有行为，非本轮引入。
- 临时产物已全部清理：TEST-W02{A,B,C,D}.json、tmp-w02r4/ 目录、3 个一次性脚本。TEST-R11.json 及 .bak-w01 未动（sha256 `0dd1e387c7908d92` 测前测后一致）。

## 三、还差什么 / 需要 Leo 决策

1. **TEST-R11 的 plan 步骤在新规则下被阻断**（登记 78.5 KB ≠ 实测 99.4 KB，approve 会 409）。该档案自称「一次性，测完即删」，本轮只读核对未动它——是否删除、打回重提、或给它的 basis 补一句版本例外声明，由你拍板。
2. 真实任务 T-DAILY(req)/T-PRODUCT(plan)/T-EASEDRAW(deliverable) 的 awaiting 均无登记产物，暂无「有产物的真实审批」可抽查——真实链路的一致性由夹具 + R11 真实档案覆盖。
