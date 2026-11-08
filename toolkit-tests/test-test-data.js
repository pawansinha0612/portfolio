// Tests for docs/tools/test-data/generate.js. Run: node toolkit-tests/test-test-data.js
'use strict';
const path = require('path');
const assert = require('assert');
const T = require(path.join(__dirname, '..', 'docs', 'tools', 'test-data', 'generate.js'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e)); }
}

const TPL = T.templates(2026);
const gen = (tpl, rows, seed) => T.generate({ rows, seed: seed == null ? 'test' : seed, columns: TPL[tpl].columns });

// Minimal RFC 4180 parser, independent of the code under test.
function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { f += '"'; i++; }
      else if (c === '"') q = false;
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}

// Australian postcode ranges by state (Australia Post)
function stateForPostcode(pc) {
  const n = +pc;
  if (n >= 800 && n <= 899) return 'NT';
  if ((n >= 200 && n <= 299) || (n >= 2600 && n <= 2618) || (n >= 2900 && n <= 2920)) return 'ACT';
  if (n >= 1000 && n <= 2999) return 'NSW';
  if (n >= 3000 && n <= 3999) return 'VIC';
  if (n >= 4000 && n <= 4999) return 'QLD';
  if (n >= 5000 && n <= 5799) return 'SA';
  if (n >= 6000 && n <= 6797) return 'WA';
  if (n >= 7000 && n <= 7799) return 'TAS';
  return '?';
}

// ---------------------------------------------------------------- tests

test('same seed gives the same data, a different seed gives different data', () => {
  for (const k of Object.keys(TPL)) {
    const a = T.toCSV(gen(k, 500, 'seed-1')), b = T.toCSV(gen(k, 500, 'seed-1')), c = T.toCSV(gen(k, 500, 'seed-2'));
    assert.strictEqual(a, b, k + ' not reproducible');
    assert.notStrictEqual(a, c, k + ' ignores the seed');
  }
});

test('emails and ids are unique across 50k rows', () => {
  const r = gen('users', 50000);
  assert.strictEqual(new Set(r.rows.map(x => x.email)).size, 50000);
  assert.strictEqual(new Set(r.rows.map(x => x.id)).size, 50000);
  assert.ok(r.rows.every(x => /^[a-z0-9._]+@example\.(com|net|org)$/.test(x.email)), 'emails use reserved domains');
  const u = T.generate({ rows: 50000, seed: 'u', columns: [{ name: 'id', type: 'id', mode: 'uuid' }, { name: 'e', type: 'email' }] });
  assert.strictEqual(new Set(u.rows.map(x => x.id)).size, 50000);
  assert.ok(u.rows.every(x => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x.id)), 'UUID v4 format');
  assert.strictEqual(new Set(u.rows.map(x => x.e)).size, 50000);
});

test('emails are built from the same row\'s name', () => {
  const r = gen('users', 2000);
  for (const x of r.rows) {
    const f = x.first_name.toLowerCase().replace(/[^a-z]/g, ''), l = x.last_name.toLowerCase().replace(/[^a-z]/g, '');
    const local = x.email.split('@')[0].replace(/\d+$/, '');
    assert.ok([f + '.' + l, f + l, f[0] + '.' + l, f + '_' + l].includes(local), x.email + ' vs ' + x.first_name + ' ' + x.last_name);
  }
});

test('test cards pass Luhn (public list and test-BIN mode), and brand and CVV match', () => {
  for (const [n] of T.PUBLIC_CARDS) assert.ok(T.luhnValid(n), n);
  const pub = gen('cards', 2000);
  const known = new Set(T.PUBLIC_CARDS.map(c => c[0]));
  for (const x of pub.rows) {
    assert.ok(known.has(x.test_card_number), 'only public test numbers');
    assert.strictEqual(T.PUBLIC_CARDS.find(c => c[0] === x.test_card_number)[1], x.brand);
    assert.strictEqual(x.cvv.length, x.brand === 'Amex' ? 4 : 3);
    assert.ok(/^(0[1-9]|1[0-2])\/(2[7-9]|3[01])$/.test(x.expiry), x.expiry);
  }
  const cols = TPL.cards.columns.map(c => c.type === 'cardNumber' ? Object.assign({}, c, { mode: 'luhn', unique: true }) : c);
  const lu = T.generate({ rows: 5000, seed: 'l', columns: cols });
  for (const x of lu.rows) {
    assert.ok(T.luhnValid(x.test_card_number), x.test_card_number);
    assert.ok(/^(411111|424242|555555|510510|222300|378282|371449)/.test(x.test_card_number), 'test BIN');
    assert.strictEqual(x.test_card_number.length, x.brand === 'Amex' ? 15 : 16);
  }
  assert.strictEqual(new Set(lu.rows.map(x => x.test_card_number)).size, 5000);
  assert.ok(!T.luhnValid('4111111111111112'));
});

