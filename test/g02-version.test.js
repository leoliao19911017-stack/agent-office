// g02-version.test.js — G02 回归：文件版本核心逻辑（version.js + shared.js 键归一）
// 覆盖：物理键归一 / 版本键 / 登记去重（混写法同版本合并、历史版本保留）/
// 实体构建（b:→sha: 并入、双版本实体）/ 实体校验六态 / 预览版本门禁 / 登记解析。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadOffice } from '../test-support/g02-vm.mjs';

// 浏览器四模块按 index.html 顺序装载（本文件只用 shared + version，
// 但保持真实顺序，避免装载顺序差异掩盖问题）
const ctx = () => loadOffice(['shared.js', 'version.js']);

test('physKey：分隔符/大小写/设备前缀/MSYS 根归一到同一物理身份', () => {
  const c = ctx();
  const pk = (p) => c.run(`physKey(${JSON.stringify(p)})`);
  assert.equal(pk('D:\\Proj\\A.md'), pk('d:/proj/a.md'));
  assert.equal(pk('\\\\?\\C:/x/y.md'), 'c:/x/y.md');
  assert.equal(pk('\\\\?\\UNC\\srv\\share\\f.md'), '//srv/share/f.md');
  assert.equal(pk('/c/Users/leo/'), 'c:/users/leo');
  assert.equal(pk('D://x///y.md/'), 'd:/x/y.md');
});

test('versionKeyOf：sha 优先、bytes 退判、无则不可判版本', () => {
  const c = ctx();
  assert.equal(c.run('versionKeyOf({sha256:"ab",bytes:9})'), 'sha:ab');
  assert.equal(c.run('versionKeyOf({bytes:5})'), 'b:5');
  assert.equal(c.run('versionKeyOf({})'), 'v:?');
  assert.equal(c.run('versionKeyOf(null)'), 'v:?');
});

test('dedupFiles：混写法同版本合并；不同历史版本是两份登记不许吞', () => {
  const c = ctx();
  const files = [
    { path: 'a\\b.md', bytes: 1 },
    { path: 'a/b.md', bytes: 1 },   // 同物理同版本（写法不同）→ 合并
    { path: 'a/b.md', bytes: 2 },   // 同物理不同版本 → 保留
    { bytes: 9 },                   // 无路径 → 丢弃
    null,
  ];
  const out = c.run(`dedupFiles(${JSON.stringify(files)})`);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((f) => f.bytes), [1, 2]);
});

test('buildFileEntities：双版本两实体一物理单元；b: 字节版并入同字节数的 sha 实体', () => {
  const c = ctx();
  const tasks = [{
    id: 'T1', title: '重复登记', updatedAt: 5,
    steps: [
      { key: 'doc', no: 2, name: '需求文档', by: 'Hermes', at: 1, files: [
        { path: 'D:\\proj\\a.md', bytes: 100, sha256: 'deadbeef' },
        { path: 'D:/proj/a.md', bytes: 200 },
      ] },
      { key: 'plan', no: 3, name: '开发计划', by: 'Leo（工作台）', at: 2, files: [
        { path: 'D:/proj/b.md', bytes: 50 },
        { path: 'D:\\proj\\b.md', bytes: 50, sha256: 'cafe' },
      ] },
      { key: 'verify', no: 6, name: '验收报告', by: 'Hermes', at: 3, files: [
        { path: 'D:/proj/a.md', bytes: 100, sha256: 'deadbeef' },   // 跨步重复登记同一版本
      ] },
    ],
  }];
  const r = c.run(`(() => {
    const { entries, ents, physUnits } = buildFileEntities(${JSON.stringify(tasks)});
    const pkA = physKey('D:/proj/a.md'), pkB = physKey('D:/proj/b.md');
    return {
      entries: entries.length, ents: ents.length, physUnits: physUnits.length,
      aEnts: [...fileEntitiesByPath.get(pkA).keys()].sort(),
      aShaRefs: fileEntitiesByPath.get(pkA).get('sha:deadbeef').refs.length,
      aShaSteps: fileEntitiesByPath.get(pkA).get('sha:deadbeef').refs.map(x => x.meta.stepKey),
      bEnts: [...fileEntitiesByPath.get(pkB).keys()],
      bShaRefs: fileEntitiesByPath.get(pkB).get('sha:cafe').refs.length,
      aRegs: fileRegsByPath.get(pkA).length,
    };
  })()`);
  assert.equal(r.entries, 5);          // doc(a.md×2) + plan(b.md×2) + verify(a.md×1)
  assert.equal(r.ents, 3);             // a:sha + a:b200 + b:sha(b50 已并入)
  assert.equal(r.physUnits, 2);
  assert.deepEqual(r.aEnts, ['b:200', 'sha:deadbeef']);
  // 同一版本跨步各登记一次 → 实体挂两条引用（各自的步骤归属不丢）
  assert.equal(r.aShaRefs, 2);
  assert.deepEqual(r.aShaSteps, ['doc', 'verify']);
  // b.md：b:50 并入同字节数的 sha:cafe 实体 → 只剩 1 个实体 2 条引用
  assert.deepEqual(r.bEnts, ['sha:cafe']);
  assert.equal(r.bShaRefs, 2);
  assert.equal(r.aRegs, 3);
});

