// Peak-readiness quiz scoring. Must match scoreQuiz() in enquiry/Code.gs, which scores the emailed report.
// answers = one option index per question, in order. Returns null if any answer is missing or invalid.
(function (root) {
  function scoreQuiz(data, answers) {
    var qs = data.questions;
    if (!Array.isArray(answers) || answers.length !== qs.length) return null;
    var got = 0, max = 0, weak = [];
    for (var i = 0; i < qs.length; i++) {
      var q = qs[i];
      var best = Math.max.apply(null, q.options.map(function (o) { return o.p; }));
      var a = Number(answers[i]);
      if (!Number.isInteger(a) || a < 0 || a >= q.options.length) return null;
      var p = q.options[a].p;
      got += p; max += best;
      if (p < best) weak.push({ id: q.id, area: q.area, fix: q.fix, gap: best - p, order: i, answer: q.options[a].t });
    }
    weak.sort(function (x, y) { return y.gap - x.gap || x.order - y.order; });
    var score = max ? Math.round(got / max * 100) : 0;
    var band = data.bands.filter(function (b) { return score >= b.min; }).sort(function (x, y) { return y.min - x.min; })[0];
    return { score: score, band: band, weak: weak };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = scoreQuiz;
  else root.scoreQuiz = scoreQuiz;
})(this);
