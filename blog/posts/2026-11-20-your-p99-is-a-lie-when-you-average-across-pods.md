---
title: Your p99 is a lie when you average across pods
date: 2026-11-20
summary: Why averaging p99 across pods, load generators or time windows gives a latency no request had, how to merge histograms in Prometheus, how big histogram_quantile's bucket error really is, and what native histograms change.
description: Averaging p99 across pods gives a number no request had. Merge histograms instead, size buckets for your SLO, and know histogram_quantile's error.
tags: Performance, Prometheus, k6
highlight: average
linkedin: |
  Four pods. The dashboard averages their p99 and shows 315 ms. The real p99 across all requests is 1.2 seconds.

  Percentiles don't average. The busiest pod served 70% of the traffic and 5% of its requests were slow. The other three were fine. An average gives each pod one equal vote, so the busy pod's tail gets diluted by pods that barely served anything.

  The fix is old and simple: merge the histograms (add the bucket counts across pods), then take the quantile once. Same rule when you run k6 on several load generators: never average their p95s.

  The article has an interactive calculator: move the traffic split and watch the averaged p99 drift away from the real one.

  Where in your dashboards is a percentile being averaged right now?

  #PerformanceEngineering #Observability #SRE
---
Your service runs on four pods. Grafana shows p99 latency at 315 ms, comfortably inside the 500 ms SLO. Support tickets say checkout hangs for more than a second. Both are telling the truth about something. Only one of them is telling you about your users.

The dashboard panel takes each pod's p99 and averages them. That number is not a percentile of anything.

## Percentiles don't average

A percentile is a position in a sorted list of samples. The p99 of a combined set depends on how many samples each part contributes and where they fall, and an average of per-part percentiles throws both away.

Here is a worked example. Pod A is the busiest pod. Its keys are hot, its node is noisy, or it got the long-lived connections.

| Pod | Requests | Slow (1,200 ms) | Pod p99 |
|---|---|---|---|
| A | 7,000 | 350 (5%) | 1,200 ms |
| B | 1,000 | 0 | 20 ms |
| C | 1,000 | 0 | 20 ms |
| D | 1,000 | 0 | 20 ms |

Averaging the four p99 values gives (1,200 + 20 + 20 + 20) / 4 = 315 ms.

Now merge the requests. There are 10,000 in total and 350 of them are slow, which is 3.5%. More than 1% of requests are slow, so the real p99 is 1,200 ms. The averaged value sits at 315 ms, a latency that not a single request experienced.

It goes wrong in the other direction too. If the slow pod were the quiet one, its single vote would drag the average up while its few slow requests barely touch the real p99.

One property is useful when you only have per-pod percentiles. The merged quantile always lies between the lowest and the highest per-pod quantile, because the combined distribution is a weighted mix of the parts. **The worst pod's p99 is a safe upper bound.** The average is not a bound of any kind.

<div class="widget" data-widget="pctmerge"><p><em>Interactive calculator: open this post on pawansinha.com.au to try it with your own numbers.</em></p></div>

The same mistake shows up in three other places:

- **Time windows.** The p99 of an hour is not the average of sixty one-minute p99s. One busy minute with a long tail gets 1/60 of the vote.
- **Load generators.** Run k6 on five machines and each prints its own p95. Averaging them has exactly the pod problem. Recompute from raw samples, or send the metrics somewhere that merges them.
- **Services.** "Average p99 across our APIs" mixes endpoints with completely different shapes. Report them separately, or merge only endpoints that share an SLO.

## Merge histograms, then take the quantile

A histogram counts samples per bucket. Two histograms with the same bucket boundaries merge by adding the counts bucket by bucket. The merged histogram is exactly the histogram of all samples together, so any quantile you take from it is honest (up to bucket resolution, covered below).

In Prometheus, classic histograms expose one counter per bucket, labelled with its upper bound `le`. Merge across pods by summing the rates and keeping `le`:

```promql
histogram_quantile(
  0.99,
  sum by (le) (rate(http_request_duration_seconds_bucket{job="checkout"}[5m]))
)
```

Two details matter.

- **Keep `le` in the `by` clause.** Drop it and you sum all buckets into one number, which is meaningless. Keep other labels (route, status) only if you want a separate quantile per value.
- **Every pod must use identical bucket boundaries.** If one deployment changed its buckets, the sum is silently wrong until the old pods are gone.

Summaries (the Prometheus `summary` type) calculate quantiles inside each pod. You cannot merge them correctly, and averaging their `quantile="0.99"` series is exactly the mistake above. For anything you want to aggregate across instances, use histograms.

Other mergeable structures follow the same rule: HdrHistogram, t-digest and DDSketch all merge before you query. Store the sketch, never the percentile.

## How wrong is histogram_quantile?

`histogram_quantile` finds the bucket that contains the requested rank and interpolates linearly inside it, assuming samples are spread evenly across the bucket. The error is therefore bounded by **the width of the bucket the quantile falls in**, not by the widest bucket overall.

A worked example. Buckets at 0.1, 0.25, 0.5, 1, 2.5 and 5 seconds. Your true p99 is 1.1 s, which falls in the 1 to 2.5 s bucket. Depending on how the samples sit inside it, the estimate can land anywhere from 1 s to 2.5 s. That is up to 1.4 s of error on a 1.1 s value.

Two more traps:

- **The +Inf bucket.** If the quantile lands above your highest finite boundary, Prometheus returns that boundary. With a top bucket of 5 s, a true p99 of 30 s reports as 5 s. Make sure your largest finite bucket is above your client timeout.
- **Boundaries away from the SLO.** If your SLO is 300 ms and the nearest boundaries are 250 ms and 500 ms, you cannot say whether you met it. Put a boundary exactly at each SLO threshold. Then "share of requests under 300 ms" is an exact ratio of two counters, with no interpolation at all:

```promql
sum(rate(http_request_duration_seconds_bucket{le="0.3"}[5m]))
/
sum(rate(http_request_duration_seconds_count[5m]))
```

For SLOs I'd alert on that ratio rather than on an interpolated p99. It is exact, it merges correctly, and it answers the question the SLO actually asks.

## Native histograms

Prometheus added native histograms as an experimental feature in version 2.40, behind a feature flag. A native histogram stores all of its buckets inside a single series, using exponential bucket boundaries chosen automatically, so resolution is high everywhere and you stop hand-picking `le` values. Check your Prometheus version's documentation for its current status before you depend on it.

The query changes too. You query the histogram metric itself, without the `_bucket` suffix and without `le`:

```promql
histogram_quantile(0.99, sum(rate(http_request_duration_seconds{job="checkout"}[5m])))
```

The same merging rule still applies. You sum the histograms, then take the quantile.

k6 can send its trend metrics to Prometheus as native histograms through its remote-write output (`K6_PROMETHEUS_RW_TREND_AS_NATIVE_HISTOGRAM=true`). That is a clean way to get one correct p95 from several load generators.

## Checklist

1. Search your dashboards for `avg(` or `avg_over_time(` wrapped around anything named quantile, p95 or p99. Each one is the bug.
2. Replace them with `histogram_quantile` over `sum by (le)` of the bucket rates.
3. Use the same bucket boundaries on every instance, and put one exactly at each SLO threshold.
4. Make the highest finite bucket larger than your client timeout.
5. Alert on the share of requests under the threshold, not on interpolated p99.
6. In distributed load tests, merge raw results or histograms. Never average the per-machine percentiles.
7. When you only have per-pod percentiles, report the worst pod's value as the upper bound.

An averaged percentile is not a rough version of the truth. It is a different number that happens to have the same units.
