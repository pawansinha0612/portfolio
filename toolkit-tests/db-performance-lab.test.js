// Tests for docs/tools/db-performance-lab/dbplan.js. Run: node toolkit-tests/db-performance-lab.test.js
'use strict';
const path = require('path');
const assert = require('assert');
const D = require(path.join(__dirname, '..', 'docs', 'tools', 'db-performance-lab', 'dbplan.js'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e)); }
}
const plan = (t, o) => D.analyse(t, o).plan;
const find = (p, id) => p.findings.find(f => f.id === id);
const node = (p, re) => p.nodes.find(n => re.test(n.label));

// ---------------------------------------------------------------- detection
test('detects every sample format', () => {
  Object.keys(D.samples).forEach(k => assert.strictEqual(D.detect(D.samples[k]), k, k));
});
test('detects psql output with wrapped "+" lines and pgAdmin quoted lines', () => {
  const t = 'QUERY PLAN\n---------\n Seq Scan on t  (cost=0.00..1.00 rows=1 width=4) (actual time=0.01..0.02 rows=1 loops=1)+\n   Filter: (a = 1)+\n Execution Time: 0.05 ms\n(3 rows)';
  assert.strictEqual(D.detect(t), 'pg-text');
  const p = plan(t);
  assert.strictEqual(p.nodes[0].props.filter, '(a = 1)');
  const q = '"Seq Scan on t  (cost=0.00..1.00 rows=1 width=4) (actual time=0.01..0.02 rows=1 loops=1)"\n"  Filter: (a = 1)"';
  assert.strictEqual(plan(q).nodes[0].props.filter, '(a = 1)');
});

