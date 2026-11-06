// Tests for docs/tools/workload-model/workload.js. Run: node toolkit-tests/test-workload.js
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { execFileSync } = require('child_process');
const W = require(path.join(__dirname, '..', 'docs', 'tools', 'workload-model', 'workload.js'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e)); }
}
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= (eps || 1e-9), (msg || '') + ` expected ${b}, got ${a}`);
const rec = () => ({ t: 0, method: '', path: '', status: 0, rt: NaN, ip: '', ua: '' });
function parseOne(text, opts) {
  const fmt = W.detectFormat(text);
  const p = W.createParser(fmt, opts);
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const r = rec();
    const ok = p(line, r);
    if (ok === true) out.push(r);
  }
  return { fmt, recs: out };
}

console.log('Format detection and parsing');

test('nginx combined with $request_time', () => {
  const { fmt, recs } = parseOne('203.0.113.7 - - [30/Oct/2026:20:01:12 +1100] "GET /product/1234?ref=x HTTP/1.1" 200 5123 "https://shop/" "Mozilla/5.0 (X11)" 0.112\n');
  assert.strictEqual(fmt.format, 'clf');
  const r = recs[0];
  assert.strictEqual(r.ip, '203.0.113.7');
  assert.strictEqual(r.method, 'GET');
  assert.strictEqual(r.path, '/product/1234?ref=x');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.ua, 'Mozilla/5.0 (X11)');
  near(r.rt, 112, 1e-6);
  assert.strictEqual(r.t, Date.UTC(2026, 9, 30, 20, 1, 12)); // wall clock as written
});

test('nginx rt=key form and Apache %D microseconds', () => {
  let r = parseOne('1.2.3.4 - - [30/Oct/2026:20:01:12 +0000] "POST /api/cart HTTP/1.1" 201 12 "-" "UA" rt=0.250 uct="0.001"\n').recs[0];
  near(r.rt, 250, 1e-6);
  r = parseOne('1.2.3.4 - frank [10/Oct/2000:13:55:36 -0700] "GET /a.gif HTTP/1.0" 200 2326 "-" "Mozilla" 4521\n').recs[0];
  near(r.rt, 4.521, 1e-9);
});

test('Apache common log format (no referer, no UA, no response time)', () => {
  const { fmt, recs } = parseOne('127.0.0.1 - frank [10/Oct/2000:13:55:36 -0700] "GET /apache_pb.gif HTTP/1.0" 200 2326\n');
  assert.strictEqual(fmt.format, 'clf');
  assert.strictEqual(recs[0].path, '/apache_pb.gif');
  assert.ok(isNaN(recs[0].rt));
  assert.strictEqual(recs[0].ua, '');
});

test('AWS ALB access log', () => {
  const line = 'https 2018-07-02T22:23:00.186641Z app/my-loadbalancer/50dc6c495c0c9188 192.168.131.39:2817 10.0.0.1:80 0.086 0.048 0.037 200 200 0 57 "GET https://www.example.com:443/orders/42?x=1 HTTP/1.1" "curl/7.46.0" ECDHE-RSA-AES128-GCM-SHA256 TLSv1.2 arn:aws:elasticloadbalancing:us-east-2:123456789012:targetgroup/my-targets/73e2d6bc24d8a067 "Root=1-58337281-1d84f3d73c47ec4e58577259" "www.example.com" "arn:aws:acm:us-east-2:123456789012:certificate/12345678-1234-1234-1234-123456789012" 1 2018-07-02T22:22:48.364000Z "authenticate,forward" "-" "-" "10.0.0.1:80" "200" "-" "-"\n';
  const { fmt, recs } = parseOne(line, { tzShiftMin: 600 });
  assert.strictEqual(fmt.format, 'alb');
  const r = recs[0];
  assert.strictEqual(r.ip, '192.168.131.39');
  assert.strictEqual(r.method, 'GET');
  assert.strictEqual(r.path, '/orders/42?x=1');
  assert.strictEqual(r.status, 200);
  near(r.rt, 171, 1e-6);
  assert.strictEqual(r.t, Date.UTC(2018, 6, 2, 22, 23, 0, 186) + 600 * 60000); // UTC shifted by +10h
  // failed target: -1 processing times mean no response time
  const bad = parseOne(line.replace('0.086 0.048 0.037 200 200', '0.000 -1 -1 502 -')).recs[0];
  assert.ok(isNaN(bad.rt));
  assert.strictEqual(bad.status, 502);
});

