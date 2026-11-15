---
title: Your load test is failing at the TCP layer
date: 2026-11-24
summary: Load tests often hit OS network limits before the application breaks. Here's how to tune somaxconn, SYN backlog, TIME_WAIT and ephemeral ports so the test actually reaches your code.
description: Fix TCP accept queue, SYN backlog, TIME_WAIT and port exhaustion that silently fail load tests.
tags: Performance, k6, Linux, Networking
linkedin: |
  Your load test hits 50k VUs and reports connection refused. The application logs are empty. The bottleneck is the OS TCP stack, not your code.
  
  Three kernel limits silently drop traffic before it reaches your service: the accept queue (somaxconn), the SYN backlog, and the client-side TIME_WAIT port exhaustion. Defaults tuned for web browsing cap out at a few hundred connections per second.
  
  Fix: raise somaxconn and tcp_max_syn_backlog to match your peak burst, enable tcp_tw_reuse on the generator, expand ip_local_port_range, and add source IPs if you exceed 64k ports/sec. Then watch ListenOverflows, SYN cookies sent, and timewait sockets stay at zero.
  
  What TCP limit has bitten you hardest in a load test?
---
Your load test ramps to 50,000 virtual users. The tool reports connection refused errors and the target service logs show nothing. The bottleneck is not your code. It is the operating system network stack dropping packets before the application ever sees them.

Every TCP connection crosses a series of kernel queues and timers. When a load generator opens thousands of connections per second, the defaults tuned for web browsing become hard limits. The test fails at the transport layer and you waste hours debugging application latency that does not exist.

## The accept queue and somaxconn

When a listening socket calls `listen(2)`, the kernel creates two queues. The incomplete connection queue holds SYN-RECEIVED sockets waiting for the final ACK. The complete connection queue holds ESTABLISHED sockets waiting for `accept(2)`. The `backlog` argument to `listen` historically capped the complete queue. Since Linux 2.2 the incomplete queue is sized by `net.ipv4.tcp_max_syn_backlog` and the complete queue is capped by `min(backlog, net.core.somaxconn)`.

If your server calls `listen(fd, 128)` and `somaxconn` is the default 128, the complete queue holds 128 connections. A burst of 200 concurrent `accept` calls fills the queue. The 129th SYN-ACK is sent but the kernel drops the resulting ACK because the queue is full. The client retransmits. You see connection timeouts or resets.

**Detection**: `netstat -s | grep -i listenoverflow` increments each time the complete queue overflows. `ss -lnt` shows `Recv-Q` (the current complete queue depth) and `Send-Q` (the backlog limit). If `Recv-Q` equals `Send-Q` under load, you are dropping connections.

**Fix**: Raise both sides. In `sysctl.conf`:
```
net.core.somaxconn = 4096
net.ipv4.tcp_max_syn_backlog = 8192
```
Then ensure the application passes a backlog at least that large. In Go `ln, _ := net.Listen("tcp", addr)` uses `net.core.somaxconn` automatically. In Java `new ServerSocket(port, 4096)` sets the backlog explicitly. In Node `server.listen(port, () => {})` defaults to 511; pass `server.listen(port, 4096)`.

Trade-off: larger queues consume kernel memory for each pending socket. A full queue of 65,535 sockets at ~1 KB each is ~64 MB. Acceptable on modern hosts but watch `slabinfo` for `tcp*` caches.

## SYN backlog and SYN cookies

The incomplete queue size is `tcp_max_syn_backlog`. When it fills, the kernel can either drop the SYN or, if `net.ipv4.tcp_syncookies=1` (default on), send a cryptographic SYN-ACK without allocating socket state. The client's ACK validates the cookie and the kernel reconstructs the socket.

SYN cookies save memory during a SYN flood but disable TCP options negotiated in the SYN: window scaling, SACK, timestamps. Throughput drops on high latency paths because the window cannot scale beyond 65,535 bytes. For a load test that mimics real clients, you want the full option set.

**Detection**: `netstat -s | grep -i "syncookies"` shows `TCP SYN cookies sent` and `TCP SYN cookies received`. If these increment during your test, the incomplete queue is overflowing.

**Fix**: Increase `tcp_max_syn_backlog` to match your peak connection rate multiplied by the expected handshake latency. For 20,000 connections per second with a 20 ms handshake, the queue needs 400 entries. Set 8192 for headroom. Keep SYN cookies enabled as a safety net but do not rely on them for performance tests.

## TIME_WAIT and ephemeral port exhaustion on the load generator

The load generator opens the client side of each connection. When it closes actively, the socket enters `TIME_WAIT` for 2 MSL (maximum segment lifetime), typically 60 seconds on Linux. During this period the 4-tuple (src IP, src port, dst IP, dst port) cannot be reused. The ephemeral port range defaults to 32768–60999, roughly 28,000 ports.

At 500 connections per second, 500 ports enter `TIME_WAIT` each second. After 60 seconds, 30,000 ports are occupied. The range is exhausted. New `connect(2)` calls fail with `EADDRNOTAVAIL`. The load tool reports "address already in use" or "cannot assign requested address".

