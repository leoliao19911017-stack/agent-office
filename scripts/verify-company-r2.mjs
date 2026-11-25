// verify-company-r2.mjs — TASK-COMPANY-D0-R2 验收证据采集（R1-R4 / R6-R15 / R18）。
//
//   ① 生产库副本迁移验证（R3 种子 / R4 回填）：拷 data/agent-office.db（含 -wal/-shm）到临时目录，
//      用 openDb 跑 v11 迁移后只读查询。绝不写生产库。
//   ② 真仓库 worktree E2E（R7/R8/R9/R12/R15 + R14）：隔离服务（临时库）+ 项目 root_path 指向本仓库，
//      两件任务并发 start → 真 worktree → finish 提交 → 手工清理（不合入真分支）。
//   ③ playwright 截图（R1/R2/R6/R18）：系统 Chrome，1440x900，截图进 docs/evidence/company/。
//
// 运行：node scripts/verify-company-r2.mjs   （从仓库根目录）
// 输出：docs/evidence/company/r2-verify.json + 4 张截图；stdout 打印同一份 JSON。
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EVID = join(ROOT, 'docs', 'evidence', 'company');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const evidence = { generatedAt: new Date().toISOString(), part1: null, part2: null, part3: null };

function git(args, opts = {}) {
  // 与 web/lib/git-ops.mjs 同口径：worktree 嵌套后仓库深路径会撞 Windows 260 上限
  return execFileSync('git', ['-c', 'core.longpaths=true', '-C', opts.cwd || ROOT, ...args], { encoding: 'utf8', windowsHide: true }).trim();
}

const scratch = [];
function cleanupScratch() {
  for (const p of scratch.reverse()) {
    try { rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 报告里如实说 */ }
  }
}

// ---------------------------------------------------------------------------
// ① 生产库副本：v11 迁移验证（R3 / R4）
// ---------------------------------------------------------------------------
async function part1() {
  const { openDb, closeDb } = await import('../web/lib/db.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'soda-r2-proddb-'));
  scratch.push(dir);
  const srcBase = join(ROOT, 'data', 'agent-office.db');
  const copied = [];
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(srcBase + suffix)) {
      copyFileSync(srcBase + suffix, join(dir, 'agent-office.db' + suffix));
      copied.push('agent-office.db' + suffix);
    }
  }
  const db = openDb({ path: join(dir, 'agent-office.db') });
  try {
    const version = Number(db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get().value);
    const projects = db.prepare('SELECT project_id, name, root_path, status FROM projects ORDER BY sort_index').all();
    const hasRuns = db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='workflow_runs'").get().n > 0;
    const runs = hasRuns ? db.prepare(`
      SELECT COUNT(*) total,
        SUM(CASE WHEN project_id = '' THEN 1 ELSE 0 END) empty,
        SUM(CASE WHEN project_id = 'proj-agent-office' THEN 1 ELSE 0 END) agentOffice
      FROM workflow_runs`).get() : { total: 0, empty: 0, agentOffice: 0 };
    const checks = {
      versionIs11: version === 11,
      seededAgentOffice: projects.some((p) => p.project_id === 'proj-agent-office'),
      noEaseDraw: !projects.some((p) => /easedraw/i.test(p.name || '')),
      rootPathExists: projects.every((p) => !p.root_path || existsSync(p.root_path)),
      backfillNoEmpty: Number(runs.empty) === 0,
      backfillFilled: Number(runs.agentOffice) > 0 || Number(runs.total) === 0,
    };
    evidence.part1 = { copied, version, projects, runs, checks };
    for (const [k, v] of Object.entries(checks)) {
      if (!v) throw new Error(`①生产库副本迁移检查失败：${k}`);
    }
  } finally {
    closeDb(db);
  }
  console.log('① 生产库副本迁移：',
    JSON.stringify({ copied, version: evidence.part1.version,
      projects: evidence.part1.projects.map((p) => `${p.project_id}(${p.name})`),
      runs: evidence.part1.runs }));
}

