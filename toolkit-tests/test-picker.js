// Tests for the load testing tool picker (docs/compare/tool-picker/picker.js). Run: node toolkit-tests/test-picker.js
const assert = require('assert');
const path = require('path');
const { pick, RULES, QUESTIONS } = require(path.join(__dirname, '..', 'docs', 'compare', 'tool-picker', 'picker.js'));

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('ok   ' + name); }
  catch (e) { console.error('FAIL ' + name + '\n     ' + e.message); process.exitCode = 1; }
}
const base = { lang: 'js', proto: 'http', scale: 'small', budget: 'free', ci: 'none', skills: 'none' };
const run = (over) => pick(Object.assign({}, base, over));
const top2 = (r) => [r.best.id, r.runnerUp.id];

t('SAP GUI / Citrix with a GUI team and budget -> LoadRunner or NeoLoad, the other one runner-up', () => {
  const r = run({ lang: 'nocode', proto: 'legacy', budget: 'commercial', scale: 'medium', ci: 'scheduled' });
  assert.deepStrictEqual(top2(r).sort(), ['loadrunner', 'neoload']);
});
t('legacy protocols on a free budget still -> LoadRunner or NeoLoad, with a note about the Community licence', () => {
  const r = run({ lang: 'nocode', proto: 'legacy', budget: 'free' });
  assert.ok(['loadrunner', 'neoload'].includes(r.best.id), r.best.id);
  assert.ok(r.notes.some((n) => /Community licence/.test(n)));
});
t('legacy protocols beat the team language (Python team with Citrix)', () => {
  const r = run({ lang: 'python', proto: 'legacy', budget: 'commercial' });
  assert.ok(['loadrunner', 'neoload'].includes(r.best.id), r.best.id);
});
t('Python team testing HTTP APIs -> Locust', () => {
  assert.strictEqual(run({ lang: 'python' }).best.id, 'locust');
});
t('Python team with tests on every build -> still Locust', () => {
  assert.strictEqual(run({ lang: 'python', ci: 'every' }).best.id, 'locust');
});
t('JavaScript team, tests in CI on every build -> k6', () => {
  const r = run({ lang: 'js', ci: 'every', scale: 'medium' });
  assert.strictEqual(r.best.id, 'k6');
  assert.ok(['artillery', 'gatling'].includes(r.runnerUp.id), r.runnerUp.id);
});
t('JavaScript team, small HTTP test -> k6 with Artillery runner-up and a comparison link', () => {
  const r = run({});
  assert.deepStrictEqual(top2(r), ['k6', 'artillery']);
  assert.strictEqual(r.compare, '/compare/k6-vs-artillery/');
});
t('Java/Kotlin team with CI -> Gatling', () => {
  assert.strictEqual(run({ lang: 'jvm', ci: 'every' }).best.id, 'gatling');
});
t('testers who want no code, HTTP, free, no CI -> JMeter', () => {
  assert.strictEqual(run({ lang: 'nocode', ci: 'none' }).best.id, 'jmeter');
});
t('JDBC / JMS / LDAP back-end testing -> JMeter', () => {
  assert.strictEqual(run({ lang: 'jvm', proto: 'backend' }).best.id, 'jmeter');
});
t('browser-level tests from a JavaScript team -> k6, Artillery runner-up', () => {
  const r = run({ proto: 'browser' });
  assert.deepStrictEqual(top2(r), ['k6', 'artillery']);
  assert.ok(r.notes.some((n) => /browsers/.test(n)));
});
t('gRPC / WebSockets -> k6', () => {
  assert.strictEqual(run({ lang: 'other', proto: 'grpc' }).best.id, 'k6');
});
t('team already knows JMeter, GUI testers -> JMeter', () => {
  assert.strictEqual(run({ lang: 'nocode', skills: 'jmeter', ci: 'scheduled' }).best.id, 'jmeter');
});
t('free budget never recommends a commercial tool for plain HTTP', () => {
  for (const lang of Object.keys(RULES.lang)) {
    for (const ci of Object.keys(RULES.ci)) {
      const r = run({ lang, ci, budget: 'free' });
      assert.ok(!['loadrunner', 'neoload'].includes(r.best.id), lang + '/' + ci + ' -> ' + r.best.id);
    }
  }
});
t('large scale mentions hosted load services', () => {
  assert.ok(run({ scale: 'large' }).notes.some((n) => /Grafana Cloud k6/.test(n) && /BlazeMeter/.test(n)));
});
t('existing skills in another tool add a switching-cost note', () => {
  const r = run({ lang: 'python', skills: 'loadrunner' });
  assert.notStrictEqual(r.best.id, 'loadrunner');
  assert.ok(r.notes.some((n) => /already knows LoadRunner/.test(n)));
});
t('every combination of answers gives two different tools with reasons and links', () => {
  const keys = QUESTIONS.map((q) => Object.keys(RULES[q]));
  let n = 0;
  (function walk(i, acc) {
    if (i === QUESTIONS.length) {
      const r = pick(acc); n++;
      assert.notStrictEqual(r.best.id, r.runnerUp.id);
      assert.ok(r.best.reasons.length > 0 && r.runnerUp.reasons.length > 0);
      assert.ok(r.best.links.length > 0);
      if (r.compare) assert.ok(/^\/compare\/[a-z0-9-]+\/$/.test(r.compare));
      return;
    }
    for (const v of keys[i]) walk(i + 1, Object.assign({}, acc, { [QUESTIONS[i]]: v }));
  })(0, {});
  assert.ok(n > 1000, 'walked ' + n);
});
t('missing answers do not throw', () => {
  const r = pick({});
  assert.ok(r.best.id && r.runnerUp.id);
});

console.log(`\n${passed} passed`);
