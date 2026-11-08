// Tests for docs/tools/qa-copilot/qa.js. Run: node toolkit-tests/qa-copilot.test.js
'use strict';
const path = require('path');
const assert = require('assert');
const Q = require(path.join(__dirname, '..', 'docs', 'tools', 'qa-copilot', 'qa.js'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e)); }
}

// ---------------------------------------------------------------- fixtures

const STORY = `US-101 As a registered customer, I want to reset my password so that I can sign in again.
Acceptance criteria:
- The reset link expires after 30 minutes
- Password must be between 8 and 64 characters`;

const MIXED = `${STORY}

REQ-7: The username must be max 50 characters.
The age must be 18 or older.
Search results should load within 2 seconds.

Feature: Checkout
Scenario: Pay with a saved card
  Given a customer with a saved card
  When they pay for an order
  Then the order is confirmed
  And an email receipt is sent`;

// ---------------------------------------------------------------- requirements

test('user story with acceptance criteria is parsed into role, want, benefit and criteria', () => {
  const r = Q.parseRequirements(STORY);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].id, 'US-101');
  assert.strictEqual(r[0].type, 'story');
  assert.strictEqual(r[0].role, 'registered customer');
  assert.strictEqual(r[0].want, 'reset my password');
  assert.strictEqual(r[0].benefit, 'I can sign in again');
  assert.deepStrictEqual(r[0].criteria, ['The reset link expires after 30 minutes', 'Password must be between 8 and 64 characters']);
});

test('multi-line story and criteria in a separate block attach to the story', () => {
  const r = Q.parseRequirements('As an admin\nI want to delete products\nSo that the catalogue stays clean\n\nAcceptance criteria:\n- Deleted products are hidden from search\n- A confirmation is shown');
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].role, 'admin');
  assert.strictEqual(r[0].want, 'delete products');
  assert.strictEqual(r[0].criteria.length, 2);
});

test('mixed input: story, ID statements, plain lines and Gherkin', () => {
  const r = Q.parseRequirements(MIXED);
  assert.deepStrictEqual(r.map(x => x.id), ['US-101', 'REQ-7', 'REQ-001', 'REQ-002', 'REQ-003']);
  assert.deepStrictEqual(r.map(x => x.type), ['story', 'statement', 'statement', 'statement', 'gherkin']);
  const g = r[4];
  assert.strictEqual(g.title, 'Pay with a saved card');
  assert.strictEqual(g.group, 'Checkout');
  assert.deepStrictEqual(g.steps.given, ['a customer with a saved card']);
  assert.deepStrictEqual(g.steps.then, ['the order is confirmed', 'an email receipt is sent']);
});

test('Gherkin background steps are copied into each scenario', () => {
  const r = Q.parseRequirements('Feature: Login\nBackground:\n  Given the login page is open\nScenario: Good password\n  When I sign in\n  Then I see my dashboard\nScenario: Bad password\n  When I sign in with a wrong password\n  Then I see an error');
  assert.strictEqual(r.length, 2);
  assert.deepStrictEqual(r[1].steps.given, ['the login page is open']);
});

test('"Account" is not mistaken for an AC prefix and IDs stay unique', () => {
  const r = Q.parseRequirements('REQ-1 Account names must be unique\nREQ-1 Accounts can be closed');
  assert.strictEqual(r[0].title, 'Account names must be unique');
  assert.deepStrictEqual(r.map(x => x.id), ['REQ-1', 'REQ-1.2']);
});

// ---------------------------------------------------------------- boundaries

test('boundary detection: ranges, max, min, exclusive and exact', () => {
  const one = t => Q.detectBoundaries(t).map(b => [b.kind, b.field, b.values.map(v => v.value + (v.valid ? '+' : '-')).join(' ')]);
  assert.deepStrictEqual(one('Quantity must be between 1 and 100'), [['range', 'Quantity', '0- 1+ 2+ 99+ 100+ 101-']]);
  assert.deepStrictEqual(one('The username must be max 50 characters'), [['max', 'Username length', '49+ 50+ 51-']]);
  assert.deepStrictEqual(one('Password must be at least 8 characters'), [['min', 'Password length', '7- 8+ 9+']]);
  assert.deepStrictEqual(one('The age must be 18 or older'), [['min', 'Age', '17- 18+ 19+']]);
  assert.deepStrictEqual(one('Discount must be less than 10'), [['lt', 'Discount', '9+ 10-']]);
  assert.deepStrictEqual(one('PIN must be exactly 4 digits'), [['exact', 'PIN', '3- 4+ 5-']]);
  assert.deepStrictEqual(one('Amount from 0.01 to 999.99 dollars'), [['range', 'Amount', '0- 0.01+ 0.02+ 999.98+ 999.99+ 1000-']]);
});

