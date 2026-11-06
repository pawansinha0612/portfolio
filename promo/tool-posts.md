# LinkedIn tool spotlight posts

One post per free tool, shared from your LinkedIn profile by the "Tool spotlight" workflow (Tuesdays and Thursdays
around 12:30pm Melbourne), oldest unposted first. Shared posts are recorded in promo/posted.json, so each goes out once.

Edit freely on github.com:
- Change the order by moving sections. Pause one by adding `skip: yes` under its heading.
- Each section: `## id`, then `url:`, optional `label:` (image badge), `title:` (card title, also the image text), `highlight:` (word(s) coloured in
  the image), `description:` (card text), a blank line, then the post text. #hashtags stay clickable.
- Images are made by promo/share.py into docs/promo/<id>.png (python3 promo/share.py --images).

## site-check
url: https://pawansinha.com.au/site-check/
label: Free check · about a minute
title: Is your shop ready for Black Friday?
highlight: Black Friday
description: Free speed check for online shops: what slows the site on phones, what to fix first, and what only a load test can tell you.

Black Friday is 27 November. Most online shops find out how fast their site is on the busiest day of the year.

I built a free check that tells you before then.

Enter your shop's address and you get a plain-English report for phones:
→ what is slowing your pages down
→ which fixes matter most, in order
→ what a speed test can't tell you, and only a load test can

No sign-up needed to run it. It takes about a minute.

