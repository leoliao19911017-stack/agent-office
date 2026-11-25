/* 逸刻 · 小红书小工具平台适配层（经典脚本，ES2017） */
(function () {
  'use strict';
  var STORAGE_MIN = 9460, WININFO_MIN = 9490, VIBRATE_MIN = 9500;
  function tool() { var x = window.xhs; return x && x.miniTool ? x.miniTool : null; }
  function has(name) { var m = tool(); return !!(m && typeof m[name] === 'function'); }
  function readBuildVersion(o) { var e = o && o.miniToolEnv; return Number(e && e.buildVersion) || 0; }
  var BV = null;
  function getBuildVersion() {
    if (BV !== null) return Promise.resolve(BV);
    var x = window.xhs, s = readBuildVersion(x && x.launchOptions);
    if (s) { BV = s; return Promise.resolve(BV); }
    if (!has('getLaunchOptions')) { BV = 0; return Promise.resolve(0); }
    return Promise.resolve().then(function () { return tool().getLaunchOptions(); })
      .then(function (o) { BV = readBuildVersion(o); return BV; }, function () { BV = 0; return 0; });
  }
  function atLeast(min) { return Math.floor((BV || 0) / 1000) >= min; }

  /* ---------- storage：9.46+ 用 Storage JS API，低版本降级 localStorage ---------- */
  var useApi = false, cache = {}, timers = {}, aborted = false;
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function preload(keys) {
    return getBuildVersion().then(function () {
      useApi = atLeast(STORAGE_MIN) && has('getStorage') && has('setStorage');
      return Promise.all(keys.map(function (k) {
        if (!useApi) { cache[k] = lsGet(k); return null; }
        return Promise.resolve().then(function () { return tool().getStorage({ key: k }); })
          .then(function (r) { return r && typeof r.data === 'string' ? r.data : null; }, function () { return null; })
          .then(function (v) {
            if (aborted) return;
            if (v == null) { /* 低版本升级后的一次性迁移 */
              var old = lsGet(k);
              if (old != null) { v = old; write(k, old); }
            }
            cache[k] = v;
          });
      }));
    }).catch(function () {});
  }
  function write(k, s) {
    if (!useApi) return Promise.resolve(lsSet(k, s));
    return Promise.resolve().then(function () { return tool().setStorage({ key: k, data: s }); })
      .then(function () { return true; }, function () { return false; });
  }
  function flushKey(k) { clearTimeout(timers[k]); delete timers[k]; return write(k, cache[k]); }
  function flushAll() { Object.keys(timers).forEach(flushKey); }
  document.addEventListener('visibilitychange', function () { if (document.hidden) flushAll(); });
  window.addEventListener('pagehide', flushAll);

  /* ---------- 振动：9.50+ vibrateShort，限频 ---------- */
  var lastBuzz = 0;
  function vibrate(type) {
    var n = Date.now(); if (n - lastBuzz < 90) return; lastBuzz = n;
    if (atLeast(VIBRATE_MIN) && has('vibrateShort')) {
      Promise.resolve().then(function () { return tool().vibrateShort({ type: type }); }).catch(function () {});
    }
  }

  /* ---------- 窗口信息：9.49+，避让容器顶部按钮 ---------- */
  function applyWindowInfo() {
    if (!atLeast(WININFO_MIN) || !has('getWindowInfo')) return;
    Promise.resolve().then(function () { return tool().getWindowInfo(); }).then(function (info) {
      if (!info) return;
      var top = info.safeArea && typeof info.safeArea.top === 'number' ? info.safeArea.top : 0;
      var mb = info.menuButtons || {};
      ['back', 'me', 'share'].forEach(function (k) { var r = mb[k]; if (r && typeof r.bottom === 'number') top = Math.max(top, r.bottom + 6); });
      document.documentElement.style.setProperty('--mt-top', Math.round(top) + 'px');
    }).catch(function () {});
  }
  var rsT = 0;
  window.addEventListener('resize', function () { clearTimeout(rsT); rsT = setTimeout(applyWindowInfo, 200); });

  /* ---------- 图片：保存到相册 / 发布笔记 ---------- */
  function toFile(dataUrl) {
    if (!has('writeTempFile')) return Promise.resolve(dataUrl);
    return Promise.resolve().then(function () { return tool().writeTempFile({ data: dataUrl }); })
      .then(function (r) { return r && r.filePath ? r.filePath : dataUrl; }, function () { return dataUrl; });
  }
  function saveImage(dataUrl) {
    if (!has('saveImageToPhotosAlbum')) return Promise.reject({ errMsg: 'unsupported' });
    return toFile(dataUrl).then(function (p) { return tool().saveImageToPhotosAlbum({ filePath: p }); });
  }
  function postImageNote(dataUrl, title, content) {
    if (!has('postNote')) return Promise.reject({ errMsg: 'unsupported' });
    return toFile(dataUrl).then(function (p) {
      return tool().postNote({ title: String(title || '').slice(0, 20), content: String(content || '').slice(0, 1000), pageType: 'photo_publish', mediaInfo: { image_resources: [{ url: p }] } });
    });
  }

  /* ---------- Flex gap 行为检测（Chrome 61 基线回退） ---------- */
  function flexGap() {
    var f = document.createElement('div');
    f.style.position = 'absolute'; f.style.visibility = 'hidden'; f.style.display = 'flex'; f.style.flexDirection = 'column'; f.style.rowGap = '1px';
    f.appendChild(document.createElement('div')); f.appendChild(document.createElement('div'));
    document.body.appendChild(f); var ok = f.scrollHeight === 1; f.parentNode.removeChild(f); return ok;
  }
  function supports(p, v) { try { return !!(window.CSS && CSS.supports && CSS.supports(p, v)); } catch (e) { return false; } }

  window.MT = {
    preload: preload,
    abortPreload: function () { aborted = true; useApi = false; Object.keys(cache).forEach(function (k) { delete cache[k]; }); },
    get: function (k) { return Object.prototype.hasOwnProperty.call(cache, k) ? cache[k] : null; },
    set: function (k, s) { cache[k] = s; clearTimeout(timers[k]); timers[k] = setTimeout(function () { flushKey(k); }, 250); },
    vibrate: vibrate, applyWindowInfo: applyWindowInfo, saveImage: saveImage, postImageNote: postImageNote,
    canSave: function () { return has('saveImageToPhotosAlbum'); }, canPost: function () { return has('postNote'); },
    flexGap: flexGap, supports: supports, version: function () { return BV || 0; }
  };
})();
