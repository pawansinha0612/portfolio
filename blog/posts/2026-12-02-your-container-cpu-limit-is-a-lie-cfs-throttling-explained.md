---
title: Your container CPU limit is a lie — CFS throttling explained
date: 2026-12-02
summary: CFS quota looks like a hard limit but behaves like a bursty token bucket. Multi-threaded runtimes burn the budget in milliseconds and stall for the rest of the period. Here is how to detect and fix it.
description: Deep dive on CFS throttling: cpu.max, quota burn rate, nr_throttled metrics, and fixes for Java, Go, Node.js.
tags: Performance, Kubernetes, Linux, Observability
linkedin: |
  Your container shows 45% CPU but latency spikes to 2 seconds. The limit is 2 cores. You're not CPU bound — you're quota bound.
  
  CFS quota (cpu.max in cgroup v2) is a token bucket: 200ms budget per 100ms period. A 50-thread Java burst burns that in 4ms. The other 96ms your threads sit throttled. Requests queue. p99 explodes.
  
  Detection: `rate(container_cpu_cfs_throttled_periods_total[1m]) > 0` correlates with latency spikes. Fix: match runtime parallelism to quota (GOMAXPROCS, ActiveProcessorCount), lengthen the period, or switch to cpu.weight for proportional sharing.
  
  What's your go-to fix when throttle metrics spike?
---
Your load test shows p99 latency of 120 ms. The same endpoint in production hits 2.3 seconds. CPU utilisation on the container sits at 45 percent. The limit is 2 cores. You are not CPU bound — you are quota bound.

The Completely Fair Scheduler bandwidth controller enforces `cpu.cfs_quota_us` over `cfs_period_us` (cgroup v1) or `cpu.max` (cgroup v2). The default period is 100 ms. A 2-core limit means `quota = 200000` microseconds per period. That is a budget of 200 ms of on-CPU time every 100 ms of wall time. The kernel implements a token bucket: each period the bucket refills by `quota` microseconds. Every thread that runs consumes tokens. When the bucket empties the task is throttled — descheduled until the next refill.

## The burst trap

Imagine a Java service with 50 threads handling a burst of requests. All 50 threads are runnable. On a 32-core node they can consume 50 × 100 ms = 5000 ms of CPU in a single 100 ms period. The quota is 200 ms. The bucket empties after 4 ms of wall time. The remaining 96 ms the threads sit in `THROTTLED` state. Requests that arrived at millisecond 5 wait 95 ms for the next refill. That is not contention. That is the scheduler doing exactly what you configured.

The maths is simple. Let `P` be the period (100 ms), `Q` the quota (200 ms), `N` the number of simultaneously runnable threads. The maximum wall time before throttle is `P × Q / (N × P) = Q / N` milliseconds. With `N = 50` you get 4 ms. With `N = 8` you get 25 ms. The more parallelism your runtime creates the faster you hit the wall.

## Why runtimes burn quota early

The JVM, Go runtime, and Node.js worker pools all create more threads than the quota allows. The JVM defaults to a thread pool sized to the host CPU count, not the cgroup limit. Go's `GOMAXPROCS` reads `/proc/cpuinfo` unless you set it explicitly. Node's `worker_threads` default to the host core count. Each thread that enters a runnable state during the period draws from the same bucket. Context switches, GC safepoints, JIT compilation, and lock contention all consume quota without advancing user work.

A common pattern: a request arrives, the framework spawns a CompletableFuture, the thread pool executes a DB call, the callback runs on another thread. That single logical request may touch 3-4 threads sequentially. Each transition burns quota. The effective quota per request is lower than you think.

## Detecting throttle with metrics

In cgroup v1 read `/sys/fs/cgroup/cpu/cpu.stat`. The field `nr_throttled` increments each time a task is throttled. `throttled_time` accumulates nanoseconds spent throttled. In cgroup v2 the file is `cpu.stat` with the same fields. cAdvisor exposes `container_cpu_cfs_throttled_periods_total` (counter of periods with any throttle) and `container_cpu_cfs_throttled_time_total` (nanoseconds). Prometheus queries:

```promql
# Periods with throttle per minute
rate(container_cpu_cfs_throttled_periods_total[1m])

# Throttled time ratio
rate(container_cpu_cfs_throttled_time_total[1m]) / 1e9
```

A healthy system shows zero throttled periods. Any non-zero value means requests queued for the next period. Correlate with latency percentiles: if p99 spikes align with throttle spikes you have found the cause.

## Coordinated omission in your metrics

Most application metrics libraries record latency only for completed requests. A request that spends 95 ms throttled then 5 ms processing appears as 5 ms. The 95 ms wait is invisible. This is coordinated omission — the measurement system coordinates with the scheduler to hide the worst cases. Fix it by recording queue time separately or by using a latency histogram that captures the full wall time from request entry to response exit including scheduler delay.

## Fixes and trade-offs

**Increase quota.** Raise `cpu.max` to `400000 100000` (4 cores). Cost: more cluster capacity consumed. Risk: noisy neighbour effect on shared nodes.

**Reduce parallelism.** Set `GOMAXPROCS=2`, `-XX:ActiveProcessorCount=2`, `NODE_OPTIONS=--max-old-space-size=...` (Node does not have a direct thread limit; use a worker pool sized to quota). Cost: lower throughput under burst. Benefit: predictable latency.

**Lengthen the period.** cgroup v2 allows `cpu.max "200000 200000"` (200 ms period). The bucket refills less often but in larger chunks. A 50-thread burst now gets 8 ms before throttle instead of 4 ms. Trade-off: longer worst-case latency for a single throttled task (up to one period).

**Use CPU shares instead of quota.** `cpu.weight` (v2) or `cpu.shares` (v1) gives proportional allocation without hard throttling. Under contention you get fair share; under no contention you can burst to all cores. Trade-off: no hard isolation. A noisy neighbour can still starve you.

**Pin to dedicated cores.** `cpuset.cpus` (v1) or `cpuset.cpus.effective` (v2) with a static allocation. The CFS bandwidth controller is bypassed entirely. Cost: requires node-level topology management and wastes idle cores.

## A decision checklist

- [ ] Alert on `rate(container_cpu_cfs_throttled_periods_total[5m]) > 0`
- [ ] Correlate throttle periods with p99 latency spikes
- [ ] Verify runtime thread count matches quota (`GOMAXPROCS`, `ActiveProcessorCount`)
- [ ] Measure queue time separately from service time
- [ ] Choose one: increase quota, reduce parallelism, lengthen period, switch to shares, or pin cores
- [ ] Re-run load test with the same burst profile and confirm throttle counter stays at zero

## The kernel view

If you have node access, `perf sched record -a -- sleep 30` followed by `perf sched latency` shows per-task wait time. Look for `throttled` in the wait reason column. `trace-cmd record -e sched:sched_throttle -e sched:sched_unthrottle` captures every throttle event with PID and cgroup. This is how you prove the hypothesis before changing config.

CFS quota is not a limit. It is a burst budget with a forced pause. Treat it like a rate limiter on CPU time — because that is exactly what it is.
