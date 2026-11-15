---
title: Your RAG pipeline p99 is hiding in the reranker
date: 2026-11-27
summary: RAG latency budgets break down when embedding, vector search, reranking and LLM calls share one load test. Here is how to isolate each hop and find the real bottleneck.
description: Load test RAG pipelines per hop: embedding, vector search, reranking, LLM. Find true bottlenecks with latency budgets.
tags: Performance, RAG, k6, LLM
linkedin: |
  Your RAG load test says p99 is 2.3s. Production says 12s. The gap? You tested the chain, not the hops.
  
  Embedding, vector search, reranker, LLM — each has its own queue, saturation point and tail. A single end-to-end test hides which one breaks first.
  
  Fix: assign a latency budget per hop (e.g., embed 300ms, search 400ms, rerank 600ms, LLM 1.5s). Run four isolated k6 scenarios at production concurrency. Export queue-time histograms from each service. The hop that breaches its budget under load is your bottleneck.
  
  Rerankers are the usual suspect — cross-encoder latency scales linearly with candidate count. Cut top-k or add a bi-encoder filter before the cross-encoder.
  
  What per-hop budget split do you use for your RAG SLO?
---
Your load test reports p99 at 2.3 seconds. The on-call engineer gets paged at 3 am because real users see 12 seconds. The test sent one request at a time and measured total wall time. It never stressed the embedding service, the vector index, the reranker and the LLM as independent hops. Each hop has its own queue, its own saturation point and its own tail latency that compounds under concurrency.

A RAG pipeline is a chain of four distinct services. The embedding model turns text into vectors. The vector database runs approximate nearest neighbour search. The reranker reorders candidates with a cross-encoder. The LLM generates the final answer. Each hop adds latency and each hop can become the bottleneck when load increases. Treating the chain as a black box hides where the queue builds.

## Latency budgets per hop

Start with a budget. Say your product SLO is p99 under 3 seconds end to end. Allocate headroom for network, serialisation and GC pauses. A realistic split for a 3 second budget might look like this.

| Hop | Target p99 | Rationale |
|-----|------------|-----------|
| Embedding | 300 ms | Batch size 32 on GPU, cold start warmed |
| Vector search | 400 ms | HNSW index, efSearch tuned, single shard |
| Reranker | 600 ms | Cross-encoder on GPU, batch 16, top 50 in |
| LLM generate | 1500 ms | 512 output tokens, vLLM, p99 includes queue |
| Overhead | 200 ms | HTTP, auth, logging, retries |

The numbers above are a worked example. Your budget changes with model size, hardware and SLO. The point is to assign a number to each hop so you can write a pass or fail check per hop.

## Isolate each hop in the load test

Write four separate k6 scenarios. Each scenario calls one service directly with production shaped payloads. Use the same concurrency ramp you expect in production. Do not call the full chain in one scenario unless you are testing end to end SLO compliance after the per hop baselines are green.

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const embedFail = new Rate('embed_fail');
const searchFail = new Rate('search_fail');
const rerankFail = new Rate('rerank_fail');
const llmFail = new Rate('llm_fail');

export const options = {
  scenarios: {
    embedding: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m', target: 10 },
        { duration: '5m', target: 50 },
        { duration: '2m', target: 0 },
      ],
      exec: 'embedding',
    },
    vector_search: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m', target: 10 },
        { duration: '5m', target: 50 },
        { duration: '2m', target: 0 },
      ],
      exec: 'vectorSearch',
    },
    reranker: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m', target: 5 },
        { duration: '5m', target: 25 },
        { duration: '2m', target: 0 },
      ],
      exec: 'reranker',
    },
    llm: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m', target: 3 },
        { duration: '5m', target: 15 },
        { duration: '2m', target: 0 },
      ],
      exec: 'llm',
    },
  },
  thresholds: {
    'http_req_duration{scenario:embedding}': ['p(99)<300'],
    'http_req_duration{scenario:vector_search}': ['p(99)<400'],
    'http_req_duration{scenario:reranker}': ['p(99)<600'],
    'http_req_duration{scenario:llm}': ['p(99)<1500'],
  },
};

const payloads = [
  'How do I reset my password?',
  'What is the refund policy for international orders?',
  'Explain the difference between RAG and fine tuning.',
];

function pick() { return payloads[Math.floor(Math.random() * payloads.length)]; }

export function embedding() {
  const res = http.post('https://embedding.internal/embed',
    JSON.stringify({ texts: [pick()], model: 'bge-large-en-v1.5' }),
    { headers: { 'Content-Type': 'application/json' }, tags: { scenario: 'embedding' } }
  );
  check(res, { 'status 200': (r) => r.status === 200 }) || embedFail.add(1);
}

export function vectorSearch() {
  const vec = new Array(1024).fill(0).map(() => Math.random());
  const res = http.post('https://vector.internal/search',
    JSON.stringify({ vector: vec, top_k: 50, ef_search: 128 }),
    { headers: { 'Content-Type': 'application/json' }, tags: { scenario: 'vector_search' } }
  );
  check(res, { 'status 200': (r) => r.status === 200 }) || searchFail.add(1);
}

