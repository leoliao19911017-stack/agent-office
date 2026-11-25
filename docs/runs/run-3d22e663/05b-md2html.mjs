// 把 dev-report 的 Markdown 子集转成自包含 HTML（同一份源，避免两版内容各写各的）。
// 支持：#/##/### 标题、段落、> 引用、| 表格 |、围栏代码、- / 1. 列表（两级）、--- 分隔线、**粗体**、`代码`、[链接](路径)。
// 用法：node docs/runs/run-3d22e663/05b-md2html.mjs <源.md> <目标.html> [gallery]
// （gallery = 在第九节末尾内嵌 docs/screenshots/tasks-workflow-link/ 的截图；路径相对 HTML 文件）
import { readFileSync, writeFileSync } from 'node:fs';

const [src, dest, withGallery] = process.argv.slice(2);
const md = readFileSync(src, 'utf8').replace(/\r\n/g, '\n');
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PLACE = '\u0000';

function inline(text) {
  const codes = [];
  let out = esc(text).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `${PLACE}${codes.length - 1}${PLACE}`; });
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[Number(i)])}</code>`);
}

const lines = md.split('\n');
const body = [];
const toc = [];
let i = 0;
let para = [];
const slug = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
const flushPara = () => { if (para.length) { body.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };

while (i < lines.length) {
  const line = lines[i];
  if (/^```/.test(line)) {
    flushPara();
    const lang = line.slice(3).trim();
    const buf = [];
    i += 1;
    while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i += 1; }
    i += 1;
    body.push(`<details class="code" open><summary>${esc(lang || 'text')} · 点击折叠</summary><pre><code>${esc(buf.join('\n'))}</code></pre></details>`);
    continue;
  }
  const h = /^(#{1,3}) (.+)$/.exec(line);
  if (h) {
    flushPara();
    const level = h[1].length;
    const id = `s-${slug(h[2]).slice(0, 60)}-${body.length}`;
    if (level === 2) toc.push({ id, text: h[2] });
    body.push(`<h${level} id="${id}">${inline(h[2])}</h${level}>`);
    i += 1;
    continue;
  }
  if (/^---+$/.test(line)) { flushPara(); body.push('<hr>'); i += 1; continue; }
  if (/^> ?/.test(line)) {
    flushPara();
    const buf = [];
    while (i < lines.length && /^> ?/.test(lines[i])) { buf.push(lines[i].replace(/^> ?/, '')); i += 1; }
    body.push(`<blockquote>${buf.map((l) => `<p>${inline(l)}</p>`).join('')}</blockquote>`);
    continue;
  }
  if (/^\|/.test(line)) {
    flushPara();
    const rows = [];
    while (i < lines.length && /^\|/.test(lines[i])) { rows.push(lines[i]); i += 1; }
    const cells = (r) => r.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    const head = cells(rows[0]);
    const data = rows.slice(2).map(cells);
    const headHtml = head.map((c) => `<th>${inline(c)}</th>`).join('');
    const rowsHtml = data.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('');
    body.push(`<div class="tw"><table><thead><tr>${headHtml}</tr></thead><tbody>${rowsHtml}</tbody></table></div>`);
    continue;
  }
  if (/^(\s*)([-*]|\d+\.) /.test(line)) {
    flushPara();
    const items = [];
    while (i < lines.length && /^(\s*)([-*]|\d+\.) /.test(lines[i])) {
      const m = /^(\s*)([-*]|\d+\.) (.*)$/.exec(lines[i]);
      items.push({ indent: m[1].length, ordered: /\d/.test(m[2]), text: m[3] });
      i += 1;
    }
    const html = items.map((it) => `${it.indent ? '<li class="sub">' : '<li>'}${inline(it.text)}</li>`).join('');
    body.push(`<ul class="${items[0].ordered ? 'ol' : 'ul'}">${html}</ul>`);
    continue;
  }
  if (line.trim() === '') { flushPara(); i += 1; continue; }
  para.push(line.trim());
  i += 1;
}
flushPara();

