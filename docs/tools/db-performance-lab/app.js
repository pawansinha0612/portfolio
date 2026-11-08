/* UI for /tools/db-performance-lab/. Logic lives in dbplan.js (window.DBPlanLab); analysis runs in worker.js.
   Nothing is uploaded: the plan, SQL and files are read on this page only. */
(function () {
  'use strict';
  const D = window.DBPlanLab;
  const $ = id => document.getElementById(id);
  const input = $('plan-in'), sqlIn = $('sql-in'), result = $('result'), errBox = $('err'), progress = $('progress'), ptext = $('ptext');
  const fileInput = $('file'), filechip = $('filechip'), fname = $('fname');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ms = D.fmtMs, n = D.fmtN;
  const mb = b => (b / 1048576).toFixed(1) + ' MB';
  let file = null, worker = null, current = null, sourceName = '', started = 0;

  // ------------------------------------------------------------------ input
  function setFile(f) {
    file = f;
    if (f) { fname.textContent = f.name + ' · ' + mb(f.size); filechip.hidden = false; input.value = ''; input.placeholder = 'File ready: ' + f.name + '. Press Analyse, or paste text here instead.'; }
    else { filechip.hidden = true; input.placeholder = 'Seq Scan on orders  (cost=0.00..44925.00 rows=2100 width=28) (actual time=0.031..1712.880 rows=41250 loops=1)'; }
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
  $('clear').addEventListener('click', () => { input.value = ''; sqlIn.value = ''; setFile(null); fileInput.value = ''; result.hidden = true; errBox.hidden = true; document.querySelectorAll('[data-sample]').forEach(b => b.removeAttribute('aria-pressed')); });
  document.querySelectorAll('[data-sample]').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('[data-sample]').forEach(x => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
    const k = b.dataset.sample;
    setFile(null);
    $('fmt').value = 'auto';
    input.value = D.samples[k];
    sqlIn.value = D.sampleSql[k] || '';
    if (sqlIn.value) $('sql-box').open = true;
    sourceName = b.textContent.trim();
    run();
  }));

  // ------------------------------------------------------------------ run
  function run() {
    errBox.hidden = true;
    const text = input.value;
    if (!file && !text.trim()) { errBox.textContent = 'Paste a query plan or a statistics CSV, or choose a file first.'; errBox.hidden = false; return; }
    if (file) sourceName = file.name;
    else if (!document.querySelector('[data-sample][aria-pressed="true"]')) sourceName = 'pasted text';
    const opts = { format: $('fmt').value, sql: sqlIn.value };
    started = performance.now();
    if (!file && text.length < 400000) { try { done(D.analyse(text, opts)); } catch (e) { fail(e); } return; }
    progress.hidden = false; ptext.textContent = 'Analysing ' + mb(file ? file.size : text.length) + '…';
    try { if (worker) worker.terminate(); worker = new Worker('/tools/db-performance-lab/worker.js'); } catch (e) { worker = null; }
    if (!worker) { (file ? file.text() : Promise.resolve(text)).then(t => { try { done(D.analyse(t, opts)); } catch (e) { fail(e); } }, fail); return; }
    worker.onmessage = e => { const m = e.data; if (m.type === 'done') done(m.result); else if (m.type === 'error') fail(new Error(m.message)); };
    worker.onerror = () => { worker = null; fail(new Error('the background worker stopped')); };
    worker.postMessage(file ? { file, opts } : { text, opts });
  }
  function fail(e) { progress.hidden = true; errBox.textContent = 'Could not analyse this: ' + (e && e.message ? e.message : e); errBox.hidden = false; }
  function done(r) {
    progress.hidden = true;
    current = r; r.took = Math.round(performance.now() - started);
    if (r.kind === 'stats') renderStats(r); else renderPlan(r);
    result.hidden = false;
    result.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function stat(v, l, cls) { return '<div class="ja-stat' + (cls ? ' ' + cls : '') + '"><b>' + v + '</b><span>' + l + '</span></div>'; }
  const fmtLine = r => '<p class="fmt">Format: ' + esc(r.formatLabel || r.source) + ' · ' + esc(sourceName || 'pasted text') + ' · analysed in ' + (r.took >= 1000 ? (r.took / 1000).toFixed(1) + ' s' : r.took + ' ms') + '</p>';
  function exportsHtml() {
    return '<div class="block"><div class="block-head"><h3>Export</h3></div><div class="exports">' +
      '<button class="btn btn-ghost btn-small" type="button" id="x-md">Copy Markdown summary</button>' +
      '<button class="btn btn-ghost btn-small" type="button" id="x-mdf">Download Markdown</button><span class="copied" id="copied" aria-live="polite"></span></div>' +
      '<p class="hint">Pastes cleanly into Jira, GitHub, Confluence or Slack, fixes included.</p></div>';
  }
  function wireExports() {
    $('x-md').addEventListener('click', () => {
      const t = D.toMarkdown(current);
      (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => flash('Copied'), () => flash('Copy failed: use Download'));
    });
    $('x-mdf').addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([D.toMarkdown(current)], { type: 'text/markdown' }));
      a.download = current.kind === 'stats' ? 'query-stats.md' : 'query-plan.md'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
  }
  function flash(t, el) { const c = el || $('copied'); c.textContent = t; setTimeout(() => { c.textContent = ''; }, 2000); }
  function wireCopy() {
    result.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', () => {
      const pre = b.parentElement.querySelector('pre');
      (navigator.clipboard ? navigator.clipboard.writeText(pre.textContent) : Promise.reject()).then(() => { b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy'; }, 1500); }, () => { b.textContent = 'Select and copy'; });
    }));
  }

  // ------------------------------------------------------------------ plan
  const view = { open: new Set(), hl: -1 };
  function renderPlan(r) {
    const p = r.plan;
    const hi = p.findings.filter(f => f.severity === 'high').length;
    const hot = p.nodes.slice().sort((a, b) => b.share - a.share)[0];
    let h = '<div class="verdict ' + (hi ? 'fail' : p.findings.some(f => f.severity === 'medium') ? 'warn' : 'pass') + '"><h2>' +
      (p.hasActual && p.totalMs != null ? esc(ms(p.totalMs)) : 'Estimated plan') + (hot && hot.share ? ' · ' + Math.round(hot.share * 100) + '% in ' + esc(hot.type) + (hot.relation ? ' on ' + esc(hot.relation) : '') : '') + '</h2>' +
      '<p>' + p.summary.map(esc).join(' ') + '</p>' + fmtLine(r) + '</div>';
    if (p.warnings.length) h += '<ul class="warnings">' + p.warnings.map(w => '<li>' + esc(w) + '</li>').join('') + '</ul>';
    const root = p.nodes[0];
    h += '<div class="ja-stats">' +
      (p.hasActual ? stat(esc(ms(p.totalMs)), 'Execution time') : stat(n(root.est.cost != null ? root.est.cost : p.nodes.reduce((x, y) => x + (y.costSelf || 0), 0)), 'Estimated cost')) +
      (p.planningMs != null ? stat(esc(ms(p.planningMs)), r.engine === 'sqlserver' ? 'Compile time' : 'Planning time', p.hasActual && p.planningMs > p.totalMs ? 'warn' : '') : '') +
      stat(n(p.nodes.length), 'Plan nodes') +
      stat(n(hi), 'Important findings', hi ? 'bad' : '') + stat(n(p.findings.length - hi), 'Other findings', p.findings.length - hi ? 'warn' : '') +
      (root.rowsAct != null ? stat(n(root.rowsAct), 'Rows returned') : root.rowsEst != null ? stat(n(root.rowsEst), 'Rows (estimated)') : '') +
      (p.io ? stat(Math.round(p.io.hit * 100 / Math.max(1, p.io.hit + p.io.read)) + '%', 'Pages from cache', p.io.read > p.io.hit ? 'warn' : '') : '') +
      (p.jit && p.jit.total ? stat(esc(ms(p.jit.total)), 'JIT compile', p.totalMs && p.jit.total > p.totalMs * 0.1 ? 'warn' : '') : '') +
      '</div>';
    if (p.findings.length) {
      h += '<div class="block"><div class="block-head"><h3>Findings and fixes</h3><span class="hint">Most important first</span></div>' +
        p.findings.map(f => '<div class="card-x ' + (f.severity === 'high' ? '' : f.severity === 'medium' ? 'warn' : 'info') + '"><h4>' + esc(f.title) + '</h4><p>' + esc(f.text) + '</p>' +
          (f.fix ? '<div class="fixbox"><button type="button" class="copybtn" data-copy>Copy</button><pre class="sql"><code>' + esc(f.fix) + '</code></pre></div>' : '') +
          (f.node >= 0 ? '<button type="button" class="linkbtn" data-node="' + f.node + '">Show node ' + (f.node + 1) + ' in the plan</button>' : '') + '</div>').join('') +
        '<p class="hint">Test index and setting changes on a copy of production data first. Fixes are suggestions from the plan alone; check them against existing indexes and your write load.</p></div>';
    } else h += '<div class="block"><div class="card-x info"><h4>No obvious problems</h4><p>Row estimates are close, nothing spills to disk, and no large scan throws most of its rows away. If the query is still too slow, look at the node with the biggest share below: it is the one to make cheaper.</p></div></div>';
    h += '<div class="block" id="tree-block"><div class="block-head"><h3>Plan tree</h3><span class="hint">' + (p.shareBy === 'time' ? 'Bars show exclusive time: time in the node itself, not its children' : 'No actual times in this plan: bars show each node\'s own share of the estimated cost') + '. Click a node for its details.</span></div>' +
      '<div class="tbl-wrap"><table class="data plan"><thead><tr><th class="l">Node</th><th class="l">' + (p.shareBy === 'time' ? 'Time share' : 'Cost share') + '</th>' +
      (p.hasActual ? '<th>Exclusive</th><th>Inclusive</th>' : '') + '<th>Rows est.</th>' + (p.hasRows ? '<th>Rows actual</th><th>Est. off by</th><th>Loops</th>' : '') + (r.engine !== 'mysql' ? '<th>Buffers / reads</th>' : '') + '</tr></thead><tbody id="tree"></tbody></table></div></div>';
    if (p.sql) h += '<div class="block"><div class="block-head"><h3>Statement</h3></div><pre class="sql stmt"><code>' + esc(p.sql) + '</code></pre></div>';
    h += exportsHtml();
    result.innerHTML = h;
    view.open = new Set(); view.hl = -1;
    drawTree();
    wireExports(); wireCopy();
    result.querySelectorAll('[data-node]').forEach(b => b.addEventListener('click', () => {
      const id = +b.dataset.node; view.hl = id; view.open.add(id); drawTree();
      const row = $('tree').querySelector('tr[data-id="' + id + '"]');
      if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }));
  }
  function bufText(x, engine) {
    const b = x.buffers || {};
    if (engine === 'sqlserver') return x.ms ? n(x.ms.logical) + ' logical' + (x.ms.physical ? ' · ' + n(x.ms.physical) + ' physical' : '') : '';
    const parts = [];
    if (b.sharedHit) parts.push(n(b.sharedHit) + ' hit');
    if (b.sharedRead) parts.push(n(b.sharedRead) + ' read');
    if (b.tempWritten) parts.push(n(b.tempWritten) + ' temp');
    return parts.join(' · ');
  }
  function drawTree() {
    const r = current, p = r.plan;
    const flagged = {}; p.findings.forEach(f => { if (f.node >= 0) flagged[f.node] = flagged[f.node] === 'high' ? 'high' : f.severity; });
    const cols = 3 + (p.hasActual ? 2 : 0) + (p.hasRows ? 3 : 0) + (r.engine !== 'mysql' ? 1 : 0);
    let h = '';
    p.nodes.forEach(x => {
      const mis = x.misest;
      const misTxt = mis == null ? '' : Math.abs(mis) < 1.5 ? '≈' : (mis > 0 ? '↑ ' : '↓ ') + (Math.abs(mis) >= 100 ? Math.round(Math.abs(mis)).toLocaleString('en-AU') : Math.abs(mis).toFixed(1)) + '×';
      const misCls = mis != null && Math.abs(mis) >= 10 ? ' class="misbad"' : '';
      const sh = Math.round((x.share || 0) * 1000) / 10;
      h += '<tr data-id="' + x.id + '" tabindex="0" class="node' + (view.hl === x.id ? ' is-hl' : '') + (x.never ? ' never' : '') + '" aria-expanded="' + view.open.has(x.id) + '">' +
        '<td class="nd" style="padding-left:' + (10 + Math.min(x.depth, 16) * 14) + 'px">' + (x.depth ? '<span class="arrow">↳</span>' : '') +
        (flagged[x.id] ? '<span class="flag ' + flagged[x.id] + '" title="Has a finding">●</span>' : '') +
        (x.subplan ? '<span class="sub">' + esc(x.subplan) + '</span> ' : '') + '<b>' + esc(x.type) + '</b>' +
        (x.relation || x.index ? ' <span class="rel">' + esc((x.relation ? 'on ' + x.relation + (x.alias ? ' ' + x.alias : '') : '') + (x.index ? (x.relation ? ' · ' : '') + 'index ' + x.index : '')) + '</span>' : '') +
        (x.never ? ' <span class="rel">(never executed)</span>' : '') + '</td>' +
        '<td class="l"><span class="tbar"><i style="width:' + Math.min(100, sh) + '%"' + (sh >= 30 ? ' class="big"' : '') + '></i></span>' + sh + '%</td>' +
        (p.hasActual ? '<td>' + esc(ms(x.excl)) + '</td><td>' + esc(ms(x.incl)) + '</td>' : '') +
        '<td>' + n(x.rowsEst) + '</td>' +
        (p.hasRows ? '<td>' + n(x.rowsAct) + '</td><td' + misCls + '>' + misTxt + '</td><td>' + (x.act ? n(x.act.loops) : '') + '</td>' : '') +
        (r.engine !== 'mysql' ? '<td>' + esc(bufText(x, r.engine)) + '</td>' : '') + '</tr>';
      if (view.open.has(x.id)) h += '<tr class="detail"><td colspan="' + cols + '">' + nodeDetail(x, r) + '</td></tr>';
    });
    const tb = $('tree');
    tb.innerHTML = h;
    tb.querySelectorAll('tr.node').forEach(tr => {
      const toggle = () => { const id = +tr.dataset.id; if (view.open.has(id)) view.open.delete(id); else view.open.add(id); drawTree(); };
      tr.addEventListener('click', toggle);
      tr.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    });
  }
  function nodeDetail(x, r) {
    const L = [];
    const row = (k, v) => { if (v != null && v !== '' && v !== 0) L.push('<dt>' + esc(k) + '</dt><dd>' + v + '</dd>'); };
    const code = v => '<code>' + esc(v) + '</code>';
    row('Node', esc(x.label));
    const P = x.props || {};
    row('Filter', P.filter && code(P.filter)); row('Index condition', P.indexCond && code(P.indexCond)); row('Recheck condition', P.recheckCond && code(P.recheckCond));
    row('Hash condition', P.hashCond && code(P.hashCond)); row('Merge condition', P.mergeCond && code(P.mergeCond)); row('Join filter', P.joinFilter && code(P.joinFilter));
    row('Sort key', P.sortKey && code(P.sortKey)); row('Group key', P.groupKey && code(P.groupKey));
    if (x.removed) { row('Rows removed by filter', x.removed.filter && n(x.removed.filter) + (x.act && x.act.loops > 1 ? ' per loop' : '')); row('Rows removed by join filter', x.removed.join && n(x.removed.join)); row('Rows removed by recheck', x.removed.recheck && n(x.removed.recheck)); }
    if (x.act && x.act.first != null && x.act.loops) row('First row after', esc(ms(x.act.first)) + (x.act.loops > 1 ? ' (per loop)' : ''));
    if (x.est) { row('Estimated cost', x.est.cost != null ? (x.est.startup != null ? x.est.startup + ' → ' : '') + x.est.cost : ''); row('Estimated rows per loop', x.est.rows != null ? n(x.est.rows) : ''); }
    if (x.my) { row('Access type', x.my.access && code(x.my.access)); row('Rows produced', x.my.produced != null ? n(x.my.produced) : ''); row('Filtered', x.my.filtered != null ? x.my.filtered + '%' : ''); row('Possible keys', x.my.possibleKeys && x.my.possibleKeys.length ? esc(x.my.possibleKeys.join(', ')) : ''); }
    if (x.sort) row('Sort', esc(x.sort.method + ', ' + D.fmtKB(x.sort.kb) + (x.sort.disk ? ' on disk' : ' in memory')));
    if (x.hash) row('Hash', esc((x.hash.buckets ? n(x.hash.buckets) + ' buckets, ' : '') + x.hash.batches + ' batch' + (x.hash.batches === 1 ? '' : 'es') + (x.hash.origBatches && x.hash.origBatches !== x.hash.batches ? ' (planned ' + x.hash.origBatches + ')' : '') + ', ' + D.fmtKB(x.hash.kb) + (x.hash.diskKB ? ', ' + D.fmtKB(x.hash.diskKB) + ' on disk' : '')));
    if (x.heap && (x.heap.exact || x.heap.lossy)) row('Heap blocks', esc('exact ' + n(x.heap.exact) + ', lossy ' + n(x.heap.lossy)));
    if (x.workers) row('Workers', esc('planned ' + x.workers.planned + (x.workers.launched != null ? ', launched ' + x.workers.launched : '')));
    const b = x.buffers || {};
    const bt = Object.keys(b).filter(k => b[k]).map(k => k.replace(/([A-Z])/g, ' $1').toLowerCase() + ' ' + (k === 'ioReadMs' ? ms(b[k]) : n(b[k]))).join(', ');
    row('Buffers', bt && esc(bt));
    if (x.ms) row('Runtime', esc(n(x.ms.rowsTotal) + ' rows' + (x.ms.rowsRead ? ', ' + n(x.ms.rowsRead) + ' rows read' : '') + ', ' + n(x.ms.logical) + ' logical reads' + (x.ms.cpu ? ', CPU ' + ms(x.ms.cpu) : '')));
    if (x.output && x.output.length) row('Output', code(x.output.join(', ')));
    if (x.warnings && x.warnings.length) row('Warnings', esc(x.warnings.map(w => w.kind + (w.level ? ' level ' + w.level : '') + (w.cols ? ': ' + w.cols.join(', ') : '')).join('; ')));
    if (P.other) row('Other', '<pre class="sql">' + esc(P.other) + '</pre>');
    return '<dl class="nd-detail">' + L.join('') + '</dl>';
  }

  // ------------------------------------------------------------------ statistics
  const sv = { key: 'total', dir: -1 };
  const statOpen = new Set();
  function renderStats(r) {
    const q = r.queries;
    let h = '<div class="verdict ' + (q.some(x => x.flags.length) ? 'warn' : 'pass') + '"><h2>' + n(r.queryCount) + ' queries · ' + esc(ms(r.totalMs)) + ' of database time</h2><p>' + r.summary.map(esc).join(' ') + '</p>' + fmtLine(r) + '</div>';
    h += '<div class="ja-stats">' + stat(n(r.queryCount), 'Distinct queries') + stat(n(r.calls), 'Calls') + stat(esc(ms(r.totalMs)), 'Total time') + stat(Math.round(q[0].share * 100) + '%', 'Top query\'s share', q[0].share >= 0.3 ? 'warn' : '') +
      stat(n(q.filter(x => x.flags.length).length), 'Queries flagged', q.some(x => x.flags.length) ? 'warn' : '') + '</div>';
    h += '<div class="block"><div class="block-head"><h3>Queries ranked</h3><span class="hint">Click a column to sort. Click a query for the full text and what to do.</span></div><div class="tbl-wrap"><table class="data stats"><thead><tr>' +
      [['#', ''], ['Query', ''], ['Calls', 'calls'], ['Total', 'total'], ['Mean', 'mean'], ['Max', 'max'], ['Rows / call', 'rowsPerCall'], ['Share', 'share']].map(c => c[1] ? '<th aria-sort="' + (sv.key === c[1] ? (sv.dir < 0 ? 'descending' : 'ascending') : 'none') + '"><button type="button" data-sort="' + c[1] + '">' + c[0] + '</button></th>' : '<th class="l">' + c[0] + '</th>').join('') +
      '</tr></thead><tbody id="qrows"></tbody></table></div></div>';
    h += exportsHtml();
    result.innerHTML = h;
    statOpen.clear();
    drawStats();
    result.querySelectorAll('[data-sort]').forEach(b => b.addEventListener('click', () => {
      const k = b.dataset.sort; sv.dir = sv.key === k ? -sv.dir : -1; sv.key = k;
      result.querySelectorAll('th[aria-sort]').forEach(th => { const kk = th.querySelector('button').dataset.sort; th.setAttribute('aria-sort', kk === sv.key ? (sv.dir < 0 ? 'descending' : 'ascending') : 'none'); });
      drawStats();
    }));
    wireExports();
  }
  function drawStats() {
    const r = current;
    const rank = new Map(r.queries.map((q, i) => [q, i + 1]));
    const list = r.queries.slice().sort((a, b) => ((a[sv.key] || 0) - (b[sv.key] || 0)) * sv.dir).slice(0, 200);
    let h = '';
    list.forEach(q => {
      const i = rank.get(q);
      const sh = Math.round(q.share * 1000) / 10;
      h += '<tr class="node" data-q="' + i + '" tabindex="0" aria-expanded="' + statOpen.has(i) + '"><td>' + i + '</td><td class="msg"><code>' + esc(q.query.length > 140 ? q.query.slice(0, 139) + '…' : q.query) + '</code>' +
        (q.flags.length ? '<div class="qflags">' + q.flags.map(f => '<span class="qflag">' + esc({ slow: 'slow', chatty: 'N+1?', examined: 'index?', 'no-index': 'no index', cache: 'disk reads', rows: 'many rows', temp: 'temp files' }[f.id] || f.id) + '</span>').join('') + '</div>' : '') + '</td>' +
        '<td>' + n(q.calls) + '</td><td>' + esc(ms(q.total)) + '</td><td' + (q.mean >= 1000 ? ' class="slow"' : '') + '>' + esc(ms(q.mean)) + '</td><td>' + (q.max ? esc(ms(q.max)) : '—') + '</td><td>' + (q.rowsPerCall != null ? n(q.rowsPerCall) : '—') + '</td>' +
        '<td class="l"><span class="tbar"><i style="width:' + Math.min(100, sh) + '%"' + (sh >= 30 ? ' class="big"' : '') + '></i></span>' + sh + '%</td></tr>';
      if (statOpen.has(i)) h += '<tr class="detail"><td colspan="8"><pre class="sql">' + esc(q.query) + '</pre>' +
        (q.flags.length ? '<ul class="qnotes">' + q.flags.map(f => '<li>' + esc(f.text) + '</li>').join('') + '</ul>' : '<p class="hint">Nothing unusual in the numbers. If it is near the top by total time, make it cheaper: get its plan and paste it above.</p>') +
        (q.hitPct != null ? '<p class="hint">Cache hit: ' + q.hitPct.toFixed(1) + '%.</p>' : '') + '<p class="hint">Next step: run <code>EXPLAIN (ANALYZE, BUFFERS)</code> (PostgreSQL), <code>EXPLAIN ANALYZE</code> (MySQL) or capture an actual execution plan (SQL Server) for this query with real parameter values, and paste it into this tool.</p></td></tr>';
    });
    const tb = $('qrows');
    tb.innerHTML = h;
    tb.querySelectorAll('tr.node').forEach(tr => {
      const toggle = () => { const i = +tr.dataset.q; if (statOpen.has(i)) statOpen.delete(i); else statOpen.add(i); drawStats(); };
      tr.addEventListener('click', toggle);
      tr.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    });
  }
})();
