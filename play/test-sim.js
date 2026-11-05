// Unit tests for the Hold the Line traffic model: node play/test-sim.js
const assert = require('assert');
const S = require('../docs/play/hold-the-line/sim.js');
const cfg = (o) => Object.assign(S.defaultConfig(), o);
let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok', name); };

test('more servers -> lower p95 at the same load', () => {
  const t = { rps: 2000, bots: 0, checkout: 0.03 };
  const a = S.evaluate(cfg({ servers: 5, cache: 3, cdn: true }), 5, t);
  const b = S.evaluate(cfg({ servers: 10, cache: 3, cdn: true }), 10, t);
  assert(b.p95 < a.p95, `${b.p95} < ${a.p95}`);
  assert(b.util < a.util);
});

test('p95 grows faster than linearly as utilisation rises', () => {
  const c = cfg({ servers: 10, cache: 3, cdn: true });
  const p = [0.3, 0.6, 0.9].map(u => S.evaluate(c, 10, { rps: u * 10 * S.K.APP_RPS / 0.6, checkout: 0 }).p95);
  assert(p[2] - p[1] > p[1] - p[0], p.join(','));
});

test('cache cuts database reads', () => {
  const t = { rps: 2000, checkout: 0.03 };
  const reads = [0, 1, 2, 3].map(level => S.evaluate(cfg({ servers: 10, cache: level }), 10, t).reads);
  for (let i = 1; i < reads.length; i++) assert(reads[i] < reads[i - 1], reads.join(','));
  assert(Math.abs(reads[3] / reads[0] - (1 - S.K.CACHE_HIT[3])) < 1e-9);
});

test('CDN offloads browsing but not checkouts', () => {
  const t = { rps: 2000, checkout: 0.05 };
  const a = S.evaluate(cfg({ servers: 10, cache: 3 }), 10, t), b = S.evaluate(cfg({ servers: 10, cache: 3, cdn: true }), 10, t);
  assert(b.origin < a.origin);
  assert(Math.abs(a.orders - b.orders) < 1e-9, 'orders unchanged by the CDN');
});

test('read replicas lower primary load; writes stay on the primary', () => {
  const t = { rps: 3000, checkout: 0.05 };
  const a = S.evaluate(cfg({ servers: 12 }), 12, t), b = S.evaluate(cfg({ servers: 12, replicas: 2 }), 12, t);
  assert(b.primaryUtil < a.primaryUtil);
  assert.strictEqual(a.writes, b.writes);
});

test('saturation -> errors and timeouts', () => {
  const r = S.evaluate(cfg({ servers: 2, cache: 3, cdn: true }), 2, { rps: 5000, checkout: 0.03 });
  assert(r.util > 1);
  assert(r.errRate > 0.3, 'err ' + r.errRate);
  assert(r.p95 >= 1000);
  const ok = S.evaluate(cfg({ servers: 2, cache: 3, cdn: true }), 2, { rps: 300, checkout: 0.03 });
  assert.strictEqual(ok.errRate, 0);
});

test("Little's law: connections = qps x latency, and the limit causes errors", () => {
  const r = S.evaluate(cfg({ servers: 30 }), 30, { rps: 6000, checkout: 0.03 });
  assert(Math.abs(r.connInUse - (r.reads + r.writes) * r.dbMs / 1000) < 1e-9);
  assert(r.connInUse > r.connLimit && r.errRate > 0);
  const p = S.evaluate(cfg({ servers: 30, pooler: true }), 30, { rps: 6000, checkout: 0.03 });
  assert(p.connLimit > r.connLimit);
});

test('scaling the app tier alone can overload the database', () => {
  const t = { rps: 4000, checkout: 0.04 };
  const a = S.evaluate(cfg({ servers: 4 }), 4, t), b = S.evaluate(cfg({ servers: 16 }), 16, t);
  assert(b.dbUtil > a.dbUtil);
});

test('autoscaling lags: new servers only serve after warm-up', () => {
  const wave = { seconds: 80, f: () => ({ rps: 6000, bots: 0, checkout: 0.02 }) };
  const st = S.createRun(cfg({ servers: 4, cache: 3, cdn: true, pooler: true, autoscale: true }), wave);
  const seen = [];
  while (st.t < wave.seconds) seen.push(S.step(st));
  const firstScale = st.events.find(e => e.type === 'scale');
  assert(firstScale, 'scaled');
  assert.strictEqual(seen[firstScale.t + S.K.WARMUP - 1].warm, 4, 'still 4 warm just before warm-up ends');
  assert(seen[firstScale.t + S.K.WARMUP].warm > 4, 'more servers after warm-up');
  assert(seen[5].errRate > seen[seen.length - 1].errRate, 'errors fall once servers are warm');
  assert(Math.abs(seen[firstScale.t].costHour - seen[firstScale.t - 1].costHour - firstScale.n * S.COST.server) < 1e-9, 'you pay while they warm up');
});

test('rate limiter blocks bots', () => {
  const t = { rps: 3000, bots: 5000, checkout: 0.03 };
  const a = S.evaluate(cfg({ servers: 10, cdn: true, cache: 3 }), 10, t), b = S.evaluate(cfg({ servers: 10, cdn: true, cache: 3, limiter: true }), 10, t);
  assert(b.origin < a.origin && b.botsBlocked > 0);
});

test('checkout queue keeps orders flowing when the database is the bottleneck', () => {
  const wave = S.WAVES[2];
  const base = { servers: 12, cache: 2, cdn: true, pooler: true };
  const a = S.runWave(cfg(base), wave), b = S.runWave(cfg(Object.assign({ queue: true }, base)), wave);
  assert(b.errSum / b.legitSum < a.errSum / a.legitSum);
});

test('every wave is winnable within roughly its budget', () => {
  const plans = [
    {}, { servers: 6, cache: 2, cdn: true }, { servers: 10, cache: 2, cdn: true, queue: true, pooler: true, replicas: 1 },
    { servers: 10, cache: 2, cdn: true, queue: true, pooler: true, limiter: true },
    { servers: 21, cache: 3, cdn: true, queue: true, pooler: true, limiter: true, dbSize: 1, replicas: 1 },
  ];
  S.WAVES.forEach((w, i) => {
    const c = cfg(plans[i]); const st = S.runWave(c, w);
    assert.strictEqual(st.livesLost, 0, w.name + ' lives lost ' + st.livesLost);
    assert(S.costPerHour(c) <= w.budget, `${w.name} cost ${S.costPerHour(c)} > ${w.budget}`);
  });
});

test('the starting setup fails the sale launch', () => {
  assert(S.runWave(S.defaultConfig(), S.WAVES[1]).livesLost > 0);
});

console.log(`${n} tests passed`);
