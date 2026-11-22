---
title: Your JVM profiler is lying about where time goes
date: 2026-12-04
summary: Safepoint bias makes sampling profilers miss the hottest code. Understand why async-profiler and JFR see what others miss, and how to read flame graphs without being misled.
description: Safepoint bias in JVM profilers: why sampling at safepoints distorts hot spots and how async-profiler and JFR avoid it.
tags: Performance, JVM, Profiling, Java
linkedin: |
  Your CPU profiler shows HashMap.get at 60%. You optimise it. Latency doesn't budge. The profiler wasn't wrong — it was biased. Safepoint samplers (VisualVM, YourKit default, JProfiler default) only catch threads at JVM safepoints. Tight loops, inlined code, and native sections often run without polls. They become invisible. async-profiler and JFR use AsyncGetCallTrace to sample running threads without stopping them. They see the real hot spots. Next time a flame graph looks suspicious, run async-profiler side by side. If the top frames flip, you had safepoint bias. What's the most misleading profile you've ever trusted?
---
Your load test shows p99 latency at 800 ms. The profiler flame graph says 60 percent of samples are in `java.util.HashMap.get`. You optimise the map access. The p99 barely moves. The profiler was not wrong about the samples it collected. It was wrong about the samples it never took.

Safepoint bias is the systematic distortion that occurs when a profiler only samples threads at JVM safepoints. A safepoint is a point in the execution where the JVM can safely pause all threads for garbage collection, deoptimisation or stack walking. Threads reach safepoints at method exits, loop backedges and explicit safepoint polls. Code that runs for a long time between safepoints — tight loops, native calls, heavy computation — is under-sampled. Code that hits safepoints frequently — allocation-heavy code, synchronized blocks, park calls — is over-sampled.

The bias has a name in queueing theory: length-biased sampling. If a thread spends 100 ms in a tight loop and 1 ms at a safepoint, a safepoint sampler sees the 1 ms window 100 times more often per unit of real time than the loop. The profiler reports the safepoint-heavy code as hot. The loop disappears.

## How the JVM reaches a safepoint

The JVM uses a cooperative mechanism. Each thread polls a global safepoint flag at designated locations. When a safepoint is requested (for GC, profiling, revocation), the VM sets the flag and waits for every thread to acknowledge. The time from request to last acknowledgement is Time To Safepoint (TTSP). Long TTSP pauses are a separate problem. For profiling, the key is that the sampler only sees stack traces when threads are at those polls.

Typical safepoint poll locations:
- Method exit (return bytecode)
- Loop backedges (counted loops have a poll; uncounted may not)
- Before `monitorenter` and after `monitorexit`
- Explicit polls inserted by JIT for long-running compiled code
- JNI entry and exit
- `Thread.sleep`, `Object.wait`, `LockSupport.park`

Code that avoids these locations runs invisible to a safepoint sampler. A tight `while (true) { compute(); }` with no allocation and no method calls may never hit a poll if the JIT compiles it as an uncounted loop. The thread appears stuck in the last visible frame — often the caller or a runtime stub.

## Safepoint-biased profilers vs async-profiler vs JFR

VisualVM, YourKit (default), JProfiler (default) and the built-in `jstack` sampler all use the JVM TI `GetStackTrace` function. That function requires the target thread to be at a safepoint. The profiler requests a safepoint, waits for all threads, walks stacks, resumes. The overhead is proportional to TTSP and the number of threads. The bias is inherent.

async-profiler uses `AsyncGetCallTrace`, an internal HotSpot API that walks the stack of a running thread without stopping it. It installs a signal handler (SIGPROF on Linux, `CreateTimerQueueTimer` on Windows) that fires at a configurable interval. The handler calls `AsyncGetCallTrace` on the interrupted thread. No safepoint request. No TTSP. The sample reflects the actual program counter at that instant.

JDK Flight Recorder (JFR) uses a similar mechanism. Since JDK 11, JFR's execution sample event is collected by the same async mechanism. Earlier versions used a mix of safepoint and async sampling depending on configuration. Modern JFR is effectively unbiased for CPU profiling.

The practical difference appears in the flame graph. A safepoint-biased profile of a CPU-bound service shows wide frames for `Thread.sleep`, `LockSupport.park`, `java.util.concurrent.locks.AbstractQueuedSynchronizer.acquire` and allocation sites. The actual compute frames are thin or missing. An async-profiler or JFR profile of the same run shows the compute frames dominating.

## Detecting safepoint bias in your data

Compare two profiles of the same workload: one from a safepoint sampler, one from async-profiler. If the top frames differ significantly, bias is present. A faster check: look for `Thread.sleep`, `park`, `wait` or `Safepoint` frames consuming large percentages in a CPU-bound workload. Those frames are over-represented.

Another signal: the profiler reports high CPU usage in `java.lang.Thread.sleep` or `j.l.Object.wait`. Those methods do not consume CPU. The sampler caught the thread at the safepoint poll inside the sleep implementation. The real CPU work happened between polls and was missed.

You can also measure TTSP directly with `-XX:+PrintSafepointStatistics -XX:PrintSafepointStatisticsCount=1`. Long TTSP correlates with bias severity because the profiler's own safepoint requests perturb the system and because threads that take long to reach a safepoint are the ones doing uninterruptible work.

