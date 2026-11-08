/* Log Analyser: pure, streaming log analysis with no DOM. Runs in the browser (window.LogAnalyser), inside the
   Web Worker in worker.js (big files are read in chunks there) and in Node (module.exports) for
   toolkit-tests/log-analyser.test.js. Nothing is uploaded.

   const a = createAnalyser(opts); a.push(chunk); …; const result = a.end();
   analyseText(text, opts)          the same in one call
   detectFormat(lines)              'json' | 'logfmt' | 'java' | 'access' | 'syslog' | 'plain'
   template(message)                numbers, UUIDs, IPs, hex, emails, URLs, times and quoted strings → placeholders
   filterEntries(entries, f), firstErrorIn(entries, from, to)
   groupsToCSV(result), toMarkdown(result)

   Times are kept as written in the log (wall-clock), ignoring any time zone offset, so what you see matches the file.
*/
(function (root) {
  'use strict';

  const LEVELS = ['FATAL', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE', 'NONE'];
  const LEVEL_MAP = {
    FATAL: 'FATAL', CRITICAL: 'FATAL', CRIT: 'FATAL', EMERG: 'FATAL', EMERGENCY: 'FATAL', ALERT: 'FATAL', PANIC: 'FATAL',
    ERROR: 'ERROR', ERR: 'ERROR', SEVERE: 'ERROR', E: 'ERROR',
    WARN: 'WARN', WARNING: 'WARN', W: 'WARN',
    INFO: 'INFO', NOTICE: 'INFO', INFORMATION: 'INFO', I: 'INFO', LOG: 'INFO',
    DEBUG: 'DEBUG', FINE: 'DEBUG', CONFIG: 'DEBUG', D: 'DEBUG', VERBOSE: 'DEBUG',
    TRACE: 'TRACE', FINER: 'TRACE', FINEST: 'TRACE', T: 'TRACE',
  };
  const PINO = { 10: 'TRACE', 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR', 60: 'FATAL' };
  function normLevel(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return PINO[v] || (v >= 50 ? 'ERROR' : v >= 40 ? 'WARN' : v >= 30 ? 'INFO' : 'DEBUG');
    const s = String(v).trim().toUpperCase();
    if (/^\d+$/.test(s)) return normLevel(+s);
    return LEVEL_MAP[s] || null;
  }
  const isErr = l => l === 'ERROR' || l === 'FATAL';

  // ------------------------------------------------------------------ time
  const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const ISO_RE = /(\d{4})[-/](\d{2})[-/](\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,9}))?/;
  // Time-only stamps (Logback's default "10:00:00.123 [main] …") are placed on 1 Jan 1970 and shown as a time only.
  const TIME_ONLY_RE = /^(\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,9}))?/;
  function isoMs(s) {
    const m = ISO_RE.exec(s);
    if (!m) {
      const t = TIME_ONLY_RE.exec(s);
      return t ? Date.UTC(1970, 0, 1, +t[1], +t[2], +t[3], t[4] ? Math.round(+('0.' + t[4]) * 1000) : 0) : null;
    }
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], m[7] ? Math.round(+('0.' + m[7]) * 1000) : 0);
  }
  function anyTime(v, year) {
    if (v == null || v === '') return null;
    if (typeof v === 'number' || /^\d{9,16}(\.\d+)?$/.test(String(v))) {
      const n = +v;
      return n > 1e14 ? Math.round(n / 1000) : n > 1e11 ? n : Math.round(n * 1000);
    }
    const s = String(v);
    const iso = isoMs(s);
    if (iso != null) return iso;
    const a = /(\d{2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})/.exec(s);
    if (a) return Date.UTC(+a[3], MON[a[2].toLowerCase()], +a[1], +a[4], +a[5], +a[6]);
    const b = /([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})/.exec(s);
    if (b && MON[b[1].toLowerCase()] != null) return Date.UTC(year || new Date().getUTCFullYear(), MON[b[1].toLowerCase()], +b[2], +b[3], +b[4], +b[5]);
    return null;
  }
  const pad2 = n => (n < 10 ? '0' : '') + n;
  function fmtTime(ms, withSec) {
    if (ms == null) return '';
    const d = new Date(ms);
    if (ms >= 0 && ms < 86400000) return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + (withSec === false ? '' : ':' + pad2(d.getUTCSeconds()));
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) + ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + (withSec === false ? '' : ':' + pad2(d.getUTCSeconds()));
  }

  // ------------------------------------------------------------------ message templates
  const T_RULES = [
    [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>'],
    [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>'],
    [/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, '<url>'],
    [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<time>'],
    [/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '<ip>'],
    [/\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b/gi, '<ip>'],
    [/"(?:[^"\\]|\\.)*"/g, '"<str>"'],
    [/(^|[\s=:(\[,{])'(?:[^'\\]|\\.)*'/g, "$1'<str>'"],
    [/\b0x[0-9a-f]+\b/gi, '<hex>'],
    [/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi, '<hex>'],
    [/\b[A-Za-z0-9_-]{16,}\b/g, m => (/\d/.test(m) && /[A-Za-z]/.test(m) ? '<id>' : m)],
    [/(^|[^\w.])-?\d+(?:\.\d+)?(?:ms|s|m|h|kb|mb|gb|b|%)?\b/gi, '$1<n>'],
    [/\s+/g, ' '],
  ];
  function template(msg) {
    let s = String(msg == null ? '' : msg);
    if (s.length > 600) s = s.slice(0, 600);
    for (const r of T_RULES) s = s.replace(r[0], r[1]);
    return s.trim() || '(empty message)';
  }
  function endpoint(path) {
    let p = String(path || '').split('?')[0].split('#')[0];
    p = p.replace(/^[a-z]+:\/\/[^/]+/i, '');
    if (p.length > 200) p = p.slice(0, 200);
    return p.split('/').map(seg => {
      if (!seg) return seg;
      if (/^\d+$/.test(seg)) return '{id}';
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return '{uuid}';
      if (/^[0-9a-f]{16,}$/i.test(seg)) return '{hash}';
      if (seg.length >= 12 && /\d/.test(seg) && /[a-z]/i.test(seg) && !/[.]/.test(seg)) return '{token}';
      if (/@/.test(seg)) return '{email}';
      return seg;
    }).join('/') || '/';
  }

  // ------------------------------------------------------------------ line parsers
  const TS_START = /^\[?(\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?(?:Z|\s?[+-]\d{2}:?\d{2})?|\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?(?= ))\]?[\s|]*/;
  const LEVEL_IN = /(?:^|[\s\[|:(<])(TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|ERR|SEVERE|FATAL|CRITICAL|CRIT|EMERG|ALERT|FINE|FINER|FINEST|CONFIG)(?=[\s\]|:)>]|$)|\[(trace|debug|info|notice|warn|warning|error|crit|alert|emerg)\]/;
  function parseJavaLike(line) {
    const m = TS_START.exec(line);
    if (!m) return null;
    const ts = isoMs(m[1]);
    const rest = line.slice(m[0].length);
    const head = rest.slice(0, 120);
    const lv = LEVEL_IN.exec(head);
    const level = lv ? normLevel(lv[1] || lv[2]) : null;
    const thr = /\[([^\]]{1,80})\]/.exec(head);
    const thread = thr && !normLevel(thr[1]) ? thr[1] : '';
    const sepRe = /\s(?:-|:|—|\|)\s/g;
    let sep = -1, mm;
    const from = lv ? lv.index + lv[0].length : 0;
    sepRe.lastIndex = from;
    if ((mm = sepRe.exec(rest)) && mm.index < from + 160) sep = mm.index;
    const msg = sep >= 0 ? rest.slice(sep + mm[0].length) : rest.slice(from).replace(/^[\s\]:|-]+/, '');
    const pre = sep >= 0 ? rest.slice(from, sep) : '';
    const lg = /([A-Za-z_$][\w$]*(?:\.[\w$]+)+)\s*(?:\[[^\]]*\]\s*)?$/.exec(pre.replace(/\s+\d+\s*$/, ''));
    return { ts, level, msg: msg.trim(), logger: lg ? lg[1] : '', thread };
  }

  const SYSLOG_3164 = /^(?:<(\d{1,3})>)?([A-Z][a-z]{2})\s+(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\S+) ([^:\[\s]+)(?:\[(\d+)\])?:\s?(.*)$/;
  const SYSLOG_5424 = /^<(\d{1,3})>\d (\S+) (\S+) (\S+) (\S+) (\S+) (-|\[.*?\]) ?(.*)$/;
  const SEV = ['FATAL', 'FATAL', 'FATAL', 'ERROR', 'WARN', 'INFO', 'INFO', 'DEBUG'];
  function kwLevel(s) {
    if (/\b(fatal|panic|emerg(ency)?|crit(ical)?|kernel panic)\b/i.test(s)) return 'FATAL';
    if (/\b(error|err|exception|failed|failure|segfault|traceback|denied|refused)\b/i.test(s)) return 'ERROR';
    if (/\b(warn|warning|deprecated|retry(ing)?|timeout|timed out)\b/i.test(s)) return 'WARN';
    if (/\bdebug\b/i.test(s)) return 'DEBUG';
    return null;
  }
  function parseSyslog(line, year) {
    let m = SYSLOG_5424.exec(line);
    if (m) {
      const msg = m[8] || '';
      return { ts: anyTime(m[2], year), level: SEV[+m[1] % 8], msg, logger: m[4] !== '-' ? m[4] : '', thread: '', host: m[3] };
    }
    m = SYSLOG_3164.exec(line);
    if (!m) return null;
    const msg = m[10] || '';
    return { ts: Date.UTC(year || new Date().getUTCFullYear(), MON[m[2].toLowerCase()], +m[3], +m[4], +m[5], +m[6]), level: m[1] ? SEV[+m[1] % 8] : (kwLevel(msg) || 'INFO'), msg, logger: m[8], thread: '', host: m[7] };
  }

  const ACCESS_RE = /^(\S+) (\S+) (\S+) \[([^\]]+)\] "(?:([A-Z]{3,10}) (\S+)(?: [^"]*)?|[^"]*)" (\d{3}) (\d+|-)(?: "([^"]*)" "([^"]*)")?(.*)$/;
  function rtFrom(tail) {
    if (!tail) return null;
    let m = /(?:\brt|request_time|rtime|req_time|response_time|upstream_response_time|urt|duration)[=:]"?([\d.]+)(ms|s)?/.exec(tail);
    if (m) return m[2] === 'ms' ? +m[1] : /\./.test(m[1]) || m[2] === 's' ? +m[1] * 1000 : +m[1];
    m = /(?:^|\s)"?([\d]+\.\d+|\d+)"?\s*(?:"[^"]*"\s*)*$/.exec(tail.trim());
    if (m) return /\./.test(m[1]) ? +m[1] * 1000 : +m[1];
    return null;
  }
  function parseAccess(line) {
    const m = ACCESS_RE.exec(line);
    if (!m) return null;
    const status = +m[7];
    const rt = rtFrom(m[11]);
    return {
      ts: anyTime(m[4]), level: status >= 500 ? 'ERROR' : status >= 400 ? 'WARN' : 'INFO',
      msg: (m[5] || '-') + ' ' + (m[6] || '-') + ' ' + status,
      access: { ip: m[1], method: m[5] || '-', path: m[6] || '-', status, bytes: m[8] === '-' ? 0 : +m[8], ua: m[10] && m[10] !== '-' ? m[10] : '', rt: rt != null && isFinite(rt) ? rt : null },
    };
  }

  const pick = (o, keys) => {
    for (const k of keys) {
      let v = o[k];
      if (v == null && k.indexOf('.') > 0) v = k.split('.').reduce((a, p) => (a && typeof a === 'object' ? a[p] : undefined), o);
      if (v != null && v !== '') return v;
    }
    return undefined;
  };
  function durMs(v, key) {
    if (v == null || v === '') return null;
    if (typeof v === 'string') {
      const m = /^([\d.]+)\s*(ms|s|µs|us|ns)?$/.exec(v.trim());
      if (!m) return null;
      const n = +m[1];
      return m[2] === 's' ? n * 1000 : m[2] === 'us' || m[2] === 'µs' ? n / 1000 : m[2] === 'ns' ? n / 1e6 : m[2] === 'ms' ? n : (/ms|millis/i.test(key) ? n : /\./.test(m[1]) ? n * 1000 : n);
    }
    if (typeof v !== 'number') return null;
    if (/_?ms$|millis/i.test(key)) return v;
    if (/_?(us|micros)$/i.test(key)) return v / 1000;
    if (/_?ns$|nanos/i.test(key)) return v / 1e6;
    return Number.isInteger(v) ? v : v * 1000;
  }
  const DUR_KEYS = ['duration_ms', 'response_time_ms', 'latency_ms', 'elapsed_ms', 'took_ms', 'responseTime', 'response_time', 'request_time', 'duration', 'latency', 'elapsed', 'took', 'http.duration', 'res.responseTime'];
  function parseObj(o, year) {
    const levelV = pick(o, ['level', 'lvl', 'severity', 'levelname', 'log.level', 'loglevel', 'log_level', 'Level', 'severityText', '@l']);
    const tsV = pick(o, ['@timestamp', 'timestamp', 'time', 'ts', 't', 'datetime', 'date', '@t', 'time_local', 'eventTime']);
    let msg = pick(o, ['message', 'msg', '@message', '@m', 'event', 'text', 'log', 'Message']);
    const errV = pick(o, ['error.message', 'err.message', 'error', 'err', 'exception.message', 'exception']);
    let stack = pick(o, ['stack_trace', 'stacktrace', 'stack', 'error.stack', 'err.stack', 'exception.stacktrace', 'exception.stack_trace', 'exc_info', '@x', 'error.stack_trace']);
    if (errV && typeof errV === 'object') { if (!stack && errV.stack) stack = errV.stack; }
    if (msg != null && typeof msg !== 'string') msg = JSON.stringify(msg);
    if ((msg == null || msg === '') && typeof errV === 'string') msg = errV;
    else if (typeof errV === 'string' && msg && msg.indexOf(errV) < 0 && errV.length < 300) msg = msg + ': ' + errV;
    let level = normLevel(levelV);
    const statusV = pick(o, ['status', 'status_code', 'statusCode', 'http.status_code', 'http.response.status_code', 'res.statusCode', 'response.status']);
    const pathV = pick(o, ['path', 'url', 'uri', 'request_uri', 'request.path', 'http.url', 'http.target', 'req.url', 'url.path', 'request']);
    let access = null;
    if (statusV != null && /^\d{3}$/.test(String(statusV)) && pathV != null) {
      const st = +statusV;
      let path = String(pathV), method = pick(o, ['method', 'request_method', 'http.method', 'req.method', 'http.request.method']) || '-';
      const rq = /^([A-Z]{3,10}) (\S+)/.exec(path);
      if (rq) { method = rq[1]; path = rq[2]; }
      let rt = null;
      for (const k of DUR_KEYS) { const v = pick(o, [k]); if (v != null) { rt = durMs(v, k); if (rt != null) break; } }
      access = { ip: String(pick(o, ['remote_addr', 'client_ip', 'ip', 'clientIp', 'remoteAddress', 'client.ip', 'source.ip', 'req.remoteAddress']) || '-'), method: String(method), path, status: st, bytes: +pick(o, ['bytes', 'body_bytes_sent', 'size', 'bytes_sent']) || 0, ua: String(pick(o, ['user_agent', 'http_user_agent', 'userAgent', 'user_agent.original', 'ua']) || ''), rt };
      if (!level) level = st >= 500 ? 'ERROR' : st >= 400 ? 'WARN' : 'INFO';
      if (msg == null || msg === '') msg = access.method + ' ' + path + ' ' + st;
    }
    if (!level) level = kwLevel(String(msg || '')) ;
    return {
      ts: anyTime(tsV, year), level, msg: String(msg == null ? '' : msg),
      logger: String(pick(o, ['logger', 'logger_name', 'loggerName', 'log.logger', 'name', 'module', 'caller', 'component', 'service', 'service.name']) || ''),
      thread: String(pick(o, ['thread', 'thread_name', 'threadName', 'process.thread.name']) || ''),
      stack: stack ? (Array.isArray(stack) ? stack.map(String) : String(stack).split(/\r?\n/)) : null,
      access,
    };
  }
  function parseJSON(line, year) {
    const t = line.trim();
    if (t[0] !== '{') return null;
    let o;
    try { o = JSON.parse(t); } catch (e) { return null; }
    if (!o || typeof o !== 'object') return null;
    return parseObj(o, year);
  }
  const LOGFMT_PAIR = /([\w.@/-]+)=("(?:[^"\\]|\\.)*"|[^\s]*)/g;
  function parseLogfmt(line, year) {
    if (line.indexOf('=') < 0) return null;
    const o = {};
    let n = 0, m;
    LOGFMT_PAIR.lastIndex = 0;
    while ((m = LOGFMT_PAIR.exec(line))) {
      let v = m[2];
      if (v[0] === '"') { try { v = JSON.parse(v); } catch (e) { v = v.slice(1, -1); } }
      o[m[1]] = v; n++;
    }
    if (n < 2 || !('level' in o || 'lvl' in o || 'msg' in o || 'message' in o || 'severity' in o)) return null;
    return parseObj(o, year);
  }
  function parsePlain(line) {
    const m = TS_START.exec(line);
    const ts = m ? isoMs(m[1]) : anyTime(line.slice(0, 40));
    const lv = LEVEL_IN.exec(line.slice(0, 160));
    return { ts, level: lv ? normLevel(lv[1] || lv[2]) : kwLevel(line), msg: (m ? line.slice(m[0].length) : line).trim() };
  }

  // ------------------------------------------------------------------ format detection
  const FORMAT_LABEL = { json: 'JSON lines', logfmt: 'logfmt (key=value)', java: 'Timestamped app log (Log4j / Logback / Spring / nginx error)', access: 'Web access log (Apache / Nginx)', syslog: 'Syslog', plain: 'Plain text' };
  function detectFormat(lines, year) {
    const score = { json: 0, logfmt: 0, access: 0, syslog: 0, java: 0 };
    let n = 0;
    for (const l of lines) {
      if (!l || !l.trim()) continue;
      if (++n > 300) break;
      if (l.trim()[0] === '{' && parseJSON(l, year)) score.json++;
      else if (ACCESS_RE.test(l)) score.access++;
      else if (SYSLOG_5424.test(l) || SYSLOG_3164.test(l)) score.syslog++;
      else if (TS_START.test(l)) score.java++;
      else if (parseLogfmt(l, year)) score.logfmt++;
    }
    const best = Object.keys(score).sort((a, b) => score[b] - score[a])[0];
    return score[best] > 0 && score[best] >= n * 0.2 ? best : 'plain';
  }
  const PARSERS = { json: parseJSON, logfmt: parseLogfmt, java: parseJavaLike, access: parseAccess, syslog: parseSyslog, plain: parsePlain };
  const HEADER_FORMATS = { java: 1, syslog: 1, plain: 0 };
  const CONT_RE = /^(?:\s+at\s|\s*at [\w$.<]|\s*\.\.\. \d+ (?:more|common frames omitted)|Caused by:|\s*Suppressed:|Traceback \(most recent call last\)|\s+File ".*", line \d+|\t|\s{2,}\S|[\w$.]+(?:Exception|Error|Throwable)(?::|$)|[A-Z]\w*(?:Error|Exception|Warning|Exit|Interrupt)(?::|$)|goroutine \d+ \[|panic: )/;

  // ------------------------------------------------------------------ stack traces
  const EXC_RE = /(?:^|[^\w$.])((?:[a-zA-Z_$][\w$]*\.)*(?:[A-Z][\w$]*)?(?:Exception|Error|Throwable|Fault|Panic))(?::|\s*$|\s)/;
  function stackInfo(msg, lines) {
    let type = '', root = '', frame = '';
    const all = [msg].concat(lines || []);
    for (const l of all) {
      const c = /^\s*Caused by:\s*([\w$.]+)/.exec(l);
      if (c) root = c[1];
    }
    // Python: the exception is the last line, the innermost frame is the last File line
    if (all.some(l => /Traceback \(most recent call last\)/.test(l))) {
      for (let i = all.length - 1; i >= 0; i--) { const m = /^([A-Za-z_][\w.]*(?:Error|Exception|Warning|Exit|Interrupt))(?::|$)/.exec(all[i].trim()); if (m) { type = m[1]; break; } }
      for (let i = all.length - 1; i >= 0; i--) { const m = /File "([^"]+)", line (\d+), in (\S+)/.exec(all[i]); if (m) { frame = m[1].split(/[\\/]/).pop() + ':' + m[2] + ' in ' + m[3]; break; } }
    } else {
      for (const l of all) { const m = EXC_RE.exec(l); if (m) { type = m[1]; break; } }
      for (const l of all) {
        const m = /^\s*at\s+(?:async\s+)?(.+?)\s*$/.exec(l);
        if (m) { frame = m[1].replace(/\s*~?\[[^\]]*\]$/, '').replace(/^.*?\(((?:file:\/\/)?[^()]*[\\/])?([^\\/()]+:\d+(?::\d+)?)\)$/, (x, p, f) => x.replace(/\(.*\)$/, '') + '(' + f + ')').replace(/\s+\($/, ''); break; }
        const g = /^\s*(\S+\.go:\d+)/.exec(l);
        if (g) { frame = g[1]; break; }
      }
    }
    if (!type) {
      const m = /^panic: (.*)/.exec(all.find(l => /^panic: /.test(l)) || '');
      if (m) type = 'panic';
    }
    return { type: type || (root ? root : 'Unknown error'), root: root && root !== type ? root : '', frame };
  }

  // ------------------------------------------------------------------ analyser
  function createAnalyser(opts) {
    opts = opts || {};
    const year = opts.year || new Date().getUTCFullYear();
    const maxSamples = opts.maxSamples || 20000;
    const maxGroups = opts.maxGroups || 5000;
    let format = opts.format && opts.format !== 'auto' ? opts.format : null;
    let parser = format ? PARSERS[format] : null;
    let rest = '';
    let lineNo = 0, bytes = 0, entries = 0, unparsed = 0;
    const pending = [];
    let cur = null;
    const levels = {}; LEVELS.forEach(l => { levels[l] = 0; });
    const groups = new Map();
    let otherGroup = null;
    const stacks = new Map();
    const minutes = new Map();
    let firstTs = null, lastTs = null, firstError = null, errorCount = 0, warnCount = 0;
    const samples = [];
    let samplesDropped = 0;
    const acc = { n: 0, statuses: {}, classes: { '1xx': 0, '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 }, endpoints: new Map(), ips: new Map(), agents: new Map(), timed: 0, bytes: 0, methods: {} };
    let rng = 12345;
    const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };

    function bump(map, key, cap) {
      const v = map.get(key);
      if (v != null) map.set(key, v + 1);
      else if (map.size < cap) map.set(key, 1);
      else map.set('(other)', (map.get('(other)') || 0) + 1);
    }

    function finish(e) {
      if (!e) return;
      entries++;
      const level = e.level || 'NONE';
      levels[level] = (levels[level] || 0) + 1;
      const ts = e.ts;
      if (ts != null && isFinite(ts)) {
        if (firstTs == null || ts < firstTs) firstTs = ts;
        if (lastTs == null || ts > lastTs) lastTs = ts;
        const mk = Math.floor(ts / 60000);
        let b = minutes.get(mk);
        if (!b) { b = { total: 0, errors: 0, warns: 0, first: null }; minutes.set(mk, b); }
        b.total++;
        if (isErr(level)) { b.errors++; if (!b.first) b.first = { line: e.line, ts, msg: e.msg.slice(0, 300) }; }
        else if (level === 'WARN') b.warns++;
      }
      let tpl = '';
      if (isErr(level)) {
        errorCount++;
        tpl = e.access ? (e.access.method + ' ' + endpoint(e.access.path) + ' → ' + e.access.status) : template(e.msg);
        let g = groups.get(tpl);
        if (!g) {
          if (groups.size < maxGroups) { g = { template: tpl, count: 0, first: ts, last: ts, firstLine: e.line, example: e.msg.slice(0, 1000), level, loggers: {} }; groups.set(tpl, g); }
          else g = otherGroup || (otherGroup = { template: '(other messages: too many distinct templates)', count: 0, first: ts, last: ts, firstLine: e.line, example: e.msg.slice(0, 1000), level, loggers: {} });
        }
        g.count++;
        if (ts != null) { if (g.first == null || ts < g.first) g.first = ts; if (g.last == null || ts > g.last) g.last = ts; }
        if (level === 'FATAL') g.level = 'FATAL';
        if (e.logger && Object.keys(g.loggers).length < 5) g.loggers[e.logger] = (g.loggers[e.logger] || 0) + 1;
        if (!firstError) firstError = { line: e.line, ts, level, msg: e.msg.slice(0, 1000), logger: e.logger || '', stack: (e.stack || []).slice(0, 30) };
      } else if (level === 'WARN') warnCount++;
      if (e.stack && e.stack.length && (isErr(level) || level === 'WARN' || EXC_RE.test(e.msg))) {
        const si = stackInfo(e.msg, e.stack);
        const key = si.type + ' @ ' + (si.frame || '?');
        let s = stacks.get(key);
        if (!s) {
          if (stacks.size < 2000) { s = { type: si.type, root: si.root, frame: si.frame, count: 0, first: ts, last: ts, firstLine: e.line, example: [e.msg.slice(0, 400)].concat(e.stack.slice(0, 40)) }; stacks.set(key, s); }
        }
        if (s) { s.count++; if (ts != null) { if (s.first == null || ts < s.first) s.first = ts; if (s.last == null || ts > s.last) s.last = ts; } }
      }
      if (e.access) {
        const a = e.access;
        acc.n++;
        acc.statuses[a.status] = (acc.statuses[a.status] || 0) + 1;
        const cls = Math.floor(a.status / 100) + 'xx';
        if (acc.classes[cls] != null) acc.classes[cls]++;
        acc.methods[a.method] = (acc.methods[a.method] || 0) + 1;
        acc.bytes += a.bytes || 0;
        bump(acc.ips, a.ip, 200000);
        bump(acc.agents, a.ua || '(none)', 50000);
        const ep = a.method + ' ' + endpoint(a.path);
        let x = acc.endpoints.get(ep);
        if (!x) {
          if (acc.endpoints.size < 5000) { x = { endpoint: ep, count: 0, errors: 0, client: 0, sum: 0, timed: 0, max: 0, res: [] }; acc.endpoints.set(ep, x); }
        }
        if (x) {
          x.count++;
          if (a.status >= 500) x.errors++; else if (a.status >= 400) x.client++;
          if (a.rt != null) {
            acc.timed++; x.timed++; x.sum += a.rt; if (a.rt > x.max) x.max = a.rt;
            if (x.res.length < 2000) x.res.push(a.rt);
            else { const j = Math.floor(rand() * x.timed); if (j < 2000) x.res[j] = a.rt; }
          }
        }
      }
      if (level !== 'INFO' && level !== 'DEBUG' && level !== 'TRACE' && level !== 'NONE') {
        if (samples.length < maxSamples) samples.push({ line: e.line, ts, level, msg: e.msg.slice(0, 600), logger: e.logger || '', tpl, stack: e.stack ? e.stack.length : 0 });
        else samplesDropped++;
      }
    }

    function handle(line) {
      lineNo++;
      if (!line) return;
      if (line.length > 20000) line = line.slice(0, 20000);
      const hf = HEADER_FORMATS[format];
      // java / syslog: a line without a header belongs to the entry above (stack traces, multi-line messages).
      // plain: indented lines, "at …", "Caused by:" and exception lines belong to the entry above.
      let p = hf === 1 ? parser(line, year) : null;
      if (cur && ((hf === 1 && !p) || (hf === 0 && CONT_RE.test(line)))) {
        if (!cur.stack) cur.stack = [];
        if (cur.stack.length < 200) cur.stack.push(line);
        return;
      }
      if (hf !== 1) p = parser(line, year);
      if (!p) {
        unparsed++;
        const q = parsePlain(line);
        finish(cur); cur = null;
        finish({ line: lineNo, ts: q.ts, level: q.level, msg: q.msg });
        return;
      }
      finish(cur);
      p.line = lineNo;
      if (p.level == null && format !== 'access') p.level = kwLevel(p.msg) || 'NONE';
      if (p.level === 'NONE' && p.msg && /^(\w+\.)*\w*(Exception|Error)\b/.test(p.msg)) p.level = 'ERROR';
      cur = p;
      if (format === 'json' || format === 'logfmt' || format === 'access') { finish(cur); cur = null; }
    }

    function processLines(lines) {
      if (!format) {
        pending.push(...lines);
        if (pending.length < 300) return;
        format = detectFormat(pending, year); parser = PARSERS[format];
        const p = pending.splice(0); for (const l of p) handle(l);
        return;
      }
      for (const l of lines) handle(l);
    }

    return {
      push(chunk) {
        bytes += chunk.length;
        const text = rest + chunk;
        const lines = text.split(/\r?\n/);
        rest = lines.pop();
        processLines(lines);
      },
      end() {
        const tail = rest ? [rest.replace(/\r$/, '')] : [];
        rest = '';
        if (!format) { pending.push(...tail); format = detectFormat(pending, year); parser = PARSERS[format]; const p = pending.splice(0); for (const l of p) handle(l); }
        else for (const l of tail) handle(l);
        finish(cur); cur = null;
        return build();
      },
      get lines() { return lineNo; },
      get format() { return format; },
    };

    function pct(arr, p) { if (!arr.length) return null; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p / 100 * s.length) - 1))]; }

    function build() {
      // timeline: pick a bucket size that keeps the chart under ~1,500 bars
      let timeline = null;
      if (minutes.size && firstTs != null) {
        const m0 = Math.floor(firstTs / 60000), m1 = Math.floor(lastTs / 60000);
        const span = m1 - m0 + 1;
        const sizes = [1, 5, 15, 30, 60, 180, 360, 720, 1440, 10080];
        const size = sizes.find(s => span / s <= 1500) || 10080;
        const start = Math.floor(m0 / size) * size;
        const n = Math.floor((m1 - start) / size) + 1;
        const buckets = new Array(n);
        for (let i = 0; i < n; i++) buckets[i] = { t: (start + i * size) * 60000, total: 0, errors: 0, warns: 0, first: null };
        minutes.forEach((b, mk) => {
          const bi = Math.floor((mk - start) / size);
          const x = buckets[bi];
          x.total += b.total; x.errors += b.errors; x.warns += b.warns;
          if (b.first && (!x.first || b.first.line < x.first.line)) x.first = b.first;
        });
        const errs = buckets.map(b => b.errors);
        const mean = errs.reduce((a, b) => a + b, 0) / n;
        const sd = Math.sqrt(errs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n);
        const threshold = mean + 3 * sd;
        const spikes = n >= 5 && sd > 0 ? buckets.filter(b => b.errors > threshold && b.errors >= 3).map(b => ({ t: b.t, errors: b.errors, total: b.total, ratio: mean ? Math.round(b.errors / mean * 10) / 10 : null, first: b.first })) : [];
        timeline = { bucketMinutes: size, buckets, mean: Math.round(mean * 100) / 100, sd: Math.round(sd * 100) / 100, threshold: Math.round(threshold * 100) / 100, spikes, peak: buckets.reduce((a, b) => (b.errors > a.errors ? b : a), buckets[0]) };
      }
      const groupList = Array.from(groups.values());
      if (otherGroup) groupList.push(otherGroup);
      groupList.sort((a, b) => b.count - a.count || (a.firstLine - b.firstLine));
      const stackList = Array.from(stacks.values()).sort((a, b) => b.count - a.count || (a.firstLine - b.firstLine));
      let access = null;
      if (acc.n) {
        const top = (map, n) => Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ key: k, count: v }));
        const eps = Array.from(acc.endpoints.values()).map(x => ({
          endpoint: x.endpoint, count: x.count, errors: x.errors, client: x.client, errorPct: Math.round(x.errors / x.count * 1000) / 10,
          avg: x.timed ? Math.round(x.sum / x.timed * 10) / 10 : null, p50: pct(x.res, 50), p95: pct(x.res, 95), p99: pct(x.res, 99), max: x.timed ? Math.round(x.max * 10) / 10 : null,
        }));
        access = {
          requests: acc.n, statuses: Object.keys(acc.statuses).map(k => ({ status: +k, count: acc.statuses[k] })).sort((a, b) => b.count - a.count),
          classes: acc.classes, methods: acc.methods, bytes: acc.bytes, hasTimes: acc.timed > 0,
          endpoints: eps.sort((a, b) => b.count - a.count).slice(0, 300),
          slowest: acc.timed ? eps.filter(e => e.p95 != null && e.count >= 1).sort((a, b) => b.p95 - a.p95).slice(0, 50) : [],
          ips: top(acc.ips, 50), ipCount: acc.ips.size, agents: top(acc.agents, 30),
        };
      }
      return {
        format, formatLabel: FORMAT_LABEL[format] || format, lines: lineNo, entries, bytes, unparsed,
        levels, errors: errorCount, warnings: warnCount,
        firstTs, lastTs, firstError,
        groups: groupList.slice(0, 1000), groupCount: groupList.length,
        stacks: stackList.slice(0, 300), stackCount: stackList.length,
        timeline, access, samples, samplesDropped,
      };
    }
  }

  function analyseText(text, opts) {
    const a = createAnalyser(opts);
    const s = String(text || '');
    const CH = 1 << 20;
    for (let i = 0; i < s.length; i += CH) a.push(s.slice(i, i + CH));
    return a.end();
  }

  // ------------------------------------------------------------------ filters and exports
  function filterEntries(entries, f) {
    f = f || {};
    const q = (f.q || '').trim().toLowerCase();
    const lv = f.levels && f.levels.length ? f.levels : null;
    const from = f.from != null && f.from !== '' ? +f.from : null, to = f.to != null && f.to !== '' ? +f.to : null;
    let re = null;
    if (q && f.regex) { try { re = new RegExp(f.q, 'i'); } catch (e) { re = null; } }
    return (entries || []).filter(e => {
      if (lv && lv.indexOf(e.level) < 0) return false;
      if (from != null && (e.ts == null || e.ts < from)) return false;
      if (to != null && (e.ts == null || e.ts > to)) return false;
      if (q) {
        if (re) { if (!re.test(e.msg) && !(e.logger && re.test(e.logger))) return false; }
        else if ((e.msg + ' ' + (e.logger || '')).toLowerCase().indexOf(q) < 0) return false;
      }
      return true;
    });
  }
  function firstErrorIn(entries, from, to) {
    let best = null;
    (entries || []).forEach(e => {
      if (!isErr(e.level)) return;
      if (from != null && (e.ts == null || e.ts < from)) return;
      if (to != null && (e.ts == null || e.ts > to)) return;
      if (!best || (e.ts != null && best.ts != null ? (e.ts < best.ts || (e.ts === best.ts && e.line < best.line)) : e.line < best.line)) best = e;
    });
    return best;
  }

  function csvCell(v) { const s = String(v == null ? '' : v); return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? '"' + (/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""') + '"' : s; }
  function groupsToCSV(r) {
    const rows = [['Count', 'Level', 'Template', 'First seen', 'Last seen', 'First line', 'Example']];
    (r.groups || []).forEach(g => rows.push([g.count, g.level, g.template, fmtTime(g.first), fmtTime(g.last), g.firstLine, g.example]));
    return rows.map(x => x.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }
  function endpointsToCSV(r) {
    const rows = [['Endpoint', 'Requests', '5xx', '4xx', 'Error %', 'Avg ms', 'p50 ms', 'p95 ms', 'p99 ms', 'Max ms']];
    ((r.access && r.access.endpoints) || []).forEach(e => rows.push([e.endpoint, e.count, e.errors, e.client, e.errorPct, e.avg, e.p50, e.p95, e.p99, e.max]));
    return rows.map(x => x.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }
  const md = s => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  function toMarkdown(r, name) {
    const L = ['### Log analysis' + (name ? ': ' + name : ''), ''];
    L.push('- **Format:** ' + r.formatLabel + ' · **Lines:** ' + r.lines.toLocaleString('en-AU') + ' · **Entries:** ' + r.entries.toLocaleString('en-AU'));
    if (r.firstTs != null) L.push('- **Time range:** ' + fmtTime(r.firstTs) + ' to ' + fmtTime(r.lastTs));
    L.push('- **Levels:** ' + LEVELS.filter(l => r.levels[l]).map(l => l + ' ' + r.levels[l].toLocaleString('en-AU')).join(', '));
    if (r.firstError) L.push('- **First error (line ' + r.firstError.line + (r.firstError.ts != null ? ', ' + fmtTime(r.firstError.ts) : '') + '):** `' + md(r.firstError.msg.slice(0, 200)) + '`');
    if (r.timeline && r.timeline.spikes.length) L.push('- **Error spikes:** ' + r.timeline.spikes.slice(0, 5).map(s => fmtTime(s.t, false) + ' (' + s.errors + ' errors)').join(', '));
    L.push('');
    if (r.groups.length) {
      L.push('**Top errors**', '', '| Count | Message template | First seen | Last seen |', '|---:|---|---|---|');
      r.groups.slice(0, 15).forEach(g => L.push('| ' + g.count + ' | `' + md(g.template.slice(0, 160)) + '` | ' + fmtTime(g.first) + ' | ' + fmtTime(g.last) + ' |'));
      L.push('');
    }
    if (r.stacks.length) {
      L.push('**Exceptions**', '', '| Count | Exception | Top frame |', '|---:|---|---|');
      r.stacks.slice(0, 10).forEach(s => L.push('| ' + s.count + ' | `' + md(s.type) + '`' + (s.root ? ' (caused by `' + md(s.root) + '`)' : '') + ' | `' + md(s.frame || '?') + '` |'));
      L.push('');
    }
    if (r.access) {
      const a = r.access;
      L.push('**HTTP:** ' + a.requests.toLocaleString('en-AU') + ' requests · ' + Object.keys(a.classes).filter(k => a.classes[k]).map(k => k + ' ' + a.classes[k]).join(', '), '');
      if (a.slowest.length) { L.push('| Slowest endpoints (p95) | Requests | p95 ms |', '|---|---:|---:|'); a.slowest.slice(0, 10).forEach(e => L.push('| `' + md(e.endpoint) + '` | ' + e.count + ' | ' + e.p95 + ' |')); L.push(''); }
    }
    L.push('_Analysed in the browser with Log Analyser (pawansinha.com.au/tools/log-analyser/)._');
    return L.join('\n');
  }

  const api = { createAnalyser, analyseText, detectFormat, template, endpoint, stackInfo, normLevel, anyTime, fmtTime, filterEntries, firstErrorIn, groupsToCSV, endpointsToCSV, toMarkdown, LEVELS, FORMAT_LABEL,
    parsers: { json: parseJSON, logfmt: parseLogfmt, java: parseJavaLike, access: parseAccess, syslog: parseSyslog, plain: parsePlain } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LogAnalyser = api;
})(typeof self !== 'undefined' ? self : this);
