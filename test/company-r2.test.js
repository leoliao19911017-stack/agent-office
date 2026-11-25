// TASK-COMPANY-D0-R2 验收测试：B1-B11（项目 + worktree 数据层）、B12-B14（HTTP 层）。
// 运行：node --no-warnings --test test/company-r2.test.js
//
// 口径与 company.test.js 一致：内存 SQLite + 临时 git 仓库（worktree 全落在会被
// 统一删除的临时目录里），HTTP 层起真实 server.js 子进程，不碰真库不抢 8090。
// R1/R2/R6/R18（界面渲染）在 scripts/verify-company-r2.mjs 里用 playwright 截图验。
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { openDb, closeDb } from '../web/lib/db.mjs';
import {
  acceptWork, archiveProject, createProject, createWork, deliverWork, finishExecution,
  getProjectDetail, getWork, listProjects, mergeExecution, startExecution, updateProject,
} from '../web/lib/company.mjs';
import { startChatServer, postJson, getJson, patchJson } from './chat-harness.mjs';

const tempRepos = [];
after(() => {
  for (const repo of tempRepos) {
    try { rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Windows 句柄延迟不挡断言 */ }
  }
});

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim();
}

/** 建一个真 git 临时仓库（有初始提交，够 worktree add 用）。 */
function makeTempRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'soda-r2-repo-'));
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Soda Test']);
  writeFileSync(join(repo, 'README.md'), '# temp repo\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'init']);
  tempRepos.push(repo);
  return repo;
}

/** 内存库 + 把预置项目的 root_path 指到临时仓库。 */
function freshDb() {
  const db = openDb({ memory: true });
  db.prepare("UPDATE projects SET root_path = ? WHERE project_id = 'proj-agent-office'").run(makeTempRepo());
  return db;
}

/** 交办一件挂 proj-agent-office 的任务，返回 work_id（to 控制走到的状态）。 */
function makeWork(db, { to = 'pending', owner = 'emp-claude' } = {}) {
  const w = createWork(db, {
    title: 'R2 测试任务', what_to_deliver: '一份文档', acceptance: '过全部断言',
    project_id: 'proj-agent-office', owner_employee_id: owner, assigned_by: 'leo',
  });
  if (to === 'pending') return w.work_id;
  startExecution(db, w.work_id, {});
  if (to === 'delivered') deliverWork(db, w.work_id, { output_refs: ['docs/x.md'] });
  return w.work_id;
}

// ---------------------------------------------------------------------------
// B1 / B2：项目表 + 种子 + CRUD
// ---------------------------------------------------------------------------

test('B1 种子：只种 Agent Office（root_path 真实存在）；workflow_runs 有 project_id 列', () => {
  const db = openDb({ memory: true });   // 不改 root_path，验种子本来的值
  try {
    const projects = listProjects(db);
    assert.equal(projects.length, 1, 'EaseDraw 路径没确认存在，就不该种');
    const p = projects[0];
    assert.equal(p.project_id, 'proj-agent-office');
    assert.ok(!/easedraw/i.test(p.name), ' EaseDraw 不在种子里');
    assert.ok(existsSync(p.root_path) && statSync(p.root_path).isDirectory(),
      `种子的 root_path 必须真实存在：${p.root_path}`);

    const cols = db.prepare('PRAGMA table_info(workflow_runs)').all().map((c) => c.name);
    assert.ok(cols.includes('project_id'), `workflow_runs 应有 project_id 列：${cols.join(',')}`);
    const wcols = db.prepare('PRAGMA table_info(work_executions)').all().map((c) => c.name);
    for (const c of ['worktree_path', 'branch_name', 'base_ref', 'commit_sha', 'session_ref']) {
      assert.ok(wcols.includes(c), `work_executions 应有 ${c} 列`);
    }
  } finally { closeDb(db); }
});

