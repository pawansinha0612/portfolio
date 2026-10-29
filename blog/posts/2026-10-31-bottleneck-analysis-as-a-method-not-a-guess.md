---
title: Bottleneck Analysis as a Method, Not a Guess
date: 2026-10-31
summary: A systematic approach to find, prove and fix the real bottleneck in a service stack. One metric, one hypothesis, one fix, repeat until the load moves.
tags: Performance, Bottleneck, Observability
linkedin: |
  Bottleneck analysis isn’t a gut feeling – it’s a loop of hypothesis, metric, fix and retest. The trick is to pick one metric that shows a resource is saturated, prove it, fix it, and then watch the next layer rise to the top. For example, if your DB connection pool utilisation is 97 %, bump the pool size and re‑test. The latency drops, but CPU utilisation spikes – the bottleneck has moved. Repeat until you hit your target. What metric do you rely on first when you spot a performance dip?
---
## Hypothesis: What you think is slow
When a service shows a 200‑ms average latency under a 100 req/s load, the first instinct is to blame the database. A hypothesis is a testable statement that links an observable to a suspected cause. In this case: *The database queue is the bottleneck*.

## Map the request path
A request crosses several layers: client → CDN → load balancer → API gateway → service thread → cache → DB → storage. Each layer can introduce latency, queueing, or CPU utilisation. Understanding the path lets you decide which metrics to collect.

## Choose a saturated‑resource metric (USE)
**USE** stands for *Utilisation, Saturation, and Exhaustion*. It is a shorthand for the metric that most directly shows a resource is at capacity.

| Layer | Typical metric | Saturation threshold | Why it matters |
|-------|----------------|----------------------|----------------|
| CPU | CPU utilisation per core | >85 % | A core busy >85 % is likely to start queuing work. |
| Thread pool | Queue length | >80 % of max | A thread pool that is constantly full cannot schedule new work. |
| DB connections | Connection pool utilisation | >95 % | If all sockets are in use, requests wait. |
| Cache | Hit ratio | <70 % | A low hit ratio forces DB hits. |
| Disk | I/O utilisation | >90 % | Disk thrashing stalls reads/writes. |
| Network | Outbound latency | >200 ms | Network congestion adds to round‑trip time. |

Pick one metric that you can query in a single Prometheus query or a single histogram bucket.

## Detect coordinated omission
Coordinated omission occurs when the measurement system hides the true latency because it does not account for queued requests. For example, a k6 test that fires 100 req/s but only measures the time from request send to response receive will under‑report latency if the server is queuing. Use the `--latency` flag in k6 or the `--output csv` option to capture the full request/response cycle.

## Prove the hypothesis with a single metric
Assume the hypothesis is *the DB queue is the bottleneck*. A single metric that proves this is the *DB connection pool utilisation*. A Prometheus query could be:

```promql
# DB connections used / DB connections allowed
sum(rate(db_connections_used_total[1m])) / sum(db_connections_max_total)
```

If the result is 0.97, the pool is 97 % utilised. The metric is simple, unambiguous, and can be plotted over time.

## Fix the saturated layer
### Example fix: increase DB pool size
If the pool is the bottleneck, raise `max_connections` from 100 to 200. Re‑run the load test. The utilisation should drop below 80 %.

### Example fix: add a cache layer
If the cache hit ratio is 65 %, add a Redis read‑through cache. Monitor the hit ratio; it should climb above 85 %.

## Re‑test and watch the bottleneck move
After the fix, re‑run the same test. The original metric should now be below threshold. A new metric will surface: perhaps CPU utilisation rises to 90 %. The bottleneck has moved. Repeat the cycle.

## Checklist for a disciplined bottleneck analysis
| Step | Action | Tool / Command |
|------|--------|----------------|
| 1 | Form a hypothesis | Document in a JIRA ticket |
| 2 | Identify USE metric | Prometheus query or Grafana panel |
| 3 | Capture full latency | k6 `--latency` or `--output csv` |
| 4 | Verify saturation | Check metric against threshold |
| 5 | Apply fix | Database config, thread pool, cache |
| 6 | Re‑test | Same k6 test, same load |
| 7 | Observe new bottleneck | Re‑run checklist |
| 8 | Repeat | Until latency target met |

## Edge cases to watch for
* **Metastable failure** – a transient spike that disappears after a few minutes can mislead you into thinking a layer is saturated when it is not. Use a rolling average of 5 min to smooth out spikes.
* **Safepoint bias** – JDK safepoints pause all Java threads for garbage collection. If GC pauses are frequent, CPU utilisation will appear low while throughput suffers. Enable `-XX:+PrintGCDetails` and analyse GC logs.
* **CFS quota** – On Linux, the Completely Fair Scheduler (CFS) may throttle a container if it exceeds its CPU quota. Check `cgroup` CPU limits; if the container is throttled, CPU utilisation metrics will be misleading.
* **Off‑CPU time** – Time spent waiting for I/O or network is not counted in CPU utilisation. A high off‑CPU time indicates I/O contention.

## Concluding thought
Bottleneck analysis is a disciplined, data‑driven loop: hypothesis → metric → proof → fix → retest. It removes guesswork and ensures that every optimisation targets a real, measurable limitation. Use the checklist to keep the process repeatable and audit‑able.

## Takeaway
A single, well‑chosen metric can prove or disprove a bottleneck hypothesis. Pick it, monitor it, fix it, and watch the next bottleneck surface.
