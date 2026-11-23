// run.mjs — Agent Chat P2（dsh adapter）验收：真 dsh、真 HTTP，B1-B5 每项的真实输出落盘。
// 用法：node --no-warnings scripts/chat-v1/p2-acceptance/run.mjs [--base http://127.0.0.1:8090] [--no-private]
//   --no-private   不起私有实例。B5 的「路径错 / 命令找不到」需要 DSH_BIN 指到坏路径，
//                  不能动 8090 的配置，所以另起一个真实 server.js 子进程 + 临时库来制造。
// 产物：scripts/chat-v1/p2-acceptance/out/*.json（证据文档从这里引用）
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { runDshTurn, defaultDshBin } from '../../../web/chat/adapters/dsh-chat.mjs';
import { startChatServer, postJson, getJson, sleep } from '../../../test/chat-harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, 'out');
mkdirSync(OUT, { recursive: true });
const args = process.argv.slice(2);
const BASE = args.includes('--base') ? args[args.indexOf('--base') + 1] : 'http://127.0.0.1:8090';
const NO_PRIVATE = args.includes('--no-private');
const REPO = resolve(HERE, '..', '..', '..');
const CODE = '青禾-9241';
const results = [];
const save = (name, data) => writeFileSync(resolve(OUT, `${name}.json`), JSON.stringify(data, null, 2));
const log = (...a) => console.log(...a);
function record(id, title, pass, detail) {
  results.push({ id, title, pass, detail, kind: 'acceptance' });
  log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${title}${detail ? `\n      ${String(detail).replace(/\n/g, '\n      ')}` : ''}`);
}
/** 实测对照：不计入验收通过率，只如实记录「哪个参数能用」 */
function probe(id, title, works, detail) {
  results.push({ id, title, works, detail, kind: 'probe' });
  log(`${works ? '能用' : '不能用'}  ${id}  ${title}${detail ? `\n      ${String(detail).replace(/\n/g, '\n      ')}` : ''}`);
}

const ACTIVE = ['queued', 'starting', 'restoring', 'running', 'tool_running', 'approval_required'];
async function send(threadId, content) {
  const r = await postJson(BASE, `/api/chat/threads/${threadId}/messages`, { content });
  if (r.status !== 202) throw new Error(`发消息失败 HTTP ${r.status}：${JSON.stringify(r.body)}`);
  return r.body;
}
async function waitTurn(turnId, ms = 240000) {
  const t0 = Date.now();
  let body = null;
  for (;;) {
    body = (await getJson(BASE, `/api/chat/turns/${turnId}`)).body;
    if (body && body.turn && !ACTIVE.includes(body.turn.status)) return { ...body, waited_ms: Date.now() - t0 };
    if (Date.now() - t0 > ms) throw new Error(`轮次 ${turnId} 超过 ${ms}ms 没到终态（${body && body.turn && body.turn.status}）`);
    await sleep(500);
  }
}
const assistantText = (turn) => (turn.assistant_message ? turn.assistant_message.content : '');
const cliCommand = (turn) => (turn.events.find((e) => e.cli_command) || {}).cli_command || null;
const brief = (s, n = 160) => String(s || '').replace(/\s+/g, ' ').slice(0, n);
/** 命令行里 dsh.cmd 之前的长路径和后面的公共参数不用看，只留续聊参数那一段 */
const resumePart = (cmd) => (cmd ? brief((cmd.match(/--(session-id|resume)\s+\S+/) || ['（无续聊参数）'])[0], 120) : null);
const userMsg = async (threadId, turnId) => ((await getJson(BASE, `/api/chat/threads/${threadId}/messages`)).body.messages.find((m) => m.turn_id === turnId && m.role === 'user') || {}).status;

async function main() {
  const startedAt = new Date().toISOString();
  const health = (await getJson(BASE, '/api/health')).body;
  log(`服务 ${BASE} health=${JSON.stringify(health)}\ndsh=${defaultDshBin()}`);

  /* ---------- B1：建 thread，发一条，有真实回复 ---------- */
  const created = await postJson(BASE, '/api/chat/threads', { agent_id: 'dsh', title: 'P2 验收（真 dsh）' });
  const threadId = created.body.thread_id;
  const m1 = `口令是：${CODE}。它只是这次对话里的口令，不要写进任何文件。现在只回复两个字：收到。`;
  const s1 = await send(threadId, m1);
  const r1 = await waitTurn(s1.turn_id);
  const t1 = assistantText(r1);
  save('b1', { http: created.status, thread_id: threadId, request: m1, turn: r1.turn, reply: t1, events: r1.events, waited_ms: r1.waited_ms });
  record('B1', '建 dsh thread，发一条消息有真实回复', r1.turn.status === 'completed' && t1.trim().length > 0,
    `thread=${threadId} turn=${s1.turn_id} status=${r1.turn.status}（${r1.waited_ms}ms） 回复=「${brief(t1)}」`);

  /* ---------- B2：连发，第 3 条反映第 1 条 ---------- */
  const m2 = '第二句：用一句话介绍你自己，不要用工具。';
  const s2 = await send(threadId, m2);
  const r2 = await waitTurn(s2.turn_id);
  const m3 = '第三句：我在这次对话最开始告诉过你一个口令。请原样复述那个口令，只回复口令本身。';
  const s3 = await send(threadId, m3);
  const r3 = await waitTurn(s3.turn_id);
  const t3 = assistantText(r3);
  save('b2', { m2: { request: m2, turn: r2.turn, reply: assistantText(r2) }, m3: { request: m3, turn: r3.turn, reply: t3, events: r3.events } });
  record('B2', '连发 3 条，第 3 条能反映第 1 条内容', r2.turn.status === 'completed' && r3.turn.status === 'completed' && t3.includes(CODE),
    `第 2 条回复=「${brief(assistantText(r2), 80)}」\n第 3 条回复=「${brief(t3)}」（期望含口令 ${CODE}）`);

  /* ---------- B3：问「我第一句说了什么」 ---------- */
  const m4 = '我第一句说了什么？请一字不差地引用原文。';
  const s4 = await send(threadId, m4);
  const r4 = await waitTurn(s4.turn_id);
  const t4 = assistantText(r4);
  const norm = (s) => String(s).replace(/[\s，。、,.!！?？：:；;「」“”"'`（）()]/g, '');
  const quoted = norm(t4).includes(norm(`口令是：${CODE}`)) && norm(t4).includes(norm('不要写进任何文件'));
  save('b3', { request: m4, turn: r4.turn, reply: t4, first_message: m1 });
  record('B3', '问「我第一句说了什么」能答对', r4.turn.status === 'completed' && quoted, `回复=「${brief(t4, 260)}」`);

  /* ---------- B4：session-id 保存，第 2 条起走续聊 ---------- */
  const threadNow = (await getJson(BASE, `/api/chat/threads/${threadId}`)).body.thread;
  const messages = (await getJson(BASE, `/api/chat/threads/${threadId}/messages`)).body;
  const sid = threadNow.provider_session_id;
  const resumeTurns = [s2, s3, s4].map((s) => messages.turns.find((t) => t.turn_id === s.turn_id));
  const firstCmd = cliCommand(r1);
  const resumeCmds = [r2, r3, r4].map(cliCommand);
  const b4 = Boolean(sid) && /^session-/.test(sid)
    && resumeTurns.every((t) => t && t.resume === true)
    && Boolean(firstCmd) && !/--session-id|--resume/.test(firstCmd)
    && resumeCmds.every((c) => c && c.includes(`--session-id ${sid}`));
  save('b4', {
    provider_session_id: sid,
    turns: messages.turns.map((t) => ({ turn_id: t.turn_id, status: t.status, resume: t.resume })),
    first_command: firstCmd, resume_commands: resumeCmds,
    resume_events: [r2, r3, r4].map((r) => r.events.filter((e) => e.type === 'restoring' || e.type === 'started').map((e) => ({ type: e.type, resume: e.resume, provider_session_id: e.provider_session_id }))),
  });
  record('B4', 'session-id 正确保存，第 2 条起走续聊', b4,
    `provider_session_id=${sid}\n首轮命令=${resumePart(firstCmd)}\n第 2/3/4 条命令=${[...new Set(resumeCmds.map(resumePart))].join(' | ')}\nchat_turns.resume=${messages.turns.map((t) => t.resume ? 1 : 0).join(',')}（首轮 0，其余 1）`);

  /* ---------- B5-a：dsh 自己说会话不存在（8090 上真实制造） ---------- */
  const bad = (await postJson(BASE, '/api/chat/threads', { agent_id: 'dsh', title: 'P2 验收 B5（坏 session）' })).body.thread_id;
  const bogus = 'session-00000000-0000-4000-8000-000000000000';
  // 直接把库里的 provider_session_id 改成一个不存在的（与 P1 的 A7 同一做法），下一句 dsh 就会真的报 does not exist
  const db = new DatabaseSync(resolve(REPO, 'data', 'agent-office.db'));
  db.prepare('UPDATE chat_threads SET provider_session_id = ? WHERE thread_id = ?').run(bogus, bad);
  db.close();
  const lost = await send(bad, '只回复两个字：在');
  const rl = await waitTurn(lost.turn_id);
  const afterLost = (await getJson(BASE, `/api/chat/threads/${bad}/messages`)).body;
  save('b5a-session-not-found', {
    thread_id: bad, injected: bogus, turn: rl.turn, error_event: rl.events.find((e) => e.type === 'error'),
    thread_after: afterLost.thread, thread_status_after: afterLost.thread_status,
    user_message: afterLost.messages.find((m) => m.role === 'user'), assistant_message: afterLost.messages.find((m) => m.role === 'assistant'),
    system_message: afterLost.messages.find((m) => m.role === 'system'),
  });
  record('B5a', 'dsh 报会话不存在 → failed，带 dsh 的原话', rl.turn.status === 'failed' && rl.turn.error.code === 'session_not_found' && /does not exist/.test(rl.turn.error.message),
    `status=${rl.turn.status} code=${rl.turn.error.code}\nmessage=「${brief(rl.turn.error.message, 220)}」\n用户消息=${(afterLost.messages.find((m) => m.role === 'user') || {}).status} 助手消息=${(afterLost.messages.find((m) => m.role === 'assistant') || {}).status}`);

  /* ---------- B5-b：工作目录在发消息前被删（8090 上真实制造） ---------- */
  const wsDir = resolve(OUT, `ws-${Date.now()}`);
  mkdirSync(wsDir, { recursive: true });
  const wsThread = (await postJson(BASE, '/api/chat/threads', { agent_id: 'dsh', workspace: wsDir.replace(/\\/g, '/'), title: 'P2 验收 B5（工作目录没了）' })).body.thread_id;
  spawnSync('cmd.exe', ['/c', 'rmdir', '/s', '/q', wsDir], { stdio: 'ignore' });
  const wsSend = await send(wsThread, '只回复两个字：在');
  const rw = await waitTurn(wsSend.turn_id);
  const wsUser = await userMsg(wsThread, wsSend.turn_id);
  save('b5b-workspace-gone', { thread_id: wsThread, workspace: wsDir, turn: rw.turn, error_event: rw.events.find((e) => e.type === 'error'), event_types: rw.events.map((e) => e.type), user_message_status: wsUser });
  record('B5b', '工作目录没了 → failed，说清是哪个目录，没去起进程', rw.turn.status === 'failed' && rw.turn.error.reason === 'workspace_not_found' && rw.events.every((e) => !e.cli_command),
    `status=${rw.turn.status} reason=${rw.turn.error.reason}\nmessage=「${rw.turn.error.message}」 用户消息=${wsUser}`);

  /* ---------- B5-c：CLI 路径错 / 命令找不到（私有实例：真实 server.js + 临时库，DSH_BIN 指到坏路径） ---------- */
  if (!NO_PRIVATE) {
    for (const [name, bin, wantReason] of [
      ['cli_path_missing', 'C:/nope/never/installed/dsh.cmd', 'cli_path_missing'],
      ['cli_not_found', 'definitely-not-a-dsh-binary-xyz.cmd', 'cli_not_found'],
    ]) {
      const srv = await startChatServer({ claudeBin: 'inherit', dshBin: bin });
      try {
        const th = (await postJson(srv.base, '/api/chat/threads', { agent_id: 'dsh' })).body.thread_id;
        const s = (await postJson(srv.base, `/api/chat/threads/${th}/messages`, { content: '只回复两个字：在' })).body;
        let turn = null;
        for (let i = 0; i < 150; i += 1) {
          turn = (await getJson(srv.base, `/api/chat/turns/${s.turn_id}`)).body;
          if (turn && turn.turn && !ACTIVE.includes(turn.turn.status)) break;
          await sleep(100);
        }
        const msgs = (await getJson(srv.base, `/api/chat/threads/${th}/messages`)).body;
        const out = {
          dsh_bin: bin, instance: srv.base, turn: turn.turn, event_types: turn.events.map((e) => e.type),
          error_event: turn.events.find((e) => e.type === 'error'),
          user_message: msgs.messages.find((m) => m.role === 'user'), assistant_message: msgs.messages.find((m) => m.role === 'assistant'),
          thread_status: msgs.thread_status,
        };
        save(`b5c-${name}`, out);
        record(`B5c-${name}`, `DSH_BIN=${bin}`, turn.turn.status === 'failed' && turn.turn.error.kind === 'cli_start_failed' && turn.turn.error.reason === wantReason
          && out.user_message.status === 'failed' && out.assistant_message.status === 'failed',
          `status=${turn.turn.status}（界面 ${turn.turn.display_status}/${turn.turn.display_label}） code=${turn.turn.error.code} reason=${turn.turn.error.reason}\nmessage=「${turn.turn.error.message}」\n用户消息=${out.user_message.status} 助手消息=${out.assistant_message.status} 对话状态=${msgs.thread_status.status}`);
      } finally {
        await srv.stop();
      }
    }
  }

  /* ---------- 续聊参数对照：--resume（任务书口径）vs --session-id（dsh help 口径），都真跑 ---------- */
  for (const flag of ['resume', 'session-id']) {
    const a = await runDshTurn({ cwd: REPO, resumeId: null, onEvent: () => {}, prompt: `这次对话里我先设一个口令：${CODE}。它只是对话内的临时口令，不要写进任何文件。现在只回复两个字：收到。` });
    if (a.kind !== 'completed' || !a.sessionId) { probe(`flag-${flag}`, `新建会话（之后用 --${flag} 续）`, false, `kind=${a.kind} ${a.message}`); continue; }
    const evs = [];
    const b = await runDshTurn({ cwd: REPO, resumeId: a.sessionId, resumeFlag: flag, onEvent: (e) => evs.push(e), prompt: '口令是什么？只回复口令本身。' });
    const row = {
      flag,
      first: { kind: a.kind, sessionId: a.sessionId, text: a.text },
      resume: { kind: b.kind, reason: b.reason || null, exitCode: b.exitCode, sessionId: b.sessionId, text: b.text, message: b.message || null, command: (evs.find((e) => e.type === 'proc') || {}).command || null },
    };
    save(`resume-flag-${flag}`, { bin: defaultDshBin(), at: new Date().toISOString(), ...row });
    probe(`flag-${flag}`, `续聊参数 --${flag}：能不能接上上一句`, b.kind === 'completed' && b.text.includes(CODE),
      `命令=${resumePart(row.resume.command)}\nkind=${b.kind} exit=${b.exitCode} 回复=「${brief(b.text)}」${b.message ? ` 报错=「${brief(b.message)}」` : ''}`);
  }

  const acceptance = results.filter((r) => r.kind === 'acceptance');
  const probes = results.filter((r) => r.kind === 'probe');
  const byFlag = Object.fromEntries(probes.filter((r) => r.id.startsWith('flag-')).map((r) => [r.id.slice(5), r.works]));
  const conclusion = 'dsh headless 的续聊参数是 --session-id <真实 session-id>；--resume 是 Claude Code 的参数，dsh 不认（unknown option，exit 1）';
  save('summary', {
    started_at: startedAt, finished_at: new Date().toISOString(), base: BASE, health, bin: defaultDshBin(),
    acceptance, probes, resume_flag_works: byFlag, resume_flag_conclusion: conclusion,
    pass: acceptance.filter((r) => r.pass).length, total: acceptance.length,
  });
  log(`\n验收 B1-B5：${acceptance.filter((r) => r.pass).length}/${acceptance.length} 通过`);
  log(`续聊参数实测：${Object.entries(byFlag).map(([f, w]) => `--${f} ${w ? '能续' : '不能续'}`).join('；')}`);
  log(`结论：${conclusion}`);
  process.exit(acceptance.every((r) => r.pass) ? 0 : 1);
}

main().catch((err) => { console.error(err && err.stack ? err.stack : err); process.exit(2); });
