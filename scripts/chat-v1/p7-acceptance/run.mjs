// run.mjs — Agent Chat P7 全量回归：A/B/C/D/E/F 六套验收 + G07 门禁 + P0 selftest。
//
// 为什么有这个脚本：
//   P1-P6 各自的 run.mjs 是「单批」验收，P7 要求六套全部重跑并把真实输出打包到
//   docs/evidence/chat-all/。这层只负责「按顺序跑、各自落盘、汇总、失败不掩盖」，
//   不重写任何断言，也不替被测代码说好话。
//
// 模型回退（如实记录，不伪装）：
//   2026-11-24 上游 glm-5.4 持续 HTTP 529（过载，不是本仓库代码/凭据问题）。
//   脚本先探针；若 5.4 不可用而 glm-5 可用，就用 Claude Code 自己的 `--settings`
//   给本次回归进程临时覆盖模型（CLI / 会话 / --resume / 适配器 / DB 全是真的），
//   原始 529 响应与回退声明写进 docs/evidence/chat-all/。用户 settings.json 不改。
//   5.4 恢复后加 --no-fallback 重跑，即可得到真实 5.4 的证据。
//
// 用法：
//   node --no-warnings scripts/chat-v1/p7-acceptance/run.mjs [--only a,b,c] [--skip d] [--no-fallback] [--no-restart]
// 产物：
//   docs/evidence/chat-all/rounds/<a|b|c|d|e|f>/   各套原始 JSON / 截图
//   docs/evidence/chat-all/logs/<a|b|...>.log      各套完整 stdout+stderr
//   docs/evidence/chat-all/logs/g07.log / selftest.log
//   docs/evidence/chat-all/summary.json            总表（pass/total、退出码、模型、上游探针）
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const EV = resolve(REPO, 'docs', 'evidence', 'chat-all');
const ROUNDS = resolve(EV, 'rounds');
const LOGS = resolve(EV, 'logs');
mkdirSync(ROUNDS, { recursive: true });
mkdirSync(LOGS, { recursive: true });

const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const ONLY = new Set(String(arg('--only') || '').split(',').filter(Boolean));
const SKIP = new Set(String(arg('--skip') || '').split(',').filter(Boolean));
const NO_FALLBACK = argv.includes('--no-fallback');
const NO_RESTART = argv.includes('--no-restart');
const BASE = arg('--base') || 'http://127.0.0.1:8090';
const log = (...a) => console.log(...a);

const SUITES = [
  { key: 'a', id: 'p1', name: 'P1 claude adapter（A1-A7）', script: 'scripts/chat-v1/p1-acceptance/run.mjs', args: ['--base', BASE], expect: 7 },
  { key: 'b', id: 'p2', name: 'P2 dsh adapter（B1-B5）', script: 'scripts/chat-v1/p2-acceptance/run.mjs', args: ['--base', BASE], expect: 8 },
  { key: 'c', id: 'p3', name: 'P3 SSE 流式（C1-C4）', script: 'scripts/chat-v1/p3-acceptance/run.mjs', args: ['--base', BASE], expect: 6 },
  { key: 'd', id: 'p4', name: 'P4 前端面板（D1-D7）', script: 'scripts/chat-v1/p4-acceptance/run.mjs', args: ['--base', BASE], expect: 7 },
  { key: 'e', id: 'p5', name: 'P5 失败与状态机（E1-E5）', script: 'scripts/chat-v1/p5-acceptance/run.mjs', args: ['--base', BASE], expect: 11 },
  { key: 'f', id: 'p6', name: 'P6 hermes adapter（F1-F2）', script: 'scripts/chat-v1/p6-acceptance/run.mjs', args: [], expect: 2 },
];

const FALLBACK_MODELS = {
  ANTHROPIC_MODEL: 'glm-5',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5',
};
const FALLBACK_SETTINGS = JSON.stringify({ env: FALLBACK_MODELS });