test('"no more than" is a maximum, not "more than"; time targets are not boundaries', () => {
  const b = Q.detectBoundaries('A cart can hold no more than 20 items');
  assert.strictEqual(b.length, 1);
  assert.strictEqual(b[0].kind, 'max');
  assert.strictEqual(b[0].value, 20);
  assert.deepStrictEqual(Q.detectBoundaries('Search results should load within 2 seconds'), []);
});

test('length boundaries never go below zero', () => {
  const b = Q.detectBoundaries('Nickname must be between 0 and 20 characters')[0];
  assert.ok(b.values.every(v => v.value >= 0));
});

// ---------------------------------------------------------------- scenarios

test('story produces happy path, acceptance, negative, boundary, permission, security and accessibility scenarios', () => {
  const s = Q.generateScenarios(Q.parseRequirements(STORY));
  const types = new Set(s.map(x => x.type));
  ['Happy path', 'Acceptance', 'Negative', 'Boundary', 'Equivalence', 'Permissions', 'Empty/null', 'Security', 'Accessibility'].forEach(t => assert.ok(types.has(t), 'missing ' + t));
  assert.ok(!types.has('Performance'), 'no performance prompt without performance words');
  assert.strictEqual(s[0].id, 'US-101-TC01');
  assert.strictEqual(s[0].title, 'Registered customer can reset their password');
  const b = s.filter(x => x.type === 'Boundary').map(x => x.data);
  assert.deepStrictEqual(b, ['7', '8', '9', '63', '64', '65']);
  assert.ok(s.some(x => /Wrong password/.test(x.title)));
  assert.ok(s.some(x => /Expired/.test(x.title)));
  assert.strictEqual(new Set(s.map(x => x.id)).size, s.length, 'ids are unique');
});

test('performance prompt uses the stated target', () => {
  const s = Q.generateScenarios(Q.parseRequirements('Search results should load within 2 seconds'));
  const p = s.find(x => x.type === 'Performance');
  assert.ok(p);
  assert.ok(/within 2 seconds/.test(p.expected), p.expected);
});

test('a "must not" requirement gets a blocked-action negative instead of a happy path', () => {
  const s = Q.generateScenarios(Q.parseRequirements('Guests must not see order history'));
  assert.ok(!s.some(x => x.type === 'Happy path'));
  assert.ok(s.some(x => x.type === 'Negative' && /^Blocked/.test(x.title)));
  assert.ok(s.some(x => x.type === 'Permissions'));
});

test('API requirement gets null and missing field checks', () => {
  const s = Q.generateScenarios(Q.parseRequirements('The orders API endpoint must reject a request without a customer id'));
  assert.ok(s.some(x => x.type === 'Empty/null' && /request/.test(x.title)));
});

// ---------------------------------------------------------------- exports

test('CSV export has Zephyr/Xray-friendly columns and escapes safely', () => {
  const s = Q.generateScenarios(Q.parseRequirements(STORY));
  const csv = Q.scenariosToCSV(s);
  const rows = Q.parseCSV(csv);
  assert.deepStrictEqual(rows[0], ['Test ID', 'Name', 'Requirement', 'Test Type', 'Priority', 'Labels', 'Precondition', 'Action', 'Data', 'Expected Result']);
  assert.strictEqual(rows.length, s.length + 1);
  assert.strictEqual(rows[1][0], 'US-101-TC01');
  assert.ok(rows.every(r => r.length === 10));
  // formula injection guard
  assert.ok(Q.toCSV([['=SUM(A1)']]).startsWith('"\'=SUM'));
});

test('Gherkin export: one feature per requirement and a Scenario Outline for boundaries', () => {
  const r = Q.parseRequirements('REQ-7: The username must be max 50 characters.');
  const g = Q.scenariosToGherkin(Q.generateScenarios(r), r);
  assert.ok(/^@REQ-7\nFeature: The username must be max 50 characters\./.test(g));
  assert.ok(/Scenario Outline: Boundary values/.test(g));
  assert.ok(/\| 51 \| rejected \|/.test(g));
  assert.ok(/\| 50 \| accepted \|/.test(g));
  assert.ok(!/Given The /.test(g), 'step text starts lower case');
});

