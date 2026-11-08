// Tests for docs/tools/perf-studio/studio.js. Run: node toolkit-tests/test-perf-studio.js
// Uses the real converter, k6 explainer, JTL analyser and workload model that the page loads.
'use strict';
const path = require('path');
const assert = require('assert');
const docs = path.join(__dirname, '..', 'docs', 'tools');
const S = require(path.join(docs, 'perf-studio', 'studio.js'));
const K = require(path.join(docs, 'openapi-to-k6', 'convert.js'));
const E = require(path.join(docs, 'k6-results', 'explain.js'));
const J = require(path.join(docs, 'jtl-analyser', 'jtl.js'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e)); }
}
const near = (a, b, tol, m) => assert.ok(Math.abs(a - b) <= tol, `${m || ''} expected ${b} ± ${tol}, got ${a}`);
const ids = list => list.map(s => s.id);

// ---------------------------------------------------------------- fixtures

const petOps = K.listOperations(K.EXAMPLES.swagger2);
const eps = petOps.map(o => ({ id: o.id, method: o.method, path: o.path, share: o.method === 'GET' ? 3 : 1 }));

// A JMeter CSV: 4 minutes, threads ramp 5 → 40. Throughput stops growing at 20 threads, latency and errors climb.
function rampJtl() {
  const lines = ['timeStamp,elapsed,label,responseCode,responseMessage,threadName,success,failureMessage,bytes,sentBytes,grpThreads,allThreads'];
  const t0 = Date.UTC(2026, 10, 1, 0, 0, 0);
  let seq = 0;
  for (let s = 0; s < 240; s++) {
    const threads = Math.min(40, 5 + Math.floor(s / 6));
    const rps = Math.min(threads, 20);              // capacity: 20 req/s
    const queue = Math.max(0, threads - 20);
    for (let i = 0; i < rps; i++) {
      const label = i % 4 === 0 ? 'POST /orders' : 'GET /products';
      const base = label === 'POST /orders' ? 180 : 90;
      const ms = Math.round(base * (1 + queue / 6) + ((seq * 37) % 50));
      const fail = label === 'POST /orders' && queue > 10 && seq % 5 === 0;
      lines.push([t0 + s * 1000 + i * 40, ms, label, fail ? 503 : 200, fail ? 'Service Unavailable' : 'OK', 'TG 1-' + (i + 1), !fail, '', 2048, 300, threads, threads].join(','));
      seq++;
    }
  }
  return lines.join('\n') + '\n';
}

// A healthy k6 handleSummary: everything well inside the targets, per-endpoint sub-metrics, 30 minutes.
function healthyK6() {
  const tr = (med, p95, p99) => ({ avg: med * 1.1, min: med / 3, med, max: p99 * 2, 'p(90)': p95 * 0.9, 'p(95)': p95, 'p(99)': p99 });
  const metrics = {
    http_reqs: { type: 'counter', values: { count: 90000, rate: 50 } },
    http_req_failed: { type: 'rate', values: { rate: 0.001, passes: 90, fails: 89910 } },
    http_req_duration: { type: 'trend', values: tr(120, 260, 410) },
    checks: { type: 'rate', values: { rate: 0.999, passes: 89910, fails: 90 } },
    vus: { type: 'gauge', values: { value: 10, min: 10, max: 60 } },
    vus_max: { type: 'gauge', values: { value: 100, min: 100, max: 100 } },
    dropped_iterations: { type: 'counter', values: { count: 0, rate: 0 } },
    'http_req_duration{name:/a}': { type: 'trend', values: tr(100, 230, 380) },
    'http_req_failed{name:/a}': { type: 'rate', values: { rate: 0.001, passes: 45, fails: 44955 } },
    'http_req_duration{name:/b}': { type: 'trend', values: tr(140, 290, 450) },
    'http_req_failed{name:/b}': { type: 'rate', values: { rate: 0.001, passes: 45, fails: 44955 } },
  };
  return JSON.stringify({ state: { testRunDurationMs: 1800000 }, metrics });
}

// ---------------------------------------------------------------- estimate

