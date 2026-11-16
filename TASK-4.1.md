# TASK-4.1 — 工作台 UI 改造为梵高《星月夜》风格

> 派单：Hermes · 执行：Claude Code · 日期：2026-11-13
> 前置：`web/index.html` 已存在（481 行，深色 DevTool 风格），Worker 工作台跑在 8090

---

## 一、目标

把 `http://127.0.0.1:8090` 的工作台从深色极简风格改成**梵高《星月夜》油画风格**。

**但不是画成油画。** 定位是：

> 70% 专业 DevTool + 20% 梵高油画语言 + 10% 星光装饰

用户第一眼看到的仍然必须是：**哪个 Agent 在工作、什么任务失败了、哪些决策等他处理。**

---

## 二、红线（违反直接打回）

1. **动态数据绝不画进图片**。Agent 在线状态、任务名、进度、待决策数量，全部是 HTML 文本 + CSS，不许是图片。
2. **任务表格零纹理**。表格是阅读区不是装饰区。正文 ≥14px，辅助文字 ≥12px，正文与背景对比度 ≥4.5:1。
3. **金色 ≠ 成功**。金黄只用于品牌强调和待决策提醒。成功=绿，失败=红，运行中=蓝，且必须同时有文字或图标（不能只靠颜色）。
4. **不许破坏现有功能**。`/api/state` 轮询、卡片回答、断线重连显示"中台离线"，这些一个都不能坏。

---

## 三、配色（直接用，不要自己改）

```css
:root {
  --bg: #0C1730;          /* 页面背景 · 深夜靛蓝 */
  --sidebar: #111E39;
  --card: #172845;        /* 卡片背景 */
  --card-hover: #203657;
  --border: #39516F;      /* 边框蓝灰 */

  --text: #F5F2E9;        /* 主文字 · 米白 */
  --text-secondary: #C4D3E8;
  --text-muted: #9FB5CE;

  --gold: #F4CD72;        /* 星光金 · 只用于强调和待决策 */
  --running: #79C1F5;     /* 旋涡蓝 · 运行中 */
  --success: #80D69F;     /* 成功绿 */
  --failed: #FF8B85;      /* 失败红 */
}
```

---

## 四、需要生成的图片（3 张，第一轮）

**你自己调 Codex 生图。** 方法见第八节。

### 图 01 · 星空主视觉 Hero

- 尺寸：**2400 × 640 px**
- 格式：PNG（先用 PNG，不必转 WebP）
- 构图：**右侧 60% 画旋涡和星光，左侧 40% 深蓝留白**
- 用途：页面顶部欢迎区，高度 220–280px，左侧盖渐变遮罩放标题

### 图 02 · 无缝画布肌理

- 尺寸：**512 × 512 px**
- 格式：PNG
- 构图：均匀细小的画布纤维和短笔触，**不要出现具体星星**
- 用途：页面底层贴图，CSS 透明度 3%–5%，`background-repeat: repeat`
- 注意：必须能无缝平铺（接缝不能看出来）

### 图 03 · 金色星光角饰

- 尺寸：**512 × 512 px**
- 格式：**透明背景 PNG**（关键，不能白底）
- 构图：只有一颗主星 + 少量旋转笔触，**四周留白**
- 用途：待决策卡片右上角，实际显示 64–96px，`opacity: .24`

---

## 五、生图统一约束（每条 prompt 都要带这段）

```
Create an individual decorative asset for a professional data-dense Agent Office dashboard.

Visual language:
Van Gogh-inspired post-impressionist oil painting,
visible impasto brushstrokes, swirling cobalt blue,
ultramarine, midnight navy and restrained golden stars.

Must NOT include:
Text, logos, letters, numbers, interface controls,
charts, tables, fake buttons or dashboard screenshots.

Prioritize negative space, controlled visual density,
and legibility when overlaid with real HTML components.

Do not produce a complete UI screenshot.
```

---

## 六、CSS 实现要点

### 6.1 Hero 区（星空 + 渐变遮罩）

```css
.office-hero {
  isolation: isolate;
  min-height: 240px;
  background:
    linear-gradient(90deg,
      #0C1730 0%,
      rgba(12,23,48,.96) 36%,
      rgba(12,23,48,.28) 100%),
    url("./assets/starry-hero.png") right center / cover no-repeat;
}
```

**渐变遮罩是关键**：左侧压深才能放标题文字，否则字看不清。

### 6.2 待决策卡片（星光角饰）

