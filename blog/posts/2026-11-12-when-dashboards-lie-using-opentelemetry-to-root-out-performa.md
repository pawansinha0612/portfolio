---
title: When Dashboards Lie: Using OpenTelemetry to Root Out Performance Anomalies
date: 2026-11-12
summary: Dashboards can mask latency spikes. Learn how to join traces, metrics, logs and continuous profiling to surface real performance issues.
tags: Performance, Observability, OpenTelemetry, Profiling
linkedin: |
  Dashboards can hide the worst latency spikes. The key to finding them is to stitch together traces, metrics, logs and continuous profiling using a common trace ID. By ensuring every span, metric and log carries the trace ID you can jump from a histogram bucket to the exact request that caused the spike, to the log that recorded the error, to the profiler that showed a CPU hotspot. This end‑to‑end observability lets you prove a hypothesis, apply a fix, and verify that the fix actually resolved the issue. Have you ever seen a dramatic p99 jump from 1 ms in tests to 9 s in production? What technique did you use to track it down?
---
## The Problem
You run a load test that reports a p99 latency of 1 ms. In production the p99 is 9 s. The dashboards look fine. The real issue is hidden because the data is incomplete. The root cause is a subtle latency spike that only shows up under real traffic conditions.

## Why Dashboards Fail
Dashboards aggregate metrics across services. They usually show the 95‑th or 99‑th percentile of a histogram bucket. They ignore the trace that caused the spike. They do not surface the high‑cardinality data that can explain why a single request behaved badly. They also miss CPU or memory pressure that only appears when many requests run concurrently.

## OpenTelemetry as the Glue
OpenTelemetry (OTel) provides a common data model for traces, metrics and logs. A trace is a tree of spans that represent a single request. Each span has a unique span ID and a trace ID that is shared across services. Metrics are time‑series data, often stored in Prometheus. Logs are structured records that can carry the trace ID.

By ensuring every span, metric and log carries the same trace ID you can join them at query time. The trace ID becomes the key that stitches together the full picture of a request.

### Exemplar Selection
A histogram bucket can carry an exemplar, a single sample that represents the bucket. The exemplar is chosen by the exporter. A common strategy is to pick the sample with the highest latency in the bucket. The exemplar includes the trace ID. When you view the histogram in Grafana you can click the exemplar and jump straight to the trace that produced it.

#### PromQL Example
```promql
sum(rate(http_request_duration_seconds_bucket{service="api"}[5m])) by (le, trace_id)
```
This query returns the rate of requests per bucket, annotated with the trace ID of the exemplar.  The `le` label is the bucket upper bound.

### High‑Cardinality Data
User IDs, session IDs and request IDs are useful for debugging but they explode cardinality. In a typical service you may see 10 000 unique users per minute. Prometheus cannot store that many series. The solution is to bucket or drop the high‑cardinality label. For example:

| Label | Strategy |
|-------|----------|
| user_id | drop if > 1000 distinct values |
| session_id | bucket into 10‑minute windows |
| request_id | drop entirely |

Dropping or bucketing reduces memory pressure but you still keep the trace ID so you can correlate the sample later.

## Coordinated Omission and Safepoint Bias
When a load generator keeps a fixed request rate, a slow request can cause the generator to queue the next request. The queue time is not measured as part of the request latency. This is coordinated omission. It hides the true latency profile.

Safepoint bias occurs in garbage‑collected runtimes. A safepoint pauses all Java threads for a GC pause. If you only measure wall‑clock time you see the pause. If you measure CPU time you miss it. The correct approach is to collect both CPU and wall‑clock times and to use a profiler that reports GC pauses.

## Continuous Profiling
Continuous profiling captures CPU, memory and GC usage over time. In Go you can use `pprof` with the `--pprof` flag. In Java you can use `async-profiler`. OpenTelemetry Collector can export a pprof payload to a storage backend.

A typical collector configuration for continuous profiling looks like this:

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317

exporters:
  otlp:
    endpoint: jaeger:14250
    insecure: true
  otlp/pprof:
    endpoint: prometheus:9090
    insecure: true
    timeout: 10s

service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [otlp]
    metrics:
      receivers: [otlp]
      exporters: [otlp/pprof]
```

The pprof exporter writes a time‑series of CPU usage per goroutine or thread. By correlating that with the trace ID you can see which goroutine was busy during a latency spike.

## How to Prove a Hypothesis
1. **Capture a trace** that shows the high latency. Look at the span tree for blocking calls.
2. **Check the exemplar** in the histogram. Verify that the exemplar trace ID matches the trace you captured.
3. **Inspect logs** that have the same trace ID. Look for error messages or warnings.
4. **Run the profiler** for the time window of the trace. Identify CPU hotspots or GC pauses.
5. **Apply a fix** such as adding a cache or increasing thread pool size.
6. **Re‑run the load test** and compare the histogram with and without the fix. The exemplar should now point to a lower latency.

## Checklist for Observability Integration
| Step | What to Verify | Why |
|------|-----------------|-----|
| Traces | Every service exports trace IDs | Enables cross‑service correlation |
| Metrics | Histograms use exemplar strategy | Provides a sample trace for each bucket |
| Logs | Structured logs carry trace ID | Allows log‑to‑trace correlation |
| High‑cardinality | Labels are bucketed or dropped | Prevents Prometheus cardinality explosion |
| Profiling | Continuous profiler runs on all nodes | Detects CPU, memory, GC issues |
| Query | PromQL includes trace_id label | Enables exemplar extraction |
| Dashboard | Exemplar panel linked to Jaeger | Quick drill‑down |

## Common Mistakes to Avoid
- **Relying on a single metric** such as average latency. The tail can hide real problems.
- **Ignoring trace IDs** in logs. Structured logs are useless if you cannot join them.
- **Using default histogram buckets** that do not match your latency distribution. Tail buckets should be fine‑grained.
- **Leaving high‑cardinality labels in metrics**. The system will crash under load.
- **Not sampling traces**. A 1 % sample may miss the worst case. Use a higher sample or exemplar strategy.
- **Assuming continuous profiling is optional**. In many cases GC pauses are the root cause of latency spikes.

## Conclusion
Dashboards give you a surface view. To uncover the real performance issues you must weave together traces, metrics, logs and continuous profiling. The trace ID is the glue that lets you jump from a histogram bucket to the exact request that caused the spike, to the log that recorded the error, to the profiler that showed a CPU hotspot. With this end‑to‑end observability you can prove hypotheses, apply fixes and verify that the fix actually resolved the problem.

## Takeaway
If your p99 latency jumps from 1 ms in tests to 9 s in production, look for coordinated omission, high‑cardinality data, and missing exemplars. Connect the dots with trace IDs and continuous profiling.
