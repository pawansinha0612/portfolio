// Unit tests for the /explain/ maths. Run: node explain/test-explain.js  (k6 checks run only if `k6` is on PATH)
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const S = require('../docs/explain/js/stats.js');
const Q = require('../docs/explain/js/queue.js');
const P = require('../docs/explain/js/profiles.js');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('ok  ' + name); };
const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} ± ${tol}, got ${a}`);

// ---- stats
t('percentile interpolates (type 7)', () => {
  const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  near(S.percentile(s, 50), 5.5, 1e-9);
  near(S.percentile(s, 90), 9.1, 1e-9);
  assert.strictEqual(S.percentile(s, 100), 10);
  assert.strictEqual(S.percentile([42], 99), 42);
});
t('summary of 1..100', () => {
  const v = Array.from({ length: 100 }, (_, i) => i + 1).reverse();
  const r = S.summary(v);
  near(r.mean, 50.5, 1e-9); near(r.p95, 95.05, 1e-9); assert.strictEqual(r.max, 100); assert.strictEqual(r.min, 1);
});
t('generator is deterministic per seed', () => {
  assert.deepStrictEqual(S.generate({ seed: 3, n: 50 }), S.generate({ seed: 3, n: 50 }));
  assert.notDeepStrictEqual(S.generate({ seed: 3, n: 50 }), S.generate({ seed: 4, n: 50 }));
});
t('average hides a slow dependency; p99 shows it', () => {
  const healthy = S.summary(S.generate({ seed: 1 }));
  const slow = S.summary(S.generate(Object.assign({ seed: 1 }, S.PRESETS.slowdep)));
  assert(slow.mean / healthy.mean < 1.45, 'mean rises modestly');
  assert(slow.p99 / healthy.p99 > 4, 'p99 jumps');
});
t('long tail: p99 well above median', () => {
  const r = S.summary(S.generate({ seed: 2, shape: 'longtail' }));
  assert(r.p99 > 2.2 * r.p50 && r.mean > r.p50);
});
t('cache misses make two humps', () => {
  const v = S.generate({ seed: 5, shape: 'bimodal', missShare: 0.2 });
  const h = S.histogram(v, 40, 600);
  const peakA = h.slice(0, 10).reduce((m, x) => Math.max(m, x), 0);
  const valley = Math.min(...h.slice(10, 17));
  const peakB = h.slice(17, 30).reduce((m, x) => Math.max(m, x), 0);
  assert(peakA > valley * 3 && peakB > valley * 2, 'bimodal');
});
t('histogram counts every value', () => {
  const v = S.generate({ seed: 9, n: 777 });
  assert.strictEqual(S.histogram(v, 30, 200).reduce((a, b) => a + b, 0), 777);
});
t('coordinated omission hides the stall', () => {
  const r = S.coordinatedOmission();
  const m = S.summary(r.measured);
  const c = S.summary(r.corrected);
  assert(m.p99 < 100, 'closed-loop p99 looks fine: ' + m.p99);
  assert(c.p99 > 1000, 'corrected p99 shows the stall: ' + c.p99);
  assert(r.measured.filter((x) => x > 1000).length === 1, 'only one slow request recorded');
});

// ---- queueing
t('Erlang C for c=1 equals utilisation', () => { near(Q.erlangC(1, 0.7), 0.7, 1e-12); });
t('Erlang C known value (c=2, a=1 -> 1/3)', () => { near(Q.erlangC(2, 1), 1 / 3, 1e-12); });
t('M/M/1 mean and p95 match closed form', () => {
  const q = Q.mmc(8, 100, 1); // mu = 10/s
  near(q.wMs, 1000 / (10 - 8), 1e-6);
  near(q.p95Ms, 1000 * Math.log(20) / 2, 0.01);
});
t('latency explodes near 100% utilisation (hockey stick)', () => {
  const at = (rho) => Q.mmc(rho * 10, 100, 1).wMs;
  assert(at(0.5) < 2.1 * 100 && at(0.9) > 9 * 100 && at(0.99) > 90 * 100);
  assert((at(0.95) - at(0.9)) > 5 * (at(0.5) - at(0.4)), 'slope steepens');
});
t('more servers at same utilisation queue less', () => {
  const one = Q.mmc(0.8 * 10, 100, 1);
  const eight = Q.mmc(0.8 * 80, 100, 8);
  assert(eight.pWait < one.pWait && eight.wMs < one.wMs);
});
t('overload is unstable', () => { assert.strictEqual(Q.mmc(20, 100, 1).stable, false); });
t('tail probability is a valid survival function', () => {
  const q = Q.mmc(50, 100, 8);
  near(Q.tailProb(q, 0), 1, 1e-9);
  assert(Q.tailProb(q, 0.1) > Q.tailProb(q, 0.5) && Q.tailProb(q, 10) < 1e-6);
  assert(q.p99Ms > q.p95Ms && q.p95Ms > q.wMs);
});
t("Little's law round trips and matches mmc", () => {
  near(Q.little({ lambda: 200, W: 0.25 }), 50, 1e-12);
  near(Q.little({ L: 50, W: 0.25 }), 200, 1e-12);
  near(Q.little({ L: 50, lambda: 200 }), 0.25, 1e-12);
  const q = Q.mmc(50, 100, 8);
  near(q.L, 50 * q.wMs / 1000, 1e-9);
});
t('curve is increasing', () => {
  const c = Q.curve(100, 4, 50);
  for (let i = 1; i < c.length; i++) assert(c[i].wMs >= c[i - 1].wMs);
});

// ---- profiles
t('duration formatting', () => {
  assert.strictEqual(P.dur(90), '1m30s'); assert.strictEqual(P.dur(3600), '1h'); assert.strictEqual(P.dur(3725), '1h2m5s'); assert.strictEqual(P.dur(0), '1s');
});
t('stages follow points; zero-length segments skipped', () => {
  const s = P.stagesOf([{ t: 0, v: 0 }, { t: 60, v: 10 }, { t: 60, v: 50 }, { t: 120, v: 50 }]);
  assert.deepStrictEqual(s, [{ duration: '1m', target: 10 }, { duration: '1m', target: 50 }]);
});
t('valueAt interpolates', () => {
  const p = P.PRESETS.load.points;
  near(P.valueAt(p, 60), 25, 1e-9); near(P.valueAt(p, 400), 50, 1e-9); near(P.valueAt(p, 9999), 0, 1e-9);
});
t('options per preset have the right executor and thresholds', () => {
  for (const [k, pr] of Object.entries(P.PRESETS)) {
    const o = P.toOptions(pr, { p95: 500, errorRate: 0.02 });
    const sc = o.scenarios.main;
    assert.strictEqual(sc.executor, pr.mode === 'rate' ? 'ramping-arrival-rate' : 'ramping-vus', k);
    assert(sc.stages.length >= 1);
    const th = JSON.stringify(o.thresholds);
    assert(th.includes('p(95)<500') && th.includes('rate<0.02'), k);
    assert.strictEqual(th.includes('abortOnFail'), !!pr.abort, k);
  }
});

let k6 = null;
try { execFileSync('k6', ['version'], { stdio: 'ignore' }); k6 = 'k6'; } catch (e) { /* not installed */ }
if (k6) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'explain-k6-'));
  t('every preset script passes k6 inspect with the same options', () => {
    for (const [k, pr] of Object.entries(P.PRESETS)) {
      const f = path.join(dir, k + '.js');
      fs.writeFileSync(f, P.toScript(pr, { p95: 600, errorRate: 0.01 }, pr.name));
      const out = JSON.parse(execFileSync(k6, ['inspect', '--execution-requirements', f], { encoding: 'utf8' }));
      const sc = out.scenarios.main;
      assert.strictEqual(sc.executor, pr.mode === 'rate' ? 'ramping-arrival-rate' : 'ramping-vus', k);
      assert.strictEqual(sc.stages.length, P.stagesOf(pr.points).length, k);
    }
  });
  t('an edited profile also inspects', () => {
    const f = path.join(dir, 'edited.js');
    fs.writeFileSync(f, P.toScript({ mode: 'vus', points: [{ t: 0, v: 3 }, { t: 45, v: 17 }, { t: 1000, v: 17.4 }, { t: 1061, v: 0 }] }));
    const out = JSON.parse(execFileSync(k6, ['inspect', f], { encoding: 'utf8' }));
    assert.deepStrictEqual(out.scenarios.main.stages.map((s) => s.target), [17, 17, 0]);
  });
} else console.log('skip k6 inspect (k6 not installed)');

console.log(`\n${pass} tests passed`);