const CF = '#Version: 1.0\n#Fields: date time x-edge-location sc-bytes c-ip cs-method cs(Host) cs-uri-stem sc-status cs(Referer) cs(User-Agent) cs-uri-query cs(Cookie) x-edge-result-type x-edge-request-id x-host-header cs-protocol cs-bytes time-taken x-forwarded-for ssl-protocol ssl-cipher x-edge-response-result-type cs-protocol-version fle-status fle-encrypted-fields c-port time-to-first-byte x-edge-detailed-result-type sc-content-type sc-content-len sc-range-start sc-range-end\n' +
  ['2019-12-04', '21:02:31', 'LAX1-C3', '392', '192.0.2.100', 'GET', 'd111111abcdef8.cloudfront.net', '/index.html', '200', '-', 'Mozilla/5.0%20(Windows%20NT%2010.0)', '-', '-', 'Hit', 'SOX4xwn4XV6Q4rgb7XiVGOHms_BGlTAC4KyHmureZmBNrjGdRLiNIQ==', 'd111111abcdef8.cloudfront.net', 'https', '23', '0.120', '-', 'TLSv1.2', 'ECDHE-RSA-AES128-GCM-SHA256', 'Hit', 'HTTP/2.0', '-', '-', '11040', '0.001', 'Hit', 'text/html', '78', '-', '-'].join('\t') + '\n';

test('AWS CloudFront standard log (#Fields, tab separated, seconds)', () => {
  const { fmt, recs } = parseOne(CF);
  assert.strictEqual(fmt.format, 'cloudfront');
  const r = recs[0];
  assert.strictEqual(r.path, '/index.html');
  assert.strictEqual(r.ip, '192.0.2.100');
  assert.strictEqual(r.status, 200);
  near(r.rt, 120, 1e-6);
  assert.strictEqual(r.t, Date.UTC(2019, 11, 4, 21, 2, 31));
});

test('CloudFront without its header still parses (default field order)', () => {
  const { fmt, recs } = parseOne(CF.split('\n')[2] + '\n');
  assert.strictEqual(fmt.format, 'cloudfront');
  assert.strictEqual(recs[0].path, '/index.html');
});

test('IIS W3C extended log (#Fields, space separated, milliseconds)', () => {
  const text = '#Software: Microsoft Internet Information Services 10.0\n#Version: 1.0\n#Date: 2026-10-30 00:00:01\n' +
    '#Fields: date time s-ip cs-method cs-uri-stem cs-uri-query s-port cs-username c-ip cs(User-Agent) cs(Referer) sc-status sc-substatus sc-win32-status time-taken\n' +
    '2026-10-30 00:00:01 10.0.0.5 POST /api/orders/12345 page=2 443 - 203.0.113.9 Mozilla/5.0+(Windows+NT+10.0) - 500 0 0 156\n';
  const { fmt, recs } = parseOne(text);
  assert.strictEqual(fmt.format, 'iis');
  const r = recs[0];
  assert.strictEqual(r.method, 'POST');
  assert.strictEqual(r.path, '/api/orders/12345');
  assert.strictEqual(r.status, 500);
  assert.strictEqual(r.ip, '203.0.113.9');
  near(r.rt, 156, 1e-9);
});

