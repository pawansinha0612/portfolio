// Tests for docs/tools/compare-runs/compare.js. Run: node toolkit-tests/test-compare.js
'use strict';
const path = require('path');
const assert = require('assert');
const docs = path.join(__dirname, '..', 'docs', 'tools');
const C = require(path.join(docs, 'compare-runs', 'compare.js'));
const J = require(path.join(docs, 'jtl-analyser', 'jtl.js'));
const K6 = require(path.join(docs, 'k6-results', 'explain.js'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e)); }
}
const near = (a, b, eps) => assert.ok(Math.abs(a - b) <= (eps || 1e-9), `expected ${b}, got ${a}`);

// ---------------------------------------------------------------- fixtures

const k6Export = (p95Login, failRate) => JSON.stringify({
  state: { testRunDurationMs: 60000 },
  metrics: {
    http_reqs: { count: 6000, rate: 100 },
    'http_reqs{name:login}': { count: 3000, rate: 50 },
    http_req_failed: { passes: 6, fails: 5994, value: 0.001 },
    'http_req_failed{name:login}': { passes: Math.round(3000 * failRate), fails: 3000 - Math.round(3000 * failRate), value: failRate },
    http_req_duration: { avg: 100, min: 10, med: 90, max: 900, 'p(90)': 180, 'p(95)': 220 },
    'http_req_duration{expected_response:true}': { avg: 99, min: 10, med: 90, max: 900, 'p(90)': 180, 'p(95)': 220 },
    'http_req_duration{name:login}': { avg: 150, min: 20, med: 120, max: 900, 'p(90)': 200, 'p(95)': p95Login, thresholds: { 'p(95)<500': false } },
    'http_req_duration{name:search}': { avg: 80, min: 10, med: 70, max: 400, 'p(90)': 120, 'p(95)': 150 },
    http_req_waiting: { avg: 95, min: 9, med: 85, max: 890, 'p(90)': 175, 'p(95)': 215 },
    iteration_duration: { avg: 1200, min: 1000, med: 1100, max: 3000, 'p(90)': 1400, 'p(95)': 1500 },
    checkout_time: { avg: 300, min: 100, med: 280, max: 1200, 'p(90)': 450, 'p(95)': 500 },
    vus: { value: 10, min: 1, max: 10 },
  },
});

const handleSummary = JSON.stringify({
  state: { testRunDurationMs: 30000 },
  metrics: {
    http_reqs: { type: 'counter', contains: 'default', values: { count: 3000, rate: 100 } },
    http_req_failed: { type: 'rate', contains: 'default', values: { rate: 0.02, passes: 60, fails: 2940 } },
    http_req_duration: { type: 'trend', contains: 'time', values: { avg: 96.4, min: 22.1, med: 71.3, max: 1302.4, 'p(90)': 168.5, 'p(95)': 231.9, 'p(99)': 480.2 } },
    'http_req_duration{group:::Checkout}': { type: 'trend', contains: 'time', values: { avg: 200, min: 50, med: 180, max: 900, 'p(90)': 300, 'p(95)': 350, 'p(99)': 700 }, thresholds: { 'p(95)<400': { ok: true } } },
    group_duration: { type: 'trend', contains: 'time', values: { avg: 500, min: 100, med: 450, max: 2000, 'p(90)': 800, 'p(95)': 900 } },
    'group_duration{group:::Browse}': { type: 'trend', contains: 'time', values: { avg: 400, min: 100, med: 380, max: 1500, 'p(90)': 600, 'p(95)': 700 }, thresholds: { 'p(95)<1000': { ok: true } } },
  },
});

const statsJson = JSON.stringify({
  Total: { transaction: 'Total', sampleCount: 1000, errorCount: 10, errorPct: 1, meanResTime: 200, medianResTime: 180, minResTime: 10, maxResTime: 2000, pct1ResTime: 300, pct2ResTime: 400, pct3ResTime: 800, throughput: 16.6, receivedKBytesPerSec: 10, sentKBytesPerSec: 1 },
  Login: { transaction: 'Login', sampleCount: 500, errorCount: 10, errorPct: 2, meanResTime: 250, medianResTime: 230, minResTime: 10, maxResTime: 2000, pct1ResTime: 350, pct2ResTime: 450, pct3ResTime: 900, throughput: 8.3, receivedKBytesPerSec: 5, sentKBytesPerSec: 0.5 },
  Search: { transaction: 'Search', sampleCount: 500, errorCount: 0, errorPct: 0, meanResTime: 150, medianResTime: 130, minResTime: 10, maxResTime: 700, pct1ResTime: 250, pct2ResTime: 300, pct3ResTime: 500, throughput: 8.3, receivedKBytesPerSec: 5, sentKBytesPerSec: 0.5 },
});

