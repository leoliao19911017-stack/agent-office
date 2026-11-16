# TASK-3.1 验收报告 — Soda Agent 工作台

> 执行：Claude Code（写代码）· Hermes（验收）
> 日期：2026-11-12
> 结论：**验收通过**，附 2 个遗留阻塞

---

## 一、交付物

| 文件 | 大小 | 说明 |
|---|---|---|
| `web/server.js` | 10.4 KB | Node 服务，`node:http` 零依赖，代理 Autoloop |
| `web/index.html` | 19.7 KB | 单文件前端，内联 CSS/JS |
| `web/README.md` | 3.7 KB | 启动/停止说明 |
| `web/VERIFY.md` | 9.0 KB | Claude Code 自测记录 |
| `web/verify-assets/` | — | 在线/离线截图 |

---

## 二、验收结果（Hermes 独立复验，非采信 Claude Code 自述）

### ✅ 1. 启动 —— 通过

```bash
export PATH="/c/Tools/node24:$PATH"
powershell Start-Process -FilePath 'C:\Tools\node24\node.exe' \
  -ArgumentList 'web/server.js' -WorkingDirectory '<Soda Office>'
```

实测监听 `127.0.0.1:8090`，`curl /api/health` → `{"ok":true,"autoloop":true}`

### ✅ 2. 首页可访问 —— 通过

浏览器打开 `http://127.0.0.1:8090`，标题 `🐴 Soda Agent 工作台`，完整渲染。

### ✅ 3. 真实数据一致 —— 通过

页面显示与 `agent-autoloop status` 完全一致：

```
中台在线
Agent: Claude Code  Codex
排队 0 · 今天 2 轮 · 4.7 万 Token

#2  完成  codex  试一下  你选了绿色，试跑通过  3 小时前
#1  完成  codex  试一下  问了一个问题            3 小时前
```

`/api/state` 实测返回 3,236 字节，`totals.done=2`、`totals.usage.input=46943`，与 CLI 一致。

### ✅ 4. Agent 状态 —— 通过

两个 Agent 都是绿点在线，底部面板显示「今日完成 X 轮 · N 秒前活跃」。

### ✅ 5. 任务列表 —— 通过

#1、#2 都在，状态、Agent、规则、结果、相对时间齐全。

### ✅ 6. key 不泄漏 —— 通过

```bash
KEY=$(python -c "...config.json['owner']")
curl /api/state > wstate.json
grep -q "$KEY" wstate.json   # → 未命中
grep -q "$KEY" web/index.html # → 未命中
grep -q "$KEY" web/server.js  # → 未命中
```

三项全部干净。server.js 从 `config.json` 读取，只在服务端内存持有。

### ✅ 7. 零依赖 —— 通过

```bash
find web/ -name "node_modules" -o -name "package.json"
# → 空
```

### ✅ 8. 断线处理 —— 通过（实测强杀验证）

1. 杀掉 Autoloop 中台（PID 20928）
2. `/api/health` → `{"ok":true,"autoloop":false}`
3. 页面显示 **「中台离线」** + 黄色警告条「连不上中台服务。页面保持自动重试，恢复后自动刷新。」
4. **不是白屏，没有报错堆栈**
5. 重启中台后，页面**自动切回「中台在线」**，无需手动刷新

---

## 三、Hermes 发现并处理的问题

### 🔴 问题 1：8080 端口冲突（已解决）

Claude Code 报告了这个问题，我复验确认：

```
TCP  0.0.0.0:8080    LISTENING  38552   ← goal-os（C:\Program Files\nodejs\node.exe .\goal-os\web\server.js）
TCP  127.0.0.1:8080  LISTENING  43028   ← 工作台
```

**风险**：工作台一停，`127.0.0.1:8080` 流量被 goal-os 静默接管，浏览器看到的是 Soda AI Studio 登录页，会误判「工作台还在但坏了」。

**处理**：已把工作台改到 **8090**（`PORT` 环境变量本来就支持），goal-os 恢复独占 8080。

