/* 逸刻 · Chrome 61 基线回退：容器单位变量、aspect-ratio、scroll-snap、Flex gap（仅在不支持时启用） */
(function () {
  'use strict';
  var S = window.MT ? MT.supports : function () { return false; };
  var root = document.documentElement;
  var noCQ = !S('width', '1cqw'), noAR = !S('aspect-ratio', '1 / 1'), noSnap = !S('scroll-snap-type', 'x mandatory');
  if (!(window.MT && MT.flexGap())) root.classList.add('nfg');
  if (noCQ) root.classList.add('ncq');

  var CONT = '.stage,#gal,#det';
  var AR = [['.cv', null], ['.lamp', 640 / 246], ['.sealT', 1], ['.sealT .sq', 1], ['.stamped', 1], ['.pg .th', 1], ['.ivh', 16 / 9]];

  function px(v) { return (Math.round(v * 1000) / 1000) + 'px'; }
  function updCQ() {
    var list = document.querySelectorAll(CONT);
    for (var i = 0; i < list.length; i++) {
      var el = list[i], p = el.parentElement, pc = null;
      while (p) { if (p.matches && p.matches(CONT)) { pc = p; break; } p = p.parentElement; }
      var pw = pc ? pc.clientWidth : window.innerWidth, ph = pc ? pc.clientHeight : window.innerHeight;
      el.style.setProperty('--pcqw', px(pw / 100)); el.style.setProperty('--pcqh', px(ph / 100));
      var w = el.clientWidth, h = el.clientHeight;
      el.style.setProperty('--cqw', px(w / 100)); el.style.setProperty('--cqh', px(h / 100));
      el.style.setProperty('--cqmin', px(Math.min(w, h) / 100)); el.style.setProperty('--cqmax', px(Math.max(w, h) / 100));
      el.style.setProperty('--cqu', px(Math.min(h / 100, 2.05 * w / 100)));
    }
  }
  function updAR() {
    for (var k = 0; k < AR.length; k++) {
      var els = document.querySelectorAll(AR[k][0]);
      for (var j = 0; j < els.length; j++) {
        var el = els[j], r = AR[k][1];
        if (r === null) r = parseFloat(getComputedStyle(el).getPropertyValue('--ar')) || 1;
        var w = el.getBoundingClientRect().width;
        if (w > 0) el.style.height = px(w / r);
      }
    }
  }
  var busy = false;
  function update() {
    if (busy) return; busy = true;
    try { if (noCQ) { updCQ(); updCQ(); } if (noAR) updAR(); } catch (e) {}
    busy = false;
  }
  if (noCQ || noAR) {
    var mo = new MutationObserver(function () { update(); });
    var start = function () { mo.observe(document.body, { childList: true, subtree: true }); update(); };
    if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
    window.addEventListener('resize', function () { update(); setTimeout(update, 120); });
    window.addEventListener('load', update);
  }

  /* scroll-snap 回退：滚动停止后吸附到最近的一项 */
  if (noSnap) {
    var SNAP = [['.car', '.slide', 'center'], ['.room .hall', '.intro,.grp', 'center']];
    var touching = false, tm = 0;
    document.addEventListener('touchstart', function () { touching = true; }, { passive: true, capture: true });
    document.addEventListener('touchend', function () { touching = false; }, { passive: true, capture: true });
    document.addEventListener('scroll', function (e) {
      var t = e.target; if (!t || !t.matches) return;
      for (var i = 0; i < SNAP.length; i++) {
        if (!t.matches(SNAP[i][0])) continue;
        var cfg = SNAP[i]; clearTimeout(tm);
        tm = setTimeout(function wait() {
          if (touching) { tm = setTimeout(wait, 80); return; }
          var items = t.querySelectorAll(cfg[1]), c = t.scrollLeft + t.clientWidth / 2, best = null, bd = 1e9;
          for (var j = 0; j < items.length; j++) {
            var it = items[j]; if (it.parentElement !== t && it.parentElement.parentElement !== t) continue;
            var d = Math.abs(it.offsetLeft + it.offsetWidth / 2 - c); if (d < bd) { bd = d; best = it; }
          }
          if (best && bd > 2) t.scrollTo({ left: best.offsetLeft + best.offsetWidth / 2 - t.clientWidth / 2, behavior: 'smooth' });
        }, 140);
        return;
      }
    }, true);
  }
  window.CompatUpdate = update;
})();