test('B2 项目 CRUD：root_path 必须真实存在；重名 409；改描述 / 归档保护', () => {
  const db = freshDb();
  try {
    // root_path 给了但不存在 → 400 ROOT_NOT_FOUND
    assert.throws(() => createProject(db, { name: '幻影项目', root_path: 'E:/no/such/dir' }),
      (e) => e.statusCode === 400 && e.code === 'ROOT_NOT_FOUND');
    // 缺名字 → 400
    assert.throws(() => createProject(db, { root_path: makeTempRepo() }),
      (e) => e.statusCode === 400 && e.code === 'MISSING_NAME');

    const repo2 = makeTempRepo();
    const p = createProject(db, { name: '逸刻EaseDraw', description: '画板', root_path: repo2, department_id: 'dev' });
    assert.ok(p.project_id.startsWith('proj-'));
    assert.equal(p.root_path, repo2);
    assert.equal(p.department_name, '研发部');

    assert.throws(() => createProject(db, { name: '逸刻EaseDraw' }),
      (e) => e.statusCode === 409 && e.code === 'PROJECT_NAME_TAKEN');
    assert.throws(() => updateProject(db, p.project_id, { name: 'Agent Office' }),
      (e) => e.statusCode === 409 && e.code === 'PROJECT_NAME_TAKEN');
    assert.throws(() => updateProject(db, p.project_id, { status: ' vanished' }),
      (e) => e.statusCode === 400 && e.code === 'BAD_STATUS');
    const patched = updateProject(db, p.project_id, { description: '白板 + 画笔' });
    assert.equal(patched.description, '白板 + 画笔');

    // 详情带需求 / 任务计数
    const wid = makeWork(db);   // pending，挂在 proj-agent-office
    const detail = getProjectDetail(db, 'proj-agent-office');
    assert.equal(detail.task_count, 1);
    assert.ok(detail.tasks.some((t) => t.work_id === wid));

    // 归档保护：有未完结任务 → 409
    assert.throws(() => archiveProject(db, 'proj-agent-office'),
      (e) => e.statusCode === 409 && e.code === 'PROJECT_HAS_ACTIVE_WORK');

    // 任务收口后，插一条 running 的 workflow_run → 仍 409（另一个保护）
    startExecution(db, wid, {});
    finishExecution(db, wid, { output_refs: ['a.md'] });
    acceptWork(db, wid);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO workflow_templates (template_id, name, version, steps, created_at, updated_at)
      VALUES ('tpl-x', 'x', 1, '[]', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO workflow_runs
      (run_id, template_id, template_version, title, status, project_id, created_at, updated_at)
      VALUES ('run-x', 'tpl-x', 1, '需求x', 'running', 'proj-agent-office', ?, ?)`).run(now, now);
    assert.throws(() => archiveProject(db, 'proj-agent-office'),
      (e) => e.statusCode === 409 && e.code === 'PROJECT_HAS_RUNNING_RUN');
    db.prepare("UPDATE workflow_runs SET status = 'completed' WHERE run_id = 'run-x'").run();
    const archived = archiveProject(db, 'proj-agent-office');
    assert.equal(archived.status, 'archived');
    assert.ok(archived.archived_at);
    assert.equal(archiveProject(db, 'proj-agent-office').status, 'archived', '重复归档幂等');
    assert.equal(listProjects(db).length, 1, '归档后不进列表');
  } finally { closeDb(db); }
});

// ---------------------------------------------------------------------------
// B3-B7：start / finish 的 worktree 链路
// ---------------------------------------------------------------------------

test('B3 start：按 §3.2 建真 worktree + exec 分支，记 base_ref，上锁', () => {
  const db = freshDb();
  try {
    const wid = makeWork(db, { to: 'pending' });
    const s = startExecution(db, wid, {});
    assert.ok(s.execution_id.startsWith('exec-'));
    assert.equal(s.branch_name, `exec/${s.execution_id}`);
    assert.equal(s.base_ref, 'main');
    const expectPath = join(db.prepare('SELECT root_path r FROM projects').get().r, '.worktrees', wid, s.execution_id);
    assert.equal(s.worktree_path, expectPath, '目录规范 <root>/.worktrees/<work_id>/<execution_id>');
    assert.ok(existsSync(expectPath), 'worktree 真的建出来了');
    assert.ok(git(expectPath, ['worktree', 'list']).includes(expectPath.replace(/\\/g, '/'))
      || git(db.prepare('SELECT root_path r FROM projects').get().r, ['worktree', 'list']).includes(s.execution_id),
      'git worktree list 能看到它');
    assert.ok(git(expectPath, ['branch', '--list', s.branch_name]).includes(s.branch_name), 'exec 分支存在');

    const lock = db.prepare('SELECT * FROM worktree_locks WHERE execution_id = ?').get(s.execution_id);
    assert.ok(lock && !lock.released_at, '锁已获取未释放');
    const exec = db.prepare('SELECT * FROM work_executions WHERE execution_id = ?').get(s.execution_id);
    assert.equal(exec.worktree_path, expectPath);
    assert.equal(exec.branch_name, `exec/${s.execution_id}`);
    assert.equal(exec.base_ref, 'main');
    assert.equal(getWork(db, wid).status, 'running');
  } finally { closeDb(db); }
});

test('B4 重复 start → 409，不产生第二个 worktree', () => {
  const db = freshDb();
  try {
    const wid = makeWork(db, { to: 'running' });
    assert.throws(() => startExecution(db, wid, {}),
      (e) => e.statusCode === 409 && e.code === 'WORK_ALREADY_RUNNING');
    const n = db.prepare('SELECT COUNT(*) n FROM work_executions WHERE work_id = ?').get(wid).n;
    assert.equal(n, 1, '只有一条执行记录');
    const repo = db.prepare('SELECT root_path r FROM projects').get().r;
    const list = git(repo, ['worktree', 'list']);
    assert.equal((list.match(new RegExp(wid, 'g')) || []).length, 1, 'git worktree list 里该任务只有一个目录');
  } finally { closeDb(db); }
});

test('B5 finish：有改动 → commit_sha；锁释放；worktree 保留；带成果 → delivered', () => {
  const db = freshDb();
  try {
    const wid = makeWork(db, { to: 'running' });
    const exec = db.prepare('SELECT * FROM work_executions WHERE work_id = ?').get(wid);
    writeFileSync(join(exec.worktree_path, 'intro.md'), 'R2 成果\n');
    const w = finishExecution(db, wid, {
      output_refs: [{ name: '功能介绍.md', path: 'docs/intro.md' }, { name: '对比表.md', path: 'docs/compare.md' }],
      result_summary: '写完两份',
    });
    assert.equal(w.status, 'delivered');
    assert.deepEqual(w.output_refs, [{ name: '功能介绍.md', path: 'docs/intro.md' }, { name: '对比表.md', path: 'docs/compare.md' }]);
    assert.equal(w.deliverable_count, 2);
    const done = db.prepare('SELECT * FROM work_executions WHERE execution_id = ?').get(exec.execution_id);
    assert.equal(done.status, 'success');
    assert.match(done.commit_sha, /^[0-9a-f]{40}$/, '记录了真实 commit sha');
    assert.equal(git(exec.worktree_path, ['rev-parse', 'HEAD']), done.commit_sha, 'sha 与 worktree HEAD 一致');
    assert.match(git(exec.worktree_path, ['log', '-1', '--format=%s']), new RegExp(`exec: ${exec.execution_id}`), '提交信息带执行号');
    const lock = db.prepare('SELECT * FROM worktree_locks WHERE execution_id = ?').get(exec.execution_id);
    assert.ok(lock.released_at, '锁已释放');
    assert.ok(existsSync(exec.worktree_path), 'worktree 保留（§3.5 只实现保留）');
  } finally { closeDb(db); }
});

test('B6 finish failed:true → 执行记 failed，任务退回 pending 可重启，原因落库', () => {
  const db = freshDb();
  try {
    const wid = makeWork(db, { to: 'running' });
    const w = finishExecution(db, wid, { failed: true, error: '工具没起来' });
    assert.equal(w.status, 'pending');
    assert.equal(w.status_reason, '工具没起来');
    const exec = db.prepare('SELECT * FROM work_executions WHERE work_id = ? ORDER BY started_at DESC').get(wid);
    assert.equal(exec.status, 'failed');
    assert.ok(db.prepare('SELECT released_at r FROM worktree_locks WHERE execution_id = ?').get(exec.execution_id).r, '锁也释放');
    // 重启：可以再 start（产生第二条执行）
    const s2 = startExecution(db, wid, {});
    assert.ok(s2.execution_id !== exec.execution_id);
    const n = db.prepare('SELECT COUNT(*) n FROM work_executions WHERE work_id = ?').get(wid).n;
    assert.equal(n, 2);
  } finally { closeDb(db); }
});

test('B7 finish 没有改动 → commit_sha 空串（没有可合并的东西，不造空提交）', () => {
  const db = freshDb();
  try {
    const wid = makeWork(db, { to: 'running' });
    const w = finishExecution(db, wid, { result_summary: '没改东西' });
    assert.equal(w.status, 'delivered', '成功但没带 refs → delivered + 待核验');
    assert.deepEqual(w.output_refs, []);
    const exec = db.prepare('SELECT * FROM work_executions WHERE work_id = ?').get(wid);
    assert.equal(exec.commit_sha, '');
  } finally { closeDb(db); }
});

// ---------------------------------------------------------------------------
// B8-B10：merge
// ---------------------------------------------------------------------------

test('B8 merge：accepted 才能合；--no-ff 合入主仓后清 worktree + 删分支', () => {
  const db = freshDb();
  try {
    const wid = makeWork(db, { to: 'running' });
    const exec = db.prepare('SELECT * FROM work_executions WHERE work_id = ?').get(wid);
    writeFileSync(join(exec.worktree_path, 'feat.md'), 'R2 成果\n');
    finishExecution(db, wid, { output_refs: ['feat.md'] });
    acceptWork(db, wid);

    const repo = db.prepare('SELECT root_path r FROM projects').get().r;
    const m = mergeExecution(db, wid);
    assert.equal(m.ok, true);
    assert.equal(m.merged_branch, exec.branch_name);
    assert.equal(m.cleanup_error, null);
    assert.ok(git(repo, ['log', '-1', '--format=%s']).includes(exec.branch_name), '主仓最新提交是 merge commit');
    assert.ok(git(repo, ['log', '--oneline']).includes(m.commit_sha.slice(0, 7)), '执行提交已在主仓历史里');
    assert.ok(!existsSync(exec.worktree_path), 'worktree 已清理');
    assert.equal(git(repo, ['branch', '--list', exec.branch_name]), '', 'exec 分支已删');
  } finally { closeDb(db); }
});

test('B9 merge 冲突 → 409 MERGE_CONFLICT，worktree 与分支原样保留', () => {
  const db = freshDb();
  try {
    const wid = makeWork(db, { to: 'running' });
    const exec = db.prepare('SELECT * FROM work_executions WHERE work_id = ?').get(wid);
    writeFileSync(join(exec.worktree_path, 'conflict.md'), '来自执行分支\n');
    finishExecution(db, wid, { output_refs: ['conflict.md'] });
    acceptWork(db, wid);
    // 主仓同文件改出冲突
    const repo = db.prepare('SELECT root_path r FROM projects').get().r;
    writeFileSync(join(repo, 'conflict.md'), '来自主仓\n');
    git(repo, ['add', 'conflict.md']);
    git(repo, ['commit', '-m', 'main 改了同一个文件']);

    assert.throws(() => mergeExecution(db, wid),
      (e) => e.statusCode === 409 && e.code === 'MERGE_CONFLICT');
    assert.ok(existsSync(exec.worktree_path), '冲突时 worktree 不动');
    assert.ok(git(repo, ['branch', '--list', exec.branch_name]).includes(exec.branch_name), '分支不动');
    // 主仓停在冲突现场：MERGE_HEAD 存在，留给人工处理
    assert.ok(git(repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).length > 0, 'MERGE_HEAD 在（等人工收场）');
    git(repo, ['merge', '--abort']);   // 收掉现场，让临时仓库好删
  } finally { closeDb(db); }
});

test('B10 merge 前置校验：未验收 409；没有任何 commit_sha 409', () => {
  const db = freshDb();
  try {
    const wid = makeWork(db, { to: 'delivered' });   // B7 路径：无改动 → 无 sha
    assert.throws(() => mergeExecution(db, wid),
      (e) => e.statusCode === 409 && e.code === 'WORK_NOT_ACCEPTED');
    acceptWork(db, wid);
    assert.throws(() => mergeExecution(db, wid),
      (e) => e.statusCode === 409 && e.code === 'NO_COMMIT_TO_MERGE');
  } finally { closeDb(db); }
});

// ---------------------------------------------------------------------------
// B11：并发隔离
// ---------------------------------------------------------------------------

test('B11 并发：两件任务同时 running → 两个互不相干的 worktree + 两把锁', () => {
  const db = freshDb();
  try {
    const w1 = makeWork(db, { to: 'running' });
    const w2 = makeWork(db, { to: 'running' });
    const repo = db.prepare('SELECT root_path r FROM projects').get().r;
    const list = git(repo, ['worktree', 'list']);
    assert.ok(list.includes(w1), `worktree list 应含任务1的目录：${list}`);
    assert.ok(list.includes(w2), `worktree list 应含任务2的目录：${list}`);
    const locks = db.prepare('SELECT COUNT(*) n FROM worktree_locks WHERE released_at IS NULL').get().n;
    assert.equal(locks, 2, '两把未释放的锁');
    // 互不影响：任务1收尾不动任务2的目录
    finishExecution(db, w1, { failed: true, error: 'x' });
    assert.ok(existsSync(db.prepare('SELECT worktree_path p FROM work_executions WHERE work_id = ?').get(w2).p));
  } finally { closeDb(db); }
});

// ---------------------------------------------------------------------------
// B12-B14：HTTP 层
// ---------------------------------------------------------------------------

test('B12 HTTP：/api/projects 列表 / 建 / 详情 / PATCH / DELETE 保护', async () => {
  const srv = await startChatServer();
  try {
    const list = await getJson(srv.base, '/api/projects');
    assert.equal(list.status, 200);
    assert.equal(list.body.projects.length, 1, '种子只有 Agent Office');
    const seed = list.body.projects[0];
    assert.equal(seed.project_id, 'proj-agent-office');
    assert.ok('requirement_count' in seed && 'task_count' in seed);

    const bad = await postJson(srv.base, '/api/projects', { name: '幻影', root_path: 'E:/no/such/dir' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'ROOT_NOT_FOUND');

    const created = await postJson(srv.base, '/api/projects', { name: '测试项目', description: 'HTTP 建' });
    assert.equal(created.status, 201);
    assert.equal(created.body.project.name, '测试项目');
    const pid = created.body.project.project_id;

    const patched = await patchJson(srv.base, `/api/projects/${pid}`, { description: '改过了' });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.project.description, '改过了');

    const detail = await getJson(srv.base, '/api/projects/proj-agent-office');
    assert.equal(detail.status, 200);
    assert.ok(Array.isArray(detail.body.project.requirements));
    assert.ok(Array.isArray(detail.body.project.tasks));

    // 挂一件未完结任务 → DELETE 409
    const w = await postJson(srv.base, '/api/work', {
      title: 'x', owner_employee_id: 'emp-claude', project_id: 'proj-agent-office',
    });
    assert.equal(w.status, 201);
    const del = await srvFetch(srv.base, 'DELETE', '/api/projects/proj-agent-office');
    assert.equal(del.status, 409);
    assert.equal(del.body.code, 'PROJECT_HAS_ACTIVE_WORK');
    const del2 = await srvFetch(srv.base, 'DELETE', `/api/projects/${pid}`);
    assert.equal(del2.status, 200, '没挂任务的项目能归档');
    assert.equal(del2.body.project.status, 'archived');
  } finally { await srv.stop(); }
});

test('B13 HTTP：start 返回 worktree_path；finish / accept / merge 全链路', async () => {
  const srv = await startChatServer();
  try {
    const repo = makeTempRepo();
    const patched = await patchJson(srv.base, '/api/projects/proj-agent-office', { root_path: repo });
    assert.equal(patched.status, 200);

    const w = await postJson(srv.base, '/api/work', {
      title: 'R2 HTTP 任务', owner_employee_id: 'emp-claude', project_id: 'proj-agent-office',
    });
    const wid = w.body.work.work_id;

    const s = await postJson(srv.base, `/api/work/${wid}/start`, {});
    assert.equal(s.status, 201);
    assert.ok(s.body.worktree_path.endsWith(join('.worktrees', wid, s.body.execution_id)),
      `start 应带回规范路径 <root>/.worktrees/<work_id>/<execution_id>：${s.body.worktree_path}`);
    assert.equal(s.body.branch_name, `exec/${s.body.execution_id}`);
    assert.ok(existsSync(s.body.worktree_path));

    writeFileSync(join(s.body.worktree_path, 'http.md'), 'HTTP 链路成果\n');
    const f = await postJson(srv.base, `/api/work/${wid}/finish`, {
      output_refs: [{ name: 'http.md', path: 'http.md' }], result_summary: '完成',
    });
    assert.equal(f.status, 200);
    assert.equal(f.body.work.status, 'delivered');
    assert.match(await dbSha(srv, f.body.work.executions[0].execution_id), /^[0-9a-f]{40}$/);

    const ac = await postJson(srv.base, `/api/work/${wid}/accept`, {});
    assert.equal(ac.status, 200);
    const m = await postJson(srv.base, `/api/work/${wid}/merge`, {});
    assert.equal(m.status, 200);
    assert.equal(m.body.ok, true);
    assert.equal(m.body.cleanup_error, null);
    assert.ok(!existsSync(s.body.worktree_path), '合并后 worktree 清理');
  } finally { await srv.stop(); }
});

test('B14 HTTP：挂不存在的项目 → 400 PROJECT_NOT_FOUND；无项目 start → 400', async () => {
  const srv = await startChatServer();
  try {
    const bad = await postJson(srv.base, '/api/work', {
      title: 'x', owner_employee_id: 'emp-claude', project_id: 'proj-nope',
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'PROJECT_NOT_FOUND');

    // 存量任务没挂项目（直接改库造出来）→ start 400 PROJECT_REQUIRED
    const w = await postJson(srv.base, '/api/work', {
      title: 'y', owner_employee_id: 'emp-claude', project_id: 'proj-agent-office',
    });
    const wid = w.body.work.work_id;
    // 服务进程持有独立的临时库文件，这里从测试进程打开同一个文件改（WAL 支持多连接）
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(srv.dbPath);
    db.prepare('UPDATE work_items SET project_id = NULL WHERE work_id = ?').run(wid);
    const s = await postJson(srv.base, `/api/work/${wid}/start`, {});
    assert.equal(s.status, 400);
    assert.equal(s.body.code, 'PROJECT_REQUIRED');
    db.close();
  } finally { await srv.stop(); }
});

/** 从服务进程的库里读执行记录的 commit_sha（B13 用）。 */
async function dbSha(srv, executionId) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(srv.dbPath);
  const sha = db.prepare('SELECT commit_sha s FROM work_executions WHERE execution_id = ?').get(executionId).s;
  db.close();
  return sha;
}

/** DELETE 走不了 postJson，单独封一个。 */
async function srvFetch(base, method, path) {
  const res = await fetch(base + path, { method });
  return { status: res.status, body: await res.json().catch(() => null) };
}