// ---------------------------------------------------------------- strategy

test('strategy includes the chosen levels, environments, risk-based exit criteria and scope', () => {
  const md = Q.buildStrategy({ project: 'Payments', type: 'api', risk: 'high', teamSize: 4, cadence: 'weekly', environments: ['Test', 'Staging'], levels: ['unit', 'api', 'performance'], tools: 'Playwright\nk6', inScope: 'Card payments\nRefunds', outScope: 'Bank systems' });
  assert.ok(/^# Test strategy: Payments/.test(md));
  assert.ok(/\| API \|/.test(md) && /\| Performance \|/.test(md) && !/\| UI \/ end-to-end \|/.test(md));
  assert.ok(/\| Staging \|/.test(md));
  assert.ok(/At least 98% of planned tests/.test(md));
  assert.ok(/- Refunds/.test(md) && /- Bank systems/.test(md));
  assert.ok(/Performance targets met/.test(md));
  assert.ok(/automated regression in the CI\/CD pipeline is essential/.test(md));
  const html = Q.markdownToHtml(md);
  assert.ok(/<h1>Test strategy: Payments<\/h1>/.test(html));
  assert.ok(/<table class="data md">/.test(html));
});

test('markdownToHtml escapes HTML', () => {
  const h = Q.markdownToHtml('# <script>x</script>\n\n- **a** <b>');
  assert.ok(!/<script>/.test(h));
  assert.ok(/&lt;script&gt;/.test(h));
  assert.ok(/<strong>a<\/strong> &lt;b&gt;/.test(h));
});

// ---------------------------------------------------------------- estimation

test('PERT estimate: expected = (O + 4M + P) / 6 and contingency is positive', () => {
  const e = Q.estimate({ simple: 10, medium: 10, complex: 0, cycles: 1, automationPct: 0, failPct: 0, envHours: 0, regressionCycles: 0, mgmtPct: 0, uncertainty: 'medium' });
  // design 10*15 + 10*30 = 450 min = 7.5 h; execution 10*10 + 10*20 = 300 min = 5 h → M = 12.5 h
  assert.strictEqual(e.mostLikely, 12.5);
  assert.strictEqual(e.optimistic, 10);
  assert.strictEqual(e.pessimistic, 20);
  assert.strictEqual(e.expected, Math.round((10 + 4 * 12.5 + 20) / 6 * 10) / 10);
  assert.ok(e.p95 > e.expected && e.contingency > 0);
  assert.strictEqual(e.rows.reduce((a, r) => a + r.hours, 0).toFixed(1), '12.5');
  assert.strictEqual(e.days.mostLikely, Math.round(12.5 / 7.6 * 10) / 10);
});

test('automation reduces repeat execution cost but adds build effort', () => {
  const manual = Q.estimate({ automationPct: 0, cycles: 6 });
  const auto = Q.estimate({ automationPct: 80, cycles: 6 });
  const row = (e, re) => e.rows.find(r => re.test(r.task)).hours;
  assert.ok(row(auto, /Manual execution/) < row(manual, /Manual execution/));
  assert.ok(row(auto, /Automation build/) > 0 && row(manual, /Automation build/) === 0);
});

// ---------------------------------------------------------------- coverage

const MODEL = {
  reqs: [{ id: 'REQ-1', title: 'Login' }, { id: 'REQ-2', title: 'Logout' }, { id: 'REQ-3', title: 'Reset' }, { id: 'REQ-4', title: 'Audit' }],
  tests: [
    { id: 'TC-1', title: 'login ok', reqs: ['REQ-1'], status: 'pass' },
    { id: 'TC-2', title: 'login bad', reqs: ['REQ-1'], status: 'fail' },
    { id: 'TC-3', title: 'logout', reqs: ['REQ-2'], status: 'pass' },
    { id: 'TC-4', title: 'reset', reqs: ['req-3'], status: 'not run' },
    { id: 'TC-5', title: 'orphan', reqs: ['REQ-9'], status: 'blocked' },
  ],
};

test('coverage: per-requirement status, coverage %, pass % and uncovered list', () => {
  const c = Q.coverage(MODEL);
  assert.deepStrictEqual(c.rows.map(r => r.status), ['fail', 'pass', 'not run', 'uncovered']);
  assert.strictEqual(c.coveragePct, 75);
  assert.deepStrictEqual(c.uncovered, ['REQ-4']);
  assert.strictEqual(c.executed, 4);
  assert.strictEqual(c.passPct, 50);
  assert.deepStrictEqual(c.orphanTests, ['TC-5']);
});

test('import results CSV updates statuses, adds new tests and requirements', () => {
  const csv = 'Test Case Key;Name;Status;Requirement\nTC-2;login bad;Passed;REQ-1\nTC-4;reset;FAIL;\nTC-9;"audit, written";pass;REQ-4 REQ-5\n';
  const r = Q.importResults(MODEL, csv);
  assert.strictEqual(r.updated, 2);
  assert.strictEqual(r.added, 1);
  const t = id => r.model.tests.find(x => x.id === id);
  assert.strictEqual(t('TC-2').status, 'pass');
  assert.strictEqual(t('TC-4').status, 'fail');
  assert.strictEqual(t('TC-9').title, 'audit, written');
  assert.deepStrictEqual(t('TC-9').reqs, ['REQ-4', 'REQ-5']);
  assert.ok(r.model.reqs.some(x => x.id === 'REQ-5'));
  assert.strictEqual(MODEL.tests[1].status, 'fail', 'original model not changed');
  assert.ok(Q.importResults(MODEL, 'foo,bar\n1,2').error);
});

test('status words are normalised', () => {
  assert.deepStrictEqual(['Passed', 'OK', 'failed', 'Error', 'Blocked', 'Unexecuted', ''].map(Q.normaliseStatus), ['pass', 'pass', 'fail', 'fail', 'blocked', 'not run', 'not run']);
});

// ---------------------------------------------------------------- risk

test('release risk: all done and clean = Go', () => {
  const all = {}; Q.CHECKLIST.forEach(c => { all[c.id] = true; });
  const r = Q.riskScore({ checklist: all, coverage: 100, passRate: 100, flakyRate: 0, changeSize: 'small' });
  assert.strictEqual(r.score, 0);
  assert.strictEqual(r.decision, 'Go');
  assert.strictEqual(r.level, 'Low');
});

test('release risk: an open critical defect is always No-go with a reason', () => {
  const all = {}; Q.CHECKLIST.forEach(c => { all[c.id] = true; });
  const r = Q.riskScore({ checklist: all, critical: 1, coverage: 100, passRate: 100, changeSize: 'small' });
  assert.strictEqual(r.decision, 'No-go');
  assert.ok(r.blockers[0].includes('critical'));
  assert.ok(r.reasons[0].text.includes('Open defects'));
});

test('release risk: missing checks, gaps and flakiness add up, N/A items are ignored', () => {
  const r = Q.riskScore({ checklist: { regression: true, migration: 'na' }, high: 2, medium: 4, coverage: 85, passRate: 96, flakyRate: 5, changeSize: 'large' });
  assert.ok(r.score >= 40 && r.score < 100, 'score ' + r.score);
  assert.ok(!r.reasons.some(x => /migration/i.test(x.text)));
  assert.ok(r.reasons.some(x => /flaky/.test(x.text)));
  assert.ok(['Go with conditions', 'No-go'].indexOf(r.decision) >= 0);
  // reasons are sorted by weight
  for (let i = 1; i < r.reasons.length; i++) assert.ok(r.reasons[i - 1].points >= r.reasons[i].points);
});

// ---------------------------------------------------------------- report

test('stakeholder report pulls estimate, coverage and risk', () => {
  const md = Q.buildReport({ project: 'Shop', release: '2.4', date: '8 Nov 2026', estimate: Q.estimate({}), coverage: Q.coverage(MODEL), risk: Q.riskScore({ critical: 1 }), defects: { critical: 1, high: 0 } });
  assert.ok(/^# Shop test summary: 2\.4/.test(md));
  assert.ok(/## Recommendation: No-go/.test(md));
  assert.ok(/Requirements covered \| 3 of 4 \(75%\)/.test(md));
  assert.ok(/Requirements with no test:\*\* REQ-4/.test(md));
  assert.ok(/## Effort/.test(md));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
