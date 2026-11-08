/* Distributed Trace Explainer: pure functions, no DOM. Runs in the browser (window.TraceExplainer), in the Web Worker
   (worker.js) and in Node (module.exports) for toolkit-tests/trace-explainer.test.js. Nothing is sent anywhere.

   parse(text)                 Jaeger JSON (UI export or API data[]), Zipkin v2 JSON, OpenTelemetry OTLP JSON (also Tempo
                               "batches" and newline-delimited files) → { format, spans, warnings }
   groupTraces(spans)          → [{ id, spans }] sorted by start time
   analyseTrace(spans, opts)   one trace: tree, clock skew adjustment, self/child time, critical path, gaps, N+1,
                               sequential calls, fan-out, retries, errors, per-service totals, summary and fixes
   analyseMany(traces, opts)   many traces: per-service and per-operation percentiles, critical-path services,
                               dependency graph, outlier traces and what made them slow
   samples                     synthetic traces in each format (sampleJaeger, sampleZipkin, sampleOtlp, sampleMany)
   toMarkdown(single, many)    summary that pastes into Jira, GitHub or Slack

   Times are microseconds (µs) internally. */
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ small helpers
  const isNum = x => typeof x === 'number' && isFinite(x);
  const num = x => { const n = Number(x); return isFinite(n) ? n : 0; };
  function nanoToMicro(v) {
    if (v == null || v === '') return 0;
    if (typeof v === 'number') return v / 1000;
    const s = String(v).trim();
    if (!/^\d+$/.test(s)) return num(s) / 1000;
    if (s.length <= 3) return Number(s) / 1000;
    return Number(s.slice(0, -3)) + Number(s.slice(-3)) / 1000; // keeps µs precision for 19-digit nanosecond strings
  }
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function b64ToHex(s) {
    s = String(s).replace(/[\s=]/g, '').replace(/-/g, '+').replace(/_/g, '/');
    let bits = 0, val = 0, out = '';
    for (let i = 0; i < s.length; i++) {
      const k = B64.indexOf(s[i]);
      if (k < 0) return '';
      val = (val << 6) | k; bits += 6;
      if (bits >= 8) { bits -= 8; out += ((val >> bits) & 255).toString(16).padStart(2, '0'); }
    }
    return out;
  }
  // OTLP JSON should use hex ids, but protobuf-to-JSON converters often emit base64. Zipkin and Jaeger use hex.
  function normId(v) {
    if (v == null) return '';
    let s = String(v).trim();
    if (!s) return '';
    if (/^[0-9a-f]+$/i.test(s) && s.length !== 12 && s.length !== 24) return s.toLowerCase().padStart(16, '0');
    if (/^[A-Za-z0-9+/_-]+=*$/.test(s) && (s.length === 12 || s.length === 24 || /=$/.test(s))) { const h = b64ToHex(s); if (h && /[1-9a-f]/.test(h)) return h.padStart(16, '0'); if (h) return ''; }
    if (/^[0-9a-f]+$/i.test(s)) return s.toLowerCase().padStart(16, '0');
    return s;
  }
  function fmtDur(us) {
    if (!isNum(us)) return '—';
    const a = Math.abs(us);
    if (a < 1000) return (a < 10 ? us.toFixed(1) : Math.round(us)) + ' µs';
    if (a < 1e6) { const m = us / 1000; return (Math.abs(m) < 10 ? m.toFixed(2) : Math.abs(m) < 100 ? m.toFixed(1) : Math.round(m)) + ' ms'; }
    return (us / 1e6).toFixed(2) + ' s';
  }
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);
  function pctl(sorted, p) {
    if (!sorted.length) return 0;
    const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[i];
  }
  const sortNum = a => a.sort((x, y) => x - y);
  const median = a => pctl(sortNum(a.slice()), 50);
  function normOp(s) {
    return String(s || '')
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '{id}')
      .replace(/'[^']*'/g, '?').replace(/\b\d+(\.\d+)?\b/g, '?')
      .replace(/\b[0-9a-f]{16,}\b/gi, '{id}')
      .replace(/\s+/g, ' ').trim();
  }
  const short = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  function plural(n, w, ws) { return n + ' ' + (n === 1 ? w : (ws || w + 's')); }

  // ------------------------------------------------------------------ attribute helpers
  function otlpValue(v) {
    if (v == null || typeof v !== 'object') return v;
    if ('stringValue' in v) return v.stringValue;
    if ('intValue' in v) return num(v.intValue);
    if ('doubleValue' in v) return num(v.doubleValue);
    if ('boolValue' in v) return !!v.boolValue;
    if ('arrayValue' in v) return ((v.arrayValue && v.arrayValue.values) || []).map(otlpValue);
    if ('kvlistValue' in v) return otlpAttrs((v.kvlistValue && v.kvlistValue.values) || []);
    if ('bytesValue' in v) return v.bytesValue;
    return '';
  }
  function otlpAttrs(list) { const o = {}; (list || []).forEach(a => { if (a && a.key != null) o[a.key] = otlpValue(a.value); }); return o; }
  function jaegerTags(list) { const o = {}; (list || []).forEach(t => { if (t && t.key != null) o[t.key] = t.value; }); return o; }
  const truthy = v => v === true || v === 'true' || v === 1 || v === '1';
  function httpStatus(a) { const v = a['http.status_code'] != null ? a['http.status_code'] : a['http.response.status_code']; const n = Number(v); return isFinite(n) && n > 0 ? n : null; }
  function errorFromAttrs(a) {
    const st = httpStatus(a);
    const err = truthy(a.error) || a['otel.status_code'] === 'ERROR' || (st != null && st >= 500);
    const msg = a['error.message'] || a['exception.message'] || a['otel.status_description'] || (typeof a.error === 'string' && a.error !== 'true' && a.error !== '' ? a.error : '') || (st >= 500 ? 'HTTP ' + st : '');
    return { err, msg: String(msg || ''), status: st };
  }
  const KIND = { 1: 'internal', 2: 'server', 3: 'client', 4: 'producer', 5: 'consumer' };
  function normKind(k) {
    if (k == null || k === '') return '';
    if (typeof k === 'number') return KIND[k] || '';
    const s = String(k).toLowerCase().replace(/^span_kind_/, '');
    return s === 'unspecified' ? '' : s;
  }

  // ------------------------------------------------------------------ parsers
  function jaegerTrace(t, out) {
    const procs = t.processes || {};
    (t.spans || []).forEach(s => {
      const a = jaegerTags(s.tags);
      const proc = (s.processID && procs[s.processID]) || s.process || {};
      const refs = s.references || [];
      let parent = '', follows = false;
      const r = refs.find(x => (x.refType || '').toUpperCase() === 'CHILD_OF') || refs.find(x => (x.refType || '').toUpperCase() === 'FOLLOWS_FROM');
      if (r) { parent = normId(r.spanID); follows = (r.refType || '').toUpperCase() === 'FOLLOWS_FROM'; }
      else if (s.parentSpanID && s.parentSpanID !== '0') parent = normId(s.parentSpanID);
      const e = errorFromAttrs(a);
      const events = [];
      (s.logs || []).forEach(l => {
        const f = jaegerTags(l.fields);
        events.push({ t: num(l.timestamp), name: String(f.event || f.message || 'log'), attrs: f });
        if (f.event === 'error' || f['error.object'] || f['exception.message'] || f['error.kind']) {
          e.err = e.err || f.event === 'error';
          if (!e.msg || /^HTTP \d+$/.test(e.msg)) e.msg = String(f['exception.message'] || f.message || f['error.object'] || f['error.kind'] || e.msg || '');
        }
      });
      out.push({
        traceId: normId(s.traceID || t.traceID), id: normId(s.spanID), parent, follows,
        service: String(proc.serviceName || 'unknown'), op: String(s.operationName || ''),
        start: num(s.startTime), dur: Math.max(0, num(s.duration)), kind: normKind(a['span.kind']),
        error: e.err, msg: e.msg, status: e.status, attrs: a, events,
      });
    });
  }
  function parseJaeger(o, out) {
    if (Array.isArray(o)) o.forEach(t => jaegerTrace(t, out));
    else if (Array.isArray(o.data)) o.data.forEach(t => jaegerTrace(t, out));
    else jaegerTrace(o, out);
  }
  function parseZipkin(arr, out) {
    const flat = [];
    (function walk(a) { a.forEach(x => (Array.isArray(x) ? walk(x) : x && flat.push(x))); })(arr);
    // shared spans: a CLIENT and a SERVER half with the same id. Give the server half its own id under the client.
    const seen = {};
    flat.forEach(s => { const k = normId(s.traceId) + '/' + normId(s.id); (seen[k] = seen[k] || []).push(s); });
    const remap = {};
    Object.keys(seen).forEach(k => {
      const g = seen[k]; if (g.length < 2) return;
      const srv = g.find(s => (s.kind || '').toUpperCase() === 'SERVER' || s.shared) || g[1];
      const cli = g.find(s => s !== srv) || g[0];
      srv.__id = normId(srv.id) + '-s'; srv.__parent = normId(cli.id);
      remap[k] = { service: (srv.localEndpoint && srv.localEndpoint.serviceName) || '', id: srv.__id };
    });
    flat.forEach(s => {
      const a = Object.assign({}, s.tags || {});
      const kind = normKind(s.kind);
      const e = errorFromAttrs(a);
      if (a.error != null && a.error !== 'false' && a.error !== false) { e.err = true; if (!e.msg && a.error !== '' && a.error !== 'true') e.msg = String(a.error); }
      const service = String((s.localEndpoint && s.localEndpoint.serviceName) || 'unknown');
      let parent = s.__parent || normId(s.parentId);
      const rm = remap[normId(s.traceId) + '/' + parent];
      if (!s.__parent && rm && rm.service === service) parent = rm.id;
      if (s.remoteEndpoint && s.remoteEndpoint.serviceName) a['peer.service'] = a['peer.service'] || s.remoteEndpoint.serviceName;
      out.push({
        traceId: normId(s.traceId), id: s.__id || normId(s.id), parent, follows: false, service, op: String(s.name || ''),
        start: num(s.timestamp), dur: Math.max(0, num(s.duration)), kind, error: e.err, msg: e.msg, status: e.status, attrs: a,
        events: (s.annotations || []).map(x => ({ t: num(x.timestamp), name: String(x.value || ''), attrs: {} })),
      });
    });
  }
  function parseOtlp(o, out) {
    const rs = o.resourceSpans || o.batches || [];
    rs.forEach(r => {
      const ra = otlpAttrs(r.resource && r.resource.attributes);
      const service = String(ra['service.name'] || 'unknown');
      (r.scopeSpans || r.instrumentationLibrarySpans || []).forEach(ss => {
        (ss.spans || []).forEach(s => {
          const a = otlpAttrs(s.attributes);
          const start = nanoToMicro(s.startTimeUnixNano), end = nanoToMicro(s.endTimeUnixNano);
          const st = s.status || {};
          const code = st.code;
          const e = errorFromAttrs(a);
          const isErr = code === 2 || code === 'STATUS_CODE_ERROR' || code === 'ERROR';
          if (code === 1 || code === 'STATUS_CODE_OK') e.err = false;
          if (isErr) e.err = true;
          if (st.message) e.msg = String(st.message);
          const events = (s.events || []).map(ev => {
            const ea = otlpAttrs(ev.attributes);
            if (ev.name === 'exception' && !e.msg) e.msg = String((ea['exception.type'] ? ea['exception.type'] + ': ' : '') + (ea['exception.message'] || ''));
            return { t: nanoToMicro(ev.timeUnixNano), name: String(ev.name || ''), attrs: ea };
          });
          if (ra['host.name'] && !a['host.name']) a['host.name'] = ra['host.name'];
          out.push({
            traceId: normId(s.traceId), id: normId(s.spanId), parent: normId(s.parentSpanId), follows: false, service, op: String(s.name || ''),
            start, dur: Math.max(0, end - start), kind: normKind(s.kind), error: e.err, msg: e.msg, status: e.status, attrs: a, events,
          });
        });
      });
    });
  }
  function detectFormat(o) {
    if (Array.isArray(o)) {
      const f = o.find(x => x && typeof x === 'object');
      if (!f) return '';
      if (Array.isArray(f)) return detectFormat(f);
      if (f.spans && (f.traceID || f.processes)) return 'jaeger';
      if (f.resourceSpans || f.batches) return 'otlp-list';
      if (f.traceId && (f.timestamp != null || f.localEndpoint || f.duration != null)) return 'zipkin';
      if (f.traceID && f.spanID) return 'jaeger-spans';
      return '';
    }
    if (!o || typeof o !== 'object') return '';
    if (o.resourceSpans || o.batches) return 'otlp';
    if (Array.isArray(o.data) && o.data.some(t => t && t.spans)) return 'jaeger';
    if (o.spans && (o.traceID || o.processes)) return 'jaeger';
    if (o.traceId && o.id && (o.timestamp != null || o.localEndpoint)) return 'zipkin';
    return '';
  }
  const FORMAT_LABEL = { jaeger: 'Jaeger JSON', zipkin: 'Zipkin v2 JSON', otlp: 'OpenTelemetry OTLP JSON', mixed: 'Mixed formats' };
  function parseObject(o, out) {
    const f = detectFormat(o);
    if (f === 'jaeger') { parseJaeger(o, out); return 'jaeger'; }
    if (f === 'jaeger-spans') { jaegerTrace({ spans: o }, out); return 'jaeger'; }
    if (f === 'zipkin') { parseZipkin(Array.isArray(o) ? o : [o], out); return 'zipkin'; }
    if (f === 'otlp') { parseOtlp(o, out); return 'otlp'; }
    if (f === 'otlp-list') { o.forEach(x => parseOtlp(x, out)); return 'otlp'; }
    return '';
  }
  function parse(text) {
    const out = [], warnings = [], formats = {};
    const s = String(text || '').trim();
    if (!s) return { format: '', formatLabel: '', spans: out, warnings: ['Nothing to read.'] };
    let docs = null;
    try { docs = [JSON.parse(s)]; } catch (e) {
      // newline-delimited JSON (OTLP file exporter, one trace per line) or several documents pasted together
      docs = []; let bad = 0;
      s.split(/\r?\n/).forEach(l => { l = l.trim(); if (!l) return; try { docs.push(JSON.parse(l)); } catch (e2) { bad++; } });
      if (!docs.length) throw new Error('This is not valid JSON (' + e.message + '). Export the trace as JSON from Jaeger, Zipkin, Tempo or your OpenTelemetry collector.');
      if (bad) warnings.push(bad + ' line' + (bad === 1 ? '' : 's') + ' could not be read as JSON and were skipped.');
    }
    docs.forEach(d => { const f = parseObject(d, out); if (f) formats[f] = 1; else warnings.push('One JSON document was not recognised as Jaeger, Zipkin or OTLP and was skipped.'); });
    const fk = Object.keys(formats);
    if (!out.length && !fk.length) throw new Error('No spans found. Expected Jaeger JSON ({"data":[{"spans":…}]}), a Zipkin v2 array of spans, or OTLP JSON ({"resourceSpans":…}).');
    const format = fk.length > 1 ? 'mixed' : fk[0] || '';
    return { format, formatLabel: FORMAT_LABEL[format] || 'Unknown', spans: out, warnings };
  }
  function groupTraces(spans) {
    const m = new Map();
    spans.forEach(s => { const k = s.traceId || 'trace'; let g = m.get(k); if (!g) m.set(k, g = []); g.push(s); });
    const out = [];
    m.forEach((v, k) => { let st = Infinity; v.forEach(s => { if (s.start < st) st = s.start; }); out.push({ id: k, spans: v, start: st }); });
    out.sort((a, b) => a.start - b.start);
    return out;
  }

  // ------------------------------------------------------------------ single trace
  const isDbSpan = s => !!(s.attrs && (s.attrs['db.system'] || s.attrs['db.statement'] || s.attrs['db.query.text'] || s.attrs['db.operation'])) ||
    /^(select|insert|update|delete|with)\b/i.test(s.op) || s.kind === 'client' && /\b(sql|query|redis|mongo|cassandra|dynamo)\b/i.test(s.op);
  const callKey = s => s.service + '|' + normOp((s.attrs && (s.attrs['db.statement'] || s.attrs['db.query.text'])) || s.op);
  function unionLen(iv) {
    if (!iv.length) return 0;
    iv.sort((a, b) => a[0] - b[0]);
    let tot = 0, cs = iv[0][0], ce = iv[0][1];
    for (let i = 1; i < iv.length; i++) { if (iv[i][0] > ce) { tot += ce - cs; cs = iv[i][0]; ce = iv[i][1]; } else if (iv[i][1] > ce) ce = iv[i][1]; }
    return tot + ce - cs;
  }
  function maxConcurrency(iv) {
    const ev = [];
    iv.forEach(x => { ev.push([x[0], 1]); ev.push([x[1], -1]); });
    ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let c = 0, m = 0; ev.forEach(e => { c += e[1]; if (c > m) m = c; });
    return m;
  }

  function analyseTrace(spansIn, opts) {
    opts = Object.assign({ adjustSkew: true, nPlusOne: 5, fanOut: 10 }, opts || {});
    const n = spansIn.length;
    if (!n) throw new Error('This trace has no spans.');
    const S = spansIn.map((s, i) => ({
      i, id: s.id || 'span' + i, parent: s.parent || '', follows: !!s.follows, service: s.service || 'unknown', op: s.op || '(unnamed)',
      start: num(s.start), dur: Math.max(0, num(s.dur)), kind: s.kind || '', error: !!s.error, msg: s.msg || '', status: s.status, attrs: s.attrs || {}, events: s.events || [],
      p: -1, kids: [], depth: 0, skew: 0,
    }));
    const warnings = [];
    const byId = new Map();
    S.forEach(s => { if (byId.has(s.id)) s.id = s.id + '#' + s.i; byId.set(s.id, s); });
    let orphans = 0;
    S.forEach(s => {
      if (!s.parent) return;
      const p = byId.get(s.parent);
      if (p && p !== s) { s.p = p.i; p.kids.push(s.i); } else if (!p) orphans++;
    });
    // walk from roots; anything unvisited sits in a parent cycle, so break it there
    const order = [], seen = new Uint8Array(n);
    const sortKids = s => s.kids.sort((a, b) => S[a].start - S[b].start || S[b].dur - S[a].dur);
    function walk(r) {
      const st = [r];
      while (st.length) {
        const i = st.pop(); if (seen[i]) continue; seen[i] = 1; order.push(i);
        const s = S[i]; sortKids(s);
        for (let k = s.kids.length - 1; k >= 0; k--) { const c = S[s.kids[k]]; c.depth = s.depth + 1; st.push(c.i); }
      }
    }
    const roots = S.filter(s => s.p < 0).sort((a, b) => a.start - b.start).map(s => s.i);
    roots.forEach(walk);
    let cycles = 0;
    for (let i = 0; i < n; i++) if (!seen[i]) {
      cycles++; const s = S[i];
      if (s.p >= 0) { const pk = S[s.p].kids; pk.splice(pk.indexOf(i), 1); s.p = -1; }
      s.depth = 0; roots.push(i); walk(i);
    }
    if (orphans) warnings.push(plural(orphans, 'span') + ' point to a parent that is not in the file (the trace may be incomplete or still arriving). They are shown as extra roots.');
    if (cycles) warnings.push('Span parent links formed a loop; it was broken so the trace could be drawn.');

    // clock skew: a child on another service that starts before its parent, or runs past it while being shorter, is
    // almost always a clock difference between hosts. Shift it (and everything under it) into the middle of the parent,
    // the same correction Jaeger applies.
    const skews = [];
    const inh = new Float64Array(n);
    order.forEach(i => {
      const c = S[i];
      if (c.p < 0) return;
      const p = S[c.p];
      c.start += inh[p.i];
      let delta = 0;
      const pEnd = p.start + p.dur, cEnd = c.start + c.dur;
      const tol = Math.max(1, p.dur * 0.001);
      if (c.service !== p.service && !c.follows && p.kind !== 'producer' && c.kind !== 'consumer') {
        const outside = c.start < p.start - tol || (cEnd > pEnd + tol && c.dur <= p.dur);
        if (outside) {
          if (c.dur <= p.dur) delta = (p.start + (p.dur - c.dur) / 2) - c.start;
          else if (c.start < p.start) delta = p.start - c.start;
          if (Math.abs(delta) > tol) skews.push({ i: c.i, service: c.service, parentService: p.service, delta: Math.round(delta) });
          else delta = 0;
        }
      }
      if (!opts.adjustSkew) delta = 0;
      c.start += delta; c.skew = delta;
      inh[i] = inh[p.i] + delta;
    });
    S.forEach(s => { s.end = s.start + s.dur; });

    let t0 = Infinity, t1 = -Infinity;
    S.forEach(s => { if (s.start < t0) t0 = s.start; if (s.end > t1) t1 = s.end; });
    const total = Math.max(0, t1 - t0);
    const mainRoot = roots.slice().sort((a, b) => S[b].dur - S[a].dur || S[a].start - S[b].start)[0];

    // self time and gaps: parts of a span not covered by any child
    const gapsAll = [];
    S.forEach(s => {
      if (!s.kids.length) { s.self = s.dur; return; }
      const iv = [];
      s.kids.forEach(k => { const c = S[k]; const a = Math.max(c.start, s.start), b = Math.min(c.end, s.end); if (b > a) iv.push([a, b]); });
      iv.sort((a, b) => a[0] - b[0]);
      let cur = s.start, covered = 0;
      const gaps = [];
      iv.forEach(x => { if (x[0] > cur) gaps.push([cur, x[0]]); if (x[1] > cur) { covered += x[1] - Math.max(cur, x[0]); cur = x[1]; } });
      if (s.end > cur) gaps.push([cur, s.end]);
      s.self = Math.max(0, s.dur - covered);
      gaps.forEach(g => gapsAll.push({ i: s.i, a: g[0], b: g[1], len: g[1] - g[0], first: g[0] === s.start, last: g[1] === s.end }));
    });

    // critical path: walk back from the end of each span, always following the child that finished last
    const crit = new Float64Array(n);
    const segs = [];
    function cp(i, cap) {
      const s = S[i];
      let cursor = Math.min(s.end, cap);
      const kids = s.kids.map(k => S[k]).filter(c => c.start < s.end && c.end > s.start).sort((a, b) => b.end - a.end);
      for (let k = 0; k < kids.length; k++) {
        const c = kids[k];
        // like Jaeger: only a child that finished by the cursor can be what the parent was waiting for
        const ce = Math.min(c.end, s.end);
        if (ce > cursor || c.start >= cursor) continue;
        if (cursor > ce) { segs.push({ i, a: ce, b: cursor }); crit[i] += cursor - ce; }
        cp(c.i, ce);
        cursor = Math.max(c.start, s.start);
        if (cursor <= s.start) break;
      }
      if (cursor > s.start) { segs.push({ i, a: s.start, b: cursor }); crit[i] += cursor - s.start; }
    }
    try { cp(mainRoot, Infinity); } catch (e) { warnings.push('The trace is too deep to compute a full critical path.'); }
    segs.sort((a, b) => a.a - b.a);
    const critTotal = segs.reduce((x, g) => x + (g.b - g.a), 0);

    // per service
    const svc = {};
    S.forEach(s => {
      const v = svc[s.service] || (svc[s.service] = { service: s.service, spans: 0, errors: 0, self: 0, crit: 0, dur: 0 });
      v.spans++; v.self += s.self; v.crit += crit[s.i]; if (s.error) v.errors++;
    });
    // time a service is "busy" = union of its spans; avoids double counting nested spans of the same service
    const svcIv = {};
    S.forEach(s => { (svcIv[s.service] = svcIv[s.service] || []).push([s.start, s.end]); });
    Object.keys(svc).forEach(k => { svc[k].dur = unionLen(svcIv[k]); });
    const services = Object.values(svc).sort((a, b) => b.crit - a.crit || b.self - a.self);

    // per operation
    const ops = {};
    S.forEach(s => {
      const k = s.service + '|' + s.op;
      const v = ops[k] || (ops[k] = { service: s.service, op: s.op, count: 0, total: 0, self: 0, max: 0, crit: 0, errors: 0 });
      v.count++; v.total += s.dur; v.self += s.self; v.crit += crit[s.i]; if (s.dur > v.max) v.max = s.dur; if (s.error) v.errors++;
    });
    const operations = Object.values(ops).sort((a, b) => b.self - a.self);

    // ---------------- findings
    const findings = [];
    const lbl = s => s.service + ' `' + short(s.op, 80) + '`';
    const minSig = Math.max(1000, total * 0.03); // ignore patterns smaller than 1 ms or 3 % of the trace

    // N+1, retries and fan-out are per parent
    const nplus = [], retries = [], fans = [], seqs = [];
    S.forEach(p => {
      if (p.kids.length < 2) return;
      const kids = p.kids.map(k => S[k]);
      const groups = {};
      kids.forEach(c => { (groups[callKey(c)] = groups[callKey(c)] || []).push(c); });
      Object.keys(groups).forEach(k => {
        const g = groups[k];
        // retries: an attempt that failed, followed by the same call starting after it
        if (g.length >= 2) {
          let chain = [g[0]];
          const flush = () => {
            if (chain.length >= 2 && chain.slice(0, -1).every(x => x.error)) {
              const first = chain[0], last = chain[chain.length - 1];
              retries.push({ parent: p.i, spans: chain.map(x => x.i), attempts: chain.length, ok: !last.error, wasted: last.start - first.start, op: last.op, service: last.service, msg: first.msg });
            }
          };
          for (let j = 1; j < g.length; j++) {
            const prev = chain[chain.length - 1];
            if (prev.error && g[j].start >= prev.end - Math.max(1, prev.dur * 0.05)) chain.push(g[j]);
            else { flush(); chain = [g[j]]; }
          }
          flush();
        }
        if (g.length >= opts.nPlusOne) {
          const iv = g.map(c => [c.start, c.end]);
          const sum = g.reduce((x, c) => x + c.dur, 0);
          const span = unionLen(iv.slice());
          const conc = maxConcurrency(iv);
          const sequential = conc <= 1;
          nplus.push({ parent: p.i, count: g.length, service: g[0].service, op: g[0].op, statement: g[0].attrs['db.statement'] || g[0].attrs['db.query.text'] || '',
            db: g.some(isDbSpan), sum, wall: span, sequential, conc, avg: sum / g.length, spans: g.map(c => c.i) });
        }
      });
      if (kids.length >= opts.fanOut) {
        const iv = kids.map(c => [c.start, c.end]);
        const svcs = {}; kids.forEach(c => { svcs[c.service] = 1; });
        fans.push({ parent: p.i, count: kids.length, services: Object.keys(svcs).length, conc: maxConcurrency(iv), wall: unionLen(iv.slice()) });
      }
      // sequential calls to different downstream operations that never overlap
      // cache lookups (cache-aside) and retried attempts are sequential by design, so they are left out
      const calls = kids.filter(c => c.dur >= Math.max(500, total * 0.02) && !/^(redis|memcached)$/i.test(String(c.attrs['db.system'] || '')) && !/\b(redis|memcache)/i.test(c.op) &&
        !(c.error && kids.some(x => x !== c && callKey(x) === callKey(c) && x.start >= c.end - 1)) &&
        (c.service !== p.service || c.kind === 'client' || isDbSpan(c) || c.kind === 'producer'));
      if (calls.length >= 2) {
        let run = [calls[0]];
        const flush = () => {
          const distinct = {}; run.forEach(c => { distinct[callKey(c)] = 1; });
          if (run.length >= 2 && Object.keys(distinct).length === run.length) {
            const sum = run.reduce((x, c) => x + c.dur, 0), mx = Math.max.apply(null, run.map(c => c.dur));
            if (sum - mx >= Math.max(minSig, total * 0.05)) seqs.push({ parent: p.i, spans: run.map(c => c.i), sum, saving: sum - mx, longest: mx });
          }
        };
        for (let j = 1; j < calls.length; j++) {
          const prev = run[run.length - 1];
          if (calls[j].start >= prev.end - Math.max(1, prev.dur * 0.02)) run.push(calls[j]);
          else { flush(); run = [calls[j]]; }
        }
        flush();
      }
    });

    nplus.sort((a, b) => b.wall - a.wall).forEach(g => {
      const p = S[g.parent];
      if (g.wall < minSig && g.count < 20) return;
      const what = g.db ? 'database queries' : 'calls';
      findings.push({ id: 'n-plus-one', severity: g.wall >= total * 0.2 ? 'high' : 'medium', spans: g.spans, time: g.wall,
        title: 'N+1 pattern: ' + g.count + ' × ' + short(g.op, 60) + ' from ' + p.service,
        text: lbl(p) + ' makes ' + g.count + ' ' + what + ' to ' + g.service + ' `' + short(g.op, 60) + '`' + (g.sequential ? ', one after another' : ' (up to ' + g.conc + ' at a time)') +
          '. Together they take ' + fmtDur(g.wall) + ' (' + pct(g.wall, total) + '% of the trace), about ' + fmtDur(g.avg) + ' each. This is the classic N+1: one call per item instead of one call for all items.',
        fix: g.db ? 'Fetch all rows in one query (WHERE id IN (…) or a JOIN), or turn on eager loading / batch fetching in your ORM (e.g. JPA @BatchSize or JOIN FETCH, Django select_related/prefetch_related, Rails includes).'
          : 'Add a batch endpoint (one request for many ids), or cache the results. If the calls must stay separate, run them concurrently with a sensible limit.' });
    });
    seqs.sort((a, b) => b.saving - a.saving).slice(0, 5).forEach(q => {
      const p = S[q.parent];
      const names = q.spans.map(i => S[i].service + ' `' + short(S[i].op, 40) + '`');
      findings.push({ id: 'sequential', severity: q.saving >= total * 0.15 ? 'high' : 'medium', spans: q.spans, time: q.saving,
        title: 'Sequential calls that could run in parallel (save up to ' + fmtDur(q.saving) + ')',
        text: lbl(p) + ' calls ' + names.join(', then ') + ' one after another (' + fmtDur(q.sum) + ' in total). If none of them needs the result of another, running them at the same time would take about ' + fmtDur(q.longest) + ', saving up to ' + fmtDur(q.saving) + ' (' + pct(q.saving, total) + '% of the trace).',
        fix: 'Start the independent calls together and wait for all of them: CompletableFuture.allOf (Java), Promise.all (Node.js), asyncio.gather (Python), errgroup (Go), Task.WhenAll (.NET). Check for hidden data dependencies first.' });
    });
    retries.forEach(r => {
      findings.push({ id: 'retry', severity: r.ok ? 'medium' : 'high', spans: r.spans, time: r.wasted,
        title: 'Retry: ' + r.service + ' `' + short(r.op, 60) + '` called ' + r.attempts + ' times' + (r.ok ? ', the last attempt worked' : ', every attempt failed'),
        text: lbl(S[r.parent]) + ' called ' + r.service + ' `' + short(r.op, 60) + '` ' + r.attempts + ' times after ' + (r.attempts === 2 ? 'a failure' : 'failures') + (r.msg ? ' ("' + short(r.msg, 120) + '")' : '') + '. The failed attempts and back-off added ' + fmtDur(r.wasted) + ' to the request.',
        fix: r.ok ? 'Find out why the first attempt fails (connection reuse, cold pool, rate limit, timeouts set too tight). Keep retries, but with jittered back-off, a retry budget and only for idempotent calls.'
          : 'The dependency is failing, not flaky. Fail fast with a circuit breaker so callers do not wait through every retry, and alert on the dependency\'s error rate.' });
    });
    fans.sort((a, b) => b.count - a.count).slice(0, 3).forEach(f => {
      const p = S[f.parent];
      if (nplus.some(g => g.parent === f.parent && g.count >= f.count * 0.8)) return; // already explained as N+1
      findings.push({ id: 'fan-out', severity: 'low', spans: p.kids.slice(), time: f.wall,
        title: 'Fan-out: ' + f.count + ' calls from ' + p.service + ' `' + short(p.op, 60) + '`',
        text: lbl(p) + ' makes ' + f.count + ' child calls to ' + plural(f.services, 'service') + ', at most ' + f.conc + ' at a time. Wide fan-outs make the slowest call decide the response time (tail latency amplification) and multiply load on downstream services.',
        fix: f.conc <= 1 ? 'The calls run one at a time. Run independent calls concurrently (with a limit), or batch them.' : 'Set a per-call timeout and a concurrency limit, consider hedged requests for the slowest calls, and cache what you can.' });
    });

    // errors: the deepest error in a chain is usually the origin; parents that fail because of it are follow-on errors
    const errs = S.filter(s => s.error);
    const errList = errs.map(s => ({ i: s.i, origin: !s.kids.some(k => S[k].error), msg: s.msg, status: s.status }));
    const retrySpans = new Set(); retries.filter(r => r.ok).forEach(r => r.spans.slice(0, -1).forEach(i => retrySpans.add(i)));
    const origins = errList.filter(e => e.origin);
    if (errs.length) {
      const hidden = origins.filter(e => retrySpans.has(e.i)).length;
      findings.push({ id: 'errors', severity: errs.length - hidden > 0 ? 'high' : 'low', spans: errs.map(s => s.i), time: 0,
        title: plural(errs.length, 'error span') + (origins.length ? ', ' + origins.length + ' where the error starts' : ''),
        text: origins.slice(0, 4).map(e => lbl(S[e.i]) + (e.status ? ' (HTTP ' + e.status + ')' : '') + (e.msg ? ': "' + short(e.msg, 160) + '"' : '')).join('; ') +
          (errs.length > origins.length ? '. The other ' + plural(errs.length - origins.length, 'error') + ' are callers failing because of these.' : '.') +
          (hidden ? ' ' + plural(hidden, 'error') + ' recovered after a retry.' : ''),
        fix: 'Start with the error that has no failing children: that is where the failure begins. Check that service\'s logs around the span\'s start time for the trace id.' });
    }

    // gaps: time inside a span not covered by its children (queueing, connection setup, GC, uninstrumented work)
    const sigGaps = gapsAll.filter(g => g.len >= Math.max(1000, total * 0.05)).sort((a, b) => b.len - a.len).slice(0, 6);
    sigGaps.forEach(g => {
      const s = S[g.i];
      const where = g.first ? 'before its first child call' : g.last ? 'after its last child call' : 'between child calls';
      const onCrit = segs.some(x => x.i === g.i && x.a < g.b && x.b > g.a);
      findings.push({ id: 'gap', severity: onCrit && g.len >= total * 0.1 ? 'medium' : 'low', spans: [g.i], time: g.len, gap: [g.a - t0, g.b - t0],
        title: 'Unexplained ' + fmtDur(g.len) + ' in ' + s.service + ' `' + short(s.op, 60) + '`',
        text: lbl(s) + ' spends ' + fmtDur(g.len) + ' ' + where + ' with no child span covering it' + (onCrit ? ', and that time is on the critical path' : '') + '. This is time in the service itself: queueing for a thread or connection, serialisation, CPU work, GC pauses, or a call that is not instrumented.',
        fix: 'Add a span (or span events) around the work in that window, check thread-pool and connection-pool wait metrics, and look at GC logs for the same timestamp.' });
    });

    // big self time leaves on the critical path
    S.filter(s => crit[s.i] >= total * 0.25 && s.self >= total * 0.2 && !s.kids.length).sort((a, b) => crit[b.i] - crit[a.i]).slice(0, 2).forEach(s => {
      findings.push({ id: 'hot-span', severity: 'high', spans: [s.i], time: crit[s.i],
        title: 'One span holds ' + pct(crit[s.i], total) + '% of the response time: ' + s.service + ' `' + short(s.op, 60) + '`',
        text: lbl(s) + ' runs for ' + fmtDur(s.dur) + ' with no child spans, and ' + fmtDur(crit[s.i]) + ' of it is on the critical path. Nothing else will make this request much faster until this span does.',
        fix: isDbSpan(s) ? 'Run EXPLAIN (ANALYZE, BUFFERS) on the statement; look for a missing index or a large scan. The Database Performance Lab on this site explains the plan.'
          : 'Profile this code path (a flame graph or an async profiler), add child spans to see where the time goes, and check whether the result could be cached.' });
    });

    if (skews.length) {
      const bySvc = {}; skews.forEach(k => { const v = bySvc[k.service] || (bySvc[k.service] = { n: 0, max: 0 }); v.n++; if (Math.abs(k.delta) > Math.abs(v.max)) v.max = k.delta; });
      findings.push({ id: 'clock-skew', severity: 'low', spans: skews.map(k => k.i), time: 0,
        title: 'Clock skew between hosts (' + plural(skews.length, 'span') + (opts.adjustSkew ? ', adjusted' : ', not adjusted') + ')',
        text: Object.keys(bySvc).map(k => k + ' is off by up to ' + fmtDur(Math.abs(bySvc[k].max)) + (bySvc[k].max > 0 ? ' (its clock runs behind its caller)' : ' (its clock runs ahead of its caller)')).join('; ') +
          '. A child span cannot start before its parent, so these spans were ' + (opts.adjustSkew ? 'moved into the middle of their parent' : 'left where the timestamps put them') + '. Durations are not changed.',
        fix: 'Make sure every host runs NTP or chrony and that containers inherit the host clock. Skew of more than a few milliseconds makes waterfalls and cross-service gaps misleading.' });
    }

    const sev = { high: 0, medium: 1, low: 2 };
    findings.sort((a, b) => sev[a.severity] - sev[b.severity] || b.time - a.time);

    // ---------------- plain-English summary
    const rootS = S[mainRoot];
    const summary = [];
    summary.push('This trace took ' + fmtDur(total) + ' end to end: ' + plural(S.length, 'span') + ' across ' + plural(services.length, 'service') +
      (errs.length ? ', with ' + plural(errs.length, 'error span') : '') + '. It starts at ' + rootS.service + ' `' + short(rootS.op, 80) + '`.');
    if (critTotal > 0) {
      // the span that contributes most to the critical path, and who is waiting on it
      let top = null; S.forEach(s => { if (!top || crit[s.i] > crit[top.i]) top = s; });
      const topSvc = services[0];
      let line = pct(topSvc.crit, total) + '% of the ' + fmtDur(total) + ' (' + fmtDur(topSvc.crit) + ') is spent in ' + topSvc.service;
      if (top && top.service === topSvc.service && crit[top.i] >= topSvc.crit * 0.5) {
        // climb to the span where the request entered this service; its parent is the caller that waits
        let entry = top;
        while (entry.p >= 0 && S[entry.p].service === top.service) entry = S[entry.p];
        let caller = entry.p >= 0 ? S[entry.p] : null;
        if (caller) {
          const sameOp = S.filter(s => s.p === entry.p && s.op === entry.op).length;
          line += ', with ' + caller.service + ' waiting on ' + (sameOp > 1 ? sameOp + ' calls to' : 'a single') + ' `' + short(entry.op, 60) + '`' + (sameOp > 1 ? '' : ' call') +
            (entry !== top ? ' (' + fmtDur(crit[top.i]) + ' of it in `' + short(top.op, 60) + '`).' : ' (' + fmtDur(crit[top.i]) + ' on the critical path).');
        } else line += ', mostly in `' + short(top.op, 60) + '` (' + fmtDur(crit[top.i]) + ').';
      } else line += '.';
      summary.push(line);
      if (services[1] && services[1].crit >= total * 0.1) summary.push('Next is ' + services[1].service + ' with ' + pct(services[1].crit, total) + '% (' + fmtDur(services[1].crit) + ').');
    }
    const said = {};
    findings.filter(f => f.id !== 'clock-skew' && f.id !== 'errors' && f.id !== 'hot-span' && f.id !== 'fan-out' && !said[f.id] && (said[f.id] = 1)).slice(0, 3).forEach(f => {
      if (f.id === 'n-plus-one') summary.push('An N+1 pattern costs ' + fmtDur(f.time) + ': ' + f.title.replace(/^N\+1 pattern: /, '') + '.');
      else if (f.id === 'sequential') summary.push('Running independent calls in parallel could save up to ' + fmtDur(f.time) + '.');
      else if (f.id === 'retry') summary.push('A retry added ' + fmtDur(f.time) + ' (' + f.title.replace(/^Retry: /, '') + ').');
      else if (f.id === 'gap') summary.push(f.title.replace(/^Unexplained/, 'There is an unexplained') + ' with no child span covering it.');
    });
    if (origins.length) summary.push('The error starts in ' + S[origins[0].i].service + ' `' + short(S[origins[0].i].op, 60) + '`' + (origins[0].msg ? ': "' + short(origins[0].msg, 100) + '"' : '') + '.');

    // ---------------- output (plain objects only, so it can cross the worker boundary)
    const spansOut = order.map(i => {
      const s = S[i];
      return { i: s.i, id: s.id, p: s.p, depth: s.depth, service: s.service, op: s.op, kind: s.kind, start: s.start - t0, dur: s.dur, self: s.self, crit: crit[s.i],
        error: s.error, msg: s.msg, status: s.status, skew: s.skew, kids: s.kids.length, follows: s.follows, attrs: trimAttrs(s.attrs), events: s.events.slice(0, 20).map(e => ({ t: e.t, name: e.name })) };
    });
    return {
      traceId: spansIn[0].traceId || '', total, start: t0, spanCount: n, serviceCount: services.length, errorCount: errs.length,
      root: { service: rootS.service, op: rootS.op }, spans: spansOut,
      critical: segs.map(g => ({ i: g.i, a: g.a - t0, b: g.b - t0 })), critTotal,
      services, operations: operations.slice(0, 100), findings, errors: errList, skews, warnings, summary,
    };
  }
  function trimAttrs(a) {
    const o = {}; let k = 0;
    for (const key in a) { if (k++ >= 40) break; const v = a[key]; o[key] = typeof v === 'object' ? short(JSON.stringify(v), 300) : typeof v === 'string' ? short(v, 300) : v; }
    return o;
  }

  // ------------------------------------------------------------------ many traces
  function analyseMany(traces, opts, onProgress) {
    opts = opts || {};
    const per = [];
    const opDur = {}, svcDur = {}, edges = {}, critSvc = {}, rootOps = {};
    traces.forEach((t, idx) => {
      let a;
      try { a = analyseTrace(t.spans, opts); } catch (e) { return; }
      const byI = {}; a.spans.forEach(s => { byI[s.i] = s; });
      const critBySvc = {}; a.services.forEach(v => { critBySvc[v.service] = v.crit; });
      per.push({ id: t.id, total: a.total, spans: a.spanCount, errors: a.errorCount, root: a.root, critBySvc, start: a.start, findings: a.findings.filter(f => f.severity !== 'low').map(f => f.id) });
      const rk = a.root.service + ' ' + a.root.op;
      (rootOps[rk] = rootOps[rk] || { service: a.root.service, op: a.root.op, d: [], errors: 0 }).d.push(a.total);
      if (a.errorCount) rootOps[rk].errors++;
      a.spans.forEach(s => {
        const ok = s.service + '|' + s.op;
        const o = opDur[ok] || (opDur[ok] = { service: s.service, op: s.op, d: [], self: 0, errors: 0 });
        o.d.push(s.dur); o.self += s.self; if (s.error) o.errors++;
        const par = s.p >= 0 ? byI[s.p] : null;
        // a service's latency = its entry spans (root, server/consumer spans, or the first span after a service hop)
        if (!par || par.service !== s.service) {
          const v = svcDur[s.service] || (svcDur[s.service] = { service: s.service, d: [], errors: 0, traces: 0, lastTrace: -1 });
          v.d.push(s.dur); if (s.error) v.errors++;
          if (v.lastTrace !== idx) { v.traces++; v.lastTrace = idx; }
        }
        if (par && par.service !== s.service) {
          const ek = par.service + '→' + s.service;
          const e = edges[ek] || (edges[ek] = { from: par.service, to: s.service, d: [], errors: 0 });
          e.d.push(s.dur); if (s.error) e.errors++;
        }
      });
      Object.keys(critBySvc).forEach(k => {
        const v = critSvc[k] || (critSvc[k] = { service: k, traces: 0, crit: 0, share: 0 });
        if (critBySvc[k] > 0) { v.traces++; v.crit += critBySvc[k]; v.share += a.total ? critBySvc[k] / a.total : 0; }
      });
      if (onProgress && idx % 200 === 199) onProgress(idx + 1, traces.length);
    });
    const N = per.length;
    if (!N) throw new Error('None of the traces could be analysed.');
    const stats = d => { const s = sortNum(d.slice()); return { count: s.length, p50: pctl(s, 50), p90: pctl(s, 90), p95: pctl(s, 95), p99: pctl(s, 99), max: s[s.length - 1], mean: s.reduce((x, y) => x + y, 0) / s.length }; };
    const services = Object.values(svcDur).map(v => Object.assign({ service: v.service, errors: v.errors, traces: v.traces }, stats(v.d))).sort((a, b) => b.p95 - a.p95);
    const operations = Object.values(opDur).map(v => Object.assign({ service: v.service, op: v.op, errors: v.errors, selfMean: v.self / v.d.length }, stats(v.d))).sort((a, b) => b.p95 * b.count - a.p95 * a.count);
    const dependencies = Object.values(edges).map(e => Object.assign({ from: e.from, to: e.to, errors: e.errors }, stats(e.d))).sort((a, b) => b.count - a.count);
    const totalCrit = Object.values(critSvc).reduce((x, v) => x + v.crit, 0);
    const critical = Object.values(critSvc).map(v => ({ service: v.service, traces: v.traces, tracePct: pct(v.traces, N), critShare: totalCrit ? v.crit / totalCrit : 0, meanShare: v.traces ? v.share / v.traces : 0 }))
      .sort((a, b) => b.critShare - a.critShare);
    const endpoints = Object.values(rootOps).map(v => Object.assign({ service: v.service, op: v.op, errors: v.errors }, stats(v.d))).sort((a, b) => b.count - a.count);

    // outliers: per endpoint, slower than median + 3 × MAD and at least 1.5 × the median
    const outliers = [];
    const byRoot = {};
    per.forEach(p => { const k = p.root.service + ' ' + p.root.op; (byRoot[k] = byRoot[k] || []).push(p); });
    Object.keys(byRoot).forEach(k => {
      const g = byRoot[k];
      if (g.length < 5) return;
      const d = g.map(p => p.total), med = median(d);
      const mad = median(d.map(x => Math.abs(x - med))) * 1.4826;
      const thr = Math.max(med * 1.5, med + 3 * mad);
      const typical = g.filter(p => p.total <= thr);
      const typCrit = {};
      typical.forEach(p => Object.keys(p.critBySvc).forEach(s => { (typCrit[s] = typCrit[s] || []).push(p.critBySvc[s]); }));
      const typMed = {}; Object.keys(typCrit).forEach(s => { const arr = typCrit[s]; while (arr.length < typical.length) arr.push(0); typMed[s] = median(arr); });
      g.filter(p => p.total > thr).forEach(p => {
        let best = null, bestX = 0;
        Object.keys(Object.assign({}, p.critBySvc, typMed)).forEach(s => { const x = (p.critBySvc[s] || 0) - (typMed[s] || 0); if (x > bestX) { bestX = x; best = s; } });
        outliers.push({ id: p.id, total: p.total, typical: med, ratio: med ? p.total / med : 0, endpoint: k, service: best, extra: bestX, errors: p.errors,
          why: best ? fmtDur(bestX) + ' more than usual on the critical path in ' + best + (p.errors ? '; ' + plural(p.errors, 'error span') : '') : (p.errors ? plural(p.errors, 'error span') : 'no single service stands out') });
      });
    });
    outliers.sort((a, b) => b.ratio - a.ratio);
    const outSet = new Set(outliers.map(o => o.id));

    const durs = per.map(p => p.total);
    const overall = stats(durs);
    const summary = [];
    summary.push(plural(N, 'trace') + (endpoints.length > 1 ? ' across ' + endpoints.length + ' entry points' : ' of ' + endpoints[0].service + ' `' + short(endpoints[0].op, 60) + '`') +
      ': median ' + fmtDur(overall.p50) + ', p95 ' + fmtDur(overall.p95) + ', slowest ' + fmtDur(overall.max) + '.');
    if (critical[0]) summary.push(critical[0].service + ' is on the critical path in ' + critical[0].tracePct + '% of traces and accounts for ' + Math.round(critical[0].critShare * 100) + '% of all critical-path time' +
      (critical[1] ? '; next is ' + critical[1].service + ' at ' + Math.round(critical[1].critShare * 100) + '%.' : '.'));
    if (outliers.length) {
      const blame = {}; outliers.forEach(o => { if (o.service) blame[o.service] = (blame[o.service] || 0) + 1; });
      const b = Object.keys(blame).sort((x, y) => blame[y] - blame[x])[0];
      summary.push(plural(outliers.length, 'trace is an outlier', 'traces are outliers') + ' (much slower than typical for their entry point)' + (b ? '; in ' + blame[b] + ' of them the extra time is in ' + b + '.' : '.'));
    }
    const errTraces = per.filter(p => p.errors).length;
    if (errTraces) summary.push(plural(errTraces, 'trace') + ' (' + pct(errTraces, N) + '%) contain at least one error span.');
    const fcount = {}; per.forEach(p => new Set(p.findings).forEach(f => { fcount[f] = (fcount[f] || 0) + 1; }));
    const FN = { 'n-plus-one': 'an N+1 pattern', sequential: 'sequential calls that could run in parallel', retry: 'retries', 'hot-span': 'one span holding a quarter or more of the time' };
    Object.keys(FN).filter(k => fcount[k] >= Math.max(2, N * 0.2)).forEach(k => summary.push(pct(fcount[k], N) + '% of traces show ' + FN[k] + '.'));

    const list = per.map(p => ({ id: p.id, total: p.total, spans: p.spans, errors: p.errors, root: p.root, start: p.start, outlier: outSet.has(p.id) })).sort((a, b) => b.total - a.total);
    return { traceCount: N, overall, services, operations: operations.slice(0, 200), dependencies, critical, endpoints, outliers: outliers.slice(0, 50), outlierCount: outliers.length, list, summary, findingCounts: fcount };
  }

  // ------------------------------------------------------------------ Markdown
  function toMarkdown(single, many) {
    const L = [];
    if (many) {
      L.push('## Trace analysis: ' + many.traceCount + ' traces', '');
      many.summary.forEach(s => L.push('- ' + s));
      L.push('', '| Service | Calls | p50 | p95 | p99 | Errors |', '|---|---:|---:|---:|---:|---:|');
      many.services.slice(0, 15).forEach(v => L.push('| ' + v.service + ' | ' + v.count + ' | ' + fmtDur(v.p50) + ' | ' + fmtDur(v.p95) + ' | ' + fmtDur(v.p99) + ' | ' + v.errors + ' |'));
      if (many.outliers.length) { L.push('', '**Outlier traces**', ''); many.outliers.slice(0, 10).forEach(o => L.push('- `' + o.id + '` ' + fmtDur(o.total) + ' (' + o.ratio.toFixed(1) + '× typical): ' + o.why)); }
      L.push('');
    }
    if (single) {
      L.push('## Trace ' + (single.traceId || '') + ' (' + fmtDur(single.total) + ')', '');
      single.summary.forEach(s => L.push(s));
      L.push('');
      if (single.findings.length) {
        L.push('**Findings**', '');
        single.findings.forEach(f => L.push('- **' + f.title + '**. ' + f.text.replace(/`/g, '') + ' _Fix:_ ' + f.fix));
        L.push('');
      }
      L.push('| Service | Critical path | Self time | Spans | Errors |', '|---|---:|---:|---:|---:|');
      single.services.forEach(v => L.push('| ' + v.service + ' | ' + fmtDur(v.crit) + ' (' + pct(v.crit, single.total) + '%) | ' + fmtDur(v.self) + ' | ' + v.spans + ' | ' + v.errors + ' |'));
      L.push('');
    }
    L.push('_Analysed in the browser with the Distributed Trace Explainer (pawansinha.com.au/tools/trace-explainer/)._');
    return L.join('\n');
  }

  // ------------------------------------------------------------------ synthetic samples
  // A checkout request: gateway queueing, an N+1 in orders-svc, three sequential calls, a slow fraud model,
  // a retried bank call, and fraud-svc's clock running 80 ms behind.
  function rng(seed) { let x = seed >>> 0 || 1; return () => { x = (x * 16807) % 2147483647; return x / 2147483647; }; }
  function hex(r, len) { let s = ''; while (s.length < len) s += Math.floor(r() * 16).toString(16); return s; }
  function checkoutTrace(seed, o) {
    o = o || {};
    const r = rng(seed);
    const T = 1794142800000000 + seed * 7300000; // 8 Nov 2026 09:00 UTC in µs
    const tid = hex(r, 32);
    const out = [];
    const ms = x => Math.round(x * 1000);
    function sp(parent, service, op, a, b, extra) {
      const s = Object.assign({ traceId: tid, id: hex(r, 16), parent: parent ? parent.id : '', service, op, start: T + ms(a), dur: ms(b - a), kind: '', error: false, msg: '', attrs: {} }, extra || {});
      out.push(s); return s;
    }
    const fraudMs = o.fraudMs != null ? o.fraudMs : 1100;
    const items = o.items != null ? o.items : 12;
    const queue = o.queue != null ? o.queue : 140;
    const jit = () => r() * 6;
    // build forward in time so the trace is internally consistent
    let t = 0;
    const root = sp(null, 'web-frontend', 'GET /checkout', 0, 0, { kind: 'server', attrs: { 'http.method': 'GET', 'http.route': '/checkout', 'http.status_code': 200 } });
    const gwc = sp(root, 'web-frontend', 'POST /api/checkout', 4, 0, { kind: 'client', attrs: { 'http.method': 'POST', 'peer.service': 'api-gateway' } });
    const gw = sp(gwc, 'api-gateway', 'POST /api/checkout', 6, 0, { kind: 'server', attrs: { 'http.method': 'POST', 'http.route': '/api/checkout' } });
    sp(gw, 'api-gateway', 'auth.verify', 8, 19 + jit(), { kind: 'internal' });
    t = 20 + queue; // uninstrumented queueing in the gateway
    const oc = sp(gw, 'api-gateway', 'POST /orders', t, 0, { kind: 'client' });
    const os = sp(oc, 'orders-svc', 'POST /orders', t + 2, 0, { kind: 'server', attrs: { 'http.route': '/orders' } });
    let u = t + 5;
    sp(os, 'orders-svc', 'SELECT orders', u, u + 6, { kind: 'client', attrs: { 'db.system': 'postgresql', 'db.statement': 'SELECT * FROM orders WHERE id = $1' } }); u += 7;
    for (let k = 0; k < items; k++) {
      const d = 7 + r() * 5;
      sp(os, 'orders-svc', 'SELECT order_items', u, u + d, { kind: 'client', attrs: { 'db.system': 'postgresql', 'db.statement': 'SELECT * FROM order_items WHERE order_id = ' + (5000 + k) } });
      u += d + 0.4;
    }
    [['inventory-svc', 'GET /stock/{sku}', 55], ['pricing-svc', 'GET /price/{sku}', 70], ['shipping-svc', 'POST /quote', 85]].forEach(c => {
      const d = c[2] * (0.8 + r() * 0.4);
      const cl = sp(os, 'orders-svc', c[1], u, u + d, { kind: 'client', attrs: { 'peer.service': c[0] } });
      sp(cl, c[0], c[1], u + 1.5, u + d - 1.5, { kind: 'server' });
      u += d + 1;
    });
    os.dur = ms(u + 3 - (t + 2)); oc.dur = ms(u + 5 - t);
    t = u + 6;
    const pc = sp(gw, 'api-gateway', 'POST /payments', t, 0, { kind: 'client' });
    const ps = sp(pc, 'payments-svc', 'POST /payments', t + 2, 0, { kind: 'server', attrs: { 'http.route': '/payments' } });
    u = t + 8;
    const fc = sp(ps, 'payments-svc', 'POST /score', u, u + fraudMs + 40, { kind: 'client', attrs: { 'peer.service': 'fraud-svc' } });
    const skew = o.skew != null ? o.skew : -80;
    const fsv = sp(fc, 'fraud-svc', 'POST /score', u + 3 + skew, u + fraudMs + 37 + skew, { kind: 'server' });
    sp(fsv, 'fraud-svc', 'features.load', u + 5 + skew, u + 18 + skew, { kind: 'internal' });
    sp(fsv, 'fraud-svc', 'model.predict', u + 20 + skew, u + 20 + fraudMs + skew, { kind: 'internal' });
    u += fraudMs + 42;
    if (o.retry !== false) {
      sp(ps, 'payments-svc', 'POST /charge', u, u + 38, { kind: 'client', error: true, msg: 'upstream connect error or disconnect/reset before headers', status: 503, attrs: { 'peer.service': 'bank-gateway', 'http.status_code': 503 } });
      u += 38 + 15;
    }
    sp(ps, 'payments-svc', 'POST /charge', u, u + 48, { kind: 'client', attrs: { 'peer.service': 'bank-gateway', 'http.status_code': 201 } });
    u += 49;
    sp(ps, 'payments-svc', 'INSERT payments', u, u + 4, { kind: 'client', attrs: { 'db.system': 'postgresql', 'db.statement': 'INSERT INTO payments (order_id, amount) VALUES ($1, $2)' } });
    u += 5;
    ps.dur = ms(u + 2 - (t + 2)); pc.dur = ms(u + 4 - t);
    t = u + 6;
    gw.dur = ms(t + 2 - 6); gwc.dur = ms(t + 4 - 4); root.dur = ms(t + 8);
    return out;
  }
  function productsTrace(seed, slow) {
    const r = rng(seed);
    const T = 1794142800000000 + seed * 7300000 + 2500000;
    const tid = hex(r, 32), out = [];
    const ms = x => Math.round(x * 1000);
    function sp(parent, service, op, a, b, extra) { const s = Object.assign({ traceId: tid, id: hex(r, 16), parent: parent ? parent.id : '', service, op, start: T + ms(a), dur: ms(b - a), kind: '', error: false, msg: '', attrs: {} }, extra || {}); out.push(s); return s; }
    const db = slow ? 400 + r() * 300 : 12 + r() * 20;
    const cache = 2 + r() * 2;
    const end = 10 + cache + db + 12;
    const root = sp(null, 'web-frontend', 'GET /products', 0, end + 6, { kind: 'server' });
    const gw = sp(root, 'api-gateway', 'GET /api/products', 2, end + 4, { kind: 'server' });
    const cs = sp(gw, 'catalog-svc', 'GET /products', 5, end + 1, { kind: 'server' });
    sp(cs, 'catalog-svc', 'redis GET', 7, 7 + cache, { kind: 'client', attrs: { 'db.system': 'redis' } });
    sp(cs, 'catalog-svc', 'SELECT products', 9 + cache, 9 + cache + db, { kind: 'client', attrs: { 'db.system': 'postgresql', 'db.statement': 'SELECT * FROM products WHERE category = $1 ORDER BY rank LIMIT 50' } });
    return out;
  }
  function toJaeger(traces) {
    return { data: traces.map(spans => {
      const procs = {}, pid = {};
      spans.forEach(s => { if (!pid[s.service]) { pid[s.service] = 'p' + (Object.keys(pid).length + 1); procs[pid[s.service]] = { serviceName: s.service, tags: [{ key: 'hostname', type: 'string', value: s.service + '-7d9c6b5f4-x2x9z' }] }; } });
      return { traceID: spans[0].traceId, spans: spans.map(s => {
        const tags = Object.keys(s.attrs).map(k => ({ key: k, type: typeof s.attrs[k] === 'number' ? 'int64' : 'string', value: s.attrs[k] }));
        if (s.kind) tags.push({ key: 'span.kind', type: 'string', value: s.kind });
        if (s.error) tags.push({ key: 'error', type: 'bool', value: true });
        return { traceID: s.traceId, spanID: s.id, operationName: s.op, references: s.parent ? [{ refType: 'CHILD_OF', traceID: s.traceId, spanID: s.parent }] : [],
          startTime: s.start, duration: s.dur, tags, logs: s.error ? [{ timestamp: s.start + s.dur, fields: [{ key: 'event', type: 'string', value: 'error' }, { key: 'message', type: 'string', value: s.msg }] }] : [],
          processID: pid[s.service], warnings: null };
      }), processes: procs, warnings: null };
    }), total: 0, limit: 0, offset: 0, errors: null };
  }
  function toZipkin(spans) {
    return spans.map(s => {
      const o = { traceId: s.traceId, id: s.id, name: s.op.toLowerCase(), timestamp: s.start, duration: s.dur, localEndpoint: { serviceName: s.service } };
      if (s.parent) o.parentId = s.parent;
      if (s.kind && s.kind !== 'internal') o.kind = s.kind.toUpperCase();
      const tags = {}; Object.keys(s.attrs).forEach(k => { tags[k] = String(s.attrs[k]); });
      if (s.error) tags.error = s.msg || 'true';
      if (Object.keys(tags).length) o.tags = tags;
      if (s.attrs['peer.service']) o.remoteEndpoint = { serviceName: s.attrs['peer.service'] };
      return o;
    });
  }
  function toOtlp(spans) {
    const bySvc = {};
    spans.forEach(s => { (bySvc[s.service] = bySvc[s.service] || []).push(s); });
    const kinds = { internal: 1, server: 2, client: 3, producer: 4, consumer: 5 };
    const val = v => (typeof v === 'number' ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }) : typeof v === 'boolean' ? { boolValue: v } : { stringValue: String(v) });
    return { resourceSpans: Object.keys(bySvc).map(svc => ({
      resource: { attributes: [{ key: 'service.name', value: { stringValue: svc } }, { key: 'host.name', value: { stringValue: svc + '-0' } }] },
      scopeSpans: [{ scope: { name: 'io.opentelemetry.sample', version: '1.0.0' }, spans: bySvc[svc].map(s => {
        const o = { traceId: s.traceId, spanId: s.id, name: s.op, kind: kinds[s.kind] || 1,
          startTimeUnixNano: String(Math.round(s.start)) + '000', endTimeUnixNano: String(Math.round(s.start + s.dur)) + '000',
          attributes: Object.keys(s.attrs).map(k => ({ key: k, value: val(s.attrs[k]) })), status: s.error ? { code: 2, message: s.msg } : {} };
        if (s.parent) o.parentSpanId = s.parent;
        if (s.error) o.events = [{ timeUnixNano: String(Math.round(s.start + s.dur)) + '000', name: 'exception', attributes: [{ key: 'exception.type', value: { stringValue: 'UpstreamError' } }, { key: 'exception.message', value: { stringValue: s.msg } }] }];
        return o;
      }) }],
    })) };
  }
  const samples = {
    sampleJaeger: () => JSON.stringify(toJaeger([checkoutTrace(1)]), null, 1),
    sampleZipkin: () => JSON.stringify(toZipkin(checkoutTrace(2)), null, 1),
    sampleOtlp: () => JSON.stringify(toOtlp(checkoutTrace(3)), null, 1),
    sampleMany: count => {
      count = count || 150;
      const r = rng(99), traces = [];
      for (let k = 0; k < count; k++) {
        if (r() < 0.35) traces.push(productsTrace(500000 + k, r() < 0.04));
        else {
          const slow = r() < 0.07;
          traces.push(checkoutTrace(2000 + k, { fraudMs: slow ? 900 + r() * 1400 : 60 + r() * 120, items: 3 + Math.floor(r() * 14), queue: r() < 0.1 ? 120 + r() * 200 : 2 + r() * 10,
            retry: r() < 0.12, skew: r() < 0.3 ? -40 - r() * 60 : 0 }));
        }
      }
      return JSON.stringify(toJaeger(traces));
    },
    checkoutTrace, toJaeger, toZipkin, toOtlp,
  };

  // ------------------------------------------------------------------ session (used by worker.js and the main-thread fallback)
  function createSession() {
    let traces = [], opts = {};
    return {
      load(texts, o, onProgress) {
        opts = o || {};
        const spans = [], warnings = [], formats = {};
        texts.forEach((t, k) => {
          let p;
          try { p = parse(t.text); } catch (e) { if (texts.length === 1) throw e; warnings.push((t.name || 'Input ' + (k + 1)) + ': ' + e.message); return; }
          for (let j = 0; j < p.spans.length; j++) spans.push(p.spans[j]);
          p.warnings.forEach(w => warnings.push((texts.length > 1 ? (t.name || 'Input ' + (k + 1)) + ': ' : '') + w));
          if (p.format) formats[p.format] = 1;
        });
        if (!spans.length) throw new Error('No spans found in ' + (texts.length > 1 ? 'any of the files.' : 'the input.'));
        traces = groupTraces(spans);
        const fk = Object.keys(formats);
        const format = fk.length > 1 ? 'mixed' : fk[0] || '';
        let many = null;
        if (traces.length > 1) many = analyseMany(traces, opts, onProgress);
        const pick = many ? many.list[0].id : traces[0].id;
        return { format, formatLabel: FORMAT_LABEL[format] || 'Unknown', warnings, spanCount: spans.length, traceCount: traces.length, many, single: this.trace(pick) };
      },
      trace(id) {
        const t = traces.find(x => x.id === id);
        if (!t) throw new Error('Trace ' + id + ' not found.');
        return analyseTrace(t.spans, opts);
      },
    };
  }

  const api = { createSession, parse, detectFormat, groupTraces, analyseTrace, analyseMany, toMarkdown, fmtDur, normId, b64ToHex, nanoToMicro, normOp, pctl, samples, FORMAT_LABEL };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TraceExplainer = api;
})(typeof self !== 'undefined' ? self : this);
