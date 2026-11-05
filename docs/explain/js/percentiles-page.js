// /explain/percentiles/ — latency playground and coordinated omission demo.
(() => {
  'use strict';
  const S = window.ExplainStats;
  const { el, text, clear, point, nice, ms, fit } = window.ExSvg;
  let W = 900, H = 340;
  const L = 48, R = 16, T = 34, B = 40;
  const svg = document.getElementById('hist');
  const statsBox = document.getElementById('stats');
  const callout = document.getElementById('callout');
  let presetKey = 'healthy';
  let base = [];
  let extra = [];

  const MARKS = [
    { k: 'mean', label: 'avg', color: 'var(--accent-2)' },
    { k: 'p50', label: 'p50', color: 'var(--muted)' },
    { k: 'p90', label: 'p90', color: '#d99a00' },
    { k: 'p95', label: 'p95', color: '#e07b39' },
    { k: 'p99', label: 'p99', color: '#d1453b' }
  ];

  function setPreset(k) {
    presetKey = k;
    base = S.generate(Object.assign({ seed: 42 }, S.PRESETS[k]));
    extra = [];
    document.querySelectorAll('[data-preset]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.preset === k)));
    draw();
  }

  let xMax = 400;
  function draw() {
    [W, H] = fit(svg, [900, 340], [480, 340]);
    const all = base.concat(extra);
    const s = S.summary(all);
    xMax = nice(Math.max(300, Math.min(s.max, s.p99 * 1.6))).max;
    const bins = W < 600 ? 36 : 60;
    const h = S.histogram(all, bins, xMax);
    const yMax = Math.max(...h) * 1.12;
    const x = (v) => L + (Math.min(v, xMax) / xMax) * (W - L - R);
    const y = (c) => H - B - (c / yMax) * (H - T - B);
    clear(svg);
    const tk = nice(xMax);
    for (let v = 0; v <= xMax + 1e-9; v += tk.step) {
      el('line', { class: 'grid', x1: x(v), x2: x(v), y1: T, y2: H - B }, svg);
      text(svg, x(v), H - B + 18, ms(v), { 'text-anchor': v === 0 ? 'start' : v + tk.step > xMax + 1e-9 ? 'end' : 'middle' });
    }
    el('line', { class: 'axis', x1: L, x2: W - R, y1: H - B, y2: H - B }, svg);
    text(svg, L, H - 6, 'Response time →', {});
    text(svg, W - R, H - 6, `${all.length.toLocaleString('en-AU')} requests`, { 'text-anchor': 'end' });
    const bw = (W - L - R) / bins;
    h.forEach((c, i) => {
      if (!c) return;
      const lo = (i * xMax) / bins;
      el('rect', { class: 'hbar' + (lo >= s.p95 ? ' tail' : ''), x: L + i * bw + 0.5, y: y(c), width: Math.max(1, bw - 1), height: H - B - y(c), rx: 1.5 }, svg);
    });
    if (s.max > xMax) text(svg, W - R, T - 18 + 0, `max ${ms(s.max)} →`, { 'text-anchor': 'end', fill: '#d1453b', 'font-weight': 700 });
    // markers, staggered vertically so labels never collide
    const used = [];
    MARKS.forEach((m) => {
      const v = s[m.k];
      const px = x(v);
      let row = 0;
      while (used.some((u) => u.row === row && Math.abs(u.px - px) < 44)) row++;
      used.push({ row, px });
      const g = el('g', { class: 'mark' }, svg);
      el('line', { x1: px, x2: px, y1: T + row * 14 - 4, y2: H - B, stroke: m.color, 'stroke-dasharray': m.k === 'mean' ? '6 4' : null }, g);
      text(g, px + 4, T + row * 14 + 6, m.label, { fill: m.color });
    });
    statsBox.innerHTML = [['avg', s.mean], ['p50', s.p50], ['p90', s.p90], ['p95', s.p95], ['p99', s.p99], ['max', s.max]]
      .map(([k, v]) => `<div class="ex-stat${k === 'avg' || k === 'p99' ? ' key' : ''}"><span>${k}</span><b>${ms(v)}</b></div>`).join('');
    const ratio = s.p99 / s.mean;
    const slow = all.filter((v) => v > 2 * s.mean).length;
    callout.className = 'ex-callout ' + (ratio > 2.5 ? 'warn' : 'ok');
    callout.textContent = ratio > 2.5
      ? `The average says ${ms(s.mean)}. But 1 in 100 requests takes over ${ms(s.p99)}, ${ratio.toFixed(1)}× the average, and ${slow.toLocaleString('en-AU')} requests took more than twice the average. The average hides them.`
      : `Healthy: p99 is ${ratio.toFixed(1)}× the average. Now try a preset, or click on the chart to add slow requests.`;
  }

  // Click or drag on the chart to add slow requests at that latency.
  let dragging = false;
  let lastAdd = 0;
  function addAt(evt) {
    const p = point(svg, evt);
    const v = ((p.x - L) / (W - L - R)) * xMax;
    if (v <= 0) return;
    for (let i = 0; i < 10; i++) extra.push(Math.max(1, v * (0.97 + 0.06 * Math.random())));
    draw();
  }
  svg.addEventListener('pointerdown', (e) => { dragging = true; svg.setPointerCapture(e.pointerId); addAt(e); });
  svg.addEventListener('pointermove', (e) => { if (dragging && performance.now() - lastAdd > 60) { lastAdd = performance.now(); addAt(e); } });
  ['pointerup', 'pointercancel'].forEach((t) => svg.addEventListener(t, () => (dragging = false)));

  document.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => setPreset(b.dataset.preset)));
  document.getElementById('add-slow').addEventListener('click', () => {
    const s = S.summary(base.concat(extra));
    for (let i = 0; i < 20; i++) extra.push(s.p50 * (6 + 4 * Math.random()));
    draw();
  });
  document.getElementById('reset').addEventListener('click', () => setPreset(presetKey));
  setPreset('healthy');

  // ---------------------------------------------------------------- coordinated omission
  const co = S.coordinatedOmission();
  const coSvg = document.getElementById('co');
  const coStats = document.getElementById('co-stats');
  const coNote = document.getElementById('co-note');
  function drawCo(view) {
    [W, H] = fit(coSvg, [900, 340], [480, 340]);
    const vals = co[view];
    const s = S.summary(vals);
    const dur = 60000;
    const yTop = nice(Math.max(...co.corrected)).max;
    const x = (i) => L + (i / (vals.length - 1)) * (W - L - R);
    const y = (v) => H - B - (v / yTop) * (H - T - B);
    clear(coSvg);
    const tk = nice(yTop);
    for (let v = 0; v <= yTop + 1e-9; v += tk.step) {
      el('line', { class: 'grid', x1: L, x2: W - R, y1: y(v), y2: y(v) }, coSvg);
      text(coSvg, L - 6, y(v) + 4, ms(v), { 'text-anchor': 'end' });
    }
    el('rect', { class: 'zone', x: x(30000 / 50), y: T, width: x(33000 / 50) - x(30000 / 50), height: H - T - B }, coSvg);
    text(coSvg, x(31500 / 50), T - 8, 'server frozen for 3 s', { 'text-anchor': 'middle', fill: '#d1453b', 'font-weight': 700 });
    el('line', { class: 'axis', x1: L, x2: W - R, y1: H - B, y2: H - B }, coSvg);
    for (let sec = 0; sec <= 60; sec += 10) text(coSvg, x((sec * 1000) / 50), H - B + 18, sec + ' s', { 'text-anchor': sec === 60 ? 'end' : 'middle' });
    const d = vals.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1)).join(' ');
    el('path', { class: 'line' + (view === 'corrected' ? ' alt' : ''), d }, coSvg);
    text(coSvg, W - R, H - 6, W < 600 ? 'one request every 50 ms' : `${vals.length.toLocaleString('en-AU')} requests planned, one every 50 ms`, { 'text-anchor': 'end' });
    coStats.innerHTML = [['p50', s.p50], ['p95', s.p95], ['p99', s.p99], ['max', s.max]]
      .map(([k, v]) => `<div class="ex-stat${k === 'p99' ? ' key' : ''}"><span>${k}</span><b>${ms(v)}</b></div>`).join('');
    const slow = vals.filter((v) => v > 500).length;
    coNote.className = 'ex-callout ' + (view === 'measured' ? 'ok' : 'warn');
    coNote.textContent = view === 'measured'
      ? `The tool waited for each reply before sending the next, so during the freeze it sent nothing. It recorded one slow request, and p99 still looks great: ${ms(s.p99)}.`
      : `Measured from when each request should have started, ${slow} requests were slower than 500 ms. Real users kept arriving during the freeze. p99 is really ${ms(s.p99)}.`;
    document.querySelectorAll('[data-co]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.co === view)));
    void dur;
  }
  let coView = 'measured';
  document.querySelectorAll('[data-co]').forEach((b) => b.addEventListener('click', () => drawCo((coView = b.dataset.co))));
  drawCo(coView);
  let rt;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { draw(); drawCo(coView); }, 120); });
})();