// ---------------------------------------------------------------- PostgreSQL text
test('PostgreSQL text: tree, exclusive vs inclusive time, timings and buffers', () => {
  const p = plan(D.samples['pg-text']);
  assert.strictEqual(p.nodes.length, 5);
  assert.strictEqual(p.executionMs, 1918.264);
  assert.strictEqual(p.planningMs, 0.412);
  const seq = node(p, /Seq Scan on orders/);
  assert.strictEqual(p.nodes[seq.parentId].type, 'Hash Join');
  assert.strictEqual(seq.removed.filter, 1958750);
  assert.ok(Math.abs(seq.excl - 1712.88) < 0.01);
  const hj = node(p, /^Hash Join/);
  assert.ok(Math.abs(hj.excl - (1846.233 - 1712.880 - 60.881)) < 0.01, 'exclusive = inclusive minus children');
  assert.strictEqual(p.nodes[0].buffers.sharedRead, 40127);
  assert.strictEqual(p.nodes[0].buffers.tempWritten, 331);
  assert.ok(p.jit && p.jit.total === 11.825 && p.jit.functions === 12);
  assert.ok(p.sql && /^SELECT o\.id/.test(p.sql), 'SQL above the plan is kept');
});
test('PostgreSQL text: index candidate with equality column before range column', () => {
  const p = plan(D.samples['pg-text']);
  const f = find(p, 'seq-scan-filter');
  assert.ok(f && f.severity === 'high');
  assert.ok(/ON orders \(status, created_at\)/.test(f.fix), f.fix);
  assert.ok(/CREATE INDEX CONCURRENTLY/.test(f.fix));
});
test('PostgreSQL text: external merge sort, hash batches, misestimate, disk reads', () => {
  const p = plan(D.samples['pg-text']);
  assert.ok(/External merge sort spilled 2\.6 MB/.test(find(p, 'sort-spill').title));
  assert.ok(/work_mem/.test(find(p, 'sort-spill').fix));
  assert.ok(/4 batches/.test(find(p, 'hash-spill').title));
  const m = find(p, 'misestimate');
  assert.ok(m && /20×/.test(m.title) && /Seq Scan on orders/.test(m.title), 'only the deepest misestimate is reported');
  assert.strictEqual(p.findings.filter(f => f.id === 'misestimate').length, 1);
  assert.ok(/CREATE STATISTICS/.test(m.fix));
  assert.ok(find(p, 'disk-reads'));
});
test('PostgreSQL text: loops multiply time, never executed, InitPlan labels', () => {
  const t = [
    'Nested Loop  (cost=0.43..900.00 rows=10 width=8) (actual time=0.05..250.00 rows=50000 loops=1)',
    '  InitPlan 1 (returns $0)',
    '    ->  Result  (cost=0.00..0.01 rows=1 width=4) (actual time=0.001..0.001 rows=1 loops=1)',
    '  ->  Seq Scan on a  (cost=0.00..100.00 rows=10 width=4) (actual time=0.01..20.00 rows=50000 loops=1)',
    '  ->  Index Scan using b_pkey on b  (cost=0.43..8.45 rows=1 width=4) (actual time=0.004..0.004 rows=1 loops=50000)',
    '        Index Cond: (id = a.b_id)',
    '  ->  Seq Scan on c  (cost=0.00..1.00 rows=1 width=4) (never executed)',
    'Execution Time: 251.0 ms',
  ].join('\n');
  const p = plan(t);
  const ix = node(p, /Index Scan using b_pkey/);
  assert.strictEqual(ix.incl, 200, '0.004 ms × 50,000 loops');
  assert.strictEqual(ix.rowsAct, 50000);
  assert.strictEqual(node(p, /Result/).subplan, 'InitPlan 1 (returns $0)');
  assert.ok(node(p, /Seq Scan on c/).never);
  const nl = find(p, 'nested-loop');
  assert.ok(nl && /50,000 times/.test(nl.title) && /expected only 10 outer rows/.test(nl.text));
});
test('PostgreSQL text: lossy bitmap, rows removed by filter on an index scan, workers, planning > execution', () => {
  const t = [
    'Gather  (cost=1000.00..5000.00 rows=100 width=8) (actual time=1.0..30.0 rows=900 loops=1)',
    '  Workers Planned: 4',
    '  Workers Launched: 2',
    '  ->  Bitmap Heap Scan on logs  (cost=50.00..4000.00 rows=33 width=8) (actual time=0.5..20.0 rows=300 loops=3)',
    "        Recheck Cond: (level = 'error'::text)",
    '        Rows Removed by Index Recheck: 50000',
    "        Filter: (service = 'api'::text)",
    '        Rows Removed by Filter: 9000',
    '        Heap Blocks: exact=100 lossy=2400',
    '        ->  Bitmap Index Scan on logs_level_idx  (cost=0.00..50.00 rows=1000 width=0) (actual time=0.4..0.4 rows=30000 loops=1)',
    "              Index Cond: (level = 'error'::text)",
    'Planning Time: 40.5 ms',
    'Execution Time: 31.0 ms',
  ].join('\n');
  const p = plan(t);
  assert.ok(find(p, 'lossy-bitmap') && /2,400 lossy/.test(find(p, 'lossy-bitmap').title));
  assert.ok(/2 of 4 parallel workers/.test(find(p, 'workers').title));
  assert.ok(find(p, 'planning'));
  const rr = find(p, 'rows-removed');
  assert.ok(rr && /\(level, service\)/.test(rr.fix), rr && rr.fix);
  assert.strictEqual(node(p, /Bitmap Index Scan/).index, 'logs_level_idx');
  const bh = node(p, /Bitmap Heap Scan/);
  assert.ok(Math.abs(bh.incl - 20 * 3 / 3) < 1e-9, 'time under a Gather is divided by the processes that ran it');
});
test('PostgreSQL: functions on columns → expression index; date functions → range rewrite', () => {
  const t = 'Seq Scan on users  (cost=0.00..30000.00 rows=5 width=8) (actual time=0.1..400.0 rows=1 loops=1)\n' +
    "  Filter: (lower((email)::text) = 'pat@example.com'::text)\n  Rows Removed by Filter: 999999\nExecution Time: 400.2 ms";
  const p = plan(t);
  const s = find(p, 'seq-scan-filter');
  assert.ok(/ON users \(lower\(email\)\)/.test(s.fix), s.fix);
  assert.ok(/citext/.test(find(p, 'function-on-column').fix));
  const q = plan('Seq Scan on o  (cost=0.00..1.00 rows=1 width=4) (actual time=0.1..9.0 rows=10 loops=1)', { sql: "SELECT * FROM orders o WHERE date(o.created_at) = '2026-11-08' AND o.note LIKE '%gift%' OFFSET 50000" });
  const fn = find(q, 'function-on-column');
  assert.ok(fn && /created_at >= /.test(fn.fix) && /ON orders/.test(fn.fix), fn && fn.fix);
  assert.ok(find(q, 'leading-wildcard') && /gin_trgm_ops/.test(find(q, 'leading-wildcard').fix));
  assert.ok(find(q, 'offset'));
});
test('PostgreSQL: JIT heavier than 10% of execution, foreign-key trigger', () => {
  const t = 'Delete on parent  (cost=0.00..8.00 rows=0 width=0) (actual time=0.2..0.2 rows=0 loops=1)\n  ->  Index Scan using parent_pkey on parent  (cost=0.29..8.30 rows=1 width=6) (actual time=0.02..0.03 rows=1 loops=1)\n' +
    'Planning Time: 0.1 ms\nJIT:\n  Functions: 30\n  Timing: Generation 5.0 ms, Inlining 50.0 ms, Optimization 200.0 ms, Emission 120.0 ms, Total 375.0 ms\nTrigger for constraint child_parent_id_fkey: time=900.0 calls=1\nExecution Time: 1300.0 ms';
  const p = plan(t);
  assert.ok(find(p, 'jit') && /jit = off/.test(find(p, 'jit').fix));
  const tr = find(p, 'trigger');
  assert.ok(tr && /foreign-key/.test(tr.text) && /CREATE INDEX/.test(tr.fix));
});

