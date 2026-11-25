/* 逸刻 · 本地合成环境声（小工具包内不支持音频文件，改为 Web Audio 实时生成缓冲） */
(function () {
  'use strict';
  function rng(seed) { var s = seed >>> 0 || 1; return function () { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
  function hash(str) { var h = 2166136261; for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function loopify(d, n, x) { var o = new Float32Array(n); for (var i = 0; i < n; i++) o[i] = d[i]; for (var j = 0; j < x; j++) { var a = j / x; o[j] = d[j] * a + d[n + j] * (1 - a); } return o; }
  function norm(d, peak) { var m = 0; for (var i = 0; i < d.length; i++) { var v = Math.abs(d[i]); if (v > m) m = v; } if (m > 0) { var k = peak / m; for (var j = 0; j < d.length; j++) d[j] *= k; } return d; }
  function lp(a) { var y = 0; return function (x) { y += a * (x - y); return y; }; }
  function coef(f, sr) { return 1 - Math.exp(-2 * Math.PI * f / sr); }

  var GEN = {
    rain: function (sr, r) {
      var L = 12, X = sr, n = sr * L, d = new Float32Array(n + X), h1 = lp(coef(5200, sr)), h2 = lp(coef(420, sr)), b = lp(coef(900, sr));
      for (var i = 0; i < n + X; i++) { var w = r() * 2 - 1, hi = h1(w) - h2(w); d[i] = hi * 0.55 + b(w) * 0.25; }
      var drops = Math.floor(L * 40);
      for (var k = 0; k < drops; k++) { var t = Math.floor(r() * (n + X - 2000)), f = 1800 + r() * 3200, a = 0.15 + r() * 0.35, len = Math.floor(sr * (0.006 + r() * 0.02));
        for (var j = 0; j < len; j++) d[t + j] += Math.sin(2 * Math.PI * f * j / sr) * a * Math.exp(-j / (len * 0.25)); }
      return norm(loopify(d, n, X), 0.7);
    },
    waves: function (sr, r) {
      var L = 16, X = sr * 2, n = sr * L, d = new Float32Array(n + X), br = 0, f = lp(coef(600, sr)), f2 = lp(coef(2400, sr));
      for (var i = 0; i < n + X; i++) { var w = r() * 2 - 1; br = (br + 0.02 * w) * 0.997; var tt = i / sr, env = Math.pow(0.5 + 0.5 * Math.sin(2 * Math.PI * tt / 8 - 1.2), 2.2);
        d[i] = f(br * 6) * (0.35 + 0.65 * env) + f2(w) * 0.12 * env; }
      return norm(loopify(d, n, X), 0.7);
    },
    fire: function (sr, r) {
      var L = 12, X = sr, n = sr * L, d = new Float32Array(n + X), br = 0, f = lp(coef(260, sr));
      for (var i = 0; i < n + X; i++) { var w = r() * 2 - 1; br = (br + 0.02 * w) * 0.996; d[i] = f(br * 7) * 0.8; }
      var pops = Math.floor(L * 26);
      for (var k = 0; k < pops; k++) { var t = Math.floor(r() * (n + X - 1500)), a = 0.2 + r() * 0.6, len = Math.floor(sr * (0.002 + r() * 0.012)), hp = 0;
        for (var j = 0; j < len; j++) { var z = r() * 2 - 1; hp = z - hp * 0.6; d[t + j] += hp * a * Math.exp(-j / (len * 0.3)); } }
      return norm(loopify(d, n, X), 0.65);
    },
    forest: function (sr, r) {
      var L = 16, X = sr * 2, n = sr * L, d = new Float32Array(n + X), f = lp(coef(900, sr)), g = lp(coef(140, sr));
      for (var i = 0; i < n + X; i++) { var w = r() * 2 - 1, tt = i / sr, gust = 0.55 + 0.45 * Math.sin(2 * Math.PI * tt / 5.3) * Math.sin(2 * Math.PI * tt / 11.7 + 1); d[i] = (f(w) - g(w)) * 0.5 * gust; }
      var birds = 7;
      for (var k = 0; k < birds; k++) { var t0 = Math.floor(r() * (n - sr)), f0 = 2600 + r() * 1800, notes = 2 + Math.floor(r() * 4);
        for (var q = 0; q < notes; q++) { var st = t0 + Math.floor(q * sr * (0.11 + r() * 0.05)), len = Math.floor(sr * (0.06 + r() * 0.05)), ph = 0;
          for (var j = 0; j < len; j++) { var p = j / len, fr = f0 * (1 + 0.35 * Math.sin(Math.PI * p)) * (1 + 0.04 * Math.sin(2 * Math.PI * 38 * j / sr)); ph += 2 * Math.PI * fr / sr;
            d[st + j] += Math.sin(ph) * 0.22 * Math.sin(Math.PI * p); } } }
      return norm(loopify(d, n, X), 0.6);
    },
    chime: function (sr) {
      var L = 4, n = sr * L, d = new Float32Array(n), notes = [[0, 1318.5], [0.18, 1975.5]], P = [[1, 1], [2.76, 0.45], [5.4, 0.22], [8.93, 0.1]];
      notes.forEach(function (nt) { var s = Math.floor(nt[0] * sr); for (var j = 0; s + j < n; j++) { var t = j / sr, v = 0; for (var k = 0; k < P.length; k++) v += Math.sin(2 * Math.PI * nt[1] * P[k][0] * t) * P[k][1] * Math.exp(-t * (1.2 + k * 1.5)); d[s + j] += v * Math.min(1, j / 40); } });
      return norm(d, 0.8);
    },
    pad: function (sr, r, key) {
      var L = 32, X = sr * 4, n = sr * L, d = new Float32Array(n + X), h = hash(key);
      var scales = [[0, 4, 7, 11, 14], [0, 3, 7, 10, 14], [0, 5, 7, 12, 16], [0, 4, 9, 11, 16]], sc = scales[h % 4], base = 110 * Math.pow(2, ((h >>> 3) % 7) / 12);
      var chord = [base / 2, base, base * Math.pow(2, sc[1] / 12), base * Math.pow(2, sc[2] / 12), base * Math.pow(2, sc[3] / 12)];
      for (var i = 0; i < n + X; i++) { var t = i / sr, v = 0; for (var c = 0; c < chord.length; c++) { var tr = 0.6 + 0.4 * Math.sin(2 * Math.PI * t / (7 + c * 2.3) + c); v += (Math.sin(2 * Math.PI * chord[c] * t) + 0.18 * Math.sin(4 * Math.PI * chord[c] * t)) * tr * (c === 0 ? 0.5 : 0.28); } d[i] = v; }
      var bells = 12; for (var k = 0; k < bells; k++) { var st = Math.floor((k + r() * 0.6) * (n / bells)), fr = base * 4 * Math.pow(2, sc[Math.floor(r() * sc.length)] / 12);
        for (var j = 0; j < sr * 3 && st + j < n + X; j++) { var tt = j / sr; d[st + j] += Math.sin(2 * Math.PI * fr * tt) * 0.16 * Math.exp(-tt * 1.6) * Math.min(1, j / 200); } }
      return norm(loopify(d, n, X), 0.55);
    }
  };
  var CACHE = {};
  window.SYNTH = function (ac, url) {
    var m = /^(amb|bgm)\/([\w-]+)\.mp3$/.exec(url); if (!m) return Promise.resolve(null);
    var kind = m[1] === 'bgm' ? 'pad' : m[2], key = m[2];
    if (!GEN[kind]) return Promise.resolve(null);
    var ck = kind + ':' + key; if (CACHE[ck]) return CACHE[ck];
    return CACHE[ck] = new Promise(function (res) {
      setTimeout(function () {
        try { var sr = Math.min(ac.sampleRate, 32000), data = GEN[kind](sr, rng(hash(ck) + 7), key), b = ac.createBuffer(1, data.length, sr); b.getChannelData(0).set(data); res(b); }
        catch (e) { delete CACHE[ck]; res(null); }
      }, 0);
    });
  };
})();
