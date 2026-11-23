// run.mjs — Agent Chat P4（前端对话面板，Coss 风格）验收 D1-D7：真实浏览器 + 真实 8090 服务 + 真 CLI。
// 用法：node --no-warnings scripts/chat-v1/p4-acceptance/run.mjs [--base http://127.0.0.1:8090]
// 产物：docs/evidence/chat-p4/（截图 + d1-d7 的 JSON），完整输出 out/run.log（由调用方重定向）
// 真 CLI 调用：dsh 3 次（D2 一次、D6 发送一次、D6 停止后重试一次）+ dsh 长文一次（被停止）；claude 0 次（只看历史）。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const DOC = resolve(REPO, 'docs', 'evidence', 'chat-p4');
mkdirSync(DOC, { recursive: true });
const args = process.argv.slice(2);
const BASE = args.includes('--base') ? args[args.indexOf('--base') + 1] : 'http://127.0.0.1:8090';
const URL = `${BASE}/board-cromma.html`;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const results = [];
const log = (...a) => console.log(...a);
function record(id, title, pass, detail) {
  results.push({ id, title, pass, detail });
  log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${title}${detail ? `\n      ${String(detail).replace(/\n/g, '\n      ')}` : ''}`);
}
const save = (name, data) => writeFileSync(resolve(DOC, `${name}.json`), JSON.stringify(data, null, 2));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const pageErrors = [];
async function newPage(w = 1440, h = 900) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => pageErrors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
  return page;
}
async function openBoard(page, { agent = null } = {}) {
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => document.querySelector('#stat-tasks')?.textContent !== '—', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(350);
  if (agent) await page.click(`.agent-card[data-agent="${agent}"]`);
  await page.waitForFunction(() => {
    const body = document.querySelector('.chat__body');     // 没接入对话的 Agent 没有消息区（只有一段说明）
    return document.querySelector('.chat') && (!body || !body.textContent.includes('正在读取历史消息'));
  }, { timeout: 15000 });
  await page.waitForTimeout(250);
}
const sigFn = () => ({
  hash: location.hash,
  route: document.body.dataset.route,
  boardHidden: document.querySelector('#view-board')?.hidden,
  selectedAgent: document.querySelector('.agent-card.is-selected')?.dataset.agent || null,
  selectedTask: document.querySelector('.task-row.is-selected')?.dataset.task || null,
  activeFilter: document.querySelector('.filter.is-active')?.dataset.filter || null,
  taskList: (document.querySelector('#task-list')?.innerText || '').replace(/\s+/g, ' ').slice(0, 320),
  refreshLabel: document.querySelector('#refresh-label')?.textContent,
  toastVisible: document.querySelector('#toast')?.classList.contains('is-show'),
  toastCount: Number(document.querySelector('#toast')?.dataset.count || 0),
  toast: document.querySelector('#toast')?.textContent,
  chatAgent: document.querySelector('.chat')?.dataset.agent || null,
  chatState: document.querySelector('.chat__state')?.textContent || null,
  chatTab: document.querySelector('.seg__item[aria-selected="true"]')?.dataset.tab || null,
  chatMsgs: document.querySelectorAll('.msg').length,
  chatTail: (document.querySelector('.chat__body')?.innerText || '').replace(/\s+/g, ' ').slice(-160),
  chatBanner: (document.querySelector('.chat__banner') && !document.querySelector('.chat__banner').hidden) ? document.querySelector('.chat__banner').textContent : '',
  composerHidden: document.querySelector('.chat__composer')?.hidden ?? null,
  detailHead: (document.querySelector('.chat__detail')?.innerText || '').replace(/\s+/g, ' ').slice(0, 100),
  detailPanelHead: (document.querySelector('#detail-panel .detail__name')?.textContent || '').slice(0, 60),
  focus: document.activeElement ? String(document.activeElement.className || document.activeElement.tagName) : null,
  chatScroll: document.querySelector('.chat__body') ? Math.round(document.querySelector('.chat__body').scrollTop) : null,
  resources: performance.getEntriesByType('resource').length,
});
const sig = (page) => page.evaluate(sigFn);
const chatSnap = (page) => page.evaluate(() => {
  const q = (s) => document.querySelector(s);
  const rect = (s) => { const el = q(s); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  return {
    agent: q('.chat')?.dataset.agent || null,
    state: q('.chat__state')?.textContent || null,
    stateTone: q('.chat__state')?.dataset.tone || null,
    msgs: [...document.querySelectorAll('.msg')].map((m) => ({
      side: m.classList.contains('msg--out') ? 'out' : 'in',
      text: (m.querySelector('.msg__bubble')?.innerText || '').replace(/\s+/g, ' ').slice(0, 90),
      note: m.querySelector('.msg__status')?.textContent || '',
      live: m.dataset.live === '1',
    })),
    rects: { side: rect('#side-panel'), chat: rect('.chat'), body: rect('.chat__body'), composer: rect('.composer'), input: rect('.composer__input'), send: rect('.cbtn[data-act="send"]') },
  };
});
/** 等这一轮跑完：以「停止」按钮收起为准（执行中才出现），再等历史重拉完；返回头部状态行 */
async function waitTurnDone(page, ms = 180000) {
  await page.waitForSelector('.cbtn[data-act="cancel"]:not([hidden])', { timeout: 8000 }).catch(() => { /* 很快就跑完了，没来得及看到停止键 */ });
  const t0 = Date.now();
  let last = '';
  for (;;) {
    const s = await page.evaluate(() => ({
      state: document.querySelector('.chat__state')?.textContent || '',
      busy: (() => { const b = document.querySelector('.cbtn[data-act="cancel"]'); return b ? !b.hidden : false; })(),
      loading: (document.querySelector('.chat__body')?.textContent || '').includes('正在读取历史消息'),
    }));
    last = s.state;
    if (!s.busy && !s.loading && Date.now() - t0 > 400) return s.state;
    if (Date.now() - t0 > ms) throw new Error(`等这一轮跑完超时（最后是「${s.state}」）`);
    await page.waitForTimeout(200);
  }
}
const brief = (s, n = 140) => String(s || '').replace(/\s+/g, ' ').slice(0, n);

/* ============================ D1 ============================ */
{
  const page = await newPage();
  await openBoard(page);
  const before = await page.evaluate(() => Boolean(document.querySelector('.chat')));
  await page.click('.agent-card[data-agent="claude"]');
  await page.waitForTimeout(500);
  const snap = await chatSnap(page);
  const inPanel = await page.evaluate(() => Boolean(document.querySelector('#side-panel #detail-panel.is-chat .chat[data-agent="claude"]')));
  const r = snap.rects.chat;
  const onScreen = r && r.x >= 0 && r.y >= 0 && r.x + r.w <= 1440 && r.y + r.h <= 900 && r.w >= 300 && r.h >= 400;
  await page.screenshot({ path: resolve(DOC, 'd1-claude-panel-1440x900.png') });
  save('d1', { chat_before_click: before, in_side_panel: inPanel, rect: r, snapshot: snap });
  record('D1', '点 agent 卡，右侧面板打开聊天', inPanel && onScreen && snap.agent === 'claude' && !/空闲/.test(snap.state || ''),
    `#detail-panel.is-chat 里的 .chat[data-agent=claude]=${inPanel}；面板位置 ${JSON.stringify(r)}；状态行=「${brief(snap.state, 80)}」；消息 ${snap.msgs.length} 条`);
  await page.close();
}

