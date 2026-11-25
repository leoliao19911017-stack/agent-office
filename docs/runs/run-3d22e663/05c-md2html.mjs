// 把 05c 返工报告的 Markdown 子集转成自包含 HTML（同一份源，避免两版内容各写各的）。
// 与 05b-md2html.mjs 同一套排版；差别只有：支持 ![说明](图片路径) 这种图片行（连续几行排成图库），
// 没有 05b 那个写死的截图清单。
// 支持：#/##/### 标题、段落、> 引用、| 表格 |、围栏代码、- / 1. 列表（两级）、--- 分隔线、**粗体**、`代码`、[链接](路径)、![说明](图片)。
// 用法：node docs/runs/run-3d22e663/05c-md2html.mjs <源.md> <目标.html>
import { readFileSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const [src, dest] = process.argv.slice(2);
if (!src || !dest) {
  console.error('用法：node 05c-md2html.mjs <源.md> <目标.html>');
  process.exit(2);
}
const md = readFileSync(src, 'utf8').replace(/\r\n/g, '\n');
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PLACE = '\u0000';
const missing = [];

function inline(text) {
  const codes = [];
  let out = esc(text).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `${PLACE}${codes.length - 1}${PLACE}`; });
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[Number(i)])}</code>`);
}

// 图片路径相对 HTML 文件所在目录；文件不在就记下来（HTML 里照常留一个破图位置的说明，不悄悄吞掉）
function imageHtml(alt, path) {
  const file = join(dirname(dest), path);
  if (!existsSync(file)) missing.push(path);
  return `<figure><img loading="lazy" src="${esc(path)}" alt="${esc(alt)}"><figcaption>${esc(alt)}${existsSync(file) ? '' : '（文件不存在：' + esc(path) + '）'}</figcaption></figure>`;
}

const lines = md.split('\n');
const body = [];
const toc = [];
let i = 0;
let para = [];
const slug = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
const flushPara = () => { if (para.length) { body.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };

while (i < lines.length) {
  const line = lines[i];
  if (/^```/.test(line)) {
    flushPara();
    const lang = line.slice(3).trim();
    const buf = [];
    i += 1;
    while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i += 1; }
    i += 1;
    const open = buf.length <= 14 ? ' open' : '';
    body.push(`<details class="code"${open}><summary>${esc(lang || 'text')} · ${buf.length} 行 · 点击展开 / 折叠</summary><pre><code>${esc(buf.join('\n'))}</code></pre></details>`);
    continue;
  }
  if (/^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/.test(line)) {
    flushPara();
    const figs = [];
    while (i < lines.length && /^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/.test(lines[i])) {
      const m = /^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/.exec(lines[i]);
      figs.push(imageHtml(m[1], m[2]));
      i += 1;
    }
    body.push(`<div class="gal gal--rails">${figs.join('')}</div>`);
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

const title = (/^# (.+)$/m.exec(md) || [null, '报告'])[1];
const css = `
:root{--ink:#2B261F;--ink2:#4A4237;--ink3:#6E6557;--line:#E7E0D5;--bg:#F6F1EA;--card:#FEFCF9;--amber:#8A611D;--bad:#A8543F;--ok:#46603A}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.75 "PingFang SC","Microsoft YaHei UI","Microsoft YaHei","Noto Sans SC",sans-serif}
.wrap{display:grid;grid-template-columns:270px minmax(0,1fr);gap:28px;max-width:1340px;margin:0 auto;padding:24px}
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
pre{margin:0;padding:14px 16px;overflow:auto;background:#2B261F;color:#F3EDE3;border-radius:0 0 10px 10px;font:12.5px/1.65 "Cascadia Mono",Consolas,"Microsoft YaHei UI",monospace}
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
.gal--rails{grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
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
<main>${body.join('\n')}</main>
</div>
<script>${js}</script></body></html>`;
writeFileSync(dest, doc, 'utf8');
console.log(JSON.stringify({
  dest, bytes: Buffer.byteLength(doc), h2Sections: toc.length,
  tables: (doc.match(/<table>/g) || []).length,
  codeBlocks: (doc.match(/<details class="code"/g) || []).length,
  figures: (doc.match(/<figure>/g) || []).length,
  missingImages: missing,
}, null, 1));
