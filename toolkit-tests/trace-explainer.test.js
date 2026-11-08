// Tests for docs/tools/trace-explainer/trace.js. Run: node toolkit-tests/trace-explainer.test.js
'use strict';
const path = require('path');
const assert = require('assert');
const T = require(path.join(__dirname, '..', 'docs', 'tools', 'trace-explainer', 'trace.js'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e)); }
}
// tiny trace builder: times in ms
function span(id, parent, service, op, a, b, extra) {
  return Object.assign({ traceId: 't1', id, parent: parent || '', service, op, start: a * 1000, dur: (b - a) * 1000, kind: '', error: false, msg: '', attrs: {}, events: [] }, extra || {});
}
const byOp = (r, op) => r.spans.find(s => s.op === op);

// ---------------------------------------------------------------- helpers
test('ids: hex is kept, base64 OTLP ids become hex', () => {
  assert.strictEqual(T.normId('5B8EFFF798038103D269B633813FC60C'), '5b8efff798038103d269b633813fc60c');
  assert.strictEqual(T.normId('AAECAwQFBgc='), '0001020304050607');
  assert.strictEqual(T.normId('W47/95gDgQPSabYzgT/GDA=='), '5b8efff798038103d269b633813fc60c');
  assert.strictEqual(T.normId('abc'), '0000000000000abc');
});
test('nanosecond strings keep microsecond precision', () => {
  assert.strictEqual(T.nanoToMicro('1794142800123456789'), 1794142800123456.789);
  assert.strictEqual(T.nanoToMicro(5000), 5);
});
test('durations format as µs, ms and s', () => {
  assert.strictEqual(T.fmtDur(450), '450 µs');
  assert.strictEqual(T.fmtDur(12345), '12.3 ms');
  assert.strictEqual(T.fmtDur(1840000), '1.84 s');
});

// ---------------------------------------------------------------- parsing
test('Jaeger sample: format, services, parent links via references', () => {
  const p = T.parse(T.samples.sampleJaeger());
  assert.strictEqual(p.format, 'jaeger');
  assert.ok(p.spans.length > 25);
  assert.ok(p.spans.some(s => s.service === 'fraud-svc'));
  const roots = p.spans.filter(s => !s.parent);
  assert.strictEqual(roots.length, 1);
  const err = p.spans.find(s => s.error);
  assert.ok(err && /upstream connect error/.test(err.msg), 'error message from the Jaeger log');
});
test('Zipkin sample and OTLP sample are detected', () => {
  assert.strictEqual(T.parse(T.samples.sampleZipkin()).format, 'zipkin');
  const o = T.parse(T.samples.sampleOtlp());
  assert.strictEqual(o.format, 'otlp');
  assert.ok(o.spans.find(s => s.error).msg.includes('upstream'));
});
test('OTLP with base64 ids, string kinds, nanosecond times and status codes', () => {
  const doc = { resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'api' } }] }, scopeSpans: [{ spans: [
    { traceId: 'W47/95gDgQPSabYzgT/GDA==', spanId: 'AAECAwQFBgc=', name: 'GET /a', kind: 'SPAN_KIND_SERVER', startTimeUnixNano: '1000000000', endTimeUnixNano: '1100000000' },
    { traceId: 'W47/95gDgQPSabYzgT/GDA==', spanId: 'AQECAwQFBgc=', parentSpanId: 'AAECAwQFBgc=', name: 'SELECT', kind: 3, startTimeUnixNano: '1010000000', endTimeUnixNano: '1090000000',
      status: { code: 'STATUS_CODE_ERROR', message: 'deadlock detected' }, attributes: [{ key: 'db.system', value: { stringValue: 'postgresql' } }] },
  ] }] }] };
  const p = T.parse(JSON.stringify(doc));
  assert.strictEqual(p.spans.length, 2);
  assert.strictEqual(p.spans[1].parent, p.spans[0].id);
  assert.strictEqual(p.spans[0].kind, 'server');
  assert.strictEqual(p.spans[1].kind, 'client');
  assert.strictEqual(p.spans[0].dur, 100000);
  assert.ok(p.spans[1].error && p.spans[1].msg === 'deadlock detected');
  assert.strictEqual(p.spans[0].traceId, '5b8efff798038103d269b633813fc60c');
});
test('Tempo "batches" and newline-delimited OTLP are read', () => {
  const one = JSON.parse(T.samples.sampleOtlp());
  assert.strictEqual(T.parse(JSON.stringify({ batches: one.resourceSpans })).format, 'otlp');
  const nd = JSON.stringify(one) + '\n' + JSON.stringify(one);
  assert.strictEqual(T.parse(nd).spans.length, 2 * T.parse(JSON.stringify(one)).spans.length);
});
test('Zipkin shared client/server spans are split into two spans', () => {
  const z = [
    { traceId: 'a1', id: '01', name: 'get /', timestamp: 1000, duration: 100000, kind: 'SERVER', localEndpoint: { serviceName: 'web' } },
    { traceId: 'a1', id: '02', parentId: '01', name: 'get /x', timestamp: 2000, duration: 80000, kind: 'CLIENT', localEndpoint: { serviceName: 'web' } },
    { traceId: 'a1', id: '02', parentId: '01', name: 'get /x', timestamp: 3000, duration: 70000, kind: 'SERVER', shared: true, localEndpoint: { serviceName: 'api' } },
    { traceId: 'a1', id: '03', parentId: '02', name: 'select', timestamp: 4000, duration: 50000, kind: 'CLIENT', localEndpoint: { serviceName: 'api' }, tags: { error: 'timeout' } },
  ];
  const p = T.parse(JSON.stringify(z));
  const srv = p.spans.find(s => s.service === 'api' && s.kind === 'server');
  assert.strictEqual(srv.parent, T.normId('02'));
  assert.notStrictEqual(srv.id, T.normId('02'));
  assert.strictEqual(p.spans.find(s => s.op === 'select').parent, srv.id, 'server-side child moves under the server half');
  assert.ok(p.spans.find(s => s.op === 'select').error);
});
test('invalid JSON gives a helpful error', () => {
  assert.throws(() => T.parse('not json at all'), /not valid JSON/);
  assert.throws(() => T.parse('{"hello":1}'), /No spans found/);
});

