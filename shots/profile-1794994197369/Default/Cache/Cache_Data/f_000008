'use strict';

/* ================= preview.js — 文件预览抽屉 M6（G02 拆分自 app.js） =================
   openFileView / closeFileView / 历史版本 fvHistPreview / 图片预览 loadImagePreview 与抽屉事件绑定。
   版本门禁口径在 version.js（fvVersionGate / fileRegsByPath），本模块只做编排与展示。 */

let fvSeq = 0;             // 文件预览请求序号：晚到的旧响应直接丢弃
let fvAbort = null;        // TASK-R4（评审 #7）：预览在途请求的 AbortController——
                           // 关闭预览/换看别的文件时真正取消请求，不只丢弃响应
// TASK-R11/F02：当前预览的文件上下文（path+taskId+stepKey），「重新校验」用
let fvCurrent=null;
// TASK-R11/F02 补：当前抽屉正在展示的那条登记（同文件多步登记时跟随所点行；重校验后就地更新再重绘）
let fvReg=null;

/* ================= M6 · preview — 文件预览（自带超时与取消控制） ================= */
/* 点 Inspector 里的产物 → 拉 /api/office/file → 按类型渲染。
   Markdown 不做富文本渲染，直接显示原文——要"看真实内容"，不是"看美化后的成品"，
   原文更能暴露问题（比如文件其实是空的、或者写的是别的任务）。 */

// 图片预览的 blob objectURL（TASK-R5 评审 #6）：img 直接挂 /api/office/file 的 URL
// 会绕过超时与取消控制，改为 fetch+blob 后再建 objectURL；换文件/关闭时必须 revoke。
let fvObjectUrl = null;
function releaseFvObjectUrl() {
  if (fvObjectUrl) { try { URL.revokeObjectURL(fvObjectUrl); } catch { /* 已释放 */ } fvObjectUrl = null; }
}

// 图片分支与文本同款的受控加载：12s 超时 + AbortController 取消 + 序号防旧响应上屏
async function loadImagePreview(p, seq) {
  if (fvAbort) { try { fvAbort.abort(); } catch { /* 已结束 */ } }
  const ac = new AbortController();
  fvAbort = ac;
  const timer = setTimeout(() => ac.abort(), 12000);
  try {
    const res = await fetch(`/api/office/file?path=${encodeURIComponent(p)}`, { signal: ac.signal });
    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      try { const d = await res.json(); if (d && d.error) msg = d.error; } catch { /* 无体 */ }
      throw new Error(msg);
    }
    const blob = await res.blob();
    if (seq !== fvSeq) return;   // 期间用户点了别的文件：这份结果作废
    releaseFvObjectUrl();
    fvObjectUrl = URL.createObjectURL(blob);
    document.getElementById('fv-meta').textContent = fmtBytes(blob.size);
    document.getElementById('fv-body').innerHTML = `<img src="${fvObjectUrl}" alt="预览图">`;
  } catch (e) {
    if (seq !== fvSeq) return;
    // 能到这里的 abort 就是 12s 超时（主动取消时 seq 已变，走不到这里）
    const msg = e && (e.name === 'AbortError' || e.name === 'TimeoutError')
      ? '读取超时（12 秒无响应），已中断' : (e && e.message) || '未知错误';
    document.getElementById('fv-body').innerHTML = `<div class="fv-err">图片读取失败：${esc(msg)}<br>
      <button class="btn btn-secondary" data-fv-retry="${esc(p)}">重试</button></div>`;
  } finally {
    clearTimeout(timer);
    if (fvAbort === ac) fvAbort = null;
  }
}

/* G02：R9 实体校验/登记解析纯工具 + 三张实体索引 Map → version.js */

/** F02：历史登记预览——不拿磁盘当前内容冒充。
 *  历史原文候选 = 登记保存原文（f.text）＋最近一条历史快照（f.history[].snapshot）；
 *  候选与登记版本指纹核对一致（sha256 优先、登记字节退判）才算「有历史快照」并展示，
 *  指纹不符的快照留档不能冒充历史原文；都没有 → 只列真实登记元数据并明示
 *  「原始内容不可预览」。await 后必须复核 seq。 */