// ---------------------------------------------------------------- PostgreSQL JSON
test('PostgreSQL JSON: nodes, parallel divisor, misestimates, workers, function from SQL', () => {
  const r = D.analyse(D.samples['pg-json'], { sql: D.sampleSql['pg-json'] });
  const p = r.plan;
  assert.strictEqual(r.engine, 'postgresql');
  assert.strictEqual(p.nodes.length, 5);
  const ps = node(p, /Parallel Seq Scan on public\.events|Parallel Seq Scan on events/);
  assert.ok(ps, 'parallel seq scan label');
  assert.ok(Math.abs(ps.incl - 98.4) < 0.01, 'divided by leader + 1 launched worker');
  assert.ok(/ON events \(tenant_id, kind\)/.test(find(p, 'seq-scan-filter').fix));
  assert.ok(/1 of 4/.test(find(p, 'workers').title));
  assert.ok(find(p, 'nested-loop'));
  assert.ok(/ON sessions \(lower\(country\)\)/.test(find(p, 'function-on-column').fix));
  assert.ok(!find(p, 'rows-removed'), 'one row removed per primary-key lookup is not a filter problem');
});

// ---------------------------------------------------------------- MySQL
test('MySQL EXPLAIN ANALYZE tree: Filter over table scan becomes an index candidate', () => {
  const p = plan(D.samples['mysql-tree']);
  assert.strictEqual(p.nodes.length, 7);
  const scan = node(p, /^Table scan on o$/);
  assert.strictEqual(scan.rowsAct, 2000000);
  const filt = p.nodes[scan.parentId];
  assert.strictEqual(filt.type, 'Filter');
  assert.strictEqual(filt.removed.filter, 2000000 - 96402);
  const f = find(p, 'seq-scan-filter');
  assert.ok(/ALTER TABLE orders\s+ADD INDEX idx_orders_status_created_at \(status, created_at\)/.test(f.fix), f.fix);
  assert.ok(/rewrite year\(o\.created_at\) as a range/.test(f.fix));
  assert.ok(find(p, 'mysql-temporary'));
  const lk = node(p, /Single-row index lookup/);
  assert.strictEqual(lk.index, 'PRIMARY');
  assert.strictEqual(lk.act.loops, 96402);
});
test('MySQL FORMAT=JSON: estimated plan, cost shares, filesort, temporary', () => {
  const r = D.analyse(D.samples['mysql-json'], { sql: 'SELECT c.country, SUM(o.total) FROM orders o JOIN customers c ON c.id = o.customer_id GROUP BY c.country ORDER BY 2 DESC' });
  const p = r.plan;
  assert.strictEqual(p.shareBy, 'cost');
  assert.ok(!p.hasActual);
  const o = node(p, /Table scan on o/);
  assert.ok(o.share > 0.9);
  const f = find(p, 'seq-scan-filter');
  assert.ok(/ALTER TABLE orders/.test(f.fix) && /\(status, created_at\)/.test(f.fix), f.fix);
  assert.ok(find(p, 'mysql-filesort') && find(p, 'mysql-temporary'));
  assert.ok(!find(p, 'nested-loop'), 'eq_ref lookups are not flagged in an estimated plan');
  assert.ok(/estimated plan/.test(p.summary[0]));
});
test('MySQL JSON format version 2 (tree in JSON)', () => {
  const v2 = { query: 'select * from t where a = 1', operation: "Filter: (t.a = 1)", estimated_rows: 10, estimated_total_cost: 1000, actual_rows: 5, actual_first_row_ms: 0.1, actual_last_row_ms: 300, actual_loops: 1,
    inputs: [{ operation: 'Table scan on t', table_name: 't', access_type: 'table', estimated_rows: 100000, estimated_total_cost: 1000, actual_rows: 100000, actual_first_row_ms: 0.05, actual_last_row_ms: 250, actual_loops: 1 }] };
  const p = plan(JSON.stringify(v2));
  assert.strictEqual(p.nodes.length, 2);
  assert.ok(find(p, 'seq-scan-filter') && /ADD INDEX idx_t_a \(a\)/.test(find(p, 'seq-scan-filter').fix));
});

