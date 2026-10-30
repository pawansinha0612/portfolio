---
title: The week-2 decisions that sink your week-38 load test
date: 2026-11-05
summary: The cheapest performance work happens before anything is built. Measurable NFRs from business numbers, latency budgets per hop, a capacity model, an architecture risk review and a test strategy that grows with the system.
tags: Performance, Architecture, Capacity Planning
highlight: week-38
linkedin: |
  On a greenfield project, the most valuable performance work happens before there's anything to load test.

  The decisions that are expensive to change later are made in the first few weeks: data model and partition keys, synchronous vs asynchronous boundaries, how many services sit on the critical path, which shared resources everything depends on.

  What I'd put in place before the first sprint ends:
  1. NFRs derived from business numbers, with arrival rates and percentiles, not "fast".
  2. A latency budget per hop that adds up to the end-to-end target.
  3. A capacity model, even a rough one. A model that shows 380 database connections against a default limit of 100 is a design conversation, not a production incident.
  4. A walking-skeleton load test that measures real CPU cost per request.
  5. Performance checks in CI from the first service.

  The article has an interactive capacity model: put in your own forecast and see where it breaks.

  When does performance engineering start on your projects: design, build, or the week before go-live?

  #PerformanceEngineering #SoftwareArchitecture #CapacityPlanning
---
Week 38 of a 40-week project. The first full-scale load test starts, and at 30% of target traffic the database starts refusing connections. The fix is an architecture change. There are two weeks left.

The decision that caused it was made in week 2, when nobody had numbers.

Performance engineering usually arrives late, against an architecture that can no longer change. A greenfield project is the rare chance to do the opposite. The work below costs days at the start and saves months at the end.

## 1. NFRs you can test, derived from business numbers

"The system must be fast and scalable" is not a requirement. A testable non-functional requirement (NFR) names the operation, the load, the percentile, the error budget and the headroom:

> Checkout: p99 under 400 ms and error rate under 0.1% at 3,000 API requests per second, sustained for 1 hour, with 2× headroom available through scaling.

Derive the load from business numbers rather than guessing. A worked example:

- Forecast: 2,000,000 orders per day, 30% of them in the busiest hour.
- Peak-hour average: 2,000,000 × 0.30 / 3,600 ≈ 167 orders/s.
- Burst factor: traffic within the peak hour is not flat. Assume the busiest minute runs at 3× the hour's average: 167 × 3 ≈ 500 orders/s.
- Fan-out: each order makes about 6 API calls, so the API tier must handle 500 × 6 = **3,000 req/s**.

Write the assumptions down next to the numbers. When the forecast changes, you can recompute in minutes, and when someone challenges the target you can show where it came from.

## 2. A latency budget per hop

Split the end-to-end target across the request path so each team owns a number:

| Hop | Budget (p99) |
|-----|-------------|
| Edge / CDN and TLS | 30 ms |
| Load balancer and API gateway | 20 ms |
| Order service compute | 80 ms |
| Cache lookups | 10 ms |
| Database | 120 ms |
| Payment provider call | 100 ms |
| Headroom | 40 ms |
| **Total** | **400 ms** |

One honest caveat: percentiles do not add. The p99 of a sum is not the sum of p99s, because hops are rarely slow on the same request. Treating the sum as the budget is conservative, which is fine for planning. Validate the real end-to-end distribution with tracing once the system exists.

The budget immediately exposes design risk. If the design needs three sequential calls to a downstream service with a 100 ms p99, it does not fit, and you know that before writing code.

## 3. A capacity model, even a rough one

A spreadsheet is enough. Continuing the example, assume each API request costs 15 ms of CPU (to be replaced with a measured number from step 5):

- CPU needed: 3,000 req/s × 0.015 s = 45 cores busy.
- At a 60% utilisation target to leave room for bursts: 45 / 0.6 = 75 cores.
- With 2-core pods: about 38 pods at peak.

Now follow the consequences. If each pod has a database connection pool of 10, that is 38 × 10 = 380 connections. PostgreSQL's default `max_connections` is 100, and large connection counts hurt PostgreSQL performance well before any limit. So the model has just produced an architecture decision: a connection pooler (such as PgBouncer or a managed proxy), smaller per-pod pools, or a different access pattern. Far better to have that conversation now.

Here is the same model as an interactive calculator. Put in your own forecast and see where it breaks:

<div class="widget" data-widget="capacity"><p><em>Interactive calculator: open this post on pawansinha.com.au to try it with your own numbers.</em></p></div>

## 4. An architecture risk review

Review the design specifically for performance risk. The patterns that cause most production performance problems are visible on a whiteboard:

- **Synchronous fan-out chains**: every sequential remote call adds its latency and its failure probability to the critical path.
- **Chatty interfaces**: N+1 calls across a network, such as fetching 50 line items one request at a time.
- **Shared hot resources**: one database, one queue partition, one cache shard that everything touches.
- **Partition keys and hot keys**: a Kafka topic keyed by merchant, or a DynamoDB table keyed by date, where one key gets most of the traffic.
- **Cold-cache dependence**: if the cache is empty after a deploy or failover, can the database survive the miss rate?
- **Third-party limits**: rate limits and latency of external providers, usually the least controllable part of the budget.
- **Timeouts and retries**: timeouts should shrink down the call chain, and retries need a budget, or a slow dependency turns into a retry storm.

Record each risk with how and when it will be tested.

## 5. A walking skeleton, measured

Build the thinnest end-to-end slice through the riskiest path, deployed on production-like infrastructure, and load test it early. The point is not to prove the target. It is to **replace the guesses in the capacity model with measured service demand**: CPU milliseconds per request, database time per request, payload sizes. Those numbers change sizing more than anything else.

## 6. Observability built in, not bolted on

From the first service:

- **OpenTelemetry** tracing with context propagated across every hop.
- **RED metrics** (rate, errors, duration) per endpoint, with latency recorded as **histograms**, not averages, so percentiles can be aggregated correctly.
- **SLOs** written from the NFRs, so production has the same targets as the tests.
- Saturation metrics for every pool and queue: threads, connections, consumer lag.

Retrofitting this later is always harder, and without it every later performance test is guesswork.

## 7. A test strategy that grows with the system

| Phase | What runs | Purpose |
|-------|-----------|---------|
| Early build | Walking-skeleton load test, microbenchmarks for hot code paths | Measure service demand, validate the model |
| Every merge | Short fixed-rate smoke test in CI with thresholds on p95/p99 and error rate | Catch regressions within hours of the change |
| Nightly | Full-scale integrated test at target load | Track trends, find interaction effects |
| Pre-release | Peak, stress-to-failure, soak, failover and scale-out tests | Prove the NFRs and find the breaking point |
| Production | SLO monitoring, synthetic checks, capacity reviews | Feed real numbers back into the model |

## The decisions to be in the room for

Some decisions are cheap now and very expensive later: the data model and partition keys, synchronous versus asynchronous boundaries, tenancy model, the number of services on the critical path, and protocol choices. A performance engineer's highest-leverage work on a greenfield project is making sure those decisions are made with numbers in hand.
