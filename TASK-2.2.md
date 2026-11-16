# Task 2.2 任务书 — 接入真实 Agent（Claude Code / Codex）

> 前置：Task 2.1 已完成（租约 + Claim Token，72 测试全过）
> 环境：**必须用 Node 22**（`C:/Tools/node22`），见 `ENVIRONMENT.md`

---

## 目标

Office 现在只能"假装"有 Agent —— 测试里手动调 `claimTask`。这一步要让它**真的能驱动 Claude Code 和 Codex 干活**。

完成后应该能做到：

```
在 Office 建一个任务
  → Claude Code 自动领走
  → 真实修改工作区文件
  → 全程心跳续约
  → 提交结果回到 Office
```

---

## 两部分

### A. Agent 客户端（`src/agent-client.js`）

给 Agent 用的 SDK，封装 Office HTTP API。**Agent 不直连数据库**（GPT 评审明确要求）。

```js
import { AgentClient } from './agent-client.js';

const client = new AgentClient({
  baseUrl: 'http://127.0.0.1:PORT',
  name: 'claude-code',
  type: 'claude-code',
  capabilities: ['code', 'test'],
});

await client.register();           // 注册（重名 409 视为已注册，继续）
const task = await client.claimNext();   // 领一个 queued 任务，没有返回 null
if (task) {
  await client.startHeartbeat();   // 每 15 秒续约（后台定时器）
  await client.reportEvent('start', { note: '开始改文件' });
  // ... 干活 ...
  await client.submit('done', { resultPath: '/runs/xxx/result.json' });
  client.stopHeartbeat();
}
```

**必须做到：**

1. `claimNext()` —— 拉 `GET /api/tasks?status=queued`，逐个尝试 `POST /api/tasks/:id/claim`，抢到返回任务（含 `claim_token`），全被抢走返回 `null`
2. `startHeartbeat()` —— `setInterval` 每 15 秒 `POST /api/tasks/:id/renew`，用 `unref()` 避免阻止进程退出
3. **心跳失败必须停手** —— 如果续约返回 `token_mismatch` / `lease_expired`，说明所有权已丢，**立刻设置 `lostOwnership = true` 并回调 `onLostOwnership`**，不能继续提交
4. `submit(status, {resultPath})` —— 带 token 调 `PATCH /api/tasks/:id/status`；如果已经丢了所有权，直接抛错，不发请求
5. `reportEvent(type, payload)` —— 上报事件
6. `stopHeartbeat()` —— 清定时器
7. `heartbeatHealthy()` —— 暴露心跳状态，供执行器判断

**`lostOwnership` 是硬要求**：GPT 评审原话「锁丢失后，原执行者必须立即停止新的浏览器动作」，这里同理 —— 丢了任务所有权就不许再干活。

---

### B. Runner（`src/runner.js`）

轮询 Office，领任务，调真实 CLI 执行，提交结果。

```js
const runner = new Runner({
  client,          // AgentClient 实例
  workdir: 'C:/path/to/workspace',   // CLI 在哪个目录干活
  executor: claudeExecutor,          // 或 codexExecutor
  pollIntervalMs: 3000,
});
await runner.start();
```

**执行器接口**（两个实现）：

```js
// 执行器签名：接收任务和上下文，返回 { ok, output, durationMs }
async function executor({ task, workdir, signal }) { ... }
```

**`claudeExecutor`** —— 调真实 Claude Code：

```
claude -p "<任务 title + description>" \
       --permission-mode bypassPermissions \
       --output-format json
```

**`codexExecutor`** —— 调真实 Codex：

```
codex exec "<prompt>" --cd <workdir> --json
```

**要求：**

1. 用 `child_process.spawn`，不用 `exec`（长输出会爆 buffer）
2. 捕获 stdout / stderr，超时（默认 15 分钟）就 `kill`
3. **执行期间心跳必须持续** —— 这是整个设计的关键，长任务不能因为没续约被回收
4. 执行完把输出写进 `<workdir>/runs/<task_id>/output.log`，`result_path` 指向它
5. 失败也要提交 `failed` 状态，**不能丢下任务不管**
6. **丢了所有权立刻停手** —— `onLostOwnership` 触发后 `kill` 子进程，不再提交

---

## 验收标准

### 单元测试 `test/agent-client.test.js`（至少 10 条）

用 `node:test` + 真实 HTTP（起真服务，`startServer({port:0})`），不用 mock：

1. `register()` 成功，重复注册不报错
2. `claimNext()` 领到任务，含 `claim_token`
3. 没有 queued 任务时 `claimNext()` 返回 `null`
4. 任务被别的 Agent 抢先时，`claimNext()` 换下一个，不报错
5. `startHeartbeat()` 后续约成功，`lease_expires_at` 变晚
6. **心跳发现 token 失效 → `lostOwnership` 变 true 且触发回调**
7. 丢了所有权后 `submit()` 抛错，**且不发 HTTP 请求**
8. `reportEvent()` 上报成功
9. `stopHeartbeat()` 后不再续约
10. 心跳间隔可配置（测试里设 50ms，验证真的每 50ms 续一次）

### 集成测试 `test/runner.test.js`（至少 6 条）

用**假的执行器**（不是真 CLI），验证 Runner 编排逻辑：

11. 领到任务 → 执行 → 提交 done，`result_path` 正确
12. 执行器返回失败 → 提交 failed
13. 执行器抛异常 → 提交 failed，错误写进 output.log
14. **执行 3 秒期间心跳持续，租约没被判定过期**
15. **执行中所有权丢失 → 子进程被 kill，不提交**
16. `stop()` 后不再领新任务

### 真实验证脚本 `verify-real-agent.mjs`

不是测试，是**手动跑的真实链路演示**：

1. 起 Office 服务
2. 建一个真实任务：「在 workdir 创建一个 hello.txt，内容为当前时间」
3. 真跑 `claudeExecutor` 让它执行
4. 检查文件真的被创建了
5. 打印任务终态和事件流

**这一步必须真跑通，不能只写代码。**

---

## 边界（不许做）

- ❌ 不做 Web 界面（Task 2.3）
- ❌ 不做自然语言编排（P2）
- ❌ 不改 Task 2.1 的租约逻辑
- ❌ 不新增 npm 依赖（零依赖原则）
- ❌ Agent 不许直连数据库，只能走 HTTP API（GPT 评审硬要求）

---

## 关键约束

**1. 心跳是长任务的生命线**

Claude Code 跑一个任务可能 5-15 分钟。租约 90 秒。**不做心跳，任务跑到一半就会被判 suspect**。

心跳必须在 `spawn` 之后、`await` 之前就启动，不能在执行完才续。

**2. 丢所有权必须真停手**

不是设置个标志位就完事 —— `onLostOwnership` 触发要 `kill` 子进程。否则旧进程还在改文件，新执行者也在改，破坏工作区。

**3. 输出必须落盘**

`<workdir>/runs/<task_id>/output.log`，不然出问题没法查。

**4. 真跑，不许模拟**

`verify-real-agent.mjs` 必须调真实的 `claude` 命令，不许假装。

---

## 报告格式

```
## Task 2.2 完成

改了什么：
- src/agent-client.js（N 行）
- src/runner.js（N 行）
- test/agent-client.test.js（N 个测试）
- test/runner.test.js（N 个测试）
- verify-real-agent.mjs

验证了什么：
$ node --test test/*.test.js
（真实输出，应为 72 + N 个）

$ node verify-real-agent.mjs
（真实执行记录：任务 ID、执行耗时、文件是否创建、终态）

还差什么：
```

**必须贴真实输出，不许说"应该能过"。**