// ---------------------------------------------------------------- SQL Server
test('SQL Server XML: operators, actual counters, missing index, implicit conversion', () => {
  const r = D.analyse(D.samples['mssql-xml']);
  const p = r.plan;
  assert.strictEqual(r.engine, 'sqlserver');
  assert.strictEqual(p.nodes.length, 3);
  assert.strictEqual(p.executionMs, 1388);
  const scan = node(p, /^Index Scan/);
  assert.strictEqual(scan.ms.rowsRead, 1500000);
  assert.strictEqual(scan.relation, 'dbo.Orders');
  const mi = find(p, 'missing-index');
  assert.ok(/ON dbo\.Orders \(CustomerEmail, CreatedAt\)\s+INCLUDE \(Total, Status\)/.test(mi.fix), mi.fix);
  assert.ok(find(p, 'implicit-convert').severity === 'high');
  assert.ok(node(p, /^Key Lookup/).flags.lookup);
  assert.ok(/SELECT o\.OrderId/.test(p.sql));
});
test('SQL Server XML: key lookup executed many times → covering index; tempdb spill', () => {
  const xml = '<ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan"><BatchSequence><Batch><Statements><StmtSimple StatementText="select" StatementSubTreeCost="5"><QueryPlan>' +
    '<RelOp NodeId="0" PhysicalOp="Nested Loops" LogicalOp="Inner Join" EstimateRows="10" EstimatedTotalSubtreeCost="5"><RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="5000" ActualExecutions="1" ActualElapsedms="900"/></RunTimeInformation><NestedLoops>' +
    '<RelOp NodeId="1" PhysicalOp="Index Seek" LogicalOp="Index Seek" EstimateRows="10" EstimatedTotalSubtreeCost="0.1"><RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="5000" ActualExecutions="1" ActualElapsedms="20"/></RunTimeInformation><IndexScan><Object Schema="[dbo]" Table="[Users]" Index="[IX_Users_Country]"/><SeekPredicates><SeekPredicateNew><SeekKeys><Prefix ScanType="EQ"><RangeColumns><ColumnReference Column="Country"/></RangeColumns></Prefix></SeekKeys></SeekPredicateNew></SeekPredicates></IndexScan></RelOp>' +
    '<RelOp NodeId="2" PhysicalOp="Clustered Index Seek" LogicalOp="Clustered Index Seek" EstimateRows="1" EstimatedTotalSubtreeCost="4"><OutputList><ColumnReference Column="Email"/><ColumnReference Column="Name"/></OutputList><Warnings><SpillToTempDb SpillLevel="1" SpilledThreadCount="1"/></Warnings><RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="5000" ActualExecutions="5000" ActualElapsedms="850" ActualLogicalReads="15000"/></RunTimeInformation><IndexScan Lookup="1"><Object Schema="[dbo]" Table="[Users]" Index="[PK_Users]"/></IndexScan></RelOp>' +
    '</NestedLoops></RelOp></QueryPlan></StmtSimple></Statements></Batch></BatchSequence></ShowPlanXML>';
  const p = plan(xml);
  const kl = find(p, 'key-lookup');
  assert.ok(kl && /5,000 times/.test(kl.title));
  assert.ok(/ON dbo\.Users \(Country\)\s+INCLUDE \(Email, Name\)/.test(kl.fix), kl.fix);
  assert.ok(find(p, 'tempdb-spill'));
  assert.strictEqual(node(p, /Key Lookup/).excl, 850);
});

