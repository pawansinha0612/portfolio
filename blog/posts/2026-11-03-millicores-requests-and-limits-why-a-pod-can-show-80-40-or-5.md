---
title: Millicores vs CPU utilisation: why one pod shows 80%, 40% and 5%
date: 2026-11-03
summary: 1 CPU = 1000m. The same pod can honestly show 80%, 40% and 5% CPU depending on whether a dashboard divides by its request, its limit or the node.
tags: Kubernetes, Performance, Monitoring
linkedin: |
  Three dashboards, one pod, three CPU numbers: 80%, 40% and 5%. All three are correct.

  In Kubernetes, CPU is measured in millicores: 1 CPU = 1000m. The pod in this example uses 400m.

  400m of its 500m request = 80%
  400m of its 1000m limit = 40%
  400m of an 8-core node = 5%

  Same usage, three different denominators. Before you call a pod "busy" or "idle" in a performance test, check what the percentage is relative to.

  And watch the limit: a container at its CPU limit gets throttled, which shows up as slower responses, not as a dramatic CPU graph.

  Which one does your team's dashboard show?
---
During a performance test, someone says "the pod is at 80% CPU". Someone else looks at a different dashboard and sees 5%. Both are right. In Kubernetes, a CPU percentage only means something once you know what it's a percentage *of*.

## Millicores: the unit

Kubernetes measures CPU in **millicores** (written `m`):

- 1 CPU (one core or vCPU) = **1000m**
- 500m = half a CPU
- 250m = a quarter of a CPU

Usage is measured the same way. A container "using 400m" is using the equivalent of 0.4 of a CPU over the measurement window.

## Requests and limits

Each container can declare two CPU values:

```yaml
resources:
  requests:
    cpu: 500m    # reserved for scheduling
  limits:
    cpu: 1000m   # hard ceiling
```

- **Request:** what the scheduler reserves for the container. A pod only lands on a node with that much unreserved CPU. It's also the container's guaranteed share when the node is busy.
- **Limit:** the most the container may use. Above it, the container is **throttled**: the kernel pauses it until the next scheduling period. It isn't killed (that's what happens with memory limits), it just runs slower.

A container can use more than its request, up to its limit, whenever the node has spare CPU.

## One pod, three percentages

Take one container:

- request: **500m**
- limit: **1000m**
- running on a node with **8 CPUs (8000m)**
- current usage: **400m**

| Compared with | Calculation | Result |
|---|---|---|
| Its request | 400 / 500 | **80%** |
| Its limit | 400 / 1000 | **40%** |
| The node's capacity | 400 / 8000 | **5%** |

Same usage, three honest numbers. Which one you see depends on the tool and the query:

- Horizontal Pod Autoscaler CPU targets are a percentage of the **request**.
- Many Grafana dashboards built on cAdvisor metrics show usage against the **limit**, or as raw cores.
- Node-level views and some cloud consoles show usage against the **node**.

`kubectl top pod` avoids the question by showing raw millicores, which is often the clearest number to start with.

## Why it matters in performance testing

**Throttling hides in plain sight.** A container at its limit doesn't show a scary graph: it sits at a flat 100% of limit while response times climb. Check the throttling metrics:

```promql
# share of CPU periods in which the container was throttled
rate(container_cpu_cfs_throttled_periods_total[5m])
  / rate(container_cpu_cfs_periods_total[5m])
```

If that's consistently above a few percent during a test, the limit is shaping your latency.

**Over 100% of the request is normal.** A pod at "150%" in an autoscaler view is using more than it reserved, which is allowed. It's only a problem if the node gets busy and the pod can no longer borrow the extra CPU.

**Low node percentages can hide a hot pod.** A node at 20% can still have one container pinned at its limit.

## A quick checklist

1. Find the container's request and limit (`kubectl describe pod`).
2. Read raw usage in millicores (`kubectl top pod --containers`).
3. Work out which denominator each dashboard uses before comparing numbers.
4. During load tests, watch throttling alongside CPU usage and response times.
5. Report CPU in millicores plus the request and limit, so everyone reads the same thing.

## Takeaway

"80% CPU" isn't a fact until you say 80% of what. Measure in millicores, know the request and limit, and look at throttling, not just utilisation, when response times rise under load.
