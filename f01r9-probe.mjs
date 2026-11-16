import { connect, evalJs, waitFor } from './f01r9-lib.mjs';
import { writeFileSync } from 'node:fs';

await connect(9451);
await evalJs(`location.href = 'http://127.0.0.1:8090/#/files'; true`);
await waitFor(`!!document.querySelector('#file-groups')`, 10000, 'file-groups 出现');
await new Promise(r => setTimeout(r, 3000));
const info = await evalJs(`(() => {
  const gs = [...document.querySelectorAll('#file-groups .filegroup')];
  return {
    hash: location.hash,
    page: document.body.dataset.page,
    groupCount: gs.length,
    titles: gs.map(g => (g.querySelector('summary,.ff-title')?.textContent || '').trim().slice(0, 60)),
    rows: gs.map(g => [...g.querySelectorAll('.library-file')].length),
    fileCount: document.getElementById('file-count')?.textContent,
    firstRows: [...document.querySelectorAll('#file-groups .library-file')].slice(0, 5).map(r => r.dataset.openFile?.split('/').pop()),
    hasTestR11Text: document.getElementById('file-groups')?.textContent.includes('TEST-R11'),
    appcssRowAnywhere: [...document.querySelectorAll('.library-file')].filter(r => (r.dataset.openFile||'').includes('app.css')).map(r => r.querySelector('.lf-name')?.textContent),
  };
})()`);
console.log(JSON.stringify(info, null, 2));
