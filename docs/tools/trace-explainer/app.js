/* UI for /tools/trace-explainer/. Logic lives in trace.js (window.TraceExplainer); parsing and analysis run in
   worker.js. Nothing is uploaded: files are read with File.text() inside a Web Worker on this page. */
(function () {
  'use strict';
  const TE = window.TraceExplainer;
  const $ = id => document.getElementById(id);
  const input = $('tr-in'), result = $('result'), errBox = $('err'), progress = $('progress'), pfill = $('pfill'), ptext = $('ptext');
  const fileInput = $('file'), filechip = $('filechip'), fname = $('fname');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const d = us => TE.fmtDur(us);
  const n = x => (x == null ? '—' : Number(x).toLocaleString('en-AU'));
  const pc = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);
  const mb = b => (b / 1048576).toFixed(1) + ' MB';
  const md = s => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
  const PALETTE = ['#2f6fdb', '#12a77a', '#d9822b', '#8e5bd6', '#d64d6c', '#1f9bb8', '#9a8a1c', '#5b6b8c', '#c45ab3', '#4a9c3a', '#b5651d', '#3d8bfd'];
  let files = [], worker = null, session = null, current = null, single = null, colours = {}, sourceName = '';

  // ------------------------------------------------------------------ input
  function setFiles(list) {
    files = Array.from(list || []);
    if (files.length) {
      const size = files.reduce((x, f) => x + f.size, 0);
      fname.textContent = (files.length === 1 ? files[0].name : files.length + ' files') + ' · ' + mb(size);
      filechip.hidden = false; input.value = '';
      input.placeholder = 'Ready: ' + (files.length === 1 ? files[0].name : files.length + ' files') + '. Press Explain, or paste JSON here instead.';
    } else { filechip.hidden = true; input.placeholder = '{"data":[{"traceID":"…","spans":[…],"processes":{…}}]}'; }
  }
  fileInput.addEventListener('change', () => { if (fileInput.files.length) { setFiles(fileInput.files); run(); } });
  $('unfile').addEventListener('click', () => { setFiles([]); fileInput.value = ''; });
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => { const f = e.dataTransfer && e.dataTransfer.files; if (f && f.length) { setFiles(f); run(); } });
  input.addEventListener('input', () => { if (files.length && input.value) setFiles([]); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) run(); });
  $('go').addEventListener('click', run);
  $('clear').addEventListener('click', () => { input.value = ''; setFiles([]); fileInput.value = ''; result.hidden = true; errBox.hidden = true; document.querySelectorAll('[data-sample]').forEach(b => b.removeAttribute('aria-pressed')); });
  $('skew').addEventListener('change', () => { if (!result.hidden) run(); });
  document.querySelectorAll('[data-sample]').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('[data-sample]').forEach(x => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
    const k = b.dataset.sample, S = TE.samples;
    setFiles([]);
    input.value = k === 'jaeger' ? S.sampleJaeger() : k === 'zipkin' ? S.sampleZipkin() : k === 'otlp' ? S.sampleOtlp() : S.sampleMany(150);
    sourceName = b.textContent.trim();
    run();
  }));
  function showProgress(frac, text) {
    progress.hidden = false;
    progress.classList.toggle('indet', frac == null);
    pfill.style.width = frac == null ? '' : Math.round(frac * 100) + '%';
    ptext.textContent = text;
  }

  // ------------------------------------------------------------------ run (Web Worker, with a main-thread fallback)
  let started = 0;
  function run() {
    errBox.hidden = true;
    const text = input.value;
    if (!files.length && !text.trim()) { errBox.textContent = 'Paste trace JSON or choose one or more files first.'; errBox.hidden = false; return; }
    const inputs = files.length ? files.map(f => ({ name: f.name, file: f })) : [{ name: sourceName || 'pasted text', text }];
    if (files.length) sourceName = files.length === 1 ? files[0].name : files.length + ' files';
    else if (!document.querySelector('[data-sample][aria-pressed="true"]')) sourceName = 'pasted text';
    const opts = { adjustSkew: $('skew').checked };
    started = performance.now();
    showProgress(null, 'Reading…');
    try { if (worker) worker.terminate(); worker = new Worker('/tools/trace-explainer/worker.js'); } catch (e) { worker = null; }
    if (!worker) { mainThread(inputs, opts); return; }
    worker.onmessage = e => {
      const m = e.data;
      if (m.type === 'progress') showProgress(m.frac, m.text);
      else if (m.type === 'done') done(m.result);
      else if (m.type === 'trace') showTrace(m.single);
      else if (m.type === 'error') fail(new Error(m.message));
    };
    worker.onerror = () => { worker = null; mainThread(inputs, opts); };
    worker.postMessage({ type: 'load', inputs, opts });
  }
  async function mainThread(inputs, opts) {
    try {
      const texts = [];
      for (const x of inputs) texts.push({ name: x.name, text: x.file ? await x.file.text() : x.text });
      await new Promise(r => setTimeout(r, 0));
      session = TE.createSession();
      done(session.load(texts, opts));
    } catch (e) { fail(e); }
  }
  function requestTrace(id) {
    if (worker) worker.postMessage({ type: 'trace', id });
    else if (session) { try { showTrace(session.trace(id)); } catch (e) { fail(e); } }
  }
  function fail(e) { progress.hidden = true; errBox.textContent = 'Could not read these traces: ' + (e && e.message ? e.message : e); errBox.hidden = false; }

  // ------------------------------------------------------------------ render
  function colour(s) { if (!colours[s]) colours[s] = PALETTE[Object.keys(colours).length % PALETTE.length]; return colours[s]; }
  function done(r) {
    progress.hidden = true;
    current = r; current.took = Math.round(performance.now() - started);
    colours = {};
    (r.many ? r.many.critical.map(c => c.service).concat(r.many.services.map(s => s.service)) : r.single.services.map(s => s.service)).forEach(colour);
    render();
    result.hidden = false;
    result.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function stat(v, l, cls) { return '<div class="ja-stat' + (cls ? ' ' + cls : '') + '"><b>' + v + '</b><span>' + l + '</span></div>'; }
  const dot = s => '<i class="dot" style="background:' + colour(s) + '"></i>';

  function render() {
    const r = current, m = r.many, s = r.single;
    const high = s.findings.filter(f => f.severity === 'high').length;
    let h = '<div class="verdict ' + (m ? (m.outlierCount || high ? 'warn' : 'pass') : (s.errorCount || high ? 'warn' : 'pass')) + '">';
    if (m) h += '<h2>' + n(m.traceCount) + ' traces · p95 ' + esc(d(m.overall.p95)) + '</h2><p>' + m.summary.map(md).join(' ') + '</p>';
    else h += '<h2>' + esc(d(s.total)) + ' end to end' + (s.services[0] ? ' · ' + pc(s.services[0].crit, s.total) + '% in ' + esc(s.services[0].service) : '') + '</h2><p>' + s.summary.map(md).join(' ') + '</p>';
    h += '<p class="fmt">Format: ' + esc(r.formatLabel) + ' · ' + esc(sourceName || 'pasted text') + ' · ' + n(r.spanCount) + ' spans in ' + n(r.traceCount) + ' trace' + (r.traceCount === 1 ? '' : 's') + ' · analysed in ' + (r.took >= 1000 ? (r.took / 1000).toFixed(1) + ' s' : r.took + ' ms') + '</p></div>';
    if (r.warnings.length) h += '<ul class="warnings">' + r.warnings.slice(0, 8).map(w => '<li>' + esc(w) + '</li>').join('') + '</ul>';
    if (m) h += manyHtml(m);
    h += '<div id="single"></div>';
    h += '<div class="block"><div class="block-head"><h3>Export</h3></div><div class="exports">' +
      '<button class="btn btn-ghost btn-small" type="button" id="x-md">Copy Markdown summary</button>' +
      '<button class="btn btn-ghost btn-small" type="button" id="x-mdf">Download Markdown</button><span class="copied" id="copied" aria-live="polite"></span></div>' +
      '<p class="hint">The summary pastes cleanly into Jira, GitHub, Confluence or Slack.</p></div>';
    result.innerHTML = h;
    if (m) wireMany(m);
    $('x-md').addEventListener('click', () => {
      const t = TE.toMarkdown(single, current.many);
      (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => { $('copied').textContent = 'Copied'; setTimeout(() => { $('copied').textContent = ''; }, 2000); }, () => { $('copied').textContent = 'Copy failed: use Download'; });
    });
    $('x-mdf').addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([TE.toMarkdown(single, current.many)], { type: 'text/markdown' }));
      a.download = 'trace-analysis.md'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    showTrace(s, true);
  }

  // ---------------- many traces
  function manyHtml(m) {
    let h = '<div class="ja-stats">' + stat(n(m.traceCount), 'Traces') + stat(esc(d(m.overall.p50)), 'Median') + stat(esc(d(m.overall.p95)), 'p95') + stat(esc(d(m.overall.p99)), 'p99') +
      stat(n(m.outlierCount), 'Outliers', m.outlierCount ? 'warn' : '') + stat(n(m.list.filter(t => t.errors).length), 'Traces with errors', m.list.some(t => t.errors) ? 'bad' : '') + '</div>';
    if (m.endpoints.length) {
      h += '<div class="block"><div class="block-head"><h3>Entry points</h3><span class="hint">The root span of each trace</span></div><div class="tbl-wrap"><table class="data"><thead><tr><th class="l">Endpoint</th><th>Traces</th><th>p50</th><th>p95</th><th>p99</th><th>Max</th><th>With errors</th></tr></thead><tbody>' +
        m.endpoints.map(e => '<tr><td>' + dot(e.service) + esc(e.service) + ' <code>' + esc(e.op) + '</code></td><td>' + n(e.count) + '</td><td>' + esc(d(e.p50)) + '</td><td>' + esc(d(e.p95)) + '</td><td>' + esc(d(e.p99)) + '</td><td>' + esc(d(e.max)) + '</td><td' + (e.errors ? ' class="errs"' : '') + '>' + n(e.errors) + '</td></tr>').join('') + '</tbody></table></div></div>';
    }
    const maxShare = Math.max.apply(null, m.critical.map(c => c.critShare).concat([0.0001]));
    h += '<div class="block"><div class="block-head"><h3>Who is on the critical path</h3></div><p class="hint">The critical path is the chain of spans that decides how long a request takes. A service with a big share is where speed-ups pay off; a service that is busy but rarely on the critical path is running in parallel with something slower.</p>' +
      '<div class="tbl-wrap"><table class="data"><thead><tr><th class="l">Service</th><th>On the path in</th><th>Share of all critical-path time</th><th>Average share per trace</th></tr></thead><tbody>' +
      m.critical.filter(c => c.traces).map(c => '<tr><td>' + dot(c.service) + esc(c.service) + '</td><td>' + c.tracePct + '% of traces</td><td><span class="sharebar"><i style="width:' + Math.round(c.critShare / maxShare * 100) + '%;background:' + colour(c.service) + '"></i></span>' + Math.round(c.critShare * 100) + '%</td><td>' + Math.round(c.meanShare * 100) + '%</td></tr>').join('') + '</tbody></table></div></div>';
    h += '<div class="block"><div class="block-head"><h3>Service latency</h3><span class="hint">Spans where a request enters each service</span></div><div class="tbl-wrap"><table class="data"><thead><tr><th class="l">Service</th><th>Calls</th><th>p50</th><th>p90</th><th>p95</th><th>p99</th><th>Max</th><th>Errors</th></tr></thead><tbody>' +
      m.services.map(v => '<tr><td>' + dot(v.service) + esc(v.service) + '</td><td>' + n(v.count) + '</td><td>' + esc(d(v.p50)) + '</td><td>' + esc(d(v.p90)) + '</td><td>' + esc(d(v.p95)) + '</td><td>' + esc(d(v.p99)) + '</td><td>' + esc(d(v.max)) + '</td><td' + (v.errors ? ' class="errs"' : '') + '>' + n(v.errors) + '</td></tr>').join('') + '</tbody></table></div></div>';
    if (m.dependencies.length) {
      h += '<div class="block"><div class="block-head"><h3>Dependency graph</h3><span class="hint">Caller → callee, with calls and p95</span></div><div class="graph-wrap">' + graph(m.dependencies) + '</div>' +
        '<details class="ex"><summary>As a table</summary><div class="tbl-wrap"><table class="data"><thead><tr><th class="l">Caller → callee</th><th>Calls</th><th>p50</th><th>p95</th><th>p99</th><th>Errors</th></tr></thead><tbody>' +
        m.dependencies.map(e => '<tr><td>' + esc(e.from) + ' → ' + esc(e.to) + '</td><td>' + n(e.count) + '</td><td>' + esc(d(e.p50)) + '</td><td>' + esc(d(e.p95)) + '</td><td>' + esc(d(e.p99)) + '</td><td' + (e.errors ? ' class="errs"' : '') + '>' + n(e.errors) + '</td></tr>').join('') + '</tbody></table></div></details></div>';
    }
    h += '<div class="block"><div class="block-head"><h3>Operations</h3><span class="hint">Sorted by p95 × calls (where the time adds up)</span></div><div class="tbl-wrap"><table class="data"><thead><tr><th class="l">Operation</th><th>Calls</th><th>p50</th><th>p95</th><th>p99</th><th>Mean self time</th><th>Errors</th></tr></thead><tbody id="ops-body">' +
      opsRows(m.operations.slice(0, 25)) + '</tbody></table></div>' + (m.operations.length > 25 ? '<p><button type="button" class="btn btn-ghost btn-small" id="ops-more">Show all ' + m.operations.length + '</button></p>' : '') + '</div>';
    if (m.outliers.length) {
      h += '<div class="block"><div class="block-head"><h3>Outlier traces</h3><span class="hint">Much slower than typical for the same entry point (median + 3 × MAD, and at least 1.5 × the median)</span></div><div class="tbl-wrap"><table class="data"><thead><tr><th class="l">Why it was slow</th><th>Duration</th><th>Typical</th><th>× typical</th><th></th></tr></thead><tbody>' +
        m.outliers.slice(0, 20).map(o => '<tr><td>' + esc(o.why) + '<br><span class="hint">' + esc(o.endpoint) + ' · <code>' + esc(o.id.slice(0, 16)) + '</code></span></td><td class="slow">' + esc(d(o.total)) + '</td><td>' + esc(d(o.typical)) + '</td><td>' + o.ratio.toFixed(1) + '×</td><td><button type="button" class="btn btn-ghost btn-small" data-open="' + esc(o.id) + '">Open</button></td></tr>').join('') + '</tbody></table></div></div>';
    }
    h += '<div class="block"><div class="block-head"><h3><label for="pick">Look at one trace</label></h3></div><div class="explore"><select id="pick" class="pick">' +
      m.list.slice(0, 2000).map(t => '<option value="' + esc(t.id) + '">' + esc(d(t.total)) + ' · ' + esc(t.root.service + ' ' + t.root.op).slice(0, 60) + (t.errors ? ' · ' + t.errors + ' errors' : '') + (t.outlier ? ' · outlier' : '') + ' · ' + esc(t.id.slice(0, 8)) + '</option>').join('') +
      '</select></div><p class="hint">Sorted slowest first' + (m.list.length > 2000 ? '; the 2,000 slowest are listed' : '') + '. The slowest trace is shown below.</p></div>';
    return h;
  }
  function opsRows(list) {
    return list.map(o => '<tr><td>' + dot(o.service) + esc(o.service) + ' <code>' + esc(o.op.slice(0, 120)) + '</code></td><td>' + n(o.count) + '</td><td>' + esc(d(o.p50)) + '</td><td>' + esc(d(o.p95)) + '</td><td>' + esc(d(o.p99)) + '</td><td>' + esc(d(o.selfMean)) + '</td><td' + (o.errors ? ' class="errs"' : '') + '>' + n(o.errors) + '</td></tr>').join('');
  }
  function wireMany(m) {
    const more = $('ops-more');
    if (more) more.addEventListener('click', () => { $('ops-body').innerHTML = opsRows(m.operations); more.remove(); });
    $('pick').addEventListener('change', e => requestTrace(e.target.value));
    result.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => { $('pick').value = b.dataset.open; requestTrace(b.dataset.open); }));
  }
  function graph(deps) {
    const svcs = {}; deps.forEach(e => { svcs[e.from] = 1; svcs[e.to] = 1; });
    const names = Object.keys(svcs);
    const callee = {}; deps.forEach(e => { callee[e.to] = 1; });
    const depth = {}; const q = names.filter(s => !callee[s]);
    if (!q.length) q.push(names[0]);
    q.forEach(s => { depth[s] = 0; });
    for (let k = 0; k < q.length; k++) deps.filter(e => e.from === q[k] && depth[e.to] == null).forEach(e => { depth[e.to] = depth[q[k]] + 1; q.push(e.to); });
    names.forEach(s => { if (depth[s] == null) depth[s] = 0; });
    const cols = {}; names.forEach(s => { (cols[depth[s]] = cols[depth[s]] || []).push(s); });
    const CW = 230, RH = 64, NW = 170, NH = 40;
    const pos = {};
    let maxRows = 0;
    Object.keys(cols).forEach(c => { cols[c].sort().forEach((s, i) => { pos[s] = { x: 10 + c * CW, y: 30 + i * RH }; }); maxRows = Math.max(maxRows, cols[c].length); });
    const W = 10 + Object.keys(cols).length * CW, H = 40 + maxRows * RH;
    let g = '<svg class="dep" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Service dependency graph"><defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="arrhead"/></marker></defs>';
    deps.forEach(e => {
      const a = pos[e.from], b = pos[e.to];
      const x1 = a.x + NW, y1 = a.y + NH / 2, x2 = b.x, y2 = b.y + NH / 2;
      const back = x2 <= x1;
      const path = back ? 'M' + (a.x + NW / 2) + ' ' + (a.y + NH) + ' C' + (a.x + NW / 2) + ' ' + (a.y + NH + 40) + ' ' + (b.x + NW / 2) + ' ' + (b.y + NH + 40) + ' ' + (b.x + NW / 2) + ' ' + (b.y + NH)
        : 'M' + x1 + ' ' + y1 + ' C' + (x1 + 30) + ' ' + y1 + ' ' + (x2 - 30) + ' ' + y2 + ' ' + x2 + ' ' + y2;
      g += '<path d="' + path + '" class="edge' + (e.errors ? ' err' : '') + '" marker-end="url(#arr)"><title>' + esc(e.from + ' → ' + e.to + ': ' + e.count + ' calls, p95 ' + d(e.p95) + (e.errors ? ', ' + e.errors + ' errors' : '')) + '</title></path>';
      if (!back) g += '<text x="' + (x2 - 6) + '" y="' + (y2 - 6) + '" text-anchor="end" class="elab">' + esc(n(e.count) + '× · ' + d(e.p95)) + '</text>';
    });
    names.forEach(s => {
      const p = pos[s];
      g += '<g><rect x="' + p.x + '" y="' + p.y + '" width="' + NW + '" height="' + NH + '" rx="8" class="node" style="stroke:' + colour(s) + '"/><rect x="' + p.x + '" y="' + p.y + '" width="5" height="' + NH + '" rx="2" style="fill:' + colour(s) + '"/>' +
        '<text x="' + (p.x + 14) + '" y="' + (p.y + 25) + '" class="nlab">' + esc(s.length > 22 ? s.slice(0, 21) + '…' : s) + '</text><title>' + esc(s) + '</title></g>';
    });
    return g + '</svg>';
  }

  // ---------------- one trace
  function showTrace(s, initial) {
    single = s;
    s.services.forEach(v => colour(v.service));
    const box = $('single');
    if (!box) return;
    const many = current && current.many;
    let h = '<div class="block"><div class="block-head"><h3>' + (many ? 'Trace ' : 'Trace ') + '<code>' + esc((s.traceId || '').slice(0, 32)) + '</code></h3><span class="hint">' + esc(s.root.service + ' ' + s.root.op) + '</span></div>';
    if (many) h += '<div class="verdict ' + (s.errorCount || s.findings.some(f => f.severity === 'high') ? 'warn' : 'pass') + '"><p>' + s.summary.map(md).join(' ') + '</p></div>';
    h += '<div class="ja-stats">' + stat(esc(d(s.total)), 'End to end') + stat(n(s.spanCount), 'Spans') + stat(n(s.serviceCount), 'Services') + stat(n(s.errorCount), 'Error spans', s.errorCount ? 'bad' : '') +
      stat(n(s.findings.filter(f => f.severity !== 'low').length), 'Things to fix', s.findings.some(f => f.severity === 'high') ? 'warn' : '') + '</div></div>';
    if (s.warnings.length) h += '<ul class="warnings">' + s.warnings.map(w => '<li>' + esc(w) + '</li>').join('') + '</ul>';
    if (s.findings.length) {
      h += '<div class="block"><div class="block-head"><h3>Findings and fixes</h3><span class="hint">Most important first. Show highlights the spans in the waterfall.</span></div>' +
        s.findings.map((f, k) => '<div class="card-x ' + (f.severity === 'high' ? '' : f.severity === 'medium' ? 'warn' : 'info') + '"><h4>' + md(f.title) + '</h4><p>' + md(f.text) + '</p><p class="fix"><b>Fix:</b> ' + md(f.fix) + '</p>' +
          (f.spans && f.spans.length ? '<button type="button" class="linkbtn" data-hl="' + k + '">Show ' + (f.spans.length === 1 ? 'the span' : f.spans.length + ' spans') + ' in the waterfall</button>' : '') + '</div>').join('') + '</div>';
    }
    // waterfall
    h += '<div class="block" id="wf-block"><div class="block-head"><h3>Waterfall</h3><div class="ja-chart-tools"><label><input type="checkbox" id="cp-only"> Critical path only</label><button type="button" class="linkbtn" id="hl-clear" hidden>Clear highlight</button></div></div>' +
      '<p class="wf-legend">' + s.services.map(v => '<span>' + dot(v.service) + esc(v.service) + '</span>').join('') + '<span><i class="cpkey"></i>Critical path</span><span><i class="errkey"></i>Error</span></p>' +
      '<div class="wf" id="wf"></div><p class="hint">Click a row for its attributes, self time and critical-path time. Times are relative to the start of the trace' + (s.skews.length ? '; spans marked ⇄ were moved to correct clock skew' : '') + '.</p></div>';
    // per service
    h += '<div class="block"><div class="block-head"><h3>Time by service</h3></div><div class="tbl-wrap"><table class="data"><thead><tr><th class="l">Service</th><th>On critical path</th><th>Self time</th><th>Busy time</th><th>Spans</th><th>Errors</th></tr></thead><tbody>' +
      s.services.map(v => '<tr><td>' + dot(v.service) + esc(v.service) + '</td><td><span class="sharebar"><i style="width:' + pc(v.crit, s.total) + '%;background:' + colour(v.service) + '"></i></span>' + esc(d(v.crit)) + ' (' + pc(v.crit, s.total) + '%)</td><td>' + esc(d(v.self)) + '</td><td>' + esc(d(v.dur)) + '</td><td>' + n(v.spans) + '</td><td' + (v.errors ? ' class="errs"' : '') + '>' + n(v.errors) + '</td></tr>').join('') +
      '</tbody></table></div><p class="hint">Self time is time in a span not covered by its children. Busy time is how long the service had at least one span open. Self time can add up to more than the trace when work runs in parallel; critical-path time never does.</p></div>';
    h += '<div class="block"><div class="block-head"><h3>Slowest operations</h3><span class="hint">By self time</span></div><div class="tbl-wrap"><table class="data"><thead><tr><th class="l">Operation</th><th>Count</th><th>Self time</th><th>Total</th><th>Longest</th><th>On critical path</th></tr></thead><tbody>' +
      s.operations.slice(0, 15).map(o => '<tr><td>' + dot(o.service) + esc(o.service) + ' <code>' + esc(o.op.slice(0, 120)) + '</code></td><td>' + n(o.count) + '</td><td>' + esc(d(o.self)) + '</td><td>' + esc(d(o.total)) + '</td><td>' + esc(d(o.max)) + '</td><td>' + esc(d(o.crit)) + '</td></tr>').join('') + '</tbody></table></div></div>';
    box.innerHTML = h;
    wf.limit = 1500; wf.hl = null; wf.cpOnly = false;
    drawWaterfall();
    $('cp-only').addEventListener('change', e => { wf.cpOnly = e.target.checked; drawWaterfall(); });
    $('hl-clear').addEventListener('click', () => { wf.hl = null; $('hl-clear').hidden = true; drawWaterfall(); });
    box.querySelectorAll('[data-hl]').forEach(b => b.addEventListener('click', () => {
      const f = s.findings[+b.dataset.hl];
      wf.hl = new Set(f.spans); wf.gap = f.gap || null; $('hl-clear').hidden = false;
      if (f.spans.length && !wf.cpOnly) { const idx = s.spans.findIndex(x => wf.hl.has(x.i)); if (idx >= wf.limit) wf.limit = idx + 200; }
      drawWaterfall();
      const first = $('wf').querySelector('.wf-row.is-hl');
      (first || $('wf-block')).scrollIntoView({ behavior: 'smooth', block: 'center' });
    }));
    if (!initial) box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  const wf = { limit: 1500, hl: null, cpOnly: false, gap: null, open: null };
  function drawWaterfall() {
    const s = single, T = s.total || 1;
    const critBy = {}; s.critical.forEach(g => { (critBy[g.i] = critBy[g.i] || []).push(g); });
    let rows = s.spans;
    if (wf.cpOnly) rows = rows.filter(x => x.crit > 0);
    const shown = rows.slice(0, wf.limit);
    const L = x => (x / T * 100).toFixed(3) + '%';
    let h = '<div class="wf-row wf-axis" aria-hidden="true"><div class="wf-label"></div><div class="wf-track">' + [0, 0.25, 0.5, 0.75, 1].map(f => '<span style="left:' + f * 100 + '%">' + (f ? esc(d(T * f)) : '0') + '</span>').join('') + '</div></div>';
    shown.forEach(x => {
      const segs = (critBy[x.i] || []).map(g => '<span class="wf-cp" style="left:' + L(g.a) + ';width:' + L(Math.max(g.b - g.a, T / 2000)) + '"></span>').join('');
      const gap = wf.gap && wf.hl && wf.hl.has(x.i) ? '<span class="wf-gap" style="left:' + L(wf.gap[0]) + ';width:' + L(wf.gap[1] - wf.gap[0]) + '"></span>' : '';
      const left = x.start / T * 100, width = Math.max(x.dur / T * 100, 0.15);
      const labelRight = left + width > 70;
      h += '<div class="wf-row' + (x.error ? ' is-err' : '') + (wf.hl && wf.hl.has(x.i) ? ' is-hl' : '') + (wf.hl && !wf.hl.has(x.i) ? ' dim' : '') + '" data-i="' + x.i + '" tabindex="0" role="button" aria-expanded="' + (wf.open === x.i) + '">' +
        '<div class="wf-label" style="padding-left:' + (Math.min(x.depth, 14) * 10 + 4) + 'px" title="' + esc(x.service + ' · ' + x.op) + '">' + dot(x.service) + '<span class="op">' + esc(x.op) + '</span><span class="svc">' + esc(x.service) + '</span></div>' +
        '<div class="wf-track">' + gap + '<span class="wf-bar" style="left:' + left.toFixed(3) + '%;width:' + width.toFixed(3) + '%;background:' + colour(x.service) + '"></span>' + segs +
        '<span class="wf-dur" style="' + (labelRight ? 'right:' + (100 - left).toFixed(3) + '%;margin-right:4px' : 'left:' + (left + width).toFixed(3) + '%;margin-left:4px') + '">' + (x.error ? '⚠ ' : '') + (x.skew ? '⇄ ' : '') + esc(d(x.dur)) + '</span></div></div>';
      if (wf.open === x.i) h += detailHtml(x);
    });
    if (rows.length > shown.length) h += '<p><button type="button" class="btn btn-ghost btn-small" id="wf-more">Show all ' + n(rows.length) + ' spans</button></p>';
    const box = $('wf');
    box.innerHTML = h;
    box.querySelectorAll('.wf-row[data-i]').forEach(r => {
      const toggle = () => { const i = +r.dataset.i; wf.open = wf.open === i ? null : i; drawWaterfall(); };
      r.addEventListener('click', toggle);
      r.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    });
    const more = $('wf-more');
    if (more) more.addEventListener('click', () => { wf.limit = Infinity; drawWaterfall(); });
  }
  function detailHtml(x) {
    const s = single;
    const parent = x.p >= 0 ? s.spans.find(y => y.i === x.p) : null;
    const attrs = Object.keys(x.attrs);
    return '<div class="wf-detail"><dl>' +
      '<dt>Service</dt><dd>' + esc(x.service) + (x.kind ? ' (' + esc(x.kind) + ')' : '') + '</dd><dt>Operation</dt><dd><code>' + esc(x.op) + '</code></dd>' +
      '<dt>Starts at</dt><dd>' + esc(d(x.start)) + '</dd><dt>Duration</dt><dd>' + esc(d(x.dur)) + '</dd>' +
      '<dt>Self time</dt><dd>' + esc(d(x.self)) + ' (' + pc(x.self, x.dur) + '% of the span)</dd><dt>On critical path</dt><dd>' + esc(d(x.crit)) + '</dd>' +
      (parent ? '<dt>Called by</dt><dd>' + esc(parent.service) + ' <code>' + esc(parent.op) + '</code>' + (x.follows ? ' (follows from)' : '') + '</dd>' : '') +
      (x.skew ? '<dt>Clock skew</dt><dd>Moved ' + esc(d(Math.abs(x.skew))) + (x.skew > 0 ? ' later' : ' earlier') + '</dd>' : '') +
      (x.error ? '<dt>Error</dt><dd class="errtxt">' + esc((x.status ? 'HTTP ' + x.status + ' · ' : '') + (x.msg || 'marked as an error')) + '</dd>' : '') +
      '<dt>Span id</dt><dd><code>' + esc(x.id) + '</code></dd></dl>' +
      (attrs.length ? '<details class="ex"><summary>' + attrs.length + ' attributes</summary><dl class="attrs">' + attrs.map(k => '<dt>' + esc(k) + '</dt><dd><code>' + esc(x.attrs[k]) + '</code></dd>').join('') + '</dl></details>' : '') +
      (x.events.length ? '<details class="ex"><summary>' + x.events.length + ' events / logs</summary><ul>' + x.events.map(e => '<li>' + esc(e.name) + '</li>').join('') + '</ul></details>' : '') + '</div>';
  }
})();
