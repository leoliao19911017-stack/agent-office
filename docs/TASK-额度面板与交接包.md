# TASK：额度面板 + 结构化交接包

> 老板 2026-11-24 定：两个一起做。
> 依赖已就绪：Agent Chat P1-P7 完成（commit e0af2d1）。

---

## 执行状态

### 第一部分：额度面板 — ✅ 已完成并验收（2026-11-24）

**提交：** `6c89bbd`（单独 commit）
**验收脚本：** `node scripts/verify-quota.mjs` → **24 项检查全过**；`node --test test/quota.test.js` → **7/7 通过**
**证据目录：** `docs/evidence/quota/`（`verify-quota.json`、`api-quotas.json`、`vendor-compare.json`、`board-quota-1440x900.png`）

| 验收项 | 结果 | 证据 |
|---|---|---|
| Q1 3 个 GLM provider，每个 5h + 周两个窗口 | PASS | 闲置 1%/1%、涛哥 0%/40%、磊哥 1%/73% |
| Q2 与厂商接口逐字段一致 | PASS | 3 个 key 的 percentage / remaining / resetAt 全一致；见 `vendor-compare.json` |
| Q3 前端条形图 + 重置倒计时 | PASS | 6 条 bar、3 个 provider 行、详情 tab 有明细；截图 `board-quota-1440x900.png` |
| Q4 响应 / DB / 日志无 key | PASS | 3 个 key 逐字节比对 0 命中；响应无 `token/api_key/authorization/settings_config` 字样 |
| Q5 连续 10 次只打一轮厂商接口 | PASS | `vendor_rounds 1→1`、`vendor_requests 3→3`、10 次全 `hit=true` |
| Q6 Codex 只显示已用 | PASS | `remaining=null`、`remaining_supported=false`，卡片明写「无剩余额度接口」 |

**实现要点：**
- `GET /api/quotas`：`web/api-quotas.mjs` + `web/lib/quota.mjs`
- 只按 `unit` 分类（3=5h，6=周），`TOKENS_LIMIT` / `CREDIT_LIMIT` 都认；unit=5 的 `TIME_LIMIT` 忽略
- 涛哥 key 只有 `percentage`、没有 usage/remaining/reset 时，字段保持 `null`，不拿 0 冒充；重置倒计时标「周」
- key 每次刷新只从 `~/.cc-switch/cc-switch.db` 读一次，只活在后端局部变量；响应白名单输出，不落 agent-office.db
- 内存缓存 5 分钟；3 个 key 一轮 = 3 个 HTTP 请求（不是 3 次/每次刷新）
- Codex 只读 `usage_daily_rollups(app_type='codex')`；当前库最新 rollup 是 2026-10-24，今日无记录，界面如实显示今日 $0.00 / 0 次，并标注最新日期
- 前端：Claude 卡 3 行额度（5h / 周 / 重置），Codex 卡「已用 · 今日」；DSH/Hermes 显示「未接入，不编造」

**字号 / 按钮：**
- 全页字号自检 `node scripts/verify-v2-fonts.mjs` → 最小 11px，正文 13px，`<11px` 0 个
- 额度块最小字号 11px；刷新按钮、4 张 Agent 卡、对话/详情 tab 均实测有反应
- 说明：旧全页脚本 `scripts/verify-v2-buttons.mjs` 按按钮下标点击，右列对话按钮会动态增删导致下标漂移（且隐藏/禁用的停止、发送被当成「无反应」），本次运行有 10 个 FAIL；不是本部分新增按钮，定向点击已单独验证。建议后续把该脚本改成稳定选择器。

### 第二部分：结构化交接包 — ✅ 已完成并验收（2026-11-24）

