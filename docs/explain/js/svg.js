// Tiny SVG helpers shared by the /explain/ pages.
(function (root) {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs || {}) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function text(parent, x, y, str, attrs) {
    const t = el('text', Object.assign({ x, y }, attrs || {}), parent);
    t.textContent = str;
    return t;
  }
  function clear(svg) { while (svg.firstChild) svg.removeChild(svg.firstChild); }
  // Pointer position in the SVG's own coordinates (works with CSS zoom and any rendered size).
  function point(svg, evt) {
    const p = svg.createSVGPoint();
    p.x = evt.clientX; p.y = evt.clientY;
    const m = svg.getScreenCTM();
    return m ? p.matrixTransform(m.inverse()) : { x: 0, y: 0 };
  }
  // "Nice" axis maximum and tick step for a value.
  function nice(max) {
    if (!(max > 0) || !isFinite(max)) return { max: 1, step: 0.2 };
    const raw = max / 5;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((s) => s >= raw);
    return { max: Math.ceil(max / step) * step, step };
  }
  function ms(v) {
    if (!isFinite(v)) return '∞';
    if (v >= 10000) return (v / 1000).toFixed(0) + ' s';
    if (v >= 1000) return (v / 1000).toFixed(1) + ' s';
    return Math.round(v) + ' ms';
  }
  // Narrow screens get a smaller coordinate system so chart text stays readable. Returns [W, H].
  function fit(svg, wide, narrow) {
    const d = svg.clientWidth && svg.clientWidth < 560 ? narrow : wide;
    svg.setAttribute('viewBox', `0 0 ${d[0]} ${d[1]}`);
    return d;
  }
  // Tick step in seconds for a time axis.
  function timeStep(total) {
    return [10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800].find((s) => total / s <= 6) || 21600;
  }
  const reduced = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  function copyButton(btn, getText) {
    btn.addEventListener('click', async () => {
      const t = getText();
      try { await navigator.clipboard.writeText(t); }
      catch (e) {
        const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); } catch (e2) { /* ignore */ }
        ta.remove();
      }
      const old = btn.textContent; btn.textContent = 'Copied ✓'; setTimeout(() => (btn.textContent = old), 1500);
    });
  }
  root.ExSvg = { el, text, clear, point, nice, ms, reduced, copyButton, fit, timeStep };
})(this);