function readClaudeEnv() {
  try {
    const j = JSON.parse(readFileSync(resolve(homedir(), '.claude', 'settings.json'), 'utf8'));
    return j.env || {};
  } catch { return {}; }
}

async function probeModel(model, env) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${String(env.ANTHROPIC_BASE_URL || '').replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_AUTH_TOKEN, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: 'user', content: 'Reply with exactly: OK' }] }),
      signal: AbortSignal.timeout(30000),
    });
    const text = await r.text();
    return { at: new Date().toISOString(), model, http: r.status, ms: Date.now() - t0, body: text.slice(0, 400) };
  } catch (err) {
    return { at: new Date().toISOString(), model, error: String(err && err.message), ms: Date.now() - t0 };
  }
}

function run(cmd, args, env, logFile, timeoutMs) {
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks = [];
    const push = (d) => { const s = String(d); chunks.push(s); process.stdout.write(s); };
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    const timer = setTimeout(() => {
      push(`\n[runner] 超时 ${timeoutMs}ms，结束 pid=${child.pid}\n`);
      spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const text = chunks.join('');
      writeFileSync(logFile, text);
      done({ code, signal, text });
    });
  });
}

async function restart8090(env) {
  const check = await run(process.execPath, ['--no-warnings', 'scripts/chat-v1/restart-8090.mjs', '--check'], env, resolve(LOGS, 'restart-check.log'), 60000);
  log(check.text.trim());
  if (!/检查结果：可以重启/.test(check.text)) throw new Error('重启前检查不通过，拒绝动 8090（见 logs/restart-check.log）');
  const r = await run(process.execPath, ['--no-warnings', 'scripts/chat-v1/restart-8090.mjs'], env, resolve(LOGS, 'restart.log'), 120000);
  log(r.text.trim());
  if (r.code !== 0) throw new Error(`重启 8090 失败，退出码 ${r.code}（见 logs/restart.log）`);
}

