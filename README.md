# Soda Office

Agent 编排工作台：让一台机器上的多个 AI Agent（Claude Code、Codex、DSH、Hermes）**被看见、可调度、能交接**。

## 当前进度

- **Task 1.1 项目骨架** ✅ — ESM 骨架 + SQLite schema（agents / tasks / events）+ 数据库层 + 测试
- Task 1.2 Agent 注册与状态（未开始）
- Task 1.3 任务提交与领取（未开始）
- Task 1.4 事件流（未开始）

## 环境

- Node >= 20（本机 v20.19.2），ESM（`"type": "module"`）
- 数据库 `node-sqlite3-wasm`（纯 WASM，本机无 C++ 工具链也可安装）

## 跑测试

```bash
npm test
```

## 目录

```
src/    数据库层（db.js：初始化 + 建表 + Agent 增查）
test/   node:test 测试
docs/   schema 说明等文档
```

Schema 细节见 [docs/schema.md](docs/schema.md)。事件与状态口径对齐同目录 `../soda-agent-workspace`。
