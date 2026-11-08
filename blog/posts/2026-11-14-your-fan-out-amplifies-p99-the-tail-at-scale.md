---
title: Your fan-out turns a 1% slow call into 63% slow requests
date: 2026-11-14
summary: The maths of tail latency under fan-out from Dean and Barroso's "The Tail at Scale", why a back-end's p99 stops being good enough, and the fixes that work: hedged and tied requests, deadlines, fewer sequential hops and load tests that report per-call percentiles.
description: Fan out to 100 back-ends and a 1% slow call makes 63% of requests slow. Fan-out maths, hedged and tied requests, deadlines and how to test it.
tags: Performance, Latency, Microservices
highlight: 63%
linkedin: |
  Each back-end call is slow 1% of the time. A page waits for 100 of them.

  How many page loads are slow? Not 1%. It's 1 − 0.99^100 = 63%.

  That's the core of Dean and Barroso's "The Tail at Scale". With fan-out, a back-end's p99 stops mattering. To keep the page's p99 healthy at a fan-out of 100, each call needs to be good at p99.99.

  What helps:
  → hedged requests: resend a call that hasn't answered by its p95, keep whichever answers first
  → tied requests: queue on two servers, cancel the copy that didn't start
  → deadlines on every hop, and fewer calls in sequence

  The article has an interactive calculator: set your fan-out and see what share of requests turn slow.

  What's the largest fan-out on your critical path?

  #PerformanceEngineering #Microservices #SRE
---
Your search page queries 100 index shards in parallel and waits for all of them. Each shard answers in 10 ms almost every time, and its p99 is a respectable 50 ms. Yet the search page's median is close to a second on busy days, and nobody can find a slow component.

Every component is fast. The page is slow because it waits for the slowest of 100.

## The arithmetic of waiting for everyone

If one call is slow with probability p, and a request waits for N independent calls, the request is fast only if every call is fast:

> P(request slow) = 1 − (1 − p)^N

A worked example from Jeff Dean and Luiz André Barroso's paper "The Tail at Scale" (2013): a server that is slow for 1 in 100 requests, with a fan-out of 100, makes 1 − 0.99^100 ≈ 63% of user requests slow.

The growth is steep at first and then flattens, because the probability can never exceed 100%:

| Fan-out | Requests slow (p = 1%) |
|---|---|
| 1 | 1% |
| 10 | 9.6% |
| 50 | 39.5% |
| 100 | 63.4% |
| 200 | 86.6% |

Turn it around and you get the requirement. For the request's p99 to be "fast", each call must be fast with probability 0.99^(1/N). At a fan-out of 100 that is 0.9999. **Each back-end has to be good at its p99.99, not its p99.**

<div class="widget" data-widget="fanout"><p><em>Interactive calculator: open this post on pawansinha.com.au to try it with your own numbers.</em></p></div>

Real systems are worse than the formula in one way and better in another. Slowness is often correlated (a GC pause, a noisy neighbour, a hot shard affects many calls at once), so calls are not independent. And sequential hops add their latencies on top, so a chain of five services each adds its own tail.

## Why the back-end's tail exists

Variability is normal in shared systems. Common sources:

- garbage collection and other stop-the-world pauses
- background work such as compaction, log rotation and cache refreshes
- queueing behind a slow request on the same thread or connection
- shared resources: CPU throttling, network, disk, a noisy neighbour
- the occasional cold cache or page fault

You can reduce each one, but not to zero. The paper's argument is that large systems should be **tail-tolerant**: designed so that individual slow calls don't become slow requests.

## Hedged requests

Send the call to one replica. If it hasn't answered after a short delay, send the same call to a second replica and use whichever answer comes first.

The usual delay is the call's p95. Only about 5% of calls are ever duplicated, so the extra load is small. A call is now slow only if both copies are slow, which turns p into roughly p² when replicas fail independently. The paper reports a Google benchmark where hedging after a 10 ms delay cut the 99.9th-percentile latency of a 100-server fan-out from 1,800 ms to 74 ms, at the cost of 2% more requests.

Trade-offs:

- **Only for idempotent reads,** or writes protected by an idempotency key.
- **Correlated slowness defeats it.** If both replicas are slow for the same reason (a hot key, an overloaded cluster), the hedge just adds load.
- **Cap it.** Under overload, hedges add work exactly when there is none to spare. Limit hedges to a small share of traffic, or turn them off when error rates rise.

## Tied requests

Hedging waits before duplicating. A tied request sends the call to two servers at once, each copy tagged with the other's identity. Whichever server starts executing first tells the other to cancel its copy. Because most of the delay is time spent in the queue, the call gets the shorter of two queues, and the cancellation means the work usually happens only once. It needs support in the server, so it fits systems you control end to end.

## Deadlines and budgets

Give every user request a deadline and pass the remaining time down with each call (gRPC deadlines do this out of the box). A shard that receives a call with 5 ms left and knows it needs 20 should fail fast rather than do work nobody will use.

When results can be partial, decide what "good enough" means. A search page that returns results from 98 of 100 shards at the deadline is usually better than a complete page three seconds later. This is a product decision, so make it explicitly.

## Reduce fan-out and sequential hops

The cheapest tail is the one you don't have:

- **Batch** many small calls to the same service into one.
- **Cache** the results of slow, repeated calls near the caller.
- **Flatten call chains.** Five services in sequence each add their tail, and parallel calls are better than sequential ones.
- **Smaller partitions** let a slow or overloaded partition be moved or split quickly, instead of slowing everything on that machine.

## How to load test for it

Fan-out amplification is easy to miss because each service's own dashboard looks healthy.

1. **Report per-call percentiles to p99.9 and beyond** for back-ends that sit behind a fan-out, with enough samples to trust them. A p99.99 needs well over 10,000 calls per measurement window.
2. **Measure at the user-request level too,** and check that the request p99 matches what the formula predicts from the per-call tail. A big gap means correlated slowness, such as a shared pause or a hot shard.
3. **Inject tail latency.** Add a fault that makes 1% of calls to one dependency take 500 ms, and watch what it does to the user-facing p99.
4. **Test hedging under overload,** not just at normal load, and make sure the hedge rate stays capped.

Avoid coordinated omission in these tests: use an open-model load generator, so slow responses don't reduce the rate of new requests and hide the tail you are trying to measure.

## Checklist

1. List the fan-out (parallel) and depth (sequential) of your critical requests.
2. Compute the per-call percentile you actually need: 0.99^(1/N).
3. Add hedging (with a cap) for idempotent reads behind large fan-outs.
4. Propagate deadlines on every hop, and decide where partial results are acceptable.
5. Batch, cache and flatten to reduce N.
6. Load test with per-call tails, user-level tails and injected slowness.

At scale, every rare event is happening somewhere, all the time. Design for the slowest call, because every big request waits for it.
