// Tests for docs/tools/log-analyser/logs.js. Run: node toolkit-tests/log-analyser.test.js
'use strict';
const path = require('path');
const assert = require('assert');
const L = require(path.join(__dirname, '..', 'docs', 'tools', 'log-analyser', 'logs.js'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e)); }
}

// ---------------------------------------------------------------- fixtures

const JAVA = `2026-11-08 10:00:00,123 INFO  [main] com.acme.App - Started App in 4.2 seconds
2026-11-08 10:00:01,200 WARN  [http-nio-8080-exec-1] com.acme.Pool - Pool at 90% (18/20)
2026-11-08 10:00:02,300 ERROR [http-nio-8080-exec-2] com.acme.OrderService - Payment failed for order 12345 user bob@example.com
java.lang.IllegalStateException: Gateway returned 502
\tat com.acme.PaymentClient.charge(PaymentClient.java:88)
\tat com.acme.OrderService.place(OrderService.java:41)
Caused by: java.net.SocketTimeoutException: Read timed out
\tat java.base/java.net.SocketInputStream.read(SocketInputStream.java:168)
\t... 12 more
2026-11-08 10:00:03,300 ERROR [http-nio-8080-exec-3] com.acme.OrderService - Payment failed for order 12346 user amy@example.com
java.lang.IllegalStateException: Gateway returned 502
\tat com.acme.PaymentClient.charge(PaymentClient.java:88)
2026-11-08 10:01:03,300 FATAL [main] com.acme.App - Shutting down`;

const NGINX = [
  '203.0.113.9 - - [08/Nov/2026:10:00:00 +1100] "GET /api/orders/123?x=1 HTTP/1.1" 200 512 "-" "Mozilla/5.0" 0.120',
  '203.0.113.9 - - [08/Nov/2026:10:00:01 +1100] "GET /api/orders/456 HTTP/1.1" 500 12 "-" "Mozilla/5.0" 1.520',
  '198.51.100.1 - - [08/Nov/2026:10:00:02 +1100] "POST /api/login HTTP/1.1" 401 12 "-" "curl/8.0" 0.020',
  '198.51.100.1 - - [08/Nov/2026:10:00:03 +1100] "GET /api/orders/9b2c6f0e-1d2a-4c55-9a7e-0c3d2e1f4a5b HTTP/1.1" 503 0 "-" "curl/8.0" 2.000',
  '198.51.100.1 - - [08/Nov/2026:10:00:03 +1100] "-" 400 0 "-" "-"',
].join('\n');

// ---------------------------------------------------------------- templates

test('templates replace numbers, UUIDs, IPs, hex, emails, URLs, times and quoted strings', () => {
  assert.strictEqual(L.template('Payment failed for order 12345 user bob@example.com'), 'Payment failed for order <n> user <email>');
  assert.strictEqual(L.template('User 9b2c6f0e-1d2a-4c55-9a7e-0c3d2e1f4a5b from 10.1.2.3:8080 not found'), 'User <uuid> from <ip> not found');
  assert.strictEqual(L.template('Lock 0x7f3a held; token deadbeef1234 at 2026-11-08T10:00:00Z'), 'Lock <hex> held; token <hex> at <time>');
  assert.strictEqual(L.template('Cannot open "C:\\tmp\\a.txt" or \'b.txt\' after 3000ms'), 'Cannot open "<str>" or \'<str>\' after <n>');
  assert.strictEqual(L.template("can't reach https://api.acme.com/v2/orders?id=7"), "can't reach <url>");
  assert.strictEqual(L.template('session abcDEF123456ghiJKL789 expired'), 'session <id> expired');
  assert.strictEqual(L.template('Upgrade to v2 failed'), 'Upgrade to v2 failed');
});

test('endpoint normalisation drops query strings and replaces ids', () => {
  assert.strictEqual(L.endpoint('/api/orders/123?x=1'), '/api/orders/{id}');
  assert.strictEqual(L.endpoint('/u/9b2c6f0e-1d2a-4c55-9a7e-0c3d2e1f4a5b/items/42'), '/u/{uuid}/items/{id}');
  assert.strictEqual(L.endpoint('https://x.com/a/b'), '/a/b');
  assert.strictEqual(L.endpoint('/files/report.pdf'), '/files/report.pdf');
});

// ---------------------------------------------------------------- formats

