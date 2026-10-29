---
title: Sizing Thread Pools from First Principles
date: 2026-11-03
summary: Use Little’s Law to size CPU‑bound and I/O‑bound pools, choose the right queue, rejection policy and read thread dumps for BLOCKED and WAITING states.
tags: Performance, ThreadPool, CPU, I/O
linkedin: |
  Thread‑pool sizing can feel like a black art, but it is really just a maths problem. By applying Little’s Law (threads = throughput × time in pool) you can calculate the exact number of threads you need for both CPU‑bound and I/O‑bound workloads. A practical takeaway: measure the on‑CPU fraction and use it to adjust the pool size; a 0.15 on‑CPU ratio on a 4‑core machine means you need roughly 27 threads to keep the CPU busy. How do you currently estimate your thread‑pool size?
---
# Thread‑pool sizing from first principles

I start every discussion on thread‑pool sizing with a single formula: **Little’s Law**. In the context of a thread pool, the law states that the average number of threads in the pool (L) equals the product of throughput (λ) and the average time a request spends in the pool (W). In symbols, L = λ × W.

This equation gives a clean, quantitative target for the pool size. It tells you *how many* threads you need to keep the system busy without over‑committing resources. The challenge is to estimate λ and W accurately for the workload you are modelling.

## CPU‑bound vs I/O‑bound workloads

A thread that performs heavy CPU calculations will spend most of its time on‑CPU. An I/O‑bound thread, by contrast, will spend a large fraction of its life waiting for external resources (disk, network, database). The two have different implications for the pool size.

| Characteristic | CPU‑bound | I/O‑bound |
|-----------------|----------|-----------|
| On‑CPU time     | high     | low       |
| Off‑CPU time    | low      | high      |
| Context‑switch cost | high | low |
| Ideal thread count | ≈ C (CPU cores) | ≈ C × (1 + R) where R is the I/O‑wait ratio |

The last row comes from a simple queueing‑theory derivation. Suppose a thread spends a fraction *p* of its time on‑CPU and *1‑p* waiting. The average number of threads needed to keep the CPU busy is C / p, where C is the number of physical cores. If *p* = 0.5, you need roughly 2C threads. For an I/O‑bound thread with *p* = 0.1, you need about 10C threads to keep the CPU saturated.

### Estimating the on‑CPU fraction

You can measure *p* by sampling the system with `top` or `htop` and noting the average CPU utilisation when the pool is under load. If utilisation is 60 % on a 4‑core machine, you can infer *p* ≈ 0.15 for the workload. Plugging into the formula gives a target pool size of 4 / 0.15 ≈ 27 threads.

## Applying Little’s Law

Once you have an estimate of λ (requests per second) and W (seconds per request), you can compute L. For a CPU‑bound service that handles 200 req/s and each request takes 0.01 s on‑CPU, W = 0.01 s. L = 200 × 0.01 = 2. That suggests a 2‑thread pool is sufficient. In practice you add a safety margin of 20 % to accommodate bursts and thread‑pool queueing delays.

For an I/O‑bound service that handles 500 req/s and spends 0.5 s waiting, W = 0.5 s. L = 500 × 0.5 = 250. A 250‑thread pool keeps the CPU busy while the threads wait for I/O.

### Queue choice

The queue type affects latency and throughput. A bounded queue protects against runaway thread counts but can cause request rejection. An unbounded queue keeps all requests but may grow indefinitely under pressure.

| Queue type | Behaviour | Suitable for |
|------------|-----------|--------------|
| LinkedBlockingQueue (unbounded) | FIFO, grows | I/O‑bound, low contention |
| ArrayBlockingQueue (bounded) | FIFO, fixed size | CPU‑bound, high contention |
| SynchronousQueue | Direct handoff | High throughput, short tasks |

When you size the pool, you must also size the queue to absorb the burst. A common rule of thumb is to set the queue length to **half the target pool size** for CPU‑bound services and **twice the target pool size** for I/O‑bound services.

## Rejection policies

If the queue is full, the thread pool must decide what to do. Two policies are most common:

1. **AbortPolicy** – throws `RejectedExecutionException` immediately.
2. **CallerRunsPolicy** – runs the task in the caller thread.

Choosing between them depends on the service’s SLA. For a background job processor, `AbortPolicy` is acceptable; for a low‑latency API, `CallerRunsPolicy` can back‑pressure the caller.

### Coordinated omission

When a thread is rejected, the request is lost. If you measure latency without accounting for the rejected requests, you may see a *coordinated omission* bias: the system appears faster because the slowest requests were dropped. To avoid this, instrument the queue to count rejections and include them in the latency histogram.

## Reading a thread dump for BLOCKED and WAITING

A thread dump reveals the state of each thread. Two states are most relevant:

| State | Meaning | Typical cause |
|-------|---------|---------------|
| BLOCKED | Waiting to acquire a monitor (synchronised block) | Lock contention |
| WAITING | Waiting on a monitor or a timed wait | Thread pools using `wait()` or `Condition.await()` |

### Checklist for analysing a dump

1. **Identify the thread pool name** – look for the pool prefix in the thread name.
2. **Count BLOCKED threads** – high counts indicate lock contention.
3. **Count WAITING threads** – high counts may indicate a saturated queue.
4. **Inspect stack traces** – look for repeated methods like `Object.wait` or `ReentrantLock.lock`.
5. **Correlate with metrics** – if CPU utilisation is low but there are many BLOCKED threads, the bottleneck is likely a lock.

| Thread name pattern | What to look for | Suggested fix |
|----------------------|------------------|----------------|
| `pool-1-thread-*` | `Object.wait` or `Condition.await` | Reduce queue size or increase pool size |
| `pool-1-thread-*` | `ReentrantLock.lock` | Refactor to minimise lock scope |
| `pool-1-thread-*` | `Thread.sleep` | Replace with non‑blocking waits |

### Example

Assume a dump shows 30 threads in the state `BLOCKED` on `java.lang.Object.wait`. The stack trace shows `java.util.concurrent.SynchronousQueue$TransferStack.transfer`. This indicates that the pool is saturated and threads are waiting for each other in the queue. The solution is to increase the pool size or switch to a bounded queue with a larger capacity.

## Putting it all together

1. **Measure** λ and W for the workload.
2. **Compute** L = λ × W.
3. **Choose** a queue type and size based on the workload type.
4. **Set** a rejection policy that matches the SLA.
5. **Validate** with a thread dump and metrics.
6. **Iterate** – adjust the pool size and queue length until the target latency and utilisation are met.

### Quick checklist

- [ ] Have you measured on‑CPU and off‑CPU fractions? 
- [ ] Is λ derived from realistic load tests? 
- [ ] Does W include queue waiting time? 
- [ ] Is the queue bounded appropriately? 
- [ ] Have you instrumented rejections? 
- [ ] Do thread dumps show an acceptable number of BLOCKED/WAITING threads? 
- [ ] Are CPU utilisation and context‑switch rates within acceptable limits?

When you follow these steps, you move from guesswork to a principled, data‑driven sizing strategy. The result is a thread pool that scales with the workload, respects system limits, and delivers predictable latency.
