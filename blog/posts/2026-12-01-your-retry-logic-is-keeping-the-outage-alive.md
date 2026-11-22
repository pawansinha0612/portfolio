---
title: Your retry logic is keeping the outage alive
date: 2026-12-01
summary: Metastable failures persist after the trigger vanishes. Retry storms are the usual suspect. Here is how backoff, budgets and breakers actually work.
description: Why retries cause metastable failures and how to fix them with backoff, budgets and circuit breakers.
tags: Performance, Reliability, SRE
linkedin: |
  Your system stays down after the trigger is gone. That is a metastable failure. Retries are usually the engine keeping it there.
  
  The fix is three layers: exponential backoff with decorrelated jitter to space retries, a retry budget (token bucket at 10 percent of successes) to bound total retry volume, and a circuit breaker with half-open probing to stop traffic when the downstream is truly dead.
  
  Most teams implement one or two. You need all three. The budget is the critical bound — without it, backoff only delays the collapse.
  
  What retry ratio does your alerting fire at?
---
Your load test says p99 latency is 120 ms. Production p99 is 9 seconds and the error rate is climbing. You roll back the deploy that started it. The error rate drops but latency stays at 8 seconds. Ten minutes later the system is still crawling. The original trigger is gone but the system refuses to recover.

This is a metastable failure. The system has settled into a degraded equilibrium where the work arriving exceeds the work the system can complete, and the gap is sustained by the system's own defensive mechanisms. Retries are the most common amplifier. Every failed request spawns two more. Those fail and spawn four. The queue grows, latency rises, timeouts fire, and the retry loop tightens. The system is now spending most of its CPU scheduling retries instead of doing useful work.

## The retry storm mechanism

Say a service handles 1,000 requests per second at steady state. A downstream dependency slows to 200 ms p99. Your client timeout is 100 ms. Eighty percent of requests time out. Each timeout triggers an immediate retry. The offered load jumps to 1,800 requests per second. The dependency, already struggling, now sees nearly double the traffic. Its latency climbs to 500 ms. The timeout rate hits 95 percent. Offered load hits 1,950. The dependency saturates. Your service threads pile up in the HTTP client pool. CPU spends 70 percent of its time in context switches and lock contention. Throughput collapses to 50 successful requests per second.

The trigger was a 2x latency spike. The sustained state is a 20x throughput collapse. The system will not recover until the offered load drops below the dependency's capacity. But your clients keep retrying. The only way out is to stop sending work.

## Exponential backoff with jitter

Immediate retries are the worst case. Fixed delays are better but synchronise retry waves. Exponential backoff spaces attempts. Jitter desynchronises them.

The standard formula is:

```
delay = min(base * 2^attempt, max_delay) * jitter
```

Full jitter multiplies by a uniform random value in [0, 1]. Decorrelated jitter multiplies the previous delay by a random value in [1, 3]. Decorrelated jitter avoids the thundering herd when many clients back off together after a shared outage.

For example, base 50 ms, max 5 s, attempt 3:

Full jitter: min(50 * 8, 5000) = 400 ms. Random factor 0.3. Delay = 120 ms.
Decorrelated jitter: previous delay was 180 ms. Random factor 2.1. Delay = 378 ms.

Full jitter is simpler and works well when clients are independent. Decorrelated jitter is better when many clients share a failure domain. I'd pick decorrelated jitter for any client that talks to a shared downstream service.

## Retry budgets

Backoff alone does not bound the total retry traffic. A retry budget does. The idea: allow retries only up to a fraction of successful requests. A common rule is 10 percent. For every 10 successful responses you earn one retry token. Each retry consumes a token. No token, no retry — fail fast.

Token bucket implementation:

```python
class RetryBudget:
    def __init__(self, success_ratio=0.1, bucket_size=100):
        self.tokens = bucket_size
        self.max_tokens = bucket_size
        self.success_ratio = success_ratio
        self.lock = threading.Lock()

    def on_success(self):
        with self.lock:
            self.tokens = min(self.max_tokens, self.tokens + self.success_ratio)

    def on_failure(self):
        with self.lock:
            self.tokens = min(self.max_tokens, self.tokens + self.success_ratio)

    def can_retry(self):
        with self.lock:
            if self.tokens >= 1:
                self.tokens -= 1
                return True
            return False
```

The bucket size caps the burst. A bucket of 100 with a 0.1 ratio means you can absorb a sudden 100 retries after a period of health. After that, retries are rate limited to 10 percent of the success rate.

This prevents the retry storm from exceeding the downstream capacity. The maths: if downstream capacity is C and you allow retry ratio R, the maximum offered load is C / (1 - R). With R = 0.1, max load is 1.11 * C. The system stays in the controllable region.

## Circuit breakers

A circuit breaker stops sending requests entirely when the failure rate crosses a threshold. Three states: closed (normal), open (fail fast), half-open (probe).

Transition rules:
- Closed to open: failure rate > threshold over a window (for example 50 percent failures in 10 seconds with minimum 20 requests).
- Open to half-open: after a fixed timeout (for example 30 seconds).
- Half-open to closed: N consecutive successes (for example 5).
- Half-open to open: any failure.

