---
title: Your capacity plan fails when utilisation hits 80 %
date: 2026-11-07
summary: Learn why response time spikes before utilisation reaches 100 %, how to use the M/M/1 and Kingman formulas, and what variability really costs.
tags: Performance, Queueing, Capacity Planning
linkedin: |
  Your load test shows a clean 5 ms p99 but production spikes to seconds. Why? The knee in response time appears long before utilisation hits 100 % because queueing theory predicts a hyperbolic rise; Kingman’s formula quantifies the cost of variability. How do you currently account for burstiness when sizing capacity?
---
Your load test shows 99th percentile latency of 5 ms. In production, the same endpoint spikes to 2 seconds. You suspect the load test is fine but the real traffic is different. The root cause is hidden in queueing theory.

Queueing theory gives a clean way to link utilisation to response time.

Consider an M/M/1 queue, the simplest model where arrivals follow a Poisson process and service times are exponential.

The mean response time is R = S / (1 - U) where S is the mean service time and U is utilisation.

For example, if the average service time is 10 ms and the utilisation is 80 %, the mean response time becomes 10 / (1 - 0.8) = 50 ms.

The knee appears when the denominator shrinks towards zero.

Why does the knee arrive before 100 % utilisation? Because the M/M/1 formula already predicts a steep rise as U approaches one. The response time grows hyperbolically, not linearly.

In practice, you rarely reach 100 % utilisation. The queue starts to explode when U is around 0.8–0.9, depending on the variability of the workload.

Kingman’s bound gives a more realistic estimate for general G/G/1 queues.

The formula is R ≈ S + ((C_s^2 + C_a^2) / 2) * λ * S^2 / (1 - U).

Here C_s is the coefficient of variation of the service time, C_a that of inter‑arrival time, λ is the arrival rate and S is the mean service time.

For an exponential service (C_s = 1) and Poisson arrivals (C_a = 1) the Kingman term reduces to the M/M/1 result.

If the workload is bursty and C_a grows to 2, the response time jumps by a factor of (1 + C_a^2)/2 = 2.5.

The cost of variability is therefore quadratic in the coefficient of variation.

Detecting the knee in real data is straightforward: plot the 95th percentile latency against utilisation.

In Grafana you can query the rate of requests and the average latency from a Prometheus exporter.

A simple query looks like this:

```
# Query utilisation and latency from Prometheus
rate(http_requests_total[1m]) by (instance)
avg_over_time(http_request_duration_seconds_sum[1m]) by (instance)
```

The output will show a flat region followed by a steep climb.

| Utilisation | Response Time (ms) |
|--------------|--------------------|
| 50 % | 20 |
| 70 % | 33.3 |
| 80 % | 50 |
| 90 % | 100 |
| 95 % | 200 |

Use a checklist when planning capacity:

- Measure the true utilisation of the critical path, not just the CPU.
- Record the coefficient of variation of service times and inter‑arrival times.
- Compute the Kingman estimate and compare it to the measured latency.
- Keep utilisation below 70 % for safety margin.
- If you need tighter budgets, add a buffer of 20–30 % capacity.
- Validate the model by running a small load test that mimics the burstiness of production.
- Avoid coordinated omission by using k6’s built‑in pacing or by injecting realistic delays.

When you apply these steps you will see that the knee is not a mystery but a predictable consequence of queueing.

Remember that the 100 % utilisation line is a theoretical limit; in real systems the queue collapses long before that.

In summary, use the M/M/1 and Kingman formulas to set utilisation targets, monitor variability, and catch the knee early.

Your capacity plan will then reflect the true cost of variability, not just a flat utilisation target.
