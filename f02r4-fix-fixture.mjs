// F02 第 4 轮：重建 F01 夹具 300B 历史登记的快照留档（一次性数据修复，非产品代码）
// 背景：TEST-F01R10 的 doc›fixture-ver.md 登记 300B/9490ac36，但 history[0].snapshot 是
// 15B 占位串（指纹 43615f79）——与登记指纹失配，且 300B 原文已确认不可恢复（r3 报告）。
// 验收要求「读取 4 条登记返回内容并核对 SHA-256」「删除一个测试历史快照→明确失败」，
// 前提是该登记拥有与登记指纹核对一致的有效快照。本脚本按登记口径重造 300B 快照，
// 登记指纹同步更新为重造内容的真实指纹；其余 3 条登记与 2 个物理文件一字不动。
// 运行：node f02r4-fix-fixture.mjs   （备份：TEST-F01R10.json.bak-f02r4）
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const FIXTURE = 'C:/Tools/agent-autoloop/office-data/tasks/TEST-F01R10.json';
const VER = 'f01-r10/fixture-ver.md';
const CUR124_SHA = 'f0431173896513c5285a0e67661f905a5bc5d83dee9f3ad7757a72f61f30e17b';
const TIME133_SHA = 'd4ada83ba873592b3dc036a9c920ed582974bdb5e86eefb022a82c0b3a6e8f30';

const rec = JSON.parse(readFileSync(FIXTURE, 'utf8'));

// 1) 生成 V1 原文：明确标注历史版本语义，ASCII 补齐到恰好 300 字节
const head = [
  '# fixture-ver.md · V1 历史版本原文',
  '',
  'doc 步骤登记的是本 300B 版本（V1 快照留档）；磁盘当前文件已更新为 V2（124B），',
  '内容与本快照不同。历史版本预览必须显示本快照内容，不得用当前文件冒充。',
  '',
].join('\n');
let v1 = head;
while (Buffer.byteLength(v1, 'utf8') < 300) v1 += '.';
const v1Bytes = Buffer.byteLength(v1, 'utf8');
if (v1Bytes !== 300) throw new Error(`V1 字节未对齐: ${v1Bytes}`);
const v1Sha = createHash('sha256').update(v1, 'utf8').digest('hex');

// 2) doc›fixture-ver.md：登记指纹更新为重造内容的真实指纹，history[0] 换成核对一致的真快照
const f = rec.steps.doc.files.find((x) => x.path.includes(VER));
if (!f) throw new Error('doc›fixture-ver.md 登记未找到');
const oldAt = (Array.isArray(f.history) && f.history[0] && f.history[0].at) || '2026-11-15T09:00:00.000Z';
f.bytes = v1Bytes;
f.sha256 = v1Sha;
f.history = [{
  bytes: v1Bytes, sha256: v1Sha, snapshot: v1, at: oldAt,
  note: 'F02 第4轮重建：原占位快照(15B)与登记指纹失配且原文不可恢复，按登记口径重造 300B 快照留档',
}];

// 3) 档案说明补记本轮重建（数据来源如实可溯），其余登记不动
rec.artifactPolicy.basis += ' F02 第4轮：doc›fixture-ver.md 的历史快照由 15B 失配占位串重建为与登记指纹一致的 300B 留档（原 300B 原文已丢失，此为按登记口径重造的内容，登记指纹同步更新为重造内容的真实指纹）。';
rec.updatedAt = new Date().toISOString();

writeFileSync(FIXTURE, JSON.stringify(rec, null, 1) + '\n', 'utf8');

// 4) 回读自检：解析→重算 sha/bytes 必须与登记一致；其余 3 条登记与总数不受影响
const back = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const bf = back.steps.doc.files.find((x) => x.path.includes(VER));
const snapSha = createHash('sha256').update(bf.history[0].snapshot, 'utf8').digest('hex');
const snapBytes = Buffer.byteLength(bf.history[0].snapshot, 'utf8');
const plan = back.steps.plan.files.find((x) => x.path.includes(VER));
const times = ['doc', 'plan'].map((k) => back.steps[k].files.find((x) => x.path.includes('fixture-time.md')));
const totalRegs = Object.values(back.steps).reduce((n, s) => n + ((s.files || []).length), 0);
const out = {
  v1Bytes, v1Sha,
  roundTrip: snapSha === bf.sha256 && snapBytes === bf.bytes,
  plan124Unchanged: plan.bytes === 124 && plan.sha256 === CUR124_SHA && !Array.isArray(plan.history),
  time133Unchanged: times.every((t) => t && t.bytes === 133 && t.sha256 === TIME133_SHA),
  totalRegs,
  snapshotHead: bf.history[0].snapshot.split('\n')[0],
};
console.log(JSON.stringify(out, null, 1));
if (!out.roundTrip || !out.plan124Unchanged || !out.time133Unchanged || totalRegs !== 4) {
  console.error('夹具重建自检失败'); process.exit(1);
}
console.log('夹具重建自检通过');
