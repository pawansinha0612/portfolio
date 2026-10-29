# Blog topics

The weekly drafting job takes the first 7 unticked topics from top to bottom and ticks them off.
Add new topics as `- [ ] Title idea — the angle or key point`. Reorder lines to change what comes next.
Lines under "Parked" use a plain `- ` so the job skips them; change one to `- [ ]` and move it up to queue it.

## Queue

- [x] Why p95 beats the average response time — averages hide slow users; worked example with numbers
- [x] Load, stress, spike and soak tests explained — what each one finds, with a one-line rule for when to use it
- [x] Mocking APIs in Playwright with page.route — test the UI when the backend is slow, broken or not built yet
- [x] Using AI to write test cases: what works and what doesn't — prompts that help, where human review is essential
- [x] Millicores vs CPU utilisation in Kubernetes — 1 CPU = 1000m; request vs limit vs node; why one pod can show 80%, 40% and 5%
- [x] API testing checklist beyond status 200 — schema, negative cases, auth, idempotency, pagination, rate limits
- [x] Testing on real mobile devices vs emulators — what emulators miss and a practical device-mix strategy
- [ ] Coordinated omission: why your load tool under-reports tail latency — closed-loop generators stall with the system; HdrHistogram correction, open-model arrival rates (k6 constant-arrival-rate, wrk2)
- [ ] The Universal Scalability Law in practice — contention (sigma) and coherency (kappa); fitting USL to throughput-vs-concurrency data to predict the peak and retrograde scaling
- [ ] Queueing theory for capacity planning — utilisation vs response time, R = S / (1 - U) for M/M/1, why the knee arrives before 100%, Kingman's formula and the cost of variability
- [ ] The tail at scale: fan-out amplifies p99 — probability a request hits at least one slow backend is 1 - 0.99^N; hedged and tied requests, latency budgets per hop
- [ ] You can't average percentiles — why averaging p99 across pods or time windows is wrong; mergeable histograms, Prometheus histogram_quantile bucket error, native histograms
- [ ] Little's Law beyond virtual users — L = λW for sizing thread pools, connection pools and in-flight limits; checking a load test's internal consistency with it
- [ ] Off-CPU analysis: where wall-clock time really goes — on-CPU vs off-CPU flame graphs, async-profiler wall mode, eBPF offcputime, locks and I/O waits that CPU profiles never show
- [ ] Safepoint bias: why some JVM profilers lie — safepoint-biased sampling vs AsyncGetCallTrace (async-profiler) and JFR; reading a flame graph correctly
- [ ] GC tuning for tail latency: G1 vs ZGC vs Shenandoah — allocation rate, pause-time goals, generational ZGC (JDK 21), reading unified GC logs (-Xlog:gc*)
- [ ] CFS throttling deep dive — cpu.cfs_quota_us / cfs_period_us (cpu.max in cgroup v2), how multi-threaded runtimes burn the quota early, nr_throttled and container_cpu_cfs_throttled_periods_total
- [ ] Container memory: RSS, working set, page cache and the OOM killer — why container_memory_usage_bytes misleads, working_set_bytes, native vs heap memory in the JVM
- [ ] The Linux 60-second performance checklist under load — uptime, vmstat, mpstat, pidstat, iostat, free, sar -n DEV/TCP; what each column tells you mid-test
- [ ] eBPF for performance engineers — bpftrace and BCC tools: runqlat, biolatency, tcpretrans, execsnoop; finding scheduler and disk latency without code changes
- [ ] TCP and socket limits that break load tests — accept queue overflow (somaxconn, ListenOverflows), SYN backlog, TIME_WAIT and ephemeral port exhaustion on load generators
- [ ] Backpressure and adaptive concurrency limits — bounded queues, load shedding, AIMD and gradient-based limiters, CoDel-style queue management
- [ ] Retry storms and metastable failures — why a system stays down after the trigger is gone; exponential backoff with jitter, retry budgets, circuit breakers
- [ ] Statistically sound performance comparisons — run-to-run noise, confidence intervals, Mann-Whitney U, A/A tests; when "5% faster" is just noise
- [ ] Microbenchmarking with JMH without fooling yourself — warm-up and JIT tiers, dead-code elimination, constant folding, Blackhole, forks
- [ ] Workload modelling from production data — arrival rates vs concurrency, transaction mix, peak-hour factor, Poisson vs bursty arrivals, think-time distributions
- [ ] Performance regression detection in CI — noisy runners, change-point detection instead of fixed thresholds, comparing distributions not single runs
- [ ] Database connection pool sizing with queueing theory — pods × pool size vs max_connections, pool wait time as the real signal, why bigger pools raise latency
- [ ] PostgreSQL under load: reading wait events — pg_stat_activity wait_event_type, lock vs LWLock vs IO waits, pg_stat_statements for top SQL by total time
- [ ] Reading an Oracle AWR report for a load test — DB time vs DB CPU, top timed foreground events, SQL ordered by elapsed time vs executions
- [ ] Kafka consumer lag as a queue — offset lag vs time lag, Little's Law on lag, partition skew, rebalances and max.poll.interval.ms under load
- [ ] Kubernetes HPA control-loop dynamics — sync period, stabilisation windows, scale-out lag vs traffic ramp rate; designing ramp profiles that expose it
- [ ] Distributed tracing for bottleneck analysis — critical path vs span duration, self time, head vs tail sampling trade-offs for performance work
- [ ] Latency SLOs and burn-rate alerting — latency SLIs as a ratio of good events, error budgets, multi-window multi-burn-rate alerts
- [ ] Cache stampedes and the thundering herd — hit ratio vs latency, request coalescing, probabilistic early expiration, cold-cache load tests
- [ ] Event-loop and thread-pool saturation — Node.js event-loop lag, blocking calls on async runtimes, Java virtual threads and pinning (JDK 21)
- [ ] Mechanical sympathy: CPU caches, false sharing and NUMA — why memory layout changes latency; perf stat counters (cache-misses, IPC)
- [ ] Amdahl's Law vs Gustafson's Law — the serial fraction limits speed-up; what it means for horizontal scaling and parallel test execution
- [ ] HTTP/2 and HTTP/3 in load tests — multiplexing, head-of-line blocking at TCP vs QUIC, connection reuse and why client config changes your results
- [ ] Serverless cold starts in depth — init phase, provisioned concurrency, SnapStart, concurrency limits and downstream connection exhaustion

