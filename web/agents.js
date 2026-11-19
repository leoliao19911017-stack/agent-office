'use strict';

/* ================= agents.js — G01 工位卡与 roster（G02 拆分自 app.js M7 段） =================
   ROLE/AVATAR、头像与数字格式化、agentStats 健康口径、renderAgents / agentDetail / agentHermesDetail。
   只读展示模块：不持有轮询状态，数据来自 app.js 的 lastState/hermesData（调用期解析）。 */

/** 岗位（看板上一律显示岗位，不显示内部 agent id） */
const ROLE = {
  claude: '开发', codex: '审查', 'claude-readonly': '日报',
  'image-gen': '生图', dsh: '开发', hermes: '调度', 'gpt-drive': '讨论',
};

/** 头像文件：按 agent id 对应，不用名字首字（三个 C 分不出来） */
const AVATAR = {
  claude: 'claude-code.png', codex: 'codex.png', 'claude-readonly': 'claude-readonly.png',
  'image-gen': 'image-gen.png', dsh: 'dsh.png', hermes: 'hermes.png', 'gpt-drive': 'gpt-drive.png',
};

function avatarFile(id) {
  return AVATAR[id] || 'hermes.png';
}

function fmtNum(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return String(v);
}

function fmtAgo(iso) {
  return ago(iso) || '—';
}

const agentUI = { selId: null };

function agentOf(id) {
  return (lastState && lastState.agents || []).find((a) => a.id === id) || null;
}

/** Agent 的忙闲判定：running/claimed/retrying 都算在干活 */
function agentBusy(a) {
  const t = a.totals || {};
  return (t.running || 0) + (t.retrying || 0) > 0;
}

