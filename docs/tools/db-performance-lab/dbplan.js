/* Database Performance Lab: pure functions, no DOM. Runs in the browser (window.DBPlanLab), in worker.js and in Node
   (module.exports) for toolkit-tests/db-performance-lab.test.js. Nothing is sent anywhere.

   detect(text)                'pg-text' | 'pg-json' | 'mysql-json' | 'mysql-tree' | 'mssql-xml' | 'stats-csv' | 'mysql-slowlog' | ''
   parsePlan(text, format)     any supported plan → { engine, format, root, planningMs, executionMs, jit, triggers, warnings }
   analysePlan(text, opts)     parse + per-node exclusive/inclusive time, misestimates, findings with fixes, summary
   analyseStats(text)          pg_stat_statements / MySQL digest or slow_log CSV / SQL Server query stats CSV / MySQL slow
                               log → queries ranked by total time with flags
   analyse(text, opts)         routes to analysePlan or analyseStats
   columnsFromCond(cond)       equality, range and function-wrapped columns in a filter
   samples                     example input for every format
   toMarkdown(result)          summary that pastes into Jira, GitHub or Slack */
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ helpers
  const num = x => { const n = Number(x); return isFinite(n) ? n : 0; };
  const has = x => x != null && x !== '';
  function fmtMs(ms) {
    if (ms == null || !isFinite(ms)) return '—';
    const a = Math.abs(ms);
    if (a < 1) return ms.toFixed(3) + ' ms';
    if (a < 10) return ms.toFixed(2) + ' ms';
    if (a < 1000) return ms.toFixed(1) + ' ms';
    if (a < 60000) return (ms / 1000).toFixed(2) + ' s';
    return (ms / 60000).toFixed(1) + ' min';
  }
  const fmtN = x => (x == null || !isFinite(x) ? '—' : Math.round(x).toLocaleString('en-AU'));
  const fmtKB = kb => (kb >= 1048576 ? (kb / 1048576).toFixed(1) + ' GB' : kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB' : Math.round(kb) + ' kB');
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);
  const short = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const plural = (n, w, ws) => fmtN(n) + ' ' + (n === 1 ? w : (ws || w + 's'));
  const BIG = 10000; // "large table" threshold in rows

  // ------------------------------------------------------------------ detection
  function detect(text) {
    const s = String(text || '').replace(/^﻿/, '').trim();
    if (!s) return '';
    if (/^</.test(s) && /ShowPlanXML|<RelOp\b/i.test(s.slice(0, 5000))) return 'mssql-xml';
    if (/^[[{]/.test(s)) {
      try {
        let o = JSON.parse(s);
        if (Array.isArray(o)) o = o[0];
        if (o && o['QUERY PLAN']) o = Array.isArray(o['QUERY PLAN']) ? o['QUERY PLAN'][0] : o['QUERY PLAN'];
        if (o && o.Plan) return 'pg-json';
        if (o && (o.query_block || (o.EXPLAIN && o.EXPLAIN.query_block))) return 'mysql-json';
        if (o && (o.operation || o.inputs) && (o.query || o.estimated_rows != null || o.access_type)) return 'mysql-json';
      } catch (e) { /* fall through */ }
    }
    if (/^#\s*(Time|User@Host|Query_time):/m.test(s) && /Query_time:\s*[\d.]+/.test(s)) return 'mysql-slowlog';
    const first = s.split(/\r?\n/, 1)[0].toLowerCase();
    if (/[,;\t]/.test(first) && /(query|digest_text|sql_text|statement|query_text)/.test(first) && /(calls|count_star|exec|total|query_time|count)/.test(first)) return 'stats-csv';
    if (/\(cost=[\d.]+\.\.[\d.]+ rows=\d+(?:\.\d+)? width=\d+\)|\(actual time=[\d.]+\.\.[\d.]+ rows=[\d.]+ loops=\d+\)|^\s*(?:->\s*)?(Seq Scan|Index Scan|Index Only Scan|Bitmap Heap Scan|Hash Join|Nested Loop|Gather|Aggregate|HashAggregate|Sort|Limit)\b/m.test(s) && !/^\s*(?:\|\s*)?(?:EXPLAIN:\s*)?->/m.test(s)) return 'pg-text';
    if (/(^|\n)\s*(?:\|\s*)?(?:EXPLAIN:\s*)?->\s+\S/.test(s)) {
      if (/width=\d+\)/.test(s)) return 'pg-text';
      return 'mysql-tree';
    }
    return '';
  }
  const FORMAT_LABEL = {
    'pg-text': 'PostgreSQL EXPLAIN (text)', 'pg-json': 'PostgreSQL EXPLAIN (FORMAT JSON)', 'mysql-json': 'MySQL EXPLAIN FORMAT=JSON',
    'mysql-tree': 'MySQL EXPLAIN ANALYZE / FORMAT=TREE', 'mssql-xml': 'SQL Server showplan XML', 'stats-csv': 'Query statistics CSV', 'mysql-slowlog': 'MySQL slow query log',
  };

  // ------------------------------------------------------------------ node model
  function mk(o) {
    return Object.assign({ type: '', label: '', relation: '', alias: '', index: '', est: { rows: null, cost: null, startup: null }, act: null, never: false,
      props: {}, removed: { filter: 0, join: 0, recheck: 0 }, heap: { exact: 0, lossy: 0 }, buffers: {}, sort: null, hash: null, workers: null,
      flags: {}, warnings: [], output: [], children: [], subplan: '' }, o || {});
  }

  // ------------------------------------------------------------------ PostgreSQL text
  const PG_COST = /\(cost=([\d.]+)\.\.([\d.]+) rows=(\d+(?:\.\d+)?) width=(\d+)\)/;
  const PG_ACT = /\(actual time=([\d.]+)\.\.([\d.]+) rows=([\d.]+) loops=(\d+)\)/;
  const PG_ACT_NT = /\(actual rows=([\d.]+) loops=(\d+)\)/;
  function pgLabel(n, label) {
    label = label.trim();
    n.label = label;
    let m = label.match(/^(.*?) using (\S+) on (\S+)(?: (\S+))?$/);
    if (m) { n.type = m[1]; n.index = m[2]; n.relation = m[3]; n.alias = m[4] || ''; return; }
    m = label.match(/^(.*?) on (\S+)(?: (\S+))?$/);
    if (m) {
      n.type = m[1];
      if (/Bitmap Index Scan$/.test(m[1])) n.index = m[2]; else { n.relation = m[2]; n.alias = m[3] || ''; }
      return;
    }
    n.type = label;
  }
  function pgProp(n, line, plan) {
    let m;
    const w = line.match(/^Worker \d+:\s+(.*)$/);
    if (w) { line = w[1]; if (!/^Sort Method|^Buffers|^Batches|^Buckets/.test(line)) return; n.flags.workerDetail = true; }
    if ((m = line.match(/^(Filter|Index Cond|Recheck Cond|Hash Cond|Merge Cond|Join Filter|Sort Key|Group Key|Presorted Key|One-Time Filter|Cache Key|TID Cond|Order By): (.*)$/))) {
      const k = { Filter: 'filter', 'Index Cond': 'indexCond', 'Recheck Cond': 'recheckCond', 'Hash Cond': 'hashCond', 'Merge Cond': 'mergeCond', 'Join Filter': 'joinFilter', 'Sort Key': 'sortKey', 'Group Key': 'groupKey', 'Presorted Key': 'presortedKey', 'One-Time Filter': 'oneTimeFilter', 'Cache Key': 'cacheKey', 'TID Cond': 'tidCond', 'Order By': 'orderBy' }[m[1]];
      n.props[k] = m[2]; return;
    }
    if ((m = line.match(/^Output: (.*)$/))) { n.output = splitTop(m[1]); return; }
    if ((m = line.match(/^Rows Removed by Filter: (\d+)/))) { n.removed.filter = num(m[1]); return; }
    if ((m = line.match(/^Rows Removed by Join Filter: (\d+)/))) { n.removed.join = num(m[1]); return; }
    if ((m = line.match(/^Rows Removed by Index Recheck: (\d+)/))) { n.removed.recheck = num(m[1]); return; }
    if ((m = line.match(/^Heap Blocks: (.*)$/))) { const e = m[1].match(/exact=(\d+)/), l = m[1].match(/lossy=(\d+)/); if (e) n.heap.exact = num(e[1]); if (l) n.heap.lossy = num(l[1]); return; }
    if ((m = line.match(/^Heap Fetches: (\d+)/))) { n.props.heapFetches = num(m[1]); return; }
    if ((m = line.match(/^Buffers: (.*)$/))) { addBuffers(n.buffers, m[1]); return; }
    if ((m = line.match(/^I\/O Timings: (.*)$/))) { const r = m[1].match(/read=([\d.]+)/); if (r) n.buffers.ioReadMs = (n.buffers.ioReadMs || 0) + num(r[1]); return; }
    if ((m = line.match(/^Sort Method: (.+?)\s+(Memory|Disk|Average Memory|Peak Memory|Maximum Storage)?:?\s*(\d+)kB/))) {
      const disk = /external|Disk/.test(m[0]);
      const prev = n.sort;
      n.sort = { method: m[1].trim(), disk: disk || (prev && prev.disk) || false, kb: Math.max(num(m[3]), prev ? prev.kb : 0) };
      if (disk && prev && prev.disk && n.flags.workerDetail) n.sort.kb = prev.kb + num(m[3]);
      return;
    }
    if ((m = line.match(/^Buckets: (\d+)(?: \(originally (\d+)\))?\s+Batches: (\d+)(?: \(originally (\d+)\))?\s+Memory Usage: (\d+)kB/))) {
      n.hash = { buckets: num(m[1]), batches: num(m[3]), origBatches: num(m[4] || m[3]), kb: num(m[5]) }; return;
    }
    if ((m = line.match(/^Batches: (\d+)\s+Memory Usage: (\d+)kB(?:\s+Disk Usage: (\d+)kB)?/))) { // HashAggregate (PG 13+)
      n.hash = { batches: num(m[1]), origBatches: 1, kb: num(m[2]), diskKB: num(m[3] || 0) }; return;
    }
    if ((m = line.match(/^Workers Planned: (\d+)/))) { n.workers = Object.assign(n.workers || {}, { planned: num(m[1]) }); return; }
    if ((m = line.match(/^Workers Launched: (\d+)/))) { n.workers = Object.assign(n.workers || {}, { launched: num(m[1]) }); return; }
    if ((m = line.match(/^Hits: (\d+)\s+Misses: (\d+)/))) { n.props.memoize = m[0]; return; }
    n.props.other = (n.props.other ? n.props.other + '\n' : '') + line;
  }
  function addBuffers(b, s) {
    const grab = (scope, txt) => {
      const re = /(hit|read|dirtied|written)=(\d+)/g; let m;
      while ((m = re.exec(txt))) b[scope + m[1][0].toUpperCase() + m[1].slice(1)] = (b[scope + m[1][0].toUpperCase() + m[1].slice(1)] || 0) + num(m[2]);
    };
    s.split(/,\s*/).forEach(part => {
      const m = part.match(/^(shared|local|temp)\s+(.*)$/);
      if (m) grab(m[1], m[2]);
    });
  }
  function splitTop(s) {
    const out = []; let depth = 0, cur = '';
    for (const ch of s) {
      if (ch === '(') depth++; else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }
  function cleanPlanLines(text) {
    return String(text).replace(/^﻿/, '').split(/\r?\n/).map(l => {
      let x = l.replace(/\s*\+$/, '');
      const q = x.match(/^\s*"(.*)"\s*,?\s*$/); if (q) x = q[1].replace(/""/g, '"');
      x = x.replace(/^\s*\|\s?/, '').replace(/\s*\|\s*$/, '');
      return x;
    }).filter(l => l.trim() && !/^\s*QUERY PLAN\s*$/.test(l) && !/^\s*-{3,}\s*$/.test(l) && !/^\s*[-+]{5,}\s*$/.test(l) && !/^\s*\(\d+ rows?\)\s*$/.test(l));
  }
  function parsePgText(text) {
    const lines = cleanPlanLines(text);
    const plan = { engine: 'postgresql', format: 'pg-text', root: null, planningMs: null, executionMs: null, jit: null, triggers: [], warnings: [], planningBuffers: null };
    const stack = [];
    let mode = '', pending = null, base = null;
    lines.forEach(raw => {
      const indent = raw.search(/\S/);
      const t = raw.trim();
      const isNode = /^->/.test(t) || PG_COST.test(t) || PG_ACT.test(t) || PG_ACT_NT.test(t) || /\(never executed\)/.test(t);
      if (isNode && !/^(Planning|Execution) Time/.test(t)) {
        mode = '';
        const arrow = /^->/.test(t) ? indent : indent;
        if (base == null) base = arrow;
        const label = t.replace(/^->\s*/, '').split(/\s+\((?:cost=|actual |never executed)/)[0];
        const n = mk({ raw: t });
        pgLabel(n, label);
        let m;
        if ((m = t.match(PG_COST))) n.est = { startup: num(m[1]), cost: num(m[2]), rows: num(m[3]), width: num(m[4]) };
        if ((m = t.match(PG_ACT))) n.act = { first: num(m[1]), time: num(m[2]), rows: num(m[3]), loops: num(m[4]) };
        else if ((m = t.match(PG_ACT_NT))) n.act = { first: null, time: null, rows: num(m[1]), loops: num(m[2]) };
        else if (/\(never executed\)/.test(t)) { n.never = true; n.act = { first: 0, time: 0, rows: 0, loops: 0 }; }
        while (stack.length && stack[stack.length - 1].indent >= arrow) stack.pop();
        if (pending && pending.indent < arrow) { n.subplan = pending.label; pending = null; }
        if (!stack.length) {
          if (!plan.root) plan.root = n;
          else { if (!plan.extraRoots) plan.extraRoots = []; plan.extraRoots.push(n); }
        } else stack[stack.length - 1].node.children.push(n);
        stack.push({ indent: arrow, node: n });
        return;
      }
      let m;
      if ((m = t.match(/^Planning [Tt]ime: ([\d.]+) ms/))) { plan.planningMs = num(m[1]); mode = ''; return; }
      if ((m = t.match(/^(?:Execution [Tt]ime|Total runtime): ([\d.]+) ms/))) { plan.executionMs = num(m[1]); mode = ''; return; }
      if (/^JIT:$/.test(t)) { mode = 'jit'; plan.jit = { functions: 0, total: 0, generation: 0, inlining: 0, optimization: 0, emission: 0 }; return; }
      if (/^Planning:$/.test(t)) { mode = 'planning'; return; }
      if ((m = t.match(/^Trigger (.+?): time=([\d.]+) calls=(\d+)/))) { plan.triggers.push({ name: m[1], ms: num(m[2]), calls: num(m[3]) }); return; }
      if (mode === 'jit') {
        if ((m = t.match(/^Functions: (\d+)/))) plan.jit.functions = num(m[1]);
        else if (/^Timing:/.test(t)) { ['Generation', 'Inlining', 'Optimization', 'Emission', 'Total'].forEach(k => { const x = t.match(new RegExp(k + ' ([\\d.]+) ms')); if (x) plan.jit[k.toLowerCase()] = num(x[1]); }); }
        else if ((m = t.match(/^Options: (.*)/))) plan.jit.options = m[1];
        return;
      }
      if (mode === 'planning') { if ((m = t.match(/^Buffers: (.*)$/))) { plan.planningBuffers = {}; addBuffers(plan.planningBuffers, m[1]); } return; }
      if (!plan.root) { (plan.sqlLines = plan.sqlLines || []).push(t); return; } // the query, if pasted above the plan
      if (/^(SubPlan \d+|InitPlan \d+|CTE \S+)/.test(t) && !/:/.test(t.split(' ')[0])) { pending = { label: t, indent }; return; }
      // property line: belongs to the deepest open node indented less than this line
      for (let k = stack.length - 1; k >= 0; k--) if (stack[k].indent < indent || (k === 0 && stack[k].indent <= indent)) { pgProp(stack[k].node, t, plan); return; }
    });
    if (!plan.root) throw new Error('No plan nodes found. Paste the whole EXPLAIN output, starting with the first node line.');
    if (plan.extraRoots) plan.warnings.push('More than one plan was found; only the first is analysed.');
    return plan;
  }

  // ------------------------------------------------------------------ PostgreSQL JSON
  const PGJ_PROPS = { Filter: 'filter', 'Index Cond': 'indexCond', 'Recheck Cond': 'recheckCond', 'Hash Cond': 'hashCond', 'Merge Cond': 'mergeCond', 'Join Filter': 'joinFilter',
    'One-Time Filter': 'oneTimeFilter', 'Cache Key': 'cacheKey', 'Order By': 'orderBy' };
  function pgJsonNode(p) {
    const n = mk();
    let type = p['Node Type'] || '';
    if (type === 'Aggregate' && p.Strategy === 'Hashed') type = 'HashAggregate';
    else if (type === 'Aggregate' && p.Strategy === 'Sorted') type = 'GroupAggregate';
    else if (type === 'Aggregate' && p.Strategy === 'Mixed') type = 'MixedAggregate';
    const jt = p['Join Type'];
    if (jt && jt !== 'Inner') {
      if (type === 'Nested Loop') type += ' ' + jt + ' Join';
      else if (/ Join$/.test(type)) type = type.replace(/ Join$/, ' ' + jt + ' Join');
    }
    if (p['Parallel Aware']) type = 'Parallel ' + type;
    if (p['Partial Mode'] === 'Partial' || p['Partial Mode'] === 'Finalize') type = p['Partial Mode'] + ' ' + type;
    n.type = type;
    n.relation = p['Relation Name'] ? (p.Schema && p.Schema !== 'public' ? p.Schema + '.' : '') + p['Relation Name'] : p['CTE Name'] || p['Function Name'] || '';
    n.alias = p.Alias && p.Alias !== p['Relation Name'] ? p.Alias : '';
    n.index = p['Index Name'] || '';
    n.label = type + (n.index ? ' using ' + n.index : '') + (n.relation ? ' on ' + n.relation + (n.alias ? ' ' + n.alias : '') : n.index && /Bitmap Index/.test(type) ? '' : '');
    if (/Bitmap Index Scan/.test(type)) n.label = type + ' on ' + n.index;
    n.est = { startup: p['Startup Cost'], cost: p['Total Cost'], rows: p['Plan Rows'], width: p['Plan Width'] };
    if (p['Actual Loops'] != null) {
      n.act = { first: p['Actual Startup Time'] != null ? num(p['Actual Startup Time']) : null, time: p['Actual Total Time'] != null ? num(p['Actual Total Time']) : null, rows: num(p['Actual Rows']), loops: num(p['Actual Loops']) };
      if (!n.act.loops) n.never = true;
    }
    Object.keys(PGJ_PROPS).forEach(k => { if (p[k] != null) n.props[PGJ_PROPS[k]] = p[k]; });
    if (p['Sort Key']) n.props.sortKey = [].concat(p['Sort Key']).join(', ');
    if (p['Group Key']) n.props.groupKey = [].concat(p['Group Key']).join(', ');
    if (p.Output) n.output = [].concat(p.Output);
    n.removed = { filter: num(p['Rows Removed by Filter']), join: num(p['Rows Removed by Join Filter']), recheck: num(p['Rows Removed by Index Recheck']) };
    n.heap = { exact: num(p['Exact Heap Blocks']), lossy: num(p['Lossy Heap Blocks']) };
    if (p['Heap Fetches'] != null) n.props.heapFetches = num(p['Heap Fetches']);
    const B = { 'Shared Hit Blocks': 'sharedHit', 'Shared Read Blocks': 'sharedRead', 'Shared Dirtied Blocks': 'sharedDirtied', 'Shared Written Blocks': 'sharedWritten',
      'Local Hit Blocks': 'localHit', 'Local Read Blocks': 'localRead', 'Temp Read Blocks': 'tempRead', 'Temp Written Blocks': 'tempWritten' };
    Object.keys(B).forEach(k => { if (p[k]) n.buffers[B[k]] = num(p[k]); });
    const io = p['Shared I/O Read Time'] != null ? p['Shared I/O Read Time'] : p['I/O Read Time'];
    if (io) n.buffers.ioReadMs = num(io);
    if (p['Sort Method']) {
      let kb = num(p['Sort Space Used']), disk = p['Sort Space Type'] === 'Disk' || /external/.test(p['Sort Method']);
      (p.Workers || []).forEach(w => { if (w['Sort Space Type'] === 'Disk') { disk = true; kb += num(w['Sort Space Used']); } });
      n.sort = { method: p['Sort Method'], disk, kb };
    }
    if (p['Hash Batches'] != null) n.hash = { buckets: num(p['Hash Buckets']), batches: num(p['Hash Batches']), origBatches: num(p['Original Hash Batches'] || p['Hash Batches']), kb: num(p['Peak Memory Usage']) };
    if (p['HashAgg Batches'] != null) n.hash = { batches: num(p['HashAgg Batches']), origBatches: 1, kb: num(p['Peak Memory Usage']), diskKB: num(p['Disk Usage']) };
    if (p['Workers Planned'] != null) n.workers = { planned: num(p['Workers Planned']), launched: p['Workers Launched'] != null ? num(p['Workers Launched']) : null };
    if (p['Subplan Name']) n.subplan = p['Subplan Name'];
    else if (p['Parent Relationship'] === 'InitPlan' || p['Parent Relationship'] === 'SubPlan') n.subplan = p['Parent Relationship'];
    n.children = (p.Plans || []).map(pgJsonNode);
    return n;
  }
  function parsePgJson(text) {
    let o = JSON.parse(String(text).trim());
    let docs = Array.isArray(o) ? o : [o];
    docs = docs.map(d => (d && d['QUERY PLAN'] ? [].concat(d['QUERY PLAN'])[0] : d)).filter(d => d && d.Plan);
    if (!docs.length) throw new Error('No "Plan" object found in the JSON.');
    const d = docs[0];
    const plan = { engine: 'postgresql', format: 'pg-json', root: pgJsonNode(d.Plan), planningMs: d['Planning Time'] != null ? num(d['Planning Time']) : null,
      executionMs: d['Execution Time'] != null ? num(d['Execution Time']) : d['Total Runtime'] != null ? num(d['Total Runtime']) : null, jit: null, triggers: [], warnings: [] };
    if (d.JIT) { const t = d.JIT.Timing || {}; const v = x => (x && typeof x === 'object' ? num(x.Total) : num(x)); plan.jit = { functions: num(d.JIT.Functions), total: v(t.Total), generation: v(t.Generation), inlining: v(t.Inlining), optimization: v(t.Optimization), emission: v(t.Emission) }; }
    (d.Triggers || []).forEach(t => plan.triggers.push({ name: t['Trigger Name'] + (t['Constraint Name'] ? ' for constraint ' + t['Constraint Name'] : ''), ms: num(t.Time), calls: num(t.Calls), relation: t.Relation }));
    if (docs.length > 1) plan.warnings.push(docs.length + ' plans were found; only the first is analysed.');
    return plan;
  }

  // ------------------------------------------------------------------ MySQL tree (EXPLAIN ANALYZE / FORMAT=TREE)
  const MY_ACCESS = /^(Table scan|Index lookup|Single-row index lookup|Index range scan|Covering index scan|Covering index lookup|Covering index range scan|Covering index skip scan|Index scan|Full-text index search|Index skip scan|Constant row from|Multi-range index scan|Single-row covering index lookup|Index range scan \(Multi-Range Read\)|Reverse index scan|Reverse covering index scan|Sort-deduplicate by row ID)\s+on\s+(\S+)(?:\s+using\s+(\S+))?\s*(.*)$/i;
  function myLabel(n, label) {
    n.label = label;
    let m = label.match(MY_ACCESS);
    if (m) {
      n.type = m[1]; n.relation = m[2].replace(/`/g, ''); n.index = (m[3] || '').replace(/`/g, '');
      const rest = (m[4] || '').trim();
      if (rest) n.props.indexCond = rest.replace(/^over\s+/, '').replace(/^\(|\)$/g, '');
      if (n.relation === '<temporary>') n.flags.temporary = true;
      return;
    }
    if ((m = label.match(/^Filter:\s*(.*)$/))) { n.type = 'Filter'; n.props.filter = m[1]; return; }
    if ((m = label.match(/^Sort(?: row IDs)?:\s*(.*)$/))) { n.type = 'Sort'; n.props.sortKey = m[1].replace(/,\s*limit input to .*$/, ''); n.flags.filesort = true; return; }
    if ((m = label.match(/^(Inner|Left|Right|Semi|Anti|Outer|Left anti|Left semi|Full)? ?hash join\s*(.*)$/i))) { n.type = (m[1] ? m[1] + ' hash join' : 'Hash join'); n.props.hashCond = (m[2] || '').replace(/^\(|\)$/g, ''); return; }
    if ((m = label.match(/^Nested loop\s*(.*)$/i))) { n.type = 'Nested loop' + (m[1] ? ' ' + m[1] : ''); return; }
    if (/temporary/i.test(label)) n.flags.temporary = true;
    if ((m = label.match(/^(Aggregate using temporary table|Group aggregate|Aggregate|Limit|Materialize|Stream results|Window aggregate|Hash|Remove duplicates|Temporary table with deduplication|Union materialize|Select #\d+)\b(.*)$/i))) { n.type = m[1]; return; }
    n.type = label.split(/[:(]/)[0].trim() || label;
  }
  const MY_LINE = /^(.*?)(?:\s+\(cost=([\d.e+]+)(?:\.\.([\d.e+]+))? rows=([\d.e+]+)\))?(?:\s+\(actual time=([\d.]+)\.\.([\d.]+) rows=([\d.]+) loops=(\d+)\))?(?:\s+\(never executed\))?\s*$/;
  function parseMyTree(text) {
    const lines = cleanPlanLines(text).map(l => l.replace(/^(\s*)EXPLAIN:\s*/, '$1').replace(/\\n/g, '\n')).join('\n').split('\n').filter(l => l.trim());
    const plan = { engine: 'mysql', format: 'mysql-tree', root: null, planningMs: null, executionMs: null, jit: null, triggers: [], warnings: [] };
    const stack = [];
    let last = null;
    lines.forEach(raw => {
      const indent = raw.search(/\S/);
      const t = raw.trim();
      if (!/^->/.test(t)) {
        if (!last) (plan.sqlLines = plan.sqlLines || []).push(t); // the query, if pasted above the plan
        else if (!/^\d+ rows? in set/i.test(t) && !/^Warning/i.test(t)) last.label += ' ' + t; // wrapped line
        return;
      }
      const m = t.replace(/^->\s*/, '').match(MY_LINE);
      const n = mk({ raw: t });
      myLabel(n, m[1].trim());
      if (m[4] != null) n.est = { cost: num(m[3] != null ? m[3] : m[2]), startup: m[3] != null ? num(m[2]) : null, rows: num(m[4]) };
      if (m[8] != null) n.act = { first: num(m[5]), time: num(m[6]), rows: num(m[7]), loops: num(m[8]) };
      else if (/\(never executed\)/.test(t)) { n.never = true; n.act = { first: 0, time: 0, rows: 0, loops: 0 }; }
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      if (!stack.length) { if (!plan.root) plan.root = n; else { (plan.extraRoots = plan.extraRoots || []).push(n); } }
      else stack[stack.length - 1].node.children.push(n);
      stack.push({ indent, node: n });
      last = n;
    });
    if (!plan.root) throw new Error('No plan lines starting with "->" were found.');
    // A Filter's "rows removed" is what its input produced minus what it kept
    walk(plan.root, n => {
      if (n.type === 'Filter' && n.children[0] && n.act && n.children[0].act) {
        const inRows = n.children[0].act.rows * n.children[0].act.loops, outRows = n.act.rows * n.act.loops;
        n.removed.filter = Math.max(0, Math.round(inRows - outRows));
      }
    });
    if (plan.root.act) plan.executionMs = plan.root.act.time * Math.max(1, plan.root.act.loops);
    return plan;
  }

  // ------------------------------------------------------------------ MySQL JSON (format version 1 and 2)
  const MY_ACCESS_LABEL = { ALL: 'Table scan', index: 'Full index scan', range: 'Index range scan', ref: 'Index lookup', eq_ref: 'Single-row index lookup', const: 'Constant lookup', system: 'System table',
    ref_or_null: 'Index lookup (or null)', index_merge: 'Index merge', fulltext: 'Full-text search', unique_subquery: 'Unique subquery lookup', index_subquery: 'Subquery index lookup' };
  function myJsonTable(t) {
    const at = t.access_type || '';
    const n = mk();
    n.type = (MY_ACCESS_LABEL[at] || at || 'Table') + (at ? ' (' + at + ')' : '');
    n.relation = t.table_name || '';
    n.index = t.key || '';
    n.label = (MY_ACCESS_LABEL[at] || 'Access') + ' on ' + n.relation + (n.index ? ' using ' + n.index : '');
    const ci = t.cost_info || {};
    n.est = { rows: t.rows_examined_per_scan != null ? num(t.rows_examined_per_scan) : null, cost: ci.prefix_cost != null ? num(ci.prefix_cost) : null, selfCost: num(ci.read_cost) + num(ci.eval_cost) };
    n.my = { access: at, produced: t.rows_produced_per_join != null ? num(t.rows_produced_per_join) : null, filtered: t.filtered != null ? num(t.filtered) : null, possibleKeys: t.possible_keys || [], usedKeyParts: t.used_key_parts || [], usingIndex: !!t.using_index, joinBuffer: t.using_join_buffer || '' };
    if (t.attached_condition) n.props.filter = t.attached_condition;
    if (t.ref) n.props.indexCond = [].concat(t.ref).join(', ');
    if (t.used_columns) n.output = t.used_columns.slice();
    if (t.using_temporary_table) n.flags.temporary = true;
    if (t.using_filesort) n.flags.filesort = true;
    if (t.materialized_from_subquery) n.children.push(myJsonBlock(t.materialized_from_subquery.query_block || t.materialized_from_subquery, 'Materialized subquery'));
    return n;
  }
  function myJsonBlock(qb, label) {
    // returns one node for a query_block-like object
    const kids = [];
    const wrap = (type, o, flags) => { const n = mk({ type, label: type }); n.est.selfCost = 0; Object.assign(n.flags, flags || {}); return n; };
    function inner(o) {
      if (!o || typeof o !== 'object') return null;
      if (o.table) return myJsonTable(o.table);
      if (o.nested_loop) { const n = wrap('Nested loop'); n.children = o.nested_loop.map(inner).filter(Boolean); return n; }
      if (o.ordering_operation) { const op = o.ordering_operation; const n = wrap('Sort (ORDER BY)', op, { filesort: !!op.using_filesort, temporary: !!op.using_temporary_table }); const c = inner(op); if (c) n.children.push(c); return n; }
      if (o.grouping_operation) { const op = o.grouping_operation; const n = wrap('Group (GROUP BY)', op, { filesort: !!op.using_filesort, temporary: !!op.using_temporary_table }); const c = inner(op); if (c) n.children.push(c); return n; }
      if (o.duplicates_removal) { const op = o.duplicates_removal; const n = wrap('Duplicates removal', op, { filesort: !!op.using_filesort, temporary: !!op.using_temporary_table }); const c = inner(op); if (c) n.children.push(c); return n; }
      if (o.windowing) { const n = wrap('Window functions', o.windowing, { filesort: !!o.windowing.using_filesort, temporary: !!o.windowing.using_temporary_table }); const c = inner(o.windowing); if (c) n.children.push(c); return n; }
      if (o.union_result) { const u = o.union_result; const n = wrap('Union', u, { temporary: !!u.using_temporary_table }); n.children = (u.query_specifications || []).map(s => myJsonBlock(s.query_block || s, 'Union part')); return n; }
      if (o.query_block) return myJsonBlock(o.query_block);
      if (o.message) return mk({ type: o.message, label: o.message });
      return null;
    }
    const main = inner(qb);
    const n = mk({ type: label || 'Query block' + (qb.select_id ? ' #' + qb.select_id : ''), label: label || 'Query block' + (qb.select_id ? ' #' + qb.select_id : '') });
    n.queryCost = qb.cost_info ? num(qb.cost_info.query_cost) : null;
    n.est.selfCost = 0;
    if (main) n.children.push(main);
    ['attached_subqueries', 'optimized_away_subqueries', 'select_list_subqueries', 'having_subqueries', 'order_by_subqueries', 'group_by_subqueries'].forEach(k => {
      (qb[k] || []).forEach(s => n.children.push(myJsonBlock(s.query_block || s, 'Subquery' + (s.dependent ? ' (dependent: runs per row)' : ''))));
    });
    (function scan(o) { // subqueries can also hang off a table
      if (!o || typeof o !== 'object') return;
      if (o.table && o.table.attached_subqueries) o.table.attached_subqueries.forEach(s => n.children.push(myJsonBlock(s.query_block || s, 'Subquery' + (s.dependent ? ' (dependent: runs per row)' : ''))));
      if (o.nested_loop) o.nested_loop.forEach(scan);
    })(qb);
    return n;
  }
  function myJson2(o) {
    const n = mk();
    myLabel(n, String(o.operation || o.access_type || 'Operation'));
    if (o.table_name && !n.relation) n.relation = o.table_name;
    if (o.index_name && !n.index) n.index = o.index_name;
    if (o.condition && !n.props.filter && n.type === 'Filter') n.props.filter = o.condition;
    n.est = { rows: o.estimated_rows != null ? num(o.estimated_rows) : null, cost: o.estimated_total_cost != null ? num(o.estimated_total_cost) : null };
    if (o.actual_loops != null) n.act = { first: num(o.actual_first_row_ms), time: num(o.actual_last_row_ms), rows: num(o.actual_rows), loops: num(o.actual_loops) };
    if (o.access_type === 'table' && /Table scan/i.test(n.type)) n.my = { access: 'ALL' };
    n.children = (o.inputs || []).map(myJson2);
    return n;
  }
  function parseMyJson(text) {
    let o = JSON.parse(String(text).trim());
    if (Array.isArray(o)) o = o[0];
    if (o.EXPLAIN) o = o.EXPLAIN;
    const plan = { engine: 'mysql', format: 'mysql-json', root: null, planningMs: null, executionMs: null, jit: null, triggers: [], warnings: [] };
    if (o.query_block) plan.root = myJsonBlock(o.query_block);
    else { plan.root = myJson2(o); plan.v2 = true; if (plan.root.act) plan.executionMs = plan.root.act.time; }
    return plan;
  }

  // ------------------------------------------------------------------ SQL Server showplan XML
  function decodeXml(s) { return s.replace(/&(lt|gt|amp|quot|apos|#x([0-9a-f]+)|#(\d+));/gi, (m, e, h, d) => (h ? String.fromCharCode(parseInt(h, 16)) : d ? String.fromCharCode(+d) : { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e.toLowerCase()])); }
  function parseXml(s) {
    const rootEl = { name: '#root', attrs: {}, children: [] };
    const stack = [rootEl];
    const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
    let m;
    while ((m = re.exec(s))) {
      if (!m[2]) continue;
      const name = m[2].replace(/^.*:/, '');
      if (m[1]) { for (let k = stack.length - 1; k > 0; k--) if (stack[k].name === name) { stack.length = k; break; } continue; }
      const attrs = {};
      const ar = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g; let a;
      while ((a = ar.exec(m[3]))) attrs[a[1].replace(/^.*:/, '')] = decodeXml(a[2] != null ? a[2] : a[3]);
      const el = { name, attrs, children: [] };
      stack[stack.length - 1].children.push(el);
      if (!m[4]) stack.push(el);
    }
    return rootEl;
  }
  function findAll(el, name, out, stopAt) {
    out = out || [];
    el.children.forEach(c => { if (c.name === name) out.push(c); if (!(stopAt && c.name === stopAt)) findAll(c, name, out, stopAt); });
    return out;
  }
  const first = (el, name, stopAt) => findAll(el, name, [], stopAt)[0];
  const unbr = s => String(s || '').replace(/[[\]]/g, '');
  function relOpChildren(el) {
    const out = [];
    (function rec(e) { e.children.forEach(c => { if (c.name === 'RelOp') out.push(c); else rec(c); }); })(el);
    return out;
  }
  function msNode(el) {
    const a = el.attrs;
    const n = mk();
    const op = el.children.find(c => !['OutputList', 'RunTimeInformation', 'Warnings', 'MemoryFractions', 'RunTimePartitionSummary', 'InternalInfo', 'DefinedValues'].includes(c.name)) || { name: '', attrs: {}, children: [] };
    const lookup = op.attrs && op.attrs.Lookup === '1' || op.attrs && op.attrs.Lookup === 'true';
    n.type = lookup ? (/Clustered/.test(a.PhysicalOp) ? 'Key Lookup' : 'RID Lookup') : a.PhysicalOp || op.name;
    if (lookup) n.flags.lookup = true;
    const obj = first(op, 'Object', 'RelOp');
    if (obj) { n.relation = [unbr(obj.attrs.Schema), unbr(obj.attrs.Table)].filter(Boolean).join('.'); n.index = unbr(obj.attrs.Index); n.alias = unbr(obj.attrs.Alias); }
    n.label = n.type + (a.LogicalOp && a.LogicalOp !== a.PhysicalOp && !lookup ? ' (' + a.LogicalOp + ')' : '') + (n.relation ? ' on ' + n.relation + (n.index ? ' (' + n.index + ')' : '') : '');
    const execEst = 1 + num(a.EstimateRebinds) + num(a.EstimateRewinds);
    n.est = { rows: num(a.EstimateRows), cost: num(a.EstimatedTotalSubtreeCost), execs: execEst, rowsRead: a.EstimatedRowsRead != null ? num(a.EstimatedRowsRead) : null };
    const pred = (name) => { const p = op.children.find(c => c.name === name); if (!p) return ''; const so = findAll(p, 'ScalarOperator', []).map(x => x.attrs.ScalarString).filter(Boolean); return so[0] || ''; };
    const f = pred('Predicate'); if (f) n.props.filter = f;
    const sp = op.children.find(c => c.name === 'SeekPredicates');
    if (sp) { const so = findAll(sp, 'ScalarOperator', []).map(x => x.attrs.ScalarString).filter(Boolean); const cols = findAll(sp, 'ColumnReference', []).filter(c => c.attrs.Column && !c.attrs.Table === false || c.attrs.Column).map(c => unbr(c.attrs.Column)); n.props.indexCond = so.join(' AND ') || cols.join(', '); n.seekCols = cols; }
    if (/Join|Nested Loops/.test(n.type) || /Join/.test(a.LogicalOp || '')) { const pr = pred('Predicate') || pred('ProbeResidual'); if (pr) n.props.joinFilter = pr; const hk = op.children.find(c => c.name === 'HashKeysProbe'); if (hk) n.props.hashCond = findAll(hk, 'ColumnReference', []).map(c => unbr(c.attrs.Column)).join(', '); }
    const ol = el.children.find(c => c.name === 'OutputList');
    if (ol) n.output = findAll(ol, 'ColumnReference', []).map(c => unbr(c.attrs.Column)).filter(Boolean);
    const rt = el.children.find(c => c.name === 'RunTimeInformation');
    if (rt) {
      let rows = 0, execs = 0, elapsed = 0, logical = 0, physical = 0, rowsRead = 0, any = false, cpu = 0;
      rt.children.filter(c => c.name === 'RunTimeCountersPerThread').forEach(c => {
        any = true; const x = c.attrs;
        rows += num(x.ActualRows); execs += num(x.ActualExecutions); elapsed = Math.max(elapsed, num(x.ActualElapsedms)); cpu += num(x.ActualCPUms);
        logical += num(x.ActualLogicalReads); physical += num(x.ActualPhysicalReads) + num(x.ActualReadAheads); rowsRead += num(x.ActualRowsRead);
        if (x.ActualExecutionMode === 'Batch') n.flags.batch = true;
      });
      if (any) {
        n.act = { rows: execs ? rows / execs : rows, loops: execs, time: null, first: null };
        n.ms = { rowsTotal: rows, elapsed: has(elapsed) ? elapsed : null, logical, physical, rowsRead, cpu };
        if (logical) n.buffers.sharedHit = logical;
        if (physical) n.buffers.sharedRead = physical;
        if (!execs) n.never = true;
      }
    }
    const w = el.children.find(c => c.name === 'Warnings');
    if (w) w.children.forEach(c => {
      if (c.name === 'SpillToTempDb') n.warnings.push({ kind: 'spill', level: num(c.attrs.SpillLevel), threads: num(c.attrs.SpilledThreadCount) });
      else if (c.name === 'NoJoinPredicate' || w.attrs.NoJoinPredicate === 'true') n.warnings.push({ kind: 'nojoin' });
      else if (c.name === 'ColumnsWithNoStatistics') n.warnings.push({ kind: 'nostats', cols: findAll(c, 'ColumnReference', []).map(x => unbr(x.attrs.Column)) });
      else if (/Spill/.test(c.name)) n.warnings.push({ kind: 'spill', detail: c.name });
    });
    if (w && w.attrs.NoJoinPredicate === 'true' && !n.warnings.some(x => x.kind === 'nojoin')) n.warnings.push({ kind: 'nojoin' });
    if (a.Parallel === '1' || a.Parallel === 'true') n.flags.parallel = true;
    n.children = relOpChildren(op.name ? op : el).map(msNode);
    return n;
  }
  function parseMsXml(text) {
    const doc = parseXml(String(text));
    const stmts = findAll(doc, 'StmtSimple', []).filter(s => first(s, 'QueryPlan'));
    if (!stmts.length) throw new Error('No <StmtSimple> with a <QueryPlan> was found. Save the plan from SSMS with "Save Execution Plan As…" (.sqlplan) or use SET STATISTICS XML ON.');
    stmts.sort((x, y) => num(y.attrs.StatementSubTreeCost) - num(x.attrs.StatementSubTreeCost));
    const st = stmts[0];
    const qp = first(st, 'QueryPlan');
    const rootRel = relOpChildren(qp)[0];
    if (!rootRel) throw new Error('The query plan has no operators (<RelOp>).');
    const plan = { engine: 'sqlserver', format: 'mssql-xml', root: msNode(rootRel), planningMs: null, executionMs: null, jit: null, triggers: [], warnings: [], sql: st.attrs.StatementText || '' };
    plan.root.label = plan.root.label;
    const qts = first(qp, 'QueryTimeStats', 'RelOp');
    if (qts) { plan.executionMs = num(qts.attrs.ElapsedTime); plan.cpuMs = num(qts.attrs.CpuTime); }
    if (qp.attrs.CompileTime) plan.planningMs = num(qp.attrs.CompileTime);
    plan.dop = num(qp.attrs.DegreeOfParallelism) || null;
    const mg = qp.children.find(c => c.name === 'MemoryGrantInfo');
    if (mg) plan.memoryGrant = { requested: num(mg.attrs.RequestedMemory), granted: num(mg.attrs.GrantedMemory), used: num(mg.attrs.MaxUsedMemory), desired: num(mg.attrs.SerialDesiredMemory) };
    const ts = qp.children.find(c => c.name === 'ThreadStat');
    if (ts) { const rsv = ts.children.find(c => c.name === 'ThreadReservation'); plan.threads = { branches: num(ts.attrs.Branches), used: num(ts.attrs.UsedThreads), reserved: rsv ? num(rsv.attrs.ReservedThreads) : null }; }
    plan.missingIndexes = findAll(qp, 'MissingIndexGroup', [], 'RelOp').map(g => {
      const mi = first(g, 'MissingIndex');
      const cols = { EQUALITY: [], INEQUALITY: [], INCLUDE: [] };
      (mi ? mi.children : []).filter(c => c.name === 'ColumnGroup').forEach(cg => { (cols[cg.attrs.Usage] = cols[cg.attrs.Usage] || []).push.apply(cols[cg.attrs.Usage], cg.children.filter(c => c.name === 'Column').map(c => unbr(c.attrs.Name))); });
      return { impact: num(g.attrs.Impact), table: mi ? [unbr(mi.attrs.Schema), unbr(mi.attrs.Table)].filter(Boolean).join('.') : '', eq: cols.EQUALITY, ineq: cols.INEQUALITY, include: cols.INCLUDE };
    });
    const warn = qp.children.find(c => c.name === 'Warnings');
    plan.converts = [];
    if (warn) warn.children.forEach(c => {
      if (c.name === 'PlanAffectingConvert') plan.converts.push({ issue: c.attrs.ConvertIssue, expr: c.attrs.Expression });
      if (c.name === 'MemoryGrantWarning') plan.memoryGrantWarning = c.attrs.GrantWarningKind;
    });
    if (stmts.length > 1) plan.warnings.push(stmts.length + ' statements were found; the most expensive one (by estimated cost) is analysed.');
    return plan;
  }

  // ------------------------------------------------------------------ common post-processing
  function walk(n, fn, parent, depth) { fn(n, parent || null, depth || 0); n.children.forEach(c => walk(c, fn, n, (depth || 0) + 1)); }
  const isPg = p => p.engine === 'postgresql';
  function isFullScan(n, plan) {
    if (plan.engine === 'postgresql') return /Seq Scan$/.test(n.type);
    if (plan.engine === 'mysql') return /^Table scan/i.test(n.type) && n.relation !== '<temporary>' || (n.my && n.my.access === 'ALL');
    if (plan.engine === 'sqlserver') return /^(Table Scan|Clustered Index Scan|Index Scan)$/.test(n.type);
    return false;
  }
  const isJoin = n => /Nested Loop|Nested loop|Hash Join|Merge Join|hash join|Hash Match|Merge Join|Nested Loops/i.test(n.type);
  const isNestedLoop = n => /^(Parallel )?Nested Loop|^Nested loop|^Nested Loops$/i.test(n.type);

  function finalise(plan) {
    if (plan.sqlLines && !plan.sql) {
      const q = plan.sqlLines.join(' ').replace(/^\s*EXPLAIN\b\s*(\([^)]*\)\s*)?((ANALYZE|VERBOSE|FORMAT\s*=\s*\w+)\s+)*/i, '').trim();
      if (/^(SELECT|WITH|UPDATE|DELETE|INSERT)\b/i.test(q)) plan.sql = q;
    }
    delete plan.sqlLines;
    const nodes = [];
    walk(plan.root, (n, p, d) => { n.id = nodes.length; n.depth = d; n.parentId = p ? p.id : -1; nodes.push(n); });
    plan.hasActual = nodes.some(n => n.act && (n.act.time != null || (n.ms && n.ms.elapsed != null)));
    plan.hasRows = nodes.some(n => n.act);
    // parallel (PostgreSQL): per-loop time under a Gather is an average over the leader and workers that ran at the same
    // time, so multiplying by loops overstates wall time. Divide by the number of processes.
    const procs = new Map();
    walk(plan.root, (n, p) => {
      if (!procs.has(n)) procs.set(n, /^Gather/.test(n.type) ? 1 : p ? procs.get(p) || 1 : 1); // a Gather itself runs in the leader
      if (/^Gather/.test(n.type) && n.workers) n.children.forEach(c => procs.set(c, (n.workers.launched != null ? n.workers.launched : n.workers.planned) + 1));
    });
    // inherit the divisor down the subtree under a Gather
    walk(plan.root, (n, p) => { if (p && !/^Gather/.test(p.type) && procs.get(p) > 1) procs.set(n, procs.get(p)); });
    nodes.forEach(n => {
      if (n.act) {
        if (plan.engine === 'sqlserver') { n.incl = n.ms && n.ms.elapsed != null ? n.ms.elapsed : null; n.rowsAct = n.ms ? n.ms.rowsTotal : n.act.rows * n.act.loops; }
        else {
          const div = procs.get(n) > 1 && n.act.loops >= procs.get(n) ? procs.get(n) : 1;
          n.incl = n.act.time != null ? n.act.time * n.act.loops / div : null;
          n.rowsAct = n.act.rows * n.act.loops;
        }
      } else { n.incl = null; n.rowsAct = null; }
      const loops = n.act ? Math.max(1, n.act.loops) : 1;
      if (n.est.rows != null) n.rowsEst = plan.engine === 'sqlserver' ? n.est.rows * (n.act ? Math.max(1, n.act.loops) : n.est.execs || 1) : n.est.rows * loops;
      else n.rowsEst = null;
      if (n.rowsAct != null && n.rowsEst != null && !n.never) {
        // compare per loop: PostgreSQL, MySQL and SQL Server all estimate rows for one execution of the node
        const a = Math.max(n.act && n.act.loops ? n.rowsAct / n.act.loops : n.rowsAct, 1), e = Math.max(n.act && n.act.loops ? n.rowsEst / Math.max(1, n.act.loops) : n.rowsEst, 1);
        n.misest = a >= e ? a / e : -(e / a); // positive: more rows than estimated
      } else n.misest = null;
    });
    // SQL Server batch-mode operators report their own time only; row-mode times include children
    nodes.forEach(n => {
      if (n.incl == null) { n.excl = null; return; }
      if (plan.engine === 'sqlserver' && n.flags.batch) { n.excl = n.incl; return; }
      let kids = 0; n.children.forEach(c => { if (c.incl != null) kids += plan.engine === 'sqlserver' && c.flags.batch ? subtreeIncl(c) : c.incl; });
      n.excl = Math.max(0, n.incl - kids);
    });
    function subtreeIncl(n) { if (!n.flags.batch) return n.incl || 0; let s = n.incl || 0; n.children.forEach(c => { s += subtreeIncl(c); }); return s; }
    if (plan.engine === 'sqlserver' && plan.hasActual) nodes.forEach(n => { if (n.flags.batch) n.inclTotal = subtreeIncl(n); });
    // cost (for estimated plans): own cost = total - children's total
    nodes.forEach(n => {
      if (n.est.selfCost != null) n.costSelf = n.est.selfCost;
      else if (n.est.cost != null) { let k = 0; n.children.forEach(c => { if (c.est.cost != null) k += c.est.cost; }); n.costSelf = Math.max(0, n.est.cost - k); }
      else n.costSelf = null;
    });
    const totalCost = nodes.reduce((x, n) => x + (n.costSelf || 0), 0);
    let totalMs = plan.executionMs;
    if (plan.hasActual) {
      const sumExcl = nodes.reduce((x, n) => x + (n.excl || 0), 0);
      if (!totalMs) totalMs = sumExcl;
      totalMs = Math.max(totalMs, plan.root.incl || 0);
      plan.timeBase = Math.max(totalMs, sumExcl);
      nodes.forEach(n => { n.share = n.excl != null && plan.timeBase ? n.excl / plan.timeBase : 0; });
      plan.shareBy = 'time';
    } else {
      nodes.forEach(n => { n.share = totalCost ? (n.costSelf || 0) / totalCost : 0; });
      plan.shareBy = 'cost';
    }
    plan.totalMs = totalMs || null;
    plan.nodes = nodes;
    return plan;
  }

  // ------------------------------------------------------------------ conditions → columns
  function normCond(c) {
    return String(c || '')
      .replace(/::"?[\w ]+"?(\[\])?(\(\d+(,\d+)?\))?/g, '')     // PostgreSQL casts
      .replace(/`/g, '').replace(/\[([^\]]+)\]/g, '$1')         // MySQL / SQL Server quoting
      .replace(/"(\w+)"/g, '$1')
      .replace(/\b\w+\.\w+\.(\w+\.\w+)\b/g, '$1')                 // db.schema.table.col → table.col
      .replace(/\b\w+\.(\w+\.\w+)\b/g, '$1')                       // db.table.col → table.col
      .replace(/\s+as\s+\w+\.\w+/gi, '')                           // SQL Server "x as [o].[x]"
      .replace(/CONVERT_IMPLICIT\(\w+(\(\d+\))?,\s*([\w.]+),\s*\d+\)/gi, '$2')  // reported separately as an implicit conversion
      .replace(/(^|[^\w])\(((?:\w+\.)?\w+)\)/g, '$1$2').replace(/(^|[^\w])\(((?:\w+\.)?\w+)\)/g, '$1$2');  // (col) → col
  }
  const FUNCS = /^(lower|upper|date|date_trunc|trunc|to_char|to_date|cast|coalesce|isnull|ifnull|nvl|substring|substr|left|right|year|month|day|convert|convert_implicit|datediff|extract|abs|round|trim|ltrim|rtrim|replace|concat|md5|json_extract|jsonb_extract_path_text|unaccent|datepart|format)$/i;
  function columnsFromCond(cond) {
    const out = { eq: [], range: [], funcs: [], likeLeading: [], ors: false, other: [] };
    let s = normCond(cond);
    if (!s.trim()) return out;
    s = s.replace(/\bBETWEEN\s+(.+?)\s+AND\s+/gi, 'BETWEEN $1 ~~AND~~ ');
    const parts = splitTop2(stripOuter(s), /^\s+AND\s+/i);
    if (parts.some(p => splitTop2(stripOuter(p), /^\s+OR\s+/i).length > 1)) out.ors = true;
    parts.forEach(p0 => {
      const p = stripOuter(p0.trim());
      const m = p.match(/^(?:([A-Za-z_]\w*)\s*\(\s*(?:\w+\s*,\s*)?(?:([A-Za-z_]\w*)\.)?([A-Za-z_]\w*)[^)]*\)|(?:([A-Za-z_]\w*)\.)?([A-Za-z_]\w*))\s*(=|==|<>|!=|<=|>=|<|>|!~~\*?|~~\*?|NOT LIKE|LIKE|ILIKE|NOT IN|IN|= ANY|IS NOT NULL|IS NULL|IS NOT|IS|BETWEEN)\s*(.*)$/i);
      if (!m) { out.other.push(p); return; }
      const fn = m[1], col = m[1] ? m[3] : m[5], tbl = m[1] ? m[2] : m[4], op = m[6].toUpperCase(), rhs = (m[7] || '').trim();
      if (/^(true|false|null|\d+)$/i.test(col)) { out.other.push(p); return; }
      if (fn && FUNCS.test(fn)) { out.funcs.push({ fn: fn.toLowerCase(), col, table: tbl || '', expr: p }); return; }
      if (fn) { out.other.push(p); return; }
      const entry = { col, table: tbl || '', op, rhs };
      if (/^(=|==|IN|= ANY|IS NULL|IS)$/.test(op)) out.eq.push(entry);
      else if (/^(<|>|<=|>=|BETWEEN)$/.test(op)) out.range.push(entry);
      else if (/LIKE|~~/.test(op)) {
        const lit = rhs.match(/^N?'([^']*)'/);
        if (lit && /^[%_]/.test(lit[1])) out.likeLeading.push(entry); else if (lit && !/NOT|!/.test(op)) out.range.push(entry); else out.other.push(p);
      } else out.other.push(p);
    });
    const uniq = a => { const seen = {}; return a.filter(x => (seen[x.col.toLowerCase()] ? false : (seen[x.col.toLowerCase()] = 1))); };
    out.eq = uniq(out.eq); out.range = uniq(out.range);
    return out;
  }
  function stripOuter(p) {
    p = p.trim();
    while (/^\(/.test(p) && /\)$/.test(p) && balanced(p.slice(1, -1))) p = p.slice(1, -1).trim();
    return p;
  }
  // split on a keyword (AND / OR) only at bracket depth 0 and outside quotes
  function splitTop2(s, kw) {
    const out = []; let depth = 0, q = false, start = 0;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === "'") q = !q;
      if (q) continue;
      if (ch === '(') depth++; else if (ch === ')') depth--;
      else if (depth === 0 && /\s/.test(ch)) { const m = s.slice(i).match(kw); if (m) { out.push(s.slice(start, i)); i += m[0].length - 1; start = i + 1; } }
    }
    out.push(s.slice(start));
    return out.map(x => x.trim()).filter(Boolean);
  }
  function balanced(s) { let d = 0; for (const ch of s) { if (ch === '(') d++; else if (ch === ')') { d--; if (d < 0) return false; } } return d === 0; }
  function idxName(table, cols) { return ('idx_' + String(table).split('.').pop() + '_' + cols.join('_')).replace(/[^\w]/g, '_').slice(0, 60); }
  function indexSql(engine, table, eq, range, include, note) {
    const keys = eq.concat(range.slice(0, 1));
    if (!table || !keys.length) return '';
    const inc = (include || []).filter(c => keys.map(k => k.toLowerCase()).indexOf(c.toLowerCase()) < 0).slice(0, 6);
    if (engine === 'postgresql') return 'CREATE INDEX CONCURRENTLY ' + idxName(table, keys) + '\n  ON ' + table + ' (' + keys.join(', ') + ')' + (inc.length ? '\n  INCLUDE (' + inc.join(', ') + ')' : '') + ';' + (note ? '\n-- ' + note : '');
    if (engine === 'mysql') return 'ALTER TABLE ' + table + '\n  ADD INDEX ' + idxName(table, keys) + ' (' + keys.concat(inc).join(', ') + ');' + (inc.length ? '\n-- the last ' + plural(inc.length, 'column') + ' make the index covering (MySQL has no INCLUDE)' : '') + (note ? '\n-- ' + note : '');
    return 'CREATE NONCLUSTERED INDEX IX_' + String(table).split('.').pop() + '_' + keys.join('_') + '\n  ON ' + table + ' (' + keys.join(', ') + ')' + (inc.length ? '\n  INCLUDE (' + inc.join(', ') + ')' : '') + '\n  WITH (ONLINE = ON); -- ONLINE needs Enterprise or Azure SQL' + (note ? '\n-- ' + note : '');
  }
  function stripQualifier(cols) { return cols.map(c => String(c).replace(/^.*\./, '').replace(/[`"[\]]/g, '')).filter(c => /^[A-Za-z_]\w*$/.test(c)); }

  // ------------------------------------------------------------------ SQL text checks
  function sqlChecks(sql, engine) {
    const out = [];
    if (!sql || !sql.trim()) return out;
    const s = sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
    const where = s.split(/\bWHERE\b|\bON\b|\bHAVING\b/i).slice(1).join(' AND ');
    const fnRe = /\b(lower|upper|date|date_trunc|trunc|to_char|cast|coalesce|isnull|ifnull|nvl|substring|substr|left|year|month|convert|datediff|extract|trim|ltrim|rtrim|datepart|format)\s*\(\s*(?:'[^']*'\s*,\s*|\w+\s*,\s*)?((?:\w+\.)?\w+)\s*(?:,[^)]*)?(?:\s+as\s+\w+(?:\(\d+\))?)?\)\s*(=|<>|!=|<=|>=|<|>|\bLIKE\b|\bIN\b|\bBETWEEN\b)/gi;
    let m; const seen = {};
    while ((m = fnRe.exec(where))) {
      const fn = m[1].toLowerCase(), col = m[2];
      if (/^\d+$/.test(col) || seen[fn + col]) continue; seen[fn + col] = 1;
      out.push({ kind: 'function', fn, col, expr: m[0].replace(/\s*(=|<>|!=|<=|>=|<|>|LIKE|IN|BETWEEN)$/i, '') });
    }
    const arith = /((?:\w+\.)?[A-Za-z_]\w*)\s*[-+*/]\s*\d+\s*(=|<=|>=|<|>)/g;
    while ((m = arith.exec(where))) if (!seen['arith' + m[1]]) { seen['arith' + m[1]] = 1; out.push({ kind: 'arith', col: m[1], expr: m[0].replace(/\s*(=|<=|>=|<|>)$/, '') }); }
    const like = /((?:\w+\.)?[A-Za-z_]\w*)\s+(?:I?LIKE)\s+N?'%/gi;
    while ((m = like.exec(where))) out.push({ kind: 'leading-wildcard', col: m[1] });
    if (/^\s*SELECT\s+\*/i.test(s) || /\bSELECT\s+(?:\w+\.)?\*\s+FROM\b/i.test(s)) out.push({ kind: 'select-star' });
    if (/\bOFFSET\s+\d{4,}|\bLIMIT\s+\d+\s*,\s*\d{4,}|\bLIMIT\s+\d+\s+OFFSET\s+\d{4,}/i.test(s)) out.push({ kind: 'offset' });
    if (/\bNOT\s+IN\s*\(\s*SELECT/i.test(s)) out.push({ kind: 'not-in' });
    return out;
  }

  // ------------------------------------------------------------------ findings
  function findingsFor(plan, opts) {
    const F = [];
    const eng = plan.engine;
    const add = (o) => F.push(Object.assign({ severity: 'medium', node: -1 }, o));
    const nodeName = n => n.label || n.type;
    const share = n => (n.share ? ' It takes ' + pct(n.share, 1) + '% of the ' + (plan.shareBy === 'time' ? 'query time' : 'estimated cost') + '.' : '');
    const sevFor = (n, base) => (n.share >= 0.3 ? 'high' : n.share >= 0.05 || plan.shareBy !== 'time' ? base : 'low');
    const statsFix = (t, cols) => eng === 'postgresql' ? 'ANALYZE ' + t + ';' + (cols && cols.length > 1 ? '\n-- columns that depend on each other: tell the planner\nCREATE STATISTICS ' + idxName(t, cols).replace(/^idx_/, 'st_') + ' (dependencies, mcv) ON ' + cols.join(', ') + ' FROM ' + t + ';\nANALYZE ' + t + ';' : cols && cols.length ? '\n-- skewed column: keep a bigger sample\nALTER TABLE ' + t + ' ALTER COLUMN ' + cols[0] + ' SET STATISTICS 1000;\nANALYZE ' + t + ';' : '')
      : eng === 'mysql' ? 'ANALYZE TABLE ' + t + ';' + (cols && cols.length ? '\nANALYZE TABLE ' + t + ' UPDATE HISTOGRAM ON ' + cols.join(', ') + ' WITH 64 BUCKETS;' : '')
        : 'UPDATE STATISTICS ' + t + ' WITH FULLSCAN;';
    const amap = aliasMap(opts.sql);
    const resolve = r => (r && amap[r.toLowerCase()] ? amap[r.toLowerCase()] : r);
    const tableOf = n => resolve(n.relation || (n.children[0] && n.children[0].relation) || '');
    const tableForCol = col => { const a = String(col).split('.'); if (a.length < 2) return ''; const al = a[0].toLowerCase(); const nd = plan.nodes.find(x => (x.alias || '').toLowerCase() === al || (x.relation || '').toLowerCase() === al); return amap[al] || (nd && nd.relation) || ''; };

    plan.nodes.forEach(n => {
      // ---------- full scans that throw most rows away: index candidates
      if (isFullScan(n, plan)) {
        let scanned = null, kept = null, cond = n.props.filter || '';
        if (eng === 'postgresql' && n.rowsAct != null) { kept = n.rowsAct; scanned = n.rowsAct + n.removed.filter * 1; if (n.act && n.act.loops > 1 && n.removed.filter) scanned = n.rowsAct + n.removed.filter * n.act.loops; }
        else if (eng === 'mysql' && n.my && n.my.access === 'ALL' && !plan.hasRows) { scanned = n.est.rows; kept = n.my.filtered != null ? scanned * n.my.filtered / 100 : null; }
        else if (eng === 'mysql') {
          const p = plan.nodes[n.parentId];
          scanned = n.rowsAct != null ? n.rowsAct : n.rowsEst;
          if (p && p.type === 'Filter') { cond = p.props.filter; kept = p.rowsAct != null ? p.rowsAct : p.rowsEst; }
        } else if (eng === 'sqlserver') {
          if (n.ms) { scanned = n.ms.rowsRead || n.ms.rowsTotal; kept = n.ms.rowsTotal; } else { scanned = n.est.rowsRead != null ? n.est.rowsRead : n.est.rows; kept = n.est.rows; }
        }
        if (eng === 'postgresql' && n.rowsAct == null && n.est.rows != null) { kept = n.est.rows; scanned = null; }
        const loops = n.act ? n.act.loops : 1;
        const perLoop = scanned != null ? scanned / Math.max(1, loops) : null;
        if (cond && scanned != null && scanned >= BIG && kept != null && kept / Math.max(scanned, 1) <= 0.1) {
          const c = columnsFromCond(cond);
          const t = tableOf(n);
          const eq = stripQualifier(c.eq.map(x => x.col)), rg = stripQualifier(c.range.map(x => x.col));
          // date functions are best rewritten as a range on the plain column, which then joins the index
          const dateFns = c.funcs.filter(f => /^(date|year|month|day|date_trunc|trunc|to_char|datepart|extract)$/.test(f.fn));
          dateFns.forEach(f => { if (rg.indexOf(f.col) < 0) rg.push(f.col); });
          const otherFns = c.funcs.filter(f => dateFns.indexOf(f) < 0);
          let inc = eng === 'mysql' ? [] : stripQualifier(n.output || []);
          if (eng === 'sqlserver') { const par = plan.nodes[n.parentId]; const lk = par && par.children.find(x => x.flags.lookup); if (lk) inc = inc.concat(stripQualifier(lk.output)); inc = inc.filter(x => !/^(id|\w+Id)$/.test(x) || lk === undefined); }
          let fix = '';
          const notes = [];
          if (rg.length > 1) notes.push('only the first range column (' + rg[0] + ') can be used for the seek; equality columns go first');
          dateFns.forEach(f => notes.push('rewrite ' + f.expr.replace(/\s*(=|<|>|<=|>=).*$/, '') + ' as a range on ' + f.col + ' (e.g. ' + f.col + " >= '2026-01-01' AND " + f.col + " < '2027-01-01') so this index can be used"));
          if (eq.length || rg.length) fix = indexSql(eng, t, eq, rg, inc.length && inc.length <= 4 ? inc : [], notes.join('\n-- '));
          if (otherFns.length) fix = (fix ? fix + '\n\n' : '') + exprIndex(eng, t, otherFns[0]);
          add({ id: 'seq-scan-filter', node: n.id, severity: sevFor(n, 'high'),
            title: 'Full scan of ' + (t || 'a table') + ' keeps ' + (kept / Math.max(scanned, 1) < 0.001 ? 'under 0.1%' : pct(kept, scanned) + '%') + ' of ' + fmtN(scanned) + ' rows',
            text: nodeName(n) + ' reads ' + fmtN(scanned) + ' rows' + (loops > 1 ? ' (' + fmtN(perLoop) + ' per loop × ' + fmtN(loops) + ' loops)' : '') + ' and keeps ' + fmtN(kept) + ' after the filter ' + short(cond, 160) + '.' + share(n) +
              ' An index on the filtered column' + (eq.length + rg.length > 1 ? 's' : '') + ' lets the database jump straight to the matching rows.' +
              (c.ors ? ' The filter uses OR, which often stops a single index being used: consider one index per branch (PostgreSQL can combine them with a BitmapOr) or rewriting as UNION ALL.' : '') +
              (c.likeLeading.length ? ' A LIKE pattern that starts with % cannot use a normal B-tree index' + (eng === 'postgresql' ? '; a trigram index (pg_trgm, GIN) can.' : '.') : ''),
            fix: fix || '-- add an index on the column(s) used in: ' + short(cond, 200) });
        } else if (!cond && perLoop != null && perLoop >= BIG && loops > 1) {
          add({ id: 'seq-scan-loop', node: n.id, severity: 'high', title: 'Full scan of ' + (tableOf(n) || 'a table') + ' repeated ' + fmtN(loops) + ' times',
            text: nodeName(n) + ' reads about ' + fmtN(perLoop) + ' rows on each of ' + fmtN(loops) + ' loops, usually the inner side of a nested loop with no index on the join column.' + share(n),
            fix: '-- index the join column on ' + (tableOf(n) || 'the inner table') + ', e.g.\nCREATE INDEX ON ' + (tableOf(n) || 'inner_table') + ' (join_column);' });
        }
      }
      // ---------- filter that discards most rows on an index scan / join
      if (!isFullScan(n, plan) && eng === 'postgresql' && n.rowsAct != null) {
        const removed = n.removed.filter * (n.act && n.act.loops > 1 ? n.act.loops : 1);
        if (removed >= 1000 && n.removed.filter >= 10 && removed / (removed + n.rowsAct) >= 0.9 && n.props.filter) {
          const c = columnsFromCond(n.props.filter);
          const ic = columnsFromCond(n.props.indexCond || n.props.recheckCond || '');
          const t = tableOf(n);
          const eq = stripQualifier(ic.eq.map(x => x.col).concat(c.eq.map(x => x.col))), rg = stripQualifier(ic.range.map(x => x.col).concat(c.range.map(x => x.col)));
          add({ id: 'rows-removed', node: n.id, severity: sevFor(n, 'medium'),
            title: pct(removed, removed + n.rowsAct) + '% of rows read by ' + (n.index || n.type) + ' are thrown away by a filter',
            text: nodeName(n) + ' fetches ' + fmtN(removed + n.rowsAct) + ' rows through the index' + (n.props.indexCond ? ' (' + short(n.props.indexCond, 100) + ')' : '') + ' and then removes ' + fmtN(removed) + ' of them with ' + short(n.props.filter, 120) + '. The index finds too many rows; adding the filter column to it means the discarded rows are never read.' + share(n),
            fix: indexSql(eng, t, eq, rg, [], 'or a partial index if the filter is a fixed value, e.g. … WHERE ' + (c.eq[0] ? c.eq[0].col + ' = ' + short(c.eq[0].rhs, 30) : 'status = \'active\'')) || '-- add the filter column to the index' });
        }
        const jr = n.removed.join * (n.act && n.act.loops > 1 ? 1 : 1);
        if (jr >= 10000 && jr / (jr + n.rowsAct) >= 0.9 && n.props.joinFilter) {
          add({ id: 'join-filter', node: n.id, severity: sevFor(n, 'medium'), title: 'Join filter discards ' + fmtN(jr) + ' row combinations',
            text: nodeName(n) + ' builds ' + fmtN(jr + n.rowsAct) + ' row pairs and keeps ' + fmtN(n.rowsAct) + ' after ' + short(n.props.joinFilter, 140) + '. The join condition is not being used to find matches, so almost every pair is tried.' + share(n),
            fix: '-- make the condition sargable (plain column = column), and index the inner side on it\n-- e.g. avoid functions or OR in the join condition' });
        }
      }
      // ---------- misestimates
      if (n.misest != null && Math.abs(n.misest) >= 10 && Math.max(n.rowsAct, n.rowsEst) >= 100 && !n.never) {
        n._mis = true;
      }
      // ---------- nested loops over many outer rows
      const joinKids = n.children.filter(c => !c.subplan); // InitPlans/SubPlans hang off the node but are not join inputs
      if (isNestedLoop(n) && joinKids.length >= 2) {
        const outer = joinKids[0], inner = joinKids[1];
        const outerRows = outer.rowsAct != null ? outer.rowsAct : outer.my && outer.my.produced != null ? outer.my.produced : outer.rowsEst;
        const innerLoops = inner.act && inner.act.loops ? inner.act.loops : outerRows;
        const innerShare = subtreeShare(inner);
        const innerScan = findDown(inner, x => isFullScan(x, plan));
        if (outerRows >= 1000 && innerLoops >= 1000 && (innerShare >= 0.2 || (!plan.hasActual && innerScan))) {
          const est = outer.rowsEst;
          const underEst = outer.rowsAct != null && est != null && outer.rowsAct / Math.max(est, 1) >= 10;
          add({ id: 'nested-loop', node: n.id, severity: innerShare >= 0.3 ? 'high' : 'medium',
            title: 'Nested loop runs its inner side ' + fmtN(innerLoops) + ' times',
            text: nodeName(n) + ' takes ' + fmtN(outerRows) + ' rows from ' + nodeName(outer) + ' and, for each one, runs ' + nodeName(inner) + '. ' +
              (innerShare ? 'The inner side accounts for ' + pct(innerShare, 1) + '% of the ' + (plan.shareBy === 'time' ? 'time' : 'cost') + '. ' : '') +
              (underEst ? 'The planner expected only ' + fmtN(est) + ' outer rows, which is why it chose a nested loop: fix the estimate and it will likely pick a hash join. ' : '') +
              (innerScan ? 'The inner side is a full scan, so there is no usable index on the join column. ' : 'Each inner lookup is cheap, but ' + fmtN(innerLoops) + ' of them add up. '),
            fix: innerScan ? '-- index the join column on ' + (innerScan.relation || 'the inner table') + '\nCREATE INDEX ON ' + (innerScan.relation || 'inner_table') + ' (join_column);'
              : eng === 'postgresql' ? '-- 1. fix the row estimate first (ANALYZE, extended statistics)\n-- 2. to test whether a hash join is faster (session only, not for production):\nSET enable_nestloop = off;\nEXPLAIN (ANALYZE, BUFFERS) <your query>;\nRESET enable_nestloop;'
                : eng === 'mysql' ? '-- fix the estimate first: ANALYZE TABLE and histograms on the join/filter columns\n-- to test a hash join (MySQL 8.0.18+):\nSELECT /*+ HASH_JOIN(t1 t2) */ …' : '-- fix the estimate first (UPDATE STATISTICS), or test: OPTION (HASH JOIN)' });
        }
      }
      // ---------- sort and hash spills
      if (n.sort && n.sort.disk) {
        const mb = Math.ceil(n.sort.kb / 1024);
        add({ id: 'sort-spill', node: n.id, severity: sevFor(n, 'medium'),
          title: (/external merge/.test(n.sort.method) ? 'External merge sort' : 'Sort') + ' spilled ' + fmtKB(n.sort.kb) + ' to disk',
          text: nodeName(n) + ' did not fit in work_mem, so PostgreSQL sorted on disk (' + n.sort.method + ', ' + fmtKB(n.sort.kb) + '). Disk sorts are many times slower than in-memory quicksort.' + share(n) +
            (n.props.sortKey ? ' Sort key: ' + short(n.props.sortKey, 100) + '.' : ''),
          fix: "-- for this session or role only (work_mem is per sort, per connection):\nSET work_mem = '" + Math.max(8, Math.pow(2, Math.ceil(Math.log2(mb * 2.5)))) + "MB';\n" +
            (n.props.sortKey ? '-- or avoid the sort with an index in ORDER BY order:\nCREATE INDEX ON ' + (findDown(n, x => !!x.relation) || {}).relation + ' (' + stripQualifier(n.props.sortKey.split(/,\s*/).map(x => x.replace(/\s+(DESC|ASC|NULLS.*)$/i, ''))).join(', ') + ');' : '') });
      }
      if (n.hash && (n.hash.batches > 1 || n.hash.diskKB)) {
        add({ id: 'hash-spill', node: n.id, severity: sevFor(n, 'medium'),
          title: (/Aggregate/.test(n.type) ? 'Hash aggregate' : 'Hash table') + ' spilled to disk in ' + n.hash.batches + ' batches',
          text: nodeName(n) + ' needed more memory than work_mem' + (n.hash.origBatches && n.hash.origBatches < n.hash.batches ? ' (planned ' + n.hash.origBatches + ' batch' + (n.hash.origBatches > 1 ? 'es' : '') + ', needed ' + n.hash.batches + ': the row estimate was too low)' : '') +
            ', so it split the work into ' + n.hash.batches + ' batches and wrote the rest to temporary files' + (n.hash.diskKB ? ' (' + fmtKB(n.hash.diskKB) + ')' : '') + '. Peak memory: ' + fmtKB(n.hash.kb) + '.' + share(n),
          fix: "SET work_mem = '" + Math.max(16, Math.pow(2, Math.ceil(Math.log2(Math.max(1, n.hash.kb * n.hash.batches / 1024) * 1.5)))) + "MB';  -- session or role, not globally\n-- PostgreSQL 13+: hash tables may use work_mem × hash_mem_multiplier (default 2)\nSET hash_mem_multiplier = 4;" });
      }
      if (!n.sort && !n.hash && (n.buffers.tempWritten || 0) > 1000 && !n.children.some(c => (c.buffers.tempWritten || 0) >= n.buffers.tempWritten)) {
        add({ id: 'temp-io', node: n.id, severity: 'low', title: nodeName(n) + ' wrote ' + fmtKB(n.buffers.tempWritten * 8) + ' of temporary files',
          text: 'Temporary file I/O means an operation ran out of work_mem (materialise, CTE, sort or hash below this node).', fix: "SET work_mem = '64MB';  -- test per session first" });
      }
      // ---------- lossy bitmaps
      if (n.heap.lossy > 0) {
        add({ id: 'lossy-bitmap', node: n.id, severity: sevFor(n, 'medium'), title: 'Lossy bitmap heap scan on ' + (n.relation || 'a table') + ' (' + fmtN(n.heap.lossy) + ' lossy blocks)',
          text: 'The bitmap of matching rows did not fit in work_mem, so for ' + fmtN(n.heap.lossy) + ' blocks PostgreSQL only remembered "something matches in this block" and had to re-check every row in them' + (n.removed.recheck ? ' (' + fmtN(n.removed.recheck) + ' rows removed by the recheck)' : '') + '.' + share(n),
          fix: "SET work_mem = '64MB';  -- enough for an exact bitmap; test per session\n-- or make the condition more selective (a composite index) so the bitmap is smaller" });
      }
      // ---------- parallel workers
      if (n.workers && n.workers.launched != null && n.workers.launched < n.workers.planned) {
        add({ id: 'workers', node: n.id, severity: 'medium', title: 'Only ' + n.workers.launched + ' of ' + n.workers.planned + ' parallel workers started',
          text: nodeName(n) + ' planned ' + n.workers.planned + ' workers but got ' + n.workers.launched + '. The pool of background workers was busy (other parallel queries), so this query ran with less parallelism than the plan assumed and took longer.',
          fix: '-- check and raise the limits (postgresql.conf; max_worker_processes needs a restart)\nSHOW max_parallel_workers;          -- total parallel workers\nSHOW max_worker_processes;\nSHOW max_parallel_workers_per_gather;' });
      }
      // ---------- SQL Server: key lookups, spills, warnings
      if (n.flags.lookup) {
        const execs = n.act ? n.act.loops : n.est.execs;
        if ((execs || 0) >= 100 || n.share >= 0.1) {
          const parentNL = plan.nodes[n.parentId];
          const seek = parentNL ? parentNL.children.find(c => c !== n && /Seek|Scan/.test(c.type)) : null;
          const keys = seek && seek.seekCols && seek.seekCols.length ? seek.seekCols : [];
          const t = n.relation;
          add({ id: 'key-lookup', node: n.id, severity: sevFor(n, 'high'), title: 'Key lookup into ' + t + ' runs ' + fmtN(execs) + ' times',
            text: 'For every row found in ' + (seek ? (seek.index || seek.label) : 'the non-clustered index') + ', SQL Server goes back to the clustered index to fetch ' + (n.output.length ? 'columns ' + n.output.slice(0, 6).join(', ') : 'the missing columns') + '. Each lookup is a random read.' + share(n),
            fix: keys.length ? indexSql('sqlserver', t, keys, [], n.output) : '-- add the looked-up columns to the existing index as INCLUDE columns:\nCREATE NONCLUSTERED INDEX IX_' + String(t).split('.').pop() + '_cover\n  ON ' + t + ' (<seek columns>)\n  INCLUDE (' + (n.output.join(', ') || '<looked-up columns>') + ')\n  WITH (DROP_EXISTING = ON);' });
        }
      }
      n.warnings.forEach(w => {
        if (w.kind === 'spill') add({ id: 'tempdb-spill', node: n.id, severity: sevFor(n, 'medium'), title: nodeName(n) + ' spilled to tempdb' + (w.level ? ' (level ' + w.level + ')' : ''),
          text: 'The memory grant was too small for this operator, so it wrote rows to tempdb. This usually comes from a row estimate that is too low.' + share(n),
          fix: '-- fix the estimate first:\nUPDATE STATISTICS ' + (tableOf(n) || 'dbo.YourTable') + ' WITH FULLSCAN;\n-- SQL Server 2019+: memory grant feedback adjusts grants on repeat runs' });
        if (w.kind === 'nojoin') add({ id: 'no-join-predicate', node: n.id, severity: 'high', title: 'Join with no join predicate (Cartesian product)', text: nodeName(n) + ' joins every row with every row. A join condition is missing or was written in a way the optimiser could not use.', fix: '-- add the missing ON condition between the two tables' });
        if (w.kind === 'nostats') add({ id: 'no-stats', node: n.id, severity: 'medium', title: 'Columns with no statistics', text: 'No statistics on ' + w.cols.join(', ') + ', so the estimates are guesses.', fix: 'CREATE STATISTICS st_' + (w.cols[0] || 'col') + ' ON ' + (tableOf(n) || 'dbo.YourTable') + ' (' + w.cols.join(', ') + ');' });
      });
      // ---------- MySQL: using temporary / filesort, join buffer, full index scans
      if (eng === 'mysql') {
        if (n.flags.temporary && n.relation !== '<temporary>' && !F.some(f => f.id === 'mysql-temporary')) {
          add({ id: 'mysql-temporary', node: n.id, severity: sevFor(n, 'medium'), title: 'Using a temporary table (' + n.type + ')',
            text: 'MySQL builds an internal temporary table to ' + (/group|aggregate/i.test(n.type + n.label) ? 'group the rows' : /dedup|distinct|union/i.test(n.type + n.label) ? 'remove duplicates' : 'process the rows') + '. If it grows past tmp_table_size it moves to disk. An index in GROUP BY order lets MySQL group rows as it reads them, with no temporary table.',
            fix: '-- index matching the GROUP BY (and the WHERE equality columns before it):\nALTER TABLE <table> ADD INDEX idx_group (<where_eq_columns>, <group_by_columns>);\n-- check: SHOW SESSION STATUS LIKE \'Created_tmp_disk_tables\';' });
        }
        let sortRows = n.rowsAct || n.rowsEst || 0;
        if (!sortRows) walk(n, x => { if (x.my && x.my.produced > sortRows) sortRows = x.my.produced; });
        if (n.flags.filesort && sortRows >= 1000) {
          const key = n.props.sortKey || '';
          const t = resolve((findDown(n, x => !!x.relation && x.relation !== '<temporary>') || {}).relation);
          add({ id: 'mysql-filesort', node: n.id, severity: sevFor(n, 'medium'), title: 'Using filesort on ' + fmtN(sortRows) + ' rows',
            text: 'MySQL sorts the rows itself (filesort) because no index returns them in ' + (key ? 'the order ' + short(key, 80) : 'ORDER BY order') + '.' + share(n),
            fix: key && t ? 'ALTER TABLE ' + t + ' ADD INDEX ' + idxName(t, stripQualifier(key.split(/,\s*/).map(x => x.replace(/\s+(DESC|ASC)$/i, '')))) + ' (' + stripQualifier(key.split(/,\s*/).map(x => x.replace(/\s+(DESC|ASC)$/i, ''))).join(', ') + ');\n-- put WHERE equality columns first, then the ORDER BY columns' : '-- add an index whose columns match WHERE equality columns, then ORDER BY columns' });
        }
        if (n.my && n.my.joinBuffer) add({ id: 'mysql-join-buffer', node: n.id, severity: 'medium', title: 'Join without an index on ' + n.relation + ' (' + n.my.joinBuffer + ')',
          text: 'MySQL joins ' + n.relation + ' using a join buffer (' + n.my.joinBuffer + '), which means no index could be used for the join condition.', fix: 'ALTER TABLE ' + n.relation + ' ADD INDEX idx_' + n.relation + '_join (<join_column>);' });
        if (n.my && n.my.access === 'index' && (n.est.rows || 0) >= BIG) add({ id: 'mysql-full-index', node: n.id, severity: 'low', title: 'Full index scan on ' + n.relation + ' (' + fmtN(n.est.rows) + ' rows)',
          text: 'access_type "index" reads the whole index' + (n.index ? ' ' + n.index : '') + '. It is cheaper than a table scan but still touches every row.', fix: '-- add a WHERE condition the index can seek on, or an index starting with the filtered column' });
      }
    });

    // ---------- misestimates: report the deepest ones (they propagate upwards)
    const mis = plan.nodes.filter(n => n._mis);
    mis.filter(n => !mis.some(o => o !== n && isAncestor(n, o, plan) && Math.sign(o.misest) === Math.sign(n.misest)))
      .sort((a, b) => Math.abs(b.misest) - Math.abs(a.misest)).slice(0, 3).forEach(n => {
        const under = n.misest > 0;
        const t = tableOf(n) || (findDown(n, x => !!x.relation) || {}).relation || '';
        const c = columnsFromCond(n.props.filter || n.props.indexCond || n.props.hashCond || '');
        const cols = stripQualifier(c.eq.concat(c.range).map(x => x.col)).slice(0, 3);
        add({ id: 'misestimate', node: n.id, severity: Math.abs(n.misest) >= 100 ? 'high' : 'medium',
          title: 'Row estimate off by ' + Math.round(Math.abs(n.misest)).toLocaleString('en-AU') + '× at ' + short(nodeName(n), 60),
          text: 'The planner expected ' + fmtN(n.rowsEst) + ' rows but got ' + fmtN(n.rowsAct) + ' (' + (under ? 'under' : 'over') + '-estimated). Join methods, join order and memory are chosen from these numbers, so a wrong estimate here can make everything above it slow. ' +
            (cols.length > 1 ? 'Filters on several related columns (' + cols.join(', ') + ') are a common cause: the planner assumes they are independent.' : 'Stale or too-coarse statistics are the usual cause.'),
          fix: t ? statsFix(t, cols) : statsFix('your_table', cols) });
      });

    // ---------- plan-level checks
    const exec = plan.totalMs;
    if (plan.jit && plan.jit.total && exec && (plan.jit.total >= exec * 0.1 && plan.jit.total >= 20)) {
      add({ id: 'jit', severity: plan.jit.total >= exec * 0.3 ? 'high' : 'medium', title: 'JIT compilation took ' + fmtMs(plan.jit.total) + ' (' + pct(plan.jit.total, exec) + '% of execution)',
        text: 'PostgreSQL compiled ' + plan.jit.functions + ' functions to machine code because the estimated cost was above jit_above_cost. JIT pays off for long analytical queries; for short queries the compile time is pure overhead (generation ' + fmtMs(plan.jit.generation) + ', optimisation ' + fmtMs(plan.jit.optimization) + ', emission ' + fmtMs(plan.jit.emission) + ').',
        fix: "SET jit = off;                -- test per session first\n-- or only JIT really expensive queries:\nALTER SYSTEM SET jit_above_cost = 500000;\nSELECT pg_reload_conf();" });
    }
    if (plan.planningMs != null && exec != null && plan.planningMs > exec && plan.planningMs >= 5) {
      add({ id: 'planning', severity: plan.planningMs >= 50 ? 'high' : 'medium', title: 'Planning (' + fmtMs(plan.planningMs) + ') took longer than execution (' + fmtMs(exec) + ')',
        text: 'The query runs quickly, but working out the plan is the slow part. Common causes: many joins, many partitions that cannot be pruned at plan time, or lots of indexes to consider' + (plan.planningBuffers && plan.planningBuffers.sharedRead ? ', and catalog reads from disk during planning (' + fmtN(plan.planningBuffers.sharedRead) + ' blocks)' : '') + '.',
        fix: eng === 'sqlserver' ? '-- reuse plans: parameterise the query (sp_executesql) instead of building SQL strings\n-- check for plan cache bloat: SELECT COUNT(*) FROM sys.dm_exec_cached_plans;'
          : '-- reuse plans: use prepared statements (most drivers do this with server-side prepare)\n-- partitioned tables: keep the partition key in WHERE as a literal or parameter\n-- many joins: SET join_collapse_limit = 8;  (the default; lower = faster planning)' });
    }
    plan.triggers.filter(t => exec && t.ms >= exec * 0.2).forEach(t => {
      const fk = /RI_ConstraintTrigger|constraint/i.test(t.name);
      add({ id: 'trigger', severity: 'high', title: 'Trigger ' + short(t.name, 60) + ' took ' + fmtMs(t.ms) + ' (' + fmtN(t.calls) + ' calls)',
        text: (fk ? 'This is a foreign-key check. When rows are deleted or keys updated, PostgreSQL looks up the referencing rows in the child table; without an index on the referencing column each check is a full scan.' : 'Triggers run once per row and their time is not part of any plan node.') + ' It is ' + pct(t.ms, exec) + '% of the execution time.',
        fix: fk ? '-- index the referencing (child) column of the foreign key\nCREATE INDEX CONCURRENTLY ON child_table (parent_id);' : '-- review the trigger function; batch the work or move it to an async job' });
    });
    if (eng === 'postgresql') {
      let hit = 0, read = 0; plan.nodes.forEach(n => { hit += n.buffers.sharedHit || 0; read += n.buffers.sharedRead || 0; });
      // buffers are cumulative up the tree in PostgreSQL, so take the root's numbers when present
      if (plan.root.buffers.sharedHit != null || plan.root.buffers.sharedRead != null) { hit = plan.root.buffers.sharedHit || 0; read = plan.root.buffers.sharedRead || 0; }
      plan.io = { hit, read };
      if (read >= 10000 && read > hit) {
        const io = plan.root.buffers.ioReadMs;
        add({ id: 'disk-reads', severity: 'low', title: 'Most data came from disk: ' + fmtN(read) + ' blocks read (' + fmtKB(read * 8) + '), ' + fmtN(hit) + ' from cache',
          text: 'Only ' + pct(hit, hit + read) + '% of the pages were already in shared_buffers' + (io ? '; waiting for disk took ' + fmtMs(io) : '') + '. A second run is often much faster (cold cache), but in production this means the working set does not fit in memory or the query reads far more than it needs.',
          fix: '-- read less: the index findings above usually fix this\n-- check the cache hit ratio overall:\nSELECT sum(blks_hit) * 100.0 / nullif(sum(blks_hit + blks_read), 0) AS hit_pct FROM pg_stat_database;' });
      }
    }
    if (eng === 'sqlserver') {
      (plan.missingIndexes || []).forEach(mi => {
        add({ id: 'missing-index', severity: mi.impact >= 50 ? 'high' : 'medium', title: 'SQL Server suggests an index on ' + mi.table + ' (estimated ' + Math.round(mi.impact) + '% improvement)',
          text: 'The optimiser recorded a missing index while compiling this plan. Treat it as a hint: check it against existing indexes before creating it, and put the most selective equality column first.',
          fix: indexSql('sqlserver', mi.table, mi.eq, mi.ineq, mi.include) });
      });
      (plan.converts || []).forEach(cv => {
        add({ id: 'implicit-convert', severity: /Seek/i.test(cv.issue || '') ? 'high' : 'low', title: 'Implicit conversion: ' + short(cv.expr, 80),
          text: 'A column is converted to another type before the comparison (' + (cv.issue || 'conversion') + '). When that happens to an indexed column the index cannot be used for a seek. Typical cause: a VARCHAR column compared with an NVARCHAR parameter.',
          fix: '-- make the parameter type match the column, e.g. VARCHAR instead of NVARCHAR\n-- JDBC: sendStringParametersAsUnicode=false; .NET: SqlDbType.VarChar' });
      });
      if (plan.memoryGrant && plan.memoryGrant.granted && plan.memoryGrant.used != null && plan.memoryGrant.granted >= 102400 && plan.memoryGrant.used < plan.memoryGrant.granted * 0.1) {
        add({ id: 'memory-grant', severity: 'low', title: 'Memory grant far bigger than used (' + fmtKB(plan.memoryGrant.granted) + ' granted, ' + fmtKB(plan.memoryGrant.used) + ' used)',
          text: 'Over-sized grants make other queries wait for memory (RESOURCE_SEMAPHORE waits) under load. They come from over-estimated row counts or wide columns.', fix: '-- fix estimates (UPDATE STATISTICS); SQL Server 2019+ memory grant feedback helps on repeat runs\n-- or cap: OPTION (MAX_GRANT_PERCENT = 10)' });
      }
      if (plan.threads && plan.threads.reserved != null && plan.threads.used != null && plan.threads.used < plan.threads.reserved) {
        add({ id: 'workers', severity: 'low', title: 'Parallel threads: ' + plan.threads.used + ' used of ' + plan.threads.reserved + ' reserved', text: 'Fewer worker threads ran than were reserved.', fix: '-- check MAXDOP and cost threshold for parallelism' });
      }
    }
    // ---------- functions on columns (from the plan and from the SQL text)
    const fnSeen = {};
    plan.nodes.forEach(n => {
      [n.props.filter, n.props.indexCond, n.props.joinFilter].filter(Boolean).forEach(cond => {
        columnsFromCond(cond).funcs.forEach(f => {
          if (fnSeen[f.fn + f.col]) return; fnSeen[f.fn + f.col] = 1;
          if (f.fn === 'convert_implicit' && eng === 'sqlserver' && (plan.converts || []).length) return;
          add({ id: 'function-on-column', node: n.id, severity: isFullScan(n, plan) ? 'high' : 'medium', title: 'Function on a column: ' + short(f.expr, 70),
            text: 'Wrapping ' + f.col + ' in ' + f.fn + '() hides it from a normal index on ' + f.col + ', so the database has to compute the function for every row.',
            fix: funcFix(eng, tableOf(n) || 'your_table', f) });
        });
      });
    });
    sqlChecks(opts.sql, eng).forEach(c => {
      if (c.kind === 'function' && !fnSeen[c.fn + c.col.replace(/^.*\./, '')]) {
        fnSeen[c.fn + c.col.replace(/^.*\./, '')] = 1;
        add({ id: 'function-on-column', severity: 'medium', title: 'Function on a column in the SQL: ' + short(c.expr, 70),
          text: 'In the query text, ' + c.col + ' is wrapped in ' + c.fn + '(). A normal index on ' + c.col + ' cannot be used for that comparison.', fix: funcFix(eng, tableForCol(c.col) || 'your_table', { fn: c.fn, col: c.col.replace(/^.*\./, ''), expr: c.expr }) });
      }
      if (c.kind === 'arith') add({ id: 'function-on-column', severity: 'medium', title: 'Arithmetic on a column: ' + short(c.expr, 60), text: 'Calculating on the column side (' + c.expr + ') stops an index on ' + c.col + ' being used.', fix: '-- move the calculation to the other side:\n-- WHERE ' + c.col + ' = :value - 1   instead of   WHERE ' + c.expr + ' = :value' });
      if (c.kind === 'leading-wildcard') add({ id: 'leading-wildcard', severity: 'medium', title: 'LIKE with a leading % on ' + c.col, text: 'A pattern that starts with % cannot use a B-tree index, so every row is checked.',
        fix: eng === 'postgresql' ? 'CREATE EXTENSION IF NOT EXISTS pg_trgm;\nCREATE INDEX CONCURRENTLY ON ' + (tableForCol(c.col) || 'your_table') + ' USING gin (' + c.col.replace(/^.*\./, '') + ' gin_trgm_ops);' : eng === 'mysql' ? '-- use a FULLTEXT index and MATCH … AGAINST, or search on a prefix instead' : '-- use full-text search (CONTAINS) or search on a prefix instead' });
      if (c.kind === 'offset') add({ id: 'offset', severity: 'low', title: 'Large OFFSET pagination', text: 'OFFSET reads and throws away every skipped row, so later pages get slower and slower.', fix: '-- keyset pagination: remember the last key of the previous page\nSELECT … WHERE (created_at, id) < (:last_created_at, :last_id)\nORDER BY created_at DESC, id DESC LIMIT 50;' });
      if (c.kind === 'not-in') add({ id: 'not-in', severity: 'low', title: 'NOT IN (SELECT …)', text: 'NOT IN with a subquery behaves badly with NULLs and often cannot be turned into an anti-join.', fix: '-- use NOT EXISTS instead:\nWHERE NOT EXISTS (SELECT 1 FROM other o WHERE o.id = t.other_id)' });
    });
    const sev = { high: 0, medium: 1, low: 2 };
    F.sort((a, b) => sev[a.severity] - sev[b.severity] || ((plan.nodes[b.node] || {}).share || 0) - ((plan.nodes[a.node] || {}).share || 0));
    return F;

    function subtreeShare(n) { let s = 0; walk(n, x => { s += x.share || 0; }); return s; }
  }
  function aliasMap(sql) {
    const m = {}; if (!sql) return m;
    const re = /\b(?:FROM|JOIN|UPDATE|INTO)\s+([\w.`"[\]]+)(?:\s+(?:AS\s+)?([A-Za-z_]\w*))?/gi; let x;
    const kw = /^(where|on|join|left|right|inner|outer|full|cross|group|order|limit|set|using|natural|values|select|having|union|lateral|as)$/i;
    while ((x = re.exec(sql))) { const t = x[1].replace(/[`"[\]]/g, ''); if (x[2] && !kw.test(x[2])) m[x[2].toLowerCase()] = t; }
    return m;
  }
  function findDown(n, fn) { let r = null; walk(n, x => { if (!r && fn(x)) r = x; }); return r; }
  function isAncestor(a, d, plan) { let p = d.parentId; while (p >= 0) { if (p === a.id) return true; p = plan.nodes[p].parentId; } return false; }
  function exprIndex(eng, t, f) {
    if (eng === 'postgresql') return '-- an expression index matches the function exactly\nCREATE INDEX CONCURRENTLY ' + idxName(t, [f.fn, f.col]) + '\n  ON ' + t + ' (' + f.fn + '(' + f.col + '));';
    if (eng === 'mysql') return '-- MySQL 8.0.13+: functional index (note the double brackets)\nALTER TABLE ' + t + ' ADD INDEX ' + idxName(t, [f.fn, f.col]) + ' ((' + f.fn + '(' + f.col + ')));';
    return '-- add a computed column and index it\nALTER TABLE ' + t + ' ADD ' + f.col + '_' + f.fn + ' AS ' + f.fn.toUpperCase() + '(' + f.col + ') PERSISTED;\nCREATE INDEX IX_' + String(t).split('.').pop() + '_' + f.col + '_' + f.fn + ' ON ' + t + ' (' + f.col + '_' + f.fn + ');';
  }
  function funcFix(eng, t, f) {
    if (/^(date|year|month|date_trunc|trunc|to_char|datepart|datediff|extract)$/.test(f.fn)) return '-- rewrite as a range on the plain column (uses a normal index):\nWHERE ' + f.col + " >= '2026-11-01' AND " + f.col + " < '2026-12-01'\n\n" + exprIndex(eng, t, f);
    if (/^(lower|upper)$/.test(f.fn)) return exprIndex(eng, t, f) + (eng === 'postgresql' ? '\n-- or store the column as citext (case-insensitive type)' : eng === 'mysql' ? '\n-- or use a case-insensitive collation (the default *_ci collations) and drop the function' : '\n-- or use a case-insensitive collation and drop the function');
    if (f.fn === 'convert_implicit') return '-- make the parameter type match the column type (e.g. VARCHAR vs NVARCHAR)';
    return exprIndex(eng, t, f);
  }

  // ------------------------------------------------------------------ analyse a plan
  function analysePlan(text, opts) {
    opts = opts || {};
    const format = opts.format && opts.format !== 'auto' ? opts.format : detect(text);
    let plan;
    if (format === 'pg-text') plan = parsePgText(text);
    else if (format === 'pg-json') plan = parsePgJson(text);
    else if (format === 'mysql-tree') plan = parseMyTree(text);
    else if (format === 'mysql-json') plan = parseMyJson(text);
    else if (format === 'mssql-xml') plan = parseMsXml(text);
    else throw new Error('This does not look like a query plan this tool reads. Paste PostgreSQL EXPLAIN output (text or FORMAT JSON), MySQL EXPLAIN FORMAT=JSON or EXPLAIN ANALYZE, or SQL Server showplan XML.');
    finalise(plan);
    if (!opts.sql && plan.sql) opts.sql = plan.sql;
    plan.findings = findingsFor(plan, opts);
    plan.formatLabel = FORMAT_LABEL[format];
    // summary
    const S = [];
    const nodes = plan.nodes;
    const hot = nodes.filter(n => n.share > 0).sort((a, b) => b.share - a.share);
    const engineName = { postgresql: 'PostgreSQL', mysql: 'MySQL', sqlserver: 'SQL Server' }[plan.engine];
    if (plan.hasActual && plan.totalMs != null) S.push('The query ran in ' + fmtMs(plan.totalMs) + (plan.planningMs != null ? ' (planning ' + fmtMs(plan.planningMs) + ')' : '') + ' with ' + plural(nodes.length, 'plan node') + '.');
    else S.push('This is an estimated plan (no actual times), so time shares below use the ' + engineName + ' cost estimates. Run EXPLAIN ANALYZE' + (plan.engine === 'sqlserver' ? ' (an actual execution plan)' : '') + ' for real timings.');
    if (hot[0]) {
      const h = hot[0];
      let line = pct(h.share, 1) + '% of the ' + (plan.shareBy === 'time' ? 'time' : 'estimated cost') + ' is in ' + short(h.label || h.type, 90);
      if (h.rowsAct != null && isFullScan(h, plan) && h.removed.filter) line += ', which reads ' + fmtN(h.rowsAct + h.removed.filter * Math.max(1, h.act.loops)) + ' rows to return ' + fmtN(h.rowsAct);
      S.push(line + '.');
      if (hot[1] && hot[1].share >= 0.15) S.push('Next is ' + short(hot[1].label || hot[1].type, 80) + ' at ' + pct(hot[1].share, 1) + '%.');
    }
    const hi = plan.findings.filter(f => f.severity === 'high');
    if (plan.findings.length) S.push(plural(plan.findings.length, 'finding') + (hi.length ? ', ' + hi.length + ' important' : '') + ': ' + plan.findings.slice(0, 3).map(f => (/^[A-Z][a-z]/.test(f.title) ? f.title.charAt(0).toLowerCase() + f.title.slice(1) : f.title)).join('; ') + '.');
    else S.push('No obvious problems: estimates are close, there are no spills, and no large scans throw most rows away.');
    plan.summary = S;
    // strip parse-only fields so it can cross the worker boundary cleanly
    nodes.forEach(n => { delete n._mis; });
    return { kind: 'plan', format, formatLabel: plan.formatLabel, engine: plan.engine, plan: serialise(plan) };
  }
  function serialise(plan) {
    const nodes = plan.nodes.map(n => ({
      id: n.id, parentId: n.parentId, depth: n.depth, type: n.type, label: n.label || n.type, relation: n.relation, alias: n.alias, index: n.index, subplan: n.subplan,
      est: n.est, act: n.act, never: n.never, incl: n.incl, excl: n.excl, share: n.share, rowsAct: n.rowsAct, rowsEst: n.rowsEst, misest: n.misest, costSelf: n.costSelf,
      props: n.props, removed: n.removed, heap: n.heap, buffers: n.buffers, sort: n.sort, hash: n.hash, workers: n.workers, flags: n.flags, warnings: n.warnings, output: n.output.slice(0, 30), my: n.my || null, ms: n.ms || null,
      children: n.children.map(c => c.id),
    }));
    return { engine: plan.engine, format: plan.format, nodes, planningMs: plan.planningMs, executionMs: plan.executionMs, totalMs: plan.totalMs, jit: plan.jit, triggers: plan.triggers,
      warnings: plan.warnings, findings: plan.findings, summary: plan.summary, shareBy: plan.shareBy, hasActual: plan.hasActual, hasRows: plan.hasRows, io: plan.io || null,
      memoryGrant: plan.memoryGrant || null, dop: plan.dop || null, sql: plan.sql || '' };
  }

  // ------------------------------------------------------------------ query statistics (pg_stat_statements, MySQL, SQL Server)
  function parseCsv(text) {
    const s = String(text).replace(/^﻿/, '');
    const firstLine = s.split(/\r?\n/, 1)[0];
    const counts = { ',': (firstLine.match(/,/g) || []).length, ';': (firstLine.match(/;/g) || []).length, '\t': (firstLine.match(/\t/g) || []).length, '|': (firstLine.match(/\|/g) || []).length };
    const sep = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    const rows = []; let row = [], cur = '', q = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (q) { if (ch === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; continue; }
      if (ch === '"' && cur.trim() === '') { q = true; cur = ''; continue; }
      if (ch === sep) { row.push(cur); cur = ''; continue; }
      if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some(x => x.trim() !== '')) rows.push(row); row = []; continue; }
      cur += ch;
    }
    row.push(cur); if (row.some(x => x.trim() !== '')) rows.push(row);
    if (sep === '|') return rows.map(r => r.map(x => x.trim())).filter(r => !r.every(x => /^[-+]*$/.test(x))).map(r => (r[0] === '' ? r.slice(1, r[r.length - 1] === '' ? -1 : undefined) : r));
    return rows.map(r => r.map(x => x.trim()));
  }
  function parseHumanTime(v) { // sys schema: "1.23 s", "345.67 ms", "2.10 m", "12.3 us", "1.5 h"; also "00:00:02.345"
    if (v == null) return null;
    const s = String(v).trim();
    let m = s.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
    if (m) return (num(m[1]) * 3600 + num(m[2]) * 60 + num(m[3])) * 1000;
    m = s.match(/^([\d.]+)\s*(ps|ns|us|µs|ms|s|m|min|h)$/i);
    if (m) return num(m[1]) * { ps: 1e-9, ns: 1e-6, us: 1e-3, 'µs': 1e-3, ms: 1, s: 1000, m: 60000, min: 60000, h: 3600000 }[m[2].toLowerCase()];
    return isFinite(Number(s)) && s !== '' ? Number(s) : null;
  }
  function normQuery(q) {
    return String(q || '').replace(/\s+/g, ' ').replace(/'(?:[^']|'')*'/g, '?').replace(/\b\d+(\.\d+)?\b/g, '?').replace(/\(\s*\?(\s*,\s*\?)+\s*\)/g, '(?…)').trim();
  }
  function statsFromRows(header, rows, sourceHint) {
    const H = header.map(h => h.toLowerCase().replace(/^"|"$/g, '').trim());
    const col = names => { for (const nm of names) { const i = H.indexOf(nm); if (i >= 0) return i; } return -1; };
    const iq = col(['query', 'digest_text', 'sql_text', 'query_text', 'statement', 'text', 'normalized_query', 'query_sql_text', 'querytext']);
    if (iq < 0) throw new Error('No query column found. Expected a column called query, digest_text, sql_text or query_text.');
    const ic = col(['calls', 'count_star', 'exec_count', 'execution_count', 'executions', 'count', 'count_executions']);
    let unitTotal = 1, unitMean = 1, unitMax = 1;
    let it = col(['total_exec_time', 'total_time', 'total_exec_time_ms', 'total_elapsed_time_ms', 'total_latency']);
    if (it < 0) { it = col(['sum_timer_wait']); if (it >= 0) unitTotal = 1e-9; }                         // picoseconds
    if (it < 0) { it = col(['total_elapsed_time', 'total_worker_time']); if (it >= 0) unitTotal = 1e-3; } // SQL Server µs
    if (it < 0) { it = col(['avg_duration_total']); }
    let im = col(['mean_exec_time', 'mean_time', 'avg_latency', 'avg_exec_time', 'avg_elapsed_time_ms', 'avg_duration_ms']);
    if (im < 0) { im = col(['avg_timer_wait']); if (im >= 0) unitMean = 1e-9; }
    if (im < 0) { im = col(['avg_elapsed_time', 'avg_duration']); if (im >= 0) unitMean = 1e-3; }
    let ix = col(['max_exec_time', 'max_time', 'max_latency', 'max_elapsed_time_ms']);
    if (ix < 0) { ix = col(['max_timer_wait']); if (ix >= 0) unitMax = 1e-9; }
    if (ix < 0) { ix = col(['max_elapsed_time']); if (ix >= 0) unitMax = 1e-3; }
    const iqt = col(['query_time']);       // mysql.slow_log, one row per execution
    const ir = col(['rows', 'sum_rows_sent', 'rows_sent', 'total_rows', 'rows_returned', 'avg_rowcount']);
    const ie = col(['sum_rows_examined', 'rows_examined', 'rows_scanned', 'total_logical_reads']);
    const ihit = col(['shared_blks_hit']), iread = col(['shared_blks_read']);
    const itmp = col(['temp_blks_written', 'sum_created_tmp_disk_tables']);
    const ino = col(['sum_no_index_used', 'no_index_used']);
    const isTimeHuman = i => i >= 0 && rows.some(r => /[a-zµ]$|:/i.test(r[i] || ''));
    const tv = (r, i, unit) => { if (i < 0) return null; const v = r[i]; return isTimeHuman(i) ? parseHumanTime(v) : v === '' || v == null ? null : num(v) * unit; };
    const perRow = ic < 0 && (iqt >= 0 || (it < 0 && im < 0));
    const groups = new Map();
    rows.forEach(r => {
      const q = r[iq]; if (!q) return;
      const key = perRow ? normQuery(q) : q;
      let g = groups.get(key);
      if (!g) groups.set(key, g = { query: perRow ? key : q, calls: 0, total: 0, max: 0, rows: 0, examined: 0, hit: 0, read: 0, tmp: 0, noIndex: 0, hasRows: ir >= 0, hasExam: ie >= 0, hasBlk: ihit >= 0, examIsReads: ie >= 0 && H[ie] === 'total_logical_reads' });
      const calls = ic >= 0 ? num(r[ic]) : 1;
      let total = tv(r, it, unitTotal), mean = tv(r, im, unitMean);
      if (perRow) total = tv(r, iqt >= 0 ? iqt : it, 1) || 0;
      if (total == null && mean != null) total = mean * calls;
      g.calls += calls; g.total += total || 0;
      const mx = tv(r, ix, unitMax); if (mx != null && mx > g.max) g.max = mx; else if (perRow && total > g.max) g.max = total;
      if (ir >= 0) g.rows += H[ir] === 'avg_rowcount' ? num(r[ir]) * calls : num(r[ir]);
      if (ie >= 0) g.examined += num(r[ie]);
      if (ihit >= 0) { g.hit += num(r[ihit]); g.read += num(r[iread]); }
      if (itmp >= 0) g.tmp += num(r[itmp]);
      if (ino >= 0) g.noIndex += num(r[ino]);
    });
    const src = sourceHint || (H.includes('digest_text') ? 'MySQL performance_schema digest' : H.includes('sum_timer_wait') || H.includes('total_latency') ? 'MySQL statement summary' : iqt >= 0 ? 'MySQL slow_log table' :
      H.includes('total_elapsed_time') || H.includes('execution_count') ? 'SQL Server query stats' : H.includes('total_exec_time') || H.includes('total_time') || H.includes('shared_blks_hit') ? 'pg_stat_statements' : 'Query statistics');
    return summariseStats([...groups.values()], src);
  }
  function summariseStats(list, source) {
    const all = list.reduce((x, g) => x + g.total, 0);
    const calls = list.reduce((x, g) => x + g.calls, 0);
    list.forEach(g => {
      g.mean = g.calls ? g.total / g.calls : 0; g.share = all ? g.total / all : 0; g.rowsPerCall = g.calls && g.hasRows ? g.rows / g.calls : null;
      g.hitPct = g.hasBlk && g.hit + g.read ? g.hit / (g.hit + g.read) * 100 : null;
      g.flags = [];
      if (g.mean >= 1000) g.flags.push({ id: 'slow', text: 'Slow on its own: ' + fmtMs(g.mean) + ' per call. Get its plan with EXPLAIN (ANALYZE, BUFFERS) and paste it above.' });
      if (calls && g.calls >= calls * 0.1 && g.mean < 5 && g.calls >= 1000 && /^\s*(\/\*.*?\*\/\s*)?(SELECT|WITH)\b/i.test(g.query)) g.flags.push({ id: 'chatty', text: 'Called very often (' + pct(g.calls, calls) + '% of all calls) and fast each time: a sign of N+1 queries or a missing cache.' });
      if (g.hasExam && g.hasRows && !g.examIsReads && g.rows > 0 && g.examined / g.rows >= 100 && g.examined >= 100000) g.flags.push({ id: 'examined', text: 'Examines ' + fmtN(g.examined / g.rows) + ' rows for each row it returns: likely a missing or unselective index.' });
      if (g.hasExam && g.hasRows && !g.examIsReads && g.rows === 0 && g.examined >= 100000) g.flags.push({ id: 'examined', text: 'Examines ' + fmtN(g.examined) + ' rows and returns none: likely a missing index.' });
      if (g.noIndex > 0) g.flags.push({ id: 'no-index', text: 'Ran ' + fmtN(g.noIndex) + ' times with no index used (full scan).' });
      if (g.hitPct != null && g.hitPct < 90 && g.read >= 10000) g.flags.push({ id: 'cache', text: 'Only ' + g.hitPct.toFixed(1) + '% of pages came from cache: ' + fmtN(g.read) + ' blocks read from disk.' });
      if (g.rowsPerCall != null && g.rowsPerCall >= 10000) g.flags.push({ id: 'rows', text: 'Returns ' + fmtN(g.rowsPerCall) + ' rows per call: paginate, aggregate in the database, or select fewer columns.' });
      if (g.tmp > 0) g.flags.push({ id: 'temp', text: 'Wrote temporary files / disk tables (' + fmtN(g.tmp) + '): sorts or hashes that do not fit in memory.' });
    });
    list.sort((a, b) => b.total - a.total);
    const S = [];
    if (!list.length) throw new Error('No queries found in the file.');
    const top5 = list.slice(0, 5).reduce((x, g) => x + g.share, 0);
    S.push(plural(list.length, 'distinct query', 'distinct queries') + ', ' + plural(calls, 'call') + ', ' + fmtMs(all) + ' of total database time.');
    S.push('The top ' + Math.min(5, list.length) + ' take ' + Math.round(top5 * 100) + '% of it; the most expensive query alone takes ' + Math.round(list[0].share * 100) + '% (' + fmtN(list[0].calls) + ' calls, ' + fmtMs(list[0].mean) + ' each).');
    const fl = {}; list.slice(0, 50).forEach(g => g.flags.forEach(f => { fl[f.id] = (fl[f.id] || 0) + 1; }));
    if (fl.chatty) S.push(fl.chatty === 1 ? '1 query is called so often it looks like an N+1 pattern.' : fl.chatty + ' queries are called so often they look like N+1 patterns.');
    if (fl.examined || fl['no-index']) S.push(plural((fl.examined || 0) + (fl['no-index'] || 0), 'query', 'queries') + ' read far more rows than they return (index candidates).');
    return { kind: 'stats', source, queries: list.slice(0, 500), queryCount: list.length, totalMs: all, calls, summary: S };
  }
  function parseSlowLog(text) {
    const entries = []; let cur = null;
    String(text).split(/\r?\n/).forEach(l => {
      let m;
      if ((m = l.match(/^#\s*Query_time:\s*([\d.]+)\s+Lock_time:\s*([\d.]+)\s+Rows_sent:\s*(\d+)\s+Rows_examined:\s*(\d+)/))) { cur = { time: num(m[1]) * 1000, rows: num(m[3]), examined: num(m[4]), sql: '' }; entries.push(cur); return; }
      if (/^#/.test(l) || /^(SET timestamp=|use \w+;|\/\w.*Version:|Tcp port:|Time\s+Id\s+Command)/i.test(l.trim())) return;
      if (cur) cur.sql += (cur.sql ? ' ' : '') + l.trim();
    });
    if (!entries.length) throw new Error('No "# Query_time:" entries found in the slow query log.');
    const groups = new Map();
    entries.forEach(e => {
      const k = normQuery(e.sql.replace(/;\s*$/, ''));
      let g = groups.get(k);
      if (!g) groups.set(k, g = { query: k, calls: 0, total: 0, max: 0, rows: 0, examined: 0, hit: 0, read: 0, tmp: 0, noIndex: 0, hasRows: true, hasExam: true, hasBlk: false });
      g.calls++; g.total += e.time; g.max = Math.max(g.max, e.time); g.rows += e.rows; g.examined += e.examined;
    });
    return summariseStats([...groups.values()], 'MySQL slow query log');
  }
  function analyseStats(text, format) {
    format = format || detect(text);
    if (format === 'mysql-slowlog') return parseSlowLog(text);
    const rows = parseCsv(text);
    if (rows.length < 2) throw new Error('The CSV needs a header row and at least one data row.');
    return statsFromRows(rows[0], rows.slice(1));
  }
  function analyse(text, opts) {
    opts = opts || {};
    const f = opts.format && opts.format !== 'auto' ? opts.format : detect(text);
    if (!f) throw new Error('Could not recognise this input. Paste a query plan (PostgreSQL, MySQL or SQL Server) or a pg_stat_statements / slow query CSV.');
    if (f === 'stats-csv' || f === 'mysql-slowlog') return Object.assign(analyseStats(text, f), { format: f, formatLabel: FORMAT_LABEL[f] });
    return analysePlan(text, Object.assign({}, opts, { format: f }));
  }

  // ------------------------------------------------------------------ Markdown
  function toMarkdown(r) {
    const L = [];
    if (r.kind === 'stats') {
      L.push('## Query statistics (' + r.source + ')', '');
      r.summary.forEach(s => L.push('- ' + s));
      L.push('', '| # | Query | Calls | Total | Mean | Share |', '|---:|---|---:|---:|---:|---:|');
      r.queries.slice(0, 15).forEach((q, i) => L.push('| ' + (i + 1) + ' | `' + short(q.query.replace(/\|/g, '\\|'), 90) + '` | ' + fmtN(q.calls) + ' | ' + fmtMs(q.total) + ' | ' + fmtMs(q.mean) + ' | ' + Math.round(q.share * 100) + '% |'));
    } else {
      const p = r.plan;
      L.push('## Query plan (' + r.formatLabel + ')', '');
      p.summary.forEach(s => L.push(s));
      L.push('');
      if (p.findings.length) {
        L.push('**Findings**', '');
        p.findings.forEach(f => { L.push('- **' + f.title + '**. ' + f.text); if (f.fix) L.push('', '```sql', f.fix, '```', ''); });
      }
      L.push('', '**Top nodes by ' + (p.shareBy === 'time' ? 'exclusive time' : 'estimated cost') + '**', '');
      p.nodes.slice().sort((a, b) => b.share - a.share).slice(0, 5).forEach(n => L.push('- ' + Math.round(n.share * 100) + '% ' + n.label + (n.excl != null ? ' (' + fmtMs(n.excl) + ')' : '')));
    }
    L.push('', '_Analysed in the browser with the Database Performance Lab (pawansinha.com.au/tools/db-performance-lab/)._');
    return L.join('\n');
  }

  // ------------------------------------------------------------------ samples
  const samples = {
    'pg-text': [
      'EXPLAIN (ANALYZE, BUFFERS)',
      'SELECT o.id, o.total, c.name FROM orders o JOIN customers c ON c.id = o.customer_id',
      "WHERE o.status = 'pending' AND o.created_at >= now() - interval '7 days' ORDER BY o.created_at DESC;",
      '',
      '                                                                QUERY PLAN',
      '-------------------------------------------------------------------------------------------------------------------------------------------',
      ' Sort  (cost=48213.52..48218.77 rows=2100 width=48) (actual time=1893.411..1912.705 rows=41250 loops=1)',
      '   Sort Key: o.created_at DESC',
      '   Sort Method: external merge  Disk: 2632kB',
      '   Buffers: shared hit=1204 read=40127, temp read=329 written=331',
      '   ->  Hash Join  (cost=3145.00..48097.66 rows=2100 width=48) (actual time=61.204..1846.233 rows=41250 loops=1)',
      '         Hash Cond: (o.customer_id = c.id)',
      '         Buffers: shared hit=1204 read=40127',
      '         ->  Seq Scan on orders o  (cost=0.00..44925.00 rows=2100 width=28) (actual time=0.031..1712.880 rows=41250 loops=1)',
      "               Filter: (((status)::text = 'pending'::text) AND (created_at >= (now() - '7 days'::interval)))",
      '               Rows Removed by Filter: 1958750',
      '               Buffers: shared hit=1 read=24924',
      '         ->  Hash  (cost=1895.00..1895.00 rows=100000 width=24) (actual time=60.880..60.881 rows=100000 loops=1)',
      '               Buckets: 65536  Batches: 4  Memory Usage: 1878kB',
      '               Buffers: shared hit=1203 read=15203',
      '               ->  Seq Scan on customers c  (cost=0.00..1895.00 rows=100000 width=24) (actual time=0.012..21.517 rows=100000 loops=1)',
      '                     Buffers: shared hit=1203 read=15203',
      ' Planning:',
      '   Buffers: shared hit=24',
      ' Planning Time: 0.412 ms',
      ' JIT:',
      '   Functions: 12',
      '   Options: Inlining false, Optimization false, Expressions true, Deforming true',
      '   Timing: Generation 1.304 ms, Inlining 0.000 ms, Optimization 0.641 ms, Emission 9.880 ms, Total 11.825 ms',
      ' Execution Time: 1918.264 ms',
      '(29 rows)',
    ].join('\n'),
    'pg-json': JSON.stringify([{ Plan: { 'Node Type': 'Limit', 'Parallel Aware': false, 'Startup Cost': 1000.43, 'Total Cost': 23540.2, 'Plan Rows': 20, 'Plan Width': 64, 'Actual Startup Time': 0.9, 'Actual Total Time': 1534.2, 'Actual Rows': 20, 'Actual Loops': 1,
      'Shared Hit Blocks': 310522, 'Shared Read Blocks': 1204,
      Plans: [{ 'Node Type': 'Nested Loop', 'Parent Relationship': 'Outer', 'Join Type': 'Inner', 'Startup Cost': 1000.43, 'Total Cost': 98211.4, 'Plan Rows': 85, 'Plan Width': 64, 'Actual Startup Time': 0.9, 'Actual Total Time': 1534.1, 'Actual Rows': 20, 'Actual Loops': 1,
        'Shared Hit Blocks': 310522, 'Shared Read Blocks': 1204,
        Plans: [
          { 'Node Type': 'Gather', 'Parent Relationship': 'Outer', 'Startup Cost': 1000, 'Total Cost': 21455.8, 'Plan Rows': 85, 'Plan Width': 40, 'Actual Startup Time': 0.6, 'Actual Total Time': 121.3, 'Actual Rows': 77120, 'Actual Loops': 1, 'Workers Planned': 4, 'Workers Launched': 1,
            'Shared Hit Blocks': 12, 'Shared Read Blocks': 1204,
            Plans: [{ 'Node Type': 'Seq Scan', 'Parent Relationship': 'Outer', 'Parallel Aware': true, 'Relation Name': 'events', Schema: 'public', Alias: 'e', 'Startup Cost': 0, 'Total Cost': 20447.3, 'Plan Rows': 21, 'Plan Width': 40,
              'Actual Startup Time': 0.02, 'Actual Total Time': 98.4, 'Actual Rows': 38560, 'Actual Loops': 2, Filter: "((tenant_id = 42) AND (kind = 'click'::text))", 'Rows Removed by Filter': 461440, 'Shared Hit Blocks': 12, 'Shared Read Blocks': 1204 }] },
          { 'Node Type': 'Index Scan', 'Parent Relationship': 'Inner', 'Scan Direction': 'Forward', 'Index Name': 'sessions_pkey', 'Relation Name': 'sessions', Schema: 'public', Alias: 's', 'Startup Cost': 0.43, 'Total Cost': 8.45, 'Plan Rows': 1, 'Plan Width': 24,
            'Actual Startup Time': 0.018, 'Actual Total Time': 0.018, 'Actual Rows': 0, 'Actual Loops': 77120, 'Index Cond': '(id = e.session_id)', Filter: "(lower((country)::text) = 'au'::text)", 'Rows Removed by Filter': 1, 'Shared Hit Blocks': 310510 },
        ] }] },
      Planning: { 'Shared Hit Blocks': 8 }, 'Planning Time': 0.31, Triggers: [], 'Execution Time': 1534.9 }], null, 2),
    'mysql-tree': [
      'EXPLAIN ANALYZE',
      "SELECT c.country, COUNT(*) FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.status = 'shipped' AND YEAR(o.created_at) = 2026 GROUP BY c.country ORDER BY COUNT(*) DESC;",
      '',
      '-> Sort: `COUNT(*)` DESC  (actual time=2210.413..2210.418 rows=38 loops=1)',
      '    -> Table scan on <temporary>  (actual time=2210.301..2210.312 rows=38 loops=1)',
      '        -> Aggregate using temporary table  (actual time=2210.297..2210.297 rows=38 loops=1)',
      '            -> Nested loop inner join  (cost=318541.20 rows=19820) (actual time=0.512..2161.725 rows=96402 loops=1)',
      "                -> Filter: ((o.`status` = 'shipped') and (year(o.created_at) = 2026))  (cost=201005.10 rows=19820) (actual time=0.476..1932.512 rows=96402 loops=1)",
      '                    -> Table scan on o  (cost=201005.10 rows=1982045) (actual time=0.461..1650.882 rows=2000000 loops=1)',
      '                -> Single-row index lookup on c using PRIMARY (id=o.customer_id)  (cost=0.25 rows=1) (actual time=0.002..0.002 rows=1 loops=96402)',
    ].join('\n'),
    'mysql-json': JSON.stringify({ query_block: { select_id: 1, cost_info: { query_cost: '214093.85' },
      ordering_operation: { using_filesort: true, grouping_operation: { using_temporary_table: true, using_filesort: false,
        nested_loop: [
          { table: { table_name: 'o', access_type: 'ALL', possible_keys: ['fk_customer'], rows_examined_per_scan: 1982045, rows_produced_per_join: 19820, filtered: '1.00',
            cost_info: { read_cost: '196400.69', eval_cost: '1982.05', prefix_cost: '198382.74', data_read_per_join: '3M' }, used_columns: ['id', 'customer_id', 'status', 'total', 'created_at'],
            attached_condition: "((`shop`.`o`.`status` = 'shipped') and (`shop`.`o`.`created_at` >= DATE'2026-01-01'))" } },
          { table: { table_name: 'c', access_type: 'eq_ref', possible_keys: ['PRIMARY'], key: 'PRIMARY', used_key_parts: ['id'], key_length: '4', ref: ['shop.o.customer_id'], rows_examined_per_scan: 1, rows_produced_per_join: 19820, filtered: '100.00',
            cost_info: { read_cost: '4955.10', eval_cost: '1982.00', prefix_cost: '205319.84', data_read_per_join: '9M' }, used_columns: ['id', 'country'] } },
        ] } } } }, null, 2),
    'mssql-xml': [
      '<?xml version="1.0" encoding="utf-16"?>',
      '<ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan" Version="1.564" Build="16.0.4105.2">',
      ' <BatchSequence><Batch><Statements>',
      '  <StmtSimple StatementText="SELECT o.OrderId, o.Total, o.Status FROM dbo.Orders o WHERE o.CustomerEmail = @email AND o.CreatedAt &gt;= @since" StatementId="1" StatementCompId="1" StatementType="SELECT" StatementSubTreeCost="12.4821" StatementEstRows="3">',
      '   <QueryPlan DegreeOfParallelism="1" MemoryGrant="0" CachedPlanSize="40" CompileTime="3" CompileCPU="3" CompileMemory="312">',
      '    <MissingIndexes><MissingIndexGroup Impact="97.12"><MissingIndex Database="[shop]" Schema="[dbo]" Table="[Orders]">',
      '     <ColumnGroup Usage="EQUALITY"><Column Name="[CustomerEmail]" ColumnId="4"/></ColumnGroup>',
      '     <ColumnGroup Usage="INEQUALITY"><Column Name="[CreatedAt]" ColumnId="6"/></ColumnGroup>',
      '     <ColumnGroup Usage="INCLUDE"><Column Name="[Total]" ColumnId="5"/><Column Name="[Status]" ColumnId="3"/></ColumnGroup>',
      '    </MissingIndex></MissingIndexGroup></MissingIndexes>',
      '    <Warnings><PlanAffectingConvert ConvertIssue="Seek Plan" Expression="CONVERT_IMPLICIT(nvarchar(320),[o].[CustomerEmail],0)=[@email]"/></Warnings>',
      '    <QueryTimeStats CpuTime="1240" ElapsedTime="1388"/>',
      '    <RelOp NodeId="0" PhysicalOp="Nested Loops" LogicalOp="Inner Join" EstimateRows="3" EstimateIO="0" EstimateCPU="0.0001" AvgRowSize="40" EstimatedTotalSubtreeCost="12.4821" Parallel="0" EstimateRebinds="0" EstimateRewinds="0" EstimatedExecutionMode="Row">',
      '     <OutputList><ColumnReference Table="[o]" Column="OrderId"/><ColumnReference Table="[o]" Column="Total"/><ColumnReference Table="[o]" Column="Status"/></OutputList>',
      '     <RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="2" ActualExecutions="1" ActualElapsedms="1387" ActualCPUms="1239"/></RunTimeInformation>',
      '     <NestedLoops Optimized="0">',
      '      <RelOp NodeId="1" PhysicalOp="Index Scan" LogicalOp="Index Scan" EstimateRows="3" EstimatedRowsRead="1500000" EstimateIO="9.1" EstimateCPU="1.65" AvgRowSize="20" EstimatedTotalSubtreeCost="10.75" Parallel="0" EstimateRebinds="0" EstimateRewinds="0">',
      '       <OutputList><ColumnReference Table="[o]" Column="OrderId"/></OutputList>',
      '       <RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="2" ActualRowsRead="1500000" ActualExecutions="1" ActualElapsedms="1380" ActualCPUms="1232" ActualLogicalReads="9214" ActualPhysicalReads="3" ActualReadAheads="9120"/></RunTimeInformation>',
      '       <IndexScan Ordered="0" ForcedIndex="0" NoExpandHint="0" Storage="RowStore">',
      '        <Object Database="[shop]" Schema="[dbo]" Table="[Orders]" Index="[IX_Orders_CustomerEmail]" Alias="[o]" IndexKind="NonClustered"/>',
      '        <Predicate><ScalarOperator ScalarString="CONVERT_IMPLICIT(nvarchar(320),[shop].[dbo].[Orders].[CustomerEmail] as [o].[CustomerEmail],0)=[@email] AND [shop].[dbo].[Orders].[CreatedAt] as [o].[CreatedAt]&gt;=[@since]"/></Predicate>',
      '       </IndexScan>',
      '      </RelOp>',
      '      <RelOp NodeId="3" PhysicalOp="Clustered Index Seek" LogicalOp="Clustered Index Seek" EstimateRows="1" EstimateIO="0.003" EstimateCPU="0.0001" AvgRowSize="31" EstimatedTotalSubtreeCost="1.73" Parallel="0" EstimateRebinds="2" EstimateRewinds="0">',
      '       <OutputList><ColumnReference Table="[o]" Column="Total"/><ColumnReference Table="[o]" Column="Status"/></OutputList>',
      '       <RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="2" ActualExecutions="2" ActualElapsedms="0" ActualCPUms="0" ActualLogicalReads="6"/></RunTimeInformation>',
      '       <IndexScan Lookup="1" Ordered="1" ScanDirection="FORWARD" ForcedIndex="0" Storage="RowStore">',
      '        <Object Database="[shop]" Schema="[dbo]" Table="[Orders]" Index="[PK_Orders]" Alias="[o]" TableReferenceId="-1" IndexKind="Clustered"/>',
      '        <SeekPredicates><SeekPredicateNew><SeekKeys><Prefix ScanType="EQ"><RangeColumns><ColumnReference Table="[o]" Column="OrderId"/></RangeColumns></Prefix></SeekKeys></SeekPredicateNew></SeekPredicates>',
      '       </IndexScan>',
      '      </RelOp>',
      '     </NestedLoops>',
      '    </RelOp>',
      '   </QueryPlan>',
      '  </StmtSimple>',
      ' </Statements></Batch></BatchSequence>',
      '</ShowPlanXML>',
    ].join('\n'),
    'stats-csv': [
      'query,calls,total_exec_time,mean_exec_time,max_exec_time,rows,shared_blks_hit,shared_blks_read,temp_blks_written',
      '"SELECT * FROM order_items WHERE order_id = $1",1843210,92160.5,0.05,12.1,5529630,7372840,1204,0',
      '"SELECT o.id, o.total, c.name FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.status = $1 AND o.created_at >= $2 ORDER BY o.created_at DESC",4210,7959630.2,1890.67,4210.5,173662500,5069000,168934670,1393510',
      '"UPDATE sessions SET last_seen = $1 WHERE id = $2",920144,138021.6,0.15,40.2,920144,3680576,2210,0',
      '"SELECT count(*) FROM events WHERE tenant_id = $1 AND kind = $2",15320,1840320.4,120.12,980.3,15320,28104210,9120440,0',
      '"INSERT INTO audit_log (actor, action, payload) VALUES ($1, $2, $3)",401220,52158.6,0.13,25.7,401220,1604880,40,0',
      '"SELECT id, name, price FROM products WHERE category_id = $1 ORDER BY rank LIMIT $2",250310,75093.0,0.3,18.4,12515500,1001240,320,0',
    ].join('\n'),
    'mysql-slowlog': [
      '/usr/sbin/mysqld, Version: 8.0.39 (MySQL Community Server - GPL). started with:',
      'Tcp port: 3306  Unix socket: /var/run/mysqld/mysqld.sock',
      'Time                 Id Command    Argument',
      '# Time: 2026-11-08T09:14:02.118842Z',
      '# User@Host: app[app] @  [10.0.4.17]  Id:  4211',
      '# Query_time: 2.210451  Lock_time: 0.000012 Rows_sent: 38  Rows_examined: 2096402',
      'SET timestamp=1794128042;',
      "SELECT c.country, COUNT(*) FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.status = 'shipped' AND YEAR(o.created_at) = 2026 GROUP BY c.country;",
      '# Time: 2026-11-08T09:14:05.901214Z',
      '# User@Host: app[app] @  [10.0.4.18]  Id:  4214',
      '# Query_time: 1.904210  Lock_time: 0.000010 Rows_sent: 41  Rows_examined: 2096421',
      'SET timestamp=1794128045;',
      "SELECT c.country, COUNT(*) FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.status = 'pending' AND YEAR(o.created_at) = 2026 GROUP BY c.country;",
      '# Time: 2026-11-08T09:15:11.004112Z',
      '# User@Host: app[app] @  [10.0.4.17]  Id:  4230',
      '# Query_time: 1.120330  Lock_time: 0.000008 Rows_sent: 0  Rows_examined: 1500000',
      'SET timestamp=1794128111;',
      "SELECT id FROM users WHERE LOWER(email) = 'pat@example.com';",
      '# Time: 2026-11-08T09:16:42.700001Z',
      '# User@Host: app[app] @  [10.0.4.19]  Id:  4231',
      '# Query_time: 1.310004  Lock_time: 0.000009 Rows_sent: 0  Rows_examined: 1500000',
      'SET timestamp=1794128202;',
      "SELECT id FROM users WHERE LOWER(email) = 'sam@example.com';",
    ].join('\n'),
  };
  const sampleSql = {
    'pg-json': "SELECT e.*, s.user_id FROM events e JOIN sessions s ON s.id = e.session_id WHERE e.tenant_id = 42 AND e.kind = 'click' AND lower(s.country) = 'au' LIMIT 20;",
  };

  const api = { detect, parsePlan: (t, f) => { const fm = f || detect(t); return finalise(fm === 'pg-text' ? parsePgText(t) : fm === 'pg-json' ? parsePgJson(t) : fm === 'mysql-tree' ? parseMyTree(t) : fm === 'mysql-json' ? parseMyJson(t) : parseMsXml(t)); },
    analysePlan, analyseStats, analyse, columnsFromCond, sqlChecks, parseCsv, parseXml, normQuery, toMarkdown, fmtMs, fmtN, fmtKB, samples, sampleSql, FORMAT_LABEL };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DBPlanLab = api;
})(typeof self !== 'undefined' ? self : this);
