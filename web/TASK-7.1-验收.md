# TASK-7.1 工作台三栏骨架（V2.0）验收报告

- 任务：重写 `web/index.html` 为三栏工作台骨架（布局/数据/交互正确，纯色，无背景图）
- 日期：2026-11-13
- 结论：**23 项验收全过 / 0 失败**，另发现并修复 1 个 CSS `hidden` 失效 bug
- 服务：127.0.0.1:8090（后台常驻），数据源 /api/state + /api/health + /api/office/flow

## 改了什么

| 文件 | 改动 | 字节数 |
|---|---|---|
| `web/index.html` | 整页重写：顶栏 56 + 导航 60 + 需求列表 248 + 中央交付链自适应 + Inspector 320 + 底栏 28；≤1280 Inspector 收起、≤1024 需求列表/Inspector 二选一；EaseDraw 专注抽屉 720px 可拖 480–1000 | 52112 |
| `web/server.js` | 仅新增 `POST /api/office/file-check`（statSync 核实产物存在性 + 实测字节，一次最多 200 条）；现有 /api/* 一律未动 | 16247 |
| `web/verify-assets/verify-7.1.mjs` | 新增 CDP 验收脚本（零依赖，Node22+ 原生 WebSocket） | 14912 |

关键实现口径：

- **4 阶段投影**：定义{req,doc} / 生产{plan,brief,run} / 验证{deliverable,verify} / 交付{final}，未知 key 按比例落列；步骤卡按阶段成 4 列，阶段头带「已完成 x/x」计数。
- **待决策判定**：`status==='awaiting'` 或 `gate===true && status==='pending'`；顶栏琥珀胶囊 0 个时隐藏。
- **状态语义分开**：Agent 连接（心跳 120s → 在线/僵死/离线）与干活状态（执行中/排队/空闲）互不冒充。
- **轮询不重置 UI**：渲染幂等于 data+ui（taskId/stepKey/view/search），`withScroll` 保滚动位置，`ensureSelection` 优雅回退。
- **产物核验**：前端收集路径集合做指纹，变化才 POST file-check；实测字节替换登记字节；`exists:false` 标红「文件不存在」。

## 发现并修复的 bug（本轮验收截图揪出来的）

`#settings-pop` 规则里 `display:flex` 盖掉了 `hidden` 属性的 UA 样式（作者样式优先于 UA 样式），导致设置弹层**从加载起永远悬浮在 Inspector 右上角，点外部关不掉**——属性探针显示 `hidden:true` 但 `computedDisplay:"flex"`、像素实测弹层区域 #171D26 深色。`#tb-decision` 胶囊同病（0 待决策时会留空琥珀壳）。修复：补 `#settings-pop[hidden]{display:none}` 与 `#tb-decision[hidden]{display:none}`。修复后像素复核弹层区域为纸色 #F1EADB，验收 23/0 重跑通过。

## 验证了什么（真实输出）

验收① 1440×900 单屏：需求列表/4 阶段/7 步骤卡/Inspector 全部在视口内；4 列确认。
验收② `scrollHeight=900 = innerHeight=900`，整页无纵向滚动条。
验收③ 概览行点击 → 回交付链 `view=chain taskId=OFFICE-V3`（数据仅 1 个需求，与需求卡同一 selectTask 路径）。
验收④ 步骤卡选中 → Inspector 显示 STEP 05 交付物 / Hermes / 3 个产物（50.9 KB、4.4 MB、3.7 MB 实测字节）/ ↑↓ 上下游。
验收⑤ 10.5 秒（≥3 轮轮询）后选中步骤/需求/Inspector 全部保持。
验收⑥ 专注抽屉 720px 滑出，iframe load 触发（luckyandease.com/easedraw/），关闭 display:none 保留 DOM，重开不重建。
异常：Runtime.exceptionThrown / console.error / `__uiErrors` 全 0。
标红分支：注入 `exists:false` → 「✗ index.html 文件不存在」出现，还原后消失（分支有效，当时数据无天然缺失文件）。

## 截图（修复后重生成）

- `web/verify-assets/v71-normal.png`（77803 B）
- `web/verify-assets/v71-step-selected.png`（77864 B）
- `web/verify-assets/v71-focus-mode.png`（802605 B，EaseDraw 实渲染）

## 还差什么

- 数据只有 1 个需求（OFFICE-V3），多需求切换只能靠同路径的概览行点击间接验证；有第二个需求后建议复跑验收③。
- 梵高风皮肤、点击产物打开文件等是后续任务，本轮骨架不含。