test('CSV with header: detection, column guessing, seconds unit', () => {
  const text = 'timestamp,client_ip,http_method,url,status_code,duration\n' +
    '2026-10-30T09:00:01Z,1.2.3.4,GET,/api/items/77,200,0.045\n2026-10-30T09:00:02Z,1.2.3.5,POST,/api/items,201,0.120\n';
  const fmt = W.detectFormat(text);
  assert.strictEqual(fmt.format, 'csv');
  assert.deepStrictEqual([fmt.mapping.time, fmt.mapping.ip, fmt.mapping.method, fmt.mapping.path, fmt.mapping.status, fmt.mapping.rt], [0, 1, 2, 3, 4, 5]);
  assert.strictEqual(fmt.rtUnit, 's');
  const r = parseOne(text).recs;
  assert.strictEqual(r.length, 2);
  near(r[1].rt, 120, 1e-6);
  assert.strictEqual(r[0].t, Date.UTC(2026, 9, 30, 9, 0, 1));
});

test('CSV with a combined "request" column and semicolons', () => {
  const text = 'time;request;status;ms\n30/Oct/2026:09:00:01 +1100;GET /a/1 HTTP/1.1;200;12\n';
  const fmt = W.detectFormat(text);
  assert.strictEqual(fmt.delimiter, ';');
  const r = parseOne(text).recs[0];
  assert.strictEqual(r.method, 'GET');
  assert.strictEqual(r.path, '/a/1');
});

test('JSON lines with nested keys', () => {
  const text = '{"@timestamp":"2026-10-30T09:00:01.250+11:00","http":{"method":"GET","path":"/x/9","status":503},"latency_ms":88,"client_ip":"9.9.9.9","user_agent":"Go"}\n';
  const fmt = W.detectFormat(text);
  assert.strictEqual(fmt.format, 'jsonl');
  assert.strictEqual(fmt.mapping.time, '@timestamp');
  assert.strictEqual(fmt.mapping.method, 'http.method');
  assert.strictEqual(fmt.mapping.path, 'http.path');
  assert.strictEqual(fmt.mapping.status, 'http.status');
  assert.strictEqual(fmt.mapping.rt, 'latency_ms');
  const r = parseOne(text).recs[0];
  assert.strictEqual(r.status, 503);
  near(r.rt, 88, 1e-9);
  assert.strictEqual(r.t, Date.UTC(2026, 9, 30, 9, 0, 1, 250)); // written with its own offset: kept as wall clock
});

test('unrecognised text returns null', () => {
  assert.strictEqual(W.detectFormat('hello world\nthis is not a log'), null);
});

console.log('Path normalisation');

test('query strings, IDs, UUIDs, hex, emails and tokens collapse to {id}', () => {
  const n = (p) => W.normalisePath(p);
  assert.strictEqual(n('/product/123?ref=home'), '/product/{id}');
  assert.strictEqual(n('/order/3f2b8c1e-9a4d-4b7e-8c21-0d9e6f1a2b3c/confirmation'), '/order/{id}/confirmation');
  assert.strictEqual(n('/blob/a3f9c2e1b4d5e6f7a8b9'), '/blob/{id}');
  assert.strictEqual(n('/users/jane.doe@example.com/prefs'), '/users/{id}/prefs');
  assert.strictEqual(n('/users/jane.doe%40example.com'), '/users/{id}');
  assert.strictEqual(n('/reset/aB3dE5fG7hJ9kL1mN3pQ5'), '/reset/{id}');
  assert.strictEqual(n('/images/products/1234.jpg'), '/images/products/{id}.jpg');
  assert.strictEqual(n('https://shop.example.com:443/cart/'), '/cart');
  assert.strictEqual(n('/'), '/');
  assert.strictEqual(n('/checkout;jsessionid=ABC'), '/checkout');
  assert.strictEqual(n('/category/shoes'), '/category/shoes'); // words stay
  assert.strictEqual(n('/v2/api'), '/v2/api');
});