**Detection**: On the generator, `ss -s | grep timewait` shows `timewait sockets`. `cat /proc/sys/net/ipv4/ip_local_port_range` shows the range. Do the math: `rate * 60 > (max - min)` means exhaustion.

**Fixes, in order of preference**:

1. **Let the server close first**. Design the protocol so the server sends FIN after the response. The client does a passive close and goes straight to `CLOSED`. No `TIME_WAIT` on the generator. This is the cleanest fix but requires application cooperation.
2. **Enable `tcp_tw_reuse`**. `net.ipv4.tcp_tw_reuse = 1` allows a new outgoing connection to reuse a port in `TIME_WAIT` if the timestamp option is negotiated and the timestamp has advanced. Safe for client sockets. Does not work if the server disables timestamps.
3. **Reduce `tcp_fin_timeout`**. `net.ipv4.tcp_fin_timeout = 15` shortens the `TIME_WAIT` equivalent for the `FIN_WAIT_2` state. It does not change the 60 second `TIME_WAIT` after active close but helps when the peer is slow to send the final ACK.
4. **Expand the port range**. `net.ipv4.ip_local_port_range = 1024 65535` gives ~64,000 ports. Combined with `tcp_tw_reuse` this handles ~1,000 connections per second sustained.
5. **Add source IPs**. Bind the load generator to multiple IP addresses. Each IP gets its own port space. `k6` supports `--local-addr` with a comma list. Four IPs quadruple capacity.

Do not enable `net.ipv4.tcp_tw_recycle`. It was removed in Linux 4.12 because it broke NAT scenarios. Do not rely on `SO_REUSEADDR` on the client side; it only affects `bind`, not the `TIME_WAIT` check on `connect`.

## Putting it together: a worked example

Imagine a test targeting an API at 10.0.1.50:443 from a generator at 10.0.1.10. Target rate: 5,000 connections per second. Handshake RTT: 2 ms. Request-response: 5 ms. Connection close: client sends FIN immediately after response.

**Server side**:
- Expected concurrent ESTABLISHED: 5,000 * 0.007 = 35 sockets. Tiny.
- But burst arrivals can spike. Set `somaxconn=4096`, `tcp_max_syn_backlog=8192`. Application backlog 4096.
- `ListenOverflows` stays at zero.

**Generator side**:
- Active close rate: 5,000/sec.
- Ports needed in 60 s: 300,000.
- Default range 28,232 ports. Exhaustion guaranteed.
- Apply `tcp_tw_reuse=1` and expand range to 1024–65535 (64,511 ports).
- With timestamps enabled (default), reuse works after 1 second (timestamp resolution). Effective capacity ~64,000 ports/sec. Still short of 5,000/sec? Wait, 64,000 ports reused per second means we can sustain 64,000 connections per second. 5,000 is fine.
- Math: `reuse_interval = 1 second` (timestamp tick). `ports_per_second = 64,511`. `max_rate = ports_per_second`. 5,000 < 64,511. Pass.
- If timestamps are disabled on server, reuse fails. Then need multiple source IPs. Two IPs give 129,000 ports/sec.

**Checklist before every load test**

- [ ] `sysctl net.core.somaxconn` >= expected peak concurrent connections * 2
- [ ] `sysctl net.ipv4.tcp_max_syn_backlog` >= peak connection rate * handshake_seconds * 2
- [ ] Application listen backlog matches or exceeds `somaxconn`
- [ ] `netstat -s` baseline captured, `ListenOverflows` and `SYN cookies` at zero
- [ ] Generator `ip_local_port_range` covers at least `rate * 60` ports
- [ ] Generator `tcp_tw_reuse=1` and timestamps not disabled on server
- [ ] Generator has enough source IPs for `rate * 60 / port_range`
- [ ] `ss -s` monitored during ramp for `timewait` and `orphan` sockets

## What the metrics actually mean

`ListenOverflows` increments when the complete accept queue is full and a new ACK arrives. The kernel drops the ACK. The client retransmits. You see latency spikes that look like GC pauses but are really retransmission timeouts.

`SYN cookies sent` means the incomplete queue was full. The handshake completes but without window scaling. Your 10 Gbps link tops out at 65 KB/s per connection. The test passes but measures the wrong thing.

`timewait sockets` climbing linearly means the generator cannot open new connections fast enough. `EADDRNOTAVAIL` appears in the load tool logs. The test throughput plateaus while CPU and memory are idle.

All three are kernel accounting events. They do not appear in application logs. You must look at `/proc/net/netstat` or `netstat -s` or `ss -s` to see them.

## One more thing: connection tracking

If the path crosses a stateful firewall or cloud load balancer with connection tracking (conntrack, AWS NLB, GCP Cloud Armor), the same limits apply there. The tracker has a table size and a hash bucket limit. Exhaustion shows as silent drops. `conntrack -L | wc -l` on the host or cloud metrics `ActiveFlowCount` will reveal it. Size the tracker table to `peak_rate * max_connection_lifetime * 2`.

The network stack is part of your system under test. Tune it before you blame the code.
