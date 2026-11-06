// Tests for docs/tools/gc-log/gclog.js. Run: node toolkit-tests/test-gclog.js
'use strict';
const path = require('path');
const assert = require('assert');
const G = require(path.join(__dirname, '..', 'docs', 'tools', 'gc-log', 'gclog.js'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e)); }
}
const near = (a, b, eps) => assert.ok(Math.abs(a - b) <= (eps || 1e-9), `expected ${b}, got ${a}`);

// ---------------------------------------------------------------- fixtures

const g1 = `[2026-11-06T10:00:00.010+1100][0.010s][info][gc,init] Version: 17.0.12+7 (release)
[2026-11-06T10:00:00.010+1100][0.010s][info][gc     ] Using G1
[2026-11-06T10:00:00.011+1100][0.011s][info][gc,init] Heap Max Capacity: 2G
[2026-11-06T10:00:10.000+1100][10.000s][info][gc,start] GC(0) Pause Young (Normal) (G1 Evacuation Pause)
[2026-11-06T10:00:10.010+1100][10.010s][info][gc,heap ] GC(0) Eden regions: 25->0(23)
[2026-11-06T10:00:10.010+1100][10.010s][info][gc      ] GC(0) Pause Young (Normal) (G1 Evacuation Pause) 300M->100M(1024M) 10.000ms
[2026-11-06T10:00:10.010+1100][10.010s][info][gc,cpu  ] GC(0) User=0.03s Sys=0.00s Real=0.01s
[2026-11-06T10:00:20.000+1100][20.000s][info][gc      ] GC(1) Pause Young (Concurrent Start) (G1 Humongous Allocation) 400M->120M(1024M) 20.000ms
[2026-11-06T10:00:20.100+1100][20.100s][info][gc      ] GC(1) Concurrent Mark Cycle
[2026-11-06T10:00:20.500+1100][20.500s][info][gc      ] GC(1) Pause Remark 130M->125M(1024M) 5.000ms
[2026-11-06T10:00:20.700+1100][20.700s][info][gc      ] GC(1) Pause Cleanup 125M->125M(1024M) 1.000ms
[2026-11-06T10:00:20.800+1100][20.800s][info][gc      ] GC(1) Concurrent Mark Cycle 700.000ms
[2026-11-06T10:00:30.000+1100][30.000s][info][gc      ] GC(2) Pause Young (Prepare Mixed) (G1 Evacuation Pause) 420M->130M(1024M) 30.000ms
[2026-11-06T10:00:40.000+1100][40.000s][info][gc      ] GC(3) Pause Young (Mixed) (G1 Evacuation Pause) 430M->110M(1024M) 40.000ms
[2026-11-06T10:00:50.000+1100][50.000s][info][gc      ] GC(4) To-space exhausted
[2026-11-06T10:00:50.000+1100][50.000s][info][gc      ] GC(4) Pause Full (Metadata GC Threshold) 500M->90M(1024M) 400.000ms
[2026-11-06T10:01:00.000+1100][60.000s][info][gc      ] GC(5) Pause Full (System.gc()) 200M->80M(1024M) 300.000ms
[2026-11-06T10:01:40.000+1100][100.000s][info][gc      ] GC(6) Pause Young (Normal) (G1 Evacuation Pause) 380M->85M(1024M) 4.000ms
`;

const zgcLegacy = `[0.010s][info][gc,init] Using The Z Garbage Collector
[1.000s][info][gc,start    ] GC(0) Garbage Collection (Warmup)
[1.001s][info][gc,phases   ] GC(0) Pause Mark Start 0.012ms
[1.050s][info][gc,phases   ] GC(0) Concurrent Mark 48.000ms
[1.051s][info][gc,phases   ] GC(0) Pause Mark End 0.030ms
[1.060s][info][gc,phases   ] GC(0) Pause Relocate Start 0.020ms
[1.070s][info][gc,stats    ] GC(0)    Phase: Pause Mark End     0.030 / 0.030   0.030 / 0.030 ms
[1.100s][info][gc          ] GC(0) Garbage Collection (Warmup) 210M(10%)->56M(3%)
[3.000s][info][gc          ] Allocation Stall (http-nio-8080-exec-7) 12.500ms
[3.500s][info][gc,phases   ] GC(1) Pause Mark Start 0.010ms
[3.540s][info][gc,phases   ] GC(1) Pause Mark End 0.040ms
[3.550s][info][gc,phases   ] GC(1) Pause Relocate Start 0.010ms
[3.600s][info][gc          ] GC(1) Garbage Collection (Allocation Rate) 1500M(73%)->300M(15%)
`;