// ---------------------------------------------------------------------------
// ② 真仓库 worktree E2E（R7 / R8 / R9 / R12 / R15 + R14）
// ---------------------------------------------------------------------------
async function part2() {
  const { startChatServer, postJson } = await import('../test/chat-harness.mjs');
  const srv = await startChatServer();
  const safePost = async (path, body) => {
    try {
      return await postJson(srv.base, path, body);
    } catch (err) {
      throw new Error(`POST ${path} 网络失败：${err.cause ? String(err.cause).slice(0, 300) : err.message}\n服务日志：\n${srv.logs.join('\n').slice(0, 2000)}`);
    }
  };
  try {
    const before = {
      worktreeList: git(['worktree', 'list']),
      execBranches: git(['branch', '--list', 'exec/*']),
      statusShort: git(['status', '--short']),
    };
    const create = async (title) => (await safePost('/api/work', {
      title, what_to_deliver: '一份文档', acceptance: 'R2 验收',
      project_id: 'proj-agent-office', owner_employee_id: 'emp-claude', assigned_by: 'leo',
    })).body.work.work_id;
    const start = async (wid) => {
      const r = await safePost(`/api/work/${wid}/start`, {});
      if (r.status !== 201) throw new Error(`start ${wid} → ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`);
      return r.body;
    };

    const widA = await create('R2 真仓库验收A（worktree 链路）');
    const sA = await start(widA);
    const widB = await create('R2 真仓库验收B（并发第二件）');
    const sB = await start(widB);

    const during = {
      worktreeList: git(['worktree', 'list']),
      execBranches: git(['branch', '--list', 'exec/*']),
    };

    // 在两个 worktree 里各写一个文件 → finish（应产生真实 commit）
    writeFileSync(join(sA.worktree_path, 'r2-验收A.md'), 'A 的成果\n');
    writeFileSync(join(sB.worktree_path, 'r2-验收B.md'), 'B 的成果\n');
    const finish = async (wid, refs) => {
      const r = await safePost(`/api/work/${wid}/finish`, { output_refs: refs, result_summary: 'R2 验收执行' });
      if (r.status !== 200) throw new Error(`finish ${wid} → ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`);
      return r.body;
    };

    const fA = await finish(widA, [{ name: 'r2-验收A.md', path: 'r2-验收A.md' }]);
    const fB = await finish(widB, [{ name: 'r2-验收B.md', path: 'r2-验收B.md' }]);
    const shaA = fA.work.executions[0].commit_sha;
    const shaB = fB.work.executions[0].commit_sha;

    const after = {
      logA: git(['log', '-1', '--format=%H %s'], { cwd: sA.worktree_path }),
      logB: git(['log', '-1', '--format=%H %s'], { cwd: sB.worktree_path }),
      // R14：.worktrees 不许出现在 git status（.gitignore 已有该规则）
      statusWorktrees: git(['status', '--short']).split('\n').filter((l) => l.includes('.worktrees')),
      locksLeft: null,
    };
    // 锁都释放了？（直接查服务的临时库）
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(srv.dbPath);
    after.locksLeft = db.prepare('SELECT COUNT(*) n FROM worktree_locks WHERE released_at IS NULL').get().n;
    db.close();

    // 手工清理（这一轮只做「保留」，merge 只有人工点；这里不合入真分支，直接撤 worktree + 删分支）
    const cleanupLog = [];
    for (const s of [sA, sB]) {
      cleanupLog.push(git(['worktree', 'remove', '--force', s.worktree_path]));
      cleanupLog.push(git(['branch', '-D', s.branch_name]));
      // worktree remove 只删 exec 子目录，空的 work-<id> 父目录要顺手带走
      try { rmSync(dirname(s.worktree_path), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* 尽力 */ }
    }
    const endWorktreeList = git(['worktree', 'list']);
    const endBranches = git(['branch', '--list', 'exec/*']);
    const endWorktreeDirs = existsSync(join(ROOT, '.worktrees')) ? readdirSync(join(ROOT, '.worktrees')) : [];

    const currentBranchOfRepo = before.worktreeList.split('\n')[0].match(/\[([^\]]+)\]/)?.[1] || '';
    // git worktree list 输出正斜杠，接口返回的 worktree_path 是 join() 出来的反斜杠——比对前统一
    const norm = (p) => p.replace(/\\/g, '/');
    const checks = {
      twoWorktreesDuring: norm(during.worktreeList).includes(norm(sA.worktree_path))
        && norm(during.worktreeList).includes(norm(sB.worktree_path)),
      twoBranchesDuring: during.execBranches.includes(sA.branch_name) && during.execBranches.includes(sB.branch_name),
      baseRefIsCurrentBranch: sA.base_ref === currentBranchOfRepo && sB.base_ref === currentBranchOfRepo,
      pathSpec: sA.worktree_path.endsWith(join('.worktrees', widA, sA.execution_id))
        && sB.worktree_path.endsWith(join('.worktrees', widB, sB.execution_id)),
      commitShaA: /^[0-9a-f]{40}$/.test(shaA) && after.logA.startsWith(shaA),
      commitShaB: /^[0-9a-f]{40}$/.test(shaB) && after.logB.startsWith(shaB),
      statusIgnoresWorktrees: after.statusWorktrees.length === 0,
      locksReleased: after.locksLeft === 0,
      cleanedUp: !endWorktreeList.includes('.worktrees') && endBranches === '' && endWorktreeDirs.length === 0,
    };
    evidence.part2 = {
      repoHead: git(['log', '-1', '--format=%h %s']),
      before, startA: { ...sA, work: undefined }, startB: { ...sB, work: undefined },
      during, shaA, shaB, after, cleanupLog, endWorktreeList, endWorktreeDirs, checks,
    };
    for (const [k, v] of Object.entries(checks)) {
      if (!v) throw new Error(`②真仓库 E2E 检查失败：${k}`);
    }
    console.log('② 真仓库 E2E：',
      JSON.stringify({ base_ref: sA.base_ref, worktreeA: sA.worktree_path, branchA: sA.branch_name,
        shaA, logA: after.logA, statusWorktrees: after.statusWorktrees, locksLeft: after.locksLeft,
        endWorktreeList: endWorktreeList.split('\n').length + ' 行' }));
  } finally {
    await srv.stop();
  }
}

