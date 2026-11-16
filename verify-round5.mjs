/* 第 5 轮修复冒烟测试（vm stub DOM）：不动真实服务，纯前端逻辑验证。
 * 跑法：node verify-round5.mjs（在 Soda Office 根目录）
 * 覆盖：评审 #1 三态（reqs/chain/files）、#2/#3 pendingOps 回查三层、
 *       #4 partial 不落盘、#5 待重提入口、#6 图片预览失败态。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP = fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8');

/* ---------- DOM / 环境 stub ---------- */
function makeEl(id) {
  const classes = new Set();
  return {
    id, innerHTML: '', textContent: '', value: '', title: '', hidden: false,
    scrollTop: 0, scrollHeight: 0, clientHeight: 0, dataset: {},
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      toggle: (c, f) => { const on = f === undefined ? !classes.has(c) : !!f; on ? classes.add(c) : classes.delete(c); return on; },
      contains: (c) => classes.has(c),
    },
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    insertAdjacentHTML() {},
    appendChild() {}, removeChild() {},
    setAttribute() {}, getAttribute() { return null; },
    removeAttribute() {},
    closest() { return null; },
    matches() { return false; },
    focus() {}, blur() {},
    close() {}, showModal() {},
  };
}
const els = new Map();
const storage = new Map();
const ctx = {
  console,
  addEventListener() {}, removeEventListener() {},
  dispatchEvent() {},
  fetch: null,           // 下面赋
  AbortSignal, AbortController,
  setTimeout: () => 0, clearTimeout: () => {},
  setInterval: () => 0, clearInterval: () => {},
  Image: class { constructor() { this.src = ''; } },
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  URL: { createObjectURL: () => 'blob:vm-test', revokeObjectURL() {} },
  alert() {}, confirm() { return true; },
  navigator: { onLine: true },
  history: { replaceState() {}, pushState() {} },
  location: { protocol: 'http:', hash: '' },
  localStorage: {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  },
  document: {
    title: '', hidden: false, body: makeEl('body'),
    getElementById: (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
    createElement: () => makeEl('anon'),
  },
  // fetch 路由表：宿主侧 push；未命中的请求一律 200 + null 体（tick 启动轮空转用）
  __fetchRoutes: [],
};
ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
ctx.fetch = async (url, opts) => {
  for (const r of ctx.__fetchRoutes) if (r.match(String(url), opts)) return r.resp(opts);
  return { ok: true, status: 200, json: async () => null, blob: async () => ({ size: 0 }) };
};
vm.createContext(ctx);
vm.runInContext(APP, ctx, { filename: 'app.js' });

/* ---------- 断言 ---------- */
let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label); }
}
const V = (expr) => vm.runInContext(expr, ctx);

/* ---------- T1 需求列表：全部失败三态（评审 #1） ---------- */
console.log('[T1] renderReqList 全部读取失败');
V(`lastFlow = { tasks: [], errors: [{file:'a.json'},{file:'b.json'}] }; renderReqList();`);
ok(V(`document.getElementById('reqs-count').textContent`) === '—', "计数为「—」不拿 0 冒充");
const t1html = V(`document.getElementById('reqs-list').innerHTML`);
ok(t1html.includes('2 项需求档案全部读取失败'), '空态明说「全部读取失败」');
ok(!t1html.includes('还没有需求'), '不显示「还没有需求」误导文案');

/* ---------- T2 需求列表：部分成功（评审 #1） ---------- */
console.log('[T2] renderReqList 部分成功');
V(`lastFlow = { tasks: [{id:'t1',title:'需求A',done:0,total:0,steps:[]}], errors: [{file:'b.json'}] }; renderReqList();`);
ok(V(`document.getElementById('reqs-count').textContent`) === '1', '计数 = 实际读到的 1');
const t2html = V(`document.getElementById('reqs-list').innerHTML`);
ok(t2html.includes('reqs-partial') && t2html.includes('另有 1 项'), '尾注说明另有 1 项读取失败');

/* ---------- T3 文件页三态（评审 #1） ---------- */
console.log('[T3] renderFiles 全部失败 / 部分成功');
V(`lastFlow = { tasks: [], errors: [{file:'x.json'}] }; renderFiles();`);
ok(V(`document.getElementById('file-count').textContent`) === '— 个产物', '全部失败计数「— 个产物」');
ok(V(`document.getElementById('file-groups').innerHTML`).includes('全部读取失败'), '文件页空态明说读取失败');
V(`for (const k of Object.keys(fingerprints)) delete fingerprints[k]; lastFlow = { tasks: [{id:'t1',title:'需求A',steps:[{key:'s1',no:1,name:'步骤',status:'done',files:[{path:'a.md',name:'a.md',bytes:10}]}]}], errors: [{file:'y.json'}] }; renderFiles();`);
const t3cnt = V(`document.getElementById('file-count').textContent`);
ok(t3cnt.includes('1 个产物') && t3cnt.includes('另有 1 项需求读取失败未统计'), '部分成功计数带尾注：' + t3cnt);
ok(V(`document.getElementById('file-groups').innerHTML`).includes('filegroup'), '已读到的分组照常渲染');

