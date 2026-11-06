/* JMeter results (JTL) analyser: pure functions, no DOM.
   Runs in the browser (window.JTL, also inside a Web Worker via importScripts) and in Node (module.exports),
   so it can be unit-tested. Nothing is uploaded: all parsing happens on the visitor's machine.

   Understands:
   - JMeter CSV results (.jtl/.csv) with a header row. Columns are found by header name, any order, any subset
     (only "elapsed" is required). Quoted fields with commas, doubled quotes and newlines are handled, also when
     they straddle chunk boundaries. Delimiter is detected (comma, tab, semicolon, pipe).
   - CSV without a header row (print_field_names=false): assumes JMeter's default column order.
   - JMeter XML results (<httpSample t= ts= lb= s= rc= .../> and <sample .../>). Only top-level samples are counted;
     nested sub-results (redirects, embedded resources, transaction children) are skipped, as JMeter's reports do.

   Percentiles are EXACT: every elapsed time is kept in typed arrays (about 25 bytes per sample, so 2 million rows
   ≈ 50 MB) and sorted per label and per time bucket. Method: nearest-rank (the value at position ceil(p/100 × n)
   in the sorted list), the same rule as JMeter's Aggregate Report. JMeter's HTML dashboard interpolates, so its
   numbers can differ slightly on small samples.
*/
(function (root) {
  'use strict';

  const DEFAULT_COLUMNS = ['timeStamp', 'elapsed', 'label', 'responseCode', 'responseMessage', 'threadName', 'dataType',
    'success', 'failureMessage', 'bytes', 'sentBytes', 'grpThreads', 'allThreads', 'URL', 'Latency', 'IdleTime', 'Connect'];

  // ---------------------------------------------------------------- small helpers

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function fmtMs(ms) {
    if (ms == null || isNaN(ms)) return 'n/a';
    if (ms >= 60000) return (ms / 60000).toFixed(1) + ' min';
    if (ms >= 10000) return (ms / 1000).toFixed(1) + ' s';
    if (ms >= 1000) return (ms / 1000).toFixed(2) + ' s';
    if (ms >= 10) return Math.round(ms) + ' ms';
    return (Math.round(ms * 10) / 10) + ' ms';
  }

  function fmtNum(n, d) {
    if (n == null || isNaN(n)) return 'n/a';
    if (d != null) return Number(n).toFixed(d);
    return Math.round(n).toLocaleString('en-AU');
  }

  function fmtPct(p) { // p is already a percentage (0..100)
    if (p == null || isNaN(p)) return 'n/a';
    if (p === 0) return '0%';
    if (p < 0.01) return '<0.01%';
    if (p < 10) return p.toFixed(2) + '%';
    return p.toFixed(1) + '%';
  }

  function fmtDuration(ms) {
    if (!(ms > 0)) return '0 s';
    const s = Math.round(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return (h ? h + ' h ' : '') + (h || m ? m + ' min ' : '') + (h ? '' : r + ' s').trim();
  }

  // Nearest-rank percentile of an ascending-sorted array (or typed array view).
  function percentileSorted(sorted, p) {
    const n = sorted.length;
    if (!n) return NaN;
    let i = Math.ceil((p / 100) * n) - 1;
    if (i < 0) i = 0; else if (i >= n) i = n - 1;
    return sorted[i];
  }

  // "1700000000123" → number; "2024/01/02 10:00:00.123" / ISO → epoch ms; otherwise NaN
  function parseTimestamp(s) {
    if (s === undefined || s === '') return NaN;
    const n = +s;
    if (!isNaN(n)) return n < 1e11 ? n * 1000 : n; // seconds → ms
    let t = Date.parse(s);
    if (!isNaN(t)) return t;
    const m = /^(\d{4})[\/-](\d\d)[\/-](\d\d)[ T](\d\d):(\d\d):(\d\d)(?:[.,](\d{1,3}))?/.exec(s);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], m[7] ? +m[7].padEnd(3, '0') : 0).getTime();
    const m2 = /^(\d\d)[\/-](\d\d)[\/-](\d{4})[ T](\d\d):(\d\d):(\d\d)(?:[.,](\d{1,3}))?/.exec(s); // dd/MM/yyyy
    if (m2) return new Date(+m2[3], +m2[2] - 1, +m2[1], +m2[4], +m2[5], +m2[6], m2[7] ? +m2[7].padEnd(3, '0') : 0).getTime();
    return NaN;
  }

  // ---------------------------------------------------------------- streaming CSV

  // Splits a CSV line that contains quotes (it may contain newlines inside quoted fields).
  function splitQuoted(line, d) {
    const out = [];
    let i = 0, field = '', inQ = false;
    const n = line.length;
    while (i < n) {
      const c = line[i];
      if (inQ) {
        if (c === '"') {
          if (line[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQ = false; i++; continue;
        }
        field += c; i++;
      } else if (c === '"') { inQ = true; i++; }
      else if (c === d) { out.push(field); field = ''; i++; }
      else { field += c; i++; }
    }
    out.push(field);
    return out;
  }

  function countQuotes(s) {
    let c = 0, i = -1;
    while ((i = s.indexOf('"', i + 1)) !== -1) c++;
    return c;
  }

  function detectDelimiter(line) {
    let best = ',', bestN = 0;
    for (const d of [',', '\t', ';', '|']) {
      const n = line.split(d).length - 1;
      if (n > bestN) { best = d; bestN = n; }
    }
    return best;
  }

  /* createCsvParser(onRecord) → { push(text), end() }
     Calls onRecord(fields[]) for each record. Lines end with \n or \r\n. A record whose quotes are unbalanced
     continues on the next line (quoted newline). */
  function createCsvParser(onRecord) {
    let buf = '';
    let d = null;
    function drain(final) {
      let pos = 0;
      const len = buf.length;
      while (pos < len) {
        let nl = buf.indexOf('\n', pos);
        if (nl === -1) { if (!final) break; nl = len; }
        let end = nl;
        let line = buf.slice(pos, end);
        if (line.indexOf('"') !== -1 && (countQuotes(line) & 1)) {
          // quoted field contains a newline: extend until the quotes balance
          let q = countQuotes(line), found = false;
          while (!found) {
            const next = buf.indexOf('\n', end + 1);
            if (next === -1) {
              if (!final) { buf = buf.slice(pos); return; }
              end = len; found = true; break;
            }
            q += countQuotes(buf.slice(end + 1, next));
            end = next;
            if (!(q & 1)) found = true;
          }
          line = buf.slice(pos, end);
          nl = end;
        }
        pos = nl + 1;
        if (line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
        if (!line) continue;
        if (d === null) d = detectDelimiter(line);
        onRecord(line.indexOf('"') === -1 ? line.split(d) : splitQuoted(line, d));
      }
      buf = pos >= len ? '' : buf.slice(pos);
    }
    return {
      push(text) { buf = buf ? buf + text : text; drain(false); },
      end() { drain(true); buf = ''; },
      get delimiter() { return d; },
    };
  }

  // ---------------------------------------------------------------- aggregator (columnar typed arrays)

  function createAggregator() {
    let cap = 1 << 16, n = 0;
    let ts = new Float64Array(cap), el = new Float64Array(cap), lab = new Uint32Array(cap);
    let ok = new Uint8Array(cap), thr = new Int32Array(cap);
    const labelIdx = new Map();
    const L = []; // per-label running sums
    const errors = new Map();
    let errorKeys = 0;
    const MAX_ERROR_KEYS = 2000;
    let hasThreads = false, hasBytes = false, hasTs = false, badRows = 0;

    function grow() {
      cap *= 2;
      const g = (A, Old) => { const a = new A(cap); a.set(Old); return a; };
      ts = g(Float64Array, ts); el = g(Float64Array, el); lab = g(Uint32Array, lab); ok = g(Uint8Array, ok); thr = g(Int32Array, thr);
    }

    function add(t, elapsed, label, success, rc, msg, bytes, sent, threads, latency, connect) {
      if (!(elapsed >= 0)) { badRows++; return; }
      if (n === cap) grow();
      let li = labelIdx.get(label);
      if (li === undefined) {
        li = L.length; labelIdx.set(label, li);
        L.push({ label, count: 0, errors: 0, sum: 0, min: Infinity, max: -Infinity, bytes: 0, sent: 0, lat: 0, latN: 0,
          con: 0, conN: 0, first: Infinity, lastEnd: -Infinity, tc: false });
      }
      const s = L[li];
      s.count++; s.sum += elapsed;
      if (elapsed < s.min) s.min = elapsed;
      if (elapsed > s.max) s.max = elapsed;
      if (bytes >= 0) { s.bytes += bytes; hasBytes = true; }
      if (sent >= 0) s.sent += sent;
      if (latency >= 0) { s.lat += latency; s.latN++; }
      if (connect >= 0) { s.con += connect; s.conN++; }
      if (t === t) { // not NaN
        hasTs = true;
        if (t < s.first) s.first = t;
        if (t + elapsed > s.lastEnd) s.lastEnd = t + elapsed;
      }
      if (!s.tc && msg && msg.charCodeAt(0) === 78 && msg.startsWith('Number of samples in transaction')) s.tc = true;
      if (!success) {
        s.errors++;
        const key = rc + '\u0000' + (msg || '');
        let e = errors.get(key);
        if (!e) {
          if (errorKeys >= MAX_ERROR_KEYS) e = errors.get('\u0001other');
          if (!e) {
            e = { rc: errorKeys >= MAX_ERROR_KEYS ? '' : rc, msg: errorKeys >= MAX_ERROR_KEYS ? '(other error messages)' : (msg || ''), count: 0, labels: new Map() };
            errors.set(errorKeys >= MAX_ERROR_KEYS ? '\u0001other' : key, e);
            errorKeys++;
          }
        }
        e.count++;
        e.labels.set(label, (e.labels.get(label) || 0) + 1);
      }
      ts[n] = t; el[n] = elapsed; lab[n] = li; ok[n] = success ? 1 : 0;
      if (threads >= 0) { thr[n] = threads; hasThreads = true; } else thr[n] = -1;
      n++;
    }

    function chooseBucket(spanMs, target) {
      const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600, 43200, 86400].map(s => s * 1000);
      for (const s of steps) if (spanMs / s <= target) return s;
      return Math.ceil(spanMs / target / 86400000) * 86400000;
    }

    // Groups el[] values by key[] (0..k-1) into one array sorted within each group. Returns {sorted, offsets}.
    function groupSort(keyOf, k) {
      const counts = new Uint32Array(k + 1);
      for (let i = 0; i < n; i++) counts[keyOf(i) + 1]++;
      for (let i = 1; i <= k; i++) counts[i] += counts[i - 1];
      const offsets = counts.slice();
      const fill = counts.slice();
      const sorted = new Float64Array(n);
      for (let i = 0; i < n; i++) sorted[fill[keyOf(i)]++] = el[i];
      for (let g = 0; g < k; g++) if (offsets[g + 1] - offsets[g] > 1) sorted.subarray(offsets[g], offsets[g + 1]).sort();
      return { sorted, offsets };
    }

    function pctsOf(view) {
      return { p50: percentileSorted(view, 50), p90: percentileSorted(view, 90), p95: percentileSorted(view, 95), p99: percentileSorted(view, 99) };
    }

    function result(opts) {
      opts = opts || {};
      const target = opts.buckets || 120;
      if (!n) return { rows: 0, badRows, labels: [], total: null, timeline: null, errors: [], slowest: [], hasThreads, hasBytes, hasTs };

      // per label
      const k = L.length;
      const g = groupSort(i => lab[i], k);
      let first = Infinity, lastEnd = -Infinity;
      for (const s of L) { if (s.first < first) first = s.first; if (s.lastEnd > lastEnd) lastEnd = s.lastEnd; }
      const spanAll = hasTs ? Math.max(lastEnd - first, 1) : NaN;
      const labels = L.map((s, li) => {
        const view = g.sorted.subarray(g.offsets[li], g.offsets[li + 1]);
        const span = hasTs ? Math.max(s.lastEnd - s.first, 1) : NaN;
        return Object.assign({
          label: s.label, count: s.count, errors: s.errors, errPct: s.count ? (s.errors / s.count) * 100 : 0,
          avg: s.sum / s.count, min: s.min, max: s.max,
          tput: hasTs ? s.count / (span / 1000) : NaN,
          recvKBs: hasTs && hasBytes ? s.bytes / 1024 / (span / 1000) : NaN,
          sentKBs: hasTs && hasBytes ? s.sent / 1024 / (span / 1000) : NaN,
          avgLatency: s.latN ? s.lat / s.latN : NaN, avgConnect: s.conN ? s.con / s.conN : NaN,
          transactionController: s.tc,
        }, pctsOf(view));
      });

      // total
      const all = el.slice(0, n).sort();
      let sum = 0, errs = 0, bytes = 0, sent = 0;
      for (const s of L) { sum += s.sum; errs += s.errors; bytes += s.bytes; sent += s.sent; }
      const total = Object.assign({
        label: 'TOTAL', count: n, errors: errs, errPct: (errs / n) * 100, avg: sum / n, min: all[0], max: all[n - 1],
        tput: hasTs ? n / (spanAll / 1000) : NaN,
        recvKBs: hasTs && hasBytes ? bytes / 1024 / (spanAll / 1000) : NaN,
        sentKBs: hasTs && hasBytes ? sent / 1024 / (spanAll / 1000) : NaN,
      }, pctsOf(all));

      // timeline (by sample timestamp)
      let timeline = null;
      if (hasTs) {
        let t0 = Infinity, t1 = -Infinity;
        for (let i = 0; i < n; i++) { const t = ts[i]; if (t === t) { if (t < t0) t0 = t; if (t > t1) t1 = t; } }
        const bucketMs = chooseBucket(Math.max(t1 - t0, 1000), target);
        const start = Math.floor(t0 / bucketMs) * bucketMs;
        const B = Math.floor((t1 - start) / bucketMs) + 1;
        const bOf = i => { const t = ts[i]; return t === t ? Math.floor((t - start) / bucketMs) : 0; };
        const gb = groupSort(bOf, B);
        const errB = new Uint32Array(B), thrB = new Int32Array(B).fill(-1), sumB = new Float64Array(B);
        for (let i = 0; i < n; i++) {
          const b = bOf(i);
          if (!ok[i]) errB[b]++;
          if (thr[i] > thrB[b]) thrB[b] = thr[i];
          sumB[b] += el[i];
        }
        const points = [];
        for (let b = 0; b < B; b++) {
          const c = gb.offsets[b + 1] - gb.offsets[b];
          const view = gb.sorted.subarray(gb.offsets[b], gb.offsets[b + 1]);
          // first and last buckets are usually partly outside the test: divide by the part that was covered
          const bs = start + b * bucketMs, covered = Math.min(bs + bucketMs, t1 + 1) - Math.max(bs, t0);
          const secs = Math.max(1000, Math.min(covered, bucketMs)) / 1000;
          points.push(Object.assign({ t: bs, count: c, errors: errB[b], tput: c / secs,
            avg: c ? sumB[b] / c : NaN, threads: thrB[b] }, c ? pctsOf(view) : { p50: NaN, p90: NaN, p95: NaN, p99: NaN }));
        }
        timeline = { start, bucketMs, points };
      }

      // top errors
      const errorList = [...errors.values()].sort((a, b) => b.count - a.count).slice(0, opts.maxErrors || 25).map(e => ({
        rc: e.rc, msg: e.msg, count: e.count, pctOfErrors: errs ? (e.count / errs) * 100 : 0, pctOfAll: (e.count / n) * 100,
        labels: [...e.labels.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([label, count]) => ({ label, count })),
      }));

      // slowest individual samples
      const topN = opts.slowest || 10;
      const top = [];
      let floor = -Infinity;
      for (let i = 0; i < n; i++) {
        if (el[i] <= floor && top.length >= topN) continue;
        top.push(i);
        if (top.length > topN * 4) { top.sort((a, b) => el[b] - el[a]); top.length = topN; floor = el[top[topN - 1]]; }
      }
      top.sort((a, b) => el[b] - el[a]);
      const slowest = top.slice(0, topN).map(i => ({ t: ts[i], elapsed: el[i], label: L[lab[i]].label, success: !!ok[i] }));

      return { rows: n, badRows, start: hasTs ? first : NaN, end: hasTs ? lastEnd : NaN, durationMs: spanAll,
        labels, total, timeline, errors: errorList, slowest, hasThreads, hasBytes, hasTs,
        method: 'exact, nearest-rank' };
    }

    return { add, result, get rows() { return n; } };
  }

  // ---------------------------------------------------------------- CSV rows → samples

  function headerIndex(fields) {
    const map = {};
    const known = {};
    for (const c of DEFAULT_COLUMNS) known[c.toLowerCase()] = c;
    known.timestamp = 'timeStamp'; known['time stamp'] = 'timeStamp'; known.sentbytes = 'sentBytes';
    known.responsecode = 'responseCode'; known.responsemessage = 'responseMessage'; known.failuremessage = 'failureMessage';
    known.allthreads = 'allThreads'; known.grpthreads = 'grpThreads'; known.threadname = 'threadName'; known.url = 'URL';
    let hits = 0;
    fields.forEach((f, i) => {
      const k = known[String(f).trim().replace(/^﻿/, '').toLowerCase()];
      if (k && map[k] === undefined) { map[k] = i; hits++; }
    });
    return hits >= 2 && map.elapsed !== undefined ? map : null;
  }

  function createCsvRowHandler(agg, warn) {
    let col = null;
    let rowNo = 0;
    return function (f) {
      rowNo++;
      if (col === null) {
        const h = headerIndex(f);
        if (h) { col = h; return; }
        // no header: JMeter's default order if the first field looks like a timestamp and the second like a number
        if (/^\d{10,13}$/.test(String(f[0]).replace(/^﻿/, '')) && /^\d+$/.test(f[1])) {
          col = {}; DEFAULT_COLUMNS.forEach((c, i) => { col[c] = i; });
          warn('No header row found, so the columns were read in JMeter\'s default order (timeStamp, elapsed, label, …).');
        } else {
          throw new Error("This doesn't look like a JMeter results file: no header row with an \"elapsed\" column was found, and the first row isn't in JMeter's default column order.");
        }
      }
      const get = c => (col[c] !== undefined ? f[col[c]] : undefined);
      const elapsed = +get('elapsed');
      const succ = get('success');
      const rc = get('responseCode') || '';
      let success;
      if (succ !== undefined && succ !== '') success = succ === 'true' || succ === 'TRUE' || succ === 'True';
      else success = /^[23]\d\d$/.test(rc) || rc === '';
      const fm = get('failureMessage');
      const msg = !success && fm ? fm : (get('responseMessage') || '');
      const num = v => (v === undefined || v === '' ? -1 : +v);
      const threads = col.allThreads !== undefined ? num(get('allThreads')) : num(get('grpThreads'));
      agg.add(parseTimestamp(get('timeStamp')), elapsed, get('label') || '(no label)', success, rc, msg,
        num(get('bytes')), num(get('sentBytes')), threads, num(get('Latency')), num(get('Connect')));
    };
  }

  // ---------------------------------------------------------------- XML JTL

  function unescapeXml(s) {
    if (s.indexOf('&') === -1) return s;
    return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e) => {
      if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1));
      return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e];
    });
  }

  function parseAttrs(s) {
    const out = {};
    const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = re.exec(s))) out[m[1]] = unescapeXml(m[3] !== undefined ? m[3] : m[4]);
    return out;
  }

  function createXmlParser(agg) {
    let buf = '';
    let depth = 0;
    let cur = null;      // attrs of the open top-level sample
    let curStart = -1;   // where the open top-level sample's content starts in buf
    let curOpen = -1;    // where its opening tag starts
    const TAG = /<(\/?)(httpSample|sample)\b([^>]*?)(\/?)>/g;

    function emit(a, inner) {
      let fm = '';
      if (inner) {
        const re = /<failureMessage>([^<]*)<\/failureMessage>/g;
        let m;
        while ((m = re.exec(inner))) { if (m[1].trim()) { fm = unescapeXml(m[1]); break; } }
      }
      const success = a.s === 'true';
      const num = v => (v === undefined || v === '' ? -1 : +v);
      agg.add(parseTimestamp(a.ts), +a.t, a.lb || '(no label)', success, a.rc || '', !success && fm ? fm : (a.rm || ''),
        num(a.by), num(a.sby), a.na !== undefined ? num(a.na) : num(a.ng), num(a.lt), num(a.ct));
    }

    function drain(final) {
      TAG.lastIndex = 0;
      let m, keepFrom = -1;
      while ((m = TAG.exec(buf))) {
        const closing = m[1] === '/', selfClose = m[4] === '/';
        if (closing) {
          depth--;
          if (depth === 0 && cur) { emit(cur, buf.slice(curStart, m.index)); cur = null; curStart = -1; }
          if (depth < 0) depth = 0;
        } else if (selfClose) {
          if (depth === 0) emit(parseAttrs(m[3]), '');
        } else {
          if (depth === 0) { cur = parseAttrs(m[3]); curStart = TAG.lastIndex; curOpen = m.index; }
          depth++;
        }
        keepFrom = TAG.lastIndex;
      }
      if (final) { buf = ''; return; }
      // keep the unfinished top-level element (if any), otherwise the tail after the last complete tag
      let from = keepFrom === -1 ? 0 : keepFrom;
      const lt = buf.lastIndexOf('<');
      if (lt >= from) from = lt; // a tag may be cut in half
      else from = buf.length;
      if (cur) {
        // re-scan from the open element next time: rewind state
        buf = buf.slice(curOpen);
        depth = 0; cur = null; curStart = -1;
        return;
      }
      buf = buf.slice(from);
    }

    return {
      push(text) { buf += text; drain(false); },
      end() { drain(true); },
    };
  }

  // ---------------------------------------------------------------- entry points

  /* createAnalyser() → { push(text), end(), result(opts), warnings, format }
     Feed the file text in chunks of any size. */
  function createAnalyser() {
    const agg = createAggregator();
    const warnings = [];
    const warn = w => { if (!warnings.includes(w)) warnings.push(w); };
    let parser = null, format = null, head = '';
    function start(text) {
      head += text;
      const t = head.replace(/^﻿/, '').trimStart();
      if (!t) return false;
      if (t[0] === '<') { format = 'JMeter XML'; parser = createXmlParser(agg); }
      else { format = 'JMeter CSV'; parser = createCsvParser(createCsvRowHandler(agg, warn)); }
      parser.push(head); head = '';
      return true;
    }
    return {
      push(text) { if (parser) parser.push(text); else start(text); },
      end() { if (!parser && head) start(''); if (parser) parser.end(); },
      result(opts) {
        const r = agg.result(opts);
        if (!r.rows) throw new Error(format === 'JMeter XML' ? 'No <httpSample> or <sample> elements were found in this XML.' : 'No result rows were found in this file.');
        if (!r.hasTs) warn('No usable timeStamp column, so throughput and charts over time are not available.');
        if (r.badRows) warn(r.badRows.toLocaleString('en-AU') + ' rows had no valid elapsed time and were skipped.');
        if (r.labels.some(l => l.transactionController)) warn('Transaction Controller samples are included as their own rows and in TOTAL (as JMeter does), so TOTAL counts those requests twice.');
        r.format = format; r.warnings = warnings.slice();
        return r;
      },
      get rows() { return agg.rows; },
      get format() { return format; },
      warnings,
    };
  }

  function analyseText(text, opts) {
    const a = createAnalyser();
    const step = (opts && opts.chunk) || text.length || 1;
    for (let i = 0; i < text.length; i += step) a.push(text.slice(i, i + step));
    a.end();
    return a.result(opts);
  }


  // ---------------------------------------------------------------- browser: read a File in chunks

  const CHUNK = 4 * 1024 * 1024;

  async function analyseFile(file, opts, progress) {
    progress = progress || function () {};
    const a = createAnalyser();
    if (/\.gz$/i.test(file.name || '')) {
      if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot unzip .gz files. Unzip it first, then choose the .jtl file.');
      const reader = file.stream().pipeThrough(new DecompressionStream('gzip')).pipeThrough(new TextDecoderStream()).getReader();
      let pending = '', last = 0, read = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += value; read += value.length;
        if (pending.length >= CHUNK) { a.push(pending); pending = ''; }
        if (read - last > CHUNK) { last = read; progress(NaN, a.rows); }
      }
      if (pending) a.push(pending);
    } else {
      const dec = new TextDecoder('utf-8');
      for (let off = 0; off < file.size; off += CHUNK) {
        const buf = await file.slice(off, off + CHUNK).arrayBuffer();
        a.push(dec.decode(buf, { stream: off + CHUNK < file.size }));
        progress(Math.min(off + CHUNK, file.size), a.rows);
      }
      a.push(dec.decode());
    }
    a.end();
    return a.result(opts);
  }

  /* analyse(file, opts, onProgress) → Promise<result>. Uses a Web Worker so the page stays responsive;
     falls back to the main thread (still chunked) if workers are unavailable. */
  function analyse(file, opts, onProgress) {
    onProgress = onProgress || function () {};
    let w = null;
    try { w = new Worker('/tools/jtl-analyser/worker.js'); } catch (e) { w = null; }
    if (!w) return analyseFile(file, opts, onProgress);
    return new Promise((resolve, reject) => {
      let settled = false;
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'progress') onProgress(m.done, m.rows, file.size);
        else { settled = true; w.terminate(); m.type === 'done' ? resolve(m.result) : reject(new Error(m.message)); }
      };
      w.onerror = (e) => {
        if (settled) return;
        settled = true; w.terminate();
        e.preventDefault && e.preventDefault();
        analyseFile(file, opts, onProgress).then(resolve, reject); // worker failed to load: do it here
      };
      w.postMessage({ file, opts });
    });
  }

  // ---------------------------------------------------------------- exports

  const COLS = [
    ['label', 'Label'], ['count', 'Samples'], ['errPct', 'Error %'], ['avg', 'Avg ms'], ['p50', 'p50 ms'], ['p90', 'p90 ms'],
    ['p95', 'p95 ms'], ['p99', 'p99 ms'], ['min', 'Min ms'], ['max', 'Max ms'], ['tput', 'Throughput/s'], ['recvKBs', 'Received KB/s'], ['sentKBs', 'Sent KB/s'],
  ];

  function csvCell(v) {
    const s = String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function round(v, d) { return v == null || isNaN(v) ? '' : +Number(v).toFixed(d); }

  function toSummaryCsv(r) {
    const rows = [COLS.map(c => c[1]).join(',')];
    for (const l of r.labels.concat([r.total])) {
      rows.push(COLS.map(([k]) => (k === 'label' ? csvCell(l.label) : k === 'count' ? l.count :
        round(l[k], k === 'errPct' || k === 'tput' || k === 'recvKBs' || k === 'sentKBs' ? 2 : 1))).join(','));
    }
    return rows.join('\n') + '\n';
  }

  function mdCell(s) { return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' '); }

  function toMarkdown(r, opts) {
    opts = opts || {};
    const out = [];
    out.push('**Load test summary** (' + (opts.fileName ? mdCell(opts.fileName) + ', ' : '') + r.rows.toLocaleString('en-AU') + ' samples' +
      (r.hasTs ? ', ' + fmtDuration(r.durationMs) : '') + ')');
    out.push('');
    out.push('| Transaction | Samples | Error % | Avg | p50 | p90 | p95 | p99 | Max | Req/s |');
    out.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
    const sla = opts.slaMs;
    for (const l of r.labels.concat([r.total])) {
      const name = l === r.total ? '**TOTAL**' : mdCell(l.label);
      const p95 = fmtMs(l.p95) + (sla && l !== r.total && l.p95 > sla ? ' ⚠️' : '');
      out.push(`| ${name} | ${fmtNum(l.count)} | ${fmtPct(l.errPct)} | ${fmtMs(l.avg)} | ${fmtMs(l.p50)} | ${fmtMs(l.p90)} | ${p95} | ${fmtMs(l.p99)} | ${fmtMs(l.max)} | ${isNaN(l.tput) ? 'n/a' : l.tput.toFixed(2)} |`);
    }
    if (r.errors.length) {
      out.push('');
      out.push('**Top errors**');
      out.push('');
      for (const e of r.errors.slice(0, 5)) out.push(`- ${fmtNum(e.count)} × \`${mdCell(e.rc || '—')}\` ${mdCell(e.msg || '').slice(0, 160)}`);
    }
    if (sla) { out.push(''); out.push(`⚠️ = p95 above ${fmtMs(sla)}.`); }
    out.push('');
    out.push('_Percentiles: exact, nearest-rank. Analysed in the browser with pawansinha.com.au/tools/jtl-analyser/_');
    return out.join('\n');
  }

  // ---------------------------------------------------------------- sample file

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* generateSample({rows, seed, start, durationMs}) → JMeter CSV text with the default columns.
     A 10-minute ramp to 50 users on a small shop: checkout slows down and throws errors in the middle of the run. */
  function generateSample(o) {
    o = o || {};
    const rows = o.rows || 20000, rnd = mulberry32(o.seed || 42);
    const start = o.start || Date.UTC(2026, 10, 3, 1, 0, 0);
    const dur = o.durationMs || 600000;
    const pages = [
      { label: '01 Home page', base: 120, url: 'https://shop.example.com/', bytes: 48000 },
      { label: '02 Login', base: 220, url: 'https://shop.example.com/api/login', bytes: 1200 },
      { label: '03 Search products', base: 340, url: 'https://shop.example.com/api/search?q=shoes', bytes: 22000 },
      { label: '04 Add to cart', base: 180, url: 'https://shop.example.com/api/cart', bytes: 900 },
      { label: '05 Checkout', base: 650, url: 'https://shop.example.com/api/checkout', bytes: 3100 },
    ];
    const lines = [DEFAULT_COLUMNS.join(',')];
    const users = 50;
    for (let i = 0; i < rows; i++) {
      const frac = i / rows;
      const t = Math.round(start + frac * dur + rnd() * 400);
      const active = Math.max(1, Math.min(users, Math.ceil(users * Math.min(1, frac / 0.3))));
      const p = pages[i % pages.length];
      const stress = frac > 0.55 && frac < 0.75 ? 1 : 0;
      // log-normal-ish response time with a long tail
      let ms = p.base * Math.exp((rnd() + rnd() + rnd() - 1.5) * 0.6) * (1 + active / 120);
      if (stress && p.label === '05 Checkout') ms *= 2.6 + rnd() * 2;
      if (rnd() < 0.004) ms *= 6;
      ms = Math.round(ms);
      let rc = '200', rm = 'OK', success = 'true', fm = '';
      const r = rnd();
      if (stress && p.label === '05 Checkout' && r < 0.09) { rc = '503'; rm = 'Service Unavailable'; success = 'false'; fm = 'Response code was 503, expected 200'; }
      else if (p.label === '02 Login' && r < 0.006) { rc = '401'; rm = 'Unauthorized'; success = 'false'; fm = 'Test failed: text expected to contain /"token"/'; }
      else if (r < 0.0015) {
        rc = 'Non HTTP response code: java.net.SocketTimeoutException'; rm = 'Non HTTP response message: Read timed out';
        success = 'false'; ms = 30000 + Math.round(rnd() * 50); fm = '';
      }
      const thread = 'Shoppers 1-' + (1 + (i % active));
      const by = success === 'true' ? Math.round(p.bytes * (0.9 + rnd() * 0.2)) : 412;
      lines.push([t, ms, p.label, csvCell(rc), csvCell(rm), thread, 'text', success, csvCell(fm), by, 380, active, active,
        p.url, Math.max(1, Math.round(ms * 0.82)), 0, rnd() < 0.05 ? Math.round(20 + rnd() * 40) : 0].join(','));
    }
    return lines.join('\n') + '\n';
  }

  const api = {
    DEFAULT_COLUMNS, analyse, analyseFile, createCsvParser, splitQuoted, createAggregator, createAnalyser, analyseText, parseTimestamp,
    percentileSorted, toSummaryCsv, toMarkdown, generateSample, fmtMs, fmtNum, fmtPct, fmtDuration, esc, csvCell,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.JTL = api;
})(typeof self !== 'undefined' ? self : this);