async function fvHistPreview(p, reg, d, seq) {
  const body = document.getElementById('fv-body');
  const meta = reg && reg.meta;
  const f = reg && reg.f;
  const other = diskMatchesOtherReg(p, reg, d);
  const own = f && f.sha256 ? `指纹 ${String(f.sha256).slice(0, 8)}` : (f && f.bytes != null ? `${f.bytes} B` : '无版本标识');
  const disk = `${fmtBytes(d.bytes)}${d.sha256 ? ` · 指纹 ${String(d.sha256).slice(0, 8)}` : ''}`;
  // F02：最近一条带 snapshot 的历史留档（时间倒序找）——有没有留档、留档对不对得上分开判
  const histArr = f && Array.isArray(f.history) ? f.history : [];
  let snapRec = null;
  for (let i = histArr.length - 1; i >= 0 && !snapRec; i--) {
    const h = histArr[i];
    if (h && typeof h.snapshot === 'string') snapRec = { text: h.snapshot, at: h.at || null };
  }
  let savedOk = false, saved = null, savedSrc = '';
  // F02（第 3 轮）：先问服务端 /api/office/file-version——请求带「物理文件标识（path）
  // + 版本登记标识（taskId›stepKey，vkey 双确认）」共同定位，服务端用 node crypto
  // 重算 sha256 核对快照留档；页内再用 WebCrypto 独立复核，两端都过才展示。
  // 服务端没有该端点/请求失败（旧服务进程）→ 退回页内候选核对（同一口径，行为不回退）。
  // F02（第 4 轮）：cache:'no-store'——快照留档可在服务端被删改，同一 URL 不允许复用
  // 浏览器 HTTP 缓存里旧的可用响应，否则删了快照还显示旧成功结果（缓存污染冒充）。
  let sv = null;
  if (meta) {
    try {
      const u = `/api/office/file-version?path=${encodeURIComponent(p)}&taskId=${encodeURIComponent(meta.taskId)}&stepKey=${encodeURIComponent(meta.stepKey)}${f && versionKeyOf(f) ? `&vkey=${encodeURIComponent(versionKeyOf(f))}` : ''}`;
      const r2 = await fetch(u, { cache: 'no-store' });
      // F01（第 78 轮）：快照缺失/错配时服务端回 404 + JSON 判定体——同样要解析，
      // 「服务端已明确回答不可用」以服务端结论为准（渲染「服务端核对」行），
      // 不退回页内 flow 副本核对（副本可能还留着已删快照的旧内容）。
      if (r2.ok || r2.status === 404) sv = await r2.json();
    } catch { /* 端点不在或网络失败：走页内候选核对 */ }
  }
  if (sv && sv.available && typeof sv.text === 'string' && f && (f.sha256 || f.bytes != null)) {
    const sha = f.sha256 ? await sha256Text(sv.text) : null;
    const nb = textBytesOf(sv.text);
    if (f.sha256 ? !!sha && sha === f.sha256 : nb != null && nb === f.bytes) {
      savedOk = true; saved = sv.text; savedSrc = `${sv.sourceLabel || '历史原文'}（服务端+页内双重核对一致）`;
    }
  }
  // F02（第 4 轮）：服务端端点已明确回答（sv 存在）就以服务端结论为准——它读的是
  // 当前档案，页内 flow 副本可能滞后（快照刚被删/改，副本里还留着旧内容）。
  // 只有端点不在/请求失败（旧服务进程，sv 为 null）才退回页内候选核对。
  if (!savedOk && !sv) {
    const cands = [];
    if (f && typeof f.text === 'string') cands.push({ text: f.text, src: '登记保存原文' });
    if (snapRec) cands.push({ text: snapRec.text, src: `登记历史快照（${snapRec.at ? fmtTime(snapRec.at) : '时间 —'}留档）` });
    for (const c of cands) {
      if (!f || (!f.sha256 && f.bytes == null)) break;   // 登记无版本标识：无从核对，不展示
      const sha = f.sha256 ? await sha256Text(c.text) : null;
      const nb = textBytesOf(c.text);
      if (f.sha256 ? !!sha && sha === f.sha256 : nb != null && nb === f.bytes) {
        savedOk = true; saved = c.text; savedSrc = c.src; break;
      }
    }
  }
  if (seq !== fvSeq) return;         // 期间换文件/关闭：这份结果作废
  const hint = `所选登记是历史版本（${own}），磁盘当前内容（${disk}）${other ? `已属于同路径另一条登记（${other.meta.taskId}›${other.meta.stepKey}）的版本` : '与所选登记不同'}，不能当作该历史版本预览。`;
  if (savedOk) {
    body.dataset.fvHint = 'hist-saved';
    body.innerHTML = `<div class="fv-hint">${esc(hint)}下方为按登记指纹核对一致后展示的${esc(savedSrc)}。</div><pre>${esc(saved)}</pre>`;
    renderFvDetail(p, reg, { code: 'hist-saved', actBytes: d.bytes, actSha: d.sha256 || null });
    return;
  }
  body.dataset.fvHint = 'hist';
  const regB = f && f.bytes != null ? `${fmtBytes(f.bytes)}（${f.bytes} B）` : '—';
  let savedRow = '未保存——该登记只留了元数据，历史原文不可预览';
  let noSavedLead = '该登记未保存原文';
  if (sv && !sv.available) {
    // F02（第 4 轮）：服务端已实测——「保存原文」行按服务端候选实测值说，页内旧副本不算数
    const sc = Array.isArray(sv.candidates) && sv.candidates.length
      ? sv.candidates.map((c) => `${c.bytes} B · 指纹 ${String(c.sha256).slice(0, 8)}`).join('；') : '';
    if (sc) {
      savedRow = `有快照留档但核对不上：快照 ${sc} ≠ 登记版本（服务端实测），不能冒充历史原文，不可预览`;
      noSavedLead = '该登记的快照留档与登记版本指纹不符（服务端实测），不能当历史原文展示';
    } else {
      savedRow = '未保存——服务端实测该登记已无保存原文或快照留档，历史原文不可预览';
      noSavedLead = '该登记的历史快照不存在（服务端实测），不可预览';
    }
  } else if (snapRec) {
    const sb = textBytesOf(snapRec.text);
    const ssha = await sha256Text(snapRec.text);
    savedRow = `有快照留档但核对不上：快照 ${sb != null ? `${sb} B` : '—'}${ssha ? ` · 指纹 ${ssha.slice(0, 8)}` : ''} ≠ 登记版本 ${f && f.sha256 ? `指纹 ${String(f.sha256).slice(0, 8)}` : regB}，不能冒充历史原文，不可预览`;
    noSavedLead = '该登记的快照留档与登记版本指纹不符，不能当历史原文展示';
  }
  const rows = [
    ['登记ID', meta ? `${meta.taskId}›${meta.stepKey}` : '—'],
    ['登记版本', versionLabelOf(f)],
    ['登记字节', regB],
    ['内容指纹', f && f.sha256 ? f.sha256 : '—（登记未存指纹）'],
    ['登记时间', meta && meta.at ? fmtTime(meta.at) : '—'],
    ['保存原文', savedRow],
    ['磁盘当前', `${disk}${other ? `，属另一条登记（${other.meta.taskId}›${other.meta.stepKey}）的版本，不在历史预览里展示` : ''}`],
  ];
  // F02（第 3 轮）：服务端 /api/office/file-version 的判定与快照实测值也进元数据，
  // 页内显示与服务端 curl 口径一致（服务端不可达时这行不加，不摆假数据）
  if (sv && !sv.available) {
    const cand = Array.isArray(sv.candidates) && sv.candidates.length
      ? `，快照实测 ${sv.candidates.map((c) => `${c.bytes} B · 指纹 ${String(c.sha256).slice(0, 8)}`).join('；')}` : '';
    rows.push(['服务端核对', `file-version：不可用（${sv.reason || '—'}${cand}）`]);
  }
  body.innerHTML = `<div class="fv-hint">${esc(hint)}${esc(noSavedLead)}，以下只列真实登记元数据：</div>
    <div class="fv-hist-meta">${rows.map(([k, v]) => `<div class="fh-kv"><span>${k}</span><b title="${esc(String(v))}">${esc(String(v))}</b></div>`).join('')}</div>`;
  renderFvDetail(p, reg, { code: 'hist', actBytes: d.bytes, actSha: d.sha256 || null });
}

