# G01 第 4 轮验证报告（2026-11-16）

工具：`verify-g01r4.mjs`（CDP + headless Chrome，对 http://127.0.0.1:8090 实测）
数据：`verify-g01r4-baseline.json`（改前）/ `verify-g01r4.json`（改后）/ 截图 8 张（`verify-g01r4-{1440x900,1280x800}-p{1..4}-*.png`）
口径：TreeWalker 全 DOM 可见文本节点（每视口 6 个页面态，1440×900 与 1280×800 双视口，共 657+ 节点）逐个取 getComputedStyle 字号/行高/颜色，沿祖先链找实底色算 WCAG 对比度；clipX=省略号设计内截断（合规），escX=逃逸视口（不合规）。
硬规则：A 对比度 ≥4.5 · B 字号 ≥11px · C <12px 必须短标签 · D 无 alpha<1 透明弱化 · E 真文字不得用 #8996A8。

## 一、总判定

| 指标 | 改前（baseline） | 改后（after） |
|---|---|---|
| 硬违规节点 bad | **41**（workbench 14 · agentsList 5 · agentsDetail 5 · skills 7 · filesList 5 · filesPreview 5，@1440） | **0**（双视口全部页面态） |
| 逃逸视口 escX | 0 | **0** |
| 页面横向滚动 pageOverflowX | false | **false**（双视口 ×4 页全测） |
| 行间遮挡 overlap（名册/技能卡/文件行） | [] | **[]** |
| 档外辅助色节点 offtier（信息性） | 189 | 121（余量为标题/正文/控件/F01 冲突项，见 §四） |
| 几何 geomDiff（reqItems/agentCards/skillRows/fileRows/fileMainW） | — | **五组全部 same**（fileMainW 825px@1440、665px@1280 逐值相同，无列宽挤压回归） |

## 二、本轮修复实测数值（改前 → 改后，均为浏览器输出）

### A｜硬违规清零（41 → 0）

| 节点 | 改前 | 改后 |
|---|---|---|
| `span.st.st-awaiting`「待拍板」（纸底 #F1EADB） | 12/19.2 #E5B95E **C1.53** | 12/19.2 **#75590F C5.49**（暗底两处 #E5B95E C8.73/10.28 保留品牌琥珀） |
| `span.msz`「实测 ≠ 登记」`span.mtp`「类型 …」 | 11/16 #A3B0BF C6.68 | **12/18 #B3C0D2 C7.99** |
| `span.eyebrow` ×3（THE ATELIER 等） | **10px**/22 #A3B0BF | **11/16 #B3C0D2 C10.24** |
| `span.ev-k` ×5（类型要求/提交者…） | 12/20 #8996A8 C5.29 | **12/18 #B3C0D2 C8.61** |
| `button.sb-chip.unknown`（Lemate/Winter/Karina） | 12/18 #8996A8 C5.34 | **12/18 #B3C0D2 C8.69**（状态点色不动） |
| `span`「同步 —/05:09」（#sb-sync） | 12/18 #8996A8 C5.87 | **12/18 #B3C0D2 C9.56** |
| `span.ch-id`「TEST-R11」 | 12/19.2 #8996A8 C6.29 | 12/19.2 **#B3C0D2 C10.24** |
| `span.chk-at`「核实于 …」 | 12/19.2 #8996A8 C5.87 | **12/18 #B3C0D2 C9.56** |
| `div.note-cnt`「0/500」 | 12/19.2 #8996A8 C5.29 | **12/18 #B3C0D2 C8.61** |
| `span.sk-na`「—（技能未提供调用说明）」×2 | 14/25.2 #8996A8 C5.87 | **12/18 #B3C0D2 C9.56**（带说明文字≠纯「—」占位） |

### B｜评审点名「仍较细小」→ 等宽关键元数据 13/20/#E2EAF4

| 节点 | 改前 | 改后 |
|---|---|---|
| `i.ag-ids`「lemate·lemate」×4（图2 实例标识，等宽） | 12/18 #B3C0D2 C10.24 | **13/20 #E2EAF4 C15.56** |
| `small.lf-src` 绝对路径（图4 列表，等宽） | 12/18 #B3C0D2 C9.0 | **13/20 #E2EAF4 C13.67** |
| `div.fv-path` 绝对路径（图4 预览，等宽） | 12/18 #B3C0D2 C9.56 | **13/20 #E2EAF4 C14.53** |
| `p.skill-path` 技能路径（图3，等宽） | 12/18 #B3C0D2 C9.56 | **13/20 #E2EAF4 C14.53** |

