/* 逸刻 · 启动：先读版本与存储，再启动主程序 */
(function () {
  'use strict';
  var started = false;
  function go() { if (started) return; started = true; try { MT.applyWindowInfo(); } catch (e) {} window.__edBoot(); }
  MT.preload(['ed2_v4', 'ed2_col', 'ed2_mute', 'ed2_open', 'ed2_rec']).then(go, go);
  setTimeout(function () { if (!started) { MT.abortPreload(); go(); } }, 6000); /* 存储接口长时间无响应：本次会话降级为浏览器存储，避免覆盖平台存储 */
})();
