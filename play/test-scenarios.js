// Checks every Spot the Bottleneck scenario builds valid rounds: node play/test-scenarios.js
const assert = require('assert');
const B = require('../docs/play/spot-the-bottleneck/scenarios.js');
const fs = require('fs'), path = require('path');
assert(B.SCENARIOS.length >= 20, 'at least 20 scenarios');
const answers = new Set(B.SCENARIOS.map(s => s.answer));
assert.strictEqual(answers.size, B.SCENARIOS.length, 'answers are unique');
const ids = new Set(B.SCENARIOS.map(s => s.id));
assert.strictEqual(ids.size, B.SCENARIOS.length, 'ids are unique');
let rounds = 0;
for (const sc of B.SCENARIOS) {
  // Glossary links must point at a page that exists in the site.
  assert(fs.existsSync(path.join(__dirname, '..', 'docs', sc.glossary, 'index.html')), sc.id + ' glossary ' + sc.glossary);
  for (let seed = 1; seed <= 50; seed++) {
    const r = B.round(sc, seed);
    assert.strictEqual(r.options.length, 4);
    assert(r.options.includes(r.answer));
    assert.strictEqual(new Set(r.options).size, 4, 'options unique');
    assert(r.charts.length >= 3 && r.charts.length <= 4, sc.id + ' chart count');
    for (const c of r.charts) {
      assert(c.title && c.series.length >= 1);
      for (const s of c.series) {
        assert(s.data.length >= 10, sc.id + ' ' + c.title + ' points');
        s.data.forEach(v => assert(Number.isFinite(v) && v >= 0, `${sc.id} ${c.title} value ${v}`));
        if (c.max === 100 && c.unit === '%') s.data.forEach(v => assert(v <= 100.5, `${sc.id} ${c.title} ${v} > 100%`));
      }
    }
    assert(r.story && r.explain.length > 60);
    rounds++;
  }
}
// A game picks 10 different scenarios, and the same seed gives the same game.
const g1 = B.game(10, 42), g2 = B.game(10, 42), g3 = B.game(10, 43);
assert.strictEqual(new Set(g1.map(r => r.id)).size, 10);
assert.deepStrictEqual(g1.map(r => r.id), g2.map(r => r.id));
assert.notDeepStrictEqual(g1.map(r => r.id), g3.map(r => r.id));
console.log(`ok ${B.SCENARIOS.length} scenarios, ${rounds} rounds checked`);
