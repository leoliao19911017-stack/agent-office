# Agent Autoloop 安装与验证报告

> 2026-11-12 19:45–20:05 · Hermes 执行
> 目的：验证能否复用其调度内核，作为 Soda 工作台的底层

---

## 一、结论先说

**装成功了，完整流程真实跑通。它确实比我们自研的 Soda Office 强，建议底层换掉。**

但有个前提必须写清楚：**它的强不在于"多"，而在于"它已经把坑踩完了"** —— 我们这两天遇到的问题（Windows 兼容、Codex 参数、Agent 失败重试、跨进程会话续接），它都有现成实现。

---

## 二、核实到的项目事实

原始转述「支持 macOS 和 Linux」**已过时**。

| 项 | 实测/查证结果 |
|---|---|
| Stars | 4,600+ |
| Forks / Contributors | 836 / 47 |
| Commits / Releases | 203 / 19 |
| 最新版本 | v1.8.2（2026-11-12 当天发布） |
| 语言 / 协议 | TypeScript 98.9% / MIT |
| **Windows 支持** | **原生支持已合并**（PR #156，Windows 11 上 455 个测试通过） |
| Node 要求 | **≥ 24**（我们原有 Node 20/22 都不够） |

---

## 三、安装过程（做了什么）

### 1. 装 Node 24 到独立目录

```
下载 node-v24.22.3-win-x64.zip (37MB)
解压到 C:/Tools/node24/
验证：node.exe --version → v24.22.3
     npm.cmd --version  → 11.19.1
```

**没有动系统 Node 20，也没动之前装的 Node 22。**

### 2. 审查安装脚本后再执行

先下载 `install.ps1`（56 行）读完全文，确认没有：
- 远程代码执行（`Invoke-Expression`、`iex`）
- 注册表写入
- 递归删除
- 关杀毒 / 改执行策略

实际行为只有三件：查 Node 版本 → `git clone` 到 `~/.agent-autoloop/app` → 把 `bin` 加进用户级 PATH。

**唯一改系统的地方是第 3 步的 PATH**，可逆。

### 3. 装到隔离目录

```bash
export AGENT_AUTOLOOP_HOME="C:/Tools/agent-autoloop"
```

安装输出：
```
装好了。
  Agent：Claude Code、Codex     ← 自动识别到本机两个 CLI
  通道：桌面通知
  规则：C:\Tools\agent-autoloop\rules.json
```

---

## 四、真实验证（关键证据）

### 4.1 服务状态

```
等你 0 · 在跑 0 · 排队 0 · 今天做完 0
在线
  ● Claude Code  sky-20231019ynz
  ● Codex        sky-20231019ynz
  ● 桌面通知     通道
```

### 4.2 第一次 try —— Claude Code 撞 429（诚实报错）

```
Agent 没跑成：API Error: Request rejected (429) · [1308]
[已达到 5 小时的使用上限。您的限额将在 2026-11-12 20:28:33 重置。]

运行 agent-autoloop doctor 看看。
```

**它没有假装成功。** 并且自动登记了重试时间 20:01:40。

### 4.3 第二次 try —— Codex 真实跑通全链路

Agent 干完这一段就**退出进程**，把问题挂起：

```
Agent 结束了这一轮，问了你一个问题。它现在不占进程、不花 Token。

【等你决定】#1 试跑：选一个颜色
  1. 蓝色
  2. 绿色
```

### 4.4 回答后自动续接

```
$ agent-autoloop answer 1 2
收到，Agent 接着干。
```

最终状态：

```
等你 0 · 在跑 0 · 排队 0 · 今天做完 2
今天 2 轮 · 4.7 万 Token

最近几轮
  20:02 #2 做完了   试一下
                    你选了绿色，试跑通过
  20:02 #1 做完了   试一下
                    问了一个问题
```

**#2 是接着 #1 的会话干的，不是重新开始。**

### 4.5 完整时间线（`why 1` 原始输出）

```
11-12 19:53:18  规则版本 #1
11-12 19:53:27  触发事件：来源 local · 类型 try.start
11-12 19:53:27  sky-20231019ynz 领取（Claude Code）
11-12 19:53:27  会话：claude://resume?session=baff9991-...
11-12 19:56:40  本次未完成：API Error 429 ...；重试时间 11-12 20:01:40
11-12 19:57:14  触发事件：来源 local · 类型 try.start
11-12 20:01:40  sky-20231019ynz 领取（Codex）        ← 自动换 Agent 重试
11-12 20:01:44  会话：codex://threads/01a1cfa2-...
11-12 20:02:01  结束：问了一个问题
11-12 20:02:01  提问：试跑：选一个颜色  选项：蓝色 / 绿色
11-12 20:02:05  本人回答「试跑：选一个颜色」：绿色
11-12 20:02:05  回答后继续：第 2 轮
```

**这段记录证明了三件事：**
1. Agent 失败后自动重试（不用人管）
2. 会自动换 Agent（Claude 挂了换 Codex）
3. 回答后的第 2 轮接着第 1 轮的会话，不是新开

---

## 五、Web 工作台怎么接（这是重点）

协议文档 `docs/protocol.md` 第 318 行，作者明确为「自己做看板」留了接口：

> 整份状态在同一个快照里读出，`seq` 是那时的日志序号：**自己做看板的，先取状态，再从 `GET /v1/stream?after=<seq>` 接着读，不漏也不重。**

### 可用接口（已实测）

