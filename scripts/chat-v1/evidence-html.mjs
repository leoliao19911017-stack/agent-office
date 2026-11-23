// evidence-html.mjs — 把验收证据的 Markdown 转成给人看的 HTML（全局规则：知识文档 md + html 双版本，同名同目录）。
// 只支持证据文档用得到的那一小块 Markdown：标题、段落、围栏代码、列表、表格、引用、行内代码 / 粗体 / 链接。
// 纯文本转义后再拼 HTML，不引第三方库。用法：
//   node scripts/chat-v1/evidence-html.mjs <in.md> <out.html> [页面标题]
//   或在脚本里 import { markdownToHtml, evidencePage }
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 行内：`code`、**粗体**、[文字](链接)。先切出行内代码（里面不再解释其它标记） */
function inline(text) {
  const parts = [];
  let rest = String(text);
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/;
  let m;
  while ((m = re.exec(rest))) {
    parts.push(esc(rest.slice(0, m.index)));
    if (m[1] !== undefined) parts.push(`<code>${esc(m[1])}</code>`);
    else if (m[2] !== undefined) parts.push(`<strong>${inline(m[2])}</strong>`);
    else parts.push(`<a href="${esc(m[4])}" target="_blank" rel="noopener">${esc(m[3])}</a>`);
    rest = rest.slice(m.index + m[0].length);
  }
  parts.push(esc(rest));
  return parts.join('');
}

export function markdownToHtml(md) {
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  let inCode = false;
  let code = [];
  let list = null;      // 'ul' | 'ol'
  let para = [];
  let table = [];

  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const closeList = () => { if (list) { out.push(list === 'ul' ? '</ul>' : '</ol>'); list = null; } };
  const flushTable = () => {
    if (!table.length) return;
    const head = table[0];
    const body = table.slice(1).filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r));
    const cells = (row) => row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
    out.push('<div class="table-wrap"><table>');
    out.push(`<thead><tr>${cells(head).map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>`);
    if (body.length) {
      out.push('<tbody>');
      for (const row of body) {
        const cs = cells(row);
        const rowCls = cs.some((c) => /^\s*❌/.test(c)) ? ' class="bad"' : cs.some((c) => /^\s*✅/.test(c)) ? ' class="good"' : '';
        out.push(`<tr${rowCls}>${cs.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`);
      }
      out.push('</tbody>');
    }
    out.push('</table></div>');
    table = [];
  };
  const needClose = () => { flushPara(); closeList(); flushTable(); };

  for (; i < lines.length; i += 1) {
    const line = lines[i];
    if (inCode) {
      if (/^```/.test(line)) { out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`); code = []; inCode = false; }
      else code.push(line);
      continue;
    }
    if (/^```/.test(line)) { needClose(); inCode = true; continue; }
    if (/^\s*\|/.test(line) && /\|\s*$/.test(line)) { flushPara(); closeList(); table.push(line); continue; }
    if (table.length) flushTable();
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { needClose(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    if (/^>\s?/.test(line)) { needClose(); out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`); continue; }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) { needClose(); out.push('<hr>'); continue; }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const kind = ul ? 'ul' : 'ol';
      if (list && list !== kind) closeList();
      if (!list) { out.push(kind === 'ul' ? '<ul>' : '<ol>'); list = kind; }
      const text = (ul ? ul[1] : ol[1]).replace(/\s+$/, '');
      const cls = /^\s*(✅|PASS)/.test(text) ? ' class="good"' : /^\s*(❌|FAIL)/.test(text) ? ' class="bad"' : '';
      out.push(`<li${cls}>${inline(text)}</li>`);
      continue;
    }
    if (line.trim() === '') { needClose(); continue; }
    closeList();
    para.push(line.trim());
  }
  if (inCode) out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
  needClose();
  return out.join('\n');
}

const CSS = `
:root { --fg:#262626; --muted:#686868; --border:rgba(0,0,0,.08); --bg:#fff; --soft:rgba(0,0,0,.04);
  --ok:#047857; --bad:#b91c1c; --warn:#b45309; --info:#1d4ed8; }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.7 "PingFang SC","Microsoft YaHei UI","Microsoft YaHei","Noto Sans SC",sans-serif; }
main { max-width: 980px; margin: 0 auto; padding: 32px 28px 80px; }
h1 { font-size:26px; line-height:1.3; margin:0 0 6px; }
h2 { font-size:19px; margin:34px 0 10px; padding-top:18px; border-top:1px solid var(--border); }
h3 { font-size:16px; margin:22px 0 8px; }
h4 { font-size:14px; margin:16px 0 6px; color:#404040; }
p { margin:8px 0; }
a { color:var(--info); }
code { font:13px/1.5 "Cascadia Mono",Consolas,"SFMono-Regular",Menlo,monospace; background:var(--soft); border:1px solid var(--border); border-radius:5px; padding:1px 5px; }
pre { background:#fafafa; border:1px solid var(--border); border-radius:12px; padding:14px 16px; overflow:auto; margin:12px 0; }
pre code { background:none; border:0; padding:0; font-size:13px; white-space:pre; }
blockquote { margin:12px 0; padding:10px 16px; border-left:3px solid #d4d4d4; background:var(--soft); border-radius:0 10px 10px 0; color:#404040; }
ul,ol { padding-left:26px; margin:8px 0; }
li { margin:3px 0; }
li.good::marker, tr.good td:first-child { color:var(--ok); }
li.bad::marker, tr.bad td:first-child { color:var(--bad); }
.table-wrap { overflow:auto; margin:12px 0; border:1px solid var(--border); border-radius:12px; }
table { border-collapse:collapse; width:100%; font-size:14px; }
th,td { text-align:left; padding:8px 12px; border-bottom:1px solid var(--border); vertical-align:top; }
th { background:var(--soft); font-weight:600; white-space:nowrap; }
tr:last-child td { border-bottom:0; }
hr { border:0; border-top:1px solid var(--border); margin:26px 0; }
.meta { color:var(--muted); font-size:13px; margin-bottom:14px; }
`;

export function evidencePage(md, { title = '验收证据', meta = '' } = {}) {
  const body = markdownToHtml(md);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
${meta ? `<div class="meta">${esc(meta)}</div>` : ''}
${body}
</main>
</body>
</html>
`;
}

const HERE = dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && resolve(process.argv[1]) === resolve(HERE, 'evidence-html.mjs')) {
  const [inPath, outPath, title] = process.argv.slice(2);
  if (!inPath || !outPath) { console.error('用法：node scripts/chat-v1/evidence-html.mjs <in.md> <out.html> [标题]'); process.exit(2); }
  const md = readFileSync(inPath, 'utf8');
  writeFileSync(outPath, evidencePage(md, { title: title || '验收证据' }), 'utf8');
  console.log(`已生成 ${outPath}（${Buffer.byteLength(md)} 字节 Markdown）`);
}
