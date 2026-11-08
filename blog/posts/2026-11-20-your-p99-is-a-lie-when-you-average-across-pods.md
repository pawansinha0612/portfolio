---
title: Your p99 is a lie when you average across pods
date: 2026-11-20
summary: Learn why averaging p99 across pods or time windows skews results and how to merge histograms correctly with Prometheus and k6.
description: Avoid percentile averaging pitfalls – use mergeable histograms, understand Prometheus histogram_quantile bucket error and native histograms.
tags: Performance, Prometheus, k6
linkedin: |
  A test shows a 10 ms p99, but in production the tail is 900 ms – why? The culprit is averaging percentiles across pods. The fix is to merge histograms before calculating the percentile. In practice, use Prometheus’ `sum` aggregation or k6’s mergeable histograms, then apply `histogram_quantile`. A key detail is bucket width: the approximation error can be as large as the widest bucket. Have you ever averaged percentiles in your metrics pipeline? What steps do you take to avoid this pitfall?
---
## 1. The problem you face today
You run a load test on a micro‑service that is spread across four pods. Each pod reports a p99 of 10 ms. Your dashboard shows a global p99 of 10 ms. You feel confident. Then you roll the service out to production and the 99th percentile spikes to 900 ms. The test data was wrong.

## 2. Percentiles are not additive
A percentile is a position in a sorted list. The 99th percentile of a combined set is not the average of the 99th percentiles of the parts. If two pods have different tail behaviours, the global tail can be much higher than any local tail.

### 2.1 Example with two pods
Assume pod A receives 1000 requests and 990 of them finish in 10 ms, 10 finish in 900 ms. The 99th percentile of pod A is 10 ms. Pod B receives 1000 requests and 990 finish in 10 ms, 10 finish in 100 ms. The 99th percentile of pod B is also 10 ms.

If you average the two p99 values you get 10 ms. But the combined set has 2000 requests, 1980 finish in 10 ms and 20 finish in 900 ms. The 99th percentile of the merged set is 900 ms. The average of percentiles is therefore meaningless.

## 3. Mergeable histograms – the correct approach
A histogram is a set of buckets that count how many samples fall into each bucket. A mergeable histogram can be combined by adding bucket counts, the total sum and the total count. After merging you can compute any percentile from the combined histogram.

### 3.1 Prometheus histogram
Prometheus stores a histogram as a set of samples named `http_request_duration_seconds_bucket{le="x"}` for each bucket boundary `x`. The special bucket with `le="+Inf"` holds the total count. The sum of all bucket counts equals the total count.

To merge histograms from multiple pods you use the `sum` aggregation across the `le` label:

```
# Merge across pods
sum(rate(http_request_duration_seconds_bucket[5m])) by (le)
```

This query adds the counts of each bucket from all pods. The result is a single histogram that represents the combined workload.

### 3.2 k6 mergeable histograms
k6 exports histograms in JSON format. Each histogram contains `buckets`, `sum` and `count`. To merge, add the bucket counts, the sums and the counts. k6 provides a helper script that performs this merge.

```js
// merge.js – a minimal example
const fs = require('fs');
const files = ['pod1.json','pod2.json'];
const merged = {buckets:{}, sum:0, count:0};
files.forEach(file=>{
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  Object.entries(data.buckets).forEach(([le, cnt])=>{
    merged.buckets[le] = (merged.buckets[le]||0)+cnt;
  });
  merged.sum += data.sum;
  merged.count += data.count;
});
fs.writeFileSync('merged.json', JSON.stringify(merged, null, 2));
```

After merging you can apply a percentile calculation algorithm such as the one used by k6’s `histogram_quantile`.

## 4. Prometheus `histogram_quantile` and bucket error
The `histogram_quantile` function approximates a percentile from a histogram. It first interpolates within a bucket and then returns a value. The error of this approximation is bounded by the bucket width.

**Bucket error definition** – the maximum difference between the true percentile and the value returned by `histogram_quantile` is equal to the bucket width.

### 4.1 Calculating the error
Suppose your histogram has buckets at 0.1, 0.2, 0.5, 1, 2, 5 seconds. The widest bucket is 5 s. If the true 99th percentile lies in the bucket [2, 5] the error can be up to 3 s.

The error bound formula is:

```
error ≤ max_{i} (bucket_i.upper - bucket_i.lower)
```

### 4.2 Practical impact
If your bucket boundaries are too coarse you may hide a long tail. For example, with buckets 0.5 s and 5 s a 99th percentile of 4.8 s will be reported as 5 s, but the true value could be 4.8 s. The error is 0.2 s, which is acceptable for many cases but not for latency‑sensitive services.

### 4.3 Choosing bucket boundaries
A common pattern is to use log‑scale buckets for latency metrics: 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10 seconds. This gives a fine resolution in the low‑latency region while keeping the number of buckets manageable.

## 5. Native histograms in Prometheus 2.15+
Prometheus 2.15 introduced a native histogram type that stores bucket counts, sum and count in a single time series. The `histogram_quantile` function works on this native type without the need for the `le` label. It is more efficient and less error‑prone.

**Key differences**:
- **Native**: one time series per bucket, no label explosion.
- **Legacy**: separate time series per bucket with `le` label.

When using native histograms you still face the bucket error, but the query syntax is simpler:

```
histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket[5m])) by (le))
```

becomes

```
histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket[5m])))
```

## 6. Checklist for correct percentile reporting
| Step | Action | Tool | Notes |
|------|--------|------|-------|
| 1 | Export histograms from each pod | Prometheus or k6 | Ensure `le` buckets are identical |
| 2 | Merge histograms using `sum` aggregation | Prometheus | Use `by (le)` to keep bucket boundaries |
| 3 | Verify bucket boundaries are fine‑grained | Manual review | Aim for log‑scale buckets |
| 4 | Compute percentile with `histogram_quantile` | Prometheus | Accept bucket error ≤ bucket width |
| 5 | Validate against raw data | Sampling | Spot‑check with a few requests |

## 7. Common mistakes to avoid
- **Averaging percentiles**: always merge histograms first.
- **Ignoring bucket width**: choose boundaries that keep error below your SLA tolerance.
- **Using legacy histograms with `le` labels in large services**: label explosion can hurt scrape performance.
- **Assuming `histogram_quantile` is exact**: it is an approximation; understand its error.

## 8. Takeaway
Averaging p99 across pods or time windows is mathematically incorrect. The right way is to merge the histograms first and then compute the percentile on the combined distribution. Pay attention to bucket boundaries to keep the approximation error within acceptable limits.

By following the checklist above you can trust that the latency metrics you expose to stakeholders reflect the true behaviour of your system.
