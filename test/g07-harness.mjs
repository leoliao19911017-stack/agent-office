// G07 测试夹具（harness）——四页启动流程回归测试共用的隔离环境。
//
// 隔离三件套（不碰 C:/Tools/agent-autoloop 真实数据，不起 8080 抢端口）：
//   1. stub 中台（node:http，临时端口）：/healthz + /v1/state，可切换故障模式
//      （garbage=200 回非 JSON、http503=透传 503），用于 API 异常注入；
//   2. 临时 AGENT_AUTOLOOP_HOME（os.tmpdir 下 mkdtemp，用完整目录删除）：
//      config.json 指向 stub 中台、office-data/tasks/*.json 按 STEP_DEFS 真实形状
//      造 3 条需求档案、skills.json 12 条、skill-meta.json 分类 overlay、
//      hermes-status.mjs 存根（输出与真实脚本同形状的 lemate/winter/karina）；
//   3. 真实 web/server.js 子进程：PORT=临时端口 + AGENT_AUTOLOOP_HOME=夹具目录，
//      就绪判定 = /api/health 真实响应（不是「进程活着」）。
// 浏览器 = playwright-core + 系统 Chrome（与 web/verify-*.mjs 同一已验证路径）。
//
// 本文件不含测试用例（命名不带 .test.js，node --test 不会收它），只被 G07 用例 import。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync as _rf } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // 仓库根（Soda Office）
export const WEB = join(ROOT, 'web');
export const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

if (!existsSync(CHROME)) {
  // 明确失败而不是悄悄跳过：G07 的验收口径就是真实浏览器跑真实页面。
  throw new Error(`G07 夹具：找不到系统 Chrome（${CHROME}），无法执行四页回归，请先安装 Chrome`);
}

/* ---------------- stub 中台 ---------------- */
// faultMode: null=正常 | 'garbage'=/v1/state 回 200+非JSON | 'http503'=/v1/state 回 503
// agentMode（R73/A01）: null|'fresh'=codex seenAt=now（与原版一致） | 'stale600'=seenAt 10 分钟前
//   | 'none'=不带 seenAt 字段 | 'offline'=online:false——控制连接健康×上报新鲜度的四种数据组合
export function startHub() {
  const hub = createServer((req, res) => {
    const u = new URL(req.url, 'http://stub');
    if (u.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (u.pathname === '/v1/state') {
      if (hub.faultMode === 'garbage') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html>stub-hub 故障注入：这不是 JSON</html>');
        return;
      }
      if (hub.faultMode === 'http503') {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'stub hub 人为 503', code: 'STUB_503' }));
        return;
      }
      // 与真实中台 /v1/state 同形状：前端只读 agents[].{id,seenAt,online,totals} 与 runs
      const now = new Date().toISOString();
      const codex = {
        id: 'codex', online: true, seenAt: now,
        totals: { queued: 0, running: 1, retrying: 0, done: 3 },
      };
      // R73/A01：按 agentMode 改写 codex 的连接字段；缺省（null/undefined/'fresh'）与原版逐字一致
      if (hub.agentMode === 'stale600') codex.seenAt = new Date(Date.now() - 600000).toISOString();
      else if (hub.agentMode === 'none') delete codex.seenAt;
      else if (hub.agentMode === 'offline') codex.online = false;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        now,
        agents: [codex],
        runs: [{ id: '9001', agent: 'codex', rule: 'G07 回归冒烟任务', state: 'running' }],
      }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `stub hub 不认识的路由：${u.pathname}` }));
  });
  return new Promise((resolve) => {
    hub.faultMode = null;
    hub.agentMode = null;
    hub.listen(0, '127.0.0.1', () => resolve(hub));
  });
}

/* ---------------- 临时 AGENT_AUTOLOOP_HOME ---------------- */