console.log('Estimate');
test("users basis: Little's Law gives req/s and VUs", () => {
  const e = S.estimate({ peakUsers: 500, thinkTimeS: 5, respTimeS: 0.5, endpoints: eps });
  near(e.targetRps, 500 / 5.5, 1e-9, 'rps');
  assert.strictEqual(e.vus, 500);
  assert.strictEqual(e.maxVUs, 1000);
  const shares = e.endpoints.reduce((a, x) => a + x.tps, 0);
  near(shares, e.targetRps, 1e-9, 'endpoint rates add up');
  const get = e.endpoints.find(x => x.id === 'GET /pet/findByStatus'), post = e.endpoints.find(x => x.id === 'POST /pet');
  near(get.tps / post.tps, 3, 1e-9, 'mix 3:1');
});

test('requests/hour basis and a scaled environment', () => {
  const e = S.estimate({ basis: 'requests', peakPerHour: 360000, thinkTimeS: 2, respTimeS: 0.5, environment: 'scaled', envScalePct: 25 });
  near(e.peakRps, 100, 1e-9);
  near(e.peakUsers, 250, 1e-9, "Little's Law users");
  near(e.targetRps, 25, 1e-9, 'scaled to 25%');
  assert.strictEqual(e.vus, 63);
  assert.ok(e.warnings.some(w => /25% of production/.test(w)));
  assert.strictEqual(e.endpoints.length, 1, 'no definition → one "All requests" endpoint');
});

test('test plan: five types, durations, peak loads and request totals', () => {
  const e = S.estimate({ peakUsers: 100, thinkTimeS: 0.5, respTimeS: 0.5, soakHours: 2 });
  assert.deepStrictEqual(e.tests.map(t => t.type), ['smoke', 'load', 'stress', 'spike', 'soak']);
  const by = Object.fromEntries(e.tests.map(t => [t.type, t]));
  assert.strictEqual(by.smoke.durationMin, 2); assert.strictEqual(by.smoke.peakVUs, 2);
  assert.strictEqual(by.load.durationMin, 42); assert.strictEqual(by.load.peakPct, 100);
  assert.strictEqual(by.stress.peakPct, 300); assert.strictEqual(by.stress.peakVUs, 300);
  assert.strictEqual(by.spike.peakPct, 200);
  assert.strictEqual(by.soak.durationMin, 132); assert.strictEqual(by.soak.peakPct, 80);
  // load: 10 min ramp (half) + 30 min full + 2 min down (half) = 36 full minutes at 100 req/s
  near(by.load.requests, 100 * 60 * 36, 1e-6, 'load test requests');
});

test('data, generator and effort follow the inputs', () => {
  const e = S.estimate({ peakUsers: 500, endpoints: eps, auth: true });
  assert.strictEqual(e.data.accounts, Math.ceil(1500 * 1.1), 'one account per stress-peak VU + 10%');
  assert.deepStrictEqual(e.data.writes.map(w => w.id).sort(), ['DELETE /pet/{petId}', 'POST /pet']);
  assert.ok(e.data.idPools.some(p => p.id === 'GET /pet/{petId}' && p.ids === 5000));
  assert.ok(e.generator.vcpu >= 2 && e.generator.memGB >= 2);
  const noAuth = S.estimate({ peakUsers: 500, endpoints: eps, auth: false });
  assert.strictEqual(noAuth.data.accounts, 0);
  assert.ok(noAuth.effortDays < e.effortDays, 'login handling adds effort');
  e.effort.forEach(x => assert.strictEqual(x.days * 2, Math.round(x.days * 2), 'half days'));
  assert.strictEqual(e.effortDays, e.effort.reduce((a, x) => a + x.days, 0));
  assert.ok(e.assumptions.length >= 5);
});

test('bad input gives an error, not NaN', () => {
  assert.ok(S.estimate({ peakUsers: 0 }).error);
  assert.ok(S.estimate({ basis: 'requests', peakPerHour: '' }).error);
});

// ---------------------------------------------------------------- k6 script

