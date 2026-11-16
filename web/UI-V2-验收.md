# TASK-5.1 UI-V2 验收报告（Agent 工位改造）

- 验收对象：`http://127.0.0.1:8090`（Leo's Agent Office）
- 验收日期：2026-11-13
- 改动文件：**仅 `web/index.html`**（重写 HTML 结构 + CSS + 前端 JS）。`web/server.js` 及 5 个 API 路由一行未动，Autoloop 未动，未生成新图片（复用 TASK-4.1 的三张星月夜素材）。
- 验证方式：headless Edge（Edg/157.0.4341.46）+ CDP 直连（`--remote-debugging-port=9222`，独立临时 profile，不碰用户浏览器），验收脚本 `web/verify-assets/verify-5.1.mjs`（零依赖，Node 24 原生 WebSocket），视口 1440×1000。

---

## 一、逐条验收（真实输出）

### 1. 改名 Leo's Agent Office，旧品牌零残留 ✅

```
Runtime.evaluate → document.title
"Leo's Agent Office"

$ grep -c "Soda Agent 工作台\|SODA INTELLIGENCE" web/index.html
0        （exit 1 = 无匹配）

hero kicker（DOM 实读）: "LEO'S AGENT OFFICE"
hero 副题: 「星夜之下，每位成员在自己的工位上赶路；需要你拍板的事，会亮成金星。」
页脚: 「Leo's Agent Office · 数据来自 Agent Autoloop · 每 3 秒自动刷新」
```

### 2. 工位卡数量 === 4 ✅

```
Runtime.evaluate → document.querySelectorAll('.workstation').length
4
```

### 3. 卡片数据与 /api/state 一致（三口径对比：API ↔ 页面渲染用的 lastState ↔ DOM）✅

DOM 工位卡实读（verify-5.1.mjs 验收3 输出）：

```
claude          name=Claude Code     role=开发  conn=online  work=空闲  load=执行中 0 · 排队 0 · 重试 0  today=今日完成 3 项  cost=累计成本 $2.27 · 15.6 万 Token
codex           name=Codex           role=审查  conn=online  work=空闲  load=执行中 0 · 排队 0 · 重试 0  today=今日完成 5 项  cost=累计成本 $0 · 32.9 万 Token
claude-readonly name=Claude Code 只读 role=日报  conn=online  work=空闲  load=执行中 0 · 排队 0 · 重试 0  today=今日完成 4 项  cost=累计成本 $2.07 · 26.4 万 Token
image-gen       name=Codex 生图      role=生图  conn=online  work=空闲  load=执行中 0 · 排队 0 · 重试 0  today=今日完成 2 项  cost=累计成本 $0 · 0 Token
```

/api/state 同刻 agents（关键字段）：

```
[{id:"claude",doneToday:3,cost:2.27…,online:true},{id:"codex",doneToday:5,cost:0,…},
 {id:"claude-readonly",doneToday:4,cost:2.0734,…},{id:"image-gen",doneToday:2,cost:0,…}]
```

脚本逐项核对 name/doneToday/cost/running/queued/retrying：

```
对比结果 issues = [] → 一致 ✅
```

无数据字段显示「—」（`fmtCost` 对 null 返回 `—`；本轮四席成本均有值，image-gen 为 $0 是真实值非编造）。整轮验证页面 JS 异常 / console.error：**（无）**。

### 4. 连接状态与工作状态计算代码（贴源码，index.html:482-501 / 470-479）✅

```js
// 心跳判宽：比 Autoloop 的心跳间隔宽裕一倍（约 1 分钟一跳，2 分钟没动静才算超时），避免误报
const HEARTBEAT_TTL = 120000;

// 连接状态：只回答「这台机器连着吗」，和干不干活无关。
// online=true 不等于在干活——它只说明 worker 报过到；超过 TTL 没心跳算 stale（黄）。
function connectionOf(agent, now) {
  if (!agent.online) return 'offline';
  const seen = Date.parse(agent.seenAt);
  if (!Number.isFinite(seen) || (now - seen) > HEARTBEAT_TTL) return 'stale';
  return 'online';
}

// 工作状态：和连接状态独立，只看这个 Agent 名下的任务。
// retrying 优先级最高（需要人留意），琥珀色不是红色——自动重试还在进行就不算失败。
function workOf(totals) {
  const t = totals || {};
  if ((t.retrying || 0) > 0) return 'retrying';
  if ((t.running || 0) > 0) return 'running';
  if ((t.queued || 0) > 0) return 'queued';
  return 'idle';
}
```

