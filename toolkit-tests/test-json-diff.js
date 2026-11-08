// Tests for docs/tools/json-diff/diff.js. Run: node toolkit-tests/test-json-diff.js
'use strict';
const path = require('path');
const assert = require('assert');
const D = require(path.join(__dirname, '..', 'docs', 'tools', 'json-diff', 'diff.js'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e)); }
}
const kinds = r => r.diffs.map(d => d.kind + ' ' + d.path).sort();

// ---------------------------------------------------------------- fixtures

const order = () => ({
  orderId: 'ORD-1', status: 'PAID',
  customer: { id: 7, name: 'Mia', address: { city: 'Melbourne', postcode: '3000' } },
  items: [{ sku: 'A', qty: 1, price: 10 }, { sku: 'B', qty: 2, price: 5.5 }, { sku: 'C', qty: 1, price: 3 }],
  total: 24, 'x-trace-id': 'abc',
});

// ---------------------------------------------------------------- tests

test('identical documents have no differences', () => {
  const r = D.diff(order(), order());
  assert.strictEqual(r.total, 0);
  assert.deepStrictEqual(r.counts, { added: 0, removed: 0, changed: 0, type: 0 });
  assert.strictEqual(D.headline(r), 'No differences');
  // key order does not matter
  assert.strictEqual(D.diff({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 }).total, 0);
});

test('nested changes are reported with correct JSON paths', () => {
  const b = order();
  b.items[2].price = 3.5;
  b.customer.address.city = 'Sydney';
  b['x-trace-id'] = 'def';
  const r = D.diff(order(), b);
  assert.deepStrictEqual(kinds(r), ['changed $.customer.address.city', 'changed $.items[2].price', 'changed $["x-trace-id"]']);
  const p = r.diffs.find(d => d.path === '$.items[2].price');
  assert.strictEqual(p.before, 3);
  assert.strictEqual(p.after, 3.5);
});

test('added and removed keys and array items', () => {
  const b = order();
  delete b.customer.name;
  b.customer.email = 'mia@example.com';
  b.items.push({ sku: 'D', qty: 1, price: 1 });
  const r = D.diff(order(), b);
  assert.deepStrictEqual(kinds(r), ['added $.customer.email', 'added $.items[3]', 'removed $.customer.name']);
  assert.strictEqual(r.counts.added, 2);
  assert.strictEqual(r.counts.removed, 1);
  const rem = r.diffs.find(d => d.kind === 'removed');
  assert.strictEqual(rem.before, 'Mia');
  // shorter array: removed from the end
  const r2 = D.diff([1, 2, 3], [1, 2]);
  assert.deepStrictEqual(kinds(r2), ['removed $[2]']);
});

test('type changes are explicit (number -> string, object -> null, root)', () => {
  const b = order();
  b.total = '24.00';
  b.customer.address = null;
  const r = D.diff(order(), b);
  assert.strictEqual(r.counts.type, 2);
  const t = r.diffs.find(d => d.path === '$.total');
  assert.strictEqual(t.kind, 'type');
  assert.strictEqual(t.beforeType, 'number');
  assert.strictEqual(t.afterType, 'string');
  assert.strictEqual(r.diffs.find(d => d.path === '$.customer.address').afterType, 'null');
  const root = D.diff([1], { a: 1 });
  assert.deepStrictEqual(kinds(root), ['type $']);
  assert.strictEqual(root.diffs[0].beforeType, 'array');
});

