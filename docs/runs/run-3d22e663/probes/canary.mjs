// 金丝雀：全量套件并行跑（共用同一个临时库）的同时，用 G07 夹具反复加载首页，
// 抓 5xx 的 URL 和服务端 stderr 的 [错误] 行。全部落在临时目录，不碰生产库。
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.argv[2];
const require = createRequire(join(ROOT, 'package.json'));
const { startStack, launchBrowser } = await import(pathToFileURL(join(ROOT, 'test', 'g07-harness.mjs')).href);

const dir = mkdtempSync(join(tmpdir(), 'soda-canary-'));
const db = join(dir, 'full.db');
process.env.AGENT_OFFICE_DB = db;

const files = readdirSync(join(ROOT, 'test')).filter((f) => f.endsWith('.test.js')).map((f) => join('test', f));
const suite = spawn(process.execPath, ['--no-warnings', '--test', ...files], {
  cwd: ROOT, env: { ...process.env, AGENT_OFFICE_DB: db }, stdio: ['ignore', 'pipe', 'pipe'],
});
let suiteOut = '';
suite.stdout.on('data', (d) => { suiteOut += d; });
suite.stderr.on('data', (d) => { suiteOut += d; });

const stack = await startStack();
const browser = await launchBrowser();
const bad = [];
const consoleErrs = [];
let loads = 0;
let loadFailures = 0;
try {
  const t0 = Date.now();
  while (Date.now() - t0 < 48000 && suite.exitCode == null) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('console', (m) => { if (m.type() === 'error') consoleErrs.push(m.text().slice(0, 160)); });
    page.on('response', (r) => {
      if (r.status() >= 500) { const u = new URL(r.url()); bad.push({ status: r.status(), url: u.pathname + u.search }); }
    });
    try {
      await page.goto(stack.base + '/#/', { waitUntil: 'commit' });
      await page.waitForSelector('#projects-list .proj-item', { timeout: 8000 });
      await page.waitForTimeout(300);
    } catch { loadFailures += 1; }
    loads += 1;
    await page.close();
  }
  if (suite.exitCode == null) await new Promise((r) => suite.once('exit', r));
  const summary = suiteOut.split(/\r?\n/).filter((l) => /^ℹ (tests|pass|fail) /.test(l));
  const errLines = [...new Set(stack.getLogs().stderr.split(/\r?\n/).filter((l) => l.includes('[错误]')))];
  console.log(JSON.stringify({
    loads, loadFailures,
    bad5xx: bad.reduce((m, b) => Object.assign(m, { [`${b.status} ${b.url}`]: (m[`${b.status} ${b.url}`] || 0) + 1 }), {}),
    consoleErrs: [...new Set(consoleErrs)].slice(0, 8),
    serverErrorLines: errLines.slice(0, 20),
    suiteSummary: summary,
    suiteFailing: [...new Set(suiteOut.split(/\r?\n/).filter((l) => l.startsWith('✖ ') && !l.includes('failing tests')))].map((l) => l.slice(0, 60)),
  }, null, 1));
} finally {
  await browser.close().catch(() => {});
  await stack.stop();
  if (suite.exitCode == null) suite.kill();
  rmSync(dir, { recursive: true, force: true });
}