// 图库：插在「十、」之前（即第九节末尾）。路径相对 HTML 文件所在目录。
const shotRel = '../../screenshots/tasks-workflow-link/';
const fig = (file, caption) => `<figure><img loading="lazy" src="${shotRel}${file}" alt="${esc(caption)}"><figcaption>${esc(caption)}</figcaption></figure>`;
const galleryHtml = withGallery === 'gallery' ? `
<h3 id="gallery">截图原图</h3>
<div class="gal">
  ${fig('01-db-copy-before-migration.png', '01 迁移前 · 生产库副本（v8）')}
  ${fig('02-db-copy-after-migration.png', '02 迁移后 · 同一副本（v9）')}
  ${fig('03-board-all-tasks-step-tags-1440x900.png', '03 全部任务 · 带步骤标签（1440×900）')}
  ${fig('04-board-filter-by-run-1440x900.png', '04 按选中的 run 过滤（1440×900）')}
  ${fig('05-board-batch-created-1440x900.png', '05 批量建 5 条之后（1440×900）')}
</div>
<div class="gal gal--rails">
  ${fig('03b-rail-all-tasks-step-tags-2x.png', '03b 左栏 2x · 全部任务')}
  ${fig('04b-rail-filter-by-run-2x.png', '04b 左栏 2x · 按 run 过滤')}
  ${fig('05b-rail-batch-created-2x.png', '05b 左栏 2x · 批量之后')}
  ${fig('07-old-backend-guard-rail-2x.png', '07 左栏 2x · 旧后端降级（8090 现状）')}
</div>
<div class="gal gal--wide">
  ${fig('04c-task-detail-workflow-row.png', '04c 任务详情的「工作流」行')}
  ${fig('06-batch-api-response.png', '06 批量建任务接口响应')}
</div>` : '';

let htmlBody = body.join('\n');
const anchor = /<h2 id="[^"]+">十、/.exec(htmlBody);
if (galleryHtml && anchor) htmlBody = `${htmlBody.slice(0, anchor.index)}${galleryHtml}\n${htmlBody.slice(anchor.index)}`;

