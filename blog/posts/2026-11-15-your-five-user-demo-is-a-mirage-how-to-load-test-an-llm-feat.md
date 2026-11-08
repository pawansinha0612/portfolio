---
title: Your five-user demo is a mirage: load testing an LLM feature
date: 2026-11-15
summary: Why an LLM feature that feels instant for five people slows down at launch (batching, KV cache, prefill, rate limits), the four numbers to measure (TTFT, TPOT, total time, tokens per minute), and a k6 test that measures them with realistic prompts.
description: An LLM feature that feels instant for five users slows at launch. Measure TTFT, TPOT, total time and TPM at real concurrency with k6.
tags: Performance, k6, LLM
highlight: mirage
linkedin: |
  Five people tried the AI assistant in the demo. First words in half a second, full answer in four. Everyone loved it.

  At launch, 600 questions a minute means about 130 answers generating at the same moment. Servers batch those together, so each answer gets a smaller share of the GPU, and new requests wait for memory to free up. The first word now takes three seconds.

  Measure four things at real concurrency:
  → time to first token (how long the bubble stays empty)
  → time per output token (how fast it types)
  → total time per answer
  → tokens per minute against your limit

  The article has an interactive calculator: turn your launch numbers into answers in flight and tokens per minute.

  How many answers will your feature be generating at once at peak?

  #LLM #PerformanceEngineering #k6
---
Five people try the new AI assistant in the sprint demo. The first words appear in half a second, and a full answer streams out in about four. On launch day, with a few thousand users online, the first word takes three seconds and some answers stall halfway.

Nothing in the demo was wrong. It just measured a different system: one with an idle GPU, an empty queue and a warm cache.

## Why five users tell you almost nothing

LLM serving behaves differently from a typical API under concurrency, for reasons that a five-user demo never triggers.

- **Answers stay in flight for seconds.** A REST call finishes in 50 ms. A streamed answer occupies the server for the whole generation, often 5 to 20 seconds. By Little's Law (concurrency = arrival rate × time in the system), 10 requests a second at 13 seconds each means about 130 answers in flight.
- **Continuous batching trades per-user speed for throughput.** Serving engines run many sequences through the model together. Total tokens per second rises with concurrency, but each user's share falls, so the typing speed users see drops as load rises.
- **KV cache memory caps concurrency.** Every active sequence keeps its attention state in GPU memory, and long prompts keep more of it. When memory is full, new requests wait in a queue, and time to first token jumps.
- **Prefill competes with generation.** Processing a long input prompt (the prefill) is heavy work. A burst of RAG requests with 6,000-token contexts slows the token stream of everyone already generating.
- **Hosted APIs add rate limits and shared capacity.** Requests and tokens per minute are capped, and latency on shared capacity varies with the provider's overall load.
- **Demos repeat the same prompt.** Prompt caching and warm prefixes make repeated questions faster than real, varied traffic.

## The four numbers to measure

1. **Time to first token (TTFT).** From sending the request to the first token arriving. It's what users feel as "is it working?". It includes network, queueing and prefill.
2. **Time per output token (TPOT).** The average gap between tokens after the first one: (total time − TTFT) / (output tokens − 1). It's the typing speed. Some tools call it inter-token latency.
3. **Total time.** TTFT + TPOT × (output tokens − 1). For non-streaming integrations, such as an agent step or a summariser feeding another service, this is the only number that matters.
4. **Throughput in tokens and requests per minute,** compared with your provider's limits or your own servers' capacity. The [token budget post](/blog/your-ai-feature-will-hit-the-token-limit-before-the-request/) covers the token side in detail.

Report each at p50, p95 and p99, at the concurrency you expect at peak, with streaming switched on if your app streams.

<div class="widget" data-widget="llmload"><p><em>Interactive calculator: open this post on pawansinha.com.au to try it with your own numbers.</em></p></div>

## A k6 test that measures them

k6's HTTP client reads the whole response before it returns, so it can't timestamp each streamed token. Two approximations work well enough for load testing:

- **TTFT ≈ time to first byte** (`res.timings.waiting`) with streaming on, because the server starts the response with the first token. A proxy that buffers the stream breaks this, so test against the same path your app uses.
- **TPOT ≈ (total − TTFB) / (output tokens − 1)**, using the token count the API reports in the final usage chunk.