const aggregateCsv = 'Label,# Samples,Average,Median,90% Line,95% Line,99% Line,Min,Max,Error %,Throughput,Received KB/sec,Sent KB/sec\n' +
  'Login,500,250,230,350,450,900,10,2000,2.00%,8.3/sec,5,0.5\n' +
  '"Search, filtered",500,150,130,250,300,500,10,700,0.00%,498/min,5,0.5\n' +
  'TOTAL,1000,200,180,300,400,800,10,2000,1.00%,16.6/sec,10,1\n';

// ---------------------------------------------------------------- tests

console.log('Input detection and parsing');

test('detect() recognises each format', () => {
  assert.strictEqual(C.detect(k6Export(300, 0.001)), 'k6');
  assert.strictEqual(C.detect(handleSummary), 'k6');
  assert.strictEqual(C.detect(statsJson), 'jmeter-stats');
  assert.strictEqual(C.detect(aggregateCsv), 'summary-csv');
  assert.strictEqual(C.detect('timeStamp,elapsed,label\n1,2,a'), 'jtl');
  assert.strictEqual(C.detect('<?xml version="1.0"?><testResults>'), 'jtl');
  assert.strictEqual(C.detect('1700000000000,150,Home,200,OK'), 'jtl');
  assert.strictEqual(C.detect('{"foo":1}'), 'json-unknown');
  assert.strictEqual(C.detect('{bad'), 'json-invalid');
  assert.strictEqual(C.detect('hello'), null);
});

test('k6 --summary-export: per-name rows, custom trend, skips sub-phases and expected_response', () => {
  const run = C.parseRun(k6Export(300, 0.01), 'a.json', K6);
  const labels = run.transactions.map(t => t.label).sort();
  assert.deepStrictEqual(labels, ['checkout_time', 'login', 'search']);
  const login = run.transactions.find(t => t.label === 'login');
  assert.strictEqual(login.p95, 300);
  near(login.errPct, 1);
  assert.strictEqual(login.tput, 50);
  assert.strictEqual(login.count, 3000);
  assert.ok(isNaN(login.p99));
  assert.strictEqual(run.total.label, 'All HTTP requests');
  assert.strictEqual(run.total.tput, 100);
  near(run.total.errPct, 0.1);
  assert.ok(run.notes.some(n => /p\(99\)/.test(n)));
  const search = run.transactions.find(t => t.label === 'search');
  assert.ok(isNaN(search.count) && isNaN(search.errPct), 'no http_reqs{name:search} → unknown, not zero');
});

test('k6 handleSummary JSON: group sub-metrics, p99, throughput from rate', () => {
  const run = C.parseRun(handleSummary, 'h.json', K6);
  const labels = run.transactions.map(t => t.label).sort();
  assert.deepStrictEqual(labels, ['group Browse', 'group Checkout']);
  assert.strictEqual(run.total.p99, 480.2);
  near(run.total.errPct, 2);
  assert.strictEqual(run.total.tput, 100);
  assert.ok(/handleSummary/.test(run.source));
});

test('k6 text summary (via K6Explain) gives an overall row', () => {
  const run = C.parseRun(K6.EXAMPLES.v1, 'v1.txt', K6);
  assert.ok(run.total && run.total.p95 > 0);
});

test('k6 tag labels', () => {
  assert.strictEqual(C.tagLabel('name:login'), 'login');
  assert.strictEqual(C.tagLabel('group:::Checkout::Pay'), 'group Checkout › Pay');
  assert.strictEqual(C.tagLabel('name:login,method:POST'), 'login, method=POST');
});

