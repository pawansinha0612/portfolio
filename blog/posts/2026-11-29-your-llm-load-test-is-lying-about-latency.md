---
title: Your LLM load test is lying about latency
date: 2026-11-29
summary: Prompt caching turns repetitive load tests into best-case fantasies. Learn how to measure real cache hit rates, generate production-like prompt variety, and stop fooling yourself.
description: Why repetitive LLM load tests overstate performance and how to test with realistic prompt variety.
tags: Performance, LLM, AI Testing
linkedin: |
  Your LLM load test shows 200ms p99. Production sees 3 seconds. The culprit: prompt caching.
  
  Most providers cache KV prefixes of 1024+ tokens. A test cycling 5 prompts hits cache 98% of the time. Real traffic with 10K unique prompts per hour hits cache maybe 20%.
  
  The fix: generate 10K+ unique prompts matching your production token-length distribution. Log `cached_tokens` per request. Assert cache hit rate stays under 30% at p90. Test cold-start latency separately.
  
  What's the highest cache hit rate you've seen in a test that didn't match production?
---
Your load test reports p50 latency of 200 ms and p99 of 400 ms. You ship to production. Users see p50 of 800 ms and p99 over 3 seconds. The test used fifty virtual users cycling through five prompt templates. The production traffic has ten thousand unique prompts per hour. The difference is prompt caching.

Most LLM providers now cache the key-value (KV) cache for common prompt prefixes. When the same system prompt and few-shot examples repeat, the model skips recomputing attention for those tokens. The first request pays the full prefill cost. Subsequent requests with the same prefix pay only for the new suffix tokens. A test that cycles five prompts will show 80 to 100 percent cache hit rates. Production rarely exceeds 20 percent.

## How prompt caching actually works

Prefix caching stores the KV cache for a prompt prefix up to a provider-defined limit. OpenAI caches prefixes of at least 1024 tokens. Anthropic caches prefixes of at least 1024 tokens for Claude 3.5 Sonnet and 2048 for Opus. Google Vertex AI caches prefixes of at least 1024 tokens. The cache key is the exact token sequence. A single character change in the system prompt or a different few-shot example breaks the cache.

The cache lives on the inference server. It is not shared across regions or projects. It expires after a provider-defined TTL, typically five to ten minutes of inactivity. Some providers evict least-recently-used entries under memory pressure.

When a request hits the cache, the response includes a `cached_tokens` field (OpenAI) or `cache_read_input_tokens` (Anthropic). The latency drops because prefill computes only the uncached suffix. Decode cost is unchanged.

## Why five prompts is a lie

Imagine a test with five prompt templates. Each template has a 1500-token system prompt and a 200-token user question. The first run of each template misses the cache. The next forty-nine runs hit the cache. That is a 98 percent cache hit rate. The measured latency reflects only the 200-token prefill plus decode.

Production traffic might have a 1500-token system prompt but ten thousand unique user questions per hour. Each question is a cache miss on the user portion. The cache hit rate on the system prompt prefix is high, but the marginal prefill cost per request is still the full user question length. The test understates prefill latency by a factor of seven.

The maths is simple. Prefill latency scales roughly linearly with token count. A 1700-token prefill takes 850 ms at 0.5 ms per token. A 200-token prefill takes 100 ms. The test reports 100 ms. Reality is 850 ms. The gap widens with longer contexts.

## Generating realistic prompt variety

You need a prompt generator that mirrors production diversity. Start with your actual prompt templates. Identify every variable slot: system prompt version, few-shot examples, user question, retrieved context chunks, conversation history length.

Build a generator that samples from realistic distributions:

- System prompt version: 80 percent v3, 15 percent v2, 5 percent v1
- Few-shot examples: pick 3 to 5 from a pool of 20, weighted by production frequency
- User question: sample from a corpus of 5000 real questions or use a language model to generate semantically diverse variants
- Retrieved context: vary the number of chunks (1 to 10) and their token lengths (50 to 500 each)
- Conversation history: 0 to 10 turns, with turn lengths following a log-normal distribution

A Python sketch using `tiktoken` to enforce token budgets:

```python
import random
import tiktoken

enc = tiktoken.get_encoding("cl100k_base")

def build_prompt() -> str:
    sys_version = random.choices(["v1", "v2", "v3"], weights=[0.05, 0.15, 0.80])[0]
    system = SYSTEM_PROMPTS[sys_version]
    
    few_shot = random.sample(FEW_SHOT_POOL, k=random.randint(3, 5))
    few_shot_text = "\n".join(few_shot)
    
    question = random.choice(QUESTION_CORPUS)
    
    num_chunks = random.randint(1, 10)
    chunks = random.sample(CONTEXT_CHUNKS, k=num_chunks)
    context = "\n".join(chunks)
    
    history_turns = random.randint(0, 10)
    history = "\n".join(random.choices(HISTORY_TURNS, k=history_turns))
    
    return f"{system}\n{few_shot_text}\n{context}\n{history}\nUser: {question}"

def token_len(text: str) -> int:
    return len(enc.encode(text))

# Generate 10000 prompts, verify token distribution
prompts = [build_prompt() for _ in range(10000)]
lengths = [token_len(p) for p in prompts]
print(f"p50: {sorted(lengths)[5000]} tokens")
print(f"p99: {sorted(lengths)[9900]} tokens")
```

Run this generator in your load test. Each virtual user pulls a unique prompt from a pre-generated pool of at least 10000 entries. Rotate the pool every test run.

## Measuring cached tokens in your test

Do not guess. Extract the cache metrics from every response. OpenAI returns `usage.prompt_tokens_details.cached_tokens`. Anthropic returns `usage.cache_read_input_tokens` and `usage.cache_creation_input_tokens`. Vertex AI returns `cached_content_token_count`.

Log these fields alongside latency. Compute the cache hit rate per request:

```
cache_hit_rate = cached_tokens / (cached_tokens + uncached_prompt_tokens)
```

Plot latency versus cache hit rate. You will see a step function. Requests with 0 percent hit rate cluster at the full prefill latency. Requests with 100 percent hit rate cluster at the suffix-only latency. The production distribution will sit between.

A k6 threshold that catches the lie:

```javascript
export const options = {
  thresholds: {
    'http_req_duration{expected_response:true}': ['p(99)<2000'],
    'llm_cache_hit_rate': ['p(90)>0.15'], // expect at least 15% hit rate at p90
  },
};

function handleSummary(data) {
  const cacheRates = data.metrics.llm_cache_hit_rate.values;
  const p90 = cacheRates.sort((a,b)=>a-b)[Math.floor(cacheRates.length*0.9)];
  if (p90 > 0.5) {
    console.warn(`Cache hit rate p90 is ${p90}. Test may not reflect production.`);
  }
  return { stdout: JSON.stringify(data) };
}
```

## Testing with production-like context

Cache behaviour changes with context length. A 4000-token prefix caches. A 8000-token prefix may not if the provider caps cache entry size. Test at your production context percentiles.

Run three test profiles:

1. **Cold start**: Clear cache between iterations. Measure full prefill latency at p50, p95, p99 context lengths.
2. **Warm steady state**: Pre-populate cache with the top 100 system prompt variants. Run 10000 unique prompts. Measure latency and cache hit rate.
3. **Cache churn**: Simulate a deploy that changes the system prompt. Measure the latency spike as the new prefix populates.

Profile 2 is your production baseline. Profile 1 is your worst case. Profile 3 is your deploy risk.

## Checklist before you trust an LLM load test

- [ ] Prompt pool size exceeds 10000 unique entries
- [ ] Prompt token length distribution matches production p50, p95, p99
- [ ] System prompt versions match production rollout percentages
- [ ] Few-shot example selection matches production diversity
- [ ] Retrieved context chunk count and size distribution matches production
- [ ] Conversation history length distribution matches production
- [ ] Cache hit rate logged per request and asserted below 30 percent at p90
- [ ] Cold-start latency measured and alerted on
- [ ] Deploy-time cache churn tested
- [ ] Test runs in the same region and project as production

## The trap of synthetic benchmarks

Public benchmarks like MMLU or GSM8K use fixed prompts. They report cached latency. They do not represent your workload. A model that scores 90 percent on MMLU with 100 ms cached latency may take 2 seconds on your 5000-token unique prompts. Always benchmark with your prompt generator.

Providers change caching behaviour without notice. OpenAI reduced the minimum cacheable prefix from 1024 to 512 tokens in late 2024. Anthropic added cache control headers. Vertex AI introduced explicit cache management. Re-run your cache characterization test monthly.

## What to tell stakeholders

"The load test shows 200 ms p99 because it reused five prompts. Production will see 800 ms p99 because every prompt is unique. We need to size for the cold path. The warm path is a bonus."

Then show the latency versus cache hit rate plot. The conversation ends there.