test('Java/Log4j log: levels, multi-line stack traces, grouping and root cause', () => {
  const r = L.analyseText(JAVA);
  assert.strictEqual(r.format, 'java');
  assert.strictEqual(r.entries, 5);
  assert.deepStrictEqual([r.levels.FATAL, r.levels.ERROR, r.levels.WARN, r.levels.INFO], [1, 2, 1, 1]);
  assert.strictEqual(r.groups[0].template, 'Payment failed for order <n> user <email>');
  assert.strictEqual(r.groups[0].count, 2);
  assert.strictEqual(L.fmtTime(r.groups[0].first), '2026-11-08 10:00:02');
  assert.strictEqual(L.fmtTime(r.groups[0].last), '2026-11-08 10:00:03');
  assert.ok(r.groups[0].loggers['com.acme.OrderService'] === 2);
  assert.strictEqual(r.stacks.length, 1);
  assert.strictEqual(r.stacks[0].count, 2);
  assert.strictEqual(r.stacks[0].type, 'java.lang.IllegalStateException');
  assert.strictEqual(r.stacks[0].root, 'java.net.SocketTimeoutException');
  assert.strictEqual(r.stacks[0].frame, 'com.acme.PaymentClient.charge(PaymentClient.java:88)');
  assert.strictEqual(r.firstError.line, 3);
  assert.strictEqual(r.firstError.stack.length, 6);
});

test('Spring Boot, Logback time-only and nginx error log headers', () => {
  const sb = L.analyseText('2026-11-08T10:00:00.123+11:00 ERROR 12345 --- [api] [nio-8080-exec-1] c.a.OrderService : Payment failed\n2026-11-08T10:00:01.123+11:00  INFO 12345 --- [api] [main] c.a.App : ok');
  assert.strictEqual(sb.format, 'java');
  assert.strictEqual(sb.groups[0].template, 'Payment failed');
  assert.ok(sb.groups[0].loggers['c.a.OrderService']);
  const lb = L.analyseText('10:00:00.123 [main] ERROR com.acme.X - boom 42\n10:00:01.000 [main] INFO com.acme.X - fine');
  assert.strictEqual(lb.errors, 1);
  assert.strictEqual(L.fmtTime(lb.firstError.ts), '10:00:00');
  const ng = L.analyseText('2026/11/08 10:00:00 [error] 123#0: *1 connect() failed (111: Connection refused) while connecting to upstream\n2026/11/08 10:00:01 [warn] 123#0: *2 an upstream response is buffered');
  assert.deepStrictEqual([ng.levels.ERROR, ng.levels.WARN], [1, 1]);
});

test('JSON lines: pino numeric levels, nested error stacks, epoch times and access fields', () => {
  const text = [
    JSON.stringify({ time: '2026-11-08T10:00:00Z', level: 'error', msg: 'db timeout after 3000ms', err: { stack: 'Error: db timeout\n    at query (/app/db.js:10:5)\n    at main (/app/index.js:3:1)' } }),
    JSON.stringify({ time: 1794132000123, level: 50, msg: 'boom id=9f8e7d6c5b4a3f2e1d0c' }),
    JSON.stringify({ '@timestamp': '2026-11-08T10:00:01Z', 'log.level': 'INFO', message: 'GET', method: 'GET', path: '/x/42', status: 503, duration_ms: 87 }),
    'not json at all',
  ].join('\n');
  const r = L.analyseText(text);
  assert.strictEqual(r.format, 'json');
  assert.strictEqual(r.levels.ERROR, 2);
  assert.deepStrictEqual(r.groups.map(g => g.template).sort(), ['boom id=<hex>', 'db timeout after <n>']);
  assert.strictEqual(r.stacks[0].type, 'Error');
  assert.strictEqual(r.stacks[0].frame, 'query (db.js:10:5)');
  assert.strictEqual(L.fmtTime(r.groups.find(g => /boom/.test(g.template)).first), '2026-11-08 10:00:00');
  assert.strictEqual(r.access.endpoints[0].endpoint, 'GET /x/{id}');
  assert.strictEqual(r.access.endpoints[0].p95, 87);
  assert.strictEqual(r.unparsed, 1);
});

test('logfmt and syslog (RFC 3164 with and without priority, RFC 5424)', () => {
  const f = L.analyseText('time=2026-11-08T10:00:00Z level=error msg="cache miss for key user:42" component=cache\ntime=2026-11-08T10:00:01Z level=info msg="ok"');
  assert.strictEqual(f.format, 'logfmt');
  assert.strictEqual(f.groups[0].template, 'cache miss for key user:<n>');
  const s = L.analyseText('<11>Nov  8 10:00:00 web01 nginx[123]: upstream timed out\nNov  8 10:00:01 web01 sshd[99]: Failed password for root from 1.2.3.4 port 22\nNov  8 10:00:02 web01 cron[1]: (root) CMD (run-parts)\n<165>1 2026-11-08T10:00:03.000Z web01 app 1 ID47 - started', { year: 2026 });
  assert.strictEqual(s.format, 'syslog');
  assert.deepStrictEqual([s.levels.ERROR, s.levels.INFO], [2, 2]);
  assert.strictEqual(L.fmtTime(s.firstTs), '2026-11-08 10:00:00');
});

