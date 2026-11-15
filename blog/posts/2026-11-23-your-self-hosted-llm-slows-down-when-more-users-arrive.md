---
title: Your self-hosted LLM slows down when more users arrive
date: 2026-11-23
summary: Continuous batching in vLLM raises aggregate throughput but starves individual requests. Here is how KV cache pressure moves the concurrency knee and how to find it with a load test.
description: vLLM continuous batching, KV cache memory limits, and finding the concurrency knee with load testing.
tags: Performance, LLM, vLLM, GPU
linkedin: |
  Continuous batching in vLLM keeps the GPU busy but starves each user. Aggregate throughput climbs while per-request tokens per second drops because the KV cache caps live sequences. Little's Law: L = λ × W. When L is fixed by memory, raising arrival rate λ forces wait time W up.
  
  Run a concurrency sweep (2, 4, 8, 12, 16 users) and plot aggregate throughput vs p99 TTFT. The knee is where throughput flattens and TTFT inflects. For Llama-3-8B on A100 80GB that knee often sits at 12-16 concurrent streams.
  
  Fixes that move the knee right: shorter max context, prefix caching, FP8 quantisation, or tensor parallel GPUs. Adding request rate without changing memory arithmetic just hurts users.
  
  Where does your knee sit?
---
Your load test shows 2,000 tokens per second aggregate throughput. The product owner asks why the chat widget feels sluggish at 20 concurrent users. You check the dashboard: p99 time-to-first-token is 4.2 seconds. The GPU sits at 94 percent utilisation. Adding more requests makes throughput climb but every user gets slower.

This is the continuous batching trap. vLLM's scheduler packs prefill and decode steps into the same iteration so the GPU never idles. Aggregate throughput rises because the hardware stays busy. Per-request latency rises because each request waits longer for its turn in the batch. The KV cache is the lever that controls where the knee sits.

## Continuous batching changes the queueing model

Static batching waits until a full batch of prefill requests arrives, runs them, then runs decode steps until every sequence finishes. Continuous batching evicts finished sequences and admits new prefill requests in the very next iteration. The GPU sees one long stream of work. From a queueing-theory perspective the system becomes a single M/G/1 queue with a service time that grows with the number of live sequences.

Each live sequence holds a KV cache block for every layer. For a 7B model with 32 layers, 4,096 hidden size and 32 attention heads, each token consumes roughly 32 layers × 2 (key and value) × 4,096 bytes × 2 bytes per half-precision element = 524,288 bytes per token. A 4,096 token context uses 2 GiB per sequence. On an 80 GiB A100 you fit about 36 full contexts before you hit the memory wall. In practice you reserve headroom for activations and the CUDA graph workspace so the real limit lands near 28 to 30 sequences.

## KV cache memory math

The formula is straightforward:

```
KV_bytes = 2 × layers × hidden_size × head_dim × seq_len × dtype_bytes
```

For Llama-3-8B (32 layers, 4,096 hidden, 128 head_dim, bfloat16):

```
2 × 32 × 4096 × 128 × seq_len × 2 = 67,108,864 × seq_len bytes
```

At 4,096 tokens that is 256 MiB per sequence. At 8,192 tokens it doubles to 512 MiB. The memory grows linearly with sequence length and batch size. When the allocator cannot find a free block the scheduler stalls. vLLM logs `Block manager: out of memory` and the iteration time spikes.

## Throughput rises while per-user tokens per second falls

Imagine a test that sends 100 requests with a mean prompt length of 512 tokens and a max output of 256 tokens. At concurrency 4 the GPU runs one prefill of 2,048 tokens then 256 decode steps. Iteration time is 45 ms. Aggregate throughput is 2,048 / 0.045 ≈ 45,500 tokens/s. Each user sees 256 / (45 ms × 256 steps) ≈ 22 tokens/s.

