# TASK-10.1：接入油画风资产（Claude Code 执行）

## 你的角色

**你负责写代码。** 图片资产由 Codex 出，已经放在 `web/assets/` 下，你只需要接入。

**不要生图、不要改图片文件。** 如果发现资产缺失或尺寸不对，在交付里写清楚，不要自己造一个。

## 工作目录

```
C:/Users/Administrator/Desktop/Soda Intelligence - AI Native Thinking/Soda Office/web/
```

主文件：`index.html`（约 234KB，单文件，内联 CSS + 内联 JS，零依赖）

**动手前先备份**：
```bash
cp index.html index.html.bak-task10.1
```

## 一、替换图标：几何 SVG → PNG 油画风

### 现状

`index.html` 里有一个 `ICONS` 常量（约在 1759 行），是 20 个几何线条 SVG：

```js
const ICONS = {"board":"<rect .../>", "agents":"<circle .../>", ...};
```

这些 SVG 会在启动时被注入到导航按钮里（找 `for(const [id,name] of Object.entries({...}))` 那段）。

### 要改成

用 `web/assets/icons/` 下的 PNG。**文件名对应关系**（Codex 实际用的命名，带 `icon-` 前缀）：

```
icon-board.png     工作台
icon-agents.png    Agents
icon-skills.png    技能
icon-folder.png    文件
icon-focus.png     专注
icon-search.png    搜索
icon-settings.png  设置
icon-close.png     关闭
icon-chevron.png   箭头
icon-check.png     完成
icon-warning.png   警告
icon-clock.png     时间
```

**已实测确认**：12 个文件全部存在，尺寸 64×64，RGBA 真透明（四角 alpha=0），字节数 2KB–6KB。

其他资产也已就绪：

```
web/assets/btn-frame.png       96×96   按钮底纹，RGBA 透明
web/assets/empty-files.png     320×200 无产物
web/assets/empty-data.png      320×200 无数据
web/assets/empty-search.png    320×200 搜索无结果
```

### 实现要求

1. **读目录确认真实文件名**，不要假设。用 `ls web/assets/icons/` 核对。如果 Codex 用了别的命名，以实际为准，并在交付里说明你调整了什么。
2. 做一个 `iconPNG(name)` 函数，返回 `<img>` 标签：
   ```js
   function iconPNG(name, size = 18) {
     return `<img class="ic" src="assets/icons/${name}.png" width="${size}" height="${size}" alt="" aria-hidden="true" decoding="async">`;
   }
   ```
3. **保留降级**：`<img>` 加 `onerror`，加载失败时隐藏而不是显示破图
4. **预加载**：12 个图标在启动时用 `new Image()` 预加载，避免切页/重渲染时闪一下
5. 原来的几何 SVG 全部删掉，不留死代码（`ICONS` 常量、`icon()` 函数如果没别的用途就删）

### 颜色处理

PNG 是米金色，不能跟随 `currentColor`。用 CSS：

```css
.ic { opacity: .82; transition: opacity .15s, filter .15s; }
.rail-item:hover .ic { opacity: 1; }
.rail-item.on .ic {
  opacity: 1;
  filter: brightness(1.15) sepia(.35) hue-rotate(180deg) saturate(1.6);
}
```

**调色目标是：默认暖米金，选中态偏蓝金。你自己调 `filter` 参数，达到「看得出选中但不过火」为止。调完截图确认。**

## 二、字体分层

### 现状

```css
body { font: 13px/1.6 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; }
```

全是无衬线。

### 要改成

在 `:root` 加变量：

```css
:root {
  --font-display: "Georgia", "Songti SC", "SimSun", "Noto Serif SC", serif;
  --font-body: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  --font-mono: "Cascadia Code", Consolas, "Courier New", monospace;
}
```

**应用到这些地方**（用 `--font-display`）：

- 页面大标题（工作台 / Agents / 技能 / 文件）
- 页面上方的小标题（如 `THE ATELIER`）
- 步骤编号 `01` `02`（`.sc-no` 或类似）
- 步骤卡标题
- Inspector 里的步骤名
- Agent 名字
- **所有大数字**（统计数字、字节数、花费金额）

**应用到这些地方**（用 `--font-mono`）：

