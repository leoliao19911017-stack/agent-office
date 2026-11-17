'use strict';

/* ================= version.js — 版本校验（G02 拆分自 app.js） =================
   版本判定缓存（version-gate 取数）+ 登记去重（dedupFiles）+ 文件实体模型
   （三张 Map：fileMetaByPath / fileRegsByPath / fileEntitiesByPath）+
   实体构建（buildFileEntities）+ 实体校验五态/登记解析等纯工具。
   状态归属：本文件持有 versionGate* 三个缓存变量与三张实体索引 Map；
   数据快照（lastFlow/fileStatus 等）仍在 app.js M2，调用期取用。 */

// W02（版本门禁轮）：当前选中步骤的服务端版本判定（/api/office/version-gate）。
// 中央异常标签、右侧警示块、主操作禁用三处都读这一份（与 decide/decision 的
// 409 判定同一函数），前端不再自算第二个真值。60 秒内不重查，失败保留旧值。
let versionGate = null;    // { key, taskId, stepKey, valid, drifted[], policy, src, at }
let versionGateKey = '';   // 上次在途/完成判定的 key（taskId/stepKey），防晚到串台
let versionGateErr = null; // 上次判定失败原因（成功后清空）

/* ================= W02（版本门禁轮）：审批版本判定取数 =================
   只对当前选中步骤请求服务端 version-gate（与 decide/decision 的 409 同一函数），
   中央异常标签 / 右侧警示块 / 主操作禁用三处消费同一份结果。判定 60 秒内不重查；
   失败保留上一轮结果（真实判过的）只记错误；步骤切走后晚到的响应按 key 丢弃。 */
async function scheduleVersionGate(force = false) {
  if (offline) return;
  const t = currentTask();
  const s = t && (t.steps || []).find((x) => x.key === ui.stepKey);
  if (!t || !s) { versionGate = null; versionGateKey = ''; versionGateErr = null; return; }
  const key = `${t.id}/${s.key}`;
  const fresh = versionGate && versionGate.key === key && Date.now() - versionGate.at < 60 * 1000;
  if (!force && fresh && !versionGateErr) return;
  versionGateKey = key;   // 在途标记：晚到响应 key 对不上就整包丢弃
  try {
    const d = await api('/api/office/version-gate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: t.id, stepKey: s.key }),
    });
    if (versionGateKey !== key) return;   // 等待期间已切到别的步骤：不串台
    versionGate = {
      key, taskId: d.taskId, stepKey: d.stepKey, valid: d.valid === true,
      drifted: Array.isArray(d.drifted) ? d.drifted : [],
      // W01 r79：核对通过文件的内容级证据（服务端已现算 sha256 比对），审批面板展示指纹
      verified: Array.isArray(d.verified) ? d.verified : [],
      policy: d.policy || null, src: d.src || 'none', at: Date.now(),
      versionExempt: d.versionExempt === true,
    };
    versionGateErr = null;
  } catch (e) {
    if (versionGateKey !== key) return;
    versionGateErr = e.message || '版本判定请求失败';   // 旧结果保留可看，但明说没判成
  }
  // 判定一到，右栏（警示块/按钮）与中央（异常标签）同源重渲染
  withScroll(document.getElementById('insp-body'), renderInspector);
  withScroll(document.getElementById('center'), renderCenter);
}

