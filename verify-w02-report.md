# W02 验证报告：压缩审批说明视觉占用 + 右侧详情独立滚动

> 日期：2026-11-16 · 服务：http://127.0.0.1:8090（build r11c，静态文件按请求读盘）
> 场景：TEST-R11 需求（test-any-file 策略）第 3 步「开发计划」（awaiting + expects=plan），即任务图1场景
> 方法：CDP 直连 headless Chrome（Emulation.setDeviceMetricsOverride 精确视口 + Runtime.evaluate 取 getComputedStyle / getBoundingClientRect / scroll 尺寸 + Page.captureScreenshot），脚本 `verify-w02.mjs`，原始数据 `verify-w02-after.json`，基线 `verify-w02-baseline.json`，截图 6 张

## 一、改了什么（只改 web/app.css，三处，备份 app.css.bak-w02b）

| 选择器 | 改动 | 原值 |
|---|---|---|
| `#insp-body` | 增加 `overflow-x: hidden`（原已有 `overflow-y: auto`） | overflow-x 默认 auto |
| `.ip-decide` | `padding: 16px`；`background: #24221E` | `padding: 14px 14px 12px`；`#24231F` |
| `.ev-src` | `margin: 12px 0`；`line-height: 19px`；`color: #A3B0BF` | `margin: 8px 0 0`；`1.6`（≈19.2px）；`var(--faint)`=#8996A8 |

说明文字内容（app.js decideHtml 的 policyNote）一字未动；未改任何 JS / HTML / 其他 CSS。

## 二、验证了什么（全部为 CDP 实测真实数值）

### 1. 右侧详情区几何与滚动（1440×900，桌面 in-flow 布局）

| 指标 | 实测值 | 规格 | 判定 |
|---|---|---|---|
| #inspector 宽×高 | 328 × **792**（x=1112, y=52） | 328 × 100vh−52−56=792 | ✅ |
| #insp-body overflow | x=hidden, y=auto | 同左 | ✅ |
| #insp-body client/scroll 高 | 748 / **1074**（可滚 326px） | scrollH>clientH | ✅ |
| #insp-body 横向 | scrollW 312 = clientW 312（零横向溢出） | 不横向溢出 | ✅ |
| .ip-decide | x=1129, y=203, w=280, h=640, padding=16px, radius=10px, bg=rgb(36,34,30)=#24221E | x1129–1424 / y203–845，16px / 10px / #24221E | ✅ |
| .ev-src | 12px / 19px / rgb(163,176,191)=#A3B0BF / margin 12px·12px，全文 127 字完整换行 | 同左，不删减 | ✅ |
| 文档级溢出 | docOverflowX=false, bodyScrollable=false | 外层不滚不争抢 | ✅ |

### 2. 三视口滚动到底，执行者 / 本步产物 / 上下游进入视口

| 视口 | 布局 | scrollTop/max | 执行者 | 本步产物 | 上下游 |
|---|---|---|---|---|---|
| 1440×900 | in-flow 328px | 326/326 | ✅ inView | ✅ inView | ✅ inView |
| 1280×800 | 覆盖层 fixed 360px（insp-open） | 387/387 | ✅ inView | ✅ inView | ✅ inView |
| 1100×768 | 覆盖层 fixed 360px（insp-open） | 419/419 | ✅ inView | ✅ inView | ✅ inView |

三视口审批文字均无水平溢出（evSrc 宽 244–276px 全部在卡内换行）。

### 3. 轮询滚动保持（1440×900，10 × ~3.2 秒，不切换需求）

滚至中部 setTo=163（max=326），10 个采样全部 163，零重置零漂移（withScroll 在 innerHTML 重建间保住位置）。

### 4. 视觉复核（截图）

- `verify-w02-1440x900-top.png`（未滚动）：审批卡顶部对齐 y=203，说明文字完整换行无横向溢出，滚动条可见；执行者/产物/上下游按原顺序排在折叠线以下（offsetTop 858/926/995 > clientH 748），决策卡底缘 843 贴近视口底 844。
- `verify-w02-*-scrolled.png`（滚到底）：三区全部可见。

## 三、还差什么 / 如实说明

- **独立纵向滚动在改动前就已生效**（基线实测 scrollH=1033 > clientH=748，`#insp-body` 本就是 flex 链上的 `overflow-y:auto`）。任务原文「若右侧没有独立滚动」是条件句；本次实际补齐的是其余规格差距项：`overflow-x:hidden`、行高 19px、颜色 #A3B0BF、段距 12px、卡内边距 16px、底色 #24221E。
- 已知无害现象：1280/1100 视口测量时 decide.y 为负（−103/−184），是上一视口滚动测试的残留 scrollTop 经轮询 withScroll 恢复、压过了 selectTask 归零的既有竞态，与 W02 改动无关（反证滚动保持有效）。
- 产物清单：`verify-w02.mjs`、`verify-w02-after.json`、`verify-w02-baseline.json`、`verify-w02-after.log`、6 张截图、本报告（md/html）。