test('ignore keys: plain names, *.name, $ paths, [*] and name globs', () => {
  const a = { requestId: 'r1', meta: { requestId: 'm1', timestamp: 1, page: 1 }, items: [{ id: 'x', v: 1 }, { id: 'y', v: 2 }], createdAt: 'a', createdBy: 'u1', name: 'n' };
  const b = { requestId: 'r2', meta: { requestId: 'm2', timestamp: 2, page: 1 }, items: [{ id: 'p', v: 1 }, { id: 'q', v: 3 }], createdAt: 'b', createdBy: 'u2', name: 'n' };
  assert.strictEqual(D.diff(a, b).total, 8);
  // plain name matches at any depth
  assert.deepStrictEqual(kinds(D.diff(a, b, { ignoreKeys: 'requestId, timestamp, *.id, created*' })), ['changed $.items[1].v']);
  // $ path is exact: only the nested requestId is ignored
  const r = D.diff(a, b, { ignoreKeys: '$.meta.requestId, $.items[*].id' });
  assert.ok(kinds(r).includes('changed $.requestId'));
  assert.ok(!kinds(r).includes('changed $.meta.requestId'));
  assert.ok(!kinds(r).some(k => /items\[\d\]\.id/.test(k)));
  assert.strictEqual(r.ignored, 3);
  // parent.child suffix
  assert.ok(!kinds(D.diff(a, b, { ignoreKeys: 'meta.requestId' })).includes('changed $.meta.requestId'));
  assert.ok(kinds(D.diff(a, b, { ignoreKeys: 'meta.requestId' })).includes('changed $.requestId'));
  // array form and an ignored key that only exists on one side
  assert.strictEqual(D.diff({ a: 1 }, { a: 1, traceId: 'z' }, { ignoreKeys: ['traceId'] }).total, 0);
});

test('ignore array order: primitives compared as multisets', () => {
  assert.strictEqual(D.diff({ tags: ['a', 'b', 'c'] }, { tags: ['c', 'a', 'b'] }).total, 3);
  assert.strictEqual(D.diff({ tags: ['a', 'b', 'c'] }, { tags: ['c', 'a', 'b'] }, { ignoreOrder: true }).total, 0);
  // duplicates still count
  const r = D.diff([1, 1, 2], [1, 2, 2], { ignoreOrder: true });
  assert.deepStrictEqual(r.counts, { added: 1, removed: 1, changed: 0, type: 0 });
  // nested arrays inside objects in any order
  assert.strictEqual(D.diff([{ t: [1, 2] }, { t: [3] }], [{ t: [3] }, { t: [2, 1] }], { ignoreOrder: true }).total, 0);
});

test('ignore array order: objects matched by key, with the field-level change', () => {
  const a = { results: [{ id: 1, name: 'kit', price: 49 }, { id: 2, name: 'workshop', price: 199 }, { id: 3, name: 'review', price: 450 }] };
  const b = { results: [{ id: 3, name: 'review', price: 450 }, { id: 2, name: 'workshop', price: 249 }, { id: 1, name: 'kit', price: 49 }, { id: 4, name: 'new', price: 1 }] };
  const plain = D.diff(a, b);
  assert.ok(plain.total > 4, 'position-by-position should be noisy');
  const r = D.diff(a, b, { ignoreOrder: true, matchKey: 'id' });
  assert.deepStrictEqual(kinds(r), ['added $.results[3]', 'changed $.results[1].price']);
  const ch = r.diffs.find(d => d.kind === 'changed');
  assert.strictEqual(ch.before, 199);
  assert.strictEqual(ch.after, 249);
  assert.strictEqual(ch.lp, '$.results[1].price');
  assert.strictEqual(ch.ra, '$.results.find((x) => x.id === 2).price');
  // without a key, content matching still pairs the unchanged ones
  const r2 = D.diff(a, b, { ignoreOrder: true });
  assert.strictEqual(r2.counts.changed, 1);
  assert.strictEqual(r2.counts.added, 1);
});

test('numeric tolerance', () => {
  const a = { price: 10, rate: 0.0435, n: [1.0, 2.0] }, b = { price: 10.004, rate: 0.04351, n: [1.009, 2.02] };
  assert.strictEqual(D.diff(a, b).total, 4);
  const r = D.diff(a, b, { tolerance: 0.01 });
  assert.deepStrictEqual(kinds(r), ['changed $.n[1]']);
  // exactly at the tolerance is equal (despite floating point)
  assert.strictEqual(D.diff({ x: 0.1 }, { x: 0.11 }, { tolerance: 0.01 }).total, 0);
  // tolerance also pairs numbers when order is ignored
  assert.strictEqual(D.diff([3.001, 1], [1, 3], { ignoreOrder: true, tolerance: 0.01 }).total, 0);
});

