---
title: Green load test, red production: finding the database bottleneck
date: 2026-11-08
summary: Why a PostgreSQL-backed service passes its load test and still blows its p99 in production, and the order I check things in: pool exhaustion, N+1, generic-plan flips, lock waits, replicas and indexes, with the exact queries for PostgreSQL 13+.
description: Why a PostgreSQL service passes its load test but blows p99 in production: pool exhaustion, N+1, plan flips and lock waits, with the queries to check.
tags: Performance, Database, PostgreSQL
repost: If the slow query log is empty but p99 is 4 seconds, what is your service waiting on?
linkedin: |
  The load test passed with a p99 of 120 ms. In production the same endpoint hits 4 seconds, and the slow query log is empty.

  That combination usually means the time is spent waiting, not executing. Waiting for a connection from the app pool. Waiting on a row lock. Waiting through 60 round trips because of an N+1 loop.

  Test environments hide these causes. A small dataset fits in memory. Parameters are uniform, so the planner never sees skew. Nobody else is writing to the same rows.

  The post walks through the order I check things in, with the exact PostgreSQL queries and a calculator for pool sizing and N+1.

  Which of these has your test environment been hiding?

  #PerformanceEngineering #PostgreSQL #LoadTesting
---
The load test passed. p99 was 120 ms at twice the expected peak, and everyone signed off. A week after launch, the same endpoint sits at 4 seconds p99 during the evening rush. You open the slow query log and it is almost empty.

Nothing in the database looks slow. Yet the database is the reason.

## Why the test environment hides it

Most database bottlenecks that escape load testing are not slow queries. They are **waits**: for a pooled connection, for a lock, for many small round trips. A typical test environment removes the conditions that create those waits:

- **A small dataset.** The whole database fits in `shared_buffers`, so every read is a cache hit, and the planner happily chooses plans that only work on small tables.
- **Uniform parameters.** The script picks customer IDs from a flat list. Production has a few customers with a million orders each.
- **No concurrent writers.** Batch jobs and other services that update the same rows are absent.
- **No replicas.** Reads go to the primary, so replica lag and read-after-write anomalies never appear.

Test with production-like volume and skew, then check in this order.

## 1. Connection pool exhaustion

This is the one that hides best. When every connection in the application's pool is in use, new requests queue inside the application for a free one. That time counts in your response time but never in `pg_stat_statements`, because no query is running.

**Little's Law** (average items in a system = arrival rate × average time in the system) gives the demand. Imagine 1,000 req/s, 60 queries per request, and 1.5 ms per query including the network round trip. Each request holds a connection for about 90 ms, so you need 1,000 × 0.09 = **90 busy connections on average**. With a pool of 100 across all instances, that is 90% utilisation. Random bursts will exceed the pool regularly, and p99 grows by much more than p50.

Detect it in the application first. HikariCP exposes pending threads (`hikaricp_connections_pending` via Micrometer) and connection acquire time. On the database side, check how connections are spending their time:

```sql
SELECT state, wait_event_type, count(*)
FROM pg_stat_activity
WHERE backend_type = 'client backend'
GROUP BY 1, 2
ORDER BY 3 DESC;
```

Many sessions `idle in transaction` means the application holds connections while doing other work, such as calling an HTTP API inside a transaction. Fix that before raising the pool size. A bigger pool only moves the queue into PostgreSQL, where more backends compete for the same cores.

<div class="widget" data-widget="dbpool"><p><em>Interactive calculator: open this post on pawansinha.com.au to try it with your own numbers.</em></p></div>

## 2. N+1 queries

N+1 is one query for a parent list, then one query per row. Each query is fast, so the slow log stays empty. The cost is round trips and connection hold time. At 0.5 ms network latency, 200 extra queries add 100 ms before the database does any work.

`pg_stat_statements` aggregates by normalised statement, so it cannot attribute calls to one request. Two methods work:

- **Tracing.** An APM or OpenTelemetry trace shows dozens of identical database spans under one request span.
- **Ratio of calls to requests.** Reset the statistics, run a test with a known request count, and compare:

```sql
SELECT pg_stat_statements_reset();
-- run the load test, then:
SELECT calls, round(mean_exec_time::numeric, 2) AS mean_ms, rows, left(query, 80) AS query
FROM pg_stat_statements
ORDER BY calls DESC
LIMIT 10;
```

If a statement shows 600,000 calls for 10,000 requests, that is 60 per request. The fix is a join or a single `WHERE parent_id = ANY($1)` query, or your ORM's batch fetching.

