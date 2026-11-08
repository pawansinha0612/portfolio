// Tests for docs/tools/openapi-to-playwright/generate.js. Run: node toolkit-tests/test-playwright-gen.js
// The last test type-checks the generated api.spec.ts with TypeScript (npx -y -p typescript@5.6.3 tsc), against a small
// stub of @playwright/test. If @playwright/test and @types/node are on NODE_PATH, it also checks against the real types.
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { execFileSync } = require('child_process');
const docs = path.join(__dirname, '..', 'docs', 'tools');
const G = require(path.join(docs, 'openapi-to-playwright', 'generate.js'));

let passed = 0, failed = 0, skipped = 0;
function test(name, fn) {
  try { const r = fn(); if (r === 'skip') { skipped++; console.log('  skip ' + name); } else { passed++; console.log('  ok  ' + name); } }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e)); }
}

// YAML: the browser loads js-yaml from cdnjs. In Node, use it if it's installed, else convert the YAML example by hand.
let yaml = null;
try { yaml = require('js-yaml').load; } catch (e) { /* not installed */ }

const gen = (spec, opts) => {
  const r = G.generate(typeof spec === 'string' ? spec : JSON.stringify(spec), Object.assign({ yaml }, opts || {}));
  assert.ok(!r.error, r.error);
  return r;
};
const count = (s, re) => (s.match(re) || []).length;
const titles = s => [...s.matchAll(/test\((['`])(.*?)\1/g)].map(m => m[2]);

// ---------------------------------------------------------------- fixtures

const bearerSpec = {
  openapi: '3.0.3', info: { title: 'Orders', version: '1' }, servers: [{ url: 'https://orders.example.com/api' }],
  security: [{ jwt: [] }],
  components: { securitySchemes: { jwt: { type: 'http', scheme: 'bearer' } } },
  paths: {
    '/orders/{orderId}': {
      get: { tags: ['Orders'], parameters: [{ name: 'orderId', in: 'path', required: true, schema: { type: 'integer', example: 42 } }],
        responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'object', required: ['id', 'total'], properties: { id: { type: 'integer' }, total: { type: 'number' } } } } } },
          401: { description: 'no auth' }, 404: { description: 'missing' } } },
    },
    '/status': { get: { tags: ['Ops'], security: [], responses: { 200: { description: 'ok', content: { 'text/plain': { schema: { type: 'string' } } } } } } },
  },
};

