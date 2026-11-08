/* Perf Studio: an AI-free performance engineering workspace. Pure functions, no DOM.
   Runs in the browser (window.PerfStudio) and in Node (module.exports), so it can be unit-tested.
   Nothing is sent anywhere: all parsing and maths happen on the visitor's machine.

   It reuses the other tools instead of copying them. In the browser, load these first:
     /tools/openapi-to-k6/convert.js   (window.OpenApiToK6)  OpenAPI parsing and the k6 script
     /tools/k6-results/explain.js      (window.K6Explain)    k6 summary parsing (text, --summary-export, handleSummary)
     /tools/jtl-analyser/jtl.js        (window.JTL)          JMeter JTL/CSV/XML parsing, exact percentiles, timeline
     /tools/workload-model/workload.js (window.Workload)     Little's Law

   Steps: estimate() → analyseText() / fromK6Model() / fromJtlResult() → evaluate() → recommend() → report().
   Every finding and recommendation quotes the measured number that triggered it. Rules of thumb used for sizing
   (load generator, effort) are listed in the estimate's `assumptions`, so nothing is presented as measured. */
(function (root) {
  'use strict';

  const node = typeof module !== 'undefined' && module.exports;
  const K = node ? require('../openapi-to-k6/convert.js') : root.OpenApiToK6;
  const E = node ? require('../k6-results/explain.js') : root.K6Explain;
  const J = node ? require('../jtl-analyser/jtl.js') : root.JTL;
  const W = node ? require('../workload-model/workload.js') : root.Workload;

  const WRITE = ['POST', 'PUT', 'PATCH', 'DELETE'];

  // ---------------------------------------------------------------- formatting

  function fmtMs(ms) {
    if (ms == null || !isFinite(ms)) return 'n/a';
    if (ms >= 60000) return (ms / 60000).toFixed(1) + ' min';
    if (ms >= 10000) return (ms / 1000).toFixed(1) + ' s';
    if (ms >= 1000) return (ms / 1000).toFixed(2) + ' s';
    if (ms >= 10) return Math.round(ms) + ' ms';
    return (Math.round(ms * 10) / 10) + ' ms';
  }
  function fmtNum(n, d) {
    if (n == null || !isFinite(n)) return 'n/a';
    if (d != null) return Number(n).toLocaleString('en-AU', { minimumFractionDigits: d, maximumFractionDigits: d });
    return Math.abs(n) >= 100 ? Math.round(n).toLocaleString('en-AU') : String(Math.round(n * 100) / 100);
  }
  function fmtPct(p) { // p is a percentage (0..100)
    if (p == null || !isFinite(p)) return 'n/a';
    if (p === 0) return '0%';
    if (p < 0.1) return p.toFixed(3) + '%';
    if (p < 10) return p.toFixed(2) + '%';
    return p.toFixed(1) + '%';
  }
  function fmtDur(min) {
    if (!isFinite(min)) return 'n/a';
    if (min < 60) return Math.round(min) + ' min';
    const h = Math.floor(min / 60), m = Math.round(min % 60);
    return h + ' h' + (m ? ' ' + m + ' min' : '');
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const num = (v, d) => { const n = +v; return v !== '' && v != null && isFinite(n) ? n : d; };
  const ceil = Math.ceil;
  const half = x => Math.ceil(x * 2) / 2;   // round up to half a day

  // ---------------------------------------------------------------- a) k6 script from OpenAPI

  /* Wraps the OpenAPI → k6 converter. When `estimate` is given, the script is sized from it (open model at the
     estimated rate) and gets per-endpoint thresholds plus p(99) in the summary, so step c) can judge each endpoint. */
  function k6Script(input, opts) {
    opts = opts || {};
    const est = opts.estimate || null;
    const c = { include: opts.include || null, yaml: opts.yaml || null, baseUrl: opts.baseUrl || '' };
    let iterRate = null;
    if (est) {
      const n = Math.max(1, (opts.include || []).length || est.endpoints.length);
      // Each iteration calls every selected endpoint once, so iterations/s = requests/s ÷ endpoints.
      iterRate = est.targetRps / n;
      const timeUnit = iterRate >= 1 ? '1s' : '1m';
      const rate = timeUnit === '1s' ? Math.max(1, Math.round(iterRate)) : Math.max(1, Math.round(iterRate * 60));
      Object.assign(c, { model: 'open', rate, timeUnit, duration: '30m', preAllocatedVUs: est.vus, maxVUs: est.maxVUs,
        thinkTime: est.input.thinkTimeS, p95: est.input.targetP95Ms, errorRate: est.input.errorPct });
    } else {
      Object.assign(c, opts.k6 || {});
    }
    const r = K.convert(input, c);
    if (r.error || !est) return Object.assign(r, { iterRate });
    const names = [...new Set((r.script.match(/tags: \{ name: '((?:[^'\\]|\\.)*)' \}/g) || []).map(t => t.slice(15, -3).replace(/\\(.)/g, '$1')))];
    r.script = addEndpointThresholds(r.script, names, est.input.targetP95Ms, est.input.errorPct);
    r.info.push(`Sized from the estimate: about ${fmtNum(est.targetRps, 1)} requests a second across ${names.length} endpoint tag${names.length === 1 ? '' : 's'}, ${est.vus} VUs pre-allocated, up to ${est.maxVUs}.`);
    r.info.push('Per-endpoint thresholds and p(99) were added, so the summary JSON shows each endpoint on its own. Export it with: k6 run --summary-export=summary.json script.js');
    return Object.assign(r, { iterRate, endpointTags: names });
  }

  // Adds summaryTrendStats with p(99), and a p95 + error-rate threshold per endpoint tag. Leaves the script alone
  // if the expected markers are missing (so it never produces a broken file).
  function addEndpointThresholds(script, names, p95, errorPct) {
    const lit = K.lit;
    if (!/export const options = \{\n/.test(script)) return script;
    let s = script.replace('export const options = {\n',
      "export const options = {\n  // p(99) in the end-of-test summary, so the tail is visible per endpoint.\n  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],\n");
    if (!names.length) return s;
    const lines = [];
    for (const n of names) {
      if (p95 > 0) lines.push(`    ${lit('http_req_duration{name:' + n + '}')}: ['p(95)<${p95}'],`);
      if (errorPct > 0) lines.push(`    ${lit('http_req_failed{name:' + n + '}')}: ['rate<${+(errorPct / 100).toFixed(4)}'],`);
    }
    if (!lines.length) return s;
    lines.unshift('    // One line per endpoint, so the summary reports each one (a threshold makes k6 keep that sub-metric).');
    if (/\n  thresholds: \{\n/.test(s)) return s.replace('\n  thresholds: {\n', '\n  thresholds: {\n' + lines.join('\n') + '\n');
    return s.replace(/\n};\n/, '\n  thresholds: {\n' + lines.join('\n') + '\n  },\n};\n');
  }

  // ---------------------------------------------------------------- b) estimate the test

  const EST_DEFAULTS = {
    basis: 'users',          // 'users' (peak concurrent users) or 'requests' (peak requests per hour)
    peakUsers: 500,
    peakPerHour: 0,
    thinkTimeS: 5,           // pause between a user's requests
    respTimeS: 0.5,          // expected average response time at peak
    targetP95Ms: 800,
    errorPct: 1,
    environment: 'prod',     // 'prod' (production-like), 'scaled' (smaller copy), 'shared' (shared test environment)
    envScalePct: 50,         // size of a scaled environment compared to production
    soakHours: 4,
    auth: true,              // the API needs a login or token
    endpoints: [],           // [{ id, method, path, share }]
  };

  // Load test profiles. Fractions are of the target load. Segments: [minutes, from, to].
  const PROFILES = {
    smoke: { purpose: 'Check the script, test data and environment work before any real load.', segs: null,
      pass: 'No errors; every check passes.' },
    load: { purpose: 'Expected peak: does it meet the targets at 100% load?', segs: [[10, 0, 1], [30, 1, 1], [2, 1, 0]],
      pass: 'p95 and error rate within targets for the whole steady part.' },
    stress: { purpose: 'Find the breaking point: step up until a target fails.', segs: [[2, 0, 1], [10, 1, 1], [2, 1, 1.5], [10, 1.5, 1.5], [2, 1.5, 2], [10, 2, 2], [2, 2, 3], [10, 3, 3], [2, 3, 0]],
      pass: 'Record the load where p95 or errors first break, and how the system fails (slow, errors, or crash).' },
    spike: { purpose: 'A sudden burst (sale, email, news): does it cope and recover?', segs: [[5, 0.5, 0.5], [1, 0.5, 2], [5, 2, 2], [1, 2, 0.5], [5, 0.5, 0.5]],
      pass: 'Errors stay low during the burst, and response times recover within a few minutes after it.' },
    soak: { purpose: 'Steady load for hours: memory leaks, connection leaks, slow drift.', segs: null,
      pass: 'p95, memory and connection counts flat from the first hour to the last.' },
  };

  function profileSegs(type, i, smokeFrac) {
    if (type === 'smoke') return [[2, smokeFrac, smokeFrac]];
    if (type === 'soak') return [[10, 0, 0.8], [i.soakHours * 60, 0.8, 0.8], [2, 0.8, 0]];
    return PROFILES[type].segs;
  }

  function estimate(inp) {
    const i = Object.assign({}, EST_DEFAULTS, inp || {});
    i.thinkTimeS = Math.max(0, num(i.thinkTimeS, EST_DEFAULTS.thinkTimeS));
    i.respTimeS = Math.max(0.001, num(i.respTimeS, EST_DEFAULTS.respTimeS));
    i.targetP95Ms = Math.max(0, num(i.targetP95Ms, EST_DEFAULTS.targetP95Ms));
    i.errorPct = Math.max(0, num(i.errorPct, EST_DEFAULTS.errorPct));
    i.envScalePct = Math.min(100, Math.max(1, num(i.envScalePct, EST_DEFAULTS.envScalePct)));
    i.soakHours = Math.min(72, Math.max(1, num(i.soakHours, EST_DEFAULTS.soakHours)));
    const warnings = [];
    const R = i.respTimeS, Z = i.thinkTimeS;

    // endpoints and their share of requests
    let eps = (Array.isArray(i.endpoints) ? i.endpoints : []).map(e => ({ id: e.id || ((e.method || 'GET') + ' ' + (e.path || '')), method: String(e.method || 'GET').toUpperCase(),
      path: e.path || '', share: Math.max(0, num(e.share, 1)) }));
    if (!eps.length) eps = [{ id: 'All requests', method: 'GET', path: '', share: 1 }];
    let shareSum = eps.reduce((a, e) => a + e.share, 0);
    if (!(shareSum > 0)) { eps.forEach(e => { e.share = 1; }); shareSum = eps.length; }

    // peak load (Little's Law: users = throughput × (response time + think time))
    let peakRps, peakUsers;
    if (i.basis === 'requests') {
      peakRps = Math.max(0, num(i.peakPerHour, 0)) / 3600;
      peakUsers = W.littlesLaw(peakRps, R, Z).users;
    } else {
      peakUsers = Math.max(0, num(i.peakUsers, 0));
      peakRps = peakUsers / (R + Z);
    }
    if (!(peakRps > 0)) return { error: i.basis === 'requests' ? 'Enter the peak requests per hour.' : 'Enter the peak number of users.' };
    const scale = i.environment === 'scaled' ? i.envScalePct / 100 : 1;
    if (i.environment === 'scaled') warnings.push(`The test environment is ${i.envScalePct}% of production, so the targets are scaled to ${i.envScalePct}%. Results only predict production if both scale the same way: check database size, caches and shared services too.`);
    if (i.environment === 'shared') warnings.push('A shared test environment means other teams\' work changes your results. Book a quiet window, tell the other teams, and repeat runs before trusting a number.');
    const targetRps = peakRps * scale;
    const vus = Math.max(1, ceil(targetRps * (R + Z)));
    const maxVUs = Math.max(vus + 1, ceil(vus * 2));   // room for response times to double before k6 runs out of VUs
    const inFlight = targetRps * R;

    const endpoints = eps.map(e => {
      const tps = targetRps * e.share / shareSum;
      return { id: e.id, method: e.method, path: e.path, sharePct: e.share / shareSum * 100, tps, perHour: tps * 3600, write: WRITE.includes(e.method),
        idParam: /\{[^}]+\}/.test(e.path), targetP95Ms: i.targetP95Ms };
    });

    // test types
    const smokeVus = Math.min(2, vus);
    const smokeFrac = smokeVus / vus;
    const tests = ['smoke', 'load', 'stress', 'spike', 'soak'].map(type => {
      const segs = profileSegs(type, i, smokeFrac);
      const durationMin = segs.reduce((a, s) => a + s[0], 0);
      const peakFrac = Math.max(...segs.map(s => Math.max(s[1], s[2])));
      const requests = segs.reduce((a, s) => a + targetRps * 60 * s[0] * (s[1] + s[2]) / 2, 0);
      const steady = segs.filter(s => s[1] === s[2] && s[1] > 0).map(s => s[1]);
      return { type, purpose: PROFILES[type].purpose, pass: PROFILES[type].pass, durationMin, peakPct: peakFrac * 100,
        peakVUs: type === 'smoke' ? smokeVus : ceil(vus * peakFrac), peakRps: targetRps * peakFrac, requests,
        profile: describeProfile(type, segs, steady) };
    });
    if (i.environment === 'shared') warnings.push(`A ${i.soakHours}-hour soak on a shared environment is hard to keep clean. Run it overnight or at a weekend.`);

    // test data
    const runRequests = tests.reduce((a, t) => a + t.requests, 0);
    const maxTestVUs = Math.max(...tests.map(t => t.peakVUs));
    const data = {
      requestsPerRound: runRequests,
      accounts: i.auth ? ceil(maxTestVUs * 1.1) : 0,
      writes: endpoints.filter(e => e.write).map(e => ({ id: e.id, records: ceil(runRequests * e.sharePct / 100) })),
      idPools: endpoints.filter(e => e.idParam && !e.write).map(e => ({ id: e.id, ids: Math.max(1000, ceil(vus * 10)) })),
    };
    data.writeRecords = data.writes.reduce((a, w) => a + w.records, 0);

    // load generator (rules of thumb, listed in assumptions)
    const maxRps = Math.max(...tests.map(t => t.peakRps));
    const cpuByRps = ceil(maxRps / 1000), cpuByVus = ceil(maxTestVUs / 1000);
    const vcpu = Math.max(2, cpuByRps, cpuByVus);
    const memGB = Math.max(2, ceil(maxTestVUs * 3 / 1024 + 1));
    const machines = ceil(vcpu / 16);
    const generator = { maxVUs: maxTestVUs, maxRps, vcpu, memGB, machines,
      text: machines > 1
        ? `${machines} load generators of about 16 vCPU and ${ceil(memGB / machines)} GB RAM each (k6 distributed, k6 Operator on Kubernetes, or Grafana Cloud k6).`
        : `One load generator with ${vcpu} vCPU and ${memGB} GB RAM, in the same region as the system under test.` };

    // effort (days)
    const reads = endpoints.filter(e => !e.write).length, writes = endpoints.filter(e => e.write).length;
    const exec = { smoke: 0.25, load: 0.5, stress: 0.5, spike: 0.25, soak: Math.max(0.5, i.soakHours / 8) };
    const effort = [
      { task: 'Plan, workload model and sign-off of targets', days: 0.5 },
      { task: `Scripts: ${reads} read and ${writes} write endpoint${reads + writes === 1 ? '' : 's'}${i.auth ? ', plus login/token handling' : ''}`, days: half(reads * 0.25 + writes * 0.5 + (i.auth ? 0.5 : 0)) },
      { task: 'Test data: accounts, ID lists, clean-up of created records', days: half(0.5 + (writes ? 0.5 : 0) + (data.accounts > 50 ? 0.5 : 0)) },
      { task: 'Environment check and monitoring (APM, logs, dashboards)', days: i.environment === 'shared' ? 1.5 : 1 },
      { task: 'Run the five tests twice (baseline, then retest after fixes)', days: half(2 * Object.values(exec).reduce((a, b) => a + b, 0)) },
      { task: 'Analysis, report and read-out', days: 1.5 },
    ];
    const subtotal = effort.reduce((a, e) => a + e.days, 0);
    effort.push({ task: 'Contingency (20%)', days: half(subtotal * 0.2) });
    const effortDays = effort.reduce((a, e) => a + e.days, 0);

    const assumptions = [
      `Little's Law: users = throughput × (response time + think time), with ${R} s response time and ${Z} s think time.`,
      'k6 iterations call each selected endpoint once. For an uneven mix, give each endpoint its own scenario at the rate in the table.',
      `maxVUs is twice the steady VUs, so k6 can keep the rate if response times double. More than that is itself a finding.`,
      'Load generator: about 1 vCPU per 1,000 requests a second or per 1,000 VUs, and about 3 MB of memory per VU (simple HTTP scripts). Watch the generator CPU: keep it under 80%.',
      'ID lists: at least 1,000 IDs, and 10 per VU, so caches see a realistic mix rather than the same few records.',
      'Effort: a quarter of a day per read endpoint and half a day per write endpoint, plus fixed time for planning, data, environment and reporting.',
    ];

    return { input: i, peakRps, peakUsers, scale, targetRps, vus, maxVUs, inFlight, endpoints, tests, data, generator, effort, effortDays, assumptions, warnings };
  }

  function describeProfile(type, segs, steady) {
    if (type === 'smoke') return 'A few VUs for 2 minutes.';
    if (type === 'load') return 'Ramp up over 10 minutes, hold 100% for 30 minutes, ramp down.';
    if (type === 'stress') return 'Steps of 10 minutes at 100%, 150%, 200% and 300%. Stop at the first step that breaks a target.';
    if (type === 'spike') return '5 minutes at 50%, jump to 200% in 1 minute, hold 5 minutes, drop back, watch 5 minutes of recovery.';
    return `Ramp to 80% and hold for ${fmtDur(segs[1][0])}.`;
  }

  // ---------------------------------------------------------------- c) results → one common shape

  /* Common shape: { source, format, durationS, total: Stats, endpoints: [Stats], timeline: [{t, tps, p95, threads, errors, count}] | null,
     errors: [{code, msg, count, endpoints}], vus: {max, allowed} | null, dropped, checksRate, warnings }
     Stats: { name, count, tps, errPct, avg, p50, p90, p95, p99, max, avgBytes } (times in ms, NaN when unknown). */

  function stats(o) {
    return Object.assign({ name: '', count: NaN, tps: NaN, errPct: NaN, avg: NaN, p50: NaN, p90: NaN, p95: NaN, p99: NaN, max: NaN, avgBytes: NaN }, o);
  }

  function fromK6Model(model) {
    const m = model.metrics;
    const val = (name, key) => (m[name] && m[name].values[key] != null && isFinite(m[name].values[key]) ? m[name].values[key] : NaN);
    const durS = model.meta && model.meta.durationMs ? model.meta.durationMs / 1000 : NaN;
    const total = trendStats('All requests', 'http_req_duration', '', val);
    if (!isFinite(total.p50) && !isFinite(total.p95) && !isFinite(total.avg)) throw new Error('This k6 output has no http_req_duration, so there are no response times to analyse.');
    // per endpoint: sub-metrics like http_req_duration{name:/books} (k6 keeps them when a threshold uses them)
    const endpoints = [];
    for (const name of Object.keys(m)) {
      const t = /^http_req_duration\{(.+)\}$/.exec(name);
      if (!t) continue;
      const tags = t[1].split(',').map(x => x.trim()).filter(x => x && !/^expected_response:/.test(x));
      if (!tags.length) continue;
      const label = tags.map(x => x.replace(/^(name|url|group|scenario):/, '').replace(/^::/, '')).join(' ');
      endpoints.push(trendStats(label, name, '{' + t[1] + '}', val));
    }
    const warnings = [];
    if (!endpoints.length) warnings.push('No per-endpoint numbers in this summary. k6 only reports an endpoint on its own when a threshold uses it, for example \'http_req_duration{name:/books}\': [\'p(95)<800\']. The k6 script from step 1 adds these for you.');
    if (!isFinite(total.p99)) warnings.push('No p(99) in this summary. Add summaryTrendStats with \'p(99)\' to the options (the script from step 1 does) to see the tail.');
    const vmax = val('vus', 'max'), vallowed = val('vus_max', 'max');
    if (!isFinite(durS) && isFinite(total.count) && total.tps > 0) total.durationS = total.count / total.tps;
    const cr = val('checks', 'rate');
    return { source: 'k6', format: model.format, durationS: isFinite(durS) ? durS : total.durationS || NaN, total, endpoints, timeline: null, errors: [],
      vus: isFinite(vmax) ? { max: vmax, allowed: isFinite(vallowed) ? vallowed : NaN } : null,
      dropped: val('dropped_iterations', 'count'), checksRate: isFinite(cr) ? cr * 100 : NaN, warnings };

    function trendStats(label, durName, sub, v) {
      const reqs = 'http_reqs' + sub, failed = 'http_req_failed' + sub;
      const fr = v(failed, 'rate');
      const recv = sub ? NaN : v('data_received', 'count');
      // k6 only keeps http_reqs{name:…} when a threshold uses it; http_req_failed{name:…} has passes + fails = requests.
      let count = v(reqs, 'count');
      if (!isFinite(count) && isFinite(v(failed, 'passes')) && isFinite(v(failed, 'fails'))) count = v(failed, 'passes') + v(failed, 'fails');
      let tps = v(reqs, 'rate');
      const runS = isFinite(durS) ? durS : v('http_reqs', 'count') / v('http_reqs', 'rate');
      if (!isFinite(tps) && isFinite(count) && runS > 0) tps = count / runS;
      return stats({ name: label, count, tps, errPct: isFinite(fr) ? fr * 100 : NaN,
        avg: v(durName, 'avg'), p50: v(durName, 'med'), p90: v(durName, 'p(90)'), p95: v(durName, 'p(95)'), p99: v(durName, 'p(99)'), max: v(durName, 'max'),
        avgBytes: isFinite(recv) && count > 0 ? recv / count : NaN });
    }
  }

  function fromJtlResult(r) {
    const conv = l => stats({ name: l.label === 'TOTAL' ? 'All requests' : l.label, count: l.count, tps: l.tput, errPct: l.errPct, avg: l.avg, p50: l.p50, p90: l.p90,
      p95: l.p95, p99: l.p99, max: l.max, avgBytes: isFinite(l.recvKBs) && l.tput > 0 ? l.recvKBs * 1024 / l.tput : NaN });
    const timeline = r.timeline ? r.timeline.points.filter(p => p.count > 0).map(p => ({ t: p.t, tps: p.tput, p95: p.p95, threads: p.threads, errors: p.errors, count: p.count })) : null;
    return { source: 'jmeter', format: r.format || 'JMeter', durationS: r.durationMs / 1000, total: conv(r.total), endpoints: r.labels.map(conv), timeline,
      errors: (r.errors || []).map(e => ({ code: String(e.rc || ''), msg: e.msg || '', count: e.count, endpoints: e.labels.map(x => x.label) })),
      vus: r.hasThreads && timeline ? { max: Math.max(...timeline.map(p => p.threads)), allowed: NaN } : null, dropped: NaN, checksRate: NaN,
      warnings: (r.warnings || []).slice() };
  }

  // Text → common shape. k6 JSON or text summary, or a JMeter JTL (CSV with a header, or XML).
  function analyseText(text) {
    const t = String(text || '').replace(/^﻿/, '').trim();
    if (!t) throw new Error('Paste or upload a k6 summary or a JMeter results file first.');
    if (t[0] === '{' || /http_req_duration|█ (THRESHOLDS|TOTAL RESULTS)/.test(t.slice(0, 20000))) return fromK6Model(E.parse(t));
    if (t[0] === '<' || /(^|[,;\t|])elapsed([,;\t|]|$)/m.test(t.split('\n', 1)[0]) || /^\d{10,13}[,;\t|]\d+[,;\t|]/.test(t)) return fromJtlResult(J.analyseText(t));
    throw new Error("This doesn't look like k6 or JMeter results. Paste k6's summary (text or JSON from --summary-export or handleSummary), or a JMeter .jtl/.csv with a header row.");
  }

  // ---------------------------------------------------------------- c) evaluate against the targets and look for bottlenecks

  function median(a) { const s = a.filter(isFinite).sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; }

  /* slo: { p95Ms, errorPct, targetRps, endpointTargets: { name: tps } }. Returns { rows, signals, verdict }.
     Each signal: { id, level: 'bad' | 'warn' | 'info', title, metric (the measured numbers), endpoint?, text }. */
  function evaluate(res, slo) {
    slo = Object.assign({ p95Ms: 800, errorPct: 1, targetRps: NaN, endpointTargets: {} }, slo || {});
    const signals = [];
    const sig = (id, level, title, metric, text, extra) => signals.push(Object.assign({ id, level, title, metric, text }, extra || {}));
    const T = res.total;
    const p95Of = s => (isFinite(s.p95) ? s.p95 : s.p90);

    // per-endpoint rows vs the targets
    const rows = res.endpoints.map(e => {
      const target = slo.endpointTargets[e.name];
      return Object.assign({}, e, {
        p95Ok: slo.p95Ms > 0 && isFinite(p95Of(e)) ? p95Of(e) <= slo.p95Ms : null,
        errOk: isFinite(e.errPct) ? e.errPct <= slo.errorPct : null,
        targetTps: isFinite(target) ? target : NaN,
        tpsPct: isFinite(target) && target > 0 && isFinite(e.tps) ? e.tps / target * 100 : NaN,
      });
    });

    // 1. overall targets
    if (slo.p95Ms > 0 && isFinite(p95Of(T)) && p95Of(T) > slo.p95Ms) {
      sig('p95-total', 'bad', 'Overall p95 is over the target', `p95 ${fmtMs(p95Of(T))} vs target ${fmtMs(slo.p95Ms)}`,
        `1 in 20 requests took longer than ${fmtMs(p95Of(T))}, above the ${fmtMs(slo.p95Ms)} target.`);
    }
    if (isFinite(T.errPct) && T.errPct > slo.errorPct) {
      sig('errors-total', 'bad', 'Error rate is over the target', `errors ${fmtPct(T.errPct)} vs target ${fmtPct(slo.errorPct)}`,
        `${fmtPct(T.errPct)} of requests failed${isFinite(T.count) ? ' (about ' + fmtNum(T.count * T.errPct / 100) + ' of ' + fmtNum(T.count) + ')' : ''}.`);
    }
    if (isFinite(slo.targetRps) && slo.targetRps > 0 && isFinite(T.tps) && T.tps < slo.targetRps * 0.9) {
      sig('tps-target', 'warn', 'Throughput fell short of the target', `${fmtNum(T.tps, 1)} req/s achieved vs ${fmtNum(slo.targetRps, 1)} req/s target (${Math.round(T.tps / slo.targetRps * 100)}%)`,
        'The test averaged under 90% of the target rate. Either the test ran below target for part of the time (ramp-up counts), or the system could not keep up. Check the steady part of the run.');
    }

    // 2. endpoints over the target
    const slow = rows.filter(r => r.p95Ok === false).sort((a, b) => p95Of(b) - p95Of(a));
    if (slow.length) {
      sig('p95-endpoints', slow.length === rows.length ? 'bad' : 'warn', `${slow.length} endpoint${slow.length === 1 ? ' is' : 's are'} over the p95 target`,
        slow.slice(0, 4).map(r => `${r.name} p95 ${fmtMs(p95Of(r))}`).join('; ') + ` (target ${fmtMs(slo.p95Ms)})`,
        'These endpoints are where to look first.', { endpoints: slow.map(r => r.name) });
    }
    const errEps = rows.filter(r => r.errOk === false).sort((a, b) => b.errPct - a.errPct);
    if (errEps.length) {
      sig('errors-endpoints', 'warn', `${errEps.length} endpoint${errEps.length === 1 ? ' has' : 's have'} errors over the target`,
        errEps.slice(0, 4).map(r => `${r.name} ${fmtPct(r.errPct)}`).join('; ') + ` (target ${fmtPct(slo.errorPct)})`, '', { endpoints: errEps.map(r => r.name) });
    }

    // 3. long tail: p99 (or p95) far above the median
    const tails = rows.concat([T]).map(r => {
      const hi = isFinite(r.p99) ? ['p99', r.p99, 5] : (isFinite(r.p95) ? ['p95', r.p95, 4] : null);
      return hi && r.p50 > 0 && r.count >= 100 ? { r, stat: hi[0], ratio: hi[1] / r.p50, limit: hi[2] } : null;
    }).filter(x => x && x.ratio >= x.limit).sort((a, b) => b.ratio - a.ratio);
    if (tails.length) {
      const top = tails.slice(0, 3);
      sig('tail', 'warn', 'Long latency tail', top.map(x => `${x.r.name}: ${x.stat} ${fmtMs(x.stat === 'p99' ? x.r.p99 : x.r.p95)} is ${fmtNum(x.ratio, 1)}× the median ${fmtMs(x.r.p50)}`).join('; '),
        'Most requests are quick but a minority wait far longer. That pattern points at queueing (pools), pauses (GC), locks or one slow dependency, not at plain CPU shortage.',
        { endpoints: top.map(x => x.r.name).filter(n => n !== T.name) });
    }

    // 4. errors clustered on one endpoint
    if (rows.length >= 2) {
      const withErr = rows.map(r => ({ r, n: isFinite(r.count) && isFinite(r.errPct) ? r.count * r.errPct / 100 : 0 }));
      const allErr = withErr.reduce((a, x) => a + x.n, 0);
      const top = withErr.sort((a, b) => b.n - a.n)[0];
      if (allErr >= 10 && top.n / allErr >= 0.6) {
        sig('error-cluster', top.r.errPct > slo.errorPct ? 'bad' : 'warn', `Errors cluster on ${top.r.name}`,
          `${Math.round(top.n / allErr * 100)}% of all errors (${fmtNum(top.n)} of ${fmtNum(allErr)}) are on ${top.r.name}, which fails ${fmtPct(top.r.errPct)} of its requests`,
          'One endpoint failing while the rest are fine means a problem specific to it: its database query, a downstream service it calls, a lock, or a pool it uses alone.', { endpoints: [top.r.name] });
      }
    }

    // 5. the time series: latency, errors and throughput against load (JMeter results with thread counts)
    const tl = res.timeline;
    if (tl && tl.length >= 8) {
      const withThreads = tl.filter(p => p.threads > 0);
      const maxThr = withThreads.length ? Math.max(...withThreads.map(p => p.threads)) : 0;
      if (maxThr >= 4) {
        const low = withThreads.filter(p => p.threads <= maxThr * 0.35);
        const mid = withThreads.filter(p => p.threads >= maxThr * 0.4 && p.threads <= maxThr * 0.6);
        const high = withThreads.filter(p => p.threads >= maxThr * 0.9);
        if (low.length >= 2 && high.length >= 2) {
          const lp = median(low.map(p => p.p95)), hp = median(high.map(p => p.p95));
          if (lp > 0 && hp / lp >= 1.5) {
            sig('latency-load', hp / lp >= 3 ? 'bad' : 'warn', 'Latency rises with load',
              `median p95 ${fmtMs(lp)} at up to ${Math.round(maxThr * 0.35)} threads vs ${fmtMs(hp)} at ${Math.round(maxThr * 0.9)}+ threads (${fmtNum(hp / lp, 1)}×)`,
              'Response times grow as users are added, so requests are waiting for something: a thread or connection pool, CPU, a database lock or a downstream service.');
          }
          const le = low.reduce((a, p) => a + p.errors, 0) / Math.max(1, low.reduce((a, p) => a + p.count, 0)) * 100;
          const he = high.reduce((a, p) => a + p.errors, 0) / Math.max(1, high.reduce((a, p) => a + p.count, 0)) * 100;
          if (he >= 1 && he >= le * 2) {
            sig('errors-load', 'bad', 'Errors rise with load', `error rate ${fmtPct(le)} at low load vs ${fmtPct(he)} at peak threads`,
              'Errors that appear only under load are a capacity limit, not a functional bug: a pool, a queue, a rate limit or an instance running out.');
          }
        }
        if (mid.length >= 2 && high.length >= 2) {
          const mt = median(mid.map(p => p.threads)), ht = median(high.map(p => p.threads));
          const mtps = median(mid.map(p => p.tps)), htps = median(high.map(p => p.tps));
          if (ht / mt >= 1.4 && mtps > 0 && htps / mtps < 1.1) {
            sig('plateau', 'bad', 'Throughput plateau',
              `threads rose from about ${Math.round(mt)} to ${Math.round(ht)} (${fmtNum(ht / mt, 1)}×) but throughput only went from ${fmtNum(mtps, 1)} to ${fmtNum(htps, 1)} req/s`,
              'Adding users stopped adding throughput, so something is saturated. (If the test used a fixed-rate throughput timer, throughput is capped by design and the extra threads mean responses slowed: still worth finding why.)');
          }
        }
      }
    }

    // 6. k6: the generator ran out of VUs, or dropped iterations
    if (res.vus && isFinite(res.vus.allowed) && res.vus.max >= res.vus.allowed && res.dropped > 0) {
      sig('vus-maxed', 'bad', 'k6 ran out of VUs and dropped iterations', `${fmtNum(res.vus.max)} of ${fmtNum(res.vus.allowed)} VUs in use; ${fmtNum(res.dropped)} iterations dropped`,
        'In an arrival-rate test, k6 needs more VUs when responses slow down. Using every VU and dropping iterations means response times grew under load (or maxVUs is too low). The system did not get the full target load.');
    } else if (res.dropped > 0) {
      sig('dropped', 'warn', 'k6 dropped iterations', `${fmtNum(res.dropped)} iterations dropped`,
        'k6 could not start every iteration on time, so the system got less load than planned. Raise maxVUs, or check the load generator\'s CPU.');
    }

    // 7. error types (JMeter keeps response codes and messages)
    const codeCount = re => res.errors.filter(e => re.test(e.code) || re.test(e.msg)).reduce((a, e) => a + e.count, 0);
    const totalErr = res.errors.reduce((a, e) => a + e.count, 0);
    const eps = re => [...new Set(res.errors.filter(e => re.test(e.code) || re.test(e.msg)).flatMap(e => e.endpoints))].slice(0, 3);
    const c5 = codeCount(/^5\d\d$/), c429 = codeCount(/^429$/), cAuth = codeCount(/^40[13]$/), cTo = codeCount(/time(d)? ?out|SocketTimeout|^504$/i);
    if (c5) sig('http-5xx', 'bad', 'Server errors (5xx)', `${fmtNum(c5)} responses with a 5xx code${totalErr ? ' (' + Math.round(c5 / totalErr * 100) + '% of errors)' : ''}, mostly on ${eps(/^5\d\d$/).join(', ')}`,
      '5xx under load usually means a pool or queue is full, an instance is overloaded or restarting, or a gateway timed out waiting.', { endpoints: eps(/^5\d\d$/) });
    if (cTo) sig('timeouts', 'bad', 'Timeouts', `${fmtNum(cTo)} requests timed out${eps(/time(d)? ?out|SocketTimeout|^504$/i).length ? ' on ' + eps(/time(d)? ?out|SocketTimeout|^504$/i).join(', ') : ''}`,
      'Timeouts hold a connection and a thread for the full timeout, which makes queueing worse for everyone else.');
    if (c429) sig('rate-limit', 'warn', 'Rate limited (429)', `${fmtNum(c429)} responses were 429 Too Many Requests`,
      'A rate limiter or WAF refused part of the load. Decide whether that limit is part of the test, or ask for the load generators to be allowed.');
    if (cAuth) sig('auth-errors', 'warn', 'Auth errors (401/403)', `${fmtNum(cAuth)} responses were 401 or 403`,
      'Usually the test, not the system: expired tokens, too few test accounts, or one account used by many VUs at once.');

    // 8. big responses
    const big = rows.filter(r => r.avgBytes >= 512 * 1024).sort((a, b) => b.avgBytes - a.avgBytes);
    if (big.length) sig('payload', 'warn', 'Large responses', big.slice(0, 3).map(r => `${r.name} averages ${fmtNum(r.avgBytes / 1024 / 1024, 2)} MB`).join('; '),
      'Big responses cost serialisation time, memory and bandwidth on every call.', { endpoints: big.map(r => r.name) });

    // 9. k6 checks
    if (isFinite(res.checksRate) && res.checksRate < 99) sig('checks', 'warn', 'Checks failed', `${fmtPct(100 - res.checksRate)} of checks failed`,
      'Failed checks mean wrong responses, even when the status code looks fine. Find which check fails before trusting the timings.');

    // 10. reliability of the numbers
    const thin = rows.filter(r => isFinite(r.count) && r.count < 100);
    if (thin.length) sig('few-samples', 'info', 'Few samples on some endpoints', thin.slice(0, 4).map(r => `${r.name}: ${fmtNum(r.count)} requests`).join('; '),
      'With under 100 requests, a p95 or p99 rests on a handful of values. Run longer before deciding on these endpoints.');
    if (isFinite(res.durationS) && res.durationS < 300) sig('short', 'info', 'Short test', `the test ran ${fmtNum(res.durationS / 60, 1)} minutes`,
      'Under 5 minutes is too short to see pools filling, caches warming or memory growing. Hold the steady load for at least 30 minutes for a load test.');

    const rank = { bad: 0, warn: 1, info: 2 };
    signals.sort((a, b) => rank[a.level] - rank[b.level]);
    return { rows, signals, slo, verdict: verdictOf(signals) };
  }

  function verdictOf(signals) {
    const bad = signals.filter(s => s.level === 'bad'), warn = signals.filter(s => s.level === 'warn');
    const lc = t => t[0].toLowerCase() + t.slice(1);
    if (bad.length) return { code: 'no-go', label: 'No-go', text: `${bad.length} blocking finding${bad.length === 1 ? '' : 's'}: ${bad.slice(0, 3).map(s => lc(s.title)).join('; ')}${bad.length > 3 ? '; and more' : ''}.` };
    if (warn.length) return { code: 'risk', label: 'Go with risks', text: `Targets met overall, with ${warn.length} risk${warn.length === 1 ? '' : 's'} to accept or fix: ${warn.slice(0, 3).map(s => lc(s.title)).join('; ')}${warn.length > 3 ? '; and more' : ''}.` };
    return { code: 'go', label: 'Go', text: 'All targets met and no bottleneck signals in these results.' };
  }

  // ---------------------------------------------------------------- d) recommendations

  // Each rule: the signal ids that trigger it, and what to do. The "because" line is always the signal's measured numbers.
  const RULES = [
    { on: ['plateau', 'latency-load', 'vus-maxed'], area: 'Application', title: 'Check thread and connection pool sizes',
      actions: ['Graph pool usage (active vs max) for the app server threads, the database connection pool and HTTP client pools during the run.',
        'A pool at its maximum while CPU is low is the bottleneck: raise it in steps, and check the database can take the extra connections.',
        'Make sure connections are returned promptly: no long transactions or slow calls made while holding a connection.'] },
    { on: ['plateau', 'latency-load', 'errors-load', 'http-5xx'], area: 'Infrastructure', title: 'Review autoscaling triggers and limits',
      actions: ['Compare when scaling started with when latency rose: scaling on CPU often reacts too late for I/O-bound services.',
        'Scale earlier (a lower CPU target, or on request rate or queue depth), keep warm minimum instances for known peaks, and check the maximum instance count is above what the stress test needed.'] },
    { on: ['p95-endpoints', 'error-cluster', 'tail'], area: 'Database', title: 'Look at the slowest endpoints\' database queries',
      actions: ['Capture the queries behind the endpoints named above (APM traces or the database\'s slow query log) during a run.',
        'Check the query plans for full table scans and add or fix indexes on the filter and join columns.',
        'Look for N+1 patterns (one query per item in a list) and batch them.'] },
    { on: ['p95-endpoints', 'latency-load', 'payload'], area: 'Application', title: 'Cache what is read often and changes rarely',
      actions: ['For read endpoints that are slow, check whether the same data is fetched again and again: cache it (in memory, Redis or the CDN) with a sensible expiry.',
        'Add Cache-Control headers to responses that browsers or the CDN can keep.'] },
    { on: ['timeouts', 'http-5xx', 'tail'], area: 'Application', title: 'Set timeouts, retries and circuit breakers deliberately',
      actions: ['Give every outbound call (database, HTTP, queue) a timeout shorter than the caller\'s, so one slow dependency cannot hold every thread.',
        'Retry only idempotent calls, with exponential backoff and jitter, and a cap on total retries.',
        'Add a circuit breaker around a dependency that keeps failing, so requests fail fast instead of piling up.'] },
    { on: ['tail'], area: 'Application', title: 'Check for pauses: garbage collection and locks',
      actions: ['Turn on GC logs for the run and look for long or frequent pauses that line up with the slow requests.',
        'Take thread dumps during the slow period to spot lock contention (many threads BLOCKED on the same lock).'] },
    { on: ['payload'], area: 'Application', title: 'Make the large responses smaller',
      actions: ['Paginate lists, return only the fields the client uses, and turn on gzip or brotli compression.'] },
    { on: ['rate-limit'], area: 'Test setup', title: 'Agree how to handle the rate limiter',
      actions: ['Either allow the load generators\' IP addresses for the test, or keep the limit and treat 429 as expected above that rate.'] },
    { on: ['auth-errors', 'checks'], area: 'Test setup', title: 'Fix the test before trusting the numbers',
      actions: ['Use one test account per VU, refresh tokens before they expire, and log the first failing response to see what the check got.'] },
    { on: ['dropped', 'vus-maxed'], area: 'Test setup', title: 'Give k6 room to hold the rate',
      actions: ['Raise maxVUs (about rate × the slowest iteration time), and check the load generator\'s CPU stayed under 80%.'] },
    { on: ['few-samples', 'short'], area: 'Test setup', title: 'Run longer before deciding',
      actions: ['Hold the steady load for at least 30 minutes and make sure every endpoint gets a few hundred requests.'] },
    { on: ['tps-target'], area: 'Test setup', title: 'Confirm the test reached the target load',
      actions: ['Check the steady part of the run reached the target rate; if not, find whether the generator or the system held it back.'] },
  ];

  function recommend(ev) {
    const out = [];
    for (const rule of RULES) {
      const hits = ev.signals.filter(s => rule.on.includes(s.id));
      if (!hits.length) continue;
      const level = hits.some(h => h.level === 'bad') ? 'bad' : hits.some(h => h.level === 'warn') ? 'warn' : 'info';
      const endpoints = [...new Set(hits.flatMap(h => h.endpoints || []))].slice(0, 4);
      out.push({ title: rule.title, area: rule.area, level, because: hits.map(h => h.title + ': ' + h.metric), endpoints, actions: rule.actions });
    }
    const rank = { bad: 0, warn: 1, info: 2 };
    out.sort((a, b) => rank[a.level] - rank[b.level]);
    if (!out.length) {
      out.push({ title: 'Keep the margin and keep testing', area: 'Next steps', level: 'info',
        because: ['No bottleneck signals: ' + (ev.verdict ? ev.verdict.text : '')],
        endpoints: [], actions: ['Run the stress test to learn how much headroom there is above the peak.', 'Run a soak test to rule out slow leaks.', 'Add the load test to CI with the same thresholds, so a slower build fails before it ships.'] });
    }
    return out;
  }

  // ---------------------------------------------------------------- e) executive report

  function nextSteps(ev, est) {
    const v = ev.verdict.code;
    const steps = [];
    if (v === 'no-go') steps.push('Fix the blocking findings (the first recommendations), then rerun the same load test to confirm.');
    if (v === 'risk') steps.push('Decide with the product owner which risks to accept for go-live, and fix the rest.');
    steps.push(v === 'go' ? 'Run the stress test to measure headroom above the peak.' : 'After the fixes, run the stress test to find the new breaking point.');
    steps.push('Run a soak test' + (est ? ` (${est.input.soakHours} hours at 80% of peak)` : '') + ' to rule out memory and connection leaks.');
    steps.push('Keep the k6 script in the repository and run a short version in CI with the same thresholds.');
    return steps;
  }

  function reportData(o) {
    const res = o.results, ev = o.evaluation, est = o.estimate || null;
    const T = res.total;
    const p95 = isFinite(T.p95) ? T.p95 : T.p90;
    const key = [
      ['Throughput', isFinite(T.tps) ? fmtNum(T.tps, 1) + ' req/s' : 'n/a', est ? 'target ' + fmtNum(est.targetRps, 1) + ' req/s' : ''],
      ['p95 response time', fmtMs(p95), ev.slo.p95Ms > 0 ? 'target ' + fmtMs(ev.slo.p95Ms) : ''],
      ['p99 response time', fmtMs(T.p99), isFinite(T.p50) && isFinite(T.p99) && T.p50 > 0 ? fmtNum(T.p99 / T.p50, 1) + '× the median' : ''],
      ['Error rate', fmtPct(T.errPct), 'target ' + fmtPct(ev.slo.errorPct)],
      ['Requests', fmtNum(T.count), isFinite(res.durationS) ? 'over ' + fmtDur(res.durationS / 60) : ''],
      ['Peak ' + (res.source === 'k6' ? 'VUs' : 'threads'), res.vus ? fmtNum(res.vus.max) : 'n/a', est ? 'estimate ' + est.vus + ' VUs' : ''],
    ];
    const risks = ev.signals.filter(s => s.level !== 'info').slice(0, 5);
    const recs = o.recommendations.slice(0, 5);
    const worst = ev.rows.slice().sort((a, b) => (isFinite(b.p95) ? b.p95 : -1) - (isFinite(a.p95) ? a.p95 : -1)).slice(0, 8);
    return { title: o.meta.project ? o.meta.project : 'Load test', meta: o.meta, verdict: ev.verdict, key, risks, recs, worst, next: nextSteps(ev, est), source: res.format };
  }

  function reportMarkdown(o) {
    const d = reportData(o);
    const md = s => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
    const out = [`# ${md(d.title)}: performance test report`, ''];
    const metaLine = [d.meta.release && 'Release: ' + d.meta.release, d.meta.environment && 'Environment: ' + d.meta.environment, d.meta.date && 'Date: ' + d.meta.date, 'Results: ' + d.source].filter(Boolean);
    out.push(metaLine.map(md).join(' · '), '');
    out.push(`## Verdict: ${d.verdict.label.toUpperCase()}`, '', md(d.verdict.text), '');
    out.push('## Key numbers', '', '| Measure | Result | Compared with |', '|---|---:|---|');
    d.key.forEach(k => out.push(`| ${md(k[0])} | ${md(k[1])} | ${md(k[2])} |`));
    if (d.worst.length) {
      out.push('', '## Endpoints (slowest first)', '', '| Endpoint | Req/s | p95 | p99 | Errors | Target |', '|---|---:|---:|---:|---:|---|');
      d.worst.forEach(r => out.push(`| ${md(r.name)} | ${fmtNum(r.tps, 1)} | ${fmtMs(isFinite(r.p95) ? r.p95 : r.p90)} | ${fmtMs(r.p99)} | ${fmtPct(r.errPct)} | ${r.p95Ok === false || r.errOk === false ? 'missed' : r.p95Ok === null ? 'n/a' : 'met'} |`));
    }
    out.push('', '## Top risks', '');
    if (d.risks.length) d.risks.forEach(s => out.push(`- **${md(s.title)}** (${s.level === 'bad' ? 'blocking' : 'risk'}): ${md(s.metric)}.`));
    else out.push('- None found in these results.');
    out.push('', '## Recommendations', '');
    d.recs.forEach((r, i) => {
      out.push(`${i + 1}. **${md(r.title)}** (${md(r.area)}). Because: ${md(r.because.join('; '))}.`);
      r.actions.forEach(a => out.push(`   - ${md(a)}`));
    });
    out.push('', '## Next steps', '');
    d.next.forEach(s => out.push('- ' + md(s)));
    out.push('', '_Prepared with Perf Studio (pawansinha.com.au/tools/perf-studio/). Rule-based: every finding quotes the measured number behind it._', '');
    return out.join('\n');
  }

  // A self-contained, printable one-page HTML report (light theme, A4-friendly).
  function reportHtml(o) {
    const d = reportData(o);
    const cls = { go: 'go', risk: 'risk', 'no-go': 'nogo' }[d.verdict.code];
    const metaLine = [d.meta.release && 'Release: ' + d.meta.release, d.meta.environment && 'Environment: ' + d.meta.environment, d.meta.date && 'Date: ' + d.meta.date, 'Results: ' + d.source].filter(Boolean);
    const rows = d.worst.map(r => `<tr><td>${esc(r.name)}</td><td>${fmtNum(r.tps, 1)}</td><td>${fmtMs(isFinite(r.p95) ? r.p95 : r.p90)}</td><td>${fmtMs(r.p99)}</td><td>${fmtPct(r.errPct)}</td><td class="${r.p95Ok === false || r.errOk === false ? 'miss' : ''}">${r.p95Ok === false || r.errOk === false ? 'missed' : r.p95Ok === null ? 'n/a' : 'met'}</td></tr>`).join('');
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(d.title)}: performance test report</title>
<style>
  @page { size: A4; margin: 14mm; }
  body { font: 12.5px/1.45 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #1a1f2b; background: #fff; margin: 0 auto; max-width: 780px; padding: 20px; }
  h1 { font-size: 21px; margin: 0 0 2px; } h2 { font-size: 14px; margin: 16px 0 6px; text-transform: uppercase; letter-spacing: .04em; color: #44506a; }
  .meta { color: #5a6273; margin: 0 0 12px; }
  .verdict { border-radius: 10px; padding: 10px 14px; border: 1px solid; }
  .verdict b { font-size: 18px; display: block; } .go { background: #e3f6ec; border-color: #9fd9bb; color: #0d5c39; }
  .risk { background: #fdf1d8; border-color: #ecd09a; color: #6b4600; } .nogo { background: #fbe9e5; border-color: #ecb3a7; color: #8f2513; }
  table { width: 100%; border-collapse: collapse; } th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #e3e6ec; vertical-align: top; }
  th { color: #5a6273; font-weight: 600; } td.miss { color: #8f2513; font-weight: 700; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 0 20px; } ul, ol { margin: 0; padding-left: 18px; } li { margin: 0 0 4px; }
  .because { color: #5a6273; } .foot { margin-top: 14px; color: #8a92a3; font-size: 11px; }
  @media (max-width: 600px) { .cols { grid-template-columns: 1fr; } body { padding: 12px; } }
</style></head><body>
<h1>${esc(d.title)}: performance test report</h1>
<p class="meta">${metaLine.map(esc).join(' · ')}</p>
<div class="verdict ${cls}"><b>${esc(d.verdict.label.toUpperCase())}</b>${esc(d.verdict.text)}</div>
<h2>Key numbers</h2>
<table><tr><th>Measure</th><th>Result</th><th>Compared with</th></tr>${d.key.map(k => `<tr><td>${esc(k[0])}</td><td><b>${esc(k[1])}</b></td><td>${esc(k[2])}</td></tr>`).join('')}</table>
${rows ? `<h2>Endpoints (slowest first)</h2><table><tr><th>Endpoint</th><th>Req/s</th><th>p95</th><th>p99</th><th>Errors</th><th>Target</th></tr>${rows}</table>` : ''}
<div class="cols"><div><h2>Top risks</h2><ul>${d.risks.length ? d.risks.map(s => `<li><b>${esc(s.title)}</b> <span class="because">${esc(s.metric)}</span></li>`).join('') : '<li>None found in these results.</li>'}</ul></div>
<div><h2>Next steps</h2><ul>${d.next.map(s => `<li>${esc(s)}</li>`).join('')}</ul></div></div>
<h2>Recommendations</h2>
<ol>${d.recs.map(r => `<li><b>${esc(r.title)}</b> (${esc(r.area)}). <span class="because">Because: ${esc(r.because.join('; '))}.</span> ${esc(r.actions[0])}</li>`).join('')}</ol>
<p class="foot">Prepared with Perf Studio (pawansinha.com.au/tools/perf-studio/). Rule-based: every finding quotes the measured number behind it.</p>
</body></html>
`;
  }

  // ---------------------------------------------------------------- samples

  // A k6 handleSummary JSON for the bookshop example, from the script step 1 writes (per-endpoint thresholds, p(99)).
  // Story: the cart endpoint saturates. k6 uses every VU, drops iterations, and /cart/items throws errors with a long tail.
  function sampleK6() {
    const ep = (name, n, failRate, t) => {
      const m = {};
      m['http_req_duration{name:' + name + '}'] = { type: 'trend', contains: 'time', values: t, thresholds: { 'p(95)<800': { ok: t['p(95)'] < 800 } } };
      m['http_req_failed{name:' + name + '}'] = { type: 'rate', contains: 'default', values: { rate: failRate, passes: Math.round(n * failRate), fails: n - Math.round(n * failRate) },
        thresholds: { 'rate<0.01': { ok: failRate < 0.01 } } };
      return m;   // like real k6: no http_reqs{name:…} unless a threshold uses it, so the count comes from passes + fails
    };
    const tr = (avg, min, med, max, p90, p95, p99) => ({ avg, min, med, max, 'p(90)': p90, 'p(95)': p95, 'p(99)': p99 });
    const metrics = Object.assign({
      http_reqs: { type: 'counter', contains: 'default', values: { count: 151200, rate: 84.0 } },
      http_req_failed: { type: 'rate', contains: 'default', values: { rate: 0.0201, passes: 3039, fails: 148161 }, thresholds: { 'rate<0.01': { ok: false } } },
      http_req_duration: { type: 'trend', contains: 'time', values: tr(412.6, 18.2, 196.4, 30002.1, 902.5, 1388.7, 4120.3), thresholds: { 'p(95)<800': { ok: false } } },
      'http_req_duration{expected_response:true}': { type: 'trend', contains: 'time', values: tr(338.1, 18.2, 188.9, 9120.4, 811.2, 1102.6, 2604.8) },
      iterations: { type: 'counter', contains: 'default', values: { count: 30240, rate: 16.8 } },
      dropped_iterations: { type: 'counter', contains: 'default', values: { count: 1260, rate: 0.7 } },
      checks: { type: 'rate', contains: 'default', values: { rate: 0.9799, passes: 148161, fails: 3039 }, thresholds: { 'rate>0.99': { ok: false } } },
      data_received: { type: 'counter', contains: 'data', values: { count: 1386000000, rate: 770000 } },
      vus: { type: 'gauge', contains: 'default', values: { value: 12, min: 12, max: 240 } },
      vus_max: { type: 'gauge', contains: 'default', values: { value: 240, min: 120, max: 240 } },
    },
    ep('/books', 60480, 0.0011, tr(204.3, 31.0, 162.4, 2210.4, 351.2, 448.9, 802.3)),
    ep('/books/{bookId}', 30240, 0.0007, tr(98.2, 18.2, 81.5, 1302.1, 160.4, 212.6, 391.0)),
    ep('/cart', 30240, 0.0042, tr(301.8, 40.2, 214.7, 6200.4, 655.9, 782.1, 1840.2)),
    ep('/cart/items', 15120, 0.1874, tr(1890.4, 52.1, 640.2, 30002.1, 4210.8, 6120.3, 14380.6)),
    ep('/health', 15120, 0, tr(12.1, 3.2, 9.8, 140.2, 19.4, 24.1, 61.0)));
    return JSON.stringify({ state: { testRunDurationMs: 1800000 }, options: { summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'] },
      root_group: { name: '', path: '', groups: [], checks: [] }, metrics }, null, 2);
  }

  // Target req/s per result name. k6 scripts from step 1 tag requests by path, so GET and POST /books share '/books'.
  function endpointTargets(est) {
    const t = {};
    for (const e of est.endpoints) {
      t[e.id] = (t[e.id] || 0) + e.tps;
      if (e.path && e.path !== e.id) t[e.path] = (t[e.path] || 0) + e.tps;
    }
    return t;
  }

  const api = {
    k6Script, addEndpointThresholds, estimate, EST_DEFAULTS, PROFILES, endpointTargets,
    analyseText, fromK6Model, fromJtlResult, evaluate, recommend, verdictOf, RULES,
    reportData, reportMarkdown, reportHtml, nextSteps,
    sampleK6, sampleJtl: o => J.generateSample(Object.assign({ rows: 20000 }, o || {})),
    fmtMs, fmtNum, fmtPct, fmtDur, esc,
  };
  if (node) module.exports = api;
  else root.PerfStudio = api;
})(typeof self !== 'undefined' ? self : this);