岗位映射（`ROLE` + 兜底链）：

```js
const ROLE = {
  'claude': '开发',
  'codex': '审查',
  'claude-readonly': '日报',
  'image-gen': '生图',
};
const USE_FALLBACK = { claude: 'Claude', codex: 'Codex', command: '命令行' };
function roleOf(agent) {
  return ROLE[agent.id] || USE_FALLBACK[agent.use] || '成员';
}
```

两维度在卡面上物理分离：`.ws-conn`（连接点+文字：在线/stale 黄/离线灰）与 `.ws-work`（工作大字：执行中/排队中/重试中/空闲）。`HEARTBEAT_TTL === 120000` 精确；来源注释在代码里。

### 5. 点击工位卡 → 详情模态框 ✅

verify-5.1.mjs 验收5 全输出（第三次插桩运行，分步日志）：

```
{
  "agent": "claude",
  "visible": true,
  "name": "Claude Code",
  "runRows": 3,
  "agentRunsInState": 3,
  "linkCount": 3,
  "secs": ["当前任务", "今日与历史记录", "统计"],
  "closedByEsc": true,
  "closedByMask": true,
  "steps": ["click前 hidden=true", "click后立即 hidden=false", "250ms后 hidden=false modalAgentId=claude"]
}
```

- 无新路由（单页，hash/URL 不变）；三区块齐全：当前任务（最醒目）、今日与历史记录（该 Agent 全部 runs，3 行 === state 里该 agent 的 3 条）、统计（token/成本/完成数）。
- `link` 字段渲染成可点链接（`#m-body a[href*="://"]` 3 个，如 `claude://resume?…`）。
- ESC 关闭 ✅、点遮罩关闭 ✅。模态框打开时每 3 秒轮询会刷新其内容（renderModal 随 render 每帧重画）。
- 视觉证据：`verify-assets/shot-5.1-modal.png`（277415 B）。

### 6. 停中台 → 「中台离线」横幅 → 自动恢复 ✅

前置安全检查（只在空闲窗口动手）：

```
/api/state → running: 0, queued: 0, retrying: 0, cards: 0   （idle 窗口确认）
中台进程 pid 41812（守护链：计划任务 agent-autoloop-56d82ec9 → wscript → background.js）

$ powershell -NoProfile -Command "Stop-Process -Id 41812 -Force"
（页面侧 verify-5.1.mjs offline 模式同时监听）

[offline 模式] 页面就绪，等待 body.offline ...
[offline 模式] ✅ body.offline 出现，hub-text="中台离线"，
  横幅="⚠ 中台离线，连不上中台服务。页面保持自动重询，恢复后自动刷新。"，display=block
[截图] …shot-5.1-offline.png (185035 B)

$ curl -s -w "\nHTTP %{http_code}\n" http://127.0.0.1:8090/api/state
{"error":"中台不可达（http://127.0.0.1:3350）：ECONNREFUSED","code":"HUB_UNREACHABLE"}
HTTP 502

（守护进程 ~10 秒内拉起新中台 pid 20952）

[recover 模式] ✅ 已恢复，hub-text="中台在线"
[截图] …shot-5.1-recovered.png (171196 B)

$ curl -s http://127.0.0.1:8090/api/health
{"ok":true,"autoloop":true}
```

离线期间页面不白屏：工位区半透明置灰但保留最后一次数据，横幅常驻直到恢复。

### 7. 「累计成本」标签 ✅

```
4 张卡有 .ws-cost，其中含「累计成本」的：4；正文其他出现：4 处
```

`totals.usage.cost` 全部标注「累计成本」（累计值），未标「今日花费」。顶栏另有「今日 $4.34」字样，那是 /api/state 的 `spending.today`（真实的今日口径），与累计成本是两个数据源，不冲突。