test('JMeter statistics.json', () => {
  const run = C.parseRun(statsJson, 's.json');
  assert.strictEqual(run.transactions.length, 2);
  assert.strictEqual(run.total.label, 'TOTAL');
  const login = run.transactions.find(t => t.label === 'Login');
  assert.strictEqual(login.p95, 450); assert.strictEqual(login.p99, 900); assert.strictEqual(login.errPct, 2);
});

test('JMeter Aggregate Report CSV: quoted label, % and /sec /min throughput', () => {
  const run = C.parseRun(aggregateCsv, 'agg.csv');
  const s = run.transactions.find(t => t.label === 'Search, filtered');
  assert.strictEqual(s.p95, 300);
  near(s.tput, 8.3);
  assert.strictEqual(run.transactions[0].errPct, 2);
  assert.strictEqual(run.total.tput, 16.6);
});

test('summary CSV exported by the JTL analyser round-trips', () => {
  const r = J.analyseText(J.generateSample({ rows: 3000 }));
  const run = C.parseRun(J.toSummaryCsv(r), 'export.csv');
  const a = r.labels[4], b = run.transactions[4];
  assert.strictEqual(b.label, a.label);
  assert.strictEqual(b.p95, a.p95);
  near(b.errPct, +a.errPct.toFixed(2));
  assert.strictEqual(run.total.count, r.total.count);
});

test('raw JTL result via fromJtl', () => {
  const r = J.analyseText(J.generateSample({ rows: 3000 }));
  const run = C.fromJtl(r, 'x.jtl');
  assert.strictEqual(run.transactions.length, 5);
  assert.strictEqual(run.total.p99, r.total.p99);
});

console.log('Regression rules');

const R = C.DEFAULT_RULES;
const tm = C.METRICS.find(m => m.key === 'p95'), em = C.METRICS.find(m => m.key === 'errPct'), tp = C.METRICS.find(m => m.key === 'tput');

test('time: over threshold = worse, under = same, big drop = better', () => {
  assert.strictEqual(C.judge(tm, 200, 221, R).status, 'worse');
  assert.strictEqual(C.judge(tm, 200, 220, R).status, 'same', 'exactly +10% is not a regression');
  assert.strictEqual(C.judge(tm, 200, 170, R).status, 'better');
});

test('time: noise floor ignores tiny absolute changes', () => {
  assert.strictEqual(C.judge(tm, 10, 14, R).status, 'same', '+40% but only 4 ms');
  assert.strictEqual(C.judge(tm, 10, 16, R).status, 'worse');
});

test('error rate is judged in percentage points', () => {
  assert.strictEqual(C.judge(em, 0.5, 1.4, R).status, 'same');
  assert.strictEqual(C.judge(em, 0.5, 1.6, R).status, 'worse');
  assert.strictEqual(C.judge(em, 3, 1, R).status, 'better');
  near(C.judge(em, 0.5, 1.6, R).pct, 1.1);
});

test('throughput: a drop is worse', () => {
  assert.strictEqual(C.judge(tp, 100, 85, R).status, 'worse');
  assert.strictEqual(C.judge(tp, 100, 95, R).status, 'same');
  assert.strictEqual(C.judge(tp, 100, 120, R).status, 'better');
});

test('missing values are n/a, empty rule disables a metric', () => {
  assert.strictEqual(C.judge(tm, NaN, 200, R).status, 'n/a');
  assert.strictEqual(C.judge(tm, 100, 500, Object.assign({}, R, { p95Pct: '' })).status, 'same');
});

console.log('Comparison and verdict');

test('k6 baseline vs candidate: login regressed on p95 and errors', () => {
  const a = C.parseRun(k6Export(300, 0.001), 'base.json', K6);
  const b = C.parseRun(k6Export(420, 0.03), 'cand.json', K6);
  const cmp = C.compare(a, b);
  const login = cmp.rows.find(r => r.label === 'login');
  assert.strictEqual(login.status, 'regression');
  assert.deepStrictEqual(login.reasons, ['p95', 'error %']);
  assert.strictEqual(cmp.counts.regression, 1);
  assert.strictEqual(cmp.counts.same, 2);
  assert.strictEqual(cmp.verdict, 'fail');
  assert.ok(/^1 regression, 0 improvements, 2 unchanged/.test(cmp.headline), cmp.headline);
});

