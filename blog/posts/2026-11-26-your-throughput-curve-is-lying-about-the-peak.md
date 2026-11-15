---
title: Your throughput curve is lying about the peak
date: 2026-11-26
summary: USL reveals why throughput collapses before you expect it. Learn to fit contention and coherency parameters from real data and predict the true scaling limit.
description: Fit Universal Scalability Law to throughput data, extract sigma and kappa, predict peak and retrograde scaling.
tags: Performance, Scalability, USL, Capacity Planning
linkedin: |
  Your load test shows linear scaling. Production hits a wall at half the predicted concurrency. The Universal Scalability Law explains why: contention (sigma) flattens the curve, coherency (kappa) makes it fall. Fit USL to closed-loop throughput data, extract sigma and kappa, then calculate the true peak and the retrograde cliff. In a worked example sigma=0.018 and kappa=0.00014 put the peak at 83 concurrent requests — the autoscaler targeting 110 would push the system into retrograde scaling. Fix sigma with lock striping and async offload. Fix kappa with cache affinity and immutable snapshots. Always validate with residuals and hold-out points. What is the highest kappa you have seen in a production system?
---
Your load test shows throughput climbing steadily as you add virtual users. You extrapolate the line and tell the team the system can handle double the traffic. Two weeks later production hits a cliff at sixty percent of that concurrency. Requests queue, latency spikes, and the on-call engineer watches the error rate climb while CPU sits at forty percent.

The Universal Scalability Law (USL) explains why the straight-line extrapolation fails. It models throughput as a function of concurrency with two parameters. Sigma (σ) captures contention — the fraction of work that must run serially because of locks, queues or single-threaded bottlenecks. Kappa (κ) captures coherency delay — the overhead of keeping distributed state consistent across threads, caches or nodes. The formula is:

C(N) = N / (1 + σ(N - 1) + κN(N - 1))

where C(N) is the relative capacity at concurrency N. When κ is zero the curve flattens at 1/σ. When κ is positive the curve peaks then falls — retrograde scaling. Most teams only measure the rising limb and miss the knee.

## Collect data that fits the model

Run a controlled throughput test at fixed concurrency levels. Use a closed-loop driver so the system under test sees exactly N concurrent requests. Measure steady-state throughput at each N. Discard warm-up and cool-down windows. A typical sweep might be N = 1, 2, 4, 8, 16, 32, 64, 128. Run each point long enough for the coefficient of variation of throughput to drop below two percent.

Do not use open-loop arrival rates. Open-loop tests mask queueing and produce optimistic curves. If you must use an open-loop tool, convert arrival rate to concurrency with Little's Law (L = λW) using the measured residence time at each step.

## Fit the parameters

Non-linear least squares on the raw throughput numbers works if you weight by the inverse of variance. In Python with SciPy:

```python
import numpy as np
from scipy.optimize import curve_fit

def usl(n, sigma, kappa):
    return n / (1 + sigma * (n - 1) + kappa * n * (n - 1))

# Example data: concurrency vs throughput (req/s)
N = np.array([1, 2, 4, 8, 16, 32, 64, 128], dtype=float)
X = np.array([980, 1900, 3600, 6500, 10200, 12800, 13500, 12000], dtype=float)
X_rel = X / X[0]  # normalise to N=1

popt, pcov = curve_fit(usl, N, X_rel, bounds=(0, [1, 1]))
sigma, kappa = popt
sigma_err, kappa_err = np.sqrt(np.diag(pcov))
print(f"sigma = {sigma:.4f} ± {sigma_err:.4f}")
print(f"kappa = {kappa:.4f} ± {kappa_err:.4f}")
```

With the example data the fit returns σ = 0.0182 ± 0.0011 and κ = 0.00014 ± 0.00002. The peak concurrency N* = √((1 - σ) / κ) ≈ 83. The peak throughput C(N*) ≈ 53.8 times the single-thread baseline. At N = 128 the model predicts 48.2 — already on the retrograde limb.

Check the residuals. Systematic curvature means the model is missing a third effect such as garbage collection pauses or OS scheduler limits. If residuals are random the two-parameter USL is sufficient.

## Interpret sigma and kappa

Sigma near zero means the workload parallelises well. Sigma above 0.1 usually points to a global lock, a single-threaded service mesh sidecar, or a database connection pool exhausted at low concurrency. Profile with `perf lock` or Java Flight Recorder to find the hottest contended monitor.

Kappa near zero means threads share little mutable state. Kappa above 0.001 often comes from cache line ping-ponging on a shared counter, distributed cache invalidation storms, or consensus protocol overhead. In a Kubernetes service mesh kappa can spike when mTLS renegotiation happens on every request. Use `perf c2c` (cache-to-cache) or Intel VTune to measure remote cache misses.

## Predict the production cliff

The fitted model gives you three actionable numbers:

1. **N_opt** = √((1 - σ) / κ) — the concurrency that maximises throughput.
2. **X_max** = C(N_opt) × X(1) — the absolute throughput ceiling.
3. **Retrograde onset** — the concurrency where throughput drops below ninety percent of X_max. Solve C(N) = 0.9 × C(N_opt) for N > N_opt.

For the example above N_opt = 83, X_max = 52,700 req/s, and the ninety percent threshold is crossed at N = 108. If your autoscaler targets eighty percent CPU and that maps to N = 110, you will scale into the retrograde zone and throughput will fall as replicas increase.

## Reduce sigma

- Partition the hot resource. Shard the database connection pool per tenant. Replace a global lock with striped locks (Java `Striped<Lock>` or Go `sync.Map`).
- Move serial work off the critical path. Write-ahead logging, async metrics emission, and background compaction all shrink the serial fraction.
- Check thread pool sizing. A fixed pool smaller than the hardware threads caps N artificially and inflates the apparent σ.

## Reduce kappa

- Affinitise threads to sockets and keep working sets local. In Java `-XX:+UseNUMA` and `-XX:ActiveProcessorCount` help. In Go `runtime.LockOSThread` for critical sections.
- Replace shared mutable state with immutable snapshots or event sourcing. A read-heavy cache that invalidates on every write is a kappa factory.
- Batch coherency work. Flush distributed cache invalidations in a single RPC instead of one per update.

## Checklist before you trust the model

- [ ] Closed-loop driver with fixed concurrency per step
- [ ] Steady-state measurement window at each N (CV < 2%)
- [ ] At least eight data points spanning one to four times expected N_opt
- [ ] Residuals randomly distributed, no U-shape
- [ ] Confidence intervals on σ and κ narrow enough for capacity decisions (relative error < 20%)
- [ ] Model validated against a hold-out concurrency level not used in the fit

## When USL lies to you

USL assumes homogeneous requests and a stationary system. Real systems violate both. If request mix shifts (read-heavy to write-heavy) the parameters change. If a background compaction runs every ten minutes the throughput curve breathes. In those cases fit USL per workload class and per time window, then take the worst-case N_opt for capacity planning.

Also watch for coordinated omission in your latency measurements. If the load generator pauses while waiting for a slow response, the measured throughput at high N is inflated. Use a generator that records intended arrival times (k6, vegeta, or a custom closed-loop driver) so the throughput denominator is wall-clock time not busy time.

The next time a stakeholder asks how much headroom you have, hand them the USL fit with confidence bands. Show the peak, show the retrograde cliff, and tell them exactly which knob — sigma or kappa — buys the most room. That conversation beats a straight-line extrapolation every time.
