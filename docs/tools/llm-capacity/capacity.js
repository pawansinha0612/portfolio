/* LLM capacity and cost model. Browser (window.LlmCapacity) and Node (module.exports) so it can be tested.
   Turns users and token sizes into peak requests and tokens per minute, compares them with the provider's limits,
   estimates concurrency with Little's law, and prices a month of traffic. No prices are built in: the visitor
   enters their own, because list prices change often. */
(function (root) {
  'use strict';

  const DEFAULTS = {
    dau: 5000, reqPerUserDay: 6, callsPerRequest: 1, busyHourPct: 15, peakFactor: 2,
    inTokens: 1500, outTokens: 300, maxTokens: 1024, countMaxTokens: false,
    rpmLimit: 5000, tpmLimit: 2000000, otpmLimit: 0,
    ttft: 0.8, tokensPerSec: 60,
    priceIn: 1, priceOut: 4, cachedPct: 0, priceCached: 0.1, days: 30,
  };

  // Shapes of common AI features. Token sizes and call counts only, never prices.
  const PRESETS = {
    chatbot: { label: 'Support chatbot', dau: 5000, reqPerUserDay: 6, callsPerRequest: 1, inTokens: 1500, outTokens: 300, maxTokens: 1024 },
    rag: { label: 'RAG search', dau: 20000, reqPerUserDay: 4, callsPerRequest: 2, inTokens: 4000, outTokens: 400, maxTokens: 800 },
    agent: { label: 'AI agent (many calls)', dau: 1000, reqPerUserDay: 10, callsPerRequest: 8, inTokens: 6000, outTokens: 500, maxTokens: 2048 },
    writer: { label: 'Writing assistant', dau: 3000, reqPerUserDay: 15, callsPerRequest: 1, inTokens: 800, outTokens: 700, maxTokens: 1500 },
  };

  const pos = (v, d) => { const n = Number(String(v).replace(/[, _]/g, '')); return Number.isFinite(n) && n >= 0 ? n : d; };

  function calc(input) {
    const o = Object.assign({}, DEFAULTS, input || {});
    const k = {};
    for (const key of Object.keys(DEFAULTS)) k[key] = typeof DEFAULTS[key] === 'boolean' ? !!o[key] : pos(o[key], DEFAULTS[key]);
    const errors = [];
    if (k.busyHourPct <= 0 || k.busyHourPct > 100) errors.push('Busiest-hour share must be between 1 and 100%.');
    if (k.peakFactor < 1) errors.push('Peak factor must be 1 or more (1 = traffic spread evenly across the busiest hour).');
    if (k.tokensPerSec <= 0) errors.push('Tokens per second must be more than 0.');
    if (errors.length) return { errors };

    const dailyCalls = k.dau * k.reqPerUserDay * k.callsPerRequest;
    const busyHourCalls = dailyCalls * k.busyHourPct / 100;
    const avgRpm = busyHourCalls / 60;
    const peakRpm = avgRpm * k.peakFactor;
    const peakRps = peakRpm / 60;

    const outForLimit = k.countMaxTokens ? Math.max(k.maxTokens, k.outTokens) : k.outTokens;
    const tokensPerCallForLimit = k.inTokens + outForLimit;
    const peakTpm = peakRpm * tokensPerCallForLimit;
    const peakOtpm = peakRpm * outForLimit;

    const limits = [];
    if (k.rpmLimit > 0) limits.push({ name: 'Requests per minute (RPM)', need: peakRpm, limit: k.rpmLimit });
    if (k.tpmLimit > 0) limits.push({ name: 'Tokens per minute (TPM)', need: peakTpm, limit: k.tpmLimit });
    if (k.otpmLimit > 0) limits.push({ name: 'Output tokens per minute', need: peakOtpm, limit: k.otpmLimit });
    limits.forEach(l => { l.used = l.need / l.limit; });
    const binding = limits.slice().sort((a, b) => b.used - a.used)[0] || null;
    const used = binding ? binding.used : 0;
    let verdict = 'none', rejectedShare = 0, maxDau = null;
    if (binding) {
      verdict = used > 1 ? 'over' : used > 0.7 ? 'tight' : 'ok';
      rejectedShare = used > 1 ? 1 - 1 / used : 0;
      maxDau = used > 0 ? k.dau / used : null;
    }

    const latency = k.ttft + k.outTokens / k.tokensPerSec;   // seconds for one answer
    const concurrency = peakRps * latency;                      // Little's law: in flight = arrival rate × time in system
    const testRpm = Math.ceil(peakRpm * 1.5);                   // test above forecast peak, not at it

    const monthCalls = dailyCalls * k.days;
    const monthIn = monthCalls * k.inTokens, monthOut = monthCalls * k.outTokens;
    const cached = Math.min(100, k.cachedPct) / 100;
    const costIn = monthIn * (1 - cached) * k.priceIn / 1e6 + monthIn * cached * k.priceCached / 1e6;
    const costOut = monthOut * k.priceOut / 1e6;
    const cost = costIn + costOut;
    const perCall = monthCalls ? cost / monthCalls : 0;

    return {
      inputs: k, dailyCalls, busyHourCalls, avgRpm, peakRpm, peakRps, tokensPerCallForLimit, peakTpm, peakOtpm,
      limits, binding, used, verdict, rejectedShare, maxDau, latency, concurrency, testRpm,
      monthCalls, monthIn, monthOut, costIn, costOut, cost,
      perUser: k.dau ? cost / k.dau : 0, per1000: perCall * 1000,
    };
  }

  const api = { calc, DEFAULTS, PRESETS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LlmCapacity = api;
})(typeof window !== 'undefined' ? window : this);
