---
title: The load tool you picked by habit can't test gRPC
date: 2026-11-10
summary: Most teams pick a load tool by habit and find its limits mid-project. A fair comparison of k6, JMeter, Gatling, Locust and LoadRunner on the constraints that actually block you: protocol, workload model, language, scale-out cost and result fidelity.
tags: Performance, Load Testing, Tooling
highlight: gRPC
linkedin: |
  Your team picks the load tool it already knows. Six months later the API moves to gRPC, the business wants a test at 1,500 orders per second, and the scripts can't do either.

  Tool choice rarely fails on features you compare in a matrix. It fails on hard constraints you didn't check: the protocol, whether the tool can hold an arrival rate when the system slows down, and what scale-out costs.

  k6, JMeter, Gatling, Locust and LoadRunner are all good tools. Each one has a different hard limit. Locust is a closed model by default. JMeter needs plugins for HTTP/2 and gRPC. Gatling's distributed runs are an Enterprise feature. LoadRunner covers SAP and Citrix but charges per virtual user.

  The article has a comparison table, a decision rule and an interactive picker that ranks the five tools against your needs.

  Which constraint caught your team out after the tool was already chosen?
---
Your team picks the load tool it already knows. Six months later the payments API moves to gRPC, the business asks for a test at 1,500 orders per second, and the release needs 30,000 concurrent users. The scripts can't speak the protocol. The thread groups can't hold a rate once the system slows down. And the quote for that many virtual users is bigger than the test environment budget.

None of that shows up in a feature matrix. It shows up mid-project, when switching costs the most. All five tools here are good, and each has a hard limit. The job is to find yours before you commit.

## Start with the hard constraints

Check these in order. Each can rule a tool out.

1. **Protocol.** Every protocol the system speaks, including gRPC between services, WebSocket and thick clients over Citrix.
2. **Workload model.** In a **closed model**, a fixed number of virtual users each wait for a response before sending the next request. In an **open model**, requests arrive at a set rate whether or not earlier ones have finished. Real users of a public service arrive independently, so they form an open model.
3. **Language.** Who maintains the scripts matters more than who chooses the tool.
4. **Scale-out cost.** Licences, paid cloud tiers, or the effort to distribute a free tool yourself.

## The comparison

| | k6 | JMeter | Gatling | Locust | LoadRunner |
|---|---|---|---|---|---|
| Scripting | JavaScript, TypeScript | GUI test plans (.jmx XML), Groovy via JSR223 | Java, Kotlin, Scala | Python | VuGen, mainly C, also JavaScript and Java |
| HTTP/2 | Built in | Plugin | Built in | Custom client | Built in |
| WebSocket | Built in | Plugin | Built in | Custom client | Built in |
| gRPC | Built in | Plugin | Official plugin | Custom client | Built in (recent versions) |
| Real browser | Built in (browser module) | Plugin (WebDriver Sampler) | No | Plugin (locust-plugins) | Built in (TruClient) |
| SAP GUI, Citrix | No | No | No | No | Built in |
| Open model | Built in (arrival-rate executors) | Built in (Open Model Thread Group, 5.5+) | Built in (`injectOpen`) | No, closed by default | Partial (goal-oriented scenarios) |
| Free distributed runs | Via k6-operator on Kubernetes | Built in (remote engines) | Enterprise only | Built in (master and workers) | Built in, licensed per virtual user |
| Licence | AGPL-3.0 | Apache 2.0 | Apache 2.0 (Enterprise is paid) | MIT | Commercial (OpenText) |

A few rows need context.

**k6** is written in Go and runs your JavaScript in an embedded JS runtime, not Node.js. npm packages that depend on Node APIs won't work. Recent versions run TypeScript directly. Raw TCP, UDP and messaging protocols need **xk6** extensions, which means building a custom k6 binary. The hosted service is now Grafana Cloud k6.

**JMeter** has the TCP sampler built in, but its core HTTP sampler does not speak HTTP/2. You need a plugin such as BlazeMeter's HTTP/2 sampler, and WebSocket and gRPC come from plugins too. Before 5.5, open-model load meant the Concurrency and Arrivals thread groups from the plugins manager. Now the Open Model Thread Group is built in. The code-first tools have recorders (Gatling Recorder, Grafana k6 Studio), but what they produce is code you maintain.

