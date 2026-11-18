
import { readFileSync, existsSync } from 'node:fs';
const files = ['web/app.js', 'web/app-base.css', 'web/app-workbench.css', 'web/app-pages.css', 'web/app-layers.css', 'web/server.js', 'web/index.html'];
for (const f of files) {
  if (!existsSync(f)) { console.log(f + '  不存在'); continue; }
  const lines = readFileSync(f, 'utf8').split(/\r?\n/);
  const blank = lines.filter(l => !l.trim()).length;
  const comment = lines.filter(l => { const t = l.trim(); return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*'); }).length;
  console.log(f + '  ' + lines.length + ' 行（有效 ' + (lines.length - blank - comment) + '，注释 ' + comment + '，空行 ' + blank + '）');
}
