---
title: Every GC pause met the goal. p99.9 still failed.
date: 2026-11-09
summary: A pause-time goal says how long each pause may be, not how many requests it hits. How allocation rate and eden size set pause frequency, what really drives G1, ZGC and Shenandoah tail latency, and how to prove it from unified GC logs.
description: A GC pause goal limits pause length, not how many requests a pause hits. How allocation rate drives G1, ZGC and Shenandoah tail latency.
tags: Performance, Java, GC, Latency
repost: Every GC pause met its goal, so why is p99.9 still red?
linkedin: |
  Every G1 pause is under the 200 ms goal. The p99.9 SLO is still red.

  A pause goal limits how long each pause is. It says nothing about how often pauses happen or how many requests they land on.

  The arithmetic is short. Young GCs per second = allocation rate ÷ eden size. Share of requests that overlap a pause ≈ GCs per second × (pause + request duration). At 1 GB/s of allocation, 1 GB of eden, 25 ms pauses and 40 ms requests, that is about 6.5% of requests. GC owns your p95, never mind p99.9.

  Lowering MaxGCPauseMillis can make it worse, because G1 meets a tighter goal by shrinking the young generation and pausing more often.

  The article has an interactive calculator, plus the unified logging command and a pipeline to get pause percentiles from your own GC log.

  What does your team alert on: pause length, or time paused per minute?

  #Java #PerformanceEngineering #Latency
---
Your G1 dashboard is green. The longest pause this week was 140 ms, comfortably inside the 200 ms goal. Median latency is 15 ms.

Then the p99.9 SLO breaches again, and the slow requests line up with GC events. Someone drops `MaxGCPauseMillis` to 50. The tail gets worse.

The pause goal was never the right number to watch. It limits how long each pause is. Tail latency depends on how many requests a pause lands on.

## The number that matters: how often requests meet a pause

A request is hurt by GC if a stop-the-world pause starts while it is in flight, or if it arrives during one. With pause frequency f, pause length p and request duration d, the share of requests that overlap a pause is roughly:

**overlap ≈ f × (p + d)**

This holds while the result is small.

For example: 1 young GC per second, 25 ms pauses and 40 ms requests. Overlap ≈ 1 × (0.025 + 0.040) = **6.5% of requests**. GC time is only 2.5% of wall-clock time, which looks harmless on a throughput dashboard. Yet GC sits inside your p95, so it certainly defines p99 and p99.9. Every pause met the goal.

## What sets frequency, and what sets length

**Frequency** is mostly allocation rate divided by eden size. Eden is the part of the young generation where new objects are allocated. At 1 GB/s into a 1 GB eden, you get roughly one young GC per second.

**Length** is mostly driven by live data, not garbage. A young collection copies surviving objects and scans roots (thread stacks and, in G1, remembered sets that track old-to-young references). Dead objects cost almost nothing to reclaim. That follows from the weak generational hypothesis: most objects die young.

In a request-driven service, survivors are largely the data of requests in flight at that moment. That volume barely changes with eden size. So a larger eden usually means fewer pauses of roughly the same length, and fewer requests hit.

Here is the trap with G1. It meets `MaxGCPauseMillis` mainly by resizing the young generation. A tighter goal means a smaller eden, which means more frequent pauses. Each pause gets shorter, but the overlap share can go up.

Try your own numbers:

<div class="widget" data-widget="gc"><p><em>Interactive calculator: open this post on pawansinha.com.au to try it with your own numbers.</em></p></div>

## G1: what the flags actually do

- `-XX:MaxGCPauseMillis` (default 200) is a soft goal. G1 predicts pause cost from history and sizes the young generation and mixed-collection work to fit. It is not a guarantee.
- Fixing the young generation with `-Xmn` or `-XX:NewSize`/`-XX:MaxNewSize` largely switches off that pause-driven sizing. Do it only if you have measured why.
- `-XX:G1ReservePercent` (default 10) keeps part of the heap free as to-space so evacuation has somewhere to copy objects. Raising it lowers the risk of evacuation failure, which produces long pauses. It does not make the pause goal more likely to be met.
- `-XX:G1HeapRegionSize` is chosen ergonomically from heap size. Objects of half a region or more are humongous and are allocated directly in old regions. Raise it only if logs show heavy humongous allocation.

The best G1 fixes are usually upstream of flags: allocate less per request, and give the heap room.

## ZGC: pauses are tiny, the risk moves

ZGC does marking and relocation concurrently with the application. Its pauses are typically well under a millisecond and do not grow with heap or live-set size.

