# Orca 调研：能借鉴什么

调研对象：https://github.com/stablyai/orca （MIT，127.8k star，YC backed，2026-11-18 仍在日更）
调研时间：2026-11-18
我们的系统：Leo's Agent Office（127.0.0.1:8090）+ Agent Autoloop 流水线

---

## 一、Orca 是什么

**一句话**：让你用自己的订阅跑一队编码 Agent（Claude Code / Codex / Hermes 等），桌面 + 手机 + 远程都能用。

**核心不是界面，是那套编排模型。** 它有 12 个功能模块，但对我们的价值集中在三块：

1. **Orchestration（编排）** —— Run / Task / Dispatch / Worker / Message / Decision Gate
2. **Review AI Output（审 AI 的产物）** —— 在 diff 的具体行上留意见，直接发回 Agent
3. **Parallel Worktrees（并行工作区）** —— 每个 Agent 一个隔离目录，互不干扰

---

## 二、最该借鉴的：它的编排模型（我们正好卡在这）

### Orca 的做法

```
Run      = 持久的命名空间 + 收件箱，从不自己派活
Task     = 工作项，带 spec、依赖、状态
           状态：pending / ready / dispatched / completed / failed / blocked
Dispatch = 一次执行尝试，是「完成」的权威来源
Message  = 收件箱邮件
           worker_done / heartbeat / escalation / question / status / dispatch
Gate     = 决策关卡，阻塞任务直到有人回答
```

**三条硬规矩，直接对应我们踩过的坑：**

**① `worker_done` 必须恰好发一次，失败也要发，且必须带 `--outcome`**

> 「Send `worker_done` exactly once, even on failure, with `--outcome`.」
> 「Worker completion and heartbeat messages should include both `taskId` and `dispatchId`.」
> 「Include both task and dispatch IDs so **stale retries cannot complete the wrong dispatch**.」

**我们踩的坑**：Claude Code 干完活不退出、不返回结果，必须靠退出码猜。我们只能靠「文件改了没有」来侧推它干没干完。

**② 长任务要发 heartbeat**

> 「Send `heartbeat` messages during long active work when the dispatch brief requests them.」
> 心跳间隔 1-60 分钟可调，默认 5 分钟。

**我们踩的坑**：一条任务跑 25 分钟，中间完全失联，只能靠 CPU 时间猜它是不是还活着。

**③ Worker 有问题要「问」，不要自己卡住**

> 「Use `orca orchestration ask` for blocking questions instead of local TUI prompts.」

带超时、带选项、带 JSON 返回，worker 可以直接 `jq -r .answer` 拿到答案。

**我们踩的坑**：Claude Code 遇到不确定的事就在那儿耗着，最后被超时杀掉，我们完全不知道它卡在哪个问题。

### 我们能怎么用

**最小改造，收益最大的一步：给 Claude Code 的输出立规矩。**

现在的调用是：
```bash
claude -p --permission-mode bypassPermissions --output-format json < 任务书
```

**改成：任务书开头强制要求它在最后写一段固定格式的 JSON**

```json
{
  "task_id": "R80-W02",
  "outcome": "succeeded | failed",
  "summary": "做了什么",
  "files_modified": ["web/app.css"],
  "blocked_by": "如果没做完，卡在哪",
  "evidence": {"实测数值": "..."}
}
```

**这样就不必靠退出码猜了。** 解析这段 JSON 就知道它干完没有、干了什么、卡在哪。

---

## 三、第二个值得抄的：审 AI 产物的方式

### Orca 的做法

> 「Review diffs, leave notes on exact changed lines, and send focused feedback back to an agent.」

**在 diff 的具体行上留符号，直接把这条意见发回给 Agent。**

配套还有：
- 从 diff **自动起草** commit message 和 PR
- CI 失败 / PR review 意见，**直接发回 Agent 让它修**

### 我们的问题

**GPT 评审只能看截图，看不到代码，所以：**
- 可维护性那项永远是「截图无法证明代码结构」
- W02「审批滚动最后一行能不能看到」连续 27 轮无法验收
- 「审批提交瞬间服务端有没有重新校验」永远缺证据

**这正好是 Orca 那套要解决的问题：评审要落到 diff 和测试上，不能只看渲染结果。**

### 我们能怎么用

