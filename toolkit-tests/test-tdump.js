// Tests for docs/tools/thread-dump/tdump.js. Run: node toolkit-tests/test-tdump.js
'use strict';
const path = require('path');
const assert = require('assert');
const T = require(path.join(__dirname, '..', 'docs', 'tools', 'thread-dump', 'tdump.js'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e)); }
}

// ---------------------------------------------------------------- fixtures

const thr = (name, num, state, desc, body) =>
  `"${name}" #${num} prio=5 os_prio=0 cpu=10.00ms elapsed=100.00s tid=0x00007f00000${String(num).padStart(5, '0')} nid=0x${(1000 + num).toString(16)} ${desc}  [0x00007f1000000000]\n` +
  `   java.lang.Thread.State: ${state}\n${body}\n`;

const header = (ts) => `${ts}\nFull thread dump OpenJDK 64-Bit Server VM (17.0.12+7 mixed mode, sharing):\n\n`;

const monitorDeadlock = header('2026-11-06 10:00:00') +
  thr('worker-A', 20, 'BLOCKED (on object monitor)', 'waiting for monitor entry',
    '\tat com.example.Bank.transfer(Bank.java:10)\n\t- waiting to lock <0x00000000000000b1> (a com.example.Account)\n\t- locked <0x00000000000000a1> (a com.example.Account)\n\tat java.lang.Thread.run(java.base@17/Thread.java:840)') +
  thr('worker-B', 21, 'BLOCKED (on object monitor)', 'waiting for monitor entry',
    '\tat com.example.Bank.transfer(Bank.java:10)\n\t- waiting to lock <0x00000000000000a1> (a com.example.Account)\n\t- locked <0x00000000000000b1> (a com.example.Account)\n\tat java.lang.Thread.run(java.base@17/Thread.java:840)') +
  thr('bystander', 22, 'RUNNABLE', 'runnable', '\tat com.example.Main.loop(Main.java:5)') +
  `
Found one Java-level deadlock:
=============================
"worker-A":
  waiting to lock monitor 0x00007f0000001000 (object 0x00000000000000b1, a com.example.Account),
  which is held by "worker-B"

"worker-B":
  waiting to lock monitor 0x00007f0000002000 (object 0x00000000000000a1, a com.example.Account),
  which is held by "worker-A"

Java stack information for the threads listed above:
===================================================
"worker-A":
\tat com.example.Bank.transfer(Bank.java:10)
\t- waiting to lock <0x00000000000000b1> (a com.example.Account)
"worker-B":
\tat com.example.Bank.transfer(Bank.java:10)
\t- waiting to lock <0x00000000000000a1> (a com.example.Account)

Found 1 deadlock.
`;

// ReentrantLock deadlock: no JVM section, ownable synchronizers + parking
const reentrantDeadlock = header('2026-11-06 10:00:00') +
  thr('rl-1', 30, 'WAITING (parking)', 'waiting on condition',
    '\tat jdk.internal.misc.Unsafe.park(java.base@17/Native Method)\n\t- parking to wait for  <0x00000000000000c2> (a java.util.concurrent.locks.ReentrantLock$NonfairSync)\n\tat java.util.concurrent.locks.ReentrantLock.lock(java.base@17/ReentrantLock.java:322)\n\tat com.example.Ledger.post(Ledger.java:20)\n\n   Locked ownable synchronizers:\n\t- <0x00000000000000c1> (a java.util.concurrent.locks.ReentrantLock$NonfairSync)') +
  thr('rl-2', 31, 'WAITING (parking)', 'waiting on condition',
    '\tat jdk.internal.misc.Unsafe.park(java.base@17/Native Method)\n\t- parking to wait for  <0x00000000000000c1> (a java.util.concurrent.locks.ReentrantLock$NonfairSync)\n\tat java.util.concurrent.locks.ReentrantLock.lock(java.base@17/ReentrantLock.java:322)\n\tat com.example.Ledger.post(Ledger.java:20)\n\n   Locked ownable synchronizers:\n\t- <0x00000000000000c2> (a java.util.concurrent.locks.ReentrantLock$NonfairSync)');

