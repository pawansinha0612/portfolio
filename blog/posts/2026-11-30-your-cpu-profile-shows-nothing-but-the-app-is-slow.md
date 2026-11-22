---
title: Your CPU profile shows nothing but the app is slow
date: 2026-11-30
summary: CPU profiles only show on-CPU time. Off-CPU analysis with async-profiler wall mode and eBPF offcputime reveals lock contention, I/O waits and scheduler delays that dominate wall-clock latency.
description: Off-CPU analysis with async-profiler and eBPF to find lock contention, I/O waits and scheduler delays invisible to CPU profilers.
tags: Performance, Profiling, eBPF, Java
linkedin: |
  Your CPU flame graph looks clean but p99 is 800 ms. The threads aren't on CPU — they're parked in futex_wait, blocked on socket reads, or throttled by CFS quota. CPU profilers only sample on-CPU time. Off-CPU analysis with async-profiler wall mode and eBPF offcputime shows the real latency sources: lock contention, synchronous I/O, page faults, scheduler throttling. One concrete takeaway: run async-profiler with `--event wall`, diff it against the CPU profile, then use `offcputime -m 1000` on the top discrepancies to get exact wait distributions with kernel stacks. What off-CPU pattern bites your team most often?
---
Your load test reports p99 latency of 800 ms. The CPU flame graph shows 95 percent of samples in `java.util.concurrent.ThreadPoolExecutor.runWorker` and a few percent in JSON serialisation. Nothing looks hot. You add more threads. Latency gets worse. The CPU profile still shows nothing useful because the threads are not on CPU — they are parked, blocked or waiting for I/O.

CPU profiling samples the program counter at a fixed interval, typically 100 to 1000 Hz, but only when the thread is actually running on a logical processor. Time spent in `park`, `sleep`, `wait`, synchronous I/O system calls or the kernel scheduler run queue is invisible. This is off-CPU time. In latency-sensitive services off-CPU time often exceeds on-CPU time by an order of magnitude. A thread that burns 2 ms of CPU but waits 200 ms for a database connection looks idle to a CPU profiler. The fix is not algorithmic optimisation. It is reducing the wait.

## On-CPU vs off-CPU flame graphs

An on-CPU flame graph aggregates stack traces sampled while the thread is executing instructions. The x-axis is population not time. Wide frames mean the code was on-CPU often. An off-CPU flame graph aggregates stack traces captured when the thread transitions off the CPU. The x-axis is still population but the y-axis shows the kernel stack that put the thread to sleep. The two graphs answer different questions. On-CPU asks "what code burns cycles?" Off-CPU asks "what code causes the thread to wait?"

A common pattern: the on-CPU graph shows a thin tower in `SocketInputStream.read`. The off-CPU graph shows a wide tower in `epoll_wait` -> `tcp_recvmsg` -> `inet_wait_for_connect`. The application is not slow because `read` is expensive. It is slow because the network round trip or the connection pool exhaustion keeps the thread in `epoll_wait` for hundreds of milliseconds. You would never see that in the on-CPU graph.

## async-profiler wall mode

async-profiler 2.9 and later supports `--event wall` which samples wall-clock time instead of CPU cycles. It uses the Linux `perf_event_open` `PERF_TYPE_SOFTWARE` `PERF_COUNT_SW_CPU_CLOCK` event. This timer fires regardless of whether the thread is on-CPU or off-CPU. The resulting flame graph merges on-CPU and off-CPU stacks into a single view. Frames that appear only in wall mode but not in CPU mode are your off-CPU suspects.

Run it like this:

```bash
./profiler.sh -e wall -f wall.html -d 60 <pid>
```

The `-d 60` samples for 60 seconds. Open `wall.html` and compare with a CPU profile of the same workload. Look for frames that are wide in wall but narrow or absent in CPU. Typical candidates:

- `java.lang.Thread.sleep` or `parkNanos` — deliberate backoff or rate limiting
- `java.net.SocketInputStream.socketRead0` — synchronous socket read
- `java.io.FileInputStream.readBytes` — blocking file I/O
- `sun.misc.Unsafe.park` — `LockSupport.park` from `ReentrantLock`, `CountDownLatch`, `CompletableFuture.join`

Wall mode has a blind spot. It still samples at a fixed frequency. If a thread sleeps for 500 ms and the sample interval is 10 ms you get roughly 50 samples in that sleep. That is fine. But if the thread wakes, does 50 µs of work, and sleeps again, the sampler may miss the on-CPU burst entirely. This is coordinated omission in profiling form. The wall-clock profile over-represents the sleep and under-represents the work. For latency distributions you still need a dedicated latency recorder.

## eBPF offcputime

When you need kernel-level visibility without modifying the JVM, eBPF `offcputime` is the tool. It traces the `sched:sched_switch` tracepoint. Every context switch records the previous thread's stack (user and kernel), the next thread's pid, and the time the previous thread spent off-CPU. The result is a histogram of off-CPU time grouped by kernel stack.

The BCC version:

```bash
/usr/share/bcc/tools/offcputime.py -p <pid> -f 60 > offcpu.txt
```

The `-f` flag folds kernel stacks. The output is a folded stack format compatible with `flamegraph.pl`. Each line ends with the off-CPU time in microseconds. A typical line:

```
java_thread;pthread_cond_wait;futex_wait_queue_me;futex_wait;schedule;__schedule;do_schedule;pick_next_task;pick_next_task_fair;entity_tick;update_curr 125000
```

This thread spent 125 ms off-CPU in a futex wait. The kernel stack shows `futex_wait_queue_me` -> `schedule` -> CFS pick next task. The user stack (if you add `-k` and `-u`) will show the Java frame that called `park`.

`offcputime` captures every off-CPU event, not a sample. It does not suffer from coordinated omission. The cost is overhead. On a busy 64-core box tracing every context switch for a high-throughput service can add 5 to 15 percent CPU overhead. Use `-m` to set a minimum off-CPU threshold in microseconds. `-m 1000` ignores waits shorter than 1 ms. This reduces overhead and filters noise.

## Lock contention that CPU profiles hide

`ReentrantLock.lock` calls `LockSupport.park` which ends up in `pthread_cond_wait` -> `futex_wait`. The thread is descheduled. A CPU profiler sees zero samples in `lock`. The off-CPU flame graph shows a wide tower in `park` -> `futex_wait`. The fix is not a faster lock. It is reducing the critical section, sharding the lock, or replacing it with a lock-free structure.

A worked example. Say a service processes 10,000 requests per second. Each request acquires a global `ReentrantLock` for a cache update. The critical section takes 5 µs on-CPU. With 200 threads the lock acquisition rate is 10,000 per second. The average queue length for an M/M/1 queue is `ρ / (1 - ρ)` where `ρ = λ * S`. Here `λ = 10,000/s` and `S = 5 µs` so `ρ = 0.05`. Average queue length is `0.05 / 0.95 ≈ 0.053`. Average wait is `ρ * S / (1 - ρ) ≈ 0.26 µs`. Negligible.

Now add a slow downstream call inside the critical section. `S` becomes 500 µs. `ρ = 5`. The system is unstable. The queue grows without bound. Threads park for seconds. The CPU profile still shows 5 µs in the lock method. The off-CPU profile shows seconds in `futex_wait`. The fix: move the downstream call out of the critical section.

## I/O waits and the page cache

Synchronous `FileChannel.read` or `SocketInputStream.read` blocks in the kernel. The thread enters `vfs_read` -> `generic_file_read_iter` -> `filemap_fault` -> `handle_mm_fault` if the page is not in the page cache. A major fault can take 10 to 50 ms on NVMe, 100+ ms on network storage. The CPU profile shows nothing. The off-CPU graph shows `page_fault` -> `blk_mq_start_request` -> `scsi_queue_rq`.

Async I/O with `io_uring` or `CompletableFuture` backed by `AsynchronousFileChannel` keeps the thread on-CPU while the kernel processes the request. The off-CPU time shifts from the application thread to the kernel I/O completion path. You still see the latency in wall-clock profiles but the application thread is not parked. This is why async I/O improves throughput under load even when single-request latency is unchanged.

## Scheduler latency and CFS quota

In Kubernetes, CPU limits map to CFS quota. A container with `cpu: 500m` gets 50 ms of runtime per 100 ms period. When the quota is exhausted the kernel throttles the cgroup. Threads are forced off-CPU even if cores are idle. The off-CPU stack shows `throttle_cfs_rq` -> `distribute_cfs_runtime` -> `schedule`. The thread can sit in the throttled state for the remainder of the period.

`offcputime` with `-m 1000` will show these throttling events as multi-millisecond off-CPU waits. The fix is either raise the limit, remove the limit, or tune `cpu.cfs_period_us` (default 100 ms) to a smaller value so throttling intervals are shorter. Note that smaller periods increase scheduler overhead.

## Correlating the views

No single view tells the whole story. The workflow:

1. Run async-profiler CPU mode for 60 seconds. Identify hot on-CPU paths.
2. Run async-profiler wall mode for the same workload. Diff the two. Wide frames only in wall are off-CPU candidates.
3. For the top candidates, run `offcputime -p <pid> -m 1000 -f 30` to get exact off-CPU time distributions and kernel stacks.
4. Match kernel stacks to user stacks. `offcputime -k -u` does this but increases overhead. Alternatively, note the thread IDs from `offcputime` output and grep the async-profiler wall output for those threads.
5. Classify each off-CPU bucket: lock contention, synchronous I/O, page fault, scheduler throttle, explicit sleep, condition wait.
6. Apply the fix for the largest bucket. Re-measure.

## Checklist for your next investigation

- [ ] Capture CPU and wall profiles for the same steady-state load
- [ ] Diff the flame graphs — flag frames present in wall but not CPU
- [ ] Run `offcputime` with a 1 ms threshold on the top 3 flagged frames
- [ ] Classify each off-CPU bucket by kernel stack
- [ ] For lock buckets: measure critical section time, calculate ρ, decide shard or remove
- [ ] For I/O buckets: check page cache hit rate, consider async I/O or larger read-ahead
- [ ] For throttle buckets: review CFS quota, period, and whether limit is necessary
- [ ] For sleep buckets: verify backoff strategy, replace with async completion where possible
- [ ] After each fix, re-run wall profile to confirm off-CPU time decreased

The CPU profile is a map of where the program burns cycles. The off-CPU profile is a map of where the program loses time. In latency-critical systems the second map is usually the one that matters.
