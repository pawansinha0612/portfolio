---
title: Your Load Test Masking Concurrency Bugs
date: 2026-11-18
summary: Load tests can hide race conditions and deadlocks. Learn how to design tests that surface these hidden failures.
description: Detect concurrency bugs that surface only under load – race conditions, lock contention, deadlocks, connection starvation – with targeted test design.
tags: Performance, Concurrency, Testing
linkedin: |
  Your load test reports 1 ms p99 latency, but real users see 9 seconds. The culprit? A hidden race condition that only appears under high concurrency. The fix is not to add more threads or increase capacity; it is to design a test that deliberately stresses the shared state. A simple k6 script that ramps to 1 k VUs, keeps a transaction open, and limits the thread pool will expose the problem. The key takeaway: use precise metrics—thread pool state, lock wait times, connection pool utilisation—and validate with thread dumps and JFR. How do you currently design your concurrency tests?
---
## A Load Test That Lies About Latency
Your load test reports a 99th‑percentile latency of 1 ms, yet real users experience 9 seconds for the same endpoint. The test runs 200 virtual users for 30 seconds, all on a single machine. The system under test is a microservice that writes to a shared cache and then to a database. The anomaly appears only when the test is run in a CI pipeline, not in a local environment. The root cause is a race condition in the cache update logic that surfaces only under high concurrency.

## Why Concurrency Bugs Slip Through
Concurrency bugs arise when multiple threads or processes manipulate shared state without proper isolation. The most common types are:

* **Race condition** – two threads read the same value, modify it, and write back, leaving the final state inconsistent. It is invisible when the threads run serially.
* **Lock contention** – a lock is held by one thread while many others wait, increasing latency. The effect scales with thread count.
* **Deadlock** – two or more threads wait for each other’s locks, blocking forever. It is often triggered by a specific ordering of resource acquisition.
* **Connection starvation** – the connection pool is exhausted, forcing new requests to queue. The queue grows until the pool is replenished.
* **Thread starvation** – the thread pool is saturated, so new tasks wait in the queue until a worker becomes free.

A common misconception is that a load test that shows low latency guarantees correctness. In reality, the test may mask the problem because the load profile does not exercise the pathological interleavings that trigger the bug.

## The Request Path as a Bottleneck Map
A request traverses multiple layers: client, CDN, load balancer, API gateway, service thread, cache, database, network, and finally the client. Fixing one layer often shifts the bottleneck to the next. For example, increasing the thread pool size may reduce thread starvation but expose lock contention in the database layer. Understanding where the request spends time is essential to design a test that forces the hidden failure.

## Detecting Hidden Concurrency Issues
### 1. Metrics and Tracing
* **Thread pool metrics** – `jcmd <pid> Thread.print` shows the number of runnable, waiting, and blocked threads. A high `blocked` count indicates contention.
* **Connection pool metrics** – in a JDBC pool, query `SELECT * FROM pool_status` or use the pool’s JMX bean. A high `idle` count with low `active` indicates starvation.
* **Queue length** – in a Kubernetes environment, `kubectl top pod` shows CPU and memory; use `kubectl describe pod` to inspect container resource limits.
* **Histogram merging** – Grafana can aggregate latency histograms across services. Look for a long tail that appears only under load.
* **Coordinated omission** – Gil Tene’s phenomenon occurs when a test client misses measuring a request because the server is busy. k6 reports `p999` and `p9999` to expose this.

### 2. Profiling
* **JFR (Java Flight Recorder)** – enable `-XX:+UnlockCommercialFeatures -XX:+FlightRecorder` and record a 5‑minute session during peak load. Inspect the `Lock contention` event.
* **k6 `--summary-export`** – export CSV and analyse the `http_reqs` and `http_req_duration` columns.
* **CPU utilisation** – `top -H` shows per‑thread CPU usage. A thread stuck in `S` state indicates it is waiting for a lock.

## Designing Tests that Provoke Concurrency Bugs
### 1. Load Shape Matters
A ramp‑up to 1 k concurrent users over 10 seconds followed by a 30 second hold creates a high contention window. The key is to exceed the service’s optimal concurrency threshold. Use k6’s `stages` to define:

```js
k6 run --vus 1000 --duration 30s \
  --stages "10s:100,20s:500,10s:1000,30s:1000"
```

### 2. Long‑Lived Transactions
If the service uses database transactions, keep them open for a few seconds. The test should issue a `BEGIN` and delay the `COMMIT`. This forces the database to hold locks longer, increasing the chance of contention.

### 3. Resource Limits
Configure the container with a low CPU quota (e.g., `cpu: 0.5`) and a small thread pool size (e.g., `maxThreads=50`). Run the test and watch the thread pool saturation.

### 4. Chaos Injectors
Use a lightweight chaos tool to kill a worker thread at random intervals. The test will then need to schedule the task on a new thread, exposing potential deadlocks.

## Example: Race Condition in a Cache Update
Consider a service that increments a counter in Redis:

```java
public void increment(String key) {
    long value = redis.get(key); // read
    redis.set(key, value + 1);   // write
}
```

Two threads read the same value before either writes. The final counter is incremented only once. Under low load, the window is narrow; under 1 k concurrent users, the window widens, and the bug surfaces.

### Proving the Hypothesis
Run k6 with the `--summary-export` flag and inspect the `http_req_duration` histogram. A secondary peak at 5–10 ms indicates a race. Add a custom metric:

```js
import http from 'k6/http';
import { Counter } from 'k6/metrics';

export let raceDetected = new Counter('race_detected');

export default function () {
    let res = http.get('https://api.example.com/increment');
    if (res.status === 409) {
        raceDetected.add(1);
    }
}
```

If `race_detected` spikes during the high‑concurrency phase, the race is confirmed.

## Measuring Lock Contention
Lock contention can be quantified using the **lock wait time** `L` and the **critical section time** `C`. Throughput `T` is:

```
T = (N * C) / (C + L)
```

where `N` is the number of threads. If `L` dominates, throughput collapses. Use `jcmd <pid> Thread.print` to capture the average `wait` time. If `wait` > 10 ms, consider using a lock‑free data structure or reducing the critical section.

## Detecting Deadlocks
A deadlock manifests as a cycle in the wait‑for graph. The JVM exposes this via `jstack` or `jcmd <pid> Thread.print`. Look for `waiting` threads that hold a lock and are waiting for another. A quick check is:

```bash
jcmd <pid> Thread.print | grep -E "waiting|blocked"
```

If you see a cycle of two or more threads, the service is deadlocked. Fix by enforcing a strict lock acquisition order or using try‑lock with timeout.

## Connection and Thread Starvation
### Connection Starvation
If the pool has a maximum of 10 connections and the test opens 20 concurrent connections, the extra 10 will queue. The queue length can be observed via:

```bash
curl -s http://localhost:8080/actuator/metrics/jdbc.connections.active | jq .
```

A rising active count that never drops indicates starvation.

### Thread Starvation
A thread pool of 20 workers handling 100 concurrent requests will queue 80 tasks. The queue length is visible in the JMX bean `ThreadPoolExecutor`. A high `queueSize` coupled with low `activeThreads` signals starvation.

## Checklist for Concurrency‑Sensitive Load Tests
| Step | Action | Tool / Command |
|------|--------|----------------|
| 1 | Define concurrency threshold | k6 `--vus` or JMeter thread group | 
| 2 | Set resource limits | Kubernetes `resources` | 
| 3 | Enable detailed metrics | Grafana, Prometheus | 
| 4 | Capture thread dumps | `jcmd <pid> Thread.print` | 
| 5 | Inject chaos | k6 `--options`, custom script | 
| 6 | Analyse lock contention | JFR, `jcmd <pid> Thread.print` | 
| 7 | Verify no coordinated omission | k6 `--summary-export` | 
| 8 | Monitor connection pool | JMX bean, `curl` | 
| 9 | Validate deadlock detection | `jstack`, `jcmd` | 
|10 | Iterate until metrics stabilize | Repeat steps 1‑9 |

## Takeaway
Concurrency bugs surface only when the system is pushed beyond its normal operating envelope. A load test that reports low latency does not guarantee correctness. By designing tests that deliberately stress thread pools, connection pools, and lock‑heavy paths, and by using precise metrics and profiling, you can surface race conditions, lock contention, deadlocks, and starvation before they hit production.
