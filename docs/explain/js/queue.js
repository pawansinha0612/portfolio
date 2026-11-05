/* Queueing maths for /explain/queueing/: M/M/c with Erlang C, response-time percentiles and Little's law.
   Browser (window.ExplainQueue) and Node (module.exports); tested in explain/test-explain.js.
   Units: lambda = arrivals per second, serviceMs = mean time one server spends on one request. */
(function (root) {
  'use strict';

  // Erlang C: probability an arriving request has to wait, for c servers and offered load a = lambda / mu (Erlangs).
  // Computed with the stable Erlang B recursion. Returns 1 when the system is overloaded (a >= c).
  function erlangC(c, a) {
    if (a <= 0) return 0;
    if (a >= c) return 1;
    let b = 1;
    for (let k = 1; k <= c; k++) b = (a * b) / (k + a * b);
    return (c * b) / (c - a * (1 - b));
  }

  function mmc(lambda, serviceMs, c) {
    const mu = 1000 / serviceMs;          // completions per second per server
    const a = lambda / mu;                // offered load (busy servers on average)
    const rho = a / c;                    // utilisation per server
    if (rho >= 1) return { lambda, mu, c, a, rho, stable: false, pWait: 1, wqMs: Infinity, wMs: Infinity, p95Ms: Infinity, p99Ms: Infinity, L: Infinity, Lq: Infinity };
    const pWait = erlangC(c, a);
    const theta = c * mu - lambda;        // drain rate of the queue
    const wq = pWait / theta;             // mean wait in queue (s)
    const w = wq + 1 / mu;                // mean response time (s)
    const res = { lambda, mu, c, a, rho, stable: true, pWait, wqMs: wq * 1000, wMs: w * 1000, L: lambda * w, Lq: lambda * wq };
    res.p95Ms = responsePercentile(res, 0.95);
    res.p99Ms = responsePercentile(res, 0.99);
    return res;
  }

  // P(response time > t) for M/M/c. Response = queue wait (0 with prob 1-C, else Exp(theta)) + service Exp(mu).
  function tailProb(q, tSec) {
    const mu = q.mu;
    const theta = q.c * q.mu - q.lambda;
    const C = q.pWait;
    const svc = Math.exp(-mu * tSec);
    let both;
    if (Math.abs(theta - mu) < 1e-9 * mu) both = Math.exp(-mu * tSec) * (1 + mu * tSec);
    else both = (theta * Math.exp(-mu * tSec) - mu * Math.exp(-theta * tSec)) / (theta - mu);
    return (1 - C) * svc + C * both;
  }
  function responsePercentile(q, p) {
    if (!q.stable) return Infinity;
    let lo = 0;
    let hi = 1 / q.mu;
    while (tailProb(q, hi) > 1 - p) hi *= 2;
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2;
      if (tailProb(q, mid) > 1 - p) lo = mid; else hi = mid;
    }
    return hi * 1000;
  }

  // Points for the hockey-stick chart: utilisation from 1% to 99% for c servers.
  function curve(serviceMs, c, steps) {
    const mu = 1000 / serviceMs;
    const pts = [];
    const n = steps || 98;
    for (let i = 1; i <= n; i++) {
      const rho = i / (n + 1);
      const q = mmc(rho * c * mu, serviceMs, c);
      pts.push({ rho, wMs: q.wMs, p95Ms: q.p95Ms });
    }
    return pts;
  }

  // Little's law: L = lambda * W. Give any two, get the third.
  function little(o) {
    if (o.L == null) return o.lambda * o.W;
    if (o.lambda == null) return o.L / o.W;
    return o.L / o.lambda;
  }

  const api = { erlangC, mmc, tailProb, responsePercentile, curve, little };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ExplainQueue = api;
})(this);
