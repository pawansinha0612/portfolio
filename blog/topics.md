# Blog topics

The weekly drafting job takes the first 7 unticked topics from top to bottom and ticks them off.
Add new topics as `- [ ] Title idea — the angle or key point`. Reorder lines to change what comes next.

## Queue

- [ ] Why p95 beats the average response time — averages hide slow users; worked example with numbers
- [ ] Load, stress, spike and soak tests explained — what each one finds, with a one-line rule for when to use it
- [ ] Mocking APIs in Playwright with page.route — test the UI when the backend is slow, broken or not built yet
- [ ] Using AI to write test cases: what works and what doesn't — prompts that help, where human review is essential
- [ ] Millicores vs CPU utilisation in Kubernetes — 1 CPU = 1000m; request vs limit vs node; why one pod can show 80%, 40% and 5%
- [ ] API testing checklist beyond status 200 — schema, negative cases, auth, idempotency, pagination, rate limits
- [ ] Testing on real mobile devices vs emulators — what emulators miss and a practical device-mix strategy
- [ ] Little's Law for testers — sizing virtual users from target throughput and think time
- [ ] Your first k6 test in 15 minutes — script structure, checks vs thresholds, running it in CI
- [ ] Flaky tests: finding the real cause — timing, test data, shared state, environment; fix vs quarantine
- [ ] CPU throttling: low CPU but high latency — how CFS quotas pause pods and the Prometheus query that proves it
- [ ] Open vs closed workload models — why constant-arrival-rate tells the truth when the system slows down
- [ ] Contract testing explained simply — consumer-driven contracts and when they beat end-to-end tests
- [ ] What an LLM does with your prompt — tokens, embeddings, prediction, sampling; why it matters for testing AI features
- [ ] Soak tests catch what load tests miss — connection leaks, memory growth, and watching trends not snapshots
- [ ] Testing AI features in your product — non-deterministic output, evaluation sets, guardrails, cost and latency
- [ ] Correlation in load test scripts — capturing tokens and IDs in LoadRunner, JMeter and k6 side by side
- [ ] Core Web Vitals for QA engineers — LCP, INP, CLS; what they measure and how to test them
- [ ] Mobile app performance basics — startup time, frame drops, memory, battery and network conditions
- [ ] Database connection pools: why bigger isn't better — pool sizing, pods × pool vs max_connections
- [ ] Reading a heap dump without panic — two dumps, dominator tree, path to GC roots
- [ ] Shift-left performance testing in CI — a 5-minute sanity load test on every merge with thresholds as gates
- [ ] Exploratory testing that finds real bugs — charters, heuristics and time boxes
- [ ] Testing REST APIs with Playwright's request context — fast API checks alongside UI tests
- [ ] On-premises to cloud migration: the performance plan — baseline first, same workload after, new network hops
- [ ] Garbage collection pauses and tail latency — why p99 spikes while the average looks fine
- [ ] Test data management that scales — unique data per user, offsets for parallel runs, consumable data
- [ ] Accessibility testing quick wins — keyboard, labels, contrast, screen reader checks in 20 minutes
- [ ] Using AI coding assistants for test automation — speeding up Playwright and k6 scripting safely
- [ ] The N+1 query problem under load — how it hides at low traffic and how APM traces expose it
- [ ] Monitoring for testers: RED and USE methods — rate, errors, duration; utilisation, saturation, errors
- [ ] Appium vs native frameworks (Espresso, XCUITest) — trade-offs for mobile automation
- [ ] Writing a performance test report people read — one page, decisions first, evidence linked
- [ ] Reading an Oracle AWR report for a load test — DB time, top events, SQL by elapsed and executions
- [ ] Kafka performance testing: watch consumer lag — why a fast API can hide a backlog
- [ ] Risk-based testing when time is short — what to test first and how to explain what you skipped
- [ ] Serverless performance testing — cold starts, concurrency limits and downstream connections
- [ ] Bug reports developers love — repro steps, evidence, impact and one bug per report
- [ ] Choosing a load testing tool: k6, JMeter, Gatling or LoadRunner — decision table by team and protocol
- [ ] Prompt patterns for QA engineers — generating test ideas, data and edge cases with AI, and checking the output
- [ ] Auto-scaling isn't free capacity — testing scale-out time, scale-in and shared limits
- [ ] Interview prep: explaining a bottleneck you found — the STAR structure with a performance example
