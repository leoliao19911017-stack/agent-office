/* R90 主题切换：浅色（默认）/ 深色，存 localStorage，防闪烁由 <head> 内联脚本负责。 */
(function () {
  var KEY = 'agentoffice-theme';
  var root = document.documentElement;

  function apply(theme) {
    if (theme === 'dark') root.setAttribute('data-theme', 'dark');
    else root.removeAttribute('data-theme');
    var btn = document.getElementById('theme-toggle');
    if (btn) {
      btn.textContent = theme === 'dark' ? '☾' : '☀';
      btn.title = theme === 'dark' ? '切到浅色' : '切到深色';
    }
  }

  function current() {
    return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light';
  }

  // 首屏：<html> 上可能已被 head 内联脚本设过，这里再确认一次
  apply(current());

  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('theme-toggle');
    apply(current());
    if (!btn) return;
    btn.addEventListener('click', function () {
      var next = current() === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(KEY, next); } catch (e) { /* 隐私模式：不存也行，本次生效 */ }
      apply(next);
    });
  });
})();
