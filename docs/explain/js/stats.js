/* Latency statistics for /explain/percentiles/. Runs in the browser (window.ExplainStats) and in Node (module.exports)
   so the maths is unit-tested (explain/test-explain.js). Everything is deterministic for a given seed. */
(function (root) {
  'use strict';

  // Small seeded random number generator (mulberry32), so a preset always draws the same picture.
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function normal(r) { // Box-Muller
    let u = 0;
    while (u === 0) u = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
  }

  // Percentile with linear interpolation between closest ranks (the common "type 7" definition).
  function percentile(sorted, p) {
    if (!sorted.length) return NaN;
    if (p <= 0) return sorted[0];
    if (p >= 100) return sorted[sorted.length - 1];
    const h = (sorted.length - 1) * (p / 100);
    const lo = Math.floor(h);
    return sorted[lo] + (h - lo) * ((sorted[lo + 1] === undefined ? sorted[lo] : sorted[lo + 1]) - sorted[lo]);
  }
  function summary(values) {
    const s = values.slice().sort((a, b) => a - b);
    const n = s.length;
    const mean = n ? s.reduce((t, v) => t + v, 0) / n : NaN;
    return { n, mean, min: s[0], p50: percentile(s, 50), p90: percentile(s, 90), p95: percentile(s, 95), p99: percentile(s, 99), max: s[n - 1] };
  }
  // Fixed-width histogram; values above `max` land in the last bin.
  function histogram(values, bins, max) {
    const out = new Array(bins).fill(0);
    const w = max / bins;
    for (const v of values) out[Math.min(bins - 1, Math.max(0, Math.floor(v / w)))]++;
    return out;
  }

  // Request latency samples (ms). Shapes: 'normal', 'longtail' (log-normal), 'bimodal' (cache hits and misses).
  // Presets add a realistic cause on top of a healthy base.
  const PRESETS = {
    healthy:   { label: 'Healthy service',      shape: 'normal' },
    longtail:  { label: 'Long tail',            shape: 'longtail' },
    slowdep:   { label: 'One slow dependency',  shape: 'normal', slowShare: 0.04, slowMs: 900 },
    gc:        { label: 'GC pauses',            shape: 'normal', gcEvery: 250, gcLen: 6, gcMs: 350 },
    cachemiss: { label: 'Cache misses',         shape: 'bimodal', missShare: 0.18 }
  };
  function generate(opts) {
    const o = Object.assign({ n: 2000, seed: 42, shape: 'normal', base: 120, spread: 25 }, opts || {});
    const r = rng(o.seed);
    const out = [];
    for (let i = 0; i < o.n; i++) {
      let v;
      if (o.shape === 'longtail') v = Math.exp(Math.log(o.base * 0.85) + 0.45 * normal(r));
      else if (o.shape === 'bimodal') v = r() < (o.missShare == null ? 0.18 : o.missShare)
        ? o.base * 3.2 + o.spread * 1.6 * normal(r) : o.base * 0.7 + o.spread * 0.6 * normal(r);
      else v = o.base + o.spread * normal(r);
      if (o.slowShare && r() < o.slowShare) v += o.slowMs * (0.8 + 0.4 * r());
      if (o.gcEvery && i % o.gcEvery < o.gcLen) v += o.gcMs * (1 - (i % o.gcEvery) / (o.gcLen + 1));
      out.push(Math.max(1, Math.round(v * 10) / 10));
    }
    return out;
  }

  /* Coordinated omission. A load generator plans one request every `intervalMs`. The system freezes once for
     `stallMs` starting at `stallAt` ms. Closed-loop testers wait for each response before sending the next one,
     so they only record ONE slow request during the freeze ("measured"). The requests they should have sent
     meanwhile were delayed too; measuring each from its intended start time gives the "corrected" view. */
  function coordinatedOmission(opts) {
    const o = Object.assign({ durationMs: 60000, intervalMs: 50, serviceMs: 20, jitterMs: 6, stallAt: 30000, stallMs: 3000, seed: 7 }, opts || {});
    const r = rng(o.seed);
    const stallEnd = o.stallAt + o.stallMs;
    const finish = (start, svc) => (start >= o.stallAt && start < stallEnd ? stallEnd + svc
      : start < o.stallAt && start + svc > o.stallAt ? stallEnd + svc - (o.stallAt - start) : start + svc);
    const measured = [];
    const corrected = [];
    let free = 0;
    for (let intended = 0; intended < o.durationMs; intended += o.intervalMs) {
      const svc = Math.max(1, o.serviceMs + o.jitterMs * normal(r));
      const sent = Math.max(intended, free); // closed loop: can't send before the previous reply came back
      const done = finish(sent, svc);
      free = done;
      measured.push(done - sent);
      corrected.push(done - intended);
    }
    return { measured, corrected };
  }

  const api = { rng, normal, percentile, summary, histogram, generate, coordinatedOmission, PRESETS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ExplainStats = api;
})(this);
