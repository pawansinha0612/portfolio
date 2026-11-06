/* Compare two load-test runs (baseline vs candidate): pure functions, no DOM.
   Runs in the browser (window.CompareRuns) and in Node (module.exports) for unit tests.

   A "run" is normalised to:
     { source, transactions: [{ label, count, avg, p50, p90, p95, p99, errPct, tput }], total: {...} | null, notes: [] }
   Times are milliseconds, errPct is a percentage (0..100), tput is requests (or iterations) per second.
   Missing numbers are NaN and are skipped by the regression rules.

   Inputs understood:
   - a JTL analysis result from jtl.js (JMeter CSV or XML results)
   - JMeter HTML dashboard statistics.json (report/statistics.json)
   - JMeter Aggregate Report / Summary Report CSV, and the summary CSV exported by /tools/jtl-analyser/
   - k6 --summary-export JSON, handleSummary() JSON, or the end-of-test text, via K6Explain.parse()
     (/tools/k6-results/explain.js): one row per http_req_duration sub-metric (e.g. {name:login}),
     per group_duration sub-metric, and per custom Trend metric, plus "All HTTP requests".
*/
(function (root) {
  'use strict';

  const N = v => (v == null || v === '' || isNaN(v) ? NaN : +v);

  // ---------------------------------------------------------------- from jtl.js result

  function fromJtl(r, name) {
    const row = l => ({ label: l.label, count: l.count, avg: l.avg, p50: l.p50, p90: l.p90, p95: l.p95, p99: l.p99,
      errPct: l.errPct, tput: l.tput, max: l.max });
    return { source: 'JMeter results (' + (r.format || 'JTL') + ')' + (name ? ': ' + name : ''),
      transactions: r.labels.map(row), total: Object.assign(row(r.total), { label: 'TOTAL' }), notes: [] };
  }

  // ---------------------------------------------------------------- JMeter statistics.json

  function fromJmeterStatistics(obj, name) {
    const tx = [];
    let total = null;
    for (const [key, s] of Object.entries(obj)) {
      if (!s || typeof s !== 'object' || s.sampleCount == null) continue;
      const row = { label: s.transaction || key, count: N(s.sampleCount), avg: N(s.meanResTime), p50: N(s.medianResTime),
        p90: N(s.pct1ResTime), p95: N(s.pct2ResTime), p99: N(s.pct3ResTime), errPct: N(s.errorPct), tput: N(s.throughput), max: N(s.maxResTime) };
      if (key === 'Total') total = Object.assign(row, { label: 'TOTAL' }); else tx.push(row);
    }
    return { source: 'JMeter dashboard statistics.json' + (name ? ': ' + name : ''), transactions: tx, total,
      notes: ['statistics.json percentile columns are read as p90/p95/p99 (JMeter\'s defaults). If you changed aggregate_rpt_pct1..3, the labels will be off.'] };
  }

  // ---------------------------------------------------------------- CSV summary (Aggregate Report, Summary Report, our export)

  function parseCsvSimple(text) {
    const rows = [];
    let row = [], field = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
        else field += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function pctNum(s) { return N(String(s == null ? '' : s).replace('%', '').trim()); }

  function isSummaryCsv(text) {
    const first = text.replace(/^﻿/, '').split(/\r?\n/, 1)[0].toLowerCase();
    return /(^|,)\s*"?label"?\s*,/.test(first) && /samples/.test(first);
  }

  function fromSummaryCsv(text, name) {
    const rows = parseCsvSimple(text.replace(/^﻿/, ''));
    const head = rows.shift().map(h => h.trim().toLowerCase());
    const find = (...re) => head.findIndex(h => re.some(r => r.test(h)));
    const c = {
      label: find(/^label$/), count: find(/^#?\s*samples$/), avg: find(/^average$/, /^avg( ms)?$/), p50: find(/^median$/, /^p50( ms)?$/),
      p90: find(/^90% line$/, /^p90( ms)?$/), p95: find(/^95% line$/, /^p95( ms)?$/), p99: find(/^99% line$/, /^p99( ms)?$/),
      err: find(/^error %$/), tput: find(/^throughput(\/s)?$/), max: find(/^max( ms)?$/),
    };
    if (c.label < 0 || c.count < 0) throw new Error('This CSV has no Label and Samples columns, so it isn\'t a JMeter summary.');
    const tx = [];
    let total = null;
    const notes = [];
    for (const r of rows) {
      const g = i => (i < 0 ? NaN : N(r[i]));
      let tput = c.tput < 0 ? NaN : String(r[c.tput]);
      // Summary/Aggregate reports saved from the GUI may write "12.3/sec" or "45.6/min"
      if (typeof tput === 'string') {
        const m = /^([\d.]+)\s*\/?\s*(sec|min|hour)?/.exec(tput.trim());
        tput = m ? +m[1] / ({ min: 60, hour: 3600 }[m[2]] || 1) : NaN;
      }
      const row = { label: r[c.label], count: g(c.count), avg: g(c.avg), p50: g(c.p50), p90: g(c.p90), p95: g(c.p95), p99: g(c.p99),
        errPct: c.err < 0 ? NaN : pctNum(r[c.err]), tput, max: g(c.max) };
      if (/^total$/i.test(row.label)) total = Object.assign(row, { label: 'TOTAL' }); else tx.push(row);
    }
    if (c.p95 < 0) notes.push('This summary has no 95th percentile column (JMeter\'s Summary Report doesn\'t include one). Use the Aggregate Report, the dashboard statistics.json or the raw .jtl for p95/p99.');
    return { source: 'JMeter summary CSV' + (name ? ': ' + name : ''), transactions: tx, total, notes };
  }

  // ---------------------------------------------------------------- k6

  const K6_SKIP = /^(http_req_(blocked|connecting|tls_handshaking|sending|waiting|receiving)|iteration_duration)$/;

  function tagLabel(tags) { // "name:login" → "login"; "group:::Checkout" → "group Checkout"; else as is
    const parts = tags.split(',').map(s => s.trim());
    return parts.map(p => {
      const i = p.indexOf(':');
      if (i < 0) return p;
      const k = p.slice(0, i), v = p.slice(i + 1);
      if (k === 'name' || k === 'url') return v;
      if (k === 'group') return 'group ' + v.replace(/^::/, '').replace(/::/g, ' › ');
      return k + '=' + v;
    }).join(', ');
  }

  function fromK6Model(model, name) {
    const M = model.metrics;
    const tx = [];
    const durMs = model.meta && model.meta.durationMs;
    const val = (m, k) => (M[m] && M[m].values[k] != null ? M[m].values[k] : NaN);
    function rowFor(metricName, label, suffix) {
      const v = M[metricName].values;
      const sub = suffix || '';
      let count = val('http_reqs' + sub, 'count');
      let tput = val('http_reqs' + sub, 'rate');
      if (isNaN(tput) && !isNaN(count) && durMs) tput = count / (durMs / 1000);
      if (!metricName.startsWith('http_req_duration')) { count = NaN; tput = NaN; }
      const failed = M['http_req_failed' + sub];
      let errPct = NaN;
      if (metricName.startsWith('http_req_duration') && failed && failed.values.rate != null) errPct = failed.values.rate * 100;
      return { label, count, avg: N(v.avg), p50: N(v.med), p90: N(v['p(90)']), p95: N(v['p(95)']), p99: N(v['p(99)']), errPct, tput, max: N(v.max) };
    }
    let total = null;
    for (const [mn, m] of Object.entries(M)) {
      if (m.type !== 'trend') continue;
      const br = mn.indexOf('{');
      const base = br < 0 ? mn : mn.slice(0, br);
      if (K6_SKIP.test(base)) continue;
      if (m.time === false) continue; // a non-time trend from the text summary
      const tags = br < 0 ? '' : mn.slice(br + 1, -1);
      if (base === 'http_req_duration') {
        if (!tags) { total = rowFor(mn, 'All HTTP requests', ''); continue; }
        if (/^expected_response:true$/.test(tags)) continue;
        tx.push(rowFor(mn, tagLabel(tags), '{' + tags + '}'));
      } else if (base === 'group_duration') {
        if (tags) tx.push(rowFor(mn, tagLabel(tags)));
      } else {
        tx.push(rowFor(mn, tags ? base + ' (' + tagLabel(tags) + ')' : base));
      }
    }
    const notes = [];
    if (!tx.length) notes.push('No per-request breakdown in this k6 summary, so only the overall numbers are compared. To get one row per request, tag requests ({ tags: { name: \'login\' } }) and add a threshold on http_req_duration{name:login} (k6 only reports sub-metrics that have a threshold).');
    if (total && isNaN(total.p99)) notes.push('No p(99) in this k6 summary. Add summaryTrendStats: [\'avg\',\'min\',\'med\',\'max\',\'p(90)\',\'p(95)\',\'p(99)\'] to options to get it.');
    return { source: 'k6 ' + (model.format || 'summary') + (name ? ': ' + name : ''), transactions: tx, total, notes };
  }

  /* detect(text) → 'k6' | 'jmeter-stats' | 'summary-csv' | 'jtl' | null
     'jtl' means raw results: feed the file through jtl.js (JTL.analyse) instead. */
  function detect(text) {
    const t = String(text || '').replace(/^﻿/, '').trimStart();
    if (!t) return null;
    if (t[0] === '{') {
      let obj;
      try { obj = JSON.parse(t); } catch (e) { return 'json-invalid'; }
      if (obj && obj.metrics && typeof obj.metrics === 'object') return 'k6';
      if (obj && Object.values(obj).some(s => s && typeof s === 'object' && s.sampleCount != null)) return 'jmeter-stats';
      return 'json-unknown';
    }
    if (t[0] === '<') return 'jtl';
    if (isSummaryCsv(t)) return 'summary-csv';
    const first = t.split(/\r?\n/, 1)[0];
    if (/(^|[,\t;|])elapsed([,\t;|]|$)/i.test(first) || /^\d{10,13}[,\t;|]\d+[,\t;|]/.test(first)) return 'jtl';
    if (/█|http_req_duration|iteration_duration|http_reqs/.test(t)) return 'k6';
    return null;
  }

  /* parseRun(text, name, K6Explain) for everything except raw JTL. */
  function parseRun(text, name, K6) {
    const kind = detect(text);
    if (kind === 'k6') {
      if (!K6) throw new Error('k6 parser not loaded.');
      return fromK6Model(K6.parse(text), name);
    }
    if (kind === 'jmeter-stats') return fromJmeterStatistics(JSON.parse(String(text).replace(/^﻿/, '')), name);
    if (kind === 'summary-csv') return fromSummaryCsv(text, name);
    if (kind === 'jtl') throw new Error('Raw JMeter results: analyse with JTL first.');
    if (kind === 'json-invalid') throw new Error('That looks like JSON but isn\'t valid JSON' + (name ? ' (' + name + ')' : '') + '.');
    throw new Error('Couldn\'t recognise ' + (name || 'this input') + '. Use a JMeter .jtl/.csv results file, JMeter\'s statistics.json, an Aggregate Report CSV, or k6 summary JSON.');
  }

  // ---------------------------------------------------------------- comparison

  const DEFAULT_RULES = {
    p95Pct: 10,      // regression when p95 grows by more than this %
    p99Pct: 15,
    avgPct: 10,
    errPts: 1,       // regression when error % grows by more than this many percentage points
    tputPct: 10,     // regression when throughput drops by more than this %
    minDeltaMs: 5,   // ignore time changes smaller than this (noise floor)
    minCount: 30,    // flag (but still compare) transactions with fewer samples than this
  };

  const METRICS = [
    { key: 'p95', name: 'p95', rule: 'p95Pct', kind: 'time' },
    { key: 'p99', name: 'p99', rule: 'p99Pct', kind: 'time' },
    { key: 'avg', name: 'avg', rule: 'avgPct', kind: 'time' },
    { key: 'errPct', name: 'error %', rule: 'errPts', kind: 'err' },
    { key: 'tput', name: 'throughput', rule: 'tputPct', kind: 'tput' },
  ];

  function pctChange(a, b) { return a > 0 ? ((b - a) / a) * 100 : (b > 0 ? Infinity : 0); }

  // Judges one metric. Returns {base, cand, delta, pct, status: 'worse'|'better'|'same'|'n/a'}
  function judge(m, a, b, rules) {
    const out = { base: a, cand: b, delta: b - a, pct: NaN, status: 'n/a' };
    if (isNaN(a) || isNaN(b)) return out;
    const lim = rules[m.rule];
    if (lim == null || lim === '' || isNaN(lim)) { out.status = 'same'; out.pct = pctChange(a, b); return out; }
    if (m.kind === 'err') {
      out.pct = b - a; // percentage points
      out.status = b - a > lim ? 'worse' : a - b > lim ? 'better' : 'same';
    } else if (m.kind === 'time') {
      out.pct = pctChange(a, b);
      const big = Math.abs(b - a) >= (rules.minDeltaMs || 0);
      out.status = big && out.pct > lim ? 'worse' : big && out.pct < -lim ? 'better' : 'same';
    } else {
      out.pct = pctChange(a, b);
      out.status = out.pct < -lim ? 'worse' : out.pct > lim ? 'better' : 'same';
    }
    return out;
  }

  function norm(s) { return String(s).trim().toLowerCase(); }

  /* compare(base, cand, rules) → { rows, total, counts, verdict, headline } */
  function compare(base, cand, rules) {
    rules = Object.assign({}, DEFAULT_RULES, rules || {});
    const bMap = new Map(base.transactions.map(t => [norm(t.label), t]));
    const cMap = new Map(cand.transactions.map(t => [norm(t.label), t]));
    const keys = [];
    for (const t of base.transactions) keys.push(norm(t.label));
    for (const t of cand.transactions) if (!bMap.has(norm(t.label))) keys.push(norm(t.label));

    function row(a, b, label) {
      const r = { label, base: a || null, cand: b || null, metrics: {}, status: 'same', reasons: [], lowSample: false };
      if (!a) { r.status = 'new'; return r; }
      if (!b) { r.status = 'missing'; return r; }
      for (const m of METRICS) r.metrics[m.key] = judge(m, a[m.key], b[m.key], rules);
      const worse = METRICS.filter(m => r.metrics[m.key].status === 'worse');
      const better = METRICS.filter(m => r.metrics[m.key].status === 'better');
      r.status = worse.length ? 'regression' : better.length ? 'improvement' : 'same';
      r.reasons = (worse.length ? worse : better).map(m => m.name);
      r.lowSample = (a.count < rules.minCount) || (b.count < rules.minCount);
      return r;
    }

    const rows = keys.map(k => { const a = bMap.get(k), b = cMap.get(k); return row(a, b, (b || a).label); });
    const total = base.total && cand.total ? row(base.total, cand.total, base.total.label === cand.total.label ? base.total.label : 'TOTAL') : null;
    const counts = { regression: 0, improvement: 0, same: 0, new: 0, missing: 0 };
    for (const r of rows) counts[r.status]++;
    // when there are no per-transaction rows, the total is the only thing to judge
    const judged = rows.length ? rows : (total ? [total] : []);
    if (!rows.length && total) counts[total.status]++;
    const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
    const parts = [plural(counts.regression, 'regression'), plural(counts.improvement, 'improvement')];
    if (counts.same) parts.push(counts.same + ' unchanged');
    if (counts.new) parts.push(counts.new + ' new');
    if (counts.missing) parts.push(counts.missing + ' missing');
    const matched = rows.length ? counts.regression + counts.improvement + counts.same : judged.length;
    const verdict = counts.regression ? 'fail' : matched ? 'pass' : 'warn';
    return { rows, total, counts, matched, verdict, headline: parts.join(', '), rules };
  }

  // ---------------------------------------------------------------- formatting

  function fmtMs(ms) {
    if (ms == null || isNaN(ms)) return 'n/a';
    if (ms >= 10000) return (ms / 1000).toFixed(1) + ' s';
    if (ms >= 1000) return (ms / 1000).toFixed(2) + ' s';
    if (ms >= 10) return Math.round(ms) + ' ms';
    return (Math.round(ms * 10) / 10) + ' ms';
  }

  function fmtVal(key, v) {
    if (v == null || isNaN(v)) return 'n/a';
    if (key === 'errPct') return (v === 0 ? '0' : v < 10 ? v.toFixed(2) : v.toFixed(1)) + '%';
    if (key === 'tput') return (v >= 100 ? v.toFixed(0) : v.toFixed(2)) + '/s';
    return fmtMs(v);
  }

  function fmtDelta(key, j) {
    if (!j || isNaN(j.pct)) return '';
    if (key === 'errPct') return (j.pct >= 0 ? '+' : '') + j.pct.toFixed(2) + ' pts';
    if (!isFinite(j.pct)) return 'new';
    return (j.pct >= 0 ? '+' : '') + j.pct.toFixed(1) + '%';
  }

  function md(s) { return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' '); }

  function toMarkdown(cmp, base, cand) {
    const icon = { regression: '🔴', improvement: '🟢', same: '⚪', new: '🆕', missing: '➖' };
    const o = [];
    o.push(`**Run comparison: ${md(cmp.headline)}**`);
    o.push('');
    o.push(`Baseline: ${md(base.source)}  `);
    o.push(`Candidate: ${md(cand.source)}`);
    o.push('');
    o.push('| | Transaction | p95 | p99 | avg | error % | throughput |');
    o.push('|---|---|---:|---:|---:|---:|---:|');
    const line = (r, bold) => {
      const name = bold ? '**' + md(r.label) + '**' : md(r.label);
      if (r.status === 'new' || r.status === 'missing') return `| ${icon[r.status]} | ${name} | ${r.status === 'new' ? 'only in candidate' : 'only in baseline'} | | | | |`;
      const cell = k => {
        const j = r.metrics[k];
        if (!j || isNaN(j.base) || isNaN(j.cand)) return 'n/a';
        const s = `${fmtVal(k, j.base)} → ${fmtVal(k, j.cand)} (${fmtDelta(k, j)})`;
        return j.status === 'worse' ? '**' + s + '**' : s;
      };
      return `| ${icon[r.status]} | ${name}${r.lowSample ? ' (few samples)' : ''} | ${cell('p95')} | ${cell('p99')} | ${cell('avg')} | ${cell('errPct')} | ${cell('tput')} |`;
    };
    for (const r of cmp.rows) o.push(line(r));
    if (cmp.total) o.push(line(cmp.total, true));
    const R = cmp.rules;
    o.push('');
    o.push(`_Regression rules: p95 +${R.p95Pct}%, p99 +${R.p99Pct}%, avg +${R.avgPct}%, error rate +${R.errPts} pts, throughput −${R.tputPct}%; time changes under ${R.minDeltaMs} ms ignored. Compared at pawansinha.com.au/tools/compare-runs/_`);
    return o.join('\n');
  }

  const api = { fromJtl, fromJmeterStatistics, fromSummaryCsv, fromK6Model, parseRun, detect, compare, judge, toMarkdown,
    fmtVal, fmtDelta, fmtMs, DEFAULT_RULES, METRICS, parseCsvSimple, tagLabel };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CompareRuns = api;
})(typeof self !== 'undefined' ? self : this);
