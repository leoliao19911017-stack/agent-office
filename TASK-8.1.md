# Leo's Agent Office — 整体 UI 设计与素材包任务书

## 你是谁

你是这个工作台的**视觉设计师 + 前端工程师**。不是执行别人拆好的碎活，是要你对整体风格负责。

## 现在的问题（用户原话）

> 「agent从下方弹出，且不要遮挡到agent。然后页面中的button。icon还有右侧步骤详情都需要好好在设计一下，现在整体风格非常不搭。」

翻译成设计语言：

1. **Agent 抽屉位置错了**——现在从左侧滑出，覆盖主看板。用户要和看板同时看，不能二选一。改成**底部弹出**，不遮挡任何内容。
2. **按钮和图标和整体风格不搭**——现在是随手写的细线 SVG + 圆角矩形，跟梵高皮完全两张皮。
3. **右侧 Inspector 风格不搭**——它是纸色底配深墨字，看着像贴了一张便利贴，不像这个应用的一部分。

## 产品定位（这条最重要，决定了所有取舍）

**「天天用的工具」，不是演示页。**

判断标准：连看 8 小时会不会累。

所以：
- 梵高风格只许出现在「容器边缘」——顶栏、底栏、弹层的外框、登录页这种地方
- 数据正文区（需求列表、步骤卡、Inspector、文件预览）必须**零纹理、满对比度、快速扫读**
- 金色只给「待拍板」和「当前步骤」，不许满屏点缀
- **不许为了好看牺牲可读性**

## 现有资产

```
工作目录：C:/Users/Administrator/Desktop/Soda Intelligence - AI Native Thinking/Soda Office/web/

index.html   约 65KB，单文件，内联 CSS + 内联 JS，零依赖
server.js    零依赖 node:http，已就绪的接口见下
assets/
  starry-night.webp     1600x533  梵高星空（Codex 生成）
  canvas-texture.webp   384x384   纸张纹理（Codex 生成）
  golden-star.webp      256x256   金色星芒，透明（Codex 生成）
  agents/*.png          7 张 Agent 头像 1254x1254
```

## 接口（全部已就绪，别改结构）

```
GET  /api/state               Agent 状态、任务、连接
GET  /api/office/flow         需求 7 步流水
GET  /api/office/files        产物索引（旧，可忽略）
GET  /api/office/skills       技能索引（222 条）
GET  /api/office/file?path=   读文件内容（白名单 + 403/404 防护已做）
POST /api/office/file-check   批量核实文件存在性
```

`/api/office/flow` 结构：
```json
{ "tasks": [ { "id","title","done","total","updatedAt",
  "steps": [{ "key","no","name","hint","gate","status","at","note","by",
              "files":[{ "path","bytes","sha256" }] }] } ] }
```

`/api/state` 关键字段：
```
agents[{ id, name, online, seenAt, totals{running,queued,retrying,done,doneToday,usage{input,output,cost}} }]
runs[{ id, agent, state, rule, summary, link, usage }]
totals{ running, queued, done, doneToday, attention, retrying }
```

Agent id → 中文岗位映射（**必须显示岗位，不显示裸 id**）：
```
claude 开发 / codex 审查 / claude-readonly 日报 / image-gen 生图
dsh 开发 / hermes 调度 / gpt-drive 讨论
```

## 任务一：Agent 改底部抽屉

**现在**：左侧滑出 420px，覆盖主看板。

**要求**：

- 从**底部**滑出，高度约 300–340px（可拖拽调高到 60vh）
- **不许遮挡主看板的核心内容**。做法：抽屉弹出时主区整体上移收缩（`transform` 或 flex 让出空间），而不是盖上去
- 列表横向排列（7 个 Agent 一行），每个卡片：头像 44px + 名字 + 岗位 + 状态点 + 1–2 个关键数字
- 点单个 Agent → **同一个抽屉内原地展开**明细（不要再来一层），明细在下方或右侧展开
- 顶部一条细手柄，可拖拽

## 任务二：重做按钮与图标

**现在的问题**：细线 SVG，1.5px stroke，和梵高皮两张皮。

**要求**：

- 统一图标风格。建议：**金线条 + 圆头端点 + 微量厚度**，呼应梵高的笔触感，但保持极简
- 所有图标用 **inline SVG**（不要额外请求），尺寸 16/20/24 三档，`stroke-linecap:round`
- 按钮分三级，视觉要拉开：
  - **主按钮**（琥珀色实心，只给「确认」「开始」这类）
  - **次按钮**（描边，边框用 `--line` 加深一档）
  - **幽灵按钮**（透明底，hover 才出现底色）
