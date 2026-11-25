import { startChatServer } from '../../../../test/chat-harness.mjs';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const out='docs/runs/run-3d22e663/review-r3-evidence';
const s=await startChatServer(); let db,browser; const ev={at:new Date().toISOString(),base:s.base};
const call=async(method,path,body)=>{const r=await fetch(s.base+path,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
try {
const t=(await call('POST','/api/tasks',{title:'R3 independent handoff constraint'})).body.task.task_id;
const a=await call('POST',`/api/tasks/${t}/attempt`,{agent_id:'dsh'});
await call('POST',`/api/tasks/${t}/finish`,{result:'passed',evidence:'independent review finished A'});
const b=await call('POST',`/api/tasks/${t}/attempt`,{agent_id:'dsh'});
const refused=await call('POST',`/api/tasks/${t}/attempt`,{agent_id:'dsh'});
const handoff=await call('POST',`/api/tasks/${t}/handoff`,{from_attempt_id:a.body.attempt.attempt_id,to_agent_id:'codex',worktree_path:s.dbPath.replace(/[^/\\]+$/, '')+'handoff-probe'});
db=new DatabaseSync(s.dbPath);
const running=db.prepare("SELECT attempt_id,status FROM attempts WHERE task_id=? AND status='running'").all(t);
ev.handoff={task:t,a:a.body.attempt.attempt_id,b:b.body.attempt.attempt_id,normalAttempt:refused,handoff,running};
assert.equal(refused.status,409);assert.equal(handoff.status,201);assert.equal(running.length,2);
// The duplicated rows above are created through real API only, without SQL insertion.
// End newest via bound stop; confirm remaining older instance, then refresh with no state change.
const first=await call('POST',`/api/tasks/${t}/stop`,{});
await call('POST',`/api/tasks/${t}/stop`,{confirm:true,attempt_id:first.body.attempt_id});
browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
const page=await browser.newPage({viewport:{width:1440,height:900}});
await page.goto(s.base+'/board-cromma.html',{waitUntil:'networkidle'});
await page.locator(`[data-line="${t}"] [data-act="stop"]`).click();
await page.locator(`[data-line="${t}"] [data-confirm="1"]`).waitFor();
const before=await page.evaluate(()=>({confirm:state.stopConfirm,task:state.tasksData.tasks[0]}));
await page.locator('#refresh-btn').click();
await page.waitForFunction(()=>!state.loading && state.stopConfirm===null);
const after=await page.evaluate(()=>({confirm:state.stopConfirm,task:state.tasksData.tasks[0]}));
const row=db.prepare('SELECT * FROM attempts WHERE attempt_id=?').get(b.body.attempt.attempt_id);
ev.refresh={before,after,remaining:row,button:await page.locator(`[data-line="${t}"] [data-act="stop"]`).innerText()};
assert.equal(row.status,'running');assert.equal(before.confirm.attemptId,b.body.attempt.attempt_id);assert.equal(after.confirm,null);
await page.screenshot({path:out+'/new-edge-refresh.png'});
// Control: fresh confirmation can still stop B and delete, no permanent dead end.
const next=await call('POST',`/api/tasks/${t}/stop`,{});
const stopped=await call('POST',`/api/tasks/${t}/stop`,{confirm:true,attempt_id:next.body.attempt_id});
ev.control={stop:stopped.status,delete:(await call('DELETE',`/api/tasks/${t}`)).status};
assert.equal(ev.control.delete,200);
} finally {writeFileSync(out+'/new-edges.json',JSON.stringify(ev,null,2));await browser?.close();db?.close();await s.stop();}
console.log(JSON.stringify(ev,null,2));
