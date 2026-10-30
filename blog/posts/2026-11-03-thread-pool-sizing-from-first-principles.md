---
title: Why 500 threads made it slower
date: 2026-11-03
summary: Size thread pools with Little's Law and the wait-to-compute ratio, bound queues by your latency budget, and read thread dumps for what threads are waiting on. Plus what changes with virtual threads.
tags: Performance, Java, Concurrency
linkedin: |
  "Set maxThreads to 500 to be safe" is one of the least safe settings in a Java service.

  A thread pool is a queue in front of a fixed number of servers, so it can be sized with arithmetic:
  • Little's Law: busy threads = throughput × time each request holds a thread. 400 req/s × 50 ms = 20.
  • For I/O-heavy work: threads ≈ cores × target CPU utilisation × (1 + wait/compute).

  Then the part people skip: a thread pool bigger than the connection pool behind it doesn't add capacity. It moves the queue somewhere you can't see it.

  And bound the queue by your latency budget. A queue of 1,000 at 640 req/s is a 1.5-second wait, longer than most client timeouts, so you're doing work nobody is waiting for any more.

  How do you size your pools today: formula, load test or the default?

  #Java #PerformanceEngineering #Concurrency
---
Traffic climbs, latency follows. Someone opens the config, finds `maxThreads: 200`, and says the obvious thing: "Make it 500, to be safe."

The deploy goes out and p99 gets *worse*. CPU has barely moved. A thread dump shows hundreds of threads parked, all waiting for one of 10 database connections.

A thread pool is a queueing system: a fixed number of servers (threads) in front of a queue. That means it can be sized with arithmetic instead of folklore, and its failure modes can be predicted before they page you.

## Little's Law gives you the floor

**Little's Law**: L = λ × W. The average number of items in a system equals the arrival rate times the average time each item spends in it.

For a thread pool, L is the number of busy threads, λ is throughput, and W is how long a request holds a thread (not end-to-end latency, which also includes time queued).

Say an endpoint serves 400 req/s and each request holds a thread for 50 ms:

L = 400 × 0.05 = **20 busy threads on average.**

That is the average, not the size. Arrivals are bursty and service times have a tail, so the pool needs headroom above it, and the queue absorbs short bursts. But it tells you instantly that a pool of 500 for this workload is 25× the average need.

## CPU-bound vs I/O-bound: the wait-to-compute ratio

For **CPU-bound** work (parsing, compression, crypto), more threads than cores only adds context switching. Use roughly the number of cores available to the process.

For work that mostly **waits** (database calls, HTTP calls), Brian Goetz's formula in *Java Concurrency in Practice* gives the starting point:

N_threads = N_cpu × U_cpu × (1 + W / C)

where U_cpu is the target CPU utilisation, W is wait time and C is compute time per request.

Example: 4 cores, target 80% CPU, each request computes for 5 ms and waits for 45 ms:

N = 4 × 0.8 × (1 + 45/5) = 3.2 × 10 = **32 threads.**

Cross-check with Little's Law. At 80% of 4 cores, the pool has 3.2 CPU-seconds per second; each request needs 0.005, so throughput tops out at 3.2 / 0.005 = 640 req/s. Each request holds a thread for 50 ms, so L = 640 × 0.05 = 32. The two methods agree, which is a good sign your inputs are consistent.

## The pool behind the pool

Here is the trap: those 32 threads each want a database connection. If the connection pool has 10 connections, 22 threads at peak are parked waiting for one. Effective concurrency for that path is 10, and the extra threads add memory and context switches, not throughput.

**The effective concurrency of a request path is the smallest pool along it**: thread pool, connection pool, HTTP client pool, semaphores, downstream rate limits. Size them together. Raising one without the others only moves the queue somewhere less visible.

Try the arithmetic with your own service, including the connection pool behind it:

<div class="widget" data-widget="threads"><p><em>Interactive calculator: open this post on pawansinha.com.au to try it with your own numbers.</em></p></div>

## Queue choice changes behaviour, not just capacity