// 产物登记里指向一个「真实存在且在 FILE_ROOTS 白名单内」的文件（仓库自身的 app-base.css；
// G02 第 5 轮起 app.css 已按职责拆四文件，本引用跟随拆分产物），
// 这样 /api/office/file、/api/office/file-download 能走通真实读取链路。
// D 系列（审批与历史版本）额外用它登记「合成旧指纹」：磁盘零改动即可测历史分支。
export const REAL_FILE = join(WEB, 'app-base.css').replace(/\\/g, '/');
export const realFileMeta = () => {
  const buf = _rf(REAL_FILE);
  return { bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
};

const iso = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString();

// 三条需求档案，覆盖四种任务状态：awaiting（verify 待拍板）/ delivered / queued / active
// steps 是「按 step key 的 map」（与真实 tasks/*.json 一致，server.js 按 STEP_DEFS 展开）
function taskRecords() {
  const rf = realFileMeta();
  return [
    {
      id: 'T-G07A', title: 'G07 首屏验证需求（待拍板）',
      createdAt: iso(120), updatedAt: iso(2),
      steps: {
        req: { status: 'done', at: iso(100), note: 'Leo 提出：补齐四页回归测试', by: 'leo',
          files: [{ path: REAL_FILE, bytes: rf.bytes, sha256: rf.sha256 }] },
        doc: { status: 'done', at: iso(90), note: '测试任务书 v1', by: 'lemate' },
        plan: { status: 'done', at: iso(80), note: '12 用例拆解', by: 'lemate' },
        brief: { status: 'done', at: iso(70), note: '已派给测试夹具', by: 'lemate' },
        deliverable: { status: 'done', at: iso(30), note: '测试代码交付', by: 'lemate',
          files: [{ path: REAL_FILE, bytes: rf.bytes, sha256: rf.sha256 }] },
        verify: { status: 'awaiting', at: iso(5), note: '等 Leo 拍板验收', by: 'hermes' },
        final: { status: 'pending', at: null, note: '', by: null },
      },
    },
    {
      id: 'T-G07B', title: 'G07 已交付需求',
      createdAt: iso(600), updatedAt: iso(200),
      steps: {
        req: { status: 'done', at: iso(590), note: '历史需求', by: 'leo' },
        doc: { status: 'done', at: iso(580), note: '', by: 'lemate' },
        plan: { status: 'done', at: iso(570), note: '', by: 'lemate' },
        brief: { status: 'done', at: iso(560), note: '', by: 'lemate' },
        deliverable: { status: 'done', at: iso(300), note: '', by: 'lemate',
          files: [{ path: REAL_FILE, bytes: rf.bytes, sha256: rf.sha256 }] },
        verify: { status: 'done', at: iso(250), note: '验收通过', by: 'hermes' },
        final: { status: 'done', at: iso(200), note: '已交付归档', by: 'leo' },
      },
    },
    {
      id: 'T-G07C', title: 'G07 排队中需求',
      createdAt: iso(30), updatedAt: iso(29),
      steps: {
        req: { status: 'done', at: iso(29), note: '排队等前置', by: 'leo' },
        doc: { status: 'pending', at: null, note: '', by: null },
        plan: { status: 'pending', at: null, note: '', by: null },
        brief: { status: 'pending', at: null, note: '', by: null },
        deliverable: { status: 'pending', at: null, note: '', by: null },
        verify: { status: 'pending', at: null, note: '', by: null },
        final: { status: 'pending', at: null, note: '', by: null },
      },
    },
  ];
}

function skillEntries() {
  const mk = (name, desc) => ({
    name, description: desc,
    dir: 'C:/g07-fixture/skills/' + name,
    agents: ['claude'],
  });
  return [
    mk('gstack-command', 'G07 夹具技能：无头浏览器巡检（仿真实条目）'),
    mk('g07-regression-runner', 'G07 夹具技能：跑四页回归并出报告'),
    mk('g07-fixture-builder', 'G07 夹具技能：生成隔离测试数据'),
    mk('g07-route-probe', 'G07 夹具技能：探测 20 条 API 路由'),
    mk('g07-dom-audit', 'G07 夹具技能：核对业务 DOM 而非 HTTP 200'),
    mk('g07-timing-meter', 'G07 夹具技能：首屏耗时测量'),
    mk('g07-fault-injector', 'G07 夹具技能：API 故障注入与恢复'),
    mk('g07-nav-walker', 'G07 夹具技能：四页导航遍历'),
    mk('g07-refresh-keeper', 'G07 夹具技能：刷新位置保持验证'),
    mk('g07-console-guard', 'G07 夹具技能：console.error 清零守卫'),
    mk('g07-style-probe', 'G07 夹具技能：getComputedStyle 取证'),
    mk('g07-report-writer', 'G07 夹具技能：双版本验证报告'),
  ];
}

// extraTasks：追加的需求档案（g07-approval 的 D 系列注入漂移/历史版本任务）。
// 只写进本次调用方自己的临时 home，不影响 A/B/C/R 夹具的 3 任务断言。
// opts.noBase（R86 实测 test/r86-verify.mjs 用）：true 时不写 A/B/C 三条基础档案，
// 只写 extraTasks——「全是测试任务」等纯净场景；缺省行为与 G07 用例完全一致。
export function buildFixtureHome(hubPort, extraTasks = [], opts = {}) {
  const home = mkdtempSync(join(tmpdir(), 'g07-autoloop-'));
  const od = join(home, 'office-data');
  mkdirSync(join(od, 'tasks'), { recursive: true });
  writeFileSync(join(home, 'config.json'), JSON.stringify({
    url: `http://127.0.0.1:${hubPort}`, owner: 'g07-stub-owner-key',
  }));
  const recs = opts.noBase ? extraTasks : [...taskRecords(), ...extraTasks];
  for (const rec of recs) {
    writeFileSync(join(od, 'tasks', `${rec.id}.json`), JSON.stringify(rec, null, 1));
  }
  writeFileSync(join(od, 'skills.json'), JSON.stringify({
    generatedAt: iso(1), roots: ['C:/g07-fixture/skills'],
    skills: skillEntries(),
  }));
  // 分类 overlay：只给 4 条，其余 category=null（前端归「未分类」）——
  // 刻意制造混合，验证 overlay 合并逻辑而不是全员同值
  writeFileSync(join(od, 'skill-meta.json'), JSON.stringify({
    _comment: 'G07 夹具分类 overlay',
    categories: {
      'gstack-command': '开发', 'g07-regression-runner': '测试', 'g07-route-probe': '测试',
      'g07-report-writer': '交付',
    },
  }));
  writeFileSync(join(od, 'index.json'), JSON.stringify({ generatedAt: iso(1), tasks: [] }));
  writeFileSync(join(od, 'decision-events.jsonl'), '');
  // hermes-status.mjs 存根：与真实脚本 'read' 子命令同输出形状；时间戳每次现算保证不 stale。
  // R73/A01：可选 hermes-control.json（同目录）按 agent id 覆盖字段（online/lastReport/
  // reportStale/state…，absent 数组可整条下线）——无该文件时输出与原存根逐字一致。
  writeFileSync(join(home, 'hermes-status.mjs'), [
    '#!/usr/bin/env node',
    '// G07 夹具存根：输出形状与真实 hermes-status.mjs read 完全一致',
    "import { readFileSync, existsSync } from 'node:fs';",
    "import { dirname, join } from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    'const now = new Date().toISOString();',
    'let agents = [',
    `  {id:'lemate', name:'Lemate', type:'Hermes', scene:'dev', sceneDetail:'G07 隔离夹具', online:true, lastBeat:now, heartbeatAgeSec:12, state:'working', task:'G07 回归冒烟：执行测试', lastReport:now, reportStale:false},`,
    `  {id:'winter', name:'Winter', type:'Hermes', scene:'video', sceneDetail:'G07 隔离夹具', online:true, lastBeat:now, heartbeatAgeSec:20, state:'idle', task:'', lastReport:now, reportStale:false},`,
    `  {id:'karina', name:'Karina', type:'Hermes', scene:'notes', sceneDetail:'G07 隔离夹具', online:true, lastBeat:now, heartbeatAgeSec:25, state:'idle', task:'', lastReport:now, reportStale:false},`,
    '];',
    "const ctrlPath = join(dirname(fileURLToPath(import.meta.url)), 'hermes-control.json');",
    'if (existsSync(ctrlPath)) {',
    '  const ctrl = JSON.parse(readFileSync(ctrlPath, "utf8"));',
    '  if (Array.isArray(ctrl.absent)) agents = agents.filter((a) => !ctrl.absent.includes(a.id));',
    '  for (const a of agents) { if (ctrl[a.id]) Object.assign(a, ctrl[a.id]); }',
    '}',
    'process.stdout.write(JSON.stringify({ generatedAt: now, agents }));',
  ].join('\n'));
  // flow.mjs 存根（R73/W01-④）：decide/resubmit 走本子进程写回档案。真实 flow.mjs 属于
  // agent-autoloop，夹具不复刻全部 CLI，只实现 server.js 用到的 `init` 与 `set` 子命令
  // （TASK-向导化改造 X07 的 /api/office/new-task 还会调 init）：
  // init = 建 7 槽骨架档案；set = 读 office-data/tasks/<id>.json → 改步骤状态/at/by/note
  // → 原子写回 → 打印 {ok:true}。
  // server 端 execFlowWriteAndVerify 随后自行读回核验，不信任本存根的 stdout。
  writeFileSync(join(home, 'flow.mjs'), [
    '#!/usr/bin/env node',
    '// G07 夹具存根：只实现 server.js 会调用的 flow.mjs init / set 子命令',
    "import { readFileSync, writeFileSync, renameSync } from 'node:fs';",
    "import { join, dirname } from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    'const home = dirname(fileURLToPath(import.meta.url));',
    'const a = process.argv.slice(2);',
    "const atomic = (file, rec) => { const tmp = file + '.g07stub'; writeFileSync(tmp, JSON.stringify(rec, null, 1)); renameSync(tmp, file); };",
    "if (a[0] === 'init') {",
    "  // 与真实 flow.mjs init 对齐：新建 7 槽全 pending 骨架（title 为 argv[4]）",
    "  const KEYS = ['req','doc','plan','brief','deliverable','verify','final'];",
    "  const now = new Date().toISOString();",
    "  const rec = { id: a[1], title: a[2] || a[1], createdAt: now, updatedAt: now, steps: {} };",
    "  for (const k of KEYS) rec.steps[k] = { status: 'pending', at: null, note: '', files: [], by: null };",
    "  const file = join(home, 'office-data', 'tasks', a[1] + '.json');",
    '  atomic(file, rec);',
    "  process.stdout.write(JSON.stringify({ ok: true, id: rec.id, steps: KEYS.length }));",
    '  process.exit(0);',
    '}',
    "if (a[0] !== 'set') { process.stdout.write(JSON.stringify({ ok: false, error: 'stub 只支持 init/set' })); process.exit(1); }",
    'const [, taskId, stepKey, ...flags] = a;',
    "const flag = (k) => { const i = flags.indexOf('--' + k); return i >= 0 ? flags[i + 1] : undefined; };",
    "const file = join(home, 'office-data', 'tasks', taskId + '.json');",
    "const rec = JSON.parse(readFileSync(file, 'utf8'));",
    'const st = rec.steps[stepKey];',
    "st.status = flag('status');",
    'st.at = new Date().toISOString();',
    "st.by = flag('by');",
    "const note = flag('note');",
    'if (note != null) st.note = note;',
    'rec.updatedAt = st.at;',
    'atomic(file, rec);',
    'process.stdout.write(JSON.stringify({ ok: true }));',
  ].join('\n'));
  return home;
}

/* ---------------- 真实 server.js 子进程 ---------------- */

function reservePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

export async function startServer(home) {
  const port = await reservePort();
  const child = spawn(process.execPath, [join(WEB, 'server.js')], {
    env: { ...process.env, PORT: String(port), AGENT_AUTOLOOP_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '', stdout = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });

  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  // 就绪 = /api/health 真实 200（HTTP 200 只当「进程起来了」，body 还要核对 build 字段）
  for (;;) {
    if (child.exitCode != null) {
      throw new Error(`G07 夹具：server.js 提前退出 code=${child.exitCode}\nstdout=${stdout}\nstderr=${stderr}`);
    }
    if (Date.now() - t0 > 15000) {
      throw new Error(`G07 夹具：server.js 15s 未就绪\nstdout=${stdout}\nstderr=${stderr}`);
    }
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) {
        const j = await r.json();
        if (j && j.ok === true && typeof j.build === 'string') break;
      }
    } catch { /* 还没监听，继续等 */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return { child, base, getLogs: () => ({ stdout, stderr }) };
}

/* ---------------- 一键起整套 + 收尾 ---------------- */

export async function startStack(extraTasks = [], opts = {}) {
  const hub = await startHub();
  const hubPort = hub.address().port;
  const home = buildFixtureHome(hubPort, extraTasks, opts);
  const srv = await startServer(home);
  return {
    hub, home, base: srv.base, child: srv.child, getLogs: srv.getLogs,
    async stop() {
      if (srv.child.exitCode == null) srv.child.kill();
      await new Promise((r) => setTimeout(r, 150));
      hub.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

export async function launchBrowser() {
  return chromium.launch({ executablePath: CHROME, headless: true });
}

// 每个用例一个干净页：捕获 console.error / pageerror，便于「零异常」断言
export function newPage(browser) {
  const state = { consoleErrs: [], pageErrors: [], consoleAll: [] };
  return (async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', (e) => state.pageErrors.push(String(e).slice(0, 200)));
    page.on('console', (m) => {
      const txt = m.text().slice(0, 300);
      state.consoleAll.push(m.type() + '|' + txt);
      if (m.type() === 'error') state.consoleErrs.push(txt);
    });
    return { page, state };
  })();
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