**每轮评审的输入，从「4 张截图」改成「4 张截图 + git diff + 测试输出」：**

```bash
# 本轮改了什么，逐行给 GPT 看
git diff HEAD~1 --stat
git diff HEAD~1 -- web/ | head -800

# 服务端接口的真实响应
curl -s -X POST /api/office/decision -d '{...}' | jq

# 实测数值
node verify-w02.mjs   # 输出 scrollTop / scrollHeight / 是否可见
```

**W02 那种「滚动能不能到底」的问题，用 `scrollTop + clientHeight >= scrollHeight - 1` 一行就能证明，根本不需要 GPT 看图猜。**

---

## 四、第三个：并行的隔离

### Orca 的做法

> 「Quickly split tasks into isolated environments, so multiple agents can work side by side without interfering with each other.」

**每个任务一个 git worktree**，多个 Agent 同时改，互不覆盖。

**还支持嵌套**：worker 可以再起 helper worker，默认深度 4；停父级的，子级一起停。

### 我们的问题

**今天真实发生过两件事故：**
1. 两个 Claude Code 会话同时改同一个 `server.js`，代码里出现了任务书完全没提的 `TASK-R4/R7`、`WORKBENCH_WRITER`
2. 66 个手写 `.bak` 文件当版本管理，改坏不知道回滚到哪

### 我们能怎么用

**已经有了 git（今天建的），下一步可以：**
```bash
# 每个任务一个隔离分支，改完再合
git worktree add ../office-r80 -b task/r80
```

**收益**：多轮可以并行跑，互不污染；改坏了直接删 worktree，主目录不受影响。

**成本**：每次要合并，对单线程流水线暂时没必要。**等要并行跑多轮的时候再上。**

---

## 五、其他值得看一眼的

| 功能 | 它怎么做的 | 我们要不要 |
|---|---|---|
| **Design Mode** | 在浏览器点任意元素，复制 HTML / 样式 / 选择器，直接贴进 Agent 对话 | **可以借鉴**：我们截图时顺带把关键元素的 `getBoundingClientRect` + `getComputedStyle` 一起给 GPT，比截图精确得多 |
| **Computer Use** | 没 CLI / API 的地方，Agent 直接看和操作桌面 | 我们已有（`computer_use`） |
| **Automations** | 定时在任意仓库跑 prompt：夜间依赖升级、周度分类、flaky 测试扫描 | 我们的 cron 已经在做类似的事，做法更糙 |
| **Usage & Accounts** | 看额度用了多少、什么时候重置，多账号切换不用重新登录 | **值得抄**：Codex 额度耗尽时我们只能干等，应该显式读到重置时间 |
| **Chat / Terminal 双模** | 同一个会话能在聊天界面和裸 CLI 之间切换，不丢上下文 | 我们做不到（`claude -p` 是一次性执行，这是我们已知的天花板） |

---

## 六、我的判断：三个层面

### 立刻能做（半天内）

**① 任务书末尾强制落 JSON 收尾**
解决「干完不知道干没干完」，比退出码判断可靠得多。**这是今天最该做的一件事。**

**② 评审输入加 diff 和接口响应**
解决 W02 那 27 轮验收不了的问题。一个 `scrollTop + clientHeight >= scrollHeight` 就够。

### 有空再做（一两天）

**③ 心跳机制**
长任务每 5 分钟写一次进度到状态文件，我们能看出它是在干活还是卡住了。

**④ 显式读额度重置时间**
Codex 的 `try again at Nov 19th` 应该直接读出来，而不是靠猜。

### 不建议现在做

**⑤ 全套 Orca 编排架构**
Run / Task / Dispatch / Gate 那套**是好东西，但我们是单线程流水线，上了是过度设计。**

**更实际的选择：直接装 Orca 用。** 它是 MIT 开源的，支持 Hermes Agent 和 Claude Code，`orca.dev` 有桌面版。**如果它能跑通我们的场景，我们自研的调度层可以直接退休。**

---

## 七、一个提醒

**Orca 是竞品，不是范本。** 它 985 个贡献者、22,199 次提交、日更 —— 我们不可能追上它的迭代速度。

**所以问题不是「怎么照着做一个 Orca」，而是「我们的场景里，哪一小块值得抄」。**

我的回答是：**抄它的「收尾契约」和「评审落到 diff 上」两件事就够了。别的不碰。**