依据：Cascadia/Consolas 12px 的 x-height 小于 Segoe UI 12px，光学上偏小——13px 等宽 ≈ 12px 无衬线视觉重量，等宽字体保留。

### C｜来源标签 11 → 12px

| 节点 | 改前 | 改后 |
|---|---|---|
| `i.lf-type`「Agent生成/历史归档」 | 11/16 #B3C0D2 | **12/18** #B3C0D2 C8.69（20px 胶囊盒装下） |
| `.lf-tag`（未核实等） | 11/16 | **12/18**（22px 胶囊盒装下；unver/mism/hist 态色不动） |

### D｜#A3B0BF → #B3C0D2 统一（改色为主，档位 12/18）

`reqs-head`(10.24) · `ss-meta`(8.69) · `hf-meta`(8.69) · `ip-time`(9.56) · `ip-file .fb/.fb.reg`(9.56) · `ev-src`(8.61) · `ev .ev-policy`(8.61) · `agent-role p`(9.56) · `sb-chip.idle`(8.69) · `#skill-pagination span`(10.24)；关键元数据归 13/20/#E2EAF4：`ch-sub`(15.56) · `#tb-task`(14.53) · `.ls.k-waitpre` 等待前置(14.53) · `.ev-v` 检验值(13.09)。

## 三、几何回归（双视口实测）

- `fileMainW`：825×12@1440、665×12@1280，改前改后**逐值相同**——文件列宽无挤压回归
- `fileRows` 84/86/108 · `skillRows` 124×12 · `agentCards` 18/74 · `reqItems`：**全部 same**（lf-src/ag-ids 升 13/20 后行盒被 68px 最小高与既有行高吸收，无异常增高）
- `rosterOverlap`/`skillOverlap`/`fileOverlap` = []；`pageOverflowX` = false（两视口 × 4 页面态 × walk 级全测）
- 双视口节点数一致（113/60/80/152/112/140），1280×800 布局与 1440 同构（agent-grid 列数断点在 1199px 以下）

## 四、诚实边界（不改的与说明的）

1. **`.lf-lines .lf-size` #D7E1EE（C12.56）**：F01 第 4 轮（app.css:1579）在时间上后置、注释明示「刻意冲突、源顺序取胜」，跨任务规格——本轮不动，只记录；对比度达标。
2. **`offtier` 余量 121**：#F1ECE2 ×41 为标题（.lf-name 14/22、filegroup 16/24）、文件正文预览（.fv-panel 12.5px mono，文件内容非辅助文字）、sk-tag 亮色短标签；#D7E1EE ×8/12 为 F01 项；#A3B0BF 仅剩 `button.rail-item` 内导航文字（控件，C7.99 达标）与「全部需求」筛选按钮（`#btn-overview`，C8.56 达标）。
3. **纸底状态胶囊其余 6 态**（done/running/pending/skipped/failed/waitpre）本轮只有 awaiting 有实节点；其余按同口径给了深色（#1E6B40 C5.43 · #75590F C5.5 · --ink-red #B23A31 C4.95 · --ink #20211C C≈13，按 #F1EADB 公式计算值，非浏览器实测）。现有 `--ink-green/--ink-amber/--ink-muted` 在纸上公式值 C3.9–4.2 不达标，故未复用。
4. **纯「—」无数据占位**（.lf-exec.na 等）保留 #8996A8 诚实弱化档（第 3 轮约定）；本轮把带说明文字的 `.sk-na`「—（原因）」提亮到辅助档。
5. `.st` 状态胶囊保持 12px（≥下限、nowrap 紧凑胶囊；主列表状态 .req-status 第 3 轮已是 13/20）。

## 五、改动清单

仅 `web/app.css` 追加「G01（第 4 轮，2026-11-16）」块（app.css:1583-1640，65 行，全部复用 --meta/--meta-strong/--ink 既有令牌 + 4 个纸底深色字面量），无其他文件改动。备份：`app.css.bak-g01c`。