/** TASK-R11/F02/F03：预览抽屉的元数据区。实测/登记双口径分开列（24px 行 · 13px），
 *  执行者与来源类型语义拆开，「归档迁移」不再冒充执行者。没有可靠数据的行显示「—」。
 *  reg = 所点那一行的登记；缺省退回首条。多步登记时补一行「登记步骤」明示口径。
 *  F02：reg.ent 指向物理实体——「登记版本/引用登记/登记步骤」按实体口径展开，
 *  同一版本的多条登记是引用不是两个文件；不同版本各开各的行、身份不混。
 *  F02（历史预览）：pv 有值时补「预览核对」行——历史分支里明说预览体里
 *  是保存原文还是纯元数据、磁盘当前内容为什么不展示。 */
function renderFvDetail(p, reg, pv){
 const det=document.getElementById('fv-detail');
 const pk=physKey(p);
 const regs=fileRegsByPath.get(pk)||[];
 if(!reg)reg=regs[0]||null;
 const meta=reg&&reg.meta;
 const sem=fileSourceSemantics(meta&&meta.by);
 const f=reg&&reg.f;
 const ent=(reg&&reg.ent)||null;
 const refs=(ent&&ent.refs&&ent.refs.length)?ent.refs:(reg?[reg]:[]);
 const st=entityCheckState(pk,ent);
 const regB=f&&f.bytes!=null?fmtBytes(f.bytes):'—';
 const actB=st.chk&&st.chk.exists?fmtBytes(st.chk.bytes):'—';
 // F01：mism 文案逐条登记枚举——同一实体多条登记各报各的核对结论（登记ID = 步骤），不合并成一个值
 const regVerdict=(r)=>{
  const b=r.f&&r.f.bytes;
  const lab=refs.length>1?`${String(r.meta.stepNo??'').padStart(2,'0')} ${r.meta.stepName}：`:'';
  if(b==null||!Number.isFinite(b))return`${lab}登记 —（缺失）`;
  return`${lab}登记 ${fmtBytes(b)}${st.chk&&st.chk.exists?(b===st.chk.bytes?' = 实测':' ≠ 实测 '+actB):''}`;
 };
 // F01（第 4 轮）：多条登记先按原始字节数确认是否真的同值——同值才合并展示并标注数量，
 // 不同值必须声明逐条分列，把「合并是不是掩盖差异」这个疑点在文案里直接回答掉。
 // F01（第 9 轮）：判据升为完整版本标识（内容指纹优先、退登记字节）——字节同值但指纹
 // 不同/缺失也是不同历史版本；同一历史版本（指纹一致）才允许汇总，否则逐条分列。
 const verTextOf=(r)=>{const k=versionKeyOf(r.f);return k.startsWith('sha:')?`内容指纹 ${String(r.f.sha256).slice(0,8)}`:k.startsWith('b:')?`按登记字节 ${r.f.bytes} B（无内容指纹）`:'版本标识缺失';};
 const distinctVers=[...new Set(refs.map(r=>versionKeyOf(r.f)))];
 const sameNote=refs.length>1?(distinctVers.length===1
  ?`；${refs.length} 条登记的版本标识完全一致（${verTextOf(refs[0])}），逐条核对确认同一历史版本后才合并展示共同登记值并标注登记数量`
  :`；${refs.length} 条登记存在 ${distinctVers.length} 个不同版本标识，逐条如实分列，不合并`):'';
 const stateText={
  unchecked:'—（尚未实测）',
  unreadable:'无法校验（不可读，非丢失）',
  ok:'一致',
  unknown:'未知（登记值缺失，无法与实测比较，不判定为一致）',
  hist:`历史版本（登记 ${regB} ≠ 实测 ${actB}；同一路径下另有版本与磁盘当前内容一致）`,
  mism:`大小不一致（${refs.map(regVerdict).join('；')}${sameNote}${st.multiVersion?'；同一路径存在多个登记版本':''}；每条登记按真实登记ID分别核对，登记原文保留、不自动更新）`,
 }[st.code];
 const stepLabel=(r)=>`${r.meta.taskTitle} › ${String(r.meta.stepNo??'').padStart(2,'0')} ${r.meta.stepName}`;
 const regStepLab=(r)=>`${String(r.meta.stepNo??'?').padStart(2,'0')} ${r.meta.stepName}`;
 // F01（第 9 轮）：按独立登记ID分别读取的四要素补齐——「登记版本」「登记路径」逐条列出
 // （步骤号标注归属），两条历史登记的版本信息与原始路径各自独立可查，不取首条冒充全部；
 // 同一历史版本的多条登记才继续汇总展示（sameNote 已按版本标识口径声明）。
 const rows=[
  ['执行者',sem.executor],
  ['来源类型',sem.sourceType||'—'],
  ['登记版本',refs.length>1?refs.map(r=>`${regStepLab(r)}：${verTextOf(r)}`).join('；'):versionLabelOf(f)],
 ];
 if(refs.length>1)rows.push(['登记路径',refs.map(r=>`${regStepLab(r)}：${r.f&&r.f.path||'—'}`).join('；')]);
 if(refs.length>1)rows.push(['引用登记',`${refs.length} 条（同一物理文件同一版本，原始登记均保留）`]);
 if(refs.length>1)rows.push(['登记步骤',refs.map(stepLabel).join('；')]);
 else if(meta)rows.push(['登记步骤',stepLabel(reg)]);
 // F01（第 5 轮）：多条登记时「登记值/登记时间」逐条列出（步骤号 + 原始字节 + 登记时间），
 // 两条历史登记可分别核对，不再只显示首条冒充全部
 rows.push(
  ['实测值',st.chk&&st.chk.exists?fmtBytes(st.chk.bytes):'—'],
  ['测量时间',st.chk&&st.chk.exists&&st.chk.mtime?fmtTime(st.chk.mtime):'—'],
  ['登记值',refs.length>1?refs.map(r=>`${regStepLab(r)}：${r.f&&r.f.bytes!=null?`${fmtBytes(r.f.bytes)}（${r.f.bytes} B）`:'—'}`).join('；'):regB],
  ['登记时间',refs.length>1?refs.map(r=>`${regStepLab(r)}：${r.meta.at?fmtTime(r.meta.at):'—'}`).join('；'):(meta&&meta.at?fmtTime(meta.at):'—')],
  ['校验状态',stateText],
 );
 // F01（第 73 轮）：不可校验态补一行来自后端真实错误码的原因说明（files.js 的
 // unreasonOf 映射：已知码准确文案、未知码统一说明），与文件行同一口径。
 if(st.code==='unreadable')rows.push(['原因',unreasonOf(st.chk&&st.chk.errCode)]);
 if(pv){
  const pvText=pv.code==='hist-saved'
   ?`已展示按登记指纹核对一致的历史原文（登记保存原文或历史快照留档）；磁盘当前 ${fmtBytes(pv.actBytes)}${pv.actSha?` · 指纹 ${String(pv.actSha).slice(0,8)}`:''} 与所选登记不同`
   :`未预览文件内容——磁盘当前 ${fmtBytes(pv.actBytes)}${pv.actSha?` · 指纹 ${String(pv.actSha).slice(0,8)}`:''} 与所选登记不同，仅展示登记元数据`;
  rows.push(['预览核对',pvText]);
 }
 det.hidden=false;
 det.innerHTML=rows.map(([k,v])=>`<div class="fvd-row"><span>${k}</span><b${k==='校验状态'&&(st.code==='mism'||st.code==='unreadable'||st.code==='unknown')?' class="warn"':''}${k==='预览核对'&&pv&&pv.code==='hist'?' class="warn"':''} title="${esc(String(v))}">${esc(String(v))}</b></div>`).join('');
}
async function openFileView(p, from) {
  const seq = ++fvSeq;              // 竞争保护：连点几个文件，只有最后一次请求有资格上屏
  const box = document.getElementById('file-view');
  const body = document.getElementById('fv-body');
  document.getElementById('fv-name').textContent = String(p).split(/[\\/]/).pop();
  document.getElementById('fv-meta').textContent = '';
  document.getElementById('fv-path').textContent = p;
  body.innerHTML = '<div class="fv-msg">读取中…</div>';
  delete body.dataset.fvHint;       // F02：清掉上一次预览留下的历史标记，避免串用
  // R9：定位到步骤——能溯源就给链接，不能就隐藏（不摆假按钮）
  const loc = document.getElementById('fv-locate');
  // TASK-R11/F02 补：优先用所点行自带的登记上下文（from），多步登记不串口径
  const reg = resolveFileReg(p, from);
  const tgt = reg ? { taskId: reg.meta.taskId, stepKey: reg.meta.stepKey } : stepOfPath(p);
  if (tgt) { loc.hidden = false; loc.dataset.goto = `${tgt.taskId}|${tgt.stepKey}`; }
  else loc.hidden = true;
  // TASK-R11/F02/F03：元数据区 + 重校验入口（离线快照或无溯源登记时不给按钮，不摆假的）
  fvCurrent = tgt ? { path: p, taskId: tgt.taskId, stepKey: tgt.stepKey } : { path: p };
  fvReg = reg;
  renderFvDetail(p, reg);
  document.getElementById('fv-revalidate').hidden = offline || !tgt;
  // 受控下载出口：任何时候都可拿到原件（离线快照没有本地服务，不给）
  const dl = document.getElementById('fv-dl');
  dl.hidden = offline;
  dl.href = '/api/office/file-download?path=' + encodeURIComponent(p);
  box.classList.add('open');

  if (offline) {
    const file=snapshot.files[p];
    document.getElementById('fv-meta').textContent='离线快照';
    body.innerHTML=file?`<pre>${esc(file.text||file.note||'暂无可预览内容')}</pre>`:'<div class="fv-warn">离线快照没有收录此文件，请通过本地服务打开。</div>';
    return;
  }
  const ext = (String(p).match(/\.[^.\\/]+$/) || [''])[0].toLowerCase();
  // TASK-R5（评审 #6）：图片不再裸挂 <img src>（绕过超时/取消，悬挂时永远「读取中…」），
  // 与文本同款走 fetch+blob 受控加载；解码失败由下面的捕获态 error 监听兜底
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) {
    body.dataset.fvPath = p;
    releaseFvObjectUrl();
    body.innerHTML = '<div class="fv-msg">图片读取中…</div>';
    loadImagePreview(p, seq);
    return;
  }

  try {
    // TASK-R4（评审 #7）：预览请求纳入统一超时保护（与 api() 同为 12s），
    // 不再裸 fetch——悬挂时永远停在「读取中」。AbortController 让关闭预览/
    // 换文件能真正取消在途请求，超时后走就地重试分支。
    if (fvAbort) { try { fvAbort.abort(); } catch { /* 已结束 */ } }
    const ac = new AbortController();
    fvAbort = ac;
    const timer = setTimeout(() => ac.abort(), 12000);
    let res, d;
    try {
      res = await fetch(`/api/office/file?path=${encodeURIComponent(p)}`, { signal: ac.signal });
      d = await res.json();
    } finally {
      clearTimeout(timer);
      if (fvAbort === ac) fvAbort = null;
    }
    if (seq !== fvSeq) return;      // 期间用户点了别的文件：这份结果作废
    if (!res.ok || d.exists === false) {
      // TASK-R3：HTTP 级失败也给就地重试，和 catch 分口一致——
      // 报错只报一半、想重试得关掉重点，是差一步的体验。
      body.innerHTML = `<div class="fv-warn">${esc(d.error || ('HTTP ' + res.status))}<br>
        <button class="btn btn-secondary" data-fv-retry="${esc(p)}">重试</button></div>`;
      return;
    }
    document.getElementById('fv-meta').textContent =
      `${fmtBytes(d.bytes)}${d.modifiedAt ? ' · ' + fmtTime(d.modifiedAt) : ''}`;
    if (d.kind === 'binary') {
      body.innerHTML = `<div class="fv-msg">${esc(d.note || '二进制文件，不支持页面预览')}<br><br>请用右上角「下载」取原件。</div>`;
      return;
    }
    const warn = d.truncated
      ? `<div class="fv-warn">文件 ${fmtBytes(d.bytes)}，超过 2MB 只显示前 2MB</div>` : '';
    // F02（第 3 轮）：只要磁盘现状与所选登记的版本指纹不同（gate=hist）就走历史
    // 预览分支，不再要求「磁盘恰好属于另一条登记的版本」——磁盘谁的版本都不匹配
    // 时（如 TEST-R11 的 app.css：两条登记都是 80408B、磁盘已漂移）展示磁盘现状
    // 仍是拿当前文件冒充历史版本。历史原文须指纹核对一致才展示，否则只给元数据。
    if (fvVersionGate(reg, d) === 'hist') {
      await fvHistPreview(p, reg, d, seq);
      return;
    }
    body.innerHTML = `${warn}<pre>${esc(d.text || '')}</pre>`;
  } catch (e) {
    if (seq !== fvSeq) return;      // 用户已关闭/换文件：不回写旧面板
    // 主动取消（abort）只发生在换文件/关闭场景，seq 已变，走不到这里；
    // 能到这里的 abort 就是 12s 超时——如实说，别甩一句英文 AbortError
    const msg = e && (e.name === 'AbortError' || e.name === 'TimeoutError')
      ? '读取超时（12 秒无响应），已中断' : (e && e.message) || '未知错误';
    body.innerHTML = `<div class="fv-err">读取失败：${esc(msg)}<br>
      <button class="btn btn-secondary" data-fv-retry="${esc(p)}">重试</button></div>`;
  }
}

