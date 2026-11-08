/* Perf Studio page: wires the form to studio.js. All work happens in this browser tab; nothing is sent anywhere. */
(() => {
  'use strict';
  const S = window.PerfStudio, K = window.OpenApiToK6, E = window.K6Explain, J = window.JTL;
  const $ = id => document.getElementById(id);
  const yaml = () => (window.jsyaml && window.jsyaml.load) || null;
  const UNSAFE = ['POST', 'PUT', 'PATCH', 'DELETE'];
  const STORE = 'perf-studio-estimate';
  const track = name => { if (window.goatcounter && window.goatcounter.count) window.goatcounter.count({ path: name, title: name, event: true }); };

  const state = { ops: [], signature: '', selected: new Set(), mix: {}, script: '', est: null, results: null, resultsName: '', ev: null, recs: null };

  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (v != null && v !== false) n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : String(c));
    return n;
  }
  function msg(box, cls, text) { box.appendChild(el('p', { class: 'msg ' + cls, text })); }
  function table(t, head, rows, alignLeft) {
    t.textContent = '';
    const thead = el('thead', {}, el('tr', {}, head.map((h, i) => el('th', { text: h, class: alignLeft && alignLeft.includes(i) ? 'wrap-cell' : null }))));
    const tbody = el('tbody', {}, rows.map(r => el('tr', {}, r.map((c, i) => {
      const td = el('td', { class: alignLeft && alignLeft.includes(i) ? 'wrap-cell' : null });
      if (c && c.nodeType) td.appendChild(c); else td.textContent = c == null ? '' : String(c);
      return td;
    }))));
    t.append(thead, tbody);
  }
  function download(name, text, type) {
    const a = el('a', { href: URL.createObjectURL(new Blob([text], { type: type || 'text/plain' })), download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  async function copy(btn, text, label) {
    if (!text) return;
    try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied ✓'; } catch (e) { btn.textContent = 'Select and copy'; }
    setTimeout(() => { btn.textContent = label; }, 1800);
  }
  const fmt = S;

  // ---------------------------------------------------------------- tabs
  const tabs = [...document.querySelectorAll('[role=tab]')];
  function show(name, focus) {
    for (const t of tabs) {
      const on = t.id === 'tab-' + name;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
      $(t.getAttribute('aria-controls')).hidden = !on;
      if (on && focus) t.focus();
      if (on) t.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    if (name === 'report') renderReport();
  }
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => show(t.id.slice(4)));
    t.addEventListener('keydown', e => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      show(tabs[(i + d + tabs.length) % tabs.length].id.slice(4), true);
    });
  });
  document.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => {
    show(b.dataset.go);
    $('tab-' + b.dataset.go).scrollIntoView({ block: 'start', behavior: 'smooth' });
  }));

  // ---------------------------------------------------------------- 1. API, endpoints, k6 script
  const specIn = $('spec-in'), opsEl = $('ops');

  function renderOps() {
    opsEl.textContent = '';
    for (const o of state.ops) {
      const cb = el('input', { type: 'checkbox', 'aria-label': 'Include ' + o.id });
      cb.checked = state.selected.has(o.id);
      cb.addEventListener('change', () => { cb.checked ? state.selected.add(o.id) : state.selected.delete(o.id); refresh(); });
      const mix = el('input', { type: 'number', min: '0', step: '1', inputmode: 'decimal', value: String(state.mix[o.id] != null ? state.mix[o.id] : 1), 'aria-label': 'Mix for ' + o.id });
      mix.addEventListener('input', () => { state.mix[o.id] = mix.value === '' ? 0 : +mix.value; later(); });
      opsEl.appendChild(el('div', { class: 'op' }, cb, el('span', { class: 'm' + (UNSAFE.includes(o.method) ? ' unsafe' : ''), text: o.method }),
        el('span', { class: 'p', text: o.path, title: o.summary || '' }), el('label', { class: 'mix' }, 'Mix', mix)));
    }
  }

  function readSpec() {
    if (!specIn.value.trim()) { state.ops = []; state.signature = ''; state.selected = new Set(); renderOps(); return; }
    let list = null;
    try { list = K.listOperations(specIn.value, yaml()); } catch (e) { list = null; }
    if (!list) { if (state.ops.length) { state.ops = []; state.signature = ''; renderOps(); } return; }
    const sig = list.map(x => x.id).join('\n');
    if (sig !== state.signature) {
      state.signature = sig; state.ops = list;
      state.selected = new Set(list.map(x => x.id));
      state.mix = {};
      list.forEach(o => { state.mix[o.id] = 1; });
      renderOps();
    }
  }

  function selectedEndpoints() {
    return state.ops.filter(o => state.selected.has(o.id)).map(o => ({ id: o.id, method: o.method, path: o.path, share: state.mix[o.id] != null ? state.mix[o.id] : 1 }));
  }

  function renderScript() {
    const box = $('k6-msgs'), out = $('k6-out').firstChild;
    box.textContent = '';
    state.script = '';
    if (!specIn.value.trim()) { out.textContent = '// Paste an OpenAPI or Swagger definition above, or try an example.'; return; }
    const include = state.ops.length ? [...state.selected] : null;
    const mode = $('k6-mode').value;
    let r;
    try {
      r = S.k6Script(specIn.value, mode === 'estimate' && state.est && !state.est.error
        ? { yaml: yaml(), include, estimate: state.est }
        : { yaml: yaml(), include, k6: { vus: 2, duration: '1m', model: 'closed' } });
    } catch (e) { r = { error: 'Something went wrong while writing the script: ' + e.message }; }
    if (r.error) { msg(box, 'err', r.error); out.textContent = '// ' + r.error; return; }
    state.script = r.script;
    out.textContent = r.script;
    r.warnings.forEach(w => msg(box, 'warn', '⚠️ ' + w));
    r.info.forEach(w => msg(box, 'info', w));
  }

  $('k6-copy').addEventListener('click', () => copy($('k6-copy'), state.script, 'Copy'));
  $('k6-download').addEventListener('click', () => { if (state.script) download('script.js', state.script, 'text/javascript'); });
  $('k6-mode').addEventListener('change', renderScript);
  document.querySelectorAll('[data-example]').forEach(b => b.addEventListener('click', () => {
    specIn.value = K.EXAMPLES[b.dataset.example];
    $('spec-file-name').textContent = '';
    refresh();
    track('perf-studio-example');
  }));
  $('spec-clear').addEventListener('click', () => { specIn.value = ''; $('spec-file-name').textContent = ''; refresh(); specIn.focus(); });
  $('sel-all').addEventListener('click', () => { state.selected = new Set(state.ops.map(o => o.id)); renderOps(); refresh(); });
  $('sel-get').addEventListener('click', () => { state.selected = new Set(state.ops.filter(o => o.method === 'GET').map(o => o.id)); renderOps(); refresh(); });
  $('sel-none').addEventListener('click', () => { state.selected = new Set(); renderOps(); refresh(); });
  $('spec-file').addEventListener('change', e => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    if (f.size > 15 * 1024 * 1024) { $('k6-msgs').textContent = ''; msg($('k6-msgs'), 'err', 'That file is over 15 MB. Upload a smaller definition.'); return; }
    f.text().then(t => { specIn.value = t; $('spec-file-name').textContent = f.name; refresh(); track('perf-studio-upload'); },
      () => msg($('k6-msgs'), 'err', "Couldn't read that file. Try pasting its contents instead."));
    e.target.value = '';
  });

  // ---------------------------------------------------------------- 2. estimate
  const estForm = $('est-form');
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (saved) for (const [k, v] of Object.entries(saved)) {
      const f = estForm.elements[k];
      if (!f) continue;
      if (f.type === 'checkbox') f.checked = !!v;
      else if (typeof RadioNodeList !== 'undefined' && f instanceof RadioNodeList) { for (const r of f) r.checked = r.value === v; }
      else f.value = v;
    }
  } catch (e) { /* storage blocked */ }

  function estInput() {
    const f = estForm.elements;
    return { basis: f.basis.value, peakUsers: f.peakUsers.value, peakPerHour: f.peakPerHour.value, thinkTimeS: f.thinkTimeS.value, respTimeS: f.respTimeS.value,
      targetP95Ms: f.targetP95Ms.value, errorPct: f.errorPct.value, environment: f.environment.value, envScalePct: f.envScalePct.value,
      soakHours: f.soakHours.value, auth: f.auth.checked };
  }

  function renderEstimate() {
    const inp = estInput();
    try { localStorage.setItem(STORE, JSON.stringify(inp)); } catch (e) { /* storage blocked */ }
    $('f-users').hidden = inp.basis !== 'users';
    $('f-reqs').hidden = inp.basis !== 'requests';
    $('f-scale').hidden = inp.environment !== 'scaled';
    inp.endpoints = selectedEndpoints();
    const est = S.estimate(inp);
    state.est = est;
    const box = $('est-msgs');
    box.textContent = '';
    if (est.error) {
      msg(box, 'err', est.error);
      ['est-tiles', 'est-eps', 'est-tests', 'est-data', 'est-effort', 'est-assume'].forEach(id => { $(id).textContent = ''; });
      $('est-gen').textContent = '';
      return;
    }
    est.warnings.forEach(w => msg(box, 'warn', '⚠️ ' + w));
    const tiles = $('est-tiles');
    tiles.textContent = '';
    const tile = (v, label) => tiles.appendChild(el('div', { class: 'tile' }, el('b', { text: v }), el('span', { text: label })));
    tile(fmt.fmtNum(est.targetRps, 1) + ' req/s', est.scale < 1 ? `target (${Math.round(est.scale * 100)}% of the ${fmt.fmtNum(est.peakRps, 1)} req/s peak)` : 'target at peak');
    tile(fmt.fmtNum(est.vus), 'VUs for the load test');
    tile(fmt.fmtNum(Math.round(est.peakUsers)), 'peak users (Little\'s Law)');
    tile(est.effortDays + ' days', 'estimated effort');

    table($('est-eps'), ['Endpoint', 'Mix', 'Req/s', 'Req/hour', 'p95 target'], est.endpoints.map(e =>
      [e.id, Math.round(e.sharePct) + '%', fmt.fmtNum(e.tps, 2), fmt.fmtNum(e.perHour), e.targetP95Ms ? fmt.fmtMs(e.targetP95Ms) : 'none']));
    table($('est-tests'), ['Test', 'Why', 'Peak load', 'Length', 'Profile', 'Passes when'], est.tests.map(t =>
      [t.type[0].toUpperCase() + t.type.slice(1), t.purpose, `${fmt.fmtNum(t.peakVUs)} VUs · ${fmt.fmtNum(t.peakRps, 1)} req/s`, fmt.fmtDur(t.durationMin), t.profile, t.pass]), [1, 4, 5]);

    const d = est.data, ul = $('est-data');
    ul.textContent = '';
    ul.appendChild(el('li', { text: `About ${fmt.fmtNum(d.requestsPerRound)} requests for one round of all five tests (twice that with a retest).` }));
    if (d.accounts) ul.appendChild(el('li', { text: `${fmt.fmtNum(d.accounts)} test accounts: one per VU at the stress test's peak, plus 10% spare, so sessions don't collide.` }));
    d.writes.forEach(w => ul.appendChild(el('li', { text: `${w.id}: about ${fmt.fmtNum(w.records)} records created or changed per round. Plan the clean-up.` })));
    d.idPools.forEach(p => ul.appendChild(el('li', { text: `${p.id}: a list of at least ${fmt.fmtNum(p.ids)} existing IDs to read.` })));
    $('est-gen').textContent = `Up to ${fmt.fmtNum(est.generator.maxVUs)} VUs and ${fmt.fmtNum(est.generator.maxRps, 1)} req/s (stress test peak). ${est.generator.text}`;
    table($('est-effort'), ['Task', 'Days'], est.effort.map(e => [e.task, e.days]).concat([['Total', est.effortDays]]), [0]);
    const as = $('est-assume');
    as.textContent = '';
    est.assumptions.forEach(a => as.appendChild(el('li', { text: a })));
    renderSlo();
  }

  // ---------------------------------------------------------------- 3. results
  const resIn = $('res-in');
  let resText = '';   // big files and samples are kept here instead of in the textarea

  function slo() {
    const est = state.est && !state.est.error ? state.est : null;
    const i = estInput();
    return { p95Ms: +i.targetP95Ms || 0, errorPct: +i.errorPct || 0, targetRps: est ? est.targetRps : NaN, endpointTargets: est ? S.endpointTargets(est) : {} };
  }
  function renderSlo() {
    const s = slo();
    $('res-slo').textContent = `Judged against: p95 up to ${s.p95Ms ? fmt.fmtMs(s.p95Ms) : 'no limit'}, errors up to ${fmt.fmtPct(s.errorPct)}` +
      (isFinite(s.targetRps) ? `, target ${fmt.fmtNum(s.targetRps, 1)} req/s` : '') + '. Change these in step 2.';
    if (state.results) evaluateAndRender();
  }

  function setResults(r, name) {
    state.results = r; state.resultsName = name || '';
    evaluateAndRender();
  }

  function analyseNow() {
    const box = $('res-msgs');
    const text = resText || resIn.value;
    if (!text.trim()) { state.results = null; box.textContent = ''; $('res-body').textContent = ''; $('res-body').appendChild(el('p', { class: 'note', text: 'Load results above, or try a sample, to see the analysis.' })); renderRecs(); return; }
    try { setResults(S.analyseText(text)); }
    catch (e) { state.results = null; box.textContent = ''; msg(box, 'err', e.message); $('res-body').textContent = ''; renderRecs(); }
  }

  function pill(ok) { return ok === null || ok === undefined ? el('span', { class: 'pill na', text: 'n/a' }) : el('span', { class: 'pill ' + (ok ? 'ok' : 'bad'), text: ok ? 'met' : 'missed' }); }

  function evaluateAndRender() {
    const r = state.results;
    if (!r) return;
    const box = $('res-msgs'), body = $('res-body');
    box.textContent = '';
    r.warnings.forEach(w => msg(box, 'info', w));
    const ev = S.evaluate(r, slo());
    state.ev = ev;
    state.recs = S.recommend(ev);
    body.textContent = '';
    body.appendChild(el('div', { class: 'verdict ' + ev.verdict.code }, el('h3', { text: 'Verdict: ' + ev.verdict.label }), el('p', { text: ev.verdict.text })));
    const T = r.total, s = ev.slo;
    const tiles = el('div', { class: 'tiles' });
    const tile = (v, label, bad) => tiles.appendChild(el('div', { class: 'tile' + (bad ? ' bad' : '') }, el('b', { text: v }), el('span', { text: label })));
    tile(fmt.fmtNum(T.tps, 1) + ' req/s', isFinite(s.targetRps) ? 'target ' + fmt.fmtNum(s.targetRps, 1) : 'throughput', isFinite(s.targetRps) && T.tps < s.targetRps * 0.9);
    tile(fmt.fmtMs(T.p50), 'p50 (median)');
    const p95 = isFinite(T.p95) ? T.p95 : T.p90;
    tile(fmt.fmtMs(p95), (isFinite(T.p95) ? 'p95' : 'p90') + (s.p95Ms ? ' · target ' + fmt.fmtMs(s.p95Ms) : ''), s.p95Ms && p95 > s.p95Ms);
    tile(fmt.fmtMs(T.p99), 'p99');
    tile(fmt.fmtPct(T.errPct), 'errors · limit ' + fmt.fmtPct(s.errorPct), T.errPct > s.errorPct);
    tile(isFinite(r.durationS) ? fmt.fmtDur(r.durationS / 60) : 'n/a', `${fmt.fmtNum(T.count)} requests · ${r.format}`);
    body.appendChild(tiles);

    if (ev.rows.length) {
      body.appendChild(el('h3', { text: 'Per endpoint' }));
      const t = el('table', { class: 'data' });
      table(t, ['Endpoint', 'Requests', 'Req/s', 'vs target', 'p50', 'p90', 'p95', 'p99', 'Errors', 'p95', 'Errors'],
        ev.rows.map(e => [e.name, fmt.fmtNum(e.count), fmt.fmtNum(e.tps, 2), isFinite(e.tpsPct) ? Math.round(e.tpsPct) + '%' : '—', fmt.fmtMs(e.p50), fmt.fmtMs(e.p90),
          fmt.fmtMs(e.p95), fmt.fmtMs(e.p99), fmt.fmtPct(e.errPct), pill(e.p95Ok), pill(e.errOk)]));
      body.appendChild(el('div', { class: 'tbl-wrap' }, t));
    }
    body.appendChild(el('h3', { text: 'Bottleneck signals' }));
    if (ev.signals.length) {
      body.appendChild(el('ul', { class: 'signals' }, ev.signals.map(g => el('li', { class: g.level },
        el('strong', { text: (g.level === 'bad' ? 'Blocking: ' : g.level === 'warn' ? 'Risk: ' : 'Note: ') + g.title }),
        el('div', { class: 'metric', text: g.metric }), g.text ? el('p', { text: g.text }) : null))));
    } else {
      body.appendChild(el('p', { class: 'note', text: 'None found: the targets are met and nothing in these results points at a bottleneck.' }));
    }
    if (!r.timeline) body.appendChild(el('p', { class: 'note', style: 'margin-top:12px', text: 'A k6 summary has totals only, no timeline. To check latency and throughput as load rises, also look at k6\'s web dashboard (K6_WEB_DASHBOARD=true) or load a JMeter file.' }));
    renderRecs();
  }

  document.querySelectorAll('[data-sample]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.sample;
    if (k === 'jtl') {
      resText = S.sampleJtl(); resIn.value = '';
      resIn.placeholder = 'Loaded the JMeter sample (20,000 rows). Paste or upload to replace it.';
      $('res-file-name').textContent = 'sample.jtl';
    } else {
      resText = ''; resIn.value = k === 'k6' ? S.sampleK6() : E.EXAMPLES.exportJson;
      $('res-file-name').textContent = '';
    }
    analyseNow();
    track('perf-studio-sample');
  }));
  $('res-clear').addEventListener('click', () => { resText = ''; resIn.value = ''; resIn.placeholder = 'Paste k6 output or JMeter CSV here, or upload a file.'; $('res-file-name').textContent = ''; analyseNow(); });
  let rtimer;
  resIn.addEventListener('input', () => { resText = ''; $('res-file-name').textContent = ''; clearTimeout(rtimer); rtimer = setTimeout(analyseNow, 300); });
  $('res-file').addEventListener('change', async e => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const box = $('res-msgs');
    box.textContent = '';
    $('res-file-name').textContent = f.name + ' (reading…)';
    try {
      const head = (await f.slice(0, 4096).text()).replace(/^﻿/, '').trimStart();
      const k6 = head[0] === '{' || /http_req_duration|█ /.test(head);
      if (k6) {
        if (f.size > 50 * 1024 * 1024) throw new Error('That k6 file is over 50 MB, which is too big for a summary. Use the end-of-test summary or --summary-export, not the raw --out json stream.');
        resText = await f.text();
        resIn.value = resText.length < 200000 ? resText : '';
        if (resIn.value) resText = '';
        analyseNow();
      } else {
        resText = ''; resIn.value = '';
        const jr = await J.analyseFile(f, {});
        setResults(S.fromJtlResult(jr), f.name);
      }
      $('res-file-name').textContent = f.name;
      track('perf-studio-results-upload');
    } catch (err) {
      $('res-file-name').textContent = f.name;
      state.results = null;
      msg(box, 'err', err.message || String(err));
    }
  });

  // ---------------------------------------------------------------- 4. recommendations
  function renderRecs() {
    const body = $('recs-body');
    body.textContent = '';
    if (!state.results || !state.recs) { body.appendChild(el('p', { class: 'note', text: 'Load results in step 3 first.' })); return; }
    for (const r of state.recs) {
      body.appendChild(el('div', { class: 'panel rec', style: 'margin-top:12px;background:var(--alt)' },
        el('h3', {}, r.title, el('span', { class: 'pill ' + (r.level === 'bad' ? 'bad' : r.level === 'warn' ? 'bad' : 'na'), text: r.area })),
        el('p', { class: 'because' }, el('b', { text: 'Because: ' }), r.because.join(' · ')),
        r.endpoints.length ? el('p', { class: 'because' }, el('b', { text: 'Where: ' }), r.endpoints.join(', ')) : null,
        el('ul', {}, r.actions.map(a => el('li', { text: a })))));
    }
  }

  // ---------------------------------------------------------------- 5. report
  const repForm = $('rep-form');
  try { repForm.elements.date.value = new Date().toISOString().slice(0, 10); } catch (e) { /* old browser */ }
  function reportInput() {
    const f = repForm.elements;
    const d = f.date.value ? new Date(f.date.value + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
    return { results: state.results, evaluation: state.ev, recommendations: state.recs, estimate: state.est && !state.est.error ? state.est : null,
      meta: { project: f.project.value.trim(), release: f.release.value.trim(), environment: f.environment.value.trim(), date: d } };
  }
  function renderReport() {
    const body = $('rep-body');
    body.textContent = '';
    $('rep-btns').hidden = !state.results;
    if (!state.results || !state.ev) { body.appendChild(el('p', { class: 'note', text: 'Load results in step 3 first.' })); return; }
    const frame = el('iframe', { class: 'report-frame', title: 'Report preview', sandbox: 'allow-same-origin allow-modals' });
    frame.srcdoc = S.reportHtml(reportInput());
    frame.addEventListener('load', () => {
      try { frame.style.height = (frame.contentDocument.documentElement.scrollHeight + 4) + 'px'; } catch (e) { /* keep min-height */ }
    });
    body.appendChild(frame);
  }
  let reptimer;
  repForm.addEventListener('input', () => { clearTimeout(reptimer); reptimer = setTimeout(renderReport, 300); });
  const fileBase = () => (repForm.elements.project.value.trim() || 'load-test').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-report';
  $('rep-print').addEventListener('click', () => {
    const f = document.querySelector('#rep-body iframe');
    if (!f) return;
    try { f.contentWindow.focus(); f.contentWindow.print(); }
    catch (e) { download(fileBase() + '.html', S.reportHtml(reportInput()), 'text/html'); }
    track('perf-studio-report-print');
  });
  $('rep-html').addEventListener('click', () => { if (state.results) download(fileBase() + '.html', S.reportHtml(reportInput()), 'text/html'); });
  $('rep-md').addEventListener('click', () => { if (state.results) download(fileBase() + '.md', S.reportMarkdown(reportInput()), 'text/markdown'); });

  // ---------------------------------------------------------------- wiring
  function refresh() { readSpec(); renderEstimate(); renderScript(); }
  let timer;
  function later() { clearTimeout(timer); timer = setTimeout(refresh, 250); }
  specIn.addEventListener('input', later);
  estForm.addEventListener('input', later);
  estForm.addEventListener('change', refresh);

  refresh();
})();
