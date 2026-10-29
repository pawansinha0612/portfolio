---
title: Choosing a Load Balancer Algorithm for Real‑World Traffic
date: 2026-11-04
summary: A practical guide to round‑robin, least‑connections, least‑outstanding, and power‑of‑two‑choices under real load, with keep‑alive, draining and L4 vs L7 trade‑offs.
tags: LoadBalancing, Performance, Networking
linkedin: |
  When a service scales, the load‑balancer algorithm you choose can make or break your tail latency.
  
  A key takeaway: if your traffic contains a non‑negligible fraction of long‑running requests or you rely heavily on HTTP keep‑alive, least outstanding requests or power of two choices will reduce tail latency compared to round robin.
  
  What algorithm are you using in production, and how have you measured its impact on the 95th‑percentile latency?
---
## Overview
When a service receives traffic that outstrips a single instance, a load balancer sits in front to distribute the work. The algorithm it uses determines how evenly requests are spread, how quickly the system responds, and how it behaves when a backend fails or is taken down for maintenance. This article compares four common algorithms—round robin, least connections, least outstanding requests, and power of two choices—under realistic load patterns, and explains how keep‑alive imbalance, connection draining, and L4 versus L7 decision points alter their behaviour.

## Algorithm Definitions

- **Round robin**: each incoming request is forwarded to the next backend in a fixed list, cycling back to the start when the list ends. The algorithm is stateless and offers predictable distribution in the absence of other factors.
- **Least connections**: the balancer queries the current number of active TCP connections on each backend and forwards the request to the one with the fewest. This is a *stateful* algorithm that reacts to short‑term spikes.
- **Least outstanding requests**: similar to least connections but counts only requests that have been accepted by the backend and are still being processed, excluding those that have already been acknowledged but not yet closed. It is more accurate for HTTP/2 and gRPC where a single TCP connection may carry many in‑flight requests.
- **Power of two choices**: the balancer randomly selects two backends, then forwards the request to the one with fewer outstanding requests or connections. This reduces the variance of the load distribution compared to pure round robin while keeping overhead low.

Each algorithm trades off CPU, memory, and network overhead against load balance quality and fairness. The choice depends on the traffic profile, the backend behaviour, and operational constraints.

## Keep‑Alive Imbalance

HTTP/1.1 keep‑alive keeps the TCP connection open for a configurable idle timeout (often 30 s). If a client opens a connection and stays idle for the full timeout, the balancer may still count that connection as active for the duration of the timeout. In a round robin scenario, a backend that receives a long‑lived connection can be starved of new requests while its connection count remains high. Least connections mitigates this by recognising the connection, but if the idle timeout is long, the backend still appears busy.

**Detection**: expose `nginx_upstream_conns` or `haproxy_backend_conn` metrics and look for a high ratio of connections to active requests. A Prometheus query such as:

```text
sum by (backend)(haproxy_backend_conn) / sum by (backend)(haproxy_backend_req)
```

returns the average connections‑per‑request per backend. A value above 1.5 often indicates idle‑connection skew.

**Mitigation**: shorten the keep‑alive timeout, or enable *connection draining* on the balancer so that new requests are not sent to a draining backend while its idle connections are still counted.

## Connection Draining

When a backend is taken out of rotation—due to a rolling upgrade, scaling event, or failure—new requests should not be sent to it. However, existing connections may still be active. Connection draining closes the backend after a configurable grace period, allowing in‑flight requests to finish.

**Impact on algorithms**: round robin will still cycle through the draining backend until it is removed from the list, potentially sending a few more requests. Least connections will see the draining backend’s connection count drop as it closes, but if the drain period is long, it may still attract traffic. Power of two choices will likely avoid the draining backend if the other candidate has fewer connections.

**Detection**: monitor the `backend_draining` metric (or equivalent) and correlate it with spikes in latency or error rates.

## L4 vs L7 Balancing

- **L4 (Transport Layer)**: the balancer forwards TCP/UDP packets based on source/destination ports and IP addresses, without inspecting the payload. It is fast and has low overhead, but cannot differentiate between HTTP methods, paths, or headers.
- **L7 (Application Layer)**: the balancer parses the HTTP header, can route based on URL, cookie, or header value, and can apply advanced policies such as sticky sessions.

**Trade‑offs**:

| Metric | L4 | L7 |
|--------|----|----|
| Latency | ~1 ms | 5–10 ms (parsing overhead) |
| CPU | low | higher (payload inspection) |
| Flexibility | low | high |
| Visibility | coarse | fine‑grained |