test('user rules apply after the built-ins; bad regex is reported', () => {
  const { rules, errors } = W.parseRules('# comment\n^/category/[^/]+$ => /category/{slug}\n([ => x\nnot a rule');
  assert.strictEqual(rules.length, 1);
  assert.strictEqual(errors.length, 2);
  assert.strictEqual(W.normalisePath('/category/shoes?page=2', rules), '/category/{slug}');
});

test('static assets, bots and health checks are classified', () => {
  assert.strictEqual(W.classify('/static/app.js', 'Mozilla'), 1);
  assert.strictEqual(W.classify('/health', 'ELB-HealthChecker/2.0'), 2);
  assert.strictEqual(W.classify('/product/1', 'Mozilla/5.0 (compatible; Googlebot/2.1)'), 2);
  assert.strictEqual(W.classify('/product/1', 'Mozilla/5.0 (iPhone)'), 0);
});

console.log('Peak detection');

function clfLine(t, p, status, rt, ip) {
  const d = new Date(t);
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const z = (n) => String(n).padStart(2, '0');
  return (ip || '10.1.1.1') + ' - - [' + z(d.getUTCDate()) + '/' + M[d.getUTCMonth()] + '/' + d.getUTCFullYear() + ':' + z(d.getUTCHours()) + ':' + z(d.getUTCMinutes()) + ':' + z(d.getUTCSeconds()) +
    ' +0000] "GET ' + p + ' HTTP/1.1" ' + status + ' 10 "-" "Mozilla" ' + (rt / 1000).toFixed(3);
}

const base = Date.UTC(2026, 9, 30, 10, 0, 0);
const peakLines = [];
for (let s = 0; s < 3600; s++) { // 10:00 hour: 2 req/s
  peakLines.push(clfLine(base + s * 1000, '/a/' + s, 200, 100));
  peakLines.push(clfLine(base + s * 1000 + 500, '/b', s % 100 === 0 ? 500 : 200, 300));
}
for (let i = 0; i < 50; i++) peakLines.push(clfLine(base + 1800 * 1000, '/a/1', 200, 100)); // one 52-request second at 10:30:00
for (let s = 0; s < 3600; s++) peakLines.push(clfLine(base + 3600000 + s * 1000, '/b', 200, 300)); // 11:00 hour: 1 req/s
for (let s = 0; s < 60; s++) peakLines.push(clfLine(base + 7200000 + s * 1000, '/health', 200, 1)); // excluded
peakLines.sort();
const peakRes = W.analyseText(peakLines.join('\n'));

test('peak hour, minute, max second and p99-of-seconds', () => {
  const m = W.buildModel(peakRes, {});
  assert.strictEqual(m.peak.hourStart, base);
  assert.strictEqual(m.peak.hourCount, 7250);
  assert.strictEqual(m.peak.maxSecRps, 52);
  assert.strictEqual(m.peak.maxSecT, base + 1800000);
  assert.strictEqual(m.peak.p99SecRps, 2); // the single spike doesn't move p99
  assert.strictEqual(m.peak.minuteStart, base + 1800000);
  near(m.peak.minuteRps, 170 / 60, 1e-9);
  near(m.peak.hourAvgRps, 7250 / 3600, 1e-9);
  assert.strictEqual(m.excluded.bots, 60);
  assert.strictEqual(m.total, 7250 + 3600);
});

test('transaction mix at the peak hour', () => {
  const m = W.buildModel(peakRes, {});
  assert.strictEqual(m.mix.length, 2);
  const a = m.mix.find((r) => r.endpoint === '/a/{id}'), b = m.mix.find((r) => r.endpoint === '/b');
  assert.strictEqual(a.count, 3650);
  assert.strictEqual(b.count, 3600);
  near(a.share + b.share, 1, 1e-12);
  near(b.errPct, 36 / 3600 * 100, 1e-9);
  near(b.p95, 300, 300 * 0.08, 'p95 within histogram accuracy');
  near(a.p95, 100, 100 * 0.08);
});

test('including bots changes totals without re-reading', () => {
  const m = W.buildModel(peakRes, { excludeBots: false });
  assert.strictEqual(m.total, 7250 + 3600 + 60);
});

