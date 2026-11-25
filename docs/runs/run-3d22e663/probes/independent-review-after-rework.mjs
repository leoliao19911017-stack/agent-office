// independent-review-after-rework.mjs —— 评审探针 independent-review.mjs 的「返工后复跑」副本。
// 与原件（Codex 的复现证据，不要改它）只有两处不同：
//   1. 输出目录 review-evidence/ → rework-evidence/（不覆盖评审的证据）；
//   2. hiddenSelection 一段：返工后切筛选会清空选择、批量条收起，原件里「点批量归档」那一步没有东西可点，
//      所以先记下批量条是否收起；收起了就不再点（也不编一个请求出来），没收回才照原件点。
// 其余逐字未动。运行：node --no-warnings docs/runs/run-3d22e663/probes/independent-review-after-rework.mjs
import { startChatServer } from '../../../../test/chat-harness.mjs';
import { openDb, closeDb } from '../../../../web/lib/db.mjs';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright-core';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const out = 'docs/runs/run-3d22e663/rework-evidence';
mkdirSync(out, {recursive:true});
const evidence = {};
const s = await startChatServer();
let db, browser;
const call = async (method,path,body) => { const r=await fetch(s.base+path,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}); return {status:r.status,body:await r.json()}; };
const create = async title => (await call('POST','/api/tasks',{title})).body.task.task_id;
try {
  await call('GET','/api/tasks');
  db = new DatabaseSync(s.dbPath);
  db.exec('PRAGMA busy_timeout=5000');
  evidence.schema={columns:db.prepare('PRAGMA table_info(tasks)').all(),indexes:db.prepare('PRAGMA index_list(tasks)').all(),integrity:db.prepare('PRAGMA integrity_check').get(),version:db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()};
  const id=await create('Review deleted execution');
  evidence.deleteThenAttempt={delete:await call('DELETE',`/api/tasks/${id}`),attempt:await call('POST',`/api/tasks/${id}/attempt`,{agent_id:'dsh'}),row:db.prepare('SELECT status,deleted_at FROM tasks WHERE task_id=?').get(id)};
  const audit=await create('Review failed audit');
  db.exec("CREATE TRIGGER review_fail_event BEFORE INSERT ON events WHEN NEW.event_type='task_archived' BEGIN SELECT RAISE(ABORT,'review audit failure'); END");
  evidence.nonAtomic={response:await call('POST',`/api/tasks/${audit}/archive`,{}),row:db.prepare('SELECT archived_at FROM tasks WHERE task_id=?').get(audit),events:db.prepare("SELECT count(*) n FROM events WHERE task_id=? AND event_type='task_archived'").get(audit)};
  db.exec('DROP TRIGGER review_fail_event');
  const drift=await create('Review archive finish restore');
  await call('POST',`/api/tasks/${drift}/attempt`,{agent_id:'dsh'});
  await call('POST',`/api/tasks/${drift}/archive`,{});
  await call('POST',`/api/tasks/${drift}/finish`,{evidence:'review-fixture',result:'passed'});
  evidence.restoreDrift={restore:await call('POST',`/api/tasks/${drift}/restore`,{}),detail:await call('GET',`/api/tasks/${drift}`),delete:await call('DELETE',`/api/tasks/${drift}`)};
  const waiting=await create('Review hidden waiting selection');
  const running=await create('Review visible running');
  await call('POST',`/api/tasks/${running}/attempt`,{agent_id:'dsh'});
  browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  await page.goto(s.base+'/board-cromma.html',{waitUntil:'networkidle'});
  await page.locator(`[data-pick="${waiting}"]`).check();
  evidence.batchVisible=await page.locator('#task-batch').isVisible();
  await page.locator('[data-filter="running"]').click();
  evidence.hiddenSelection={hiddenRowCount:await page.locator(`[data-line="${waiting}"]`).count(),barText:await page.locator('#task-batch').innerText()};
  evidence.hiddenSelection.barHidden=await page.locator('#task-batch').isHidden();
  evidence.hiddenSelection.selectedSize=await page.evaluate(()=>state.selectedTaskIds.size);
  await page.screenshot({path:join(out,'hidden-selection.png')});
  if(!evidence.hiddenSelection.barHidden){
  const response=page.waitForResponse(r=>r.url().endsWith('/api/tasks/batch')&&r.request().method()==='POST');
  await page.locator('[data-batch="archive"]').click();
  evidence.hiddenSelection.response=await (await response).json();
  }else{
    evidence.hiddenSelection.response=null;
    evidence.hiddenSelection.note='返工后：切筛选即清空选择、批量条收起，没有可点的「批量归档」';
  }
  evidence.hiddenSelection.row=db.prepare('SELECT archived_at FROM tasks WHERE task_id=?').get(waiting);
  await page.locator('[data-filter="all"]').click();
  const ui=await create('Review UI archive restore');
  await page.reload({waitUntil:'networkidle'});
  await page.locator(`[data-line="${ui}"] [data-act="archive"]`).click();
  await page.locator(`[data-line="${ui}"].is-archived`).waitFor();
  await page.screenshot({path:join(out,'archive-ui.png')});
  await page.locator(`[data-line="${ui}"] [data-act="restore"]`).click();
  await page.locator(`[data-line="${ui}"]:not(.is-archived)`).waitFor();
  evidence.uiRestore=db.prepare('SELECT archived_at FROM tasks WHERE task_id=?').get(ui);
  const run=(await call('POST','/api/workflow/runs',{template_id:'coding-v1',title:'Review workflow'})).body.run.run_id;
  evidence.workflowBatch=await call('POST',`/api/workflow/runs/${run}/steps/05/tasks`,{tasks:[{title:'Review workflow task'}]});
  await page.reload({waitUntil:'networkidle'});
  const filtered=page.waitForResponse(r=>r.url().includes('/api/tasks?workflow_run_id=')&&r.request().method()==='GET');
  await page.locator('#task-run-select').selectOption(run);
  await filtered;
  await page.waitForFunction(()=>document.querySelectorAll('.task-line').length===1);
  evidence.workflowUi={count:await page.locator('.task-line').count(),tags:await page.locator('.task-tag--step').allTextContents()};
  await page.screenshot({path:join(out,'workflow-ui.png')});
  const migPath=join(s.home,'migration-v7.db');
  let m=openDb({path:migPath});
  m.exec("DROP INDEX idx_tasks_archived; DROP INDEX idx_tasks_deleted; DROP INDEX idx_tasks_workflow;");
  for(const col of ['archived_at','archived_from','deleted_at','workflow_run_id','workflow_step_id']) m.exec(`ALTER TABLE tasks DROP COLUMN ${col}`);
  m.exec("UPDATE schema_meta SET value='7' WHERE key='schema_version'; INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('old-review','旧任务','waiting','2020-01-01','2020-01-01')");
  const before=m.prepare('SELECT rowid,* FROM tasks').all(); closeDb(m);
  m=openDb({path:migPath});
  evidence.migration={before,after:m.prepare('SELECT rowid,* FROM tasks').all(),integrity:m.prepare('PRAGMA integrity_check').get(),version:m.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()}; closeDb(m);
} finally {
  writeFileSync(join(out,'probe.json'),JSON.stringify(evidence,null,2));
  await browser?.close(); db?.close(); await s.stop();
}
console.log(JSON.stringify(evidence,null,2));
