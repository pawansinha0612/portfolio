/* SLO / error budget calculator. Runs in the browser (window.SloCalc) and in Node (module.exports), so it can be
   unit-tested. Pure maths, nothing is sent anywhere.

   compute(input) takes the page's inputs (numbers or strings) and returns everything the page shows:
   budget per period, burn rate, the multi-window multi-burn-rate alert table (Google SRE workbook, chapter 5),
   the budget tracker and the k6 / Prometheus snippets. Bad input never produces NaN: it gives ok:false + error,
   or leaves the optional part out. */
(function (root) {
  'use strict';

  const DAY = 86400;
  const WINDOWS = [7, 28, 30, 90];
  const PRESETS = [99, 99.5, 99.9, 99.95, 99.99];

  // Google SRE workbook recommendation: [share of budget spent, long window h, short window, severity].
  const ALERTS = [
    { budget: 2, longH: 1, long: '1h', short: '5m', severity: 'page', name: 'ErrorBudgetBurnFast', for: '2m' },
    { budget: 5, longH: 6, long: '6h', short: '30m', severity: 'page', name: 'ErrorBudgetBurnMedium', for: '15m' },
    { budget: 10, longH: 72, long: '3d', short: '6h', severity: 'ticket', name: 'ErrorBudgetBurnSlow', for: '1h' },
  ];

  // "1,000,000", " 2.5e6 ", "" → number or null. Commas and spaces are allowed as thousands separators.
  function num(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const s = String(v).trim().replace(/[,\s_]/g, '');
    if (!s) return null;
    const n = Number(s.replace(/%$/, ''));
    return Number.isFinite(n) ? n : null;
  }

  // Trim float noise: 0.0010000000000000009 → 0.001, keeps up to 6 significant digits.
  function clean(n) {
    if (!Number.isFinite(n)) return n;
    return Number(n.toPrecision(6));
  }

  // Seconds → "43m 12s", "7h 18m", "3d 15h", "0.9 s". Non-finite → "—" (or "never" for Infinity when asked).
  function fmtDuration(sec, opts) {
    opts = opts || {};
    if (sec === Infinity) return opts.infinity || 'never';
    if (!Number.isFinite(sec) || sec < 0) return '—';
    if (sec === 0) return '0 s';
    if (sec < 10) return clean(Number(sec.toFixed(sec < 1 ? 2 : 1))) + ' s';
    if (sec < 60) return Math.round(sec) + ' s';
    // Round at the smallest unit shown, so 1h 40m 48s reads 1h 41m.
    if (sec >= DAY) {
      const hours = Math.round(sec / 3600), d = Math.floor(hours / 24), h = hours % 24;
      return h ? d + 'd ' + h + 'h' : d + 'd';
    }
    if (sec >= 3600) {
      const mins = Math.round(sec / 60), h = Math.floor(mins / 60), m = mins % 60;
      if (h >= 24) return '1d';
      return m ? h + 'h ' + m + 'm' : h + 'h';
    }
    const secs = Math.round(sec), m = Math.floor(secs / 60), s = secs % 60;
    if (m >= 60) return '1h';
    return s ? m + 'm ' + s + 's' : m + 'm';
  }

  function fmtNumber(n, digits) {
    if (!Number.isFinite(n)) return '—';
    return n.toLocaleString('en-AU', { maximumFractionDigits: digits === undefined ? 0 : digits });
  }

  // 0.001 → "0.1%", 0.00005 → "0.005%".
  function fmtPct(fraction) {
    if (!Number.isFinite(fraction)) return '—';
    const p = fraction * 100;
    if (p === 0) return '0%';
    const digits = p >= 10 ? 1 : p >= 1 ? 2 : Math.min(6, 2 - Math.floor(Math.log10(p)));
    return clean(Number(p.toFixed(digits))) + '%';
  }

  function validTarget(t) {
    if (t === null) return 'Enter an SLO target, for example 99.9.';
    if (t <= 0 || t > 100) return 'The SLO target must be above 0 and at most 100 (%).';
    return null;
  }

  // ---------------------------------------------------------------- pieces

  function budget(target, windowDays, monthlyRequests) {
    const f = (100 - target) / 100;          // error budget as a fraction of requests / time
    const out = {
      fraction: f,
      windowSec: windowDays * DAY * f,
      periods: [
        { label: 'Per day', days: 1, sec: DAY * f },
        { label: 'Per week', days: 7, sec: 7 * DAY * f },
        { label: 'Per 30-day month', days: 30, sec: 30 * DAY * f },
        { label: 'Per quarter (90 days)', days: 90, sec: 90 * DAY * f },
        { label: 'Per year (365 days)', days: 365, sec: 365 * DAY * f },
      ],
    };
    if (monthlyRequests !== null && monthlyRequests > 0) {
      out.windowRequests = monthlyRequests * windowDays / 30;
      out.budgetRequests = out.windowRequests * f;
      out.budgetRequestsPerDay = monthlyRequests / 30 * f;
      out.periods.forEach(p => { p.requests = monthlyRequests / 30 * p.days * f; });
    }
    return out;
  }

  // Burn rate = observed error rate ÷ allowed error rate. 1× spends the budget exactly over the window.
  function burn(target, windowDays, errorRatePct) {
    if (errorRatePct === null) return null;
    if (errorRatePct < 0 || errorRatePct > 100) return { error: 'The error rate must be between 0 and 100 (%).' };
    const allowed = (100 - target) / 100, e = errorRatePct / 100;
    let rate;
    if (allowed === 0) rate = e > 0 ? Infinity : 0;
    else rate = clean(e / allowed);   // clean(): 0.1% ÷ 0.1% must be exactly 1, not 1.0000000000000568
    const exhaustSec = rate === 0 ? Infinity : rate === Infinity ? 0 : windowDays * DAY / rate;
    let status;
    if (allowed === 0) status = e > 0 ? 'over' : 'ok';
    else if (Math.abs(rate - 1) < 1e-9) status = 'even';
    else if (rate > 1) status = 'over';
    else status = 'ok';
    return { rate, exhaustSec, status };
  }

  function alertTable(target, windowDays) {
    const allowed = (100 - target) / 100;
    const windowH = windowDays * 24;
    return ALERTS.map(a => {
      const longH = Math.min(a.longH, windowH);                 // a 3-day window in a 7-day SLO is fine; never longer than the SLO window
      // The workbook's 2% / 5% / 10% are tuned for 30 days. In a 7-day window "10% in 3 days" is a 0.23× burn, which would
      // alert on a service that isn't even using its budget, so never alert below 1×.
      const burnRate = Math.max(1, (a.budget / 100) * windowH / longH);
      const errorRate = burnRate * allowed;                       // fraction of requests
      return Object.assign({}, a, {
        burn: clean(burnRate),
        errorRate: clean(errorRate),
        impossible: errorRate > 1,                                 // the alert could never fire: SLO too loose for this burn
      });
    });
  }

  // Bad events so far + days elapsed → budget used, remaining, projected end of window.
  function tracker(target, windowDays, monthlyRequests, badSoFar, totalSoFar, daysElapsed) {
    if (badSoFar === null && daysElapsed === null && totalSoFar === null) return null;
    if (badSoFar === null || daysElapsed === null) return { error: 'Enter failed requests so far and days elapsed.' };
    if (badSoFar < 0 || (totalSoFar !== null && totalSoFar < 0)) return { error: 'Request counts can\'t be negative.' };
    if (daysElapsed <= 0 || daysElapsed > windowDays) return { error: 'Days elapsed must be more than 0 and at most the ' + windowDays + '-day window.' };
    let windowTotal;
    if (totalSoFar !== null && totalSoFar > 0) {
      if (badSoFar > totalSoFar) return { error: 'Failed requests can\'t be more than total requests.' };
      windowTotal = totalSoFar / daysElapsed * windowDays;      // assume traffic keeps its current pace
    } else if (monthlyRequests !== null && monthlyRequests > 0) {
      windowTotal = monthlyRequests * windowDays / 30;
    } else {
      return { error: 'Enter total requests so far, or a monthly request volume above.' };
    }
    const allowed = (100 - target) / 100;
    const budgetReq = windowTotal * allowed;
    const perDay = badSoFar / daysElapsed;
    const projectedBad = perDay * windowDays;
    const used = budgetReq === 0 ? (badSoFar > 0 ? Infinity : 0) : badSoFar / budgetReq;
    const projected = budgetReq === 0 ? (projectedBad > 0 ? Infinity : 0) : projectedBad / budgetReq;
    const remaining = budgetReq - badSoFar;
    let status, exhaustDay = null;
    if (used >= 1) status = 'exhausted';
    else if (projected > 1) { status = 'at-risk'; exhaustDay = budgetReq / perDay; }
    else status = 'ok';
    return { budgetReq, used, projected, remaining, status, exhaustDay, windowTotal };
  }

  // ---------------------------------------------------------------- snippets

  function k6Snippet(target, latencyPct, latencyMs) {
    const allowed = clean((100 - target) / 100);
    const lines = ['export const options = {', '  thresholds: {'];
    lines.push(`    // SLO ${clean(target)}%: fail the test if more than ${fmtPct(allowed)} of requests fail`);
    if (allowed === 0) lines.push("    http_req_failed: ['rate==0'],");
    else lines.push(`    http_req_failed: ['rate<${allowed}'],`);
    if (latencyPct !== null && latencyMs !== null && latencyPct > 0 && latencyPct < 100 && latencyMs > 0) {
      lines.push(`    // Latency SLO: ${clean(latencyPct)}% of requests under ${clean(latencyMs)} ms`);
      lines.push(`    http_req_duration: ['p(${clean(latencyPct)})<${clean(latencyMs)}'],`);
    }
    lines.push('  },', '};');
    return lines.join('\n');
  }

  // Label selector helpers: join non-empty matchers into {a, b}.
  function sel(parts) {
    const p = parts.map(x => String(x || '').trim().replace(/^\{|\}$/g, '').trim()).filter(Boolean);
    return p.length ? '{' + p.join(', ') + '}' : '';
  }

  function promSnippet(target, windowDays, metric, errorFilter, extraLabels) {
    metric = String(metric || '').trim() || 'http_requests_total';
    if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(metric)) metric = 'http_requests_total';
    errorFilter = String(errorFilter === undefined || errorFilter === null ? 'code=~"5.."' : errorFilter).trim();
    const allowed = clean((100 - target) / 100);
    const all = sel([extraLabels]);
    const bad = sel([extraLabels, errorFilter]);
    const ratio = w => `sum(rate(${metric}${bad}[${w}])) / sum(rate(${metric}${all}[${w}]))`;
    const out = [
      `# Multi-window, multi-burn-rate alerts for a ${clean(target)}% SLO over ${windowDays} days.`,
      `# Error budget = ${allowed} (${fmtPct(allowed)} of requests). From the Google SRE workbook, chapter 5.`,
      'groups:',
      '  - name: slo-burn-rate',
      '    rules:',
    ];
    alertTable(target, windowDays).forEach(a => {
      const thr = clean(a.burn * allowed);
      out.push(
        `      - alert: ${a.name}`,
        `        # ${a.budget}% of the ${windowDays}-day budget spent in ${a.long} (burn rate ${a.burn}x)`,
        '        expr: |',
        '          (',
        `            ${ratio(a.long)} > ${thr}`,
        '          and',
        `            ${ratio(a.short)} > ${thr}`,
        '          )',
        `        for: ${a.for}`,
        '        labels:',
        `          severity: ${a.severity}`,
        '        annotations:',
        `          summary: "Error budget burning ${a.burn}x too fast (${a.budget}% of the ${windowDays}-day budget in ${a.long})"`,
      );
    });
    return out.join('\n');
  }

  // ---------------------------------------------------------------- everything the page needs

  function compute(input) {
    input = input || {};
    const target = num(input.target);
    const err = validTarget(target);
    if (err) return { ok: false, error: err };
    let windowDays = num(input.windowDays);
    if (windowDays === null || windowDays <= 0 || windowDays > 366) windowDays = 30;
    let monthly = num(input.monthlyRequests);
    if (monthly !== null && monthly <= 0) monthly = null;
    const warnings = [];
    if (target === 100) warnings.push('A 100% SLO leaves no error budget: every failed request breaks it, and every deploy is a risk. Most teams pick 99.9% or 99.95% for user-facing APIs.');
    else if (target < 90) warnings.push('An SLO below 90% is unusual. Check you entered a percentage (99.9), not a fraction (0.999).');
    const latencyPct = num(input.latencyPct), latencyMs = num(input.latencyMs);
    return {
      ok: true,
      target, windowDays, monthlyRequests: monthly, warnings,
      budget: budget(target, windowDays, monthly),
      burn: burn(target, windowDays, num(input.errorRatePct)),
      alerts: alertTable(target, windowDays),
      tracker: tracker(target, windowDays, monthly, num(input.badSoFar), num(input.totalSoFar), num(input.daysElapsed)),
      k6: k6Snippet(target, latencyPct, latencyMs),
      prometheus: promSnippet(target, windowDays, input.metric, input.errorFilter, input.labels),
    };
  }

  const api = { compute, budget, burn, alertTable, tracker, k6Snippet, promSnippet, fmtDuration, fmtNumber, fmtPct, num, clean, WINDOWS, PRESETS, ALERTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SloCalc = api;
})(typeof window !== 'undefined' ? window : this);