// Object.wait() releases the monitor even though the frame below says "- locked"
const waitNotHold = header('2026-11-06 10:00:00') +
  thr('waiter', 40, 'WAITING (on object monitor)', 'in Object.wait()',
    '\tat java.lang.Object.wait(java.base@17/Native Method)\n\t- waiting on <0x00000000000000d1> (a com.example.Queue)\n\tat com.example.Queue.take(Queue.java:9)\n\t- locked <0x00000000000000d1> (a com.example.Queue)') +
  thr('enterer', 41, 'BLOCKED (on object monitor)', 'waiting for monitor entry',
    '\tat com.example.Queue.put(Queue.java:4)\n\t- waiting to lock <0x00000000000000d1> (a com.example.Queue)');

function poolDump(ts, nHikari, readerFrame) {
  let s = header(ts);
  for (let i = 1; i <= nHikari; i++) {
    s += thr(`http-nio-8080-exec-${i}`, 100 + i, 'TIMED_WAITING (parking)', 'waiting on condition',
      '\tat jdk.internal.misc.Unsafe.park(java.base@17/Native Method)\n\t- parking to wait for  <0x00000000000000e1> (a java.util.concurrent.SynchronousQueue$TransferStack)\n' +
      '\tat java.util.concurrent.SynchronousQueue.poll(java.base@17/SynchronousQueue.java:903)\n\tat com.zaxxer.hikari.util.ConcurrentBag.borrow(ConcurrentBag.java:151)\n' +
      '\tat com.zaxxer.hikari.pool.HikariPool.getConnection(HikariPool.java:180)\n\tat com.example.shop.OrderRepo.find(OrderRepo.java:30)');
  }
  s += thr('report-1', 300, 'RUNNABLE', 'runnable', `\tat ${readerFrame}\n\tat com.example.shop.Report.build(Report.java:12)`);
  return s;
}

// ---------------------------------------------------------------- tests

test('detects formats', () => {
  assert.strictEqual(T.detectFormat(monitorDeadlock), 'hotspot');
  assert.strictEqual(T.detectFormat('{"threadDump":{"threadContainers":[]}}'), 'json');
  assert.strictEqual(T.detectFormat('0SECTION       TITLE subcomponent dump routine\n3XMTHREADINFO      "main" J9VMThread:0x1, state:R, prio=5'), 'javacore');
  assert.strictEqual(T.detectFormat('#1 "main"\n      java.base/java.lang.Thread.sleep(Thread.java:509)'), 'dumpToFile');
  assert.strictEqual(T.detectFormat('hello world'), null);
});

test('parses header fields, state, frames and locks', () => {
  const d = T.analyse(monitorDeadlock).dumps[0];
  assert.strictEqual(d.threads.length, 3);
  const a = d.threads[0];
  assert.strictEqual(a.name, 'worker-A');
  assert.strictEqual(a.num, 20);
  assert.strictEqual(a.prio, 5);
  assert.strictEqual(a.state, 'BLOCKED');
  assert.strictEqual(a.cpuMs, 10);
  assert.strictEqual(a.nid, '0x3fc');
  assert.strictEqual(a.frames.length, 2);
  assert.deepStrictEqual(a.locks.map((l) => l.kind), ['waiting to lock', 'locked']);
  assert.strictEqual(d.ts, '2026-11-06 10:00:00');
});

test('JVM deadlock section is surfaced and not parsed as threads', () => {
  const d = T.analyse(monitorDeadlock).dumps[0];
  assert.strictEqual(d.jvmDeadlocks.length, 1);
  assert.deepStrictEqual(d.jvmDeadlocks[0].threads, ['worker-A', 'worker-B']);
  assert.ok(d.jvmDeadlocks[0].text.includes('which is held by "worker-B"'));
  assert.strictEqual(d.threads.filter((t) => t.name === 'worker-A').length, 1);
});

test('monitor deadlock cycle detected from the lock graph', () => {
  const d = T.analyse(monitorDeadlock).dumps[0];
  assert.strictEqual(d.cycles.length, 1);
  assert.deepStrictEqual(d.cycles[0].map((e) => e.t.name).sort(), ['worker-A', 'worker-B']);
  assert.ok(d.hints[0].title.startsWith('Deadlock'));
});

