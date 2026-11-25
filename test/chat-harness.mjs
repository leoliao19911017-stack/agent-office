// chat-harness.mjs — Agent Chat 的 HTTP 集成测试夹具（node --test 不收本文件：名字不带 .test.js）。
//
// 隔离四件套（不碰真实数据、不抢 8090、不起真 CLI、不花额度）：
//   1. stub 中台：/healthz + /v1/state（server.js 启动要读 config.json 指向的中台）；
//   2. 临时 AGENT_AUTOLOOP_HOME（config.json 指向 stub）；
//   3. 临时数据库 AGENT_OFFICE_DB；
//   4. 真实 web/server.js 子进程，CLAUDE_BIN / DSH_BIN 指向 test/fixtures/chat-fake-*.mjs 的包装脚本。
// 就绪判定 = /api/health 真实响应（不是「进程活着」）。
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));   // 仓库根
export const FIXTURES = join(ROOT, 'test', 'fixtures');

function startHub() {
  const hub = createServer((req, res) => {
    const u = new URL(req.url, 'http://stub');
    if (u.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return; }
    if (u.pathname === '/v1/state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ now: new Date().toISOString(), agents: [], runs: [], totals: { usage: { input: 0, output: 0, cost: 0 } } }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `stub hub 不认识的路由：${u.pathname}` }));
  });
  return new Promise((resolve) => hub.listen(0, '127.0.0.1', () => resolve(hub)));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/** 给假 CLI 做一个可执行包装：Windows 是 .cmd，其它平台是带 shebang 的 .sh（与 proc.mjs 的 spawnPlan 同一口径） */
export function writeCliWrapper(dir, name, script) {
  mkdirSync(dir, { recursive: true });
  if (process.platform === 'win32') {
    const p = join(dir, `${name}.cmd`);
    writeFileSync(p, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    return p.replace(/\\/g, '/');
  }
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(p, 0o755);
  return p;
}

/**
 * 起一个隔离的真实服务。
 * @param {object} [opts]
 * @param {string} [opts.home]     续用已有的夹具目录（测「重启后历史还在」：stop 时 keepHome:true，再带 home/dbPath 起一个新的）
 * @param {boolean} [opts.keepHome] stop 时不删夹具目录
 * @param {string} [opts.dbPath]   续用已有数据库（测「重启后历史还在」）
 * @param {string} [opts.dshBin]   覆盖 DSH_BIN（比如指向坏路径，测启动失败的具体原因）
 * @param {string} [opts.claudeBin] 'inherit' = 不覆盖，用机器上真的 Claude CLI（验收脚本用）
 * @param {object} [opts.env]      额外环境变量（比如把 DSH_BIN 指到坏路径）
 * @param {number} [opts.port]     固定端口（测「同一个 URL 上服务重启」；默认随机空闲端口）
 * @param {number} [opts.fakeDelayMs] 假 CLI 的流式片间隔
 */
export async function startChatServer(opts = {}) {
  const hub = await startHub();
  const home = opts.home || mkdtempSync(join(tmpdir(), 'soda-chat-test-'));   // 传 home = 续用（测重启后历史还在）
  mkdirSync(join(home, 'office-data'), { recursive: true });
  const hubUrl = `http://127.0.0.1:${hub.address().port}`;
  writeFileSync(join(home, 'config.json'), JSON.stringify({ url: hubUrl, owner: 'test-owner-key-not-real' }));
  const dbPath = opts.dbPath || join(home, 'agent-office-test.db');
  const fakeHome = join(home, 'fake-cli');
  mkdirSync(fakeHome, { recursive: true });
  const claudeBin = writeCliWrapper(fakeHome, 'fake-claude', join(FIXTURES, 'chat-fake-claude.mjs'));
  const dshBin = opts.dshBin || writeCliWrapper(fakeHome, 'fake-dsh', join(FIXTURES, 'chat-fake-dsh.mjs'));
  const claudeBinFinal = opts.claudeBin === 'inherit' ? null : (opts.claudeBin || claudeBin);   // 'inherit' = 用机器上真的 Claude CLI
  const port = opts.port || await freePort();

  const child = spawn(process.execPath, [join(ROOT, 'web', 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      AGENT_AUTOLOOP_HOME: home,
      AGENT_OFFICE_DB: dbPath,
      ...(claudeBinFinal ? { CLAUDE_BIN: claudeBinFinal } : {}),
      DSH_BIN: dshBin,
      FAKE_CLI_HOME: fakeHome,
      FAKE_CLI_DELAY_MS: String(opts.fakeDelayMs || 60),
      CHAT_CLAUDE_SETTINGS: '',
      ...(opts.env || {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(`[out] ${String(d).trim()}`));
  child.stderr.on('data', (d) => logs.push(`[err] ${String(d).trim()}`));

  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  for (;;) {
    if (child.exitCode != null) {
      hub.close();
      throw new Error(`server.js 启动即退出（exit ${child.exitCode}）：\n${logs.join('\n')}`);
    }
    try {
      const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) break;
    } catch { /* 还没起来 */ }
    if (Date.now() - t0 > 20000) {
      child.kill();
      hub.close();
      throw new Error(`server.js 20s 内没有就绪：\n${logs.join('\n')}`);
    }
    await new Promise((r) => setTimeout(r, 120));
  }

  return {
    base, port, child, home, dbPath, hub, logs,
    claudeBin: claudeBinFinal, dshBin,
    async stop() {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
      await new Promise((r) => hub.close(r));
      if (opts.keepHome !== true) { try { rmSync(home, { recursive: true, force: true }); } catch { /* 临时目录删不掉不影响断言 */ } }
    },
  };
}

/** 极简 SSE 客户端：按 text/event-stream 解析，onEvent 收 {event, data, id}；连接结束时 resolve */
export async function readSse(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let cur = { event: 'message', data: '', id: null };
  const dispatch = () => {
    if (cur.data === '' && cur.id === null) { cur = { event: 'message', data: '', id: null }; return; }
    const dataLines = cur.data.replace(/\n$/, '').split('\n');
    let data = null;
    try { data = JSON.parse(dataLines.join('\n')); } catch { data = dataLines.join('\n'); }
    onEvent({ event: cur.event, data, id: cur.id });
    cur = { event: 'message', data: '', id: null };
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      let line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') { dispatch(); continue; }
      if (line.startsWith(':')) continue;                       // 心跳注释
      if (line.startsWith('retry:')) { cur.retry = Number(line.slice(6).trim()); continue; }
      const m = line.match(/^(event|data|id):\s?(.*)$/);
      if (!m) continue;
      if (m[1] === 'event') cur.event = m[2];
      else if (m[1] === 'data') cur.data += `${m[2]}\n`;
      else cur.id = m[2];
    }
  }
  dispatch();
}

export async function postJson(base, path, body) {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

export async function getJson(base, path) {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json().catch(() => null) };
}

export async function patchJson(base, path, body) {
  const res = await fetch(base + path, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

export async function deleteJson(base, path) {
  const res = await fetch(base + path, { method: 'DELETE' });
  return { status: res.status, body: await res.json().catch(() => null) };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询到这一轮走到终态（或超时），返回轮次视图 */
export async function waitTurn(base, turnId, ms = 20000) {
  const t0 = Date.now();
  for (;;) {
    const { body } = await getJson(base, `/api/chat/turns/${turnId}`);
    const status = body && body.turn ? body.turn.status : null;
    if (status && !['queued', 'starting', 'restoring', 'running', 'tool_running', 'approval_required'].includes(status)) return body;
    if (Date.now() - t0 > ms) throw new Error(`轮次 ${turnId} 没在 ${ms}ms 内走到终态（当前 ${status}）`);
    await sleep(40);
  }
}