/* ---------- T4 pendingOps 回查三层（评审 #2/#3） ---------- */
console.log('[T4] reconcilePendingDecision 三层判定');
// a) 服务端操作记录命中：verified 成功 → 落定释放
V(`pendingOps.clear(); pendingOps.set('t1/s1', {id:'op-a',key:'t1/s1',taskId:'t1',stepKey:'s1',action:'approve',targetStatus:'done',at:Date.now()});`);
ctx.__fetchRoutes.push({
  match: (u) => u.includes('/api/office/op-status') && u.includes('op-a'),
  resp: () => ({ ok: true, status: 200, json: async () => ({ found: true, op: { ok: true, verified: true, at: '2026-11-15T00:00:00Z', after: { note: 'n' } } }) }),
});
await V(`reconcilePendingDecision()`);
ok(V(`pendingOps.size`) === 0, 'a) op-status 命中 verified → 释放占用');
// b) 端点 404（旧服务）+ 超 30 秒 + 档案已是目标状态 → unconfirmed 成功落定
V(`
  ui.taskId='t1'; ui.stepKey='s1'; decisionResult=null;
  lastFlow = { tasks: [{id:'t1',title:'T1',steps:[{key:'s1',no:1,name:'s',status:'done'}]}], errors: [] };
  decisionsData = { items: [], blocked: [], rejected: [] };
  pendingOps.set('t1/s1', {id:'op-b',key:'t1/s1',taskId:'t1',stepKey:'s1',action:'approve',targetStatus:'done',at:Date.now()-40000});
`);
ctx.__fetchRoutes.push({
  match: (u) => u.includes('/api/office/op-status') && u.includes('op-b'),
  resp: () => ({ ok: false, status: 404, json: async () => ({ error: 'NOT_FOUND' }) }),
});
await V(`reconcilePendingDecision()`);
ok(V(`decisionResult && decisionResult.ok === true && decisionResult.unconfirmed === true`) === true,
  'b) 404+超窗+状态匹配 → ⚠ 归属不确定的成功（不冒充确定）');
ok(V(`pendingOps.size`) === 0, 'b) 落定后释放占用');
// c) 404 + 窗口内（fresh）→ 继续等，不误判失败
V(`pendingOps.set('t2/s9', {id:'op-c',key:'t2/s9',taskId:'t2',stepKey:'s9',action:'approve',targetStatus:'done',at:Date.now()});`);
await V(`reconcilePendingDecision()`);
ok(V(`pendingOps.size`) === 1, 'c) 30 秒窗口内查不到 → 保留继续回查，不误判');

/* ---------- T5 partial 不覆盖工作位置（评审 #4） ---------- */
console.log('[T5] completeUiPosRestore 部分失败保护');
V(`
  uiPosReady = false; ui.taskId = null; ui.stepKey = null;
  lastFlow = { tasks: [], errors: [{file:'z.json'}] };
  localStorage.setItem('office.ui.v2', JSON.stringify({taskId:'old',stepKey:'',view:'chain',search:'',page:'workbench'}));
  completeUiPosRestore();
`);
ok(V(`uiPosReady`) === false, 'partial 时不置 ready');
ok(V(`JSON.parse(localStorage.getItem('office.ui.v2')).taskId`) === 'old', '存档原样保留未被覆盖');
V(`lastFlow = { tasks: [{id:'old',title:'旧任务',steps:[]}], errors: [] }; completeUiPosRestore();`);
ok(V(`uiPosReady`) === true && V(`ui.taskId`) === 'old', '完整成功后正常恢复');
ok(V(`JSON.parse(localStorage.getItem('office.ui.v2')).taskId`) === 'old', '恢复后归档一致');

/* ---------- T6 交付链真空集文案（评审 #1/#8） ---------- */
console.log('[T6] renderChain 成功空集');
V(`lastFlow = { tasks: [], errors: [] }; ui.taskId=''; renderChain();`);
const t6 = V(`document.getElementById('center-chain').innerHTML`);
ok(t6.includes('Hermes'), '真空集引导用户把需求告诉 Hermes');
ok(!t6.includes('等中台恢复'), '成功空集不再说「等中台恢复」');

/* ---------- T7 只有待重提时入口不消失（评审 #5） ---------- */
console.log('[T7] renderTopbar 双数入口');
V(`decisionsData = { items: [], blocked: [], rejected: [{taskId:'t1',stepKey:'s1',stepName:'x',stepNo:1,taskTitle:'T',gate:false,note:''},{taskId:'t1',stepKey:'s2',stepName:'y',stepNo:2,taskTitle:'T',gate:false,note:''}] }; renderTopbar();`);
ok(V(`document.getElementById('tb-decision').hidden`) === false, 'decN=0 但 rejN=2 → 入口仍显示');
const t7 = V(`document.getElementById('tb-decision').innerHTML`);
ok(t7.includes('待重提') && t7.includes('2'), '胶囊显示待重提数：' + t7.trim());
ok(!t7.includes('待决策'), '可拍板为 0 时不显示待决策段');

/* ---------- T8 图片预览失败态（评审 #6） ---------- */
console.log('[T8] loadImagePreview 网络失败');
ctx.__fetchRoutes.push({
  match: (u) => u.includes('/api/office/file'),
  resp: () => { throw new TypeError('模拟断连'); },
});
await V(`loadImagePreview('x.png', 0)`);
const t8 = V(`document.getElementById('fv-body').innerHTML`);
ok(t8.includes('fv-retry') && t8.includes('图片读取失败'), '断连显示失败态 + 可重试按钮，不挂死');
ok(V(`fvObjectUrl`) === null, '失败时不残留 objectURL');

/* ---------- 结果 ---------- */
console.log(`\n${fail === 0 ? '全部通过' : '存在失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
