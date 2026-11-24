# 第二批验收：中央同心圆弧转盘

> 任务书：`docs/TASK-转盘与Agent可添加.md` 第二批（中央转盘）
> 日期：2026-11-24 · 分支 `p0-foundation` · 服务 `127.0.0.1:8090`
> 结论：**24/24 真跑断言全过**。Agent 卡片网格已换成同心圆弧转盘；左弧读 `tool_events` 真实聚合，右弧管道 + 液位，中心显示当前选中 Agent。

---

## 一、先验证图标（任务书前置）

在替换卡片前，先对卡片里的品牌图标做了像素级检查：

| 图标 | viewBox | 实测 | 结论 |
|---|---|---|---|
| Claude | `0 0 248 248` | 橙色 `#D97757` 星芒，24×24 框内完整显示 | 正确，无需修 CSS |
| Hermes | `0 0 39.1 78.5` | `currentColor` 单色翅膀剪影，按比例居中（不是裁切） | 正确，无需修 CSS |

第二批把卡片换成转盘后，这两个图标仍在转盘中心显示当前选中 Agent。验收脚本实测：

```
Claude 中心图标 viewBox=0 0 248 248, fill=#D97757
Hermes 中心图标 viewBox=0 0 39.1 78.5, fill=currentColor
```

证据：`turntable-1440x900.png`（Claude）、`turntable-hermes-1440x900.png`（Hermes）。

---

## 二、工具级采集器 `scripts/tool-events.mjs`

### 2.1 数据源（只读）

```
Claude  ~/.claude/projects/E--DesktopProjects-Soda-Intelligence---AI-Native-Thinking-Soda-Office/*.jsonl
DSH     ~/.dsh/sessions/--E-DesktopProjects-Soda~0020Intelligence~0020-~0020AI~0020Native~0020Thinking-Soda~0020Office--/*/session.v4.jsonl.zstd
```

- Claude：逐行 JSON，取 `message.content[]` 里 `type=tool_use` 的块（也兼容顶层 `type=tool_use`）。
- DSH：`zlib.zstdDecompressSync(...)` 解压，取 `type=tool/call`，工具名在 `data.name`，参数在 `data.arguments`。
- 写入 `tool_events(id, agent_id, session_id, tool_name, target, ts, raw_json)`，`id` 是确定性 SHA1，重复采集 `INSERT OR IGNORE`。
- `tool_event_sources` 是增量账本：Claude JSONL 按字节 offset 只读新增行；DSH zstd 变了才重读。
- `raw_json` 只落库，**不进 `/api/tool-events` 响应**（避免把完整命令/路径/潜在秘密回传浏览器）。

### 2.2 真跑输出

第一次（全量读 78 个 Claude JSONL + 59 个 DSH 会话）：

```json
{
  "inserted": 2792,
  "parsed": 2792,
  "total": 2792,
  "claude": { "files": 78, "skipped": 0 },
  "dsh": { "files": 59, "skipped": 0 },
  "errors": []
}
```

第二次（幂等 + 增量，耗时 0.77s）：

```json
{
  "inserted": 1,
  "parsed": 73,
  "total": 2793,
  "claude": { "files": 78, "skipped": 78 },
  "dsh": { "files": 59, "skipped": 58 },
  "errors": []
}
```

新增的 1 条来自正在写入的 DSH 当前会话，其余文件全部按 mtime/size 跳过。当前库内 2793 条。

### 2.3 聚合 API `GET /api/tool-events`

实测：

```json
{
  "collecting": false,
  "total_all": 2793,
  "by_agent": [
    { "agent_id": "dsh", "count": 1402 },
    { "agent_id": "claude", "count": 1391 }
  ],
  "max_agent_count": 1402,
  "tools": [
    { "tool_name": "bash", "count": 1602, "agents": { "claude": 580, "dsh": 1022 } },
    { "tool_name": "Edit", "count": 418, "agents": { "claude": 290, "dsh": 128 } },
    { "tool_name": "Read", "count": 366, "agents": { "claude": 308, "dsh": 58 } }
  ],
  "rate_15m": { "total": 73, "buckets": 15 }
}
```

采不到时返回 `collecting: true`、`last_run_at: null`，前端显示「工具数据采集中」，不画任何数字。

---

## 三、转盘实现

### 3.1 结构

```
中央 224° 同心圆弧 + 可旋转刻度轨道
左弧  工具调用流（按 tool_name 聚合的 ×次数 + 最近内容 + 最近调用代码块）
中心  当前选中 Agent（名字 / 状态 / 工具次数 / 最近活动）
右弧  数据流管道（stroke-dashoffset 流动）+ 储液罐（液位 = 任务真实 done/total）
```

- 每个 Agent 一个扇区；扇区轨道固定，扇区里的色带弧长 = `该 Agent 工具数 / max(by_agent)`，比例是真实数据。
- 刻度标题 `TOOL CALLS · 0–max`，刻度值由真实 `max_agent_count` 计算；未采集时写「未采集」。
- 选中 Agent：扇区变琥珀色、节点脉冲、中心大字切到它；点击弧上节点即可切换，右侧对话/详情跟着切。
- 左右两个浮动面板贴着弧的两侧，1280 / 1440 / 1936 三档实测都不压中心文字。

