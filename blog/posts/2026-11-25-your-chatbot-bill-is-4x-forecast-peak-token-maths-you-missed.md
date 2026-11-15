---
title: Your chatbot bill is 4x forecast — peak token maths you missed
date: 2026-11-25
summary: Convert DAU to peak RPS, model context growth and max_tokens, apply prompt caching and batch discounts, and build a cost model that survives finance review.
description: Peak chatbot cost model from DAU, token maths, caching, batch discounts, max_tokens trap.
tags: Performance, AI, Cost Optimization, LLM
linkedin: |
  Your chatbot forecast missed peak concurrency, context growth, and the max_tokens trap. The bill arrives 4x over budget.
  
  One concrete takeaway: model peak cost using max_tokens, not average output tokens. At 417 peak RPS, a 4,096 max_tokens setting on GPT-4o burns $1,500 per minute if a prompt goes verbose. Set max_tokens to p99 output + 20% buffer and alert at 80% utilisation.
  
  How do you handle cost modelling for LLM traffic — spreadsheet, simulation, or something else?
---
Your chatbot serves 50,000 DAU. The monthly bill lands at $47,000. The forecast you gave finance was $12,000. You modelled average load, average context length, and average output tokens. Peak concurrency, conversation history growth, and the max_tokens parameter just rewrote your budget.

## DAU to peak RPS: the conversion most teams get wrong

Start with daily active users. Multiply by sessions per user per day, then turns per session. That gives total daily requests. Divide by 86,400 for average RPS. Then apply a peak factor.

For a consumer chat app, a typical day looks like this:

- 50,000 DAU
- 8 sessions per DAU per day
- 6 turns per session (user + assistant = 1 turn)
- Total daily requests = 50,000 × 8 × 6 = 2,400,000
- Average RPS = 2,400,000 / 86,400 ≈ 27.8 RPS

Peak factor for consumer traffic is 12× to 20×. Use 15× for planning. Peak RPS = 27.8 × 15 ≈ 417 RPS. That is the load your cost model must sustain for the busiest hour, not the average.

## Tokens per request: context grows, system prompt stays

Each request sends three token buckets:

1. **System prompt** — fixed, cacheable. Example: 600 tokens.
2. **Conversation history** — grows linearly with turn count. Assume 180 tokens per prior turn (user + assistant). At turn 6, history = 5 × 180 = 900 tokens.
3. **Current user message** — variable. Budget 80 tokens.

Input tokens at turn 6 = 600 + 900 + 80 = 1,580 tokens.

Output tokens: the model generates a response. Average might be 220 tokens. But the `max_tokens` parameter sets a hard ceiling. If you set `max_tokens = 2,000`, a verbose or adversarial prompt can consume the full budget. For peak cost modelling, you must use `max_tokens`, not the average.

## Prompt caching: 50% off the static prefix

OpenAI, Anthropic, and Google all discount cached prefix tokens. The system prompt and early conversation turns are identical across requests in a session. Only the new user message and the latest assistant response differ.

With a 600-token system prompt cached at 50% discount:
- Cached input tokens: 600 × 0.5 = 300 effective tokens
- Non-cached input tokens: 900 (history) + 80 (user) = 980 tokens
- Total effective input tokens = 300 + 980 = 1,280

Without caching you would pay for 1,580 input tokens. Caching saves 300 tokens per request at peak.

## Batch API: 50% off everything — if you can wait

Batch APIs (OpenAI Batch, Anthropic Message Batches) process requests asynchronously with up to 24-hour turnaround. They discount both input and output tokens by 50%. Use them for:
- Offline summarisation
- Embedding generation
- Nightly report generation

Do not use batch for real-time chat. The latency SLA breaks the user experience.

## The max_tokens trap

`max_tokens` is a hard limit on completion length. You pay for every token generated up to that limit. If you set `max_tokens = 4,096` on GPT-4o ($15 / 1M output tokens) but the typical response is 300 tokens, a single runaway request costs 13× the average. At 417 peak RPS, one pathological minute burns:

417 RPS × 60 s × 4,096 tokens × $15 / 1,000,000 = $1,536 per minute.

Set `max_tokens` to the 99th percentile of your actual output distribution plus a 20% buffer. Monitor `completion_tokens` in production and alert when it exceeds 80% of `max_tokens`.

## A defensible monthly cost model

Build the model in a spreadsheet. Rows = turn number (1 to N). Columns = token buckets, effective tokens after caching, cost per request, requests per day at that turn, daily cost. Sum across turns and multiply by 30.

### Worked example: GPT-4o pricing

| Parameter | Value |
|---|---|
| Input price | $5.00 / 1M tokens |
| Output price | $15.00 / 1M tokens |
| Cached input discount | 50% |
| System prompt (cached) | 600 tokens |
| Tokens per history turn | 180 tokens |
| User message | 80 tokens |
| max_tokens (budget) | 800 tokens |
| Peak factor | 15× |
| DAU | 50,000 |
| Sessions/DAU/day | 8 |
| Turns/session | 6 |

**Turn 6 (peak context) cost per request:**
- Cached input: 600 × 0.5 × $5 / 1M = $0.0015
- Non-cached input: (5 × 180 + 80) × $5 / 1M = 980 × $5 / 1M = $0.0049
- Output (max_tokens): 800 × $15 / 1M = $0.0120
- **Total per request = $0.0184**

**Daily requests at turn 6:** 50,000 DAU × 8 sessions × 1 (only the 6th turn) = 400,000 requests.
**Daily cost at turn 6:** 400,000 × $0.0184 = $7,360.

Repeat for turns 1–5 (lower history tokens) and sum. For this example, the 6-turn session averages $0.0142 per request across all turns. Total daily requests = 2.4M. Daily cost = 2.4M × $0.0142 = $34,080. Monthly = $1,022,400.

That number looks scary. It assumes every session hits 6 turns at peak pricing every day. Reality: sessions are shorter, peak factor applies only to the busiest hour, and you can optimise.

## Optimisation levers that actually work

1. **Summarise history** — replace raw turns with a 200-token summary after turn 3. Cuts history tokens by 60%.
2. **Dynamic max_tokens** — set per-use-case. Code generation needs 2,000; FAQ needs 300.
3. **Route simple queries to smaller models** — GPT-4o-mini ($0.15 / $0.60 per 1M) handles 40% of traffic at 3% of the cost.
4. **Enforce session limits** — cap at 8 turns. Force new session for longer conversations.
5. **Cache aggressively** — use `prompt_cache_key` (Anthropic) or rely on automatic prefix caching (OpenAI). Ensure system prompt is identical across all requests.

## Checklist before you show finance

- [ ] Peak RPS derived from DAU × sessions × turns × peak factor (document the factor)
- [ ] Token counts per turn measured from production logs, not guessed
- [ ] Cached vs non-cached input tokens split shown explicitly
- [ ] max_tokens set per route, justified by p99 output length + 20%
- [ ] Batch API usage identified for async workloads with 50% discount applied
- [ ] Model routing table: which % of traffic hits which model at what price
- [ ] Sensitivity table: cost at peak factor 10×, 15×, 20×
- [ ] Monthly total = Σ (turn cost × daily requests at turn) × 30 × peak-hour-weighting

## The number you can defend

Finance asks: "What is the worst credible month?" Your answer: "At 20× peak factor, 6-turn sessions, no summarisation, GPT-4o for all traffic: $1.4M. With summarisation, dynamic max_tokens, 40% routed to 4o-mini, and 15× peak factor: $380k. We are tracking at $320k last month."

That conversation ends with a nod, not a spreadsheet audit.
