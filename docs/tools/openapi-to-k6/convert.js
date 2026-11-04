/* OpenAPI / Swagger → k6 converter. Runs in the browser (window.OpenApiToK6) and in Node (module.exports), so it can be
   unit-tested. Nothing is sent anywhere: all parsing happens on the visitor's machine.

   Accepts OpenAPI 3.0 / 3.1 and Swagger 2.0, as JSON or YAML (YAML needs a parser: pass options.yaml, or load js-yaml
   so window.jsyaml exists). Produces a k6 (v1.x) script with one request per operation, grouped by tag. */
(function (root) {
  'use strict';

  const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
  const UNSAFE = ['POST', 'PUT', 'PATCH', 'DELETE'];

  const DEFAULTS = {
    model: 'closed',          // 'closed' (VUs + duration) or 'open' (constant-arrival-rate)
    vus: 10, duration: '1m',
    rate: 10, timeUnit: '1s', preAllocatedVUs: 20, maxVUs: 100,
    thinkTime: 1,             // seconds between requests and at the end of each iteration (closed model)
    p95: 500,                 // ms, 0 to skip
    errorRate: 1,             // %, empty/negative to skip
    checks: true,             // check each response has the status the spec documents
    optionalQuery: true,      // list optional query parameters as a comment
    baseUrl: '',              // override the server URL from the spec
    include: null,            // array of operation ids ("GET /pets/{id}"); null = every GET operation
    yaml: null,               // function (text) → object, for YAML input
  };

  // ---------------------------------------------------------------- code helpers (same style as curl → k6)

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

  function key(k) { return /^[A-Za-z_$][\w$]*$/.test(k) ? k : lit(k); }

  function envName(name, used) {
    let base = String(name).replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'SECRET';
    if (/^\d/.test(base)) base = '_' + base;
    let n = base, i = 2;
    while (used.has(n)) n = base + '_' + i++;
    used.add(n);
    return n;
  }

  function jsValue(v, indent) { return JSON.stringify(v, null, 2).replace(/\n/g, '\n' + indent); }
  function num(v, d) { const n = +v; return isFinite(n) && n > 0 ? n : d; }
  function indent(text, pad) { return text.split('\n').map(l => (l ? pad + l : l)).join('\n'); }
  function oneLine(s, max) {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > (max || 100) ? t.slice(0, (max || 100) - 1) + '…' : t;
  }
  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

  // ---------------------------------------------------------------- parsing

  function parseSpec(input, yaml) {
    if (isObj(input)) return checkSpec(input);
    const text = String(input == null ? '' : input).replace(/^\uFEFF/, '').trim();
    if (!text) throw new Error('Paste an OpenAPI or Swagger definition first.');
    let spec;
    if (text[0] === '{' || text[0] === '[') {
      try { spec = JSON.parse(text); }
      catch (e) { throw new Error("This looks like JSON but it doesn't parse: " + e.message + '. Check for a missing comma or quote, or paste the whole file.'); }
    } else {
      const load = yaml || (root && root.jsyaml && root.jsyaml.load);
      if (!load) throw new Error("This isn't JSON, and the YAML reader hasn't loaded (are you offline?). Paste the JSON version, or reload the page.");
      try { spec = load(text); }
      catch (e) { throw new Error("This doesn't parse as YAML or JSON: " + String(e.message || e).split('\n')[0] + '.'); }
    }
    return checkSpec(spec);
  }

  function checkSpec(spec) {
    if (!isObj(spec)) throw new Error("This doesn't look like an API definition: expected an object with an 'openapi' or 'swagger' field.");
    if (spec.swaggerVersion || (spec.swagger && !/^2\./.test(String(spec.swagger)))) {
      throw new Error('This is Swagger ' + (spec.swaggerVersion || spec.swagger) + '. Only Swagger 2.0 and OpenAPI 3.x are supported: convert it first (for example with the Swagger Editor).');
    }
    if (!spec.openapi && !spec.swagger) {
      if (spec.info && spec.item) throw new Error('This looks like a Postman collection, not an OpenAPI definition. Try the Postman to k6 converter instead.');
      throw new Error("This file has no 'openapi' or 'swagger' field, so it doesn't look like an OpenAPI or Swagger definition.");
    }
    if (spec.openapi && !/^3\./.test(String(spec.openapi))) throw new Error('OpenAPI ' + spec.openapi + " isn't supported yet: use a 3.0, 3.1 or Swagger 2.0 file.");
    if (!isObj(spec.paths) || !Object.keys(spec.paths).length) throw new Error("This definition has no 'paths', so there are no requests to turn into a test.");
    return spec;
  }

  // ---------------------------------------------------------------- $ref

  function makeCtx(spec, warnings) {
    return { spec, warnings, warned: new Set(), v2: !!spec.swagger };
  }

  function warnOnce(ctx, text) { if (!ctx.warned.has(text)) { ctx.warned.add(text); ctx.warnings.push(text); } }

  function getRef(ctx, ref) {
    if (typeof ref !== 'string' || ref[0] !== '#') {
      warnOnce(ctx, `External reference ${oneLine(ref, 80)} can't be followed in the browser, so it was left empty. Bundle the spec into one file (for example with "redocly bundle") for complete bodies.`);
      return undefined;
    }
    let node = ctx.spec;
    for (const raw of ref.slice(1).split('/').filter(Boolean)) {
      const part = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
      if (node == null || typeof node !== 'object' || !(part in node)) { warnOnce(ctx, `Reference ${ref} points to nothing in this file.`); return undefined; }
      node = node[part];
    }
    return node;
  }

  // Follow $ref chains on non-schema objects (parameters, request bodies, responses, security schemes).
  function deref(ctx, obj) {
    let n = obj, hops = 0;
    while (isObj(n) && typeof n.$ref === 'string' && hops++ < 20) n = getRef(ctx, n.$ref);
    return n;
  }

  // ---------------------------------------------------------------- sample values from schemas

  const FORMAT_SAMPLES = {
    email: 'user@example.com', uuid: '3fa85f64-5717-4562-b3fc-2c963f66afa6', date: '2026-01-01', 'date-time': '2026-01-01T09:00:00Z',
    time: '09:00:00', uri: 'https://example.com', url: 'https://example.com', 'uri-reference': '/example', hostname: 'example.com',
    ipv4: '192.0.2.1', ipv6: '2001:db8::1', byte: 'U2FtcGxl', password: 'change-me', duration: 'P1D', 'iri': 'https://example.com',
  };

  function firstType(s) {
    let t = s.type;
    if (Array.isArray(t)) t = t.find(x => x !== 'null') || t[0];
    if (!t) {
      if (s.properties || s.additionalProperties) t = 'object';
      else if (s.items) t = 'array';
    }
    return t;
  }

  function mergeAllOf(ctx, schema, stack) {
    const out = Object.assign({}, schema);
    delete out.allOf;
    const props = Object.assign({}, schema.properties || {});
    const required = new Set(schema.required || []);
    for (const part of schema.allOf) {
      let p = part, s2 = stack;
      if (isObj(p) && p.$ref) { if (stack.includes(p.$ref)) continue; s2 = stack.concat(p.$ref); p = getRef(ctx, p.$ref); }
      if (!isObj(p)) continue;
      if (p.allOf) p = mergeAllOf(ctx, p, s2);
      Object.assign(props, p.properties || {});
      (p.required || []).forEach(r => required.add(r));
      for (const k of ['type', 'example', 'format', 'items', 'enum', 'additionalProperties']) if (p[k] !== undefined && out[k] === undefined) out[k] = p[k];
    }
    if (Object.keys(props).length) { out.properties = props; if (!out.type) out.type = 'object'; }
    if (required.size) out.required = [...required];
    return out;
  }

  // forRequest: leave out readOnly properties; returns undefined for "write nothing" (binary)
  function sample(ctx, schema, opts, stack, depth) {
    stack = stack || []; depth = depth || 0;
    if (!isObj(schema)) return schema === true ? 'string' : undefined;
    if (schema.$ref) {
      if (stack.includes(schema.$ref)) return undefined;              // circular: stop here
      const target = getRef(ctx, schema.$ref);
      return sample(ctx, target, opts, stack.concat(schema.$ref), depth);
    }
    if (depth > 8) return undefined;
    if (schema.example !== undefined) return schema.example;
    if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
    if (schema.const !== undefined) return schema.const;
    if (schema.default !== undefined) return schema.default;
    if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum.find(v => v !== null) ?? schema.enum[0];
    if (Array.isArray(schema.allOf)) return sample(ctx, mergeAllOf(ctx, schema, stack), opts, stack, depth);
    const alt = schema.oneOf || schema.anyOf;
    if (Array.isArray(alt) && alt.length) {
      const pick = alt.find(a => !(isObj(a) && a.type === 'null')) || alt[0];
      const base = Object.assign({}, schema); delete base.oneOf; delete base.anyOf;
      const v = sample(ctx, pick, opts, stack, depth);
      if (isObj(v) && base.properties) return Object.assign(sample(ctx, base, opts, stack, depth) || {}, v);
      return v;
    }
    const t = firstType(schema);
    if (t === 'object') {
      const o = {};
      const props = schema.properties || {};
      for (const [name, p] of Object.entries(props)) {
        const ps = isObj(p) && p.$ref && !stack.includes(p.$ref) ? getRef(ctx, p.$ref) : p;
        if (opts.forRequest && isObj(ps) && ps.readOnly) continue;
        if (!opts.forRequest && isObj(ps) && ps.writeOnly) continue;
        const v = sample(ctx, p, opts, stack, depth + 1);
        if (v !== undefined) o[name] = v;
      }
      if (!Object.keys(props).length && isObj(schema.additionalProperties)) {
        const v = sample(ctx, schema.additionalProperties, opts, stack, depth + 1);
        if (v !== undefined) o.key = v;
      }
      return o;
    }
    if (t === 'array') {
      const v = sample(ctx, schema.items, opts, stack, depth + 1);
      if (v === undefined) return [];
      const n = Math.min(3, Math.max(1, +schema.minItems || 1));
      return Array.from({ length: n }, () => v);
    }
    if (t === 'integer' || t === 'number') {
      let v = t === 'integer' ? 1 : 1.5;
      const min = typeof schema.minimum === 'number' ? schema.minimum : (typeof schema.exclusiveMinimum === 'number' ? schema.exclusiveMinimum + (t === 'integer' ? 1 : 0.5) : null);
      if (min !== null) v = schema.exclusiveMinimum === true ? min + 1 : min;
      const max = typeof schema.maximum === 'number' ? schema.maximum : (typeof schema.exclusiveMaximum === 'number' ? schema.exclusiveMaximum - 1 : null);
      if (max !== null && v > max) v = max;
      if (t === 'integer') v = Math.round(v);
      return v;
    }
    if (t === 'boolean') return true;
    if (t === 'null') return null;
    if (t === 'file' || schema.format === 'binary') return opts.allowFile ? { __file: true } : undefined;
    // string (or unknown)
    let s = FORMAT_SAMPLES[schema.format] || 'string';
    if (+schema.minLength > s.length) s = s.padEnd(+schema.minLength, 'x');
    if (+schema.maxLength > 0 && s.length > +schema.maxLength) s = s.slice(0, +schema.maxLength);
    return s;
  }

  // Example for a parameter: example, examples, schema example/default/enum, then a generated value.
  function paramValue(ctx, p) {
    if (p.example !== undefined) return p.example;
    if (p['x-example'] !== undefined) return p['x-example'];
    if (isObj(p.examples)) {
      const first = deref(ctx, Object.values(p.examples)[0]);
      if (isObj(first) && first.value !== undefined) return first.value;
    }
    if (isObj(p.content)) {
      const media = Object.values(p.content)[0];
      if (isObj(media)) {
        if (media.example !== undefined) return media.example;
        return sample(ctx, media.schema, {});
      }
    }
    // Swagger 2.0 non-body parameters keep the schema fields on the parameter itself
    const schema = p.schema || p;
    if (p.default !== undefined) return p.default;
    if (Array.isArray(p.enum) && p.enum.length) return p.enum[0];
    return sample(ctx, schema, {});
  }

  function asString(v) {
    if (v === undefined || v === null) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }

  // ---------------------------------------------------------------- operations

  function listOperations(input, yaml) {
    const spec = isObj(input) && (input.openapi || input.swagger) ? input : parseSpec(input, yaml);
    const ctx = makeCtx(spec, []);
    const ops = [];
    for (const [path, rawItem] of Object.entries(spec.paths)) {
      const item = deref(ctx, rawItem);
      if (!isObj(item)) continue;
      for (const m of METHODS) {
        const op = item[m];
        if (!isObj(op)) continue;
        const method = m.toUpperCase();
        ops.push({
          id: method + ' ' + path, method, path,
          tag: (Array.isArray(op.tags) && op.tags.length ? String(op.tags[0]) : 'Other'),
          summary: oneLine(op.summary || op.operationId || op.description || '', 90),
          deprecated: !!op.deprecated,
          op, item,
        });
      }
    }
    return ops;
  }

  function serverUrl(ctx, override) {
    if (override && String(override).trim()) return { url: String(override).trim().replace(/\/+$/, ''), from: 'override' };
    const s = ctx.spec;
    if (ctx.v2) {
      const scheme = (Array.isArray(s.schemes) && (s.schemes.includes('https') ? 'https' : s.schemes[0])) || 'https';
      const base = (s.basePath || '').replace(/\/+$/, '');
      if (!s.host) return { url: 'https://api.example.com' + base, from: 'missing' };
      return { url: scheme + '://' + s.host + base, from: 'spec' };
    }
    const srv = Array.isArray(s.servers) && s.servers.find(x => isObj(x) && x.url);
    if (!srv) return { url: 'https://api.example.com', from: 'missing' };
    let url = String(srv.url).replace(/\{([^}]+)\}/g, (m, name) => {
      const v = isObj(srv.variables) && isObj(srv.variables[name]) ? srv.variables[name] : null;
      return v && v.default !== undefined ? String(v.default) : (v && Array.isArray(v.enum) ? String(v.enum[0]) : name);
    });
    url = url.replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(url)) {
      if (url.startsWith('//')) return { url: 'https:' + url, from: 'spec' };
      return { url: 'https://api.example.com' + (url.startsWith('/') ? url : '/' + url).replace(/\/+$/, ''), from: 'relative' };
    }
    return { url, from: 'spec' };
  }

  function mergedParams(ctx, item, op) {
    const map = new Map();
    for (const raw of [].concat(item.parameters || [], op.parameters || [])) {
      const p = deref(ctx, raw);
      if (!isObj(p) || !p.name || !p.in) continue;
      map.set(p.in + ':' + p.name, p);
    }
    return [...map.values()];
  }

  function expectedStatus(op) {
    const codes = Object.keys(op.responses || {});
    const exact = codes.filter(c => /^2\d\d$/.test(c)).sort();
    if (exact.length) return { code: +exact[0], all: exact.map(Number) };
    return { code: null };   // 2XX, default or nothing documented: check for any 2xx
  }

  function acceptFor(ctx, op) {
    if (ctx.v2) {
      const p = op.produces || ctx.spec.produces || [];
      return p.find(x => /json/i.test(x)) || p[0] || null;
    }
    const st = Object.keys(op.responses || {}).filter(c => /^2/.test(c)).sort()[0] || 'default';
    const r = deref(ctx, (op.responses || {})[st]);
    const types = isObj(r) && isObj(r.content) ? Object.keys(r.content) : [];
    return types.find(x => /json/i.test(x)) || types[0] || null;
  }

  // ---------------------------------------------------------------- security

  function securityFor(ctx, op) {
    const req = Array.isArray(op.security) ? op.security : (Array.isArray(ctx.spec.security) ? ctx.spec.security : []);
    if (!req.length) return [];
    const first = req.find(r => isObj(r) && Object.keys(r).length) ;
    if (!first) return [];                                   // {} means auth is optional
    const defs = ctx.v2 ? (ctx.spec.securityDefinitions || {}) : ((ctx.spec.components || {}).securitySchemes || {});
    return Object.keys(first).map(name => ({ name, scheme: deref(ctx, defs[name]) })).filter(x => isObj(x.scheme));
  }

  // ---------------------------------------------------------------- convert

  function convert(input, options) {
    const o = Object.assign({}, DEFAULTS, options || {});
    const result = { script: '', warnings: [], info: [], env: [], operations: [], selected: [], error: null };
    let spec;
    try { spec = parseSpec(input, o.yaml); }
    catch (e) { result.error = e.message; return result; }
    const ctx = makeCtx(spec, result.warnings);

    let ops;
    try { ops = listOperations(spec); }
    catch (e) { result.error = e.message; return result; }
    result.operations = ops.map(({ id, method, path, tag, summary, deprecated }) => ({ id, method, path, tag, summary, deprecated }));
    if (!ops.length) { result.error = "The 'paths' in this definition have no operations (get, post, …), so there's nothing to test."; return result; }

    let chosen;
    if (Array.isArray(o.include)) {
      const want = new Set(o.include);
      chosen = ops.filter(x => want.has(x.id));
    } else {
      chosen = ops.filter(x => x.method === 'GET');
      if (!chosen.length) {
        chosen = ops.slice();
        result.warnings.push("This API has no GET operations, so every operation is included. They change data: run the test against a test environment only.");
      }
    }
    result.selected = chosen.map(x => x.id);
    if (!chosen.length) { result.error = 'No operations selected. Tick at least one in the list.'; return result; }

    const srv = serverUrl(ctx, o.baseUrl);
    if (srv.from === 'missing') result.warnings.push(`The definition doesn't say where the API runs (no ${ctx.v2 ? "'host'" : "'servers'"}), so the script uses ${srv.url}. Type your real base URL in the options, or run with -e BASE_URL=https://your-api.`);
    if (srv.from === 'relative') result.warnings.push(`The server URL in the definition is relative, so the script uses ${srv.url}. Type your real base URL in the options, or run with -e BASE_URL=https://your-api.`);

    // ---- security schemes used by the chosen operations → init-context constants
    const usedEnv = new Set(['BASE_URL']);
    const schemeCode = new Map();     // scheme name → { header?, query?, cookie?, note }
    const initLines = [];
    const needs = { check: o.checks, group: true, sleep: o.thinkTime > 0, encoding: false };
    let bearerCount = 0;
    function codeForScheme(name, s) {
      if (schemeCode.has(name)) return schemeCode.get(name);
      let c = null;
      const type = String(s.type || '').toLowerCase();
      const httpScheme = String(s.scheme || '').toLowerCase();
      if ((type === 'http' && httpScheme === 'basic') || type === 'basic') {
        const u = envName(name + '_USERNAME', usedEnv), p = envName(name + '_PASSWORD', usedEnv);
        initLines.push(`// ${name}: HTTP basic auth. Pass -e ${u}=... -e ${p}=... (use a test account).`);
        initLines.push(`const ${u} = __ENV.${u} || '';`, `const ${p} = __ENV.${p} || '';`);
        needs.encoding = true;
        result.env.push({ name: u, about: name + ' user name' }, { name: p, about: name + ' password' });
        c = { header: ['Authorization', { code: `'Basic ' + encoding.b64encode(\`\${${u}}:\${${p}}\`)` }] };
      } else if (type === 'apikey') {
        const v = envName(s.name || name, usedEnv);
        initLines.push(`// ${name}: API key sent in the ${s.in || 'header'} "${s.name}". Pass -e ${v}=...`);
        initLines.push(`const ${v} = __ENV.${v} || '';`);
        result.env.push({ name: v, about: name + ' API key' });
        if (s.in === 'query') c = { query: [s.name, v] };
        else if (s.in === 'cookie') c = { cookie: [s.name, v] };
        else c = { header: [s.name || 'X-API-Key', { code: v }] };
      } else if ((type === 'http' && httpScheme === 'bearer') || type === 'oauth2' || type === 'openidconnect' || type === 'http') {
        const v = envName(bearerCount++ ? name + '_TOKEN' : 'TOKEN', usedEnv);
        if (type === 'oauth2' || type === 'openidconnect') {
          initLines.push(`// ${name}: ${type === 'oauth2' ? 'OAuth 2' : 'OpenID Connect'}. Get an access token for a test user (for example with the`);
          initLines.push(`// client credentials flow, once in setup()) and pass it with -e ${v}=... Tokens expire: keep runs shorter than the token's lifetime.`);
        } else {
          initLines.push(`// ${name}: bearer token. Pass -e ${v}=... (a token for a test user).`);
        }
        initLines.push(`const ${v} = __ENV.${v} || '';`);
        result.env.push({ name: v, about: name + ' access token' });
        c = { header: ['Authorization', { code: `\`Bearer \${${v}}\`` }] };
      } else {
        warnOnce(ctx, `Security scheme "${name}" (${type || 'unknown type'}) isn't supported: add its credentials by hand.`);
      }
      schemeCode.set(name, c);
      return c;
    }

    // ---- build each request
    const groups = new Map();         // tag → [code blocks]
    const fileInits = new Map();
    let unsafeCount = 0, pathParamCount = 0, generatedBodies = 0, deprecated = 0;
    const usedChecks = new Map();

    chosen.forEach(entry => {
      const { op, item, method, path } = entry;
      const lines = [];
      const params = mergedParams(ctx, item, op);
      if (UNSAFE.includes(method)) unsafeCount++;
      if (op.deprecated) { deprecated++; lines.push('// Deprecated in the API definition.'); }
      if (entry.summary) lines.push('// ' + entry.summary);

      // path
      const urlParts = [{ code: 'BASE_URL' }];
      let usedPathParam = false;
      const pathOut = path.replace(/\{([^}]+)\}/g, (m, name) => {
        const p = params.find(x => x.in === 'path' && x.name === name);
        usedPathParam = true;
        const v = p ? paramValue(ctx, p) : undefined;
        return encodeURIComponent(asString(v === undefined || v === '' ? 1 : v));
      });
      if (usedPathParam) pathParamCount++;
      urlParts.push(pathOut);

      // query
      const q = [], qCode = [], optionalQ = [];
      const headers = [];
      const cookies = [];
      for (const p of params) {
        if (p.in === 'query') {
          const v = paramValue(ctx, p);
          const pair = (val) => encodeURIComponent(p.name) + '=' + encodeURIComponent(asString(val));
          const enc = Array.isArray(v) ? v.map(pair).join('&') : pair(v === undefined ? '' : v);
          if (p.required) q.push(enc); else optionalQ.push(enc);
        } else if (p.in === 'header') {
          const low = p.name.toLowerCase();
          if (['accept', 'content-type', 'authorization'].includes(low)) continue;
          if (!p.required && p.example === undefined && p['x-example'] === undefined) continue;
          headers.push([p.name, asString(paramValue(ctx, p))]);
        } else if (p.in === 'cookie') {
          if (p.required) cookies.push(p.name + '=' + encodeURIComponent(asString(paramValue(ctx, p))));
        }
      }

      // security
      for (const { name, scheme } of securityFor(ctx, op)) {
        const c = codeForScheme(name, scheme);
        if (!c) continue;
        if (c.header) headers.push(c.header);
        if (c.query) qCode.push(c.query);
        if (c.cookie) cookies.push({ code: c.cookie });
      }

      if (q.length || qCode.length) {
        let first = true;
        const sep = () => { const s = first ? '?' : '&'; first = false; return s; };
        for (const pair of q) urlParts.push(sep() + pair);
        for (const [n, v] of qCode) { urlParts.push(sep() + encodeURIComponent(n) + '='); urlParts.push({ code: `encodeURIComponent(${v})` }); }
      }
      if (o.optionalQuery && optionalQ.length) lines.push('// Optional query parameters: ' + oneLine(optionalQ.join('&'), 160));

      // accept
      const accept = acceptFor(ctx, op);
      if (accept) headers.unshift(['Accept', accept]);

      // body
      let bodyCode = null, contentType = null;
      const body = requestBody(ctx, op, params);
      if (body) {
        if (body.generated) generatedBodies++;
        if (body.kind === 'json') {
          contentType = body.type;
          bodyCode = `JSON.stringify(${jsValue(body.value, '')})`;
        } else if (body.kind === 'form') {
          contentType = null;  // k6 sets application/x-www-form-urlencoded for objects
          bodyCode = jsValue(stringifyFields(body.value), '');
        } else if (body.kind === 'multipart') {
          const fields = [];
          for (const [k, v] of Object.entries(body.value || {})) {
            if (isObj(v) && v.__file) {
              let fv = fileInits.get(k);
              if (!fv) {
                fv = 'file_' + k.replace(/[^A-Za-z0-9_]/g, '_');
                fileInits.set(k, fv);
                initLines.push(`// TODO: put a test file next to the script for the "${k}" upload field.`);
                initLines.push(`const ${fv} = open('./${k.replace(/[^A-Za-z0-9_.-]/g, '_')}.bin', 'b');`);
              }
              fields.push(`  ${key(k)}: http.file(${fv}, ${lit(k + '.bin')}),`);
            } else fields.push(`  ${key(k)}: ${lit(asString(v))},`);
          }
          bodyCode = fields.length ? `{\n${fields.join('\n')}\n}` : '{}';
          lines.push('// Sent as multipart/form-data (k6 does this when a field is an http.file).');
        } else {
          contentType = body.type;
          bodyCode = lit(asString(body.value));
        }
      }
      if (contentType) headers.push(['Content-Type', contentType]);
      if (cookies.length) {
        const parts = [];
        cookies.forEach((c, i) => {
          if (i) parts.push('; ');
          if (typeof c === 'string') parts.push(c); else { parts.push(c.code[0] + '='); parts.push({ code: c.code[1] }); }
        });
        headers.push(['Cookie', parts.some(x => typeof x !== 'string') ? { code: tpl(parts) } : parts.join('')]);
      }

      // params object
      const pp = [];
      if (headers.length) pp.push('headers: {\n' + headers.map(([k, v]) => `    ${key(k)}: ${typeof v === 'string' ? lit(v) : v.code},`).join('\n') + '\n  }');
      pp.push(`tags: { name: ${lit(path)} }`);
      const paramsCode = `{\n  ${pp.join(',\n  ')},\n}`;
      const urlCode = urlParts.length === 1 ? 'BASE_URL' : tpl(urlParts);

      let call; const args = [urlCode];
      if (method === 'GET' || method === 'HEAD') { call = method === 'GET' ? 'http.get' : 'http.head'; args.push(paramsCode); }
      else if (['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method)) {
        call = { POST: 'http.post', PUT: 'http.put', PATCH: 'http.patch', DELETE: 'http.del', OPTIONS: 'http.options' }[method];
        args.push(bodyCode != null ? bodyCode : 'null', paramsCode);
      } else { call = 'http.request'; args.unshift(lit(method)); args.push(bodyCode != null ? bodyCode : 'null', paramsCode); }
      lines.push(`res = ${call}(${args.join(', ')});`);

      if (o.checks) {
        const st = expectedStatus(op);
        let name = method + ' ' + path + (st.code ? ' is ' + st.code : ' is 2xx');
        const n = (usedChecks.get(name) || 0) + 1; usedChecks.set(name, n);
        if (n > 1) name += ` (#${n})`;
        const cond = st.code ? (st.all.length > 1 ? `[${st.all.join(', ')}].includes(r.status)` : `r.status === ${st.code}`) : 'r.status >= 200 && r.status < 300';
        lines.push(`check(res, { ${lit(name)}: (r) => ${cond} });`);
      }
      if (o.thinkTime > 0) lines.push(`sleep(${+o.thinkTime});`);

      if (!groups.has(entry.tag)) groups.set(entry.tag, []);
      groups.get(entry.tag).push(lines.join('\n'));
    });

    // ---- assemble
    const info = spec.info || {};
    const out = [];
    out.push('// Generated by the OpenAPI to k6 converter: https://pawansinha.com.au/tools/openapi-to-k6/');
    if (info.title) out.push(`// API: ${oneLine(info.title, 80)}${info.version ? ' (version ' + oneLine(info.version, 20) + ')' : ''}, ${chosen.length} of ${ops.length} operation${ops.length === 1 ? '' : 's'}`);
    out.push(`// Run it with: k6 run${result.env.map(e => ` -e ${e.name}=...`).join('')} script.js`);
    out.push('// Point it at another environment with: k6 run -e BASE_URL=https://staging.example.com script.js');
    out.push("import http from 'k6/http';");
    out.push(`import { ${['check', 'group', 'sleep'].filter(n => needs[n]).join(', ')} } from 'k6';`);
    if (needs.encoding) out.push("import encoding from 'k6/encoding';");
    out.push('');
    out.push(`const BASE_URL = __ENV.BASE_URL || ${lit(srv.url)};`);
    if (initLines.length) { out.push(''); out.push(...initLines); }
    out.push('');
    out.push('export const options = {');
    if (o.model === 'open') {
      const pre = Math.max(1, Math.round(+o.preAllocatedVUs || 1));
      const max = Math.max(pre, Math.round(+o.maxVUs || pre));
      out.push('  // Open model: k6 starts new iterations at a fixed rate, whether or not the system keeps up.');
      out.push("  // VUs needed ≈ rate × iteration duration (Little's Law). If k6 reports dropped_iterations, raise maxVUs.");
      out.push('  scenarios: {');
      out.push('    load: {');
      out.push("      executor: 'constant-arrival-rate',");
      out.push(`      rate: ${num(o.rate, 1)},`);
      out.push(`      timeUnit: ${lit(o.timeUnit || '1s')},`);
      out.push(`      duration: ${lit(o.duration || '1m')},`);
      out.push(`      preAllocatedVUs: ${pre},`);
      out.push(`      maxVUs: ${max},`);
      out.push('    },');
      out.push('  },');
    } else {
      out.push('  // Closed model: each virtual user runs every request below in a loop.');
      out.push(`  vus: ${Math.max(1, Math.round(+o.vus || 1))},`);
      out.push(`  duration: ${lit(o.duration || '1m')},`);
    }
    const th = [];
    if (+o.p95 > 0) th.push(`    http_req_duration: ['p(95)<${num(o.p95, 500)}'],`);
    if (o.errorRate !== '' && o.errorRate != null && +o.errorRate >= 0 && !isNaN(+o.errorRate)) {
      th.push(+o.errorRate === 0 ? "    http_req_failed: ['rate==0']," : `    http_req_failed: ['rate<${+(+o.errorRate / 100).toFixed(6)}'],`);
    }
    if (o.checks) th.push("    checks: ['rate>0.99'],");
    if (th.length) { out.push('  thresholds: {'); out.push(...th); out.push('  },'); }
    out.push('};');
    out.push('');
    out.push('export default function () {');
    out.push('  let res;');
    const blocks = [];
    for (const [tag, reqs] of groups) {
      blocks.push(`group(${lit(tag)}, function () {\n${indent(reqs.join('\n\n'), '  ')}\n});`);
    }
    out.push(indent(blocks.join('\n\n'), '  '));
    out.push('}');
    out.push('');
    result.script = out.join('\n');

    // ---- messages
    if (unsafeCount) result.warnings.push(`${unsafeCount} of the selected operation${unsafeCount === 1 ? '' : 's'} (POST, PUT, PATCH or DELETE) change data, and a load test repeats them thousands of times. Run it against a test environment with test data, never production.`);
    if (pathParamCount) result.info.push(`${pathParamCount} request${pathParamCount === 1 ? ' uses' : 's use'} example values for path parameters (like /pets/1). Replace them with IDs that exist in your test environment, or load a list of IDs from a CSV with SharedArray.`);
    if (generatedBodies) result.info.push(`${generatedBodies} request bod${generatedBodies === 1 ? 'y was' : 'ies were'} generated from the schema because the definition has no example. Check the values make sense for your API.`);
    if (deprecated) result.info.push(`${deprecated} selected operation${deprecated === 1 ? ' is' : 's are'} marked deprecated in the definition.`);
    if (fileInits.size) result.warnings.push('Some requests upload a file. Put a test file next to the script before you run it (see the TODO lines at the top).');
    result.info.push(`Converted ${chosen.length} of ${ops.length} operation${ops.length === 1 ? '' : 's'} into ${groups.size} group${groups.size === 1 ? '' : 's'} (one per tag).`);
    return result;
  }

  function stringifyFields(v) {
    const out = {};
    for (const [k, x] of Object.entries(isObj(v) ? v : {})) out[k] = asString(x);
    return out;
  }

  // → { kind: 'json'|'form'|'multipart'|'text', type, value, generated } or null
  function requestBody(ctx, op, params) {
    if (ctx.v2) {
      const bodyP = params.find(p => p.in === 'body');
      const consumes = op.consumes || ctx.spec.consumes || [];
      if (bodyP) {
        const type = consumes.find(x => /json/i.test(x)) || consumes[0] || 'application/json';
        let value, generated = false;
        if (bodyP['x-example'] !== undefined) value = bodyP['x-example'];
        else if (isObj(bodyP['x-examples'])) value = Object.values(bodyP['x-examples'])[0];
        else { value = sample(ctx, bodyP.schema, { forRequest: true }); generated = !(isObj(bodyP.schema) && bodyP.schema.example !== undefined); }
        if (/json/i.test(type)) return { kind: 'json', type, value: value === undefined ? {} : value, generated };
        return { kind: 'text', type, value: typeof value === 'string' ? value : JSON.stringify(value), generated };
      }
      const formP = params.filter(p => p.in === 'formData');
      if (formP.length) {
        const multipart = consumes.some(x => /multipart/i.test(x)) || formP.some(p => p.type === 'file');
        const value = {};
        formP.forEach(p => { value[p.name] = p.type === 'file' ? { __file: true } : paramValue(ctx, p); });
        return { kind: multipart ? 'multipart' : 'form', type: multipart ? 'multipart/form-data' : 'application/x-www-form-urlencoded', value, generated: false };
      }
      return null;
    }
    const rb = deref(ctx, op.requestBody);
    if (!isObj(rb) || !isObj(rb.content)) return null;
    const types = Object.keys(rb.content);
    const type = types.find(t => /^application\/(.+\+)?json/i.test(t)) || types.find(t => /x-www-form-urlencoded/i.test(t)) ||
      types.find(t => /multipart\//i.test(t)) || types[0];
    if (!type) return null;
    const media = rb.content[type] || {};
    let value, generated = false;
    if (media.example !== undefined) value = media.example;
    else if (isObj(media.examples) && Object.keys(media.examples).length) {
      const ex = deref(ctx, Object.values(media.examples)[0]);
      value = isObj(ex) && 'value' in ex ? ex.value : undefined;
    }
    const multipart = /multipart\//i.test(type);
    if (value === undefined) { value = sample(ctx, media.schema, { forRequest: true, allowFile: multipart }); generated = true; }
    if (/json/i.test(type)) return { kind: 'json', type, value: value === undefined ? {} : value, generated };
    if (/x-www-form-urlencoded/i.test(type)) return { kind: 'form', type, value, generated };
    if (multipart) return { kind: 'multipart', type, value, generated };
    if (isObj(media.schema) && (media.schema.format === 'binary' || media.schema.type === 'string' && media.schema.format === 'byte')) {
      ctx.warnings.push(`${op.operationId || 'An operation'} sends a raw file (${type}): the script sends a placeholder string, replace it with open('./file', 'b').`);
      return { kind: 'text', type, value: 'placeholder', generated };
    }
    return { kind: 'text', type, value: typeof value === 'string' ? value : (value === undefined ? '' : JSON.stringify(value)), generated };
  }

  // ---------------------------------------------------------------- examples

  const EXAMPLES = {
    openapi3: `openapi: 3.0.3
info:
  title: Bookshop API
  version: 1.4.0
servers:
  - url: https://{env}.bookshop.example.com/v1
    variables:
      env:
        default: api
        enum: [api, staging]
security:
  - bearerAuth: []
paths:
  /books:
    get:
      tags: [Books]
      summary: Search the catalogue
      parameters:
        - name: q
          in: query
          required: true
          schema: { type: string, example: performance }
        - name: limit
          in: query
          schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
      responses:
        '200':
          description: Matching books
          content:
            application/json:
              schema:
                type: array
                items: { $ref: '#/components/schemas/Book' }
    post:
      tags: [Books]
      summary: Add a book
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/NewBook' }
      responses:
        '201': { description: Created }
  /books/{bookId}:
    parameters:
      - name: bookId
        in: path
        required: true
        schema: { type: string, format: uuid }
    get:
      tags: [Books]
      summary: Get one book
      responses:
        '200':
          description: The book
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Book' }
        '404': { description: Not found }
  /cart:
    get:
      tags: [Cart]
      summary: Show the cart
      responses:
        '200': { description: The cart }
  /cart/items:
    post:
      tags: [Cart]
      summary: Add a book to the cart
      requestBody:
        content:
          application/json:
            example: { bookId: 3fa85f64-5717-4562-b3fc-2c963f66afa6, quantity: 1 }
      responses:
        '200': { description: Updated cart }
  /health:
    get:
      tags: [Ops]
      summary: Health check
      security: []
      responses:
        default: { description: OK }
components:
  securitySchemes:
    bearerAuth: { type: http, scheme: bearer, bearerFormat: JWT }
  schemas:
    NewBook:
      type: object
      required: [title, author, price]
      properties:
        title: { type: string, example: Systems Performance }
        author: { type: string, example: Brendan Gregg }
        price: { type: number, minimum: 0, example: 89.95 }
        tags: { type: array, items: { type: string, example: linux } }
    Book:
      allOf:
        - $ref: '#/components/schemas/NewBook'
        - type: object
          properties:
            id: { type: string, format: uuid, readOnly: true }
            published: { type: string, format: date }
`,
    swagger2: JSON.stringify({
      swagger: '2.0',
      info: { title: 'Swagger Petstore', version: '1.0.7' },
      host: 'petstore.swagger.io', basePath: '/v2', schemes: ['https', 'http'],
      consumes: ['application/json'], produces: ['application/json'],
      securityDefinitions: { api_key: { type: 'apiKey', name: 'api_key', in: 'header' } },
      paths: {
        '/pet/findByStatus': { get: { tags: ['pet'], summary: 'Finds pets by status', operationId: 'findPetsByStatus',
          parameters: [{ name: 'status', in: 'query', required: true, type: 'array', items: { type: 'string', enum: ['available', 'pending', 'sold'] }, collectionFormat: 'multi' }],
          responses: { 200: { description: 'successful operation', schema: { type: 'array', items: { $ref: '#/definitions/Pet' } } }, 400: { description: 'Invalid status value' } } } },
        '/pet/{petId}': {
          get: { tags: ['pet'], summary: 'Find pet by ID', operationId: 'getPetById', security: [{ api_key: [] }],
            parameters: [{ name: 'petId', in: 'path', required: true, type: 'integer', format: 'int64' }],
            responses: { 200: { description: 'successful operation', schema: { $ref: '#/definitions/Pet' } }, 404: { description: 'Pet not found' } } },
          delete: { tags: ['pet'], summary: 'Deletes a pet', operationId: 'deletePet', security: [{ api_key: [] }],
            parameters: [{ name: 'petId', in: 'path', required: true, type: 'integer', format: 'int64' }], responses: { 400: { description: 'Invalid ID supplied' } } } },
        '/pet': { post: { tags: ['pet'], summary: 'Add a new pet to the store', operationId: 'addPet',
          parameters: [{ in: 'body', name: 'body', required: true, schema: { $ref: '#/definitions/Pet' } }], responses: { 405: { description: 'Invalid input' } } } },
        '/store/inventory': { get: { tags: ['store'], summary: 'Returns pet inventories by status', operationId: 'getInventory', security: [{ api_key: [] }],
          responses: { 200: { description: 'successful operation', schema: { type: 'object', additionalProperties: { type: 'integer' } } } } } },
        '/store/order/{orderId}': { get: { tags: ['store'], summary: 'Find purchase order by ID', operationId: 'getOrderById',
          parameters: [{ name: 'orderId', in: 'path', required: true, type: 'integer', minimum: 1, maximum: 10 }],
          responses: { 200: { description: 'successful operation' }, 404: { description: 'Order not found' } } } },
        '/user/login': { get: { tags: ['user'], summary: 'Logs user into the system', operationId: 'loginUser',
          parameters: [{ name: 'username', in: 'query', required: true, type: 'string' }, { name: 'password', in: 'query', required: true, type: 'string' }],
          responses: { 200: { description: 'successful operation' } } } },
      },
      definitions: {
        Category: { type: 'object', properties: { id: { type: 'integer', format: 'int64' }, name: { type: 'string', example: 'Dogs' } } },
        Tag: { type: 'object', properties: { id: { type: 'integer', format: 'int64' }, name: { type: 'string' } } },
        Pet: { type: 'object', required: ['name', 'photoUrls'], properties: {
          id: { type: 'integer', format: 'int64' }, category: { $ref: '#/definitions/Category' }, name: { type: 'string', example: 'doggie' },
          photoUrls: { type: 'array', items: { type: 'string' } }, tags: { type: 'array', items: { $ref: '#/definitions/Tag' } },
          status: { type: 'string', description: 'pet status in the store', enum: ['available', 'pending', 'sold'] } } },
      },
    }, null, 2),
  };

  const api = { convert, parseSpec, listOperations: (input, yaml) => listOperations(input, yaml).map(({ id, method, path, tag, summary, deprecated }) => ({ id, method, path, tag, summary, deprecated })), sample: (spec, schema, opts) => sample(makeCtx(spec, []), schema, opts || {}), DEFAULTS, EXAMPLES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OpenApiToK6 = api;
})(typeof window !== 'undefined' ? window : this);