Version matters. Generational ZGC is opt-in with `-XX:+UseZGC -XX:+ZGenerational` in JDK 21, the default mode from JDK 23, and the only mode from JDK 24, where non-generational ZGC was removed. On JDK 17, ZGC is non-generational.

With pauses this short, the tail risk is the **allocation stall**: allocation outpaces the concurrent cycle, the heap fills, and application threads block until memory is freed. The GC log shows `Allocation Stall` lines with the thread and duration.

The main lever is headroom. Set `-Xmx` so the concurrent cycle finishes before the heap fills. `-XX:SoftMaxHeapSize` asks ZGC to try to stay below a lower limit, while keeping `-Xmx` as burst room. Note that `-XX:ZCollectionInterval` is not a pause target. It forces a collection every N seconds.

## Shenandoah: same idea, different failure path

Shenandoah is also concurrent, with pauses typically in the low milliseconds or below. It ships in OpenJDK builds such as Temurin, Corretto and Red Hat's, but not in Oracle JDK.

The real knobs are `-XX:ShenandoahGCHeuristics` (`adaptive` by default, with `static`, `compact` and `aggressive` as alternatives) and `-XX:ShenandoahGCMode` (`satb` by default). A generational mode exists in recent JDKs, so check your release notes before relying on it.

When allocation outruns a concurrent cycle, Shenandoah falls back to a degenerated GC, which finishes the cycle stop-the-world, and in the worst case to a full GC. Both appear in the log as pauses. If you see them, add heap headroom or reduce allocation before touching heuristics.

## Comparison

| Collector | Typical pause | Main tail-latency risk | Cost |
|-----------|---------------|------------------------|------|
| G1 | Tens of ms per young or mixed pause | Pause frequency × length, evacuation failure | Lowest CPU overhead of the three in most services |
| ZGC | Well under 1 ms | Allocation stalls when heap headroom runs out | Concurrent threads take CPU, needs memory headroom |
| Shenandoah | Low ms or below | Degenerated and full GCs under allocation pressure | Concurrent threads take CPU, needs memory headroom |

My default: G1 when p99 targets are in the hundreds of milliseconds and CPU is tight. ZGC when p99.9 matters at tens of milliseconds and you can spare CPU and memory.

## Measure it, don't guess

Enable unified logging (JDK 9 and later) with GC and safepoint tags:

```bash
java -Xlog:gc*,safepoint:file=gc.log:time,uptime,level,tags -jar app.jar
```

A G1 pause line looks like this:

```
[2026-11-09T10:15:30.123+1100][12.345s][info][gc          ] GC(42) Pause Young (Normal) (G1 Evacuation Pause) 512M->128M(2048M) 8.123ms
```

Pause count, total, p50, p99 and max (nearest-rank percentiles):

```bash
grep -E '\] GC\([0-9]+\) Pause .*[0-9.]+ms$' gc.log \
  | sed -E 's/.* ([0-9.]+)ms$/\1/' \
  | sort -n \
  | awk '{ v[NR] = $1; sum += $1 }
         END { i = int(NR * 0.99); if (i < NR * 0.99) i++
               printf "pauses=%d total=%.1fms p50=%s p99=%s max=%s\n", NR, sum, v[int((NR + 1) / 2)], v[i], v[NR] }'
```

Divide the total by the log's time span to get the paused fraction. A GC log analyser gives the same with charts.

**Allocation rate** is not in a dedicated log line. Estimate it from the log: heap before this GC minus heap after the previous one, divided by the time between them. Or record with JFR and read `jdk.ObjectAllocationSample` and `jdk.GCHeapSummary` events.

**Safepoints beyond GC.** A safepoint is a point where all application threads are stopped so the JVM can do work that needs a consistent view. GC is only one reason. Other VM operations, such as class redefinition and thread dumps, also use them. `-Xlog:safepoint` reports each operation, including time-to-safepoint: how long the JVM waited for the last thread to reach a stop point. A long time-to-safepoint stalls every thread that already stopped, and it does not show up as GC time.

## Checklist

1. Compute overlap ≈ pauses per second × (pause + request duration). If it exceeds 0.1%, GC is in your p99.9.
2. Alert on paused time per minute and pause count, not just max pause.
3. On G1, reduce frequency with heap room and less allocation before lowering the pause goal.
4. On ZGC and Shenandoah, watch for allocation stalls and degenerated or full GCs, and buy headroom with heap size.
5. Log safepoints as well as GC, and check time-to-safepoint.
6. Correlate slow requests with pause timestamps before you change a single flag.
