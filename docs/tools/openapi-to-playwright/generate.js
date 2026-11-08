/* OpenAPI / Swagger → Playwright API tests. Runs in the browser (window.OpenApiToPlaywright) and in Node (module.exports),
   so it can be unit-tested. Nothing is sent anywhere: all parsing happens on the visitor's machine.

   Parsing, $ref, allOf, sample values, servers and security come from the OpenAPI → k6 converter
   (docs/tools/openapi-to-k6/convert.js), which must be loaded first in the browser (window.OpenApiToK6).
   Output: one api.spec.ts for @playwright/test that uses the `request` fixture, with a test.describe block per tag. */
(function (root) {
  'use strict';

  const K = (typeof module !== 'undefined' && module.exports)
    ? require('../openapi-to-k6/convert.js')
    : root.OpenApiToK6;
  if (!K || !K.makeCtx) throw new Error('Load /tools/openapi-to-k6/convert.js before generate.js.');

  const { isObj, lit, tpl, key, envName, asString, oneLine } = K;
  const UNSAFE = ['POST', 'PUT', 'PATCH', 'DELETE'];
  const MAX_LOOP = 10;

  const DEFAULTS = {
    baseUrl: '',          // fallback base URL written into the spec (BASE_URL still wins at run time)
    include: null,        // array of operation ids ("GET /pets/{id}"); null = every operation
    negative: true,       // missing field, wrong type, no auth, unknown id
    dataDriven: true,     // one test per enum / example value
    shape: true,          // check required response fields exist
    yaml: null,           // function (text) → object, for YAML input
  };

  const RESERVED = new Set(('request res json body test expect field item value BASE_URL break case catch class const continue debugger ' +
    'default delete do else enum export extends false finally for function if import in instanceof let new null return super switch ' +
    'this throw true try typeof var void while with yield await implements interface package private protected public static type of')
    .split(' '));

  // ---------------------------------------------------------------- code helpers

  // Raw code inside a value tree, written as-is by toCode().
  function Raw(code) { this.code = code; }
  const raw = c => new Raw(c);

  function toCode(v, pad, multi) {
    pad = pad || '';
    if (v instanceof Raw) return v.code;
    if (v === undefined) return 'undefined';
    if (v === null) return 'null';
    if (typeof v === 'number') return isFinite(v) ? String(v) : 'null';
    if (typeof v === 'boolean') return String(v);
    if (typeof v === 'string') return lit(v);
    const inner = pad + '  ';
    if (Array.isArray(v)) {
      if (!v.length) return '[]';
      const items = v.map(x => toCode(x, inner));
      const one = '[' + items.join(', ') + ']';
      if (one.length + pad.length <= 100 && !one.includes('\n')) return one;
      return '[\n' + items.map(i => inner + i).join(',\n') + ',\n' + pad + ']';
    }
    const entries = Object.entries(v).filter(([, x]) => x !== undefined);
    if (!entries.length) return '{}';
    const items = entries.map(([k, x]) => key(k) + ': ' + toCode(x, inner));
    const one = '{ ' + items.join(', ') + ' }';
    if (!multi && one.length + pad.length <= 90 && !one.includes('\n')) return one;
    return '{\n' + items.map(i => inner + i).join(',\n') + ',\n' + pad + '}';
  }

  function ident(name, used) {
    let s = String(name).replace(/[^A-Za-z0-9_$]+(.)?/g, (m, c) => (c ? c.toUpperCase() : '')).replace(/^[^A-Za-z_$]+/, '');
    if (!s) s = 'value';
    s = s[0].toLowerCase() + s.slice(1);
    if (RESERVED.has(s) || (used && used.has(s))) s += 'Value';
    return s;
  }

  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

  // ---------------------------------------------------------------- schema helpers

  function resolve(ctx, s) {
    let n = s, hops = 0;
    while (isObj(n) && typeof n.$ref === 'string' && hops++ < 20) n = K.getRef(ctx, n.$ref);
    if (isObj(n) && Array.isArray(n.allOf)) n = K.mergeAllOf(ctx, n, []);
    return isObj(n) ? n : null;
  }

  function typeOf(s) {
    if (!isObj(s)) return null;
    let t = s.type;
    if (Array.isArray(t)) t = t.find(x => x !== 'null') || t[0];
    if (!t) {
      if (s.properties || s.additionalProperties) t = 'object';
      else if (s.items) t = 'array';
      else if (Array.isArray(s.enum) && s.enum.length) t = typeof s.enum[0] === 'number' ? 'number' : (typeof s.enum[0] === 'string' ? 'string' : null);
    }
    return t || null;
  }

  function wrongValue(t) {
    return { string: 12345, integer: 'not-a-number', number: 'not-a-number', boolean: 'not-a-boolean', array: 'not-an-array', object: 'not-an-object' }[t];
  }

  // The schema a parameter's value follows: Swagger 2.0 keeps it on the parameter itself.
  function paramSchema(ctx, p) {
    if (p.schema) return resolve(ctx, p.schema);
    if (isObj(p.content)) { const m = Object.values(p.content)[0]; return isObj(m) ? resolve(ctx, m.schema) : null; }
    return p;
  }

  // Values worth one test each: an enum, or several named examples.
  function loopValues(ctx, p) {
    const s = paramSchema(ctx, p);
    const items = s && s.items ? resolve(ctx, s.items) : null;
    const en = (s && Array.isArray(s.enum) && s.enum) || (items && Array.isArray(items.enum) && items.enum);
    if (en) {
      const vals = en.filter(v => v !== null && typeof v !== 'object');
      if (vals.length >= 2) return { values: vals, from: 'enum', array: typeOf(s) === 'array' };
    }
    if (isObj(p.examples) && Object.keys(p.examples).length >= 2) {
      const vals = Object.values(p.examples).map(e => K.deref(ctx, e)).filter(e => isObj(e) && e.value !== undefined && typeof e.value !== 'object').map(e => e.value);
      if (vals.length >= 2) return { values: vals, from: 'examples', array: false };
    }
    return null;
  }

  // 2xx response: { code, all, contentType, schema }
  function successResponse(ctx, op) {
    const st = K.expectedStatus(op);
    const responses = isObj(op.responses) ? op.responses : {};
    const codes = Object.keys(responses);
    const pickCode = st.code ? String(st.code) : (codes.find(c => /^2xx$/i.test(c)) || null);
    const r = pickCode ? K.deref(ctx, responses[pickCode]) : null;
    let contentType = null, schema = null;
    if (isObj(r)) {
      if (ctx.v2) {
        if (r.schema) {
          const produces = op.produces || ctx.spec.produces || ['application/json'];
          contentType = produces.find(x => /json/i.test(x)) || produces[0] || null;
          schema = r.schema;
        }
      } else if (isObj(r.content)) {
        const types = Object.keys(r.content);
        contentType = types.find(x => /json/i.test(x)) || types[0] || null;
        if (contentType && isObj(r.content[contentType])) schema = r.content[contentType].schema || null;
      }
    }
    if (contentType) contentType = contentType.split(';')[0].trim();
    if (contentType && /\*/.test(contentType)) contentType = null;
    return { code: st.code, all: st.all || [], contentType, schema: schema ? resolve(ctx, schema) : null };
  }

  // Required response fields to check: { array: bool, fields: [...] } or null.
  function shapeOf(ctx, schema) {
    if (!schema) return null;
    const t = typeOf(schema);
    const fieldsOf = s => {
      if (!isObj(s) || !Array.isArray(s.required)) return [];
      const props = s.properties || {};
      return s.required.filter(f => { const ps = resolve(ctx, props[f]); return !(ps && ps.writeOnly); });
    };
    if (t === 'array') {
      const item = resolve(ctx, schema.items);
      const fields = fieldsOf(item);
      return { array: true, fields };
    }
    if (t === 'object') { const fields = fieldsOf(schema); return fields.length ? { array: false, fields } : null; }
    return null;
  }

  // ---------------------------------------------------------------- generate

  function generate(input, options) {
    const o = Object.assign({}, DEFAULTS, options || {});
    const result = { spec: '', config: CONFIG, command: 'npx playwright test --reporter=html', env: [], warnings: [], info: [],
      operations: [], selected: [], counts: { tests: 0, positive: 0, negative: 0, dataDriven: 0, describes: 0 }, error: null };
    let spec;
    try { spec = K.parseSpec(input, o.yaml); }
    catch (e) { result.error = e.message; return result; }
    const ctx = K.makeCtx(spec, result.warnings);

    let ops;
    try { ops = K.operations(spec); }
    catch (e) { result.error = e.message; return result; }
    result.operations = ops.map(({ id, method, path, tag, summary, deprecated }) => ({ id, method, path, tag, summary, deprecated }));
    if (!ops.length) { result.error = "The 'paths' in this definition have no operations (get, post, …), so there's nothing to test."; return result; }

    const chosen = Array.isArray(o.include) ? ops.filter(x => new Set(o.include).has(x.id)) : ops.slice();
    result.selected = chosen.map(x => x.id);
    if (!chosen.length) { result.error = 'No operations selected. Tick at least one in the list.'; return result; }

    const srv = K.serverUrl(ctx, o.baseUrl);
    if (srv.from === 'missing') result.warnings.push(`The definition doesn't say where the API runs (no ${ctx.v2 ? "'host'" : "'servers'"}), so the tests fall back to ${srv.url}. Set BASE_URL when you run them.`);
    if (srv.from === 'relative') result.warnings.push(`The server URL in the definition is relative, so the tests fall back to ${srv.url}. Set BASE_URL when you run them.`);

    // ---- auth: one environment variable (or pair) per security scheme
    const usedEnv = new Set(['BASE_URL']);
    const schemeAuth = new Map();     // scheme name → { header: [name, Raw] } | { query: [name, Raw] } | { cookie: [name, envVar] } | null
    const top = [];                   // constants after BASE_URL
    let bearers = 0, basics = 0;
    function authFor(name, s) {
      if (schemeAuth.has(name)) return schemeAuth.get(name);
      let a = null;
      const type = String(s.type || '').toLowerCase(), scheme = String(s.scheme || '').toLowerCase();
      if ((type === 'http' && scheme === 'basic') || type === 'basic') {
        const first = !basics++;
        const u = first ? (usedEnv.add('API_USER'), 'API_USER') : envName(name + '_USER', usedEnv);
        const p = first ? (usedEnv.add('API_PASS'), 'API_PASS') : envName(name + '_PASS', usedEnv);
        const c = envName(first ? 'BASIC_AUTH' : name + '_BASIC_AUTH', usedEnv);
        top.push(`// ${name}: HTTP basic auth. Set ${u} and ${p} to a test account.`,
          `const ${u} = process.env.${u} || '';`, `const ${p} = process.env.${p} || '';`,
          `const ${c} = 'Basic ' + Buffer.from(\`\${${u}}:\${${p}}\`).toString('base64');`);
        result.env.push({ name: u, about: name + ' user name' }, { name: p, about: name + ' password' });
        a = { header: ['Authorization', raw(c)] };
      } else if (type === 'apikey') {
        const v = envName(s.name || name, usedEnv);
        top.push(`// ${name}: API key sent in the ${s.in || 'header'} "${s.name}". Set ${v}.`, `const ${v} = process.env.${v} || '';`);
        result.env.push({ name: v, about: name + ' API key' });
        if (s.in === 'query') a = { query: [s.name, raw(v)] };
        else if (s.in === 'cookie') a = { cookie: [s.name, v] };
        else a = { header: [s.name || 'X-API-Key', raw(v)] };
      } else if ((type === 'http' && scheme === 'bearer') || type === 'oauth2' || type === 'openidconnect' || type === 'http') {
        const v = bearers++ ? envName(name + '_TOKEN', usedEnv) : (usedEnv.add('API_TOKEN'), 'API_TOKEN');
        top.push(type === 'oauth2' || type === 'openidconnect'
          ? `// ${name}: ${type === 'oauth2' ? 'OAuth 2' : 'OpenID Connect'}. Get an access token for a test user and set ${v}.`
          : `// ${name}: bearer token. Set ${v} to a token for a test user.`, `const ${v} = process.env.${v} || '';`);
        result.env.push({ name: v, about: name + ' access token' });
        a = { header: ['Authorization', raw('`Bearer ${' + v + '}`')] };
      } else {
        result.warnings.push(`Security scheme "${name}" (${type || 'unknown type'}) isn't supported: add its credentials by hand.`);
      }
      schemeAuth.set(name, a);
      return a;
    }

    // ---- tests per operation
    const groups = new Map();         // tag → [test code]
    const C = result.counts;
    let pathIds = 0, generatedBodies = 0, unsafe = 0, deprecated = 0, truncated = 0;

    for (const entry of chosen) {
      const { op, item, method, path } = entry;
      const params = K.mergedParams(ctx, item, op);
      const label = method + ' ' + path;
      const tests = [];
      if (UNSAFE.includes(method)) unsafe++;
      if (op.deprecated) deprecated++;
      const responses = isObj(op.responses) ? op.responses : {};
      const documented = c => Object.prototype.hasOwnProperty.call(responses, String(c));

      // security
      const req = Array.isArray(op.security) ? op.security : (Array.isArray(spec.security) ? spec.security : []);
      const authOptional = req.some(r => isObj(r) && !Object.keys(r).length);
      const auths = K.securityFor(ctx, op).map(({ name, scheme }) => authFor(name, scheme)).filter(Boolean);

      // parameters → base request pieces
      const pathVals = {}, queryPs = [], headerPairs = [], cookiePairs = [];
      for (const p of params) {
        if (p.in === 'path') {
          const v = K.paramValue(ctx, p);
          pathVals[p.name] = v === undefined || v === '' ? 1 : v;
        } else if (p.in === 'query' && p.required) {
          queryPs.push({ p, value: K.paramValue(ctx, p) });
        } else if (p.in === 'header') {
          const low = p.name.toLowerCase();
          if (['accept', 'content-type', 'authorization'].includes(low)) continue;
          if (!p.required && p.example === undefined && p['x-example'] === undefined) continue;
          headerPairs.push([p.name, asString(K.paramValue(ctx, p))]);
        } else if (p.in === 'cookie' && p.required) {
          cookiePairs.push(p.name + '=' + encodeURIComponent(asString(K.paramValue(ctx, p))));
        }
      }
      if (Object.keys(pathVals).length) pathIds++;

      const accept = K.acceptFor(ctx, op);
      const body = K.requestBody(ctx, op, params);
      if (body && body.generated) generatedBodies++;
      const bodySchema = body ? resolve(ctx, bodySchemaOf(ctx, op, params, body.type)) : null;

      // Build the call. ov: { noAuth, path: {name: Raw|value}, query: {name: [[name, v]]}, body: value }
      function call(ov) {
        ov = ov || {};
        const parts = [raw('BASE_URL')];
        let last = 0;
        path.replace(/\{([^}]+)\}/g, (m, name, at) => {
          parts.push(path.slice(last, at)); last = at + m.length;
          const v = ov.path && name in ov.path ? ov.path[name] : (name in pathVals ? pathVals[name] : 1);
          parts.push(v instanceof Raw ? { code: 'encodeURIComponent(String(' + v.code + '))' } : encodeURIComponent(asString(v)));
          return m;
        });
        parts.push(path.slice(last));
        const url = tpl(parts.filter(x => x !== '').map(x => (x instanceof Raw ? { code: x.code } : x)));

        let pairs = [];
        for (const { p, value } of queryPs) {
          if (ov.query && ov.query[p.name]) pairs.push(...ov.query[p.name]);
          else pairs.push(...queryPairs(ctx, p, value));
        }
        const headers = {};
        if (accept) headers.Accept = accept;
        headerPairs.forEach(([k, v]) => { headers[k] = v; });
        const cookies = cookiePairs.slice();
        if (!ov.noAuth) for (const a of auths) {
          if (a.header) headers[a.header[0]] = a.header[1];
          if (a.query) pairs.push(a.query);
          if (a.cookie) cookies.push({ name: a.cookie[0], env: a.cookie[1] });
        }
        if (cookies.length) {
          const tp = [];
          cookies.forEach((c, i) => { if (i) tp.push('; '); if (typeof c === 'string') tp.push(c); else { tp.push(c.name + '='); tp.push({ code: c.env }); } });
          headers.Cookie = tp.every(x => typeof x === 'string') ? tp.join('') : raw(tpl(tp));
        }

        const opts = {};
        if (Object.keys(headers).length) opts.headers = headers;
        if (pairs.length) {
          const names = pairs.map(x => x[0]);
          if (new Set(names).size === names.length) { opts.params = {}; pairs.forEach(([k, v]) => { opts.params[k] = v; }); }
          else opts.params = raw('new URLSearchParams(' + toCode(pairs.map(([k, v]) => [k, v instanceof Raw ? raw('String(' + v.code + ')') : asString(v)]), '    ') + ')');
        }
        if (body) {
          const value = 'body' in ov ? ov.body : body.value;
          if (body.kind === 'json') {
            if (!/^application\/json$/i.test(body.type)) headers['Content-Type'] = body.type;
            opts.data = value;
          } else if (body.kind === 'form') {
            const f = {};
            for (const [k, v] of Object.entries(isObj(value) ? value : {})) f[k] = v instanceof Raw ? v : asString(v);
            opts.form = f;
          } else if (body.kind === 'multipart') {
            const f = {};
            for (const [k, v] of Object.entries(isObj(value) ? value : {})) {
              f[k] = isObj(v) && v.__file
                ? raw(`{ name: ${lit(k + '.bin')}, mimeType: 'application/octet-stream', buffer: Buffer.from('test file') }`)
                : (v instanceof Raw ? v : asString(v));
            }
            opts.multipart = f;
          } else {
            headers['Content-Type'] = body.type;
            opts.data = value instanceof Raw ? value : asString(value);
          }
          if (!Object.keys(headers).length) delete opts.headers; else opts.headers = headers;
        }
        const m = method.toLowerCase();
        const fn = ['get', 'post', 'put', 'patch', 'delete', 'head'].includes(m) ? m : 'fetch';
        if (fn === 'fetch') opts.method = method;
        if (!Object.keys(opts).length) return `const res = await request.${fn}(${url});`;
        const short = `const res = await request.${fn}(${url}, ${toCode(opts, '')});`;
        if (short.length <= 110 && !short.includes('\n')) return short;
        return `const res = await request.${fn}(${url}, ${toCode(opts, '', true)});`;
      }

      // ---- positive test (data-driven when there's an enum or several examples)
      const succ = successResponse(ctx, op);
      const statusText = succ.code ? (succ.all.length > 1 ? succ.all.join(' or ') : String(succ.code)) : '2xx';
      const positiveChecks = [];
      if (succ.code && succ.all.length > 1) positiveChecks.push(`expect(${toCode(succ.all)}).toContain(res.status());`);
      else if (succ.code) positiveChecks.push(`expect(res.status()).toBe(${succ.code});`);
      else positiveChecks.push('expect(res.status()).toBeGreaterThanOrEqual(200);', 'expect(res.status()).toBeLessThan(300);');
      const noBody = method === 'HEAD' || succ.code === 204;
      if (succ.contentType && !noBody) positiveChecks.push(`expect(res.headers()['content-type']).toContain(${lit(succ.contentType)});`);
      const shape = o.shape && !noBody && succ.contentType && /json/i.test(succ.contentType) ? shapeOf(ctx, succ.schema) : null;
      if (shape) {
        positiveChecks.push('const json = await res.json();');
        if (shape.array) {
          positiveChecks.push('expect(Array.isArray(json)).toBe(true);');
          if (shape.fields.length) positiveChecks.push(`for (const item of json.slice(0, 5)) {`, `  for (const field of ${toCode(shape.fields)}) expect(item).toHaveProperty(field);`, '}');
        } else {
          positiveChecks.push(`for (const field of ${toCode(shape.fields)}) expect(json).toHaveProperty(field);`);
        }
      }

      let loop = null;
      if (o.dataDriven) {
        for (const p of params) {
          if (p.in !== 'query' && p.in !== 'path') continue;
          if (p.in === 'query' && !p.required) continue;
          const lv = loopValues(ctx, p);
          if (lv) { loop = { kind: p.in, p, ...lv }; break; }
        }
        if (!loop && body && body.kind === 'json' && isObj(body.value) && bodySchema && isObj(bodySchema.properties)) {
          for (const [name, ps0] of Object.entries(bodySchema.properties)) {
            const ps = resolve(ctx, ps0);
            if (!ps || ps.readOnly || !Array.isArray(ps.enum)) continue;
            const vals = ps.enum.filter(v => v !== null && typeof v !== 'object');
            if (vals.length >= 2) { loop = { kind: 'body', name, values: vals, from: 'enum' }; break; }
          }
        }
      }

      if (loop) {
        if (loop.values.length > MAX_LOOP) { truncated++; loop.values = loop.values.slice(0, MAX_LOOP); }
        const pname = loop.kind === 'body' ? loop.name : loop.p.name;
        const v = ident(pname);
        const ov = {};
        if (loop.kind === 'path') ov.path = { [pname]: raw(v) };
        else if (loop.kind === 'query') ov.query = { [pname]: [[pname, raw(v)]] };
        else { const b = clone(body.value); b[pname] = raw(v); ov.body = b; }
        const where = loop.kind === 'body' ? 'body field' : (loop.kind === 'path' ? 'path parameter' : 'query parameter');
        tests.push([
          `// One test per ${loop.from === 'enum' ? 'allowed value' : 'documented example'} of the ${where} "${pname}".`,
          `for (const ${v} of ${toCode(loop.values)}) {`,
          `  test(${tpl([label + ' with ' + pname + '=', { code: v }, ' returns ' + statusText])}, async ({ request }) => {`,
          ...indentLines([call(ov), ...positiveChecks], '    '),
          '  });',
          '}',
        ].join('\n'));
        C.dataDriven += loop.values.length; C.positive += loop.values.length;
      } else {
        tests.push(testCode(`${label} returns ${statusText}`, [call(), ...positiveChecks], entry.summary));
        C.positive++;
      }

      if (o.negative) {
        // validation status: the code the definition documents for bad input, or any 4xx
        const valCodes = [400, 422].filter(documented);
        const fourxx = (codes, why) => codes.length === 1 ? [`expect(res.status()).toBe(${codes[0]});`]
          : codes.length > 1 ? [`expect(${toCode(codes)}).toContain(res.status());`]
            : [...(why ? ['// ' + why] : []), 'expect(res.status()).toBeGreaterThanOrEqual(400);', 'expect(res.status()).toBeLessThan(500);'];

        // required body fields that we actually send
        const reqFields = body && body.kind === 'json' && isObj(body.value) && bodySchema && Array.isArray(bodySchema.required)
          ? bodySchema.required.filter(f => {
            const ps = resolve(ctx, (bodySchema.properties || {})[f]);
            return !(ps && ps.readOnly) && Object.prototype.hasOwnProperty.call(body.value, f);
          }) : [];

        if (reqFields.length) {
          const f = reqFields[0];
          const b = clone(body.value); delete b[f];
          tests.push(testCode(`${label} rejects a body without "${f}"`, [
            `// "${f}" is required, so the API should refuse the request.`, call({ body: b }), ...fourxx(valCodes)]));
          C.negative++;
        }

        // wrong type: a required body field first, then a required query or path parameter that isn't a string
        let wrong = null;
        for (const f of reqFields) {
          const t = typeOf(resolve(ctx, (bodySchema.properties || {})[f]));
          if (wrongValue(t) !== undefined) { const b = clone(body.value); b[f] = wrongValue(t); wrong = { name: f, t, ov: { body: b }, where: 'body field' }; break; }
        }
        if (!wrong) {
          for (const p of params) {
            if (!(p.in === 'query' && p.required) && p.in !== 'path') continue;
            const t = typeOf(paramSchema(ctx, p));
            if (!t || t === 'string' || t === 'array' || t === 'object') continue;
            const bad = wrongValue(t);
            wrong = p.in === 'path'
              ? { name: p.name, t, ov: { path: { [p.name]: bad } }, where: 'path parameter' }
              : { name: p.name, t, ov: { query: { [p.name]: [[p.name, bad]] } }, where: 'query parameter' };
            break;
          }
        }
        if (wrong) {
          tests.push(testCode(`${label} rejects "${wrong.name}" with the wrong type`, [
            `// The ${wrong.where} "${wrong.name}" should be ${/^[aeiou]/.test(wrong.t) ? 'an' : 'a'} ${wrong.t}. This sends ${toCode(wrongValue(wrong.t))}.`,
            call(wrong.ov), ...fourxx(valCodes)]));
          C.negative++;
        }

        // no auth
        if (auths.length && !authOptional) {
          const codes = [401, 403].filter(documented);
          tests.push(testCode(`${label} without auth returns ${codes.length === 1 ? codes[0] : '401 or 403'}`, [
            call({ noAuth: true }),
            codes.length === 1 ? `expect(res.status()).toBe(${codes[0]});` : 'expect([401, 403]).toContain(res.status());']));
          C.negative++;
        }

        // unknown id in the path
        const idParam = params.filter(p => p.in === 'path' && /(id|uuid)$/i.test(p.name)).pop();
        if (idParam) {
          const s = paramSchema(ctx, idParam);
          const t = typeOf(s);
          const missing = s && s.format === 'uuid' ? '00000000-0000-0000-0000-000000000000'
            : (t === 'integer' || t === 'number') ? 999999999 : 'does-not-exist-0';
          tests.push(testCode(`${label} returns 404 for an unknown ${idParam.name}`, [
            `// ${toCode(missing)} should not exist in your test data. Change it if it does.`,
            call({ path: { [idParam.name]: missing } }),
            ...(documented(404) ? ['expect(res.status()).toBe(404);'] : fourxx([], "The definition doesn't document a 404, so this accepts any 4xx."))]));
          C.negative++;
        }
      }

      if (!groups.has(entry.tag)) groups.set(entry.tag, []);
      groups.get(entry.tag).push(...tests);
    }

    C.tests = C.positive + C.negative;
    C.describes = groups.size;

    // ---- assemble
    const info = spec.info || {};
    const envLine = result.env.map(e => e.name + '=...').join(' ');
    const out = [];
    out.push('// Generated by the OpenAPI to Playwright generator: https://pawansinha.com.au/tools/openapi-to-playwright/');
    if (info.title) out.push(`// API: ${oneLine(info.title, 80)}${info.version ? ' (version ' + oneLine(info.version, 20) + ')' : ''}. ${chosen.length} of ${ops.length} operation${ops.length === 1 ? '' : 's'}, ${C.tests} test${C.tests === 1 ? '' : 's'}.`);
    out.push('// Run it against a test environment, never production:');
    out.push(`//   BASE_URL=https://staging.example.com ${envLine ? envLine + ' ' : ''}npx playwright test --reporter=html`);
    out.push('// These tests check status codes, content types and required fields from the definition.');
    out.push("// They don't know your business rules: add assertions for the values that matter to you.");
    out.push("import { test, expect } from '@playwright/test';");
    out.push('');
    out.push(`const BASE_URL = (process.env.BASE_URL || ${lit(srv.url)}).replace(/\\/+$/, '');`);
    if (top.length) out.push(...top);
    out.push('');
    const blocks = [];
    for (const [tag, list] of groups) blocks.push(`test.describe(${lit(tag)}, () => {\n${indentLines(list.join('\n\n').split('\n'), '  ').join('\n')}\n});`);
    out.push(blocks.join('\n\n'));
    out.push('');
    result.spec = out.join('\n');

    // ---- messages
    if (unsafe) result.warnings.push(`${unsafe} of the selected operation${unsafe === 1 ? '' : 's'} (POST, PUT, PATCH or DELETE) change data. Run the tests against a test environment with test data, never production.`);
    if (pathIds) result.info.push(`${pathIds} operation${pathIds === 1 ? ' uses' : 's use'} example values in the path (like /pets/1). Replace them with IDs that exist in your test data.`);
    if (generatedBodies) result.info.push(`${generatedBodies} request bod${generatedBodies === 1 ? 'y was' : 'ies were'} built from the schema because the definition has no example. Check the values make sense for your API.`);
    if (deprecated) result.info.push(`${deprecated} selected operation${deprecated === 1 ? ' is' : 's are'} marked deprecated in the definition.`);
    if (truncated) result.info.push(`Long value lists were cut to the first ${MAX_LOOP} values to keep the test count sensible.`);
    result.info.push(`Generated ${C.tests} test${C.tests === 1 ? '' : 's'} (${C.positive} positive, ${C.negative} negative${C.dataDriven ? ', ' + C.dataDriven + ' of them data-driven' : ''}) in ${groups.size} describe block${groups.size === 1 ? '' : 's'} (one per tag).`);
    return result;
  }

  function bodySchemaOf(ctx, op, params, type) {
    if (ctx.v2) { const b = params.find(p => p.in === 'body'); return b ? b.schema : null; }
    const rb = K.deref(ctx, op.requestBody);
    if (!isObj(rb) || !isObj(rb.content) || !type) return null;
    const media = rb.content[type];
    return isObj(media) ? media.schema : null;
  }

  function queryPairs(ctx, p, value) {
    const scalar = v => (v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : v));
    if (Array.isArray(value)) {
      const multi = ctx.v2 ? p.collectionFormat === 'multi' : p.explode !== false;
      if (multi) return value.map(x => [p.name, scalar(x)]);
      const sep = ctx.v2 ? ({ ssv: ' ', tsv: '\t', pipes: '|' }[p.collectionFormat] || ',') : ({ spaceDelimited: ' ', pipeDelimited: '|' }[p.style] || ',');
      return [[p.name, value.map(asString).join(sep)]];
    }
    return [[p.name, scalar(value)]];
  }

  function indentLines(lines, pad) { return [].concat(...lines.map(l => l.split('\n'))).map(l => (l ? pad + l : l)); }

  function testCode(title, body, summary) {
    return [
      ...(summary ? ['// ' + summary] : []),
      `test(${lit(title)}, async ({ request }) => {`,
      ...indentLines(body, '  '),
      '});',
    ].join('\n');
  }

  const CONFIG = `import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',            // put api.spec.ts in this folder
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1,                    // the tests create and change data, so run them one at a time
  reporter: [['list'], ['html', { open: 'never' }]],
});
`;

  const api = {
    generate, DEFAULTS, CONFIG, EXAMPLES: K.EXAMPLES, parseSpec: K.parseSpec,
    listOperations: K.listOperations,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OpenApiToPlaywright = api;
})(typeof window !== 'undefined' ? window : this);
