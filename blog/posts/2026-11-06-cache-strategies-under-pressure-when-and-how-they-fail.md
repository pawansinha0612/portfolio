---
title: Cache Strategies Under Pressure: When and How They Fail
date: 2026-11-06
summary: Discover how cache‑aside, read‑through, write‑through and write‑behind can break, and learn to spot hot keys, stampedes and invalidation races with real metrics and fixes.
tags: Performance, Caching, Redis
linkedin: |
  When a cache strategy fails, the symptoms are often subtle but catastrophic. One concrete takeaway: always expose the queue length of a write‑behind system and set a hard cap – otherwise you’ll see latency creep before you notice. Have you ever hit a write‑behind overflow in production, and what was your trigger to catch it early?
---
## Cache‑Aside, Read‑Through, Write‑Through and Write‑Behind – A Quick Recap

I start each discussion with a short refresher. A **cache‑aside** (or lazy‑load) strategy leaves the application in charge of deciding when to read from or write to the cache. A **read‑through** cache automatically fetches from the backing store on a miss, while a **write‑through** cache immediately propagates writes to the store. **Write‑behind** (or write‑back) keeps writes in an in‑memory queue and flushes them asynchronously.

Each pattern trades consistency, latency and complexity against one another. The failure modes that surface are often the same across patterns, but the symptoms differ.

## Hot Keys – The Silent Killer of Cache Efficiency

A **hot key** is a key that is requested far more often than any other key. In Redis, a hot key can consume a disproportionate amount of memory and CPU, leading to eviction of useful data and increased latency.

### Detection

1. **Redis INFO stats** – look at `keyspace_hits` vs `keyspace_misses` per key. A key with >90 % hit ratio but a high absolute hit count is a candidate.
2. **Redis slowlog** – a hot key can generate many slowlog entries if it triggers expensive operations.
3. **Prometheus query** (assuming Redis exporter):
   ```
   sum(rate(redis_keyspace_hits_total[5m])) by (key)
   ```
   Sort by value to surface the top keys.

### Mitigation

* **Sharding** – distribute hot data across multiple Redis instances.
* **Cache‑aside with a local in‑memory LRU** – keep a small copy of the hot key in the application.
* **Key partitioning** – append a hash suffix to the key to spread traffic.

## Cache Stampede – When a Miss Spawns a Storm

A **cache stampede** occurs when many concurrent requests hit a missing key, all of which then query the backing store, saturating it. The classic symptom is a sudden spike in DB query latency and a drop in cache hit ratio.

### Detection

* **High miss rate**: `cache_misses / (cache_hits + cache_misses)` > 0.3 for a short burst.
* **DB query latency spike**: Prometheus query
  ```
  avg_over_time(db_query_latency_seconds[1m]) > 0.5
  ```
* **Redis `latency` command** – if latency spikes correlate with the same key.

### Mitigation – Request Coalescing

A simple pattern is to use a **distributed lock** (e.g. Redlock) or a **token bucket** to allow only one request to fetch and populate the cache.

```python
# Pseudo‑Python: request coalescing with Redis lock
import redis
r = redis.Redis()
lock_key = f"lock:{key}"
with r.lock(lock_key, blocking_timeout=2) as lock:
    if not r.exists(key):
        value = fetch_from_db(key)
        r.set(key, value, ex=300)
    else:
        value = r.get(key)
```

The lock ensures that only one thread performs the expensive DB call, while others wait for the value to appear in the cache.

## Invalidation – The Most Common Consistency Failure

Cache invalidation must be **atomic** with respect to the write that changes the underlying data. Two common pitfalls:

1. **Race conditions** – the cache is updated before the database, or vice‑versa.
2. **Stale data** – TTL expiry is too long, or the cache is never refreshed.

### Detection

* **Consistency drift** – periodically query the cache and DB for a sample of keys and compare.
* **Eventual consistency windows** – measure the time between a write and the first cache miss.

### Mitigation

* **Write‑through** – guarantees the cache is updated before the write returns.
* **Versioned keys** – embed a version number in the key; on write, increment the version.
* **Cache‑aside with optimistic locking** – use a CAS (compare‑and‑swap) on the DB row to detect concurrent updates.

## Write‑Behind Queue Overflows – A Hidden Latency Source

In a **write‑behind** setup, writes are appended to a queue and flushed asynchronously. If the queue grows faster than it drains, the latency of writes increases, and the queue may eventually overflow.

### Detection

* **Queue length** – expose the queue size via a Prometheus metric.
* **Flush latency** – monitor the time between a write and its persistence to the DB.

### Mitigation

* **Back‑pressure** – expose a `max_queue_size` and block writers when exceeded.
* **Dynamic batch sizing** – increase batch size when queue length grows.
* **Hybrid strategy** – fall back to write‑through for critical writes.

## A Practical Checklist for Choosing a Strategy

| Question | What to look for | Recommended Strategy |
|----------|------------------|----------------------|
| Do you need strong consistency on every write? | Latency budget allows a round‑trip to DB | Write‑through |
| Are reads the majority of traffic? | Cache hit ratio > 80 % | Read‑through |
| Do you tolerate eventual consistency? | Write latency can be higher | Write‑behind |
| Is your workload bursty with infrequent keys? | High cache miss rate | Cache‑aside with request coalescing |
| Do you have a known hot key? | Single key dominates traffic | Shard or local LRU |

## Putting It All Together – A Hypothetical Scenario

Imagine a payment service that receives 200 k requests per second. The service reads a user’s balance from a relational DB and writes a transaction record. The current architecture uses **cache‑aside** for reads and **write‑behind** for writes.

1. **Cache Stampede**: When a new user logs in, 1000 concurrent requests miss the cache and hit the DB, causing a 3 × spike in DB latency.
2. **Hot Key**: The most active user’s balance key accounts for 15 % of all cache hits, consuming 40 % of Redis memory.
3. **Write‑Behind Overload**: During a flash sale, the write‑behind queue grows to 1 M entries; the flush thread cannot keep up, and the average write latency climbs from 5 ms to 120 ms.

**Fixes applied**:

* Added a distributed lock around the cache‑aside read to coalesce requests.
* Partitioned the hot key across two Redis shards.
* Introduced a `max_queue_size` of 200 k and switched critical transaction writes to write‑through.

After the changes, the DB latency returned to baseline, the cache hit ratio improved to 93 %, and write latency stayed below 10 ms even during the flash sale.

## Takeaway – Measure, Detect, Fix

The most common failure mode is not a bug in the caching library but a mismatch between the chosen strategy and the workload. By instrumenting the right metrics—hit ratio, queue length, DB latency—and by applying a systematic checklist, you can pre‑empt hot keys, stampedes and write‑behind overloads before they hit production.

---

## Further Reading

* **Gunther, “The Universal Scalability Law”** – for understanding the limits of caching layers.
* **Tene, “Coordinated Omission”** – for a deeper dive into latency measurement pitfalls.
