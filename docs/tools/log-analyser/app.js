/* UI for /tools/log-analyser/. Logic lives in logs.js (window.LogAnalyser); files are analysed in worker.js.
   Nothing is uploaded: files are read with File.slice() in a Web Worker on this page. */
(function () {
  'use strict';
  const LA = window.LogAnalyser;
  const $ = id => document.getElementById(id);
  const input = $('log-in'), result = $('result'), errBox = $('err'), progress = $('progress'), pfill = $('pfill'), ptext = $('ptext');
  const fileInput = $('file'), filechip = $('filechip'), fname = $('fname');
  let file = null, current = null, worker = null, sourceName = '';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const n = x => (x == null ? '—' : Number(x).toLocaleString('en-AU'));
  const ms = x => (x == null ? '—' : x >= 1000 ? (x / 1000).toFixed(2) + ' s' : Math.round(x) + ' ms');
  const mb = b => (b / 1048576).toFixed(1) + ' MB';

  // ------------------------------------------------------------------ samples
  function pad(x) { return String(x).padStart(2, '0'); }
  function stamp(t, sep) { const d = new Date(t); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + (sep || ' ') + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) + ',' + String(d.getUTCMilliseconds()).padStart(3, '0'); }
  function javaSample() {
    const t0 = Date.UTC(2026, 10, 8, 9, 0, 0);
    const L = [];
    let seed = 7;
    const r = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let s = 0; s < 60 * 60; s += 4) {
      const t = t0 + s * 1000 + Math.floor(r() * 900);
      const th = 'http-nio-8080-exec-' + (1 + Math.floor(r() * 20));
      const id = 10000 + Math.floor(r() * 90000);
      L.push(stamp(t) + ' INFO  [' + th + '] c.a.web.OrderController - GET /api/orders/' + id + ' 200 in ' + Math.floor(40 + r() * 80) + 'ms');
      if (s > 2400 && s < 2580) {
        if (s === 2404) L.push(stamp(t + 1) + ' WARN  [HikariPool-1 housekeeper] com.zaxxer.hikari.pool.HikariPool - HikariPool-1 - Thread starvation or clock leap detected (housekeeper delta=1m2s).');
        if (s === 2408) L.push(stamp(t + 2) + ' ERROR [' + th + '] c.a.db.OrderRepository - Database query failed for order ' + id + '\norg.springframework.dao.DataAccessResourceFailureException: Unable to acquire JDBC Connection\n\tat org.springframework.orm.jpa.vendor.HibernateJpaDialect.convertHibernateAccessException(HibernateJpaDialect.java:275)\n\tat com.acme.db.OrderRepository.findById(OrderRepository.java:52)\nCaused by: java.sql.SQLTransientConnectionException: HikariPool-1 - Connection is not available, request timed out after 30000ms.\n\tat com.zaxxer.hikari.pool.HikariPool.createTimeoutException(HikariPool.java:696)\n\t... 48 common frames omitted');
        for (let k = 0; k < 3; k++) L.push(stamp(t + 10 + k) + ' ERROR [' + th + '] c.a.web.OrderController - Request failed: GET /api/orders/' + (id + k) + ' for user ' + (['amy', 'bob', 'kai', 'mia'][k % 4]) + '@example.com after 30012ms\norg.springframework.transaction.CannotCreateTransactionException: Could not open JPA EntityManager for transaction\n\tat com.acme.web.OrderController.get(OrderController.java:31)');
      }
      if (s % 600 === 0) L.push(stamp(t + 3) + ' WARN  [scheduling-1] c.a.jobs.PriceSync - Price feed slow: took ' + Math.floor(2000 + r() * 1000) + 'ms (limit 2000ms)');
      if (s % 900 === 452) L.push(stamp(t + 5) + ' ERROR [' + th + '] c.a.pay.PaymentClient - Payment declined for order ' + id + ': card_declined (code 402)');
    }
    return L.join('\n');
  }
  function accessSample() {
    const t0 = Date.UTC(2026, 10, 8, 9, 0, 0);
    const MON = 'Nov';
    const L = [];
    let seed = 3;
    const r = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const ips = ['203.0.113.9', '198.51.100.24', '192.0.2.77', '203.0.113.150', '198.51.100.3'];
    const uas = ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) Safari/604.1', 'k6/0.54.0 (https://k6.io/)', 'curl/8.7.1', 'Googlebot/2.1 (+http://www.google.com/bot.html)'];
    const eps = [['GET', '/', 0.02], ['GET', '/api/products?page=2', 0.08], ['GET', '/api/products/{n}', 0.06], ['POST', '/api/cart', 0.12], ['POST', '/api/checkout', 0.45], ['GET', '/api/orders/{n}', 0.09], ['GET', '/static/app.js', 0.004]];
    for (let s = 0; s < 1800; s++) {
      const t = new Date(t0 + s * 1000);
      const stampA = pad(t.getUTCDate()) + '/' + MON + '/' + t.getUTCFullYear() + ':' + pad(t.getUTCHours()) + ':' + pad(t.getUTCMinutes()) + ':' + pad(t.getUTCSeconds()) + ' +1100';
      for (let k = 0; k < 3; k++) {
        const e = eps[Math.floor(r() * eps.length)];
        const path = e[1].replace('{n}', String(100 + Math.floor(r() * 900)));
        const slow = s > 1200 && s < 1260 && e[1] === '/api/checkout';
        let st = r() < 0.01 ? 404 : 200;
        if (e[0] === 'POST' && e[1] === '/api/cart') st = 201;
        if (slow && r() < 0.6) st = 504;
        const rt = (slow ? 8 + r() * 4 : e[2] * (0.5 + r() * 1.5)).toFixed(3);
        L.push(ips[Math.floor(r() * ips.length)] + ' - - [' + stampA + '] "' + e[0] + ' ' + path + ' HTTP/1.1" ' + st + ' ' + Math.floor(200 + r() * 5000) + ' "-" "' + uas[Math.floor(r() * uas.length)] + '" ' + rt);
      }
    }
    return L.join('\n');
  }
  function jsonSample() {
    const t0 = Date.UTC(2026, 10, 8, 9, 0, 0);
    const L = [];
    for (let s = 0; s < 1200; s += 2) {
      const time = new Date(t0 + s * 1000).toISOString();
      L.push(JSON.stringify({ level: 30, time, pid: 4211, hostname: 'api-7d9c6b5f4-x2x9z', reqId: 'req-' + s, msg: 'request completed', req: { method: 'GET', url: '/v1/quotes/' + (s * 7 % 900) }, res: { statusCode: 200 }, responseTime: 20 + (s * 13 % 70) }));
      if (s % 300 === 100) L.push(JSON.stringify({ level: 40, time, msg: 'rate limit close for tenant ' + (s % 7) + ': 92% of quota used' }));
      if (s >= 700 && s < 760) L.push(JSON.stringify({ level: 50, time, msg: 'upstream pricing service failed', err: { type: 'FetchError', message: 'request to http://pricing.internal:8080/v2/price?sku=' + (s * 11) + ' failed, reason: connect ECONNREFUSED 10.0.4.17:8080', stack: 'FetchError: request to http://pricing.internal:8080/v2/price failed, reason: connect ECONNREFUSED 10.0.4.17:8080\n    at ClientRequest.<anonymous> (/app/node_modules/node-fetch/lib/index.js:1505:11)\n    at PricingClient.price (/app/src/pricing.js:41:17)' } }));
      if (s === 1100) L.push(JSON.stringify({ level: 60, time, msg: 'unhandled rejection, shutting down', err: { type: 'TypeError', message: "Cannot read properties of undefined (reading 'total')", stack: "TypeError: Cannot read properties of undefined (reading 'total')\n    at quoteTotal (/app/src/quote.js:88:21)" } }));
    }
    return L.join('\n');
  }
  async function bigSample() {
    // ~50 MB Log4j-style log with one incident, built in pieces so the page stays responsive
    const parts = [];
    let size = 0, i = 0;
    const t0 = Date.UTC(2026, 10, 8, 0, 0, 0);
    while (size < 50 * 1024 * 1024) {
      const lines = [];
      for (let k = 0; k < 20000; k++, i++) {
        const ts = stamp(t0 + i * 40);
        let l;
        const spike = i > 400000 && i < 405000;
        if ((spike && i % 4 === 0) || i % 997 === 0) l = ts + ' ERROR [exec-' + (i % 40) + '] com.acme.OrderService - Payment failed for order ' + i + ' user u' + (i % 5000) + '@example.com\njava.lang.IllegalStateException: Gateway returned 502\n\tat com.acme.PaymentClient.charge(PaymentClient.java:88)\n\tat com.acme.OrderService.place(OrderService.java:41)';
        else if (i % 131 === 0) l = ts + ' WARN  [exec-' + (i % 40) + '] com.acme.Pool - Pool at ' + (i % 100) + '% (' + (i % 20) + '/20)';
        else l = ts + ' INFO  [exec-' + (i % 40) + '] com.acme.Api - GET /api/orders/' + i + ' 200 in ' + (i % 300) + 'ms';
        lines.push(l);
      }
      const chunk = lines.join('\n') + '\n';
      parts.push(chunk); size += chunk.length;
      if (parts.length % 10 === 0) { ptext.textContent = 'Generating a 50 MB test log… ' + mb(size); await new Promise(r => setTimeout(r, 0)); }
    }
    return new File(parts, 'generated-50mb.log', { type: 'text/plain' });
  }

  // ------------------------------------------------------------------ input handling
  function setFile(f) {
    file = f;
    if (f) { fname.textContent = f.name + ' · ' + mb(f.size); filechip.hidden = false; input.value = ''; input.placeholder = 'File ready: ' + f.name + '. Press Analyse, or paste text here instead.'; }
    else { filechip.hidden = true; input.placeholder = ''; }
  }
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) { setFile(fileInput.files[0]); run(); } });
  $('unfile').addEventListener('click', () => { setFile(null); fileInput.value = ''; });
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => { const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) { setFile(f); run(); } });
  input.addEventListener('input', () => { if (file && input.value) setFile(null); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) run(); });
  $('go').addEventListener('click', run);
  $('clear').addEventListener('click', () => { input.value = ''; setFile(null); fileInput.value = ''; result.hidden = true; errBox.hidden = true; document.querySelectorAll('[data-sample]').forEach(b => b.removeAttribute('aria-pressed')); });
  document.querySelectorAll('[data-sample]').forEach(b => b.addEventListener('click', async () => {
    document.querySelectorAll('[data-sample]').forEach(x => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
    $('fmt').value = 'auto';
    const k = b.dataset.sample;
    if (k === 'big') {
      showProgress(0, 'Generating a 50 MB test log…');
      setFile(await bigSample());
    } else {
      setFile(null);
      input.value = k === 'java' ? javaSample() : k === 'access' ? accessSample() : jsonSample();
      sourceName = b.textContent.trim();
    }
    run();
  }));

  function showProgress(frac, text) {
    progress.hidden = false;
    progress.classList.toggle('indet', frac == null);
    pfill.style.width = frac == null ? '' : Math.round(frac * 100) + '%';
    ptext.textContent = text;
  }

  // ------------------------------------------------------------------ run
  let started = 0;
  function run() {
    errBox.hidden = true;
    const opts = { format: $('fmt').value };
    const text = input.value;
    if (!file && !text.trim()) { errBox.textContent = 'Paste a log or choose a file first.'; errBox.hidden = false; return; }
    if (file) sourceName = file.name;
    started = performance.now();
    const size = file ? file.size : text.length;
    if (!file && size < 1.5e6) {
      // small pasted logs: analyse straight away
      try { done(LA.analyseText(text, opts)); } catch (e) { fail(e); }
      return;
    }
    showProgress(0, 'Reading ' + mb(size) + '…');
    try {
      if (worker) worker.terminate();
      worker = new Worker('/tools/log-analyser/worker.js');
    } catch (e) { worker = null; }
    if (!worker) { mainThread(opts, text); return; }
    worker.onmessage = e => {
      const m = e.data;
      if (m.type === 'progress') showProgress(m.done / m.total, 'Analysed ' + mb(m.done) + ' of ' + mb(m.total) + ' · ' + n(m.lines) + ' lines');
      else if (m.type === 'done') { worker.terminate(); worker = null; done(m.result); }
      else if (m.type === 'error') { worker.terminate(); worker = null; fail(new Error(m.message)); }
    };
    worker.onerror = () => { worker = null; mainThread(opts, text); };
    worker.postMessage(file ? { file, opts } : { text, opts });
  }
  // Fallback when Web Workers are unavailable: chunked on the main thread, yielding between chunks.
  async function mainThread(opts, text) {
    const a = LA.createAnalyser(opts);
    const CH = 2 * 1024 * 1024;
    try {
      if (file) {
        const dec = new TextDecoder();
        for (let off = 0; off < file.size; off += CH) {
          a.push(dec.decode(await file.slice(off, off + CH).arrayBuffer(), { stream: off + CH < file.size }));
          showProgress(Math.min(1, (off + CH) / file.size), 'Analysed ' + mb(Math.min(file.size, off + CH)) + ' of ' + mb(file.size));
          await new Promise(r => setTimeout(r, 0));
        }
      } else {
        for (let i = 0; i < text.length; i += CH) { a.push(text.slice(i, i + CH)); showProgress(Math.min(1, (i + CH) / text.length), 'Analysing…'); await new Promise(r => setTimeout(r, 0)); }
      }
      done(a.end());
    } catch (e) { fail(e); }
  }
  function fail(e) { progress.hidden = true; errBox.textContent = 'Could not analyse this log: ' + (e && e.message ? e.message : e); errBox.hidden = false; }

  // ------------------------------------------------------------------ render
  const view = { q: '', regex: false, levels: ['FATAL', 'ERROR', 'WARN'], from: null, to: null, sel: -1 };
  function done(r) {
    progress.hidden = true;
    current = r;
    current.took = Math.round(performance.now() - started);
    view.q = ''; view.regex = false; view.from = null; view.to = null; view.sel = -1;
    render();
    result.hidden = false;
    result.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function render() {
    const r = current;
    const lv = r.levels;
    const cls = r.levels.FATAL || r.errors ? 'fail' : r.warnings ? 'warn' : 'pass';
    const spikes = r.timeline ? r.timeline.spikes : [];
    let headline;
    if (!r.entries) headline = 'No log entries found';
    else if (r.errors) headline = n(r.errors) + ' error' + (r.errors === 1 ? '' : 's') + ' in ' + n(r.groupCount) + ' distinct message' + (r.groupCount === 1 ? '' : 's') + (spikes.length ? ', ' + spikes.length + ' spike' + (spikes.length === 1 ? '' : 's') : '');
    else if (r.warnings) headline = 'No errors, ' + n(r.warnings) + ' warning' + (r.warnings === 1 ? '' : 's');
    else headline = 'No errors or warnings';
    let h = '<div class="verdict ' + cls + '"><h2>' + esc(headline) + '</h2>';
    h += '<p>' + (r.firstTs != null ? 'From ' + esc(LA.fmtTime(r.firstTs)) + ' to ' + esc(LA.fmtTime(r.lastTs)) + '. ' : '') + n(r.lines) + ' lines, ' + n(r.entries) + ' entries.</p>';
    h += '<p class="fmt">Format: ' + esc(r.formatLabel) + ' · ' + esc(sourceName || 'pasted text') + ' · ' + mb(r.bytes) + ' analysed in ' + (r.took >= 1000 ? (r.took / 1000).toFixed(1) + ' s' : r.took + ' ms') + (r.unparsed ? ' · ' + n(r.unparsed) + ' lines did not match the format' : '') + '</p></div>';
    h += '<div class="ja-stats">' + ['FATAL', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE', 'NONE'].filter(l => lv[l] || l === 'ERROR' || l === 'WARN' || l === 'INFO')
      .map(l => '<div class="ja-stat ' + l.toLowerCase() + '"><b>' + n(lv[l]) + '</b><span>' + (l === 'NONE' ? 'No level' : l.charAt(0) + l.slice(1).toLowerCase()) + '</span></div>').join('') + '</div>';

    if (r.firstError) {
      const f = r.firstError;
      h += '<div class="card-x"><h4>First error · line ' + n(f.line) + (f.ts != null ? ' · ' + esc(LA.fmtTime(f.ts)) : '') + '</h4><p><code>' + esc(f.msg.slice(0, 400)) + '</code></p>' +
        (f.stack && f.stack.length ? '<details class="ex"><summary>Stack trace</summary><pre class="stack">' + esc(f.stack.join('\n')) + '</pre></details>' : '') + '</div>';
    }
    if (spikes.length) {
      h += '<div class="card-x warn"><h4>Error spike' + (spikes.length > 1 ? 's' : '') + ' (more than ' + r.timeline.threshold + ' errors per ' + bucketLabel(r.timeline.bucketMinutes) + ')</h4>' +
        spikes.slice(0, 6).map(s => '<p><b>' + esc(LA.fmtTime(s.t, false)) + '</b>: ' + n(s.errors) + ' errors' + (s.ratio ? ' (' + s.ratio + '× normal)' : '') + (s.first ? '. First: <code>' + esc(s.first.msg.slice(0, 200)) + '</code> (line ' + n(s.first.line) + ')' : '') + '</p>').join('') + '</div>';
    }

    if (r.timeline && r.timeline.buckets.length > 1) {
      h += '<div class="block"><div class="block-head"><h3>Errors over time</h3></div>' +
        '<p class="legend"><span><i style="background:color-mix(in srgb,var(--bad) 55%,transparent)"></i>Errors per ' + bucketLabel(r.timeline.bucketMinutes) + '</span><span><i style="background:var(--bad)"></i>Spike</span><span><i style="background:color-mix(in srgb,var(--warn) 45%,transparent)"></i>Warnings</span><span>- - - mean + 3σ</span></p>' +
        '<div class="chart-box">' + chart(r.timeline) + '</div><p class="hint">Click a bar to list the errors and warnings in that ' + bucketLabel(r.timeline.bucketMinutes) + ' below.</p></div>';
    }

    if (r.groups.length) {
      h += '<div class="block"><div class="block-head"><h3>Errors grouped by message</h3><span class="hint">' + n(r.groupCount) + ' templates' + (r.groupCount > 200 ? ', top 200 shown' : '') + '</span></div>' +
        '<div class="tbl-wrap"><table class="data"><thead><tr><th class="l">Message template</th><th>Count</th><th>Level</th><th>First seen</th><th>Last seen</th></tr></thead><tbody>' +
        r.groups.slice(0, 200).map(g => '<tr><td class="msg"><code>' + esc(g.template.slice(0, 300)) + '</code><details class="ex"><summary>Example (line ' + n(g.firstLine) + ')</summary><pre class="stack">' + esc(g.example) + '</pre>' +
          (Object.keys(g.loggers).length ? '<span class="hint">Logger: ' + esc(Object.keys(g.loggers).join(', ')) + '</span>' : '') + '</details></td><td>' + n(g.count) + '</td><td>' + esc(g.level) + '</td><td>' + esc(LA.fmtTime(g.first)) + '</td><td>' + esc(LA.fmtTime(g.last)) + '</td></tr>').join('') +
        '</tbody></table></div></div>';
    }
    if (r.stacks.length) {
      h += '<div class="block"><div class="block-head"><h3>Exceptions by type and top frame</h3><span class="hint">' + n(r.stackCount) + ' groups</span></div>' +
        r.stacks.slice(0, 50).map(s => '<details class="grp"><summary><span class="cnt">' + n(s.count) + '×</span><span class="top">' + esc(s.type) + (s.root ? ' ← caused by ' + esc(s.root) : '') + '<br>at ' + esc(s.frame || 'unknown frame') + '</span></summary>' +
          '<div class="body">First at line ' + n(s.firstLine) + (s.first != null ? ' (' + esc(LA.fmtTime(s.first)) + '), last ' + esc(LA.fmtTime(s.last)) : '') + '<pre class="stack">' + esc(s.example.join('\n')) + '</pre></div></details>').join('') + '</div>';
    }
    if (r.access) h += accessHtml(r.access);

    h += '<div class="block" id="explore"><div class="block-head"><h3>Search warnings and errors</h3><span class="hint">' + n(r.samples.length) + ' lines kept' + (r.samplesDropped ? ' (first 20,000; ' + n(r.samplesDropped) + ' more not kept)' : '') + '</span></div>' +
      '<div class="explore"><label>Search<input type="search" id="q" placeholder="timeout, order 123, /api/…" value="' + esc(view.q) + '"></label>' +
      '<label class="check"><input type="checkbox" id="rx"' + (view.regex ? ' checked' : '') + '> Regex</label>' +
      '<div class="lvchips" role="group" aria-label="Levels">' + ['FATAL', 'ERROR', 'WARN'].map(l => '<button type="button" class="chip-btn" data-lv="' + l + '" aria-pressed="' + (view.levels.indexOf(l) >= 0) + '">' + l + '</button>').join('') + '</div>' +
      (r.firstTs != null ? '<label>From<input type="datetime-local" id="from" step="1"></label><label>To<input type="datetime-local" id="to" step="1"></label><button type="button" class="btn btn-ghost btn-small" id="resetwin">All times</button>' : '') +
      '</div><div id="winfirst"></div><ul class="hits" id="hits"></ul></div>';

    h += '<div class="block"><div class="block-head"><h3>Export</h3></div><div class="exports">' +
      '<button class="btn btn-ghost btn-small" type="button" id="x-csv">Errors CSV</button>' +
      (r.access ? '<button class="btn btn-ghost btn-small" type="button" id="x-ep">Endpoints CSV</button>' : '') +
      '<button class="btn btn-ghost btn-small" type="button" id="x-md">Copy Markdown summary</button>' +
      '<button class="btn btn-ghost btn-small" type="button" id="x-mdf">Download Markdown</button><span class="copied" id="copied" aria-live="polite"></span></div>' +
      '<p class="hint">The Markdown summary pastes cleanly into Jira, GitHub, Confluence or Slack.</p></div>';

    result.innerHTML = h;
    wire();
    if (r.firstTs != null) setWindowInputs();
    renderHits();
  }

  function bucketLabel(m) { return m === 1 ? 'minute' : m < 60 ? m + ' minutes' : m === 60 ? 'hour' : m < 1440 ? (m / 60) + ' hours' : m === 1440 ? 'day' : 'week'; }

  function chart(t) {
    // bars stretch to the box width; labels are HTML so they never distort
    const W = 1000, H = 200, P = { l: 0, r: 0, t: 6, b: 1 };
    const b = t.buckets;
    let max = 1;
    b.forEach(x => { if (x.errors > max) max = x.errors; if (x.warns > max) max = x.warns; });
    if (t.threshold > max) max = t.threshold;
    const bw = (W - P.l - P.r) / b.length;
    const y = v => P.t + (H - P.t - P.b) * (1 - v / max);
    let s = '<div class="ylab">' + Math.round(max) + '</div><svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="Errors per ' + bucketLabel(t.bucketMinutes) + ' over time">';
    [0, 0.5, 1].forEach(f => { const v = max * f; s += '<line class="axis" vector-effect="non-scaling-stroke" x1="0" x2="' + W + '" y1="' + y(v) + '" y2="' + y(v) + '"/>'; });
    const spikeSet = new Set(t.spikes.map(x => x.t));
    b.forEach((x, i) => {
      const x0 = P.l + i * bw, w = Math.max(0.6, bw * 0.85);
      if (x.warns) s += '<rect class="wbar" x="' + x0.toFixed(2) + '" y="' + y(x.warns).toFixed(1) + '" width="' + w.toFixed(2) + '" height="' + (H - P.b - y(x.warns)).toFixed(1) + '"/>';
      const hgt = H - P.b - y(x.errors);
      s += '<rect class="bar' + (spikeSet.has(x.t) ? ' spike' : '') + (view.sel === i ? ' sel' : '') + '" data-i="' + i + '" x="' + x0.toFixed(2) + '" y="' + (x.errors ? y(x.errors) : H - P.b - 0.01).toFixed(1) + '" width="' + w.toFixed(2) + '" height="' + Math.max(x.errors ? 1 : 0, hgt).toFixed(1) + '"><title>' + esc(LA.fmtTime(x.t, false)) + ': ' + x.errors + ' errors, ' + x.warns + ' warnings, ' + x.total + ' entries</title></rect>';
      // a transparent hit area so empty buckets are clickable too
      s += '<rect data-i="' + i + '" x="' + x0.toFixed(2) + '" y="' + P.t + '" width="' + bw.toFixed(2) + '" height="' + (H - P.t - P.b) + '" fill="transparent" style="cursor:pointer"><title>' + esc(LA.fmtTime(x.t, false)) + ': ' + x.errors + ' errors</title></rect>';
    });
    if (t.sd > 0) s += '<line class="thr" vector-effect="non-scaling-stroke" x1="0" x2="' + W + '" y1="' + y(t.threshold) + '" y2="' + y(t.threshold) + '"/>';
    s += '</svg>';
    const lab = i => esc(LA.fmtTime(b[i].t, false));
    return s + '<div class="xlab"><span>' + lab(0) + '</span><span>' + lab(Math.floor((b.length - 1) / 2)) + '</span><span>' + lab(b.length - 1) + '</span></div>';
  }

  function accessHtml(a) {
    let h = '<div class="block"><div class="block-head"><h3>HTTP requests</h3><span class="hint">' + n(a.requests) + ' requests · ' + n(a.ipCount) + ' client IPs</span></div>';
    h += '<div class="ja-stats">' + Object.keys(a.classes).filter(k => a.classes[k] || k === '5xx' || k === '4xx').map(k => '<div class="ja-stat' + (k === '5xx' && a.classes[k] ? ' bad' : k === '4xx' && a.classes[k] ? ' warn' : '') + '"><b>' + n(a.classes[k]) + '</b><span>' + k + ' (' + (a.classes[k] / a.requests * 100).toFixed(1) + '%)</span></div>').join('') + '</div>';
    h += '<div class="two" style="margin-top:12px"><div><div class="tbl-wrap"><table class="data"><thead><tr><th class="l">Status</th><th>Requests</th><th>Share</th></tr></thead><tbody>' +
      a.statuses.slice(0, 20).map(s => '<tr><td>' + s.status + '</td><td>' + n(s.count) + '</td><td>' + (s.count / a.requests * 100).toFixed(1) + '%</td></tr>').join('') + '</tbody></table></div></div>' +
      '<div><div class="tbl-wrap"><table class="data"><thead><tr><th class="l">Top client IPs</th><th>Requests</th></tr></thead><tbody>' +
      a.ips.slice(0, 10).map(s => '<tr><td class="code">' + esc(s.key) + '</td><td>' + n(s.count) + '</td></tr>').join('') + '</tbody></table></div></div></div>';
    if (a.hasTimes && a.slowest.length) {
      h += '<h3 style="margin:18px 0 8px;font-size:16px">Slowest endpoints (by p95)</h3><div class="tbl-wrap"><table class="data"><thead><tr><th class="l">Endpoint</th><th>Requests</th><th>5xx</th><th>p50</th><th>p95</th><th>p99</th><th>Max</th></tr></thead><tbody>' +
        a.slowest.slice(0, 15).map(e => '<tr><td class="code">' + esc(e.endpoint) + '</td><td>' + n(e.count) + '</td><td' + (e.errors ? ' class="errs"' : '') + '>' + n(e.errors) + '</td><td>' + ms(e.p50) + '</td><td>' + ms(e.p95) + '</td><td>' + ms(e.p99) + '</td><td>' + ms(e.max) + '</td></tr>').join('') + '</tbody></table></div>';
    } else h += '<p class="hint">No response times found in this log. Add <code>$request_time</code> (Nginx) or <code>%D</code> (Apache) to the log format to see slow endpoints.</p>';
    h += '<h3 style="margin:18px 0 8px;font-size:16px">Busiest endpoints</h3><div class="tbl-wrap"><table class="data"><thead><tr><th class="l">Endpoint</th><th>Requests</th><th>5xx</th><th>4xx</th><th>Error %</th>' + (a.hasTimes ? '<th>Avg</th>' : '') + '</tr></thead><tbody>' +
      a.endpoints.slice(0, 20).map(e => '<tr><td class="code">' + esc(e.endpoint) + '</td><td>' + n(e.count) + '</td><td' + (e.errors ? ' class="errs"' : '') + '>' + n(e.errors) + '</td><td>' + n(e.client) + '</td><td>' + e.errorPct + '%</td>' + (a.hasTimes ? '<td>' + ms(e.avg) + '</td>' : '') + '</tr>').join('') + '</tbody></table></div>';
    h += '<h3 style="margin:18px 0 8px;font-size:16px">Top user agents</h3><div class="tbl-wrap"><table class="data"><thead><tr><th class="l">User agent</th><th>Requests</th></tr></thead><tbody>' +
      a.agents.slice(0, 10).map(s => '<tr><td class="msg">' + esc(s.key) + '</td><td>' + n(s.count) + '</td></tr>').join('') + '</tbody></table></div>';
    return h + '</div>';
  }

  // datetime-local values are wall-clock; the analyser stores wall-clock times as UTC milliseconds
  const toLocalInput = t => (t == null ? '' : new Date(t).toISOString().slice(0, 19));
  const fromLocalInput = v => (v ? Date.parse(v.length === 16 ? v + ':00Z' : v + 'Z') : null);
  function setWindowInputs() {
    const f = $('from'), t = $('to');
    if (!f) return;
    f.value = toLocalInput(view.from != null ? view.from : current.firstTs);
    t.value = toLocalInput(view.to != null ? view.to : current.lastTs);
  }

  function wire() {
    const q = $('q');
    let timer = 0;
    q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { view.q = q.value; renderHits(); }, 150); });
    $('rx').addEventListener('change', e => { view.regex = e.target.checked; renderHits(); });
    result.querySelectorAll('[data-lv]').forEach(b => b.addEventListener('click', () => {
      const l = b.dataset.lv, i = view.levels.indexOf(l);
      if (i >= 0) view.levels.splice(i, 1); else view.levels.push(l);
      b.setAttribute('aria-pressed', String(i < 0));
      renderHits();
    }));
    if ($('from')) {
      $('from').addEventListener('change', e => { view.from = fromLocalInput(e.target.value); view.sel = -1; renderHits(); });
      $('to').addEventListener('change', e => { view.to = fromLocalInput(e.target.value); view.sel = -1; renderHits(); });
      $('resetwin').addEventListener('click', () => { view.from = view.to = null; view.sel = -1; setWindowInputs(); markBar(); renderHits(); });
    }
    const svg = result.querySelector('.chart-box svg');
    if (svg) svg.addEventListener('click', e => {
      const el = e.target.closest('[data-i]');
      if (!el) return;
      const i = +el.dataset.i, b = current.timeline.buckets[i];
      view.sel = i; view.from = b.t; view.to = b.t + current.timeline.bucketMinutes * 60000 - 1;
      setWindowInputs(); markBar(); renderHits();
      $('explore').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    $('x-csv').addEventListener('click', () => download('log-errors.csv', LA.groupsToCSV(current), 'text/csv'));
    if ($('x-ep')) $('x-ep').addEventListener('click', () => download('log-endpoints.csv', LA.endpointsToCSV(current), 'text/csv'));
    $('x-md').addEventListener('click', async () => {
      const md = LA.toMarkdown(current, sourceName);
      try { await navigator.clipboard.writeText(md); $('copied').textContent = 'Copied'; } catch (e) { download('log-summary.md', md, 'text/markdown'); $('copied').textContent = 'Downloaded'; }
      setTimeout(() => { $('copied').textContent = ''; }, 2500);
    });
    $('x-mdf').addEventListener('click', () => download('log-summary.md', LA.toMarkdown(current, sourceName), 'text/markdown'));
  }
  function markBar() { result.querySelectorAll('.chart-box .bar').forEach(r => r.classList.toggle('sel', +r.dataset.i === view.sel)); }

  function renderHits() {
    const list = LA.filterEntries(current.samples, { q: view.q, regex: view.regex, levels: view.levels, from: view.from, to: view.to });
    const ul = $('hits');
    const shown = list.slice(0, 300);
    ul.innerHTML = shown.length ? shown.map(e => '<li><span class="ln">' + n(e.line) + '</span> ' + (e.ts != null ? esc(LA.fmtTime(e.ts)) + ' ' : '') + '<span class="lv ' + e.level + '">' + e.level + '</span> ' + esc(e.msg.slice(0, 400)) + '</li>').join('') +
      (list.length > shown.length ? '<li class="ln">…and ' + n(list.length - shown.length) + ' more. Narrow the search to see them.</li>' : '') : '<li class="ln">No matching lines.</li>';
    const wf = $('winfirst');
    if (view.from != null || view.to != null) {
      const f = LA.firstErrorIn(current.samples, view.from, view.to);
      wf.innerHTML = '<div class="card-x info" style="margin:0 0 10px"><h4>First error in this window' + (f ? ' · line ' + n(f.line) + ' · ' + esc(LA.fmtTime(f.ts)) : '') + '</h4><p>' + (f ? '<code>' + esc(f.msg.slice(0, 300)) + '</code>' : 'No errors between these times.') + ' ' + n(list.length) + ' matching lines.</p></div>';
    } else wf.innerHTML = '';
  }

  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: type + ';charset=utf-8' }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
})();
