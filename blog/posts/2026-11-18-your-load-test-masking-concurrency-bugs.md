---
title: Your load test passed and oversold the last 40 units
date: 2026-11-18
summary: Why green load tests miss race conditions, lost updates, deadlocks and pool starvation, how to design tests that provoke them (hot keys, contention windows, invariants), and the exact signals that prove them in the JVM, the connection pool and the database.
description: Green load tests miss races, lost updates, deadlocks and pool starvation. Design tests that provoke them with hot keys and check invariants.
tags: Performance, Concurrency, Testing
highlight: oversold
linkedin: |
  The load test passed. p95 was fine, errors were 0.02%. The next morning the warehouse had 40 orders for items it didn't have.

  Load tests are built to measure speed, so they spread traffic across thousands of random products and users. Race conditions need the opposite: many requests fighting over the same row at the same moment. A random data set almost never creates that.

  To find concurrency bugs under load:
  → aim a slice of traffic at a few hot keys (one product, one account, one cart)
  → assert invariants after the run (stock never below zero, money in = money out)
  → watch BLOCKED threads, pool wait time and database lock waits, not just latency

  The article has an interactive pool calculator: see when your threads start queueing for connections.

  Does your load test check the data at the end, or only the response codes?

  #PerformanceEngineering #Testing #SRE
---
Your load test ran for an hour at twice the expected peak. p95 stayed under 300 ms and the error rate was 0.02%. Everyone signed off. The next morning the warehouse has 40 orders for a product with no stock, and two customers have been charged twice.

The load test did its job. It measured speed. Nobody asked it to check whether the answers were right.

## Why load tests hide concurrency bugs

Concurrency bugs need two requests touching the same state inside the same small window. A typical load test makes that unlikely on purpose. It picks random products from a catalogue of 50,000, random users from a pool of 10,000, and spreads them evenly. Real peaks don't look like that. A flash sale sends half the traffic to one product.

Here are the bugs that hide, with a one-line definition of each:

- **Lost update.** Two transactions read the same value, both compute a new value and both write it. One write silently overwrites the other. This is the overselling bug: two buyers both read "1 left", and both succeed.
- **Check-then-act race.** Code checks a condition ("is this coupon unused?") and then acts on it, without holding a lock or using a unique constraint between the two steps.
- **Deadlock.** Two transactions each hold a lock the other needs. The database detects the cycle and aborts one of them, which usually reaches the user as a 500 or a retry.
- **Lock contention.** Correct, but slow: many requests queue for the same row lock or the same `synchronized` block, and throughput collapses for that key while the rest of the system looks healthy.
- **Pool starvation.** Every connection in the pool is checked out, so new requests wait for one. If a request needs two connections at once, for example an outer transaction plus an audit write, pool starvation can turn into a deadlock inside the application.

The first three are correctness bugs. Response time can look perfect while they happen. The last two are performance bugs that only appear when contention concentrates.

## Design the test to create contention

**Add a hot-key scenario.** Keep the realistic spread for most traffic, and add a second scenario that aims at a handful of keys. In k6 that is a separate scenario with its own data:

```js
export const options = {
  scenarios: {
    browse: { executor: 'constant-arrival-rate', rate: 200, timeUnit: '1s', duration: '20m', preAllocatedVUs: 200, exec: 'browse' },
    hotProduct: {
      executor: 'ramping-arrival-rate', startRate: 0, timeUnit: '1s', preAllocatedVUs: 300, exec: 'buyHot',
      stages: [{ target: 150, duration: '30s' }, { target: 150, duration: '2m' }, { target: 0, duration: '10s' }],
    },
  },
};
```

`buyHot` buys from the same three product IDs, each seeded with a known stock count, for example 500 units.

**Make arrivals simultaneous.** A spike from 0 to 150 requests a second in 30 seconds packs many requests into the same few milliseconds. An open model (arrival-rate executors) keeps sending at the set rate even when the system slows. A closed model with think time would back off, and contention would drop just when it matters.

**Repeat the same request.** Send the same payment or order twice with the same idempotency key, a few milliseconds apart. A double-clicked submit button and a retrying client both look like this.