// TASK-R11/G01：全站唯一的角色/实例标准化口径。
// 「角色」= ROSTER_DEFS 里的稳定角色ID（一线 4 个：3 个 Hermes 入口 + Codex）；
// 「实例」= 各上报源里的实例标识（Hermes 用自报 id，Codex 用中台 agent id）。
// 底栏与 Agents 页的每一个数字都从这一份 roster 算，不允许各页面自己数各的。
const ROSTER_DEFS=[
 {roleId:'lemate',name:'Lemate',role:'Coding'},
 {roleId:'winter',name:'Winter',role:'视频剪辑'},
 {roleId:'karina',name:'Karina',role:'图文笔记'},
 {roleId:'claude',name:'Claude Code',role:'写代码'},
 {roleId:'codex',name:'Codex',role:'生图·审查'},
];
// A02：连接健康 / 执行状态 / 上报新鲜度 —— 三个独立数据字段，一处判定，两处共用。
// 底栏 chips 与 Agents 页 roster 全部读 agentStats() 产出的 conn/work/hbState，
// 任何一个表面不得自己再判一套。语义边界：
//   连接健康   = online（Hermes 心跳 3 分钟窗口 / Codex 中台 seenAt 120 秒窗口）；
//   执行状态   = 只认「当前有效」的自报 state。自报缺失、已过期（reportStale）、
//               连接断开一律「未知」——历史上报事件只进「最近动作」列，不推断当前状态
//               （服务端 hermes-status 会把过期自报降级成 idle，前端按 reportStale 还原成未知）；
//   上报新鲜度 = 只依据最后一次有效业务上报时间 lastReport（A02 第 3 轮改判：
//               不再用连接心跳 heartbeatAgeSec——心跳新而上报过期时曾误显「刚刚」）。
//               缺上报时间显「—」；超 300 秒过期阈值显「已过期 · 时刻」（A01 第 73 轮：
//               只按 lastReport 的 age 判 300 秒，与服务端 reportStale 的 2 分钟
//               工作态语义解耦——上报新鲜度只反映最后成功上报，不看工作状态降级）；
//               新鲜显相对时长（N 秒/分钟前），永不显示「刚刚」。
//               与连接健康彻底解耦：只更新连接心跳不会重置上报新鲜度。
const WORK_CN={working:'执行中',idle:'空闲',unknown:'未知'};
const HERMES_TASK_PLACEHOLDERS=new Set(['—','未接入上报','（离线）','（上次上报已过期）']);
function hermesWorkOf(h){
 if(!h||!h.online)return 'unknown';         // 连接断开：执行状态不可知，不推断
 if(h.reportStale)return 'unknown';         // 过期自报被服务端降级成 idle；按「未知」还原（A02）
 if(h.state==='working')return 'working';
 if(h.state==='idle')return 'idle';
 return 'unknown';                          // state=unknown（从未接入上报）等
}
function hermesWorkUnknownWhy(h){
 if(!h)return '该角色没有实例上报';
 if(!h.online)return '连接已断开';
 if(h.reportStale)return '上次自报已过期';
 return '从未接入上报';
}
// A01 第 73 轮：上报过期阈值 300 秒（任务书口径），只按 lastReport 的 age 判定。
// 服务端 hermes-status.mjs 的 reportStale（2 分钟）是「执行状态」列的工作态语义，
// 不再串进本列——上报新鲜度仅反映最后成功上报，连接在线不因上报过期改成离线。
const REPORT_STALE_MS = 5 * 60 * 1000;
function hermesHbOf(h){
 if(!h)return{state:'none',text:'—',title:'该角色当前没有实例上报，缺业务上报时间显「—」'};
 const t=h.lastReport?Date.parse(h.lastReport):NaN;
 if(!Number.isFinite(t))return{state:'none',text:'—',title:'从未上报业务状态：缺上报时间显「—」，不拿连接心跳冒充新鲜'};
 const age=Date.now()-t;
 if(age>REPORT_STALE_MS)
  return{state:'timeout',text:`已过期 · ${fmtTime(h.lastReport)}`,title:`最后一次业务上报 ${fmtTime(h.lastReport)}（${ago(h.lastReport)}），已超 300 秒过期阈值；连接心跳是「连接健康」列的口径，不参与本列`};
 return{state:'ok',text:fmtAgo(h.lastReport),title:`最后一次业务上报 ${fmtTime(h.lastReport)}，在 300 秒过期阈值内`};
}
// A02：最近动作列只放「事件」——新鲜自报的任务文本，或带真实事件时间的历史告警。
// 历史告警不得取代当前执行状态；没有事件时间的历史异常显示 —。
function hermesTaskEvent(h){
 if(!h)return{text:'—',title:'该角色当前没有实例上报'};
 if(h.reportStale){
  if(!h.lastReport)return{text:'—',title:'上次自报已过期，但记录缺上报时间，按「无时间」显示 —'};
  return{text:`上次上报已过期 · ${fmtTime(h.lastReport)}`,title:`历史事件：自报于 ${fmtTime(h.lastReport)}，已过期；不代表当前执行状态`,hist:true};
 }
 const t=String(h.task||'').trim();
 if(!t||HERMES_TASK_PLACEHOLDERS.has(t))
  return{text:'—',title:t==='未接入上报'?'该入口从未接入任务上报，执行状态未知':null};
 return{text:t};
}
// X03：Claude / Codex 的三维状态——进程（活着/没开/未知）、执行（执行中/空闲/未知）、
// 接活（能/额度用完/未知）。数据只来自 /api/agents/real 的本机实测（app.js 轮询进
// agentsRealData）：PowerShell 进程数 + 会话日志 mtime + 最新会话尾部的限额报错。
// 红线：取不到就是未知，不猜；绝不拿「空闲」兜底。
const ACTIVE_MS=10*60*1000;   // 最近 10 分钟内有会话活动 = 执行中
const CAN_CN={ok:'能接活',exhausted:'额度用完',unknown:'未知'};
function realDims(roleId){
 const d=(agentsRealData&&agentsRealData.agents&&agentsRealData.agents[roleId])||null;
 if(!d)return{has:false,alive:undefined,work:'unknown',can:'unknown',
  why:'真实状态接口还没读到（/api/agents/real）',d:null,age:null};
 const alive=d.processAlive;   // true/false/null（null=探测失败，照实未知）
 const age=d.lastActivityAt!=null?Date.now()-Date.parse(d.lastActivityAt):null;
 let work,why=null;
 if(alive===false){work='unknown';why='进程没开，执行与否不可知';}
 else if(d.lastActivityAt==null){work='unknown';why=d.scanError||'没读到最近会话活动时间';}
 else if(age!=null&&age<=ACTIVE_MS){work='working';}
 else if(alive===true){work='idle';}                       // 进程活着但 10 分钟没动静 = 空闲
 else{work='unknown';why='活动已超 10 分钟且进程数探测失败，不猜';}
 const can=d.rateLimited==null?'unknown':(d.rateLimited?'exhausted':'ok');
 return{has:true,alive,work,can,why,d,age};
}
function agentStats(){
 const hubAgents=(lastState&&Array.isArray(lastState.agents))?lastState.agents:null;
 const now=Date.parse(lastState&&lastState.now)||Date.now();
 const hs=(hermesData&&hermesData.agents)||[];
 const roster=ROSTER_DEFS.map(d=>{
  // X03：Claude / Codex 走本机实测三维（进程/执行/接活），不再用中台 seenAt——
  // seenAt 只是中台刷新时刻（7 个 agent 同一毫秒），判不出谁在干活。
  if(d.roleId==='claude'||d.roleId==='codex'){
   const r=realDims(d.roleId);
   if(!r.has)return{...d,loaded:false,online:false,busy:false,timeout:false,work:'unknown',
    connText:'—',workText:WORK_CN.unknown,workUnknownWhy:'真实状态接口还没读到（/api/agents/real）',
    can:'unknown',canText:CAN_CN.unknown,hbState:'none',hbText:'—',taskText:'—'};
   const dd=r.d;
   const aliveTxt=r.alive===true?`进程活着（${dd.processCount} 个）`:r.alive===false?'进程没开':'进程未知';
   const connCls=r.alive===true?'online':r.alive===false?'offline':'none';
   const hbState=dd.lastActivityAt==null?'none':(r.age>REPORT_STALE_MS?'timeout':'ok');
   const hbText=dd.lastActivityAt==null?'—':`${esc(fmtAgo(dd.lastActivityAt))}有活动`;
   let taskText='—',taskTitle=dd.lastActivityFile?`最近会话日志：${dd.lastActivityFile}`:null;
   if(r.can==='exhausted'){
    taskText=`额度用完${dd.rateLimitResetAt?`，重置于 ${fmtTime(dd.rateLimitResetAt)}`:''}`;
    if(dd.rateLimitSample)taskTitle=`报错样本：${dd.rateLimitSample.slice(0,200)}\n${taskTitle||''}`;
   }else if(dd.lastActivityAt!=null){
    taskText=`${fmtAgo(dd.lastActivityAt)}有会话活动`;
   }
   return{...d,loaded:true,instanceId:(hubAgents&&hubAgents.find(x=>x.id===d.roleId)||{}).id||d.roleId,
    conn:connCls,online:r.alive===true,work:r.work,busy:r.work==='working',
    timeout:hbState==='timeout',alive:r.alive,real:dd,
    connText:aliveTxt,connTitle:dd.processError?`进程探测失败：${dd.processError}`:(dd.processCount!=null?`PowerShell Get-Process ${d.roleId} 实测 ${dd.processCount} 个进程`:null),
    workText:WORK_CN[r.work],workUnknownWhy:r.work==='unknown'?r.why:null,
    can:r.can,canText:CAN_CN[r.can],
    canWhy:r.can==='unknown'?'额度探测不到（取不到就是未知，不猜）':null,
    canTitle:dd.rateLimitResetAt?`限额重置于 ${fmtTime(dd.rateLimitResetAt)}`:null,
    hbState,hbText,
    taskText:esc(taskText),taskTitle:taskTitle?esc(taskTitle):null,taskHist:false};
  }
  const h=hs.find(x=>x.id===d.roleId);
  if(!h)return{...d,loaded:false,online:false,busy:false,timeout:false,work:'unknown',connText:'—',workText:WORK_CN.unknown,hbState:'none',hbText:'—',taskText:'—',taskTitle:'该角色当前没有实例上报'};
  const work=hermesWorkOf(h);
  const hb=hermesHbOf(h);
  const ev=hermesTaskEvent(h);
  return{...d,loaded:true,instanceId:h.id,
   conn:h.online?'online':'offline',
   online:!!h.online,work,busy:work==='working',
   timeout:hb.state==='timeout',
   connText:h.online?'在线':'离线',
   workText:WORK_CN[work],
   workUnknownWhy:work==='unknown'?hermesWorkUnknownWhy(h):null,
   // X03：Hermes 三入口没有额度上报通道——接活维度取不到就是未知，不猜
   can:'unknown',canText:CAN_CN.unknown,
   canWhy:'该角色没有额度上报通道',
   hbState:hb.state,hbText:esc(hb.text),hbTitle:hb.title?esc(hb.title):null,
   taskText:esc(ev.text),taskTitle:ev.title?esc(ev.title):null,taskHist:!!ev.hist};
 });
 const loaded=roster.filter(r=>r.loaded);
 return{
  registered:hubAgents?hubAgents.length:null,          // 中台注册角色（含未启用壳角色）
  roster,                                               // 一线 Agent 名册（含未加载占位）
  firstLine:loaded.length,
  rosterOnline:loaded.filter(r=>r.online).length,
  rosterBusy:loaded.filter(r=>r.work==='working').length,
  rosterIdle:loaded.filter(r=>r.work==='idle').length,        // A02：只有明确自报「空闲」才计，未知不计入空闲
  rosterUnknownWork:loaded.filter(r=>r.work==='unknown').length,
  hasUnknown:roster.some(r=>!r.loaded),                 // 有实例没上报时如实说「未知 N」
 };
}