test('ReentrantLock deadlock detected via ownable synchronizers', () => {
  const d = T.analyse(reentrantDeadlock).dumps[0];
  assert.strictEqual(d.jvmDeadlocks.length, 0);
  assert.strictEqual(d.cycles.length, 1);
  assert.strictEqual(d.cycles[0].length, 2);
});

test('two JVM deadlock sections are both captured', () => {
  const two = monitorDeadlock.replace('Found 1 deadlock.', '') + monitorDeadlock.slice(monitorDeadlock.indexOf('Found one Java-level')).replace('Found 1 deadlock.', 'Found 2 deadlocks.');
  const d = T.analyse(two).dumps[0];
  assert.strictEqual(d.jvmDeadlocks.length, 2);
});

test('no cycle when nobody waits', () => {
  const d = T.analyse(poolDump('2026-11-06 10:00:00', 3, 'com.example.X.y(X.java:1)')).dumps[0];
  assert.strictEqual(d.cycles.length, 0);
});

test('Object.wait() monitor is not counted as held', () => {
  const d = T.analyse(waitNotHold).dumps[0];
  const L = d.locks.find((l) => l.addr === '0x00000000000000d1');
  assert.strictEqual(L.holders.length, 0);
  assert.strictEqual(L.waiters.length, 1);
  assert.strictEqual(L.waitingOn.length, 1);
  assert.strictEqual(d.cycles.length, 0);
});

test('groups identical stacks and sorts by size', () => {
  const d = T.analyse(poolDump('2026-11-06 10:00:00', 180, 'com.example.X.y(X.java:1)')).dumps[0];
  assert.strictEqual(d.groups[0].threads.length, 180);
  assert.strictEqual(d.groups[0].state, 'TIMED_WAITING');
  assert.strictEqual(d.groups.length, 2);
});

test('pool exhaustion hint for HikariCP waiters (and classified active, not idle)', () => {
  const d = T.analyse(poolDump('2026-11-06 10:00:00', 50, 'com.example.X.y(X.java:1)')).dumps[0];
  const h = d.hints.find((x) => /HikariCP exhaustion/.test(x.title));
  assert.ok(h, 'expected a HikariCP hint');
  assert.strictEqual(h.level, 'bad');
  assert.ok(/^Likely/.test(h.title), 'hints are hedged');
  assert.strictEqual(d.threads[0].cls, 'active');
});

test('pool names strip trailing numbers', () => {
  assert.strictEqual(T.poolName('http-nio-8080-exec-12'), 'http-nio-8080-exec-#');
  assert.strictEqual(T.poolName('GC Thread#3'), 'GC Thread#');
  assert.strictEqual(T.poolName('main'), 'main');
});

test('splits several dumps in one paste', () => {
  const txt = poolDump('2026-11-06 10:00:00', 5, 'a.B.c(B.java:1)') + '\n' + poolDump('2026-11-06 10:00:07', 5, 'a.B.c(B.java:1)') + '\n' + poolDump('2026-11-06 10:00:14', 5, 'a.B.c(B.java:2)');
  const r = T.analyse(txt);
  assert.strictEqual(r.dumps.length, 3);
  assert.deepStrictEqual(r.dumps.map((d) => d.ts), ['2026-11-06 10:00:00', '2026-11-06 10:00:07', '2026-11-06 10:00:14']);
});

test('multi-dump: same frames in all dumps = stuck; changing frames = moving', () => {
  const r = T.analyse([poolDump('2026-11-06 10:00:00', 5, 'a.B.c(B.java:1)'), poolDump('2026-11-06 10:00:07', 5, 'a.B.c(B.java:1)'), poolDump('2026-11-06 10:00:14', 5, 'a.B.d(B.java:9)')]);
  const c = r.compare;
  assert.ok(c);
  const byName = new Map(c.rows.map((x) => [x.name, x]));
  assert.strictEqual(byName.get('http-nio-8080-exec-1').verdict, 'stuck');
  assert.strictEqual(byName.get('report-1').verdict, 'moving');
  assert.strictEqual(c.counts.stuck, 5);
  assert.strictEqual(c.stuckGroups[0].rows.length, 5);
  assert.ok(c.hints.some((h) => /same place in all 3 dumps/.test(h.title)));
});

