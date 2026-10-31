---
title: Your 1% trace sample threw away the slow requests
date: 2026-11-12
summary: Head sampling keeps 1% of everything, including 1% of the requests you actually need to debug. How to keep every slow and failed trace, link metrics to traces with exemplars, and close the loop with logs and profiles.
tags: Performance, Observability, OpenTelemetry, Tracing
highlight: slow requests
linkedin: |
  The p99 panel spikes to 3 seconds. You open the tracing backend and every trace you have is fast.

  That is head sampling working as designed. A 1% sample keeps 1% of the slow requests too. At 200 req/s over 15 minutes, p99.9 is about 180 requests, so you expect to keep fewer than two of them.

  The fix is tail sampling in the OpenTelemetry Collector: wait for the trace to finish, then keep every slow or failed one plus a small random baseline. Storage grows by about 10% in that example, and you never lose the evidence again.

  Then link the layers. Exemplars take you from a histogram bucket to a trace, trace_id in logs takes you to the log lines, and span-linked profiles show the code that burned the time.

  The article has an interactive calculator for your own traffic and sampling rate.

  How many of your slowest requests from last week could you still open as a trace?

  #PerformanceEngineering #Observability #OpenTelemetry
---
The latency alert fires. The p99 panel shows a clean spike to 3 seconds, starting at 14:02. You open the tracing backend, filter for that window and sort by duration. The slowest trace you have took 240 ms.

Nothing is broken in the tracing pipeline. It is doing exactly what it was configured to do: keep 1% of traces, chosen before anyone knew which requests would be slow. Dashboards tell you *that* the tail moved. Only traces, logs and profiles tell you *why*, and only if you kept the right ones.

## Head sampling keeps 1% of the evidence

**Head sampling** decides at the root span, before the request has done any work. The OpenTelemetry SDK's `parentbased_traceidratio` sampler, set with `OTEL_TRACES_SAMPLER_ARG=0.01`, keeps a trace when its trace ID falls under the ratio. That decision knows nothing about latency or errors, so a 1% sample keeps about 1% of slow requests too.

The maths is unforgiving. Imagine 200 req/s for 15 minutes: 180,000 requests. The requests slower than p99.9 number 0.1% of that, so 180.

- Expected slow traces kept: 180 × 0.01 = 1.8.
- Probability of keeping at least one: 1 − (1 − 0.01)^180 ≈ 0.84.

So one time in six you have nothing, and the rest of the time you have one or two traces. That is not enough to tell a pattern from a coincidence.

<div class="widget" data-widget="sampling"><p><em>Interactive calculator: open this post on pawansinha.com.au to try it with your own numbers.</em></p></div>

## Tail sampling keeps what you need

**Tail sampling** decides after the trace is complete, so it can keep every trace that was slow or failed and a small random baseline of the rest. In the example above that stores about 1,800 baseline traces plus all 180 slow ones, roughly 10% more than head sampling, and you never lose the evidence.

It runs in the OpenTelemetry Collector as the `tail_sampling` processor, which ships in the contrib distribution (`otelcol-contrib`), not the core one. A minimal setup:

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  memory_limiter:
    check_interval: 1s
    limit_percentage: 80
    spike_limit_percentage: 20
  tail_sampling:
    decision_wait: 10s
    num_traces: 100000
    policies:
      - name: keep-errors
        type: status_code
        status_code:
          status_codes: [ERROR]
      - name: keep-slow
        type: latency
        latency:
          threshold_ms: 500
      - name: baseline
        type: probabilistic
        probabilistic:
          sampling_percentage: 1
  batch: {}