- 文件路径（`.fv-path`）
- 技能名（`.skill-row b`）
- 文件名
- 步骤 key（`req` `doc` 这种）

其余保持 `--font-body`。

**注意**：衬线体字重用 `600`，不要用 `700`，否则太硬。

**不许引入 Web Font**（不能用 `@import`、`<link>` 到 Google Fonts 等）。只能用系统字体。

## 三、按钮底纹

`web/assets/btn-frame.png` 是 96×96 的九宫格底纹，只有描边和纹理，没有实心色。

```css
.btn {
  border: none;
  background-image: url("assets/btn-frame.png");
  background-size: 100% 100%;
  background-color: var(--card);   /* 实心色由 CSS 给 */
  border-radius: 8px;
  padding: 6px 14px;
  font: 13px/1 var(--font-body);
  cursor: pointer;
}
```

三级按钮：

| 级别 | class | 底色 | 说明 |
|---|---|---|---|
| 主 | `.btn-primary` | `#E0B341` 琥珀实心 | 只给「确认」「开始」这类 |
| 次 | `.btn-secondary` | `--card` | 描边为主 |
| 幽灵 | `.btn-ghost` | 透明 | hover 才出底色 |

`btn-frame.png` 的九宫格偏白，在主按钮（琥珀底）上可能不协调。**如果主按钮套上去难看，主按钮就用纯色不用底纹**，次/幽灵用底纹。你自己判断，截图确认后在交付里说明。

## 四、空状态插画

三张图：

```
web/assets/empty-files.png    无产物
web/assets/empty-data.png     无数据
web/assets/empty-search.png   搜索无结果
```

找到现有的空状态文字（搜「还没有」「没有找到」「暂无」这类），改成：

```html
<div class="empty">
  <img src="assets/empty-files.png" alt="" width="160">
  <p>这项需求还没有登记产物</p>
</div>
```

CSS：
```css
.empty { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 28px 0; color: var(--faint); font-size: 12.5px; }
.empty img { opacity: .55; }
```

## 五、不许碰坏（这些是已经做对的）

- 多页面 hash 路由 `#/agents` `#/skills` `#/files`，前进后退可用
- Skill Hub：222 条 / 每页 20 / 分页 / 详情 / 搜索 / Agent 过滤
- 文件库按需求分组折叠
- 步骤卡上的产物按钮（`data-open-step-files`），无产物时 disabled
- Inspector 深色底 + 纸色标题小色块
- 顶栏星空（opacity .26）、底栏星空边
- 选中态蓝色 `#5B8FF9`；琥珀 `#E0B341` 只给待拍板
- `/api/office/file` 白名单 + 403/404
- **整页不出纵向滚动条**
- **3 秒轮询不重置 UI 状态**（选中的需求、步骤、页面路由、滚动位置）
- **零依赖，不许 npm install**

## 六、验收（必须自己实测，不许只报完成）

跑一遍，把真实数字写进交付：

1. 打开 `http://127.0.0.1:8090`，控制台**报错数 = 0**
2. 12 个图标的 `<img>` 全部 `naturalWidth > 0`（不是破图）
3. 切到 `#/agents` `#/skills` `#/files` 再切回，图标仍在
4. `getComputedStyle(页面大标题).fontFamily` 含 `Georgia` 或 `Serif`
5. `getComputedStyle(正文).fontFamily` 不含 `Serif`
6. 等 10 秒（3 次轮询），选中的需求/步骤/路由**没有被重置**
7. `document.documentElement.scrollHeight === innerHeight`（四个页面都要测）
8. 地图标在导航里的悬停/选中态**看得出差异**
9. 截图：工作台、Agents、技能、文件库、空状态、按钮三级对比

## 七、交付格式

```
BACKUP: <备份文件路径>

CHANGED:
- <文件> | <改了什么，一句话>

MEASURED:
- 控制台报错数: <N>
- 图标 loaded: <N>/12  破图数: <N>
- 切页后图标仍在: <是/否>
- 标题 fontFamily: <实际值>
- 正文 fontFamily: <实际值>
- 轮询10秒后状态保持: <是/否>
- 四个页面 scrollHeight/innerHeight: /=<N> agents=<N> skills=<N> files=<N>
- 图标文件名调整: <有/无，说明>

SCREENSHOTS:
- <路径> | <说明>

ISSUES: <如实写>
```