Try it on your own shop (or your client's) and tell me what it found:
https://pawansinha.com.au/site-check/

#BlackFriday #Ecommerce #WebPerformance

## jtl-analyser
url: https://pawansinha.com.au/tools/jtl-analyser/
title: JMeter results analyser
highlight: analyser
description: Drop in a .jtl file (even 2 million rows) and get exact p95/p99, errors, throughput and charts per transaction. Nothing is uploaded.

Your JMeter test finished. Now you have a 2 GB .jtl file and a report that takes ten minutes to generate.

I built a free analyser that reads it in seconds, right in your browser:
→ exact p50, p90, p95 and p99 per transaction (not averaged averages)
→ errors grouped by response code and message
→ response time, throughput, errors and threads over time
→ copy the summary as Markdown straight into your ticket

A 2-million-row file takes about 2 seconds. Nothing is uploaded, which matters when your results contain internal URLs.

Try it on your last test run and tell me what it's missing:
https://pawansinha.com.au/tools/jtl-analyser/

#JMeter #PerformanceTesting #LoadTesting

## workload-model
url: https://pawansinha.com.au/tools/workload-model/
title: Access logs to workload model
highlight: workload model
description: Drop nginx, ALB, CloudFront or IIS logs and get peak RPS, the transaction mix, a Little's law user count and a ready k6 script.

"How many users should we test with?"

Most load tests start with a guess. Your access logs already have the answer.

I built a free tool that turns them into a workload model:
→ peak hour, busiest minute and peak requests per second
→ the transaction mix at peak, with response times and errors
→ virtual users from Little's law, with your growth factor
→ a ready-to-run k6 script, plus a weights file for JMeter

Works with nginx, Apache, AWS ALB, CloudFront and IIS logs, even large .gz files. It all runs in your browser: your logs never leave your computer.

Drop in your busiest day and see what your real peak looks like:
https://pawansinha.com.au/tools/workload-model/

#PerformanceTesting #LoadTesting #k6

## thread-dump
url: https://pawansinha.com.au/tools/thread-dump/
title: Java thread dump analyser
highlight: thread dump
description: Paste jstack dumps to find deadlocks, hot locks, exhausted connection pools and threads stuck across dumps. Runs in your browser.

The app is slow under load. CPU is fine. Memory is fine. So what are the threads doing?

A thread dump tells you, if you can read 2,000 stack traces quickly.

I built a free analyser that does it for you:
→ groups identical stacks, so 180 threads waiting on the same JDBC call jump out
→ shows which locks are contended and who holds them
→ finds deadlocks
→ flags exhausted connection pools (Hikari, Tomcat, DBCP and others)
→ paste 3 dumps taken seconds apart and it shows which threads are stuck

Runs in your browser. Nothing is uploaded.

Next time something hangs, take three dumps and paste them in:
https://pawansinha.com.au/tools/thread-dump/

#Java #PerformanceEngineering #JVM

## jmeter-to-k6
url: https://pawansinha.com.au/tools/jmeter-to-k6/
title: JMeter to k6 converter
highlight: k6
description: Upload a .jmx test plan and get a k6 script: thread groups, requests, CSV data, extractors, assertions and controllers.

Thinking about moving from JMeter to k6, but not about rewriting 200 test plans by hand?

I built a free converter for that.

Upload a .jmx file and get a k6 script with:
→ thread groups as k6 scenarios
→ CSV data, extractors and assertions carried over
→ If, Loop, Transaction and Module controllers handled
→ notes on anything that needs a human look

It runs in your browser, so your test plans stay on your computer.

Try it on your gnarliest test plan and tell me where it breaks:
https://pawansinha.com.au/tools/jmeter-to-k6/

#JMeter #k6 #PerformanceTesting

## compare-runs
url: https://pawansinha.com.au/tools/compare-runs/
title: Did this release get slower?
highlight: slower
description: Baseline vs candidate for JMeter or k6: which transactions regressed on p95, p99, errors or throughput, ready to paste into your PR.

"Is this release slower than the last one?"

Usually answered by two people squinting at two reports.

I built a free tool that compares two test runs:
→ per transaction: p95, p99, average, errors and throughput, old vs new
→ regressions in red, improvements in green, with thresholds you set
→ a one-line verdict: "2 regressions, 1 improvement, 14 unchanged"
→ copy it as Markdown into your pull request

Works with JMeter results and k6 summaries. Runs in your browser.

Try it on your last two runs:
https://pawansinha.com.au/tools/compare-runs/

#PerformanceTesting #k6 #JMeter

## gc-log
url: https://pawansinha.com.au/tools/gc-log/
title: JVM GC log analyser
highlight: GC log
description: Drop a gc.log for pause percentiles, throughput, Full GC causes, heap trends and leak hints in plain English.

p99 spikes every few minutes during your load test. Is it the garbage collector?

Your GC log knows. I built a free analyser that reads it:
→ pause count, total pause time, p95, p99 and max pause
→ every Full GC and its cause (Metaspace, System.gc(), and the rest)
→ heap after each GC over time, so a leak shows as a line that keeps climbing
→ plain-English findings, with what to check next

Supports G1, ZGC, Shenandoah, Parallel and Serial logs from JDK 9 onwards (JDK 8 best effort). Runs in your browser.

Turn on GC logging for your next test and drop the file in:
https://pawansinha.com.au/tools/gc-log/

#Java #JVM #PerformanceEngineering

## capacity-calculator
url: https://pawansinha.com.au/tools/capacity-calculator/
title: Load test capacity calculator
highlight: capacity
description: From orders per day to peak requests per second, cores, pods and database connections, then the virtual users and k6 scenario to prove it.

"We expect 50,000 orders on Black Friday." Great. How many requests per second is that? How many pods? How many database connections?

I built a free calculator that walks from the business number to the infrastructure:
→ orders per day to peak requests per second
→ cores, pods and database connections needed
→ the virtual users and k6 scenario to prove it in a test

Useful in the meeting where someone asks "will it hold?".

Plug in your own peak and see where the numbers land:
https://pawansinha.com.au/tools/capacity-calculator/

#CapacityPlanning #PerformanceTesting #SRE

## k6-results
url: https://pawansinha.com.au/tools/k6-results/
title: What do my k6 results mean?
highlight: k6 results
description: Paste your k6 summary or JSON and get a plain-English verdict: what passed, what's slow and what to look at next.

k6 prints a wall of numbers at the end of every test. Which ones matter?

I built a free explainer: paste your k6 summary (text or JSON) and get
→ a plain-English verdict
→ what passed, what failed and what's slow
→ what to look at next

Handy for sharing results with people who don't read p95s for a living.

Paste your last k6 run and see what it says:
https://pawansinha.com.au/tools/k6-results/

#k6 #PerformanceTesting #LoadTesting

## slo-calculator
url: https://pawansinha.com.au/tools/slo-calculator/
title: SLO and error budget calculator
highlight: error budget
description: Turn 99.9% into minutes of downtime and failed requests, check your burn rate, and copy k6 thresholds and Prometheus alerts.

"99.9% availability" sounds strict. It's 43 minutes of downtime a month.

I built a free SLO calculator that turns the percentage into something you can act on:
→ minutes of downtime and failed requests per month
→ how fast you're burning the error budget
→ k6 thresholds to test against it
→ Prometheus burn-rate alerts to copy

Put in your team's SLO and see what it really allows:
https://pawansinha.com.au/tools/slo-calculator/

#SRE #SLO #PerformanceTesting

## postman-to-k6
url: https://pawansinha.com.au/tools/postman-to-k6/
title: Postman to k6 converter
highlight: k6
description: Upload a Postman collection and get a k6 load test: folders become groups, variables and auth carry over, and tests become checks.

Your API tests already live in Postman. Your load test doesn't have to start from zero.

I built a free converter: upload a Postman collection and get a k6 load test where
→ folders become groups
→ variables and auth carry over
→ your Postman tests become k6 checks

Runs in your browser, so the collection stays on your computer.

Try it on a collection you already have:
https://pawansinha.com.au/tools/postman-to-k6/

#Postman #k6 #APITesting

## openapi-to-k6
url: https://pawansinha.com.au/tools/openapi-to-k6/
title: OpenAPI to k6 converter
highlight: k6
description: Paste an OpenAPI or Swagger file, pick the endpoints, and get a k6 script with example data, auth from environment variables and checks.

If your API has an OpenAPI spec, you already have most of a load test.

I built a free converter: paste or upload an OpenAPI or Swagger file (JSON or YAML), pick the endpoints, and get a k6 script with
→ example request data from the spec
→ auth read from environment variables
→ status checks on every request

Try it on your API's spec:
https://pawansinha.com.au/tools/openapi-to-k6/

#OpenAPI #k6 #APITesting

## llm-load-test
url: https://pawansinha.com.au/tools/llm-load-test/
title: Load testing your AI feature
highlight: AI feature
description: A k6 script for your chatbot, RAG or agent API that measures time to first token, tokens per second, 429s and cost.

Your AI feature will hit the provider's token limit before it hits the request limit.

Load testing a chatbot isn't like load testing a REST API. What matters is time to first token, tokens per second, rate-limit errors and cost.

I built a free generator that writes the k6 test for you:
→ OpenAI-compatible, Azure, Anthropic or your own API
→ measures time to first token, tokens per second and 429s
→ adds a cost estimate for the run to the end-of-test summary, from your prices per million tokens

Build the test for your AI feature here:
https://pawansinha.com.au/tools/llm-load-test/

#AI #LLM #LoadTesting

## llm-capacity
url: https://pawansinha.com.au/tools/llm-capacity/
title: LLM capacity and cost calculator
highlight: capacity
description: From users and token sizes to peak requests and tokens per minute, headroom against your rate limits, and the monthly bill.

How many users can your AI feature take before the provider starts returning 429s?

I built a free calculator that works it out:
→ users and token sizes to peak requests and tokens per minute
→ headroom against your RPM and TPM limits
→ answers in flight at peak
→ the monthly bill, with your own prices

Check your numbers before launch day:
https://pawansinha.com.au/tools/llm-capacity/

#AI #LLM #CapacityPlanning

## curl-to-k6
url: https://pawansinha.com.au/tools/curl-to-k6/
title: curl to k6 in one paste
highlight: k6
description: Paste "Copy as cURL" from your browser and get a ready-to-run k6 script with checks, thresholds and a realistic load model.

The fastest way to start a load test: open your browser's dev tools, right-click a request, "Copy as cURL".

Then paste it into my free converter and get a k6 script with
→ the request, headers and body
→ checks and thresholds
→ a realistic load model, not just 10 virtual users looping

Try it on the slowest request in your app:
https://pawansinha.com.au/tools/curl-to-k6/

#k6 #PerformanceTesting #DevTools

## tool-picker
url: https://pawansinha.com.au/compare/tool-picker/
label: Free tool · six questions
title: Which load testing tool should you use?
highlight: load testing tool
description: Six questions about your team and system, then a recommended tool and runner-up with the reasons.

k6, JMeter, Gatling, Locust, LoadRunner, NeoLoad, Artillery. Which one fits your team?

It depends on your team's language, your protocols, your budget and what you already know. So I built a free tool picker:
→ answer six questions
→ get a recommended tool and a runner-up
→ with the reasons, and links to guides for both

Take it for your current project and tell me if you agree with the answer:
https://pawansinha.com.au/compare/tool-picker/

#PerformanceTesting #LoadTesting #TestAutomation

## guides
url: https://pawansinha.com.au/guides/
label: Free guides
title: Free performance testing guides
highlight: guides
description: Step-by-step guides for JMeter, k6, Gatling, Locust, LoadRunner and NeoLoad, finding bottlenecks, monitoring, cheat sheets and templates.

Every performance tester has 40 browser tabs open: tool docs, Stack Overflow, an old blog post, a YouTube video.

I've put the answers in one place, free:
→ JMeter, k6, Gatling, Locust, LoadRunner and NeoLoad how-tos
→ correlation, test data, login tokens, CI pipelines
→ finding bottlenecks on Linux, the JVM and databases
→ a ready-to-run Grafana stack for watching tests
→ printable cheat sheets and free test templates

Bookmark it, and tell me which guide you'd want next:
https://pawansinha.com.au/guides/

#PerformanceTesting #LoadTesting #QA

## practice
url: https://pawansinha.com.au/guides/practice/
label: Free hands-on exercises
title: Learn load testing by doing it
highlight: by doing it
description: Guided hands-on exercises from your first test to finding a bottleneck, against a safe practice app you run yourself.

You can't learn load testing from reading about it. You need something safe to break.

I've put together free hands-on exercises, from your first test to finding a real bottleneck:
→ run a small practice app on your own laptop, so you're never load testing someone else's site
→ each exercise has a goal, a script, what you should see, and the answer
→ track down a hidden slowdown yourself, the way you would on a real project

Work through the first exercise this week and tell me how far you got:
https://pawansinha.com.au/guides/practice/

#PerformanceTesting #k6 #LearnToCode