const zgcGen = `[0.010s][info][gc,init] Using The Z Garbage Collector
[1.000s][info][gc,phases   ] GC(3) Y: Pause Mark Start (Major) 0.011ms
[1.010s][info][gc,phases   ] GC(3) Y: Pause Mark End 0.009ms
[1.020s][info][gc,phases   ] GC(3) O: Pause Mark End 0.008ms
[1.100s][info][gc          ] GC(3) Major Collection (Proactive) 812M(40%)->304M(15%) 0.046s
`;

const shenandoah = `[0.010s][info][gc] Using Shenandoah
[1.000s][info][gc] Trigger: Free (102M) is below minimum threshold (102M)
[1.001s][info][gc,start] GC(0) Pause Init Mark (unload classes)
[1.002s][info][gc] GC(0) Pause Init Mark (unload classes) 0.345ms
[1.100s][info][gc] GC(0) Concurrent marking (unload classes) 64M->66M(1024M) 64.123ms
[1.101s][info][gc] GC(0) Pause Final Mark (unload classes) 0.456ms
[1.200s][info][gc] GC(0) Concurrent cleanup 66M->60M(1024M) 0.123ms
[1.300s][info][gc] GC(0) Pause Final Update Refs 0.200ms
[5.000s][info][gc] GC(1) Pause Degenerated GC (Mark) 900M->300M(1024M) 34.123ms
`;

const parallel = `[0.005s][info][gc] Using Parallel
[2.000s][info][gc] GC(0) Pause Young (Allocation Failure) 65M->12M(245M) 8.123ms
[4.000s][info][gc] GC(1) Pause Full (Ergonomics) 200M->150M(245M) 210.500ms
`;

const jdk8parallel = `2026-11-06T10:00:01.234+1100: 1.234: [GC (Allocation Failure) [PSYoungGen: 65536K->10720K(76288K)] 65536K->10728K(251392K), 0.0123456 secs] [Times: user=0.03 sys=0.01, real=0.01 secs]
2026-11-06T10:00:05.000+1100: 5.000: [Full GC (Ergonomics) [PSYoungGen: 10720K->0K(76288K)] [ParOldGen: 160000K->90000K(175104K)] 170720K->90000K(251392K), [Metaspace: 30000K->30000K(1077248K)], 0.2345678 secs] [Times: user=0.50 sys=0.01, real=0.23 secs]
2026-11-06T10:00:09.000+1100: 9.000: [Full GC (System.gc()) [PSYoungGen: 1000K->0K(76288K)] [ParOldGen: 90000K->80000K(175104K)] 91000K->80000K(251392K), [Metaspace: 30000K->30000K(1077248K)], 0.1000000 secs] [Times: user=0.20 sys=0.00, real=0.10 secs]
`;

const jdk8g1 = `1.500: [GC pause (G1 Evacuation Pause) (young), 0.0150000 secs]
   [Parallel Time: 14.1 ms, GC Workers: 4]
   [Eden: 24.0M(24.0M)->0.0B(20.0M) Survivors: 0.0B->3072.0K Heap: 24.0M(256.0M)->4.5M(256.0M)]
 [Times: user=0.05 sys=0.00, real=0.02 secs]
3.000: [GC remark 3.000: [Finalize Marking, 0.0001 secs] 3.001: [GC ref-proc, 0.0002 secs] 3.002: [Unloading, 0.0010 secs], 0.0034567 secs]
4.000: [GC cleanup 100M->90M(256M), 0.0012000 secs]
6.000: [Full GC (Allocation Failure)  250M->200M(256M), 1.2345678 secs]
`;

// ---------------------------------------------------------------- tests

test('detects formats', () => {
  assert.strictEqual(G.detect(g1), 'unified');
  assert.strictEqual(G.detect(zgcLegacy), 'unified');
  assert.strictEqual(G.detect(jdk8parallel), 'jdk8');
  assert.strictEqual(G.detect('hello'), null);
});

test('size units', () => {
  near(G.toMB('512K'), 0.5); near(G.toMB('2G'), 2048); near(G.toMB('25M'), 25); near(G.toMB('0.0B'), 0);
});

test('decorators: time, uptime, level, tags', () => {
  const d = G.decorators('[2026-11-06T10:00:10.000+1100][10.000s][info][gc,start    ] GC(0) Pause Young');
  assert.strictEqual(d.up, 10); assert.strictEqual(d.level, 'info'); assert.strictEqual(d.tags, 'gc,start'); assert.strictEqual(d.rest, 'GC(0) Pause Young');
  assert.strictEqual(G.decorators('[1234ms][info][gc] x').up, 1.234);
});

