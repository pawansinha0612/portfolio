---
title: Your load test is lying about p99
date: 2026-11-02
summary: A closed-loop load generator politely waits whenever the system stalls, so the worst moments never get measured. A worked example, how to spot it in results you already have, and how to fix it.
tags: Performance, Load Testing, Latency
linkedin: |
  Your load test says p99 is 1 ms. The real p99 is 9 seconds. Same run, same system.

  That's coordinated omission (Gil Tene's term). A closed-loop load generator waits for each response before sending the next request. When the system stalls, the tool stalls with it, so the requests that would have suffered the most are never sent and never measured.

  In the worked example in this post, one 10-second stall in a 100-second run gives a reported mean of about 2 ms. The true mean is about 500 ms.

  The fix: use open-model, arrival-rate load (k6 constant-arrival-rate, Gatling open injection, JMeter's Open Model Thread Group, wrk2) and watch for dropped iterations, which are the same omission in a new form.

  The article has an interactive simulator: set your own stall length and compare reported vs real p99.

  Quick check on existing results: did achieved throughput dip at the same moment latency spiked? If so, your percentiles are flattering you.

  #PerformanceEngineering #LoadTesting #Latency
---
Your load test report says p99 is 1 ms. Clean run, green thresholds, ready for sign-off.

During that same run, the service froze for 10 seconds. The real p99 was about 9 seconds. The tool didn't lie on purpose. It simply stopped asking questions at the exact moment the answers got bad.

That is **coordinated omission**, a term from Gil Tene, and it is sitting quietly in a lot of load test reports right now. It doesn't make results a little optimistic. It can understate tail latency by several orders of magnitude.

## The mechanism

Most load tools default to a **closed model**: each virtual user sends a request, waits for the response, optionally thinks, then sends the next one. That works until the system stalls.

When the server freezes for two seconds (a GC pause, a lock, a failover), every virtual user is stuck waiting on one request. During those two seconds, the requests a real user population *would have sent* are never sent. The tool records one slow sample per user, not the hundreds of slow experiences real users would have had. The tool has "coordinated" with the system, and the omitted samples are exactly the bad ones.

Real users do not coordinate. They arrive whenever they arrive, whether or not your service is mid-pause. That is an **open model**: arrivals are independent of response times.

## A worked example

Imagine one closed-loop thread intended to send a request every 10 ms (100 req/s) for 100 seconds: 10,000 requests in total.

- For 90 seconds the service answers in 1 ms. The thread sends 9,000 requests, all recorded at 1 ms.
- Then the service stalls for 10 seconds. The thread sends one request and waits. That one request is recorded at 10 s.

**What the tool reports** (9,001 samples):

- Mean = (9,000 × 1 ms + 10,000 ms) / 9,001 = 19,000 / 9,001 ≈ 2.1 ms
- p99 = 1 ms, because only one sample in 9,001 (0.011%) is slow.

**What users would have experienced:** during the stall, 1,000 requests were due (one every 10 ms). They would have waited 10 s, 9.99 s, 9.98 s, down to about 0.01 s, an average of about 5 s.

- Mean = (9,000 × 1 ms + 1,000 × 5,000 ms) / 10,000 = 5,009,000 / 10,000 ≈ 501 ms
- p99: the slowest 1% is 100 samples, all from the start of the stall, waiting at least 9 s. So p99 ≈ 9 s.

Reported p99: 1 ms. Actual p99: about 9 s. Same run.

Change the stall length and request interval and compare what the tool reports with what users experienced:

<div class="widget" data-widget="omission"><p><em>Interactive calculator: open this post on pawansinha.com.au to try it with your own numbers.</em></p></div>

## Where it hides

- **Closed-model test plans**: classic JMeter Thread Groups, LoadRunner scenarios built on a fixed number of virtual users, k6's `constant-vus` and `ramping-vus` executors. Pacing and throughput timers do not fix it. They still wait for the response before the next request.
- **Server-side timing**: an application that times a request from when a worker thread picks it up misses the time spent in the accept queue, the load balancer and the thread pool queue.
- **Client libraries and monitoring** that measure only from actual send time, not from when the work was due.

## How to spot it in results you already have

1. **Throughput dips when latency spikes.** In a closed test, achieved throughput falls when the system slows down. If your throughput graph has notches aligned with latency spikes, samples were omitted.
2. **Max far above p99.9 with very few samples.** A handful of huge values over a calm distribution often means stalls that were barely sampled.
3. **Achieved rate below target** during the run, even briefly.

## Fixing it

**1. Generate load with an open model.** Requests are scheduled by arrival rate, not by the previous response.

```javascript
import http from 'k6/http';

export const options = {
  scenarios: {
    open: {
      executor: 'constant-arrival-rate',
      rate: 200,             // iterations started per timeUnit
      timeUnit: '1s',
      duration: '10m',
      preAllocatedVUs: 100,
      maxVUs: 2000,          // headroom for a stall: 200/s × 10 s
    },
  },
  thresholds: {
    http_req_duration: ['p(99)<300'],
    dropped_iterations: ['count==0'],
  },
};

export default function () {
  http.get(`${__ENV.BASE_URL}/api/quote`);
}
```

With an arrival-rate executor, k6 keeps starting iterations on schedule during a stall, using new VUs. The stall shows up as many concurrent slow requests, which is the truth. If k6 runs out of VUs, it cannot start the iteration and counts it in `dropped_iterations`. That is coordinated omission again, so treat any dropped iterations as an invalid run, as the threshold above does.

Equivalents elsewhere: Gatling's open injection profiles such as `constantUsersPerSec`, JMeter's **Open Model Thread Group** (added in JMeter 5.5), and **wrk2**, which takes a fixed rate with `-R` and measures latency from each request's *intended* send time.

**2. Correct closed-loop data when you cannot change the tool.** HdrHistogram provides `recordValueWithExpectedInterval(value, expectedInterval)`, which back-fills the samples that should have been taken during a long response. It is an estimate based on an assumed interval, but far closer to reality than the raw data.

**3. In custom harnesses, measure from the intended start time**, not the actual send time. If a request was due at t = 100 ms and went out at t = 2,100 ms because the sender was blocked, its latency starts at 100 ms.

## Open models have a cost: plan for it

An open-model test does not back off. If the system cannot keep up, concurrency grows without limit: that is how real traffic behaves, and it is the point. Bound it deliberately with `maxVUs` sized for the longest stall you want to measure (arrival rate × stall length), and make sure the load generator has the memory and CPU for that concurrency.

## Decision rule

If the question is "what latency will users see at X requests per second?", use an open model. Use a closed model only when the real system is closed: a fixed pool of batch workers, or a client with a hard concurrency limit. And whichever you use, report achieved throughput next to every percentile. A p99 without the rate it was measured at is not a result.