export function reranker() {
  const query = pick();
  const docs = Array.from({ length: 50 }, (_, i) => `Doc ${i}: ${query} detail ${i}`);
  const res = http.post('https://reranker.internal/rerank',
    JSON.stringify({ query, documents: docs, top_n: 10 }),
    { headers: { 'Content-Type': 'application/json' }, tags: { scenario: 'reranker' } }
  );
  check(res, { 'status 200': (r) => r.status === 200 }) || rerankFail.add(1);
}

export function llm() {
  const res = http.post('https://llm.internal/v1/chat/completions',
    JSON.stringify({
      model: 'llama-3-70b-instruct',
      messages: [{ role: 'user', content: pick() }],
      max_tokens: 512,
      temperature: 0.2,
    }),
    { headers: { 'Content-Type': 'application/json' }, tags: { scenario: 'llm' } }
  );
  check(res, { 'status 200': (r) => r.status === 200 }) || llmFail.add(1);
}
```

Run each scenario alone first. Then run all four together to see cross contention on shared GPU nodes or network fabric. The thresholds fail fast when a hop exceeds its budget.

## Where the bottleneck actually lives

### Embedding service

Embedding models are memory bound on GPU. Batch size controls throughput. A common pattern is to accumulate requests for a few milliseconds then run a single forward pass. If the accumulator window is too long you add latency. If it is too short you underutilise the GPU. Measure queue time separately from model time. Export a histogram of `queue_ms` and `infer_ms` from the embedding server. If `queue_ms` p99 exceeds 100 ms at target concurrency, increase replica count or reduce accumulator window.

### Vector search

HNSW index latency grows with `ef_search` and degrades when the hot shard does not fit in memory. Run a test with `ef_search` at 64, 128, 256 and plot p99 vs recall. Pick the smallest `ef_search` that meets your recall target. Watch for CPU saturation on the index nodes. If CPU hits 80 percent, add read replicas or shard the index. Disk I/O appears as tail latency spikes when the OS evicts index pages. Use `iostat -x 1` during the test to confirm.

### Reranker

Cross-encoders are the hidden killer. They run a full attention pass over query plus each candidate. Latency scales linearly with candidate count and sequence length. A reranker that takes 50 ms for 10 candidates takes 250 ms for 50. At 25 concurrent users that is 6.25 seconds of GPU time per second of wall time. You need either more GPUs or a smaller candidate set. The fix is often to reduce `top_k` from vector search or to cascade a cheap bi-encoder filter before the cross-encoder. Measure `rerank_latency_ms` per candidate and plot against concurrency. The slope tells you the GPU saturation point.

### LLM generation

LLM latency is dominated by output token count and KV cache pressure. vLLM and TensorRT-LLM use paged attention to share KV blocks. Under load the scheduler queues requests when free blocks run out. The queue time is invisible to a single request test. Run a sustained load at target concurrency for 10 minutes. Export `time_to_first_token` and `inter_token_latency` percentiles. If `time_to_first_token` p99 grows linearly with concurrency, the prefill queue is saturated. Increase `max_num_seqs` or add replica pods. If `inter_token_latency` p99 spikes, the decode batch is too large for GPU memory and the scheduler is swapping blocks. Reduce `max_num_batched_tokens`.

## Coordinated omission in RAG

Coordinated omission happens when the load generator waits for a response before sending the next request. If the system stalls, the generator stops sending and the measured latency distribution misses the stall. k6's default VU model avoids this because each VU runs independently. But if you use a constant arrival rate executor with `preAllocatedVUs` too low, the generator becomes the bottleneck. Set `preAllocatedVUs` to at least 2x the peak target VUs. Verify by checking that `vus` metric never plateaus below target during the sustained stage.

## Checklist before you ship

- [ ] Each hop has a p99 budget derived from the end to end SLO
- [ ] k6 scenarios test each hop in isolation at production concurrency
- [ ] Embedding server exports queue and infer histograms
- [ ] Vector search tuned for `ef_search` vs recall at target QPS
- [ ] Reranker candidate count justified by recall gain per ms
- [ ] LLM scheduler metrics show no prefill or decode queue growth
- [ ] Combined run shows no cross hop resource contention
- [ ] Alerting rules fire on per hop p99 breach not just end to end

## The maths of compounding tails

If each hop has independent latency distributions, the end to end p99 is not the sum of p99s. It is the p99 of the convolution. For independent hops the variance adds. A quick approximation: if hop latencies are lognormal with geometric standard deviation σ, the end to end σ is sqrt(σ₁² + σ₂² + σ₃² + σ₄²). Say each hop has σ = 1.3. Combined σ = sqrt(4 * 1.3²) = 2.6. The tail fattens fast. This is why per hop budgets must be tighter than naive division suggests. Allocate 60 percent of the budget to the median case and 40 percent to tail absorption.

## What to tell the team

Run the four scenarios in CI on every model or index change. Fail the build if any hop exceeds its budget. The end to end test runs nightly. When the on-call engineer gets paged, the dashboard shows which hop p99 breached first. That is the service to scale or optimise. No more guessing whether it was the vector index or the reranker.