```
GET /v1/state   Authorization: Bearer <owner key>
→ 200 { seq, totals, cards, recentCards, agents, channels,
        sources, lines, pauses, skipped, elsewhere, runs,
        nextBefore, hasMore, unrouted, spending, timers, now, timezone }

GET /v1/stream?after=<seq>     ← 增量订阅，做实时看板用
GET /healthz                   ← 免鉴权健康检查
```

### 实测返回（真实数据，非示例）

```json
{
  "seq": 40,
  "totals": {
    "running": 0, "queued": 0, "retrying": 0,
    "done": 2, "doneToday": 2,
    "usage": { "input": 46943, "output": 140, "cost": 0 },
    "attention": 0
  },
  "agents": [
    { "id": "claude", "name": "Claude Code", "online": true },
    { "id": "codex",  "name": "Codex",       "online": true }
  ],
  "channels": [{ "id": "desktop", "name": "桌面通知" }],
  "runs": [
    {
      "id": 2, "rule": "试一下", "agent": "codex", "state": "done",
      "createdAt": "2026-11-12T12:02:05Z",
      "finishedAt": "2026-11-12T12:02:19Z",
      "summary": "你选了绿色，试跑通过",
      "session": "01a1cfa2-9c45-7342-8f8d-d1e0455303eb",
      "link": "codex://threads/01a1cfa2-..."
    }
  ]
}
```

**Web 工作台需要的数据它全有**：多少在跑、多少排队、用了多少 Token、哪些 Agent 在线、每一轮干了什么、失败原因是什么。

---

## 六、和我们的 Soda Office 对比

| 能力 | Soda Office（自研 2 天，88 测试） | Agent Autoloop |
|---|---|---|
| 任务调度 + 原子领取 | ✅ 租约 + Claim Token | ✅ 同样有 |
| 跨进程并发 | ✅ 8 进程压测通过 | ✅ 20 万步模拟 + 强杀 1000 次 |
| **人拍板卡片** | ❌ 没有 | ✅ 飞书/钉钉/Slack/桌面 |
| **挂起零消耗** | ❌ 任务卡住占着进程 | ✅ 进程退出，回复后接着干 |
| **跨进程会话续接** | ❌ 没做 | ✅ `claude://resume` / `codex://threads` |
| **Agent 失败自动重试** | ❌ 没做 | ✅ 自动换 Agent 重试 |
| **事件溯源** | ⚠️ 简单事件表 | ✅ append-only，可重建 |
| **指令数据分离** | ❌ 有注入风险 | ✅ 外部文字只当资料 |
| **跳数熔断** | ❌ 没有 | ✅ 最多 8 层 |
| **Web 看板** | ❌ 没有 | ❌ **也没有（命令行 status）** |
| **飞书通知通道** | ❌ 没有 | ✅ 但当前只配了桌面通知 |

**唯一我们有、它没有的：没有。**
**唯一它没有、我们也没有的：Web 看板。这就是我们要做的事。**

---

## 七、待决策事项

### D1. 底层是否换成 Agent Autoloop？

| 方案 | 后果 |
|---|---|
| **A. 换（推荐）** | Soda Office 的 88 个测试、1722 行代码作废，但省下后续几个月的调度开发，且能持续跟上游更新 |
| B. 保留自研 | 继续补拍板、会话续接、事件溯源，工作量约 2–3 周，且永远落后上游 |
| C. 两套并行 | **不建议**，两套调度内核会打架（GPT 评审也明确反对） |

**我的建议：A。** 理由是它已经把 Agent 调度的坑踩完了，我们再走一遍不划算。

### D2. 通知通道接哪个？

现在是**桌面通知**（只能本机弹窗）。要接飞书，需要：
- 飞书自建应用（已有网关 PID 20952 可复用）
- 配置 `answerers`（谁能拍板，填你的 open_id）
- 配置回调地址

**需要你决定：接飞书，还是先只用桌面通知？**

### D3. Web 工作台技术选型

| 方案 | 说明 |
|---|---|
| **A. 纯静态 + fetch 轮询**（推荐） | 单 HTML 文件，`/v1/state` 每 3 秒拉一次，零依赖，和 Autoloop 风格一致 |
| B. 带 SSE 实时推送 | 用 `/v1/stream?after=seq`，更实时但代码复杂度高 |
| C. 框架（React/Vue） | 需要构建流程，与「零依赖」理念冲突 |

### D4. 开发由谁做？

Claude Code 的额度 20:28 恢复。按 GPT 评审的分工：
- **Claude Code** 写代码
- **Codex** 审查

---

## 八、环境变更清单（可回滚）

| 变更 | 位置 | 回滚方式 |
|---|---|---|
| 新增 Node 24 | `C:/Tools/node24/` | 删目录 |
| 新增 Autoloop | `C:/Tools/agent-autoloop/` | 删目录 |
| 用户级 PATH 新增 bin 目录 | Windows 环境变量 | 从 PATH 移除那一条 |
| 规则文件被改 | `rules.json` 的 `rules[0].to` 从 `claude` → `codex` | 改回 `claude`（我为了让 Codex 试跑临时改的） |

**没有动**：系统 Node 20、Soda Office 的 Node 22、Clash、任何正在跑的服务。

---

## 九、遗留问题

1. **Claude Code 额度未恢复** —— 20:28:33 重置，届时可补验 Claude 链路
2. **`rules.json` 被我改成指向 codex** —— 需要决定正式规则怎么配
3. **owner key 明文存在 `config.json`** —— 这是它自己的设计，但接 Web 面板时要避免把这个 key 打进前端
4. **Autoloop 的 `/v1/state` 只监听 127.0.0.1:3350** —— Web 面板要访问它，需要考虑同机部署还是加代理
5. **未验证飞书通道** —— 需要飞书应用配置
