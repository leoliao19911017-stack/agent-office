# TASK-10.1 交付报告 — 油画风资产接入 Soda Office

日期:2026-11-14 | 执行:Lemate(Claude Code) | 资产提供:Codex

```
BACKUP: web/index.html.bak-task10.1(234434 字节,改动前原件)
```

## CHANGED

仅改 `web/index.html` 一个文件(零依赖保持,未 npm install,未引入 Web Font,未改任何图片文件):

1. **图标系统**:删除 ICONS 常量与 icon()(不留死代码),新增 `iconPNG(name,size)` 返回 `<img class="ic">`(onerror 隐藏降级,启动 `new Image()` 预加载 12 个)。注入 10 处:侧栏 5 项、搜索、设置、工作台/Inspector 折叠 ×2。米金色不跟随 currentColor,用 CSS 区分状态:默认 `opacity .82`、悬停 `opacity 1`、选中 `brightness(1.12) sepia(.3) hue-rotate(175deg) saturate(1.5)`(米金→蓝金)。文件按钮、技能详情关闭、分页按钮、轮询控制(暂停/静默/立即刷新)同步换新按钮样式。
2. **字体分层**:`--font-display`(Georgia/宋体系)应用到 h1–h4、.tb-logo、.eyebrow、.ip-step、.step-number、.sc-title、.ov-cell、.ip-file .fb、.phase .p-name、.agent-name、.agent-stats b、.ch-meta、.req-prog、#agent-summary、#skill-count、#file-count,统一 `font-weight:600`(衬线不用 700);文件路径/技能名/key 走 `--font-mono`。变量定义复用 TASK-9.1,本次只补选择器。
3. **按钮三级**:`.btn-primary` 纯琥珀 #E0B341 实心(主动不用底纹,见 ISSUES 2);`.btn-secondary` --card 底 + `btn-frame.png` 底纹(background-size 100% 100%);`.btn-ghost` 透明、hover 出 --card 底。disabled 降透明度。
4. **空状态**:8 处文本占位换成 `empty-files/empty-data/empty-search` 插画(160px 显示、opacity .55),新增 `.empty` CSS;删除无引用的 `.empty-message` 死样式。
5. **favicon**:head 加 `<link rel="icon" href="data:,">`,消除浏览器自动请求 /favicon.ico 产生的 404(验收"报错=0"所需)。

## MEASURED(2026-11-14 隔离 Chromium 实测,CDP)

- 控制台报错数:**0**(清缓存 reload 后收集 6 秒,Log+Runtime+consoleAPI 三通道)
- 图标 loaded:**12/12**(每个 naturalWidth=64×64),破图 0
- 切页后图标仍在:**是**(#/agents→#/skills→#/files 往返,每页 `document.images` 全部 naturalWidth>0)
- 标题 fontFamily:`Georgia, "Songti SC", SimSun, "Noto Serif SC", serif`(h1 与 .sc-title 均含 Georgia)
- 正文 fontFamily:`"Segoe UI", "Microsoft YaHei", system-ui, sans-serif`(不含 Serif)
- 轮询 10.5 秒后状态保持:**是**(hash、选中步骤 class、Inspector、需求数 42 四项逐一比对全保持)
- 四个页面 scrollHeight/innerHeight:工作台 **545/545**、agents **545/545**、skills **545/545**、files **545/545**(整页无纵向滚动条)
- 空状态图:三张各自实证加载成功,naturalWidth 均 **320**(320×200,与资产规格一致)
- 图标文件名调整:**无**(例外两处见 ISSUES 1)

## SCREENSHOTS(docs/task-10.1/,1440×900@1.5x)

| 文件 | 说明 |
|---|---|
| 01-workbench.png | 工作台全景:衬线标题、PNG 图标、步骤卡 |
| 02-rail-detail.png | 侧栏特写:选中项蓝金描边 vs 未选中米金(AI 目检确认差异明显) |
| 03-agents.png | Agents 页:7 张工位卡、大数字衬线 |
| 04-skills.png | 技能页:222 技能/每页 20、分页 secondary 按钮(带底纹) |
| 05-empty-search.png | 技能搜索空状态:插画居中渲染正常 |
| 06-files.png | 文件库:分组折叠、文件行 folder 图标 |
| 07-buttons-3levels.png | 设置弹层:primary 纯琥珀实心 + ghost 文字态(AI 目检确认协调) |
| 08-step-files-picker.png | 步骤产物弹窗:ghost 关闭按钮、文件行图标 |

## ISSUES(如实)

1. **icon-file.png、icon-play.png 不在 Codex 交付的 12 个图标内**。文件按钮用 icon-folder.png 替代;播放/展开场景用 focus/chevron 替代。如需专属图标请 Codex 补两张 64×64 RGBA,替换无需改代码(改 iconPNG 调用参数即可)。
2. **主按钮不用 btn-frame 底纹**(任务书授权自行判断):琥珀实心叠金色纹理目检过花,改纯色;secondary 按钮保留底纹,目检协调(截图 04/07)。
3. **20px 显示尺寸下油画笔触不明显**,观感偏扁平线性——资产本身在缩小后的特性,非代码问题;选中态(蓝金)与未选中(米金)差异清晰可辨(02 截图 AI 目检)。
4. 12 个图标实测全部 64×64 RGBA,与任务书规格一致。
5. favicon 404 处理:加 `data:,` 空图标(浏览器行为,非资产问题)。
6. **环境备注(不影响交付)**:本地 8090 静态服务偶发请求停顿(Resource Timing 见过 tfb≈52s),造成图片请求间歇失败;排查后确认资产文件(PNG 魔数/字节数)、服务端代码、页面代码三方均无缺陷——直连下载字节完整、页面内加载成功、截图渲染正常。另:git-bash 下 `curl -o /dev/null` 会因写入失败(exit 23)得出假"0 字节",测量下载量需写真实文件。

## 验收对照(任务书九项)

1. 控制台报错=0 ✅ 2. 12 图标 naturalWidth>0 ✅ 3. 切页图标仍在 ✅ 4. 标题含 Georgia ✅ 5. 正文无 Serif ✅ 6. 轮询 10s 不重置 ✅ 7. 四页 scrollHeight=innerHeight ✅ 8. 悬停/选中差异可辨 ✅(02 目检) 9. 截图六类全覆盖 ✅(共 8 张)