test('access log: status breakdown, slowest endpoints, top IPs and user agents, 5xx as errors', () => {
  const r = L.analyseText(NGINX);
  assert.strictEqual(r.format, 'access');
  const a = r.access;
  assert.strictEqual(a.requests, 5);
  assert.deepStrictEqual(a.classes, { '1xx': 0, '2xx': 1, '3xx': 0, '4xx': 2, '5xx': 2 });
  assert.ok(a.hasTimes);
  assert.strictEqual(a.slowest[0].endpoint, 'GET /api/orders/{uuid}');
  assert.strictEqual(a.slowest[0].p95, 2000);
  const orders = a.endpoints.find(e => e.endpoint === 'GET /api/orders/{id}');
  assert.deepStrictEqual([orders.count, orders.errors, orders.p50, orders.max], [2, 1, 120, 1520]);
  assert.deepStrictEqual(a.ips[0], { key: '198.51.100.1', count: 3 });
  assert.ok(a.agents.some(x => x.key === 'curl/8.0' && x.count === 2));
  assert.ok(a.agents.some(x => x.key === '(none)' && x.count === 1));
  assert.strictEqual(r.errors, 2);
  assert.ok(r.groups.some(g => g.template === 'GET /api/orders/{id} → 500'));
  assert.strictEqual(r.levels.WARN, 2);
});

test('Python tracebacks and plain text are grouped', () => {
  const r = L.analyseText('2026-11-08 10:00:00,000 ERROR app: Unhandled\nTraceback (most recent call last):\n  File "/app/main.py", line 10, in <module>\n    run()\n  File "/app/main.py", line 5, in run\n    1/0\nZeroDivisionError: division by zero');
  assert.strictEqual(r.stacks[0].type, 'ZeroDivisionError');
  assert.strictEqual(r.stacks[0].frame, 'main.py:5 in run');
  const p = L.analyseText('starting up\nERROR could not open socket 12\nwarning: disk 91% full\nERROR could not open socket 13\n    at net.open (net.js:1:1)');
  assert.strictEqual(p.format, 'plain');
  assert.strictEqual(p.groups[0].count, 2);
  assert.strictEqual(p.levels.WARN, 1);
});

// ---------------------------------------------------------------- timeline and spikes

function spikeLog() {
  const t0 = Date.UTC(2026, 10, 8, 9, 0, 0);
  const out = [];
  for (let m = 0; m < 120; m++) {
    const errs = m === 77 ? 40 : (m % 10 === 0 ? 1 : 0);
    for (let k = 0; k < 20; k++) out.push(L.fmtTime(t0 + m * 60000 + k * 1000).replace(' ', 'T') + 'Z INFO [w] a.B - tick ' + k);
    for (let k = 0; k < errs; k++) out.push(L.fmtTime(t0 + m * 60000 + 30000 + k * 100).replace(' ', 'T') + 'Z ERROR [w] a.B - ' + (k === 0 && m === 77 ? 'Connection pool exhausted' : 'timeout ' + k));
  }
  return out.join('\n');
}

test('timeline buckets errors per minute and flags spikes above mean + 3σ', () => {
  const r = L.analyseText(spikeLog());
  const t = r.timeline;
  assert.strictEqual(t.bucketMinutes, 1);
  assert.strictEqual(t.buckets.length, 120);
  assert.strictEqual(t.spikes.length, 1);
  assert.strictEqual(L.fmtTime(t.spikes[0].t, false), '2026-11-08 10:17');
  assert.strictEqual(t.spikes[0].errors, 40);
  assert.strictEqual(t.spikes[0].first.msg, 'Connection pool exhausted');
  assert.ok(t.threshold > t.mean);
  assert.strictEqual(t.peak.errors, 40);
});

test('long time spans use bigger buckets', () => {
  const lines = [];
  for (let d = 0; d < 10; d++) lines.push('2026-11-' + String(d + 1).padStart(2, '0') + ' 00:00:00 INFO x - a');
  const r = L.analyseText(lines.join('\n'));
  assert.ok(r.timeline.bucketMinutes >= 15);
  assert.ok(r.timeline.buckets.length <= 1500);
});

// ---------------------------------------------------------------- filters

