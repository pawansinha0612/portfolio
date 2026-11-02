---
title: Your capacity plan breaks long before 100% utilisation
date: 2026-11-07
summary: Why response time bends upward long before a server is full, how Kingman's formula prices the cost of bursty traffic, how many servers change the answer, and how to measure and load test the inputs.
description: Why response time climbs long before 100% utilisation, how Kingman's formula prices bursty traffic, and why constant-rate load tests miss it.
tags: Performance, Queueing, Capacity Planning
highlight: utilisation
linkedin: |
  Your load test holds a 5 ms p99. Production, at the same average traffic, spikes to 2 seconds. Same code, CPU at 65%.

  The difference is variability. Kingman's formula for a single-server queue says the waiting time is roughly U/(1−U) × (Ca² + Cs²)/2 × S. Variability multiplies the wait, not the work.

  Worked example: 10 ms service time at 80% utilisation. A constant-rate load test (Ca ≈ 0) predicts a 30 ms mean. Bursty production traffic (Ca = 2) gives 110 ms. Same server, same average load.

  And "keep it under 70%" is not a universal rule. Eight workers sharing one queue tolerate far more than one single-threaded bottleneck does.

  The article has an interactive calculator: plug in your service time, utilisation and variability and see where your knee is.

  Do you measure the burstiness of your traffic, or only its average?

  #PerformanceEngineering #CapacityPlanning #Queueing
---
Your load test holds 1,200 req/s with a steady 5 ms p99. Production averages the same 1,200 req/s, and twice an hour the same endpoint spikes to 2 seconds. Nobody changed the code. The CPU graph says 65%.

The test and production differ in something the dashboard doesn't show: variability. The test sent requests at a perfectly even rate. Production arrives in clumps, and for a few minutes at a time it runs much hotter than the hourly average suggests. Queueing theory predicts exactly this, and it gives you numbers you can plan with.

## Why latency bends long before 100%

Start with the simplest model, **M/M/1**: Poisson arrivals, exponentially distributed service times, one server with one queue. Utilisation is U = λ × S, the arrival rate times the mean service time.

Mean response time is R = S / (1 − U), of which the time spent waiting in the queue is Wq = U / (1 − U) × S.

With S = 10 ms:

| Utilisation | M/M/1 response time | Constant-rate test (Ca = 0) | Bursty arrivals (Ca = 2) |
|-------------|--------------------|-----------------------------|--------------------------|
| 50% | 20 ms | 15 ms | 35 ms |
| 70% | 33 ms | 22 ms | 68 ms |
| 80% | 50 ms | 30 ms | 110 ms |
| 90% | 100 ms | 55 ms | 235 ms |
| 95% | 200 ms | 105 ms | 485 ms |

