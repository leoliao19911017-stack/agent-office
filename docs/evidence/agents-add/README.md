# 第一批验收 · agents 表 + 添加界面（G1–G7）

> 执行时间：2026-11-24 · 分支 `p0-foundation` · 服务 `127.0.0.1:8090`
> 证据文件：`acceptance.json`（机器可读）、`board-agents.png`（看板 6 张卡）、`add-agent-modal.png`（添加弹窗）

## 结论

| 项 | 结果 | 证据 |
|---|---|---|
| G1 看板有 `[+ 添加 Agent]` | PASS | `board-agents.png`；`#agent-add-btn` 文本实测 `+ 添加 Agent` |
| G2 API 类型加 Kimi，测试连接真跑 | PASS（测试连接） | `acceptance.json` 中 `Kimi K3 测试连接`：HTTP 200、`model=k3` |
| G3 加完出现在看板、能真发消息 | PASS（机制）/ Kimi 被上游订阅挡 | GLM 4.6 走同一添加流程，聊天返回 `收到`；Kimi 实测 403，见下 |
| G4 现有 4 个 id 不变、历史还在 | PASS | 迁移前后 tasks 21 / attempts 11 / threads 60 / turns 127 / events 89 一致；id `claude/codex/dsh/hermes` 原值 |
| G5 禁用后看板消失、数据保留 | PASS | 禁用后 status-v2 不含该 id；`/api/agents?all=1` 与聊天历史仍在 |
| G6 key 不进响应、不进 DB | PASS | 所有 HTTP 响应扫描无 key；`agent-office.db` + WAL + SHM 扫描 `containsKey=false` |
| G7 两处硬编码删除，改 DB | PASS | `AGENTS = new Set(...)` 与 state-machine 默认 `['claude','dsh','codex','hermes']` 均已删除；名册走 `listAgents(db)` |

## Kimi 的真实情况（必须说明）

本机 CC Switch 里的 `Kimi For Coding` key：

- 测试连接（`max_tokens=1`）**真发请求**，Kimi 返回 HTTP 200、`model=k3`，所以 G2 的测试连接按钮能过；
- 一旦真生成（`max_tokens≥2`），上游返回 **403**：
  `Your current subscription does not have access to Kimi Code right now. Upgrade your plan...`
- 换 `kimi-k2 / kimi-k3 / kimi-latest / moonshot-*` 和另一份 Kimi key 都一样；这是 Kimi 账号订阅状态，不是适配器代码。

因此生产库里同时留了两个 API Agent：

- `kimi-k3`（任务书指定的 Kimi，配置真实；等订阅恢复即可聊）
- `glm-46`（GLM 4.6，同一套 API 添加/测试/聊天流程，实测返回 `收到`，用于证明 G3 的代码路径可用）

如果老板不想在看板看到暂时不可用的 Kimi，可在「管理」里禁用；历史与配置保留。

## 关键实现

- `web/lib/db.mjs`：schema v3，新增 `agents` 表；迁移只 `INSERT OR IGNORE` 四个历史 id。
- `web/lib/agents.mjs`：名册读写、`chatSupport`、输出脱敏（`extra_env` 里的 KEY/TOKEN 一律 `[REDACTED]`）。
- `web/lib/secrets.mjs`：key 放 `data/secrets/agents.json`（0600，gitignore）；DB 只存 `api_key_ref`（`local:` / `ccswitch:` / `env:`）。
- `web/lib/api-provider.mjs`：Anthropic / OpenAI 兼容的测试连接 + SSE 流式聊天。
- `web/api-agents.mjs`：`GET/POST /api/agents`、`GET/PATCH /api/agents/:id`、`POST /api/agents/test-connection`、`POST /api/agents/:id/test`；API 类型必须持 10 分钟有效的 `test_token` 才能保存，令牌绑定 base_url/model/protocol/key 指纹。
- `web/chat/adapters/api-chat.mjs`：API Agent 聊天；历史由引擎回放，无原生 session。
- 看板：`web/board-agent-admin.js`（添加/管理弹窗，独立模块）；`web/board-cromma.js` 名册动态化，卡片随数量 2/3 列自适应。

## 复跑

```bash
# 离线单测（假上游，不花额度）
node --no-warnings --test test/agents.test.js test/chat-engine.test.js test/chat-http.test.js

# 生产服务
curl -s http://127.0.0.1:8090/api/agents?all=1
curl -s http://127.0.0.1:8090/api/agents/status-v2
```

## 备注

- 现有 4 个 Agent 的 `agent_id` 一个都没改；`attempts` / `chat_threads` 的历史引用不动。
- 迁移前备份：`E:/tmp/soda-live-backup/agent-office.db`（未入库）。
- 新增聊天轮次是本次验收产生（GLM 4.6 的 `收到` 与 Kimi 的 403 各一轮），所以验收后 threads/turns 比迁移前多 2。
