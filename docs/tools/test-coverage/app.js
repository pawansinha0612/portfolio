/* UI for /tools/test-coverage/. Logic lives in coverage.js (window.CoverageIntel); big reports are analysed in worker.js.
   Nothing leaves the browser. */
(function () {
  'use strict';
  const CV = window.CoverageIntel;
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = x => Number(x).toLocaleString('en-AU');
  const pctTxt = x => (x == null ? '–' : x.toFixed(1) + '%');
  const result = $('result');
  let junitRuns = [];
  let last = null;

  // ------------------------------------------------------------------ sample data (a made-up online shop)
  function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  const SHOP = [
    ['src/cart/cart.ts', 220, 0.92], ['src/cart/discounts.ts', 140, 0.55], ['src/checkout/payment.ts', 310, 0.41], ['src/checkout/checkout.ts', 260, 0.74],
    ['src/checkout/refunds.ts', 120, 0.18], ['src/catalogue/search.ts', 180, 0.88], ['src/catalogue/product.ts', 90, 0.97], ['src/account/address.ts', 75, 0.81],
    ['src/account/login.ts', 130, 0.66], ['src/shared/money.ts', 60, 1], ['src/shared/http.ts', 150, 0.62], ['src/shipping/rates.ts', 200, 0.34],
    ['src/shipping/tracking.ts', 85, 0.0], ['src/catalogue/stock.ts', 110, 0.71],
  ];
  const hash = s => { let h = 7; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; };
  function lcov(files, seed) {
    let out = 'TN:\n';
    files.forEach(([p, n, cov]) => {
      const r = rng(seed + hash(p));
      out += 'SF:/home/runner/work/shop/shop/' + p + '\n';
      let lf = 0, lh = 0, bf = 0, bh = 0;
      for (let ln = 1; ln <= n; ln++) {
        if (r() < 0.35) continue; // blank lines, comments
        const hit = r() < cov ? 1 + Math.floor(r() * 40) : 0;
        out += 'DA:' + ln + ',' + hit + '\n'; lf++; if (hit) lh++;
        if (ln % 9 === 0) { for (let b = 0; b < 2; b++) { const t = r() < cov * 0.9; out += 'BRDA:' + ln + ',0,' + b + ',' + (t ? 1 + Math.floor(r() * 9) : '-') + '\n'; bf++; if (t) bh++; } }
      }
      out += 'LF:' + lf + '\nLH:' + lh + '\nBRF:' + bf + '\nBRH:' + bh + '\nend_of_record\n';
    });
    return out;
  }
  const TESTS = [
    ['cart.spec.ts', 'adds an item @REQ-101', 'p', 'p', 'p'], ['cart.spec.ts', 'removes an item @REQ-101', 'p', 'p', 'p'],
    ['discounts.spec.ts', 'applies a 10% code @REQ-104', 'p', 'f', 'p'], ['payment.spec.ts', 'pays with a saved card @REQ-110', 'p', 'p', 'p'],
    ['payment.spec.ts', 'declined card shows an error @REQ-111', 'f', 'f', 'f'], ['checkout.spec.ts', 'places an order @REQ-110', 'p', 'p', 'p'],
    ['search.spec.ts', 'finds a product by name @REQ-120', 'p', 'p', 'p'], ['search.spec.ts', 'empty results message', 'p', 'p', 's'],
    ['login.spec.ts', 'logs in with email @REQ-130', 'p', 'p', 'p'], ['login.spec.ts', 'locks after five attempts @REQ-131', 'p', 'f', 'f'],
    ['rates.spec.ts', 'quotes express shipping @REQ-140', 'p', 'p', 'p'], ['address.spec.ts', 'updates the address', 'p', 'p', 'p'],
  ];
  function junit(run) {
    const by = {};
    TESTS.forEach(t => { (by[t[0]] = by[t[0]] || []).push(t); });
    let x = '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="playwright">\n';
    Object.keys(by).forEach(f => {
      x += '  <testsuite name="' + f + '" tests="' + by[f].length + '">\n';
      by[f].forEach(t => {
        const s = t[2 + run];
        x += '    <testcase name="' + t[1] + '" classname="' + f + '" time="1.2"';
        if (s === 'p') x += '/>\n';
        else if (s === 's') x += '><skipped/></testcase>\n';
        else x += '><failure message="expect(received).toBe(expected)" type="FAILURE">Error: expect(received).toBe(expected)</failure></testcase>\n';
      });
      x += '  </testsuite>\n';
    });
    return x + '</testsuites>\n';
  }
  function gitlog() {
    const r = rng(7);
    const weights = { 'src/checkout/payment.ts': 0.7, 'src/checkout/refunds.ts': 0.45, 'src/shipping/rates.ts': 0.5, 'src/cart/discounts.ts': 0.4, 'src/checkout/checkout.ts': 0.35,
      'src/account/login.ts': 0.3, 'src/shared/http.ts': 0.2 };
    let out = '';
    for (let c = 0; c < 60; c++) {
      const day = String(1 + (c % 28)).padStart(2, '0');
      out += 'commit ' + (0x1a2b3c4d + c * 7919).toString(16) + '0f00d\nAuthor: Dev <dev@example.com>\nDate:   2026-10-' + day + '\n\n    change ' + c + '\n\n';
      let any = false;
      SHOP.forEach(([p]) => { if (r() < (weights[p] || 0.06)) { out += (1 + Math.floor(r() * 40)) + '\t' + Math.floor(r() * 20) + '\t' + p + '\n'; any = true; } });
      if (!any) out += '3\t1\tREADME.md\n';
      out += '\n';
    }
    return out;
  }
  const REQS = 'Requirement,Title,Tests\nREQ-101,Add and remove cart items,\nREQ-104,Discount codes,\nREQ-110,Pay for an order,\nREQ-111,Card declined handling,\n'
    + 'REQ-112,Refund a payment,\nREQ-120,Product search,\nREQ-130,Customer login,\nREQ-131,Account lockout,\nREQ-140,Shipping quotes,\nREQ-141,Parcel tracking,\n';
  function cobertura() {
    const r = rng(3);
    const files = [['app/orders/api.py', 140, 0.83], ['app/orders/models.py', 90, 0.96], ['app/billing/invoice.py', 210, 0.48], ['app/billing/tax.py', 70, 0.9], ['app/auth/tokens.py', 120, 0.62], ['app/utils/dates.py', 50, 1]];
    let x = '<?xml version="1.0" ?>\n<coverage version="7.6.1" line-rate="0.7" branch-rate="0.6" timestamp="1731000000000">\n  <sources><source>/builds/acme/orders</source></sources>\n  <packages>\n';
    const pk = {};
    files.forEach(f => { const d = f[0].split('/').slice(0, -1).join('.'); (pk[d] = pk[d] || []).push(f); });
    Object.keys(pk).forEach(d => {
      x += '    <package name="' + d + '"><classes>\n';
      pk[d].forEach(([p, n, cov]) => {
        x += '      <class name="' + p.split('/').pop() + '" filename="' + p + '"><methods/><lines>\n';
        for (let ln = 1; ln <= n; ln++) {
          if (r() < 0.3) continue;
          const h = r() < cov ? 1 + Math.floor(r() * 5) : 0;
          if (ln % 8 === 0) { const c = r() < cov ? 2 : r() < 0.5 ? 1 : 0; x += '        <line number="' + ln + '" hits="' + h + '" branch="true" condition-coverage="' + (c * 50) + '% (' + c + '/2)"/>\n'; }
          else x += '        <line number="' + ln + '" hits="' + h + '"/>\n';
        }
        x += '      </lines></class>\n';
      });
      x += '    </classes></package>\n';
    });
    return x + '  </packages>\n</coverage>\n';
  }
  function jacoco() {
    const r = rng(11);
    const files = [['com/acme/payments', 'RefundService.java', 160, 0.42], ['com/acme/payments', 'SettlementJob.java', 240, 0.71], ['com/acme/payments', 'Money.java', 60, 0.98],
      ['com/acme/ledger', 'LedgerWriter.java', 190, 0.58], ['com/acme/ledger', 'Reconciler.java', 130, 0.25]];
    let x = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><!DOCTYPE report PUBLIC "-//JACOCO//DTD Report 1.1//EN" "report.dtd"><report name="payments-api">\n';
    const pk = {};
    files.forEach(f => { (pk[f[0]] = pk[f[0]] || []).push(f); });
    Object.keys(pk).forEach(p => {
      x += '<package name="' + p + '">\n';
      pk[p].forEach(([, n, size, cov]) => {
        x += '<sourcefile name="' + n + '">\n';
        for (let ln = 1; ln <= size; ln++) {
          if (r() < 0.4) continue;
          const hit = r() < cov, br = ln % 7 === 0 ? 2 : 0, cb = br ? (hit ? (r() < 0.6 ? 2 : 1) : 0) : 0;
          x += '<line nr="' + ln + '" mi="' + (hit ? 0 : 3) + '" ci="' + (hit ? 3 : 0) + '" mb="' + (br - cb) + '" cb="' + cb + '"/>\n';
        }
        x += '</sourcefile>\n';
      });
      x += '</package>\n';
    });
    return x + '</report>\n';
  }
  const baseShop = SHOP.map(([p, n, c]) => [p, p === 'src/checkout/payment.ts' ? n - 40 : n, Math.min(1, c + (/refunds|payment|rates/.test(p) ? 0.12 : /discounts/.test(p) ? 0.05 : 0))]).filter(f => f[0] !== 'src/shipping/tracking.ts');

  const SAMPLES = {
    shop: () => ({ coverage: lcov(SHOP, 42), baseline: lcov(baseShop, 42), junit: [0, 1, 2].map(i => ({ name: 'run-' + (101 + i) + '.xml', text: junit(i) })), churn: gitlog(), requirements: REQS }),
    cobertura: () => ({ coverage: cobertura(), baseline: '', junit: [], churn: '', requirements: '' }),
    jacoco: () => ({ coverage: jacoco(), baseline: '', junit: [], churn: '', requirements: '' }),
  };

  // ------------------------------------------------------------------ inputs
  function readFile(f) { return f.text ? f.text() : new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsText(f); }); }
  function dropTo(zone, cb) {
    ['dragenter', 'dragover'].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.remove('over'); }));
    zone.addEventListener('drop', e => { const fs = e.dataTransfer && e.dataTransfer.files; if (fs && fs.length) cb(Array.from(fs)); });
  }
  function bindText(id) {
    const ta = $(id);
    $(id + '-file').addEventListener('change', async e => { const f = e.target.files[0]; if (f) { ta.value = await readFile(f); markOpen(ta); } e.target.value = ''; });
    dropTo(ta.closest('.dropzone'), async files => { ta.value = await readFile(files[0]); markOpen(ta); });
  }
  function markOpen(el) { const d = el.closest('details'); if (d) d.open = true; updateBadges(); }
  ['cov', 'base', 'churn', 'reqs'].forEach(bindText);

  function renderRuns() {
    $('runs').innerHTML = junitRuns.map((r, i) => '<li><span title="' + esc(r.name) + '">' + esc(r.name) + '</span><button type="button" data-rm="' + i + '" aria-label="Remove ' + esc(r.name) + '">×</button></li>').join('');
    updateBadges();
  }
  $('runs').addEventListener('click', e => { const b = e.target.closest('[data-rm]'); if (b) { junitRuns.splice(+b.dataset.rm, 1); renderRuns(); } });
  async function addJUnitFiles(files) { for (const f of files) junitRuns.push({ name: f.name, text: await readFile(f) }); renderRuns(); }
  $('junit-file').addEventListener('change', async e => { await addJUnitFiles(Array.from(e.target.files)); e.target.value = ''; });
  dropTo($('junit-drop'), files => addJUnitFiles(files));
  $('junit-add').addEventListener('click', () => {
    const t = $('junit').value;
    if (!t.trim()) return;
    junitRuns.push({ name: 'Pasted run ' + (junitRuns.length + 1), text: t }); $('junit').value = ''; renderRuns();
  });
  function updateBadges() {
    const set = (id, on, txt) => { const b = $(id); b.textContent = on ? txt : 'optional'; b.classList.toggle('on', !!on); };
    set('b-junit', junitRuns.length, junitRuns.length + ' run' + (junitRuns.length > 1 ? 's' : '') + ' loaded');
    set('b-churn', $('churn').value.trim(), 'loaded');
    set('b-reqs', $('reqs').value.trim(), 'loaded');
    set('b-base', $('base').value.trim(), 'loaded');
  }
  ['churn', 'reqs', 'base'].forEach(id => $(id).addEventListener('input', updateBadges));

  document.querySelectorAll('[data-sample]').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('[data-sample]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    const s = SAMPLES[b.dataset.sample]();
    $('cov').value = s.coverage; $('base').value = s.baseline; $('churn').value = s.churn; $('reqs').value = s.requirements;
    junitRuns = s.junit.slice(); renderRuns();
    document.querySelectorAll('details.opt').forEach(d => { d.open = !!d.querySelector('textarea').value.trim() || (d.id === 'd-junit' && junitRuns.length > 0); });
    run();
  }));
  $('go').addEventListener('click', run);
  $('clear').addEventListener('click', () => {
    ['cov', 'base', 'churn', 'reqs', 'junit'].forEach(id => { $(id).value = ''; });
    junitRuns = []; renderRuns(); result.hidden = true; $('err').hidden = true;
    document.querySelectorAll('[data-sample]').forEach(b => b.removeAttribute('aria-pressed'));
  });

  // ------------------------------------------------------------------ run (worker for big inputs)
  let worker = null;
  function analyseAsync(input) {
    const size = input.coverage.length + input.baseline.length;
    if (size < 400000 || typeof Worker === 'undefined') return Promise.resolve().then(() => CV.analyse(input));
    return new Promise((resolve, reject) => {
      try { if (!worker) worker = new Worker('/tools/test-coverage/worker.js'); }
      catch (e) { resolve(CV.analyse(input)); return; }
      worker.onmessage = e => (e.data.ok ? resolve(e.data.result) : reject(new Error(e.data.error)));
      worker.onerror = () => { worker = null; try { resolve(CV.analyse(input)); } catch (err) { reject(err); } };
      worker.postMessage(input);
    });
  }
  async function run() {
    $('err').hidden = true;
    const input = { coverage: $('cov').value, baseline: $('base').value, churn: $('churn').value, requirements: $('reqs').value, junit: junitRuns.slice() };
    if (!input.coverage.trim()) { showErr('Paste or choose a coverage report first, or try a sample.'); return; }
    $('busy').hidden = false;
    try {
      last = await analyseAsync(input);
      render(last);
    } catch (e) { showErr(e.message || String(e)); result.hidden = true; }
    finally { $('busy').hidden = true; }
  }
  function showErr(m) { $('err').textContent = m; $('err').hidden = false; }

  // ------------------------------------------------------------------ render
  const covClass = p => (p == null ? 'mute' : p < 50 ? 'bad' : p < 80 ? 'warn' : 'ok');
  function covColour(p) { if (p == null) return 'hsl(220 10% 55%)'; const h = Math.max(0, Math.min(120, (p - 30) * 2)); return 'hsl(' + h + ' 52% 40%)'; }

  function render(a) {
    const t = a.totals, s = a.summary;
    const lvl = s.level === 'high' ? 'fail' : s.level === 'medium' ? 'warn' : 'pass';
    let h = '<div class="verdict ' + lvl + '"><h2>' + esc(s.headline) + '</h2><ul class="points">' + s.points.map(p => '<li>' + esc(p) + '</li>').join('') + '</ul>'
      + '<p class="advice"><strong>' + esc(s.advice) + '</strong></p><p class="fmt">Read as ' + esc(a.formatLabel) + ' · ' + num(t.files) + ' files'
      + (a.tests ? ' · ' + a.tests.runs.length + ' test run' + (a.tests.runs.length > 1 ? 's' : '') : '') + (a.churn ? ' · change history matched ' + a.churn.matched + ' of ' + a.churn.total + ' paths' : '') + '</p>'
      + '<div class="exports"><button class="btn btn-small" type="button" id="x-sum">Copy summary for a manager</button><button class="btn btn-ghost btn-small" type="button" id="x-md">Download report (Markdown)</button><button class="btn btn-ghost btn-small" type="button" id="x-csv">Download files (CSV)</button><span class="copied" id="copied" aria-live="polite"></span></div></div>';
    h += '<div class="ja-stats">' + stat('Lines covered', pctTxt(t.linePct), num(t.lc) + ' of ' + num(t.lt), covClass(t.linePct))
      + stat('Branches covered', pctTxt(t.branchPct), t.bt ? num(t.bc) + ' of ' + num(t.bt) : 'not in report', covClass(t.branchPct))
      + (t.ft ? stat('Functions covered', pctTxt(t.fnPct), num(t.fc) + ' of ' + num(t.ft), covClass(t.fnPct)) : '')
      + (a.tests ? stat('Failing tests', num(a.tests.failing), 'of ' + num(a.tests.total), a.tests.failing ? 'bad' : '') + stat('Flaky tests', num(a.tests.flaky), 'pass and fail', a.tests.flaky ? 'warn' : '') : '')
      + (a.requirements ? stat('Untested requirements', num(a.requirements.filter(r => r.status === 'untested').length), 'of ' + a.requirements.length, a.requirements.some(r => r.status === 'untested') ? 'bad' : '') : '')
      + (a.diff && a.diff.delta != null ? stat('Change vs baseline', (a.diff.delta > 0 ? '+' : '') + a.diff.delta + ' pts', num(a.diff.newUncoveredTotal) + ' new untested lines', a.diff.delta < 0 ? 'bad' : '') : '')
      + '</div>';
    if (a.warnings.length) h += '<ul class="warnings">' + a.warnings.map(w => '<li>' + esc(w) + '</li>').join('') + '</ul>';

    h += '<div class="block"><div class="block-head"><h3>Coverage map</h3></div><p class="hint">Each box is a file, grouped by folder. Size is the number of executable lines; colour is line coverage (red under 50%, amber under 80%, green above). Select a box to jump to it in the table.</p>'
      + '<div class="tm-wrap" id="tm"></div><div class="tm-legend"><span><i style="background:' + covColour(20) + '"></i>under 50%</span><span><i style="background:' + covColour(65) + '"></i>50–80%</span><span><i style="background:' + covColour(95) + '"></i>80% and over</span></div></div>';

    h += '<div class="block"><div class="block-head"><h3>Risk hotspots</h3></div><p class="hint">Risk = how much is untested × how often it changes' + (a.churn ? '' : ' (add a change history to use this)') + ' × how big it is, plus failing or flaky tests that point at the file. Start adding tests at the top.</p>'
      + '<div class="tbl-wrap"><table class="data" id="t-hot"></table></div></div>';

    if (a.diff) h += diffBlock(a.diff);
    if (a.tests && a.tests.list.length) h += testsBlock(a.tests);
    if (a.requirements) h += reqBlock(a.requirements);

    h += '<div class="block"><div class="block-head"><h3>Coverage by folder</h3></div><div class="tbl-wrap"><table class="data" id="t-pkg"></table></div></div>';
    h += '<div class="block"><div class="block-head"><h3>All files</h3><label class="field">Filter <input type="search" id="f-filter" placeholder="path" style="width:180px"></label></div><div class="tbl-wrap"><table class="data" id="t-files"></table></div><p class="hint" id="f-more"></p></div>';
    h += gatesBlock(a);
    result.innerHTML = h;
    result.hidden = false;

    drawTreemap(a);
    sortable($('t-hot'), [
      { k: 'path', l: 'File', left: true }, { k: 'risk', l: 'Risk', f: r => '<span class="risk-bar"><i style="width:' + r.risk + '%"></i></span> ' + r.risk },
      { k: 'linePct', l: 'Lines', f: r => '<span class="' + covClass(r.linePct) + '">' + pctTxt(r.linePct) + '</span>' }, { k: 'branchPct', l: 'Branches', f: r => pctTxt(r.branchPct) },
      { k: 'commits', l: 'Commits', f: r => (r.commits == null ? '–' : r.commits) }, { k: 'why', l: 'Why', left: true, wide: true, f: r => esc(r.why.join('; ') || 'well covered') },
    ], a.hotspots.slice(0, 15), 'risk', -1);
    sortable($('t-pkg'), [
      { k: 'name', l: 'Folder', left: true }, { k: 'files', l: 'Files' }, { k: 'lt', l: 'Lines', f: r => num(r.lt) },
      { k: 'linePct', l: 'Line %', f: r => '<span class="' + covClass(r.linePct) + '">' + pctTxt(r.linePct) + '</span>' }, { k: 'branchPct', l: 'Branch %', f: r => pctTxt(r.branchPct) },
    ], a.packages, 'linePct', 1);
    const fileCols = [
      { k: 'path', l: 'File', left: true }, { k: 'lt', l: 'Lines', f: r => num(r.lt) },
      { k: 'linePct', l: 'Line %', f: r => '<span class="' + covClass(r.linePct) + '">' + pctTxt(r.linePct) + '</span>' }, { k: 'branchPct', l: 'Branch %', f: r => pctTxt(r.branchPct) },
      { k: 'uncovered', l: 'Untested lines', left: true, wide: true, f: r => (r.uncovered ? '<b>' + num(r.uncovered) + '</b> <small>' + esc(r.uncoveredText) + '</small>' : '–') },
    ];
    if (a.churn) fileCols.push({ k: 'commits', l: 'Commits', f: r => (r.commits == null ? '0' : r.commits) });
    if (a.tests) fileCols.push({ k: 'failing', l: 'Tests', f: r => (r.tests ? r.tests + (r.failing ? ' <b class="bad">' + r.failing + ' failing</b>' : '') + (r.flaky ? ' <b class="warn">' + r.flaky + ' flaky</b>' : '') : '–') });
    const drawFiles = () => {
      const q = $('f-filter').value.trim().toLowerCase();
      const rows = a.files.filter(r => !q || r.path.toLowerCase().includes(q));
      sortable($('t-files'), fileCols, rows.slice(0, 500), 'linePct', 1, r => 'file-' + r.path);
      $('f-more').textContent = rows.length > 500 ? 'Showing 500 of ' + num(rows.length) + ' files. Use the filter to narrow down.' : '';
    };
    $('f-filter').addEventListener('input', drawFiles);
    drawFiles();
    bindGates(a);
    $('x-sum').addEventListener('click', () => copy(a.summary.text));
    $('x-md').addEventListener('click', () => download('coverage-report.md', toMarkdown(a), 'text/markdown'));
    $('x-csv').addEventListener('click', () => download('coverage-files.csv', toCSV(a), 'text/csv'));
    result.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function stat(label, big, small, cls) { return '<div class="ja-stat ' + (cls || '') + '"><b>' + esc(big) + '</b><span>' + esc(label) + (small ? ' · ' + esc(small) : '') + '</span></div>'; }

  function diffBlock(d) {
    let h = '<div class="block"><div class="block-head"><h3>Compared with the baseline report</h3></div><p class="hint">Lines '
      + pctTxt(d.base.linePct) + ' → ' + pctTxt(d.head.linePct) + ' (' + (d.delta > 0 ? '+' : '') + d.delta + ' points). ' + d.newFiles + ' new file' + (d.newFiles === 1 ? '' : 's') + ', ' + d.removedFiles + ' removed. '
      + '“New untested lines” are lines with no test now that were tested, or did not exist, in the baseline. If a file was edited, line numbers can shift, so treat them as a guide.</p>';
    if (!d.rows.length) return h + '<p>No file changed coverage.</p></div>';
    h += '<div class="tbl-wrap"><table class="data"><thead><tr><th class="l">File</th><th>Before</th><th>After</th><th>Change</th><th class="l">New untested lines</th></tr></thead><tbody>';
    d.rows.slice(0, 60).forEach(r => {
      h += '<tr><td>' + esc(r.path) + (r.status !== 'changed' ? ' <span class="ja-tag">' + r.status + '</span>' : '') + '</td><td>' + pctTxt(r.basePct) + '</td><td>' + pctTxt(r.headPct) + '</td><td class="'
        + (r.delta < 0 ? 'errs' : '') + '">' + (r.delta == null ? '–' : (r.delta > 0 ? '+' : '') + r.delta) + '</td><td class="msg">' + (r.newUncovered.length ? '<b>' + r.newUncovered.length + '</b> <small>' + esc(r.newUncoveredText) + '</small>' : '–') + '</td></tr>';
    });
    return h + '</tbody></table></div></div>';
  }
  function testsBlock(t) {
    let h = '<div class="block"><div class="block-head"><h3>Failing and flaky tests</h3></div><p class="hint">' + t.mapped + ' of ' + t.total
      + ' tests were matched to a source file by name (CartTest → Cart.java, cart.spec.ts → cart.ts). Matched failures add to that file’s risk.</p><div class="tbl-wrap"><table class="data"><thead><tr><th class="l">Test</th><th>Status</th><th>Failed</th><th class="l">Last message</th></tr></thead><tbody>';
    t.list.forEach(x => { h += '<tr><td>' + esc(x.key) + '</td><td class="' + (x.status === 'fail' ? 'errs' : '') + '">' + (x.status === 'fail' ? 'failing' : 'flaky') + '</td><td>' + x.fails + ' of ' + x.runs + '</td><td class="msg">' + esc(x.message || '') + '</td></tr>'; });
    return h + '</tbody></table></div></div>';
  }
  function reqBlock(reqs) {
    const lab = { failing: 'failing', untested: 'no test', flaky: 'flaky', skipped: 'skipped', 'no-results': 'not run', passing: 'passing' };
    let h = '<div class="block"><div class="block-head"><h3>Requirements and their tests</h3></div><p class="hint">From your requirements CSV and from tags such as <code>@REQ-123</code> in test names.</p><div class="tbl-wrap"><table class="data"><thead><tr><th class="l">Requirement</th><th>Status</th><th class="l">Tests</th></tr></thead><tbody>';
    reqs.forEach(r => {
      h += '<tr><td><b>' + esc(r.id) + '</b>' + (r.title ? ' ' + esc(r.title) : '') + '</td><td class="st-' + r.status + '">' + lab[r.status] + '</td><td class="msg">'
        + (r.tests.length ? r.tests.map(t => esc(t.key) + ' <small>(' + t.status + ')</small>').join('<br>') : '–')
        + (r.missingRefs && r.missingRefs.length ? '<br><small>Not found in results: ' + esc(r.missingRefs.join(', ')) + '</small>' : '') + '</td></tr>';
    });
    return h + '</tbody></table></div></div>';
  }
  function gatesBlock(a) {
    return '<div class="block" id="gates"><div class="block-head"><h3>CI coverage gate</h3></div><p class="hint">Start the gate at today’s numbers so the build only fails when coverage goes down, then raise it a few points each quarter. The diff-cover step checks only the lines a pull request changed, which is the fairest gate for old code.</p>'
      + '<div class="actions" style="margin:0 0 10px"><label class="field">Lines % <input type="number" id="g-line" min="0" max="100" value="' + a.gates.line + '"></label><label class="field">Branches % <input type="number" id="g-branch" min="0" max="100" value="' + a.gates.branch + '"></label></div>'
      + '<div class="modes" role="tablist" aria-label="Gate format" id="g-tabs">'
      + [['github', 'GitHub Actions'], ['gitlab', 'GitLab CI'], ['jest', 'Jest'], ['vitest', 'Vitest'], ['pytest', 'pytest'], ['jacoco', 'Maven JaCoCo']].map((x, i) => '<button class="chip-btn" type="button" role="tab" aria-selected="' + (i === 0) + '" data-g="' + x[0] + '">' + x[1] + '</button>').join('')
      + '</div><div class="code-box"><button class="btn btn-ghost btn-small copy-btn" type="button" id="g-copy">Copy</button><pre class="gate"><code id="g-code"></code></pre></div></div>';
  }
  function bindGates(a) {
    let which = 'github';
    const draw = () => {
      const g = CV.ciGates({ format: a.format, line: +$('g-line').value || 0, branch: +$('g-branch').value || 0 });
      $('g-code').textContent = which === 'github' ? g.github : which === 'gitlab' ? g.gitlab : g.native[which];
    };
    $('g-tabs').addEventListener('click', e => { const b = e.target.closest('[data-g]'); if (!b) return; which = b.dataset.g; $('g-tabs').querySelectorAll('[data-g]').forEach(x => x.setAttribute('aria-selected', String(x === b))); draw(); });
    ['g-line', 'g-branch'].forEach(id => $(id).addEventListener('input', draw));
    $('g-copy').addEventListener('click', () => copy($('g-code').textContent));
    draw();
  }

  // generic sortable table
  function sortable(table, cols, rows, key, dir, idFn) {
    const state = { key, dir };
    const draw = () => {
      const k = state.key, d = state.dir;
      const sorted = rows.slice().sort((x, y) => {
        let a = x[k], b = y[k];
        if (Array.isArray(a)) { a = a.length; b = b.length; }
        if (a == null && b == null) return 0; if (a == null) return 1; if (b == null) return -1;
        return (typeof a === 'string' ? a.localeCompare(b) : a - b) * d;
      });
      table.innerHTML = '<thead><tr>' + cols.map(c => '<th' + (c.left ? ' class="l"' : '') + (c.k === k ? ' aria-sort="' + (d > 0 ? 'ascending' : 'descending') + '"' : ' aria-sort="none"') + '><button type="button" data-k="' + c.k + '">' + esc(c.l) + '</button></th>').join('') + '</tr></thead><tbody>'
        + sorted.map(r => '<tr' + (idFn ? ' id="' + esc(idFn(r)) + '"' : '') + '>' + cols.map((c, i) => '<td' + (c.wide ? ' class="msg"' : c.left && i ? ' class="l"' : '') + '>' + (c.f ? c.f(r) : esc(r[c.k])) + '</td>').join('') + '</tr>').join('') + '</tbody>';
    };
    table.onclick = e => { const b = e.target.closest('button[data-k]'); if (!b) return; if (state.key === b.dataset.k) state.dir = -state.dir; else { state.key = b.dataset.k; state.dir = b.dataset.k === 'path' || b.dataset.k === 'name' ? 1 : -1; } draw(); };
    draw();
  }

  function drawTreemap(a) {
    const W = 1000, H = 440;
    const pk = a.packages.map(p => ({ name: p.name, value: Math.max(1, p.lt), pct: p.linePct }));
    const outer = CV.treemap(pk, 0, 0, W, H);
    let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Coverage treemap: file size by lines, colour by line coverage">';
    outer.forEach(p => {
      const head = p.h > 40 && p.w > 60 ? 16 : 0;
      const files = a.files.filter(f => f.dir === p.name).map(f => ({ name: f.path, value: Math.max(1, f.lt), pct: f.linePct }));
      CV.treemap(files, p.x + 1, p.y + 1 + head, p.w - 2, p.h - 2 - head).forEach(f => {
        const label = f.w > 70 && f.h > 22 ? '<text x="' + (f.x + 5).toFixed(1) + '" y="' + (f.y + 15).toFixed(1) + '">' + esc(trim(f.name.split('/').pop(), Math.floor(f.w / 7))) + '</text>' : '';
        const lab2 = f.w > 50 && f.h > 38 ? '<text class="p" x="' + (f.x + 5).toFixed(1) + '" y="' + (f.y + 30).toFixed(1) + '">' + pctTxt(f.pct) + '</text>' : '';
        svg += '<g class="tm-f" data-path="' + esc(f.name) + '" tabindex="0" role="button" aria-label="' + esc(f.name + ', ' + pctTxt(f.pct) + ' lines covered') + '"><rect x="' + f.x.toFixed(1) + '" y="' + f.y.toFixed(1) + '" width="' + Math.max(0, f.w - 1).toFixed(1) + '" height="' + Math.max(0, f.h - 1).toFixed(1) + '" fill="' + covColour(f.pct) + '"><title>' + esc(f.name + ': ' + pctTxt(f.pct) + ' of ' + f.value + ' lines') + '</title></rect>' + label + lab2 + '</g>';
      });
      if (head) svg += '<text class="pk" x="' + (p.x + 4).toFixed(1) + '" y="' + (p.y + 12).toFixed(1) + '">' + esc(trim(p.name + ' · ' + pctTxt(p.pct), Math.floor(p.w / 6.5))) + '</text>';
      svg += '<rect class="pk-b" x="' + p.x.toFixed(1) + '" y="' + p.y.toFixed(1) + '" width="' + p.w.toFixed(1) + '" height="' + p.h.toFixed(1) + '"/>';
    });
    $('tm').innerHTML = svg + '</svg>';
    const go = el => {
      if ($('f-filter').value) { $('f-filter').value = ''; $('f-filter').dispatchEvent(new Event('input')); }
      const row = document.getElementById('file-' + el.dataset.path);
      if (row) { row.scrollIntoView({ behavior: 'smooth', block: 'center' }); row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 1600); }
    };
    $('tm').addEventListener('click', e => { const g = e.target.closest('.tm-f'); if (g) go(g); });
    $('tm').addEventListener('keydown', e => { const g = e.target.closest('.tm-f'); if (g && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); go(g); } });
  }
  const trim = (s, n) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s);

  // ------------------------------------------------------------------ exports
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); $('copied').textContent = 'Copied'; }
    catch (e) { download('summary.txt', text, 'text/plain'); $('copied').textContent = 'Downloaded'; }
    setTimeout(() => { if ($('copied')) $('copied').textContent = ''; }, 2500);
  }
  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: (type || 'text/plain') + ';charset=utf-8' }));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  function toMarkdown(a) {
    const t = a.totals;
    let md = '# Test coverage report\n\n## ' + a.summary.headline + '\n\n' + a.summary.points.map(p => '- ' + p).join('\n') + '\n\n' + a.summary.advice + '\n\n';
    md += '| Measure | Value |\n|---|---|\n| Lines | ' + pctTxt(t.linePct) + ' (' + t.lc + ' of ' + t.lt + ') |\n| Branches | ' + pctTxt(t.branchPct) + ' |\n| Files | ' + t.files + ' |\n';
    if (a.tests) md += '| Tests | ' + a.tests.total + ' (' + a.tests.failing + ' failing, ' + a.tests.flaky + ' flaky) |\n';
    md += '\n## Top risk hotspots\n\n| File | Risk | Lines | Why |\n|---|---|---|---|\n' + a.hotspots.slice(0, 10).map(h => '| ' + h.path + ' | ' + h.risk + ' | ' + pctTxt(h.linePct) + ' | ' + h.why.join('; ') + ' |').join('\n') + '\n';
    if (a.requirements) md += '\n## Requirements\n\n| Requirement | Status | Tests |\n|---|---|---|\n' + a.requirements.map(r => '| ' + r.id + (r.title ? ' ' + r.title : '') + ' | ' + r.status + ' | ' + (r.tests.map(x => x.key).join('<br>') || '–') + ' |').join('\n') + '\n';
    if (a.diff) md += '\n## Compared with baseline\n\nLines ' + pctTxt(a.diff.base.linePct) + ' → ' + pctTxt(a.diff.head.linePct) + ', ' + a.diff.newUncoveredTotal + ' new untested lines.\n';
    return md + '\n_Made with the free Test Coverage Intelligence tool: https://pawansinha.com.au/tools/test-coverage/_\n';
  }
  function toCSV(a) {
    const q = v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? '"' + s.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""') + '"' : s; };
    return 'file,lines,covered,line_pct,branches,branches_covered,branch_pct,untested_lines,commits\n' + a.files.map(f => [f.path, f.lt, f.lc, f.linePct, f.bt, f.bc, f.branchPct, f.uncoveredText, f.commits].map(q).join(',')).join('\n') + '\n';
  }
})();
