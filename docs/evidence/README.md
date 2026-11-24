# 看板复刻 · 真实数据取证

生成时间：2026-11-24 01:57（本地）
页面：http://127.0.0.1:8090/board-cromma.html
服务：`PORT=8090 node --no-warnings web/server.js`（仓库根目录）

## 文件

| 文件 | 来源 | 说明 |
|---|---|---|
| `status-v2.json` | `GET /api/agents/status-v2` | 4 个 agent 的 availability / execution / task 三维状态 |
| `tasks.json` | `GET /api/tasks` | 10 个任务、19 个交付物，全部状态为 unknown（证据超 30 分钟窗） |
| `board-verify.json` | `scripts/verify-board-cromma.mjs` | 交互状态、颜色、字体、API 请求的自动取证结果 |

## 本次快照的关键事实

- Agent 4 个：`dsh` / `claude` / `codex` / `hermes`（API 实际返回 4 个，不是 5 个）。
- `codex.availability.available = false`，reason `cli_not_found`；执行态 `unknown`。
- `hermes.availability.available = null`，reason `no_self_report`；执行态 `unknown`。
- `claude.availability.available = true`，执行态 `unknown`（没有可信执行证据）。
- `dsh.availability.available = true`，执行态 `idle`。
- 10 个任务全部 `unknown`，原因均为观测链路失效（最近证据 100+ 小时前）。
- 累计交付物 19 个；步骤 done 33 / total 71。
- `/api/state` 只用于累计 token 输出/输入（`totals.usage`）；所有 agent / task 状态仍然来自 status-v2 与 tasks。

## 复跑

```bash
# 1. 起服务
PORT=8090 node --no-warnings web/server.js

# 2. 截图（默认 1936x1056）
node scripts/shot-board-cromma.mjs final 1936x1056

# 3. 交互 + 硬规矩取证
node scripts/verify-board-cromma.mjs > verify-board-final.json
```

`board-verify.json` 里 `hard.resourceAPIs` 列出页面实际发出的三个同源请求；`codex.offenders` 是空数组，表示 Codex 详情面板里没有绿色元素。
