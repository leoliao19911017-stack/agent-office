# Soda Agent 流水线 —— 完整方案

> 2026-11-13 · Hermes 起草
> Leo 的需求原文：「从你这 Hermes 发需求，然后你通过和 GPT 讨论之后，确认拆解成一个开发任务，给到 Claude Code 去开发。然后返回结果再给到你。Claude Code 需要生图的时候，由你去调度生图……你再用 Codex 去生图，给到他。然后前面说的 dsh 也可以接入，有 CLI」

---

## 一、先认错

**你说得对，我跑偏了。**

我花了一整晚调通的是「Autoloop 能跑任务」——但那只是**一个 Agent 自己干活**。你要的是**一条流水线，我当总调度，把几个 Agent 串起来**。

这两件事不是一回事。下面按你说的重做。

---

## 二、你要的流水线（我理解的）

```
你 ──需求──► Hermes（我，总调度）
                 │
                 ├─1─► GPT（网页版）讨论、质疑、拆解
                 │        ↳ 产出：任务书 + 验收标准
                 │
                 ├─2─► 写 TASK-X.md，派给 Claude Code
                 │        ↳ Claude Code 开发中
                 │            │
                 │            ├─ 需要图片？──► 通知我 ──► 我调 Codex 生图
                 │            │                                ↳ 图回送 ──┘
                 │            │
                 │            └─ 做完 ──► 结果回到我
                 │
                 ├─3─► 我验收（真跑、真看，不采信自述）
                 │
                 └─4─► 汇总给你
```

**关键角色分工：**

| 角色 | 干什么 | 身份 |
|---|---|---|
| **你** | 提需求、拍板 | 老板 |
| **我（Hermes）** | 讨论、拆解、派活、生图调度、验收、汇总 | **总调度，不写业务代码** |
| **GPT（网页版）** | 被质疑、补盲区、给架构意见 | 外部参谋 |
| **Claude Code** | 写代码 | 开发 |
| **Codex** | 生图 | 美术 |
| **DSH** | 备用执行 Agent（有 headless CLI） | 打杂/并行 |

---

## 三、四项能力核实结果（都实测过）

### 3.1 GPT 讨论通道 —— ✅ 可用

- 工具：`chatgpt-drive` skill + 本机 browse daemon
- 浏览器：headed Chromium，已登录 ChatGPT
- **坑（skill 里已记录）**：
  - 输入框是 `div[contenteditable="true"]`，`#prompt-textarea` 已失效
  - 单条消息 <3000 字，超了会静默丢弃
  - 用「独特子串」验落地，不能信「已发送」
  - 讨论原文必须落盘存档

### 3.2 Claude Code 开发 + 中途提问 —— ✅ 可用

- 调用：`claude -p --permission-mode <read|acceptEdits|bypassPermissions>`
- **中途提问机制已经跑通了**（今晚实测）：
  - Agent 发现需要授权/决策 → 写进回执 → **本轮结束，进程退出**
  - 卡片推到你飞书 → 你点击 → **接着同一个 session 继续**
  - 证据：`card 4: answered by ou_a67039..., counted` + 后续轮次 `claude://resume?session=...`

**这意味着「Claude Code 要图 → 我生图 → 图给它」这条路是通的**，只不过要走「提问-回答」这个通道。

### 3.3 Codex 生图 —— ⚠️ 需要验证

- Codex CLI：`codex-cli 0.153.4` ✅
- 但**生图能力**要先验证：`codex exec` 能不能调 image_gen 工具、图存哪、怎么取回
- **备选方案**：GPT 网页版生图（skill §5 有完整配方，实测跑通过）

**这个要实测，不能假设。**

### 3.4 DSH CLI —— ✅ 找到了

**之前我说「DSH 无 CLI」是错的。** 它在 Electron 目录里：

```
C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd
```

实测版本：`0.2.2-rc.1`

**关键能力**：
```bash
dsh headless "run the tests"    # 跑一个任务，打印结果，退出
dsh --profile <name>            # 启动某个 profile
dsh tui --resume <session>      # 续接会话
```

`headless` 正是 Autoloop 要的接口形态——一次任务、一次退出、给结果。

---

## 四、接入方式：用 Autoloop 当骨架

Autoloop 已经解决了调度问题（领取、租约、挂起、卡片、事件溯源）。**我们不需要重造，只需要把 Agent 接进去。**

### 4.1 已接好的

| Agent | 状态 | 配置 |
|---|---|---|
| Claude Code | ✅ | `agents.claude`（edit） |
| Claude Code 只读 | ✅ | `agents.claude-readonly`（read） |
| Codex | ✅ | `agents.codex`（edit） |

### 4.2 要新接的

**Codex 生图 Agent** —— 用 `use: "command"` 自定义命令：

```json
"agents": {
  "codex-image": {
    "name": "Codex 生图",
    "worker": "sky-20231019ynz",
    "use": "command",
    "command": ["node", "C:/Tools/agent-autoloop/image-gen.mjs"],
    "access": "edit",
    "timeout": 10
  }
}
```

`image-gen.mjs` 是我写的桥：收 prompt → 调 Codex 生图 → 图落到指定目录 → 返回路径。

**DSH Agent**：

```json
"dsh": {
  "name": "DSH",
  "worker": "sky-20231019ynz",
  "use": "command",
  "command": [
    "C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd",
    "headless"
  ]
}
```