test('fake TFN and Medicare numbers always fail the official checksum', () => {
  const r = gen('negative', 20000);
  for (const x of r.rows) {
    assert.ok(/^\d{3} \d{3} \d{3}$/.test(x.fake_tfn), x.fake_tfn);
    assert.ok(!T.tfnValid(x.fake_tfn), 'valid TFN produced: ' + x.fake_tfn);
    assert.ok(/^[2-6]\d{3} \d{5} [1-9]$/.test(x.fake_medicare), x.fake_medicare);
    assert.ok(!T.medicareValid(x.fake_medicare), 'valid Medicare produced: ' + x.fake_medicare);
  }
  // the checkers themselves accept known-good examples (ATO sample TFN 123 456 782, Medicare 2123 45670 1)
  assert.ok(T.tfnValid('123 456 782'));
  assert.ok(T.medicareValid('2123 45670 1'));
});

test('order lines add up to the order total', () => {
  const r = gen('orders', 20000);
  const orders = new Map();
  for (const x of r.rows) {
    assert.strictEqual(Math.round(x.quantity * x.unit_price * 100), Math.round(x.line_total * 100), 'line total');
    if (!orders.has(x.order_id)) orders.set(x.order_id, []);
    orders.get(x.order_id).push(x);
  }
  assert.ok(orders.size > 5000 && orders.size < 20000, 'orders have several lines: ' + orders.size);
  for (const [id, lines] of orders) {
    const sum = lines.reduce((s, l) => s + Math.round(l.line_total * 100), 0);
    for (const l of lines) assert.strictEqual(Math.round(l.order_total * 100), sum, id);
    lines.forEach((l, i) => assert.strictEqual(l.line_no, i + 1));
    // order-level fields are the same on every line
    assert.strictEqual(new Set(lines.map(l => l.customer_email + l.order_date + l.status)).size, 1, id);
    assert.strictEqual(new Set(lines.map(l => l.sku)).size, lines.length, 'no repeated SKU in one order');
  }
  // the CSV text shows money with two decimals
  const csv = parseCsv(T.toCSV({ columns: r.columns, rows: r.rows.slice(0, 50) }));
  const i = csv[0].indexOf('order_total');
  assert.ok(csv.slice(1).every(row => /^\d+\.\d\d$/.test(row[i])));
});

test('postcode and state always match, and suburbs are real combinations', () => {
  const r = gen('users', 20000);
  const real = new Set(T.SUBURBS.map(s => s.join('|')));
  const states = new Set();
  for (const x of r.rows) {
    assert.ok(real.has([x.suburb, x.state, x.postcode].join('|')), x.suburb + ' ' + x.state + ' ' + x.postcode);
    assert.strictEqual(stateForPostcode(x.postcode), x.state, x.suburb + ' ' + x.postcode);
    states.add(x.state);
  }
  assert.strictEqual(states.size, 8, 'all states and territories appear');
  assert.ok(T.SUBURBS.length >= 100);
  for (const s of T.SUBURBS) assert.strictEqual(stateForPostcode(s[2]), s[1], 'built-in list: ' + s.join(' '));
  // unique suburbs still keep their state and postcode
  const u = T.generate({ rows: 50, seed: 's', columns: [{ name: 'suburb', type: 'suburb', unique: true }, { name: 'state', type: 'state' }, { name: 'postcode', type: 'postcode' }] });
  assert.strictEqual(new Set(u.rows.map(x => x.suburb)).size, 50);
  for (const x of u.rows) assert.ok(real.has([x.suburb, x.state, x.postcode].join('|')));
});

test('CSV escapes commas, quotes and newlines (round trip)', () => {
  const nasty = ['plain', 'a,b', 'say "hi"', 'line1\nline2', "O'Brien", ' padded ', 'crlf\r\nx', ''];
  const r = T.generate({ rows: 400, seed: 'c', columns: [
    { name: 'v', type: 'enum', values: nasty },
    { name: 'note, with comma', type: 'constant', value: 'x' },
    { name: 'addr', type: 'address' },
  ] });
  const csv = T.toCSV(r);
  const back = parseCsv(csv);
  assert.deepStrictEqual(back[0], ['v', 'note, with comma', 'addr']);
  assert.strictEqual(back.length, 401);
  back.slice(1).forEach((row, i) => {
    assert.strictEqual(row.length, 3);
    assert.strictEqual(row[0], r.rows[i].v);
    assert.strictEqual(row[2], r.rows[i].addr);
  });
  assert.ok(csv.includes('"say ""hi"""'));
  assert.ok(T.csvNeedsQuotes(r));
  assert.ok(!T.csvNeedsQuotes(gen('credentials', 1000)), 'credentials CSV needs no quotes, so JMeter defaults work');
  assert.strictEqual(T.csvField('a;b', ';'), '"a;b"');
});

