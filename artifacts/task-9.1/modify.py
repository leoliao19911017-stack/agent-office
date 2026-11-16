from pathlib import Path
import re,json,urllib.request
p=Path('web/index.html')
s=p.read_text(encoding='utf-8')
# Remove the module drawer, its styles, handlers and markup completely.
a=s.index('  /* ================= Agent 抽屉')
b=s.index('  /* ================= 响应式',a)
s=s[:a]+s[b:]
s=re.sub(r'^.*(?:--agent-h:|body\.agent-open|#agent-drawer|#agent-grip|#ad-list|\.ad-agent|\.ad-ava|#ad-detail|#add-body|\.add-sec).*\n','',s,flags=re.M)
s=s.replace('svg {stroke-width:1.6;stroke-linecap:round}','')
s=re.sub(r'^#hub.*\n','',s,flags=re.M)
s=s.replace('.hubtools','.skill-tools').replace('.hubgrid','.skill-layout')
a=s.index('<!-- ================= Agent 抽屉')
b=s.index('<!-- ================= 专注模式',a)
s=s[:a]+s[b:]
s=s.replace('  if(agentUI.open && drawerMode!==\'agents\') renderHub();','')
s=re.sub(r'  // 抽屉开着时.*\n  if \(agentUI.open.*\n','  renderModules();\n',s)
a=s.index("    case 'rail-agents':")
b=s.index("    case 'fd-close':",a)
s=s[:a]+s[b:]
s=s.replace('const agentUI = { open: false, selId: null };','const agentUI = { selId: null };')
a=s.index('function dotClass(a)')
b=s.index('/* 页面切后台暂停轮询',a)
s=s[:a]+s[b:]
a=s.index('/* Merged from TASK-8.1')
b=s.index('/* ================= 启动',a)
s=s[:a]+'/* MODULE_CODE */\n'+s[b:]
# Keep EaseDraw as a fixed focus overlay, with no remaining drag machinery.
s=s.replace('focus-drawer','focus-panel')
s=re.sub(r'  \.fd-grip \{.*?  \.fd-grip:hover::after[^\n]*\n','',s,flags=re.S)
s=re.sub(r'  <div class="fd-grip"[^\n]*\n','',s)
a=s.index('/* ---- 专注抽屉拖宽')
b=s.index('/* ================= Agent 抽屉',a)
s=s[:a]+s[b:]
s=s.replace('/* ================= Agent 抽屉 ================= */','/* ================= 页面工具 ================= */')
s=s.replace('专注模式抽屉','专注模式').replace('不关抽屉','不关专注面板')
s=s.replace('<span>需求</span>','<span>工作台</span>').replace('<span>Agent</span>','<span>Agents</span>')
s=s.replace('  <!-- 左：需求列表 248px -->','  <section id="page-workbench" class="workbench-page" aria-label="工作台">\n  <!-- 左：需求列表 248px -->')
s=s.replace('</div>\n\n<!-- ================= 底部状态栏', '''  </section>
  <main id="page-agents" class="module-page" hidden><header class="page-heading"><div><span class="eyebrow">THE ATELIER</span><h1>Agents</h1></div><p id="agent-summary"></p></header><div id="agent-grid"></div></main>
  <main id="page-skills" class="module-page" hidden><header class="page-heading"><div><span class="eyebrow">TOOLS & CRAFT</span><h1>技能</h1></div><p id="skill-count"></p></header><div class="skill-tools"><input id="skill-search" aria-label="搜索技能" placeholder="搜索技能名称或用途"><div id="skill-filters"></div></div><div class="skill-layout"><div class="skill-list-column"><div id="skill-list"></div><div id="skill-pagination" class="pagination"></div></div><aside id="skill-detail" class="skilldetail" aria-label="技能详情" hidden></aside></div></main>
  <main id="page-files" class="module-page" hidden><header class="page-heading"><div><span class="eyebrow">COLLECTED WORK</span><h1>文件</h1></div><p id="file-count"></p></header><div id="file-groups"></div></main>
</div>
<dialog id="step-files"><div class="picker-heading"><h3>选择产物</h3><button data-close-picker>关闭</button></div><div id="step-file-list"></div></dialog>

<!-- ================= 底部状态栏''')
a=s.index('function stepCardHtml(s)')
b=s.index('/* ---- 中：全部需求',a)
s=s[:a]+'''function stepCardHtml(s) {
  const st = s.status || 'pending', files = dedupFiles(s.files || []);
  return `<article class="step-card st-${esc(st)}${s.key === ui.stepKey ? ' sel' : ''}${files.length ? ' has-files' : ''}" data-step="${esc(s.key)}" data-task="${esc(ui.taskId)}" tabindex="0" aria-label="${esc(s.name)}详情">
    <span class="sc-row1"><span class="sc-title"><span class="step-number">${String(s.no ?? '').padStart(2,'0')}</span> · ${esc(s.name)}</span><span class="st st-${esc(st)}">${esc(STEP_LABEL[st] || st)}</span></span>
    <span class="sc-row2"><span class="sc-by">${esc(s.by || '—')}</span><button class="file-pill" data-open-step-files="${esc(s.key)}" ${files.length ? '' : 'disabled title="这一步没有登记产物"'}>${files.length} 个产物</button></span>
  </article>`;
}

'''+s[b:]
s=s.replace("  const el = ev.target.closest('[data-task],[data-step],button');", """  const pill = ev.target.closest('[data-open-step-files]');
  if (pill) {
    if (pill.disabled) return;
    const files = dedupFiles(currentTask()?.steps.find(s=>s.key===pill.dataset.openStepFiles)?.files || []);
    if (files.length===1) openFileView(files[0].path);
    else if (files.length>1) { document.getElementById('step-file-list').innerHTML=files.map(fileButton).join(''); document.getElementById('step-files').showModal(); }
    return;
  }
  const el = ev.target.closest('[data-task],[data-step],button');""")
