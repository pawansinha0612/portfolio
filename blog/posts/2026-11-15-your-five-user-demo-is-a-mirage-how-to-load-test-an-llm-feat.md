---
title: Your five‑user demo is a mirage: how to load‑test an LLM feature correctly
date: 2026-11-15
summary: A five‑user demo can hide latency issues that surface at scale. Learn how to measure TTFT, TPOT, streaming and set RPM/TPM limits with k6.
description: Load test LLMs: avoid five‑user demos, measure TTFT, TPOT, streaming, RPM and TPM with k6
tags: Performance, k6, LLM
linkedin: |
  Five‑user demos look great, but they hide the latency that surfaces at scale. In a production‑ready LLM test, you must capture TTFT, TPOT, total time, RPM, TPM, and support streaming. A k6 script that measures all of these gives you a clear picture of where the bottleneck lies. The key takeaway: always measure the first token latency; coordinated omission is the silent killer. Have you ever seen a test pass with a 200 ms TTFT and then fail under load? What strategies do you use to surface real‑world latency?
---
## Five‑user demos are deceptive
You run a demo with five users typing prompts. The LLM replies in 200 ms. You think the feature is ready for launch. A week later, a production load of 200 concurrent users pushes the latency to 3 s. The demo was misleading.

The root cause is that a small‑scale demo does not expose the true behaviour of the system under realistic load. It masks coordinated omission, cache warm‑up, thread contention, and network bottlenecks. To avoid this, you must design a test that measures the right metrics at the right scale.

## What to measure: TTFT, TPOT, total time and streaming

### TTFT – Time to First Token
TTFT is the interval between sending a request and receiving the first token. It is a good indicator of the request–response pipeline latency, including network round‑trip time, load‑balancer routing, and the first micro‑service hop. For an LLM, TTFT is often dominated by model warm‑up and GPU scheduling.

### TPOT – Time to Produce Output Token
TPOT is the time between the first token and the last token. In a streaming API, it captures the pacing of token generation. TPOT is influenced by model inference time, queueing delays, and GPU utilisation.

### Total Time
Total time is the sum of TTFT and TPOT. It is the end‑to‑end latency that matters to the user. If TTFT is 200 ms and TPOT is 2 s, the total latency is 2.2 s.

### Streaming vs. Non‑streaming
A streaming response delivers tokens as they are produced. Non‑streaming waits until the entire output is ready. The two modes have different TTFT and TPOT profiles. Streaming can hide long TPOT by showing early tokens, but the user still experiences the full latency when the last token arrives.

## RPM and TPM limits

RPM (requests per minute) and TPM (tokens per minute) are throughput metrics that capture the load on the system. RPM is the number of API calls per minute. TPM is the number of tokens generated per minute. A high TPM can saturate GPU memory or cause queue back‑pressure.

To set realistic limits, you need to understand the service’s capacity curve. Use Little’s Law (L = λW) where L is the average number of requests in the system, λ is the arrival rate, and W is the average waiting time. By measuring W at different λ, you can extrapolate the λ that keeps W below a target threshold.

## Why five users mislead

A five‑user demo usually runs on a single node. The cache is warm, the GPU is idle, and the queue is empty. The system behaves as if it has infinite resources. When you increase the load, the GPU becomes a bottleneck, context switches increase, and queueing delays appear. The demo also suffers from coordinated omission: the time spent waiting for a token is omitted from the measured latency because the user only sees the first token.

## A k6 test plan that measures everything

Below is a k6 script that sends concurrent requests to an LLM endpoint, measures TTFT, TPOT, total time, RPM, TPM, and supports streaming. The script uses k6’s built‑in metrics and a custom summary function.

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

// Custom metrics
export let ttft = new Trend('ttft_ms');
export let tpot = new Trend('tpot_ms');
export let total = new Trend('total_ms');
export let rpm = new Rate('rpm');
export let tpm = new Counter('tpm');

export let options = {
  stages: [
    { duration: '1m', target: 50 },   // ramp up
    { duration: '5m', target: 50 },   // steady state
    { duration: '1m', target: 0 },    // ramp down
  ],
  thresholds: {
    ttft_ms: ['p(95)<500'],
    tpot_ms: ['p(95)<2000'],
    total_ms: ['p(95)<2500'],
    rpm: ['rate>0.95'],
    tpm: ['rate>0.95'],
  },
};

