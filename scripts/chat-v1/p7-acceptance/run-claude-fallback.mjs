// run-claude-fallback.mjs — P7 回归里需要真 Claude Code 的三段（A1-A7 / C1-C4 / E3a）。
//
// 为什么要单独跑：2026-11-24 09:24–09:52 期间上游 glm-5.4 持续返回 HTTP 529 overloaded_error
// （模型「当前访问量过大」，不是我们的代码/凭据问题；原始响应见 out/glm54-529.json）。
// 为了不让外部过载挡住回归，用 Claude Code 自己的 `--settings` 把**本次验收进程**的模型临时
// 覆盖成同一网关的 glm-5（CLI、会话文件、`--resume`、适配器、数据库全是同一套真链路），
// 并在报告里如实标注。用户 settings.json 不改；验收结束进程退出即失效。
//
// 用法：node --no-warnings scripts/chat-v1/p7-acceptance/run-claude-fallback.mjs
// 产物：out/a-fallback.log / c-fallback.log / e3a-fallback.log / glm54-529.json
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startChatServer } from '../../../test/chat-harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const OUT = resolve(HERE, 'out');
mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);

const MODELS = { ANTHROPIC_MODEL: 'glm-5', ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5', ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5' };
const SETTINGS = JSON.stringify({ env: MODELS });

/* 先留一份上游 529 的原始证据（用用户 settings.json 里的真凭据，只请求 8 token，不打印密钥） */
async function probeUpstream() {
  const j = JSON.parse(readFileSync(resolve(homedir(), '.claude', 'settings.json'), 'utf8'));
  const env = j.env || {};
  const t0 = Date.now();
  try {
    const r = await fetch(`${String(env.ANTHROPIC_BASE_URL || '').replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_AUTH_TOKEN, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'glm-5.4', max_tokens: 8, messages: [{ role: 'user', content: 'Reply with exactly: OK' }] }),
      signal: AbortSignal.timeout(30000),
    });
    const text = await r.text();
    return { at: new Date().toISOString(), model: 'glm-5.4', http: r.status, ms: Date.now() - t0, body: text.slice(0, 600) };
  } catch (err) {
    return { at: new Date().toISOString(), model: 'glm-5.4', error: String(err && err.message) };
  }
}

function runNode(label, script, args, env) {
  log(`\n===== ${label} =====`);
  const r = spawnSync(process.execPath, ['--no-warnings', script, ...args], {
    cwd: REPO, encoding: 'utf8', timeout: 30 * 60 * 1000,
    env: { ...process.env, ...env },
  });
  const text = `${r.stdout || ''}${r.stderr || ''}`;
  writeFileSync(resolve(OUT, `${label}.log`), text);
  process.stdout.write(text);
  log(`[${label}] exit=${r.status}`);
  return r.status === 0;
}

const upstream = await probeUpstream();
writeFileSync(resolve(OUT, 'glm54-529.json'), JSON.stringify(upstream, null, 2));
log(`上游 glm-5.4 探针：HTTP ${upstream.http} ${upstream.body ? upstream.body.slice(0, 160) : upstream.error}`);

const srv = await startChatServer({ claudeBin: 'inherit', env: { CHAT_CLAUDE_SETTINGS: SETTINGS }, keepHome: true });
log(`私有实例：${srv.base}（真实 server.js + 临时库；Claude Code 真 CLI，模型本次覆盖为 glm-5）`);
let ok = true;
try {
  ok = runNode('a-fallback', resolve(REPO, 'scripts/chat-v1/p1-acceptance/run.mjs'), ['--base', srv.base], { AGENT_OFFICE_DB: srv.dbPath }) && ok;
  ok = runNode('c-fallback', resolve(REPO, 'scripts/chat-v1/p3-acceptance/run.mjs'), ['--base', srv.base], { AGENT_OFFICE_DB: srv.dbPath }) && ok;
  ok = runNode('e3a-fallback', resolve(REPO, 'scripts/chat-v1/p5-acceptance/run.mjs'), ['--base', srv.base, '--skip', 'e5,e3b,e1,e2,e4'], {}) && ok;
} finally {
  await srv.stop();
}
writeFileSync(resolve(OUT, 'fallback-summary.json'), JSON.stringify({
  at: new Date().toISOString(), upstream, base: srv.base, models: MODELS, ok,
  note: 'glm-5.4 持续 529 时，用 Claude Code --settings 临时覆盖为 glm-5；CLI/会话/适配器/DB 全真，报告如实标注。',
}, null, 2));
log(`\nA/C/E3a（glm-5 回退）${ok ? '全过' : '有失败'}；上游 529 原始响应见 out/glm54-529.json`);
process.exit(ok ? 0 : 1);
