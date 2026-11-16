# TASK-4.1 UI 验收报告（星月夜改造）

- 验收对象：`http://127.0.0.1:8090` Worker 工作台
- 验收日期：2026-11-13
- 改动文件：`web/index.html`（重写 CSS 与 hero 结构，JS 零改动）、`web/server.js`（新增 /assets/ 静态路由 23 行，其余 API 逻辑一行未动）、新增 `web/assets/` 三图
- 服务进程：验收时为临时后台任务；验收完成后已交接为持久实例（另一会话以 `PORT=8090 node web/server.js` 启动，输出重定向到仓库根 `web-server-8090.log` / `web-server-8090.err.log`，pid 24896）。交接后复测：`GET /` 200、`/api/health` `{"ok":true,"autoloop":true}`、三图 200

三张图（真实路径与字节数，`ls -la` 实测）：

| 图 | 路径 | 字节 | 尺寸 |
|---|---|---|---|
| 星空 hero | `web/assets/starry-hero.png` | 3,420,702 | 2400×640 |
| 画布肌理 | `web/assets/canvas-texture.png` | 420,762 | 512×512（无缝化） |
| 金色星光 | `web/assets/golden-star.png` | 80,459 | 512×512（透明底） |

---

## 9.1 逐条验收

### 9.1.1 首页 HTTP 200 ✅

```
$ curl -s -o /dev/null -w "GET / → HTTP %{http_code}\n" http://127.0.0.1:8090/
GET / → HTTP 200
```

服务重启后（后台任务 b306jh8xm）复测同样 200。

### 9.1.2 三张图存在且 >10000 字节 ✅

```
$ ls -la web/assets/*.png
assets/canvas-texture.png 420762B
assets/golden-star.png     80459B
assets/starry-hero.png     3420702B
```

三张均远大于 10000 字节。

### 9.1.3 三图 HTTP 200 + image/png ✅

```
$ curl -sI http://127.0.0.1:8090/assets/starry-hero.png   | grep -iE '^(HTTP|content-type)'
HTTP/1.1 200 OK content-type: image/png
$ curl -sI http://127.0.0.1:8090/assets/canvas-texture.png | grep -iE '^(HTTP|content-type)'
HTTP/1.1 200 OK content-type: image/png
$ curl -sI http://127.0.0.1:8090/assets/golden-star.png    | grep -iE '^(HTTP|content-type)'
HTTP/1.1 200 OK content-type: image/png
```

实体完整性抽查（GET 下载 golden-star.png）：

```
$ curl -s http://127.0.0.1:8090/assets/golden-star.png -o golden-check.png && ls -la golden-check.png
golden-star body bytes: 80459        # 与磁盘文件逐字节一致
```

路径穿越防护（回归）：

```
$ curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8090/assets/../server.js   → 404
$ curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:8090/assets/..%2fserver.js" → 404
```

### 9.1.4 页面显示新风格 ✅（浏览器目视证据）

在用户 Chrome（pid 2780，独立窗口「Soda Agent 工作台」）打开 `http://127.0.0.1:8090/`，
用 cua-driver `get_window_state` 截图（capture_71824e99…0000）目检：

- 星空 hero：右侧 60% 梵高旋涡 + 金星清晰可见，左侧 40% 深蓝渐变上叠加
  「SODA INTELLIGENCE / Agent 工作台 / 星夜之下，Agent 们各自赶路；需要你拍板的事，会亮成金星。」
- 蓝金配色：body 深蓝 #0C1730，卡片 #172845，金色仅出现在 kicker「SODA INTELLIGENCE」、
  「5 待处理决策」计数与星光角饰；成功绿 / 失败红 / 运行蓝与文字标签并存
- 数据全部为 HTML 文本：21 条任务表格、Agent 面板（4 在线）、渠道（桌面通知/飞书）、
  页脚「数据来自 Agent Autoloop · 每 3 秒自动刷新」——UIA 可访问性树同样能读到这些文本，
  证明动态数据没有画进图片
- hero 放大目检（zoom 700-1200×40-300 区域）：旋涡笔触与金星渲染正常，无破图占位符

### 9.1.5 数据一致性（代理 == 中台直连）✅

`agent-autoloop` CLI 在本会话不可用（PATH 无命令；直接跑 `app/bin/agent-autoloop.ts status`
报「还没装好：先运行 agent-autoloop init」——不愿跑 init 动线上状态），改用更源头的验证：
node 脚本同时取 `http://127.0.0.1:8090/api/state`（代理）与 `http://127.0.0.1:3350/v1/state`
（直连，owner key 只进内存不打印），剔除动态字段 `seq`/`now` 后 deep-equal：

```
EQUAL after removing seq,now
agents online: 4/4 (claude, codex, claude-readonly, image-gen)
runs: 21, all done
spending today: 514935 tok / $4.34314
```

（对比脚本 /tmp/cmp-state.mjs；本轮停机恢复后中台 seq 继续单调递增，代理随之同步。）

### 9.1.6 停中台 → 显示「中台离线」，恢复后自动回连 ✅

前置安全检查：`running: 0 queued: 0`（空闲窗口才动手）。
中台由计划任务 `agent-autoloop-56d82ec9` → wscript → `app/host/background.js` 守护，
进程死后 background.js 10 秒内自动拉起，因此测试窗口安全可控。

```
$ powershell -NoProfile -Command "Stop-Process -Id 32920 -Force; 'killed'"
killed

$ curl -s -w "\nHTTP %{http_code}\n" http://127.0.0.1:8090/api/state | head -3
{"error":"中台不可达（http://127.0.0.1:3350）：ECONNREFUSED","code":"HUB_UNREACHABLE"}
HTTP 502
```

