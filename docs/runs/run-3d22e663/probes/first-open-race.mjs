// 实验复现：N 个 server.js 同时第一次打开同一个「未迁移的新库」时，迁移会不会撞车。
// 全部用临时库 / 临时目录；不碰生产库。
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const ROOT = process.argv[2];
const require = createRequire(join(ROOT, 'package.json'));
const { startChatServer } = await import(pathToFileURL(join(ROOT, 'test', 'chat-harness.mjs')).href);

const N = Number(process.argv[3] || 10);
const rounds = Number(process.argv[4] || 3);
for (let round = 1; round <= rounds; round += 1) {
  const dir = mkdtempSync(join(tmpdir(), 'soda-race-'));
  const dbPath = join(dir, 'fresh.db');
  // 所有服务指向同一个还不存在的库；每个服务自己的 stub 中台 / 随机端口
  const servers = await Promise.all(Array.from({ length: N }, () => startChatServer({ dbPath })));
  // 同时发第一个会打开库的请求（此前没有任何请求碰过库：/api/health 不开库）
  const hits = await Promise.all(servers.flatMap((s, i) => [
    fetch(`${s.base}/api/workflow/runs`).then((r) => ({ i, p: '/api/workflow/runs', status: r.status }), (e) => ({ i, p: '/api/workflow/runs', status: `ERR ${e.message}` })),
    fetch(`${s.base}/api/tasks`).then((r) => ({ i, p: '/api/tasks', status: r.status }), (e) => ({ i, p: '/api/tasks', status: `ERR ${e.message}` })),
  ]));
  const errs = servers.flatMap((s) => s.logs.filter((l) => l.includes('[错误]')).map((l) => l.slice(0, 230)));
  const non200 = hits.filter((h) => h.status !== 200);
  console.log(`round ${round}: ${N} servers × 2 requests, non-200 = ${non200.length}/${hits.length}`, JSON.stringify(non200.slice(0, 6)));
  for (const line of [...new Set(errs)].slice(0, 4)) console.log('   server stderr:', line);
  for (const s of servers) await s.stop();
  rmSync(dir, { recursive: true, force: true });
}
