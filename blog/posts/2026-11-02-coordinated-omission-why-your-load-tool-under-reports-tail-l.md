---
title: Coordinated omission: why your load tool under‑reports tail latency
date: 2026-11-02
summary: Closed‑loop generators stall, hiding true tail latency. Use open‑loop rates and HdrHistogram corrections to surface the real performance profile.
tags: Performance, LoadTesting, HdrHistogram
linkedin: |
  In load testing, the tail latency you see is often lower than what real users experience. The culprit? Coordinated omission in closed‑loop generators. A quick fix: switch to an open‑loop executor like k6’s constant‑arrival‑rate or wrk2’s `-R` flag, and record start‑and‑end timestamps for each request. The result is a histogram that truly reflects the worst‑case delays. Have you ever noticed a sudden drop in tail latency after switching to open‑loop? What other tactics do you use to surface hidden latency?
---
## Closed‑loop generators stall the system
A closed‑loop generator sends a request and waits for the response before dispatching the next one. The generator’s pacing is therefore *coordinated* with the service’s response time. If the service is slow, the generator backs up; if the service is fast, the generator speeds up. This coupling masks the worst‑case delays that a real user would experience.

When a request is delayed by the backend, the generator is idle for that period. The idle time is not accounted for in the measured latency, because the generator never started the next request until the previous one returned. The result is a systematic under‑reporting of the tail of the latency distribution.

### Example
Assume a load generator sends 100 req/s in a closed‑loop fashion. The service normally returns in 200 ms, but a cache miss causes a 1 s delay on one request. The generator will pause for 1 s, then resume. The measured latency for that request will be 1 s, but the next 800 ms of simulated traffic is missing from the sample. The tail percentile (e.g. 99.9th) will be lower than the real tail that a user would see.

## Open‑loop arrival rates expose the real tail
Open‑loop generators, such as k6’s `constant-arrival-rate` (CAR) executor or wrk2’s `-R` flag, send requests at a fixed rate regardless of the response time. The generator does not wait; it keeps the pipeline full. The number of in‑flight requests grows until the system saturates, and the measured latency reflects the true backlog.

### k6 example
```js
import http from 'k6/http';
import { sleep } from 'k6';

export const options = {
  stages: [{ duration: '30s', target: 100 }],
  thresholds: {
    http_req_duration: ['p(99.9)>=2000'], // 99.9th percentile
  },
  // Open‑loop mode
  ext: {
    loadimpact: {
      distribution: { 'Europe': 1 },
    },
  },
};

export default function () {
  http.get('https://example.com/api');
  sleep(0.1);
}
```
The `constant-arrival-rate` executor keeps the request rate at 100 req/s even if the backend is slow.

### wrk2 example
```bash
wrk2 -t4 -c200 -d30s -R1000 -s script.lua http://example.com/api
```
The `-R1000` flag forces 1000 req/s regardless of the response time.

## Coordinated omission and HdrHistogram
HdrHistogram records latency values in a histogram that can be merged across threads. The key to correcting coordinated omission is to record *both* the request start time and the response end time, then compute the latency as `end - start`. The histogram should be populated with the *actual* latency, not the elapsed time that includes generator stalling.

### How HdrHistogram works
* **Histogram**: A data structure that stores counts of latency buckets. Each bucket covers a range of values and is stored as a power‑of‑two scaling.
* **Merging**: When multiple threads produce histograms, they can be merged by summing bucket counts. This preserves the overall distribution.

### Detecting coordinated omission
1. **Plot request count vs. elapsed time**: In a closed‑loop test, the request count will plateau when the system is saturated. In an open‑loop test, the count will continue to rise until the generator reaches its limit.
2. **Compare start‑to‑start and start‑to‑end intervals**: If the start‑to‑start interval is consistently longer than the service’s mean response time, the generator is stalling.
3. **Check the 95th/99th percentile vs. mean**: A large gap indicates tail latency. If the tail is lower than expected, coordinated omission may be present.

### Fixing the histogram
When using a closed‑loop generator, you can still recover the true tail by recording timestamps inside the request callback and feeding them to HdrHistogram:
```go
// Go example using k6's custom metrics
import (
    "github.com/k6io/k6/metrics"
    "github.com/HdrHistogram/hdrhistogram-go"
)

var latencyHist = hdrhistogram.New(1, 10000000, 3) // 1µs to 10s, 3 significant figures

export func httpRequest() {
    start := time.Now()
    resp, err := http.Get("https://example.com/api")
    end := time.Now()
    if err == nil {
        latency := end.Sub(start).Microseconds()
        latencyHist.RecordValue(latency)
        resp.Body.Close()
    }
}
```
The histogram now contains the real latency, independent of generator stalling.

## Practical checklist
| Step | What to check | Why it matters |
|------|---------------|---------------|
| 1 | Use an open‑loop executor (e.g. k6 CAR, wrk2 `-R`) | Avoids coordinated omission |
| 2 | Record request start and end timestamps | Enables accurate latency calculation |
| 3 | Merge histograms across threads | Provides a global view of latency |
| 4 | Plot request count vs. elapsed time | Detects generator stalling |
| 5 | Compare 99.9th percentile to mean latency | Spot tail inflation |
| 6 | Run a closed‑loop test as a sanity check | Confirms that the system can handle the load |

## When to use closed‑loop generators
Closed‑loop generators are still useful when you want to measure system behaviour under *self‑paced* load, such as when modelling a user that waits for a response before issuing the next request. Use them only for throughput or CPU utilisation studies, not for tail latency.

## Summary
Coordinated omission is the silent killer of tail latency measurements. Closed‑loop generators stall when the system is slow, hiding the worst‑case delays. Open‑loop arrival rates, coupled with precise timestamped histograms, surface the true distribution. By following the checklist above, senior engineers can ensure that their load tests reveal the real performance profile rather than a smoothed, optimistic view.