test('merging endpoints combines counts and keeps members', () => {
  const m = W.buildModel(peakRes, { merges: { 'GET /a/{id}': 'Browse', 'GET /b': 'Browse' } });
  assert.strictEqual(m.mix.length, 1);
  assert.strictEqual(m.mix[0].label, 'Browse');
  assert.strictEqual(m.mix[0].count, 7250);
  assert.strictEqual(m.mix[0].members.length, 2);
});

console.log("Little's law and the load model");

test("Little's law numbers", () => {
  const l = W.littlesLaw(100, 0.2, 4.8);
  near(l.users, 500, 1e-9);
  near(l.inFlight, 20, 1e-9);
});

test('target = base x coverage x growth x headroom; VUs from response + think time', () => {
  const m = W.buildModel(peakRes, { basis: 'minute', growth: 1.5, headroom: 20, coverage: 2, rtMs: 200, thinkS: 4.8 });
  const expect = (170 / 60) * 2 * 1.5 * 1.2;
  near(m.model.target, expect, 1e-9);
  near(m.model.usersClosed, expect * 5, 1e-9);
  near(m.model.inFlight, expect * 0.2, 1e-9);
  const p99 = W.buildModel(peakRes, { basis: 'p99', growth: 2, headroom: 0 });
  near(p99.model.target, 4, 1e-9);
  assert.strictEqual(p99.model.rtSource, 'logs');
});

console.log('Sessions');

test('sessions split on 30-minute gaps; think time ignores sub-second gaps', () => {
  const t0 = Date.UTC(2026, 9, 30, 9, 0, 0);
  const L = [];
  // visitor A: requests at 0s, 0.3s (same page), 10s, 30s -> then 40 min later a new session of 1 request
  for (const s of [0, 0.3, 10, 30, 30 + 2400]) L.push(clfLine(t0 + s * 1000, '/p', 200, 50, '1.1.1.1'));
  L.push(clfLine(t0 + 5000, '/p', 200, 50, '2.2.2.2'));
  L.sort();
  const m = W.buildModel(W.analyseText(L.join('\n')), {});
  assert.strictEqual(m.sessions.count, 3);
  assert.strictEqual(m.sessions.visitors, 2);
  assert.strictEqual(m.sessions.thinkSamples, 2); // 9.7 s and 20 s
  near(m.sessions.thinkMedianS, 9.7, 9.7 * 0.08);
});

console.log('Sample log and exports');

const sample = W.generateSampleLog({ lines: 60000, seed: 3 });
const sres = W.analyseText(sample);
const smodel = W.buildModel(sres, {});

test('sample log: parses fully, peak in the evening, sensible mix', () => {
  assert.strictEqual(sres.unparsed, 0);
  assert.ok(sres.lines > 55000);
  const h = new Date(smodel.peak.hourStart).getUTCHours();
  assert.ok(h >= 18 && h <= 21, 'peak hour ' + h);
  assert.ok(smodel.mix.some((r) => r.endpoint === '/product/{id}'));
  assert.ok(smodel.mix.some((r) => r.endpoint === '/api/checkout/payment' && r.errPct > 0));
  assert.ok(smodel.excluded.static > 0 && smodel.excluded.bots > 0);
  assert.ok(smodel.sessions && smodel.sessions.thinkMedianS > 2);
  assert.ok(!smodel.mix.some((r) => /\.(js|css|jpg)$/.test(r.endpoint)));
});

test('CSV, JSON and JMeter exports', () => {
  const csv = W.mixToCsv(smodel).trim().split('\n');
  assert.strictEqual(csv[0], 'endpoint,method,count_peak_hour,percent,req_per_s_peak_hour,req_per_s_target,p95_ms,error_5xx_percent');
  assert.strictEqual(csv.length, smodel.mix.length + 1);
  const j = JSON.parse(W.mixToJson(smodel));
  near(j.mix.reduce((a, r) => a + r.percent, 0), 100, 0.05);
  const jm = W.mixToJmeterCsv(smodel).trim().split('\n');
  assert.strictEqual(jm[0], 'label,method,path,weight_percent');
  near(jm.slice(1).reduce((a, l) => a + parseFloat(l.split(',').pop()), 0), 100, 0.5);
});

