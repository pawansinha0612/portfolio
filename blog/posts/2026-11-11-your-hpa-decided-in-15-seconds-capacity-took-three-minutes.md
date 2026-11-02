---
title: Your HPA decided in 15 seconds. Capacity took three minutes
date: 2026-11-11
summary: Scale-out lag is rarely the HPA's maths. It is metric delay, scale-up policies, node provisioning and pod start time stacked together. What the stabilisation window really does, how to size the backlog a ramp creates, and how to test it with an arrival-rate load test.
description: HPA scale-out lag is metric delay, sync period, node provisioning and pod start stacked together. What the stabilisation window really does.
tags: Performance, Kubernetes, Autoscaling
highlight: three minutes
linkedin: |
  Traffic triples in a minute. The HPA asks for more pods within seconds. The pods serve traffic three minutes later.

  The HPA decision is the fast part. The lag is the chain around it: metrics that are already 30 seconds old, a 15 second sync, image pull, JVM start, readiness probes, and node provisioning when no node has room.

  A common fix is shortening the 5-minute stabilisation window. That window only delays scale-down. Scale-up has no window by default.

  Every second of lag turns excess demand into backlog. A ramp from 2,000 to 6,000 req/s with 75 seconds of lag queues over 140,000 requests before the first new pod is ready.

  The article has a simulator: put in your own ramp, pod capacity and reaction times and see the backlog.

  Have you ever measured the time from HPA decision to pod Ready in your cluster?

  #PerformanceEngineering #Kubernetes #SRE
---
Traffic triples in a minute. Your HPA notices, does the maths and asks for 60 more pods. Then nothing happens. For the next three minutes the existing 25 pods take the whole surge, queues fill and p99 climbs past your client timeout.

When the new pods finally go Ready, the incident is already over and the HPA gets the blame. Someone shortens the 5-minute stabilisation window. Nothing improves, because that window was never in the way.

The HPA's decision is the fast part. The lag lives in the chain around it.

## What the HPA actually computes

Every sync period (15 s by default, set by `--horizontal-pod-autoscaler-sync-period` on kube-controller-manager) the controller computes:

```
desiredReplicas = ceil(currentReplicas × currentMetricValue / desiredMetricValue)
```

If the ratio is within a tolerance of 10% (default), it does nothing. Three details matter more than the formula:

- **CPU utilisation is relative to the pod's CPU request**, not the node or the limit. Requests set too high make the HPA react late. Requests set too low make it scale on noise.
- **Pods that are not yet Ready are treated as using 0% of the target** when the controller computes a scale-up. This deliberately damps the next step while earlier pods are still starting.
- **A saturated pod cannot report demand it never received.** If the work is CPU-bound and pods are pinned, measured utilisation stops at the ceiling while real demand keeps rising, so each sync under-asks. Request rate or queue depth does not have this blind spot.

## Stabilisation windows slow scale-down, not scale-up

In `autoscaling/v2` the defaults are:

- **Scale-up:** stabilisation window 0 s. Policies allow the larger of +100% or +4 pods every 15 s.
- **Scale-down:** stabilisation window 300 s (cluster-wide default from `--horizontal-pod-autoscaler-downscale-stabilization`). The HPA uses the highest recommendation from the last five minutes, so it scales in slowly.

The window is a look-back that holds pods up after a spike. It never delays adding them.

The scale-up policy is rarely the bottleneck either. From 25 pods it allows 50, then 100, 15 s apart. Tune both directions per HPA with `spec.behavior`:

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: checkout
  namespace: shop
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: checkout
  minReplicas: 25
  maxReplicas: 200
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 60
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 0
      selectPolicy: Max
      policies:
        - type: Percent
          value: 100
          periodSeconds: 15
        - type: Pods
          value: 10
          periodSeconds: 15
    scaleDown:
      stabilizationWindowSeconds: 600
      policies:
        - type: Percent
          value: 10
          periodSeconds: 60