**Gatling** treats open and closed injection as first-class: `injectOpen` with profiles such as `constantUsersPerSec`, or `injectClosed` with a concurrency target. Recent versions also offer a JavaScript and TypeScript SDK. Check the current docs for which protocols it covers. Running one test across several load generators with merged results is a Gatling Enterprise feature.

**Locust** is plain Python, which is its real strength. Anything with a Python client can be load tested by wrapping it in a custom `User` class that fires request events. Out of the box you get HTTP/1.1 through `HttpUser` and the faster `FastHttpUser`. The catch is the model. Users loop with a `wait_time`, so it is closed. `--spawn-rate` (formerly `--hatch-rate`) only controls how fast users start. `constant_throughput` and `constant_pacing` target a rate per user, but when responses slow past the pacing interval, the rate drops with them.

**LoadRunner** (OpenText, formerly Micro Focus) has the widest protocol list of the five, including SAP GUI and Citrix. Licensing is based on virtual users, so cost scales with the size of the test. CI integration works well with the Jenkins and Azure DevOps plugins, but plan for it rather than expecting it out of the box. Goal-oriented scenarios adjust the virtual user count to reach a target hits or transactions per second. That is a feedback loop on a closed model, not true independent arrivals.

Tick your own needs and see how the five rank:

<div class="widget" data-widget="toolpick"><p><em>Interactive tool picker: open this post on pawansinha.com.au to try it.</em></p></div>

## The constraint most comparisons skip

Whichever tool you choose, run user-facing services as an open model. A closed-model tool waits whenever the system stalls, so the requests that would have suffered the most are never sent. That is **coordinated omission**, Gil Tene's term for a load generator unintentionally synchronising with the system it measures. It can turn a 9-second real p99 into a reported 1 ms.

In practice:

- **k6:** `constant-arrival-rate` or `ramping-arrival-rate`, with a `dropped_iterations` threshold of zero. A dropped iteration is coordinated omission in a new form.
- **Gatling:** `injectOpen`, and watch the generator's own CPU. A saturated generator delays sends and hides latency just as badly.
- **JMeter:** the Open Model Thread Group, not a classic Thread Group with a Constant Throughput Timer. Timers still wait for the previous response.
- **Locust:** treat results as closed-model numbers. Size enough users that pacing is never missed, and check that achieved throughput holds steady when latency rises.

Then check how the tool stores latencies. Percentiles need either every sample or a proper histogram such as HdrHistogram. Two traps are common. Averaging p99 across several load generators gives a number that is not a percentile of anything. And some tools round samples into coarse buckets: Locust, for example, rounds response times above 100 ms for its percentile statistics. Fine for most work, but check before arguing about single milliseconds.

## CI fit, briefly

All five run headless. k6 exits non-zero when a threshold fails and writes JSON through `--summary-export` or `handleSummary()`, with `--summary-trend-stats` choosing the percentiles shown. JMeter runs with `-n`, writes a .jtl results file and can build its HTML dashboard with `-e -o`. Gatling assertions fail the build from Maven, Gradle or sbt. For any of them, gate on the percentile and the achieved rate together. A p99 without the throughput it was measured at is not a result.

## My decision rule

- **SAP GUI, Citrix or other enterprise thick-client protocols:** LoadRunner. Budget the licence for your peak user count before you promise a test size.
- **Developers own the tests, HTTP, gRPC or WebSocket, CI gates:** k6. Plan for xk6 if you need raw TCP or a message broker.
- **JVM team, high per-machine efficiency, open-model rigour:** Gatling. Price Enterprise if one machine won't generate enough load.
- **Testers who prefer a GUI, broad plugin ecosystem, free distributed runs:** JMeter. Pin plugin versions in source control, because plugin drift breaks test plans quietly.
- **Python team, unusual protocol, closed workloads such as a fixed pool of workers:** Locust. Don't use it to answer "what latency will users see at 1,500 requests per second?" without proving that the rate held.

Then run a one-day pilot. Script the hardest flow, drive it at target rate on an open model, and keep the generator under about 70% CPU.