```bash
PORT=8090 node web/server.js
```

### 🟡 问题 2：Claude Code 用会话后台跑服务会被杀（已绕过）

它最初两次用会话后台启动，服务到时被停（第二次已是 2 小时上限），才改用 `Start-Process` detached 方式。**这个判断是对的。**

---

## 四、飞书通道（Leo 拍板 D2 的落地情况）

### 配置已完成

```json
// rules.json
"channels": { "feishu": { "name": "飞书", "answerers": ["ou_2948072d13067cf165b27500f3fa8c90"] } }
// config.json
"channels": { "feishu": { "key": "***", "user": "ou_2948072d13067cf165b27500f3fa8c90" } }
```

`agent-autoloop doctor` → **`● 飞书在线`**

### 已修复：lark-cli 版本导致卡片发不出

**原始故障**：
```
card 2 not sent: --content is not valid JSON: -
```

**根因**：Autoloop 硬编码调用 `C:\Users\Administrator\AppData\Roaming\npm\node_modules\@larksuite\cli\scripts\run.js`，该路径下是 **1.0.96**，不支持 `--content -` 从 stdin 读。而 `C:\Tools\node24\node_modules` 下那份才是 1.0.100。

**处理**：两份都升级到 1.0.100。

验证：
```bash
echo '{"text":"test"}' | lark-cli im +messages-send --user-id ou_294... --as bot --msg-type text --content -
# → {"ok":true,"data":{"message_id":"om_x100b606910fa90a0c325bf3aecd7ac4"}}
```
**这条测试消息真实发到 Leo 飞书了。**

### 🔴 未解决：飞书长连接被 Hermes 网关占用

**原始报错**：
```
another event bus is already connected to this app
(1 remote event connection(s) detected via API);
only one bus should run globally to avoid duplicate event delivery
```

**根因（已查证）**：
- Hermes 网关（`~/AppData/Local/hermes/.env`）和 Autoloop（`lark-cli auth status`）**用的是同一个飞书应用 `cli_aa3a20271b385d27`**
- 飞书规定：**一个应用的卡片点击只能有一个长连接监听器**

**这是平台物理限制，不是配置错误。**

**两个解法（需要 Leo 拍板）**：

| 方案 | 做法 | 代价 |
|---|---|---|
| **A. 给 Autoloop 单独建飞书应用** | `lark-cli config init --new`，扫新建应用，把 `app_id/secret` 换掉 | 需在开发者后台开机器人能力 + 订阅卡片交互，约 10 分钟 |
| **B. 让 Hermes 让出长连接** | 停 Hermes 网关的飞书长连接 | **不建议**，Hermes 就收不到消息了 |

**推荐 A。** 两个应用各管各的，互不干扰。

**当前状态**：飞书通道「在线」，但**卡片点击收不到**，卡片也发不出（因为发卡片需要同一通道的连接正常）。

---

## 五、遗留清单

| # | 问题 | 影响 | 需要谁 |
|---|---|---|---|
| 1 | 飞书长连接冲突 | 卡片发不出、点击收不到 | **Leo 拍板选 A 还是 B** |
| 2 | 工作台端口是 8090 不是 8080 | 文档需更新 | 已处理，README 待改 |
| 3 | `rules.json` 试跑规则指向 codex | 我临时改的 | 可改回 claude |
| 4 | 工作台没做 systemd/开机自启 | 重启电脑要手动起 | P2 |

---

## 六、当前运行状态

```
端口 8090  → Soda Agent 工作台（PID 39600，node24）
端口 8080  → goal-os（PID 38552，node20）—— 互不干扰
端口 3350  → Autoloop 中台（PID 38536）
```

**页面地址：http://127.0.0.1:8090**

---

## 七、结论

Claude Code 这次干得不错，尤其是：
- 主动发现了 8080 冲突并写进 VERIFY.md
- 两次服务被杀后改用 detached 方式，判断正确
- 没有把 key 泄漏到前端

**验收通过。** 剩下的飞书长连接问题不是代码问题，是应用复用的必然冲突。
