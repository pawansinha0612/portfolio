---
title: Your load test traffic looks nothing like production
date: 2026-12-03
summary: Production traffic bursts, thinks, and mixes transactions in ways synthetic loads never capture. Here is how to model it from real data.
description: Model realistic load from production logs: arrival patterns, think time, transaction mix.
tags: Performance, k6, Workload Modelling
linkedin: |
  Your load test passes at 500 RPS steady state. Production hits 3 500 RPS in a five-minute burst at 9:15 am and the p99 jumps from 120 ms to 4 seconds. The test passed. The system failed.
  
  The gap is workload modelling. Most teams feed a single throughput number into a tool and call it a day. Real traffic has bursty arrivals (not Poisson), log-normal think times (not uniform), and a transaction mix driven by business impact (not volume).
  
  One concrete step: pull four weeks of access logs, bucket requests into 10-second windows, and feed that histogram directly into k6's ramping-arrival-rate executor. It takes an hour and catches the coordinated omission that hides your worst latency.
  
  What is the peak-hour factor in your busiest service?
---
Your load test runs at a steady 500 requests per second for an hour. The p99 latency is 120 ms. In production the same endpoint hits 2 000 requests per second in a three-minute burst every morning at 9 am and the p99 jumps to 4 seconds. The test passed. The system failed.

## Arrival rate vs concurrency: the first trap

Most teams configure a target throughput and let the tool spawn whatever virtual users are needed to sustain it. That inverts the real relationship. In production users arrive independently. Concurrency is the *result* of arrival rate multiplied by response time (Little's Law: L = λ × W). When latency spikes, concurrency spikes even if the arrival rate stays flat. A fixed-throughput driver masks this feedback loop because it throttles new requests when the system slows down. A fixed-concurrency driver does the opposite: it piles on more work as latency grows, which is closer to reality but can saturate load generators.

Model arrival rate from access logs. Count requests per second in 10-second buckets across a typical week. Keep the raw histogram; do not average it. Feed that histogram into your load tool as a schedule. In k6 you can use `ramping-arrival-rate` with a pre-computed array of target rates per stage.

## Transaction mix: weight by business impact not volume

A login endpoint might receive 40 percent of traffic but contribute almost zero revenue risk. A payment endpoint might be 2 percent of traffic but 90 percent of revenue. If your mix mirrors raw volume you over-test login and under-test payment. Pull the top 20 endpoints from production logs. Classify each by business criticality (revenue, SLA, user-visible). Assign a weight that reflects the cost of failure. Normalise weights so they sum to 1. Use those weights to select the next request in your script.

```javascript
// k6 transaction mix weighted by business impact
const mix = [
  { name: 'login', weight: 0.15, fn: doLogin },
  { name: 'browse', weight: 0.30, fn: doBrowse },
  { name: 'addToCart', weight: 0.20, fn: doAddToCart },
  { name: 'checkout', weight: 0.25, fn: doCheckout },
  { name: 'payment', weight: 0.10, fn: doPayment }
];

function pickTransaction() {
  const r = Math.random();
  let cum = 0;
  for (const t of mix) {
    cum += t.weight;
    if (r < cum) return t.fn;
  }
  return mix[mix.length - 1].fn;
}
```

## Peak-hour factor: your average is a lie

Average requests per second across 24 hours might be 200. The 9 am to 10 am average is 1 200. The 9:15 am to 9:20 am average is 3 500. Designing for the 24-hour average guarantees failure at 9:15. The peak-hour factor is the ratio of the busiest 5-minute window to the hourly average. In retail banking it is often 3 to 5. In flash-sale e-commerce it can exceed 20. Calculate it from at least four weeks of production data. Multiply your hourly arrival-rate schedule by that factor for the peak window. If your tool only accepts a single target rate, run a separate peak-only scenario.

## Poisson vs bursty: the coordinated omission problem

Poisson arrivals assume each request is independent and the inter-arrival time follows an exponential distribution. Real traffic is bursty: marketing emails, cron jobs, cache expiry, and human behaviour create correlated arrivals. If you generate Poisson traffic you suffer from coordinated omission (Gil Tene). The load generator waits for the previous request to finish before scheduling the next one. When the system stalls, the generator *also* stalls, so the measured latency distribution misses the worst samples. The fix is to decouple arrival scheduling from response handling. Use a constant-arrival-rate executor (k6) or a separate scheduler thread (JMeter, Gatling) that fires requests on a timeline regardless of whether previous requests have completed. Record the scheduled time and the actual response time separately. Merge them offline to reconstruct the true latency distribution.

## Think-time distributions: log-normal not uniform

Uniform think time between 1 and 5 seconds is a convenience, not a model. Human think time follows a log-normal distribution: many short pauses, a long tail of distractions. Fit a log-normal to your session logs. Extract the time between consecutive requests from the same client IP or session cookie. Discard gaps longer than your session timeout (usually 30 minutes). Compute the geometric mean and geometric standard deviation. In k6 you can sample from that distribution with `Math.exp(mu + sigma * Math.sqrt(-2 * Math.log(Math.random())) * Math.cos(2 * Math.PI * Math.random()))`.

| Parameter | Typical value (e-commerce) | Source |
|-----------|----------------------------|--------|
| Geometric mean (μ) | 2.1 s | Session logs |
| Geometric std dev (σ) | 1.8 | Session logs |
| Session timeout | 1 800 s | App config |

## Putting it together: a k6 script sketch

```javascript
import http from 'k6/http';
import { sleep } from 'k6';
import { SharedArray } from 'k6/data';

const arrivalSchedule = new SharedArray('schedule', () =>
  JSON.parse(open('./arrival-schedule.json'))
);
const thinkParams = { mu: Math.log(2.1), sigma: Math.log(1.8) };

export const options = {
  scenarios: {
    realistic: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      stages: arrivalSchedule,
      preAllocatedVUs: 2000,
      maxVUs: 5000
    }
  }
};

function lognormalThink() {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.exp(thinkParams.mu + thinkParams.sigma * z);
}

export default function () {
  pickTransaction();
  sleep(lognormalThink());
}
```

## Checklist before you run

- Arrival schedule derived from at least four weeks of production logs at 10-second granularity.
- Peak-hour factor calculated and applied to the busiest 5-minute window.
- Transaction mix weighted by business impact, not raw volume.
- Think-time distribution fitted to log-normal parameters from session data.
- Load generator uses constant-arrival-rate mode to avoid coordinated omission.
- Test duration covers at least two full peak cycles to capture warm-up and cool-down effects.
- Metrics collection includes scheduled vs actual start time for every request.

If any item is missing, the test is a smoke test, not a capacity test. Treat it accordingly.