exporters:
  otlp/traces:
    endpoint: tempo:4317   # Tempo and Jaeger both accept OTLP natively
    tls:
      insecure: true
  prometheus:
    endpoint: 0.0.0.0:8889
    enable_open_metrics: true

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, tail_sampling, batch]
      exporters: [otlp/traces]
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [prometheus]
```

Policies are OR'ed: a trace that matches any of them is kept. Three things catch teams out:

- **The SDK must send everything.** If the services still head-sample at 1%, the collector only ever sees 1%. Leave the SDK on its default `parentbased_always_on` and let the collector decide.
- **All spans of a trace must reach the same collector.** With several collector replicas, put a first tier running the `loadbalancing` exporter, which routes by trace ID, in front of the sampling tier.
- **Memory is the cost.** The processor holds every in-flight trace for `decision_wait`. At 200 traces/s and 10 seconds that is 2,000 traces, comfortably under `num_traces`. Spans that arrive after the decision can miss it, so set `decision_wait` above your slowest normal request.

## Exemplars: from the histogram to the trace

An **exemplar** is a sample attached to a histogram bucket, carrying a trace ID and a value. It sits beside the series, not in its label set. That distinction matters. Never add `trace_id` as a metric label. Every request would create a new series and Prometheus memory would grow without bound.

How the exemplar is chosen depends on the library. Prometheus client libraries keep the most recent exemplar per bucket. OpenTelemetry SDKs apply an exemplar filter (the default, `trace_based`, only records measurements made inside a sampled span) and then a reservoir that picks which of those to keep. Neither guarantees the slowest request, which is another reason to keep every slow trace.

The query itself does not change. With the OTel HTTP semantic conventions, `http.server.request.duration` (in seconds) becomes this in Prometheus:

```promql
histogram_quantile(0.99, sum by (le) (rate(http_server_request_duration_seconds_bucket[5m])))
```

To see exemplars on it you need three things. Exemplars must be exposed in OpenMetrics format (hence `enable_open_metrics` above), Prometheus must run with `--enable-feature=exemplar-storage`, and the Grafana panel must have exemplars switched on in the query options, with the data source linked to your tracing backend. Click a dot at 3 seconds and you are in the trace.

One subtlety: with tail sampling, an exemplar can point to a fast trace the collector dropped. Exemplars from the slow buckets are the ones that resolve, because the latency policy kept those traces.

## High-cardinality data belongs in traces and logs

User IDs, session IDs, request IDs and tenant IDs are exactly what you need when one customer is slow. They belong in span attributes and log fields, where each value costs one record. As metric labels, each new value creates a new time series.

| Signal | Use for |
|--------|---------|
| Metric labels | Bounded values: route template, method, status class, region |
| Span attributes | User, tenant, order and request IDs, payload size, cache hit or miss |
| Log fields | The same IDs plus `trace_id` and `span_id` |

Keep routes as templates (`/orders/{id}`), never raw paths.

## Logs and profiles close the loop

OpenTelemetry SDKs and logging bridges (the Java agent's Logback and Log4j instrumentation, for example) inject `trace_id` and `span_id` into each log record. With those fields present, Grafana can jump from a trace span to its log lines and from a log line back to the trace.

When the trace shows a span that was slow but made no slow downstream calls, the time went inside the process. That is where **continuous profiling** earns its place: always-on, low-overhead sampling of stacks, stored over time. Grafana Pyroscope and Parca are common backends. In Go the data comes from the runtime profiler, usually exposed with `net/http/pprof`. In Java use async-profiler or JDK Flight Recorder. Some integrations, Pyroscope's span profiles among them, tag samples with the span ID so you can open the profile for one slow trace. OpenTelemetry also has a profiling signal, but it is still maturing, so check its status for your language before you depend on it.

Pick the Java profiler carefully. **Safepoint bias** is a sampling-profiler flaw: profilers that collect stacks through safepoint-based APIs only see threads when they reach a safepoint poll, so a hot loop without one gets blamed on whatever code comes next. async-profiler (via `AsyncGetCallTrace` and perf_events) and JFR sample threads without waiting for a safepoint, so they avoid it.

And check the load tool before you trust the reproduction. A closed-loop generator waits for each response before sending the next request, so during a stall it sends fewer requests and under-records latency. That is coordinated omission. An open-model, arrival-rate generator avoids it.

## A proof workflow

1. Confirm the spike on the histogram, then click a slow-bucket exemplar.
2. In the trace, find the span whose own time (minus its children) dominates.
3. Jump to that span's logs: retries, timeouts, pool waits.
4. If the time is in-process, open the profile for that span or window.
5. State the hypothesis with a number, fix one thing, re-run the same open-model test and compare the histograms.

## Decision rule

If you can afford to store every trace, store every trace. If you cannot, sample at the tail, never only at the head: keep all errors, all requests over your latency objective, and a 1–5% baseline for comparison. Head sampling is fine for estimating the median. It is the wrong tool for the tail.
