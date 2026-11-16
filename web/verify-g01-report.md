# G01 第 3 轮验证报告（2026-11-16）

工具：`verify-g01.mjs`（CDP + headless Chrome，1440×900，对 http://127.0.0.1:8090 实测）
数据：`verify-g01-baseline.json`（改前基线 04:42）/ `verify-g01.json`（改后 04:48）/ 截图 4 张
口径：getComputedStyle 取 fontSize/lineHeight/color，沿祖先链取实底色算 WCAG 对比度；clipX=省略号设计内截断（合规），escX=逃逸视口（不合规）。

## 一、档位标准与总判定

| 档 | 规格 | 实测结果 |
|---|---|---|
| 辅助文字 | 12px / 18px / #B3C0D2 | 24 个实节点全落档 |
| 状态文字 | 13px / 20px / #E2EAF4 或品牌语义色 | 12 个实节点全落档 |
| 短标签 | 11px / 16px（对比度 ≥4.5） | 3 个实节点全落档 |
| 占位「—」 | #8996A8 诚实弱化档 | 1 个（.lf-exec.na，C 5.52） |
| 标题 | .lf-name 14/22（非辅助文字，豁免） | 1 个 |

**实节点 39 个：38 严格落档 + 1 个品牌语义豁免（.lf-size.ok 完成绿 ✓，12/18、C 7.98 ≥4.5，同「已交付/在线」的绿，规范明示不改品牌色）。**
全部节点 contrast 5.52–15.56 ≥4.5；无 rgba 半透明弱化（rawColor 全为 rgb()）；escX=0；四页 pageOverflowX=false。

## 二、本轮修复项（改前 → 改后，均为浏览器实测值）

| 节点 | 改前（baseline） | 改后（after） | 对比度 |
|---|---|---|---|
| `.ag-work.work-unknown`「未知」 | #8996A8，C 5.87 | 13/20 #E2EAF4 | **14.53** |
| `.ag-task.hist`「上次上报已过期」 | #8996A8，C 5.87 | 13/20 #E2EAF4 | **14.53** |
| `.sc-label`（图2 统计卡标签） | 12/18 #8996A8 | 12/18 #B3C0D2 | 8.77 |
| `.agent-kv`（明细 KV 行） | 14/22（继承），标签 #8996A8 | **12/18，标签与值均 #B3C0D2** | 9.56 |
| `.fvd-row span`（预览来源标签） | 13/24 残留行高 | 12/18 #B3C0D2 | 10.24 |
| `.fvd-row b`（执行者/校验/大小） | 13/24 #B3C0D2 偏暗 | 13/20 #E2EAF4 | 15.56 |
| `.lf-size` 实测/登记双值 | 12/18 #D7E1EE（F01 强调色，档外） | 12/18 #B3C0D2 | 9.0 |
| `.lf-exec`（执行者） | 12/18 #F1ECE2（档外偏亮） | 12/18 #B3C0D2 | 9.0 |
| `.lf-tag.unver`（未核实标签） | 11/16 #A3B0BF on #26384F，C 5.41 | 11/16 #B3C0D2，C 6.47（级联，无实节点，手工计算） | 6.47 |

前两轮遗留的 8 个档外节点全部归位；#8996A8 仅保留给真正的「—」无数据占位（.lf-exec.na、.sk-na）。

## 三、代表性达标数值（改后实测）

- 图1：状态 待拍板 13/20 #E5B95E C7.02 · 进行中 C9.6 · 已交付 #62C6A0 C8.48；阶段 12/18 #B3C0D2 C7.0
- 图2：ids/角色/scope/roster-head 12/18 #B3C0D2 C9.56–10.24；在线绿 C8.48；空闲/未知/心跳/任务 13/20 #E2EAF4 C14.53
- 图3：计数/用途/摘要 small 12/18 #B3C0D2 C8.69–10.24；skill-path 等宽 12/18 C9.56；sk-tag/sk-cat 11/16 C8.69–10.13
- 图4：路径 lf-src/fv-path 等宽 12/18 C9–9.56（fv-path rtl 省略号截断尾部，clipX 合规）；fvd 标签 12/18 / 数值 13/20；warn 琥珀 C10.28

## 四、压力测试与几何回归

- 注入超长中文 / 157 字符英文深路径 / 中英混合串共 11 例：escX=0/11，四页 pageOverflowX=false
- geomDiff（vs baseline）：reqItems / agentCards / skillRows / fileRows / fileMainW 五组 **全部 same**，无卡片高度异常、无文件列宽回归

## 五、诚实边界（做不到的如实说）

1. 无 DOM 节点的状态无法 getComputedStyle 实测，按 CSS 级联核对规则源：`ag-conn.off`/`ag-hb.off`→:1510 #E2EAF4；`ag-hb.stale`→琥珀 C8.73（计算值）；`work-working`→蓝 C5.95（计算值）；`t-queued`→:1501 #E2EAF4；`agent-run p`→:1513 #B3C0D2，字号 14/22 继承（≥12 达标）。
2. `.req-line2` 是纯 flex 容器（直接文本节点=0，实测），其 12/20/#F1ECE2 不渲染任何字，档位以两个子节点为准（均已落档）。
3. `.lf-tag.unver` 当前无实节点，6.47 为公式计算值非浏览器输出。

产物：web/app.css（唯一应用改动；备份 app.css.bak-g01b）、本报告、verify-g01*.json/png