console.log('k6 script');
test('sized from the estimate, with per-endpoint thresholds and p(99)', () => {
  const ops = petOps.filter(o => o.method === 'GET');
  const e = S.estimate({ peakUsers: 300, thinkTimeS: 1, respTimeS: 0.5, endpoints: ops.map(o => ({ id: o.id, method: o.method, path: o.path })), targetP95Ms: 600, errorPct: 2 });
  const r = S.k6Script(K.EXAMPLES.swagger2, { estimate: e, include: ops.map(o => o.id) });
  assert.ok(!r.error, r.error);
  assert.ok(r.script.includes("executor: 'constant-arrival-rate'"));
  assert.ok(r.script.includes(`rate: ${Math.round(200 / ops.length)},`), 'iterations/s = req/s ÷ endpoints');
  assert.ok(r.script.includes("summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],"));
  assert.ok(r.script.includes("'http_req_duration{name:/pet/{petId}}': ['p(95)<600'],"));
  assert.ok(r.script.includes("'http_req_failed{name:/pet/{petId}}': ['rate<0.02'],"));
  assert.ok(r.script.includes(`preAllocatedVUs: ${e.vus},`) && r.script.includes(`maxVUs: ${e.maxVUs},`));
  // the converter output itself is untouched apart from the additions
  const plain = K.convert(K.EXAMPLES.swagger2, { include: ops.map(o => o.id) });
  assert.ok(plain.script.includes('export default function'));
});

test('without an estimate it is the plain converter output', () => {
  const r = S.k6Script(K.EXAMPLES.swagger2, { k6: { vus: 2, duration: '1m' } });
  assert.strictEqual(r.script, K.convert(K.EXAMPLES.swagger2, { vus: 2, duration: '1m' }).script);
  assert.ok(S.k6Script('not an api', {}).error);
});

// ---------------------------------------------------------------- results

console.log('Results');
test('k6 handleSummary: totals, per-endpoint stats (count from passes + fails), VUs, dropped', () => {
  const r = S.analyseText(S.sampleK6());
  assert.strictEqual(r.source, 'k6');
  assert.strictEqual(r.total.count, 151200);
  near(r.total.p99, 4120.3, 1e-9);
  near(r.total.errPct, 2.01, 1e-9);
  assert.deepStrictEqual(r.endpoints.map(e => e.name), ['/books', '/books/{bookId}', '/cart', '/cart/items', '/health']);
  const items = r.endpoints.find(e => e.name === '/cart/items');
  assert.strictEqual(items.count, 15120);
  near(items.tps, 8.4, 1e-9, 'tps from count / duration');
  assert.deepStrictEqual(r.vus, { max: 240, allowed: 240 });
  assert.strictEqual(r.dropped, 1260);
  assert.strictEqual(r.timeline, null);
});

test('k6 --summary-export and text summaries are read through the k6 explainer', () => {
  const x = S.analyseText(E.EXAMPLES.exportJson);
  assert.strictEqual(x.format, '--summary-export JSON');
  near(x.total.p95, 4120.9, 1e-9);
  assert.ok(x.warnings.some(w => /per-endpoint/.test(w)));
  const t = S.analyseText(E.EXAMPLES.v1);
  assert.ok(isFinite(t.total.p95));
});

test('JMeter CSV: per-label exact percentiles and a timeline with threads', () => {
  const r = S.analyseText(rampJtl());
  assert.strictEqual(r.source, 'jmeter');
  assert.deepStrictEqual(r.endpoints.map(e => e.name).sort(), ['GET /products', 'POST /orders']);
  const direct = J.analyseText(rampJtl());
  assert.strictEqual(r.total.p95, direct.total.p95, 'same numbers as the JTL analyser');
  assert.ok(r.timeline.length > 100 && r.timeline.every(p => p.threads > 0));
  assert.strictEqual(r.vus.max, 40);
  assert.ok(r.errors.some(e => e.code === '503'));
});

