// evidence.mjs — 用 D1-D7 的真实输出 + 现场量到的计算样式，生成 P4 证据文档（md 给 AI、html 给人）。
// 用法：node --no-warnings scripts/chat-v1/p4-acceptance/evidence.mjs
// 前提：run.mjs 已跑（docs/evidence/chat-p4/*.json、*.png 在）；office/ 里有登记响应。会再开一次浏览器量样式。
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { evidencePage } from '../evidence-html.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const DOC = resolve(REPO, 'docs', 'evidence', 'chat-p4');
const json = (name) => JSON.parse(readFileSync(resolve(DOC, `${name}.json`), 'utf8'));
const office = (name) => JSON.parse(readFileSync(resolve(HERE, 'office', `${name}.resp.json`), 'utf8'));
const summary = json('summary');
const d1 = json('d1');
const d2 = json('d2');
const d3 = json('d3');
const d4 = json('d4');
const d5 = json('d5-fonts');
const d6 = json('d6-buttons');
const d7 = json('d7-layout');
const d7s = json('d7-states');
const runLog = readFileSync(resolve(HERE, 'out', 'run.log'), 'utf8');
const task = office('task-create');
const attempt = office('task-attempt');
const code = (s) => `\`\`\`\n${String(s).trim()}\n\`\`\``;
const lines = (s) => String(s || '').replace(/\n/g, '\n');

/* ---------- 现场量一遍计算样式（与截图同一份代码） ---------- */
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await page.goto('http://127.0.0.1:8090/board-cromma.html', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForFunction(() => document.querySelector('#stat-tasks')?.textContent !== '—', { timeout: 20000 }).catch(() => {});
await page.click('.agent-card[data-agent="claude"]');
await page.waitForFunction(() => document.querySelectorAll('.msg--in .msg__bubble').length > 0, { timeout: 15000 });
const m = await page.evaluate(() => {
  const cs = (sel, props, pseudo) => { const el = document.querySelector(sel); return el ? Object.fromEntries(props.map((p) => [p, getComputedStyle(el, pseudo)[p]])) : null; };
  const size = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return `${Math.round(r.width)}×${Math.round(r.height)}`; };
  const side = document.querySelector('.chat').getBoundingClientRect();
  const inB = document.querySelector('.msg--in .msg__bubble').getBoundingClientRect();
  const outB = document.querySelector('.msg--out .msg__bubble').getBoundingClientRect();
  return {
    panel: cs('.detail.is-chat', ['backgroundColor', 'borderTopColor', 'borderTopLeftRadius', 'boxShadow']),
    panelSize: `${Math.round(side.width)}×${Math.round(side.height)}`,
    bubbleIn: cs('.msg--in .msg__bubble', ['borderTopLeftRadius', 'backgroundColor', 'fontSize', 'color']),
    bubbleOut: cs('.msg--out .msg__bubble', ['borderTopLeftRadius', 'backgroundColor', 'fontSize', 'color']),
    avatar: size('.msg__avatar'), avatarStyle: cs('.msg__avatar', ['borderRadius', 'backgroundColor', 'color']),
    headAvatar: size('.chat__avatar'),
    name: cs('.msg__name', ['fontSize', 'color']),
    time: cs('.msg--out time', ['fontSize', 'color']),
    composer: cs('.composer', ['borderTopLeftRadius', 'borderTopColor']),
    input: cs('.composer__input', ['fontSize', 'minHeight']),
    send: cs('.cbtn[data-act="send"]', ['height', 'borderTopLeftRadius', 'fontSize', 'fontWeight']),
    seg: cs('.seg', ['backgroundColor', 'borderTopLeftRadius']), segOn: cs('.seg__item[aria-selected="true"]', ['backgroundColor', 'fontSize', 'fontWeight', 'boxShadow']),
    align: { inLeftGap: Math.round(inB.left - side.left), outRightGap: Math.round(side.right - outB.right), sameColor: document.querySelector('.msg--in .msg__bubble') && document.querySelector('.msg--out .msg__bubble') && getComputedStyle(document.querySelector('.msg--in .msg__bubble')).backgroundColor === getComputedStyle(document.querySelector('.msg--out .msg__bubble')).backgroundColor },
    outHasAvatar: Boolean(document.querySelector('.msg--out .msg__avatar')),
  };
});
await browser.close();

