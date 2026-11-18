'use strict';

/* ================= files.js — 文件视图（G02 拆分自 app.js F01/F02/F03） =================
   文件页筛选状态 + 文件行渲染（fileButton 单版本行 / physButton 物理文件主行）+
   文件库总渲染（renderFiles）。G02 拆分：fileButton 原为 176 行整块装配，登记核对
   的逐条逻辑（登记标签/核对文案/登记行/身份行）收进模块级纯函数，fileButton 只留
   六态判定与行装配；renderFiles 的实体构建在 version.js buildFileEntities，
   筛选/工具栏/分组各自成函数——输出与拆分前逐字一致。
   状态归属：fileQuery/fileTask/... 筛选态随本文件（R9 存 office.ui.v2）；数据快照
   （lastFlow/fileStatus/fileStatusVersion）与 renderChanged 在 app.js，调用期取用。 */

// R9（评审 Files）：文件页检索状态——与技能页一样刷新不丢（存 office.ui.v2）
let fileQuery='',fileTask='all',fileStep='all',fileType='all',fileAgent='all',fileSort='recent',fileOnlyWith=true;

// G02：筛选状态存取收口——app.js（saveUiPos/restoreUiPos/清空筛选）只经这三个
// 函数读写，不再各写一份字段清单，字段增减只改这一处。
function getFileFilters(){return{fileQuery,fileTask,fileStep,fileType,fileAgent,fileSort,fileOnlyWith};}
function setFileFilters(p){
 if(!p)return;
 if(typeof p.fileQuery==='string')fileQuery=p.fileQuery;
 if(typeof p.fileTask==='string')fileTask=p.fileTask;
 if(typeof p.fileStep==='string')fileStep=p.fileStep;
 if(typeof p.fileType==='string')fileType=p.fileType;
 if(typeof p.fileAgent==='string')fileAgent=p.fileAgent;
 if(typeof p.fileSort==='string')fileSort=p.fileSort;
 if(typeof p.fileOnlyWith==='boolean')fileOnlyWith=p.fileOnlyWith;
}
function clearFileFilters(){
 // 与原「清空筛选」同一语义：清 6 项、不动 fileOnlyWith（保留原行为）
 fileQuery='';fileTask='all';fileStep='all';fileType='all';fileAgent='all';fileSort='recent';
}

// TASK-R11/F03：来源语义拆分——「执行者」与「来源类型」是两个字段。
// 「归档迁移」是导入行为不是角色：执行者记「—」，来源类型记「历史归档」。
// 依据任务档案里真实出现过的 by 值（Hermes/hermes/Leo（工作台）/归档迁移），
// 不在这一层猜测未登记的值：其它值原样作为执行者，来源类型记 null（前端不显示标签）。
function fileSourceSemantics(by){
 const b=String(by||'').trim();
 if(!b)return{executor:'—',sourceType:null,executorKnown:false};
 if(b==='归档迁移')return{executor:'—',sourceType:'历史归档',executorKnown:false};
 if(/^hermes$/i.test(b))return{executor:'Hermes',sourceType:'Agent生成',executorKnown:true};
 if(b.startsWith('Leo'))return{executor:b,sourceType:'人工创建',executorKnown:true};
 return{executor:b,sourceType:null,executorKnown:true};
}

/* ================= 登记核对纯函数（G02 自 fileButton 拆出，输出逐字不变） =================
   原为 fileButton 内的局部 const；拆出后把闭包依赖（st.chk / refs / oneTask）改为
   显式入参，逻辑与文案零改动。physButton 里的同名短函数（verKey/verShort）是它
   自己的局部版本，不受影响。 */

// F01（第 5 轮）：登记标签带上登记时间——原始ID（需求›步骤）、登记时间、登记字节三要素
const regLabOf=(r)=>`${String(r.meta.stepNo??'?').padStart(2,'0')} ${r.meta.stepName}（${r.meta.taskId}）${r.meta.at?` · ${fmtTime(r.meta.at)}`:''}`;
// 逐条登记的核对文案：登记缺失不判一致；未实测如实说；实测了逐条比（chk = 实测快照）
const refNoteOf=(r,chk,actB)=>{
 const b=r.f&&r.f.bytes;
 const lab=regLabOf(r);
 if(b==null||!Number.isFinite(b))return`${lab}：登记 —（缺失，无从比较，不判一致）`;
 if(actB==null)return`${lab}：登记 ${fmtBytes(b)}（尚未实测）`;
 return b===chk.bytes?`${lab}：登记 ${fmtBytes(b)} = 实测 ${actB}（一致）`:`${lab}：登记 ${fmtBytes(b)} ≠ 实测 ${actB}（不一致）`;
};
const refNotesOf=(ent,chk,actB)=>(ent.refs||[]).map(r=>refNoteOf(r,chk,actB)).join('\n');
const oneTaskOf=(ent)=>(ent.refs||[]).length>0&&ent.refs.every(r=>r.meta.taskId===ent.refs[0].meta.taskId);
const stepsByBytesOf=(ent)=>{
 const stepsByBytes=new Map();
 for(const r of ent.refs||[]){const b=r.f&&r.f.bytes;
  if(b==null||!Number.isFinite(b))continue;
  if(!stepsByBytes.has(b))stepsByBytes.set(b,[]);
  stepsByBytes.get(b).push(String(r.meta.stepNo??'?').padStart(2,'0'));
 }
 return stepsByBytes;
};
// 同一大小的登记步骤并排标注（跨需求的步骤号会撞车，只在单一需求内标注）
const regLineOf=(st,oneTask,stepsByBytes)=>st.regBytes&&st.regBytes.length
 ?st.regBytes.map(b=>fmtBytes(b)+(oneTask&&stepsByBytes.has(b)?`(${[...new Set(stepsByBytes.get(b))].join('·')})`:'')).join(' · ')
 :null;