- 按钮圆角 7px，内边距 6px 14px，字号 12.5–13px
- hover / active / disabled / focus 四态都要有，**focus 必须可见**（键盘可达）

## 任务三：重做右侧 Inspector

**现在的问题**：整块纸色底，像贴了张便利贴。

**要求**：

- 底色改回深色面板（`--panel`），**纸色只留在「当前步骤标题区」做一个小色块**，作为视觉锚点
- 结构重排，从上到下：
  1. **步骤头**：`STEP 06` 金色小标 + 步骤名（16px）+ 状态胶囊
  2. **执行信息**：执行者头像 24px + 名字 + 时间，一行放下
  3. **产物列表**：每行 文件名 + 字节 + 可点开；文件不存在要红标
  4. **上下游**：紧凑两行，带小箭头
  5. **备注**：正文 13px，行高 1.65
- 分区之间用**极细分割线**（1px `--line`），不要卡片套卡片
- 空状态要好看：「这一格还没有内容」配一个极简线稿图标

## 任务四：Skill Hub

数据源 `/api/office/skills`，返回 222 条技能索引。

**要求**：

- 入口：左侧导航加一个「技能」图标
- 打开后是**底部抽屉**（和 Agent 抽屉同一套交互，不要两套）
- 顶部：搜索框 + 按 Agent 过滤的胶囊（claude 139 / codex 82 / hermes 1）
- 列表：虚拟滚动或分页（222 条不能一次全渲染），每项显示 技能名 + 一句话描述 + 归属 Agent
- 点击技能 → 右侧（或下方）显示完整描述 + 安装命令
- **空搜索结果显示友好提示**，不要空白

## 任务五：文件库

数据源：从 `/api/office/flow` 的各 step.files 聚合，加上 `/api/office/file?path=` 读内容。

**要求**：

- 入口：左侧导航加一个「文件」图标
- 打开后是**底部抽屉**（同上）
- 按需求分组，每组可折叠
- 每行：文件图标（按扩展名区分）+ 文件名 + 字节 + 所属步骤
- **点击直接打开预览**（复用现有 `#file-view` 弹层，别重写）
- 文件不存在要红标 + 「文件已被移走」

## 任务六：Codex 出设计稿和素材包

**先出设计稿给我看，我认可后再写代码。**

设计稿要求：

1. 主界面（含底部 Agent 抽屉打开状态）
2. Inspector 特写
3. 按钮与图标规范页（三级按钮 + 全部图标的四态）
4. 文件库 / 技能中心抽屉
5. 空状态与错误状态

素材包要求：

- 图标：SVG，纯代码手写，存 `web/assets/icons/`，每个 24×24 viewBox，`currentColor`
- 背景：已有星空/纸纹/星芒，如需补充（比如空状态插画、抽屉手柄纹样）生成 PNG 存 `web/assets/`

**设计稿可以用 HTML 做一个静态页**（`web/design-preview.html`），这样我能直接打开看，也能给用户截图确认。

## 硬性约束

1. **零依赖**——不许 npm install，不许引入框架，纯 HTML/CSS/JS
2. **整页不出纵向滚动条**——顶栏底栏固定，中间各栏自己滚
3. **3 秒轮询不能重置 UI 状态**——选中的需求、步骤、抽屉开合、滚动位置都要保持
4. **不虚构数据**——没数据显示 `—`，不写 0 冒充
5. **不许新增假按钮**——没做的功能不要放可点的东西
6. **颜色变量统一走 `:root`**——不许散落硬编码色值
7. **可访问性**：按钮必须是 `<button>`，图标加 `aria-hidden`，焦点可见

## 交付格式

```
DELIVERABLES:
- <绝对路径> | <说明> | <字节数>

DESIGN:
- 设计稿路径 | 截图路径

VERIFY:
- 整页纵向滚动: <有/无>
- 轮询后状态保持: <是/否>
- 底部抽屉不遮挡: <是/否>
- 图标数量: <N>, 全部 inline SVG: <是/否>
- Skill Hub 222 条渲染: <是/否>
- 文件库聚合文件数: <N>
- 截图: <路径列表>
```

字节数必须真实。