Raise concurrency to 16. The scheduler now interleaves 16 prefill chunks and 16 decode streams. Iteration time grows to 120 ms because the KV cache pressure forces smaller chunk sizes and more kernel launches. Aggregate throughput becomes (16 × 512) / 0.12 ≈ 68,000 tokens/s. A 50 percent gain. But each user now waits 120 ms per decode step so their throughput drops to 256 / (0.12 × 256) ≈ 8.3 tokens/s. The knee has moved left.

Little's Law explains it: `L = λ × W`. The number of live sequences `L` is capped by KV memory. Arrival rate `λ` is your request rate. Wait time `W` is the per-request latency. When you push `λ` up while `L` is fixed, `W` must rise. The aggregate throughput `λ` can still climb because the GPU stays saturated, but the user experience degrades.

## Finding the concurrency knee with a load test

You need a test that measures both aggregate throughput and per-request latency across a sweep of concurrency levels. A k6 script with a constant-arrival-rate executor works well:

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  scenarios: {
    sweep: {
      executor: 'constant-arrival-rate',
      rate: 10,           // requests per second, adjust per step
      timeUnit: '1s',
      duration: '3m',
      preAllocatedVUs: 50,
      maxVUs: 100,
    },
  },
  thresholds: {
    'http_req_duration{type:ttft}': ['p(99)<2000'],
    'http_req_duration{type:decode}': ['p(99)<100'],
  },
};

const payload = JSON.stringify({
  model: 'llama-3-8b',
  prompt: 'A'.repeat(512),
  max_tokens: 256,
  stream: true,
});

export default function () {
  const res = http.post('http://localhost:8000/v1/completions', payload, {
    headers: { 'Content-Type': 'application/json' },
    tags: { type: 'ttft' },
  });
  check(res, { 'status 200': (r) => r.status === 200 });
  // decode latency captured via stream chunks in a real script
  sleep(0.1);
}
```

Run the script at 2, 4, 8, 12, 16, 20, 24 concurrent users (adjust `rate` and `preAllocatedVUs`). Plot two curves: aggregate tokens per second (sum of all completion tokens divided by wall time) and p99 time-to-first-token. The knee is the concurrency where aggregate throughput stops scaling linearly and p99 TTFT inflects upward. In the example above the knee sits at 12 users. Beyond that you trade user latency for marginal throughput.

## Detecting KV pressure in production

vLLM exposes Prometheus metrics. Watch these:

- `vllm:gpu_cache_usage_percent` — should stay below 85 percent. Above that the block manager starts evicting and recomputing.
- `vllm:num_batched_tokens` — decode step token count. A drop while request rate holds steady means the scheduler is shrinking chunks to fit memory.
- `vllm:iteration_time_seconds` — p99 above 200 ms usually correlates with KV fragmentation.

If you see `gpu_cache_usage_percent` at 92 and `iteration_time_seconds` p99 climbing, you are past the knee. The fix is not more GPUs. It is one of:

1. Reduce max sequence length. Cutting from 8,192 to 4,096 doubles the number of sequences that fit.
2. Enable prefix caching (`--enable-prefix-caching`) so shared system prompts reuse KV blocks.
3. Quantise to FP8 or AWQ. Half the KV bytes per token.
4. Add a second GPU and enable tensor parallelism. The KV cache shards across devices so each GPU holds half the layers.

## Checklist before you ship

- [ ] Measure KV bytes per sequence for your model and dtype.
- [ ] Calculate max sequences = (GPU memory × 0.85) / KV_per_sequence.
- [ ] Run the concurrency sweep. Record the knee.
- [ ] Set your autoscaler max replicas so `replicas × max_sequences_per_gpu` covers peak concurrency with 20 percent headroom.
- [ ] Alert on `gpu_cache_usage_percent > 85` for 5 minutes.
- [ ] Document the latency SLO at the knee concurrency. That is your capacity limit.

Continuous batching is a throughput optimiser, not a latency optimiser. Treat the concurrency knee as a hard boundary. Push past it only when you can accept the per-user degradation or when you have changed the memory arithmetic.
