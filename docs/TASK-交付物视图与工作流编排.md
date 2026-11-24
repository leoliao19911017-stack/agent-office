# 开发任务清单：交付物视图 + 工作流编排 + 清理归档

> Leo 2026-11-24 口述。核心一句：**「我不会关心它调用什么工具，我只关心它的交付物。」**
> 这是产品视角的纠偏：现在看板全是工具调用/进程/额度，老板要看的是「东西做出来没有」。

---

## 零、产品视角的根本转变

**现在看板给的：** 工具调用次数、进程探测、额度和证据源、token 数。

**老板要看的是交付物：**

```
① 讨论出的需求文档
② 交付出去的开发指令/任务书
③ 任务发出之后完成到哪一步了
④ 最终完成的成果
⑤ 评审报告和改进建议
⑥ 目标达成情况（如果设定了目标）
```

**推论：看板主视图必须从「Agent 状态」变成「任务及其交付物」。**
Agent 状态是操作层信息，交付物是结果层信息。老板看结果。

---

## 任务一：交付物视图（最高优先级）

### 1.1 数据模型

```sql
-- 交付物：任务的产出物，可追溯、可打开、可存档
CREATE TABLE IF NOT EXISTS deliverables (
  deliverable_id TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL,
  attempt_id     TEXT,
  kind           TEXT NOT NULL,   -- requirement | task_spec | dev_output
                                  -- | artifact | review | retro | goal_report
  title          TEXT NOT NULL,
  path           TEXT,            -- 仓库内相对路径（可点开看）
  content_ref    TEXT,            -- 或 DB 内引用
  status         TEXT NOT NULL,   -- draft | submitted | accepted | rejected
  created_by     TEXT,            -- agent_id
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(task_id)
);
```

### 1.2 各类交付物的来源（必须真实，不许编）

| kind | 从哪来 | 真实路径示例 |
|---|---|---|
| `requirement` | 需求讨论文档 | `docs/产品需求-AgentOffice.md`、`docs/TASK-*.md` 的开头段 |
| `task_spec` | 派给 agent 的任务书 | `docs/TASK-转盘与Agent可添加.md`、`C:\Tools\agent-autoloop\claude-*.txt` |
| `dev_output` | agent 写出的代码/文件 | git commit + 改动文件列表 |
| `artifact` | 生成物（截图/报告/文档） | `docs/screenshots/**`、`docs/evidence/**` |
| `review` | GPT 评审文档 | `C:\Tools\agent-autoloop\*-answer.md`、`office-r*-raw.txt` |
| `retro` | 复盘/改进建议 | 评审文档的「结论」段 |
| `goal_report` | 目标达成 | tasks 表的 acceptance 字段 + 验收结果 |

**关键：全部从已有真实文件/记录推导，不新增人工填写。**

### 1.3 界面

```
左侧任务列表（现有）
  点一个任务 →
中间主区变成「这个任务的交付物时间线」：
  ┌─────────────────────────────────────┐
  │ 任务：转盘视图 + Agent 可添加          │
  │ 目标：中央转盘，工具级采集              │
  │ 状态：进行中 4/6                      │
  ├─────────────────────────────────────┤
  │ ① 需求文档    docs/TASK-转盘...md  ✅ │
  │ ② 开发指令    claude-dial-p2.txt   ✅ │
  │ ③ 执行进度    第二批 完成 第三批 待做  │
  │ ④ 交付成果    b6c2955 改了 12 个文件  │
  │ ⑤ 评审报告    待生成                  │
  │ ⑥ 目标达成    24/24 通过              │
  └─────────────────────────────────────┘
右侧保留 Agent 对话面板
```

### 1.4 验收

```
D1  点任务，中间显示交付物时间线，6 类都有位置
D2  每类交付物可点开（能跳到文件内容或 diff）
D3  没有的类别显式写「未产生」，不是空着
D4  用真实历史任务验证：Agent Chat P1-P7 六批应有完整交付物链
D5  工具调用数据不在主视图（可以折叠到「技术细节」里）
```

---

## 任务二：目标达成情况

**已有：** `tasks.acceptance` 字段（验收标准）+ checkpoint 记录。

**要加：**

```
任务详情页顶部显示：
  目标     从 acceptance 字段读
  达成度   已通过检查点 / 总检查点
  差距     未通过项列表
  判定     achieved | partial | missed | no_goal
```

**没有设目标的任务，显式写「未设定目标」，不编百分比。**

---

## 任务三：任务手动删除 / 归档

**Leo 原话：「任务列表要支持手动删除归档」。**

```
任务行 hover → 出现「归档」按钮
点归档 → 二次确认「归档后从主列表移除，可在归档区恢复」
       → status 改成 archived，不进统计
归档区：设置页或列表底部「已归档 N 条」，可恢复
真删除：只有归档区里能删，二次确认 + 明确「不可恢复」
```

**批量归档：** 多选 → 归档，用于清理 TEST-* 和跑完没标结束的历史残留。

---

## 任务四：EaseDraw 集成位置修正

**Leo 原话：「EaseDraw 的集成区域不对，仅在 Agent 转盘这块中间区域显示即可。」**

```
现状   顶部胶囊「看板 / EaseDraw」切换整个页面
要求   只在中央转盘那块区域内切换
       转盘上方胶囊：Agent 状态 ⇄ EaseDraw
       左右栏不动
```

**这个和第三批（转盘区切换）是同一件事，一起做。**

---

## 任务五：Hermes Logo 换成老板给的图

**已做（我刚完成）：**

```
源图   447×447 黑白漫画少女（Leo 提供）
处理   去 3% 黑框 → 生成 48/96/192px
       打包成 hermes.svg（内嵌 192px PNG，37401B）
备份   旧翅膀版 → web/icons/old/hermes-wing-official.svg
```

**待验证：** 看板卡片里 44px 圆形显示是否清楚（黑白图在白色卡片上可能边界不清，需要加浅灰描边或底色）。

---

## 任务六：继续未完成的工作流编排

**Leo 原话：「你还要继续之前没完成的工作流的编排」。**

**现状：**
```
docs/调研-自然语言编排.md        294 行，结论「引擎层可复用，口述→流程定义必须自写」
docs/工作流定义-coding-v1.md      161 行，含 archive 目录结构
docs/决定-形态二与Agent可添加.md   形态二定了，autonomy 要可配置
GPT 讨论                          已完成，结论：形态二 + 路线 C
```

**待做：**

```
① autonomy 配置落地（第四批，存 + 改，不做引擎）
② 工作流定义的数据结构（节点 / 边 / 人的审核点 / 打回路径）
③ 口述 → 工作流：先用最简单的方式打通
   老板说需求 → GPT/Claude 生成 workflow.json → 老板确认 → 存库
④ 不做执行引擎（那是后面的大工程，先让定义能存能改能看）
```

---

## 实施顺序（先做老板现在就要验的）

```
第一批  交付物视图 + 目标达成          ← 老板现在要看这个
第二批  任务归档/删除
第三批  转盘区胶囊切换（EaseDraw 挪进去）+ Hermes logo 验证
第四批  autonomy 配置 + 工作流定义结构
```

**每批：真跑 → 截图 → 登记 Agent Office → 单独 commit → 立刻报老板。**

---

## 铁律

```
- 交付物必须指向真实文件/记录，不许编造
- 没有的类别写「未产生」，不空着也不填假数据
- 主视图是交付物，不是工具调用
- 每批单独验收，不攒到最后
- 老板现在就要验，所以第一批必须快
```
