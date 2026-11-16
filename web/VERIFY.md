# VERIFY.md — TASK-3.1 验收记录

日期：2026-11-12 · 环境：Windows 10 / Node 24 / git-bash
以下全部是实际执行的命令与真实输出，未做美化。截图在 [verify-assets/](./verify-assets/)。

服务当前在跑（后台）：`node web/server.js`，PID 41852，监听 `127.0.0.1:8080`。

---

## 8.1 启动：`node web/server.js` 起得来，监听 127.0.0.1:8080 ✅

```console
$ export PATH="/c/Tools/node24:$PATH" && node web/server.js
Soda Agent 工作台  http://127.0.0.1:8080
代理到中台        http://127.0.0.1:3350（owner key 已从 config.json 载入内存，不出服务端）
```

```console
$ netstat -ano | grep -E ":8080\s+.*LISTENING"
  TCP    127.0.0.1:8080         0.0.0.0:0              LISTENING       41852
```

（`0.0.0.0:8080` 上另有一个监听者，见文末「坑 1」。）

## 8.2 首页：浏览器打开 http://127.0.0.1:8080 能看到界面 ✅

```console
$ curl -s -o /dev/null -w "HTTP %{http_code} / %{content_type}\n" http://127.0.0.1:8080/
HTTP 200 / text/html; charset=utf-8

$ curl -s http://127.0.0.1:8080/ | grep -o "<title>[^<]*</title>"
<title>Soda Agent 工作台</title>
```

Chrome 实际渲染截图：[verify-assets/online.png](./verify-assets/online.png)
（顶部状态条 / 等你拍板 / 任务表 / Agent 与通道面板全部可见。）

## 8.3 真实数据：页面数字与 `agent-autoloop status` 一致 ✅

```console
$ node --disable-warning=ExperimentalWarning C:/Tools/agent-autoloop/app/bin/agent-autoloop.ts status
等你 0 · 在跑 0 · 排队 0 · 今天做完 2
今天      2 轮 · 4.7 万 Token（1 轮没上报） · $0.00（1 轮没上报）
在线
  ● Claude Code  sky-20231019ynz
  ● Codex        sky-20231019ynz
最近几轮
  20:02 #2 做完了   试一下   你选了绿色，试跑通过
  20:02 #1 做完了   试一下   问了一个问题
```

`GET /api/state`（经工作台代理）关键字段：

```json
"spending": { "today": { "rounds": 2, "tokens": 47083, "cost": 0, "missingTokens": 1, "missingCost": 1 } },
"agents": [ {"id":"claude","name":"Claude Code","online":true},
            {"id":"codex","name":"Codex","online":true} ],
"runs": [ {"id":2,"state":"done","summary":"你选了绿色，试跑通过"},
          {"id":1,"state":"done","summary":"问了一个问题"} ]
```

对照：2 轮 ✓ · 4.7 万 Token ✓ · $0 ✓ · 两个 Agent 在线 ✓ · #1/#2 摘要一致 ✓。
页面顶部显示「今天 2 轮 · 4.7 万 Token · $0（部分轮次缺成本数据）」，与 CLI 的「（1 轮没上报）」同义。

## 8.4 Agent 状态：Claude Code 与 Codex 都是在线绿点 ✅

`state.agents` 两个 `online: true`（见 8.3），页面渲染截图 [verify-assets/online.png](./verify-assets/online.png) 顶部两枚绿点、底部 Agent 面板同绿点。

## 8.5 任务列表：能看到 #1「问了一个问题」、#2「你选了绿色，试跑通过」 ✅

见 8.3 的 `runs` 与 [verify-assets/online.png](./verify-assets/online.png) 任务表两行。

## 8.6 key 不泄漏：`/api/state` 返回里搜不到 owner key ✅

```console
$ curl -s http://127.0.0.1:8080/api/state -o /tmp/state.json
$ node -e "…读取 config.json 的 owner 与 /tmp/state.json 比较…"
state bytes: 3061
owner key substring of /api/state response: false
any 40+ char token-ish string: none
```

- owner key（43 字符）不是响应的子串；
- 响应里除 key 外也没有任何 40+ 字符的可疑凭据串；
- 服务端另有深度脱敏层：任何含 key 片段的字符串/字段名在返回前都会替换为 `[REDACTED]`（防御性，本次实测未触发）。
- 四个交付文件（index.html / server.js / README.md / VERIFY.md）实测均不含完整 key，也不含 key 的前/后 8 字符片段：

```console
$ node -e "…逐文件 includes 检查…"
web/index.html 含完整key: false | 含key前后8字符片段: false
web/server.js  含完整key: false | 含key前后8字符片段: false
web/README.md  含完整key: false | 含key前后8字符片段: false
web/VERIFY.md  含完整key: false | 含key前后8字符片段: false
```

## 8.7 零依赖：无 dependencies / 无 node_modules ✅

```console
$ ls web/
index.html  README.md  server.js  verify-assets/

$ ls web/node_modules
ls: cannot access '.../web/node_modules': No such file or directory

$ cat package.json   # 项目根，本任务未改动
  "dependencies": {},

$ node --check web/server.js && echo OK
server.js 语法 OK（node --check）
```