**Don't let retries hide errors.** Deadlock victims are often retried by the framework. That keeps the error rate down and hides the deadlock. Count retries as a metric of their own.

## Assert invariants after the run

The most important step happens after the load stops. Query the system of record and check facts that must always be true:

```sql
-- Stock can never go negative
SELECT product_id, stock FROM inventory WHERE stock < 0;

-- Units sold must match what was taken out of stock
SELECT p.id, 500 - i.stock AS taken, COUNT(o.id) AS sold
FROM products p JOIN inventory i ON i.product_id = p.id
LEFT JOIN order_lines o ON o.product_id = p.id
WHERE p.id IN (101, 102, 103)
GROUP BY p.id, i.stock
HAVING 500 - i.stock <> COUNT(o.id);

-- One payment per idempotency key
SELECT idempotency_key, COUNT(*) FROM payments GROUP BY idempotency_key HAVING COUNT(*) > 1;
```

Then compare with what the load tool saw: the number of successful buy responses for the hot products must equal the units sold. Any mismatch is a bug, whatever the latency was. Make these checks a pass/fail gate in the pipeline, next to the latency thresholds.

## Signals that prove it while it happens

**JVM threads.** Take thread dumps during the hot-key phase with `jcmd <pid> Thread.print`, three dumps about five seconds apart. Many threads in `BLOCKED` state waiting on the same monitor point to lock contention. The JVM's thread dump reports Java-level deadlocks explicitly ("Found one Java-level deadlock"). For lock waits over time, record with Java Flight Recorder: `jcmd <pid> JFR.start duration=5m filename=hot.jfr`, then look at the `jdk.JavaMonitorEnter` and `jdk.ThreadPark` events.

**Connection pool.** With HikariCP and Micrometer, watch `hikaricp_connections_pending` (threads waiting for a connection), `hikaricp_connections_active` against the pool maximum, and `hikaricp_connections_acquire_seconds`. Pending above zero for long stretches means starvation. `hikaricp_connections_timeout_total` counts requests that gave up waiting.

**Database locks.** In PostgreSQL, sessions waiting on locks show `wait_event_type = 'Lock'` in `pg_stat_activity`, `pg_stat_database.deadlocks` counts deadlocks, and `log_lock_waits = on` logs every wait longer than `deadlock_timeout`. In MySQL, `SHOW ENGINE INNODB STATUS` shows the latest deadlock, and `performance_schema.data_lock_waits` shows current waits.

Latency for the hot scenario, reported separately from the browse scenario, is the other tell. If the hot keys' p99 is ten times the rest while CPU is low, the requests are waiting on a lock, not doing work.

<div class="widget" data-widget="dbpool"><p><em>Interactive calculator: open this post on pawansinha.com.au to try it with your own numbers.</em></p></div>

## Fixes and their trade-offs

- **Atomic conditional update.** `UPDATE inventory SET stock = stock - 1 WHERE product_id = ? AND stock > 0`, then check that one row changed. It is simple and fast, and it serialises on the row, which is correct for a single counter.
- **Optimistic locking** (a version column). There is no lock while reading, and a conflict fails the write. It suits low contention. On a hot key most attempts fail and retry, and throughput collapses.
- **Pessimistic locking** (`SELECT ... FOR UPDATE`). It is correct, but every buyer of that product queues. Keep the transaction short and lock rows in a consistent order to avoid deadlocks.
- **Unique constraints** for check-then-act. A unique index on the idempotency key or the coupon redemption turns a race into a clean constraint violation that the code can handle.
- **Pool sizing.** Never let one request hold two connections from the same pool. If it must, size the pool so that the threads that can hold one and wait for a second can't use up every connection.

## Checklist

1. Add a hot-key scenario with known starting data to every peak test.
2. Use arrival-rate executors so contention doesn't ease off when the system slows.
3. Send duplicate requests with the same idempotency key.
4. Report hot-key latency separately from the rest.
5. Watch BLOCKED threads, pool pending count and database lock waits during the run.
6. After the run, assert invariants in the database and fail the build on any mismatch.

A load test that only checks status codes and latency can pass while the data is wrong. Check the data too.
