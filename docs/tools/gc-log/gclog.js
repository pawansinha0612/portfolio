/* JVM GC log analyser: pure parsing + statistics, no DOM.
   Works in the browser (window.GCLog) and in Node (module.exports).
   Formats: JDK 9+ unified logging (-Xlog:gc*) for G1, Parallel, Serial, ZGC (incl. generational) and Shenandoah;
   JDK 8 -XX:+PrintGCDetails (Parallel, CMS, G1) best effort. */
(function (root) {
  'use strict';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // "25M", "1.5G", "512K", "0.0B", "1024" (bytes) -> MB
  function toMB(s) {
    const m = /^([\d.]+)\s*([KMGT]?)B?$/i.exec(String(s).trim());
    if (!m) return null;
    const v = parseFloat(m[1]);
    switch (m[2].toUpperCase()) {
      case 'K': return v / 1024;
      case 'M': return v;
      case 'G': return v * 1024;
      case 'T': return v * 1024 * 1024;
      default: return v / (1024 * 1024);
    }
  }

  const ISO_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2}):?(\d{2})?$|^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)Z?$/;
  function isoToMs(s) {
    const m = ISO_RE.exec(s);
    if (!m) return null;
    const str = m[1] ? `${m[1]}${m[2]}:${m[3] || '00'}` : `${m[4]}Z`;
    const v = Date.parse(str);
    return isNaN(v) ? null : v;
  }

  // Parse leading [decorator][decorator]... of a unified-logging line
  function decorators(line) {
    const d = { up: null, wall: null, level: null, tags: '', rest: line };
    let i = 0;
    while (line[i] === '[') {
      const j = line.indexOf(']', i);
      if (j < 0) break;
      const v = line.slice(i + 1, j).trim();
      let m;
      if ((m = /^(\d+(?:[.,]\d+)?)s$/.exec(v))) d.up = parseFloat(m[1].replace(',', '.'));
      else if ((m = /^(\d+)ms$/.exec(v))) d.up = +m[1] / 1000;
      else if ((m = /^(\d+)ns$/.exec(v))) d.up = +m[1] / 1e9;
      else if (/^\d{4}-\d{2}-\d{2}T/.test(v)) d.wall = isoToMs(v);
      else if (/^(trace|debug|info|warning|error)$/.test(v)) d.level = v;
      else if (/^[a-z][a-z0-9_,]*$/i.test(v.replace(/\s+/g, '')) && !/^\d/.test(v)) d.tags = v.replace(/\s+/g, '');
      i = j + 1;
    }
    d.rest = line.slice(i).trim();
    return d;
  }

  // "Young (Normal) (G1 Evacuation Pause)" -> { base: 'Young', groups: ['Normal', 'G1 Evacuation Pause'] }
  function splitName(name) {
    const groups = [];
    let base = '', depth = 0, cur = '';
    for (const ch of name) {
      if (ch === '(') { if (depth > 0) cur += ch; depth++; continue; }
      if (ch === ')') { depth--; if (depth > 0) cur += ch; else { groups.push(cur.trim()); cur = ''; } continue; }
      if (depth > 0) cur += ch; else if (!groups.length) base += ch;
    }
    return { base: base.trim(), groups };
  }

  const G1_YOUNG_TYPES = ['Normal', 'Concurrent Start', 'Prepare Mixed', 'Mixed'];
  function classifyPause(label) {
    const { base, groups } = splitName(label);
    let kind = 'other', sub = '', cause = '';
    const restGroups = groups.filter((g) => !/^(Evacuation Failure|Major|Minor|unload classes|update refs)$/i.test(g));
    if (/^Full\b/i.test(base) || /^Full GC/i.test(base)) { kind = 'full'; cause = restGroups.join(' ') || 'unspecified'; }
    else if (/^Degenerated/i.test(base)) { kind = 'degenerated'; cause = restGroups.join(' '); }
    else if (/^Young\b/i.test(base)) {
      sub = restGroups.find((g) => G1_YOUNG_TYPES.includes(g)) || '';
      kind = sub === 'Mixed' ? 'mixed' : 'young';
      cause = restGroups.filter((g) => !G1_YOUNG_TYPES.includes(g)).join(' ');
    } else if (/^Remark\b/i.test(base)) kind = 'remark';
    else if (/^Cleanup\b/i.test(base)) kind = 'cleanup';
    else cause = restGroups.join(' ');
    return { kind, sub, cause, base };
  }

  // ---------- unified logging (JDK 9+) ----------
  const SZ = '(\\d+(?:\\.\\d+)?[KMGT]?B?)';
  const PAUSE_RE = new RegExp(`^GC\\((\\d+)\\)\\s+(?:([YO]):\\s+)?Pause\\s+(.+?)\\s+(?:${SZ}->${SZ}\\(${SZ}\\)\\s+)?(\\d+(?:\\.\\d+)?)(ms|s)\\s*$`);
  const ZCYCLE_RE = /^GC\((\d+)\)\s+(Garbage Collection|Major Collection|Minor Collection)\s+\((.+?)\)\s+(\d+(?:\.\d+)?)M\((\d+)%\)->(\d+(?:\.\d+)?)M\((\d+)%\)(?:\s+([\d.]+)(ms|s))?/;
  const CONC_HEAP_RE = new RegExp(`^GC\\((\\d+)\\)\\s+(Concurrent [^\\d]+?)\\s+${SZ}->${SZ}\\(${SZ}\\)\\s+(\\d+(?:\\.\\d+)?)(ms|s)\\s*$`);
  const CPU_RE = /^GC\((\d+)\)\s+User=([\d.]+)s\s+Sys=([\d.]+)s\s+Real=([\d.]+)s/;
  const STALL_RE = /Allocation Stall \((.*?)\)\s+([\d.]+)ms/;

  function parseUnified(lines) {
    const r = newResult('unified');
    let firstWall = null;
    const seen = new Set();
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      if (!line || line[0] !== '[') { if (line && /GC\(\d+\)/.test(line)) parseUnifiedContent(r, { up: null, wall: null, rest: line.trim(), tags: '' }, seen, li); continue; }
      const d = decorators(line);
      if (d.wall != null && firstWall == null) firstWall = d.wall;
      if (d.up == null && d.wall != null) d.up = (d.wall - firstWall) / 1000;
      if (d.up != null) { if (r.firstT == null) r.firstT = d.up; r.lastT = d.up; }
      if (d.wall != null) { if (r.firstWall == null) r.firstWall = d.wall; }
      parseUnifiedContent(r, d, seen, li);
    }
    return r;
  }

  function parseUnifiedContent(r, d, seen, li) {
    const c = d.rest;
    let m;
    if ((m = /^Using (G1|Parallel|Serial|The Z Garbage Collector|Shenandoah|Concurrent Mark Sweep|Epsilon)/.exec(c))) { r.collector = m[1] === 'The Z Garbage Collector' ? 'ZGC' : m[1]; return; }
    if ((m = /^Version: (\S+)/.exec(c))) { r.jdk = m[1]; return; }
    if ((m = /^Heap Max Capacity: (\S+)/.exec(c)) || (m = /^Heap Max Capacity:\s*(\S+)/.exec(c))) { r.maxHeapMB = toMB(m[1]); return; }
    if ((m = /^Heap Region Size: (\S+)/.exec(c))) { r.regionSize = m[1]; return; }
    if ((m = /^Initial Capacity: (\S+)|^Min Capacity: (\S+)|^Max Capacity: (\S+)/.exec(c)) && m[3]) { r.maxHeapMB = toMB(m[3]); return; }
    if ((m = PAUSE_RE.exec(c))) {
      const ms = m[8] === 's' ? parseFloat(m[7]) * 1000 : parseFloat(m[7]);
      const label = (m[2] ? m[2] + ': ' : '') + m[3];
      const key = m[1] + '|' + label + '|' + m[7];
      if (seen.has(key)) return;
      seen.add(key);
      const cl = classifyPause(m[3]);
      const p = { gcId: +m[1], t: d.up, ms, label, kind: cl.kind, sub: cl.sub, cause: cl.cause, before: m[4] ? toMB(m[4]) : null, after: m[5] ? toMB(m[5]) : null, cap: m[6] ? toMB(m[6]) : null, line: li };
      if (/Evacuation Failure/i.test(m[3])) r.evacFailures++;
      if (/Humongous/i.test(m[3])) r.humongousPauses++;
      r.pauses.push(p);
      return;
    }
    if ((m = ZCYCLE_RE.exec(c))) {
      const before = +m[4], after = +m[6];
      const cap = +m[5] > 0 ? before / (+m[5] / 100) : null;
      r.cycles.push({ gcId: +m[1], t: d.up, type: m[2], cause: m[3], before, after, cap, ms: m[8] ? (m[9] === 's' ? +m[8] * 1000 : +m[8]) : null });
      return;
    }
    if ((m = CONC_HEAP_RE.exec(c))) {
      r.concHeap.push({ gcId: +m[1], t: d.up, name: m[2], before: toMB(m[3]), after: toMB(m[4]), cap: toMB(m[5]) });
      return;
    }
    if ((m = /^GC\((\d+)\)\s+Concurrent (Mark|Undo) Cycle\s+([\d.]+)ms/.exec(c))) { r.concCycles.push({ gcId: +m[1], t: d.up, ms: +m[3], type: m[2] }); return; }
    if ((m = CPU_RE.exec(c))) { r.cpu.push({ gcId: +m[1], user: +m[2], sys: +m[3], real: +m[4] }); return; }
    if ((m = STALL_RE.exec(c))) { r.stalls.push({ t: d.up, thread: m[1], ms: +m[2] }); return; }
    if (/To-space exhausted/i.test(c)) { r.evacFailures++; return; }
    if (/Cancelling GC: (Allocation Failure|Stopping VM)/.test(c)) { r.shenCancels++; return; }
    if ((m = /^GC\((\d+)\)\s+Metaspace:\s+(\S+?)(?:\((\S+)\))?->(\S+?)\((\S+)\)/.exec(c))) { r.metaspace.push({ gcId: +m[1], t: d.up, after: toMB(m[4]), cap: toMB(m[5]) }); return; }
  }

  // ---------- JDK 8 -XX:+PrintGCDetails (best effort) ----------
  const J8_EVT_RE = /(?:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+[+-]\d{4}): )?(\d+[.,]\d+): \[(Full GC|GC)\b/g;

  function parseJdk8(lines) {
    const r = newResult('jdk8');
    let last = null;
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      // G1 detail line with the heap summary for the previous pause
      let hm;
      if (last && last.before == null && (hm = /Heap: ([\d.]+[KMGB])\(([\d.]+[KMGB])\)->([\d.]+[KMGB])\(([\d.]+[KMGB])\)/.exec(line))) {
        last.before = toMB(hm[1]); last.after = toMB(hm[3]); last.cap = toMB(hm[4]);
        continue;
      }
      const tm = /(\d+[.,]\d+): \[/.exec(line);
      if (tm) { const t = parseFloat(tm[1].replace(',', '.')); if (r.firstT == null) r.firstT = t; r.lastT = Math.max(r.lastT || 0, t); }
      if (/\[(?:CMS-concurrent|GC concurrent)/.test(line) && !/\[(Full GC|GC)[ (]/.test(line.replace(/\[GC concurrent[^\]]*\]/g, ''))) continue;
      J8_EVT_RE.lastIndex = 0;
      const m = J8_EVT_RE.exec(line);
      if (!m) continue;
      const t = parseFloat(m[2].replace(',', '.'));
      const body = line.slice(m.index + m[0].length - (m[3].length + 1)); // starts at "[GC" / "[Full GC"
      const noTimes = body.replace(/\[Times:[^\]]*\]/g, '');
      // pause duration: the last ", 0.0123 secs]" belongs to the outermost event
      const secs = [...noTimes.matchAll(/,\s*([\d.,]+) secs\]/g)];
      if (!secs.length) continue;
      const ms = parseFloat(secs[secs.length - 1][1].replace(',', '.')) * 1000;
      const inner = noTimes.slice(1 + m[3].length);
      const lab = /^\s*((?:pause|remark|cleanup|\([^()]*(?:\([^()]*\))?[^()]*\)|\s)*)/.exec(inner)[1].trim();
      const groups = splitName('x ' + lab).groups;
      let kind = 'young', cause = groups.filter((g) => !/^(young|mixed|initial-mark)$/.test(g)).join(' ');
      if (m[3] === 'Full GC') kind = 'full';
      else if (/^remark/.test(lab) || /CMS Final Remark/.test(lab)) kind = 'remark';
      else if (/^cleanup/.test(lab)) kind = 'cleanup';
      else if (/\(mixed\)/.test(lab)) kind = 'mixed';
      else if (/CMS Initial Mark/.test(lab)) kind = 'other';
      // heap: strip nested [...] groups and take the last X->Y(Z)
      let flat = inner;
      for (let k = 0; k < 5; k++) flat = flat.replace(/\[[^\[\]]*\]/g, '');
      const hs = [...flat.matchAll(/([\d.]+[KMGB]?)->([\d.]+[KMGB]?)\(([\d.]+[KMGB]?)\)/g)];
      const h = hs.length ? hs[hs.length - 1] : null;
      const unitFix = (s) => (/[KMGB]$/.test(s) ? s : s + 'K');
      const p = { gcId: r.pauses.length, t, ms, label: (m[3] === 'Full GC' ? 'Full GC ' : 'GC ') + lab, kind, sub: kind === 'mixed' ? 'Mixed' : '', cause: kind === 'young' && !cause ? '' : cause,
        before: h ? toMB(unitFix(h[1])) : null, after: h ? toMB(unitFix(h[2])) : null, cap: h ? toMB(unitFix(h[3])) : null, line: li };
      if (/to-space (exhausted|overflow)/i.test(line)) r.evacFailures++;
      if (/Humongous/i.test(lab)) r.humongousPauses++;
      if (!r.collector) {
        if (/PSYoungGen|ParOldGen/.test(line)) r.collector = 'Parallel';
        else if (/ParNew|CMS/.test(line)) r.collector = 'CMS';
        else if (/G1|GC pause/.test(line)) r.collector = 'G1';
        else if (/DefNew|Tenured/.test(line)) r.collector = 'Serial';
      }
      const tm2 = /\[Times: user=([\d.]+) sys=([\d.]+), real=([\d.]+) secs\]/.exec(line);
      if (tm2) r.cpu.push({ gcId: p.gcId, user: +tm2[1], sys: +tm2[2], real: +tm2[3] });
      r.pauses.push(p);
      last = p;
    }
    return r;
  }

  function newResult(format) {
    return { format, collector: null, jdk: null, maxHeapMB: null, regionSize: null, pauses: [], cycles: [], concHeap: [], concCycles: [], cpu: [], stalls: [], metaspace: [],
      evacFailures: 0, humongousPauses: 0, shenCancels: 0, firstT: null, lastT: null, firstWall: null };
  }

  function detect(text) {
    const head = text.slice(0, 200000);
    if (/^\[[^\]\n]*\](\[[^\]\n]*\])*\s*(GC\(\d+\)|Using |Version:|Heap )/m.test(head) || /\]\[(info|debug|trace|warning)\s*\]\[gc/.test(head)) return 'unified';
    if (/^\s*GC\(\d+\) Pause /m.test(head)) return 'unified';
    if (/\d+[.,]\d+: \[(Full GC|GC)[ (]/.test(head)) return 'jdk8';
    return null;
  }

  // ---------- statistics ----------
  function percentile(sorted, p) {
    if (!sorted.length) return null;
    const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[i];
  }

  function linreg(pts) {
    const n = pts.length;
    if (n < 2) return null;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    pts.forEach(([x, y]) => { sx += x; sy += y; sxx += x * x; sxy += x * y; });
    const den = n * sxx - sx * sx;
    if (!den) return null;
    const slope = (n * sxy - sx * sy) / den;
    return { slope, icpt: (sy - slope * sx) / n };
  }

  const fmtMs = (ms) => (ms == null ? '–' : ms >= 1000 ? (ms / 1000).toFixed(ms >= 10000 ? 1 : 2) + ' s' : ms >= 100 ? Math.round(ms) + ' ms' : ms >= 10 ? ms.toFixed(1) + ' ms' : ms.toFixed(2) + ' ms');
  const fmtMB = (mb) => (mb == null ? '–' : mb >= 1024 ? (mb / 1024).toFixed(mb >= 10240 ? 0 : 1) + ' GB' : Math.round(mb) + ' MB');
  const fmtDur = (s) => (s == null ? '–' : s >= 3600 ? (s / 3600).toFixed(1) + ' h' : s >= 120 ? Math.round(s / 60) + ' min' : Math.round(s) + ' s');
  const plural = (n, one, many) => `${n.toLocaleString('en-AU')} ${n === 1 ? one : (many || one + 's')}`;

  const CAUSE_ADVICE = [
    { re: /Metadata GC Threshold|Metaspace/i, text: 'Metaspace (class metadata) filled up. Check <code>-XX:MaxMetaspaceSize</code> and whether classes keep being generated (proxies, scripting engines, redeploys leaking class loaders).' },
    { re: /System\.gc\(\)/i, text: 'Something called <code>System.gc()</code> (application code, a library, or RMI\'s distributed GC). Find the caller; <code>-XX:+ExplicitGCInvokesConcurrent</code> or <code>-XX:+DisableExplicitGC</code> stop it costing a full pause.' },
    { re: /Heap Dump Initiated|Heap Inspection Initiated/i, text: 'Triggered by a heap dump or <code>jmap -histo:live</code>. Expected if someone was diagnosing; worrying if a tool does it on a schedule.' },
    { re: /Diagnostic Command/i, text: 'Triggered by <code>jcmd GC.run</code> or a similar diagnostic command.' },
    { re: /GCLocker/i, text: 'GC was delayed by JNI critical sections. Usually rare; frequent ones point at native code holding arrays.' },
    { re: /Ergonomics/i, text: 'The Parallel collector ran a full collection because the old generation was nearly full. Check heap size and the trend of heap after GC.' },
    { re: /G1 Compaction Pause|Allocation Failure|G1 Humongous/i, text: 'The heap could not satisfy allocations, so the JVM fell back to a stop-the-world full collection. Usually the heap is too small for the live data, live data keeps growing (leak), or humongous objects fragment the heap.' },
    { re: /G1 Preventive/i, text: 'G1 started a preventive collection to avoid running out of space. Frequent ones mean the heap is tight.' }
  ];

  function analyse(text) {
    if (!text || !text.trim()) throw new Error('Paste a GC log or drop a file first.');
    const fmt = detect(text);
    if (!fmt) throw new Error("That doesn't look like a GC log. Expected JDK 9+ unified logging lines like [12.345s][info][gc] GC(3) Pause Young (Normal) (G1 Evacuation Pause) 250M->40M(1024M) 6.2ms, or JDK 8 -XX:+PrintGCDetails lines like 12.345: [GC (Allocation Failure) ...].");
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const r = fmt === 'unified' ? parseUnified(lines) : parseJdk8(lines);
    if (!r.pauses.length && !r.cycles.length) throw new Error('No GC pauses found. If this is unified logging, make sure it includes the gc tag at info level (-Xlog:gc*); safepoint-only or gc+heap-only logs have no pause lines.');
    if (!r.collector) {
      if (r.cycles.length) r.collector = 'ZGC';
      else if (r.pauses.some((p) => /Init Mark|Final Mark|Update Refs|Degenerated/.test(p.label))) r.collector = 'Shenandoah';
      else if (r.pauses.some((p) => p.sub || p.kind === 'remark' || p.kind === 'mixed')) r.collector = 'G1';
    }
    return stats(r, lines.length);
  }

  function stats(r, lineCount) {
    const P = r.pauses.slice().sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
    const timed = P.every((p) => p.t != null);
    const durs = P.map((p) => p.ms).sort((a, b) => a - b);
    const total = durs.reduce((a, b) => a + b, 0);
    const first = r.firstT != null ? r.firstT : (P[0] && P[0].t);
    const last = r.lastT != null ? r.lastT : (P.length && P[P.length - 1].t);
    const span = timed && last != null && first != null ? Math.max(0, last - first) : null;
    const throughput = span && span > 0 ? Math.max(0, 1 - total / 1000 / span) : null;

    const byKind = {};
    P.forEach((p) => { const k = byKind[p.kind] || (byKind[p.kind] = { count: 0, total: 0, max: 0 }); k.count++; k.total += p.ms; k.max = Math.max(k.max, p.ms); });
    const fulls = P.filter((p) => p.kind === 'full');
    const fullCauses = {};
    fulls.forEach((p) => { fullCauses[p.cause || 'unspecified'] = (fullCauses[p.cause || 'unspecified'] || 0) + 1; });
    const youngCauses = {};
    P.filter((p) => p.kind === 'young' || p.kind === 'mixed').forEach((p) => { const c = p.cause || p.sub || 'unspecified'; youngCauses[c] = (youngCauses[c] || 0) + 1; });

    // heap series: pauses with heap info, ZGC cycles, Shenandoah concurrent phases with heap
    const heap = [];
    P.forEach((p) => { if (p.before != null && p.t != null) heap.push({ t: p.t, before: p.before, after: p.after, cap: p.cap, kind: p.kind }); });
    r.cycles.forEach((c) => { if (c.t != null) heap.push({ t: c.t, before: c.before, after: c.after, cap: c.cap, kind: c.type === 'Minor Collection' ? 'young' : 'cycle' }); });
    r.concHeap.forEach((c) => { if (c.t != null && /cleanup/i.test(c.name)) heap.push({ t: c.t, before: c.before, after: c.after, cap: c.cap, kind: 'cycle' }); });
    heap.sort((a, b) => a.t - b.t);

    // allocation rate: what was allocated between one collection's end and the next one's start
    let allocMB = 0, allocSpan = 0, peakRate = null;
    if (heap.length >= 2) {
      const t0 = heap[0].t, t1 = heap[heap.length - 1].t;
      const nb = Math.min(60, Math.max(1, Math.floor((t1 - t0) / 10)));
      const bw = (t1 - t0) / nb || 1;
      const buckets = new Array(nb).fill(0);
      for (let i = 1; i < heap.length; i++) {
        const a = heap[i].before - heap[i - 1].after;
        if (a > 0) { allocMB += a; buckets[Math.min(nb - 1, Math.floor((heap[i].t - t0) / bw))] += a; }
      }
      allocSpan = t1 - t0;
      if (nb >= 3) peakRate = Math.max(...buckets) / bw;
    }
    const allocRate = allocSpan > 0 ? allocMB / allocSpan : null;

    // trend of heap after GC (lower envelope per window)
    let trend = null;
    const capMax = Math.max(r.maxHeapMB || 0, ...heap.map((h) => h.cap || 0)) || null;
    if (heap.length >= 10 && span && span >= 300) {
      const W = 8;
      const t0 = heap[0].t, t1 = heap[heap.length - 1].t, w = (t1 - t0) / W;
      const mins = [];
      for (let i = 0; i < W; i++) {
        const xs = heap.filter((h) => h.t >= t0 + i * w && (i === W - 1 ? h.t <= t1 : h.t < t0 + (i + 1) * w) && h.after != null);
        if (xs.length) mins.push([t0 + (i + 0.5) * w, Math.min(...xs.map((h) => h.after))]);
      }
      if (mins.length >= 5) {
        const lr = linreg(mins);
        let ups = 0;
        for (let i = 1; i < mins.length; i++) if (mins[i][1] > mins[i - 1][1]) ups++;
        const startV = mins[0][1], endV = mins[mins.length - 1][1];
        trend = { windows: mins, slopeMBperMin: lr ? lr.slope * 60 : 0, startMB: startV, endMB: endV, ups, steps: mins.length - 1 };
      }
    }

    const longest = P.slice().sort((a, b) => b.ms - a.ms).slice(0, 10);
    const cpuReal = r.cpu.filter((c) => c.real >= 0.05 && c.real > 1.5 * (c.user + c.sys) && c.user + c.sys < c.real);
    const stallMs = r.stalls.reduce((a, s) => a + s.ms, 0);
    const afterPct = heap.filter((h) => h.cap && h.after != null).map((h) => h.after / h.cap);
    const avgAfterPct = afterPct.length ? afterPct.reduce((a, b) => a + b, 0) / afterPct.length : null;
    const recentAfterPct = afterPct.length >= 10 ? afterPct.slice(-Math.ceil(afterPct.length / 5)).reduce((a, b) => a + b, 0) / Math.ceil(afterPct.length / 5) : avgAfterPct;

    const res = {
      format: r.format === 'unified' ? 'Unified logging (JDK 9+)' : 'JDK 8 -XX:+PrintGCDetails (best effort)',
      collector: r.collector, jdk: r.jdk, maxHeapMB: r.maxHeapMB || capMax, lines: lineCount,
      pauses: P, count: P.length, totalMs: total, span, throughput, timed,
      p50: percentile(durs, 50), p95: percentile(durs, 95), p99: percentile(durs, 99), max: durs.length ? durs[durs.length - 1] : null, mean: durs.length ? total / durs.length : null,
      byKind, fulls, fullCauses, youngCauses, heap, allocRate, peakRate, trend, longest, cycles: r.cycles, concCycles: r.concCycles, stalls: r.stalls, stallMs,
      evacFailures: r.evacFailures, humongousPauses: r.humongousPauses, shenCancels: r.shenCancels, cpuReal, avgAfterPct, recentAfterPct, firstT: first, lastT: last
    };
    res.findings = findings(res);
    return res;
  }

  function findings(s) {
    const F = [];
    const tp = s.throughput;

    if (s.fulls.length) {
      const causes = Object.entries(s.fullCauses).sort((a, b) => b[1] - a[1]);
      causes.forEach(([cause, n]) => {
        const adv = CAUSE_ADVICE.find((a) => a.re.test(cause));
        const worst = Math.max(...s.fulls.filter((p) => (p.cause || 'unspecified') === cause).map((p) => p.ms));
        F.push({ level: n >= 3 || worst >= 1000 ? 'bad' : 'warn', title: `${plural(n, 'Full GC')} caused by ${cause} (longest ${fmtMs(worst)})`,
          text: (adv ? adv.text : 'A full, stop-the-world collection of the whole heap. Check why the normal collector could not keep up.') });
      });
    } else if (s.count) {
      F.push({ level: 'ok', title: 'No Full GCs', text: `The ${s.collector || 'collector'} never fell back to a full stop-the-world collection in this log.` });
    }

    if (s.trend) {
      const t = s.trend;
      const growth = t.endMB - t.startMB;
      const cap = s.maxHeapMB || 0;
      if (growth > 0 && t.ups >= Math.ceil(t.steps * 0.7) && (cap ? growth >= 0.1 * cap : growth >= 50) && t.endMB >= t.startMB * 1.2) {
        F.push({ level: 'bad', title: `Heap after GC keeps rising: ${fmtMB(t.startMB)} → ${fmtMB(t.endMB)} over ${fmtDur(s.span)}`,
          text: `The memory left after each collection (the live data) grows at about ${fmtMB(Math.max(1, t.slopeMBperMin))}/min. That is the shape of a <a href="/glossary/memory-leak/">memory leak</a>, though a cache filling up or warm-up can look the same. If a longer run keeps climbing, take two heap dumps some minutes apart (<code>jcmd &lt;pid&gt; GC.heap_dump file.hprof</code>) and compare what grew.` });
      } else if (Math.abs(growth) < Math.max(20, 0.05 * (cap || 1000))) {
        F.push({ level: 'ok', title: 'Heap after GC is flat', text: `Live data stays around ${fmtMB((t.startMB + t.endMB) / 2)} across the log: no sign of a leak in this window.` });
      }
    } else if (s.span != null && s.span < 300 && s.count) {
      F.push({ level: 'info', title: 'Log is too short to judge a leak', text: `It covers ${fmtDur(s.span)}. Leaks show over tens of minutes to hours; capture a log from a longer soak or load test.` });
    }

    if (tp != null) {
      const pc = (tp * 100).toFixed(tp >= 0.999 ? 2 : 1);
      if (tp < 0.9) F.push({ level: 'bad', title: `Throughput ${pc}%: the JVM spent ${(100 - tp * 100).toFixed(1)}% of the time paused`, text: 'More than a tenth of wall time went to stop-the-world pauses. Requests queue during every pause. Likely the heap is too small for the live data or allocation rate; check the heap chart and Full GCs first.' });
      else if (tp < 0.95) F.push({ level: 'warn', title: `Throughput ${pc}%`, text: 'Pauses take more than 5% of the time. Worth tuning: look at the most frequent pause type and the allocation rate.' });
      else F.push({ level: 'ok', title: `Throughput ${pc}%`, text: 'Little time lost to pauses overall. If users still see slow requests, compare the long pauses below with your slow-request timestamps.' });
    }

    if (s.max != null) {
      const target = s.collector === 'G1' ? 200 : s.collector === 'ZGC' || s.collector === 'Shenandoah' ? 10 : null;
      if (s.max >= 1000) F.push({ level: 'bad', title: `Longest pause ${fmtMs(s.max)}`, text: 'Every request in flight waited at least this long. Pauses over a second usually come from Full GCs or evacuation failures; see the list of longest pauses.' });
      else if (target && s.p99 > target) F.push({ level: 'warn', title: `p99 pause ${fmtMs(s.p99)} is above the ${s.collector} target (${target} ms)`, text: s.collector === 'G1' ? 'G1 aims for <code>-XX:MaxGCPauseMillis</code> (200 ms by default). Missing it regularly often means too little heap headroom, large old-gen evacuations (mixed GCs), or long reference processing.' : 'Low-latency collectors aim for pauses of a few milliseconds; long ones suggest CPU starvation (containers with low CPU limits) or a very large root set.' });
    }

    if (s.evacFailures) F.push({ level: 'bad', title: `${plural(s.evacFailures, 'evacuation failure')} (to-space exhausted)`, text: 'G1 ran out of free regions while copying live objects, which makes that pause much longer and often precedes a Full GC. Likely the heap is too full: more heap, or a lower <code>-XX:InitiatingHeapOccupancyPercent</code> so marking starts earlier.' });
    if (s.humongousPauses >= 3) F.push({ level: 'warn', title: `${plural(s.humongousPauses, 'collection')} triggered by humongous allocations`, text: 'Objects of half a region or more (large arrays, big strings, buffers) are allocated directly in old gen. Check what allocates them, or raise <code>-XX:G1HeapRegionSize</code>.' });
    if (s.stalls.length) F.push({ level: 'bad', title: `${plural(s.stalls.length, 'allocation stall')} (${fmtMs(s.stallMs)} total)`, text: 'Application threads had to wait for ZGC to free memory: effectively a pause for those threads. The collector cannot keep up with the allocation rate; give it more heap headroom (<code>-Xmx</code>) or reduce allocation.' });
    if (s.byKind.degenerated) F.push({ level: 'bad', title: `${plural(s.byKind.degenerated.count, 'degenerated GC')}`, text: 'Shenandoah ran out of memory during a concurrent cycle and finished it stop-the-world. Same remedy as allocation stalls: more headroom or less allocation.' });

    if (s.avgAfterPct != null && s.recentAfterPct >= 0.85) F.push({ level: 'warn', title: `Heap after GC is ${Math.round(s.recentAfterPct * 100)}% of capacity`, text: 'Little room is left after collecting, so collections come often and Full GCs are likely. Either the heap is too small for the live data, or the live data is growing.' });

    if (s.allocRate != null && s.span) {
      const young = (s.byKind.young ? s.byKind.young.count : 0) + (s.byKind.mixed ? s.byKind.mixed.count : 0);
      const every = young ? s.span / young : null;
      if (every != null && every < 1 && young >= 20) F.push({ level: 'warn', title: `Young collections every ${every.toFixed(2)} s on average`, text: `Allocation runs at about ${fmtMB(s.allocRate)}/s. Frequent young pauses add up; check for heavy allocation (large temporary objects, string building, JSON mapping) or a young generation that is too small.` });
    }

    if (s.cpuReal.length >= 3) F.push({ level: 'warn', title: `${plural(s.cpuReal.length, 'pause')} where wall time far exceeded CPU time`, text: 'Real time was much longer than User+Sys, so GC threads were waiting rather than working. Likely CPU throttling (container CPU limits), swapping, or I/O to the log file. Check host and container CPU metrics.' });

    const order = { bad: 0, warn: 1, info: 2, ok: 3 };
    return F.map((f, i) => [f, i]).sort((a, b) => order[a[0].level] - order[b[0].level] || a[1] - b[1]).map((x) => x[0]);
  }

  // ---------- synthetic samples ----------
  function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

  // G1, JDK 17, 4 GB heap, ~40 minutes of a load test with live data creeping up
  function sampleG1(opts) {
    const o = Object.assign({ minutes: 40, seed: 3, leak: true }, opts || {});
    const R = rng(o.seed);
    const L = [];
    const wall0 = Date.UTC(2026, 10, 6, 3, 0, 0); // 2026-11-06 14:00 AEDT
    const pad = (n, w) => String(n).padStart(w, '0');
    const stamp = (t) => {
      const d = new Date(wall0 + t * 1000 + 11 * 3600 * 1000);
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}T${pad(d.getUTCHours(), 2)}:${pad(d.getUTCMinutes(), 2)}:${pad(d.getUTCSeconds(), 2)}.${pad(d.getUTCMilliseconds(), 3)}+1100`;
    };
    const line = (t, tags, msg, level) => L.push(`[${stamp(t)}][${t.toFixed(3)}s][${level || 'info'}][${tags.padEnd(12)}] ${msg}`);
    const capM = 4096, regionM = 2;
    let t = 0.012;
    line(t, 'gc,init', 'Version: 17.0.12+7 (release)'); line(t, 'gc', 'Using G1');
    line(t, 'gc,init', 'CPUs: 4 total, 4 available'); line(t, 'gc,init', 'Memory: 7836M'); line(t, 'gc,init', 'Large Page Support: Disabled');
    line(t, 'gc,init', 'NUMA Support: Disabled'); line(t, 'gc,init', 'Compressed Oops: Enabled (Zero based)');
    line(t, 'gc,init', `Heap Region Size: ${regionM}M`); line(t, 'gc,init', 'Heap Min Capacity: 1G'); line(t, 'gc,init', 'Heap Initial Capacity: 1G');
    line(t, 'gc,init', `Heap Max Capacity: ${capM / 1024}G`); line(t, 'gc,init', 'Pre-touch: Disabled'); line(t, 'gc,init', 'Parallel Workers: 4');
    line(t, 'gc,init', 'Concurrent Workers: 1'); line(t, 'gc,init', 'Concurrent Refinement Workers: 4'); line(t, 'gc,init', 'Periodic GC: Disabled');
    line(0.02, 'gc,metaspace', 'CDS archive(s) mapped at: [0x0000000800000000-0x0000000800bb0000-0x0000000800bb0000), size 12255232, SharedBaseAddress: 0x0000000800000000, ArchiveRelocationMode: 0.');
    line(0.02, 'gc,metaspace', 'Compressed class space mapped at: 0x0000000801000000-0x0000000841000000, reserved size: 1073741824');

    let id = 0, heapCap = 1024, live = 180, used = 200, meta = 48;
    const end = o.minutes * 60;
    let nextConc = 600, mixedLeft = 0;
    t = 2.4;
    const emit = (label, before, after, cap, ms, extra) => {
      const gid = id++;
      line(t, 'gc,start', `GC(${gid}) ${label}`);
      if (extra) extra(gid);
      const eden0 = Math.round((before - after) / regionM), old = Math.round(after * 0.9 / regionM);
      line(t + ms / 1000, 'gc,heap', `GC(${gid}) Eden regions: ${eden0}->0(${Math.max(20, eden0)})`);
      line(t + ms / 1000, 'gc,heap', `GC(${gid}) Survivor regions: 6->7(${Math.round(cap / regionM / 16)})`);
      line(t + ms / 1000, 'gc,heap', `GC(${gid}) Old regions: ${old}->${old + 2}`);
      line(t + ms / 1000, 'gc,heap', `GC(${gid}) Humongous regions: 3->3`);
      line(t + ms / 1000, 'gc,metaspace', `GC(${gid}) Metaspace: ${Math.round(meta)}M(${Math.round(meta + 1)}M)->${Math.round(meta)}M(${Math.round(meta + 1)}M) NonClass: ${Math.round(meta * 0.87)}M(${Math.round(meta * 0.88)}M)->${Math.round(meta * 0.87)}M(${Math.round(meta * 0.88)}M) Class: ${Math.round(meta * 0.13)}M(${Math.round(meta * 0.13)}M)->${Math.round(meta * 0.13)}M(${Math.round(meta * 0.13)}M)`);
      line(t + ms / 1000, 'gc', `GC(${gid}) ${label} ${Math.round(before)}M->${Math.round(after)}M(${Math.round(cap)}M) ${ms.toFixed(3)}ms`);
      const real = ms / 1000;
      line(t + ms / 1000, 'gc,cpu', `GC(${gid}) User=${(real * 3.6).toFixed(2)}s Sys=${(real * 0.3).toFixed(2)}s Real=${real.toFixed(2)}s`);
      return gid;
    };
    while (t < end) {
      // load ramps up over the first 5 minutes, allocation ~ 220-320 MB/s at peak
      const load = Math.min(1, 0.25 + t / 300);
      const alloc = (220 + 100 * R()) * load;
      meta = Math.min(160, meta + 0.02);
      const youngSize = Math.max(120, Math.min(820, (heapCap - live) * 0.55));
      const dt = Math.max(0.4, (youngSize - 30) / alloc);
      t += dt * (0.85 + R() * 0.3);
      if (t >= end) break;
      // live data grows steadily after warm-up (the leak this sample demonstrates)
      if (o.leak && t > 120) live += 1.5 * load * dt * (0.8 + R() * 0.4);
      heapCap = Math.min(capM, Math.max(heapCap, live + 820 + 200));
      const before = Math.min(heapCap, live + youngSize + 20 * R());
      let after = live + 25 + 10 * R();
      if (heapCap - live < 700 && R() < 0.012) {
        // heap is nearly full: evacuation failure then a Full GC that cannot free the leaked data
        emit('Pause Young (Normal) (G1 Evacuation Pause)', before, Math.min(heapCap - 40, before), heapCap, 380 + 200 * R(), (g) => line(t, 'gc', `GC(${g}) To-space exhausted`));
        t += 0.9;
        emit('Pause Full (G1 Compaction Pause)', heapCap - 30, live + 15, heapCap, 2400 + 900 * R(), (g) => {
          ['Phase 1: Mark live objects', 'Phase 2: Prepare for compaction', 'Phase 3: Adjust pointers', 'Phase 4: Compact heap'].forEach((ph, k) => line(t + k * 0.3, 'gc,phases', `GC(${g}) ${ph} ${(300 + 400 * R()).toFixed(3)}ms`));
        });
        t += 3;
        continue;
      }
      let label = 'Pause Young (Normal) (G1 Evacuation Pause)';
      let ms = 6 + 8 * R() + live / 120 + (R() < 0.03 ? 40 * R() : 0);
      if (mixedLeft > 0) {
        label = mixedLeft === 9 ? 'Pause Young (Prepare Mixed) (G1 Evacuation Pause)' : 'Pause Young (Mixed) (G1 Evacuation Pause)';
        if (mixedLeft < 9) { ms += 12 + 20 * R(); after -= 4; }
        mixedLeft--;
      } else if (before > heapCap * 0.45 && t > nextConc) {
        label = 'Pause Young (Concurrent Start) (G1 Evacuation Pause)';
      }
      emit(label, before, Math.max(60, after), heapCap, ms);
      if (/Concurrent Start/.test(label)) {
        const g = id - 1;
        const cs = t + 0.02;
        line(cs, 'gc', `GC(${g}) Concurrent Mark Cycle`);
        line(cs, 'gc,marking', `GC(${g}) Concurrent Clear Claimed Marks`);
        line(cs + 0.001, 'gc,marking', `GC(${g}) Concurrent Clear Claimed Marks 0.034ms`);
        line(cs + 0.001, 'gc,marking', `GC(${g}) Concurrent Scan Root Regions`);
        line(cs + 0.01, 'gc,marking', `GC(${g}) Concurrent Scan Root Regions 9.812ms`);
        line(cs + 0.01, 'gc,marking', `GC(${g}) Concurrent Mark`);
        const markMs = 350 + live * 0.6 + 200 * R();
        line(cs + markMs / 1000, 'gc,marking', `GC(${g}) Concurrent Mark From Roots`);
        line(cs + markMs / 1000, 'gc,marking', `GC(${g}) Concurrent Mark ${markMs.toFixed(3)}ms`);
        const rt = cs + markMs / 1000 + 0.002;
        line(rt, 'gc,start', `GC(${g}) Pause Remark`);
        const remMs = 4 + 6 * R() + live / 400;
        line(rt + remMs / 1000, 'gc', `GC(${g}) Pause Remark ${Math.round(after + 40)}M->${Math.round(after + 34)}M(${Math.round(heapCap)}M) ${remMs.toFixed(3)}ms`);
        line(rt + remMs / 1000, 'gc,cpu', `GC(${g}) User=0.02s Sys=0.00s Real=0.01s`);
        const ct = rt + 0.15;
        line(ct, 'gc,start', `GC(${g}) Pause Cleanup`);
        line(ct + 0.001, 'gc', `GC(${g}) Pause Cleanup ${Math.round(after + 60)}M->${Math.round(after + 60)}M(${Math.round(heapCap)}M) ${(0.3 + 0.4 * R()).toFixed(3)}ms`);
        line(ct + 0.001, 'gc,cpu', `GC(${g}) User=0.00s Sys=0.00s Real=0.00s`);
        line(ct + 0.05, 'gc,marking', `GC(${g}) Concurrent Cleanup for Next Mark 3.245ms`);
        line(ct + 0.05, 'gc', `GC(${g}) Concurrent Mark Cycle ${((ct + 0.05 - cs) * 1000).toFixed(3)}ms`);
        nextConc = t + 240 + 120 * R();
        mixedLeft = 9;
      }
      // a nightly job calls System.gc() once
      if (t > end * 0.3 && t < end * 0.3 + dt * 1.2) {
        t += 0.5;
        emit('Pause Full (System.gc())', live + 300, live + 10, heapCap, 900 + 300 * R());
      }
    }
    return L.join('\n') + '\n';
  }

  // Generational ZGC, JDK 21, short excerpt with an allocation stall
  function sampleZGC() {
    const R = rng(5);
    const L = [];
    const line = (t, tags, msg) => L.push(`[${t.toFixed(3)}s][info][${tags.padEnd(11)}] ${msg}`);
    line(0.008, 'gc,init', 'Initializing The Z Garbage Collector'); line(0.008, 'gc,init', 'Version: 21.0.5+11-LTS (release)');
    line(0.008, 'gc,init', 'Using The Z Garbage Collector'); line(0.008, 'gc,init', 'Max Capacity: 2048M'); line(0.008, 'gc,init', 'GC Workers for Young Generation: 2 (dynamic)');
    let t = 1.2, live = 300;
    for (let id = 0; id < 160; id++) {
      const major = id % 8 === 7;
      const cause = major ? 'Proactive' : (R() < 0.8 ? 'Allocation Rate' : 'High Usage');
      const kind = major ? 'Major Collection' : 'Minor Collection';
      line(t, 'gc,start', `GC(${id}) ${kind} (${cause})`);
      line(t + 0.001, 'gc,phases', `GC(${id}) Y: Young Generation`);
      line(t + 0.001, 'gc,phases', `GC(${id}) Y: Pause Mark Start${major ? ' (Major)' : ''} ${(0.008 + 0.02 * R()).toFixed(3)}ms`);
      line(t + 0.04, 'gc,phases', `GC(${id}) Y: Concurrent Mark ${(30 + 20 * R()).toFixed(3)}ms`);
      line(t + 0.04, 'gc,phases', `GC(${id}) Y: Pause Mark End ${(0.01 + 0.03 * R()).toFixed(3)}ms`);
      line(t + 0.05, 'gc,phases', `GC(${id}) Y: Pause Relocate Start ${(0.006 + 0.02 * R()).toFixed(3)}ms`);
      if (major) {
        line(t + 0.2, 'gc,phases', `GC(${id}) O: Old Generation`);
        line(t + 0.2, 'gc,phases', `GC(${id}) O: Pause Mark End ${(0.01 + 0.03 * R()).toFixed(3)}ms`);
        line(t + 0.25, 'gc,phases', `GC(${id}) O: Pause Relocate Start ${(0.008 + 0.02 * R()).toFixed(3)}ms`);
      }
      const before = Math.min(2040, live + 900 + 300 * R());
      if (id > 100 && id < 106 && R() < 0.7) line(t + 0.03, 'gc', `Allocation Stall (http-nio-8080-exec-${1 + Math.floor(R() * 50)}) ${(5 + 30 * R()).toFixed(3)}ms`);
      line(t + 0.3, 'gc', `GC(${id}) ${kind} (${cause}) ${Math.round(before)}M(${Math.round(before / 20.48)}%)->${Math.round(live)}M(${Math.round(live / 20.48)}%) ${(0.12 + 0.2 * R()).toFixed(3)}s`);
      live = Math.max(250, live + (R() - 0.5) * 30);
      t += 2.5 + 2 * R();
    }
    return L.join('\n') + '\n';
  }

  function sample(kind) { return kind === 'zgc' ? sampleZGC() : sampleG1(); }

  const api = { analyse, detect, parseUnified, parseJdk8, classifyPause, splitName, toMB, percentile, decorators, fmtMs, fmtMB, fmtDur, sample, sampleG1, sampleZGC, esc };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GCLog = api;
})(typeof window !== 'undefined' ? window : this);