```css
.task-card.needs-decision::before {
  content: "";
  position: absolute;
  top: -12px; right: -12px;
  width: 88px; height: 88px;
  background: url("./assets/golden-star.png") center / contain no-repeat;
  opacity: .24;
  pointer-events: none;   /* 必须，否则挡住按钮点击 */
}
```

**`pointer-events: none` 不能漏**，否则星饰挡住下面的按钮点不动。

### 6.3 任务表格（零纹理）

```css
.task-table {
  background: #101D35;
  color: var(--text);
  font-size: 14px;
}
```

不许加任何纹理、滤镜、油画底纹。

### 6.4 状态色

```css
.is-running { color: var(--running); }
.is-success { color: var(--success); }
.is-failed  { color: var(--failed); }
.is-pending { color: var(--gold); }
```

每个状态**再配一个小图标或文字**，不能只靠颜色区分。

---

## 七、文件结构

```
Soda Office/web/
├── server.js           # 不动
├── index.html          # 改造这个
└── assets/             # 新建
    ├── starry-hero.png
    ├── canvas-texture.png
    └── golden-star.png
```

**`server.js` 一行不许改。** 但要让它能返回 `assets/` 下的图片（检查现在的静态文件路由，如果只服务 index.html，需要加一个读 assets 的分支——这个改动是允许的）。

---

## 八、怎么调 Codex 生图（重点）

**不要自己去猜 Codex 怎么用。** 用已经验证过的桥：

```bash
# 生图，prompt 作为参数，输出目录固定
"C:/Tools/node24/node.exe" "C:/Tools/agent-autoloop/image-gen.js" \
  "C:/Users/Administrator/Desktop/Soda Intelligence - AI Native Thinking/Soda Office/web/assets" \
  "你的 prompt 写在这里"
```

**它会做的事**：
1. 调 Codex CLI 生成图片
2. 把图存到你指定的目录
3. 在 stdout 打印**图片的绝对路径**
4. 退出码 0 = 成功，非 0 = 失败

**你要做的**：
1. 执行上面的命令
2. 从 stdout 拿到路径
3. **用 `Read` 工具读那个文件，确认存在且 > 10000 字节**
4. 重命名成 `starry-hero.png` / `canvas-texture.png` / `golden-star.png`

**注意**：
- 单张图 30–90 秒，命令要给足超时（不要用默认短超时）
- Codex 对形状理解有偏差，prompt 要把构图说死（"左侧 40% 留空"这种要写清）
- 图 03 要透明背景，如果生成的是白底，在 prompt 里强调 `transparent background, PNG with alpha channel, no background fill`

---

## 九、验收标准

### 9.1 必须通过

1. **服务起来**：`PORT=8090 node web/server.js` 后 `curl http://127.0.0.1:8090/` 返回 200
2. **三张图真的存在**：`ls -la web/assets/`，每张 > 10000 字节
3. **图能被访问**：`curl -I http://127.0.0.1:8090/assets/starry-hero.png` 返回 200 且 Content-Type 是 image/png
4. **页面显示新风格**：浏览器打开能看到星空 hero 和蓝金配色
5. **数据仍然是真实的**：页面上的 Agent 列表、任务列表、Token 统计，和 `agent-autoloop status` 一致
6. **功能没坏**：把中台停掉，页面显示"中台离线"（不是白屏）
7. **对比度合格**：任务表格正文能在正常光线下看清

### 9.2 加分项

- 星空 hero 在 1366 / 1440 / 1920 三种宽度下都不变形
- 待决策卡片有金色星光角饰，但按钮能正常点击（不被遮挡）

---

## 十、交付

1. 改好的 `web/index.html`
2. `web/assets/` 下三张图
3. `server.js` 的静态资源路由改动（如果改了）
4. **`web/UI-验收.md`**：贴真实命令和输出，证明 9.1 的每一条

---

## 十一、边界

- ❌ 不改 `server.js` 的 API 逻辑（只加静态资源路由）
- ❌ 不动 Autoloop（`C:/Tools/agent-autoloop`）
- ❌ 不自己造生图方法，只用第八节给的桥
- ❌ 不把数据画进图里
- ❌ 验收证据不许编，跑不通写跑不通

---

## 十二、回复要求

回复时给：
1. 三张图的**真实路径和字节数**
2. 改了什么（index.html 哪些地方）
3. 验收 9.1 七条的逐条结果
4. 遇到什么坑

**不要写"已完成"，要写证据。**