The half-open probe is critical. Without it the breaker stays open forever. With it, a single failure reopens the breaker. This prevents a flapping dependency from hammering the system.

Implementation sketch:

```python
class CircuitBreaker:
    def __init__(self, failure_threshold=0.5, min_requests=20,
                 open_timeout=30, success_threshold=5):
        self.state = 'closed'
        self.failure_threshold = failure_threshold
        self.min_requests = min_requests
        self.open_timeout = open_timeout
        self.success_threshold = success_threshold
        self.successes = 0
        self.failures = 0
        self.total = 0
        self.opened_at = 0
        self.lock = threading.Lock()

    def call(self, func, *args, **kwargs):
        with self.lock:
            if self.state == 'open':
                if time.time() - self.opened_at > self.open_timeout:
                    self.state = 'half-open'
                    self.successes = 0
                else:
                    raise CircuitOpen()
        try:
            result = func(*args, **kwargs)
            self.on_success()
            return result
        except Exception as e:
            self.on_failure()
            raise

    def on_success(self):
        with self.lock:
            self.total += 1
            if self.state == 'half-open':
                self.successes += 1
                if self.successes >= self.success_threshold:
                    self.state = 'closed'
                    self.failures = 0
                    self.total = 0
            elif self.state == 'closed':
                pass

    def on_failure(self):
        with self.lock:
            self.total += 1
            self.failures += 1
            if self.state == 'half-open':
                self.state = 'open'
                self.opened_at = time.time()
            elif self.state == 'closed':
                if self.total >= self.min_requests:
                    rate = self.failures / self.total
                    if rate > self.failure_threshold:
                        self.state = 'open'
                        self.opened_at = time.time()
```

## How they compose

Use all three. Backoff spaces retries. Budget bounds the total retry volume. Breaker stops the bleeding when the downstream is truly dead.

Request flow:
1. Check breaker. If open, fail fast.
2. Check budget. If no token, fail fast.
3. Attempt request.
4. On success: record success in breaker, return token to budget.
5. On failure: record failure in breaker, consume token from budget, schedule retry with backoff.

This composition ensures that:
- Healthy traffic sees zero overhead.
- Transient blips absorb retries within the budget.
- Sustained failures hit the budget limit, then the breaker.
- Recovery is probed automatically via half-open.

## Detection and proof

You need to see the retry storm before it becomes a metastable failure. Key metrics:
- Retry rate per second (client side)
- Retry ratio: retries / (successes + retries)
- Breaker state changes
- Budget token level
- Downstream latency and error rate

A PromQL query for retry ratio:

```
sum(rate(http_client_retries_total[1m]))
/
sum(rate(http_client_requests_total[1m]))
```

Alert when retry ratio > 0.1 for 2 minutes. That is your early warning.

To prove a metastable failure, correlate three signals:
1. Offered load (client requests + retries) exceeds downstream capacity.
2. Downstream latency increases as offered load increases (positive feedback).
3. Removing the original trigger does not reduce offered load because retries sustain it.

Capture a 5 minute window. Plot offered load vs downstream throughput. If the curve bends backward (higher load, lower throughput) you have a metastable failure.

## Common mistakes

- No jitter. Synchronised retries create periodic load spikes that look like a heartbeat on the downstream.
- Unbounded retries. A client that retries forever with 1 second delay will eventually send more retries than the original traffic.
- Breaker threshold too low. A 5 percent failure threshold on a noisy dependency causes constant flapping.
- Breaker timeout too short. A 5 second open timeout on a dependency that needs 30 seconds to recover guarantees re-entry into the open state.
- Budget ratio too high. 50 percent retry budget means offered load can reach 2x capacity. That is not a budget, that is a multiplier.
- Applying budgets per client instance instead of per downstream service. Ten clients each with a 10 percent budget generate 100 percent retry load.

## Checklist for your next review

- [ ] Every HTTP client has exponential backoff with decorrelated jitter.
- [ ] Every client has a retry budget token bucket shared across all instances calling the same downstream.
- [ ] Every downstream dependency has a circuit breaker with half-open probing.
- [ ] Breaker thresholds are tuned per dependency (error rate, latency, timeout).
- [ ] Metrics cover retry rate, retry ratio, breaker state, budget tokens.
- [ ] Alert on retry ratio > 10 percent for 2 minutes.
- [ ] Run a chaos experiment: inject 500 ms latency on a dependency for 60 seconds. Verify the system recovers within 2 minutes of the injection stopping.

## The bottom line

A metastable failure is a feedback loop. Retries are the fuel. Backoff, budgets and breakers are the dampers. You need all three. The budget is the most important because it bounds the total work the system can generate against itself. Without it, backoff only delays the collapse. Without the breaker, the budget drains and the system sits in fail-fast limbo. Without backoff, the budget burns in seconds.

Next time you see latency climb after a deploy rollback, check the retry ratio. If it is above 10 percent, the system is keeping itself down. Fix the dampers.
