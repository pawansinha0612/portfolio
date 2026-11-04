/* Postman collection → k6 converter. Runs in the browser (window.PostmanToK6) and in Node (module.exports), so it can be unit-tested.
   Nothing is sent anywhere: all parsing happens on the visitor's machine.

   Accepts a Postman Collection v2.0 or v2.1 export (JSON), and optionally a Postman environment export.
   Folders become k6 groups, {{variables}} are resolved at run time from a VARS object that -e can override,
   common pm.test() assertions become k6 checks, and pm.environment.set() calls that read the response are kept
   so requests can pass tokens and IDs to each other. Produces a k6 (v1.x) script. */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- code generation helpers

  function lit(s) {
    return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,
        c => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0')) + "'";
  }

  function key(k) {
    return /^[A-Za-z_$][\w$]*$/.test(k) ? k : lit(k);
  }

  function envRef(name) {
    return /^[A-Za-z_$][\w$]*$/.test(name) ? '__ENV.' + name : '__ENV[' + lit(name) + ']';
  }

  function envName(name, used) {
    let base = String(name).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'SECRET';
    if (/^\d/.test(base)) base = '_' + base;
    let n = base, i = 2;
    while (used.has(n)) n = base + '_' + i++;
    used.add(n);
    return n;
  }

  function indent(text, pad) {
    return text.split('\n').map(l => (l ? pad + l : l)).join('\n');
  }

  function oneLine(s) {
    return String(s == null ? '' : s).replace(/[\r\n\u2028\u2029]+/g, ' ').trim();
  }

  function num(v, d) { const n = +v; return isFinite(n) && n > 0 ? n : d; }

  // Replace ids in the path so many URLs share one name in the results (avoids high-cardinality metrics)
  function templatePath(path) {
    return path.split('/').map(seg => {
      if (!seg) return seg;
      if (/^\d+$/.test(seg)) return '{id}';
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return '{uuid}';
      if (/^[0-9a-f]{16,}$/i.test(seg)) return '{id}';
      if (/^[A-Za-z0-9_-]{20,}$/.test(seg) && /\d/.test(seg) && /[A-Za-z]/.test(seg)) return '{token}';
      return seg;
    }).join('/');
  }

  // k6 (Go) stores response headers in canonical form: content-type → Content-Type
  function canonHeader(name) {
    return String(name).split('-').map(p => p ? p[0].toUpperCase() + p.slice(1).toLowerCase() : p).join('-');
  }

  const VAR_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;
  const hasVar = (t) => /\{\{[^{}]+\}\}/.test(String(t));
  const ALWAYS_DROP = /^(content-length|host|connection|keep-alive|transfer-encoding|te|expect)$/i;
  const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|x-api-key|api-key|apikey|x-auth-token|x-access-token|x-csrf-token|x-xsrf-token|x-amz-security-token|x-goog-api-key|ocp-apim-subscription-key)$/i;
  const SECRET_VAR = /(token|secret|password|passwd|pwd|api[-_]?key|apikey|auth|session|cookie|signature|credential|private)/i;

  // Postman dynamic variables we can reproduce in k6 (plain JavaScript, no extra modules)
  const DYNAMIC = {
    $guid: '() => uuid()',
    $randomUUID: '() => uuid()',
    $timestamp: '() => String(Math.floor(Date.now() / 1000))',
    $isoTimestamp: '() => new Date().toISOString()',
    $randomInt: '() => String(Math.floor(Math.random() * 1001))',
    $randomBoolean: "() => String(Math.random() < 0.5)",
    $randomAlphaNumeric: '() => rnd(1)',
    $randomEmail: "() => 'user.' + rnd(8) + '@example.com'",
    $randomExampleEmail: "() => 'user.' + rnd(8) + '@example.com'",
    $randomUserName: "() => 'user_' + rnd(8)",
    $randomFirstName: "() => pick(['Alex', 'Sam', 'Priya', 'Wei', 'Maria', 'Liam', 'Aisha', 'Noah'])",
    $randomLastName: "() => pick(['Smith', 'Nguyen', 'Patel', 'Chen', 'Garcia', 'Brown', 'Khan', 'Wilson'])",
    $randomFullName: "() => DYNAMIC.$randomFirstName() + ' ' + DYNAMIC.$randomLastName()",
    $randomPhoneNumber: "() => '04' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0')",
    $randomWord: "() => pick(['alpha', 'bravo', 'delta', 'echo', 'kilo', 'lima', 'oscar', 'tango'])",
    $randomColor: "() => pick(['red', 'green', 'blue', 'black', 'white', 'orange'])",
    $randomCity: "() => pick(['Melbourne', 'Sydney', 'Brisbane', 'Perth', 'Adelaide', 'Hobart'])",
    $randomPrice: '() => (Math.random() * 1000).toFixed(2)',
    $randomIP: "() => [1, 2, 3, 4].map(() => Math.floor(Math.random() * 255)).join('.')",
  };
  const DYNAMIC_DEPS = { $randomFullName: ['$randomFirstName', '$randomLastName'] };

  // ---------------------------------------------------------------- reading the Postman JSON

  function parseJson(text, what) {
    const t = String(text || '').replace(/^\uFEFF/, '').trim();
    if (!t) return { empty: true };
    try { return { value: JSON.parse(t) }; }
    catch (e) {
      let where = '';
      const m = /position (\d+)/.exec(e.message), l = /line (\d+)/.exec(e.message);
      if (m) where = ` (around line ${t.slice(0, +m[1]).split('\n').length})`;
      else if (l) where = ` (around line ${l[1]})`;
      // V8 quotes a chunk of the input in its message: drop it, it's noise
      const why = String(e.message).replace(/,?\s*"[\s\S]*" is not valid JSON/, '').replace(/^JSON\.parse: /, '').replace(/\s*in JSON at position \d+.*$/, '').replace(/ at line \d+ column \d+.*$/, '');
      return { error: `That ${what} isn't valid JSON${where}: ${why}. Export it again and paste the whole file, from the first { to the last }.` };
    }
  }

  // v2.1 stores auth/variables as [{key, value}], v2.0 sometimes as a plain object
  function kv(list) {
    const out = {};
    if (Array.isArray(list)) list.forEach(x => { if (x && x.key != null && !x.disabled) out[x.key] = x.value; });
    else if (list && typeof list === 'object') Object.keys(list).forEach(k => { out[k] = list[k]; });
    return out;
  }

  function authParams(auth) {
    return kv(auth && auth[auth.type]);
  }

  function scriptText(events, listen) {
    if (!Array.isArray(events)) return '';
    return events.filter(e => e && e.listen === listen && e.script && !e.disabled).map(e => {
      const ex = e.script.exec;
      return Array.isArray(ex) ? ex.join('\n') : String(ex || '');
    }).join('\n').replace(/\r\n?/g, '\n');
  }

  function headerList(h) {
    if (!h) return [];
    if (typeof h === 'string') {
      return h.split(/\r?\n/).map(l => l.trim()).filter(Boolean).filter(l => !l.startsWith('//')).map(l => {
        const i = l.indexOf(':');
        return i < 0 ? null : { key: l.slice(0, i).trim(), value: l.slice(i + 1).trim() };
      }).filter(Boolean);
    }
    if (Array.isArray(h)) return h.filter(x => x && x.key && !x.disabled).map(x => ({ key: String(x.key), value: x.value == null ? '' : String(x.value) }));
    return [];
  }

  // Postman URL (string or object) → one URL string that may contain {{variables}}
  function buildUrl(url, notes) {
    if (url == null) return '';
    let raw, query = null, vars = [];
    if (typeof url === 'string') raw = url;
    else {
      raw = url.raw;
      if (!raw) {
        const host = Array.isArray(url.host) ? url.host.join('.') : (url.host || '');
        const path = Array.isArray(url.path) ? url.path.join('/') : (url.path || '');
        raw = (url.protocol ? url.protocol + '://' : '') + host + (url.port ? ':' + url.port : '') + (path ? '/' + path.replace(/^\//, '') : '');
      }
      if (Array.isArray(url.query)) query = url.query.filter(q => q && q.key != null && !q.disabled);
      if (Array.isArray(url.variable)) vars = url.variable.filter(x => x && x.key);
    }
    raw = String(raw || '').trim().replace(/#.*$/, '');
    if (query) {
      raw = raw.replace(/\?.*$/, '');
      if (query.length) raw += '?' + query.map(q => q.value == null ? String(q.key) : q.key + '=' + q.value).join('&');
    }
    // path variables: /users/:id with url.variable [{key: 'id', value: '42'}]
    const [base, qs] = splitQuery(raw);
    let path = base;
    vars.forEach(v => {
      const val = v.value == null || v.value === '' ? '{{' + v.key + '}}' : String(v.value);
      path = path.replace(new RegExp(':' + v.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=/|$)', 'g'), () => val);
    });
    raw = path + qs;
    if (raw && !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !/^\{\{/.test(raw)) {
      notes.push('The URL had no http:// or https://, so http:// was added, as Postman does.');
      raw = 'http://' + raw;
    }
    // spaces are fine in Postman but not in a real URL (leave {{variables}} alone)
    raw = raw.split(/(\{\{[^{}]*\}\})/).map((p, i) => (i % 2 ? p : p.replace(/ /g, '%20'))).join('');
    return raw;
  }

  function splitQuery(u) {
    const i = u.indexOf('?');
    return i < 0 ? [u, ''] : [u.slice(0, i), u.slice(i)];
  }

  function nameTag(url) {
    let u = url.replace(/[?#].*$/, '');
    u = u.replace(/^[a-z][\w+.-]*:\/\/[^/]*/i, '');
    if (/^\{\{/.test(u)) u = u.replace(/^\{\{[^{}]*\}\}[^/]*/, '');
    u = u.replace(VAR_RE, (m, n) => '{' + n + '}');
    return templatePath(u) || '/';
  }

  // ---------------------------------------------------------------- Postman tests → k6 checks

  const STATUS_WORDS = {
    ok: ['r.status === 200', 'status is 200'],
    success: ['r.status >= 200 && r.status < 300', 'status is 2xx'],
    created: ['r.status === 201', 'status is 201'],
    accepted: ['r.status === 202', 'status is 202'],
    badRequest: ['r.status === 400', 'status is 400'],
    unauthorized: ['r.status === 401', 'status is 401'],
    unauthorised: ['r.status === 401', 'status is 401'],
    forbidden: ['r.status === 403', 'status is 403'],
    notFound: ['r.status === 404', 'status is 404'],
    rateLimited: ['r.status === 429', 'status is 429'],
    info: ['r.status >= 100 && r.status < 200', 'status is 1xx'],
    redirection: ['r.status >= 300 && r.status < 400', 'status is 3xx'],
    clientError: ['r.status >= 400 && r.status < 500', 'status is 4xx'],
    serverError: ['r.status >= 500', 'status is 5xx'],
    error: ['r.status >= 400', 'status is 4xx or 5xx'],
  };

  function parseLiteral(s) {
    s = s.trim();
    if (/^-?\d+(\.\d+)?$/.test(s)) return s;
    if (/^(true|false|null)$/.test(s)) return s;
    let m = /^'((?:[^'\\]|\\.)*)'$/.exec(s) || /^"((?:[^"\\]|\\.)*)"$/.exec(s);
    if (m) return lit(m[1].replace(/\\(['"\\])/g, '$1'));
    return null;
  }

  // .data.items[0].id → data.items.0.id (gjson syntax used by k6's res.json(selector))
  function jsonSelector(chain) {
    if (!chain) return '';
    if (!/^(?:\.[A-Za-z_$][\w$]*|\[\d+\]|\[(['"])[A-Za-z_$][\w$]*\1\])+$/.test(chain)) return null;
    return chain.replace(/\[(['"])([\w$]+)\1\]/g, '.$2').replace(/\[(\d+)\]/g, '.$1').replace(/^\./, '');
  }

  function convertTests(src, reqName) {
    const out = { checks: [], sets: [], unconverted: [], hasStatus: false };
    if (!src.trim()) return out;
    const lines = src.split('\n');

    // names that hold the parsed JSON body: var jsonData = pm.response.json();
    const aliases = ['pm\\.response\\.json\\(\\)'];
    lines.forEach(l => {
      const m = /^\s*(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:pm\.response\.json\(\)|JSON\.parse\(\s*(?:responseBody|pm\.response\.text\(\))\s*\))\s*;?\s*$/.exec(l);
      if (m) aliases.push(m[1].replace(/\$/g, '\\$'));
    });
    const A = '(?:' + aliases.join('|') + ')';
    const CHAIN = '((?:\\.[A-Za-z_$][\\w$]*|\\[\\d+\\]|\\[[\'"][A-Za-z_$][\\w$]*[\'"]\\])*)';
    const LITERAL = '(\'(?:[^\'\\\\]|\\\\.)*\'|"(?:[^"\\\\]|\\\\.)*"|-?\\d+(?:\\.\\d+)?|true|false|null)';
    const STR = '([\'"])((?:(?!\\1).)*)\\1';   // always the first group in the patterns below

    let current = null;          // name of the pm.test() we're inside
    const add = (code, label, isStatus) => {
      out.checks.push({ name: current || label, code });
      if (isStatus) out.hasStatus = true;
    };

    lines.forEach(raw => {
      const line = raw.trim();
      let hit = false;
      if (!line || /^\/\//.test(line) || /^\/\*.*\*\/$/.test(line)) return;
      let m = /pm\.test\(\s*(['"`])((?:(?!\1).)*)\1/.exec(line);
      if (m) { current = m[2]; hit = /^pm\.test\(\s*(['"`]).*?\1\s*,\s*(?:function\s*\(\s*\)|\(\s*\)\s*=>)\s*\{?\s*$/.test(line); }
      if (/^\}\s*\)\s*;?$/.test(line)) { current = null; return; }
      if (/^\}\s*;?$/.test(line)) return;
      if (/^\s*(?:var|let|const)\s+[A-Za-z_$][\w$]*\s*=\s*(?:pm\.response\.json\(\)|JSON\.parse\(\s*(?:responseBody|pm\.response\.text\(\))\s*\))\s*;?\s*$/.test(line)) return;

      let r;
      // status
      const stRe = /pm\.response\.to\.have\.status\(\s*(\d{3})\s*\)/g;
      while ((r = stRe.exec(line))) { add(`r.status === ${r[1]}`, `status is ${r[1]}`, true); hit = true; }
      const codeRe = /pm\.expect\(\s*pm\.response\.(?:code|status)\s*\)\.to\.(?:be\.)?(?:eql|equal|eq|equals)\(\s*(\d{3})\s*\)/g;
      while ((r = codeRe.exec(line))) { add(`r.status === ${r[1]}`, `status is ${r[1]}`, true); hit = true; }
      const oneOf = /pm\.expect\(\s*pm\.response\.(?:code|status)\s*\)\.to\.be\.oneOf\(\s*\[([\d\s,]+)\]\s*\)/g;
      while ((r = oneOf.exec(line))) {
        const codes = r[1].split(',').map(s => s.trim()).filter(Boolean);
        add(`[${codes.join(', ')}].includes(r.status)`, `status is ${codes.join(' or ')}`, true); hit = true;
      }
      const words = /pm\.response\.to\.(?:be|have)\.(ok|success|created|accepted|badRequest|unauthori[sz]ed|forbidden|notFound|rateLimited|info|redirection|clientError|serverError|error|json|withBody)\b/g;
      while ((r = words.exec(line))) {
        if (r[1] === 'json') add(`String(r.headers['Content-Type'] || '').includes('json')`, 'response is JSON', false);
        else if (r[1] === 'withBody') add(`r.body != null && r.body.length > 0`, 'response has a body', false);
        else add(STATUS_WORDS[r[1]][0], STATUS_WORDS[r[1]][1], true);
        hit = true;
      }
      // legacy: tests["Status code is 200"] = responseCode.code === 200;
      m = /^tests\[\s*(['"])((?:(?!\1).)*)\1\s*\]\s*=\s*(.+?);?$/.exec(line);
      if (m) {
        const expr = m[3];
        let c;
        if ((c = /^responseCode\.code\s*===?\s*(\d{3})$/.exec(expr))) { out.checks.push({ name: m[2], code: `r.status === ${c[1]}` }); out.hasStatus = true; hit = true; }
        else if ((c = /^responseTime\s*<\s*(\d+)$/.exec(expr))) { out.checks.push({ name: m[2], code: `r.timings.duration < ${c[1]}` }); hit = true; }
        else if ((c = /^responseBody\.has\(\s*(['"])((?:(?!\1).)*)\1\s*\)$/.exec(expr))) { out.checks.push({ name: m[2], code: `String(r.body).includes(${lit(c[2])})` }); hit = true; }
      }
      // response time
      const rt = /pm\.expect\(\s*pm\.response\.responseTime\s*\)\.to\.be\.(?:below|lessThan|lt|under)\(\s*(\d+)\s*\)/g;
      while ((r = rt.exec(line))) { add(`r.timings.duration < ${r[1]}`, `response time is under ${r[1]} ms`, false); hit = true; }
      // headers
      const hh = new RegExp('pm\\.response\\.to\\.have\\.header\\(\\s*' + STR + '\\s*(?:,\\s*' + LITERAL.replace('(', '(?:') + '\\s*)?\\)', 'g');
      while ((r = hh.exec(line))) {
        const h = canonHeader(r[2]);
        const valM = new RegExp('header\\(\\s*' + STR + '\\s*,\\s*' + LITERAL + '\\s*\\)').exec(r[0]);
        if (valM) add(`r.headers[${lit(h)}] === ${parseLiteral(valM[3])}`, `${h} header is ${valM[3].replace(/^['"]|['"]$/g, '')}`, false);
        else add(`r.headers[${lit(h)}] !== undefined`, `has a ${h} header`, false);
        hit = true;
      }
      const hg = new RegExp('pm\\.expect\\(\\s*pm\\.response\\.headers\\.get\\(\\s*' + STR + '\\s*\\)\\s*\\)\\.to\\.(?:be\\.)?(include|contain|contains|eql|equal|eq)\\(\\s*' + LITERAL + '\\s*\\)', 'g');
      while ((r = hg.exec(line))) {
        const h = canonHeader(r[2]);
        const val = parseLiteral(r[4]);
        if (/^(include|contain|contains)$/.test(r[3])) add(`String(r.headers[${lit(h)}] || '').includes(${val})`, `${h} header includes ${r[4].replace(/^['"]|['"]$/g, '')}`, false);
        else add(`r.headers[${lit(h)}] === ${val}`, `${h} header is ${r[4].replace(/^['"]|['"]$/g, '')}`, false);
        hit = true;
      }
      // body text
      const bt = new RegExp('pm\\.expect\\(\\s*(?:pm\\.response\\.text\\(\\)|responseBody)\\s*\\)\\.to\\.(?:include|contain|have\\.string)\\(\\s*' + STR + '\\s*\\)', 'g');
      while ((r = bt.exec(line))) { add(`String(r.body).includes(${lit(r[2])})`, `body includes "${r[2]}"`, false); hit = true; }
      const bb = new RegExp('pm\\.response\\.to\\.have\\.body\\(\\s*' + STR + '\\s*\\)', 'g');
      while ((r = bb.exec(line))) { add(`String(r.body).includes(${lit(r[2])})`, `body includes "${r[2]}"`, false); hit = true; }
      // JSON values: pm.expect(jsonData.user.id).to.eql(42) / .to.exist / pm.response.to.have.jsonBody('a.b')
      const jv = new RegExp('pm\\.expect\\(\\s*' + A + CHAIN + '\\s*\\)\\.to\\.(?:be\\.)?(?:eql|equal|eq|equals)\\(\\s*' + LITERAL + '\\s*\\)', 'g');
      while ((r = jv.exec(line))) {
        const sel = jsonSelector(r[1]);
        if (sel === null || sel === '') continue;
        add(`jsonPath(r, ${lit(sel)}) === ${parseLiteral(r[2])}`, `${sel} is ${r[2].replace(/^['"]|['"]$/g, '')}`, false);
        out.usesJsonPath = true; hit = true;
      }
      const je = new RegExp('pm\\.expect\\(\\s*' + A + CHAIN + '\\s*\\)\\.to\\.(?:exist|not\\.be\\.undefined|be\\.ok|not\\.be\\.empty)\\b', 'g');
      while ((r = je.exec(line))) {
        const sel = jsonSelector(r[1]);
        if (sel === null || sel === '') continue;
        add(`jsonPath(r, ${lit(sel)}) !== undefined`, `${sel} is in the response`, false);
        out.usesJsonPath = true; hit = true;
      }
      const jb = new RegExp('pm\\.response\\.to\\.have\\.jsonBody\\(\\s*' + STR + '\\s*\\)', 'g');
      while ((r = jb.exec(line))) {
        add(`jsonPath(r, ${lit(r[2])}) !== undefined`, `${r[2]} is in the response`, false);
        out.usesJsonPath = true; hit = true;
      }

      // pm.environment.set("token", pm.response.json().token)
      m = /^(?:pm\.(?:environment|collectionVariables|globals|variables)\.set|postman\.set(?:Environment|Global)Variable)\(\s*(['"])((?:(?!\1).)+)\1\s*,\s*(.+?)\s*\)\s*;?\s*$/.exec(line);
      if (m) {
        const name = m[2], expr = m[3];
        let code = null, c;
        if ((c = new RegExp('^' + A + CHAIN + '$').exec(expr))) {
          const sel = jsonSelector(c[1]);
          if (sel) { code = `jsonPath(res, ${lit(sel)})`; out.usesJsonPath = true; }
        } else if ((c = new RegExp('^pm\\.response\\.headers\\.get\\(\\s*' + STR + '\\s*\\)$').exec(expr))) {
          code = `res.headers[${lit(canonHeader(c[2]))}]`;
        } else if ((c = new RegExp('^postman\\.getResponseHeader\\(\\s*' + STR + '\\s*\\)$').exec(expr))) {
          code = `res.headers[${lit(canonHeader(c[2]))}]`;
        } else if (parseLiteral(expr) !== null) {
          code = parseLiteral(expr);
        }
        if (code) { out.sets.push({ name, code }); hit = true; }
      }

      if (!hit) out.unconverted.push(raw.replace(/\s+$/, ''));
    });
    // drop structural leftovers so the warning only counts real code
    out.unconverted = out.unconverted.filter(l => !/^\s*[{}()\[\];,]*\s*$/.test(l));
    return out;
  }

  // ---------------------------------------------------------------- main conversion

  const DEFAULTS = {
    model: 'closed',          // 'closed' (VUs + duration) or 'open' (constant-arrival-rate)
    vus: 10, duration: '1m',
    rate: 10, timeUnit: '1s', preAllocatedVUs: 20, maxVUs: 100,
    thinkTime: 1,             // seconds between requests and at the end of each iteration (closed model)
    p95: 500,                 // ms, 0 to skip
    errorRate: 1,             // %, empty/negative to skip
    checks: true,             // convert Postman tests to checks, and check 2xx when a request has none
    groups: true,             // one k6 group per Postman folder
    nameTags: true,
    secretsToEnv: true,
    keepScripts: true,        // keep scripts that weren't converted as comments
  };

  function unwrap(v, prop) {
    return v && typeof v === 'object' && v[prop] && typeof v[prop] === 'object' && !v.item && !v.values ? v[prop] : v;
  }

  function convert(text, envText, options) {
    const o = Object.assign({}, DEFAULTS, options || {});
    const result = { script: '', warnings: [], info: [], env: [], requests: 0, folders: 0 };

    const pc = parseJson(text, 'collection');
    if (pc.empty) { result.error = 'Paste a Postman collection (JSON) first, or upload the exported file.'; return result; }
    if (pc.error) { result.error = pc.error; return result; }
    const col = unwrap(pc.value, 'collection');
    if (!col || typeof col !== 'object' || Array.isArray(col)) { result.error = "That JSON isn't a Postman collection. In Postman: right-click the collection → Export → Collection v2.1, then paste the file."; return result; }
    if (Array.isArray(col.requests) && !col.item) { result.error = 'This is an old Postman v1 collection. Import it into Postman and export it again as Collection v2.1, then paste that file here.'; return result; }
    if (Array.isArray(col.values) && !col.item) { result.error = 'This looks like a Postman environment, not a collection. Paste it in the environment box below instead, and the collection here.'; return result; }
    if (col.openapi || col.swagger) { result.error = 'This is an OpenAPI (Swagger) file, not a Postman collection. Use the OpenAPI to k6 converter: /tools/openapi-to-k6/'; return result; }
    if (col.log && col.log.entries) { result.error = 'This is a HAR file (a browser recording), not a Postman collection. Copy the requests as cURL and use the curl to k6 converter: /tools/curl-to-k6/'; return result; }
    if (!Array.isArray(col.item)) { result.error = "I couldn't find any requests (the \"item\" list) in this JSON. Export the collection from Postman as Collection v2.1 and paste the whole file."; return result; }

    // environment (optional)
    let envValues = [];
    let envLabel = '';
    const pe = parseJson(envText, 'environment');
    if (pe.error) { result.error = pe.error; return result; }
    if (pe.value) {
      const env = unwrap(pe.value, 'environment');
      if (env && Array.isArray(env.values)) { envValues = env.values.filter(x => x && x.key && x.enabled !== false); envLabel = env.name || 'environment'; }
      else if (env && Array.isArray(env.item)) { result.error = 'The environment box has a collection in it. Put the collection in the first box, and a Postman environment export (it has a "values" list) here.'; return result; }
      else { result.error = 'The environment JSON has no "values" list. In Postman: Environments → ⋯ → Export, then paste that file.'; return result; }
    }

    // ---- variables: collection, then environment on top (Postman's order of precedence)
    const vars = new Map();    // name → { value, secret, from }
    (Array.isArray(col.variable) ? col.variable : []).forEach(x => {
      if (!x || x.key == null || x.disabled) return;
      vars.set(String(x.key), { value: x.value == null ? '' : String(x.value), secret: x.type === 'secret', from: 'collection' });
    });
    envValues.forEach(x => {
      vars.set(String(x.key), { value: x.value == null ? '' : String(x.value), secret: x.type === 'secret', from: 'environment' });
    });

    const used = new Set();           // {{names}} referenced anywhere
    const dyn = new Set();            // dynamic variables used
    const setNames = new Set();       // set by pm.environment.set from responses
    const needs = { check: false, sleep: false, group: false, encoding: false, formdata: false, v: false, jsonPath: false, setVar: false };
    const usedEnv = new Set();
    const envMap = new Map();
    const secretsFound = new Set();
    const bodySecrets = new Set();
    const initLines = [];
    const fileVars = new Map();
    const unconvertedReqs = [];
    const preReqs = [];
    const unknownDynamic = new Set();
    const unsupportedAuth = new Set();
    let checkCount = 0;

    const secretEnv = (label, value) => {
      if (envMap.has(value)) return envMap.get(value);
      const n = envName(label, usedEnv);
      envMap.set(value, n);
      result.env.push({ name: n, label });
      return n;
    };

    // a string that may hold {{variables}} → JS expression
    const S = (str) => {
      str = String(str == null ? '' : str);
      let found = false;
      str.replace(VAR_RE, (m, n) => {
        found = true;
        if (n[0] === '$') { if (DYNAMIC[n]) { dyn.add(n); (DYNAMIC_DEPS[n] || []).forEach(d => dyn.add(d)); } else unknownDynamic.add(n); }
        else used.add(n);
        return m;
      });
      if (found) { needs.v = true; return `v(${lit(str)})`; }
      return lit(str);
    };
    // literal secret value (no variables) → __ENV when secretsToEnv
    const secretOr = (str, label, what) => {
      if (hasVar(str)) return S(str);
      if (!str) return lit(str);
      secretsFound.add(what);
      return o.secretsToEnv ? envRef(secretEnv(label, str)) : lit(str);
    };
    const concat = (prefix, expr) => (/^'/.test(expr) ? lit(prefix + evalLit(expr)) : `${lit(prefix)} + ${expr}`);

    const jsExpr = (val, ind) => {
      if (typeof val === 'string') return S(val);
      if (val === null || typeof val !== 'object') return JSON.stringify(val);
      const pad = ind + '  ';
      if (Array.isArray(val)) {
        if (!val.length) return '[]';
        return '[\n' + val.map(x => pad + jsExpr(x, pad) + ',').join('\n') + '\n' + ind + ']';
      }
      const ks = Object.keys(val);
      if (!ks.length) return '{}';
      return '{\n' + ks.map(k => pad + key(k) + ': ' + jsExpr(val[k], pad) + ',').join('\n') + '\n' + ind + '}';
    };

    const fileVar = (path, binary) => {
      if (fileVars.has(path)) return fileVars.get(path);
      const name = 'file' + (fileVars.size + 1);
      fileVars.set(path, name);
      const base = String(path).split(/[\\/]/).pop();
      initLines.push(`// TODO: put ${base} next to this script (open() reads files when k6 starts, not during the test)`);
      initLines.push(`const ${name} = open(${lit('./' + base)}${binary ? ", 'b'" : ''});`);
      return name;
    };

    const checkNames = new Map();
    const uniqueName = (n) => {
      const c = (checkNames.get(n) || 0) + 1;
      checkNames.set(n, c);
      return c > 1 ? `${n} (#${c})` : n;
    };

    let reqIndex = 0;
    const totalRequests = countRequests(col.item);

    // ---- one request → lines of code
    function requestCode(item, auth) {
      const req = typeof item.request === 'string' ? { url: item.request, method: 'GET' } : (item.request || {});
      const name = oneLine(item.name) || 'Request';
      const notes = [];
      const lines = [];
      const method = String(req.method || 'GET').toUpperCase();
      let url = buildUrl(req.url, notes);
      if (!url) { result.warnings.push(`"${name}" has no URL, so it was skipped.`); return null; }
      reqIndex++;

      // ---- auth (request → folder → collection)
      const headers = [];
      let a = req.auth && req.auth.type && req.auth.type !== 'inherit' ? req.auth : auth;
      if (a && a.type && a.type !== 'noauth') {
        const p = authParams(a);
        if (a.type === 'bearer') {
          headers.push(['Authorization', concat('Bearer ', secretOr(String(p.token || ''), 'BEARER_TOKEN', 'the bearer token'))]);
        } else if (a.type === 'basic') {
          needs.encoding = true;
          const u = S(String(p.username || '')), pw = secretOr(String(p.password || ''), 'BASIC_PASSWORD', 'the basic auth password');
          headers.push(['Authorization', `\`Basic \${encoding.b64encode(${u} + ':' + ${pw})}\``]);
        } else if (a.type === 'apikey') {
          const k = String(p.key || 'x-api-key'), val = String(p.value || '');
          if (String(p.in || 'header') === 'query') {
            url += (url.includes('?') ? '&' : '?') + k + '=' + (hasVar(val) ? val : '{{__APIKEY__}}');
            if (url.includes('{{__APIKEY__}}')) {
              // literal key in the query → env var
              const envN = o.secretsToEnv ? secretEnv(k, val) : null;
              secretsFound.add(`the ${k} API key`);
              url = url.replace('{{__APIKEY__}}', envN ? '\u0000ENV:' + envN + '\u0000' : val);
            }
          } else {
            headers.push([k, secretOr(val, k, `the ${k} API key`)]);
          }
        } else if (a.type === 'oauth2' && p.accessToken) {
          headers.push(['Authorization', concat('Bearer ', secretOr(String(p.accessToken), 'ACCESS_TOKEN', 'the OAuth 2.0 access token'))]);
          notes.push('OAuth 2.0: the access token saved in Postman is sent as a Bearer token. It will expire; for a real test, fetch a token in setup() and pass it to the default function.');
        } else {
          unsupportedAuth.add(a.type);
          notes.push(`Postman "${a.type}" auth isn't converted: add the Authorization header yourself.`);
        }
      }

      // ---- headers
      let hasContentType = false;
      const body = req.body && req.body.mode && !req.body.disabled ? req.body : null;
      const formMode = body && body.mode === 'formdata';
      for (const h of headerList(req.header)) {
        if (ALWAYS_DROP.test(h.key)) continue;
        if (/^content-type$/i.test(h.key)) { if (formMode) continue; hasContentType = true; }
        if (headers.some(x => x[0].toLowerCase() === h.key.toLowerCase())) {
          const i = headers.findIndex(x => x[0].toLowerCase() === h.key.toLowerCase());
          headers.splice(i, 1);           // a header set on the request wins over auth
        }
        if (SECRET_HEADER.test(h.key)) headers.push([h.key, secretOr(h.value, h.key, `the ${h.key} header`)]);
        else headers.push([h.key, S(h.value)]);
      }

      // ---- body (Postman drops bodies on GET/HEAD unless body pruning is turned off)
      let bodyCode = null;
      const pruned = ['GET', 'HEAD', 'COPY', 'UNLOCK', 'UNLINK', 'PURGE', 'LINK', 'VIEW'].includes(method) &&
        !(item.protocolProfileBehavior && item.protocolProfileBehavior.disableBodyPruning);
      if (body && pruned && hasBodyContent(body)) notes.push(`Postman doesn't send a body with ${method} unless "body pruning" is turned off, so the body was left out.`);
      if (body && !pruned) {
        if (body.mode === 'raw' && String(body.raw || '').trim()) {
          const rawBody = String(body.raw);
          const lang = body.options && body.options.raw && body.options.raw.language;
          let parsed;
          try { parsed = JSON.parse(rawBody); } catch (e) { parsed = undefined; }
          const looksJson = lang === 'json' || (parsed !== undefined && typeof parsed === 'object') || /^\s*[{[]/.test(rawBody);
          if (/password|passwd|secret|client_secret|api_?key/i.test(rawBody) && !/\{\{[^}]*(password|secret|key)[^}]*\}\}/i.test(rawBody)) bodySecrets.add(name);
          if (parsed !== undefined && parsed !== null && typeof parsed === 'object') bodyCode = `JSON.stringify(${jsExpr(parsed, '')})`;
          else bodyCode = S(rawBody);
          if (looksJson && !hasContentType) headers.push(['Content-Type', lit('application/json')]);
          if (parsed === undefined && looksJson && hasVar(rawBody)) notes.push('The JSON body has {{variables}} outside quotes, so it is sent as text with the variables filled in.');
        } else if (body.mode === 'urlencoded' && Array.isArray(body.urlencoded)) {
          const fields = body.urlencoded.filter(f => f && f.key != null && !f.disabled);
          const seen = new Set();
          fields.forEach(f => { if (seen.has(f.key)) notes.push(`The form field "${f.key}" appears more than once: k6 keeps the last value.`); seen.add(f.key); });
          if (fields.some(f => /password|secret|token/i.test(f.key) && f.value && !hasVar(f.value))) bodySecrets.add(name);
          const obj = {};
          fields.forEach(f => { obj[f.key] = f.value == null ? '' : String(f.value); });
          bodyCode = jsExpr(obj, '');
        } else if (body.mode === 'formdata' && Array.isArray(body.formdata)) {
          needs.formdata = true;
          lines.push('const fd = new FormData();');
          body.formdata.filter(f => f && f.key != null && !f.disabled).forEach(f => {
            if (f.type === 'file') {
              const src = Array.isArray(f.src) ? f.src[0] : f.src;
              if (!src) { lines.push(`// TODO: Postman had no file chosen for the "${oneLine(f.key)}" field`); notes.push(`The form field "${f.key}" is a file with no file chosen.`); return; }
              const fv = fileVar(src, true);
              const fname = String(src).split(/[\\/]/).pop();
              lines.push(`fd.append(${lit(f.key)}, http.file(${fv}, ${lit(fname)}${f.contentType ? ', ' + lit(f.contentType) : ''}));`);
              result.hasFiles = true;
            } else {
              lines.push(`fd.append(${lit(f.key)}, ${S(f.value == null ? '' : f.value)});`);
            }
          });
          headers.push(['Content-Type', "'multipart/form-data; boundary=' + fd.boundary"]);
          bodyCode = 'fd.body()';
        } else if (body.mode === 'graphql' && body.graphql) {
          const g = body.graphql;
          let gv = {};
          if (typeof g.variables === 'string' && g.variables.trim()) {
            try { gv = JSON.parse(g.variables); } catch (e) { gv = null; }
          } else if (g.variables && typeof g.variables === 'object') gv = g.variables;
          const q = jsExpr(String(g.query || ''), '  ');
          if (gv === null) {
            notes.push("The GraphQL variables aren't valid JSON, so they're sent as text with any {{variables}} filled in.");
            bodyCode = `JSON.stringify({\n  query: ${q},\n  variables: JSON.parse(${S(g.variables)}),\n})`;
          } else {
            bodyCode = `JSON.stringify({\n  query: ${q},\n  variables: ${jsExpr(gv, '  ')},\n})`;
          }
          if (!hasContentType) headers.push(['Content-Type', lit('application/json')]);
        } else if (body.mode === 'file' && body.file) {
          if (body.file.src) { bodyCode = fileVar(body.file.src, true); result.hasFiles = true; }
          else if (body.file.content) bodyCode = S(body.file.content);
          else notes.push('The binary body has no file chosen.');
        }
      }

      // ---- scripts
      const pre = scriptText(item.event, 'prerequest');
      if (pre.trim()) {
        preReqs.push(name);
        if (o.keepScripts) {
          lines.unshift(...['// Postman pre-request script (not converted: rewrite it in k6 JavaScript if you need it):']
            .concat(pre.split('\n').filter(l => l.trim()).map(l => '//   ' + l.replace(/\s+$/, ''))));
        }
      }
      const tests = convertTests(scriptText(item.event, 'test'), name);
      if (tests.usesJsonPath) needs.jsonPath = true;

      // ---- params
      const params = [];
      if (headers.length) params.push(`headers: {\n` + headers.map(([k, v]) => `    ${key(k)}: ${v},`).join('\n') + `\n  }`);
      if (o.nameTags && (/\{\{|\?/.test(url) || nameTag(url) !== (url.replace(/^[a-z][\w+.-]*:\/\/[^/]*/i, '') || '/'))) {
        params.push(`tags: { name: ${lit(nameTag(url))} }`);
      }
      if (item.protocolProfileBehavior && item.protocolProfileBehavior.followRedirects === false) params.push('redirects: 0');
      const paramsCode = params.length ? `{\n  ${params.join(',\n  ')},\n}` : null;

      // ---- URL expression
      let urlCode;
      if (url.includes('\u0000ENV:')) {
        const parts = url.split(/\u0000ENV:([A-Z0-9_]+)\u0000/);
        urlCode = parts.map((p, i) => (i % 2 ? envRef(p) : (p ? S(p) : null))).filter(Boolean).join(' + ');
      } else urlCode = S(url);

      // ---- call
      let call;
      const args = [urlCode];
      if (method === 'GET' && bodyCode == null) { call = 'http.get'; if (paramsCode) args.push(paramsCode); }
      else if (method === 'HEAD' && bodyCode == null) { call = 'http.head'; if (paramsCode) args.push(paramsCode); }
      else if (['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method)) {
        call = { POST: 'http.post', PUT: 'http.put', PATCH: 'http.patch', DELETE: 'http.del', OPTIONS: 'http.options' }[method];
        if (bodyCode != null || paramsCode) args.push(bodyCode != null ? bodyCode : 'null');
        if (paramsCode) args.push(paramsCode);
      } else {
        call = 'http.request';
        args.unshift(lit(method));
        args.push(bodyCode != null ? bodyCode : 'null');
        if (paramsCode) args.push(paramsCode);
      }

      lines.unshift(`// ${name}`);
      for (const n of notes) lines.splice(1, 0, `// NOTE: ${oneLine(n)}`);
      lines.push(`res = ${call}(${args.join(', ')});`);

      // ---- checks
      if (o.checks) {
        const cs = tests.checks.slice();
        if (!tests.hasStatus) cs.unshift({ name: 'status is 2xx', code: 'r.status >= 200 && r.status < 300' });
        if (cs.length) {
          needs.check = true;
          checkCount += cs.length;
          lines.push('check(res, {');
          cs.forEach(c => lines.push(`  ${lit(uniqueName(name + ': ' + c.name))}: (r) => ${c.code},`));
          lines.push('});');
        }
      }
      tests.sets.forEach(s => {
        needs.setVar = true;
        setNames.add(s.name);
        lines.push(`setVar(${lit(s.name)}, ${s.code});`);
      });
      if (tests.unconverted.length) {
        unconvertedReqs.push(name);
        if (o.keepScripts) {
          lines.push('// Postman test script lines not converted (rewrite as k6 checks if you need them):');
          tests.unconverted.forEach(l => lines.push('//   ' + l));
        }
      }
      if (o.thinkTime > 0 && reqIndex < totalRequests) { needs.sleep = true; lines.push(`sleep(${o.thinkTime});`); }

      const text = lines.join('\n');
      return formMode ? `{\n${indent(text, '  ')}\n}` : text;
    }

    // ---- folders → groups
    function walk(items, auth, depth) {
      const blocks = [];
      items.forEach(it => {
        if (!it || typeof it !== 'object') return;
        if (Array.isArray(it.item)) {
          const fAuth = it.auth && it.auth.type && it.auth.type !== 'inherit' ? it.auth : auth;
          const fPre = scriptText(it.event, 'prerequest'), fTest = scriptText(it.event, 'test');
          const inner = walk(it.item, fAuth, depth + 1);
          if (!inner.length) return;
          result.folders++;
          const head = [];
          if ((fPre.trim() || fTest.trim())) {
            result.warnings.push(`The folder "${oneLine(it.name)}" has its own pre-request or test script. Folder scripts aren't converted; they're kept as comments at the top of its group.`);
            if (o.keepScripts) head.push('// Folder script from Postman (not converted):', ...(fPre + '\n' + fTest).split('\n').filter(l => l.trim()).map(l => '//   ' + l.replace(/\s+$/, '')));
          }
          const innerText = (head.length ? head.join('\n') + '\n' : '') + inner.join('\n\n');
          if (o.groups) {
            needs.group = true;
            blocks.push(`group(${lit(oneLine(it.name) || 'Folder')}, function () {\n${indent(innerText, '  ')}\n});`);
          } else {
            blocks.push(`// ---- ${oneLine(it.name) || 'Folder'}\n${innerText}`);
          }
        } else if (it.request) {
          const code = requestCode(it, auth);
          if (code) blocks.push(code);
        }
      });
      return blocks;
    }

    const colAuth = col.auth && col.auth.type ? col.auth : null;
    const blocks = walk(col.item, colAuth, 0);
    result.requests = reqIndex;
    if (!reqIndex) { result.error = 'This collection has no requests in it.'; return result; }

    // ---- variables used but never defined
    const undefinedVars = [...used].filter(n => !vars.has(n) && !setNames.has(n));
    undefinedVars.forEach(n => vars.set(n, { value: '', secret: false, from: 'missing' }));
    [...setNames].forEach(n => { if (!vars.has(n)) vars.set(n, { value: '', secret: false, from: 'response' }); });

    // ---- assemble
    const out = [];
    const colName = oneLine(col.info && col.info.name);
    out.push(`// Generated by the Postman to k6 converter: https://pawansinha.com.au/tools/postman-to-k6/`);
    out.push(`// From the Postman collection ${colName ? '"' + colName + '" ' : ''}(${reqIndex} request${reqIndex > 1 ? 's' : ''}${envLabel ? ', environment "' + oneLine(envLabel) + '"' : ''}).`);

    // variable lines
    const varLines = [];
    const runEnv = [];
    const emitVars = vars.size > 0 && (needs.v || needs.setVar);
    if (emitVars) {
      for (const [n, info] of vars) {
        const looksSecret = info.secret || (SECRET_VAR.test(n) && info.value && !/^https?:\/\//i.test(info.value));
        let def = lit(info.value), comment = '';
        if (info.from === 'missing') { comment = ' // used in the collection but not defined: pass it with -e'; runEnv.push(n); }
        else if (info.from === 'response') comment = ' // set from a response during the test';
        else if (looksSecret && info.value) {
          secretsFound.add(`the ${n} variable`);
          if (o.secretsToEnv) { def = "''"; comment = ' // secret: pass it with -e'; runEnv.push(n); }
        }
        varLines.push(`  ${key(n)}: ${envRef(n)} || ${def},${comment}`);
      }
      runEnv.forEach(n => { if (!result.env.some(e => e.name === n)) result.env.push({ name: n, label: n }); });
    }
    const urlVar = [...vars.keys()].find(n => /(base_?url|host|url|domain|server|api)/i.test(n) && /^https?:\/\//i.test(vars.get(n).value));
    out.push(`// Run it with: k6 run${result.env.map(e => ` -e ${e.name}=...`).join('')} script.js`);
    if (urlVar && emitVars) out.push(`// Point it at another environment with: k6 run -e ${urlVar}=https://staging.example.com script.js`);
    out.push(`import http from 'k6/http';`);
    const k6imports = ['check', 'group', 'sleep'].filter(n => needs[n]);
    if (k6imports.length) out.push(`import { ${k6imports.join(', ')} } from 'k6';`);
    if (needs.encoding) out.push(`import encoding from 'k6/encoding';`);
    if (needs.formdata) out.push(`import { FormData } from 'https://jslib.k6.io/formdata/0.0.2/index.js';`);
    out.push('');
    if (initLines.length) { out.push(...initLines); out.push(''); }

    if (emitVars) {
      out.push('// Postman variables (collection' + (envLabel ? ' + environment' : '') + '). Override any of them with -e name=value.');
      out.push('const VARS = {');
      out.push(...varLines);
      out.push('};');
      out.push('');
    } else if (needs.v) {
      out.push('const VARS = {};');
      out.push('');
    }
    if (dyn.size) {
      out.push("// Postman's dynamic variables ({{$guid}}, {{$timestamp}} ...), rebuilt in plain JavaScript.");
      out.push('const DYNAMIC = {');
      [...dyn].forEach(n => out.push(`  ${n}: ${DYNAMIC[n]},`));
      out.push('};');
      const defs = [...dyn].map(n => DYNAMIC[n]).join(' ');
      if (defs.includes('uuid(')) out.push("function uuid() { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16); }); }");
      if (defs.includes('rnd(')) out.push("function rnd(n) { let s = ''; while (s.length < n) s += Math.random().toString(36).slice(2); return s.slice(0, n); }");
      if (defs.includes('pick(')) out.push('function pick(list) { return list[Math.floor(Math.random() * list.length)]; }');
      out.push('');
    }
    if (needs.v) {
      out.push('// Fills in {{name}} with the variable\'s current value, like Postman does when it sends a request.');
      out.push('function v(text) {');
      out.push('  let s = String(text);');
      out.push('  for (let i = 0; i < 5 && s.includes(\'{{\'); i++) {');
      out.push('    const next = s.replace(/\\{\\{\\s*([^{}]+?)\\s*\\}\\}/g, (m, name) => {');
      out.push('      if (Object.prototype.hasOwnProperty.call(VARS, name)) return VARS[name];');
      if (dyn.size) out.push('      if (Object.prototype.hasOwnProperty.call(DYNAMIC, name)) return DYNAMIC[name]();');
      out.push('      return m;');
      out.push('    });');
      out.push('    if (next === s) break;');
      out.push('    s = next;');
      out.push('  }');
      out.push('  return s;');
      out.push('}');
      out.push('');
    }
    if (needs.setVar) {
      out.push('// Saves a value from a response for later requests, like pm.environment.set() in Postman.');
      out.push('function setVar(name, value) {');
      out.push('  if (value === undefined || value === null) return;');
      out.push("  VARS[name] = typeof value === 'object' ? JSON.stringify(value) : String(value);");
      out.push('}');
      out.push('');
    }
    if (needs.jsonPath) {
      out.push("// Reads a value from a JSON response (path like 'data.items.0.id'), or undefined if it isn't there.");
      out.push('function jsonPath(res, path) {');
      out.push('  try { return res.json(path); } catch (e) { return undefined; }');
      out.push('}');
      out.push('');
    }

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
      out.push('  // Closed model: each virtual user runs the whole collection in a loop, like the Postman runner.');
      out.push(`  vus: ${Math.max(1, Math.round(+o.vus || 1))},`);
      out.push(`  duration: ${lit(o.duration || '1m')},`);
    }
    const th = [];
    if (+o.p95 > 0) th.push(`    http_req_duration: ['p(95)<${num(o.p95, 500)}'],`);
    if (o.errorRate !== '' && o.errorRate != null && +o.errorRate >= 0 && !isNaN(+o.errorRate)) {
      th.push(+o.errorRate === 0 ? `    http_req_failed: ['rate==0'],` : `    http_req_failed: ['rate<${+(+o.errorRate / 100).toFixed(6)}'],`);
    }
    if (o.checks && checkCount) th.push(`    checks: ['rate>0.99'],`);
    if (th.length) { out.push('  thresholds: {'); out.push(...th); out.push('  },'); }
    out.push('};');
    out.push('');

    // collection-level scripts
    const cPre = scriptText(col.event, 'prerequest'), cTest = scriptText(col.event, 'test');
    out.push('export default function () {');
    out.push('  let res;');
    if (cPre.trim() || cTest.trim()) {
      result.warnings.push("The collection has its own pre-request or test script, which runs for every request in Postman. It isn't converted; it's kept as a comment at the top of the default function.");
      if (o.keepScripts) {
        out.push('  // Collection script from Postman (not converted):');
        (cPre + '\n' + cTest).split('\n').filter(l => l.trim()).forEach(l => out.push('  //   ' + l.replace(/\s+$/, '')));
      }
    }
    out.push('');
    out.push(indent(blocks.join('\n\n'), '  '));
    if (o.thinkTime > 0 && o.model === 'closed') {
      needs.sleep = true;
      out.push('');
      out.push(`  sleep(${o.thinkTime}); // think time before the next iteration`);
    }
    out.push('}');
    out.push('');
    // sleep may only be needed by the end-of-iteration think time: make sure it's imported
    let script = out.join('\n');
    if (needs.sleep && !k6imports.includes('sleep')) {
      const imp = ['check', 'group', 'sleep'].filter(n => needs[n]);
      script = k6imports.length
        ? script.replace(`import { ${k6imports.join(', ')} } from 'k6';`, `import { ${imp.join(', ')} } from 'k6';`)
        : script.replace(`import http from 'k6/http';\n`, `import http from 'k6/http';\nimport { ${imp.join(', ')} } from 'k6';\n`);
    }
    result.script = script;

    // ---- messages
    if (secretsFound.size) {
      result.warnings.push(o.secretsToEnv
        ? `Secrets found in ${[...secretsFound].join(', ')}. They're no longer in the script: pass them with -e when you run k6. Saved tokens usually expire; for a real test, log in inside the script (or in setup()) and save the token with setVar().`
        : `Secrets found in ${[...secretsFound].join(', ')}. They're in the script as plain text. Don't commit it or share it: tick "Move secrets to environment variables".`);
    }
    if (bodySecrets.size) result.warnings.push(`The body of ${[...bodySecrets].map(n => '"' + n + '"').join(', ')} looks like it holds a password or key as plain text. Use a test account, and use a {{variable}} for it before you share the script.`);
    if (undefinedVars.length) result.warnings.push(`${undefinedVars.length === 1 ? 'This variable is' : 'These variables are'} used but not defined in the collection${envLabel ? ' or environment' : ''}: ${undefinedVars.join(', ')}. Pass ${undefinedVars.length === 1 ? 'it' : 'them'} with -e, or add the Postman environment above.`);
    if (unknownDynamic.size) result.warnings.push(`Postman dynamic variable${unknownDynamic.size > 1 ? 's' : ''} ${[...unknownDynamic].join(', ')} ${unknownDynamic.size > 1 ? "aren't" : "isn't"} supported and will be sent as written. Replace ${unknownDynamic.size > 1 ? 'them' : 'it'} with your own test data.`);
    if (unconvertedReqs.length) result.warnings.push(`Some test script lines in ${unconvertedReqs.length} request${unconvertedReqs.length > 1 ? 's' : ''} (${unconvertedReqs.slice(0, 4).map(n => '"' + n + '"').join(', ')}${unconvertedReqs.length > 4 ? ' …' : ''}) couldn't be converted. Status, response time, header, body text and simple JSON value checks are converted; the rest is kept as comments.`);
    if (preReqs.length) result.warnings.push(`${preReqs.length} request${preReqs.length > 1 ? 's have' : ' has'} a pre-request script (${preReqs.slice(0, 4).map(n => '"' + n + '"').join(', ')}${preReqs.length > 4 ? ' …' : ''}). Pre-request scripts aren't converted; they're kept as comments above each request.`);
    if (unsupportedAuth.size) result.warnings.push(`Postman auth type${unsupportedAuth.size > 1 ? 's' : ''} ${[...unsupportedAuth].join(', ')} ${unsupportedAuth.size > 1 ? "aren't" : "isn't"} converted. Add the header (or fetch a token in setup()) yourself.`);
    if (result.hasFiles) result.warnings.push('Some requests upload files. Put the files next to the script before you run it (see the TODO lines at the top).');
    result.info.push(`Converted ${reqIndex} request${reqIndex > 1 ? 's' : ''}${result.folders ? ` in ${result.folders} folder${result.folders > 1 ? 's' : ''}` : ''}, in the order the Postman runner sends them.`);
    if (setNames.size) result.info.push(`Values saved from responses (${[...setNames].join(', ')}) are passed to later requests through VARS, as pm.environment.set() does in Postman.`);
    if (o.model === 'open' && o.thinkTime > 0 && reqIndex > 1) result.info.push('With the open model, think time makes each iteration longer, so k6 needs more VUs to hold the rate. Size maxVUs with the VU calculator.');
    return result;
  }

  function evalLit(code) {
    // code is a single-quoted literal produced by lit(): turn it back into the string
    return code.slice(1, -1).replace(/\\(x[0-9a-f]{2}|u[0-9a-f]{4}|.)/gi, (m, c) => {
      if (c[0] === 'x' || c[0] === 'u') return String.fromCharCode(parseInt(c.slice(1), 16));
      return { n: '\n', r: '\r', t: '\t' }[c] || c;
    });
  }

  function hasBodyContent(b) {
    if (b.mode === 'raw') return !!String(b.raw || '').trim();
    if (b.mode === 'urlencoded') return Array.isArray(b.urlencoded) && b.urlencoded.length > 0;
    if (b.mode === 'formdata') return Array.isArray(b.formdata) && b.formdata.length > 0;
    if (b.mode === 'graphql') return !!(b.graphql && b.graphql.query);
    if (b.mode === 'file') return !!(b.file && (b.file.src || b.file.content));
    return false;
  }

  function countRequests(items) {
    let n = 0;
    (items || []).forEach(it => {
      if (!it || typeof it !== 'object') return;
      if (Array.isArray(it.item)) n += countRequests(it.item);
      else if (it.request) {
        const r = typeof it.request === 'string' ? { url: it.request } : it.request;
        if (r.url) n++;
      }
    });
    return n;
  }

  // ---------------------------------------------------------------- examples

  const EXAMPLES = {
    api: JSON.stringify({
      info: { name: 'Shop API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{authToken}}', type: 'string' }] },
      variable: [
        { key: 'baseUrl', value: 'https://api.example.com/v2' },
        { key: 'authToken', value: '' },
      ],
      item: [
        {
          name: 'Log in',
          request: {
            auth: { type: 'noauth' },
            method: 'POST',
            header: [{ key: 'Content-Type', value: 'application/json' }],
            body: { mode: 'raw', raw: '{\n  "email": "{{userEmail}}",\n  "password": "{{userPassword}}"\n}', options: { raw: { language: 'json' } } },
            url: { raw: '{{baseUrl}}/login', host: ['{{baseUrl}}'], path: ['login'] },
          },
          event: [{ listen: 'test', script: { type: 'text/javascript', exec: [
            'pm.test("Status code is 200", function () {',
            '    pm.response.to.have.status(200);',
            '});',
            'var jsonData = pm.response.json();',
            'pm.environment.set("authToken", jsonData.data.token);',
          ] } }],
        },
        {
          name: 'Catalogue',
          item: [
            {
              name: 'Search products',
              request: {
                method: 'GET',
                header: [{ key: 'Accept', value: 'application/json' }, { key: 'X-Debug', value: 'true', disabled: true }],
                url: {
                  raw: '{{baseUrl}}/products?q=shoes&page=1&sort=price',
                  host: ['{{baseUrl}}'], path: ['products'],
                  query: [{ key: 'q', value: 'shoes' }, { key: 'page', value: '1' }, { key: 'sort', value: 'price', disabled: true }],
                },
              },
              event: [{ listen: 'test', script: { exec: [
                'pm.test("Status code is 200", () => pm.response.to.have.status(200));',
                'pm.test("Fast enough", function () {',
                '    pm.expect(pm.response.responseTime).to.be.below(800);',
                '});',
                'pm.collectionVariables.set("productId", pm.response.json().items[0].id);',
              ] } }],
            },
            {
              name: 'Get product',
              request: {
                method: 'GET',
                url: { raw: '{{baseUrl}}/products/:productId', host: ['{{baseUrl}}'], path: ['products', ':productId'], variable: [{ key: 'productId', value: '{{productId}}' }] },
              },
              event: [{ listen: 'test', script: { exec: [
                'pm.test("Product has a price", function () {',
                '    pm.response.to.have.status(200);',
                '    pm.expect(pm.response.json().price).to.exist;',
                '});',
              ] } }],
            },
          ],
        },
        {
          name: 'Checkout',
          item: [{
            name: 'Add to cart',
            request: {
              method: 'POST',
              header: [{ key: 'Content-Type', value: 'application/json' }, { key: 'X-Request-Id', value: '{{$guid}}' }],
              body: { mode: 'raw', raw: '{\n  "productId": "{{productId}}",\n  "qty": 2\n}', options: { raw: { language: 'json' } } },
              url: '{{baseUrl}}/cart/items',
            },
            event: [{ listen: 'test', script: { exec: [
              'pm.test("Item added", function () {',
              '    pm.expect(pm.response.code).to.be.oneOf([200, 201]);',
              '});',
              'console.log("cart total", pm.response.json().total);',
            ] } }],
          }],
        },
      ],
    }, null, 2),

    v20: JSON.stringify({
      info: { name: 'Legacy services (v2.0)', schema: 'https://schema.getpostman.com/json/collection/v2.0.0/collection.json' },
      item: [
        {
          name: 'Accounts',
          auth: { type: 'apikey', apikey: { key: 'X-Api-Key', value: '{{apiKey}}', in: 'header' } },
          item: [
            {
              name: 'Sign in (form)',
              request: {
                url: 'https://legacy.example.com/session',
                method: 'POST',
                header: 'Accept: application/json\nX-Client: postman',
                body: { mode: 'urlencoded', urlencoded: [
                  { key: 'username', value: '{{username}}', type: 'text' },
                  { key: 'password', value: '{{password}}', type: 'text' },
                  { key: 'remember', value: 'true', type: 'text', disabled: true },
                ] },
              },
              event: [{ listen: 'test', script: { exec: [
                'tests["Status code is 200"] = responseCode.code === 200;',
                'postman.setEnvironmentVariable("sessionId", postman.getResponseHeader("X-Session-Id"));',
              ] } }],
            },
            {
              name: 'Upload avatar',
              request: {
                url: 'https://legacy.example.com/accounts/{{accountId}}/avatar',
                method: 'PUT',
                header: [{ key: 'X-Session-Id', value: '{{sessionId}}' }],
                body: { mode: 'formdata', formdata: [
                  { key: 'caption', value: 'Profile photo {{$timestamp}}', type: 'text' },
                  { key: 'file', type: 'file', src: '/Users/me/Pictures/avatar.png' },
                ] },
              },
            },
          ],
        },
        {
          name: 'GraphQL',
          item: [{
            name: 'Order history',
            request: {
              url: 'https://legacy.example.com/graphql',
              method: 'POST',
              auth: { type: 'basic', basic: { username: 'reporting', password: 'S3cret-pass' } },
              body: { mode: 'graphql', graphql: { query: 'query Orders($first: Int!) {\n  orders(first: $first) { id total }\n}', variables: '{"first": {{$randomInt}}}' } },
            },
            event: [
              { listen: 'prerequest', script: { exec: ['pm.variables.set("start", Date.now());'] } },
              { listen: 'test', script: { exec: [
                'pm.test("OK", function () { pm.response.to.be.ok; });',
                'pm.test("JSON", function () { pm.response.to.have.header("Content-Type"); });',
              ] } },
            ],
          }],
        },
      ],
    }, null, 2),
  };

  const ENV_EXAMPLE = JSON.stringify({
    name: 'Staging',
    values: [
      { key: 'baseUrl', value: 'https://staging-api.example.com/v2', enabled: true },
      { key: 'userEmail', value: 'load.test@example.com', enabled: true },
      { key: 'userPassword', value: 'not-a-real-password', type: 'secret', enabled: true },
    ],
  }, null, 2);

  const api = { convert, convertTests, buildUrl, nameTag, templatePath, canonHeader, jsonSelector, DEFAULTS, EXAMPLES, ENV_EXAMPLE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PostmanToK6 = api;
})(typeof window !== 'undefined' ? window : this);