### 3.2 动效（全部 CSS，无 setInterval 硬刷）

| 动效 | 实现 | 实测 computed animation |
|---|---|---|
| 刻度轨道缓慢旋转 | `.tt-tickrail` 240s linear infinite，`transform-box: view-box` 绕 (450,392) | `tt-tick-spin` |
| 数据流管道 | `stroke-dashoffset` 动画，3 条管道不同速度 | `tt-dash` |
| 代码块逐行淡入 | 每行 `--i` 递增 delay | `tt-line-in` |
| 光标闪烁 | `steps(1)` 闪烁 | `tt-blink` |
| 选中节点高亮 | 节点外圈脉冲 | `tt-node-pulse` |

刻度旋转实测：取同一根 tick 的屏幕坐标，旋转 3 秒前后到圆心距离都是 `271.657px`，证明是绕圆心转，不是绕 (0,0) 漂移。

### 3.3 液位不是随机

储液罐液位 = `/api/tasks` 全量 `sum(progress.done) / sum(progress.total)`，实测 `60 / 105 = 57%`。
罐内文字、罐下方 `60 / 105 步`、页面读数三者一致。

---

## 四、验收（24/24）

命令：

```bash
npm run tools:collect
node --no-warnings scripts/verify-turntable.mjs
```

实测输出：

```
ALL PASS  24/24
```

覆盖：

1. `/api/tool-events` 200、已采集、Claude/DSH 都有真实事件
2. 15 分钟桶恰好 15 个；聚合不含 `raw_json`
3. 扇区数 = 启用 Agent 数（4）；节点数 = 4
4. 中心默认 Claude，工具次数 = API `by_agent.claude`（1,391）
5. 刻度标题 = `0–1,402`（max by_agent）
6. 左弧 `BASH ×580` = API 里 Claude 的 Bash 次数
7. 左弧有工具分组 + 最近调用内容
8. 液位 57% = 任务 60/105
9. 15 分钟调用率来自真实 buckets（73 次）
10. 五个 CSS 动效全部命中
11. Claude 中心图标官方橙色星芒
12. 两侧面板与中心不重叠
13. 页面无横向溢出、无控制台错误
14. Hermes 中心图标单色翅膀剪影
15. Codex 无工具事件时明说「这个 Agent 没有工具事件，左弧显示全部已采集数据」
16. 1440/1280/1936 三档不重叠、不溢出
17. 采集未跑时左弧 =「工具数据采集中」，节点 =「待采集」，刻度 =「未采集」，中心 =「工具 待采集」，15 分钟卡 =「没有数字」
18. 采集未跑时右弧工具事件 = `—`，不把未知写成 0

证据文件：

```
docs/evidence/turntable/acceptance.json          # 24 项逐条结果
docs/evidence/turntable/turntable-1440x900.png   # 主验收图
docs/evidence/turntable/turntable-1280x800.png
docs/evidence/turntable/turntable-1936x1056.png
docs/evidence/turntable/turntable-hermes-1440x900.png
docs/evidence/turntable/turntable-collecting-1440x900.png
```

---

## 五、测试

相关测试（DB / API / 路由 / 新采集器）：

```bash
node --no-warnings --test test/api.tasks.test.js test/api.agents.test.js \
  test/db.test.js test/tool-events.test.js test/g07-routes.test.js
# 35/35 pass
```

新采集器单测 `test/tool-events.test.js`：4/4 过。用真实临时 JSONL + 真 zstd 压缩，验证：
项目路径 → Claude/DSH 目录名、target 提取、未采集 = collecting、双来源解析、重复采集幂等、聚合计数、按 Agent 过滤、响应无 raw_json。

全量 `test/*.test.js` 300 项：290 过、10 个旧工作台 UI 用例失败（L1/L3/L4/P1/D1/B5/R1/R2 等颜色/布局断言）。这些用例跑的是旧 `index.html`/工作台页面，不加载 `board-cromma.*`；失败项与本批改动无交集。相关 35 项全过。

---

## 六、已知边界（如实写）

- 采集器只覆盖 **Claude / DSH** 两个有本地明文日志的来源；Codex / Hermes 没有工具级日志，转盘上它们的 `×0` 是「采集器没有这个来源」，选中时左弧会明说并回退显示全部已采集数据。
- 左弧默认显示当前选中 Agent 的工具流；切到 Codex/Hermes 会切到「全部 Agent」并显示说明，不拿别的 Agent 数据冒充它。
- `tool_events` 采集是一次性 CLI（`npm run tools:collect`），不是服务端常驻任务；采集没跑时整块转盘如实显示「采集中/待采集」。
- 液位用任务推进（有真实分母），不使用随机噪声；工具事件本身作为右侧「工具事件 / 15 分钟」数值展示。

---

## 七、第三批状态

第三批（转盘区胶囊切换 `Agent 状态 ⇄ EaseDraw`）**未做**，等老板验收第二批后再做。
