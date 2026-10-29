---
title: Load, stress, spike and soak tests: what each one finds
date: 2026-10-31
summary: Four performance test types, four different questions. What each one finds, a one-line rule for when to use it, and a k6 example.
tags: Performance, Load testing, k6
linkedin: |
  "We ran a performance test" doesn't say much. Which one?

  Load test: can we handle the traffic we expect?
  Stress test: where do we break, and how badly?
  Spike test: what happens when traffic jumps suddenly?
  Soak test: does anything degrade over hours?

  Each one finds different problems. A load test won't find a memory leak that takes six hours to appear. A soak test won't tell you what happens when a marketing email lands and traffic triples in a minute.

  A simple rule: load test every release, spike test anything with a known event or launch, soak test before big releases and after memory-related changes, and stress test to know your real capacity and how the system fails.

  Which of the four gets skipped most often on your projects?
---
"We did performance testing" can mean very different things. Load, stress, spike and soak tests each ask a different question, and each finds problems the others miss. Here's what each one is for, with a one-line rule for when to use it.

## Load test: can we handle normal peak traffic?

A load test runs the system at the traffic you expect at your busiest normal time, for long enough to see stable behaviour (often 30–60 minutes at steady state).

**What it finds:** response times and error rates against your targets, and resource use (CPU, memory, connections) at realistic volume.

**Rule:** run it for every significant release, against the expected peak plus some headroom.

Example: an online store expects 2,000 concurrent users at its evening peak. The load test ramps to 2,000 users, holds for 45 minutes and checks that p95 stays under 1 second with an error rate under 1%.

## Stress test: where and how do we break?

A stress test keeps increasing load beyond the expected peak until something gives: response times climb, errors appear, or a resource runs out.

**What it finds:** your real capacity, the first bottleneck (database connections, thread pools, CPU, a downstream service), and whether the system fails gracefully (clear errors, recovery afterwards) or badly (timeouts everywhere, no recovery).

**Rule:** run it when you need to know your capacity and failure behaviour, for example before a launch or when planning infrastructure.

## Spike test: what happens when traffic jumps suddenly?

A spike test takes the system from normal load to a much higher load within seconds or a minute, holds briefly, then drops back.

**What it finds:** whether auto-scaling reacts fast enough, how queues and connection pools behave under a sudden surge, and whether the system recovers once the spike passes.

**Rule:** run it when traffic can jump quickly, such as a ticket release, a sale, a push notification or a TV mention.

## Soak test: does anything degrade over time?

A soak (endurance) test runs a moderate, realistic load for hours, sometimes overnight or longer.

**What it finds:** memory leaks, connection leaks, growing queues, disks filling with logs, and slowdowns that only appear after hours of running.

**Rule:** run it before major releases and after changes to caching, connection handling or memory-heavy code.

## Quick comparison

| Test | Load shape | Main question | Typical finding |
|---|---|---|---|
| Load | Ramp to expected peak, hold | Do we meet targets at normal peak? | Slow transactions, high resource use |
| Stress | Keep increasing past peak | Where is the limit and how do we fail? | First bottleneck, poor failure handling |
| Spike | Sudden jump, short hold, drop | Do we survive surges and recover? | Slow scaling, exhausted pools |
| Soak | Moderate load for hours | Does anything degrade over time? | Memory and connection leaks |

## The same idea in k6

The test type is mostly about the shape of the load. In k6 that's the `stages` option. A load test:

```javascript
import http from 'k6/http';
import { sleep } from 'k6';

export const options = {
  stages: [
    { duration: '10m', target: 2000 }, // ramp up
    { duration: '45m', target: 2000 }, // steady state
    { duration: '5m', target: 0 },     // ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<1000'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  http.get('https://test.example.com/products');
  sleep(1);
}
```

For a spike test, change the stages to something like:

```javascript
stages: [
  { duration: '5m', target: 500 },   // normal load
  { duration: '30s', target: 5000 }, // sudden spike
  { duration: '5m', target: 5000 },  // hold
  { duration: '30s', target: 500 },  // back to normal
  { duration: '5m', target: 500 },   // check recovery
],
```

A soak test holds a moderate target for hours. A stress test keeps adding stages with higher targets until thresholds fail.

## A sensible order

1. **Load test** first. If you don't meet targets at normal peak, nothing else matters yet.
2. **Stress test** to find your capacity and the first bottleneck.
3. **Spike test** if your traffic can surge.
4. **Soak test** before big releases, ideally overnight.

Whatever the type, monitor the servers and dependencies during the run, not just the response times. The test tells you something is wrong; the monitoring tells you why.
