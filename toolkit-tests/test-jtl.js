// Tests for docs/tools/jtl-analyser/jtl.js. Run: node toolkit-tests/test-jtl.js
'use strict';
const path = require('path');
const assert = require('assert');
const J = require(path.join(__dirname, '..', 'docs', 'tools', 'jtl-analyser', 'jtl.js'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e)); }
}
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= (eps || 1e-9), (msg || '') + ` expected ${b}, got ${a}`);

// brute-force nearest-rank reference
function refPct(values, p) {
  const s = values.slice().sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * s.length));
  return s[Math.min(rank, s.length) - 1];
}

function rng(seed) { let a = seed; return () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; }; }

const HEADER = J.DEFAULT_COLUMNS.join(',');

console.log('CSV parsing');

test('plain split and header detection', () => {
  const recs = [];
  const p = J.createCsvParser(f => recs.push(f));
  p.push('a,b,c\n1,2,3\r\n4,5,6'); p.end();
  assert.deepStrictEqual(recs, [['a', 'b', 'c'], ['1', '2', '3'], ['4', '5', '6']]);
});

test('quoted fields with commas, doubled quotes and newlines', () => {
  const recs = [];
  const p = J.createCsvParser(f => recs.push(f));
  p.push('x,y,z\n"a,b","he said ""hi""","line1\nline2"\nlast,"",end\n'); p.end();
  assert.deepStrictEqual(recs[1], ['a,b', 'he said "hi"', 'line1\nline2']);
  assert.deepStrictEqual(recs[2], ['last', '', 'end']);
  assert.strictEqual(recs.length, 3);
});

test('quoted newline split across every possible chunk boundary', () => {
  const text = 'h1,h2\n"multi\r\nline, with comma",2\n3,"q""uote"\n';
  for (let cut = 1; cut < text.length; cut++) {
    const recs = [];
    const p = J.createCsvParser(f => recs.push(f));
    p.push(text.slice(0, cut)); p.push(text.slice(cut)); p.end();
    assert.deepStrictEqual(recs, [['h1', 'h2'], ['multi\r\nline, with comma', '2'], ['3', 'q"uote']], 'cut at ' + cut);
  }
});

test('tab delimiter detected', () => {
  const r = J.analyseText('timeStamp\telapsed\tlabel\tsuccess\n1700000000000\t100\tA\ttrue\n1700000001000\t300\tA\tfalse\n');
  assert.strictEqual(r.rows, 2);
  assert.strictEqual(r.labels[0].errors, 1);
});

console.log('JTL CSV analysis');

test('default columns, failure message with commas and newline, totals', () => {
  const rows = [
    HEADER,
    '1700000000000,100,Login,200,OK,T 1-1,text,true,,1000,200,1,1,http://x/login,90,0,10',
    '1700000001000,300,Login,500,"Server Error, retry",T 1-1,text,false,"Assertion failed:\nexpected ""ok""",500,200,1,1,http://x/login,280,0,0',
    '1700000002000,200,Search,200,OK,T 1-1,text,true,,2000,100,1,1,"http://x/s?q=a,b",150,0,0',
  ];
  const r = J.analyseText(rows.join('\n') + '\n');
  assert.strictEqual(r.rows, 3);
  const login = r.labels.find(l => l.label === 'Login');
  assert.strictEqual(login.count, 2);
  assert.strictEqual(login.errors, 1);
  near(login.errPct, 50);
  near(login.avg, 200);
  assert.strictEqual(r.errors[0].rc, '500');
  assert.strictEqual(r.errors[0].msg, 'Assertion failed:\nexpected "ok"');
  near(r.total.errPct, 100 / 3);
  // span = (2000+200) - 0 = 2.2 s
  near(r.total.tput, 3 / 2.2, 1e-9);
  near(r.total.recvKBs, 3500 / 1024 / 2.2, 1e-9);
  assert.strictEqual(r.format, 'JMeter CSV');
});

test('missing columns: only elapsed + label + responseCode, reordered', () => {
  const r = J.analyseText('responseCode,label,elapsed\n200,A,10\n500,A,20\n302,B,30\n');
  assert.strictEqual(r.rows, 3);
  const a = r.labels.find(l => l.label === 'A');
  assert.strictEqual(a.errors, 1, 'success derived from responseCode');
  assert.ok(isNaN(r.total.tput), 'no timestamps → no throughput');
  assert.strictEqual(r.timeline, null);
  assert.ok(r.warnings.some(w => /timeStamp/.test(w)));
});