// ---------------------------------------------------------------- helpers
test('columnsFromCond: equality, range, BETWEEN, OR, functions, leading wildcard', () => {
  const c = D.columnsFromCond("((status = 'paid') AND (created_at BETWEEN '2026-01-01' AND '2026-02-01') AND (lower(email) = 'x') AND (name ~~ '%bob%'::text))");
  assert.deepStrictEqual(c.eq.map(x => x.col), ['status']);
  assert.deepStrictEqual(c.range.map(x => x.col), ['created_at']);
  assert.deepStrictEqual(c.funcs.map(x => x.fn + ':' + x.col), ['lower:email']);
  assert.deepStrictEqual(c.likeLeading.map(x => x.col), ['name']);
  assert.ok(D.columnsFromCond('((a = 1) OR (b = 2))').ors);
  assert.deepStrictEqual(D.columnsFromCond('[shop].[dbo].[Orders].[Status] as [o].[Status]=N\'x\'').eq.map(x => x.col), ['Status']);
});
test('XML parser handles entities, self-closing tags and namespaces', () => {
  const x = D.parseXml('<?xml version="1.0"?><a:Root xmlns:a="x"><B v="1 &lt; 2 &amp; 3"/><C><D/></C></a:Root>');
  const root = x.children[0];
  assert.strictEqual(root.name, 'Root');
  assert.strictEqual(root.children[0].attrs.v, '1 < 2 & 3');
  assert.strictEqual(root.children[1].children[0].name, 'D');
});

