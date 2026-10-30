---
title: One GC pause, everyone's p99
date: 2026-11-04
summary: Round robin assumes every request costs the same. It doesn't. Least outstanding requests, power of two choices, the connection-level imbalance that L4 hides, slow start, draining, and how to load test the balancer itself.
tags: Performance, Load Balancing, Kubernetes
linkedin: |
  Round robin balances requests evenly. That's the problem.

  It assumes every request costs the same and every backend is equally healthy. Mix in a few 2-second reports with 20 ms reads, or one node in a GC pause, and round robin keeps sending that node its exact share while its queue grows.

  Least outstanding requests adapts to real cost. Power of two choices (pick two at random, send to the less busy) gets most of the benefit and avoids the herding that pure least-connections causes across many balancer instances.

  The imbalance most people miss is a level down. An L4 balancer, including a plain Kubernetes Service, spreads connections, not requests. HTTP/2 and gRPC put thousands of requests on one connection, so one pod can carry a client's entire traffic while the new pods sit idle.

  Which algorithm does your edge balancer use, and did someone choose it on purpose?

  The article has a live simulator: switch on GC pauses and watch what each algorithm does to p99.

  #PerformanceEngineering #Kubernetes #SRE
---
One of your four pods hits a 500 ms garbage collection pause. Nothing unusual. It happens every few seconds. But p99 just jumped across the whole service, for every user.

The pause didn't do that. Your load balancer did. It kept sending that frozen pod a quarter of all traffic, because round robin was the default and nobody ever changed it.

Under light, uniform traffic the algorithm hardly matters. Under real load, with uneven request costs, pauses and long-lived connections, it decides whether one slow backend stays a local problem or becomes everyone's p99.

## The algorithms, and what each assumes

| Algorithm | Picks | Assumes | Breaks when |
|-----------|-------|---------|-------------|
| Round robin (weighted) | next in rotation | requests cost the same, backends equally fast | request cost varies, or one node slows down |
| Least connections | backend with fewest open connections | connections ≈ load | connections are long-lived or multiplexed |
| Least outstanding requests | backend with fewest in-flight requests | balancer sees request boundaries (L7) | many balancer instances herd onto the same target |
| Power of two choices | best of two random backends | in-flight counts are roughly current | rarely, it is the robust default |
| Hash (source IP, header, consistent hash) | same backend for the same key | key distribution is even | a few keys dominate, or clients sit behind one NAT IP |

## Why round robin fails on uneven work

Imagine 4 backends and a workload where 99% of requests take 20 ms and 1% are reports that take 2 s. Round robin gives each backend the same *count* of requests, but the cost is lumpy: any backend that happens to receive two or three reports close together builds a queue, and the cheap requests behind them inherit seconds of wait.

The same happens with a **paused** backend. During a 500 ms garbage collection pause, round robin keeps sending that node its full share. Every one of those requests waits the full pause.

**Least outstanding requests** (AWS Application Load Balancer offers it under that name, and Envoy's `LEAST_REQUEST` policy works on the same signal) routes on in-flight work. A backend that is slow or paused accumulates outstanding requests and stops being chosen. That is the property you want.

You can see the effect in a simulation. It sends identical traffic through each algorithm. Switch the GC pauses on and off and raise the share of slow requests:

<div class="widget" data-widget="lb"><p><em>Interactive calculator: open this post on pawansinha.com.au to try it with your own numbers.</em></p></div>

## Power of two choices: the robust default

Pure "pick the least-loaded backend" has a weakness at scale. With many balancer instances, each one sees only its own view, and they can all pick the same lightly loaded backend at the same moment. That backend gets flooded and becomes the most loaded. This is called **herding**.

**Power of two random choices** (from Michael Mitzenmacher's work on balanced allocations) picks two backends at random and sends to the less loaded one. Randomness stops herding, and comparing just two is enough to get most of the benefit of full least-loaded selection. Envoy's `LEAST_REQUEST` policy uses this approach by default (choosing from two), and NGINX supports it with `random two least_conn;` in an upstream block. If you have no strong reason for something else, this is a good default for HTTP services.

## The imbalance L4 hides: connections are not requests

A **Layer 4** balancer (TCP level) balances *connections*. Once a connection lands on a backend, every request on it goes there. This matters more than the algorithm:

- **HTTP/2 and gRPC** multiplex many requests over one long-lived connection. A client with one connection sends all of its traffic to one pod.
- A plain **Kubernetes Service** (kube-proxy) balances at the connection level. gRPC services behind a Service commonly show one hot pod and several idle ones.
- **After scale-out**, existing keep-alive connections stay on the old pods. The new pods receive only new connections, so autoscaling appears to "not work".
- **Load generators** reuse connections too. A test with 50 virtual users and keep-alive opens about 50 connections, which spread unevenly across 10 pods.

Fixes, in rough order of preference: balance at **Layer 7** (a proxy that sees each request, such as Envoy or a service mesh), use **client-side load balancing** with per-request choice (common for gRPC), or cap connection lifetime so clients reconnect and rebalance (for example gRPC's server-side `MaxConnectionAge`).

## Slow start: protecting a cold backend

Least-connections and least-request algorithms send a brand-new backend a flood of traffic, because it has zero in-flight work. A JVM that has not warmed up its JIT compiler or caches cannot handle that, so it slows down, fails health checks and may be removed again.

**Slow start** ramps a new target's share up over a period. AWS ALB supports a slow start duration of 30 to 900 seconds per target group, and HAProxy has the `slowstart` server option. Test it: scale out mid-test and check the new pod's p99 for its first minutes.

## Draining: protecting in-flight requests

When a backend is removed (deploy, scale-in), in-flight requests should finish. Two settings must line up:

- The balancer's **deregistration delay** (connection draining). On AWS target groups the default is 300 seconds.
- In Kubernetes, the pod must keep serving until the endpoint removal has propagated to every proxy and balancer. A short `preStop` sleep before shutdown, within `terminationGracePeriodSeconds` (default 30 s), avoids the burst of 502s and resets that otherwise appears during every deploy.

A load test that runs through a rolling deploy is the cheapest way to find this.

## Health checks can cause the outage

Under heavy load, a health check that times out removes a busy backend, which puts its traffic on the remaining backends, which then time out too. Keep health checks shallow (is this process able to serve?), give them their own lightweight path, and avoid checking deep dependencies from every instance. A shared dependency failing should not mark every backend unhealthy at once.

## Load testing the balancer itself

- **Source diversity**: hash-based balancing on source IP sends a test from a few load generators to a few backends. Use several generators, or confirm the algorithm is not source-IP based.
- **Connection behaviour**: decide whether your test should open new connections per iteration or reuse them, because real clients do one or the other and the balancer behaves differently.
- **Managed balancer scaling**: cloud balancers scale with traffic but not instantly. For a known sharp spike, check your provider's guidance on pre-provisioning capacity.
- **Watch per-backend metrics**, not just totals: request rate, in-flight requests and p99 per pod. An even total can hide one pod at 3× its share.

## Decision rule

For HTTP services behind an L7 balancer, use least outstanding requests or power of two choices, with slow start and draining configured. For gRPC or HTTP/2 inside Kubernetes, fix connection-level balancing first. The algorithm matters only after requests can actually be spread.
