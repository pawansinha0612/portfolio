---
title: Your iostat says fine but writes stall for 500 ms
date: 2026-11-13
summary: Discover how await, %util and queue depth hide disk bottlenecks, why fsync is expensive, and how cloud burst credits can mislead performance tests.
tags: Performance, Disk I/O, Cloud Storage
linkedin: |
  Your load test says 5 ms p99 for writes but users see 500 ms stalls. The culprit is often hidden in disk I/O metrics like await, %util and queue depth. A simple iostat run can reveal a saturated SSD or a backlog that your test didn’t hit. A concrete takeaway: check %util > 80 % and await > 10 ms before you scale. What other metrics do you monitor to catch I/O bottlenecks early?
---
## The hidden cost of disk latency
You run a load test that reports 5 ms p99 for database writes. In production a user reports a 500 ms stall when inserting a record. The discrepancy is not in the application code but in the storage layer. Your test harness is not exercising the same I/O path as production, and iostat tells you the truth if you read it correctly.

## iostat fundamentals
iostat reports three key metrics: **await**, **%util** and **queue depth**.

* **await** is the average time a request spends in the queue and on the device. It includes queue latency and service time.
* **%util** is the percentage of time the device is busy handling requests. When it approaches 100 % the device is saturated.
* **queue depth** is the average number of requests waiting for service.

A device with 10 ms service time and a queue depth of 5 will have an average latency of 50 ms, even if the device is only 30 % utilised.

## Queueing theory in practice
Queueing theory gives a simple relationship: **L = λW** (Little’s Law). Here, *L* is the average queue depth, *λ* is the arrival rate (IOPS), and *W* is the average waiting time.

For example, a 100 GB SSD receives 200 IOPS with a service time of 5 ms. The arrival rate is 200 IOPS, the service time is 0.005 s, so the utilisation is 200 × 0.005 = 1 = 100 %. The queue depth will grow indefinitely, and the average wait will be unbounded. In a real system you will see %util close to 100 % and await rising.

## Detecting bottlenecks
Run iostat with the **-x** flag to get extended statistics:

```bash
iostat -dx 1 5
```

Look for:

* **await** > 10 ms on a high‑throughput device.
* **%util** > 80 %.
* **queue depth** > 2.

If any of these thresholds are exceeded, the device is a candidate bottleneck.

## fsync cost
A **fsync** forces the OS to flush dirty pages to disk. Each call can cost 5–10 ms on a spinning disk and 1–3 ms on an SSD. If your workload performs 1,000 fsyncs per second, the cumulative cost is 5–10 s of wall‑clock time per second – effectively 500–1000 % utilisation. The OS may schedule these flushes during idle periods, but if the application issues them synchronously, the thread is blocked.

To quantify:

```
fsync_time = fsync_calls × avg_fsync_latency
```

With 1,000 calls and 8 ms latency, fsync_time = 8 s.

## Cloud volume burst credits
Public clouds offer burstable volumes. Two common types are **gp2** and **gp3** on AWS.

| Volume | Baseline IOPS | Max IOPS | Burst credits | Credit accumulation |
|--------|---------------|----------|---------------|---------------------|
| gp2   | 3 IOPS per GiB | 10,000   | 3 IOPS per GiB | 1 credit per IOPS per second |
| gp3   | 3000 IOPS     | 10,000   | None          | None                |

A 100 GiB gp2 volume has a baseline of 300 IOPS. If it performs 5,000 IOPS for 10 seconds, it consumes 40,000 credits, exhausting the baseline and causing throttling. gp3 eliminates this problem by providing a fixed baseline.

## Fixing the problem
1. **Match test I/O to production** – use the same volume type and size.
2. **Avoid unnecessary fsyncs** – batch writes or use asynchronous flush.
3. **Tune queue depth** – increase the device queue depth if the kernel allows it.
4. **Use burst‑capable volumes** – switch to gp3 or a provisioned IOPS volume if burst behaviour is required.
5. **Monitor continuously** – set up alerts on await > 15 ms, %util > 90 % and queue depth > 3.

## Checklist: Disk I/O bottleneck detection
| Step | What to check | Why it matters |
|------|---------------|----------------|
| 1 | iostat -dx | Gives await, %util, queue depth |
| 2 | %util > 80 % | Device is saturated |
| 3 | await > 10 ms | Latency is high |
| 4 | queue depth > 2 | Backlog exists |
| 5 | fsync calls per second | Estimate cumulative cost |
| 6 | Cloud credit utilisation | Detect burst exhaustion |
| 7 | Compare test vs production | Ensure realistic I/O patterns |

If all metrics are within limits, the storage layer is healthy. If any metric exceeds its threshold, investigate the corresponding layer before scaling the application.
