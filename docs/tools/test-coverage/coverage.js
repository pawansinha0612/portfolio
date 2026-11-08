/* Test Coverage Intelligence: pure functions, no DOM. Runs in the browser (window.CoverageIntel), in a Web Worker
   (worker.js) and in Node (module.exports) for toolkit-tests/test-coverage.test.js. Nothing is sent anywhere.

   parseCoverage(text)          LCOV, Cobertura XML, JaCoCo XML, Istanbul coverage-summary.json / coverage-final.json
                                → { format, files: [{ path, lt, lc, bt, bc, ft, fc, lines: {line: hits} | null }] }
   parseTestResults(runs)       JUnit XML files (one per run) → per-test status, flaky, failing
   parseChurn(text)             `git log --numstat` output or a CSV of path,commits → { path: { commits, changed } }
   parseRequirements(text)      CSV of requirement → tests (or just a list of requirements)
   analyse(input)               everything together: files, packages, hotspots, requirements, test overlay, diff,
                                release summary and CI gate snippets
   diffReports(base, head)      coverage change between two reports, with new uncovered lines
   ciGates(opts)                GitHub Actions / GitLab CI / tool-config snippets for a coverage gate
   The JUnit parser is shared with /tools/ci-failure-detective/ci.js when that file is loaded first. */
