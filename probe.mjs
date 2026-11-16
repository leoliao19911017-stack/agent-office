import { connect, evalJs } from './f01r9-lib.mjs';
await connect(9451);
const r = await Promise.race([
  evalJs(`(() => ({ groups: [...document.querySelectorAll('#file-groups .filegroup summary')].map(s=>s.textContent.trim().slice(0,60)), hasLib: typeof lastFlow, files: document.querySelectorAll('.library-file').length }))()`),
  new Promise((_, rej) => setTimeout(() => rej(new Error('evaluate 8s 超时')), 8000)),
]);
console.log(JSON.stringify(r, null, 1));
