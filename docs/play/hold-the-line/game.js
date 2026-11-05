/* Hold the Line: game UI. The model lives in sim.js (window.HoldSim). */
(function () {
  'use strict';
  const S = window.HoldSim, P = window.Play;
  const $ = (id) => document.getElementById(id);
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fmt = (n) => Math.round(n).toLocaleString('en-AU');
  const money = (n) => '$' + (Math.round(n * 10) / 10).toLocaleString('en-AU');
  const URL_ = 'https://pawansinha.com.au/play/hold-the-line/';
  const SVGNS = 'http://www.w3.org/2000/svg';

  $('warm-s').textContent = S.K.WARMUP;

  // ------------------------------------------------------------ state
  let cfg, waveIdx, lives, score, run, running, paused, speed, acc, lastTs, hist, peak, waveStats, over;
  function reset() {
    cfg = S.defaultConfig(); waveIdx = 0; lives = 3; score = 0; run = null; running = false; paused = false; acc = 0;
    hist = []; peak = { rps: 0, p95: 0 }; over = false; speed = speed || 1;
  }

  // ------------------------------------------------------------ shop
  const CACHE = ['Off', 'Small', 'Medium', 'Large'], DBS = ['Small', 'Large', 'X-Large'];
  const ITEMS = [
    { id: 'servers', name: 'App servers', desc: `Each serves ${S.K.APP_RPS} req/s. Latency climbs fast past ~80% busy.`, kind: 'count', min: 1, max: 30,
      price: () => money(S.COST.server) + '/h each', show: () => String(totalServers()) },
    { id: 'cache', name: 'Cache', desc: 'Page and product cache. Hits never touch the database.', kind: 'level', min: 0, max: 3,
      price: () => cfg.cache ? money(S.COST.cache[cfg.cache]) + '/h' : 'from ' + money(S.COST.cache[1]) + '/h', show: () => CACHE[cfg.cache] + (cfg.cache ? ` (${Math.round(S.K.CACHE_HIT[cfg.cache] * 100)}% hits)` : '') },
    { id: 'cdn', name: 'CDN', desc: `Serves ${Math.round(S.K.CDN_OFFLOAD * 100)}% of browsing at the edge. Checkouts still reach you.`, kind: 'toggle', price: () => money(S.COST.cdn) + '/h' },
    { id: 'replicas', name: 'Read replicas', desc: 'Extra database copies for reads. Writes still go to the primary.', kind: 'count', min: 0, max: 3,
      price: () => money(S.COST.replica) + '/h each', show: () => String(cfg.replicas) },
    { id: 'dbSize', name: 'Primary database', desc: 'A bigger primary handles more reads and all the writes.', kind: 'level', min: 0, max: 2,
      price: () => cfg.dbSize ? money(S.COST.dbSize[cfg.dbSize]) + '/h' : 'Large ' + money(S.COST.dbSize[1]) + '/h', show: () => DBS[cfg.dbSize] },
    { id: 'pooler', name: 'Connection pooler', desc: `Raises the database connection limit from ${S.K.DB_CONN} to ${S.K.POOLER_CONN}.`, kind: 'toggle', price: () => money(S.COST.pooler) + '/h' },
    { id: 'queue', name: 'Checkout queue', desc: 'Orders wait in line instead of failing when the database is busy.', kind: 'toggle', price: () => money(S.COST.queue) + '/h' },
    { id: 'limiter', name: 'Rate limiter', desc: `Blocks ${Math.round(S.K.LIMITER_BOT_BLOCK * 100)}% of bot traffic before it reaches your servers.`, kind: 'toggle', price: () => money(S.COST.limiter) + '/h' },
    { id: 'autoscale', name: 'Autoscaling', desc: `Adds servers at ${Math.round(S.K.SCALE_AT * 100)}% CPU, up to 30. They still take ${S.K.WARMUP} s to warm up.`, kind: 'toggle', price: () => money(S.COST.autoscale) + '/h + servers' },
  ];

  function totalServers() { return run && running ? run.warm + run.pending.length : cfg.servers; }

  function buildShop() {
    const shop = $('shop'); shop.innerHTML = '';
    ITEMS.forEach(it => {
      const d = document.createElement('div'); d.className = 'item'; d.id = 'it-' + it.id;
      d.innerHTML = `<header><h3>${it.name}</h3><span class="price"></span></header><p>${it.desc}</p><div class="ctl"></div>`;
      const ctl = d.querySelector('.ctl');
      if (it.kind === 'toggle') {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'gbtn'; b.style.flex = '1';
        b.setAttribute('aria-pressed', 'false'); b.dataset.track = 'hold-buy-' + it.id;
        b.addEventListener('click', () => { cfg[it.id] = !cfg[it.id]; refreshShop(); render(run && run.last); });
        ctl.appendChild(b);
      } else {
        const minus = document.createElement('button'), plus = document.createElement('button'), out = document.createElement('output');
        minus.type = plus.type = 'button'; minus.className = plus.className = 'gbtn';
        minus.textContent = '−'; plus.textContent = '+';
        minus.setAttribute('aria-label', 'Less ' + it.name); plus.setAttribute('aria-label', 'More ' + it.name);
        plus.dataset.track = 'hold-buy-' + it.id;
        minus.addEventListener('click', () => change(it, -1)); plus.addEventListener('click', () => change(it, +1));
        ctl.append(minus, out, plus);
      }
      shop.appendChild(d);
    });
    refreshShop();
  }

  function change(it, delta) {
    if (it.id === 'servers') {
      const total = totalServers();
      if (total + delta < it.min || total + delta > it.max) return;
      if (running && run) {
        if (delta > 0) S.addServers(run, 1);
        else if (run.pending.length) run.pending.pop();
        else run.warm--;
        cfg.servers = run.warm + run.pending.length;
      } else cfg.servers = total + delta;
    } else {
      const v = cfg[it.id] + delta;
      if (v < it.min || v > it.max) return;
      cfg[it.id] = v;
    }
    refreshShop(); render(run && run.last);
  }

  function refreshShop() {
    ITEMS.forEach(it => {
      const d = $('it-' + it.id); if (!d) return;
      d.querySelector('.price').textContent = it.price();
      if (it.kind === 'toggle') {
        const b = d.querySelector('button'); b.textContent = cfg[it.id] ? 'On' : 'Off';
        b.setAttribute('aria-pressed', String(!!cfg[it.id])); b.classList.toggle('primary', !!cfg[it.id]);
        d.classList.toggle('on', !!cfg[it.id]);
      } else {
        d.querySelector('output').textContent = it.show();
        const v = it.id === 'servers' ? totalServers() : cfg[it.id];
        const [minus, plus] = d.querySelectorAll('button');
        minus.disabled = v <= it.min; plus.disabled = v >= it.max;
        d.classList.toggle('on', it.id !== 'servers' && v > it.min);
      }
    });
  }

  // ------------------------------------------------------------ architecture diagram
  // Two layouts: wide (left to right) and tall (top to bottom, for phones) so text stays readable.
  const LAYOUTS = {
    wide: { vb: [720, 300], grid: { cols: 6, x0: 12, y0: 112, dx: 25, dy: 22 }, N: {
      users: { x: 6, y: 118, w: 104, h: 64 }, limiter: { x: 128, y: 118, w: 100, h: 64 }, cdn: { x: 246, y: 118, w: 88, h: 64 },
      app: { x: 352, y: 34, w: 168, h: 232 }, cache: { x: 556, y: 14, w: 158, h: 64 }, queue: { x: 556, y: 100, w: 158, h: 64 },
      db: { x: 556, y: 186, w: 158, h: 100 } } },
    tall: { vb: [360, 480], grid: { cols: 10, x0: 14, y0: 70, dx: 32, dy: 26 }, N: {
      users: { x: 4, y: 6, w: 112, h: 62 }, limiter: { x: 124, y: 6, w: 112, h: 62 }, cdn: { x: 244, y: 6, w: 112, h: 62 },
      app: { x: 4, y: 96, w: 352, h: 160 }, cache: { x: 4, y: 290, w: 156, h: 62 }, queue: { x: 200, y: 290, w: 156, h: 62 },
      db: { x: 4, y: 386, w: 352, h: 78 } } },
  };
  const LABELS = { users: 'Users', limiter: 'Rate limiter', cdn: 'CDN', app: 'App servers', cache: 'Cache', queue: 'Checkout queue', db: 'Database' };
  const narrow = window.matchMedia ? window.matchMedia('(max-width: 640px)') : { matches: false };
  let L = narrow.matches ? LAYOUTS.tall : LAYOUTS.wide, N = L.N;
  const mid = (n) => [n.x + n.w / 2, n.y + n.h / 2];
  const LINKS = [['users', 'limiter'], ['limiter', 'cdn'], ['cdn', 'app'], ['app', 'cache'], ['app', 'queue'], ['app', 'db'], ['queue', 'db']];
  const nodeEls = {};

  function el(tag, attrs, parent) { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; }

  // Arrow from A to B: side to side if B is to the right, top to bottom if B is below.
  function anchor(A, B) {
    if (B.x >= A.x + A.w - 1) {
      const y = Math.max(A.y + 12, Math.min(A.y + A.h - 12, B.y + B.h / 2));
      return [[A.x + A.w, y], [B.x - 2, Math.max(B.y + 8, Math.min(B.y + B.h - 8, y))]];
    }
    const lo = Math.max(A.x, B.x), hi = Math.min(A.x + A.w, B.x + B.w);
    const x = lo < hi ? (lo + hi) / 2 : A.x + A.w / 2;
    return [[x, A.y + A.h], [x, B.y - 2]];
  }

  function buildDiagram() {
    L = narrow.matches ? LAYOUTS.tall : LAYOUTS.wide; N = L.N;
    const svg = $('arch'), links = $('links'), nodes = $('nodes');
    svg.setAttribute('viewBox', `0 0 ${L.vb[0]} ${L.vb[1]}`);
    links.innerHTML = ''; nodes.innerHTML = ''; clearDots();
    LINKS.forEach(([a, b]) => {
      let [p1, p2] = anchor(N[a], N[b]);
      // In the tall layout the app → database arrow runs down the gap between cache and queue.
      if (a === 'app' && b === 'db' && L === LAYOUTS.tall) { p1 = [180, N.app.y + N.app.h]; p2 = [180, N.db.y - 2]; }
      el('path', { class: 'link', d: `M${p1[0]} ${p1[1]} L${p2[0]} ${p2[1]}`, 'marker-end': 'url(#ah)' }, links);
    });
    Object.keys(N).forEach(k => {
      const n = N[k], g = el('g', { class: 'node', id: 'n-' + k }, nodes);
      el('rect', { x: n.x, y: n.y, width: n.w, height: n.h, rx: 10 }, g);
      const t = el('text', { x: n.x + 10, y: n.y + 20 }, g); t.textContent = LABELS[k];
      const s = el('text', { x: n.x + 10, y: n.y + 38, class: 'sub' }, g);
      const s2 = el('text', { x: n.x + 10, y: n.y + 54, class: 'sub' }, g);
      nodeEls[k] = { g, s, s2 };
    });
    // Server grid (up to 30 servers).
    const grid = el('g', { id: 'srv-grid' }, nodes), G = L.grid;
    for (let i = 0; i < 30; i++) {
      const c = i % G.cols, r = Math.floor(i / G.cols);
      el('rect', { x: N.app.x + G.x0 + c * G.dx, y: N.app.y + G.y0 + r * G.dy, width: G.dx - 6, height: G.dy - 6, rx: 3, class: 'srv', id: 'srv-' + i, visibility: 'hidden' }, grid);
    }
  }
  if (narrow.addEventListener) narrow.addEventListener('change', () => { buildDiagram(); render(run && run.last); });

  function setNode(k, state, sub, sub2) {
    const n = nodeEls[k]; n.g.setAttribute('class', 'node ' + state); n.s.textContent = sub || ''; n.s2.textContent = sub2 || '';
  }
  const lvl = (u) => u > 0.95 ? 'bad' : u > 0.8 ? 'warn' : 'ok';

  // ------------------------------------------------------------ rendering
  function meter(id, value, state) { const m = $(id); m.querySelector('b').textContent = value; m.className = 'meter ' + (state || ''); }

  function render(r) {
    const wave = S.WAVES[waveIdx];
    const live = totalServers();
    const costH = S.costPerHour(cfg, live);
    $('m-budget').textContent = 'budget ' + money(wave.budget) + '/h';
    meter('m-cost', money(costH) + '/h', costH > wave.budget ? 'warn' : 'ok');
    if (!r) {
      meter('m-rps', '0'); meter('m-p95', '—'); meter('m-err', '—'); meter('m-orders', '0');
      $('m-queue').textContent = 'this wave';
    } else {
      meter('m-rps', fmt(r.legit + r.bots));
      meter('m-p95', fmt(r.p95) + ' ms', r.p95 > S.K.SLO_P95 ? 'bad' : r.p95 > S.K.SLO_P95 * 0.7 ? 'warn' : 'ok');
      meter('m-err', (r.errRate * 100).toFixed(r.errRate < 0.1 ? 2 : 1) + '%', r.errRate > S.K.SLO_ERR ? 'bad' : r.errRate > S.K.SLO_ERR / 2 ? 'warn' : 'ok');
      meter('m-orders', fmt(run.orders));
      $('m-queue').textContent = cfg.queue && r.backlog >= 1 ? fmt(r.backlog) + ' in queue' : 'this wave';
    }
    // Diagram
    setNode('users', 'ok', r ? fmt(r.legit) + ' shoppers/s' : 'waiting', r && r.bots ? fmt(r.bots) + ' bots/s' : '');
    setNode('limiter', cfg.limiter ? 'ok' : 'off', cfg.limiter ? (r ? fmt(r.botsBlocked) + ' bots blocked' : 'on') : 'off', '');
    setNode('cdn', cfg.cdn ? 'ok' : 'off', cfg.cdn ? Math.round(S.K.CDN_OFFLOAD * 100) + '% at edge' : 'off', '');
    const appU = r ? r.util : 0;
    setNode('app', r ? lvl(appU) : 'ok', (r ? Math.round(Math.min(appU, 9.99) * 100) + '% busy' : 'idle'), r ? 'p95 ' + fmt(r.p95) + ' ms' : '');
    setNode('cache', cfg.cache ? 'ok' : 'off', cfg.cache ? CACHE[cfg.cache] + ' · ' + Math.round(S.K.CACHE_HIT[cfg.cache] * 100) + '% hits' : 'off', '');
    setNode('queue', cfg.queue ? (r && r.abandoned > 0 ? 'bad' : r && r.backlog > 100 ? 'warn' : 'ok') : 'off', cfg.queue ? (r ? fmt(r.backlog) + ' waiting' : 'on') : 'off', '');
    const dbU = r ? r.dbUtil : 0, connU = r ? r.connInUse / r.connLimit : 0;
    setNode('db', r ? lvl(Math.max(dbU, connU)) : 'ok', DBS[cfg.dbSize] + (cfg.replicas ? ' + ' + cfg.replicas + ' replica' + (cfg.replicas > 1 ? 's' : '') : ''),
      r ? Math.round(Math.min(dbU, 9.99) * 100) + '% busy · ' + fmt(r.connInUse) + '/' + r.connLimit + ' conns' : (cfg.pooler ? 'pooler on' : ''));
    // Server squares
    const warm = run && running ? run.warm : cfg.servers, warming = run && running ? run.pending.length : 0;
    for (let i = 0; i < 30; i++) {
      const s = $('srv-' + i);
      if (i < warm) { s.setAttribute('visibility', 'visible'); s.setAttribute('class', 'srv ' + (appU > 0.95 ? 'hot' : 'live')); }
      else if (i < warm + warming) { s.setAttribute('visibility', 'visible'); s.setAttribute('class', 'srv warming'); }
      else s.setAttribute('visibility', 'hidden');
    }
    nodeEls.app.s2.textContent = (r ? 'p95 ' + fmt(r.p95) + ' ms' : '') + (warming ? ' · ' + warming + ' warming' : '');
    // Spark
    if (hist.length) {
      const maxR = Math.max(1, ...hist.map(h => h.rps)), maxP = Math.max(S.K.SLO_P95 * 1.5, ...hist.map(h => Math.min(h.p95, 3000)));
      const n = wave.seconds;
      $('spark-rps').setAttribute('points', hist.map((h, i) => `${(i / n) * 300},${58 - (h.rps / maxR) * 54}`).join(' '));
      $('spark-p95').setAttribute('points', hist.map((h, i) => `${(i / n) * 300},${58 - (Math.min(h.p95, 3000) / maxP) * 54}`).join(' '));
      const y = 58 - (S.K.SLO_P95 / maxP) * 54; $('slo-line').setAttribute('y1', y); $('slo-line').setAttribute('y2', y);
    } else {
      $('spark-rps').setAttribute('points', ''); $('spark-p95').setAttribute('points', '');
    }
    $('lives').textContent = '❤️'.repeat(Math.max(0, lives)) + '🖤'.repeat(Math.max(0, 3 - lives));
    $('lives').setAttribute('aria-label', lives + ' lives left');
    $('score').textContent = fmt(score + (run && running ? run.orders : 0));
    $('wave-label').textContent = `Wave ${waveIdx + 1} of ${S.WAVES.length}`;
    $('wave-name').textContent = wave.name;
    $('wave-bar').style.width = (run ? Math.min(100, run.t / wave.seconds * 100) : 0) + '%';
  }

  // ------------------------------------------------------------ traffic dots (decoration only)
  const dots = [];
  const ROUTE = () => {
    const pts = [mid(N.users), mid(N.limiter), mid(N.cdn), [N.app.x + 40, N.app.y + 50]];
    return pts;
  };
  function spawnDots(r) {
    if (reduce || !r) return;
    const n = Math.min(4, Math.round((r.legit + r.bots) / 1500) + 1);
    for (let i = 0; i < n && dots.length < 60; i++) {
      const bot = Math.random() < r.bots / Math.max(1, r.legit + r.bots);
      const stop = bot && cfg.limiter && Math.random() < S.K.LIMITER_BOT_BLOCK ? 1 : 3;
      const offload = !bot && cfg.cdn && Math.random() < S.K.CDN_OFFLOAD;
      const e = el('circle', { r: 3.2, class: 'dot' + (bot ? ' bot' : ''), cx: mid(N.users)[0], cy: mid(N.users)[1] }, $('dots'));
      dots.push({ e, p: Math.random() * 0.2, stop: offload ? 2 : stop, jitter: (Math.random() - 0.5) * 24 });
    }
  }
  function animateDots(dt) {
    if (reduce) return;
    const pts = ROUTE();
    for (let i = dots.length - 1; i >= 0; i--) {
      const d = dots[i]; d.p += dt / 1000 * 1.6 * (speed);
      if (d.p >= d.stop) { d.e.remove(); dots.splice(i, 1); continue; }
      const seg = Math.floor(d.p), f = d.p - seg, a = pts[seg], b = pts[seg + 1];
      d.e.setAttribute('cx', a[0] + (b[0] - a[0]) * f);
      d.e.setAttribute('cy', a[1] + (b[1] - a[1]) * f + d.jitter * Math.sin(Math.PI * f));
    }
  }
  function clearDots() { dots.splice(0).forEach(d => d.e.remove()); }

  // ------------------------------------------------------------ waves
  function blankStats() { return { appHot: 0, dbHot: 0, connHot: 0, botsHurt: 0, lag: 0, breaches: 0 }; }

  function startWave() {
    hideOverlay();
    run = S.createRun(cfg, S.WAVES[waveIdx]);
    hist = []; waveStats = blankStats(); running = true; paused = false; acc = 0; lastTs = null;
    $('pause').disabled = false; $('pause').textContent = 'Pause';
    P.track('hold-wave-' + (waveIdx + 1));
    refreshShop(); render(null);
    requestAnimationFrame(loop);
  }

  function tick() {
    const r = S.step(run);
    hist.push({ rps: r.legit + r.bots, p95: r.p95 });
    if (r.util > 0.95) waveStats.appHot++;
    if (r.dbUtil > 0.95) waveStats.dbHot++;
    if (r.connInUse > r.connLimit) waveStats.connHot++;
    if (r.bots > r.legit * 0.5 && !cfg.limiter && r.breach) waveStats.botsHurt++;
    if (r.breach && r.warming > 0) waveStats.lag++;
    if (r.breach) waveStats.breaches++;
    if (!r.breach && r.legit + r.bots > peak.rps) peak = { rps: r.legit + r.bots, p95: r.p95 };
    $('breach').textContent = r.breach ? `⚠ Outside the SLO for ${run.breach} s. At ${S.K.BREACH_S} s you lose a life.` : '';
    if (r.lifeLost) {
      lives--;
      $('breach').textContent = lives > 0 ? `💥 Incident! You lost a life. ${lives} left.` : '💥 Incident!';
      if (lives <= 0) { render(r); endGame(false); return; }
    }
    spawnDots(r);
    render(r);
    if (run.t >= run.wave.seconds) endWave();
  }

  function loop(ts) {
    if (!running) return;
    if (lastTs == null) lastTs = ts;
    const dt = Math.min(250, ts - lastTs); lastTs = ts;
    if (!paused) {
      acc += dt;
      const tickMs = 250 / speed;
      while (acc >= tickMs && running) { acc -= tickMs; tick(); }
      animateDots(dt);
    }
    if (running) requestAnimationFrame(loop);
  }

  const TIPS = {
    app: { text: 'Your app servers ran past 95% busy. Latency grows like 1 / (1 − utilisation), so the last 10% of capacity costs you most of your p95.', href: '/glossary/utilisation-law/', link: 'Utilisation law' },
    db: { text: 'The database was the bottleneck. A cache, read replicas or a bigger primary take that load off; more app servers only make it worse.', href: '/blog/bottleneck-analysis-is-a-method-not-a-guess/', link: 'Bottleneck analysis' },
    conn: { text: "The database ran out of connections. Connections in use = queries per second × query time (Little's law). A pooler raises the limit.", href: '/glossary/connection-pool/', link: 'Connection pools' },
    bots: { text: 'Bots ate the capacity your customers needed. A rate limiter in front stops them before they cost you servers.', href: '/glossary/rate-limiting/', link: 'Rate limiting' },
    lag: { text: 'Autoscaling reacted, but new servers took time to warm up. For a spike you can see coming, scale before it starts.', href: '/glossary/autoscaling/', link: 'Autoscaling' },
    queue: { text: "Orders waited so long in the queue that people gave up. A queue buys time; it doesn't add database capacity.", href: '/glossary/back-pressure/', link: 'Back-pressure' },
    spend: { text: 'You held the line but went over budget. Headroom is good; paying for capacity you never use isn\'t. Size it from a load test.', href: '/tools/capacity-calculator/', link: 'Capacity calculator' },
    clean: { text: 'Clean wave: inside the SLO with headroom to spare. In a real test, now push until it breaks so you know where the edge is.', href: '/glossary/breakpoint-testing/', link: 'Breakpoint testing' },
  };

  function pickTip(spend) {
    const s = waveStats;
    if (s.breaches > 0) {
      if (s.botsHurt > 3) return TIPS.bots;
      if (s.connHot > 3) return TIPS.conn;
      if (s.lag > 3) return TIPS.lag;
      if (s.dbHot > s.appHot) return TIPS.db;
      if (s.appHot > 0) return TIPS.app;
      if (s.dbHot > 0) return TIPS.db;
    }
    if (run.abandoned > 1) return TIPS.queue;
    if (spend > 0) return TIPS.spend;
    return TIPS.clean;
  }

  function endWave() {
    running = false; $('pause').disabled = true; clearDots(); $('breach').textContent = '';
    const wave = run.wave;
    const drained = cfg.queue ? run.backlog : 0;
    const orders = run.orders + drained;
    const budgetSpend = wave.budget * wave.seconds / 60;
    const over = Math.max(0, run.cost - budgetSpend);
    const penalty = Math.round(over * 500);
    const waveScore = Math.max(0, Math.round(orders - penalty));
    score += waveScore;
    cfg.servers = run.warm + run.pending.length; // everything is warm by the next wave
    const tip = pickTip(over);
    const last = waveIdx === S.WAVES.length - 1;
    const err = run.legitSum ? run.errSum / run.legitSum : 0;
    showOverlay(last ? 'You held the line' : 'Wave ' + (waveIdx + 1) + ' done', wave.name + (run.livesLost ? ' · ' + run.livesLost + ' incident' + (run.livesLost > 1 ? 's' : '') : ' · no incidents'),
      `<div class="ov-stats">
        <div><span>Orders</span><b>${fmt(orders)}</b></div>
        <div><span>Worst p95</span><b>${fmt(run.worstP95)} ms</b></div>
        <div><span>Errors</span><b>${(err * 100).toFixed(2)}%</b></div>
        <div><span>Over budget</span><b>${over > 0 ? money(over) : '—'}</b></div>
       </div>
       ${drained >= 1 ? `<p>${fmt(drained)} queued orders were processed after the rush.</p>` : ''}
       ${penalty ? `<p>Overspend cost you ${fmt(penalty)} points.</p>` : ''}
       <p class="tip"><b>What you just learned:</b> ${tip.text} <a href="${tip.href}" data-check hidden>${tip.link} →</a></p>`,
      last ? [['See your result', () => endGame(true), true]] : [['Next: ' + S.WAVES[waveIdx + 1].name, () => { waveIdx++; showIntro(); }, true]]);
    P.checkLinks($('overlay'));
    run.last = null; hist = []; render(null);
  }

  function showIntro() {
    const w = S.WAVES[waveIdx];
    run = null; refreshShop(); render(null);
    showOverlay('Wave ' + (waveIdx + 1) + ': ' + w.name, waveIdx ? 'Change your setup, then start' : 'Get ready',
      `<p>${w.intro}</p><p>Budget: <b>${money(w.budget)}/h</b>. Your setup costs <b>${money(S.costPerHour(cfg))}/h</b>. Changes are instant until the wave starts.</p>`
      + (waveIdx === 0 ? '<p>Tip: close this, look at the upgrades below, then start. Keep p95 under 800 ms and errors under 1%; if you stay outside for ' + S.K.BREACH_S + ' seconds you lose one of 3 lives.</p>' : ''),
      [['Start wave', startWave, true], ['Change setup first', () => { hideOverlay(); showStartBar(); }, false]]);
  }

  function showStartBar() {
    $('breach').innerHTML = '';
    const b = document.createElement('button'); b.type = 'button'; b.className = 'gbtn primary'; b.textContent = '▶ Start wave ' + (waveIdx + 1);
    b.addEventListener('click', startWave); $('breach').appendChild(b);
  }

  function endGame(won) {
    running = false; over = true; $('pause').disabled = true; clearDots();
    const best = P.store.get('hold-best');
    const isBest = !best || score > best.score;
    if (isBest) P.store.set('hold-best', { score, peak: Math.round(peak.rps), p95: Math.round(peak.p95), waves: won ? 5 : waveIdx });
    P.track(won ? 'hold-win' : 'hold-gameover');
    const text = won
      ? `I held ${fmt(peak.rps)} req/s at p95 ${fmt(peak.p95)} ms through Black Friday on Hold the Line (score ${fmt(score)}). Can your setup do better?`
      : `My shop went down in wave ${waveIdx + 1} (${S.WAVES[waveIdx].name}) on Hold the Line after holding ${fmt(peak.rps)} req/s. Score ${fmt(score)}. Can you hold it longer?`;
    showOverlay(won ? 'Black Friday survived 🎉' : 'Your shop went down', won ? 'Final score' : 'Game over',
      `<div class="ov-stats">
        <div><span>Score</span><b>${fmt(score)}</b></div>
        <div><span>Peak held</span><b>${fmt(peak.rps)} req/s</b></div>
        <div><span>p95 at peak</span><b>${peak.rps ? fmt(peak.p95) + ' ms' : '—'}</b></div>
        <div><span>Your best</span><b>${fmt(isBest ? score : best.score)}</b></div>
       </div>
       ${isBest && score > 0 ? '<p>New personal best.</p>' : ''}
       <div class="share-row" id="share-row"></div>
       <p class="tip">Real Black Friday coming? <a href="/site-check/" data-track="hold-end-sitecheck">Run the free site check</a> or <a href="/peak-readiness/" data-track="hold-end-peak">book a peak-readiness load test</a>.</p>`,
      [['Play again', () => { reset(); buildShop(); showIntro(); }, true]]);
    P.shareButtons($('share-row'), text, URL_, 'hold');
  }

  // ------------------------------------------------------------ overlay
  function showOverlay(title, eyebrow, body, actions) {
    $('ov-title').textContent = title; $('ov-eyebrow').textContent = eyebrow; $('ov-body').innerHTML = body;
    const a = $('ov-actions'); a.innerHTML = '';
    actions.forEach(([label, fn, primary]) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'gbtn' + (primary ? ' primary' : ''); b.textContent = label;
      b.addEventListener('click', fn); a.appendChild(b);
    });
    $('overlay').hidden = false;
    const first = a.querySelector('.primary'); if (first) first.focus({ preventScroll: true });
  }
  function hideOverlay() { $('overlay').hidden = true; }

  // ------------------------------------------------------------ controls
  $('pause').addEventListener('click', togglePause);
  function togglePause() {
    if (!running) return;
    paused = !paused; $('pause').textContent = paused ? 'Resume' : 'Pause';
    $('breach').textContent = paused ? '⏸ Paused. Change your setup, then resume.' : '';
  }
  $('speed').addEventListener('click', () => {
    speed = speed === 1 ? 2 : 1; $('speed').textContent = 'Speed ×' + speed; $('speed').setAttribute('aria-pressed', String(speed === 2));
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable]')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'p' || e.key === 'P') { togglePause(); e.preventDefault(); }
    else if (e.key === '+' || e.key === '=') { change(ITEMS[0], +1); }
    else if (e.key === '-' || e.key === '_') { change(ITEMS[0], -1); }
    else if (e.key === 'Enter' && !running && !over && $('overlay').hidden && document.activeElement === document.body) { startWave(); }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden && running && !paused) togglePause(); });

  // ------------------------------------------------------------ go
  reset(); buildDiagram(); buildShop(); render(null);
  const best = P.store.get('hold-best');
  showIntro();
  if (best) $('ov-body').insertAdjacentHTML('beforeend', `<p>Your best: <b>${fmt(best.score)}</b> (held ${fmt(best.peak)} req/s).</p>`);
  // Test hook: lets the automated test drive the game quickly. Harmless for players.
  window.__hold = { get state() { return { cfg, waveIdx, lives, score, running, over, t: run && run.t }; }, startWave, setSpeed: (s) => { speed = s; } };
})();