test('k6 script: rates add up to the target and scenarios are well formed', () => {
  const g = W.generateK6(smodel, { profile: 'constant', topN: 5, durationMin: 10 });
  assert.strictEqual(g.scenarios, 6); // 5 + other
  const rates = [...g.script.matchAll(/rate: (\d+), timeUnit: '(1s|1m)'/g)].map((m) => +m[1] / (m[2] === '1m' ? 60 : 1));
  assert.strictEqual(rates.length, 6);
  const sum = rates.reduce((a, b) => a + b, 0);
  near(sum, smodel.model.target, Math.max(0.1, smodel.model.target * 0.05), 'sum of scenario rates');
  assert.ok(/executor: 'constant-arrival-rate'/.test(g.script));
  assert.ok(/preAllocatedVUs: \d+, maxVUs: \d+/.test(g.script));
  assert.ok(!/(\d{1,3}\.){3}\d{1,3}/.test(g.script.replace(/k6 v[\d.]+/g, '')), 'no IP addresses leak into the script');
});

const k6bin = ['/opt/homebrew/bin/k6', '/usr/local/bin/k6', '/usr/bin/k6'].find((p) => fs.existsSync(p));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-k6-'));
for (const profile of ['constant', 'ramp', 'curve']) {
  test('k6 inspect accepts the ' + profile + ' profile' + (k6bin ? '' : ' (k6 not installed: syntax check only)'), () => {
    const g = W.generateK6(smodel, { profile, topN: 8, durationMin: 15, rampMin: 3, compressMin: 12 });
    const f = path.join(tmp, 'workload-' + profile + '.js');
    fs.writeFileSync(f, g.script);
    if (!k6bin) { new Function(g.script.replace(/^import .*$/gm, '').replace(/^export /gm, '')); return; }
    const out = JSON.parse(execFileSync(k6bin, ['inspect', f], { encoding: 'utf8' }));
    const sc = out.scenarios;
    assert.ok(Object.keys(sc).length >= 8);
    const first = sc[Object.keys(sc)[0]];
    assert.strictEqual(first.executor, profile === 'constant' ? 'constant-arrival-rate' : 'ramping-arrival-rate');
    if (profile === 'curve') assert.strictEqual(first.stages.length, 25);
    assert.ok(out.thresholds.http_req_failed);
  });
}

test('k6 script survives odd endpoint names (quotes, unicode, merged groups)', () => {
  const text = [
    clfLine(base, "/it's/ok", 200, 10), clfLine(base + 1, '/caf%C3%A9/é', 200, 10), clfLine(base + 2, '/x"y', 200, 10)
  ].join('\n');
  const m = W.buildModel(W.analyseText(text), { merges: { "GET /it's/ok": 'Group "A"' } });
  const g = W.generateK6(m, { profile: 'ramp' });
  const f = path.join(tmp, 'workload-odd.js');
  fs.writeFileSync(f, g.script);
  if (k6bin) execFileSync(k6bin, ['inspect', f], { encoding: 'utf8' });
  else new Function(g.script.replace(/^import .*$/gm, '').replace(/^export /gm, ''));
});

console.log('Performance');

test('1M-line nginx log in Node (parse + aggregate)', () => {
  const big = W.generateSampleLog({ lines: 1000000, seed: 11 });
  const t = Date.now();
  const r = W.analyseText(big);
  const ms = Date.now() - t;
  console.log('       (' + r.lines.toLocaleString() + ' lines, ' + (big.length / 1e6).toFixed(0) + ' MB in ' + ms + ' ms)');
  assert.strictEqual(r.unparsed, 0);
  assert.ok(ms < 20000);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