// ---------------------------------------------------------------- statistics
test('pg_stat_statements CSV: ranking, shares and flags', () => {
  const r = D.analyse(D.samples['stats-csv']);
  assert.strictEqual(r.kind, 'stats');
  assert.strictEqual(r.source, 'pg_stat_statements');
  assert.strictEqual(r.queryCount, 6);
  assert.ok(/^SELECT o\.id/.test(r.queries[0].query));
  const ids = q => q.flags.map(f => f.id);
  assert.ok(ids(r.queries[0]).includes('slow') && ids(r.queries[0]).includes('cache') && ids(r.queries[0]).includes('temp'));
  assert.ok(ids(r.queries.find(q => /order_items/.test(q.query))).includes('chatty'));
  assert.ok(!ids(r.queries.find(q => /UPDATE sessions/.test(q.query))).includes('chatty'), 'writes are not flagged as N+1');
  assert.ok(Math.abs(r.queries.reduce((x, q) => x + q.share, 0) - 1) < 1e-9);
});
test('MySQL digest CSV (picoseconds) and sys schema human times', () => {
  const csv = 'DIGEST_TEXT,COUNT_STAR,SUM_TIMER_WAIT,SUM_ROWS_SENT,SUM_ROWS_EXAMINED,SUM_NO_INDEX_USED\n' +
    '"SELECT * FROM `t` WHERE `a` = ?",1000,5000000000000,1000,50000000,1000\n"SELECT ? ",10,1000000000,10,0,0';
  const r = D.analyse(csv);
  assert.strictEqual(r.source, 'MySQL performance_schema digest');
  assert.strictEqual(r.queries[0].total, 5000);
  assert.ok(r.queries[0].flags.some(f => f.id === 'examined') && r.queries[0].flags.some(f => f.id === 'no-index'));
  const sys = D.analyse('query,exec_count,total_latency,avg_latency\n"select 1",10,1.50 s,150.00 ms\n"select 2",100,2.00 m,1.20 s');
  assert.strictEqual(sys.queries[0].total, 120000);
  assert.strictEqual(sys.queries[1].mean, 150);
});
test('MySQL slow query log groups by normalised query', () => {
  const r = D.analyse(D.samples['mysql-slowlog']);
  assert.strictEqual(r.queryCount, 2);
  assert.strictEqual(r.queries[0].calls, 2);
  assert.ok(/status = \?/.test(r.queries[0].query));
  assert.ok(Math.abs(r.queries[0].total - (2210.451 + 1904.21)) < 0.01);
});
test('SQL Server query stats CSV (microseconds)', () => {
  const r = D.analyse('query_text,execution_count,total_elapsed_time,total_logical_reads\n"SELECT a FROM b",100,5000000,900000');
  assert.strictEqual(r.source, 'SQL Server query stats');
  assert.strictEqual(r.queries[0].total, 5000);
  assert.strictEqual(r.queries[0].mean, 50);
});
test('Markdown output for a plan and for stats', () => {
  const m = D.toMarkdown(D.analyse(D.samples['pg-text']));
  assert.ok(/## Query plan/.test(m) && /```sql/.test(m) && /db-performance-lab/.test(m));
  assert.ok(/\| # \| Query \|/.test(D.toMarkdown(D.analyse(D.samples['stats-csv']))));
});
test('unknown input gives a helpful error', () => {
  assert.throws(() => D.analyse('hello world'), /Could not recognise/);
});
test('big plan: 20,000-node PostgreSQL text plan analyses quickly', () => {
  const L = ['Append  (cost=0.00..1.00 rows=1 width=4) (actual time=0.01..2000.0 rows=200000 loops=1)'];
  for (let i = 0; i < 20000; i++) L.push('  ->  Seq Scan on part_' + i + '  (cost=0.00..1.00 rows=1 width=4) (actual time=0.001..0.09 rows=10 loops=1)\n        Filter: (tenant_id = 7)\n        Rows Removed by Filter: 5');
  const t0 = Date.now();
  const p = plan(L.join('\n'));
  const ms = Date.now() - t0;
  assert.strictEqual(p.nodes.length, 20001);
  assert.ok(ms < 5000, 'took ' + ms + ' ms');
  console.log('       (20,001 nodes in ' + ms + ' ms)');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