test('SQL escapes quotes and writes typed values', () => {
  const r = T.generate({ rows: 3, seed: 'q', columns: [
    { name: 'name', type: 'enum', values: ["O'Brien"] },
    { name: 'n', type: 'int', min: 5, max: 5 },
    { name: 'price', type: 'decimal', min: 1.5, max: 1.5, dp: 2 },
    { name: 'ok', type: 'bool', pct: 100 },
    { name: 'order date', type: 'date', min: '2025-01-02', max: '2025-01-02' },
  ] });
  const sql = T.toSQL(r, { table: 'app.users' });
  assert.ok(sql.startsWith('INSERT INTO app.users (name, n, price, ok, "order date") VALUES\n'), sql);
  assert.ok(sql.includes("('O''Brien', 5, 1.50, TRUE, '2025-01-02')"), sql);
  assert.strictEqual((sql.match(/'/g) || []).length % 2, 0, 'quotes are balanced');
  // dialects: identifier quoting, booleans, backslashes
  const odd = { columns: [{ name: 'a b' }, { name: 'ok' }], rows: [{ 'a b': "it's C:\\temp", ok: false }] };
  assert.ok(T.toSQL(odd, { table: 't', dialect: 'mysql' }).includes("(`a b`, ok) VALUES\n  ('it''s C:\\\\temp', FALSE);"));
  assert.ok(T.toSQL(odd, { table: 't', dialect: 'sqlserver' }).includes("([a b], ok) VALUES\n  ('it''s C:\\temp', 0);"));
  assert.ok(T.toSQL(odd, { table: 't' }).includes('("a b", ok) VALUES\n  (\'it\'\'s C:\\temp\', FALSE);'));
  // batching
  const big = T.toSQL(gen('users', 1201), { table: 'users', batch: 500 });
  assert.strictEqual((big.match(/INSERT INTO users /g) || []).length, 3);
  assert.strictEqual((big.match(/;\n/g) || []).length, 3);
  // JSON keeps numbers and booleans typed
  const j = JSON.parse(T.toJSON(r));
  assert.deepStrictEqual(j[0], { name: "O'Brien", n: 5, price: 1.5, ok: true, 'order date': '2025-01-02' });
});

test('patterns: literals, # ? *, classes, repeats and uniqueness', () => {
  const r = T.generate({ rows: 5000, seed: 'p', columns: [
    { name: 'a', type: 'pattern', pattern: 'ABC-####', unique: true },
    { name: 'b', type: 'pattern', pattern: '[A-F]{2}\\d{3}-?*' },
    { name: 'c', type: 'pattern', pattern: 'INV-[0-9]{2,4}\\#' },
  ] });
  assert.ok(r.rows.every(x => /^ABC-\d{4}$/.test(x.a)));
  assert.strictEqual(new Set(r.rows.map(x => x.a)).size, 5000);
  assert.ok(r.rows.every(x => /^[A-F]{2}\d{3}-[A-Z][A-Z0-9]$/.test(x.b)), r.rows[0].b);
  assert.ok(r.rows.every(x => /^INV-\d{2,4}#$/.test(x.c)), r.rows[0].c);
  assert.strictEqual(new Set(r.rows.map(x => x.c.length)).size, 3, 'variable repeat uses every length');
  assert.strictEqual(T.patternCapacity(T.parsePattern('ABC-####')), 10000);
  // unique pattern can use its whole space
  const full = T.generate({ rows: 1000, seed: 'f', columns: [{ name: 'a', type: 'pattern', pattern: 'X###', unique: true }] });
  assert.strictEqual(new Set(full.rows.map(x => x.a)).size, 1000);
  assert.throws(() => T.parsePattern('[A-Z'), /Missing \]/);
});

test('"not enough unique values" error', () => {
  const cases = [
    [{ name: 'code', type: 'pattern', pattern: 'ABC-##', unique: true }, 100],
    [{ name: 'tier', type: 'enum', values: 'Gold, Silver', unique: true }, 2],
    [{ name: 'age', type: 'int', min: 18, max: 30, unique: true }, 13],
    [{ name: 'day', type: 'date', min: '2025-01-01', max: '2025-01-31', unique: true }, 31],
    [{ name: 'flag', type: 'bool', unique: true }, 2],
    [{ name: 'card', type: 'cardNumber', mode: 'public', unique: true }, T.PUBLIC_CARDS.length],
  ];
  for (const [col, cap] of cases) {
    // exactly at capacity works
    const ok = T.generate({ rows: cap, seed: 'e', columns: [col] });
    assert.strictEqual(new Set(ok.rows.map(x => String(x[col.name]))).size, cap, col.name);
    // one more fails with a clear message
    assert.throws(() => T.generate({ rows: cap + 1, seed: 'e', columns: [col] }), e =>
      e.code === 'NOT_ENOUGH_UNIQUE' && e.column === col.name && e.capacity === cap && /can make/.test(e.message), col.name);
  }
  // without unique the same column is fine
  T.generate({ rows: 1000, seed: 'e', columns: [{ name: 'tier', type: 'enum', values: 'Gold, Silver' }] });
});

test('input validation', () => {
  assert.throws(() => T.generate({ rows: 0, columns: [{ name: 'a', type: 'int' }] }), /between 1 and 100,000/);
  assert.throws(() => T.generate({ rows: 100001, columns: [{ name: 'a', type: 'int' }] }), /between 1 and 100,000/);
  assert.throws(() => T.generate({ rows: 1, columns: [] }), /at least one column/);
  assert.throws(() => T.generate({ rows: 1, columns: [{ name: 'a', type: 'int' }, { name: 'a', type: 'int' }] }), /Two columns/);
  assert.throws(() => T.generate({ rows: 1, columns: [{ name: 'a', type: 'int', min: 5, max: 1 }] }), /max is below min/);
  assert.throws(() => T.generate({ rows: 1, columns: [{ name: 'a', type: 'date', min: '2025-13-45' }] }), /date/i);
});

test('passwords meet the rules, ranges and percentages hold', () => {
  const r = T.generate({ rows: 10000, seed: 'pw', columns: [
    { name: 'pw', type: 'password', length: 12 },
    { name: 'pin', type: 'password', length: 6, upper: false, lower: false, symbol: false },
    { name: 'n', type: 'int', min: -3, max: 3 },
    { name: 'd', type: 'decimal', min: 0.5, max: 0.6, dp: 3 },
    { name: 'b', type: 'bool', pct: 25 },
    { name: 'm', type: 'mobile' },
    { name: 't', type: 'enum', values: 'a, b', weights: '9, 1' },
  ] });
  for (const x of r.rows) {
    assert.ok(x.pw.length === 12 && /[A-Z]/.test(x.pw) && /[a-z]/.test(x.pw) && /\d/.test(x.pw) && /[^A-Za-z0-9]/.test(x.pw), x.pw);
    assert.ok(!/^[=+\-@]/.test(x.pw), 'no formula-like first character');
    assert.ok(/^\d{6}$/.test(x.pin));
    assert.ok(x.n >= -3 && x.n <= 3 && Number.isInteger(x.n));
    assert.ok(x.d >= 0.5 && x.d <= 0.6);
    assert.ok(/^04\d\d \d{3} \d{3}$/.test(x.m), x.m);
  }
  const t = r.rows.filter(x => x.b).length / r.rows.length;
  assert.ok(t > 0.22 && t < 0.28, 'bool pct ' + t);
  const a = r.rows.filter(x => x.t === 'a').length / r.rows.length;
  assert.ok(a > 0.87 && a < 0.93, 'weights ' + a);
});

test('100k rows in under 3 s in Node (generate + CSV)', () => {
  for (const k of ['users', 'orders']) {
    const t0 = Date.now();
    const r = gen(k, 100000);
    const csv = T.toCSV(r);
    const ms = Date.now() - t0;
    assert.strictEqual(r.rows.length, 100000);
    assert.ok(csv.length > 1e6);
    assert.ok(ms < 3000, k + ' took ' + ms + ' ms');
    console.log('       ' + k + ': 100,000 rows + CSV in ' + ms + ' ms');
  }
});

test('createGenerator can run in chunks and matches generate()', () => {
  const g = T.createGenerator({ rows: 1234, seed: 'chunk', columns: TPL.customers.columns });
  const rows = [];
  let r;
  while ((r = g.next())) rows.push(r);
  assert.strictEqual(rows.length, 1234);
  assert.deepStrictEqual(rows, gen('customers', 1234, 'chunk').rows);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