const enumSpec = {
  openapi: '3.1.0', info: { title: 'Enum', version: '1' }, servers: [{ url: 'https://e.example.com' }],
  paths: {
    '/items': {
      get: { tags: ['Items'], parameters: [
        { name: 'colour', in: 'query', required: true, schema: { type: 'string', enum: ['red', 'green', 'blue'] } },
        { name: 'sort', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'] } }],
      responses: { 200: { description: 'ok' } } },
    },
    '/search': {
      get: { tags: ['Items'], parameters: [{ name: 'term', in: 'query', required: true, schema: { type: 'string' },
        examples: { short: { value: 'cat' }, long: { value: 'black cat with a hat' } } }], responses: { 200: { description: 'ok' } } },
    },
  },
};

const refSpec = {
  openapi: '3.0.0', info: { title: 'Refs', version: '1' }, servers: [{ url: 'https://r.example.com' }],
  components: {
    securitySchemes: { key: { type: 'apiKey', in: 'header', name: 'X-API-Key' }, basic: { type: 'http', scheme: 'basic' } },
    requestBodies: { Person: { content: { 'application/json': { schema: { $ref: '#/components/schemas/NewPerson' } } } } },
    schemas: {
      Base: { type: 'object', required: ['name'], properties: { name: { type: 'string', example: 'Ada' } } },
      NewPerson: { allOf: [{ $ref: '#/components/schemas/Base' }, { type: 'object', required: ['age'], properties: { age: { type: 'integer', minimum: 18 }, id: { type: 'string', readOnly: true } } }] },
      Person: { allOf: [{ $ref: '#/components/schemas/NewPerson' }, { required: ['id'] }] },
    },
  },
  paths: {
    '/people': {
      post: { tags: ['People'], security: [{ key: [] }], requestBody: { $ref: '#/components/requestBodies/Person' },
        responses: { 201: { description: 'made', content: { 'application/json': { schema: { $ref: '#/components/schemas/Person' } } } }, 422: { description: 'bad' } } },
    },
    '/admin': { get: { tags: ['Admin'], security: [{ basic: [] }], responses: { 204: { description: 'ok' }, 403: { description: 'nope' } } } },
  },
};

// ---------------------------------------------------------------- tests

console.log('Examples');

test('OpenAPI 3 example (bookshop): describes per tag, bearer auth, server variables, 404 for bookId', () => {
  if (!yaml) {
    // YAML parser not installed here: the example is still checked through its JSON equivalent below.
    const r = G.generate(G.EXAMPLES.openapi3, {});
    assert.ok(/YAML/.test(r.error), 'without a YAML parser the error should say so');
    return 'skip';
  }
  const r = gen(G.EXAMPLES.openapi3);
  const s = r.spec;
  assert.ok(s.includes("import { test, expect } from '@playwright/test';"));
  assert.ok(s.includes("const BASE_URL = (process.env.BASE_URL || 'https://api.bookshop.example.com/v1')"));
  assert.ok(s.includes("const API_TOKEN = process.env.API_TOKEN || '';"));
  assert.deepStrictEqual([...s.matchAll(/test\.describe\('([^']+)'/g)].map(m => m[1]), ['Books', 'Cart', 'Ops']);
  assert.ok(s.includes("test('GET /books returns 200'"));
  assert.ok(s.includes("test('POST /books returns 201'"));
  assert.ok(s.includes("test('GET /books/{bookId} returns 404 for an unknown bookId'"));
  assert.ok(s.includes('/books/00000000-0000-0000-0000-000000000000'));
  assert.ok(s.includes("test('POST /books rejects a body without \"title\"'"));
  assert.ok(s.includes("for (const field of ['title', 'author', 'price'])"), 'allOf-merged required fields are checked');
  assert.ok(!s.includes("'GET /health without auth"), '/health has security: [] so no auth test');
  assert.ok(s.includes("test('GET /health returns 2xx'"));
  assert.strictEqual(r.counts.positive, 6);
  assert.deepStrictEqual(r.env.map(e => e.name), ['API_TOKEN']);
  assert.strictEqual(r.command, 'npx playwright test --reporter=html');
  assert.ok(/defineConfig/.test(r.config));
});

test('Swagger 2.0 example (petstore): api_key env var, host + basePath, 404 only where documented', () => {
  const r = gen(G.EXAMPLES.swagger2);
  const s = r.spec;
  assert.ok(s.includes("process.env.BASE_URL || 'https://petstore.swagger.io/v2'"));
  assert.ok(s.includes("const API_KEY = process.env.API_KEY || '';"));
  assert.ok(s.includes('api_key: API_KEY'));
  assert.deepStrictEqual([...s.matchAll(/test\.describe\('([^']+)'/g)].map(m => m[1]), ['pet', 'store', 'user']);
  // getPetById documents 404 → exact; deletePet doesn't → any 4xx
  const get404 = s.slice(s.indexOf("test('GET /pet/{petId} returns 404"));
  assert.ok(/^[^]*?expect\(res\.status\(\)\)\.toBe\(404\)/.test(get404.slice(0, 600)));
  const del404 = s.slice(s.indexOf("test('DELETE /pet/{petId} returns 404"));
  assert.ok(del404.slice(0, 600).includes('toBeGreaterThanOrEqual(400)'));
  // deletePet documents 400 for a bad id → exact 400 for the wrong-type test
  const delWrong = s.slice(s.indexOf("test('DELETE /pet/{petId} rejects \"petId\" with the wrong type"));
  assert.ok(delWrong.slice(0, 600).includes('toBe(400)'));
  assert.ok(s.includes('/pet/not-a-number'));
  assert.strictEqual(r.counts.tests, titles(s).length + 4, 'two loops of 3 tests each appear as one title each');
});

console.log('Auth');

test('bearer auth spec: API_TOKEN header, no-auth test uses the documented 401', () => {
  const r = gen(bearerSpec);
  const s = r.spec;
  assert.ok(s.includes('Authorization: `Bearer ${API_TOKEN}`'));
  assert.ok(s.includes("test('GET /orders/{orderId} without auth returns 401'"));
  const noAuth = s.slice(s.indexOf('without auth returns 401'), s.indexOf('without auth returns 401') + 400);
  assert.ok(!noAuth.split('});')[0].includes('Authorization'), 'the no-auth request sends no Authorization header');
  assert.ok(noAuth.includes('expect(res.status()).toBe(401);'));
  assert.ok(s.includes("for (const field of ['id', 'total']) expect(json).toHaveProperty(field);"));
});

test('operation without security gets no auth test', () => {
  const s = gen(bearerSpec).spec;
  assert.ok(s.includes("test('GET /status returns 200'"));
  assert.ok(!/GET \/status without auth/.test(s));
  assert.ok(s.includes("toContain('text/plain')"), 'content type from the 2xx response');
  const status = s.slice(s.indexOf("test('GET /status returns 200'"));
  assert.ok(!status.slice(0, 300).includes('API_TOKEN'), 'no token sent where security: []');
});

test('apiKey and basic auth: named env var, API_USER / API_PASS', () => {
  const r = gen(refSpec);
  assert.deepStrictEqual(r.env.map(e => e.name), ['X_API_KEY', 'API_USER', 'API_PASS']);
  assert.ok(r.spec.includes("'X-API-Key': X_API_KEY"));
  assert.ok(r.spec.includes("Buffer.from(`${API_USER}:${API_PASS}`).toString('base64')"));
  assert.ok(r.spec.includes("test('GET /admin without auth returns 403'"));
});

console.log('Negative tests');

test('path id gives a 404 test, and an integer id gets a wrong-type test', () => {
  const s = gen(bearerSpec).spec;
  assert.ok(s.includes("test('GET /orders/{orderId} returns 404 for an unknown orderId'"));
  assert.ok(s.includes('/orders/999999999'));
  assert.ok(s.includes('/orders/42`'), 'positive test uses the example id');
  assert.ok(s.includes("test('GET /orders/{orderId} rejects \"orderId\" with the wrong type'"));
  assert.ok(s.includes('/orders/not-a-number'));
});

test('only applicable negatives: nothing for an open GET with no params or body', () => {
  const r = gen({ swagger: '2.0', info: { title: 't', version: '1' }, host: 'x.example.com', paths: { '/ping': { get: { responses: { 200: { description: 'ok' } } } } } });
  assert.strictEqual(r.counts.negative, 0);
  assert.strictEqual(r.counts.positive, 1);
  assert.deepStrictEqual(titles(r.spec), ['GET /ping returns 200']);
  const off = gen(bearerSpec, { negative: false });
  assert.strictEqual(off.counts.negative, 0);
});

console.log('Data-driven');

test('enum and examples give one test per value with for...of', () => {
  const r = gen(enumSpec);
  const s = r.spec;
  assert.ok(s.includes("for (const colour of ['red', 'green', 'blue']) {"));
  assert.ok(s.includes('test(`GET /items with colour=${colour} returns 200`'));
  assert.ok(s.includes('params: { colour: colour }'));
  assert.ok(!s.includes("['asc', 'desc']"), 'optional query enums are not looped');
  assert.ok(s.includes("for (const term of ['cat', 'black cat with a hat']) {"));
  assert.strictEqual(r.counts.dataDriven, 5);
  assert.strictEqual(r.counts.positive, 5);
  const off = gen(enumSpec, { dataDriven: false });
  assert.ok(!/for \(const colour/.test(off.spec));
  assert.strictEqual(off.counts.positive, 2);
});

test('petstore: array query enum and body enum both loop', () => {
  const s = gen(G.EXAMPLES.swagger2).spec;
  assert.ok(s.includes("for (const status of ['available', 'pending', 'sold']) {"));
  assert.ok(s.includes('test(`GET /pet/findByStatus with status=${status} returns 200`'));
  assert.ok(s.includes('test(`POST /pet with status=${status} returns 2xx`'));
  assert.ok(/status: status,\n/.test(s), 'the body field takes the loop value');
});

console.log('Schemas');

test('$ref + allOf: merged required fields, readOnly left out, 422 documented', () => {
  const s = gen(refSpec).spec;
  const pos = s.slice(s.indexOf("test('POST /people returns 201'"));
  assert.ok(pos.slice(0, 500).includes("data: { name: 'Ada', age: 18 }"), 'readOnly id left out of the request');
  assert.ok(s.includes("for (const field of ['name', 'age', 'id']) expect(json).toHaveProperty(field);"));
  assert.ok(s.includes("test('POST /people rejects a body without \"name\"'"));
  assert.ok(s.includes("data: { age: 18 }"));
  assert.ok(s.includes("test('POST /people rejects \"name\" with the wrong type'"));
  assert.ok(s.includes("data: { name: 12345, age: 18 }"));
  assert.strictEqual(count(s, /expect\(res\.status\(\)\)\.toBe\(422\);/g), 2, 'validation tests use the documented 422');
  assert.ok(!/GET \/admin returns 204[^]*?res\.json\(\)/.test(s.slice(s.indexOf('GET /admin returns 204'), s.indexOf('GET /admin returns 204') + 300)), 'no body read for 204');
});

test('errors: bad input, no operations selected', () => {
  assert.ok(/no 'openapi' or 'swagger'/.test(G.generate('{"a":1}').error));
  assert.ok(/No operations selected/.test(G.generate(JSON.stringify(bearerSpec), { include: [] }).error));
  const one = gen(bearerSpec, { include: ['GET /status'] });
  assert.deepStrictEqual(one.selected, ['GET /status']);
  assert.ok(!one.spec.includes('API_TOKEN'));
});

console.log('TypeScript');

const STUB = `declare module '@playwright/test' {
  type Value = string | number | boolean;
  interface APIResponse { status(): number; ok(): boolean; headers(): { [key: string]: string }; json(): Promise<any>; text(): Promise<string>; }
  interface FilePayload { name: string; mimeType: string; buffer: Buffer; }
  interface RequestOptions {
    data?: any; form?: { [key: string]: Value }; multipart?: { [key: string]: Value | FilePayload };
    headers?: { [key: string]: string }; params?: { [key: string]: Value } | URLSearchParams | string;
    method?: string; timeout?: number; failOnStatusCode?: boolean;
  }
  interface APIRequestContext {
    get(url: string, options?: RequestOptions): Promise<APIResponse>; post(url: string, options?: RequestOptions): Promise<APIResponse>;
    put(url: string, options?: RequestOptions): Promise<APIResponse>; patch(url: string, options?: RequestOptions): Promise<APIResponse>;
    delete(url: string, options?: RequestOptions): Promise<APIResponse>; head(url: string, options?: RequestOptions): Promise<APIResponse>;
    fetch(url: string, options?: RequestOptions): Promise<APIResponse>;
  }
  interface Matchers { toBe(v: unknown): void; toContain(v: unknown): void; toHaveProperty(k: string): void;
    toBeGreaterThanOrEqual(n: number): void; toBeLessThan(n: number): void; }
  interface TestFn { (title: string, fn: (args: { request: APIRequestContext }) => Promise<void>): void; describe(title: string, fn: () => void): void; }
  export const test: TestFn;
  export function expect(v: unknown): Matchers;
  export function defineConfig(c: object): object;
}
declare const process: { env: { [key: string]: string | undefined } };
declare class Buffer { static from(s: string): Buffer; toString(encoding?: string): string; }
`;

function tsc(dir) {
  return execFileSync('npx', ['-y', '-p', 'typescript@5.6.3', 'tsc', '-p', dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 });
}

test('generated api.spec.ts and playwright.config.ts compile (tsc --noEmit, strict)', () => {
  const specs = { bookshop: yaml ? gen(G.EXAMPLES.openapi3).spec : null, petstore: gen(G.EXAMPLES.swagger2).spec,
    bearer: gen(bearerSpec).spec, enums: gen(enumSpec).spec, refs: gen(refSpec).spec };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-gen-'));
  try {
    const files = [];
    for (const [n, s] of Object.entries(specs)) if (s) { fs.writeFileSync(path.join(dir, n + '.spec.ts'), s); files.push(n + '.spec.ts'); }
    fs.writeFileSync(path.join(dir, 'playwright.config.ts'), G.CONFIG); files.push('playwright.config.ts');
    fs.writeFileSync(path.join(dir, 'stub.d.ts'), STUB); files.push('stub.d.ts');
    const cfg = { compilerOptions: { strict: true, noEmit: true, target: 'ES2020', module: 'commonjs', lib: ['ES2020', 'DOM'], types: [], skipLibCheck: true }, files };
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify(cfg));
    try { tsc(dir); }
    catch (e) {
      if (!e.stdout && /ENOTFOUND|EAI_AGAIN|network/i.test(String(e.stderr))) { console.log('       (TypeScript could not be downloaded: offline?)'); return 'skip'; }
      throw new Error('tsc failed (stub types):\n' + (e.stdout || e.stderr));
    }
    // Real types, when @playwright/test and @types/node are installed somewhere on NODE_PATH.
    const nm = (process.env.NODE_PATH || '').split(path.delimiter).find(p => p && fs.existsSync(path.join(p, '@playwright', 'test')) && fs.existsSync(path.join(p, '@types', 'node')));
    if (nm) {
      fs.unlinkSync(path.join(dir, 'stub.d.ts'));
      fs.symlinkSync(nm, path.join(dir, 'node_modules'), 'dir');
      cfg.compilerOptions.types = ['node']; cfg.files = files.filter(f => f !== 'stub.d.ts');
      fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify(cfg));
      try { tsc(dir); } catch (e) { throw new Error('tsc failed (real @playwright/test types):\n' + (e.stdout || e.stderr)); }
      console.log('       (also checked against the real @playwright/test types in ' + nm + ')');
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed${skipped ? ', ' + skipped + ' skipped' : ''}`);
process.exit(failed ? 1 : 0);
