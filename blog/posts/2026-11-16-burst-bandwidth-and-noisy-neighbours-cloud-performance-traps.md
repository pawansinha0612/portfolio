---
title: Burst, Bandwidth, and Noisy Neighbours: Cloud Performance Traps You’re Missing
date: 2026-11-16
summary: Cloud performance traps like burstable CPU credits, per‑instance network limits, cross‑AZ latency, noisy neighbours and service throttling can silently inflate latency and cost. This post shows how to spot and mitigate them.
description: Cloud performance traps: burstable CPU credits, network limits, cross‑AZ latency, noisy neighbours, throttling quotas.
tags: Performance, Cloud, AWS
linkedin: |
  Your load test says p99 is 1 ms, but in production you hit 9 s. Why? Burstable CPU credits can silently throttle you. The fix is simple: monitor CPUCreditBalance and set an alarm before it hits zero. Have you ever seen a CloudWatch alarm trigger on credit exhaustion? What other hidden traps have you uncovered in your cloud workloads?
---
Your load test on a t3.medium shows p99 1 ms, but in production you hit 9 s. The culprit? A burstable instance exhausted its CPU credits.

## Burstable Instances and CPU Credits

Burstable instances are designed for workloads that are idle most of the time but need occasional spikes. Each instance accrues CPU credits at a fixed rate. A credit equals 1 % of a single core per second. When you run at 100 % CPU, you spend credits. If the balance reaches zero, the instance throttles to 10 % CPU. This is coordinated omission.

The math is simple: credits = credit_rate × time – usage_rate × time. For a t3.medium credit_rate is 1 credit per second. If you run at 100 % for 10 s you spend 10 credits. If you have 0 credits left you cannot sustain that utilisation.

### Detection

CloudWatch exposes CPUCreditBalance and CPUCreditUsage metrics. A quick query:

```bash
aws cloudwatch get-metric-statistics \
  --namespace AWS/EC2 \
  --metric-name CPUCreditBalance \
  --dimensions Name=InstanceId,Value=i-0123456789abcdef0 \
  --statistics Maximum \
  --period 300 \
  --start-time 2024-01-01T00:00:00Z \
  --end-time 2024-01-01T01:00:00Z
```

If the balance falls below a threshold, you should alarm:

```bash
aws cloudwatch put-metric-alarm \
  --alarm-name LowCPUCreditBalance \
  --metric-name CPUCreditBalance \
  --namespace AWS/EC2 \
  --statistic Minimum \
  --period 300 \
  --threshold 10 \
  --comparison-operator LessThanThreshold \
  --dimensions Name=InstanceId,Value=i-0123456789abcdef0 \
  --evaluation-periods 1 \
  --alarm-actions arn:aws:sns:us-east-1:123456789012:Notify
```

### Mitigation

* Switch to unlimited credit mode if your workload is bursty but you cannot afford throttling.
* Move to a general‑purpose or compute‑optimized instance if you need sustained CPU.
* Implement a credit‑aware scheduler that spreads load across instances.

## Per‑Instance Network Bandwidth Limits

Network performance is tied to instance type. A t3.medium offers up to 5 Gbps aggregate bandwidth. If you saturate the network you see increased latency. The CloudWatch metrics NetworkIn and NetworkOut show traffic volume.

For example, sending 1 Gbps of traffic for 10 s consumes 10 Gb of data, which exceeds the 5 Gbps limit and triggers throttling. The resulting latency can grow from 1 ms to 200 ms.

### Detection

```bash
aws cloudwatch get-metric-statistics \
  --namespace AWS/EC2 \
  --metric-name NetworkIn \
  --dimensions Name=InstanceId,Value=i-0123456789abcdef0 \
  --statistics Average \
  --period 60 \
  --start-time 2024-01-01T00:00:00Z \
  --end-time 2024-01-01T01:00:00Z
```

VPC flow logs can confirm packet drops.

### Mitigation

* Upgrade to a larger instance type with higher network performance.
* Use Elastic Network Interfaces (ENIs) to increase throughput.
* Off‑load traffic to a load balancer or use AWS Global Accelerator to optimise path.

## Cross‑AZ Latency and Cost

Traffic between Availability Zones incurs ~10–30 ms latency and $0.01–$0.02 per GB. If your architecture keeps state in one AZ but reads from another you double latency and cost.

### Detection

Run a simple traceroute or ping from one AZ to another and record round‑trip time. CloudWatch can also surface inter‑AZ traffic metrics if you enable VPC Flow Logs.

### Mitigation

* Keep co‑located services in the same AZ.
* Use placement groups to minimise inter‑AZ traffic.
* Deploy AWS Global Accelerator to provide a single, low‑latency entry point.

## Noisy Neighbours

On shared hypervisor hosts, other tenants can consume CPU, memory, and I/O. This is called a noisy neighbour. It manifests as unexplained CPU utilisation spikes that are not correlated with your own workload.

### Detection

CloudWatch CPUUtilisation spikes that do not match your traffic pattern are a red flag. Trusted Advisor can also flag noisy neighbour issues.

### Mitigation

* Use dedicated hosts or instance tenancy to isolate your workload.
* Employ placement groups to co‑locate instances on the same host.
* Scale horizontally to spread load across more hosts.

## Managed‑Service Throttling Quotas

Services like DynamoDB, SQS, and API Gateway enforce quotas. Exceeding them returns 429 or 503 errors. These throttles are invisible in latency unless you handle them.

### Detection

Look for error codes 429 or 503 in your application logs. CloudWatch can surface these as metrics.

### Mitigation

* Request a quota increase via the Service Quotas console.
* Implement exponential backoff and jitter.
* Queue requests using SQS or a dedicated queue to smooth traffic.

## Checklist for Cloud Performance Traps

| Trap | Symptoms | Detection | Mitigation |
|------|----------|-----------|------------|
| Burstable CPU credits | p99 latency spikes after idle period | CloudWatch CPUCreditBalance < threshold | Switch to unlimited mode or a different instance type |
| Network bandwidth limits | Sustained high NetworkIn/Out, packet drops | CloudWatch NetworkIn/Out, VPC Flow Logs | Upgrade instance, add ENIs, use load balancer |
| Cross‑AZ traffic | Unexpected latency, higher cost | Traceroute, CloudWatch inter‑AZ metrics | Keep services in same AZ, use placement groups |
| Noisy neighbours | Unexplained CPU spikes | CloudWatch CPUUtilisation, Trusted Advisor | Dedicated hosts, placement groups |
| Service throttling | 429/503 errors, increased latency | Application logs, CloudWatch metrics | Increase quota, backoff, queue |

## Takeaway

Cloud performance traps are often hidden behind the veneer of a “good” load test. By systematically monitoring the right metrics, you can expose hidden throttling, bandwidth limits, and cross‑AZ costs before they become production nightmares. Apply the checklist above to your next test run and you’ll see the difference.