/* ============================ D2 ============================ */
let dshText = '';
{
  const page = await newPage();
  await openBoard(page, { agent: 'dsh' });
  await page.click('.chat [data-act="new"]');                 // 新对话：从干净的开始
  await page.waitForTimeout(300);
  const empty = await chatSnap(page);
  const text = '用两句话介绍一下你能帮我做什么。不要用工具。';
  await page.fill('.composer__input', text);
  const sendEnabled = await page.evaluate(() => !document.querySelector('.cbtn[data-act="send"]').disabled);
  const t0 = Date.now();
  await page.click('.cbtn[data-act="send"]');
  await page.waitForFunction((n) => document.querySelectorAll('.msg--out').length >= 1, 1, { timeout: 5000 });
  const ownBubbleMs = Date.now() - t0;
  const afterSend = await chatSnap(page);
  // 等回复：中途抓一张「执行中」的截图
  const mid = await page.evaluate(() => document.querySelector('.chat__state')?.textContent || '');
  await page.screenshot({ path: resolve(DOC, 'd2-dsh-sent-1440x900.png') });
  const finalState = await waitTurnDone(page, 180000);
  await page.waitForTimeout(400);
  const snap = await chatSnap(page);
  const reply = await page.evaluate(() => [...document.querySelectorAll('.msg--in .msg__bubble')].map((b) => b.innerText).join('\n'));   // 完整文本（chatSnap 里是截断的）
  dshText = text;
  await page.screenshot({ path: resolve(DOC, 'd2-dsh-reply-1440x900.png') });
  const api = (await (await fetch(`${BASE}/api/chat/threads?agent_id=dsh`)).json()).threads[0];
  const msgs = (await (await fetch(`${BASE}/api/chat/threads/${api.thread_id}/messages`)).json());
  const apiReply = msgs.messages.filter((m) => m.role === 'assistant').map((m) => m.content).join('\n');
  save('d2', { empty_after_new: empty.msgs.length, empty_state: empty.state, send_enabled_after_typing: sendEnabled, own_bubble_ms: ownBubbleMs, state_right_after_send: afterSend.state, state_seen_meanwhile: mid, final_state: finalState, snapshot: snap, thread_id: api.thread_id, api_messages: msgs.messages.map((m) => ({ role: m.role, status: m.status, content: m.content.slice(0, 120) })) });
  // 面板里显示的是渲染后的 Markdown（列表符号、** 之类不再显示），所以两边都去掉空白和 Markdown 记号再逐字比
  const norm = (t) => t.replace(/^\s*\d+[.)]\s*/gm, '').replace(/[\s*_#`>~•\-|]/g, '');
  const sameText = norm(reply) === norm(apiReply);
  record('D2', '发一条消息，能看到自己的气泡和它的回复', sendEnabled && afterSend.msgs.some((m) => m.side === 'out' && m.text.includes('两句话')) && reply.length > 10 && /^完成/.test(finalState) && sameText,
    `新对话后 ${empty.msgs.length} 条；打字后发送键可用=${sendEnabled}\n点发送后 ${ownBubbleMs}ms 自己的气泡出现；此刻状态=「${brief(afterSend.state, 60)}」\n最终状态=「${finalState}」；回复=「${brief(reply, 160)}」\n与 API 里的助手消息一致（去空白与 Markdown 记号后逐字相等）=${sameText}`);
  await page.close();
}

/* ============================ D3 ============================ */
{
  const page = await newPage();
  await openBoard(page, { agent: 'dsh' });
  const dsh = await chatSnap(page);
  await page.click('.agent-card[data-agent="claude"]');
  await page.waitForTimeout(500);
  const claude = await chatSnap(page);
  await page.screenshot({ path: resolve(DOC, 'd3-switch-to-claude-1440x900.png') });
  const sameFirst = dsh.msgs[0] && claude.msgs[0] && dsh.msgs[0].text === claude.msgs[0].text;
  save('d3', { dsh: { agent: dsh.agent, state: dsh.state, first: dsh.msgs[0] }, claude: { agent: claude.agent, state: claude.state, first: claude.msgs[0], count: claude.msgs.length } });
  record('D3', '切到另一个 agent，看到的是另一个对话', claude.agent === 'claude' && claude.msgs.length >= 2 && !sameFirst,
    `DSH：${dsh.msgs.length} 条，首条「${brief(dsh.msgs[0] && dsh.msgs[0].text, 50)}」\nClaude：${claude.msgs.length} 条，首条「${brief(claude.msgs[0] && claude.msgs[0].text, 50)}」`);
  await page.close();
}

/* ============================ D4 ============================ */
{
  const page = await newPage();
  await openBoard(page, { agent: 'claude' });
  const before = await chatSnap(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const body = document.querySelector('.chat__body');
    return document.querySelector('.chat') && body && !body.textContent.includes('正在读取历史消息') && document.querySelectorAll('.msg').length > 0;
  }, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(400);
  const after = await chatSnap(page);
  await page.screenshot({ path: resolve(DOC, 'd4-after-reload-1440x900.png') });
  const same = before.agent === after.agent && before.msgs.length === after.msgs.length && before.msgs.every((m, i) => m.text === after.msgs[i].text);
  save('d4', { before: { agent: before.agent, count: before.msgs.length, texts: before.msgs.map((m) => m.text) }, after: { agent: after.agent, count: after.msgs.length, state: after.state, texts: after.msgs.map((m) => m.text) } });
  record('D4', '刷新页面，历史消息还在（从 API 拉）', same && after.msgs.length >= 2,
    `刷新前 ${before.agent} ${before.msgs.length} 条 → 刷新后 ${after.agent} ${after.msgs.length} 条，逐条相同=${same}；状态行=「${brief(after.state, 60)}」`);
  await page.close();
}

/* ============================ D5 字号 ============================ */
{
  const audit = () => {
    const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'TITLE']);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const rows = [];
    let node;
    while ((node = walker.nextNode())) {
      const text = node.nodeValue.replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const el = node.parentElement;
      if (!el || skip.has(el.tagName)) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
      if (el.closest('[hidden]')) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      if (![...range.getClientRects()].some((r) => r.width > 0 && r.height > 0)) continue;
      rows.push({ text: text.slice(0, 40), size: parseFloat(cs.fontSize), tag: el.tagName, cls: String(el.className || '').slice(0, 50) });
    }
    const dist = {};
    for (const r of rows) dist[r.size] = (dist[r.size] || 0) + 1;
    const bodySelectors = ['.msg__bubble', '.msg__error span', '.chat__empty', '.chat__unsupported', '.composer__input', '.detail__value', '.task-row__title', '.agent-card__doing', '.stage-head p', '.task-empty'];
    const body = [...document.querySelectorAll(bodySelectors.join(','))]
      .filter((el) => el.getClientRects().length > 0 && !el.closest('[hidden]') && (el.value || el.textContent || '').trim())
      .map((el) => ({ sel: String(el.className).split(' ')[0], size: parseFloat(getComputedStyle(el).fontSize) }));
    const controls = [...document.querySelectorAll('.chat button, .chat textarea, .seg__item')].filter((el) => !el.closest('[hidden]') && el.getClientRects().length)
      .map((el) => ({ text: `${(el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 16)} ${String(el.className)}`.slice(0, 44), size: parseFloat(getComputedStyle(el).fontSize), h: Math.round(el.getBoundingClientRect().height) }));
    const placeholder = (() => { const el = document.querySelector('.composer__input'); return el ? parseFloat(getComputedStyle(el, '::placeholder').fontSize) : null; })();
    const sizes = Object.keys(dist).map(Number).sort((a, b) => a - b);
    return {
      textNodes: rows.length,
      distribution: Object.fromEntries(sizes.map((s) => [`${s}px`, dist[s]])),
      minFontSize: sizes[0] ?? null,
      under11: rows.filter((r) => r.size < 11),
      bodyRows: body,
      bodyTextMin: body.length ? Math.min(...body.map((r) => r.size)) : null,
      buttonSizes: [...new Set(controls.filter((c) => /cbtn/.test(c.text)).map((c) => c.size))],
      controls, placeholder,
    };
  };
  const out = {};
  for (const [name, agent, w, h] of [['claude-1440x900', 'claude', 1440, 900], ['dsh-1440x900', 'dsh', 1440, 900], ['claude-1280x800', 'claude', 1280, 800], ['claude-1936x1056', 'claude', 1936, 1056]]) {
    const page = await newPage(w, h);
    await openBoard(page, { agent });
    out[name] = await page.evaluate(audit);
    await page.close();
  }
  const first = out['claude-1440x900'];
  // 硬线：任何文字 >= 11px、正文 >= 13px、输入框 14px；按钮（.cbtn）按 Coss 是 14px；提示行里的文字链是辅助文字，>= 12px
  const allOk = Object.values(out).every((o) => o.minFontSize >= 11 && o.under11.length === 0 && o.bodyTextMin >= 13 && o.placeholder >= 14
    && o.controls.filter((c) => /cbtn/.test(c.text)).every((c) => c.size >= 13) && o.controls.every((c) => c.size >= 12));
  save('d5-fonts', { generatedAt: new Date().toISOString(), url: URL, states: out, pass: allOk });
  record('D5', '字号实测 min >= 11px，正文 >= 13px（交脚本）', allOk,
    `1440x900：文本节点 ${first.textNodes} 个，分布 ${JSON.stringify(first.distribution)}；最小 ${first.minFontSize}px，<11px 的 ${first.under11.length} 个\n正文最小 ${first.bodyTextMin}px（气泡 / 报错说明 / 任务标题 / Agent 卡说明）；输入框 ${first.placeholder}px；按钮字号 ${JSON.stringify(first.buttonSizes)}\n四种视口全部达标=${allOk}`);
}