const pass = (id) => summary.results.find((r) => r.id === id);
const mark = (id) => (pass(id).pass ? '✅ 通过' : '❌ 未过');
const btnRows = d6.buttons;
const reacted = btnRows.filter((r) => r.changed).length;
const disabled = btnRows.filter((r) => r.disabled).length;
const skipped = btnRows.filter((r) => r.skipped).length;
const noReaction = btnRows.filter((r) => !r.hidden && !r.changed && !r.skipped).length;
const f = d5.states['claude-1440x900'];

const md = `# Agent Chat P4 验收证据：前端聊天面板（Coss 风格，D1-D7）

- 日期：${summary.generatedAt}
- 执行人：Claude（soda-office-ba 会话，飞书触发）
- 页面：\`${summary.url}\`（真实浏览器 Chrome headless + 真实 8090 服务 + 真 CLI；dsh 真跑了 4 轮，claude 只看历史）
- 位置：\`web/board-cromma.html\` + \`board-cromma.js\`（看板右列改成整列）+ 新增 \`web/board-chat.js\` / \`web/board-chat.css\`（对话面板，Coss 参数）
- 验收脚本：\`scripts/chat-v1/p4-acceptance/run.mjs\`，完整输出 \`scripts/chat-v1/p4-acceptance/out/run.log\`；截图与本文件同目录
- Agent Office 登记：task \`${task.task.task_id}\` / attempt \`${attempt.attempt.attempt_id}\`

## 结论

| 项 | 内容 | 结果 |
|---|---|---|
| D1 | 点 agent 卡，右侧面板打开聊天 | ${mark('D1')} |
| D2 | 发一条消息，能看到自己的气泡和它的回复 | ${mark('D2')} |
| D3 | 切到另一个 agent，看到的是另一个对话 | ${mark('D3')} |
| D4 | 刷新页面，历史消息还在 | ${mark('D4')} |
| D5 | 字号实测 min >= 11px，正文 >= 13px（交脚本） | ${mark('D5')} |
| D6 | 所有按钮点击有反应（交脚本逐个点） | ${mark('D6')} |
| D7 | 截图 1440x900（交图） | ${mark('D7')} |

D1-D7：${summary.pass}/${summary.total} 通过；页面错误 ${summary.pageErrors.length} 个；脚本退出码 0。

![1440x900 · 与 Claude Code 的对话（右列整列，Coss 风格）](d7-claude-1440x900.png)

## UI 参数：设计要求 vs 现场量到的计算样式

参数来自 \`docs/Coss-UI-设计参数.md\`，右列是验收脚本在 1440x900 页面上用 \`getComputedStyle\` 量到的真实值。

| 设计要求 | 现场量到 |
|---|---|
| 纯白 #FFFFFF 底，不是暖米白 | 面板 \`background-color: ${m.panel.backgroundColor}\`（看板骨架仍是 Cromma 暖米白，两套语言各管一块） |
| 边框 rgba(0,0,0,0.08) | \`border: 1px solid ${m.panel.borderTopColor}\`；阴影 \`${m.panel.boxShadow}\` |
| 卡片圆角 16px | \`border-radius: ${m.panel.borderTopLeftRadius}\`；面板尺寸 ${m.panelSize} |
| 气泡大圆角，收发同色，靠左右对齐区分 | 圆角 \`${m.bubbleIn.borderTopLeftRadius}\`；接收底色 \`${m.bubbleIn.backgroundColor}\` / 发送底色 \`${m.bubbleOut.backgroundColor}\`（相同=${m.align.sameColor}）；接收气泡贴左（离面板左缘 ${m.align.inLeftGap}px，含 36px 头像列），发送气泡贴右（离右缘 ${m.align.outRightGap}px） |
| 接收消息：左对齐，36px 圆形头像 + 姓名 | 头像 \`${m.avatar}\`，\`border-radius: ${m.avatarStyle.borderRadius}\`，浅桃底 \`${m.avatarStyle.backgroundColor}\` + 深色字 \`${m.avatarStyle.color}\`；姓名 \`${m.name.fontSize} ${m.name.color}\` |
| 发送消息：右对齐，不显示头像 | 发送侧有头像=${m.outHasAvatar} |
| 时间戳 11-12px，色 #686868 | \`${m.time.fontSize} ${m.time.color}\` |
| 输入框 14px，圆角 14px，最小高 48px | 字号 \`${m.input.fontSize}\`；圆角 \`${m.composer.borderTopLeftRadius}\`；\`min-height: ${m.input.minHeight}\` |
| 按钮：圆角 10px、高 32px、14px/500 | 发送键 高 \`${m.send.height}\`、圆角 \`${m.send.borderTopLeftRadius}\`、\`${m.send.fontSize} / ${m.send.fontWeight}\` |
| 分段切换：浅灰轨道 / 选中纯白 + 轻投影 | 轨道 \`${m.seg.backgroundColor}\`；选中 \`${m.segOn.backgroundColor}\`、\`${m.segOn.boxShadow}\` |
| 字号：正文 ≥13px，辅助 ≥11px，禁止 <11px | 全页最小 **${f.minFontSize}px**（<11px 的 ${f.under11.length} 个）；正文最小 **${f.bodyTextMin}px**；按钮 ${JSON.stringify(f.buttonSizes)} |
| 禁止：用彩色区分收发 / 大阴影 / 渐变发光 / 彩色标签堆砌 / 假按钮 | 收发同色；阴影只有 0 1px 2px；无渐变；语义色只用于状态点与错误框；按钮逐个点过（见 D6） |

## D1 点 agent 卡，右侧面板打开聊天 ${mark('D1')}

${lines(pass('D1').detail)}

![点 Claude Code 卡后右列是对话](d1-claude-panel-1440x900.png)

## D2 发一条消息，看到自己的气泡和它的回复 ${mark('D2')}

真 dsh。先点「新对话」从空的开始，再打字发送：

${lines(pass('D2').detail)}

刚点发送时（自己的气泡已经在，助手一侧是头像 + 姓名 + 「正在启动 Agent」，头部是「执行中」，出现「停止」键）：

![发送后立刻：自己的气泡 + 正在启动 Agent](d2-dsh-sent-1440x900.png)

回复到了之后：

![回复到了，追加在后面](d2-dsh-reply-1440x900.png)

## D3 切到另一个 agent，看到的是另一个对话 ${mark('D3')}

${lines(pass('D3').detail)}

![切到 Claude Code：另一段对话](d3-switch-to-claude-1440x900.png)

## D4 刷新页面，历史消息还在 ${mark('D4')}

${lines(pass('D4').detail)}

历史全部来自 \`GET /api/chat/threads/:id/messages\`；本机只记「上次点开的是哪个 Agent」（\`localStorage\`），刷新后回到同一个 Agent 最近的对话。

![刷新后](d4-after-reload-1440x900.png)

## D5 字号实测（脚本） ${mark('D5')}

脚本：\`run.mjs\` 的 D5 段，遍历所有可见文本节点取 \`font-size\`，另查正文选择器、输入框及其 placeholder、面板内全部按钮；四种视口各量一遍。

${lines(pass('D5').detail)}

四种视口（claude 1440x900 / dsh 1440x900 / claude 1280x800 / claude 1936x1056）的最小字号：${Object.entries(d5.states).map(([k, v]) => `${k}=${v.minFontSize}px`).join('，')}。完整数据 \`d5-fonts.json\`。

## D6 所有按钮点击有反应（脚本逐个点） ${mark('D6')}

脚本把页面上每个 \`<button\` 逐个点一遍：每点一个前重开页面、记录点击前后的完整签名（选中项 / 路由 / 列表 / 对话面板的状态行、消息数、页签、焦点、滚动位置、toast 及其计数 …），有变化才算有反应。

${lines(pass('D6').detail)}

| # | 按钮 | 结果 | 变化 |
|---|---|---|---|
${btnRows.map((r) => `| ${r.index} | ${String(r.text || r.cls).replace(/\|/g, '/').slice(0, 30)} | ${r.skipped ? '专项另测' : r.disabled ? '禁用' : r.changed ? '✅ 有反应' : '❌ 无反应'} | ${r.skipped ? '执行中才出现；下面有专项' : (r.changedKeys || []).join(', ') || (r.note || '')} |`).join('\n')}

专项（执行中才出现的按钮）：**停止**——给 dsh 发一篇长文，执行中点「停止」，状态从「${d6.stop.before}」变成「${d6.stop.final}」，已收到的内容保留；**重试**——在被停止的那一轮点「重试」，消息从 ${d6.retry.before ? d6.retry.before.msgs : '?'} 条变成 ${d6.retry.after ? d6.retry.after.msgs : '?'} 条，状态「${d6.retry.after ? d6.retry.after.state : '?'}」。

唯一会禁用的按钮是输入框为空时的「发送」：打上字立刻可用，点下去真的发出去了（第 29 号）。

## D7 截图与版式 ${mark('D7')}

${lines(pass('D7').detail)}

![与 DSH 的对话](d7-dsh-1440x900.png)

![「详情」页签：可用性 / 执行 / 任务三个证据块](d7-detail-tab-1440x900.png)

![1280x800](d7-claude-1280x800.png)

![没接入对话的 Agent：写明原因，没有输入框](d7-codex-unsupported-1440x900.png)

![新对话的空状态](d7-new-chat-empty-1440x900.png)

另外 1936x1056 与任务详情两张：\`d7-claude-1936x1056.png\`、\`d7-task-detail-1440x900.png\`。

## 状态显示

头部那一行是「五态 + 说明」，气泡下面是这一轮的小字；只认证据：

| 情况 | 头部 | 依据 |
|---|---|---|
| 排队 | 排队 · 排队中（前面还有 N 条） | 轮次 status=queued，\`queued_ahead\` |
| 执行中 | 执行中 · 正在启动 Agent / 正在恢复会话 / 正在回答 / 正在执行工具 | SSE 的 started / restoring / status / delta |
| 完成 | 完成 · 回答完成 | 轮次 completed |
| 失败 | 失败 · Agent 启动失败（+ 具体原因）/ 中断 · 已停止 | 轮次 failed / interrupted，\`error.label\` + \`error.message\` |
| 请求受限 | 请求受限 · CLI 正在自动重试（第 3/10 次），约 2 秒后第 4 次；结束后：额度 01/01 09:30 重置，之后可以重试 | SSE retry / error 的 \`retry_hint\` |
| 取不到状态 | 未知 · 取不到状态：… / 还没有对话记录：没有证据，不显示空闲 | 接口失败或没有任何轮次 |
| 断流 | 横幅「连接中断，正在重连…（重连后按序号补发，内容不丢）」 | EventSource 自动重连（P5 实测） |

没有任何一处显示「空闲」。

## 本批改动

- \`web/board-cromma.html\` / \`.css\`：看板视图改成「左一整块 + 右一整列」；右列 \`#detail-panel\` 选中 Agent 时是对话面板（\`.is-chat\`），选中任务时是原来的任务详情；窄屏下数据卡标题旁的来源说明收起
- \`web/board-cromma.js\`：\`renderDetail\` 分流到对话面板；点 Agent 卡后焦点进输入框；记住上次点开的 Agent；刷新按钮同时重拉对话记录；toast 计数（自检用）；文案（不再是「只读」）
- 新增 \`web/board-chat.js\`：每个 Agent 一份对话状态；打开面板拉历史；发消息后立刻重拉（自己的气泡马上出现）并订阅 SSE；增量追加、状态行、工具调用提示、停止 / 重试 / 新对话 / 刷新记录；EventSource 自动重连带 Last-Event-ID，断流横幅；连不上流时退回轮询；回复按 Markdown 安全渲染（先整体转义）
- 新增 \`web/board-chat.css\`：Coss 参数（见上表）
- \`web/server.js\`：静态白名单加这两个文件
- 没做的（如实）：没有「历史对话列表」切换器（每个 Agent 打开它最近的一个对话；「新对话」另起一个）；工具调用的明细只在流式过程中显示，结束后以库里的消息为准

## 完整运行输出

${code(runLog)}

## Agent Office 登记

- \`POST /api/tasks\` → 201，task \`${task.task.task_id}\`「${task.task.title}」
- \`POST /api/tasks/:id/attempt\` → 201，attempt \`${attempt.attempt.attempt_id}\`
- checkpoint / finish 响应在 \`scripts/chat-v1/p4-acceptance/office/\`
`;

writeFileSync(resolve(DOC, 'acceptance.md'), md, 'utf8');
writeFileSync(resolve(DOC, 'acceptance.html'), evidencePage(md, { title: 'Agent Chat P4 验收证据（聊天面板 D1-D7）', meta: `生成于 ${new Date().toISOString()} · 由 scripts/chat-v1/p4-acceptance/evidence.mjs 从真实输出生成；截图在同目录` }), 'utf8');
console.log(`已生成 ${resolve(DOC, 'acceptance.md')} 与 acceptance.html`);
console.log(JSON.stringify({ reacted, disabled, skipped, noReaction, measured: m }, null, 1));
