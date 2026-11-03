/* JMeter (.jmx) → k6 converter. Runs in the browser (window.JmxToK6) and in Node (module.exports), so it can be
   unit-tested. Nothing is sent anywhere: the test plan is parsed on the visitor's machine.

   What it converts: thread groups (standard, setUp/tearDown, Concurrency and Arrivals plugins) → k6 scenarios;
   HTTP samplers, HTTP Request Defaults and Header Managers (with JMeter's scoping rules); User Defined Variables,
   CSV Data Set, Random Variable and Counter; timers → sleep(); Response, Duration, Size and JSON assertions → check();
   Regex, JSON, Boundary and CSS extractors → variables; Transaction, Simple, Loop, If, Once Only, Random,
   Interleave, Throughput and ForEach controllers; common ${__functions}. Anything else is listed in the notes and
   marked TODO in the script, so nothing is dropped silently. Output targets k6 v1.x. */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- tiny XML parser
  // JMX is plain XML (elements, attributes, text, CDATA, comments, entities). DOMParser isn't in Node, so parse here.

  const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
  function decode(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
      }
      return Object.prototype.hasOwnProperty.call(ENT, e) ? ENT[e] : m;
    });
  }

  function parseXml(text) {
    const rootNode = { name: '#root', attrs: {}, children: [], text: '' };
    const stack = [rootNode];
    let i = 0;
    const n = text.length;
    const top = () => stack[stack.length - 1];
    while (i < n) {
      const lt = text.indexOf('<', i);
      if (lt < 0) { top().text += decode(text.slice(i)); break; }
      if (lt > i) top().text += decode(text.slice(i, lt));
      if (text.startsWith('<!--', lt)) { const e = text.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue; }
      if (text.startsWith('<![CDATA[', lt)) {
        const e = text.indexOf(']]>', lt + 9);
        top().text += text.slice(lt + 9, e < 0 ? n : e);
        i = e < 0 ? n : e + 3;
        continue;
      }
      if (text.startsWith('<?', lt)) { const e = text.indexOf('?>', lt + 2); i = e < 0 ? n : e + 2; continue; }
      if (text.startsWith('<!', lt)) { const e = text.indexOf('>', lt + 2); i = e < 0 ? n : e + 1; continue; }
      if (text[lt + 1] === '/') {
        const e = text.indexOf('>', lt + 2);
        if (e < 0) throw new Error('Unclosed tag near the end of the file.');
        const name = text.slice(lt + 2, e).trim();
        if (top().name !== name) throw new Error('Mismatched </' + name + '>: the file looks cut off or isn\'t a JMeter test plan.');
        stack.pop();
        i = e + 1;
        continue;
      }
      // start tag: scan to '>' outside quotes
      let j = lt + 1, q = null;
      for (; j < n; j++) {
        const c = text[j];
        if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === '>') break;
      }
      if (j >= n) throw new Error('Unclosed tag near the end of the file.');
      let inner = text.slice(lt + 1, j);
      const selfClose = inner.endsWith('/');
      if (selfClose) inner = inner.slice(0, -1);
      const m = /^([^\s/>]+)/.exec(inner);
      if (!m) throw new Error('Bad tag at character ' + lt + '.');
      const node = { name: m[1], attrs: {}, children: [], text: '' };
      const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      let a;
      while ((a = re.exec(inner.slice(m[1].length)))) node.attrs[a[1]] = decode(a[3] !== undefined ? a[3] : a[4]);
      top().children.push(node);
      if (!selfClose) stack.push(node);
      i = j + 1;
    }
    if (stack.length > 1) throw new Error('The file ends before <' + top().name + '> is closed: it looks cut off.');
    return rootNode;
  }

  // ---------------------------------------------------------------- JMX helpers

  const PROP_TAGS = /^(stringProp|boolProp|intProp|longProp|doubleProp|floatProp|elementProp|collectionProp|objProp)$/;
  function prop(el, name) {
    if (!el) return '';
    for (const c of el.children) if (PROP_TAGS.test(c.name) && c.attrs.name === name) return c.name === 'elementProp' || c.name === 'collectionProp' ? c : c.text;
    return '';
  }
  function str(el, name) { const v = prop(el, name); return typeof v === 'string' ? v : ''; }
  function bool(el, name, dflt) { const v = str(el, name).trim().toLowerCase(); return v === '' ? !!dflt : v === 'true'; }
  function elemProp(el, name) { const v = prop(el, name); return v && typeof v === 'object' ? v : null; }
  function collection(el, name) { const c = elemProp(el, name); return c ? c.children : []; }
  function enabled(el) { return el.attrs.enabled !== 'false'; }

  // <hashTree> holds pairs: element, then a <hashTree> with that element's children.
  function walk(hashTree) {
    const out = [];
    const kids = hashTree ? hashTree.children : [];
    for (let k = 0; k < kids.length; k++) {
      const el = kids[k];
      if (el.name === 'hashTree') continue;
      const next = kids[k + 1] && kids[k + 1].name === 'hashTree' ? kids[k + 1] : null;
      out.push({ el, kids: walk(next) });
    }
    return out;
  }

  function kindOf(el) {
    const t = el.attrs.testclass || el.name;
    const gui = el.attrs.guiclass || '';
    if (t === 'ConfigTestElement' && /HttpDefaults/.test(gui)) return 'HttpDefaults';
    if (t === 'ConfigTestElement') return 'ConfigOther';
    if (/ConcurrencyThreadGroup$/.test(t)) return 'ConcurrencyThreadGroup';
    if (/ArrivalsThreadGroup$/.test(t)) return 'ArrivalsThreadGroup';
    if (/UltimateThreadGroup$/.test(t)) return 'UltimateThreadGroup';
    if (/SteppingThreadGroup$/.test(t)) return 'SteppingThreadGroup';
    return t.replace(/^.*\./, '');
  }

  // ---------------------------------------------------------------- JMeter strings → JS expressions

  const IDENT = /^[A-Za-z_$][\w$]*$/;
  function varRef(name) { return IDENT.test(name) ? 'vars.' + name : 'vars[' + JSON.stringify(name) + ']'; }
  function q(s) { return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029') + "'"; }

  // Splits "a${b}c${__P(x,${y})}" into text and ${...} parts, honouring nested braces.
  function splitVars(s) {
    const parts = [];
    let i = 0, buf = '';
    while (i < s.length) {
      if (s[i] === '$' && s[i + 1] === '{') {
        let depth = 0, j = i + 1;
        for (; j < s.length; j++) {
          if (s[j] === '{') depth++;
          else if (s[j] === '}' && --depth === 0) break;
        }
        if (j >= s.length) { buf += s.slice(i); break; }
        if (buf) parts.push({ text: buf });
        buf = '';
        parts.push({ expr: s.slice(i + 2, j) });
        i = j + 1;
      } else buf += s[i++];
    }
    if (buf) parts.push({ text: buf });
    return parts;
  }

  // Splits function arguments on commas, honouring \, escapes and nested ${...}.
  function fnArgs(s) {
    const out = [];
    let buf = '', depth = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '\\' && s[i + 1] === ',') { buf += ','; i++; continue; }
      if (c === '$' && s[i + 1] === '{') { depth++; buf += '${'; i++; continue; }
      if (c === '}' && depth > 0) depth--;
      if (c === ',' && depth === 0) { out.push(buf); buf = ''; continue; }
      buf += c;
    }
    out.push(buf);
    return out;
  }

  class Ctx {
    constructor(opts) {
      this.opts = opts;
      this.warnings = [];
      this.infos = [];
      this.helpers = new Set();
      this.imports = new Set(['http']);
      this.k6Imports = new Set();
      this.usedVars = new Set();
      this.definedVars = new Set();
      this.envVars = new Map();
      this.stats = { requests: 0, checks: 0, extractors: 0, timers: 0, todo: 0 };
    }
    warn(msg) { if (!this.warnings.includes(msg)) this.warnings.push(msg); }
    info(msg) { if (!this.infos.includes(msg)) this.infos.push(msg); }

    // A JS expression for one ${...} body.
    exprFor(body) {
      const b = body.trim();
      if (/^[\w.\-]+$/.test(b) && !b.startsWith('__')) { this.usedVars.add(b); return varRef(b); }
      const m = /^(__\w+)(?:\(([\s\S]*)\))?$/.exec(b);
      if (!m) return this.todoExpr(body, 'unrecognised variable');
      const fn = m[1], args = m[2] !== undefined ? fnArgs(m[2]) : [];
      const a = k => (args[k] !== undefined ? args[k].trim() : '');
      switch (fn) {
        case '__P': case '__property': {
          const name = a(0), dflt = fn === '__P' ? a(1) : a(2);
          if (!name) break;
          this.envVars.set(name, dflt);
          return '(__ENV[' + q(name) + '] || ' + this.js(dflt) + ')';
        }
        case '__env': { const name = a(0); if (!name) break; this.envVars.set(name, a(2)); return '(__ENV[' + q(name) + '] || ' + this.js(a(2)) + ')'; }
        case '__Random': {
          this.helpers.add('randomInt');
          const e = 'String(randomInt(' + this.num(a(0), 0) + ', ' + this.num(a(1), 100) + '))';
          return a(2) ? this.assignExpr(a(2), e) : e;
        }
        case '__RandomString': {
          this.helpers.add('randomString');
          const e = 'randomString(' + this.num(a(0), 8) + (a(1) ? ', ' + this.js(a(1)) : '') + ')';
          return a(2) ? this.assignExpr(a(2), e) : e;
        }
        case '__UUID': return 'crypto.randomUUID()';
        case '__threadNum': return 'String(__VU)';
        case '__counter': return 'String(__ITER + 1)';
        case '__time': {
          const f = a(0);
          if (!f) return 'String(Date.now())';
          if (f === '/1000') return 'String(Math.floor(Date.now() / 1000))';
          if (/^yyyy-MM-dd$/.test(f)) return 'new Date().toISOString().slice(0, 10)';
          if (/^yyyy-MM-dd'T'HH:mm:ss/.test(f)) return 'new Date().toISOString()';
          return this.todoExpr(body, 'date format "' + f + '"');
        }
        case '__urlencode': return 'encodeURIComponent(' + this.js(a(0)) + ')';
        case '__urldecode': return 'decodeURIComponent(' + this.js(a(0)) + ')';
        case '__escapeHtml': return this.js(a(0));
        case '__lowercase': return this.js(a(0)) + '.toLowerCase()';
        case '__uppercase': return this.js(a(0)) + '.toUpperCase()';
        case '__intSum': {
          const parts = args.map(x => x.trim()).filter(Boolean);
          const last = parts.length > 2 && !/^-?\d+$/.test(parts[parts.length - 1]) && !/\$\{/.test(parts[parts.length - 1]) ? parts.pop() : '';
          const e = 'String(' + parts.map(p => this.num(p, 0)).join(' + ') + ')';
          return last ? this.assignExpr(last, e) : e;
        }
        case '__V': return 'vars[' + this.js(a(0)) + ']';
        case '__base64Encode': return 'encoding.b64encode(' + this.js(a(0)) + ')';
        case '__machineName': return "'k6'";
        case '__log': case '__logn': return "''";
        default: break;
      }
      return this.todoExpr(body, fn + ' needs rewriting by hand');
    }

    assignExpr(name, e) {
      this.definedVars.add(name);
      return '(' + varRef(name) + ' = ' + e + ')';
    }

    todoExpr(body, why) {
      this.stats.todo++;
      this.warn('${' + body + '}: ' + why + '. It is left as text in the script, marked TODO.');
      return q('${' + body + '}') + ' /* TODO: ' + why.replace(/\*\//g, '* /') + ' */';
    }

    // A JMeter string (may contain ${...}) as a JS expression.
    js(s) {
      s = s == null ? '' : String(s);
      const parts = splitVars(s);
      if (!parts.length) return "''";
      if (parts.length === 1 && parts[0].text !== undefined) return q(parts[0].text);
      if (parts.length === 1) {
        const e = this.exprFor(parts[0].expr);
        return /^(vars\.|vars\[)/.test(e) ? e : e;
      }
      return '`' + parts.map(p => p.text !== undefined
        ? p.text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
        : '${' + this.exprFor(p.expr) + '}').join('') + '`';
    }

    // A number, or Number(expression) when the value comes from a variable or property.
    num(s, dflt) {
      const t = String(s == null ? '' : s).trim();
      if (t === '') return String(dflt);
      if (/^-?\d+(\.\d+)?$/.test(t)) return String(Number(t));
      return 'Number(' + this.js(t) + ')';
    }
  }

  function isLiteral(expr) { return /^-?\d+(\.\d+)?$/.test(expr); }

  // ---------------------------------------------------------------- code emitter

  class Out {
    constructor() { this.lines = []; this.depth = 0; }
    line(s) { this.lines.push(s === '' ? '' : '  '.repeat(this.depth) + s); }
    open(s) { this.line(s); this.depth++; }
    close(s) { this.depth--; this.line(s); }
    comment(s) { String(s).split('\n').forEach(l => this.line('// ' + l)); }
    text() { return this.lines.join('\n'); }
  }

  // ---------------------------------------------------------------- scope (JMeter applies config, timers and
  // assertions to every sampler under the same parent, including nested controllers)

  function scopeFrom(parent, items) {
    const s = {
      defaults: parent ? parent.defaults.slice() : [],
      headers: parent ? parent.headers.slice() : [],
      timers: parent ? parent.timers.slice() : [],
      assertions: parent ? parent.assertions.slice() : [],
      post: parent ? parent.post.slice() : [],
      pre: parent ? parent.pre.slice() : [],
    };
    for (const it of items) {
      if (!enabled(it.el)) continue;
      const k = kindOf(it.el);
      if (k === 'HttpDefaults') s.defaults.push(it.el);
      else if (k === 'HeaderManager') s.headers.push(it.el);
      else if (/Timer$/.test(k)) s.timers.push(it.el);
      else if (/Assertion$/.test(k)) s.assertions.push(it.el);
      else if (/(Extractor|PostProcessor)$/.test(k)) s.post.push(it.el);
      else if (/PreProcessor$/.test(k)) s.pre.push(it.el);
    }
    return s;
  }

  // ---------------------------------------------------------------- HTTP request

  const DROP_HEADERS = /^(content-length|host|connection|accept-encoding)$/i;

  function httpRequest(ctx, out, el, scope) {
    ctx.stats.requests++;
    const name = el.attrs.testname || 'HTTP Request';
    const get = key => {
      const own = str(el, key);
      if (own.trim() !== '') return own;
      for (let i = scope.defaults.length - 1; i >= 0; i--) { const v = str(scope.defaults[i], key); if (v.trim() !== '') return v; }
      return '';
    };
    let protocol = get('HTTPSampler.protocol').trim();
    let domain = get('HTTPSampler.domain').trim();
    let port = get('HTTPSampler.port').trim();
    let path = str(el, 'HTTPSampler.path').trim();
    const defaultPath = get('HTTPSampler.path').trim();
    if (!path && defaultPath) path = defaultPath;
    const method = (str(el, 'HTTPSampler.method') || 'GET').trim().toUpperCase();

    // A full URL in the path field wins over domain/port/protocol.
    const full = /^(https?):\/\/([^/:?#]+)(?::([^/?#]*))?([^#]*)$/i.exec(path);
    if (full) { protocol = full[1]; domain = full[2]; port = full[3] || ''; path = full[4] || '/'; }
    if (!protocol) protocol = port === '443' ? 'https' : 'http';
    protocol = protocol.toLowerCase();
    if ((protocol === 'https' && port === '443') || (protocol === 'http' && port === '80')) port = '';
    if (path && !path.startsWith('/') && !path.startsWith('${')) path = '/' + path;
    if (!domain) ctx.warn('"' + name + '" has no server name (and no HTTP Request Defaults): set BASE_URL when you run it.');

    const origin = domain ? protocol + '://' + domain + (port ? ':' + port : '') : '';

    // Parameters: query string for GET-like requests, form body otherwise. "Body data" = raw body.
    const args = collection(elemProp(el, 'HTTPsampler.Arguments'), 'Arguments.arguments').filter(a => a.name === 'elementProp');
    const raw = bool(el, 'HTTPSampler.postBodyRaw', false);
    let bodyExpr = null, queryParts = [];
    if (raw) {
      bodyExpr = ctx.js(args.map(a => str(a, 'Argument.value')).join(''));
    } else if (args.length) {
      const pairs = args.map(a => ({ name: str(a, 'Argument.name'), value: str(a, 'Argument.value'), encode: bool(a, 'HTTPArgument.always_encode', false) }))
        .filter(p => p.name !== '' || p.value !== '');
      if (/^(GET|HEAD|DELETE|OPTIONS)$/.test(method) || bool(el, 'HTTPSampler.DO_MULTIPART_POST', false) === 'never') {
        queryParts = pairs;
      } else {
        bodyExpr = '{ ' + pairs.map(p => (IDENT.test(p.name) ? p.name : q(p.name)) + ': ' + ctx.js(p.value)).join(', ') + ' }';
      }
    }
    if (bool(el, 'HTTPSampler.DO_MULTIPART_POST', false)) ctx.warn('"' + name + '" is a multipart upload: k6 needs http.file(open(...)) for files, check the body by hand.');
    const files = collection(elemProp(el, 'HTTPsampler.Files'), 'HTTPFileArgs.files');
    if (files.length) { ctx.warn('"' + name + '" uploads files: add them with open(path, "b") and http.file() (see k6 docs, "Multipart requests").'); ctx.stats.todo++; }
    if (bool(el, 'HTTPSampler.image_parser', false)) ctx.info('"Retrieve all embedded resources" is on in JMeter. k6 only requests what the script names, so page assets (images, CSS, JS) are not downloaded.');

    // URL expression
    const sharedOrigin = ctx.baseOrigin && origin === ctx.baseOrigin;
    let pathExpr = ctx.js(path || '/');
    let url;
    if (sharedOrigin && ctx.opts.baseUrl) url = joinExpr('BASE_URL', pathExpr);
    else url = origin ? joinExpr(ctx.js(origin), pathExpr) : joinExpr('BASE_URL', pathExpr);
    if (!origin) ctx.needBase = true;
    if (queryParts.length) {
      queryParts.forEach((p, i) => {
        const name = p.encode ? encodeURIComponent(p.name) : p.name;
        url = joinExpr(url, q((i === 0 && !path.includes('?') ? '?' : '&') + name + '='));
        const literal = !/\$\{/.test(p.value);
        if (p.encode && literal) url = joinExpr(url, q(encodeURIComponent(p.value)));
        else url = joinExpr(url, p.encode ? 'encodeURIComponent(' + ctx.js(p.value) + ')' : ctx.js(p.value));
      });
    }

    // Headers in scope: outer managers first, inner ones override (case-insensitive), as in JMeter.
    const entriesOf = hm => collection(hm, 'HeaderManager.headers')
      .map(h => [str(h, 'Header.name').trim(), str(h, 'Header.value')])
      .filter(([hn]) => hn && !DROP_HEADERS.test(hn));
    const headers = new Map();
    const lists = scope.headers.map(hm => ({ hm, entries: entriesOf(hm) })).filter(x => x.entries.length);
    for (const x of lists) for (const [hn, hv] of x.entries) headers.set(hn.toLowerCase(), [hn, hv]);
    // Managers above the sampler with fixed values become one shared constant each (shorter script).
    // Values with ${variables} stay inline: they can change during the test, e.g. an extracted token.
    const names = lists.map(x => x.entries.map(e => e[0].toLowerCase()));
    const overlap = names.some((n, i) => n.some(h => names.some((m, j) => j !== i && m.includes(h))));
    let headersExpr = null;
    if (!overlap && lists.length) {
      const parts = lists.map(x => {
        const own = (scope.samplerHeaders || []).includes(x.hm);
        const fixed = x.entries.every(([, v]) => !/\$\{/.test(v));
        if (!own && fixed) return '...' + headerConst(ctx, x.hm, x.entries);
        return x.entries.map(([k, v]) => (IDENT.test(k) ? k : q(k)) + ': ' + ctx.js(v)).join(', ');
      });
      headersExpr = parts.length === 1 && parts[0].startsWith('...') ? parts[0].slice(3) : '{ ' + parts.join(', ') + ' }';
    }
    if (bodyExpr && raw && ![...headers.keys()].includes('content-type')) {
      const b = args.map(a => str(a, 'Argument.value')).join('').trim();
      if (/^[[{]/.test(b)) ctx.info('Some requests send a JSON body without a Content-Type header, as in the JMeter plan. Add \'Content-Type\': \'application/json\' if the API needs it.');
    }

    const params = [];
    if (headersExpr) params.push('headers: ' + headersExpr);
    else if (headers.size) params.push('headers: { ' + [...headers.values()].map(([k, v]) => (IDENT.test(k) ? k : q(k)) + ': ' + ctx.js(v)).join(', ') + ' }');
    params.push('tags: { name: ' + q(name) + ' }');
    if (!bool(el, 'HTTPSampler.follow_redirects', true) && !bool(el, 'HTTPSampler.auto_redirects', false)) params.push('redirects: 0');
    const timeout = get('HTTPSampler.response_timeout').trim();
    if (timeout && /^\d+$/.test(timeout)) params.push("timeout: '" + Math.max(1, Math.round(Number(timeout))) + "ms'");

    // Timers run before the sampler in JMeter.
    emitTimers(ctx, out, scope.timers);
    emitPre(ctx, out, scope.pre, name);

    const p = '{ ' + params.join(', ') + ' }';
    let call;
    switch (method) {
      case 'GET': call = 'http.get(' + url + ', ' + p + ')'; break;
      case 'HEAD': call = 'http.head(' + url + ', ' + p + ')'; break;
      case 'POST': call = 'http.post(' + url + ', ' + (bodyExpr || 'null') + ', ' + p + ')'; break;
      case 'PUT': call = 'http.put(' + url + ', ' + (bodyExpr || 'null') + ', ' + p + ')'; break;
      case 'PATCH': call = 'http.patch(' + url + ', ' + (bodyExpr || 'null') + ', ' + p + ')'; break;
      case 'DELETE': call = 'http.del(' + url + ', ' + (bodyExpr || 'null') + ', ' + p + ')'; break;
      default: call = 'http.request(' + q(method) + ', ' + url + ', ' + (bodyExpr || 'null') + ', ' + p + ')';
    }
    out.line('res = ' + call + ';');

    emitAssertions(ctx, out, scope.assertions, name);
    emitPost(ctx, out, scope.post, name);
  }

  // The inside of a template literal for an expression made by q() or ctx.js(), or null.
  function templateBody(e) {
    if (e === 'BASE_URL') return '${BASE_URL}';
    if (/^'(?:[^'\\]|\\.)*'$/.test(e)) {
      return e.slice(1, -1).replace(/\\'/g, "'").replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
    }
    if (/^`[^`]*`$/.test(e)) return e.slice(1, -1);
    return '${' + e + '}';
  }
  function joinExpr(a, b) {
    const body = templateBody(a) + templateBody(b);
    return /\$\{|`|\\/.test(body) ? '`' + body + '`' : q(body);
  }

  // A module-level constant for a Header Manager with fixed values: headers, headers2, or a name from its label.
  function headerConst(ctx, hm, entries) {
    ctx.headerConsts = ctx.headerConsts || [];
    const found = ctx.headerConsts.find(c => c.hm === hm);
    if (found) return found.name;
    const label = (hm.attrs.testname || '').trim();
    let base = 'headers';
    if (label && !/^HTTP Header Manager$/i.test(label)) {
      const words = label.replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 4);
      const camel = words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join('');
      if (camel && /^[A-Za-z]/.test(camel)) base = /headers?$/i.test(camel) ? camel.replace(/header$/i, 'Headers') : camel + 'Headers';
    }
    let name = base, n = 2;
    const taken = new Set(['vars', 'res', 'http', 'check', 'group', 'sleep', 'exec', 'options', 'BASE_URL', 'encoding', 'parseHTML', 'SharedArray']);
    while (taken.has(name) || ctx.headerConsts.some(c => c.name === name)) name = base + n++;
    ctx.headerConsts.push({ hm, name, entries, label });
    return name;
  }

  // ---------------------------------------------------------------- timers

  function emitTimers(ctx, out, timers) {
    const parts = [];
    for (const t of timers) {
      const k = kindOf(t);
      const delay = str(t, 'ConstantTimer.delay');
      const range = str(t, 'RandomTimer.range');
      if (k === 'ConstantTimer') parts.push(ctx.num(delay, 300));
      else if (k === 'UniformRandomTimer') parts.push(ctx.num(delay, 0) + ' + Math.random() * ' + ctx.num(range, 100));
      else if (k === 'GaussianRandomTimer') { ctx.helpers.add('gaussian'); parts.push(ctx.num(delay, 300) + ' + gaussian() * ' + ctx.num(range, 100)); }
      else if (k === 'PoissonRandomTimer') parts.push(ctx.num(delay, 300) + ' + Math.random() * ' + ctx.num(range, 100));
      else if (k === 'ConstantThroughputTimer' || k === 'PreciseThroughputTimer') {
        ctx.warn('A ' + k + ' sets a target throughput. In k6, use the "Arrival rate" load model (constant-arrival-rate executor) instead of sleeps.');
        continue;
      } else if (k === 'SyncTimer') { ctx.warn('Synchronizing Timer (rendezvous) has no direct k6 equivalent. It is skipped.'); continue; }
      else if (/JSR223Timer|BeanShellTimer/.test(k)) { ctx.warn('A scripted timer was skipped: add a sleep() by hand.'); ctx.stats.todo++; continue; }
      else continue;
    }
    if (!parts.length) return;
    ctx.stats.timers++;
    ctx.k6Imports.add('sleep');
    const allLiteral = parts.every(isLiteral);
    if (allLiteral) {
      const ms = parts.reduce((s, p) => s + Number(p), 0);
      out.line('sleep(' + +(ms / 1000).toFixed(3) + ');');
    } else {
      out.line('sleep(Math.max(0, ' + parts.join(' + ') + ') / 1000);');
    }
  }

  function emitPre(ctx, out, pre, name) {
    for (const p of pre) {
      const k = kindOf(p);
      if (k === 'UserParameters') { ctx.warn('User Parameters pre-processor on "' + name + '" was skipped: use a CSV file (SharedArray) instead.'); continue; }
      scripted(ctx, out, p, 'pre-processor');
    }
  }

  function scripted(ctx, out, el, what) {
    const k = kindOf(el);
    const lang = str(el, 'scriptLanguage') || (/BeanShell/.test(k) ? 'beanshell' : '');
    const script = str(el, 'script') || str(el, 'BeanShellSampler.query') || str(el, 'JSR223Sampler.script');
    ctx.stats.todo++;
    ctx.warn('Script ' + what + ' "' + (el.attrs.testname || k) + '"' + (lang ? ' (' + lang + ')' : '') + ' must be rewritten in JavaScript. Its code is copied into the script as a comment.');
    out.line('// TODO: ' + k + ' "' + (el.attrs.testname || '') + '"' + (lang ? ' (' + lang + ')' : '') + ': rewrite in JavaScript.');
    if (script.trim()) script.trim().split('\n').slice(0, 40).forEach(l => out.line('//   ' + l.replace(/\s+$/, '')));
  }

  // ---------------------------------------------------------------- assertions → check()

  function emitAssertions(ctx, out, assertions, name) {
    const checks = [];
    let statusHandled = false;
    for (const a of assertions) {
      const k = kindOf(a);
      const label = (a.attrs.testname || '').trim();
      if (k === 'ResponseAssertion') {
        const field = str(a, 'Assertion.test_field') || 'Assertion.response_data';
        const type = Number(str(a, 'Assertion.test_type')) || 16;
        const strings = collection(a, 'Asserion.test_strings').concat(collection(a, 'Assertion.test_strings')).map(s => s.text);
        const assume = bool(a, 'Assertion.assume_success', false);
        if (field === 'Assertion.response_code' || assume) statusHandled = true;
        const subj = {
          'Assertion.response_data': 'String(r.body)', 'Assertion.response_code': 'String(r.status)',
          'Assertion.response_message': 'r.status_text', 'Assertion.response_headers': "Object.entries(r.headers).map(([k, v]) => k + ': ' + v).join('\\n')",
          'Assertion.url': 'r.url', 'Assertion.response_data_as_document': 'String(r.body)',
        }[field];
        if (!subj) { ctx.warn('Response Assertion on "' + field.replace('Assertion.', '') + '" was skipped (no k6 equivalent).'); continue; }
        if (!strings.length) continue;
        const NOT = type & 4, OR = type & 32;
        const tests = strings.map(s => {
          let t;
          if (type & 8) t = subj + ' === ' + ctx.js(s);
          else if (type & 16) t = subj + '.includes(' + ctx.js(s) + ')';
          else if (type & 1) t = regexTest(ctx, s, subj, true);
          else t = regexTest(ctx, s, subj, false);  // 2 = contains (regex)
          return NOT ? '!(' + t + ')' : t;
        });
        const what = field.replace('Assertion.', '').replace('response_', '').replace('_', ' ');
        const verb = NOT ? 'not ' : '';
        const kind = type & 8 ? 'equals' : type & 16 ? 'contains' : type & 1 ? 'matches' : 'contains';
        const desc = label && !/^Response Assertion$/i.test(label) ? label
          : what + ' ' + verb + kind + ' ' + (strings.length === 1 ? (strings[0].length > 40 ? strings[0].slice(0, 39).replace(/\s+\S*$/, '') + '…' : strings[0]) : strings.length + ' values');
        checks.push([desc, tests.join(OR ? ' || ' : ' && ')]);
      } else if (k === 'DurationAssertion') {
        const ms = ctx.num(str(a, 'DurationAssertion.duration'), 1000);
        checks.push([label && !/^Duration Assertion$/i.test(label) ? label : 'responds within ' + ms + ' ms', 'r.timings.duration < ' + ms]);
      } else if (k === 'SizeAssertion') {
        const size = ctx.num(str(a, 'SizeAssertion.size'), 0);
        const op = { 1: '===', 2: '!==', 3: '>', 4: '<', 5: '>=', 6: '<=' }[str(a, 'SizeAssertion.operator')] || '===';
        checks.push([label && !/^Size Assertion$/i.test(label) ? label : 'body size ' + op + ' ' + size, 'String(r.body).length ' + op + ' ' + size]);
      } else if (k === 'JSONPathAssertion') {
        ctx.helpers.add('jsonPath');
        const path = str(a, 'JSON_PATH');
        const expectValue = bool(a, 'JSONVALIDATION', false);
        const expected = str(a, 'EXPECTED_VALUE');
        const isNull = bool(a, 'EXPECT_NULL', false);
        const invert = bool(a, 'INVERT', false);
        const isRegex = bool(a, 'ISREGEX', true);
        const vals = 'jsonPath(r, ' + ctx.js(path) + ')';
        let t;
        if (isNull) t = vals + '.some(v => v === null)';
        else if (!expectValue) t = vals + '.length > 0';
        else if (isRegex) t = vals + '.some(v => ' + regexTest(ctx, expected, 'String(v)', true) + ')';
        else t = vals + '.some(v => String(v) === ' + ctx.js(expected) + ')';
        if (invert) t = '!(' + t + ')';
        checks.push([label && !/^JSON Assertion$/i.test(label) ? label : path + (expectValue ? ' is ' + expected : ' exists'), t]);
      } else if (/XPath|XMLSchema|XMLAssertion|HTMLAssertion|MD5Hex|SMIME|Compare/.test(k)) {
        ctx.warn(k + ' on "' + name + '" has no direct k6 equivalent and was skipped.');
        ctx.stats.todo++;
      } else if (/JSR223Assertion|BeanShellAssertion/.test(k)) {
        scripted(ctx, out, a, 'assertion');
      }
    }
    if (ctx.opts.statusCheck && !statusHandled) checks.unshift(['status is ' + 'not an error', 'r.status >= 200 && r.status < 400']);
    if (!checks.length) return;
    ctx.k6Imports.add('check');
    ctx.stats.checks += checks.length;
    const seen = new Map();
    out.open('check(res, {');
    for (const [desc, t] of checks) {
      let key = name + ': ' + desc.replace(/\s+/g, ' ');
      const c = seen.get(key) || 0; seen.set(key, c + 1);
      if (c) key += ' (' + (c + 1) + ')';
      out.line(q(key) + ': (r) => ' + t + ',');
    }
    out.close('});');
  }

  // Java regex → JS RegExp. Leading (?i)/(?s)/(?m) become flags; the pattern is checked here so a bad one
  // doesn't crash the k6 script.
  function toRegex(ctx, pattern, full) {
    let p = pattern, flags = '';
    const m = /^\(\?([ism]+)\)/.exec(p);
    if (m) { flags = [...new Set(m[1].split(''))].join(''); p = p.slice(m[0].length); }
    if (/\$\{/.test(p)) return { dynamic: true, expr: 'new RegExp(' + (full ? "'^(?:' + " + ctx.js(p) + " + ')$'" : ctx.js(p)) + (flags ? ', ' + q(flags) : '') + ')' };
    const src = full ? '^(?:' + p + ')$' : p;
    try { new RegExp(src, flags); } catch (e) {
      ctx.warn('Regular expression "' + pattern.slice(0, 60) + '" uses Java-only syntax: check it by hand (marked TODO).');
      ctx.stats.todo++;
      return { bad: true, expr: 'new RegExp(' + q(src.replace(/\(\?<([a-zA-Z])/g, '(?<$1')) + ', ' + q(flags) + ') /* TODO: check this Java regex */' };
    }
    return { expr: '/' + src.replace(/(\\.)|\//g, (all, esc) => esc || '\\/').replace(/\n/g, '\\n') + '/' + flags };
  }
  function regexTest(ctx, pattern, subj, full) {
    const r = toRegex(ctx, pattern, full);
    if (r.bad) return 'true /* TODO: Java regex ' + q(pattern).slice(0, 80) + ' */';
    return r.expr + '.test(' + subj + ')';
  }

  // ---------------------------------------------------------------- extractors → vars

  function emitPost(ctx, out, post, name) {
    for (const p of post) {
      const k = kindOf(p);
      if (k === 'RegexExtractor') {
        ctx.helpers.add('regexExtract'); ctx.stats.extractors++;
        const ref = str(p, 'RegexExtractor.refname').trim();
        if (!ref) continue;
        ctx.definedVars.add(ref);
        const where = str(p, 'RegexExtractor.useHeaders') || 'false';
        const subj = { 'true': "Object.entries(res.headers).map(([k, v]) => k + ': ' + v).join('\\n')", URL: 'res.url', code: 'String(res.status)', message: 'res.status_text' }[where] || 'String(res.body)';
        const r = toRegex(ctx, str(p, 'RegexExtractor.regex'), false);
        out.line('regexExtract(' + q(ref) + ', ' + subj + ', ' + r.expr + ', ' + ctx.js(str(p, 'RegexExtractor.template') || '$1$') + ', ' +
          ctx.num(str(p, 'RegexExtractor.match_number'), 1) + ', ' + ctx.js(str(p, 'RegexExtractor.default')) + ');');
      } else if (k === 'JSONPostProcessor') {
        ctx.helpers.add('jsonExtract'); ctx.helpers.add('jsonPath'); ctx.stats.extractors++;
        const names = str(p, 'JSONPostProcessor.referenceNames').split(';');
        const paths = str(p, 'JSONPostProcessor.jsonPathExprs').split(';');
        const matches = str(p, 'JSONPostProcessor.match_numbers').split(';');
        const defaults = str(p, 'JSONPostProcessor.defaultValues').split(';');
        names.forEach((n, i) => {
          n = n.trim();
          if (!n) return;
          ctx.definedVars.add(n);
          out.line('jsonExtract(' + q(n) + ', res, ' + ctx.js((paths[i] || '$').trim()) + ', ' + ctx.num((matches[i] || '').trim(), 0) + ', ' + ctx.js(defaults[i] !== undefined ? defaults[i] : '') + ');');
        });
      } else if (k === 'BoundaryExtractor') {
        ctx.helpers.add('boundaryExtract'); ctx.stats.extractors++;
        const ref = str(p, 'BoundaryExtractor.refname').trim();
        if (!ref) continue;
        ctx.definedVars.add(ref);
        const where = str(p, 'BoundaryExtractor.useHeaders') || 'false';
        const subj = { 'true': "Object.entries(res.headers).map(([k, v]) => k + ': ' + v).join('\\n')", URL: 'res.url', code: 'String(res.status)', message: 'res.status_text' }[where] || 'String(res.body)';
        out.line('boundaryExtract(' + q(ref) + ', ' + subj + ', ' + ctx.js(str(p, 'BoundaryExtractor.lboundary')) + ', ' + ctx.js(str(p, 'BoundaryExtractor.rboundary')) + ', ' +
          ctx.num(str(p, 'BoundaryExtractor.match_number'), 1) + ', ' + ctx.js(str(p, 'BoundaryExtractor.default')) + ');');
      } else if (k === 'HtmlExtractor') {
        ctx.helpers.add('cssExtract'); ctx.k6HtmlImport = true; ctx.stats.extractors++;
        const ref = str(p, 'HtmlExtractor.refname').trim();
        if (!ref) continue;
        ctx.definedVars.add(ref);
        out.line('cssExtract(' + q(ref) + ', res, ' + ctx.js(str(p, 'HtmlExtractor.expr')) + ', ' + ctx.js(str(p, 'HtmlExtractor.attribute')) + ', ' +
          ctx.num(str(p, 'HtmlExtractor.match_number'), 1) + ', ' + ctx.js(str(p, 'HtmlExtractor.default')) + ');');
      } else if (/XPath/.test(k)) {
        ctx.warn('XPath Extractor on "' + name + '" was skipped: use a CSS extractor (parseHTML) or a regex instead.');
        ctx.stats.todo++;
        out.line('// TODO: XPath Extractor "' + (p.attrs.testname || '') + '" (' + str(p, 'XPathExtractor.xpathQuery').slice(0, 80) + ')');
      } else if (/JSR223|BeanShell/.test(k)) {
        scripted(ctx, out, p, 'post-processor');
      } else if (k === 'DebugPostProcessor') {
        continue;
      } else if (k === 'ResultAction') {
        ctx.info('Result Status Action Handler: in k6 a failed request doesn\'t stop the VU. Use thresholds with abortOnFail to stop a test early.');
      }
    }
  }

  // ---------------------------------------------------------------- controllers and flow

  function emitChildren(ctx, out, items, parentScope, nested) {
    const scope = scopeFrom(parentScope, items);
    // CSV Data Set, Random Variable and Counter inside a controller: a new value each time the controller runs.
    if (nested !== false) initData(ctx, items, scope).forEach(l => out.line(l));
    for (const it of items) emitItem(ctx, out, it, scope);
  }

  function emitItem(ctx, out, it, scope) {
    const el = it.el;
    if (!enabled(el)) return;
    const k = kindOf(el);
    const name = el.attrs.testname || k;
    if (k === 'HTTPSamplerProxy' || k === 'HTTPSampler' || k === 'HTTPSampler2') {
      const own = scopeFrom(scope, it.kids);
      // Header managers directly under the sampler apply only to it (scopeFrom added them).
      own.samplerHeaders = it.kids.filter(c => enabled(c.el) && kindOf(c.el) === 'HeaderManager').map(c => c.el);
      httpRequest(ctx, out, el, own);
      return;
    }
    if (k === 'TransactionController') {
      ctx.k6Imports.add('group');
      out.open('group(' + q(name) + ', () => {');
      emitChildren(ctx, out, it.kids, scope);
      out.close('});');
      return;
    }
    if (k === 'GenericController') {
      out.comment(name);
      emitChildren(ctx, out, it.kids, scope);
      return;
    }
    if (k === 'LoopController') {
      const loops = str(el, 'LoopController.loops');
      if (bool(el, 'LoopController.continue_forever', false) && (loops === '-1' || loops === '')) {
        ctx.warn('Loop Controller "' + name + '" loops forever. It runs once per iteration in k6 (the scenario repeats it).');
        emitChildren(ctx, out, it.kids, scope);
        return;
      }
      const n = ctx.num(loops, 1);
      const v = 'i' + (out.depth);
      out.open('for (let ' + v + ' = 0; ' + v + ' < ' + n + '; ' + v + '++) {');
      emitChildren(ctx, out, it.kids, scope);
      out.close('}');
      return;
    }
    if (k === 'IfController') {
      const cond = condition(ctx, str(el, 'IfController.condition'), name);
      out.open('if (' + cond + ') {');
      emitChildren(ctx, out, it.kids, scope);
      out.close('}');
      return;
    }
    if (k === 'WhileController') {
      const c = str(el, 'WhileController.condition');
      ctx.warn('While Controller "' + name + '" runs its children once (condition: ' + (c || 'until a sampler fails') + '). Add a loop by hand if it matters.');
      ctx.stats.todo++;
      out.comment('TODO: While Controller "' + name + '"' + (c ? ' (condition: ' + c + ')' : '') + ': runs once here.');
      emitChildren(ctx, out, it.kids, scope);
      return;
    }
    if (k === 'OnceOnlyController') {
      out.open('if (__ITER === 0) { // Once Only Controller: ' + name);
      emitChildren(ctx, out, it.kids, scope);
      out.close('}');
      return;
    }
    if (k === 'RandomController' || k === 'RandomOrderController' || k === 'InterleaveControl') {
      const branches = it.kids.filter(c => enabled(c.el) && isRunnable(c.el));
      const childScope = scopeFrom(scope, it.kids);
      if (k === 'RandomOrderController') {
        ctx.info('Random Order Controller "' + name + '" runs its children in the order written. Shuffle them by hand if order matters.');
        emitChildren(ctx, out, it.kids, scope);
        return;
      }
      if (!branches.length) return;
      const pickExpr = k === 'RandomController' ? 'Math.floor(Math.random() * ' + branches.length + ')' : '__ITER % ' + branches.length;
      out.open('switch (' + pickExpr + ') { // ' + (k === 'RandomController' ? 'Random' : 'Interleave') + ' Controller: ' + name);
      branches.forEach((b, i) => {
        out.open('case ' + i + ': {');
        emitItem(ctx, out, b, childScope);
        out.line('break;');
        out.close('}');
      });
      out.close('}');
      return;
    }
    if (k === 'ThroughputController') {
      const style = str(el, 'ThroughputController.style');
      if (style === '1') {
        const pct = ctx.num(str(elemProp(el, 'ThroughputController.percentThroughput') || el, 'FloatProperty.value') || str(el, 'ThroughputController.percentThroughput'), 100);
        out.open('if (Math.random() * 100 < ' + pct + ') { // Throughput Controller: ' + name);
      } else {
        const max = ctx.num(str(elemProp(el, 'ThroughputController.maxThroughput') || el, 'IntegerProperty.value') || str(el, 'ThroughputController.maxThroughput'), 1);
        ctx.info('Throughput Controller "' + name + '" (total executions) counts per virtual user in k6, not across all threads.');
        out.open('if (__ITER < ' + max + ') { // Throughput Controller: ' + name);
      }
      emitChildren(ctx, out, it.kids, scope);
      out.close('}');
      return;
    }
    if (k === 'ForeachController') {
      const input = str(el, 'ForeachController.inputVal');
      const ret = str(el, 'ForeachController.returnVal');
      const sep = bool(el, 'ForeachController.useSeparator', true) ? '_' : '';
      const start = Number(str(el, 'ForeachController.startIndex')) || 0;
      ctx.definedVars.add(ret);
      const v = 'n' + out.depth;
      out.open('for (let ' + v + ' = ' + (start + 1) + '; vars[' + q(input + sep) + ' + ' + v + '] !== undefined; ' + v + '++) { // ForEach Controller: ' + name);
      out.line(varRef(ret) + ' = vars[' + q(input + sep) + ' + ' + v + '];');
      emitChildren(ctx, out, it.kids, scope);
      out.close('}');
      return;
    }
    if (k === 'RunTime') {
      ctx.warn('Runtime Controller "' + name + '" runs its children once here. Use scenario durations in k6 instead.');
      emitChildren(ctx, out, it.kids, scope);
      return;
    }
    if (k === 'CriticalSectionController' || k === 'SwitchController') {
      if (k === 'SwitchController') { ctx.warn('Switch Controller "' + name + '" runs all its children here. Rewrite as a JavaScript switch.'); ctx.stats.todo++; }
      emitChildren(ctx, out, it.kids, scope);
      return;
    }
    if (k === 'ModuleController') {
      const path = collection(el, 'ModuleController.node_path').map(c => c.text);
      const target = findModule(ctx, path);
      if (target && !ctx.moduleStack.includes(target)) {
        out.comment('Module Controller "' + name + '" → ' + (target.el.attrs.testname || 'fragment'));
        ctx.moduleStack.push(target);
        const tk = kindOf(target.el);
        if (tk === 'TestFragmentController' || tk === 'GenericController') emitChildren(ctx, out, target.kids, scope);
        else emitItem(ctx, out, { el: Object.assign({}, target.el, { attrs: Object.assign({}, target.el.attrs, { enabled: 'true' }) }), kids: target.kids }, scope);
        ctx.moduleStack.pop();
        return;
      }
      ctx.warn('Module Controller "' + name + '" points to ' + (target ? 'itself (a loop)' : 'a part of the plan that wasn\'t found') + '. Copy those requests in by hand.');
      ctx.stats.todo++;
      out.comment('TODO: Module Controller "' + name + '" (' + path.slice(1).join(' > ') + ')');
      return;
    }
    if (k === 'TestFragmentController') { emitChildren(ctx, out, it.kids, scope); return; }
    if (k === 'IncludeController') {
      ctx.warn(k + ' "' + name + '" includes another .jmx file. Convert that file too and copy its requests in.');
      ctx.stats.todo++;
      out.comment('TODO: ' + k + ' "' + name + '"');
      return;
    }
    if (k === 'TestAction') {
      const action = str(el, 'ActionProcessor.action');
      const dur = str(el, 'ActionProcessor.duration');
      if (action === '1' || action === '') {  // pause
        if (dur && dur.trim() !== '0') { ctx.k6Imports.add('sleep'); out.line('sleep(' + (isLiteral(ctx.num(dur, 0)) ? +(Number(dur) / 1000).toFixed(3) : ctx.num(dur, 0) + ' / 1000') + '); // Flow Control Action: ' + name); }
      } else if (action === '5' || action === '0' || action === '2') {
        out.line('return; // Flow Control Action "' + name + '": stop / next iteration');
      }
      emitTimers(ctx, out, scopeFrom(scope, it.kids).timers);
      return;
    }
    if (/JSR223Sampler|BeanShellSampler/.test(k)) { scripted(ctx, out, el, 'sampler'); return; }
    if (k === 'DebugSampler') return;
    if (/Sampler$|SamplerProxy$/.test(k) || /JDBC|FTP|LDAP|SMTP|TCP|JMS|Mongo|SoapSampler|AjpSampler|AccessLog|MailReader|SystemSampler|BoltSampler/.test(k)) {
      ctx.warn(k + ' "' + name + '" isn\'t HTTP, so it can\'t be converted. k6 has extensions for some protocols (gRPC, WebSockets, SQL via xk6).');
      ctx.stats.todo++;
      out.comment('TODO: ' + k + ' "' + name + '" (not HTTP)');
      return;
    }
    if (/Controller$/.test(k)) {
      ctx.info(k + ' "' + name + '" is treated as a plain group of steps.');
      emitChildren(ctx, out, it.kids, scope);
      return;
    }
    // Config, timers, assertions, listeners: handled by scope or ignored here.
    if (/(ResultCollector|Visualizer|BackendListener|Summariser|Listener|Reporter)$/.test(k)) { ctx.listeners = true; return; }
    if (k === 'CookieManager' || k === 'CacheManager' || k === 'DNSCacheManager' || k === 'AuthManager' || k === 'KeystoreConfig' || k === 'ConfigOther') {
      configNote(ctx, el, k);
      return;
    }
  }

  // ModuleController.node_path is the list of names from the tree root, e.g. ["Test Plan", "My plan", "Login fragment"].
  function findModule(ctx, path) {
    const descend = (items, names) => {
      let cur = null, level = items;
      for (const nm of names) {
        cur = level.find(it => (it.el.attrs.testname || '') === nm);
        if (!cur) return null;
        level = cur.kids;
      }
      return cur;
    };
    for (let start = 0; start < Math.min(3, path.length); start++) {
      const names = path.slice(start);
      if (!names.length) break;
      if (names[0] === ctx.planName) { const r = descend(ctx.planItems, names.slice(1)); if (r) return r; }
      const r = descend(ctx.planItems, names);
      if (r) return r;
    }
    return null;
  }

  function isRunnable(el) {
    const k = kindOf(el);
    return !/^(HttpDefaults|HeaderManager|CookieManager|CacheManager|DNSCacheManager|AuthManager|CSVDataSet|Arguments|RandomVariableConfig|CounterConfig|ConfigOther)$/.test(k)
      && !/(Timer|Assertion|Extractor|PostProcessor|PreProcessor|ResultCollector|Listener|Visualizer)$/.test(k);
  }

  function configNote(ctx, el, k) {
    if (k === 'CookieManager') {
      ctx.cookieManager = true;
      if (!bool(el, 'CookieManager.clearEachIteration', false)) ctx.keepCookies = true;
    } else if (k === 'CacheManager') ctx.info('HTTP Cache Manager: k6 doesn\'t cache responses, so every request goes to the server (a little more load than JMeter with a cache).');
    else if (k === 'DNSCacheManager') ctx.info('DNS Cache Manager: k6 caches DNS per VU by default. Use the "dns" option to change it.');
    else if (k === 'AuthManager') {
      const auths = collection(el, 'AuthManager.auth_list');
      if (auths.length) { ctx.warn('HTTP Authorization Manager: add credentials to the URL (https://user:pass@host) or an Authorization header by hand.'); ctx.stats.todo++; }
    } else if (k === 'KeystoreConfig') ctx.warn('Keystore Configuration (client certificates): use the tlsAuth option in k6.');
  }

  // "${__jexl3("${status}" == "ok")}" → String(vars.status) === "ok"
  function condition(ctx, raw, name) {
    let c = raw.trim();
    const wrap = /^\$\{__(jexl3|groovy|javaScript)\(([\s\S]*)\)\}$/.exec(c);
    if (wrap) c = fnArgs(wrap[2])[0].trim();
    const cmp = /^"?\$\{([\w.\-]+)\}"?\s*(==|!=|===|!==)\s*"([^"]*)"$/.exec(c) || /^"([^"]*)"\s*(==|!=|===|!==)\s*"?\$\{([\w.\-]+)\}"?$/.exec(c);
    if (cmp) {
      const varName = /^"/.test(c) && !/^"\$\{/.test(c) ? cmp[3] : cmp[1];
      const value = /^"/.test(c) && !/^"\$\{/.test(c) ? cmp[1] : cmp[3];
      ctx.usedVars.add(varName);
      return 'String(' + varRef(varName) + ') ' + (cmp[2].startsWith('!') ? '!==' : '===') + ' ' + q(value);
    }
    if (/^\$\{JMeterThread\.last_sample_ok\}$/.test(c)) return 'res && res.status < 400';
    const g = groovyToJs(ctx, c);
    if (g) return g + ' /* JMeter: ' + raw.replace(/\*\//g, '* /').replace(/\s+/g, ' ').slice(0, 120) + ' */';
    if (/^(true|false)$/.test(c)) return c;
    const bare = /^\$\{([\w.\-]+)\}$/.exec(c);
    if (bare) { ctx.usedVars.add(bare[1]); return 'String(' + varRef(bare[1]) + ') === \'true\''; }
    ctx.warn('If Controller "' + name + '" has a condition to rewrite by hand: ' + raw.slice(0, 120));
    ctx.stats.todo++;
    return 'true /* TODO: ' + raw.replace(/\*\//g, '* /').slice(0, 160) + ' */';
  }

  // Groovy/JEXL one-liners → JavaScript. Returns null when unsure, so the caller marks it TODO.
  function groovyToJs(ctx, c) {
    // JMeter fills ${...} in first, also inside "quoted strings".
    let outStr = '', i = 0;
    while (i < c.length) {
      const ch = c[i];
      if (ch === '"' || ch === "'") {
        let j = i + 1, buf = '';
        while (j < c.length && c[j] !== ch) { if (c[j] === '\\' && j + 1 < c.length) { buf += c[j + 1]; j += 2; continue; } buf += c[j++]; }
        if (j >= c.length) return null;
        outStr += '(' + ctx.js(buf) + ')';
        i = j + 1;
      } else if (ch === '$' && c[i + 1] === '{') {
        const part = splitVars(c.slice(i))[0];
        if (!part || part.expr === undefined) return null;
        outStr += '(' + ctx.exprFor(part.expr) + ')';
        i += part.expr.length + 3;
      } else { outStr += ch; i++; }
    }
    let e = outStr;
    e = e.replace(/\bvars\.get\(\s*(\([^()]*\)|[^()]*?)\s*\)/g, 'vars[$1]')
      .replace(/\bvars\.getIteration\(\s*\)/g, '(__ITER + 1)')
      .replace(/\bctx\.getThreadNum\(\s*\)/g, '(__VU - 1)')
      .replace(/\bprev\.isSuccessful\(\s*\)/g, '(res && res.status < 400)')
      .replace(/\bprev\.getResponseCode\(\s*\)/g, 'String(res && res.status)')
      .replace(/\s+as\s+(int|Integer|long|Long|double|Double|float)\b/g, ' * 1')
      .replace(/\s+as\s+String\b/g, " + ''")
      .replace(/\.toInteger\(\s*\)/g, ' * 1')
      .replace(/\.(size|length)\(\s*\)/g, '.length')
      .replace(/\.isEmpty\(\s*\)/g, '.length === 0')
      .replace(/\.contains\(/g, '.includes(')
      .replace(/\bnull\b/g, 'undefined')
      .replace(/\s+(eq)\s+/g, ' == ').replace(/\s+(ne)\s+/g, ' != ').replace(/\s+and\s+/g, ' && ').replace(/\s+or\s+/g, ' || ').replace(/(^|\s)not\s+/g, '$1!');
    if (/\b(vars\.(put|putObject|remove)|props\.|ctx\.|prev\.|log\.|sampler\.|SampleResult|new |def |import |\{)/.test(e)) return null;
    // Only string methods that exist in JavaScript too; anything else (Groovy/Java API) → by hand.
    const calls = [...e.matchAll(/\.([A-Za-z_]\w*)\s*\(/g)].map(m => m[1]);
    if (calls.some(m => !/^(equals|includes|startsWith|endsWith|trim|toLowerCase|toUpperCase|test)$/.test(m))) return null;
    if (/\.equals\(/.test(e)) ctx.helpers.add('equals');
    try { new Function('vars', 'res', '__ITER', '__VU', '__ENV', 'return (' + e + ');'); } catch (err) { return null; }  // compiles, never runs
    return '(' + e.trim() + ')';
  }

  // ---------------------------------------------------------------- thread groups → scenarios

  function dur(ctx, secondsExpr) {
    if (isLiteral(secondsExpr)) return q(Math.max(0, Math.round(Number(secondsExpr))) + 's');
    return '`${' + secondsExpr + '}s`';
  }

  function scenarioFor(ctx, tg, k, fnName) {
    const name = tg.attrs.testname || 'Thread Group';
    const lines = [];
    const add = (key, v) => lines.push(key + ': ' + v);
    if (k === 'ThreadGroup' || k === 'SetupThreadGroup' || k === 'PostThreadGroup') {
      const threads = ctx.num(str(tg, 'ThreadGroup.num_threads'), 1);
      const ramp = ctx.num(str(tg, 'ThreadGroup.ramp_time'), 0);
      const scheduler = bool(tg, 'ThreadGroup.scheduler', false);
      const duration = ctx.num(str(tg, 'ThreadGroup.duration'), 0);
      const delay = ctx.num(str(tg, 'ThreadGroup.delay'), 0);
      const lc = elemProp(tg, 'ThreadGroup.main_controller');
      const loopsRaw = str(lc, 'LoopController.loops');
      const forever = bool(lc, 'LoopController.continue_forever', false) && (loopsRaw.trim() === '-1') || loopsRaw.trim() === '-1';
      const loops = ctx.num(loopsRaw, 1);
      if (scheduler && duration !== '0') {
        if (ramp !== '0') {
          add('executor', "'ramping-vus'");
          add('startVUs', '0');
          const hold = isLiteral(ramp) && isLiteral(duration) ? String(Math.max(0, Number(duration) - Number(ramp))) : 'Math.max(0, ' + duration + ' - ' + ramp + ')';
          add('stages', '[\n        { duration: ' + dur(ctx, ramp) + ', target: ' + threads + ' },\n        { duration: ' + dur(ctx, hold) + ', target: ' + threads + ' },\n      ]');
          add('gracefulRampDown', "'30s'");
        } else {
          add('executor', "'constant-vus'");
          add('vus', threads);
          add('duration', dur(ctx, duration));
        }
        if (!forever && loops !== '1' && isLiteral(loops)) ctx.info('"' + name + '" also had a loop count (' + loops + '). k6 runs for the duration instead.');
        if (delay !== '0') add('startTime', dur(ctx, delay));
      } else if (!forever) {
        add('executor', "'per-vu-iterations'");
        add('vus', threads);
        add('iterations', loops);
        add('maxDuration', "'1h'");
        if (ramp !== '0') ctx.info('"' + name + '" ramps up over ' + ramp + ' s in JMeter. k6\'s per-vu-iterations starts all VUs together; switch to ramping-vus if the ramp matters.');
      } else {
        add('executor', "'ramping-vus'");
        add('startVUs', '0');
        add('stages', '[\n        { duration: ' + dur(ctx, ramp === '0' ? '1' : ramp) + ', target: ' + threads + ' },\n        { duration: ' + (ctx.opts.duration ? q(ctx.opts.duration) : "'10m'") + ', target: ' + threads + ' },\n      ]');
        ctx.warn('"' + name + '" loops forever with no duration in JMeter. The k6 scenario holds for ' + (ctx.opts.duration || '10m') + ': change the second stage to your test length.');
      }
    } else if (k === 'ConcurrencyThreadGroup' || k === 'ArrivalsThreadGroup') {
      const unit = str(tg, 'Unit') === 'S' ? 1 : 60;
      const target = ctx.num(str(tg, 'TargetLevel'), 1);
      const rampUp = ctx.num(str(tg, 'RampUp'), 0);
      const hold = ctx.num(str(tg, 'Hold'), 0);
      const sec = v => (isLiteral(v) ? String(Number(v) * unit) : '(' + v + ') * ' + unit);
      if (str(tg, 'Steps') && str(tg, 'Steps') !== '0') ctx.info('"' + name + '" uses ramp-up steps. k6 ramps smoothly instead.');
      if (k === 'ConcurrencyThreadGroup') {
        add('executor', "'ramping-vus'");
        add('startVUs', '0');
      } else {
        add('executor', "'ramping-arrival-rate'");
        add('startRate', '0');
        add('timeUnit', "'1s'");
        add('preAllocatedVUs', isLiteral(target) ? String(Math.max(10, Math.ceil(Number(target) * 2))) : '50');
        add('maxVUs', isLiteral(target) ? String(Math.max(50, Math.ceil(Number(target) * 10))) : '500');
      }
      add('stages', '[\n        { duration: ' + dur(ctx, sec(rampUp)) + ', target: ' + target + ' },\n        { duration: ' + dur(ctx, sec(hold)) + ', target: ' + target + ' },\n      ]');
    } else {
      ctx.warn('"' + name + '" (' + k + ') was converted with 1 VU for ' + (ctx.opts.duration || '1m') + ': set the load model by hand.');
      ctx.stats.todo++;
      add('executor', "'constant-vus'");
      add('vus', '1');
      add('duration', q(ctx.opts.duration || '1m'));
    }
    if (fnName) add('exec', q(fnName));
    return lines;
  }

  // ---------------------------------------------------------------- data: variables, CSV, random, counter

  function initData(ctx, items, parentScope, once) {
    // Collects CSV/random/counter config visible at this level. Returns per-iteration lines.
    const lines = [];
    for (const it of items) {
      if (!enabled(it.el)) continue;
      const k = kindOf(it.el);
      if (k === 'CSVDataSet') lines.push(...csvData(ctx, it.el, once));
      else if (k === 'RandomVariableConfig') {
        const v = str(it.el, 'variableName');
        if (!v) continue;
        ctx.helpers.add('randomInt'); ctx.definedVars.add(v);
        lines.push(varRef(v) + ' = String(randomInt(' + ctx.num(str(it.el, 'minimumValue'), 1) + ', ' + ctx.num(str(it.el, 'maximumValue'), 100) + ')); // Random Variable');
      } else if (k === 'CounterConfig') {
        const v = str(it.el, 'CounterConfig.name');
        if (!v) continue;
        ctx.definedVars.add(v);
        const start = ctx.num(str(it.el, 'CounterConfig.start'), 1), incr = ctx.num(str(it.el, 'CounterConfig.incr'), 1);
        const perUser = bool(it.el, 'CounterConfig.per_user', false);
        if (!perUser && !once) ctx.k6ExecImport = true;
        lines.push(varRef(v) + ' = String(' + start + ' + ' + (once ? '0' : perUser ? '__ITER' : 'exec.scenario.iterationInTest') + ' * ' + incr + '); // Counter');
      }
    }
    return lines;
  }

  function csvData(ctx, el, once) {
    const file = str(el, 'filename');
    const names = str(el, 'variableNames').split(/\s*,\s*/).filter(Boolean);
    let delim = str(el, 'delimiter') || ',';
    if (delim === '\\t') delim = '\t';
    const header = !names.length || bool(el, 'ignoreFirstLine', false);
    const shared = str(el, 'shareMode') || 'shareMode.all';
    const baseName = (file.split(/[\\/]/).pop() || 'data.csv').replace(/\$\{[^}]*\}/g, '');
    const id = 'csv_' + (baseName.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1') || 'data');
    // The same CSV element seen again (plan-level CSV in several thread groups) reuses one SharedArray.
    const again = ctx.csvs.find(c => c.el === el);
    let uniq = again ? again.id : id, n = 2;
    while (!again && ctx.csvs.some(c => c.id === uniq)) uniq = id + '_' + n++;
    ctx.helpers.add('parseCsv');
    ctx.k6DataImport = true;
    const path = './' + (baseName || 'data.csv');
    if (!again) ctx.csvs.push({ id: uniq, path, delim, header, names, el });
    if (/\$\{/.test(file)) ctx.info('CSV file "' + file + '" uses a variable in its path. The script opens ' + path + ': put the file next to the script or change the path.');
    if (bool(el, 'quotedData', false)) ctx.info('CSV "' + baseName + '" has quoted data: the CSV reader in the script handles "double quotes".');
    if (!bool(el, 'recycle', true)) ctx.info('CSV "' + baseName + '" doesn\'t recycle in JMeter. In k6 rows wrap around: add more rows or a check if each row must be used once.');
    let idx;
    if (once) idx = '0';
    else if (shared === 'shareMode.thread') idx = '__ITER';
    else { ctx.k6ExecImport = true; idx = 'exec.scenario.iterationInTest'; }
    names.forEach(v => ctx.definedVars.add(v));
    const lines = ['const row_' + uniq + ' = ' + uniq + '[' + idx + ' % ' + uniq + '.length]; // CSV Data Set: ' + baseName];
    if (names.length) lines.push(names.map((v, i) => varRef(v) + ' = row_' + uniq + '[' + i + ']').join('; ') + ';');
    else lines.push('Object.assign(vars, row_' + uniq + ');');
    if (!names.length) ctx.headerCsv = true;
    return lines;
  }

  function userVariables(ctx, items, testPlan) {
    const out = [];
    const add = (args) => {
      for (const a of args) {
        if (a.name !== 'elementProp') continue;
        const n = str(a, 'Argument.name').trim();
        if (!n) continue;
        ctx.definedVars.add(n);
        out.push([n, str(a, 'Argument.value')]);
      }
    };
    add(collection(elemProp(testPlan, 'TestPlan.user_defined_variables'), 'Arguments.arguments'));
    for (const it of items) if (enabled(it.el) && kindOf(it.el) === 'Arguments') add(collection(it.el, 'Arguments.arguments'));
    return out;
  }

  // ---------------------------------------------------------------- helpers emitted into the script

  const HELPERS = {
    equals: `// Groovy's a.equals(b), used by converted If Controller conditions.
if (!String.prototype.equals) {
  Object.defineProperty(String.prototype, 'equals', { value: function (other) { return String(this) === String(other); } });
}`,
    randomInt: `function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}`,
    randomString: `function randomString(length, chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') {
  let s = '';
  for (let i = 0; i < length; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}`,
    gaussian: `// A standard normal random number (for JMeter's Gaussian Random Timer).
function gaussian() {
  return Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
}`,
    parseCsv: `// Reads a CSV file. Handles "quoted, values" and "" inside quotes.
function parseCsv(text, delimiter, hasHeader) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === delimiter) { row.push(cell); cell = ''; }
    else if (c === '\\n' || c === '\\r') {
      if (c === '\\r' && text[i + 1] === '\\n') i++;
      row.push(cell); cell = '';
      if (row.some(v => v !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some(v => v !== '')) rows.push(row);
  if (!hasHeader) return rows;
  const head = rows.shift() || [];
  return rows.map(r => Object.fromEntries(head.map((h, i) => [h.trim(), r[i]])));
}`,
    regexExtract: `// JMeter Regular Expression Extractor: template like $1$, match number (0 = random, -1 = all).
function regexExtract(name, text, re, template, matchNo, fallback) {
  const all = [...String(text).matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))];
  const fill = (m) => template.replace(/\\$(\\d+)\\$/g, (_, g) => m[Number(g)] ?? '');
  if (matchNo < 0) {
    vars[name + '_matchNr'] = String(all.length);
    all.forEach((m, i) => { vars[name + '_' + (i + 1)] = fill(m); });
    vars[name] = all.length ? fill(all[0]) : fallback;
    return;
  }
  const m = matchNo === 0 ? all[Math.floor(Math.random() * all.length)] : all[matchNo - 1];
  vars[name] = m ? fill(m) : fallback;
}`,
    jsonPath: `// A small JSONPath reader: $.a.b, $['a'], [0], [*], ..name. Filters [?()] aren't supported.
function jsonPath(res, path) {
  let data;
  try { data = typeof res === 'object' && res !== null && 'body' in res ? res.json() : res; } catch (e) { return []; }
  const tokens = [];
  const re = /\\.\\.([\\w$-]+|\\*)|\\.([\\w$-]+|\\*)|\\[\\s*'([^']*)'\\s*\\]|\\[\\s*"([^"]*)"\\s*\\]|\\[\\s*(-?\\d+)\\s*\\]|\\[\\s*\\*\\s*\\]/g;
  const p = String(path).trim().replace(/^\\$/, '');
  let m;
  while ((m = re.exec(p))) {
    if (m[1] !== undefined) tokens.push({ deep: m[1] });
    else if (m[2] !== undefined) tokens.push({ key: m[2] });
    else if (m[3] !== undefined || m[4] !== undefined) tokens.push({ key: m[3] ?? m[4] });
    else if (m[5] !== undefined) tokens.push({ index: Number(m[5]) });
    else tokens.push({ key: '*' });
  }
  let cur = [data];
  for (const t of tokens) {
    const next = [];
    for (const v of cur) {
      if (v === null || typeof v !== 'object') continue;
      if (t.deep !== undefined) {
        const stack = [v];
        while (stack.length) {
          const o = stack.pop();
          if (o === null || typeof o !== 'object') continue;
          if (t.deep === '*') next.push(...Object.values(o));
          else if (Object.prototype.hasOwnProperty.call(o, t.deep)) next.push(o[t.deep]);
          stack.push(...Object.values(o));
        }
      } else if (t.index !== undefined) {
        if (Array.isArray(v)) { const i = t.index < 0 ? v.length + t.index : t.index; if (i in v) next.push(v[i]); }
      } else if (t.key === '*') next.push(...Object.values(v));
      else if (Object.prototype.hasOwnProperty.call(v, t.key)) next.push(v[t.key]);
    }
    cur = next;
  }
  return tokens.length ? cur : [data];
}`,
    jsonExtract: `// JMeter JSON Extractor: match number 0 = random, -1 = all (name_1, name_2, ... and name_matchNr).
function jsonExtract(name, res, path, matchNo, fallback) {
  const found = jsonPath(res, path).map(v => (typeof v === 'object' ? JSON.stringify(v) : String(v)));
  if (matchNo < 0) {
    vars[name + '_matchNr'] = String(found.length);
    found.forEach((v, i) => { vars[name + '_' + (i + 1)] = v; });
    vars[name] = found.length ? found[0] : fallback;
    return;
  }
  const v = matchNo === 0 ? found[Math.floor(Math.random() * found.length)] : found[matchNo - 1];
  vars[name] = v === undefined ? fallback : v;
}`,
    boundaryExtract: `// JMeter Boundary Extractor: the text between left and right (match number 0 = random, -1 = all).
function boundaryExtract(name, text, left, right, matchNo, fallback) {
  const found = [];
  let i = 0;
  text = String(text);
  while (true) {
    const a = text.indexOf(left, i);
    if (a < 0) break;
    const b = text.indexOf(right, a + left.length);
    if (b < 0) break;
    found.push(text.slice(a + left.length, b));
    i = b + right.length;
  }
  if (matchNo < 0) {
    vars[name + '_matchNr'] = String(found.length);
    found.forEach((v, n) => { vars[name + '_' + (n + 1)] = v; });
    vars[name] = found.length ? found[0] : fallback;
    return;
  }
  const v = matchNo === 0 ? found[Math.floor(Math.random() * found.length)] : found[matchNo - 1];
  vars[name] = v === undefined ? fallback : v;
}`,
    cssExtract: `// JMeter CSS Selector Extractor: an attribute (or the text when attribute is empty) of the nth match.
function cssExtract(name, res, selector, attribute, matchNo, fallback) {
  const found = [];
  parseHTML(String(res.body)).find(selector).each((i, el) => {
    const v = attribute ? el.getAttribute(attribute) : el.textContent();
    if (v !== undefined && v !== null) found.push(String(v));
  });
  if (matchNo < 0) {
    vars[name + '_matchNr'] = String(found.length);
    found.forEach((v, n) => { vars[name + '_' + (n + 1)] = v; });
    vars[name] = found.length ? found[0] : fallback;
    return;
  }
  const v = matchNo === 0 ? found[Math.floor(Math.random() * found.length)] : found[matchNo - 1];
  vars[name] = v === undefined ? fallback : v;
}`,
  };

  // ---------------------------------------------------------------- main

  const DEFAULTS = { baseUrl: true, statusCheck: true, p95: 500, errorRate: 1, duration: '10m' };

  function slug(s, used) {
    let b = String(s || 'thread_group').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'thread_group';
    if (/^\d/.test(b)) b = 'tg_' + b;
    let r = b, n = 2;
    while (used.has(r)) r = b + '_' + n++;
    used.add(r);
    return r;
  }

  function convert(text, options) {
    const opts = Object.assign({}, DEFAULTS, options || {});
    const src = String(text || '').replace(/^﻿/, '').trim();
    if (!src) return { script: '', warnings: [], infos: [], error: 'Paste a JMeter test plan (.jmx) or choose a file.' };
    if (!/<jmeterTestPlan[\s>]/.test(src)) {
      return { script: '', warnings: [], infos: [], error: 'This doesn\'t look like a JMeter test plan. A .jmx file starts with <?xml ...?> and <jmeterTestPlan>.' };
    }
    let doc;
    try { doc = parseXml(src); } catch (e) { return { script: '', warnings: [], infos: [], error: 'Couldn\'t read the file: ' + e.message }; }
    const plan = doc.children.find(c => c.name === 'jmeterTestPlan');
    const top = walk(plan && plan.children.find(c => c.name === 'hashTree'));
    const tpItem = top.find(it => kindOf(it.el) === 'TestPlan');
    if (!tpItem) return { script: '', warnings: [], infos: [], error: 'This file is a JMeter snippet (a template part), not a full test plan: it has no Test Plan element. Open it in JMeter, add it to a test plan and save that.' };

    const ctx = new Ctx(opts);
    ctx.csvs = [];
    const testPlan = tpItem.el;
    const planItems = tpItem.kids;
    const planName = testPlan.attrs.testname || 'Test Plan';
    ctx.planName = planName;
    ctx.planItems = planItems;
    ctx.moduleStack = [];

    const isTG = k => /^(ThreadGroup|SetupThreadGroup|PostThreadGroup|ConcurrencyThreadGroup|ArrivalsThreadGroup|UltimateThreadGroup|SteppingThreadGroup|OpenModelThreadGroup)$/.test(k);
    const tgs = planItems.filter(it => enabled(it.el) && isTG(kindOf(it.el)));
    if (!tgs.length) return { script: '', warnings: [], infos: [], error: 'The test plan has no enabled thread group, so there is nothing to convert.' };
    if (bool(testPlan, 'TestPlan.serialize_threadgroups', false) && tgs.filter(t => !/Setup|Post/.test(kindOf(t.el))).length > 1) {
      ctx.warn('"Run thread groups consecutively" is on in JMeter. The k6 scenarios run at the same time: add startTime to each one to run them in order.');
    }

    // Base URL: the most common origin across HTTP samplers, honouring defaults.
    const origins = new Map();
    const collectOrigins = (items, defaults) => {
      const own = defaults.concat(items.filter(i => enabled(i.el) && kindOf(i.el) === 'HttpDefaults').map(i => i.el));
      for (const it of items) {
        const k = kindOf(it.el);
        if (!enabled(it.el) && k !== 'TestFragmentController') continue;  // fragments are saved disabled but still used
        if (/^HTTPSampler(Proxy|2)?$/.test(k)) {
          const get = key => { const v = str(it.el, key).trim(); if (v) return v; for (let i = own.length - 1; i >= 0; i--) { const d = str(own[i], key).trim(); if (d) return d; } return ''; };
          let protocol = get('HTTPSampler.protocol'), domain = get('HTTPSampler.domain'), port = get('HTTPSampler.port');
          const full = /^(https?):\/\/([^/:?#]+)(?::([^/?#]*))?/i.exec(str(it.el, 'HTTPSampler.path').trim());
          if (full) { protocol = full[1]; domain = full[2]; port = full[3] || ''; }
          if (!domain) continue;
          if (!protocol) protocol = port === '443' ? 'https' : 'http';
          protocol = protocol.toLowerCase();
          if ((protocol === 'https' && port === '443') || (protocol === 'http' && port === '80')) port = '';
          const o = protocol + '://' + domain + (port ? ':' + port : '');
          origins.set(o, (origins.get(o) || 0) + 1);
        }
        collectOrigins(it.kids, own);
      }
    };
    collectOrigins(planItems, []);
    ctx.baseOrigin = [...origins.entries()].sort((a, b) => b[1] - a[1])[0];
    ctx.baseOrigin = ctx.baseOrigin ? ctx.baseOrigin[0] : '';

    // Build each thread group's body first (this also collects imports, helpers and notes).
    const planScope = scopeFrom(null, planItems);
    const planDataFor = once => initData(ctx, planItems, planScope, once);
    const userVars = userVariables(ctx, planItems, testPlan);
    const used = new Set(['default', 'setup', 'teardown', 'options', 'vars', 'res', 'http', 'check', 'group', 'sleep', 'exec']);
    const groups = [];
    for (const tg of tgs) {
      const k = kindOf(tg.el);
      const body = new Out();
      body.depth = 1;
      const once = /^(SetupThreadGroup|PostThreadGroup)$/.test(k);
      planDataFor(once).concat(initData(ctx, tg.kids, planScope, once)).forEach(l => body.line(l));
      emitChildren(ctx, body, tg.kids, planScope, false);
      groups.push({ tg, k, body, name: tg.el.attrs.testname || 'Thread Group' });
    }
    const mains = groups.filter(g => !/^(SetupThreadGroup|PostThreadGroup)$/.test(g.k));
    const single = mains.length === 1;
    for (const g of mains) g.fn = single ? null : slug(g.name, used);

    // Notes for things that apply to the whole plan.
    if (ctx.listeners) ctx.info('Listeners (View Results Tree, Summary Report, Backend Listener...) are not needed: k6 prints a summary at the end. Use --out for InfluxDB, Prometheus or a JSON/CSV file.');
    if (!ctx.cookieManager) ctx.info('The JMeter plan has no Cookie Manager, but k6 always keeps cookies per VU. That matters only if the server treats cookie-less requests differently.');
    if (bool(testPlan, 'TestPlan.tearDown_on_shutdown', false) && groups.some(g => g.k === 'PostThreadGroup')) {}
    const matchAll = v => { const m = /^(.+)_(\d+|matchNr)$/.exec(v); return m && ctx.definedVars.has(m[1]); };
    let undefinedVars = [...ctx.usedVars].filter(v => !ctx.definedVars.has(v) && !matchAll(v));
    if (undefinedVars.length && ctx.headerCsv) {
      ctx.info('These variables aren\'t set in the plan, so they probably come from a CSV file\'s header row: ' + undefinedVars.slice(0, 12).join(', ') + '. Check the column names match.');
      undefinedVars = [];
    }
    if (undefinedVars.length) {
      ctx.warn('These variables are used but never set in the plan (maybe by a script or a plugin): ' + undefinedVars.slice(0, 12).join(', ') + (undefinedVars.length > 12 ? '…' : '') + '. Give them a value in "vars" at the top of the script.');
    }

    // ---------------- assemble
    const o = new Out();
    const today = new Date().toISOString().slice(0, 10);
    o.comment('k6 load test converted from the JMeter test plan "' + planName + '"');
    o.comment('by the free converter at https://pawansinha.com.au/tools/jmeter-to-k6/ on ' + today + '.');
    o.comment('Run it: k6 run script.js' + (ctx.opts.baseUrl && ctx.baseOrigin ? '   (another environment: k6 run -e BASE_URL=https://staging.example.com script.js)' : ''));
    const todoCount = ctx.stats.todo;
    if (todoCount) o.comment(todoCount + ' item' + (todoCount === 1 ? '' : 's') + ' need a manual touch: search this file for TODO.');
    o.line('');
    o.line("import http from 'k6/http';");
    const k6i = ['check', 'group', 'sleep'].filter(x => ctx.k6Imports.has(x));
    if (k6i.length) o.line('import { ' + k6i.join(', ') + " } from 'k6';");
    if (ctx.k6DataImport) o.line("import { SharedArray } from 'k6/data';");
    if (ctx.k6ExecImport) o.line("import exec from 'k6/execution';");
    if (ctx.k6HtmlImport) o.line("import { parseHTML } from 'k6/html';");
    if (/encoding\.b64encode/.test(groups.map(g => g.body.text()).join('\n'))) o.line("import encoding from 'k6/encoding';");
    o.line('');

    // variables first: options may use them (thread counts from ${variables})
    o.comment('JMeter variables. Each virtual user has its own copy, like each JMeter thread.');
    const exprs = userVars.map(([n, v]) => [n, ctx.js(v)]);
    if (exprs.some(([, e]) => /\bvars\b/.test(e))) {
      // A value refers to another variable, so set them one by one (in JMeter's order).
      o.line('const vars = {};');
      for (const [n, e] of exprs) o.line(varRef(n) + ' = ' + e + ';');
    } else if (exprs.length) {
      o.open('const vars = {');
      for (const [n, e] of exprs) o.line((IDENT.test(n) ? n : q(n)) + ': ' + e + ',');
      o.close('};');
    } else o.line('const vars = {};');
    const missing = undefinedVars.filter(v => !userVars.some(u => u[0] === v));
    if (missing.length) {
      o.comment('TODO: set these, they are used but never given a value in the JMeter plan:');
      for (const v of missing.slice(0, 20)) o.line(varRef(v) + " = ''; // TODO");
    }
    o.line('');

    // options
    o.open('export const options = {');
    if (ctx.keepCookies) o.line('noCookiesReset: true, // JMeter\'s Cookie Manager kept cookies between iterations');
    o.open('scenarios: {');
    for (const g of mains) {
      const key = g.fn || slug(g.name, new Set());
      o.open(key + ': {');
      scenarioFor(ctx, g.tg.el, g.k, g.fn).forEach(l => o.line(l + ','));
      o.close('},');
    }
    o.close('},');
    o.open('thresholds: {');
    const p95 = Number(opts.p95), er = Number(opts.errorRate);
    if (Number.isFinite(p95) && p95 > 0) o.line("http_req_duration: ['p(95)<" + p95 + "'],  // 95% of requests faster than " + p95 + ' ms');
    if (Number.isFinite(er) && er >= 0) o.line("http_req_failed: ['rate<" + +(er / 100).toFixed(4) + "'],  // under " + er + '% errors');
    if (ctx.stats.checks) o.line("checks: ['rate>0.99'],  // 99% of checks pass");
    o.close('},');
    o.close('};');
    o.line('');

    if (ctx.needBase || (ctx.opts.baseUrl && ctx.baseOrigin)) {
      o.line('');
      o.line('const BASE_URL = __ENV.BASE_URL || ' + (ctx.baseOrigin ? ctx.js(ctx.baseOrigin) : "'http://localhost'") + ';');
    }
    for (const c of ctx.headerConsts || []) {
      o.line('');
      o.comment('From "' + (c.label || 'HTTP Header Manager') + '"');
      o.open('const ' + c.name + ' = {');
      for (const [k, v] of c.entries) o.line((IDENT.test(k) ? k : q(k)) + ': ' + q(v) + ',');
      o.close('};');
    }
    for (const c of ctx.csvs) {
      o.line('');
      o.comment('Put ' + c.path.slice(2) + ' next to this script.' + (c.names.length ? ' Columns: ' + c.names.join(', ') + '.' : ''));
      o.line('const ' + c.id + ' = new SharedArray(' + q(c.path) + ', () => parseCsv(open(' + q(c.path) + '), ' + q(c.delim) + ', ' + c.header + ')' + (c.names.length && c.header ? '.map(Object.values)' : '') + ');');
    }
    o.line('');

    // thread groups
    const setup = groups.filter(g => g.k === 'SetupThreadGroup');
    const teardown = groups.filter(g => g.k === 'PostThreadGroup');
    if (setup.length) {
      o.comment('From the setUp Thread Group' + (setup.length > 1 ? 's' : '') + ': runs once before the test. Return anything the test needs.');
      o.open('export function setup() {');
      o.line('let res;');
      setup.forEach(g => { if (setup.length > 1) o.comment(g.name); g.body.lines.forEach(l => o.lines.push(l)); });
      o.close('}');
      o.line('');
      ctx.info('setUp Thread Group → setup(). Values it extracts stay in setup(); return them (return { token: vars.token }) and read them from the data argument to share them with the VUs.');
    }
    for (const g of mains) {
      o.comment('Thread Group "' + g.name + '"');
      o.open(g.fn ? 'export function ' + g.fn + '() {' : 'export default function () {');
      o.line('let res;');
      g.body.lines.forEach(l => o.lines.push(l));
      o.close('}');
      o.line('');
    }
    if (teardown.length) {
      o.comment('From the tearDown Thread Group: runs once after the test.');
      o.open('export function teardown() {');
      o.line('let res;');
      teardown.forEach(g => g.body.lines.forEach(l => o.lines.push(l)));
      o.close('}');
      o.line('');
    }

    // helpers
    const order = ['equals', 'randomInt', 'randomString', 'gaussian', 'parseCsv', 'jsonPath', 'regexExtract', 'jsonExtract', 'boundaryExtract', 'cssExtract'];
    const helpers = order.filter(h => ctx.helpers.has(h));
    if (helpers.length) {
      o.comment('---- Helpers that do what JMeter elements did ----');
      helpers.forEach(h => { HELPERS[h].split('\n').forEach(l => o.lines.push(l)); o.line(''); });
    }

    let script = o.text().replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
    if (!ctx.stats.requests) ctx.warn('No HTTP requests were found in the enabled thread groups.');
    return {
      script, warnings: ctx.warnings, infos: ctx.infos, error: null,
      stats: Object.assign({ threadGroups: groups.length, csvFiles: ctx.csvs.map(c => c.path.slice(2)) }, ctx.stats),
      envVars: [...ctx.envVars.keys()],
    };
  }

  const api = { convert, parseXml, splitVars, fnArgs, DEFAULTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.JmxToK6 = api;
})(typeof window !== 'undefined' ? window : this);