**提交：** `e8dedba`（单独 commit）
**生成器：** `scripts/handoff/build.mjs`（CLI）；API 壳：`web/api-handoffs.mjs`
**验收脚本：** `node scripts/verify-handoff.mjs` → **32 项检查全过**；`node scripts/verify-handoff-h6.mjs` → **6/6 通过**
**证据目录：** `docs/evidence/handoff/`（`verify-handoff.json`、`h1-handoff.json`、`h4-handoff.json`、`h6-prompt.md`、`h6-answer.md`、`h6-check.json`、`no-key-check.json`、`handoff-panel-1440x900.png`）

| 验收项 | 结果 | 证据 |
|---|---|---|
| H1 真实 thread 生成，6 个板块都有内容 | PASS | `ho-20261124-1036-4`：task/progress/workspace/attempts/dead_ends/next_action 全非空；JSON+MD 双文件 |
| H2 workspace 与 git 一致 | PASS | branch `p0-foundation`、HEAD `fb2ad73…` 与实际一致；`uncommitted_count 614` 与实际 617 − 本次新增 3 个 handoff 文件一致 |
| H3 task 与 agent-office.db 一致 | PASS | `t-20261124022821-85c2cb` / 标题 / 4 条验收逐项对上；task_doc 指向真实文件 |
| H4 attempts 来自真实失败记录 | PASS | `ho-20261124-1036-5`：失败轮次与 `chat_turns` 的 529 记录逐条匹配，不是编的 |
| H5 Markdown 人能读懂 | PASS | 2497 字、8 节、无 JSON dump、无 undefined/乱码 |
| H6 新 Agent 能接手 | PASS | 独立 subagent `handoff-h6` 只读 `h6-prompt.md`，答出「已完成 / 最新检查点 fb2ad73 / 无需继续 / 返工条件 / 已知死路」，6/6 断言通过 |

**实现要点：**
- `POST /api/handoffs`（生成）、`GET /api/handoffs`（列表）、`GET /api/handoffs/:id`（读取 JSON+MD）
- 任务 / 步骤 / attempts / checkpoints / chat_turns 全部来自 `agent-office.db`；branch / HEAD / 未提交来自 `git` 命令；两者在生成时硬编码进包，不经过 LLM
- catchup 已复制到 `scripts/tools/catchup.exe`（也支持 `CATCHUP_BIN` / 临时目录 / PATH 回退）；dsh → `deepseek` 的映射在 `scripts/handoff/build.mjs`
- 会话原文另存 `<handoff_id>.session.md`；主 `.md` 只放结构化交接内容，不塞 5000 字原文
- 对话面板顶部新增「交接包」按钮；生成后可在面板里复制 Markdown、下载 `.md` / `.json`，关闭按钮可收起
- 生成前先取 git 快照再写文件，所以 `workspace` 是「生成那一刻」的现场；`uncommitted` 超过 80 条时标 `uncommitted_truncated`
- 会话部分采用**确定性摘录**（带 `[会话]` 来源标记），不调用 LLM 编 `attempts`/`next_action`；这是为了守住「不编」和 H4 可逐条核对。若后续要 LLM 润色文案，应只作用于 `next_action/open_questions`，事实字段不得交给 LLM
- 交接包 6 个文件逐个与 3 个 GLM key 做字节比对：0 命中（`no-key-check.json`）

**H6 新 Agent 回答（原文）：**
> 任务已完成，验收通过。后端额度 API 和 5 分钟缓存、Codex 已用量、前端额度条（百分比与重置倒计时）、Q1-Q6 真实证据均已完成；最新检查点 fb2ad73，目前没有正在进行的步骤，也没有阻塞。

**说明：** 旧全页按钮脚本 `scripts/verify-v2-buttons.mjs` 仍按按钮下标点击，右列对话按钮会动态增删导致下标漂移（隐藏/禁用的停止、发送也被当成无反应）；本部分新增的「交接包」按钮、复制/下载/关闭按钮已在 `verify-handoff.mjs` 中逐个实测通过。

---

## 第一部分：额度面板

### 1.1 需求

**在 Office 看板上，每个 agent 接入的模型下面显示额度。**

