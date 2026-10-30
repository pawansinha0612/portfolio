---
title: Your bottleneck isn't where you think it is
date: 2026-10-31
summary: Most slow-system investigations start with a fix. Start instead with service demand, the USE method and a stepped open-model test, and prove the bottleneck before touching anything.
tags: Performance, Bottlenecks, Capacity Planning
highlight: bottleneck
linkedin: |
  "Let's double the connection pool and see." That's a guess, not an analysis.

  My rule: no change goes in until you can name the saturated resource and show the number that proves it.

  The method is simple. Work out the service demand per tier (Utilisation Law: U = X × D), run a stepped open-model load test, and watch which resource starts saturating at the knee: queues, waits and throttled periods, not just utilisation. Fix that one thing, re-run the identical test, and expect the bottleneck to move.

  If latency climbs and no resource looks busy, look for waiting: locks, pools, GC pauses, downstream calls, or CPU throttling hidden behind a low average.

  The article has an interactive calculator: put in your own cores and CPU cost per request and see which tier caps you.

  What's the first saturation metric you look at when p99 starts climbing?

  #PerformanceEngineering #SRE #CapacityPlanning
---
The dashboards are green. CPU sits at 55%, memory is fine, the database looks bored. And p99 has just gone from 180 ms to 4 seconds.

Someone in the incident channel types the sentence that has burned more engineering hours than any bug: "Let's just double the connection pool and see."

Sometimes that works. More often it moves the queue somewhere else and the tail gets worse. My rule is blunt: **no change goes in until you can name the saturated resource and show the number that proves it.** Here is the method behind that rule.

## Start with service demand, not dashboards

Every system has a throughput ceiling set by its most constrained resource. The operational laws make this concrete:

- **Utilisation Law:** U = X × D, where X is throughput and D is the *service demand* (the total busy time one request needs from that resource).
- **Bottleneck bound:** X_max = capacity / D_max. The resource with the largest demand relative to its capacity caps the whole system.

A worked example. Say each request costs 20 ms of CPU in the API tier, which runs 3 pods with 2 cores each, and 8 ms of CPU on a database with 8 cores.

| Tier | Capacity | Demand per request | Max throughput |
|------|----------|--------------------|----------------|
| API | 6 cores | 0.020 core-s | 6 / 0.020 = **300 req/s** |
| Database | 8 cores | 0.008 core-s | 8 / 0.008 = 1,000 req/s |

The API tier caps the system at 300 req/s. Tuning the database here buys nothing. At 240 req/s the API tier sits at U = 240 × 0.020 / 6 = 0.8, which is already where queueing delay starts to bite.

You can get demand numbers cheaply: divide CPU-seconds consumed during a steady test by the number of requests served. Do this before any tuning conversation.

Try it with your own numbers. Change the cores and CPU cost per request for each tier and watch where the ceiling lands:

<div class="widget" data-widget="bottleneck"><p><em>Interactive calculator: open this post on pawansinha.com.au to try it with your own numbers.</em></p></div>

## Use RED to find the service, USE to find the resource

**RED** (Rate, Errors, Duration, from Tom Wilkie) tells you *which service* is slow. Traces tell you which span on the critical path owns the time. Then the **USE method** (Utilisation, Saturation, Errors, from Brendan Gregg) tells you *which resource* inside it is the problem.

The column that matters most is saturation: work that is *waiting*. Utilisation alone misleads. A connection pool at 100% utilisation is fine if nobody waits for a connection. A CPU at 55% average can still be throttled every 100 ms period.

| Resource | Utilisation | Saturation (the real signal) | Errors |
|----------|-------------|------------------------------|--------|
| CPU | busy % per core / container | run-queue length (`vmstat` r > cores), CFS throttled periods | n/a |
| Memory | used vs limit | major page faults, swapping, GC frequency | OOM kills |
| Disk | `iostat` %util | `aqu-sz`, `r_await`/`w_await` | I/O errors |
| Network | bytes vs link or instance limit | retransmits, drops, accept-queue overflows | resets |
| Thread pool | active / max | queued tasks, time in queue | rejections |
| Connection pool | active / max | pending acquirers, acquire time | acquire timeouts |

Software resources (pools, locks, semaphores, rate limits) are resources too. In practice they are the bottleneck more often than hardware.

## The experiment: stepped, open-model load

The single most useful test for bottleneck analysis is a **stepped arrival-rate test**. Hold each load level long enough to reach steady state, and use an open model so the load generator does not slow down when the system does (otherwise you get coordinated omission and a flattering result).

```javascript
import http from 'k6/http';

export const options = {
  scenarios: {
    steps: {
      executor: 'ramping-arrival-rate',
      startRate: 50,
      timeUnit: '1s',
      preAllocatedVUs: 200,
      maxVUs: 1000,
      stages: [
        { target: 100, duration: '1m' }, { target: 100, duration: '5m' },
        { target: 200, duration: '1m' }, { target: 200, duration: '5m' },
        { target: 300, duration: '1m' }, { target: 300, duration: '5m' },
      ],
    },
  },
  thresholds: { http_req_duration: ['p(99)<500'] },
};

export default function () {
  http.get(`${__ENV.BASE_URL}/api/orders`);
}
```

Plot achieved throughput against offered load, and p99 against offered load. The knee is where throughput stops tracking offered load and latency turns upward. **The bottleneck is the resource whose saturation metric rises at that knee.** Also watch k6's `dropped_iterations`: if it is non-zero, the generator ran out of VUs and your offered load was lower than you think.

Two queries that settle a lot of arguments:

```promql
# Fraction of CFS periods in which the container was throttled
sum by (pod) (rate(container_cpu_cfs_throttled_periods_total{container="api"}[5m]))
  /
sum by (pod) (rate(container_cpu_cfs_periods_total{container="api"}[5m]))

# Threads waiting for a database connection (HikariCP via Micrometer)
max by (pod) (hikaricp_connections_pending)
```

## Prove it, then falsify it

A hypothesis must predict something: "the API tier's CPU is the bottleneck, so throttled periods will climb at the knee, and adding one core per pod in a test (9 cores / 0.020 = 450) will move the ceiling from about 300 to about 450 req/s, unless something else saturates first." If you can relieve the suspected resource in a test environment and the knee moves as predicted, you have proof. If it does not move, you were wrong, and you found out cheaply.

## Fix one thing, then watch the bottleneck move

Change one thing. Re-run the *identical* workload. Expect the bottleneck to move, and expect the gain to be smaller than the arithmetic suggests, because the next constraint is usually close behind. Sometimes the fix makes things worse: a bigger connection pool lifts the app tier's throughput and pushes the database into lock contention, so p99 rises.

## When nothing looks saturated

If latency rises and every utilisation graph looks calm, the time is being spent **waiting**, off-CPU:

- lock contention and synchronised sections
- pool acquisition (threads, connections, HTTP clients)
- GC pauses (check the GC log, not the CPU graph)
- downstream calls and their retries
- CPU throttling hidden by a one-minute average
- the load generator itself (check its CPU and network)

Short bursts are the other blind spot. A one-minute average of 60% CPU can contain ten seconds at 100%. Look at saturation counters, which accumulate, rather than averaged utilisation.

## Checklist

1. Define the symptom precisely: which endpoint, which percentile, at what arrival rate.
2. Estimate service demand per tier and compute the expected ceiling.
3. Use RED and traces to locate the service and span, then USE to locate the resource.
4. Run a stepped open-model test and find the knee.
5. Name the resource whose saturation rises at the knee, and predict what relieving it will do.
6. Change one thing, re-run the same test, and record where the bottleneck moved.