test('pause name classification', () => {
  assert.deepStrictEqual(G.classifyPause('Young (Normal) (G1 Evacuation Pause)').kind, 'young');
  assert.strictEqual(G.classifyPause('Young (Mixed) (G1 Evacuation Pause)').kind, 'mixed');
  const c = G.classifyPause('Young (Concurrent Start) (G1 Humongous Allocation)');
  assert.strictEqual(c.sub, 'Concurrent Start'); assert.strictEqual(c.cause, 'G1 Humongous Allocation');
  assert.strictEqual(G.classifyPause('Full (System.gc())').cause, 'System.gc()');
  assert.strictEqual(G.classifyPause('Remark').kind, 'remark');
  assert.strictEqual(G.classifyPause('Degenerated GC (Mark)').kind, 'degenerated');
});

test('G1 unified: counts, kinds, causes, heap, stats', () => {
  const s = G.analyse(g1);
  assert.strictEqual(s.collector, 'G1');
  assert.strictEqual(s.jdk, '17.0.12+7');
  assert.strictEqual(s.maxHeapMB, 2048);
  assert.strictEqual(s.count, 9);
  assert.strictEqual(s.byKind.young.count, 4);
  assert.strictEqual(s.byKind.mixed.count, 1);
  assert.strictEqual(s.byKind.remark.count, 1);
  assert.strictEqual(s.byKind.cleanup.count, 1);
  assert.strictEqual(s.byKind.full.count, 2);
  assert.deepStrictEqual(s.fullCauses, { 'Metadata GC Threshold': 1, 'System.gc()': 1 });
  near(s.totalMs, 10 + 20 + 5 + 1 + 30 + 40 + 400 + 300 + 4);
  near(s.max, 400);
  near(s.p50, 20);
  near(s.span, 100 - 0.01, 1e-6);
  near(s.throughput, 1 - 0.81 / 99.99, 1e-9);
  assert.strictEqual(s.evacFailures, 1);
  assert.strictEqual(s.humongousPauses, 1);
  assert.strictEqual(s.longest[0].ms, 400);
  const p0 = s.pauses[0];
  assert.strictEqual(p0.before, 300); assert.strictEqual(p0.after, 100); assert.strictEqual(p0.cap, 1024);
});

test('G1 findings mention Metaspace and System.gc() with hedged advice', () => {
  const s = G.analyse(g1);
  const meta = s.findings.find((f) => /Metadata GC Threshold/.test(f.title));
  assert.ok(meta && /MaxMetaspaceSize/.test(meta.text));
  const sys = s.findings.find((f) => /System\.gc\(\)/.test(f.title));
  assert.ok(sys && /DisableExplicitGC/.test(sys.text));
  assert.ok(s.findings.some((f) => /evacuation failure/.test(f.title)));
  assert.ok(s.findings.some((f) => /too short to judge a leak/.test(f.title)));
});

test('allocation rate from before(i+1) - after(i)', () => {
  const s = G.analyse(parallel);
  // one interval: 200 - 12 = 188 MB over 2 s
  near(s.allocRate, 94, 1e-6);
});

test('percentiles use nearest rank', () => {
  const xs = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.strictEqual(G.percentile(xs, 50), 50);
  assert.strictEqual(G.percentile(xs, 95), 95);
  assert.strictEqual(G.percentile(xs, 99), 99);
  assert.strictEqual(G.percentile([7], 99), 7);
});

test('ZGC (non-generational): sub-ms pauses, cycles, allocation stall', () => {
  const s = G.analyse(zgcLegacy);
  assert.strictEqual(s.collector, 'ZGC');
  assert.strictEqual(s.count, 6, 'stats table lines must not be counted');
  near(s.max, 0.04);
  assert.strictEqual(s.cycles.length, 2);
  assert.strictEqual(s.cycles[0].cause, 'Warmup');
  near(s.cycles[1].cap, 1500 / 0.73, 1e-6);
  assert.strictEqual(s.stalls.length, 1);
  assert.ok(s.findings.some((f) => /allocation stall/.test(f.title)));
  assert.ok(s.heap.length === 2);
});

test('generational ZGC: Y:/O: pause prefixes and Major Collection cycle', () => {
  const s = G.analyse(zgcGen);
  assert.strictEqual(s.count, 3);
  assert.ok(s.pauses.some((p) => p.label === 'O: Mark End'));
  assert.strictEqual(s.cycles[0].type, 'Major Collection');
  near(s.cycles[0].ms, 46);
});

test('Shenandoah: pauses, degenerated GC, concurrent heap', () => {
  const s = G.analyse(shenandoah);
  assert.strictEqual(s.collector, 'Shenandoah');
  assert.strictEqual(s.count, 4);
  assert.strictEqual(s.byKind.degenerated.count, 1);
  assert.ok(s.findings.some((f) => /degenerated/.test(f.title)));
});