// ---------------------------------------------------------------------------
// ③ playwright：R1（文件名渲染）/ R2（+N）/ R6（项目下拉）/ R18（board-cromma）
// ---------------------------------------------------------------------------
async function part3() {
  const { startChatServer, postJson, patchJson } = await import('../test/chat-harness.mjs');
  // 界面流程也走 start（需要 worktree）→ 临时 git 仓库，不碰真仓库
  const repo = mkdtempSync(join(tmpdir(), 'soda-r2-ui-repo-'));
  scratch.push(repo);
  git(['init', '-b', 'main'], { cwd: repo });
  git(['config', 'user.email', 'test@example.com'], { cwd: repo });
  git(['config', 'user.name', 'Soda Test'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# ui\n');
  git(['add', 'README.md'], { cwd: repo });
  git(['commit', '-m', 'init'], { cwd: repo });

  const srv = await startChatServer();
  try {
    await patchJson(srv.base, '/api/projects/proj-agent-office', { root_path: repo });
    const mkDelivered = async (title, refs) => {
      const w = (await postJson(srv.base, '/api/work', {
        title, owner_employee_id: 'emp-claude', project_id: 'proj-agent-office',
      })).body.work.work_id;
      await postJson(srv.base, `/api/work/${w}/start`, {});
      await postJson(srv.base, `/api/work/${w}/deliver`, { output_refs: refs, result_summary: '界面验收' });
    };
    await mkDelivered('整理 EaseDraw 功能介绍', [
      { name: '功能介绍.md', path: 'docs/easedraw-intro.md' },
      { name: '竞品对比.md', path: 'docs/compare.md' },
    ]);
    await mkDelivered('四份材料归档', [
      { name: '材料一.md', path: 'docs/1.md' },
      { name: '材料二.md', path: 'docs/2.md' },
      { name: '材料三.md', path: 'docs/3.md' },
      { name: '材料四.md', path: 'docs/4.md' },
    ]);

    const browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const errs = [];
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      page.on('pageerror', (e) => errs.push('pageerror|' + String(e).slice(0, 200)));
      page.on('console', (m) => { if (m.type() === 'error') errs.push('console|' + m.text().slice(0, 200)); });

      await page.goto(srv.base + '/company', { waitUntil: 'commit' });
      await page.waitForSelector('#delivered-list .work-card', { timeout: 20000 });
      await sleep(800);

      const readCards = `(() => ({
        cards: [...document.querySelectorAll('#delivered-list .work-card')].map((c) => ({
          title: (c.querySelector('.title') || {}).textContent,
          refs: [...c.querySelectorAll('.refs li')].map((li) => ({
            text: li.textContent.trim(), more: li.classList.contains('more'),
            clickable: li.dataset.action === 'show-ref',
          })),
        })),
        objectLeak: document.body.innerText.includes('[object'),
      }))()`;
      const cards = await page.evaluate(readCards);

      // R1：点名点「整理 EaseDraw 功能介绍」卡的第一个交付物 → sync-label 闪出「名字 · 路径」
      // （列表新任务在前，DOM 第一张卡不一定是它）
      await page.locator('#delivered-list .work-card', { hasText: '整理 EaseDraw 功能介绍' })
        .locator('.refs li[data-action="show-ref"]').first().click();
      await sleep(300);
      const flashText = await page.evaluate("document.querySelector('#sync-label').textContent");
      await page.locator('#delivered-list').scrollIntoViewIfNeeded();
      await sleep(200);
      await page.screenshot({ path: join(EVID, 'r2-r1-deliverables-1440x900.png') });

      // R2：第二张卡的 +1
      const card2 = cards.cards.find((c) => c.title === '四份材料归档');
      // R6：交办栏项目下拉
      const projectSelect = await page.evaluate(`(() => {
        const s = document.getElementById('compose-project');
        if (!s || s.hidden) return null;
        return { value: s.value, options: [...s.options].map((o) => o.textContent.trim()) };
      })()`);
      await page.evaluate("document.querySelector('.compose').scrollIntoView({ block: 'center' })");
      await sleep(200);
      await page.screenshot({ path: join(EVID, 'r2-r6-project-select-1440x900.png') });

      // R18：board-cromma.html 打开不炸
      const boardErrs = [];
      page.on('pageerror', (e) => boardErrs.push(String(e).slice(0, 200)));
      await page.goto(srv.base + '/board-cromma.html', { waitUntil: 'commit' });
      await sleep(2500);
      await page.screenshot({ path: join(EVID, 'r2-r18-board-cromma-1440x900.png') });

      const two = cards.cards.find((c) => c.title === '整理 EaseDraw 功能介绍');
      const checks = {
        r1NamesRendered: two && two.refs.length === 2
          && two.refs.every((r) => r.text.startsWith('📄') && r.text.includes('.md') && !r.text.includes('object'))
          && two.refs.every((r) => r.clickable),
        r1ClickShowsPath: flashText.includes('功能介绍.md') && flashText.includes('docs/easedraw-intro.md'),
        r1NoObjectLeak: !cards.objectLeak,
        r2Folded: card2 && card2.refs.length === 4 && card2.refs[3].more && card2.refs[3].text === '+1',
        r6SelectVisible: projectSelect && projectSelect.value === 'proj-agent-office'
          && projectSelect.options.length >= 1,
        r18BoardClean: boardErrs.length === 0,
        jsErrors: errs.length === 0,
      };
      evidence.part3 = { cards, flashText, projectSelect, boardErrs, errs, checks,
        screenshots: ['r2-r1-deliverables-1440x900.png', 'r2-r6-project-select-1440x900.png', 'r2-r18-board-cromma-1440x900.png'] };
      for (const [k, v] of Object.entries(checks)) {
        if (!v) throw new Error(`③界面检查失败：${k}（errs=${errs.join(' ; ')}）`);
      }
      console.log('③ 界面：', JSON.stringify({
        r1Refs: two.refs.map((r) => r.text), flashText,
        r2Refs: card2.refs.map((r) => r.text), projectSelect, boardErrs, errs,
      }));
    } finally {
      await browser.close();
    }
  } finally {
    await srv.stop();
  }
}

// ---------------------------------------------------------------------------
async function main() {
  mkdirSync(EVID, { recursive: true });
  try {
    await part1();
    await part2();
    await part3();
    evidence.allPassed = true;
    console.log('\nR2 验收证据全部采集通过 ✅');
  } catch (err) {
    evidence.allPassed = false;
    evidence.error = String(err && err.stack || err);
    console.error('\nR2 验收证据采集失败 ❌\n', evidence.error);
    process.exitCode = 1;
  } finally {
    cleanupScratch();
    writeFileSync(join(EVID, 'r2-verify.json'), JSON.stringify(evidence, null, 2));
  }
}
main();