test('entityCheckState：六态判定（unchecked/unreadable/ok/mism/hist/unknown）', () => {
  const c = ctx();
  const tasks = [{
    id: 'T1', title: 't', updatedAt: 0,
    steps: [
      { key: 'doc', no: 2, name: '需求文档', by: 'H', at: 1, files: [
        { path: 'D:/proj/a.md', bytes: 100 },
        { path: 'D:/proj/a.md', bytes: 200 },
      ] },
      { key: 'plan', no: 3, name: '开发计划', by: 'H', at: 2, files: [
        { path: 'D:/proj/c.md' },   // 无 bytes：登记值缺失
      ] },
    ],
  }];
  const r = c.run(`(() => {
    buildFileEntities(${JSON.stringify(tasks)});
    const pkA = physKey('D:/proj/a.md'), pkC = physKey('D:/proj/c.md');
    const ent100 = fileEntitiesByPath.get(pkA).get('b:100');
    const ent200 = fileEntitiesByPath.get(pkA).get('b:200');
    const entC = fileEntitiesByPath.get(pkC).get('v:?');
    const st = {};
    st.unchecked = entityCheckState(pkA, ent100).code;            // 未核实
    fileStatus = new Map([[pkA, { exists: false }]]);
    st.unreadable = entityCheckState(pkA, ent100).code;           // 服务端读不了
    fileStatus = new Map([[pkA, { exists: true, bytes: 200 }]]);
    const hist = entityCheckState(pkA, ent100);                   // 磁盘=b:200 版 → 历史版本
    st.hist = hist.code; st.histMulti = hist.multiVersion; st.histBytes = hist.regBytes;
    st.ok = entityCheckState(pkA, ent200);                        // 登记与实测一致
    fileStatus = new Map([[pkA, { exists: true, bytes: 999 }]]);
    st.mism = entityCheckState(pkA, ent100).code;                 // 无其他版本可解释 → 不一致
    fileStatus = new Map([[pkC, { exists: true, bytes: 10 }]]);
    const unk = entityCheckState(pkC, entC);                      // 登记缺 bytes → 无从比较
    st.unknown = unk.code; st.unknownBytes = unk.regBytes;
    return st;
  })()`);
  assert.equal(r.unchecked, 'unchecked');
  assert.equal(r.unreadable, 'unreadable');
  assert.equal(r.hist, 'hist');
  assert.equal(r.histMulti, true, '同路径双登记版本必须带 multiVersion 标记');
  assert.deepEqual(r.histBytes, [100]);
  assert.equal(r.ok.code, 'ok');
  assert.deepEqual(r.ok.regBytes, [200]);
  assert.equal(r.mism, 'mism');
  assert.equal(r.unknown, 'unknown');
  assert.deepEqual(r.unknownBytes, []);
});

test('fvVersionGate：match/hist/nover/noreg 四结论（指纹优先、字节退判）', () => {
  const c = ctx();
  const r = c.run(`(() => {
    const reg = (f) => ({ f });
    const d = (o) => ({ exists: true, ...o });
    return {
      noReg: fvVersionGate(null, d({ sha256: 'x' })),
      noDisk: fvVersionGate(reg({ sha256: 'x', bytes: 1 }), { exists: false }),
      shaMatch: fvVersionGate(reg({ sha256: 'ab', bytes: 3 }), d({ sha256: 'ab', bytes: 3 })),
      shaHist: fvVersionGate(reg({ sha256: 'ab', bytes: 3 }), d({ sha256: 'cd', bytes: 3 })),
      bytesMatch: fvVersionGate(reg({ bytes: 3 }), d({ bytes: 3 })),
      bytesHist: fvVersionGate(reg({ bytes: 3 }), d({ bytes: 9 })),
      nover: fvVersionGate(reg({}), d({ bytes: 3 })),
    };
  })()`);
  assert.equal(r.noReg, 'noreg');
  assert.equal(r.noDisk, 'noreg');
  assert.equal(r.shaMatch, 'match');
  assert.equal(r.shaHist, 'hist');
  assert.equal(r.bytesMatch, 'match');
  assert.equal(r.bytesHist, 'hist');
  assert.equal(r.nover, 'nover');
});

test('resolveFileReg：from.vkey 优先命中同版本登记，未命中退回首条', () => {
  const c = ctx();
  const tasks = [{
    id: 'T1', title: 't', updatedAt: 0,
    steps: [
      { key: 'doc', no: 2, name: '需求文档', by: 'H', at: 1, files: [{ path: 'D:/x.md', bytes: 1 }] },
      { key: 'plan', no: 3, name: '开发计划', by: 'H', at: 2, files: [{ path: 'D:\\x.md', bytes: 2 }] },
    ],
  }];
  const r = c.run(`(() => {
    buildFileEntities(${JSON.stringify(tasks)});
    const byStep = (reg) => reg.meta.stepKey + ':' + reg.f.bytes;
    return {
      byStepOnly: byStep(resolveFileReg('D:/x.md', { taskId: 'T1', stepKey: 'plan' })),
      byVkey: byStep(resolveFileReg('D:/x.md', { taskId: 'T1', stepKey: 'doc', vkey: 'b:1' })),
      vkeyMissFallsBack: byStep(resolveFileReg('D:/x.md', { taskId: 'T1', stepKey: 'doc', vkey: 'b:999' })),
      taskMissFallsBack: byStep(resolveFileReg('D:/x.md', { taskId: 'T9', stepKey: 'doc' })),
      noPath: resolveFileReg('D:/none.md', null),
    };
  })()`);
  assert.equal(r.byStepOnly, 'plan:2');
  assert.equal(r.byVkey, 'doc:1');
  assert.equal(r.vkeyMissFallsBack, 'doc:1', 'vkey 不中时按 task/step 退判，不串行');
  assert.equal(r.taskMissFallsBack, 'doc:1', 'from 完全不中退回首条登记');
  assert.equal(r.noPath, null);
});
