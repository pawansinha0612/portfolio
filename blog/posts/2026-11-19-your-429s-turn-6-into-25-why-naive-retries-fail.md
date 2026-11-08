---
title: Your 429s Turn 6% into 25% – Why Naive Retries Fail
date: 2026-11-19
summary: Naive retry logic can quadruple your 429 rate. Learn how to design a robust strategy with Retry‑After, backoff, budgets, fallbacks and queues.
description: 429 Too Many Requests: design retries with Retry‑After, jittered backoff, retry budgets, fallback models and queues to avoid exponential growth.
tags: Performance, LLM, Retry
linkedin: |
  When you hit a 429, do you just retry or do you think about the server’s limits? A naive retry loop can turn a 6 % 429 rate into 25 %. The trick is to honour the Retry‑After header, use jittered exponential backoff, cap retries with a budget, and fall back to a lighter model when the 429 rate spikes. How do you design your retry strategy to avoid the thundering herd effect?
---
## Your 429s Turn 6% into 25% – Why Naive Retries Fail

You run a nightly integration test against a third‑party LLM. The test reports a 6 % 429 rate. Once the service goes live, the 429 rate explodes to 25 %. The culprit? A retry loop that blindly repeats failed requests.

The loop looks like this:

```text
for i in 1..3:
    send request
    if status == 429:
        sleep 1s
```

The 1‑second pause seems harmless, but it adds three more requests per failed call. If the original 6 % of 1 000 requests are 429s, you add 18 % more 429s. The service now sees 1 000 + 180 = 1 180 requests, and the 429 rate climbs to 25 %.

### Why naive retries amplify 429s

A 429 response means the server has reached a rate limit. Retrying without regard to the server’s state creates *coordinated omission*: the client keeps sending requests while the server throttles, and the client’s own latency metrics become skewed. The server’s load increases, the rate limit tightens, and the cycle repeats.

The effect can be visualised with Little’s Law. Let 

- **L** be the average queue length, 
- **λ** the arrival rate, 
- **W** the average waiting time.

Little’s Law states **L = λW**. When retries add to λ, W grows too, and the system saturates faster than the test environment suggested.

### Designing a robust retry strategy

A principled approach requires four layers:

1. **Respect the Retry‑After header** – the server tells you how long to wait.
2. **Use exponential backoff with jitter** – avoid thundering herd.
3. **Limit the number of retries** – a retry budget.
4. **Add fallbacks or queues** – reduce load when the API is congested.

#### Retry‑After header

The HTTP 429 response may include a `Retry-After` header. It can be an HTTP date or a number of seconds. If present, use it directly:

```text
if response.status == 429 and response.headers.contains("Retry-After"):
    wait = int(response.headers["Retry-After"])  # seconds
```

If the header is missing, fall back to a sensible default, e.g. 2 s. Do not ignore the header; the server’s back‑off policy is part of the contract.

#### Exponential backoff with jitter

A classic retry policy is:

```text
delay = base * 2^retry + jitter
```

where `base` is the initial wait (e.g. 1 s), `retry` is the attempt number (starting at 0), and `jitter` is a random value in 

```
[0, base * 2^retry]
```

The jitter spreads retries over a window, reducing the chance that many clients hit the server simultaneously. In practice, set `base` to 1 s and cap the maximum delay at 30 s.

#### Retry budgets

A *retry budget* limits the total number of retries per request or per time window. For example, allow at most 2 retries per request, or 100 retries per minute across the entire service. The budget prevents runaway load.

| Budget type | Example | Effect |
|-------------|---------|--------|
| Per‑request | 2 retries | Keeps latency bounded |
| Per‑minute | 100 retries | Caps overall load |

Implement the budget with a token bucket. Each token represents a retry slot. When a retry is needed, attempt to take a token; if none are available, drop the request or send to a queue.

#### Fallback models

If the LLM provider offers multiple models, use a lower‑cost or local model when the primary one is rate‑limited. For example, switch from `gpt‑4` to `gpt‑3.5` when the 429 rate exceeds 10 %. This reduces the load on the throttled endpoint and preserves user experience.

#### Queueing and backpressure

A simple in‑memory queue can buffer requests when the 429 rate is high. The queue drains at a controlled rate, e.g. 5 req/s. Use a bounded queue to avoid unbounded memory growth. If the queue fills, reject new requests with a 503 and a `Retry‑After` header.

### Putting it all together

Below is a k6 script that demonstrates a full retry strategy. The script respects `Retry‑After`, applies exponential backoff with jitter, enforces a per‑request retry budget, and falls back to a lighter model when the 429 rate is high.

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';

export let options = {
    vus: 10,
    duration: '30s',
    thresholds: {
        http_req_failed: ['rate<0.05'], // <5% failures
        http_req_duration: ['p(99)<500'],
    },
};

const BASE_MODEL = 'gpt-4';
const FALLBACK_MODEL = 'gpt-3.5';
const MAX_RETRIES = 2;

export default function () {
    let retries = 0;
    let model = BASE_MODEL;
    let response;

    while (retries <= MAX_RETRIES) {
        response = http.post('https://api.llm.com/v1/chat', JSON.stringify({ model, prompt: 'Hello' }), {
            headers: { 'Content-Type': 'application/json' },
        });

        if (response.status === 429) {
            let retryAfter = response.headers['Retry-After'];
            let wait = retryAfter ? parseInt(retryAfter) : 1 + Math.random() * Math.pow(2, retries);
            sleep(wait);
            retries++;
            continue;
        }

        check(response, { 'status 200': r => r.status === 200 });
        break;
    }

    // If the 429 rate is high, switch to fallback model for subsequent requests
    if (get429Rate() > 0.10) {
        model = FALLBACK_MODEL;
    }
}

function get429Rate() {
    // In a real system, read from a shared counter or metric
    return __VU % 10 === 0 ? 0.12 : 0.04; // mock
}
```

The script shows how to combine the four layers. In production you would replace the `get429Rate` stub with a real metric query.

### Checklist for a resilient retry policy

| Item | What to verify |
|------|----------------|
| Retry‑After usage | Server returns a header and client honours it |
| Backoff formula | `delay = base * 2^retry + jitter` |
| Retry budget | Max retries per request and per time window |
| Fallback path | Alternate model or local cache is used when 429 > threshold |
| Queue behaviour | Requests are buffered, not dropped, and the queue is bounded |
| Metrics | 429 rate, retry count, latency percentiles, queue length |
| Alerts | 429 rate > 10 % triggers an alert |

Follow this checklist before deploying a new LLM integration. It will keep your 429 rate in check and prevent naive retries from turning a 6 % problem into a 25 % crisis.

## Final thoughts

Rate‑limited APIs are a common source of chaos. The key is to treat retries as a controlled, bounded process rather than a brute‑force hammer. Respect the server’s signals, back off intelligently, cap retries, and fall back gracefully. With these practices in place, you can keep your service responsive without overloading the provider.