Java's `ThreadPoolExecutor` has three settings that interact in surprising ways: `corePoolSize`, `maximumPoolSize` and the work queue.

| Queue | Behaviour |
|-------|-----------|
| Unbounded `LinkedBlockingQueue` | New threads beyond core are created only when the queue is full, which never happens. `maximumPoolSize` is ignored, and the queue can grow until memory runs out. |
| `SynchronousQueue` | Direct hand-off: no queueing. The pool grows to max, then rejects. |
| Bounded `ArrayBlockingQueue` | Grows to core, queues up to the bound, then grows to max, then rejects. Predictable. |

**Bound the queue by your latency budget.** Queue wait ≈ queue depth / throughput. With a queue of 1,000 at 640 req/s, the last item waits about 1,000 / 640 ≈ 1.56 s before it even starts. If the client times out at 1 s, you are spending capacity on work nobody is waiting for, which is how overload turns into collapse. If you can afford 200 ms of queueing, the queue bound is about 0.2 × 640 = 128.

## Rejection is a feature

When the queue is full, the `RejectedExecutionHandler` decides what happens:

- `AbortPolicy` (default) throws `RejectedExecutionException`. Map it to a fast 503 or 429 so clients back off.
- `CallerRunsPolicy` runs the task on the submitting thread. This is natural back-pressure, but if the caller is a web server's I/O or event-loop thread, you just stalled your network layer.
- `DiscardPolicy` and `DiscardOldestPolicy` drop work silently. Rarely what you want for requests.

Failing fast under overload is what keeps p99 bounded for the requests you do accept.

## Web server defaults are not sizing

Embedded Tomcat (and Spring Boot's default config) uses `maxThreads` 200 and `acceptCount` 100 by default, with the NIO connector allowing up to 8,192 connections. Those numbers are generic defaults, not a statement about your workload. Derive yours from the arithmetic above and confirm with a stepped load test.

## Reading a thread dump for saturation

When latency climbs and CPU is low, threads are waiting. Find out on what:

```bash
# Take three dumps about 5 seconds apart
for i in 1 2 3; do jcmd <pid> Thread.print > dump-$i.txt; sleep 5; done

# Count thread states in each dump
grep -ho 'java.lang.Thread.State: [A-Z_]*' dump-*.txt | sort | uniq -c
```

How to read the states:

- **RUNNABLE** does not mean on-CPU. A thread blocked in a native socket read shows as RUNNABLE. Look at the top frame.
- **BLOCKED** means waiting to enter a `synchronized` monitor. Many threads BLOCKED on the same lock is contention.
- **WAITING / TIMED_WAITING (parking)** often means waiting on a pool: a connection pool's borrow method, a queue's `take`, a `Future.get`.

A stack frame that shows up in many threads across all three dumps is your bottleneck. One dump is a snapshot; three show persistence.

## Metrics to export

At minimum: active threads, pool size, queued tasks and, most valuable, **time spent in the queue** (record it yourself if your framework does not). Micrometer's executor metrics expose active, queued and pool-size gauges; exact metric names depend on the Micrometer version, so check your `/actuator/prometheus` output. Queue time is the saturation signal; active-thread count alone is utilisation.

## Virtual threads change the question

With Java 21 virtual threads, a blocking call no longer pins an OS thread, so you stop sizing thread pools for I/O-bound work. The question becomes: **what limits concurrency now?** Usually the connection pool or a downstream service. Put explicit limits (a semaphore or a bounded pool) in front of scarce resources, because millions of cheap threads will happily queue on a pool of 10 connections.

One caveat: in JDK 21 to 23, a virtual thread blocking inside a `synchronized` block stays *pinned* to its carrier thread, which can starve the scheduler. JDK 24 (JEP 491) removed most of that pinning. Check which JDK you run before trusting load test results across versions.

## Summary

1. Compute average busy threads with Little's Law.
2. Use the wait-to-compute formula as a starting size; cross-check the two.
3. Size the thread pool with the connection and client pools behind it.
4. Bound the queue by latency budget, and reject fast.
5. Prove the size with a stepped load test and three thread dumps.
