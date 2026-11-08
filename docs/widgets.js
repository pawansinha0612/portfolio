/* Interactive widgets for blog posts.
   A post includes <div data-widget="name"></div> (with fallback text inside); this script replaces it.
   blog/build.py adds this script only to posts that contain a widget. */
(function () {
  'use strict';

  var CSS = '\
.widget{margin:24px 0 28px;border:1px solid var(--border);border-radius:16px;background:var(--surface);padding:18px 18px 14px;box-shadow:var(--shadow);font-size:15px;line-height:1.5}\
.widget h4{margin:0 0 2px;font-size:16px}\
.widget .w-sub{margin:0 0 14px;color:var(--muted);font-size:14px}\
.widget .w-controls{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px 18px;margin-bottom:14px}\
.widget label{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--muted);font-weight:500}\
.widget .w-row{display:flex;justify-content:space-between;gap:8px}\
.widget .w-row b{color:var(--text);white-space:nowrap;font-variant-numeric:tabular-nums}\
.widget input[type=range]{width:100%;accent-color:var(--accent)}\
.widget input[type=number]{width:100%;box-sizing:border-box;font:inherit;color:var(--text);background:var(--alt);border:1px solid var(--border);border-radius:8px;padding:6px 8px}\
.widget label.w-check{flex-direction:row;align-items:center;gap:8px;color:var(--text)}\
.widget .w-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin-bottom:12px}\
.widget .w-stat{background:var(--alt);border-radius:10px;padding:8px 10px}\
.widget .w-stat span{display:block;font-size:12px;color:var(--muted)}\
.widget .w-stat b{font-size:18px;font-variant-numeric:tabular-nums}\
.widget .w-stat.warn{background:var(--warn-bg)}.widget .w-stat.warn b{color:var(--warn)}\
.widget .w-stat.ok b{color:var(--ok)}\
.widget .w-note{margin:10px 0 0;font-size:14px;padding:8px 12px;border-radius:10px;background:var(--alt)}\
.widget .w-note.warn{background:var(--warn-bg);color:var(--warn)}\
.widget svg{width:100%;height:auto;display:block;margin-top:4px}\
.widget svg text{fill:var(--muted);font:12px Inter,system-ui,sans-serif}\
.widget .w-legend{display:flex;flex-wrap:wrap;gap:14px;font-size:13px;color:var(--muted);margin:2px 0 0}\
.widget .w-legend i{display:inline-block;width:14px;height:4px;border-radius:2px;margin-right:6px;vertical-align:middle}\
.widget table{margin:10px 0 0;font-size:14px}\
.widget td,.widget th{font-variant-numeric:tabular-nums;padding:4px 14px 4px 0;text-align:left}\
.widget .w-code{margin:4px 0 0;background:var(--alt);border:1px solid var(--border);border-radius:10px;padding:12px 14px;overflow-x:auto;font:500 13px/1.6 "JetBrains Mono",ui-monospace,monospace;color:var(--text)}';

  var SVGNS = 'http://www.w3.org/2000/svg';
  var C = { a: 'var(--accent)', b: 'var(--accent-2)', w: 'var(--warn)', m: 'var(--muted)', g: 'var(--border)' };

  function fmt(n, d) {
    return Number(n).toLocaleString('en-AU', { maximumFractionDigits: d || 0 });
  }
  function ms(v) {
    if (v >= 1000) return fmt(v / 1000, 2) + ' s';
    return fmt(v, v < 10 ? 1 : 0) + ' ms';
  }
  function pct(v, d) { return fmt(v * 100, d === undefined ? 1 : d) + '%'; }

  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k === 'class') e.className = attrs[k];
      else e.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (k) { e.appendChild(k); });
    return e;
  }
  function s(tag, attrs, style) {
    var e = document.createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') e.textContent = attrs[k]; else e.setAttribute(k, attrs[k]);
    });
    Object.keys(style || {}).forEach(function (k) { e.style[k] = style[k]; });
    return e;
  }

  // ---- widget scaffolding ----

  function frame(node, title, sub) {
    node.innerHTML = '';
    node.classList.add('widget');
    node.appendChild(h('h4', { text: title }));
    if (sub) node.appendChild(h('p', { class: 'w-sub', text: sub }));
    var f = { node: node, controls: h('div', { class: 'w-controls' }), out: h('div') };
    node.appendChild(f.controls);
    node.appendChild(f.out);
    return f;
  }

  function range(f, o, onChange) {
    var input = h('input', { type: 'range', min: o.min, max: o.max, step: o.step || 1, value: o.value, 'aria-label': o.label });
    var val = h('b');
    var show = function () { val.textContent = (o.show || fmt)(+input.value); };
    input.addEventListener('input', function () { show(); onChange(); });
    show();
    f.controls.appendChild(h('label', {}, [h('span', { class: 'w-row' }, [h('span', { text: o.label }), val]), input]));
    return function () { return +input.value; };
  }

  function number(f, o, onChange) {
    var attrs = { type: 'number', min: o.min, step: o.step || 'any', value: o.value };
    if (o.max != null) attrs.max = o.max;
    var input = h('input', attrs);
    input.addEventListener('input', onChange);
    f.controls.appendChild(h('label', {}, [h('span', { text: o.label }), input]));
    return function () {
      var v = parseFloat(input.value), lo = o.min || 0, hi = o.max != null ? o.max : Infinity;
      var ok = isFinite(v) && v >= lo && v <= hi;
      input.setAttribute('aria-invalid', ok ? 'false' : 'true');
      input.style.outline = ok ? '' : '2px solid #e5484d';
      return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : o.value;
    };
  }

  function check(f, o, onChange) {
    var input = h('input', { type: 'checkbox' });
    input.checked = !!o.value;
    input.addEventListener('change', onChange);
    f.controls.appendChild(h('label', { class: 'w-check' }, [input, h('span', { text: o.label })]));
    return function () { return input.checked; };
  }

  function stats(parent, defs) {
    var grid = h('div', { class: 'w-stats' });
    var api = {};
    defs.forEach(function (d) {
      var b = h('b', { text: '–' });
      var box = h('div', { class: 'w-stat' }, [h('span', { text: d[1] }), b]);
      grid.appendChild(box);
      api[d[0]] = function (text, cls) { b.textContent = text; box.className = 'w-stat' + (cls ? ' ' + cls : ''); };
    });
    parent.appendChild(grid);
    return api;
  }

  function note(parent) {
    var p = h('p', { class: 'w-note' });
    parent.appendChild(p);
    return function (text, warn) {
      p.textContent = text;
      p.className = 'w-note' + (warn ? ' warn' : '');
      p.style.display = text ? '' : 'none';
    };
  }

  function legend(parent, items) {
    parent.appendChild(h('div', { class: 'w-legend' }, items.map(function (it) {
      var i = h('i'); i.style.background = it[1];
      return h('span', {}, [i, document.createTextNode(it[0])]);
    })));
  }

  // Draw at the container's real width (320–640) so chart text stays readable on phones.
  function chartWidth(host) {
    return Math.round(Math.min(640, Math.max(320, host.clientWidth || 640)));
  }

  function niceTicks(min, max, n) {
    var span = max - min || 1, step = Math.pow(10, Math.floor(Math.log10(span / n)));
    [1, 2, 5, 10].some(function (m) { if (span / (step * m) <= n) { step *= m; return true; } return false; });
    var out = [];
    for (var v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(+v.toPrecision(12));
    return out;
  }

  var clipSeq = 0;

  // Line chart. o: {xMin,xMax,yMin,yMax,logY,xTicks:[[v,label]],yFmt,xTitle,yTitle,series:[{pts,color,dash,width}],hLines:[{y,color,label}],points:[{x,y,color,label}]}
  function lineChart(host, o) {
    var W = chartWidth(host), H = 270, L = 74, R = 16, T = 14, B = 42;
    var ly = o.logY ? Math.log10 : function (v) { return v; };
    var X = function (v) { return L + (v - o.xMin) / (o.xMax - o.xMin) * (W - L - R); };
    var Y = function (v) {
      var r = (ly(Math.max(v, o.logY ? o.yMin : -Infinity)) - ly(o.yMin)) / (ly(o.yMax) - ly(o.yMin));
      return T + (1 - Math.min(Math.max(r, 0), 1)) * (H - T - B);
    };
    // Lines that leave the plot are cut off at its edge (clip path), never flattened onto it: a flattened
    // line would look like the value stops growing.
    var Yraw = function (v) {
      var r = (ly(Math.max(v, o.logY ? o.yMin : -Infinity)) - ly(o.yMin)) / (ly(o.yMax) - ly(o.yMin));
      return T + (1 - Math.min(Math.max(r, -1), 2)) * (H - T - B);
    };
    var svg = s('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img' });
    var clipId = 'wclip' + (++clipSeq);
    var defs = s('defs'), clip = s('clipPath', { id: clipId });
    clip.appendChild(s('rect', { x: L, y: T, width: W - L - R, height: H - T - B }));
    defs.appendChild(clip); svg.appendChild(defs);
    var yTicks = o.logY
      ? (function () { var t = []; for (var p = Math.ceil(Math.log10(o.yMin)); p <= Math.log10(o.yMax); p++) t.push(Math.pow(10, p)); return t; })()
      : niceTicks(o.yMin, o.yMax, 5);
    yTicks.forEach(function (v) {
      svg.appendChild(s('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v) }, { stroke: C.g }));
      svg.appendChild(s('text', { x: L - 6, y: Y(v) + 4, 'text-anchor': 'end', text: (o.yFmt || fmt)(v) }));
    });
    (o.xTicks || niceTicks(o.xMin, o.xMax, 6).map(function (v) { return [v, (o.xFmt || fmt)(v)]; })).forEach(function (t) {
      svg.appendChild(s('text', { x: X(t[0]), y: H - B + 16, 'text-anchor': 'middle', text: t[1] }));
    });
    if (o.xTitle) svg.appendChild(s('text', { x: (L + W - R) / 2, y: H - 6, 'text-anchor': 'middle', text: o.xTitle }));
    if (o.yTitle) svg.appendChild(s('text', { x: 12, y: T + (H - T - B) / 2, 'text-anchor': 'middle', transform: 'rotate(-90 12 ' + (T + (H - T - B) / 2) + ')', text: o.yTitle }));
    (o.hLines || []).forEach(function (l) {
      svg.appendChild(s('line', { x1: L, x2: W - R, y1: Y(l.y), y2: Y(l.y), 'stroke-dasharray': '5 4' }, { stroke: l.color, strokeWidth: 1.5 }));
      if (l.label) svg.appendChild(s('text', { x: W - R - 4, y: Y(l.y) - 6, 'text-anchor': 'end', text: l.label }));
    });
    (o.series || []).forEach(function (se) {
      var d = se.pts.map(function (p, i) { return (i ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Yraw(p[1]).toFixed(1); }).join(' ');
      svg.appendChild(s('path', { d: d, fill: 'none', 'stroke-dasharray': se.dash || '', 'clip-path': 'url(#' + clipId + ')' }, { stroke: se.color, strokeWidth: se.width || 2.5, strokeLinejoin: 'round' }));
    });
    (o.points || []).forEach(function (p) {
      svg.appendChild(s('circle', { cx: X(p.x), cy: Y(p.y), r: 5 }, { fill: p.color, stroke: 'var(--surface)', strokeWidth: 2 }));
      if (p.label) {
        // Put the label under the point when it would sit on a dashed reference line.
        var above = Y(p.y) - 9, clash = (o.hLines || []).some(function (l) { return Math.abs(Y(l.y) - (above - 4)) < 9; });
        var ly2 = clash || above < T + 10 ? Y(p.y) + 19 : above;
        svg.appendChild(s('text', { x: X(p.x) + (X(p.x) > W - 160 ? -8 : 8), y: ly2, 'text-anchor': X(p.x) > W - 160 ? 'end' : 'start', text: p.label }));
      }
    });
    host.innerHTML = '';
    host.appendChild(svg);
  }

  // Grouped bar chart. o: {cats:[], series:[{label,color,vals:[]}], yMax, logY, yMin, yFmt, hLines:[{y,color,label}], yTitle}
  function barChart(host, o) {
    var W = chartWidth(host), H = 250, L = 74, R = 16, T = 14, B = 34;
    var yMin = o.logY ? o.yMin : 0;
    var Y = function (v) {
      var r = o.logY
        ? (Math.log10(Math.max(v, yMin)) - Math.log10(yMin)) / (Math.log10(o.yMax) - Math.log10(yMin))
        : v / o.yMax;
      return T + (1 - Math.min(Math.max(r, 0), 1)) * (H - T - B);
    };
    var svg = s('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img' });
    var ticks = o.logY
      ? (function () { var t = []; for (var p = Math.ceil(Math.log10(yMin)); p <= Math.log10(o.yMax); p++) t.push(Math.pow(10, p)); return t; })()
      : niceTicks(0, o.yMax, 5);
    ticks.forEach(function (v) {
      svg.appendChild(s('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v) }, { stroke: C.g }));
      svg.appendChild(s('text', { x: L - 6, y: Y(v) + 4, 'text-anchor': 'end', text: (o.yFmt || fmt)(v) }));
    });
    if (o.yTitle) svg.appendChild(s('text', { x: 12, y: T + (H - T - B) / 2, 'text-anchor': 'middle', transform: 'rotate(-90 12 ' + (T + (H - T - B) / 2) + ')', text: o.yTitle }));
    var gw = (W - L - R) / o.cats.length, n = o.series.length, bw = Math.min(46, gw * 0.7 / n);
    o.cats.forEach(function (cat, ci) {
      var x0 = L + gw * ci + (gw - bw * n) / 2;
      o.series.forEach(function (se, si) {
        var v = se.vals[ci], y = Y(v);
        svg.appendChild(s('rect', { x: x0 + si * bw + 1, y: y, width: bw - 2, height: Math.max(H - B - y, 0), rx: 3 }, { fill: se.color }));
      });
      var cx = L + gw * ci + gw / 2, words = cat.split(' ');
      if (gw < 140 && words.length > 1) {   // two lines when categories are narrow
        var mid = Math.ceil(words.length / 2);
        svg.appendChild(s('text', { x: cx, y: H - B + 15, 'text-anchor': 'middle', text: words.slice(0, mid).join(' ') }));
        svg.appendChild(s('text', { x: cx, y: H - B + 29, 'text-anchor': 'middle', text: words.slice(mid).join(' ') }));
      } else {
        svg.appendChild(s('text', { x: cx, y: H - B + 18, 'text-anchor': 'middle', text: cat }));
      }
    });
    (o.hLines || []).forEach(function (l) {
      svg.appendChild(s('line', { x1: L, x2: W - R, y1: Y(l.y), y2: Y(l.y), 'stroke-dasharray': '5 4' }, { stroke: l.color, strokeWidth: 1.5 }));
      if (l.label) svg.appendChild(s('text', { x: W - R - 4, y: Y(l.y) - 6, 'text-anchor': 'end', text: l.label }));
    });
    host.innerHTML = '';
    host.appendChild(svg);
  }

  // Math.ceil for results that should be whole numbers: 25 × 2.2 is 55.000000000000004 in floating point, which
  // must not round up to 56.
  function ceilSafe(v) { return Math.ceil(v - 1e-9); }

  function sortedPercentile(sorted, p) {
    if (!sorted.length) return 0;
    var i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
    return sorted[i];
  }

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function debounce(fn, wait) {
    var t;
    return function () { clearTimeout(t); t = setTimeout(fn, wait); };
  }

  // ---- widgets ----

  var W = {};

  W.bottleneck = function (node) {
    var f = frame(node, 'Find the bottleneck tier', 'Service demand per tier sets the ceiling: max throughput = cores ÷ CPU seconds per request.');
    var u = function () { update(); };
    var apiCores = range(f, { label: 'API tier cores', min: 1, max: 32, value: 6 }, u);
    var apiMs = range(f, { label: 'API CPU per request', min: 1, max: 100, value: 20, show: ms }, u);
    var dbCores = range(f, { label: 'Database cores', min: 1, max: 64, value: 8 }, u);
    var dbMs = range(f, { label: 'Database CPU per request', min: 1, max: 100, value: 8, show: ms }, u);
    var load = range(f, { label: 'Offered load', min: 10, max: 1500, step: 10, value: 240, show: function (v) { return fmt(v) + ' req/s'; } }, u);
    var st = stats(f.out, [['api', 'API tier ceiling'], ['db', 'Database ceiling'], ['ua', 'API utilisation'], ['ud', 'Database utilisation']]);
    var chart = h('div'); f.out.appendChild(chart);
    legend(f.out, [['Achieved throughput', C.a], ['Ceiling', C.w]]);
    var say = note(f.out);
    function update() {
      var apiMax = apiCores() / (apiMs() / 1000), dbMax = dbCores() / (dbMs() / 1000);
      var ceil = Math.min(apiMax, dbMax), tier = apiMax <= dbMax ? 'API tier' : 'database';
      // Both tiers see the achieved throughput, which can't exceed the ceiling: the faster tier is never "saturated".
      var x = load(), got = Math.min(x, ceil), ua = got * apiMs() / 1000 / apiCores(), ud = got * dbMs() / 1000 / dbCores();
      st.api(fmt(apiMax) + ' req/s', apiMax <= dbMax ? 'warn' : '');
      st.db(fmt(dbMax) + ' req/s', dbMax < apiMax ? 'warn' : '');
      st.ua(ua >= 1 ? 'saturated' : pct(ua, 0), ua >= 0.8 ? 'warn' : 'ok');
      st.ud(ud >= 1 ? 'saturated' : pct(ud, 0), ud >= 0.8 ? 'warn' : 'ok');
      var xMax = Math.max(1500, ceil * 1.5);
      lineChart(chart, {
        xMin: 0, xMax: xMax, yMin: 0, yMax: Math.max(ceil * 1.25, 10),
        xTitle: 'Offered load (req/s)', yTitle: 'Throughput (req/s)',
        series: [{ pts: [[0, 0], [ceil, ceil], [xMax, ceil]], color: C.a }],
        hLines: [{ y: ceil, color: C.w, label: 'ceiling set by the ' + tier }],
        points: [{ x: Math.min(x, xMax), y: Math.min(x, ceil), color: x >= ceil ? C.w : C.a, label: fmt(x) + ' req/s offered' }],
      });
      if (x >= ceil) say('Offered load is ' + (x > ceil ? 'above' : 'at') + ' the ' + tier + ' ceiling of ' + fmt(ceil) + ' req/s. Throughput flattens and queues grow until requests time out. Tuning the other tier changes nothing.', true);
      else if (Math.max(ua, ud) >= 0.8) say('Below the ceiling, but the ' + (ua >= ud ? 'API tier' : 'database') + ' is at ' + pct(Math.max(ua, ud), 0) + ' utilisation, where queueing delay starts to climb steeply.', true);
      else say('Headroom: you can add about ' + fmt(ceil - x) + ' req/s before the ' + tier + ' saturates.');
    }
    update();
  };

  W.vusers = function (node) {
    var f = frame(node, 'How many virtual users do I need?', 'Little\'s Law: concurrent users = throughput × (response time + think time). Enter your target and get a k6 scenario sized for it.');
    var u = function () { update(); };
    var rate = range(f, { label: 'Target throughput', min: 1, max: 2000, value: 50, show: function (v) { return fmt(v) + ' iterations/s'; } }, u);
    var resp = range(f, { label: 'Response time per iteration (all requests)', min: 50, max: 10000, step: 50, value: 800, show: ms }, u);
    var think = range(f, { label: 'Think time per iteration', min: 0, max: 60, step: 0.5, value: 5, show: function (v) { return fmt(v, 1) + ' s'; } }, u);
    var st = stats(f.out, [['closed', 'Closed model: virtual users'], ['hour', 'Iterations per hour'], ['pre', 'Open model: preAllocatedVUs'], ['max', 'Open model: maxVUs']]);
    var code = h('pre', { class: 'w-code' });
    f.out.appendChild(code);
    var say = note(f.out);
    function update() {
      var x = rate(), r = resp() / 1000, z = think();
      var closed = ceilSafe(x * (r + z));
      var pre = Math.max(1, ceilSafe(x * r * 1.2));       // busy VUs at normal latency, plus 20%
      var max = Math.max(pre, ceilSafe(x * r * 5));        // room for latency to grow 5× before iterations drop
      st.closed(fmt(closed));
      st.hour(fmt(x * 3600));
      st.pre(fmt(pre));
      st.max(fmt(max));
      code.textContent =
        "export const options = {\n" +
        "  scenarios: {\n" +
        "    target_load: {\n" +
        "      executor: 'constant-arrival-rate',\n" +
        "      rate: " + x + ",\n" +
        "      timeUnit: '1s',\n" +
        "      duration: '30m',\n" +
        "      preAllocatedVUs: " + pre + ",\n" +
        "      maxVUs: " + max + ",\n" +
        "    },\n" +
        "  },\n" +
        "  thresholds: { dropped_iterations: ['count==0'] },\n" +
        "};";
      say('A closed-model tool (fixed users with think time) needs ' + fmt(closed) + ' users to reach ' + fmt(x) + ' iterations/s, and only while response time stays at ' + ms(resp()) + '. An arrival-rate test keeps the rate fixed even when the system slows down, so think time is not needed to hit the target.');
    }
    update();
  };

  W.cdn = function (node) {
    var f = frame(node, 'Hit ratio vs origin load', 'Origin traffic = edge traffic × (1 − hit ratio). Move the slider and watch how fast origin load grows.');
    var u = function () { update(); };
    var edge = range(f, { label: 'Edge traffic', min: 1000, max: 50000, step: 500, value: 10000, show: function (v) { return fmt(v) + ' req/s'; } }, u);
    var hit = range(f, { label: 'Request hit ratio', min: 50, max: 99.9, step: 0.1, value: 95, show: function (v) { return fmt(v, 1) + '%'; } }, u);
    var cap = range(f, { label: 'Origin capacity', min: 100, max: 10000, step: 50, value: 1000, show: function (v) { return fmt(v) + ' req/s'; } }, u);
    var st = stats(f.out, [['origin', 'Origin traffic'], ['util', 'Origin utilisation'], ['min', 'Hit ratio at 100% origin load']]);
    var chart = h('div'); f.out.appendChild(chart);
    legend(f.out, [['Origin load', C.a], ['Origin capacity', C.w]]);
    var say = note(f.out);
    function update() {
      var e = edge(), r = hit() / 100, c = cap(), o = e * (1 - r);
      var minHit = 1 - c / e;
      st.origin(fmt(o) + ' req/s', o > c ? 'warn' : '');
      st.util(pct(o / c, 0), o / c >= 0.8 ? 'warn' : 'ok');
      st.min(minHit <= 0 ? 'any' : pct(minHit, 1));
      var pts = [];
      for (var x = 50; x <= 100.0001; x += 0.5) pts.push([x, e * (1 - x / 100)]);
      lineChart(chart, {
        xMin: 50, xMax: 100, yMin: 0, yMax: Math.max(e * 0.5, c * 1.15), xTitle: 'Hit ratio (%)', yTitle: 'Origin req/s',
        series: [{ pts: pts, color: C.a }],
        hLines: [{ y: c, color: C.w, label: 'origin capacity' }],
        points: [{ x: hit(), y: o, color: o > c ? C.w : C.a, label: fmt(o) + ' req/s' }],
      });
      var drop = e * 0.05;
      say(o > c
        ? 'The origin is overloaded: it needs a hit ratio of at least ' + pct(minHit, 1) + ' at this traffic. A purge-all would send up to ' + fmt(e) + ' req/s to it.'
        : 'Every 5-point drop in hit ratio adds ' + fmt(drop) + ' req/s to the origin. A purge-all would briefly send up to ' + fmt(e) + ' req/s, ' + fmt(e / c, 1) + '× its capacity.', o > c || e > c);
    }
    update();
  };

  W.omission = function (node) {
    var f = frame(node, 'Coordinated omission simulator', 'One closed-loop thread that should send a request every interval. During a stall it waits on one request, so the requests that would have suffered are never measured.');
    var u = function () { update(); };
    var interval = range(f, { label: 'Intended interval between requests', min: 2, max: 100, value: 10, show: ms }, u);
    var normal = range(f, { label: 'Normal response time', min: 1, max: 50, value: 1, show: ms }, u);
    var stall = range(f, { label: 'Stall (e.g. GC pause, failover)', min: 0.5, max: 30, step: 0.5, value: 10, show: function (v) { return fmt(v, 1) + ' s'; } }, u);
    var run = range(f, { label: 'Test length', min: 30, max: 600, step: 10, value: 100, show: function (v) { return fmt(v) + ' s'; } }, u);
    var st = stats(f.out, [['rp99', 'Reported p99'], ['tp99', 'Actual p99'], ['rmean', 'Reported mean'], ['tmean', 'Actual mean'], ['miss', 'Requests never sent']]);
    var chart = h('div'); f.out.appendChild(chart);
    legend(f.out, [['What the tool reports', C.a], ['What users experienced', C.w]]);
    var say = note(f.out);
    function update() {
      var r = normal(), I = Math.max(interval(), r), S = stall() * 1000, T = run() * 1000;
      if (T <= S + I) T = S + I * 10;
      var n = Math.floor((T - S) / I), m = Math.max(1, Math.floor(S / I));
      var rep = new Float64Array(n + 1), act = new Float64Array(n + m), i;
      for (i = 0; i < n; i++) { rep[i] = r; act[i] = r; }
      rep[n] = S;
      for (i = 0; i < m; i++) act[n + i] = S - i * I;
      rep.sort(); act.sort();
      var mean = function (a) { var t = 0; for (var k = 0; k < a.length; k++) t += a[k]; return t / a.length; };
      var ps = [0.5, 0.9, 0.99, 0.999, 0.9999, 1];
      var labels = ['p50', 'p90', 'p99', 'p99.9', 'p99.99', 'max'];
      var rv = ps.map(function (p) { return sortedPercentile(rep, p); });
      var av = ps.map(function (p) { return sortedPercentile(act, p); });
      st.rp99(ms(rv[2]), 'ok'); st.tp99(ms(av[2]), 'warn');
      st.rmean(ms(mean(rep)), 'ok'); st.tmean(ms(mean(act)), 'warn');
      st.miss(fmt(m - 1));
      var top = Math.max.apply(null, av.concat(rv));
      var bottom = Math.max(0.1, Math.min.apply(null, av.concat(rv)) / 2);
      lineChart(chart, {
        xMin: 0, xMax: 5, yMin: Math.pow(10, Math.floor(Math.log10(bottom))), yMax: Math.pow(10, Math.ceil(Math.log10(top * 1.01))), logY: true,
        xTicks: labels.map(function (l, k) { return [k, l]; }), yFmt: ms, xTitle: 'Percentile', yTitle: 'Latency (log scale)',
        series: [
          { pts: rv.map(function (v, k) { return [k, v]; }), color: C.a },
          { pts: av.map(function (v, k) { return [k, v]; }), color: C.w },
        ],
      });
      say((normal() > interval() ? 'A single thread with ' + ms(normal()) + ' responses cannot send every ' + ms(interval()) + ', so this uses a ' + ms(I) + ' interval. ' : '') + (run() * 1000 <= S + I ? 'The test is shorter than the stall, so this uses a ' + fmt(T / 1000, 1) + ' s test. ' : '') + 'The tool recorded ' + fmt(n + 1) + ' samples. Users would have sent ' + fmt(n + m) + '. ' + (av[2] / rv[2] >= 1.5 ? 'Reported p99 understates the real p99 by about ' + fmt(av[2] / rv[2]) + '×.' : 'Here the stall fills most of the test, so the reported and real p99 are close; shorten the stall or lengthen the test to see the effect.'), av[2] / rv[2] > 2);
    }
    update();
  };

  W.threads = function (node) {
    var f = frame(node, 'Thread pool sizing calculator', 'Threads = cores × target CPU × (1 + wait ÷ compute), cross-checked with Little\'s Law and the connection pool behind it.');
    var u = function () { update(); };
    var cores = range(f, { label: 'CPU cores', min: 1, max: 64, value: 4 }, u);
    var util = range(f, { label: 'Target CPU utilisation', min: 10, max: 100, step: 5, value: 80, show: function (v) { return v + '%'; } }, u);
    var comp = range(f, { label: 'Compute time per request', min: 1, max: 100, value: 5, show: ms }, u);
    var wait = range(f, { label: 'Wait time per request (DB, HTTP)', min: 0, max: 1000, step: 5, value: 45, show: ms }, u);
    var pool = range(f, { label: 'Database connection pool', min: 1, max: 200, value: 10 }, u);
    var budget = range(f, { label: 'Acceptable queueing delay', min: 10, max: 2000, step: 10, value: 200, show: ms }, u);
    var st = stats(f.out, [['threads', 'Thread pool size'], ['x', 'CPU-bound max throughput'], ['xp', 'Connection-pool max throughput'], ['q', 'Queue bound (at achievable rate)']]);
    var say = note(f.out);
    function update() {
      var N = cores() * util() / 100 * (1 + wait() / comp());
      var X = cores() * util() / 100 / (comp() / 1000);
      // Assumes each request holds a database connection for its wait time.
      var Xp = wait() > 0 ? pool() / (wait() / 1000) : Infinity;
      var Xe = Math.min(X, Xp);
      st.threads(fmt(ceilSafe(N)) + ' threads');
      st.x(fmt(X) + ' req/s', X <= Xp ? 'ok' : '');
      st.xp(isFinite(Xp) ? fmt(Xp) + ' req/s' : 'n/a', Xp < X ? 'warn' : '');
      st.q(fmt(Math.max(1, Math.floor(budget() / 1000 * Xe))) + ' tasks');
      var L = X * (comp() + wait()) / 1000;
      if (Xp < X) say('The connection pool is the real limit: at most ' + fmt(Xp) + ' req/s if each request holds a connection for its ' + ms(wait()) + ' wait. ' + fmt(ceilSafe(N)) + ' threads would leave about ' + fmt(Math.max(0, ceilSafe(N) - pool())) + ' parked waiting for a connection. Size the pools together.', true);
      else say('Little\'s Law check: ' + fmt(X) + ' req/s × ' + ms(comp() + wait()) + ' = ' + fmt(L, 1) + ' busy threads, matching the formula. Queue bound = delay budget × throughput.');
    }
    update();
  };

  W.lb = function (node) {
    var f = frame(node, 'Load balancer algorithm simulator', 'Simulates 30,000 requests with Poisson arrivals across FIFO backends, using the same traffic for every algorithm.');
    var u = debounce(function () { update(); }, 120);
    var n = range(f, { label: 'Backends', min: 2, max: 16, value: 4 }, u);
    var util = range(f, { label: 'Average utilisation', min: 30, max: 90, step: 5, value: 70, show: function (v) { return v + '%'; } }, u);
    var slow = range(f, { label: 'Share of slow requests', min: 0, max: 5, step: 0.5, value: 1, show: function (v) { return fmt(v, 1) + '%'; } }, u);
    var slowMs = range(f, { label: 'Slow request time', min: 200, max: 5000, step: 100, value: 2000, show: ms }, u);
    var pause = check(f, { label: 'Backend 1 has 500 ms GC pauses every 5 s', value: true }, u);
    var chart = h('div'); f.out.appendChild(chart);
    legend(f.out, [['p50', C.b], ['p99', C.a], ['p99.9', C.w]]);
    var table = h('div'); f.out.appendChild(table);
    var say = note(f.out);
    var algs = [['Round robin', 'rr'], ['Random', 'rand'], ['Power of two', 'p2c'], ['Least outstanding', 'lor']];
    var NREQ = 30000, NORMAL = 20, PAUSE = 500, PERIOD = 5000;

    function simulate(alg, arr, svc, nb, paused, seed) {
      var rnd = mulberry32(seed), fin = [], head = [], last = [], lat = new Float64Array(arr.length), rr = 0, b, i;
      for (b = 0; b < nb; b++) { fin.push([]); head.push(0); last.push(0); }
      var outstanding = function (k, now) {
        var q = fin[k];
        while (head[k] < q.length && q[head[k]] <= now) head[k]++;
        return q.length - head[k];
      };
      for (i = 0; i < arr.length; i++) {
        var now = arr[i];
        if (alg === 'rr') b = rr++ % nb;
        else if (alg === 'rand') b = Math.floor(rnd() * nb);
        else if (alg === 'p2c') {
          var a1 = Math.floor(rnd() * nb), a2 = Math.floor(rnd() * (nb - 1));
          if (a2 >= a1) a2++;
          b = outstanding(a1, now) <= outstanding(a2, now) ? a1 : a2;
        } else {
          var best = Infinity, ties = [];
          for (var k = 0; k < nb; k++) {
            var o = outstanding(k, now);
            if (o < best) { best = o; ties = [k]; } else if (o === best) ties.push(k);
          }
          b = ties[Math.floor(rnd() * ties.length)];
        }
        var start = Math.max(now, last[b]), d = svc[i];
        if (paused && b === 0) {
          var ph = start % PERIOD;
          if (ph < PAUSE) start += PAUSE - ph;                        // arrived during a pause
          else if (ph + d > PERIOD) d += PAUSE;                       // runs into the next pause
        }
        last[b] = start + d;
        fin[b].push(last[b]);
        lat[i] = last[b] - now;
      }
      lat.sort();
      return [sortedPercentile(lat, 0.5), sortedPercentile(lat, 0.99), sortedPercentile(lat, 0.999)];
    }

    function update() {
      var nb = n(), share = slow() / 100, sm = slowMs();
      var mean = (1 - share) * NORMAL + share * sm;
      var lambda = util() / 100 * nb / mean;              // requests per ms
      var rnd = mulberry32(42), arr = new Float64Array(NREQ), svc = new Float64Array(NREQ), t = 0;
      for (var i = 0; i < NREQ; i++) {
        t += -Math.log(1 - rnd()) / lambda;
        arr[i] = t;
        svc[i] = rnd() < share ? sm : NORMAL * (0.5 + rnd());
      }
      var res = algs.map(function (a) { return simulate(a[1], arr, svc, nb, pause(), 7); });
      var top = Math.max.apply(null, res.map(function (r) { return r[2]; }));
      barChart(chart, {
        cats: algs.map(function (a) { return a[0]; }), logY: true, yMin: 1, yMax: Math.pow(10, Math.ceil(Math.log10(top * 1.05))),
        yFmt: ms, yTitle: 'Latency (log scale)',
        series: [
          { label: 'p50', color: C.b, vals: res.map(function (r) { return r[0]; }) },
          { label: 'p99', color: C.a, vals: res.map(function (r) { return r[1]; }) },
          { label: 'p99.9', color: C.w, vals: res.map(function (r) { return r[2]; }) },
        ],
      });
      var rows = '<table><thead><tr><th>Algorithm</th><th>p50</th><th>p99</th><th>p99.9</th></tr></thead><tbody>' +
        res.map(function (r, k) { return '<tr><td>' + algs[k][0] + '</td><td>' + ms(r[0]) + '</td><td>' + ms(r[1]) + '</td><td>' + ms(r[2]) + '</td></tr>'; }).join('') +
        '</tbody></table>';
      table.innerHTML = rows;
      var rr = res[0][1], lo = res[3][1];
      say('Round robin p99 is ' + fmt(rr / Math.max(lo, 0.1), 1) + '× the least-outstanding p99 here. One balancer with perfect information is modelled. With many balancer instances, least-outstanding can herd, which power of two choices avoids.');
    }
    update();
  };

  W.capacity = function (node) {
    var f = frame(node, 'Greenfield capacity model', 'From business numbers to request rate, cores, pods and database connections. Replace the CPU cost with a measured number as soon as you have one.');
    var u = function () { update(); };
    var orders = number(f, { label: 'Orders per day', min: 1, value: 2000000 }, u);
    var peak = number(f, { label: 'Share in the busiest hour (%)', min: 1, max: 100, value: 30 }, u);
    var burst = number(f, { label: 'Burst factor (peak minute ÷ hour average)', min: 1, value: 3 }, u);
    var calls = number(f, { label: 'API calls per order', min: 1, value: 6 }, u);
    var cpu = number(f, { label: 'CPU ms per API request', min: 0.1, value: 15 }, u);
    var target = number(f, { label: 'Target CPU utilisation (%)', min: 1, max: 100, value: 60 }, u);
    var podCores = number(f, { label: 'Cores per pod', min: 0.25, value: 2 }, u);
    var poolSize = number(f, { label: 'DB pool size per pod', min: 1, value: 10 }, u);
    var maxConn = number(f, { label: 'Database max connections', min: 1, value: 100 }, u);
    var st = stats(f.out, [['avg', 'Peak-hour average'], ['peak', 'Peak orders'], ['rps', 'API requests'], ['cores', 'Cores needed'], ['pods', 'Pods at peak'], ['conn', 'DB connections']]);
    var say = note(f.out);
    function update() {
      var avg = orders() * peak() / 100 / 3600, pk = avg * burst(), rps = pk * calls();
      var busy = rps * cpu() / 1000, need = busy / (Math.min(target(), 100) / 100);
      var pods = ceilSafe(need / podCores()), conns = pods * poolSize();
      st.avg(fmt(avg) + ' orders/s');
      st.peak(fmt(pk) + ' orders/s');
      st.rps(fmt(rps) + ' req/s');
      st.cores(fmt(need, 1));
      st.pods(fmt(pods));
      st.conn(fmt(conns), conns > maxConn() ? 'warn' : 'ok');
      if (conns > maxConn()) say(fmt(pods) + ' pods × ' + fmt(poolSize()) + ' connections = ' + fmt(conns) + ', above the database limit of ' + fmt(maxConn()) + '. That is an architecture decision to make now: a connection pooler, smaller pools, or a different access pattern.', true);
      else say('Connections fit within the database limit with ' + fmt(maxConn() - conns) + ' to spare. Remember deploys: during a rolling update, old and new pods hold connections at the same time.');
    }
    update();
  };

  W.cache = function (node) {
    var f = frame(node, 'Cold-cache cliff and stampede calculator', 'A cache multiplies database capacity, so losing it divides capacity. And a hot key that expires sends every concurrent miss to the database.');
    var u = function () { update(); };
    var rps = range(f, { label: 'Read traffic', min: 1000, max: 100000, step: 1000, value: 20000, show: function (v) { return fmt(v) + ' req/s'; } }, u);
    var hit = range(f, { label: 'Hit ratio', min: 50, max: 99.9, step: 0.1, value: 95, show: function (v) { return fmt(v, 1) + '%'; } }, u);
    var cap = range(f, { label: 'Database capacity', min: 500, max: 50000, step: 500, value: 3000, show: function (v) { return fmt(v) + ' req/s'; } }, u);
    var hot = range(f, { label: 'Reads of one hot key', min: 100, max: 20000, step: 100, value: 2000, show: function (v) { return fmt(v) + ' req/s'; } }, u);
    var rebuild = range(f, { label: 'Time to rebuild that key', min: 10, max: 2000, step: 10, value: 100, show: ms }, u);
    var st = stats(f.out, [['warm', 'DB load, warm cache'], ['cold', 'DB load, cold cache'], ['mult', 'Cold ÷ warm'], ['stamp', 'Concurrent misses on expiry']]);
    var chart = h('div'); f.out.appendChild(chart);
    var say = note(f.out);
    function update() {
      var r = rps(), warm = r * (1 - hit() / 100), cold = r, c = cap(), misses = hot() * rebuild() / 1000;
      st.warm(fmt(warm) + ' req/s', warm > c ? 'warn' : 'ok');
      st.cold(fmt(cold) + ' req/s', cold > c ? 'warn' : 'ok');
      st.mult(fmt(cold / Math.max(warm, 1e-9), 1) + '×');
      st.stamp(fmt(misses) + ' queries', misses > 10 ? 'warn' : '');
      barChart(chart, {
        cats: ['Warm cache', 'Cold cache'], yMax: Math.max(cold, c) * 1.15, yTitle: 'Database req/s',
        series: [{ label: 'DB load', color: C.a, vals: [warm, cold] }],
        hLines: [{ y: c, color: C.w, label: 'database capacity' }],
      });
      say(cold > c
        ? 'After a cache restart or flush the database would receive ' + fmt(cold / c, 1) + '× its capacity. Warm the cache before taking traffic, rate-limit misses, or serve stale data. Without stampede protection, one hot key expiring sends about ' + fmt(misses) + ' identical queries at once.'
        : 'The database can survive a cold cache at this traffic. Without stampede protection, one hot key expiring still sends about ' + fmt(misses) + ' identical queries at once.', cold > c);
    }
    update();
  };

  W.queue = function (node) {
    var f = frame(node, 'Utilisation knee calculator', 'Queueing delay from Kingman\'s G/G/1 approximation (Allen–Cunneen for more than one server) compared with the Poisson, exponential M/M model. Wq ≈ M/M waiting time × (Ca² + Cs²) ÷ 2.');
    var u = function () { update(); };
    var svc = range(f, { label: 'Mean service time (S)', min: 1, max: 500, value: 10, show: ms }, u);
    var util = range(f, { label: 'Utilisation per server', min: 5, max: 98, value: 80, show: function (v) { return v + '%'; } }, u);
    var ca = range(f, { label: 'Arrival variability (Ca)', min: 0, max: 4, step: 0.1, value: 2, show: function (v) { return fmt(v, 1); } }, u);
    var cs = range(f, { label: 'Service time variability (Cs)', min: 0, max: 4, step: 0.1, value: 1, show: function (v) { return fmt(v, 1); } }, u);
    var servers = range(f, { label: 'Servers (workers sharing one queue)', min: 1, max: 64, value: 1 }, u);
    var st = stats(f.out, [['mm', 'Mean response time, M/M'], ['gg', 'Mean response time, Kingman'], ['wq', 'Queueing delay, Kingman'], ['dbl', 'Response time doubles at']]);
    var chart = h('div'); f.out.appendChild(chart);
    legend(f.out, [['Kingman (your Ca, Cs)', C.a], ['M/M (Ca = Cs = 1)', C.b]]);
    var say = note(f.out);

    // Probability an arrival has to wait in M/M/c (Erlang C), via the Erlang B recursion.
    function erlangC(c, rho) {
      var a = c * rho, b = 1;
      for (var k = 1; k <= c; k++) b = a * b / (k + a * b);
      return b / (1 - rho * (1 - b));
    }
    // Mean M/M/c waiting time in queue. With c = 1 this is rho / (1 - rho) × S.
    function wqMM(c, rho, S) { return erlangC(c, rho) * S / (c * (1 - rho)); }
    function doubleAt(c, k) {
      if (k <= 0) return 1;
      var lo = 0, hi = 0.99999;
      for (var i = 0; i < 60; i++) {
        var m = (lo + hi) / 2;
        if (wqMM(c, m, 1) * k < 1) lo = m; else hi = m;
      }
      return lo;
    }

    function update() {
      var S = svc(), U = util() / 100, c = servers();
      var k = (ca() * ca() + cs() * cs()) / 2;
      var wMM = wqMM(c, U, S), wGG = wMM * k;
      var rMM = S + wMM, rGG = S + wGG, d = doubleAt(c, k);
      st.mm(ms(rMM));
      st.gg(ms(rGG), rGG > 2 * S ? 'warn' : 'ok');
      st.wq(ms(wGG) + ' (' + fmt(k, 2) + '× M/M)');
      st.dbl(k <= 0 ? 'never' : pct(d, 0) + ' utilisation');

      var yMax = Math.max(10 * S, rGG * 1.3, rMM * 1.3);
      var gg = [], mm = [];
      for (var x = 0.01; x <= 0.985; x += 0.005) {
        var w = wqMM(c, x, S);
        if (S + w * k <= yMax) gg.push([x, S + w * k]);
        if (S + w <= yMax) mm.push([x, S + w]);
      }
      lineChart(chart, {
        xMin: 0, xMax: 1, yMin: 0, yMax: yMax, yFmt: ms,
        xTicks: [[0, '0%'], [0.2, '20%'], [0.4, '40%'], [0.6, '60%'], [0.8, '80%'], [1, '100%']],
        xTitle: 'Utilisation per server', yTitle: 'Mean response time',
        series: [{ pts: mm, color: C.b, dash: '6 4' }, { pts: gg, color: C.a }],
        hLines: [{ y: 2 * S, color: C.w, label: '2 × service time' }],
        points: [{ x: U, y: rGG, color: C.a, label: ms(rGG) }]
      });

      var step = Math.min(U + 0.05, U + (1 - U) / 2);
      var rNext = S + wqMM(c, step, S) * k;
      if (U > 0.8) say('Above 80% the curve is nearly vertical. Going from ' + pct(U, 0) + ' to ' + pct(step, 0) + ' utilisation moves mean response time from ' + ms(rGG) + ' to ' + ms(rNext) + '. A small traffic burst or a slightly slower dependency is now enough to tip the queue over. These are means, so p99 is worse again.', true);
      else say('Queueing delay is ' + fmt(k, 2) + '× the M/M value because (Ca² + Cs²) ÷ 2 = ' + fmt(k, 2) + '. Only the waiting time scales with variability, the ' + ms(S) + ' of service time does not. Measure utilisation over your burst window, not an hourly average.');
    }
    update();
  };

  W.dbpool = function (node) {
    var f = frame(node, 'Connection pool and N+1 calculator', 'Little\'s Law: connections busy = request rate × time each request holds a connection. N+1 multiplies the hold time.');
    var u = function () { update(); };
    var rate = range(f, { label: 'Request rate (all app instances)', min: 10, max: 5000, step: 10, value: 1000, show: function (v) { return fmt(v) + ' req/s'; } }, u);
    var queries = range(f, { label: 'Queries per request', min: 1, max: 200, value: 60 }, u);
    var rtt = range(f, { label: 'Network round trip per query', min: 0.1, max: 5, step: 0.1, value: 0.5, show: ms }, u);
    var exec = range(f, { label: 'Execution time per query', min: 0.1, max: 50, step: 0.1, value: 1, show: ms }, u);
    var pool = range(f, { label: 'Pool size (connections across all instances)', min: 1, max: 500, value: 100 }, u);
    var st = stats(f.out, [['db', 'DB time per request'], ['busy', 'Connections busy (average)'], ['util', 'Pool utilisation'], ['wait', 'Mean wait for a connection']]);
    var chart = h('div'); f.out.appendChild(chart);
    legend(f.out, [['Connections busy', C.a], ['Pool size', C.w]]);
    var say = note(f.out);

    // Erlang C (M/M/c): probability an arrival waits, then mean queueing delay. A rough guide, not a forecast.
    function erlangWait(a, c, hold) {
      if (a >= c) return Infinity;
      var b = 1;
      for (var k = 1; k <= c; k++) b = a * b / (k + a * b);
      var pw = c * b / (c - a * (1 - b));
      return pw * hold / (c - a);
    }

    function update() {
      var x = rate(), n = queries(), c = pool();
      var hold = n * (rtt() + exec());            // ms the connection is held per request
      var busy = x * hold / 1000;                 // Little's Law
      var util = busy / c;
      var wait = erlangWait(busy, c, hold);
      st.db(ms(hold), hold > 100 ? 'warn' : '');
      st.busy(fmt(busy, 1));
      st.util(util >= 1 ? 'over 100%' : pct(util, 0), util >= 0.8 ? 'warn' : 'ok');
      st.wait(isFinite(wait) ? ms(wait) : 'unbounded', !isFinite(wait) || wait > hold ? 'warn' : 'ok');

      // Wide enough to show where demand crosses the pool size, and the line leaving the top of the chart.
      var xMax = Math.max(x * 1.5, c * 1.5 * 1000 / hold), pts = [];
      for (var i = 0; i <= 40; i++) { var r = xMax * i / 40; pts.push([r, r * hold / 1000]); }
      lineChart(chart, {
        xMin: 0, xMax: xMax, yMin: 0, yMax: Math.max(c * 1.5, busy * 1.1, 10),
        xTitle: 'Request rate (req/s)', yTitle: 'Connections busy',
        series: [{ pts: pts, color: C.a }],
        hLines: [{ y: c, color: C.w, label: 'pool size ' + fmt(c) }],
        points: [{ x: x, y: busy, color: util >= 1 ? C.w : C.a, label: fmt(busy, 1) + ' busy at ' + fmt(x) + ' req/s' }],
      });

      var batched = 2 * (rtt() + exec()), batchedBusy = x * batched / 1000;
      if (util >= 1) say('Demand is ' + fmt(busy, 1) + ' connections but the pool has ' + fmt(c) + '. Requests queue for a connection until the pool timeout fires, so p99 grows without limit while the database itself may look only lightly loaded. Fetching the children in one batched query (2 queries per request) would need about ' + fmt(batchedBusy, 1) + ' connections.', true);
      else if (util >= 0.8) say('At ' + pct(util, 0) + ' pool utilisation, random bursts already make requests wait for a connection. That wait is invisible in pg_stat_statements because no query is running. Batching to 2 queries per request would need about ' + fmt(batchedBusy, 1) + ' connections.', true);
      else say('The pool has headroom: about ' + fmt(c - busy, 0) + ' connections spare on average. Rough upper rate before the pool saturates: ' + fmt(c * 1000 / hold) + ' req/s.');
    }
    update();
  };

  W.gc = function (node) {
    var f = frame(node, 'Young GC frequency and tail latency', 'Young GCs per second = allocation rate ÷ eden size. Share of requests that overlap a pause ≈ GCs per second × (pause + request duration).');
    var u = function () { update(); };
    var mbs = function (v) { return fmt(v) + ' MB/s'; };
    var alloc = range(f, { label: 'Allocation rate', min: 50, max: 5000, step: 50, value: 800, show: mbs }, u);
    var eden = range(f, { label: 'Eden size', min: 64, max: 8192, step: 64, value: 1024, show: function (v) { return fmt(v) + ' MB'; } }, u);
    var surv = range(f, { label: 'Survival rate per young GC', min: 0, max: 30, step: 0.5, value: 3, show: function (v) { return fmt(v, 1) + '%'; } }, u);
    var pause = range(f, { label: 'Pause per young GC', min: 0.1, max: 200, step: 0.1, value: 25, show: ms }, u);
    var rps = range(f, { label: 'Request rate', min: 10, max: 10000, step: 10, value: 500, show: function (v) { return fmt(v) + ' req/s'; } }, u);
    var dur = range(f, { label: 'Request duration (no GC)', min: 1, max: 1000, value: 40, show: ms }, u);
    var st = stats(f.out, [['gcs', 'Young GCs per minute'], ['gap', 'Time between GCs'], ['ovh', 'Time paused (GC overhead)'], ['hit', 'Requests overlapping a pause'], ['hitm', 'Affected requests per minute'], ['copy', 'Survivors copied per GC']]);
    var say = note(f.out);
    function update() {
      var perSec = alloc() / eden();
      var p = pause() / 1000, d = dur() / 1000;
      var overhead = Math.min(1, perSec * p);
      var hit = Math.min(1, perSec * (p + d));
      st.gcs(fmt(perSec * 60, 1));
      st.gap(ms(1000 / perSec));
      st.ovh(pct(overhead, 2), overhead >= 0.05 ? 'warn' : 'ok');
      st.hit(pct(hit, 2), hit >= 0.001 ? 'warn' : 'ok');
      st.hitm(fmt(rps() * 60 * hit));
      st.copy(fmt(eden() * surv() / 100, 1) + ' MB');
      var tail = hit >= 0.05 ? 'p95' : hit >= 0.01 ? 'p99' : hit >= 0.001 ? 'p99.9' : '';
      if (overhead >= 0.05) say('The application is paused ' + pct(overhead, 1) + ' of the time. That is a throughput problem as well as a latency one: reduce allocation or give the young generation more room before tuning anything else.', true);
      else if (tail) say('About ' + pct(hit, 2) + ' of requests overlap a pause, so ' + tail + ' latency includes GC even though each pause is only ' + ms(pause()) + '. A pause goal of 200 ms is met and the tail is still GC-bound.', true);
      else say('Fewer than 1 in 1,000 requests overlap a pause. GC is unlikely to be what drives your p99.9 at these numbers.');
    }
    update();
  };

  W.toolpick = function (node) {
    var f = frame(node, 'Load tool picker', 'Tick what you need. Scores: built in = 2, via plugin, extension or custom client = 1, not available = 0. A need scored 0 is a blocker.');
    var u = function () { update(); };
    var tools = ['k6', 'JMeter', 'Gatling', 'Locust', 'LoadRunner'];
    // [label, default, [k6, JMeter, Gatling, Locust, LoadRunner]]
    var needs = [
      ['HTTP/2', true, [2, 1, 2, 1, 2]],
      ['gRPC', false, [2, 1, 1, 1, 2]],
      ['WebSocket', false, [2, 1, 2, 1, 2]],
      ['Real browser testing', false, [2, 1, 0, 1, 2]],
      ['Open model (arrival rate)', true, [2, 2, 2, 0, 1]],
      ['Team prefers JavaScript/TypeScript', false, [2, 0, 2, 0, 2]],   // Gatling JS/TS SDK (3.11+), LoadRunner DevWeb/TruClient
      ['Team prefers Python', false, [0, 0, 0, 2, 0]],
      ['Team prefers Java, Kotlin or Scala', false, [0, 1, 2, 0, 1]],
      ['No-code GUI authoring', false, [1, 2, 1, 0, 2]],
      ['Enterprise protocols (SAP GUI, Citrix)', false, [0, 0, 0, 0, 2]],
      ['Zero licence cost', true, [2, 2, 2, 2, 0]],
      ['Very high scale on own infrastructure, free', false, [1, 2, 0, 2, 0]]
    ];
    var caveats = [
      'Raw TCP, UDP and brokers need xk6 extensions (a custom binary), and free distributed runs need the k6-operator on Kubernetes.',
      'HTTP/2, WebSocket and gRPC all come from plugins. Pin plugin versions, and use the Open Model Thread Group (5.5+), not a timer, for rate-based load.',
      'Running one test across several load generators with merged results is a Gatling Enterprise feature. gRPC is an official plugin.',
      'Closed model by default. constant_throughput still drops the rate when responses slow, so prove the rate held before trusting percentiles.',
      'Licensed per virtual user, so price your peak test size first. Goal-oriented scenarios approximate a target rate but are not a true open model.'
    ];
    var boxes = needs.map(function (n) { return check(f, { label: n[0], value: n[1] }, u); });
    var table = h('div'); f.out.appendChild(table);
    var say = note(f.out);
    function update() {
      var picked = [];
      needs.forEach(function (n, i) { if (boxes[i]()) picked.push(n); });
      if (!picked.length) { table.innerHTML = ''; say('Tick at least one need to rank the tools.'); return; }
      var max = picked.length * 2;
      var res = tools.map(function (t, k) {
        var score = 0, gaps = [];
        picked.forEach(function (n) { score += n[2][k]; if (n[2][k] === 0) gaps.push(n[0]); });
        return { k: k, name: t, score: score, gaps: gaps };
      });
      res.sort(function (a, b) { return a.gaps.length - b.gaps.length || b.score - a.score || a.k - b.k; });
      table.innerHTML = '<table><thead><tr><th>Rank</th><th>Tool</th><th>Score</th><th>Blockers</th></tr></thead><tbody>' +
        res.map(function (r, i) {
          return '<tr><td>' + (i + 1) + '</td><td>' + r.name + '</td><td>' + r.score + ' / ' + max + '</td><td>' + (r.gaps.length ? r.gaps.join(', ') : 'none') + '</td></tr>';
        }).join('') + '</tbody></table>';
      var top = res[0];
      if (top.gaps.length) say('No tool covers every need. ' + top.name + ' has the fewest blockers (' + top.gaps.join(', ') + '). Relax that need or split the work across two tools' + (boxes[9]() ? ', for example LoadRunner for the SAP or Citrix flows and a free tool for the APIs' : '') + '. Caveat for ' + top.name + ': ' + caveats[top.k], true);
      else say(top.name + ' meets every need with a score of ' + top.score + ' of ' + max + (res[1].gaps.length === 0 && res[1].score === top.score ? ', tied with ' + res[1].name + ', so let the team\'s language decide' : '') + '. Main caveat: ' + caveats[top.k] + ' Scores are capability only. Pilot the hardest flow before you commit.');
    }
    update();
  };

  W.hpa = function (node) {
    var f = frame(node, 'Scale-out lag simulator', 'Demand ramps up. The HPA acts on metrics that are already old, and new pods serve traffic only after they start. Everything above the capacity line is backlog or errors.');
    var u = function () { update(); };
    var rps = function (v) { return fmt(v) + ' req/s'; };
    var secs = function (v) { return fmt(v) + ' s'; };
    var start = range(f, { label: 'Starting traffic', min: 100, max: 20000, step: 100, value: 2000, show: rps }, u);
    var peak = range(f, { label: 'Peak traffic', min: 100, max: 50000, step: 100, value: 6000, show: rps }, u);
    var ramp = range(f, { label: 'Ramp duration', min: 5, max: 600, step: 5, value: 60, show: secs }, u);
    var cap = range(f, { label: 'Capacity per pod', min: 10, max: 2000, step: 10, value: 100, show: rps }, u);
    var target = range(f, { label: 'HPA target utilisation', min: 30, max: 95, value: 80, show: function (v) { return v + '%'; } }, u);
    var pods0 = range(f, { label: 'Starting pods', min: 1, max: 300, value: 25 }, u);
    var mDelay = range(f, { label: 'Metrics delay (scrape + averaging)', min: 0, max: 120, step: 5, value: 30, show: secs }, u);
    var sync = range(f, { label: 'HPA sync period', min: 5, max: 60, step: 5, value: 15, show: secs }, u);
    var podStart = range(f, { label: 'Pod start to Ready (schedule, pull, start, probe)', min: 1, max: 300, value: 30, show: secs }, u);
    var nodeTime = range(f, { label: 'Node provisioning time', min: 30, max: 600, step: 10, value: 180, show: secs }, u);
    var noNodes = check(f, { label: 'No spare nodes: new pods wait for node provisioning', value: false }, u);
    var policy = check(f, { label: 'Default scale-up policy (max of +100% or +4 pods per 15 s)', value: true }, u);
    var sat = check(f, { label: 'CPU metric saturates at pod capacity (HPA cannot see demand above it)', value: false }, u);
    var st = stats(f.out, [['backlog', 'Peak backlog (requests)'], ['over', 'Seconds over capacity'], ['first', 'First new pod Ready at'], ['wait', 'Worst queue wait']]);
    var chart = h('div'); f.out.appendChild(chart);
    legend(f.out, [['Demand', C.w], ['Ready capacity', C.a], ['HPA target capacity', C.m]]);
    var say = note(f.out);

    function update() {
      var s0 = start(), sp = Math.max(peak(), s0), rd = ramp(), c = cap(), tu = target() / 100;
      var lag = podStart() + (noNodes() ? nodeTime() : 0), md = mDelay(), sy = sync();
      var horizon = Math.min(3600, Math.ceil(rd + md + sy + lag) * 2 + 120);
      var demand = function (t) { return t <= 0 ? s0 : s0 + (sp - s0) * Math.min(t / rd, 1); };
      var ready = pods0(), want = ready, arrivals = {};
      var q = 0, peakQ = 0, peakWait = 0, over = 0, first = -1, scaleUps = [];
      var dPts = [], cPts = [], tPts = [];
      for (var t = 0; t <= horizon; t++) {
        if (arrivals[t]) { ready += arrivals[t]; if (first < 0) first = t; }
        if (t > 0 && t % sy === 0) {
          var seen = demand(t - md);
          if (sat()) seen = Math.min(seen, ready * c);
          var need = seen / (c * tu);
          if (Math.abs(need / want - 1) > 0.1 && need > want) {
            var next = ceilSafe(need);
            if (policy()) {
              // Kubernetes limits growth over a rolling 15 s window, based on the replica count at its start.
              var recent = scaleUps.filter(function (e) { return t - e.t < 15; }).reduce(function (a, e) { return a + e.n; }, 0);
              var base = want - recent;
              next = Math.min(next, Math.max(base * 2, base + 4));
            }
            if (next > want) {
              scaleUps.push({ t: t, n: next - want });
              arrivals[t + lag] = (arrivals[t + lag] || 0) + (next - want);
              want = next;
            }
          }
        }
        var d = demand(t), capNow = ready * c;
        if (d > capNow) over++;
        q = Math.max(0, q + d - capNow);
        if (q > peakQ) peakQ = q;
        if (q / capNow > peakWait) peakWait = q / capNow;
        dPts.push([t, d]); cPts.push([t, capNow]); tPts.push([t, want * c]);
      }
      st.backlog(fmt(peakQ), peakQ > sp * 5 ? 'warn' : (peakQ > 0 ? '' : 'ok'));
      st.over(fmt(over) + ' s', over > 0 ? 'warn' : 'ok');
      st.first(first < 0 ? 'none needed' : fmt(first) + ' s');
      st.wait(peakWait > 0 ? ms(peakWait * 1000) : '0 ms', peakWait > 5 ? 'warn' : (peakWait > 0 ? '' : 'ok'));
      var yMax = Math.max(sp, ready * c, want * c) * 1.1;
      lineChart(chart, {
        xMin: 0, xMax: horizon, yMin: 0, yMax: yMax,
        xTitle: 'Seconds since the ramp started', yTitle: 'req/s',
        yFmt: function (v) { return v >= 1000 ? fmt(v / 1000, 1) + 'k' : fmt(v); },
        series: [
          { pts: tPts, color: C.m, dash: '5 4', width: 1.5 },
          { pts: cPts, color: C.a },
          { pts: dPts, color: C.w }
        ]
      });
      if (peakQ > sp * 5) say('Peak backlog is ' + fmt(peakQ) + ' requests, about ' + fmt(peakQ / sp, 0) + ' seconds of peak traffic. With a typical 30 s client timeout most of it becomes errors and retries. Pre-scale before known peaks, lower the target utilisation for more headroom, or shorten the reaction chain (spare nodes, faster pod start).', true);
      else if (peakQ > 0) say('Demand exceeds ready capacity for ' + fmt(over) + ' s and ' + fmt(peakQ) + ' requests queue at the worst point. Survivable if your queues and timeouts can absorb it.');
      else say(peak() < start()
        ? 'Peak traffic is below the starting traffic, so this shows a flat load at ' + fmt(s0) + ' req/s (scale-down isn\'t modelled). Ready capacity covers it.'
        : 'Ready capacity stays ahead of demand. Your headroom covers the reaction time for this ramp.');
    }
    update();
  };

  W.sampling = function (node) {
    var f = frame(node, 'Trace sampling calculator', 'How many of your slowest requests survive as traces? Head sampling keeps a fixed share of everything. Tail sampling decides after the trace has finished and keeps every slow one.');
    var u = function () { update(); };
    var TAILS = [[0.99, 'p99'], [0.999, 'p99.9'], [0.9999, 'p99.99']];
    var rate = range(f, { label: 'Request rate', min: 10, max: 5000, step: 10, value: 200, show: function (v) { return fmt(v) + ' req/s'; } }, u);
    var head = range(f, { label: 'Head sampling rate', min: 0.1, max: 100, step: 0.1, value: 1, show: function (v) { return fmt(v, 1) + '%'; } }, u);
    var tail = range(f, { label: 'Tail you care about', min: 0, max: 2, step: 1, value: 1, show: function (v) { return 'slower than ' + TAILS[v][1]; } }, u);
    var mins = range(f, { label: 'Time window', min: 1, max: 60, step: 1, value: 15, show: function (v) { return fmt(v) + ' min'; } }, u);
    var st = stats(f.out, [['slow', 'Slow requests in window'], ['hcap', 'Slow traces kept (head)'], ['prob', 'Chance head keeps at least one'], ['tcap', 'Slow traces kept (tail)'], ['hstore', 'Traces stored (head)'], ['tstore', 'Traces stored (tail)']]);
    var chart = h('div'); f.out.appendChild(chart);
    legend(f.out, [['Slow traces kept', C.a]]);
    var say = note(f.out);
    function update() {
      var total = rate() * 60 * mins(), t = TAILS[tail()], slow = total * (1 - t[0]), r = head() / 100;
      var hcap = slow * r, prob = 1 - Math.exp(-slow * r);
      var hstore = total * r, tstore = r * (total - slow) + slow;
      st.slow(fmt(slow, slow < 10 ? 1 : 0));
      st.hcap(fmt(hcap, hcap < 1 ? 2 : hcap < 10 ? 1 : 0), hcap < 10 ? 'warn' : 'ok');
      st.prob(pct(prob), prob < 0.95 ? 'warn' : 'ok');
      st.tcap(fmt(slow, slow < 10 ? 1 : 0), 'ok');
      st.hstore(fmt(hstore));
      st.tstore(fmt(tstore) + ' (+' + pct(tstore / Math.max(hstore, 1e-9) - 1, 0) + ')');
      var top = Math.max(slow, 1);
      barChart(chart, {
        cats: ['Head sampling', 'Tail sampling'], logY: true, yMin: 0.1, yMax: Math.pow(10, Math.ceil(Math.log10(top * 1.01))),
        yTitle: 'Slow traces (log scale)', yFmt: function (v) { return fmt(v, 1); },
        series: [{ label: 'Slow traces kept', color: C.a, vals: [Math.max(hcap, 0.1), Math.max(slow, 0.1)] }],
      });
      if (r >= 1) say('At 100% head sampling every trace is kept, so head and tail sampling keep the same ' + fmt(slow, slow < 10 ? 1 : 0) + ' slow traces' + (slow < 1 ? ', and in this window you expect fewer than one request slower than ' + t[1] + ' at all' : '') + '. Tail sampling only pays off when you sample less than everything.', slow < 1);
      else if (hcap < 1) say('Head sampling expects to keep ' + fmt(hcap, 2) + ' of the ' + fmt(slow, 1) + ' requests slower than ' + t[1] + ', so most of the time you will have no slow trace at all. Tail sampling keeps all of them for about ' + pct(tstore / Math.max(hstore, 1e-9) - 1, 0) + ' more stored traces.', true);
      else if (hcap < 10) say('Head sampling expects to keep only ' + fmt(hcap, 1) + ' slow traces (' + pct(prob) + ' chance of at least one). That is too few to see a pattern. Tail sampling keeps all ' + fmt(slow) + '.', true);
      else say('Head sampling keeps about ' + fmt(hcap) + ' of ' + fmt(slow) + ' slow traces. Enough to investigate, but tail sampling keeps every one for ' + fmt(tstore - hstore) + ' extra stored traces.');
    }
    update();
  };

  W.burst = function (node) {
    var f = frame(node, 'gp2 burst-credit calculator', 'A gp2 volume earns I/O credits at its baseline rate and spends them at the rate you use. When the 5.4 million credit bucket is empty, the volume drops to baseline. gp3 has no credits: it delivers its provisioned IOPS all the time.');
    var u = function () { update(); };
    var size = number(f, { label: 'gp2 volume size (GiB)', min: 1, max: 16384, step: 1, value: 100 }, u);
    var load = number(f, { label: 'Sustained workload (IOPS)', min: 1, step: 1, value: 2000 }, u);
    var start = range(f, { label: 'Starting credit balance', min: 0, max: 100, step: 1, value: 100, show: function (v) { return fmt(v) + '%'; } }, u);
    var st = stats(f.out, [['base', 'gp2 baseline'], ['burst', 'gp2 burst ceiling'], ['empty', 'Credits run out after'], ['after', 'gp2 IOPS after that'], ['gp3', 'gp3 (3,000 IOPS included)']]);
    var chart = h('div'); f.out.appendChild(chart);
    legend(f.out, [['gp2 delivered IOPS', C.a], ['gp3 delivered IOPS (default 3,000)', C.b], ['workload demand', C.w]]);
    var say = note(f.out);
    var BUCKET = 5400000, HOURS = 8;
    function dur(sec) {
      if (sec < 120) return fmt(sec) + ' s';
      if (sec < 7200) return fmt(sec / 60, 0) + ' min';
      return fmt(sec / 3600, 1) + ' h';
    }
    function update() {
      var g = Math.max(1, Math.round(size())), w = load();
      var base = Math.min(16000, Math.max(100, 3 * g));
      var cap = g < 1000 ? Math.max(3000, base) : base;
      var credits = BUCKET * start() / 100;
      var bursting = Math.min(w, cap);
      var drain = bursting - base;
      var tEmpty = drain > 0 ? credits / drain : Infinity;
      var gp3 = Math.min(w, 3000);
      st.base(fmt(base) + ' IOPS');
      st.burst(g < 1000 ? fmt(cap) + ' IOPS' : 'no burst (baseline ≥ 3,000)');
      st.empty(isFinite(tEmpty) ? dur(tEmpty) : 'never', isFinite(tEmpty) && tEmpty < HOURS * 3600 ? 'warn' : 'ok');
      st.after(fmt(Math.min(w, base)) + ' IOPS', w > base ? 'warn' : 'ok');
      st.gp3(fmt(gp3) + ' IOPS', w > 3000 ? 'warn' : 'ok');
      var pts = [], end = HOURS * 3600;
      if (isFinite(tEmpty) && tEmpty < end) {
        pts = [[0, bursting], [tEmpty / 3600, bursting], [tEmpty / 3600, Math.min(w, base)], [HOURS, Math.min(w, base)]];
      } else {
        pts = [[0, bursting], [HOURS, bursting]];
      }
      var yMax = Math.max(w, cap, 3000) * 1.15;
      lineChart(chart, {
        xMin: 0, xMax: HOURS, yMin: 0, yMax: yMax, xTitle: 'Hours into the test', yTitle: 'IOPS',
        series: [{ pts: [[0, gp3], [HOURS, gp3]], color: C.b, dash: '6 4' }, { pts: pts, color: C.a }],
        hLines: [{ y: w, color: C.w, label: 'workload ' + fmt(w) + ' IOPS' }],
      });
      var msg;
      if (credits === 0 && w > base) {
        st.empty('already empty', 'warn');
        say('The bucket starts empty, so the volume runs at its baseline of ' + fmt(base) + ' IOPS from the first second, ' + fmt(w / base, 1) + '× less than the workload needs. Credits only refill while the workload stays below ' + fmt(base) + ' IOPS.', true);
      } else if (w > cap) {
        msg = 'This workload needs more IOPS than this gp2 volume can ever deliver (' + fmt(cap) + (g < 1000 ? ' even when bursting' : ', and volumes of 1,000 GiB or more don\'t burst') + '). Requests will queue from the start, and await will grow until the backlog is bounded by the application.';
        if (isFinite(tEmpty) && tEmpty < end) msg += ' Then after ' + dur(tEmpty) + ' the volume drops to ' + fmt(base) + ' IOPS.';
        say(msg, true);
      } else if (isFinite(tEmpty) && tEmpty < end) {
        say('A test shorter than ' + dur(tEmpty) + ' will pass. After that the volume drops from ' + fmt(bursting) + ' to ' + fmt(base) + ' IOPS, about ' + fmt(w / base, 1) + '× less than the workload needs, and queueing latency climbs without limit. Run tests long enough to drain the bucket, or watch BurstBalance in CloudWatch.', true);
      } else if (isFinite(tEmpty)) {
        say('Credits last about ' + dur(tEmpty) + ', longer than an ' + HOURS + '-hour day, but they only refill when the workload drops below ' + fmt(base) + ' IOPS. A busy week can still empty the bucket.', false);
      } else {
        say('The workload fits within the gp2 baseline of ' + fmt(base) + ' IOPS, so it never spends credits. Throughput limits and the EC2 instance\'s own EBS limits can still cap you.', false);
      }
    }
    update();
  };

  // ---- Fan-out tail amplification (post: 2026-11-14) ----
  W.fanout = function (node) {
    var f = frame(node, 'Fan-out tail calculator', 'A request that waits for N back-end calls is only as fast as the slowest one. If each call is slow with probability p, the request is slow with probability 1 − (1 − p)^N. Hedging sends a second copy of a call that has not answered by its p95, so the call is slow only if both copies are.');
    var u = function () { update(); };
    var p = range(f, { label: 'Chance one call is slow', min: 0.01, max: 5, step: 0.01, value: 1, show: function (v) { return fmt(v, 2) + '%'; } }, u);
    var n = range(f, { label: 'Calls per request (fan-out)', min: 1, max: 200, step: 1, value: 100 }, u);
    var hedge = check(f, { label: 'Hedge each call after its p95', value: false }, u);
    var st = stats(f.out, [['one', 'Slow calls'], ['req', 'Slow requests'], ['hedged', 'Slow requests, hedged'], ['extra', 'Extra calls from hedging']]);
    var chart = h('div'); f.out.appendChild(chart);
    legend(f.out, [['without hedging', C.a], ['with hedging', C.b]]);
    var say = note(f.out);
    function slow(q, k) { return 1 - Math.pow(1 - q, k); }
    function update() {
      var q = p() / 100, k = n(), q2 = q * q;
      var a = slow(q, k), b = slow(q2, k);
      st.one(pct(q, 2));
      st.req(pct(a, 1), a > 0.1 ? 'warn' : '');
      st.hedged(hedge() ? pct(b, 2) : 'off', hedge() ? 'ok' : '');
      st.extra(hedge() ? 'about 5%' : '0%');
      var pts = [], pts2 = [];
      for (var i = 1; i <= 200; i++) { pts.push([i, slow(q, i) * 100]); pts2.push([i, slow(q2, i) * 100]); }
      lineChart(chart, { xMin: 1, xMax: 200, yMin: 0, yMax: 100, xTitle: 'Fan-out (calls per request)', yTitle: '% of requests slow', yFmt: function (v) { return fmt(v) + '%'; },
        series: hedge() ? [{ pts: pts, color: C.a }, { pts: pts2, color: C.b }] : [{ pts: pts, color: C.a }],
        points: [{ x: k, y: a * 100, color: C.a, label: pct(a, 1) }] });
      var msg = 'A ' + pct(q, 2) + ' slow call becomes ' + pct(a, 1) + ' of requests at a fan-out of ' + k + '. Your request p99 is now set by the call\'s p' + fmt(100 - (1 - Math.pow(0.99, 1 / k)) * 100, 3).replace(/0+$/, '') + ', not its p99.';
      if (hedge()) msg += ' Hedging cuts it to ' + pct(b, 2) + ' for about 5% more calls, if the two replicas are slow independently. When slowness is shared (a hot partition, a GC pause on the only replica), hedging does little.';
      say(msg, a > 0.1 && !hedge());
    }
    update();
  };

  // ---- LLM concurrency (post: 2026-11-15) ----
  W.llmload = function (node) {
    var f = frame(node, 'LLM load from your launch numbers', 'Streaming answers stay in flight for the whole generation, so concurrency follows Little\'s Law: requests per second × seconds per answer. Token throughput is what the provider\'s TPM limit and your GPUs actually see.');
    var u = function () { update(); };
    var rpm = number(f, { label: 'Peak requests per minute', min: 1, step: 1, value: 600 }, u);
    var inTok = number(f, { label: 'Input tokens per request', min: 1, step: 1, value: 3000 }, u);
    var outTok = number(f, { label: 'Output tokens per answer', min: 1, step: 1, value: 400 }, u);
    var ttft = number(f, { label: 'Time to first token (ms)', min: 0, step: 50, value: 800 }, u);
    var tpot = number(f, { label: 'Time per output token (ms)', min: 1, step: 1, value: 30 }, u);
    var st = stats(f.out, [['total', 'Time per answer'], ['conc', 'Answers in flight'], ['tpm', 'Tokens per minute'], ['demo', 'A 5-user demo has']]);
    var say = note(f.out);
    function update() {
      var total = ttft() + tpot() * Math.max(0, outTok() - 1);
      var conc = rpm() / 60 * total / 1000;
      var tpm = rpm() * (inTok() + outTok());
      st.total(ms(total));
      st.conc(fmt(conc, 0), conc > 50 ? 'warn' : '');
      st.tpm(fmt(tpm));
      st.demo('≤ 5 in flight');
      say('At peak about ' + fmt(conc, 0) + ' answers are generating at once, ' + fmt(conc / 5, 0) + '× what a five-person demo exercises. Batching servers share the GPU across them, so time per output token usually grows as concurrency rises. Measure TTFT and TPOT at this concurrency, not at five. Check ' + fmt(tpm) + ' tokens per minute against your provider\'s TPM limit.', conc > 50);
    }
    update();
  };

  // ---- T3 CPU credits (post: 2026-11-16) ----
  W.cpucredit = function (node) {
    var f = frame(node, 'T3 CPU credit calculator', 'One CPU credit is one vCPU at 100% for one minute. A T3 instance earns credits at a fixed hourly rate and spends them whenever it runs above its baseline. In standard mode an empty balance caps the CPU at the baseline. In unlimited mode (the T3 default) it keeps running and you pay for surplus credits.');
    var TYPES = { 't3.micro': [2, 12], 't3.small': [2, 24], 't3.medium': [2, 24], 't3.large': [2, 36], 't3.xlarge': [4, 96], 't3.2xlarge': [8, 192] };
    var names = Object.keys(TYPES);
    var u = function () { update(); };
    var type = range(f, { label: 'Instance type', min: 0, max: names.length - 1, step: 1, value: 2, show: function (v) { return names[v]; } }, u);
    var util = range(f, { label: 'Sustained CPU (whole instance)', min: 1, max: 100, step: 1, value: 60, show: function (v) { return v + '%'; } }, u);
    var start = range(f, { label: 'Starting credit balance', min: 0, max: 100, step: 1, value: 100, show: function (v) { return v + '%'; } }, u);
    var st = stats(f.out, [['base', 'Baseline'], ['earn', 'Earns'], ['spend', 'Spends at this load'], ['empty', 'Balance empty after']]);
    var chart = h('div'); f.out.appendChild(chart);
    legend(f.out, [['credit balance', C.a]]);
    var say = note(f.out);
    function dur(hh) { return hh < 2 ? fmt(hh * 60) + ' min' : fmt(hh, 1) + ' h'; }
    function update() {
      var t = TYPES[names[type()]], v = t[0], earn = t[1], max = earn * 24;
      var base = earn / 60 / v;
      var spend = v * util() / 100 * 60;
      var bal = max * start() / 100, net = spend - earn;
      var tEmpty = net > 0 ? bal / net : Infinity;
      st.base(pct(base, 0) + ' per vCPU');
      st.earn(fmt(earn) + ' credits/h');
      st.spend(fmt(spend) + ' credits/h', net > 0 ? 'warn' : 'ok');
      st.empty(isFinite(tEmpty) ? dur(tEmpty) : 'never', isFinite(tEmpty) && tEmpty < 24 ? 'warn' : 'ok');
      var H = 24, pts = [];
      for (var i = 0; i <= 96; i++) { var x = i / 4; pts.push([x, Math.max(0, Math.min(max, bal - net * x))]); }
      lineChart(chart, { xMin: 0, xMax: H, yMin: 0, yMax: max * 1.05, xTitle: 'Hours at this load', yTitle: 'Credits', series: [{ pts: pts, color: C.a }], hLines: [{ y: max, color: C.m, label: 'max balance ' + fmt(max) }] });
      if (isFinite(tEmpty)) say('A load test shorter than ' + dur(tEmpty) + ' runs on banked credits and passes. After that, standard mode caps the instance at ' + pct(base, 0) + ' per vCPU while the load needs ' + util() + '%. Unlimited mode keeps the speed and bills about ' + fmt(net / 60, 2) + ' surplus vCPU-hours per hour instead. Watch CPUCreditBalance and CPUSurplusCreditBalance.', true);
      else say('This load stays at or under the baseline, so the balance never drains. Credits only help the bursts above ' + pct(base, 0) + ' per vCPU.', false);
    }
    update();
  };

  // ---- Token budget (post: 2026-11-17) ----
  W.tokens = function (node) {
    var f = frame(node, 'Token wall calculator', 'Tokens per call = system prompt + retrieved context + history + the answer. Many providers count the max_tokens you reserve, not the tokens you use, when they check the limit. Agents multiply it by the number of model calls per user request.');
    var u = function () { update(); };
    var sys = number(f, { label: 'System prompt tokens', min: 0, step: 50, value: 200 }, u);
    var ctx = number(f, { label: 'Retrieved context tokens', min: 0, step: 100, value: 2000 }, u);
    var hist = number(f, { label: 'Chat history tokens', min: 0, step: 100, value: 1200 }, u);
    var max = number(f, { label: 'max_tokens reserved for the answer', min: 1, step: 50, value: 1000 }, u);
    var calls = range(f, { label: 'Model calls per user request', min: 1, max: 10, step: 1, value: 1 }, u);
    var rpm = number(f, { label: 'Peak user requests per minute', min: 1, step: 1, value: 120 }, u);
    var lim = number(f, { label: 'TPM limit', min: 1, step: 1000, value: 400000 }, u);
    var rlim = number(f, { label: 'RPM limit', min: 1, step: 1, value: 1000 }, u);
    var st = stats(f.out, [['call', 'Tokens per call'], ['tpm', 'Peak TPM'], ['rpm', 'Peak model RPM'], ['wall', 'Which limit hits first']]);
    var say = note(f.out);
    function update() {
      var per = sys() + ctx() + hist() + max();
      var mrpm = rpm() * calls(), tpm = per * mrpm;
      var tu = tpm / lim(), ru = mrpm / rlim();
      st.call(fmt(per));
      st.tpm(fmt(tpm) + ' (' + pct(tu, 0) + ')', tu > 1 ? 'warn' : 'ok');
      st.rpm(fmt(mrpm) + ' (' + pct(ru, 0) + ')', ru > 1 ? 'warn' : 'ok');
      st.wall(tu >= ru ? 'tokens' : 'requests', tu > 1 || ru > 1 ? 'warn' : '');
      var maxUsers = Math.floor(Math.min(lim() / per, rlim()) / calls());
      say('You use ' + pct(ru, 0) + ' of the request limit but ' + pct(tu, 0) + ' of the token limit. The most user requests per minute you can serve is about ' + fmt(maxUsers) + '. ' + (tu > 1 ? 'You hit the token wall first: trim the context, summarise history, or lower max_tokens to what answers really need.' : 'You fit, but check again when context or agent steps grow.'), tu > 1);
    }
    update();
  };

  // ---- Retry amplification under a rate limit (post: 2026-11-19) ----
  W.retry = function (node) {
    var f = frame(node, 'Retry amplification calculator', 'Steady-state model of a fixed rate limit. Each rejected attempt is retried immediately, up to the retry limit, and retries land in the same window. A retry budget caps retries at a share of first attempts.');
    var u = function () { update(); };
    var limit = number(f, { label: 'Rate limit (requests/min)', min: 1, step: 1, value: 1000 }, u);
    var offered = number(f, { label: 'First attempts (requests/min)', min: 1, step: 1, value: 1064 }, u);
    var retries = range(f, { label: 'Retries per request', min: 0, max: 6, step: 1, value: 1 }, u);
    var budget = range(f, { label: 'Retry budget (0 = none)', min: 0, max: 50, step: 1, value: 0, show: function (v) { return v ? v + '% of first attempts' : 'none'; } }, u);
    var st = stats(f.out, [['first', 'Rejected with no retries'], ['rej', 'Attempts rejected'], ['load', 'Attempts per minute'], ['fail', 'Users who still fail']]);
    var say = note(f.out);
    function update() {
      var C = limit(), L = offered(), r = retries(), b = budget() / 100;
      var f0 = Math.max(0, 1 - C / L), fr = f0, T = L;
      for (var i = 0; i < 400; i++) {
        var geo = 0, pw = 1;
        for (var k = 1; k <= r; k++) { pw *= fr; geo += pw; }
        var re = L * geo;
        if (b > 0) re = Math.min(re, b * L);
        T = L + re;
        var nf = Math.max(0, 1 - C / T);
        if (Math.abs(nf - fr) < 1e-9) break;
        fr = fr + 0.5 * (nf - fr);
      }
      var served = Math.min(C, T);
      var userFail = Math.max(0, 1 - served / L);
      st.first(pct(f0, 1));
      st.rej(pct(fr, 1), fr > f0 * 2 ? 'warn' : '');
      st.load(fmt(T) + ' (' + fmt(T / L, 2) + '×)', T / L > 1.3 ? 'warn' : '');
      st.fail(pct(userFail, 1));
      if (L <= C) say('Load fits under the limit, so nothing is rejected in steady state. Retries only matter for bursts.', false);
      else say('Retries cannot create capacity: ' + fmt(C) + ' requests a minute succeed either way, so ' + pct(userFail, 1) + ' of users still fail. What retries change is the load (' + fmt(T / L, 2) + '× the first attempts), the rejection rate (' + pct(f0, 1) + ' → ' + pct(fr, 1) + ') and the latency of everyone who waited for a retry. Back off with jitter and honour Retry-After so retries move into quieter seconds, and cap them with a budget.', fr > f0 * 2);
    }
    update();
  };

  // ---- Averaging percentiles across pods (post: 2026-11-20) ----
  W.pctmerge = function (node) {
    var f = frame(node, 'Averaged p99 vs real p99', 'Each pod serves fast requests (20 ms) and a share of slow ones (1,200 ms). The real p99 comes from all requests together. Averaging the pods\' p99 values gives every pod the same weight, whatever its traffic.');
    var u = function () { update(); };
    var pods = range(f, { label: 'Pods', min: 2, max: 12, step: 1, value: 4 }, u);
    var share = range(f, { label: 'Traffic on the busiest pod', min: 5, max: 90, step: 1, value: 70, show: function (v) { return v + '%'; } }, u);
    var hot = range(f, { label: 'Slow requests on the busiest pod', min: 0, max: 20, step: 0.1, value: 5, show: function (v) { return fmt(v, 1) + '%'; } }, u);
    var cold = range(f, { label: 'Slow requests on the other pods', min: 0, max: 20, step: 0.1, value: 0.2, show: function (v) { return fmt(v, 1) + '%'; } }, u);
    var st = stats(f.out, [['avg', 'Average of pod p99s'], ['real', 'Real p99 (merged)'], ['max', 'Worst pod p99'], ['slow', 'Slow requests overall']]);
    var say = note(f.out);
    var FAST = 20, SLOW = 1200;
    function p99(slowFrac) { return slowFrac > 0.01 ? SLOW : FAST; }
    function update() {
      var n = pods(), s = share() / 100, hs = hot() / 100, cs = cold() / 100;
      if (s < 1 / n) s = 1 / n;
      var avg = (p99(hs) + (n - 1) * p99(cs)) / n;
      var all = s * hs + (1 - s) * cs;
      var real = p99(all);
      st.avg(ms(avg));
      st.real(ms(real), real > avg ? 'warn' : 'ok');
      st.max(ms(Math.max(p99(hs), p99(cs))));
      st.slow(pct(all, 2));
      if (real > avg) say('The dashboard says ' + ms(avg) + ', a latency no request actually had. ' + pct(all, 2) + ' of all requests are slow, more than 1%, so the real p99 is ' + ms(real) + '. Merge histograms (sum the bucket counts across pods) before you take the quantile.', true);
      else if (avg > real) say('Here the average overstates p99: the slow pod gets a full 1/' + n + ' vote but serves little traffic. Averaging is wrong in both directions.', true);
      else say('The average happens to match the merged value here. Change the traffic split and it stops matching. The merged quantile always lies between the best and worst pod p99, so the worst pod is a safe upper bound.', false);
    }
    update();
  };

  function init() {
    if (!document.getElementById('widget-css')) {
      var style = document.createElement('style');
      style.id = 'widget-css';
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    document.querySelectorAll('[data-widget]').forEach(function (node) {
      var fn = W[node.getAttribute('data-widget')];
      if (!fn) return;
      try { fn(node); } catch (err) { if (window.console) console.error('widget failed', err); }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
