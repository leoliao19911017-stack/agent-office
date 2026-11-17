// G02(第 5 轮)——app.css 颜色语义化收口 + 四文件拆分(一次性脚本,产物可复核):
//   ① :root 主变量块追加 6 个语义变量;删除 :1527/:1877 两个散置 :root 覆盖块(值前移集中)
//   ② 11 种高频硬编码颜色 → var() 引用(跳过 `--xxx:` 变量定义行;注释里同步替换,扫描干净)
//   ③ 按 679/1239/1685 三个区块边界拆 app-base/app-workbench/app-pages/app-layers
//   ④ 输出:拆分后各文件行数 + 11 色残留统计(应只剩 :root 定义处)
// 运行:node scripts/g02-css-split.mjs   (先备份 app.css 已在 git 工作区)
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(dirname(HERE), 'web');
// app.css 是 CRLF 行尾;正则里的 . 不匹配 \r,先统一规范成 \n 再处理(拆分产物一律 \n)
const src = readFileSync(join(WEB, 'app.css'), 'utf8').replace(/\r\n/g, '\n');

// ---------- ① 变量集中 ----------
let css = src;
// 删除两个散置 :root 覆盖块(整行,内容精确匹配)
css = css.replace(/^:root \{ --meta: #B3C0D2; --meta-strong: #E2EAF4; \}\n/m, '/* G02（第 5 轮）：--meta/--meta-strong 前移至文件头主 :root 集中定义 */\n');
// :1877 覆盖块带跨 2 行的尾注释,[\s\S]*? 一并吞到 */ 结束(避免留下悬空注释尾)
css = css.replace(/^:root \{ --meta-strong: #D6E0ED; \}[\s\S]*?\*\/\n/m, '/* G02（第 5 轮）：--meta-strong 生效值 #D6E0ED 前移集中,原两处覆盖块移除 */\n');

// 主 :root 内追加(锚在 --faint 行后)
const NEWVARS = `    --faint: #8996A8;       /* 未知灰（没数据 = 「—」，不猜） */
    /* G02（第 5 轮）：11 种高频硬编码颜色（169 处）语义化收口——组件规则一律 var() 引用，
       计算色值与收口前逐一致（verify-assets/g02/colors-diff.json 实测 0 差异）。 */
    --meta: #B3C0D2;         /* 辅助文字档（原 :1527 散置定义前移） */
    --meta-strong: #D6E0ED;  /* 正文强调档（原 :1877 覆盖值前移,历史 #E2EAF4 归 --meta-hi） */
    --meta-hi: #E2EAF4;      /* 重要状态文字档 */
    --meta-num: #D7E1EE;     /* 登记数值档 */
    --amber-bg: #3B3021;     /* 琥珀警示底 */
    --ok: #65D9B1;           /* 恢复/有效强调（与完成绿 --green #62C6A0 是两个色值） */`;
if (!/--faint: #8996A8;/.test(css)) throw new Error('锚点 --faint 未找到');
css = css.replace(/    --faint: #8996A8;.*\n/, NEWVARS + '\n');

// ---------- ② 颜色 → var() ----------
const MAP = {
  'B3C0D2': '--meta', 'E5B95E': '--amber', 'E2EAF4': '--meta-hi', 'A3B0BF': '--muted',
  'D7E1EE': '--meta-num', '3B3021': '--amber-bg', '182230': '--card', '65D9B1': '--ok',
  '8996A8': '--faint', 'D6E0ED': '--meta-strong', '0D111A': '--bg',
};
let replaced = 0;
const lines = css.split('\n').map((line) => {
  if (/^\s*--[a-z0-9-]+\s*:\s*#/.test(line)) return line; // 变量定义行不动
  if (/^:root \{.*--/.test(line)) return line;            // 单行 :root 定义块不动(防自引用)
  let out = line;
  for (const [hex, v] of Object.entries(MAP)) {
    const re = new RegExp(`#${hex}(?![0-9A-Fa-f])`, 'gi');
    out = out.replace(re, () => { replaced++; return `var(${v})`; });
  }
  return out;
});
// 自引用死循环校验:--x: var(--x) 同名自引用出现即失败(引用其它变量的别名是合法的)
const selfRef = lines.filter((l) => /^\s*(--[a-z0-9-]+)\s*:\s*var\(\1\)\s*;/.test(l));
if (selfRef.length) throw new Error('变量定义行出现同名自引用:\n' + selfRef.join('\n'));
css = lines.join('\n');

// ---------- ③ 拆分 ----------
const all = css.split('\n');
// 找切点:顶格区块注释行号(拆分后行号因追加变量有漂移,按内容重新定位)
const findLine = (prefix) => {
  const i = all.findIndex((l, idx) => idx > 0 && l.startsWith(prefix));
  if (i < 0) throw new Error('切点未找到: ' + prefix);
  return i;
};
const cutA = findLine('/* ================= TASK-R2 补丁层');
// TASK-R11 层块首(两空格缩进 ===== 开头,块内第 2 行含「TASK-R11 层」字样),不是更早的 TASK-R9 组件层
const cutB = all.findIndex((l, idx) => idx > 0 && l.startsWith('  /* ====') && (all[idx + 1] || '').includes('TASK-R11 层'));
if (cutB < 0) throw new Error('TASK-R11 切点未找到');
const cutC = findLine('/* ================= W01：审批材料类型门禁');

const segs = [
  { name: 'app-base.css', from: 0, to: cutA, head: '/* app-base.css —— G02（第 5 轮）自 app.css 拆分：全局 token（:root 变量）、重置、骨架、顶/底栏、三栏框架、弹层与响应式。加载顺序 1/4。 */' },
  { name: 'app-workbench.css', from: cutA, to: cutB, head: '/* app-workbench.css —— G02（第 5 轮）自 app.css 拆分：TASK-R2/R3/R6 补丁层、TASK-R9 组件层与工作台三栏（需求列表/交付链/Inspector/审批）。加载顺序 2/4。 */' },
  { name: 'app-pages.css', from: cutB, to: cutC, head: '/* app-pages.css —— G02（第 5 轮）自 app.css 拆分：TASK-R11 层——Agents/技能/文件三个模块页与全局提示组件。加载顺序 3/4。 */' },
  { name: 'app-layers.css', from: cutC, to: all.length, head: '/* app-layers.css —— G02（第 5 轮）自 app.css 拆分：W01 审批材料门禁起的历轮评审覆盖层（必须最后加载,源顺序即覆盖顺序）。加载顺序 4/4。 */' },
];
const report = { replaced, segs: [] };
for (const s of segs) {
  const body = all.slice(s.from, s.to).join('\n');
  writeFileSync(join(WEB, s.name), s.head + '\n' + body.replace(/^\n+/, '') + '\n');
  report.segs.push({ name: s.name, lines: body.split('\n').length + 1 });
}
// 残留统计(拆分产物中 11 色还有几处、各在哪)
const residue = {};
for (const [hex] of Object.entries(MAP)) residue[hex] = 0;
for (const s of segs) {
  const body = all.slice(s.from, s.to).join('\n');
  for (const [hex] of Object.entries(MAP)) {
    const m = body.match(new RegExp(`#${hex}(?![0-9A-Fa-f])`, 'gi'));
    if (m) { residue[hex] += m.length; }
  }
}
report.residue = residue;
console.log(JSON.stringify(report, null, 2));
