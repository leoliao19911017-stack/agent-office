# TASK-5.2 — 修正数据标注 + 接入 Agent 头像

> 派单：Hermes · 执行：Claude Code · 日期：2026-11-13
> 前置：TASK-5.1 验收通过（4 张工位卡已上线）

---

## 一、必须修的三个数据诚实性问题

### 1.1 `image-gen` 显示「累计成本 $0 · 0 Token」是错的

**真实情况**：Autoloop 的 `runs[].usage` 对这个 Agent 返回 `null`，所以 `totals.usage` 是 `{input:0, output:0, cost:0}`。

这不是「花了 0 元」，是**没有统计数据**。

**要求**：
- 当 `agent.totals.usage.cost === 0 && agent.totals.done > 0 && agent.id` 属于 command 型（`agent.use === 'command'`）时，显示 **`成本未统计`**，不要显示 `$0`
- 同理 Token 显示 `—` 不显示 `0`
- 判断依据写进代码注释

### 1.2 顶部「今日 $4.34」和卡片「累计成本」口径混乱

顶部用的是 `spending.today.cost`（今日），卡片用的是 `agent.totals.usage.cost`（累计）。

现在两个数字碰巧相等（4.34314），因为今天的数据就是全部数据。但**口径不同必须标清**：

- 顶部保持「今日 $4.34」← 来自 `spending.today`
- 卡片改成 **`累计 $2.27`**（明确写「累计」，不写「累计成本」，省两个字但意思清楚）

**如果 `spending.today.cost` 存在但 `missingCost > 0`**，顶部要显示「今日 $4.34（7 轮缺成本数据）」——这个已经做了，保持。

### 1.3 `missingCost` 要说明清楚

顶部现在有「（部分轮次缺成本数据）」，但用户不知道缺几轮。

**改成**：`今日 $4.34 · 7 轮缺成本数据`
（用 `spending.today.missingCost` 的真实值，不要写死）

---

## 二、接入 Agent 头像

头像已经生成好了，在：

```
web/assets/agents/
├── claude-code.png        (3,690,579 字节)
├── codex.png              (3,809,980 字节)
├── claude-readonly.png    (3,609,559 字节)
└── image-gen.png          (3,797,574 字节)
```

**要求**：

1. 每张工位卡的身份区左侧放头像，**尺寸 72×72px**，`border-radius: 50%`，`object-fit: cover`
2. 加一圈 2px 的边框，颜色用 `var(--border)`；Agent 在线时边框改成 `var(--gold)` 或 `var(--success)`（你判断哪个更好看）
3. **头像加载失败要有兜底**：`onerror` 时显示一个纯色圆形 + Agent 名字首字，不能出现裂图
4. 映射关系写死在这张表里，按 `agent.id` 取：

```js
const AVATAR = {
  'claude': 'assets/agents/claude-code.png',
  'codex': 'assets/agents/codex.png',
  'claude-readonly': 'assets/agents/claude-readonly.png',
  'image-gen': 'assets/agents/image-gen.png'
};
// 未知 id 走兜底，不报错
```

5. **不要用 48px 以下**。实测这些图细节多，48px 认不出来，72px 是下限。

---

## 三、验收

1. `document.querySelectorAll('.agent-avatar').length === 4`
2. 4 张头像的 `naturalWidth > 0`（真的加载成功，不是裂图），贴出每张的 `src` 和 `naturalWidth`
3. `image-gen` 卡片显示「成本未统计」不是「$0」
4. 顶部显示「7 轮缺成本数据」这样的真实轮数
5. 截图一张

---

## 四、边界

- ❌ 不改 `/api/*` 路由
- ❌ 不重新生图（4 张已经够用）
- ❌ 不许写死数字，全从 API 取
- ❌ 验收证据不许编

---

## 五、回复要求

五条验收的逐条真实输出 + 截图路径。