s=s.replace("    case 'tb-decision': {", "    case 'tb-decision': {\n      location.hash='/';")
css='''
/* TASK-9.1 — independent, internally scrolling pages. */
:root {--font-display:"Georgia","Songti SC","SimSun","Noto Serif SC",serif;--font-body:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;--font-mono:"Cascadia Code",Consolas,monospace;--ink-muted:var(--muted);--ink-green:var(--green);--ink-blue:var(--blue);--ink-red:var(--red)}
[hidden] {display:none!important}
body,button,input,textarea {font-family:var(--font-body)}
h1,h2,h3,h4,.tb-logo,.step-number,.phase .p-name,.agent-name,.agent-stats b,.ch-meta,.req-prog,#agent-summary,#skill-count,#file-count {font-family:var(--font-display);font-weight:600!important}
.fv-path,#fv-body pre,.skill-row b,.skilldetail h3,.skill-path,.library-file span {font-family:var(--font-mono)}
svg {stroke-width:2;stroke-linecap:round;stroke-linejoin:round;width:20px;height:20px;flex:none}
.rail-item svg,.tb-icon svg {width:20px;height:20px}
button:hover svg,.rail-item[aria-current] svg {color:#E8B84A}
button:focus-visible,[tabindex]:focus-visible,input:focus-visible {outline:2px solid var(--blue);outline-offset:3px}
button:disabled {opacity:.45;cursor:default}
.workbench-page {display:flex;flex:1;min-width:0;min-height:0}
.module-page {flex:1;min-width:0;min-height:0;overflow:auto;padding:28px 32px 36px}
.page-heading {display:flex;align-items:end;justify-content:space-between;gap:24px;border-bottom:1px solid var(--line);padding-bottom:20px;margin-bottom:24px}
.page-heading h1 {font-size:30px;line-height:1.2;margin:6px 0 0;color:var(--paper)}
.page-heading p {color:var(--muted);margin:0;font-size:15px}
.eyebrow {font-size:10px;letter-spacing:.2em;color:var(--muted)}
#agent-grid {display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:18px;align-items:start}
.agent-card {background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.agent-card.selected {border-color:var(--blue)}
.agent-card:hover {border-color:var(--blue)}
.agent-select {display:block;width:100%;padding:22px;text-align:left;background:none;border:0;cursor:pointer}
.agent-head {display:flex;gap:14px;align-items:center}
.agent-avatar {width:64px;height:64px;object-fit:cover;border-radius:10px;border:1px solid var(--line)}
.agent-name {font-size:20px;display:block;color:var(--paper)}
.agent-role {font-size:12px;color:var(--muted)}
.agent-online {display:block;color:var(--green);font-size:12px;margin-top:6px}.agent-offline {color:var(--faint)}
.agent-stats {display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:22px 0 16px}
.agent-stats b {display:block;font-size:25px;color:var(--text)}
.agent-stats span,.agent-cost {color:var(--muted);font-size:12px}
.agent-cost {border-top:1px solid var(--line);padding-top:12px;display:flex;justify-content:space-between}.agent-cost b {color:var(--paper);font-family:var(--font-display);font-size:17px;font-weight:600}
.agent-detail {padding:0 22px 20px;border-top:1px solid var(--line)}
.agent-detail h4 {color:var(--paper);font-size:15px;margin:18px 0 8px}.agent-kv {display:flex;justify-content:space-between;color:var(--muted);gap:12px}.agent-run {padding:10px 0;border-bottom:1px solid var(--line);overflow-wrap:anywhere}.agent-run p {margin:4px 0;color:var(--muted)}
#page-skills {display:flex;flex-direction:column;overflow:hidden}
.skill-tools {flex:none;display:flex;gap:18px;flex-wrap:wrap;margin-bottom:18px}.skill-tools input {width:min(360px,100%);padding:9px 12px;font:inherit}
#skill-filters {display:flex;gap:8px;align-items:center}#skill-filters button {border-radius:999px;padding:5px 16px}#skill-filters button.selected {border-color:var(--blue);color:var(--blue)}
.skill-layout {display:flex;flex:1;min-height:0;gap:24px;position:relative}
.skill-list-column {flex:1;min-width:0;display:flex;flex-direction:column;min-height:0}
#skill-list {overflow:auto;flex:1;min-height:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;align-content:start;padding:2px}
.skill-row {padding:12px 14px;background:var(--panel);min-width:0;min-height:76px}.skill-row b {font-size:12px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:400}.skill-row:hover {border-color:var(--blue)}.skill-row small {margin-top:5px}
.pagination {flex:none;padding-top:14px;margin:0;border-top:1px solid var(--line)}
.skilldetail {flex:0 0 340px;padding:24px;background:var(--panel);border:1px solid var(--blue);border-radius:8px;overflow:auto;white-space:pre-wrap}.skilldetail h3 {font-size:18px;margin:22px 0;font-weight:400}.skilldetail h4 {color:var(--muted);margin:24px 0 6px}.skilldetail p {line-height:1.8}.skilldetail button {float:right;background:var(--card);border:1px solid var(--line);border-radius:5px;cursor:pointer}.skill-path {font-size:12px;color:var(--muted)}
.empty-message {padding:36px 20px;color:var(--muted);text-align:center;grid-column:1/-1}
.filegroup {margin-bottom:18px;padding:12px 20px;background:var(--panel);border:1px solid var(--line);border-radius:8px}.filegroup summary {font-family:var(--font-display);font-size:17px;color:var(--paper)}.library-file:hover {border-color:var(--blue)}.library-file span {overflow-wrap:anywhere;min-width:0}.library-file small {white-space:nowrap}
.file-pill {border:1px solid var(--blue);background:rgba(91,143,249,.1);color:var(--blue);border-radius:999px;padding:2px 10px;margin-left:auto;font-size:12px;cursor:pointer}.file-pill:disabled {border-color:var(--faint);color:var(--faint);background:none;opacity:.8}.step-card.has-files:hover {border-color:var(--blue);cursor:pointer}.step-card .sc-row2 {overflow:visible}
#step-files {background:var(--panel);color:var(--text);border:1px solid var(--blue);border-radius:10px;width:min(560px,90vw);max-height:70vh;padding:20px}#step-files::backdrop {background:#06090eb8}.picker-heading {display:flex;justify-content:space-between;align-items:center}.picker-heading button {background:var(--card);border:1px solid var(--line);border-radius:6px;cursor:pointer}
body:not([data-page="workbench"]) #tb-reqs-toggle,body:not([data-page="workbench"]) #tb-insp-toggle {display:none}
@media(max-width:1199px){#agent-grid {grid-template-columns:repeat(3,minmax(0,1fr))}.skilldetail {position:fixed;right:20px;top:76px;bottom:48px;width:min(440px,calc(100vw - 100px));z-index:45;box-shadow:0 0 0 100vmax #06090eaa}}
@media(max-width:900px){#agent-grid {grid-template-columns:repeat(2,minmax(0,1fr))}.module-page {padding:20px}#skill-list {grid-template-columns:1fr}.page-heading {align-items:start;flex-direction:column;gap:12px}}
@media(max-width:600px){#agent-grid {grid-template-columns:1fr}.skill-tools {gap:8px}#skill-filters button {padding:5px 9px}}
'''
s=s.replace('</style>',css+'\n</style>')
p.write_text(s,encoding='utf-8')