// F01（第 9 轮）：登记按「字节数+内容指纹」完整版本标识分组（v=null 表登记缺字节数）
const regsByValOf=(refs)=>{
 const regsByVal=[];
 for(const r of refs){
  const b=r.f&&r.f.bytes;
  const sha=(r.f&&r.f.sha256)||null;
  const v=(b!=null&&Number.isFinite(b))?b:null;
  let g=regsByVal.find(x=>x.v===v&&x.sha===sha);
  if(!g){g={v,sha,steps:[],labs:[]};regsByVal.push(g);}
  g.steps.push(String(r.meta.stepNo??'?').padStart(2,'0'));
  g.labs.push(regLabOf(r));
 }
 return regsByVal;
};
// 版本标识的可读写法：有指纹给前 8 位；无指纹明说「无内容指纹」——指纹缺失不算版本一致的证据
const verNoteOf=(g)=>g.sha?`内容指纹 ${String(g.sha).slice(0,8)}`:(g.v!=null?'无内容指纹（仅按登记字节）':'版本标识缺失');
const verListOf=(g)=>g.v==null?'登记缺失':`${g.v} B · ${verNoteOf(g)}`;
const stepPrefixOf=(g,oneTask,refs)=>oneTask?`${[...new Set(g.steps)].join('·')} `:`${refs[0]&&refs[0].meta.taskId}·${[...new Set(g.steps)].join('·')} `;
// F01（第 4 轮）：全部登记同版本 → 合并显示共同登记值并标 ×N；分叉 → 逐条分列真实登记值
const regLinesOf=(refs,regsByVal,actBytes,oneTask)=>{
 const regLines=[];
 if(regsByVal.length===1&&regsByVal[0].v!=null){
  const g=regsByVal[0];
  regLines.push({
   t:`登记 ${fmtBytes(g.v)}${refs.length>1?` ×${refs.length}`:''}`,
   title:`${refs.map(r=>regLabOf(r)).join(' / ')} 的版本标识完全一致（${verListOf(g)}），${refs.length>1?`${refs.length} 条登记逐条核对为同一历史版本后才合并展示共同登记值并标注登记数量；`:''}与实测 ${actBytes} B ${g.v===actBytes?'一致':'不一致'}`,
  });
 }else for(const g of regsByVal){
  regLines.push({
   t:g.v==null?`${stepPrefixOf(g,oneTask,refs)}登记 —（缺失）`:`${stepPrefixOf(g,oneTask,refs)}登记 ${fmtBytes(g.v)}`,
   title:`${g.labs.join(' / ')}：${g.v==null?'登记缺字节数，无从比较，不判一致':`登记 ${g.v} B（${verNoteOf(g)}）${actBytes==null?'（尚未实测）':(g.v===actBytes?'= 实测（一致）':`≠ 实测 ${actBytes} B（不一致）`)}`}`,
  });
 }
 return regLines;
};
const sameAllOf=(refs,regsByVal)=>regsByVal.length===1&&regsByVal[0].v!=null&&refs.length>1
 ?`&#10;${refs.length} 条登记（${esc(refs.map(r=>regLabOf(r)).join(' / '))}）的版本标识完全一致（${esc(verListOf(regsByVal[0]))}），逐条核对确认同一历史版本后才合并展示共同登记值并标注登记数量`
 :regsByVal.length>1
  ?`&#10;${refs.length} 条登记存在 ${regsByVal.length} 个不同版本标识（${regsByVal.map(g=>esc(verListOf(g))).join('、')}），逐条如实分列，不合并`
  :'';
