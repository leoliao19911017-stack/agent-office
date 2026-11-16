// Rounded brush paths are drawn directly in a 20 × 20 coordinate space.
const ICONS={
 board:'M3.4 3.8Q10 3.1 16.7 3.9Q17.5 4 17.3 5Q16.9 10 17.4 16.3Q17.5 17.2 16.6 17Q10 16.6 3.5 17.2Q2.6 17.3 2.8 16.3Q3.3 10 2.8 4.8Q2.7 4 3.4 3.8ZM7.7 4Q7.3 10 7.7 17M12.3 4Q12.8 10 12.3 17M3 9Q5 8.8 7.6 9M7.7 13Q10 12.6 12.4 13M12.5 7Q15 7.3 17 7',
 agents:'M10.2 6Q10.7 9.2 7.4 9.5Q4.1 9.7 4.2 6.2Q4 3.1 7.1 3Q10 2.8 10.2 6ZM2.2 17Q2 11.6 7.2 11.4Q12.6 11.3 12.4 17M13 3.8Q17.6 3.5 17 7.2Q16.8 9 14.5 9.4M15 11.8Q18.8 12.8 18 17',
 skills:'M3 4Q6 2.5 10 4.8Q14 2.7 17.3 3.9Q16.9 9.8 17.3 16Q13.4 15 10 17Q6.5 15.1 2.7 16Q3.2 10 3 4ZM10 5Q9.7 11 10 17M5.5 7Q6.8 7 7.7 7.6M12.4 7.5Q13.7 6.9 15 7',
 folder:'M2.7 7Q2.6 5.4 3.1 4.5Q5.5 4 7.6 4.5Q8.7 5.5 9.7 6.6Q13.3 6.1 17 6.7Q17.7 6.8 17.4 8Q16.8 12 17.3 16.3Q10 15.8 2.7 16.4Q3.2 12 2.7 7Z',
 file:'M4.4 2.5Q8 2.1 12 2.6Q14.3 4.8 16 6.8Q15.5 11.5 16 17.3Q10 16.8 4 17.5Q4.5 10 4.4 2.5ZM12 3Q11.6 5.1 12 7Q14 7.3 16 6.8M7 10Q10 9.7 13 10M7 13.4Q10 13.1 12 13.4',
 search:'M14.1 8.7Q14.2 14.4 8.5 14.1Q2.9 14 3.2 8.5Q3 3 8.8 3.1Q14.3 3.2 14.1 8.7ZM13 13Q15.3 15.8 17.7 17.5',
 close:'M5 5Q9.6 10.4 15 15M15 5Q10.4 9.7 5 15',
 play:'M6 3.5Q12 6.4 16.5 10Q11.3 13.7 6 16.5Q6.4 10 6 3.5Z',
 settings:'M3 5Q10 5.5 17 5M3 10Q10 9.5 17 10M3 15Q10 15.5 17 15M7 3Q6.6 5 7 7M13 8Q13.3 10 13 12M8 13Q7.7 15 8 17'
};
const icon=n=>`<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[n]||ICONS.file}"/></svg>`;
let skillsData=[],skillPage=0,skillQuery='',skillSelected=null,skillFilter='all',activePage='workbench';
const fingerprints={};
function renderChanged(id,data,fn){const key=JSON.stringify(data);if(fingerprints[id]===key)return;fingerprints[id]=key;withScroll(document.getElementById(id),fn)}
function route(){
 const path=location.hash.slice(1)||'/';activePage=({'/':'workbench','/agents':'agents','/skills':'skills','/files':'files'})[path]||'workbench';
 document.body.dataset.page=activePage;
 for(const name of ['workbench','agents','skills','files'])document.getElementById('page-'+name).hidden=name!==activePage;
 for(const [id,name] of Object.entries({'rail-reqs':'workbench','rail-agents':'agents','rail-skills':'skills','rail-files':'files'})){
  const el=document.getElementById(id);if(name===activePage)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');
 }
 document.body.classList.remove('insp-open','reqs-open');syncToggleStates();
 document.title=({workbench:'工作台',agents:'Agents',skills:'技能',files:'文件'})[activePage]+" · Leo's Agent Office";
 document.getElementById('step-files').close();renderModules();
}
window.addEventListener('hashchange',route);
function money(n){return n==null?'未统计':'$'+Number(n).toFixed(2)}
function agentDetail(a){
 const t=a.totals||{},u=t.usage||{};
 const runs=(lastState?.runs||[]).filter(r=>r.agent===a.id).slice(0,8);
 return `<div class="agent-detail"><h4>当前状态</h4><div class="agent-kv"><span>${a.online?'在线':'离线'} · ${agentBusy(a)?'工作中':'空闲'}</span><span>${t.retrying||0} 重试中</span></div><div class="agent-kv"><span>最近心跳</span><span>${esc(fmtAgo(a.seenAt))}</span></div><h4>累计工作量</h4><div class="agent-kv"><span>已完成 ${t.done||0}</span><span>${fmtNum((u.input||0)+(u.output||0))} tokens</span></div><h4>最近 8 条执行记录</h4>${runs.length?runs.map(r=>`<div class="agent-run"><span class="st st-${r.state==='done'?'done':r.state==='failed'?'failed':'running'}">${esc(({done:'完成',failed:'失败',running:'执行中',claimed:'已领取',retrying:'重试'})[r.state]||r.state)}</span> ${esc(r.rule||'—')}<p>${esc(r.summary||'暂无执行摘要')}</p></div>`).join(''):'<p class="agent-role">最近没有执行记录</p>'}</div>`;
}
function renderAgents(){
 const agents=lastState?.agents||[], online=agents.filter(a=>a.online),busy=online.filter(agentBusy);
 document.getElementById('agent-summary').textContent=`${online.length} 个在线 · ${busy.length} 执行中 · ${online.length-busy.length} 空闲 · 今日花费 ${money(lastState?.spending?.today?.cost)}`;
 renderChanged('agent-grid',[agents,lastState?.runs,agentUI.selId],()=>{
 document.getElementById('agent-grid').innerHTML=agents.map(a=>{const t=a.totals||{},selected=a.id===agentUI.selId;return `<article class="agent-card ${selected?'selected':''}"><button class="agent-select" data-agent="${esc(a.id)}" aria-expanded="${selected}"><span class="agent-head"><img class="agent-avatar" src="assets/agents/${esc(avatarFile(a.id))}" alt="${esc(a.name||a.id)}"><span><span class="agent-name">${esc(a.name||a.id)}</span><span class="agent-role">${esc(ROLE[a.id]||'Agent')}</span><span class="agent-online ${a.online?'':'agent-offline'}">● ${a.online?'在线':'离线'}</span></span></span><span class="agent-stats"><span><b>${t.running||0}</b>执行中</span><span><b>${t.queued||0}</b>排队</span><span><b>${t.doneToday||0}</b>今日完成</span></span><span class="agent-cost">累计花费 <b>${money(t.usage?.cost)}</b></span></button>${selected?agentDetail(a):''}</article>`}).join('')||'<p class="empty-message">尚未收到 Agent 数据</p>';
 });
}
function renderSkills(){
 const rows=skillsData.filter(s=>(skillFilter==='all'||(s.agents||[]).some(a=>a===skillFilter||a.startsWith(skillFilter+'-')))&&(s.name+' '+(s.description||'')).toLowerCase().includes(skillQuery.toLowerCase()));
 const pages=Math.max(1,Math.ceil(rows.length/20));skillPage=Math.max(0,Math.min(skillPage,pages-1));
 document.getElementById('skill-count').textContent=`${skillsData.length} 条技能 · ${rows.length} 条匹配`;
 renderChanged('skill-filters',skillFilter,()=>document.getElementById('skill-filters').innerHTML=['all','claude','codex','hermes'].map(a=>`<button class="${a===skillFilter?'selected':''}" data-filter="${a}" aria-pressed="${a===skillFilter}">${a==='all'?'全部':a}</button>`).join(''));
 renderChanged('skill-list',[rows,skillPage,skillSelected],()=>document.getElementById('skill-list').innerHTML=rows.slice(skillPage*20,skillPage*20+20).map(s=>`<button class="skill-row ${s.name===skillSelected?'selected':''}" data-skill="${esc(s.name)}"><b>${esc(s.name)}</b><small>${esc(s.description||'暂无描述')}</small></button>`).join('')||'<p class="empty-message">没有找到匹配的技能，请尝试其他关键词或选择全部 Agent。</p>');
 document.getElementById('skill-pagination').innerHTML=`<button data-page="-1" ${skillPage===0?'disabled':''}>上一页</button><span>第 ${skillPage+1} / ${pages} 页</span><button data-page="1" ${skillPage===pages-1?'disabled':''}>下一页</button>`;
 const selected=rows.find(s=>s.name===skillSelected),detail=document.getElementById('skill-detail');
 detail.hidden=!selected;
 renderChanged('skill-detail',selected,()=>{detail.innerHTML=selected?`<button data-close-skill aria-label="关闭技能详情">关闭 ${icon('close')}</button><h3>${esc(selected.name)}</h3><h4>完整描述</h4><p>${esc(selected.description||'该技能尚未提供描述')}</p><h4>归属 Agent</h4><p>${esc((selected.agents||[]).join(' · ')||'未登记')}</p><h4>文件路径</h4><p class="skill-path">${esc(selected.path||((selected.dir||'')+'/SKILL.md'))}</p>`:''});
}
function fileButton(f){return `<button class="library-file" data-open-file="${esc(f.path)}" title="${esc(f.path)}">${icon('file')}<span>${esc(normPath(f.path).split('/').pop())}</span><small>${fmtBytes(f.bytes)}</small></button>`}
function renderFiles(){
 const tasks=lastFlow?.tasks||[];document.getElementById('file-count').textContent=tasks.reduce((n,t)=>n+dedupFiles((t.steps||[]).flatMap(s=>s.files||[])).length,0)+' 个产物 · 按需求归档';
 renderChanged('file-groups',tasks,()=>{const box=document.getElementById('file-groups'),states=new Map([...box.querySelectorAll('details')].map(e=>[e.dataset.group,e.open]));box.innerHTML=tasks.map(t=>{const files=dedupFiles((t.steps||[]).flatMap(s=>s.files||[]));return `<details class="filegroup" data-group="${esc(t.id)}" ${(states.get(t.id)??true)?'open':''}><summary>${esc(t.title)} · ${files.length} 个产物</summary>${files.map(fileButton).join('')||'<p class="empty-message">这项需求还没有登记产物</p>'}</details>`}).join('')||'<p class="empty-message">尚无需求产物</p>'});
}
function renderModules(){
 if(activePage==='agents')withScroll(document.getElementById('page-agents'),renderAgents);
 if(activePage==='skills')renderSkills();
 if(activePage==='files')withScroll(document.getElementById('page-files'),renderFiles);
}
document.addEventListener('click',e=>{
 const b=e.target.closest('button');if(!b)return;
 const routes={'rail-reqs':'/','rail-agents':'/agents','rail-skills':'/skills','rail-files':'/files'};
 if(routes[b.id]){location.hash=routes[b.id];return}
 if(b.dataset.agent){agentUI.selId=agentUI.selId===b.dataset.agent?null:b.dataset.agent;renderAgents()}
 if(b.dataset.page&&!b.disabled){skillPage+=Number(b.dataset.page);renderSkills();document.getElementById('skill-list').scrollTop=0}
 if(b.dataset.skill){skillSelected=b.dataset.skill;renderSkills()}
 if(b.dataset.filter){skillFilter=b.dataset.filter;skillPage=0;skillSelected=null;renderSkills();document.getElementById('skill-list').scrollTop=0}
 if(b.hasAttribute('data-close-skill')){skillSelected=null;renderSkills()}
 if(b.hasAttribute('data-close-picker')||b.dataset.openFile)document.getElementById('step-files').close();
});
document.getElementById('skill-search').addEventListener('input',e=>{skillQuery=e.target.value;skillPage=0;skillSelected=null;renderSkills();document.getElementById('skill-list').scrollTop=0});
document.addEventListener('keydown',e=>{
 if(e.key==='Escape'){skillSelected=null;renderSkills()}
 if((e.key==='Enter'||e.key===' ')&&e.target.matches('.step-card')){e.preventDefault();selectStep(e.target.dataset.step)}
});
for(const [id,name] of Object.entries({'rail-reqs':'board','rail-agents':'agents','rail-skills':'skills','rail-files':'folder','rail-focus':'play','tb-search':'search','tb-settings':'settings','tb-reqs-toggle':'board','tb-insp-toggle':'file'})){
 const el=document.getElementById(id);el.querySelector('svg')?.remove();el.insertAdjacentHTML('afterbegin',icon(name));
}
route();
