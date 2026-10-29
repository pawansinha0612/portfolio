---
title: Beyond Static Caching: Optimising CDN Behaviour for Real‑World Loads
date: 2026-11-01
summary: Learn how cache keys, Vary headers, TTL strategies, origin shield and hit‑ratio metrics shape CDN performance, and why bypassing the CDN in load tests is a common pitfall.
tags: Performance, CDN, Cache, Load Testing
linkedin: |
  Ever wondered why a CDN‑only test shows a 95 % hit ratio but production traffic hits the origin 30 % of the time? The culprit is often a mis‑configured cache key or an ignored Vary header. A quick check of the CDN’s key template and a test that routes traffic through the edge can reveal hidden bottlenecks. One concrete takeaway: enable stale‑while‑revalidate and monitor its success rate; a low success rate means the origin is still the bottleneck. How do you validate your CDN configuration before a load test? Share your approach.
---
# Beyond Static Caching: Optimising CDN Behaviour for Real‑World Loads

Content delivery networks are often reduced to a single function: cache static files. In practice, the behaviour of a CDN is far richer. The key lies in recognising that every request traverses a chain of layers – client, edge, cache key, origin shield, origin, database – and that a mis‑configured cache key or TTL can shift the bottleneck from the edge to the origin or even the database.

## Cache Keys and the Vary Header

A CDN cache key is the string that identifies a cached object. It is usually a hash of the request URL, query string, host header and, crucially, the **Vary** header returned by the origin.

> **Vary**: a response header that tells caches which request headers should be considered when selecting a cached object. Common values are `Accept-Encoding`, `Accept-Language`, `Cookie`.

### Why Vary Matters

If an origin returns `Vary: Accept-Encoding` but the CDN is configured to ignore this header, the CDN will serve a compressed version to a client that does not support it, causing a 206 partial‑content or a 500 error. Conversely, if the CDN respects Vary but the origin never sets it, the CDN may cache multiple variations of the same URL, inflating cache storage and reducing hit ratio.

### Practical Example

Assume a site serves two flavours of a page: `en` and `fr`. The origin returns:

```
Cache-Control: max-age=600
Vary: Accept-Language
```

The CDN must include `Accept-Language` in the cache key. If the key is simply the URL, a request for `https://example.com/home` with `Accept-Language: fr` will be served the English version from the edge, leading to incorrect content and a higher error rate.

**Fix**: Verify that the CDN’s cache key policy includes all Vary headers that the origin emits. Many CDNs expose a *key template* where you can add `${header:Accept-Language}`.

## TTL, Stale‑While‑Revalidate and Freshness Semantics

The **TTL** (time‑to‑live) is the period for which a cached object is considered fresh. When TTL expires, the edge can either revalidate with the origin (if `stale-while-revalidate` is set) or serve stale content until the origin responds.

> **Stale‑while‑revalidate** (SWR): a directive that allows the edge to serve a stale object while asynchronously fetching a fresh one.

### Calculating the Effective Latency

Let `L_e` be the latency of the edge to serve a cache hit, `L_o` the latency to the origin, and `P` the probability that the origin will respond within the SWR window. The average latency `E` for a request that may hit the cache is:

```
E = (1 - H) * L_o + H * (L_e + (1 - P) * L_o)
```

where `H` is the hit ratio. If `P` is low, SWR offers little benefit; if `P` is high, the edge can mask origin latency.

### Example

Suppose:

- `L_e` = 20 ms
- `L_o` = 200 ms
- `H` = 0.9
- `P` = 0.7

Then:

```
E = 0.1 * 200 + 0.9 * (20 + 0.3 * 200)
  = 20 + 0.9 * (20 + 60)
  = 20 + 0.9 * 80
  = 20 + 72
  = 92 ms
```

The edge delivers a latency of 92 ms on average, a 54 % reduction compared to a direct origin hit. If `P` were 0.2, the benefit would drop to 68 ms.

### Common Pitfall

Many teams set a short TTL (e.g. 60 s) for dynamic content and forget to enable SWR. The result is a high number of cache‑missed requests that hit the origin, inflating `L_o` and the load on the origin.

**Recommendation**: For pages that change infrequently but are accessed heavily, set a longer TTL (e.g. 600 s) and enable SWR. Monitor the `stale-while-revalidate` success rate via the CDN’s analytics API.

## Origin Shield: A Layered Cache

An **origin shield** is a dedicated cache layer positioned between the edge and the origin. It is particularly useful when the origin is a database‑backed service that cannot handle the full edge traffic.

### How It Works

1. Edge receives a request. If the object is cached, it is served.
2. If the edge misses, it forwards the request to the origin shield.
3. The origin shield checks its own cache. A hit returns the object to the edge. A miss forwards the request to the origin.
4. The origin responds, and the shield caches the response for future hits.

### Performance Impact

Assume:

- `L_e` = 20 ms
- `L_s` = 50 ms (shield latency)
- `L_o` = 200 ms
- `H_s` = 0.6 (shield hit ratio)
- `H_e` = 0.9 (edge hit ratio)

The average latency for a request that misses the edge but hits the shield is `L_e + L_s = 70 ms`. If it misses both:

```
E = L_e + L_s + L_o = 270 ms
```

By raising `H_s` from 0.6 to 0.8, the proportion of 270 ms requests falls, reducing the average latency.

### Cost vs Benefit

An origin shield adds cost (extra cache nodes) and complexity (cache invalidation). It is most beneficial when:

- The origin is a database‑backed API with high latency.
- The edge hit ratio is high but the origin still receives a non‑negligible traffic.
- The application can tolerate a slight staleness between edge and shield.

**Checklist**:

| Item | Check | Tool/Command | Notes |
|------|--------|--------------|-------|
| Shield hit ratio | > 0.5 | CDN analytics API | If below, evaluate cost/benefit |
| Invalidation strategy | TTL + explicit purge | CDN API | Ensure TTL aligns with data freshness |
| Latency increase | < 10 ms per hop | `curl -w` | Avoid excessive hops |
|
## Hit Ratio vs Byte Hit Ratio

The **hit ratio** is the proportion of requests served from the cache. The **byte hit ratio** (BHR) is the proportion of bytes served from the cache. BHR is more indicative of bandwidth savings.

### Example Calculation

Assume a site serves:

- 10 kB static assets (CSS/JS) 80 % of the time.
- 1 kB dynamic pages 20 % of the time.
- Edge hit ratio `H` = 0.9.

Total bytes per request: `0.8 * 10k + 0.2 * 1k = 8.6k`.

Bytes served from cache: `0.9 * 8.6k = 7.74k`.

BHR = `7.74k / 8.6k ≈ 0.90`.

If the hit ratio drops to 0.7, the BHR drops to `0.7 * 8.6k / 8.6k = 0.70` – a 20 % reduction in bandwidth savings.

### Why BHR Matters

A high hit ratio can still waste bandwidth if the cached objects are small. Conversely, a moderate hit ratio on large assets can yield a high BHR. Monitoring both metrics helps prioritise cache optimisation.

## Why Load Tests that Bypass the CDN Mislead

A common practice is to run load tests directly against the origin, assuming the CDN is a passive layer. This approach hides several issues:

1. **Cache Warm‑up** – The CDN starts cold; the origin sees a burst of traffic that would never occur in production.
2. **Cache‑Key Mis‑configuration** – A test that hits the origin directly cannot surface problems caused by incorrect cache keys or Vary handling.
3. **Origin Shield Effect** – If an origin shield is in place, a direct test bypasses it entirely, misrepresenting latency and throughput.
4. **Stale‑While‑Revalidate Behaviour** – The test will not exercise SWR, leading to an over‑optimistic view of origin performance.

### How to Test the CDN Path

1. **Route traffic through the edge** – Use the CDN’s test URL or a staging sub‑domain.
2. **Enable full tracing** – Capture the `X-Cache` header and `Vary` handling.
3. **Simulate real traffic patterns** – Mix static and dynamic requests, vary headers, and use realistic TTLs.
4. **Measure metrics at each hop** – Use `curl -w` to capture edge latency (`%{time_connect}`), origin latency (`%{time_starttransfer}`), and total time.

```bash
curl -w "\nEdge: %{time_connect}\nOrigin: %{time_starttransfer}\nTotal: %{time_total}\n" \
  -H 'Accept-Encoding: gzip' \
  https://edge.example.com/home
```

The output will show how much of the latency is spent at the edge versus the origin.

## Checklist for Realistic CDN Performance Testing

| Step | What to Verify | Tool / Command | Why |
|------|----------------|----------------|-----|
| 1 | Edge cache key policy | CDN console | Avoid cache misses due to Vary mis‑config |
| 2 | TTL and SWR settings | CDN analytics API | Ensure freshness vs latency trade‑off |
| 3 | Origin shield hit ratio | CDN analytics API | Validate shield effectiveness |
| 4 | Hit ratio vs BHR | CDN analytics API | Measure bandwidth savings |
| 5 | Latency per hop | `curl -w` or `k6` | Identify where the bottleneck moves |
| 6 | Load test through edge | `k6` script with `--http-user-agent` | Capture real behaviour |
|

## Takeaway

Optimising a CDN is not a one‑time configuration tweak. It requires continuous measurement of cache keys, TTLs, SWR success, origin shield behaviour, and both hit‑ratio metrics. Load tests must exercise the full edge‑origin path; otherwise, the results will be misleading and the origin will be over‑provisioned.

---

## Further Reading

- *The Tail at Scale* – Dean & Barroso, 2014 – for understanding tail latency in distributed systems.
- *Gunther's Universal Scalability Law* – for modelling how throughput scales with added resources.
- *Coordinated Omission* – Gil Tene – to recognise how synchronous measurement can hide latency.
