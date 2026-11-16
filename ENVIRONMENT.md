# Soda Office 运行环境

## 必须用 Node 22

数据库驱动是 **Node 22 内置的 `node:sqlite`**，Node 20 没有这个模块。

```
node --version   # 必须 >= 22.5.0
```

本机 Node 22 装在 `C:/Tools/node22`（Node 20 原样保留在 `C:/Program Files/nodejs`，未覆盖）。

### 跑测试

```bash
export PATH="/c/Tools/node22:$PATH"
npm test
```

或者直接指定：

```bash
"C:/Tools/node22/node.exe" --no-warnings --test test/*.test.js
```

---

## 为什么换掉 node-sqlite3-wasm

原来的 WASM 驱动**不支持多进程共享同一个数据库文件**。

实测：8 个真实进程同时抢同一个任务，随机抛 `disk I/O error`（崩在打开连接后的第一次读）。全量测试 10 次挂 3 次。

定位过程：逐层排除只读 / 读写 / 建表 / 业务 SQL，最后定位到「打开连接后第一次读」。

**为什么之前没发现**：进程启动时间错开，从没真正同时冲线。必须用同步栅栏（每个 worker 就绪后写 `ready-<slot>`，父进程集齐 N 个再写 `go`）才会暴露。

替代方案实测：

| 驱动 | 多进程 | 结论 |
|---|---|---|
| `node-sqlite3-wasm` v0.8.61 | 随机 `disk I/O error` | ❌ |
| `better-sqlite3` v13.1.1 | 装不上（无 Visual Studio） | ❌ |
| `node:sqlite`（Node 22 内置） | 100 轮 × 8 进程零崩溃 | ✅ |

详细分析见 `docs/DB-技术选型问题.md`。

---

## 已知注意点

**`node:sqlite` 标为实验特性**，启动会打 `ExperimentalWarning`。所有脚本都加了 `--no-warnings`，不影响功能。

**API 与旧驱动不同**：`node:sqlite` 是 `db.prepare(sql).run(...)`，旧驱动是 `db.run(sql, params)`。
`src/db.js` 里的 `wrapDatabase()` 做了适配，业务代码一行没改。以后换驱动只改那个函数。