The script below targets an OpenAI-compatible chat endpoint. Adjust the body and the parsing for your provider.

```js
import http from 'k6/http';
import { check } from 'k6';
import { Trend, Counter, Rate } from 'k6/metrics';
import { SharedArray } from 'k6/data';

// Real, anonymised conversations with realistic context and history lengths
const prompts = new SharedArray('prompts', () => JSON.parse(open('./prompts.json')));

const ttft = new Trend('llm_ttft', true);
const tpot = new Trend('llm_tpot', true);
const total = new Trend('llm_total', true);
const outTokens = new Counter('llm_output_tokens');
const limited = new Rate('llm_429');

export const options = {
  scenarios: {
    peak: {
      executor: 'ramping-arrival-rate',
      startRate: 1, timeUnit: '1s', preAllocatedVUs: 200, maxVUs: 400,
      stages: [{ target: 10, duration: '5m' }, { target: 10, duration: '15m' }],
    },
  },
  thresholds: {
    llm_ttft: ['p(95)<2000'],
    llm_tpot: ['p(95)<60'],
    llm_429: ['rate<0.01'],
  },
};

export default function () {
  const p = prompts[Math.floor(Math.random() * prompts.length)];
  const res = http.post(`${__ENV.BASE_URL}/v1/chat/completions`, JSON.stringify({
    model: __ENV.MODEL,
    messages: p.messages,
    max_tokens: 500,
    stream: true,
    stream_options: { include_usage: true },
  }), {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${__ENV.API_KEY}` },
    timeout: '120s',
  });

  limited.add(res.status === 429);
  if (!check(res, { 'status is 200': (r) => r.status === 200 })) return;

  let n = 0;
  for (const line of res.body.split('\n')) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
    try {
      const chunk = JSON.parse(line.slice(6));
      if (chunk.usage) n = chunk.usage.completion_tokens;
    } catch (e) { /* ignore keep-alive or partial lines */ }
  }

  ttft.add(res.timings.waiting);
  total.add(res.timings.duration);
  if (n > 1) {
    outTokens.add(n);
    tpot.add((res.timings.duration - res.timings.waiting) / (n - 1));
  }
}
```

A few design choices matter more than the code:

- **Open model.** `ramping-arrival-rate` keeps sending 10 requests a second even when answers slow down, which is what real users do. A closed model with a fixed number of VUs would quietly send less as latency rises, and hide the problem.
- **Enough VUs.** Each VU is busy for the whole answer, so you need at least rate × p99 total time, here 10 × 20 s = 200, plus margin.
- **Realistic prompts.** Use real conversation lengths and real retrieved context. Ten copies of "hello" measures the prompt cache.
- **Long enough.** Run at peak for at least 15 minutes so queues, caches and rate-limit windows settle.

If you want true per-token timing, use a client that reads the stream incrementally. Open-source benchmarking tools such as GuideLLM and LLMPerf do this, and so does a small Python script with an async HTTP client. For a ready-made k6 starting point, my [LLM load test generator](/tools/llm-load-test/) builds a script like the one above from your own prompts.

## Reading the results

- **TTFT rises sharply while TPOT stays flat:** requests are queueing before they start. Look at the server's waiting queue or KV cache usage, or at provider-side throttling.
- **TPOT rises steadily with load:** the batch is getting bigger and each sequence gets less compute. This is the throughput/latency trade-off. Decide what typing speed is acceptable and cap concurrency there.
- **429s appear before latency moves:** you hit a rate limit, not a capacity limit. Check whether requests or tokens ran out.
- **p99 total time far above p95:** look at output length. A few very long answers dominate the tail. A lower max_tokens or a length instruction fixes this better than any infrastructure change.

## Checklist

1. Estimate peak concurrency with Little's Law: requests per second × seconds per answer.
2. Build test data from real prompts, with real context and history lengths.
3. Measure TTFT, TPOT, total time and tokens per minute at p95 and p99.
4. Use an arrival-rate executor and enough VUs for the longest answers.
5. Hold peak for at least 15 minutes.
6. Set thresholds on TTFT, TPOT and the 429 rate, not only on errors.

A demo shows that the feature works. A load test shows whether it still works when everyone is using it at once.