const title = (/^# (.+)$/m.exec(md) || [null, '报告'])[1];
const css = `
:root{--ink:#2B261F;--ink2:#4A4237;--ink3:#6E6557;--line:#E7E0D5;--bg:#F6F1EA;--card:#FEFCF9;--amber:#8A611D}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.75 "PingFang SC","Microsoft YaHei UI","Microsoft YaHei","Noto Sans SC",sans-serif}
.wrap{display:grid;grid-template-columns:260px minmax(0,1fr);gap:28px;max-width:1320px;margin:0 auto;padding:24px}
nav{position:sticky;top:16px;align-self:start;max-height:calc(100vh - 32px);overflow:auto;font-size:13.5px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}
nav b{display:block;font-size:12px;color:var(--ink3);margin-bottom:6px;letter-spacing:.5px}
nav a{display:block;color:var(--ink2);text-decoration:none;padding:4px 6px;border-radius:6px}
nav a:hover{background:#F3EDE3;color:var(--amber)}
nav .tools{margin-top:10px;display:flex;flex-direction:column;gap:6px}
nav button{font:inherit;font-size:12.5px;text-align:left;padding:5px 8px;border:1px solid var(--line);border-radius:7px;background:#FCFAF6;color:var(--ink2);cursor:pointer}
nav button:hover{background:#F3EDE3}
nav input{font:inherit;font-size:13px;padding:6px 8px;border:1px solid var(--line);border-radius:7px;width:100%}
main{min-width:0;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:30px 36px 40px}
h1{font-size:27px;line-height:1.35;margin:0 0 10px}
h2{font-size:20px;margin:38px 0 12px;padding-top:14px;border-top:1px solid var(--line)}
h3{font-size:16.5px;margin:24px 0 8px;color:var(--ink2)}
p{margin:0 0 12px}
blockquote{margin:0 0 16px;padding:10px 16px;border-left:3px solid var(--amber);background:#FFF9EC;border-radius:0 10px 10px 0;color:var(--ink2)}
blockquote p{margin:0}
code{font:13px/1.6 "Cascadia Mono",Consolas,"Microsoft YaHei UI",monospace;background:#F3EDE3;padding:1px 5px;border-radius:4px}
pre{margin:0;padding:14px 16px;overflow:auto;background:#2B261F;color:#F3EDE3;border-radius:0 0 10px 10px;font:13px/1.65 "Cascadia Mono",Consolas,"Microsoft YaHei UI",monospace}
pre code{background:none;padding:0;color:inherit;font-size:inherit}
details.code{margin:0 0 14px;border:1px solid var(--line);border-radius:10px;background:#FCFAF6}
details.code summary{cursor:pointer;padding:7px 12px;font-size:12.5px;color:var(--ink3);user-select:none}
details.code[open] summary{border-bottom:1px solid var(--line)}
ul,ol{margin:0 0 14px;padding-left:24px}
li{margin:4px 0}
li.sub{list-style:disc;opacity:.92}
.tw{overflow-x:auto;margin:0 0 16px;border:1px solid var(--line);border-radius:10px}
table{border-collapse:collapse;width:100%;font-size:14px;background:var(--card)}
th,td{padding:8px 12px;border-bottom:1px solid #EEE8DE;text-align:left;vertical-align:top}
th{background:#F3EDE3;color:var(--ink3);font-weight:600;white-space:nowrap}
tr:nth-child(even) td{background:#FCFAF6}
hr{border:0;border-top:1px solid var(--line);margin:28px 0}
mark{background:#FBEBCB;color:inherit;padding:0 1px}
.gal{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px;margin:12px 0 18px}
.gal--rails{grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
figure{margin:0;background:#FCFAF6;border:1px solid var(--line);border-radius:10px;padding:8px}
figure img{display:block;width:100%;height:auto;border:1px solid var(--line);border-radius:6px;background:#fff}
figcaption{font-size:12.5px;color:var(--ink3);margin-top:6px}
#count{font-size:12.5px;color:var(--ink3)}
@media (max-width:900px){.wrap{grid-template-columns:1fr}nav{position:static;max-height:none}main{padding:20px}}
@media print{nav{display:none}.wrap{display:block}main{border:0}}
`;
const js = `
(function () {
  var main = document.querySelector('main');
  var q = document.getElementById('q');
  var count = document.getElementById('count');
  function clear() {
    main.querySelectorAll('mark').forEach(function (m) {
      var p = m.parentNode;
      p.replaceChild(document.createTextNode(m.textContent), m);
      p.normalize();
    });
  }
  q.addEventListener('input', function () {
    clear();
    var v = q.value.trim();
    if (!v) { count.textContent = ''; return; }
    var n = 0;
    var w = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    var parts = [];
    var node;
    while ((node = w.nextNode())) {
      if (node.parentNode.closest('script,style')) continue;
      if (node.nodeValue.indexOf(v) >= 0) parts.push(node);
    }
    parts.forEach(function (textNode) {
      var frag = document.createDocumentFragment();
      var text = textNode.nodeValue;
      var idx = 0;
      for (;;) {
        var at = text.indexOf(v, idx);
        if (at < 0) { frag.appendChild(document.createTextNode(text.slice(idx))); break; }
        frag.appendChild(document.createTextNode(text.slice(idx, at)));
        var m = document.createElement('mark');
        m.textContent = text.substr(at, v.length);
        frag.appendChild(m);
        n += 1;
        idx = at + v.length;
      }
      textNode.parentNode.replaceChild(frag, textNode);
    });
    count.textContent = n ? ('匹配 ' + n + ' 处') : '无匹配';
  });
  function all(open) { main.querySelectorAll('details.code').forEach(function (d) { d.open = open; }); }
  document.getElementById('collapse').addEventListener('click', function () { all(false); });
  document.getElementById('expand').addEventListener('click', function () { all(true); });
})();
`;
const navLinks = toc.map((t) => `<a href="#${t.id}">${esc(t.text.replace(/`/g, ''))}</a>`).join('');
const doc = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${css}</style></head>
<body><div class="wrap">
<nav><b>目录</b>${navLinks}
<div class="tools"><input id="q" type="search" placeholder="页内搜索（高亮）"><span id="count"></span>
<button id="collapse" type="button">折叠所有代码块</button><button id="expand" type="button">展开所有代码块</button></div></nav>
<main>${htmlBody}</main>
</div>
<script>${js}</script></body></html>`;
writeFileSync(dest, doc, 'utf8');
console.log(JSON.stringify({
  dest, bytes: Buffer.byteLength(doc), h2Sections: toc.length,
  tables: (htmlBody.match(/<table>/g) || []).length,
  codeBlocks: (htmlBody.match(/<details class="code"/g) || []).length,
  figures: (htmlBody.match(/<figure>/g) || []).length,
  galleryInjected: Boolean(galleryHtml && anchor),
  leftOverFences: (htmlBody.match(/```/g) || []).length,
  leftOverTablePipes: (htmlBody.match(/^\|/gm) || []).length,
}));