test('new and missing transactions, case-insensitive matching, improvement', () => {
  const run = (rows) => ({ source: 'x', transactions: rows, total: null });
  const t = (label, p95, n) => ({ label, count: n || 100, avg: p95 / 2, p95, p99: p95 * 2, errPct: 0, tput: 10 });
  const cmp = C.compare(run([t('Login', 300), t('Old page', 100), t('Search', 400)]), run([t('login ', 300), t('Search', 200), t('New page', 50, 5)]));
  const byStatus = s => cmp.rows.filter(r => r.status === s).map(r => r.label);
  assert.deepStrictEqual(byStatus('missing'), ['Old page']);
  assert.deepStrictEqual(byStatus('new'), ['New page']);
  assert.deepStrictEqual(byStatus('improvement'), ['Search']);
  assert.deepStrictEqual(byStatus('same'), ['login ']);
  assert.strictEqual(cmp.verdict, 'pass');
  assert.strictEqual(cmp.headline, '0 regressions, 1 improvement, 1 unchanged, 1 new, 1 missing');
});

test('no names in common → warn, not pass', () => {
  const run = l => ({ source: 'x', transactions: [{ label: l, count: 100, avg: 1, p95: 1, p99: 1, errPct: 0, tput: 1 }], total: { label: 'TOTAL', count: 100, avg: 1, p95: 1, p99: 1, errPct: 0, tput: 1 } });
  const cmp = C.compare(run('A'), run('B'));
  assert.strictEqual(cmp.verdict, 'warn');
  assert.strictEqual(cmp.matched, 0);
});

test('low sample counts are flagged', () => {
  const run = n => ({ source: 'x', transactions: [{ label: 'A', count: n, avg: 1, p95: 1, p99: 1, errPct: 0, tput: 1 }], total: null });
  assert.strictEqual(C.compare(run(10), run(100)).rows[0].lowSample, true);
  assert.strictEqual(C.compare(run(100), run(100)).rows[0].lowSample, false);
});

test('total-only comparison (k6 without tags) still gives a verdict', () => {
  const k = p95 => JSON.stringify({ metrics: { http_reqs: { count: 10, rate: 1 }, http_req_duration: { avg: 1, med: 1, max: 1, min: 1, 'p(90)': 1, 'p(95)': p95 } } });
  const cmp = C.compare(C.parseRun(k(100), 'a', K6), C.parseRun(k(150), 'b', K6));
  assert.strictEqual(cmp.rows.length, 0);
  assert.strictEqual(cmp.total.status, 'regression');
  assert.strictEqual(cmp.verdict, 'fail');
  assert.strictEqual(cmp.counts.regression, 1);
});

test('custom rules change the outcome', () => {
  const a = C.parseRun(k6Export(300, 0.001), 'a', K6), b = C.parseRun(k6Export(320, 0.001), 'b', K6);
  assert.strictEqual(C.compare(a, b).counts.regression, 0);
  assert.strictEqual(C.compare(a, b, { p95Pct: 5 }).counts.regression, 1);
});

test('JTL vs JTL end to end + markdown', () => {
  const base = C.fromJtl(J.analyseText(J.generateSample({ rows: 4000, seed: 1 })), 'base.jtl');
  // candidate: same generator, but every Checkout row is 50% slower
  const slow = J.generateSample({ rows: 4000, seed: 1 }).split('\n').map((l, i) => {
    if (!i || !l.includes(',05 Checkout,')) return l;
    const f = l.split(','); f[1] = String(Math.round(+f[1] * 1.5)); return f.join(',');
  }).join('\n');
  const cand = C.fromJtl(J.analyseText(slow), 'cand.jtl');
  const cmp = C.compare(base, cand);
  const co = cmp.rows.find(r => r.label === '05 Checkout');
  assert.strictEqual(co.status, 'regression');
  assert.ok(co.metrics.p95.pct > 40);
  assert.strictEqual(cmp.rows.filter(r => r.status === 'regression').length, 1);
  const md = C.toMarkdown(cmp, base, cand);
  assert.ok(md.startsWith('**Run comparison: 1 regression'));
  assert.ok(md.includes('| 🔴 | 05 Checkout |'));
  assert.ok(md.includes('| ⚪ | **TOTAL** |') || md.includes('| 🔴 | **TOTAL** |'));
  assert.ok(md.includes('Regression rules: p95 +10%'));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
