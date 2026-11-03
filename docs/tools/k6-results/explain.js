/* k6 results explainer: turns k6 end-of-test output into a plain-English verdict.
   Runs in the browser (window.K6Explain) and in Node (module.exports), so it can be unit-tested.
   Nothing is sent anywhere: all parsing happens on the visitor's machine.

   Understands:
   - k6 v1.x text summary (█ THRESHOLDS / █ TOTAL RESULTS / HTTP / EXECUTION / NETWORK), compact or full mode
   - the legacy flat summary (k6 before v1.0, or k6 v1 with --summary-mode=legacy), old "✓ n ✗ m" and newer "n out of m"
   - --summary-export JSON (thresholds are booleans that mean "crossed")
   - handleSummary() data JSON (metrics.X.values, thresholds {expr: {ok}})
*/
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- number and unit parsing

  // Go duration ("1m2.5s", "605.92ms", "480.41µs", "0s") → milliseconds. Plain numbers are returned as is.
  function durationMs(s) {
    s = String(s).trim();
    if (/^-?\d+(\.\d+)?$/.test(s)) return parseFloat(s);
    const re = /(-?\d+(?:\.\d+)?)(ns|µs|μs|us|ms|s|m|h)/g;
    const mult = { ns: 1e-6, 'µs': 1e-3, 'μs': 1e-3, us: 1e-3, ms: 1, s: 1000, m: 60000, h: 3600000 };
    let total = 0, found = false, m, consumed = '';
    while ((m = re.exec(s))) { total += parseFloat(m[1]) * mult[m[2]]; found = true; consumed += m[0]; }
    return found && consumed === s.replace(/\s/g, '') ? total : NaN;
  }

  const SIZE = { B: 1, kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };

  // "39 kB" → 39000. Returns NaN when it isn't a size.
  function sizeBytes(num, unit) {
    return unit in SIZE ? parseFloat(num) * SIZE[unit] : NaN;
  }

  function fmtMs(ms) {
    if (ms == null || isNaN(ms)) return 'n/a';
    if (ms >= 60000) return (ms / 60000).toFixed(ms >= 600000 ? 0 : 1) + ' min';
    if (ms >= 1000) return (ms / 1000).toFixed(ms >= 10000 ? 1 : 2) + ' s';
    if (ms >= 10) return Math.round(ms) + ' ms';
    if (ms >= 1) return ms.toFixed(1) + ' ms';
    if (ms > 0) return Math.round(ms * 1000) + ' µs';
    return '0 ms';
  }

  function fmtPct(r) {
    if (r == null || isNaN(r)) return 'n/a';
    const p = r * 100;
    if (p === 0 || p === 100) return p + '%';
    if (p < 0.1) return p.toFixed(3) + '%';
    if (p < 10 || p > 99) return p.toFixed(2) + '%';
    return p.toFixed(1) + '%';
  }

  function fmtNum(n, digits) {
    if (n == null || isNaN(n)) return 'n/a';
    if (digits != null) return Number(n).toFixed(digits);
    return n >= 100 ? Math.round(n).toLocaleString('en-AU') : String(Math.round(n * 100) / 100);
  }

  function fmtBytes(b) {
    if (b == null || isNaN(b)) return 'n/a';
    const u = ['B', 'kB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (b >= 1000 && i < u.length - 1) { b /= 1000; i++; }
    return (i ? b.toFixed(1) : b) + ' ' + u[i];
  }

  // ---------------------------------------------------------------- common model
  // metrics: { name: { type, values: {avg, min, med, max, 'p(90)', ..., count, rate, passes, fails, value}, thresholds: [{expr, ok, actual}] } }
  // Trend values are in ms when the metric holds times. Rates use `rate` (0..1), `passes` = true values, `fails` = false values.

  function blankModel(format) {
    return { format, metrics: {}, checks: [], meta: {}, thresholdsKnown: false, crossedNames: [] };
  }

  function metric(model, name, type) {
    if (!model.metrics[name]) model.metrics[name] = { type, values: {}, thresholds: [] };
    else if (type && !model.metrics[name].type) model.metrics[name].type = type;
    return model.metrics[name];
  }

  // ---------------------------------------------------------------- JSON input

  function fromJson(obj) {
    if (!obj || typeof obj !== 'object' || !obj.metrics || typeof obj.metrics !== 'object') {
      throw new Error("This JSON doesn't look like k6 output. It needs a \"metrics\" object, as written by --summary-export or handleSummary().");
    }
    const isHandle = Object.values(obj.metrics).some(m => m && typeof m === 'object' && m.values && typeof m.values === 'object');
    const model = blankModel(isHandle ? 'handleSummary JSON' : '--summary-export JSON');

    for (const [name, m] of Object.entries(obj.metrics)) {
      if (!m || typeof m !== 'object') continue;
      const vals = isHandle ? (m.values || {}) : m;
      const out = metric(model, name, isHandle ? m.type : guessType(vals));
      for (const [k, v] of Object.entries(vals)) {
        if (k === 'thresholds' || typeof v !== 'number') continue;
        out.values[k] = v;
      }
      // summary-export rates store the rate as "value"
      if (out.type === 'rate' && out.values.rate == null && typeof vals.value === 'number') out.values.rate = vals.value;
      const th = m.thresholds;
      if (th && typeof th === 'object') {
        model.thresholdsKnown = true;
        for (const [expr, t] of Object.entries(th)) {
          // handleSummary: {ok: true}. summary-export: a boolean that is true when the threshold was CROSSED.
          const ok = isHandle ? !!(t && t.ok) : t === false;
          out.thresholds.push({ expr, ok });
        }
      }
    }

    const rg = obj.root_group;
    if (rg) collectChecks(rg, model.checks, '');
    if (obj.state && typeof obj.state.testRunDurationMs === 'number') model.meta.durationMs = obj.state.testRunDurationMs;
    if (obj.options && obj.options.summaryTrendStats) model.meta.trendStats = obj.options.summaryTrendStats;
    return model;
  }

  function guessType(vals) {
    if ('passes' in vals || 'fails' in vals) return 'rate';
    if ('count' in vals) return 'counter';
    if ('avg' in vals || 'med' in vals) return 'trend';
    if ('value' in vals && ('min' in vals || 'max' in vals)) return 'gauge';
    return '';
  }

  function collectChecks(group, list, prefix) {
    const checks = Array.isArray(group.checks) ? group.checks : Object.values(group.checks || {});
    for (const c of checks) {
      if (c && c.name != null) list.push({ name: (prefix ? prefix + ' › ' : '') + c.name, passes: c.passes || 0, fails: c.fails || 0 });
    }
    const groups = Array.isArray(group.groups) ? group.groups : Object.values(group.groups || {});
    for (const g of groups) if (g) collectChecks(g, list, (prefix ? prefix + ' › ' : '') + (g.name || ''));
  }

  // ---------------------------------------------------------------- text input

  // "name.......: rest" (v1 and legacy). The name may carry a {tag} suffix; sub-metric lines start with "{ ... }".
  const METRIC_LINE = /^\s*(?:([✓✗])\s+)?([A-Za-z_][\w]*(?:\{[^}]*\})?|\{[^}]*\})\s*\.{2,}\s*:\s*(.*?)\s*$/;
  const CHECK_LINE = /^\s*([✓✗])\s+(.+?)\s*$/;
  const CHECK_DETAIL = /↳\s*(\d+)%\s*[—-]\s*✓\s*(\d+)\s*\/\s*✗\s*(\d+)/;

  function fromText(text) {
    // Logs downloaded from CI (GitHub Actions) start every line with a timestamp: drop it.
    const lines = text.replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z ?/, ''));
    const isV1 = lines.some(l => /█\s*TOTAL RESULTS/.test(l));
    const model = blankModel(isV1 ? 'k6 v1 text summary' : 'k6 text summary (legacy format)');

    let section = isV1 ? 'pre' : 'total';   // v1: pre → thresholds → total → other (scenario/group blocks, ignored)
    let lastMetric = null;
    let thMetric = null;
    let lastCheck = null;
    const checkMap = {};

    for (const raw of lines) {
      const line = raw.replace(/\t/g, '    ');
      const trimmed = line.trim();
      if (!trimmed) continue;

      // header and progress lines (anywhere)
      let m;
      if ((m = trimmed.match(/^scenarios:\s*\([\d.]+%\)\s*(\d+)\s+scenarios?,\s*(\d+)\s+max VUs,\s*([^\s]+)\s+max duration/))) {
        model.meta.scenarios = +m[1]; model.meta.maxVUsPlanned = +m[2]; model.meta.maxDuration = m[3];
        continue;
      }
      if ((m = trimmed.match(/^\*\s+([\w-]+):\s*(.+)$/))) {
        (model.meta.executors = model.meta.executors || []).push({ name: m[1], text: m[2] });
        continue;
      }
      if ((m = trimmed.match(/^running \(([^)]+)\),\s*(\d+)\/(\d+) VUs,\s*(\d+) complete and (\d+) interrupted iterations/))) {
        model.meta.durationMs = durationMs(m[1]);
        model.meta.completeIterations = +m[4];
        model.meta.interrupted = +m[5];
        continue;
      }
      if ((m = trimmed.match(/thresholds on metrics '([^']+)' (?:have been|were) crossed/))) {
        model.crossedNames = m[1].split(/,\s*/);
        model.thresholdsKnown = true;
        continue;
      }
      if (/^(time=|level=|WARN|ERRO|INFO)/.test(trimmed)) continue;

      if (isV1) {
        if ((m = trimmed.match(/^█\s*(.+?)\s*$/))) {
          const title = m[1].toUpperCase();
          section = title.startsWith('THRESHOLDS') ? 'thresholds' : title.startsWith('TOTAL RESULTS') ? 'total' : 'other';
          thMetric = null; lastMetric = null; lastCheck = null;
          continue;
        }
        if (section === 'pre' || section === 'other') continue;
        if (section === 'thresholds') {
          model.thresholdsKnown = true;
          if ((m = trimmed.match(/^([✓✗])\s+'(.+)'\s*(.*)$/))) {
            if (thMetric) metric(model, thMetric).thresholds.push({ expr: m[2], ok: m[1] === '✓', actual: m[3] || '' });
          } else if (/^[A-Za-z_][\w]*(\{[^}]*\})?$/.test(trimmed)) {
            thMetric = trimmed;
          }
          continue;
        }
        if (/^(HTTP|EXECUTION|NETWORK|WEBSOCKET|BROWSER|GRPC|CUSTOM|WEB VITALS)$/.test(trimmed)) continue;
      } else if ((m = trimmed.match(/^█\s*(.+?)\s*$/))) {
        // legacy group header: checks below it belong to the group
        lastCheck = null;
        continue;
      }

      if ((m = line.match(METRIC_LINE))) {
        const mark = m[1], rawName = m[2], rest = m[3];
        let name = rawName;
        if (rawName.startsWith('{')) {
          if (!lastMetric) continue;
          name = lastMetric + '{' + rawName.slice(1, -1).trim().replace(/\s+/g, '') + '}';
        } else {
          lastMetric = rawName;
        }
        const met = parseValues(model, name, rest);
        if (mark && met && !rawName.startsWith('{')) {
          // legacy: ✓/✗ before a metric means its thresholds passed/failed (the expressions aren't printed)
          model.thresholdsKnown = true;
          met.thresholds.push({ expr: '(all thresholds on this metric)', ok: mark === '✓' });
        }
        lastCheck = null;
        continue;
      }

      if ((m = trimmed.match(CHECK_DETAIL))) {
        if (lastCheck) { lastCheck.passes = +m[2]; lastCheck.fails = +m[3]; }
        continue;
      }
      if ((m = trimmed.match(CHECK_LINE))) {
        const name = m[2];
        if (/^\[|VUs|iters\/s|\d+%\s*\]/.test(name)) continue;  // progress bar lines like "load ✓ [ 100% ]"
        const c = checkMap[name] || (checkMap[name] = { name, passes: null, fails: m[1] === '✓' ? 0 : null });
        if (!model.checks.includes(c)) model.checks.push(c);
        lastCheck = c;
        continue;
      }
    }

    // v1 splits checks into checks_total / checks_succeeded / checks_failed: rebuild a "checks" rate.
    const cs = model.metrics.checks_succeeded;
    if (cs && !model.metrics.checks) {
      const total = (cs.values.passes || 0) + (cs.values.fails || 0);
      model.metrics.checks = { type: 'rate', values: { rate: cs.values.rate, passes: cs.values.passes, fails: total - (cs.values.passes || 0) }, thresholds: [] };
    }
    // v1 prints threshold results for "checks" under THRESHOLDS even though the metric line is checks_*
    if (model.metrics.checks && model.metrics.checks.values.rate == null && cs) model.metrics.checks.values = Object.assign({}, cs.values);

    // legacy failed thresholds named in the final error line
    for (const n of model.crossedNames) {
      const met = model.metrics[n];
      if (met && !met.thresholds.length) met.thresholds.push({ expr: '(all thresholds on this metric)', ok: false });
    }
    return model;
  }

  function parseValues(model, name, rest) {
    // trend: key=value pairs
    if (/\b(avg|med|min|max|p\([\d.]+\))=/.test(rest)) {
      const met = metric(model, name, 'trend');
      const re = /(avg|min|med|max|p\([\d.]+\))=(\S+)/g;
      let m, isTime = false;
      while ((m = re.exec(rest))) {
        const v = durationMs(m[2]);
        if (/[a-zµμ]s?$/.test(m[2]) && !/^-?\d+(\.\d+)?$/.test(m[2])) isTime = true;
        met.values[m[1]] = v;
      }
      met.time = isTime;
      return met;
    }
    // rate: "96.16% 276 out of 287" | "97.04% ✓ 296 ✗ 9" | "3.83% 11 out of 287"
    let m = rest.match(/^(-?[\d.]+)%\s*(?:(\d+)\s+out of\s+(\d+)|✓\s*(\d+)\s*✗\s*(\d+))?/);
    if (m) {
      const met = metric(model, name, 'rate');
      met.values.rate = parseFloat(m[1]) / 100;
      if (m[2] != null) { met.values.passes = +m[2]; met.values.fails = +m[3] - +m[2]; }
      else if (m[4] != null) { met.values.passes = +m[4]; met.values.fails = +m[5]; }
      return met;
    }
    // gauge: "3 min=0 max=3"
    m = rest.match(/^(-?[\d.]+)\s+min=(-?[\d.]+)\s+max=(-?[\d.]+)/);
    if (m) {
      const met = metric(model, name, 'gauge');
      met.values.value = +m[1]; met.values.min = +m[2]; met.values.max = +m[3];
      return met;
    }
    // counter with sizes: "39 kB 4.6 kB/s"
    m = rest.match(/^(-?[\d.]+)\s*(B|kB|KB|MB|GB|TB)\s+(-?[\d.]+)\s*(B|kB|KB|MB|GB|TB)\/s/);
    if (m) {
      const met = metric(model, name, 'counter');
      met.values.count = sizeBytes(m[1], m[2]); met.values.rate = sizeBytes(m[3], m[4]); met.bytes = true;
      return met;
    }
    // counter: "287 33.554571/s"
    m = rest.match(/^(-?[\d.]+)\s+(-?[\d.]+)\/s/);
    if (m) {
      const met = metric(model, name, 'counter');
      met.values.count = +m[1]; met.values.rate = +m[2];
      return met;
    }
    // bare number (custom gauge or counter)
    m = rest.match(/^(-?[\d.]+)\s*$/);
    if (m) {
      const met = metric(model, name, 'gauge');
      met.values.value = +m[1];
      return met;
    }
    return null;
  }

  // ---------------------------------------------------------------- parse entry point

  function parse(input) {
    const text = String(input || '').trim();
    if (!text) throw new Error('Paste the output of a k6 run first.');
    if (text[0] === '{') {
      let obj;
      try { obj = JSON.parse(text); }
      catch (e) { throw new Error("That looks like JSON, but it isn't valid JSON (" + e.message + '). Paste the whole file.'); }
      return fromJson(obj);
    }
    const model = fromText(text);
    if (!Object.keys(model.metrics).length) {
      throw new Error("I couldn't find any k6 metrics in that text. Paste the end-of-test summary: the block that starts with █ THRESHOLDS or █ TOTAL RESULTS (k6 v1), or the lines like http_req_duration....: avg=… (older k6).");
    }
    return model;
  }

  // ---------------------------------------------------------------- analysis

  function v(model, name, key) {
    const m = model.metrics[name];
    return m && m.values[key] != null && !isNaN(m.values[key]) ? m.values[key] : null;
  }

  function analyse(model) {
    const out = { format: model.format, verdict: 'unknown', headline: '', summary: '', thresholds: [], sections: [], hints: [], missing: [], stats: [] };
    const hint = (level, title, text) => out.hints.push({ level, title, text });
    const section = (level, title, text) => out.sections.push({ level, title, text });

    // ---- thresholds
    let failed = 0, total = 0;
    for (const [name, m] of Object.entries(model.metrics)) {
      for (const t of m.thresholds) {
        total++;
        if (!t.ok) failed++;
        out.thresholds.push({ metric: name, expr: t.expr, ok: t.ok, actual: t.actual || '' });
      }
    }
    out.thresholds.sort((a, b) => a.ok - b.ok);

    // ---- latency
    const durName = 'http_req_duration';
    const okName = 'http_req_duration{expected_response:true}';
    const useOkToo = model.metrics[okName] && (v(model, 'http_req_failed', 'rate') || 0) > 0.01;
    const med = v(model, durName, 'med'), p95 = v(model, durName, 'p(95)'), p90 = v(model, durName, 'p(90)'),
      p99 = v(model, durName, 'p(99)'), max = v(model, durName, 'max'), avg = v(model, durName, 'avg');
    const tailStat = p95 != null ? ['p95', p95] : p90 != null ? ['p90', p90] : null;
    let latencyLevel = 'info';
    if (med != null || avg != null) {
      const parts = [];
      if (med != null) parts.push(`Half of the requests finished in under <b>${fmtMs(med)}</b>`);
      else parts.push(`The average request took <b>${fmtMs(avg)}</b> (the median wasn't in the output)`);
      if (p95 != null) parts.push(`1 in 20 took longer than <b>${fmtMs(p95)}</b>`);
      else if (p90 != null) parts.push(`1 in 10 took longer than <b>${fmtMs(p90)}</b>`);
      if (p99 != null) parts.push(`1 in 100 took longer than <b>${fmtMs(p99)}</b>`);
      if (max != null) parts.push(`the slowest took <b>${fmtMs(max)}</b>`);
      let text = parts.join(', ') + '.';
      let okText = '';
      if (useOkToo) {
        const okMed = v(model, okName, 'med'), okP95 = v(model, okName, 'p(95)');
        okText = ` The numbers above include failed requests, which are often very fast (instant errors) or very slow (timeouts). Counting successful responses only: median ${fmtMs(okMed)}` +
          (okP95 != null ? `, p95 ${fmtMs(okP95)}.` : '.');
      }
      const tail = tailStat ? tailStat[1] : null;
      if (tail != null) latencyLevel = tail > 3000 ? 'bad' : tail > 1000 ? 'warn' : 'ok';
      if (med != null && tail != null && med > 0) {
        const ratio = tail / med;
        if (ratio >= 5) {
          latencyLevel = latencyLevel === 'bad' ? 'bad' : 'warn';
          text += ` The ${tailStat[0]} is <b>${fmtNum(ratio, 1)}×</b> the median: a long tail. Most users are fine, but a sizeable minority wait much longer.`;
          hint('warn', 'Long latency tail', `A ${tailStat[0]} that far above the median usually means requests sometimes queue or pause: a saturated thread or connection pool, garbage-collection pauses, lock contention, a slow downstream call for some requests, or cold caches. Compare the slow periods with server CPU, GC logs and pool usage. Splitting the test by endpoint (tags) shows whether one request type causes it.`);
        } else if (ratio >= 2.5) {
          text += ` The ${tailStat[0]} is ${fmtNum(ratio, 1)}× the median, a moderate tail.`;
        } else {
          text += ` The ${tailStat[0]} is within ${fmtNum(ratio, 1)}× of the median, so response times were fairly consistent.`;
        }
      }
      if (max != null && tail != null && tail > 0 && max / tail >= 10 && max > 1000) {
        hint('info', 'A few very slow outliers', `The slowest request (${fmtMs(max)}) was over 10× the ${tailStat ? tailStat[0] : 'tail'}. Rare spikes like this are often timeouts, retries, connection resets or a pause at the start of the test (cold start, JIT warm-up, autoscaling). Check whether they cluster at one moment.`);
      }
      text += okText;
      if ((model.metrics[durName].thresholds || []).some(t => !t.ok)) latencyLevel = 'bad';
      section(latencyLevel, 'Response times', text);
    } else {
      out.missing.push('http_req_duration (response times)');
    }

    // ---- errors
    const failRate = v(model, 'http_req_failed', 'rate');
    let errorLevel = 'info';
    if (failRate != null) {
      const failedN = v(model, 'http_req_failed', 'passes');
      const totalN = failedN != null && v(model, 'http_req_failed', 'fails') != null ? failedN + v(model, 'http_req_failed', 'fails') : null;
      const count = failedN != null && totalN ? ` (${fmtNum(failedN)} of ${fmtNum(totalN)} requests)` : '';
      const errTh = (model.metrics.http_req_failed.thresholds || []).some(t => !t.ok);
      if (failRate === 0) { errorLevel = 'ok'; section('ok', 'Errors', 'No HTTP requests failed.'); }
      else if (failRate < 0.01 && !errTh) { errorLevel = 'warn'; section('warn', 'Errors', `<b>${fmtPct(failRate)}</b> of requests failed${count}. Small, but find out which requests and why: errors under load often grow quickly as load rises.`); }
      else {
        errorLevel = 'bad';
        let text = `<b>${fmtPct(failRate)}</b> of requests failed${count}. k6 counts a request as failed when it gets no response or a status outside 200–399 (unless you changed that with setResponseCallback).`;
        if (failRate >= 0.5) text += ' With most requests failing, check the basics first: the URL and environment, an expired login token, a rate limiter or firewall blocking the load generator, or the system being down.';
        section('bad', 'Errors', text);
        hint('bad', 'Find the failing requests', 'Add checks on status codes per request, tag requests by name, and look at the response status breakdown (for example with --out json or the web dashboard: K6_WEB_DASHBOARD=true k6 run script.js). Errors that start only above a certain load point to a capacity limit; errors from the start point to the script or environment.');
      }
    } else {
      out.missing.push('http_req_failed (error rate)');
    }

    // ---- checks
    const checkRate = v(model, 'checks', 'rate');
    const failingChecks = model.checks.filter(c => c.fails > 0 || c.fails === null);
    if (checkRate != null || model.checks.length) {
      let level = 'ok', text;
      if (checkRate != null) text = `<b>${fmtPct(checkRate)}</b> of checks passed.`;
      else text = `${model.checks.length} check${model.checks.length > 1 ? 's' : ''} ran.`;
      if (failingChecks.length) {
        level = checkRate != null && checkRate < 0.95 ? 'bad' : 'warn';
        text += ' Failing: ' + failingChecks.map(c => `“${esc(c.name)}”` + (c.fails ? ` (${fmtNum(c.fails)} failed${c.passes != null ? ' of ' + fmtNum(c.passes + c.fails) : ''})` : '')).join(', ') + '.';
        text += ' A failed check doesn\'t stop the test or fail it on its own: add a threshold such as checks: [\'rate>0.99\'] if it should.';
      } else if (checkRate != null && checkRate < 1) {
        level = 'warn';
      }
      section(level, 'Checks', text);
    } else {
      hint('info', 'No checks', 'The test had no checks, so a 200 page that says "Sorry, something went wrong" would count as a success. Add check(res, { \'status is 200\': (r) => r.status === 200 }) and a content check for important responses.');
    }

    // ---- throughput and execution
    const reqRate = v(model, 'http_reqs', 'rate'), reqCount = v(model, 'http_reqs', 'count');
    const itRate = v(model, 'iterations', 'rate'), itCount = v(model, 'iterations', 'count');
    const dur = model.meta.durationMs != null ? model.meta.durationMs : (reqCount && reqRate ? reqCount / reqRate * 1000 : null);
    const vusMax = v(model, 'vus', 'max');
    const vusMaxAllowed = v(model, 'vus_max', 'max') != null ? v(model, 'vus_max', 'max') : v(model, 'vus_max', 'value');
    if (reqRate != null || itRate != null) {
      const parts = [];
      if (reqRate != null) parts.push(`k6 sent <b>${fmtNum(reqRate, reqRate < 10 ? 2 : 1)} requests per second</b>` + (reqCount != null ? ` (${fmtNum(reqCount)} in total)` : ''));
      if (itRate != null) parts.push(`completed ${fmtNum(itRate, itRate < 10 ? 2 : 1)} iterations per second` + (itCount != null ? ` (${fmtNum(itCount)} in total)` : ''));
      let text = parts.join(' and ') + '.';
      if (dur) text += ` The test ran for about ${fmtMs(dur)}.`;
      if (vusMax != null) text += ` Up to ${fmtNum(vusMax)} virtual users were active at once` + (vusMaxAllowed != null ? ` (${fmtNum(vusMaxAllowed)} allowed).` : '.');
      section('info', 'Throughput', text);
    } else {
      out.missing.push('http_reqs / iterations (throughput)');
    }

    if (dur != null && dur < 60000) {
      hint('warn', 'Short test', `The test ran for ${fmtMs(dur)}. That is fine for a smoke test, but too short to judge capacity: caches, connection pools, autoscaling and garbage collection need several minutes to show their steady state. Run load tests for at least 10–15 minutes at the target rate.`);
    }
    const sampleN = reqCount != null ? reqCount : itCount;
    if (sampleN != null && sampleN < 200) {
      hint('warn', 'Small sample', `Only ${fmtNum(sampleN)} ${reqCount != null ? 'requests' : 'iterations'} were measured. A p95 from fewer than a few hundred samples is rough, and a p99 is mostly noise.`);
    }

    const dropped = v(model, 'dropped_iterations', 'count');
    if (dropped != null && dropped > 0) {
      const planned = (itCount || 0) + dropped;
      const share = planned ? dropped / planned : null;
      hint(share != null && share > 0.01 ? 'bad' : 'warn', 'Dropped iterations: the test didn\'t reach its target rate',
        `k6 skipped <b>${fmtNum(dropped)}</b> iterations${share != null ? ' (' + fmtPct(share) + ' of the planned load)' : ''} because no virtual user was free to start them. ` +
        (vusMax != null && vusMaxAllowed != null && vusMax >= vusMaxAllowed
          ? `All ${fmtNum(vusMaxAllowed)} allowed VUs were busy. `
          : '') +
        'With an arrival-rate executor this means either maxVUs is too low, or the system slowed down so each iteration took longer and VUs piled up (which is a finding in itself). ' +
        `Size VUs with Little's Law: VUs ≈ target iterations per second × iteration duration in seconds` +
        (v(model, 'iteration_duration', 'p(95)') != null && itRate ? ` (here about ${Math.ceil(itRate * v(model, 'iteration_duration', 'p(95)') / 1000 * 1.5) || 1} VUs using the p95 iteration time plus 50% headroom)` : '') +
        '. Raise maxVUs, and treat a rise in dropped iterations as the point where the system stopped keeping up.');
    }

    if (model.meta.interrupted && model.meta.completeIterations != null) {
      const share = model.meta.interrupted / Math.max(1, model.meta.completeIterations + model.meta.interrupted);
      if (share > 0.01) hint('info', 'Interrupted iterations', `${fmtNum(model.meta.interrupted)} iterations were cut off when the test ended (${fmtPct(share)}). Usually harmless at the end of a test, but a high count means long iterations or a short gracefulStop, and their requests may be missing from the results.`);
    }

    // closed model: throughput is capped by VUs / iteration duration
    // closed model (constant-vus, ramping-vus, per-vu/shared iterations): throughput is capped by VUs / iteration duration.
    // When k6 didn't print the executor (JSON input), only suggest it if the numbers fit a closed model.
    const ex = model.meta.executors;
    const openKnown = ex && ex.some(e => /iterations\/s/.test(e.text));
    const closedKnown = ex && !openKnown && ex.some(e => /VUs|iterations/.test(e.text));
    const itAvg = v(model, 'iteration_duration', 'avg');
    if (!openKnown && !(dropped > 0) && vusMax && itAvg && itRate) {
      const ceiling = vusMax / (itAvg / 1000);
      const fit = itRate / ceiling;
      if (closedKnown || (fit > 0.75 && fit < 1.1)) {
        hint('info', 'Throughput was set by your VUs, not found by the test',
          (closedKnown ? 'In this test' : 'If you used a VU-based executor (the default, constant-vus or ramping-vus),') +
          ` each virtual user starts its next iteration only when the last one ends, so ${fmtNum(vusMax)} VUs ÷ ${fmtMs(itAvg)} per iteration caps it at about ${fmtNum(ceiling, 1)} iterations per second (you got ${fmtNum(itRate, 1)}). If the system slows down, k6 automatically sends less load, which hides the problem. To test a target rate, use the constant-arrival-rate or ramping-arrival-rate executor.`);
      }
    }

    // ---- request phases
    const dAvg = v(model, 'http_req_duration', 'avg');
    const waitAvg = v(model, 'http_req_waiting', 'avg'), recvAvg = v(model, 'http_req_receiving', 'avg'), sendAvg = v(model, 'http_req_sending', 'avg');
    const blkAvg = v(model, 'http_req_blocked', 'avg'), blkP95 = v(model, 'http_req_blocked', 'p(95)'),
      connAvg = v(model, 'http_req_connecting', 'avg'), tlsAvg = v(model, 'http_req_tls_handshaking', 'avg'), tlsP95 = v(model, 'http_req_tls_handshaking', 'p(95)');
    if (dAvg && waitAvg != null) {
      const share = waitAvg / dAvg;
      if (share >= 0.8 && dAvg >= 50) {
        hint('info', 'Time is spent on the server', `Waiting for the first byte (http_req_waiting, ${fmtMs(waitAvg)} on average) is ${fmtPct(share)} of the response time. The time is spent in the application, database or downstream calls, not on the network. Look at server-side traces or APM for the slowest endpoints.`);
      }
      if (recvAvg != null && recvAvg / dAvg >= 0.3 && recvAvg > 20) {
        hint('warn', 'Downloading responses takes a large share', `Receiving the response body takes ${fmtMs(recvAvg)} on average (${fmtPct(recvAvg / dAvg)} of the time). Either responses are large (check compression and payload sizes), or the load generator's network or CPU is the limit. Watch the load generator's CPU and bandwidth.`);
      }
      if (sendAvg != null && sendAvg / dAvg >= 0.2 && sendAvg > 20) {
        hint('warn', 'Uploads are slow', `Sending requests takes ${fmtMs(sendAvg)} on average. Large request bodies or a saturated network on the load generator are the usual causes.`);
      }
    }
    if ((blkAvg != null && blkAvg > 10) || (blkP95 != null && blkP95 > 50)) {
      hint('warn', 'Opening connections is slow', `k6 waited ${fmtMs(blkAvg)} on average (p95 ${fmtMs(blkP95)}) before it could send requests (http_req_blocked)` +
        (connAvg != null ? `, with ${fmtMs(connAvg)} on TCP connects` : '') + (tlsAvg ? ` and ${fmtMs(tlsAvg)} on TLS handshakes` : '') +
        '. Connections are probably not being reused: check keep-alive on the server and load balancer, avoid noConnectionReuse/noVUConnectionReuse in options, and check whether the load generator is running out of ports or file descriptors.');
    } else if (tlsP95 != null && tlsP95 > 100) {
      hint('info', 'TLS handshakes are expensive', `The p95 TLS handshake took ${fmtMs(tlsP95)}. If this is more than the first request per VU, connections are being re-established; check keep-alive and session reuse.`);
    }
    if (!('http_req_waiting' in model.metrics) && model.format.startsWith('k6 v1')) {
      out.missing.push('request phases (blocked, connecting, waiting, receiving): run k6 with --summary-mode=full to include them');
    }

    // ---- verdict
    const levels = out.sections.map(s => s.level).concat(out.hints.map(h => h.level));
    if (total) {
      out.verdict = failed ? 'fail' : 'pass';
      out.headline = failed ? `Failed: ${failed} of ${total} threshold${total > 1 ? 's' : ''} crossed` : `Passed: all ${total} threshold${total > 1 ? 's' : ''} met`;
      out.summary = failed
        ? 'k6 exits with code 99 when a threshold is crossed, so a CI pipeline would stop here. The details below show why.'
        : (levels.includes('bad') ? 'Your thresholds passed, but there are problems they didn\'t catch. Consider tightening them.' : 'Your pass/fail criteria were met. Read the notes below before you call it done.');
    } else {
      out.verdict = levels.includes('bad') ? 'fail' : levels.includes('warn') ? 'warn' : (latencyLevel === 'ok' || errorLevel === 'ok') ? 'pass' : 'unknown';
      out.headline = out.verdict === 'fail' ? 'Problems found' : out.verdict === 'warn' ? 'Needs attention' : out.verdict === 'pass' ? 'Looks healthy' : 'Not enough data for a verdict';
      out.summary = 'No thresholds were set, so k6 didn\'t judge pass or fail. This is my read of the numbers. Add thresholds (for example http_req_duration: [\'p(95)<500\'] and http_req_failed: [\'rate<0.01\']) so k6 can fail the test for you.';
      if (model.format.includes('legacy')) out.summary = 'No threshold results were found in the output, so this is my read of the numbers. If you set thresholds, k6 marks them with ✓ or ✗ next to the metric name.';
    }

    // ---- headline numbers
    if (tailStat) out.stats.push({ label: tailStat[0] + ' response time', value: fmtMs(tailStat[1]), level: latencyLevel });
    else if (med != null) out.stats.push({ label: 'Median response time', value: fmtMs(med), level: latencyLevel });
    if (failRate != null) out.stats.push({ label: 'Failed requests', value: fmtPct(failRate), level: errorLevel });
    if (reqRate != null) out.stats.push({ label: 'Requests per second', value: fmtNum(reqRate, reqRate < 10 ? 2 : 1), level: 'info' });
    if (checkRate != null) out.stats.push({ label: 'Checks passed', value: fmtPct(checkRate), level: checkRate === 1 ? 'ok' : checkRate >= 0.99 ? 'warn' : 'bad' });

    const order = { bad: 0, warn: 1, info: 2, ok: 3 };
    out.hints.sort((a, b) => order[a.level] - order[b.level]);
    return out;
  }

  function esc(t) {
    return String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function explain(input) {
    const model = parse(input);
    const result = analyse(model);
    result.model = model;
    return result;
  }

  // ---------------------------------------------------------------- examples (real k6 v1.0 output, trimmed)

  const EXAMPLES = {
    v1: `     scenarios: (100.00%) 1 scenario, 60 max VUs, 10m30s max duration (incl. graceful stop):
              * checkout: 40.00 iterations/s for 10m0s (maxVUs: 20-60, gracefulStop: 30s)

  █ THRESHOLDS

    checks
    ✓ 'rate>0.99' rate=99.52%

    http_req_duration
    ✗ 'p(95)<500' p(95)=842.31ms
    ✓ 'p(99)<2000' p(99)=1.61s

    http_req_failed
    ✓ 'rate<0.01' rate=0.47%


  █ TOTAL RESULTS

    checks_total.......................: 23712  39.49/s
    checks_succeeded...................: 99.52% 23598 out of 23712
    checks_failed......................: 0.47%  114 out of 23712

    ✓ status is 200
    ✗ order confirmed
      ↳  99% — ✓ 11742 / ✗ 114

    HTTP
    http_req_duration.......................................................: avg=212.4ms  min=38.12ms med=118.9ms max=4.82s  p(90)=511.2ms p(95)=842.31ms
      { expected_response:true }............................................: avg=209.83ms min=38.12ms med=118.4ms max=4.82s  p(90)=507.7ms p(95)=836.02ms
    http_req_failed.........................................................: 0.47%  114 out of 23712
    http_reqs...............................................................: 23712  39.49/s

    EXECUTION
    dropped_iterations......................................................: 144    0.24/s
    iteration_duration......................................................: avg=424.9ms  min=80.4ms  med=241.7ms max=5.01s  p(90)=1.02s   p(95)=1.66s
    iterations..............................................................: 11856  19.74/s
    vus.....................................................................: 60     min=8        max=60
    vus_max.................................................................: 60     min=20       max=60

    NETWORK
    data_received...........................................................: 412 MB 686 kB/s
    data_sent...............................................................: 9.8 MB 16 kB/s

running (10m00.6s), 00/60 VUs, 11856 complete and 0 interrupted iterations
checkout ✓ [ 100% ] 00/60 VUs  10m0s  40.00 iters/s`,

    legacy: `     scenarios: (100.00%) 1 scenario, 50 max VUs, 5m30s max duration (incl. graceful stop):
              * default: 50 looping VUs for 5m0s (gracefulStop: 30s)

     ✓ status is 200

     checks.........................: 100.00% ✓ 18452     ✗ 0
     data_received..................: 96 MB   319 kB/s
     data_sent......................: 2.1 MB  7.0 kB/s
     http_req_blocked...............: avg=38.2ms   min=1µs     med=4µs     max=1.42s    p(90)=7µs      p(95)=212.4ms
     http_req_connecting............: avg=12.1ms   min=0s      med=0s      max=402.7ms  p(90)=0s       p(95)=61.3ms
   ✓ http_req_duration..............: avg=311.12ms min=92.43ms med=287.6ms max=1.92s    p(90)=455.1ms  p(95)=521.73ms
       { expected_response:true }...: avg=311.12ms min=92.43ms med=287.6ms max=1.92s    p(90)=455.1ms  p(95)=521.73ms
   ✓ http_req_failed................: 0.00%   ✓ 0         ✗ 18452
     http_req_receiving.............: avg=1.2ms    min=21µs    med=88µs    max=310.5ms  p(90)=1.1ms    p(95)=4.9ms
     http_req_sending...............: avg=41.5µs   min=6µs     med=25µs    max=12.1ms   p(90)=62µs     p(95)=91µs
     http_req_tls_handshaking.......: avg=24.6ms   min=0s      med=0s      max=988.2ms  p(90)=0s       p(95)=142.6ms
     http_req_waiting...............: avg=309.88ms min=92.11ms med=287.1ms max=1.91s    p(90)=453.8ms  p(95)=519.6ms
     http_reqs......................: 18452   61.42/s
     iteration_duration.............: avg=813.4ms  min=600.9ms med=789.2ms max=2.84s    p(90)=962.3ms  p(95)=1.03s
     iterations.....................: 18452   61.42/s
     vus............................: 50      min=50       max=50
     vus_max........................: 50      min=50       max=50

running (5m00.4s), 00/50 VUs, 18452 complete and 0 interrupted iterations
default ✓ [======================================] 50 VUs  5m0s`,

    exportJson: JSON.stringify({
      root_group: { name: '', path: '', groups: {}, checks: { 'status is 200': { name: 'status is 200', passes: 4613, fails: 387 } } },
      metrics: {
        http_reqs: { count: 5000, rate: 27.71 },
        iterations: { count: 5000, rate: 27.71 },
        http_req_failed: { passes: 387, fails: 4613, value: 0.0774, thresholds: { 'rate<0.01': true } },
        http_req_duration: { avg: 1460.2, min: 41.3, med: 690.4, max: 30001.2, 'p(90)': 2410.7, 'p(95)': 4120.9, thresholds: { 'p(95)<1000': true } },
        'http_req_duration{expected_response:true}': { avg: 980.6, min: 41.3, med: 655.1, max: 9120.4, 'p(90)': 1980.3, 'p(95)': 2702.5 },
        http_req_waiting: { avg: 1455.1, min: 40.9, med: 688.2, max: 30000.8, 'p(90)': 2405.9, 'p(95)': 4115.6 },
        http_req_blocked: { avg: 0.9, min: 0.001, med: 0.004, max: 210.2, 'p(90)': 0.006, 'p(95)': 0.009 },
        checks: { passes: 4613, fails: 387, value: 0.9226 },
        iteration_duration: { avg: 2462.4, min: 1042.1, med: 1693.8, max: 31003.5, 'p(90)': 3413.2, 'p(95)': 5124.6 },
        vus: { value: 1, min: 1, max: 80 },
        vus_max: { value: 80, min: 80, max: 80 },
      },
    }, null, 2),

    handleSummaryJson: JSON.stringify({
      state: { testRunDurationMs: 902114.6 },
      root_group: { name: '', path: '', groups: [{ name: 'Search', path: '::Search', groups: [], checks: [{ name: 'results returned', passes: 26988, fails: 0 }] }], checks: [] },
      metrics: {
        http_reqs: { type: 'counter', contains: 'default', values: { count: 53976, rate: 59.83 } },
        iterations: { type: 'counter', contains: 'default', values: { count: 26988, rate: 29.92 } },
        http_req_failed: { type: 'rate', contains: 'default', values: { rate: 0, passes: 0, fails: 53976 }, thresholds: { 'rate<0.01': { ok: true } } },
        http_req_duration: { type: 'trend', contains: 'time', values: { avg: 96.4, min: 22.1, med: 71.3, max: 1302.4, 'p(90)': 168.5, 'p(95)': 231.9, 'p(99)': 480.2 }, thresholds: { 'p(95)<300': { ok: true }, 'p(99)<800': { ok: true } } },
        http_req_waiting: { type: 'trend', contains: 'time', values: { avg: 95.1, min: 21.8, med: 70.4, max: 1301.1, 'p(90)': 167.2, 'p(95)': 230.1 } },
        http_req_receiving: { type: 'trend', contains: 'time', values: { avg: 0.9, min: 0.02, med: 0.11, max: 41.2, 'p(90)': 0.4, 'p(95)': 1.3 } },
        http_req_blocked: { type: 'trend', contains: 'time', values: { avg: 0.02, min: 0, med: 0.003, max: 88.1, 'p(90)': 0.005, 'p(95)': 0.007 } },
        checks: { type: 'rate', contains: 'default', values: { rate: 1, passes: 26988, fails: 0 }, thresholds: { 'rate>0.99': { ok: true } } },
        iteration_duration: { type: 'trend', contains: 'time', values: { avg: 1195.2, min: 1046.1, med: 1146.5, max: 3610.2, 'p(90)': 1342.4, 'p(95)': 1468.6 } },
        vus: { type: 'gauge', contains: 'default', values: { value: 5, min: 5, max: 41 } },
        vus_max: { type: 'gauge', contains: 'default', values: { value: 100, min: 100, max: 100 } },
        dropped_iterations: { type: 'counter', contains: 'default', values: { count: 0, rate: 0 } },
      },
    }, null, 2),
  };

  const api = { parse, analyse, explain, durationMs, fmtMs, fmtPct, esc, EXAMPLES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.K6Explain = api;
})(typeof window !== 'undefined' ? window : this);
