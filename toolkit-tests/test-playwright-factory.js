// Tests for the "API Automation Factory" options of docs/tools/openapi-to-playwright/generate.js:
// dataTable, tokenHelper, htmlReport and catalogue. Run: node toolkit-tests/test-playwright-factory.js
// The options are opt-in. The first tests prove that with them off the output is exactly what it was before they existed.
// If @playwright/test and @types/node are on NODE_PATH, the last tests type-check the generated files with TypeScript and
// run the generated suite against a small fake API with the real Playwright test runner. Otherwise they are skipped.
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const assert = require('assert');
const { execFileSync, spawn } = require('child_process');
const G = require(path.join(__dirname, '..', 'docs', 'tools', 'openapi-to-playwright', 'generate.js'));

let passed = 0, failed = 0, skipped = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }

let yaml = null;
try { yaml = require('js-yaml').load; } catch (e) { /* not installed: the YAML example is skipped */ }
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const gen = (spec, opts) => {
  const r = G.generate(typeof spec === 'string' ? spec : JSON.stringify(spec), Object.assign({ yaml }, opts || {}));
  assert.ok(!r.error, r.error);
  return r;
};
const ALL_ON = { dataTable: true, tokenHelper: true, htmlReport: true, catalogue: true };

// ---------------------------------------------------------------- fixtures

const shopSpec = {
  openapi: '3.0.3', info: { title: 'Shop orders', version: '2.1' }, servers: [{ url: 'http://127.0.0.1:8899/api' }],
  security: [{ oauth: ['orders:write'] }],
  components: {
    securitySchemes: { oauth: { type: 'oauth2', flows: { clientCredentials: { tokenUrl: '/oauth/token', scopes: { 'orders:write': 'write orders' } } } } },
    schemas: {
      NewOrder: {
        type: 'object', required: ['sku', 'quantity'],
        properties: {
          id: { type: 'integer', readOnly: true },
          sku: { type: 'string', minLength: 3, maxLength: 12, example: 'SKU-123' },
          quantity: { type: 'integer', minimum: 1, maximum: 50, example: 2 },
          priority: { type: 'string', enum: ['standard', 'express'] },
          discount: { type: 'number', minimum: 0, exclusiveMaximum: true, maximum: 100 },
          note: { type: 'string', maxLength: 500 },
        },
      },
    },
  },
  paths: {
    '/auth/login': {
      post: { tags: ['Auth'], security: [], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { username: { type: 'string' }, password: { type: 'string' } } } } } },
        responses: { 200: { description: 'token' } } },
    },
    '/orders': {
      post: {
        tags: ['Orders'], summary: 'Place an order',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/NewOrder' } } } },
        responses: { 201: { description: 'created', content: { 'application/json': { schema: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } } } } },
          400: { description: 'bad' }, 401: { description: 'no auth' } },
      },
      get: {
        tags: ['Orders'],
        parameters: [
          { name: 'limit', in: 'query', required: true, schema: { type: 'integer', minimum: 1, maximum: 100, example: 10 } },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['open', 'shipped'] } },
        ],
        responses: { 200: { description: 'list', content: { 'application/json': { schema: { type: 'array', items: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } } } } } },
          400: { description: 'bad' }, 401: { description: 'no auth' } },
      },
    },
    '/orders/{orderId}': {
      get: { tags: ['Orders'], parameters: [{ name: 'orderId', in: 'path', required: true, schema: { type: 'integer', example: 1 } }],
        responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } } } } },
          401: { description: 'no auth' }, 404: { description: 'missing' } } },
    },
  },
};

// OpenAPI 3.1 numeric exclusive limits, and a Swagger 2.0 OAuth "application" flow.
const limitsSpec = {
  openapi: '3.1.0', info: { title: 'Limits', version: '1' }, servers: [{ url: 'https://l.example.com' }],
  paths: {
    '/rates': {
      put: { tags: ['Rates'], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: {
        rate: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 },
        code: { type: 'string', enum: ['A', 'B', 'C'] },
      } } } } }, responses: { 204: { description: 'saved' }, 422: { description: 'invalid' } } },
    },
  },
};
const swaggerOauth = {
  swagger: '2.0', info: { title: 'Old', version: '1' }, host: 'old.example.com', basePath: '/v1', schemes: ['https'],
  securityDefinitions: { o: { type: 'oauth2', flow: 'application', tokenUrl: 'https://auth.example.com/token', scopes: { read: 'read' } } },
  security: [{ o: ['read'] }],
  paths: { '/things': { get: { responses: { 200: { description: 'ok' } } } } },
};

