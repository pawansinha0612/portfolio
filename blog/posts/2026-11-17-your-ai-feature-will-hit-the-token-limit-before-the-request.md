---
title: Your AI feature will hit the token limit before the request limit
date: 2026-11-17
summary: How to budget tokens per minute for an LLM feature, why reserved max_tokens and agent loops break capacity plans, and how to measure, cap and load test token usage before launch.
description: LLM features hit the tokens-per-minute limit long before requests per minute. Budget peak TPM, mind max_tokens and agents, and test it.
tags: AI, LLM, Performance
highlight: token limit
linkedin: |
  120 requests a minute against a 1,000 RPM limit. 12% used, lots of headroom.

  Then the 429s start.

  Each call carries a 200-token system prompt, 2,000 tokens of retrieved context, 1,200 of chat history and a 1,000-token answer reservation. That's 4,400 tokens a call, or 528,000 tokens a minute against a 400,000 TPM limit.

  And when it's an agent making three model calls per user request, it's 1.58 million.

  LLM capacity planning starts with tokens. Measure every part of the prompt, check how your provider counts max_tokens, and cap agent steps.

  The article has an interactive calculator: see which limit you hit first.

  Do you know your feature's peak tokens per minute?

  #AI #LLM #PerformanceEngineering
---
Your support assistant handles 120 questions a minute at peak. The provider allows 1,000 requests a minute, so the load test plan says 12% utilisation and moves on. On launch morning, 429 errors start at 9:05, while the request graph is nowhere near its limit.

The limit you hit was the other one: tokens per minute.

## Count the tokens in one call

Every model call sends and reserves tokens from several sources:

> tokens per call = system prompt + retrieved context + conversation history + answer

A realistic retrieval-augmented (RAG) assistant, for example:

| Part | Tokens |
|---|---|
| System prompt and tool definitions | 200 |
| Retrieved context (5 chunks) | 2,000 |
| Conversation history | 1,200 |
| Answer (max_tokens) | 1,000 |
| **Total** | **4,400** |

At 120 calls a minute that is 120 × 4,400 = 528,000 tokens a minute. Against a 400,000 TPM limit you are at 132%, while the request limit is at 12%.

Two details make the real number larger than the naive one.

**The answer reservation.** Some providers count the max_tokens you request against the limit when the call starts, not the tokens the model actually writes. An answer that uses 250 tokens but reserves 1,000 costs 1,000 against the limit until the call finishes. Read your provider's rate-limit documentation for how it counts input and output, and set max_tokens to what answers really need rather than a generous round number.

**History grows.** Conversation history is not a constant. Turn ten carries the previous nine. If you plan with an average conversation, plan for the long ones too, or cap history by summarising old turns.

<div class="widget" data-widget="tokens"><p><em>Interactive calculator: open this post on pawansinha.com.au to try it with your own numbers.</em></p></div>

## Agents multiply everything

An agent that plans, calls a tool and then writes the answer makes at least three model calls per user request. Each call carries the system prompt and tool definitions again, and each later step also carries the earlier steps' output.

Taking the same 4,400 tokens per call and three calls per request, 120 user requests a minute is 1,584,000 tokens a minute, roughly four times the limit. In practice the later calls are larger, so this is a lower bound.

Agents also make the token cost unpredictable. A question that needs five tool calls instead of two costs more than twice as much. Give the agent a step limit and a token budget per user request, and stop with a useful partial answer when it runs out.

## Measure, don't estimate

Tokenisers differ between model families, so a word count or another vendor's tokeniser is only a rough guide. Use the numbers the API gives you.

- **Log usage on every response.** The major APIs return input and output token counts with each response. Log them with the feature name, the prompt version and the number of context chunks.
- **Count before sending** where your provider offers a token-counting endpoint or library, to reject or trim oversized prompts early.
- **Watch the rate-limit headers.** Many providers return the remaining requests and tokens for the current window. Graph them. They show how close you run to the wall before the first 429.

From real logs, use the p95 tokens per call, not the mean. The heavy calls (long histories, many chunks, agent loops) are the ones that tip you over at peak.

## Reduce tokens per call

In rough order of effort:

1. **Lower max_tokens** to the p99 of real answer lengths plus a margin.
2. **Retrieve fewer, better chunks.** Five 400-token chunks where two would do is the most common waste.
3. **Summarise history** beyond the last few turns.
4. **Use prompt caching** where your provider offers it for repeated prefixes such as the system prompt and tool definitions. It cuts cost and latency. Check whether cached tokens still count toward your rate limit, because providers differ.
5. **Route simple questions to a smaller model** with its own, separate limits.

Streaming does not reduce token usage. It changes when the user sees the first words, not how many tokens the call consumes.

## Load test the token wall

A load test for an LLM feature has to send realistic prompts, not "hello":

- Build the test data from real (anonymised) conversations, with the real distribution of history length and retrieved context.
- Ramp the request rate past the point where calculated TPM crosses the limit, and confirm where the 429s really start.
- Report tokens per minute next to requests per minute, and break 429s down by which limit the provider says you hit.
- Include the retry behaviour of your client, because retries consume tokens too.

## Checklist

1. List every component of a call and measure its tokens from real traffic.
2. Compute peak TPM: p95 tokens per call × peak calls per minute, including agent steps.
3. Compare with both limits. Plan for the lower ceiling.
4. Set max_tokens deliberately, and cap history and agent steps.
5. Log token usage and rate-limit headers in production.
6. Load test with realistic prompts until the token limit, not just the request limit, is reached.

Requests per minute is the number on the pricing page. Tokens per minute is the number that decides your launch day.
