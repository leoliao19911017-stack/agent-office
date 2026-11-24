/* Soda Office · Agent 对话面板（Coss UI）
   挂在看板右列（#detail-panel）：点中间的 Agent 卡，这里就是与它的真对话。
   数据源（都是真实 API，不编造）：
     GET  /api/chat/threads?agent_id=…            这个 Agent 最近的一个对话
     POST /api/chat/threads                        第一句发出去时才建对话
     GET  /api/chat/threads/:id/messages           历史（刷新页面也从这里拉）
     POST /api/chat/threads/:id/messages           发消息 → turn_id
     GET  /api/chat/turns/:id/stream               SSE：snapshot → 补发 → 实时（started / delta / completed / error …）
     POST /api/chat/turns/:id/cancel               停止本轮
   口径：状态只认证据——取不到状态显示「未知」，绝不显示「空闲」；
         断流显示「连接中断，正在重连」；EventSource 自动带 Last-Event-ID 续订，内容不丢不重。
   样式参数见 board-chat.css（docs/Coss-UI-设计参数.md）。 */

(function () {
  'use strict';

  const SVG = {
    send: '<svg class="ui-icon" aria-hidden="true" width="16" height="16" viewBox="0 0 20 20"><path d="M3.4 10h12.2M11 5.4 15.8 10 11 14.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    stop: '<svg class="ui-icon" aria-hidden="true" width="14" height="14" viewBox="0 0 20 20"><rect x="5" y="5" width="10" height="10" rx="2" fill="currentColor"/></svg>',
    refresh: '<svg class="ui-icon" aria-hidden="true" width="14" height="14" viewBox="0 0 20 20"><path d="M16.2 8.1A6.4 6.4 0 1 0 16 12.7M16.2 3.9v4.4h-4.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };
  const INITIALS = { claude: 'CL', dsh: 'DS', codex: 'CX', hermes: 'HE' };
  const ACTIVE = new Set(['queued', 'starting', 'restoring', 'running', 'tool_running', 'approval_required']);
  const POLL_MS = 1500;

  /** 轮次状态的短说法（与 chat-state.mjs 的十态一一对应，具体原因另带） */
  const TURN_TEXT = {
    queued: '排队中', starting: '正在启动 Agent', restoring: '正在恢复会话', running: '正在回答',
    tool_running: '正在执行工具', approval_required: '等待确认（讨论模式一律拒绝）',
    completed: '回答完成', rate_limited: '请求受限', interrupted: '已中断', failed: '失败', unknown: '结果未知',
  };
  /** 用户消息：stored 还没交出去 / sent 已交给模型 / failed 没发出去 / unknown 送达情况无法确认 */
  const USER_TEXT = { stored: '待发送', sent: '', failed: '未发出', unknown: '送达情况未知' };
  /** 讨论模式能做到什么，按 provider 如实写（hermes 没开 file/terminal，不能替它吹「能读代码」） */
  const DISCUSS_NOTE = {
    hermes: '讨论模式：能对话、能续聊，能查网与历史会话；不开放本机文件与终端，不会改你的文件。',
  };
  const MSG_TEXT = {
    streaming: '正在接收', complete: '', partial: '未完成（已保留收到的部分）', failed: '没有回复',
    rate_limited: '请求受限', interrupted: '已中断', unknown: '结果未知',
  };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (sel, root = document) => root.querySelector(sel);

  let root = null;
  let opts = {};
  let unsupported = {};
  /** 每个 Agent 一份对话状态：切 Agent 就是切它自己的 thread */
  const chats = new Map();

  /* ---------------------------------------------------------------- 数据层 */

  async function api(path, { method = 'GET', body } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(path, {
        method, cache: 'no-store', signal: ctrl.signal,
        headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json; charset=utf-8' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      if (!res.ok) {
        const err = new Error((data && data.error) || `HTTP ${res.status}`);
        err.status = res.status;
        err.code = data && data.code;
        err.data = data;
        throw err;
      }
      return data;
    } finally { clearTimeout(timer); }
  }

  function chatOf(agentId) {
    if (!chats.has(agentId)) {
      chats.set(agentId, {
        agentId, threadId: null, thread: null, fresh: false, messages: [], turns: [], threadStatus: null,
        loading: false, loadError: null, loadSeq: 0, stream: null, draft: '', tab: 'chat',
        el: null, sending: false, sendError: null,
      });
    }
    return chats.get(agentId);
  }

  /** 这个 Agent 最近的一个对话（没有就是 null：第一句发出去时才建） */
  async function pickThread(agentId) {
    const data = await api(`/api/chat/threads?agent_id=${encodeURIComponent(agentId)}`);
    if (data && data.unsupported) unsupported = { ...unsupported, ...data.unsupported };
    const list = (data && Array.isArray(data.threads) ? data.threads : []).filter((t) => t.agent_id === agentId);
    return list[0] || null;
  }

  /** 拉全部历史。带序号防乱序：快速切 Agent 时，旧响应不许覆盖新的 */
  async function reload(chat) {
    const seq = ++chat.loadSeq;
    chat.loading = true;
    chat.loadError = null;
    render(chat);
    try {
      if (!chat.threadId) {
        const picked = chat.fresh ? null : await pickThread(chat.agentId);
        if (seq !== chat.loadSeq) return;
        if (!picked) {
          chat.thread = null; chat.messages = []; chat.turns = []; chat.threadStatus = null; chat.loading = false;
          render(chat);
          return;
        }
        chat.threadId = picked.thread_id;
      }
      const data = await api(`/api/chat/threads/${encodeURIComponent(chat.threadId)}/messages`);
      if (seq !== chat.loadSeq) return;
      if (!data || !Array.isArray(data.messages)) throw new Error('接口没有返回消息列表');
      chat.thread = data.thread;
      chat.messages = data.messages;
      chat.turns = data.turns || [];
      chat.threadStatus = data.thread_status || null;
      chat.loading = false;
      // 页面打开 / 刷新时有轮次还在进行：接上它的实时流（EventSource 会从头补发这一轮的事件）
      const activeId = chat.threadStatus && chat.threadStatus.active_turn_id;
      if (activeId && (!chat.stream || chat.stream.turnId !== activeId)) openStream(chat, activeId);
    } catch (err) {
      if (seq !== chat.loadSeq) return;
      chat.loading = false;
      chat.loadError = `取不到状态：${err.message}`;
    }
    render(chat);
  }

  /* ---------------------------------------------------------------- SSE */

  function openStream(chat, turnId) {
    closeStream(chat);
    const st = {
      turnId, mode: 'sse', es: null, poll: null, done: false, conn: 'connecting', status: 'starting',
      text: '', baseSeq: 0, seen: new Set(), tools: [], retry: null, error: null, stalled: null, queuedAhead: 0, pollError: null,
    };
    chat.stream = st;
    if (!window.EventSource) { startPolling(chat, st); return; }
    const es = new EventSource(`/api/chat/turns/${encodeURIComponent(turnId)}/stream`);
    st.es = es;
    es.onopen = () => { st.conn = 'live'; render(chat); };
    es.onerror = () => {
      // 浏览器正在自动重连（会带 Last-Event-ID）：如实显示「连接中断，正在重连」；连都连不上（404/405）就退回轮询
      if (es.readyState === EventSource.CONNECTING) { st.conn = 'reconnecting'; render(chat); return; }
      if (st.done) return;
      es.close();
      startPolling(chat, st);
    };
    // 服务端发的是带名字的事件（event: started / delta / completed …）：onmessage 只收无名事件，必须逐个类型监听
    const onEvent = (e) => {
      let ev;
      try { ev = JSON.parse(e.data); } catch { return; }
      if (st.done) return;
      if (ev.seq != null) {
        if (st.seen.has(ev.seq)) return;                      // 同一个 seq 只处理一次
        st.seen.add(ev.seq);
      }
      switch (ev.type || e.type) {
        case 'snapshot':
          st.status = ev.status;
          st.text = ev.text || '';
          st.baseSeq = ev.event_seq || 0;
          st.queuedAhead = ev.queued_ahead || 0;
          if (ev.error) st.error = ev.error;
          break;
        case 'delta':
          if (ev.seq <= st.baseSeq) break;                    // 已经在快照全文里了
          st.text = ev.replace ? ev.text : st.text + ev.text;
          if (st.status !== 'running') st.status = 'running';
          break;
        case 'started':
        case 'restoring':
          st.status = ev.status || (ev.type === 'restoring' ? 'restoring' : 'starting');
          st.queuedAhead = 0;
          break;
        case 'status':
          if (ev.status) st.status = ev.status;
          if (ev.stalled) st.stalled = ev.message || '长时间无新事件，正在核实';
          else if (ev.status && ev.status !== 'rate_limited') st.stalled = null;
          break;
        case 'tool':
          if (ev.phase !== 'result') st.tools.push({ seq: ev.seq, name: ev.name || 'tool' });
          break;
        case 'retry':
          st.retry = ev;
          st.status = 'rate_limited';
          break;
        case 'completed':
          st.status = 'completed';
          finishStream(chat, 'completed');
          return;
        case 'error':
          st.error = ev;
          st.status = ev.status || 'failed';
          finishStream(chat, 'error');
          return;
        default:
          break;
      }
      render(chat);
    };
    for (const type of ['snapshot', 'started', 'restoring', 'status', 'delta', 'tool', 'retry', 'completed', 'error', 'message']) es.addEventListener(type, onEvent);
    render(chat);
  }

  /** 没有 EventSource、或流连不上：退回轮询（同一份数据，只是不逐段了） */
  function startPolling(chat, st) {
    st.mode = 'poll';
    st.conn = 'polling';
    const tick = async () => {
      if (st.done || chat.stream !== st) return;
      try {
        const data = await api(`/api/chat/turns/${encodeURIComponent(st.turnId)}`);
        if (st.done || chat.stream !== st) return;
        st.pollError = null;
        st.status = data.turn.status;
        st.text = (data.assistant_message && data.assistant_message.content) || '';
        if (data.turn.error) st.error = data.turn.error;
        render(chat);
        if (!ACTIVE.has(st.status)) { finishStream(chat, st.status === 'completed' ? 'completed' : 'error'); return; }
      } catch (err) {
        st.pollError = err.message;
        render(chat);
      }
      st.poll = setTimeout(tick, POLL_MS);
    };
    render(chat);
    tick();
  }

  function closeStream(chat) {
    const st = chat.stream;
    if (!st) return;
    st.done = true;
    if (st.es) { try { st.es.close(); } catch { /* 已关闭 */ } }
    if (st.poll) clearTimeout(st.poll);
    chat.stream = null;
  }

  /** 一轮走到终态：关流、把最终全文落到本地消息上立刻可见，再去库里核对一遍（以库为准） */
  async function finishStream(chat, kind) {
    const st = chat.stream;
    if (!st || st.done) return;
    const finalText = st.text;
    closeStream(chat);
    const asst = chat.messages.find((m) => m.role === 'assistant' && m.turn_id === st.turnId);
    if (asst) {
      asst.content = finalText;
      asst.status = kind === 'completed' ? 'complete' : (st.status === 'rate_limited' ? 'rate_limited' : (st.status === 'failed' ? 'failed' : (st.status === 'unknown' ? 'unknown' : 'interrupted')));
      if (st.error) asst.error = st.error;
    }
    const user = chat.messages.find((m) => m.role === 'user' && m.turn_id === st.turnId);
    if (user && user.status === 'stored') user.status = 'sent';
    if (st.error && st.error.kind && ['cli_start_failed', 'credentials_missing', 'auth_failed', 'session_not_found'].includes(st.error.kind) && user) user.status = 'failed';
    const turn = chat.turns.find((t) => t.turn_id === st.turnId);
    if (turn) {
      turn.status = st.status;
      turn.error = st.error || null;
      turn.ended_at = new Date().toISOString();
    }
    render(chat);
    await reload(chat);
  }

  /* ---------------------------------------------------------------- 动作 */

  async function ensureThread(chat) {
    if (chat.threadId && chat.thread) return chat.thread;
    const data = await api('/api/chat/threads', { method: 'POST', body: { agent_id: chat.agentId } });
    if (!data || !data.thread_id) throw new Error('建对话失败：接口没有返回 thread_id');
    chat.threadId = data.thread_id;
    chat.thread = data.thread;
    chat.fresh = false;
    return chat.thread;
  }

  async function send(chat, text) {
    const content = String(text || '').trim();
    if (!content || chat.sending) return;
    chat.sending = true;
    chat.sendError = null;
    chat.draft = '';
    const input = $('.composer__input', chat.el);
    if (input) { input.value = ''; autosize(input); }
    render(chat);
    try {
      const thread = await ensureThread(chat);
      const data = await api(`/api/chat/threads/${encodeURIComponent(thread.thread_id)}/messages`, { method: 'POST', body: { content } });
      if (!data || !data.turn_id) throw new Error('发消息失败：接口没有返回 turn_id');
      // 服务端在返回 202 之前已经把这句话落库：立刻重拉，自己的气泡马上出现；实时流开在哪一轮由 reload 统一判断
      await reload(chat);
    } catch (err) {
      chat.sendError = `没发出去：${err.message}`;
      chat.draft = content;                                   // 没发出去的字还给输入框
    } finally {
      chat.sending = false;
      render(chat);
      const input2 = $('.composer__input', chat.el);
      if (input2 && chat.draft && input2.value !== chat.draft) { input2.value = chat.draft; autosize(input2); }
    }
  }

  async function cancel(chat) {
    const st = chat.stream;
    if (!st) return;
    try {
      await api(`/api/chat/turns/${encodeURIComponent(st.turnId)}/cancel`, { method: 'POST', body: {} });
      // 真正的终态由流上的 error(cancelled) 带回来，这里不抢先改状态
    } catch (err) {
      opts.toast && opts.toast(`停止失败：${err.message}`);
    }
  }

  function newChat(chat) {
    closeStream(chat);
    chat.loadSeq += 1;
    chat.threadId = null; chat.thread = null; chat.fresh = true;
    chat.messages = []; chat.turns = []; chat.threadStatus = null; chat.sendError = null; chat.loading = false; chat.loadError = null;
    render(chat);
    opts.toast && opts.toast(`已为 ${meta(chat.agentId).name} 开新对话：下一句会新开一个会话，之前的上下文不带过去`);
  }

  function retry(chat, turnId) {
    const user = chat.messages.find((m) => m.role === 'user' && m.turn_id === turnId);
    if (user) send(chat, user.content);
  }

  /* ---------------------------------------------------------------- 文本 */

  function meta(agentId) {
    return (opts.meta && opts.meta(agentId)) || { name: agentId, short: String(agentId).toUpperCase() };
  }
  const initials = (agentId) => INITIALS[agentId] || String(meta(agentId).short || meta(agentId).name || agentId).slice(0, 2).toUpperCase();
  const pad = (n) => String(n).padStart(2, '0');
  function clock(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /** 轮次状态 + 错误说成一句人话（气泡下面的小字） */
  function turnNote(turn, st) {
    const status = st ? st.status : (turn ? turn.status : null);
    const err = (st && st.error) || (turn && turn.error) || null;
    if (status === 'queued') {
      const ahead = turn && turn.queued_ahead != null ? turn.queued_ahead : (st ? st.queuedAhead : 0);
      return ahead > 0 ? `排队中（前面还有 ${ahead} 条）` : '排队中';
    }
    if (status === 'rate_limited') {
      const hint = (st && st.retry && st.retry.retry_hint) || (err && err.retry_hint) || (err && err.label) || '请求受限';
      return `请求受限 · ${hint}`;
    }
    if (st && st.stalled && ACTIVE.has(status)) return st.stalled;
    return TURN_TEXT[status] || status || '';
  }

  /** 头部那一行「五态 + 说明」：只认证据，取不到就是未知 */
  function threadState(chat) {
    const st = chat.stream;
    if (chat.loadError) return { tone: 'unknown', label: '未知', detail: chat.loadError };
    if (!chat.threadId && !st) {
      // 没有对话 = 没有证据：状态就是未知，不显示「空闲」
      return { tone: 'unknown', label: '未知', detail: unsupported[chat.agentId] ? '没有接入对话' : '还没有对话记录：没有证据，不显示空闲' };
    }
    if (st) {
      if (st.status === 'queued') return { tone: 'queued', label: '排队', detail: turnNote(null, st) };
      if (st.status === 'rate_limited') return { tone: 'limited', label: '请求受限', detail: (st.retry && st.retry.retry_hint) || 'CLI 正在自动重试' };
      const last = st.tools.length ? ` · 刚调用了 ${st.tools[st.tools.length - 1].name}` : '';
      return { tone: 'running', label: '执行中', detail: `${st.stalled || TURN_TEXT[st.status] || st.status}${last}` };
    }
    const ts = chat.threadStatus;
    if (!ts) return { tone: 'unknown', label: '未知', detail: '取不到状态' };
    if (ts.status === 'completed') return { tone: 'completed', label: '完成', detail: '回答完成' };
    if (ts.status === 'rate_limited') {
      const why = ts.error_kind === 'quota_exhausted' ? '额度已用尽' : '请求被限流';
      return { tone: 'limited', label: '请求受限', detail: `${why}${ts.retry_hint ? ` · ${ts.retry_hint}` : (ts.reason ? ` · ${ts.reason}` : '')}` };
    }
    if (ts.status === 'failed' || ts.status === 'interrupted') {
      const last = chat.turns.find((t) => t.turn_id === ts.turn_id);
      const lab = (last && last.error && last.error.label) || TURN_TEXT[ts.status];
      return { tone: 'failed', label: ts.status === 'failed' ? '失败' : '中断', detail: `${lab}${ts.retry_hint ? ` · ${ts.retry_hint}` : ''}` };
    }
    if (ACTIVE.has(ts.status)) return { tone: 'running', label: '执行中', detail: TURN_TEXT[ts.status] || ts.status };
    return { tone: 'unknown', label: '未知', detail: ts.reason || '执行结果未确认' };
  }

  /* ---------------------------------------------------------------- Markdown（安全渲染） */

  function inlineMd(text) {
    return text
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  }

  /** 只认回复里常见的几种写法；输入先整体转义，所以不会注入标签 */
  function renderMd(src) {
    const escaped = esc(src);
    const out = [];
    const chunks = escaped.split(/```[^\n]*\n?/);
    for (let i = 0; i < chunks.length; i += 1) {
      if (i % 2 === 1) { out.push(`<pre><code>${chunks[i].replace(/\n$/, '')}</code></pre>`); continue; }
      const lines = chunks[i].split('\n');
      let para = [];
      let list = null;        // 'ul' | 'ol'
      let quote = [];
      const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inlineMd).join('<br>')}</p>`); para = []; } };
      const flushList = () => { if (list) { out.push(list === 'ul' ? '</ul>' : '</ol>'); list = null; } };
      const flushQuote = () => { if (quote.length) { out.push(`<blockquote>${quote.map(inlineMd).join('<br>')}</blockquote>`); quote = []; } };
      const flushAll = () => { flushPara(); flushList(); flushQuote(); };
      for (const raw of lines) {
        const line = raw.replace(/\s+$/, '');
        if (!line.trim()) { flushAll(); continue; }
        const h = line.match(/^(#{1,6})\s+(.*)$/);
        if (h) { flushAll(); out.push(h[1].length <= 2 ? `<h3>${inlineMd(h[2])}</h3>` : `<h4>${inlineMd(h[2])}</h4>`); continue; }
        if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { flushAll(); out.push('<hr>'); continue; }
        const q = line.match(/^\s*&gt;\s?(.*)$/);
        if (q) { flushPara(); flushList(); quote.push(q[1]); continue; }
        flushQuote();
        const ul = line.match(/^\s*[-*+]\s+(.*)$/);
        const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
        if (ul || ol) {
          flushPara();
          const kind = ul ? 'ul' : 'ol';
          if (list && list !== kind) flushList();
          if (!list) { out.push(kind === 'ul' ? '<ul>' : '<ol>'); list = kind; }
          out.push(`<li>${inlineMd(ul ? ul[1] : ol[1])}</li>`);
          continue;
        }
        flushList();
        para.push(line);
      }
      flushAll();
    }
    return out.join('');
  }

  /* ---------------------------------------------------------------- 渲染 */

  const timeHtml = (iso) => `<time datetime="${esc(iso)}" title="${esc(iso)}">${esc(clock(iso))}</time>`;

  function messageHtml(chat, m) {
    if (m.role === 'system') {
      return `<div class="chat__note" data-mid="${esc(m.message_id)}">${esc(m.content)}</div>`;
    }
    const turn = chat.turns.find((t) => t.turn_id === m.turn_id) || null;
    const st = chat.stream && chat.stream.turnId === m.turn_id ? chat.stream : null;
    if (m.role === 'user') {
      // 这一轮为什么失败，只在助手消息那一侧完整写一次（下面 assistant 分支）；用户这边只标「没发出去」
      const failed = m.status === 'failed';
      // 排队中就说排队（哪怕消息还是 stored）：这比「待发送」准确
      let note = turn && turn.status === 'queued' ? turnNote(turn, st) : (USER_TEXT[m.status] || '');
      return `<div class="msg msg--out" data-mid="${esc(m.message_id)}" data-status="${esc(m.status)}">
        <div class="msg__bubble">${esc(m.content)}</div>
        <div class="msg__meta">${note ? `<span class="msg__status" data-tone="${turn && turn.status === 'queued' ? 'queued' : 'failed'}">${esc(note)}</span>` : ''}${timeHtml(m.created_at)}</div>
      </div>`;
    }
    // assistant：左对齐，头像 + 姓名
    const live = Boolean(st);
    const text = live ? st.text : m.content;
    const err = (live && st.error) || (!live && (m.error || (turn && turn.error))) || null;
    const tone = !err ? '' : (st && st.status === 'rate_limited') || m.status === 'rate_limited' ? 'limited' : (st && st.status === 'unknown') || m.status === 'unknown' ? 'unknown' : 'failed';
    let note = live ? (st.status === 'running' ? (st.stalled || '') : turnNote(null, st)) : (MSG_TEXT[m.status] || (turn && ACTIVE.has(turn.status) ? turnNote(turn, null) : ''));
    const tools = live && st.tools.length ? `<div class="msg__activity">${esc(st.tools.slice(-3).map((t) => `调用工具 ${t.name}`).join(' · '))}</div>` : '';
    const bubble = (text || !live)
      ? `<div class="msg__bubble msg__bubble--md" data-live="${live ? '1' : '0'}">${renderMd(text)}${live && st.conn !== 'reconnecting' ? '<span class="caret" aria-hidden="true"></span>' : ''}</div>` : '';
    const retryBtn = err && !live && err.retryable !== false ? `<button type="button" class="cbtn" data-act="retry" data-turn="${esc(m.turn_id)}">重试</button>` : '';
    const errorBox = err && !live
      ? `<div class="msg__error" data-tone="${tone}" role="status"><div><b>${esc(err.label || '出错了')}</b><span>${esc(err.retry_hint ? `${err.retry_hint} · ` : '')}${esc(err.message || err.text || '')}</span></div>${retryBtn}</div>` : '';
    return `<div class="msg msg--in" data-mid="${esc(m.message_id)}" data-live="${live ? '1' : '0'}">
      <span class="msg__avatar" aria-hidden="true">${esc(initials(chat.agentId))}</span>
      <div class="msg__col">
        <div class="msg__name">${esc(meta(chat.agentId).name)}</div>
        ${bubble}
        ${tools}
        ${errorBox}
        <div class="msg__meta">${note ? `<span class="msg__status" data-tone="${live ? (st.status === 'rate_limited' ? 'limited' : 'running') : tone}">${esc(note)}</span>` : ''}${timeHtml(m.created_at)}</div>
      </div>
    </div>`;
  }

  function bodyHtml(chat) {
    if (chat.loading && !chat.messages.length) return '<div class="chat__empty">正在读取历史消息…</div>';
    if (chat.loadError && !chat.messages.length) {
      return `<div class="chat__empty"><b>读不到对话记录</b>${esc(chat.loadError)}<br>不是没有历史，是证据没到。<br><button type="button" class="cbtn" data-act="reload" style="margin-top:8px">${SVG.refresh}重新读取</button></div>`;
    }
    if (!chat.messages.length && !chat.stream) {
      return `<div class="chat__empty"><b>还没有和 ${esc(meta(chat.agentId).name)} 的对话</b>在下面写第一句就会开始。<br>${DISCUSS_NOTE[chat.agentId] || '讨论模式：它能读代码、能分析、能回答，不会改你的文件。'}</div>`;
    }
    return chat.messages.map((m) => messageHtml(chat, m)).join('');
  }

  function headHtml(chat) {
    const m = meta(chat.agentId);
    return `<header class="chat__head">
        <span class="chat__avatar" data-online="" aria-hidden="true">${esc(initials(chat.agentId))}</span>
        <div class="chat__who">
          <div class="chat__name">${esc(m.name)}</div>
          <div class="chat__state" data-tone="unknown" role="status" aria-live="polite"><i aria-hidden="true"></i><b>未知</b><span class="chat__state-detail">取不到状态</span></div>
        </div>
        ${unsupported[chat.agentId] && !chat.threadId ? '' : `<div class="seg" role="tablist" aria-label="面板内容">
          <button type="button" class="seg__item" role="tab" data-tab="chat" aria-selected="true">对话</button>
          <button type="button" class="seg__item" role="tab" data-tab="detail" aria-selected="false">详情</button>
        </div>`}
      </header>`;
  }

  function shellHtml(chat) {
    const m = meta(chat.agentId);
    return `<section class="chat" data-agent="${esc(chat.agentId)}" aria-label="与 ${esc(m.name)} 的对话">
      ${headHtml(chat)}
      <div class="chat__banner" data-kind="warn" hidden></div>
      <div class="chat__body"></div>
      <div class="chat__detail" hidden></div>
      <footer class="chat__composer">
        <div class="composer">
          <textarea class="composer__input" rows="1" placeholder="给 ${esc(m.name)} 发消息…" aria-label="给 ${esc(m.name)} 的消息" maxlength="20000"></textarea>
          <div class="composer__actions">
            <button type="button" class="cbtn cbtn--stop" data-act="cancel" hidden aria-label="停止本轮">${SVG.stop}停止</button>
            <button type="button" class="cbtn cbtn--primary" data-act="send" aria-label="发送">${SVG.send}发送</button>
          </div>
        </div>
        <div class="chat__hint">
          <span>Enter 发送 · Shift+Enter 换行 · 讨论模式（只读）</span>
          <span class="chat__hint-links"><button type="button" data-act="new">新对话</button><i aria-hidden="true">·</i><button type="button" data-act="reload">刷新记录</button></span>
        </div>
      </footer>
    </section>`;
  }

  /** 不支持对话的 Agent：如实说明是哪一条原因，不给能打字但发不出去的假输入框 */
  function unsupportedHtml(chat) {
    const m = meta(chat.agentId);
    return `<section class="chat" data-agent="${esc(chat.agentId)}" aria-label="${esc(m.name)} 不支持对话">
      ${headHtml(chat)}
      <div class="chat__unsupported">
        <div><b>不支持对话</b></div>
        <span>${esc(unsupported[chat.agentId] || '这个 Agent 还没有接入对话能力。')}</span>
        <span>所以这里没有输入框。</span>
      </div>
    </section>`;
  }

  /** 把焦点放进输入框；toBottom=true 时同时滚到最新一条 */
  function focusInput(chat, toBottom) {
    const el = chat.el;
    if (!el || !el.isConnected) return;
    const input = $('.composer__input', el);
    if (input) input.focus({ preventScroll: true });
    const body = $('.chat__body', el);
    if (toBottom && body) body.scrollTop = body.scrollHeight;
  }

  function autosize(input) {
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(168, Math.max(48, input.scrollHeight))}px`;
  }

  /** 只重绘会变的部分（状态行 / 横幅 / 消息 / 按钮可用性），输入框和焦点不动 */
  function render(chat) {
    const el = chat.el;
    if (!el || !el.isConnected) return;
    const agent = opts.agent ? opts.agent(chat.agentId) : null;
    const st = threadState(chat);
    const stateEl = $('.chat__state', el);
    if (stateEl) {
      const sig = `${st.tone}|${st.label}|${st.detail || ''}`;
      if (stateEl.dataset.sig !== sig) {
        stateEl.dataset.sig = sig;
        stateEl.dataset.tone = st.tone;
        stateEl.innerHTML = `<i aria-hidden="true"></i><b>${esc(st.label)}</b><span class="chat__state-detail">${esc(st.detail || '')}</span>`;
        stateEl.title = st.detail || '';
      }
    }
    const avatar = $('.chat__avatar', el);
    if (avatar) {
      const online = agent && agent.availability ? agent.availability.available : null;
      avatar.dataset.online = online === true ? '1' : online === false ? '0' : '';
    }
    // 横幅：没发出去 / 断流重连 / 轮询兜底
    const banner = $('.chat__banner', el);
    if (banner) {
      let text = '';
      let kind = 'warn';
      if (chat.sendError) { text = chat.sendError; kind = 'error'; }
      else if (chat.stream && chat.stream.conn === 'reconnecting') text = '连接中断，正在重连…（重连后按序号补发，内容不丢）';
      else if (chat.stream && chat.stream.mode === 'poll') { text = chat.stream.pollError ? `实时流连不上，正在轮询：${chat.stream.pollError}` : '实时流连不上，改为轮询获取进展'; kind = 'info'; }
      if (banner.textContent !== text) banner.textContent = text;
      banner.dataset.kind = kind;
      banner.hidden = !text;
    }
    const body = $('.chat__body', el);
    const pane = $('.chat__detail', el);
    const composer = $('.chat__composer', el);
    if (!body || !pane || !composer) return;
    const tabs = $('.seg', el);
    const tab = tabs ? chat.tab : 'chat';
    $$('.seg__item', el).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    if (tab === 'detail') {
      body.hidden = true;
      composer.hidden = true;
      pane.hidden = false;
      const html = opts.detailHtml ? opts.detailHtml(chat.agentId) : '<div class="chat__empty">没有详情</div>';
      if (pane.dataset.sig !== html) { pane.innerHTML = html; pane.dataset.sig = html; }
      return;
    }
    pane.hidden = true;
    body.hidden = false;
    composer.hidden = false;
    const input = $('.composer__input', el);
    const sendBtn = $('.cbtn[data-act="send"]', el);
    if (sendBtn) sendBtn.disabled = chat.sending || !input || !input.value.trim();
    const cancelBtn = $('.cbtn[data-act="cancel"]', el);
    if (cancelBtn) cancelBtn.hidden = !chat.stream;
    const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
    const html = bodyHtml(chat);
    if (body.dataset.sig !== html) {
      body.innerHTML = html;
      body.dataset.sig = html;
      if (nearBottom) body.scrollTop = body.scrollHeight;    // 本来就贴着底部才跟着滚；用户往上翻时不打扰
    }
  }

  function $$(sel, el) { return [...el.querySelectorAll(sel)]; }

  function bindShell(chat) {
    const el = chat.el;
    if (!el) return;
    el.addEventListener('click', (e) => {
      const tab = e.target.closest('.seg__item');
      if (tab) {
        const again = chat.tab === tab.dataset.tab;       // 点的就是当前页签：回到底部最新一条，并把焦点放进输入框
        chat.tab = tab.dataset.tab;
        render(chat);
        if (again && tab.dataset.tab === 'chat') focusInput(chat, true);
        return;
      }
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'send') send(chat, ($('.composer__input', el) || {}).value);
      else if (act === 'cancel') cancel(chat);
      else if (act === 'new') newChat(chat);
      else if (act === 'reload') reload(chat).then(() => opts.toast && opts.toast(`已重新读取对话记录：${chat.messages.length} 条消息（${chat.loadError ? chat.loadError : '以库里的为准'}）`));
      else if (act === 'retry') retry(chat, btn.dataset.turn);
    });
    const input = $('.composer__input', el);
    if (input) {
      input.value = chat.draft || '';
      autosize(input);
      input.addEventListener('input', () => { chat.draft = input.value; autosize(input); render(chat); });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(chat, input.value); }
      });
    }
  }

  /* ---------------------------------------------------------------- 对外 */

  /**
   * 选中了某个 Agent：右列切成与它的对话。可重复调用（看板每次整体重绘都会调），只更新变化的部分。
   * @param {string} agentId
   * @param {{focus?: boolean}} [extra]  focus=true 时把焦点放进输入框（从输入框点出去又回来时不丢焦点）
   */
  function show(agentId, extra = {}) {
    if (!root) return;
    const chat = chatOf(agentId);
    const hadFocus = extra.focus === true || (document.activeElement && document.activeElement.classList.contains('composer__input'));
    root.classList.add('is-chat');
    root.removeAttribute('aria-live');
    const un = Boolean(unsupported[agentId]) && !chat.threadId;
    if (!chat.el || !chat.el.isConnected || chat.el.dataset.unsupported !== String(un)) {
      const tmp = document.createElement('div');
      tmp.innerHTML = (un ? unsupportedHtml(chat) : shellHtml(chat)).trim();
      chat.el = tmp.firstElementChild;
      chat.el.dataset.unsupported = String(un);
      root.innerHTML = '';
      root.appendChild(chat.el);
      bindShell(chat);
    }
    render(chat);
    if (!chat.messages.length && !chat.loading && !chat.loadError) reload(chat);
    if (hadFocus && !un) { const input = $('.composer__input', chat.el); if (input) input.focus({ preventScroll: true }); }
  }

  /** 右列被别的内容占用（任务详情）：流不断，回来自动接上 */
  function hide() {
    if (root) root.classList.remove('is-chat');
  }

  function mount(rootEl, options) {
    root = rootEl;
    opts = options || {};
    api('/api/chat/threads').then((d) => { if (d && d.unsupported) unsupported = { ...unsupported, ...d.unsupported }; }).catch(() => { /* 列不出来就用默认说法 */ });
  }

  window.SodaChat = {
    mount, show, hide,
    focus(agentId) { const c = chats.get(agentId); if (c) focusInput(c, false); },
    reload(agentId) { const c = chats.get(agentId); if (c) reload(c); },
    setUnsupported(map) { unsupported = { ...unsupported, ...(map || {}) }; },
  };
})();