export default function () {
  const prompt = {
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'Explain queueing theory in simple terms.' }],
    stream: true,
  };

  const params = {
    headers: { 'Content-Type': 'application/json' },
  };

  const start = new Date().getTime();
  const res = http.post('https://api.llm.example.com/v1/chat/completions', JSON.stringify(prompt), params);
  const firstTokenTime = new Date().getTime();

  check(res, {
    'status is 200': (r) => r.status === 200,
  });

  // Parse streaming response
  let tokenCount = 0;
  const decoder = new TextDecoder();
  for (const chunk of res.body) {
    const text = decoder.decode(chunk, { stream: true });
    if (text.includes('data:')) {
      const payload = JSON.parse(text.replace(/^data: /, ''));
      if (payload.choices && payload.choices[0].delta && payload.choices[0].delta.content) {
        tokenCount++;
      }
      if (payload.choices[0].finish_reason === 'stop') {
        break;
      }
    }
  }

  const end = new Date().getTime();
  const ttft_ms = firstTokenTime - start;
  const tpot_ms = end - firstTokenTime;
  const total_ms = end - start;

  ttft.add(ttft_ms);
  tpot.add(tpot_ms);
  total.add(total_ms);
  rpm.add(1);
  tpm.add(tokenCount);

  sleep(1); // pause between iterations
}
```

### How the script works

1. **Stages** define the load profile. The script ramps up to 50 virtual users (VUs) over one minute, keeps them steady for five minutes, then ramps down. This approximates a realistic traffic burst.
2. **Custom metrics** capture TTFT, TPOT, total time, RPM, and TPM. Each metric is a `Trend` or `Counter` that k6 aggregates across VUs.
3. **Streaming parsing** reads the SSE stream. The first token arrival time is captured by the first `data:` event. Subsequent tokens increment a counter until the `finish_reason` is `stop`.
4. **Thresholds** enforce that 95 % of requests finish within the target latencies. RPM and TPM rates must stay above 95 % of the target.

### Interpreting the results

| Metric | Target | Typical failure | Fix |
|--------|--------|-----------------|-----|
| TTFT (ms) | < 500 | GPU warm‑up, load‑balancer latency | Increase GPU pool, optimise routing |
| TPOT (ms) | < 2000 | Model inference queue | Scale out inference nodes, optimise batch size |
| Total (ms) | < 2500 | Combined TTFT+TPOT | Address both TTFT and TPOT |
| RPM | > 0.95 of target | Queue back‑pressure | Add more workers, increase throughput |
| TPM | > 0.95 of target | Token generation throttling | Tune model parameters, increase GPU memory |

## Checklist for a production‑ready LLM load test

- [ ] Define realistic traffic patterns: ramp‑up, peak, ramp‑down.
- [ ] Measure TTFT, TPOT, total time, RPM, TPM.
- [ ] Use streaming to capture token pacing.
- [ ] Set thresholds that reflect user experience goals.
- [ ] Run tests on the target environment, not a dev box.
- [ ] Verify that the system honours rate limits and back‑pressure signals.
- [ ] Analyse queueing delays with k6’s `http_req_waiting` metric.
- [ ] Correlate CPU/GPU utilisation with latency spikes.
- [ ] Repeat tests with different model sizes and batch sizes.
- [ ] Document the hypothesis, data, and conclusion.

## Common pitfalls and how to avoid them

1. **Coordinated omission** – If you measure only the time until the last token, you miss the waiting time before the first token. Always capture TTFT.
2. **Ignoring streaming** – Non‑streaming responses hide token pacing. Test both modes.
3. **Assuming one node suffices** – Scale the GPU pool to match the target RPM.
4. **Not checking throughput** – High latency can still meet a target if throughput is low. Verify both.
5. **Using static thresholds** – Latency can vary with payload size. Adjust thresholds per payload.

## Takeaway

A five‑user demo can be a mirage. Only a full load test that measures TTFT, TPOT, total time, RPM, TPM, and supports streaming can reveal the true behaviour of an LLM feature. Use k6 to instrument every stage of the request, set realistic thresholds, and iterate until the system meets the user‑experience goals.

---

## LinkedIn post

Five‑user demos look great, but they hide the latency that surfaces at scale. In a production‑ready LLM test, you must capture TTFT, TPOT, total time, RPM, TPM, and support streaming. A k6 script that measures all of these gives you a clear picture of where the bottleneck lies. The key takeaway: always measure the first token latency; coordinated omission is the silent killer. Have you ever seen a test pass with a 200 ms TTFT and then fail under load? What strategies do you use to surface real‑world latency?
