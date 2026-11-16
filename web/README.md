# Soda Agent 工作台（Web 看板）

浏览器里看 Agent Autoloop：谁在线、任务跑没跑、哪张卡片等你拍板、今天花了多少 Token。
不用再去命令行敲 `agent-autoloop status`。

## 启动

前台跑（调试用，Ctrl+C 停）：

```bash
export PATH="/c/Tools/node24:$PATH"          # Node 24
cd "$HOME/Desktop/Soda Intelligence - AI Native Thinking/Soda Office"
node web/server.js
```

后台常驻（不依赖任何会话，关终端也活着）：

```powershell
powershell -NoProfile -Command "Start-Process -FilePath 'C:\Tools\node24\node.exe' -ArgumentList '\"web/server.js\"' -WorkingDirectory 'C:\Users\Administrator\Desktop\Soda Intelligence - AI Native Thinking\Soda Office' -WindowStyle Hidden -RedirectStandardOutput 'C:\Users\Administrator\Desktop\Soda Intelligence - AI Native Thinking\Soda Office\web-server.log' -RedirectStandardError 'C:\Users\Administrator\Desktop\Soda Intelligence - AI Native Thinking\Soda Office\web-server.err.log'"
```

停掉：先 `netstat -ano | grep "127.0.0.1:8090.*LISTENING"` 找 pid，再
`powershell Stop-Process -Id <pid>`（git-bash 里 taskkill 的斜杠参数会被 MSYS 吃掉，用 PowerShell）。

然后开浏览器：<http://127.0.0.1:8090>

启动成功输出：

```
Soda Agent 工作台  http://127.0.0.1:8090
代理到中台        http://127.0.0.1:3350（owner key 已从 config.json 载入内存，不出服务端）
```

## 端口与配置

| 项 | 默认 | 改法 |
|---|---|---|
| 监听地址 | `127.0.0.1`（不对外） | 写死，本机工具 |
| 端口 | `8090` | 环境变量 `PORT=8081 node web/server.js` |
| 中台地址 / owner key | 从 `C:/Tools/agent-autoloop/config.json` 的 `url`、`owner` 读 | 环境变量 `AGENT_AUTOLOOP_HOME` 指到别的安装目录 |

## 架构（安全模型）

```
浏览器 ──► 本服务 127.0.0.1:8090 ──► Autoloop 中台 127.0.0.1:3350
             ↑ 持有 owner key，只在进程内存
```

- **本服务是动作白名单代理，不是透明转发。** 只开放 5 个接口，白名单外一律 404，前端无法借道访问中台其它端点。
- **owner key 不落前端**：key 只在服务端内存里，不写日志、不进错误响应。`/api/state` 返回前还做深度脱敏——任何字符串值含 key 片段即替换为 `[REDACTED]`（防御性，实测中台本身不回传 key）。
- **零依赖**：`node:http` + 全局 `fetch`，无 npm 包。

## 前端可用的接口

```
GET  /                    → 单页界面（index.html）
GET  /api/state           → 透传中台 /v1/state（已脱敏）
GET  /api/health          → { ok, autoloop }（探测中台 /healthz）
POST /api/cards/:id/answer   → body { choice: 选项下标 } 或 { text: "自由回答" }
POST /api/cards/:id/resolve  → body { reason: "不用决定了，因为…" }
POST /api/runs/:id/cancel    → body {}，停掉一轮
```

## 界面说明

- 顶部：中台在线状态（3 秒探一次 `/healthz`）、Agent 在线圆点、今天的轮数/Token/成本
- 「等你拍板」：待决定卡片，点选项即回答；也可填原因「不用决定了」（resolve）
- 任务列表：状态着色（完成 绿 / 进行中 蓝+呼吸 / 排队 灰 / 重试 橙 / 失败 红），可按状态筛选；进行中的任务可点「停」
- 底部：Agent 与通知通道的在线状态
- 每 3 秒轮询；页面切到后台自动暂停，切回立刻刷新；中台离线时显示横幅并自动重试，不白屏

## 注意事项

- 中台（`agent-autoloop`）得先跑着，否则页面显示「中台离线」。
- 回答/结案/停任务直接操作真实中台，没有二次确认——拍板前看清楚。
- 验收记录见 [VERIFY.md](./VERIFY.md)。
