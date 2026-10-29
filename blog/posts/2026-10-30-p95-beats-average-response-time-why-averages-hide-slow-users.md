---
title: p95 beats average response time: why averages hide slow users
date: 2026-10-30
summary: Averages mask the worst cases. Learn why p95 is a better indicator of real user experience with a simple numbers example.
tags: Performance, Metrics, Testing
linkedin: |
  Averages can make performance look great, but they hide the slowest 5 % of users. Instead of just reporting the mean, look at the 95th percentile – it tells you what most users really experience. In a recent test, the mean was 800 ms but the p95 was 1550 ms; the difference would have gone unnoticed until users started complaining. If you want to keep your users happy, start analysing the tail. What other metrics do you rely on to gauge real user experience?
---
# Why p95 outperforms average response time

When a report says the average page load is 1.2 s, it looks good. But the average can hide a cluster of slow users. I prefer to look at the 95th percentile (p95). It tells me what 95 % of users experience. If that is 1.8 s, the remaining 5 % are stuck at 5 s or more.

## What is p95?

The 95th percentile is the value below which 95 % of observations fall. In practical terms, if you sort all response times from fastest to slowest and pick the value at the 95‑percent position, you get p95. It is a standard metric in performance engineering.

## A worked‑out example

Imagine you have logged 1000 response times (ms) for a button click:

```
[200, 210, 215, 220, 225, …, 2500]
```

The first 950 values are below 1500 ms. The 951st value is 1550 ms, and the last one is 2500 ms. The average is:

```
avg = sum(times) / len(times) ≈ 800 ms
```

But the p95 is 1550 ms. 5 % of users experience a delay twice the average. If you only optimise for the average, you might ignore that 5 % and still deliver a poor experience to them.

## Why the average can be deceptive

1. **Skewed distribution** – A few very slow responses pull the mean up, but most users are fine. The mean tells you nothing about the tail.
2. **User perception** – Users only notice the slowest part of a chain. If 5 % wait 5 s, they will complain.
3. **Regression detection** – A new build might improve the mean but worsen the tail. Relying on the mean alone could hide a regression.

## Calculating p95 in a test script

Below is a quick Python sketch that reads a CSV of response times and prints the p95. It uses the built‑in `statistics` module.

```python
import statistics

# sample data – replace with real results
response_times = [200, 210, 215, 220, 225, 230, 235, 240, 245, 250, 260, 270, 280, 290, 300, 310, 320, 330, 340, 350]

# 95th percentile
p95 = statistics.quantiles(response_times, n=100)[94]
print(f'p95: {p95} ms')
```

This script assumes you have a flat list of numbers. For large data sets, use a streaming algorithm or a dedicated library.

## Checklist: when to use p95

- [ ] You have a performance baseline and want to track regressions.
- [ ] You are measuring user‑centric metrics, not system‑centric.
- [ ] You need to satisfy SLAs that target 95 % of users.
- [ ] Your data set is large enough that the tail is meaningful (at least a few hundred points).

## Decision rule

If the p95 is more than 1.5× the average, stop. That indicates a significant tail. Investigate the slowest 5 % – they may reveal resource bottlenecks, network latency, or code inefficiencies.

## Quick takeaway

Averages look tidy but can blind you to real problems. p95 reveals the worst‑case experience for most users and is a better guardrail for performance optimisation.

## Final thought

Next time you see a report that only shows the mean, ask for the 95th percentile. It will save you from a lot of user complaints later.