test('unknown input explains what to paste', () => {
  assert.throws(() => S.analyseText('hello world'), /doesn't look like k6 or JMeter/);
  assert.throws(() => S.analyseText(''), /Paste or upload/);
});

// ---------------------------------------------------------------- evaluate

console.log('Evaluate');
test('k6 sample: targets missed, errors clustered, VUs maxed, long tail → no-go', () => {
  const ev = S.evaluate(S.analyseText(S.sampleK6()), { p95Ms: 800, errorPct: 1, targetRps: 100 });   // ran 84 req/s
  const got = ids(ev.signals);
  for (const id of ['p95-total', 'errors-total', 'error-cluster', 'vus-maxed', 'p95-endpoints', 'tail', 'tps-target', 'checks']) assert.ok(got.includes(id), 'has ' + id);
  assert.strictEqual(ev.verdict.code, 'no-go');
  const cl = ev.signals.find(s => s.id === 'error-cluster');
  assert.deepStrictEqual(cl.endpoints, ['/cart/items']);
  assert.ok(/\/cart\/items/.test(cl.metric) && /18\.7%/.test(cl.metric), 'cites the measured numbers: ' + cl.metric);
  const row = ev.rows.find(r => r.name === '/health');
  assert.strictEqual(row.p95Ok, true); assert.strictEqual(row.errOk, true);
});

test('JMeter ramp: latency and errors rise with load, throughput plateaus, 5xx', () => {
  const ev = S.evaluate(S.analyseText(rampJtl()), { p95Ms: 2000, errorPct: 5 });
  const got = ids(ev.signals);
  for (const id of ['latency-load', 'plateau', 'http-5xx']) assert.ok(got.includes(id), 'has ' + id + ' in ' + got.join(','));
  const pl = ev.signals.find(s => s.id === 'plateau');
  assert.ok(/threads rose from about \d+ to 40/.test(pl.metric), pl.metric);
  assert.ok(/20(\.0)? req\/s/.test(pl.metric), 'plateau at the 20 req/s capacity: ' + pl.metric);
});

test('healthy run → go, no signals, endpoint targets matched by tag name', () => {
  const ev = S.evaluate(S.analyseText(healthyK6()), { p95Ms: 500, errorPct: 1, targetRps: 50, endpointTargets: { '/a': 25, '/b': 25 } });
  assert.deepStrictEqual(ids(ev.signals), []);
  assert.strictEqual(ev.verdict.code, 'go');
  near(ev.rows.find(r => r.name === '/a').tpsPct, 100, 1e-9);
  const recs = S.recommend(ev);
  assert.strictEqual(recs.length, 1);
  assert.ok(/stress test/.test(recs[0].actions.join(' ')));
});

test('endpointTargets maps estimate endpoints to k6 tag names (paths)', () => {
  const e = S.estimate({ peakUsers: 110, thinkTimeS: 0.5, respTimeS: 0.5, endpoints: [{ method: 'GET', path: '/books', share: 1 }, { method: 'POST', path: '/books', share: 1 }] });
  const t = S.endpointTargets(e);
  near(t['/books'], 110, 1e-9, 'GET + POST share the /books tag');
  near(t['GET /books'], 55, 1e-9);
});

// ---------------------------------------------------------------- recommendations and report

console.log('Recommendations and report');
test('every recommendation cites the measured numbers that triggered it', () => {
  const ev = S.evaluate(S.analyseText(S.sampleK6()), { p95Ms: 800, errorPct: 1 });
  const recs = S.recommend(ev);
  assert.ok(recs.length >= 4);
  for (const r of recs) {
    assert.ok(r.because.length && r.because.every(b => /\d/.test(b)), 'because has numbers: ' + r.because);
    assert.ok(r.actions.length);
  }
  assert.ok(recs.some(r => /pool/i.test(r.title)));
  assert.ok(recs.some(r => /database/i.test(r.title) && r.endpoints.includes('/cart/items')));
  assert.strictEqual(recs[0].level, 'bad', 'blocking first');
});

test('report: HTML is a full escaped page; Markdown has every section', () => {
  const results = S.analyseText(S.sampleK6());
  const evaluation = S.evaluate(results, { p95Ms: 800, errorPct: 1, targetRps: 90 });
  const input = { results, evaluation, recommendations: S.recommend(evaluation), estimate: S.estimate({ peakUsers: 500 }),
    meta: { project: 'Shop <script>alert(1)</script>', release: '2.4', environment: 'Perf', date: '8 November 2026' } };
  const html = S.reportHtml(input);
  assert.ok(html.startsWith('<!doctype html>') && html.includes('</html>'));
  assert.ok(!html.includes('<script>alert(1)</script>') && html.includes('&lt;script&gt;'), 'escaped');
  assert.ok(html.includes('NO-GO') && html.includes('@page'));
  const md = S.reportMarkdown(input);
  for (const h of ['## Verdict: NO-GO', '## Key numbers', '## Endpoints (slowest first)', '## Top risks', '## Recommendations', '## Next steps']) assert.ok(md.includes(h), h);
  assert.ok(md.includes('| /cart/items |'));
  assert.ok(md.includes('target 90.9 req/s') || md.includes('target 90.9'), 'estimate target in the key numbers');
});

test('JTL sample helper gives a file the analyser reads', () => {
  const r = S.analyseText(S.sampleJtl({ rows: 2000 }));
  assert.strictEqual(r.total.count, 2000);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
