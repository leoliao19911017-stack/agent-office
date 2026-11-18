
fetch('http://127.0.0.1:8090/api/office/decision', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ demandId: 'PROBE_NONEXISTENT_DEMAND', doc: 'probe.md', step: 'doc', approve: true })
}).then(async r => {
  console.log('HTTP ' + r.status + '  ' + (await r.text()).slice(0, 300));
}).catch(e => console.log('ERR ' + e.message));
