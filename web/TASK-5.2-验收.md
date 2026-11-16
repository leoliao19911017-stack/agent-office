# TASK-5.2 验收报告 — 修正数据标注 + 接入 Agent 头像

> 执行：Claude Code · 2026-11-13 · 工作台 http://127.0.0.1:8090
> 改动文件：`web/index.html`、`web/server.js`（仅静态资源路由，`/api/*` 零改动）

---

## 一、改了什么

### web/index.html

| # | 改动 | 说明 |
|---|---|---|
| 1 | 新增 `AVATAR` 映射表 | 按 `agent.id` 写死 4 张头像路径；未知 id 走兜底，不报错 |
| 2 | 新增 `avatarFallback()` + `avatarHtml()` | 兜底 = 纯色圆 + 名字首字的内联 SVG data URI，不依赖文件；`onerror` 时无缝切换，绝不出现裂图 |
| 3 | 工位卡身份区左侧插 `<img class="agent-avatar">` | 72×72px、`border-radius:50%`、`object-fit:cover`；默认 2px `var(--border)` 描边，在线时描边换 `var(--success)`（选绿不选金：配色纪律里金色只留给品牌强调与待决策，连接是语义状态，与 conn-dot 同源） |
| 4 | §1.1 数据诚实性 | `noUsage = a.use==='command' && u.cost===0 && t.done>0` 时：成本显示「成本未统计」（不显示 `$0`）、Token 显示 `—`（不显示 `0`）。判断依据已写进代码注释 |
| 5 | §1.2 口径标清 | 卡片标签「累计成本」→「累计」，与顶部「今日」（`spending.today`）口径分开 |
| 6 | §1.3 缺成本轮数 | 顶部从「（部分轮次缺成本数据）」改为 `· N 轮缺成本数据`，N 取 `spending.today.missingCost` 真实值 |
| 7 | 模态框统计区同源 | 同一 `noUsage` 规则，详情页不再说回 `$0` |

### web/server.js（只动静态资源路由）

- `/assets/` 白名单放行**一层子目录** `assets/agents/`（原正则不含 `/`，头像会 404）
- 每段文件名仍限字母数字开头 + `._-`，`..`/多层级/非图片扩展名一律 404
- `assets/agents/` 给 `cache-control: public, max-age=86400`：工位卡每 3 秒重渲染会重建 `<img>`，`no-cache` 会导致每轮全量重拉 3.7MB×4；其余资源维持 `no-cache` 不变

### 服务重启

`server.js` 改动需重启生效：已重启 8090 工作台（旧 pid 46428 → 新后台进程），`/api/*` 与 3350 中台零改动。

---

## 二、验证了什么（headless Edge + CDP 真实输出）

脚本：`web/verify-assets/verify-5.2.mjs`（零依赖，Node22+ 原生 WebSocket）

### 验收 1 — `.agent-avatar` 数量 ✅

```
document.querySelectorAll('.agent-avatar').length = 4
```

### 验收 2 — 4 张头像真实加载（非裂图）✅

```
[claude]         src=assets/agents/claude-code.png     naturalWidth=1254×1254 complete=true 渲染=72×72px radius=50% object-fit=cover
[codex]          src=assets/agents/codex.png           naturalWidth=1254×1254 complete=true 渲染=72×72px radius=50% object-fit=cover
[claude-readonly] src=assets/agents/claude-readonly.png naturalWidth=1254×1254 complete=true 渲染=72×72px radius=50% object-fit=cover
[image-gen]      src=assets/agents/image-gen.png       naturalWidth=1254×1254 complete=true 渲染=72×72px radius=50% object-fit=cover
→ 4/4 naturalWidth>0 PASS
```

（4 张均为在线态，成功绿描边已生效。）

### 验收 3 — image-gen 显示「成本未统计」✅

```
[claude]          累计 $2.27 · 15.6 万 Token
[codex]           累计 $0 · 32.9 万 Token
[claude-readonly] 累计 $2.07 · 26.4 万 Token
[image-gen]       成本未统计 · — Token   ← 不再是「$0 · 0 Token」
```

### 验收 4 — 顶部真实轮数 ✅

```
#topstats = "排队 0 · 今天 14 轮 · 51.5 万 Token · 今日 $4.34 · 7 轮缺成本数据"
/api/state → spending.today.missingCost = 7, cost = 4.34314
→ 页面显示与 API 真实值一致（7 轮，非写死）
```

### 验收 5 — 截图 ✅

- `web/verify-assets/shot-5.2-workstations.png`（工位区特写，含 4 头像）
- `web/verify-assets/shot-5.2-full.png`（全页）

### 附加自查（全过）

- **模态框同源**：点开 image-gen 详情 → `累计 Token：— 累计成本：成本未统计 累计完成：2 项 今日完成：2 项` ✅
- **onerror 兜底真实触发**：人为把 src 改成 404 路径 → 自动换成 `data:image/svg+xml` 兜底圆字，`naturalWidth=72`，无裂图 ✅
- **页面 JS 异常 / console.error**：（无）✅
- **server.js 路由安全**：`assets/..%2F..%2Fconfig.json`、`assets/..\..\config.json`、三层子目录、非图片扩展名全部 404；HTTP 下载与磁盘原件 sha1 一致 ✅

---

## 三、两点如实说明（非问题，需知悉）

1. **codex 卡片仍显示「累计 $0」**：经查 codex 的 12 轮里 7 轮带 usage 上报（token 有值 32.9 万），`cost` 字段上报值就是 0——这是「上报为 0」，不是 image-gen 那种「全程缺报」。任务书 §1.1 的修正条件明确限定 `agent.use === 'command'`，故 codex 不在本次修正范围。若后续确认 codex 的 0 也是缺统计，需另开任务。
2. **image-gen.png 实际字节数 3,847,958**，与任务书标注的 3,797,574 不符：文件在任务书撰写后被重新生成过（磁盘原件、HTTP 下载、sha1 三方一致，图可正常加载解码）。不影响验收。

## 四、还差什么

无。五条验收全过，证据齐备。待 Leo 拍板验收。