```
Claude(涛哥)   5h ▓▓░░░ 82%   周 ▓▓░░░ 60%   重置 3h20m
Claude(磊哥)   5h ▓▓▓▓░ 27%   周 ▓░░░░ 94%   重置 5h10m  ⚠️
Claude(闲置)   5h ░░░░░ 100%  周 ░░░░░ 99%   重置 4h02m
Codex          已用 $12.40 / 今日 118 次请求
```

### 1.2 GLM 额度接口（我已实测）

```
GET https://open.bigmodel.cn/api/monitor/usage/quota/limit
Header: Authorization: <api_key>       ← 裸 key，不带 Bearer
Header: Accept-Language: en-US,en
```

**返回：**
```json
{ "code":200, "success":true,
  "data": { "limits":[
    {"type":"CREDIT_LIMIT","unit":3,"number":5,
     "usage":28000,"currentValue":178,"remaining":27821,
     "percentage":1,"nextResetTime":1795499923795},
    {"type":"CREDIT_LIMIT","unit":6,"number":1,
     "usage":140000,"currentValue":103096,"remaining":36903,
     "percentage":73,"nextResetTime":1795835951983}
  ], "level":"max" } }
```

**字段映射：**
```
unit=3  → 5 小时窗口
unit=6  → 1 周窗口
percentage  已用百分比（注意是"已用"不是"剩余"）
remaining   剩余量
usage       总量
nextResetTime  毫秒时间戳
level       套餐等级
```

### 1.3 坑（必须处理）

```
① type 有两种：TOKENS_LIMIT（新）/ CREDIT_LIMIT（旧）
   不要按 type 过滤，只按 unit 分类

② 涛哥那个 key 返回 TOKENS_LIMIT 且没有 usage/remaining 字段，
   只有 percentage —— 要兼容"只有百分比"的情况

③ key 从 ~/.cc-switch/cc-switch.db 的 providers 表读
   settings_config 是 JSON 字符串，取 env.ANTHROPIC_AUTH_TOKEN
   只读 name LIKE '%Zhipu%' 的，app_type='claude'
```

### 1.4 Codex

```
OpenAI 官方没有配额查询接口
只能显示：已用多少（从 ~/.cc-switch 的 usage_daily_rollups 读）
app_type='codex'，按 date 聚合
```

**不要假装能显示 Codex 的剩余额度 —— 显示不了就说显示不了。**

### 1.5 实现要求

```
① 新 API：GET /api/quotas
   返回 { providers: [{ id, name, level, windows:[{unit,label,percentage,remaining,resetAt}] }] }

② 缓存：每 5 分钟查一次，不要每次刷新都打厂商接口
   缓存放内存 + 落一张表 quota_snapshots（可选）

③ 前端：在看板右侧或顶部，每个 agent 下面显示
   条形图 + 百分比 + 重置倒计时
   颜色：<50% 正常 / 50-80% 提醒 / >80% 警告

④ 安全：key 只在后端内存里，绝不返回给前端，绝不写进 agent-office.db
```

### 1.6 验收

```
Q1  GET /api/quotas 返回 3 个 GLM provider，每个都有 5h 和 周两个窗口
Q2  数据与厂商接口一致（截图对比）
Q3  前端能看到条形图和重置倒计时
Q4  响应里 grep api_key / token 结果为 0
Q5  连续请求 10 次只打了 1 次厂商接口（缓存生效）
Q6  Codex 显示"已用"，明确标注"无剩余额度接口"
```

---

## 第二部分：结构化交接包

### 2.1 问题

**catchup 能读会话原文，但那是一堆对话，不是「交接包」。**

**换人的时候，接手的人需要立刻知道 6 件事，而不是读 5000 字对话。**

### 2.2 交接包结构