// 同一步里同一路径常以 \ 和 / 两种写法登记两次，按归一路径去重；
// F02：去重键再带上版本身份（physKey+versionKey）——同一物理文件同一版本的混写法
// 登记合并成一条；不同历史版本是两份真实登记，不许在去重时吞掉
function dedupFiles(files) {
  const seen = new Set();
  const out = [];
  for (const f of files || []) {
    if (!f || !f.path) continue;
    const k = physKey(f.path) + '\u0000' + versionKeyOf(f);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  return out;
}

// TASK-R11/F03：文件页溯源元数据按规范化路径索引——预览抽屉展示 执行者/来源类型/登记信息 用
const fileMetaByPath=new Map();
// TASK-R11/F02 补：同一路径的全部登记（数组，顺序同 fileMetaByPath 首条口径）；fileMetaByPath 保留为首条快查
// F02：键改用物理键 physKey——\ 与 /、大小写、设备前缀等写法差异归到同一实体
const fileRegsByPath=new Map();
// F02（R14 评审·R11 重复登记）：物理路径 → 版本键 → 实体 {pk,vk,refs[{meta,f,ent}]}。
// refs = 同一物理文件同一版本的全部登记（引用）；实体行渲染按它聚合，登记一条不删。
const fileEntitiesByPath=new Map();

// 展开全部步骤的文件，带上溯源元数据（需求 > 步骤 > 文件）——G02 自 renderFiles
// 原样拆出（口径与注释不变，仅收进函数；renderFiles 每次渲染先调它重建索引）：
// F02（R14 评审·R11 重复登记）：登记（引用）与物理实体分开建——ent = physKey×版本 的实体，
// ent.refs 收齐同一实体的全部登记；entries 保持全量登记（计数口径），渲染行用实体。
// \ 与 / 混写法、同 bytes 同 sha 的登记聚成一行；登记一条不删。
function buildFileEntities(tasks){
 const entries=[];
 // TASK-R11/F02/F03：路径 → 溯源登记索引（预览抽屉的执行者/来源类型/登记值/登记时间从这里取）
 fileMetaByPath.clear();
 fileRegsByPath.clear();
 fileEntitiesByPath.clear();
 for(const t of tasks){
  const ss=(t.steps||[]).slice().sort((a,b)=>(a.no??0)-(b.no??0));
  for(const s of ss) for(const f of dedupFiles(s.files||[])){
   const meta={taskId:t.id,taskTitle:t.title,stepKey:s.key,stepNo:s.no,stepName:s.name,by:s.by||'',at:s.at||null,updatedAt:t.updatedAt||0};
   const pk=physKey(f.path), vk=versionKeyOf(f);
   let entMap=fileEntitiesByPath.get(pk);
   if(!entMap){entMap=new Map();fileEntitiesByPath.set(pk,entMap);}
   let ent=entMap.get(vk);
   if(!ent){ent={pk,vk,refs:[]};entMap.set(vk,ent);}
   const reg={meta:{...meta},f};
   reg.ent=ent;ent.refs.push(reg);   // 双向挂接：登记指回实体，实体收齐引用
   entries.push(reg);
   const np=normPath(f.path);
   if(!fileMetaByPath.has(np))fileMetaByPath.set(np,{...meta,f});
   let regList=fileRegsByPath.get(pk);
   if(!regList){regList=[];fileRegsByPath.set(pk,regList);}
   regList.push(reg); // 包装形状 {meta,f}：resolveFileReg/renderFvDetail 按 reg.meta/reg.f 取
  }
 }
 // F02：只有登记大小、没有 sha 的版本（b:N），若同一路径恰有 sha 版本登记同样字节数 → 同一内容，
 // 引用并入 sha 实体（bytes 相同只是弱判据，并入只影响展示聚合，不动任何登记数据）
 for(const entMap of fileEntitiesByPath.values()){
  const shaEnts=[...entMap.values()].filter(e=>e.vk.startsWith('sha:'));
  for(const e of [...entMap.values()]){
   if(!e.vk.startsWith('b:'))continue;
   const b=Number(e.vk.slice(2));
   const host=shaEnts.find(h=>h.refs[0]&&h.refs[0].f.bytes===b);
   if(host&&host!==e){
    for(const r of e.refs){r.ent=host;host.refs.push(r);}
    e.refs=[];e.dead=true;entMap.delete(e.vk);
   }
  }
 }
 const ents=[...fileEntitiesByPath.values()].flatMap(m=>[...m.values()]).filter(e=>!e.dead);   // 渲染用实体全集
 // F01（第 12 轮）：物理文件全集——聚合键 = 需求ID + physKey（规范化绝对路径），同一物理文件的
 // 全部登记版本收进一个主行；行渲染与计数（顶部总量、组头「N 个产物」）都按这一物理口径去重
 const physUnits=[...fileEntitiesByPath.entries()].map(([pk,m])=>({pk,ents:[...m.values()].filter(e=>!e.dead)})).filter(u=>u.ents.length);
 for(const u of physUnits){u.first=u.ents[0].refs[0];u.updatedAt=Math.max(...u.ents.flatMap(e=>e.refs.map(r=>r.meta.updatedAt||0)));}
 return {entries,ents,physUnits};
}

// R9（评审 Files）：这条路径登记在哪个需求的哪一步——预览抽屉里「定位到步骤」用。
// 找不到（文件已从档案移除等）返回 null，按钮如实隐藏，不给一条跳空的路。
// F02：比较用物理键——\ 与 /、大小写、设备前缀等写法差异不再让同一步的登记对不上。
function stepOfPath(p) {
  const pk = physKey(p);
  for (const t of (lastFlow && lastFlow.tasks) || []) {
    for (const s of t.steps || []) {
      if ((s.files || []).some((f) => physKey(f.path) === pk)) return { taskId: t.id, stepKey: s.key };
    }
  }
  return null;
}
// TASK-R11/F02 补：按（可选的）需求+步骤取这条路径的那条登记；from 缺省或未命中退回首条。
// 同一文件登记在多个步骤时（如 TEST-R11 的 doc+plan 都挂 app.css），行标签、详情、
// 重新校验三处必须用同一条登记，否则「大小不一致」的行点开却显示「一致」。
// F02：物理键取登记集合；from.vkey（所点行的版本）优先，两条登记版本分叉后不串行。
function resolveFileReg(p, from) {
  const regs = fileRegsByPath.get(physKey(p)) || [];
  if (!regs.length) return null;
  if (from) {
    const hit = (from.vkey
      ? regs.find((r) => r.meta.taskId === from.taskId && r.meta.stepKey === from.stepKey && versionKeyOf(r.f) === from.vkey)
      : null) || regs.find((r) => r.meta.taskId === from.taskId && r.meta.stepKey === from.stepKey);
    if (hit) return hit;
  }
  return regs[0];
}

/** F02（R14 评审·R11 重复登记）：实体校验状态——五态判定，行标签与详情共用同一口径。
 *  unchecked=还没核实到；unreadable=服务端读不了；ok=登记与实测一致；
 *  hist=登记版本与实测不同、但同一路径下另有登记版本的 bytes 与磁盘当前内容一致
 *       → 不是登记错了，是磁盘上是另一个历史版本，按历史版本解释；
 *  mism=大小不一致；unknown=登记值缺失、无从比较（不得判定为一致）。
 *  multiVersion=同一路径存在多个登记版本（详情里明示）。
 *  F02（第 8 轮）：同一物理文件的每条登记各比各的登记大小——实体里任一条登记
 *  与实测不同即 mism；没有不同但有登记缺 bytes 即 unknown；全部一致才 ok。
 *  regBytes=实体名下登记过的大小（去重保序），供行内「登记」行展示，不改登记原文。 */
function entityCheckState(pk, ent) {
  const chk = fileStatus.get(pk);
  if (!chk) return { code: 'unchecked', chk: null, multiVersion: false, regBytes: [] };
  const ents = fileEntitiesByPath.get(pk);
  const multiVersion = !!(ents && ents.size > 1);
  if (!chk.exists) return { code: 'unreadable', chk, multiVersion, regBytes: [] };
  const refs = (ent && ent.refs) || [];
  const regBytes = [];
  let mismRef = null, missRef = null;
  for (const r of refs) {
    const b = r.f && r.f.bytes;
    if (b == null || !Number.isFinite(b)) { if (!missRef) missRef = r; continue; }
    if (!regBytes.includes(b)) regBytes.push(b);
    if (chk.bytes !== b && !mismRef) mismRef = r;
  }
  if (mismRef) {
    if (ents) for (const e of ents.values()) {
      if (e === ent) continue;
      for (const r of e.refs || []) {
        const g = r.f && r.f.bytes;
        if (g != null && g === chk.bytes) return { code: 'hist', chk, multiVersion, regBytes };
      }
    }
    return { code: 'mism', chk, multiVersion, regBytes };
  }
  if (missRef) return { code: 'unknown', chk, multiVersion, regBytes };
  return { code: 'ok', chk, multiVersion, regBytes };
}
// F02：登记的版本身份给用户看的写法——有 sha256 用指纹前 8 位，退而求其次按登记大小。
function versionLabelOf(f) {
  if (!f) return '—';
  if (f.sha256) return `内容指纹 ${String(f.sha256).slice(0, 8)}`;
  if (f.bytes != null) return `按登记大小 ${fmtBytes(f.bytes)}`;
  return '不可判版本';
}

// ── F02（历史版本预览）：预览内容必须对上所选登记的版本指纹 ──
// 磁盘上只有「当前内容」。点历史登记时若磁盘内容恰好属于同路径另一条登记的版本，
// 直接展示磁盘内容就等于拿别的版本冒充所选历史版本——这里按登记指纹拦截。
// /api/office/file 已回全文 sha256（不受 2MB 截断影响），与 server.js 的
// artifactVersionGateOf 同口径：指纹优先、登记字节退判。
function fvVersionGate(reg, d) {
  if (!reg || !reg.f || !d || !d.exists) return 'noreg';
  const rs = typeof reg.f.sha256 === 'string' && reg.f.sha256 ? reg.f.sha256 : null;
  const rb = Number.isFinite(reg.f.bytes) ? reg.f.bytes : null;
  if (rs && d.sha256) return rs === d.sha256 ? 'match' : 'hist';
  if (rb == null) return 'nover';
  return d.bytes === rb ? 'match' : 'hist';
}
// 磁盘当前内容是否属于同一路径「另一条登记」的版本（sha 优先、字节退判）；
// 是 → 返回那条登记：证明磁盘已是别的登记版本，不再是所选历史版本
function diskMatchesOtherReg(p, reg, d) {
  if (!d || !d.exists) return null;
  for (const r of fileRegsByPath.get(physKey(p)) || []) {
    if (reg && (r === reg || (r.ent && r.ent === reg.ent))) continue;   // 同实体=同版本，不算「别的版本」
    const rs = r.f && typeof r.f.sha256 === 'string' && r.f.sha256 ? r.f.sha256 : null;
    const rb = r.f && Number.isFinite(r.f.bytes) ? r.f.bytes : null;
    if (rs && d.sha256) { if (rs === d.sha256) return r; }
    else if (rb != null && rb === d.bytes) return r;
  }
  return null;
}
async function sha256Text(s) {
  try {
    const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch { return null; }   // 非安全上下文等：核不了就不核，走元数据分支
}
function textBytesOf(s) { try { return new TextEncoder().encode(s).length; } catch { return null; } }
