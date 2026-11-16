# TASK-3.1 — Soda Agent 工作台（Web 看板）

> 派单方：Hermes（coordinator）
> 执行方：Claude Code
> 日期：2026-11-12
> 前置：Agent Autoloop v1.8.2 已装好并验证通过（见 `docs/AUTOLOOP-安装验证报告.md`）

---

## 一、背景（你必须先理解这件事）

我们已经**放弃自研调度内核**，改用开源的 **Agent Autoloop** 作为底层。它负责：

- 任务调度、原子领取、租约
- Agent 调用（Claude Code / Codex）
- 挂起零消耗（Agent 问完问题就退出进程）
- 人拍板卡片
- 事件溯源

**我们不重写这些。我们只做它没有的那一层：Web 工作台。**

Autoloop 目前只有命令行 `status`，没有图形界面。**你的任务就是补上这个界面。**

---

## 二、目标

做一个**单页 Web 工作台**，让 Leo 打开浏览器就能看到：

1. **现在有几个 Agent 在线**，分别是谁
2. **有哪些任务在跑、在排队、在等你拍板**
3. **每个任务卡在哪一步**
4. **今天用了多少 Token、花了多少钱**
5. **能直接在网页上回答问题卡片**（不用去命令行敲）

---

## 三、技术约束（硬性，不许改）

| 约束 | 说明 |
|---|---|
| **零依赖** | 不许 `npm install` 任何包。只能用 Node 标准库 + 原生 HTML/CSS/JS |
| **单 HTML 文件** | 前端只有 `public/index.html` 一个文件，内联 CSS 和 JS |
| **服务端用 node:http** | 不许用 Express。参考项目里 `Soda Office/src/server.js` 的写法 |
| **不能把 owner key 打到前端** | 这是安全红线，见第五节 |
| **必须用 Node 24** | `export PATH="/c/Tools/node24:$PATH"` |

---

## 四、数据来源（已实测可用）

Autoloop 的中台在 `http://127.0.0.1:3350`。

### 4.1 读状态

```
GET /v1/state
Authorization: Bearer <owner key>
```

**owner key 在 `C:/Tools/agent-autoloop/config.json` 的 `owner` 字段。**
**绝对不许写进前端代码。**

实测返回结构（真实数据）：

```json
{
  "seq": 40,
  "now": "...",
  "timezone": "...",
  "spending": {...},
  "totals": {
    "running": 0, "queued": 0, "retrying": 0, "unknown": 0,
    "done": 2, "doneToday": 2, "nothing": 0,
    "usage": { "input": 46943, "output": 140, "cost": 0 },
    "attention": 0
  },
  "cards": [...],        // 等你拍板的
  "recentCards": [...],  // 最近的卡片
  "timers": [...],
  "sources": [...],
  "lines": [...],
  "pauses": [...],
  "skipped": [...],
  "elsewhere": [...],
  "agents": [
    { "id": "claude", "name": "Claude Code", "online": true },
    { "id": "codex",  "name": "Codex",       "online": true }
  ],
  "channels": [{ "id": "desktop", "name": "桌面通知" }],
  "runs": [
    {
      "id": 2, "rule": "试一下", "agent": "codex", "state": "done",
      "attempts": 0,
      "createdAt": "2026-11-12T12:02:05.408Z",
      "claimedAt": "2026-11-12T12:02:05.410Z",
      "finishedAt": "2026-11-12T12:02:19.520Z",
      "notBefore": "2026-11-12T12:02:05.408Z",
      "summary": "你选了绿色，试跑通过",
      "error": "",
      "link": "codex://threads/01a1cfa2-...",
      "session": "01a1cfa2-...",
      "usage": {...}
    }
  ],
  "hasMore": false,
  "nextBefore": null,
  "unrouted": []
}
```

### 4.2 回答问题

```
POST /v1/cards/<id>/answer
Authorization: Bearer <owner key>
Content-Type: application/json

{ "choice": 1 }          // 选项下标，从 0 开始
或
{ "text": "别的想法" }    // 自由文字
```

### 4.3 结案（不用决定了）

```
POST /v1/cards/<id>/resolve
{ "reason": "不用决定了，因为……" }
```

### 4.4 停掉一轮

```
POST /v1/runs/<id>/cancel
{}
```

### 4.5 健康检查（免鉴权）

```
GET /healthz
→ { "ok": true, "commit": "..." }
```

---

## 五、架构（两层，防止 key 泄漏）

```
浏览器 ──► 你的 Web 服务 (127.0.0.1:8080) ──► Autoloop 中台 (127.0.0.1:3350)
              ↑ 持有 owner key，代理转发
```

**你的服务是代理，不是直连转发。** 必须做到：

1. owner key **只存在于服务端进程内存**，从 `config.json` 读取，不写日志、不返给前端
2. 前端只能访问你定义的接口，不能任意代理到 Autoloop
3. 只开放 4 个动作：读状态、回答问题、结案、停任务

### 你的 API