test('no header row: default column order assumed', () => {
  const r = J.analyseText('1700000000000,150,Home,200,OK,T 1-1,text,true,,100,10,1,1,http://x,140,0,5\n1700000000500,250,Home,200,OK,T 1-1,text,true,,100,10,1,1,http://x,240,0,5\n');
  assert.strictEqual(r.rows, 2);
  near(r.labels[0].avg, 200);
  assert.ok(r.warnings.some(w => /No header/.test(w)));
});

test('not a JTL file → helpful error', () => {
  assert.throws(() => J.analyseText('hello,world\nfoo,bar\n'), /doesn't look like a JMeter results file/);
});

test('formatted timestamps (yyyy/MM/dd HH:mm:ss.SSS) are parsed', () => {
  const r = J.analyseText('timeStamp,elapsed,label,success\n2026/11/03 10:00:00.000,100,A,true\n2026/11/03 10:00:10.000,100,A,true\n');
  near(r.durationMs, 10100);
});

test('BOM and CRLF tolerated', () => {
  const r = J.analyseText('﻿timeStamp,elapsed,label,success\r\n1700000000000,5,A,true\r\n');
  assert.strictEqual(r.rows, 1);
});

test('rows with non-numeric elapsed are skipped and reported', () => {
  const r = J.analyseText('elapsed,label\n10,A\nabc,A\n20,A\n');
  assert.strictEqual(r.rows, 2);
  assert.ok(r.warnings.some(w => /skipped/.test(w)));
});

console.log('Percentiles');

test('nearest-rank helper on small arrays', () => {
  assert.strictEqual(J.percentileSorted([1, 2, 3, 4], 50), 2);
  assert.strictEqual(J.percentileSorted([1, 2, 3, 4], 95), 4);
  assert.strictEqual(J.percentileSorted([7], 99), 7);
  assert.strictEqual(J.percentileSorted(Float64Array.from([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]), 90), 90);
});

test('per-label and total percentiles match brute force (random data, 3 labels, chunked)', () => {
  const R = rng(7);
  const vals = { A: [], B: [], C: [] };
  const all = [];
  const lines = ['timeStamp,elapsed,label,success'];
  for (let i = 0; i < 30011; i++) {
    const l = 'ABC'[Math.floor(R() * 3)];
    const v = Math.round(Math.exp(R() * 8));
    vals[l].push(v); all.push(v);
    lines.push(`${1700000000000 + i * 10},${v},${l},true`);
  }
  const r = J.analyseText(lines.join('\n'), { chunk: 4093 });
  for (const l of r.labels) {
    for (const p of [50, 90, 95, 99]) assert.strictEqual(l['p' + p], refPct(vals[l.label], p), `${l.label} p${p}`);
    assert.strictEqual(l.max, Math.max(...vals[l.label]));
  }
  for (const p of [50, 90, 95, 99]) assert.strictEqual(r.total['p' + p], refPct(all, p), 'total p' + p);
});

test('timeline buckets: counts add up and bucket percentiles match brute force', () => {
  const R = rng(11);
  const lines = ['timeStamp,elapsed,label,success,allThreads'];
  const samples = [];
  for (let i = 0; i < 5000; i++) {
    const t = 1700000000000 + Math.floor(R() * 600000);
    const v = 1 + Math.floor(R() * 1000);
    samples.push([t, v]);
    lines.push(`${t},${v},X,${R() < 0.1 ? 'false' : 'true'},${1 + (i % 20)}`);
  }
  const r = J.analyseText(lines.join('\n'));
  const tl = r.timeline;
  assert.ok(tl.points.length <= 120 && tl.points.length > 10);
  assert.strictEqual(tl.points.reduce((s, p) => s + p.count, 0), 5000);
  const errs = tl.points.reduce((s, p) => s + p.errors, 0);
  assert.strictEqual(errs, r.total.errors);
  const b = tl.points[3];
  const inB = samples.filter(([t]) => t >= b.t && t < b.t + tl.bucketMs).map(s => s[1]);
  assert.strictEqual(b.count, inB.length);
  assert.strictEqual(b.p95, refPct(inB, 95));
  assert.ok(r.hasThreads && tl.points.some(p => p.threads === 20));
});

console.log('XML JTL');

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<testResults version="1.2">
<httpSample t="120" it="0" lt="100" ct="10" ts="1700000000000" s="true" lb="Home &amp; landing" rc="200" rm="OK" tn="TG 1-1" dt="text" by="5000" sby="300" ng="2" na="2">
  <httpSample t="40" ts="1700000000010" s="true" lb="Home-0" rc="302" rm="Found" by="10"/>
  <java.net.URL>https://x/</java.net.URL>
</httpSample>
<httpSample t="900" lt="850" ts="1700000001000" s="false" lb="Checkout" rc="500" rm="Internal Server Error" tn="TG 1-2" by="200" sby="300" ng="2" na="2">
  <assertionResult>
    <name>Response Assertion</name>
    <failure>true</failure>
    <error>false</error>
    <failureMessage>Test failed: code expected to equal /200/</failureMessage>
  </assertionResult>
</httpSample>
<sample t="300" ts="1700000002000" s="true" lb="Checkout" rc="200" rm="Number of samples in transaction : 2, number of failing samples : 0" na="2"/>
<httpSample t="200" ts="1700000003000" s="true" lb='Search "shoes"' rc="200" rm="OK" na="1"/>
</testResults>
`;

test('top-level samples only, attributes, entities and failure message', () => {
  const r = J.analyseText(XML);
  assert.strictEqual(r.format, 'JMeter XML');
  assert.strictEqual(r.rows, 4, 'nested Home-0 sub-result is not counted');
  assert.ok(r.labels.find(l => l.label === 'Home & landing'));
  assert.ok(r.labels.find(l => l.label === 'Search "shoes"'));
  const co = r.labels.find(l => l.label === 'Checkout');
  assert.strictEqual(co.count, 2);
  assert.strictEqual(co.errors, 1);
  assert.strictEqual(r.errors[0].msg, 'Test failed: code expected to equal /200/');
  assert.ok(co.transactionController, 'transaction controller message detected');
  near(r.labels[0].avgLatency, 100);
});

test('XML split at every chunk boundary gives the same answer', () => {
  const ref = J.analyseText(XML);
  for (let cut = 1; cut < XML.length; cut += 7) {
    const a = J.createAnalyser();
    a.push(XML.slice(0, cut)); a.push(XML.slice(cut)); a.end();
    const r = a.result();
    assert.strictEqual(r.rows, ref.rows, 'rows, cut ' + cut);
    assert.strictEqual(r.total.p95, ref.total.p95, 'p95, cut ' + cut);
    assert.strictEqual(r.errors[0].msg, ref.errors[0].msg, 'msg, cut ' + cut);
  }
});

console.log('Exports and sample');

test('summary CSV export is parseable and quotes labels', () => {
  const r = J.analyseText('elapsed,label,success\n10,"a,b",true\n20,c,false\n');
  const csv = J.toSummaryCsv(r);
  const lines = csv.trim().split('\n');
  assert.ok(lines[0].startsWith('Label,Samples,Error %,Avg ms,p50 ms,p90 ms,p95 ms,p99 ms'));
  assert.ok(lines[1].startsWith('"a,b",1,0,'));
  assert.ok(lines[3].startsWith('TOTAL,2,50,'));
});

test('markdown summary contains a table row per label and TOTAL', () => {
  const r = J.analyseText(J.generateSample({ rows: 2000 }));
  const md = J.toMarkdown(r, { slaMs: 500, fileName: 'run|1.jtl' });
  assert.ok(md.includes('| 05 Checkout |'));
  assert.ok(md.includes('| **TOTAL** |'));
  assert.ok(md.includes('run\\|1.jtl'));
  assert.ok(md.includes('⚠️'));
});

test('generated sample: deterministic, 5 labels, errors, threads', () => {
  const t1 = J.generateSample({ rows: 5000 }), t2 = J.generateSample({ rows: 5000 });
  assert.strictEqual(t1, t2);
  const r = J.analyseText(t1);
  assert.strictEqual(r.rows, 5000);
  assert.strictEqual(r.labels.length, 5);
  assert.ok(r.total.errors > 0 && r.hasThreads && r.hasBytes);
  assert.ok(r.slowest.length === 10 && r.slowest[0].elapsed >= r.slowest[9].elapsed);
  assert.strictEqual(r.slowest[0].elapsed, r.total.max);
});

test('300k rows analyse in reasonable time', () => {
  const text = J.generateSample({ rows: 300000 });
  const t = Date.now();
  const r = J.analyseText(text, { chunk: 4 << 20 });
  const ms = Date.now() - t;
  assert.strictEqual(r.rows, 300000);
  console.log('       (300k rows, ' + (text.length / 1e6).toFixed(1) + ' MB in ' + ms + ' ms)');
  assert.ok(ms < 5000);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