If the service is stateless and the traffic pattern is uniform, L4 round robin may suffice. If you need to route based on user‑agent or perform A/B testing, L7 least outstanding requests gives better fairness.

## Comparative Checklist

| Algorithm | CPU Overhead | Memory Footprint | Load Balance Quality | Fairness | Typical Use Case |
|----------|--------------|------------------|-----------------------|----------|------------------|
| Round robin | very low | minimal | good for uniform traffic | high | Stateless services with uniform request size |
| Least connections | moderate | moderate | adapts to spikes | high | Services with variable request duration |
| Least outstanding | moderate | higher | best for HTTP/2 or gRPC | very high | Services with many multiplexed streams |
| Power of two | low | low | near‑optimal variance | high | High‑traffic services where full state is expensive |

**Decision rule**: If your traffic is bursty and request durations vary widely, prefer least connections or least outstanding. If you want minimal overhead and your traffic is uniform, round robin is fine. If you need to keep state but want to avoid full‑state overhead, power of two is a good compromise.

## Hypothetical Scenario

Assume a service receives 100 k requests per second, with 10 identical backends. Each request takes on average 200 ms to process, and 5 % of requests are long‑running (1 s). Keep‑alive timeout is 30 s.

**Round robin**: each backend receives 10 k req/s. The 5 % long‑running requests occupy a backend for 1 s, creating a backlog of 10 k × 0.05 × 1 s = 500 requests that sit in the queue. This backlog is spread evenly, but the tail latency rises to ~1 s.

**Least connections**: during the burst of long‑running requests, the balancer will route new requests to the backends with fewer connections, concentrating the long‑running ones on a subset. The backlog reduces to ~250 requests, and tail latency drops to ~800 ms.

**Least outstanding**: because the algorithm counts only in‑flight requests, it will immediately recognise that a backend is busy with long‑running requests and redirect new traffic elsewhere. Backlog falls to ~150 requests, tail latency ~700 ms.

**Power of two**: the random pair selection reduces variance; the effective backlog is similar to least outstanding but with lower CPU usage.

## Proving a Hypothesis

To decide between algorithms, run a controlled experiment:

1. Deploy the same service behind each algorithm on a separate load‑balancer instance.
2. Use k6 to generate 100 k req/s with the same mix of short and long requests.
3. Collect metrics: `http_req_duration`, `backend_conn`, `backend_req`.
4. Compute the 95th and 99th percentile latency.
5. Compare the tail latency and request distribution.

A simple k6 script (single‑quoted strings to avoid escaping) looks like:

```js
import http from 'k6/http';
import { check, sleep } from 'k6';

export let options = {
  vus: 2000,
  duration: '60s',
  thresholds: {
    http_req_duration: ['p(95)<500', 'p(99)<1000'],
  },
};

export default function () {
  let res = http.get('http://service.local/api');
  check(res, { 'status==200': r => r.status === 200 });
  sleep(0.1);
}
```

After the run, query Prometheus for `http_req_duration` per backend and inspect the histogram buckets. If the tail latency on one algorithm is consistently higher, that indicates a bottleneck in the distribution logic.

## Common Misconceptions

- **“Round robin is always the simplest and safest.”** It is simple, but in the presence of long‑running requests or keep‑alive skew it can produce significant tail latency.
- **“Least connections is always best.”** It adds state tracking and can over‑react to short spikes, leading to oscillation.
- **“L7 is always preferable.”** L7 incurs extra CPU and can introduce cache‑miss penalties if the balancer has to parse headers for every request.
- **“Power of two choices is a drop‑in replacement for L4.”** It is a probabilistic algorithm; if the traffic is already uniform, the extra state tracking offers little benefit.

## Takeaway
When selecting a load‑balancing algorithm, start by modelling your traffic: bursty versus steady, short versus long requests, and keep‑alive behaviour. Use the comparative checklist to map those characteristics to the algorithm’s strengths and weaknesses. Then validate your choice with a focused experiment that measures tail latency and request distribution under realistic load.

## Next Steps
- Instrument your balancer to expose per‑backend connection and request metrics.
- Add a small test harness that can switch algorithms on the fly.
- Monitor keep‑alive skew and enable connection draining during upgrades.
- Re‑evaluate the algorithm if you observe a shift in traffic patterns or a change in backend behaviour.