```
GET  /api/state              → 透传 /v1/state 的结果（已脱敏）
POST /api/cards/:id/answer   → body { choice } 或 { text }
POST /api/cards/:id/resolve  → body { reason }
POST /api/runs/:id/cancel    → body {}
GET  /api/health             → { ok, autoloop: bool }
```

**脱敏要求**：`/api/state` 返回前，把任何含 key/token 的字段删掉。**先自己看一眼真实返回里有没有敏感字段**，有就剔除。

---

## 六、界面要求

单页，深色，看清就行，不要花哨。

### 6.1 顶部状态条

```
● 中台在线    Agent: Claude Code ●  Codex ●    今天 2 轮 · 4.7万 Token
```

- 中台在线状态用 `GET /healthz` 判断，每 3 秒刷
- Agent 在线状态来自 `state.agents[].online`
- 数字来自 `state.totals`

### 6.2 中间：等你的卡片（最重要）

如果 `state.cards` 非空，**放在最显眼位置**，因为这是需要人做决定的。

每张卡片显示：
- 标题（`card.title`）
- 说明（`card.text`）
- 选项按钮（`card.options`，点哪个就 `POST /api/cards/:id/answer { choice: 下标 }`）
- 一个「不用决定了」输入框 + 按钮（调 resolve）

**如果 cards 为空，显示「没有需要你决定的」。**

### 6.3 任务列表

`state.runs` 每一条一行：

```
#2  完成   codex   试一下   你选了绿色，试跑通过          14秒前
```

- 状态用颜色区分：`done` 绿、`running` 蓝（带呼吸动画）、`queued` 灰、`failed` 红
- 时间显示成「x 分钟前」这种相对时间
- `state === "running"` 的右边给个「停」按钮

### 6.4 底部：Agent 和通道

列出 `state.agents` 和 `state.channels`，在线/离线用圆点颜色区分。

### 6.5 刷新策略

- **每 3 秒轮询 `GET /api/state`**
- 不要用 WebSocket（Autoloop 的设计者明确建议轮询）
- 页面切到后台时暂停轮询，切回来立刻刷一次

---

## 七、文件结构

在 `Soda Office/` 下新建 `web/` 目录：

```
web/
├── server.js          # Node 服务，node:http，零依赖
├── index.html         # 单文件前端，内联 CSS/JS
└── README.md          # 怎么启动
```

**不要改 `Soda Office/src/` 下的任何文件。** 那是旧的 Soda Office，保留作参考。

---

## 八、验收标准

### 8.1 必须通过（逐条验证）

1. **启动**：`node web/server.js` 能起来，监听 `127.0.0.1:8080`
2. **首页**：浏览器打开 `http://127.0.0.1:8080` 能看到界面
3. **真实数据**：页面显示的数字和 `agent-autoloop status` 一致
4. **Agent 状态**：能看到 Claude Code 和 Codex 两个都是在线（绿点）
5. **任务列表**：能看到 #1「问了一个问题」和 #2「你选了绿色，试跑通过」
6. **key 不泄漏**：`curl http://127.0.0.1:8080/api/state` 的返回里**搜不到 config.json 里的 owner key**
7. **零依赖**：`package.json` 里没有 dependencies（或 `web/` 目录下没有 node_modules）
8. **断线处理**：把 Autoloop 停掉，页面显示「中台离线」，不是白屏或报错堆栈

### 8.2 加分项（有余力再做）

- 回答卡片后，卡片立刻从列表消失（乐观更新）
- 任务列表能按状态筛选
- Token 消耗显示成本估算

---

## 九、交付物

1. `web/server.js`（含注释说明代理架构）
2. `web/index.html`
3. `web/README.md`（启动命令、端口、注意事项）
4. **一份 `web/VERIFY.md`**：把你实际跑的命令和输出贴进去，证明第 8.1 的每一条都过了

**注意：`VERIFY.md` 必须是真实输出，不许写「应该可以」。** 跑不通就写跑不通。

---

## 十、环境

```bash
export PATH="/c/Tools/node24:$PATH"   # 必须，Autoloop 要 Node 24
export AGENT_AUTOLOOP_HOME="C:/Tools/agent-autoloop"

cd "$HOME/Desktop/Soda Intelligence - AI Native Thinking/Soda Office"
```

Autoloop CLI：`C:/Tools/agent-autoloop/app/bin/agent-autoloop.ts`
用 `node --disable-warning=ExperimentalWarning <CLI> status` 调用。

---

## 十一、边界（不许做）

- ❌ 不许改 Autoloop 的代码（那是第三方，升级会被覆盖）
- ❌ 不许改 `Soda Office/src/`
- ❌ 不许 `npm install`
- ❌ 不许把 owner key 写进任何前端文件
- ❌ 不许自己编造 Autoloop 的接口（只用本文档列出的）
- ❌ 不许把假数据当成真实数据填进度

---

## 十二、做完怎么回复

回复时给：

1. **实际跑了什么命令**（贴真实输出）
2. **页面截图或 `/api/state` 的真实返回**
3. **哪几条验收通过、哪几条没过**
4. **遇到什么坑**

不要写「已完成」，要写**证据**。
