---
title: Your Load Test Is Lying About p99: Spotting DB Bottlenecks Fast
date: 2026-11-08
summary: When a load test reports a p99 of 1 ms but real traffic hits 9 s, a hidden DB issue is at play. Learn the order to check plans, locks, N+1, replica lag and indexes.
tags: Performance, Database, PostgreSQL
linkedin: |
  Your load test says p99 is 1 ms but real traffic hits 9 s. The culprit is usually a hidden database issue, not the application code. The first thing to check is whether the execution plan is stable; a plan flip can silently degrade performance under load. Next, look for lock contention, N+1 queries, replica lag and finally index health. By applying a structured checklist you can identify the root cause quickly. Which of these steps do you find most surprising in your own tests?
---
## Your load test says p99 is 1 ms. The real p99 was 9 seconds.
You run a synthetic test with 100 rps. The dashboard shows a 99th percentile of 1 ms. After launch the same query takes 9 seconds for 99 % of users. The problem is not the network or the app code – it’s the database.

## Why the test was wrong
Synthetic tests often use a single connection or a very small pool. They ignore the effect of connection limits, lock contention and replication lag. When the real system opens thousands of concurrent connections the database behaviour changes. The first thing to check is the execution plan.

## Execution plan flipping
A plan flip occurs when the optimiser chooses a different strategy for the same query after the first few executions. In PostgreSQL this is controlled by plan_cache_mode. The default is auto, which allows plan changes if the parameter values differ. When the first 100 executions use a cached plan that is optimal for a small dataset, a sudden increase in cardinality can cause the optimiser to pick a table scan instead of an index seek.

### Detecting plan flips
Run the query with explain analyze and capture the plan hash:

```sql
SET plan_cache_mode = force_generic_plan;
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM orders WHERE customer_id = 123;
```

Compare the JSON output across multiple runs. If the hash changes, the plan has flipped. A stable plan hash across the expected load is a good sign.

### Fix
Set plan_cache_mode to force_custom_plan for queries that depend on a parameter that changes cardinality. This forces a fresh plan each time and eliminates the flip.

## Lock contention
When many sessions try to modify the same rows, they queue for a lock. The queue forms a queueing system with a service rate determined by the lock acquisition time. If the queue length grows, the latency follows Little’s Law: L = λW, where L is the number of queued sessions, λ is the arrival rate and W is the average wait.

### Detecting lock contention
PostgreSQL exposes lock information in pg_locks. A simple query shows the number of sessions waiting for a lock:

```sql
SELECT locktype, relation::regclass, mode, COUNT(*) as waiters
FROM pg_locks
WHERE NOT granted
GROUP BY 1,2,3;
```

If the count for a particular relation is high, that table is a contention hotspot.

### Fix
Add a covering index that satisfies the update pattern. If the contention is on a primary key, consider sharding the table. For write‑heavy tables, enable row‑level locking with SELECT … FOR UPDATE SKIP LOCKED.

## N+1 queries
A classic performance pitfall is executing one query per row returned by a parent query. The symptom is a linear increase in total latency with the number of rows.

### Detecting N+1
Enable the Postgres autovacuum log for query plans or use pg_stat_statements to find queries that run the same statement many times during a single request. Look for a pattern where a SELECT runs once per parent row.

```sql
SELECT query, calls, total_time
FROM pg_stat_statements
WHERE query LIKE '%SELECT * FROM child%'
ORDER BY calls DESC;
```

If calls are in the thousands for a single request, you likely have N+1.

### Fix
Replace the loop with a JOIN or a sub‑query that retrieves all child rows in one call.

## Replica lag
Even if the primary is fast, a read‑only replica can be slow if it lags behind. The lag is measured in WAL bytes or in seconds.

### Detecting lag

```sql
SELECT pg_last_xact_replay_timestamp(), now() - pg_last_xact_replay_timestamp() AS lag;
```

If lag is more than a few seconds, read traffic will suffer.

### Fix
Add more replicas, or move read traffic to a replica that is within acceptable lag. Consider asynchronous replication for low‑latency reads.

## Index over‑ and under‑use
Missing indexes lead to full scans; over‑indexing adds write overhead and can cause cache eviction.

### Detecting missing indexes

```sql
SELECT relname, idx_scan, idx_tup_read, idx_tup_fetch, idx_scan::float * idx_tup_read / NULLIF(idx_tup_fetch,0) AS missing
FROM pg_stat_user_indexes
WHERE idx_scan = 0;
```

Indexes with zero scans are candidates for removal.

### Detecting over‑indexing

```sql
SELECT relname, n_live_tup, idx_scan, idx_scan/NULLIF(n_live_tup,0) AS scan_ratio
FROM pg_stat_user_tables
WHERE idx_scan/n_live_tup < 0.01;
```

A low scan ratio suggests the index is rarely used.

### Fix
Drop unused indexes. For needed indexes, ensure they are covering and use the most selective columns.

## Checklist for diagnosing DB bottlenecks under load
1. **Execution plans** – check plan stability with explain analyse and plan_cache_mode.
2. **Lock contention** – query pg_locks for waiting sessions.
3. **N+1 queries** – analyse pg_stat_statements for high call counts.
4. **Replica lag** – monitor pg_last_xact_replay_timestamp.
5. **Index health** – review pg_stat_user_indexes and pg_stat_user_tables.
6. **Write‑throughput** – look at pg_stat_bgwriter and pg_stat_database for I/O bottlenecks.
7. **Cache behaviour** – use pg_stat_activity to see if sessions are in the buffer pool.

Apply the checklist in order. Start with plans because they influence all other metrics. Fix plan flips first, then address lock contention, then N+1, replica lag, and finally index tuning.

## Practical commands to run in a day
```bash
# 1. Plan stability
SET plan_cache_mode = force_custom_plan;
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM orders WHERE customer_id = 123;

# 2. Lock contention
SELECT locktype, relation::regclass, mode, COUNT(*) as waiters
FROM pg_locks
WHERE NOT granted
GROUP BY 1,2,3;

# 3. N+1 detection
SELECT query, calls, total_time
FROM pg_stat_statements
WHERE query LIKE '%SELECT * FROM child%'
ORDER BY calls DESC;

# 4. Replica lag
SELECT pg_last_xact_replay_timestamp(), now() - pg_last_xact_replay_timestamp() AS lag;

# 5. Index health
SELECT relname, idx_scan, idx_tup_read, idx_tup_fetch
FROM pg_stat_user_indexes
WHERE idx_scan = 0;
```

Run these commands during a load test or immediately after a spike. The output will tell you where the bottleneck is.

## Takeaway
A single, invisible change in the database layer can turn a 1 ms p99 into 9 s. By following a disciplined order – plans, locks, N+1, replica lag, indexes – you can pinpoint the culprit before it hurts users.