## Parked

- Your first k6 test in 15 minutes — script structure, checks vs thresholds, running it in CI
- Flaky tests: finding the real cause — timing, test data, shared state, environment; fix vs quarantine
- Contract testing explained simply — consumer-driven contracts and when they beat end-to-end tests
- What an LLM does with your prompt — tokens, embeddings, prediction, sampling; why it matters for testing AI features
- Testing AI features in your product — non-deterministic output, evaluation sets, guardrails, cost and latency
- Correlation in load test scripts — capturing tokens and IDs in LoadRunner, JMeter and k6 side by side
- Core Web Vitals for QA engineers — LCP, INP, CLS; what they measure and how to test them
- Mobile app performance basics — startup time, frame drops, memory, battery and network conditions
- Exploratory testing that finds real bugs — charters, heuristics and time boxes
- Testing REST APIs with Playwright's request context — fast API checks alongside UI tests
- On-premises to cloud migration: the performance plan — baseline first, same workload after, new network hops
- Test data management that scales — unique data per user, offsets for parallel runs, consumable data
- Accessibility testing quick wins — keyboard, labels, contrast, screen reader checks in 20 minutes
- Using AI coding assistants for test automation — speeding up Playwright and k6 scripting safely
- Appium vs native frameworks (Espresso, XCUITest) — trade-offs for mobile automation
- Writing a performance test report people read — one page, decisions first, evidence linked
- Risk-based testing when time is short — what to test first and how to explain what you skipped
- Bug reports developers love — repro steps, evidence, impact and one bug per report
- Choosing a load testing tool: k6, JMeter, Gatling or LoadRunner — decision table by team and protocol
- Prompt patterns for QA engineers — generating test ideas, data and edge cases with AI, and checking the output
- Interview prep: explaining a bottleneck you found — the STAR structure with a performance example
