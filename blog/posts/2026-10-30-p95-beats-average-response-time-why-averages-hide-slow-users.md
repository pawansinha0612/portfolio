---
title: Why p95 beats the average response time
date: 2026-10-30
summary: An average of 480 ms can hide one in ten users waiting 3 seconds. A worked example of why percentiles tell the truth and averages don't.
tags: Performance, Metrics
linkedin: |
  An average response time of 480 ms sounds healthy. It can still mean one in ten of your users waits 3 seconds.

  Take 100 requests: 90 return in 200 ms and 10 take 3,000 ms. The average is 480 ms. The p95 is 3,000 ms.

  The average blends the fast and the slow into a number nobody actually experienced. The p95 answers a better question: how slow is it for the unlucky 5%?

  That's why performance targets (and test pass/fail thresholds) should be written as percentiles: "p95 under 800 ms", not "average under 500 ms". Report p50, p95 and p99 together and the shape of the problem becomes obvious.

  Which percentile do your SLAs use, and has the average ever hidden a problem from you?
---
A report says the average response time is 480 ms. Everyone relaxes. Meanwhile one in ten users is waiting three seconds for the page to respond. Both statements can be true at the same time, and that's the problem with averages.

## A worked example

Say a load test sends 100 requests to a search endpoint:

| Requests | Response time |
|---|---|
| 90 | 200 ms |
| 10 | 3,000 ms |

**Average:** (90 × 200 + 10 × 3,000) / 100 = (18,000 + 30,000) / 100 = **480 ms**

**p95:** sort all 100 times from fastest to slowest and take the value 95% of the way along. Positions 1–90 are 200 ms and positions 91–100 are 3,000 ms, so the 95th value is **3,000 ms**.

**p50 (median):** **200 ms**.

So the same test can be summarised three ways:

- p50 = 200 ms: the typical user is fine.
- average = 480 ms: looks acceptable, but describes no real user at all.
- p95 = 3,000 ms: one in ten users has a poor experience.

Nobody in this test actually waited 480 ms. The average sits in a gap between two groups of real users and hides the slow group.

## Why averages mislead

**Response times are skewed.** Most requests are fast, and a minority are much slower because of cache misses, slow queries, garbage collection pauses, lock contention or a cold instance. That long tail is where users get frustrated, and the average dilutes it.

**Averages can hide regressions.** A release that makes most requests faster and a few much slower can leave the average unchanged. Compare p95 and p99 between builds and the regression shows up.

**Users feel the tail more than you'd think.** A single page often makes many API calls. If each call has a 5% chance of being slow, a page making 10 calls has roughly a 40% chance (1 − 0.95¹⁰) that at least one of them is slow. Tail latency adds up quickly.

## Which percentile to use

- **p50** shows the typical experience.
- **p95** is the usual target for SLAs and test thresholds.
- **p99** matters for high-volume or critical paths (payments, login), where 1% is still a lot of people.
- **max** is useful for spotting outliers, but too noisy to set a target on.

Report them together. A big gap between p50 and p95 tells you the system has two behaviours, and it's worth finding out what makes the slow requests slow.

## Calculating p95

Most tools already do it: k6, JMeter, Gatling and LoadRunner all report percentiles. If you have raw numbers, Python's standard library is enough:

```python
import statistics

response_times_ms = [200] * 90 + [3000] * 10

cuts = statistics.quantiles(response_times_ms, n=100)  # 99 cut points
print("average:", statistics.mean(response_times_ms))  # 480
print("p50:", statistics.median(response_times_ms))    # 200
print("p95:", cuts[94])                                # 3000
```

Different tools interpolate percentiles slightly differently, so compare numbers from the same tool across runs.

In k6, make the percentile the pass/fail rule rather than the average:

```javascript
export const options = {
  thresholds: {
    http_req_duration: ['p(95)<800', 'p(99)<1500'],
  },
};
```

## A few cautions

- **Small samples make shaky percentiles.** With 20 requests, the p95 is decided by one value. Collect hundreds or thousands of samples per transaction before trusting it.
- **Don't average percentiles.** The average of five servers' p95 values is not the overall p95. Calculate it from the combined raw data.
- **Look per transaction.** A fast health-check endpoint mixed with a slow search endpoint gives a blended percentile that describes neither.

## Takeaway

Write performance targets as percentiles, report p50, p95 and p99 together, and treat a wide gap between them as something to investigate. The average is fine as a supporting number, but it should never be the headline.
