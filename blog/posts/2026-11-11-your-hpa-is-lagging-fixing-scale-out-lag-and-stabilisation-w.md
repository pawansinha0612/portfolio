---
title: Your HPA is lagging: fixing scale‑out lag and stabilisation windows
date: 2026-11-11
summary: Learn how HPA stabilisation windows, node provisioning times and traffic ramp rates affect real‑world scale‑out, and how to test and tune them.
tags: Performance, Kubernetes, Autoscaling
linkedin: |
  Your HPA might be the culprit behind a sudden latency spike. A short stabilisation window and a fast node‑provisioner like Karpenter can cut scale‑out lag from minutes to seconds. Test your ramp rates with k6 and watch HPA events in Prometheus to prove it. How do you tune HPA for your workloads?
---
# Your HPA is lagging: fixing scale‑out lag and stabilisation windows

You run a load test that shows the 95th‑percentile latency is 200 ms at 10 k RPS. In production, a traffic spike to 12 k RPS pushes the 99th‑percentile latency to 5 s. Your first instinct is to blame the Horizontal Pod Autoscaler (HPA). The problem is that the HPA control loop and node provisioning are not keeping pace with the traffic ramp.

## HPA control loop 101

The HPA watches a metric – usually CPU utilisation or a custom metric – and, every `--horizontal-pod-autoscaler-sync-period` (default 15 s), calculates a desired replica count. It then applies a *stabilisation window* to avoid oscillation. The stabilisation window is a period over which the HPA keeps the highest desired replica count and never drops below it. The default window is 5 minutes. This means that if traffic spikes for 30 s, the HPA may still hold the old replica count until the window expires.

The formula the HPA uses for CPU utilisation is:

```
desired = ceil((currentCPU / targetCPU) * currentReplicas)
```

where `currentCPU` is the average CPU utilisation of all pods, `targetCPU` is the HPA target (default 80 %), and `currentReplicas` is the current replica count. If the calculated `desired` is higher than the current replica count, the HPA sets the desired count to the maximum of the two values over the stabilisation window.

### Why the window matters

Consider a traffic spike that lasts 30 s. The HPA syncs every 15 s, so it will see the spike twice. If the stabilisation window is 5 min, the HPA will remember the highest desired count from the spike and will not reduce replicas until the window expires. This keeps the system from thrashing but can also delay scale‑out if the spike is brief.

If you need faster reaction, you can reduce the stabilisation window with `--horizontal-pod-autoscaler-sync-period` and `--horizontal-pod-autoscaler-stabilisation-window`. However, a too‑short window can cause rapid scaling, increasing cost and instability.

## Node provisioning: Cluster Autoscaler vs Karpenter

Even if the HPA decides to add replicas, the cluster must have enough nodes. Two common node‑provisioning solutions are the Cluster Autoscaler (CA) and Karpenter.

| Feature | Cluster Autoscaler | Karpenter |
|---------|-------------------|-----------|
| Provisioning time | 5–10 min (polls every 15 s) | 30–60 s (reactive, uses Spot/On‑Demand) |
| Cost optimisation | Uses existing node groups | Can launch spot nodes instantly |
| API | `kubectl get hpa` + `kubectl get nodes` | `kubectl get hpa` + `kubectl get nodes` |

The CA uses a *scaling plan* that looks at pending pods and decides whether to add or remove nodes. It polls at a fixed interval, so a sudden spike may not trigger a node addition until the next poll. Karpenter, on the other hand, listens for unschedulable pods and immediately requests a node from the cloud provider. This reduces the *node provisioning latency* by an order of magnitude.

### Measuring provisioning time

Run a script that records timestamps before and after a node is added:

```bash
start=$(date +%s%3N)
# Trigger HPA to add replicas
kubectl scale deployment myapp --replicas 10
# Wait for node to appear
while ! kubectl get nodes | grep -q "Ready"; do sleep 1; done
end=$(date +%s%3N)
elapsed=$((end - start))
echo "Provisioning time: $elapsed ms"
```

You will see that CA typically reports 5–10 min, whereas Karpenter reports 30–60 s.

## Scale‑out lag vs traffic ramp rate

The *scale‑out lag* is the time between the HPA deciding to add replicas and those replicas becoming available to serve traffic. The *traffic ramp rate* is how quickly you increase RPS during a test or a real‑world surge. These two interact through queueing theory.

Little’s Law states that the average number of requests in the system (L) equals the arrival rate (λ) times the average wait time (W):

```
L = λ × W
```

If you ramp traffic from 5 k to 15 k RPS over 2 min, λ increases by 5 k RPS every 30 s. If the scale‑out lag is 60 s, the system will queue an additional 300 k requests during that lag. With an average service time of 10 ms, the queue will grow to 3 k requests, pushing latency up dramatically.

### Coordinated omission

When measuring latency during a ramp, you must capture all requests, not just those served. If you only record served requests, you will miss the ones that were queued, leading to *coordinated omission*. Use a load generator that records timestamps for every request, including those that were rejected or timed out.

## End‑to‑end testing strategy

1. **Set up a realistic traffic ramp** using k6.
2. **Enable HPA** with a short stabilisation window (e.g. 30 s) and a target CPU of 70 %.
3. **Choose a node‑provisioner** – Karpenter for low latency, CA for cost optimisation.
4. **Collect metrics** from Prometheus: `kube_hpa_status_current_replicas`, `kube_node_status_capacity`, `http_request_duration_seconds_bucket`.
5. **Analyse** queue length using `kube_pod_status_phase` and `kube_pod_container_status_waiting_reason`.

### k6 traffic ramp script

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';

export let options = {
  stages: [
    { duration: '2m', target: 5000 },
    { duration: '1m', target: 15000 },
    { duration: '2m', target: 5000 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<200'],
  },
};

export default function () {
  let res = http.get('http://myapp.default.svc.cluster.local/api');
  check(res, { 'status was 200': (r) => r.status === 200 });
  sleep(1);
}
```

### Prometheus query to watch HPA events

```sql
kube_hpa_status_current_replicas{hpa="myapp-hpa"}
```

This query returns the current replica count over time. Combine it with `kube_node_status_capacity` to see when new nodes appear.

## Checklist for production readiness

| Item | How to validate | Tool / Command |
|------|-----------------|----------------|
| HPA stabilisation window | Verify that replicas increase within 30 s of a 10 k RPS spike | `kubectl describe hpa myapp-hpa` |
| Node provisioning latency | Measure time from HPA trigger to node ready | Script above |
| Traffic ramp rate | Ensure latency does not exceed 200 ms at 10 k RPS | k6 thresholds |
| Queue length | Confirm that queue stays below 1 k requests during ramp | Prometheus query `kube_pod_status_phase` |
| Coordinated omission | Verify that all requests are recorded, including timeouts | k6 `check` functions |

## Takeaway

The HPA control loop, stabilisation windows, and node‑provisioning latency together determine whether your cluster can keep up with a traffic ramp. By tuning the stabilisation window, choosing the right node‑provisioner, and measuring the entire request path, you can reduce the scale‑out lag from minutes to seconds and keep latency in check.