(function (root) {
  'use strict';
  let CI = root && root.CIDetective;
  if (!CI && typeof require === 'function') { try { CI = require('../ci-failure-detective/ci.js'); } catch (e) { CI = null; } }

  // ------------------------------------------------------------------ helpers
  function decode(s) {
    return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (m, e) => {
      if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e.toLowerCase()];
    });
  }
  function attrs(tag) {
    const a = {};
    const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = re.exec(tag))) a[m[1]] = decode(m[3] != null ? m[3] : m[4]);
    return a;
  }
  const normPath = p => String(p || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/');
  const base = p => normPath(p).split('/').pop();
  const dirname = p => { const s = normPath(p).split('/'); s.pop(); return s.join('/') || '.'; };
  const pct = (c, t) => (t > 0 ? (100 * c) / t : null);
  const round1 = x => (x == null ? null : Math.round(x * 10) / 10);

  function newFile(path) { return { path: normPath(path), lines: {}, br: {}, hasLines: false, ft: 0, fc: 0, decl: {} }; }
  function addLine(f, ln, hits) {
    if (!(ln > 0)) return;
    f.hasLines = true;
    const prev = f.lines[ln];
    if (prev === undefined || hits > prev) f.lines[ln] = hits;
  }
  function setBranch(f, ln, total, covered) {
    const prev = f.br[ln];
    if (!prev || total > prev[0] || (total === prev[0] && covered > prev[1])) f.br[ln] = [total, covered];
  }
  function finish(f) {
    let lt = 0, lc = 0, bt = 0, bc = 0;
    for (const k in f.lines) { lt++; if (f.lines[k] > 0) lc++; }
    for (const k in f.br) { bt += f.br[k][0]; bc += f.br[k][1]; }
    if (!f.hasLines && f.decl.lt != null) { lt = f.decl.lt; lc = f.decl.lc || 0; }
    if (!bt && f.decl.bt != null) { bt = f.decl.bt; bc = f.decl.bc || 0; }
    return { path: f.path, lt, lc, bt, bc, ft: f.ft || 0, fc: f.fc || 0, lines: f.hasLines ? f.lines : null, branches: bt ? f.br : null };
  }
  // the same file can appear more than once (sharded runs, Cobertura classes that share a file): keep the best hit count per line
  function mergeRaw(list) {
    const by = new Map();
    for (const f of list) {
      const o = by.get(f.path);
      if (!o) { by.set(f.path, f); continue; }
      for (const k in f.lines) addLine(o, +k, f.lines[k]);
      for (const k in f.br) setBranch(o, +k, f.br[k][0], f.br[k][1]);
      o.ft = Math.max(o.ft, f.ft); o.fc = Math.max(o.fc, f.fc);
      if (f.decl.lt != null) { o.decl.lt = (o.decl.lt || 0) + f.decl.lt; o.decl.lc = (o.decl.lc || 0) + (f.decl.lc || 0); }
      if (f.decl.bt != null) { o.decl.bt = (o.decl.bt || 0) + f.decl.bt; o.decl.bc = (o.decl.bc || 0) + (f.decl.bc || 0); }
    }
    return [...by.values()].map(finish);
  }

  // ------------------------------------------------------------------ coverage parsers
  function parseLCOV(text) {
    const out = [];
    let f = null;
    for (const raw of String(text).split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const i = line.indexOf(':');
      const key = i > 0 ? line.slice(0, i) : line, val = i > 0 ? line.slice(i + 1) : '';
      if (key === 'SF') { if (f) out.push(f); f = newFile(val); continue; }
      if (key === 'end_of_record') { if (f) out.push(f); f = null; continue; }
      if (!f) continue;
      if (key === 'DA') { const p = val.split(','); addLine(f, parseInt(p[0], 10), parseInt(p[1], 10) || 0); }
      else if (key === 'BRDA') {
        const p = val.split(','), ln = parseInt(p[0], 10);
        const b = f.br[ln] || (f.br[ln] = [0, 0]);
        b[0]++; if (p[3] !== '-' && parseInt(p[3], 10) > 0) b[1]++;
      }
      else if (key === 'LF') f.decl.lt = +val; else if (key === 'LH') f.decl.lc = +val;
      else if (key === 'BRF') f.decl.bt = +val; else if (key === 'BRH') f.decl.bc = +val;
      else if (key === 'FNF') f.ft = +val; else if (key === 'FNH') f.fc = +val;
    }
    if (f) out.push(f);
    if (!out.length) throw new Error('No SF: records found. An LCOV file (lcov.info) has SF:, DA: and end_of_record lines.');
    return mergeRaw(out);
  }

  function parseCobertura(xml) {
    const s = String(xml).replace(/<!--[\s\S]*?-->/g, '');
    const out = [];
    const re = /<(\/?)(class|line)\b([^>]*?)(\/?)>/g;
    let m, f = null;
    while ((m = re.exec(s))) {
      if (m[2] === 'class') {
        if (m[1]) { f = null; continue; }
        const a = attrs(m[3]);
        f = newFile(a.filename || a.name || '(unknown)');
        out.push(f);
        if (m[4]) f = null;
        continue;
      }
      if (!f || m[1]) continue;
      const a = attrs(m[3]);
      const ln = parseInt(a.number, 10);
      addLine(f, ln, parseInt(a.hits, 10) || 0);
      const cc = /\((\d+)\s*\/\s*(\d+)\)/.exec(a['condition-coverage'] || '');
      if (a.branch === 'true' && cc) setBranch(f, ln, +cc[2], +cc[1]);
    }
    if (!out.length) throw new Error('No <class filename="..."> elements found in this Cobertura XML.');
    return mergeRaw(out);
  }

  function parseJaCoCo(xml) {
    const s = String(xml).replace(/<!--[\s\S]*?-->/g, '').replace(/<!DOCTYPE[^>]*>/i, '');
    const out = [];
    const re = /<(\/?)(package|sourcefile|line|counter)\b([^>]*?)(\/?)>/g;
    let m, pkg = '', f = null;
    while ((m = re.exec(s))) {
      const closing = !!m[1], tag = m[2];
      if (tag === 'package') { if (!closing) pkg = attrs(m[3]).name || ''; else pkg = ''; continue; }
      if (tag === 'sourcefile') {
        if (closing) { f = null; continue; }
        const a = attrs(m[3]);
        f = newFile((pkg ? pkg + '/' : '') + (a.name || '(unknown)'));
        out.push(f);
        continue;
      }
      if (!f || closing) continue;
      const a = attrs(m[3]);
      if (tag === 'line') {
        const ln = parseInt(a.nr, 10), ci = parseInt(a.ci, 10) || 0, mb = parseInt(a.mb, 10) || 0, cb = parseInt(a.cb, 10) || 0;
        addLine(f, ln, ci);
        if (mb + cb > 0) setBranch(f, ln, mb + cb, cb);
      } else if (tag === 'counter' && a.type === 'METHOD') {
        f.ft = (parseInt(a.missed, 10) || 0) + (parseInt(a.covered, 10) || 0); f.fc = parseInt(a.covered, 10) || 0;
      }
    }
    if (!out.length) throw new Error('No <sourcefile> elements found. Use the JaCoCo XML report (jacoco.xml), not the HTML or CSV report.');
    return mergeRaw(out);
  }

  function parseIstanbul(json) {
    const data = typeof json === 'string' ? JSON.parse(json) : json;
    const out = [];
    const keys = Object.keys(data || {});
    const isFinal = keys.some(k => data[k] && data[k].statementMap);
    for (const k of keys) {
      const d = data[k];
      if (!d || typeof d !== 'object') continue;
      if (isFinal) {
        if (!d.statementMap) continue;
        const f = newFile(d.path || k);
        f.hasLines = true;
        for (const id in d.statementMap) {
          const st = d.statementMap[id], ln = st && st.start && st.start.line;
          if (ln > 0) addLine(f, ln, +(d.s && d.s[id]) || 0);
        }
        for (const id in d.branchMap || {}) {
          const bm = d.branchMap[id], counts = (d.b && d.b[id]) || [];
          const ln = bm.line || (bm.loc && bm.loc.start && bm.loc.start.line) || (bm.locations && bm.locations[0] && bm.locations[0].start.line) || 0;
          const prev = f.br[ln] || [0, 0];
          f.br[ln] = [prev[0] + counts.length, prev[1] + counts.filter(c => c > 0).length];
        }
        const fns = Object.keys(d.fnMap || {});
        f.ft = fns.length; f.fc = fns.filter(id => (d.f && d.f[id]) > 0).length;
        out.push(f);
      } else {
        if (k === 'total' || !d.lines) continue;
        const f = newFile(k);
        f.decl = { lt: +d.lines.total || 0, lc: +d.lines.covered || 0 };
        if (d.branches) { f.decl.bt = +d.branches.total || 0; f.decl.bc = +d.branches.covered || 0; }
        if (d.functions) { f.ft = +d.functions.total || 0; f.fc = +d.functions.covered || 0; }
        out.push(f);
      }
    }
    if (!out.length) throw new Error('No files found in this JSON. Use coverage-summary.json (json-summary reporter) or coverage-final.json (json reporter).');
    return { format: isFinal ? 'istanbul-final' : 'istanbul-summary', files: mergeRaw(out) };
  }

  const FORMAT_LABEL = { lcov: 'LCOV', cobertura: 'Cobertura XML', jacoco: 'JaCoCo XML', 'istanbul-final': 'Istanbul coverage-final.json', 'istanbul-summary': 'Istanbul coverage-summary.json' };

  function detectFormat(text) {
    const t = String(text || '').replace(/^﻿/, '').trimStart();
    if (!t) return '';
    if (t[0] === '{') return 'istanbul';
    const head = t.slice(0, 5000);
    if (/<coverage\b/.test(head) && !/clover=/.test(head)) return 'cobertura';
    if (/<report\b/.test(head) || /<!DOCTYPE report/.test(head)) return 'jacoco';
    if (/^(TN|SF):/m.test(head)) return 'lcov';
    return '';
  }

  function parseCoverage(text) {
    const fmt = detectFormat(text);
    let r;
    if (fmt === 'istanbul') {
      let data;
      try { data = JSON.parse(String(text).replace(/^﻿/, '')); } catch (e) { throw new Error('This looks like JSON but does not parse: ' + e.message); }
      r = parseIstanbul(data);
    }
    else if (fmt === 'cobertura') r = { format: 'cobertura', files: parseCobertura(text) };
    else if (fmt === 'jacoco') r = { format: 'jacoco', files: parseJaCoCo(text) };
    else if (fmt === 'lcov') r = { format: 'lcov', files: parseLCOV(text) };
    else throw new Error('Format not recognised. Paste LCOV (lcov.info), Cobertura XML, JaCoCo XML, or Istanbul coverage-summary.json / coverage-final.json.');
    r.label = FORMAT_LABEL[r.format];
    shortenPaths(r.files);
    return r;
  }

  const SOURCE_ROOTS = /^(src|lib|app|apps|packages|internal|pkg|cmd|source|sources|main|test|tests|server|client|web|modules)$/;
  // absolute paths from a CI runner are long and identical up to the repo root: drop the shared prefix for display
  function shortenPaths(files) {
    const abs = files.length > 1 && files.every(f => /^(\/|[A-Za-z]:\/)/.test(f.path));
    let prefix = '';
    if (abs) {
      const parts = files.map(f => f.path.split('/'));
      const first = parts[0];
      let n = 0;
      while (n < first.length - 1 && parts.every(p => p.length - 1 > n && p[n] === first[n])) n++;
      // keep a well-known source folder (src/, lib/, app/ …) in the path: it is part of the repository, not the runner
      for (let i = n - 1; i > 0; i--) if (SOURCE_ROOTS.test(first[i])) { n = i; break; }
      prefix = first.slice(0, n).join('/');
      if (prefix) prefix += '/';
    }
    files.forEach(f => { f.full = f.path; f.path = prefix && f.path.startsWith(prefix) ? f.path.slice(prefix.length) : f.path; });
    return prefix;
  }

  function totals(files) {
    const t = { files: files.length, lt: 0, lc: 0, bt: 0, bc: 0, ft: 0, fc: 0 };
    files.forEach(f => { t.lt += f.lt; t.lc += f.lc; t.bt += f.bt; t.bc += f.bc; t.ft += f.ft; t.fc += f.fc; });
    t.linePct = round1(pct(t.lc, t.lt)); t.branchPct = round1(pct(t.bc, t.bt)); t.fnPct = round1(pct(t.fc, t.ft));
    return t;
  }
  function uncoveredLines(f) {
    if (!f.lines) return [];
    return Object.keys(f.lines).filter(k => !(f.lines[k] > 0)).map(Number).sort((a, b) => a - b);
  }
  // 3,4,5,9 → "3–5, 9"
  function ranges(nums, max) {
    const out = [];
    for (let i = 0; i < nums.length; i++) {
      let j = i;
      while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
      out.push(i === j ? String(nums[i]) : nums[i] + '–' + nums[j]);
      i = j;
    }
    if (max && out.length > max) return out.slice(0, max).join(', ') + ' and ' + (out.length - max) + ' more';
    return out.join(', ');
  }

  // ------------------------------------------------------------------ path matching (coverage paths vs git paths vs test names)
  function makeMatcher(files) {
    const byBase = new Map();
    files.forEach(f => { const b = base(f.full || f.path).toLowerCase(); if (!byBase.has(b)) byBase.set(b, []); byBase.get(b).push(f); });
    return function match(p) {
      const segs = normPath(p).toLowerCase().split('/');
      const cands = byBase.get(segs[segs.length - 1]);
      if (!cands) return null;
      let best = null, bestScore = 0;
      for (const f of cands) {
        const fs = (f.full || f.path).toLowerCase().split('/');
        let k = 0;
        while (k < segs.length && k < fs.length && segs[segs.length - 1 - k] === fs[fs.length - 1 - k]) k++;
        if (k > bestScore) { best = f; bestScore = k; }
      }
      // a bare file name that exists in several folders is ambiguous: only accept it when the folders also agree
      if (cands.length > 1 && bestScore < 2) return null;
      return best;
    };
  }

  // ------------------------------------------------------------------ churn
  function parseChurn(text) {
    const s = String(text || '');
    const out = {};
    const lines = s.split(/\r?\n/);
    const isNumstat = lines.some(l => /^(\d+|-)\t(\d+|-)\t.+/.test(l));
    if (isNumstat) {
      let inBlock = false, commits = 0;
      const seen = new Set();
      for (const l of lines) {
        const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(l);
        if (!m) { if (inBlock) { inBlock = false; seen.clear(); } continue; }
        if (!inBlock) { inBlock = true; commits++; }
        let p = m[3].trim();
        p = p.replace(/\{([^{}]*) => ([^{}]*)\}/g, '$2').replace(/^.* => (.+)$/, '$1');
        p = normPath(p);
        if (seen.has(p)) continue;
        seen.add(p);
        const o = out[p] || (out[p] = { commits: 0, changed: 0 });
        o.commits++;
        o.changed += (m[1] === '-' ? 0 : +m[1]) + (m[2] === '-' ? 0 : +m[2]);
      }
      return { kind: 'git', commits, files: out };
    }
    const rows = parseCSV(s).filter(r => r.length >= 2 && r[0].trim());
    rows.forEach((r, i) => {
      const c = parseFloat(r[1]);
      if (isNaN(c)) { if (i === 0) return; else return; }
      out[normPath(r[0])] = { commits: c, changed: parseFloat(r[2]) || 0 };
    });
    return { kind: 'csv', commits: null, files: out };
  }

  function parseCSV(text) {
    const rows = [];
    let row = [], cur = '', q = false;
    const s = String(text || '');
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) {
        if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',' || c === '\t') { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
      else cur += c;
    }
    if (cur || row.length) { row.push(cur); rows.push(row); }
    return rows.map(r => r.map(x => x.trim())).filter(r => r.some(Boolean));
  }

  // ------------------------------------------------------------------ test results
  function miniJUnit(xml) {
    const s = String(xml);
    const cases = [];
    const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
    let m;
    while ((m = re.exec(s))) {
      const a = attrs(m[1]), body = m[3] || '';
      let status = 'pass';
      if (/<failure\b/.test(body)) status = 'fail'; else if (/<error\b/.test(body)) status = 'error'; else if (/<skipped\b/.test(body)) status = 'skip';
      cases.push({ classname: a.classname || '', name: a.name || '(unnamed)', file: a.file || '', status, flaky: /<flaky(Failure|Error)\b/.test(body), message: '' });
    }
    return { cases };
  }
  function testKey(c) { return (c.classname ? c.classname + ' › ' : '') + c.name; }

  function parseTestResults(runs) {
    const tests = new Map();
    const runInfo = [];
    (runs || []).forEach((run, idx) => {
      const name = run.name || 'Run ' + (idx + 1);
      let j;
      try { j = CI && CI.parseJUnitXML ? CI.parseJUnitXML(run.text) : miniJUnit(run.text); }
      catch (e) { runInfo.push({ name, error: e.message }); return; }
      if (!j.cases.length) { runInfo.push({ name, error: 'No <testcase> elements.' }); return; }
      const info = { name, total: j.cases.length, passed: 0, failed: 0, skipped: 0 };
      j.cases.forEach(c => {
        const k = testKey(c);
        const t = tests.get(k) || { key: k, classname: c.classname, name: c.name, file: c.file || '', history: [], retried: false, message: '' };
        const st = c.status === 'error' ? 'fail' : c.status;
        t.history.push(st);
        if (c.flaky) t.retried = true;
        if (st === 'fail' && c.message) t.message = c.message;
        if (st === 'pass') info.passed++; else if (st === 'fail') info.failed++; else info.skipped++;
        tests.set(k, t);
      });
      runInfo.push(info);
    });
    const list = [...tests.values()].map(t => {
      const ran = t.history.filter(h => h !== 'skip');
      const fails = ran.filter(h => h === 'fail').length;
      const last = ran[ran.length - 1] || 'skip';
      let status;
      if (t.retried || (fails > 0 && fails < ran.length)) status = 'flaky';
      else if (fails > 0) status = 'fail';
      else if (!ran.length) status = 'skip';
      else status = 'pass';
      return Object.assign(t, { status, last, fails, runs: ran.length });
    });
    return { runs: runInfo, tests: list };
  }

  // which source file does a test exercise? CartTest → Cart.java, test_cart.py → cart.py, cart.spec.ts → cart.ts
  const normTok = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  function subjectTokens(t) {
    const toks = [];
    const strip = s => String(s || '').replace(/\.(ts|tsx|js|jsx|mjs|py|java|kt|rb|go|cs|php|scala)$/i, '')
      .replace(/[._-](spec|test|tests|cy|e2e|it)$/i, '').replace(/(Tests?|Spec|IT|IntegrationTest)$/, '').replace(/^(test_|Test(?=[A-Z_]))/, '');
    if (t.file) toks.push(strip(base(t.file)));
    const segs = String(t.classname || '').split(/[./\\]/).filter(Boolean);
    if (/\.(ts|tsx|js|jsx|mjs|py)$/i.test(t.classname || '')) toks.push(strip(base(t.classname)));
    else {
      if (segs.length) toks.push(strip(segs[segs.length - 1]));
      if (segs.length > 1) toks.push(strip(segs[segs.length - 2]));
    }
    return [...new Set(toks.map(normTok).filter(x => x.length >= 3))];
  }
  function mapTestsToFiles(tests, files) {
    const byName = new Map();
    files.forEach(f => {
      const k = normTok(base(f.path).replace(/\.[^.]+$/, ''));
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push(f);
    });
    let mapped = 0;
    const perFile = new Map();
    tests.forEach(t => {
      for (const tok of subjectTokens(t)) {
        const hit = byName.get(tok);
        if (hit) {
          mapped++;
          hit.forEach(f => {
            const o = perFile.get(f.path) || { tests: 0, failing: 0, flaky: 0, names: [] };
            o.tests++;
            if (t.status === 'fail') { o.failing++; o.names.push(t.key); }
            if (t.status === 'flaky') { o.flaky++; o.names.push(t.key); }
            perFile.set(f.path, o);
          });
          break;
        }
      }
    });
    return { mapped, perFile };
  }

  // ------------------------------------------------------------------ requirements
  const TAG_RE = /@([A-Za-z][A-Za-z0-9]*-\d+)\b|\[([A-Z][A-Z0-9]+-\d+)\]/g;
  function parseRequirements(text) {
    const rows = parseCSV(text);
    if (!rows.length) return [];
    let start = 0;
    const h = rows[0].map(x => x.toLowerCase());
    if (h.some(x => /^(req|requirement|id|story|key|test|tests|title|name|summary)/.test(x)) && !/\d/.test(rows[0][0])) start = 1;
    const by = new Map();
    for (let i = start; i < rows.length; i++) {
      const r = rows[i];
      const id = r[0];
      if (!id) continue;
      let title = '', refs = [];
      if (r.length === 2) {
        if (/[;|]/.test(r[1]) || /\.|›|::|#|\btest/i.test(r[1])) refs = r[1].split(/[;|]/);
        else title = r[1];
      } else if (r.length >= 3) { title = r[1]; refs = r.slice(2).join(';').split(/[;|]/); }
      refs = refs.map(x => x.trim()).filter(Boolean);
      const o = by.get(id) || { id, title: '', refs: [], source: 'csv' };
      if (title && !o.title) o.title = title;
      o.refs.push(...refs);
      by.set(id, o);
    }
    return [...by.values()];
  }
  function tagsIn(s) {
    const out = [];
    let m;
    TAG_RE.lastIndex = 0;
    while ((m = TAG_RE.exec(s))) out.push((m[1] || m[2]).toUpperCase());
    return out;
  }
  function traceRequirements(reqs, tests, haveResults) {
    const list = reqs.map(r => Object.assign({}, r, { id: r.id, tests: [] }));
    const byId = new Map(list.map(r => [r.id.toUpperCase(), r]));
    tests.forEach(t => {
      tagsIn(t.name + ' ' + t.classname).forEach(id => {
        let r = byId.get(id);
        if (!r) { r = { id, title: '', refs: [], source: 'tag', tests: [] }; list.push(r); byId.set(id, r); }
        if (!r.tests.includes(t)) r.tests.push(t);
      });
    });
    list.forEach(r => {
      r.refs.forEach(ref => {
        const lr = ref.toLowerCase();
        tests.forEach(t => {
          if (r.tests.includes(t)) return;
          const k = t.key.toLowerCase(), n = t.name.toLowerCase(), cn = (t.classname.split('.').pop() + '.' + t.name).toLowerCase();
          if (n === lr || cn === lr || k === lr || (lr.length >= 6 && k.includes(lr))) r.tests.push(t);
        });
      });
      const st = r.tests.map(t => t.status);
      if (!r.refs.length && !r.tests.length) r.status = 'untested';
      else if (!r.tests.length) r.status = haveResults ? 'untested' : 'no-results';
      else if (st.includes('fail')) r.status = 'failing';
      else if (st.includes('flaky')) r.status = 'flaky';
      else if (st.every(s => s === 'skip')) r.status = 'skipped';
      else r.status = 'passing';
      r.missingRefs = r.refs.filter(ref => !r.tests.some(t => { const lr = ref.toLowerCase(); return t.name.toLowerCase() === lr || t.key.toLowerCase().includes(lr) || (t.classname.split('.').pop() + '.' + t.name).toLowerCase() === lr; }));
      r.tests = r.tests.map(t => ({ key: t.key, status: t.status }));
    });
    const order = { failing: 0, untested: 1, flaky: 2, skipped: 3, 'no-results': 4, passing: 5 };
    return list.sort((a, b) => order[a.status] - order[b.status] || a.id.localeCompare(b.id, undefined, { numeric: true }));
  }

  // ------------------------------------------------------------------ hotspots
  function hotspots(files, churn, overlay) {
    const maxC = Math.max(1, ...files.map(f => f.churn ? f.churn.commits : 0));
    const maxSize = Math.max(1, ...files.map(f => f.lt + 2 * f.bt));
    const sizes = files.map(f => f.lt).sort((a, b) => a - b);
    const bigLine = files.length >= 5 ? sizes[Math.floor(sizes.length * 0.8)] : Infinity;
    return files.map(f => {
      const linePct = pct(f.lc, f.lt);
      const brPct = pct(f.bc, f.bt);
      const cov = linePct == null ? 0 : (brPct == null ? linePct : 0.7 * linePct + 0.3 * brPct) / 100;
      const size = Math.log1p(f.lt + 2 * f.bt) / Math.log1p(maxSize);
      const ch = churn ? (f.churn ? Math.log1p(f.churn.commits) / Math.log1p(maxC) : 0) : null;
      let risk = (1 - cov) * (ch == null ? 1 : 0.25 + 0.75 * ch) * (0.35 + 0.65 * size) * 100;
      const o = overlay && overlay.get(f.path);
      if (o && o.failing) risk += 15;
      if (o && o.flaky) risk += 8;
      risk = Math.min(100, Math.round(risk));
      const why = [];
      if (linePct != null && linePct < 50) why.push(Math.round(linePct) + '% of lines run by tests');
      else if (linePct != null && linePct < 80) why.push('only ' + Math.round(linePct) + '% line coverage');
      if (brPct != null && brPct < 60) why.push(Math.round(brPct) + '% of branches');
      if (f.churn && ch > 0.5) why.push('changed in ' + f.churn.commits + ' commits');
      if (f.lt >= bigLine && f.lt > 0) why.push('one of the largest files (' + f.lt + ' lines)');
      if (o && o.failing) why.push(o.failing + ' failing test' + (o.failing > 1 ? 's' : ''));
      if (o && o.flaky) why.push(o.flaky + ' flaky test' + (o.flaky > 1 ? 's' : ''));
      return { path: f.path, risk, linePct: round1(linePct), branchPct: round1(brPct), lines: f.lt, commits: f.churn ? f.churn.commits : null, why };
    }).sort((a, b) => b.risk - a.risk || a.path.localeCompare(b.path));
  }

  function packages(files) {
    const by = new Map();
    files.forEach(f => {
      const d = dirname(f.path);
      const p = by.get(d) || { name: d, files: 0, lt: 0, lc: 0, bt: 0, bc: 0 };
      p.files++; p.lt += f.lt; p.lc += f.lc; p.bt += f.bt; p.bc += f.bc;
      by.set(d, p);
    });
    return [...by.values()].map(p => Object.assign(p, { linePct: round1(pct(p.lc, p.lt)), branchPct: round1(pct(p.bc, p.bt)) }))
      .sort((a, b) => b.lt - a.lt);
  }

  // ------------------------------------------------------------------ diff
  function diffReports(baseRep, headRep) {
    const bFiles = baseRep.files, hFiles = headRep.files;
    const match = makeMatcher(bFiles);
    const usedBase = new Set();
    const rows = [];
    let newUncoveredTotal = 0;
    hFiles.forEach(h => {
      const b = bFiles.find(x => x.path === h.path) || match(h.full || h.path);
      if (b) usedBase.add(b);
      const hp = pct(h.lc, h.lt), bp = b ? pct(b.lc, b.lt) : null;
      let newUnc = [];
      if (h.lines) {
        newUnc = uncoveredLines(h).filter(ln => !b || !b.lines || b.lines[ln] === undefined || b.lines[ln] > 0);
        if (b && !b.lines) newUnc = [];
      }
      newUncoveredTotal += newUnc.length;
      rows.push({ path: h.path, status: b ? 'changed' : 'new', basePct: round1(bp), headPct: round1(hp),
        delta: bp == null || hp == null ? null : round1(hp - bp), baseLines: b ? b.lt : 0, headLines: h.lt, newUncovered: newUnc, newUncoveredText: ranges(newUnc, 12) });
    });
    bFiles.forEach(b => { if (!usedBase.has(b)) rows.push({ path: b.path, status: 'removed', basePct: round1(pct(b.lc, b.lt)), headPct: null, delta: null, baseLines: b.lt, headLines: 0, newUncovered: [], newUncoveredText: '' }); });
    const tb = totals(bFiles), th = totals(hFiles);
    const interesting = rows.filter(r => r.status !== 'changed' || (r.delta != null && Math.abs(r.delta) >= 0.1) || r.newUncovered.length)
      .sort((a, b) => (b.newUncovered.length - a.newUncovered.length) || ((a.delta == null ? 0 : a.delta) - (b.delta == null ? 0 : b.delta)));
    return { base: tb, head: th, delta: tb.linePct == null || th.linePct == null ? null : round1(th.linePct - tb.linePct),
      branchDelta: tb.branchPct == null || th.branchPct == null ? null : round1(th.branchPct - tb.branchPct),
      newUncoveredTotal, rows: interesting, newFiles: rows.filter(r => r.status === 'new').length, removedFiles: rows.filter(r => r.status === 'removed').length };
  }

  // ------------------------------------------------------------------ release summary (plain English for a manager)
  function releaseSummary(a) {
    const t = a.totals, pts = [];
    let score = 0;
    const lp = t.linePct;
    if (lp != null) {
      if (lp < 50) { score += 3; pts.push(`Only ${lp}% of the code is run by the automated tests, so most changes ship without a safety net.`); }
      else if (lp < 70) { score += 2; pts.push(`${lp}% of the code is run by the automated tests. That leaves large parts unchecked.`); }
      else if (lp < 80) { score += 1; pts.push(`${lp}% of the code is run by the automated tests, which is reasonable but has gaps.`); }
      else pts.push(`${lp}% of the code is run by the automated tests, which is a healthy level.`);
    }
    if (t.branchPct != null && t.branchPct < 60) { score += 1; pts.push(`Only ${t.branchPct}% of decision points (if/else, error paths) are tested. Error handling is where releases usually break.`); }
    if (a.diff && a.diff.delta != null) {
      if (a.diff.delta <= -2) { score += 2; pts.push(`Coverage fell by ${Math.abs(a.diff.delta)} points since the baseline report: new code went in without tests.`); }
      else if (a.diff.delta < 0) { score += 1; pts.push(`Coverage dipped slightly (${a.diff.delta} points) since the baseline report.`); }
      else pts.push(`Coverage is ${a.diff.delta > 0 ? 'up ' + a.diff.delta + ' points' : 'unchanged'} since the baseline report.`);
      if (a.diff.newUncoveredTotal > 0) pts.push(`${a.diff.newUncoveredTotal} lines are not tested now that were tested, or did not exist, in the baseline.`);
    }
    if (a.tests) {
      const f = a.tests.failing, fl = a.tests.flaky;
      if (f) { score += 3; pts.push(`${f} automated test${f > 1 ? 's are' : ' is'} failing. Each one is a known problem or a broken check, and needs a decision before release.`); }
      if (fl) { score += 1; pts.push(`${fl} test${fl > 1 ? 's are' : ' is'} flaky (pass and fail without a code change). Flaky tests hide real failures and slow the team down.`); }
      if (!f && !fl) pts.push(`All ${a.tests.total} automated tests passed.`);
    }
    if (a.requirements && a.requirements.length) {
      const un = a.requirements.filter(r => r.status === 'untested').length, fr = a.requirements.filter(r => r.status === 'failing').length;
      if (fr) { score += 2; pts.push(`${fr} requirement${fr > 1 ? 's have' : ' has'} failing tests.`); }
      if (un) { score += un > 2 ? 2 : 1; pts.push(`${un} of ${a.requirements.length} requirements have no test that ran.`); }
      if (!un && !fr) pts.push(`Every one of the ${a.requirements.length} requirements has at least one passing test.`);
    }
    const hot = a.hotspots.filter(h => h.risk >= 50).slice(0, 3);
    if (hot.length) { score += 1; pts.push(`Highest-risk area${hot.length > 1 ? 's' : ''}: ${hot.map(h => h.path).join(', ')}${a.churn ? ' (often changed and poorly tested)' : ' (large and poorly tested)'}.`); }
    const level = score >= 5 ? 'high' : score >= 2 ? 'medium' : 'low';
    const headline = { high: 'High release risk', medium: 'Medium release risk', low: 'Low release risk' }[level];
    const advice = {
      high: 'Recommendation: do not release until the failing tests are fixed or accepted, and add tests to the top hotspots first.',
      medium: 'Recommendation: release is possible with care. Fix flaky tests and add tests for the top hotspots in the next sprint.',
      low: 'Recommendation: no blockers from the test data. Keep the coverage gate in CI so it stays this way.',
    }[level];
    return { level, headline, points: pts, advice, text: headline + '\n\n' + pts.map(p => '- ' + p).join('\n') + '\n\n' + advice };
  }

  // ------------------------------------------------------------------ CI gate snippets
  function ciGates(opts) {
    const o = Object.assign({ format: 'lcov', line: 80, branch: 0 }, opts || {});
    const L = Math.max(0, Math.min(100, Math.floor(o.line))), B = Math.max(0, Math.min(100, Math.floor(o.branch || 0)));
    const path = o.path || { lcov: 'coverage/lcov.info', cobertura: 'coverage.xml', jacoco: 'target/site/jacoco/jacoco.xml', 'istanbul-summary': 'coverage/coverage-summary.json', 'istanbul-final': 'coverage/coverage-final.json' }[o.format] || 'coverage/lcov.info';
    let check;
    if (o.format === 'lcov') {
      check = `awk -F: -v L=${L} -v B=${B} '/^LF:/{lf+=$2} /^LH:/{lh+=$2} /^BRF:/{bf+=$2} /^BRH:/{bh+=$2}
  END { l = lf ? 100*lh/lf : 0; b = bf ? 100*bh/bf : 100;
        printf "Lines %.1f%% (gate %d%%), branches %.1f%% (gate %d%%)\\n", l, L, b, B;
        if (l < L || b < B) { print "Coverage is below the gate"; exit 1 } }' ${path}`;
    } else if (o.format === 'cobertura') {
      check = `python3 - <<'PY'
import sys, xml.etree.ElementTree as ET
r = ET.parse("${path}").getroot()
l = float(r.get("line-rate", 0)) * 100; b = float(r.get("branch-rate", 1)) * 100
print(f"Lines {l:.1f}% (gate ${L}%), branches {b:.1f}% (gate ${B}%)")
sys.exit(1 if l < ${L} or b < ${B} else 0)
PY`;
    } else if (o.format === 'jacoco') {
      check = `python3 - <<'PY'
import sys, xml.etree.ElementTree as ET
r = ET.parse("${path}").getroot()
c = {x.get("type"): x for x in r.findall("counter")}
def p(t):
    x = c.get(t)
    if x is None: return 100.0
    m, v = int(x.get("missed")), int(x.get("covered"))
    return 100.0 * v / (m + v) if m + v else 100.0
l, b = p("LINE"), p("BRANCH")
print(f"Lines {l:.1f}% (gate ${L}%), branches {b:.1f}% (gate ${B}%)")
sys.exit(1 if l < ${L} or b < ${B} else 0)
PY`;
    } else {
      check = `node -e '
const d = require("./coverage/coverage-summary.json").total;
const l = d.lines.pct, b = d.branches.pct;
console.log("Lines " + l + "% (gate ${L}%), branches " + b + "% (gate ${B}%)");
if (l < ${L} || b < ${B}) process.exit(1);'`;
    }
    const indent = (s, n) => s.split('\n').map(x => ' '.repeat(n) + x).join('\n');
    const github = `# .github/workflows/coverage-gate.yml
name: Coverage gate
on:
  pull_request:
  push:
    branches: [main]
jobs:
  coverage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      # ... set up your language and run the tests with coverage here, writing ${path}
      - name: Fail if coverage is below the gate
        run: |
${indent(check, 10)}
      - name: Fail if new or changed lines are under ${Math.max(L, 80)}% covered
        if: github.event_name == 'pull_request'
        run: |
          pip install diff-cover
          diff-cover ${o.format === 'istanbul-summary' || o.format === 'istanbul-final' ? 'coverage/lcov.info' : path} --compare-branch=origin/\${{ github.base_ref }} --fail-under=${Math.max(L, 80)}
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: coverage
          path: ${o.format === 'jacoco' ? 'target/site/jacoco/' : o.format === 'cobertura' ? path : 'coverage/'}`;
    const gitlab = `# .gitlab-ci.yml
coverage-gate:
  stage: test
  script:
    # ... run the tests with coverage here, writing ${path}
    - |
${indent(check, 6)}
  coverage: '/Lines (\\d+\\.?\\d*)%/'
  artifacts:
    when: always
    paths: [${o.format === 'jacoco' ? 'target/site/jacoco/' : o.format === 'cobertura' ? path : 'coverage/'}]${o.format === 'cobertura' ? `
    reports:
      coverage_report:
        coverage_format: cobertura
        path: ${path}` : ''}`;
    const native = {
      jest: `// jest.config.js: Jest fails the run itself when coverage drops
module.exports = {
  collectCoverage: true,
  coverageReporters: ['lcov', 'json-summary', 'text-summary'],
  coverageThreshold: { global: { lines: ${L}, branches: ${B} } },
};`,
      vitest: `// vitest.config.ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { coverage: { reporter: ['lcov', 'json-summary', 'text'], thresholds: { lines: ${L}, branches: ${B} } } },
});`,
      pytest: `# pytest with pytest-cov: fails when total coverage is under the gate
pytest --cov=src --cov-branch --cov-report=xml --cov-report=term --cov-fail-under=${L}`,
      jacoco: `<!-- pom.xml, jacoco-maven-plugin: mvn verify fails below the gate -->
<execution>
  <id>check</id>
  <goals><goal>check</goal></goals>
  <configuration>
    <rules>
      <rule>
        <element>BUNDLE</element>
        <limits>
          <limit><counter>LINE</counter><value>COVEREDRATIO</value><minimum>${(L / 100).toFixed(2)}</minimum></limit>
          <limit><counter>BRANCH</counter><value>COVEREDRATIO</value><minimum>${(B / 100).toFixed(2)}</minimum></limit>
        </limits>
      </rule>
    </rules>
  </configuration>
</execution>`,
    };
    return { line: L, branch: B, path, check, github, gitlab, native };
  }

  // ------------------------------------------------------------------ everything together
  function analyse(input) {
    const inp = input || {};
    if (!String(inp.coverage || '').trim()) throw new Error('Add a coverage report first.');
    const rep = parseCoverage(inp.coverage);
    const files = rep.files;
    const warnings = [];

    let churn = null;
    if (String(inp.churn || '').trim()) {
      churn = parseChurn(inp.churn);
      const match = makeMatcher(files);
      let matched = 0;
      for (const p in churn.files) { const f = match(p); if (f) { f.churn = f.churn ? { commits: f.churn.commits + churn.files[p].commits, changed: f.churn.changed + churn.files[p].changed } : Object.assign({}, churn.files[p]); matched++; } }
      churn.matched = matched;
      churn.total = Object.keys(churn.files).length;
      if (!matched) { warnings.push('None of the paths in the change history matched a file in the coverage report, so change frequency is not used.'); churn = null; }
    }

    let tests = null, overlay = null;
    const runs = (inp.junit || []).filter(r => String(r.text || '').trim());
    if (runs.length) {
      const tr = parseTestResults(runs);
      tr.runs.filter(r => r.error).forEach(r => warnings.push(r.name + ': ' + r.error));
      if (tr.tests.length) {
        const m = mapTestsToFiles(tr.tests, files);
        overlay = m.perFile;
        const c = st => tr.tests.filter(t => t.status === st).length;
        tests = { runs: tr.runs, total: tr.tests.length, passed: c('pass'), failing: c('fail'), flaky: c('flaky'), skipped: c('skip'), mapped: m.mapped,
          list: tr.tests.filter(t => t.status === 'fail' || t.status === 'flaky').map(t => ({ key: t.key, status: t.status, fails: t.fails, runs: t.runs, message: t.message })),
          all: tr.tests };
      }
    }

    let requirements = null;
    const reqList = String(inp.requirements || '').trim() ? parseRequirements(inp.requirements) : [];
    if (reqList.length || (tests && tests.all.some(t => tagsIn(t.name + ' ' + t.classname).length))) {
      requirements = traceRequirements(reqList, tests ? tests.all : [], !!tests);
    }
    if (tests) delete tests.all;

    let diff = null;
    if (String(inp.baseline || '').trim()) {
      const b = parseCoverage(inp.baseline);
      diff = diffReports(b, rep);
      diff.baseFormat = b.label;
    }

    const t = totals(files);
    const fileRows = files.map(f => {
      const unc = uncoveredLines(f);
      const o = overlay && overlay.get(f.path);
      return { path: f.path, dir: dirname(f.path), lt: f.lt, lc: f.lc, bt: f.bt, bc: f.bc, linePct: round1(pct(f.lc, f.lt)), branchPct: round1(pct(f.bc, f.bt)),
        uncovered: unc.length, uncoveredText: ranges(unc, 10), commits: f.churn ? f.churn.commits : null,
        tests: o ? o.tests : 0, failing: o ? o.failing : 0, flaky: o ? o.flaky : 0 };
    });
    const hs = hotspots(files, churn, overlay);
    const a = { format: rep.format, formatLabel: rep.label, totals: t, files: fileRows, packages: packages(files), hotspots: hs,
      churn: churn ? { kind: churn.kind, commits: churn.commits, matched: churn.matched, total: churn.total } : null,
      tests, requirements, diff, warnings };
    a.summary = releaseSummary(a);
    a.gates = ciGates({ format: rep.format, line: t.linePct == null ? 80 : Math.min(90, Math.floor(t.linePct)), branch: t.branchPct == null ? 0 : Math.min(85, Math.floor(t.branchPct)) });
    return a;
  }

  // ------------------------------------------------------------------ squarified treemap layout (used by the page)
  function treemap(items, x, y, w, h) {
    const total = items.reduce((s, i) => s + i.value, 0);
    if (!total || w <= 0 || h <= 0) return [];
    const scale = (w * h) / total;
    const nodes = items.filter(i => i.value > 0).map(i => Object.assign({}, i, { area: i.value * scale })).sort((a, b) => b.area - a.area);
    const out = [];
    const worst = (row, len) => {
      const s = row.reduce((a, r) => a + r.area, 0);
      let max = 0, min = Infinity;
      row.forEach(r => { max = Math.max(max, r.area); min = Math.min(min, r.area); });
      return Math.max((len * len * max) / (s * s), (s * s) / (len * len * min));
    };
    let rx = x, ry = y, rw = w, rh = h, row = [];
    const layout = () => {
      const s = row.reduce((a, r) => a + r.area, 0);
      if (rw >= rh) {
        const cw = s / rh; let cy = ry;
        row.forEach(r => { const ch = r.area / cw; out.push(Object.assign(r, { x: rx, y: cy, w: cw, h: ch })); cy += ch; });
        rx += cw; rw -= cw;
      } else {
        const ch = s / rw; let cx = rx;
        row.forEach(r => { const cw = r.area / ch; out.push(Object.assign(r, { x: cx, y: ry, w: cw, h: ch })); cx += cw; });
        ry += ch; rh -= ch;
      }
      row = [];
    };
    nodes.forEach(n => {
      const len = Math.min(rw, rh);
      if (!row.length || worst(row.concat(n), len) <= worst(row, len)) row.push(n);
      else { layout(); row.push(n); }
    });
    if (row.length) layout();
    return out;
  }

  const api = { parseCoverage, parseLCOV, parseCobertura, parseJaCoCo, parseIstanbul, detectFormat, parseChurn, parseCSV, parseTestResults,
    parseRequirements, traceRequirements, mapTestsToFiles, subjectTokens, hotspots, packages, totals, diffReports, releaseSummary, ciGates,
    analyse, treemap, ranges, uncoveredLines, FORMAT_LABEL, usesSharedJUnit: !!(CI && CI.parseJUnitXML) };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CoverageIntel = api;
})(typeof self !== 'undefined' ? self : this);