## Reading a flame graph correctly

A flame graph aggregates stack traces. Width represents sample count. In an unbiased profile, width is proportional to CPU time per frame. In a biased profile, width is proportional to (CPU time × safepoint frequency in that frame).

Rules for reading any flame graph:
1. The bottom frame is the thread entry point. The top frames are leaf functions. Follow the widest path from bottom to top to find the hottest code path.
2. Frame width includes all descendants. A wide parent with narrow children means the parent itself does work. A wide parent with one wide child means the child is the hot spot.
3. Grey or hashed frames often indicate kernel or native code. In async-profiler, use `--lib` to resolve native symbols.
4. Missing frames: if a known hot function does not appear, the profiler likely could not sample it. This is common for inlined methods (use `--inline` in async-profiler) and for code compiled without safepoint polls.
5. Compare profiles at the same load level. A profile at 10 percent utilisation has different safepoint dynamics than one at 90 percent.

## Worked example

Imagine a service that processes messages in a loop:

```java
while (running) {
    Message msg = queue.poll();
    if (msg != null) {
        process(msg); // heavy CPU, no allocation
    } else {
        LockSupport.parkNanos(1_000_000);
    }
}
```

`process` runs a tight numeric loop for 5 ms per message. `parkNanos` sleeps 1 ms. The loop runs 83 percent of wall time. The park runs 17 percent.

A safepoint sampler at 100 Hz requests a safepoint every 10 ms. The thread hits a poll at the loop backedge (if counted) or at the `park` call. Assume the JIT emits a poll at the backedge. The thread spends 5 ms in the loop, hits the poll, then parks for 1 ms. The sampler catches it at the poll 5 times per 6 ms cycle. It catches it in `park` once per cycle. The profile shows 83 percent in the loop frame, 17 percent in `park`. That looks correct.

Now remove the backedge poll. The JIT compiles the loop as uncounted. The thread runs 5 ms with no poll. It only hits a poll at the `park` call. The sampler requests a safepoint every 10 ms. The thread is in the loop for 5 ms, then parks for 1 ms, then loops again. The sampler catches it only during the 1 ms park window. The profile shows 100 percent in `park`. The 5 ms loop is invisible. The bias factor is 5x in this direction.

In reality, the JVM inserts polls at method exits. If `process` is a separate method, the poll at its return catches the thread. But if `process` is inlined into the loop, the poll disappears. Inlining is aggressive in HotSpot. The bias is real and common.

async-profiler at 100 Hz fires a signal every 10 ms regardless of polls. It samples the program counter directly. Over 6 ms cycles, it hits the loop 5 times and the park once. The flame graph matches reality.

## Choosing and configuring your profiler

Default to async-profiler for CPU profiling. Use JFR for production continuous profiling. Reserve safepoint samplers for heap allocation profiling (where allocation sites are safepoints anyway) or when you cannot attach native agents.

async-profiler command for a 60 second CPU profile at 1000 Hz:

```bash
./profiler.sh -d 60 -e cpu -f profile.html -o flamegraph <pid>
```

Key options:
- `-e cpu` uses `AsyncGetCallTrace`. `-e alloc` uses TLAB allocation events (unbiased).
- `-f profile.html` writes a collapsible flame graph. Use `-o collapsed` for Brendan Gregg's format.
- `--lib /path/to/lib.so` resolves native frames.
- `--inline` attempts to show inlined frames (experimental).

JFR recording for CPU:

```bash
jcmd <pid> JFR.start name=cpuprofile settings=profile duration=60s filename=cpu.jfr
```

Open the `.jfr` in JDK Mission Control or `jfr print --events jdk.ExecutionSample cpu.jfr`.

Checklist before you trust a profile:
- [ ] Profiler uses async sampling (async-profiler, JFR, perf with Java agent)
- [ ] Flame graph shows expected compute frames, not only park/sleep
- [ ] Native frames resolved if JNI or system calls are involved
- [ ] Profile duration covers at least 100x the target latency percentile window
- [ ] Load level matches production (bias changes with utilisation)
- [ ] Compare two profilers on the same run if results drive decisions

## When safepoint sampling is acceptable

Allocation profiling: every allocation is a safepoint poll in modern HotSpot. Safepoint samplers see allocation sites accurately. VisualVM and YourKit allocation views are reliable.

Thread state analysis: if you need to know why threads are blocked, safepoint samplers show monitor and park stacks correctly because those states are safepoints.

Low-overhead attachment: async-profiler requires a native agent. In some locked-down environments you cannot load it. JFR is built-in but adds overhead. A safepoint sampler via JMX may be the only option. In that case, treat CPU profiles as qualitative only.

## The trap of optimising the visible

Teams optimise what the profiler highlights. If the profiler highlights `HashMap.get` because the map is accessed right before a safepoint poll, you shrink the map. The real bottleneck — a tight loop in a math library with no polls — keeps burning CPU. Latency does not improve. You declare the profiler useless and reach for logs or metrics.

The profiler is not useless. It is biased. Understand the bias, choose the right tool, and read the flame graph with the sampling mechanism in mind. The hottest code is often the code that never stops long enough to be sampled.