```

The useful change is on the scale-down side. A longer window and a gentle rate stop the HPA removing capacity between two waves of a spike. The sync period is a controller flag you usually cannot change on managed control planes.

## Where the time goes

| Step | Typical cost | Lever |
|------|--------------|-------|
| Metric collection | metrics-server resolution 15 s (60 s in old releases), plus the averaging window | Scale on a faster signal |
| HPA sync | up to 15 s | Usually fixed on managed clusters |
| Scheduling | under a second if a node has room | Spare capacity |
| Node provisioning | usually minutes: VM boot, kubelet join, node Ready | Overprovisioning, Karpenter |
| Image pull | seconds if cached, far longer for a large image on a fresh node | Smaller images, pre-pulling |
| App start and readiness | seconds for a small Go service, often tens of seconds for a JVM | Faster start, tuned probes |
| Endpoint propagation | pod added to EndpointSlices, then to kube-proxy or the balancer | Watch balancer registration |

Cluster Autoscaler scans for unschedulable pods every 10 s by default, then scales a node group. Karpenter launches right-sized instances directly from pending pods, which is often quicker. Either way VM boot dominates, and it turns 75 seconds of lag into several minutes.

## The cost of lag, in requests

During the lag, excess demand (demand minus ready capacity) accumulates every second. It becomes backlog if you queue it, or errors if you shed it.

Take an example. Each pod serves 100 req/s, and 25 pods carry 2,000 req/s at 80% utilisation, so ready capacity is 2,500 req/s. Demand ramps linearly to 6,000 req/s over 60 s. Assume the first extra pods are Ready at 75 s.

- Demand crosses 2,500 req/s at 7.5 s.
- From 7.5 s to 60 s the excess grows from 0 to 3,500 req/s: ½ × 52.5 × 3,500 ≈ 91,900 requests.
- From 60 s to 75 s it holds at 3,500 req/s: another 52,500.
- Backlog at 75 s: about 144,000 requests.

Little's Law (L = λW) gives the wait. With L = 144,000 queued and λ = 2,500 req/s served, the request at the back waits about 58 s. Past a 30 s client timeout, that backlog becomes timeouts and retries, and retries add demand.

Run the same ramp at a 60% target (34 pods, 3,400 req/s ready) and the backlog at 75 s drops to about 90,000. Headroom helps, but it does not fix a 3× ramp on its own. The backlog also keeps growing after 75 s until enough pods arrive. Try your own numbers:

<div class="widget" data-widget="hpa"><p><em>Interactive calculator: open this post on pawansinha.com.au to try it with your own numbers.</em></p></div>

## Fixes, in the order I'd try them

1. **Pre-scale known peaks.** A launch or a draw is in the calendar. Raise `minReplicas` before it with a CronJob, or use KEDA's cron scaler. No reactive autoscaler beats capacity that already exists.
2. **Scale on a leading signal.** KEDA scales on queue length, Prometheus queries such as request rate, or schedules, and drives an HPA underneath. Request rate rises before CPU saturates and does not cap at the pod's ceiling.
3. **Keep spare nodes.** Overprovisioning runs low-priority placeholder pods (pause containers with a negative PriorityClass) that reserve room. Real pods preempt them and schedule in seconds, and the evicted placeholders trigger node provisioning in the background. Keep their priority at or above Cluster Autoscaler's expendable cutoff (default −10), or they won't trigger scale-up.
4. **Lower the target utilisation** for spiky services. You pay for idle headroom to buy reaction time.
5. **Shorten pod start.** Small images, a short readiness `periodSeconds` instead of a long `initialDelaySeconds`, and warm-up before Ready.

## Proving it with a test

A closed-model test with ramping VUs and `sleep(1)` does not produce a target request rate. As latency rises, each VU sends less, which hides the lag you are trying to measure. Use an arrival-rate executor:

```javascript
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  scenarios: {
    spike: {
      executor: 'ramping-arrival-rate',
      startRate: 2000,
      timeUnit: '1s',
      preAllocatedVUs: 500,
      maxVUs: 3000,
      stages: [
        { target: 2000, duration: '5m' },  // settle at baseline
        { target: 6000, duration: '1m' },  // the ramp
        { target: 6000, duration: '10m' }, // watch recovery
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(99)<500'],
    dropped_iterations: ['count==0'],
  },
};

export default function () {
  const res = http.get('https://checkout.example.com/api/cart');
  check(res, { 'status is 200': (r) => r.status === 200 });
}
```

Arrival rate keeps sending at the planned rate while the system slows down, which avoids coordinated omission (the load generator backing off exactly when the system is slow). If k6 runs out of VUs it reports `dropped_iterations` rather than hiding them.

While it runs, plot the gap between what the HPA wants and what is Ready (kube-state-metrics v2):

```promql
kube_horizontalpodautoscaler_status_desired_replicas{namespace="shop", horizontalpodautoscaler="checkout"}

sum(kube_pod_status_ready{namespace="shop", pod=~"checkout-.*", condition="true"})

sum(kube_pod_status_phase{namespace="shop", pod=~"checkout-.*", phase="Pending"})

histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket{service="checkout"}[1m])))
```

The latency metric name depends on your instrumentation. For per-pod lag, compare creation and Ready times:

```bash
kubectl get pods -n shop -l app=checkout -o custom-columns='NAME:.metadata.name,CREATED:.metadata.creationTimestamp,READY:.status.conditions[?(@.type=="Ready")].lastTransitionTime'
kubectl get events -n shop --field-selector involvedObject.kind=HorizontalPodAutoscaler
```

## Checklist

| Check | How |
|-------|-----|
| CPU requests reflect real usage | Compare requests with observed usage under load |
| Decision to Ready time, with and without spare nodes | Pod creation vs Ready timestamps |
| Desired vs Ready gap during a ramp | PromQL above |
| Scale-down holds through a double spike | Two ramps 3 minutes apart |
| No coordinated omission | Arrival-rate executor, `dropped_iterations` threshold |

Measure the reaction time first, then size headroom to cover it. Tuning the HPA before you know where the minutes go is guessing.
