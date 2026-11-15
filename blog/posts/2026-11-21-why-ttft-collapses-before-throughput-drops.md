---
title: Why TTFT collapses before throughput drops
date: 2026-11-21
summary: TTFT spikes while throughput looks healthy because queueing hits the prefill phase first. Streaming responses make k6 TTFB a poor proxy. Here is how to measure and fix it.
description: TTFT degrades before throughput under load. Prefill queueing, decode streaming, and why k6 TTFB misleads.
tags: Performance, LLM, k6, Observability
linkedin: |
  Your LLM endpoint shows healthy throughput but users complain about latency. The problem: TTFT collapses before throughput drops because requests queue for prefill slots. Throughput measures completed requests. TTFT measures wait for the first token. That wait is pure queue time when prefill slots are full.
  
  k6 time-to-first-byte does not equal TTFT. It includes TLS, headers, and network. Some servers flush headers before prefill starts, making TTFB near zero while real TTFT is seconds.
  
  Measure TTFT at the first token byte using a streaming client. Instrument the prefill queue on the server. Size prefill slots to GPU memory. Alert on p99 TTFT, not throughput.
  
  What metric do you use to catch queueing before users feel it?
---
You are load testing an LLM endpoint. Throughput sits at a steady 50 requests per second. GPU utilisation reads 60 percent. Yet the p99 time to first token has jumped from 200 milliseconds to eight seconds. The dashboard shows no errors. Something is queuing but it is not the GPU.

The culprit is queueing before the prefill phase. Throughput measures completed requests. TTFT measures the wait until the first token of a single request. When concurrency rises, new requests sit in a scheduler queue waiting for a prefill slot. That wait adds directly to TTFT but barely touches throughput until the queue backs up far enough to starve the decode loop.

## Prefill vs decode

Prefill processes the entire prompt in one forward pass. It is compute bound and memory bound. The KV cache for the prompt is written once. Decode generates tokens one at a time. Each step reads the KV cache and writes one new entry. Decode is memory bandwidth bound.

Because prefill consumes the bulk of compute for a request, the scheduler typically gates prefill slots. A common pattern is to allow N concurrent prefills where N is tuned to GPU memory. Decode slots are often higher because each step is lighter. When all prefill slots are busy, incoming requests queue. That queue time is pure latency added to TTFT.

Little's Law applies here. If the average prefill time is 150 ms and you allow four concurrent prefills, the maximum prefill throughput is 4 / 0.15 ≈ 26.7 requests per second. At 30 requests per second the queue grows. Average queue wait rises. TTFT rises. Throughput stays at 26.7 because the prefill pipeline is saturated.

## KV cache pressure moves the bottleneck

Each active request holds a KV cache. For a 4k context at 16 bit that is roughly 1.5 GB per request on a 70B model. Eight concurrent requests consume 12 GB. If the GPU has 24 GB you can run perhaps twelve before OOM. The scheduler must limit concurrency to fit memory. That limit caps prefill throughput.

When the cache limit is reached, new requests cannot even enter the prefill queue. They wait at the admission gate. That wait is invisible to GPU utilisation metrics. It shows up only in the request latency distribution.

## Measuring TTFT with streaming

LLM endpoints stream tokens via server sent events or chunked transfer encoding. The first chunk contains the first token. TTFT is the elapsed time from request send to first chunk received.

A correct measurement must capture the moment the first byte of the first token arrives. Not the HTTP headers. Not the TLS handshake. Not the connection reuse. The first token byte.

In k6 you can use the `http.stream` API with a custom response handler. The handler receives chunks as they arrive. Record the timestamp on the first chunk that contains token data.

```javascript
import http from 'k6/http';
import { check } from 'k6';

const url = 'https://api.example.com/v1/chat/completions';
const payload = JSON.stringify({
  model: 'llama-70b',
  messages: [{ role: 'user', content: 'Hello' }],
  stream: true,
  max_tokens: 256
});

const params = {
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${__ENV.TOKEN}`
  },
  responseType: 'stream',
  tags: { name: 'llm_stream' }
};

export default function () {
  const start = new Date().getTime();
  let ttft = null;

  const res = http.post(url, payload, params, (chunk) => {
    if (ttft === null && chunk.length > 0) {
      // first non-empty chunk after headers
      ttft = new Date().getTime() - start;
    }
  });

  check(res, { 'status 200': (r) => r.status === 200 });
  if (ttft !== null) {
    console.log(`TTFT ${ttft}ms`);
  }
}
```

This captures the first data chunk. In practice you may need to parse SSE framing to ignore the initial `data: ` prefix and the `[DONE]` marker. The principle holds: measure from request dispatch to first token payload byte.

## Why k6 time to first byte is not TTFT

k6 reports `timings.waiting` as time to first byte (TTFB). For a streaming LLM response TTFB includes:

1. DNS lookup
2. TCP connect
3. TLS handshake
4. Request write
5. Server side queue wait
6. Prefill compute
7. First token serialisation
8. Network propagation of first chunk

Items 1 to 4 and 8 are network overhead. They are constant per request and do not reflect model serving latency. Item 5 is the queue wait we care about. Item 6 is prefill. Item 7 is trivial.

TTFB conflates all of them. Under load the queue wait (item 5) grows. TTFB grows. But so does the variance from network jitter. Worse, if the server flushes headers early before prefill starts, TTFB reports near zero while the real TTFT is seconds away. Some frameworks send `200 OK` and headers immediately then block on prefill. k6 sees first byte at header flush. The metric lies.

## Isolating the queue component

To see queue wait separately you need server side instrumentation. Emit a timestamp when the request enters the prefill queue and another when prefill starts. The difference is pure queue time. Export that as a histogram to Prometheus.

On the client side you can approximate by measuring TTFB on a warm connection (keep alive) and subtracting a baseline measured at near zero concurrency. The delta is mostly queue plus prefill variance. It is noisy but useful for alerting.

A better client side proxy: send a tiny prompt (one token) at the same concurrency as your real test. Its prefill time is negligible. Its TTFB approximates queue wait plus network. Subtract the network baseline. What remains is queue wait.

## Checklist for TTFT investigation

- [ ] Measure TTFT at the first token byte, not at headers
- [ ] Plot TTFT percentile latency against concurrency
- [ ] Plot prefill queue depth from server metrics
- [ ] Verify prefill slot count matches GPU memory budget
- [ ] Check KV cache eviction or swap events
- [ ] Confirm decode throughput is not starved by prefill backlog
- [ ] Alert on p99 TTFT not on throughput

## Fixing the queue

Options ranked by impact:

1. Increase prefill slots if GPU memory allows. Each slot adds one concurrent prefill. Throughput scales linearly until memory or compute saturates.
2. Batch small prompts together. Some engines support continuous batching where prefill and decode share the same iteration. This reduces queue fragmentation.
3. Add a second GPU and shard the prefill queue. Requires a load balancer that understands model parallelism.
4. Reject or shed load at the admission gate with a 429 when queue depth exceeds a threshold. Protects TTFT for admitted requests.
5. Optimise prefill kernels. Flash attention, quantised KV cache, speculative prefill. These shrink the prefill time per request, raising the service rate.

Each fix shifts the bottleneck. After prefill scales, decode memory bandwidth becomes the limit. Then context length limits hit. The queue moves downstream. Monitor each stage.

## Summary

TTFT degrades first because it includes the prefill queue wait. Throughput hides the queue until saturation. k6 TTFB mixes network, headers, and queue into one number. Measure TTFT at the first token byte. Instrument the prefill queue on the server. Size prefill slots to GPU memory. Alert on TTFT percentiles. The queue you cannot see is the one that hurts users.
