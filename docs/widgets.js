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
    var input = h('input', { type: 'number', min: o.min, step: o.step || 'any', value: o.value });
    input.addEventListener('input', onChange);
    f.controls.appendChild(h('label', {}, [h('span', { text: o.label }), input]));
    return function () {
      var v = parseFloat(input.value);
      return isFinite(v) && v >= (o.min || 0) ? v : o.value;
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

  // Line chart. o: {xMin,xMax,yMin,yMax,logY,xTicks:[[v,label]],yFmt,xTitle,yTitle,series:[{pts,color,dash,width}],hLines:[{y,color,label}],points:[{x,y,color,label}]}
  function lineChart(host, o) {
    var W = chartWidth(host), H = 270, L = 74, R = 16, T = 14, B = 42;
    var ly = o.logY ? Math.log10 : function (v) { return v; };
    var X = function (v) { return L + (v - o.xMin) / (o.xMax - o.xMin) * (W - L - R); };
    var Y = function (v) {
      var r = (ly(Math.max(v, o.logY ? o.yMin : -Infinity)) - ly(o.yMin)) / (ly(o.yMax) - ly(o.yMin));
      return T + (1 - Math.min(Math.max(r, 0), 1)) * (H - T - B);
    };
    var svg = s('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img' });
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
      var d = se.pts.map(function (p, i) { return (i ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1); }).join(' ');
      svg.appendChild(s('path', { d: d, fill: 'none', 'stroke-dasharray': se.dash || '' }, { stroke: se.color, strokeWidth: se.width || 2.5, strokeLinejoin: 'round' }));
    });
    (o.points || []).forEach(function (p) {
      svg.appendChild(s('circle', { cx: X(p.x), cy: Y(p.y), r: 5 }, { fill: p.color, stroke: 'var(--surface)', strokeWidth: 2 }));
      if (p.label) svg.appendChild(s('text', { x: X(p.x) + (X(p.x) > W - 160 ? -8 : 8), y: Y(p.y) - 9, 'text-anchor': X(p.x) > W - 160 ? 'end' : 'start', text: p.label }));
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
      var x = load(), ua = x * apiMs() / 1000 / apiCores(), ud = x * dbMs() / 1000 / dbCores();
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
      if (x >= ceil) say('Offered load is above the ' + tier + ' ceiling of ' + fmt(ceil) + ' req/s. Throughput flattens and queues grow until requests time out. Tuning the other tier changes nothing.', true);
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
      var closed = Math.ceil(x * (r + z));
      var pre = Math.max(1, Math.ceil(x * r * 1.2));       // busy VUs at normal latency, plus 20%
      var max = Math.max(pre, Math.ceil(x * r * 5));        // room for latency to grow 5× before iterations drop
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
    var st = stats(f.out, [['origin', 'Origin traffic'], ['util', 'Origin utilisation'], ['min', 'Lowest safe hit ratio']]);
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
        xMin: 50, xMax: 100, yMin: 0, yMax: e * 0.5, xTitle: 'Hit ratio (%)', yTitle: 'Origin req/s',
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
      var I = interval(), r = Math.min(normal(), I), S = stall() * 1000, T = run() * 1000;
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
      say('The tool recorded ' + fmt(n + 1) + ' samples. Users would have sent ' + fmt(n + m) + '. Reported p99 understates the real p99 by about ' + fmt(av[2] / rv[2]) + '×.', av[2] / rv[2] > 2);
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
    var st = stats(f.out, [['threads', 'Thread pool size'], ['x', 'CPU-bound max throughput'], ['xp', 'Connection-pool max throughput'], ['q', 'Queue bound']]);
    var say = note(f.out);
    function update() {
      var N = cores() * util() / 100 * (1 + wait() / comp());
      var X = cores() * util() / 100 / (comp() / 1000);
      // Assumes each request holds a database connection for its wait time.
      var Xp = wait() > 0 ? pool() / (wait() / 1000) : Infinity;
      var Xe = Math.min(X, Xp);
      st.threads(fmt(Math.ceil(N)) + ' threads');
      st.x(fmt(X) + ' req/s', X <= Xp ? 'ok' : '');
      st.xp(isFinite(Xp) ? fmt(Xp) + ' req/s' : 'n/a', Xp < X ? 'warn' : '');
      st.q(fmt(Math.max(1, Math.floor(budget() / 1000 * Xe))) + ' tasks');
      var L = X * (comp() + wait()) / 1000;
      if (Xp < X) say('The connection pool is the real limit: at most ' + fmt(Xp) + ' req/s if each request holds a connection for its ' + ms(wait()) + ' wait. ' + fmt(Math.ceil(N)) + ' threads would leave about ' + fmt(Math.max(0, Math.ceil(N) - pool())) + ' parked waiting for a connection. Size the pools together.', true);
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
    var peak = number(f, { label: 'Share in the busiest hour (%)', min: 1, value: 30 }, u);
    var burst = number(f, { label: 'Burst factor (peak minute ÷ hour average)', min: 1, value: 3 }, u);
    var calls = number(f, { label: 'API calls per order', min: 1, value: 6 }, u);
    var cpu = number(f, { label: 'CPU ms per API request', min: 0.1, value: 15 }, u);
    var target = number(f, { label: 'Target CPU utilisation (%)', min: 1, value: 60 }, u);
    var podCores = number(f, { label: 'Cores per pod', min: 0.25, value: 2 }, u);
    var poolSize = number(f, { label: 'DB pool size per pod', min: 1, value: 10 }, u);
    var maxConn = number(f, { label: 'Database max connections', min: 1, value: 100 }, u);
    var st = stats(f.out, [['avg', 'Peak-hour average'], ['peak', 'Peak orders'], ['rps', 'API requests'], ['cores', 'Cores needed'], ['pods', 'Pods at peak'], ['conn', 'DB connections']]);
    var say = note(f.out);
    function update() {
      var avg = orders() * peak() / 100 / 3600, pk = avg * burst(), rps = pk * calls();
      var busy = rps * cpu() / 1000, need = busy / (Math.min(target(), 100) / 100);
      var pods = Math.ceil(need / podCores()), conns = pods * poolSize();
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