test('single dump has no comparison', () => {
  assert.strictEqual(T.analyse(waitNotHold).compare, null);
});

test('slow downstream hint from socket reads in a JDBC driver', () => {
  let s = header('2026-11-06 10:00:00');
  for (let i = 0; i < 8; i++) {
    s += thr(`exec-${i}`, 10 + i, 'RUNNABLE', 'runnable', '\tat java.net.SocketInputStream.socketRead0(java.base@11/Native Method)\n\tat java.net.SocketInputStream.read(java.base@11/SocketInputStream.java:168)\n\tat org.postgresql.core.PGStream.receiveChar(PGStream.java:465)\n\tat com.example.Repo.q(Repo.java:3)');
  }
  const d = T.analyse(s).dumps[0];
  const h = d.hints.find((x) => /network read/.test(x.title));
  assert.ok(h);
  assert.ok(/8 in a JDBC driver/.test(h.text));
});

test('logging contention hint', () => {
  let s = header('2026-11-06 10:00:00');
  for (let i = 0; i < 6; i++) {
    s += thr(`exec-${i}`, 10 + i, 'BLOCKED (on object monitor)', 'waiting for monitor entry', '\tat org.apache.log4j.Category.callAppenders(Category.java:204)\n\t- waiting to lock <0x00000000000000f1> (a org.apache.log4j.spi.RootLogger)\n\tat com.example.Svc.run(Svc.java:3)');
  }
  const d = T.analyse(s).dumps[0];
  assert.ok(d.hints.some((x) => /logging framework/.test(x.title)));
  assert.strictEqual(d.contended[0].waiters.length, 6);
});

test('GC/VM threads without stacks are parsed and categorised', () => {
  const s = header('2026-11-06 10:00:00') + '"GC Thread#0" os_prio=0 cpu=9000.00ms elapsed=100.00s tid=0x00007f0000000001 nid=0x10 runnable  \n\n"VM Thread" os_prio=0 cpu=50.00ms elapsed=100.00s tid=0x00007f0000000002 nid=0x11 runnable  \n' +
    thr('app', 5, 'RUNNABLE', 'runnable', '\tat com.example.A.b(A.java:1)');
  const d = T.analyse(s).dumps[0];
  assert.strictEqual(d.threads.length, 3);
  assert.strictEqual(d.threads[0].cat, 'gc');
  assert.strictEqual(d.threads[0].state, 'RUNNABLE');
  assert.ok(d.hints.some((x) => /GC threads used/.test(x.title)));
});

test('JDK 21 header with [os id] and virtual-thread carrier line', () => {
  const s = header('2026-11-06 10:00:00') + '"ForkJoinPool-1-worker-1" #25 [12345] daemon prio=5 os_prio=31 cpu=5.00ms elapsed=3.00s tid=0x0000000130000000 nid=12345 waiting on condition  [0x000000016f000000]\n   java.lang.Thread.State: WAITING (parking)\n\tat jdk.internal.misc.Unsafe.park(java.base@21/Native Method)\n\tat java.lang.VirtualThread.parkOnCarrierThread(java.base@21/VirtualThread.java:661)\n   Carrying virtual thread #31\n';
  const t = T.analyse(s).dumps[0].threads[0];
  assert.strictEqual(t.num, 25);
  assert.strictEqual(t.nid, '12345');
  assert.strictEqual(t.daemon, true);
  assert.strictEqual(t.carrying, 31);
});

test('jcmd Thread.dump_to_file JSON with virtual threads', () => {
  const j = JSON.stringify({ threadDump: { processId: '1', time: '2026-11-06T10:00:00Z', runtimeVersion: '21.0.5', threadContainers: [
    { container: '<root>', parent: null, owner: null, threads: [{ tid: '1', name: 'main', stack: ['java.base/java.lang.Thread.sleep(Thread.java:509)', 'com.example.Main.main(Main.java:3)'] }], threadCount: '1' },
    { container: 'java.util.concurrent.ThreadPerTaskExecutor@1', parent: '<root>', owner: null, threads: [
      { tid: '30', name: '', stack: ['java.base/java.lang.VirtualThread.park(VirtualThread.java:582)', 'com.example.Job.run(Job.java:9)'] },
      { tid: '31', name: '', stack: ['java.base/java.lang.VirtualThread.park(VirtualThread.java:582)', 'com.example.Job.run(Job.java:9)'] }], threadCount: '2' }] } });
  const d = T.analyse(j).dumps[0];
  assert.strictEqual(d.threads.length, 3);
  assert.strictEqual(d.virtualCount, 2);
  assert.strictEqual(d.threads[0].state, 'TIMED_WAITING');
  assert.strictEqual(d.groups[0].threads.length, 2);
});

