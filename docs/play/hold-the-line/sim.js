/* Hold the Line: the traffic model. Runs in the browser (window.HoldSim) and in Node (module.exports) so it can be
   unit-tested (play/test-sim.js).

   One step = one simulated second. The model is deliberately simple but every effect in it is a real one:
   - CDN takes a share of requests off the origin.
   - App servers are queues: p95 grows with 1 / (1 - utilisation), and requests beyond ~98% utilisation time out.
   - Cache hits skip the database; misses become DB reads. Checkouts are DB writes and always hit the primary.
   - Read replicas add read capacity; writes only go to the primary.
   - DB connections in use = DB queries per second × DB latency (Little's law). Past the connection limit,
     requests fail. A connection pooler raises the limit.
   - Autoscaling adds servers when CPU passes 70%, but new servers take WARMUP seconds before they serve traffic.
   - A checkout queue accepts orders quickly and drains them at what the DB can write; long waits mean abandoned carts.
   - A rate limiter blocks most bot traffic before it reaches the app. */
(function (root) {
  'use strict';

  const K = {
    CDN_OFFLOAD: 0.4,          // share of requests the CDN serves without touching the origin
    APP_RPS: 500,              // requests per second one app server can serve
    APP_P95_MS: 90,            // app p95 at low load
    TIMEOUT_MS: 5000,
    MAX_UTIL: 0.98,            // above this, extra requests time out
    QUERIES_PER_REQ: 2,        // DB reads per page request on a cache miss
    CACHE_HIT: [0, 0.6, 0.8, 0.92],
    DB_READ_QPS: 1500,         // primary capacity in queries per second (reads and writes) at the smallest size
    DB_SIZE: [1, 2, 4],        // bigger primary (vertical scaling) multiplies that
    REPLICA_QPS: 1500,         // each read replica
    WRITE_COST: 3,             // queries per checkout
    DB_MS: 4,                  // DB query time at low load
    DB_CONN: 100,              // max connections without a pooler
    POOLER_CONN: 400,          // with a pooler in front
    QUEUE_WORKERS_WPS: 0.8,    // share of primary capacity the checkout workers may use
    QUEUE_ABANDON_S: 90,       // orders that wait longer than this are abandoned
    WARMUP: 25,                // seconds before a new server takes traffic
    SCALE_EVERY: 10,
    SCALE_AT: 0.7,
    LIMITER_BOT_BLOCK: 0.92,
    SLO_P95: 800,
    SLO_ERR: 0.01,
    BREACH_S: 8,               // seconds of SLO breach before you lose a life
  };

  const COST = { dbSize: [0, 2, 5], server: 1.0, cache: [0, 0.6, 1.2, 2.4], cdn: 0.8, replica: 1.5, queue: 0.5, pooler: 0.4, limiter: 0.4, autoscale: 0.1 };

  function defaultConfig() {
    return { servers: 2, cache: 0, cdn: false, replicas: 0, dbSize: 0, queue: false, pooler: false, limiter: false, autoscale: false, maxServers: 30 };
  }

  function costPerHour(cfg, liveServers) {
    const n = liveServers == null ? cfg.servers : liveServers;
    return n * COST.server + COST.cache[cfg.cache] + (cfg.cdn ? COST.cdn : 0) + cfg.replicas * COST.replica + COST.dbSize[cfg.dbSize || 0] +
      (cfg.queue ? COST.queue : 0) + (cfg.pooler ? COST.pooler : 0) + (cfg.limiter ? COST.limiter : 0) +
      (cfg.autoscale ? COST.autoscale : 0);
  }

  // Steady-state evaluation of one second of traffic. traffic = { rps (legit), bots, checkout (share of legit) }.
  // servers = servers actually serving traffic (warm). backlog = orders waiting in the checkout queue.
  function evaluate(cfg, servers, traffic, backlog) {
    backlog = backlog || 0;
    const legit = Math.max(0, traffic.rps), botsIn = Math.max(0, traffic.bots || 0);
    const bots = cfg.limiter ? botsIn * (1 - K.LIMITER_BOT_BLOCK) : botsIn;
    const checkoutShare = traffic.checkout == null ? 0.03 : traffic.checkout;
    const total = legit + bots;
    // Checkouts are never cacheable, so the CDN only offloads the browsing part of the traffic.
    const checkoutReq = legit * checkoutShare;
    const origin = (total - checkoutReq) * (cfg.cdn ? 1 - K.CDN_OFFLOAD : 1) + checkoutReq;
    const legitShare = total > 0 ? legit / total : 1;

    // App tier
    const capacity = Math.max(servers, 0) * K.APP_RPS;
    const util = capacity > 0 ? origin / capacity : (origin > 0 ? Infinity : 0);
    const served = Math.min(origin, capacity * K.MAX_UTIL);
    const appDrop = origin - served;
    const u = Math.min(util, K.MAX_UTIL);
    const appP95 = capacity > 0 ? Math.min(K.TIMEOUT_MS, K.APP_P95_MS / (1 - u)) : K.TIMEOUT_MS;

    // DB tier. Reads from cache misses; writes from checkouts (directly, or via the queue workers).
    const hit = K.CACHE_HIT[cfg.cache];
    const servedShare = origin > 0 ? served / origin : 1;
    const reads = (served - checkoutReq * servedShare) * K.QUERIES_PER_REQ * (1 - hit);
    const checkoutAttempts = checkoutReq * servedShare;
    const primaryCap = K.DB_READ_QPS * K.DB_SIZE[cfg.dbSize || 0];
    const readCap = primaryCap + cfg.replicas * K.REPLICA_QPS;
    // Replicas take reads first in proportion to their capacity; the primary carries its share plus all writes.
    const primaryReadShare = primaryCap / readCap;
    const primaryReads = reads * primaryReadShare;
    const replicaReads = reads - primaryReads;
    let writes, queueIn = 0, queueOut = 0, newBacklog = backlog, abandoned = 0;
    if (cfg.queue) {
      queueIn = checkoutAttempts;
      const writeBudget = Math.max(0, primaryCap * K.QUEUE_WORKERS_WPS - primaryReads) / K.WRITE_COST;
      const pending = backlog + queueIn;
      queueOut = Math.min(pending, writeBudget);
      newBacklog = pending - queueOut;
      // Orders that would wait longer than the abandon limit give up.
      const maxWait = queueOut > 0 ? newBacklog / queueOut : (newBacklog > 0 ? Infinity : 0);
      if (maxWait > K.QUEUE_ABANDON_S) {
        const keep = queueOut * K.QUEUE_ABANDON_S;
        abandoned = newBacklog - keep;
        newBacklog = keep;
      }
      writes = queueOut * K.WRITE_COST;
    } else {
      writes = checkoutAttempts * K.WRITE_COST;
    }
    const primaryLoad = primaryReads + writes;
    const primaryUtil = primaryLoad / primaryCap;
    const replicaUtil = cfg.replicas > 0 ? replicaReads / (cfg.replicas * K.REPLICA_QPS) : 0;
    const dbUtil = Math.max(primaryUtil, replicaUtil);
    const du = Math.min(dbUtil, K.MAX_UTIL);
    const dbMs = K.DB_MS / (1 - du);
    // Share of DB work that can't be done this second (saturated primary or replicas).
    const dbOver = dbUtil > K.MAX_UTIL ? 1 - K.MAX_UTIL / dbUtil : 0;

    // Connections (Little's law): queries per second × seconds per query.
    const qps = reads + writes;
    const connLimit = cfg.pooler ? K.POOLER_CONN : K.DB_CONN;
    const connInUse = qps * dbMs / 1000;
    const connOver = connInUse > connLimit ? 1 - connLimit / connInUse : 0;

    // A request that needs the DB fails if the DB is over capacity or out of connections.
    const needsDb = served > 0 ? Math.min(1, (reads / K.QUERIES_PER_REQ + (cfg.queue ? 0 : checkoutAttempts)) / served) : 0;
    const dbFailShare = needsDb * (1 - (1 - dbOver) * (1 - connOver));
    const dbFails = served * dbFailShare;

    const okRequests = served - dbFails;
    const legitErrors = (appDrop + dbFails) * legitShare;
    const legitOrigin = origin * legitShare;
    const errRate = legitOrigin > 0 ? Math.min(1, legitErrors / legitOrigin) : 0;

    // p95: app time plus DB time for requests that query it (several queries per miss), capped at the timeout.
    const dbPart = needsDb > 0.05 ? dbMs * K.QUERIES_PER_REQ * (dbOver > 0 || connOver > 0 ? 6 : 2) : 0;
    const p95 = Math.min(K.TIMEOUT_MS, appP95 + dbPart + (cfg.limiter ? 1 : 0));

    // Orders: direct checkouts succeed unless their request failed; queued ones complete as workers write them.
    const orders = cfg.queue ? queueOut : checkoutAttempts * (1 - dbFailShare);
    return {
      legit, bots: botsIn, botsBlocked: botsIn - bots, origin, util, appDrop, p95, errRate,
      reads, writes, primaryUtil, replicaUtil, dbUtil, dbMs, connInUse, connLimit,
      orders, backlog: newBacklog, abandoned, okRequests,
    };
  }

  // Waves: f(t) gives { rps, bots, checkout } for second t of the wave.
  const WAVES = [
    { name: 'Normal Tuesday', seconds: 60, budget: 6, intro: 'A quiet day. Get a feel for the meters.',
      f: (t) => ({ rps: 250 + 250 * Math.min(1, t / 45), bots: 30, checkout: 0.03 }) },
    { name: 'Sale launch', seconds: 75, budget: 12, intro: 'The sale email just went out. Traffic jumps in seconds, not minutes.',
      f: (t) => ({ rps: t < 10 ? 600 : t < 16 ? 600 + (t - 10) * 450 : 3300 - Math.min(800, (t - 16) * 15), bots: 80, checkout: 0.04 }) },
    { name: 'Flash sale', seconds: 90, budget: 18, intro: 'Doorbusters at the top of every 30 seconds. Lots of people check out at once.',
      f: (t) => ({ rps: 3000 + 2500 * Math.pow(Math.max(0, Math.sin(Math.PI * ((t % 30) / 30))), 2) + 15 * t, bots: 150, checkout: 0.08 }) },
    { name: 'Bot surge', seconds: 75, budget: 20, intro: 'Scalper bots arrive. They never buy, but they use your capacity.',
      f: (t) => ({ rps: 4500, bots: t < 8 ? 500 : 6500, checkout: 0.05 }) },
    { name: 'Black Friday peak', seconds: 100, budget: 30, intro: 'Everything at once. Hold the line.',
      f: (t) => ({ rps: 5000 + Math.min(1, t / 40) * 7000 + 600 * Math.sin(t / 5), bots: 2500 + (t > 60 ? 2500 : 0), checkout: 0.06 }) },
  ];

  // A running game wave: tracks warm-up of new servers, autoscaling, the queue backlog and SLO breaches.
  function createRun(cfg, wave) {
    const st = {
      cfg, wave, t: 0, warm: cfg.servers, pending: [], backlog: 0, breach: 0, livesLost: 0,
      orders: 0, abandoned: 0, cost: 0, peakHeld: 0, worstP95: 0, errSum: 0, legitSum: 0, last: null, events: [],
    };
    return st;
  }

  // Add servers now (during a wave they take WARMUP seconds to come online).
  function addServers(st, n, now) {
    for (let i = 0; i < n; i++) st.pending.push(now == null ? st.t + K.WARMUP : now);
  }

  function step(st) {
    const cfg = st.cfg, t = st.t;
    // Bring warmed-up servers online.
    const ready = st.pending.filter(at => at <= t).length;
    if (ready) { st.warm += ready; st.pending = st.pending.filter(at => at > t); }
    const traffic = st.wave.f(t);
    const r = evaluate(cfg, st.warm, traffic, st.backlog);
    st.backlog = r.backlog;
    // Autoscaling: every SCALE_EVERY seconds, aim for SCALE_AT utilisation, counting servers still warming up.
    if (cfg.autoscale && t % K.SCALE_EVERY === 0 && t > 0) {
      const total = st.warm + st.pending.length;
      const need = Math.ceil(r.origin / (K.APP_RPS * K.SCALE_AT));
      const add = Math.min(cfg.maxServers - total, need - total);
      if (add > 0) { addServers(st, add); st.events.push({ t, type: 'scale', n: add }); }
    }
    const live = st.warm + st.pending.length; // you pay for servers while they warm up
    st.cost += costPerHour(cfg, live) / 3600 * 60; // shown as $/hour; accumulated per game-minute for scoring
    st.orders += r.orders;
    st.abandoned += r.abandoned;
    st.errSum += r.errRate * r.legit;
    st.legitSum += r.legit;
    const breach = r.p95 > K.SLO_P95 || r.errRate > K.SLO_ERR;
    if (breach) st.breach++; else { st.breach = 0; if (r.legit + r.bots > st.peakHeld) st.peakHeld = r.legit + r.bots; }
    st.worstP95 = Math.max(st.worstP95, r.p95);
    let lifeLost = false;
    if (st.breach >= K.BREACH_S) { st.livesLost++; st.breach = 0; lifeLost = true; st.events.push({ t, type: 'life' }); }
    st.last = Object.assign({ t, warm: st.warm, warming: st.pending.length, costHour: costPerHour(cfg, live), breach, lifeLost }, r);
    st.t++;
    return st.last;
  }

  function runWave(cfg, wave) {
    const st = createRun(cfg, wave);
    while (st.t < wave.seconds) step(st);
    return st;
  }

  const api = { K, COST, WAVES, defaultConfig, costPerHour, evaluate, createRun, addServers, step, runWave };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HoldSim = api;
})(typeof window !== 'undefined' ? window : this);