// ---------------------------------------------------------------- one trace
test('critical path follows the last-finishing child and skips parallel work', () => {
  const r = T.analyseTrace([
    span('r', '', 'web', 'root', 0, 100),
    span('a', 'r', 'svc-a', 'A', 0, 60),
    span('b', 'r', 'svc-b', 'B', 10, 90),
  ], { adjustSkew: false });
  assert.strictEqual(r.total, 100000);
  assert.strictEqual(byOp(r, 'B').crit, 80000);
  assert.strictEqual(byOp(r, 'A').crit, 0);
  assert.strictEqual(byOp(r, 'root').crit, 20000);
  assert.strictEqual(r.critTotal, 100000);
  assert.strictEqual(byOp(r, 'root').self, 10000, 'self time = time not covered by any child');
});
test('critical path through a sequential chain covers every call', () => {
  const r = T.analyseTrace([
    span('r', '', 'web', 'root', 0, 100),
    span('a', 'r', 'x', 'A', 5, 30), span('b', 'r', 'y', 'B', 30, 60), span('c', 'r', 'z', 'C', 60, 95),
  ]);
  assert.strictEqual(byOp(r, 'A').crit + byOp(r, 'B').crit + byOp(r, 'C').crit, 90000);
  const seq = r.findings.find(f => f.id === 'sequential');
  assert.ok(seq, 'sequential calls found');
  assert.strictEqual(seq.time, 90000 - 35000);
});
test('N+1: many sibling SELECTs are reported with the total time', () => {
  const s = [span('r', '', 'orders', 'GET /orders', 0, 200)];
  for (let i = 0; i < 20; i++) s.push(span('q' + i, 'r', 'orders', 'SELECT items', 5 + i * 9, 13 + i * 9, { attrs: { 'db.system': 'postgresql', 'db.statement': 'SELECT * FROM items WHERE order_id = ' + i } }));
  const r = T.analyseTrace(s);
  const f = r.findings.find(x => x.id === 'n-plus-one');
  assert.ok(f, 'N+1 found');
  assert.ok(/20 × SELECT items/.test(f.title));
  assert.strictEqual(f.time, 160000);
  assert.ok(/eager loading|IN \(/.test(f.fix));
});
test('retries: same call after a failure', () => {
  const r = T.analyseTrace([
    span('r', '', 'pay', 'POST /pay', 0, 200),
    span('c1', 'r', 'pay', 'POST /charge', 10, 50, { error: true, msg: 'HTTP 503' }),
    span('c2', 'r', 'pay', 'POST /charge', 80, 150),
  ]);
  const f = r.findings.find(x => x.id === 'retry');
  assert.ok(f && /2 times, the last attempt worked/.test(f.title));
  assert.strictEqual(f.time, 70000);
  const e = r.findings.find(x => x.id === 'errors');
  assert.ok(e && /recovered after a retry/.test(e.text));
});
test('errors: the deepest failing span is the origin', () => {
  const r = T.analyseTrace([
    span('r', '', 'gw', 'GET /', 0, 100, { error: true }),
    span('a', 'r', 'api', 'GET /a', 5, 95, { error: true }),
    span('b', 'a', 'db', 'SELECT', 10, 90, { error: true, msg: 'connection refused' }),
  ]);
  assert.deepStrictEqual(r.errors.filter(e => e.origin).map(e => e.i), [2]);
  assert.ok(r.summary.some(l => /error starts in db `SELECT`: "connection refused"/.test(l)));
});
test('clock skew: child that starts before its parent is moved inside it, with its children', () => {
  const s = [
    span('r', '', 'pay', 'POST /pay', 1000, 1200, { kind: 'client' }),
    span('f', 'r', 'fraud', 'score', 900, 1050, { kind: 'server' }),   // fraud's clock is 150 ms behind
    span('g', 'f', 'fraud', 'predict', 910, 1040),
  ];
  const r = T.analyseTrace(s);
  assert.strictEqual(r.skews.length, 1);
  const f = byOp(r, 'score'), g = byOp(r, 'predict');
  assert.strictEqual(f.start, 25000, 'centred in the parent: (200 - 150) / 2');
  assert.strictEqual(g.start - f.start, 10000, 'children move with it');
  assert.ok(r.findings.some(x => x.id === 'clock-skew'));
  const off = T.analyseTrace(s, { adjustSkew: false });
  assert.strictEqual(off.skews.length, 1, 'still detected when not adjusted');
  assert.strictEqual(byOp(off, 'score').start, 0);
});
test('gaps: uncovered time inside a span is reported', () => {
  const r = T.analyseTrace([
    span('r', '', 'gw', 'POST /checkout', 0, 1000),
    span('a', 'r', 'orders', 'POST /orders', 400, 990),
  ]);
  const g = r.findings.find(x => x.id === 'gap');
  assert.ok(g && /400 ms/.test(g.title) && /before its first child/.test(g.text));
});
test('fan-out: wide parallel calls', () => {
  const s = [span('r', '', 'search', 'GET /search', 0, 100)];
  for (let i = 0; i < 12; i++) s.push(span('s' + i, 'r', 'shard-' + i, 'query', 2, 60 + i));
  const r = T.analyseTrace(s);
  const f = r.findings.find(x => x.id === 'fan-out');
  assert.ok(f && /12 calls/.test(f.title) && /at most 12 at a time/.test(f.text));
});
test('orphans and parent cycles do not break the analysis', () => {
  const r = T.analyseTrace([span('a', 'b', 'x', 'A', 0, 10), span('b', 'a', 'y', 'B', 1, 9), span('c', 'zzz', 'z', 'C', 0, 5)]);
  assert.strictEqual(r.spanCount, 3);
  assert.ok(r.warnings.some(w => /loop/.test(w)));
  assert.ok(r.warnings.some(w => /parent that is not in the file/.test(w)));
});
test('sample checkout trace: summary blames fraud-svc and the slow call', () => {
  const p = T.parse(T.samples.sampleJaeger());
  const r = T.analyseTrace(T.groupTraces(p.spans)[0].spans);
  assert.ok(/% of the 1\.\d\d s .* is spent in fraud-svc, with payments-svc waiting on a single `POST \/score` call/.test(r.summary[1]), r.summary[1]);
  ['n-plus-one', 'sequential', 'retry', 'gap', 'clock-skew', 'hot-span', 'errors'].forEach(id => assert.ok(r.findings.some(f => f.id === id), 'finding ' + id));
  assert.strictEqual(Math.round(r.critTotal), Math.round(r.total));
});

// ---------------------------------------------------------------- many traces
test('many traces: percentiles, critical path services, dependencies and outliers', () => {
  const p = T.parse(T.samples.sampleMany(150));
  const traces = T.groupTraces(p.spans);
  assert.strictEqual(traces.length, 150);
  const m = T.analyseMany(traces);
  assert.strictEqual(m.traceCount, 150);
  assert.ok(m.overall.p95 >= m.overall.p50);
  assert.ok(m.dependencies.some(e => e.from === 'payments-svc' && e.to === 'fraud-svc'));
  assert.ok(m.outliers.length > 0 && m.outliers.every(o => o.ratio >= 1.5));
  assert.ok(m.outliers.some(o => o.service === 'fraud-svc'), 'slow fraud model shows up as the outlier cause');
  assert.ok(m.critical[0].critShare > 0);
  assert.strictEqual(m.endpoints.length, 2);
  assert.ok(m.list[0].total >= m.list[m.list.length - 1].total, 'list sorted slowest first');
});
test('session: loads several inputs and analyses one trace on demand', () => {
  const s = T.createSession();
  const r = s.load([{ name: 'a.json', text: T.samples.sampleJaeger() }, { name: 'b.json', text: T.samples.sampleOtlp() }], {});
  assert.strictEqual(r.traceCount, 2);
  assert.strictEqual(r.format, 'mixed');
  const other = r.many.list[1].id;
  assert.strictEqual(s.trace(other).traceId, other);
});
test('Markdown summary', () => {
  const s = T.createSession();
  const r = s.load([{ name: 'x', text: T.samples.sampleMany(30) }], {});
  const md = T.toMarkdown(r.single, r.many);
  assert.ok(/## Trace analysis: 30 traces/.test(md) && /\| Service \|/.test(md) && /trace-explainer/.test(md));
});
test('big input: 3,000 traces (~100k spans) parse and analyse quickly', () => {
  const t0 = Date.now();
  const json = T.samples.sampleMany(3000);
  const s = T.createSession();
  const r = s.load([{ name: 'big', text: json }], {});
  const ms = Date.now() - t0;
  assert.strictEqual(r.traceCount, 3000);
  assert.ok(ms < 15000, 'took ' + ms + ' ms');
  console.log('       (' + (json.length / 1048576).toFixed(1) + ' MB, ' + r.spanCount.toLocaleString() + ' spans in ' + ms + ' ms including generation)');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
