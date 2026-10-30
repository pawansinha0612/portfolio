---
title: When the cache fails, the database pays
date: 2026-11-06
summary: Cache-aside, read-through, write-through and write-behind compared by failure mode, then the failures that matter at scale: stampedes, synchronised expiry, hot keys, cold starts, penetration, stale-write races and eviction churn.
tags: Performance, Caching, Redis
linkedin: |
  A cache is a capacity multiplier, until it isn't, and then it's a capacity cliff.

  At 20,000 req/s with a 95% hit ratio, the database sees 1,000 req/s. Restart the cache cluster and it briefly sees all 20,000: twenty times its normal load, at exactly the wrong moment.

  The failure modes worth testing for:
  • Stampede: a hot key expires and hundreds of concurrent misses rebuild it at once.
  • Synchronised expiry: keys loaded together with the same TTL expire together. Add jitter.
  • Hot keys: one key lives on one shard, so one shard's throughput caps it.
  • Stale-write race in cache-aside: a slow reader puts an old value back after an update deleted it.

  The article has an interactive calculator: see what a cold cache does to your database.

  Which of these has your load test actually exercised?

  #PerformanceEngineering #Redis #Caching
---
Monday, 9:02 am. A routine Redis failover: thirty seconds of reconnects, nothing dramatic. Then the database, which normally handles 1,000 queries a second, receives 20,000. It falls over, and takes the application with it.

The cache was never just an optimisation. It had quietly become a load-bearing wall.

The caching pattern you choose decides how you fail, and at scale the failures that matter are not "the cache is a bit slow" but sudden shifts of load onto the system the cache was protecting.

## The patterns, compared by how they fail

| Pattern | How it works | Write latency | Main risk |
|---------|-------------|---------------|-----------|
| Cache-aside (lazy loading) | App reads cache, and on a miss reads the database and fills the cache | unchanged | stale data and races, stampedes on miss |
| Read-through | Cache library or service loads from the database on miss | unchanged | same as cache-aside, but logic is centralised |
| Write-through | Every write goes to cache and database synchronously | higher (two writes) | write latency and availability tied to both |
| Write-behind (write-back) | Writes go to cache, database updated asynchronously | lowest | data loss on cache failure, ordering and durability |
| Refresh-ahead | Popular entries refreshed before they expire | unchanged | refreshing entries nobody needs |

Cache-aside is the most common and the most forgiving. Write-behind is the fastest and the most dangerous: it turns your cache into a primary data store, with all the durability questions that brings.

## Stampede (dogpile) on a hot key

When a popular key expires, every request that arrives before it is rebuilt misses. Say a key is read 2,000 times per second and rebuilding it takes a 100 ms database query. About 2,000 × 0.1 = **200 requests** miss during the rebuild, and with naive cache-aside all 200 run the same expensive query at once. If the query is slow because the database is busy, the window widens, more requests miss, and it feeds itself.

Fixes, from simplest:

- **Request coalescing (single-flight)**: within a process, only one caller rebuilds a key and the others wait for its result.
- **A rebuild lock across processes**: in Redis, `SET lock:key token NX PX 5000`, so only the holder rebuilds. Others briefly serve the stale value or wait.
- **Probabilistic early expiration** (the "XFetch" approach from Vattani, Chierichetti and Lowenstein): each reader recomputes early with a probability that rises as expiry approaches:

```python
import math, random, time

def should_recompute(expiry_ts, delta_s, beta=1.0):
    # delta_s: how long the last recompute took; beta > 1 recomputes earlier
    return time.time() - delta_s * beta * math.log(1.0 - random.random()) >= expiry_ts  # 1 - random() avoids log(0)
```

Because the logarithm of a number between 0 and 1 is negative, the subtraction pushes the check forward in time by a random amount. One reader usually refreshes the key shortly before expiry, and the stampede never forms.

## Synchronised expiry

Keys written together with the same TTL, for example by a bulk warm-up job or a deploy, expire together. That is a stampede across thousands of keys at once. Add jitter: TTL = base × (1 + random between −0.1 and +0.1). It costs nothing and spreads the misses out.

## Hot keys

In Redis Cluster, each key maps to one hash slot on one shard, and Redis executes commands for that shard largely on a single thread. **One very hot key is capped at what one shard can serve**, no matter how many shards you add.

Detection: `redis-cli --hotkeys` reports the most accessed keys, but it requires an LFU `maxmemory-policy` (such as `allkeys-lfu`). Application-side sampling of key access is an alternative.

Fixes: a short-TTL **in-process near cache** in front of Redis for the hottest keys (even 1 second removes most of the load), **key replication** (write `key#1` to `key#N` and read a random copy), or read replicas for read-heavy keys.

Large values are a related problem. `redis-cli --bigkeys` finds them. A multi-megabyte value costs network bandwidth and can delay other commands on the same shard while it is serialised.

## The cold-cache cliff

A cache multiplies database capacity, which means losing it divides capacity. Imagine 20,000 req/s with a 95% hit ratio: the database serves 20,000 × 0.05 = 1,000 req/s. After a cache restart, failover or flush, it briefly serves up to all 20,000, which is 20× normal load.

If the database cannot survive that, the cache is a **load-bearing dependency**, and the design needs one of: warming the cache before taking traffic, rate limiting misses, serving stale data, or a database sized for the cold case. Whichever you choose, test the cold start explicitly.

Try it with your own traffic and database capacity:

<div class="widget" data-widget="cache"><p><em>Interactive calculator: open this post on pawansinha.com.au to try it with your own numbers.</em></p></div>

## Cache penetration

Requests for keys that do not exist always miss, so they always reach the database. A bot iterating random IDs bypasses your cache entirely. Cache negative results with a short TTL, or put a Bloom filter of valid keys in front of the lookup.

## The stale-write race in cache-aside

The classic sequence:

1. Request A misses and reads the **old** value from the database.
2. Request B updates the database and deletes the cache key.
3. Request A writes the old value into the cache.

The cache now holds stale data until the TTL expires. Mitigations:

- Always set a TTL as a safety net.
- Delete the key after the database write (some teams add a second, delayed delete).
- Store a version with the value and refuse older versions.
- Drive invalidation from the database change stream (change data capture) instead of the application.

## Eviction and memory pressure

Redis's default `maxmemory-policy` is `noeviction`: when memory is full, writes fail with errors. For a pure cache you almost always want `allkeys-lru` or `allkeys-lfu`. Watch `evicted_keys` in `INFO stats`. Steady eviction of keys that are requested again soon (churn) shows up as a falling hit ratio with no change in traffic, and the fix is memory or a smaller working set, not a longer TTL.

## What to measure

- **Hit ratio** from `INFO stats`: `keyspace_hits / (keyspace_hits + keyspace_misses)`, and per key pattern from the application.
- **Cache call latency** as a histogram from the client side, including connection pool wait.
- `evicted_keys`, `used_memory`, `connected_clients`, and Redis latency diagnostics (`LATENCY DOCTOR`).
- **Database load during misses**: the number that tells you whether the cache is a convenience or a dependency.

## Load testing caches honestly

- Use a **realistic key distribution**. Real popularity is long-tailed. A test that reads 100 keys measures a 100% hit ratio and nothing else.
- Run a **cold-start scenario**: flush or restart the cache under load and watch the database.
- Expire a known hot key mid-test to check stampede protection.
- Fail over the cache primary under load and measure client reconnection time and errors.

A cache that has only been tested warm has only been half tested.
