---
title: One CDN purge can take down your origin
date: 2026-11-01
summary: Origin load scales with (1 − hit ratio), cache keys quietly fragment, and synchronised expiry is a load test you never planned. How to engineer and test a CDN properly.
tags: Performance, CDN, Caching
linkedin: |
  A CDN hit ratio dropping from 95% to 90% sounds like a rounding error. It doubles your origin load.

  Origin traffic is proportional to (1 − hit ratio): 5% of 10,000 req/s is 500 req/s, and 10% is 1,000.

  That's why I treat the CDN as part of the capacity model, not a box in front of it. The usual culprits are cache keys fragmented by tracking parameters, cookies or a careless Vary header. Then every edge location missing on its own because there's no origin shield. And TTLs or a purge-all that expire everything at once, right at peak.

  And load tests mislead in both directions. Bypass the CDN and you overstate origin load. Hammer one URL through it from one region and you test a single warm edge cache.

  Do you size your origin for the normal hit ratio, or for a cold cache?

  The article has an interactive calculator: move the hit ratio and watch your origin run out of headroom.

  #PerformanceEngineering #CDN #WebPerformance
---
Launch morning. The new campaign goes live, and someone helpfully purges the whole CDN so the new banner shows everywhere at once. Thirty seconds later the origin, which normally serves 500 requests a second, is taking 10,000. The site goes down in the one hour it most needed to stay up.

Nothing was broken. The CDN did exactly what it was told.

Most teams treat the CDN as a box that makes static files fast. From a performance engineering point of view it is the **first tier of your capacity model**. It decides how much traffic your origin sees, and it fails in ways that stay invisible until a busy day.

## The number that matters: origin load ∝ (1 − hit ratio)

Origin request rate = edge request rate × (1 − hit ratio). This is not linear in the way people intuit.

| Edge traffic | Hit ratio | Origin traffic |
|--------------|-----------|----------------|
| 10,000 req/s | 95% | 10,000 × 0.05 = 500 req/s |
| 10,000 req/s | 90% | 10,000 × 0.10 = 1,000 req/s |
| 10,000 req/s | 80% | 10,000 × 0.20 = 2,000 req/s |

A five-point drop in hit ratio doubles origin load. If the origin was sized at 2× headroom for 500 req/s, that drop alone consumes all of it.

Try it: move the hit ratio and see how quickly the origin runs out of headroom.

<div class="widget" data-widget="cdn"><p><em>Interactive calculator: open this post on pawansinha.com.au to try it with your own numbers.</em></p></div>

Track two ratios, not one:

- **Request hit ratio**: share of requests served from cache. This drives origin CPU and connection load.
- **Byte hit ratio**: share of bytes served from cache. This drives origin egress bandwidth and cost. A site can have a high request hit ratio while missing on the large files.

## Cache keys: the silent fragmentation

The cache key decides which requests share an object. Every extra dimension in the key splits one hot object into many lukewarm ones.

Common fragmenters:

- **Query strings**: `?utm_source=...`, `?fbclid=...`, cache-busting timestamps, or the same parameters in a different order. Strip tracking parameters and normalise order at the edge.
- **Cookies**: forwarding all cookies to the origin usually puts them in the key. Forward only the ones the origin needs.
- **`Vary` headers**: `Vary: Accept-Encoding` is normal and most CDNs normalise it. `Vary: User-Agent` can turn one object into thousands of variants. `Vary: Cookie` effectively disables shared caching.

A quick test: request the same object with two realistic variations (different tracking parameter, different user agent) and check whether the second is a hit.

## TTLs, revalidation and serving stale

Use `Cache-Control` deliberately:

```http
Cache-Control: public, max-age=60, s-maxage=300, stale-while-revalidate=60, stale-if-error=86400
```

- `max-age` applies to browsers, and `s-maxage` overrides it for shared caches such as the CDN.
- `stale-while-revalidate` (RFC 5861) lets the cache serve the stale copy while it refreshes in the background, so users never wait on the origin for a popular object.
- `stale-if-error` lets the cache serve stale content when the origin returns errors, which turns an origin outage into degraded freshness instead of an outage.

Support for these directives differs between CDN providers and configuration modes, so confirm them against your provider's documentation and verify with response headers.

## Tiered caching and request collapsing

Without tiering, every edge location (point of presence, or POP) misses independently. With 50 POPs, a newly published or just-expired object can cause up to 50 origin fetches. An **origin shield** (a mid-tier cache that edges fetch from) collapses those into roughly one.

**Request collapsing** handles the same problem inside one location: if 200 requests for the same uncached object arrive together, the cache sends one request to the origin and holds the rest. Check whether your provider does this by default and for which responses. It is your main defence against a stampede on a hot object.

## Synchronised expiry and purge-all

Two events produce a sudden wall of misses:

- **Purge-all** during peak hours. It turns the origin's traffic from (1 − hit ratio) into nearly 100% for the hottest objects at once. Prefer targeted purges by URL or tag, and schedule large purges off-peak.
- **Aligned TTLs**: content published in a batch with identical TTLs expires in a batch.

Size the origin for a cold-cache event, or have a plan (stale-while-revalidate, shielding, rate limiting) that makes a cold cache survivable.

## Dynamic content benefits too

Even uncacheable API calls gain from the CDN. Say a user is 150 ms round-trip time (RTT) from the origin. A new TCP plus TLS 1.3 connection needs about two round trips before the request is sent, then one more for the response: roughly 3 × 150 = 450 ms. If the edge is 10 ms from the user and keeps a warm, reused connection to the origin, the user pays about 2 × 10 = 20 ms for the handshakes plus one edge-to-origin round trip, usually under 150 ms over the provider's network. That is roughly 170 ms instead of 450 ms, before any caching.

## Load testing with a CDN in the path

CDN load tests mislead in both directions:

- **Bypassing the CDN** sends 100% of traffic to the origin. You overstate origin load and learn nothing about the edge.
- **Testing through the CDN with one URL from one cloud region** hits one or two POPs with a perfectly warm cache. You understate origin load.

What I'd do instead:

1. Model the URL distribution from real access logs. Popularity is usually long-tailed, so a realistic mix includes many rarely requested objects that miss.
2. Test the origin directly at **expected miss traffic**: total × (1 − hit ratio), plus the uncacheable requests, with headroom for a lower hit ratio.
3. Run a **cold-cache scenario** and a **purge scenario** against a staging CDN configuration.
4. Generate load from several regions if you want to exercise more than one POP.
5. Tell your CDN provider before a large test. Edge security rules often treat a load test as an attack, and some providers' terms require notice.

## What to monitor

- Hit ratio by content type and path, both request and byte.
- Origin request rate and origin response time, separately from edge time to first byte.
- 5xx errors split by edge and origin.
- Cache status headers on sampled responses: `Age` (standard), and provider-specific ones such as `cf-cache-status` (Cloudflare) or `X-Cache` (CloudFront).

The CDN is the first tier in your capacity model. Give it the same rigour as the database.
