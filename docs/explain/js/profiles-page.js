// /explain/load-profiles/ — draw and edit load test shapes, see what each finds, export the k6 options.
(() => {
  'use strict';
  const P = window.ExplainProfiles;
  const { el, text, clear, point, nice, copyButton, fit, timeStep } = window.ExSvg;
  const $ = (id) => document.getElementById(id);
  const svg = $('shape');
  let W = 620, H = 360;
  const L = 48, R = 18, T = 28, B = 40;
  let key = 'load';
  let prof = null;
  let drag = -1;

  function clone(k) {
    const p = P.PRESETS[k];
    return Object.assign({}, p, { points: p.points.map((q) => ({ t: q.t, v: q.v })) });
  }
  function setPreset(k) {
    key = k;
    prof = clone(k);
    document.querySelectorAll('[data-profile]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.profile === k)));
    $('p-name').textContent = prof.name;
    $('p-finds').textContent = prof.finds;
    $('p-watch').textContent = prof.watch;
    $('p-when').textContent = prof.when;
    render();
  }

  let xMax = 1, yMax = 1;
  const fmtT = (s) => (s >= 3600 ? (s / 3600).toFixed(s % 3600 ? 1 : 0) + ' h' : s >= 60 ? Math.round(s / 60) + ' min' : Math.round(s) + ' s');
  // fixedScale: while dragging, keep the axes still so the point doesn't run away from the pointer.
  function render(fixedScale) {
    [W, H] = fit(svg, [620, 360], [440, 320]);
    const pts = prof.points;
    const wantX = Math.max(60, P.totalSeconds(pts));
    const wantY = nice(P.peak(pts) * 1.25 || 10).max;
    if (!fixedScale || wantX > xMax || P.peak(pts) * 1.05 > yMax) { xMax = wantX; yMax = wantY; }
    const x = (t) => L + (t / xMax) * (W - L - R);
    const y = (v) => H - B - (v / yMax) * (H - T - B);
    clear(svg);
    const yt = nice(yMax);
    for (let v = 0; v <= yMax + 1e-9; v += yt.step) {
      el('line', { class: 'grid', x1: L, x2: W - R, y1: y(v), y2: y(v) }, svg);
      text(svg, L - 6, y(v) + 4, String(Math.round(v)), { 'text-anchor': 'end' });
    }
    const xs = timeStep(xMax);
    for (let t = 0; t <= xMax + 1e-9; t += xs) {
      el('line', { class: 'grid', x1: x(t), x2: x(t), y1: T, y2: H - B }, svg);
      text(svg, x(t), H - B + 18, fmtT(t), { 'text-anchor': t === 0 ? 'start' : x(t) > W - R - 30 ? 'end' : 'middle' });
    }
    el('line', { class: 'axis', x1: L, x2: W - R, y1: H - B, y2: H - B }, svg);
    text(svg, L, T - 8, prof.unit === 'VUs' ? 'Virtual users' : 'Requests per second', { 'font-weight': 700 });
    text(svg, W - R, H - 6, 'Time →', { 'text-anchor': 'end' });
    const d = pts.map((p, i) => (i ? 'L' : 'M') + x(p.t).toFixed(1) + ' ' + y(p.v).toFixed(1)).join(' ');
    el('path', { class: 'area', d: d + ` L ${x(pts[pts.length - 1].t)} ${y(0)} L ${x(0)} ${y(0)} Z` }, svg);
    const line = el('path', { class: 'line', d }, svg);
    line.style.cursor = 'copy';
    line.addEventListener('pointerdown', (e) => { e.stopPropagation(); addPoint(e); });
    pts.forEach((p, i) => {
      const c = el('circle', { class: 'dot' + (i === drag ? ' drag' : ''), cx: x(p.t), cy: y(p.v), r: 8, tabindex: 0, 'aria-label': `Point ${i + 1}: ${Math.round(p.v)} at ${fmtT(p.t)}` }, svg);
      c.addEventListener('pointerdown', (e) => { e.stopPropagation(); drag = i; svg.setPointerCapture(e.pointerId); });
      c.addEventListener('dblclick', () => removePoint(i));
      c.addEventListener('keydown', (e) => keyMove(e, i));
    });
    $('p-peak').textContent = `${Math.round(P.peak(pts))} ${prof.unit}`;
    $('p-dur').textContent = P.dur(P.totalSeconds(pts)).replace(/(\d)([hms])/g, '$1$2 ').trim();
    $('code').textContent = P.toScript(prof, budgets(), prof.name);
  }
  function budgets() { return { p95: Math.max(1, +$('b-p95').value || 800), errorRate: Math.max(0, Math.min(1, (+$('b-err').value || 1) / 100)) }; }

  function toData(evt) {
    const p = point(svg, evt);
    return { t: ((p.x - L) / (W - L - R)) * xMax, v: ((H - B - p.y) / (H - T - B)) * yMax };
  }
  function clampPoint(i, t, v) {
    const pts = prof.points;
    const lo = i === 0 ? 0 : pts[i - 1].t;
    const hi = i === pts.length - 1 ? Math.max(lo + 5, xMax * 1.5) : pts[i + 1].t;
    pts[i].t = i === 0 ? 0 : Math.round(Math.min(hi, Math.max(lo, t)) / 5) * 5;
    pts[i].v = Math.max(0, Math.round(v));
  }
  svg.addEventListener('pointermove', (e) => {
    if (drag < 0) return;
    const d = toData(e);
    clampPoint(drag, d.t, d.v);
    render(true);
  });
  ['pointerup', 'pointercancel'].forEach((t) => svg.addEventListener(t, () => { if (drag >= 0) { drag = -1; render(); } }));
  function addPoint(evt) {
    const d = toData(evt);
    const pts = prof.points;
    let i = pts.findIndex((p) => p.t > d.t);
    if (i <= 0) return;
    pts.splice(i, 0, { t: Math.round(d.t / 5) * 5, v: Math.max(0, Math.round(P.valueAt(pts, d.t))) });
    render();
  }
  function removePoint(i) { if (prof.points.length > 2 && i > 0) { prof.points.splice(i, 1); render(); } }
  function keyMove(e, i) {
    const p = prof.points[i];
    const step = e.shiftKey ? 10 : 1;
    const moves = { ArrowUp: [0, step], ArrowDown: [0, -step], ArrowRight: [step * 5, 0], ArrowLeft: [-step * 5, 0] };
    if (e.key === 'Delete' || e.key === 'Backspace') { removePoint(i); e.preventDefault(); return; }
    if (!moves[e.key]) return;
    e.preventDefault();
    clampPoint(i, p.t + moves[e.key][0], p.v + moves[e.key][1]);
    render();
    const dots = svg.querySelectorAll('.dot');
    if (dots[i]) dots[i].focus();
  }

  document.querySelectorAll('[data-profile]').forEach((b) => b.addEventListener('click', () => setPreset(b.dataset.profile)));
  $('reset').addEventListener('click', () => setPreset(key));
  ['b-p95', 'b-err'].forEach((id) => $(id).addEventListener('input', () => ($('code').textContent = P.toScript(prof, budgets(), prof.name))));
  copyButton($('copy'), () => $('code').textContent);
  $('download').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([$('code').textContent], { type: 'text/javascript' }));
    a.download = key + '-test.js';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  setPreset('load');
  let rt;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => render(), 120); });
})();
