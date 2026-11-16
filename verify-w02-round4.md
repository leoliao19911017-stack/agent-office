# W02 第 4 轮验证报告 — 右侧详情独立滚动

日期：2026-11-16 ｜ 环境：http://127.0.0.1:8090 ｜ 方法：CDP 直连 headless Chrome（--headless=new），`Emulation.setDeviceMetricsOverride` 锁视口，`Runtime.evaluate` 取 getComputedStyle / getBoundingClientRect / scrollHeight / clientHeight，像素检验为纯 Node 解码 PNG（zlib inflate + 扫描线去滤镜）。

数据文件：`tmp-w02-round4-baseline.json`（三视口基线）、`tmp-w02-center.out`（中央跟随测试）、`tmp-w02-inspclip-1440.png`（滚动条像素证据裁片）。

## 一、改了什么

**本轮 0 行代码改动。** 先补测后判断：三视口逐项实测显示规格字面项在当前 `web/app.css` 上已全部成立，按「只改这一处不动别的」的要求，不再叠加改动。前三轮的改动（`.bak-w02` → 当前）diff 复核确认全部限于 W02 范围（#insp-body overflow、说明文字 12/19/#A3B0BF、审批卡 #24221E/16px/10px、1100 断点、上下游状态色），≤1100px 时 #reqs 抽屉化是第 1 轮之前就存在的旧逻辑，前三轮未动。

## 二、验证了什么（全部为真实实测值）

### 1. 面板几何（三视口）
| 视口 | #inspector | #insp-body clientH / scrollH | 可滚 |
|---|---|---|---|
| 1440×900 | x1112 y52 w328 **h792**（=900−108）| 748 / 1386 | ✅ |
| 1280×800 | x952 y52 w328 **h692**（=800−108）| 648 / 1386 | ✅ |
| 1100×768 | x772 y52 w328 **h660**（=768−108，static 常驻非抽屉）| 616 / 1386 | ✅ |

`overflow-y:auto; overflow-x:hidden`，scrollW312=clientW312 → 无横向溢出；document.body 无整页滚动。

### 2. 说明文字与审批卡样式（三视口一致）
- .ev-src：font-size **12px** / line-height **19px** / color **rgb(163,176,191)**=#A3B0BF / 段落间距 **12px**
- .ip-decide：background **rgb(36,34,30)**=#24221E / padding **16px** / border-radius **10px**

### 3. 滚到底三区可见（scrollTop = scrollTopMax）
| 视口 | 滚动位置 | 执行者 | 本步产物 | 上下游 |
|---|---|---|---|---|
| 1440×900 | 638/638 | ✅ inView | ✅ | ✅ |
| 1280×800 | 738/738 | ✅ | ✅ | ✅ |
| 1100×768 | 770/770 | ✅ | ✅ | ✅ |

### 4. 轮询滚动保持（1440×900，10 次 × ~3.2s）
设定 scrollTop=319 → 10 个样本全部 **[319×10]**，无自动归零。

### 5. 滚动条真实可见（回应「截图不能确认右侧是否支持独立滚动」）
- 布局级：#insp-body offsetWidth **327** − clientWidth **312** = **15px** —— 经典常驻滚动条占据布局空间（overlay 式滚动条差值为 0）。
- 像素级：解码 `tmp-w02-inspclip-1440.png`（336×500 裁片），x321–335 竖条带内 track **rgb(252,252,252)×4228px** + thumb **rgb(139,139,139)×1455px**，与正文背景 rgb(36,34,30)/rgb(25,26,28) 完全不同 —— 截图中滚动条确实渲染在画面上。

### 6. 右侧滚动不带动中央（本轮新测）
三视口各做：右栏 scrollTop 0→400 并派发 WheelEvent(deltaY 300) 前后对比 —— window.scrollY / documentElement.scrollTop / body.scrollTop 全程 **0**，#center scrollTop/left 全程 **0**（#center scrollHeight==clientHeight，中央本就不可滚），三视口 centerUnmoved 均为 **true**。

### 7. 信息完整性
DOM 结构 dump（tmp-w02-probe.out）：顺序保持「审批对象 → 测试策略 → 材料核对 → 备注 → 操作按钮 → 执行者 → 本步产物 → 上下游 → 备注」，测试策略段（h114，约 6 行）完整存在，无删文缩水。

## 三、还差什么 / 需要 Leo 决策

1. **数据漂移（非布局问题，但影响观感）**：前三轮改 app.css 使其实测 91.3KB ≠ 登记 78.5KB，系统校验自动渲染 172px「材料不一致」警示块，审批卡因此高 952px。这是产物登记数据过期，不是布局缺陷。若把登记大小刷新为实测值，警示块消失、首屏占用进一步缩小 —— 是否更新登记数据请拍板（超出 W02 范围，未动）。
2. 任务方上一轮引用的「审批卡到 y802、执行者 y823」对应的是无警示块时的数据状态；当前带警示块状态下执行者首屏 y≈1170，按规格靠右栏内滚到达（第 3 项已验证滚到底全可见）。