// ---------------------------------------------------------------- defaults stay exactly as they were

// sha256 of the default output, taken before the factory options were added (8 Nov 2026).
const GOLDEN = {
  swagger2: 'cbabbf3cf9714807f8bef13ebcfe10849e65c1e507e9245034f9830915ad8c03',
  openapi3: 'b83d58844f5b77134c4c386ecf79880f7fe94c5d8d8089686f940471313bdcc4',
  config: 'a3fc97265bacf770d2d07e16365d7f733672ed48532be2cdece36e8a2a3df87d',
};

test('default output of the examples is byte-identical to before the factory options', () => {
  assert.strictEqual(sha(gen(G.EXAMPLES.swagger2).spec), GOLDEN.swagger2);
  assert.strictEqual(sha(G.CONFIG), GOLDEN.config);
  if (yaml) assert.strictEqual(sha(gen(G.EXAMPLES.openapi3).spec), GOLDEN.openapi3);
  else return 'skip';
});

test('options set to false give the same result object as no options at all', () => {
  const off = { dataTable: false, tokenHelper: false, htmlReport: false, catalogue: false };
  const inputs = [JSON.stringify(shopSpec), JSON.stringify(limitsSpec), JSON.stringify(swaggerOauth), G.EXAMPLES.swagger2];
  if (yaml) inputs.push(G.EXAMPLES.openapi3);
  for (const input of inputs) {
    const a = gen(input), b = gen(input, off);
    assert.deepStrictEqual(b, a);
    assert.ok(!('files' in a) && !('catalogue' in a) && !('dataTable' in a.counts), 'no new keys when the options are off');
    assert.strictEqual(a.config, G.CONFIG);
  }
});

// ---------------------------------------------------------------- data tables

