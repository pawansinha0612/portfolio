/* Java thread dump analyser: pure parsing + analysis, no DOM.
   Works in the browser (window.TDump) and in Node (module.exports).
   Formats: HotSpot jstack / jcmd Thread.print / kill -3 (JDK 6-25), jcmd Thread.dump_to_file
   (plain text and JSON, which include virtual threads), OpenJ9 javacore (best effort). */
(function (root) {
  'use strict';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- splitting into dumps ----------
  const FULL_RE = /^Full thread dump\b.*$/;
  const TS_RE = /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})/;

  function splitDumps(text) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const starts = [];
    for (let i = 0; i < lines.length; i++) {
      if (FULL_RE.test(lines[i])) {
        let s = i, ts = null;
        // a timestamp line (jstack / jcmd) or "<pid>:" line (jcmd) usually precedes the header
        for (let k = i - 1; k >= Math.max(0, i - 3); k--) {
          const l = lines[k].trim();
          if (!l) continue;
          const m = TS_RE.exec(l);
          if (m) { ts = m[1]; s = k; if (k > 0 && /^\d+:\s*$/.test(lines[k - 1].trim())) s = k - 1; break; }
          if (/^\d+:\s*$/.test(l)) { s = k; continue; }
          break;
        }
        starts.push({ line: s, header: lines[i], ts });
      }
    }
    if (!starts.length) return [{ header: '', ts: null, lines }];
    const out = [];
    for (let j = 0; j < starts.length; j++) {
      const end = j + 1 < starts.length ? starts[j + 1].line : lines.length;
      out.push({ header: starts[j].header, ts: starts[j].ts, lines: lines.slice(starts[j].line, end) });
    }
    return out;
  }

  // ---------- HotSpot thread parsing ----------
  // "name" #12 [3456] daemon prio=5 os_prio=0 cpu=12.3ms elapsed=45.6s tid=0x.. nid=0x1a2b waiting on condition  [0x..]
  const HDR_RE = /^"(.*)"\s+(.*)$/;
  const STATE_RE = /^\s*java\.lang\.Thread\.State:\s*([A-Z_]+)(?:\s*\((.*)\))?/;
  const FRAME_RE = /^\s*at\s+(.+?)\s*$/;
  const LOCK_RE = /^\s*-\s+(locked|waiting to lock|waiting on|parking to wait for|waiting to re-lock in wait\(\)|eliminated|lock owner)\s*<([^>]+)>\s*(?:\(a ([^)]+)\))?/;
  const OWNABLE_RE = /^\s*-\s+<(0x[0-9a-f]+)>\s*\(a ([^)]+)\)/i;

  function parseHeaderRest(rest) {
    const t = { daemon: false, virtual: false, prio: null, osPrio: null, num: null, tid: null, nid: null, cpuMs: null, elapsedS: null, desc: '' };
    let m;
    if ((m = /#(\d+)/.exec(rest))) t.num = +m[1];
    if (/\bdaemon\b/.test(rest)) t.daemon = true;
    if (/\bvirtual\b/.test(rest)) t.virtual = true;
    if ((m = /\bprio=(-?\d+)/.exec(rest))) t.prio = +m[1];
    if ((m = /\bos_prio=(-?\d+)/.exec(rest))) t.osPrio = +m[1];
    if ((m = /\btid=(0x[0-9a-f]+)/i.exec(rest))) t.tid = m[1];
    if ((m = /\bnid=(0x[0-9a-f]+|\d+)/i.exec(rest))) t.nid = m[1];
    if ((m = /\bcpu=([\d.]+)ms/.exec(rest))) t.cpuMs = +m[1];
    if ((m = /\belapsed=([\d.]+)s/.exec(rest))) t.elapsedS = +m[1];
    // description is the text after nid=..., minus the trailing [0x...] stack address
    if ((m = /\bnid=\S+\s+(.*?)\s*(?:\[0x[0-9a-f]+\])?\s*$/i.exec(rest))) t.desc = m[1];
    return t;
  }

  function stateFromDesc(desc) {
    if (/waiting for monitor entry/.test(desc)) return 'BLOCKED';
    if (/in Object\.wait/.test(desc)) return 'WAITING';
    if (/waiting on condition|parking/.test(desc)) return 'WAITING';
    if (/sleeping/.test(desc)) return 'TIMED_WAITING';
    if (/runnable/.test(desc)) return 'RUNNABLE';
    return null;
  }

  function parseHotspot(lines) {
    const threads = [];
    const jvmDeadlocks = [];
    let cur = null, inOwnable = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^Found one Java-level deadlock:/.test(line) || /^Found \d+ deadlocks?\./.test(line)) {
        if (/^Found one/.test(line)) {
          // capture the summary block up to "Java stack information" or "Found N deadlock"
          const block = [line];
          let k = i + 1;
          for (; k < lines.length; k++) {
            if (/^Java stack information for the threads listed above/.test(lines[k]) || /^Found (one Java-level|\d+) deadlock/.test(lines[k])) break;
            block.push(lines[k]);
          }
          const names = [];
          block.forEach((b) => { const mm = /^"(.*)":\s*$/.exec(b); if (mm) names.push(mm[1]); });
          jvmDeadlocks.push({ text: block.join('\n').trim(), threads: names });
          // skip the stack information section (its "name": lines are not thread headers)
          for (; k < lines.length; k++) {
            if (/^Found \d+ deadlocks?\./.test(lines[k])) break;
            if (/^Found one Java-level deadlock:/.test(lines[k])) { k--; break; }
          }
          i = k;
        }
        cur = null; continue;
      }
      const hm = HDR_RE.exec(line);
      if (hm && !/^"[^"]*":\s*$/.test(line)) {
        cur = Object.assign({ name: hm[1], state: null, stateDetail: '', frames: [], locks: [], owned: [], carrying: null }, parseHeaderRest(hm[2]));
        threads.push(cur); inOwnable = false; continue;
      }
      if (!cur) continue;
      let m;
      if ((m = STATE_RE.exec(line))) { cur.state = m[1]; cur.stateDetail = m[2] || ''; continue; }
      if ((m = FRAME_RE.exec(line))) { cur.frames.push(m[1]); continue; }
      if ((m = LOCK_RE.exec(line))) {
        cur.locks.push({ kind: m[1], addr: m[2].toLowerCase(), cls: m[3] || '', frame: cur.frames.length - 1 });
        continue;
      }
      if (/^\s*-\s+waiting on <no object reference available>/.test(line)) { cur.locks.push({ kind: 'waiting on', addr: null, cls: '', frame: cur.frames.length - 1 }); continue; }
      if (/^\s*Locked ownable synchronizers:/.test(line)) { inOwnable = true; continue; }
      if (inOwnable && (m = OWNABLE_RE.exec(line))) { cur.owned.push({ addr: m[1].toLowerCase(), cls: m[2] }); continue; }
      if ((m = /Carrying virtual thread #(\d+)/.exec(line))) { cur.carrying = +m[1]; continue; }
      if (/^\S/.test(line) && !/^"/.test(line)) { cur = null; inOwnable = false; }
    }
    threads.forEach((t) => { if (!t.state) t.state = stateFromDesc(t.desc) || (t.frames.length ? 'UNKNOWN' : 'VM'); });
    return { threads, jvmDeadlocks };
  }

  // ---------- jcmd Thread.dump_to_file (text) ----------
  // #1 "main"            /  #25 "" virtual
  //       java.base/java.lang.Thread.sleep(Thread.java:509)
  function parseDumpToFileText(lines) {
    const threads = [];
    let cur = null;
    for (const line of lines) {
      const m = /^#(\d+)\s+"(.*)"\s*(virtual)?\s*(.*)$/.exec(line);
      if (m) {
        cur = { name: m[2] || `virtual #${m[1]}`, num: +m[1], daemon: false, virtual: !!m[3], prio: null, tid: m[1], nid: null, cpuMs: null, elapsedS: null,
          desc: m[4] || '', state: null, stateDetail: '', frames: [], locks: [], owned: [], carrying: null };
        const st = /\b(RUNNABLE|BLOCKED|WAITING|TIMED_WAITING|NEW|TERMINATED)\b/.exec(m[4] || '');
        if (st) cur.state = st[1];
        threads.push(cur); continue;
      }
      if (cur && /^\s+\S/.test(line)) {
        const f = line.trim();
        const lm = /^-\s+(locked|waiting to lock|waiting on|parking to wait for)\s*<([^>]+)>/.exec(f);
        if (lm) cur.locks.push({ kind: lm[1], addr: lm[2].toLowerCase(), cls: '', frame: cur.frames.length - 1 });
        else if (!/^-/.test(f)) cur.frames.push(f.replace(/^at\s+/, ''));
      }
    }
    threads.forEach((t) => { if (!t.state) t.state = inferState(t.frames); });
    return { threads, jvmDeadlocks: [] };
  }

  // when a format has no state, guess from the top frame (labelled as inferred in the UI)
  function inferState(frames) {
    if (!frames.length) return 'UNKNOWN';
    const top = frames[0];
    if (/Unsafe\.park|LockSupport\.park|VirtualThread\.park|Continuation\.yield/.test(top) || /Object\.wait/.test(top)) return 'WAITING';
    if (/Thread\.sleep/.test(top)) return 'TIMED_WAITING';
    return 'RUNNABLE';
  }

  // ---------- jcmd Thread.dump_to_file -format=json ----------
  function parseJson(text) {
    const j = JSON.parse(text);
    const td = j.threadDump || j;
    const threads = [];
    (td.threadContainers || []).forEach((c) => {
      (c.threads || []).forEach((t) => {
        const frames = (t.stack || []).map((f) => (typeof f === 'string' ? f : (f.className ? `${f.className}.${f.methodName}(${f.fileName || ''}${f.lineNumber ? ':' + f.lineNumber : ''})` : JSON.stringify(f))));
        const locks = [];
        if (t.blockedOn) locks.push({ kind: 'waiting to lock', addr: String(t.blockedOn).toLowerCase(), cls: '', frame: 0 });
        if (t.waitingOn) locks.push({ kind: 'waiting on', addr: String(t.waitingOn).toLowerCase(), cls: '', frame: 0 });
        if (t.parkBlocker) locks.push({ kind: 'parking to wait for', addr: String(t.parkBlocker.object || t.parkBlocker).toLowerCase(), cls: '', frame: 0 });
        (t.monitorsOwned || []).forEach((mo) => (mo.locks || []).forEach((a) => locks.push({ kind: 'locked', addr: String(a).toLowerCase(), cls: '', frame: mo.depth || 0 })));
        threads.push({ name: t.name || `virtual #${t.tid}`, num: +t.tid || null, tid: t.tid, nid: null, daemon: false, virtual: !!t.virtual || (t.name === '' && c.container !== '<root>'),
          prio: null, cpuMs: null, elapsedS: null, desc: '', state: t.state || inferState(frames), stateDetail: t.state ? '' : 'inferred', frames, locks, owned: [], carrying: null, container: c.container });
      });
    });
    return { threads, jvmDeadlocks: [], ts: td.time || null, header: td.runtimeVersion ? `Thread dump (JSON), runtime ${td.runtimeVersion}` : 'Thread dump (JSON)' };
  }

  // ---------- OpenJ9 javacore (best effort) ----------
  const J9_STATE = { R: 'RUNNABLE', CW: 'WAITING', B: 'BLOCKED', P: 'WAITING', S: 'WAITING', Z: 'TERMINATED', D: 'TERMINATED', N: 'NEW', W: 'WAITING' };
  function parseJavacore(lines) {
    const threads = [];
    let cur = null;
    for (const line of lines) {
      let m;
      if ((m = /^3XMTHREADINFO\s+"(.*?)"\s+(.*)$/.exec(line))) {
        const st = /state:(\w+)/.exec(m[2]);
        const pr = /prio=(\d+)/.exec(m[2]);
        cur = { name: m[1], num: null, tid: (/J9VMThread:(0x[0-9A-Fa-f]+)/.exec(m[2]) || [])[1] || null, nid: null, daemon: false, virtual: false,
          prio: pr ? +pr[1] : null, cpuMs: null, elapsedS: null, desc: '', state: J9_STATE[st ? st[1] : ''] || 'UNKNOWN', stateDetail: st ? `OpenJ9 state ${st[1]}` : '',
          frames: [], locks: [], owned: [], carrying: null };
        threads.push(cur); continue;
      }
      if (!cur) continue;
      if ((m = /^3XMTHREADINFO1\s+.*native thread ID:(0x[0-9A-Fa-f]+)/.exec(line))) cur.nid = m[1];
      if ((m = /^3XMJAVALTHREAD\s+.*isDaemon:(true|false)/.exec(line))) cur.daemon = m[1] === 'true';
      if ((m = /^4XESTACKTRACE\s+at\s+(.+)$/.exec(line))) cur.frames.push(m[1].trim().replace(/\//g, '.'));
      if ((m = /^3XMTHREADBLOCK\s+(Blocked on|Waiting on|Parked on):\s*(\S+?)@(0x[0-9A-Fa-f]+)(?:.*Owned by:\s*"(.*?)")?/.exec(line))) {
        const kind = m[1] === 'Blocked on' ? 'waiting to lock' : (m[1] === 'Parked on' ? 'parking to wait for' : 'waiting on');
        cur.locks.push({ kind, addr: m[3].toLowerCase(), cls: m[2].replace(/\//g, '.'), frame: 0, ownerName: m[4] || null });
      }
    }
    // javacore names the owner rather than listing "locked": synthesise holder records
    const byName = new Map(threads.map((t) => [t.name, t]));
    threads.forEach((t) => t.locks.forEach((l) => {
      if (l.ownerName && byName.has(l.ownerName)) {
        const o = byName.get(l.ownerName);
        if (!o.locks.some((x) => x.kind === 'locked' && x.addr === l.addr)) o.locks.push({ kind: 'locked', addr: l.addr, cls: l.cls, frame: 0 });
      }
    }));
    return { threads, jvmDeadlocks: [] };
  }

  // ---------- detection of format ----------
  function detectFormat(text) {
    const t = text.trimStart();
    if (t[0] === '{' && /"threadDump"|"threadContainers"/.test(t.slice(0, 2000))) return 'json';
    if (/^0SECTION|^1TISIGINFO|^3XMTHREADINFO/m.test(text)) return 'javacore';
    if (/^\s*java\.lang\.Thread\.State:/m.test(text) || /^"[^"\n]*"\s+(#\d+|os_prio|prio=|daemon|tid=)/m.test(text)) return 'hotspot';
    if (/^#\d+\s+"[^"\n]*"/m.test(text)) return 'dumpToFile';
    return null;
  }

  // ---------- classification ----------
  // frames that are "idle" only when they are the *only* interesting frames; we check the top 6 frames for pool-idle markers
  // markers of a thread waiting for work (checked in the top frames only)
  const POOL_IDLE = [/ThreadPoolExecutor\.getTask/, /ForkJoinPool\.awaitWork/, /ReferenceQueue\.remove/, /Reference\.waitForReferencePendingList/,
    /EPoll\.wait|EPollArrayWrapper\.epollWait|KQueue\.(poll|keventPoll)|WEPoll\.wait|WindowsSelectorImpl/, /accept0?\(|socketAccept|Net\.accept/, /TimerThread\.mainLoop/, /CleanerImpl\.run/,
    /SelectorImpl\.(lockAndDoSelect|select)/, /DelayedWorkQueue\.take/];

  function classify(t) {
    if (!t.frames.length) return 'vm';
    const top = t.frames.slice(0, 14).join('\n');
    if (t.state === 'BLOCKED') return 'active';
    if (/socketRead|SocketInputStream\.read|NioSocketImpl\.(read|park)|SocketDispatcher\.read|SocketChannelImpl\.read/.test(top) && !/accept/i.test(top)) return 'active';
    if (POOL_IDLE.some((r) => r.test(top))) return 'idle';
    if (t.state === 'RUNNABLE') return 'active';
    return 'active';
  }

  // pool name: strip trailing numbers, e.g. "http-nio-8080-exec-12" -> "http-nio-8080-exec-#"
  function poolName(name) {
    if (!name) return '(unnamed / virtual)';
    const n = name.replace(/#?\d+(?=\D*$)/, '#');
    return n === name ? name : n;
  }

  const VM_THREAD_RE = /^(GC Thread#|G1 |ZGC|Z(Director|Driver|Stat|Unmapper|Worker|Refine|Uncommitter)|Shenandoah|ParGC|VM Thread|VM Periodic Task|C[12] CompilerThread|Sweeper|Service Thread|Monitor Deflation|Common-Cleaner|Notification Thread|Signal Dispatcher|Finalizer|Reference Handler|Attach Listener|Concurrent |CMS|Surrogate Locker|JVMCI|Gang worker|SharedPool)/;
  function category(t) {
    if (/^(GC Thread#|G1 |ZGC|Z(Director|Driver|Stat|Unmapper|Worker|Refine|Uncommitter)|Shenandoah|ParGC|Gang worker|CMS|Concurrent )/.test(t.name)) return 'gc';
    if (/CompilerThread|^Sweeper|JVMCI/.test(t.name)) return 'compiler';
    if (VM_THREAD_RE.test(t.name)) return 'jvm';
    return 'app';
  }

  // ---------- one dump analysis ----------
  function stackKey(t) { return t.state + '\n' + t.frames.join('\n'); }

  function analyseDump(parsed) {
    const threads = parsed.threads;
    threads.forEach((t, i) => { t.idx = i; t.cls = classify(t); t.cat = category(t); t.pool = poolName(t.name); });

    const states = {};
    threads.forEach((t) => { states[t.state] = (states[t.state] || 0) + 1; });

    // group identical stacks (only threads with frames)
    const gmap = new Map();
    threads.forEach((t) => {
      if (!t.frames.length) return;
      const k = stackKey(t);
      let g = gmap.get(k);
      if (!g) { g = { key: k, state: t.state, frames: t.frames, threads: [], cls: t.cls }; gmap.set(k, g); }
      g.threads.push(t);
    });
    const groups = [...gmap.values()].sort((a, b) => b.threads.length - a.threads.length || (a.cls === 'idle') - (b.cls === 'idle'));

    // lock graph
    const locks = new Map();
    const getLock = (addr, cls) => { let l = locks.get(addr); if (!l) { l = { addr, cls: cls || '', holders: [], waiters: [], parked: [], waitingOn: [] }; locks.set(addr, l); } if (cls && !l.cls) l.cls = cls; return l; };
    threads.forEach((t) => {
      const waitedOn = new Set(t.locks.filter((l) => l.kind === 'waiting on' && l.addr).map((l) => l.addr));
      t.locks.forEach((l) => {
        if (!l.addr) return;
        if (l.kind === 'locked') {
          // a thread in Object.wait() also shows "- locked" for the monitor it released; that is not a hold
          if (waitedOn.has(l.addr)) return;
          const L = getLock(l.addr, l.cls);
          if (!L.holders.some((h) => h.t === t)) L.holders.push({ t, frame: t.frames[l.frame] || '' });
        } else if (l.kind === 'waiting to lock' || l.kind === 'waiting to re-lock in wait()') {
          getLock(l.addr, l.cls).waiters.push({ t, frame: t.frames[Math.max(0, l.frame)] || '' });
        } else if (l.kind === 'parking to wait for') {
          getLock(l.addr, l.cls).parked.push({ t, frame: t.frames[Math.max(0, l.frame)] || '' });
        } else if (l.kind === 'waiting on') {
          getLock(l.addr, l.cls).waitingOn.push({ t });
        }
      });
      t.owned.forEach((o) => { const L = getLock(o.addr, o.cls); L.ownable = true; if (!L.holders.some((h) => h.t === t)) L.holders.push({ t, frame: '' }); });
    });
    const lockList = [...locks.values()];
    // parked threads count as contention only when the synchronizer has an owner (e.g. a held ReentrantLock)
    lockList.forEach((L) => { L.contenders = L.waiters.length + (L.holders.length ? L.parked.length : 0); });
    const contended = lockList.filter((L) => L.contenders > 0).sort((a, b) => b.contenders - a.contenders);

    // wait-for graph and cycle detection
    const waitsFor = new Map(); // thread -> [{holder, lock}]
    lockList.forEach((L) => {
      if (!L.holders.length) return;
      const ws = L.waiters.concat(L.parked);
      ws.forEach((w) => L.holders.forEach((h) => {
        if (h.t === w.t) return;
        if (!waitsFor.has(w.t)) waitsFor.set(w.t, []);
        waitsFor.get(w.t).push({ holder: h.t, lock: L });
      }));
    });
    const cycles = findCycles(waitsFor);

    // pools
    const pmap = new Map();
    threads.forEach((t) => {
      let p = pmap.get(t.pool);
      if (!p) { p = { name: t.pool, count: 0, active: 0, idle: 0, states: {}, cat: t.cat }; pmap.set(t.pool, p); }
      p.count++; if (t.cls === 'idle') p.idle++; else if (t.cls === 'active') p.active++;
      p.states[t.state] = (p.states[t.state] || 0) + 1;
    });
    const pools = [...pmap.values()].sort((a, b) => b.count - a.count);

    const cpu = { gc: 0, compiler: 0, jvm: 0, app: 0, known: false };
    threads.forEach((t) => { if (t.cpuMs != null) { cpu.known = true; cpu[t.cat] += t.cpuMs; } });

    const res = { header: parsed.header || '', ts: parsed.ts || null, format: parsed.format, threads, states, groups, locks: lockList, contended, cycles, jvmDeadlocks: parsed.jvmDeadlocks || [], pools, cpu,
      virtualCount: threads.filter((t) => t.virtual).length };
    res.hints = hintsFor(res);
    return res;
  }

  // Tarjan's strongly connected components; each component with 2+ threads (or a self-wait) holds a cycle.
  function findCycles(waitsFor) {
    let index = 0;
    const idx = new Map(), low = new Map(), onStack = new Set(), stack = [], comps = [];
    const nodes = [...waitsFor.keys()];
    const next = (t) => (waitsFor.get(t) || []);
    for (const start of nodes) {
      if (idx.has(start)) continue;
      // iterative DFS to survive thousands of threads
      const work = [{ t: start, i: 0 }];
      idx.set(start, index); low.set(start, index); index++; stack.push(start); onStack.add(start);
      while (work.length) {
        const fr = work[work.length - 1];
        const es = next(fr.t);
        if (fr.i < es.length) {
          const w = es[fr.i++].holder;
          if (!idx.has(w)) {
            idx.set(w, index); low.set(w, index); index++; stack.push(w); onStack.add(w);
            work.push({ t: w, i: 0 });
          } else if (onStack.has(w)) low.set(fr.t, Math.min(low.get(fr.t), idx.get(w)));
        } else {
          work.pop();
          if (work.length) { const p = work[work.length - 1].t; low.set(p, Math.min(low.get(p), low.get(fr.t))); }
          if (low.get(fr.t) === idx.get(fr.t)) {
            const comp = [];
            let w;
            do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== fr.t);
            if (comp.length > 1) comps.push(comp);
          }
        }
      }
    }
    // turn each component into an ordered cycle: walk edges that stay inside the component
    return comps.slice(0, 50).map((comp) => {
      const inComp = new Set(comp);
      const cyc = [];
      const seen = new Map();
      let t = comp[0];
      while (!seen.has(t)) {
        seen.set(t, cyc.length);
        const e = next(t).find((x) => inComp.has(x.holder));
        if (!e) break;
        cyc.push({ t, lock: e.lock, holder: e.holder });
        t = e.holder;
      }
      return seen.has(t) ? cyc.slice(seen.get(t)) : cyc;
    });
  }

  // ---------- hints ----------
  const anyFrame = (t, re, n) => { const fs = n ? t.frames.slice(0, n) : t.frames; for (const f of fs) if (re.test(f)) return true; return false; };
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;

  function hintsFor(r) {
    const H = [];
    const T = r.threads;
    const app = T.filter((t) => t.cat === 'app');
    const total = T.length;

    if (r.jvmDeadlocks.length || r.cycles.length) {
      const n = Math.max(r.jvmDeadlocks.length, r.cycles.length);
      H.push({ level: 'bad', title: `Deadlock: ${plural(n, 'cycle')} of threads waiting on each other`,
        text: `${r.jvmDeadlocks.length ? 'The JVM itself reported a Java-level deadlock. ' : ''}These threads will never make progress on their own; requests that need them will hang until timeouts fire. Fix the lock ordering (always take locks in the same order) or use <code>tryLock</code> with a timeout. See the deadlock section below for who holds what.` });
    }

    // connection pool exhaustion
    const poolRes = [
      { re: /com\.zaxxer\.hikari\.pool\.HikariPool\.getConnection/, name: 'HikariCP', fix: 'maximumPoolSize, slow queries holding connections, and leaks (<code>leakDetectionThreshold</code>)' },
      { re: /org\.apache\.tomcat\.jdbc\.pool\.ConnectionPool\.(borrowConnection|getConnection)/, name: 'Tomcat JDBC pool', fix: 'maxActive, slow queries and abandoned connections' },
      { re: /org\.apache\.commons\.dbcp2?\..*(getConnection|borrowObject)/, name: 'DBCP', fix: 'maxTotal, slow queries and abandoned connections' },
      { re: /com\.mchange\.v2\.c3p0\..*(checkoutPooledConnection|getConnection)|BasicResourcePool\.awaitAvailable/, name: 'c3p0', fix: 'maxPoolSize and slow queries' },
      { re: /oracle\.ucp\..*(borrowConnection|getConnection)/, name: 'Oracle UCP', fix: 'maxPoolSize and slow queries' },
      { re: /org\.apache\.commons\.pool2\.impl\.GenericObjectPool\.borrowObject/, name: 'commons-pool (e.g. Redis/Jedis or LDAP)', fix: 'maxTotal and how long borrowers hold objects' },
      { re: /PoolingHttpClientConnectionManager.*(leaseConnection|get)|AbstractConnPool\.(getPoolEntryBlocking|lease)|StrictConnPool\.(lease|getPoolEntryBlocking)/, name: 'Apache HttpClient connection pool', fix: 'maxConnPerRoute / maxConnTotal and response times of the downstream' }
    ];
    poolRes.forEach((p) => {
      const waiting = T.filter((t) => t.state !== 'RUNNABLE' && anyFrame(t, p.re, 25));
      if (waiting.length >= 3) {
        H.push({ level: waiting.length >= 10 ? 'bad' : 'warn', title: `Likely ${p.name} exhaustion: ${plural(waiting.length, 'thread')} waiting to borrow a connection`,
          text: `They are parked inside the pool's borrow call, so every connection was in use when this dump was taken. Check ${p.fix}. Look at what the threads that <b>do</b> have a connection are doing (often slow SQL in socketRead below).` });
      }
    });

    // slow downstream: threads reading a socket
    const reading = T.filter((t) => t.state === 'RUNNABLE' && t.frames.length && /socketRead0|SocketInputStream\.(socketRead|read)|NioSocketImpl\.(read|implRead|timedRead|park)|SocketDispatcher\.read|SocketChannelImpl\.read|SSLSocketImpl\$AppInputStream\.read|Net\.poll/.test(t.frames.slice(0, 10).join('\n')) && !/accept/i.test(t.frames.slice(0, 6).join('\n')));
    if (reading.length >= 5 || (reading.length >= 3 && pct(reading.length, app.length) >= 20)) {
      const by = { database: 0, http: 0, other: 0 };
      reading.forEach((t) => {
        const s = t.frames.join('\n');
        if (/org\.postgresql|com\.mysql|org\.mariadb|oracle\.jdbc|com\.microsoft\.sqlserver|com\.ibm\.db2|net\.sourceforge\.jtds|jdbc/i.test(s)) by.database++;
        else if (/org\.apache\.http|okhttp3|java\.net\.http|HttpURLConnection|HttpClient|feign|RestTemplate|WebClient|netty/i.test(s)) by.http++;
        else by.other++;
      });
      const parts = [];
      if (by.database) parts.push(`${by.database} in a JDBC driver (waiting for the database)`);
      if (by.http) parts.push(`${by.http} in an HTTP client (waiting for another service)`);
      if (by.other) parts.push(`${by.other} elsewhere`);
      H.push({ level: reading.length >= 20 ? 'bad' : 'warn', title: `${plural(reading.length, 'thread')} waiting on a network read: likely a slow downstream`,
        text: `"RUNNABLE" here does not mean busy on CPU; they are blocked reading a socket: ${parts.join(', ')}. Check the downstream's response times for the same moment and make sure read timeouts are set. If it is the database, check slow-query logs and locks there.` });
    }

    // blocked on logging
    const logRe = /org\.apache\.log4j\.|org\.apache\.logging\.log4j\.|ch\.qos\.logback\.|java\.util\.logging\.|org\.slf4j\.impl\./;
    const logBlocked = T.filter((t) => (t.state === 'BLOCKED' || t.state === 'WAITING') && t.frames.slice(0, 12).some((f) => logRe.test(f)) && t.locks.some((l) => l.kind === 'waiting to lock' || l.kind === 'parking to wait for'));
    if (logBlocked.length >= 3) {
      H.push({ level: logBlocked.length >= 10 ? 'bad' : 'warn', title: `${plural(logBlocked.length, 'thread')} blocked inside the logging framework`,
        text: 'A synchronous appender is serialising threads: only one can write at a time. Check log volume (DEBUG left on?), slow disk or console output, and consider an async appender with a bounded queue.' });
    }

    // other well-known bottlenecks
    const known = [
      { re: /SecureRandom|NativePRNG|SeedGenerator/, title: 'blocked in SecureRandom', text: 'Random number generation is serialised or waiting for entropy. Check <code>-Djava.security.egd=file:/dev/./urandom</code> (older JDKs) and avoid sharing one SecureRandom across threads.' },
      { re: /ClassLoader\.loadClass|ClassLoader\.getClassLoadingLock/, title: 'blocked loading classes', text: 'Class loading is contended, often at warm-up or when code loads classes (e.g. reflection, JAXB, XML factories) on every request. Check whether it persists after warm-up; cache factories.' },
      { re: /java\.util\.Hashtable\.|Collections\$Synchronized|java\.util\.Vector\./, title: 'blocked on a synchronized collection', text: 'A shared Hashtable / synchronized collection is a hotspot. Consider ConcurrentHashMap or reducing sharing.' },
      { re: /sun\.nio\.fs\.|java\.io\.FileOutputStream|FileChannelImpl/, title: 'blocked on file I/O', text: 'Threads are queued on file access. Check disk latency and whether a single file is being written by many threads.' }
    ];
    known.forEach((k) => {
      const n = T.filter((t) => t.state === 'BLOCKED' && t.frames.slice(0, 10).some((f) => k.re.test(f))).length;
      if (n >= 3) H.push({ level: 'warn', title: `${plural(n, 'thread')} ${k.title}`, text: k.text });
    });

    // most contended lock
    const top = r.contended[0];
    if (top && top.contenders >= 3) {
      const h = top.holders[0];
      const hText = h ? `held by <b>${esc(h.t.name)}</b> (${esc(h.t.state)}${h.t.frames[0] ? ' at ' + esc(shortFrame(h.t.frames[0])) : ''})` : 'with no owner in this dump (possibly just released)';
      H.push({ level: top.contenders >= 10 ? 'bad' : 'warn', title: `Hot lock: ${plural(top.contenders, 'thread')} waiting for <${top.addr}>`,
        text: `The lock is a ${esc(top.cls || 'monitor')}, ${hText}. Check what the holder is doing: if it is slow I/O inside a synchronized block, move the I/O out of the lock. See the lock table below.` });
    }

    // saturated pools
    r.pools.forEach((p) => {
      if (p.cat !== 'app' || p.count < 10 || p.name.indexOf('#') < 0) return;
      if (p.active / p.count >= 0.9) {
        H.push({ level: 'warn', title: `Pool "${p.name}" looks saturated: ${p.active} of ${p.count} threads busy`,
          text: 'Nearly every thread in this pool is doing work, so new tasks queue. If this is the request pool (e.g. Tomcat maxThreads), check what the busy threads are waiting on before raising the size; more threads only help if the bottleneck is not shared.' });
      }
    });

    // pinning of virtual threads (JDK 21+)
    const pinned = T.filter((t) => anyFrame(t, /VirtualThread\.parkOnCarrierThread/, 8));
    if (pinned.length >= 2) {
      H.push({ level: 'warn', title: `${plural(pinned.length, 'carrier thread')} blocked by pinned virtual threads`,
        text: 'A virtual thread parked while pinned to its carrier (inside synchronized or a native frame on JDK 21-23), so the carrier cannot run other work. Check with <code>-Djdk.tracePinnedThreads=full</code> or JFR <code>jdk.VirtualThreadPinned</code>; JDK 24+ removes most synchronized pinning.' });
    }

    // lots of threads
    if (total >= 1000) {
      H.push({ level: 'warn', title: `${total.toLocaleString('en-AU')} threads in one JVM`,
        text: 'That is a lot of platform threads: each reserves stack memory and adds scheduling cost. Check for unbounded pools (e.g. newCachedThreadPool) or a thread leak; compare counts across dumps taken minutes apart.' });
    }

    // blocked share
    const blocked = T.filter((t) => t.state === 'BLOCKED').length;
    if (blocked >= 5 && !H.some((h) => /Hot lock|logging|Deadlock/.test(h.title))) {
      H.push({ level: 'warn', title: `${plural(blocked, 'thread')} BLOCKED on monitors`, text: 'Threads are queuing to enter synchronized code. The lock table below shows which monitors and who holds them.' });
    }

    // GC / compiler CPU
    if (r.cpu.known) {
      const tot = r.cpu.gc + r.cpu.compiler + r.cpu.jvm + r.cpu.app;
      if (tot > 0) {
        const g = r.cpu.gc / tot;
        if (g >= 0.25) {
          H.push({ level: 'warn', title: `GC threads used ${Math.round(g * 100)}% of the CPU time recorded in this dump`,
            text: 'Garbage collection is a big share of CPU since JVM start. Check the GC log for frequent or long pauses (try the <a href="/tools/gc-log/">GC log analyser</a>) and heap sizing.' });
        }
        const c = r.cpu.compiler / tot;
        if (c >= 0.3) H.push({ level: 'info', title: `JIT compiler threads used ${Math.round(c * 100)}% of recorded CPU`, text: 'Normal during warm-up. If the JVM has been up a long time, check code cache size (<code>-XX:ReservedCodeCacheSize</code>) and for deoptimisation loops.' });
      }
    }

    if (!H.length) {
      const idle = T.filter((t) => t.cls === 'idle').length;
      H.push({ level: 'ok', title: 'No common problem pattern found in this dump', text: `${pct(idle, total)}% of threads are idle (waiting for work). That is what a healthy, lightly loaded JVM looks like; if you were chasing a slowdown, take dumps <b>while</b> it is slow, 3 of them 5-10 seconds apart.` });
    }
    return H;
  }

  function shortFrame(f) { return String(f).replace(/^(java\.base\/|app\/\/)/, '').replace(/\((.*?)\)$/, (m, a) => '(' + a.replace(/^.*\//, '') + ')'); }

  // ---------- across dumps ----------
  function compareDumps(dumps) {
    if (dumps.length < 2) return null;
    // identity: name + tid when both available, else name
    const keyOf = (t) => (t.tid ? t.name + '|' + t.tid : t.name);
    const maps = dumps.map((d) => { const m = new Map(); d.threads.forEach((t) => m.set(keyOf(t), t)); return m; });
    const rows = [];
    for (const [k, t0] of maps[0]) {
      const seq = maps.map((m) => m.get(k));
      if (seq.some((x) => !x)) continue;
      if (seq.every((x) => !x.frames.length)) continue;
      const sameStack = seq.every((x) => stackKey(x) === stackKey(t0));
      const sameTop = seq.every((x) => x.state === t0.state && x.frames.slice(0, 3).join('|') === t0.frames.slice(0, 3).join('|'));
      const allIdle = seq.every((x) => x.cls === 'idle');
      let verdict;
      if (allIdle) verdict = 'idle';
      else if (sameStack || sameTop) verdict = 'stuck';
      else verdict = 'moving';
      let cpuDelta = null;
      if (seq.every((x) => x.cpuMs != null)) cpuDelta = seq[seq.length - 1].cpuMs - seq[0].cpuMs;
      rows.push({ name: t0.name, state: t0.state, states: seq.map((x) => x.state), top: t0.frames[0] || '', frames: t0.frames, verdict, sameStack, cpuDelta, cat: t0.cat, pool: t0.pool });
    }
    const stuck = rows.filter((r) => r.verdict === 'stuck');
    // group stuck threads by their (identical) top frames
    const gm = new Map();
    stuck.forEach((r) => {
      const k = r.state + '|' + r.frames.slice(0, 3).join('|');
      let g = gm.get(k); if (!g) { g = { state: r.state, frames: r.frames, rows: [] }; gm.set(k, g); }
      g.rows.push(r);
    });
    const stuckGroups = [...gm.values()].sort((a, b) => b.rows.length - a.rows.length);
    const counts = { stuck: stuck.length, moving: rows.filter((r) => r.verdict === 'moving').length, idle: rows.filter((r) => r.verdict === 'idle').length, matched: rows.length };
    const spinning = stuck.filter((r) => r.state === 'RUNNABLE' && r.cpuDelta != null && r.cpuDelta > 0 && !/socketRead|SocketInputStream|NioSocketImpl|SocketDispatcher|Net\.poll|EPoll|KQueue/.test(r.frames.slice(0, 6).join('\n')));
    const hints = [];
    const appStuck = stuck.filter((r) => r.cat === 'app');
    if (appStuck.length) {
      const g = stuckGroups.find((x) => x.rows.some((r) => r.cat === 'app'));
      hints.push({ level: appStuck.length >= 10 ? 'bad' : 'warn', title: `${plural(appStuck.length, 'application thread')} in the same place in all ${dumps.length} dumps`,
        text: `These did not move between dumps, so they are stuck or waiting on something slow, not just caught mid-request. The biggest group (${g.rows.length}) is ${esc(g.state)} in <code>${esc(shortFrame(g.frames.find((f) => !/^(java\.|javax\.|jdk\.|sun\.|com\.sun\.)/.test(f)) || g.frames[0] || ''))}</code>.` });
    }
    if (spinning.length) {
      hints.push({ level: 'warn', title: `${plural(spinning.length, 'thread')} RUNNABLE in the same frames and using CPU`,
        text: `They used CPU between dumps without their stack changing (largest: ${Math.round(Math.max(...spinning.map((s) => s.cpuDelta)))} ms). Likely a hot loop or a long computation; check the top frame in the code. Confirm with <code>top -H -p &lt;pid&gt;</code> (thread ids map to nid in hex).` });
    }
    const sizes = dumps.map((d) => d.threads.length);
    if (sizes[sizes.length - 1] - sizes[0] >= 50) {
      hints.push({ level: 'warn', title: `Thread count grew from ${sizes[0]} to ${sizes[sizes.length - 1]} between dumps`, text: 'A steadily growing count points at a thread leak or an unbounded pool. Compare which pool names grew.' });
    }
    return { rows, counts, stuckGroups, hints, sizes };
  }

  // ---------- top-level ----------
  function analyse(inputs) {
    // inputs: string or array of strings (files)
    const texts = Array.isArray(inputs) ? inputs : [inputs];
    const dumps = [];
    const unsupported = [];
    texts.forEach((text, fi) => {
      if (!text || !text.trim()) return;
      const fmt = detectFormat(text);
      if (!fmt) { unsupported.push(fi); return; }
      if (fmt === 'json') {
        const p = parseJson(text); p.format = 'jcmd Thread.dump_to_file (JSON)'; dumps.push(p); return;
      }
      if (fmt === 'javacore') {
        const p = parseJavacore(text.replace(/\r\n?/g, '\n').split('\n'));
        const tm = /1TIDATETIME\s+Date:\s*(.*)$/m.exec(text);
        p.ts = tm ? tm[1].trim() : null; p.header = 'OpenJ9 javacore'; p.format = 'OpenJ9 javacore (best effort)'; dumps.push(p); return;
      }
      splitDumps(text).forEach((d) => {
        const p = fmt === 'dumpToFile' ? parseDumpToFileText(d.lines) : parseHotspot(d.lines);
        if (!p.threads.length) return;
        p.header = d.header; p.ts = d.ts;
        p.format = fmt === 'dumpToFile' ? 'jcmd Thread.dump_to_file (text)' : 'HotSpot (jstack / jcmd Thread.print / kill -3)';
        dumps.push(p);
      });
    });
    if (!dumps.length) {
      throw new Error(unsupported.length
        ? "That doesn't look like a Java thread dump. Expected HotSpot output (lines like \"http-nio-8080-exec-1\" #42 daemon prio=5 ... and java.lang.Thread.State:), jcmd Thread.dump_to_file output, or an OpenJ9 javacore."
        : 'Paste a thread dump or drop a file first.');
    }
    const analysed = dumps.map(analyseDump);
    return { dumps: analysed, compare: compareDumps(analysed) };
  }

  // ---------- synthetic sample ----------
  // Deterministic generator for a realistic Spring Boot / Tomcat / HikariCP service on JDK 17.
  function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  const hex = (n, w) => '0x' + n.toString(16).padStart(w || 16, '0');

  function sampleDump(opts) {
    const o = Object.assign({ seed: 7, n: 0, ts: '2026-11-06 14:32:10', deadlock: false, execThreads: 200, poolWaiters: 150, dbReaders: 20, logBlocked: 0, extraIdle: 0 }, opts || {});
    const R = rng(o.seed);
    const out = [];
    let num = 1, nid = 0x2a00, tidBase = 0x7f3a2c000000;
    const lockAddr = (k) => hex(0x0000000700000000 + k * 0x1a8, 16);
    const uptime = 3612.4 + o.n * 7;
    const head = (name, daemon, prio, state, desc, cpu) => {
      const n = num++; nid += 1;
      const tid = hex(tidBase + n * 0x1800, 16);
      return `"${name}" #${n} ${daemon ? 'daemon ' : ''}prio=${prio} os_prio=0 cpu=${cpu.toFixed(2)}ms elapsed=${(uptime - R() * 3).toFixed(2)}s tid=${tid} nid=${hex(nid, 0)} ${desc}  [${hex(0x7f3a1b000000 + n * 0x100000, 16)}]\n   java.lang.Thread.State: ${state}`;
    };
    const scale = o.execThreads / 200;
    const vmLine = (name, cpu) => { const n = nid += 1; return `"${name}" os_prio=0 cpu=${cpu.toFixed(2)}ms elapsed=${uptime.toFixed(2)}s tid=${hex(tidBase + n * 0x400, 16)} nid=${hex(n, 0)} runnable  \n`; };
    const tomcatTail = [
      'org.springframework.web.servlet.FrameworkServlet.service(FrameworkServlet.java:885)',
      'jakarta.servlet.http.HttpServlet.service(HttpServlet.java:658)',
      'org.apache.catalina.core.ApplicationFilterChain.internalDoFilter(ApplicationFilterChain.java:205)',
      'org.apache.catalina.core.ApplicationFilterChain.doFilter(ApplicationFilterChain.java:149)',
      'org.springframework.web.filter.OncePerRequestFilter.doFilter(OncePerRequestFilter.java:116)',
      'org.apache.catalina.core.StandardWrapperValve.invoke(StandardWrapperValve.java:167)',
      'org.apache.catalina.connector.CoyoteAdapter.service(CoyoteAdapter.java:341)',
      'org.apache.coyote.http11.Http11Processor.service(Http11Processor.java:390)',
      'org.apache.coyote.AbstractProcessorLight.process(AbstractProcessorLight.java:63)',
      'org.apache.coyote.AbstractProtocol$ConnectionHandler.process(AbstractProtocol.java:894)',
      'org.apache.tomcat.util.net.NioEndpoint$SocketProcessor.doRun(NioEndpoint.java:1741)',
      'org.apache.tomcat.util.net.SocketProcessorBase.run(SocketProcessorBase.java:52)',
      'org.apache.tomcat.util.threads.ThreadPoolExecutor.runWorker(ThreadPoolExecutor.java:1191)',
      'org.apache.tomcat.util.threads.ThreadPoolExecutor$Worker.run(ThreadPoolExecutor.java:659)',
      'org.apache.tomcat.util.threads.TaskThread$WrappingRunnable.run(TaskThread.java:61)',
      'java.lang.Thread.run(java.base@17.0.12/Thread.java:840)'
    ];
    const at = (fs) => fs.map((f) => `\tat ${f}`).join('\n');
    const dispatch = [
      'org.springframework.web.servlet.DispatcherServlet.doDispatch(DispatcherServlet.java:1089)',
      'org.springframework.web.servlet.DispatcherServlet.doService(DispatcherServlet.java:979)',
      'org.springframework.web.servlet.FrameworkServlet.processRequest(FrameworkServlet.java:1014)',
      'org.springframework.web.servlet.FrameworkServlet.doGet(FrameworkServlet.java:903)'
    ];
    const ctrl = (m, line) => [
      `com.example.shop.catalog.ProductController.${m}(ProductController.java:${line})`,
      'jdk.internal.reflect.GeneratedMethodAccessor212.invoke(Unknown Source)',
      'org.springframework.web.method.support.InvocableHandlerMethod.doInvoke(InvocableHandlerMethod.java:255)',
      'org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerAdapter.handle(RequestMappingHandlerAdapter.java:917)'
    ];
    const repo = [
      'com.example.shop.catalog.ProductRepository.findByCategory(ProductRepository.java:88)',
      'com.example.shop.catalog.ProductService.listCategory(ProductService.java:54)'
    ];

    out.push(`${o.ts}\nFull thread dump OpenJDK 64-Bit Server VM (17.0.12+7 mixed mode, sharing):\n`);
    out.push(`Threads class SMR info:\n_java_thread_list=${hex(0x7f3a30001e40, 16)}, length=${o.execThreads + 40}, elements={\n${hex(tidBase, 16)}, ...\n}\n`);

    out.push(head('Reference Handler', true, 10, 'RUNNABLE', 'waiting on condition ', 4.1) + '\n' + at([
      'java.lang.ref.Reference.waitForReferencePendingList(java.base@17.0.12/Native Method)',
      'java.lang.ref.Reference.processPendingReferences(java.base@17.0.12/Reference.java:253)',
      'java.lang.ref.Reference$ReferenceHandler.run(java.base@17.0.12/Reference.java:215)']) + '\n');
    out.push(head('Finalizer', true, 8, 'WAITING (on object monitor)', 'in Object.wait() ', 0.4) + '\n' + at([
      'java.lang.Object.wait(java.base@17.0.12/Native Method)']) + `\n\t- waiting on <${lockAddr(1)}> (a java.lang.ref.ReferenceQueue$Lock)\n` + at([
      'java.lang.ref.ReferenceQueue.remove(java.base@17.0.12/ReferenceQueue.java:155)']) + `\n\t- locked <${lockAddr(1)}> (a java.lang.ref.ReferenceQueue$Lock)\n` + at([
      'java.lang.ref.ReferenceQueue.remove(java.base@17.0.12/ReferenceQueue.java:176)',
      'java.lang.ref.Finalizer$FinalizerThread.run(java.base@17.0.12/Finalizer.java:172)']) + '\n');
    out.push(head('Signal Dispatcher', true, 9, 'RUNNABLE', 'runnable ', 0.3) + '\n');
    out.push(head('C2 CompilerThread0', true, 9, 'RUNNABLE', 'waiting on condition ', (48210 + o.n * 120) * o.execThreads / 200) + '\n   No compile task\n');
    out.push(head('C1 CompilerThread0', true, 9, 'RUNNABLE', 'waiting on condition ', (9120 + o.n * 30) * o.execThreads / 200) + '\n   No compile task\n');
    out.push(head('Common-Cleaner', true, 8, 'TIMED_WAITING (parking)', 'waiting on condition ', 12.6) + '\n' + at([
      'jdk.internal.misc.Unsafe.park(java.base@17.0.12/Native Method)']) + `\n\t- parking to wait for  <${lockAddr(2)}> (a java.util.concurrent.locks.AbstractQueuedSynchronizer$ConditionObject)\n` + at([
      'java.util.concurrent.locks.LockSupport.parkNanos(java.base@17.0.12/LockSupport.java:252)',
      'java.lang.ref.ReferenceQueue.remove(java.base@17.0.12/ReferenceQueue.java:155)',
      'jdk.internal.ref.CleanerImpl.run(java.base@17.0.12/CleanerImpl.java:140)',
      'java.lang.Thread.run(java.base@17.0.12/Thread.java:840)']) + '\n');

    // HikariCP housekeeper
    out.push(head('HikariPool-1 housekeeper', true, 5, 'TIMED_WAITING (parking)', 'waiting on condition ', 310.5) + '\n' + at([
      'jdk.internal.misc.Unsafe.park(java.base@17.0.12/Native Method)']) + `\n\t- parking to wait for  <${lockAddr(3)}> (a java.util.concurrent.locks.AbstractQueuedSynchronizer$ConditionObject)\n` + at([
      'java.util.concurrent.locks.LockSupport.parkNanos(java.base@17.0.12/LockSupport.java:252)',
      'java.util.concurrent.ScheduledThreadPoolExecutor$DelayedWorkQueue.take(java.base@17.0.12/ScheduledThreadPoolExecutor.java:1182)',
      'java.util.concurrent.ThreadPoolExecutor.getTask(java.base@17.0.12/ThreadPoolExecutor.java:1062)',
      'java.util.concurrent.ThreadPoolExecutor.runWorker(java.base@17.0.12/ThreadPoolExecutor.java:1122)',
      'java.util.concurrent.ThreadPoolExecutor$Worker.run(java.base@17.0.12/ThreadPoolExecutor.java:635)',
      'java.lang.Thread.run(java.base@17.0.12/Thread.java:840)']) + '\n');

    // Tomcat acceptor + poller
    out.push(head('http-nio-8080-Poller', true, 5, 'RUNNABLE', 'runnable ', 20410.2 + o.n * 50) + '\n' + at([
      'sun.nio.ch.EPoll.wait(java.base@17.0.12/Native Method)',
      'sun.nio.ch.EPollSelectorImpl.doSelect(java.base@17.0.12/EPollSelectorImpl.java:118)',
      'sun.nio.ch.SelectorImpl.lockAndDoSelect(java.base@17.0.12/SelectorImpl.java:129)']) + `\n\t- locked <${lockAddr(4)}> (a sun.nio.ch.Util$2)\n\t- locked <${lockAddr(5)}> (a sun.nio.ch.EPollSelectorImpl)\n` + at([
      'sun.nio.ch.SelectorImpl.select(java.base@17.0.12/SelectorImpl.java:141)',
      'org.apache.tomcat.util.net.NioEndpoint$Poller.run(NioEndpoint.java:805)',
      'java.lang.Thread.run(java.base@17.0.12/Thread.java:840)']) + '\n');
    out.push(head('http-nio-8080-Acceptor', true, 5, 'RUNNABLE', 'runnable ', 1820.7) + '\n' + at([
      'sun.nio.ch.Net.accept(java.base@17.0.12/Native Method)',
      'sun.nio.ch.ServerSocketChannelImpl.implAccept(java.base@17.0.12/ServerSocketChannelImpl.java:425)',
      'sun.nio.ch.ServerSocketChannelImpl.accept(java.base@17.0.12/ServerSocketChannelImpl.java:391)']) + `\n\t- locked <${lockAddr(6)}> (a java.lang.Object)\n` + at([
      'org.apache.tomcat.util.net.NioEndpoint.serverSocketAccept(NioEndpoint.java:521)',
      'org.apache.tomcat.util.net.Acceptor.run(Acceptor.java:129)',
      'java.lang.Thread.run(java.base@17.0.12/Thread.java:840)']) + '\n');

    // request threads
    const auditLock = lockAddr(40);
    const readerLo = o.poolWaiters + 1, readerHi = o.poolWaiters + o.dbReaders;
    const others = o.execThreads - o.dbReaders - o.logBlocked;
    for (let i = 1; i <= o.execThreads; i++) {
      const name = `http-nio-8080-exec-${i}`;
      let body;
      // pool waiters rotate a little between dumps (some get a connection, others take their place)
      const pos = i < readerLo ? i - 1 : i - o.dbReaders - o.logBlocked - 1;
      const isWaiter = !(i >= readerLo && i <= readerHi + o.logBlocked) && others > 0 && ((pos + o.n * 9) % others) < o.poolWaiters;
      if (isWaiter) {
        body = head(name, true, 5, 'TIMED_WAITING (parking)', 'waiting on condition ', 900 + R() * 400 + o.n * 2) + '\n' + at([
          'jdk.internal.misc.Unsafe.park(java.base@17.0.12/Native Method)']) + `\n\t- parking to wait for  <${lockAddr(7)}> (a java.util.concurrent.SynchronousQueue$TransferStack)\n` + at([
          'java.util.concurrent.locks.LockSupport.parkNanos(java.base@17.0.12/LockSupport.java:252)',
          'java.util.concurrent.SynchronousQueue$TransferStack.transfer(java.base@17.0.12/SynchronousQueue.java:401)',
          'java.util.concurrent.SynchronousQueue.poll(java.base@17.0.12/SynchronousQueue.java:903)',
          'com.zaxxer.hikari.util.ConcurrentBag.borrow(ConcurrentBag.java:151)',
          'com.zaxxer.hikari.pool.HikariPool.getConnection(HikariPool.java:180)',
          'com.zaxxer.hikari.pool.HikariPool.getConnection(HikariPool.java:146)',
          'com.zaxxer.hikari.HikariDataSource.getConnection(HikariDataSource.java:128)',
          'org.springframework.jdbc.datasource.DataSourceUtils.fetchConnection(DataSourceUtils.java:160)',
          'org.springframework.jdbc.datasource.DataSourceUtils.doGetConnection(DataSourceUtils.java:118)',
          'org.springframework.jdbc.core.JdbcTemplate.execute(JdbcTemplate.java:376)',
          'org.springframework.jdbc.core.JdbcTemplate.query(JdbcTemplate.java:465)']
          .concat(repo, ctrl('listByCategory', 41), dispatch, tomcatTail));
      } else if (i >= readerLo && i <= readerHi) {
        body = head(name, true, 5, 'RUNNABLE', 'runnable ', 4200 + R() * 900 + o.n * 1.5) + '\n' + at([
          'sun.nio.ch.Net.poll(java.base@17.0.12/Native Method)',
          'sun.nio.ch.NioSocketImpl.park(java.base@17.0.12/NioSocketImpl.java:186)',
          'sun.nio.ch.NioSocketImpl.timedRead(java.base@17.0.12/NioSocketImpl.java:290)',
          'sun.nio.ch.NioSocketImpl.implRead(java.base@17.0.12/NioSocketImpl.java:314)',
          'sun.nio.ch.NioSocketImpl.read(java.base@17.0.12/NioSocketImpl.java:355)',
          'sun.nio.ch.NioSocketImpl$1.read(java.base@17.0.12/NioSocketImpl.java:808)',
          'java.net.Socket$SocketInputStream.read(java.base@17.0.12/Socket.java:966)',
          'org.postgresql.core.VisibleBufferedInputStream.readMore(VisibleBufferedInputStream.java:161)',
          'org.postgresql.core.VisibleBufferedInputStream.ensureBytes(VisibleBufferedInputStream.java:128)',
          'org.postgresql.core.PGStream.receiveChar(PGStream.java:465)',
          'org.postgresql.core.v3.QueryExecutorImpl.processResults(QueryExecutorImpl.java:2155)',
          'org.postgresql.core.v3.QueryExecutorImpl.execute(QueryExecutorImpl.java:368)']) + `\n\t- locked <${lockAddr(100 + i)}> (a org.postgresql.core.v3.QueryExecutorImpl)\n` + at([
          'org.postgresql.jdbc.PgStatement.executeInternal(PgStatement.java:498)',
          'org.postgresql.jdbc.PgPreparedStatement.executeQuery(PgPreparedStatement.java:134)',
          'com.zaxxer.hikari.pool.HikariProxyPreparedStatement.executeQuery(HikariProxyPreparedStatement.java)',
          'org.springframework.jdbc.core.JdbcTemplate$1.doInPreparedStatement(JdbcTemplate.java:732)',
          'org.springframework.jdbc.core.JdbcTemplate.execute(JdbcTemplate.java:658)',
          'org.springframework.jdbc.core.JdbcTemplate.query(JdbcTemplate.java:465)']
          .concat(repo, ctrl('listByCategory', 41), dispatch, tomcatTail)) + '\n\n   Locked ownable synchronizers:\n\t- None';
      } else if (i > readerHi && i <= readerHi + o.logBlocked) {
        const holder = i === readerHi + 1;
        body = head(name, true, 5, holder ? 'RUNNABLE' : 'BLOCKED (on object monitor)', holder ? 'runnable ' : 'waiting for monitor entry ', 2100 + R() * 300) + '\n' + at(holder ? [
          'java.io.FileOutputStream.writeBytes(java.base@17.0.12/Native Method)',
          'java.io.FileOutputStream.write(java.base@17.0.12/FileOutputStream.java:349)',
          'com.example.shop.audit.AuditTrail.append(AuditTrail.java:63)'] : ['com.example.shop.audit.AuditTrail.append(AuditTrail.java:58)']) +
          `\n\t- ${holder ? 'locked' : 'waiting to lock'} <${auditLock}> (a com.example.shop.audit.AuditTrail)\n` + at([
          'com.example.shop.checkout.CheckoutService.placeOrder(CheckoutService.java:119)',
          'com.example.shop.checkout.CheckoutController.submit(CheckoutController.java:47)',
          'jdk.internal.reflect.GeneratedMethodAccessor230.invoke(Unknown Source)',
          'org.springframework.web.method.support.InvocableHandlerMethod.doInvoke(InvocableHandlerMethod.java:255)'].concat(dispatch, tomcatTail));
      } else {
        body = head(name, true, 5, 'WAITING (parking)', 'waiting on condition ', 800 + R() * 300) + '\n' + at([
          'jdk.internal.misc.Unsafe.park(java.base@17.0.12/Native Method)']) + `\n\t- parking to wait for  <${lockAddr(8)}> (a java.util.concurrent.locks.AbstractQueuedSynchronizer$ConditionObject)\n` + at([
          'java.util.concurrent.locks.LockSupport.park(java.base@17.0.12/LockSupport.java:341)',
          'java.util.concurrent.locks.AbstractQueuedSynchronizer$ConditionNode.block(java.base@17.0.12/AbstractQueuedSynchronizer.java:506)',
          'java.util.concurrent.ForkJoinPool.unmanagedBlock(java.base@17.0.12/ForkJoinPool.java:3465)',
          'java.util.concurrent.ForkJoinPool.managedBlock(java.base@17.0.12/ForkJoinPool.java:3436)',
          'java.util.concurrent.locks.AbstractQueuedSynchronizer$ConditionObject.await(java.base@17.0.12/AbstractQueuedSynchronizer.java:1623)',
          'java.util.concurrent.LinkedBlockingQueue.take(java.base@17.0.12/LinkedBlockingQueue.java:435)',
          'org.apache.tomcat.util.threads.TaskQueue.take(TaskQueue.java:117)',
          'org.apache.tomcat.util.threads.TaskQueue.take(TaskQueue.java:33)',
          'org.apache.tomcat.util.threads.ThreadPoolExecutor.getTask(ThreadPoolExecutor.java:1114)',
          'org.apache.tomcat.util.threads.ThreadPoolExecutor.runWorker(ThreadPoolExecutor.java:1176)',
          'org.apache.tomcat.util.threads.ThreadPoolExecutor$Worker.run(ThreadPoolExecutor.java:659)',
          'org.apache.tomcat.util.threads.TaskThread$WrappingRunnable.run(TaskThread.java:61)',
          'java.lang.Thread.run(java.base@17.0.12/Thread.java:840)']);
      }
      out.push(body + '\n');
    }

    // scheduled workers
    for (let i = 1; i <= 4 + o.extraIdle; i++) {
      out.push(head(`scheduling-${i}`, false, 5, 'TIMED_WAITING (parking)', 'waiting on condition ', 40 + R() * 20) + '\n' + at([
        'jdk.internal.misc.Unsafe.park(java.base@17.0.12/Native Method)']) + `\n\t- parking to wait for  <${lockAddr(9)}> (a java.util.concurrent.locks.AbstractQueuedSynchronizer$ConditionObject)\n` + at([
        'java.util.concurrent.locks.LockSupport.parkNanos(java.base@17.0.12/LockSupport.java:252)',
        'java.util.concurrent.ScheduledThreadPoolExecutor$DelayedWorkQueue.take(java.base@17.0.12/ScheduledThreadPoolExecutor.java:1182)',
        'java.util.concurrent.ThreadPoolExecutor.getTask(java.base@17.0.12/ThreadPoolExecutor.java:1062)',
        'java.util.concurrent.ThreadPoolExecutor.runWorker(java.base@17.0.12/ThreadPoolExecutor.java:1122)',
        'java.util.concurrent.ThreadPoolExecutor$Worker.run(java.base@17.0.12/ThreadPoolExecutor.java:635)',
        'java.lang.Thread.run(java.base@17.0.12/Thread.java:840)']) + '\n');
    }

    // optional deadlock between two inventory workers
    let deadlockText = '';
    if (o.deadlock) {
      const a = lockAddr(50), b = lockAddr(51);
      out.push(head('inventory-sync-1', false, 5, 'BLOCKED (on object monitor)', 'waiting for monitor entry ', 512.3) + '\n' + at([
        'com.example.shop.inventory.StockLedger.transfer(StockLedger.java:74)']) + `\n\t- waiting to lock <${b}> (a com.example.shop.inventory.Warehouse)\n\t- locked <${a}> (a com.example.shop.inventory.Warehouse)\n` + at([
        'com.example.shop.inventory.RebalanceJob.run(RebalanceJob.java:39)',
        'java.util.concurrent.Executors$RunnableAdapter.call(java.base@17.0.12/Executors.java:539)',
        'java.util.concurrent.FutureTask.run(java.base@17.0.12/FutureTask.java:264)',
        'java.util.concurrent.ThreadPoolExecutor.runWorker(java.base@17.0.12/ThreadPoolExecutor.java:1136)',
        'java.util.concurrent.ThreadPoolExecutor$Worker.run(java.base@17.0.12/ThreadPoolExecutor.java:635)',
        'java.lang.Thread.run(java.base@17.0.12/Thread.java:840)']) + '\n');
      out.push(head('inventory-sync-2', false, 5, 'BLOCKED (on object monitor)', 'waiting for monitor entry ', 498.9) + '\n' + at([
        'com.example.shop.inventory.StockLedger.transfer(StockLedger.java:74)']) + `\n\t- waiting to lock <${a}> (a com.example.shop.inventory.Warehouse)\n\t- locked <${b}> (a com.example.shop.inventory.Warehouse)\n` + at([
        'com.example.shop.inventory.RebalanceJob.run(RebalanceJob.java:39)',
        'java.util.concurrent.Executors$RunnableAdapter.call(java.base@17.0.12/Executors.java:539)',
        'java.util.concurrent.FutureTask.run(java.base@17.0.12/FutureTask.java:264)',
        'java.util.concurrent.ThreadPoolExecutor.runWorker(java.base@17.0.12/ThreadPoolExecutor.java:1136)',
        'java.util.concurrent.ThreadPoolExecutor$Worker.run(java.base@17.0.12/ThreadPoolExecutor.java:635)',
        'java.lang.Thread.run(java.base@17.0.12/Thread.java:840)']) + '\n');
      deadlockText = `
Found one Java-level deadlock:
=============================
"inventory-sync-1":
  waiting to lock monitor 0x00007f3a24006a80 (object ${b}, a com.example.shop.inventory.Warehouse),
  which is held by "inventory-sync-2"

"inventory-sync-2":
  waiting to lock monitor 0x00007f3a24006b70 (object ${a}, a com.example.shop.inventory.Warehouse),
  which is held by "inventory-sync-1"

Java stack information for the threads listed above:
===================================================
"inventory-sync-1":
\tat com.example.shop.inventory.StockLedger.transfer(StockLedger.java:74)
\t- waiting to lock <${b}> (a com.example.shop.inventory.Warehouse)
\t- locked <${a}> (a com.example.shop.inventory.Warehouse)
\tat com.example.shop.inventory.RebalanceJob.run(RebalanceJob.java:39)
"inventory-sync-2":
\tat com.example.shop.inventory.StockLedger.transfer(StockLedger.java:74)
\t- waiting to lock <${a}> (a com.example.shop.inventory.Warehouse)
\t- locked <${b}> (a com.example.shop.inventory.Warehouse)
\tat com.example.shop.inventory.RebalanceJob.run(RebalanceJob.java:39)

Found 1 deadlock.
`;
    }

    out.push(head('DestroyJavaVM', false, 5, 'RUNNABLE', 'waiting on condition ', 6120.4) + '\n');
    out.push(vmLine('VM Thread', 18210.5 + o.n * 60));
    for (let g = 0; g < 8; g++) out.push(vmLine(`GC Thread#${g}`, (6100 + g * 37 + o.n * 25) * scale));
    out.push(vmLine('G1 Main Marker', 120.2));
    out.push(vmLine('G1 Conc#0', 3110.8));
    out.push(vmLine('G1 Refine#0', 410.1));
    out.push(vmLine('G1 Service', 980.6));
    out.push(vmLine('VM Periodic Task Thread', 2500.0));
    out.push('JNI global refs: 24, weak refs: 0\n');
    return out.join('\n') + deadlockText;
  }

  function sample(kind) {
    if (kind === 'deadlock') return sampleDump({ seed: 11, execThreads: 40, poolWaiters: 0, dbReaders: 2, logBlocked: 6, deadlock: true });
    // three dumps 7 seconds apart during a slowdown
    return [0, 1, 2].map((n) => sampleDump({ seed: 7 + n, n, ts: `2026-11-06 14:32:${String(10 + n * 7).padStart(2, '0')}` })).join('\n\n');
  }

  const api = { analyse, splitDumps, detectFormat, parseHotspot, parseJson, parseJavacore, parseDumpToFileText, analyseDump, compareDumps, findCycles, poolName, shortFrame, sample, sampleDump, esc };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TDump = api;
})(typeof window !== 'undefined' ? window : this);
