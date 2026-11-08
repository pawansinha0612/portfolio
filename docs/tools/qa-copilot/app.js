/* UI for /tools/qa-copilot/. All logic lives in qa.js (window.QACopilot). Nothing is uploaded; the coverage
   tracker and the last values of each form are kept in this browser's localStorage. */
(function () {
  'use strict';
  const Q = window.QACopilot;
  const $ = id => document.getElementById(id);
  const esc = Q.esc;
  const n = x => Number(x).toLocaleString('en-AU', { maximumFractionDigits: 1 });
  const store = {
    get(k, d) { try { const v = localStorage.getItem('qa-copilot:' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('qa-copilot:' + k, JSON.stringify(v)); } catch (e) { /* private mode: keep working without saving */ } },
  };
  const docs = { strategy: '', report: '' };

  // ------------------------------------------------------------------ tabs
  const tabs = Array.from(document.querySelectorAll('.tabs [role=tab]'));
  function showTab(id, push) {
    if (!$(id)) id = 'scenarios';
    tabs.forEach(t => t.setAttribute('aria-selected', String(t.getAttribute('aria-controls') === id)));
    document.querySelectorAll('.tabpanel').forEach(p => { p.hidden = p.id !== id; });
    if (push) history.replaceState(null, '', '#' + id);
    if (id === 'coverage') renderCoverage();
    if (id === 'estimate') renderEstimate();
    if (id === 'risk') renderRisk();
  }
  tabs.forEach(t => t.addEventListener('click', () => showTab(t.getAttribute('aria-controls'), true)));
  tabs.forEach((t, i) => t.addEventListener('keydown', e => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const nx = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    nx.focus(); nx.click();
  }));

  function flash(el, msg) { if (!el) return; el.textContent = msg; setTimeout(() => { el.textContent = ''; }, 2500); }
  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: (type || 'text/plain') + ';charset=utf-8' }));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  async function copy(text, msgEl, fallbackName) {
    try { await navigator.clipboard.writeText(text); flash(msgEl, 'Copied'); }
    catch (e) { download(fallbackName, text, 'text/markdown'); flash(msgEl, 'Downloaded'); }
  }
  const readFile = f => (f.text ? f.text() : new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsText(f); }));

  // ================================================================== (a) scenarios
  const REQ_SAMPLES = {
    stories: `SHOP-381 As a registered customer, I want to reset my password so that I can sign in again.
Acceptance criteria:
- The reset link is emailed and expires after 30 minutes
- The new password must be between 8 and 64 characters
- The last 5 passwords cannot be reused

SHOP-382 As a customer, I want to add products to my cart so that I can buy several items at once.
Acceptance criteria:
- A cart can hold no more than 50 items
- Quantity per product must be between 1 and 10
- The cart total updates within 1 second

SHOP-390 As a store admin, I want to issue a refund so that customers get their money back for returned orders.
Acceptance criteria:
- Only admins can issue refunds
- Refunds over $500 need a second approver
- The customer receives an email receipt`,
    gherkin: `Feature: Checkout

Background:
  Given a signed-in customer with 2 items in the cart

Scenario: Pay with a saved card
  When they pay with their saved Visa card
  Then the order is confirmed
  And an email receipt is sent

Scenario: Apply a discount code
  When they enter a discount code of up to 12 characters
  Then the discount is applied to the total

Scenario: Guest checkout is blocked for restricted items
  Given the cart contains an age-restricted item
  When a guest tries to check out
  Then they must sign in and confirm they are 18 or older`,
    plain: `Registration
REQ-1 The username must be between 3 and 20 characters.
REQ-2 The email address must be unique.
REQ-3 Users must be at least 16 years old.
REQ-4 The registration API endpoint shall return 400 for a missing email field.
Search
REQ-5 Search results should load within 2 seconds for up to 500 concurrent users.
REQ-6 Guests must not see wholesale prices.`,
  };
  let reqs = [], scen = [], filterType = '';
  const typesBox = $('types');
  typesBox.innerHTML = Q.TYPES.map(t => '<label><input type="checkbox" value="' + esc(t) + '" checked> ' + esc(t) + '</label>').join('');
  document.querySelectorAll('[data-req]').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('[data-req]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    $('req-in').value = REQ_SAMPLES[b.dataset.req];
    generate();
  }));
  $('gen').addEventListener('click', generate);
  $('req-in').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) generate(); });
  $('req-clear').addEventListener('click', () => { $('req-in').value = ''; $('scen-out').hidden = true; reqs = []; scen = []; });

  function generate() {
    const err = $('req-err');
    err.hidden = true;
    reqs = Q.parseRequirements($('req-in').value);
    if (!reqs.length) { err.textContent = 'Paste at least one requirement, user story or Gherkin scenario.'; err.hidden = false; return; }
    const types = Array.from(typesBox.querySelectorAll('input:checked')).map(i => i.value);
    scen = Q.generateScenarios(reqs, { types });
    filterType = '';
    renderScenarios();
    $('scen-out').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderScenarios() {
    const out = $('scen-out');
    const counts = {};
    scen.forEach(s => { counts[s.type] = (counts[s.type] || 0) + 1; });
    let h = '<div class="verdict pass"><h2>' + scen.length + ' scenarios from ' + reqs.length + ' requirement' + (reqs.length === 1 ? '' : 's') + '</h2><p>' +
      Object.keys(counts).map(k => esc(k) + ' ' + counts[k]).join(' · ') + '</p><p class="fmt">A first draft: edit titles, steps and expected results in the table, delete what you don\'t need, then export.</p></div>';
    h += '<div class="block"><details><summary style="cursor:pointer;font-weight:600">Requirements found (' + reqs.length + ')</summary><ul class="reqlist">' +
      reqs.map(r => '<li><b>' + esc(r.id) + '</b> <span class="tp">' + esc(r.type) + '</span> ' + esc(r.title) + (r.criteria && r.criteria.length ? ' <span class="hint">(' + r.criteria.length + ' criteria)</span>' : '') +
        (Q.detectBoundaries(r.text).length ? ' <span class="hint">· boundaries: ' + esc(Q.detectBoundaries(r.text).map(Q.describeBoundary).join('; ')) + '</span>' : '') + '</li>').join('') + '</ul></details></div>';
    h += '<div class="block"><div class="block-head"><h3>Scenarios</h3><label class="field">Show <select id="sc-filter"><option value="">All types</option>' + Object.keys(counts).map(k => '<option' + (k === filterType ? ' selected' : '') + '>' + esc(k) + '</option>').join('') + '</select></label></div>' +
      '<div class="tbl-wrap"><table class="data edit"><thead><tr><th>ID</th><th>Scenario</th><th>Steps</th><th>Expected result</th><th>Priority</th><th><span class="sr-only">Delete</span></th></tr></thead><tbody>' +
      scen.map((s, i) => (filterType && s.type !== filterType) ? '' : '<tr data-i="' + i + '"><td><span class="mono" style="font:500 12px JetBrains Mono,monospace">' + esc(s.id) + '</span><br><span class="tp">' + esc(s.type) + '</span></td>' +
        '<td><input class="cell" data-k="title" aria-label="Scenario title" value="' + esc(s.title) + '">' + (s.pre ? '<span class="hint" style="display:block;margin-top:4px">Pre: ' + esc(s.pre) + '</span>' : '') + '</td>' +
        '<td><textarea class="cell" data-k="steps" aria-label="Steps">' + esc(s.steps) + '</textarea></td>' +
        '<td><textarea class="cell" data-k="expected" aria-label="Expected result">' + esc(s.expected) + '</textarea></td>' +
        '<td><select class="cell" data-k="priority" aria-label="Priority">' + ['High', 'Medium', 'Low'].map(p => '<option' + (p === s.priority ? ' selected' : '') + '>' + p + '</option>').join('') + '</select></td>' +
        '<td><button class="x" type="button" data-del="' + i + '" aria-label="Delete ' + esc(s.id) + '">✕</button></td></tr>').join('') +
      '</tbody></table></div>' +
      '<div class="exports"><button class="btn btn-ghost btn-small" type="button" id="sc-add">Add a scenario</button>' +
      '<button class="btn btn-ghost btn-small" type="button" id="sc-csv">Download CSV (Zephyr / Xray)</button>' +
      '<button class="btn btn-ghost btn-small" type="button" id="sc-feat">Download .feature (Gherkin)</button>' +
      '<button class="btn btn-ghost btn-small" type="button" id="sc-copy">Copy Gherkin</button>' +
      '<button class="btn btn-ghost btn-small" type="button" id="sc-cov">Send to coverage tracker →</button><span class="copied" id="sc-msg" aria-live="polite"></span></div></div>';
    out.innerHTML = h;
    out.hidden = false;
    out.querySelectorAll('.cell').forEach(c => c.addEventListener(c.tagName === 'SELECT' ? 'change' : 'input', () => { scen[+c.closest('tr').dataset.i][c.dataset.k] = c.value; }));
    out.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => { scen.splice(+b.dataset.del, 1); renderScenarios(); }));
    $('sc-filter').addEventListener('change', e => { filterType = e.target.value; renderScenarios(); });
    $('sc-add').addEventListener('click', () => {
      const r = reqs[0] || { id: 'REQ-001', title: '' };
      const nums = scen.filter(s => s.reqId === r.id).map(s => +(/TC(\d+)$/.exec(s.id) || [0, 0])[1]);
      scen.push({ id: r.id + '-TC' + String((nums.length ? Math.max(...nums) : 0) + 1).padStart(2, '0'), reqId: r.id, reqTitle: r.title, type: filterType || 'Negative', title: 'New scenario', pre: '', steps: '', expected: '', priority: 'Medium', data: '' });
      renderScenarios();
    });
    $('sc-csv').addEventListener('click', () => download('test-scenarios.csv', Q.scenariosToCSV(scen), 'text/csv'));
    $('sc-feat').addEventListener('click', () => download('scenarios.feature', Q.scenariosToGherkin(scen, reqs), 'text/plain'));
    $('sc-copy').addEventListener('click', () => copy(Q.scenariosToGherkin(scen, reqs), $('sc-msg'), 'scenarios.feature'));
    $('sc-cov').addEventListener('click', () => { addScenariosToCoverage(); showTab('coverage', true); });
  }

  // ================================================================== (b) strategy
  const ENVS = ['Dev', 'Test', 'Staging', 'UAT', 'Performance', 'Production'];
  const LEVELS = Object.keys(Q.LEVEL_TEXT);
  $('st-envs').innerHTML = ENVS.map(e => '<label><input type="checkbox" value="' + e + '"' + (['Dev', 'Test', 'Staging', 'Production'].indexOf(e) >= 0 ? ' checked' : '') + '> ' + e + '</label>').join('');
  $('st-levels').innerHTML = LEVELS.map(l => '<label><input type="checkbox" value="' + l + '"' + (['unit', 'integration', 'api', 'ui', 'regression', 'exploratory'].indexOf(l) >= 0 ? ' checked' : '') + '> ' + esc(Q.LEVEL_TEXT[l][0]) + '</label>').join('');
  const stFields = ['st-project', 'st-type', 'st-risk', 'st-team', 'st-cadence', 'st-owner', 'st-tools', 'st-in', 'st-out'];
  (function restore() {
    const s = store.get('strategy', null);
    if (!s) return;
    stFields.forEach(id => { if (s[id] != null) $(id).value = s[id]; });
    if (s.envs) $('st-envs').querySelectorAll('input').forEach(i => { i.checked = s.envs.indexOf(i.value) >= 0; });
    if (s.levels) $('st-levels').querySelectorAll('input').forEach(i => { i.checked = s.levels.indexOf(i.value) >= 0; });
  })();
  $('st-sample').addEventListener('click', () => {
    $('st-project').value = 'Online store checkout'; $('st-type').value = 'web'; $('st-risk').value = 'high'; $('st-team').value = 4; $('st-cadence').value = 'weekly'; $('st-owner').value = 'Alex Chen (QA lead)';
    $('st-tools').value = 'Jira with Zephyr Scale\nPlaywright for UI and API automation\nk6 for load testing\nGitHub Actions for CI/CD';
    $('st-in').value = 'Cart, checkout and payment\nCustomer accounts and password reset\nOrder confirmation emails';
    $('st-out').value = 'Payment gateway internals (covered by the provider)\nWarehouse system beyond its API';
    $('st-envs').querySelectorAll('input').forEach(i => { i.checked = ['Dev', 'Test', 'Staging', 'Production'].indexOf(i.value) >= 0; });
    $('st-levels').querySelectorAll('input').forEach(i => { i.checked = ['unit', 'integration', 'api', 'ui', 'performance', 'security', 'accessibility', 'regression', 'exploratory'].indexOf(i.value) >= 0; });
    writeStrategy();
  });
  $('st-go').addEventListener('click', writeStrategy);
  function writeStrategy() {
    const checked = box => Array.from($(box).querySelectorAll('input:checked')).map(i => i.value);
    const saved = {}; stFields.forEach(id => { saved[id] = $(id).value; }); saved.envs = checked('st-envs'); saved.levels = checked('st-levels');
    store.set('strategy', saved);
    docs.strategy = Q.buildStrategy({
      project: $('st-project').value, type: $('st-type').value, risk: $('st-risk').value, teamSize: $('st-team').value, cadence: $('st-cadence').value,
      environments: saved.envs, levels: saved.levels, tools: $('st-tools').value, inScope: $('st-in').value, outScope: $('st-out').value,
      author: $('st-owner').value, version: '0.1', date: new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' }),
    });
    $('st-doc').innerHTML = Q.markdownToHtml(docs.strategy);
    $('st-doc').hidden = false; $('st-x').hidden = false;
    $('st-doc').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ================================================================== (c) estimate
  const D = Q.EST_DEFAULTS;
  const EST_FIELDS = [
    ['simple', 'Simple scenarios', 'count'], ['medium', 'Medium scenarios', 'count'], ['complex', 'Complex scenarios', 'count'],
    ['designMins.simple', 'Design: simple (min)', 'minutes to write and review one'], ['designMins.medium', 'Design: medium (min)', ''], ['designMins.complex', 'Design: complex (min)', ''],
    ['execMins.simple', 'Run: simple (min)', 'minutes to run one by hand'], ['execMins.medium', 'Run: medium (min)', ''], ['execMins.complex', 'Run: complex (min)', ''],
    ['cycles', 'Execution cycles', 'full test cycles planned'], ['failPct', 'Failure rate %', 'share of runs that find a defect'], ['retestPct', 'Retest %', 'share of failures retested'],
    ['automationPct', 'Automation %', 'share of scenarios automated'], ['autoHours.simple', 'Automate: simple (h)', 'hours to automate one'], ['autoHours.medium', 'Automate: medium (h)', ''], ['autoHours.complex', 'Automate: complex (h)', ''],
    ['envHours', 'Environment and data setup (h)', ''], ['regressionCycles', 'Regression cycles', ''], ['regressionPct', 'Regression suite %', 'share of scenarios in regression'],
    ['mgmtPct', 'Management and reporting %', 'overhead on top'], ['hoursPerDay', 'Hours per person-day', '7.6 = 38-hour week'],
  ];
  const getPath = (o, p) => p.split('.').reduce((a, k) => (a ? a[k] : undefined), o);
  const setPath = (o, p, v) => { const ks = p.split('.'); let x = o; ks.slice(0, -1).forEach(k => { x = x[k] = x[k] || {}; }); x[ks[ks.length - 1]] = v; };
  let est = store.get('estimate', null) || JSON.parse(JSON.stringify(D));
  function buildEstForm() {
    $('es-form').innerHTML = EST_FIELDS.map(([k, label, hint]) => '<label class="f"><span>' + esc(label) + '</span><input type="number" min="0" step="any" inputmode="decimal" data-ek="' + k + '" value="' + esc(getPath(est, k)) + '">' + (hint ? '<small>' + esc(hint) + '</small>' : '') + '</label>').join('') +
      '<label class="f"><span>Uncertainty</span><select data-ek="uncertainty"><option value="low">Low: known system, stable scope</option><option value="medium">Medium: some unknowns</option><option value="high">High: new system or vague scope</option></select><small>sets the optimistic and pessimistic range</small></label>';
    $('es-form').querySelector('[data-ek=uncertainty]').value = est.uncertainty || 'medium';
    $('es-form').querySelectorAll('[data-ek]').forEach(i => i.addEventListener('input', () => { setPath(est, i.dataset.ek, i.tagName === 'SELECT' ? i.value : (i.value === '' ? 0 : +i.value)); store.set('estimate', est); renderEstimate(); }));
  }
  buildEstForm();
  $('es-reset').addEventListener('click', () => { est = JSON.parse(JSON.stringify(D)); store.set('estimate', est); buildEstForm(); renderEstimate(); });
  $('es-from').addEventListener('click', () => {
    if (!scen.length) { $('es-out').innerHTML = '<p class="err">Generate scenarios in tab 1 first.</p>'; return; }
    const cx = { simple: 0, medium: 0, complex: 0 };
    scen.forEach(s => { cx[/Boundary|Equivalence|Empty/.test(s.type) ? 'simple' : /Performance|Security/.test(s.type) ? 'complex' : 'medium']++; });
    Object.assign(est, cx); store.set('estimate', est); buildEstForm(); renderEstimate();
  });
  let lastEstimate = null;
  function renderEstimate() {
    const e = lastEstimate = Q.estimate(est);
    const out = $('es-out');
    if (!e.scenarios) { out.innerHTML = '<p class="hint">Enter how many scenarios you expect.</p>'; return; }
    out.innerHTML = '<div class="verdict"><h2>Plan for ' + n(e.days.p95) + ' person-days (' + n(e.p95) + ' hours)</h2><p>That is the 95% confidence figure for ' + n(e.scenarios) + ' scenarios. Expected effort is ' + n(e.expected) + ' hours (' + n(e.days.expected) + ' days); the difference, ' + n(e.contingency) + ' hours (' + e.contingencyPct + '% of the most likely), is your contingency.</p></div>' +
      '<div class="ja-stats"><div class="ja-stat"><b>' + n(e.optimistic) + ' h</b><span>Optimistic (O)</span></div><div class="ja-stat"><b>' + n(e.mostLikely) + ' h</b><span>Most likely (M)</span></div><div class="ja-stat"><b>' + n(e.pessimistic) + ' h</b><span>Pessimistic (P)</span></div>' +
      '<div class="ja-stat"><b>' + n(e.expected) + ' h</b><span>PERT expected</span></div><div class="ja-stat"><b>±' + n(e.sd) + ' h</b><span>Standard deviation</span></div><div class="ja-stat warn"><b>' + n(e.p84) + ' h</b><span>84% confidence (E + σ)</span></div></div>' +
      '<div class="block"><div class="block-head"><h3>Breakdown (most likely)</h3></div><div class="tbl-wrap"><table class="data"><thead><tr><th class="l">Activity</th><th>Hours</th><th>Days</th><th>Share</th></tr></thead><tbody>' +
      e.rows.map(r => '<tr><td>' + esc(r.task) + '</td><td>' + n(r.hours) + '</td><td>' + n(r.hours / e.hoursPerDay) + '</td><td>' + (e.mostLikely ? Math.round(r.hours / e.mostLikely * 100) : 0) + '%</td></tr>').join('') +
      '<tr class="total"><td>Total (M)</td><td>' + n(e.mostLikely) + '</td><td>' + n(e.days.mostLikely) + '</td><td>100%</td></tr></tbody></table></div>' +
      '<p class="hint">PERT: E = (O + 4M + P) / 6 = (' + n(e.optimistic) + ' + 4 × ' + n(e.mostLikely) + ' + ' + n(e.pessimistic) + ') / 6 = ' + n(e.expected) + ' h. σ = (P − O) / 6. Automated scenarios still cost 10% of their manual run time each cycle for reviewing results and fixing scripts.</p></div>';
  }

  // ================================================================== (d) coverage
  let model = store.get('coverage', { reqs: [], tests: [] });
  const saveModel = () => store.set('coverage', model);
  const COV_SAMPLE = {
    reqs: [{ id: 'SHOP-381', title: 'Reset password' }, { id: 'SHOP-382', title: 'Add to cart' }, { id: 'SHOP-383', title: 'Apply discount code' }, { id: 'SHOP-384', title: 'Pay with saved card' }, { id: 'SHOP-385', title: 'Order confirmation email' }, { id: 'SHOP-390', title: 'Issue a refund' }],
    tests: [
      { id: 'TC-101', title: 'Reset link emailed', reqs: ['SHOP-381'], status: 'pass' }, { id: 'TC-102', title: 'Expired link rejected', reqs: ['SHOP-381'], status: 'pass' },
      { id: 'TC-103', title: 'Password length boundaries', reqs: ['SHOP-381'], status: 'fail' }, { id: 'TC-110', title: 'Add one item', reqs: ['SHOP-382'], status: 'pass' },
      { id: 'TC-111', title: 'Cart limit of 50 items', reqs: ['SHOP-382'], status: 'pass' }, { id: 'TC-120', title: 'Valid discount code', reqs: ['SHOP-383'], status: 'blocked' },
      { id: 'TC-130', title: 'Saved Visa card', reqs: ['SHOP-384'], status: 'pass' }, { id: 'TC-131', title: 'Declined card', reqs: ['SHOP-384'], status: 'not run' },
      { id: 'TC-140', title: 'Receipt email content', reqs: ['SHOP-385', 'SHOP-384'], status: 'pass' },
    ],
  };
  function addScenariosToCoverage() {
    reqs.forEach(r => { if (!model.reqs.some(x => x.id.toLowerCase() === r.id.toLowerCase())) model.reqs.push({ id: r.id, title: r.title.slice(0, 120) }); });
    scen.forEach(s => { if (!model.tests.some(x => x.id.toLowerCase() === s.id.toLowerCase())) model.tests.push({ id: s.id, title: s.title, reqs: [s.reqId], status: 'not run' }); });
    saveModel();
  }
  $('cv-sample').addEventListener('click', () => { model = JSON.parse(JSON.stringify(COV_SAMPLE)); saveModel(); renderCoverage(); });
  $('cv-from').addEventListener('click', () => { if (!scen.length) { flash($('cv-msg'), 'Generate scenarios in tab 1 first'); return; } addScenariosToCoverage(); renderCoverage(); flash($('cv-msg'), 'Added ' + scen.length + ' scenarios'); });
  $('cv-radd').addEventListener('click', () => {
    const id = $('cv-rid').value.trim(); if (!id) { $('cv-rid').focus(); return; }
    if (!model.reqs.some(r => r.id.toLowerCase() === id.toLowerCase())) model.reqs.push({ id, title: $('cv-rtitle').value.trim() });
    $('cv-rid').value = ''; $('cv-rtitle').value = ''; saveModel(); renderCoverage(); $('cv-rid').focus();
  });
  $('cv-tadd').addEventListener('click', () => {
    const id = $('cv-tid').value.trim() || 'TC-' + String(model.tests.length + 1).padStart(3, '0');
    if (!model.tests.some(t => t.id.toLowerCase() === id.toLowerCase())) model.tests.push({ id, title: $('cv-ttitle').value.trim(), reqs: $('cv-treqs').value.split(/[,;\s]+/).filter(Boolean), status: 'not run' });
    $('cv-tid').value = ''; $('cv-ttitle').value = ''; saveModel(); renderCoverage(); $('cv-tid').focus();
  });
  ['cv-rtitle', 'cv-rid'].forEach(id => $(id).addEventListener('keydown', e => { if (e.key === 'Enter') $('cv-radd').click(); }));
  ['cv-ttitle', 'cv-tid', 'cv-treqs'].forEach(id => $(id).addEventListener('keydown', e => { if (e.key === 'Enter') $('cv-tadd').click(); }));
  $('cv-csv').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    const r = Q.importResults(model, await readFile(f));
    e.target.value = '';
    if (r.error) { flash($('cv-msg'), r.error); return; }
    model = r.model; saveModel(); renderCoverage();
    flash($('cv-msg'), 'Updated ' + r.updated + ', added ' + r.added + (r.skipped ? ', skipped ' + r.skipped : ''));
  });
  $('cv-xcsv').addEventListener('click', () => download('coverage.csv', Q.coverageToCSV(model), 'text/csv'));
  $('cv-xjson').addEventListener('click', () => download('qa-coverage-backup.json', JSON.stringify(model, null, 2), 'application/json'));
  $('cv-ijson').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    try { const m = JSON.parse(await readFile(f)); if (!Array.isArray(m.reqs) || !Array.isArray(m.tests)) throw new Error('bad'); model = m; saveModel(); renderCoverage(); flash($('cv-msg'), 'Backup loaded'); }
    catch (err) { flash($('cv-msg'), 'That file is not a coverage backup'); }
    e.target.value = '';
  });
  $('cv-clear').addEventListener('click', () => { if (!model.reqs.length && !model.tests.length) return; if (!confirm('Remove all requirements and tests from the tracker?')) return; model = { reqs: [], tests: [] }; saveModel(); renderCoverage(); });

  const STL = { pass: 'Pass', fail: 'Fail', blocked: 'Blocked', 'not run': 'Not run', uncovered: 'No tests', 'in progress': 'In progress' };
  const stc = s => 'st-' + s.replace(/\s+/g, '');
  let lastCoverage = null;
  function renderCoverage() {
    const c = lastCoverage = Q.coverage(model);
    $('cv-reqs').innerHTML = model.reqs.length ? '<div class="tbl-wrap" style="margin-top:10px"><table class="data"><thead><tr><th class="l">Requirement</th><th class="l">Status</th><th>Tests</th><th></th></tr></thead><tbody>' +
      c.rows.map((r, i) => '<tr><td><b>' + esc(r.id) + '</b> ' + esc(r.title) + '</td><td class="l ' + stc(r.status) + '">' + STL[r.status] + '</td><td>' + r.tests.length + '</td><td><button class="x" type="button" data-rdel="' + i + '" aria-label="Remove ' + esc(r.id) + '">✕</button></td></tr>').join('') + '</tbody></table></div>' : '<p class="hint">No requirements yet.</p>';
    $('cv-tests').innerHTML = model.tests.length ? '<div class="tbl-wrap" style="margin-top:10px"><table class="data edit"><thead><tr><th>Test</th><th>Covers</th><th>Status</th><th></th></tr></thead><tbody>' +
      model.tests.map((t, i) => '<tr><td><b class="mono" style="font:600 12px JetBrains Mono,monospace">' + esc(t.id) + '</b><br><span class="hint">' + esc(t.title || '') + '</span></td><td><input class="cell" style="min-width:110px" data-tr="' + i + '" value="' + esc((t.reqs || []).join(', ')) + '" aria-label="Requirements covered by ' + esc(t.id) + '"></td>' +
        '<td><select class="cell" data-ts="' + i + '" aria-label="Status of ' + esc(t.id) + '">' + Q.STATUSES.map(s => '<option value="' + s + '"' + (Q.normaliseStatus(t.status) === s ? ' selected' : '') + '>' + STL[s] + '</option>').join('') + '</select></td>' +
        '<td><button class="x" type="button" data-tdel="' + i + '" aria-label="Remove ' + esc(t.id) + '">✕</button></td></tr>').join('') + '</tbody></table></div>' : '<p class="hint">No tests yet.</p>';
    document.querySelectorAll('[data-rdel]').forEach(b => b.addEventListener('click', () => { model.reqs.splice(+b.dataset.rdel, 1); saveModel(); renderCoverage(); }));
    document.querySelectorAll('[data-tdel]').forEach(b => b.addEventListener('click', () => { model.tests.splice(+b.dataset.tdel, 1); saveModel(); renderCoverage(); }));
    document.querySelectorAll('[data-ts]').forEach(s => s.addEventListener('change', () => { model.tests[+s.dataset.ts].status = s.value; saveModel(); renderCoverage(); }));
    document.querySelectorAll('[data-tr]').forEach(s => s.addEventListener('change', () => { model.tests[+s.dataset.tr].reqs = s.value.split(/[,;\s]+/).filter(Boolean); saveModel(); renderCoverage(); }));

    const out = $('cv-out');
    if (!model.reqs.length && !model.tests.length) { out.innerHTML = ''; return; }
    const cls = c.uncovered.length || c.fail ? 'fail' : c.notRun || c.blocked ? 'warn' : 'pass';
    let h = '<div class="verdict ' + cls + '"><h2>' + c.coveragePct + '% of requirements covered, ' + (c.executed ? c.passPct + '% of executed tests passing' : 'no tests run yet') + '</h2><p>' +
      c.covered + ' of ' + c.reqTotal + ' requirements have a test. ' + c.executed + ' of ' + c.testTotal + ' tests run (' + c.executedPct + '%).' + (c.uncovered.length ? ' No tests: ' + esc(c.uncovered.slice(0, 12).join(', ')) + (c.uncovered.length > 12 ? '…' : '') + '.' : '') + '</p></div>' +
      '<div class="ja-stats"><div class="ja-stat"><b>' + c.pass + '</b><span>Passed</span></div><div class="ja-stat' + (c.fail ? ' bad' : '') + '"><b>' + c.fail + '</b><span>Failed</span></div><div class="ja-stat' + (c.blocked ? ' warn' : '') + '"><b>' + c.blocked + '</b><span>Blocked</span></div><div class="ja-stat"><b>' + c.notRun + '</b><span>Not run</span></div>' +
      '<div class="ja-stat' + (c.uncovered.length ? ' bad' : '') + '"><b>' + c.uncovered.length + '</b><span>Requirements with no test</span></div>' + (c.orphanTests.length ? '<div class="ja-stat warn"><b>' + c.orphanTests.length + '</b><span>Tests linked to no known requirement</span></div>' : '') + '</div>';
    if (model.reqs.length && model.tests.length) {
      const cols = model.tests.slice(0, 40);
      const sym = { pass: '✓', fail: '✗', blocked: '!', 'not run': '○' };
      h += '<div class="block"><div class="block-head"><h3>Traceability matrix</h3><span class="hint">' + (model.tests.length > 40 ? 'first 40 tests shown · ' : '') + '✓ pass · ✗ fail · ! blocked · ○ not run</span></div><div class="tbl-wrap"><table class="data matrix"><thead><tr><th>Requirement</th>' +
        cols.map(t => '<th class="rot" title="' + esc(t.title || '') + '">' + esc(t.id) + '</th>').join('') + '</tr></thead><tbody>' +
        c.rows.map(r => '<tr><td><b>' + esc(r.id) + '</b> <span class="' + stc(r.status) + '">' + STL[r.status] + '</span></td>' + cols.map(t => {
          const linked = (t.reqs || []).some(x => x.toLowerCase() === r.id.toLowerCase());
          const s = Q.normaliseStatus(t.status);
          return '<td class="' + (linked ? stc(s) : '') + '">' + (linked ? sym[s] : '') + '</td>';
        }).join('') + '</tr>').join('') + '</tbody></table></div></div>';
    }
    out.innerHTML = h;
  }

  // ================================================================== (e) release risk
  let risk = store.get('risk', { checklist: {}, critical: 0, high: 1, medium: 4, low: 6, coverage: '', passRate: '', flakyRate: 2, changeSize: 'medium' });
  $('rk-checks').innerHTML = Q.CHECKLIST.map(c => '<li><span>' + esc(c.label) + ' <span class="hint">(weight ' + c.weight + ')</span></span><select data-ck="' + c.id + '" aria-label="' + esc(c.label) + '"><option value="no">Not done</option><option value="yes">Done</option><option value="na">Not applicable</option></select></li>').join('');
  const RK_FIELDS = [['critical', 'Open critical defects'], ['high', 'Open high defects'], ['medium', 'Open medium defects'], ['low', 'Open low defects'], ['coverage', 'Requirement coverage %'], ['passRate', 'Test pass rate %'], ['flakyRate', 'Flaky test rate %']];
  $('rk-form').innerHTML = RK_FIELDS.map(([k, l]) => '<label class="f"><span>' + l + '</span><input type="number" min="0" step="any" inputmode="decimal" data-rk="' + k + '"></label>').join('') +
    '<label class="f"><span>Size of the change</span><select data-rk="changeSize"><option value="small">Small: a few fixes</option><option value="medium">Medium: a normal release</option><option value="large">Large: major features or re-platform</option></select></label>';
  function fillRisk() {
    document.querySelectorAll('[data-ck]').forEach(s => { const v = risk.checklist[s.dataset.ck]; s.value = v === true ? 'yes' : v || 'no'; });
    document.querySelectorAll('[data-rk]').forEach(i => { i.value = risk[i.dataset.rk] == null ? '' : risk[i.dataset.rk]; });
  }
  fillRisk();
  document.querySelectorAll('[data-ck]').forEach(s => s.addEventListener('change', () => { risk.checklist[s.dataset.ck] = s.value; store.set('risk', risk); renderRisk(); }));
  document.querySelectorAll('[data-rk]').forEach(i => i.addEventListener('input', () => { risk[i.dataset.rk] = i.value; store.set('risk', risk); renderRisk(); }));
  $('rk-from').addEventListener('click', () => {
    const c = Q.coverage(model);
    if (!c.reqTotal) { $('rk-out').insertAdjacentHTML('afterbegin', '<p class="err">Add requirements and tests in tab 4 first.</p>'); return; }
    risk.coverage = c.coveragePct; risk.passRate = c.executed ? c.passPct : ''; store.set('risk', risk); fillRisk(); renderRisk();
  });
  $('rk-sample').addEventListener('click', () => {
    risk = { checklist: { regression: 'yes', uat: 'yes', perf: 'no', security: 'yes', rollback: 'no', monitoring: 'yes', migration: 'na', flags: 'yes', smoke: 'yes', support: 'no' }, critical: 0, high: 2, medium: 5, low: 9, coverage: 92, passRate: 96.5, flakyRate: 4, changeSize: 'large' };
    store.set('risk', risk); fillRisk(); renderRisk();
  });
  let lastRisk = null;
  function renderRisk() {
    const r = lastRisk = Q.riskScore(risk);
    const cls = r.decision === 'Go' ? 'pass' : r.decision === 'No-go' ? 'fail' : 'warn';
    $('rk-out').innerHTML = '<div class="verdict ' + cls + '"><h2>' + esc(r.decision) + ': risk ' + r.score + '/100 (' + esc(r.level) + ')</h2><p>' + esc(r.advice) + '</p>' +
      '<div class="meter" role="img" aria-label="Risk score ' + r.score + ' out of 100"><i style="left:' + r.score + '%"></i></div><div class="meter-lbl"><span>0 low</span><span>30</span><span>60</span><span>100 very high</span></div></div>' +
      '<div class="ja-stats"><div class="ja-stat"><b>' + r.parts.checklist + '</b><span>Checklist (max 35)</span></div><div class="ja-stat' + (r.parts.defects >= 15 ? ' bad' : '') + '"><b>' + r.parts.defects + '</b><span>Open defects (max 30)</span></div>' +
      '<div class="ja-stat"><b>' + r.parts.coverage + '</b><span>Coverage gap (max 15)</span></div><div class="ja-stat"><b>' + r.parts.passRate + '</b><span>Failed tests (max 10)</span></div><div class="ja-stat"><b>' + r.parts.flaky + '</b><span>Flaky tests (max 10)</span></div><div class="ja-stat"><b>' + r.parts.size + '</b><span>Change size (max 5)</span></div></div>' +
      (r.reasons.length ? '<div class="block"><div class="block-head"><h3>Reasons, biggest first</h3></div><ol class="reasons">' + r.reasons.map(x => '<li>' + esc(x.text) + ' <em>+' + x.points + '</em></li>').join('') + '</ol></div>' : '');
  }

  // ================================================================== (f) report
  const rp = store.get('report', {});
  ['rp-project', 'rp-release', 'rp-author', 'rp-notes'].forEach(id => { if (rp[id]) $(id).value = rp[id]; });
  $('rp-date').value = new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
  if (!$('rp-project').value && $('st-project').value) $('rp-project').value = $('st-project').value;
  $('rp-go').addEventListener('click', () => {
    const saved = {}; ['rp-project', 'rp-release', 'rp-author', 'rp-notes'].forEach(id => { saved[id] = $(id).value; }); store.set('report', saved);
    const c = Q.coverage(model);
    docs.report = Q.buildReport({
      project: $('rp-project').value.trim() || $('st-project').value.trim() || 'Release', release: $('rp-release').value.trim(), author: $('rp-author').value.trim(), date: $('rp-date').value.trim(), notes: $('rp-notes').value,
      risk: $('rp-risk').checked ? Q.riskScore(risk) : null,
      coverage: $('rp-cov').checked && c.reqTotal ? c : null,
      defects: $('rp-def').checked ? { critical: +risk.critical || 0, high: +risk.high || 0, medium: +risk.medium || 0, low: +risk.low || 0 } : null,
      estimate: $('rp-est').checked && Q.estimate(est).scenarios ? Q.estimate(est) : null,
    });
    $('rp-doc').innerHTML = Q.markdownToHtml(docs.report) + '<p class="hint" style="margin-top:16px">Prepared with QA Manager Copilot · pawansinha.com.au/tools/qa-copilot/</p>';
    $('rp-doc').hidden = false; $('rp-x').hidden = false;
    $('rp-doc').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // ------------------------------------------------------------------ copy / download / print for strategy and report
  document.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', () => copy(docs[b.dataset.copy], b.parentNode.querySelector('.copied'), b.dataset.copy + '.md')));
  document.querySelectorAll('[data-dl]').forEach(b => b.addEventListener('click', () => download((b.dataset.dl === 'strategy' ? 'test-strategy' : 'test-summary-report') + '.md', docs[b.dataset.dl], 'text/markdown')));
  document.querySelectorAll('[data-print]').forEach(b => b.addEventListener('click', () => {
    const panel = $(b.dataset.print);
    document.body.setAttribute('data-print', b.dataset.print);
    panel.classList.add('printing');
    const done = () => { document.body.removeAttribute('data-print'); panel.classList.remove('printing'); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    window.print();
    setTimeout(done, 1000);
  }));

  // ------------------------------------------------------------------ start
  showTab((location.hash || '#scenarios').slice(1), false);
  renderCoverage();
  renderEstimate();
  renderRisk();
})();
