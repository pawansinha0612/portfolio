// /explain/queueing/ — the hockey stick: utilisation vs response time (M/M/c), animated queue, Little's law.
(() => {
  'use strict';
  const Q = window.ExplainQueue;
  const { el, text, clear, nice, ms, reduced, fit } = window.ExSvg;
  const $ = (id) => document.getElementById(id);
  const svc = $('svc'), srv = $('srv'), rate = $('rate');
  let W = 900, H = 340;
  const L = 60, R = 16, T = 24, B = 40;
  const chart = $('curve');

  function sync(keepRho) {
    const mu = 1000 / +svc.value;
    const c = +srv.value;
    const cap = c * mu;
    rate.max = String(Math.max(1, Math.round(cap * 1.05)));
    rate.step = cap > 200 ? '1' : cap > 20 ? '0.5' : '0.1';
    if (keepRho != null) rate.value = String(Math.min(+rate.max, keepRho * cap));
    draw();
  }
  let lastRho = 0.7;
  svc.addEventListener('input', () => sync(lastRho));
  srv.addEventListener('input', () => sync(lastRho));
  rate.addEventListener('input', () => draw());
  document.querySelectorAll('[data-rho]').forEach((b) => b.addEventListener('click', () => {
    const cap = (+srv.value * 1000) / +svc.value;
    rate.value = String(Math.min(+rate.max, +b.dataset.rho * cap));
    draw();
  }));

  function draw() {
    const s = +svc.value, c = +srv.value, lam = +rate.value;
    const q = Q.mmc(lam, s, c);
    lastRho = Math.min(q.rho, 1.05);
    $('svc-o').textContent = s + ' ms';
    $('srv-o').textContent = c;
    $('rate-o').textContent = (lam >= 100 ? Math.round(lam) : lam.toFixed(1)) + ' req/s';

    // chart
    [W, H] = fit(chart, [900, 340], [480, 340]);
    const pts = Q.curve(s, c, 120);
    const yTop = nice(s * 12).max;
    const x = (r) => L + r * (W - L - R);
    const y = (v) => H - B - (Math.min(v, yTop) / yTop) * (H - T - B);
    clear(chart);
    el('rect', { class: 'zone', x: x(0.8), y: T, width: x(1) - x(0.8), height: H - T - B }, chart);
    text(chart, x(0.9), H - B - 10, 'danger zone', { 'text-anchor': 'middle', fill: '#d1453b', 'font-weight': 700 });
    const tk = nice(yTop);
    for (let v = 0; v <= yTop + 1e-9; v += tk.step) {
      el('line', { class: 'grid', x1: L, x2: W - R, y1: y(v), y2: y(v) }, chart);
      text(chart, L - 6, y(v) + 4, ms(v), { 'text-anchor': 'end' });
    }
    for (let r = 0; r <= 1.0001; r += 0.2) text(chart, x(r), H - B + 18, Math.round(r * 100) + '%', { 'text-anchor': r > 0.99 ? 'end' : 'middle' });
    el('line', { class: 'axis', x1: L, x2: W - R, y1: H - B, y2: H - B }, chart);
    text(chart, W - R, H - 6, W < 600 ? 'Utilisation →' : 'Utilisation (how busy the servers are) →', { 'text-anchor': 'end' });
    const path = (key) => pts.filter((p) => p[key] < yTop * 1.5).map((p, i) => (i ? 'L' : 'M') + x(p.rho).toFixed(1) + ' ' + y(p[key]).toFixed(1)).join(' ');
    el('path', { class: 'line alt', d: path('p95Ms') }, chart);
    el('path', { class: 'line', d: path('wMs') }, chart);
    text(chart, L + 8, T + 14, '— average', { fill: 'var(--accent)', 'font-weight': 700 });
    text(chart, L + 8, T + 30, '- - p95', { fill: '#e0675f', 'font-weight': 700 });
    if (q.stable) {
      el('line', { class: 'now', x1: x(q.rho), x2: x(q.rho), y1: T, y2: H - B, 'stroke-dasharray': '3 4' }, chart);
      el('circle', { class: 'dot', cx: x(q.rho), cy: y(q.wMs), r: 7 }, chart);
      el('circle', { cx: x(q.rho), cy: y(q.p95Ms), r: 5, fill: '#e0675f' }, chart);
    } else {
      text(chart, x(0.98), y(yTop * 0.6), 'over capacity: the queue grows forever', { 'text-anchor': 'end', fill: '#d1453b', 'font-weight': 700 });
    }

    // stats
    const tiles = [['Utilisation', q.stable ? Math.round(q.rho * 100) + '%' : '≥100%'], ['Chance of waiting', Math.round(q.pWait * 100) + '%'],
      ['Avg wait in queue', ms(q.wqMs)], ['Avg response', ms(q.wMs)], ['p95 response', ms(q.p95Ms)], ['p99 response', ms(q.p99Ms)]];
    $('stats').innerHTML = tiles.map(([k, v], i) => `<div class="ex-stat${i === 0 || i === 4 ? ' key' : ''}"><span>${k}</span><b>${v}</b></div>`).join('');
    const note = $('note');
    if (!q.stable) { note.className = 'ex-callout warn'; note.textContent = `More requests arrive (${Math.round(lam)}/s) than ${c} server${c > 1 ? 's' : ''} can finish (${Math.round(c * q.mu)}/s). Every second the queue gets longer, until timeouts and errors.`; }
    else if (q.rho > 0.8) { note.className = 'ex-callout warn'; note.textContent = `At ${Math.round(q.rho * 100)}% busy, the work per request is still ${s} ms, but p95 is ${ms(q.p95Ms)}: ${(q.p95Ms / s).toFixed(1)}× the service time. Small traffic increases now cause big slowdowns.`; }
    else { note.className = 'ex-callout ok'; note.textContent = `Comfortable: at ${Math.round(q.rho * 100)}% busy, p95 is ${ms(q.p95Ms)}. Push the traffic slider right and watch the curve bend.`; }

    // Little's law
    $('ll-lam').textContent = lam >= 100 ? Math.round(lam) : lam.toFixed(1);
    $('ll-w').textContent = q.stable ? (q.wMs / 1000).toFixed(3) : '∞';
    $('ll-l').textContent = q.stable ? (q.L >= 10 ? Math.round(q.L) : q.L.toFixed(1)) : '∞';
    $('ll-note').textContent = q.stable
      ? `On average ${q.L >= 10 ? Math.round(q.L) : q.L.toFixed(1)} requests are inside the system at once (${Math.min(q.L, q.a).toFixed(1)} being served, ${q.Lq.toFixed(1)} waiting). That's roughly how many threads, connections or VUs this traffic needs.`
      : 'With an endless queue, the number of requests in the system has no limit either. Something will run out: threads, connections or memory.';
    anim.update(c, Math.min(q.rho, 1.15));
  }

  // ---------------------------------------------------------------- slow-motion queue animation
  const anim = (() => {
    const box = $('queue');
    const VW = 900, VH = 150;
    const SVC = 1.4; // seconds per request in slow motion
    let c = 4, rho = 0.7, servers = [], queue = [], next = 0, last = 0, running = false;
    const r = () => -Math.log(1 - Math.random());
    function layout() {
      clear(box);
      servers = [];
      const cols = Math.min(c, 16);
      const sw = Math.min(46, (VW * 0.42) / cols - 6);
      for (let i = 0; i < c; i++) {
        const col = i % cols, row = Math.floor(i / cols);
        const x = VW - 24 - (cols - col) * (sw + 6), y = 20 + row * (sw + 10);
        el('rect', { x, y, width: sw, height: sw, rx: 8, fill: 'var(--surface)', stroke: 'var(--border)', 'stroke-width': 2 }, box);
        const busy = el('circle', { cx: x + sw / 2, cy: y + sw / 2, r: sw / 4, fill: 'var(--accent)', opacity: 0 }, box);
        servers.push({ until: 0, busy });
      }
      text(box, VW - 24, VH - 8, 'servers', { 'text-anchor': 'end' });
      text(box, 16, VH - 8, 'queue (slow motion, same utilisation)', {});
      box.qg = el('g', {}, box);
      box.count = text(box, 16, 22, '', { 'font-weight': 700, fill: 'var(--text)' });
    }
    function update(nc, nrho) {
      if (nc !== c) { c = nc; layout(); queue = []; }
      rho = nrho;
      if (!running && !reduced()) { running = true; last = performance.now() / 1000; next = last; requestAnimationFrame(tick); }
      if (reduced()) renderStatic();
    }
    function renderStatic() {
      const q = Q.mmc(rho * c, 1000, c);
      const n = q.stable ? Math.min(30, Math.round(q.Lq)) : 30;
      queue = new Array(n).fill(0);
      servers.forEach((s, i) => s.busy.setAttribute('opacity', i < Math.round(Math.min(1, rho) * c) ? 1 : 0));
      paintQueue();
    }
    function paintQueue() {
      clear(box.qg);
      const shown = Math.min(queue.length, 34);
      for (let i = 0; i < shown; i++) el('circle', { cx: VW * 0.5 - 40 - i * 14, cy: 60, r: 5.5, fill: i > 20 ? '#d1453b' : '#e0a33a' }, box.qg);
      box.count.textContent = queue.length ? `${queue.length} waiting` + (queue.length > shown ? ' (and growing)' : '') : 'no queue';
    }
    function tick(nowMs) {
      if (reduced()) { running = false; renderStatic(); return; }
      const now = nowMs / 1000;
      last = now;
      const lam = (rho * c) / SVC;
      while (next <= now) { queue.push(next); next += r() / Math.max(lam, 1e-6); }
      servers.forEach((s) => {
        if (s.until <= now && queue.length) { queue.shift(); s.until = now + SVC * r(); }
        s.busy.setAttribute('opacity', s.until > now ? 1 : 0);
      });
      if (queue.length > 400) queue.length = 400;
      paintQueue();
      requestAnimationFrame(tick);
    }
    layout();
    return { update };
  })();

  sync(0.7);
  let rt;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(draw, 120); });
})();