test('OpenJ9 javacore best effort with owner synthesis', () => {
  const jc = `0SECTION       THREADS subcomponent dump routine
1TIDATETIME    Date: 2026/11/06 at 10:00:00:123
3XMTHREADINFO      "worker-1" J9VMThread:0x0000000000AA0100, omrthread_t:0x1, java/lang/Thread:0x2, state:B, prio=5
3XMJAVALTHREAD            (java/lang/Thread getId:0x10, isDaemon:false)
3XMTHREADBLOCK     Blocked on: java/lang/Object@0x00000000E0001000 Owned by: "worker-2" (J9VMThread:0x0000000000AA0200, java/lang/Thread:0x3)
4XESTACKTRACE                at com/example/A.b(A.java:5)
3XMTHREADINFO      "worker-2" J9VMThread:0x0000000000AA0200, omrthread_t:0x4, java/lang/Thread:0x3, state:R, prio=5
4XESTACKTRACE                at com/example/A.c(A.java:9)
`;
  const d = T.analyse(jc).dumps[0];
  assert.strictEqual(d.threads.length, 2);
  assert.strictEqual(d.threads[0].state, 'BLOCKED');
  assert.strictEqual(d.threads[0].frames[0], 'com.example.A.b(A.java:5)');
  assert.strictEqual(d.contended[0].holders[0].t.name, 'worker-2');
});

test('rejects non-dumps with a helpful message', () => {
  assert.throws(() => T.analyse('just some text'), /doesn't look like a Java thread dump/);
  assert.throws(() => T.analyse('   '), /Paste a thread dump/);
});

test('built-in samples analyse with the expected findings', () => {
  const r = T.analyse(T.sample());
  assert.strictEqual(r.dumps.length, 3);
  assert.ok(r.dumps[0].hints.some((h) => /HikariCP/.test(h.title)));
  assert.ok(r.compare.counts.stuck > 50);
  const d = T.analyse(T.sample('deadlock')).dumps[0];
  assert.strictEqual(d.jvmDeadlocks.length, 1);
  assert.strictEqual(d.cycles.length, 1);
  assert.ok(d.hints.some((h) => /Hot lock/.test(h.title)));
});

test('2,000-thread dump x3 parses in well under 2 s', () => {
  const big = [0, 1, 2].map((n) => T.sampleDump({ n, seed: n + 1, execThreads: 2000, poolWaiters: 1500, dbReaders: 200, ts: `2026-11-06 10:00:0${n * 3}` })).join('\n');
  const t0 = Date.now();
  const r = T.analyse(big);
  const ms = Date.now() - t0;
  assert.strictEqual(r.dumps.length, 3);
  assert.ok(r.dumps[0].threads.length > 2000);
  assert.ok(ms < 2000, `took ${ms} ms`);
  console.log(`       (3 x ${r.dumps[0].threads.length} threads in ${ms} ms)`);
});

test('long wait chain (no cycle) does not blow the stack', () => {
  let s = header('2026-11-06 10:00:00');
  const N = 3000;
  for (let i = 0; i < N; i++) {
    const own = (0x1000 + i).toString(16), want = (0x1000 + i + 1).toString(16);
    s += thr(`chain-${i}`, i + 1, i === N - 1 ? 'RUNNABLE' : 'BLOCKED (on object monitor)', 'waiting for monitor entry',
      `\tat com.example.C.m(C.java:1)\n${i === N - 1 ? '' : `\t- waiting to lock <0x${want}> (a java.lang.Object)\n`}\t- locked <0x${own}> (a java.lang.Object)`);
  }
  const d = T.analyse(s).dumps[0];
  assert.strictEqual(d.cycles.length, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
