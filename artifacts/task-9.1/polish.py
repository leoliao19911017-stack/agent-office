from pathlib import Path
import json,re,urllib.request,urllib.parse
p=Path('web/index.html');s=p.read_text(encoding='utf-8')
match=re.search(r'<script id="offline-snapshot" type="application/json">(.*?)</script>',s,re.S)
def fetch(path):return json.load(urllib.request.urlopen('http://127.0.0.1:8090'+path))
state=fetch('/api/state')
data={'state':{k:state[k] for k in ['agents','runs','totals','spending','now','cards','channels']},'skills':fetch('/api/office/skills'),'flow':fetch('/api/office/flow'),'files':{}}
for task in data['flow']['tasks']:
 for step in task['steps']:
  for f in step['files']:
   path=f['path']
   if path.replace('\\','/').endswith('/web/index.html'):continue
   try:
    v=fetch('/api/office/file?path='+urllib.parse.quote(path))
    if 'text' in v:data['files'][path]=v
   except Exception:pass
payload=json.dumps(data,ensure_ascii=False,separators=(',',':')).replace('<','\\u003c')
s=s[:match.start(1)]+payload+s[match.end(1):]
# Remove original geometric SVG markup; the shared brush icon factory supplies each control.
a=s.index('<body>');b=s.index('<script id="offline-snapshot"')
s=s[:a]+re.sub(r'<svg\b.*?</svg>','',s[a:b],flags=re.S)+s[b:]
s=s.replace('.st-pending { color: var(--muted);','.st-pending { color: var(--faint);')
s=s.replace('h1,h2,h3,h4,.tb-logo,.step-number,','h1,h2,h3,h4,.tb-logo,.ip-step,.step-number,')
s=s.replace("function agentBusy(a) {\n  const t = a.totals || {};\n  return (t.running || 0) + (t.queued || 0) + (t.retrying || 0) > 0;", "function agentBusy(a) {\n  const t = a.totals || {};\n  return (t.running || 0) + (t.retrying || 0) > 0;")
# A read-only offline snapshot must not imply a fresh server sync.
s=s.replace("  el.textContent = lastSyncAt", "  if (offline) { el.textContent='快照 '+fmtTime(snapshot.state.now); return; }\n  el.textContent = lastSyncAt")
p.write_text(s,encoding='utf-8')
