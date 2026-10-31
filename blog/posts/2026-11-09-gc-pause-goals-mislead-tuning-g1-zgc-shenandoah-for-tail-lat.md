---
title: GC pause goals mislead: tuning G1, ZGC, Shenandoah for tail latency
date: 2026-11-09
summary: Learn how to set realistic pause‑time goals for G1, ZGC and Shenandoah, use allocation‑rate tuning, and parse unified GC logs to eliminate tail‑latency surprises.
tags: Performance, GC, Java
linkedin: |
  GC pause goals can mislead you into thinking latency is under control. The real culprit is often an allocation rate that exceeds the collector’s budget. A quick way to keep tail latency in check is to calculate the maximum allocation rate for your chosen pause goal and then adjust the reserve percentage or heap size so the bound is comfortably higher than the observed rate. Have you ever tuned a collector without first measuring allocation rate? What metrics do you rely on to confirm a pause‑time goal is met?
---
## 1. The headline problem
You run a load test that reports p99 latency of 200 ms. In production the same request type spikes to 2 s. The culprit is a GC pause that the test does not see because it runs with a very low allocation rate. The pause‑time goal you set in the JVM is not being honoured by the collector.

## 2. Tail latency, pause‑time goal and allocation rate
*Tail latency* is the 99th‑percentile request time that an end‑user experiences. A *pause‑time goal* is the maximum pause a collector should spend on a safepoint, expressed in milliseconds. The *allocation rate* is the amount of heap bytes allocated per second by the application.

The collector can honour a pause‑time goal only if the allocation rate is below a threshold that depends on the heap size and the reserve percentage. The formula is:

\[\text{alloc\_rate} \le \frac{\text{heap\_size} \times (1-\frac{\text{reserve\%}}{100})}{\text{pause\_goal}}\]

For example, a 4 GB heap with a 10 % reserve and a 200 ms pause goal yields an upper bound of 18 GB/s. If the application allocates 5 GB/s, the collector will exceed the pause goal and tail latency will rise.

## 3. G1 tuning for tail latency
G1 exposes several knobs that influence the pause‑time budget:

| Option | Effect | Typical value |
|--------|--------|---------------|
| -XX:MaxGCPauseMillis | Target pause time in ms | 200 |
| -XX:G1ReservePercent | Heap fraction reserved for allocation | 10 |
| -XX:G1HeapRegionSize | Size of a region | 32 MB |
| -XX:G1NewSizePercent / -XX:G1MaxNewSizePercent | New‑generation size bounds | 10 / 30 |

To keep the pause‑time goal realistic, first calculate the maximum allocation rate using the formula above. Then adjust G1ReservePercent so that the bound is comfortably above the observed allocation rate. If the application spikes to 6 GB/s, you might raise the reserve to 30 %.

### Quick check
Run G1 with:

```
java -XX:+UseG1GC \
     -XX:MaxGCPauseMillis=200 \
     -XX:G1ReservePercent=30 \
     -Xlog:gc*:time,level,tags:file=gc.log,uptime
```

Parse the log for *GC pause* lines and confirm that the 99th percentile pause is below 200 ms.

## 4. ZGC tuning – generational and non‑generational
ZGC is a low‑latency collector that aims for pauses below 10 ms. In JDK 21 it can run in a *generational* mode that keeps a separate young generation.

| Option | Effect | Value |
|--------|--------|-------|
| -XX:+UseZGC | Enable ZGC | — |
| -XX:ZCollectionInterval | Target pause time in ms | 10 |
| -XX:ZUncommitDelay | Delay before freeing unused space | 600 |
| -XX:ZUncommitFreeMemoryThreshold | Threshold for uncommitting | 10 |
| -XX:+ZGenerational | Enable generational mode | — |
| -XX:ZGenRegionSize | Region size for the young gen | 1 MB |

ZGC’s pause budget is not strictly enforced; it is a *goal*. The collector will exceed the goal if the allocation rate is too high. Use the same allocation‑rate calculation to decide whether you need to increase the heap or lower the application throughput.

