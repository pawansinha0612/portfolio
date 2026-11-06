/* Workload model: turn access logs into a load-test workload model.
 * Pure logic, no DOM. Used by the page, the Web Worker (importScripts) and Node tests (require).
 * Nothing here sends data anywhere. */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- time
  const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

  // "10/Oct/2000:13:55:36 -0700" -> wall-clock ms (the time as written; the offset is not applied)
  function parseClfTime(s) {
    const mon = MONTHS[s.slice(3, 6)];
    if (mon === undefined) return NaN;
    return Date.UTC(+s.slice(7, 11), mon, +s.slice(0, 2), +s.slice(12, 14), +s.slice(15, 17), +s.slice(18, 20));
  }

  const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/;
  // Any reasonable timestamp -> wall-clock ms. UTC times (Z, epoch numbers) get shiftMs added
  // so they read in the chosen timezone; times written with their own offset stay as written.
  function parseAnyTime(v, shiftMs) {
    shiftMs = shiftMs || 0;
    if (v == null || v === '') return NaN;
    if (typeof v === 'number') return (v > 1e12 ? v : v * 1000) + shiftMs;
    const s = String(v).trim();
    if (/^\d+(\.\d+)?$/.test(s)) {
      const n = +s;
      if (n > 1e14) return n / 1000 + shiftMs; // microseconds
      if (n > 1e11) return n + shiftMs;
      if (n > 1e8) return n * 1000 + shiftMs;
      return NaN;
    }
    if (/^\d{2}\/\w{3}\/\d{4}:\d{2}:\d{2}:\d{2}/.test(s)) return parseClfTime(s);
    const m = ISO_RE.exec(s);
    if (m) {
      const ms = m[7] ? Math.round(parseFloat(m[7]) * 1000) : 0;
      const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0), ms);
      return m[8] === 'Z' ? wall + shiftMs : wall;
    }
    const d = Date.parse(s);
    return isNaN(d) ? NaN : d + shiftMs;
  }

  // ---------------------------------------------------------------- helpers
  // split on single spaces, keeping "double quoted" fields together (quotes removed)
  function splitQuoted(line) {
    const out = [];
    let i = 0;
    const n = line.length;
    while (i < n) {
      if (line.charCodeAt(i) === 34) {
        let j = i + 1, s = '';
        while (j < n) {
          const c = line.charCodeAt(j);
          if (c === 92 && j + 1 < n) { s += line[j + 1]; j += 2; continue; }
          if (c === 34) break;
          s += line[j]; j++;
        }
        out.push(s);
        i = j + 2;
      } else {
        let j = line.indexOf(' ', i);
        if (j < 0) j = n;
        out.push(line.slice(i, j));
        i = j + 1;
      }
    }
    return out;
  }

  function splitCsv(line, d) {
    if (line.indexOf('"') < 0) return line.split(d);
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
      } else if (c === '"') q = true;
      else if (c === d) { out.push(cur); cur = ''; } else cur += c;
    }
    out.push(cur);
    return out;
  }

  function stripHost(u) {
    if (u.charCodeAt(0) !== 47 && /^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
      const k = u.indexOf('/', u.indexOf('//') + 2);
      return k < 0 ? '/' : u.slice(k);
    }
    return u;
  }

  function stripQuery(p) {
    let k = p.length;
    for (let i = 0; i < p.length; i++) {
      const c = p.charCodeAt(i);
      if (c === 63 || c === 35 || c === 59) { k = i; break; } // ? # ;
    }
    return k === p.length ? p : p.slice(0, k);
  }

  function getPath(obj, key) {
    if (!key) return undefined;
    if (key in obj) return obj[key];
    let cur = obj;
    for (const part of key.split('.')) {
      if (cur == null || typeof cur !== 'object') return undefined;
      cur = cur[part];
    }
    return cur;
  }

  function flattenKeys(obj, prefix, out, depth) {
    out = out || []; prefix = prefix || ''; depth = depth || 0;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && depth < 3) flattenKeys(v, prefix + k + '.', out, depth + 1);
      else out.push(prefix + k);
    }
    return out;
  }

  function splitRequest(rec, req) {
    // "GET /path HTTP/1.1"
    const a = req.indexOf(' ');
    if (a < 0) { rec.method = ''; rec.path = req === '-' ? '' : req; return; }
    rec.method = req.slice(0, a);
    const b = req.indexOf(' ', a + 1);
    rec.path = stripHost(b < 0 ? req.slice(a + 1) : req.slice(a + 1, b));
  }

  // ---------------------------------------------------------------- formats
  const FORMAT_LABELS = {
    clf: 'nginx / Apache access log (combined or common)',
    alb: 'AWS Application Load Balancer access log',
    cloudfront: 'AWS CloudFront standard log',
    iis: 'IIS W3C extended log',
    csv: 'CSV / delimited file',
    jsonl: 'JSON lines'
  };

  const CLF_RE = /^(\S+) \S+ \S+ \[([^\]]+)\] "((?:[^"\\]|\\.)*)" (\d{3}|-) (\S+)(.*)$/;
  const CLF_TAIL_RE = /^ "((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)"(.*)$/;
  const RT_KV_RE = /(?:^|\s)(?:rt|request_time|rtime|reqtime|duration|upstream_response_time|urt)[=:]"?([\d.]+)/;
  const ALB_RE = /^(?:https?|h2|grpcs|wss?) \d{4}-\d{2}-\d{2}T/;
  const CF_DEFAULT = 'date time x-edge-location sc-bytes c-ip cs-method cs(host) cs-uri-stem sc-status cs(referer) cs(user-agent) cs-uri-query cs(cookie) x-edge-result-type x-edge-request-id x-host-header cs-protocol cs-bytes time-taken x-forwarded-for ssl-protocol ssl-cipher x-edge-response-result-type cs-protocol-version fle-status fle-encrypted-fields c-port time-to-first-byte x-edge-detailed-result-type sc-content-type sc-content-len sc-range-start sc-range-end'.split(' ');
  const IIS_DEFAULT = 'date time s-ip cs-method cs-uri-stem cs-uri-query s-port cs-username c-ip cs(user-agent) cs(referer) sc-status sc-substatus sc-win32-status time-taken'.split(' ');

  function clfExtraRt(extra) {
    if (!extra) return NaN;
    const kv = RT_KV_RE.exec(extra);
    if (kv) return parseFloat(kv[1]) * 1000;
    const toks = extra.trim().split(/\s+/);
    for (const t of toks) {
      if (/^\d+\.\d+$/.test(t)) return parseFloat(t) * 1000; // nginx $request_time (seconds)
      if (/^\d+$/.test(t)) return parseInt(t, 10) / 1000; // Apache %D (microseconds)
    }
    return NaN;
  }

  function createParser(fmt, opts) {
    opts = opts || {};
    const shift = (opts.tzShiftMin || 0) * 60000;
    const format = fmt.format || fmt;
    let lastTs = '', lastT = NaN;

    if (format === 'clf') {
      return function (line, rec) {
        const m = CLF_RE.exec(line);
        if (!m) return false;
        rec.ip = m[1];
        const ts = m[2].slice(0, 20);
        if (ts !== lastTs) { lastTs = ts; lastT = parseClfTime(ts); }
        rec.t = lastT;
        splitRequest(rec, m[3]);
        rec.status = m[4] === '-' ? 0 : +m[4];
        const tail = CLF_TAIL_RE.exec(m[6]);
        if (tail) { rec.ua = tail[2]; rec.rt = clfExtraRt(tail[3]); } else { rec.ua = ''; rec.rt = clfExtraRt(m[6]); }
        return true;
      };
    }

    if (format === 'alb') {
      return function (line, rec) {
        if (line.length < 40) return false;
        const f = splitQuoted(line);
        if (f.length < 14) return false;
        const ts = f[1];
        if (ts.slice(0, 19) !== lastTs) { lastTs = ts.slice(0, 19); lastT = parseAnyTime(lastTs + 'Z', shift); }
        rec.t = lastT + (ts[19] === '.' ? Math.floor(parseFloat('0' + ts.slice(19, 26)) * 1000) : 0);
        const c = f[3], k = c.lastIndexOf(':');
        rec.ip = k > 0 ? c.slice(0, k) : c;
        const a = +f[5], b = +f[6], d = +f[7];
        rec.rt = a < 0 || b < 0 || d < 0 || isNaN(a + b + d) ? NaN : (a + b + d) * 1000;
        rec.status = f[8] === '-' ? 0 : +f[8];
        splitRequest(rec, f[12]);
        rec.ua = f[13] || '';
        return true;
      };
    }

    if (format === 'cloudfront' || format === 'iis' || format === 'w3c') {
      let idx = null;
      let seconds = format === 'cloudfront';
      function setFields(names) {
        names = names.map(s => s.toLowerCase());
        const at = n => names.indexOf(n);
        idx = {
          date: at('date'), time: at('time'), method: at('cs-method'), stem: at('cs-uri-stem'),
          status: at('sc-status'), ua: at('cs(user-agent)'), ip: at('c-ip'), tt: at('time-taken'),
          n: names.length
        };
        seconds = names.indexOf('x-edge-location') >= 0;
      }
      if (fmt.fields) setFields(fmt.fields);
      return function (line, rec) {
        if (line.charCodeAt(0) === 35) { // '#'
          if (/^#Fields:/i.test(line)) setFields(line.slice(8).trim().split(/\s+/));
          return 'skip';
        }
        const tab = line.indexOf('\t') >= 0;
        if (!idx) setFields(tab ? CF_DEFAULT : IIS_DEFAULT);
        const f = tab ? line.split('\t') : line.split(' ');
        if (f.length < 5 || idx.date < 0 || idx.time < 0) return false;
        const ts = f[idx.date] + 'T' + f[idx.time];
        if (ts !== lastTs) { lastTs = ts; lastT = parseAnyTime(ts.slice(0, 19) + 'Z', shift); }
        if (isNaN(lastT)) return false;
        rec.t = lastT;
        rec.method = idx.method >= 0 ? f[idx.method] : 'GET';
        rec.path = idx.stem >= 0 ? f[idx.stem] : '/';
        rec.status = idx.status >= 0 ? +f[idx.status] || 0 : 0;
        rec.ua = idx.ua >= 0 ? f[idx.ua] || '' : '';
        rec.ip = idx.ip >= 0 ? f[idx.ip] || '' : '';
        const tt = idx.tt >= 0 ? parseFloat(f[idx.tt]) : NaN;
        rec.rt = isNaN(tt) ? NaN : seconds ? tt * 1000 : tt;
        return true;
      };
    }

    if (format === 'csv' || format === 'jsonl') {
      const map = fmt.mapping || {};
      const unit = { ms: 1, s: 1000, us: 0.001 }[fmt.rtUnit || 'ms'] || 1;
      const isCsv = format === 'csv';
      const d = fmt.delimiter || ',';
      const header = fmt.headerLine || null;
      const get = isCsv
        ? (f, k) => (k == null || k === '' || k < 0 ? undefined : f[k])
        : (f, k) => (k == null || k === '' ? undefined : getPath(f, k));
      return function (line, rec) {
        let f;
        if (isCsv) {
          if (header && line === header) return 'skip';
          f = splitCsv(line, d);
        } else {
          if (line.charCodeAt(0) !== 123) return false;
          try { f = JSON.parse(line); } catch (e) { return false; }
        }
        const t = get(f, map.time);
        rec.t = parseAnyTime(t, shift);
        if (isNaN(rec.t)) return false;
        let p = get(f, map.path);
        let method = get(f, map.method);
        p = p == null ? '' : String(p);
        if (!method && /^[A-Z]+ \S+/.test(p)) splitRequest(rec, p);
        else { rec.method = method ? String(method) : 'GET'; rec.path = stripHost(p); }
        const st = get(f, map.status);
        rec.status = st == null ? 0 : parseInt(st, 10) || 0;
        const rt = get(f, map.rt);
        rec.rt = rt == null || rt === '' ? NaN : parseFloat(rt) * unit;
        const ip = get(f, map.ip), ua = get(f, map.ua);
        rec.ip = ip == null ? '' : String(ip);
        rec.ua = ua == null ? '' : String(ua);
        return true;
      };
    }
    throw new Error('Unknown log format: ' + format);
  }

  // ---------------------------------------------------------------- detection
  const GUESS = {
    time: /^(@?timestamp|time|ts|date_?time|datetime|time_?local|time_?iso8601|request_?time_?stamp|start_?time|logged_?at|date)$/i,
    method: /^(method|request_?method|http_?method|verb|cs-method|httpmethod)$/i,
    path: /^(path|uri|url|request_?uri|request_?path|endpoint|route|request|cs-uri-stem|target)$/i,
    status: /^(status|status_?code|response_?code|http_?status|sc-status|code|statuscode)$/i,
    rt: /^(response_?time|request_?time|duration|latency|elapsed|time_?taken|rt|took|ms|millis|time_?ms|response_?time_?ms|duration_?ms|elapsed_?ms|latency_?ms)$/i,
    ip: /^(ip|client_?ip|remote_?addr|remote_?ip|c-ip|clientip|client|source_?ip|x_?forwarded_?for)$/i,
    ua: /^(ua|user_?agent|http_?user_?agent|useragent|agent)$/i
  };

  function guessMapping(names, rows) {
    const map = {};
    const last = n => n.split('.').pop();
    for (const k of Object.keys(GUESS)) {
      let hit = names.findIndex(n => GUESS[k].test(last(n)));
      if (hit < 0) hit = names.findIndex(n => GUESS[k].test(n.replace(/[.\s]/g, '_')));
      map[k] = hit;
    }
    // content-based fallbacks
    if (rows && rows.length) {
      const col = (i) => rows.map(r => r[i]).filter(v => v != null && v !== '');
      const used = () => new Set(Object.values(map).filter(v => v >= 0));
      names.forEach((n, i) => {
        if (used().has(i)) return;
        const vals = col(i).map(String);
        if (!vals.length) return;
        const all = re => vals.every(v => re.test(v));
        if (map.method < 0 && all(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/)) map.method = i;
        else if (map.status < 0 && all(/^[1-5]\d\d$/)) map.status = i;
        else if (map.path < 0 && all(/^(\/|https?:\/\/|[A-Z]+ \/)/)) map.path = i;
        else if (map.time < 0 && vals.every(v => !isNaN(parseAnyTime(v)))) map.time = i;
      });
    }
    return map;
  }

  function detectFormat(text) {
    const lines = String(text).split(/\r?\n/).filter(l => l.trim() !== '').slice(0, 200);
    if (!lines.length) return null;
    const fieldsLine = lines.find(l => /^#Fields:/i.test(l));
    if (fieldsLine) {
      const fields = fieldsLine.slice(8).trim().split(/\s+/);
      const cf = fields.map(s => s.toLowerCase()).indexOf('x-edge-location') >= 0;
      return { format: cf ? 'cloudfront' : 'iis', label: FORMAT_LABELS[cf ? 'cloudfront' : 'iis'], fields };
    }
    const data = lines.filter(l => l[0] !== '#');
    const first = data[0];
    if (!first) return null;
    if (first[0] === '{') {
      let obj = null;
      try { obj = JSON.parse(first); } catch (e) { /* fallthrough */ }
      if (obj) {
        const names = flattenKeys(obj);
        const rows = data.slice(0, 20).map(l => { try { const o = JSON.parse(l); return names.map(n => getPath(o, n)); } catch (e) { return []; } });
        const gm = guessMapping(names, rows);
        const mapping = {};
        for (const k of Object.keys(gm)) mapping[k] = gm[k] >= 0 ? names[gm[k]] : '';
        return { format: 'jsonl', label: FORMAT_LABELS.jsonl, columns: names, mapping, rtUnit: guessRtUnit(rows.map(r => r[gm.rt])) };
      }
    }
    const clfHits = data.slice(0, 20).filter(l => CLF_RE.test(l)).length;
    if (clfHits && clfHits >= Math.min(20, data.length) * 0.6) return { format: 'clf', label: FORMAT_LABELS.clf };
    if (ALB_RE.test(first)) return { format: 'alb', label: FORMAT_LABELS.alb };
    if (/^\d{4}-\d{2}-\d{2}\t\d{2}:\d{2}:\d{2}\t/.test(first)) return { format: 'cloudfront', label: FORMAT_LABELS.cloudfront, fields: CF_DEFAULT };
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} /.test(first) && first.split(' ').length >= 10) return { format: 'iis', label: FORMAT_LABELS.iis, fields: IIS_DEFAULT };
    // delimited
    const cands = [',', '\t', ';', '|'];
    let best = null, bestN = 0;
    for (const d of cands) {
      const n = splitCsv(first, d).length;
      if (n > bestN) { bestN = n; best = d; }
    }
    if (bestN >= 3) {
      const head = splitCsv(first, best).map(s => s.trim());
      const rest = data.slice(1, 21).map(l => splitCsv(l, best));
      const looksHeader = head.every(h => isNaN(parseAnyTime(h)) && !/^\d+(\.\d+)?$/.test(h) && !/^\//.test(h));
      const names = looksHeader ? head : head.map((_, i) => 'Column ' + (i + 1));
      const rows = looksHeader ? rest : [splitCsv(first, best)].concat(rest);
      const gm = guessMapping(names, rows);
      return {
        format: 'csv', label: FORMAT_LABELS.csv, delimiter: best, columns: names, mapping: gm,
        headerLine: looksHeader ? first : null, rtUnit: guessRtUnit(rows.map(r => r[gm.rt]))
      };
    }
    return null;
  }

  function guessRtUnit(vals) {
    const nums = vals.map(v => parseFloat(v)).filter(v => !isNaN(v));
    if (!nums.length) return 'ms';
    const sorted = nums.slice().sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    const hasDecimals = vals.some(v => /\.\d/.test(String(v)));
    if (med < 30 && hasDecimals) return 's';
    if (med > 100000) return 'us';
    return 'ms';
  }

  // ---------------------------------------------------------------- normalisation
  const DEFAULT_RULES = [
    { name: 'UUID', re: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i },
    { name: 'number', re: /^\d+$/ },
    { name: 'long hex (16+ chars)', re: /^[0-9a-f]{16,}$/i },
    { name: 'email', re: /^[^@/\s]+(@|%40)[^@/\s]+\.[a-z]{2,}$/i },
    { name: 'long token (20+ letters and digits)', re: /^(?=[A-Za-z_-]*\d)(?=[\d_-]*[A-Za-z])[A-Za-z0-9_-]{20,}$/ }
  ];

  function parseRules(text) {
    const rules = [], errors = [];
    String(text || '').split(/\r?\n/).forEach((raw, i) => {
      const line = raw.trim();
      if (!line || line[0] === '#') return;
      const k = line.indexOf('=>');
      if (k < 0) { errors.push('Line ' + (i + 1) + ': use  pattern => replacement'); return; }
      const pat = line.slice(0, k).trim(), rep = line.slice(k + 2).trim();
      try { rules.push({ re: new RegExp(pat), rep, src: pat }); } catch (e) { errors.push('Line ' + (i + 1) + ': ' + e.message); }
    });
    return { rules, errors };
  }

  function normalisePath(raw, userRules) {
    let p = stripQuery(stripHost(raw || ''));
    if (!p || p[0] !== '/') p = '/' + p;
    if (p.length > 1 && p.endsWith('/')) p = p.replace(/\/+$/, '') || '/';
    const segs = p.split('/');
    for (let i = 1; i < segs.length; i++) {
      const s = segs[i];
      if (!s) continue;
      let hit = false;
      for (const r of DEFAULT_RULES) { if (r.re.test(s)) { segs[i] = '{id}'; hit = true; break; } }
      if (!hit) {
        // an ID with a file extension: /images/123.jpg -> /images/{id}.jpg
        const m = /^(.+?)(\.[A-Za-z0-9]{1,5})$/.exec(s);
        if (m) for (const r of DEFAULT_RULES) { if (r.re.test(m[1])) { segs[i] = '{id}' + m[2]; break; } }
      }
    }
    p = segs.join('/');
    if (userRules) for (const r of userRules) p = p.replace(r.re, r.rep);
    return p;
  }

  const STATIC_RE = /\.(?:js|mjs|css|map|png|jpe?g|gif|svg|ico|webp|avif|bmp|woff2?|ttf|otf|eot|mp4|webm|mp3)$/i;
  const BOT_UA_RE = /bot\b|bot\/|crawl|spider|slurp|pingdom|uptimerobot|statuscake|health-?check|kube-probe|monitor/i;
  const HEALTH_RE = /^\/(?:health|healthz|healthcheck|health-check|ready|readyz|live|livez|ping|_health|actuator\/health)(?:\/|$)/i;

  // 0 = normal traffic, 1 = static asset, 2 = health check or bot
  function classify(path, ua) {
    if (HEALTH_RE.test(path) || (ua && BOT_UA_RE.test(ua))) return 2;
    if (STATIC_RE.test(path)) return 1;
    return 0;
  }

  // ---------------------------------------------------------------- histograms
  const HB = 1.15, NB = 90;
  const LOG_HB = Math.log(HB);
  function bucketOf(ms) { return ms < 1 ? 0 : Math.min(NB - 1, 1 + Math.floor(Math.log(ms) / LOG_HB)); }
  function bucketMid(i) { return i === 0 ? 0.5 : Math.pow(HB, i - 0.5); }
  function histQuantile(h, q) {
    let n = 0;
    for (let i = 0; i < h.length; i++) n += h[i];
    if (!n) return NaN;
    const target = Math.ceil(q * n);
    let c = 0;
    for (let i = 0; i < h.length; i++) { c += h[i]; if (c >= target) return bucketMid(i); }
    return bucketMid(h.length - 1);
  }

  function hash32(s, seed) {
    let h = seed >>> 0;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  // ---------------------------------------------------------------- aggregation
  const MAX_KEYS = 5000;
  const SESSION_GAP = 30 * 60 * 1000;
  const MAX_VISITORS = 3000000;

  function createAggregator(opts) {
    opts = opts || {};
    const userRules = opts.rules || null;
    const keys = new Map();
    const list = [];
    const secs = [new Map(), new Map(), new Map()];
    const normCache = new Map();
    let lines = 0, parsed = 0, unparsed = 0, noRequest = 0, overflow = 0, rtSeen = 0, visitorSeen = 0;
    let unparsedSample = '';
    let minT = Infinity, maxT = -Infinity;
    // sessions
    const vIndex = new Map();
    let vLast = new Float64Array(1024), vStart = new Float64Array(1024), vN = new Int32Array(1024), vCount = 0;
    const durHist = new Uint32Array(NB), thinkHist = new Uint32Array(NB), pagesHist = new Uint32Array(201);
    let sessions = 0, visitorsCapped = false;

    function closeSession(i) {
      sessions++;
      durHist[bucketOf(vLast[i] - vStart[i])]++; // ms
      pagesHist[Math.min(200, vN[i])]++;
    }

    function norm(path) {
      let v = normCache.get(path);
      if (v === undefined) {
        if (normCache.size > 50000) normCache.clear();
        const p = stripQuery(stripHost(path));
        v = { p: normalisePath(p, userRules), stat: STATIC_RE.test(p), health: HEALTH_RE.test(p) };
        normCache.set(path, v);
      }
      return v;
    }

    function add(rec) {
      lines++;
      const t = rec.t;
      if (!(t > 0)) { unparsed++; return; }
      if (!rec.path) { noRequest++; return; }
      parsed++;
      if (t < minT) minT = t;
      if (t > maxT) maxT = t;
      const n = norm(rec.path);
      const cls = n.health || (rec.ua && BOT_UA_RE.test(rec.ua)) ? 2 : n.stat ? 1 : 0;
      let method = rec.method ? rec.method.toUpperCase() : 'GET';
      if (!/^[A-Z]{3,7}$/.test(method)) method = 'OTHER';
      const k = cls + ' ' + method + ' ' + n.p;
      let e = keys.get(k);
      if (!e) {
        if (list.length >= MAX_KEYS) {
          overflow++;
          const ok = cls + ' ' + method + ' (other endpoints)';
          e = keys.get(ok);
          if (!e) { e = newKey(cls, method, '(other endpoints)'); keys.set(ok, e); }
        } else { e = newKey(cls, method, n.p); keys.set(k, e); }
      }
      const sec = Math.floor(t / 1000);
      const sm = secs[cls];
      sm.set(sec, (sm.get(sec) || 0) + 1);
      const hour = Math.floor(sec / 3600);
      let hs = e.lastHour === hour ? e.lastStats : e.hours.get(hour);
      if (!hs) { hs = { n: 0, e5: 0, e4: 0, rtN: 0, rtSum: 0, hist: null }; e.hours.set(hour, hs); }
      e.lastHour = hour; e.lastStats = hs;
      hs.n++;
      const st = rec.status;
      if (st >= 500) hs.e5++; else if (st >= 400) hs.e4++;
      const rt = rec.rt;
      if (rt >= 0) {
        rtSeen++;
        hs.rtN++; hs.rtSum += rt;
        if (!hs.hist) hs.hist = new Uint32Array(NB);
        hs.hist[bucketOf(rt)]++;
      }
      if (cls === 0 && rec.ip && rec.ip !== '-') {
        visitorSeen++;
        const ua = rec.ua || '';
        const vk = hash32(rec.ip + '\u0001' + ua, 2166136261) * 2097152 + (hash32(ua + '\u0002' + rec.ip, 374761393) & 0x1fffff);
        let i = vIndex.get(vk);
        if (i === undefined) {
          if (vCount >= MAX_VISITORS) { visitorsCapped = true; return; }
          if (vCount === vLast.length) {
            const g = (a, C) => { const b = new C(a.length * 2); b.set(a); return b; };
            vLast = g(vLast, Float64Array); vStart = g(vStart, Float64Array); vN = g(vN, Int32Array);
          }
          i = vCount++;
          vIndex.set(vk, i);
          vLast[i] = t; vStart[i] = t; vN[i] = 1;
          return;
        }
        const gap = t - vLast[i];
        if (gap < 0) { vN[i]++; return; } // out of order: count it, don't move time back
        if (gap > SESSION_GAP) { closeSession(i); vStart[i] = t; vLast[i] = t; vN[i] = 1; return; }
        if (gap >= 1000) thinkHist[bucketOf(gap)]++;
        vLast[i] = t; vN[i]++;
      }
    }

    function newKey(cls, method, ep) {
      const e = { cls, method, ep, hours: new Map(), lastHour: -1, lastStats: null };
      list.push(e);
      return e;
    }

    function finish(extra) {
      for (let i = 0; i < vCount; i++) closeSession(i);
      // seconds -> sorted typed arrays
      const all = new Set();
      for (const m of secs) for (const s of m.keys()) all.add(s);
      const T = Float64Array.from(all).sort();
      const C = [new Int32Array(T.length), new Int32Array(T.length), new Int32Array(T.length)];
      for (let i = 0; i < T.length; i++) for (let c = 0; c < 3; c++) C[c][i] = secs[c].get(T[i]) || 0;
      const endpoints = list.map(e => {
        const hrs = Array.from(e.hours.keys()).sort((a, b) => a - b);
        const H = { h: Int32Array.from(hrs), n: new Int32Array(hrs.length), e5: new Int32Array(hrs.length), e4: new Int32Array(hrs.length),
          rtN: new Int32Array(hrs.length), rtSum: new Float64Array(hrs.length), hist: [] };
        hrs.forEach((h, i) => { const s = e.hours.get(h); H.n[i] = s.n; H.e5[i] = s.e5; H.e4[i] = s.e4; H.rtN[i] = s.rtN; H.rtSum[i] = s.rtSum; H.hist.push(s.hist); });
        return { cls: e.cls, method: e.method, ep: e.ep, hours: H };
      });
      return Object.assign({
        lines, parsed, unparsed, noRequest, unparsedSample, overflow,
        minT: isFinite(minT) ? minT : 0, maxT: isFinite(maxT) ? maxT : 0,
        hasRt: rtSeen > 0, rtShare: parsed ? rtSeen / parsed : 0, hasVisitor: visitorSeen > 0,
        seconds: { t: T, c: C },
        endpoints,
        sessions: { count: sessions, visitors: vCount, capped: visitorsCapped, durHist, thinkHist, pagesHist }
      }, extra || {});
    }

    return {
      add, finish,
      noteUnparsed(line) { lines++; unparsed++; if (!unparsedSample) unparsedSample = line.slice(0, 300); }
    };
  }

  // Convenience: parse a whole text in one go (tests, paste box, sample)
  function analyseText(text, opts) {
    opts = opts || {};
    const fmt = opts.format && opts.format !== 'auto' ? opts.formatInfo || { format: opts.format } : detectFormat(text);
    if (!fmt) throw new Error('Could not recognise the log format.');
    const parse = createParser(fmt, opts);
    const agg = createAggregator(opts);
    const rec = { t: 0, method: '', path: '', status: 0, rt: NaN, ip: '', ua: '' };
    for (const raw of String(text).split('\n')) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (!line) continue;
      const ok = parse(line, rec);
      if (ok === 'skip') continue;
      if (!ok) agg.noteUnparsed(line); else agg.add(rec);
    }
    return agg.finish({ format: fmt.format, formatLabel: FORMAT_LABELS[fmt.format] || fmt.format });
  }

  // ---------------------------------------------------------------- model
  const DEFAULTS = {
    excludeStatic: true, excludeBots: true, merges: {}, growth: 1.5, headroom: 20, basis: 'p99', coverage: 1,
    rtMs: null, thinkS: null, topN: 8, profile: 'ramp', durationMin: 30, rampMin: 5, compressMin: 24, baseUrl: 'https://staging.example.com'
  };

  function percentileSorted(a, q) {
    if (!a.length) return 0;
    return a[Math.min(a.length - 1, Math.max(0, Math.ceil(q * a.length) - 1))];
  }

  function buildModel(res, settings) {
    const s = Object.assign({}, DEFAULTS, settings || {});
    const inc = [true, !s.excludeStatic, !s.excludeBots];
    const T = res.seconds.t, C = res.seconds.c;
    const n = T.length;
    const per = new Int32Array(n);
    let total = 0;
    for (let i = 0; i < n; i++) {
      let v = 0;
      for (let c = 0; c < 3; c++) if (inc[c]) v += C[c][i];
      per[i] = v; total += v;
    }
    const excluded = { static: 0, bots: 0 };
    for (let i = 0; i < n; i++) { if (!inc[1]) excluded.static += C[1][i]; if (!inc[2]) excluded.bots += C[2][i]; }

    // hour + minute totals
    const hourMap = new Map(), minMap = new Map();
    let maxSec = 0, maxSecT = 0;
    for (let i = 0; i < n; i++) {
      const v = per[i];
      if (!v) continue;
      const sec = T[i];
      const h = Math.floor(sec / 3600), m = Math.floor(sec / 60);
      hourMap.set(h, (hourMap.get(h) || 0) + v);
      minMap.set(m, (minMap.get(m) || 0) + v);
      if (v > maxSec) { maxSec = v; maxSecT = sec; }
    }
    let peakHour = 0, peakHourN = 0;
    for (const [h, v] of hourMap) if (v > peakHourN || (v === peakHourN && h < peakHour)) { peakHour = h; peakHourN = v; }
    let peakMin = 0, peakMinN = 0;
    for (const [m, v] of minMap) if (v > peakMinN || (v === peakMinN && m < peakMin)) { peakMin = m; peakMinN = v; }

    // per-second counts within the peak hour (zeros included)
    const hourSecs = new Int32Array(3600);
    const h0 = peakHour * 3600;
    for (let i = 0; i < n; i++) { const d = T[i] - h0; if (d >= 0 && d < 3600) hourSecs[d] = per[i]; }
    const spanStart = Math.max(h0, Math.floor((res.minT || 0) / 1000)), spanEnd = Math.min(h0 + 3599, Math.floor((res.maxT || 0) / 1000));
    const activeSecs = Math.max(1, spanEnd - spanStart + 1);
    const sortedSecs = Array.from(hourSecs.slice(spanStart - h0, spanStart - h0 + activeSecs)).sort((a, b) => a - b);
    const p99Sec = percentileSorted(sortedSecs, 0.99);
    const p95Sec = percentileSorted(sortedSecs, 0.95);

    const peak = {
      hourStart: h0 * 1000, hourCount: peakHourN, hourAvgRps: peakHourN / activeSecs, hourSeconds: activeSecs,
      minuteStart: peakMin * 60000, minuteCount: peakMinN, minuteRps: peakMinN / Math.min(60, activeSecs),
      maxSecRps: maxSec, maxSecT: maxSecT * 1000, p99SecRps: p99Sec, p95SecRps: p95Sec
    };

    // hour-of-day curve (average per hour of day across the hours the log spans)
    const firstH = Math.floor((res.minT || 0) / 3600000), lastH = Math.floor((res.maxT || 0) / 3600000);
    const hodSum = new Float64Array(24), hodCnt = new Float64Array(24);
    for (let h = firstH; h <= lastH && lastH - firstH < 24 * 400; h++) { hodSum[((h % 24) + 24) % 24] += hourMap.get(h) || 0; hodCnt[((h % 24) + 24) % 24]++; }
    const hod = Array.from(hodSum, (v, i) => (hodCnt[i] ? v / hodCnt[i] / 3600 : 0));

    // endpoint groups (filters + merges)
    const groups = new Map();
    for (const e of res.endpoints) {
      if (!inc[e.cls]) continue;
      const label = e.method + ' ' + e.ep;
      const gname = (s.merges && s.merges[label]) || label;
      let g = groups.get(gname);
      if (!g) { g = { label: gname, merged: !!(s.merges && s.merges[label]), members: [], total: 0, n: 0, e5: 0, e4: 0, rtN: 0, rtSum: 0, hist: null, allHist: null, allRtN: 0, allRtSum: 0 }; groups.set(gname, g); }
      let mPeak = 0, mTotal = 0;
      const H = e.hours;
      for (let i = 0; i < H.h.length; i++) {
        mTotal += H.n[i];
        if (H.hist[i]) { if (!g.allHist) g.allHist = new Uint32Array(NB); addHist(g.allHist, H.hist[i]); g.allRtN += H.rtN[i]; g.allRtSum += H.rtSum[i]; }
        if (H.h[i] === peakHour) {
          mPeak += H.n[i];
          g.n += H.n[i]; g.e5 += H.e5[i]; g.e4 += H.e4[i]; g.rtN += H.rtN[i]; g.rtSum += H.rtSum[i];
          if (H.hist[i]) { if (!g.hist) g.hist = new Uint32Array(NB); addHist(g.hist, H.hist[i]); }
        }
      }
      g.total += mTotal;
      const existing = g.members.find(m => m.label === label);
      if (existing) { existing.peak += mPeak; existing.total += mTotal; } else g.members.push({ label, method: e.method, ep: e.ep, cls: e.cls, peak: mPeak, total: mTotal });
    }
    const peakTotal = Array.from(groups.values()).reduce((a, g) => a + g.n, 0) || 1;
    const mix = Array.from(groups.values()).filter(g => g.n > 0).map(g => {
      g.members.sort((a, b) => b.peak - a.peak);
      const methods = Array.from(new Set(g.members.map(m => m.method)));
      return {
        label: g.label, merged: g.merged || g.members.length > 1, members: g.members, method: methods.join('/'),
        endpoint: g.merged ? g.label : g.members[0].ep,
        count: g.n, total: g.total, share: g.n / peakTotal, rps: g.n / activeSecs,
        p95: g.hist ? histQuantile(g.hist, 0.95) : NaN, mean: g.rtN ? g.rtSum / g.rtN : NaN, rtN: g.rtN,
        errPct: g.n ? (g.e5 / g.n) * 100 : 0, err4Pct: g.n ? (g.e4 / g.n) * 100 : 0
      };
    }).sort((a, b) => b.count - a.count || (a.label < b.label ? -1 : 1));

    // overall response times in peak hour
    let rtN = 0, rtSum = 0;
    const allH = new Uint32Array(NB);
    for (const g of groups.values()) { rtN += g.rtN; rtSum += g.rtSum; if (g.hist) addHist(allH, g.hist); }
    const overallP95 = rtN ? histQuantile(allH, 0.95) : NaN;
    const overallMean = rtN ? rtSum / rtN : NaN;

    // sessions
    const ss = res.sessions;
    let sessions = null;
    if (res.hasVisitor && ss && ss.count > 0) {
      sessions = {
        count: ss.count, visitors: ss.visitors, capped: ss.capped,
        durationMedianS: histQuantile(ss.durHist, 0.5) / 1000,
        pagesMedian: medianLinear(ss.pagesHist), pagesMean: meanLinear(ss.pagesHist),
        thinkMedianS: histQuantile(ss.thinkHist, 0.5) / 1000, thinkSamples: sumArr(ss.thinkHist)
      };
      if (!sessions.thinkSamples) sessions.thinkMedianS = NaN;
    }

    // load model
    const bases = { p99: peak.p99SecRps, minute: peak.minuteRps, hour: peak.hourAvgRps, max: peak.maxSecRps };
    const base = bases[s.basis] != null ? bases[s.basis] : peak.p99SecRps;
    const coverage = Math.max(1, +s.coverage || 1);
    const target = base * coverage * (+s.growth || 1) * (1 + (+s.headroom || 0) / 100);
    const rtMs = s.rtMs != null && s.rtMs !== '' && !isNaN(s.rtMs) ? +s.rtMs : !isNaN(overallMean) ? overallMean : 300;
    const rtSource = s.rtMs != null && s.rtMs !== '' && !isNaN(s.rtMs) ? 'you' : !isNaN(overallMean) ? 'logs' : 'default';
    const sessThink = sessions && !isNaN(sessions.thinkMedianS) ? sessions.thinkMedianS : NaN;
    const thinkS = s.thinkS != null && s.thinkS !== '' && !isNaN(s.thinkS) ? +s.thinkS : !isNaN(sessThink) ? sessThink : 5;
    const thinkSource = s.thinkS != null && s.thinkS !== '' && !isNaN(s.thinkS) ? 'you' : !isNaN(sessThink) ? 'logs' : 'default';
    const lit = littlesLaw(target, rtMs / 1000, thinkS);
    const p95ForVus = !isNaN(overallP95) ? overallP95 : rtMs * 2;
    const model = {
      base, basis: s.basis, coverage, growth: +s.growth || 1, headroom: +s.headroom || 0, target,
      rtMs, rtSource, thinkS, thinkSource, usersClosed: lit.users, inFlight: lit.inFlight,
      preAllocatedVUs: Math.max(2, Math.ceil(target * (p95ForVus / 1000) * 1.5))
    };

    return {
      settings: s, total, excluded, peak, hod, mix, hourSecs, hourSecStart: spanStart - h0, hourSecEnd: spanStart - h0 + activeSecs, peakTotal, overallP95, overallMean, sessions, model,
      hourMap, minMap, per, T, hasRt: res.hasRt, format: res.format, formatLabel: res.formatLabel
    };
  }

  function littlesLaw(throughput, rtS, thinkS) {
    return { users: throughput * (rtS + (thinkS || 0)), inFlight: throughput * rtS };
  }

  function addHist(a, b) { for (let i = 0; i < a.length; i++) a[i] += b[i]; }
  function sumArr(a) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; }
  function medianLinear(h) {
    const n = sumArr(h); if (!n) return NaN;
    let c = 0; for (let i = 0; i < h.length; i++) { c += h[i]; if (c >= n / 2) return i; }
    return h.length - 1;
  }
  function meanLinear(h) {
    const n = sumArr(h); if (!n) return NaN;
    let s = 0; for (let i = 0; i < h.length; i++) s += i * h[i];
    return s / n;
  }

  // ---------------------------------------------------------------- exports
  function fmtNum(x, d) {
    if (x == null || isNaN(x)) return '';
    return String(Math.round(x * Math.pow(10, d || 0)) / Math.pow(10, d || 0));
  }
  function csvCell(v) {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function mixToCsv(m) {
    const rows = [['endpoint', 'method', 'count_peak_hour', 'percent', 'req_per_s_peak_hour', 'req_per_s_target', 'p95_ms', 'error_5xx_percent']];
    for (const r of m.mix) rows.push([r.endpoint, r.method, r.count, fmtNum(r.share * 100, 3), fmtNum(r.rps, 3), fmtNum(r.share * m.model.target, 3), fmtNum(r.p95, 0), fmtNum(r.errPct, 2)]);
    return rows.map(r => r.map(csvCell).join(',')).join('\n') + '\n';
  }

  function mixToJson(m) {
    return JSON.stringify({
      generator: 'https://pawansinha.com.au/tools/workload-model/',
      peakHourStart: new Date(m.peak.hourStart).toISOString().slice(0, 16).replace('T', ' '),
      peak: {
        hourAvgRps: +fmtNum(m.peak.hourAvgRps, 3), minuteRps: +fmtNum(m.peak.minuteRps, 3),
        p99SecondRps: m.peak.p99SecRps, maxSecondRps: m.peak.maxSecRps
      },
      model: {
        basis: m.model.basis, growth: m.model.growth, headroomPercent: m.model.headroom, coverage: m.model.coverage,
        targetRps: +fmtNum(m.model.target, 3), responseTimeMs: +fmtNum(m.model.rtMs, 1), thinkTimeS: +fmtNum(m.model.thinkS, 2),
        concurrentUsers: Math.ceil(m.model.usersClosed)
      },
      mix: m.mix.map(r => ({
        endpoint: r.endpoint, method: r.method, members: r.members.length > 1 ? r.members.map(x => x.label) : undefined,
        count: r.count, percent: +fmtNum(r.share * 100, 3), rpsPeakHour: +fmtNum(r.rps, 3), rpsTarget: +fmtNum(r.share * m.model.target, 3),
        p95Ms: isNaN(r.p95) ? null : Math.round(r.p95), error5xxPercent: +fmtNum(r.errPct, 2)
      }))
    }, null, 2) + '\n';
  }

  function mixToJmeterCsv(m) {
    const rows = [['label', 'method', 'path', 'weight_percent']];
    for (const r of m.mix) {
      const lead = r.members[0];
      rows.push([r.label, lead.method, lead.ep, fmtNum(r.share * 100, 2)]);
    }
    return rows.map(r => r.map(csvCell).join(',')).join('\n') + '\n';
  }

  function slug(s) { return s.toLowerCase().replace(/\{id\}/g, 'id').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'root'; }
  function jsStr(s) { return JSON.stringify(String(s)); }
  function rateFor(rps) {
    // integer iterations per timeUnit; use per-minute for low rates so small endpoints keep their share
    if (rps >= 20) return { rate: Math.max(1, Math.round(rps)), timeUnit: '1s', mul: 1 };
    return { rate: Math.max(1, Math.round(rps * 60)), timeUnit: '1m', mul: 60 };
  }
  function dur(min) {
    const s = Math.max(1, Math.round(min * 60));
    return s % 60 === 0 ? s / 60 + 'm' : s + 's';
  }

  function generateK6(m, opts) {
    const s = Object.assign({}, m.settings, opts || {});
    const topN = Math.max(1, Math.min(40, Math.round(+s.topN || 8)));
    const target = m.model.target;
    const groups = m.mix.slice(0, topN);
    const rest = m.mix.slice(topN);
    const scen = groups.map((g, i) => ({
      key: 's' + String(i + 1).padStart(2, '0') + '_' + slug(/ \/$/.test(g.label) ? g.label + 'root' : g.label),
      share: g.share, p95: isNaN(g.p95) ? m.model.rtMs * 2 : g.p95,
      reqs: g.members.filter(x => x.peak > 0).map(x => ({ method: x.method, path: x.ep, w: x.peak }))
    }));
    if (rest.length) {
      const share = rest.reduce((a, r) => a + r.share, 0);
      const reqs = [];
      for (const r of rest) for (const x of r.members) if (x.peak > 0 && reqs.length < 200) reqs.push({ method: x.method, path: x.ep, w: x.peak });
      scen.push({ key: 'other_endpoints', share, p95: m.model.rtMs * 2, reqs, other: rest.length });
    }
    const profile = s.profile || 'ramp';
    const durationMin = Math.max(1, +s.durationMin || 30);
    const rampMin = Math.max(0, +s.rampMin || 0);
    const compressMin = Math.max(1, +s.compressMin || 24);
    const peakHod = Math.max.apply(null, m.hod) || 1;
    const curve = m.hod.map(v => v / peakHod);
    const fmtT = ms => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

    const L = [];
    L.push('// Load test generated from production access logs by the workload model tool:');
    L.push('// https://pawansinha.com.au/tools/workload-model/  (runs in the browser, logs never uploaded)');
    L.push('//');
    L.push('// Peak hour in the logs: ' + fmtT(m.peak.hourStart) + ' (log time), ' + fmtNum(m.peak.hourAvgRps, 2) + ' req/s average,');
    L.push('// busiest minute ' + fmtNum(m.peak.minuteRps, 2) + ' req/s, 99th percentile second ' + m.peak.p99SecRps + ' req/s.');
    L.push('// Target ' + fmtNum(target, 2) + ' req/s = ' + fmtNum(m.model.base, 2) + ' (' + basisName(m.model.basis) + ')' +
      (m.model.coverage > 1 ? ' x ' + m.model.coverage + ' (log coverage)' : '') + ' x ' + m.model.growth + ' growth x ' + (1 + m.model.headroom / 100).toFixed(2) + ' headroom.');
    L.push('// Profile: ' + profileName(profile, s) + '.');
    L.push('//');
    L.push('// Run:   k6 run -e BASE_URL=https://staging.example.com workload.js');
    L.push('// Before you run it: replace {id} values with real test data, add auth and request bodies,');
    L.push('// and point it at a test environment you are allowed to load.');
    L.push("import http from 'k6/http';");
    L.push("import { check } from 'k6';");
    L.push('');
    L.push('const BASE_URL = (__ENV.BASE_URL || ' + jsStr(s.baseUrl || 'https://staging.example.com') + ").replace(/\\/$/, '');");
    L.push('');
    L.push('// Each scenario sends its share of the target rate. w = relative weight inside the scenario.');
    L.push('const GROUPS = {');
    for (const sc of scen) {
      L.push('  ' + sc.key + ': [' + (sc.other ? ' // ' + sc.other + ' smaller endpoints' : ''));
      for (const r of sc.reqs) L.push('    { method: ' + jsStr(r.method === 'OTHER' ? 'GET' : r.method) + ', path: ' + jsStr(r.path) + ', w: ' + r.w + ' },');
      L.push('  ],');
    }
    L.push('};');
    L.push('');
    L.push('const TOTALS = {};');
    L.push('for (const k of Object.keys(GROUPS)) TOTALS[k] = GROUPS[k].reduce((a, r) => a + r.w, 0);');
    L.push('');
    L.push('function pick(list, total) {');
    L.push('  let x = Math.random() * total;');
    L.push('  for (const r of list) { x -= r.w; if (x <= 0) return r; }');
    L.push('  return list[list.length - 1];');
    L.push('}');
    L.push('');
    L.push('// TODO: swap the random numbers for real IDs, e.g. a SharedArray loaded from a CSV of test data.');
    L.push('function fill(path) {');
    L.push("  return path.replace(/\\{[a-z]+\\}/g, () => String(1 + Math.floor(Math.random() * 1000)));");
    L.push('}');
    L.push('');
    L.push('export const options = {');
    L.push('  discardResponseBodies: true,');
    L.push('  scenarios: {');
    let totalPre = 0, totalMax = 0;
    for (const sc of scen) {
      const rps = target * sc.share;
      const r = rateFor(rps);
      const pre = Math.max(2, Math.ceil(rps * (sc.p95 / 1000) * 1.5) + 1);
      const max = Math.max(pre * 4, 10);
      totalPre += pre; totalMax += max;
      L.push('    ' + sc.key + ': { // ' + fmtNum(sc.share * 100, 2) + '% of traffic, ' + fmtNum(rps, 2) + ' req/s');
      if (profile === 'constant') {
        L.push("      executor: 'constant-arrival-rate',");
        L.push('      rate: ' + r.rate + ", timeUnit: '" + r.timeUnit + "', duration: '" + dur(durationMin) + "',");
      } else {
        L.push("      executor: 'ramping-arrival-rate',");
        L.push('      startRate: 0, timeUnit: ' + jsStr(r.timeUnit) + ',');
        L.push('      stages: [');
        if (profile === 'curve') {
          const stepMin = compressMin / 24;
          for (let h = 0; h < 24; h++) {
            const v = Math.round(rps * curve[h] * r.mul);
            L.push('        { target: ' + v + ", duration: '" + dur(stepMin) + "' }, // " + String(h).padStart(2, '0') + ':00 ' + Math.round(curve[h] * 100) + '% of peak');
          }
          L.push("        { target: 0, duration: '30s' },");
        } else {
          if (rampMin > 0) L.push('        { target: ' + r.rate + ", duration: '" + dur(rampMin) + "' }, // ramp up");
          L.push('        { target: ' + r.rate + ", duration: '" + dur(durationMin) + "' }, // hold at target");
          L.push("        { target: 0, duration: '1m' }, // ramp down");
        }
        L.push('      ],');
      }
      L.push('      preAllocatedVUs: ' + pre + ', maxVUs: ' + max + ',');
      L.push("      exec: 'hit', env: { GROUP: " + jsStr(sc.key) + ' },');
      L.push('    },');
    }
    L.push('  },');
    const thr = !isNaN(m.overallP95) ? Math.max(100, Math.ceil((m.overallP95 * 1.5) / 50) * 50) : 1000;
    L.push('  thresholds: {');
    L.push("    http_req_failed: ['rate<0.01'],");
    L.push("    http_req_duration: ['p(95)<" + thr + "'], // " + (!isNaN(m.overallP95) ? 'production p95 was ~' + Math.round(m.overallP95) + ' ms; set your real target' : 'set your real target'));
    L.push("    dropped_iterations: ['count<" + Math.max(10, Math.round(target * 60 * 0.01)) + "'], // k6 could not keep up: raise maxVUs or the system is saturated");
    L.push('  },');
    L.push('};');
    L.push('');
    L.push('const JSON_HEADERS = { headers: { \'Content-Type\': \'application/json\' } };');
    L.push('');
    L.push('export function hit() {');
    L.push('  const g = __ENV.GROUP;');
    L.push('  const r = pick(GROUPS[g], TOTALS[g]);');
    L.push("  const hasBody = r.method === 'POST' || r.method === 'PUT' || r.method === 'PATCH';");
    L.push("  const body = hasBody ? JSON.stringify({}) : null; // TODO: real request body");
    L.push('  const params = Object.assign({ tags: { name: r.method + \' \' + r.path } }, hasBody ? JSON_HEADERS : {});');
    L.push('  const res = http.request(r.method, BASE_URL + fill(r.path), body, params);');
    L.push("  check(res, { 'not a server error': (x) => x.status > 0 && x.status < 500 });");
    L.push('}');
    L.push('');
    return { script: L.join('\n'), preAllocatedVUs: totalPre, maxVUs: totalMax, scenarios: scen.length };
  }

  function basisName(b) {
    return { p99: '99th percentile second in the peak hour', minute: 'busiest minute average', hour: 'peak hour average', max: 'single busiest second' }[b] || b;
  }
  function profileName(p, s) {
    if (p === 'constant') return 'constant-arrival-rate for ' + dur(+s.durationMin || 30);
    if (p === 'curve') return 'the daily curve compressed into ' + dur(+s.compressMin || 24) + ' (ramping-arrival-rate)';
    return 'ramp up ' + dur(+s.rampMin || 0) + ', hold ' + dur(+s.durationMin || 30) + ' (ramping-arrival-rate)';
  }

  // ---------------------------------------------------------------- sample log generator
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Synthetic shop: one day of nginx combined logs with $request_time appended.
  function generateSampleLog(o) {
    o = o || {};
    const rnd = mulberry32(o.seed || 42);
    const targetLines = o.lines || 60000;
    const day = Date.UTC(2026, 9, 30); // Friday 30 Oct 2026, written as +1100 local time
    const curve = [2, 1.2, 0.8, 0.6, 0.5, 0.7, 1.4, 2.8, 4.2, 5.2, 5.8, 6.3, 7, 7.2, 6.5, 6, 6, 6.6, 7.6, 9, 10, 9.2, 6.4, 3.6];
    const cSum = curve.reduce((a, b) => a + b, 0);
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const pad = n => (n < 10 ? '0' : '') + n;
    const UAS = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0'
    ];
    const CATS = ['shoes', 'shirts', 'jackets', 'bags', 'hats', 'sale'];
    const out = [];
    const expo = mean => -Math.log(1 - rnd()) * mean;
    const logn = (median, sigma) => median * Math.exp(sigma * gauss());
    function gauss() { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
    function line(t, ip, method, path, status, bytes, ua, rtS, ref) {
      const d = new Date(t);
      const ts = pad(d.getUTCDate()) + '/' + MON[d.getUTCMonth()] + '/' + d.getUTCFullYear() + ':' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) + ' +1100';
      out.push([t, ip + ' - - [' + ts + '] "' + method + ' ' + path + ' HTTP/1.1" ' + status + ' ' + bytes + ' "' + (ref || '-') + '" "' + ua + '" ' + rtS.toFixed(3)]);
    }
    const uuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.floor(rnd() * 16); return (c === 'x' ? r : (r & 3) | 8).toString(16); });
    function req(t, v, method, path, med, errP) {
      let status = method === 'POST' && path === '/api/login' ? 200 : 200;
      let rt = logn(med, 0.45) / 1000;
      const inIncident = t >= day + (20 * 60 + 2) * 60000 && t < day + (20 * 60 + 5) * 60000 && path.indexOf('/api/checkout') === 0;
      if (inIncident && rnd() < 0.35) { status = 504; rt = 30 + rnd() * 0.2; } else if (rnd() < errP) { status = rnd() < 0.7 ? 500 : 503; rt *= 3; } else if (path.indexOf('/product/') === 0 && rnd() < 0.01) status = 404;
      line(t, v.ip, method, path, status, status >= 400 ? 162 : Math.floor(800 + rnd() * 40000), v.ua, rt, v.ref);
    }
    function statics(t, v) {
      for (const p of ['/static/js/app.4f9c2b.js', '/static/css/site.81ad0e.css', '/images/logo.svg', '/favicon.ico']) {
        t += 20 + rnd() * 80; line(t, v.ip, 'GET', p, 200, Math.floor(2000 + rnd() * 90000), v.ua, logn(4, 0.4) / 1000);
      }
    }
    function session(t0) {
      const v = { ip: (11 + Math.floor(rnd() * 200)) + '.' + Math.floor(rnd() * 256) + '.' + Math.floor(rnd() * 256) + '.' + Math.floor(1 + rnd() * 254), ua: UAS[Math.floor(rnd() * UAS.length)], ref: null };
      let t = t0;
      const think = () => { t += Math.min(180000, 2000 + expo(14000)); };
      const r0 = rnd();
      let product = 1000 + Math.floor(rnd() * 4000);
      if (r0 < 0.6) { req(t, v, 'GET', '/', 70, 0.002); statics(t, v); }
      else if (r0 < 0.85) { req(t, v, 'GET', '/product/' + product + (rnd() < 0.5 ? '?utm_source=google&utm_medium=cpc' : ''), 110, 0.003); statics(t, v); }
      else { req(t, v, 'GET', '/search?q=' + CATS[Math.floor(rnd() * CATS.length)], 240, 0.004); statics(t, v); }
      v.ref = 'https://shop.example.com/';
      const pages = 1 + Math.floor(expo(4));
      let carted = false;
      for (let i = 0; i < pages; i++) {
        think();
        const r = rnd();
        if (r < 0.25) req(t, v, 'GET', '/category/' + CATS[Math.floor(rnd() * CATS.length)] + (rnd() < 0.3 ? '?page=' + (2 + Math.floor(rnd() * 4)) : ''), 140, 0.003);
        else if (r < 0.7) {
          product = 1000 + Math.floor(rnd() * 4000);
          req(t, v, 'GET', '/product/' + product, 110, 0.003);
          line(t + 60, v.ip, 'GET', '/images/products/' + product + '.jpg', 200, 60000, v.ua, 0.006);
          req(t + 150 + rnd() * 100, v, 'GET', '/api/products/' + product + '/reviews', 45, 0.002);
          if (rnd() < 0.3) { t += 3000 + expo(5000); req(t, v, 'POST', '/api/cart/items', 85, 0.004); carted = true; }
        } else if (r < 0.85) req(t, v, 'GET', '/search?q=' + CATS[Math.floor(rnd() * CATS.length)], 240, 0.004);
        else if (r < 0.95) req(t, v, 'GET', '/api/cart', 40, 0.002);
        else { req(t, v, 'POST', '/api/login', 180, 0.003); think(); req(t, v, 'GET', '/account/orders', 160, 0.003); }
      }
      if (carted && rnd() < 0.45) {
        think(); req(t, v, 'GET', '/cart', 90, 0.002);
        think(); req(t, v, 'GET', '/checkout', 260, 0.006);
        think(); req(t, v, 'POST', '/api/checkout/payment', 850, 0.015);
        req(t + 900 + rnd() * 300, v, 'GET', '/order/' + uuid() + '/confirmation', 120, 0.003);
      }
    }
    // health checks every 10 s from two load balancer nodes; a crawler through the day
    for (let t = day; t < day + 86400000; t += 10000) {
      line(t + 1, '10.0.1.12', 'GET', '/health', 200, 2, 'ELB-HealthChecker/2.0', 0.001);
      line(t + 5003, '10.0.2.47', 'GET', '/health', 200, 2, 'ELB-HealthChecker/2.0', 0.001);
    }
    const bot = { ip: '66.249.66.' + Math.floor(1 + rnd() * 200), ua: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' };
    const botN = Math.round(targetLines * 0.01);
    for (let i = 0; i < botN; i++) line(day + rnd() * 86400000, bot.ip, 'GET', '/product/' + (1000 + Math.floor(rnd() * 4000)), 200, 30000, bot.ua, logn(110, 0.4) / 1000);
    const nSess = Math.max(10, Math.round((targetLines - out.length) / 14));
    for (let i = 0; i < nSess; i++) {
      let r = rnd() * cSum, h = 0;
      while (h < 23 && r > curve[h]) { r -= curve[h]; h++; }
      let t = day + h * 3600000 + rnd() * 3600000;
      if (i % 60 === 0) t = day + 20 * 3600000 + rnd() * 120000; // promo email at 8 pm: a two-minute burst
      session(t);
    }
    out.sort((a, b) => a[0] - b[0]);
    return out.map(x => x[1]).join('\n') + '\n';
  }

  const W = {
    FORMAT_LABELS, DEFAULT_RULES, DEFAULTS, STATIC_RE, BOT_UA_RE, HEALTH_RE,
    parseClfTime, parseAnyTime, splitQuoted, splitCsv, detectFormat, guessMapping, createParser,
    parseRules, normalisePath, classify, createAggregator, analyseText, buildModel, littlesLaw,
    histQuantile, bucketOf, mixToCsv, mixToJson, mixToJmeterCsv, generateK6, generateSampleLog, basisName
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = W;
  else root.Workload = W;
})(typeof self !== 'undefined' ? self : this);
