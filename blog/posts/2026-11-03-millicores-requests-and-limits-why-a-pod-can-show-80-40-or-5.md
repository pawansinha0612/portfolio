---
title: Millicores, Requests, and Limits: Why a Pod Can Show 80%, 40% or 5% CPU Usage
date: 2026-11-03
summary: Learn how Kubernetes measures CPU, how requests and limits work, and why a pod’s utilisation can vary wildly.
tags: Kubernetes, CPU, Millicores
linkedin: |
  Ever wondered why a pod shows 80 %, 40 % or 5 % CPU utilisation? The answer lies in what the metric is being compared to. In Kubernetes, the percentage can be against the node’s total capacity, the pod’s CPU limit, or its request. Understanding this helps you avoid mis‑interpreting dashboards. A quick rule: if the number looks too low, you’re likely looking at node capacity; if it’s high, it’s probably a container limit. How do you handle these variations in your monitoring stack?
---
# Millicores, Requests, and Limits

When you look at a pod’s CPU usage in a dashboard, you often see numbers like 80 %, 40 % or 5 %. Those percentages can be confusing if you don’t understand how Kubernetes measures CPU.

## 1. The 1 CPU = 1000 m rule

Kubernetes uses a unit called a *millicore*.

* 1 CPU = 1000 m
* 200 m means 0.2 CPU
* 2500 m means 2.5 CPU

This is simply a way to express fractions of a single CPU core. Most dashboards report utilisation against the node’s total capacity. If a node has 4 CPU cores, its capacity is 4000 m.

## 2. Requests and limits

Each container in a pod declares two CPU values:

| Value | What it tells the scheduler | What it tells the kube‑let
|-------|------------------------------|-----------------------------
| **Request** | Minimum CPU guaranteed | CPU that the container can always use
| **Limit** | Upper bound for CPU usage | CPU that the container cannot exceed

If you set a request of 500 m and a limit of 1000 m, the pod gets 0.5 CPU guaranteed. It can burst up to 1 CPU if the node has spare capacity.

Requests are used when the scheduler places the pod on a node. Limits are enforced by the kube‑let.

## 3. Node capacity vs pod utilisation

The percentage you see is calculated as:

```
CPU used by pod / CPU capacity of node × 100
```

So if a node has 4000 m of CPU and a pod uses 800 m, the utilisation shown is 20 %.

However, the pod may also expose *own* CPU usage relative to its request or limit. Different monitoring tools show different metrics.

### Example

* Node: 4 CPU cores (4000 m)
* Pod A: 1 container
  * Request: 250 m
  * Limit: 500 m
  * Current usage: 400 m

*Utilisation calculation*:

```
400 m / 4000 m = 0.10 → 10 %
```

But the container itself is using 160 % of its request (400 / 250) and 80 % of its limit (400 / 500). A dashboard that reports *pod utilisation on node* will show 10 %, while one that shows *request utilisation* will show 160 %. That explains the 80 %, 40 % or 5 % you see.

## 4. Why a pod can show 80 %, 40 % and 5 %

| Scenario | What is being measured | Reason for the figure
|----------|------------------------|------------------------
| 80 % | CPU usage vs node capacity | Pod uses 3200 m on a 4000 m node
| 40 % | CPU usage vs pod limit | Pod uses 200 m of a 500 m limit
| 5 % | CPU usage vs pod request | Pod uses 200 m of a 4000 m node but its request is 200 m

The key point: different dashboards use different denominators. If the monitoring tool shows *node‑level* utilisation, the number will be small when the node has many cores. If it shows *container‑level* utilisation relative to the container’s limit, the number can be large.

## 5. Checklist for interpreting CPU metrics

- **Identify the unit** your dashboard uses: millicores or cores.
- **Check the denominator**: node capacity, pod limit, or pod request.
- **Look at the container definition**: request and limit values.
- **Compare with node capacity**: 4 CPU node = 4000 m.
- **Use the same metric across your stack**: if you rely on node‑level numbers for thresholds, stick to that.

## 6. Practical tip

If you want a single, consistent view of CPU utilisation, calculate it yourself:

```
# kubectl top pod <pod-name> -n <ns> --containers
# parse output, sum m values, divide by node capacity (in m)
```

This gives you a clear 0‑100 % figure that matches the node’s capacity.

## 7. Takeaway

CPU utilisation percentages in Kubernetes can look wildly different because they are calculated against different baselines. Always check whether the metric is node‑based, limit‑based or request‑based before you act on it.