function money(n){return n==null?'未统计':'$'+Number(n).toFixed(2)}
// TASK-R5（评审 #7）：单条执行记录的 HTML 抽成函数——原来整段内联在 agentDetail
// 的模板串里，一行 900+ 字符；执行记录的结构与状态映射单独看才好核对。
const RUN_STATE_CN={done:'完成',failed:'失败',running:'执行中',claimed:'已领取',retrying:'重试'};
function agentRunHtml(r){
 const st=r.state==='done'?'done':r.state==='failed'?'failed':'running';
 return `<div class="agent-run"><span class="st st-${st}">${esc(RUN_STATE_CN[r.state]||r.state)}</span> ${esc(r.rule||'—')}<p>${esc(r.summary||'暂无执行摘要')}</p></div>`;
}
function agentDetail(a){
 const t=a.totals||{},u=t.usage||{};
 const runs=(lastState?.runs||[]).filter(r=>r.agent===a.id).slice(0,8);
 // 没上报的字段显示 —，不用 0 冒充「做过了」
 const toks=(u.input==null&&u.output==null)?null:(u.input||0)+(u.output||0);
 const runsHtml=runs.length?runs.map(agentRunHtml).join(''):'<p class="agent-role">最近没有执行记录</p>';
 return `<div class="agent-detail"><h4>当前状态</h4><div class="agent-kv"><span>角色ID（稳定）</span><span>codex</span></div><div class="agent-kv"><span>实例ID</span><span>${esc(a.id)}</span></div><div class="agent-kv"><span>${a.online?'在线':'离线'} · ${a.totals==null?'状态未知':(agentBusy(a)?'工作中':'空闲')}</span><span>${t.retrying==null?'—':t.retrying} 重试中</span></div><div class="agent-kv"><span>最近心跳</span><span>${esc(fmtAgo(a.seenAt))}</span></div><h4>累计工作量</h4><div class="agent-kv"><span>已完成 ${t.done==null?'—':t.done}</span><span>${toks==null?'—':fmtNum(toks)} tokens</span></div><h4>最近 8 条执行记录</h4>${runsHtml}</div>`;
}
// X03/X04：Claude / Codex 的明细——三维（进程/执行/接活）全部来自 /api/agents/real
// 的本机实测，中台档案（done/tokens）只作附注，seenAt 一律不读（它只是中台刷新时刻）。
function agentRealDetail(r){
 const dd=r.real||{};
 const hubA=(lastState&&Array.isArray(lastState.agents)?lastState.agents:[]).find(a=>a.id===r.roleId);
 const t=(hubA&&hubA.totals)||{};
 const runs=(lastState?.runs||[]).filter(x=>x.agent===r.roleId).slice(0,8);
 const runsHtml=runs.length?runs.map(agentRunHtml).join(''):'<p class="agent-role">中台侧最近没有执行记录</p>';
 const canTxt=(r.canText||CAN_CN.unknown)+(dd.rateLimitResetAt?`，重置于 ${fmtTime(dd.rateLimitResetAt)}`:'');
 const rows=[
  ['角色ID（稳定）',r.roleId],
  ['实例ID',r.instanceId||r.roleId],
  ['进程状态',`${r.connText||'—'}${dd.processError?`（探测失败：${dd.processError}）`:''}`],
  ['最近会话活动',dd.lastActivityAt?`${fmtTime(dd.lastActivityAt)}（${fmtAgo(dd.lastActivityAt)}）`:`—（${dd.scanError||'没读到最近会话活动时间'}）`],
  ['执行状态',r.workText+(r.workUnknownWhy?`（${r.workUnknownWhy}，不推断为空闲）`:'')],
  ['能不能接活',canTxt],
 ];
 let hubBlock='';
 if(hubA){
  const u=t.usage||{};
  const toks=(u.input==null&&u.output==null)?null:(u.input||0)+(u.output||0);
  hubBlock=`<h4>中台档案（附注）</h4><div class="agent-kv"><span>已完成 ${t.done==null?'—':t.done} 个任务</span><span>${toks==null?'—':fmtNum(toks)} tokens</span></div>`;
 }else{
  hubBlock=`<h4>中台档案（附注）</h4><div class="agent-kv"><span>该角色不在中台注册表里</span><span>正常——干活走本机会话，不经过中台</span></div>`;
 }
 const quotaSample=dd.rateLimitSample?`<h4>额度报错样本（最新会话尾部实测）</h4><p class="agent-role">${esc(dd.rateLimitSample)}</p>`:'';
 const noteP=dd.note?`<p class="agent-role">${esc(dd.note)}</p>`:'';
 return `<div class="agent-detail"><h4>实时状态（本机实测）</h4>${rows.map(([k,v])=>`<div class="agent-kv"><span>${k}</span><span>${esc(String(v))}</span></div>`).join('')}
 ${hubBlock}${quotaSample}<h4>最近 8 条执行记录（中台侧）</h4>${runsHtml}
 <p class="agent-role" style="margin-top:10px">这一行不读中台 seenAt（7 个 agent 同一毫秒，判不出谁在干活）。三维状态来自本机实测：PowerShell 进程数、会话日志 mtime、最新会话尾部的限额报错；取不到的维度如实显示「未知」。</p>${noteP}</div>`;
}
function renderAgents(){
 // 平级架构：三个 Hermes（Lemate / Winter / Karina）各自是不同场景的需求入口，
 // 加上 Codex。TASK-R11/G01：名册与底栏同源（agentStats），每行带稳定角色ID+实例ID；
 // 中台注册数单独成统计卡——「中台注册 7」与「一线 4」分层展示，同一份名册可解释。
 const st=agentStats();
 const hs=hermesData?.agents||[];
 const codex=(lastState?.agents||[]).find(a=>a.id==='codex');
 // A01：说明段只留一行业务范围——注册数/筛选口径交给上方统计卡，不展示字段名与校验过程。
 const scopeText=`本页展示参与日常协作的一线 Agent 及其连接与执行状态。`;
 // TASK-R3：Hermes 状态还没读到（或一直失败）时如实说「未加载」，
 // 不拿空数组算出「0 个入口 · 0 在线」冒充实测结论。
 if(!hermesData){
  document.getElementById('agent-scope').textContent='Hermes 状态未加载（读取失败或尚未完成首轮同步），顶部横幅可见具体原因，恢复后自动刷新。';
  document.getElementById('agent-stats').innerHTML='';
  document.getElementById('agent-grid').innerHTML='<div class="empty"><img src="assets/empty-data.png" alt="" width="160"><p>Hermes 状态还没读到，等下一轮同步。<br>顶部横幅可见读取状态。</p></div>';
  return;
 }
 // TASK-R11/G01：三个统计卡横向排列——中台注册角色 / 一线角色 / 在线实例。
 // 中台注册数含未启用壳角色，是分层说明的一半；一线数字与底栏逐字相同。
 document.getElementById('agent-stats').innerHTML=[
  {label:'中台注册角色',value:st.registered==null?'—':String(st.registered),title:'中台 /api/state 的 agents 总数，含未启用的壳角色（claude-readonly / image-gen / gpt-drive / dsh 等）'},
  {label:'一线角色',value:String(st.roster.length),title:'实际参与工作的 Agent：3 个 Hermes 入口 + Codex。底栏「一线角色」同一个数'},
  {label:'在线实例',value:String(st.rosterOnline)+(st.hasUnknown?`（另 ${st.roster.length-st.firstLine} 未知）`:''),title:st.hasUnknown?'未上报的实例不计入在线；底栏「在线实例」同一个数':'一线角色中当前在线的实例数；底栏「在线实例」同一个数'},
 ].map(c=>`<div class="stat-card" title="${esc(c.title)}"><span class="sc-label">${esc(c.label)}</span><b class="sc-num">${esc(c.value)}</b></div>`).join('');
 // TASK-R11/G01：范围说明必须是可见文字（此前只藏在 ? 图标里，评审两轮看不见）
 document.getElementById('agent-scope').textContent=scopeText;
 // R9：roster 表格化。A02：连接健康 / 执行状态 / 上报新鲜度 三列读 agentStats
 // 产出的 conn / work / hbState 三个独立字段——「在线（连接，绿）」「上报已过期（新鲜度，金，只认业务上报时间）」
 // 「执行状态未知（历史上报已过期时不推断成空闲）」各自成列，互不顶替。
 // 最近动作列只放事件：新鲜自报的任务文本，或带真实事件时间的历史告警；无时间的历史异常显示 —。
 const now=Date.parse(lastState?.now)||Date.now();
 const rowsRoster=st.roster.map(r=>{
  if(r.real){   // X03：Claude / Codex 走本机实测三维，明细同时展示中台档案
   return{...r,id:r.roleId,ava:avatarFile(r.roleId),
    det:()=>agentRealDetail(r)};
  }
  const h=hs.find(x=>x.id===r.roleId);
  return{...r,id:r.roleId,ava:avatarFile(r.roleId),
   det:()=>agentHermesDetail(h,r.roleId)};
 });
 const head=`<div class="roster-head"><span></span><span>Agent</span><span>进程 / 连接</span><span>执行状态</span><span>能不能接活</span><span>最近活动 / 上报</span><span>当前需求 / 最近动作</span></div>`;
 const cards=rowsRoster.map(r=>{
  const sel=r.id===agentUI.selId;
  const workCls=r.work==='working'?'work-working':r.work==='idle'?'work-idle':'work-unknown';
  const hbCls=r.hbState==='timeout'?'stale':r.hbState==='ok'?'ok':'off';
  // X04 颜色语义：绿=执行中/能接活，灰=空闲，黄=额度用完，红=进程没开，问号灰=未知
  const dotCls=r.work==='working'?'run':r.can==='exhausted'?'stale':r.alive===false?'dead':r.online?'ok':'off';
  const connCls=r.alive===false?'dead':r.online?'ok':'off';
  const canCls=r.can==='ok'?'ok':r.can==='exhausted'?'limited':'unknown';
  return `<article class="agent-card ${sel?'selected':''}"><button type="button" class="agent-select" data-agent="${esc(r.id)}" aria-expanded="${sel}">
   <span class="ag-ava"><img class="agent-avatar" src="assets/agents/${esc(r.ava)}" alt=""><i class="ava-dot ${dotCls}"></i></span>
   <span class="ag-idcol"><span class="agent-name">${esc(r.name)}<i class="ag-ids" title="角色ID ${esc(r.roleId)}｜实例ID ${r.loaded?esc(r.instanceId):'未上报'}">${esc(r.roleId)}·${r.loaded?esc(r.instanceId):'?'}</i></span><span class="agent-role">${esc(r.role)}</span></span>
   <span class="ag-conn ${connCls}"${r.connTitle?` title="${esc(r.connTitle)}"`:''}>${r.connText}</span>
   <span class="ag-work ${workCls}"${r.workUnknownWhy?` title="执行状态未知：${esc(r.workUnknownWhy)}（不推断为空闲）"`:''}>${r.workText}</span>
   <span class="ag-can ${canCls}"${r.canWhy?` title="${esc(r.canWhy)}"`:r.canTitle?` title="${esc(r.canTitle)}"`:''}>${r.canText||CAN_CN.unknown}</span>
   <span class="ag-hb ${hbCls}"${r.hbTitle?` title="${r.hbTitle}"`:''}>${r.hbText}</span>
   <span class="ag-task${r.taskHist?' hist':''}"${r.taskTitle?` title="${r.taskTitle}"`:''}>${r.taskText}</span>
  </button>${sel?r.det():''}</article>`;
 });
 renderChanged('agent-grid',[rowsRoster,agentUI.selId],()=>{
  document.getElementById('agent-grid').innerHTML=head+cards.join('')||'<div class="empty"><img src="assets/empty-data.png" alt="" width="160"><p>尚未收到 Agent 数据</p></div>';
 });
}
function agentHermesDetail(h,roleId){
 // A02：明细行与 roster 三列同一套判定（hermesWorkOf / hermesHbOf / hermesTaskEvent），
 // 并把「上次自报时间」单独列出来——历史告警的事件时间在这里可核对。
 const work=h?hermesWorkOf(h):'unknown';
 const hb=hermesHbOf(h);
 const ev=hermesTaskEvent(h);
 const rows=[
  ['角色ID（稳定）', roleId||'—'],
  ['实例ID', h?h.id:'—'],
  ['连接健康', h?(h.online?'在线':'离线（未接入上报时如实显示）'):'—'],
  ['执行状态', h?WORK_CN[work]+(work==='unknown'?`（${hermesWorkUnknownWhy(h)}，不推断为空闲）`:''):'—'],
  ['上报新鲜度（业务上报）', h?(hb.state==='timeout'?`已过期（${fmtTime(h.lastReport)}，超 300 秒阈值）`:hb.state==='ok'?`正常（${ago(h.lastReport)}）`:'—（从未上报，缺上报时间）'):'—'],
  ['最后心跳', h&&h.heartbeatAgeSec!=null?fmtHbSec(h.heartbeatAgeSec):'—'],
  ['上次自报', h?(h.lastReport?`${fmtTime(h.lastReport)}${h.reportStale?'（已过期，属历史事件）':''}`:'从未上报'):'—'],
  ['当前需求 / 最近动作', ev.text],
  ['类型 / 场景', h?`${h.type||'—'} · ${h.scene||'—'}`:'—'],
 ];
 return `<div class="agent-detail"><h4>实时状态</h4>${rows.map(([k,v])=>`<div class="agent-kv"><span>${k}</span><span>${esc(String(v))}</span></div>`).join('')}
 <p class="agent-role" style="margin-top:10px">平级入口之间不共享内部数据。这一行是 ${esc(h?h.name:'—')} 自己上报的，不是外部探测的。</p></div>`;
}
