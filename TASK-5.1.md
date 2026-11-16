# TASK-5.1 — Leo's Agent Office：从「任务表」改成「Agent 工位」

> 派单：Hermes · 执行：Claude Code · 日期：2026-11-13
> 前置：`web/index.html` 已是梵高风格（TASK-4.1 验收通过），工作台跑在 8090

---

## 一、为什么要改

用户原话：**「现在这里根本不像 Office，每个 Agent 要有自己的看板，当前状态」**

现在是：一张任务表格是主角，Agent 只是表格里的一列。
要变成：**Agent 是主角，任务围绕 Agent 展开。** 像走进一个有 4 名数字员工的办公室。

信息组织方式从「任务为中心」改为「Agent 为中心」。

---

## 二、必须做的事（按顺序）

### 2.1 改名

全站标题、`<title>`、hero 里的品牌文字，全部改成 **`Leo's Agent Office`**。

页面里不能再出现 "Soda Agent 工作台"、"Soda Office"、"SODA INTELLIGENCE" 这类旧名。
（保留 `style` 里的 CSS 变量名无所谓，只改**用户看到的文字**。）

### 2.2 Hero 缩小

现在 hero 是 240px+，占太多。**缩到 112–150px**，变成一条品牌横幅。

梵高星空还在，但不用靠一幅大油画证明风格。主体让给 Agent 工位。

### 2.3 首页 Agent 工位卡（核心）

每张工位卡 250–280px 高，**2 列布局**（4 个 Agent 时正好 2×2）。

每张卡必须包含五个区域：

| 区域 | 内容 | 数据来源 |
|---|---|---|
| 身份区 | 名称、岗位、连接状态点、最后心跳 | `agent.name`、`agent.online`、`agent.seenAt` |
| 当前工作 | 正在执行的任务名 + 已执行时长；没任务就显示「空闲」 | `runs` 里 `r.agent===agent.id && r.state==='running'`，用 `rule` 和 `claimedAt` |
| 工作负载 | 执行中 N · 排队 N · 重试 N | `totals.running/queued/retrying` |
| 今日成绩 | 今天完成 N 项 | `totals.doneToday` |
| 使用成本 | Token 数 + 成本 | `totals.usage.input/output/cost` |

**岗位（role）需要你在代码里映射**，从 agent.id 推：

```js
const ROLE = {
  'claude': '开发',
  'codex': '审查',
  'claude-readonly': '日报',
  'image-gen': '生图'
};
// 未知 id 用 agent.use 兜底，再不行显示「成员」
```

### 2.4 连接状态 vs 工作状态，必须分开

这是 GPT 强调的关键点，我认同：

**不要**把 `online=true` 直接显示成「工作中」。`online=true` 只说明连着，不等于在干活。

```js
// 连接状态
const connection = !agent.online ? 'offline'
  : (now - Date.parse(agent.seenAt)) > HEARTBEAT_TTL ? 'stale'
  : 'online';

// 工作状态（和连接状态独立）
const work = totals.retrying > 0 ? 'retrying'
  : totals.running > 0 ? 'running'
  : totals.queued > 0 ? 'queued'
  : 'idle';
```

**HEARTBEAT_TTL 用 120000（2 分钟）**。别自己编，就用这个数，并在代码注释里写清楚这个值的来历是「比 Autoloop 心跳间隔宽裕，避免误报」。

显示时两个状态都要出现：卡片右上角是连接状态点（绿/黄/红），中间大字是工作状态（执行中/空闲/排队/重试中）。

**`retrying` 用琥珀色，不是红色。** 自动重试还在进行就不算失败。

### 2.5 「需要你关注」区

放在 Agent 工位**上面**，但要能折叠。

- 有 `cards` 待回答 / 有 `totals.retrying>0` → 展开，突出显示
- 都没有 → 折叠成一行「暂无需要你处理的事项」

**注意**：不要把普通失败任务伪装成「待审批」。只有真的需要人拍板的（`cards` 里待回答的）才算。