async function main() {
  const startedAt = new Date().toISOString();
  const claudeEnv = readClaudeEnv();
  const upstream = {
    'glm-5.4': await probeModel('glm-5.4', claudeEnv),
    'glm-5': await probeModel('glm-5', claudeEnv),
  };
  const useFallback = !NO_FALLBACK && upstream['glm-5.4'].http !== 200 && upstream['glm-5'].http === 200;
  const settings = useFallback ? FALLBACK_SETTINGS : '';
  const env = { ...process.env, ...(settings ? { CHAT_CLAUDE_SETTINGS: settings } : {}) };
  log(`上游探针：glm-5.4 HTTP ${upstream['glm-5.4'].http ?? upstream['glm-5.4'].error} / glm-5 HTTP ${upstream['glm-5'].http ?? upstream['glm-5'].error}`);
  log(useFallback ? '⚠ glm-5.4 不可用 → 本次回归用 Claude Code --settings 临时回退到 glm-5（报告如实标注）' : '使用默认模型（glm-5.4）');

  writeFileSync(resolve(EV, 'probe.json'), JSON.stringify({
    at: startedAt, upstream, use_fallback: useFallback, fallback_models: useFallback ? FALLBACK_MODELS : null,
    note: useFallback
      ? 'glm-5.4 上游 529 过载；Claude Code CLI / 会话文件 / --resume / 适配器 / 数据库全真，仅本轮进程的模型临时覆盖为 glm-5。用户 settings.json 未改。'
      : '上游 glm-5.4 正常，未回退。',
  }, null, 2));

  if (!NO_RESTART) await restart8090(env);

  const health = await fetch(`${BASE}/api/health`).then((r) => r.json()).catch((e) => ({ error: String(e.message) }));
  log(`服务 ${BASE} /api/health = ${JSON.stringify(health)}`);

  const results = [];
  for (const s of SUITES) {
    if (ONLY.size && !ONLY.has(s.key)) continue;
    if (SKIP.has(s.key)) { log(`\n===== 跳过 ${s.key.toUpperCase()} =====`); continue; }
    log(`\n===== ${s.key.toUpperCase()}  ${s.name} =====`);
    const evidence = resolve(ROUNDS, s.key);
    mkdirSync(evidence, { recursive: true });
    const r = await run(process.execPath, ['--no-warnings', s.script, ...s.args], {
      ...env, CHAT_EVIDENCE_DIR: evidence,
    }, resolve(LOGS, `${s.key}.log`), 45 * 60 * 1000);
    let summary = null;
    try { summary = JSON.parse(readFileSync(resolve(evidence, 'summary.json'), 'utf8')); } catch { /* 有套件不写 summary */ }
    const pass = summary ? summary.pass : null;
    const total = summary ? summary.total : null;
    const ok = r.code === 0 && pass === s.expect && total === s.expect;
    results.push({ key: s.key, batch: s.id, name: s.name, exit: r.code, pass, total, expected: s.expect, ok, evidence: `rounds/${s.key}`, log: `logs/${s.key}.log` });
    log(`[${s.key}] exit=${r.code} pass=${pass}/${total} 期望=${s.expect} → ${ok ? 'PASS' : 'FAIL'}`);
  }

  // P7 的另外两道硬门禁
  const gates = [];
  if (!ONLY.size || ONLY.has('g07')) {
    log('\n===== G07 门禁 npm run test:g07 =====');
    const g = await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'test:g07'], env, resolve(LOGS, 'g07.log'), 20 * 60 * 1000);
    const pass = Number((g.text.match(/^ℹ pass (\d+)/m) || [])[1] || 0);
    const fail = Number((g.text.match(/^ℹ fail (\d+)/m) || [])[1] || 0);
    gates.push({ key: 'g07', name: 'npm run test:g07', exit: g.code, pass, fail, expected: 19, ok: g.code === 0 && pass === 19 && fail === 0, log: 'logs/g07.log' });
    log(`[g07] exit=${g.code} pass=${pass} fail=${fail} → ${gates.at(-1).ok ? 'PASS' : 'FAIL'}`);
  }
  if (!ONLY.size || ONLY.has('selftest')) {
    log('\n===== P0 selftest node scripts/selftest-p0.mjs =====');
    const t = await run(process.execPath, ['--no-warnings', 'scripts/selftest-p0.mjs'], env, resolve(LOGS, 'selftest.log'), 10 * 60 * 1000);
    const pass = Number((t.text.match(/规定测试:\s*(\d+)\/(\d+)\s*通过/) || [])[1] || 0);
    const extra = Number((t.text.match(/附加必验:\s*(\d+)\/(\d+)\s*通过/) || [])[1] || 0);
    gates.push({ key: 'selftest', name: 'node scripts/selftest-p0.mjs', exit: t.code, pass, extra, expected: 8, ok: t.code === 0 && pass === 8 && extra === 3, log: 'logs/selftest.log' });
    log(`[selftest] exit=${t.code} 规定=${pass}/8 附加=${extra}/3 → ${gates.at(-1).ok ? 'PASS' : 'FAIL'}`);
  }

  const ok = results.every((r) => r.ok) && gates.every((g) => g.ok);
  writeFileSync(resolve(EV, 'summary.json'), JSON.stringify({
    at: new Date().toISOString(), started_at: startedAt, base: BASE, use_fallback: useFallback,
    fallback_models: useFallback ? FALLBACK_MODELS : null, upstream, health, results, gates, ok,
  }, null, 2));
  log(`\nP7 回归：${ok ? '全过' : '有失败'}（套件 ${results.filter((r) => r.ok).length}/${results.length}，门禁 ${gates.filter((g) => g.ok).length}/${gates.length}）`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  writeFileSync(resolve(EV, 'summary.json'), JSON.stringify({ at: new Date().toISOString(), ok: false, error: String(err && err.message ? err.message : err) }, null, 2));
  process.exit(2);
});