function closeFileView() {
  fvSeq++;                          // 关闭即作废在途请求，回来不允许再上屏
  if (fvAbort) { try { fvAbort.abort(); } catch { /* 已结束 */ } fvAbort = null; }   // TASK-R4：真取消，不留悬挂连接
  releaseFvObjectUrl();             // TASK-R5（评审 #6）：释放图片 objectURL
  document.getElementById('file-view').classList.remove('open');
  document.getElementById('fv-body').innerHTML = '';
}

// 图片加载失败是 <img> 自身的 error 事件，不冒泡——捕获态监听一次，给错误态 + 重试
document.getElementById('fv-body').addEventListener('error', (ev) => {
  if (ev.target.tagName !== 'IMG') return;
  const p = ev.target.parentElement.dataset.fvPath || document.getElementById('fv-path').textContent;
  ev.target.outerHTML = `<div class="fv-err">图片加载失败（路径不存在或不可读）<br>
    <button class="btn btn-secondary" data-fv-retry="${esc(p)}">重试</button></div>`;
}, true);

// Inspector 里点产物行 / 点遮罩关闭 / 失败重试
document.addEventListener('click', (e) => {
  // TASK-R11/F04：整行单击打开预览，但行内的「定位到步骤」「清除筛选」是独立动作——
  // 不加这道闸它们会被行上的 data-open-file 抢走，点了没反应
  if (e.target.closest('[data-goto],[data-clear-file-filters]')) return;
  const row = e.target.closest('[data-open-file]');
  if (row) {
    // TASK-R11/F02 补：文件页的行/预览按钮带自己的登记（data-task-id/data-step-key），
    // 点哪条登记就展示哪条；工作台等入口没有上下文 → null，退回首条登记
    // F02：行上还带版本键（data-vkey）——同一路径版本分叉后，点哪条版本就展示哪条
    const host = row.closest('.library-file') || row;
    // F01（第 12 轮）：多版本主行内的登记行自带版本身份（data-reg-vkey/data-task-id/data-step-key）——
    // 点哪条登记行就展示哪条版本的登记；不带该属性的行（旧渲染/预览按钮）仍用行根（当前版本）上下文
    const own = e.target.closest('[data-reg-vkey]');
    const src = own && host !== own && host.contains(own) ? own : host;
    const from = src.dataset.taskId ? { taskId: src.dataset.taskId, stepKey: src.dataset.stepKey, vkey: src.dataset.regVkey || src.dataset.vkey || null } : null;
    openFileView(row.getAttribute('data-open-file'), from);
    return;
  }
  const retry = e.target.closest('[data-fv-retry]');
  if (retry) { openFileView(retry.getAttribute('data-fv-retry')); return; }
  if (e.target.id === 'file-view') closeFileView();
});
document.getElementById('fv-close').addEventListener('click', closeFileView);
// R9（评审 Files）：复制路径。127.0.0.1 是安全上下文，clipboard API 可用；
// execCommand 兜底，仍失败就如实报「复制失败」——不假装成功。
document.getElementById('fv-copy').addEventListener('click', async () => {
  const p = document.getElementById('fv-path').textContent;
  const btn = document.getElementById('fv-copy');
  let ok = false;
  try { await navigator.clipboard.writeText(p); ok = true; }
  catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = p; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      ok = document.execCommand('copy');
      ta.remove();
    } catch { ok = false; }
  }
  const old = btn.textContent;
  btn.textContent = ok ? '已复制' : '复制失败';
  setTimeout(() => { btn.textContent = old; }, 1500);
});
// TASK-R11/F02：重新校验——服务端读真实文件元数据（大小+sha256）更新登记并留历史；
// 文件读不到就明确「无法校验」，登记原样不动（服务端 file-events.jsonl 留痕）。
document.getElementById('fv-revalidate').addEventListener('click', async () => {
  if(!fvCurrent||offline)return;
  const btn=document.getElementById('fv-revalidate');
  btn.disabled=true;const old=btn.textContent;btn.textContent='校验中…';
  try{
    const d=await api('/api/office/file-revalidate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(fvCurrent)});
    if(d.ok){
      fileStatus.set(physKey(fvCurrent.path),{exists:true,bytes:d.after.bytes,mtime:d.after.mtime});   // F02：物理键，与两页共用口径一致
      fileStatusVersion++;
      // F01（第 10 轮·验证轮）：登记快照（bytes/sha256/时间/history）只以任务档案为准——
      // 不再就地用实测值覆盖 fvReg.f（那是历史登记的原件，覆盖即伪造快照）。服务端重校验
      // 已把旧值留进该登记的 history、档案值更新为实测；这里拉一轮新档案，再从新档案里
      // 重取这条登记来渲染，抽屉与文件行展示的始终是档案口径，历史仍在档可查。
      await tick();
      const freshRegs=fileRegsByPath.get(physKey(fvCurrent.path))||[];
      const regNow=freshRegs.find(r=>(!fvCurrent.taskId||r.meta.taskId===fvCurrent.taskId)&&(!fvCurrent.stepKey||r.meta.stepKey===fvCurrent.stepKey))||freshRegs[0]||fvReg;
      renderFvDetail(fvCurrent.path,regNow);
      if(activePage==='files')renderFiles();
      showToast(d.changed?`已更新登记：实测 ${fmtBytes(d.after.bytes)}（原 ${fmtBytes(d.before.bytes)}，历史已保留）`:`校验一致：${fmtBytes(d.after.bytes)}`,'ok');
    }else{
      showToast(`无法校验：${d.message||'文件不可读'}`,'err');
    }
  }catch(err){
    showToast(`重新校验失败：${err.message||err}`,'err');
  }finally{
    btn.disabled=false;btn.textContent=old;
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('file-view').classList.contains('open')) {
    closeFileView();
  }
});
