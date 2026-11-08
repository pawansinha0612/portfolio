---
title: One retry turned a 6% 429 rate into 25%
date: 2026-11-19
summary: Why immediate retries against a rate limit multiply rejections without helping a single extra user, the maths behind it, and the retry design that works: Retry-After, jittered backoff, retry budgets, client-side rate limiting and queues.
description: Immediate retries against a rate limit turn 6% 429s into 25% and help no extra users. The maths, and retries that work: backoff, jitter, budgets.
tags: Performance, LLM, Resilience
highlight: 25%
linkedin: |
  Your API allows 1,000 requests a minute. Peak traffic is 1,064. About 6% of calls get a 429.

  Add one immediate retry and the rejection rate settles near 25%. Add three and it's about 50%, with almost twice the traffic.

  The part that surprises people: the share of users who end up failing is still 6%. A rate limit is a fixed capacity. Retries can't create more of it. They add load, latency and noise while the same number of requests succeed.

  Retries only help when they move work into quieter seconds: honour Retry-After, back off with jitter, cap them with a retry budget, and rate-limit yourself before the provider has to.

  The article has an interactive calculator: set your limit, traffic and retry count and see the real rejection rate.

  How many retries does your client do on a 429, and does your load test include them?

  #PerformanceEngineering #SRE #LLM
---
Your AI feature calls a provider that allows 1,000 requests a minute. At peak you send 1,064. The load test shows a 6% rate of `429 Too Many Requests`, which seems tolerable, so the client retries once on a 429. In production the provider's dashboard shows a quarter of your calls rejected, and users see answers arrive seconds later than before.

Nothing changed except the retry. That retry is the reason the number got worse.

## The arithmetic of retrying into a wall

A rate limit is a fixed capacity: 1,000 accepted calls per minute, no matter how many arrive. Everything above it is rejected.

Without retries, the rejection rate is simply the excess: 64 / 1,064 = 6%.

Now add one immediate retry. Every rejected call comes back once, so the total attempts are:

> attempts = first attempts × (1 + f)

where f is the share of attempts that get rejected. But f itself depends on the total attempts, because only 1,000 of them can succeed:

> f = 1 − 1,000 / attempts

Solve the two together and you get f ≈ 25% with about 1,325 attempts a minute. With three retries, the attempts become first × (1 + f + f² + f³). The fixed point is now f ≈ 50% and about 1,980 attempts a minute, nearly double the real demand.

Then look at what users see. The limit still accepts exactly 1,000 calls a minute, and there are still 1,064 users asking. So 64 of them, 6%, still fail after all their retries. **Retries did not save a single extra user.** They added load, turned a 6% error rate into a 25% or 50% one on every dashboard, and made successful users wait for a second or third round trip.

<div class="widget" data-widget="retry"><p><em>Interactive calculator: open this post on pawansinha.com.au to try it with your own numbers.</em></p></div>

This is a simple steady-state model. It assumes retries land in the same window and every attempt has the same chance of rejection. Real limiters use token buckets and sliding windows, and some count rejected calls against the quota too, which makes things worse. The direction is the same in every case. When demand exceeds capacity for a sustained period, immediate retries only amplify.

## When retries do help

Retries are valuable when the overload is short. A burst exhausts a token bucket for two seconds, and a retry that waits until the bucket refills succeeds. The key word is *waits*. A retry helps only when it moves work from a full second into an emptier one.

So the design question is never "how many retries?" but "where in time do the retries land?"

## A retry design that works

**1. Honour Retry-After.** On a 429 or 503 the server may send `Retry-After`, as a number of seconds or an HTTP date. It is the server telling you when capacity returns. Use it as the minimum wait. Many LLM providers also return headers describing the remaining requests and tokens in the current window. Read your provider's documentation and log them. They tell you how close to the wall you run before the first 429.

**2. Exponential backoff with full jitter.** Without jitter, every client that was rejected at the same moment retries at the same moment, and you get synchronised waves. Full jitter spreads them out:

```text
wait = random(0, min(cap, base × 2^attempt))
```

With base 0.5 s and cap 20 s, the third retry waits somewhere between 0 and 4 s. The spread is what breaks the herd.

**3. A retry budget.** Cap retries at a share of first attempts, for example 10%, measured over a sliding window. Below the budget, transient failures still get retried. In sustained overload the budget runs out and extra retries stop, so the load can't double. In the calculator, a 10% budget with three retries keeps rejections near 15% instead of 50%.

**4. Limit yourself before the provider does.** If you know the limit is 1,000 requests and 400,000 tokens a minute, run a client-side token bucket slightly below both. Requests over the line wait in a queue or are shed with a clear message. A queue in your own process gives you control over priority and timeouts, and the provider never sees the excess.

**5. Bound the total time, not just the attempts.** A user waiting for a chat answer will not wait 40 seconds of backoff. Give each user request a deadline and stop retrying when the remaining time can't fit another attempt.

**6. Degrade on purpose.** When the limit is the bottleneck for minutes at a time, retries can't fix it. Capacity can: a higher quota tier, a second region or deployment, or a smaller model for low-value calls. Decide in advance which requests get the fallback.

## Test the retries, not just the API

Most load tests run without the production client's retry logic, so they measure the API and miss the amplification. To see the real behaviour:

- Drive the load through the same client library and retry settings as production, or reproduce them in the test script.
- Record first attempts and retries as separate metrics. In k6, tag the requests (`tags: { attempt: '1' }`) and report each tag separately.
- Push past the limit on purpose, for example 110% of the quota for ten minutes, and compare four numbers: rejection rate, total attempts, user-level failure rate and user-level latency.
- Run it once with retries off as a baseline. If the user failure rate is the same with retries on, your retries are only adding load.

## Checklist

1. Find every retry loop on the path to a rate-limited dependency, including the ones inside SDKs.
2. Make sure each one honours Retry-After and uses jittered exponential backoff.
3. Add a retry budget, around 10% of first attempts.
4. Rate-limit and queue on your side, just below the provider's request and token limits.
5. Give each user request a deadline that stops retries.
6. Load test above the limit with production retry settings, and report first attempts and retries separately.

A 429 is the provider telling you the capacity is spent. A retry that ignores that message doesn't get more capacity. It just asks again, louder.