test('dataTable: body rows from examples, min/max length, min/max and exclusive limits', () => {
  const r = gen(shopSpec, { dataTable: true });
  const s = r.spec;
  assert.ok(s.includes('const postOrdersRows = ['), 'table constant for POST /orders');
  assert.ok(s.includes('for (const row of postOrdersRows) {'));
  assert.ok(s.includes("{ name: '\"sku\" one character too short (2)', field: 'sku', value: 'aa', valid: false },"));
  assert.ok(s.includes("{ name: '\"quantity\" above the maximum (51)', field: 'quantity', value: 51, valid: false },"));
  assert.ok(s.includes("{ name: '\"discount\" just below the exclusive maximum (99.99)', field: 'discount', value: 99.99, valid: true },"));
  assert.ok(s.includes("{ name: '\"discount\" at the exclusive maximum (100)', field: 'discount', value: 100, valid: false },"));
  assert.ok(s.includes("value: 'a'.repeat(501), valid: false"), 'long strings are written as repeat(), not 501 characters');
  assert.ok(!/"id"/.test(s.split('const postOrdersRows')[1].split('];')[0]), 'readOnly id is not in the table');
  assert.ok(s.includes('[row.field]: row.value }'), 'row value overrides one body field');
  assert.ok(/if \(row\.valid\) \{\n\s+expect\(res\.status\(\)\)\.toBe\(201\);\n\s+\} else \{\n\s+expect\(res\.status\(\)\)\.toBe\(400\);/.test(s), 'valid → 201, invalid → documented 400');
});

test('dataTable: required query parameters get their own table; enum values already looped are not repeated', () => {
  const r = gen(shopSpec, { dataTable: true });
  assert.ok(r.spec.includes('const getOrdersQueryRows = ['));
  assert.ok(r.spec.includes('params: { ...{ limit: 10 }, [row.field]: String(row.value) },'));
  // priority is looped by the existing data-driven test, so the table only adds the invalid value
  const table = r.spec.split('const postOrdersRows')[1].split('];')[0];
  assert.ok(!table.includes('(allowed value)'), 'allowed values not repeated');
  assert.ok(table.includes('"priority" not in the allowed values'));
  const noLoop = gen(shopSpec, { dataTable: true, dataDriven: false }).spec.split('const postOrdersRows')[1].split('];')[0];
  assert.ok(noLoop.includes('"priority" = "standard" (allowed value)'), 'with data-driven off, the table has the allowed values');
});

test('dataTable: OpenAPI 3.1 numeric exclusive limits, enum invalid row, 422 expected, counts', () => {
  const r = gen(limitsSpec, { dataTable: true });
  assert.ok(r.spec.includes("value: 0.01, valid: true"));
  assert.ok(r.spec.includes("{ name: '\"rate\" at the exclusive minimum (0)', field: 'rate', value: 0, valid: false },"));
  assert.ok(r.spec.includes("value: 0.99, valid: true"));
  assert.ok(r.spec.includes("value: 'not-an-allowed-value', valid: false"));
  assert.ok(r.spec.includes('expect(res.status()).toBe(422);'));
  assert.strictEqual(r.counts.tests, r.counts.positive + r.counts.negative);
  assert.ok(r.counts.dataTable >= 5);
  assert.ok(r.info.some(i => /Data tables add/.test(i)));
});

// ---------------------------------------------------------------- token helper, reports

test('tokenHelper: global-setup.ts with the client credentials token URL and the login endpoint', () => {
  const r = gen(shopSpec, { tokenHelper: true });
  const f = r.files.find(x => x.name === 'global-setup.ts');
  assert.ok(f, 'global-setup.ts added');
  assert.ok(f.content.includes("const TOKEN_URL = process.env.TOKEN_URL || 'http://127.0.0.1:8899/api/oauth/token';"), 'relative tokenUrl made absolute');
  assert.ok(f.content.includes("const SCOPE = process.env.SCOPE ?? 'orders:write';"));
  assert.ok(f.content.includes('const LOGIN_URL = process.env.LOGIN_URL || `${BASE_URL}/auth/login`;'));
  assert.ok(f.content.includes('process.env.API_TOKEN = token;'));
  assert.ok(r.config.includes("globalSetup: './global-setup.ts',"));
  assert.ok(!r.files.some(x => x.name === 'package.json'), 'package.json only with htmlReport');
  assert.strictEqual(r.spec, gen(shopSpec).spec, 'the spec itself does not change: it still reads API_TOKEN');
});

test('tokenHelper: Swagger 2.0 application flow; APIs without bearer auth get no setup file', () => {
  const r = gen(swaggerOauth, { tokenHelper: true });
  assert.ok(r.files[0].content.includes("process.env.TOKEN_URL || 'https://auth.example.com/token'"));
  const k = gen(G.EXAMPLES.swagger2, { tokenHelper: true });   // API key auth only
  assert.ok(!k.files.some(x => x.name === 'global-setup.ts'));
  assert.ok(k.info.some(i => /no token to fetch/.test(i)));
  assert.strictEqual(k.config, G.CONFIG, 'no setup, no html option → the usual config');
});

test('htmlReport: config with html + junit reporters, package.json with scripts', () => {
  const r = gen(shopSpec, { htmlReport: true });
  assert.ok(r.config.includes("['html', { open: 'never', outputFolder: 'playwright-report' }]"));
  assert.ok(r.config.includes("['junit', { outputFile: 'test-results/junit.xml' }]"));
  assert.ok(!r.config.includes('globalSetup'));
  const pkg = JSON.parse(r.files.find(x => x.name === 'package.json').content);
  assert.strictEqual(pkg.scripts.test, 'playwright test');
  assert.strictEqual(pkg.scripts.report, 'playwright show-report playwright-report');
  assert.ok(pkg.devDependencies['@playwright/test']);
  assert.strictEqual(r.command, 'npm test');
});

// ---------------------------------------------------------------- catalogue

test('catalogue: one row per test, sequential IDs, types and expected results', () => {
  const r = gen(shopSpec, ALL_ON);
  const c = r.catalogue;
  assert.strictEqual(c.length, r.counts.tests, 'one row per generated test');
  c.forEach((row, i) => assert.strictEqual(row.id, 'TC-' + String(i + 1).padStart(3, '0')));
  const types = new Set(c.map(x => x.type));
  for (const t of ['positive', 'negative', 'boundary', 'auth']) assert.ok(types.has(t), 'has ' + t);
  assert.ok(c.some(x => x.type === 'auth' && x.expected === 'Status 401 (no credentials sent)'));
  assert.ok(c.some(x => x.endpoint === 'GET /orders/{orderId}' && x.expected === 'Status 404'));
  assert.ok(c.some(x => x.type === 'boundary' && x.expected === 'Status 400 (refused)'));
  // titles in the catalogue match test titles in the file (the fixed ones, not the looped template titles)
  assert.ok(r.spec.includes(`test('${c.find(x => x.type === 'auth').scenario}'`));
});

test('catalogue: CSV quoting, formula guard, and Markdown table', () => {
  const rows = [{ id: 'TC-001', tag: 'Orders, EU', endpoint: 'POST /o', scenario: '=SUM(A1) "quoted"', type: 'negative', expected: 'Status 4xx (refused)' }];
  const csv = G.catalogueCsv(rows);
  assert.strictEqual(csv.split('\r\n')[0], 'ID,Area,Endpoint,Scenario,Type,Expected result');
  assert.ok(csv.includes('"Orders, EU"'));
  assert.ok(csv.includes(`"'=SUM(A1) ""quoted"""`), 'leading = is neutralised and quotes doubled');
  const md = G.catalogueMarkdown([{ id: 'TC-001', tag: 'A', endpoint: 'GET /a|b', scenario: 's', type: 'auth', expected: 'e' }], 'My API');
  assert.ok(md.startsWith('# Test case catalogue: My API'));
  assert.ok(md.includes('1 test case: 1 auth.'));
  assert.ok(md.includes('| TC-001 | A | GET /a\\|b | s | auth | e |'));
});

// ---------------------------------------------------------------- compile and run with the real Playwright

const NM = (process.env.NODE_PATH || '').split(path.delimiter).find(p => p && fs.existsSync(path.join(p, '@playwright', 'test')) && fs.existsSync(path.join(p, '@types', 'node')));

function writeProject(dir, r) {
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tests', 'api.spec.ts'), r.spec);
  fs.writeFileSync(path.join(dir, 'playwright.config.ts'), r.config);
  for (const f of r.files || []) fs.writeFileSync(path.join(dir, f.name), f.content);
  fs.symlinkSync(NM, path.join(dir, 'node_modules'), 'dir');
}

test('generated spec, config and global-setup.ts compile (tsc --noEmit, strict, real types)', () => {
  if (!NM) return 'skip';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-factory-'));
  try {
    writeProject(dir, gen(shopSpec, ALL_ON));
    fs.writeFileSync(path.join(dir, 'limits.spec.ts'), gen(limitsSpec, ALL_ON).spec);
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2020', module: 'commonjs',
      lib: ['ES2020', 'DOM'], types: ['node'], skipLibCheck: true }, files: ['tests/api.spec.ts', 'limits.spec.ts', 'playwright.config.ts', 'global-setup.ts'] }));
    let cmd = ['npx', ['-y', '-p', 'typescript@5.6.3', 'tsc', '-p', dir]];
    try { execFileSync('tsc', ['--version'], { stdio: 'ignore' }); cmd = ['tsc', ['-p', dir]]; } catch (e) { /* use npx */ }
    try { execFileSync(cmd[0], cmd[1], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 }); }
    catch (e) {
      if (!e.stdout && /ENOTFOUND|EAI_AGAIN|network/i.test(String(e.stderr))) return 'skip';
      throw new Error('tsc failed:\n' + (e.stdout || e.stderr));
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// The fake API checks the token, the limits and the required fields the way the definition says.
const FAKE_API = `
const http = require('http');
let tokenCalls = 0;
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
http.createServer((req, res) => {
  let raw = ''; req.on('data', c => { raw += c; });
  req.on('end', () => {
    const u = new URL(req.url, 'http://x'), p = u.pathname;
    if (p === '/__calls') return send(res, 200, { tokenCalls });
    if (p === '/api/oauth/token') { tokenCalls++; const f = new URLSearchParams(raw);
      return f.get('client_id') === 'cid' && f.get('client_secret') === 'secret' && f.get('grant_type') === 'client_credentials'
        ? send(res, 200, { access_token: 'tok-123' }) : send(res, 401, {}); }
    if (p === '/api/auth/login') return send(res, 200, { token: 'tok-123' });
    if (req.headers.authorization !== 'Bearer tok-123') return send(res, 401, {});
    if (p === '/api/orders' && req.method === 'GET') { const l = u.searchParams.get('limit');
      return /^\\d+$/.test(l || '') && +l >= 1 && +l <= 100 ? send(res, 200, [{ id: 1 }]) : send(res, 400, {}); }
    if (p === '/api/orders' && req.method === 'POST') { let b; try { b = JSON.parse(raw); } catch (e) { return send(res, 400, {}); }
      const ok = typeof b.sku === 'string' && b.sku.length >= 3 && b.sku.length <= 12 && Number.isInteger(b.quantity) && b.quantity >= 1 && b.quantity <= 50
        && (b.priority === undefined || ['standard', 'express'].includes(b.priority))
        && (b.discount === undefined || (typeof b.discount === 'number' && b.discount >= 0 && b.discount < 100))
        && (b.note === undefined || (typeof b.note === 'string' && b.note.length <= 500));
      return ok ? send(res, 201, { id: 9 }) : send(res, 400, {}); }
    const m = /^\\/api\\/orders\\/([^/]+)$/.exec(p);
    if (m) return !/^\\d+$/.test(m[1]) ? send(res, 400, {}) : m[1] === '999999999' ? send(res, 404, {}) : send(res, 200, { id: +m[1] });
    send(res, 404, {});
  });
}).listen(+process.argv[1], '127.0.0.1', () => console.log('ready'));`;

test('the generated suite passes against a fake API with the real Playwright runner; token fetched once', async () => {
  if (!NM) return 'skip';
  const port = 8899;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-factory-run-'));
  const server = spawn(process.execPath, ['-e', FAKE_API, String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((resolve, reject) => {
      server.stdout.on('data', d => { if (/ready/.test(d)) resolve(); });
      server.on('exit', c => reject(new Error('fake API exited with ' + c)));
      setTimeout(() => reject(new Error('fake API did not start')), 5000);
    });
    const r = gen(shopSpec, ALL_ON);
    writeProject(dir, r);
    const cli = path.join(NM, '@playwright', 'test', 'cli.js');
    const env = Object.assign({}, process.env, { CLIENT_ID: 'cid', CLIENT_SECRET: 'secret', API_TOKEN: '' });
    const out = await new Promise(resolve => {
      const p = spawn(process.execPath, [cli, 'test'], { cwd: dir, env });
      let text = ''; p.stdout.on('data', d => { text += d; }); p.stderr.on('data', d => { text += d; });
      p.on('exit', code => resolve({ code, text }));
    });
    assert.strictEqual(out.code, 0, 'playwright test failed:\n' + out.text.slice(-3000));
    assert.ok(new RegExp(`${r.counts.tests} passed`).test(out.text), 'all ' + r.counts.tests + ' tests passed');
    assert.ok(fs.existsSync(path.join(dir, 'playwright-report', 'index.html')), 'HTML report written');
    assert.ok(fs.existsSync(path.join(dir, 'test-results', 'junit.xml')), 'JUnit XML written');
    const calls = await new Promise((resolve, reject) => require('http').get(`http://127.0.0.1:${port}/__calls`, res => {
      let t = ''; res.on('data', d => { t += d; }); res.on('end', () => resolve(JSON.parse(t).tokenCalls));
    }).on('error', reject));
    assert.strictEqual(calls, 1, 'the token is fetched once, in global setup');
  } finally {
    server.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

(async () => {
  for (const [name, fn] of queue) {
    try {
      const r = await fn();
      if (r === 'skip') { skipped++; console.log('  skip ' + name); } else { passed++; console.log('  ok  ' + name); }
    } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n       ') : e)); }
  }
  console.log(`\n${passed} passed, ${failed} failed${skipped ? ', ' + skipped + ' skipped' : ''}`);
  process.exit(failed ? 1 : 0);
})();
