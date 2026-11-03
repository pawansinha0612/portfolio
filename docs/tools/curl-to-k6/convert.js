/* curl → k6 converter. Runs in the browser (window.CurlToK6) and in Node (module.exports), so it can be unit-tested.
   Nothing is sent anywhere: all parsing happens on the visitor's machine.

   Accepts one or more curl commands: Chrome/Edge/Firefox "Copy as cURL (bash)" and "Copy all as cURL",
   "Copy as cURL (cmd)" with ^ escapes, and hand-written commands. Produces a k6 (v1.x) script. */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- shell tokenizing

  const SEP = { sep: true };

  // POSIX shell (bash) rules: '...', "...", $'...', backslash escapes and line continuations.
  // Unquoted ; && || | & and newlines end a command.
  function tokenizeBash(text) {
    const out = [];
    let cur = null;          // current word, or null between words
    let i = 0;
    const n = text.length;
    const push = () => { if (cur !== null) { out.push(cur); cur = null; } };
    while (i < n) {
      const c = text[i];
      if (c === '\\') {
        if (text[i + 1] === '\n') { i += 2; continue; }
        if (text[i + 1] === '\r' && text[i + 2] === '\n') { i += 3; continue; }
        if (i + 1 < n) { cur = (cur || '') + text[i + 1]; i += 2; continue; }
        i++; continue;
      }
      if (c === "'") {
        const end = text.indexOf("'", i + 1);
        const stop = end < 0 ? n : end;
        cur = (cur || '') + text.slice(i + 1, stop);
        i = stop + 1;
        continue;
      }
      if (c === '$' && text[i + 1] === "'") {
        const r = ansiC(text, i + 2);
        cur = (cur || '') + r.value;
        i = r.next;
        continue;
      }
      if (c === '"') {
        let j = i + 1, s = '';
        while (j < n && text[j] !== '"') {
          if (text[j] === '\\' && j + 1 < n && '$`"\\\n'.includes(text[j + 1])) {
            if (text[j + 1] !== '\n') s += text[j + 1];
            j += 2;
          } else { s += text[j]; j++; }
        }
        cur = (cur || '') + s;
        i = j + 1;
        continue;
      }
      if (c === '\n' || c === ';' || c === '|' || c === '&') {
        push();
        out.push(SEP);
        i++;
        while (i < n && (text[i] === '&' || text[i] === '|')) i++;
        continue;
      }
      if (c === ' ' || c === '\t' || c === '\r') { push(); i++; continue; }
      if (c === '#' && cur === null) {          // comment to end of line
        while (i < n && text[i] !== '\n') i++;
        continue;
      }
      cur = (cur || '') + c;
      i++;
    }
    push();
    return out;
  }

  // Bash $'...' (ANSI-C quoting), used by Chrome for bodies with special characters.
  function ansiC(text, i) {
    let s = '';
    const n = text.length;
    while (i < n && text[i] !== "'") {
      if (text[i] !== '\\' || i + 1 >= n) { s += text[i++]; continue; }
      const e = text[i + 1];
      const simple = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '?': '?' };
      if (e in simple) { s += simple[e]; i += 2; continue; }
      let m;
      if (e === 'x' && (m = /^[0-9a-fA-F]{1,2}/.exec(text.slice(i + 2)))) { s += String.fromCharCode(parseInt(m[0], 16)); i += 2 + m[0].length; continue; }
      if (e === 'u' && (m = /^[0-9a-fA-F]{1,4}/.exec(text.slice(i + 2)))) { s += String.fromCharCode(parseInt(m[0], 16)); i += 2 + m[0].length; continue; }
      if (e === 'U' && (m = /^[0-9a-fA-F]{1,8}/.exec(text.slice(i + 2)))) { s += String.fromCodePoint(parseInt(m[0], 16)); i += 2 + m[0].length; continue; }
      if ((m = /^[0-7]{1,3}/.exec(text.slice(i + 1)))) { s += String.fromCharCode(parseInt(m[0], 8)); i += 1 + m[0].length; continue; }
      s += '\\' + e; i += 2;
    }
    return { value: s, next: i + 1 };
  }

  // Windows cmd.exe ("Copy as cURL (cmd)"): ^ escapes the next character, ^ at a line end continues the line,
  // then curl.exe splits arguments with the Microsoft C runtime rules ("..." groups, \" is a literal quote).
  function tokenizeCmd(text) {
    let s = '';
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '^') {
        if (text[i + 1] === '\r' && text[i + 2] === '\n') { i += 2; continue; }
        if (text[i + 1] === '\n') { i += 1; continue; }
        if (i + 1 < text.length) { s += '\u0000' + text[i + 1]; i++; }   // mark as escaped
        continue;
      }
      s += c;
    }
    const out = [];
    let cur = null, inQ = false;
    const push = () => { if (cur !== null) { out.push(cur); cur = null; } };
    for (let i = 0; i < s.length; i++) {
      let c = s[i];
      let escaped = false;
      if (c === '\u0000') { escaped = true; c = s[++i]; }
      if (c === '\\') {
        // count backslashes before a quote
        let j = i, bs = 0;
        while (s[j] === '\\') { bs++; j++; }
        let q = s[j];
        if (q === '\u0000' && s[j + 1] === '"') { q = '"'; }
        if (q === '"') {
          cur = (cur || '') + '\\'.repeat(Math.floor(bs / 2));
          if (bs % 2) { cur += '"'; i = j + (s[j] === '\u0000' ? 1 : 0); continue; }
          i = j - 1; continue;
        }
        cur = (cur || '') + '\\'.repeat(bs);
        i = j - 1;
        continue;
      }
      if (c === '"') { inQ = !inQ; cur = cur || ''; continue; }
      if (!inQ && !escaped && (c === '&' || c === '\n' || c === '|')) { push(); out.push(SEP); continue; }
      if (!inQ && (c === ' ' || c === '\t' || c === '\r' || c === '\n')) { push(); continue; }
      cur = (cur || '') + c;
    }
    push();
    return out;
  }

  function looksLikeCmd(text) {
    return /\^"/.test(text) || /\s\^\r?\n/.test(text) || /^\s*curl(\.exe)?\s+"/m.test(text) && !/'/.test(text);
  }

  // Split tokens into commands. A command starts at a "curl" word; anything before the first curl is ignored,
  // and pieces after a newline that don't start with curl are treated as part of the previous command.
  function splitCommands(text) {
    const tokens = looksLikeCmd(text) ? tokenizeCmd(text) : tokenizeBash(text);
    const cmds = [];
    let cur = null, fresh = true;
    for (const t of tokens) {
      if (t === SEP || t === '&' || t === ';' || t === '&&') { fresh = true; continue; }
      if (fresh && /^(\$|>|%|PS>|sudo)$/.test(t)) continue;      // a pasted shell prompt
      if (fresh && /^(?:.*[\\/])?curl(?:\.exe)?$/i.test(t)) { cur = []; cmds.push(cur); fresh = false; continue; }
      fresh = false;
      if (cur) cur.push(t);
    }
    return cmds;
  }

  // ---------------------------------------------------------------- curl options

  const SHORT_VALUE = new Set('XHdFubAeoTwmxEcrDKCyYzPQtU'.split(''));
  const LONG = {
    // value options we use
    request: 'v', header: 'v', data: 'v', 'data-raw': 'v', 'data-binary': 'v', 'data-ascii': 'v', 'data-urlencode': 'v', json: 'v',
    form: 'v', 'form-string': 'v', user: 'v', cookie: 'v', 'user-agent': 'v', referer: 'v', url: 'v', 'oauth2-bearer': 'v',
    // value options we ignore (their value must still be skipped)
    output: 'i', 'max-time': 'i', 'connect-timeout': 'i', retry: 'i', 'retry-delay': 'i', 'retry-max-time': 'i', proxy: 'i',
    'proxy-user': 'i', cacert: 'i', capath: 'i', cert: 'i', key: 'i', 'cert-type': 'i', 'key-type': 'i', resolve: 'i',
    'write-out': 'i', 'cookie-jar': 'i', 'limit-rate': 'i', interface: 'i', 'dump-header': 'i', 'upload-file': 'i', range: 'i',
    'continue-at': 'i', 'max-redirs': 'i', ciphers: 'i', 'connect-to': 'i', 'aws-sigv4': 'i', 'unix-socket': 'i', trace: 'i',
    'trace-ascii': 'i', config: 'i', 'netrc-file': 'i', 'expect100-timeout': 'i', 'keepalive-time': 'i', 'local-port': 'i',
    'max-filesize': 'i', 'speed-limit': 'i', 'speed-time': 'i', 'tls-max': 'i', 'pass': 'i', 'proto': 'i', 'proto-redir': 'i',
    'request-target': 'i', 'happy-eyeballs-timeout-ms': 'i', 'variable': 'i', 'url-query': 'v', 'stderr': 'i', 'time-cond': 'i',
    'dns-servers': 'i', 'doh-url': 'i', 'noproxy': 'i', 'preproxy': 'i', 'proxy-header': 'i', 'socks5': 'i', 'socks5-hostname': 'i',
    'hostpubmd5': 'i', 'pinnedpubkey': 'i', 'retry-all-errors': 'f', 'ssl-reqd': 'f',
  };
  const SHORT_ALIAS = { X: 'request', H: 'header', d: 'data', F: 'form', u: 'user', b: 'cookie', A: 'user-agent', e: 'referer' };
  // flags (no value) that mean something for k6
  const FLAG_NOTES = {
    compressed: 'compressed', k: 'insecure', insecure: 'insecure', L: 'location', location: 'location', G: 'get', get: 'get',
    I: 'head', head: 'head',
  };
  // flags that are harmless to drop without comment
  const QUIET_FLAGS = new Set(['s', 'S', 'v', 'i', 'f', 'n', 'N', 'q', '#', 'silent', 'show-error', 'verbose', 'include', 'fail',
    'fail-with-body', 'no-buffer', 'progress-bar', 'http1.1', 'http2', 'http2-prior-knowledge', 'http1.0', 'http3', 'globoff', 'g',
    'path-as-is', 'tlsv1.2', 'tlsv1.3', 'ipv4', 'ipv6', '4', '6', 'no-progress-meter', 'O', 'remote-name', 'J', 'remote-header-name',
    'compressed-ssh', 'tcp-nodelay', 'no-keepalive', 'raw', 'Z', 'parallel']);

  function parseCurl(args) {
    const r = { method: null, url: null, headers: [], data: [], dataMode: null, urlencode: [], form: [], user: null,
      cookies: [], insecure: false, get: false, head: false, compressed: false, notes: [], ignored: [], extraUrls: [] };
    const positionals = [];
    const setHeader = (raw) => {
      const idx = raw.indexOf(':');
      if (idx < 0) {
        // "Name;" sends an empty header. Anything else isn't a header.
        if (/;$/.test(raw.trim())) r.headers.push([raw.trim().slice(0, -1), '']);
        else r.notes.push(`Skipped a header without a colon: ${raw}`);
        return;
      }
      const name = raw.slice(0, idx).trim();
      const value = raw.slice(idx + 1).trim();
      if (!name) return;
      if (!value) { r.headers = r.headers.filter(([k]) => k.toLowerCase() !== name.toLowerCase()); return; }  // "Name:" removes it
      r.headers.push([name, value]);
    };
    const take = (opt, value) => {
      switch (opt) {
        case 'request': r.method = String(value).toUpperCase(); break;
        case 'header': setHeader(value); break;
        case 'data': case 'data-ascii': case 'data-binary': case 'data-raw': {
          let val = value;
          if (opt !== 'data-raw' && val.startsWith('@')) {
            r.notes.push(`curl reads the body from the file ${val.slice(1)}. Put that file next to the script; it is loaded with open().`);
            r.data.push({ file: val.slice(1) });
            break;
          }
          if (opt === 'data' || opt === 'data-ascii') val = val.replace(/[\r\n]/g, '');   // curl strips newlines for -d
          r.data.push({ text: val });
          break;
        }
        case 'data-urlencode': r.data.push({ text: urlencodeArg(value, r) }); break;
        case 'url-query': r.urlencode.push(urlencodeArg(value, r)); break;
        case 'json':
          r.data.push(value.startsWith('@') ? { file: value.slice(1) } : { text: value });
          r.json = true;
          break;
        case 'form': case 'form-string': r.form.push({ raw: value, literal: opt === 'form-string' }); break;
        case 'user': r.user = value; break;
        case 'cookie':
          if (value.includes('=')) r.cookies.push(value);
          else r.notes.push(`-b ${value} reads cookies from a file, which k6 can't do. Add the cookies as a Cookie header instead.`);
          break;
        case 'user-agent': r.headers.push(['User-Agent', value]); break;
        case 'referer': r.headers.push(['Referer', value.replace(/;auto$/, '')]); break;
        case 'url': positionals.push(value); break;
        case 'oauth2-bearer': r.headers.push(['Authorization', 'Bearer ' + value]); break;
      }
    };
    const flag = (name, display) => {
      const f = FLAG_NOTES[name];
      if (f === 'insecure') r.insecure = true;
      else if (f === 'get') r.get = true;
      else if (f === 'head') r.head = true;
      else if (f === 'compressed') r.compressed = true;
      else if (f === 'location') { /* k6 follows redirects by default */ }
      else if (!QUIET_FLAGS.has(name)) r.ignored.push(display);
    };

    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { positionals.push(...args.slice(i + 1)); break; }
      if (a.startsWith('--') && a.length > 2) {
        let name = a.slice(2), inline = null;
        const eq = name.indexOf('=');
        if (eq > 0 && !(name in LONG)) { inline = name.slice(eq + 1); name = name.slice(0, eq); }
        if (name.startsWith('no-') && !(name in LONG) && !QUIET_FLAGS.has(name)) { continue; }
        const kind = LONG[name];
        if (kind === 'v' || kind === 'i') {
          const value = inline != null ? inline : args[++i];
          if (value == null) break;
          if (kind === 'v') take(name, value);
          else r.ignored.push(`--${name} ${value}`);
        } else {
          flag(name, a);
        }
        continue;
      }
      if (a.startsWith('-') && a.length > 1) {
        // short options, possibly bundled (-sSL) or with an attached value (-XPOST, -H'...')
        for (let j = 1; j < a.length; j++) {
          const ch = a[j];
          if (SHORT_VALUE.has(ch)) {
            const value = j + 1 < a.length ? a.slice(j + 1) : args[++i];
            if (value == null) break;
            if (SHORT_ALIAS[ch]) take(SHORT_ALIAS[ch], value);
            else r.ignored.push(`-${ch} ${value}`);
            break;
          }
          flag(ch, '-' + ch);
        }
        continue;
      }
      positionals.push(a);
    }

    // The URL: the first positional that looks like one
    const urlLike = positionals.filter(p => /^(https?:\/\/|[\w.-]+\.[a-z]{2,}|localhost|\d+\.\d+\.\d+\.\d+|\[)/i.test(p));
    r.url = urlLike[0] || positionals[0] || null;
    r.extraUrls = positionals.filter(p => p !== r.url);
    if (r.url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(r.url)) r.url = 'http://' + r.url;   // curl's default scheme
    return r;
  }

  // curl --data-urlencode forms: "content", "=content", "name=content", "@file", "name@file"
  function urlencodeArg(v, r) {
    const enc = s => encodeURIComponent(s).replace(/%20/g, '+').replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    const eq = v.indexOf('='), at = v.indexOf('@');
    if (at >= 0 && (eq < 0 || at < eq)) {
      r.notes.push(`--data-urlencode ${v} reads a file, which this converter can't see. Replace the placeholder value.`);
      return (at > 0 ? v.slice(0, at) + '=' : '') + 'FILE_CONTENTS';
    }
    if (eq === 0) return enc(v.slice(1));
    if (eq > 0) return v.slice(0, eq) + '=' + enc(v.slice(eq + 1));
    return enc(v);
  }

  // ---------------------------------------------------------------- building requests

  const STATIC_EXT = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|css|js|mjs|map|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|m4a)(\?|#|$)/i;
  const NOISY = name => /^(sec-ch-|sec-fetch-|sec-gpc$|priority$|accept-encoding$|upgrade-insecure-requests$|dnt$|purpose$|x-client-data$|sec-purpose$)/i.test(name);
  const ALWAYS_DROP = /^(content-length|host|connection|keep-alive|transfer-encoding|te|expect)$/i;
  const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|x-api-key|api-key|apikey|x-auth-token|x-access-token|x-csrf-token|x-xsrf-token|x-amz-security-token|x-goog-api-key|ocp-apim-subscription-key)$/i;
  const SECRET_HEADER_LOOSE = /(token|secret|api[-_]?key|auth|session|password|signature)/i;
  const SECRET_PARAM = /^(access_token|token|api_?key|key|secret|client_secret|password|pwd|sig|signature|auth|session|sessionid|code|id_token|refresh_token|x-amz-signature|x-amz-credential|x-amz-security-token)$/i;

  function buildRequest(p) {
    const req = { method: 'GET', url: p.url, headers: [], body: null, bodyKind: null, files: [], formParts: null, notes: p.notes.slice(), ignored: p.ignored.slice(), secrets: [] };
    if (!p.url) return null;

    // headers, last one wins (case-insensitive), in first-seen order
    const seen = new Map();
    for (const [k, v] of p.headers) {
      const key = k.toLowerCase();
      if (seen.has(key)) seen.get(key)[1] = v;
      else { const pair = [k, v]; seen.set(key, pair); req.headers.push(pair); }
    }
    if (p.cookies.length) {
      const existing = seen.get('cookie');
      const value = p.cookies.join('; ');
      if (existing) existing[1] = existing[1] + '; ' + value;
      else { const pair = ['Cookie', value]; seen.set('cookie', pair); req.headers.push(pair); }
    }
    if (p.user != null) {
      req.basicAuth = p.user.includes(':') ? p.user : p.user + ':';
      if (!p.user.includes(':')) req.notes.push('-u had no password; curl would prompt for one. Add it after the colon.');
    }

    let url = p.url;
    const dataText = p.data.map(d => d.text != null ? d.text : null);
    const fileData = p.data.filter(d => d.file);
    if (p.urlencode.length) url += (url.includes('?') ? '&' : '?') + p.urlencode.join('&');

    if (p.form.length) {
      req.formParts = p.form.map(f => parseFormPart(f.raw, f.literal, req));
      req.method = 'POST';
    } else if (p.data.length) {
      if (p.get) {
        url += (url.includes('?') ? '&' : '?') + dataText.filter(t => t != null).join('&');
        req.method = 'GET';
      } else {
        req.method = 'POST';
        if (fileData.length) {
          req.bodyFile = fileData[0].file;
          if (fileData.length > 1 || dataText.some(t => t != null)) req.notes.push('Only the first @file body is used; curl would join them with &.');
        } else {
          req.body = dataText.join(p.json ? '' : '&');
        }
        if (p.json) {
          if (!seen.has('content-type')) req.headers.push(['Content-Type', 'application/json']);
          if (!seen.has('accept')) req.headers.push(['Accept', 'application/json']);
        } else if (!seen.has('content-type')) {
          req.headers.push(['Content-Type', 'application/x-www-form-urlencoded']);   // curl -d sends this
        }
      }
    }
    if (p.head) req.method = 'HEAD';
    if (p.method) req.method = p.method;
    req.url = url;

    // body type
    const ct = (req.headers.find(([k]) => k.toLowerCase() === 'content-type') || [])[1] || '';
    if (req.body != null) {
      if (/json/i.test(ct) || p.json) {
        try { req.json = JSON.parse(req.body); req.bodyKind = 'json'; } catch (e) { req.bodyKind = 'text'; }
      } else {
        req.bodyKind = /x-www-form-urlencoded/i.test(ct) ? 'form' : 'text';
      }
    }
    if (p.extraUrls.length) req.notes.push('Ignored extra arguments: ' + p.extraUrls.join(' '));
    return req;
  }

  function parseFormPart(raw, literal, req) {
    const eq = raw.indexOf('=');
    const name = eq < 0 ? raw : raw.slice(0, eq);
    let value = eq < 0 ? '' : raw.slice(eq + 1);
    if (!literal && (value.startsWith('@') || value.startsWith('<'))) {
      // name=@path;type=mime;filename=x
      const bits = value.slice(1).split(';');
      const path = bits.shift();
      const part = { name, file: path, filename: path.split(/[\\/]/).pop(), type: null, fromContents: value[0] === '<' };
      for (const b of bits) {
        const m = b.match(/^\s*(type|filename)=(.*)$/);
        if (m) part[m[1] === 'type' ? 'type' : 'filename'] = m[2].replace(/^"|"$/g, '');
      }
      req.files.push(part.file);
      return part;
    }
    if (!literal) value = value.replace(/;type=[^;]*$/, '');
    return { name, value };
  }

  // ---------------------------------------------------------------- code generation

  function lit(s) {
    return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,
        c => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0')) + "'";
  }

  // template literal with ${...} expressions kept as code
  function tpl(parts) {
    return '`' + parts.map(p => typeof p === 'string'
      ? p.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${').replace(/\n/g, '\\n').replace(/\r/g, '\\r')
      : '${' + p.code + '}').join('') + '`';
  }

  function key(k) {
    return /^[A-Za-z_$][\w$]*$/.test(k) ? k : lit(k);
  }

  function envName(name, used) {
    let base = String(name).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'SECRET';
    if (/^\d/.test(base)) base = '_' + base;
    let n = base, i = 2;
    while (used.has(n)) n = base + '_' + i++;
    used.add(n);
    return n;
  }

  function jsValue(v, indent) {
    // JSON is valid JavaScript; pretty-print with the script's indentation
    return JSON.stringify(v, null, 2).replace(/\n/g, '\n' + indent);
  }

  // Replace ids in the path so many URLs share one name in the results (avoids high-cardinality metrics)
  function templatePath(path) {
    return path.split('/').map(seg => {
      if (!seg) return seg;
      if (/^\d+$/.test(seg)) return '{id}';
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return '{uuid}';
      if (/^[0-9a-f]{16,}$/i.test(seg)) return '{id}';
      if (/^[A-Za-z0-9_-]{20,}$/.test(seg) && /\d/.test(seg) && /[A-Za-z]/.test(seg)) return '{token}';
      if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(decodeURIComponentSafe(seg))) return '{email}';
      return seg;
    }).join('/');
  }

  function decodeURIComponentSafe(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }

  function splitUrl(u) {
    const m = String(u).match(/^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)([^?#]*)(\?[^#]*)?/i);
    if (!m) return { origin: '', path: u, query: '' };
    return { origin: m[1], path: m[2] || '/', query: m[3] || '' };
  }

  const DEFAULTS = {
    model: 'closed',          // 'closed' (VUs + duration) or 'open' (constant-arrival-rate)
    vus: 10, duration: '1m',
    rate: 10, timeUnit: '1s', preAllocatedVUs: 20, maxVUs: 100,
    thinkTime: 1,             // seconds between requests and at the end of each iteration (closed model)
    p95: 500,                 // ms, 0 to skip
    errorRate: 1,             // %, empty/negative to skip
    checks: true,
    group: '',                // group name, '' for none
    nameTags: true,
    dropNoisy: true,
    keepUserAgent: false,
    skipStatic: true,
    secretsToEnv: true,
    baseUrl: true,
  };

  function convert(text, options) {
    const o = Object.assign({}, DEFAULTS, options || {});
    const result = { script: '', warnings: [], info: [], env: [], requests: 0, skipped: 0 };
    const cmds = splitCommands(String(text || ''));
    if (!cmds.length) {
      result.error = String(text || '').trim()
        ? "I couldn't find a curl command. It should start with curl, for example: curl 'https://api.example.com/items' -H 'accept: application/json'"
        : 'Paste a curl command first.';
      return result;
    }

    let reqs = cmds.map(parseCurl).map(buildRequest).filter(Boolean);
    if (!reqs.length) { result.error = "The curl command has no URL."; return result; }
    if (o.skipStatic) {
      const before = reqs.length;
      reqs = reqs.filter(r => !STATIC_EXT.test(r.url) && !/^(data|blob|chrome-extension):/i.test(r.url));
      result.skipped = before - reqs.length;
      if (!reqs.length) { result.error = 'All the requests were images, scripts, styles or fonts, which are skipped. Untick "Skip static files" to keep them.'; return result; }
    }
    result.requests = reqs.length;

    const usedEnv = new Set(['BASE_URL']);
    const envMap = new Map();        // secret value → env name, so the same token is reused
    const secretEnv = (label, value) => {
      if (envMap.has(value)) return envMap.get(value);
      const n = envName(label, usedEnv);
      envMap.set(value, n);
      result.env.push({ name: n, label, preview: value.length > 14 ? value.slice(0, 6) + '…' + value.slice(-4) : value });
      return n;
    };
    const secretsFound = new Set();
    const bodySecrets = new Set();

    // shared origin → BASE_URL
    const origins = [...new Set(reqs.map(r => splitUrl(r.url).origin))];
    const useBase = o.baseUrl && origins.length === 1 && origins[0];

    const needs = { check: false, sleep: false, group: false, encoding: false, formdata: false };
    const initLines = [];
    const fileVars = new Map();
    const fileVar = (path, binary) => {
      if (fileVars.has(path)) return fileVars.get(path);
      const name = 'file' + (fileVars.size + 1);
      fileVars.set(path, name);
      initLines.push(`// TODO: put ${path.split(/[\\/]/).pop()} next to this script (open() reads files when k6 starts, not during the test)`);
      initLines.push(`const ${name} = open(${lit('./' + path.split(/[\\/]/).pop())}${binary ? ", 'b'" : ''});`);
      return name;
    };

    const body = [];
    const ind = '';   // lines are built at relative indentation; indent() adds the block's indentation
    const usedNames = new Map();

    reqs.forEach((r, idx) => {
      const lines = [];
      const { origin, path, query } = splitUrl(r.url);
      const tplPath = templatePath(path);

      // ---- URL (with secrets in the query string moved to env)
      let queryOut = query;
      const urlParts = [];
      if (query && o.secretsToEnv) {
        const parts = query.slice(1).split('&').map(kv => {
          const eq = kv.indexOf('=');
          const k = eq < 0 ? kv : kv.slice(0, eq), val = eq < 0 ? '' : kv.slice(eq + 1);
          if (val && SECRET_PARAM.test(decodeURIComponentSafe(k))) {
            secretsFound.add(`the ${decodeURIComponentSafe(k)} URL parameter`);
            return [k + '=', { code: `__ENV.${secretEnv(k, decodeURIComponentSafe(val))}` }];
          }
          return [kv];
        });
        queryOut = null;
        urlParts.push(useBase ? { code: 'BASE_URL' } : origin, path, '?');
        parts.forEach((p, i) => { if (i) urlParts.push('&'); urlParts.push(...p); });
      } else if (query) {
        for (const kv of query.slice(1).split('&')) {
          const k = kv.split('=')[0];
          if (SECRET_PARAM.test(decodeURIComponentSafe(k)) && kv.includes('=')) secretsFound.add(`the ${decodeURIComponentSafe(k)} URL parameter`);
        }
      }
      let urlCode;
      if (urlParts.length) urlCode = tpl(urlParts.reduce((acc, p) => {     // merge adjacent strings
        if (typeof p === 'string' && typeof acc[acc.length - 1] === 'string') acc[acc.length - 1] += p; else acc.push(p);
        return acc;
      }, []));
      else if (useBase) urlCode = tpl([{ code: 'BASE_URL' }, path + (queryOut || '')]);
      else urlCode = lit(r.url);

      // ---- headers
      const headers = [];
      for (const [k, v] of r.headers) {
        if (ALWAYS_DROP.test(k)) continue;
        if (o.dropNoisy && NOISY(k)) continue;
        if (o.dropNoisy && /^user-agent$/i.test(k) && !o.keepUserAgent) continue;
        if (/^content-type$/i.test(k) && r.formParts) continue;      // FormData sets the multipart boundary
        const secret = SECRET_HEADER.test(k) || (SECRET_HEADER_LOOSE.test(k) && v.length >= 8);
        if (secret) secretsFound.add(`the ${k} header`);
        if (secret && o.secretsToEnv) headers.push([k, { code: `__ENV.${secretEnv(k, v)}` }]);
        else headers.push([k, v]);
      }
      if (r.basicAuth != null) {
        secretsFound.add('the -u user name and password');
        needs.encoding = true;
        const val = o.secretsToEnv ? { code: `__ENV.${secretEnv('BASIC_AUTH', r.basicAuth)}` } : lit(r.basicAuth);
        headers.push(['Authorization', { code: `\`Basic \${encoding.b64encode(${typeof val === 'string' ? val : val.code})}\`` }]);
      }

      // ---- body
      let bodyCode = null;
      if (r.formParts) {
        needs.formdata = true;
        lines.push('const fd = new FormData();');
        for (const part of r.formParts) {
          if (part.file != null) {
            const fv = fileVar(part.file, !part.fromContents);
            if (part.fromContents) lines.push(`fd.append(${lit(part.name)}, ${fv});`);
            else lines.push(`fd.append(${lit(part.name)}, http.file(${fv}, ${lit(part.filename)}${part.type ? ', ' + lit(part.type) : ''}));`);
          } else {
            lines.push(`fd.append(${lit(part.name)}, ${lit(part.value)});`);
          }
        }
        headers.push(['Content-Type', { code: "'multipart/form-data; boundary=' + fd.boundary" }]);
        bodyCode = 'fd.body()';
      } else if (r.bodyFile) {
        bodyCode = fileVar(r.bodyFile, true);
      } else if (r.body != null) {
        if (/password|passwd|secret|client_secret|api_?key|token/i.test(r.body)) bodySecrets.add(r.method + ' ' + tplPath);
        if (r.bodyKind === 'json' && r.json !== null && typeof r.json === 'object') bodyCode = `JSON.stringify(${jsValue(r.json, ind)})`;
        else bodyCode = lit(r.body);
      }

      // ---- params
      const params = [];
      if (headers.length) {
        params.push(`headers: {\n` + headers.map(([k, v]) => `${ind}    ${key(k)}: ${typeof v === 'string' ? lit(v) : v.code},`).join('\n') + `\n${ind}  }`);
      }
      const label = r.method + ' ' + tplPath;
      if (o.nameTags && (tplPath !== path || query)) {
        const nm = (useBase || origins.length === 1 ? '' : origin) + tplPath;
        params.push(`tags: { name: ${lit(nm)} }`);
      }
      const paramsCode = params.length ? `{\n${ind}  ${params.join(`,\n${ind}  `)},\n${ind}}` : null;

      // ---- call
      const m = r.method;
      let call;
      const args = [urlCode];
      if (m === 'GET' && bodyCode == null) { call = 'http.get'; if (paramsCode) args.push(paramsCode); }
      else if (m === 'HEAD' && bodyCode == null) { call = 'http.head'; if (paramsCode) args.push(paramsCode); }
      else if (['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(m)) {
        call = { POST: 'http.post', PUT: 'http.put', PATCH: 'http.patch', DELETE: 'http.del', OPTIONS: 'http.options' }[m];
        if (bodyCode != null || paramsCode) args.push(bodyCode != null ? bodyCode : 'null');
        if (paramsCode) args.push(paramsCode);
      } else {
        call = 'http.request';
        args.unshift(lit(m));
        args.push(bodyCode != null ? bodyCode : 'null');
        if (paramsCode) args.push(paramsCode);
      }

      for (const n of r.notes) lines.unshift(`// NOTE: ${n.replace(/\n/g, ' ')}`);
      for (const ig of r.ignored) lines.unshift(`// Ignored curl option (no k6 equivalent needed): ${ig.replace(/\n/g, ' ')}`);
      lines.push(`res = ${call}(${args.join(', ')});`);

      if (o.checks) {
        needs.check = true;
        let checkName = label;
        const count = (usedNames.get(label) || 0) + 1;
        usedNames.set(label, count);
        if (count > 1) checkName += ` (#${count})`;
        lines.push(`check(res, { ${lit(checkName + ' status is 2xx')}: (r) => r.status >= 200 && r.status < 300 });`);
      }
      if (o.thinkTime > 0 && idx < reqs.length - 1) { needs.sleep = true; lines.push(`sleep(${o.thinkTime});`); }

      if (r.formParts && reqs.length > 1) {
        // keep each FormData in its own block so the const name can repeat
        body.push(`{\n${lines.map(l => '  ' + l).join('\n')}\n}`);
      } else {
        body.push(lines.join('\n'));
      }
    });

    if (o.thinkTime > 0 && o.model === 'closed') needs.sleep = true;
    if (o.group) needs.group = true;

    // ---- assemble
    const out = [];
    out.push(`// Generated by the curl to k6 converter: https://pawansinha.com.au/tools/curl-to-k6/`);
    out.push(`// Run it with: k6 run${result.env.length ? result.env.map(e => ` -e ${e.name}=...`).join('') : ''}${useBase ? '' : ''} script.js`);
    if (useBase) out.push(`// Point it at another environment with: k6 run -e BASE_URL=https://staging.example.com script.js`);
    if (o.secretsToEnv && result.env.length) out.push(`// Secrets are read from environment variables (-e NAME=value), so they don't end up in source control.`);
    out.push(`import http from 'k6/http';`);
    const k6imports = ['check', 'group', 'sleep'].filter(n => needs[n]);
    if (k6imports.length) out.push(`import { ${k6imports.join(', ')} } from 'k6';`);
    if (needs.encoding) out.push(`import encoding from 'k6/encoding';`);
    if (needs.formdata) out.push(`import { FormData } from 'https://jslib.k6.io/formdata/0.0.2/index.js';`);
    out.push('');
    if (useBase) { out.push(`const BASE_URL = __ENV.BASE_URL || ${lit(useBase)};`); out.push(''); }
    if (initLines.length) { out.push(...initLines); out.push(''); }

    out.push('export const options = {');
    if (o.model === 'open') {
      const pre = Math.max(1, Math.round(+o.preAllocatedVUs || 1));
      const max = Math.max(pre, Math.round(+o.maxVUs || pre));
      out.push('  // Open model: k6 starts new iterations at a fixed rate, whether or not the system keeps up.');
      out.push('  // VUs needed ≈ rate × iteration duration (Little\'s Law). If k6 reports dropped_iterations, raise maxVUs.');
      out.push('  scenarios: {');
      out.push('    load: {');
      out.push(`      executor: 'constant-arrival-rate',`);
      out.push(`      rate: ${num(o.rate, 1)},`);
      out.push(`      timeUnit: ${lit(o.timeUnit || '1s')},`);
      out.push(`      duration: ${lit(o.duration || '1m')},`);
      out.push(`      preAllocatedVUs: ${pre},`);
      out.push(`      maxVUs: ${max},`);
      out.push('    },');
      out.push('  },');
    } else {
      out.push('  // Closed model: each virtual user runs the journey in a loop.');
      out.push(`  vus: ${Math.max(1, Math.round(+o.vus || 1))},`);
      out.push(`  duration: ${lit(o.duration || '1m')},`);
    }
    const th = [];
    if (+o.p95 > 0) th.push(`    http_req_duration: ['p(95)<${num(o.p95, 500)}'],`);
    if (o.errorRate !== '' && o.errorRate != null && +o.errorRate >= 0 && !isNaN(+o.errorRate)) {
      th.push(+o.errorRate === 0 ? `    http_req_failed: ['rate==0'],` : `    http_req_failed: ['rate<${+(+o.errorRate / 100).toFixed(6)}'],`);
    }
    if (o.checks) th.push(`    checks: ['rate>0.99'],`);
    if (th.length) { out.push('  thresholds: {'); out.push(...th); out.push('  },'); }
    if (cmds.some(c => parseCurl(c).insecure)) {
      out.push('  insecureSkipTLSVerify: true, // from curl -k: only for test environments with self-signed certificates');
    }
    out.push('};');
    out.push('');
    out.push('export default function () {');
    out.push('  let res;');
    const bodyText = body.join('\n\n');
    if (o.group) {
      out.push(`  group(${lit(o.group)}, function () {`);
      out.push(indent(bodyText, '    '));
      out.push('  });');
    } else {
      out.push(indent(bodyText, '  '));
    }
    if (o.thinkTime > 0 && o.model === 'closed') {
      out.push('');
      out.push(`  sleep(${o.thinkTime}); // think time before the next iteration`);
    }
    out.push('}');
    out.push('');
    result.script = out.join('\n');

    // ---- messages
    if (secretsFound.size) {
      result.warnings.push(o.secretsToEnv
        ? `Secrets found in ${[...secretsFound].join(', ')}. They now come from environment variables: pass them with -e when you run k6. Tokens copied from a browser usually expire within minutes or hours; for a real test, log in inside the script (or in setup()) and reuse the token.`
        : `Secrets found in ${[...secretsFound].join(', ')}. They are now in the script as plain text. Don't commit it to source control or share it: tick "Move secrets to environment variables", or use __ENV yourself.`);
    }
    if (bodySecrets.size) {
      result.warnings.push(`The body of ${[...bodySecrets].join(', ')} looks like it holds a password, token or key, and it is in the script as plain text. Use a test account, and read the value from __ENV (for example password: __ENV.TEST_PASSWORD) before you share or commit the script.`);
    }
    if (result.skipped) result.info.push(`Skipped ${result.skipped} static file request${result.skipped > 1 ? 's' : ''} (images, scripts, styles, fonts). A browser caches most of these, and a CDN usually serves them.`);
    if (reqs.some(r => r.files.length || r.bodyFile)) result.warnings.push('This request uploads a local file. Put the file next to the script before you run it (see the TODO in the script).');
    if (cmds.length > 1) result.info.push(`Converted ${reqs.length} request${reqs.length > 1 ? 's' : ''} into one journey, in the order you pasted them.`);
    if (o.model === 'open' && o.thinkTime > 0 && reqs.length > 1) result.info.push('With the open model, think time makes each iteration longer, so k6 needs more VUs to hold the rate. Size maxVUs with the VU calculator.');
    return result;
  }

  function num(v, d) { const n = +v; return isFinite(n) && n > 0 ? n : d; }

  function indent(text, pad) {
    return text.split('\n').map(l => (l ? pad + l : l)).join('\n');
  }

  const EXAMPLES = {
    chrome: `curl 'https://api.example.com/v2/orders?status=open&page=1' \\
  -H 'accept: application/json, text/plain, */*' \\
  -H 'accept-language: en-AU,en;q=0.9' \\
  -H 'authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl' \\
  -H 'origin: https://shop.example.com' \\
  -H 'priority: u=1, i' \\
  -H 'sec-ch-ua: "Chromium";v="130", "Google Chrome";v="130"' \\
  -H 'sec-ch-ua-mobile: ?0' \\
  -H 'sec-fetch-dest: empty' \\
  -H 'sec-fetch-mode: cors' \\
  -H 'sec-fetch-site: same-site' \\
  -H 'user-agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'`,
    journey: `curl 'https://api.example.com/v2/login' \\
  -H 'content-type: application/json' \\
  --data-raw '{"email":"test.user@example.com","password":"Sup3rSecret!"}' ;
curl 'https://api.example.com/v2/products/48213?include=stock' \\
  -H 'accept: application/json' \\
  -b 'session=7f3c9a1b2d4e6f80; region=au' ;
curl 'https://api.example.com/v2/cart/items' \\
  -H 'content-type: application/json' \\
  -b 'session=7f3c9a1b2d4e6f80; region=au' \\
  --data-raw $'{"productId":48213,"qty":2,"note":"Gift \\u2013 wrap it"}'`,
    cmd: `curl ^"https://api.example.com/v2/search?q=red^%^20shoes^&size=20^" ^
  -H ^"accept: application/json^" ^
  -H ^"x-api-key: 4f9d2c71e8a64b0f9c3e^" ^
  --data-raw ^"^{^\\^"filters^\\^":^{^\\^"brand^\\^":^\\^"acme^\\^"^}^}^" ^
  --compressed`,
  };

  const api = { convert, splitCommands, tokenizeBash, tokenizeCmd, parseCurl, buildRequest, templatePath, DEFAULTS, EXAMPLES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CurlToK6 = api;
})(typeof window !== 'undefined' ? window : this);