// F01（第 10 轮）：登记身份 = 原始字节数 + 版本标识 + 登记时间，三者全等才算「相同登记」
const regVerKeyOf=(r)=>versionKeyOf(r.f);
const regIdentKeyOf=(r)=>`${r.f&&r.f.bytes!=null&&Number.isFinite(r.f.bytes)?r.f.bytes:'null'}|${regVerKeyOf(r)}|${r.meta.at||''}`;
const sameRegsOf=(refs)=>refs.length<2||refs.every((r)=>regIdentKeyOf(r)===regIdentKeyOf(refs[0]));
// 190px 列 / 12px Segoe UI 实测：「指纹」标签+8位+跨日时间=210px 必截断；
// 行内改紧凑格式（6 位指纹短显、KB 去空格），最坏 173px 装得下；完整 sha256 与字节数在 title。
const verShortOf=(vk)=>vk&&vk.startsWith('sha:')?vk.slice(4,10):'';
const regTimeLabOf=(r)=>r.meta.at?fmtTime(r.meta.at):'时间 —';
// F01（第 14 轮）：完整日期时间（YYYY-MM-DD HH:mm）——fmtTime 只到「月/日 时:分」，
// 任务书要求登记行第二行给完整日期；physButton 聚合行与 fileButton 分行态共用。
const fmtFullOf=(iso)=>{
 if(!iso)return '时间 —';
 const d=new Date(iso);if(isNaN(d.getTime()))return '时间 —';
 const p=(n)=>String(n).padStart(2,'0');
 return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
// F01（第 14 轮）：版本编号——同一物理文件的全部登记按登记时间升序稳定编号 V1..Vn，
// 聚合行（physButton）与分行态（fileButton regRows）同源，编号口径全库一致。
const vNumberOf=(refs)=>{
 const byTime=[...(refs||[])].sort((a,b)=>String(a.meta.at||'').localeCompare(String(b.meta.at||'')));
 const m=new Map();byTime.forEach((r,i)=>m.set(r,'V'+(i+1)));
 return m;
};
// 逐条登记行（分行态）：title 给全四要素（登记ID/原始字节数/版本标识/登记时间）与比对结论
// F01（第 14 轮）：t1/t2 与 physButton 聚合行统一口径——第一行「版本编号 · 字节数 · 8 位哈希前缀」，
// 第二行完整日期时间；vno 由调用方传入（vNumberOf 全文件登记统一编号），缺省回退步骤号。
const regRowOf=(r,chk,vno)=>{
 const b=r.f&&r.f.bytes;const hasB=b!=null&&Number.isFinite(b);
 const vk=regVerKeyOf(r);const hash8=vk&&vk.startsWith('sha:')?vk.slice(4,12):'';
 const hasChk=!!(chk&&chk.exists);
 const suf=!hasChk?'':(hasB?(b===chk.bytes?' ✓':' ≠'):'');
 // F01（第 12 轮起）：登记行统一分色口径——登记字节=磁盘实测 → 当前版本 #65D9B1；
 // 第 14 轮起实测已知但不等（历史版本）与不可核验（无实测或登记缺字节）同归差异警示 #E5B95E。
 const cls=!hasChk||!hasB?' lf-unver':(b===chk.bytes?' lf-cur':' lf-hist');
 return{
  cls,
  no:vno||String(r.meta.stepNo??'?').padStart(2,'0'),
  t1:`${hasB?`${b} B`:'— B'}·${hash8||'--------'}${suf}`,
  t2:fmtFullOf(r.meta.at),
  title:[
   `登记 ${r.meta.taskId} › ${String(r.meta.stepNo??'?').padStart(2,'0')} ${r.meta.stepName}（${r.meta.taskTitle}）`,
   `原始字节数 ${hasB?`${b} B（${fmtBytes(b)}）`:'—（缺失）'}`,
   `版本标识 ${vk&&vk!=='v:?'?vk:'—（无指纹）'}`,
   `登记时间 ${r.meta.at?`${r.meta.at}（${fmtTime(r.meta.at)}）`:'—'}`,
   hasChk?`实测 ${chk.bytes} B（${fmtBytes(chk.bytes)}）${hasB?(b===chk.bytes?'，与该条登记一致':'，与该条登记不一致'):''}`:'尚未实测，无实测可比对',
   '登记原文只读，不随当前文件元数据更新',
  ].join('\n'),
 };
};
// F01（第 10 轮·验证轮）：每条登记行的 data-regs = 登记原件的结构化投影
//（原始ID=需求›步骤、关联步骤、原始字节数、版本标识、登记时间、history 深度），
// 页面就地可查可比对——「查询两条登记记录并比对四要素」不再依赖翻悬停文案。
const regsDataAttrOf=(rs)=>esc(JSON.stringify(rs.map(r=>({id:`${r.meta.taskId}›${r.meta.stepKey}`,step:`${String(r.meta.stepNo??'?').padStart(2,'0')} ${r.meta.stepName}`,bytes:r.f&&r.f.bytes!=null?r.f.bytes:null,ver:regVerKeyOf(r),at:r.meta.at||null,history:Array.isArray(r.f&&r.f.history)?r.f.history.length:0}))));
// F01（第 12 轮）：单条登记的行自带登记身份（data-reg-vkey 等）——点哪条登记行就展示哪条登记
const regAttrsOf=(l)=>(l.regs&&l.regs.length===1)?` data-reg-vkey="${esc(regVerKeyOf(l.regs[0]))}" data-task-id="${esc(l.regs[0].meta.taskId)}" data-step-key="${esc(l.regs[0].meta.stepKey)}"`:'';
const lineHtmlOf=(l,refs)=>`<span class="lf-size lf-reg${l.cls||''}"${regAttrsOf(l)} data-regs="${regsDataAttrOf(l.regs||refs)}" title="${esc(l.title)}">${esc(l.t)}</span>`;
// F01（第 14 轮）：逐条登记行两行布局与 physButton 聚合行同构——第一行 lf-vl1
//（版本编号·字节数·8 位哈希前缀），第二行 lf-vtime（完整日期时间），11px 等宽/18px。
// 仅用于 regRows（登记分叉逐条分行的场景，如 F01 的 fixture-time.md），汇总行/身份行仍走 lineHtmlOf。
const vRowHtmlOf=(l,refs)=>`<span class="lf-size lf-reg lf-vrow${l.cls||''}"${regAttrsOf(l)} data-regs="${regsDataAttrOf(l.regs||refs)}" title="${esc(l.title)}"><span class="lf-vl1"><b class="lf-vno">${esc(l.no)}</b><span>${esc(l.t1)}</span></span><span class="lf-vtime">${esc(l.t2)}</span></span>`;
// F01（第 10 轮·验证轮）：登记身份行——两种场景可见地证明登记逐条读取：
// ① 汇总（同版本同刻的多条登记）：×N 行下补「步骤并排 同版 指纹 登记时间」；
// ② 同一路径版本分叉（multiVersion）：每个版本行各带自己的「步骤·指纹·登记时间」，
//    不同版本的登记身份在元信息区直接可对照，不全挤在 title 里。
const idLineOf=(rs,sameVer)=>({
 t:sameVer
  ?`${[...new Set(rs.map(r=>String(r.meta.stepNo??'?').padStart(2,'0')))].join('·')} 同版 ${verShortOf(regVerKeyOf(rs[0]))||'按字节'} ${regTimeLabOf(rs[0])}`
  :`${String(rs[0].meta.stepNo??'?').padStart(2,'0')} ${rs[0].f&&rs[0].f.bytes!=null&&Number.isFinite(rs[0].f.bytes)?fmtBytes(rs[0].f.bytes).replace(' ',''):'—'}·${verShortOf(regVerKeyOf(rs[0]))||'—'}·${regTimeLabOf(rs[0])}`,
 title:`${rs.map(r=>`${r.meta.taskId}›${r.meta.stepKey}：${regVerKeyOf(r)||'无版本标识'} · ${r.f&&r.f.bytes!=null?r.f.bytes+' B':'登记字节 —'} · ${r.meta.at||'时间 —'}${Array.isArray(r.f&&r.f.history)&&r.f.history.length?` · 历史 ${r.f.history.length} 版留存`:''}`).join('\n')}${sameVer?`：${rs.length} 条登记的原始字节数、版本标识与登记时间逐条比对完全一致，才汇总为共同登记值（×${rs.length}）`:'：本行登记的独立身份，与同一路径其他版本行各自核对'}`,
 regs:rs.slice(),
});
// 身份行不进 dual 内部：dual 是标签+双行的行布局，标签会占掉约 76px，行列表只剩 ~106px，
// 「02·03 同版 …」身份行放里面必截断——放 dual 外面吃整列 190px（实测 146–176px 装得下）。
const dualOf=(tag,st,regLinesHtml,refs)=>`<span class="lf-dual">${tag}<span class="lf-lines" data-regs="${regsDataAttrOf(refs)}"><span class="lf-size" title="当前物理文件实测 ${esc(String(st.chk.bytes))} B（实测只进这一行，不回写登记原文）">实测 ${esc(fmtBytes(st.chk.bytes))}</span>${regLinesHtml}</span></span>`;

/* ================= F01（第 73 轮）：不可校验状态的原因说明 =================
   异常行只加一行只读说明（.lf-reason 12px/18px #E8A4A7 最多 2 行），不新增操作入口。
   文案映射后端真实错误码（file-check 的 errCode）：已知分类给准确文案，
   未知码/缺码走统一错误说明——不猜原因、不拿猜测冒充实测。 */
const UNREASON_KNOWN={
 ENOENT:'文件已删除或移走（ENOENT：登记路径当前不存在）',
 EACCES:'权限拒绝（EACCES：进程无权访问该路径）',
 EPERM:'权限拒绝（EPERM：系统不允许访问该路径）',
 EISDIR:'登记路径是目录不是文件（EISDIR），无法当产物校验',
};
function unreasonOf(code){
 if(code&&UNREASON_KNOWN[code])return UNREASON_KNOWN[code];
 if(code)return `后端返回错误码 ${code}，未收录进已知分类，按不可校验处理`;
 return '后端未返回可识别的错误码，按不可校验处理';
}
// mism（大小不一致）的原因行：实测与登记的差异事实，来自实测快照与登记原文，不引用错误码
const mismReasonOf=(st)=>st.chk&&Number.isFinite(st.chk.bytes)
 ?`实测 ${st.chk.bytes} B 与登记版本不符（大小不一致，内容已变化）`
 :null;

// F02（R14 评审·R11 重复登记）：一行 = 一个物理实体（physKey × 版本），不再是一条登记。
// ent.refs = 同一物理文件同一版本的全部登记；taskId 给定时只列该需求的引用（多需求共用同一文件时每组各显示一行）。
// G02 拆分：登记核对逐条逻辑已收进上方纯函数，本函数只留六态判定与行装配，输出逐字不变。
function fileButton(ent, taskId){
 const refs=taskId?ent.refs.filter(r=>r.meta.taskId===taskId):ent.refs;
 const reg=refs[0]||ent.refs[0];
 if(!reg)return '';
 const meta=reg.meta, f=reg.f;
 // TASK-R11/F01/F02/F03：一行 64px = 图标 + 文件名/来源路径 + 右侧 240px 元信息（大小/执行者/来源类型）+ 140px 操作区。
 // F02：校验六态——一致 / 尚未实测 / 无法校验 / 大小不一致 / 登记缺失未知 / 历史版本（与预览抽屉同一判定函数）
 // F02（第 8 轮）：190px 元信息列里异常/未知态 = 标签 + 双行「实测/登记」（12px/18px），
 // 实测值与工作台/抽屉同源同舍入；登记行只读登记原文（多条登记各有大小时逐一列出），不改不覆盖。
 // 正常态实测值用完成绿。登记值缺失只标未知，绝不判一致。
 const st=entityCheckState(ent.pk,ent);
 // F01：登记行按真实登记逐条归属——多条登记大小不同时各自标注来源步骤，不把两条历史值
 // 合并成一个虚构值；title 逐条给核对结论（哪条登记与实测不同），登记ID = 需求 › 步骤。
 const actB=st.chk&&st.chk.exists?fmtBytes(st.chk.bytes):null;
 const refNotes=refNotesOf(ent,st.chk,actB);
 const oneTask=oneTaskOf(ent);
 const stepsByBytes=stepsByBytesOf(ent);
 const regLine=regLineOf(st,oneTask,stepsByBytes);
 // F01（第 4 轮）：登记值不再合并成一个无主数字。本行登记逐条按原始字节数分组：
 // 全部登记字节完全一致 → 才允许合并显示共同登记值，且必须标注登记数量（×N）；
 // 存在不同登记大小 → 逐条分列真实登记值 + 来源步骤号，不平均、不取首条冒充。
 // 与实测的差异逐条按原始字节数比较（不比较四舍五入后的 KB 文案），登记原文永不回写实测值。
 const actBytes=st.chk&&st.chk.exists?st.chk.bytes:null;
 const regsByVal=regsByValOf(refs);
 const regLines=regLinesOf(refs,regsByVal,actBytes,oneTask);
 const sameAll=sameAllOf(refs,regsByVal);
 // F01（第 10 轮）：登记身份任一不同（字节/版本标识/时间）→ 190px 元信息区逐条分行（lf-multi 96px），
 // 分行读的永远是登记原文（r.f / r.meta），不用当前文件元数据覆盖历史快照。
 const sameRegs=sameRegsOf(refs);
 const vnoMap=vNumberOf(ent.refs);
 const regRows=!sameRegs?refs.map((r)=>({...regRowOf(r,st.chk,vnoMap.get(r)),regs:[r]})):null;
 const regRowLines=regRows?`<span class="lf-lines" data-regs="${regsDataAttrOf(refs)}">${regRows.map(l=>vRowHtmlOf(l,refs)).join('')}</span>`:'';
 const showAggId=refs.length>1&&sameRegs;          // 汇总身份行：登记完全一致时
 const showVerId=!!st.multiVersion;                // 版本分叉身份行：同一路径存在多个登记版本
 const idLine=showAggId?idLineOf(refs,true):showVerId?idLineOf(refs.slice(0,1),false):null;
 const idLineHtml=idLine?lineHtmlOf(idLine,refs):'';
 const regLinesHtml=regLines.map((l)=>lineHtmlOf(l,refs));
 const dual=(tag)=>dualOf(tag,st,regLinesHtml,refs);
 let size;
 if(regRows) size=regRowLines;
 else if(st.code==='unchecked') size=refs.length>1
  ?`<span class="lf-lines" data-regs="${regsDataAttrOf(refs)}">${regLinesHtml}${showAggId?idLineHtml:''}</span>`
  :`<span class="lf-size" title="尚未实测，显示登记值">${esc(fmtBytes(f.bytes))}（登记）</span>${showVerId?idLineHtml:''}`;
 else if(st.code==='unreadable') size=`<i class="lf-tag unver" title="文件当前不可读（不存在或无法访问）；登记信息保持原样，不推断为已丢失">无法校验</i>${showVerId||showAggId?idLineHtml:''}`;
 else if(st.code==='hist') size=`<i class="lf-tag hist" title="登记 ${esc(regLine||'—')} 与实测 ${esc(fmtBytes(st.chk.bytes))} 不同；同一路径下另有版本与磁盘当前内容一致，按历史版本保留身份">历史版本</i>${showVerId||showAggId?idLineHtml:''}`;
 else if(st.code==='mism') size=dual(`<i class="lf-tag mism" title="实测 ${esc(fmtBytes(st.chk.bytes))} · 逐条核对：&#10;${esc(refNotes)}${sameAll}&#10;每条登记各比各的登记大小；登记原文保留、不自动更新，点开预览可「重新校验」${st.multiVersion?'；同一路径存在多个登记版本':''}">大小不一致</i>`)+(idLineHtml||'');
 else if(st.code==='unknown') size=dual(`<i class="lf-tag unver" title="登记值缺失，无法与实测大小比较，按未知处理，不判定为一致${refNotes?`；&#10;${esc(refNotes)}`:''}">登记缺失</i>`)+(idLineHtml||'');
 else size=refs.length>1
  ?`<span class="lf-lines" data-regs="${regsDataAttrOf(refs)}"><span class="lf-size ok" title="实测与每条登记的大小都一致${refNotes?`；&#10;${esc(refNotes)}`:''}">✓ ${esc(fmtBytes(st.chk.bytes))}</span>${showAggId?idLineHtml:''}</span>`
  :`<span class="lf-size ok" title="实测与每条登记的大小都一致${refNotes?`；&#10;${esc(refNotes)}`:''}">✓ ${esc(fmtBytes(st.chk.bytes))}</span>${showVerId?idLineHtml:''}`;
 const miss=st.code==='unreadable';
 // F01（第 73 轮）：异常态原因行——不可读走 errCode 映射，大小不一致给实测对登记的事实；
 // 正常态/未知态不加行（未知态缺的是登记数据，不是后端错误）。
 const reasonHtml=miss
  ?`<small class="lf-reason">${esc(unreasonOf(st.chk&&st.chk.errCode))}</small>`
  :(st.code==='mism'&&mismReasonOf(st)?`<small class="lf-reason">${esc(mismReasonOf(st))}</small>`:'');
 const name=normPath(f.path).split('/').pop();
 const srcPath=normPath(f.path)+(refs.length>1?` · ${refs.length} 处登记`:'');
 // F03：执行者一栏只放真实角色名或「—」；来源类型（Agent生成/人工创建/历史归档）独立成标签，
 // 未知执行者用 #8996A8 弱化，「归档迁移」不再冒充 Agent 身份
 const sem=fileSourceSemantics(meta&&meta.by);
 const executor=`<span class="lf-exec${sem.executorKnown?'':' na'}">${esc(sem.executor)}</span>`;
 const typeTag=sem.sourceType?`<i class="lf-type">${esc(sem.sourceType)}</i>`:'';
 const locate=meta?`<button type="button" class="lf-locate" data-goto="${esc(meta.taskId)}|${esc(meta.stepKey)}" title="回到 ${esc(meta.taskTitle)} 的步骤 ${String(meta.stepNo??'').padStart(2,'0')} ${esc(meta.stepName)}">定位到步骤</button>`:'';
 // title 逐条列出引用登记（需求 › 步骤），多重引用一目了然；\n 在属性值里原样换行
 // F01（第 5 轮）：每条登记补登记字节原文与登记时间——悬停即可分别核对两条记录
 const titleParts=[f.path,...refs.map(r=>`${r.meta.taskTitle} › ${String(r.meta.stepNo??'').padStart(2,'0')} ${r.meta.stepName}${r.meta.by?`（${r.meta.by}）`:''} · 登记 ${r.f&&r.f.bytes!=null?r.f.bytes+' B':'—（缺失）'} · ${r.meta.at?fmtTime(r.meta.at):'登记时间 —'}`)];
 if(miss)titleParts.push('文件当前不可读');
 // F04：整行单击即预览（行上挂 data-open-file；行内导航类按钮由委托层闸门保护），「预览」按钮保留
 // F02：data-vkey 带上版本身份——同一路径版本分叉后点开抽屉不串版本
 // F01（第 10 轮·验证轮）：执行者与来源类型并为单行（.lf-row，18px）——此前两行叠放占 42px，
 // 汇总身份行加入后 190px 列在 96px 行高里装不下；分行态（lf-multi）该行移入文件名列，
 // 元信息列整列让给登记行。data-regs 同时挂在行根上（容器级查询口）。
 const whoRow=`<span class="lf-row">${executor}${typeTag}</span>`;
 return `<div class="library-file${miss?' miss':''}${regRows?' lf-multi':''}" data-open-file="${esc(f.path)}" data-vkey="${esc(ent.vk)}"${refs.length>1||st.multiVersion?` data-regs="${regsDataAttrOf(refs)}"`:''}${meta?` data-task-id="${esc(meta.taskId)}" data-step-key="${esc(meta.stepKey)}"`:''} title="${esc(titleParts.join('\n'))}">
  <span class="lf-c1">${iconPNG(miss?'warning':'folder',24)}<span class="lf-main"><span class="lf-name">${esc(name)}</span><small class="lf-src">${esc(srcPath)}</small>${regRows?whoRow:''}</span></span>
  <span class="lf-meta">${size}${reasonHtml}${regRows?'':whoRow}</span>
  <span class="lf-actions">${locate}<button type="button" class="lf-preview" data-open-file="${esc(f.path)}" data-vkey="${esc(ent.vk)}"${meta?` data-task-id="${esc(meta.taskId)}" data-step-key="${esc(meta.stepKey)}"`:''}>预览</button></span>
 </div>`;
}

// F01（第 12 轮）：物理文件主行——聚合键 = 需求ID + 规范化绝对路径（physKey）。
// 同一路径登记过多个版本时不再各占一行：主行唯一，该需求的全部登记在主行内部纵向展开
//（lf-vers：当前版本行 #65D9B1，历史版本行 #AFC0D5·12px/18px·行高24px·间距4px）。
// 当前版本 = 登记字节与磁盘实测一致的登记；其余为历史版本（登记时间倒序）。
// 每条登记行带独立登记身份（登记ID=需求›步骤 / 原始字节 / 内容指纹 / 登记时间，逐条读登记原文，
// 磁盘现状只用于分色与 ✓/≠ 结论，绝不回写覆盖），data-reg-vkey 支持点行即查该条登记。
// 单一版本的物理文件完全沿用 fileButton（聚合口径天然一致，其余分组零改动）。
function physButton(taskId, pk){
 const entMap=fileEntitiesByPath.get(pk);
 const ents=entMap?[...entMap.values()].filter(e=>!e.dead):[];
 if(!ents.length)return '';
 if(entMap.size<=1)return fileButton(ents[0],taskId);
 const regs=[];
 for(const e of ents)for(const r of e.refs)if(r.meta.taskId===taskId)regs.push(r);
 if(!regs.length)return '';
 const chkRaw=fileStatus.get(pk)||null;
 const miss=!!(chkRaw&&!chkRaw.exists);
 const chk=chkRaw&&chkRaw.exists?chkRaw:null;
 const actB=chk?fmtBytes(chk.bytes):null;
 const verKey=(r)=>versionKeyOf(r.f);
 const verShort=(vk)=>vk&&vk.startsWith('sha:')?vk.slice(4,10):'';
 const regTimeLab=(r)=>r.meta.at?fmtTime(r.meta.at):'时间 —';
 const cur=chk?regs.filter(r=>r.f&&r.f.bytes!=null&&Number.isFinite(r.f.bytes)&&r.f.bytes===chk.bytes):[];
 const hist=regs.filter(r=>!cur.includes(r));
 hist.sort((a,b)=>String(b.meta.at||'').localeCompare(String(a.meta.at||'')));
 const ordered=[...cur,...hist];
 const regProj=(r)=>({id:`${r.meta.taskId}›${r.meta.stepKey}`,step:`${String(r.meta.stepNo??'?').padStart(2,'0')} ${r.meta.stepName}`,bytes:r.f&&r.f.bytes!=null?r.f.bytes:null,ver:verKey(r),at:r.meta.at||null,history:Array.isArray(r.f&&r.f.history)?r.f.history.length:0});
 // F01（第 14 轮）：版本编号与完整时间用模块级共享纯函数（vNumberOf/fmtFullOf），
 // 与 fileButton 分行态同源，编号口径全库一致。
 const vnoOf=vNumberOf(regs);
 const lineOf=(r)=>{
  const isCur=cur.includes(r);
  const b=r.f&&r.f.bytes;const hasB=b!=null&&Number.isFinite(b);
  const vk=verKey(r);const hash8=vk&&vk.startsWith('sha:')?vk.slice(4,12):'';
  const suf=!chk?'':(hasB?(isCur?' ✓':' ≠'):'');
  // F01（第 14 轮）：分色——有效（当前）版本 #65D9B1；差异状态（历史不等 / 不可核验）#E5B95E
  //（r13 的历史档 #B3C0D2 按本轮规格归入差异警示色；不可核验=无实测可比对或登记缺字节数）。
  const cls=!chk||!hasB?' lf-unver':(isCur?' lf-cur':' lf-hist');
  const verdict=isCur
   ?`当前版本：登记 ${hasB?`${b} B（${fmtBytes(b)}）`:'—'} = 实测 ${chk.bytes} B（${actB}），一致`
   :(chk?`历史版本：登记 ${hasB?`${b} B（${fmtBytes(b)}）`:'—'} ≠ 实测 ${chk.bytes} B（${actB}）；登记原文保留，不随当前文件覆盖`:'尚未实测，无实测可比对');
  // F01（第 14 轮）：登记行独立两行——第一行「版本编号 · 字节数 · 8位哈希前缀」（11px 等宽/18px），
  // 第二行完整日期时间（12px/18px）；点击身份（data-reg-vkey 等）与 title 四要素全部保留，不合并登记。
  return `<span class="lf-size lf-reg lf-vrow${cls}" data-reg-vkey="${esc(vk)}" data-task-id="${esc(r.meta.taskId)}" data-step-key="${esc(r.meta.stepKey)}" data-regs="${esc(JSON.stringify([regProj(r)]))}" title="${esc([
   `登记 ${r.meta.taskId} › ${String(r.meta.stepNo??'?').padStart(2,'0')} ${r.meta.stepName}（${r.meta.taskTitle}）`,
   `原始字节数 ${hasB?`${b} B（${fmtBytes(b)}）`:'—（缺失）'}`,
   `版本标识 ${vk&&vk!=='v:?'?vk:'—（无指纹）'}`,
   `登记时间 ${r.meta.at?`${r.meta.at}（${fmtTime(r.meta.at)}）`:'—'}`,
   verdict,
   '登记原文只读，不随当前文件元数据更新',
  ].join('\n'))}"><span class="lf-vl1"><b class="lf-vno">${esc(vnoOf.get(r)||'V?')}</b><span class="lf-vb">${hasB?`${b} B`:'— B'}</span><span class="lf-vh">${hash8||'--------'}${suf}</span></span><span class="lf-vtime">${esc(fmtFullOf(r.meta.at))}</span></span>`;
 };
 const head=cur[0]||regs[0];
 const f=head.f, meta=head.meta;
 const name=normPath(f.path).split('/').pop();
 const srcPath=normPath(f.path)+` · ${regs.length} 处登记`;
 const sem=fileSourceSemantics(meta&&meta.by);
 const executor=`<span class="lf-exec${sem.executorKnown?'':' na'}">${esc(sem.executor)}</span>`;
 const typeTag=sem.sourceType?`<i class="lf-type">${esc(sem.sourceType)}</i>`:'';
 const whoRow=`<span class="lf-row">${executor}${typeTag}</span>`;
 const locate=meta?`<button type="button" class="lf-locate" data-goto="${esc(meta.taskId)}|${esc(meta.stepKey)}" title="回到 ${esc(meta.taskTitle)} 的步骤 ${String(meta.stepNo??'?').padStart(2,'0')} ${esc(meta.stepName)}">定位到步骤</button>`:'';
 const titleParts=[f.path,...ordered.map(r=>`${r.meta.taskTitle} › ${String(r.meta.stepNo??'?').padStart(2,'0')} ${r.meta.stepName}${r.meta.by?`（${r.meta.by}）`:''} · 登记 ${r.f&&r.f.bytes!=null?r.f.bytes+' B':'—（缺失）'} · ${r.meta.at?fmtTime(r.meta.at):'登记时间 —'}${cur.includes(r)?' · 当前版本':' · 历史版本'}`)];
 if(miss)titleParts.push('文件当前不可读');
 const regsAttr=esc(JSON.stringify(ordered.map(regProj)));
 return `<div class="library-file lf-phys${miss?' miss':''}" data-open-file="${esc(f.path)}" data-vkey="${esc(verKey(head))}" data-regs="${regsAttr}" data-task-id="${esc(meta.taskId)}" data-step-key="${esc(meta.stepKey)}" title="${esc(titleParts.join('\n'))}">
  <span class="lf-c1">${iconPNG(miss?'warning':'folder',24)}<span class="lf-main"><span class="lf-name">${esc(name)}</span><small class="lf-src">${esc(srcPath)}</small>${whoRow}</span></span>
  <span class="lf-meta">${miss?`<small class="lf-reason">${esc(unreasonOf(chkRaw&&chkRaw.errCode))}</small>`:''}<span class="lf-lines lf-vers" data-regs="${regsAttr}">${ordered.map(lineOf).join('')}</span></span>
  <span class="lf-actions">${locate}<button type="button" class="lf-preview" data-open-file="${esc(f.path)}" data-vkey="${esc(verKey(head))}" data-task-id="${esc(meta.taskId)}" data-step-key="${esc(meta.stepKey)}">预览</button></span>
 </div>`;
}

// R9：筛选器选项的真实取值集合（从数据里长出来，不写死枚举冒充元数据）
function fileFilterOptions(vals, cur, allLabel){
 let h=`<option value="all"${cur==='all'?' selected':''}>${allLabel}</option>`;
 for(const v of [...new Set(vals.map(String))].sort())h+=`<option value="${esc(v)}"${v===cur?' selected':''}>${esc(v)}</option>`;
 return h;
}

/* ================= 文件库总渲染（G02 自 renderFiles 拆出，输出逐字不变） ================= */

function renderFiles(){
 // TASK-R4（评审 #1）/ TASK-R5（评审 #1）：三态——未读到 / 全部读取失败 / 真实数据。
 // 部分失败时计数只统计读到的任务，尾注说明另有多少项没统计进来，不冒充完整。
 if(!lastFlow){
  const failed=modErr.flow&&!modOkAt.flow;
  document.getElementById('file-count').textContent='— 个产物';
  document.getElementById('file-toolbar').hidden=true;
  document.getElementById('file-groups').innerHTML=`<div class="empty"><img src="assets/empty-files.png" alt="" width="160"><p>${failed?'需求流水线读取失败，文件清单暂不可用。<br>原因见顶部横幅。':'需求流水线读取中…<br>文件清单等首轮同步完成。'}</p></div>`;
  return;
 }
 const tasks=lastFlow.tasks||[],ferrs=lastFlow.errors||[];
 if(!tasks.length&&ferrs.length){
  document.getElementById('file-count').textContent='— 个产物';
  document.getElementById('file-toolbar').hidden=true;
  document.getElementById('file-groups').innerHTML=`<div class="empty"><img src="assets/empty-files.png" alt="" width="160"><p>${ferrs.length} 项需求档案全部读取失败，文件清单暂不可用。<br>原因见顶部横幅，可点「重试读取」。</p></div>`;
  return;
 }
 // 展开全部步骤的文件，带上溯源元数据（需求 > 步骤 > 文件）——G02 拆分：实体构建收进
 // version.js 的 buildFileEntities（每次渲染先重建三张索引 Map），口径与注释见彼处。
 const {entries,ents,physUnits}=buildFileEntities(tasks);
 renderFileToolbar(tasks,ents);
 const shownUnits=filterShownUnits(ents,physUnits,tasks);
 const total=physUnits.length;   // 顶部总量按物理文件去重口径
 const filtered=shownUnits.length;
 const totalRegs=entries.length;   // 原始登记条数——实体聚合只影响展示，不减少登记
 document.getElementById('file-count').textContent=ferrs.length
  ?`匹配 ${filtered} / ${total} 个产物${totalRegs>total?`（${totalRegs} 条登记）`:''} · 另有 ${ferrs.length} 项需求读取失败未统计`
  :`匹配 ${filtered} / ${total} 个产物${totalRegs>total?`（${totalRegs} 条登记）`:''}`;
 const html=fileGroupsHtml(tasks,shownUnits,physUnits,entries);
 // TASK-R3：缓存 key 必须带上核实版本 fileStatusVersion——
 // 只看 tasks 的话，重核出「文件不存在/字节变了」时任务数据没变，红标永远刷不进来。
 // TASK-R5：再加 ferrs.length；R9 再加全部筛选状态。
 renderChanged('file-groups',[tasks,fileStatusVersion,ferrs.length,fileQuery,fileTask,fileStep,fileType,fileAgent,fileSort,fileOnlyWith],()=>{
  const box=document.getElementById('file-groups');
  const states=new Map([...box.querySelectorAll('details')].map(e=>[e.dataset.group,e.open]));   // 换 DOM 前记下折叠态
  box.innerHTML=html||`<div class="empty"><img src="assets/empty-search.png" alt="" width="160"><p>没有匹配文件</p><button type="button" class="btn btn-secondary" data-clear-file-filters="1">清除筛选</button></div>`;
  for(const d of box.querySelectorAll('details')){if(states.get(d.dataset.group)===false)d.open=false;}   // 用户手动折叠的组不弹开
 });
}

// 工具栏：筛选下拉的选项来自真实数据；只看有产物默认开（空需求折叠成 52px 提示行）
function renderFileToolbar(tasks,ents){
 const tb=document.getElementById('file-toolbar');
 tb.hidden=false;
 const setOpt=(id,vals,allLabel,cur)=>{document.getElementById(id).innerHTML=fileFilterOptions(vals,cur||'all',allLabel);};
 setOpt('file-task',tasks.map(t=>t.title),'全部需求',fileTask);
 setOpt('file-step',[...new Set(ents.flatMap(e=>e.refs.map(r=>r.meta.stepName)))].filter(Boolean),'全部步骤',fileStep);
 setOpt('file-type',ents.map(e=>(normPath(e.refs[0].f.path).split('/').pop().split('.').pop()||'无扩展名').toLowerCase()),'全部类型',fileType);
 setOpt('file-agent',ents.flatMap(e=>e.refs.map(r=>r.meta.by)).filter(Boolean),'全部Agent',fileAgent);
 document.getElementById('file-search').value=fileQuery;
 document.getElementById('file-sort').value=fileSort;
 document.getElementById('file-only-toggle').checked=fileOnlyWith;
}

// 过滤 + 排序（recent = 需求最近更新优先）——F02：按实体筛，任一引用命中即命中；
// F01（第 12 轮）：实体级筛选结果按 physKey 归并成物理文件级展示单元——任一版本命中即整文件命中
function filterShownUnits(ents,physUnits,tasks){
 const q=fileQuery.trim().toLowerCase();
 const shown=ents.filter(e=>{
  const f=e.refs[0].f;
  if(q&&!(normPath(f.path).toLowerCase().includes(q)||normPath(f.path).split('/').pop().toLowerCase().includes(q)))return false;
  if(fileTask!=='all'){const t=tasks.find(x=>x.title===fileTask);if(!t||!e.refs.some(r=>r.meta.taskId===t.id))return false;}
  if(fileStep!=='all'&&!e.refs.some(r=>r.meta.stepName===fileStep))return false;
  if(fileType!=='all'&&(normPath(f.path).split('/').pop().split('.').pop()||'无扩展名').toLowerCase()!==fileType)return false;
  if(fileAgent!=='all'&&!e.refs.some(r=>r.meta.by===fileAgent))return false;
  return true;
 });
 const shownPk=new Set(shown.map(e=>e.pk));
 const shownUnits=physUnits.filter(u=>shownPk.has(u.pk));
 if(fileSort==='name')shownUnits.sort((a,b)=>normPath(a.first.f.path).split('/').pop().localeCompare(normPath(b.first.f.path).split('/').pop(),'zh'));
 else if(fileSort==='demand')shownUnits.sort((a,b)=>a.first.meta.taskId.localeCompare(b.first.meta.taskId)||String(a.first.meta.stepNo??0).localeCompare(String(b.first.meta.stepNo??0)));
 else shownUnits.sort((a,b)=>b.updatedAt-a.updatedAt);
 return shownUnits;
}

// 分组渲染：只看有产物（默认开）时空需求折叠成 52px 行；被筛掉的组如实计数
// F02：被多个需求引用的实体在每个引用组里各出现一行；组计数 = 实体数，登记条数另注
function fileGroupsHtml(tasks,shownUnits,physUnits,entries){
 const q=fileQuery.trim().toLowerCase();
 const byTask=new Map(tasks.map(t=>[t.id,{t,rows:[]}]));
 for(const u of shownUnits){
  const seen=new Set();
  for(const e of u.ents)for(const r of e.refs){
   if(seen.has(r.meta.taskId))continue;seen.add(r.meta.taskId);
   const g=byTask.get(r.meta.taskId);if(g&&!g.rows.includes(u))g.rows.push(u);
  }
 }
 const groups=[...byTask.values()];
 const hasFilter=q||fileTask!=='all'||fileStep!=='all'||fileType!=='all'||fileAgent!=='all';
 return groups.map(({t,rows})=>{
  const all=physUnits.filter(u=>u.ents.some(e=>e.refs.some(r=>r.meta.taskId===t.id))).length;   // F01（第 12 轮）：组计数同样按物理文件去重
  if(!all){
   // 「只看有产物」开（默认）：空需求整组不占位；关：折叠成 52px 提示行，给一条
   // 跳回当前步骤的直达链接（跳过去干什么：看这需求到底走到哪一步了）
   if(fileOnlyWith||hasFilter)return '';
   const cur=(t.steps||[]).find(s=>['awaiting','running','failed'].includes(s.status))||(t.steps||[])[0];
   return `<div class="filegroup-flat" data-group="${esc(t.id)}"><span class="ff-title">${esc(t.title)}</span>${cur?`<button type="button" class="ff-link" data-goto="${esc(t.id)}|${esc(cur.key)}">暂无登记产物 · 查看该需求的当前步骤</button>`:'<span class="ff-note">暂无登记产物</span>'}</div>`;
  }
  const allRegs=entries.filter(r=>r.meta.taskId===t.id).length;
  const inner=rows.map(u=>physButton(t.id,u.pk)).join('')
    ||`<div class="ff-none">这组文件被当前筛选条件排除 <button type="button" class="lf-locate" data-clear-file-filters="1">清除筛选</button></div>`;
  return `<details class="filegroup" data-group="${esc(t.id)}" open><summary>${esc(t.title)} · ${rows.length}${rows.length!==all?`/${all}`:''} 个产物${allRegs>all?`（${allRegs} 条登记）`:''}</summary>${inner}</details>`;
 }).join('');
}

// 筛选状态变更：写回模块变量（不是新建对象）→ 落 office.ui.v2 → 重渲染
function bindFileToolbar(){
 const on=(id,ev,fn)=>document.getElementById(id).addEventListener(ev,fn);
 on('file-search','input',e=>{fileQuery=e.target.value;saveUiPos();renderFiles();});
 on('file-task','change',e=>{fileTask=e.target.value;saveUiPos();renderFiles();});
 on('file-step','change',e=>{fileStep=e.target.value;saveUiPos();renderFiles();});
 on('file-type','change',e=>{fileType=e.target.value;saveUiPos();renderFiles();});
 on('file-agent','change',e=>{fileAgent=e.target.value;saveUiPos();renderFiles();});
 on('file-sort','change',e=>{fileSort=e.target.value;saveUiPos();renderFiles();});
 on('file-only-toggle','change',e=>{fileOnlyWith=e.target.checked;saveUiPos();renderFiles();});
}
bindFileToolbar();
