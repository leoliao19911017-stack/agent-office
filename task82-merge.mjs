import fs from 'node:fs';
const target='web/index.html';
let h=fs.readFileSync(target,'utf8');
const preview=fs.readFileSync('C:/Users/Administrator/AppData/Local/Temp/leo-office-design/web/design-preview.html','utf8');
const icons=JSON.parse(preview.match(/,ICONS=(\{[^\n]+\});/)[1]);
fs.mkdirSync('docs/task-8.2',{recursive:true});
fs.writeFileSync('docs/task-8.2/index-before.html',h);
const css=`
/* TASK-8.2: semantic colors. Amber #E0B341 = Leo decision ONLY;
   blue #5B8FF9 = selected requirement / step / Agent / navigation;
   green #6FD3A0 = completed / online; red #E4685D = failed / broken / missing;
   gray #66748A = pending / waiting. */
:root { --agent-h:320px; --ink-muted:var(--muted); --ink-green:var(--green); --ink-blue:var(--blue); --ink-red:var(--red); }
html,body {height:100%;overflow:hidden}
body.agent-open #frame {flex:none;height:calc(100dvh - var(--topbar-h) - var(--statusbar-h) - min(var(--agent-h),60dvh));}
#agent-drawer {top:auto;left:0;right:0;bottom:var(--statusbar-h);width:100%;max-width:none;height:min(var(--agent-h),60dvh);box-shadow:none;border-top:1px solid var(--line);}
#agent-grip {height:14px;flex:none;cursor:ns-resize;touch-action:none;display:grid;place-items:center}
#agent-grip:before {content:'';width:42px;height:3px;border-radius:3px;background:var(--muted)}
#ad-list {display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;align-content:start;}
.ad-agent {background:var(--bg);border:1px solid var(--line);min-height:76px;margin:0}
.ad-agent.sel {border:1px solid var(--blue)}
.ad-ava {width:40px;height:40px;padding:2px;background:var(--card);border:1px solid var(--line);border-radius:10px;filter:saturate(.85)}
#ad-detail {position:static;transform:none;width:auto;display:none;flex:1;min-height:0}
#ad-detail.open {display:flex}
#agent-drawer:has(#ad-detail.open) #ad-list {flex:0 0 100px}
#add-body {display:flex;gap:32px;padding:10px 18px;overflow:auto}
.add-sec {min-width:200px}
#inspector {background:var(--panel);color:var(--text)}
.insp-head,.insp-empty,.ip-step,.ip-time,.ip-none,.ip-sec>h4,.ip-link .arr {color:var(--muted)}
.ip-name {background:var(--paper);color:#20211C;min-height:48px;max-height:56px;padding:8px 10px;border-radius:4px;flex-wrap:nowrap;font-size:14px}
.ip-note,.ip-link .ln {color:var(--text)}
.ip-sec>h4,.ip-file,.insp-head {border-color:var(--line)}
.step-card.sel {background:var(--card);border:1px solid var(--blue);box-shadow:none;color:var(--text)}
.step-card.sel .sc-title {color:var(--text)}
.step-card.sel .sc-row2 {color:var(--muted)}
.cols {grid-template-columns:repeat(2,minmax(0,1fr))}
.col {display:contents}
.step-card {padding:14px;min-height:84px}
.step-card:not(.sel) {border-color:var(--line)}
.step-card.st-awaiting {background:var(--panel);color:var(--text)}
.phase.cur {border-color:var(--blue)}
.s-awaiting .dot {background:var(--faint)}
.req-status.t-awaiting,.phase .p-count .c-wait,.ov-block,.ov-cell.k-wait,.ip-link .ls.k-awaiting {color:var(--muted)}
.rail-item[aria-current=page],.rail-item.selected {color:var(--blue);border-color:var(--blue);background:#1c2532}
#rail .rail-spacer {display:none}
#rail-focus {margin-top:auto}
svg {stroke-width:1.6;stroke-linecap:round}
#hub {flex:1;min-height:0;overflow:auto;padding:12px 20px}
#hub[hidden] {display:none}
.hubtools,.pagination {display:flex;align-items:center;gap:12px;margin-bottom:12px}
.hubtools input {background:var(--bg);color:var(--text);border:1px solid var(--line);padding:7px;border-radius:6px}
.hubtools button,.pagination button {background:var(--card);color:var(--text);border:1px solid var(--line);padding:6px 12px;border-radius:6px;cursor:pointer}
.pagination {justify-content:space-between;margin-top:10px}
.skill-row {display:block;width:100%;text-align:left;background:var(--bg);color:var(--text);padding:9px 12px;border:1px solid var(--line);border-radius:6px;cursor:pointer}
.skill-row.selected {border-color:var(--blue)}
.skill-row small {display:block;color:var(--muted);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.hubgrid {display:grid;grid-template-columns:1.4fr 1fr;gap:20px}
.skilldetail {color:var(--text);overflow-wrap:anywhere}
.filegroup summary {padding:10px 0;cursor:pointer}
.library-file {display:flex;gap:12px;align-items:center;width:100%;padding:10px;background:var(--bg);color:var(--text);border:1px solid var(--line);text-align:left;cursor:pointer}
.library-file svg {width:20px;height:20px}.library-file small {margin-left:auto;color:var(--muted)}
@media(max-width:1280px){body.agent-open #inspector,body.agent-open #reqs {bottom:calc(var(--statusbar-h) + min(var(--agent-h),60dvh))}}
`;
h=h.replace('</style>',css+'\n</style>');
h=h.replace(' sel on-paper',' sel').replace('<div class="on-paper">','<div class="inspector-content">');
h=h.replace('<div class="rail-item" aria-current="page" title="工作台（当前页）">','<button id="rail-reqs" class="rail-item" aria-current="page" title="需求">').replace('<span>工作台</span>\n    </div>','<span>需求</span>\n    </button>');
h=h.replace('<button id="rail-focus"', '<button id="rail-skills" class="rail-item" type="button"><span>技能</span></button><button id="rail-files" class="rail-item" type="button"><span>文件</span></button>\n    <button id="rail-focus"');
h=h.replace('<div class="ad-bar">','<div id="agent-grip" role="separator" tabindex="0" aria-label="调整抽屉高度" aria-orientation="horizontal"></div>\n  <div class="ad-bar">');
h=h.replace('<div id="ad-list"></div>','<div id="hub" hidden></div><div id="ad-list"></div>');
h=h.replace("const [sR, hR, fR]", "const [sR, hR, fR, kR]").replace("api('/api/office/flow'),","api('/api/office/flow'),\n    api('/api/office/skills'),");
h=h.replace('  renderAll();\n}',"  if(kR.status==='fulfilled') skillsData=kR.value.skills || [];\n  renderAll();\n  if(agentUI.open && drawerMode!=='agents') renderHub();\n}");
h=h.replace("if (agentUI.open) withScroll(document.getElementById('ad-list'), renderAgentDrawer);","if (agentUI.open && drawerMode==='agents') { withScroll(document.getElementById('ad-list'), renderAgentList); withScroll(document.getElementById('add-body'), renderAgentDetail); }");
h=h.replace('  agentUI.open = true;',"  drawerMode='agents';\n  setDrawerMode();\n  agentUI.open = true;");
h=h.replace('  agentUI.open = false;',"  document.body.classList.remove('agent-open');\n  setNav('reqs');\n  agentUI.open = false;");
h=h.replace("    renderInspector();   //", "    withScroll(document.getElementById('insp-body'), renderInspector);   //");
h=h.replace('/* ================= 启动 ================= */', `
/* Merged from TASK-8.1 design: all 20 inline icon definitions. */
const ICONS=${JSON.stringify(icons)};
const icon=n=>\`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">\${ICONS[n]||ICONS.file}</svg>\`;
let drawerMode='agents',skillsData=[],skillPage=0,skillQuery='',skillSelected=null,hubFingerprint='';
function setNav(mode){document.querySelectorAll('#rail .rail-item').forEach(e=>{e.classList.toggle('selected',e.id==='rail-'+mode);e.removeAttribute('aria-current')});document.getElementById('rail-'+mode)?.setAttribute('aria-current','page')}
function setDrawerMode(){document.body.classList.add('agent-open');setNav(drawerMode);document.getElementById('hub').hidden=drawerMode==='agents';document.getElementById('ad-list').style.display=drawerMode==='agents'?'grid':'none';document.getElementById('ad-detail').classList.remove('open');document.querySelector('.ad-bar b').textContent={agents:'Agents',skills:'Skill Hub',files:'文件库'}[drawerMode]}
function openHub(mode){drawerMode=mode;agentUI.open=true;setDrawerMode();document.getElementById('agent-drawer').classList.add('open');hubFingerprint='';renderHub()}
function renderHub(){
 const hub=document.getElementById('hub');
 const fingerprint=JSON.stringify([drawerMode,skillsData,lastFlow,skillPage,skillQuery,skillSelected]);
 if(fingerprint===hubFingerprint)return;hubFingerprint=fingerprint;
 const opened=new Set([...hub.querySelectorAll('details[open]')].map(e=>e.dataset.group));
 withScroll(hub,()=>{
 if(drawerMode==='skills'){
 const rows=skillsData.filter(s=>(s.name+' '+(s.description||'')).toLowerCase().includes(skillQuery.toLowerCase()));
 const pages=Math.max(1,Math.ceil(rows.length/8));skillPage=Math.min(skillPage,pages-1);
 const selected=rows.find(s=>s.name===skillSelected)||rows[0];
 document.getElementById('ad-count').textContent=skillsData.length+' 条';
 hub.innerHTML='<div class="hubtools"><input id="skill-search" aria-label="搜索技能" placeholder="搜索技能名称或用途" value="'+esc(skillQuery)+'"></div><div class="hubgrid"><div>'+rows.slice(skillPage*8,skillPage*8+8).map(s=>'<button class="skill-row '+(s===selected?'selected':'')+'" data-skill="'+esc(s.name)+'"><b>'+esc(s.name)+'</b><small>'+esc(s.description||'—')+'</small></button>').join('')+'<div class="pagination"><span>'+rows.length+' 条 · '+(skillPage+1)+' / '+pages+'</span><button data-page="-1" '+(skillPage===0?'disabled':'')+'>上一页</button><button data-page="1" '+(skillPage+1>=pages?'disabled':'')+'>下一页</button></div></div><aside class="skilldetail">'+(selected?'<h3>'+esc(selected.name)+'</h3><p>'+esc(selected.description||'—')+'</p><p>'+esc((selected.agents||[]).join(' · ')||'—')+'</p>':'—')+'</aside></div>';
 } else {
 let count=0;
 const groups=(lastFlow?.tasks||[]).map(t=>{const files=dedupFiles((t.steps||[]).flatMap(s=>s.files||[]));count+=files.length;return '<details class="filegroup" data-group="'+esc(t.id)+'" '+(opened.has(t.id)||!hub.children.length?'open':'')+'><summary>'+esc(t.title)+' · '+files.length+'</summary>'+files.map(f=>'<button class="library-file" data-open-file="'+esc(f.path)+'">'+icon('file')+'<span>'+esc(normPath(f.path).split('/').pop())+'</span><small>'+fmtBytes(f.bytes)+'</small></button>').join('')+(files.length?'':'<p>—</p>')+'</details>'}).join('');
 document.getElementById('ad-count').textContent=count+' 个文件';hub.innerHTML=groups||'—';
 }
 });
}
document.getElementById('hub').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.page){skillPage+=Number(b.dataset.page);renderHub()}if(b.dataset.skill){skillSelected=b.dataset.skill;renderHub()}});
document.getElementById('hub').addEventListener('input',e=>{if(e.target.id!=='skill-search')return;const pos=e.target.selectionStart;skillQuery=e.target.value;skillPage=0;renderHub();const input=document.getElementById('skill-search');input.focus();input.setSelectionRange(pos,pos)});
for(const [id,name] of Object.entries({'rail-reqs':'tasks','rail-agents':'agents','rail-skills':'skills','rail-files':'files','rail-focus':'focus','tb-search':'search','tb-settings':'settings','tb-reqs-toggle':'tasks','tb-insp-toggle':'detail'})){const el=document.getElementById(id);el.querySelector('svg')?.remove();el.insertAdjacentHTML('afterbegin',icon(name))}
document.getElementById('rail-reqs').onclick=()=>closeAgentDrawer();
document.getElementById('rail-skills').onclick=()=>openHub('skills');
document.getElementById('rail-files').onclick=()=>openHub('files');
const grip=document.getElementById('agent-grip');let drag=null;
function resizeAgent(h){const max=innerHeight*.6;const height=Math.min(max,Math.max(220,h));document.documentElement.style.setProperty('--agent-h',height+'px');grip.setAttribute('aria-valuemin','220');grip.setAttribute('aria-valuemax',Math.round(max));grip.setAttribute('aria-valuenow',Math.round(height))}
grip.onpointerdown=e=>{drag={y:e.clientY,h:document.getElementById('agent-drawer').offsetHeight};grip.setPointerCapture(e.pointerId)};
grip.onpointermove=e=>{if(drag)resizeAgent(drag.h+drag.y-e.clientY)};grip.onpointerup=grip.onpointercancel=()=>drag=null;
grip.onkeydown=e=>{if(['ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();resizeAgent(document.getElementById('agent-drawer').offsetHeight+(e.key==='ArrowUp'?20:-20))}};
/* ================= 启动 ================= */`);
fs.writeFileSync(target,h,'utf8');
console.log({bytes:fs.statSync(target).size,modified:fs.statSync(target).mtime,icons:Object.keys(icons)});
