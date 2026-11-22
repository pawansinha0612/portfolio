---
title: Your APM agent eats 30% CPU and you don't know why
date: 2026-11-28
summary: A practical comparison of Dynatrace, Datadog, New Relic, Grafana and OpenTelemetry covering agent overhead, sampling defaults, pricing at scale and lock‑in risk.
description: Compare APM tools on overhead, sampling, cost and vendor lock‑in to pick the right stack.
tags: Performance, Observability, OpenTelemetry, Cost
repost: What's your APM agent CPU overhead at 100% sampling under load?
linkedin: |
  Your APM agent can silently consume 30 percent of CPU while only sampling one percent of traces. The fix is not a bigger box but a deliberate choice of instrumentation, sampling policy and backend pricing. Run a ten minute load test with the agent at full sampling, measure the overhead, then compare the per span cost against your projected trace volume. Which APM stack are you evaluating right now?
---
Your production cluster spikes to 90 percent CPU after you enable a new APM agent. The dashboard shows latency dropping but the error rate climbs. You realise the agent is sampling only one percent of traces and the overhead is eating your headroom.

## The hidden cost of agents
Agent overhead is the extra CPU, memory and network a monitoring library consumes while it instruments your code. A Java agent that rewrites bytecode at class load can add 10 to 30 percent CPU on a busy service. An eBPF based agent that attaches to kernel tracepoints typically stays under five percent but requires a recent kernel and root privileges. Dynatrace OneAgent uses a combination of bytecode instrumentation and eBPF. Datadog APM relies on language specific libraries that instrument at runtime. New Relic uses a similar library approach. The Grafana stack does not ship an agent; you decide which OpenTelemetry collector or sidecar to run.

## Sampling is not free
Sampling reduces the volume of spans sent to the backend. Probabilistic sampling keeps a fixed percentage of traces. Tail based sampling decides after a request finishes whether to keep it based on latency or error status. Both add CPU work because the agent must evaluate the sampling decision for every request. If you set a one percent probabilistic rate on a service handling 100 000 requests per second the agent still processes 100 000 decisions per second. Tail based sampling needs to buffer spans until the request ends which increases memory pressure. Coordinated omission occurs when the sampler drops long requests and the remaining data no longer represents the true latency distribution. Gil Tene showed that this bias can hide the very outliers you care about.

## Pricing models at scale
Dynatrace charges per host unit with a minimum commit. A host unit roughly equals one vCPU. At 500 hosts the annual bill can exceed one million dollars. Datadog bills per host for infrastructure and per million spans for APM. High cardinality tags such as request ID or user ID inflate the span count quickly. New Relic uses a usage based model with a free tier up to 100 GB ingest per month. Beyond that you pay per GB. The Grafana stack is open source; you pay for the managed Grafana Cloud tier or for your own compute and storage. OpenTelemetry itself has no cost but you must run collectors, storage and query engines. A typical cost comparison for a 200 node Kubernetes cluster ingesting 5 TB of traces per month:

| Tool | Annual licence (USD) | Ingest cost (USD/TB) | Lock‑in risk |
|------|----------------------|----------------------|--------------|
| Dynatrace | 1 200 000 | included | High (proprietary protocol) |
| Datadog | 800 000 | 0.10 per million spans | Medium (API compatible) |
| New Relic | 600 000 | 0.25 per GB | Medium (NRQL only) |
| Grafana Cloud | 300 000 | 0.50 per GB | Low (open protocols) |
| Self‑hosted OpenTelemetry + Loki + Tempo | 150 000 (infra) | 0 (storage only) | None |

Numbers are illustrative. Multiply your expected TB by the per TB rate to verify the total.

## Vendor lock‑in and data portability
Lock‑in risk is the effort required to move telemetry to another backend. Dynatrace uses a proprietary binary protocol; exporting raw spans needs a dedicated exporter that may not capture all enriched metadata. Datadog and New Relic expose OTLP exporters but their SaaS dashboards rely on vendor specific query languages (Datadog query language, NRQL). Grafana Cloud accepts OTLP natively and stores data in Loki for logs, Tempo for traces and Mimir for metrics. OpenTelemetry collector can forward to any OTLP endpoint so you can switch backends by changing the exporter config. The collector also supports a file exporter for local debugging.

## OpenTelemetry as the neutral layer
OpenTelemetry provides a single instrumentation API and a collector that can receive, process and export telemetry. You instrument once with the OpenTelemetry SDK. The collector runs as a DaemonSet or sidecar. It can batch spans, apply tail based sampling, scrub PII and enrich with Kubernetes metadata. Because the collector is vendor agnostic you can send the same data to Dynatrace, Datadog and Grafana simultaneously during a migration. The collector configuration is declarative YAML.

```yaml
receivers:
  otlp:
    protocols:
      grpc:
      http:
processors:
  batch:
    timeout: 10s
    send_batch_size: 1000
  tail_sampling:
    decision_wait: 30s
    num_traces: 50000
    expected_new_traces_per_sec: 20000
    policies:
      - name: errors
        type: string_attribute
        string_attribute:
          key: error
          values: ["true"]
      - name: latency
        type: latency
        latency:
          threshold_ms: 500
exporters:
  otlp:
    endpoint: "tempo.grafana.cloud:4317"
    headers:
      Authorization: "Bearer ${TEMPO_TOKEN}"
  logging:
    loglevel: debug
service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch, tail_sampling]
      exporters: [otlp, logging]
```

The config above shows a collector that receives OTLP, batches, applies tail sampling for errors and high latency, then forwards to Tempo and logs locally.

## Decision checklist
Use the following checklist when you evaluate a new APM stack.

- [ ] Measure baseline CPU and memory before installing any agent.
- [ ] Run a load test with the agent enabled at 100 percent sampling for ten minutes. Record the overhead.
- [ ] Estimate monthly trace volume. Multiply by the vendor per span or per GB rate.
- [ ] Verify that the vendor accepts OTLP natively or provides a certified OpenTelemetry exporter.
- [ ] Confirm that you can export raw spans to an object store for long term retention.
- [ ] Check the contract for minimum commit and price escalation clauses.
- [ ] Validate that the collector can run in your Kubernetes environment without privileged pods unless you need eBPF.
- [ ] Ensure the sampling policy you need (probabilistic, tail, rate limiting) is supported by the agent or collector.
- [ ] Plan a migration path: run dual export for at least two sprints before cutting over.

## How to decide today
If you need full stack auto‑discovery with minimal engineering effort and you can absorb the host based price, Dynatrace is the fastest to value. If you already use Datadog for logs and metrics and want a single pane of glass, the APM add‑on keeps the workflow consistent. If you prefer a usage based model with a generous free tier and you can tolerate NRQL for queries, New Relic fits. If you want full control over data, avoid vendor pricing surprises and you have the ops capacity to run collectors, the Grafana stack with OpenTelemetry is the most flexible. Start by instrumenting a single service with the OpenTelemetry SDK, deploy the collector in a test namespace and compare the overhead numbers against the vendor agents. The data will tell you which trade‑off you can live with.
