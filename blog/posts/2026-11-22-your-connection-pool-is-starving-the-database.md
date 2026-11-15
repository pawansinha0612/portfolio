---
title: Your connection pool is starving the database
date: 2026-11-22
summary: Pool sizing is a queueing problem not a configuration guess. Learn why pool wait time beats throughput as a signal and how to size pods × pool against max_connections without raising latency.
description: Size database connection pools with queueing theory. Pool wait time, Little's Law, and why bigger pools increase latency.
tags: Performance, Database, Queueing Theory, k6
linkedin: |
  Your load test shows great throughput but p99 is 12 seconds. The culprit: 20 pods × 30 pool size = 600 connections fighting for a 500 max_connections database.
  
  Pool sizing is a queueing problem. Use Little's Law: wait time = queue length / throughput. Target 70% utilisation. Instrument pool wait histogram not just throughput. Alert when p99 pool wait exceeds 10ms.
  
  Bigger pools raise latency past the knee because database context switching and lock contention grow quadratically (Universal Scalability Law).
  
  What pool wait threshold do you alert on?
---
Your load test shows 2000 requests per second with a p50 of 45 milliseconds. The p99 sits at 12 seconds. The application logs show thousands of HikariCP pool timeout exceptions. The database max_connections is 500. You run 20 pods each with a pool of 30. That is 600 potential connections fighting for 500 slots. The maths was wrong before you started.

## The queueing model behind the pool

A connection pool is an M/M/c queue. Requests arrive at rate λ. Each connection serves at rate μ. The pool size c is the number of servers. When all c servers are busy new requests wait in a queue. The average time a request spends waiting is Wq. The average number waiting is Lq. Little's Law binds them: Lq = λ × Wq.

The utilisation ρ = λ / (c × μ). As ρ approaches 1 the queue length grows exponentially. The Erlang-C formula gives the probability a request waits:

P(wait) = (c × ρ)^c / (c! × (1 - ρ)) × (sum from k=0 to c-1 of (c × ρ)^k / k! + (c × ρ)^c / (c! × (1 - ρ)))^-1

For a concrete example imagine λ = 1800 requests per second. Each request holds a connection for 20 milliseconds so μ = 50 per second. With c = 30 the utilisation ρ = 1800 / (30 × 50) = 1.2. The system is unstable. The queue grows without bound. Drop c to 25 and ρ = 1.44. Worse. Raise c to 40 and ρ = 0.9. P(wait) ≈ 0.53. Average wait Wq = P(wait) / (c × μ × (1 - ρ)) = 0.53 / (40 × 50 × 0.1) = 0.0265 seconds or 26.5 milliseconds. That wait adds straight to your p99.

## Pods × pool size versus max_connections

The total connection demand is pods × pool_size. If that product exceeds max_connections the database becomes the bottleneck. Postgres defaults to 100. A typical cloud instance might allow 500. Your 20 pods at 30 each demand 600. The database rejects the excess with connection refused errors. Those errors surface as pool timeouts after the client side timeout expires.

The safe ceiling is pods × pool_size ≤ max_connections × safety_factor. A safety factor of 0.8 leaves headroom for superuser connections and background tasks. For max_connections = 500 and 20 pods the maximum pool per pod is 500 × 0.8 / 20 = 20. Not 30.

If you need more throughput you have three levers. Reduce hold time μ^-1 by optimising queries. Increase max_connections if the instance class allows it. Add read replicas and route reads there. Adding pods without adjusting pool size only moves the contention to the database.

## Pool wait time is the signal you should watch

Throughput hides queueing. A system at ρ = 0.95 can push the same requests per second as one at ρ = 0.6. The difference shows in wait time. Instrument the pool wait histogram. In HikariCP expose hikaricp_connections_pending and hikaricp_connections_wait_time_seconds. In a k6 script tag the pool wait:

```javascript
import http from 'k6/http';
import { check } from 'k6';

export default function () {
  const start = new Date();
  const res = http.get('https://api.example.com/orders/123');
  const poolWait = res.timings.waiting - res.timings.sending - res.timings.receiving;
  check(res, { 'pool wait < 50ms': () => poolWait < 50 });
}
```

