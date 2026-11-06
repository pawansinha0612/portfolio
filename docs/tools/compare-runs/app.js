/* UI for /tools/compare-runs/. Parsing: /tools/jtl-analyser/jtl.js (raw JMeter results, in a Web Worker),
   /tools/k6-results/explain.js (k6), compare.js (everything else + the comparison). Nothing is uploaded. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const C = window.CompareRuns, J = window.JTL, K6 = window.K6Explain;
  const esc = J.esc;
  const runs = { base: null, cand: null };
  let last = null;

  const err = $('err'), out = $('result');
  function showErr(m) { err.textContent = m || ''; err.hidden = !m; }
  function track(p) { if (window.goatcounter && window.goatcounter.count) window.goatcounter.count({ path: p, title: p, event: true }); }

  // ---------------------------------------------------------------- loading a run

  async function fromText(text, name) {
    const kind = C.detect(text);
    if (kind === 'jtl') return C.fromJtl(J.analyseText(text), name);
    return C.parseRun(text, name, K6);
  }

  async function fromFile(file, side) {
    const head = await file.slice(0, 65536).text();
    const kind = /\.gz$/i.test(file.name) ? 'jtl' : C.detect(head);
    if (kind === 'jtl') {
      return C.fromJtl(await J.analyse(file, { buckets: 60 }, (done, rows) => status(side, 'Reading… ' + J.fmtNum(rows) + ' rows')), file.name);
    }
    if (file.size > 50e6) throw new Error(file.name + ' is large but isn\'t raw JMeter results. Summary files are small; check you picked the right file.');
    return C.parseRun(await file.text(), file.name, K6);
  }

  function status(side, text, cls) {
    const el = $(side + '-status');
    el.textContent = text;
    el.className = 'run-status ' + (cls || '');
  }

  async function load(side, getRun, label) {
    showErr('');
    status(side, 'Reading ' + label + '…');
    try {
      const run = await getRun();
      runs[side] = run;
      const n = run.transactions.length;
      status(side, '✓ ' + run.source + ' · ' + (n ? n + ' transaction' + (n === 1 ? '' : 's') : 'overall numbers only'), 'ok');
      update(true);
    } catch (e) {
      runs[side] = null;
      status(side, '✗ ' + (e.message || e), 'bad');
      out.hidden = true;
    }
  }

  for (const side of ['base', 'cand']) {
    const input = $(side + '-file'), drop = $(side + '-drop');
    input.addEventListener('change', () => { const f = input.files[0]; if (f) load(side, () => fromFile(f, side), f.name); });
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, () => drop.classList.remove('over')));
    drop.addEventListener('drop', e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) load(side, () => fromFile(f, side), f.name); });
    $(side + '-paste-go').addEventListener('click', () => {
      const t = $(side + '-paste').value;
      if (!t.trim()) { status(side, '✗ Paste something first.', 'bad'); return; }
      load(side, () => fromText(t, 'pasted text'), 'pasted text');
    });
  }

  // ---------------------------------------------------------------- examples

  function jmeterExample() {
    const base = J.generateSample({ rows: 20000, seed: 3 });
    const factor = { '05 Checkout': 1.45, '03 Search products': 0.7 };
    const cand = J.generateSample({ rows: 20000, seed: 4 }).split('\n').map((l, i) => {
      const m = i && /^(\d+),(\d+),([^,]+),/.exec(l);
      if (!m || !factor[m[3]]) return l;
      return m[1] + ',' + Math.round(+m[2] * factor[m[3]]) + l.slice(m[1].length + m[2].length + 1);
    }).join('\n');
    return [C.fromJtl(J.analyseText(base), 'example-baseline.jtl'), C.fromJtl(J.analyseText(cand), 'example-candidate.jtl')];
  }

  function k6Example() {
    const mk = (login, search, cart, fail, rate) => JSON.stringify({
      state: { testRunDurationMs: 600000 },
      metrics: {
        http_reqs: { count: rate * 600, rate },
        'http_reqs{name:login}': { count: rate * 200, rate: rate / 3 },
        'http_reqs{name:search}': { count: rate * 200, rate: rate / 3 },
        'http_reqs{name:add_to_cart}': { count: rate * 200, rate: rate / 3 },
        http_req_failed: { passes: 0, fails: rate * 600, value: fail / 3 },
        'http_req_failed{name:login}': { passes: Math.round(rate * 200 * fail), fails: rate * 200 - Math.round(rate * 200 * fail), value: fail },
        'http_req_failed{name:search}': { passes: 0, fails: rate * 200, value: 0 },
        'http_req_failed{name:add_to_cart}': { passes: 0, fails: rate * 200, value: 0 },
        http_req_duration: { avg: (login[0] + search[0] + cart[0]) / 3, med: 90, min: 12, max: 2900, 'p(90)': 260, 'p(95)': Math.max(login[1], search[1], cart[1]), 'p(99)': Math.max(login[2], search[2], cart[2]) },
        'http_req_duration{name:login}': { avg: login[0], med: login[0] * 0.8, min: 20, max: 2900, 'p(90)': login[1] * 0.85, 'p(95)': login[1], 'p(99)': login[2] },
        'http_req_duration{name:search}': { avg: search[0], med: search[0] * 0.8, min: 15, max: 1900, 'p(90)': search[1] * 0.85, 'p(95)': search[1], 'p(99)': search[2] },
        'http_req_duration{name:add_to_cart}': { avg: cart[0], med: cart[0] * 0.8, min: 12, max: 900, 'p(90)': cart[1] * 0.85, 'p(95)': cart[1], 'p(99)': cart[2] },
      },
    });
    return [C.parseRun(mk([140, 310, 620], [210, 480, 900], [90, 180, 350], 0.002, 50), 'release-41.json', K6),
      C.parseRun(mk([175, 405, 980], [150, 330, 640], [92, 186, 360], 0.021, 49), 'release-42.json', K6)];
  }

  document.querySelectorAll('[data-example]').forEach(b => b.addEventListener('click', () => {
    showErr('');
    const [a, c] = b.dataset.example === 'k6' ? k6Example() : jmeterExample();
    runs.base = a; runs.cand = c;
    status('base', '✓ ' + a.source + ' · ' + a.transactions.length + ' transactions', 'ok');
    status('cand', '✓ ' + c.source + ' · ' + c.transactions.length + ' transactions', 'ok');
    update(true);
    track('compare-example');
  }));

  // ---------------------------------------------------------------- rules

  const RULES = ['p95Pct', 'p99Pct', 'avgPct', 'errPts', 'tputPct', 'minDeltaMs'];
  function rules() {
    const r = {};
    for (const k of RULES) { const v = $('r-' + k).value; r[k] = v === '' ? '' : +v; }
    return r;
  }
  RULES.forEach(k => $('r-' + k).addEventListener('input', () => update(false)));
  $('only-changes').addEventListener('change', () => update(false));

  // ---------------------------------------------------------------- output

  function update(scroll) {
    if (!runs.base || !runs.cand) return;
    last = C.compare(runs.base, runs.cand, rules());
    render(last, scroll);
  }

  const STATUS = {
    regression: ['Regression', 'bad'], improvement: ['Improvement', 'good'], same: ['No change', ''],
    new: ['New', 'info'], missing: ['Missing', 'info'],
  };

  function metricCell(key, j) {
    if (!j || isNaN(j.base) || isNaN(j.cand)) return '<td class="na">n/a</td>';
    const cls = j.status === 'worse' ? 'worse' : j.status === 'better' ? 'better' : '';
    return `<td class="${cls}"><span class="vals">${C.fmtVal(key, j.base)} → ${C.fmtVal(key, j.cand)}</span><span class="delta">${esc(C.fmtDelta(key, j))}</span></td>`;
  }

  function render(cmp, scroll) {
    const a = runs.base, b = runs.cand;
    const only = $('only-changes').checked;
    const h = [];
    const v = cmp.verdict;
    const title = v === 'fail' ? cmp.headline : v === 'pass' ? 'No regressions: ' + cmp.headline : 'No transactions in common';
    h.push(`<div class="verdict ${v}"><h2>${esc(title)}</h2>` +
      `<p>${v === 'fail' ? 'The candidate is worse than the baseline by more than your thresholds on the rows marked in red.' : v === 'pass' ? 'Nothing got worse by more than your thresholds.' : 'None of the transaction names match between the two runs, so nothing could be compared. Check that both runs used the same test plan or script.'}</p>` +
      `<p class="fmt">Baseline: ${esc(a.source)}<br>Candidate: ${esc(b.source)}</p></div>`);
    const notes = [...new Set(a.notes.concat(b.notes))];
    if (a.source.split(':')[0] !== b.source.split(':')[0]) notes.unshift('The two files are different kinds of output (' + a.source.split(':')[0] + ' vs ' + b.source.split(':')[0] + '). Transactions are matched by name, so this only works if they use the same names.');
    if (notes.length) h.push('<ul class="warnings">' + notes.map(n => `<li>${esc(n)}</li>`).join('') + '</ul>');

    const rows = cmp.rows.filter(r => !only || r.status !== 'same');
    h.push(`<div class="block"><div class="block-head"><h3 id="cmp-h">Per transaction</h3>
      <div class="actions" style="margin:0"><button class="btn btn-small" type="button" id="copy-md">Copy as Markdown</button>
      <button class="btn btn-ghost btn-small" type="button" id="dl-md">Download .md</button><span class="copied" id="copied" aria-live="polite"></span></div></div>
      <div class="tbl-wrap" tabindex="0" role="region" aria-labelledby="cmp-h"><table class="data cmp"><thead><tr>
      <th scope="col">Transaction</th><th scope="col" class="l">Result</th><th scope="col">p95</th><th scope="col">p99</th><th scope="col">Average</th>
      <th scope="col">Error %</th><th scope="col">Throughput</th><th scope="col">Samples</th></tr></thead><tbody>`);
    const line = (r, isTotal) => {
      const [txt, cls] = STATUS[r.status];
      const why = r.reasons.length ? ': ' + r.reasons.join(', ') : '';
      const first = `<td>${esc(r.label)}${r.lowSample ? ' <span class="few" title="Fewer samples than the minimum: percentiles are unreliable">few samples</span>' : ''}</td><td class="l"><span class="cmp-pill ${cls}">${txt}${esc(why)}</span></td>`;
      if (r.status === 'new' || r.status === 'missing') {
        return `<tr class="${isTotal ? 'total' : ''}">${first}<td colspan="6" class="na l">${r.status === 'new' ? 'Only in the candidate run' : 'Only in the baseline run'}</td></tr>`;
      }
      const cnt = x => (x && !isNaN(x.count) ? J.fmtNum(x.count) : 'n/a');
      return `<tr class="${isTotal ? 'total' : ''} st-${r.status}">${first}${['p95', 'p99', 'avg', 'errPct', 'tput'].map(k => metricCell(k, r.metrics[k])).join('')}` +
        `<td><span class="vals">${cnt(r.base)} → ${cnt(r.cand)}</span></td></tr>`;
    };
    h.push(rows.map(r => line(r)).join(''));
    if (cmp.total) h.push(line(cmp.total, true));
    if (!rows.length && !cmp.total) h.push('<tr><td colspan="8" class="na l">No rows to show.</td></tr>');
    h.push(`</tbody></table></div><p class="hint">Red = worse than your threshold, green = better by more than the same threshold. ` +
      `Error % changes are in percentage points. A throughput drop only means something if both runs applied the same load.` +
      `${only && cmp.counts.same ? ' ' + cmp.counts.same + ' unchanged transaction' + (cmp.counts.same === 1 ? ' is' : 's are') + ' hidden.' : ''}</p></div>`);

    out.innerHTML = h.join('');
    out.hidden = false;
    const md = () => C.toMarkdown(cmp, a, b);
    $('copy-md').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(md()); $('copied').textContent = 'Copied. Paste it into your ticket or PR.'; }
      catch (e) { dl('run-comparison.md', md()); $('copied').textContent = 'Clipboard blocked, so it was downloaded instead.'; }
      track('compare-copy-md');
    });
    $('dl-md').addEventListener('click', () => dl('run-comparison.md', md()));
    if (scroll) { out.scrollIntoView({ behavior: 'smooth', block: 'start' }); track('compare-done'); }
  }

  function dl(name, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
})();