test('Parallel unified: Full GC Ergonomics', () => {
  const s = G.analyse(parallel);
  assert.strictEqual(s.collector, 'Parallel');
  assert.deepStrictEqual(s.fullCauses, { Ergonomics: 1 });
});

test('JDK 8 Parallel PrintGCDetails (best effort)', () => {
  const s = G.analyse(jdk8parallel);
  assert.ok(/JDK 8/.test(s.format));
  assert.strictEqual(s.collector, 'Parallel');
  assert.strictEqual(s.count, 3);
  near(s.pauses[0].ms, 12.3456, 1e-9);
  near(s.pauses[0].before, 64); near(s.pauses[0].after, 10728 / 1024, 1e-9); near(s.pauses[0].cap, 251392 / 1024, 1e-9);
  assert.deepStrictEqual(s.fullCauses, { Ergonomics: 1, 'System.gc()': 1 });
  near(s.pauses[1].after, 90000 / 1024, 1e-9);
});

test('JDK 8 G1 with detail lines', () => {
  const s = G.analyse(jdk8g1);
  assert.strictEqual(s.collector, 'G1');
  assert.strictEqual(s.count, 4);
  assert.strictEqual(s.pauses[0].kind, 'young');
  near(s.pauses[0].before, 24); near(s.pauses[0].after, 4.5); near(s.pauses[0].cap, 256);
  assert.strictEqual(s.pauses[1].kind, 'remark');
  near(s.pauses[1].ms, 3.4567, 1e-9);
  assert.strictEqual(s.pauses[2].kind, 'cleanup');
  assert.strictEqual(s.pauses[3].kind, 'full');
  assert.strictEqual(s.pauses[3].cause, 'Allocation Failure');
});

test('rejects non-GC text and logs without pauses', () => {
  assert.throws(() => G.analyse('hello'), /doesn't look like a GC log/);
  assert.throws(() => G.analyse('[0.01s][info][gc] Using G1\n'), /No GC pauses found/);
});

test('G1 sample shows a leak trend, Full GCs and throughput', () => {
  const s = G.analyse(G.sample('g1'));
  assert.strictEqual(s.collector, 'G1');
  assert.ok(s.count > 500);
  assert.ok(s.fulls.length >= 2);
  assert.ok(s.findings.some((f) => /Heap after GC keeps rising/.test(f.title)));
  assert.ok(s.throughput > 0.9 && s.throughput < 1);
  assert.ok(s.allocRate > 50);
});

test('flat heap does not raise a leak finding', () => {
  const s = G.analyse(G.sampleG1({ leak: false, minutes: 20 }));
  assert.ok(!s.findings.some((f) => /keeps rising/.test(f.title)));
  assert.ok(s.findings.some((f) => /Heap after GC is flat/.test(f.title)));
});

test('ZGC sample parses', () => {
  const s = G.analyse(G.sample('zgc'));
  assert.strictEqual(s.collector, 'ZGC');
  assert.ok(s.cycles.length === 160);
  assert.ok(s.stalls.length >= 1);
});

test('100k-line log parses in under 2 s', () => {
  let txt = '';
  const parts = [];
  let t = 1;
  for (let i = 0; i < 20000; i++) {
    t += 0.5;
    parts.push(`[${t.toFixed(3)}s][info][gc,start    ] GC(${i}) Pause Young (Normal) (G1 Evacuation Pause)`);
    parts.push(`[${t.toFixed(3)}s][info][gc,heap     ] GC(${i}) Eden regions: 300->0(300)`);
    parts.push(`[${t.toFixed(3)}s][info][gc,heap     ] GC(${i}) Old regions: 100->101`);
    parts.push(`[${(t + 0.01).toFixed(3)}s][info][gc          ] GC(${i}) Pause Young (Normal) (G1 Evacuation Pause) ${700 + (i % 50)}M->${200 + (i % 7)}M(2048M) ${(5 + (i % 13)).toFixed(3)}ms`);
    parts.push(`[${(t + 0.01).toFixed(3)}s][info][gc,cpu      ] GC(${i}) User=0.02s Sys=0.00s Real=0.01s`);
  }
  txt = parts.join('\n');
  const t0 = Date.now();
  const s = G.analyse(txt);
  const ms = Date.now() - t0;
  assert.strictEqual(s.count, 20000);
  assert.ok(ms < 2000, `took ${ms} ms`);
  console.log(`       (${parts.length.toLocaleString()} lines in ${ms} ms)`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