test('null versus missing', () => {
  const a = { nickname: null, a: 1, nested: { x: null } }, b = { a: 1, nested: {}, extra: null };
  assert.deepStrictEqual(kinds(D.diff(a, b)), ['added $.extra', 'removed $.nested.x', 'removed $.nickname']);
  assert.strictEqual(D.diff(a, b, { nullEqualsMissing: true }).total, 0);
  // null versus a value is still a type change
  assert.strictEqual(D.diff({ a: null }, { a: 0 }, { nullEqualsMissing: true }).counts.type, 1);
  // and it applies inside unordered arrays
  assert.strictEqual(D.diff([{ id: 1, n: null }], [{ id: 1 }], { ignoreOrder: true, nullEqualsMissing: true }).total, 0);
});

test('assertion generation: Playwright and k6 lines for the after values', () => {
  const a = { status: 'PAID', total: 49.95, customer: { email: 'm@x.io' }, items: [1, 2], 'x-id': 1, gift: true };
  const b = { status: 'SHIPPED', total: '50.95', customer: { email: 'm@x.io', phone: null }, items: [1, 2, 3], 'x-id': 2 };
  const r = D.diff(a, b);
  const as = D.assertions(r);
  assert.ok(as.playwright.includes('const body = await response.json();'));
  assert.ok(as.playwright.includes('expect(body.status).toBe("SHIPPED");'));
  assert.ok(as.playwright.includes('expect(body.total).toBe("50.95");'));
  assert.ok(as.playwright.includes('expect(body.customer.phone).toBe(null);'));
  assert.ok(as.playwright.includes('expect(body["x-id"]).toBe(2);'));
  assert.ok(as.playwright.includes('expect(body.items).toHaveLength(3);'));
  assert.ok(as.playwright.includes('expect(body.gift).toBeUndefined();'));
  assert.ok(as.k6.startsWith("import { check } from 'k6';"));
  assert.ok(as.k6.includes('check(body, {'));
  assert.ok(as.k6.includes('(b) => b.status === "SHIPPED",'));
  assert.ok(as.k6.includes('(b) => b.items.length === 3,'));
  assert.ok(as.k6.includes('(b) => b.gift === undefined,'));
  // the k6 block is valid JavaScript once the import line is dropped
  new Function('check', 'res', as.k6.replace(/^import .*$/m, ''));
  new Function('expect', 'response', '(async () => {' + as.playwright + '})');
  // tolerance -> range check; key match -> find()
  const r2 = D.diff({ rows: [{ id: 1, v: 1 }, { id: 2, v: 2 }] }, { rows: [{ id: 2, v: 2.5 }, { id: 1, v: 1 }] }, { ignoreOrder: true, matchKey: 'id', tolerance: 0.1 });
  const as2 = D.assertions(r2);
  assert.ok(as2.playwright.includes('expect(Math.abs(body.rows.find((x) => x.id === 2).v - 2.5)).toBeLessThanOrEqual(0.1);'), as2.playwright);
  assert.ok(as2.k6.includes('(b) => Math.abs(b.rows.find((x) => x.id === 2).v - 2.5) <= 0.1,'));
  assert.strictEqual(D.assertions(D.diff(1, 1)).count, 0);
});

test('Markdown and JSON exports', () => {
  const r = D.diff({ a: 1, b: 'x|y' }, { a: '1', b: 'x|z', c: [1] }, { ignoreKeys: 'zzz' });
  const md = D.toMarkdown(r);
  assert.ok(md.startsWith('**JSON diff: 3 differences: 1 changed, 1 type change, 1 added**'));
  assert.ok(md.includes('| Type change | `$.a` | `1 (number)` | `"1" (string)` |'));
  assert.ok(md.includes('`"x\\|y"`'), 'pipes are escaped');
  assert.ok(md.includes('_Options: ignore zzz.'));
  const j = JSON.parse(D.toJSON(r));
  assert.strictEqual(j.summary.total, 3);
  assert.deepStrictEqual(j.differences.find(d => d.path === '$.c'), { change: 'added', path: '$.c', after: [1], afterType: 'array' });
});

