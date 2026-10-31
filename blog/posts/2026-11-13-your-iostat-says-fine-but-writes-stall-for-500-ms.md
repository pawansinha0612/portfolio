---
title: Your iostat says fine but writes stall for 500 ms
date: 2026-11-13
summary: Why %util lies on SSDs and cloud volumes, how to read await and aqu-sz with Little's Law, why per-second averages hide stalls, what fsync and writeback really cost, and how gp2 burst credits make short load tests pass.
tags: Performance, Disk I/O, AWS
highlight: 500 ms
linkedin: |
  iostat shows 100% util and 2 ms write latency. The disk is fine. An hour later, commits stall for half a second.

  On SSDs and cloud volumes, %util only means at least one I/O was in flight. A device that serves dozens of requests in parallel can show 100% and still have plenty of headroom.

  The real stalls hide elsewhere. One-second averages swallow a 500 ms pause. Dirty-page writeback blocks writers when it hits its threshold. And a 100 GiB gp2 volume bursts to 3,000 IOPS for about 33 minutes from a full bucket, then drops to 300.

  A 20-minute load test on that volume proves nothing.

  The article has an interactive calculator: see when your gp2 credits run out.

  How long are your storage load tests, and do they run long enough to drain the credits?

  #PerformanceEngineering #AWS #SRE
---
Your load test reports 4 ms p99 for database commits. `iostat` agrees: write latency around 2 ms, nothing alarming. Two hours into the business day, commits start stalling for 500 ms at a time, and the same `iostat` still shows a 2 ms average.

Nothing is lying exactly. You are reading averages from a tool designed for spinning disks, on a cloud volume that changed speed mid-morning.

## Read the right columns

Use `iostat -xz 1` (extended statistics, skip idle devices, one-second intervals). In current sysstat the columns that matter are:

- `r/s`, `w/s`: completed reads and writes per second.
- `rkB/s`, `wkB/s`: throughput.
- `r_await`, `w_await`: average time per I/O in milliseconds, **including time queued** in the block layer, not just time on the device.
- `aqu-sz`: average number of requests queued or in service (called `avgqu-sz` in older versions).
- `%util`: the share of the interval during which at least one request was in flight.

Ignore `svctm` on older systems. It was an unreliable derived estimate, and recent sysstat releases have removed it.

## Why %util lies on SSDs and cloud volumes

`%util` made sense for a disk serving one request at a time. An NVMe drive, a RAID set or an EBS volume serves many concurrently, and `%util` only counts time with *at least one* request outstanding. A device with one request permanently in flight shows 100%, and so does the same device with 30 in flight. It says nothing about how much parallel capacity remains.

So 100% util on an NVMe drive is a prompt to look further, not a diagnosis. Saturation shows up as rising `await` at flat or falling throughput, a growing `aqu-sz`, or hitting a known limit such as provisioned IOPS.

## Little's Law ties the columns together

Little's Law says the average number of items in a system equals arrival rate times average time in the system: L = λW. For a block device, that gives:

**aqu-sz ≈ (r/s × r_await + w/s × w_await) / 1000** (await in ms)

For example, a volume doing 1,500 writes per second with `w_await` of 20 ms holds 1,500 × 0.020 = **30 requests** on average. If 1,500 IOPS is the volume's limit, extra load cannot raise throughput. It only lengthens the queue, and `await` rises with it.

## Averages hide stalls

`iostat` reports means over the interval. Imagine 1,000 writes in one second, 990 of them at 1 ms and 10 of them stuck behind a 500 ms flush. The mean is about 6 ms. Nothing looks wrong, yet ten commits waited half a second.

To see the distribution, trace individual I/Os:

- `biolatency` (bcc and bpftrace): a histogram of block I/O latency. Look at the tail buckets, not the mode.
- `biosnoop`: one line per I/O with process, sector, size and latency, so you can see *who* waited and when.
- `blktrace` with `btt`: heavier, with detail on where time goes inside the block layer.

If the application's commit p99 spikes line up with the `biolatency` tail, the disk is involved. If they do not, the wait is above the block layer: locks, the filesystem or the page cache.

## What fsync really costs