```json
{
  "handoff_id": "ho-20261124-1015",
  "created_at": "2026-11-24T10:15:00+08:00",
  "from": { "agent_id": "claude", "session_id": "...", "reason": "rate_limited" },
  "to":   { "agent_id": "dsh" },

  "task": {
    "task_id": "t-xxx",
    "title": "Agent Chat P7 回归",
    "goal": "把所有验收项重跑一遍",
    "acceptance": ["A1-A7 全过", "G07 19/19"],
    "task_doc": "docs/TASK-AgentChat-分批计划.md"
  },

  "progress": {
    "done": ["P1-P6 已完成并提交", "A1-A5 复验通过"],
    "doing": "正在跑 P7 的 G07 门禁",
    "blocked": "Claude Code 返回 529，无法继续"
  },

  "workspace": {
    "cwd": "E:\\DesktopProjects\\...\\Soda Office",
    "branch": "p0-foundation",
    "head_commit": "1e09fcd",
    "uncommitted": ["docs/evidence/chat-p5/e3a.json"],
    "worktree": null
  },

  "attempts": [
    { "at": "09:38", "what": "跑 P7 第一轮", "result": "failed", "why": "529 限流" },
    { "at": "09:46", "what": "换 key 重试", "result": "failed", "why": "530 限流" }
  ],

  "dead_ends": [
    "不要用 --resume 续 dsh，它不认（unknown option）",
    "不要改 ANTHROPIC_MODEL 的 [1M] 后缀，直连 API 返回 400"
  ],

  "next_action": "用 dsh 跑 P7，续聊用 --session-id",
  "open_questions": ["Claude Code 的 529 是客户端问题还是服务端？"],

  "artifacts": {
    "docs": ["docs/TASK-AgentChat-分批计划.md"],
    "evidence": ["docs/evidence/chat-all/"],
    "session_transcript": "catchup 导出的 Markdown 路径"
  }
}
```

### 2.3 怎么生成

**两种数据源结合：**

```
① catchup 抓会话原文 → 用 LLM 提取成上面的结构
   命令：catchup <agent> --last 20
   
② 系统已知的事实 → 直接填
   git branch / head_commit / uncommitted  ← git 命令
   task_id / goal / acceptance            ← agent-office.db 的 tasks 表
   status                                  ← chat_turns 表
```

**关键：不能只靠 LLM 总结，git 和数据库的事实必须硬编码填进去。**

### 2.4 实现

```
① catchup 定位
   C:\Users\Administrator\AppData\Local\Temp\catchup-bin\catchup.exe
   （临时目录，要复制到项目 scripts/tools/ 下或全局安装）
   实际用：catchup <agent> --id <session-id> --last 30

② 生成器：scripts/handoff/build.mjs
   输入 thread_id 或 task_id
   输出 docs/handoffs/<handoff_id>.json + .md

③ API：POST /api/handoffs       生成交接包
        GET  /api/handoffs/:id  读取
        GET  /api/handoffs      列表

④ UI：对话面板顶部加「生成交接包」按钮
   生成后可以下载 / 复制给下一个 agent
```

### 2.5 验收

```
H1  对一个真实 thread 生成交接包，6 个板块都有内容
H2  workspace 的 branch/commit/uncommitted 与实际 git 状态一致（脚本断言）
H3  task 信息与 agent-office.db 一致
H4  attempts 来自真实失败记录，不是编的
H5  生成的 .md 能被人读懂（不是 JSON dump）
H6  把交接包给一个新起的 agent，它能答出「这个任务做到哪了」
```

**H6 是核心：证明这个包真的能让人接手。**

---

## 第三部分：关系

```
额度面板    告诉你「谁还能干活」
交接包      告诉你「换人的时候带什么走」
```

**两个加起来，才是「agent 之间快速接手」的完整闭环。**

---

## 铁律

- 不编：厂商返回什么显示什么，没有的说没有
- key 不落地、不进日志、不进响应
- 字号 ≥11px，按钮必须有反应
- 每批做完登记 Agent Office + commit
- 做完一批报一批，不要闷头做完才说
