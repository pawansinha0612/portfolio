/* Spot the Bottleneck: scenario templates. Each one builds a few charts from a load test with randomised numbers.
   Runs in the browser (window.Bottlenecks) and in Node (module.exports) so play/test-scenarios.js can check them. */
(function (root) {
  'use strict';

  const N = 24; // points per chart

  function rng(seed) { // small deterministic PRNG so tests can reproduce a round
    let s = seed >>> 0 || 1;
    return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  }

  function make(r) {
    const R = (a, b) => a + (b - a) * r();
    const RI = (a, b) => Math.round(R(a, b));
    const noise = (v, pct) => v * (1 + (r() - 0.5) * 2 * (pct == null ? 0.04 : pct));
    const xs = (n) => Array.from({ length: n || N }, (_, i) => i / ((n || N) - 1)); // 0..1
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    // A load ramp: x = share of the ramp; "knee" = where something saturates.
    const plateau = (max, knee) => xs().map(x => noise(max * Math.min(x / knee, 1) * (x < knee ? 1 : 1 - 0.02 * (x - knee)), 0.03));
    const hockey = (base, knee, steep) => xs().map(x => noise(base * (x <= knee ? 1 + x * 0.6 : 1 + knee * 0.6 + Math.pow((x - knee) * steep, 2)), 0.05));
    const rising = (lo, hi, curve) => xs().map(x => noise(lo + (hi - lo) * Math.pow(x, curve || 1), 0.04));
    const flat = (v, pct) => xs().map(() => noise(v, pct == null ? 0.06 : pct));
    const capped = (hi, knee, cap) => xs().map(x => clamp(noise(hi * x / knee, 0.04), 0, cap));
    return { R, RI, noise, xs, clamp, plateau, hockey, rising, flat, capped };
  }

  const LOAD = 'virtual users →', TIME = 'time →';
  const c = (title, unit, x, series, extra) => Object.assign({ title, unit, x, series }, extra || {});
  const s = (data, label) => ({ data, label });

  const SCENARIOS = [
    { id: 'cpu', answer: 'App server CPU is saturated', glossary: '/glossary/saturation/',
      build(h) { const vu = h.RI(200, 600), t = h.RI(800, 2400), knee = h.R(0.45, 0.6);
        return { story: `Ramp to ${vu} virtual users against the product API.`, charts: [
          c('Throughput', 'req/s', LOAD, [s(h.plateau(t, knee))]),
          c('p95 latency', 'ms', LOAD, [s(h.hockey(h.RI(120, 220), knee, 6))]),
          c('App CPU', '%', LOAD, [s(h.capped(100, knee * 0.95, h.R(97, 99.5)))], { max: 100 }),
          c('DB connections in use', '', LOAD, [s(h.rising(5, h.RI(18, 30)))], { limit: 100 }),
        ] }; },
      explain: 'Throughput flattens exactly when app CPU hits ~100%, while the database still has plenty of room. Every extra user just waits in the CPU run queue, so latency bends upwards. Profile the hot code path or add instances.' },

    { id: 'dbpool', answer: 'Database connection pool is exhausted', glossary: '/glossary/connection-pool/',
      build(h) { const pool = h.RI(2, 5) * 10, knee = h.R(0.35, 0.55);
        return { story: `Checkout flow, ramping to ${h.RI(300, 800)} users.`, charts: [
          c('DB connections in use', '', LOAD, [s(h.capped(pool, knee, pool))], { limit: pool }),
          c('p95 latency', 'ms', LOAD, [s(h.hockey(h.RI(150, 300), knee, 7))]),
          c('App CPU', '%', LOAD, [s(h.rising(10, h.RI(30, 45)))], { max: 100 }),
          c('DB server CPU', '%', LOAD, [s(h.rising(8, h.RI(35, 50)))], { max: 100 }),
        ] }; },
      explain: "Connections pin at the pool limit while both the app and database CPUs are relaxed. Requests are queueing for a connection, not for compute. Check how long each connection is held (Little's law) before simply raising the pool size." },

    { id: 'threads', answer: 'Web server thread pool is exhausted', glossary: '/glossary/thread-pool/',
      build(h) { const max = h.RI(1, 4) * 100, knee = h.R(0.4, 0.55);
        return { story: `Search API ramp to ${h.RI(400, 1200)} users.`, charts: [
          c('Busy worker threads', '', LOAD, [s(h.capped(max, knee, max))], { limit: max }),
          c('p95 latency', 'ms', LOAD, [s(h.hockey(h.RI(100, 200), knee, 7))]),
          c('App CPU', '%', LOAD, [s(h.rising(12, h.RI(28, 40)))], { max: 100 }),
          c('Downstream call latency', 'ms', LOAD, [s(h.flat(h.RI(40, 90)))]),
        ] }; },
      explain: 'Every worker thread is busy while the CPU sits at about a third. The threads are waiting (blocked on I/O), and new requests queue for a free thread. Size the pool from the wait time, or move to non-blocking calls.' },

    { id: 'leak', answer: 'Memory leak', glossary: '/glossary/memory-leak/',
      build(h) { const hrs = h.RI(6, 12), max = h.RI(2, 8);
        return { story: `${hrs}-hour soak test at a steady ${h.RI(200, 600)} req/s.`, charts: [
          c('Heap used after GC', 'GB', TIME, [s(h.rising(max * 0.25, max * 0.97, 1))], { limit: max }),
          c('GC pause time', 'ms', TIME, [s(h.rising(h.RI(10, 30), h.RI(400, 900), 3))]),
          c('Throughput', 'req/s', TIME, [s(h.flat(h.RI(200, 600), 0.03))]),
          c('p95 latency', 'ms', TIME, [s(h.rising(h.RI(120, 200), h.RI(900, 1800), 3.5))]),
        ] }; },
      explain: "The heap that survives garbage collection keeps rising under a steady load, so something is holding references it should release. GC works harder and harder until pauses dominate. Take heap dumps an hour apart and diff them." },

    { id: 'gc', answer: 'Heap too small: GC thrashing', glossary: '/glossary/garbage-collection-pause/',
      build(h) { const max = h.RI(1, 2), knee = h.R(0.35, 0.5);
        const heap = h.xs().map((x, i) => max * (x < knee ? 0.5 + 0.4 * ((i % 4) / 4) : 0.86 + 0.12 * ((i % 2)))) ;
        return { story: `Catalogue API ramp; the service runs with a ${max} GB heap.`, charts: [
          c('Heap used', 'GB', LOAD, [s(heap)], { limit: max }),
          c('Time spent in GC', '%', LOAD, [s(h.xs().map(x => x < knee ? h.noise(3, 0.3) : h.noise(25 + 30 * (x - knee), 0.1)))], { max: 100 }),
          c('App CPU', '%', LOAD, [s(h.capped(100, knee * 1.4, 96))], { max: 100 }),
          c('p95 latency', 'ms', LOAD, [s(h.xs().map((x, i) => x < knee ? h.noise(150) : h.noise(400 + (i % 3) * 300, 0.2)))]),
        ] }; },
      explain: 'Live data fills almost the whole heap, so the collector runs constantly and frees very little: a quarter or more of the time goes to GC and latency spikes in step. Unlike a leak, it appears as load rises, not over hours. Give it more heap or allocate less per request.' },

    { id: 'net', answer: 'Network bandwidth limit', glossary: '/glossary/throughput/',
      build(h) { const link = h.RI(1, 2) * 1000 / (h.R(0, 1) < 0.5 ? 1 : 10), knee = h.R(0.45, 0.6), kb = h.RI(400, 900);
        return { story: `Image-heavy product pages, average response ${kb} KB.`, charts: [
          c('Network out', 'Mbit/s', LOAD, [s(h.capped(link, knee, link * 0.98))], { limit: link }),
          c('Throughput', 'req/s', LOAD, [s(h.plateau(link * 1000 / 8 / kb, knee))]),
          c('App CPU', '%', LOAD, [s(h.rising(10, h.RI(35, 50)))], { max: 100 }),
          c('p95 latency', 'ms', LOAD, [s(h.hockey(h.RI(200, 400), knee, 5))]),
        ] }; },
      explain: "Network out sits flat at the link's limit while the CPU idles. Big responses fill the pipe. Compress, resize images, or move static content to a CDN." },

    { id: 'lock', answer: 'Database lock contention', glossary: '/glossary/lock-contention/',
      build(h) { const peakT = h.RI(300, 900), knee = h.R(0.35, 0.5);
        return { story: `Inventory updates during a sale, ramp to ${h.RI(200, 500)} users.`, charts: [
          c('Throughput', 'req/s', LOAD, [s(h.xs().map(x => h.noise(x < knee ? peakT * x / knee : peakT * (1 - 0.9 * (x - knee)), 0.04)))]),
          c('Row lock wait time', 'ms', LOAD, [s(h.xs().map(x => h.noise(x < knee * 0.8 ? 2 : 2 + 900 * Math.pow(x - knee * 0.8, 2), 0.1)))]),
          c('DB server CPU', '%', LOAD, [s(h.rising(10, h.RI(25, 40)))], { max: 100 }),
          c('p95 latency', 'ms', LOAD, [s(h.hockey(h.RI(80, 150), knee, 9))]),
        ] }; },
      explain: 'Throughput goes down as load goes up (retrograde scaling) while the database CPU is low and lock waits explode. Transactions are queueing on the same rows. Shorten transactions, change the update pattern or avoid hot rows.' },

    { id: 'nplus1', answer: 'N+1 queries', glossary: '/glossary/n-plus-one-query/',
      build(h) { const q = h.RI(35, 120);
        return { story: `Order history page, ramp to only ${h.RI(30, 80)} users.`, charts: [
          c('DB queries per request', '', LOAD, [s(h.flat(q, 0.03))]),
          c('DB server CPU', '%', LOAD, [s(h.capped(100, h.R(0.35, 0.5), 97))], { max: 100 }),
          c('p95 latency', 'ms', LOAD, [s(h.rising(h.RI(600, 1200), h.RI(3000, 6000), 2))]),
          c('App CPU', '%', LOAD, [s(h.rising(5, h.RI(20, 30)))], { max: 100 }),
        ] }; },
      explain: `Each page load runs dozens of small queries (one per item in a list), so the database is busy at a tiny load and latency is high from the first user. Fetch the list with a join or one batched query.` },

    { id: 'downstream', answer: 'Slow downstream dependency', glossary: '/glossary/fan-out-amplification/',
      build(h) { const knee = h.R(0.3, 0.5);
        return { story: `Checkout calls an external payment API. Ramp to ${h.RI(200, 600)} users.`, charts: [
          c('Payment API latency', 'ms', LOAD, [s(h.hockey(h.RI(150, 300), knee, 6))]),
          c('Checkout p95 latency', 'ms', LOAD, [s(h.hockey(h.RI(250, 400), knee, 6))]),
          c('App CPU', '%', LOAD, [s(h.rising(8, h.RI(25, 35)))], { max: 100 }),
          c('DB server CPU', '%', LOAD, [s(h.rising(5, h.RI(20, 30)))], { max: 100 }),
        ] }; },
      explain: "Your p95 follows the payment API's curve exactly while your own CPU and database are quiet. The bottleneck isn't in your code. Add timeouts and a circuit breaker, and ask the provider about their limits." },

    { id: 'ratelimit', answer: "Third-party rate limit (HTTP 429)", glossary: '/glossary/http-429/',
      build(h) { const lim = h.RI(5, 20) * 10, knee = h.R(0.4, 0.6);
        return { story: `Address lookup calls a third-party API. Ramp to ${Math.round(lim / knee)} req/s.`, charts: [
          c('Requests to the lookup API', 'req/s', LOAD, [s(h.rising(0, lim / knee))], { limit: lim }),
          c('HTTP 429 responses', '%', LOAD, [s(h.xs().map(x => x < knee ? 0 : h.noise(100 * (1 - knee / x), 0.05)))], { max: 100 }),
          c('App CPU', '%', LOAD, [s(h.rising(5, h.RI(18, 30)))], { max: 100 }),
          c('p95 latency', 'ms', LOAD, [s(h.flat(h.RI(90, 160)))]),
        ] }; },
      explain: 'Errors start exactly when calls cross a fixed rate, they are 429 Too Many Requests, and latency stays flat. The provider is throttling you. Cache the answers, batch calls or negotiate a higher limit.' },

    { id: 'stampede', answer: 'Cache stampede', glossary: '/glossary/cache-stampede/',
      build(h) { const at = h.RI(9, 15), qps = h.RI(200, 500);
        const t = (fn) => Array.from({ length: N }, (_, i) => fn(i));
        return { story: `Steady ${h.RI(1000, 3000)} req/s on the home page; the cache TTL is ${h.RI(5, 30)} minutes.`, charts: [
          c('Cache hit ratio', '%', TIME, [s(t(i => i >= at && i < at + 3 ? h.noise(5 + 25 * (i - at), 0.2) : h.noise(96, 0.01)))], { max: 100 }),
          c('DB queries', '/s', TIME, [s(t(i => i >= at && i < at + 3 ? h.noise(qps * h.R(12, 20), 0.1) : h.noise(qps)))]),
          c('p95 latency', 'ms', TIME, [s(t(i => i >= at && i < at + 4 ? h.noise(h.RI(2000, 5000), 0.2) : h.noise(120)))]),
          c('Throughput', 'req/s', TIME, [s(h.flat(h.RI(1000, 3000), 0.03))]),
        ] }; },
      explain: 'Load is steady, then the cache hit ratio collapses at once and the database gets a burst of identical queries: a popular key expired and every request tried to rebuild it. Use request coalescing, early refresh or jittered TTLs.' },

    { id: 'autoscale', answer: 'Autoscaling reacts too slowly', glossary: '/glossary/autoscaling/',
      build(h) { const at = h.RI(5, 8), lag = h.RI(5, 8), n0 = h.RI(3, 6), n1 = n0 * h.RI(2, 4);
        const t = (fn) => Array.from({ length: N }, (_, i) => fn(i));
        return { story: `A sale email goes out; traffic jumps ${h.RI(4, 8)}× in a minute.`, charts: [
          c('Traffic', 'req/s', TIME, [s(t(i => h.noise(i < at ? 500 : 2500 + 200 * Math.min(1, (i - at) / 3))))]),
          c('Instances serving', '', TIME, [s(t(i => i < at + lag ? n0 : i < at + lag + 3 ? n0 + (n1 - n0) * (i - at - lag + 1) / 3 : n1))]),
          c('App CPU', '%', TIME, [s(t(i => h.clamp(h.noise(i < at ? 35 : i < at + lag + 2 ? 99 : 55), 0, 100)))], { max: 100 }),
          c('p95 latency', 'ms', TIME, [s(t(i => h.noise(i < at ? 150 : i < at + lag + 2 ? h.RI(2500, 4500) : 180, 0.1)))]),
        ] }; },
      explain: 'Capacity does arrive, but only minutes after the spike. Until the new instances are warm, CPU is pinned and latency explodes. For a spike you can predict, scale out before it starts.' },

    { id: 'loadgen', answer: 'The load generator is the bottleneck', glossary: '/glossary/coordinated-omission/',
      build(h) { const target = h.RI(2000, 6000), knee = h.R(0.4, 0.6);
        return { story: `Aiming for ${target.toLocaleString('en-AU')} req/s from one load generator machine.`, charts: [
          c('Achieved vs target rate', 'req/s', LOAD, [s(h.plateau(target, knee), 'achieved'), s(h.rising(0, target), 'target')]),
          c('Load generator CPU', '%', LOAD, [s(h.capped(100, knee, 99))], { max: 100 }),
          c('Server CPU', '%', LOAD, [s(h.capped(100, 1, 40).map(v => v * 0.75))], { max: 100 }),
          c('Server-side p95', 'ms', LOAD, [s(h.flat(h.RI(60, 120)))]),
        ] }; },
      explain: "The servers are relaxed and fast, but the achieved rate falls behind the target exactly when the load generator's CPU hits 100%. You're testing your test machine. Add generators or make the script lighter." },

    { id: 'disk', answer: 'Disk I/O saturated', glossary: '/glossary/use-method/',
      build(h) { const knee = h.R(0.4, 0.55);
        return { story: `Order service ramp; it writes an audit log for every request.`, charts: [
          c('Disk utilisation', '%', LOAD, [s(h.capped(100, knee, 99))], { max: 100 }),
          c('CPU waiting on I/O (iowait)', '%', LOAD, [s(h.xs().map(x => h.noise(x < knee ? 2 : 2 + 50 * (x - knee), 0.1)))], { max: 100 }),
          c('CPU user time', '%', LOAD, [s(h.rising(5, h.RI(25, 35)))], { max: 100 }),
          c('p95 latency', 'ms', LOAD, [s(h.hockey(h.RI(80, 160), knee, 7))]),
        ] }; },
      explain: 'The disk is 100% busy and the CPU spends its time waiting on I/O rather than doing work. Synchronous writes are the queue. Buffer or batch the writes, log asynchronously, or use faster storage.' },

    { id: 'retry', answer: 'Retry storm', glossary: '/glossary/retry-storm/',
      build(h) { const at = h.RI(6, 9), base = h.RI(800, 2000);
        const t = (fn) => Array.from({ length: N }, (_, i) => fn(i));
        return { story: `Steady ${base.toLocaleString('en-AU')} users/s. A dependency blips for 30 seconds at minute ${at}.`, charts: [
          c('Requests arriving', 'req/s', TIME, [s(t(i => h.noise(i < at ? base : base * h.R(2.6, 3.4), 0.05)))]),
          c('Unique user actions', '/s', TIME, [s(h.flat(base, 0.04))]),
          c('Error rate', '%', TIME, [s(t(i => h.noise(i < at ? 0.2 : h.R(30, 50), 0.1)))], { max: 100 }),
          c('App CPU', '%', TIME, [s(t(i => h.clamp(h.noise(i < at ? 45 : 99), 0, 100)))], { max: 100 }),
        ] }; },
      explain: "Real user actions stayed flat, but requests tripled after the blip and never came back down: clients retry failed calls immediately, and the retries keep the system overloaded long after the cause is gone. Use exponential backoff with jitter and a retry budget." },

    { id: 'hotkey', answer: 'Hot partition (one shard overloaded)', glossary: '/glossary/saturation/',
      build(h) { const knee = h.R(0.35, 0.5);
        return { story: `A celebrity product launch. The product table is split across 3 database shards.`, charts: [
          c('CPU per shard', '%', LOAD, [s(h.capped(100, knee, 99), 'shard A'), s(h.rising(5, h.RI(18, 28)), 'shard B'), s(h.rising(5, h.RI(15, 25)), 'shard C')], { max: 100 }),
          c('Requests per shard', 'req/s', LOAD, [s(h.rising(0, h.RI(1500, 2500)), 'shard A'), s(h.rising(0, h.RI(200, 400)), 'shard B'), s(h.rising(0, h.RI(200, 400)), 'shard C')]),
          c('p95 latency', 'ms', LOAD, [s(h.hockey(h.RI(80, 150), knee, 7))]),
          c('Average DB CPU (all shards)', '%', LOAD, [s(h.rising(5, h.RI(40, 50)))], { max: 100 }),
        ] }; },
      explain: 'The average looks healthy, but one shard does most of the work because one popular key lives there. Averages hide hot spots. Cache the hot item, or split the key so its load spreads.' },

    { id: 'single', answer: 'Single-threaded bottleneck', glossary: '/glossary/use-method/',
      build(h) { const cores = [4, 8][h.RI(0, 1)], knee = h.R(0.35, 0.5);
        return { story: `Report export service on a ${cores}-core machine.`, charts: [
          c('Total CPU', '%', LOAD, [s(h.capped(100 / cores, knee, 100 / cores * 0.98))], { max: 100 }),
          c('Busiest core', '%', LOAD, [s(h.capped(100, knee, 99))], { max: 100 }),
          c('Throughput', 'req/s', LOAD, [s(h.plateau(h.RI(40, 120), knee))]),
          c('p95 latency', 'ms', LOAD, [s(h.hockey(h.RI(300, 600), knee, 6))]),
        ] }; },
      explain: "Total CPU stalls at one core's worth (100% ÷ the number of cores) while one core is pinned at 100%: the work runs on a single thread (an event loop, a global lock or a single consumer). More cores won't help until that path runs in parallel." },

    { id: 'index', answer: 'Missing database index', glossary: '/glossary/n-plus-one-query/',
      build(h) {
        return { story: `Same load every week; the orders table keeps growing.`, charts: [
          c('Rows in orders table', 'M', TIME, [s(h.rising(h.R(1, 3), h.R(20, 40)))]),
          c('Rows scanned per search', 'M', TIME, [s(h.rising(h.R(1, 3), h.R(20, 40)))]),
          c('Search query time', 'ms', TIME, [s(h.rising(h.RI(40, 80), h.RI(1500, 3000)))]),
          c('Throughput', 'req/s', TIME, [s(h.flat(h.RI(100, 300), 0.03))]),
        ] }; },
      explain: 'Every search reads the whole table, so query time grows in step with the table, not with load. Load tests on a small test database never see it. Add the right index and test with production-sized data.' },

    { id: 'lb', answer: 'Uneven load balancing', glossary: '/glossary/load-testing/',
      build(h) { const knee = h.R(0.4, 0.55);
        return { story: `3 app instances behind a load balancer with sticky sessions.`, charts: [
          c('Requests per instance', 'req/s', LOAD, [s(h.rising(0, h.RI(900, 1300)), 'app-1'), s(h.rising(0, h.RI(250, 350)), 'app-2'), s(h.rising(0, h.RI(250, 350)), 'app-3')]),
          c('CPU per instance', '%', LOAD, [s(h.capped(100, knee, 99), 'app-1'), s(h.rising(5, h.RI(25, 35)), 'app-2'), s(h.rising(5, h.RI(25, 35)), 'app-3')], { max: 100 }),
          c('Errors', '%', LOAD, [s(h.xs().map(x => x < knee ? 0 : h.noise(20 * (x - knee), 0.1)))], { max: 100 }),
          c('p95 latency', 'ms', LOAD, [s(h.hockey(h.RI(100, 180), knee, 6))]),
        ] }; },
      explain: "One instance gets most of the traffic (sticky sessions pinned the load test's few IPs to it) while the others idle. Check the balancing algorithm, and make sure your load test uses many connections and source IPs like real users do." },

    { id: 'keepalive', answer: 'No connection reuse (keep-alive off)', glossary: '/glossary/ttfb/',
      build(h) { const knee = h.R(0.4, 0.55);
        return { story: `Mobile API over HTTPS, ramp to ${h.RI(2000, 5000)} req/s.`, charts: [
          c('New TCP/TLS connections', '/s', LOAD, [s(h.rising(0, h.RI(2000, 5000)))]),
          c('Sockets in TIME_WAIT', 'k', LOAD, [s(h.rising(0, h.RI(25, 60), 1.2))], { limit: 28 }),
          c('CPU in TLS handshakes', '%', LOAD, [s(h.rising(3, h.RI(45, 65)))], { max: 100 }),
          c('Connection errors', '%', LOAD, [s(h.xs().map(x => x < knee ? 0 : h.noise(12 * (x - knee), 0.1)))], { max: 100 }),
        ] }; },
      explain: "New connections per second match requests per second: nothing is reused. Every request pays a TLS handshake and leaves a socket in TIME_WAIT until ports run out. Turn on keep-alive or HTTP/2 and pool connections." },
  ];

  // Build one round: the scenario's charts plus 4 shuffled options (the answer and 3 others).
  function round(scenario, seed) {
    const r = rng(seed), h = make(r);
    const b = scenario.build(h);
    const others = SCENARIOS.filter(x => x.answer !== scenario.answer).map(x => x.answer);
    for (let i = others.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [others[i], others[j]] = [others[j], others[i]]; }
    const options = [scenario.answer].concat(others.slice(0, 3));
    for (let i = options.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [options[i], options[j]] = [options[j], options[i]]; }
    return { id: scenario.id, story: b.story, charts: b.charts, options, answer: scenario.answer, explain: scenario.explain, glossary: scenario.glossary };
  }

  // Pick n different scenarios in random order.
  function game(n, seed) {
    const r = rng(seed);
    const order = SCENARIOS.map((x, i) => i);
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    return order.slice(0, n).map((idx, k) => round(SCENARIOS[idx], (seed * 7919 + k * 104729) >>> 0));
  }

  const api = { SCENARIOS, round, game, rng };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Bottlenecks = api;
})(typeof window !== 'undefined' ? window : this);
