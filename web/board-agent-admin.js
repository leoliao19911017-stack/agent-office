/* Soda Office · Agent 名册：添加 / 管理弹窗（TASK-转盘与Agent可添加 第一批）
   独立模块：只通过 window.AgentAdmin 暴露 init/open/refresh，不改看板的数据逻辑。
   铁律：api_key 只读一次、只发给测试连接与保存；不写入 DOM 文本、不 console、不进 toast。 */
(function () {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let ctx = {
    toast: () => {},
    loadData: async () => {},
    roster: () => [],
    meta: (id) => ({ name: id }),
  };
  let state = { open: false, mode: 'add', kind: 'cli', test: null, busy: false };

  const modalEl = () => $('#agent-modal');

  async function sendJson(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch { /* 非 JSON 错误体按 HTTP 状态处理 */ }
    if (!res.ok) {
      const msg = (data && (data.error || data.message)) || `${path} → HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data || {};
  }

  function segButton(kind, label, current) {
    return `<button type="button" data-kind="${kind}" aria-pressed="${kind === current}">${label}</button>`;
  }

  function addFormHtml() {
    return `
      <div class="modal__section">
        <div class="field field--wide">
          <label for="af-name">显示名</label>
          <input id="af-name" type="text" placeholder="例如 Kimi K3" autocomplete="off">
        </div>
      </div>

      <div class="modal__section">
        <div class="modal__label">类型</div>
        <div class="type-seg" id="af-kind">
          ${segButton('cli', 'CLI', 'cli')}
          ${segButton('api', 'API', 'cli')}
          ${segButton('external', '外部', 'cli')}
        </div>
        <p class="hint" id="af-kind-hint">本机命令行工具；保存后按 cli_command 探测可用性。</p>
      </div>

      <div class="modal__section" id="af-cli">
        <div class="form-grid">
          <div class="field field--wide">
            <label for="af-command">命令</label>
            <input id="af-command" type="text" placeholder="claude / codex / 完整路径\\dsh.cmd" autocomplete="off">
            <span class="hint">命令或完整路径；完整路径含空格也可以。</span>
          </div>
          <div class="field">
            <label for="af-resume">续聊参数</label>
            <input id="af-resume" type="text" placeholder="--resume / --session-id" autocomplete="off">
          </div>
          <div class="field">
            <label for="af-cli-model">模型名（可选）</label>
            <input id="af-cli-model" type="text" placeholder="留空则不指定" autocomplete="off">
          </div>
        </div>
      </div>

      <div class="modal__section" id="af-api" hidden>
        <div class="form-grid">
          <div class="field field--wide">
            <label for="af-base">base_url</label>
            <input id="af-base" type="url" placeholder="https://api.kimi.com/coding/" autocomplete="off">
          </div>
          <div class="field field--wide">
            <label for="af-key">api_key</label>
            <input id="af-key" type="password" placeholder="只用于本次测试与保存；不会出现在任何响应或数据库里" autocomplete="new-password">
            <span class="hint">key 存在库外 secrets 文件；agents 表只存引用 <code>local:&lt;agent_id&gt;</code>。</span>
          </div>
          <div class="field">
            <label for="af-model">模型名</label>
            <input id="af-model" type="text" placeholder="k3" autocomplete="off">
          </div>
          <div class="field">
            <label for="af-protocol">协议</label>
            <select id="af-protocol">
              <option value="anthropic">Anthropic 兼容</option>
              <option value="openai">OpenAI 兼容</option>
            </select>
          </div>
        </div>
        <div class="test-box">
          <button type="button" class="btn-ghost" id="af-test">测试连接</button>
          <span class="test-out" id="af-test-out">保存前必须真跑一次最小请求（max_tokens=1）。</span>
        </div>
      </div>

      <div class="modal__section" id="af-external" hidden>
        <p class="hint">外部 Agent 只登记名册；它自己上报状态（例如 Hermes），Agent Office 不启动、不代聊。</p>
      </div>

      <div class="modal__foot">
        <span class="foot-note" id="af-error"></span>
        <button type="button" class="btn-ghost" id="af-cancel">取消</button>
        <button type="button" class="btn-primary" id="af-save">保存</button>
      </div>`;
  }

  function manageHtml() {
    const all = ctx.roster();
    if (!all.length) return '<div class="task-empty">读不到 /api/agents，不编造名册。</div>';
    return `
      <div class="modal__section">
        <div class="manage-list" id="agent-manage-list">
          ${all.map((a) => `<div class="manage-row ${a.enabled ? '' : 'manage-row--off'}" data-agent="${esc(a.agent_id)}" data-enabled="${a.enabled ? 1 : 0}">
            <div>
              <div class="manage-row__name">${esc(a.display_name)}</div>
              <div class="manage-row__id">${esc(a.agent_id)} · ${esc(a.kind)}${a.model ? ` · ${esc(a.model)}` : ''}</div>
            </div>
            <div class="manage-row__meta">
              <span class="manage-row__kind">${a.enabled ? '启用中' : '已禁用'}</span>
              ${a.kind === 'api' ? '<button type="button" class="btn-ghost" data-act="test">测试</button>' : ''}
              <button type="button" class="btn-ghost" data-act="toggle">${a.enabled ? '禁用' : '启用'}</button>
            </div>
          </div>`).join('')}
        </div>
        <p class="hint">禁用只把 enabled 置 0：看板不显示，attempts / 聊天历史 / 配置都保留。</p>
      </div>`;
  }

  function syncAddForm() {
    const kind = state.kind;
    $$('#af-kind button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === kind)));
    $('#af-cli').hidden = kind !== 'cli';
    $('#af-api').hidden = kind !== 'api';
    $('#af-external').hidden = kind !== 'external';
    const hints = {
      cli: '本机命令行工具；保存后按 cli_command 探测可用性。',
      api: '任何 Anthropic / OpenAI 兼容网关；保存前必须测试连接成功。',
      external: '只登记名册，状态只信它自己上报。',
    };
    $('#af-kind-hint').textContent = hints[kind];
    syncSaveState();
  }

  function readAddForm() {
    return {
      display_name: ($('#af-name')?.value || '').trim(),
      kind: state.kind,
      cli_command: ($('#af-command')?.value || '').trim() || null,
      resume_flag: ($('#af-resume')?.value || '').trim() || null,
      model: (state.kind === 'api'
        ? ($('#af-model')?.value || '').trim()
        : ($('#af-cli-model')?.value || '').trim()) || null,
      base_url: ($('#af-base')?.value || '').trim() || null,
      protocol: $('#af-protocol')?.value || null,
      api_key: ($('#af-key')?.value || '').trim() || null,
    };
  }

  function testSignature(v) {
    return JSON.stringify({ b: (v.base_url || '').replace(/\/+$/, ''), m: v.model || '', p: v.protocol || '' });
  }

  function syncSaveState() {
    const save = $('#af-save');
    if (!save) return;
    const vals = readAddForm();
    if (state.kind === 'api') {
      const tested = state.test && state.test.ok && state.test.signature === testSignature(vals);
      save.disabled = state.busy || !tested;
      save.title = tested ? '' : 'API 类型必须先测试连接成功';
    } else {
      save.disabled = state.busy;
      save.title = '';
    }
  }

  function invalidateTest(message) {
    if (!state.test) return;
    state.test = null;
    const out = $('#af-test-out');
    if (out) {
      out.dataset.tone = '';
      out.textContent = message || '配置改了，请重新测试连接。';
    }
    syncSaveState();
  }

  function bindAddForm() {
    $$('#af-kind button').forEach((b) => {
      b.addEventListener('click', () => {
        state.kind = b.dataset.kind;
        syncAddForm();
        invalidateTest('类型改了，请重新测试连接。');
      });
    });
    ['af-base', 'af-model', 'af-protocol', 'af-key'].forEach((id) => {
      const el = $(`#${id}`);
      if (el) el.addEventListener('input', () => invalidateTest('配置改了，请重新测试连接。'));
    });
    $('#af-cancel').addEventListener('click', close);

    $('#af-test').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      if (state.busy) return;
      const vals = readAddForm();
      const out = $('#af-test-out');
      if (!vals.base_url || !vals.model || !vals.api_key) {
        out.dataset.tone = 'bad';
        out.textContent = 'base_url / 模型名 / api_key 都要填。';
        return;
      }
      state.busy = true;
      btn.setAttribute('aria-busy', 'true');
      btn.textContent = '测试中…';
      out.dataset.tone = '';
      out.textContent = `正在请求 ${vals.protocol === 'anthropic' ? '/v1/messages' : '/v1/chat/completions'} …`;
      try {
        const data = await sendJson('POST', '/api/agents/test-connection', {
          base_url: vals.base_url, model: vals.model, protocol: vals.protocol, api_key: vals.api_key,
        });
        if (data.ok) {
          state.test = { ok: true, token: data.test_token, signature: testSignature(vals) };
          out.dataset.tone = 'ok';
          out.innerHTML = `连接成功 · 返回模型 <b>${esc(data.model || vals.model)}</b> · HTTP ${esc(data.http_status)} · ${esc(data.latency_ms)}ms`;
        } else {
          state.test = null;
          out.dataset.tone = 'bad';
          out.textContent = `连接失败（HTTP ${data.http_status ?? '—'}）：${data.error || '上游没有返回原因'}`;
        }
      } catch (err) {
        state.test = null;
        out.dataset.tone = 'bad';
        out.textContent = `连接失败：${err.message}`;
      } finally {
        state.busy = false;
        btn.removeAttribute('aria-busy');
        btn.textContent = '测试连接';
        syncSaveState();
      }
    });

    $('#af-save').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      if (state.busy) return;
      const vals = readAddForm();
      const errEl = $('#af-error');
      errEl.textContent = '';
      if (!vals.display_name) { errEl.textContent = '显示名必填。'; return; }
      if (vals.kind === 'cli' && !vals.cli_command) { errEl.textContent = 'CLI 类型必须填命令。'; return; }
      if (vals.kind === 'api' && (!vals.base_url || !vals.model || !vals.protocol || !vals.api_key)) {
        errEl.textContent = 'API 类型要填 base_url / api_key / 模型名 / 协议。'; return;
      }
      state.busy = true;
      btn.disabled = true;
      btn.textContent = '保存中…';
      try {
        const data = await sendJson('POST', '/api/agents', {
          display_name: vals.display_name,
          kind: vals.kind,
          cli_command: vals.cli_command,
          resume_flag: vals.resume_flag,
          model: vals.model,
          base_url: vals.base_url,
          protocol: vals.protocol,
          api_key: vals.api_key,
          test_token: state.test ? state.test.token : undefined,
        });
        const added = data.agent;
        close();
        await ctx.loadData();
        ctx.toast(`已添加 ${added.display_name}（${added.agent_id}）· 看板已刷新`);
      } catch (err) {
        errEl.textContent = err.message;
      } finally {
        state.busy = false;
        if (btn.isConnected) {
          btn.textContent = '保存';
          syncSaveState();
        }
      }
    });
  }

  function bindManage() {
    const list = $('#agent-manage-list');
    if (!list) return;
    list.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const row = btn.closest('.manage-row');
      if (!row) return;
      const id = row.dataset.agent;
      const enabled = row.dataset.enabled === '1';
      btn.disabled = true;
      try {
        if (btn.dataset.act === 'toggle') {
          await sendJson('PATCH', `/api/agents/${encodeURIComponent(id)}`, { enabled: !enabled });
          await ctx.loadData();
          render();
          ctx.toast(`${ctx.meta(id).name} 已${enabled ? '禁用（看板隐藏，数据保留）' : '启用'}`);
        } else if (btn.dataset.act === 'test') {
          const data = await sendJson('POST', `/api/agents/${encodeURIComponent(id)}/test`, {});
          ctx.toast(data.ok
            ? `${ctx.meta(id).name} 连接成功 · ${data.model || ''} · ${data.latency_ms}ms`
            : `${ctx.meta(id).name} 连接失败：${data.error || '上游没有返回原因'}`);
        }
      } catch (err) {
        ctx.toast(`${ctx.meta(id).name} 操作失败：${err.message}`);
      } finally {
        if (btn.isConnected) btn.disabled = false;
      }
    });
  }

  function render() {
    if (!state.open) return;
    const isAdd = state.mode === 'add';
    $('#agent-modal-title').textContent = isAdd ? '添加 Agent' : '管理 Agent';
    $('#agent-modal-sub').textContent = isAdd
      ? '名册写进 agents 表；现有 4 个 Agent 的 id 不变，历史数据不动。'
      : '启用 / 禁用都在名册里改，不删历史；API 类型可以再测一次连接。';
    const body = $('#agent-modal-body');
    body.innerHTML = isAdd ? addFormHtml() : manageHtml();
    if (isAdd) {
      syncAddForm();
      bindAddForm();
    } else {
      bindManage();
    }
  }

  function open(mode) {
    state = { open: true, mode: mode === 'manage' ? 'manage' : 'add', kind: 'cli', test: null, busy: false };
    modalEl().hidden = false;
    render();
    const first = state.mode === 'add' ? $('#af-name') : $('#agent-manage-list button');
    if (first) first.focus();
  }

  function close() {
    state.open = false;
    const el = modalEl();
    if (el) el.hidden = true;
    const body = $('#agent-modal-body');
    if (body) body.innerHTML = '';
  }

  function refresh() {
    if (state.open) render();
  }

  function init(options) {
    ctx = { ...ctx, ...(options || {}) };
    const add = $('#agent-add-btn');
    const manage = $('#agent-manage-btn');
    if (add) add.addEventListener('click', () => open('add'));
    if (manage) manage.addEventListener('click', () => open('manage'));
    const el = modalEl();
    if (!el) return;
    $('#agent-modal-close')?.addEventListener('click', close);
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-modal-close]')) close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.open) close();
    });
  }

  window.AgentAdmin = { init, open, close, refresh, isOpen: () => state.open };
})();
