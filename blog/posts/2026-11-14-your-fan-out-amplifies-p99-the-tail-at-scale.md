---
title: Your Fan‑Out Amplifies p99: The Tail at Scale
date: 2026-11-14
summary: A single slow micro‑service can wreck your p99. Learn how fan‑out, hedging and tied requests amplify tail latency and how to budget per hop.
description: Tail latency explodes with fan‑out. Use probability, hedging, tied requests and hop budgets to keep p99 in check.
tags: Performance, Latency, Microservices, Hedging
linkedin: |
  When a single micro‑service goes slow, the whole request can become a 2 s tail. The key is to recognise that fan‑out multiplies the tail probability: 1‑0.99^N. A quick takeaway: hedge only idempotent calls and tie only when you truly need all results. How do you currently allocate latency budgets per hop in your architecture?
---
## The problem you’re already seeing
Your load test reports a p99 of 200 ms, but in production the p99 is 2 s. The request path fans out to ten downstream services. One of those services is occasionally slow – a single 1 s response blows the overall latency. You’re not alone; the tail grows with every hop you add.

## Fan‑out and the probability of a slow hop
When a request calls *N* independent back‑ends, the probability that at least one of them is slow is

\[\mathbb{P}_{\text{slow}} = 1 - (1 - p)^{N}\]\n
where *p* is the probability that a single hop is slow. If *p* is 1 % and *N* is 10, the probability that the request experiences a slow hop is

\[1 - 0.99^{10} \approx 0.095\]\n
So a 1 % tail on a single hop becomes a 9.5 % tail on the request. If you add another hop, the probability rises to 1 – 0.99^11 ≈ 0.104. The tail grows exponentially with the number of hops.

## Coordinated omission is not the whole story
Coordinated omission occurs when a test runner does not account for time spent waiting for a slow server. With fan‑out, the omission is compounded because the test sees the slowest hop, not the average. Even if you eliminate omission, the probability formula still applies.

## Hedged requests: duplicate the call, keep the first
A hedged request sends the same request to *M* instances of a service and returns the first response. The idea is to reduce the tail by trading extra load for speed. The expected latency of a hedged call is

\[\mathbb{E}[T] = \int_{0}^{\infty} \prod_{i=1}^{M} (1 - F_i(t))\,dt\]\n
where *F_i(t)* is the cumulative distribution of the *i*‑th instance. For identical, independent instances with an exponential tail, the expected latency drops roughly by a factor of \(\ln M\). In practice, a hedged call to two instances halves the tail for a 1 % slow probability.

### Trade‑offs
* **Cost** – double the traffic for the same operation. 
* **Side‑effects** – only idempotent calls should be hedged, otherwise duplicate writes may corrupt state.
* **Resource contention** – the service may throttle under the extra load.

## Tied requests: wait for all responses
Some flows require the results of all downstream calls, e.g. a distributed transaction that reads from two shards. The overall latency is the maximum of the individual latencies, so the tail is the tail of the slowest hop. If you can tolerate partial results, consider breaking the tie: return early and reconcile later.

## Latency budgets per hop
When you know the maximum acceptable request latency *L* and the number of hops *N*, a simple way to allocate budgets is to divide *L* evenly:

\[\text{Budget per hop} = \frac{L}{N}\]\n
For a 1 s request with 10 hops, each hop gets 100 ms. This is a crude approach; in reality you should allocate more budget to hops that historically have higher variance.

### Using a cumulative budget
Track the cumulative latency *C(t)* after each hop. If *C(t) > t \times \text{budget per hop}*, trigger a circuit breaker or drop the request. This protects the tail before it reaches the end.

## Practical checklist for engineers
| Step | What to do | Why it matters |
|------|------------|----------------|
| 1 | Estimate *p* for each hop from historical data | You need the base probability to calculate the tail |
| 2 | Compute \(1-(1-p)^N\) for the full path | Quantify how much the tail grows |
| 3 | Identify idempotent calls that can be hedged | Hedging reduces tail but only for safe calls |
| 4 | Set per‑hop budgets and enforce via circuit breakers | Prevent a single slow hop from dragging the whole request |
| 5 | Instrument per‑hop latencies in production | You need real data to adjust budgets |
| 6 | Review side‑effect safety before hedging | Avoid duplicate writes or state corruption |
| 7 | Use tied requests only when all results are required | Reduce tail by breaking ties when possible |

## Example: modelling fan‑out and hedging in k6
The following k6 script demonstrates a request that fans out to three services, hedges the second service, and ties the third:

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';

export let options = {
    vus: 200,
    duration: '30s',
    thresholds: {
        http_req_duration: ['p(99)<2000'],
    },
};

export default function () {
    // Step 1: call service A
    let resA = http.get('https://service-a/api');
    check(resA, { 'A OK': (r) => r.status === 200 });

    // Step 2: hedged call to service B
    let resB1 = http.get('https://service-b/api');
    let resB2 = http.get('https://service-b/api');
    let resB = resB1.duration < resB2.duration ? resB1 : resB2;
    check(resB, { 'B OK': (r) => r.status === 200 });

    // Step 3: tied call to service C
    let resC1 = http.get('https://service-c/api');
    let resC2 = http.get('https://service-c/api');
    // Wait for both
    let resC = [resC1, resC2];
    check(resC, { 'C OK': (r) => r.every((rr) => rr.status === 200) });

    sleep(1);
}
```

The script sends two parallel requests to service B and keeps the faster one. It sends two parallel requests to service C and waits for both. The thresholds ensure the p99 stays below 2 s.

## Takeaway
When a request fans out, the tail latency grows exponentially with the number of hops. Use probability to quantify the risk, hedge only idempotent calls, tie only when necessary, and allocate per‑hop latency budgets enforced by circuit breakers. With these practices you keep the p99 predictable even as the service mesh scales.