服务端只 import `node:http` / `node:fs` / `node:path` / `node:url` + 全局 `fetch`。

## 8.8 断线处理：中台停掉后页面显示「中台离线」，不白屏不报错 ✅

**先试了真停中台**：`Stop-Process -Id 13112`（当时的 `agent-autoloop up` 进程）。
结果：Autoloop 自带 supervisor（`app/host/background.ts`，pid 45144）在 1~2 秒内自动拉起新中台进程（pid 20928），造不出持续离线窗口，且硬停 supervisor 会破坏第三方系统的保活链，不做。

**改用等价方式**：起第二个工作台实例（同一份 `server.js`），`AGENT_AUTOLOOP_HOME` 指向一份 `url` 为 `http://127.0.0.1:9`（死端口）的测试配置，`PORT=8081`。代码路径与真实断线完全一致（`callHub` 连接被拒 → 502 → 前端离线渲染）。

```console
$ curl -s -m 8 http://127.0.0.1:8081/api/health
{"ok":true,"autoloop":false}

$ curl -s -m 15 -w "\n[%{http_code}]" http://127.0.0.1:8081/api/state
{"error":"中台不可达（http://127.0.0.1:9）：bad port","code":"HUB_UNREACHABLE"}
[502]
```

浏览器打开 `http://127.0.0.1:8081`（截图 [verify-assets/offline.png](./verify-assets/offline.png)）：

- 顶部红点 + 「中台离线」
- 红色横幅「⚠ 中台离线，连不上中台服务。页面保持自动重试，恢复后自动刷新。」
- 内容区明确提示「连不上中台，暂时没有数据；恢复后这里会自动填上。」
- 无白屏、无报错堆栈；恢复后自动回到正常视图（已在 8080 主实例验证）

测试完已停掉 8081 实例并删除测试配置。

---

## 接口的边界行为（额外验证）

| 请求 | 结果 |
|---|---|
| `POST /api/state` | 405 METHOD_NOT_ALLOWED |
| `GET /api/cards/1/answer` | 405 METHOD_NOT_ALLOWED |
| `POST /api/cards/abc/answer`（id 非数字） | 404 NOT_FOUND |
| `POST /api/cards/999/answer {"choice":0}` | 中台业务错误透传：`{"error":"没有这张卡片"}` 404 —— 证明转发真实到达中台 |
| `GET /api/../v1/state`（路径穿越） | URL 规范化后落白名单外，404 |
| `GET /v1/state`（直连中台路径） | 404，不能借道代理 |
| `POST {"choice":0,"text":"x"}`（双字段） | 400 INVALID_ANSWER |
| body 非法 JSON | 400 INVALID_JSON |

## 加分项

- **乐观更新**：点选项/「不用决定了」成功后卡片立即从列表移除，失败恢复按钮可重试（`web/index.html` 的 `onAnswer`/`onResolve`）。当前没有真实待答卡片可点，转发路径已由上表「没有这张卡片」一条证明通畅。
- **状态筛选**：任务区一排筛选按钮（全部/进行中/排队/重试/完成/失败，带计数），见在线截图。
- **成本显示**：显示中台真实上报的 cost；`missingCost=1` 时标注「部分轮次缺成本数据」，不编造估算值。

## 坑（给后来人）

1. **8080 端口已有别的服务**：Soda AI Studio（`goal-os/web/server.js`）绑 `0.0.0.0:8080`（pid 38552），本工作台绑 `127.0.0.1:8080`。Windows 允许特定地址绑定与通配绑定共存，本机访问实测路由到工作台（`<title>Soda Agent 工作台</title>` 为证）。**风险已实锤**：工作台进程一停，`127.0.0.1:8080` 的流量立刻被 goal-os 静默接管（实测返回其鉴权响应 `{"ok":false,"error":"请先登录"}`），浏览器里看是「页面变了」而不是「服务没了」。长期建议二选一：工作台换 `PORT=8090`，或 goal-os 让出 8080。**需要 Leo 拍板。**
   当时常驻启动方式见 README（PowerShell Start-Process 后台，日志 `web-server.log`/`web-server.err.log` 在项目根）。
2. **Autoloop 中台有 supervisor 保活**（`app/host/background.ts`），杀 `up` 进程会被秒级重启；想制造持续离线请用死端口配置，别硬停第三方链路。
3. git-bash 里 `taskkill //F //PID` 参数转义会失败（GBK 报错「无效开关」），用 `powershell Stop-Process` 代替。
4. git-bash 的 `/tmp` 是 MSYS 虚拟路径，Windows 原生 node 看不见（会解析成 `C:\tmp`），跨进程传路径要用真实 Windows 路径。
5. `runs[].usage` 可能为 `null`（如 #2），前端已容错显示。
6. `spending.today.missingTokens/missingCost = 1` 表示有轮次没上报用量，CLI 显示「1 轮没上报」；页面如实标注而不是假装有精确成本。

## 结论

TASK-3.1 验收 8 条全部通过，证据如上。交付物：`web/server.js`、`web/index.html`、`web/README.md`、本文件。
