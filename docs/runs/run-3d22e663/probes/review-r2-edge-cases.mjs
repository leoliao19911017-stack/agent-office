import { startChatServer } from '../../../../test/chat-harness.mjs';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
const out='docs/runs/run-3d22e663/review-r2-evidence';
mkdirSync(out,{recursive:true});
const s=await startChatServer();
const ev={at:new Date().toISOString(),base:s.base};
let db,browser,externalWorker;
const call=async(method,path,body)=>{const r=await fetch(s.base+path,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
const create=async(title,extra={})=>(await call('POST','/api/tasks',{title,...extra})).body.task.task_id;
try {
  await call('GET','/api/tasks'); db=new DatabaseSync(s.dbPath); db.exec('PRAGMA busy_timeout=5000');
  const run=(await call('POST','/api/workflow/runs',{template_id:'coding-v1',title:'R2 completed fixture'})).body.run.run_id;
  const archived=(await call('POST','/api/workflow/runs',{template_id:'coding-v1',title:'R2 archived fixture'})).body.run.run_id;
  db.prepare('UPDATE workflow_runs SET archived_at=? WHERE run_id=?').run(new Date().toISOString(),archived);
  for(let i=1;i<=10;i++) {
    const id=await create(`R2 completed ${i}`,{workflow_run_id:run,workflow_step_id:'05'});
    db.prepare("UPDATE tasks SET status='completed',closed_at=? WHERE task_id=?").run(new Date().toISOString(),id);
  }
  browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  await page.goto(s.base+'/board-cromma.html',{waitUntil:'networkidle'});
  ev.display={counts:await page.locator('#task-filters .filter').evaluateAll(es=>Object.fromEntries(es.map(e=>[e.dataset.filter,e.querySelector('b')?.textContent]))),progress:await page.locator('.task-row__prog').allTextContents(),options:await page.locator('#task-run-select option').evaluateAll(es=>es.map(e=>({value:e.value,text:e.textContent}))),archivedRun:archived};
  assert.equal(ev.display.counts.completed,'10'); assert.equal(ev.display.progress.length,10); assert.ok(ev.display.progress.every(x=>x.trim()==='1/1')); assert.ok(!ev.display.options.some(x=>x.value===archived));
  await page.screenshot({path:out+'/display.png'});
  await page.screenshot({path:out+'/display-rail.png',clip:{x:0,y:0,width:300,height:900}});

  // Confirmation for A must not apply to B started by another client before the second click.
  const t=await create('R2 stale stop confirmation');
  const a=await call('POST',`/api/tasks/${t}/attempt`,{agent_id:'dsh'});
  await page.reload({waitUntil:'networkidle'});
  await page.locator(`[data-line="${t}"] [data-act="stop"]`).click();
  await page.locator(`[data-line="${t}"] [data-confirm="1"]`).waitFor();
  const firstConfirm=await page.evaluate(()=>state.stopConfirm);
  await call('POST',`/api/tasks/${t}/finish`,{evidence:'R2 A finished'});
  externalWorker=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});
  await new Promise((resolve,reject)=>{externalWorker.once('spawn',resolve);externalWorker.once('error',reject);});
  const b=await call('POST',`/api/tasks/${t}/attempt`,{agent_id:'dsh'});
  await page.locator('#refresh-btn').click();
  await page.waitForFunction(id=>state.tasksData.tasks.find(x=>x.task_id===id)?.active_attempt_id!=null,t);
  const confirmText=await page.locator(`[data-line="${t}"] [data-act="stop"]`).innerText();
  const response=page.waitForResponse(r=>r.url().endsWith(`/api/tasks/${t}/stop`)&&r.request().method()==='POST');
  await page.locator(`[data-line="${t}"] [data-act="stop"]`).click();
  const r=await response;
  ev.staleStopConfirmation={task:t,a:a.body.attempt.attempt_id,b:b.body.attempt.attempt_id,firstConfirm,confirmText,request:r.request().postDataJSON(),response:{status:r.status(),body:await r.json()},attempts:db.prepare('SELECT attempt_id,status,end_reason FROM attempts WHERE task_id=? ORDER BY started_at').all(t),deleteAfter:await call('DELETE',`/api/tasks/${t}`)};
  process.kill(externalWorker.pid,0);
  ev.staleStopConfirmation.externalWorker={pid:externalWorker.pid,registeredPid:null,aliveAfterStopAndDelete:true};
  await page.screenshot({path:out+'/stale-confirm.png'});

  // Multiple supported attempt declarations: stop only the latest, inspect UI and delete guard.
  const multi=await create('R2 two running attempts');
  const m1=await call('POST',`/api/tasks/${multi}/attempt`,{agent_id:'dsh'});
  const m2=await call('POST',`/api/tasks/${multi}/attempt`,{agent_id:'dsh'});
  const stopped=await call('POST',`/api/tasks/${multi}/stop`,{confirm:true});
  await page.reload({waitUntil:'networkidle'});
  ev.multiAttempt={task:multi,startStatuses:[m1.status,m2.status],stop:stopped,running:db.prepare("SELECT attempt_id FROM attempts WHERE task_id=? AND status='running'").all(multi),stopButtons:await page.locator(`[data-line="${multi}"] [data-act="stop"]`).count(),delete:await call('DELETE',`/api/tasks/${multi}`)};
  await page.screenshot({path:out+'/multi-attempt.png'});

  // The new detail write path must not partially commit on audit failure.
  const drift=await create('R2 detail audit rollback');
  db.prepare("UPDATE tasks SET status='running' WHERE task_id=?").run(drift);
  const before=db.prepare('SELECT status,status_reason,updated_at FROM tasks WHERE task_id=?').get(drift);
  db.exec("CREATE TRIGGER r2_fail_status BEFORE INSERT ON events WHEN NEW.event_type='status_changed' BEGIN SELECT RAISE(ABORT,'R2 reject status audit'); END");
  const detail=await call('GET',`/api/tasks/${drift}`);
  ev.detailAtomicity={task:drift,before,response:detail,after:db.prepare('SELECT status,status_reason,updated_at FROM tasks WHERE task_id=?').get(drift),events:db.prepare("SELECT count(*) n FROM events WHERE task_id=? AND event_type='status_changed'").get(drift)};
  db.exec('DROP TRIGGER r2_fail_status');
} finally {
  if(externalWorker && externalWorker.exitCode===null) { const exited=new Promise(resolve=>externalWorker.once('exit',resolve));externalWorker.kill();await exited; }
  writeFileSync(out+'/edge-cases.json',JSON.stringify(ev,null,2));
  await browser?.close();db?.close();await s.stop();
}
console.log(JSON.stringify(ev,null,2));