### 8. Hero 高度 112–150px ✅

```
Runtime.evaluate → document.querySelector('.office-hero').getBoundingClientRect()
{ "height": 132, "top": 0, "width": 1440 }
→ 在 112–150 区间 ✅
```

CSS 源：`.office-hero { min-height: 132px; … }`（星月夜背景保留，Task 4.1 素材复用）。

---

## 二、布局与附加检查（实测）

```
grid: gridTemplateColumns = "464px 464px"，gap = "20px"     → 2 列 ✅（.workstations）
卡片: 4 张全部 h=264 w=464（含 padding/border，min-height:264px 生效）→ 250–280 区间 ✅
需要你关注区: attentionOpen=null（自动模式）, cards=0, retrying=0
  → 折叠态文案「暂无需要你处理的事项」；有卡片或 retrying>0 时自动展开并高亮（本轮无此态，逻辑见 index.html）
最近任务: h2="最近任务", 筛选=["全部 21","进行中 0","排队 0","重试 0","完成 21","失败 0"], 21 行
卡片排序: 首帧按 retrying>running>queued>idle>offline 排定后冻结座次（seatOrder），状态变化只变色不换位 ✅
状态点: 静态（旧呼吸动画已删）✅   进度条: 无 ✅   装饰动画: 无 ✅
```

截图目检（多模态读图，非美化描述）：4 卡 2×2 齐整、五区信息完整、无重叠/破版；离线截图红幅文字与 DOM 实读一致。

## 三、截图清单（web/verify-assets/）

| 图 | 内容 | 字节 |
|---|---|---|
| `shot-5.1-main.png` | 全页（hero+关注区+工位+最近任务） | 397,931 |
| `shot-5.1-workstations.png` | 工位区 2×2 特写 | 205,722 |
| `shot-5.1-modal.png` | Claude Code 详情模态框打开态 | 277,415 |
| `shot-5.1-offline.png` | 中台停止：离线横幅 | 185,035 |
| `shot-5.1-recovered.png` | 守护拉起后自动恢复 | 171,196 |

## 四、坑（如实记录）

1. **验收5 模态框前两次 `visible:false`**：与 `m-name` 已填充的读数矛盾。单独诊断脚本（click→hidden=false, display=flex, modalAgentId='claude'）证明模态框本身正常；第三次给脚本加分步日志后 `visible:true` 且三步日志齐全。判定为「点击与 3 秒轮询 render() 重画」之间的读数竞态，非页面缺陷；插桩输出已作为正式证据。
2. **系统 Node 20.19.2 无原生 WebSocket**：CDP 客户端连不上 → 全部验证改用 `C:/Tools/node24/node.exe`（v24.22.3）。
3. **截图路径 %20 编码**：`new URL('.', import.meta.url).pathname` 把「Soda Intelligence」变 `Soda%20Intelligence` 导致 ENOENT → 改 `fileURLToPath()`。
4. **window.__errs 不存在**：早版脚本引用了页面根本没有的全局错误收集器 → 改为 CDP `Runtime.exceptionThrown` + `console.error` 事件订阅（`Runtime.enable`）。
5. **git-bash `taskkill //F` 无效参数**（TASK-4.1 同坑）：杀中台改 PowerShell `Stop-Process -Force`。

## 五、遗留与建议

- **未实测态**：本窗口恰逢全空闲（running/queued/retrying 均 0、无待答卡片），「执行中/重试中」卡面、关注区展开高亮、`link` 实际可点跳转只在代码层验证过，未在真实运行态截到图。建议下次有任务跑动时顺手补一张执行中截图（无需改代码）。
- **排序冻结的边界**：Agent 增删时新卡追加到尾部、消失的卡移除——rules.json 热载已覆盖，但建议成员超过 8 个前落实 TODO 里的紧凑模式（注释已留）。
- **顶栏「在线 N」口径**：按 connectionOf（含 stale 判定）统计，与工位卡一致；离线瞬间显示「成员 4 · 在线 4」是因为沿用最后一帧数据（by design，不闪零）。
- web/server.js、Autoloop、assets 均零改动，TASK-4.1 的验收结论（对比度/字体/路由安全）继续有效。
