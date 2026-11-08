/* UI for /tools/ci-failure-detective/. Logic lives in ci.js (window.CIDetective). Nothing leaves the browser. */
(function () {
  'use strict';
  const CI = window.CIDetective;
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const n = x => Number(x).toLocaleString('en-AU');
  const result = $('result');
  let current = null, currentName = '', multi = null;
  const runs = [];

  // ------------------------------------------------------------------ samples
  const ts = (s) => '2026-11-08T10:' + String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0') + '.' + String(1000000 + s * 7919 % 1000000).slice(1) + '0Z ';
  const SAMPLES = {
    gh: () => [
      'Current runner version: \'2.320.0\'', 'Operating System', '  Ubuntu 24.04.1 LTS', 'Runner Image', '  Image: ubuntu-24.04',
      '##[group]Run actions/checkout@v4', 'with:', '  repository: acme/shop-web', '##[endgroup]', 'Syncing repository: acme/shop-web',
      '##[group]Run actions/setup-node@v4', 'with:', '  node-version: 20', '##[endgroup]', 'Found in cache @ /opt/hostedtoolcache/node/20.18.0/x64',
      '##[group]Run npm ci', '\x1b[36;1mnpm ci\x1b[0m', 'shell: /usr/bin/bash -e {0}', '##[endgroup]',
      'npm warn deprecated inflight@1.0.6: This module is not supported, and leaks memory.',
      'npm ERR! code ERESOLVE', 'npm ERR! ERESOLVE unable to resolve dependency tree', 'npm ERR! ',
      'npm ERR! While resolving: shop-web@2.4.0', 'npm ERR! Found: react@19.0.0', 'npm ERR! node_modules/react', 'npm ERR!   react@"^19.0.0" from the root project',
      'npm ERR! ', 'npm ERR! Could not resolve dependency:', 'npm ERR! peer react@"^17.0.0 || ^18.0.0" from react-datepicker@6.9.0',
      'npm ERR! Fix the upstream dependency conflict, or retry', 'npm ERR! this command with --force or --legacy-peer-deps',
      'npm ERR! A complete log of this run can be found in: /home/runner/.npm/_logs/2026-11-08T10_00_31_118Z-debug-0.log',
      '##[error]Process completed with exit code 1.',
    ].map((l, i) => ts(i) + l).join('\n'),
    gl: () => [
      'Running with gitlab-runner 17.5.2 (c6eae8d7)', '  on shared-runner-7 xZ3k9, system ID: s_5e2d', 'section_start:1731060001:prepare_executor\r\x1b[0K\x1b[0K\x1b[36;1mPreparing the "docker" executor\x1b[0;m',
      'Using Docker executor with image docker:27.3 ...', 'Starting service docker:27.3-dind ...', 'section_end:1731060010:prepare_executor\r\x1b[0K',
      '\x1b[32;1m$ docker build -t $CI_REGISTRY_IMAGE:$CI_COMMIT_SHORT_SHA .\x1b[0;m', '#0 building with "default" instance using docker driver', '#1 [internal] load build definition from Dockerfile',
      '#2 [internal] load metadata for docker.io/library/node:20-alpine', '#2 ERROR: toomanyrequests: You have reached your unauthenticated pull rate limit. https://www.docker.com/increase-rate-limit',
      '------', ' > [internal] load metadata for docker.io/library/node:20-alpine:', '------',
      'ERROR: failed to solve: node:20-alpine: failed to resolve source metadata for docker.io/library/node:20-alpine: toomanyrequests: You have reached your unauthenticated pull rate limit.',
      'section_end:1731060040:step_script\r\x1b[0K', '\x1b[31;1mERROR: Job failed: exit code 1\x1b[0;m',
    ].map((l, i) => '2026-11-08T10:00:' + String(i).padStart(2, '0') + '.123456Z 00O ' + l).join('\n'),
    jk: () => [
      'Started by timer', 'Obtained Jenkinsfile from git https://git.acme.internal/payments/api.git', '[Pipeline] Start of Pipeline', '[Pipeline] node',
      'Running on build-agent-04 in /var/lib/jenkins/workspace/payments-api', '[Pipeline] { (Test)', '[Pipeline] sh', '+ mvn -B verify',
      '[INFO] Scanning for projects...', '[INFO] Building payments-api 3.8.0', '[INFO] --- surefire:3.5.1:test (default-test) @ payments-api ---',
      '[INFO] Running com.acme.payments.RefundServiceTest', '[INFO] Tests run: 14, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 2.1 s',
      '[INFO] Running com.acme.payments.SettlementJobTest', '[ERROR] Tests run: 9, Failures: 1, Errors: 1, Skipped: 0, Time elapsed: 61.4 s <<< FAILURE! -- in com.acme.payments.SettlementJobTest',
      '[ERROR] com.acme.payments.SettlementJobTest.settlesLargeBatch -- Time elapsed: 58.2 s <<< ERROR!', 'java.lang.OutOfMemoryError: Java heap space',
      '\tat java.base/java.util.Arrays.copyOf(Arrays.java:3541)', '\tat com.acme.payments.SettlementJob.loadAll(SettlementJob.java:88)',
      '[ERROR] com.acme.payments.SettlementJobTest.totalsMatch -- Time elapsed: 0.4 s <<< FAILURE!', 'org.opentest4j.AssertionFailedError: expected: <1250.00> but was: <1249.99>',
      '[INFO] Results:', '[ERROR] Failures: ', '[ERROR]   SettlementJobTest.totalsMatch:61 expected: <1250.00> but was: <1249.99>', '[ERROR] Errors: ',
      '[ERROR]   SettlementJobTest.settlesLargeBatch:42 » OutOfMemory Java heap space', '[ERROR] Tests run: 23, Failures: 1, Errors: 1, Skipped: 0',
      '[INFO] BUILD FAILURE', '[ERROR] Failed to execute goal org.apache.maven.plugins:maven-surefire-plugin:3.5.1:test (default-test) on project payments-api: There are test failures.',
      '[Pipeline] }', 'ERROR: script returned exit code 1', '[Pipeline] End of Pipeline', 'Finished: FAILURE',
    ].map((l, i) => '[2026-11-08T10:' + String(10 + Math.floor(i / 10)).padStart(2, '0') + ':' + String(i * 3 % 60).padStart(2, '0') + '.000Z] ' + l).join('\n'),
    pw: () => pwLog(['pass', 'fail', 'flaky', 'pass', 'pass'], true),
  };
  const PW_TESTS = ['home.spec.ts:3:5 › shows the hero', 'search.spec.ts:8:5 › finds a product', 'cart.spec.ts:12:5 › adds to cart', 'checkout.spec.ts:20:5 › pays with a saved card', 'account.spec.ts:6:5 › updates the address'];
  function pwLog(states, withError) {
    const L = ['Running ' + states.length + ' tests using 2 workers', ''];
    const fails = [], flakies = [];
    states.forEach((s, i) => {
      const name = '[chromium] › ' + PW_TESTS[i % PW_TESTS.length];
      if (s === 'pass') L.push('  ✓  ' + (i + 1) + ' ' + name + ' (' + (1 + i * 0.4).toFixed(1) + 's)');
      else if (s === 'fail') { L.push('  ✘  ' + (i + 1) + ' ' + name + ' (30.0s)'); fails.push(name); }
      else { L.push('  ✘  ' + (i + 1) + ' ' + name + ' (5.2s)', '  ✓  ' + (i + 1) + ' ' + name + ' (retry #1) (2.1s)'); flakies.push(name); }
    });
    L.push('');
    fails.forEach((f, k) => {
      L.push('  ' + (k + 1) + ') ' + f + ' ──────────────────────', '');
      if (withError) L.push('    Error: locator.click: Timeout 30000ms exceeded.', '    Call log:', "      - waiting for getByRole('button', { name: 'Search' })", '      - element is not visible', '');
    });
    if (fails.length) L.push('  ' + fails.length + ' failed', ...fails.map(f => '    ' + f));
    if (flakies.length) L.push('  ' + flakies.length + ' flaky', ...flakies.map(f => '    ' + f));
    L.push('  ' + (states.length - fails.length - flakies.length) + ' passed (41.3s)');
    return L.join('\n');
  }
  function junit(states) {
    const names = ['CartTest.addsItem', 'CartTest.appliesDiscount', 'CheckoutTest.paysWithSavedCard', 'CheckoutTest.declinedCard', 'SearchTest.findsProduct', 'SearchTest.emptyResults', 'AccountTest.updatesAddress'];
    let x = '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n';
    const suites = {};
    names.forEach((nm, i) => { const [cls, m] = nm.split('.'); (suites[cls] = suites[cls] || []).push([m, states[i]]); });
    Object.keys(suites).forEach(cls => {
      x += '  <testsuite name="com.acme.shop.' + cls + '" tests="' + suites[cls].length + '">\n';
      suites[cls].forEach(([m, s]) => {
        x += '    <testcase classname="com.acme.shop.' + cls + '" name="' + m + '" time="0.' + (m.length * 37 % 900 + 100) + '"';
        if (s === 'p') x += '/>\n';
        else if (s === 'f') x += '>\n      <failure message="expected: &lt;true&gt; but was: &lt;false&gt;" type="org.opentest4j.AssertionFailedError">at com.acme.shop.' + cls + '.' + m + '(' + cls + '.java:42)</failure>\n    </testcase>\n';
        else if (s === 'r') x += '>\n      <flakyFailure message="Timed out after 10 seconds waiting for element" type="org.openqa.selenium.TimeoutException"/>\n    </testcase>\n';
        else x += '>\n      <skipped/>\n    </testcase>\n';
      });
      x += '  </testsuite>\n';
    });
    return x + '</testsuites>\n';
  }
  const MSAMPLES = {
    xml: () => [
      ['nightly-2026-11-03.xml', junit(['p', 'p', 'f', 'p', 'p', 'p', 'p'])],
      ['nightly-2026-11-04.xml', junit(['p', 'p', 'p', 'p', 'p', 'f', 'p'])],
      ['nightly-2026-11-05.xml', junit(['p', 'f', 'f', 'p', 'r', 'p', 's'])],
      ['nightly-2026-11-06.xml', junit(['p', 'f', 'p', 'p', 'p', 'p', 's'])],
      ['nightly-2026-11-07.xml', junit(['p', 'f', 'f', 'p', 'p', 'f', 'p'])],
    ],
    logs: () => [
      ['run-101.log', pwLog(['pass', 'pass', 'fail', 'pass', 'pass'])],
      ['run-102.log', pwLog(['pass', 'pass', 'pass', 'pass', 'pass'])],
      ['run-103.log', pwLog(['pass', 'fail', 'flaky', 'pass', 'fail'], true)],
      ['run-104.log', pwLog(['pass', 'pass', 'fail', 'pass', 'fail'])],
    ],
  };

  // ------------------------------------------------------------------ mode tabs
  const tabs = [$('tab-one'), $('tab-multi')];
  tabs.forEach(t => t.addEventListener('click', () => setMode(t.id === 'tab-multi' ? 'multi' : 'one')));
  function setMode(m) {
    tabs.forEach(t => t.setAttribute('aria-selected', String((t.id === 'tab-multi') === (m === 'multi'))));
    $('p-one').hidden = m === 'multi';
    $('p-multi').hidden = m !== 'multi';
    result.hidden = true;
  }

  // ------------------------------------------------------------------ one log
  const input = $('log-in');
  function readFile(f) { return f.text ? f.text() : new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsText(f); }); }
  $('file').addEventListener('change', async e => { const f = e.target.files[0]; if (f) { input.value = await readFile(f); currentName = f.name; analyseOne(); } });
  dropTo($('drop'), async files => { input.value = await readFile(files[0]); currentName = files[0].name; analyseOne(); });
  $('go').addEventListener('click', () => { currentName = currentName || ''; analyseOne(); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) analyseOne(); });
  input.addEventListener('input', () => { currentName = ''; });
  $('clear').addEventListener('click', () => { input.value = ''; currentName = ''; result.hidden = true; $('err').hidden = true; document.querySelectorAll('[data-sample]').forEach(b => b.removeAttribute('aria-pressed')); });
  document.querySelectorAll('[data-sample]').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('[data-sample]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    input.value = SAMPLES[b.dataset.sample]();
    currentName = b.textContent.trim();
    analyseOne();
  }));

  function dropTo(zone, cb) {
    ['dragenter', 'dragover'].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.remove('over'); }));
    zone.addEventListener('drop', e => { const fs = e.dataTransfer && e.dataTransfer.files; if (fs && fs.length) cb(Array.from(fs)); });
  }

  function analyseOne() {
    $('err').hidden = true;
    if (!input.value.trim()) { $('err').textContent = 'Paste a log or choose a file first.'; $('err').hidden = false; return; }
    if (CI.looksLikeJUnit(input.value)) {
      setMode('multi'); runs.length = 0; runs.push({ name: currentName || 'report.xml', text: input.value }); input.value = ''; renderRuns(); analyseMulti(); return;
    }
    current = CI.analyse(input.value);
    renderOne(current);
  }

  const STATUS = { failed: ['fail', 'Failed'], passed: ['pass', 'Passed'], 'passed-with-warnings': ['warn', 'Passed with warnings'], unknown: ['warn', 'Result unclear'] };
  function ctx(lines) { return '<pre class="ctx">' + lines.map(c => '<span' + (c.hit ? ' class="hit"' : '') + '><i>' + c.n + '</i>' + esc(c.text) + '</span>').join('') + '</pre>'; }

  function renderOne(r) {
    const st = STATUS[r.status] || STATUS.unknown;
    const rs = r.root && r.root.sig;
    let h = '<div class="verdict ' + st[0] + '"><h2>' + esc(rs ? rs.title : r.root ? 'Unrecognised error at line ' + r.root.line : st[1]) + '</h2>';
    h += '<p>' + esc(r.summary) + '</p><p class="fmt">' + esc(r.ciLabel) + ' · ' + n(r.lineCount) + ' lines' + (r.exitCode != null ? ' · exit code ' + r.exitCode : '') + (currentName ? ' · ' + esc(currentName) : '') + '</p></div>';
    const real = r.groups.filter(g => !g.generic);
    h += '<div class="ja-stats"><div class="ja-stat' + (real.length ? ' bad' : '') + '"><b>' + real.length + '</b><span>Failure signals</span></div>' +
      '<div class="ja-stat' + (r.failedTests.length ? ' bad' : '') + '"><b>' + r.failedTests.length + '</b><span>Failed tests</span></div>' +
      '<div class="ja-stat' + (r.flakyTests.length ? ' warn' : '') + '"><b>' + r.flakyTests.length + '</b><span>Passed on retry</span></div>' +
      '<div class="ja-stat"><b>' + r.groups.filter(g => g.generic).reduce((a, g) => a + g.count, 0) + '</b><span>Follow-on lines</span></div></div>';

    if (r.root) {
      h += '<div class="block"><div class="block-head"><h3>Root cause candidate</h3><span class="hint">line ' + r.root.line + '</span></div>';
      h += '<div class="card-x bad"><h4>' + (rs ? '<span class="cat">' + esc(CI.CATS[rs.cat]) + '</span>' + esc(rs.title) : 'First error-like line') + '</h4>' + ctx(r.root.context) +
        (rs ? '<p><b>Why:</b> ' + esc(rs.cause) + '</p><p><b>Fix:</b> ' + esc(rs.fix) + '</p>' : '<p>No known pattern matched. Read the lines around it; the cause is usually here or just above.</p>') +
        (r.exitCode != null ? '<p><b>Exit code ' + r.exitCode + ':</b> ' + esc(r.exitMeaning) + '</p>' : '') + '</div></div>';
    }
    const others = real.filter(g => !(rs && g.id === rs.id));
    if (others.length) {
      h += '<div class="block"><div class="block-head"><h3>Other failure signals</h3><span class="hint">in log order</span></div>';
      others.forEach(g => {
        const m = r.matches.filter(x => x.sigId === g.id);
        h += '<div class="card-x ' + (g.cat === 'flaky' || g.cat === 'quality' ? 'warn' : 'info') + '"><h4><span class="cat">' + esc(g.catLabel) + '</span>' + esc(g.title) + ' <span class="hint">×' + g.count + ', line' + (g.lines.length > 1 ? 's ' : ' ') + g.lines.slice(0, 6).join(', ') + (g.lines.length > 6 ? '…' : '') + '</span></h4>' +
          '<p>' + esc(g.cause) + '</p><details class="more"><summary>Fix and log lines</summary><p><b>Fix:</b> ' + esc(g.fix) + '</p>' + (m[0] ? ctx(m[0].context) : '') + '</details></div>';
      });
      h += '</div>';
    }
    if (r.failedTests.length || r.flakyTests.length) {
      h += '<div class="block"><div class="block-head"><h3>Tests</h3><span class="hint">' + r.failedTests.length + ' failed · ' + r.flakyTests.length + ' passed on retry · ' + r.tests.filter(t => t.status === 'pass').length + ' passed lines seen</span></div>' +
        '<div class="tbl-wrap"><table class="data"><thead><tr><th class="l">Test</th><th class="l">Result</th><th class="l">Framework</th><th>Line</th></tr></thead><tbody>' +
        r.failedTests.concat(r.flakyTests).slice(0, 300).map(t => '<tr><td class="msg"><code>' + esc(t.name) + '</code></td><td class="l">' + (t.status === 'flaky' ? '<span style="color:var(--warn);font-weight:700">Flaky</span>' : '<span style="color:var(--bad);font-weight:700">Failed</span>') + '</td><td class="l">' + esc(t.framework) + '</td><td>' + t.line + '</td></tr>').join('') + '</tbody></table></div></div>';
    }
    const noise = r.groups.filter(g => g.generic);
    if (noise.length) {
      h += '<div class="block"><details class="more"><summary>Follow-on noise (' + noise.reduce((a, g) => a + g.count, 0) + ' lines): results of the failure, not causes</summary>' +
        noise.map(g => '<div class="card-x mute" style="margin-top:8px"><h4>' + esc(g.title) + ' <span class="hint">line' + (g.lines.length > 1 ? 's ' : ' ') + g.lines.slice(0, 8).join(', ') + '</span></h4><p>' + esc(g.cause) + '</p></div>').join('') + '</details></div>';
    }
    h += exportsHtml('Copy for a ticket or Slack');
    show(h);
    wireExports(() => CI.toMarkdown(current, currentName), 'ci-failure.md');
  }

  // ------------------------------------------------------------------ several runs
  const mIn = $('m-in');
  function renderRuns() {
    $('runs').innerHTML = runs.map((r, i) => '<li><span>' + (i + 1) + '. ' + esc(r.name) + '</span><button type="button" data-rm="' + i + '" aria-label="Remove ' + esc(r.name) + '">✕</button></li>').join('');
    $('runs').querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => { runs.splice(+b.dataset.rm, 1); renderRuns(); }));
  }
  async function addFiles(files) {
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const f of files) runs.push({ name: f.name, text: await readFile(f) });
    renderRuns();
  }
  $('m-file').addEventListener('change', async e => { await addFiles(Array.from(e.target.files)); e.target.value = ''; });
  dropTo($('mdrop'), addFiles);
  $('m-add').addEventListener('click', () => { if (!mIn.value.trim()) return; runs.push({ name: 'Pasted run ' + (runs.length + 1), text: mIn.value }); mIn.value = ''; renderRuns(); });
  $('m-clear').addEventListener('click', () => { runs.length = 0; renderRuns(); result.hidden = true; document.querySelectorAll('[data-msample]').forEach(b => b.removeAttribute('aria-pressed')); });
  $('m-go').addEventListener('click', analyseMulti);
  document.querySelectorAll('[data-msample]').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('[data-msample]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    runs.length = 0;
    MSAMPLES[b.dataset.msample]().forEach(([name, text]) => runs.push({ name, text }));
    renderRuns();
    analyseMulti();
  }));

  function analyseMulti() {
    const err = $('m-err');
    err.hidden = true;
    if (mIn.value.trim()) { runs.push({ name: 'Pasted run ' + (runs.length + 1), text: mIn.value }); mIn.value = ''; renderRuns(); }
    if (!runs.length) { err.textContent = 'Add at least one run (two or more to spot flaky tests).'; err.hidden = false; return; }
    // the browser's XML parser double-checks JUnit files; the analysis itself uses the same pure parser as the tests
    const bad = [];
    if (typeof DOMParser !== 'undefined') runs.forEach(r => { if (CI.looksLikeJUnit(r.text)) { const d = new DOMParser().parseFromString(r.text, 'application/xml'); if (d.getElementsByTagName('parsererror').length) bad.push(r.name); } });
    multi = CI.multiRun(runs);
    renderMulti(multi, bad);
  }

  const ICON = { pass: ['✓', 'pass', 'Passed'], fail: ['✗', 'fail', 'Failed'], flaky: ['↻', 'flaky', 'Passed on retry'], skip: ['–', '', 'Skipped'] };
  function renderMulti(m, bad) {
    const cls = m.flaky.length ? 'warn' : m.recurring.length ? 'fail' : 'pass';
    const hard = m.recurring.filter(t => !t.flaky);
    let h = '<div class="verdict ' + cls + '"><h2>' + (m.flaky.length ? m.flaky.length + ' flaky test' + (m.flaky.length === 1 ? '' : 's') : 'No flaky tests found') + (hard.length ? ', ' + hard.length + ' failing test' + (hard.length === 1 ? '' : 's') + ' (not flaky)' : '') + '</h2>' +
      '<p>' + m.runCount + ' runs, ' + n(m.tests.length) + ' tests seen. ' + (m.runCount < 3 ? 'Load at least 3 runs for a reliable picture.' : 'Flaky rate ' + m.flakyRate + '% of tests.') + '</p></div>';
    if (bad.length) h += '<ul class="warnings"><li>The browser found XML errors in ' + esc(bad.join(', ')) + '. Results for those files may be incomplete.</li></ul>';
    if (m.runs.some(r => r.error)) h += '<ul class="warnings">' + m.runs.filter(r => r.error).map(r => '<li>' + esc(r.name) + ': ' + esc(r.error) + '</li>').join('') + '</ul>';
    h += '<div class="ja-stats"><div class="ja-stat"><b>' + m.runCount + '</b><span>Runs</span></div><div class="ja-stat"><b>' + n(m.tests.length) + '</b><span>Tests</span></div>' +
      '<div class="ja-stat' + (m.flaky.length ? ' warn' : '') + '"><b>' + m.flaky.length + '</b><span>Flaky</span></div><div class="ja-stat' + (hard.length ? ' bad' : '') + '"><b>' + hard.length + '</b><span>Failing, not flaky</span></div></div>';

    const runHead = m.runs.map((r, i) => '<th title="' + esc(r.name) + '">' + (i + 1) + '</th>').join('');
    const histRows = list => list.map(t => '<tr><td class="msg"><code>' + esc(t.name) + '</code>' + (t.brokenSince != null ? ' <span class="cat">broken since run ' + (t.brokenSince + 1) + '</span>' : '') + (t.messages[0] ? '<br><span class="hint">' + esc(t.messages[0].slice(0, 160)) + '</span>' : '') + '</td>' +
      t.statuses.map((s, i) => { const ic = ICON[s]; return '<td class="s ' + (ic ? ic[1] : '') + '" title="' + esc(m.runs[i].name) + ': ' + (ic ? ic[2] : 'not in this run') + '">' + (ic ? ic[0] : '·') + '</td>'; }).join('') +
      '<td>' + (t.fails + t.flakyRuns) + '/' + t.statuses.filter(Boolean).length + '</td></tr>').join('');
    const legend = '<p class="hint">✓ passed · ✗ failed · ↻ passed on retry · – skipped · · not in that run. Columns are runs in the order loaded.</p>';
    if (m.flaky.length) h += '<div class="block"><div class="block-head"><h3>Flaky tests</h3><span class="hint">pass and fail across runs, or pass only on retry</span></div><div class="tbl-wrap"><table class="data hist"><thead><tr><th class="l">Test</th>' + runHead + '<th>Fails</th></tr></thead><tbody>' + histRows(m.flaky.slice(0, 100)) + '</tbody></table></div>' + legend + '</div>';
    if (hard.length) h += '<div class="block"><div class="block-head"><h3>Failing, not flaky</h3><span class="hint">failed every time, or kept failing from one run on: real bugs or broken tests</span></div><div class="tbl-wrap"><table class="data hist"><thead><tr><th class="l">Test</th>' + runHead + '<th>Fails</th></tr></thead><tbody>' + histRows(hard.slice(0, 100)) + '</tbody></table></div></div>';
    if (m.recurring.length) h += '<div class="block"><div class="block-head"><h3>Most frequent failures</h3></div><div class="tbl-wrap"><table class="data"><thead><tr><th class="l">Test</th><th>Failed runs</th><th>Fail rate</th><th class="l">Type</th></tr></thead><tbody>' +
      m.recurring.slice(0, 30).map(t => '<tr><td class="msg"><code>' + esc(t.name) + '</code></td><td>' + (t.fails + t.flakyRuns) + '</td><td>' + t.failRate + '%</td><td class="l">' + (t.flaky ? 'Flaky' : t.brokenSince != null ? 'Broken since run ' + (t.brokenSince + 1) : 'Always fails') + '</td></tr>').join('') + '</tbody></table></div></div>';
    h += '<div class="block"><div class="block-head"><h3>Per run</h3></div><div class="tbl-wrap"><table class="data"><thead><tr><th class="l">Run</th><th>Passed</th><th>Failed</th><th>Retry</th>' + m.categories.map(c => '<th>' + esc(CI.CATS[c] || c) + '</th>').join('') + '<th class="l">Root cause (logs)</th></tr></thead><tbody>' +
      m.runs.map((r, i) => '<tr><td>' + (i + 1) + '. ' + esc(r.name) + '</td><td>' + r.passed + '</td><td' + (r.failed ? ' class="errs"' : '') + '>' + r.failed + '</td><td>' + r.flaky + '</td>' + m.categories.map(c => '<td>' + (m.trend[i][c] || '·') + '</td>').join('') + '<td class="msg">' + (r.root ? esc(r.root.title) + ' <span class="hint">line ' + r.root.line + '</span>' : r.kind === 'junit' ? '<span class="hint">JUnit XML</span>' : '—') + '</td></tr>').join('') +
      '</tbody></table></div><p class="hint">Category columns count failure signals per run, so you can see whether failures are drifting from tests to infrastructure.</p></div>';
    h += exportsHtml('Copy summary');
    show(h);
    wireExports(() => CI.multiToMarkdown(multi), 'flaky-tests.md');
  }

  // ------------------------------------------------------------------ shared
  function exportsHtml(label) {
    return '<div class="block"><div class="block-head"><h3>Share</h3></div><div class="exports"><button class="btn btn-ghost btn-small" type="button" id="x-md">' + label + ' (Markdown)</button>' +
      '<button class="btn btn-ghost btn-small" type="button" id="x-dl">Download .md</button><span class="copied" id="copied" aria-live="polite"></span></div><p class="hint">Pastes cleanly into Jira, GitHub, GitLab, Confluence and Slack.</p></div>';
  }
  function wireExports(mdFn, file) {
    $('x-md').addEventListener('click', async () => {
      const md = mdFn();
      try { await navigator.clipboard.writeText(md); $('copied').textContent = 'Copied'; } catch (e) { download(file, md); $('copied').textContent = 'Downloaded'; }
      setTimeout(() => { $('copied').textContent = ''; }, 2500);
    });
    $('x-dl').addEventListener('click', () => download(file, mdFn()));
  }
  function show(h) { result.innerHTML = h; result.hidden = false; result.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  function download(name, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
})();
