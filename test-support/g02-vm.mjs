// g02-vm.mjs — G02 回归测试的浏览器全局环境装载器
// web/ 下的前端文件是普通 <script>（file:// 场景没有 ES modules），共享同一
// 全局词法环境；node:vm 的同一 context 复刻 index.html 的加载顺序
// （shared → version → approval → decision-ops → files，按需）。
// app.js 拥有、被拆出模块在调用期取用的状态/函数由 PRELUDE 以桩提供（口径见各桩注释）。
// 2026-11 第4轮拆分：decisionBusy/decisionResult/pendingOps/decisionNotes 与
// decisionResultFor/setDecisionResult/saveNoteDraft/persistPendingOps/persistNotes/
// pushOpResult 已随 submitDecision 拆入 decision-ops.js——loadOffice(['…','decision-ops.js'])
// 时 PRELUDE 不再声明这些桩（同 context 重复声明 = SyntaxError），__g02 用 getter
// 取 decision-ops.js 装载后的活绑定；未加载时仍用桩，approval.js 单独可测。
// 注：放在 test/ 之外，避免被 `node --test test/` 当成测试文件捡走。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');

// 桩与模块声明的边界（2026-11 核对）：offline/snapshot 属 shared.js，
// ensureReconcileLoop/taskArtifactPolicy 属 approval.js，上列十个决策状态/函数属
// decision-ops.js——加载对应模块时绝不能在这里再声明，否则同 context 的后续脚本
// 直接 SyntaxError（let/const/function 不许重复声明）。

/** 按需加载 web/ 前端模块（顺序同 index.html：shared → version → approval → decision-ops → files）。 */
export function loadOffice(modules, opts = {}) {
  const live = modules.includes('decision-ops.js');   // 决策状态/函数：真实实现 or 桩
  const PRELUDE = `
// —— 测试桥：宿主测试与页面全局之间的唯一通道（宿主侧经 ctx.run 访问）——
const __g02 = {
  fetchCalls: [], fetchImpl: null,          // fetch 请求记录 / 按需替身
  ${live ? 'get decisionResults() { return decisionResults; },' : 'decisionResults: new Map(),'}
  ${live ? 'get opResults() { return opResults; },' : 'opResults: [],'}
  curTask: null,                            // currentTask 桩的返回值
  alerts: [],                               // alert 记录（不弹窗）
  storage: new Map(), storageBroken: false, // 内存 localStorage；broken=true → 读写抛错（隐私模式 catch 臂）
  els: Object.create(null), hiddenEls: null,// getElementById 的返回值记录 / 按 id 返回 null（!box 等分支）
  timers: [],                               // setInterval 注册的回调（回查循环手动触发）
};

// —— 浏览器环境 ——
const window = { __SNAPSHOT__: null };      // offline-snapshot.js 的角色
const location = { protocol: ${JSON.stringify(opts.offline ? 'file:' : 'http:')} };   // file: → shared 的 offline=true（离线分支可测）
const document = {
  hidden: false,
  getElementById: (id) => {
    if (__g02.hiddenEls && __g02.hiddenEls.has(id)) return null;   // renderOpHistory 的 !box 等分支
    const el = { addEventListener() {}, innerHTML: '', textContent: '' };
    __g02.els[id] = el;                    // 测试经 __g02.els 读回 innerHTML/textContent
    return el;
  },
  addEventListener() {},
};
const fetch = async (url, opts) => {
  __g02.fetchCalls.push({ url, method: opts && opts.method, body: opts && opts.body });
  if (__g02.fetchImpl) return __g02.fetchImpl(url, opts);
  return { ok: true, status: 200, json: async () => ({ ok: true }) };
};
const AbortSignal = { timeout() { return undefined; } };   // api() 的 12s 兜底信号
const localStorage = {   // 内存实现：decision-ops 的存/恢复/坏档/隐私异常分支可测
  getItem: (k) => { if (__g02.storageBroken) throw new Error('privacy'); return __g02.storage.has(k) ? __g02.storage.get(k) : null; },
  setItem: (k, v) => { if (__g02.storageBroken) throw new Error('privacy'); __g02.storage.set(k, String(v)); },
  removeItem: (k) => { if (__g02.storageBroken) throw new Error('privacy'); __g02.storage.delete(k); },
};
const alert = (m) => { __g02.alerts.push(String(m)); };
const setInterval = (fn) => { __g02.timers.push(fn); return __g02.timers.length; }, clearInterval = () => {};
const crypto = { subtle: { async digest() { return new Uint8Array(32); } } };   // sha256Text 不在测试范围
const TextEncoder = class { encode(s) { return new Uint8Array(String(s).length); } };   // 近似，仅测长度语义

// —— app.js 拥有的状态与函数（桩）：被拆出模块在调用期取用 ——
let lastFlow = null;              // M2 数据快照（buildFileEntities/applyDecisionOutcome 用）
let fileStatus = new Map();       // 物理键 → { exists, bytes }（entityCheckState 用）
let modErr = null, modOkAt = 0;   // 模块完整性哨兵（G04 读，测试不触发）
const ui = { stepKey: 'doc' };    // 当前步骤选择
let decisionsData = null;         // /decisions 快照（本组测试不走弹层）
let iconPNG = '';                 // 图标注入（渲染用，空串即可）
const currentTask = () => __g02.curTask;
const scheduleFileCheck = () => {};
const renderInspector = () => {};
const renderCenter = () => {};
const renderAll = () => {};
const renderChanged = (id, k, fn) => (typeof fn === 'function' ? fn() : undefined);
const saveUiPos = () => {};
let __tickImpl = async () => {};  // 提交后拉新数据（测试可换成抛错体打 settleOp 的 catch 臂）
async function tick() { return __tickImpl(); }
${live ? `
// —— decision-ops.js 已加载：以下十个状态/函数用该模块的真实实现，不再打桩 ——` : `
// —— decision-ops.js 未加载：决策桩（decideHtml 等调用期取用；submitDecision 本体不在测试范围）
let decisionBusy = false;         // 提交中标记（decideHtml 锁钮用）
let decisionResult = null;        // 最近一次提交结果（submitDecision 清空用）
let pendingOps = new Map();       // 操作标识占用集合（防重复提交的口径源）
let decisionNotes = new Map();    // 备注草稿按 key 留存
const decisionResultFor = (k) => __g02.decisionResults.get(k) || null;
const setDecisionResult = (r) => { decisionResult = r; if (r && r.key) __g02.decisionResults.set(r.key, r); };
const saveNoteDraft = () => {};
const persistPendingOps = () => {};
const persistNotes = () => {};
const pushOpResult = (r) => { __g02.opResults.push(r); };
`}
`;

  /** vm realm 里造出来的数组/对象原型在宿主域之外，deepStrictEqual 会判原型不等——
   *  出参一律 structuredClone 成宿主域的纯值再交给断言（函数等不可克隆值原样返回）。 */
  const sandbox = { console };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(PRELUDE, ctx, { filename: 'g02-prelude.js' });
  for (const m of modules) {
    vm.runInContext(readFileSync(join(WEB, m), 'utf8'), ctx, { filename: m });
  }
  return {
    /** 在页面全局里执行一段代码，返回完成值（测试断言与夹具准备共用）。 */
    run(code) { return out(vm.runInContext(code, ctx)); },
    /** 同 run，但代码体里可以 await（包一层 async IIFE）。 */
    async runAsync(code) { return out(await vm.runInContext(`(async () => {\n${code}\n})()`, ctx)); },
  };
}

function out(v) {
  try { return structuredClone(v); } catch { return v; }
}