同秒对 Chrome 窗口截图（capture_…0001）：页面顶部出现红底横幅
「⚠ 中台离线 — 正在重连，数据可能滞后。请检查 Autoloop 中台（127.0.0.1:3350）是否在运行。」，
hero/表格保持渲染、不是白屏。

自动恢复验证：

```
t=3s {"ok":true,"autoloop":true}          # background.js 已拉起新中台
$ netstat -ano | grep ':3350.*LISTEN'
  TCP 127.0.0.1:3350 ... LISTENING 40548
$ cat C:/Tools/agent-autoloop/up.pid
40548                                     # 新 pid 已写入（硬杀残留的旧 pid 被锁检测正确处理）
```

恢复后再次截图（capture_…0002）：横幅消失，顶部回到「● 中台在线」，统计与表格恢复刷新。
卡片回答、取消任务等按钮本次未实际点击（无待处理卡片可答），但其 JS 处理函数与服务端
5 个 API 路由一行未动，风险面为零；9.1.5 的一致性对比已覆盖 /api/state 全量字段。

### 9.1.7 对比度 ≥4.5:1 ✅（WCAG 2.x 相对亮度公式实算）

node 逐对计算（正文/辅助/弱化/三态色/金 on 表格底 #101D35 与卡片 #172845）：

```
PASS 15.02 正文 F5F2E9 / 表格底 101D35
PASS 13.16 正文 F5F2E9 / 卡片 172845
PASS 15.89 正文 F5F2E9 / hero左侧 0C1730
PASS 11.07 辅助 C4D3E8 / 表格底 101D35
PASS  9.70 辅助 C4D3E8 / 卡片 172845
PASS  7.99 弱化 9FB5CE / 表格底 101D35
PASS  9.64 成功 80D69F / 表格底 101D35
PASS  7.43 失败 FF8B85 / 表格底 101D35
PASS  8.61 运行 79C1F5 / 表格底 101D35
PASS 11.06 金 F4CD72 / 表格底 101D35
PASS  9.69 金 F4CD72 / 卡片 172845
```

11 对全部 ≥4.5:1，最低 7.43（失败红 on 表格底）。
字号红线复查（grep font-size）：正文/表格单元格 14px、卡片标题 15px、hero 副题 14px；
辅助类（表头、状态徽标、按钮小字、hint、页脚）12–13px，无 <12px 文本。

---

## 红线自查

| 红线 | 结果 |
|---|---|
| 动态数据不进图片 | ✅ 全部 HTML 文本 + CSS；图片只做 hero 背景、全页肌理（opacity .04）、卡片角饰（opacity .24，pointer-events:none） |
| 表格零纹理、正文≥14px、辅助≥12px、≥4.5:1 | ✅ table 有不透明背景 #101D35 盖住 body::before 纹理层；字号/对比度见上 |
| 金≠成功 | ✅ 成功绿/失败红/运行蓝三态各有圆点图标 + 中文文字（运行中/成功/失败/重试中），金色只用于品牌 kicker、待决策计数、角饰与 hero |
| 不破坏现有功能 | ✅ JS 与 5 个 API 路由零改动；/api/state 轮询、断线横幅、自动重连全部实测通过（9.1.5/9.1.6） |

加分项：hero 用 `cover + right center`，1366/1440/1920 宽度下都是右侧裁切、左侧文字区完整；星光角饰 88×88 且 pointer-events:none，不挡任何按钮。

## 坑（如实记录）

1. **纹理 v1 有大亮斑**：生图首轮右下角出现星云状亮团，平铺会成格子 → prompt 加强「绝对禁止亮斑/星云/漩涡」后重生成 v2 合格。
2. **星图「白底」假象**：Read 工具把透明渲染成白，误判有白底 → PowerShell 读四角像素 A=0 证明原本透明；仍跑了饱和度白底剥离（顺带清掉低饱和光晕），棋盘格目检合格。
3. **curl -I 是 HEAD**：assets 路由最初只匹配 GET，HEAD 404 → 路由加 `|| method === 'HEAD'`，`res.end(method === 'HEAD' ? undefined : buf)`。
4. **image-gen.js 汇报不准**：IMG2 完成行打印的是 hero 的路径/字节数 → 一律以 `ls -la` 实际文件为准。
5. **PS 5.1 中文注释炸语法**：无 BOM UTF-8 被按 ANSI 读 → 后处理脚本全英文注释。
6. **agent-autoloop CLI 未装**（见 9.1.5）→ 用代理 vs 直连对比替代。
7. **cua-driver 浏览器 consent 拒绝**：绑定既有 Chrome 需要 host 授权（--grant existing-profile）→ 改用 `launch_app` 打开页面 + `get_window_state` 截图/UIA 树目检，同样拿到证据。
8. **git-bash 双斜杠坑**：`taskkill //F //PID` 报「无效参数」，第一次没杀成（中台还活着，/api/state 仍 200，未造成影响）→ 改 PowerShell `Stop-Process -Force`。
9. **8090 端口被无关 python -m http.server（pid 24272）占通配地址**：node 绑 127.0.0.1 特定地址成功，127.0.0.1 请求路由到 node（未动 python 进程）；后台服务任务两次到达时限被杀，最终由另一会话接力为持久实例（日志落 `web-server-8090.log`），交接后复测全绿。
10. **验收后中台又重启过一次（02:59Z，up.log 可见 worker started + listening）**：非本任务操作（本任务的停机测试在 02:26Z 且当时已恢复）。重启间隙代理对浏览器轮询正确返回 8 次 502（`web-server-8090.err.log`），恢复后自动回连——断线行为在生产路径上又被无意复验了一遍。
