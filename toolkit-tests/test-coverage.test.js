// Tests for docs/tools/test-coverage/coverage.js. Run: node toolkit-tests/test-coverage.test.js
'use strict';
const path = require('path');
const assert = require('assert');
const C = require(path.join(__dirname, '..', 'docs', 'tools', 'test-coverage', 'coverage.js'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e)); }
}

// ---------------------------------------------------------------- fixtures
const LCOV = `TN:
SF:/home/runner/work/shop/shop/src/cart/cart.ts
FN:1,add
FNDA:3,add
FNF:1
FNH:1
DA:1,3
DA:2,3
DA:3,0
DA:4,1
BRDA:2,0,0,3
BRDA:2,0,1,-
BRF:2
BRH:1
LF:4
LH:3
end_of_record
SF:/home/runner/work/shop/shop/src/checkout/payment.ts
DA:1,1
DA:2,0
DA:3,0
DA:4,0
DA:5,0
LF:5
LH:1
end_of_record
SF:/home/runner/work/shop/shop/src/cart/cart.ts
DA:3,2
end_of_record
`;
const LCOV_BASE = `SF:/ci/src/cart/cart.ts
DA:1,1
DA:2,1
DA:3,1
DA:4,1
end_of_record
SF:/ci/src/checkout/payment.ts
DA:1,1
DA:2,1
DA:3,0
end_of_record
SF:/ci/src/old/legacy.ts
DA:1,0
end_of_record
`;
const COBERTURA = `<?xml version="1.0" ?>
<coverage version="7.6" line-rate="0.6" branch-rate="0.5">
  <sources><source>/builds/acme</source></sources>
  <packages><package name="app.billing"><classes>
    <class name="invoice.py" filename="app/billing/invoice.py" line-rate="0.5">
      <methods><method name="total"><lines><line number="2" hits="1"/></lines></method></methods>
      <lines>
        <line number="1" hits="1"/>
        <line number="2" hits="1" branch="true" condition-coverage="50% (1/2)"/>
        <line number="3" hits="0"/>
        <line number="4" hits="0"/>
      </lines>
    </class>
    <class name="tax.py" filename="app/billing/tax.py"><lines><line number="1" hits="3"/><line number="2" hits="3"/></lines></class>
  </classes></package></packages>
</coverage>`;
const JACOCO = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><!DOCTYPE report PUBLIC "-//JACOCO//DTD Report 1.1//EN" "report.dtd"><report name="api">
<package name="com/acme/pay"><class name="com/acme/pay/Refund"><method name="run" desc="()V" line="3"><counter type="LINE" missed="1" covered="1"/></method></class>
<sourcefile name="Refund.java"><line nr="3" mi="0" ci="4" mb="1" cb="1"/><line nr="4" mi="2" ci="0" mb="0" cb="0"/><line nr="5" mi="0" ci="2" mb="0" cb="0"/>
<counter type="LINE" missed="1" covered="2"/><counter type="METHOD" missed="0" covered="1"/></sourcefile></package></report>`;
const SUMMARY = JSON.stringify({ total: { lines: { total: 30, covered: 20, pct: 66.67 } },
  '/repo/src/a.js': { lines: { total: 10, covered: 10, pct: 100 }, branches: { total: 4, covered: 2, pct: 50 }, functions: { total: 2, covered: 2 } },
  '/repo/src/lib/b.js': { lines: { total: 20, covered: 10, pct: 50 }, branches: { total: 0, covered: 0, pct: 100 } } });
const FINAL = JSON.stringify({ '/repo/src/a.js': { path: '/repo/src/a.js',
  statementMap: { 0: { start: { line: 1, column: 0 }, end: { line: 1, column: 9 } }, 1: { start: { line: 2, column: 0 } }, 2: { start: { line: 2, column: 10 } }, 3: { start: { line: 5, column: 0 } } },
  s: { 0: 1, 1: 0, 2: 4, 3: 0 }, fnMap: { 0: {} }, f: { 0: 1 }, branchMap: { 0: { line: 2, locations: [{}, {}] } }, b: { 0: [3, 0] } } });

const junit = (states) => `<?xml version="1.0"?><testsuites>
<testsuite name="com.acme.shop.CartTest"><testcase classname="com.acme.shop.CartTest" name="addsItem @REQ-1" time="0.1"${states[0] === 'f' ? '><failure message="boom">x</failure></testcase>' : '/>'}
<testcase classname="com.acme.shop.CartTest" name="removesItem" time="0.1"${states[1] === 'f' ? '><failure message="nope"/></testcase>' : '/>'}</testsuite>
<testsuite name="PaymentTest"><testcase classname="com.acme.shop.PaymentTest" name="declined" time="0.1"${states[2] === 'f' ? '><error message="timeout"/></testcase>' : states[2] === 'r' ? '><flakyFailure message="t"/></testcase>' : '/>'}</testsuite>
</testsuites>`;

// ---------------------------------------------------------------- parsers
test('shares the JUnit parser from the CI failure detective', () => assert.ok(C.usesSharedJUnit));

test('LCOV: lines, branches, functions; repeated SF records merged; CI prefix stripped', () => {
  const r = C.parseCoverage(LCOV);
  assert.strictEqual(r.format, 'lcov');
  assert.deepStrictEqual(r.files.map(f => f.path), ['src/cart/cart.ts', 'src/checkout/payment.ts']);
  const cart = r.files[0];
  assert.strictEqual(cart.lt, 4);
  assert.strictEqual(cart.lc, 4, 'line 3 covered by the second record');
  assert.strictEqual(cart.bt, 2); assert.strictEqual(cart.bc, 1);
  assert.strictEqual(cart.ft, 1); assert.strictEqual(cart.fc, 1);
  assert.deepStrictEqual(C.uncoveredLines(r.files[1]), [2, 3, 4, 5]);
  const t = C.totals(r.files);
  assert.strictEqual(t.linePct, 55.6);
});

test('Cobertura: method lines are not double counted, condition-coverage gives branches', () => {
  const r = C.parseCoverage(COBERTURA);
  assert.strictEqual(r.format, 'cobertura');
  const inv = r.files.find(f => f.path === 'app/billing/invoice.py');
  assert.strictEqual(inv.lt, 4); assert.strictEqual(inv.lc, 2);
  assert.strictEqual(inv.bt, 2); assert.strictEqual(inv.bc, 1);
  assert.strictEqual(r.files.find(f => f.path.endsWith('tax.py')).lc, 2);
});

test('JaCoCo: package/sourcefile path, ci>0 is covered, mb+cb are branches, METHOD counter', () => {
  const r = C.parseCoverage(JACOCO);
  assert.strictEqual(r.format, 'jacoco');
  const f = r.files[0];
  assert.strictEqual(f.path, 'com/acme/pay/Refund.java');
  assert.strictEqual(f.lt, 3); assert.strictEqual(f.lc, 2);
  assert.strictEqual(f.bt, 2); assert.strictEqual(f.bc, 1);
  assert.strictEqual(f.ft, 1); assert.strictEqual(f.fc, 1);
});

test('Istanbul coverage-summary.json: totals per file, no line detail', () => {
  const r = C.parseCoverage(SUMMARY);
  assert.strictEqual(r.format, 'istanbul-summary');
  assert.deepStrictEqual(r.files.map(f => f.path).sort(), ['src/a.js', 'src/lib/b.js'], 'runner prefix dropped, src/ kept');
  const a = r.files.find(f => f.path === 'src/a.js');
  assert.strictEqual(a.lt, 10); assert.strictEqual(a.bt, 4); assert.strictEqual(a.bc, 2); assert.strictEqual(a.lines, null);
});

test('Istanbul coverage-final.json: statements → lines (max hits per line), branches, functions', () => {
  const r = C.parseCoverage(FINAL);
  assert.strictEqual(r.format, 'istanbul-final');
  const f = r.files[0];
  assert.strictEqual(f.lt, 3, 'lines 1, 2 and 5');
  assert.strictEqual(f.lc, 2, 'line 2 has one hit statement');
  assert.strictEqual(f.bt, 2); assert.strictEqual(f.bc, 1);
  assert.strictEqual(f.ft, 1);
});

test('unknown format gives a helpful error', () => {
  assert.throws(() => C.parseCoverage('hello world'), /LCOV/);
  assert.throws(() => C.parseCoverage('{"x": '), /JSON/);
});

test('ranges() compresses line numbers', () => {
  assert.strictEqual(C.ranges([1, 2, 3, 7, 9, 10]), '1–3, 7, 9–10');
  assert.strictEqual(C.ranges([1, 3, 5, 7], 2), '1, 3 and 2 more');
});

// ---------------------------------------------------------------- churn
test('git log --numstat: commits per file, renames followed, binary files handled', () => {
  const log = `commit aaa\nAuthor: x\n\n    one\n\n10\t2\tsrc/checkout/payment.ts\n1\t1\tsrc/cart/cart.ts\n\ncommit bbb\n\n    two\n\n5\t0\tsrc/checkout/payment.ts\n-\t-\tlogo.png\n\n3\t1\tsrc/{old => checkout}/payment.ts\n`;
  const c = C.parseChurn(log);
  assert.strictEqual(c.kind, 'git');
  assert.strictEqual(c.commits, 3);
  assert.strictEqual(c.files['src/checkout/payment.ts'].commits, 3);
  assert.strictEqual(c.files['src/checkout/payment.ts'].changed, 21);
  assert.strictEqual(c.files['logo.png'].changed, 0);
  const csv = C.parseChurn('path,commits\nsrc/a.ts,12\nsrc/b.ts,3\n');
  assert.strictEqual(csv.kind, 'csv');
  assert.strictEqual(csv.files['src/a.ts'].commits, 12);
});

// ---------------------------------------------------------------- tests, requirements
test('JUnit runs: flaky (mixed or retried) vs failing (every run)', () => {
  const r = C.parseTestResults([{ name: 'r1', text: junit(['p', 'f', 'f']) }, { name: 'r2', text: junit(['f', 'f', 'r']) }]);
  const by = k => r.tests.find(t => t.name.startsWith(k));
  assert.strictEqual(by('addsItem').status, 'flaky');
  assert.strictEqual(by('removesItem').status, 'fail');
  assert.strictEqual(by('declined').status, 'flaky', 'flakyFailure means it passed on retry');
  assert.strictEqual(r.runs[0].failed, 2);
});

test('tests are matched to source files by name', () => {
  assert.deepStrictEqual(C.subjectTokens({ classname: 'com.acme.shop.CartTest', name: 'x' }), ['cart', 'shop']);
  assert.deepStrictEqual(C.subjectTokens({ classname: 'tests.test_invoice', name: 'x' }), ['invoice', 'tests']);
  assert.deepStrictEqual(C.subjectTokens({ classname: 'payment.spec.ts', name: 'x' }), ['payment']);
  const files = C.parseCoverage(LCOV).files;
  const m = C.mapTestsToFiles([{ classname: 'com.acme.CartTest', name: 'a', status: 'fail', key: 'k' }, { classname: 'payment.spec.ts', name: 'b', status: 'flaky', key: 'k2' }, { classname: 'Nothing', name: 'c', status: 'pass', key: 'k3' }], files);
  assert.strictEqual(m.mapped, 2);
  assert.strictEqual(m.perFile.get('src/cart/cart.ts').failing, 1);
  assert.strictEqual(m.perFile.get('src/checkout/payment.ts').flaky, 1);
});

test('requirements: CSV refs + @tags, untested / failing / passing', () => {
  const reqs = C.parseRequirements('Requirement,Title,Tests\nREQ-1,Add to cart,\nREQ-2,Remove,CartTest.removesItem\nREQ-3,Refunds,RefundTest.full;RefundTest.partial\nREQ-4,Export,\n');
  assert.strictEqual(reqs.length, 4);
  assert.deepStrictEqual(reqs[2].refs, ['RefundTest.full', 'RefundTest.partial']);
  const tr = C.parseTestResults([{ name: 'r', text: junit(['p', 'f', 'p']) }]);
  const out = C.traceRequirements(reqs, tr.tests, true);
  const st = id => out.find(r => r.id === id).status;
  assert.strictEqual(st('REQ-1'), 'passing', 'linked through @REQ-1 in the test name');
  assert.strictEqual(st('REQ-2'), 'failing');
  assert.strictEqual(st('REQ-3'), 'untested');
  assert.deepStrictEqual(out.find(r => r.id === 'REQ-3').missingRefs, ['RefundTest.full', 'RefundTest.partial']);
  assert.strictEqual(st('REQ-4'), 'untested');
  assert.strictEqual(out[0].status, 'failing', 'failing first');
  const noRes = C.traceRequirements(C.parseRequirements('REQ-9,Search,SearchTest.finds'), [], false);
  assert.strictEqual(noRes[0].status, 'no-results');
});

// ---------------------------------------------------------------- analysis
test('hotspots: untested + often changed + big ranks first; churn and test failures add weight', () => {
  const a = C.analyse({ coverage: LCOV, churn: '5\t1\tsrc/checkout/payment.ts\n\n5\t1\tsrc/checkout/payment.ts\n\n1\t0\tsrc/cart/cart.ts\n',
    junit: [{ name: 'r1', text: junit(['p', 'p', 'f']) }] });
  assert.strictEqual(a.hotspots[0].path, 'src/checkout/payment.ts');
  assert.ok(a.hotspots[0].risk > a.hotspots[1].risk);
  assert.strictEqual(a.hotspots[0].commits, 2);
  assert.ok(a.hotspots[0].why.some(w => /failing test/.test(w)));
  assert.strictEqual(a.churn.matched, 2);
  assert.strictEqual(a.tests.failing, 1);
  assert.ok(a.files.find(f => f.path === 'src/checkout/payment.ts').failing === 1);
  assert.deepStrictEqual(a.packages.map(p => p.name).sort(), ['src/cart', 'src/checkout']);
});

test('change history that matches nothing is ignored with a warning', () => {
  const a = C.analyse({ coverage: LCOV, churn: '1\t1\tother/thing.go\n' });
  assert.strictEqual(a.churn, null);
  assert.ok(a.warnings.some(w => /change history/.test(w)));
});

test('diff: coverage delta, new uncovered lines, new and removed files (different CI prefixes)', () => {
  const d = C.diffReports(C.parseCoverage(LCOV_BASE), C.parseCoverage(LCOV));
  const pay = d.rows.find(r => r.path === 'src/checkout/payment.ts');
  assert.deepStrictEqual(pay.newUncovered, [2, 4, 5], 'line 3 was already uncovered');
  assert.strictEqual(pay.status, 'changed');
  assert.ok(d.rows.find(r => r.status === 'removed' && /legacy/.test(r.path)));
  assert.strictEqual(d.removedFiles, 1);
  assert.strictEqual(d.newUncoveredTotal, 3);
  assert.ok(d.delta < 0);
});

test('release summary: failing tests + untested requirements = high risk, in plain English', () => {
  const a = C.analyse({ coverage: LCOV, baseline: LCOV_BASE, junit: [{ name: 'r', text: junit(['p', 'f', 'f']) }], requirements: 'REQ-1,Add\nREQ-7,Export' });
  assert.strictEqual(a.summary.level, 'high');
  assert.ok(/failing/.test(a.summary.text));
  assert.ok(/no test that ran/.test(a.summary.text));
  assert.ok(/fell by/.test(a.summary.text));
  const good = C.analyse({ coverage: 'SF:a.js\nDA:1,1\nDA:2,1\nend_of_record\n' });
  assert.strictEqual(good.summary.level, 'low');
});

test('CI gates: LCOV awk check really works; ratchet from today’s numbers', () => {
  const a = C.analyse({ coverage: LCOV });
  assert.strictEqual(a.gates.line, 55);
  const g = C.ciGates({ format: 'lcov', line: 50, branch: 40 });
  assert.ok(/actions\/checkout@v4/.test(g.github) && /diff-cover/.test(g.github));
  assert.ok(/coverage: '\/Lines/.test(g.gitlab));
  assert.ok(/coverageThreshold: \{ global: \{ lines: 50, branches: 40 \} \}/.test(g.native.jest));
  assert.ok(/--cov-fail-under=50/.test(g.native.pytest));
  assert.ok(/<minimum>0.50<\/minimum>/.test(g.native.jacoco));
  assert.ok(/coverage_format: cobertura/.test(C.ciGates({ format: 'cobertura' }).gitlab));
  // run the generated awk against an LCOV file: 75% passes a 50% gate and fails an 80% gate
  const { execSync } = require('child_process');
  const fs = require('fs'), os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cov-gate-'));
  try {
    fs.mkdirSync(path.join(dir, 'coverage'));
    fs.writeFileSync(path.join(dir, 'coverage', 'lcov.info'), LCOV_BASE.replace(/end_of_record/g, 'LF:4\nLH:3\nBRF:2\nBRH:1\nend_of_record'));
    const ok = execSync(g.check, { cwd: dir, encoding: 'utf8', shell: '/bin/sh' });
    assert.ok(/Lines 75\.0% \(gate 50%\), branches 50\.0% \(gate 40%\)/.test(ok), ok);
    let threw = false;
    try { execSync(C.ciGates({ format: 'lcov', line: 80 }).check, { cwd: dir, stdio: 'pipe', shell: '/bin/sh' }); } catch (e) { threw = e.status === 1; }
    assert.ok(threw, 'below the gate exits 1');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('treemap fills the box and keeps areas proportional', () => {
  const r = C.treemap([{ name: 'a', value: 6 }, { name: 'b', value: 3 }, { name: 'c', value: 1 }], 0, 0, 100, 50);
  assert.strictEqual(r.length, 3);
  const area = r.reduce((s, x) => s + x.w * x.h, 0);
  assert.ok(Math.abs(area - 5000) < 1e-6);
  const a = r.find(x => x.name === 'a');
  assert.ok(Math.abs(a.w * a.h - 3000) < 1e-6);
  r.forEach(x => assert.ok(x.x >= -1e-9 && x.y >= -1e-9 && x.x + x.w <= 100 + 1e-9 && x.y + x.h <= 50 + 1e-9));
});

test('a 5,000-file LCOV report is analysed in well under two seconds', () => {
  let s = '';
  for (let i = 0; i < 5000; i++) { s += 'SF:/w/src/m' + (i % 50) + '/f' + i + '.ts\n'; for (let l = 1; l <= 60; l++) s += 'DA:' + l + ',' + (l % 3 ? 1 : 0) + '\n'; s += 'end_of_record\n'; }
  const t0 = Date.now();
  const a = C.analyse({ coverage: s });
  assert.strictEqual(a.totals.files, 5000);
  assert.ok(Date.now() - t0 < 2000, 'took ' + (Date.now() - t0) + 'ms');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