`fsync` returns only when the file's data and metadata are durable. Its cost depends heavily on the device. Enterprise SSDs with power-loss protection can acknowledge a flush from protected cache very quickly. Consumer SSDs and network cloud volumes can be far slower. Measure it on your hardware with `fio --fsync=1` rather than trusting a rule of thumb.

Do not multiply fsync count by fsync latency to get utilisation. Flushes from different threads run concurrently, and databases use **group commit**: one WAL flush makes durable every commit written to the log before it. A thousand commits per second rarely means a thousand flushes per second. PostgreSQL can widen the batch with `commit_delay`, a wait in microseconds (default 0) before the flush, applied only when at least `commit_siblings` other transactions are active.

The bigger levers trade durability for latency:

- PostgreSQL `synchronous_commit = off` returns before the WAL flush. A crash can lose the last few hundred milliseconds of commits (up to three times `wal_writer_delay`), but does not corrupt the database.
- MySQL `innodb_flush_log_at_trx_commit = 2` writes the log to the OS at commit and flushes about once a second. A mysqld crash loses nothing, but an OS crash or power loss can lose about a second of commits.

Both are business decisions, not tuning knobs. Agree the loss window in writing first.

## Writeback and journal stalls

Buffered writes land in the page cache as dirty pages. When dirty data passes `vm.dirty_background_ratio` (commonly 10% of available memory), the kernel starts background writeback. When it passes `vm.dirty_ratio` (commonly 20%), processes that write are throttled until writeback catches up. On a large-memory host, that can be gigabytes of data flushed at once, and every `fsync` queued behind it waits too.

Filesystem journals add their own ordering. On ext4 and XFS, an `fsync` may have to wait for a journal commit that includes other files' metadata. A busy logger on the database's volume can stretch commit latency.

Detection: watch `Dirty` and `Writeback` in `/proc/meminfo` alongside `biolatency`. A sawtooth in `Dirty` that matches your latency spikes is the signature.

## Burst credits: the test that passes for 30 minutes

On AWS, a gp2 volume gets a baseline of 3 IOPS per GiB, with a minimum of 100 and a maximum of 16,000. Volumes under 1,000 GiB can burst to 3,000 IOPS using a bucket of up to 5.4 million I/O credits that refills at the baseline rate.

A 100 GiB gp2 volume has a 300 IOPS baseline. At a sustained 3,000 IOPS it drains 2,700 credits per second, so a full bucket lasts 5,400,000 / 2,700 ≈ 2,000 seconds, **about 33 minutes**. Then it drops to 300 IOPS, a tenfold cut. A 20-minute load test passes. Production fails mid-morning. CloudWatch's `BurstBalance` metric shows the bucket as a percentage.

<div class="widget" data-widget="burst"><p><em>Interactive calculator: open this post on pawansinha.com.au to try it with your own numbers.</em></p></div>

gp3 removes this behaviour. Every gp3 volume includes 3,000 IOPS and 125 MiB/s regardless of size, and you can provision more independently of capacity. There are no credits, so a short test and a long test see the same volume. I would move most small gp2 volumes to gp3 for predictability alone. AWS has raised gp3 maximums over time, so check the current AWS documentation for limits.

The volume is not the only cap. Each EC2 instance type has its own EBS bandwidth and IOPS limits, and many smaller instances can only reach their peak EBS performance for a limited time each day. A fast volume behind a small instance is a slow volume. `VolumeQueueLength` and `VolumeTotalWriteTime` in CloudWatch help confirm where the queue forms.

## Thresholds belong to the device

"Alert when await exceeds 10 ms" is meaningless without context. Local NVMe and network block storage have very different normal latencies. Set thresholds from two numbers: the device's measured latency at low load, and the application's latency budget. If a commit has a 50 ms p99 budget and four synchronous writes, the disk tail you can tolerate is far below 50 ms.

Raising queue depth is rarely the fix. It helps only if the device has spare parallelism. On a capped cloud volume it just adds queueing time.

## Make the test match production I/O

- Same volume type, size and instance type as production.
- The same write pattern: small random writes with fsync for databases, not large sequential writes.
- A dataset larger than the page cache, so reads actually reach the disk.
- A run long enough to drain burst credits, then a steady phase after.
- `biolatency` running during the test, with `/proc/meminfo` and `BurstBalance` captured.

If your storage test is shorter than your credit bucket, you have measured the bucket, not the disk.
