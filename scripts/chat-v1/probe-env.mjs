// probe-env.mjs — Agent Chat V1 开工前的只读环境探针（不改任何东西）。
// 用法：node scripts/chat-v1/probe-env.mjs
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

const secret = (k) => /KEY|TOKEN|SECRET|PASSWORD/i.test(k);
console.log('== 相关环境变量（密钥只显示长度）==');
for (const k of Object.keys(process.env).filter((x) => /ANTHROPIC|CLAUDE|DSH|DEEPSEEK/i.test(x)).sort()) {
  const v = process.env[k] ?? '';
  console.log(`  ${k}=${secret(k) ? `<redacted len=${v.length}>` : v}`);
}

console.log('\n== claude --version ==');
{
  const r = spawnSync('claude', ['--version'], { encoding: 'utf8', shell: true, timeout: 30000 });
  console.log('  status=', r.status, 'stdout=', JSON.stringify((r.stdout || '').trim()), 'stderr=', JSON.stringify((r.stderr || '').trim().slice(0, 300)), r.error ? `error=${r.error.message}` : '');
}

console.log('\n== dsh --help ==');
{
  const local = process.env.LOCALAPPDATA || '';
  const known = `${String(local).replace(/\\/g, '/')}/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd`;
  console.log('  known dsh.cmd exists:', existsSync(known), known);
  const r = spawnSync('dsh', ['--help'], { encoding: 'utf8', shell: true, timeout: 30000 });
  console.log('  status=', r.status, r.error ? `error=${r.error.message}` : '');
  console.log((r.stdout || '').slice(0, 6000));
  if (r.stderr) console.log('  [stderr]', r.stderr.slice(0, 1500));
}

console.log('\n== 端口 8090 是否在监听 ==');
await new Promise((resolve) => {
  const s = net.connect({ port: 8090, host: '127.0.0.1' }, () => { console.log('  8090: LISTENING'); s.end(); resolve(); });
  s.on('error', (e) => { console.log('  8090: not listening (' + e.code + ')'); resolve(); });
});

console.log('\n== 当前 SQLite 的表 ==');
{
  const { DatabaseSync } = await import('node:sqlite');
  const p = join(process.cwd(), 'data', 'agent-office.db');
  if (!existsSync(p)) { console.log('  db 不存在:', p); }
  else {
    const db = new DatabaseSync(p, { readOnly: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
    console.log('  tables:', tables.join(', '));
    for (const t of tables) {
      const n = db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n;
      console.log(`    ${t}: ${n} rows`);
    }
    const v = db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get();
    console.log('  schema_version:', v && v.value);
    db.close();
  }
}

console.log('\n== ~/.claude/projects 目录（只列目录名）==');
{
  const dir = process.env.CLAUDE_PROJECTS_DIR || join(homedir(), '.claude', 'projects');
  try {
    const names = readdirSync(dir);
    console.log('  ', dir, '→', names.length, '个项目目录');
    for (const n of names) console.log('    ', n);
  } catch (e) { console.log('  读不到:', e.message); }
}

console.log('\n== ~/.claude/settings.json 的 env 段（密钥脱敏）==');
{
  try {
    const s = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8'));
    const env = s.env || {};
    for (const [k, v] of Object.entries(env)) console.log(`    ${k}=${secret(k) ? '<redacted>' : v}`);
    console.log('    permissions:', JSON.stringify(s.permissions || null));
    console.log('    model:', s.model);
  } catch (e) { console.log('  读不到 settings.json:', e.message); }
}