### 2.6 任务表格降级

原来的任务表格**保留**，但移到 Agent 工位**下面**，标题改成「最近任务」，作为全办公室的执行记录，不再是页面主角。

保留现有筛选功能（全部/进行中/排队/重试/完成/失败）。

### 2.7 Agent 详情（点工位卡）

点工位卡 → 打开**模态框**（不要新路由，不要新页面）。

模态框内容：
1. 顶部：Agent 名称、岗位、连接状态、心跳时间
2. **当前任务**（最显眼）：正在跑的任务列表，每项显示 rule、开始时间、已执行时长、state。若有 `link` 字段（如 `claude://resume?...`），显示成可点击链接
3. **今日与历史记录**：这个 Agent 的所有 runs，显示 rule / state / summary / 完成时间 / error
4. **统计**：Token、成本、完成数（放最后，不抢戏）

模态框要能关闭（ESC 或点遮罩）。

---

## 三、红线

1. **数据必须真实**。所有数字来自 `/api/state`，一个都不许写死或编造。没有数据显示「—」，不要显示 0。
2. **`totals.usage.cost` 不许直接标「今日花费」**。它是累计值，标成「累计成本」。
3. **不许加假进度条**。API 没有进度百分比，就不要画。
4. **不许加装饰性动画**（呼吸灯、扫描线那种）。状态点静态即可。
5. **`/api/state`、`/api/health`、`/api/cards/*` 路由一行不许改**。只改前端。
6. **断线提示不能坏**：中台停掉后仍要显示「中台离线」横幅。

---

## 四、布局细节

```css
/* 工位网格 */
.workstations {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 20px;
}
@media (max-width: 1100px) {
  .workstations { grid-template-columns: 1fr; }
}
```

**Agent 超过 8 个时**不用改布局（现在只有 4 个），但代码里留一行注释，写清以后要切紧凑模式。

工位卡排序固定为：需要关注 → 执行中 → 队列有活 → 空闲 → 离线。**不要每次刷新重排**，避免卡片乱跳。（用固定排序规则，状态变了卡片变色但不换位置也可以接受；你自己判断哪种更稳。）

---

## 五、验收标准

### 5.1 必须通过

1. **标题是 `Leo's Agent Office`**：`document.title` 和页面 hero 都是，`grep -c "Soda Agent 工作台\|SODA INTELLIGENCE"` 结果为 0
2. **4 张工位卡都在**：`document.querySelectorAll('.workstation').length === 4`
3. **每张卡有真实数据**：截图 + 用 JS 读出每张卡的 Agent 名、工作状态、今日完成数，与 `/api/state` 对比一致
4. **连接/工作状态分离**：贴出代码里 `connection` 和 `work` 两个变量怎么算的
5. **点卡片出模态框**：JS 点击第一张卡，断言模态框出现且内容含该 Agent 名的任务记录
6. **断线提示没坏**：停中台 → 页面显示「中台离线」→ 恢复后自动回连
7. **成本标签正确**：页面上是「累计成本」不是「今日花费」
8. **Hero 高度 112–150px**：用 `getBoundingClientRect()` 实测并贴出数值

### 5.2 不允许的做法

- ❌ 写死任何 Agent 数据
- ❌ 把 `online` 显示成「工作中」
- ❌ 加假进度条
- ❌ 改后端 API

---

## 六、交付

1. 改好的 `web/index.html`
2. `web/UI-V2-验收.md`：贴真实命令输出，证明 5.1 八条

---

## 七、边界

- ❌ 不改 `server.js` 任何 API 逻辑
- ❌ 不动 Autoloop
- ❌ 不新生成图片（现有三张够用；真要新的用 `image-gen.js` 桥，但先说清为什么需要）
- ❌ 验收证据不许编

---

## 八、回复要求

1. 八条验收的**逐条真实输出**
2. 截图路径
3. 遇到什么坑、哪里和任务书对不上
4. 有没有你觉得该改但我没说的

**不要写「已完成」，要写证据。**