Alert when p99 pool wait exceeds 10 milliseconds for OLTP workloads. That threshold catches queueing before it cascades into timeouts. If you only alert on pool exhaustion you are already in outage.

## Why bigger pools raise latency

Increasing pool size past the knee of the utilisation curve hurts latency in three ways.

First the database side. Each connection consumes a backend process or thread. Postgres uses one process per connection. MySQL uses a thread. At 500 connections the OS scheduler spends measurable time context switching. The CPU cache working set grows. Lock contention on shared buffers increases. The throughput per connection drops. This is Gunther's Universal Scalability Law in action: throughput = c × μ / (1 + α(c - 1) + β c (c - 1)). The β term is coherency delay. It grows quadratically with c.

Second the client side. A larger pool means more concurrent in-flight requests per pod. The application thread pool must match. If you have 50 connections but only 20 request threads 30 connections sit idle. If you raise threads to 50 you increase heap pressure and GC pauses. The JVM safepoint bias grows with thread count. Off-CPU time in profilers shows this as scheduler latency.

Third the network layer. More connections mean more TLS handshakes more socket buffers more ephemeral port usage. On Kubernetes the conntrack table can fill. The default nf_conntrack_max is often 65536. At 20 pods × 50 connections that is 1000 entries. Harmless. At 100 pods × 100 connections you hit 10000. Still fine. But each new connection allocates kernel memory. The marginal cost is small but non-zero.

The net effect: latency per request is service_time + wait_time. Wait_time falls as pool size rises until ρ drops below 0.7. Past that point the database side degradation outweighs the queueing benefit. The optimum pool size is where d(latency)/d(pool_size) = 0. In practice that is often 2 × CPU_cores for the database instance up to the max_connections limit divided by pod count.

## Sizing checklist

Use this checklist when you provision a new service or scale an existing one.

1. Measure the average connection hold time under load. Call it H seconds. μ = 1 / H.
2. Estimate peak request rate λ per pod. Use the 99th percentile of your traffic pattern not the average.
3. Choose a target utilisation ρ_target. 0.7 is safe for OLTP. 0.85 for batch.
4. Compute minimum pool per pod: c_min = λ / (μ × ρ_target). Round up.
5. Verify pods × c_min ≤ max_connections × 0.8. If false reduce pods or increase max_connections or add read replicas.
6. Run a 30 minute soak test at peak λ. Record pool wait p50 p95 p99.
7. If p99 pool wait > 10 ms increase pool by 10 percent and repeat. Stop when p99 stops improving or database CPU hits 70 percent.
8. Set the pool timeout to 2 × p99 pool wait from step 7. This fails fast instead of queuing indefinitely.
9. Document the final numbers in the runbook. Revisit when traffic pattern shifts by more than 30 percent.

## A worked example

Service: payments API. Peak λ = 1200 req/s per pod. Hold time H = 15 ms so μ = 66.7 /s. Target ρ = 0.75. c_min = 1200 / (66.7 × 0.75) = 24. Round to 25.

Pods = 15. max_connections = 400. 15 × 25 = 375. 375 ≤ 400 × 0.8 = 320? No. 375 > 320.

Options:
- Reduce pods to 12. 12 × 25 = 300 ≤ 320. Pass.
- Increase max_connections to 500. 15 × 25 = 375 ≤ 400. Pass.
- Reduce pool to 21. 15 × 21 = 315 ≤ 320. Pass but ρ rises to 1200 / (21 × 66.7) = 0.857. Wait time jumps.

Pick the option that keeps ρ ≤ 0.75 and satisfies the connection budget. In this case reducing pods to 12 or raising max_connections are the only valid moves.

## What to avoid

Do not set pool size to max_connections / pods without the safety factor. Do not ignore pool wait because throughput looks fine. Do not increase pool size when database CPU is already above 70 percent. Do not rely on the default pool timeout of 30 seconds. That masks the problem until the pod OOMs from queued requests.

Pool sizing is a capacity planning exercise not a tuning knob. Treat it like one.
