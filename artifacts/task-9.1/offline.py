from pathlib import Path
import urllib.request,json
base='http://127.0.0.1:8090'
def fetch(path):return json.load(urllib.request.urlopen(base+path))
flow=fetch('/api/office/flow');skills=fetch('/api/office/skills');state=fetch('/api/state')
state={k:state[k] for k in ['agents','runs','totals','spending','now','cards','channels']}
files={}
for t in flow['tasks']:
 for step in t['steps']:
  for f in step['files']:
   path=f['path']
   try:
    data=fetch('/api/office/file?path='+urllib.parse.quote(path))
    if data.get('kind')!='binary':files[path]=data
   except Exception:pass
snapshot={'flow':flow,'skills':skills,'state':state,'files':files}
p=Path('web/index.html');s=p.read_text(encoding='utf-8')
data=json.dumps(snapshot,ensure_ascii=False,separators=(',',':')).replace('<','\\u003c')
s=s.replace('<script>','<script id="offline-snapshot" type="application/json">'+data+'</script>\n<script>',1)
s=s.replace("async function api(path, opts) {",'''const offline = location.protocol === 'file:';
const snapshot = offline ? JSON.parse(document.getElementById('offline-snapshot').textContent) : null;
async function api(path, opts) {
  if (offline) {
    if (opts?.method && opts.method !== 'GET') throw new Error('离线快照不能执行操作，请通过本地服务打开');
    const data={'/api/state':snapshot.state,'/api/office/flow':snapshot.flow,'/api/office/skills':snapshot.skills,'/api/health':{autoloop:false}};
    if (path in data) return data[path];
    throw new Error('离线模式不支持此操作');
  }''')
s=s.replace('function startPolling() {','function startPolling() {\n  if (offline) return;')
s=s.replace('async function scheduleFileCheck() {','async function scheduleFileCheck() {\n  if (offline) return;')
s=s.replace("  const ext = (String(p).match", """  if (offline) {
    const file=snapshot.files[p];
    document.getElementById('fv-meta').textContent='离线快照';
    body.innerHTML=file?`<pre>${esc(file.text||file.note||'暂无可预览内容')}</pre>`:'<div class="fv-warn">离线快照没有收录此文件，请通过本地服务打开。</div>';
    return;
  }
  const ext = (String(p).match""")
s=s.replace("  else if (hubOnline === false) { conn.classList.add('off'); connText.textContent = '连接断开'; }", "  else if (hubOnline === false) { conn.classList.add('off'); connText.textContent = offline ? '离线快照 · '+fmtTime(snapshot.state.now) : '连接断开'; }")
# Do not load the online focus app until explicitly opened.
s=s.replace('src="https://luckyandease.com/easedraw/"','data-src="https://luckyandease.com/easedraw/"')
s=s.replace("    case 'rail-focus':", "    case 'rail-focus':\n      if (!document.getElementById('fd-frame').src) document.getElementById('fd-frame').src=document.getElementById('fd-frame').dataset.src;")
p.write_text(s,encoding='utf-8')
print('Snapshot bytes',len(data.encode()),'files',len(files))