(The last two columns assume Cs = 1 and come from Kingman's formula below.)

There is no sharp corner in the maths. The curve is a hyperbola, and its slope is S / (1 − U)². At 80% each extra percentage point of utilisation adds about 2.5 ms. At 90% it adds 10 ms. The "knee" is where that slope starts to hurt your latency budget, and on a single server it arrives early: mean response time has already doubled at 50%.

## Kingman: variability multiplies the wait, not the work

Real traffic is not Poisson and real service times are not exponential. **Kingman's formula** approximates the mean waiting time of a G/G/1 queue (general arrivals, general service times, one server):

Wq ≈ (U / (1 − U)) × ((Ca² + Cs²) / 2) × S

R = S + Wq

Ca is the coefficient of variation of inter-arrival times (standard deviation divided by mean). Cs is the same for service times. Poisson arrivals and exponential service give Ca = Cs = 1, and the formula collapses back to M/M/1. With Ca = 1 it matches the exact Pollaczek–Khinchine result for M/G/1. Otherwise it is an approximation that is most accurate at high utilisation, which is the region you care about.

The variability factor scales the queueing delay only. The 10 ms of actual work does not get slower because traffic is bursty.

Worked example at S = 10 ms and U = 80%:

- M/M/1: Wq = 4 × 10 = 40 ms, so R = 50 ms.
- Bursty arrivals, Ca = 2 and Cs = 1: the factor is (4 + 1) / 2 = 2.5. Wq = 100 ms, so R = 110 ms. Response time grew 2.2×, not 2.5×.
- Constant-rate load test, Ca ≈ 0 and Cs = 1: the factor is 0.5. Wq = 20 ms, so R = 30 ms.

Same server, same average utilisation, and the test under-predicts production by almost 4×. Those are means. Tail percentiles stretch further, which is how a 5 ms p99 in test becomes seconds in production.

Two decision rules fall out of the formula. Write k = (Ca² + Cs²) / 2.

- Response time doubles the service time when U = 1 / (1 + k). That is 50% for M/M/1, 67% for a constant-rate test and only 29% for Ca = 2.
- For a latency budget of m × S, the highest safe utilisation is U = (m − 1) / (m − 1 + k). A 50 ms budget on a 10 ms service is m = 5. M/M/1 allows 80%. With Ca = 2 the limit drops to 62%.

<div class="widget" data-widget="queue"><p><em>Interactive calculator: open this post on pawansinha.com.au to try it with your own numbers.</em></p></div>

## One server or many changes the answer

M/M/1 describes one server with its own queue. A pool of c workers pulling from one shared queue, such as a thread pool, is **M/M/c**, and it tolerates far more. With S = 10 ms at 80% utilisation, M/M/1 waits 40 ms on average. M/M/8 waits under 3 ms, from the Erlang C formula.

Mean response time doubles at about 50% utilisation for one server, 71% for two, 84% for four and 91% for eight. For general traffic, the Allen–Cunneen approximation multiplies the M/M/c wait by the same (Ca² + Cs²) / 2 factor, and the widget uses it when you add servers.

So "keep utilisation below 70%" is too strict for 32 workers sharing a queue and too loose for a single-threaded bottleneck such as a hot lock, one Kafka partition or Redis, which executes commands on a single main thread. One trap: ten pods behind a random load balancer are ten separate M/M/1 queues, not one M/M/10. The sharing has to be real.

## Measure the inputs

Utilisation must be for the bottleneck resource, measured over the burst window. A 1-hour average of 60% can hide minutes at 95%. For CPU on Kubernetes, with cAdvisor and kube-state-metrics:

```promql
# CPU utilisation per pod against its CPU limit
sum by (namespace, pod) (rate(container_cpu_usage_seconds_total{container="api"}[1m]))
  /
sum by (namespace, pod) (kube_pod_container_resource_limits{resource="cpu", container="api"})

# Mean response time: total time divided by request count
sum(rate(http_request_duration_seconds_sum{job="api"}[5m]))
  /
sum(rate(http_request_duration_seconds_count{job="api"}[5m]))

# p95 from histogram buckets
histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{job="api"}[5m])))
```

If the bottleneck is a pool rather than CPU, utilisation is busy workers over pool size, for example `hikaricp_connections_active / hikaricp_connections_max`. Be aware that server-side timers often start after the request leaves the accept queue, so they can miss part of the queueing delay.

Ca and Cs come from request logs. Export arrival timestamp and handler time (excluding queueing) in seconds for a few busy minutes, then:

```python
import csv
import statistics as st

with open("requests.csv") as f:
    rows = sorted((float(t), float(d)) for t, d in csv.reader(f))
gaps = [b[0] - a[0] for a, b in zip(rows, rows[1:])]
svc = [d for _, d in rows]
ca = st.pstdev(gaps) / st.mean(gaps)
cs = st.pstdev(svc) / st.mean(svc)
print(f"Ca={ca:.2f} Cs={cs:.2f} factor={(ca**2 + cs**2) / 2:.2f}")
```

## Load test with the burstiness you will get

Coordinated omission is solved by an open-model executor such as k6's `constant-arrival-rate` or `ramping-arrival-rate`, so the tool keeps sending when the system slows down. But those executors start iterations at an even rate, which means Ca ≈ 0, the most flattering arrival pattern there is. Burstiness has to be modelled on purpose:

```javascript
import http from 'k6/http';

const stages = [];
for (let i = 0; i < 10; i++) {
  stages.push({ target: 1000, duration: '50s' });
  stages.push({ target: 1400, duration: '1s' });
  stages.push({ target: 1400, duration: '8s' });
  stages.push({ target: 1000, duration: '1s' });
}

export const options = {
  scenarios: {
    bursty: {
      executor: 'ramping-arrival-rate',
      startRate: 1000,
      timeUnit: '1s',
      preAllocatedVUs: 200,
      maxVUs: 2000,
      stages: stages,
    },
  },
};

export default function () {
  http.get('https://test.example.com/api/checkout');
}
```

This adds a 40% surge for about 10 seconds every minute. Watch `dropped_iterations`: if k6 runs out of VUs it skips iterations, and you are back to under-reporting.

## Checklist

1. Find the bottleneck resource and measure its utilisation over a 1-minute window, not an hourly average.
2. Measure Ca and Cs from logs, using handler time rather than end-to-end latency for Cs.
3. Set the utilisation target from your latency budget with (m − 1) / (m − 1 + k), adjusted for how many servers genuinely share a queue.
4. Load test with an open model and deliberate bursts, and check `dropped_iterations`.
5. Compare measured mean latency with the prediction. If it is much higher, there is a queue you have not modelled: a connection pool, a lock or a GC pause.