### Example
A 6 GB heap, 10 % reserve, 10 ms pause goal gives an upper bound of 5.4 GB/s. If the app allocates 4 GB/s, the collector will stay within the goal. If the app spikes to 6 GB/s, you must increase the heap or reduce the reserve.

## 5. Shenandoah tuning
Shenandoah is similar to ZGC but uses a *conservative* mode by default. The key knobs are:

| Option | Effect | Value |
|--------|--------|-------|
| -XX:+UseShenandoahGC | Enable Shenandoah | — |
| -XX:ShenandoahGCMode | Conservative or Aggressive | conservative |
| -XX:ShenandoahGCPercent | Target pause time in % of GC cycle | 10 |
| -XX:ShenandoahGCInterval | Pause interval in ms | 100 |
| -XX:ShenandoahGCThreshold | Threshold for triggering GC | 50 |

Shenandoah’s pause‑time goal is expressed as a percentage of the GC cycle. To convert it to milliseconds, multiply the cycle duration by the percentage. The collector will try to keep the pause below that value.

### Quick check
Run with:

```
java -XX:+UseShenandoahGC \
     -XX:ShenandoahGCMode=conservative \
     -XX:ShenandoahGCPercent=10 \
     -Xlog:gc*:time,level,tags:file=gc.log,uptime
```

Verify that the 99th percentile pause stays below the target.

## 6. Reading unified GC logs
From JDK 9 onwards the unified GC log format is enabled with `-Xlog:gc*`. The log contains a timestamp, log level, tags and a message. Example lines:

```
2026-10-31T12:00:00.123+1000:  0 ms [GC (Allocation Failure)  4096K->2048K(8192K), 1.2345 secs]
2026-10-31T12:00:01.456+1000:  1 ms [GC (System.gc)  2048K->1024K(8192K), 0.0123 secs]
```

To extract pause times you can use:

```
grep -E '\[GC.*secs\]' gc.log | awk '{print $NF}' | tr -d '()'
```

To compute the 99th percentile you can pipe the values into `awk`:

```
awk '{print $1}' pauses.txt | sort -n | awk 'NR==int(NR*0.99)'
```

The log also shows the *allocation rate* if you enable `-Xlog:gc:alloc,uptime`. The line will contain `alloc=...`.

## 7. Checklist for GC tuning to minimise tail latency

| Step | What to do | Why |
|------|------------|-----|
| 1 | Measure real allocation rate | To compare against the pause‑time budget |
| 2 | Choose a collector that matches the latency profile | G1 for moderate latency, ZGC/SH for <10 ms |
| 3 | Compute the maximum allocation rate from the pause goal | To set reserve percentages |
| 4 | Adjust reserve or heap size to keep allocation rate below the bound | Guarantees pause‑time goal |
| 5 | Enable unified GC logs with `-Xlog:gc*` | For post‑mortem analysis |
| 6 | Verify 99th percentile pauses in production | To confirm the goal is met |
| 7 | Monitor for coordinated omission | To avoid under‑reporting of latency |

## 8. Quick comparison table

| Collector | Typical pause‑time goal | Allocation‑rate tolerance | Use case |
|-----------|------------------------|---------------------------|----------|
| G1 | 200 ms | Heap × (1‑reserve%) / pause | Medium‑scale services, predictable traffic |
| ZGC | <10 ms | Very high, but limited by heap size | Services with extreme tail‑latency requirements |
| Shenandoah | <10 ms (conservative) | Similar to ZGC | Services where pause‑time predictability is critical |

## 9. Takeaway
If you set a pause‑time goal but ignore the allocation rate, the collector will exceed the goal and tail latency will explode. The key is to compute the allocation‑rate bound, adjust the reserve or heap accordingly, and validate the 99th‑percentile pause with unified GC logs. This systematic approach removes the mystery behind sudden latency spikes.