/* ============================ D6 按钮逐个点 ============================ */
{
  const page = await newPage();
  await openBoard(page, { agent: 'dsh' });
  await page.evaluate(() => localStorage.removeItem('soda-board.agent'));
  const buttons = await page.$$eval('button', (els) => els.map((el, index) => ({
    index,
    text: (el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim(),
    cls: String(el.className || '').slice(0, 60),
    act: el.dataset.act || null,
    hidden: el.closest('[hidden]') != null || el.hidden,
  })));
  const rows = [];
  for (const b of buttons) {
    if (b.hidden) { rows.push({ ...b, skipped: 'hidden（另有专项：停止 / 条件出现的按钮）' }); continue; }
    await openBoard(page, { agent: 'dsh' });
    // 两个「本来就在这个状态」的按钮，先把状态拨开再点，反应才看得见：
    //   已选中的 Agent 卡 → 先把焦点移走（点卡片会把焦点放回输入框）；当前页签「对话」→ 先滚到顶（点它回到底部最新一条）
    if (b.cls.includes('agent-card') || b.cls.includes('seg__item')) await page.evaluate(() => document.activeElement && document.activeElement.blur());
    if (b.cls.includes('seg__item')) await page.evaluate(() => { const body = document.querySelector('.chat__body'); if (body) body.scrollTop = 0; });
    await page.waitForTimeout(120);
    const before = await sig(page);
    const loc = page.locator('button').nth(b.index);
    let note = '';
    try {
      if (await loc.isDisabled()) {
        // 只有「输入框是空的所以发送键不可用」是合理的禁用：打上字它必须立刻可用
        if (b.act === 'send') {
          await page.fill('.composer__input', '只回复两个字：收到（按钮自检）');
          const enabled = await page.evaluate(() => !document.querySelector('.cbtn[data-act="send"]').disabled);
          if (!enabled) throw new Error('输入框有字了发送键还是禁用');
          note = '空输入时禁用 → 打字后可用 → 点击发送';
        } else {
          rows.push({ ...b, disabled: true });
          continue;
        }
      }
      await loc.scrollIntoViewIfNeeded({ timeout: 4000 });
      await loc.click({ timeout: 5000 });
    } catch (err) { note += ` 点击报错：${err.message.split('\n')[0]}`; }
    if (b.act === 'send') {
      await page.waitForFunction((n) => document.querySelectorAll('.msg').length > n, before.chatMsgs, { timeout: 15000 }).catch(() => {});
      await waitTurnDone(page, 180000).catch(() => {});
    }
    await page.waitForTimeout(b.cls.includes('btn-refresh') ? 1100 : 700);
    const after = await sig(page);
    const changed = Object.keys(before).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    rows.push({ ...b, note, changed: changed.length > 0, changedKeys: changed, after: { toast: after.toast, chatState: after.chatState, chatMsgs: after.chatMsgs, chatTab: after.chatTab, selectedAgent: after.selectedAgent, selectedTask: after.selectedTask, detailHead: after.detailHead, detailPanelHead: after.detailPanelHead } });
  }
  // 专项：停止（只在执行中出现）→ 点了本轮真的停 → 再点「重试」真的重发
  await openBoard(page, { agent: 'dsh' });
  await page.fill('.composer__input', '写一篇 800 字的短文，题目《海边的灯塔》。不要用工具。');
  await page.click('.cbtn[data-act="send"]');
  await page.waitForSelector('.cbtn[data-act="cancel"]:not([hidden])', { timeout: 15000 });
  const stopBefore = await sig(page);
  await page.click('.cbtn[data-act="cancel"]');
  const stopped = await waitTurnDone(page, 90000);
  await page.waitForTimeout(600);
  const stopAfter = await sig(page);
  const retryVisible = await page.locator('.chat [data-act="retry"]').count();
  let retryRow = { skipped: '没有出现重试按钮' };
  if (retryVisible > 0) {
    const before = await sig(page);
    await page.locator('.chat [data-act="retry"]').last().click();
    await page.waitForFunction((n) => document.querySelectorAll('.msg').length > n, before.chatMsgs, { timeout: 15000 }).catch(() => {});
    await waitTurnDone(page, 240000).catch(() => {});
    await page.waitForTimeout(500);
    const after = await sig(page);
    retryRow = { text: '重试', changed: before.chatMsgs < after.chatMsgs, before: { msgs: before.chatMsgs, state: before.chatState }, after: { msgs: after.chatMsgs, state: after.chatState } };
  }
  const noReaction = rows.filter((r) => !r.hidden && !r.changed && !r.skipped);
  const stopOk = /^(中断|失败)/.test(stopped) && stopBefore.chatState !== stopAfter.chatState;
  const retryOk = retryRow.changed === true;
  save('d6-buttons', { generatedAt: new Date().toISOString(), url: URL, buttons: rows, stop: { before: stopBefore.chatState, after: stopAfter.chatState, final: stopped }, retry: retryRow, pageErrors });
  for (const r of rows) log(`      ${r.skipped ? '跳过' : r.disabled ? '禁用' : r.changed ? 'PASS' : 'FAIL'}  #${String(r.index).padStart(2)} ${(r.text || r.cls).slice(0, 22).padEnd(22)} ${r.skipped || r.note || (r.changedKeys || []).join(', ')}`);
  record('D6', '所有按钮点击有反应（交脚本逐个点）', noReaction.length === 0 && stopOk && retryOk && pageErrors.length === 0,
    `按钮 ${rows.length} 个：有反应 ${rows.filter((r) => r.changed).length}，合理禁用 ${rows.filter((r) => r.disabled).length}（仅空输入时的发送键），无反应 ${noReaction.length}\n停止：点之前「${brief(stopBefore.chatState, 40)}」→ 点之后「${stopped}」\n重试：${retryRow.changed ? `点了之后消息 ${retryRow.before.msgs} → ${retryRow.after.msgs} 条，状态「${retryRow.after.state}」` : '没验到'}\n页面错误 ${pageErrors.length} 个`);
  await page.close();
}

/* ============================ D7 截图 + 版式 ============================ */
{
  const overlapFn = () => {
    const skipTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'TITLE']);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const boxes = [];
    let node;
    let idx = 0;
    while ((node = walker.nextNode())) {
      const text = node.nodeValue.replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const el = node.parentElement;
      if (!el || skipTags.has(el.tagName)) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (el.closest('.toast') && !el.closest('.toast').classList.contains('is-show')) continue;
      if (el.closest('[hidden]')) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const clip = (r) => {
        let box = { x: r.x, y: r.y, w: r.width, h: r.height };
        let p = el;
        while (p && p !== document.documentElement) {
          const s = getComputedStyle(p);
          if (s.overflowX !== 'visible' || s.overflowY !== 'visible') {
            const pr = p.getBoundingClientRect();
            const left = pr.left + p.clientLeft; const top = pr.top + p.clientTop;
            const x1 = Math.max(box.x, left); const y1 = Math.max(box.y, top);
            const x2 = Math.min(box.x + box.w, left + p.clientWidth); const y2 = Math.min(box.y + box.h, top + p.clientHeight);
            box = { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) };
          }
          p = p.parentElement;
        }
        return { x: Math.max(box.x, 0), y: Math.max(box.y, 0), w: Math.min(box.w, innerWidth), h: Math.min(box.h, innerHeight) };
      };
      for (const raw of [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5)) {
        const r = clip(raw);
        if (r.w <= 0.5 || r.h <= 0.5) continue;
        boxes.push({ node: idx, text: text.slice(0, 50), cls: String(el.className || '').slice(0, 50), x: r.x, y: r.y, w: r.w, h: r.h });
      }
      idx += 1;
    }
    const overlaps = [];
    for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i]; const b = boxes[j];
      if (a.node === b.node) continue;
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox > 1.5 && oy > 1.5 && ox * oy > 4) overlaps.push({ area: +(ox * oy).toFixed(2), a: a.text, b: b.text, aCls: a.cls, bCls: b.cls });
    }
    return { textNodes: idx, overlapCount: overlaps.length, overlaps: overlaps.slice(0, 20) };
  };
  const fitFn = () => {
    const panel = document.querySelector('.chat').getBoundingClientRect();
    const body = document.querySelector('.chat__body');
    const over = [...document.querySelectorAll('.msg__bubble, .msg__error, .composer')].filter((el) => {
      if (el.closest('[hidden]')) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && (r.right > panel.right + 1 || r.left < panel.left - 1);
    }).map((el) => el.className);
    return { panel: { x: Math.round(panel.x), w: Math.round(panel.width), h: Math.round(panel.height) }, bodyOverflowX: body.scrollWidth - body.clientWidth, overflowing: over, docOverflowX: document.documentElement.scrollWidth - innerWidth };
  };
  const states = {};
  const shots = [['claude', 'claude', 1440, 900, 'd7-claude-1440x900.png'], ['dsh', 'dsh', 1440, 900, 'd7-dsh-1440x900.png'], ['claude-1280x800', 'claude', 1280, 800, 'd7-claude-1280x800.png'], ['claude-1936x1056', 'claude', 1936, 1056, 'd7-claude-1936x1056.png']];
  for (const [name, agent, w, h, file] of shots) {
    const page = await newPage(w, h);
    await openBoard(page, { agent });
    await page.waitForFunction(() => !document.querySelector('#toast')?.classList.contains('is-show'), { timeout: 6000 }).catch(() => {});   // 等 toast 消失再量、再截
    await page.waitForTimeout(400);
    states[name] = { ...(await page.evaluate(overlapFn)), fit: await page.evaluate(fitFn) };
    await page.screenshot({ path: resolve(DOC, file) });
    await page.close();
  }
  { // 「详情」页签与任务详情两种状态也查重叠
    const page = await newPage();
    await openBoard(page, { agent: 'claude' });
    await page.click('.seg__item[data-tab="detail"]');
    await page.waitForTimeout(350);
    states.detailTab = { ...(await page.evaluate(overlapFn)), fit: await page.evaluate(fitFn) };
    await page.screenshot({ path: resolve(DOC, 'd7-detail-tab-1440x900.png') });
    await page.click('.task-row');
    await page.waitForFunction(() => !document.querySelector('#toast')?.classList.contains('is-show'), { timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(200);
    states.taskDetail = await page.evaluate(overlapFn);
    await page.screenshot({ path: resolve(DOC, 'd7-task-detail-1440x900.png') });
    await page.close();
  }
  // 另两种面板状态：没接入对话的 Agent（如实写原因、没有输入框）、新对话的空状态
  const extras = {};
  {
    const page = await newPage();
    await openBoard(page, { agent: 'codex' });
    await page.waitForFunction(() => !document.querySelector('#toast')?.classList.contains('is-show'), { timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(400);
    extras.codex = await page.evaluate(() => ({
      state: document.querySelector('.chat__state')?.textContent || '',
      text: (document.querySelector('.chat__unsupported')?.innerText || '').replace(/\s+/g, ' '),
      hasInput: Boolean(document.querySelector('.composer__input')),
    }));
    await page.screenshot({ path: resolve(DOC, 'd7-codex-unsupported-1440x900.png') });
    await openBoard(page, { agent: 'claude' });
    await page.click('.chat [data-act="new"]');
    await page.waitForFunction(() => !document.querySelector('#toast')?.classList.contains('is-show'), { timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(400);
    extras.empty = await page.evaluate(() => ({
      state: document.querySelector('.chat__state')?.textContent || '',
      text: (document.querySelector('.chat__empty')?.innerText || '').replace(/\s+/g, ' '),
      hasInput: Boolean(document.querySelector('.composer__input')),
      msgs: document.querySelectorAll('.msg').length,
    }));
    await page.screenshot({ path: resolve(DOC, 'd7-new-chat-empty-1440x900.png') });
    await page.close();
  }
  save('d7-states', extras);
  const total = Object.values(states).reduce((n, s) => n + s.overlapCount, 0);
  const fitBad = Object.values(states).filter((s) => s.fit).filter((s) => s.fit.bodyOverflowX > 1 || s.fit.overflowing.length > 0 || s.fit.docOverflowX > 0);
  save('d7-layout', { generatedAt: new Date().toISOString(), url: URL, states, overlapTotal: total, fitProblems: fitBad.map((s) => s.fit) });
  record('D7', '截图 1440x900（另附 1280x800 / 1936x1056）；文字无重叠、气泡不出面板', total === 0 && fitBad.length === 0
    && extras.codex.hasInput === false && /不支持对话/.test(extras.codex.text) && extras.empty.hasInput === true && extras.empty.msgs === 0 && /^未知/.test(extras.empty.state),
    `截图：d7-claude-1440x900.png、d7-dsh-1440x900.png、d7-claude-1280x800.png、d7-claude-1936x1056.png、d7-detail-tab-1440x900.png、d7-task-detail-1440x900.png、d7-codex-unsupported-1440x900.png、d7-new-chat-empty-1440x900.png\n文字重叠总数 ${total}；横向溢出 / 出面板的问题 ${fitBad.length} 处\n未接入的 Codex：状态「${extras.codex.state}」／「${extras.codex.text.slice(0, 50)}」／有输入框=${extras.codex.hasInput}\n新对话空状态：状态「${extras.empty.state}」／消息 ${extras.empty.msgs} 条／有输入框=${extras.empty.hasInput}`);
}

await browser.close();
save('summary', { generatedAt: new Date().toISOString(), url: URL, results, pageErrors, pass: results.filter((r) => r.pass).length, total: results.length });
log(`\nD1-D7：${results.filter((r) => r.pass).length}/${results.length} 通过；页面错误 ${pageErrors.length} 个`);
process.exit(results.every((r) => r.pass) && pageErrors.length === 0 ? 0 : 1);
