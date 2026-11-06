/* Workload model page UI. Logs are read by worker.js in this browser; nothing is uploaded. */
(() => {
  'use strict';
  const W = window.Workload;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nf = (x, d) => (x == null || isNaN(x) ? '—' : Number(x).toLocaleString('en-AU', { maximumFractionDigits: d == null ? 0 : d, minimumFractionDigits: 0 }));
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p2 = (n) => (n < 10 ? '0' : '') + n;
  // times are wall-clock values stored as if UTC, so read them back with getUTC*
  const fDay = (ms) => { const d = new Date(ms); return DAYS[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MON[d.getUTCMonth()]; };
  const fHM = (ms) => { const d = new Date(ms); return p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()); };
  const fHMS = (ms) => fHM(ms) + ':' + p2(new Date(ms).getUTCSeconds());
  const fBytes = (b) => (b >= 1e9 ? nf(b / 1e9, 2) + ' GB' : b >= 1e6 ? nf(b / 1e6, 1) + ' MB' : nf(b / 1e3, 0) + ' KB');
  const fDur = (s) => (isNaN(s) ? '—' : s < 60 ? nf(s, 1) + ' s' : s < 3600 ? nf(s / 60, 1) + ' min' : nf(s / 3600, 1) + ' h');

  const state = { sources: null, formatInfo: null, result: null, model: null, merges: {}, showAll: false, worker: null, timelineMode: 'minute' };

  // ------------------------------------------------------------ settings UI
  const tzSel = $('tz');
  const browserOff = -new Date().getTimezoneOffset();
  for (let m = -12 * 60; m <= 14 * 60; m += 30) {
    const o = document.createElement('option');
    o.value = m;
    const a = Math.abs(m);
    o.textContent = 'UTC' + (m < 0 ? '−' : '+') + p2(Math.floor(a / 60)) + ':' + p2(a % 60) + (m === browserOff ? ' (this browser)' : m === 0 ? ' (no change)' : '');
    if (m === browserOff) o.selected = true;
    tzSel.appendChild(o);
  }

  function showErr(msg) { const e = $('err'); e.textContent = msg; e.hidden = !msg; }

  // ------------------------------------------------------------ input
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('over')));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length) start(files.map((file) => ({ file })));
  });
  $('files').addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length) start(files.map((file) => ({ file })));
  });
  $('sample').addEventListener('click', () => {
    const text = W.generateSampleLog({ lines: 120000, seed: 7 });
    $('fmt').value = 'auto';
    start([{ name: 'sample-shop-access.log', text }]);
  });
  $('paste-go').addEventListener('click', () => {
    const text = $('paste').value;
    if (!text.trim()) { showErr('Paste a few log lines first.'); return; }
    start([{ name: 'pasted lines', text }]);
  });
  $('reanalyse').addEventListener('click', () => { if (state.sources) start(state.sources, true); });
  $('cancel').addEventListener('click', () => {
    if (state.worker) { state.worker.terminate(); state.worker = null; }
    $('progress').hidden = true;
    showErr('Cancelled.');
  });

  async function readHead(file) {
    const magic = new Uint8Array(await file.slice(0, 2).arrayBuffer());
    const gz = magic[0] === 0x1f && magic[1] === 0x8b;
    let stream = file.slice(0, 1 << 18).stream();
    if (gz) {
      if (typeof DecompressionStream === 'undefined') throw new Error(file.name + ' is gzipped and this browser cannot unzip it. Unzip it first, or use a current Chrome, Edge, Firefox or Safari.');
      stream = stream.pipeThrough(new DecompressionStream('gzip'));
    }
    const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
    let text = '';
    try {
      while (text.length < 200000) {
        const { value, done } = await reader.read();
        if (done) break;
        text += value;
      }
    } catch (e) { /* a sliced gzip ends early: keep what we have */ }
    reader.cancel().catch(() => {});
    const cut = text.lastIndexOf('\n');
    return cut > 0 ? text.slice(0, cut) : text;
  }

  async function start(sources, keepFormat) {
    showErr('');
    if (state.worker) { state.worker.terminate(); state.worker = null; }
    state.sources = sources;
    try {
      let info = keepFormat && state.formatInfo ? state.formatInfo : null;
      if (!info) {
        const first = sources[0];
        const head = first.text != null ? first.text.slice(0, 200000) : await readHead(first.file);
        const det = W.detectFormat(head);
        const forced = $('fmt').value;
        if (forced !== 'auto' && (!det || det.format !== forced)) {
          if (forced === 'csv' || forced === 'jsonl') throw new Error('Could not read columns from this file as ' + W.FORMAT_LABELS[forced] + '.');
          info = { format: forced };
        } else info = det;
        if (!info) throw new Error('Could not recognise the log format. Supported: nginx/Apache combined or common, AWS ALB, CloudFront, IIS W3C, CSV with a header row, or JSON lines. Try “Format” in the settings, or paste a few lines to check.');
      }
      state.formatInfo = info;
      const names = sources.map((s) => (s.file ? s.file.name : s.name));
      const d = $('detected');
      d.innerHTML = 'Reading <b>' + esc(names.length > 3 ? names.length + ' files' : names.join(', ')) + '</b> as <b>' + esc(W.FORMAT_LABELS[info.format] || info.format) + '</b>.';
      d.hidden = false;
      if ((info.format === 'csv' || info.format === 'jsonl') && !keepFormat) { showMapping(info); return; }
      $('mapping').hidden = true;
      run();
    } catch (e) {
      showErr(e.message);
    }
  }

  const MAP_FIELDS = [['time', 'Timestamp *'], ['method', 'Method'], ['path', 'Path or URL *'], ['status', 'Status code'], ['rt', 'Response time'], ['ip', 'Client IP'], ['ua', 'User agent']];
  function showMapping(info) {
    const box = $('map-fields');
    const opts = (sel) => '<option value="">(none)</option>' + info.columns.map((c, i) => {
      const v = info.format === 'csv' ? i : c;
      return '<option value="' + esc(v) + '"' + (String(sel) === String(v) ? ' selected' : '') + '>' + esc(c) + '</option>';
    }).join('');
    box.innerHTML = MAP_FIELDS.map(([k, label]) => {
      const cur = info.mapping[k];
      return '<label>' + esc(label) + '<select data-map="' + k + '">' + opts(cur === -1 ? '' : cur) + '</select></label>';
    }).join('') + '<label>Response time unit<select id="map-unit">' +
      [['ms', 'milliseconds'], ['s', 'seconds'], ['us', 'microseconds']].map(([v, l]) => '<option value="' + v + '"' + (info.rtUnit === v ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></label>';
    $('map-sub').textContent = 'Read as ' + W.FORMAT_LABELS[info.format] + ' with ' + info.columns.length + ' columns. We guessed from the names and values; check them, then analyse.';
    $('mapping').hidden = false;
    $('mapping').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  $('map-go').addEventListener('click', () => {
    const info = state.formatInfo;
    const mapping = {};
    document.querySelectorAll('[data-map]').forEach((s) => {
      const v = s.value;
      mapping[s.dataset.map] = v === '' ? (info.format === 'csv' ? -1 : '') : info.format === 'csv' ? +v : v;
    });
    if (mapping.time === -1 || mapping.time === '' || mapping.path === -1 || mapping.path === '') { showErr('Pick the timestamp and path columns.'); return; }
    info.mapping = mapping;
    info.rtUnit = $('map-unit').value;
    showErr('');
    run();
  });

  function run() {
    const w = new Worker('/tools/workload-model/worker.js');
    state.worker = w;
    const prog = $('progress'), bar = $('meter').firstElementChild, txt = $('prog-text');
    prog.hidden = false; bar.style.width = '0%'; txt.textContent = 'Starting…';
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') {
        const pct = m.totalBytes ? Math.min(100, (m.bytes / m.totalBytes) * 100) : 0;
        bar.style.width = pct.toFixed(1) + '%';
        $('meter').setAttribute('aria-valuenow', Math.round(pct));
        const rate = m.ms > 0 ? m.lines / (m.ms / 1000) : 0;
        txt.textContent = 'Read ' + fBytes(m.bytes) + ' of ' + fBytes(m.totalBytes) + ' · ' + nf(m.lines) + ' lines · ' + nf(rate) + ' lines/s';
      } else if (m.type === 'done') {
        w.terminate(); state.worker = null;
        prog.hidden = true;
        state.result = m.result;
        if (!m.result.parsed) {
          showErr('No lines matched ' + (W.FORMAT_LABELS[m.result.format] || m.result.format) + '.' + (m.result.unparsedSample ? ' First line that did not match: ' + m.result.unparsedSample.slice(0, 160) : ''));
          $('result').hidden = true;
          return;
        }
        if (m.result.ruleErrors && m.result.ruleErrors.length) showErr('Some rules were ignored: ' + m.result.ruleErrors.join('; '));
        $('reanalyse').disabled = false;
        state.showAll = false;
        $('result').hidden = false; // visible first, so charts measure their real width
        renderAll();
        $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
        if (window.goatcounter && window.goatcounter.count) window.goatcounter.count({ path: 'workload-model-analysed', title: 'workload-model-analysed', event: true });
      } else if (m.type === 'error') {
        w.terminate(); state.worker = null;
        prog.hidden = true;
        showErr(m.message);
      }
    };
    w.onerror = (e) => { prog.hidden = true; showErr('The reader stopped: ' + (e.message || 'unknown error')); };
    w.postMessage({
      sources: state.sources,
      options: { formatInfo: state.formatInfo, tzShiftMin: +tzSel.value, rulesText: $('rules').value }
    });
  }

  // ------------------------------------------------------------ settings -> model
  const num = (id) => { const v = $(id).value; return v === '' ? null : +v; };
  function settings() {
    return {
      excludeStatic: $('x-static').checked, excludeBots: $('x-bots').checked, merges: state.merges,
      basis: $('basis').value, growth: num('growth') || 1, headroom: num('headroom') || 0, coverage: num('coverage') || 1,
      rtMs: num('rt'), thinkS: num('think'), topN: num('topn') || 8, profile: $('profile').value,
      durationMin: num('dur') || 30, rampMin: num('ramp') == null ? 5 : num('ramp'), compressMin: num('comp') || 24, baseUrl: $('base').value
    };
  }

  function renderAll() {
    state.model = W.buildModel(state.result, settings());
    renderPeak(); renderMix(); renderSessions(); renderModel(); renderExport();
  }
  function renderLight() {
    state.model = W.buildModel(state.result, settings());
    renderModel(); renderExport();
  }
  ['x-static', 'x-bots'].forEach((id) => $(id).addEventListener('change', () => state.result && renderAll()));
  ['basis', 'growth', 'headroom', 'coverage', 'rt', 'think', 'topn', 'profile', 'dur', 'ramp', 'comp', 'base'].forEach((id) =>
    $(id).addEventListener('input', () => state.result && renderLight()));
  $('profile').addEventListener('change', () => {
    const p = $('profile').value;
    $('l-ramp').hidden = p !== 'ramp'; $('l-dur').hidden = p === 'curve'; $('l-comp').hidden = p !== 'curve';
  });

  // ------------------------------------------------------------ peak
  function stat(value, label, cls) { return '<div class="stat' + (cls ? ' ' + cls : '') + '"><b>' + value + '</b><span>' + label + '</span></div>'; }

  function renderPeak() {
    const r = state.result, m = state.model, p = m.peak;
    const spanS = (r.maxT - r.minT) / 1000;
    $('peak-sub').innerHTML = 'Read ' + nf(r.lines) + ' lines' + (r.bytes ? ' (' + fBytes(r.bytes) + ')' : '') + (r.ms != null ? ' in ' + nf(r.ms / 1000, 1) + ' s' : '') +
      ' as ' + esc(r.formatLabel || r.format) + '. ' + (r.unparsed ? '<b>' + nf(r.unparsed) + ' lines not recognised</b> and skipped. ' : '') +
      'Excluded ' + nf(m.excluded.static) + ' static and ' + nf(m.excluded.bots) + ' health-check or bot requests. Times are as written in the log' +
      (r.format === 'clf' || r.format === 'csv' || r.format === 'jsonl' ? '' : ' (shifted from UTC by your timezone setting)') + '.';
    $('peak-stats').innerHTML = [
      stat(nf(m.total), 'requests analysed'),
      stat(fDur(spanS), 'time span'),
      stat(fDay(p.hourStart) + ' ' + fHM(p.hourStart), 'peak hour starts'),
      stat(nf(p.hourAvgRps, 2), 'req/s, peak hour average'),
      stat(nf(p.minuteRps, 2), 'req/s, busiest minute (' + fHM(p.minuteStart) + ')'),
      stat(nf(p.p99SecRps), 'req/s, 99th percentile second', 'hl'),
      stat(nf(p.maxSecRps), 'req/s, busiest second (' + fHMS(p.maxSecT) + ')')
    ].join('');
    renderTimeline();
    renderHourChart();
    renderHod();
  }

  function niceMax(v) {
    if (!(v > 0)) return 1;
    const e = Math.pow(10, Math.floor(Math.log10(v)));
    for (const f of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (f * e >= v) return f * e;
    return 10 * e;
  }

  // Area chart over time. xs in ms (wall clock), ys dense. Returns nothing; wires hover readout.
  function areaChart(box, o) {
    const w = Math.max(260, Math.floor(box.clientWidth || 800));
    const h = w < 520 ? 170 : 220;
    const L = 40, R = 8, T = 10, B = 24;
    const pw = w - L - R, ph = h - T - B;
    const n = o.ys.length;
    const cols = Math.max(1, Math.min(n, Math.floor(pw)));
    const colMax = new Float64Array(cols), colIdx = new Int32Array(cols).fill(-1);
    for (let i = 0; i < n; i++) {
      const c = Math.min(cols - 1, Math.floor((i / n) * cols));
      if (colIdx[c] < 0 || o.ys[i] > colMax[c]) { colMax[c] = o.ys[i]; colIdx[c] = i; }
    }
    let ymax = 0;
    for (let c = 0; c < cols; c++) if (colMax[c] > ymax) ymax = colMax[c];
    for (const rl of o.refs || []) if (rl.v > ymax) ymax = rl.v;
    ymax = niceMax(ymax);
    const X = (c) => L + (cols === 1 ? pw / 2 : (c / (cols - 1)) * pw);
    const Y = (v) => T + ph - (v / ymax) * ph;
    const s = [];
    s.push('<svg viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '" role="img" aria-label="' + esc(o.aria) + '">');
    for (const f of [0, 0.5, 1]) {
      const y = Y(ymax * f);
      s.push('<line class="wm-grid" x1="' + L + '" x2="' + (w - R) + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '"/>');
      s.push('<text class="wm-axis" x="' + (L - 6) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="end">' + nf(ymax * f, ymax < 5 ? 1 : 0) + '</text>');
    }
    if (o.shade) {
      const a = Math.max(0, Math.floor((o.shade[0] / n) * cols)), b = Math.min(cols - 1, Math.ceil((o.shade[1] / n) * cols));
      if (b >= a) s.push('<rect class="wm-peak" x="' + X(a).toFixed(1) + '" y="' + T + '" width="' + Math.max(2, X(b) - X(a)).toFixed(1) + '" height="' + ph + '"/>');
    }
    let d = 'M' + X(0).toFixed(1) + ' ' + Y(colMax[0]).toFixed(1);
    for (let c = 1; c < cols; c++) d += 'L' + X(c).toFixed(1) + ' ' + Y(colMax[c]).toFixed(1);
    s.push('<path class="wm-area" d="' + d + 'L' + X(cols - 1).toFixed(1) + ' ' + Y(0) + 'L' + X(0).toFixed(1) + ' ' + Y(0) + 'Z"/>');
    s.push('<path class="wm-line" d="' + d + '"/>');
    for (const rl of o.refs || []) s.push('<line class="wm-ref ' + rl.cls + '" x1="' + L + '" x2="' + (w - R) + '" y1="' + Y(rl.v).toFixed(1) + '" y2="' + Y(rl.v).toFixed(1) + '"/>');
    // x labels
    const nl = w < 520 ? 3 : 6;
    for (let k = 0; k <= nl; k++) {
      const c = Math.round((k / nl) * (cols - 1));
      const i = colIdx[c] < 0 ? Math.floor((c / cols) * n) : colIdx[c];
      s.push('<text class="wm-axis" x="' + X(c).toFixed(1) + '" y="' + (h - 6) + '" text-anchor="' + (k === 0 ? 'start' : k === nl ? 'end' : 'middle') + '">' + esc(o.xLabel(i)) + '</text>');
    }
    s.push('<line class="wm-cross" x1="0" x2="0" y1="' + T + '" y2="' + (T + ph) + '" visibility="hidden"/><circle class="wm-dot" r="4" cx="0" cy="0" visibility="hidden"/>');
    s.push('<rect x="' + L + '" y="' + T + '" width="' + pw + '" height="' + ph + '" fill="transparent" class="hit"/></svg>');
    const leg = o.legend ? '<div class="legend">' + o.legend + '</div>' : '';
    box.innerHTML = '<div class="chart-head"><h3>' + esc(o.title) + '</h3>' + (o.control || '') + '</div>' + leg + s.join('') + '<p class="readout">' + esc(o.hint || 'Hover or tap the chart for values.') + '</p>';
    const svg = box.querySelector('svg'), cross = svg.querySelector('.wm-cross'), dot = svg.querySelector('.wm-dot'), out = box.querySelector('.readout');
    const move = (ev) => {
      const rect = svg.getBoundingClientRect();
      const x = ((ev.clientX - rect.left) / rect.width) * w;
      const c = Math.max(0, Math.min(cols - 1, Math.round(((x - L) / pw) * (cols - 1))));
      const i = colIdx[c] < 0 ? Math.floor((c / cols) * n) : colIdx[c];
      cross.setAttribute('x1', X(c)); cross.setAttribute('x2', X(c)); cross.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', X(c)); dot.setAttribute('cy', Y(colMax[c])); dot.setAttribute('visibility', 'visible');
      out.textContent = o.readout(i, colMax[c]);
    };
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerdown', move);
    svg.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); });
    const ctl = box.querySelector('select');
    if (ctl && o.onControl) ctl.addEventListener('change', () => o.onControl(ctl.value));
  }

  function renderTimeline() {
    const m = state.model, r = state.result;
    const box = $('chart-timeline');
    const firstS = Math.floor(r.minT / 1000), lastS = Math.floor(r.maxT / 1000);
    const spanS = lastS - firstS + 1;
    let mode = state.timelineMode;
    if (mode === 'second' && spanS > 8 * 86400) mode = 'minute';
    if (mode === 'minute' && spanS > 45 * 86400) mode = 'hour';
    const step = mode === 'second' ? 1 : mode === 'minute' ? 60 : 3600;
    const start = Math.floor(firstS / step) * step;
    const n = Math.floor((lastS - start) / step) + 1;
    const ys = new Float64Array(n);
    if (mode === 'second') { for (let i = 0; i < m.T.length; i++) ys[m.T[i] - start] = m.per[i]; }
    else {
      const src = mode === 'minute' ? m.minMap : m.hourMap;
      for (const [k, v] of src) { const i = k - start / step; if (i >= 0 && i < n) ys[i] = v / step; }
    }
    const ph0 = (m.peak.hourStart / 1000 - start) / step;
    const ctl = '<label class="note" style="margin:0">Show <select id="tl-mode" aria-label="Chart resolution">' +
      '<option value="minute"' + (mode === 'minute' ? ' selected' : '') + '>per minute (average req/s)</option>' +
      (spanS <= 8 * 86400 ? '<option value="second"' + (mode === 'second' ? ' selected' : '') + '>per second (peak in each pixel)</option>' : '') +
      '<option value="hour"' + (mode === 'hour' ? ' selected' : '') + '>per hour (average req/s)</option></select></label>';
    const multiDay = spanS > 36 * 3600;
    areaChart(box, {
      title: 'Requests per second across the log',
      aria: 'Requests per second over time; the peak hour is shaded',
      ys, shade: [ph0, ph0 + 3600 / step], control: ctl,
      legend: '<span><i class="line"></i>req/s</span><span><i style="border-top:10px solid color-mix(in srgb, var(--warn) 30%, transparent);height:0"></i>peak hour</span>',
      xLabel: (i) => { const r = spanS > 6 * 3600 ? 3600000 : spanS > 1800 ? 300000 : 1000; const t = Math.round(((start + i * step) * 1000) / r) * r; return multiDay ? fDay(t).replace(/^\w+ /, '') + ' ' + fHM(t) : fHM(t); },
      readout: (i, v) => { const t = (start + i * step) * 1000; return fDay(t) + ' ' + (step === 1 ? fHMS(t) : fHM(t)) + ' · ' + nf(v, 2) + ' req/s' + (n > 900 ? ' (highest in this slice)' : ''); },
      onControl: (v) => { state.timelineMode = v; renderTimeline(); }
    });
  }

  function renderHourChart() {
    const m = state.model;
    const a = m.hourSecStart, b = m.hourSecEnd;
    const ys = Array.from(m.hourSecs.slice(a, b));
    const t0 = m.peak.hourStart + a * 1000;
    areaChart($('chart-hour'), {
      title: 'Peak hour, second by second',
      aria: 'Requests per second for each second of the peak hour with reference lines',
      ys,
      refs: [{ v: m.peak.p99SecRps, cls: 'p99' }, { v: m.peak.minuteRps, cls: 'min' }, { v: m.peak.hourAvgRps, cls: 'avg' }],
      legend: '<span><i class="line"></i>req/s each second</span><span><i class="p99"></i>99th pct second ' + nf(m.peak.p99SecRps) + '</span>' +
        '<span><i class="min"></i>busiest minute avg ' + nf(m.peak.minuteRps, 1) + '</span><span><i class="avg"></i>hour avg ' + nf(m.peak.hourAvgRps, 1) + '</span>',
      xLabel: (i) => fHM(t0 + i * 1000),
      readout: (i, v) => fHMS(t0 + i * 1000) + ' · ' + nf(v) + ' req/s' + (ys.length > 900 ? ' (highest in this slice)' : '')
    });
  }

  function renderHod() {
    const m = state.model, box = $('chart-hod');
    const w = Math.max(260, Math.floor(box.clientWidth || 800)), h = w < 520 ? 150 : 180;
    const L = 40, R = 8, T = 10, B = 24, pw = w - L - R, ph = h - T - B;
    const ymax = niceMax(Math.max.apply(null, m.hod));
    const peakH = m.hod.indexOf(Math.max.apply(null, m.hod));
    const cw = pw / 24, gap = Math.min(4, cw * 0.25);
    const s = ['<svg viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '" role="img" aria-label="Average requests per second by hour of day">'];
    for (const f of [0, 0.5, 1]) {
      const y = T + ph - f * ph;
      s.push('<line class="wm-grid" x1="' + L + '" x2="' + (w - R) + '" y1="' + y + '" y2="' + y + '"/><text class="wm-axis" x="' + (L - 6) + '" y="' + (y + 4) + '" text-anchor="end">' + nf(ymax * f, ymax < 5 ? 1 : 0) + '</text>');
    }
    for (let i = 0; i < 24; i++) {
      const v = m.hod[i], bh = Math.max(v > 0 ? 1 : 0, (v / ymax) * ph);
      const x = L + i * cw + gap / 2, y = T + ph - bh;
      s.push('<path class="wm-col' + (i === peakH ? ' hot' : '') + '" data-h="' + i + '" d="M' + x.toFixed(1) + ' ' + (T + ph) + 'V' + (y + Math.min(3, bh)).toFixed(1) +
        'q0 -' + Math.min(3, bh).toFixed(1) + ' ' + Math.min(3, (cw - gap) / 2).toFixed(1) + ' -' + Math.min(3, bh).toFixed(1) + 'H' + (x + cw - gap - Math.min(3, (cw - gap) / 2)).toFixed(1) +
        'q' + Math.min(3, (cw - gap) / 2).toFixed(1) + ' 0 ' + Math.min(3, (cw - gap) / 2).toFixed(1) + ' ' + Math.min(3, bh).toFixed(1) + 'V' + (T + ph) + 'Z"/>');
      if (i % (w < 520 ? 6 : 3) === 0) s.push('<text class="wm-axis" x="' + (L + i * cw + cw / 2).toFixed(1) + '" y="' + (h - 6) + '" text-anchor="middle">' + p2(i) + ':00</text>');
    }
    s.push('<rect class="hit" x="' + L + '" y="' + T + '" width="' + pw + '" height="' + ph + '" fill="transparent"/></svg>');
    box.innerHTML = '<div class="chart-head"><h3>Daily curve: average req/s by hour of day</h3></div>' + s.join('') +
      '<p class="readout">Busiest hour of day: ' + p2(peakH) + ':00 (' + nf(m.hod[peakH], 2) + ' req/s). The “daily curve” k6 profile follows this shape.</p>';
    const svg = box.querySelector('svg'), out = box.querySelector('.readout');
    const move = (ev) => {
      const rect = svg.getBoundingClientRect();
      const x = ((ev.clientX - rect.left) / rect.width) * w;
      const i = Math.max(0, Math.min(23, Math.floor((x - L) / cw)));
      out.textContent = p2(i) + ':00–' + p2(i) + ':59 · ' + nf(m.hod[i], 2) + ' req/s on average (' + nf((m.hod[i] / (m.hod[peakH] || 1)) * 100) + '% of the busiest hour)';
    };
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerdown', move);
  }

  // ------------------------------------------------------------ mix
  function renderMix() {
    const m = state.model, r = state.result;
    const rows = state.showAll ? m.mix : m.mix.slice(0, 40);
    const maxShare = m.mix.length ? m.mix[0].share : 1;
    $('mix-sub').innerHTML = nf(m.peakTotal) + ' requests between ' + fHM(m.peak.hourStart) + ' and ' + fHM(m.peak.hourStart + 3600000) + ' on ' + fDay(m.peak.hourStart) +
      ', grouped into ' + nf(m.mix.length) + ' endpoints. Tick rows and “Merge selected” to treat them as one transaction.';
    const h = ['<thead><tr><th scope="col"><span class="visually-hidden">Select</span></th><th class="ep" scope="col">Endpoint</th><th scope="col">Count</th><th scope="col">% of traffic</th>' +
      '<th scope="col">req/s peak hr</th><th scope="col">req/s at target</th><th scope="col">p95 ms</th><th scope="col">5xx %</th></tr></thead><tbody>'];
    for (const row of rows) {
      const lead = row.members[0];
      const label = row.merged
        ? '<code>' + esc(row.label) + '</code><span class="members">' + row.members.length + ' merged: ' + row.members.map((x) => esc(x.label)).join(', ') +
          ' <button class="chip-btn" type="button" data-unmerge="' + esc(row.label) + '">Split</button></span>'
        : '<span class="m">' + esc(lead.method) + '</span><code>' + esc(lead.ep) + '</code>' + (lead.cls === 1 ? ' <span class="m">static</span>' : lead.cls === 2 ? ' <span class="m">bot/health</span>' : '');
      h.push('<tr><td><input type="checkbox" data-sel="' + esc(row.label) + '" aria-label="Select ' + esc(row.label) + '"></td><td class="ep">' + label + '</td>' +
        '<td>' + nf(row.count) + '</td><td>' + nf(row.share * 100, 1) + '%<span class="share" style="width:' + Math.max(2, Math.round((row.share / maxShare) * 40)) + 'px"></span></td>' +
        '<td>' + nf(row.rps, 2) + '</td><td>' + nf(row.share * m.model.target, 2) + '</td><td>' + (isNaN(row.p95) ? '—' : nf(row.p95)) + '</td>' +
        '<td class="' + (row.errPct >= 1 ? 'bad' : '') + '">' + (row.errPct ? nf(row.errPct, 2) : '0') + '</td></tr>');
    }
    h.push('</tbody>');
    $('mix-table').innerHTML = h.join('');
    const more = $('more-rows');
    more.hidden = m.mix.length <= 40;
    more.textContent = state.showAll ? 'Show top 40' : 'Show all ' + nf(m.mix.length);
    const notes = [];
    if (!r.hasRt) notes.push('No response times in this log, so p95 is blank and the model uses a default; add $request_time (nginx) or %D (Apache) to your log format.');
    else if (r.rtShare < 0.9) notes.push('Only ' + nf(r.rtShare * 100) + '% of lines had a response time.');
    if (r.overflow) notes.push('More than 5,000 distinct endpoints: ' + nf(r.overflow) + ' requests were grouped as “(other endpoints)”. Add a rule in “Format, timezone and endpoint rules” for paths with slugs, then re-analyse.');
    notes.push('p95 is from a log-bucketed histogram (about ±7%). Error % counts 5xx only; 4xx are usually client errors and kept in the mix.');
    $('mix-note').textContent = notes.join(' ');
  }
  $('more-rows').addEventListener('click', () => { state.showAll = !state.showAll; renderMix(); });
  $('merge-go').addEventListener('click', () => {
    const sel = Array.from(document.querySelectorAll('[data-sel]:checked')).map((c) => c.dataset.sel);
    if (sel.length < 2) { showMergeHint('Tick two or more rows to merge.'); return; }
    const rows = state.model.mix.filter((r) => sel.indexOf(r.label) >= 0);
    const name = $('merge-name').value.trim() || rows[0].label + ' (+' + (rows.length - 1) + ')';
    for (const r of rows) for (const mem of r.members) state.merges[mem.label] = name;
    $('merge-name').value = '';
    renderAll();
  });
  $('mix-table').addEventListener('click', (e) => {
    const b = e.target.closest('[data-unmerge]');
    if (!b) return;
    const name = b.dataset.unmerge;
    for (const k of Object.keys(state.merges)) if (state.merges[k] === name) delete state.merges[k];
    renderAll();
  });
  function showMergeHint(t) { $('mix-note').textContent = t; }

  // ------------------------------------------------------------ sessions
  function renderSessions() {
    const s = state.model.sessions, box = $('sess-body');
    if (!s) {
      box.innerHTML = '<p class="sub">Not available: sessions need the client IP (and ideally the user agent) on each line. The load model uses a default think time of 5 s; set your own below.</p>';
      return;
    }
    box.innerHTML = '<p class="sub">Requests from the same IP and user agent, with no gap longer than 30 minutes, are counted as one session. IP and user agent are hashed in memory and never shown or stored. Static assets, bots and health checks are left out.</p>' +
      '<div class="wm-stats">' + [
        stat(nf(s.count), 'sessions'),
        stat(fDur(s.durationMedianS), 'median session length'),
        stat(nf(s.pagesMedian), 'median requests per session'),
        stat(isNaN(s.thinkMedianS) ? '—' : nf(s.thinkMedianS, 1) + ' s', 'median think time')
      ].join('') + '</div>' +
      '<p class="note">Think time is the gap between requests of one session, counting only gaps of 1 second or more (shorter gaps are the browser fetching parts of the same page). Shared IPs (offices, mobile networks) merge people; this is an estimate to sanity-check, not a measurement.' +
      (s.capped ? ' Over 3 million visitors: later visitors were not tracked.' : '') + '</p>';
  }

  // ------------------------------------------------------------ model
  function renderModel() {
    const m = state.model, md = m.model;
    const src = { logs: 'from the logs', you: 'your input', default: 'default, not in the logs' };
    $('model-stats').innerHTML = [
      stat(nf(md.target, 1), 'target req/s', 'hl'),
      stat(nf(Math.ceil(md.usersClosed)), 'concurrent users (with think time)'),
      stat(nf(md.inFlight, 1), 'requests in flight (no think time)'),
      stat(nf(md.preAllocatedVUs), 'k6 VUs to pre-allocate')
    ].join('');
    $('model-formula').innerHTML =
      '<p><b>Target rate</b> = ' + nf(md.base, 2) + ' req/s (' + esc(W.basisName(md.basis)) + ')' + (md.coverage > 1 ? ' × ' + md.coverage + ' servers' : '') +
      ' × ' + nf(md.growth, 2) + ' growth × ' + nf(1 + md.headroom / 100, 2) + ' headroom = <b>' + nf(md.target, 2) + ' req/s</b> (' + nf(md.target * 3600) + ' requests an hour).</p>' +
      '<p><b>Concurrent users</b> = ' + nf(md.target, 2) + ' req/s × (' + nf(md.rtMs / 1000, 3) + ' s response time [' + src[md.rtSource] + '] + ' + nf(md.thinkS, 1) + ' s think time [' + src[md.thinkSource] + ']) = <b>' + nf(md.usersClosed, 1) + '</b>.' +
      ' Use this for a closed model (fixed users with sleeps) or to sanity-check against analytics “active users”.</p>' +
      '<p><b>Requests in flight</b> = ' + nf(md.target, 2) + ' × ' + nf(md.rtMs / 1000, 3) + ' s = ' + nf(md.inFlight, 2) + '. With an arrival-rate test each VU waits only for the response, so k6 needs far fewer VUs than “users”; the script pre-allocates for p95 response times with spare, and maxVUs covers slowdowns.</p>';
  }

  // ------------------------------------------------------------ export
  let lastK6 = '';
  function renderExport() {
    const g = W.generateK6(state.model, settings());
    lastK6 = g.script;
    $('k6-out').value = g.script;
    $('k6-note').textContent = g.scenarios + ' scenarios, ' + nf(g.preAllocatedVUs) + ' VUs pre-allocated (up to ' + nf(g.maxVUs) + '). Run with: k6 run -e BASE_URL=https://your-test-env workload.js';
  }
  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  $('dl-k6').addEventListener('click', () => download('workload.js', lastK6, 'text/javascript'));
  $('copy-k6').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(lastK6); $('copy-k6').textContent = 'Copied'; } catch (e) { $('k6-out').select(); $('copy-k6').textContent = 'Press Ctrl+C'; }
    setTimeout(() => { $('copy-k6').textContent = 'Copy'; }, 1500);
  });
  $('dl-json').addEventListener('click', () => download('workload-mix.json', W.mixToJson(state.model), 'application/json'));
  $('dl-csv').addEventListener('click', () => download('workload-mix.csv', W.mixToCsv(state.model), 'text/csv'));
  $('dl-jmx').addEventListener('click', () => download('jmeter-weights.csv', W.mixToJmeterCsv(state.model), 'text/csv'));

  let rt;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => { if (state.model && !$('result').hidden) { renderTimeline(); renderHourChart(); renderHod(); } }, 150);
  });
})();