test('invalid JSON gives line and column; BOM and whitespace are fine', () => {
  assert.deepStrictEqual(D.parse('﻿ \n {"a": 1}\n\n'), { a: 1 });
  const cases = [
    ['{\n  "a": 1,\n}', 3, 1, /trailing comma/],
    ['{"a": [1, 2 3]}', 1, 13, /expected ',' or ']'/],
    ["{'a': 1}", 1, 2, /double quotes/],
    ['{\n  a: 1\n}', 2, 3, /keys need double quotes/],
    ['{"a": 1} x', 1, 10, /more content/],
    ['{"a": "line\nbreak"}', 1, 12, /line break/],
    ['{"a": NaN}', 1, 7, /NaN/],
    ['{"a": 1', 1, 8, /ends inside an object/],
  ];
  for (const [txt, line, col, re] of cases) {
    try { D.parse(txt, 'After'); assert.fail('should throw: ' + txt); }
    catch (e) {
      assert.ok(e.message.startsWith('After is not valid JSON'), e.message);
      assert.strictEqual(e.line, line, txt + ' -> ' + e.message);
      assert.strictEqual(e.col, col, txt + ' -> ' + e.message);
      assert.ok(re.test(e.message), e.message);
    }
  }
  const r = D.run('', '{"a":', {});
  assert.strictEqual(r.errors.length, 2);
  assert.ok(r.errors[0].empty);
});

test('side-by-side view marks changed, added, removed and ignored lines', () => {
  const r = D.run(JSON.stringify({ a: 1, b: 2, ts: 1 }), JSON.stringify({ a: 1, b: 3, c: 4, ts: 2 }), { ignoreKeys: 'ts' }, { context: 0 });
  const right = r.view.right.full;
  const cls = t => right.find(x => x[2].includes(t))[1];
  assert.strictEqual(cls('"b": 3'), 'chg');
  assert.strictEqual(cls('"c": 4'), 'add');
  assert.strictEqual(cls('"ts": 2'), 'ign');
  assert.strictEqual(cls('"a": 1'), '');
  assert.ok(r.view.right.context.some(x => x[1] === 'gap'));
  assert.ok(r.view.left.full.every(x => x[1] !== 'add'));
});

test('5 MB documents compare in under 2 s', () => {
  const mk = (seed) => {
    const items = [];
    for (let i = 0; i < 33000; i++) {
      items.push({ id: i, sku: 'SKU-' + i, name: 'Product number ' + i, price: +(i * 1.13 % 500).toFixed(2), stock: (i * 7) % 90,
        tags: ['a', 'b', 'c'].slice(0, 1 + (i % 3)), meta: { updatedAt: '2026-11-0' + (seed + 1) + 'T00:00:00Z', ok: i % 2 === 0 } });
    }
    return { requestId: 'r' + seed, count: items.length, items };
  };
  const a = mk(0), b = mk(1);
  for (let i = 0; i < 33000; i += 1000) b.items[i].price += 1;
  const ta = JSON.stringify(a), tb = JSON.stringify(b);
  assert.ok(ta.length > 5e6, 'input is ' + (ta.length / 1e6).toFixed(2) + ' MB');
  const t0 = Date.now();
  const r = D.run(ta, tb, { ignoreKeys: 'requestId, updatedAt' });
  const ms = Date.now() - t0;
  assert.strictEqual(r.result.counts.changed, 33);
  assert.strictEqual(r.result.total, 33);
  assert.ok(ms < 2000, 'took ' + ms + ' ms');
  // unordered + key match on the same data
  b.items.reverse();
  const t1 = Date.now();
  const r2 = D.run(ta, JSON.stringify(b), { ignoreKeys: 'requestId, updatedAt', ignoreOrder: true, matchKey: 'id' }, false);
  const ms2 = Date.now() - t1;
  assert.strictEqual(r2.result.total, 33);
  assert.ok(ms2 < 2000, 'unordered took ' + ms2 + ' ms');
  console.log('       (' + (ta.length / 1e6).toFixed(1) + ' MB: ' + ms + ' ms with view, ' + ms2 + ' ms unordered)');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