test('filters by level, text, regex and time window; first error in a window', () => {
  const r = L.analyseText(spikeLog());
  const s = r.samples;
  assert.ok(s.length > 40);
  assert.strictEqual(L.filterEntries(s, { q: 'pool exhausted' }).length, 1);
  assert.strictEqual(L.filterEntries(s, { q: 'timeout [0-3]$', regex: true }).length, L.filterEntries(s, { q: 'timeout ' }).filter(e => /timeout [0-3]$/.test(e.msg)).length);
  const from = Date.UTC(2026, 10, 8, 10, 17, 0), to = Date.UTC(2026, 10, 8, 10, 17, 59);
  assert.strictEqual(L.filterEntries(s, { from, to }).length, 40);
  assert.strictEqual(L.firstErrorIn(s, from, to).msg, 'Connection pool exhausted');
  assert.strictEqual(L.firstErrorIn(s, null, null).msg, 'timeout 0');
  assert.strictEqual(L.filterEntries(s, { levels: ['WARN'] }).length, 0);
  assert.doesNotThrow(() => L.filterEntries(s, { q: '(', regex: true }));
});

// ---------------------------------------------------------------- streaming and exports

test('chunked input gives the same answer as one string (lines split across chunks)', () => {
  const whole = L.analyseText(JAVA);
  const a = L.createAnalyser();
  for (let i = 0; i < JAVA.length; i += 7) a.push(JAVA.slice(i, i + 7));
  const r = a.end();
  assert.deepStrictEqual(r.levels, whole.levels);
  assert.deepStrictEqual(r.groups.map(g => [g.template, g.count]), whole.groups.map(g => [g.template, g.count]));
  assert.strictEqual(r.stacks[0].count, 2);
  assert.strictEqual(L.analyseText(JAVA.replace(/\n/g, '\r\n')).entries, 5);
});

test('CSV and Markdown exports', () => {
  const r = L.analyseText(JAVA);
  const csv = L.groupsToCSV(r).split('\r\n');
  assert.strictEqual(csv[0], 'Count,Level,Template,First seen,Last seen,First line,Example');
  assert.ok(/^2,ERROR,Payment failed for order <n> user <email>,2026-11-08 10:00:02/.test(csv[1]));
  const md = L.toMarkdown(r, 'app.log');
  assert.ok(/^### Log analysis: app\.log/.test(md));
  assert.ok(/First error \(line 3, 2026-11-08 10:00:02\)/.test(md));
  assert.ok(/\| 2 \| `java\.lang\.IllegalStateException` \(caused by `java\.net\.SocketTimeoutException`\)/.test(md));
  const ep = L.endpointsToCSV(L.analyseText(NGINX)).split('\r\n');
  assert.strictEqual(ep[0], 'Endpoint,Requests,5xx,4xx,Error %,Avg ms,p50 ms,p95 ms,p99 ms,Max ms');
});

test('50 MB log streams through in reasonable time with bounded memory structures', () => {
  const t0 = Date.UTC(2026, 10, 8);
  const a = L.createAnalyser();
  let size = 0, i = 0;
  const chunk = [];
  const started = Date.now();
  while (size < 50 * 1024 * 1024) {
    const ts = L.fmtTime(t0 + i * 50).replace(' ', 'T') + '.' + String(i % 1000).padStart(3, '0');
    let l;
    if (i % 97 === 0) l = ts + ' ERROR [exec-' + (i % 40) + '] com.acme.OrderService - Payment failed for order ' + i + ' user u' + i + '@example.com\njava.lang.IllegalStateException: Gateway returned 502\n\tat com.acme.PaymentClient.charge(PaymentClient.java:88)';
    else if (i % 31 === 0) l = ts + ' WARN  [exec-' + (i % 40) + '] com.acme.Pool - Pool at ' + (i % 100) + '% (' + (i % 20) + '/20)';
    else l = ts + ' INFO  [exec-' + (i % 40) + '] com.acme.Api - GET /api/orders/' + i + ' 200 in ' + (i % 300) + 'ms';
    chunk.push(l); size += l.length + 1; i++;
    if (chunk.length === 20000) { a.push(chunk.join('\n') + '\n'); chunk.length = 0; }
  }
  a.push(chunk.join('\n'));
  const r = a.end();
  const ms = Date.now() - started;
  assert.strictEqual(r.groups.length, 1);
  assert.strictEqual(r.stacks.length, 1);
  assert.ok(r.errors > 5000);
  assert.ok(r.samples.length <= 20000);
  assert.ok(ms < 15000, 'took ' + ms + ' ms');
  console.log('       (50 MB, ' + r.lines.toLocaleString() + ' lines in ' + ms + ' ms including generation)');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
