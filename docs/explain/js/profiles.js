/* Load test profiles for /explain/load-profiles/: preset shapes, and the k6 options / script that run them.
   Browser (window.ExplainProfiles) and Node (module.exports); explain/test-explain.js runs the output through `k6 inspect`.
   A profile is { mode: 'vus' | 'rate', points: [{ t: seconds, v: VUs or requests per second }] } with points[0].t = 0. */
(function (root) {
  'use strict';

  const PRESETS = {
    load: {
      name: 'Load test', mode: 'vus', unit: 'VUs',
      points: [{ t: 0, v: 0 }, { t: 120, v: 50 }, { t: 720, v: 50 }, { t: 780, v: 0 }],
      finds: 'Does the system meet its targets at the traffic you expect on a normal busy day?',
      watch: 'p95 and error rate stay flat through the steady part. If they drift up, something is filling up.',
      when: 'Before every release, against an agreed peak-hour number.'
    },
    stress: {
      name: 'Stress test', mode: 'vus', unit: 'VUs',
      points: [{ t: 0, v: 0 }, { t: 120, v: 50 }, { t: 300, v: 50 }, { t: 420, v: 100 }, { t: 600, v: 100 }, { t: 720, v: 150 }, { t: 900, v: 150 }, { t: 960, v: 0 }],
      finds: 'How it behaves beyond expected traffic: which part fails first, and does it fail gracefully?',
      watch: 'The step where p95 bends upward. That is your real headroom, and the component that saturates is your bottleneck.',
      when: 'Before a launch or a sale, and after big architecture changes.'
    },
    spike: {
      name: 'Spike test', mode: 'rate', unit: 'req/s',
      points: [{ t: 0, v: 20 }, { t: 120, v: 20 }, { t: 130, v: 300 }, { t: 310, v: 300 }, { t: 320, v: 20 }, { t: 600, v: 20 }],
      finds: 'What happens when traffic jumps in seconds: an email blast, a TV ad, a flash sale opening.',
      watch: 'Errors in the first minute (autoscaling is too slow), and whether it recovers after the spike ends.',
      when: 'Before marketing events, ticket releases and sale launches.'
    },
    soak: {
      name: 'Soak test', mode: 'vus', unit: 'VUs',
      points: [{ t: 0, v: 0 }, { t: 300, v: 40 }, { t: 14700, v: 40 }, { t: 15000, v: 0 }],
      finds: 'Problems that only appear with time: memory leaks, connection leaks, full disks, log rotation, token expiry.',
      watch: 'Memory and response time slowly creeping up at a constant load. Flat lines are what you want.',
      when: 'Before a long event (Black Friday to Cyber Monday) and for services that never restart.'
    },
    breakpoint: {
      name: 'Breakpoint test', mode: 'rate', unit: 'req/s',
      points: [{ t: 0, v: 10 }, { t: 1200, v: 500 }],
      finds: 'The maximum throughput before the system breaks. It keeps adding load until a threshold aborts the run.',
      watch: 'The request rate at the moment the abort threshold trips. Run it against a test environment, never production.',
      when: 'Capacity planning: "how far can we go?" rather than "are we OK at X?".',
      abort: true
    }
  };

  // 90 -> "1m30s", 3600 -> "1h"
  function dur(sec) {
    sec = Math.max(1, Math.round(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return (h ? h + 'h' : '') + (m ? m + 'm' : '') + (s ? s + 's' : '') || '1s';
  }

  function stagesOf(points) {
    const out = [];
    for (let i = 1; i < points.length; i++) {
      const d = points[i].t - points[i - 1].t;
      if (d <= 0) continue;
      out.push({ duration: dur(d), target: Math.max(0, Math.round(points[i].v)) });
    }
    return out;
  }

  function totalSeconds(points) { return points.length ? points[points.length - 1].t : 0; }
  function peak(points) { return points.reduce((m, p) => Math.max(m, p.v), 0); }

  // Value at time t (linear between points) — used for the chart and tests.
  function valueAt(points, t) {
    if (t <= points[0].t) return points[0].v;
    for (let i = 1; i < points.length; i++) {
      if (t <= points[i].t) {
        const a = points[i - 1];
        const b = points[i];
        return b.t === a.t ? b.v : a.v + (b.v - a.v) * ((t - a.t) / (b.t - a.t));
      }
    }
    return points[points.length - 1].v;
  }

  // k6 options object for a profile. budgets: { p95: ms, errorRate: 0..1 }.
  function toOptions(profile, budgets) {
    const b = Object.assign({ p95: 800, errorRate: 0.01 }, budgets || {});
    const pts = profile.points;
    let scenario;
    if (profile.mode === 'rate') {
      const max = Math.max(1, peak(pts));
      scenario = {
        executor: 'ramping-arrival-rate',
        startRate: Math.max(0, Math.round(pts[0].v)),
        timeUnit: '1s',
        // Rough sizing: VUs needed ~ rate x response time. Start with 1 s per request, cap at 2x for safety.
        preAllocatedVUs: Math.max(10, Math.ceil(max * 0.5)),
        maxVUs: Math.max(20, Math.ceil(max * 2)),
        stages: stagesOf(pts)
      };
    } else {
      scenario = { executor: 'ramping-vus', startVUs: Math.max(0, Math.round(pts[0].v)), stages: stagesOf(pts), gracefulRampDown: '30s' };
    }
    const thresholds = {
      http_req_duration: [profile.abort ? { threshold: 'p(95)<' + b.p95, abortOnFail: true, delayAbortEval: '30s' } : 'p(95)<' + b.p95],
      http_req_failed: [profile.abort ? { threshold: 'rate<' + b.errorRate, abortOnFail: true, delayAbortEval: '30s' } : 'rate<' + b.errorRate]
    };
    return { scenarios: { main: scenario }, thresholds };
  }

  function toScript(profile, budgets, title) {
    const opts = JSON.stringify(toOptions(profile, budgets), null, 2)
      .replace(/"([a-zA-Z_][a-zA-Z0-9_]*)":/g, '$1:').replace(/"/g, "'");
    return [
      '// ' + (title || 'Load profile') + ' — generated at pawansinha.com.au/explain/load-profiles/',
      '// Run: k6 run -e BASE_URL=https://your-test-env.example script.js',
      "import http from 'k6/http';",
      "import { check, sleep } from 'k6';",
      '',
      "const BASE_URL = __ENV.BASE_URL || 'https://quickpizza.grafana.com';",
      '',
      'export const options = ' + opts + ';',
      '',
      'export default function () {',
      "  const res = http.get(BASE_URL + '/');",
      "  check(res, { 'status is 200': (r) => r.status === 200 });",
      profile.mode === 'rate' ? '  // Arrival-rate executors start iterations on schedule, so no sleep() is needed here.' : '  sleep(1); // think time between pages',
      '}',
      ''
    ].join('\n');
  }

  const api = { PRESETS, dur, stagesOf, totalSeconds, peak, valueAt, toOptions, toScript };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ExplainProfiles = api;
})(this);
