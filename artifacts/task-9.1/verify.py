from playwright.sync_api import sync_playwright
from pathlib import Path
import json,urllib.request,urllib.parse,urllib.error
out=Path('artifacts/task-9.1');result={};errors=[]
def api_status(path):
 try:return urllib.request.urlopen('http://127.0.0.1:8090/api/office/file?path='+urllib.parse.quote(path)).status
 except urllib.error.HTTPError as e:return e.code
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True)
 page=browser.new_page(viewport={'width':1440,'height':900})
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto('http://127.0.0.1:8090',wait_until='networkidle')
 page.locator('#rail-agents').click();page.wait_for_selector('.agent-card')
 page.wait_for_function('Array.from(document.querySelectorAll(".agent-avatar")).every(i=>i.complete && i.naturalWidth>0)')
 result['route']={'hash':page.evaluate('location.hash'),'title':page.locator('#page-agents h1').inner_text(),'cards':page.locator('.agent-card').count(),'columns':page.locator('#agent-grid').evaluate('e=>getComputedStyle(e).gridTemplateColumns'),'summary':page.locator('#agent-summary').inner_text()}
 page.screenshot(path=str(out/'agents.png'))
 page.locator('.agent-select').first.click();result['agentDetailChars']=len(page.locator('.agent-detail').inner_text())
 page.wait_for_timeout(3300);assert page.locator('.agent-detail').count()==1
 page.locator('#rail-skills').click();page.wait_for_selector('.skill-row')
 assert page.locator('.skill-row').count()==20
 assert page.locator('[data-page="-1"]').is_disabled()
 first=page.locator('.skill-row b').first.inner_text()
 page.locator('[data-page="1"]').click();second=page.locator('.skill-row b').first.inner_text();assert first!=second
 page.locator('.skill-row').first.click();detail=len(page.locator('#skill-detail').inner_text());assert detail>0
 result['skills']={'first':first,'second':second,'detailChars':detail,'pagination':page.locator('#skill-pagination').inner_text()}
 page.locator('#skill-list').evaluate('e=>e.scrollTop=170')
 before=page.locator('#skill-list').evaluate('e=>e.scrollTop')
 page.wait_for_timeout(3400)
 result['pollState']={'scrollBefore':before,'scrollAfter':page.locator('#skill-list').evaluate('e=>e.scrollTop'),'page2': '2 / 12' in page.locator('#skill-pagination').inner_text(),'selected':page.locator('.skill-row.selected b').inner_text()}
 assert result['pollState']['scrollAfter']==before
 page.locator('#skill-list').evaluate('e=>e.scrollTop=0');page.screenshot(path=str(out/'skills.png'))
 page.go_back();page.wait_for_selector('#page-agents:not([hidden])');page.go_forward();page.wait_for_selector('#page-skills:not([hidden])');result['history']='可用'
 page.locator('#skill-search').fill('zzzznonexist987654');result['empty']=page.locator('#skill-list').inner_text();assert '没有找到' in result['empty']
 page.wait_for_timeout(3200);assert page.locator('#skill-search').input_value()=='zzzznonexist987654'
 page.locator('#skill-search').fill('');page.locator('[data-filter="claude"]').click();result['filter']=page.locator('#skill-count').inner_text()
 page.locator('[data-filter="all"]').click()
 for _ in range(11):page.locator('[data-page="1"]').click()
 result['lastPage']={'items':page.locator('.skill-row').count(),'disabled':page.locator('[data-page="1"]').is_disabled()};assert result['lastPage']['disabled']
 page.locator('#rail-reqs').click();page.wait_for_selector('#page-workbench:not([hidden])')
 page.locator('.req-item').filter(has_text='Agent Office 可视化与流程打通').click()
 done=page.locator('.step-card.st-done.has-files').filter(has_text='开发计划');name=done.locator('.sc-title').inner_text()
 done.locator('[data-open-step-files]').click();page.wait_for_selector('#fv-body pre');result['file']={'step':name,'name':page.locator('#fv-name').inner_text(),'chars':len(page.locator('#fv-body pre').inner_text())};assert result['file']['chars']>0
 page.screenshot(path=str(out/'file-preview.png'));page.locator('#fv-close').click()
 multi=page.locator('.step-card').filter(has_text='任务书');multi.locator('[data-open-step-files]').click();assert page.locator('#step-files').is_visible();result['multiFiles']=page.locator('#step-file-list button').count();page.locator('#step-file-list button').first.click();page.wait_for_selector('#fv-body pre');page.locator('#fv-close').click()
 empty=page.locator('.step-card').filter(has_text='验收报告').locator('[data-open-step-files]');result['disabled']=empty.is_disabled();assert result['disabled'];assert empty.get_attribute('title')=='这一步没有登记产物'
 done.click();page.locator('#insp-body [data-open-file]').first.click();page.wait_for_selector('#fv-body pre');result['inspectorFile']=len(page.locator('#fv-body pre').inner_text());page.locator('#fv-close').click()
 page.screenshot(path=str(out/'workbench.png'))
 result['scroll']={}
 for route in ['/','/agents','/skills','/files']:
  page.evaluate('(r)=>location.hash=r',route);page.wait_for_timeout(150)
  result['scroll'][route]=page.evaluate('({scrollHeight:document.documentElement.scrollHeight,innerHeight,scrollWidth:document.documentElement.scrollWidth,innerWidth})')
  assert result['scroll'][route]['scrollHeight']==900
 page.screenshot(path=str(out/'files.png'))
 page.locator('.filegroup summary').first.click();page.wait_for_timeout(3200);assert not page.locator('.filegroup').first.evaluate('e=>e.open');result['fileGroupsPersist']=True
 page.set_viewport_size({'width':1100,'height':800});page.locator('#rail-skills').click();page.locator('.skill-row').first.click();assert page.locator('#skill-detail').is_visible();result['narrowDetail']=page.locator('#skill-detail').evaluate('e=>getComputedStyle(e).position');assert result['narrowDetail']=='fixed';page.screenshot(path=str(out/'skills-1100.png'));page.locator('[data-close-skill]').click()
 offline=browser.new_page(viewport={'width':1440,'height':900});offline.on('pageerror',lambda e:errors.append('offline: '+str(e)));offline.goto(Path('web/index.html').resolve().as_uri()+'#/skills',wait_until='networkidle');offline.wait_for_selector('.skill-row');result['offline']={'skills':offline.locator('#skill-count').inner_text(),'status':offline.locator('#sb-conn-text').inner_text()};offline.locator('[data-page="1"]').click();assert offline.locator('.skill-row b').first.inner_text()==second
 result['errors']=errors;assert not errors
 browser.close()
result['fileAPI']={'forbidden':api_status('C:/Windows/win.ini'),'missing':api_status(str(Path('web/does-not-exist-task91.txt').resolve()))}
assert result['fileAPI']=={'forbidden':403,'missing':404}
out.joinpath('measured.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(result,ensure_ascii=False,indent=2))
