// run-e3a-fallback.mjs — 只跑 E3a（断流重连），用私有实例 + glm-5 回退，便于拿到服务端日志定位 502。
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startChatServer } from '../../../test/chat-harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const SETTINGS = JSON.stringify({ env: { ANTHROPIC_MODEL: 'glm-5', ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5', ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5' } });
const srv = await startChatServer({ claudeBin: 'inherit', env: { CHAT_CLAUDE_SETTINGS: SETTINGS }, keepHome: true });
console.log('base', srv.base);
const r = spawnSync(process.execPath, ['--no-warnings', resolve(REPO, 'scripts/chat-v1/p5-acceptance/run.mjs'), '--base', srv.base, '--skip', 'e5,e3b,e1,e2,e4'], { cwd: REPO, encoding: 'utf8', timeout: 10 * 60 * 1000 });
console.log(r.stdout || '');
console.log(r.stderr || '');
console.log('--- server logs ---');
console.log(srv.logs.join('\n').slice(-4000));
await srv.stop();
process.exit(r.status === 0 ? 0 : 1);