## 3. Generic plan flips

`plan_cache_mode` only affects **prepared statements**, including those your driver prepares for you. In the default `auto` mode, PostgreSQL builds a custom plan for each of the first five executions. After that it switches to a cached **generic plan** (one built without knowing the parameter values) if the generic plan's estimated cost is not much higher than the average custom plan.

With skewed data, the generic plan may suit the typical customer and be terrible for the largest one, for example an index scan that should have been a sequential scan, or a nested loop over a million rows. Small test datasets with uniform parameters never trigger it.

To see the flip, run the same statement more than five times:

```sql
PREPARE orders_by_customer(bigint) AS
  SELECT * FROM orders WHERE customer_id = $1;
EXECUTE orders_by_customer(42);  -- repeat at least five times
EXPLAIN (ANALYZE, BUFFERS) EXECUTE orders_by_customer(42);
SELECT name, generic_plans, custom_plans FROM pg_prepared_statements;
```

A generic plan shows `$1` in its conditions instead of the literal value. The `generic_plans` and `custom_plans` columns need PostgreSQL 14 or later.

In production, capture the actual slow plan with `auto_explain`. Set `auto_explain.log_min_duration = '500ms'` and `auto_explain.log_analyze = on`, and consider `auto_explain.log_timing = off` to reduce overhead. In `pg_stat_statements`, a plan problem looks like a `max_exec_time` or `stddev_exec_time` far above `mean_exec_time` for the same statement.

Fixes, in the order I'd try them: better statistics (`ANALYZE`, a higher per-column statistics target, `CREATE STATISTICS` for correlated columns), then `plan_cache_mode = force_custom_plan` for the role or the specific statements with skewed parameters. Custom plans cost planning time on every execution, so do not set it globally without measuring.

## 4. Lock waits

A session blocked on a row lock is waiting, not running. Find blocked sessions and who blocks them:

```sql
SELECT pid, pg_blocking_pids(pid) AS blocked_by, wait_event,
       now() - query_start AS waiting_for, left(query, 60) AS query
FROM pg_stat_activity
WHERE wait_event_type = 'Lock';
```

Set `log_lock_waits = on` to log any wait longer than `deadlock_timeout` (1 s by default), and `lock_timeout` so a request fails fast instead of queueing forever.

Fixes: shorter transactions, a consistent order for locking rows, and no hot rows. A single counter row updated by every request serialises your whole workload. `SELECT ... FOR UPDATE SKIP LOCKED` suits queue-style workers only, because it skips rows rather than waiting for them.

## 5. Read replicas

Streaming replication is asynchronous by default, so replicas lag. Synchronous replication with `synchronous_commit = remote_apply` makes a commit visible on the standby before it returns, at the cost of a standby round trip on every commit. On the primary:

```sql
SELECT application_name, state, sync_state, write_lag, flush_lag, replay_lag
FROM pg_stat_replication;
```

On the replica, `now() - pg_last_xact_replay_timestamp()` gives replay delay, but it keeps growing on an idle primary even when the replica is caught up. On a primary that was never a standby it returns NULL. Lag shows up as read-after-write bugs and retries, which load tests that only read from the primary never see.

## 6. Indexes and cache

A missing index shows up as sequential scans on large tables, not in the index statistics:

```sql
SELECT relname, seq_scan, seq_tup_read, idx_scan, n_live_tup
FROM pg_stat_user_tables
WHERE n_live_tup > 100000
ORDER BY seq_tup_read DESC
LIMIT 10;
```

`idx_scan = 0` in `pg_stat_user_indexes` finds the opposite: unused indexes that cost write time. Check every replica before dropping one, because each server keeps its own counters.

For cache behaviour, use `pg_stat_database`:

```sql
SELECT datname, round(100.0 * blks_hit / nullif(blks_hit + blks_read, 0), 2) AS hit_pct
FROM pg_stat_database
WHERE datname = current_database();
```

A `blks_read` may still be served from the operating system's page cache, so treat this as a trend, not a precise number. A test dataset that fits in memory will always score well here.

## The checklist

1. Pool wait time in the application, and `idle in transaction` sessions.
2. Calls per request, from traces or `pg_stat_statements`.
3. Plan variance: `max_exec_time` against `mean_exec_time`, then `auto_explain`.
4. Sessions with `wait_event_type = 'Lock'`.
5. `pg_stat_replication` lag, if reads go to replicas.
6. Sequential scans on large tables.

When the slow query log is empty and p99 is high, look for the waiting, not the working.
