---
title: Your cloud load test passed on credit
date: 2026-11-16
summary: The cloud limits that let a short load test pass and production fail: T3 CPU credits, network burst and packet allowances, single-flow limits, NAT port exhaustion, cross-AZ hops, steal time and service quotas, with the metric that exposes each one.
description: Cloud load tests pass on banked credits. CPU credits, network allowances, NAT ports, cross-AZ hops and steal time, and the metric that shows each.
tags: Performance, Cloud, AWS
highlight: credit
linkedin: |
  The 30-minute load test on a t3.medium passed at 60% CPU. In production, at the same load, the box ground down to a crawl on day two.

  Burstable instances earn CPU credits and spend them above their baseline. A t3.medium earns 24 credits an hour, and at 60% CPU it spends 72. A full balance of 576 credits lasts 12 hours. Your test ran on savings.

  Cloud has more of these:
  → network "up to" bandwidth that's a burst, not a promise
  → per-instance packet and connection-tracking allowances
  → NAT gateway ports per destination
  → steal time from noisy neighbours

  The article has an interactive calculator: see how long your T3 credits last at your load.

  Do your load tests run long enough to drain the credits?

  #PerformanceEngineering #AWS #Cloud
---
Your load test runs for 30 minutes on a t3.medium at 60% CPU. p95 is flat, and the team signs off. In production the same traffic runs fine through Monday, and on Tuesday afternoon latency triples while the CPU graph shows 40%, lower than before.

The instance didn't get slower. It ran out of credit.

Cloud resources often have two speeds: a sustained baseline and a burst that is paid for out of a balance. A short load test only ever sees the burst. This post covers the common traps on AWS and the metric that shows each one. Other clouds have equivalents with different names.

## CPU credits on burstable instances

T-family instances (T3, T3a, T4g, T2) earn CPU credits at a fixed rate and spend them when they run above a baseline. **One CPU credit is one vCPU at 100% for one minute.**

A t3.medium has 2 vCPUs and earns 24 credits an hour. That works out to a baseline of 20% per vCPU: 24 credits / 60 minutes / 2 vCPUs. It can bank up to 24 hours of earnings, 576 credits.

At 60% sustained CPU it spends 2 × 0.6 × 60 = 72 credits an hour while earning 24, a net drain of 48 an hour. A full balance lasts 576 / 48 = 12 hours. A 30-minute test uses 4% of the bank and learns nothing.

What happens when the balance hits zero depends on the credit mode:

- **Standard mode** caps the instance at its baseline. At 20% per vCPU, a workload that needs 60% queues, and latency climbs without limit. CPU utilisation then *drops* to the baseline, which is why the graph looks healthier as things get worse. T2 instances launch in standard mode by default.
- **Unlimited mode** keeps the speed and charges for surplus credits. T3 and later launch in unlimited mode by default. There's no slowdown, but there is a bill, and burstables that run hot all the time often cost more than a fixed-performance instance.

<div class="widget" data-widget="cpucredit"><p><em>Interactive calculator: open this post on pawansinha.com.au to try it with your own numbers.</em></p></div>

**Detect it:** CloudWatch `CPUCreditBalance` (and `CPUSurplusCreditBalance` in unlimited mode), and the instance's credit specification. In a load test, either run long enough to drain the balance or start from an empty one. For anything with a steady load, I'd pick a fixed-performance instance (M, C or R family) and keep burstables for genuinely spiky, mostly idle work.

Storage has the same shape. gp2 volumes burst on I/O credits, which I covered in [the disk I/O post](/blog/your-iostat-says-fine-but-writes-stall-for-500-ms/).

## Network bandwidth is also a burst

Instance types listed with "up to" a bandwidth figure, for example "up to 5 Gigabit", have a lower baseline bandwidth and burst above it on network I/O credits. A short test bursts and passes. A long data transfer or a sustained cache warm-up drops to the baseline.

Separately from bandwidth, every instance has allowances that are easy to exceed without noticing:

- **Packets per second.** Small messages (chatty RPC, small UDP datagrams) can hit the packet limit long before the bandwidth limit.
- **Connection tracking.** Security groups track connections, and the tracking table has a per-instance size. Many short-lived connections can fill it.
- **Single flow.** One TCP flow is capped (5 Gbps between instances outside a cluster placement group), whatever the instance's total bandwidth. One big transfer over one connection can't use a 25 Gbps NIC.

**Detect it:** on instances with the ENA driver, `ethtool -S eth0` shows counters such as `bw_in_allowance_exceeded`, `bw_out_allowance_exceeded`, `pps_allowance_exceeded` and `conntrack_allowance_exceeded`. Any of them increasing during a test means packets were queued or dropped at the instance limit. Retransmits and latency spikes follow, while CPU and bandwidth graphs look normal. Collect these counters in every load test.

## NAT gateway ports

Outbound traffic from private subnets often goes through a NAT gateway, which can hold about 55,000 simultaneous connections to each unique destination (IP, port and protocol). A service that opens a new connection per request to one third-party API can exhaust that at a few hundred requests a second, depending on how long connections linger.

**Detect it:** the NAT gateway's `ErrorPortAllocation` metric in CloudWatch. Fix it with connection pooling and keep-alive to the destination, or spread the traffic across more NAT gateways or addresses.

## Cross-zone hops add up

Availability zones in a region are close, but a cross-AZ round trip still costs more than one inside a zone, and cross-AZ data transfer is billed. One extra hop is negligible. A request that makes 40 sequential calls, each crossing a zone, adds 40 of those round trips to every request.

**Detect it:** measure the round-trip time between zones yourself (a simple TCP ping from each zone to each other). Then count sequential cross-zone calls per request in your traces. Zone-aware routing in the load balancer or service mesh keeps chatty traffic within one zone.

## Noisy neighbours and steal time

On shared hardware, another tenant can take CPU time your VM was ready to use. Inside the guest this shows up as **steal time**: the share of time the vCPU was runnable but the hypervisor ran something else.

**Detect it:** the `st` column in `top`, `vmstat 1` or `mpstat -P ALL 1`. A few percent of steal that comes and goes, lining up with latency spikes your own metrics can't explain, is the signature. On burstable instances, steal also rises when the instance is held at its baseline.

## Service quotas

Many limits sit outside the instance entirely and only show up at production scale. Examples on AWS:

- Lambda concurrency per region (1,000 by default).
- DynamoDB per-partition throughput, which makes one hot key throttle while the table looks under capacity.
- API rate limits on control-plane calls, which autoscaling and deployment tooling depend on.

**Detect it:** check Service Quotas for each service on the request path before the test. In the test, alert on throttling errors (`ThrottlingException`, `ProvisionedThroughputExceededException`, `RequestLimitExceeded`), not only on 5xx.

## Checklist

1. Run peak tests long enough to drain every credit bucket, or start them with empty balances.
2. Prefer fixed-performance instances for steady load.
3. Collect ENA allowance counters and steal time in every test.
4. Pool and reuse outbound connections, and watch `ErrorPortAllocation`.
5. Count cross-zone hops per request and keep chatty paths inside one zone.
6. Review service quotas for every dependency before peak.

In the cloud, the first half-hour of a load test measures the burst. Production runs on the baseline.
