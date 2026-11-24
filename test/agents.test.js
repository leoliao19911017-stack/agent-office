// agents.test.js — 第一批：名册 CRUD、chat 能力、API key 不进 DB、两种协议的测试连接/流式聊天。
// 全部离线：上游是本进程起的一个假 HTTP 服务，不花额度、不碰真实 key。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SECRETS_DIR = mkdtempSync(join(tmpdir(), 'soda-agents-secrets-'));
process.env.AGENT_OFFICE_SECRETS_DIR = SECRETS_DIR;

const { openDb } = await import('../web/lib/db.mjs');
const {
  listAgents, getAgent, createAgent, updateAgent, chatSupport, toPublicAgent,
} = await import('../web/lib/agents.mjs');
const { saveAgentSecret, getAgentSecret, resolveApiKey, keyFingerprint } = await import('../web/lib/secrets.mjs');
const { testApiConnection, streamChat, apiEndpoint } = await import('../web/lib/api-provider.mjs');

function db() { return openDb({ memory: true }); }

test('v3 迁移：四个历史 agent_id 原值入库，dsh 存完整命令路径', () => {
  const d = db();
  const agents = listAgents(d);
  assert.deepEqual(agents.map((a) => a.agent_id), ['claude', 'codex', 'dsh', 'hermes']);
  assert.equal(getAgent(d, 'claude').resume_flag, '--resume');
  assert.match(getAgent(d, 'dsh').cli_command, /dsh\.cmd$/);
  assert.equal(getAgent(d, 'dsh').resume_flag, '--session-id');
  assert.equal(getAgent(d, 'hermes').kind, 'external');
});

test('chatSupport：内置三个 CLI + 任意 API 可聊；codex / 新 CLI / 外部不可聊', () => {
  const d = db();
  assert.equal(chatSupport(getAgent(d, 'claude')).supported, true);
  assert.equal(chatSupport(getAgent(d, 'dsh')).supported, true);
  assert.equal(chatSupport(getAgent(d, 'hermes')).supported, true);
  assert.equal(chatSupport(getAgent(d, 'codex')).supported, false);
  const cli = createAgent(d, { agent_id: 'my-cli', display_name: 'My CLI', kind: 'cli', cli_command: 'mycli' });
  assert.equal(chatSupport(cli).supported, false);
  const api = createAgent(d, {
    agent_id: 'my-api', display_name: 'My API', kind: 'api',
    base_url: 'https://example.test', model: 'm1', protocol: 'anthropic', api_key_ref: 'local:my-api',
  });
  assert.equal(chatSupport(api).supported, true);
});

test('禁用：列表可按 enabled 过滤，行和数据不删', () => {
  const d = db();
  updateAgent(d, 'codex', { enabled: false });
  assert.equal(listAgents(d).length, 4);
  assert.equal(listAgents(d, { enabledOnly: true }).length, 3);
  assert.equal(listAgents(d, { enabledOnly: false }).length, 4);
  assert.equal(getAgent(d, 'codex').enabled, false);
});

test('输出脱敏：extra_env 里的 KEY/TOKEN 不出现，api_key_ref 只回引用', () => {
  const d = db();
  const a = createAgent(d, {
    agent_id: 'leaky', display_name: 'Leaky', kind: 'api',
    base_url: 'https://example.test', model: 'm', protocol: 'openai', api_key_ref: 'local:leaky',
    extra_env: { OPENAI_API_KEY: 'sk-should-not-leak', NORMAL: 'ok' },
  });
  const pub = toPublicAgent(a);
  const text = JSON.stringify(pub);
  assert.ok(!text.includes('sk-should-not-leak'));
  assert.equal(pub.extra_env.OPENAI_API_KEY, '[REDACTED]');
  assert.equal(pub.extra_env.NORMAL, 'ok');
  assert.equal(pub.api_key_set, true);
});

test('key 只在库外：secrets 文件有，数据库文件里没有', () => {
  const d = openDb({ path: join(SECRETS_DIR, 'keys.db') });
  const key = 'sk-test-1234567890-abcdefghij';
  saveAgentSecret('k1', key);
  assert.equal(getAgentSecret('k1'), key);
  assert.equal(resolveApiKey({ apiKeyRef: 'local:k1' }).key, key);
  assert.ok(keyFingerprint(key));
  d.close();
  const dbBytes = readFileSync(join(SECRETS_DIR, 'keys.db'));
  assert.equal(dbBytes.includes(Buffer.from(key)), false);
});

/* ---------------- 假上游：同时支持 anthropic / openai ---------------- */

function startFake() {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const auth = req.headers.authorization || '';
      if (auth.includes('bad-key')) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'bad key' } }));
        return;
      }
      let parsed = {}; try { parsed = JSON.parse(body); } catch { /* 空体 */ }
      if (url.pathname.endsWith('/messages')) {
        if (!parsed.stream) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 'msg_1', model: parsed.model, content: [{ type: 'text', text: 'ok' }] }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { model: parsed.model, usage: { input_tokens: 3, output_tokens: 1 } } })}\n\n`);
        for (const ch of ['收', '到']) {
          res.write(`data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: ch } })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 2 } })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      if (url.pathname.endsWith('/chat/completions')) {
        if (!parsed.stream) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 'c1', model: parsed.model, choices: [{ message: { content: 'ok' } }] }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '收' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '到' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(404); res.end('{}');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ server, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) });
  }));
}

test('endpoint 拼接：/v1 不重复', () => {
  assert.equal(apiEndpoint('https://api.kimi.com/coding/', 'anthropic'), 'https://api.kimi.com/coding/v1/messages');
  assert.equal(apiEndpoint('https://x.test/v1', 'anthropic'), 'https://x.test/v1/messages');
  assert.equal(apiEndpoint('https://x.test/v1', 'openai'), 'https://x.test/v1/chat/completions');
});

test('测试连接：anthropic / openai 真发最小请求；401 带回原因', async () => {
  const fake = await startFake();
  try {
    const a = await testApiConnection({ baseUrl: fake.base, model: 'm', protocol: 'anthropic', apiKey: 'good-key' });
    assert.equal(a.ok, true);
    assert.equal(a.model, 'm');
    const o = await testApiConnection({ baseUrl: fake.base, model: 'm2', protocol: 'openai', apiKey: 'good-key' });
    assert.equal(o.ok, true);
    const bad = await testApiConnection({ baseUrl: fake.base, model: 'm', protocol: 'anthropic', apiKey: 'bad-key' });
    assert.equal(bad.ok, false);
    assert.equal(bad.http_status, 401);
    assert.match(bad.error, /bad key/);
  } finally { await fake.close(); }
});

test('流式聊天：anthropic / openai 都能把增量拼成完整回复并带 usage', async () => {
  const fake = await startFake();
  try {
    for (const protocol of ['anthropic', 'openai']) {
      const deltas = [];
      const r = await streamChat({
        baseUrl: fake.base, model: 'm', protocol, apiKey: 'good-key',
        messages: [{ role: 'user', content: 'hi' }],
        onEvent: (ev) => { if (ev.type === 'delta') deltas.push(ev.text); },
      });
      assert.equal(r.kind, 'completed', protocol);
      assert.equal(r.text, '收到', protocol);
      assert.ok(r.usage, `${protocol} usage`);
      assert.equal(deltas.join(''), '收到', protocol);
    }
  } finally { await fake.close(); }
});

test('cleanup', () => { rmSync(SECRETS_DIR, { recursive: true, force: true }); });
