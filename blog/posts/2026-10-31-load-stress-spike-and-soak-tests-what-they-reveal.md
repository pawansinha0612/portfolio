---
title: Load, Stress, Spike and Soak Tests: What They Reveal
date: 2026-10-31
summary: Learn the purpose of load, stress, spike and soak tests, and a quick rule for when to use each. Apply these checks to keep your services stable.
tags: Testing, Performance, LoadTesting
linkedin: |
  Today I wanted to cut through the jargon around performance testing. The simple rule: pick the test that matches the risk you care about – normal load, extreme limits, sudden bursts, or long‑term endurance. For example, a banking app under 10 000 concurrent users is a load test; a flash sale on an e‑commerce site is a spike test. Which type of test do you run first in your projects?
---
## Quick Takeaway
I test four main types of performance tests. Each one finds a different flaw and I use a one‑line rule to decide which to run.

## Load Testing
A load test simulates a normal, expected number of users or transactions over a period of time. It answers the question: *Will the system handle the anticipated traffic without crashing?*

**Rule of thumb:** Run a load test when you need to verify that the system meets the agreed‑upon performance targets for a typical user load.

Example: A banking app expects 10 000 concurrent users during peak hours. I run a load test with 10 000 virtual users for 30 minutes to confirm response times stay below the target of 2 seconds.

## Stress Testing
Stress testing pushes the system beyond its normal operational capacity until it fails. It shows where the breaking point is, how the system recovers, and whether it fails gracefully.

**Rule of thumb:** Use a stress test when you want to discover the upper limits of your infrastructure and the behaviour under extreme load.

Example: I ramp up the previous banking app to 25 000 users until the API rate‑limits kick in or latency spikes beyond 5 seconds, then analyse the failure points.

## Spike Testing
A spike test injects a sudden, short‑lived surge in traffic. It checks if the system can handle abrupt spikes without a crash.

**Rule of thumb:** Perform a spike test when your service is likely to receive unexpected traffic bursts, such as a flash sale or a news event.

Example: A gaming platform might see a 50 % jump in concurrent users for 2 minutes during a live event. I simulate that spike to see if the servers hold up.

## Soak Testing
Also called endurance testing, a soak test runs the system under a moderate load for an extended period (hours or days). It looks for memory leaks, resource exhaustion, or performance drift.

**Rule of thumb:** Use a soak test when you need to confirm long‑term stability under sustained usage.

Example: I keep the banking app at 5 000 users for 48 hours to watch for memory growth or slow‑down.

## Quick Comparison Table
| Test Type | Typical Scenario | What It Finds | Rule of Thumb |
|-----------|------------------|---------------|---------------|
| Load | Expected peak traffic | Meets performance targets | Verify normal load performance |
| Stress | Unknown limits | Upper limit, failure mode | Discover breaking points |
| Spike | Sudden traffic surge | Graceful handling of bursts | Test for abrupt spikes |
| Soak | Long‑term operations | Memory leaks, resource drift | Confirm endurance |

## Simple k6 Script
Below is a minimal k6 script that you can tweak for a load test. It runs 10 000 virtual users for 30 minutes.
```javascript
import http from 'k6/http';
import { sleep } from 'k6';
export let options = {
  stages: [
    { duration: '5m', target: 10000 }, // ramp up
    { duration: '20m', target: 10000 }, // steady state
    { duration: '5m', target: 0 }      // ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<2000'] // 95% under 2s
  }
};

export default function () {
  http.get('https://example.com/api');
  sleep(1);
}
```
Adjust the `stages` and `thresholds` to match your target load and performance goals.

## Checklist for Choosing the Right Test
- [ ] Do you need to confirm that everyday traffic works? → Load test.
- [ ] Do you need to know the system’s limit or how it fails? → Stress test.
- [ ] Will traffic ever spike suddenly? → Spike test.
- [ ] Do you care about long‑term stability? → Soak test.

## Putting It All Together
In practice, I run a small load test first. If it passes, I add a spike test to mimic real‑world bursts. If the system behaves correctly, I run a soak test to ensure no leaks appear over time. Only if a problem surfaces do I push to a stress test to see how far the system can go.

By following these one‑line rules, you can pick the right test quickly and keep your services reliable without over‑engineering your test plan.
