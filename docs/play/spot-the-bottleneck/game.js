/* Spot the Bottleneck: game UI. Scenarios live in scenarios.js (window.Bottlenecks). */
(function () {
  'use strict';
  const B = window.Bottlenecks, P = window.Play;
  const $ = (id) => document.getElementById(id);
  const ROUNDS = 10, SECONDS = 20;
  const URL_ = 'https://pawansinha.com.au/play/spot-the-bottleneck/';
  const fmt = (n) => Math.round(n).toLocaleString('en-AU');
  let rounds, idx, score, streak, bestStreak, correct, timer, left, answered;

  function showBest() {
    const b = P.store.get('spot-best');
    $('best').textContent = b ? `Your best: ${fmt(b.score)} (${b.correct}/10).` : '';
  }

  function start() {
    const seed = (Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0;
    rounds = B.game(ROUNDS, seed); idx = 0; score = 0; streak = 0; bestStreak = 0; correct = 0;
    $('start').hidden = true; $('end').hidden = true; $('play').hidden = false;
    P.track('spot-start');
    show();
  }

  // ------------------------------------------------------------ charts
  function niceMax(v) {
    if (v <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v))), m = v / p;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
  }
  function label(v) { return v >= 10000 ? Math.round(v / 1000) + 'k' : v >= 100 ? fmt(v) : String(Math.round(v * 10) / 10); }

  function chartSvg(c) {
    const W = 300, H = 128, L = 36, Rr = 6, T = 8, Bm = 22;
    const all = c.series.flatMap(s => s.data).concat(c.limit ? [c.limit] : []);
    const max = c.max || niceMax(Math.max(...all) * 1.08);
    const X = (i, n) => L + (W - L - Rr) * i / (n - 1), Y = (v) => T + (H - T - Bm) * (1 - Math.min(v, max) / max);
    let out = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${c.title}">`;
    out += `<line class="ax" x1="${L}" y1="${T}" x2="${L}" y2="${H - Bm}"/><line class="ax" x1="${L}" y1="${H - Bm}" x2="${W - Rr}" y2="${H - Bm}"/>`;
    out += `<text x="${L - 4}" y="${T + 8}" text-anchor="end">${label(max)}</text><text x="${L - 4}" y="${H - Bm}" text-anchor="end">0</text>`;
    out += `<text x="${W - Rr}" y="${H - 6}" text-anchor="end">${c.x}</text>`;
    if (c.limit) out += `<line class="lim" x1="${L}" x2="${W - Rr}" y1="${Y(c.limit)}" y2="${Y(c.limit)}"/><text x="${L + 4}" y="${Y(c.limit) - 3}">limit ${label(c.limit)}</text>`;
    c.series.forEach((s, k) => {
      const pts = s.data.map((v, i) => `${X(i, s.data.length).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
      out += `<polyline class="ln${k ? k + 1 : ''}" points="${pts}"/>`;
    });
    return out + '</svg>';
  }

  function renderCharts(r) {
    $('charts').innerHTML = r.charts.map(c => {
      const legend = c.series.length > 1 ? `<p class="lg">${c.series.map((s, k) => `<i class="c${k + 1}"></i>${s.label}`).join('')}</p>` : '';
      return `<div class="chart"><h3>${c.title}${c.unit ? ` <span class="best">(${c.unit})</span>` : ''}</h3>${legend}${chartSvg(c)}</div>`;
    }).join('');
  }

  // ------------------------------------------------------------ rounds
  function show() {
    const r = rounds[idx];
    answered = false; left = SECONDS;
    $('r-num').textContent = idx + 1; $('r-score').textContent = fmt(score); $('r-streak').textContent = streak;
    $('story').textContent = r.story;
    renderCharts(r);
    const opts = $('opts'); opts.innerHTML = '';
    r.options.forEach((o, i) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'opt';
      b.innerHTML = `<kbd>${i + 1}</kbd>`; b.appendChild(document.createTextNode(o));
      b.addEventListener('click', () => answer(o)); opts.appendChild(b);
    });
    $('explain').hidden = true;
    tickTimer();
    clearInterval(timer);
    timer = setInterval(() => { left = Math.max(0, left - 0.2); tickTimer(); if (left <= 0) answer(null); }, 200);
    $('game').scrollIntoView({ block: 'start', behavior: 'auto' });
  }

  function tickTimer() {
    $('r-time').textContent = Math.ceil(left);
    $('timer-bar').style.width = (left / SECONDS * 100) + '%';
    $('timer').classList.toggle('low', left <= 5);
  }

  function answer(choice) {
    if (answered) return;
    answered = true; clearInterval(timer);
    const r = rounds[idx], ok = choice === r.answer;
    let gained = 0;
    if (ok) { streak++; correct++; bestStreak = Math.max(bestStreak, streak); gained = 100 + Math.round(left * 5) + (streak - 1) * 20; score += gained; }
    else streak = 0;
    $('opts').querySelectorAll('.opt').forEach(b => {
      const t = b.textContent.slice(1);
      b.disabled = true;
      if (t === r.answer) b.classList.add('right');
      else if (t === choice) b.classList.add('wrong');
    });
    $('verdict').textContent = ok ? `✅ Right: ${r.answer}. +${gained}` : choice ? `❌ Not quite. It's ${r.answer}.` : `⏰ Time's up. It's ${r.answer}.`;
    $('why').textContent = r.explain;
    $('why-link').href = r.glossary;
    $('r-score').textContent = fmt(score); $('r-streak').textContent = streak;
    $('next').textContent = idx === ROUNDS - 1 ? 'See your result' : 'Next round';
    $('explain').hidden = false;
    $('next').focus({ preventScroll: true });
  }

  function next() { if (idx < ROUNDS - 1) { idx++; show(); } else finish(); }

  function finish() {
    clearInterval(timer);
    $('play').hidden = true; $('end').hidden = false;
    const best = P.store.get('spot-best');
    const isBest = !best || score > best.score;
    if (isBest) P.store.set('spot-best', { score, correct });
    P.track('spot-finish');
    const title = correct >= 9 ? 'Bottleneck whisperer' : correct >= 7 ? 'Sharp eyes' : correct >= 4 ? 'Getting there' : 'Back to the charts';
    $('end-title').textContent = `${title}: ${correct}/10`;
    $('e-score').textContent = fmt(score); $('e-correct').textContent = correct + '/10'; $('e-streak').textContent = bestStreak;
    $('e-best').textContent = fmt(isBest ? score : best.score);
    $('e-msg').textContent = (isBest && score > 0 ? 'New personal best. ' : '') +
      (correct >= 7 ? 'You read load test charts better than most. ' : 'Every one of these turns up in real load tests. ') + 'Play again for new charts and a different mix.';
    const text = `I spotted ${correct}/10 performance bottlenecks (score ${fmt(score)}, best streak ${bestStreak}) on Spot the Bottleneck. Can you read a load test faster?`;
    P.shareButtons($('share-row'), text, URL_, 'spot');
    $('end').scrollIntoView({ block: 'start', behavior: 'auto' });
  }

  $('go').addEventListener('click', start);
  $('again').addEventListener('click', start);
  $('next').addEventListener('click', next);
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || $('play').hidden) return;
    if (e.target.closest && e.target.closest('input, textarea, select')) return;
    if (!answered && /^[1-4]$/.test(e.key)) { const b = $('opts').querySelectorAll('.opt')[+e.key - 1]; if (b) { b.click(); e.preventDefault(); } }
  });
  document.addEventListener('visibilitychange', () => {
    // Don't let the clock run out in a background tab: pause by holding the time.
    if (document.hidden && !answered && !$('play').hidden) { clearInterval(timer); }
    else if (!document.hidden && !answered && !$('play').hidden && rounds) {
      clearInterval(timer); timer = setInterval(() => { left = Math.max(0, left - 0.2); tickTimer(); if (left <= 0) answer(null); }, 200);
    }
  });
  showBest();
  window.__spot = { get state() { return { idx, score, correct, answered, answer: rounds && rounds[idx] && rounds[idx].answer }; } };
})();