### 4.3 三条规则的骨架

| 规则 | 触发 | 谁干 | 产出 |
|---|---|---|---|
| `开发任务` | 我 emit `dev.task` | claude | 代码 + 自测报告 |
| `生图请求` | Claude 提问生成 | codex-image | 图片文件 |
| `设计评审` | 我 emit `dev.review` | codex | 评审意见 |

---

## 五、完整流程（具体到每一步）

### 第 1 步：你提需求

你说一句话，比如「工作台加一个任务详情页」。

### 第 2 步：我跟 GPT 讨论

1. 我先把需求整理成结构化问题（现状、目标、约束、我自己的疑虑）
2. browse → ChatGPT → 发过去
3. 落盘 GPT 回复
4. **我读一遍，采纳对的，否决不同意的，写清理由**
5. 再发一轮，把分歧点摆出来问 GPT
6. 收敛后产出任务书

**产出**：`TASK-X.Y.md`（含背景、目标、约束、验收标准、边界）

### 第 3 步：派给 Claude Code

```bash
agent-autoloop emit dev.task --summary "任务简述" --detail "$(cat TASK-X.Y.md)"
```

Autoloop 派给 Claude Code，Claude Code 开始写代码。

### 第 4 步：Claude Code 要图怎么办

**这是我今晚还没验证的关键环节。** 有两种可能：

**方案 A（理想）**：Claude Code 主动提问「需要一张 XX 图」，Autoloop 把它变成飞书卡片给我 → 我调 Codex 生成 → 我回答卡片时附图片路径 → Claude Code 续接会话拿到路径。

**方案 B（现实）**：Claude Code 直接在任务里说「需要图片」，我在**下一轮派活时**把图片路径塞进去。

**方案 A 更自动，但要验证 Autoloop 的 answer 能不能带文件路径。方案 B 更土但一定行。**

### 第 5 步：结果回到我

Claude Code 完成后，Autoloop 记录结果，我从 `status` / API 读取。

### 第 6 步：我验收

- 不信自述，**自己跑一遍**
- 检查真实产出（文件、服务、截图）
- 不通过的打回重做

### 第 7 步：汇总给你

超过 200 字写 MD，聊天发摘要 + 附件。

---

## 六、现在缺什么

| # | 缺口 | 严重度 | 谁能补 |
|---|---|---|---|
| 1 | **Codex 生图能力未验证** | 🔴 高 | 我先实测 |
| 2 | **Claude Code 要图的回传通道未验证** | 🔴 高 | 我先实测 |
| 3 | `command` 型 Agent 的写法未验证 | 🟡 中 | 我先实测 |
| 4 | DSH 接入未验证（headless 能不能真正干活） | 🟡 中 | 我先实测 |
| 5 | GPT 讨论的自动化（现在要手动操作浏览器） | 🟡 中 | 可做脚本 |
| 6 | 生图任务排队 / 并发控制 | 🟢 低 | 后续 |

---

## 七、我建议的推进顺序

**第 1 步：把「生图」这条支线打通**（缺口 1+2+3）

这是整条流水线里最不确定、也最容易卡住的一环。先在 Autoloop 里做一个最小闭环：

```
我手动 emit「生成一张测试图」→ Codex 生图 → 图落到 Soda Office/assets/
```

跑通了，再验证「Claude Code 提问要图 → 我回答附路径 → 它拿到」。

**第 2 步：DSH 接入**（缺口 4）

`dsh headless "写个 hello world 到 /tmp/x.txt"` 跑通，确认能当 Agent 用。

**第 3 步：跑一个真实开发任务**（整个流程串起来）

拿一个小需求（比如工作台加个筛选功能），完整走一遍：讨论 → 拆解 → 派活 → 生图 → 验收。

**第 4 步：把 GPT 讨论也自动化**

前 3 步跑顺了，再把 GPT 那一环写成脚本，减少手动操作。

---

## 八、需要你确认

1. **这个理解和你的想法一致吗？** 如果有偏差，指出哪一条不对。
2. **推进顺序同意吗？** 我建议先打通生图，因为它最容易卡。
3. **Codex 生图 vs GPT 网页生图**，你有偏好吗？
   - Codex：走 CLI，无浏览器，但如果没 API key 可能不行
   - GPT 网页：已验证可用，但要占浏览器窗口

---

## 九、我要纠正自己的两处错误

**错误 1：我说「DSH 无 CLI 入口」。**
实际有，在 `DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd`，版本 0.2.2-rc.1，支持 `headless`。

**错误 2：我把「Autoloop 跑通」当成了目标达成。**
它只是基础设施。真正的目标是你说的这条流水线，我今晚没做。

---

## 十、本次会话已完成的（作为基础）

- ✅ Agent Autoloop v1.8.2 装好、跑通
- ✅ 独立飞书应用 Ann（`cli_aa7f5ab825b81cb7`），不抢 Hermes 的长连接
- ✅ 卡片能发到飞书、能点击回答、能续接会话
- ✅ Web 工作台（`http://127.0.0.1:8090`）
- ✅ Claude Code / Codex / 只读 Agent 三个都已接入
- ✅ 日报任务跑出真实数据

**这些是地基，不是房子。** 房子是你说的那条流水线。
